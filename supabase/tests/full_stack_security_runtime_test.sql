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

insert into private.account_deletion_storage_items (
  request_id,
  storage_path,
  state
)
values (
  '30000000-0000-4000-8000-000000000003',
  'published/runtime/deleted.jpg',
  'pending'
);

do $storage_checkpoint$
declare
  checkpoint jsonb;
begin
  checkpoint := public.checkpoint_account_deletion_storage_batch(
    '30000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000002',
    array['published/runtime/deleted.jpg']::text[]
  );
  if checkpoint->>'storage_complete' <> 'true' then
    raise exception 'Valid account deletion storage receipt did not checkpoint';
  end if;
end;
$storage_checkpoint$;

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

do $storage_path_contract$
begin
  if not private.is_valid_media_storage_path('published/runtime/pending.jpg')
    or private.is_valid_media_storage_path('published/runtime/../escape.jpg')
    or private.is_valid_media_storage_path('quarantine/' || repeat('a', 502))
  then
    raise exception 'Media storage path validation does not enforce the bounded safe contract';
  end if;

  begin
    insert into private.account_deletion_storage_items (
      request_id,
      storage_path,
      state
    )
    values (
      '50000000-0000-4000-8000-000000000005',
      'published/runtime/../escape.jpg',
      'pending'
    );
    raise exception 'Account deletion storage accepted an unsafe path';
  exception
    when check_violation then null;
  end;
end;
$storage_path_contract$;

do $effective_storage_functions$
declare
  definitions text;
begin
  definitions := pg_catalog.pg_get_functiondef(
      'public.prepare_media_cleanup_batch()'::regprocedure
    ) || pg_catalog.pg_get_functiondef(
      'public.finalize_media_cleanup_batch(uuid,text[])'::regprocedure
    ) || pg_catalog.pg_get_functiondef(
      'public.checkpoint_account_deletion_storage_batch(uuid,uuid,text[])'::regprocedure
    );

  if position('{0,499}' in definitions) > 0
    or position('{0,510}' in definitions) > 0
    or position('private.is_valid_media_storage_path' in definitions) = 0
  then
    raise exception 'Effective media functions retain an unsupported regex bound';
  end if;
end;
$effective_storage_functions$;

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

-- Public discovery is reachable only through the service-role proxy.  The
-- proxy supplies HMAC digests; this runtime drill never inserts a raw IP.
set local role anon;

do $public_discovery_denial$
begin
  begin
    perform public.acquire_public_discovery_lease(
      'map', repeat('a', 64), null, repeat('b', 64)
    );
    raise exception 'Anonymous role unexpectedly acquired a discovery lease';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.release_public_discovery_lease(repeat('b', 64));
    raise exception 'Anonymous role unexpectedly released a discovery lease';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.attach_public_discovery_account(
      repeat('b', 64), repeat('c', 64)
    );
    raise exception 'Anonymous role unexpectedly attached a discovery account';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.cleanup_public_discovery_leases();
    raise exception 'Anonymous role unexpectedly cleaned discovery leases';
  exception
    when insufficient_privilege then null;
  end;
end;
$public_discovery_denial$;

reset role;

do $public_discovery_privileges$
begin
  if has_function_privilege(
      'anon',
      'public.map_food_places(double precision,double precision,double precision,double precision,integer,text[],integer)',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'public.map_food_places(double precision,double precision,double precision,double precision,integer,text[],integer)',
      'execute'
    )
    or has_function_privilege(
      'anon',
      'public.nearby_businesses(double precision,double precision,integer,integer,integer)',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'public.nearby_businesses(double precision,double precision,integer,integer,integer)',
      'execute'
    )
    or has_function_privilege(
      'anon',
      'public.search_businesses(text,integer,integer)',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'public.search_businesses(text,integer,integer)',
      'execute'
    )
  then
    raise exception 'Anonymous or authenticated discovery execution was not revoked';
  end if;

  if not has_function_privilege(
      'service_role',
      'public.map_food_places(double precision,double precision,double precision,double precision,integer,text[],integer)',
      'execute'
    )
    or not has_function_privilege(
      'service_role',
      'public.nearby_businesses(double precision,double precision,integer,integer,integer)',
      'execute'
    )
    or not has_function_privilege(
      'service_role',
      'public.search_businesses(text,integer,integer)',
      'execute'
    )
    or not has_function_privilege(
      'service_role',
      'public.acquire_public_discovery_lease(text,text,text)',
      'execute'
    )
    or not has_function_privilege(
      'service_role',
      'public.attach_public_discovery_account(text,text)',
      'execute'
    )
    or not has_function_privilege(
      'service_role',
      'public.release_public_discovery_lease(text)',
      'execute'
    )
    or not has_function_privilege(
      'service_role',
      'public.cleanup_public_discovery_leases()',
      'execute'
    )
  then
    raise exception 'Service role lost a discovery query grant';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_attribute attribute
    join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'private'
      and relation.relname in (
        'public_discovery_rate_buckets',
        'public_discovery_leases'
      )
      and attribute.attnum > 0
      and not attribute.attisdropped
      and pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) in ('inet', 'cidr')
  ) then
    raise exception 'Public discovery state stores a raw network address';
  end if;
end;
$public_discovery_privileges$;

set local role service_role;

do $public_discovery_service_execution$
declare
  lease_response jsonb;
  attach_response jsonb;
  generated_lease text;
  map_lease text;
  search_lease text;
begin
  lease_response := public.acquire_public_discovery_lease(
    'nearby', repeat('f', 64), null
  );
  generated_lease := lease_response->>'lease_hmac';
  if generated_lease is null or generated_lease !~ '^[0-9a-f]{64}$' then
    raise exception 'Service role did not receive a generated lease digest';
  end if;

  attach_response := public.attach_public_discovery_account(
    generated_lease, repeat('e', 64)
  );
  if not coalesce((attach_response->>'attached')::boolean, false)
    or attach_response->>'operation' <> 'nearby'
  then
    raise exception 'Service role did not attach an account quota';
  end if;

  perform 1 from public.nearby_businesses(34.0, -118.4, 500, 1, 0) limit 1;
  if not (public.release_public_discovery_lease(generated_lease)->>'released')::boolean then
    raise exception 'Service role could not release a generated lease';
  end if;

  map_lease := public.acquire_public_discovery_lease(
    'map', repeat('1', 64), null
  )->>'lease_hmac';
  if map_lease = generated_lease then
    raise exception 'Generated discovery lease digests were not unique';
  end if;
  perform 1 from public.map_food_places(
    -118.5, 33.9, -118.4, 34.0, 11, array['food_truck']::text[], 1
  ) limit 1;
  perform public.release_public_discovery_lease(map_lease);

  search_lease := public.acquire_public_discovery_lease(
    'search', repeat('2', 64), null
  )->>'lease_hmac';
  if search_lease in (generated_lease, map_lease) then
    raise exception 'Generated discovery lease digests were not unique';
  end if;
  perform 1 from public.search_businesses('Los Angeles', 1, 0) limit 1;
  perform public.release_public_discovery_lease(search_lease);
end;
$public_discovery_service_execution$;

reset role;

do $public_discovery_service_success$
declare
  response jsonb;
  acquired_lease_hmac text;
  release_response jsonb;
begin
  response := public.acquire_public_discovery_lease(
    'map', repeat('a', 64), null, repeat('b', 64)
  );
  acquired_lease_hmac := response->>'lease_hmac';
  if acquired_lease_hmac is null or acquired_lease_hmac !~ '^[0-9a-f]{64}$'
    or response->>'operation' <> 'map'
  then
    raise exception 'Service role did not receive a valid discovery lease';
  end if;

  if not exists (
    select 1
    from private.public_discovery_leases lease
    where lease.lease_hmac = acquired_lease_hmac
      and lease.ip_hmac = repeat('a', 64)
      and lease.account_hmac is null
      and lease.expires_at > clock_timestamp()
      and lease.expires_at <= lease.created_at + interval '2 minutes'
  ) then
    raise exception 'Discovery lease state was not persisted as digest-only data';
  end if;

  release_response := public.release_public_discovery_lease(acquired_lease_hmac);
  if not (release_response->>'released')::boolean
    or exists (
      select 1 from private.public_discovery_leases lease
      where lease.lease_hmac = acquired_lease_hmac
    )
  then
    raise exception 'Discovery lease release did not remove the active lease';
  end if;
end;
$public_discovery_service_success$;

-- The pre-auth IP admission persists, while a rejected account attachment must
-- leave the lease anonymous and the exhausted account bucket unchanged.
insert into private.public_discovery_rate_buckets (
  operation,
  subject_kind,
  subject_hmac,
  bucket_started_at,
  request_count
)
values (
  'search',
  'account',
  repeat('c', 64),
  to_timestamp(floor(extract(epoch from clock_timestamp()) / 60) * 60),
  240
);

do $public_discovery_quota_atomicity$
begin
  perform public.acquire_public_discovery_lease(
    'search', repeat('d', 64), null, repeat('e', 64)
  );

  begin
    perform public.attach_public_discovery_account(
      repeat('e', 64), repeat('c', 64)
    );
    raise exception 'An exhausted account quota unexpectedly admitted a request';
  exception
    when sqlstate 'P0001' then null;
  end;

  if not exists (
    select 1
    from private.public_discovery_rate_buckets bucket
    where bucket.operation = 'search'
      and bucket.subject_kind = 'ip'
      and bucket.subject_hmac = repeat('d', 64)
      and bucket.bucket_started_at = to_timestamp(floor(extract(epoch from clock_timestamp()) / 60) * 60)
      and bucket.request_count = 1
  ) then
    raise exception 'Pre-authenticated IP admission was not retained';
  end if;

  if not exists (
    select 1
    from private.public_discovery_rate_buckets bucket
    where bucket.operation = 'search'
      and bucket.subject_kind = 'account'
      and bucket.subject_hmac = repeat('c', 64)
      and bucket.request_count = 240
  ) then
    raise exception 'Authenticated account quota bucket changed after rejection';
  end if;

  if not exists (
    select 1
    from private.public_discovery_leases lease
    where lease.lease_hmac = repeat('e', 64)
      and lease.account_hmac is null
  ) then
    raise exception 'Rejected account attachment changed the anonymous lease';
  end if;

  perform public.release_public_discovery_lease(repeat('e', 64));
end;
$public_discovery_quota_atomicity$;

-- Fill the map cap with distinct digest identities, then prove that one stale
-- lease is reclaimed without waiting and that cleanup/release remain effective.
do $public_discovery_lease_cap$
declare
  index_value integer;
  ip_digest text;
  lease_digest text;
  response jsonb;
  stale_lease text := repeat('b', 62) || '01';
  cleanup_response jsonb;
  release_response jsonb;
begin
  for index_value in 1..32 loop
    ip_digest := repeat('a', 62) || lpad(to_hex(index_value), 2, '0');
    lease_digest := repeat('b', 62) || lpad(to_hex(index_value), 2, '0');
    perform public.acquire_public_discovery_lease(
      'map', ip_digest, null, lease_digest
    );
  end loop;

  begin
    perform public.acquire_public_discovery_lease(
      'map', repeat('a', 62) || '21', null, repeat('b', 62) || '21'
    );
    raise exception 'Map concurrency cap unexpectedly admitted a 33rd lease';
  exception
    when sqlstate '55P03' then null;
  end;

  update private.public_discovery_leases lease
  set created_at = clock_timestamp() - interval '20 seconds',
      expires_at = clock_timestamp() - interval '1 second'
  where lease.lease_hmac = stale_lease;

  response := public.acquire_public_discovery_lease(
    'map', repeat('a', 62) || '21', null, repeat('b', 62) || '21'
  );
  if response->>'lease_hmac' <> repeat('b', 62) || '21'
    or exists (
      select 1 from private.public_discovery_leases lease
      where lease.lease_hmac = stale_lease
    )
  then
    raise exception 'Stale map lease was not recovered during admission';
  end if;

  update private.public_discovery_leases lease
  set created_at = clock_timestamp() - interval '20 seconds',
      expires_at = clock_timestamp() - interval '1 second'
  where lease.lease_hmac = repeat('b', 62) || '02';

  cleanup_response := public.cleanup_public_discovery_leases();
  if coalesce((cleanup_response->>'leases_deleted')::integer, 0) < 1
    or coalesce((cleanup_response->>'buckets_deleted')::integer, -1) < 0
    or coalesce((cleanup_response->>'more_work')::boolean, true)
    or jsonb_typeof(cleanup_response->'skipped_operations') <> 'array'
    or exists (
      select 1 from private.public_discovery_leases lease
      where lease.lease_hmac = repeat('b', 62) || '02'
    )
  then
    raise exception 'Discovery cleanup did not reclaim a stale lease';
  end if;

  release_response := public.release_public_discovery_lease(response->>'lease_hmac');
  if not (release_response->>'released')::boolean
    or exists (
      select 1 from private.public_discovery_leases lease
      where lease.lease_hmac = response->>'lease_hmac'
    )
  then
    raise exception 'Discovery release did not remove the recovered lease';
  end if;
end;
$public_discovery_lease_cap$;

reset role;

do $professional_content$
begin
  if private.content_is_professional('f.u.c.k')
    or private.content_is_professional('f!u!c!k')
    or private.content_is_professional('sh1t')
    or private.content_is_professional('m0therfuuucker')
    or not private.content_is_professional('Bastille pastries and classical bass')
  then
    raise exception 'Professional-content enforcement is bypassable or over-broad after migrations';
  end if;
end;
$professional_content$;

do $business_claim_verification_guard$
begin
  if pg_catalog.pg_get_functiondef(
    'public.submit_business_claim(uuid,text,text)'::regprocedure
  ) not like '%CLAIM_VERIFICATION_SERVICE_REQUIRED%'
    or pg_catalog.pg_get_functiondef(
      'public.submit_business_claim(uuid,text,text)'::regprocedure
    ) like '%submit_business_claim_core%'
    or pg_catalog.has_function_privilege(
      'anon', 'public.submit_business_claim(uuid,text,text)', 'execute'
    )
    or not pg_catalog.has_function_privilege(
      'authenticated', 'public.submit_business_claim(uuid,text,text)', 'execute'
    )
  then
    raise exception 'Business claim authority guard was weakened after migrations';
  end if;
end;
$business_claim_verification_guard$;

rollback;
