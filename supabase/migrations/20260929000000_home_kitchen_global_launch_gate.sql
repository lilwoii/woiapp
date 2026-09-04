-- Database-authoritative home-kitchen launch gate.
--
-- EXPO_PUBLIC_HOME_KITCHENS_ENABLED is a presentation/defense-in-depth flag;
-- it is not an authorization boundary. This private singleton is the server
-- boundary for public home-kitchen eligibility and chat. It defaults to false
-- and can only be changed or read through service-role operations.

create table if not exists private.home_kitchen_runtime_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  change_reason text,
  constraint home_kitchen_runtime_settings_reason_length check (
    change_reason is null or char_length(btrim(change_reason)) between 3 and 1000
  )
);

insert into private.home_kitchen_runtime_settings (
  singleton,
  enabled,
  change_reason
)
values (
  true,
  false,
  'Migration default: home kitchens remain disabled until launch approval.'
)
on conflict (singleton) do nothing;

revoke all privileges on table private.home_kitchen_runtime_settings
  from public, anon, authenticated, service_role;

create or replace function private.home_kitchens_globally_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select settings.enabled
    from private.home_kitchen_runtime_settings settings
    where settings.singleton
  ), false);
$$;

revoke all on function private.home_kitchens_globally_enabled()
  from public, anon, authenticated, service_role;

-- Public visibility keeps the latest provider lifecycle, jurisdiction, and
-- permit checks intact. The launch gate applies only to home kitchens so
-- restaurant, pop-up, truck, and cafe visibility is unchanged.
create or replace function private.is_business_publicly_eligible(target_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.businesses b
    where b.id = target_business_id
      and b.state = 'published'
      and (
        b.provenance <> 'licensed_provider'
        or exists (
          select 1
          from private.provider_business_sources source
          join private.provider_accounts account
            on account.provider_slug = source.provider_slug
          where source.business_id = b.id
            and source.source_status = 'active'
            and account.enabled
            and current_date between account.license_effective_on
              and account.license_expires_on
        )
      )
      and (
        b.kind <> 'home_kitchen'
        or (
          private.home_kitchens_globally_enabled()
          and b.verification = 'verified'
          and exists (
            select 1
            from public.jurisdictions j
            join public.home_kitchen_permits hp
              on hp.jurisdiction_id = j.id
             and hp.business_id = b.id
            where j.id = b.jurisdiction_id
              and j.home_kitchens_enabled
              and j.legal_reviewed_at is not null
              and hp.verification = 'verified'
              and hp.expires_on >= current_date
          )
        )
      )
  );
$$;

revoke all on function private.is_business_publicly_eligible(uuid)
  from public, anon, authenticated;
grant execute on function private.is_business_publicly_eligible(uuid)
  to anon, authenticated;

-- Exact pickup addresses/coordinates are revoked when the global gate is
-- disabled. Conversations remain for moderation and account export, but an
-- active request cannot retain a private disclosure while launch is off.
create or replace function private.revoke_home_kitchen_pickup_state()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  now_value timestamptz := pg_catalog.clock_timestamp();
  cancelled_count integer := 0;
  neighborhood_disclosures_deleted integer := 0;
  legacy_disclosures_deleted integer := 0;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('spottr:home-kitchen-launch-gate', 0)
  );

  update public.marketplace_pickup_requests request
  set state = 'cancelled',
      version = request.version + 1,
      responded_by = actor,
      responded_at = now_value,
      updated_at = now_value
  from public.marketplace_conversations conversation
  join public.businesses business
    on business.id = conversation.business_id
  where request.conversation_id = conversation.id
    and business.kind = 'home_kitchen'
    and request.state in ('pending', 'authorized');
  get diagnostics cancelled_count = row_count;

  -- The request-state trigger removes current Neighborhood Kitchen
  -- disclosures. This explicit delete is defense in depth for historical
  -- rows or deployments where that trigger was not present yet.
  delete from private.neighborhood_pickup_disclosures disclosure
  using public.marketplace_pickup_requests request,
    public.marketplace_conversations conversation,
    public.businesses business
  where disclosure.request_id = request.id
    and request.conversation_id = conversation.id
    and conversation.business_id = business.id
    and business.kind = 'home_kitchen';
  get diagnostics neighborhood_disclosures_deleted = row_count;

  -- Remove legacy exact pickup snapshots too; they are not account-facing
  -- conversation history and must not survive a public launch kill switch.
  delete from private.marketplace_pickup_disclosures disclosure
  using public.marketplace_pickup_requests request,
    public.marketplace_conversations conversation,
    public.businesses business
  where disclosure.request_id = request.id
    and request.conversation_id = conversation.id
    and conversation.business_id = business.id
    and business.kind = 'home_kitchen';
  get diagnostics legacy_disclosures_deleted = row_count;

  return pg_catalog.jsonb_build_object(
    'cancelled_requests', cancelled_count,
    'neighborhood_disclosures_deleted', neighborhood_disclosures_deleted,
    'legacy_disclosures_deleted', legacy_disclosures_deleted
  );
end;
$$;

revoke all on function private.revoke_home_kitchen_pickup_state()
  from public, anon, authenticated, service_role;

-- The migration itself starts disabled and revokes any exact pickup state that
-- may already exist on an upgraded database.
select private.revoke_home_kitchen_pickup_state();

-- A service-role-only boundary is used instead of granting application roles
-- access to the private table. Every toggle records the reason and cleanup
-- result in the existing public audit stream.
create or replace function public.set_home_kitchen_launch_gate(
  target_enabled boolean,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  normalized_reason text := nullif(btrim(target_reason), '');
  previous_enabled boolean;
  cleanup_result jsonb := '{}'::jsonb;
  now_value timestamptz := pg_catalog.clock_timestamp();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_enabled is null
    or normalized_reason is null
    or char_length(normalized_reason) not between 3 and 1000
  then
    raise exception using
      errcode = '22023',
      message = 'A launch-gate reason between 3 and 1000 characters is required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('spottr:home-kitchen-launch-gate', 0)
  );

  select settings.enabled
  into previous_enabled
  from private.home_kitchen_runtime_settings settings
  where settings.singleton
  for update;

  if not found then
    insert into private.home_kitchen_runtime_settings (
      singleton,
      enabled,
      updated_by,
      updated_at,
      change_reason
    ) values (
      true,
      false,
      actor,
      now_value,
      'Recovered missing singleton; launch gate remains disabled.'
    );
    previous_enabled := false;
  end if;

  update private.home_kitchen_runtime_settings settings
  set enabled = target_enabled,
      updated_by = actor,
      updated_at = now_value,
      change_reason = normalized_reason
  where settings.singleton;

  if not target_enabled then
    cleanup_result := private.revoke_home_kitchen_pickup_state();
  end if;

  perform private.write_audit_event(
    actor,
    null,
    'home_kitchen.launch_gate_changed',
    'runtime_setting',
    'home_kitchen',
    pg_catalog.jsonb_build_object(
      'previous_enabled', previous_enabled,
      'enabled', target_enabled,
      'reason', normalized_reason,
      'cleanup', cleanup_result
    )
  );

  return pg_catalog.jsonb_build_object(
    'enabled', target_enabled,
    'previous_enabled', previous_enabled,
    'updated_at', now_value,
    'cleanup', cleanup_result
  );
end;
$$;

revoke all on function public.set_home_kitchen_launch_gate(boolean, text)
  from public, anon, authenticated;
grant execute on function public.set_home_kitchen_launch_gate(boolean, text)
  to service_role;

create or replace function public.get_home_kitchen_launch_gate()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  select coalesce(
    (
      select pg_catalog.jsonb_build_object(
        'enabled', settings.enabled,
        'updated_at', settings.updated_at,
        'updated_by', settings.updated_by,
        'change_reason', settings.change_reason
      )
      from private.home_kitchen_runtime_settings settings
      where settings.singleton
    ),
    pg_catalog.jsonb_build_object('enabled', false)
  )
  into result;
  return result;
end;
$$;

revoke all on function public.get_home_kitchen_launch_gate()
  from public, anon, authenticated;
grant execute on function public.get_home_kitchen_launch_gate()
  to service_role;

-- Existing home-kitchen conversations must not remain readable merely because
-- both participants are still present. Pop-up history keeps its pre-existing
-- participant access semantics; home kitchens require current public chat
-- eligibility, which includes the global gate.
create or replace function private.marketplace_conversation_access_allowed(
  target_conversation_id uuid,
  target_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_active_user(target_user_id)
    and exists (
      select 1
      from public.marketplace_conversations conversation
      join public.businesses business
        on business.id = conversation.business_id
      where conversation.id = target_conversation_id
        and target_user_id in (conversation.customer_id, conversation.merchant_id)
        and (
          business.kind <> 'home_kitchen'
          or private.marketplace_chat_available(business.id)
        )
    );
$$;

revoke all on function private.marketplace_conversation_access_allowed(uuid, uuid)
  from public, anon, authenticated;

-- The v1 list is the data source for v2; filter here and again in v2 so a
-- future wrapper change cannot reintroduce an inbox enumeration bypass.
create or replace function public.list_my_marketplace_conversations(
  cursor_time timestamptz default null,
  cursor_public_id uuid default null,
  result_limit integer default 30
)
returns table (
  conversation_public_id uuid,
  business_id uuid,
  business_name text,
  business_kind public.business_kind,
  conversation_state text,
  counterpart_public_profile_id uuid,
  counterpart_name text,
  counterpart_username text,
  counterpart_avatar_path text,
  last_message_preview text,
  last_message_at timestamptz,
  unread_count bigint,
  created_at timestamptz,
  has_more boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  bounded_limit integer := least(greatest(coalesce(result_limit, 30), 1), 50);
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  if (cursor_time is null) <> (cursor_public_id is null) then
    raise exception using errcode = '22023', message = 'INVALID_CONVERSATION_CURSOR';
  end if;

  return query
  with page as (
    select conversation.*,
      coalesce(conversation.last_message_at, conversation.created_at) as sort_time,
      case
        when actor = conversation.customer_id then conversation.merchant_id
        else conversation.customer_id
      end as counterpart_id
    from public.marketplace_conversations conversation
    where actor in (conversation.customer_id, conversation.merchant_id)
      and private.marketplace_conversation_access_allowed(conversation.id, actor)
      and (
        cursor_time is null
        or (coalesce(conversation.last_message_at, conversation.created_at), conversation.public_id)
          < (cursor_time, cursor_public_id)
      )
    order by sort_time desc, conversation.public_id desc
    limit bounded_limit + 1
  ), selected as (
    select * from page
    order by sort_time desc, public_id desc
    limit bounded_limit
  )
  select
    selected.public_id,
    selected.business_id,
    business.name,
    business.kind,
    selected.state,
    counterpart.public_id,
    counterpart.display_name,
    counterpart.username::text,
    counterpart.avatar_path,
    (
      select case
        when message.visibility <> 'visible' or message.deleted_at is not null
          then null
        else left(message.body, 140)
      end
      from public.marketplace_messages message
      where message.conversation_id = selected.id
      order by message.sequence desc
      limit 1
    ),
    selected.last_message_at,
    (
      select count(*)
      from public.marketplace_messages message
      left join public.marketplace_read_receipts receipt
        on receipt.conversation_id = selected.id
       and receipt.user_id = actor
      where message.conversation_id = selected.id
        and message.sender_id is distinct from actor
        and message.visibility = 'visible'
        and message.deleted_at is null
        and message.sequence > coalesce(receipt.last_read_sequence, 0)
    ),
    selected.created_at,
    (select count(*) > bounded_limit from page)
  from selected
  join public.businesses business on business.id = selected.business_id
  left join public.profiles counterpart on counterpart.user_id = selected.counterpart_id
  order by selected.sort_time desc, selected.public_id desc;
end;
$$;

revoke all on function public.list_my_marketplace_conversations(timestamptz, uuid, integer)
  from public;
grant execute on function public.list_my_marketplace_conversations(timestamptz, uuid, integer)
  to authenticated;

create or replace function public.list_my_marketplace_conversations_v2(
  cursor_time timestamptz default null,
  cursor_public_id uuid default null,
  result_limit integer default 30
)
returns table (
  conversation_public_id uuid,
  business_id uuid,
  business_name text,
  business_kind public.business_kind,
  conversation_state text,
  counterpart_public_profile_id uuid,
  counterpart_name text,
  counterpart_username text,
  counterpart_avatar_path text,
  last_message_preview text,
  last_message_at timestamptz,
  unread_count bigint,
  created_at timestamptz,
  has_more boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select listed.*
  from public.list_my_marketplace_conversations(cursor_time, cursor_public_id, result_limit) listed
  join public.marketplace_conversations conversation
    on conversation.public_id = listed.conversation_public_id
  left join private.marketplace_conversation_visibility visibility
    on visibility.conversation_id = conversation.id
   and visibility.user_id = auth.uid()
  where (visibility.conversation_id is null
      or conversation.last_sequence > visibility.hidden_through_sequence)
    and private.marketplace_conversation_access_allowed(conversation.id, auth.uid())
$$;

revoke all on function public.list_my_marketplace_conversations_v2(timestamptz, uuid, integer)
  from public, anon;
grant execute on function public.list_my_marketplace_conversations_v2(timestamptz, uuid, integer)
  to authenticated;

create or replace function public.get_marketplace_conversation_role(
  target_conversation_public_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_conversation public.marketplace_conversations%rowtype;
  participant_role text;
begin
  select conversation.*
  into target_conversation
  from public.marketplace_conversations conversation
  where conversation.public_id = target_conversation_public_id;

  if not found
    or not private.marketplace_conversation_access_allowed(target_conversation.id, actor)
  then
    raise exception using errcode = '42501', message = 'CHAT_ACCESS_REQUIRED';
  end if;

  participant_role := case
    when target_conversation.customer_id = actor then 'customer'
    when target_conversation.merchant_id = actor then 'merchant'
    else null
  end;
  if participant_role is null then
    raise exception using errcode = '42501', message = 'CHAT_ACCESS_REQUIRED';
  end if;
  return participant_role;
end;
$$;

revoke all on function public.get_marketplace_conversation_role(uuid)
  from public, anon;
grant execute on function public.get_marketplace_conversation_role(uuid)
  to authenticated;

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
      when business.kind = 'home_kitchen'
        then private.home_kitchens_globally_enabled()
      else coalesce(setting.enabled, false)
    end,
    business.kind = 'home_kitchen'
      and private.home_kitchens_globally_enabled(),
    business.kind = 'pop_up'
  from public.businesses business
  left join public.business_marketplace_chat_settings setting
    on setting.business_id = business.id
  where business.id = target_business_id
    and business.kind in ('home_kitchen', 'pop_up');
end;
$$;

revoke all on function public.get_business_marketplace_controls(uuid)
  from public, anon;
grant execute on function public.get_business_marketplace_controls(uuid)
  to authenticated;

-- Pickup writers share the launch-gate lock before taking a conversation or
-- request row lock. This gives the service-only disable path an exclusive
-- barrier without introducing a reverse lock order or changing the mature
-- consent, idempotency, DLP, or rate-limit contract.
create or replace function public.request_neighborhood_pickup_choice(
  target_conversation_public_id uuid,
  target_choice_public_id uuid,
  target_choice_kind text,
  pickup_starts_at timestamptz,
  pickup_ends_at timestamptz,
  accepted_buyer_terms_version text,
  request_note text,
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
  target_conversation public.marketplace_conversations%rowtype;
  chosen_place private.safe_meeting_places%rowtype;
  normalized_note text := nullif(btrim(request_note), '');
  request_id uuid := gen_random_uuid();
  request_public_id uuid := gen_random_uuid();
  key_hash text;
  request_hash text;
  prior_response jsonb;
  response jsonb;
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  if target_choice_kind not in ('safe_meeting_place', 'seller_residence')
    or pickup_starts_at < now() + interval '30 minutes'
    or pickup_starts_at > now() + interval '7 days'
    or pickup_ends_at < pickup_starts_at + interval '15 minutes'
    or pickup_ends_at > pickup_starts_at + interval '4 hours'
    or (normalized_note is not null and (
      char_length(normalized_note) > 240
      or not private.content_is_professional(normalized_note)
      or private.marketplace_chat_safety_code(normalized_note) is not null
    ))
  then
    raise exception using errcode = '22023', message = 'INVALID_PICKUP_REQUEST';
  end if;

  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('spottr:home-kitchen-launch-gate', 0)
  );

  select conversation.* into target_conversation
  from public.marketplace_conversations conversation
  join public.businesses business on business.id = conversation.business_id
  where conversation.public_id = target_conversation_public_id
    and business.kind = 'home_kitchen'
  for update of conversation;
  if not found or actor <> target_conversation.customer_id
    or not private.marketplace_conversation_write_allowed(
      target_conversation.id, actor
    )
  then
    raise exception using errcode = '42501', message = 'CUSTOMER_CHAT_ACCESS_REQUIRED';
  end if;
  if exists (
    select 1 from public.marketplace_pickup_requests request
    where request.conversation_id = target_conversation.id
      and request.state in ('pending', 'authorized')
  ) then
    raise exception using errcode = '55000', message = 'PICKUP_REQUEST_ALREADY_ACTIVE';
  end if;

  if target_choice_kind = 'safe_meeting_place' then
    select place.* into chosen_place
    from private.safe_meeting_places place
    join private.business_meeting_routes route
      on route.meeting_place_id = place.id
      and route.business_id = target_conversation.business_id
    where place.public_id = target_choice_public_id
      and place.active
      and place.rights_status in ('licensed', 'first_party')
      and place.expires_at > pickup_ends_at;
    if not found then
      raise exception using errcode = '55000', message = 'PICKUP_CHOICE_UNAVAILABLE';
    end if;
    accepted_buyer_terms_version := null;
  else
    if accepted_buyer_terms_version is distinct from '2026-08-01'
      or not exists (
        select 1
        from private.neighborhood_pickup_settings setting
        join public.businesses business on business.id = setting.business_id
        where setting.business_id = target_conversation.business_id
          and setting.residence_pickup_enabled
          and setting.seller_terms_version = '2026-08-01'
          and business.public_id = target_choice_public_id
      )
    then
      raise exception using errcode = '55000', message = 'RESIDENCE_PICKUP_CONSENT_REQUIRED';
    end if;
  end if;

  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'conversation', target_conversation_public_id,
    'choice', target_choice_public_id,
    'kind', target_choice_kind,
    'starts', pickup_starts_at,
    'ends', pickup_ends_at,
    'terms', accepted_buyer_terms_version,
    'note', normalized_note
  ));
  prior_response := private.marketplace_chat_idempotent_response(
    actor, 'request_neighborhood_pickup_choice', key_hash, request_hash
  );
  if prior_response is not null then return prior_response; end if;
  perform private.consume_rate_limit(
    actor, 'marketplace_pickup_request_day', 20, 86400
  );

  insert into public.marketplace_pickup_requests (
    id, public_id, conversation_id, requested_by,
    pickup_starts_at, pickup_ends_at, note, choice_kind,
    safe_meeting_place_id, buyer_terms_version, buyer_acknowledged_at
  ) values (
    request_id, request_public_id, target_conversation.id, actor,
    pickup_starts_at, pickup_ends_at, normalized_note, target_choice_kind,
    case when target_choice_kind = 'safe_meeting_place'
      then chosen_place.id else null end,
    accepted_buyer_terms_version,
    case when target_choice_kind = 'seller_residence' then now() else null end
  );
  response := jsonb_build_object(
    'pickup_request_public_id', request_public_id,
    'state', 'pending',
    'version', 1,
    'choice_kind', target_choice_kind
  );
  perform private.store_marketplace_chat_idempotency(
    actor, 'request_neighborhood_pickup_choice', key_hash,
    request_hash, response
  );
  perform private.write_audit_event(
    actor, target_conversation.business_id,
    'neighborhood_pickup.choice_requested',
    'marketplace_pickup_request', request_public_id::text,
    jsonb_build_object(
      'choice_kind', target_choice_kind,
      'pickup_starts_at', pickup_starts_at,
      'pickup_ends_at', pickup_ends_at,
      'terms_version', accepted_buyer_terms_version
    )
  );
  return response;
end;
$$;
revoke all on function public.request_neighborhood_pickup_choice(
  uuid, uuid, text, timestamptz, timestamptz, text, text, text
) from public, anon;
grant execute on function public.request_neighborhood_pickup_choice(
  uuid, uuid, text, timestamptz, timestamptz, text, text, text
) to authenticated;

create or replace function public.authorize_neighborhood_pickup_choice(
  target_conversation_public_id uuid,
  target_pickup_request_public_id uuid,
  expected_version integer,
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
  target_conversation public.marketplace_conversations%rowtype;
  target_request public.marketplace_pickup_requests%rowtype;
  place private.safe_meeting_places%rowtype;
  residence public.business_locations%rowtype;
  choice_id uuid;
  detail_label text;
  detail_address text;
  detail_city text;
  detail_region text;
  detail_postal text;
  detail_lat double precision;
  detail_lon double precision;
  detail_expires_at timestamptz;
  key_hash text;
  request_hash text;
  prior_response jsonb;
  response jsonb;
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  perform private.require_aal2();
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('spottr:home-kitchen-launch-gate', 0)
  );
  select conversation.* into target_conversation
  from public.marketplace_conversations conversation
  where conversation.public_id = target_conversation_public_id
  for update;
  if not found or actor <> target_conversation.merchant_id
    or not private.marketplace_conversation_write_allowed(
      target_conversation.id, actor
    )
  then
    raise exception using errcode = '42501', message = 'MERCHANT_CHAT_ACCESS_REQUIRED';
  end if;
  select request.* into target_request
  from public.marketplace_pickup_requests request
  where request.public_id = target_pickup_request_public_id
    and request.conversation_id = target_conversation.id
  for update;
  if not found or target_request.state <> 'pending'
    or target_request.version <> expected_version
    or target_request.pickup_starts_at <= now()
    or target_request.choice_kind not in ('safe_meeting_place', 'seller_residence')
  then
    raise exception using errcode = '40001', message = 'PICKUP_REQUEST_VERSION_OR_STATE_CONFLICT';
  end if;

  if target_request.choice_kind = 'safe_meeting_place' then
    select candidate.* into place
    from private.safe_meeting_places candidate
    join private.business_meeting_routes route
      on route.meeting_place_id = candidate.id
      and route.business_id = target_conversation.business_id
    where candidate.id = target_request.safe_meeting_place_id
      and candidate.active
      and candidate.rights_status in ('licensed', 'first_party')
      and candidate.expires_at > target_request.pickup_ends_at;
    if not found then
      raise exception using errcode = '55000', message = 'PICKUP_CHOICE_UNAVAILABLE';
    end if;
    choice_id := place.public_id;
    detail_label := place.label;
    detail_address := place.address_line;
    detail_city := place.city;
    detail_region := place.region;
    detail_postal := place.postal_code;
    detail_lat := public.st_y(place.point::public.geometry);
    detail_lon := public.st_x(place.point::public.geometry);
  else
    if not exists (
        select 1 from private.marketplace_consent_receipts receipt
        where receipt.request_id = target_request.id
          and receipt.user_id = target_conversation.customer_id
          and receipt.consent_kind = 'buyer_residence_choice'
          and receipt.policy_version = '2026-08-01'
      )
      or not exists (
        select 1 from private.neighborhood_pickup_settings setting
        where setting.business_id = target_conversation.business_id
          and setting.residence_pickup_enabled
          and setting.seller_terms_version = '2026-08-01'
      )
    then
      raise exception using errcode = '55000', message = 'RESIDENCE_PICKUP_CONSENT_REQUIRED';
    end if;
    select location.* into residence
    from public.business_locations location
    where location.business_id = target_conversation.business_id
      and location.is_primary
      and location.publication_state <> 'archived'
      and nullif(btrim(location.address_line), '') is not null;
    if not found then
      raise exception using errcode = '55000', message = 'RESIDENCE_PICKUP_UNAVAILABLE';
    end if;
    select business.public_id into choice_id
    from public.businesses business
    where business.id = target_conversation.business_id;
    detail_label := 'Seller residence';
    detail_address := residence.address_line;
    detail_city := residence.city;
    detail_region := residence.region;
    detail_postal := residence.postal_code;
    detail_lat := public.st_y(residence.point::public.geometry);
    detail_lon := public.st_x(residence.point::public.geometry);
  end if;

  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'conversation', target_conversation_public_id,
    'request', target_pickup_request_public_id,
    'version', expected_version
  ));
  prior_response := private.marketplace_chat_idempotent_response(
    actor, 'authorize_neighborhood_pickup_choice', key_hash, request_hash
  );
  if prior_response is not null then return prior_response; end if;
  perform private.consume_rate_limit(
    actor, 'marketplace_pickup_authorize_day', 40, 86400
  );
  detail_expires_at := least(
    target_request.pickup_ends_at + interval '2 hours',
    now() + interval '24 hours'
  );
  insert into private.neighborhood_pickup_disclosures (
    request_id, choice_kind, choice_public_id, label, address_line, city,
    region, postal_code, latitude, longitude, authorized_by, expires_at
  ) values (
    target_request.id, target_request.choice_kind, choice_id, detail_label,
    detail_address, detail_city, detail_region, detail_postal, detail_lat,
    detail_lon, actor, detail_expires_at
  );
  update public.marketplace_pickup_requests
  set state = 'authorized', version = version + 1,
    responded_by = actor, responded_at = now(), updated_at = now()
  where id = target_request.id;
  response := jsonb_build_object(
    'pickup_request_public_id', target_request.public_id,
    'state', 'authorized',
    'version', expected_version + 1,
    'choice_kind', target_request.choice_kind,
    'detail_expires_at', detail_expires_at
  );
  perform private.store_marketplace_chat_idempotency(
    actor, 'authorize_neighborhood_pickup_choice', key_hash,
    request_hash, response
  );
  perform private.write_audit_event(
    actor, target_conversation.business_id,
    'neighborhood_pickup.choice_authorized',
    'marketplace_pickup_request', target_request.public_id::text,
    jsonb_build_object(
      'choice_kind', target_request.choice_kind,
      'expires_at', detail_expires_at
    )
  );
  return response;
end;
$$;
revoke all on function public.authorize_neighborhood_pickup_choice(
  uuid, uuid, integer, text
) from public, anon;
grant execute on function public.authorize_neighborhood_pickup_choice(
  uuid, uuid, integer, text
) to authenticated;
