-- A queued notification must never cross claim or provider handoff after its
-- business stops being publicly eligible. Push remains disabled by default;
-- this revalidation is a required pre-activation invariant.

create or replace function private.lock_notification_business_eligibility(
  target_business_ids uuid[]
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare normalized_ids uuid[];
begin
  select coalesce(array_agg(distinct item.id order by item.id), '{}'::uuid[])
  into normalized_ids
  from unnest(coalesce(target_business_ids, '{}'::uuid[])) item(id)
  where item.id is not null;

  if cardinality(normalized_ids) > 250 then
    raise exception using errcode = '22023', message = 'Too many notification businesses to lock';
  end if;
  if cardinality(normalized_ids) = 0 then return; end if;

  -- Every row that can make is_business_publicly_eligible() turn false is
  -- locked before the predicate is evaluated in the following statement.
  -- Inserts into the child tables can only add eligibility; updates and
  -- deletes conflict with these SHARE locks.
  perform business.id
  from public.businesses business
  where business.id = any(normalized_ids)
  order by business.id
  for share of business;

  perform account.provider_slug
  from private.provider_accounts account
  where exists (
    select 1
    from private.provider_business_sources source
    where source.business_id = any(normalized_ids)
      and source.provider_slug = account.provider_slug
  )
  order by account.provider_slug
  for share of account;

  perform source.provider_slug
  from private.provider_business_sources source
  where source.business_id = any(normalized_ids)
  order by source.business_id, source.provider_slug, source.provider_external_id
  for share of source;

  perform jurisdiction.id
  from public.jurisdictions jurisdiction
  where exists (
    select 1
    from public.businesses business
    where business.id = any(normalized_ids)
      and business.jurisdiction_id = jurisdiction.id
  )
  order by jurisdiction.id
  for share of jurisdiction;

  perform permit.business_id
  from public.home_kitchen_permits permit
  where permit.business_id = any(normalized_ids)
  order by permit.business_id
  for share of permit;
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
declare locked_business_ids uuid[] := '{}'::uuid[];
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
    and delivery.state not in ('sending', 'delivered', 'dead', 'expired', 'cancelled');

  select coalesce(
    array_agg(distinct candidate.business_id order by candidate.business_id),
    '{}'::uuid[]
  )
  into locked_business_ids
  from (
    select delivery.business_id
    from private.notification_deliveries delivery
    join private.notification_outbox queue on queue.id = delivery.outbox_id
    where queue.expires_at > now()
      and delivery.attempts < 20
      and delivery.available_at <= now()
      and (
        delivery.state in ('pending', 'retry')
        or (delivery.state = 'leased' and delivery.lease_expires_at <= now())
      )
    order by delivery.created_at, delivery.id
    limit target_batch_size
  ) candidate;
  perform private.lock_notification_business_eligibility(locked_business_ids);

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
      and delivery.business_id = any(locked_business_ids)
      and private.is_active_user(delivery.user_id)
      and private.is_business_publicly_eligible(delivery.business_id)
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
declare
  affected integer;
  locked_business_ids uuid[] := '{}'::uuid[];
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

  select coalesce(
    array_agg(distinct delivery.business_id order by delivery.business_id),
    '{}'::uuid[]
  )
  into locked_business_ids
  from unnest(target_delivery_ids, target_lease_tokens) target(delivery_id, lease_token)
  join private.notification_deliveries delivery
    on delivery.id = target.delivery_id
   and delivery.lease_token = target.lease_token;
  perform private.lock_notification_business_eligibility(locked_business_ids);

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
    and private.is_active_user(delivery.user_id)
    and private.is_business_publicly_eligible(delivery.business_id)
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

revoke all on function private.lock_notification_business_eligibility(uuid[])
  from public, anon, authenticated;
grant execute on function private.lock_notification_business_eligibility(uuid[])
  to service_role;
revoke all on function private.claim_notification_deliveries(uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function private.claim_notification_deliveries(uuid, integer, integer)
  to service_role;
revoke all on function private.mark_notification_delivery_batch_sending(uuid[], uuid[], integer)
  from public, anon, authenticated;
grant execute on function private.mark_notification_delivery_batch_sending(uuid[], uuid[], integer)
  to service_role;
