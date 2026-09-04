\set ON_ERROR_STOP on

create extension if not exists pgcrypto;
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
create schema if not exists auth;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table auth.users (
  id uuid primary key,
  email_confirmed_at timestamptz
);

create or replace function auth.uid()
returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
create or replace function auth.jwt()
returns jsonb language sql stable as $$
  select jsonb_build_object('aal', coalesce(nullif(current_setting('request.jwt.claim.aal', true), ''), 'aal1'));
$$;
create or replace function auth.role()
returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '');
$$;

create table public.profiles (
  user_id uuid primary key references auth.users(id),
  status text not null,
  terms_accepted_at timestamptz
);
create table public.businesses (
  id uuid primary key,
  state text not null,
  kind text not null,
  timezone text not null default 'UTC'
);
create table public.business_members (
  business_id uuid not null references public.businesses(id),
  user_id uuid not null references auth.users(id),
  role text not null,
  status text not null,
  primary key (business_id, user_id)
);
create table public.business_locations (
  id uuid primary key,
  business_id uuid not null references public.businesses(id),
  label text not null default 'Test pickup site',
  address_line text,
  city text not null default 'Test City',
  region text not null default 'CA',
  postal_code text,
  unique (id, business_id)
);
create table public.mobile_stops (
  id uuid primary key,
  business_id uuid not null references public.businesses(id),
  location_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  state text not null,
  foreign key (location_id, business_id) references public.business_locations(id, business_id)
);
create table public.menu_items (id uuid primary key);
create table public.audit_events (
  id bigint generated always as identity primary key,
  actor_id uuid,
  business_id uuid,
  event_type text not null,
  target_type text not null,
  target_id text not null,
  metadata jsonb not null,
  created_at timestamptz not null default now()
);
create table private.platform_roles (
  user_id uuid not null references auth.users(id),
  role text not null,
  active boolean not null,
  primary key (user_id, role)
);
create table private.rate_limit_buckets (
  actor_id uuid not null,
  action text not null,
  bucket_started_at timestamptz not null,
  request_count integer not null,
  primary key (actor_id, action, bucket_started_at)
);

create or replace function private.has_aal2()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
$$;
create or replace function private.require_aal2()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.has_aal2() then raise exception using errcode = '42501', message = 'AAL2_REQUIRED'; end if;
end;
$$;
create or replace function private.is_active_user(target_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select target_user_id is not null and exists (
    select 1 from public.profiles p join auth.users u on u.id = p.user_id
    where p.user_id = target_user_id and p.status = 'active'
      and p.terms_accepted_at is not null and u.email_confirmed_at is not null
  );
$$;
create or replace function private.is_business_member(target_business_id uuid, target_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_active_user(target_user_id) and exists (
    select 1 from public.business_members bm where bm.business_id = target_business_id
      and bm.user_id = target_user_id and bm.status = 'active'
  );
$$;
create or replace function private.is_platform_staff(target_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_active_user(target_user_id) and exists (
    select 1 from private.platform_roles pr where pr.user_id = target_user_id
      and pr.active and pr.role in ('moderator', 'admin')
  );
$$;
create or replace function private.is_business_publicly_eligible(target_business_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.businesses b
    where b.id = target_business_id and b.state = 'published' and b.kind <> 'home_kitchen');
$$;
create or replace function private.consume_rate_limit(
  target_actor_id uuid, target_action text, max_requests integer, window_seconds integer
) returns void language plpgsql volatile security definer set search_path = '' as $$
declare bucket_start timestamptz; accepted_count integer;
begin
  bucket_start := to_timestamp(floor(extract(epoch from clock_timestamp()) / window_seconds) * window_seconds);
  insert into private.rate_limit_buckets values (target_actor_id, target_action, bucket_start, 1)
  on conflict (actor_id, action, bucket_started_at) do update
    set request_count = private.rate_limit_buckets.request_count + 1
    where private.rate_limit_buckets.request_count < max_requests
  returning request_count into accepted_count;
  if accepted_count is null then raise exception using errcode = 'P0001', message = 'RATE_LIMITED'; end if;
end;
$$;
create or replace function private.idempotency_key_hash(candidate text)
returns text language plpgsql immutable security definer set search_path = '' as $$
begin
  if char_length(btrim(coalesce(candidate, ''))) not between 16 and 128 then
    raise exception using errcode = '22023', message = 'INVALID_IDEMPOTENCY_KEY';
  end if;
  return encode(public.digest(btrim(candidate), 'sha256'), 'hex');
end;
$$;
create or replace function private.json_request_hash(payload jsonb)
returns text language sql immutable security definer set search_path = '' as $$
  select encode(public.digest(coalesce(payload, 'null'::jsonb)::text, 'sha256'), 'hex');
$$;
create or replace function private.lock_idempotency_request(
  target_actor_id uuid, target_action text, target_key_hash text
) returns void language sql volatile security definer set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended(target_actor_id::text || ':' || target_action || ':' || target_key_hash, 0));
$$;
create or replace function private.write_audit_event(
  target_actor_id uuid, target_business_id uuid, target_event_type text,
  target_type text, target_id text, target_metadata jsonb
) returns void language sql volatile security definer set search_path = '' as $$
  insert into public.audit_events (actor_id, business_id, event_type, target_type, target_id, metadata)
  values (target_actor_id, target_business_id, target_event_type, target_type, target_id, target_metadata);
$$;

grant usage on schema public, auth to authenticated;
grant execute on function auth.uid(), auth.jwt() to authenticated;

