-- PostgreSQL ARE repetition bounds reject counts above 255 at evaluation time.
-- Centralize the 512-character media path contract without a large bounded
-- repetition so cleanup and account deletion cannot fail on valid paths.

create or replace function private.is_valid_media_storage_path(target_path text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select target_path is not null
    and char_length(target_path) <= 512
    and target_path ~ '^(quarantine|published)/[A-Za-z0-9][A-Za-z0-9/_.-]*$'
    and target_path !~ '(^|/)\.\.?(/|$)'
    and target_path not like '%//%'
    and right(target_path, 1) <> '/';
$$;

revoke all on function private.is_valid_media_storage_path(text)
  from public, anon, authenticated;
grant execute on function private.is_valid_media_storage_path(text)
  to service_role;

alter table private.media_cleanup_items
  drop constraint if exists media_cleanup_items_path;
alter table private.media_cleanup_items
  add constraint media_cleanup_items_path
  check (private.is_valid_media_storage_path(storage_path));

alter table private.account_deletion_storage_items
  drop constraint if exists account_deletion_storage_path;
alter table private.account_deletion_storage_items
  add constraint account_deletion_storage_path
  check (private.is_valid_media_storage_path(storage_path));

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
    and private.is_valid_media_storage_path(orphan.storage_path)
  on conflict (storage_path) do nothing;

  -- Registration and cleanup take the same path lock. Recheck after the
  -- lock so a just-registered object can never be claimed as unregistered.
  for target_storage_path in
    select object.name
    from storage.objects object
    where object.bucket_id = 'spottr-media'
      and object.name like 'quarantine/%'
      and private.is_valid_media_storage_path(object.name)
      and object.created_at < now() - interval '1 hour'
      and not exists (
        select 1 from public.media_assets asset where asset.storage_path = object.name
      )
      and not exists (
        select 1 from private.media_stage_grants stage_grant
        where stage_grant.storage_path = object.name
          and stage_grant.state not in ('cancelled', 'expired')
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
    left join private.media_stage_grants stage_grant on stage_grant.storage_path = object.name
    where object.bucket_id = 'spottr-media' and object.name = target_storage_path
      and asset.id is null
      and (stage_grant.id is null or stage_grant.state in ('cancelled', 'expired'))
      and object.created_at < now() - interval '1 hour'
      and private.is_valid_media_storage_path(object.name)
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
      and private.is_valid_media_storage_path(asset.storage_path)
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

revoke all on function public.prepare_media_cleanup_batch()
  from public, anon, authenticated;
grant execute on function public.prepare_media_cleanup_batch()
  to service_role;

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
    or exists (
      select 1 from unnest(paths) as supplied(path)
      where not private.is_valid_media_storage_path(supplied.path)
    )
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
  delete from private.media_stage_grants stage_grant using private.media_cleanup_items item
  where item.batch_id = target_batch_id and item.state = 'claimed'
    and stage_grant.storage_path = item.storage_path and stage_grant.state in ('cancelled', 'expired');
  update private.media_cleanup_items set state = 'finalized', finalized_at = now(), lease_expires_at = null
  where batch_id = target_batch_id and state = 'claimed';
  return jsonb_build_object('batch_id', target_batch_id, 'deleted_asset_records', deleted_assets);
end;
$$;

revoke all on function public.finalize_media_cleanup_batch(uuid, text[])
  from public, anon, authenticated;
grant execute on function public.finalize_media_cleanup_batch(uuid, text[])
  to service_role;

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
    or exists (
      select 1 from unnest(paths) as supplied(path)
      where not private.is_valid_media_storage_path(supplied.path)
    )
    or exists (
      select 1 from unnest(paths) supplied(path)
      where not exists (
        select 1 from private.account_deletion_storage_items item
        where item.request_id = target_request_id and item.storage_path = supplied.path
          and item.state in ('pending', 'deleted')
      )
    )
    or not exists (
      select 1 from private.account_deletion_freezes deletion_freeze
      where deletion_freeze.user_id = target_user_id and deletion_freeze.request_id = target_request_id
    )
  then raise exception using errcode = '22023', message = 'INVALID_ACCOUNT_DELETION_STORAGE_RECEIPT'; end if;

  update private.account_deletion_storage_items set state = 'deleted', deleted_at = now()
  where request_id = target_request_id and storage_path = any(paths) and state = 'pending';
  select count(*) into pending_count from private.account_deletion_storage_items
  where request_id = target_request_id and state = 'pending';
  return jsonb_build_object('pending_count', pending_count, 'storage_complete', pending_count = 0);
end;
$$;

revoke all on function public.checkpoint_account_deletion_storage_batch(uuid, uuid, text[])
  from public, anon, authenticated;
grant execute on function public.checkpoint_account_deletion_storage_batch(uuid, uuid, text[])
  to service_role;
