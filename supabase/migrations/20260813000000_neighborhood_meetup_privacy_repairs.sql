-- Close launch-blocking privacy gaps in the Neighborhood Kitchen meetup flow.
-- Buyer consent is private, pickup notes share chat DLP, withdrawn provider
-- places fail closed, and clearing an inbox also revokes attachment reads.

update public.marketplace_pickup_requests
set buyer_terms_version = null,
    buyer_acknowledged_at = null
where buyer_terms_version is not null or buyer_acknowledged_at is not null;

alter table public.marketplace_pickup_requests
  drop constraint if exists marketplace_pickup_requests_choice_shape;
alter table public.marketplace_pickup_requests
  add constraint marketplace_pickup_requests_choice_shape check (
    (choice_kind is null and safe_meeting_place_id is null
      and buyer_terms_version is null and buyer_acknowledged_at is null)
    or (choice_kind = 'safe_meeting_place' and safe_meeting_place_id is not null
      and buyer_terms_version is null and buyer_acknowledged_at is null)
    or (choice_kind = 'seller_residence' and safe_meeting_place_id is null
      and buyer_terms_version is null and buyer_acknowledged_at is null)
  );

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
  origin public.geography(point, 4326);
  key_hash text;
  request_hash text;
  prior_response jsonb;
  response jsonb;
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  perform private.require_aal2();
  if not private.is_business_member(
      target_business_id, actor,
      array['owner', 'manager']::public.member_role[]
    )
    or accepted_attestation_version is distinct from '2026-08-01'
    or cardinality(choices) not between 2 and 3
    or cardinality(choices) <> (
      select count(distinct choice) from unnest(choices) choice
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_MEETING_ROUTE_SELECTION';
  end if;
  select location.point into origin
  from public.business_locations location
  join public.businesses business
    on business.id = location.business_id and business.kind = 'home_kitchen'
  where location.business_id = target_business_id
    and location.is_primary
    and location.publication_state <> 'archived';
  if origin is null or (
    select count(*) from private.safe_meeting_places place
    where place.public_id = any(choices)
      and place.active
      and place.rights_status in ('licensed', 'first_party')
      and place.expires_at > now()
      and public.st_dwithin(place.point, origin, 25000)
  ) <> cardinality(choices) then
    raise exception using errcode = '55000', message = 'MEETING_ROUTE_UNAVAILABLE';
  end if;

  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'business', target_business_id,
    'choices', choices,
    'attestation', accepted_attestation_version
  ));
  prior_response := private.marketplace_chat_idempotent_response(
    actor, 'set_business_meeting_routes', key_hash, request_hash
  );
  if prior_response is not null then return prior_response; end if;
  perform private.consume_rate_limit(
    actor, 'neighborhood_route_setting_hour', 20, 3600
  );

  update public.marketplace_pickup_requests request
  set state = 'cancelled', version = version + 1,
    responded_by = actor, responded_at = now(), updated_at = now()
  from public.marketplace_conversations conversation
  where request.conversation_id = conversation.id
    and conversation.business_id = target_business_id
    and request.choice_kind = 'safe_meeting_place'
    and request.state in ('pending', 'authorized')
    and not exists (
      select 1 from private.safe_meeting_places place
      where place.id = request.safe_meeting_place_id
        and place.public_id = any(choices)
    );

  delete from private.business_meeting_routes
  where business_id = target_business_id;
  insert into private.business_meeting_routes (
    business_id, meeting_place_id, ordinal, enabled_by, attestation_version
  )
  select target_business_id, place.id, choice.ordinality::smallint,
    actor, accepted_attestation_version
  from unnest(choices) with ordinality choice(public_id, ordinality)
  join private.safe_meeting_places place on place.public_id = choice.public_id;
  response := jsonb_build_object(
    'business_id', target_business_id,
    'selected_count', cardinality(choices)
  );
  perform private.store_marketplace_chat_idempotency(
    actor, 'set_business_meeting_routes', key_hash, request_hash, response
  );
  perform private.write_audit_event(
    actor, target_business_id,
    'neighborhood_pickup.routes_changed',
    'business', target_business_id::text,
    jsonb_build_object(
      'selected_count', cardinality(choices),
      'attestation_version', accepted_attestation_version
    )
  );
  return response;
end;
$$;
revoke all on function public.set_business_meeting_routes(uuid, uuid[], text, text)
  from public, anon;
grant execute on function public.set_business_meeting_routes(uuid, uuid[], text, text)
  to authenticated;

create or replace function private.cancel_unavailable_meeting_place_requests()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.marketplace_pickup_requests request
  set state = 'cancelled', version = version + 1,
    responded_at = now(), updated_at = now()
  where request.safe_meeting_place_id = new.id
    and request.state in ('pending', 'authorized')
    and (
      not new.active
      or new.rights_status not in ('licensed', 'first_party')
      or new.expires_at <= request.pickup_ends_at
    );
  return new;
end;
$$;
revoke all on function private.cancel_unavailable_meeting_place_requests()
  from public, anon, authenticated;
drop trigger if exists cancel_unavailable_meeting_place_requests
  on private.safe_meeting_places;
create trigger cancel_unavailable_meeting_place_requests
after update of active, expires_at, rights_status
on private.safe_meeting_places
for each row execute function private.cancel_unavailable_meeting_place_requests();

create or replace function public.cleanup_unavailable_meeting_place_requests(
  result_limit integer default 500
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare affected integer;
begin
  with targets as (
    select request.id
    from public.marketplace_pickup_requests request
    join private.safe_meeting_places place
      on place.id = request.safe_meeting_place_id
    where request.choice_kind = 'safe_meeting_place'
      and request.state in ('pending', 'authorized')
      and (
        not place.active
        or place.expires_at <= request.pickup_ends_at
        or place.rights_status not in ('licensed', 'first_party')
      )
    order by request.updated_at, request.id
    limit greatest(1, least(coalesce(result_limit, 500), 2000))
    for update of request skip locked
  )
  update public.marketplace_pickup_requests request
  set state = 'cancelled', version = version + 1,
    responded_at = now(), updated_at = now()
  from targets
  where request.id = targets.id;
  get diagnostics affected = row_count;
  return affected;
end;
$$;
revoke all on function public.cleanup_unavailable_meeting_place_requests(integer)
  from public, anon, authenticated;
grant execute on function public.cleanup_unavailable_meeting_place_requests(integer)
  to service_role;

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
  available boolean := false;
begin
  select c.* into conversation
  from public.marketplace_conversations c
  where c.public_id = target_conversation_public_id;
  if not found
    or not private.marketplace_conversation_access_allowed(conversation.id, actor)
    or private.users_are_blocked(conversation.customer_id, conversation.merchant_id)
  then
    raise exception using errcode = '42501', message = 'PICKUP_DETAIL_ACCESS_REQUIRED';
  end if;
  select r.* into request
  from public.marketplace_pickup_requests r
  where r.public_id = target_pickup_request_public_id
    and r.conversation_id = conversation.id
    and r.state = 'authorized'
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'PICKUP_DETAIL_NOT_AUTHORIZED';
  end if;
  select d.* into disclosure
  from private.neighborhood_pickup_disclosures d
  where d.request_id = request.id
  for update;
  if not found then return null; end if;

  if disclosure.choice_kind = 'safe_meeting_place' then
    available := exists (
      select 1
      from private.safe_meeting_places place
      join private.business_meeting_routes route
        on route.meeting_place_id = place.id
        and route.business_id = conversation.business_id
      where place.id = request.safe_meeting_place_id
        and place.active
        and place.rights_status in ('licensed', 'first_party')
        and place.expires_at > request.pickup_ends_at
    );
  else
    available := exists (
      select 1 from private.neighborhood_pickup_settings setting
      where setting.business_id = conversation.business_id
        and setting.residence_pickup_enabled
        and setting.seller_terms_version = '2026-08-01'
    );
  end if;
  if now() >= disclosure.expires_at or not available then
    delete from private.neighborhood_pickup_disclosures
    where request_id = request.id;
    update public.marketplace_pickup_requests
    set state = 'cancelled', version = version + 1,
      responded_at = now(), updated_at = now()
    where id = request.id;
    return null;
  end if;
  if actor = conversation.customer_id
    and disclosure.customer_first_viewed_at is null
  then
    update private.neighborhood_pickup_disclosures
    set customer_first_viewed_at = now()
    where request_id = request.id and customer_first_viewed_at is null;
    if found then
      perform private.write_audit_event(
        actor, conversation.business_id,
        'neighborhood_pickup.detail_first_viewed',
        'marketplace_pickup_request', request.public_id::text,
        jsonb_build_object('choice_kind', disclosure.choice_kind)
      );
    end if;
  end if;
  return jsonb_build_object(
    'pickup_request_public_id', request.public_id,
    'pickup_site_public_id', disclosure.choice_public_id,
    'label', disclosure.label,
    'site_kind', disclosure.choice_kind,
    'address_line', disclosure.address_line,
    'city', disclosure.city,
    'region', disclosure.region,
    'postal_code', disclosure.postal_code,
    'latitude', disclosure.latitude,
    'longitude', disclosure.longitude,
    'pickup_starts_at', request.pickup_starts_at,
    'pickup_ends_at', request.pickup_ends_at,
    'expires_at', disclosure.expires_at
  );
end;
$$;
revoke all on function public.get_authorized_neighborhood_pickup_detail(uuid, uuid)
  from public, anon;
grant execute on function public.get_authorized_neighborhood_pickup_detail(uuid, uuid)
  to authenticated;

create or replace function private.can_read_marketplace_chat_media_object(
  target_name text,
  target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.media_assets asset
    join public.marketplace_message_media link on link.asset_id = asset.id
    join public.marketplace_messages message on message.id = link.message_id
    left join private.marketplace_conversation_visibility visibility
      on visibility.conversation_id = message.conversation_id
      and visibility.user_id = target_user_id
    where asset.processed_storage_path = target_name
      and asset.quarantine_state = 'clean'
      and asset.moderation = 'approved'
      and message.visibility = 'visible'
      and message.deleted_at is null
      and private.marketplace_conversation_access_allowed(
        message.conversation_id, target_user_id
      )
      and (
        visibility.conversation_id is null
        or message.sequence > visibility.hidden_through_sequence
      )
  );
$$;
revoke all on function private.can_read_marketplace_chat_media_object(text, uuid)
  from public, anon, authenticated;
grant execute on function private.can_read_marketplace_chat_media_object(text, uuid)
  to authenticated;
