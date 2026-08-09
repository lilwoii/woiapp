-- Spottr licensed-provider transactional ingest boundary.
--
-- Prerequisite: the private provider source/receipt/snapshot tables from the
-- reviewed baseline schema. This migration deliberately creates draft/private
-- materializations only; publication remains a separate staff-reviewed action.

do $prerequisites$
begin
  if to_regclass('private.provider_accounts') is null
    or to_regclass('private.provider_ingest_receipts') is null
    or to_regclass('private.provider_ingest_batches') is null
    or to_regclass('private.provider_business_sources') is null
    or to_regclass('private.provider_location_sources') is null
    or to_regclass('private.provider_menu_section_sources') is null
    or to_regclass('private.provider_menu_item_sources') is null
    or to_regclass('private.provider_source_history') is null
    or to_regclass('private.provider_snapshot_sessions') is null
    or to_regclass('private.provider_snapshot_seen') is null
    or to_regclass('private.provider_field_materializations') is null
    or to_regclass('private.provider_ingest_audit_events') is null
    or to_regclass('public.businesses') is null
    or to_regclass('public.business_private_details') is null
    or to_regclass('public.business_members') is null
    or to_regclass('public.business_locations') is null
    or to_regclass('public.weekly_hours') is null
    or to_regclass('public.special_hours') is null
    or to_regclass('public.business_payments') is null
    or to_regclass('public.menu_sections') is null
    or to_regclass('public.menu_items') is null
    or to_regclass('public.provider_links') is null
  then
    raise exception using
      errcode = '55000',
      message = 'PROVIDER_INGEST_PREREQUISITES_MISSING';
  end if;
end;
$prerequisites$;

create or replace function private.provider_signing_key_ids_valid(candidate text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select cardinality(candidate) between 1 and 8
    and count(*) = count(key_id)
    and count(*) = count(distinct key_id)
    and coalesce(
      bool_and(key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
      false
    )
  from unnest(candidate) key_id;
$$;

revoke all on function private.provider_signing_key_ids_valid(text[]) from public;

create or replace function private.provider_jsonb_exact_keys(
  candidate jsonb,
  required_keys text[],
  optional_keys text[] default '{}'::text[]
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(candidate) = 'object'
    and not exists (
      select 1
      from unnest(required_keys) required_key
      where not candidate ? required_key
    )
    and not exists (
      select 1
      from jsonb_object_keys(candidate) supplied_key
      where not supplied_key = any(required_keys || optional_keys)
    );
$$;

create or replace function private.provider_jsonb_text_valid(
  candidate jsonb,
  minimum_length integer,
  maximum_length integer,
  required_pattern text default null
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  value text;
  unsafe_code_point integer;
begin
  if jsonb_typeof(candidate) <> 'string' then
    return false;
  end if;
  value := candidate #>> '{}';
  if value <> btrim(value)
    or char_length(value) not between minimum_length and maximum_length
    or (required_pattern is not null and value !~ required_pattern)
  then
    return false;
  end if;

  -- Match the Edge contract exactly: tabs, line feeds, and carriage returns are
  -- permitted, while other C0/DEL controls and bidi override/isolate markers
  -- are rejected. PostgreSQL text cannot contain NUL or surrogate code points.
  foreach unsafe_code_point in array array[
    1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22,
    23, 24, 25, 26, 27, 28, 29, 30, 31, 127,
    8234, 8235, 8236, 8237, 8238, 8294, 8295, 8296, 8297
  ]
  loop
    if position(pg_catalog.chr(unsafe_code_point) in value) > 0 then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

create or replace function private.provider_jsonb_integer_valid(
  candidate jsonb,
  minimum_value numeric,
  maximum_value numeric
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(candidate) = 'number'
    and (candidate #>> '{}')::numeric = trunc((candidate #>> '{}')::numeric)
    and (candidate #>> '{}')::numeric between minimum_value and maximum_value;
$$;

create or replace function private.provider_https_url_valid(candidate jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  value text;
  authority text;
begin
  if not private.provider_jsonb_text_valid(candidate, 1, 2048, '^https://') then
    return false;
  end if;
  value := candidate #>> '{}';
  if value ~ '[#[:space:]]' then
    return false;
  end if;
  authority := split_part(split_part(substr(value, 9), '/', 1), '?', 1);
  return authority ~ '^[A-Za-z0-9]'
    and position('@' in authority) = 0;
end;
$$;

create or replace function private.provider_payload_hash(candidate jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(candidate::text, 'sha256'), 'hex');
$$;

create or replace function private.validate_licensed_provider_payload(
  request_payload jsonb,
  expected_provider text,
  expected_batch_id text,
  licensed_field_classes text[]
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  now_value timestamptz := clock_timestamp();
  generated_at_value timestamptz;
  generated_at_text text;
  record_value jsonb;
  record_updated_at timestamptz;
  record_updated_text text;
  record_status text;
  location_value jsonb;
  schedule_value jsonb;
  menu_value jsonb;
  section_value jsonb;
  item_value jsonb;
  row_status text;
  row_date date;
  row_date_text text;
  row_count integer;
  distinct_count integer;
  primary_count integer;
  menu_item_count integer := 0;
  latitude_value numeric;
  longitude_value numeric;
begin
  if request_payload is null
    or octet_length(request_payload::text) > 524288
    or not private.provider_jsonb_exact_keys(
      request_payload,
      array['schemaVersion', 'provider', 'batchId', 'generatedAt', 'sync', 'records']
    )
    or request_payload->>'schemaVersion' <> '2026-07-30'
    or request_payload->>'provider' <> expected_provider
    or request_payload->>'batchId' <> expected_batch_id
    or not private.provider_jsonb_text_valid(
      request_payload->'provider', 2, 40, '^[a-z0-9][a-z0-9_-]{1,39}$'
    )
    or not private.provider_jsonb_text_valid(
      request_payload->'batchId', 16, 128, '^[A-Za-z0-9._:-]{16,128}$'
    )
    or not private.provider_jsonb_text_valid(
      request_payload->'generatedAt',
      24,
      24,
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    )
    or jsonb_typeof(request_payload->'records') <> 'array'
    or jsonb_array_length(request_payload->'records') not between 1 and 100
  then
    raise exception using errcode = '22023', message = 'PROVIDER_INVALID_PAYLOAD';
  end if;

  begin
    generated_at_text := request_payload->>'generatedAt';
    generated_at_value := generated_at_text::timestamptz;
  exception when others then
    raise exception using errcode = '22023', message = 'PROVIDER_INVALID_GENERATED_AT';
  end;
  if to_char(generated_at_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      <> generated_at_text
    or generated_at_value < now_value - interval '24 hours'
    or generated_at_value > now_value + interval '5 minutes'
  then
    raise exception using errcode = '22023', message = 'PROVIDER_INVALID_GENERATED_AT';
  end if;

  if not (
    array['profile', 'locations', 'hours', 'payments']::text[]
      <@ licensed_field_classes
  ) then
    raise exception using errcode = '55000', message = 'PROVIDER_FIELD_LICENSE_INCOMPLETE';
  end if;

  if jsonb_typeof(request_payload->'sync') <> 'object' then
    raise exception using errcode = '22023', message = 'PROVIDER_INVALID_SYNC';
  end if;
  if request_payload#>>'{sync,mode}' = 'delta' then
    if not private.provider_jsonb_exact_keys(request_payload->'sync', array['mode']) then
      raise exception using errcode = '22023', message = 'PROVIDER_INVALID_SYNC';
    end if;
  elsif request_payload#>>'{sync,mode}' = 'snapshot' then
    if not private.provider_jsonb_exact_keys(
      request_payload->'sync',
      array['mode', 'snapshotId', 'pageIndex', 'finalPage']
    )
      or not private.provider_jsonb_text_valid(
        request_payload#>'{sync,snapshotId}',
        16,
        128,
        '^[A-Za-z0-9._:-]{16,128}$'
      )
      or not private.provider_jsonb_integer_valid(
        request_payload#>'{sync,pageIndex}', 0, 100000
      )
      or jsonb_typeof(request_payload#>'{sync,finalPage}') <> 'boolean'
    then
      raise exception using errcode = '22023', message = 'PROVIDER_INVALID_SYNC';
    end if;
  else
    raise exception using errcode = '22023', message = 'PROVIDER_INVALID_SYNC';
  end if;

  select count(*), count(distinct entry->>'externalId')
  into row_count, distinct_count
  from jsonb_array_elements(request_payload->'records') entry;
  if row_count <> distinct_count then
    raise exception using errcode = '22023', message = 'PROVIDER_DUPLICATE_EXTERNAL_ID';
  end if;

  for record_value in
    select entry
    from jsonb_array_elements(request_payload->'records') entry
  loop
    if jsonb_typeof(record_value) <> 'object'
      or not private.provider_jsonb_text_valid(
        record_value->'externalId',
        1,
        128,
        '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
      )
      or not private.provider_jsonb_text_valid(
        record_value->'updatedAt',
        24,
        24,
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      )
    then
      raise exception using errcode = '22023', message = 'PROVIDER_INVALID_RECORD';
    end if;

    begin
      record_updated_text := record_value->>'updatedAt';
      record_updated_at := record_updated_text::timestamptz;
    exception when others then
      raise exception using errcode = '22023', message = 'PROVIDER_INVALID_RECORD_TIMESTAMP';
    end;
    if to_char(record_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        <> record_updated_text
      or record_updated_at > generated_at_value + interval '5 minutes'
      or record_updated_at > now_value + interval '5 minutes'
      or record_updated_at < now_value - interval '2 years'
    then
      raise exception using errcode = '22023', message = 'PROVIDER_INVALID_RECORD_TIMESTAMP';
    end if;

    record_status := record_value->>'status';
    if record_status = 'inactive' then
      if not private.provider_jsonb_exact_keys(
        record_value,
        array['externalId', 'status', 'updatedAt'],
        array['inactiveReason']
      )
        or (
          record_value ? 'inactiveReason'
          and (
            not private.provider_jsonb_text_valid(record_value->'inactiveReason', 1, 40)
            or record_value->>'inactiveReason' not in (
              'closed', 'removed_by_provider', 'duplicate', 'unknown'
            )
          )
        )
      then
        raise exception using errcode = '22023', message = 'PROVIDER_INVALID_INACTIVE_RECORD';
      end if;
      continue;
    end if;

    if record_status is distinct from 'active'
      or not private.provider_jsonb_exact_keys(
        record_value,
        array[
          'externalId', 'status', 'updatedAt', 'name', 'kind', 'description',
          'cuisineLabels', 'priceLevel', 'timezone', 'payments', 'locations',
          'weeklyHours', 'specialHours'
        ],
        array['websiteUrl', 'phone', 'sourceUrl', 'menu']
      )
      or not private.provider_jsonb_text_valid(record_value->'name', 1, 100)
      or not private.provider_jsonb_text_valid(record_value->'kind', 1, 30)
      or record_value->>'kind' not in (
          'food_truck', 'restaurant', 'pop_up', 'cafe_bakery'
        )
      or not private.provider_jsonb_text_valid(record_value->'description', 0, 2000)
      or not private.provider_jsonb_integer_valid(record_value->'priceLevel', 1, 4)
      or not private.provider_jsonb_text_valid(record_value->'timezone', 1, 80)
      or not exists (
        select 1
        from pg_catalog.pg_timezone_names zone
        where zone.name = record_value->>'timezone'
      )
    then
      raise exception using errcode = '22023', message = 'PROVIDER_INVALID_ACTIVE_RECORD';
    end if;

    if (record_value ? 'websiteUrl' or record_value ? 'phone')
      and not ('contact' = any(licensed_field_classes))
    then
      raise exception using errcode = '22023', message = 'PROVIDER_FIELD_NOT_LICENSED';
    end if;
    if record_value ? 'sourceUrl'
      and not ('source_url' = any(licensed_field_classes))
    then
      raise exception using errcode = '22023', message = 'PROVIDER_FIELD_NOT_LICENSED';
    end if;
    if record_value ? 'menu' and not ('menu' = any(licensed_field_classes)) then
      raise exception using errcode = '22023', message = 'PROVIDER_FIELD_NOT_LICENSED';
    end if;
    if record_value ? 'websiteUrl'
      and not private.provider_https_url_valid(record_value->'websiteUrl')
    then
      raise exception using errcode = '22023', message = 'PROVIDER_INVALID_URL';
    end if;
    if record_value ? 'sourceUrl'
      and not private.provider_https_url_valid(record_value->'sourceUrl')
    then
      raise exception using errcode = '22023', message = 'PROVIDER_INVALID_URL';
    end if;
    if record_value ? 'phone'
      and not private.provider_jsonb_text_valid(
        record_value->'phone',
        6,
        40,
        '^\+?\(?[0-9][0-9 ()-]{5,30}( ?(x|ext\.?) ?[0-9]{1,8})?$'
      )
    then
      raise exception using errcode = '22023', message = 'PROVIDER_INVALID_PHONE';
    end if;

    if jsonb_typeof(record_value->'cuisineLabels') <> 'array'
      or jsonb_array_length(record_value->'cuisineLabels') > 12
      or exists (
        select 1
        from jsonb_array_elements(record_value->'cuisineLabels') label
        where not private.provider_jsonb_text_valid(label, 1, 60)
      )
      or (
        select count(*) <> count(distinct label #>> '{}')
        from jsonb_array_elements(record_value->'cuisineLabels') label
      )
    then
      raise exception using errcode = '22023', message = 'PROVIDER_INVALID_CUISINES';
    end if;

    if jsonb_typeof(record_value->'payments') <> 'array'
      or jsonb_array_length(record_value->'payments') > 8
      or exists (
        select 1
        from jsonb_array_elements(record_value->'payments') payment
        where jsonb_typeof(payment) <> 'string'
          or payment #>> '{}' not in (
            'cash', 'visa', 'mastercard', 'amex', 'apple_pay', 'google_pay',
            'cash_app', 'venmo'
          )
      )
      or (
        select count(*) <> count(distinct payment #>> '{}')
        from jsonb_array_elements(record_value->'payments') payment
      )
    then
      raise exception using errcode = '22023', message = 'PROVIDER_INVALID_PAYMENTS';
    end if;

    if jsonb_typeof(record_value->'locations') <> 'array'
      or jsonb_array_length(record_value->'locations') not between 1 and 30
    then
      raise exception using errcode = '22023', message = 'PROVIDER_INVALID_LOCATIONS';
    end if;
    select
      count(*),
      count(distinct location->>'externalId'),
      count(*) filter (where location->>'isPrimary' = 'true')
    into row_count, distinct_count, primary_count
    from jsonb_array_elements(record_value->'locations') location;
    if row_count <> distinct_count or primary_count <> 1 then
      raise exception using errcode = '22023', message = 'PROVIDER_INVALID_LOCATIONS';
    end if;
    for location_value in
      select location
      from jsonb_array_elements(record_value->'locations') location
    loop
      if not private.provider_jsonb_exact_keys(
        location_value,
        array[
          'externalId', 'label', 'city', 'region', 'countryCode', 'latitude',
          'longitude', 'isPrimary', 'isApproximate', 'publicAddress'
        ],
        array['addressLine', 'postalCode']
      )
        or not private.provider_jsonb_text_valid(
          location_value->'externalId',
          1,
          128,
          '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
        )
        or not private.provider_jsonb_text_valid(location_value->'label', 1, 120)
        or not private.provider_jsonb_text_valid(location_value->'city', 1, 120)
        or not private.provider_jsonb_text_valid(location_value->'region', 1, 80)
        or not private.provider_jsonb_text_valid(
          location_value->'countryCode', 2, 2, '^[A-Z]{2}$'
        )
        or jsonb_typeof(location_value->'latitude') <> 'number'
        or jsonb_typeof(location_value->'longitude') <> 'number'
        or jsonb_typeof(location_value->'isPrimary') <> 'boolean'
        or jsonb_typeof(location_value->'isApproximate') <> 'boolean'
        or jsonb_typeof(location_value->'publicAddress') <> 'boolean'
        or (
          location_value ? 'addressLine'
          and not private.provider_jsonb_text_valid(location_value->'addressLine', 1, 300)
        )
        or (
          location_value ? 'postalCode'
          and not private.provider_jsonb_text_valid(location_value->'postalCode', 1, 24)
        )
      then
        raise exception using errcode = '22023', message = 'PROVIDER_INVALID_LOCATION';
      end if;
      latitude_value := (location_value->>'latitude')::numeric;
      longitude_value := (location_value->>'longitude')::numeric;
      if latitude_value not between -90 and 90
        or longitude_value not between -180 and 180
        or (latitude_value = 0 and longitude_value = 0)
      then
        raise exception using errcode = '22023', message = 'PROVIDER_INVALID_LOCATION';
      end if;
    end loop;

    if jsonb_typeof(record_value->'weeklyHours') <> 'array'
      or jsonb_array_length(record_value->'weeklyHours') <> 7
      or (
        select count(*) <> count(distinct schedule->>'weekday')
        from jsonb_array_elements(record_value->'weeklyHours') schedule
      )
    then
      raise exception using errcode = '22023', message = 'PROVIDER_INVALID_WEEKLY_HOURS';
    end if;
    for schedule_value in
      select schedule
      from jsonb_array_elements(record_value->'weeklyHours') schedule
    loop
      row_status := schedule_value->>'status';
      if not private.provider_jsonb_integer_valid(schedule_value->'weekday', 0, 6)
        or (
          row_status in ('closed', 'open_24_hours')
          and not private.provider_jsonb_exact_keys(
            schedule_value, array['weekday', 'status']
          )
        )
        or (
          row_status = 'open'
          and (
            not private.provider_jsonb_exact_keys(
              schedule_value, array['weekday', 'status', 'opensAt', 'closesAt']
            )
            or not private.provider_jsonb_text_valid(
              schedule_value->'opensAt', 5, 5, '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            )
            or not private.provider_jsonb_text_valid(
              schedule_value->'closesAt', 5, 5, '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            )
            or schedule_value->>'opensAt' = schedule_value->>'closesAt'
          )
        )
        or row_status is null
        or row_status not in ('closed', 'open_24_hours', 'open')
      then
        raise exception using errcode = '22023', message = 'PROVIDER_INVALID_WEEKLY_HOURS';
      end if;
    end loop;

    if jsonb_typeof(record_value->'specialHours') <> 'array'
      or jsonb_array_length(record_value->'specialHours') > 366
      or (
        select count(*) <> count(distinct schedule->>'serviceDate')
        from jsonb_array_elements(record_value->'specialHours') schedule
      )
    then
      raise exception using errcode = '22023', message = 'PROVIDER_INVALID_SPECIAL_HOURS';
    end if;
    for schedule_value in
      select schedule
      from jsonb_array_elements(record_value->'specialHours') schedule
    loop
      row_status := schedule_value->>'status';
      if not private.provider_jsonb_text_valid(
        schedule_value->'serviceDate', 10, 10, '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      )
        or (
          schedule_value ? 'note'
          and not private.provider_jsonb_text_valid(schedule_value->'note', 1, 240)
        )
        or (
          row_status in ('closed', 'open_24_hours')
          and not private.provider_jsonb_exact_keys(
            schedule_value,
            array['serviceDate', 'status'],
            array['note']
          )
        )
        or (
          row_status = 'open'
          and (
            not private.provider_jsonb_exact_keys(
              schedule_value,
              array['serviceDate', 'status', 'opensAt', 'closesAt'],
              array['note']
            )
            or not private.provider_jsonb_text_valid(
              schedule_value->'opensAt', 5, 5, '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            )
            or not private.provider_jsonb_text_valid(
              schedule_value->'closesAt', 5, 5, '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            )
            or schedule_value->>'opensAt' = schedule_value->>'closesAt'
          )
        )
        or row_status is null
        or row_status not in ('closed', 'open_24_hours', 'open')
      then
        raise exception using errcode = '22023', message = 'PROVIDER_INVALID_SPECIAL_HOURS';
      end if;
      begin
        row_date_text := schedule_value->>'serviceDate';
        row_date := row_date_text::date;
      exception when others then
        raise exception using errcode = '22023', message = 'PROVIDER_INVALID_SPECIAL_HOURS';
      end;
      if to_char(row_date, 'YYYY-MM-DD') <> row_date_text
        or row_date < (now_value at time zone 'UTC')::date - 30
        or row_date > (now_value at time zone 'UTC')::date + 400
      then
        raise exception using errcode = '22023', message = 'PROVIDER_INVALID_SPECIAL_HOURS';
      end if;
    end loop;

    if record_value ? 'menu' then
      menu_value := record_value->'menu';
      if not private.provider_jsonb_exact_keys(menu_value, array['mode', 'sections'])
        or menu_value->>'mode' is distinct from 'replace'
        or jsonb_typeof(menu_value->'sections') <> 'array'
        or jsonb_array_length(menu_value->'sections') > 50
        or (
          select count(*) <> count(distinct section->>'externalId')
          from jsonb_array_elements(menu_value->'sections') section
        )
      then
        raise exception using errcode = '22023', message = 'PROVIDER_INVALID_MENU';
      end if;
      menu_item_count := 0;
      for section_value in
        select section
        from jsonb_array_elements(menu_value->'sections') section
      loop
        if not private.provider_jsonb_exact_keys(
          section_value, array['externalId', 'name', 'sortOrder', 'items']
        )
          or not private.provider_jsonb_text_valid(
            section_value->'externalId',
            1,
            128,
            '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
          )
          or not private.provider_jsonb_text_valid(section_value->'name', 1, 80)
          or not private.provider_jsonb_integer_valid(section_value->'sortOrder', -10000, 10000)
          or jsonb_typeof(section_value->'items') <> 'array'
          or jsonb_array_length(section_value->'items') > 500
          or (
            select count(*) <> count(distinct item->>'externalId')
            from jsonb_array_elements(section_value->'items') item
          )
        then
          raise exception using errcode = '22023', message = 'PROVIDER_INVALID_MENU_SECTION';
        end if;
        menu_item_count := menu_item_count + jsonb_array_length(section_value->'items');
        if menu_item_count > 500 then
          raise exception using errcode = '22023', message = 'PROVIDER_INVALID_MENU';
        end if;
        for item_value in
          select item
          from jsonb_array_elements(section_value->'items') item
        loop
          if not private.provider_jsonb_exact_keys(
            item_value,
            array[
              'externalId', 'name', 'description', 'priceMinor', 'currency',
              'availability', 'dietaryTags', 'sortOrder'
            ],
            array['allergenNote']
          )
            or not private.provider_jsonb_text_valid(
              item_value->'externalId',
              1,
              128,
              '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
            )
            or not private.provider_jsonb_text_valid(item_value->'name', 1, 120)
            or not private.provider_jsonb_text_valid(item_value->'description', 0, 1000)
            or not private.provider_jsonb_integer_valid(item_value->'priceMinor', 0, 100000000)
            or not private.provider_jsonb_text_valid(
              item_value->'currency', 3, 3, '^[A-Z]{3}$'
            )
            or jsonb_typeof(item_value->'availability') <> 'string'
            or item_value->>'availability' not in ('available', 'sold_out', 'hidden')
            or not private.provider_jsonb_integer_valid(item_value->'sortOrder', -10000, 10000)
            or (
              item_value ? 'allergenNote'
              and not private.provider_jsonb_text_valid(item_value->'allergenNote', 1, 500)
            )
            or jsonb_typeof(item_value->'dietaryTags') <> 'array'
            or jsonb_array_length(item_value->'dietaryTags') > 12
            or exists (
              select 1
              from jsonb_array_elements(item_value->'dietaryTags') tag
              where jsonb_typeof(tag) <> 'string'
                or tag #>> '{}' not in (
                  'dairy_free', 'gluten_aware', 'gluten_free', 'halal', 'kosher',
                  'nut_free', 'organic', 'spicy', 'vegan', 'vegetarian'
                )
            )
            or (
              select count(*) <> count(distinct tag #>> '{}')
              from jsonb_array_elements(item_value->'dietaryTags') tag
            )
          then
            raise exception using errcode = '22023', message = 'PROVIDER_INVALID_MENU_ITEM';
          end if;
        end loop;
      end loop;
    end if;
  end loop;
end;
$$;

revoke all on function private.provider_jsonb_exact_keys(jsonb, text[], text[]) from public;
revoke all on function private.provider_jsonb_text_valid(jsonb, integer, integer, text) from public;
revoke all on function private.provider_jsonb_integer_valid(jsonb, numeric, numeric) from public;
revoke all on function private.provider_https_url_valid(jsonb) from public;
revoke all on function private.provider_payload_hash(jsonb) from public;
revoke all on function private.validate_licensed_provider_payload(jsonb, text, text, text[]) from public;

create or replace function private.provider_current_field_hash(
  target_business_id uuid,
  target_field_name text
)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  current_value jsonb;
begin
  case target_field_name
    when 'name' then
      select to_jsonb(business.name)
      into current_value
      from public.businesses business
      where business.id = target_business_id;
    when 'kind' then
      select to_jsonb(business.kind)
      into current_value
      from public.businesses business
      where business.id = target_business_id;
    when 'description' then
      select to_jsonb(business.description)
      into current_value
      from public.businesses business
      where business.id = target_business_id;
    when 'cuisine_labels' then
      select to_jsonb(business.cuisine_labels)
      into current_value
      from public.businesses business
      where business.id = target_business_id;
    when 'price_level' then
      select to_jsonb(business.price_level)
      into current_value
      from public.businesses business
      where business.id = target_business_id;
    when 'timezone' then
      select to_jsonb(business.timezone)
      into current_value
      from public.businesses business
      where business.id = target_business_id;
    when 'website_url' then
      select to_jsonb(details.website_url)
      into current_value
      from public.business_private_details details
      where details.business_id = target_business_id;
      current_value := coalesce(current_value, 'null'::jsonb);
    when 'business_phone' then
      select to_jsonb(details.business_phone)
      into current_value
      from public.business_private_details details
      where details.business_id = target_business_id;
      current_value := coalesce(current_value, 'null'::jsonb);
    when 'locations' then
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', location.id,
            'label', location.label,
            'addressLine', location.address_line,
            'city', location.city,
            'region', location.region,
            'postalCode', location.postal_code,
            'longitude', public.st_x(location.point::public.geometry),
            'latitude', public.st_y(location.point::public.geometry),
            'isPrimary', location.is_primary,
            'isApproximate', location.is_approximate,
            'publicAddress', location.public_address,
            'publicationState', location.publication_state
          ) order by location.id
        ),
        '[]'::jsonb
      )
      into current_value
      from public.business_locations location
      where location.business_id = target_business_id;
    when 'weekly_hours' then
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'weekday', hours.weekday,
            'opensAt', hours.opens_at,
            'closesAt', hours.closes_at,
            'isClosed', hours.is_closed
          ) order by hours.weekday
        ),
        '[]'::jsonb
      )
      into current_value
      from public.weekly_hours hours
      where hours.business_id = target_business_id;
    when 'special_hours' then
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', hours.id,
            'serviceDate', hours.service_date,
            'opensAt', hours.opens_at,
            'closesAt', hours.closes_at,
            'isClosed', hours.is_closed,
            'note', hours.note
          ) order by hours.service_date, hours.id
        ),
        '[]'::jsonb
      )
      into current_value
      from public.special_hours hours
      where hours.business_id = target_business_id;
    when 'payments' then
      select coalesce(
        jsonb_agg(to_jsonb(payment.payment) order by payment.payment),
        '[]'::jsonb
      )
      into current_value
      from public.business_payments payment
      where payment.business_id = target_business_id;
    when 'menu' then
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', section.id,
            'name', section.name,
            'sortOrder', section.sort_order,
            'isPublished', section.is_published,
            'items', (
              select coalesce(
                jsonb_agg(
                  jsonb_build_object(
                    'id', item.id,
                    'name', item.name,
                    'description', item.description,
                    'priceMinor', item.price_minor,
                    'currency', item.currency,
                    'availability', item.availability,
                    'dietaryTags', item.dietary_tags,
                    'allergenNote', item.allergen_note,
                    'sortOrder', item.sort_order,
                    'isPublished', item.is_published
                  ) order by item.sort_order, item.id
                ),
                '[]'::jsonb
              )
              from public.menu_items item
              where item.section_id = section.id
            )
          ) order by section.sort_order, section.id
        ),
        '[]'::jsonb
      )
      into current_value
      from public.menu_sections section
      where section.business_id = target_business_id;
    else
      raise exception using errcode = '22023', message = 'PROVIDER_FIELD_NAME_INVALID';
  end case;

  if current_value is null then
    raise exception using errcode = '55000', message = 'PROVIDER_MATERIALIZATION_MISSING';
  end if;
  return private.provider_payload_hash(current_value);
end;
$$;

create or replace function private.provider_field_writable(
  target_business_id uuid,
  target_field_name text,
  target_provider_slug text,
  target_external_id text
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  business_state public.business_state;
  business_provenance text;
  field_row private.provider_field_materializations%rowtype;
  current_field_hash text;
begin
  select b.state, b.provenance
  into business_state, business_provenance
  from public.businesses b
  where b.id = target_business_id
  for update;
  if not found then
    return false;
  end if;

  select materialization.*
  into field_row
  from private.provider_field_materializations materialization
  where materialization.business_id = target_business_id
    and materialization.field_name = target_field_name
  for update;
  if not found then
    return false;
  end if;

  if business_state <> 'draft'
    or business_provenance <> 'licensed_provider'
    or exists (
      select 1
      from public.business_members member
      where member.business_id = target_business_id
        and member.status = 'active'
    )
  then
    if field_row.ownership = 'provider' then
      update private.provider_field_materializations materialization
      set ownership = 'owner',
          overridden_at = coalesce(materialization.overridden_at, clock_timestamp())
      where materialization.business_id = target_business_id
        and materialization.field_name = target_field_name;
    end if;
    return false;
  end if;

  if field_row.ownership <> 'provider'
    or field_row.source_provider_slug <> target_provider_slug
    or field_row.source_external_id <> target_external_id
  then
    return false;
  end if;

  current_field_hash := private.provider_current_field_hash(
    target_business_id,
    target_field_name
  );
  if current_field_hash <> field_row.materialized_value_hash then
    update private.provider_field_materializations materialization
    set ownership = 'owner',
        overridden_at = coalesce(materialization.overridden_at, clock_timestamp())
    where materialization.business_id = target_business_id
      and materialization.field_name = target_field_name;
    return false;
  end if;
  return true;
end;
$$;

create or replace function private.set_provider_field_materialization(
  target_business_id uuid,
  target_field_name text,
  target_provider_slug text,
  target_external_id text,
  normalized_source_value jsonb
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  source_hash text := private.provider_payload_hash(normalized_source_value);
  current_field_hash text;
begin
  current_field_hash := private.provider_current_field_hash(
    target_business_id,
    target_field_name
  );
  insert into private.provider_field_materializations (
    business_id,
    field_name,
    source_provider_slug,
    source_external_id,
    ownership,
    source_value_hash,
    materialized_value_hash,
    materialized_at,
    overridden_at
  ) values (
    target_business_id,
    target_field_name,
    target_provider_slug,
    target_external_id,
    'provider',
    source_hash,
    current_field_hash,
    clock_timestamp(),
    null
  )
  on conflict (business_id, field_name) do update
  set source_provider_slug = excluded.source_provider_slug,
      source_external_id = excluded.source_external_id,
      ownership = 'provider',
      source_value_hash = excluded.source_value_hash,
      materialized_value_hash = excluded.materialized_value_hash,
      materialized_at = excluded.materialized_at,
      overridden_at = null
  where private.provider_field_materializations.ownership = 'provider'
    and private.provider_field_materializations.source_provider_slug = target_provider_slug
    and private.provider_field_materializations.source_external_id = target_external_id;
end;
$$;

revoke all on function private.provider_current_field_hash(uuid, text) from public;
revoke all on function private.provider_field_writable(uuid, text, text, text) from public;
revoke all on function private.set_provider_field_materialization(uuid, text, text, text, jsonb) from public;

drop function if exists public.ingest_licensed_provider_batch(text, text, text, text, jsonb);

create function public.ingest_licensed_provider_batch(
  provider_slug text,
  signing_key_id text,
  idempotency_key text,
  request_sha256 text,
  request_payload jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '5s'
set statement_timeout = '30s'
as $$
#variable_conflict use_variable
declare
  provider_account private.provider_accounts%rowtype;
  snapshot_session private.provider_snapshot_sessions%rowtype;
  receipt_key_hash text;
  stored_request_hash text;
  stored_batch_id text;
  stored_receipt_status text;
  stored_safe_response jsonb;
  rate_count integer;
  rate_window_started_at timestamptz := date_trunc('minute', clock_timestamp());
  generated_at_value timestamptz;
  sync_mode text;
  sync_snapshot_id text;
  sync_page_index integer;
  sync_final_page boolean;
  accepted_records integer;
  inactive_records integer;
  batch_record_count integer;
  batch_uuid uuid;
  record_value jsonb;
  record_hash text;
  record_updated_at timestamptz;
  record_external_id text;
  record_status text;
  source_business_id uuid;
  source_updated_at timestamptz;
  source_hash text;
  source_exists boolean;
  new_business boolean;
  target_business_id uuid;
  target_slug text;
  cuisine_values text[];
  payment_values text[];
  dietary_values text[];
  source_url_value text;
  location_value jsonb;
  location_uuid uuid;
  schedule_value jsonb;
  section_value jsonb;
  section_uuid uuid;
  item_value jsonb;
  item_uuid uuid;
  can_materialize boolean;
  missing_source_count integer := 0;
  result_response jsonb;
begin
  if provider_slug is null
    or provider_slug !~ '^[a-z0-9][a-z0-9_-]{1,39}$'
    or signing_key_id is null
    or signing_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    or idempotency_key is null
    or idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
    or request_sha256 is null
    or request_sha256 !~ '^[0-9a-f]{64}$'
  then
    raise exception using errcode = '22023', message = 'PROVIDER_INVALID_ARGUMENT';
  end if;

  -- A provider-wide transaction lock prevents source ordering, snapshot pages,
  -- and materialization from interleaving across different idempotency keys.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('spottr:provider:' || provider_slug, 0)
  );

  select account.*
  into provider_account
  from private.provider_accounts account
  where account.provider_slug = ingest_licensed_provider_batch.provider_slug
  for update;
  if not found or not provider_account.enabled then
    raise exception using errcode = '55000', message = 'PROVIDER_NOT_ENABLED';
  end if;
  if current_date not between provider_account.license_effective_on
      and provider_account.license_expires_on
  then
    raise exception using errcode = '55000', message = 'PROVIDER_LICENSE_INACTIVE';
  end if;
  if not signing_key_id = any(provider_account.accepted_signing_key_ids) then
    raise exception using errcode = '28000', message = 'PROVIDER_KEY_NOT_ACCEPTED';
  end if;

  insert into private.provider_rate_limit_buckets (
    provider_slug,
    signing_key_id,
    window_started_at,
    request_count
  ) values (
    provider_slug,
    signing_key_id,
    rate_window_started_at,
    1
  )
  on conflict on constraint provider_rate_limit_buckets_pkey do update
  set request_count = private.provider_rate_limit_buckets.request_count + 1
  where private.provider_rate_limit_buckets.request_count
    < provider_account.requests_per_minute
  returning request_count into rate_count;
  if rate_count is null then
    raise exception using errcode = '54000', message = 'PROVIDER_RATE_LIMITED';
  end if;

  receipt_key_hash := encode(extensions.digest(idempotency_key, 'sha256'), 'hex');
  select
    receipt.request_sha256,
    receipt.batch_id,
    receipt.status,
    receipt.safe_response
  into
    stored_request_hash,
    stored_batch_id,
    stored_receipt_status,
    stored_safe_response
  from private.provider_ingest_receipts receipt
  where receipt.provider_slug = ingest_licensed_provider_batch.provider_slug
    and receipt.idempotency_key_hash = receipt_key_hash
  for update;

  if found then
    if stored_request_hash <> request_sha256
      or stored_batch_id <> idempotency_key
    then
      raise exception using errcode = '23505', message = 'PROVIDER_IDEMPOTENCY_CONFLICT';
    end if;
    if stored_receipt_status <> 'completed' or stored_safe_response is null then
      raise exception using errcode = '55000', message = 'PROVIDER_RECEIPT_INCOMPLETE';
    end if;
    insert into private.provider_ingest_audit_events (
      provider_slug,
      event_type,
      batch_id_hash,
      accepted_records,
      inactive_records,
      metadata
    ) values (
      provider_slug,
      'batch_replayed',
      encode(extensions.digest(idempotency_key, 'sha256'), 'hex'),
      (stored_safe_response->>'accepted_records')::integer,
      (stored_safe_response->>'inactive_records')::integer,
      '{}'::jsonb
    );
    return stored_safe_response || jsonb_build_object('status', 'replayed');
  end if;

  insert into private.provider_ingest_receipts (
    provider_slug,
    idempotency_key_hash,
    request_sha256,
    batch_id,
    status
  ) values (
    provider_slug,
    receipt_key_hash,
    request_sha256,
    idempotency_key,
    'processing'
  );

  perform private.validate_licensed_provider_payload(
    request_payload,
    provider_slug,
    idempotency_key,
    provider_account.allowed_field_classes
  );

  generated_at_value := (request_payload->>'generatedAt')::timestamptz;
  sync_mode := request_payload#>>'{sync,mode}';
  if sync_mode = 'snapshot' then
    sync_snapshot_id := request_payload#>>'{sync,snapshotId}';
    sync_page_index := (request_payload#>>'{sync,pageIndex}')::integer;
    sync_final_page := (request_payload#>>'{sync,finalPage}')::boolean;
  end if;
  select
    count(*) filter (where entry->>'status' = 'active'),
    count(*) filter (where entry->>'status' = 'inactive'),
    count(*)
  into accepted_records, inactive_records, batch_record_count
  from jsonb_array_elements(request_payload->'records') entry;

  if sync_mode = 'delta' then
    if exists (
      select 1
      from private.provider_snapshot_sessions session
      where session.provider_slug = ingest_licensed_provider_batch.provider_slug
        and not session.final_page_received
    ) then
      raise exception using errcode = '55000', message = 'PROVIDER_SNAPSHOT_IN_PROGRESS';
    end if;
  else
    if exists (
      select 1
      from private.provider_ingest_batches batch
      where batch.provider_slug = ingest_licensed_provider_batch.provider_slug
        and batch.snapshot_id = sync_snapshot_id
        and batch.page_index = sync_page_index
    ) then
      raise exception using errcode = '23505', message = 'PROVIDER_SNAPSHOT_PAGE_REUSED';
    end if;
    if exists (
      select 1
      from private.provider_snapshot_seen seen
      join jsonb_array_elements(request_payload->'records') entry
        on entry->>'externalId' = seen.provider_external_id
      where seen.provider_slug = ingest_licensed_provider_batch.provider_slug
        and seen.snapshot_id = sync_snapshot_id
    ) then
      raise exception using errcode = '23505', message = 'PROVIDER_SNAPSHOT_RECORD_REPEATED';
    end if;

    if sync_page_index = 0 then
      if exists (
        select 1
        from private.provider_snapshot_sessions open_session
        where open_session.provider_slug = ingest_licensed_provider_batch.provider_slug
          and not open_session.final_page_received
          and open_session.snapshot_id <> sync_snapshot_id
      ) then
        raise exception using errcode = '55000', message = 'PROVIDER_SNAPSHOT_IN_PROGRESS';
      end if;
      insert into private.provider_snapshot_sessions (
        provider_slug,
        snapshot_id,
        first_generated_at,
        last_generated_at,
        next_page_index
      ) values (
        provider_slug,
        sync_snapshot_id,
        generated_at_value,
        generated_at_value,
        0
      )
      on conflict on constraint provider_snapshot_sessions_pkey do nothing;
    end if;

    select session.*
    into snapshot_session
    from private.provider_snapshot_sessions session
    where session.provider_slug = ingest_licensed_provider_batch.provider_slug
      and session.snapshot_id = sync_snapshot_id
    for update;
    if not found
      or snapshot_session.final_page_received
      or snapshot_session.next_page_index <> sync_page_index
      or generated_at_value < snapshot_session.last_generated_at
    then
      raise exception using errcode = '55000', message = 'PROVIDER_SNAPSHOT_SEQUENCE_INVALID';
    end if;
  end if;

  insert into private.provider_ingest_batches (
    provider_slug,
    receipt_key_hash,
    signing_key_id,
    batch_id,
    request_sha256,
    generated_at,
    sync_mode,
    snapshot_id,
    page_index,
    final_page,
    accepted_records,
    inactive_records
  ) values (
    provider_slug,
    receipt_key_hash,
    signing_key_id,
    idempotency_key,
    request_sha256,
    generated_at_value,
    sync_mode,
    sync_snapshot_id,
    sync_page_index,
    sync_final_page,
    accepted_records,
    inactive_records
  )
  returning id into batch_uuid;

  for record_value in
    select entry
    from jsonb_array_elements(request_payload->'records') entry
  loop
    record_external_id := record_value->>'externalId';
    record_status := record_value->>'status';
    record_updated_at := (record_value->>'updatedAt')::timestamptz;
    record_hash := private.provider_payload_hash(record_value);
    source_url_value := nullif(record_value->>'sourceUrl', '');

    select source.business_id, source.source_updated_at, source.normalized_payload_hash
    into source_business_id, source_updated_at, source_hash
    from private.provider_business_sources source
    where source.provider_slug = ingest_licensed_provider_batch.provider_slug
      and source.provider_external_id = record_external_id
    for update;
    source_exists := found;
    if source_exists and record_updated_at < source_updated_at then
      raise exception using errcode = '22023', message = 'PROVIDER_STALE_SOURCE_UPDATE';
    end if;
    if source_exists
      and record_updated_at = source_updated_at
      and record_hash <> source_hash
    then
      raise exception using errcode = '22023', message = 'PROVIDER_SOURCE_TIMESTAMP_CONFLICT';
    end if;

    target_business_id := source_business_id;
    new_business := false;
    if record_status = 'active' and target_business_id is null then
      select coalesce(array_agg(label #>> '{}' order by ordinal), '{}'::text[])
      into cuisine_values
      from jsonb_array_elements(record_value->'cuisineLabels')
        with ordinality labels(label, ordinal);
      target_slug := 'provider-'
        || replace(provider_slug, '_', '-')
        || '-'
        || encode(extensions.digest(record_external_id, 'sha256'), 'hex');
      insert into public.businesses (
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
        provider_freshness_at,
        created_by
      ) values (
        (record_value->>'kind')::public.business_kind,
        record_value->>'name',
        target_slug,
        record_value->>'description',
        cuisine_values,
        (record_value->>'priceLevel')::smallint,
        'draft',
        'unverified',
        record_value->>'timezone',
        'licensed_provider',
        record_updated_at,
        null
      )
      returning id into target_business_id;
      new_business := true;
    end if;

    insert into private.provider_business_sources (
      provider_slug,
      provider_external_id,
      business_id,
      source_status,
      source_updated_at,
      first_seen_at,
      last_seen_at,
      missing_since,
      inactive_at,
      source_url,
      license_agreement_id,
      normalized_payload_hash,
      inactive_reason
    ) values (
      provider_slug,
      record_external_id,
      target_business_id,
      record_status,
      record_updated_at,
      clock_timestamp(),
      clock_timestamp(),
      null,
      case when record_status = 'inactive' then clock_timestamp() else null end,
      source_url_value,
      provider_account.license_agreement_id,
      record_hash,
      nullif(record_value->>'inactiveReason', '')
    )
    on conflict on constraint provider_business_sources_pkey do update
    set business_id = coalesce(
          private.provider_business_sources.business_id,
          excluded.business_id
        ),
        source_status = excluded.source_status,
        source_updated_at = excluded.source_updated_at,
        last_seen_at = excluded.last_seen_at,
        missing_since = null,
        inactive_at = excluded.inactive_at,
        source_url = excluded.source_url,
        license_agreement_id = excluded.license_agreement_id,
        normalized_payload_hash = excluded.normalized_payload_hash,
        inactive_reason = excluded.inactive_reason;

    insert into private.provider_source_history (
      ingest_batch_id,
      provider_slug,
      provider_external_id,
      source_updated_at,
      record_status,
      normalized_payload,
      normalized_payload_hash,
      license_agreement_id
    ) values (
      batch_uuid,
      provider_slug,
      record_external_id,
      record_updated_at,
      record_status,
      record_value,
      record_hash,
      provider_account.license_agreement_id
    )
    on conflict do nothing;

    if sync_mode = 'snapshot' then
      insert into private.provider_snapshot_seen (
        provider_slug,
        snapshot_id,
        provider_external_id,
        first_seen_page
      ) values (
        provider_slug,
        sync_snapshot_id,
        record_external_id,
        sync_page_index
      );
    end if;

    if target_business_id is not null then
      insert into public.provider_links (
        business_id,
        provider,
        provider_place_id,
        last_fetched_at
      ) values (
        target_business_id,
        provider_slug,
        record_external_id,
        record_updated_at
      )
      on conflict (provider, provider_place_id) do update
      set business_id = excluded.business_id,
          last_fetched_at = excluded.last_fetched_at;
    end if;

    if record_status = 'inactive' then
      update private.provider_location_sources child
      set source_status = 'inactive',
          missing_since = null,
          inactive_at = clock_timestamp()
      where child.provider_slug = ingest_licensed_provider_batch.provider_slug
        and child.business_external_id = record_external_id;
      update private.provider_menu_section_sources child
      set source_status = 'inactive',
          missing_since = null,
          inactive_at = clock_timestamp()
      where child.provider_slug = ingest_licensed_provider_batch.provider_slug
        and child.business_external_id = record_external_id;
      update private.provider_menu_item_sources child
      set source_status = 'inactive',
          missing_since = null,
          inactive_at = clock_timestamp()
      where child.provider_slug = ingest_licensed_provider_batch.provider_slug
        and child.business_external_id = record_external_id;
      continue;
    end if;

    if not new_business then
      update public.businesses business
      set provider_freshness_at = greatest(
            coalesce(business.provider_freshness_at, '-infinity'::timestamptz),
            record_updated_at
          )
      where business.id = target_business_id;
    end if;

    select coalesce(array_agg(label #>> '{}' order by ordinal), '{}'::text[])
    into cuisine_values
    from jsonb_array_elements(record_value->'cuisineLabels')
      with ordinality labels(label, ordinal);

    if new_business
      or private.provider_field_writable(
        target_business_id, 'name', provider_slug, record_external_id
      )
    then
      update public.businesses set name = record_value->>'name'
      where id = target_business_id;
      perform private.set_provider_field_materialization(
        target_business_id, 'name', provider_slug, record_external_id,
        record_value->'name'
      );
    end if;
    if new_business
      or private.provider_field_writable(
        target_business_id, 'kind', provider_slug, record_external_id
      )
    then
      update public.businesses set kind = (record_value->>'kind')::public.business_kind
      where id = target_business_id;
      perform private.set_provider_field_materialization(
        target_business_id, 'kind', provider_slug, record_external_id,
        record_value->'kind'
      );
    end if;
    if new_business
      or private.provider_field_writable(
        target_business_id, 'description', provider_slug, record_external_id
      )
    then
      update public.businesses set description = record_value->>'description'
      where id = target_business_id;
      perform private.set_provider_field_materialization(
        target_business_id, 'description', provider_slug, record_external_id,
        record_value->'description'
      );
    end if;
    if new_business
      or private.provider_field_writable(
        target_business_id, 'cuisine_labels', provider_slug, record_external_id
      )
    then
      update public.businesses set cuisine_labels = cuisine_values
      where id = target_business_id;
      perform private.set_provider_field_materialization(
        target_business_id, 'cuisine_labels', provider_slug, record_external_id,
        record_value->'cuisineLabels'
      );
    end if;
    if new_business
      or private.provider_field_writable(
        target_business_id, 'price_level', provider_slug, record_external_id
      )
    then
      update public.businesses
      set price_level = (record_value->>'priceLevel')::smallint
      where id = target_business_id;
      perform private.set_provider_field_materialization(
        target_business_id, 'price_level', provider_slug, record_external_id,
        record_value->'priceLevel'
      );
    end if;
    if new_business
      or private.provider_field_writable(
        target_business_id, 'timezone', provider_slug, record_external_id
      )
    then
      update public.businesses set timezone = record_value->>'timezone'
      where id = target_business_id;
      perform private.set_provider_field_materialization(
        target_business_id, 'timezone', provider_slug, record_external_id,
        record_value->'timezone'
      );
    end if;

    if 'contact' = any(provider_account.allowed_field_classes) then
      if new_business
        or private.provider_field_writable(
          target_business_id, 'website_url', provider_slug, record_external_id
        )
      then
        insert into public.business_private_details (business_id)
        values (target_business_id)
        on conflict (business_id) do nothing;
        update public.business_private_details
        set website_url = nullif(record_value->>'websiteUrl', ''),
            show_website_public = false,
            updated_at = clock_timestamp()
        where business_id = target_business_id;
        perform private.set_provider_field_materialization(
          target_business_id, 'website_url', provider_slug, record_external_id,
          coalesce(record_value->'websiteUrl', 'null'::jsonb)
        );
      end if;
      if new_business
        or private.provider_field_writable(
          target_business_id, 'business_phone', provider_slug, record_external_id
        )
      then
        insert into public.business_private_details (business_id)
        values (target_business_id)
        on conflict (business_id) do nothing;
        update public.business_private_details
        set business_phone = nullif(record_value->>'phone', ''),
            show_phone_public = false,
            updated_at = clock_timestamp()
        where business_id = target_business_id;
        perform private.set_provider_field_materialization(
          target_business_id, 'business_phone', provider_slug, record_external_id,
          coalesce(record_value->'phone', 'null'::jsonb)
        );
      end if;
    end if;

    can_materialize := new_business or private.provider_field_writable(
      target_business_id, 'locations', provider_slug, record_external_id
    );
    update private.provider_location_sources child
    set source_status = 'missing',
        missing_since = coalesce(child.missing_since, clock_timestamp()),
        inactive_at = null
    where child.provider_slug = ingest_licensed_provider_batch.provider_slug
      and child.business_external_id = record_external_id
      and not exists (
        select 1
        from jsonb_array_elements(record_value->'locations') supplied
        where supplied->>'externalId' = child.location_external_id
      );
    if can_materialize then
      update public.business_locations location
      set is_primary = false
      where location.business_id = target_business_id
        and location.publication_state <> 'archived';
      delete from public.business_locations location
      using private.provider_location_sources child
      where child.provider_slug = ingest_licensed_provider_batch.provider_slug
        and child.business_external_id = record_external_id
        and child.source_status = 'missing'
        and child.materialized_location_id = location.id
        and location.business_id = target_business_id;
    end if;

    for location_value in
      select supplied
      from jsonb_array_elements(record_value->'locations') supplied
    loop
      insert into private.provider_location_sources (
        provider_slug,
        business_external_id,
        location_external_id,
        source_status,
        source_updated_at,
        first_seen_at,
        last_seen_at,
        missing_since,
        inactive_at,
        source_url,
        license_agreement_id,
        normalized_payload,
        normalized_payload_hash
      ) values (
        provider_slug,
        record_external_id,
        location_value->>'externalId',
        'active',
        record_updated_at,
        clock_timestamp(),
        clock_timestamp(),
        null,
        null,
        source_url_value,
        provider_account.license_agreement_id,
        location_value,
        private.provider_payload_hash(location_value)
      )
      on conflict on constraint provider_location_sources_pkey do update
      set source_status = 'active',
          source_updated_at = excluded.source_updated_at,
          last_seen_at = excluded.last_seen_at,
          missing_since = null,
          inactive_at = null,
          source_url = excluded.source_url,
          license_agreement_id = excluded.license_agreement_id,
          normalized_payload = excluded.normalized_payload,
          normalized_payload_hash = excluded.normalized_payload_hash;

      if can_materialize then
        select child.materialized_location_id
        into location_uuid
        from private.provider_location_sources child
        where child.provider_slug = ingest_licensed_provider_batch.provider_slug
          and child.business_external_id = record_external_id
          and child.location_external_id = location_value->>'externalId'
        for update;
        if location_uuid is null
          or not exists (
            select 1
            from public.business_locations location
            where location.id = location_uuid
              and location.business_id = target_business_id
          )
        then
          insert into public.business_locations (
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
          ) values (
            target_business_id,
            location_value->>'label',
            nullif(location_value->>'addressLine', ''),
            location_value->>'city',
            location_value->>'region',
            nullif(location_value->>'postalCode', ''),
            public.st_setsrid(
              public.st_makepoint(
                (location_value->>'longitude')::double precision,
                (location_value->>'latitude')::double precision
              ),
              4326
            )::public.geography,
            (location_value->>'isPrimary')::boolean,
            (location_value->>'isApproximate')::boolean,
            (location_value->>'publicAddress')::boolean,
            'private'
          )
          returning id into location_uuid;
        else
          update public.business_locations
          set label = location_value->>'label',
              address_line = nullif(location_value->>'addressLine', ''),
              city = location_value->>'city',
              region = location_value->>'region',
              postal_code = nullif(location_value->>'postalCode', ''),
              point = public.st_setsrid(
                public.st_makepoint(
                  (location_value->>'longitude')::double precision,
                  (location_value->>'latitude')::double precision
                ),
                4326
              )::public.geography,
              is_primary = (location_value->>'isPrimary')::boolean,
              is_approximate = (location_value->>'isApproximate')::boolean,
              public_address = (location_value->>'publicAddress')::boolean,
              publication_state = 'private',
              updated_at = clock_timestamp()
          where id = location_uuid
            and business_id = target_business_id;
        end if;
        update private.provider_location_sources child
        set materialized_location_id = location_uuid
        where child.provider_slug = ingest_licensed_provider_batch.provider_slug
          and child.business_external_id = record_external_id
          and child.location_external_id = location_value->>'externalId';
      end if;
    end loop;
    if can_materialize then
      perform private.set_provider_field_materialization(
        target_business_id, 'locations', provider_slug, record_external_id,
        record_value->'locations'
      );
    end if;

    can_materialize := new_business or private.provider_field_writable(
      target_business_id, 'weekly_hours', provider_slug, record_external_id
    );
    if can_materialize then
      delete from public.weekly_hours hours
      where hours.business_id = target_business_id;
      for schedule_value in
        select supplied
        from jsonb_array_elements(record_value->'weeklyHours') supplied
      loop
        insert into public.weekly_hours (
          business_id,
          weekday,
          opens_at,
          closes_at,
          is_closed
        ) values (
          target_business_id,
          (schedule_value->>'weekday')::smallint,
          case
            when schedule_value->>'status' = 'open' then (schedule_value->>'opensAt')::time
            when schedule_value->>'status' = 'open_24_hours' then '00:00'::time
            else null
          end,
          case
            when schedule_value->>'status' = 'open' then (schedule_value->>'closesAt')::time
            when schedule_value->>'status' = 'open_24_hours' then '00:00'::time
            else null
          end,
          schedule_value->>'status' = 'closed'
        );
      end loop;
      perform private.set_provider_field_materialization(
        target_business_id, 'weekly_hours', provider_slug, record_external_id,
        record_value->'weeklyHours'
      );
    end if;

    can_materialize := new_business or private.provider_field_writable(
      target_business_id, 'special_hours', provider_slug, record_external_id
    );
    if can_materialize then
      delete from public.special_hours hours
      where hours.business_id = target_business_id;
      for schedule_value in
        select supplied
        from jsonb_array_elements(record_value->'specialHours') supplied
      loop
        insert into public.special_hours (
          business_id,
          service_date,
          opens_at,
          closes_at,
          is_closed,
          note
        ) values (
          target_business_id,
          (schedule_value->>'serviceDate')::date,
          case
            when schedule_value->>'status' = 'open' then (schedule_value->>'opensAt')::time
            when schedule_value->>'status' = 'open_24_hours' then '00:00'::time
            else null
          end,
          case
            when schedule_value->>'status' = 'open' then (schedule_value->>'closesAt')::time
            when schedule_value->>'status' = 'open_24_hours' then '00:00'::time
            else null
          end,
          schedule_value->>'status' = 'closed',
          nullif(schedule_value->>'note', '')
        );
      end loop;
      perform private.set_provider_field_materialization(
        target_business_id, 'special_hours', provider_slug, record_external_id,
        record_value->'specialHours'
      );
    end if;

    can_materialize := new_business or private.provider_field_writable(
      target_business_id, 'payments', provider_slug, record_external_id
    );
    if can_materialize then
      delete from public.business_payments payment
      where payment.business_id = target_business_id;
      select coalesce(array_agg(payment #>> '{}' order by ordinal), '{}'::text[])
      into payment_values
      from jsonb_array_elements(record_value->'payments')
        with ordinality payments(payment, ordinal);
      insert into public.business_payments (business_id, payment)
      select target_business_id, payment::public.payment_kind
      from unnest(payment_values) payment;
      perform private.set_provider_field_materialization(
        target_business_id, 'payments', provider_slug, record_external_id,
        record_value->'payments'
      );
    end if;

    if record_value ? 'menu' then
      update private.provider_menu_section_sources child
      set source_status = 'missing',
          missing_since = coalesce(child.missing_since, clock_timestamp()),
          inactive_at = null
      where child.provider_slug = ingest_licensed_provider_batch.provider_slug
        and child.business_external_id = record_external_id
        and not exists (
          select 1
          from jsonb_array_elements(record_value#>'{menu,sections}') supplied
          where supplied->>'externalId' = child.section_external_id
        );
      update private.provider_menu_item_sources child
      set source_status = 'missing',
          missing_since = coalesce(child.missing_since, clock_timestamp()),
          inactive_at = null
      where child.provider_slug = ingest_licensed_provider_batch.provider_slug
        and child.business_external_id = record_external_id
        and not exists (
          select 1
          from jsonb_array_elements(record_value#>'{menu,sections}') supplied_section
          cross join lateral jsonb_array_elements(supplied_section->'items') supplied_item
          where supplied_section->>'externalId' = child.section_external_id
            and supplied_item->>'externalId' = child.item_external_id
        );

      can_materialize := new_business or private.provider_field_writable(
        target_business_id, 'menu', provider_slug, record_external_id
      );
      if can_materialize then
        delete from public.menu_sections section
        where section.business_id = target_business_id;
      end if;

      for section_value in
        select supplied
        from jsonb_array_elements(record_value#>'{menu,sections}') supplied
      loop
        insert into private.provider_menu_section_sources (
          provider_slug,
          business_external_id,
          section_external_id,
          source_status,
          source_updated_at,
          first_seen_at,
          last_seen_at,
          missing_since,
          inactive_at,
          source_url,
          license_agreement_id,
          normalized_payload,
          normalized_payload_hash
        ) values (
          provider_slug,
          record_external_id,
          section_value->>'externalId',
          'active',
          record_updated_at,
          clock_timestamp(),
          clock_timestamp(),
          null,
          null,
          source_url_value,
          provider_account.license_agreement_id,
          section_value,
          private.provider_payload_hash(section_value)
        )
        on conflict on constraint provider_menu_section_sources_pkey do update
        set source_status = 'active',
            source_updated_at = excluded.source_updated_at,
            last_seen_at = excluded.last_seen_at,
            missing_since = null,
            inactive_at = null,
            source_url = excluded.source_url,
            license_agreement_id = excluded.license_agreement_id,
            normalized_payload = excluded.normalized_payload,
            normalized_payload_hash = excluded.normalized_payload_hash;

        section_uuid := null;
        if can_materialize then
          insert into public.menu_sections (
            business_id,
            name,
            sort_order,
            is_published
          ) values (
            target_business_id,
            section_value->>'name',
            (section_value->>'sortOrder')::integer,
            false
          )
          returning id into section_uuid;
          update private.provider_menu_section_sources child
          set materialized_section_id = section_uuid
          where child.provider_slug = ingest_licensed_provider_batch.provider_slug
            and child.business_external_id = record_external_id
            and child.section_external_id = section_value->>'externalId';
        end if;

        for item_value in
          select supplied
          from jsonb_array_elements(section_value->'items') supplied
        loop
          insert into private.provider_menu_item_sources (
            provider_slug,
            business_external_id,
            section_external_id,
            item_external_id,
            source_status,
            source_updated_at,
            first_seen_at,
            last_seen_at,
            missing_since,
            inactive_at,
            source_url,
            license_agreement_id,
            normalized_payload,
            normalized_payload_hash
          ) values (
            provider_slug,
            record_external_id,
            section_value->>'externalId',
            item_value->>'externalId',
            'active',
            record_updated_at,
            clock_timestamp(),
            clock_timestamp(),
            null,
            null,
            source_url_value,
            provider_account.license_agreement_id,
            item_value,
            private.provider_payload_hash(item_value)
          )
          on conflict on constraint provider_menu_item_sources_pkey do update
          set source_status = 'active',
              source_updated_at = excluded.source_updated_at,
              last_seen_at = excluded.last_seen_at,
              missing_since = null,
              inactive_at = null,
              source_url = excluded.source_url,
              license_agreement_id = excluded.license_agreement_id,
              normalized_payload = excluded.normalized_payload,
              normalized_payload_hash = excluded.normalized_payload_hash;

          if can_materialize then
            select coalesce(array_agg(tag #>> '{}' order by ordinal), '{}'::text[])
            into dietary_values
            from jsonb_array_elements(item_value->'dietaryTags')
              with ordinality tags(tag, ordinal);
            insert into public.menu_items (
              section_id,
              name,
              description,
              price_minor,
              currency,
              availability,
              dietary_tags,
              allergen_note,
              sort_order,
              is_published
            ) values (
              section_uuid,
              item_value->>'name',
              item_value->>'description',
              (item_value->>'priceMinor')::integer,
              item_value->>'currency',
              item_value->>'availability',
              dietary_values,
              nullif(item_value->>'allergenNote', ''),
              (item_value->>'sortOrder')::integer,
              false
            )
            returning id into item_uuid;
            update private.provider_menu_item_sources child
            set materialized_item_id = item_uuid
            where child.provider_slug = ingest_licensed_provider_batch.provider_slug
              and child.business_external_id = record_external_id
              and child.section_external_id = section_value->>'externalId'
              and child.item_external_id = item_value->>'externalId';
          end if;
        end loop;
      end loop;

      if can_materialize then
        perform private.set_provider_field_materialization(
          target_business_id, 'menu', provider_slug, record_external_id,
          record_value->'menu'
        );
      end if;
    end if;
  end loop;

  if sync_mode = 'snapshot' then
    if sync_final_page then
      update private.provider_business_sources source
      set source_status = 'missing',
          missing_since = coalesce(source.missing_since, clock_timestamp()),
          inactive_at = null
      where source.provider_slug = ingest_licensed_provider_batch.provider_slug
        and source.source_status <> 'inactive'
        and not exists (
          select 1
          from private.provider_snapshot_seen seen
          where seen.provider_slug = ingest_licensed_provider_batch.provider_slug
            and seen.snapshot_id = sync_snapshot_id
            and seen.provider_external_id = source.provider_external_id
        );
      get diagnostics missing_source_count = row_count;

      update private.provider_location_sources child
      set source_status = 'missing',
          missing_since = coalesce(child.missing_since, clock_timestamp()),
          inactive_at = null
      where child.provider_slug = ingest_licensed_provider_batch.provider_slug
        and exists (
          select 1
          from private.provider_business_sources source
          where source.provider_slug = child.provider_slug
            and source.provider_external_id = child.business_external_id
            and source.source_status = 'missing'
        );
      update private.provider_menu_section_sources child
      set source_status = 'missing',
          missing_since = coalesce(child.missing_since, clock_timestamp()),
          inactive_at = null
      where child.provider_slug = ingest_licensed_provider_batch.provider_slug
        and exists (
          select 1
          from private.provider_business_sources source
          where source.provider_slug = child.provider_slug
            and source.provider_external_id = child.business_external_id
            and source.source_status = 'missing'
        );
      update private.provider_menu_item_sources child
      set source_status = 'missing',
          missing_since = coalesce(child.missing_since, clock_timestamp()),
          inactive_at = null
      where child.provider_slug = ingest_licensed_provider_batch.provider_slug
        and exists (
          select 1
          from private.provider_business_sources source
          where source.provider_slug = child.provider_slug
            and source.provider_external_id = child.business_external_id
            and source.source_status = 'missing'
        );

      update private.provider_snapshot_sessions session
      set last_generated_at = generated_at_value,
          next_page_index = sync_page_index + 1,
          final_page_received = true,
          seen_record_count = session.seen_record_count + batch_record_count,
          completed_at = clock_timestamp()
      where session.provider_slug = ingest_licensed_provider_batch.provider_slug
        and session.snapshot_id = sync_snapshot_id;

      insert into private.provider_ingest_audit_events (
        provider_slug,
        event_type,
        batch_id_hash,
        accepted_records,
        inactive_records,
        metadata
      ) values (
        provider_slug,
        'snapshot_completed',
        encode(extensions.digest(idempotency_key, 'sha256'), 'hex'),
        accepted_records,
        inactive_records,
        jsonb_build_object(
          'snapshot_id_hash', encode(extensions.digest(sync_snapshot_id, 'sha256'), 'hex'),
          'final_page_index', sync_page_index,
          'missing_sources', missing_source_count
        )
      );
    else
      update private.provider_snapshot_sessions session
      set last_generated_at = generated_at_value,
          next_page_index = sync_page_index + 1,
          seen_record_count = session.seen_record_count + batch_record_count
      where session.provider_slug = ingest_licensed_provider_batch.provider_slug
        and session.snapshot_id = sync_snapshot_id;
    end if;
  end if;

  result_response := jsonb_build_object(
    'status', 'applied',
    'batch_id', idempotency_key,
    'accepted_records', accepted_records,
    'inactive_records', inactive_records
  );
  update private.provider_ingest_receipts receipt
  set status = 'completed',
      safe_response = result_response,
      completed_at = clock_timestamp()
  where receipt.provider_slug = ingest_licensed_provider_batch.provider_slug
    and receipt.idempotency_key_hash = receipt_key_hash;

  insert into private.provider_ingest_audit_events (
    provider_slug,
    event_type,
    batch_id_hash,
    accepted_records,
    inactive_records,
    metadata
  ) values (
    provider_slug,
    'batch_applied',
    encode(extensions.digest(idempotency_key, 'sha256'), 'hex'),
    accepted_records,
    inactive_records,
    jsonb_build_object(
      'sync_mode', sync_mode,
      'page_index', sync_page_index,
      'final_page', sync_final_page
    )
  );

  return result_response;
end;
$$;

revoke all on function public.ingest_licensed_provider_batch(text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_licensed_provider_batch(text, text, text, text, jsonb)
  to service_role;
