-- Finalize the buyer-chosen Neighborhood Kitchen meetup contract.
-- Retire the free-form/staff-approved pickup-site path, shorten exact-detail
-- retention, record immutable consent events, and keep existing conversations
-- writable when a seller disables new pop-up chats.

alter table private.safe_meeting_places
  add column if not exists source_updated_at timestamptz,
  add column if not exists rights_status text,
  add column if not exists source_license_ref text;

update private.safe_meeting_places
set source_updated_at = coalesce(source_updated_at, verified_at),
    rights_status = coalesce(rights_status, 'legacy_unverified'),
    active = case when rights_status in ('licensed', 'first_party') then active else false end;

alter table private.safe_meeting_places
  alter column source_updated_at set not null,
  alter column rights_status set not null;

alter table private.safe_meeting_places
  drop constraint if exists safe_meeting_places_place_kind_check;
alter table private.safe_meeting_places
  add constraint safe_meeting_places_place_kind_check
    check (place_kind in ('shopping_center', 'public_market', 'commercial_center'));
alter table private.safe_meeting_places
  drop constraint if exists safe_meeting_places_rights_status_check;
alter table private.safe_meeting_places
  add constraint safe_meeting_places_rights_status_check
    check (rights_status in ('licensed', 'first_party', 'legacy_unverified'));
alter table private.safe_meeting_places
  drop constraint if exists safe_meeting_places_active_rights_check;
alter table private.safe_meeting_places
  add constraint safe_meeting_places_active_rights_check
    check (
      not active
      or (
        rights_status in ('licensed', 'first_party')
        and source_license_ref is not null
        and char_length(btrim(source_license_ref)) between 3 and 240
        and source_updated_at <= now()
      )
    ) not valid;
alter table private.safe_meeting_places
  validate constraint safe_meeting_places_active_rights_check;

create table if not exists private.marketplace_consent_receipts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  business_id uuid not null,
  conversation_id uuid,
  request_id uuid,
  consent_kind text not null check (consent_kind in (
    'seller_residence_enable',
    'seller_route_attestation',
    'buyer_residence_choice',
    'merchant_residence_authorize'
  )),
  policy_version text not null,
  recorded_at timestamptz not null default now(),
  constraint marketplace_consent_policy_version
    check (char_length(btrim(policy_version)) between 3 and 80)
);
create index if not exists marketplace_consent_receipts_user_time_idx
  on private.marketplace_consent_receipts (user_id, recorded_at desc);
create index if not exists marketplace_consent_receipts_business_time_idx
  on private.marketplace_consent_receipts (business_id, recorded_at desc);
revoke all privileges on table private.marketplace_consent_receipts
  from public, anon, authenticated;
-- Preserve the prior versioned acknowledgements before the fail-closed cutover
-- destroys old exact-address cards and redacts public consent columns.
insert into private.marketplace_consent_receipts (
  user_id, business_id, consent_kind, policy_version, recorded_at
)
select setting.seller_acknowledged_by, setting.business_id,
  'seller_residence_enable', setting.seller_terms_version,
  setting.seller_acknowledged_at
from private.neighborhood_pickup_settings setting
where setting.residence_pickup_enabled
  and setting.seller_acknowledged_by is not null
  and setting.seller_terms_version is not null
  and setting.seller_acknowledged_at is not null;

insert into private.marketplace_consent_receipts (
  user_id, business_id, consent_kind, policy_version, recorded_at
)
select route.enabled_by, route.business_id, 'seller_route_attestation',
  route.attestation_version, route.enabled_at
from private.business_meeting_routes route
where route.enabled_by is not null;

insert into private.marketplace_consent_receipts (
  user_id, business_id, conversation_id, request_id,
  consent_kind, policy_version, recorded_at
)
select request.requested_by, conversation.business_id, request.conversation_id,
  request.id, 'buyer_residence_choice', request.buyer_terms_version,
  request.buyer_acknowledged_at
from public.marketplace_pickup_requests request
join public.marketplace_conversations conversation
  on conversation.id = request.conversation_id
where request.choice_kind = 'seller_residence'
  and request.buyer_terms_version is not null
  and request.buyer_acknowledged_at is not null;

insert into private.marketplace_consent_receipts (
  user_id, business_id, conversation_id, request_id,
  consent_kind, policy_version, recorded_at
)
select disclosure.authorized_by, conversation.business_id,
  request.conversation_id, request.id, 'merchant_residence_authorize',
  '2026-08-01', disclosure.authorized_at
from private.neighborhood_pickup_disclosures disclosure
join public.marketplace_pickup_requests request on request.id = disclosure.request_id
join public.marketplace_conversations conversation
  on conversation.id = request.conversation_id
where disclosure.choice_kind = 'seller_residence'
  and disclosure.authorized_by is not null;

create or replace function private.record_neighborhood_setting_consent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.residence_pickup_enabled
    and (tg_op = 'INSERT' or not old.residence_pickup_enabled
      or old.seller_terms_version is distinct from new.seller_terms_version)
  then
    insert into private.marketplace_consent_receipts (
      user_id, business_id, consent_kind, policy_version, recorded_at
    ) values (
      new.seller_acknowledged_by, new.business_id,
      'seller_residence_enable', new.seller_terms_version,
      coalesce(new.seller_acknowledged_at, now())
    );
  end if;
  return new;
end;
$$;
revoke all on function private.record_neighborhood_setting_consent()
  from public, anon, authenticated;
drop trigger if exists record_neighborhood_setting_consent
  on private.neighborhood_pickup_settings;
create trigger record_neighborhood_setting_consent
after insert or update of residence_pickup_enabled, seller_terms_version
on private.neighborhood_pickup_settings
for each row execute function private.record_neighborhood_setting_consent();

create or replace function private.record_neighborhood_route_consent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- One receipt per saved route preserves the exact attested route set without
  -- exposing the seller's origin or a derived distance.
  insert into private.marketplace_consent_receipts (
    user_id, business_id, consent_kind, policy_version, recorded_at
  ) values (
    new.enabled_by, new.business_id,
    'seller_route_attestation', new.attestation_version, new.enabled_at
  );
  return new;
end;
$$;
revoke all on function private.record_neighborhood_route_consent()
  from public, anon, authenticated;
drop trigger if exists record_neighborhood_route_consent
  on private.business_meeting_routes;
create trigger record_neighborhood_route_consent
after insert on private.business_meeting_routes
for each row execute function private.record_neighborhood_route_consent();

create or replace function private.record_neighborhood_request_consent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare target_business_id uuid;
begin
  if new.choice_kind = 'seller_residence' then
    select conversation.business_id into target_business_id
    from public.marketplace_conversations conversation
    where conversation.id = new.conversation_id;
    insert into private.marketplace_consent_receipts (
      user_id, business_id, conversation_id, request_id,
      consent_kind, policy_version, recorded_at
    ) values (
      new.requested_by, target_business_id, new.conversation_id, new.id,
      'buyer_residence_choice', new.buyer_terms_version,
      coalesce(new.buyer_acknowledged_at, now())
    );
  end if;
  return new;
end;
$$;
revoke all on function private.record_neighborhood_request_consent()
  from public, anon, authenticated;
drop trigger if exists record_neighborhood_request_consent
  on public.marketplace_pickup_requests;
create trigger record_neighborhood_request_consent
after insert on public.marketplace_pickup_requests
for each row execute function private.record_neighborhood_request_consent();

create or replace function private.record_neighborhood_authorization_consent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_conversation_id uuid;
  target_business_id uuid;
begin
  if new.choice_kind = 'seller_residence' then
    select request.conversation_id, conversation.business_id
      into target_conversation_id, target_business_id
    from public.marketplace_pickup_requests request
    join public.marketplace_conversations conversation
      on conversation.id = request.conversation_id
    where request.id = new.request_id;
    insert into private.marketplace_consent_receipts (
      user_id, business_id, conversation_id, request_id,
      consent_kind, policy_version, recorded_at
    ) values (
      new.authorized_by, target_business_id, target_conversation_id,
      new.request_id, 'merchant_residence_authorize',
      '2026-08-01', new.authorized_at
    );
  end if;
  return new;
end;
$$;
revoke all on function private.record_neighborhood_authorization_consent()
  from public, anon, authenticated;
drop trigger if exists record_neighborhood_authorization_consent
  on private.neighborhood_pickup_disclosures;
create trigger record_neighborhood_authorization_consent
after insert on private.neighborhood_pickup_disclosures
for each row execute function private.record_neighborhood_authorization_consent();

-- Exact details are destroyed before tightening the contract. This is safer
-- than preserving cards that were minted under the previous 12-hour rule.
-- Cancel every active neighborhood request first so no request remains
-- authorized without a disclosure and the one-active-request guard is released.
update public.marketplace_pickup_requests
set state = 'cancelled', version = version + 1,
  responded_at = now(), updated_at = now()
where choice_kind in ('safe_meeting_place', 'seller_residence')
  and state in ('pending', 'authorized');
delete from private.neighborhood_pickup_disclosures;
alter table private.neighborhood_pickup_disclosures
  drop constraint if exists neighborhood_pickup_disclosure_expiry;
alter table private.neighborhood_pickup_disclosures
  add constraint neighborhood_pickup_disclosure_expiry check (
    expires_at > authorized_at
    and expires_at <= authorized_at + interval '24 hours'
  );

create or replace function private.enforce_neighborhood_disclosure_window()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare request_end timestamptz;
begin
  select request.pickup_ends_at into request_end
  from public.marketplace_pickup_requests request
  where request.id = new.request_id;
  if request_end is null
    or new.expires_at is distinct from least(
      request_end + interval '2 hours',
      new.authorized_at + interval '24 hours'
    )
  then
    raise exception using errcode = '23514', message = 'INVALID_PICKUP_DISCLOSURE_WINDOW';
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_neighborhood_disclosure_window()
  from public, anon, authenticated;
drop trigger if exists enforce_neighborhood_disclosure_window
  on private.neighborhood_pickup_disclosures;
create trigger enforce_neighborhood_disclosure_window
before insert or update of expires_at, authorized_at, request_id
on private.neighborhood_pickup_disclosures
for each row execute function private.enforce_neighborhood_disclosure_window();

create table if not exists private.business_payment_confirmations (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  confirmed_by uuid,
  confirmed_at timestamptz not null
);
revoke all privileges on table private.business_payment_confirmations
  from public, anon, authenticated;

create or replace function private.refresh_business_payment_confirmation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_business_id uuid := coalesce(new.business_id, old.business_id);
begin
  if actor is not null and private.is_business_member(
    target_business_id, actor,
    array['owner', 'manager']::public.member_role[]
  ) then
    insert into private.business_payment_confirmations (
      business_id, confirmed_by, confirmed_at
    ) values (target_business_id, actor, now())
    on conflict (business_id) do update set
      confirmed_by = excluded.confirmed_by,
      confirmed_at = excluded.confirmed_at;
  else
    delete from private.business_payment_confirmations
    where business_id = target_business_id;
  end if;
  return coalesce(new, old);
end;
$$;
revoke all on function private.refresh_business_payment_confirmation()
  from public, anon, authenticated;
drop trigger if exists refresh_business_payment_confirmation
  on public.business_payments;
create trigger refresh_business_payment_confirmation
after insert or delete on public.business_payments
for each row execute function private.refresh_business_payment_confirmation();

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
  if not found or not private.marketplace_conversation_access_allowed(
    target_conversation.id, actor
  ) then
    raise exception using errcode = '42501', message = 'CHAT_ACCESS_REQUIRED';
  end if;
  return (
    select jsonb_build_object(
      'business_kind', business.kind::text,
      'participant_role', case
        when actor = target_conversation.customer_id then 'customer'
        else 'merchant'
      end,
      'actor_public_profile_id', (
        select profile.public_id from public.profiles profile
        where profile.user_id = actor
      ),
      'payment_methods', coalesce((
        select jsonb_agg(payment.payment::text order by payment.payment::text)
        from public.business_payments payment
        where payment.business_id = target_conversation.business_id
      ), '[]'::jsonb),
      'payment_methods_confirmed_at', (
        select confirmation.confirmed_at
        from private.business_payment_confirmations confirmation
        where confirmation.business_id = target_conversation.business_id
      ),
      'platform_payment_enabled', false
    )
    from public.businesses business
    where business.id = target_conversation.business_id
  );
end;
$$;
revoke all on function public.get_marketplace_conversation_context(uuid)
  from public, anon;
grant execute on function public.get_marketplace_conversation_context(uuid)
  to authenticated;

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

-- Existing legacy requests are closed before their free-form detail APIs are
-- retired. Neighborhood requests have a non-null choice_kind and remain valid.
update public.marketplace_pickup_requests
set state = 'cancelled', version = version + 1,
  responded_at = now(), updated_at = now()
where choice_kind is null and state in ('pending', 'authorized');
delete from private.marketplace_pickup_disclosures;

drop trigger if exists close_pop_up_chat_on_disable
  on public.business_marketplace_chat_settings;
drop function if exists private.close_pop_up_chat_on_disable();

revoke all on function public.close_marketplace_conversation(uuid, text)
  from public, anon, authenticated;
revoke all on function public.submit_marketplace_pickup_site(
  uuid, text, text, text, text, text, text, double precision,
  double precision, text
) from public, anon, authenticated;
revoke all on function public.list_pending_marketplace_pickup_sites(integer, integer)
  from public, anon, authenticated;
revoke all on function public.review_marketplace_pickup_site(
  uuid, text, boolean, text, text
) from public, anon, authenticated;
revoke all on function public.list_managed_marketplace_pickup_sites(
  uuid, integer, integer
) from public, anon, authenticated;
revoke all on function public.archive_marketplace_pickup_site(
  uuid, timestamptz, text
) from public, anon, authenticated;
revoke all on function public.request_marketplace_pickup_detail(
  uuid, timestamptz, timestamptz, text, text
) from public, anon, authenticated;
revoke all on function public.list_marketplace_pickup_options(uuid)
  from public, anon, authenticated;
revoke all on function public.authorize_marketplace_pickup_detail(
  uuid, uuid, uuid, integer, text
) from public, anon, authenticated;
revoke all on function public.get_authorized_marketplace_pickup_detail(uuid, uuid)
  from public, anon, authenticated;

-- Service-role ingestion remains the only write path. Active rows additionally
-- fail closed unless the provider job supplies current provenance and rights.
grant select, insert, update on private.safe_meeting_places to service_role;
