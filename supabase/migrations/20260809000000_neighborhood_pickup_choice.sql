-- Buyer-selected Neighborhood Kitchen handoff model.
-- Public meeting places come only from a licensed, freshness-bounded provider
-- feed. A seller residence is opt-in, never returned as a choice with an exact
-- address, and is disclosed only after buyer consent and merchant acceptance.

create table if not exists private.safe_meeting_places (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null default gen_random_uuid() unique,
  provider text not null,
  provider_place_id text not null,
  label text not null,
  address_line text not null,
  city text not null,
  region text not null,
  postal_code text,
  point geography(point, 4326) not null,
  place_kind text not null check (place_kind in ('shopping_center', 'public_market')),
  active boolean not null default true,
  verified_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_place_id),
  constraint safe_meeting_places_provider check (provider ~ '^[a-z0-9_-]{2,40}$'),
  constraint safe_meeting_places_label check (char_length(btrim(label)) between 1 and 120),
  constraint safe_meeting_places_address check (char_length(btrim(address_line)) between 1 and 300),
  constraint safe_meeting_places_city check (char_length(btrim(city)) between 1 and 120),
  constraint safe_meeting_places_region check (char_length(btrim(region)) between 1 and 80),
  constraint safe_meeting_places_postal check (postal_code is null or char_length(postal_code) <= 24),
  constraint safe_meeting_places_freshness check (
    expires_at > verified_at and expires_at <= verified_at + interval '45 days'
  )
);

create index if not exists safe_meeting_places_point_gix
  on private.safe_meeting_places using gist (point);
create index if not exists safe_meeting_places_fresh_idx
  on private.safe_meeting_places (active, expires_at, verified_at desc);
revoke all privileges on table private.safe_meeting_places from public, anon, authenticated;

create table if not exists private.neighborhood_pickup_settings (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  residence_pickup_enabled boolean not null default false,
  seller_terms_version text,
  seller_acknowledged_by uuid references auth.users(id) on delete set null,
  seller_acknowledged_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint neighborhood_pickup_seller_consent check (
    (not residence_pickup_enabled)
    or (
      seller_terms_version = '2026-08-01'
      and seller_acknowledged_by is not null
      and seller_acknowledged_at is not null
    )
  )
);
revoke all privileges on table private.neighborhood_pickup_settings from public, anon, authenticated;

create table if not exists private.business_meeting_routes (
  business_id uuid not null references public.businesses(id) on delete cascade,
  meeting_place_id uuid not null references private.safe_meeting_places(id) on delete restrict,
  ordinal smallint not null check (ordinal between 1 and 3),
  enabled_by uuid references auth.users(id) on delete set null,
  enabled_at timestamptz not null default now(),
  attestation_version text not null check (attestation_version = '2026-08-01'),
  primary key (business_id, meeting_place_id),
  unique (business_id, ordinal)
);
revoke all privileges on table private.business_meeting_routes from public, anon, authenticated;

alter table public.marketplace_pickup_requests
  add column if not exists choice_kind text,
  add column if not exists safe_meeting_place_id uuid references private.safe_meeting_places(id) on delete restrict,
  add column if not exists buyer_terms_version text,
  add column if not exists buyer_acknowledged_at timestamptz;

alter table public.marketplace_pickup_requests
  drop constraint if exists marketplace_pickup_requests_choice_shape;
alter table public.marketplace_pickup_requests
  add constraint marketplace_pickup_requests_choice_shape check (
    (choice_kind is null and safe_meeting_place_id is null and buyer_terms_version is null and buyer_acknowledged_at is null)
    or (
      choice_kind = 'safe_meeting_place'
      and safe_meeting_place_id is not null
      and buyer_terms_version is null
      and buyer_acknowledged_at is null
    )
    or (
      choice_kind = 'seller_residence'
      and safe_meeting_place_id is null
      and buyer_terms_version = '2026-08-01'
      and buyer_acknowledged_at is not null
    )
  );

create table if not exists private.neighborhood_pickup_disclosures (
  request_id uuid primary key references public.marketplace_pickup_requests(id) on delete cascade,
  choice_kind text not null check (choice_kind in ('safe_meeting_place', 'seller_residence')),
  choice_public_id uuid not null,
  label text not null,
  address_line text not null,
  city text not null,
  region text not null,
  postal_code text,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  authorized_by uuid references auth.users(id) on delete set null,
  authorized_at timestamptz not null default now(),
  expires_at timestamptz not null,
  customer_first_viewed_at timestamptz,
  constraint neighborhood_pickup_disclosure_label check (char_length(btrim(label)) between 1 and 120),
  constraint neighborhood_pickup_disclosure_address check (char_length(btrim(address_line)) between 1 and 300),
  constraint neighborhood_pickup_disclosure_city check (char_length(btrim(city)) between 1 and 120),
  constraint neighborhood_pickup_disclosure_region check (char_length(btrim(region)) between 1 and 80),
  constraint neighborhood_pickup_disclosure_postal check (postal_code is null or char_length(postal_code) <= 24),
  constraint neighborhood_pickup_disclosure_expiry check (
    expires_at > authorized_at and expires_at <= authorized_at + interval '8 days'
  )
);
revoke all privileges on table private.neighborhood_pickup_disclosures from public, anon, authenticated;

create table if not exists private.marketplace_conversation_visibility (
  conversation_id uuid not null references public.marketplace_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  hidden_through_sequence bigint not null check (hidden_through_sequence >= 0),
  hidden_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
revoke all privileges on table private.marketplace_conversation_visibility from public, anon, authenticated;

create or replace function public.get_marketplace_conversation_context(
  target_conversation_public_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_conversation public.marketplace_conversations%rowtype;
begin
  select conversation.* into target_conversation
  from public.marketplace_conversations conversation
  where conversation.public_id = target_conversation_public_id;
  if not found or not private.marketplace_conversation_access_allowed(target_conversation.id, actor) then
    raise exception using errcode = '42501', message = 'CHAT_ACCESS_REQUIRED';
  end if;
  return (
    select jsonb_build_object(
      'business_kind', business.kind::text,
      'participant_role', case when actor = target_conversation.customer_id then 'customer' else 'merchant' end,
      'actor_public_profile_id', (select profile.public_id from public.profiles profile where profile.user_id = actor),
      'payment_methods', coalesce((
        select jsonb_agg(payment.payment::text order by payment.payment::text)
        from public.business_payments payment
        where payment.business_id = target_conversation.business_id
      ), '[]'::jsonb),
      'platform_payment_enabled', false
    )
    from public.businesses business
    where business.id = target_conversation.business_id
  );
end;
$$;
revoke all on function public.get_marketplace_conversation_context(uuid) from public, anon;
grant execute on function public.get_marketplace_conversation_context(uuid) to authenticated;

create or replace function public.get_neighborhood_pickup_settings(target_business_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare actor uuid := auth.uid();
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  perform private.require_aal2();
  if not private.is_business_member(target_business_id, actor, array['owner', 'manager']::public.member_role[]) then
    raise exception using errcode = '42501', message = 'BUSINESS_MANAGER_REQUIRED';
  end if;
  if not exists (select 1 from public.businesses where id = target_business_id and kind = 'home_kitchen') then
    raise exception using errcode = '22023', message = 'NEIGHBORHOOD_KITCHEN_REQUIRED';
  end if;
  return jsonb_build_object(
    'residence_pickup_enabled', coalesce((
      select setting.residence_pickup_enabled
      from private.neighborhood_pickup_settings setting
      where setting.business_id = target_business_id
    ), false),
    'seller_terms_version', (
      select setting.seller_terms_version
      from private.neighborhood_pickup_settings setting
      where setting.business_id = target_business_id
    ),
    'service_location_ready', exists (
      select 1 from public.business_locations location
      where location.business_id = target_business_id
        and location.is_primary and location.publication_state <> 'archived'
        and location.address_line is not null
    )
  );
end;
$$;
revoke all on function public.get_neighborhood_pickup_settings(uuid) from public, anon;
grant execute on function public.get_neighborhood_pickup_settings(uuid) to authenticated;

create or replace function public.set_neighborhood_residence_pickup(
  target_business_id uuid,
  should_enable boolean,
  accepted_terms_version text,
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
  key_hash text;
  request_hash text;
  prior_response jsonb;
  response jsonb;
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  perform private.require_aal2();
  if not private.is_business_member(target_business_id, actor, array['owner', 'manager']::public.member_role[]) then
    raise exception using errcode = '42501', message = 'BUSINESS_MANAGER_REQUIRED';
  end if;
  if not exists (select 1 from public.businesses where id = target_business_id and kind = 'home_kitchen')
    or (should_enable and accepted_terms_version is distinct from '2026-08-01')
    or (should_enable and not exists (
      select 1 from public.business_locations location
      where location.business_id = target_business_id and location.is_primary
        and location.publication_state <> 'archived' and location.address_line is not null
    ))
  then
    raise exception using errcode = '22023', message = 'INVALID_RESIDENCE_PICKUP_SETTING';
  end if;
  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'business_id', target_business_id, 'enabled', should_enable,
    'terms_version', case when should_enable then accepted_terms_version else null end
  ));
  prior_response := private.marketplace_chat_idempotent_response(actor, 'set_neighborhood_residence_pickup', key_hash, request_hash);
  if prior_response is not null then return prior_response; end if;
  perform private.consume_rate_limit(actor, 'neighborhood_pickup_setting_hour', 20, 3600);
  insert into private.neighborhood_pickup_settings (
    business_id, residence_pickup_enabled, seller_terms_version,
    seller_acknowledged_by, seller_acknowledged_at, updated_at
  ) values (
    target_business_id, should_enable,
    case when should_enable then accepted_terms_version else null end,
    case when should_enable then actor else null end,
    case when should_enable then now() else null end, now()
  )
  on conflict (business_id) do update set
    residence_pickup_enabled = excluded.residence_pickup_enabled,
    seller_terms_version = excluded.seller_terms_version,
    seller_acknowledged_by = excluded.seller_acknowledged_by,
    seller_acknowledged_at = excluded.seller_acknowledged_at,
    updated_at = now();
  if not should_enable then
    update public.marketplace_pickup_requests request
    set state = 'cancelled', version = version + 1, responded_by = actor,
      responded_at = now(), updated_at = now()
    from public.marketplace_conversations conversation
    where request.conversation_id = conversation.id
      and conversation.business_id = target_business_id
      and request.choice_kind = 'seller_residence'
      and request.state in ('pending', 'authorized');
    delete from private.neighborhood_pickup_disclosures disclosure
    using public.marketplace_pickup_requests request, public.marketplace_conversations conversation
    where disclosure.request_id = request.id
      and request.conversation_id = conversation.id
      and conversation.business_id = target_business_id
      and disclosure.choice_kind = 'seller_residence';
  end if;
  response := jsonb_build_object('business_id', target_business_id, 'residence_pickup_enabled', should_enable);
  perform private.store_marketplace_chat_idempotency(actor, 'set_neighborhood_residence_pickup', key_hash, request_hash, response);
  perform private.write_audit_event(actor, target_business_id, 'neighborhood_pickup.residence_setting_changed', 'business', target_business_id::text, jsonb_build_object('enabled', should_enable, 'terms_version', case when should_enable then accepted_terms_version else null end));
  return response;
end;
$$;
revoke all on function public.set_neighborhood_residence_pickup(uuid, boolean, text, text) from public, anon;
grant execute on function public.set_neighborhood_residence_pickup(uuid, boolean, text, text) to authenticated;

create or replace function public.list_business_meeting_place_suggestions(target_business_id uuid)
returns table (
  choice_public_id uuid,
  label text,
  address_line text,
  city text,
  region text,
  postal_code text,
  distance_meters double precision,
  selected_ordinal smallint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare actor uuid := auth.uid(); origin geography(point, 4326);
begin
  if not private.is_active_user(actor) then raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED'; end if;
  perform private.require_aal2();
  if not private.is_business_member(target_business_id, actor, array['owner', 'manager']::public.member_role[])
    or not exists (select 1 from public.businesses where id = target_business_id and kind = 'home_kitchen')
  then raise exception using errcode = '42501', message = 'NEIGHBORHOOD_KITCHEN_MANAGER_REQUIRED'; end if;
  select location.point into origin from public.business_locations location
  where location.business_id = target_business_id and location.is_primary and location.publication_state <> 'archived';
  if origin is null then return; end if;
  return query
  select place.public_id, place.label, place.address_line, place.city, place.region,
    place.postal_code, public.st_distance(place.point, origin), route.ordinal
  from private.safe_meeting_places place
  left join private.business_meeting_routes route
    on route.business_id = target_business_id and route.meeting_place_id = place.id
  where place.active and place.expires_at > now() and public.st_dwithin(place.point, origin, 25000)
  order by (route.ordinal is null), route.ordinal, public.st_distance(place.point, origin), place.public_id
  limit 8;
end;
$$;
revoke all on function public.list_business_meeting_place_suggestions(uuid) from public, anon;
grant execute on function public.list_business_meeting_place_suggestions(uuid) to authenticated;

create or replace function public.set_business_meeting_routes(
  target_business_id uuid,
  selected_choice_public_ids uuid[],
  accepted_attestation_version text,
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
  choices uuid[] := coalesce(selected_choice_public_ids, '{}'::uuid[]);
  origin geography(point, 4326);
  key_hash text; request_hash text; prior_response jsonb; response jsonb;
begin
  if not private.is_active_user(actor) then raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED'; end if;
  perform private.require_aal2();
  if not private.is_business_member(target_business_id, actor, array['owner', 'manager']::public.member_role[])
    or accepted_attestation_version is distinct from '2026-08-01'
    or cardinality(choices) not between 2 and 3
    or cardinality(choices) <> (select count(distinct choice) from unnest(choices) choice)
  then raise exception using errcode = '22023', message = 'INVALID_MEETING_ROUTE_SELECTION'; end if;
  select location.point into origin from public.business_locations location
  join public.businesses business on business.id = location.business_id and business.kind = 'home_kitchen'
  where location.business_id = target_business_id and location.is_primary and location.publication_state <> 'archived';
  if origin is null or (select count(*) from private.safe_meeting_places place
    where place.public_id = any(choices) and place.active and place.expires_at > now()
      and public.st_dwithin(place.point, origin, 25000)) <> cardinality(choices)
  then raise exception using errcode = '55000', message = 'MEETING_ROUTE_UNAVAILABLE'; end if;
  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object('business', target_business_id, 'choices', choices, 'attestation', accepted_attestation_version));
  prior_response := private.marketplace_chat_idempotent_response(actor, 'set_business_meeting_routes', key_hash, request_hash);
  if prior_response is not null then return prior_response; end if;
  perform private.consume_rate_limit(actor, 'neighborhood_route_setting_hour', 20, 3600);
  delete from private.business_meeting_routes where business_id = target_business_id;
  insert into private.business_meeting_routes (business_id, meeting_place_id, ordinal, enabled_by, attestation_version)
  select target_business_id, place.id, choice.ordinality::smallint, actor, accepted_attestation_version
  from unnest(choices) with ordinality choice(public_id, ordinality)
  join private.safe_meeting_places place on place.public_id = choice.public_id;
  response := jsonb_build_object('business_id', target_business_id, 'selected_count', cardinality(choices));
  perform private.store_marketplace_chat_idempotency(actor, 'set_business_meeting_routes', key_hash, request_hash, response);
  perform private.write_audit_event(actor, target_business_id, 'neighborhood_pickup.routes_changed', 'business', target_business_id::text, jsonb_build_object('selected_count', cardinality(choices), 'attestation_version', accepted_attestation_version));
  return response;
end;
$$;
revoke all on function public.set_business_meeting_routes(uuid, uuid[], text, text) from public, anon;
grant execute on function public.set_business_meeting_routes(uuid, uuid[], text, text) to authenticated;

create or replace function public.list_neighborhood_pickup_choices(
  target_conversation_public_id uuid
)
returns table (
  choice_public_id uuid,
  choice_kind text,
  label text,
  address_line text,
  city text,
  region text,
  postal_code text,
  latitude double precision,
  longitude double precision,
  warning_required boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_conversation public.marketplace_conversations%rowtype;
  origin geography(point, 4326);
begin
  select conversation.* into target_conversation
  from public.marketplace_conversations conversation
  join public.businesses business on business.id = conversation.business_id
  where conversation.public_id = target_conversation_public_id
    and business.kind = 'home_kitchen';
  if not found or not private.marketplace_conversation_write_allowed(target_conversation.id, actor) then
    raise exception using errcode = '42501', message = 'NEIGHBORHOOD_CHAT_ACCESS_REQUIRED';
  end if;
  select location.point into origin
  from public.business_locations location
  where location.business_id = target_conversation.business_id
    and location.is_primary and location.publication_state <> 'archived';
  if origin is null then return; end if;

  return query
  select place.public_id, 'safe_meeting_place'::text, place.label,
    place.address_line, place.city, place.region, place.postal_code,
    public.st_y(place.point::geometry), public.st_x(place.point::geometry),
    false
  from private.safe_meeting_places place
  join private.business_meeting_routes route
    on route.meeting_place_id = place.id and route.business_id = target_conversation.business_id
  where place.active and place.expires_at > now()
  order by route.ordinal;

  if exists (
    select 1 from private.neighborhood_pickup_settings setting
    where setting.business_id = target_conversation.business_id
      and setting.residence_pickup_enabled
      and setting.seller_terms_version = '2026-08-01'
  ) then
    return query
    select business.public_id, 'seller_residence'::text, 'Seller residence'::text,
      null::text, location.city, location.region, null::text,
      null::double precision, null::double precision, true
    from public.businesses business
    join public.business_locations location on location.business_id = business.id and location.is_primary
    where business.id = target_conversation.business_id
      and location.publication_state <> 'archived';
  end if;
end;
$$;
revoke all on function public.list_neighborhood_pickup_choices(uuid) from public, anon;
grant execute on function public.list_neighborhood_pickup_choices(uuid) to authenticated;

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
  if target_choice_kind not in ('safe_meeting_place', 'seller_residence')
    or pickup_starts_at < now() + interval '30 minutes'
    or pickup_starts_at > now() + interval '7 days'
    or pickup_ends_at < pickup_starts_at + interval '15 minutes'
    or pickup_ends_at > pickup_starts_at + interval '4 hours'
    or (normalized_note is not null and (char_length(normalized_note) > 240 or not private.content_is_professional(normalized_note)))
  then raise exception using errcode = '22023', message = 'INVALID_PICKUP_REQUEST'; end if;

  select conversation.* into target_conversation
  from public.marketplace_conversations conversation
  join public.businesses business on business.id = conversation.business_id
  where conversation.public_id = target_conversation_public_id and business.kind = 'home_kitchen'
  for update of conversation;
  if not found or actor <> target_conversation.customer_id
    or not private.marketplace_conversation_write_allowed(target_conversation.id, actor)
  then raise exception using errcode = '42501', message = 'CUSTOMER_CHAT_ACCESS_REQUIRED'; end if;
  if exists (select 1 from public.marketplace_pickup_requests request where request.conversation_id = target_conversation.id and request.state in ('pending', 'authorized')) then
    raise exception using errcode = '55000', message = 'PICKUP_REQUEST_ALREADY_ACTIVE';
  end if;

  if target_choice_kind = 'safe_meeting_place' then
    select place.* into chosen_place from private.safe_meeting_places place
    join private.business_meeting_routes route
      on route.meeting_place_id = place.id and route.business_id = target_conversation.business_id
    where place.public_id = target_choice_public_id and place.active and place.expires_at > now();
    if not found then raise exception using errcode = '55000', message = 'PICKUP_CHOICE_UNAVAILABLE'; end if;
    accepted_buyer_terms_version := null;
  else
    if accepted_buyer_terms_version is distinct from '2026-08-01'
      or not exists (
        select 1 from private.neighborhood_pickup_settings setting
        join public.businesses business on business.id = setting.business_id
        where setting.business_id = target_conversation.business_id
          and setting.residence_pickup_enabled and setting.seller_terms_version = '2026-08-01'
          and business.public_id = target_choice_public_id
      )
    then raise exception using errcode = '55000', message = 'RESIDENCE_PICKUP_CONSENT_REQUIRED'; end if;
  end if;

  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'conversation', target_conversation_public_id, 'choice', target_choice_public_id,
    'kind', target_choice_kind, 'starts', pickup_starts_at, 'ends', pickup_ends_at,
    'terms', accepted_buyer_terms_version, 'note', normalized_note
  ));
  prior_response := private.marketplace_chat_idempotent_response(actor, 'request_neighborhood_pickup_choice', key_hash, request_hash);
  if prior_response is not null then return prior_response; end if;
  perform private.consume_rate_limit(actor, 'marketplace_pickup_request_day', 20, 86400);

  insert into public.marketplace_pickup_requests (
    id, public_id, conversation_id, requested_by, pickup_starts_at, pickup_ends_at,
    note, choice_kind, safe_meeting_place_id, buyer_terms_version, buyer_acknowledged_at
  ) values (
    request_id, request_public_id, target_conversation.id, actor, pickup_starts_at, pickup_ends_at,
    normalized_note, target_choice_kind,
    case when target_choice_kind = 'safe_meeting_place' then chosen_place.id else null end,
    accepted_buyer_terms_version,
    case when target_choice_kind = 'seller_residence' then now() else null end
  );
  response := jsonb_build_object('pickup_request_public_id', request_public_id, 'state', 'pending', 'version', 1, 'choice_kind', target_choice_kind);
  perform private.store_marketplace_chat_idempotency(actor, 'request_neighborhood_pickup_choice', key_hash, request_hash, response);
  perform private.write_audit_event(actor, target_conversation.business_id, 'neighborhood_pickup.choice_requested', 'marketplace_pickup_request', request_public_id::text, jsonb_build_object('choice_kind', target_choice_kind, 'pickup_starts_at', pickup_starts_at, 'pickup_ends_at', pickup_ends_at, 'terms_version', accepted_buyer_terms_version));
  return response;
end;
$$;
revoke all on function public.request_neighborhood_pickup_choice(uuid, uuid, text, timestamptz, timestamptz, text, text, text) from public, anon;
grant execute on function public.request_neighborhood_pickup_choice(uuid, uuid, text, timestamptz, timestamptz, text, text, text) to authenticated;

create or replace function public.list_marketplace_pickup_requests_v2(
  target_conversation_public_id uuid
)
returns table (
  pickup_request_public_id uuid,
  participant_role text,
  pickup_starts_at timestamptz,
  pickup_ends_at timestamptz,
  request_note text,
  request_state text,
  request_version integer,
  created_at timestamptz,
  updated_at timestamptz,
  choice_kind text,
  choice_public_id uuid,
  choice_label text,
  choice_city text,
  choice_region text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare actor uuid := auth.uid(); conversation public.marketplace_conversations%rowtype;
begin
  select c.* into conversation from public.marketplace_conversations c where c.public_id = target_conversation_public_id;
  if not found or not private.marketplace_conversation_access_allowed(conversation.id, actor) then
    raise exception using errcode = '42501', message = 'CHAT_ACCESS_REQUIRED';
  end if;
  return query
  select request.public_id,
    case when actor = conversation.customer_id then 'customer' else 'merchant' end,
    request.pickup_starts_at, request.pickup_ends_at, request.note, request.state,
    request.version, request.created_at, request.updated_at, request.choice_kind,
    case when request.choice_kind = 'safe_meeting_place' then place.public_id
      when request.choice_kind = 'seller_residence' then business.public_id else site.public_id end,
    case when request.choice_kind = 'safe_meeting_place' then place.label
      when request.choice_kind = 'seller_residence' then 'Seller residence' else site.label end,
    case when request.choice_kind = 'safe_meeting_place' then place.city
      when request.choice_kind = 'seller_residence' then location.city else site.city end,
    case when request.choice_kind = 'safe_meeting_place' then place.region
      when request.choice_kind = 'seller_residence' then location.region else site.region end
  from public.marketplace_pickup_requests request
  join public.businesses business on business.id = conversation.business_id
  left join private.safe_meeting_places place on place.id = request.safe_meeting_place_id
  left join public.business_locations location on location.business_id = conversation.business_id and location.is_primary
  left join private.marketplace_pickup_disclosures legacy_disclosure on legacy_disclosure.request_id = request.id
  left join public.marketplace_pickup_sites site on site.id = legacy_disclosure.site_id
  where request.conversation_id = conversation.id
  order by request.created_at desc, request.public_id desc
  limit 20;
end;
$$;
revoke all on function public.list_marketplace_pickup_requests_v2(uuid) from public, anon;
grant execute on function public.list_marketplace_pickup_requests_v2(uuid) to authenticated;

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
  key_hash text;
  request_hash text;
  prior_response jsonb;
  response jsonb;
begin
  perform private.require_aal2();
  select conversation.* into target_conversation
  from public.marketplace_conversations conversation
  where conversation.public_id = target_conversation_public_id for update;
  if not found or actor <> target_conversation.merchant_id
    or not private.marketplace_conversation_write_allowed(target_conversation.id, actor)
  then raise exception using errcode = '42501', message = 'MERCHANT_CHAT_ACCESS_REQUIRED'; end if;
  select request.* into target_request from public.marketplace_pickup_requests request
  where request.public_id = target_pickup_request_public_id and request.conversation_id = target_conversation.id
  for update;
  if not found or target_request.state <> 'pending' or target_request.version <> expected_version
    or target_request.pickup_starts_at <= now() or target_request.choice_kind not in ('safe_meeting_place', 'seller_residence')
  then raise exception using errcode = '40001', message = 'PICKUP_REQUEST_VERSION_OR_STATE_CONFLICT'; end if;

  if target_request.choice_kind = 'safe_meeting_place' then
    select candidate.* into place from private.safe_meeting_places candidate
    where candidate.id = target_request.safe_meeting_place_id and candidate.active and candidate.expires_at > now();
    if not found then raise exception using errcode = '55000', message = 'PICKUP_CHOICE_UNAVAILABLE'; end if;
    choice_id := place.public_id; detail_label := place.label; detail_address := place.address_line;
    detail_city := place.city; detail_region := place.region; detail_postal := place.postal_code;
    detail_lat := public.st_y(place.point::geometry); detail_lon := public.st_x(place.point::geometry);
  else
    if target_request.buyer_terms_version <> '2026-08-01' or target_request.buyer_acknowledged_at is null
      or not exists (select 1 from private.neighborhood_pickup_settings setting where setting.business_id = target_conversation.business_id and setting.residence_pickup_enabled and setting.seller_terms_version = '2026-08-01')
    then raise exception using errcode = '55000', message = 'RESIDENCE_PICKUP_CONSENT_REQUIRED'; end if;
    select location.* into residence from public.business_locations location
    where location.business_id = target_conversation.business_id and location.is_primary
      and location.publication_state <> 'archived' and location.address_line is not null;
    if not found then raise exception using errcode = '55000', message = 'RESIDENCE_PICKUP_UNAVAILABLE'; end if;
    select business.public_id into choice_id from public.businesses business where business.id = target_conversation.business_id;
    detail_label := 'Seller residence'; detail_address := residence.address_line;
    detail_city := residence.city; detail_region := residence.region; detail_postal := residence.postal_code;
    detail_lat := public.st_y(residence.point::geometry); detail_lon := public.st_x(residence.point::geometry);
  end if;

  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object('conversation', target_conversation_public_id, 'request', target_pickup_request_public_id, 'version', expected_version));
  prior_response := private.marketplace_chat_idempotent_response(actor, 'authorize_neighborhood_pickup_choice', key_hash, request_hash);
  if prior_response is not null then return prior_response; end if;
  perform private.consume_rate_limit(actor, 'marketplace_pickup_authorize_day', 40, 86400);
  insert into private.neighborhood_pickup_disclosures (
    request_id, choice_kind, choice_public_id, label, address_line, city, region,
    postal_code, latitude, longitude, authorized_by, expires_at
  ) values (
    target_request.id, target_request.choice_kind, choice_id, detail_label, detail_address,
    detail_city, detail_region, detail_postal, detail_lat, detail_lon, actor,
    target_request.pickup_ends_at + interval '12 hours'
  );
  update public.marketplace_pickup_requests set state = 'authorized', version = version + 1,
    responded_by = actor, responded_at = now(), updated_at = now() where id = target_request.id;
  response := jsonb_build_object('pickup_request_public_id', target_request.public_id, 'state', 'authorized', 'version', expected_version + 1, 'choice_kind', target_request.choice_kind, 'detail_expires_at', target_request.pickup_ends_at + interval '12 hours');
  perform private.store_marketplace_chat_idempotency(actor, 'authorize_neighborhood_pickup_choice', key_hash, request_hash, response);
  perform private.write_audit_event(actor, target_conversation.business_id, 'neighborhood_pickup.choice_authorized', 'marketplace_pickup_request', target_request.public_id::text, jsonb_build_object('choice_kind', target_request.choice_kind, 'expires_at', target_request.pickup_ends_at + interval '12 hours'));
  return response;
end;
$$;
revoke all on function public.authorize_neighborhood_pickup_choice(uuid, uuid, integer, text) from public, anon;
grant execute on function public.authorize_neighborhood_pickup_choice(uuid, uuid, integer, text) to authenticated;

create or replace function public.get_authorized_neighborhood_pickup_detail(
  target_conversation_public_id uuid,
  target_pickup_request_public_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  conversation public.marketplace_conversations%rowtype;
  request public.marketplace_pickup_requests%rowtype;
  disclosure private.neighborhood_pickup_disclosures%rowtype;
begin
  select c.* into conversation from public.marketplace_conversations c where c.public_id = target_conversation_public_id;
  if not found or not private.marketplace_conversation_access_allowed(conversation.id, actor)
    or private.users_are_blocked(conversation.customer_id, conversation.merchant_id)
  then raise exception using errcode = '42501', message = 'PICKUP_DETAIL_ACCESS_REQUIRED'; end if;
  select r.* into request from public.marketplace_pickup_requests r
  where r.public_id = target_pickup_request_public_id and r.conversation_id = conversation.id and r.state = 'authorized';
  if not found then raise exception using errcode = '55000', message = 'PICKUP_DETAIL_NOT_AUTHORIZED'; end if;
  select d.* into disclosure from private.neighborhood_pickup_disclosures d where d.request_id = request.id for update;
  if not found or now() >= disclosure.expires_at then raise exception using errcode = '55000', message = 'PICKUP_DETAIL_NOT_AVAILABLE'; end if;
  if actor = conversation.customer_id and disclosure.customer_first_viewed_at is null then
    update private.neighborhood_pickup_disclosures set customer_first_viewed_at = now() where request_id = request.id and customer_first_viewed_at is null;
    if found then perform private.write_audit_event(actor, conversation.business_id, 'neighborhood_pickup.detail_first_viewed', 'marketplace_pickup_request', request.public_id::text, jsonb_build_object('choice_kind', disclosure.choice_kind)); end if;
  end if;
  return jsonb_build_object(
    'pickup_request_public_id', request.public_id, 'pickup_site_public_id', disclosure.choice_public_id,
    'label', disclosure.label, 'site_kind', disclosure.choice_kind,
    'address_line', disclosure.address_line, 'city', disclosure.city, 'region', disclosure.region,
    'postal_code', disclosure.postal_code, 'latitude', disclosure.latitude, 'longitude', disclosure.longitude,
    'pickup_starts_at', request.pickup_starts_at, 'pickup_ends_at', request.pickup_ends_at,
    'expires_at', disclosure.expires_at
  );
end;
$$;
revoke all on function public.get_authorized_neighborhood_pickup_detail(uuid, uuid) from public, anon;
grant execute on function public.get_authorized_neighborhood_pickup_detail(uuid, uuid) to authenticated;

create or replace function private.destroy_neighborhood_pickup_disclosure_on_resolution()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.state in ('pending', 'authorized') and new.state not in ('pending', 'authorized') then
    delete from private.neighborhood_pickup_disclosures where request_id = new.id;
  end if;
  return new;
end;
$$;
revoke all on function private.destroy_neighborhood_pickup_disclosure_on_resolution() from public, anon, authenticated;
drop trigger if exists destroy_neighborhood_pickup_disclosure_on_resolution on public.marketplace_pickup_requests;
create trigger destroy_neighborhood_pickup_disclosure_on_resolution
after update of state on public.marketplace_pickup_requests
for each row execute function private.destroy_neighborhood_pickup_disclosure_on_resolution();

create or replace function private.revoke_pickup_disclosures_on_user_block()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.marketplace_pickup_requests request
  set state = 'cancelled', version = version + 1, responded_by = new.blocker_id,
    responded_at = now(), updated_at = now()
  from public.marketplace_conversations conversation
  where request.conversation_id = conversation.id
    and new.blocker_id in (conversation.customer_id, conversation.merchant_id)
    and new.blocked_id in (conversation.customer_id, conversation.merchant_id)
    and request.state in ('pending', 'authorized');
  delete from private.neighborhood_pickup_disclosures disclosure
  using public.marketplace_pickup_requests request, public.marketplace_conversations conversation
  where disclosure.request_id = request.id and request.conversation_id = conversation.id
    and new.blocker_id in (conversation.customer_id, conversation.merchant_id)
    and new.blocked_id in (conversation.customer_id, conversation.merchant_id);
  delete from private.marketplace_pickup_disclosures disclosure
  using public.marketplace_pickup_requests request, public.marketplace_conversations conversation
  where disclosure.request_id = request.id and request.conversation_id = conversation.id
    and new.blocker_id in (conversation.customer_id, conversation.merchant_id)
    and new.blocked_id in (conversation.customer_id, conversation.merchant_id);
  insert into private.marketplace_conversation_visibility (conversation_id, user_id, hidden_through_sequence, hidden_at)
  select conversation.id, new.blocker_id, conversation.last_sequence, now()
  from public.marketplace_conversations conversation
  where new.blocker_id in (conversation.customer_id, conversation.merchant_id)
    and new.blocked_id in (conversation.customer_id, conversation.merchant_id)
  on conflict (conversation_id, user_id) do update set
    hidden_through_sequence = greatest(private.marketplace_conversation_visibility.hidden_through_sequence, excluded.hidden_through_sequence),
    hidden_at = now();
  return new;
end;
$$;
revoke all on function private.revoke_pickup_disclosures_on_user_block() from public, anon, authenticated;
drop trigger if exists revoke_pickup_disclosures_on_user_block on public.user_blocks;
create trigger revoke_pickup_disclosures_on_user_block
after insert on public.user_blocks for each row execute function private.revoke_pickup_disclosures_on_user_block();

create or replace function public.clear_marketplace_conversation_from_inbox(
  target_conversation_public_id uuid,
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
  conversation public.marketplace_conversations%rowtype;
  key_hash text;
  request_hash text;
  prior_response jsonb;
  response jsonb;
begin
  select c.* into conversation from public.marketplace_conversations c
  where c.public_id = target_conversation_public_id for update;
  if not found or not private.marketplace_conversation_access_allowed(conversation.id, actor) then
    raise exception using errcode = '42501', message = 'CHAT_ACCESS_REQUIRED';
  end if;
  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object('conversation', target_conversation_public_id, 'through_sequence', conversation.last_sequence));
  prior_response := private.marketplace_chat_idempotent_response(actor, 'clear_marketplace_conversation_from_inbox', key_hash, request_hash);
  if prior_response is not null then return prior_response; end if;
  perform private.consume_rate_limit(actor, 'marketplace_conversation_clear_hour', 40, 3600);
  insert into private.marketplace_conversation_visibility (conversation_id, user_id, hidden_through_sequence, hidden_at)
  values (conversation.id, actor, conversation.last_sequence, now())
  on conflict (conversation_id, user_id) do update set
    hidden_through_sequence = greatest(private.marketplace_conversation_visibility.hidden_through_sequence, excluded.hidden_through_sequence),
    hidden_at = now();
  delete from public.marketplace_typing_presence where conversation_id = conversation.id and user_id = actor;
  update public.marketplace_pickup_requests set state = 'cancelled', version = version + 1,
    responded_by = actor, responded_at = now(), updated_at = now()
  where conversation_id = conversation.id and state in ('pending', 'authorized');
  delete from private.neighborhood_pickup_disclosures disclosure
  using public.marketplace_pickup_requests request
  where disclosure.request_id = request.id and request.conversation_id = conversation.id;
  delete from private.marketplace_pickup_disclosures disclosure
  using public.marketplace_pickup_requests request
  where disclosure.request_id = request.id and request.conversation_id = conversation.id;
  response := jsonb_build_object('conversation_public_id', conversation.public_id, 'hidden_through_sequence', conversation.last_sequence);
  perform private.store_marketplace_chat_idempotency(actor, 'clear_marketplace_conversation_from_inbox', key_hash, request_hash, response);
  perform private.write_audit_event(actor, conversation.business_id, 'marketplace_chat.cleared_from_inbox', 'marketplace_conversation', conversation.public_id::text, jsonb_build_object('hidden_through_sequence', conversation.last_sequence));
  return response;
end;
$$;
revoke all on function public.clear_marketplace_conversation_from_inbox(uuid, text) from public, anon;
grant execute on function public.clear_marketplace_conversation_from_inbox(uuid, text) to authenticated;

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
  join public.marketplace_conversations conversation on conversation.public_id = listed.conversation_public_id
  left join private.marketplace_conversation_visibility visibility
    on visibility.conversation_id = conversation.id and visibility.user_id = auth.uid()
  where visibility.conversation_id is null or conversation.last_sequence > visibility.hidden_through_sequence
$$;
revoke all on function public.list_my_marketplace_conversations_v2(timestamptz, uuid, integer) from public, anon;
grant execute on function public.list_my_marketplace_conversations_v2(timestamptz, uuid, integer) to authenticated;

create or replace function public.get_marketplace_messages_v2(
  target_conversation_public_id uuid,
  before_sequence bigint default null,
  result_limit integer default 50
)
returns table (
  message_public_id uuid,
  sequence bigint,
  sender_public_profile_id uuid,
  sender_name text,
  sender_username text,
  sender_avatar_path text,
  body text,
  attachments jsonb,
  visibility text,
  sent_at timestamptz,
  edited_at timestamptz,
  deleted_at timestamptz,
  read_by_counterpart_at timestamptz,
  has_more boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select message.*
  from public.get_marketplace_messages(target_conversation_public_id, before_sequence, result_limit) message
  join public.marketplace_conversations conversation on conversation.public_id = target_conversation_public_id
  left join private.marketplace_conversation_visibility visibility
    on visibility.conversation_id = conversation.id and visibility.user_id = auth.uid()
  where visibility.conversation_id is null or message.sequence > visibility.hidden_through_sequence
$$;
revoke all on function public.get_marketplace_messages_v2(uuid, bigint, integer) from public, anon;
grant execute on function public.get_marketplace_messages_v2(uuid, bigint, integer) to authenticated;

-- Safe-place records are provider-managed only. Service-role writes are still
-- expected to use the licensed ingest job and are never exposed as a client API.
grant select, insert, update on private.safe_meeting_places to service_role;
