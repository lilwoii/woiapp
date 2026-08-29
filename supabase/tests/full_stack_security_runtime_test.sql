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
    or has_function_privilege(
      'authenticated',
      'public.expire_shadow_order_quotes(integer)',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'public.expire_shadow_orders(integer)',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'public.reconcile_licensed_provider_lifecycle(integer)',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'public.select_sponsored_placement(text,double precision,double precision,integer,public.business_kind[],text,text,uuid)',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'public.reconcile_sponsored_reservations(integer)',
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

do $business_core_acl$
declare
  expected_core_count constant integer := 15;
  actual_core_count integer;
begin
  select count(*)
  into actual_core_count
  from pg_catalog.pg_proc function_row
  join pg_catalog.pg_namespace schema_row
    on schema_row.oid = function_row.pronamespace
  where schema_row.nspname = 'private'
    and function_row.proname = any(array[
      'invite_business_member_core',
      'respond_business_invitation_core',
      'set_business_member_role_core',
      'revoke_business_member_core',
      'revoke_business_invitation_core',
      'transfer_business_ownership_core',
      'nominate_business_logo_core',
      'schedule_mobile_stop_core',
      'cancel_mobile_stop_core',
      'submit_business_revision_core',
      'submit_business_for_review_core',
      'submit_business_update_core',
      'submit_business_response_core',
      'set_business_live_status_core',
      'set_menu_item_availability_core'
    ]::text[]);

  if actual_core_count <> expected_core_count then
    raise exception 'A serialized business core function is missing after migrations';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc function_row
    join pg_catalog.pg_namespace schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'private'
      and function_row.proname = any(array[
        'invite_business_member_core',
        'respond_business_invitation_core',
        'set_business_member_role_core',
        'revoke_business_member_core',
        'revoke_business_invitation_core',
        'transfer_business_ownership_core',
        'nominate_business_logo_core',
        'schedule_mobile_stop_core',
        'cancel_mobile_stop_core',
        'submit_business_revision_core',
        'submit_business_for_review_core',
        'submit_business_update_core',
        'submit_business_response_core',
        'set_business_live_status_core',
        'set_menu_item_availability_core'
      ]::text[])
      and pg_catalog.has_function_privilege(
        'service_role',
        function_row.oid,
        'execute'
      )
  ) then
    raise exception 'Service role can bypass a serialized business RPC wrapper';
  end if;
end;
$business_core_acl$;

set local role anon;

select count(*)
from public.public_business_directory;

do $anon$
begin
  begin
    perform private.is_business_publicly_eligible(null);
    raise exception 'Anonymous role unexpectedly invoked the private eligibility helper directly';
  exception
    when insufficient_privilege then null;
  end;

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

insert into public.businesses (
  id, kind, name, slug, state, provenance, created_by
)
values (
  '70000000-0000-4000-8000-000000000007',
  'restaurant',
  'Runtime Claim Guard',
  'runtime-claim-guard',
  'draft',
  'licensed_provider',
  '10000000-0000-4000-8000-000000000001'
);

insert into public.business_claims (
  id, business_id, claimant_id, method, state
)
values (
  '80000000-0000-4000-8000-000000000008',
  '70000000-0000-4000-8000-000000000007',
  '10000000-0000-4000-8000-000000000001',
  'listed_phone',
  'pending'
);

do $legacy_claim_approval$
begin
  begin
    update public.business_claims
    set state = 'approved'
    where id = '80000000-0000-4000-8000-000000000008';
    raise exception 'Legacy claim was approved without a verification receipt';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'CLAIM_VERIFICATION_RECEIPT_REQUIRED' then
        raise;
      end if;
  end;

  update public.business_claims
  set state = 'rejected'
  where id = '80000000-0000-4000-8000-000000000008';

  if not exists (
    select 1 from public.business_claims
    where id = '80000000-0000-4000-8000-000000000008'
      and state = 'rejected'
  ) then
    raise exception 'Unsafe legacy claim could not be rejected';
  end if;
end;
$legacy_claim_approval$;

insert into public.businesses (
  id, kind, name, slug, state, verification, provenance, created_by
)
values (
  '71000000-0000-4000-8000-000000000007',
  'restaurant',
  'Runtime Publication Guard',
  'runtime-publication-guard',
  'draft',
  'pending',
  'owner',
  '10000000-0000-4000-8000-000000000001'
);

do $publication_authority$
begin
  begin
    update public.businesses
    set state = 'published', verification = 'verified'
    where id = '71000000-0000-4000-8000-000000000007';
    raise exception 'Owner draft bypassed the review lifecycle';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'BUSINESS_REVIEW_REQUIRED' then
        raise;
      end if;
  end;

  begin
    update public.businesses
    set state = 'published'
    where id = '70000000-0000-4000-8000-000000000007';
    raise exception 'Provider draft published without an active licensed source';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'LICENSED_SOURCE_NOT_ACTIVE' then
        raise;
      end if;
  end;

  if exists (
    select 1 from public.businesses
    where id in (
      '70000000-0000-4000-8000-000000000007',
      '71000000-0000-4000-8000-000000000007'
    )
      and state = 'published'
  ) then
    raise exception 'Publication authority guard did not preserve private state';
  end if;
end;
$publication_authority$;

insert into private.provider_accounts (
  provider_slug,
  enabled,
  stale_after,
  archive_after,
  license_agreement_id,
  license_effective_on,
  license_expires_on,
  allowed_field_classes,
  accepted_signing_key_ids,
  retention_terms,
  deletion_terms,
  configuration_version
)
values (
  'runtime_provider',
  true,
  interval '1 day',
  interval '30 days',
  'runtime-license',
  current_date - 30,
  current_date + 30,
  array['profile']::text[],
  array['runtime-key']::text[],
  'Runtime retention terms',
  'Runtime deletion terms',
  'runtime-v1'
);

insert into private.provider_business_sources (
  provider_slug,
  provider_external_id,
  business_id,
  source_status,
  source_updated_at,
  first_seen_at,
  last_seen_at,
  missing_since,
  license_agreement_id,
  normalized_payload_hash
)
values (
  'runtime_provider',
  'runtime-missing-listing',
  '70000000-0000-4000-8000-000000000007',
  'missing',
  now() - interval '3 days',
  now() - interval '3 days',
  now() - interval '3 days',
  now() - interval '2 days',
  'runtime-license',
  repeat('c', 64)
);

do $provider_lifecycle$
declare
  result jsonb;
begin
  result := public.reconcile_licensed_provider_lifecycle(100);
  if result->>'sources_marked_stale' <> '1'
    or result->>'businesses_archived' <> '0'
    or result->>'more_work' <> 'false'
    or result->>'skipped' <> 'false'
  then
    raise exception 'Provider lifecycle returned an unsafe or incomplete result';
  end if;

  if not exists (
    select 1
    from private.provider_business_sources source
    where source.provider_slug = 'runtime_provider'
      and source.provider_external_id = 'runtime-missing-listing'
      and source.source_status = 'stale'
      and source.missing_since is not null
      and source.inactive_at is null
  ) then
    raise exception 'Missing provider source did not advance to stale';
  end if;

  if not exists (
    select 1
    from private.provider_ingest_audit_events event
    where event.provider_slug = 'runtime_provider'
      and event.event_type = 'sources_marked_stale'
      and event.metadata->>'count' = '1'
  ) then
    raise exception 'Provider stale transition was not audited';
  end if;

  if exists (
    select 1
    from public.businesses business
    where business.id = '70000000-0000-4000-8000-000000000007'
      and business.state = 'archived'
  ) then
    raise exception 'Provider listing was archived before its archive grace period';
  end if;
end;
$provider_lifecycle$;

-- Build one fully eligible licensed listing to exercise the sponsored-serving
-- path without weakening the publication authority trigger.
update private.provider_business_sources
set source_status = 'active',
    last_seen_at = now(),
    missing_since = null,
    inactive_at = null,
    inactive_reason = null
where provider_slug = 'runtime_provider'
  and provider_external_id = 'runtime-missing-listing';

insert into public.media_assets (
  id, owner_id, business_id, storage_path, mime_type, width, height,
  byte_size, sha256, source, license_note, quarantine_state,
  processed_storage_path, scan_completed_at, moderation
) values (
  '72000000-0000-4000-8000-000000000007',
  '10000000-0000-4000-8000-000000000001',
  '70000000-0000-4000-8000-000000000007',
  'published/runtime/provider-logo.jpg', 'image/jpeg', 512, 512,
  4096, repeat('d', 64), 'licensed_provider', 'Runtime licensed fixture',
  'clean', 'published/runtime/provider-logo-processed.jpg', now(), 'approved'
);

update public.businesses
set description = 'A complete licensed runtime listing.',
    logo_asset_id = '72000000-0000-4000-8000-000000000007'
where id = '70000000-0000-4000-8000-000000000007';

insert into public.business_private_details (
  business_id, business_email, business_phone
) values (
  '70000000-0000-4000-8000-000000000007',
  'runtime-business@spottr.invalid', '+12135550100'
);

insert into public.business_locations (
  id, business_id, label, address_line, city, region, postal_code,
  point, is_primary, is_approximate, public_address, publication_state
) values
  (
    '73000000-0000-4000-8000-000000000007',
    '70000000-0000-4000-8000-000000000007',
    'Runtime location', '100 Runtime Way', 'Los Angeles', 'CA', '90001',
    public.st_setsrid(public.st_makepoint(-118.24, 34.05), 4326)::public.geography,
    true, false, true, 'published'
  ),
  (
    '73100000-0000-4000-8000-000000000007',
    '70000000-0000-4000-8000-000000000007',
    'Private runtime pickup', null, 'Los Angeles', 'CA', '90001',
    public.st_setsrid(public.st_makepoint(-118.237, 34.043), 4326)::public.geography,
    false, false, false, 'published'
  ),
  (
    '73200000-0000-4000-8000-000000000007',
    '70000000-0000-4000-8000-000000000007',
    'Private dateline pickup', null, 'Dateline', 'AA', '00000',
    public.st_setsrid(public.st_makepoint(-179.987, 10.013), 4326)::public.geography,
    false, false, false, 'published'
  );

insert into public.weekly_hours (business_id, weekday, opens_at, closes_at, is_closed)
select
  '70000000-0000-4000-8000-000000000007',
  weekday::smallint, '00:00'::time, '23:59'::time, false
from generate_series(0, 6) weekday;

insert into public.business_payments (business_id, payment)
values ('70000000-0000-4000-8000-000000000007', 'cash');

insert into public.menu_sections (id, business_id, name, is_published)
values (
  '74000000-0000-4000-8000-000000000007',
  '70000000-0000-4000-8000-000000000007', 'Runtime menu', true
);
insert into public.menu_items (
  id, section_id, name, price_minor, currency, availability, is_published
) values (
  '75000000-0000-4000-8000-000000000007',
  '74000000-0000-4000-8000-000000000007', 'Runtime meal',
  1200, 'USD', 'available', true
);

update public.businesses
set state = 'published', verification = 'verified'
where id = '70000000-0000-4000-8000-000000000007';

-- Reports against already-approved reviews must be visible to staff and must
-- have an audited, optimistic-locking keep/remove path.
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}',
  true
);
insert into public.reviews (
  id, business_id, author_id, rating, body, moderation
) values (
  '75100000-0000-4000-8000-000000000007',
  '70000000-0000-4000-8000-000000000007',
  '20000000-0000-4000-8000-000000000002',
  4,
  'Approved runtime review that can be reported.',
  'approved'
);

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"60000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal1"}',
  true
);
select public.submit_content_report(
  'review',
  '75100000-0000-4000-8000-000000000007',
  'spam',
  'Runtime report for the protected review queue.'
);
reset role;

insert into private.platform_roles (user_id, role, active)
values ('10000000-0000-4000-8000-000000000001', 'moderator', true);

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',
  true
);

do $reported_review_moderation$
declare
  queued record;
  decision_updated_at timestamptz;
begin
  select * into queued
  from public.list_pending_content_moderation(100, 0)
  where target_type = 'review'
    and target_id = '75100000-0000-4000-8000-000000000007';

  if queued.target_id is null
    or queued.context->>'reported' <> 'true'
    or (queued.context->>'report_count')::integer <> 1
  then
    raise exception 'Reported approved review was absent from the moderation queue';
  end if;

  decision_updated_at := public.decide_reported_review(
    queued.target_id,
    'rejected',
    'Runtime removal after reviewing the report.',
    queued.updated_at
  );

  if decision_updated_at is null
    or exists (
      select 1 from public.public_reviews review
      where review.review_id = queued.target_id
    )
  then
    raise exception 'Reported review removal remained in the public projection';
  end if;
end;
$reported_review_moderation$;

reset role;

do $reported_review_report_state$
begin
  if not exists (
      select 1 from public.reviews review
      where review.id = '75100000-0000-4000-8000-000000000007'
        and review.moderation = 'removed'
    )
    or not exists (
      select 1 from public.content_reports report
      where report.target_type = 'review'
        and report.target_id = '75100000-0000-4000-8000-000000000007'
        and report.state = 'resolved'
    )
  then
    raise exception 'Reported review removal was not atomic across review and report state';
  end if;
end;
$reported_review_report_state$;

-- Mobile vendors can submit several candidate pins and draft stops, but only
-- the exact staff-reviewed selection may cross into public discovery.
select pg_catalog.set_config('request.jwt.claims', '{}'::text, true);

insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values (
  'a1000000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'runtime-mobile-admin@spottr.invalid', now(),
  '{}'::jsonb,
  '{"username":"runtime_mobile_admin","display_name":"Runtime Mobile Admin","terms_accepted":true}'::jsonb,
  now(), now()
);

insert into private.platform_roles (user_id, role, active)
values ('a1000000-0000-4000-8000-000000000001', 'admin', true);

insert into public.businesses (
  id, kind, name, slug, description, state, verification, provenance, created_by
) values (
  '79000000-0000-4000-8000-000000000009',
  'food_truck',
  'Runtime Route Truck',
  'runtime-route-truck',
  'A complete mobile vendor submission for runtime approval tests.',
  'draft',
  'pending',
  'owner',
  '10000000-0000-4000-8000-000000000001'
);

insert into public.business_members (
  business_id, user_id, role, status, accepted_at
) values (
  '79000000-0000-4000-8000-000000000009',
  '10000000-0000-4000-8000-000000000001',
  'owner', 'active', now()
);

select public.create_media_stage_grant(
  '10000000-0000-4000-8000-000000000001',
  'quarantine/10000000-0000-4000-8000-000000000001/79100000-0000-4000-8000-000000000009.jpg',
  'business_logo',
  '79000000-0000-4000-8000-000000000009',
  null,
  'image/jpeg',
  4096
);

insert into public.media_assets (
  id, owner_id, business_id, storage_path, mime_type, width, height,
  byte_size, sha256, source, quarantine_state, processed_storage_path,
  scan_completed_at, moderation
) values (
  '79100000-0000-4000-8000-000000000009',
  '10000000-0000-4000-8000-000000000001',
  '79000000-0000-4000-8000-000000000009',
  'quarantine/10000000-0000-4000-8000-000000000001/79100000-0000-4000-8000-000000000009.jpg',
  'image/jpeg', 512, 512,
  4096, repeat('e', 64), 'owner_upload', 'clean',
  'published/runtime/mobile-review-logo-processed.jpg', now(), 'approved'
);

update public.businesses
set logo_asset_id = '79100000-0000-4000-8000-000000000009'
where id = '79000000-0000-4000-8000-000000000009';

insert into public.business_private_details (
  business_id, business_email
) values (
  '79000000-0000-4000-8000-000000000009',
  'runtime-route-truck@spottr.invalid'
);

insert into public.business_locations (
  id, business_id, label, address_line, city, region, postal_code,
  point, is_primary, is_approximate, public_address, publication_state
) values
  (
    '79200000-0000-4000-8000-000000000009',
    '79000000-0000-4000-8000-000000000009',
    'Runtime home route', '900 Runtime Avenue', 'Los Angeles', 'CA', '90009',
    public.st_setsrid(public.st_makepoint(-118.250, 34.050), 4326)::public.geography,
    true, false, true, 'private'
  ),
  (
    '79300000-0000-4000-8000-000000000009',
    '79000000-0000-4000-8000-000000000009',
    'Runtime market stop', '910 Runtime Avenue', 'Los Angeles', 'CA', '90009',
    public.st_setsrid(public.st_makepoint(-118.245, 34.055), 4326)::public.geography,
    false, false, true, 'private'
  ),
  (
    '79400000-0000-4000-8000-000000000009',
    '79000000-0000-4000-8000-000000000009',
    'Runtime unapproved stop', '920 Runtime Avenue', 'Los Angeles', 'CA', '90009',
    public.st_setsrid(public.st_makepoint(-118.240, 34.060), 4326)::public.geography,
    false, false, true, 'private'
  );

insert into public.weekly_hours (business_id, weekday, opens_at, closes_at, is_closed)
select
  '79000000-0000-4000-8000-000000000009',
  weekday::smallint, '09:00'::time, '18:00'::time, false
from generate_series(0, 6) weekday;

insert into public.business_payments (business_id, payment)
values ('79000000-0000-4000-8000-000000000009', 'cash');

insert into public.menu_sections (id, business_id, name, is_published)
values (
  '79700000-0000-4000-8000-000000000009',
  '79000000-0000-4000-8000-000000000009',
  'Runtime truck menu', true
);

insert into public.menu_items (
  id, section_id, name, price_minor, currency, availability, is_published
) values (
  '79800000-0000-4000-8000-000000000009',
  '79700000-0000-4000-8000-000000000009',
  'Runtime route plate', 1400, 'USD', 'available', true
);

insert into public.mobile_stops (
  id, business_id, location_id, starts_at, ends_at, state
) values
  (
    '79500000-0000-4000-8000-000000000009',
    '79000000-0000-4000-8000-000000000009',
    '79300000-0000-4000-8000-000000000009',
    now() + interval '1 day', now() + interval '1 day 2 hours', 'draft'
  ),
  (
    '79600000-0000-4000-8000-000000000009',
    '79000000-0000-4000-8000-000000000009',
    '79400000-0000-4000-8000-000000000009',
    now() + interval '1 day 1 hour', now() + interval '1 day 3 hours', 'draft'
  ),
  (
    '79900000-0000-4000-8000-000000000009',
    '79000000-0000-4000-8000-000000000009',
    '79200000-0000-4000-8000-000000000009',
    now() - interval '2 hours', now() + interval '1 hour', 'draft'
  );

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',
  true
);

do $mobile_owner_publication_guard$
begin
  begin
    perform public.set_business_location_publication(
      '79300000-0000-4000-8000-000000000009',
      'published'
    );
    raise exception 'Mobile owner published an unreviewed secondary pin';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'MOBILE_SUBMISSION_SELECTION_REQUIRED' then raise; end if;
  end;
end;
$mobile_owner_publication_guard$;

reset role;
select pg_catalog.set_config('request.jwt.claims', '{}'::text, true);
update public.businesses
set state = 'pending'
where id = '79000000-0000-4000-8000-000000000009';

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',
  true
);

do $mobile_review_aal_guard$
begin
  begin
    perform public.get_pending_business_submission(
      '79000000-0000-4000-8000-000000000009'
    );
    raise exception 'AAL1 administrator read an exact mobile submission';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'AAL2_REQUIRED' then raise; end if;
  end;
end;
$mobile_review_aal_guard$;

select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',
  true
);

do $mobile_submission_review_guards$
declare
  submission jsonb;
begin
  submission := public.get_pending_business_submission(
    '79000000-0000-4000-8000-000000000009'
  );
  if jsonb_array_length(submission->'locations') <> 3
    or jsonb_array_length(submission->'draft_stops') <> 3
    or submission->'locations'->0->>'id' <> '79200000-0000-4000-8000-000000000009'
    or submission ? 'business_email'
    or submission ? 'business_phone'
  then
    raise exception 'Pending mobile submission detail was incomplete or leaked private contact data';
  end if;

  begin
    perform public.set_business_publication(
      '79000000-0000-4000-8000-000000000009',
      'published', 'verified', 'Legacy mobile approval must be rejected.'
    );
    raise exception 'Legacy publication bypassed explicit mobile selection';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'MOBILE_SUBMISSION_SELECTION_REQUIRED' then raise; end if;
  end;

  begin
    perform public.review_business_submission(
      '79000000-0000-4000-8000-000000000009',
      array['79200000-0000-4000-8000-000000000009']::uuid[],
      array['79900000-0000-4000-8000-000000000009']::uuid[],
      'Reject an expired initial stop window.'
    );
    raise exception 'Mobile review accepted a stale initial stop';
  exception
    when sqlstate '22023' then
      if sqlerrm <> 'Approved mobile stop selection is invalid' then raise; end if;
  end;

  begin
    perform public.review_business_submission(
      '79000000-0000-4000-8000-000000000009',
      array['79300000-0000-4000-8000-000000000009']::uuid[],
      '{}'::uuid[],
      'Reject selection without the primary pin.'
    );
    raise exception 'Mobile review accepted a selection without the primary pin';
  exception
    when sqlstate '22023' then
      if sqlerrm <> 'Primary location approval is required' then raise; end if;
  end;

  begin
    perform public.review_business_submission(
      '79000000-0000-4000-8000-000000000009',
      array[
        '79200000-0000-4000-8000-000000000009',
        '79300000-0000-4000-8000-000000000009',
        '79400000-0000-4000-8000-000000000009'
      ]::uuid[],
      array[
        '79500000-0000-4000-8000-000000000009',
        '79600000-0000-4000-8000-000000000009'
      ]::uuid[],
      'Reject overlapping initial mobile stops.'
    );
    raise exception 'Mobile review accepted overlapping initial stops';
  exception
    when sqlstate '23P01' then
      if sqlerrm <> 'MOBILE_STOP_TIME_OVERLAP' then raise; end if;
  end;

  begin
    perform public.review_business_submission(
      '79000000-0000-4000-8000-000000000009',
      array[
        '79200000-0000-4000-8000-000000000009',
        '79300000-0000-4000-8000-000000000009'
      ]::uuid[],
      array['79500000-0000-4000-8000-000000000009']::uuid[],
      'Require a complete verified contact before approval.'
    );
    raise exception 'Mobile review published a submission without complete contact data';
  exception
    when sqlstate '23514' then
      if sqlerrm <> 'SUBMISSION_MISSING_CONTACT' then raise; end if;
  end;

  if exists (
      select 1 from public.businesses business
      where business.id = '79000000-0000-4000-8000-000000000009'
        and business.state <> 'pending'
    )
    or exists (
      select 1 from public.business_locations location
      where location.business_id = '79000000-0000-4000-8000-000000000009'
        and location.publication_state <> 'private'
    )
    or exists (
      select 1 from public.mobile_stops stop
      where stop.business_id = '79000000-0000-4000-8000-000000000009'
        and (stop.state <> 'draft' or stop.confirmed_at is not null)
    )
  then
    raise exception 'Rejected mobile review did not roll back atomically';
  end if;
end;
$mobile_submission_review_guards$;

reset role;
select pg_catalog.set_config('request.jwt.claims', '{}'::text, true);
update public.business_private_details
set business_phone = '+12135550199'
where business_id = '79000000-0000-4000-8000-000000000009';

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',
  true
);
select public.review_business_submission(
  '79000000-0000-4000-8000-000000000009',
  array[
    '79200000-0000-4000-8000-000000000009',
    '79300000-0000-4000-8000-000000000009'
  ]::uuid[],
  array['79500000-0000-4000-8000-000000000009']::uuid[],
  'Approved the primary pin, reviewed market location, and verified the initial schedule.'
);
reset role;
select pg_catalog.set_config('request.jwt.claims', '{}'::text, true);

do $mobile_submission_review_state$
begin
  if not exists (
      select 1 from public.businesses business
      where business.id = '79000000-0000-4000-8000-000000000009'
        and business.state = 'published'
        and business.verification = 'verified'
    )
    or (
      select count(*) from public.business_locations location
      where location.business_id = '79000000-0000-4000-8000-000000000009'
        and location.publication_state = 'published'
    ) <> 2
    or not exists (
      select 1 from public.business_locations location
      where location.id = '79400000-0000-4000-8000-000000000009'
        and location.publication_state = 'private'
    )
    or not exists (
      select 1 from public.mobile_stops stop
      where stop.id = '79500000-0000-4000-8000-000000000009'
        and stop.state = 'scheduled'
        and stop.confirmed_at is not null
    )
    or not exists (
      select 1 from public.mobile_stops stop
      where stop.id = '79600000-0000-4000-8000-000000000009'
        and stop.state = 'draft'
        and stop.confirmed_at is null
    )
    or not exists (
      select 1 from public.mobile_stops stop
      where stop.id = '79900000-0000-4000-8000-000000000009'
        and stop.state = 'draft'
        and stop.confirmed_at is null
    )
    or not exists (
      select 1 from public.audit_events event
      where event.actor_id = 'a1000000-0000-4000-8000-000000000001'
        and event.business_id = '79000000-0000-4000-8000-000000000009'
        and event.event_type = 'business.submission_approved'
    )
  then
    raise exception 'Approved mobile submission did not preserve its exact reviewed state';
  end if;
end;
$mobile_submission_review_state$;

set local role anon;
do $mobile_submission_public_projection$
begin
  if not exists (
      select 1 from public.public_business_directory directory
      where directory.business_id = '79000000-0000-4000-8000-000000000009'
    )
    or (
      select count(*) from public.public_business_locations location
      where location.business_id = '79000000-0000-4000-8000-000000000009'
    ) <> 2
    or exists (
      select 1 from public.public_business_locations location
      where location.location_id = '79400000-0000-4000-8000-000000000009'
    )
    or (
      select count(*) from public.mobile_stops stop
      where stop.business_id = '79000000-0000-4000-8000-000000000009'
    ) <> 1
    or not exists (
      select 1 from public.mobile_stops stop
      where stop.id = '79500000-0000-4000-8000-000000000009'
    )
  then
    raise exception 'Anonymous discovery did not match the reviewed mobile selection';
  end if;
end;
$mobile_submission_public_projection$;
reset role;

-- The reviewed logo fixture is complete at this point. Retire only its
-- serialized upload capability so it cannot leak into the independent
-- account-deletion seal scenarios later in this rollback-only test.
update private.media_stage_grants
set
  state = 'cancelled',
  registered_asset_id = null,
  updated_at = now()
where storage_path =
  'quarantine/10000000-0000-4000-8000-000000000001/79100000-0000-4000-8000-000000000009.jpg';

insert into public.pricing_versions (
  id, version, region_code, currency, click_floor_minor, click_ceiling_minor,
  state, effective_at, approval_reference, approved_at
) values (
  '76000000-0000-4000-8000-000000000007', 'runtime-v1', 'US', 'USD',
  25, 500, 'approved', now() - interval '1 day',
  'runtime pricing approval', now() - interval '1 day'
);

insert into public.business_members (
  business_id, user_id, role, status, accepted_at
) values
  (
    '70000000-0000-4000-8000-000000000007',
    '10000000-0000-4000-8000-000000000001',
    'owner', 'active', now()
  ),
  (
    '70000000-0000-4000-8000-000000000007',
    '20000000-0000-4000-8000-000000000002',
    'staff', 'active', now()
  );

-- Exercise merchant authoring as an AAL2 owner. This stays inside the
-- rollback-only runtime fixture so it cannot create production data.
set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',
  true
);

do $sponsored_authoring$
declare
  quote jsonb;
  draft_public_id uuid;
  replay_public_id uuid;
  expected_updated_at timestamptz;
  submit_result text;
begin
  quote := public.get_sponsored_campaign_quote(
    '70000000-0000-4000-8000-000000000007'
  );
  if quote is null
    or quote->>'currency' <> 'USD'
    or quote->>'disclosure' <> 'Sponsored ad'
    or quote->>'term_days' <> '30'
  then
    raise exception 'Sponsored campaign quote was not server-authoritative';
  end if;

  draft_public_id := public.create_sponsored_campaign_draft(
    '70000000-0000-4000-8000-000000000007',
    15000, 1609, now() + interval '1 hour',
    'spottr:sponsor:runtime-authoring-0001'
  );
  replay_public_id := public.create_sponsored_campaign_draft(
    '70000000-0000-4000-8000-000000000007',
    15000, 1609, now() + interval '1 hour',
    'spottr:sponsor:runtime-authoring-0001'
  );
  if replay_public_id <> draft_public_id then
    raise exception 'Sponsored draft replay was not idempotent';
  end if;

  begin
    perform public.create_sponsored_campaign_draft(
      '70000000-0000-4000-8000-000000000007',
      15000, 3218, now() + interval '1 hour',
      'spottr:sponsor:runtime-authoring-0001'
    );
    raise exception 'Sponsored idempotency key was accepted for a different payload';
  exception
    when sqlstate '22023' then
      if sqlerrm <> 'IDEMPOTENCY_KEY_REUSED' then raise; end if;
  end;

  begin
    perform public.create_sponsored_campaign_draft(
      '70000000-0000-4000-8000-000000000007',
      15000, 1609, null,
      'spottr:sponsor:runtime-authoring-null'
    );
    raise exception 'Sponsored authoring accepted a NULL campaign start';
  exception
    when sqlstate '22023' then null;
  end;

  select campaign.updated_at into expected_updated_at
  from public.ad_campaigns campaign
  where campaign.public_id = draft_public_id;
  submit_result := public.submit_sponsored_campaign(
    draft_public_id, expected_updated_at
  );
  if submit_result <> 'submitted' then
    raise exception 'Sponsored campaign did not submit from a valid draft';
  end if;
  perform pg_catalog.set_config(
    'spottr.runtime.sponsor_campaign_id', draft_public_id::text, true
  );
  select campaign.updated_at into expected_updated_at
  from public.ad_campaigns campaign
  where campaign.public_id = draft_public_id;
  perform pg_catalog.set_config(
    'spottr.runtime.sponsor_campaign_updated_at', expected_updated_at::text, true
  );
end;
$sponsored_authoring$;

reset role;

-- A staff member may not read campaign financials or terminate a campaign.
set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}',
  true
);

do $sponsored_staff_boundary$
declare
  visible_campaigns integer;
begin
  select count(*) into visible_campaigns from public.ad_campaigns;
  if visible_campaigns <> 0 then
    raise exception 'Staff unexpectedly read sponsored campaign financials';
  end if;
  begin
    perform public.end_sponsored_campaign(
      current_setting('spottr.runtime.sponsor_campaign_id')::uuid,
      current_setting('spottr.runtime.sponsor_campaign_updated_at')::timestamptz
    );
    raise exception 'Staff unexpectedly terminated a sponsored campaign';
  exception
    when sqlstate '42501' then null;
  end;
end;
$sponsored_staff_boundary$;

reset role;

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',
  true
);

do $sponsored_owner_end$
declare
  end_result text;
begin
  end_result := public.end_sponsored_campaign(
    current_setting('spottr.runtime.sponsor_campaign_id')::uuid,
    current_setting('spottr.runtime.sponsor_campaign_updated_at')::timestamptz
  );
  if end_result <> 'ended' then
    raise exception 'Owner could not end a submitted sponsored campaign';
  end if;
end;
$sponsored_owner_end$;

reset role;

insert into public.ad_campaigns (
  id, business_id, billing_model, state, currency, bid_cap_minor,
  daily_budget_minor, lifetime_budget_minor, pricing_version_id,
  starts_at, ends_at, approved_at, approval_reference
) values (
  '77000000-0000-4000-8000-000000000007',
  '70000000-0000-4000-8000-000000000007', 'shadow', 'active', 'USD',
  100, 1000, 10000, '76000000-0000-4000-8000-000000000007',
  now() - interval '1 hour', now() + interval '1 day', now() - interval '1 hour',
  'runtime campaign approval'
);

insert into public.ad_targets (
  campaign_id, business_kinds, center, radius_meters
) values (
  '77000000-0000-4000-8000-000000000007',
  array['restaurant']::public.business_kind[],
  public.st_setsrid(public.st_makepoint(-118.24, 34.05), 4326)::public.geography,
  10000
);

insert into public.ad_creatives (
  id, campaign_id, business_id, moderation, moderation_version
) values (
  '78000000-0000-4000-8000-000000000007',
  '77000000-0000-4000-8000-000000000007',
  '70000000-0000-4000-8000-000000000007', 'approved', 'runtime-v1'
);

update private.ad_runtime_config
set enabled = true,
    shadow_only = true,
    approval_reference = 'runtime shadow-only approval',
    updated_at = now()
where singleton;

create temporary table runtime_sponsored_result (payload jsonb not null);
grant select, insert on runtime_sponsored_result to service_role, anon;

set local role service_role;
insert into runtime_sponsored_result (payload)
select public.select_sponsored_placement(
  'discover', 34.05, -118.24, 16093,
  array['food_truck', 'restaurant', 'pop_up', 'cafe_bakery']::public.business_kind[],
  repeat('a', 64), repeat('b', 64), null
);
reset role;

do $sponsored_selection$
declare result jsonb;
begin
  select payload into result from runtime_sponsored_result;
  if result->>'business_id' <> '70000000-0000-4000-8000-000000000007'
    or result->>'disclosure' <> 'Sponsored ad'
    or result->>'placement_token' !~ '^[0-9a-f-]{36}\.[0-9]{10}\.[0-9a-f]{64}$'
  then
    raise exception 'Sponsored selector returned an invalid public projection';
  end if;
end;
$sponsored_selection$;

set local role anon;
do $sponsored_public_boundary$
declare
  token text;
  first_receipt jsonb;
  duplicate_receipt jsonb;
begin
  select payload->>'placement_token' into token from runtime_sponsored_result;
  first_receipt := public.record_sponsored_interaction(
    token, 'open', 'runtime:sponsor:open:0001'
  );
  duplicate_receipt := public.record_sponsored_interaction(
    token, 'open', 'runtime:sponsor:open:0002'
  );
  if first_receipt->>'accepted' <> 'true'
    or first_receipt->>'billed' <> 'false'
    or first_receipt->>'duplicate' <> 'false'
    or duplicate_receipt->>'duplicate' <> 'true'
    or duplicate_receipt->>'billed' <> 'false'
  then
    raise exception 'Shadow sponsored interaction was not safely idempotent';
  end if;

  begin
    perform public.select_sponsored_placement(
      'discover', 34.05, -118.24, 16093,
      array['restaurant']::public.business_kind[],
      repeat('a', 64), repeat('b', 64), null
    );
    raise exception 'Anonymous role unexpectedly selected a sponsored placement';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform 1 from private.billing_ledger limit 1;
    raise exception 'Anonymous role unexpectedly read the billing ledger';
  exception
    when insufficient_privilege then null;
  end;
end;
$sponsored_public_boundary$;
reset role;

do $sponsored_financial_state$
begin
  if exists (select 1 from private.billing_ledger) then
    raise exception 'Shadow-only sponsored interaction created a financial debit';
  end if;
  if not exists (
    select 1 from private.ad_budget_reservations
    where campaign_id = '77000000-0000-4000-8000-000000000007'
      and state = 'released'
  ) then
    raise exception 'Shadow sponsored interaction did not release its reservation';
  end if;
end;
$sponsored_financial_state$;

set local role service_role;
do $sponsored_reconcile$
declare result jsonb;
begin
  result := public.reconcile_sponsored_reservations(100);
  if result->>'released' <> '0'
    or result->>'more_work' <> 'false'
    or result->>'skipped' <> 'false'
  then
    raise exception 'Sponsored reservation reconciliation returned an unsafe result';
  end if;
end;
$sponsored_reconcile$;
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

  if exists (
    select 1 from public.map_food_places(
      -118.238, 34.042, -118.236, 34.044, 18, null, 100
    ) place
    where place.location_id = '73100000-0000-4000-8000-000000000007'
  ) then
    raise exception 'Tiny viewport revealed a private raw location';
  end if;
  if not exists (
    select 1 from public.map_food_places(
      -118.251, 34.049, -118.249, 34.051, 18, null, 100
    ) place
    where place.location_id = '73100000-0000-4000-8000-000000000007'
      and abs(place.longitude - (-118.25)) < 0.0000001
      and abs(place.latitude - 34.05) < 0.0000001
  ) then
    raise exception 'Private location was not filtered and returned at its redacted point';
  end if;
  if exists (
    select 1 from public.map_food_places(
      -179.988, 10.012, -179.986, 10.014, 18, null, 100
    ) place
    where place.location_id = '73200000-0000-4000-8000-000000000007'
  ) then
    raise exception 'Tiny dateline viewport revealed a private raw location';
  end if;
  if not exists (
    select 1 from public.map_food_places(
      179.999, 9.999, -179.999, 10.001, 18, null, 100
    ) place
    where place.location_id = '73200000-0000-4000-8000-000000000007'
      and abs(abs(place.longitude) - 180) < 0.0000001
      and abs(place.latitude - 10) < 0.0000001
  ) then
    raise exception 'Antimeridian viewport did not use the redacted coordinate';
  end if;
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
    or not exists (
      select 1
      from pg_catalog.pg_trigger trigger_row
      join pg_catalog.pg_class table_row on table_row.oid = trigger_row.tgrelid
      join pg_catalog.pg_namespace schema_row on schema_row.oid = table_row.relnamespace
      where schema_row.nspname = 'public'
        and table_row.relname = 'business_claims'
        and trigger_row.tgname = 'require_business_claim_verification_receipt'
        and not trigger_row.tgisinternal
    )
    or pg_catalog.pg_get_functiondef(
      'private.require_business_claim_verification_receipt()'::regprocedure
    ) not like '%CLAIM_VERIFICATION_RECEIPT_REQUIRED%'
  then
    raise exception 'Business claim authority guard was weakened after migrations';
  end if;
end;
$business_claim_verification_guard$;

-- Push remains disabled in production, but the database foundation must prove
-- consent/preference races, lease bounds, and identity consistency before a
-- provider adapter can be considered.
insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
)
values
  (
    '90000000-0000-4000-8000-000000000009',
    'authenticated', 'authenticated', 'runtime-push@spottr.invalid', now(),
    '{}'::jsonb,
    '{"username":"runtime_push","display_name":"Runtime Push","terms_accepted":true}'::jsonb,
    now(), now()
  ),
  (
    '92000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'runtime-push-b@spottr.invalid', now(),
    '{}'::jsonb,
    '{"username":"runtime_push_b","display_name":"Runtime Push B","terms_accepted":true}'::jsonb,
    now(), now()
  );

insert into auth.sessions (id, user_id, created_at, updated_at)
values
  (
    '91000000-0000-4000-8000-000000000001',
    '90000000-0000-4000-8000-000000000009',
    now(), now()
  ),
  (
    '91000000-0000-4000-8000-000000000002',
    '90000000-0000-4000-8000-000000000009',
    now(), now()
  ),
  (
    '91000000-0000-4000-8000-000000000003',
    '92000000-0000-4000-8000-000000000002',
    now(), now()
  );

do $push_registration_session_guard$
begin
  begin
    perform private.register_notification_device(
      '90000000-0000-4000-8000-000000000009',
      '91000000-0000-4000-8000-000000000099',
      '81000000-0000-4000-8000-000000000099',
      'ios', 'expo', '82000000-0000-4000-8000-000000000002',
      repeat('e', 64), repeat('E', 48), repeat('F', 16), 1,
      'America/Los_Angeles', '0.2.0', 'granted'
    );
    raise exception 'Registration accepted a missing Auth session';
  exception when invalid_parameter_value then null;
  end;

  update auth.sessions set not_after = now() - interval '1 second'
  where id = '91000000-0000-4000-8000-000000000002';
  begin
    perform private.register_notification_device(
      '90000000-0000-4000-8000-000000000009',
      '91000000-0000-4000-8000-000000000002',
      '81000000-0000-4000-8000-000000000098',
      'ios', 'expo', '82000000-0000-4000-8000-000000000002',
      repeat('1', 64), repeat('G', 48), repeat('H', 16), 1,
      'America/Los_Angeles', '0.2.0', 'granted'
    );
    raise exception 'Registration accepted an expired Auth session';
  exception when invalid_parameter_value then null;
  end;
  update auth.sessions set not_after = null
  where id = '91000000-0000-4000-8000-000000000002';
end;
$push_registration_session_guard$;

insert into public.follows (user_id, business_id)
values (
  '90000000-0000-4000-8000-000000000009',
  '70000000-0000-4000-8000-000000000007'
)
on conflict do nothing;

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"90000000-0000-4000-8000-000000000009","role":"authenticated","aal":"aal2","session_id":"91000000-0000-4000-8000-000000000001"}',
  true
);

select public.update_follow_notification_preferences(
  array['70000000-0000-4000-8000-000000000007'::uuid],
  'owner_bundle', true, 'America/Los_Angeles', '22:00'::time, '07:00'::time,
  'spottr:notification-preference:runtime-enable-0001'
);

select public.update_follow_notification_preferences(
  array['70000000-0000-4000-8000-000000000007'::uuid],
  'live_nearby', false, null, null, null,
  'spottr:notification-preference:runtime-live-0002'
);

do $push_quiet_hours_preserved$
begin
  if not exists (
    select 1 from public.notification_preferences preference
    where preference.user_id = '90000000-0000-4000-8000-000000000009'
      and preference.business_id = '70000000-0000-4000-8000-000000000007'
      and preference.owner_update and preference.location_change and preference.menu_return
      and preference.quiet_hours_start = '22:00'::time
      and preference.quiet_hours_end = '07:00'::time
      and preference.timezone = 'America/Los_Angeles'
  ) then raise exception 'Notification toggle erased quiet hours or bundle state'; end if;
end;
$push_quiet_hours_preserved$;

reset role;

-- The preservation assertion above intentionally uses real quiet hours. Clear
-- them for the worker lease/handoff fixtures so this runtime test is stable at
-- every wall-clock hour while production quiet-hour deferral remains enforced.
update public.notification_preferences
set quiet_hours_start = null,
    quiet_hours_end = null,
    timezone = null,
    updated_at = now()
where user_id = '90000000-0000-4000-8000-000000000009'
  and business_id = '70000000-0000-4000-8000-000000000007';

select public.register_notification_device_server(
  '90000000-0000-4000-8000-000000000009',
  '91000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000001',
  'ios',
  '82000000-0000-4000-8000-000000000002',
  repeat('a', 64),
  repeat('A', 48),
  repeat('B', 16),
  1,
  'America/Los_Angeles',
  '0.2.0',
  'granted',
  'product-updates-v1',
  'native_settings'
);

update private.notification_runtime_settings
set enqueue_enabled = true, delivery_enabled = true, updated_at = now()
where singleton;

do $push_runtime$
declare
  first_event_id bigint;
  second_event_id bigint;
  claimed_outbox record;
  delivery_id uuid;
  original_device_id uuid;
  rebound_device_id uuid;
  reclaimed_device_id uuid;
  unmatched_device_id uuid;
  unfollow_event_id bigint;
  unfollow_outbox_claim record;
  unfollow_delivery_id uuid;
  unfollow_handoff_event_id bigint;
  unfollow_handoff_outbox_claim record;
  unfollow_handoff_delivery_claim record;
  ineligible_claim_event_id bigint;
  ineligible_claim_outbox record;
  ineligible_handoff_event_id bigint;
  ineligible_handoff_outbox record;
  ineligible_handoff_delivery record;
  affected integer;
begin
  -- Losing public eligibility after fanout must block both lease claim and the
  -- final provider handoff. These rows are cleaned before the shared fixtures
  -- continue so later delivery-count assertions remain isolated.
  insert into public.business_public_events (
    business_id, event_type, payload, expires_at
  ) values (
    '70000000-0000-4000-8000-000000000007',
    'owner_update',
    jsonb_build_object('update_id', '83100000-0000-4000-8000-000000000003'),
    now() + interval '1 hour'
  ) returning id into ineligible_claim_event_id;

  select * into ineligible_claim_outbox
  from private.claim_notification_outbox(
    '84100000-0000-4000-8000-000000000004', 10, 60
  ) where source_event_id = ineligible_claim_event_id;
  if ineligible_claim_outbox.outbox_id is null then
    raise exception 'Ineligible-claim fixture outbox was not claimed';
  end if;
  affected := private.expand_notification_outbox(
    ineligible_claim_outbox.outbox_id,
    ineligible_claim_outbox.lease_token,
    20
  );
  if affected <> 1 then
    raise exception 'Ineligible-claim fixture did not fan out exactly one delivery';
  end if;

  update public.businesses set state = 'suspended'
  where id = '70000000-0000-4000-8000-000000000007';
  if exists (
    select 1 from private.claim_notification_deliveries(
      '85100000-0000-4000-8000-000000000005', 20, 60
    ) where source_event_id = ineligible_claim_event_id
  ) or exists (
    select 1 from private.notification_deliveries delivery
    where delivery.source_event_id = ineligible_claim_event_id
      and delivery.state = 'leased'
  ) then
    raise exception 'Ineligible business delivery crossed claim';
  end if;
  update private.notification_deliveries set
    state = 'cancelled', last_provider_code = 'test_cleanup',
    lease_token = null, lease_expires_at = null, updated_at = now()
  where source_event_id = ineligible_claim_event_id;
  update public.businesses set state = 'published'
  where id = '70000000-0000-4000-8000-000000000007';

  insert into public.business_public_events (
    business_id, event_type, payload, expires_at
  ) values (
    '70000000-0000-4000-8000-000000000007',
    'owner_update',
    jsonb_build_object('update_id', '83200000-0000-4000-8000-000000000003'),
    now() + interval '1 hour'
  ) returning id into ineligible_handoff_event_id;

  select * into ineligible_handoff_outbox
  from private.claim_notification_outbox(
    '84200000-0000-4000-8000-000000000004', 10, 60
  ) where source_event_id = ineligible_handoff_event_id;
  if ineligible_handoff_outbox.outbox_id is null then
    raise exception 'Ineligible-handoff fixture outbox was not claimed';
  end if;
  affected := private.expand_notification_outbox(
    ineligible_handoff_outbox.outbox_id,
    ineligible_handoff_outbox.lease_token,
    20
  );
  if affected <> 1 then
    raise exception 'Ineligible-handoff fixture did not fan out exactly one delivery';
  end if;
  select * into ineligible_handoff_delivery
  from private.claim_notification_deliveries(
    '85200000-0000-4000-8000-000000000005', 20, 60
  ) where source_event_id = ineligible_handoff_event_id;
  if ineligible_handoff_delivery.delivery_id is null then
    raise exception 'Ineligible-handoff fixture was not leased while eligible';
  end if;

  update public.businesses set state = 'suspended'
  where id = '70000000-0000-4000-8000-000000000007';
  begin
    perform private.mark_notification_delivery_batch_sending(
      array[ineligible_handoff_delivery.delivery_id],
      array[ineligible_handoff_delivery.lease_token],
      60
    );
    raise exception 'Ineligible business delivery crossed provider handoff';
  exception when sqlstate '40001' then null;
  end;
  if not exists (
    select 1 from private.notification_deliveries delivery
    where delivery.id = ineligible_handoff_delivery.delivery_id
      and delivery.state = 'leased'
  ) then
    raise exception 'Rejected ineligible handoff did not preserve the lease atomically';
  end if;
  update private.notification_deliveries set
    state = 'cancelled', last_provider_code = 'test_cleanup',
    lease_token = null, lease_expires_at = null, updated_at = now()
  where id = ineligible_handoff_delivery.delivery_id;
  update public.businesses set state = 'published'
  where id = '70000000-0000-4000-8000-000000000007';

  insert into public.business_public_events (
    business_id, event_type, payload, expires_at
  ) values (
    '70000000-0000-4000-8000-000000000007',
    'owner_update',
    jsonb_build_object('update_id', '83000000-0000-4000-8000-000000000003', 'body', 'private body'),
    now() + interval '1 hour'
  ) returning id into first_event_id;

  select * into claimed_outbox
  from private.claim_notification_outbox(
    '84000000-0000-4000-8000-000000000004', 10, 60
  ) where source_event_id = first_event_id;
  if claimed_outbox.outbox_id is null then raise exception 'Eligible notification outbox was not claimed'; end if;
  affected := private.expand_notification_outbox(
    claimed_outbox.outbox_id, claimed_outbox.lease_token, 20
  );
  if affected <> 1 then raise exception 'Eligible notification fanout did not create one device delivery'; end if;
  select delivery.id into delivery_id from private.notification_deliveries delivery
  where delivery.source_event_id = first_event_id;

  select device.id into original_device_id
  from private.notification_devices device
  where device.user_id = '90000000-0000-4000-8000-000000000009'
    and device.provider = 'expo'
    and device.installation_id = '81000000-0000-4000-8000-000000000001'
    and device.revoked_at is null;
  if original_device_id is null or delivery_id is null then
    raise exception 'Cross-account rebind fixture did not capture the original device and delivery';
  end if;
  rebound_device_id := private.register_notification_device(
    '92000000-0000-4000-8000-000000000002',
    '91000000-0000-4000-8000-000000000003',
    '81000000-0000-4000-8000-000000000001',
    'ios', 'expo', '82000000-0000-4000-8000-000000000002',
    repeat('b', 64), repeat('J', 48), repeat('K', 16), 1,
    'America/Los_Angeles', '0.2.0', 'granted'
  );
  if not exists (
    select 1 from private.notification_devices device
    where device.id = original_device_id
      and device.revoked_at is not null
      and device.revoke_reason = 'ownership_changed'
  ) then raise exception 'Cross-account installation rebind left the prior device active'; end if;
  if not exists (
    select 1 from private.notification_deliveries delivery
    where delivery.id = delivery_id
      and delivery.device_id = original_device_id
      and delivery.user_id = '90000000-0000-4000-8000-000000000009'
      and delivery.state = 'cancelled'
      and delivery.last_provider_code = 'device_rebound'
  ) then raise exception 'Cross-account installation rebind left prior-account delivery queued'; end if;
  if not exists (
    select 1 from private.notification_devices device
    where device.id = rebound_device_id
      and device.user_id = '92000000-0000-4000-8000-000000000002'
      and device.auth_session_id = '91000000-0000-4000-8000-000000000003'
      and device.revoked_at is null
  ) then raise exception 'Cross-account installation rebind did not install the new owner'; end if;
  if rebound_device_id is null or (
    select count(*) from private.notification_devices device
    where device.provider = 'expo'
      and device.installation_id = '81000000-0000-4000-8000-000000000001'
      and device.revoked_at is null
  ) <> 1 then raise exception 'Cross-account rebind allowed multiple active owners'; end if;

  reclaimed_device_id := private.register_notification_device(
    '90000000-0000-4000-8000-000000000009',
    '91000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000001',
    'ios', 'expo', '82000000-0000-4000-8000-000000000002',
    repeat('a', 64), repeat('A', 48), repeat('B', 16), 1,
    'America/Los_Angeles', '0.2.0', 'granted'
  );
  if not exists (
    select 1 from private.notification_devices device
    where device.id = rebound_device_id
      and device.revoked_at is not null
      and device.revoke_reason = 'ownership_changed'
  ) then raise exception 'Installation reclaim left the temporary owner active'; end if;
  if not exists (
    select 1 from private.notification_devices device
    where device.id = reclaimed_device_id
      and device.user_id = '90000000-0000-4000-8000-000000000009'
      and device.auth_session_id = '91000000-0000-4000-8000-000000000001'
      and device.revoked_at is null
  ) then raise exception 'Installation reclaim did not restore the verified owner session'; end if;
  if reclaimed_device_id = original_device_id or exists (
    select 1 from private.notification_devices device
    where device.user_id = '92000000-0000-4000-8000-000000000002'
      and device.provider = 'expo'
      and device.installation_id = '81000000-0000-4000-8000-000000000001'
      and device.revoked_at is null
  ) then raise exception 'Installation reclaim reused stale ownership state'; end if;
  if reclaimed_device_id is null or (
    select count(*) from private.notification_devices device
    where device.provider = 'expo'
      and device.installation_id = '81000000-0000-4000-8000-000000000001'
      and device.revoked_at is null
  ) <> 1 then raise exception 'Installation ownership allowed multiple active owners'; end if;

  unmatched_device_id := private.register_notification_device(
    '90000000-0000-4000-8000-000000000009',
    '91000000-0000-4000-8000-000000000002',
    '81000000-0000-4000-8000-000000000009',
    'ios', 'expo', '82000000-0000-4000-8000-000000000002',
    repeat('c', 64), repeat('C', 48), repeat('D', 16), 1,
    'America/Los_Angeles', '0.2.0', 'granted'
  );

  begin
    insert into private.notification_deliveries (
      outbox_id, device_id, user_id, business_id, source_event_id, notification_kind
    ) values (
      claimed_outbox.outbox_id,
      unmatched_device_id,
      '10000000-0000-4000-8000-000000000001',
      '70000000-0000-4000-8000-000000000007', first_event_id, 'owner_update'
    );
    raise exception 'Delivery accepted a mismatched device owner';
  exception when foreign_key_violation then null;
  end;

  delete from auth.sessions
  where id = '91000000-0000-4000-8000-000000000002';
  affected := private.revoke_notification_devices_without_session();
  if affected <> 1 then raise exception 'Ended auth session did not retire one device'; end if;
  if not exists (
    select 1 from private.notification_devices device
    where device.id = unmatched_device_id
      and device.revoked_at is not null
      and device.revoke_reason = 'auth_session_ended'
  ) then raise exception 'Ended auth session left an active notification device'; end if;

  insert into public.business_public_events (
    business_id, event_type, payload, expires_at
  ) values (
    '70000000-0000-4000-8000-000000000007',
    'owner_update',
    jsonb_build_object('update_id', '83000000-0000-4000-8000-000000000010'),
    now() + interval '2 hours'
  ) returning id into unfollow_event_id;
  select * into unfollow_outbox_claim
  from private.claim_notification_outbox(
    '85000000-0000-4000-8000-000000000010', 10, 60
  ) where source_event_id = unfollow_event_id;
  if unfollow_outbox_claim.outbox_id is null then
    raise exception 'Unfollow fixture outbox was not claimed';
  end if;
  if private.expand_notification_outbox(
    unfollow_outbox_claim.outbox_id, unfollow_outbox_claim.lease_token, 20
  ) <> 1 then
    raise exception 'Unfollow fixture did not fan out exactly one delivery';
  end if;
  select delivery.id into unfollow_delivery_id
  from private.notification_deliveries delivery
  where delivery.source_event_id = unfollow_event_id
    and delivery.user_id = '90000000-0000-4000-8000-000000000009';
  if unfollow_delivery_id is null then
    raise exception 'Unfollow fixture delivery was not created';
  end if;

  delete from public.follows
  where user_id = '90000000-0000-4000-8000-000000000009'
    and business_id = '70000000-0000-4000-8000-000000000007';
  if not exists (
    select 1 from private.notification_deliveries delivery
    where delivery.id = unfollow_delivery_id
      and delivery.state = 'cancelled'
      and delivery.last_provider_code = 'follow_removed'
      and delivery.lease_token is null
      and delivery.lease_expires_at is null
  ) then raise exception 'Unfollow left the queued delivery claimable'; end if;
  if exists (
    select 1 from private.claim_notification_deliveries(
      '85000000-0000-4000-8000-000000000011', 20, 60
    ) where source_event_id = unfollow_event_id
  ) then raise exception 'Unfollowed delivery was still claimable'; end if;

  -- Recreate the follow for a leased delivery so the handoff guard is also
  -- exercised after the follow-delete trigger has run.
  insert into public.follows (user_id, business_id)
  values (
    '90000000-0000-4000-8000-000000000009',
    '70000000-0000-4000-8000-000000000007'
  );
  insert into public.business_public_events (
    business_id, event_type, payload, expires_at
  ) values (
    '70000000-0000-4000-8000-000000000007',
    'owner_update',
    jsonb_build_object('update_id', '83000000-0000-4000-8000-000000000011'),
    now() + interval '2 hours'
  ) returning id into unfollow_handoff_event_id;
  select * into unfollow_handoff_outbox_claim
  from private.claim_notification_outbox(
    '85000000-0000-4000-8000-000000000012', 10, 60
  ) where source_event_id = unfollow_handoff_event_id;
  if unfollow_handoff_outbox_claim.outbox_id is null then
    raise exception 'Unfollow handoff fixture outbox was not claimed';
  end if;
  if private.expand_notification_outbox(
    unfollow_handoff_outbox_claim.outbox_id,
    unfollow_handoff_outbox_claim.lease_token,
    20
  ) <> 1 then
    raise exception 'Unfollow handoff fixture did not fan out exactly one delivery';
  end if;
  select * into unfollow_handoff_delivery_claim
  from private.claim_notification_deliveries(
    '85000000-0000-4000-8000-000000000013', 20, 60
  ) where source_event_id = unfollow_handoff_event_id;
  if unfollow_handoff_delivery_claim.delivery_id is null then
    raise exception 'Unfollow handoff fixture delivery was not leased';
  end if;
  delete from public.follows
  where user_id = '90000000-0000-4000-8000-000000000009'
    and business_id = '70000000-0000-4000-8000-000000000007';
  begin
    perform private.mark_notification_delivery_batch_sending(
      array[unfollow_handoff_delivery_claim.delivery_id],
      array[unfollow_handoff_delivery_claim.lease_token], 60
    );
    raise exception 'Unfollowed delivery crossed provider handoff';
  exception when sqlstate '40001' then null;
  end;
  if not exists (
    select 1 from private.notification_deliveries delivery
    where delivery.id = unfollow_handoff_delivery_claim.delivery_id
      and delivery.state = 'cancelled'
      and delivery.last_provider_code = 'follow_removed'
  ) then raise exception 'Unfollow handoff guard did not preserve cancellation'; end if;

  insert into public.follows (user_id, business_id)
  values (
    '90000000-0000-4000-8000-000000000009',
    '70000000-0000-4000-8000-000000000007'
  ) on conflict do nothing;
end;
$push_runtime$;

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"90000000-0000-4000-8000-000000000009","role":"authenticated","aal":"aal2","session_id":"91000000-0000-4000-8000-000000000001"}',
  true
);
select public.update_follow_notification_preferences(
  array['70000000-0000-4000-8000-000000000007'::uuid],
  'owner_bundle', false, null, null, null,
  'spottr:notification-preference:runtime-disable-0003'
);
reset role;

do $push_preference_revocation$
begin
  if exists (
    select 1 from private.notification_deliveries delivery
    where delivery.user_id = '90000000-0000-4000-8000-000000000009'
      and delivery.state in ('pending', 'leased', 'retry', 'unknown')
  ) then raise exception 'Preference revocation left a claimable delivery'; end if;
  if exists (
    select 1 from private.claim_notification_deliveries(
      '85000000-0000-4000-8000-000000000005', 20, 60
    )
  ) then raise exception 'Claim-time preference enforcement was bypassed'; end if;
end;
$push_preference_revocation$;

select private.set_notification_consent(
  '90000000-0000-4000-8000-000000000009',
  'product_updates', false, 'product-updates-v1', 'native_settings'
);

do $push_consent_revocation$
begin
  if exists (
    select 1 from private.notification_deliveries delivery
    where delivery.user_id = '90000000-0000-4000-8000-000000000009'
      and delivery.state in ('pending', 'leased', 'retry', 'unknown')
  ) then raise exception 'Consent revocation left a claimable delivery'; end if;
  if has_table_privilege('authenticated', 'private.notification_devices', 'select')
    or has_function_privilege(
      'authenticated',
      'public.register_notification_device_server(uuid,uuid,uuid,text,uuid,text,text,text,integer,text,text,text,text,text)',
      'execute'
    )
  then raise exception 'Notification device secrets or server registration are client-accessible'; end if;
end;
$push_consent_revocation$;

-- The provider remains external and disabled in production. Exercise only the
-- service-role dispatch/receipt state machine with synthetic tickets.
select private.set_notification_consent(
  '90000000-0000-4000-8000-000000000009',
  'product_updates', true, 'product-updates-v1', 'native_settings'
);
update public.notification_preferences set
  owner_update = true, location_change = true, menu_return = true,
  quiet_hours_start = null, quiet_hours_end = null, timezone = null,
  updated_at = now()
where user_id = '90000000-0000-4000-8000-000000000009'
  and business_id = '70000000-0000-4000-8000-000000000007';
update private.notification_devices set
  revoked_at = now(), revoke_reason = 'user_revoked', updated_at = now()
where user_id = '90000000-0000-4000-8000-000000000009'
  and installation_id = '81000000-0000-4000-8000-000000000009'
  and revoked_at is null;

do $push_dispatch_receipt_runtime$
declare
  event_id bigint;
  ambiguous_event_id bigint;
  outbox_claim record;
  ambiguous_outbox_claim record;
  delivery_claim record;
  ambiguous_delivery_claim record;
  receipt_claim record;
  receipt_claim_count integer;
  receipt_finalization jsonb;
  unknown_finalization jsonb;
  outbox_finalization jsonb;
  pending_outbox_event_id bigint;
  retry_outbox_event_id bigint;
  leased_outbox_event_id bigint;
  active_outbox_event_id bigint;
  pending_outbox_id uuid;
  retry_outbox_id uuid;
  leased_outbox_id uuid;
  active_outbox_id uuid;
begin
  insert into public.business_public_events (
    business_id, event_type, payload, expires_at
  ) values (
    '70000000-0000-4000-8000-000000000007',
    'owner_update',
    jsonb_build_object(
      'update_id', '86000000-0000-4000-8000-000000000006',
      'body', 'must never enter the provider payload'
    ),
    now() + interval '2 hours'
  ) returning id into event_id;

  select * into outbox_claim
  from public.claim_notification_outbox_server(
    '87000000-0000-4000-8000-000000000007', 10, 60
  ) where source_event_id = event_id;
  if outbox_claim.outbox_id is null then
    raise exception 'Server dispatch wrapper did not claim the outbox event';
  end if;
  if public.expand_notification_outbox_server(
    outbox_claim.outbox_id, outbox_claim.lease_token, 20
  ) <> 1 then
    raise exception 'Server dispatch wrapper did not fan out exactly one delivery';
  end if;

  select * into delivery_claim
  from public.claim_notification_deliveries_server(
    '88000000-0000-4000-8000-000000000008', 20, 60
  ) where source_event_id = event_id;
  if delivery_claim.delivery_id is null then
    raise exception 'Server dispatch wrapper did not claim the delivery';
  end if;
  perform public.mark_notification_delivery_batch_sending_server(
    array[delivery_claim.delivery_id], array[delivery_claim.lease_token], 60
  );
  perform public.record_notification_delivery_result_server(
    delivery_claim.delivery_id,
    delivery_claim.lease_token,
    'accepted',
    'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    'ExpoAccepted',
    null
  );
  if not exists (
    select 1 from private.notification_receipt_checks receipt
    where receipt.delivery_id = delivery_claim.delivery_id
      and receipt.state = 'pending'
      and receipt.available_at >= receipt.created_at + interval '14 minutes'
  ) then raise exception 'Accepted provider ticket did not create a delayed receipt check'; end if;

  insert into public.business_public_events (
    business_id, event_type, payload, expires_at
  ) values (
    '70000000-0000-4000-8000-000000000007',
    'owner_update',
    jsonb_build_object('update_id', '86100000-0000-4000-8000-000000000006'),
    now() + interval '2 hours'
  ) returning id into ambiguous_event_id;
  select * into ambiguous_outbox_claim
  from public.claim_notification_outbox_server(
    '87100000-0000-4000-8000-000000000007', 10, 60
  ) where source_event_id = ambiguous_event_id;
  if ambiguous_outbox_claim.outbox_id is null then
    raise exception 'Ambiguous-send fixture outbox was not claimed';
  end if;
  if public.expand_notification_outbox_server(
    ambiguous_outbox_claim.outbox_id, ambiguous_outbox_claim.lease_token, 20
  ) <> 1 then raise exception 'Ambiguous-send fixture did not fan out'; end if;
  select * into ambiguous_delivery_claim
  from public.claim_notification_deliveries_server(
    '88100000-0000-4000-8000-000000000008', 20, 60
  ) where source_event_id = ambiguous_event_id;
  if ambiguous_delivery_claim.delivery_id is null then
    raise exception 'Ambiguous-send fixture delivery was not claimed';
  end if;
  perform public.mark_notification_delivery_batch_sending_server(
    array[ambiguous_delivery_claim.delivery_id],
    array[ambiguous_delivery_claim.lease_token],
    60
  );
  update private.notification_deliveries set lease_expires_at = now() - interval '1 second'
  where id = ambiguous_delivery_claim.delivery_id;
  perform * from public.claim_notification_deliveries_server(
    '88200000-0000-4000-8000-000000000008', 20, 60
  );
  if not exists (
    select 1 from private.notification_deliveries delivery
    where delivery.id = ambiguous_delivery_claim.delivery_id
      and delivery.state = 'unknown'
      and delivery.last_provider_code = 'worker_handoff_ambiguous'
  ) then raise exception 'Expired sending handoff was blindly retried'; end if;

  update private.notification_receipt_checks set available_at = now()
  where delivery_id = delivery_claim.delivery_id;
  select * into receipt_claim
  from public.claim_notification_receipts_server(
    '89000000-0000-4000-8000-000000000009', 20, 60
  ) where delivery_id = delivery_claim.delivery_id;
  if receipt_claim.receipt_check_id is null then
    raise exception 'Server receipt wrapper did not claim the provider ticket';
  end if;
  perform public.record_notification_receipt_result_server(
    receipt_claim.receipt_check_id,
    receipt_claim.lease_token,
    'dead',
    'DeviceNotRegistered',
    null
  );
  if not exists (
    select 1 from private.notification_devices device
    where device.id = delivery_claim.device_id
      and device.revoked_at is not null
      and device.revoke_reason = 'provider_invalid'
  ) then raise exception 'Invalid provider receipt did not retire the device'; end if;
  if not exists (
    select 1 from private.notification_deliveries delivery
    where delivery.id = delivery_claim.delivery_id
      and delivery.state = 'dead'
      and delivery.last_provider_code = 'DeviceNotRegistered'
  ) then raise exception 'Invalid provider receipt did not finalize the delivery'; end if;

  -- An active receipt lease is preserved even when its receipt window has
  -- expired; the provider request may still be in flight.
  update private.notification_deliveries
  set state = 'accepted', last_provider_code = 'ExpoAccepted', updated_at = now()
  where id = delivery_claim.delivery_id;
  update private.notification_receipt_checks
  set state = 'leased', attempts = 1, created_at = now() - interval '2 hours',
      expires_at = now() - interval '1 hour', available_at = now(),
      lease_token = '8a000000-0000-4000-8000-000000000008',
      lease_expires_at = now() + interval '1 hour',
      last_provider_code = 'ExpoReceiptPending', updated_at = now()
  where delivery_id = delivery_claim.delivery_id;
  select count(*) into receipt_claim_count
  from public.claim_notification_receipts_server(
    '89a00000-0000-4000-8000-000000000009', 20, 60
  ) where delivery_id = delivery_claim.delivery_id;
  if receipt_claim_count <> 0
  then raise exception 'Active receipt lease was finalized prematurely'; end if;
  if not exists (
    select 1 from private.notification_receipt_checks receipt
    where receipt.delivery_id = delivery_claim.delivery_id
      and receipt.state = 'leased'
      and receipt.lease_token = '8a000000-0000-4000-8000-000000000008'
      and receipt.lease_expires_at > now()
  ) then raise exception 'Active receipt lease was cleared'; end if;

  -- Receipt max-attempt finalization is atomic with the accepted delivery and
  -- never leaves a row eligible for another provider attempt.
  update private.notification_receipt_checks
  set state = 'retry', attempts = 20, expires_at = now() + interval '1 day',
      available_at = now(), lease_token = null, lease_expires_at = null,
      last_provider_code = 'ExpoReceiptPending', updated_at = now()
  where delivery_id = delivery_claim.delivery_id;
  receipt_finalization := private.finalize_notification_receipt_expiry(20);
  if coalesce((receipt_finalization->>'finalized')::integer, 0) <> 1
    or coalesce((receipt_finalization->>'more_work')::boolean, true)
  then raise exception 'Receipt max-attempt finalization did not settle its bounded batch'; end if;
  if not exists (
    select 1 from private.notification_receipt_checks receipt
    where receipt.delivery_id = delivery_claim.delivery_id
      and receipt.state = 'dead'
      and receipt.last_provider_code = 'receipt_max_attempts'
  ) or not exists (
    select 1 from private.notification_deliveries delivery
    where delivery.id = delivery_claim.delivery_id
      and delivery.state = 'failed'
      and delivery.last_provider_code = 'receipt_max_attempts'
  ) then raise exception 'Receipt max-attempt finalization left an accepted delivery retryable'; end if;

  -- A fresh provider 5xx/lease ambiguity remains untouched during the fixed
  -- two-hour grace window, including its lease fields.
  update private.notification_deliveries
  set state = 'unknown', lease_token = '8b000000-0000-4000-8000-000000000008',
      lease_expires_at = now() + interval '1 hour', updated_at = now(),
      last_provider_code = 'ExpoHttp503'
  where id = ambiguous_delivery_claim.delivery_id;
  unknown_finalization := private.finalize_unknown_notification_deliveries(20);
  if coalesce((unknown_finalization->>'finalized')::integer, 0) <> 0
    or coalesce((unknown_finalization->>'more_work')::boolean, true)
  then raise exception 'Fresh unknown delivery was finalized prematurely'; end if;
  if not exists (
    select 1 from private.notification_deliveries delivery
    where delivery.id = ambiguous_delivery_claim.delivery_id
      and delivery.state = 'unknown'
      and delivery.lease_token = '8b000000-0000-4000-8000-000000000008'
      and delivery.lease_expires_at > now()
  ) then raise exception 'Fresh unknown delivery lease was cleared'; end if;

  -- A stale provider 5xx/lease ambiguity is finalized after the grace window
  -- and clears any leftover lease fields.
  update private.notification_deliveries
  set updated_at = now() - interval '3 hours'
  where id = ambiguous_delivery_claim.delivery_id;
  unknown_finalization := private.finalize_unknown_notification_deliveries(20);
  if coalesce((unknown_finalization->>'finalized')::integer, 0) <> 1
    or coalesce((unknown_finalization->>'more_work')::boolean, true)
  then raise exception 'Unknown delivery finalization did not settle its bounded batch'; end if;
  if not exists (
    select 1 from private.notification_deliveries delivery
    where delivery.id = ambiguous_delivery_claim.delivery_id
      and delivery.state = 'failed'
      and delivery.lease_token is null
      and delivery.lease_expires_at is null
      and delivery.last_provider_code = 'provider_ambiguity_expired'
  ) then raise exception 'Unknown provider outcome was not finalized terminally'; end if;

  -- Delivery attempts that can no longer be claimed are finalized without
  -- touching a provider-handoff `sending` row.
  update private.notification_deliveries
  set state = 'retry', attempts = 20, lease_token = null,
      lease_expires_at = null, updated_at = now(),
      last_provider_code = 'ExpoReceiptPending'
  where id = delivery_claim.delivery_id;
  unknown_finalization := private.finalize_unknown_notification_deliveries(20);
  if coalesce((unknown_finalization->>'finalized')::integer, 0) <> 1
    or coalesce((unknown_finalization->>'more_work')::boolean, true)
  then raise exception 'Exhausted retry delivery was not finalized'; end if;
  if not exists (
    select 1 from private.notification_deliveries delivery
    where delivery.id = delivery_claim.delivery_id
      and delivery.state = 'failed'
      and delivery.last_provider_code = 'delivery_max_attempts'
  ) then raise exception 'Exhausted retry delivery remained retryable'; end if;

  update private.notification_deliveries
  set state = 'leased', attempts = 20,
      lease_token = '8c000000-0000-4000-8000-000000000008',
      lease_expires_at = now() - interval '1 second', updated_at = now(),
      last_provider_code = 'ExpoReceiptPending'
  where id = ambiguous_delivery_claim.delivery_id;
  unknown_finalization := private.finalize_unknown_notification_deliveries(20);
  if coalesce((unknown_finalization->>'finalized')::integer, 0) <> 1
    or coalesce((unknown_finalization->>'more_work')::boolean, true)
  then raise exception 'Expired exhausted lease was not finalized'; end if;
  if not exists (
    select 1 from private.notification_deliveries delivery
    where delivery.id = ambiguous_delivery_claim.delivery_id
      and delivery.state = 'failed'
      and delivery.lease_token is null
      and delivery.lease_expires_at is null
      and delivery.last_provider_code = 'delivery_lease_max_attempts'
  ) then raise exception 'Expired exhausted lease remained retryable'; end if;

  -- Outbox attempts have their own terminal boundary. Pending/retry rows and
  -- expired pre-fan-out leases are settled, while an active lease remains
  -- untouched because its worker may still be in flight.
  insert into public.business_public_events (
    business_id, event_type, payload, expires_at
  ) values (
    '70000000-0000-4000-8000-000000000007', 'owner_update',
    jsonb_build_object('update_id', '86200000-0000-4000-8000-000000000006'),
    now() + interval '2 hours'
  ) returning id into pending_outbox_event_id;
  select id into pending_outbox_id
  from private.notification_outbox where source_event_id = pending_outbox_event_id;
  update private.notification_outbox set
    state = 'pending', attempts = 20, lease_token = null,
    lease_expires_at = null, updated_at = now()
  where id = pending_outbox_id;
  outbox_finalization := private.finalize_notification_outbox(20);
  if coalesce((outbox_finalization->>'finalized')::integer, 0) <> 1
    or coalesce((outbox_finalization->>'more_work')::boolean, true)
  then raise exception 'Exhausted pending outbox was not finalized'; end if;
  if not exists (
    select 1 from private.notification_outbox queue
    where queue.id = pending_outbox_id
      and queue.state = 'dead'
      and queue.lease_token is null
      and queue.lease_expires_at is null
      and queue.last_error_code = 'outbox_max_attempts'
  ) then raise exception 'Exhausted pending outbox remained claimable'; end if;

  insert into public.business_public_events (
    business_id, event_type, payload, expires_at
  ) values (
    '70000000-0000-4000-8000-000000000007', 'owner_update',
    jsonb_build_object('update_id', '86300000-0000-4000-8000-000000000006'),
    now() + interval '2 hours'
  ) returning id into retry_outbox_event_id;
  select id into retry_outbox_id
  from private.notification_outbox where source_event_id = retry_outbox_event_id;
  update private.notification_outbox set
    state = 'retry', attempts = 20, lease_token = null,
    lease_expires_at = null, updated_at = now()
  where id = retry_outbox_id;
  outbox_finalization := private.finalize_notification_outbox(20);
  if coalesce((outbox_finalization->>'finalized')::integer, 0) <> 1
    or coalesce((outbox_finalization->>'more_work')::boolean, true)
  then raise exception 'Exhausted retry outbox was not finalized'; end if;
  if not exists (
    select 1 from private.notification_outbox queue
    where queue.id = retry_outbox_id
      and queue.state = 'dead'
      and queue.last_error_code = 'outbox_max_attempts'
  ) then raise exception 'Exhausted retry outbox remained claimable'; end if;

  insert into public.business_public_events (
    business_id, event_type, payload, expires_at
  ) values (
    '70000000-0000-4000-8000-000000000007', 'owner_update',
    jsonb_build_object('update_id', '86400000-0000-4000-8000-000000000006'),
    now() + interval '2 hours'
  ) returning id into leased_outbox_event_id;
  select id into leased_outbox_id
  from private.notification_outbox where source_event_id = leased_outbox_event_id;
  update private.notification_outbox set
    state = 'leased', attempts = 20,
    lease_token = '8d000000-0000-4000-8000-000000000008',
    lease_expires_at = now() - interval '1 second', updated_at = now()
  where id = leased_outbox_id;
  outbox_finalization := private.finalize_notification_outbox(20);
  if coalesce((outbox_finalization->>'finalized')::integer, 0) <> 1
    or coalesce((outbox_finalization->>'more_work')::boolean, true)
  then raise exception 'Expired exhausted outbox lease was not finalized'; end if;
  if not exists (
    select 1 from private.notification_outbox queue
    where queue.id = leased_outbox_id
      and queue.state = 'dead'
      and queue.lease_token is null
      and queue.lease_expires_at is null
      and queue.last_error_code = 'outbox_max_attempts'
  ) then raise exception 'Expired exhausted outbox lease remained claimable'; end if;

  insert into public.business_public_events (
    business_id, event_type, payload, expires_at
  ) values (
    '70000000-0000-4000-8000-000000000007', 'owner_update',
    jsonb_build_object('update_id', '86500000-0000-4000-8000-000000000006'),
    now() + interval '2 hours'
  ) returning id into active_outbox_event_id;
  select id into active_outbox_id
  from private.notification_outbox where source_event_id = active_outbox_event_id;
  update private.notification_outbox set
    state = 'leased', attempts = 20,
    lease_token = '8e000000-0000-4000-8000-000000000008',
    lease_expires_at = now() + interval '1 hour', updated_at = now()
  where id = active_outbox_id;
  outbox_finalization := private.finalize_notification_outbox(20);
  if coalesce((outbox_finalization->>'finalized')::integer, 0) <> 0
    or coalesce((outbox_finalization->>'more_work')::boolean, true)
  then raise exception 'Active outbox lease was finalized prematurely'; end if;
  if not exists (
    select 1 from private.notification_outbox queue
    where queue.id = active_outbox_id
      and queue.state = 'leased'
      and queue.lease_token = '8e000000-0000-4000-8000-000000000008'
      and queue.lease_expires_at > now()
  ) then raise exception 'Active outbox lease was cleared'; end if;
end;
$push_dispatch_receipt_runtime$;

-- A deletion freeze is an immediate account-wide push boundary. It must cancel
-- a lease and make both later claims and provider handoff impossible.
insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values (
  '93000000-0000-4000-8000-000000000003',
  'authenticated', 'authenticated', 'runtime-push-delete@spottr.invalid', now(),
  '{}'::jsonb,
  '{"username":"runtime_push_delete","display_name":"Runtime Push Delete","terms_accepted":true}'::jsonb,
  now(), now()
);
insert into auth.sessions (id, user_id, created_at, updated_at)
values (
  '93100000-0000-4000-8000-000000000003',
  '93000000-0000-4000-8000-000000000003',
  now(), now()
);
insert into public.follows (user_id, business_id)
values (
  '93000000-0000-4000-8000-000000000003',
  '70000000-0000-4000-8000-000000000007'
);

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"93000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2","session_id":"93100000-0000-4000-8000-000000000003"}',
  true
);
select public.update_follow_notification_preferences(
  array['70000000-0000-4000-8000-000000000007'::uuid],
  'owner_bundle', true, null, null, null,
  'spottr:notification-preference:runtime-delete-0001'
);
reset role;

select public.register_notification_device_server(
  '93000000-0000-4000-8000-000000000003',
  '93100000-0000-4000-8000-000000000003',
  '93200000-0000-4000-8000-000000000003',
  'ios',
  '82000000-0000-4000-8000-000000000002',
  repeat('9', 64), repeat('L', 48), repeat('M', 16), 1,
  'America/Los_Angeles', '0.2.0', 'granted',
  'product-updates-v1', 'native_settings'
);

do $push_account_deletion_runtime$
declare
  event_id bigint;
  outbox_claim record;
  delivery_claim record;
begin
  insert into public.business_public_events (
    business_id, event_type, payload, expires_at
  ) values (
    '70000000-0000-4000-8000-000000000007',
    'owner_update',
    jsonb_build_object('update_id', '93300000-0000-4000-8000-000000000003'),
    now() + interval '2 hours'
  ) returning id into event_id;

  select * into outbox_claim
  from public.claim_notification_outbox_server(
    '93400000-0000-4000-8000-000000000003', 20, 60
  ) where source_event_id = event_id;
  if outbox_claim.outbox_id is null
    or public.expand_notification_outbox_server(
      outbox_claim.outbox_id, outbox_claim.lease_token, 20
    ) < 1
  then
    raise exception 'Deletion lifecycle fixture did not create a delivery';
  end if;

  select * into delivery_claim
  from public.claim_notification_deliveries_server(
    '93500000-0000-4000-8000-000000000003', 20, 60
  ) claimed where claimed.source_event_id = event_id
      and claimed.user_id = '93000000-0000-4000-8000-000000000003';
  if delivery_claim.delivery_id is null then
    raise exception 'Deletion lifecycle fixture delivery was not leased';
  end if;

  begin
    update public.profiles
    set status = 'deleted'
    where user_id = '93000000-0000-4000-8000-000000000003';
    raise exception 'Profile status changed without a deletion freeze';
  exception
    when insufficient_privilege then null;
  end;

  perform * from public.begin_account_deletion(
    '93000000-0000-4000-8000-000000000003',
    'spottr:runtime-delete-push-0001'
  );

  if not exists (
    select 1
    from public.profiles profile
    where profile.user_id = '93000000-0000-4000-8000-000000000003'
      and profile.status = 'deleted'
  ) then
    raise exception 'Frozen account deletion did not apply the terminal profile status';
  end if;

  if coalesce(
    current_setting('spottr.account_deletion_request_id', true), '<missing>'
  ) <> '' then
    raise exception 'Account deletion left its profile-transition marker active';
  end if;

  begin
    update public.profiles
    set status = 'active'
    where user_id = '93000000-0000-4000-8000-000000000003';
    raise exception 'Deletion freeze remained a reusable profile-status bypass';
  exception
    when insufficient_privilege then null;
  end;

  if not exists (
    select 1 from private.notification_deliveries delivery
    where delivery.id = delivery_claim.delivery_id
      and delivery.state = 'cancelled'
      and delivery.last_provider_code = 'account_deletion'
      and delivery.lease_token is null
      and delivery.lease_expires_at is null
  ) then
    raise exception 'Account deletion freeze left a notification delivery leased';
  end if;

  begin
    perform public.mark_notification_delivery_batch_sending_server(
      array[delivery_claim.delivery_id],
      array[delivery_claim.lease_token],
      60
    );
    raise exception 'Deleted account delivery crossed provider handoff';
  exception
    when sqlstate '40001' then null;
  end;

  update private.notification_outbox queue
  set created_at = now() - interval '2 hours',
      expires_at = now() - interval '1 hour',
      updated_at = now()
  where queue.id = outbox_claim.outbox_id;
  perform * from public.claim_notification_deliveries_server(
    '93600000-0000-4000-8000-000000000003', 20, 60
  );
  if not exists (
    select 1 from private.notification_deliveries delivery
    where delivery.id = delivery_claim.delivery_id
      and delivery.state = 'cancelled'
      and delivery.last_provider_code = 'account_deletion'
  ) then
    raise exception 'Expiry cleanup erased terminal account-deletion cancellation';
  end if;

  if exists (
    select 1 from public.claim_notification_deliveries_server(
      '93700000-0000-4000-8000-000000000003', 20, 60
    ) claimed
    where claimed.source_event_id = event_id
  ) then
    raise exception 'Deleted account delivery was claimable after freeze';
  end if;
end;
$push_account_deletion_runtime$;

do $push_dispatch_privilege_guard$
declare
  client_role text;
  function_signature text;
begin
  if has_table_privilege('authenticated', 'private.notification_receipt_checks', 'select')
    or has_function_privilege(
      'authenticated', 'public.claim_notification_outbox_server(uuid,integer,integer)', 'execute'
    )
    or has_function_privilege(
      'authenticated', 'public.claim_notification_receipts_server(uuid,integer,integer)', 'execute'
    )
    or has_function_privilege(
      'authenticated', 'public.record_notification_receipt_result_server(uuid,uuid,text,text,integer)', 'execute'
    )
  then raise exception 'Notification provider worker authority is client-accessible'; end if;

  foreach client_role in array array['anon', 'authenticated'] loop
    foreach function_signature in array array[
      'public.finalize_notification_outbox_server(integer)',
      'public.finalize_unknown_notification_deliveries_server(integer)',
      'public.finalize_notification_receipt_expiry_server(integer)',
      'public.notification_outbox_has_pending_server(uuid[])',
      'public.claim_notification_receipts_after_finalization_server(uuid,integer,integer)'
    ] loop
      if has_function_privilege(client_role, function_signature, 'execute') then
        raise exception 'Notification wrapper % is executable by %',
          function_signature, client_role;
      end if;
    end loop;
  end loop;
end;
$push_dispatch_privilege_guard$;

select pg_catalog.set_config(
  'request.jwt.claims', '{"role":"service_role"}', true
);
set local role service_role;

do $push_dispatch_service_wrapper_runtime$
declare
  result jsonb;
  claimed_receipts integer;
begin
  result := public.finalize_notification_outbox_server(1);
  if coalesce(jsonb_typeof(result->'finalized'), '') <> 'number'
    or coalesce(jsonb_typeof(result->'more_work'), '') <> 'boolean'
  then raise exception 'Service-role outbox finalizer returned an invalid contract'; end if;

  result := public.finalize_unknown_notification_deliveries_server(1);
  if coalesce(jsonb_typeof(result->'finalized'), '') <> 'number'
    or coalesce(jsonb_typeof(result->'more_work'), '') <> 'boolean'
  then raise exception 'Service-role delivery finalizer returned an invalid contract'; end if;

  result := public.finalize_notification_receipt_expiry_server(1);
  if coalesce(jsonb_typeof(result->'finalized'), '') <> 'number'
    or coalesce(jsonb_typeof(result->'more_work'), '') <> 'boolean'
  then raise exception 'Service-role receipt finalizer returned an invalid contract'; end if;

  if public.notification_outbox_has_pending_server(
    array['ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid]
  ) then raise exception 'Outbox status wrapper matched an absent row'; end if;

  select count(*) into claimed_receipts
  from public.claim_notification_receipts_after_finalization_server(
    '89b00000-0000-4000-8000-000000000009', 1, 60
  );
  if claimed_receipts not between 0 and 1 then
    raise exception 'After-finalization receipt wrapper exceeded its batch';
  end if;
end;
$push_dispatch_service_wrapper_runtime$;

reset role;

rollback;
