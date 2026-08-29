-- Fail-closed provider dispatch and receipt lifecycle. These routines remain
-- inert unless both the application worker gate and private runtime gate are
-- explicitly enabled after production acceptance.

create unique index if not exists notification_deliveries_id_device_idx
  on private.notification_deliveries (id, device_id);

alter table private.notification_deliveries
  drop constraint if exists notification_deliveries_state_check,
  add constraint notification_deliveries_state_check check (
    state in (
      'pending', 'leased', 'sending', 'accepted', 'unknown', 'delivered',
      'retry', 'failed', 'dead', 'expired', 'cancelled'
    )
  );

create table if not exists private.notification_receipt_checks (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null,
  device_id uuid not null,
  provider_ticket_id text not null unique,
  state text not null default 'pending' check (
    state in ('pending', 'leased', 'retry', 'complete', 'dead', 'expired')
  ),
  attempts integer not null default 0 check (attempts between 0 and 20),
  available_at timestamptz not null default (now() + interval '15 minutes'),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_provider_code text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  updated_at timestamptz not null default now(),
  unique (delivery_id),
  constraint notification_receipt_checks_delivery_device_fkey
    foreign key (delivery_id, device_id)
    references private.notification_deliveries(id, device_id)
    on delete cascade,
  constraint notification_receipt_checks_ticket_length
    check (char_length(provider_ticket_id) between 1 and 240),
  constraint notification_receipt_checks_lease_pair check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  ),
  constraint notification_receipt_checks_code_length
    check (last_provider_code is null or char_length(last_provider_code) between 1 and 80),
  constraint notification_receipt_checks_expiry check (expires_at > created_at)
);

create index if not exists notification_receipt_checks_claim_idx
  on private.notification_receipt_checks (available_at, created_at)
  where state in ('pending', 'retry', 'leased');

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

  -- A sending lease means the provider request may already have crossed the
  -- network boundary. Expiry is ambiguous and must never become a blind retry.
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
  update private.notification_deliveries delivery set
    state = 'sending',
    lease_expires_at = now() + make_interval(secs => target_lease_seconds),
    updated_at = now()
  from unnest(target_delivery_ids, target_lease_tokens) target(delivery_id, lease_token),
    private.notification_devices device,
    private.notification_outbox queue,
    private.notification_consents consent,
    public.notification_preferences preference
  where delivery.id = target.delivery_id and delivery.state = 'leased'
    and delivery.lease_token = target.lease_token and delivery.lease_expires_at > now()
    and device.id = delivery.device_id and device.revoked_at is null
    and device.last_seen_at > now() - interval '30 days'
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
declare claimed private.notification_deliveries%rowtype;
begin
  if target_delivery_id is null or target_lease_token is null
    or target_state not in ('accepted', 'unknown', 'retry', 'failed', 'dead')
    or (target_provider_ticket_id is not null and char_length(target_provider_ticket_id) not between 1 and 240)
    or (target_provider_code is not null and char_length(target_provider_code) not between 1 and 80)
    or (target_retry_after_seconds is not null and target_retry_after_seconds not between 15 and 86400)
    or (target_state = 'accepted' and target_provider_ticket_id is null)
  then raise exception using errcode = '22023', message = 'Invalid notification delivery result'; end if;

  update private.notification_deliveries delivery set
    state = target_state,
    provider_ticket_id = coalesce(target_provider_ticket_id, delivery.provider_ticket_id),
    last_provider_code = target_provider_code,
    accepted_at = case when target_state = 'accepted' then now() else delivery.accepted_at end,
    available_at = case when target_state = 'retry'
      then now() + make_interval(secs => coalesce(target_retry_after_seconds, 60))
      else delivery.available_at end,
    lease_token = null, lease_expires_at = null, updated_at = now()
  where delivery.id = target_delivery_id
    and (
      (target_state in ('accepted', 'unknown') and delivery.state = 'sending')
      or (target_state not in ('accepted', 'unknown') and delivery.state in ('leased', 'sending'))
    )
    and delivery.lease_token = target_lease_token and delivery.lease_expires_at > now()
  returning delivery.* into claimed;
  if claimed.id is null then
    raise exception using errcode = '40001', message = 'Notification lease is stale';
  end if;

  if target_state = 'accepted' then
    insert into private.notification_receipt_checks (
      delivery_id, device_id, provider_ticket_id
    ) values (
      claimed.id, claimed.device_id, target_provider_ticket_id
    ) on conflict (delivery_id) do update set
      provider_ticket_id = excluded.provider_ticket_id,
      state = 'pending', attempts = 0,
      available_at = now() + interval '15 minutes',
      lease_token = null, lease_expires_at = null,
      last_provider_code = null,
      expires_at = now() + interval '24 hours',
      updated_at = now();
  end if;

  if target_state = 'dead' and target_provider_code = 'DeviceNotRegistered' then
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

create or replace function private.claim_notification_receipts(
  target_worker_id uuid,
  target_batch_size integer default 100,
  target_lease_seconds integer default 60
)
returns table (
  receipt_check_id uuid,
  delivery_id uuid,
  device_id uuid,
  provider_ticket_id text,
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
  then raise exception using errcode = '22023', message = 'Invalid notification receipt claim'; end if;
  if not coalesce((
    select delivery_enabled from private.notification_runtime_settings where singleton
  ), false) then return; end if;

  update private.notification_receipt_checks receipt set
    state = 'expired', lease_token = null, lease_expires_at = null,
    last_provider_code = 'receipt_expired', updated_at = now()
  where receipt.expires_at <= now()
    and receipt.state not in ('complete', 'dead', 'expired');

  return query
  with candidates as (
    select receipt.id
    from private.notification_receipt_checks receipt
    join private.notification_deliveries delivery on delivery.id = receipt.delivery_id
    where receipt.expires_at > now()
      and receipt.attempts < 20
      and receipt.available_at <= now()
      and delivery.state in ('accepted', 'unknown')
      and (
        receipt.state in ('pending', 'retry')
        or (receipt.state = 'leased' and receipt.lease_expires_at <= now())
      )
    order by receipt.created_at, receipt.id
    for update of receipt skip locked
    limit target_batch_size
  ), claimed as (
    update private.notification_receipt_checks receipt set
      state = 'leased', attempts = receipt.attempts + 1,
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => target_lease_seconds),
      updated_at = now()
    from candidates where receipt.id = candidates.id
    returning receipt.*
  )
  select claimed.id, claimed.delivery_id, claimed.device_id,
    claimed.provider_ticket_id, claimed.lease_token
  from claimed order by claimed.created_at, claimed.id;
end;
$$;

create or replace function private.record_notification_receipt_result(
  target_receipt_check_id uuid,
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
declare claimed private.notification_receipt_checks%rowtype;
begin
  if target_receipt_check_id is null or target_lease_token is null
    or target_state not in ('delivered', 'retry', 'failed', 'dead')
    or (target_provider_code is not null and char_length(target_provider_code) not between 1 and 80)
    or (target_retry_after_seconds is not null and target_retry_after_seconds not between 15 and 86400)
  then raise exception using errcode = '22023', message = 'Invalid notification receipt result'; end if;

  select * into claimed from private.notification_receipt_checks receipt
  where receipt.id = target_receipt_check_id and receipt.state = 'leased'
    and receipt.lease_token = target_lease_token and receipt.lease_expires_at > now()
  for update;
  if claimed.id is null then
    raise exception using errcode = '40001', message = 'Notification receipt lease is stale';
  end if;

  update private.notification_receipt_checks receipt set
    state = case
      when target_state = 'delivered' then 'complete'
      when target_state = 'retry' then 'retry'
      else 'dead'
    end,
    available_at = case when target_state = 'retry'
      then now() + make_interval(secs => coalesce(target_retry_after_seconds, 300))
      else receipt.available_at end,
    lease_token = null, lease_expires_at = null,
    last_provider_code = target_provider_code, updated_at = now()
  where receipt.id = claimed.id;

  if target_state <> 'retry' then
    update private.notification_deliveries delivery set
      state = target_state,
      delivered_at = case when target_state = 'delivered' then now() else delivery.delivered_at end,
      last_provider_code = target_provider_code,
      updated_at = now()
    where delivery.id = claimed.delivery_id and delivery.state in ('accepted', 'unknown');
  end if;

  if target_provider_code = 'DeviceNotRegistered' then
    update private.notification_devices device set
      revoked_at = coalesce(device.revoked_at, now()),
      revoke_reason = coalesce(device.revoke_reason, 'provider_invalid'),
      updated_at = now()
    where device.id = claimed.device_id;
    update private.notification_deliveries delivery set
      state = 'cancelled', lease_token = null, lease_expires_at = null,
      last_provider_code = 'device_revoked', updated_at = now()
    where delivery.device_id = claimed.device_id
      and delivery.id <> claimed.delivery_id
      and delivery.state in ('pending', 'leased', 'retry', 'unknown');
  end if;
end;
$$;

-- PostgREST exposes only the public schema. These wrappers expose no private
-- rows to clients and remain executable only by the service role.
create or replace function public.claim_notification_outbox_server(
  target_worker_id uuid, target_batch_size integer, target_lease_seconds integer
)
returns table (
  outbox_id uuid, source_event_id bigint, business_id uuid,
  notification_kind text, lease_token uuid, expires_at timestamptz
)
language sql volatile security definer set search_path = ''
as $$ select * from private.claim_notification_outbox(target_worker_id, target_batch_size, target_lease_seconds) $$;

create or replace function public.expand_notification_outbox_server(
  target_outbox_id uuid, target_lease_token uuid, target_user_batch_size integer
)
returns integer
language sql volatile security definer set search_path = ''
as $$ select private.expand_notification_outbox(target_outbox_id, target_lease_token, target_user_batch_size) $$;

create or replace function public.claim_notification_deliveries_server(
  target_worker_id uuid, target_batch_size integer, target_lease_seconds integer
)
returns table (
  delivery_id uuid, device_id uuid, user_id uuid, business_id uuid,
  source_event_id bigint, notification_kind text, provider text,
  token_ciphertext text, token_nonce text, encryption_key_version integer,
  lease_token uuid
)
language sql volatile security definer set search_path = ''
as $$ select * from private.claim_notification_deliveries(target_worker_id, target_batch_size, target_lease_seconds) $$;

create or replace function public.record_notification_delivery_result_server(
  target_delivery_id uuid, target_lease_token uuid, target_state text,
  target_provider_ticket_id text, target_provider_code text,
  target_retry_after_seconds integer
)
returns void
language sql volatile security definer set search_path = ''
as $$ select private.record_notification_delivery_result(
  target_delivery_id, target_lease_token, target_state, target_provider_ticket_id,
  target_provider_code, target_retry_after_seconds
) $$;

create or replace function public.mark_notification_delivery_batch_sending_server(
  target_delivery_ids uuid[], target_lease_tokens uuid[], target_lease_seconds integer
)
returns void
language sql volatile security definer set search_path = ''
as $$ select private.mark_notification_delivery_batch_sending(
  target_delivery_ids, target_lease_tokens, target_lease_seconds
) $$;

create or replace function public.claim_notification_receipts_server(
  target_worker_id uuid, target_batch_size integer, target_lease_seconds integer
)
returns table (
  receipt_check_id uuid, delivery_id uuid, device_id uuid,
  provider_ticket_id text, lease_token uuid
)
language sql volatile security definer set search_path = ''
as $$ select * from private.claim_notification_receipts(target_worker_id, target_batch_size, target_lease_seconds) $$;

create or replace function public.record_notification_receipt_result_server(
  target_receipt_check_id uuid, target_lease_token uuid, target_state text,
  target_provider_code text, target_retry_after_seconds integer
)
returns void
language sql volatile security definer set search_path = ''
as $$ select private.record_notification_receipt_result(
  target_receipt_check_id, target_lease_token, target_state,
  target_provider_code, target_retry_after_seconds
) $$;

revoke all privileges on table private.notification_receipt_checks
  from public, anon, authenticated;

revoke all on function private.claim_notification_receipts(uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function private.record_notification_receipt_result(uuid, uuid, text, text, integer)
  from public, anon, authenticated;
revoke all on function private.mark_notification_delivery_batch_sending(uuid[], uuid[], integer)
  from public, anon, authenticated;
grant execute on function private.claim_notification_receipts(uuid, integer, integer)
  to service_role;
grant execute on function private.record_notification_receipt_result(uuid, uuid, text, text, integer)
  to service_role;
grant execute on function private.mark_notification_delivery_batch_sending(uuid[], uuid[], integer)
  to service_role;

revoke all on function public.claim_notification_outbox_server(uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function public.expand_notification_outbox_server(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.claim_notification_deliveries_server(uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function public.record_notification_delivery_result_server(uuid, uuid, text, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.mark_notification_delivery_batch_sending_server(uuid[], uuid[], integer)
  from public, anon, authenticated;
revoke all on function public.claim_notification_receipts_server(uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function public.record_notification_receipt_result_server(uuid, uuid, text, text, integer)
  from public, anon, authenticated;

grant execute on function public.claim_notification_outbox_server(uuid, integer, integer)
  to service_role;
grant execute on function public.expand_notification_outbox_server(uuid, uuid, integer)
  to service_role;
grant execute on function public.claim_notification_deliveries_server(uuid, integer, integer)
  to service_role;
grant execute on function public.record_notification_delivery_result_server(uuid, uuid, text, text, text, integer)
  to service_role;
grant execute on function public.mark_notification_delivery_batch_sending_server(uuid[], uuid[], integer)
  to service_role;
grant execute on function public.claim_notification_receipts_server(uuid, integer, integer)
  to service_role;
grant execute on function public.record_notification_receipt_result_server(uuid, uuid, text, text, integer)
  to service_role;
