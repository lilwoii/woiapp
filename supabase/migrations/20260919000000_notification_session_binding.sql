-- Bind every push registration to the verified Supabase Auth session that
-- created it. Push remains disabled; legacy unbound registrations are retired
-- instead of being guessed or silently inherited by another account.

alter table private.notification_devices
  add column if not exists auth_session_id uuid;

update private.notification_devices
set revoked_at = coalesce(revoked_at, now()),
  revoke_reason = case when revoked_at is null then 'session_binding_required' else revoke_reason end,
  updated_at = now()
where auth_session_id is null;

update private.notification_deliveries delivery
set state = 'cancelled',
  lease_token = null,
  lease_expires_at = null,
  last_provider_code = 'session_binding_required',
  updated_at = now()
from private.notification_devices device
where device.id = delivery.device_id
  and device.auth_session_id is null
  and delivery.state in ('pending', 'leased', 'retry', 'unknown');

alter table private.notification_devices
  drop constraint if exists notification_devices_active_session_required,
  add constraint notification_devices_active_session_required check (
    revoked_at is not null or auth_session_id is not null
  );

drop index if exists private.notification_devices_active_installation_idx;
create unique index notification_devices_active_installation_idx
  on private.notification_devices (provider, installation_id)
  where revoked_at is null;

create index if not exists notification_devices_active_session_idx
  on private.notification_devices (auth_session_id, user_id)
  where revoked_at is null;

drop function if exists public.register_notification_device_server(
  uuid, uuid, text, uuid, text, text, text, integer, text, text, text, text, text
);
drop function if exists private.register_notification_device(
  uuid, uuid, text, text, uuid, text, text, text, integer, text, text, text
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
    or target_installation_id is null or target_project_id is null
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
    or not exists (
      select 1 from auth.sessions auth_session
      where auth_session.id = target_auth_session_id
        and auth_session.user_id = target_user_id
        and (auth_session.not_after is null or auth_session.not_after > now())
    )
  then
    raise exception using errcode = '22023', message = 'Invalid notification device';
  end if;

  -- Serialize registration against Auth session deletion. A concurrent sign-out
  -- either waits for this transaction or wins first and leaves no row to lock.
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

create or replace function public.register_notification_device_server(
  target_user_id uuid,
  target_auth_session_id uuid,
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
    target_user_id, target_auth_session_id, target_installation_id,
    target_platform, 'expo', target_project_id, target_token_hash,
    target_token_ciphertext, target_token_nonce, target_encryption_key_version,
    target_timezone, target_app_version, target_permission_state
  );
  return device_id;
end;
$$;

create or replace function private.revoke_notification_devices_without_session()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare stale_device_ids uuid[] := '{}'::uuid[];
begin
  with stale as (
    update private.notification_devices device set
      revoked_at = now(), revoke_reason = 'auth_session_ended', updated_at = now()
    where device.revoked_at is null
      and not exists (
        select 1 from auth.sessions auth_session
        where auth_session.id = device.auth_session_id
          and auth_session.user_id = device.user_id
          and (auth_session.not_after is null or auth_session.not_after > now())
      )
    returning device.id
  )
  select coalesce(array_agg(stale.id), '{}'::uuid[])
  into stale_device_ids
  from stale;

  update private.notification_deliveries delivery set
    state = 'cancelled', lease_token = null, lease_expires_at = null,
    last_provider_code = 'auth_session_ended', updated_at = now()
  where delivery.device_id = any(stale_device_ids)
    and delivery.state in ('pending', 'leased', 'retry', 'unknown');

  return cardinality(stale_device_ids);
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
  if not coalesce((
    select delivery_enabled from private.notification_runtime_settings where singleton
  ), false) then return; end if;

  perform private.revoke_notification_devices_without_session();

  update private.notification_deliveries delivery set
    state = 'unknown', lease_token = null, lease_expires_at = null,
    last_provider_code = 'worker_handoff_ambiguous', updated_at = now()
  where delivery.state = 'sending' and delivery.lease_expires_at <= now();

  update private.notification_deliveries delivery set
    state = 'expired', lease_token = null, lease_expires_at = null, updated_at = now()
  from private.notification_outbox queue
  where queue.id = delivery.outbox_id and queue.expires_at <= now()
    and delivery.state not in ('sending', 'delivered', 'dead', 'expired');

  return query
  with candidates as (
    select delivery.id
    from private.notification_deliveries delivery
    join private.notification_outbox queue on queue.id = delivery.outbox_id
    join private.notification_devices device on device.id = delivery.device_id
    join auth.sessions auth_session on auth_session.id = device.auth_session_id
      and auth_session.user_id = device.user_id
      and (auth_session.not_after is null or auth_session.not_after > now())
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
  from claimed
  join private.notification_devices device on device.id = claimed.device_id
  join auth.sessions auth_session on auth_session.id = device.auth_session_id
    and auth_session.user_id = device.user_id
    and (auth_session.not_after is null or auth_session.not_after > now())
  order by claimed.created_at, claimed.id;
end;
$$;

create or replace function private.mark_notification_delivery_batch_sending(
  target_delivery_ids uuid[],
  target_lease_tokens uuid[],
  target_lease_seconds integer default 60
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare affected integer;
begin
  if target_delivery_ids is null or target_lease_tokens is null
    or cardinality(target_delivery_ids) not between 1 and 100
    or cardinality(target_delivery_ids) <> cardinality(target_lease_tokens)
    or exists (select 1 from unnest(target_delivery_ids) as item(value) where value is null)
    or exists (select 1 from unnest(target_lease_tokens) as item(value) where value is null)
    or (select count(distinct value) from unnest(target_delivery_ids) as item(value))
      <> cardinality(target_delivery_ids)
    or target_lease_seconds not between 15 and 300
  then raise exception using errcode = '22023', message = 'Invalid notification send handoff'; end if;

  perform private.revoke_notification_devices_without_session();

  update private.notification_deliveries delivery set
    state = 'sending',
    lease_expires_at = now() + make_interval(secs => target_lease_seconds),
    updated_at = now()
  from unnest(target_delivery_ids, target_lease_tokens) target(delivery_id, lease_token),
    private.notification_devices device,
    auth.sessions auth_session,
    private.notification_outbox queue,
    private.notification_consents consent,
    public.notification_preferences preference
  where delivery.id = target.delivery_id and delivery.state = 'leased'
    and delivery.lease_token = target.lease_token and delivery.lease_expires_at > now()
    and device.id = delivery.device_id and device.revoked_at is null
    and device.last_seen_at > now() - interval '30 days'
    and auth_session.id = device.auth_session_id
    and auth_session.user_id = device.user_id
    and (auth_session.not_after is null or auth_session.not_after > now())
    and queue.id = delivery.outbox_id and queue.expires_at > now()
    and consent.user_id = delivery.user_id
    and consent.consent_kind = 'product_updates' and consent.granted
    and preference.user_id = delivery.user_id
    and preference.business_id = delivery.business_id
    and coalesce(case delivery.notification_kind
      when 'owner_update' then preference.owner_update
      when 'location_change' then preference.location_change
      when 'menu_return' then preference.menu_return
      else false
    end, false)
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
    );
  get diagnostics affected = row_count;
  if affected <> cardinality(target_delivery_ids) then
    raise exception using errcode = '40001', message = 'Notification lease is stale';
  end if;
end;
$$;

revoke all on function private.register_notification_device(
  uuid, uuid, uuid, text, text, uuid, text, text, text, integer, text, text, text
) from public, anon, authenticated;
grant execute on function private.register_notification_device(
  uuid, uuid, uuid, text, text, uuid, text, text, text, integer, text, text, text
) to service_role;

revoke all on function public.register_notification_device_server(
  uuid, uuid, uuid, text, uuid, text, text, text, integer, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.register_notification_device_server(
  uuid, uuid, uuid, text, uuid, text, text, text, integer, text, text, text, text, text
) to service_role;

revoke all on function private.revoke_notification_devices_without_session()
  from public, anon, authenticated;
grant execute on function private.revoke_notification_devices_without_session()
  to service_role;
