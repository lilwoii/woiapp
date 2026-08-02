-- Crash-safe cleanup for private chat media.
--
-- Clean chat uploads may sit unlinked when a composer is abandoned. Cleanup
-- claims those assets while holding the same row locks used by message send.
-- Once claimed, an asset can never be attached, even after a lease expires;
-- expiry only permits another cleanup worker to retry storage deletion.

create table if not exists private.chat_media_cleanup_claims (
  asset_id uuid primary key references public.media_assets(id) on delete cascade,
  batch_id uuid not null,
  claimed_at timestamptz not null,
  lease_expires_at timestamptz not null,
  attempt_count integer not null default 1 check (attempt_count between 1 and 10000),
  constraint chat_media_cleanup_claim_lease check (
    lease_expires_at > claimed_at
    and lease_expires_at <= claimed_at + interval '30 minutes'
  )
);

create index if not exists chat_media_cleanup_claims_lease_idx
  on private.chat_media_cleanup_claims (lease_expires_at, asset_id);

revoke all privileges on table private.chat_media_cleanup_claims
  from public, anon, authenticated;

create or replace function public.prepare_chat_media_cleanup_batch()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_batch_id uuid := gen_random_uuid();
  target_asset_id uuid;
  claimed_paths text[] := '{}'::text[];
  raw_source_paths text[] := '{}'::text[];
  result_paths text[] := '{}'::text[];
begin
  -- Asset locks make this selection mutually exclusive with message attach.
  -- SKIP LOCKED lets overlapping scheduled workers make independent progress.
  for target_asset_id in
    select asset.id
    from public.media_assets asset
    left join private.chat_media_cleanup_claims claim
      on claim.asset_id = asset.id
    where asset.source = 'chat_upload'
      and asset.quarantine_state = 'clean'
      and asset.moderation = 'approved'
      and asset.processed_storage_path is not null
      and coalesce(asset.scan_completed_at, asset.created_at) < now() - interval '24 hours'
      and (claim.asset_id is null or claim.lease_expires_at <= now())
      and not exists (
        select 1
        from public.marketplace_message_media message_link
        where message_link.asset_id = asset.id
      )
    order by coalesce(asset.scan_completed_at, asset.created_at), asset.id
    for update of asset skip locked
    limit 200
  loop
    insert into private.chat_media_cleanup_claims (
      asset_id,
      batch_id,
      claimed_at,
      lease_expires_at,
      attempt_count
    )
    values (
      target_asset_id,
      target_batch_id,
      now(),
      now() + interval '15 minutes',
      1
    )
    on conflict (asset_id)
    do update set
      batch_id = excluded.batch_id,
      claimed_at = excluded.claimed_at,
      lease_expires_at = excluded.lease_expires_at,
      attempt_count = private.chat_media_cleanup_claims.attempt_count + 1
    where private.chat_media_cleanup_claims.lease_expires_at <= now();
  end loop;

  select coalesce(array_agg(path order by path), '{}'::text[])
  into claimed_paths
  from (
    select asset.storage_path as path
    from private.chat_media_cleanup_claims claim
    join public.media_assets asset on asset.id = claim.asset_id
    where claim.batch_id = target_batch_id
    union
    select asset.processed_storage_path
    from private.chat_media_cleanup_claims claim
    join public.media_assets asset on asset.id = claim.asset_id
    where claim.batch_id = target_batch_id
      and asset.processed_storage_path is not null
  ) claimed;

  -- Re-encoded media no longer needs its raw quarantine input. This applies to
  -- linked assets too and never deletes the clean media record or output.
  select coalesce(array_agg(source.path order by source.path), '{}'::text[])
  into raw_source_paths
  from (
    select asset.storage_path as path
    from public.media_assets asset
    join storage.objects object
      on object.bucket_id = 'spottr-media'
     and object.name = asset.storage_path
    where asset.quarantine_state = 'clean'
      and asset.processed_storage_path is not null
      and asset.scan_completed_at < now() - interval '1 hour'
      and not (asset.storage_path = any(claimed_paths))
    order by asset.scan_completed_at, asset.id
    limit greatest(500 - cardinality(claimed_paths), 0)
  ) source;

  result_paths := claimed_paths || raw_source_paths;
  return jsonb_build_object(
    'batch_id', target_batch_id,
    'storage_paths', to_jsonb(result_paths),
    'claimed_asset_count', (
      select count(*)
      from private.chat_media_cleanup_claims claim
      where claim.batch_id = target_batch_id
    )
  );
end;
$$;

revoke all on function public.prepare_chat_media_cleanup_batch()
  from public, anon, authenticated;
grant execute on function public.prepare_chat_media_cleanup_batch()
  to service_role;

create or replace function public.finalize_chat_media_cleanup_batch(
  target_batch_id uuid,
  deleted_storage_paths text[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  normalized_paths text[] := coalesce(deleted_storage_paths, '{}'::text[]);
  deleted_count integer := 0;
begin
  if target_batch_id is null
    or cardinality(normalized_paths) > 500
    or cardinality(normalized_paths) <> (
      select count(distinct supplied.path)
      from unnest(normalized_paths) supplied(path)
    )
    or exists (
      select 1
      from unnest(normalized_paths) supplied(path)
      where supplied.path !~ '^(quarantine|published)/[A-Za-z0-9/_-]+\.(jpg|jpeg|png|webp)$'
        or char_length(supplied.path) > 512
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_CHAT_MEDIA_CLEANUP_RECEIPT';
  end if;

  -- A claimed asset row is removed only after every path recorded for it was
  -- acknowledged by storage deletion. Missing or partial receipts fail closed.
  if exists (
    select 1
    from private.chat_media_cleanup_claims claim
    join public.media_assets asset on asset.id = claim.asset_id
    where claim.batch_id = target_batch_id
      and (
        not (asset.storage_path = any(normalized_paths))
        or (
          asset.processed_storage_path is not null
          and not (asset.processed_storage_path = any(normalized_paths))
        )
      )
  ) then
    raise exception using errcode = '22023', message = 'INCOMPLETE_CHAT_MEDIA_CLEANUP_RECEIPT';
  end if;

  delete from public.media_assets asset
  using private.chat_media_cleanup_claims claim
  where claim.asset_id = asset.id
    and claim.batch_id = target_batch_id;
  get diagnostics deleted_count = row_count;

  return jsonb_build_object(
    'batch_id', target_batch_id,
    'deleted_asset_records', deleted_count
  );
end;
$$;

revoke all on function public.finalize_chat_media_cleanup_batch(uuid, text[])
  from public, anon, authenticated;
grant execute on function public.finalize_chat_media_cleanup_batch(uuid, text[])
  to service_role;

-- Block post-claim scan, registration, and moderation updates. Cleanup deletes
-- the row; it never needs to update a claimed asset.
create or replace function private.reject_claimed_chat_media_update()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from private.chat_media_cleanup_claims claim
    where claim.asset_id = old.id
  ) then
    raise exception using errcode = '55000', message = 'CHAT_MEDIA_CLEANUP_CLAIMED';
  end if;
  return new;
end;
$$;

revoke all on function private.reject_claimed_chat_media_update()
  from public, anon, authenticated;
drop trigger if exists reject_claimed_chat_media_update on public.media_assets;
create trigger reject_claimed_chat_media_update
before update on public.media_assets
for each row execute function private.reject_claimed_chat_media_update();

-- Preserve the DLP wrapper as a private core, then add the row-lock/claim gate.
alter function public.send_marketplace_message(uuid, text, uuid[], text)
  rename to send_marketplace_message_dlp_core;
revoke all on function public.send_marketplace_message_dlp_core(uuid, text, uuid[], text)
  from public, anon, authenticated;

create or replace function public.send_marketplace_message(
  target_conversation_public_id uuid,
  message_body text,
  media_asset_ids uuid[] default '{}'::uuid[],
  idempotency_key text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  normalized_assets uuid[] := coalesce(media_asset_ids, '{}'::uuid[]);
  locked_asset_count integer := 0;
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  if cardinality(normalized_assets) > 4
    or cardinality(normalized_assets) <> (
      select count(distinct supplied.asset_id)
      from unnest(normalized_assets) supplied(asset_id)
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_CHAT_MEDIA_SET';
  end if;

  if cardinality(normalized_assets) > 0 then
    -- Deterministic row order avoids deadlocks between multi-photo sends.
    perform asset.id
    from public.media_assets asset
    where asset.id = any(normalized_assets)
      and asset.owner_id = actor
    order by asset.id
    for update;
    get diagnostics locked_asset_count = row_count;

    if locked_asset_count <> cardinality(normalized_assets)
      or exists (
        select 1
        from private.chat_media_cleanup_claims claim
        where claim.asset_id = any(normalized_assets)
      )
    then
      raise exception using errcode = '55000', message = 'CHAT_MEDIA_CLEANUP_CLAIMED';
    end if;
  end if;

  return public.send_marketplace_message_dlp_core(
    target_conversation_public_id,
    message_body,
    normalized_assets,
    idempotency_key
  );
end;
$$;

revoke all on function public.send_marketplace_message(uuid, text, uuid[], text)
  from public, anon;
grant execute on function public.send_marketplace_message(uuid, text, uuid[], text)
  to authenticated;
