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
) values (
  '73000000-0000-4000-8000-000000000007',
  '70000000-0000-4000-8000-000000000007',
  'Runtime location', '100 Runtime Way', 'Los Angeles', 'CA', '90001',
  public.st_setsrid(public.st_makepoint(-118.24, 34.05), 4326)::public.geography,
  true, false, true, 'published'
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
values (
  '90000000-0000-4000-8000-000000000009',
  'authenticated', 'authenticated', 'runtime-push@spottr.invalid', now(),
  '{}'::jsonb,
  '{"username":"runtime_push","display_name":"Runtime Push","terms_accepted":true}'::jsonb,
  now(), now()
);

insert into public.follows (user_id, business_id)
values (
  '90000000-0000-4000-8000-000000000009',
  '70000000-0000-4000-8000-000000000007'
)
on conflict do nothing;

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"90000000-0000-4000-8000-000000000009","role":"authenticated","aal":"aal2"}',
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

select public.register_notification_device_server(
  '90000000-0000-4000-8000-000000000009',
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
  unmatched_device_id uuid;
  affected integer;
begin
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

  unmatched_device_id := private.register_notification_device(
    '90000000-0000-4000-8000-000000000009',
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
end;
$push_runtime$;

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"90000000-0000-4000-8000-000000000009","role":"authenticated","aal":"aal2"}',
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
      'public.register_notification_device_server(uuid,uuid,text,uuid,text,text,text,integer,text,text,text,text,text)',
      'execute'
    )
  then raise exception 'Notification device secrets or server registration are client-accessible'; end if;
end;
$push_consent_revocation$;

rollback;
