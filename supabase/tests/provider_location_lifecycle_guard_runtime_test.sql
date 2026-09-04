\set ON_ERROR_STOP on

begin;

-- Keep this fixture self-contained. The business is made fully publishable so
-- the location helper is exercised through the same publication and source
-- eligibility prerequisites as production data, then the whole probe rolls
-- back before the next runtime contract runs.
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
values (
  'f7000000-0000-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  'runtime-provider-guard@spottr.invalid',
  now(),
  '{}'::jsonb,
  '{"username":"runtime_provider_guard","display_name":"Runtime Provider Guard","terms_accepted":true}'::jsonb,
  now(),
  now()
);

insert into public.businesses (
  id,
  kind,
  name,
  slug,
  description,
  cuisine_labels,
  price_level,
  state,
  verification,
  timezone,
  provenance,
  created_by
)
values (
  'f7100000-0000-4000-8000-000000000001',
  'restaurant',
  'Runtime Provider Guard Kitchen',
  'runtime-provider-guard-kitchen',
  'Runtime provider lifecycle fixture.',
  array['runtime']::text[],
  2,
  'draft',
  'unverified',
  'America/Los_Angeles',
  'licensed_provider',
  'f7000000-0000-4000-8000-000000000001'
), (
  'f7100000-0000-4000-8000-000000000002',
  'restaurant',
  'Runtime Provider Guard Other Kitchen',
  'runtime-provider-guard-other-kitchen',
  'Runtime provider mismatch fixture.',
  array['runtime']::text[],
  2,
  'draft',
  'unverified',
  'America/Los_Angeles',
  'owner',
  'f7000000-0000-4000-8000-000000000001'
);

insert into private.provider_accounts (
  provider_slug,
  enabled,
  license_agreement_id,
  license_effective_on,
  license_expires_on,
  allowed_field_classes,
  accepted_signing_key_ids,
  retention_terms,
  deletion_terms,
  configuration_version
)
values
  (
    'runtime_guard_a',
    true,
    'runtime-license-a',
    current_date - 1,
    current_date + 1,
    array['locations']::text[],
    array['runtime-key-a']::text[],
    'Runtime fixture retention.',
    'Runtime fixture deletion.',
    'runtime-test-v1'
  ),
  (
    'runtime_guard_b',
    true,
    'runtime-license-b',
    current_date - 1,
    current_date + 1,
    array['locations']::text[],
    array['runtime-key-b']::text[],
    'Runtime fixture retention.',
    'Runtime fixture deletion.',
    'runtime-test-v1'
  ),
  (
    'runtime_guard_c',
    true,
    'runtime-license-c',
    current_date - 1,
    current_date + 1,
    array['locations']::text[],
    array['runtime-key-c']::text[],
    'Runtime fixture retention.',
    'Runtime fixture deletion.',
    'runtime-test-v1'
  );

insert into private.provider_business_sources (
  provider_slug,
  provider_external_id,
  business_id,
  source_status,
  source_updated_at,
  source_url,
  license_agreement_id,
  normalized_payload_hash
)
values
  (
    'runtime_guard_a',
    'runtime-business-main',
    'f7100000-0000-4000-8000-000000000001',
    'active',
    now(),
    null,
    'runtime-license-a',
    repeat('a', 64)
  ),
  (
    'runtime_guard_b',
    'runtime-business-null-parent',
    null,
    'active',
    now(),
    null,
    'runtime-license-b',
    repeat('b', 64)
  ),
  (
    'runtime_guard_c',
    'runtime-business-mismatched-parent',
    'f7100000-0000-4000-8000-000000000002',
    'active',
    now(),
    null,
    'runtime-license-c',
    repeat('c', 64)
  );

insert into public.business_private_details (
  business_id,
  business_email,
  business_phone
)
values (
  'f7100000-0000-4000-8000-000000000001',
  'runtime-provider-guard@spottr.invalid',
  '+14155550123'
);

insert into public.weekly_hours (
  business_id,
  weekday,
  opens_at,
  closes_at,
  is_closed
)
select
  'f7100000-0000-4000-8000-000000000001',
  weekday,
  '09:00'::time,
  '17:00'::time,
  false
from generate_series(0, 6) as days(weekday);

insert into public.business_payments (business_id, payment)
values ('f7100000-0000-4000-8000-000000000001', 'cash');

insert into public.menu_sections (
  id,
  business_id,
  name,
  sort_order,
  is_published
)
values (
  'f7400000-0000-4000-8000-000000000001',
  'f7100000-0000-4000-8000-000000000001',
  'Runtime Menu',
  0,
  true
);

insert into public.menu_items (
  id,
  section_id,
  name,
  description,
  price_minor,
  currency,
  availability,
  dietary_tags,
  sort_order,
  is_published
)
values (
  'f7500000-0000-4000-8000-000000000001',
  'f7400000-0000-4000-8000-000000000001',
  'Runtime Bowl',
  'Runtime menu item.',
  1000,
  'USD',
  'available',
  '{}'::text[],
  0,
  true
);

insert into public.business_locations (
  id,
  business_id,
  label,
  address_line,
  city,
  region,
  postal_code,
  point,
  is_primary,
  is_approximate,
  public_address,
  publication_state
)
values
  (
    'f7200000-0000-4000-8000-000000000001',
    'f7100000-0000-4000-8000-000000000001',
    'Runtime Valid Location',
    '1 Runtime Way',
    'San Francisco',
    'CA',
    '94105',
    public.st_setsrid(public.st_makepoint(-122.3958, 37.7936), 4326)::public.geography,
    true,
    false,
    true,
    'published'
  ),
  (
    'f7200000-0000-4000-8000-000000000002',
    'f7100000-0000-4000-8000-000000000001',
    'Runtime Inactive Location',
    '2 Runtime Way',
    'San Francisco',
    'CA',
    '94105',
    public.st_setsrid(public.st_makepoint(-122.3960, 37.7938), 4326)::public.geography,
    false,
    false,
    true,
    'published'
  ),
  (
    'f7200000-0000-4000-8000-000000000003',
    'f7100000-0000-4000-8000-000000000001',
    'Runtime Null Parent Location',
    '3 Runtime Way',
    'San Francisco',
    'CA',
    '94105',
    public.st_setsrid(public.st_makepoint(-122.3962, 37.7940), 4326)::public.geography,
    false,
    false,
    true,
    'published'
  ),
  (
    'f7200000-0000-4000-8000-000000000004',
    'f7100000-0000-4000-8000-000000000001',
    'Runtime Mismatched Parent Location',
    '4 Runtime Way',
    'San Francisco',
    'CA',
    '94105',
    public.st_setsrid(public.st_makepoint(-122.3964, 37.7942), 4326)::public.geography,
    false,
    false,
    true,
    'published'
  );

insert into public.media_assets (
  id,
  owner_id,
  business_id,
  storage_path,
  mime_type,
  width,
  height,
  byte_size,
  sha256,
  source,
  license_note,
  quarantine_state,
  processed_storage_path,
  scan_completed_at,
  moderation
)
values (
  'f7300000-0000-4000-8000-000000000001',
  'f7000000-0000-4000-8000-000000000001',
  'f7100000-0000-4000-8000-000000000001',
  'runtime/provider-guard/logo.png',
  'image/png',
  1,
  1,
  1,
  repeat('d', 64),
  'licensed_provider',
  'Runtime provider license.',
  'clean',
  'runtime/provider-guard/logo-processed.png',
  now(),
  'approved'
);

update public.businesses
set logo_asset_id = 'f7300000-0000-4000-8000-000000000001'
where id = 'f7100000-0000-4000-8000-000000000001';

update public.businesses
set state = 'published'
where id = 'f7100000-0000-4000-8000-000000000001';

insert into private.provider_location_sources (
  provider_slug,
  business_external_id,
  location_external_id,
  materialized_location_id,
  source_status,
  source_updated_at,
  source_url,
  license_agreement_id,
  normalized_payload,
  normalized_payload_hash,
  inactive_at
)
values
  (
    'runtime_guard_a',
    'runtime-business-main',
    'runtime-location-valid',
    'f7200000-0000-4000-8000-000000000001',
    'active',
    now(),
    null,
    'runtime-license-a',
    '{"externalId":"runtime-location-valid"}'::jsonb,
    repeat('e', 64),
    null
  ),
  (
    'runtime_guard_a',
    'runtime-business-main',
    'runtime-location-inactive',
    'f7200000-0000-4000-8000-000000000002',
    'inactive',
    now(),
    null,
    'runtime-license-a',
    '{"externalId":"runtime-location-inactive"}'::jsonb,
    repeat('f', 64),
    now()
  ),
  (
    'runtime_guard_b',
    'runtime-business-null-parent',
    'runtime-location-null-parent',
    'f7200000-0000-4000-8000-000000000003',
    'active',
    now(),
    null,
    'runtime-license-b',
    '{"externalId":"runtime-location-null-parent"}'::jsonb,
    repeat('1', 64),
    null
  ),
  (
    'runtime_guard_c',
    'runtime-business-mismatched-parent',
    'runtime-location-mismatched-parent',
    'f7200000-0000-4000-8000-000000000004',
    'active',
    now(),
    null,
    'runtime-license-c',
    '{"externalId":"runtime-location-mismatched-parent"}'::jsonb,
    repeat('2', 64),
    null
  );

do $provider_location_lifecycle_guard$
begin
  if not private.is_business_publicly_eligible(
    'f7100000-0000-4000-8000-000000000001'
  ) then
    raise exception 'Second active source did not keep the fixture business eligible';
  end if;

  if not private.is_business_location_publicly_eligible(
    'f7200000-0000-4000-8000-000000000001'
  ) then
    raise exception 'Valid active provider child was rejected';
  end if;

  if private.is_business_location_publicly_eligible(
    'f7200000-0000-4000-8000-000000000002'
  ) then
    raise exception 'Inactive provider child remained eligible';
  end if;

  if private.is_business_location_publicly_eligible(
    'f7200000-0000-4000-8000-000000000003'
  ) then
    raise exception 'Child with null parent business was treated as manual';
  end if;

  if private.is_business_location_publicly_eligible(
    'f7200000-0000-4000-8000-000000000004'
  ) then
    raise exception 'Child with mismatched parent business was treated as manual';
  end if;

  delete from private.provider_location_sources
  where provider_slug = 'runtime_guard_b'
    and business_external_id = 'runtime-business-null-parent'
    and location_external_id = 'runtime-location-null-parent';

  if not private.is_business_location_publicly_eligible(
    'f7200000-0000-4000-8000-000000000003'
  ) then
    raise exception 'Deleting the provider child did not restore manual eligibility';
  end if;
end;
$provider_location_lifecycle_guard$;

rollback;
select 'provider location lifecycle guard runtime passed' as result;
