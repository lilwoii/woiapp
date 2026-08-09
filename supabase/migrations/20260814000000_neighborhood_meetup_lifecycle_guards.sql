-- Lifecycle guards that apply regardless of which privileged RPC performs the
-- mutation. These close account-deletion, consent, and stale-provider races.

drop trigger if exists record_neighborhood_request_consent
  on public.marketplace_pickup_requests;
drop trigger if exists privatize_neighborhood_request_consent
  on public.marketplace_pickup_requests;

create or replace function private.privatize_neighborhood_request_consent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare target_business_id uuid;
begin
  if new.choice_kind = 'seller_residence' then
    if new.buyer_terms_version is distinct from '2026-08-01'
      or new.buyer_acknowledged_at is null
    then
      raise exception using errcode = '23514', message = 'RESIDENCE_PICKUP_CONSENT_REQUIRED';
    end if;
    select conversation.business_id into target_business_id
    from public.marketplace_conversations conversation
    where conversation.id = new.conversation_id;
    if target_business_id is null then
      raise exception using errcode = '23503', message = 'PICKUP_CONVERSATION_REQUIRED';
    end if;
    insert into private.marketplace_consent_receipts (
      user_id, business_id, conversation_id, request_id,
      consent_kind, policy_version, recorded_at
    ) values (
      new.requested_by, target_business_id, new.conversation_id, new.id,
      'buyer_residence_choice', new.buyer_terms_version,
      new.buyer_acknowledged_at
    );
    new.buyer_terms_version := null;
    new.buyer_acknowledged_at := null;
  elsif new.buyer_terms_version is not null
    or new.buyer_acknowledged_at is not null
  then
    raise exception using errcode = '23514', message = 'UNEXPECTED_PICKUP_CONSENT_METADATA';
  end if;
  return new;
end;
$$;
revoke all on function private.privatize_neighborhood_request_consent()
  from public, anon, authenticated;
create trigger privatize_neighborhood_request_consent
before insert on public.marketplace_pickup_requests
for each row execute function private.privatize_neighborhood_request_consent();

create or replace function private.require_current_meeting_place_for_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.choice_kind = 'safe_meeting_place' and not exists (
    select 1
    from private.safe_meeting_places place
    join public.marketplace_conversations conversation
      on conversation.id = new.conversation_id
    join private.business_meeting_routes route
      on route.business_id = conversation.business_id
      and route.meeting_place_id = place.id
    where place.id = new.safe_meeting_place_id
      and place.active
      and place.rights_status in ('licensed', 'first_party')
      and place.expires_at > new.pickup_ends_at
  ) then
    raise exception using errcode = '23514', message = 'PICKUP_CHOICE_NOT_CURRENT_FOR_WINDOW';
  end if;
  return new;
end;
$$;
revoke all on function private.require_current_meeting_place_for_request()
  from public, anon, authenticated;
drop trigger if exists require_current_meeting_place_for_request
  on public.marketplace_pickup_requests;
create trigger require_current_meeting_place_for_request
before insert or update of conversation_id, choice_kind,
  safe_meeting_place_id, pickup_ends_at
on public.marketplace_pickup_requests
for each row execute function private.require_current_meeting_place_for_request();

create or replace function private.require_usable_residence_pickup_location()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.residence_pickup_enabled and not exists (
    select 1
    from public.business_locations location
    where location.business_id = new.business_id
      and location.is_primary
      and location.publication_state <> 'archived'
      and nullif(btrim(location.address_line), '') is not null
  ) then
    raise exception using errcode = '23514', message = 'USABLE_RESIDENCE_PICKUP_LOCATION_REQUIRED';
  end if;
  return new;
end;
$$;
revoke all on function private.require_usable_residence_pickup_location()
  from public, anon, authenticated;
drop trigger if exists require_usable_residence_pickup_location
  on private.neighborhood_pickup_settings;
create trigger require_usable_residence_pickup_location
before insert or update of residence_pickup_enabled
on private.neighborhood_pickup_settings
for each row execute function private.require_usable_residence_pickup_location();

create or replace function private.freeze_neighborhood_residence_on_account_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state in ('started', 'processing', 'storage_deleted', 'failed') then
    with disabled as (
      update private.neighborhood_pickup_settings setting
      set residence_pickup_enabled = false,
        seller_terms_version = null,
        seller_acknowledged_by = null,
        seller_acknowledged_at = null,
        updated_at = now()
      where setting.seller_acknowledged_by = new.user_id
        and setting.residence_pickup_enabled
      returning setting.business_id
    )
    update public.marketplace_pickup_requests request
    set state = 'cancelled', version = version + 1,
      responded_at = now(), updated_at = now()
    from public.marketplace_conversations conversation
    where request.conversation_id = conversation.id
      and conversation.business_id in (select business_id from disabled)
      and request.choice_kind = 'seller_residence'
      and request.state in ('pending', 'authorized');
  end if;
  return new;
end;
$$;
revoke all on function private.freeze_neighborhood_residence_on_account_deletion()
  from public, anon, authenticated;
drop trigger if exists freeze_neighborhood_residence_on_account_deletion
  on private.account_deletion_requests;
create trigger freeze_neighborhood_residence_on_account_deletion
after insert or update on private.account_deletion_requests
for each row execute function private.freeze_neighborhood_residence_on_account_deletion();
