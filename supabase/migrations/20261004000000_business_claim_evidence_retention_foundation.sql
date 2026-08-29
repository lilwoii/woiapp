-- Private, fail-closed retention boundary for business-claim evidence.
--
-- Claim approval and evidence intake remain disabled. This migration only
-- moves legacy evidence references out of the public schema, protects retained
-- objects from generic/account-deletion cleanup, and installs a disabled,
-- receipt-driven purge boundary. No retention period is invented here:
-- counsel-approved policy_version and purge_after values are required before
-- an evidence object can ever become purge eligible.

create table private.business_claim_evidence_runtime_config (
  singleton boolean primary key default true check (singleton),
  intake_enabled boolean not null default false,
  purge_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

insert into private.business_claim_evidence_runtime_config (
  singleton,
  intake_enabled,
  purge_enabled
)
values (true, false, false)
on conflict (singleton) do nothing;

revoke all privileges on table private.business_claim_evidence_runtime_config
  from public, anon, authenticated, service_role;

create table private.business_claim_evidence (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid unique references public.business_claims(id) on delete set null,
  business_id uuid references public.businesses(id) on delete set null,
  claimant_id uuid references auth.users(id) on delete set null,
  stage_grant_id uuid unique references private.media_stage_grants(id) on delete set null,
  source text not null default 'legacy_backfill'
    check (source in ('legacy_backfill', 'claim_intake')),
  storage_path text unique,
  storage_path_hash text not null unique,
  scan_state text not null default 'unscanned'
    check (scan_state in ('unscanned', 'clean', 'rejected', 'error')),
  lifecycle_state text not null default 'retained'
    check (lifecycle_state in ('retained', 'purge_eligible', 'purge_claimed', 'purged')),
  legal_hold boolean not null default true,
  retention_policy_version text,
  purge_after timestamptz,
  purge_batch_id uuid,
  purge_claimed_at timestamptz,
  purge_lease_expires_at timestamptz,
  purge_attempt_count integer not null default 0
    check (purge_attempt_count between 0 and 10000),
  purged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_claim_evidence_path_hash check (
    storage_path_hash ~ '^[0-9a-f]{64}$'
    and (
      storage_path is null
      or storage_path_hash = encode(extensions.digest(storage_path, 'sha256'), 'hex')
    )
  ),
  constraint business_claim_evidence_path check (
    storage_path is null
    or (
      private.is_valid_media_storage_path(storage_path)
      and storage_path ~ '^quarantine/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$'
      and (
        claimant_id is null
        or storage_path like ('quarantine/' || claimant_id::text || '/%')
      )
    )
  ),
  constraint business_claim_evidence_policy_shape check (
    (legal_hold and lifecycle_state = 'retained'
      and purge_after is null and retention_policy_version is null
      and purge_batch_id is null and purge_claimed_at is null
      and purge_lease_expires_at is null and purged_at is null
      and storage_path is not null)
    or
    (not legal_hold and lifecycle_state = 'retained'
      and purge_after is null and retention_policy_version is null
      and purge_batch_id is null and purge_claimed_at is null
      and purge_lease_expires_at is null and purged_at is null
      and storage_path is not null)
    or
    (not legal_hold and lifecycle_state = 'purge_eligible'
      and retention_policy_version is not null
      and btrim(retention_policy_version) <> ''
      and purge_after is not null
      and purge_batch_id is null and purge_claimed_at is null
      and purge_lease_expires_at is null and purged_at is null
      and storage_path is not null)
    or
    (not legal_hold and lifecycle_state = 'purge_claimed'
      and retention_policy_version is not null
      and btrim(retention_policy_version) <> ''
      and purge_after is not null and purge_batch_id is not null
      and purge_claimed_at is not null
      and purge_lease_expires_at > purge_claimed_at
      and purge_lease_expires_at <= purge_claimed_at + interval '15 minutes'
      and purged_at is null and storage_path is not null)
    or
    (not legal_hold and lifecycle_state = 'purged'
      and retention_policy_version is not null
      and btrim(retention_policy_version) <> ''
      and purge_after is not null and purge_batch_id is null
      and purge_claimed_at is null and purge_lease_expires_at is null
      and purged_at is not null and storage_path is null)
  )
);

create index business_claim_evidence_claimant_idx
  on private.business_claim_evidence (claimant_id, created_at, id)
  where claimant_id is not null;
create index business_claim_evidence_purge_idx
  on private.business_claim_evidence (
    lifecycle_state,
    purge_after,
    purge_lease_expires_at,
    created_at,
    id
  );

revoke all privileges on table private.business_claim_evidence
  from public, anon, authenticated, service_role;

create table private.business_claim_evidence_audit (
  id bigint generated always as identity primary key,
  evidence_id uuid references private.business_claim_evidence(id) on delete set null,
  action text not null check (action in (
    'legacy_backfilled',
    'evidence_registered',
    'scan_state_changed',
    'legal_hold_changed',
    'lifecycle_state_changed'
  )),
  actor_id uuid references auth.users(id) on delete set null,
  from_state text,
  to_state text,
  occurred_at timestamptz not null default now()
);

create index business_claim_evidence_audit_evidence_idx
  on private.business_claim_evidence_audit (evidence_id, occurred_at, id);

revoke all privileges on table private.business_claim_evidence_audit
  from public, anon, authenticated, service_role;

create table private.business_claim_evidence_account_deletion_exceptions (
  request_id uuid not null
    references private.account_deletion_requests(id) on delete cascade,
  evidence_id uuid not null
    references private.business_claim_evidence(id) on delete restrict,
  reason text not null default 'retention_boundary'
    check (reason = 'retention_boundary'),
  created_at timestamptz not null default now(),
  primary key (request_id, evidence_id)
);

revoke all privileges on table private.business_claim_evidence_account_deletion_exceptions
  from public, anon, authenticated, service_role;

create or replace function private.is_valid_sorted_sha256_hash_array(
  target_hashes text[],
  maximum_count integer
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select target_hashes is not null
    and maximum_count between 1 and 1000
    and cardinality(target_hashes) between 1 and maximum_count
    and cardinality(target_hashes) = (
      select count(distinct hash_value)
      from unnest(target_hashes) as supplied(hash_value)
    )
    and not exists (
      select 1
      from unnest(target_hashes) as supplied(hash_value)
      where hash_value is null or hash_value !~ '^[0-9a-f]{64}$'
    )
    and target_hashes = (
      select array_agg(hash_value order by hash_value)
      from unnest(target_hashes) as supplied(hash_value)
    );
$$;

revoke all on function private.is_valid_sorted_sha256_hash_array(text[], integer)
  from public, anon, authenticated, service_role;

create table private.business_claim_evidence_purge_receipts (
  batch_id uuid primary key,
  state text not null default 'claimed'
    check (state in ('claimed', 'finalized', 'superseded')),
  path_hashes text[] not null,
  item_count integer not null check (item_count between 1 and 100),
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  superseded_at timestamptz,
  constraint business_claim_evidence_purge_receipt_hashes check (
    cardinality(path_hashes) = item_count
    and private.is_valid_sorted_sha256_hash_array(path_hashes, 100)
  ),
  constraint business_claim_evidence_purge_receipt_state check (
    (state = 'claimed' and finalized_at is null and superseded_at is null)
    or (state = 'superseded' and finalized_at is null and superseded_at is not null)
    or (state = 'finalized' and finalized_at is not null and superseded_at is null)
  )
);

revoke all privileges on table private.business_claim_evidence_purge_receipts
  from public, anon, authenticated, service_role;

create or replace function private.audit_business_claim_evidence_insert()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into private.business_claim_evidence_audit (
    evidence_id,
    action,
    actor_id,
    from_state,
    to_state
  ) values (
    new.id,
    case
      when new.source = 'legacy_backfill' then 'legacy_backfilled'
      else 'evidence_registered'
    end,
    null,
    null,
    new.lifecycle_state
  );
  return new;
end;
$$;

revoke all on function private.audit_business_claim_evidence_insert()
  from public, anon, authenticated, service_role;

create trigger audit_business_claim_evidence_insert
after insert on private.business_claim_evidence
for each row execute function private.audit_business_claim_evidence_insert();

create or replace function private.audit_business_claim_evidence_transition()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();

  if old.storage_path_hash <> new.storage_path_hash then
    raise exception using errcode = '22023', message = 'CLAIM_EVIDENCE_HASH_IMMUTABLE';
  end if;
  if old.storage_path is distinct from new.storage_path
    and not (
      old.storage_path is not null
      and new.storage_path is null
      and new.lifecycle_state = 'purged'
    )
  then
    raise exception using errcode = '22023', message = 'CLAIM_EVIDENCE_PATH_IMMUTABLE';
  end if;

  if old.scan_state is distinct from new.scan_state then
    insert into private.business_claim_evidence_audit (
      evidence_id, action, actor_id, from_state, to_state
    ) values (
      new.id, 'scan_state_changed', null, old.scan_state, new.scan_state
    );
  end if;
  if old.legal_hold is distinct from new.legal_hold then
    insert into private.business_claim_evidence_audit (
      evidence_id, action, actor_id, from_state, to_state
    ) values (
      new.id,
      'legal_hold_changed',
      null,
      case when old.legal_hold then 'held' else 'released' end,
      case when new.legal_hold then 'held' else 'released' end
    );
  end if;
  if old.lifecycle_state is distinct from new.lifecycle_state then
    insert into private.business_claim_evidence_audit (
      evidence_id, action, actor_id, from_state, to_state
    ) values (
      new.id, 'lifecycle_state_changed', null,
      old.lifecycle_state, new.lifecycle_state
    );
  end if;
  return new;
end;
$$;

revoke all on function private.audit_business_claim_evidence_transition()
  from public, anon, authenticated, service_role;

create trigger audit_business_claim_evidence_transition
before update on private.business_claim_evidence
for each row execute function private.audit_business_claim_evidence_transition();

-- Validate and serialize legacy references before moving them. A bad path,
-- missing object, or in-flight/finalized deletion aborts the migration instead
-- of silently producing a false retention record.
lock table public.business_claims in share row exclusive mode;
lock table private.media_cleanup_items in share row exclusive mode;
lock table private.account_deletion_storage_items in share row exclusive mode;

do $legacy_claim_evidence_validation$
begin
  if exists (
    select 1
    from public.business_claims claim
    where claim.evidence_private_path is not null
      and (
        not private.is_valid_media_storage_path(claim.evidence_private_path)
        or claim.evidence_private_path !~ '^quarantine/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$'
        or claim.evidence_private_path not like ('quarantine/' || claim.claimant_id::text || '/%')
      )
  ) then
    raise exception using errcode = '22023', message = 'INVALID_LEGACY_CLAIM_EVIDENCE_PATH';
  end if;

  if exists (
    select claim.evidence_private_path
    from public.business_claims claim
    where claim.evidence_private_path is not null
    group by claim.evidence_private_path
    having count(*) > 1
  ) then
    raise exception using errcode = '23505', message = 'DUPLICATE_LEGACY_CLAIM_EVIDENCE_PATH';
  end if;

  if exists (
    select 1
    from public.business_claims claim
    where claim.evidence_private_path is not null
      and not exists (
        select 1
        from storage.objects object
        where object.bucket_id = 'spottr-media'
          and object.name = claim.evidence_private_path
      )
  ) then
    raise exception using errcode = '55000', message = 'LEGACY_CLAIM_EVIDENCE_OBJECT_MISSING';
  end if;

  if exists (
    select 1
    from public.business_claims claim
    join private.media_stage_grants stage_grant
      on stage_grant.storage_path = claim.evidence_private_path
    where claim.evidence_private_path is not null
      and (
        stage_grant.purpose <> 'claim_evidence'
        or stage_grant.owner_id <> claim.claimant_id
        or stage_grant.business_id is distinct from claim.business_id
      )
  ) then
    raise exception using errcode = '55000', message = 'LEGACY_CLAIM_EVIDENCE_STAGE_GRANT_MISMATCH';
  end if;

  if exists (
    select 1
    from public.business_claims claim
    join private.media_stage_grants stage_grant
      on stage_grant.storage_path = claim.evidence_private_path
    where claim.evidence_private_path is not null
      and stage_grant.state in ('issued', 'registered')
      and stage_grant.expires_at > now()
  ) then
    raise exception using errcode = '55000', message = 'LEGACY_CLAIM_EVIDENCE_UPLOAD_CAPABILITY_ACTIVE';
  end if;

  if exists (
    select 1
    from public.business_claims claim
    join private.media_cleanup_items cleanup
      on cleanup.storage_path = claim.evidence_private_path
    where claim.evidence_private_path is not null
      and cleanup.state in ('claimed', 'finalized')
  ) then
    raise exception using errcode = '55000', message = 'LEGACY_CLAIM_EVIDENCE_CLEANUP_CONFLICT';
  end if;

  if exists (
    select 1
    from public.business_claims claim
    join private.account_deletion_requests request
      on request.user_id = claim.claimant_id
    where claim.evidence_private_path is not null
      and request.state in ('storage_deleted', 'completed')
  ) then
    raise exception using errcode = '55000', message = 'LEGACY_CLAIM_EVIDENCE_DELETION_ALREADY_SEALED';
  end if;

  if exists (
    select 1
    from public.business_claims claim
    join private.account_deletion_storage_items deletion_item
      on deletion_item.storage_path = claim.evidence_private_path
    where claim.evidence_private_path is not null
      and deletion_item.state = 'deleted'
  ) then
    raise exception using errcode = '55000', message = 'LEGACY_CLAIM_EVIDENCE_ALREADY_DELETED';
  end if;
end;
$legacy_claim_evidence_validation$;

insert into private.business_claim_evidence (
  claim_id,
  business_id,
  claimant_id,
  stage_grant_id,
  storage_path,
  storage_path_hash
)
select
  claim.id,
  claim.business_id,
  claim.claimant_id,
  stage_grant.id,
  claim.evidence_private_path,
  encode(extensions.digest(claim.evidence_private_path, 'sha256'), 'hex')
from public.business_claims claim
left join private.media_stage_grants stage_grant
  on stage_grant.storage_path = claim.evidence_private_path
where claim.evidence_private_path is not null;

insert into private.business_claim_evidence_account_deletion_exceptions (
  request_id,
  evidence_id,
  reason
)
select request.id, evidence.id, 'retention_boundary'
from private.business_claim_evidence evidence
join private.account_deletion_requests request
  on request.user_id = evidence.claimant_id
where evidence.lifecycle_state <> 'purged'
  and request.state in ('started', 'processing')
on conflict (request_id, evidence_id) do nothing;

delete from private.media_cleanup_items cleanup
using private.business_claim_evidence evidence
where cleanup.storage_path = evidence.storage_path
  and cleanup.state = 'pending';

delete from private.account_deletion_storage_items deletion_item
using private.business_claim_evidence evidence
where deletion_item.storage_path = evidence.storage_path
  and deletion_item.state = 'pending'
  and exists (
    select 1
    from private.business_claim_evidence_account_deletion_exceptions exception_row
    where exception_row.request_id = deletion_item.request_id
      and exception_row.evidence_id = evidence.id
  );

update public.business_claims
set evidence_private_path = null
where evidence_private_path is not null;

alter table public.business_claims
  add constraint business_claims_legacy_evidence_path_retired
  check (evidence_private_path is null);

create or replace function public.business_claim_evidence_intake_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select config.intake_enabled
    from private.business_claim_evidence_runtime_config config
    where config.singleton
  ), false);
$$;

revoke all on function public.business_claim_evidence_intake_enabled()
  from public, anon, authenticated, service_role;
grant execute on function public.business_claim_evidence_intake_enabled()
  to service_role;

create or replace function private.is_protected_business_claim_evidence_path(
  target_storage_path text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select target_storage_path is not null
    and exists (
      select 1
      from private.business_claim_evidence evidence
      where evidence.storage_path = target_storage_path
        and evidence.lifecycle_state <> 'purged'
    );
$$;

revoke all on function private.is_protected_business_claim_evidence_path(text)
  from public, anon, authenticated, service_role;
grant execute on function private.is_protected_business_claim_evidence_path(text)
  to authenticated;

drop policy if exists "users delete own quarantine media" on storage.objects;
create policy "users delete own quarantine media"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'spottr-media'
    and (storage.foldername(name))[1] = 'quarantine'
    and (storage.foldername(name))[2] = auth.uid()::text
    and not private.is_protected_business_claim_evidence_path(name)
    and not exists (
      select 1
      from public.media_assets asset
      where asset.storage_path = name
        and asset.quarantine_state = 'clean'
    )
  );

create or replace function public.prepare_business_claim_evidence_purge_batch()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  batch uuid := gen_random_uuid();
  paths text[];
  path_hashes text[];
begin
  if not coalesce((
    select config.purge_enabled
    from private.business_claim_evidence_runtime_config config
    where config.singleton
  ), false) then
    return jsonb_build_object(
      'enabled', false,
      'batch_id', null,
      'storage_paths', '[]'::jsonb
    );
  end if;

  update private.business_claim_evidence_purge_receipts receipt
  set state = 'superseded', superseded_at = now()
  where receipt.state = 'claimed'
    and exists (
      select 1
      from private.business_claim_evidence evidence
      where evidence.purge_batch_id = receipt.batch_id
        and evidence.lifecycle_state = 'purge_claimed'
        and evidence.purge_lease_expires_at <= now()
    );

  with candidates as (
    select evidence.id
    from private.business_claim_evidence evidence
    left join private.media_stage_grants stage_grant
      on stage_grant.id = evidence.stage_grant_id
    where not evidence.legal_hold
      and evidence.storage_path is not null
      and evidence.purge_after is not null
      and evidence.purge_after <= now()
      and nullif(btrim(evidence.retention_policy_version), '') is not null
      and not exists (
        select 1
        from private.account_deletion_freezes deletion_freeze
        where deletion_freeze.user_id = evidence.claimant_id
      )
      and not exists (
        select 1
        from private.business_claim_evidence_account_deletion_exceptions exception_row
        where exception_row.evidence_id = evidence.id
      )
      and (
        evidence.lifecycle_state = 'purge_eligible'
        or (
          evidence.lifecycle_state = 'purge_claimed'
          and evidence.purge_lease_expires_at <= now()
        )
      )
      and (
        stage_grant.id is null
        or (
          stage_grant.state in ('cancelled', 'expired')
          and stage_grant.expires_at <= now()
        )
      )
    order by evidence.purge_after, evidence.created_at, evidence.id
    for update of evidence skip locked
    limit 100
  )
  update private.business_claim_evidence evidence
  set lifecycle_state = 'purge_claimed',
      purge_batch_id = batch,
      purge_claimed_at = now(),
      purge_lease_expires_at = now() + interval '15 minutes',
      purge_attempt_count = evidence.purge_attempt_count + 1
  from candidates
  where evidence.id = candidates.id;

  select coalesce(
    array_agg(evidence.storage_path order by evidence.storage_path),
    '{}'::text[]
  )
  into paths
  from private.business_claim_evidence evidence
  where evidence.purge_batch_id = batch
    and evidence.lifecycle_state = 'purge_claimed';

  if cardinality(paths) = 0 then
    return jsonb_build_object(
      'enabled', true,
      'batch_id', null,
      'storage_paths', '[]'::jsonb
    );
  end if;

  select array_agg(evidence.storage_path_hash order by evidence.storage_path_hash)
  into path_hashes
  from private.business_claim_evidence evidence
  where evidence.purge_batch_id = batch
    and evidence.lifecycle_state = 'purge_claimed';

  insert into private.business_claim_evidence_purge_receipts (
    batch_id,
    state,
    path_hashes,
    item_count
  ) values (
    batch,
    'claimed',
    path_hashes,
    cardinality(path_hashes)
  );

  return jsonb_build_object(
    'enabled', true,
    'batch_id', batch,
    'storage_paths', to_jsonb(paths)
  );
end;
$$;

revoke all on function public.prepare_business_claim_evidence_purge_batch()
  from public, anon, authenticated, service_role;
grant execute on function public.prepare_business_claim_evidence_purge_batch()
  to service_role;

create or replace function public.finalize_business_claim_evidence_purge_batch(
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
  paths text[] := coalesce(deleted_storage_paths, '{}'::text[]);
  supplied_path_hashes text[];
  receipt private.business_claim_evidence_purge_receipts%rowtype;
  finalized_count integer := 0;
begin
  if target_batch_id is null
    or cardinality(paths) = 0
    or cardinality(paths) > 100
    or cardinality(paths) <> (
      select count(distinct supplied.path)
      from unnest(paths) as supplied(path)
    )
    or exists (
      select 1
      from unnest(paths) as supplied(path)
      where not private.is_valid_media_storage_path(supplied.path)
    )
  then
    raise exception using
      errcode = '22023',
      message = 'INVALID_CLAIM_EVIDENCE_PURGE_RECEIPT';
  end if;

  select array_agg(hashed.path_hash order by hashed.path_hash)
  into supplied_path_hashes
  from (
    select encode(extensions.digest(supplied.path, 'sha256'), 'hex') as path_hash
    from unnest(paths) as supplied(path)
  ) hashed;

  select current_receipt.*
  into receipt
  from private.business_claim_evidence_purge_receipts current_receipt
  where current_receipt.batch_id = target_batch_id
  for update;

  if not found
    or supplied_path_hashes is distinct from receipt.path_hashes
  then
    raise exception using
      errcode = '22023',
      message = 'INVALID_CLAIM_EVIDENCE_PURGE_RECEIPT';
  end if;

  if receipt.state = 'finalized' then
    return jsonb_build_object(
      'batch_id', target_batch_id,
      'finalized_count', receipt.item_count,
      'already_finalized', true
    );
  end if;

  if receipt.state = 'superseded' then
    raise exception using
      errcode = '40001',
      message = 'CLAIM_EVIDENCE_PURGE_BATCH_SUPERSEDED';
  end if;

  if receipt.item_count <> cardinality(paths)
    or cardinality(paths) <> (
      select count(*)
      from private.business_claim_evidence evidence
      where evidence.purge_batch_id = target_batch_id
        and evidence.lifecycle_state = 'purge_claimed'
    )
    or exists (
      select 1
      from unnest(paths) as supplied(path)
      where not exists (
        select 1
        from private.business_claim_evidence evidence
        where evidence.purge_batch_id = target_batch_id
          and evidence.lifecycle_state = 'purge_claimed'
          and not evidence.legal_hold
          and evidence.storage_path = supplied.path
      )
    )
    or exists (
      select 1
      from private.business_claim_evidence evidence
      where evidence.purge_batch_id = target_batch_id
        and evidence.lifecycle_state = 'purge_claimed'
        and not (evidence.storage_path = any(paths))
    )
  then
    raise exception using
      errcode = '22023',
      message = 'INVALID_CLAIM_EVIDENCE_PURGE_RECEIPT';
  end if;

  update private.media_stage_grants stage_grant
  set state = 'expired',
      registered_asset_id = null,
      updated_at = now()
  from private.business_claim_evidence evidence
  where evidence.purge_batch_id = target_batch_id
    and evidence.lifecycle_state = 'purge_claimed'
    and evidence.stage_grant_id = stage_grant.id
    and stage_grant.state in ('cancelled', 'expired');

  update private.business_claim_evidence evidence
  set lifecycle_state = 'purged',
      storage_path = null,
      purge_batch_id = null,
      purge_claimed_at = null,
      purge_lease_expires_at = null,
      purged_at = now()
  where evidence.purge_batch_id = target_batch_id
    and evidence.lifecycle_state = 'purge_claimed'
    and not evidence.legal_hold
    and evidence.storage_path = any(paths);
  get diagnostics finalized_count = row_count;

  if finalized_count <> receipt.item_count then
    raise exception using
      errcode = '40001',
      message = 'CLAIM_EVIDENCE_PURGE_FINALIZE_CONFLICT';
  end if;

  update private.business_claim_evidence_purge_receipts current_receipt
  set state = 'finalized', finalized_at = now()
  where current_receipt.batch_id = target_batch_id
    and current_receipt.state = 'claimed';

  return jsonb_build_object(
    'batch_id', target_batch_id,
    'finalized_count', finalized_count,
    'already_finalized', false
  );
end;
$$;

revoke all on function public.finalize_business_claim_evidence_purge_batch(uuid, text[])
  from public, anon, authenticated, service_role;
grant execute on function public.finalize_business_claim_evidence_purge_batch(uuid, text[])
  to service_role;

-- Generic media cleanup must treat every non-purged evidence row as protected.
-- Only the dedicated, disabled purge receipt boundary may retire those paths.
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

  for target_storage_path in
    select object.name
    from storage.objects object
    where object.bucket_id = 'spottr-media'
      and object.name like 'quarantine/%'
      and private.is_valid_media_storage_path(object.name)
      and object.created_at < now() - interval '1 hour'
      and not exists (
        select 1 from public.media_assets asset
        where asset.storage_path = object.name
      )
      and not exists (
        select 1 from private.media_stage_grants stage_grant
        where stage_grant.storage_path = object.name
          and stage_grant.state not in ('cancelled', 'expired')
      )
      and not exists (
        select 1
        from private.business_claim_evidence evidence
        where evidence.storage_path = object.name
          and evidence.lifecycle_state <> 'purged'
      )
    order by object.created_at, object.name
    limit 500
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(target_storage_path, 7741903)
    );
    insert into private.media_cleanup_items (storage_path, owner_id, reason)
    select object.name,
      case
        when split_part(object.name, '/', 2) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then split_part(object.name, '/', 2)::uuid
        else null
      end,
      'unregistered_upload'
    from storage.objects object
    left join public.media_assets asset
      on asset.storage_path = object.name
    left join private.media_stage_grants stage_grant
      on stage_grant.storage_path = object.name
    where object.bucket_id = 'spottr-media'
      and object.name = target_storage_path
      and asset.id is null
      and (stage_grant.id is null or stage_grant.state in ('cancelled', 'expired'))
      and object.created_at < now() - interval '1 hour'
      and private.is_valid_media_storage_path(object.name)
      and not exists (
        select 1
        from private.business_claim_evidence evidence
        where evidence.storage_path = object.name
          and evidence.lifecycle_state <> 'purged'
      )
    on conflict (storage_path) do nothing;
  end loop;

  for target_asset_id in
    select asset.id
    from public.media_assets asset
    left join private.media_scan_claims scan_claim
      on scan_claim.asset_id = asset.id
    where asset.moderation <> 'approved'
      and private.is_valid_media_storage_path(asset.storage_path)
      and not exists (
        select 1
        from private.business_claim_evidence evidence
        where evidence.storage_path = asset.storage_path
          and evidence.lifecycle_state <> 'purged'
      )
      and (
        (
          asset.quarantine_state in ('uploaded', 'scanning')
          and asset.created_at < now() - interval '24 hours'
        )
        or (
          asset.quarantine_state = 'rejected'
          and asset.created_at < now() - interval '7 days'
        )
      )
      and (scan_claim.asset_id is null or scan_claim.lease_expires_at <= now())
    order by asset.created_at, asset.id
    for update of asset skip locked
    limit 500
  loop
    insert into private.media_cleanup_items (
      storage_path,
      asset_id,
      owner_id,
      reason
    )
    select asset.storage_path, asset.id, asset.owner_id, 'stale_asset'
    from public.media_assets asset
    where asset.id = target_asset_id
    on conflict (storage_path) do nothing;
  end loop;

  with candidates as (
    select item.id
    from private.media_cleanup_items item
    where (
      item.state = 'pending'
      or (item.state = 'claimed' and item.lease_expires_at <= now())
    )
      and not exists (
        select 1
        from private.business_claim_evidence evidence
        where evidence.storage_path = item.storage_path
          and evidence.lifecycle_state <> 'purged'
      )
    order by item.created_at, item.id
    for update of item skip locked
    limit 500
  )
  update private.media_cleanup_items item
  set state = 'claimed',
      batch_id = batch,
      claimed_at = now(),
      lease_expires_at = now() + interval '15 minutes',
      attempt_count = item.attempt_count + 1
  from candidates
  where item.id = candidates.id;

  select coalesce(
    array_agg(item.storage_path order by item.storage_path),
    '{}'::text[]
  )
  into paths
  from private.media_cleanup_items item
  where item.batch_id = batch and item.state = 'claimed';

  return jsonb_build_object('batch_id', batch, 'storage_paths', to_jsonb(paths));
end;
$$;

revoke all on function public.prepare_media_cleanup_batch()
  from public, anon, authenticated, service_role;
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
declare
  paths text[] := coalesce(deleted_storage_paths, '{}'::text[]);
  deleted_assets integer := 0;
begin
  if target_batch_id is null
    or cardinality(paths) > 500
    or cardinality(paths) <> (
      select count(distinct supplied.path)
      from unnest(paths) as supplied(path)
    )
    or exists (
      select 1
      from unnest(paths) as supplied(path)
      where not private.is_valid_media_storage_path(supplied.path)
    )
    or cardinality(paths) <> (
      select count(*)
      from private.media_cleanup_items item
      where item.batch_id = target_batch_id and item.state = 'claimed'
    )
    or exists (
      select 1
      from unnest(paths) supplied(path)
      where not exists (
        select 1
        from private.media_cleanup_items item
        where item.batch_id = target_batch_id
          and item.state = 'claimed'
          and item.storage_path = supplied.path
      )
    )
    or exists (
      select 1
      from private.media_cleanup_items item
      where item.batch_id = target_batch_id
        and item.state = 'claimed'
        and not (item.storage_path = any(paths))
    )
    or exists (
      select 1
      from private.media_cleanup_items item
      join private.business_claim_evidence evidence
        on evidence.storage_path = item.storage_path
      where item.batch_id = target_batch_id
        and item.state = 'claimed'
        and evidence.lifecycle_state <> 'purged'
    )
  then
    raise exception using
      errcode = '22023',
      message = 'INVALID_MEDIA_CLEANUP_RECEIPT';
  end if;

  delete from public.media_assets asset
  using private.media_cleanup_items item
  where item.batch_id = target_batch_id
    and item.state = 'claimed'
    and item.reason = 'stale_asset'
    and item.asset_id = asset.id
    and asset.moderation <> 'approved'
    and asset.quarantine_state in ('uploaded', 'scanning', 'rejected');
  get diagnostics deleted_assets = row_count;

  delete from private.media_orphan_paths orphan
  using private.media_cleanup_items item
  where item.batch_id = target_batch_id
    and item.state = 'claimed'
    and orphan.storage_path = item.storage_path;

  delete from private.media_stage_grants stage_grant
  using private.media_cleanup_items item
  where item.batch_id = target_batch_id
    and item.state = 'claimed'
    and stage_grant.storage_path = item.storage_path
    and stage_grant.state in ('cancelled', 'expired');

  update private.media_cleanup_items
  set state = 'finalized', finalized_at = now(), lease_expires_at = null
  where batch_id = target_batch_id and state = 'claimed';

  return jsonb_build_object(
    'batch_id', target_batch_id,
    'deleted_asset_records', deleted_assets
  );
end;
$$;

revoke all on function public.finalize_media_cleanup_batch(uuid, text[])
  from public, anon, authenticated, service_role;
grant execute on function public.finalize_media_cleanup_batch(uuid, text[])
  to service_role;

-- These pre-lease cleanup RPCs are permanently retired. Revoke again so a
-- manually broadened ACL in an older environment cannot survive this upgrade.
revoke all on function public.media_quarantine_cleanup_manifest()
  from public, anon, authenticated, service_role;
revoke all on function public.finalize_media_quarantine_cleanup(text[])
  from public, anon, authenticated, service_role;

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
declare
  paths text[];
  wait_seconds integer := 0;
  pending_count integer;
  preserved_evidence_count integer;
begin
  if not exists (
    select 1
    from private.account_deletion_requests request
    join private.account_deletion_freezes deletion_freeze
      on deletion_freeze.request_id = request.id
      and deletion_freeze.user_id = request.user_id
    where request.id = target_request_id
      and request.user_id = target_user_id
      and request.state in ('processing', 'storage_deleted')
      and request.expires_at > now()
  ) then
    raise exception using
      errcode = '42501',
      message = 'ACCOUNT_DELETION_CLAIM_REQUIRED';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_user_id::text, 7741902)
  );

  update private.media_stage_grants
  set state = 'expired', registered_asset_id = null, updated_at = now()
  where owner_id = target_user_id
    and state in ('issued', 'registered')
    and expires_at <= now();

  select greatest(
    0,
    ceil(extract(epoch from max(blocked_until - now())))::integer
  )
  into wait_seconds
  from (
    select stage_grant.expires_at as blocked_until
    from private.media_stage_grants stage_grant
    where stage_grant.owner_id = target_user_id
      and stage_grant.state in ('issued', 'registered')
      and stage_grant.expires_at > now()
    union all
    select claim.lease_expires_at + interval '15 minutes'
    from private.media_scan_claims claim
    where claim.owner_id = target_user_id
      and claim.lease_expires_at + interval '15 minutes' > now()
  ) blockers;

  if coalesce(wait_seconds, 0) > 0 then
    return jsonb_build_object(
      'ready', false,
      'retry_after_seconds', least(wait_seconds + 5, 7800)
    );
  end if;

  if exists (
    select 1
    from private.business_claim_evidence evidence
    where evidence.claimant_id = target_user_id
      and evidence.lifecycle_state = 'purge_claimed'
  ) then
    return jsonb_build_object(
      'ready', false,
      'retry_after_seconds', 60,
      'blocking_reason', 'claim_evidence_purge_reconciliation'
    );
  end if;

  insert into private.media_orphan_paths (storage_path, owner_id, reason)
  select claim.planned_output_path, claim.owner_id, 'abandoned_scan_output'
  from private.media_scan_claims claim
  where claim.owner_id = target_user_id
    and claim.planned_output_path is not null
  on conflict (storage_path) do nothing;

  delete from private.media_scan_claims
  where owner_id = target_user_id;

  insert into private.business_claim_evidence_account_deletion_exceptions (
    request_id,
    evidence_id,
    reason
  )
  select target_request_id, evidence.id, 'retention_boundary'
  from private.business_claim_evidence evidence
  where evidence.claimant_id = target_user_id
    and evidence.lifecycle_state <> 'purged'
  on conflict (request_id, evidence_id) do nothing;

  insert into private.account_deletion_storage_items (request_id, storage_path)
  select target_request_id, source.path
  from (
    select object.name as path
    from storage.objects object
    where object.bucket_id = 'spottr-media'
      and object.name like ('quarantine/' || target_user_id::text || '/%')
    union
    select asset.storage_path
    from public.media_assets asset
    where asset.owner_id = target_user_id
    union
    select asset.processed_storage_path
    from public.media_assets asset
    where asset.owner_id = target_user_id
      and asset.processed_storage_path is not null
    union
    select stage_grant.storage_path
    from private.media_stage_grants stage_grant
    where stage_grant.owner_id = target_user_id
    union
    select orphan.storage_path
    from private.media_orphan_paths orphan
    where orphan.owner_id = target_user_id
    union
    select profile.avatar_path
    from public.profiles profile
    where profile.user_id = target_user_id
      and profile.avatar_path ~ '^(quarantine|published)/'
  ) source
  where source.path is not null
    and private.is_valid_media_storage_path(source.path)
    and not exists (
      select 1
      from private.business_claim_evidence evidence
      where evidence.storage_path = source.path
        and evidence.lifecycle_state <> 'purged'
    )
  on conflict (request_id, storage_path) do nothing;

  -- Remove a protected path from a previously prepared, still-pending batch.
  -- A deleted receipt is never erased; the seal trigger below fails closed if
  -- an older worker already reported deletion of retained evidence.
  delete from private.account_deletion_storage_items deletion_item
  using private.business_claim_evidence evidence
  where deletion_item.request_id = target_request_id
    and deletion_item.storage_path = evidence.storage_path
    and deletion_item.state = 'pending'
    and evidence.lifecycle_state <> 'purged';

  select coalesce(
    array_agg(item.storage_path order by item.storage_path),
    '{}'::text[]
  )
  into paths
  from (
    select storage_path
    from private.account_deletion_storage_items
    where request_id = target_request_id and state = 'pending'
    order by storage_path
    limit 500
  ) item;

  select count(*)
  into pending_count
  from private.account_deletion_storage_items
  where request_id = target_request_id and state = 'pending';

  select count(*)
  into preserved_evidence_count
  from private.business_claim_evidence_account_deletion_exceptions exception_row
  join private.business_claim_evidence evidence
    on evidence.id = exception_row.evidence_id
  where exception_row.request_id = target_request_id
    and evidence.lifecycle_state <> 'purged';

  return jsonb_build_object(
    'ready', true,
    'storage_paths', to_jsonb(paths),
    'pending_count', pending_count,
    'preserved_evidence_count', preserved_evidence_count
  );
end;
$$;

revoke all on function public.prepare_account_deletion_storage_batch(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.prepare_account_deletion_storage_batch(uuid, uuid)
  to service_role;

create or replace function private.enforce_claim_evidence_account_deletion_seal()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if new.state in ('storage_deleted', 'completed')
    and old.state is distinct from new.state
    and (
      exists (
        select 1
        from private.account_deletion_storage_items deletion_item
        join private.business_claim_evidence evidence
          on evidence.storage_path = deletion_item.storage_path
        where deletion_item.request_id = old.id
          and evidence.lifecycle_state <> 'purged'
      )
      or exists (
        select 1
        from private.business_claim_evidence evidence
        where old.user_id is not null
          and evidence.claimant_id = old.user_id
          and evidence.lifecycle_state <> 'purged'
          and not exists (
            select 1
            from private.business_claim_evidence_account_deletion_exceptions exception_row
            where exception_row.request_id = old.id
              and exception_row.evidence_id = evidence.id
          )
      )
      or exists (
        select 1
        from private.business_claim_evidence_account_deletion_exceptions exception_row
        left join private.business_claim_evidence evidence
          on evidence.id = exception_row.evidence_id
        where exception_row.request_id = old.id
          and (
            evidence.id is null
            or evidence.lifecycle_state = 'purged'
          )
      )
    )
  then
    raise exception using
      errcode = '55000',
      message = 'ACCOUNT_DELETION_CLAIM_EVIDENCE_NOT_SEALED';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_claim_evidence_account_deletion_seal()
  from public, anon, authenticated, service_role;

create trigger enforce_claim_evidence_account_deletion_seal
before update of state on private.account_deletion_requests
for each row execute function private.enforce_claim_evidence_account_deletion_seal();

comment on table private.business_claim_evidence is
  'Private claim-evidence references. Intake and purge default off; legal hold defaults on; no retention duration is implied.';
comment on column private.business_claim_evidence.storage_path is
  'Private storage locator. Never expose through public projections, exports, logs, or audit payloads.';
comment on column private.business_claim_evidence.retention_policy_version is
  'Nullable until an approved legal retention policy authorizes a transition out of retained state.';
