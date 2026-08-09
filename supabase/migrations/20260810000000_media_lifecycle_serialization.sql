-- Durable media lifecycle serialization.
--
-- Invariants:
-- 1. Every signed upload grant is persisted before the bearer token is minted.
-- 2. One scanner owns an asset at a time and writes a unique, pre-registered path.
-- 3. Cleanup work survives a storage-delete/DB-finalize crash.
-- 4. Account deletion freezes new mutations before waiting for outstanding
--    upload/scan capabilities and taking a durable storage snapshot.

create table if not exists private.media_stage_grants (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null unique,
  purpose text not null check (purpose in (
    'profile_avatar', 'business_logo', 'business_gallery',
    'review_photo', 'chat_photo', 'claim_evidence'
  )),
  business_id uuid references public.businesses(id) on delete set null,
  conversation_public_id uuid,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size bigint not null check (byte_size between 1 and 5242880),
  state text not null default 'issued' check (state in ('issued', 'registered', 'cancelled', 'expired')),
  registered_asset_id uuid references public.media_assets(id) on delete set null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint media_stage_grants_path check (
    storage_path ~ '^quarantine/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'
    and char_length(storage_path) <= 512
  ),
  constraint media_stage_grants_expiry check (
    expires_at > issued_at and expires_at <= issued_at + interval '2 hours 10 minutes'
  ),
  constraint media_stage_grants_registration_shape check (
    registered_asset_id is null or state = 'registered'
  )
);
create index if not exists media_stage_grants_owner_state_idx
  on private.media_stage_grants (owner_id, state, expires_at);
revoke all privileges on table private.media_stage_grants from public, anon, authenticated;

create table if not exists private.media_orphan_paths (
  storage_path text primary key,
  owner_id uuid,
  reason text not null check (reason in ('abandoned_scan_output', 'failed_scan_output')),
  created_at timestamptz not null default now(),
  constraint media_orphan_paths_format check (
    storage_path ~ '^published/[A-Za-z0-9/_-]+\.(jpg|jpeg|png|webp)$'
    and char_length(storage_path) <= 512
  )
);
revoke all privileges on table private.media_orphan_paths from public, anon, authenticated;

create table if not exists private.media_scan_claims (
  asset_id uuid primary key references public.media_assets(id) on delete cascade,
  owner_id uuid not null,
  attempt_token uuid not null unique,
  claimed_at timestamptz not null,
  lease_expires_at timestamptz not null,
  planned_output_path text unique,
  attempt_count integer not null default 1 check (attempt_count between 1 and 10000),
  constraint media_scan_claim_lease check (
    lease_expires_at > claimed_at and lease_expires_at <= claimed_at + interval '10 minutes'
  ),
  constraint media_scan_claim_output_path check (
    planned_output_path is null
    or (
      planned_output_path ~ '^published/[A-Za-z0-9/_-]+\.(jpg|jpeg|png|webp)$'
      and char_length(planned_output_path) <= 512
    )
  )
);
create index if not exists media_scan_claims_owner_lease_idx
  on private.media_scan_claims (owner_id, lease_expires_at);
revoke all privileges on table private.media_scan_claims from public, anon, authenticated;

create table if not exists private.media_cleanup_items (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null unique,
  asset_id uuid references public.media_assets(id) on delete set null,
  owner_id uuid,
  reason text not null check (reason in ('unregistered_upload', 'stale_asset', 'orphan_scan_output')),
  state text not null default 'pending' check (state in ('pending', 'claimed', 'finalized')),
  batch_id uuid,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count between 0 and 10000),
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  constraint media_cleanup_items_path check (
    storage_path ~ '^(quarantine|published)/[A-Za-z0-9][A-Za-z0-9/_.-]{0,510}$'
    and storage_path !~ '(^|/)\.\.?(/|$)'
    and storage_path not like '%//%'
    and right(storage_path, 1) <> '/'
    and char_length(storage_path) <= 512
  ),
  constraint media_cleanup_items_claim_shape check (
    (state = 'pending' and batch_id is null and claimed_at is null and lease_expires_at is null and finalized_at is null)
    or (state = 'claimed' and batch_id is not null and claimed_at is not null and lease_expires_at > claimed_at and finalized_at is null)
    or (state = 'finalized' and finalized_at is not null)
  )
);
create index if not exists media_cleanup_items_claim_idx
  on private.media_cleanup_items (state, lease_expires_at, created_at, id);
revoke all privileges on table private.media_cleanup_items from public, anon, authenticated;

create table if not exists private.account_deletion_freezes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  request_id uuid not null unique references private.account_deletion_requests(id) on delete cascade,
  frozen_at timestamptz not null default now()
);
revoke all privileges on table private.account_deletion_freezes from public, anon, authenticated;

create table if not exists private.account_deletion_storage_items (
  request_id uuid not null references private.account_deletion_requests(id) on delete cascade,
  storage_path text not null,
  state text not null default 'pending' check (state in ('pending', 'deleted')),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (request_id, storage_path),
  constraint account_deletion_storage_path check (
    storage_path ~ '^(quarantine|published)/[A-Za-z0-9][A-Za-z0-9/_.-]{0,510}$'
    and storage_path !~ '(^|/)\.\.?(/|$)'
    and storage_path not like '%//%'
    and right(storage_path, 1) <> '/'
    and char_length(storage_path) <= 512
  ),
  constraint account_deletion_storage_state check (
    (state = 'pending' and deleted_at is null)
    or (state = 'deleted' and deleted_at is not null)
  )
);
revoke all privileges on table private.account_deletion_storage_items from public, anon, authenticated;

create or replace function private.is_active_user(target_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select target_user_id is not null
    and not exists (
      select 1 from private.account_deletion_freezes freeze
      where freeze.user_id = target_user_id
    )
    and exists (
      select 1
      from public.profiles profile
      join auth.users account on account.id = profile.user_id
      where profile.user_id = target_user_id
        and profile.status = 'active'
        and profile.terms_accepted_at is not null
        and account.email_confirmed_at is not null
    );
$$;

create or replace function public.create_media_stage_grant(
  target_user_id uuid,
  target_storage_path text,
  media_purpose text,
  target_business_id uuid,
  target_conversation_public_id uuid,
  target_mime_type text,
  target_byte_size bigint
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare grant_id uuid;
begin
  if not private.is_active_user(target_user_id)
    or media_purpose not in ('profile_avatar', 'business_logo', 'business_gallery', 'review_photo', 'chat_photo', 'claim_evidence')
    or target_storage_path !~ ('^quarantine/' || target_user_id::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$')
    or target_mime_type not in ('image/jpeg', 'image/png', 'image/webp')
    or target_byte_size not between 1 and 5242880
    or ((media_purpose = 'profile_avatar') <> (target_business_id is null))
    or ((media_purpose = 'chat_photo') <> (target_conversation_public_id is not null))
  then
    raise exception using errcode = '22023', message = 'INVALID_MEDIA_STAGE_GRANT';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_user_id::text, 7741902)
  );
  if not private.is_active_user(target_user_id) then
    raise exception using errcode = '42501', message = 'ACCOUNT_MUTATIONS_FROZEN';
  end if;

  insert into private.media_stage_grants (
    owner_id, storage_path, purpose, business_id, conversation_public_id,
    mime_type, byte_size, expires_at
  ) values (
    target_user_id, target_storage_path, media_purpose, target_business_id,
    target_conversation_public_id, target_mime_type, target_byte_size,
    now() + interval '2 hours 5 minutes'
  ) returning id into grant_id;
  return grant_id;
end;
$$;
revoke all on function public.create_media_stage_grant(uuid, text, text, uuid, uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.create_media_stage_grant(uuid, text, text, uuid, uuid, text, bigint) to service_role;

create or replace function public.cancel_media_stage_grant(target_grant_id uuid, target_user_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update private.media_stage_grants
  set state = 'cancelled', updated_at = now()
  where id = target_grant_id and owner_id = target_user_id and state = 'issued'
$$;
revoke all on function public.cancel_media_stage_grant(uuid, uuid) from public, anon, authenticated;
grant execute on function public.cancel_media_stage_grant(uuid, uuid) to service_role;

create or replace function private.consume_media_stage_grant()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare grant_row private.media_stage_grants%rowtype;
begin
  if new.source = 'licensed_provider' then return new; end if;

  -- Serialize registration with account deletion. This makes the grant either
  -- fully consumed before the deletion freeze, or unusable after it.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.owner_id::text, 7741902)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.storage_path, 7741903)
  );

  select grant.* into grant_row
  from private.media_stage_grants grant
  where grant.storage_path = new.storage_path
  for update;

  if not found or grant_row.owner_id <> new.owner_id
    or grant_row.state <> 'issued' or grant_row.expires_at <= now()
    or grant_row.mime_type <> new.mime_type or grant_row.byte_size <> new.byte_size
    or grant_row.business_id is distinct from new.business_id
    or (new.source = 'review_upload' and grant_row.purpose <> 'review_photo')
    or (new.source = 'chat_upload' and grant_row.purpose <> 'chat_photo')
    or (new.source = 'owner_upload' and grant_row.purpose not in ('profile_avatar', 'business_logo', 'business_gallery'))
    or exists (
      select 1 from private.media_cleanup_items item
      where item.storage_path = new.storage_path and item.state <> 'finalized'
    )
    or exists (
      select 1 from private.account_deletion_freezes freeze
      where freeze.user_id = new.owner_id
    )
  then
    raise exception using errcode = '55000', message = 'MEDIA_STAGE_GRANT_UNAVAILABLE';
  end if;

  update private.media_stage_grants
  set state = 'registered', registered_asset_id = new.id, updated_at = now()
  where id = grant_row.id;
  return new;
end;
$$;
revoke all on function private.consume_media_stage_grant() from public, anon, authenticated;
drop trigger if exists consume_media_stage_grant on public.media_assets;
create trigger consume_media_stage_grant
after insert on public.media_assets
for each row execute function private.consume_media_stage_grant();

-- Preserve the existing scan transition and review side effects as a private core.
alter function public.record_media_scan_result(uuid, text, text, text, integer, integer, bigint, text, text)
  rename to record_media_scan_result_core;
revoke all on function public.record_media_scan_result_core(uuid, text, text, text, integer, integer, bigint, text, text)
  from public, anon, authenticated, service_role;

create or replace function public.claim_media_scan_attempt(target_asset_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  asset public.media_assets%rowtype;
  existing private.media_scan_claims%rowtype;
  token uuid := gen_random_uuid();
begin
  select media.* into asset from public.media_assets media where media.id = target_asset_id;
  if not found then raise exception using errcode = 'P0002', message = 'MEDIA_ASSET_NOT_FOUND'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(asset.owner_id::text, 7741902));
  select media.* into asset from public.media_assets media
  where media.id = target_asset_id and media.owner_id = asset.owner_id
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'MEDIA_ASSET_NOT_FOUND'; end if;
  if asset.quarantine_state in ('clean', 'rejected') then
    return jsonb_build_object('status', asset.quarantine_state, 'asset_id', asset.id);
  end if;
  if exists (select 1 from private.account_deletion_freezes freeze where freeze.user_id = asset.owner_id)
    or exists (select 1 from private.media_cleanup_items item where item.asset_id = asset.id and item.state <> 'finalized')
  then raise exception using errcode = '55000', message = 'MEDIA_ASSET_FROZEN'; end if;

  select claim.* into existing from private.media_scan_claims claim where claim.asset_id = asset.id for update;
  if found and existing.lease_expires_at > now() then
    raise exception using errcode = '55000', message = 'MEDIA_SCAN_IN_PROGRESS';
  end if;
  if found and existing.planned_output_path is not null then
    insert into private.media_orphan_paths (storage_path, owner_id, reason)
    values (existing.planned_output_path, asset.owner_id, 'abandoned_scan_output')
    on conflict (storage_path) do nothing;
  end if;

  insert into private.media_scan_claims (
    asset_id, owner_id, attempt_token, claimed_at, lease_expires_at, planned_output_path, attempt_count
  ) values (asset.id, asset.owner_id, token, now(), now() + interval '5 minutes', null, 1)
  on conflict (asset_id) do update set
    owner_id = excluded.owner_id, attempt_token = excluded.attempt_token,
    claimed_at = excluded.claimed_at, lease_expires_at = excluded.lease_expires_at,
    planned_output_path = null,
    attempt_count = private.media_scan_claims.attempt_count + 1;

  update public.media_assets set quarantine_state = 'scanning' where id = asset.id;
  return jsonb_build_object(
    'status', 'claimed', 'asset_id', asset.id, 'attempt_token', token,
    'business_id', asset.business_id, 'storage_path', asset.storage_path,
    'source', asset.source, 'lease_expires_at', now() + interval '5 minutes'
  );
end;
$$;
revoke all on function public.claim_media_scan_attempt(uuid) from public, anon, authenticated;
grant execute on function public.claim_media_scan_attempt(uuid) to service_role;

create or replace function public.plan_media_scan_output(
  target_asset_id uuid,
  target_attempt_token uuid,
  target_output_path text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare claim private.media_scan_claims%rowtype;
begin
  select current_claim.* into claim
  from private.media_scan_claims current_claim
  where current_claim.asset_id = target_asset_id
  for update;
  if not found or claim.attempt_token <> target_attempt_token or claim.lease_expires_at <= now()
    or target_output_path !~ ('^published/[A-Za-z0-9/_-]+/' || target_asset_id::text || '/' || target_attempt_token::text || '\.(jpg|jpeg|png|webp)$')
    or exists (select 1 from private.account_deletion_freezes freeze where freeze.user_id = claim.owner_id)
  then raise exception using errcode = '55000', message = 'MEDIA_SCAN_CLAIM_INVALID'; end if;
  update private.media_scan_claims set planned_output_path = target_output_path
  where asset_id = target_asset_id;
end;
$$;
revoke all on function public.plan_media_scan_output(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.plan_media_scan_output(uuid, uuid, text) to service_role;

create or replace function public.finalize_media_scan_attempt(
  target_asset_id uuid,
  target_attempt_token uuid,
  scan_state text,
  clean_storage_path text,
  clean_mime_type text,
  clean_width integer,
  clean_height integer,
  clean_byte_size bigint,
  clean_sha256 text,
  scan_rejection_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare claim private.media_scan_claims%rowtype;
begin
  select current_claim.* into claim from private.media_scan_claims current_claim
  where current_claim.asset_id = target_asset_id;
  if not found then raise exception using errcode = '55000', message = 'MEDIA_SCAN_CLAIM_INVALID'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(claim.owner_id::text, 7741902));
  select current_claim.* into claim from private.media_scan_claims current_claim
  where current_claim.asset_id = target_asset_id for update;
  if not found or claim.attempt_token <> target_attempt_token or claim.lease_expires_at <= now()
    or scan_state not in ('clean', 'rejected')
    or (scan_state = 'clean' and claim.planned_output_path is distinct from clean_storage_path)
  then raise exception using errcode = '55000', message = 'MEDIA_SCAN_CLAIM_INVALID'; end if;

  if exists (select 1 from private.account_deletion_freezes freeze where freeze.user_id = claim.owner_id) then
    if claim.planned_output_path is not null then
      insert into private.media_orphan_paths (storage_path, owner_id, reason)
      values (claim.planned_output_path, claim.owner_id, 'failed_scan_output')
      on conflict (storage_path) do nothing;
    end if;
    delete from private.media_scan_claims where asset_id = target_asset_id;
    return jsonb_build_object('status', 'abandoned_for_account_deletion');
  end if;

  if scan_state = 'rejected' and claim.planned_output_path is not null then
    insert into private.media_orphan_paths (storage_path, owner_id, reason)
    values (claim.planned_output_path, claim.owner_id, 'failed_scan_output')
    on conflict (storage_path) do nothing;
  end if;

  perform public.record_media_scan_result_core(
    target_asset_id, scan_state, clean_storage_path, clean_mime_type,
    clean_width, clean_height, clean_byte_size, clean_sha256, scan_rejection_reason
  );
  delete from private.media_scan_claims where asset_id = target_asset_id;
  return jsonb_build_object('status', scan_state);
end;
$$;
revoke all on function public.finalize_media_scan_attempt(uuid, uuid, text, text, text, integer, integer, bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.finalize_media_scan_attempt(uuid, uuid, text, text, text, integer, integer, bigint, text, text)
  to service_role;

create or replace function public.prepare_media_cleanup_batch()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  batch uuid := gen_random_uuid();
  target_asset_id uuid;
  target_storage_path text;
  paths text[];
begin
  update private.media_stage_grants
  set state = 'expired', registered_asset_id = null, updated_at = now()
  where state in ('issued', 'registered') and expires_at <= now();

  insert into private.media_orphan_paths (storage_path, owner_id, reason)
  select claim.planned_output_path, claim.owner_id, 'abandoned_scan_output'
  from private.media_scan_claims claim
  where claim.lease_expires_at <= now() and claim.planned_output_path is not null
  on conflict (storage_path) do nothing;
  delete from private.media_scan_claims claim where claim.lease_expires_at <= now();

  insert into private.media_cleanup_items (storage_path, owner_id, reason)
  select orphan.storage_path, orphan.owner_id, 'orphan_scan_output'
  from private.media_orphan_paths orphan
  where orphan.created_at <= now() - interval '15 minutes'
  on conflict (storage_path) do nothing;

  -- Registration and cleanup take the same path lock. Recheck after the
  -- lock so a just-registered object can never be claimed as unregistered.
  for target_storage_path in
    select object.name
    from storage.objects object
    where object.bucket_id = 'spottr-media'
      and object.name like 'quarantine/%'
      and object.name ~ '^quarantine/[A-Za-z0-9][A-Za-z0-9/_.-]{0,499}$'
      and object.name !~ '(^|/)\.\.?(/|$)'
      and object.name not like '%//%'
      and right(object.name, 1) <> '/'
      and object.created_at < now() - interval '1 hour'
      and not exists (
        select 1 from public.media_assets asset where asset.storage_path = object.name
      )
      and not exists (
        select 1 from private.media_stage_grants grant
        where grant.storage_path = object.name
          and grant.state not in ('cancelled', 'expired')
      )
      and not exists (
        select 1 from public.business_claims claim
        where claim.evidence_private_path = object.name
          and claim.state in ('pending', 'approved')
      )
    order by object.created_at, object.name
    limit 500
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(target_storage_path, 7741903)
    );
    insert into private.media_cleanup_items (storage_path, owner_id, reason)
    select object.name,
      case when split_part(object.name, '/', 2) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then split_part(object.name, '/', 2)::uuid else null end,
      'unregistered_upload'
    from storage.objects object
    left join public.media_assets asset on asset.storage_path = object.name
    left join private.media_stage_grants grant on grant.storage_path = object.name
    where object.bucket_id = 'spottr-media' and object.name = target_storage_path
      and asset.id is null
      and (grant.id is null or grant.state in ('cancelled', 'expired'))
      and object.created_at < now() - interval '1 hour'
      and not exists (
        select 1 from public.business_claims claim
        where claim.evidence_private_path = object.name and claim.state in ('pending', 'approved')
      )
    on conflict (storage_path) do nothing;
  end loop;

  for target_asset_id in
    select asset.id
    from public.media_assets asset
    left join private.media_scan_claims scan_claim on scan_claim.asset_id = asset.id
    where asset.moderation <> 'approved'
      and not exists (
        select 1 from public.business_claims claim
        where claim.evidence_private_path = asset.storage_path and claim.state in ('pending', 'approved')
      )
      and (
        (asset.quarantine_state in ('uploaded', 'scanning') and asset.created_at < now() - interval '24 hours')
        or (asset.quarantine_state = 'rejected' and asset.created_at < now() - interval '7 days')
      )
      and (scan_claim.asset_id is null or scan_claim.lease_expires_at <= now())
    order by asset.created_at, asset.id
    for update of asset skip locked
    limit 500
  loop
    insert into private.media_cleanup_items (storage_path, asset_id, owner_id, reason)
    select asset.storage_path, asset.id, asset.owner_id, 'stale_asset'
    from public.media_assets asset where asset.id = target_asset_id
    on conflict (storage_path) do nothing;
  end loop;

  with candidates as (
    select item.id from private.media_cleanup_items item
    where item.state = 'pending'
      or (item.state = 'claimed' and item.lease_expires_at <= now())
    order by item.created_at, item.id
    for update skip locked
    limit 500
  )
  update private.media_cleanup_items item
  set state = 'claimed', batch_id = batch, claimed_at = now(),
    lease_expires_at = now() + interval '15 minutes', attempt_count = item.attempt_count + 1
  from candidates where item.id = candidates.id;

  select coalesce(array_agg(item.storage_path order by item.storage_path), '{}'::text[])
  into paths from private.media_cleanup_items item where item.batch_id = batch and item.state = 'claimed';
  return jsonb_build_object('batch_id', batch, 'storage_paths', to_jsonb(paths));
end;
$$;
revoke all on function public.prepare_media_cleanup_batch() from public, anon, authenticated;
grant execute on function public.prepare_media_cleanup_batch() to service_role;

create or replace function public.finalize_media_cleanup_batch(
  target_batch_id uuid,
  deleted_storage_paths text[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare paths text[] := coalesce(deleted_storage_paths, '{}'::text[]); deleted_assets integer := 0;
begin
  if target_batch_id is null or cardinality(paths) > 500
    or cardinality(paths) <> (select count(distinct supplied.path) from unnest(paths) as supplied(path))
    or exists (select 1 from unnest(paths) as supplied(path) where supplied.path !~ '^(quarantine|published)/[A-Za-z0-9][A-Za-z0-9/_.-]{0,510}$' or supplied.path ~ '(^|/)\.\.?(/|$)' or supplied.path like '%//%' or right(supplied.path, 1) = '/' or char_length(supplied.path) > 512)
    or cardinality(paths) <> (
      select count(*) from private.media_cleanup_items item
      where item.batch_id = target_batch_id and item.state = 'claimed'
    )
    or exists (
      select 1 from unnest(paths) supplied(path)
      where not exists (
        select 1 from private.media_cleanup_items item
        where item.batch_id = target_batch_id and item.state = 'claimed'
          and item.storage_path = supplied.path
      )
    )
    or exists (
      select 1 from private.media_cleanup_items item
      where item.batch_id = target_batch_id and item.state = 'claimed'
        and not (item.storage_path = any(paths))
    )
  then raise exception using errcode = '22023', message = 'INVALID_MEDIA_CLEANUP_RECEIPT'; end if;

  delete from public.media_assets asset
  using private.media_cleanup_items item
  where item.batch_id = target_batch_id and item.state = 'claimed'
    and item.reason = 'stale_asset' and item.asset_id = asset.id
    and asset.moderation <> 'approved' and asset.quarantine_state in ('uploaded', 'scanning', 'rejected');
  get diagnostics deleted_assets = row_count;

  delete from private.media_orphan_paths orphan using private.media_cleanup_items item
  where item.batch_id = target_batch_id and item.state = 'claimed' and orphan.storage_path = item.storage_path;
  delete from private.media_stage_grants grant using private.media_cleanup_items item
  where item.batch_id = target_batch_id and item.state = 'claimed'
    and grant.storage_path = item.storage_path and grant.state in ('cancelled', 'expired');
  update private.media_cleanup_items set state = 'finalized', finalized_at = now(), lease_expires_at = null
  where batch_id = target_batch_id and state = 'claimed';
  return jsonb_build_object('batch_id', target_batch_id, 'deleted_asset_records', deleted_assets);
end;
$$;
revoke all on function public.finalize_media_cleanup_batch(uuid, text[]) from public, anon, authenticated;
grant execute on function public.finalize_media_cleanup_batch(uuid, text[]) to service_role;

-- The durable worker above is the only supported generic cleanup boundary.
revoke all on function public.media_quarantine_cleanup_manifest()
  from public, anon, authenticated, service_role;
revoke all on function public.finalize_media_quarantine_cleanup(text[])
  from public, anon, authenticated, service_role;

-- Freeze the account in the same user-scoped critical section that creates or
-- reuses the one live deletion receipt.
create or replace function public.begin_account_deletion(target_user_id uuid, request_key text)
returns table (request_id uuid, request_state text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare fingerprint text;
begin
  if target_user_id is null or char_length(coalesce(request_key, '')) not between 16 and 128
    or request_key !~ '^[A-Za-z0-9._:-]+$'
    or not exists (select 1 from auth.users account where account.id = target_user_id)
  then raise exception using errcode = '22023', message = 'INVALID_ACCOUNT_DELETION_REQUEST'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_user_id::text, 7741902));
  delete from private.account_deletion_requests request
  where request.expires_at < now() and request.state = 'completed';
  select request.id, request.state into request_id, request_state
  from private.account_deletion_requests request
  where request.user_id = target_user_id
    and request.state in ('started', 'processing', 'storage_deleted', 'failed')
  order by request.created_at limit 1;

  if request_id is null then
    fingerprint := pg_catalog.encode(public.digest(target_user_id::text || ':' || request_key, 'sha256'), 'hex');
    insert into private.account_deletion_requests as request (user_id, request_fingerprint, state)
    values (target_user_id, fingerprint, 'started')
    on conflict (request_fingerprint) do update set user_id = request.user_id
    returning request.id, request.state into request_id, request_state;
  end if;

  update private.account_deletion_requests
  set expires_at = greatest(expires_at, now() + interval '24 hours'), updated_at = now()
  where id = request_id;
  insert into private.account_deletion_freezes (user_id, request_id)
  values (target_user_id, request_id)
  on conflict (user_id) do update set request_id = excluded.request_id;
  update public.profiles set status = 'deleted' where user_id = target_user_id;
  return next;
end;
$$;
revoke all on function public.begin_account_deletion(uuid, text) from public, anon, authenticated;
grant execute on function public.begin_account_deletion(uuid, text) to service_role;

create or replace function public.prepare_account_deletion_storage_batch(
  target_request_id uuid,
  target_user_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare paths text[]; wait_seconds integer := 0; pending_count integer;
begin
  if not exists (
    select 1 from private.account_deletion_requests request
    join private.account_deletion_freezes freeze on freeze.request_id = request.id and freeze.user_id = request.user_id
    where request.id = target_request_id and request.user_id = target_user_id
      and request.state in ('processing', 'storage_deleted') and request.expires_at > now()
  ) then raise exception using errcode = '42501', message = 'ACCOUNT_DELETION_CLAIM_REQUIRED'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_user_id::text, 7741902));
  update private.media_stage_grants
  set state = 'expired', registered_asset_id = null, updated_at = now()
  where owner_id = target_user_id and state in ('issued', 'registered') and expires_at <= now();

  select greatest(0, ceil(extract(epoch from max(blocked_until - now())))::integer)
  into wait_seconds
  from (
    select grant.expires_at as blocked_until from private.media_stage_grants grant
    where grant.owner_id = target_user_id and grant.state in ('issued', 'registered') and grant.expires_at > now()
    union all
    select claim.lease_expires_at + interval '15 minutes' from private.media_scan_claims claim
    where claim.owner_id = target_user_id
      and claim.lease_expires_at + interval '15 minutes' > now()
  ) blockers;
  if coalesce(wait_seconds, 0) > 0 then
    return jsonb_build_object('ready', false, 'retry_after_seconds', least(wait_seconds + 5, 7800));
  end if;

  insert into private.media_orphan_paths (storage_path, owner_id, reason)
  select claim.planned_output_path, claim.owner_id, 'abandoned_scan_output'
  from private.media_scan_claims claim
  where claim.owner_id = target_user_id and claim.planned_output_path is not null
  on conflict (storage_path) do nothing;
  delete from private.media_scan_claims where owner_id = target_user_id;

  insert into private.account_deletion_storage_items (request_id, storage_path)
  select target_request_id, source.path from (
    select object.name as path from storage.objects object
    where object.bucket_id = 'spottr-media' and object.name like ('quarantine/' || target_user_id::text || '/%')
    union select asset.storage_path from public.media_assets asset where asset.owner_id = target_user_id
    union select asset.processed_storage_path from public.media_assets asset where asset.owner_id = target_user_id and asset.processed_storage_path is not null
    union select grant.storage_path from private.media_stage_grants grant where grant.owner_id = target_user_id
    union select orphan.storage_path from private.media_orphan_paths orphan where orphan.owner_id = target_user_id
    union select profile.avatar_path from public.profiles profile where profile.user_id = target_user_id and profile.avatar_path ~ '^(quarantine|published)/'
    union select claim.evidence_private_path from public.business_claims claim where claim.claimant_id = target_user_id and claim.evidence_private_path is not null
  ) source where source.path is not null
  on conflict (request_id, storage_path) do nothing;

  select coalesce(array_agg(item.storage_path order by item.storage_path), '{}'::text[])
  into paths from (
    select storage_path from private.account_deletion_storage_items
    where request_id = target_request_id and state = 'pending'
    order by storage_path limit 500
  ) item;
  select count(*) into pending_count from private.account_deletion_storage_items
  where request_id = target_request_id and state = 'pending';
  return jsonb_build_object('ready', true, 'storage_paths', to_jsonb(paths), 'pending_count', pending_count);
end;
$$;
revoke all on function public.prepare_account_deletion_storage_batch(uuid, uuid) from public, anon, authenticated;
grant execute on function public.prepare_account_deletion_storage_batch(uuid, uuid) to service_role;

create or replace function public.checkpoint_account_deletion_storage_batch(
  target_request_id uuid,
  target_user_id uuid,
  deleted_storage_paths text[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare paths text[] := coalesce(deleted_storage_paths, '{}'::text[]); pending_count integer;
begin
  if cardinality(paths) > 500
    or cardinality(paths) <> (select count(distinct supplied.path) from unnest(paths) as supplied(path))
    or exists (select 1 from unnest(paths) as supplied(path) where supplied.path !~ '^(quarantine|published)/[A-Za-z0-9][A-Za-z0-9/_.-]{0,510}$' or supplied.path ~ '(^|/)\.\.?(/|$)' or supplied.path like '%//%' or right(supplied.path, 1) = '/' or char_length(supplied.path) > 512)
    or exists (
      select 1 from unnest(paths) supplied(path)
      where not exists (
        select 1 from private.account_deletion_storage_items item
        where item.request_id = target_request_id and item.storage_path = supplied.path
          and item.state in ('pending', 'deleted')
      )
    )
    or not exists (
      select 1 from private.account_deletion_freezes freeze
      where freeze.user_id = target_user_id and freeze.request_id = target_request_id
    )
  then raise exception using errcode = '22023', message = 'INVALID_ACCOUNT_DELETION_STORAGE_RECEIPT'; end if;

  update private.account_deletion_storage_items set state = 'deleted', deleted_at = now()
  where request_id = target_request_id and storage_path = any(paths) and state = 'pending';
  select count(*) into pending_count from private.account_deletion_storage_items
  where request_id = target_request_id and state = 'pending';
  return jsonb_build_object('pending_count', pending_count, 'storage_complete', pending_count = 0);
end;
$$;
revoke all on function public.checkpoint_account_deletion_storage_batch(uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function public.checkpoint_account_deletion_storage_batch(uuid, uuid, text[]) to service_role;

-- Incomplete deletion intents are retained until completion; a stale worker may
-- be reclaimed without reactivating the account.
alter table private.account_deletion_requests
  drop constraint if exists account_deletion_requests_expiry;
alter table private.account_deletion_requests
  add constraint account_deletion_requests_expiry check (expires_at > created_at);

create or replace function private.enforce_account_deletion_storage_seal()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if new.state = 'storage_deleted' and old.state <> 'storage_deleted' then
    if old.user_id is null
      or not exists (
        select 1 from private.account_deletion_freezes freeze
        where freeze.user_id = old.user_id and freeze.request_id = old.id
      )
      or exists (
        select 1 from private.account_deletion_storage_items item
        where item.request_id = old.id and item.state <> 'deleted'
      )
      or exists (
        select 1 from private.media_stage_grants grant
        where grant.owner_id = old.user_id
          and grant.state in ('issued', 'registered') and grant.expires_at > now()
      )
      or exists (
        select 1 from private.media_scan_claims claim
        where claim.owner_id = old.user_id and claim.lease_expires_at > now()
      )
    then raise exception using errcode = '55000', message = 'ACCOUNT_DELETION_STORAGE_NOT_SEALED'; end if;
  elsif new.state = 'completed' and old.state <> 'completed' then
    if old.state <> 'storage_deleted'
      or exists (
        select 1 from private.account_deletion_storage_items item
        where item.request_id = old.id and item.state <> 'deleted'
      )
    then raise exception using errcode = '55000', message = 'ACCOUNT_DELETION_NOT_READY'; end if;
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_account_deletion_storage_seal()
  from public, anon, authenticated;
drop trigger if exists enforce_account_deletion_storage_seal
  on private.account_deletion_requests;
create trigger enforce_account_deletion_storage_seal
before update of state on private.account_deletion_requests
for each row execute function private.enforce_account_deletion_storage_seal();

alter function public.prepare_account_deletion(uuid, uuid)
  rename to prepare_account_deletion_core;
revoke all on function public.prepare_account_deletion_core(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.prepare_account_deletion(
  target_user_id uuid,
  target_request_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from private.account_deletion_requests request
    join private.account_deletion_freezes freeze
      on freeze.request_id = request.id and freeze.user_id = request.user_id
    where request.id = target_request_id and request.user_id = target_user_id
      and request.state = 'storage_deleted'
  )
    or exists (
      select 1 from private.account_deletion_storage_items item
      where item.request_id = target_request_id and item.state <> 'deleted'
    )
    or exists (
      select 1 from private.media_stage_grants grant
      where grant.owner_id = target_user_id
        and grant.state in ('issued', 'registered') and grant.expires_at > now()
    )
    or exists (
      select 1 from private.media_scan_claims claim
      where claim.owner_id = target_user_id and claim.lease_expires_at > now()
    )
  then raise exception using errcode = '55000', message = 'ACCOUNT_DELETION_NOT_READY'; end if;
  perform public.prepare_account_deletion_core(target_user_id, target_request_id);
end;
$$;
revoke all on function public.prepare_account_deletion(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.prepare_account_deletion(uuid, uuid) to service_role;

revoke all on function public.account_deletion_manifest(uuid)
  from public, anon, authenticated, service_role;

-- Hold the account lifecycle lock for the complete chat mutation. An in-flight
-- send either commits before deletion freezes the account or observes the
-- freeze; it cannot insert/link content after the deletion snapshot.
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
  if actor is null then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(actor::text, 7741902)
  );
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
    perform asset.id
    from public.media_assets asset
    where asset.id = any(normalized_assets)
      and asset.owner_id = actor
    order by asset.id
    for update;
    get diagnostics locked_asset_count = row_count;

    if locked_asset_count <> cardinality(normalized_assets)
      or exists (
        select 1 from private.chat_media_cleanup_claims claim
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

-- Claim evidence registration shares both the account lifecycle and exact-path
-- cleanup locks. Evidence cannot be attached after cleanup has claimed it.
alter function public.submit_business_claim(uuid, text, text)
  rename to submit_business_claim_core;
revoke all on function public.submit_business_claim_core(uuid, text, text)
  from public, anon, authenticated;

create or replace function public.submit_business_claim(
  target_business_id uuid,
  claim_method text,
  evidence_private_path text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  normalized_evidence text := nullif(btrim(evidence_private_path), '');
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(actor::text, 7741902)
  );
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  if normalized_evidence is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(normalized_evidence, 7741903)
    );
    if exists (
      select 1 from private.media_cleanup_items item
      where item.storage_path = normalized_evidence
        and item.state in ('pending', 'claimed')
    ) then
      raise exception using errcode = '55000', message = 'CLAIM_EVIDENCE_CLEANUP_STARTED';
    end if;
  end if;
  return public.submit_business_claim_core(
    target_business_id, claim_method, normalized_evidence
  );
end;
$$;
revoke all on function public.submit_business_claim(uuid, text, text)
  from public, anon;
grant execute on function public.submit_business_claim(uuid, text, text)
  to authenticated;

