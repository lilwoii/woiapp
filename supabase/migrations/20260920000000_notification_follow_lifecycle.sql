-- Revoke queued push work when a user stops following a business. Delivery
-- claim and provider handoff both re-check the follow relation so a stale
-- client or concurrent unfollow cannot send queued work after opt-out.

create or replace function private.cancel_notification_deliveries_for_unfollow()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update private.notification_deliveries delivery set
    state = 'cancelled',
    lease_token = null,
    lease_expires_at = null,
    last_provider_code = 'follow_removed',
    updated_at = now()
  where delivery.user_id = old.user_id
    and delivery.business_id = old.business_id
    and delivery.state in ('pending', 'leased', 'retry', 'unknown');
  return old;
end;
$$;

revoke all on function private.cancel_notification_deliveries_for_unfollow()
  from public, anon, authenticated;

drop trigger if exists cancel_notification_deliveries_for_unfollow
  on public.follows;
create trigger cancel_notification_deliveries_for_unfollow
after delete on public.follows
for each row execute function private.cancel_notification_deliveries_for_unfollow();

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
    join public.follows followed on followed.user_id = delivery.user_id
      and followed.business_id = delivery.business_id
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
  join public.follows followed on followed.user_id = claimed.user_id
    and followed.business_id = claimed.business_id
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
    public.notification_preferences preference,
    public.follows followed
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
    and followed.user_id = delivery.user_id
    and followed.business_id = delivery.business_id
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

revoke all on function private.claim_notification_deliveries(uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function private.claim_notification_deliveries(uuid, integer, integer)
  to service_role;
revoke all on function private.mark_notification_delivery_batch_sending(uuid[], uuid[], integer)
  from public, anon, authenticated;
grant execute on function private.mark_notification_delivery_batch_sending(uuid[], uuid[], integer)
  to service_role;
