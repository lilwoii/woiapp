-- Consent-based invitations from verified business operators to established
-- reviewers. Invitations may never require, purchase, or condition a review.

alter table public.profiles
  add column if not exists allow_business_invitations boolean not null default false;

create table if not exists public.creator_invitations (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null default gen_random_uuid() unique,
  business_id uuid not null references public.businesses(id) on delete cascade,
  sender_id uuid references auth.users(id) on delete set null,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  message text not null,
  response_note text,
  event_starts_at timestamptz not null,
  event_ends_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'withdrawn', 'expired')),
  review_required boolean not null default false check (not review_required),
  terms_version text not null default 'creator-invite-2026-09-15',
  idempotency_key_hash text not null,
  request_hash text not null,
  responded_at timestamptz,
  withdrawn_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint creator_invitations_title_length check (char_length(btrim(title)) between 3 and 80),
  constraint creator_invitations_message_length check (char_length(btrim(message)) between 10 and 800),
  constraint creator_invitations_response_length check (response_note is null or char_length(btrim(response_note)) between 1 and 500),
  constraint creator_invitations_window check (
    event_ends_at > event_starts_at and event_ends_at <= event_starts_at + interval '24 hours'
  ),
  constraint creator_invitations_hashes check (
    idempotency_key_hash ~ '^[0-9a-f]{64}$' and request_hash ~ '^[0-9a-f]{64}$'
  ),
  unique (sender_id, idempotency_key_hash)
);

create index if not exists creator_invitations_recipient_time_idx
  on public.creator_invitations (recipient_id, created_at desc);
create index if not exists creator_invitations_business_time_idx
  on public.creator_invitations (business_id, created_at desc);
alter table public.creator_invitations enable row level security;
alter table public.creator_invitations force row level security;
revoke all on public.creator_invitations from public, anon, authenticated, service_role;

create or replace function public.set_creator_invitation_consent(next_value boolean)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  perform private.require_aal2();
  if not private.is_active_user(actor) or next_value is null then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;
  perform private.consume_rate_limit(actor, 'creator_invite_consent', 20, 3600);
  update public.profiles profile set allow_business_invitations = next_value, updated_at = now()
  where profile.user_id = actor;
  perform private.write_audit_event(actor, null, 'profile.creator_invite_consent_changed', 'profile', null,
    jsonb_build_object('enabled', next_value));
  return next_value;
end;
$$;

create or replace function public.update_social_profile_with_invitation_consent(
  payload jsonb, next_consent boolean
)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare actor uuid := auth.uid(); prior_consent boolean;
begin
  perform private.require_aal2();
  if not private.is_active_user(actor) or next_consent is null then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;
  select profile.allow_business_invitations into prior_consent
  from public.profiles profile where profile.user_id = actor for update;
  perform public.update_own_social_profile(payload);
  update public.profiles profile set allow_business_invitations = next_consent, updated_at = now()
  where profile.user_id = actor;
  if prior_consent is distinct from next_consent then
    perform private.write_audit_event(actor, null, 'profile.creator_invite_consent_changed', 'profile', null,
      jsonb_build_object('enabled', next_consent));
  end if;
end;
$$;

create or replace function public.can_receive_creator_invitation(target_profile_public_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare actor uuid := auth.uid(); recipient uuid;
begin
  if not private.is_active_user(actor) or not exists (
    select 1 from public.business_members member
    join public.businesses business on business.id = member.business_id
    where member.user_id = actor and member.status = 'active' and member.role in ('owner', 'manager')
      and business.verification = 'verified' and private.is_business_publicly_eligible(business.id)
  ) then return false; end if;
  select profile.user_id into recipient from public.profiles profile
  where profile.public_id = target_profile_public_id and profile.status = 'active'
    and profile.allow_business_invitations and profile.user_id <> actor;
  if recipient is null or private.users_are_blocked(actor, recipient) then return false; end if;
  return (select count(*) >= 10 from public.reviews review
    where review.author_id = recipient and review.moderation = 'approved' and review.deleted_at is null
      and private.is_business_publicly_eligible(review.business_id));
end;
$$;

create or replace function public.send_creator_invitation(
  target_business_id uuid,
  target_profile_public_id uuid,
  invite_title text,
  invite_message text,
  invite_starts_at timestamptz,
  invite_ends_at timestamptz,
  no_review_required_ack boolean,
  idempotency_key text
)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  actor uuid := auth.uid(); recipient uuid; invite_id uuid; invite_public_id uuid;
  normalized_title text := btrim(coalesce(invite_title, ''));
  normalized_message text := btrim(coalesce(invite_message, ''));
  key_hash text; payload_hash text; prior_hash text;
begin
  perform private.require_aal2();
  if not private.is_active_user(actor) then raise exception using errcode = '42501', message = 'Active verified account required'; end if;
  if not exists (
    select 1 from public.business_members member join public.businesses business on business.id = member.business_id
    where member.business_id = target_business_id and member.user_id = actor and member.status = 'active'
      and member.role in ('owner', 'manager') and business.verification = 'verified'
      and private.is_business_publicly_eligible(business.id)
  ) then raise exception using errcode = '42501', message = 'Verified owner or manager required'; end if;
  if not no_review_required_ack then raise exception using errcode = '22023', message = 'Review independence acknowledgment required'; end if;
  if char_length(normalized_title) not between 3 and 80 or char_length(normalized_message) not between 10 and 800
    or not private.content_is_professional(normalized_title) or not private.content_is_professional(normalized_message)
    or normalized_message ~* '(five[ -]?star|5[ -]?star|positive review|good review|required review|review in exchange)'
    or invite_starts_at < now() + interval '2 hours' or invite_starts_at > now() + interval '180 days'
    or invite_ends_at <= invite_starts_at or invite_ends_at > invite_starts_at + interval '24 hours'
    or idempotency_key !~ '^spottr:invite:[A-Za-z0-9._:-]{12,180}$'
  then raise exception using errcode = '22023', message = 'Invalid creator invitation'; end if;

  select profile.user_id into recipient from public.profiles profile
  where profile.public_id = target_profile_public_id and profile.status = 'active'
    and profile.allow_business_invitations and profile.user_id <> actor;
  if recipient is null or private.users_are_blocked(actor, recipient) or not (
    select count(*) >= 10 from public.reviews review
    where review.author_id = recipient and review.moderation = 'approved' and review.deleted_at is null
      and private.is_business_publicly_eligible(review.business_id)
  ) then raise exception using errcode = '22023', message = 'Recipient is not eligible for invitations'; end if;

  perform private.consume_rate_limit(actor, 'creator_invite_send_hour', 8, 3600);
  perform private.consume_rate_limit(actor, 'creator_invite_send_day', 20, 86400);
  perform private.consume_rate_limit(recipient, 'creator_invite_receive_week', 12, 604800);
  key_hash := encode(digest(idempotency_key, 'sha256'), 'hex');
  payload_hash := encode(digest(concat_ws('|', target_business_id, recipient, normalized_title,
    normalized_message, invite_starts_at, invite_ends_at), 'sha256'), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text || key_hash, 915150));

  select invitation.public_id, invitation.request_hash into invite_public_id, prior_hash
  from public.creator_invitations invitation
  where invitation.sender_id = actor and invitation.idempotency_key_hash = key_hash;
  if invite_public_id is not null then
    if prior_hash <> payload_hash then raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED'; end if;
    return invite_public_id;
  end if;

  insert into public.creator_invitations (
    business_id, sender_id, recipient_id, title, message, event_starts_at, event_ends_at,
    review_required, idempotency_key_hash, request_hash
  ) values (
    target_business_id, actor, recipient, normalized_title, normalized_message, invite_starts_at,
    invite_ends_at, false, key_hash, payload_hash
  ) returning id, public_id into invite_id, invite_public_id;
  perform private.write_audit_event(actor, target_business_id, 'creator.invitation_sent', 'creator_invitation', invite_id::text,
    jsonb_build_object('recipient_public_id', target_profile_public_id, 'event_starts_at', invite_starts_at));
  return invite_public_id;
end;
$$;

create or replace function public.respond_creator_invitation(
  target_invitation_public_id uuid, decision text, response_message text default null
)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare actor uuid := auth.uid(); normalized_note text := nullif(btrim(response_message), ''); target record;
begin
  if not private.is_active_user(actor) then raise exception using errcode = '42501', message = 'Active account required'; end if;
  if decision not in ('accepted', 'declined') or char_length(coalesce(normalized_note, '')) > 500
    or not private.content_is_professional(normalized_note)
  then raise exception using errcode = '22023', message = 'Invalid invitation response'; end if;
  select invitation.id, invitation.business_id, invitation.status, invitation.event_starts_at into target
  from public.creator_invitations invitation
  where invitation.public_id = target_invitation_public_id and invitation.recipient_id = actor
  for update;
  if target.id is null or target.status <> 'pending' or target.event_starts_at <= now() then
    raise exception using errcode = '40001', message = 'Invitation is no longer pending';
  end if;
  perform private.consume_rate_limit(actor, 'creator_invite_response', 30, 3600);
  update public.creator_invitations invitation set status = decision, response_note = normalized_note,
    responded_at = now(), updated_at = now() where invitation.id = target.id;
  perform private.write_audit_event(actor, target.business_id, 'creator.invitation_responded', 'creator_invitation', target.id::text,
    jsonb_build_object('decision', decision));
  return decision;
end;
$$;

create or replace view public.my_creator_invitations
with (security_barrier = true, security_invoker = false) as
select invitation.public_id, invitation.business_id, business.name as business_name,
  sender_profile.public_id as sender_public_id, sender_profile.display_name as sender_name,
  recipient_profile.public_id as recipient_public_id, recipient_profile.display_name as recipient_name,
  invitation.title, invitation.message, invitation.response_note, invitation.event_starts_at,
  invitation.event_ends_at,
  case when invitation.status = 'pending' and invitation.event_starts_at <= now() then 'expired' else invitation.status end as status,
  invitation.created_at, invitation.responded_at,
  (invitation.recipient_id = auth.uid()) as is_recipient
from public.creator_invitations invitation
join public.businesses business on business.id = invitation.business_id
left join public.profiles sender_profile on sender_profile.user_id = invitation.sender_id
join public.profiles recipient_profile on recipient_profile.user_id = invitation.recipient_id
where auth.uid() in (invitation.sender_id, invitation.recipient_id)
  and (invitation.sender_id is null or not private.users_are_blocked(invitation.sender_id, invitation.recipient_id));

revoke all on function public.set_creator_invitation_consent(boolean) from public;
revoke all on function public.update_social_profile_with_invitation_consent(jsonb, boolean) from public;
revoke all on function public.can_receive_creator_invitation(uuid) from public;
revoke all on function public.send_creator_invitation(uuid, uuid, text, text, timestamptz, timestamptz, boolean, text) from public;
revoke all on function public.respond_creator_invitation(uuid, text, text) from public;
grant execute on function public.set_creator_invitation_consent(boolean) to authenticated;
grant execute on function public.update_social_profile_with_invitation_consent(jsonb, boolean) to authenticated;
grant execute on function public.can_receive_creator_invitation(uuid) to authenticated;
grant execute on function public.send_creator_invitation(uuid, uuid, text, text, timestamptz, timestamptz, boolean, text) to authenticated;
grant execute on function public.respond_creator_invitation(uuid, text, text) to authenticated;
revoke all on public.my_creator_invitations from public, anon, authenticated;
grant select on public.my_creator_invitations to authenticated;
