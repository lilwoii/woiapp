-- PostgreSQL evaluates `null not in (...)` and `not null` as unknown. Preserve
-- the established authority transactions behind private cores, while requiring
-- every public decision and review-independence acknowledgment to be explicit.

alter function public.review_business_revision(uuid, text, text)
  rename to review_business_revision_null_safe_core;
alter function public.review_business_revision_null_safe_core(uuid, text, text)
  set schema private;

revoke all on function private.review_business_revision_null_safe_core(
  uuid, text, text
) from public, anon, authenticated, service_role;

create function public.review_business_revision(
  target_revision_id uuid,
  decision text,
  moderation_reason text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_aal2();
  if not private.is_platform_staff(
    auth.uid(),
    array['admin']::public.platform_role[]
  ) then
    raise exception using
      errcode = '42501',
      message = 'Platform administrator role required';
  end if;
  if decision is null then
    raise exception using
      errcode = '22023',
      message = 'Invalid revision decision';
  end if;

  perform private.review_business_revision_null_safe_core(
    target_revision_id,
    decision,
    moderation_reason
  );
end;
$$;

revoke all on function public.review_business_revision(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.review_business_revision(uuid, text, text)
  to authenticated;

alter function public.send_creator_invitation(
  uuid, uuid, text, text, timestamptz, timestamptz, boolean, text
)
  rename to send_creator_invitation_explicit_ack_core;
alter function public.send_creator_invitation_explicit_ack_core(
  uuid, uuid, text, text, timestamptz, timestamptz, boolean, text
)
  set schema private;

revoke all on function private.send_creator_invitation_explicit_ack_core(
  uuid, uuid, text, text, timestamptz, timestamptz, boolean, text
) from public, anon, authenticated, service_role;

create function public.send_creator_invitation(
  target_business_id uuid,
  target_profile_public_id uuid,
  invite_title text,
  invite_message text,
  invite_starts_at timestamptz,
  invite_ends_at timestamptz,
  no_review_required_ack boolean,
  idempotency_key text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  perform private.require_aal2();
  if not private.is_active_user(actor) then
    raise exception using
      errcode = '42501',
      message = 'Active verified account required';
  end if;
  if not exists (
    select 1
    from public.business_members member
    join public.businesses business on business.id = member.business_id
    where member.business_id = target_business_id
      and member.user_id = actor
      and member.status = 'active'
      and member.role in ('owner', 'manager')
      and business.verification = 'verified'
      and private.is_business_publicly_eligible(business.id)
  ) then
    raise exception using
      errcode = '42501',
      message = 'Verified owner or manager required';
  end if;
  if no_review_required_ack is distinct from true then
    raise exception using
      errcode = '22023',
      message = 'Review independence acknowledgment required';
  end if;

  return private.send_creator_invitation_explicit_ack_core(
    target_business_id,
    target_profile_public_id,
    invite_title,
    invite_message,
    invite_starts_at,
    invite_ends_at,
    no_review_required_ack,
    idempotency_key
  );
end;
$$;

revoke all on function public.send_creator_invitation(
  uuid, uuid, text, text, timestamptz, timestamptz, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function public.send_creator_invitation(
  uuid, uuid, text, text, timestamptz, timestamptz, boolean, text
) to authenticated;

create or replace function public.respond_business_invitation(
  target_invitation_id uuid,
  decision text
)
returns table (
  business_id uuid,
  business_name text,
  role public.member_role,
  state text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  locked_business_id uuid;
begin
  perform private.require_aal2();
  if not private.is_active_user(actor) then
    raise exception using
      errcode = '42501',
      message = 'Active verified account required';
  end if;
  if decision is null then
    raise exception using
      errcode = '22023',
      message = 'Invalid invitation decision';
  end if;

  select invitation.business_id
  into locked_business_id
  from private.business_invitations invitation
  where invitation.id = target_invitation_id;

  if locked_business_id is null then
    raise exception using
      errcode = '22023',
      message = 'Invitation not found';
  end if;

  perform 1
  from public.businesses business
  where business.id = locked_business_id
  for update;
  if not found then
    raise exception using
      errcode = '22023',
      message = 'Invitation not found';
  end if;

  return query
  select *
  from private.respond_business_invitation_core(target_invitation_id, decision);
end;
$$;

revoke all on function public.respond_business_invitation(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.respond_business_invitation(uuid, text)
  to authenticated;

alter function public.respond_creator_invitation(uuid, text, text)
  rename to respond_creator_invitation_null_safe_core;
alter function public.respond_creator_invitation_null_safe_core(uuid, text, text)
  set schema private;

revoke all on function private.respond_creator_invitation_null_safe_core(
  uuid, text, text
) from public, anon, authenticated, service_role;

create function public.respond_creator_invitation(
  target_invitation_public_id uuid,
  decision text,
  response_message text default null
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  -- Authenticate before validating caller-controlled input so unauthenticated
  -- callers cannot use validation differences as an application oracle.
  if not private.is_active_user(actor) then
    raise exception using
      errcode = '42501',
      message = 'Active account required';
  end if;
  if decision is null then
    raise exception using
      errcode = '22023',
      message = 'Invalid invitation response';
  end if;

  return private.respond_creator_invitation_null_safe_core(
    target_invitation_public_id,
    decision,
    response_message
  );
end;
$$;

revoke all on function public.respond_creator_invitation(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.respond_creator_invitation(uuid, text, text)
  to authenticated;
