-- Privacy-first push notification foundation. This migration deliberately does
-- not call a push provider and keeps event enqueueing disabled until production
-- credentials, operations, legal review, and signed-device evidence exist.

alter table public.notification_preferences
  add column if not exists timezone text;

alter table public.notification_preferences
  alter column live_nearby set default false,
  alter column location_change set default false,
  alter column owner_update set default false,
  alter column menu_return set default false;

alter table public.notification_preferences
  drop constraint if exists notification_preferences_quiet_hours_pair,
  add constraint notification_preferences_quiet_hours_pair check (
    (quiet_hours_start is null and quiet_hours_end is null)
    or (quiet_hours_start is not null and quiet_hours_end is not null)
  ),
  drop constraint if exists notification_preferences_timezone_length,
  add constraint notification_preferences_timezone_length check (
    timezone is null or char_length(timezone) between 1 and 64
  );

create table if not exists private.notification_runtime_settings (
  singleton boolean primary key default true check (singleton),
  enqueue_enabled boolean not null default false,
  delivery_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint notification_runtime_delivery_requires_enqueue
    check (not delivery_enabled or enqueue_enabled)
);

insert into private.notification_runtime_settings (singleton, enqueue_enabled, delivery_enabled)
values (true, false, false)
on conflict (singleton) do nothing;

create table if not exists private.notification_consents (
  user_id uuid not null references auth.users(id) on delete cascade,
  consent_kind text not null check (consent_kind in ('product_updates', 'marketing')),
  granted boolean not null default false,
  policy_version text not null,
  source text not null check (source in ('native_settings', 'web_settings', 'support')),
  granted_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, consent_kind),
  constraint notification_consents_policy_version
    check (char_length(policy_version) between 1 and 80),
  constraint notification_consents_timestamps check (
    (granted and granted_at is not null and revoked_at is null)
    or (not granted and revoked_at is not null)
  )
);

create table if not exists private.notification_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  installation_id uuid not null,
  platform text not null check (platform in ('ios', 'android')),
  provider text not null check (provider = 'expo'),
  project_id uuid not null,
  token_hash char(64) not null check (token_hash ~ '^[0-9a-f]{64}$'),
  token_ciphertext text not null,
  token_nonce text not null,
  encryption_key_version integer not null check (encryption_key_version between 1 and 2147483647),
  timezone text not null,
  app_version text not null,
  permission_state text not null check (permission_state in ('granted', 'provisional')),
  registered_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoke_reason text,
  constraint notification_devices_ciphertext_size
    check (char_length(token_ciphertext) between 24 and 2048),
  constraint notification_devices_nonce_format
    check (token_nonce ~ '^[A-Za-z0-9_-]{16}$'),
  constraint notification_devices_timezone_length
    check (char_length(timezone) between 1 and 64),
  constraint notification_devices_app_version_length
    check (char_length(app_version) between 1 and 80),
  constraint notification_devices_revoke_reason_length
    check (revoke_reason is null or char_length(revoke_reason) between 1 and 80),
  constraint notification_devices_revocation_pair
    check ((revoked_at is null and revoke_reason is null) or revoked_at is not null)
);

create unique index if not exists notification_devices_active_installation_idx
  on private.notification_devices (user_id, provider, installation_id)
  where revoked_at is null;

create unique index if not exists notification_devices_active_token_idx
  on private.notification_devices (provider, token_hash)
  where revoked_at is null;

create index if not exists notification_devices_user_active_idx
  on private.notification_devices (user_id, last_seen_at desc)
  where revoked_at is null;

create unique index if not exists notification_devices_id_user_idx
  on private.notification_devices (id, user_id);

create table if not exists private.notification_preference_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key_hash char(64) not null check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_hash char(64) not null check (request_hash ~ '^[0-9a-f]{64}$'),
  affected_count integer not null check (affected_count between 0 and 200),
  created_at timestamptz not null default now(),
  primary key (user_id, idempotency_key_hash)
);

create index if not exists notification_preference_receipts_created_idx
  on private.notification_preference_receipts (created_at);

create table if not exists private.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  source_event_id bigint not null references public.business_public_events(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  notification_kind text not null check (
    notification_kind in ('owner_update', 'location_change', 'menu_return')
  ),
  state text not null default 'pending' check (
    state in ('pending', 'leased', 'expanded', 'retry', 'dead', 'expired')
  ),
  dedupe_key text not null unique,
  fanout_cursor uuid,
  attempts integer not null default 0 check (attempts between 0 and 20),
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint notification_outbox_dedupe_length check (char_length(dedupe_key) between 1 and 160),
  constraint notification_outbox_lease_pair check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  ),
  constraint notification_outbox_error_length
    check (last_error_code is null or char_length(last_error_code) between 1 and 80),
  constraint notification_outbox_expiry check (expires_at > created_at)
);

create unique index if not exists business_public_events_id_business_idx
  on public.business_public_events (id, business_id);

alter table private.notification_outbox
  drop constraint if exists notification_outbox_source_business_fkey,
  add constraint notification_outbox_source_business_fkey
    foreign key (source_event_id, business_id)
    references public.business_public_events(id, business_id)
    on delete cascade;

create unique index if not exists notification_outbox_delivery_identity_idx
  on private.notification_outbox (id, business_id, source_event_id, notification_kind);

create index if not exists notification_outbox_claim_idx
  on private.notification_outbox (available_at, created_at)
  where state in ('pending', 'retry', 'leased');

create table if not exists private.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null,
  device_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  source_event_id bigint not null,
  notification_kind text not null check (
    notification_kind in ('owner_update', 'location_change', 'menu_return')
  ),
  state text not null default 'pending' check (
    state in ('pending', 'leased', 'accepted', 'unknown', 'delivered', 'retry', 'failed', 'dead', 'expired', 'cancelled')
  ),
  attempts integer not null default 0 check (attempts between 0 and 20),
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  provider_ticket_id text,
  last_provider_code text,
  accepted_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (device_id, source_event_id),
  constraint notification_deliveries_device_user_fkey
    foreign key (device_id, user_id)
    references private.notification_devices(id, user_id)
    on delete cascade,
  constraint notification_deliveries_outbox_identity_fkey
    foreign key (outbox_id, business_id, source_event_id, notification_kind)
    references private.notification_outbox(id, business_id, source_event_id, notification_kind)
    on delete cascade,
  constraint notification_deliveries_lease_pair check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  ),
  constraint notification_deliveries_ticket_length
    check (provider_ticket_id is null or char_length(provider_ticket_id) between 1 and 240),
  constraint notification_deliveries_code_length
    check (last_provider_code is null or char_length(last_provider_code) between 1 and 80)
);

create index if not exists notification_deliveries_claim_idx
  on private.notification_deliveries (available_at, created_at)
  where state in ('pending', 'retry', 'leased', 'unknown');

create index if not exists notification_deliveries_user_idx
  on private.notification_deliveries (user_id, created_at desc);

create or replace function public.update_follow_notification_preferences(
  target_business_ids uuid[],
  target_field text,
  target_enabled boolean,
  target_timezone text,
  target_quiet_hours_start time,
  target_quiet_hours_end time,
  idempotency_key text
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  normalized_ids uuid[];
  key_hash text;
  request_hash text;
  stored_hash text;
  stored_count integer;
  affected integer;
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active account required';
  end if;
  if target_enabled is null
    or target_field not in ('live_nearby', 'owner_bundle')
    or idempotency_key is null
    or idempotency_key !~ '^spottr:notification-preference:[A-Za-z0-9._:-]{12,180}$'
    or ((target_quiet_hours_start is null) <> (target_quiet_hours_end is null))
    or (target_timezone is null) <> (target_quiet_hours_start is null)
  then
    raise exception using errcode = '22023', message = 'Invalid notification preference request';
  end if;
  if target_timezone is not null and not exists (
    select 1 from pg_catalog.pg_timezone_names zone where zone.name = target_timezone
  ) then
    raise exception using errcode = '22023', message = 'Invalid notification timezone';
  end if;
  select coalesce(array_agg(distinct id order by id), '{}'::uuid[])
  into normalized_ids from unnest(coalesce(target_business_ids, '{}'::uuid[])) id;
  if cardinality(normalized_ids) < 1 or cardinality(normalized_ids) > 200 then
    raise exception using errcode = '22023', message = 'Choose between 1 and 200 followed businesses';
  end if;
  if exists (
    select 1 from unnest(normalized_ids) business_id
    where not exists (
      select 1 from public.follows followed
      where followed.user_id = actor and followed.business_id = business_id
    ) or not private.is_business_publicly_eligible(business_id)
  ) then
    raise exception using errcode = '42501', message = 'Notification preferences require an eligible followed business';
  end if;

  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'business_ids', normalized_ids,
    'field', target_field,
    'enabled', target_enabled,
    'timezone', target_timezone,
    'quiet_hours_start', target_quiet_hours_start,
    'quiet_hours_end', target_quiet_hours_end
  ));
  perform private.lock_idempotency_request(actor, 'notification_preference', key_hash);
  select receipt.request_hash, receipt.affected_count
  into stored_hash, stored_count
  from private.notification_preference_receipts receipt
  where receipt.user_id = actor and receipt.idempotency_key_hash = key_hash;
  if found then
    if stored_hash <> request_hash then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return stored_count;
  end if;

  perform private.consume_rate_limit(actor, 'notification_preference_hour', 60, 3600);
  insert into public.notification_preferences (
    user_id, business_id, live_nearby, location_change, owner_update, menu_return,
    quiet_hours_start, quiet_hours_end, timezone, updated_at
  )
  select actor, business_id,
    case when target_field = 'live_nearby' then target_enabled else false end,
    case when target_field = 'owner_bundle' then target_enabled else false end,
    case when target_field = 'owner_bundle' then target_enabled else false end,
    case when target_field = 'owner_bundle' then target_enabled else false end,
    target_quiet_hours_start, target_quiet_hours_end, target_timezone, now()
  from unnest(normalized_ids) business_id
  on conflict (user_id, business_id) do update set
    live_nearby = case when target_field = 'live_nearby' then excluded.live_nearby else notification_preferences.live_nearby end,
    location_change = case when target_field = 'owner_bundle' then excluded.location_change else notification_preferences.location_change end,
    owner_update = case when target_field = 'owner_bundle' then excluded.owner_update else notification_preferences.owner_update end,
    menu_return = case when target_field = 'owner_bundle' then excluded.menu_return else notification_preferences.menu_return end,
    quiet_hours_start = coalesce(excluded.quiet_hours_start, notification_preferences.quiet_hours_start),
    quiet_hours_end = coalesce(excluded.quiet_hours_end, notification_preferences.quiet_hours_end),
    timezone = coalesce(excluded.timezone, notification_preferences.timezone),
    updated_at = now();
  get diagnostics affected = row_count;
  if target_field = 'owner_bundle' and not target_enabled then
    update private.notification_deliveries delivery set
      state = 'cancelled', lease_token = null, lease_expires_at = null,
      last_provider_code = 'preference_revoked', updated_at = now()
    where delivery.user_id = actor
      and delivery.business_id = any(normalized_ids)
      and delivery.notification_kind in ('owner_update', 'location_change', 'menu_return')
      and delivery.state in ('pending', 'leased', 'retry', 'unknown');
  end if;
  insert into private.notification_preference_receipts (
    user_id, idempotency_key_hash, request_hash, affected_count
  ) values (actor, key_hash, request_hash, affected);
  return affected;
end;
$$;

create or replace function private.register_notification_device(
  target_user_id uuid,
  target_installation_id uuid,
  target_platform text,
  target_provider text,
  target_project_id uuid,
  target_token_hash text,
  target_token_ciphertext text,
  target_token_nonce text,
  target_encryption_key_version integer,
  target_timezone text,
  target_app_version text,
  target_permission_state text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare device_id uuid;
begin
  if target_user_id is null or target_installation_id is null or target_project_id is null
    or target_platform not in ('ios', 'android') or target_provider <> 'expo'
    or target_token_hash !~ '^[0-9a-f]{64}$'
    or target_token_ciphertext is null or char_length(target_token_ciphertext) not between 24 and 2048
    or target_token_nonce !~ '^[A-Za-z0-9_-]{16}$'
    or target_encryption_key_version not between 1 and 2147483647
    or target_permission_state not in ('granted', 'provisional')
    or target_app_version is null or char_length(target_app_version) not between 1 and 80
    or target_timezone is null or char_length(target_timezone) not between 1 and 64
    or not exists (select 1 from pg_catalog.pg_timezone_names zone where zone.name = target_timezone)
    or not private.is_active_user(target_user_id)
  then
    raise exception using errcode = '22023', message = 'Invalid notification device';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_provider || ':' || target_token_hash, 917170)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_user_id::text || ':' || target_installation_id::text, 917171)
  );
  select device.id into device_id
  from private.notification_devices device
  where device.user_id = target_user_id
    and device.provider = target_provider
    and device.installation_id = target_installation_id
    and device.token_hash = target_token_hash
    and device.revoked_at is null
  for update;
  if device_id is not null then
    update private.notification_devices set
      token_ciphertext = target_token_ciphertext,
      token_nonce = target_token_nonce,
      encryption_key_version = target_encryption_key_version,
      project_id = target_project_id,
      timezone = target_timezone,
      app_version = target_app_version,
      permission_state = target_permission_state,
      last_seen_at = now(),
      updated_at = now()
    where id = device_id;
    return device_id;
  end if;
  update private.notification_devices set
    revoked_at = now(), revoke_reason = 'ownership_changed', updated_at = now()
  where revoked_at is null and provider = target_provider and token_hash = target_token_hash
    and (user_id <> target_user_id or installation_id <> target_installation_id);
  update private.notification_devices set
    revoked_at = now(), revoke_reason = 'token_rotated', updated_at = now()
  where revoked_at is null and user_id = target_user_id and provider = target_provider
    and installation_id = target_installation_id;
  insert into private.notification_devices (
    user_id, installation_id, platform, provider, project_id, token_hash,
    token_ciphertext, token_nonce, encryption_key_version, timezone,
    app_version, permission_state
  ) values (
    target_user_id, target_installation_id, target_platform, target_provider,
    target_project_id, target_token_hash, target_token_ciphertext,
    target_token_nonce, target_encryption_key_version, target_timezone,
    target_app_version, target_permission_state
  ) returning id into device_id;
  perform private.write_audit_event(
    target_user_id, null, 'notification.device_registered', 'notification_device',
    device_id::text, jsonb_build_object('platform', target_platform, 'provider', target_provider)
  );
  return device_id;
end;
$$;

create or replace function public.register_notification_device_server(
  target_user_id uuid,
  target_installation_id uuid,
  target_platform text,
  target_project_id uuid,
  target_token_hash text,
  target_token_ciphertext text,
  target_token_nonce text,
  target_encryption_key_version integer,
  target_timezone text,
  target_app_version text,
  target_permission_state text,
  target_consent_policy_version text,
  target_consent_source text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare device_id uuid;
begin
  perform private.consume_rate_limit(target_user_id, 'notification_device_register_hour', 30, 3600);
  perform private.set_notification_consent(
    target_user_id, 'product_updates', true,
    target_consent_policy_version, target_consent_source
  );
  device_id := private.register_notification_device(
    target_user_id, target_installation_id, target_platform, 'expo', target_project_id,
    target_token_hash, target_token_ciphertext, target_token_nonce,
    target_encryption_key_version, target_timezone, target_app_version,
    target_permission_state
  );
  return device_id;
end;
$$;

create or replace function public.revoke_notification_device_server(
  target_user_id uuid,
  target_installation_id uuid,
  target_consent_policy_version text
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare affected integer;
begin
  if target_user_id is null or target_installation_id is null
    or target_consent_policy_version is null
    or char_length(target_consent_policy_version) not between 1 and 80
  then raise exception using errcode = '22023', message = 'Invalid notification revocation'; end if;
  perform private.consume_rate_limit(target_user_id, 'notification_device_revoke_hour', 60, 3600);
  affected := private.revoke_notification_device(
    target_user_id, target_installation_id, 'user_revoked'
  );
  return affected;
end;
$$;

create or replace function public.revoke_all_notification_devices_server(
  target_user_id uuid,
  target_consent_policy_version text
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare affected integer;
begin
  if target_user_id is null or target_consent_policy_version is null
    or char_length(target_consent_policy_version) not between 1 and 80
  then raise exception using errcode = '22023', message = 'Invalid notification revocation'; end if;
  perform private.consume_rate_limit(target_user_id, 'notification_device_revoke_all_day', 10, 86400);
  update private.notification_devices set
    revoked_at = now(), revoke_reason = 'sign_out', updated_at = now()
  where user_id = target_user_id and revoked_at is null;
  get diagnostics affected = row_count;
  perform private.set_notification_consent(
    target_user_id, 'product_updates', false,
    target_consent_policy_version, 'native_settings'
  );
  if affected > 0 then
    perform private.write_audit_event(
      target_user_id, null, 'notification.devices_revoked', 'notification_account',
      target_user_id::text, jsonb_build_object('reason', 'sign_out', 'device_count', affected)
    );
  end if;
  return affected;
end;
$$;

create or replace function private.set_notification_consent(
  target_user_id uuid,
  target_consent_kind text,
  target_granted boolean,
  target_policy_version text,
  target_source text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if target_user_id is null or target_granted is null
    or target_consent_kind not in ('product_updates', 'marketing')
    or target_source not in ('native_settings', 'web_settings', 'support')
    or target_policy_version is null or char_length(target_policy_version) not between 1 and 80
    or not private.is_active_user(target_user_id)
  then raise exception using errcode = '22023', message = 'Invalid notification consent'; end if;
  insert into private.notification_consents (
    user_id, consent_kind, granted, policy_version, source,
    granted_at, revoked_at, updated_at
  ) values (
    target_user_id, target_consent_kind, target_granted, target_policy_version,
    target_source, case when target_granted then now() end,
    case when not target_granted then now() end, now()
  ) on conflict (user_id, consent_kind) do update set
    granted = excluded.granted,
    policy_version = excluded.policy_version,
    source = excluded.source,
    granted_at = case when excluded.granted then now() else notification_consents.granted_at end,
    revoked_at = case when excluded.granted then null else now() end,
    updated_at = now();
  if target_consent_kind = 'product_updates' and not target_granted then
    update private.notification_deliveries delivery set
      state = 'cancelled', lease_token = null, lease_expires_at = null,
      last_provider_code = 'consent_revoked', updated_at = now()
    where delivery.user_id = target_user_id
      and delivery.state in ('pending', 'leased', 'retry', 'unknown');
  end if;
  perform private.write_audit_event(
    target_user_id, null,
    case when target_granted then 'notification.consent_granted' else 'notification.consent_revoked' end,
    'notification_consent', target_consent_kind,
    jsonb_build_object('policy_version', target_policy_version, 'source', target_source)
  );
end;
$$;

create or replace function private.revoke_notification_device(
  target_user_id uuid,
  target_installation_id uuid,
  target_reason text default 'user_revoked'
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare affected integer;
begin
  if target_user_id is null or target_installation_id is null
    or target_reason not in ('user_revoked', 'sign_out', 'permission_revoked', 'provider_invalid')
  then raise exception using errcode = '22023', message = 'Invalid notification device revocation'; end if;
  update private.notification_devices set
    revoked_at = now(), revoke_reason = target_reason, updated_at = now()
  where user_id = target_user_id and installation_id = target_installation_id and revoked_at is null;
  get diagnostics affected = row_count;
  update private.notification_deliveries delivery set
    state = 'cancelled', lease_token = null, lease_expires_at = null,
    last_provider_code = 'device_revoked', updated_at = now()
  where delivery.user_id = target_user_id
    and delivery.device_id in (
      select device.id from private.notification_devices device
      where device.user_id = target_user_id
        and device.installation_id = target_installation_id
    )
    and delivery.state in ('pending', 'leased', 'retry', 'unknown');
  if affected > 0 then
    perform private.write_audit_event(
      target_user_id, null, 'notification.device_revoked', 'notification_installation',
      target_installation_id::text, jsonb_build_object('reason', target_reason)
    );
  end if;
  return affected;
end;
$$;

create or replace function private.enqueue_notification_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare notification_kind text;
begin
  if not coalesce((
    select settings.enqueue_enabled
    from private.notification_runtime_settings settings where settings.singleton
  ), false) then return new; end if;
  notification_kind := case new.event_type
    when 'owner_update' then 'owner_update'
    when 'mobile_stop' then 'location_change'
    when 'menu_availability' then case when new.payload ->> 'availability' = 'available' then 'menu_return' end
    else null
  end;
  if notification_kind is null or new.expires_at <= now()
    or not private.is_business_publicly_eligible(new.business_id)
  then return new; end if;
  insert into private.notification_outbox (
    source_event_id, business_id, notification_kind, dedupe_key, expires_at
  ) values (
    new.id, new.business_id, notification_kind,
    concat('business-event:', new.id, ':', notification_kind), new.expires_at
  ) on conflict (dedupe_key) do nothing;
  return new;
end;
$$;

drop trigger if exists business_public_events_notification_outbox on public.business_public_events;
create trigger business_public_events_notification_outbox
after insert on public.business_public_events
for each row execute function private.enqueue_notification_event();

create or replace function private.claim_notification_outbox(
  target_worker_id uuid,
  target_batch_size integer default 50,
  target_lease_seconds integer default 60
)
returns table (
  outbox_id uuid,
  source_event_id bigint,
  business_id uuid,
  notification_kind text,
  lease_token uuid,
  expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if target_worker_id is null or target_batch_size not between 1 and 100
    or target_lease_seconds not between 15 and 300
  then raise exception using errcode = '22023', message = 'Invalid notification outbox claim'; end if;
  if not coalesce((select delivery_enabled from private.notification_runtime_settings where singleton), false) then
    return;
  end if;
  update private.notification_outbox queue set
    state = 'expired', lease_token = null, lease_expires_at = null, updated_at = now()
  where queue.expires_at <= now() and queue.state not in ('expanded', 'dead', 'expired');
  return query
  with candidates as (
    select queue.id
    from private.notification_outbox queue
    where queue.expires_at > now()
      and queue.attempts < 20
      and queue.available_at <= now()
      and (
        queue.state in ('pending', 'retry')
        or (queue.state = 'leased' and queue.lease_expires_at <= now())
      )
    order by queue.created_at, queue.id
    for update skip locked
    limit target_batch_size
  ), claimed as (
    update private.notification_outbox queue set
      state = 'leased', attempts = queue.attempts + 1,
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => target_lease_seconds),
      updated_at = now()
    from candidates where queue.id = candidates.id
    returning queue.*
  )
  select claimed.id, claimed.source_event_id, claimed.business_id,
    claimed.notification_kind, claimed.lease_token, claimed.expires_at
  from claimed order by claimed.created_at, claimed.id;
end;
$$;

create or replace function private.expand_notification_outbox(
  target_outbox_id uuid,
  target_lease_token uuid,
  target_user_batch_size integer default 200
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare target private.notification_outbox%rowtype; inserted_count integer := 0;
  last_user_id uuid; has_more boolean := false;
begin
  if target_outbox_id is null or target_lease_token is null
    or target_user_batch_size not between 1 and 500
  then raise exception using errcode = '22023', message = 'Invalid notification fanout request'; end if;
  select * into target from private.notification_outbox queue
  where queue.id = target_outbox_id and queue.state = 'leased'
    and queue.lease_token = target_lease_token and queue.lease_expires_at > now()
  for update;
  if target.id is null then raise exception using errcode = '40001', message = 'Notification lease is stale'; end if;
  if target.expires_at <= now() then
    update private.notification_outbox set state = 'expired', lease_token = null,
      lease_expires_at = null, updated_at = now() where id = target.id;
    return 0;
  end if;

  with recipient_users as materialized (
    select followed.user_id
    from public.follows followed
    where followed.business_id = target.business_id
      and (target.fanout_cursor is null or followed.user_id > target.fanout_cursor)
      and private.is_active_user(followed.user_id)
      and exists (
        select 1 from private.notification_consents consent
        where consent.user_id = followed.user_id
          and consent.consent_kind = 'product_updates' and consent.granted
      )
      and coalesce((
        select case target.notification_kind
          when 'owner_update' then preference.owner_update
          when 'location_change' then preference.location_change
          when 'menu_return' then preference.menu_return
          else false
        end
        from public.notification_preferences preference
        where preference.user_id = followed.user_id
          and preference.business_id = target.business_id
      ), false)
    order by followed.user_id
    limit target_user_batch_size
  ), inserted as (
    insert into private.notification_deliveries (
      outbox_id, device_id, user_id, business_id, source_event_id, notification_kind
    )
    select target.id, device.id, device.user_id, target.business_id,
      target.source_event_id, target.notification_kind
    from recipient_users recipient
    join private.notification_devices device on device.user_id = recipient.user_id
      and device.revoked_at is null
    on conflict (device_id, source_event_id) do nothing
    returning id
  )
  select (select max(user_id) from recipient_users), (select count(*) from inserted)
  into last_user_id, inserted_count;

  if last_user_id is not null then
    select exists (
      select 1 from public.follows followed
      where followed.business_id = target.business_id and followed.user_id > last_user_id
    ) into has_more;
  end if;
  update private.notification_outbox set
    fanout_cursor = coalesce(last_user_id, fanout_cursor),
    state = case when has_more then 'pending' else 'expanded' end,
    available_at = case when has_more then now() else available_at end,
    lease_token = null, lease_expires_at = null, last_error_code = null,
    updated_at = now()
  where id = target.id;
  return inserted_count;
end;
$$;

create or replace function private.claim_notification_deliveries(
  target_worker_id uuid,
  target_batch_size integer default 100,
  target_lease_seconds integer default 60
)
returns table (
  delivery_id uuid,
  device_id uuid,
  user_id uuid,
  business_id uuid,
  source_event_id bigint,
  notification_kind text,
  provider text,
  token_ciphertext text,
  token_nonce text,
  encryption_key_version integer,
  lease_token uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if target_worker_id is null or target_batch_size not between 1 and 250
    or target_lease_seconds not between 15 and 300
  then raise exception using errcode = '22023', message = 'Invalid notification delivery claim'; end if;
  if not coalesce((select delivery_enabled from private.notification_runtime_settings where singleton), false) then
    return;
  end if;
  update private.notification_deliveries delivery set
    state = 'expired', lease_token = null, lease_expires_at = null, updated_at = now()
  from private.notification_outbox queue
  where queue.id = delivery.outbox_id and queue.expires_at <= now()
    and delivery.state not in ('delivered', 'dead', 'expired');
  return query
  with candidates as (
    select delivery.id
    from private.notification_deliveries delivery
    join private.notification_outbox queue on queue.id = delivery.outbox_id
    join private.notification_devices device on device.id = delivery.device_id
    join private.notification_consents consent on consent.user_id = delivery.user_id
      and consent.consent_kind = 'product_updates' and consent.granted
    left join public.notification_preferences preference
      on preference.user_id = delivery.user_id and preference.business_id = delivery.business_id
    where queue.expires_at > now() and device.revoked_at is null
      and device.last_seen_at > now() - interval '30 days'
      and coalesce(case delivery.notification_kind
        when 'owner_update' then preference.owner_update
        when 'location_change' then preference.location_change
        when 'menu_return' then preference.menu_return
        else false
      end, false)
      and delivery.attempts < 20 and delivery.available_at <= now()
      and (
        delivery.state in ('pending', 'retry')
        or (delivery.state = 'leased' and delivery.lease_expires_at <= now())
      )
      and not (
        preference.quiet_hours_start is not null
        and preference.quiet_hours_end is not null
        and (
          (preference.quiet_hours_start < preference.quiet_hours_end
            and (now() at time zone coalesce(preference.timezone, device.timezone))::time
              >= preference.quiet_hours_start
            and (now() at time zone coalesce(preference.timezone, device.timezone))::time
              < preference.quiet_hours_end)
          or (preference.quiet_hours_start > preference.quiet_hours_end
            and ((now() at time zone coalesce(preference.timezone, device.timezone))::time
              >= preference.quiet_hours_start
              or (now() at time zone coalesce(preference.timezone, device.timezone))::time
              < preference.quiet_hours_end))
          or (preference.quiet_hours_start = preference.quiet_hours_end)
        )
      )
    order by delivery.created_at, delivery.id
    for update of delivery skip locked
    limit target_batch_size
  ), claimed as (
    update private.notification_deliveries delivery set
      state = 'leased', attempts = delivery.attempts + 1,
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => target_lease_seconds),
      updated_at = now()
    from candidates where delivery.id = candidates.id
    returning delivery.*
  )
  select claimed.id, claimed.device_id, claimed.user_id, claimed.business_id,
    claimed.source_event_id, claimed.notification_kind, device.provider,
    device.token_ciphertext, device.token_nonce, device.encryption_key_version,
    claimed.lease_token
  from claimed join private.notification_devices device on device.id = claimed.device_id
  order by claimed.created_at, claimed.id;
end;
$$;

create or replace function private.record_notification_delivery_result(
  target_delivery_id uuid,
  target_lease_token uuid,
  target_state text,
  target_provider_ticket_id text default null,
  target_provider_code text default null,
  target_retry_after_seconds integer default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if target_delivery_id is null or target_lease_token is null
    or target_state not in ('accepted', 'unknown', 'delivered', 'retry', 'failed', 'dead')
    or (target_provider_ticket_id is not null and char_length(target_provider_ticket_id) not between 1 and 240)
    or (target_provider_code is not null and char_length(target_provider_code) not between 1 and 80)
    or (target_retry_after_seconds is not null and target_retry_after_seconds not between 15 and 86400)
  then raise exception using errcode = '22023', message = 'Invalid notification delivery result'; end if;
  update private.notification_deliveries set
    state = target_state,
    provider_ticket_id = coalesce(target_provider_ticket_id, provider_ticket_id),
    last_provider_code = target_provider_code,
    accepted_at = case when target_state = 'accepted' then now() else accepted_at end,
    delivered_at = case when target_state = 'delivered' then now() else delivered_at end,
    available_at = case when target_state = 'retry'
      then now() + make_interval(secs => coalesce(target_retry_after_seconds, 60))
      else available_at end,
    lease_token = null, lease_expires_at = null, updated_at = now()
  where id = target_delivery_id and state = 'leased'
    and lease_token = target_lease_token and lease_expires_at > now();
  if not found then raise exception using errcode = '40001', message = 'Notification lease is stale'; end if;
end;
$$;

-- Private push data is service-owned and never exposed through PostgREST or Realtime.
revoke all privileges on table
  private.notification_runtime_settings,
  private.notification_consents,
  private.notification_devices,
  private.notification_preference_receipts,
  private.notification_outbox,
  private.notification_deliveries
from public, anon, authenticated;

revoke all on function public.update_follow_notification_preferences(
  uuid[], text, boolean, text, time, time, text
) from public, anon, service_role;
grant execute on function public.update_follow_notification_preferences(
  uuid[], text, boolean, text, time, time, text
) to authenticated;

revoke all on function private.register_notification_device(
  uuid, uuid, text, text, uuid, text, text, text, integer, text, text, text
) from public, anon, authenticated;
revoke all on function private.set_notification_consent(uuid, text, boolean, text, text)
  from public, anon, authenticated;
revoke all on function private.revoke_notification_device(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function private.register_notification_device(
  uuid, uuid, text, text, uuid, text, text, text, integer, text, text, text
) to service_role;
grant execute on function private.set_notification_consent(uuid, text, boolean, text, text)
  to service_role;
grant execute on function private.revoke_notification_device(uuid, uuid, text)
  to service_role;
revoke all on function public.register_notification_device_server(
  uuid, uuid, text, uuid, text, text, text, integer, text, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.revoke_notification_device_server(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.register_notification_device_server(
  uuid, uuid, text, uuid, text, text, text, integer, text, text, text, text, text
) to service_role;
grant execute on function public.revoke_notification_device_server(uuid, uuid, text)
  to service_role;
revoke all on function public.revoke_all_notification_devices_server(uuid, text)
  from public, anon, authenticated;
grant execute on function public.revoke_all_notification_devices_server(uuid, text)
  to service_role;
revoke all on function private.claim_notification_outbox(uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function private.expand_notification_outbox(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function private.claim_notification_deliveries(uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function private.record_notification_delivery_result(uuid, uuid, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function private.claim_notification_outbox(uuid, integer, integer) to service_role;
grant execute on function private.expand_notification_outbox(uuid, uuid, integer) to service_role;
grant execute on function private.claim_notification_deliveries(uuid, integer, integer) to service_role;
grant execute on function private.record_notification_delivery_result(uuid, uuid, text, text, text, integer)
  to service_role;

revoke insert, update, delete on public.notification_preferences from authenticated;
drop policy if exists "users manage own notification preferences" on public.notification_preferences;
drop policy if exists "users read own notification preferences" on public.notification_preferences;
create policy "users read own notification preferences" on public.notification_preferences
  for select to authenticated using (user_id = auth.uid());

-- Preserve the existing complete export as a private implementation and add
-- sanitized notification metadata. Cryptographic token material is never part
-- of a user export.
do $notification_export_core$
begin
  if pg_catalog.to_regprocedure('public.account_export_payload_core(uuid)') is null then
    alter function public.account_export_payload(uuid) rename to account_export_payload_core;
  end if;
end;
$notification_export_core$;

create or replace function public.account_export_payload(target_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.account_export_payload_core(target_user_id) || jsonb_build_object(
    'notification_consents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'consent_kind', consent.consent_kind,
        'granted', consent.granted,
        'policy_version', consent.policy_version,
        'source', consent.source,
        'granted_at', consent.granted_at,
        'revoked_at', consent.revoked_at,
        'updated_at', consent.updated_at
      ) order by consent.consent_kind)
      from private.notification_consents consent
      where consent.user_id = target_user_id
    ), '[]'::jsonb),
    'notification_devices', coalesce((
      select jsonb_agg(jsonb_build_object(
        'platform', device.platform,
        'provider', device.provider,
        'timezone', device.timezone,
        'app_version', device.app_version,
        'permission_state', device.permission_state,
        'registered_at', device.registered_at,
        'last_seen_at', device.last_seen_at,
        'revoked_at', device.revoked_at,
        'revoke_reason', device.revoke_reason
      ) order by device.registered_at)
      from private.notification_devices device
      where device.user_id = target_user_id
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.account_export_payload_core(uuid) from public, anon, authenticated;
grant execute on function public.account_export_payload_core(uuid) to service_role;
revoke all on function public.account_export_payload(uuid) from public, anon, authenticated;
grant execute on function public.account_export_payload(uuid) to service_role;

-- Defense-in-depth invariants: future dispatch work cannot be enabled by a
-- client grant or accidental Realtime publication.
do $push_foundation_verify$
begin
  if exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'private'
      and tablename in ('notification_devices', 'notification_outbox', 'notification_deliveries')
  ) then raise exception 'Private notification tables must never be published to Realtime'; end if;
end;
$push_foundation_verify$;
