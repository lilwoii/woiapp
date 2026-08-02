-- Merchant and trust-operations projections for safe marketplace pickup.
-- Raw chat and exact-location tables remain unavailable to application clients.

create or replace function public.get_business_marketplace_controls(target_business_id uuid)
returns table (
  business_id uuid,
  business_name text,
  business_kind text,
  chat_enabled boolean,
  chat_required boolean,
  can_toggle_chat boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  perform private.require_aal2();
  if not private.is_business_member(
    target_business_id,
    actor,
    array['owner', 'manager']::public.member_role[]
  ) then
    raise exception using errcode = '42501', message = 'BUSINESS_MANAGER_REQUIRED';
  end if;

  return query
  select
    business.id,
    business.name,
    business.kind::text,
    case
      when business.kind = 'home_kitchen' then true
      else coalesce(setting.enabled, false)
    end,
    business.kind = 'home_kitchen',
    business.kind = 'pop_up'
  from public.businesses business
  left join public.business_marketplace_chat_settings setting
    on setting.business_id = business.id
  where business.id = target_business_id
    and business.kind in ('home_kitchen', 'pop_up');
end;
$$;

revoke all on function public.get_business_marketplace_controls(uuid) from public, anon;
grant execute on function public.get_business_marketplace_controls(uuid) to authenticated;

create or replace function public.list_managed_marketplace_pickup_sites(
  target_business_id uuid,
  result_limit integer default 50,
  result_offset integer default 0
)
returns table (
  pickup_site_public_id uuid,
  label text,
  site_kind text,
  state text,
  address_line text,
  city text,
  region text,
  postal_code text,
  latitude double precision,
  longitude double precision,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  updated_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  bounded_limit integer := least(greatest(coalesce(result_limit, 50), 1), 100);
  bounded_offset integer := least(greatest(coalesce(result_offset, 0), 0), 10000);
  returned_count integer;
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  perform private.require_aal2();
  if not private.is_business_member(
    target_business_id,
    actor,
    array['owner', 'manager']::public.member_role[]
  ) then
    raise exception using errcode = '42501', message = 'BUSINESS_MANAGER_REQUIRED';
  end if;

  perform private.consume_rate_limit(actor, 'managed_pickup_sites_hour', 120, 3600);
  return query
  select
    site.public_id,
    site.label,
    site.site_kind,
    site.state,
    details.address_line,
    site.city,
    site.region,
    details.postal_code,
    details.latitude,
    details.longitude,
    site.created_at,
    site.reviewed_at,
    site.updated_at
  from public.marketplace_pickup_sites site
  join private.marketplace_pickup_site_details details on details.site_id = site.id
  where site.business_id = target_business_id
    and site.state <> 'archived'
  order by site.updated_at desc, site.id
  limit bounded_limit
  offset bounded_offset;
  get diagnostics returned_count = row_count;

  perform private.write_audit_event(
    actor,
    target_business_id,
    'marketplace_pickup.manager_sites_accessed',
    'business',
    target_business_id::text,
    jsonb_build_object('result_count', returned_count)
  );
end;
$$;

revoke all on function public.list_managed_marketplace_pickup_sites(uuid, integer, integer)
  from public, anon;
grant execute on function public.list_managed_marketplace_pickup_sites(uuid, integer, integer)
  to authenticated;

create or replace function public.archive_marketplace_pickup_site(
  target_pickup_site_public_id uuid,
  expected_updated_at timestamptz,
  idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_site public.marketplace_pickup_sites%rowtype;
  key_hash text;
  request_hash text;
  prior_response jsonb;
  response jsonb;
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  perform private.require_aal2();

  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'pickup_site_public_id', target_pickup_site_public_id,
    'expected_updated_at', expected_updated_at
  ));
  prior_response := private.marketplace_chat_idempotent_response(
    actor,
    'archive_marketplace_pickup_site',
    key_hash,
    request_hash
  );
  if prior_response is not null then
    return prior_response;
  end if;

  select site.*
  into target_site
  from public.marketplace_pickup_sites site
  where site.public_id = target_pickup_site_public_id
  for update;

  if not found or not private.is_business_member(
    target_site.business_id,
    actor,
    array['owner', 'manager']::public.member_role[]
  ) then
    raise exception using errcode = '42501', message = 'BUSINESS_MANAGER_REQUIRED';
  end if;
  if target_site.updated_at <> expected_updated_at then
    raise exception using errcode = '40001', message = 'PICKUP_SITE_CHANGED';
  end if;
  if target_site.state = 'archived' then
    raise exception using errcode = '22023', message = 'PICKUP_SITE_ALREADY_ARCHIVED';
  end if;

  perform private.consume_rate_limit(actor, 'archive_pickup_site_hour', 30, 3600);

  update public.marketplace_pickup_requests request
  set state = 'cancelled',
      version = request.version + 1,
      responded_by = actor,
      responded_at = now(),
      updated_at = now()
  where request.id in (
    select disclosure.request_id
    from private.marketplace_pickup_disclosures disclosure
    where disclosure.site_id = target_site.id
  )
    and request.state = 'authorized';

  delete from private.marketplace_pickup_disclosures disclosure
  where disclosure.site_id = target_site.id;

  update public.marketplace_pickup_sites
  set state = 'archived', updated_at = now()
  where id = target_site.id;

  response := jsonb_build_object(
    'pickup_site_public_id', target_site.public_id,
    'state', 'archived'
  );
  perform private.store_marketplace_chat_idempotency(
    actor,
    'archive_marketplace_pickup_site',
    key_hash,
    request_hash,
    response
  );
  perform private.write_audit_event(
    actor,
    target_site.business_id,
    'marketplace_pickup.site_archived',
    'marketplace_pickup_site',
    target_site.public_id::text,
    jsonb_build_object('active_disclosures_destroyed', true)
  );
  return response;
end;
$$;

revoke all on function public.archive_marketplace_pickup_site(uuid, timestamptz, text)
  from public, anon;
grant execute on function public.archive_marketplace_pickup_site(uuid, timestamptz, text)
  to authenticated;

-- Turning off pop-up chat is a durable closure, not a reversible write pause.
-- This avoids silently reviving old conversations if chat is enabled later.
create or replace function private.close_pop_up_chat_on_disable()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if new.enabled
    or (tg_op = 'UPDATE' and old.enabled = new.enabled)
    or not exists (
      select 1 from public.businesses business
      where business.id = new.business_id and business.kind = 'pop_up'
    )
  then
    return new;
  end if;

  update public.marketplace_pickup_requests request
  set state = 'cancelled',
      version = request.version + 1,
      responded_by = coalesce(auth.uid(), new.updated_by),
      responded_at = now(),
      updated_at = now()
  where request.conversation_id in (
    select conversation.id
    from public.marketplace_conversations conversation
    where conversation.business_id = new.business_id
      and conversation.state = 'open'
  )
    and request.state in ('pending', 'authorized');

  delete from private.marketplace_pickup_disclosures disclosure
  using public.marketplace_pickup_requests request,
        public.marketplace_conversations conversation
  where disclosure.request_id = request.id
    and request.conversation_id = conversation.id
    and conversation.business_id = new.business_id;

  update public.marketplace_conversations conversation
  set state = 'closed_by_merchant', updated_at = now()
  where conversation.business_id = new.business_id
    and conversation.state = 'open';
  return new;
end;
$$;

revoke all on function private.close_pop_up_chat_on_disable() from public, anon, authenticated;
drop trigger if exists close_pop_up_chat_on_disable on public.business_marketplace_chat_settings;
create trigger close_pop_up_chat_on_disable
after insert or update of enabled on public.business_marketplace_chat_settings
for each row execute function private.close_pop_up_chat_on_disable();

-- A submitted site can receive exactly one staff decision. Later state changes
-- use the separate manager archive path.
create or replace function private.enforce_pickup_site_state_transition()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if old.state = new.state then
    return new;
  end if;
  if (old.state = 'submitted' and new.state in ('approved', 'rejected'))
    or (old.state in ('submitted', 'approved', 'rejected') and new.state = 'archived')
  then
    return new;
  end if;
  raise exception using errcode = '40001', message = 'PICKUP_SITE_STATE_CHANGED';
end;
$$;

revoke all on function private.enforce_pickup_site_state_transition() from public, anon, authenticated;
drop trigger if exists enforce_pickup_site_state_transition on public.marketplace_pickup_sites;
create trigger enforce_pickup_site_state_transition
before update of state on public.marketplace_pickup_sites
for each row execute function private.enforce_pickup_site_state_transition();

-- Version chat moderation so two operators cannot unknowingly overwrite each
-- other. The v2 queue also rate-limits and audits access to report content.
alter table public.marketplace_messages
  add column if not exists moderation_version integer not null default 1
  check (moderation_version > 0);

create or replace function public.list_reported_marketplace_messages_v2(
  result_limit integer default 50,
  result_offset integer default 0
)
returns table (
  report_id uuid,
  report_state text,
  report_reason text,
  report_detail text,
  reported_at timestamptz,
  message_public_id uuid,
  message_body text,
  message_visibility text,
  message_moderation_version integer,
  message_sent_at timestamptz,
  sender_public_profile_id uuid,
  sender_name text,
  sender_username text,
  conversation_public_id uuid,
  business_id uuid,
  attachments jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  bounded_limit integer := least(greatest(coalesce(result_limit, 50), 1), 100);
  bounded_offset integer := least(greatest(coalesce(result_offset, 0), 0), 10000);
  returned_count integer;
begin
  perform private.require_aal2();
  if not private.is_platform_staff(actor) then
    raise exception using errcode = '42501', message = 'STAFF_REQUIRED';
  end if;
  perform private.consume_rate_limit(actor, 'reported_chat_queue_hour', 120, 3600);

  return query
  select
    queue.report_id,
    queue.report_state,
    queue.report_reason,
    queue.report_detail,
    queue.reported_at,
    queue.message_public_id,
    queue.message_body,
    queue.message_visibility,
    message.moderation_version,
    queue.message_sent_at,
    queue.sender_public_profile_id,
    queue.sender_name,
    queue.sender_username,
    queue.conversation_public_id,
    queue.business_id,
    queue.attachments
  from public.list_reported_marketplace_messages(bounded_limit, bounded_offset) queue
  join public.marketplace_messages message on message.public_id = queue.message_public_id;
  get diagnostics returned_count = row_count;

  perform private.write_audit_event(
    actor,
    null,
    'marketplace_chat.report_queue_accessed',
    'marketplace_message_report_queue',
    'open',
    jsonb_build_object('result_count', returned_count)
  );
end;
$$;

revoke all on function public.list_reported_marketplace_messages_v2(integer, integer)
  from public, anon;
grant execute on function public.list_reported_marketplace_messages_v2(integer, integer)
  to authenticated;

create or replace function public.moderate_marketplace_message_v2(
  target_message_public_id uuid,
  expected_moderation_version integer,
  next_visibility text,
  moderation_reason text,
  idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_message public.marketplace_messages%rowtype;
  key_hash text;
  request_hash text;
  prior_response jsonb;
  response jsonb;
begin
  perform private.require_aal2();
  if not private.is_platform_staff(actor) then
    raise exception using errcode = '42501', message = 'STAFF_REQUIRED';
  end if;

  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'message_public_id', target_message_public_id,
    'expected_moderation_version', expected_moderation_version,
    'visibility', next_visibility,
    'reason', moderation_reason
  ));
  prior_response := private.marketplace_chat_idempotent_response(
    actor,
    'moderate_marketplace_message_v2',
    key_hash,
    request_hash
  );
  if prior_response is not null then
    return prior_response;
  end if;

  select message.* into target_message
  from public.marketplace_messages message
  where message.public_id = target_message_public_id
  for update;
  if not found or target_message.moderation_version <> expected_moderation_version then
    raise exception using errcode = '40001', message = 'CHAT_MODERATION_CHANGED';
  end if;

  response := public.moderate_marketplace_message(
    target_message_public_id,
    next_visibility,
    moderation_reason,
    idempotency_key
  );
  update public.marketplace_messages
  set moderation_version = moderation_version + 1
  where id = target_message.id;
  response := response || jsonb_build_object(
    'moderation_version', expected_moderation_version + 1
  );
  perform private.store_marketplace_chat_idempotency(
    actor,
    'moderate_marketplace_message_v2',
    key_hash,
    request_hash,
    response
  );
  return response;
end;
$$;

revoke all on function public.moderate_marketplace_message_v2(uuid, integer, text, text, text)
  from public, anon;
grant execute on function public.moderate_marketplace_message_v2(uuid, integer, text, text, text)
  to authenticated;
