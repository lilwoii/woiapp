\set ON_ERROR_STOP on

begin;

do $upgrade$
begin
  perform private.runtime_legacy_upgrade_probe();
  perform private.runtime_legacy_sql_upgrade_probe('spottr');
exception
  when others then
    raise exception 'The forward migration did not make the representative legacy function callable: %', sqlerrm;
end;
$upgrade$;

do $contract$
begin
  if has_schema_privilege('anon', 'private', 'usage')
    or has_schema_privilege('authenticated', 'private', 'usage')
  then
    raise exception 'Application roles can use the private schema';
  end if;

  if has_table_privilege('anon', 'public.profiles', 'select')
    or has_table_privilege('authenticated', 'private.marketplace_consent_receipts', 'select')
    or has_table_privilege('authenticated', 'private.neighborhood_pickup_disclosures', 'select')
    or has_table_privilege('authenticated', 'public.marketplace_messages', 'select')
  then
    raise exception 'A protected identity, consent, disclosure, or chat table is directly readable';
  end if;

  if not has_table_privilege('anon', 'public.public_business_directory', 'select')
    or not has_table_privilege('anon', 'public.public_business_locations', 'select')
    or not has_table_privilege('anon', 'public.public_reviews', 'select')
  then
    raise exception 'Anonymous discovery is missing an approved public projection';
  end if;

  if has_function_privilege(
      'authenticated',
      'public.prepare_media_cleanup_batch()',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'public.claim_next_account_deletion()',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'public.cleanup_marketplace_chat_ephemera()',
      'execute'
    )
  then
    raise exception 'Authenticated users can execute a service-only maintenance RPC';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'profiles'
      and relation.relrowsecurity
  ) then
    raise exception 'Profile RLS is not enabled';
  end if;
end;
$contract$;

set local role anon;

select count(*)
from public.public_business_directory;

do $anon$
begin
  begin
    perform 1 from public.profiles limit 1;
    raise exception 'Anonymous role unexpectedly read the profile base table';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.prepare_media_cleanup_batch();
    raise exception 'Anonymous role unexpectedly executed a service-only RPC';
  exception
    when insufficient_privilege then null;
  end;
end;
$anon$;

reset role;

insert into auth.users (
  id,
  aud,
  role,
  email,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '10000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'runtime-a@spottr.invalid',
    now(),
    '{}'::jsonb,
    '{"username":"runtime_a","display_name":"Runtime A","terms_accepted":true}'::jsonb,
    now(),
    now()
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'runtime-b@spottr.invalid',
    now(),
    '{}'::jsonb,
    '{"username":"runtime_b","display_name":"Runtime B","terms_accepted":true}'::jsonb,
    now(),
    now()
  );

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',
  true
);

do $rls$
declare
  own_rows integer;
  other_rows integer;
begin
  select count(*) into own_rows
  from public.profiles
  where user_id = '10000000-0000-4000-8000-000000000001';

  select count(*) into other_rows
  from public.profiles
  where user_id = '20000000-0000-4000-8000-000000000002';

  if own_rows <> 1 or other_rows <> 0 then
    raise exception 'Profile RLS does not isolate authenticated identities';
  end if;

  begin
    perform public.update_own_profile(
      jsonb_build_object('display_name', 'AAL1 must not mutate this profile')
    );
    raise exception 'AAL1 unexpectedly passed an AAL2-gated mutation';
  exception
    when insufficient_privilege then null;
  end;
end;
$rls$;

reset role;
rollback;
