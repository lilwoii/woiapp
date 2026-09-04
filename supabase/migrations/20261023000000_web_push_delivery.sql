-- Standard Web Push delivery. Browser subscriptions remain encrypted in the
-- private notification device table and are never projected through PostgREST
-- or Realtime. All client, registration, worker, and provider gates remain
-- independently default-off until VAPID and signed-browser acceptance exists.

alter table private.notification_devices
  drop constraint if exists notification_devices_platform_check,
  drop constraint if exists notification_devices_provider_check;

alter table private.notification_devices
  alter column project_id drop not null;

alter table private.notification_devices
  add constraint notification_devices_platform_check
    check (platform in ('ios', 'android', 'web')),
  add constraint notification_devices_provider_check
    check (provider in ('expo', 'web_push')),
  add constraint notification_devices_provider_shape check (
    (provider = 'expo' and platform in ('ios', 'android') and project_id is not null)
    or
    (provider = 'web_push' and platform = 'web' and project_id is null
      and permission_state = 'granted')
  );

create or replace function private.register_notification_device(
  target_user_id uuid,
  target_auth_session_id uuid,
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
declare
  device_id uuid;
  revoked_device_ids uuid[] := '{}'::uuid[];
  rotated_device_ids uuid[] := '{}'::uuid[];
begin
  if target_user_id is null or target_auth_session_id is null
    or target_installation_id is null
    or not (
      (target_provider = 'expo' and target_platform in ('ios', 'android')
        and target_project_id is not null
        and target_permission_state in ('granted', 'provisional'))
      or
      (target_provider = 'web_push' and target_platform = 'web'
        and target_project_id is null and target_permission_state = 'granted')
    )
    or target_token_hash !~ '^[0-9a-f]{64}$'
    or target_token_ciphertext is null
    or char_length(target_token_ciphertext) not between 24 and 2048
    or target_token_nonce !~ '^[A-Za-z0-9_-]{16}$'
    or target_encryption_key_version not between 1 and 2147483647
    or target_app_version is null or char_length(target_app_version) not between 1 and 80
    or target_timezone is null or char_length(target_timezone) not between 1 and 64
    or not exists (select 1 from pg_catalog.pg_timezone_names zone where zone.name = target_timezone)
    or not private.is_active_user(target_user_id)
    or not exists (
      select 1 from auth.sessions auth_session
      where auth_session.id = target_auth_session_id
        and auth_session.user_id = target_user_id
        and (auth_session.not_after is null or auth_session.not_after > now())
    )
  then
    raise exception using errcode = '22023', message = 'Invalid notification device';
  end if;

  perform 1
  from auth.sessions auth_session
  where auth_session.id = target_auth_session_id
    and auth_session.user_id = target_user_id
    and (auth_session.not_after is null or auth_session.not_after > now())
  for key share;
  if not found then
    raise exception using errcode = '22023', message = 'Invalid notification device';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_provider || ':' || target_token_hash, 917170)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_provider || ':' || target_installation_id::text, 917171)
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
      auth_session_id = target_auth_session_id,
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

  with revoked as (
    update private.notification_devices device set
      revoked_at = now(), revoke_reason = 'ownership_changed', updated_at = now()
    where device.revoked_at is null
      and device.provider = target_provider
      and (
        (device.token_hash = target_token_hash
          and (device.user_id <> target_user_id or device.installation_id <> target_installation_id))
        or (device.installation_id = target_installation_id and device.user_id <> target_user_id)
      )
    returning device.id
  )
  select coalesce(array_agg(revoked.id), '{}'::uuid[])
  into revoked_device_ids
  from revoked;

  with rotated as (
    update private.notification_devices device set
      revoked_at = now(), revoke_reason = 'token_rotated', updated_at = now()
    where device.revoked_at is null
      and device.user_id = target_user_id
      and device.provider = target_provider
      and device.installation_id = target_installation_id
    returning device.id
  )
  select coalesce(array_agg(rotated.id), '{}'::uuid[])
  into rotated_device_ids
  from rotated;

  update private.notification_deliveries delivery set
    state = 'cancelled', lease_token = null, lease_expires_at = null,
    last_provider_code = 'device_rebound', updated_at = now()
  where delivery.device_id = any(revoked_device_ids || rotated_device_ids)
    and delivery.state in ('pending', 'leased', 'retry', 'unknown');

  insert into private.notification_devices (
    user_id, auth_session_id, installation_id, platform, provider, project_id,
    token_hash, token_ciphertext, token_nonce, encryption_key_version,
    timezone, app_version, permission_state
  ) values (
    target_user_id, target_auth_session_id, target_installation_id,
    target_platform, target_provider, target_project_id, target_token_hash,
    target_token_ciphertext, target_token_nonce, target_encryption_key_version,
    target_timezone, target_app_version, target_permission_state
  ) returning id into device_id;

  perform private.write_audit_event(
    target_user_id, null, 'notification.device_registered', 'notification_device',
    device_id::text, jsonb_build_object('platform', target_platform, 'provider', target_provider)
  );
  return device_id;
end;
$$;

create or replace function public.register_web_notification_device_server(
  target_user_id uuid,
  target_auth_session_id uuid,
  target_installation_id uuid,
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
    target_user_id, target_auth_session_id, target_installation_id,
    'web', 'web_push', null, target_token_hash,
    target_token_ciphertext, target_token_nonce, target_encryption_key_version,
    target_timezone, target_app_version, target_permission_state
  );
  return device_id;
end;
$$;

create or replace function private.record_web_push_delivery_result(
  target_delivery_id uuid,
  target_lease_token uuid,
  target_state text,
  target_provider_code text default null,
  target_retry_after_seconds integer default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare claimed private.notification_deliveries%rowtype;
begin
  if target_delivery_id is null or target_lease_token is null
    or target_state not in ('accepted', 'unknown', 'retry', 'failed', 'dead')
    or (target_provider_code is not null and char_length(target_provider_code) not between 1 and 80)
    or (target_retry_after_seconds is not null and target_retry_after_seconds not between 15 and 86400)
  then
    raise exception using errcode = '22023', message = 'Invalid web push delivery result';
  end if;

  update private.notification_deliveries delivery set
    state = target_state,
    provider_ticket_id = null,
    last_provider_code = target_provider_code,
    accepted_at = case when target_state = 'accepted' then now() else delivery.accepted_at end,
    available_at = case when target_state = 'retry'
      then now() + make_interval(secs => coalesce(target_retry_after_seconds, 60))
      else delivery.available_at end,
    lease_token = null, lease_expires_at = null, updated_at = now()
  from private.notification_devices device
  where delivery.id = target_delivery_id
    and device.id = delivery.device_id
    and device.provider = 'web_push'
    and (
      (target_state in ('accepted', 'unknown') and delivery.state = 'sending')
      or (target_state not in ('accepted', 'unknown') and delivery.state in ('leased', 'sending'))
    )
    and delivery.lease_token = target_lease_token
    and delivery.lease_expires_at > now()
  returning delivery.* into claimed;
  if claimed.id is null then
    raise exception using errcode = '40001', message = 'Notification lease is stale';
  end if;

  if target_state = 'dead' and target_provider_code = 'WebPushSubscriptionExpired' then
    update private.notification_devices device set
      revoked_at = coalesce(device.revoked_at, now()),
      revoke_reason = coalesce(device.revoke_reason, 'provider_invalid'),
      updated_at = now()
    where device.id = claimed.device_id;
    update private.notification_deliveries delivery set
      state = 'cancelled', lease_token = null, lease_expires_at = null,
      last_provider_code = 'device_revoked', updated_at = now()
    where delivery.device_id = claimed.device_id
      and delivery.id <> claimed.id
      and delivery.state in ('pending', 'leased', 'retry', 'unknown');
  end if;
end;
$$;

create or replace function public.record_web_push_delivery_result_server(
  target_delivery_id uuid,
  target_lease_token uuid,
  target_state text,
  target_provider_code text,
  target_retry_after_seconds integer
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  select private.record_web_push_delivery_result(
    target_delivery_id, target_lease_token, target_state,
    target_provider_code, target_retry_after_seconds
  )
$$;

revoke all on function private.register_notification_device(
  uuid, uuid, uuid, text, text, uuid, text, text, text, integer, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function private.register_notification_device(
  uuid, uuid, uuid, text, text, uuid, text, text, text, integer, text, text, text
) to service_role;

revoke all on function public.register_web_notification_device_server(
  uuid, uuid, uuid, text, text, text, integer, text, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.register_web_notification_device_server(
  uuid, uuid, uuid, text, text, text, integer, text, text, text, text, text
) to service_role;

revoke all on function private.record_web_push_delivery_result(uuid, uuid, text, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function private.record_web_push_delivery_result(uuid, uuid, text, text, integer)
  to service_role;
revoke all on function public.record_web_push_delivery_result_server(uuid, uuid, text, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.record_web_push_delivery_result_server(uuid, uuid, text, text, integer)
  to service_role;
