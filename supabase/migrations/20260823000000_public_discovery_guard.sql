-- Fail-closed service boundary for anonymous public discovery.
--
-- The public discovery Edge Function computes HMAC-SHA256 digests before it
-- calls these RPCs.  Raw client IPs and account identifiers must never cross
-- this boundary.  The private tables consequently contain only fixed-width
-- digest values for request identity and lease tokens.

create table if not exists private.public_discovery_rate_buckets (
  operation text not null,
  subject_kind text not null,
  subject_hmac varchar(64) not null,
  bucket_started_at timestamptz not null,
  request_count integer not null default 1,
  constraint public_discovery_rate_buckets_operation
    check (operation in ('map', 'nearby', 'search')),
  constraint public_discovery_rate_buckets_subject_kind
    check (subject_kind in ('ip', 'account')),
  constraint public_discovery_rate_buckets_subject_hmac
    check (subject_hmac ~ '^[0-9a-f]{64}$'),
  constraint public_discovery_rate_buckets_request_count
    check (request_count between 1 and 240),
  primary key (operation, subject_kind, subject_hmac, bucket_started_at)
);

create index if not exists public_discovery_rate_buckets_cleanup_idx
  on private.public_discovery_rate_buckets (bucket_started_at);

create table if not exists private.public_discovery_leases (
  lease_hmac varchar(64) primary key,
  operation text not null,
  ip_hmac varchar(64) not null,
  account_hmac varchar(64),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  constraint public_discovery_leases_operation
    check (operation in ('map', 'nearby', 'search')),
  constraint public_discovery_leases_lease_hmac
    check (lease_hmac ~ '^[0-9a-f]{64}$'),
  constraint public_discovery_leases_ip_hmac
    check (ip_hmac ~ '^[0-9a-f]{64}$'),
  constraint public_discovery_leases_account_hmac
    check (account_hmac is null or account_hmac ~ '^[0-9a-f]{64}$'),
  constraint public_discovery_leases_expiry
    check (expires_at > created_at and expires_at <= created_at + interval '2 minutes')
);

create index if not exists public_discovery_leases_operation_expiry_idx
  on private.public_discovery_leases (operation, expires_at);

revoke all on table
  private.public_discovery_rate_buckets,
  private.public_discovery_leases
  from public, anon, authenticated, service_role;

create or replace function private.is_public_discovery_hmac(candidate text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select candidate is not null and candidate ~ '^[0-9a-f]{64}$';
$$;

revoke all on function private.is_public_discovery_hmac(text)
  from public, anon, authenticated, service_role;

-- This helper is intentionally private.  The limits are supplied as constants
-- by the service-only acquire RPC, and the single transaction makes the IP and
-- account increments all-or-nothing when an authenticated request is limited.
create or replace function private.consume_public_discovery_quota(
  target_operation text,
  target_subject_kind text,
  target_subject_hmac text,
  target_limit integer,
  target_now timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  bucket_start timestamptz;
  accepted_count integer;
begin
  if target_operation is null
    or target_operation not in ('map', 'nearby', 'search')
    or target_subject_kind is null
    or target_subject_kind not in ('ip', 'account')
    or not private.is_public_discovery_hmac(target_subject_hmac)
    or target_limit is null
    or target_limit < 1
    or target_limit > 240
    or target_now is null
  then
    raise exception using errcode = '22023', message = 'INVALID_PUBLIC_DISCOVERY_QUOTA';
  end if;

  bucket_start := pg_catalog.to_timestamp(
    pg_catalog.floor(pg_catalog.date_part('epoch', target_now) / 60) * 60
  );

  insert into private.public_discovery_rate_buckets (
    operation,
    subject_kind,
    subject_hmac,
    bucket_started_at,
    request_count
  )
  values (
    target_operation,
    target_subject_kind,
    target_subject_hmac,
    bucket_start,
    1
  )
  on conflict (operation, subject_kind, subject_hmac, bucket_started_at)
  do update
    set request_count = private.public_discovery_rate_buckets.request_count + 1
    where private.public_discovery_rate_buckets.request_count < target_limit
  returning request_count into accepted_count;

  if accepted_count is null then
    raise exception using
      errcode = 'P0001',
      message = 'PUBLIC_DISCOVERY_RATE_LIMITED';
  end if;
end;
$$;

revoke all on function private.consume_public_discovery_quota(text, text, text, integer, timestamptz)
  from public, anon, authenticated, service_role;

-- The implementation accepts an optional caller-supplied lease digest.  The
-- three-argument public wrapper lets the service receive a fresh HMAC token
-- generated from a cryptographically random nonce without storing that nonce.
create or replace function private.acquire_public_discovery_lease(
  target_operation text,
  target_ip_hmac text,
  target_account_hmac text,
  target_lease_hmac text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  now_value timestamptz := pg_catalog.clock_timestamp();
  lease_value text := target_lease_hmac;
  active_leases integer;
  lease_cap integer;
  account_request boolean := target_account_hmac is not null;
  lease_nonce text;
  pgcrypto_schema text;
  skipped_lock boolean;
begin
  if target_operation is null
    or target_operation not in ('map', 'nearby', 'search')
    or not private.is_public_discovery_hmac(target_ip_hmac)
    or (target_account_hmac is not null and not private.is_public_discovery_hmac(target_account_hmac))
    or (target_lease_hmac is not null and not private.is_public_discovery_hmac(target_lease_hmac))
  then
    raise exception using errcode = '22023', message = 'INVALID_PUBLIC_DISCOVERY_LEASE';
  end if;

  -- A failed try-lock is deliberate: admission must never queue behind another
  -- request while the cap is being evaluated.
  skipped_lock := not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('spottr:public-discovery:' || target_operation, 0)
  );
  if skipped_lock then
    raise exception using
      errcode = '55P03',
      message = 'PUBLIC_DISCOVERY_BUSY';
  end if;

  lease_cap := case when target_operation = 'map' then 32 else 64 end;

  -- Reclaim expired work before counting the operation's active leases.  The
  -- operation advisory lock makes the count/insertion pair race-free without
  -- waiting on row locks held by another acquisition.
  delete from private.public_discovery_leases lease
  where lease.operation = target_operation
    and lease.expires_at <= now_value;

  select count(*)::integer
  into active_leases
  from private.public_discovery_leases lease
  where lease.operation = target_operation
    and lease.expires_at > now_value;

  if active_leases >= lease_cap then
    raise exception using
      errcode = '55P03',
      message = 'PUBLIC_DISCOVERY_CONCURRENCY_LIMITED';
  end if;

  perform private.consume_public_discovery_quota(
    target_operation,
    'ip',
    target_ip_hmac,
    60,
    now_value
  );
  if account_request then
    perform private.consume_public_discovery_quota(
      target_operation,
      'account',
      target_account_hmac,
      240,
      now_value
    );
  end if;

  if lease_value is null then
    select namespace.nspname
    into strict pgcrypto_schema
    from pg_catalog.pg_extension extension
    join pg_catalog.pg_namespace namespace
      on namespace.oid = extension.extnamespace
    where extension.extname = 'pgcrypto';

    execute pg_catalog.format(
      'select pg_catalog.encode(%I.gen_random_bytes(32), ''hex'')',
      pgcrypto_schema
    ) into lease_nonce;
    -- The service-provided identity digest is already keyed HMAC material;
    -- deriving the returned nonce with it avoids a raw or unkeyed token.
    execute pg_catalog.format(
      'select pg_catalog.encode(%I.hmac($1, $2, ''sha256''), ''hex'')',
      pgcrypto_schema
    )
    into lease_value
    using lease_nonce, coalesce(target_account_hmac, target_ip_hmac);
  end if;

  insert into private.public_discovery_leases (
    lease_hmac,
    operation,
    ip_hmac,
    account_hmac,
    created_at,
    expires_at
  )
  values (
    lease_value,
    target_operation,
    target_ip_hmac,
    target_account_hmac,
    now_value,
      now_value + interval '2 minutes'
  );

  return pg_catalog.jsonb_build_object(
    'lease_hmac', lease_value,
    'operation', target_operation,
    'expires_at', now_value + interval '2 minutes'
  );
end;
$$;

revoke all on function private.acquire_public_discovery_lease(text, text, text, text)
  from public, anon, authenticated, service_role;

-- Service-only acquisition wrapper with a server-generated lease HMAC.
create or replace function public.acquire_public_discovery_lease(
  target_operation text,
  target_ip_hmac text,
  target_account_hmac text default null
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.acquire_public_discovery_lease(
    target_operation,
    target_ip_hmac,
    target_account_hmac,
    null
  );
$$;

revoke all on function public.acquire_public_discovery_lease(text, text, text)
  from public, anon, authenticated;
grant execute on function public.acquire_public_discovery_lease(text, text, text)
  to service_role;

-- Deterministic service wrapper used when the caller already owns a lease HMAC.
create or replace function public.acquire_public_discovery_lease(
  target_operation text,
  target_ip_hmac text,
  target_account_hmac text,
  target_lease_hmac text
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.acquire_public_discovery_lease(
    target_operation,
    target_ip_hmac,
    target_account_hmac,
    target_lease_hmac
  );
$$;

revoke all on function public.acquire_public_discovery_lease(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.acquire_public_discovery_lease(text, text, text, text)
  to service_role;

-- Authentication is deliberately performed only after the anonymous IP lease
-- is admitted. This service-only step attaches the verified account digest and
-- consumes its independent quota without exposing the Auth identifier.
create or replace function public.attach_public_discovery_account(
  target_lease_hmac text,
  target_account_hmac text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  lease_operation text;
  existing_account_hmac text;
  now_value timestamptz := pg_catalog.clock_timestamp();
begin
  if not private.is_public_discovery_hmac(target_lease_hmac)
    or not private.is_public_discovery_hmac(target_account_hmac)
  then
    raise exception using errcode = '22023', message = 'INVALID_PUBLIC_DISCOVERY_ACCOUNT';
  end if;

  select lease.operation, lease.account_hmac
  into lease_operation, existing_account_hmac
  from private.public_discovery_leases lease
  where lease.lease_hmac = target_lease_hmac
    and lease.expires_at > now_value
  for update;

  if not found then
    raise exception using errcode = '55000', message = 'PUBLIC_DISCOVERY_LEASE_UNAVAILABLE';
  end if;
  if existing_account_hmac is not null then
    if existing_account_hmac <> target_account_hmac then
      raise exception using errcode = '55000', message = 'PUBLIC_DISCOVERY_ACCOUNT_MISMATCH';
    end if;
    return pg_catalog.jsonb_build_object('attached', true, 'operation', lease_operation);
  end if;

  perform private.consume_public_discovery_quota(
    lease_operation,
    'account',
    target_account_hmac,
    240,
    now_value
  );

  update private.public_discovery_leases lease
  set account_hmac = target_account_hmac
  where lease.lease_hmac = target_lease_hmac;

  return pg_catalog.jsonb_build_object('attached', true, 'operation', lease_operation);
end;
$$;

revoke all on function public.attach_public_discovery_account(text, text)
  from public, anon, authenticated;
grant execute on function public.attach_public_discovery_account(text, text)
  to service_role;

create or replace function public.release_public_discovery_lease(
  target_lease_hmac text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  released_count integer;
begin
  if not private.is_public_discovery_hmac(target_lease_hmac) then
    raise exception using errcode = '22023', message = 'INVALID_PUBLIC_DISCOVERY_LEASE';
  end if;

  delete from private.public_discovery_leases lease
  where lease.lease_hmac = target_lease_hmac;
  get diagnostics released_count = row_count;

  return pg_catalog.jsonb_build_object('released', released_count = 1);
end;
$$;

revoke all on function public.release_public_discovery_lease(text)
  from public, anon, authenticated;
grant execute on function public.release_public_discovery_lease(text)
  to service_role;

create or replace function public.cleanup_public_discovery_leases()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  operation_name text;
  now_value timestamptz := pg_catalog.clock_timestamp();
  leases_deleted integer := 0;
  buckets_deleted integer := 0;
  bucket_backlog boolean := false;
  affected integer;
  skipped_operations text[] := '{}'::text[];
begin
  -- Cleanup is also nonblocking.  A request that is actively admitting work
  -- keeps its operation lock; the next cleanup pass handles that operation.
  for operation_name in
    select operation_value.operation_name_value
    from pg_catalog.unnest(array['map', 'nearby', 'search']::text[])
      as operation_value(operation_name_value)
  loop
    if pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended('spottr:public-discovery:' || operation_name, 0)
    ) then
      delete from private.public_discovery_leases lease
      where lease.operation = operation_name
        and lease.expires_at <= now_value;
      get diagnostics affected = row_count;
      leases_deleted := leases_deleted + affected;
    else
      skipped_operations := skipped_operations || operation_name;
    end if;
  end loop;

  with stale_buckets as materialized (
    select bucket.tableoid, bucket.ctid
    from private.public_discovery_rate_buckets bucket
    where bucket.bucket_started_at < now_value - interval '2 minutes'
    order by bucket.bucket_started_at, bucket.operation, bucket.subject_kind
    limit 10000
    for update skip locked
  ), deleted as (
    delete from private.public_discovery_rate_buckets bucket
    using stale_buckets stale
    where bucket.tableoid = stale.tableoid
      and bucket.ctid = stale.ctid
    returning 1
  )
  select count(*)::integer into buckets_deleted from deleted;

  select exists (
    select 1
    from private.public_discovery_rate_buckets bucket
    where bucket.bucket_started_at < now_value - interval '2 minutes'
  ) into bucket_backlog;

  return pg_catalog.jsonb_build_object(
    'leases_deleted', leases_deleted,
    'buckets_deleted', buckets_deleted,
    'more_work', bucket_backlog or pg_catalog.cardinality(skipped_operations) > 0,
    'skipped_operations', to_jsonb(skipped_operations)
  );
end;
$$;

revoke all on function public.cleanup_public_discovery_leases()
  from public, anon, authenticated;
grant execute on function public.cleanup_public_discovery_leases()
  to service_role;

revoke all on function public.map_food_places(
  double precision,
  double precision,
  double precision,
  double precision,
  integer,
  text[],
  integer
) from public, anon, authenticated;
grant execute on function public.map_food_places(
  double precision,
  double precision,
  double precision,
  double precision,
  integer,
  text[],
  integer
) to service_role;

revoke all on function public.nearby_businesses(
  double precision,
  double precision,
  integer,
  integer,
  integer
) from public, anon, authenticated;
grant execute on function public.nearby_businesses(
  double precision,
  double precision,
  integer,
  integer,
  integer
) to service_role;

revoke all on function public.search_businesses(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.search_businesses(text, integer, integer)
  to service_role;
