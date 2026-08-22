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
      'public.finalize_account_deletion_receipt(uuid)',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'public.finalize_next_account_deletion_receipt()',
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
  ),
  (
    '60000000-0000-4000-8000-000000000006',
    'authenticated',
    'authenticated',
    'runtime-c@spottr.invalid',
    now(),
    '{}'::jsonb,
    '{"username":"runtime_c","display_name":"Runtime C","terms_accepted":true}'::jsonb,
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

insert into private.account_deletion_requests (
  id,
  user_id,
  request_fingerprint,
  state,
  expires_at
)
values (
  '30000000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-000000000002',
  repeat('b', 64),
  'started',
  now() + interval '24 hours'
);

insert into private.account_deletion_freezes (user_id, request_id)
values (
  '20000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003'
);

select public.advance_account_deletion(
  '30000000-0000-4000-8000-000000000003',
  'processing',
  null
);
select public.advance_account_deletion(
  '30000000-0000-4000-8000-000000000003',
  'storage_deleted',
  null
);

-- Failure injection: Auth deletion succeeds, but the completion receipt is
-- deliberately left at storage_deleted until the autonomous worker recovers it.
delete from auth.users
where id = '20000000-0000-4000-8000-000000000002';

do $orphaned_receipt$
begin
  if not exists (
    select 1
    from private.account_deletion_requests request
    where request.id = '30000000-0000-4000-8000-000000000003'
      and request.user_id is null
      and request.state = 'storage_deleted'
  ) then
    raise exception 'Auth deletion did not leave the expected recoverable receipt';
  end if;
end;
$orphaned_receipt$;

set local role authenticated;

do $receipt_privilege$
begin
  begin
    perform public.finalize_account_deletion_receipt(
      '30000000-0000-4000-8000-000000000003'
    );
    raise exception 'Authenticated role unexpectedly finalized a deletion receipt';
  exception
    when insufficient_privilege then null;
  end;
end;
$receipt_privilege$;

reset role;
set local role service_role;

do $receipt_recovery$
declare
  recovered_id uuid;
begin
  select receipt.request_id
  into recovered_id
  from public.finalize_next_account_deletion_receipt() receipt;

  if recovered_id is distinct from '30000000-0000-4000-8000-000000000003'::uuid then
    raise exception 'Autonomous receipt recovery did not finalize the orphaned request';
  end if;

  if not public.finalize_account_deletion_receipt(recovered_id) then
    raise exception 'Exact receipt finalization is not idempotent';
  end if;
end;
$receipt_recovery$;

reset role;

do $receipt_completed$
begin
  if not exists (
    select 1
    from private.account_deletion_requests request
    where request.id = '30000000-0000-4000-8000-000000000003'
      and request.user_id is null
      and request.state = 'completed'
  ) then
    raise exception 'Recovered account deletion receipt was not completed';
  end if;
end;
$receipt_completed$;

insert into private.account_deletion_requests (
  id,
  user_id,
  request_fingerprint,
  state,
  expires_at
)
values
  (
    '40000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000001',
    repeat('c', 64),
    'started',
    now() + interval '24 hours'
  ),
  (
    '50000000-0000-4000-8000-000000000005',
    '60000000-0000-4000-8000-000000000006',
    repeat('d', 64),
    'started',
    now() + interval '24 hours'
  );

insert into private.account_deletion_freezes (user_id, request_id)
values
  (
    '10000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000004'
  ),
  (
    '60000000-0000-4000-8000-000000000006',
    '50000000-0000-4000-8000-000000000005'
  );

select public.advance_account_deletion(
  '40000000-0000-4000-8000-000000000004',
  'processing',
  null
);
select public.advance_account_deletion(
  '40000000-0000-4000-8000-000000000004',
  'storage_deleted',
  null
);
select public.advance_account_deletion(
  '50000000-0000-4000-8000-000000000005',
  'processing',
  null
);
select public.advance_account_deletion(
  '50000000-0000-4000-8000-000000000005',
  'storage_deleted',
  null
);

insert into private.account_deletion_storage_items (
  request_id,
  storage_path,
  state
)
values (
  '50000000-0000-4000-8000-000000000005',
  'published/runtime/pending.jpg',
  'pending'
);

delete from auth.users
where id = '60000000-0000-4000-8000-000000000006';

set local role service_role;

do $receipt_rejections$
begin
  begin
    perform public.finalize_account_deletion_receipt(
      '40000000-0000-4000-8000-000000000004'
    );
    raise exception 'Receipt finalization accepted a request with a live Auth user';
  exception
    when sqlstate '55000' then null;
  end;

  begin
    perform public.finalize_account_deletion_receipt(
      '50000000-0000-4000-8000-000000000005'
    );
    raise exception 'Receipt finalization accepted pending storage';
  exception
    when sqlstate '55000' then null;
  end;

  if exists (
    select 1
    from public.finalize_next_account_deletion_receipt()
  ) then
    raise exception 'Queue finalization accepted an unsealed orphan receipt';
  end if;
end;
$receipt_rejections$;

reset role;

rollback;
