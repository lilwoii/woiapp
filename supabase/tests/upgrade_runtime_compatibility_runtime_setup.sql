\set ON_ERROR_STOP on

-- Simulate a stored function left behind by an older deployment. PostgreSQL 17
-- can store this body without compiling it; migration 170 must make it callable.
set check_function_bodies = off;

create or replace function private.runtime_legacy_upgrade_probe()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  origin geography(point, 4326);
begin
  origin := 'POINT(1 2)'::geography;
  return not exists (
      select 1
      from private.account_deletion_freezes freeze
      where false and freeze.user_id is null
    )
    and not exists (
      select 1
      from private.media_stage_grants grant
      where false and grant.owner_id is null
    )
    and pg_catalog.encode(public.digest('spottr', 'sha256'), 'hex') is not null
    and 'POINT(1 2)'::geometry is not null
    and origin is not null
    and 'spottr'::citext = 'SPOTTR'::citext;
end;
$$;

create or replace function private.runtime_legacy_sql_upgrade_probe(value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.encode(public.digest(value, 'sha256'), 'hex')
$$;

reset check_function_bodies;
