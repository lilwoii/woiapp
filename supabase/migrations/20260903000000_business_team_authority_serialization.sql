-- Serialize every team mutation on the business row before evaluating the
-- caller's role. This closes cross-device races where an owner or manager
-- could otherwise finish a privileged write after ownership/access changed.
-- The original implementations become private cores so existing RPC names
-- remain stable while callers cannot bypass the serialization boundary.

alter function public.invite_business_member(
  uuid,
  text,
  public.member_role,
  text
) set schema private;
alter function private.invite_business_member(
  uuid,
  text,
  public.member_role,
  text
) rename to invite_business_member_core;

alter function public.respond_business_invitation(uuid, text) set schema private;
alter function private.respond_business_invitation(uuid, text)
  rename to respond_business_invitation_core;

alter function public.set_business_member_role(
  uuid,
  uuid,
  public.member_role
) set schema private;
alter function private.set_business_member_role(
  uuid,
  uuid,
  public.member_role
) rename to set_business_member_role_core;

alter function public.revoke_business_member(uuid, uuid) set schema private;
alter function private.revoke_business_member(uuid, uuid)
  rename to revoke_business_member_core;

alter function public.revoke_business_invitation(uuid, uuid) set schema private;
alter function private.revoke_business_invitation(uuid, uuid)
  rename to revoke_business_invitation_core;

alter function public.transfer_business_ownership(uuid, uuid, text)
  set schema private;
alter function private.transfer_business_ownership(uuid, uuid, text)
  rename to transfer_business_ownership_core;

revoke all on function private.invite_business_member_core(
  uuid,
  text,
  public.member_role,
  text
) from public, anon, authenticated;
revoke all on function private.respond_business_invitation_core(uuid, text)
  from public, anon, authenticated;
revoke all on function private.set_business_member_role_core(
  uuid,
  uuid,
  public.member_role
) from public, anon, authenticated;
revoke all on function private.revoke_business_member_core(uuid, uuid)
  from public, anon, authenticated;
revoke all on function private.revoke_business_invitation_core(uuid, uuid)
  from public, anon, authenticated;
revoke all on function private.transfer_business_ownership_core(uuid, uuid, text)
  from public, anon, authenticated;

create or replace function public.invite_business_member(
  target_business_id uuid,
  invite_target text,
  invite_role public.member_role,
  idempotency_key text
)
returns table (
  invitation_id uuid,
  target_type text,
  target_hint text,
  role public.member_role,
  state text,
  expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_aal2();
  perform 1
  from public.businesses business
  where business.id = target_business_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Business not found';
  end if;

  return query
  select *
  from private.invite_business_member_core(
    target_business_id,
    invite_target,
    invite_role,
    idempotency_key
  );
end;
$$;

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
  locked_business_id uuid;
begin
  perform private.require_aal2();
  select invitation.business_id
  into locked_business_id
  from private.business_invitations invitation
  where invitation.id = target_invitation_id;

  if locked_business_id is null then
    raise exception using errcode = '22023', message = 'Invitation not found';
  end if;

  perform 1
  from public.businesses business
  where business.id = locked_business_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Invitation not found';
  end if;

  return query
  select *
  from private.respond_business_invitation_core(target_invitation_id, decision);
end;
$$;

create or replace function public.set_business_member_role(
  target_business_id uuid,
  target_member_public_id uuid,
  next_role public.member_role
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_aal2();
  perform 1
  from public.businesses business
  where business.id = target_business_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Business not found';
  end if;

  perform private.set_business_member_role_core(
    target_business_id,
    target_member_public_id,
    next_role
  );
end;
$$;

create or replace function public.revoke_business_member(
  target_business_id uuid,
  target_member_public_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_aal2();
  perform 1
  from public.businesses business
  where business.id = target_business_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Business not found';
  end if;

  perform private.revoke_business_member_core(
    target_business_id,
    target_member_public_id
  );
end;
$$;

create or replace function public.revoke_business_invitation(
  target_business_id uuid,
  target_invitation_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_aal2();
  perform 1
  from public.businesses business
  where business.id = target_business_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Business not found';
  end if;

  perform private.revoke_business_invitation_core(
    target_business_id,
    target_invitation_id
  );
end;
$$;

create or replace function public.transfer_business_ownership(
  target_business_id uuid,
  target_member_public_id uuid,
  idempotency_key text
)
returns table (
  previous_owner_public_id uuid,
  new_owner_public_id uuid,
  previous_owner_role public.member_role,
  new_owner_role public.member_role
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_aal2();
  perform 1
  from public.businesses business
  where business.id = target_business_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Business not found';
  end if;

  return query
  select *
  from private.transfer_business_ownership_core(
    target_business_id,
    target_member_public_id,
    idempotency_key
  );
end;
$$;

revoke all on function public.invite_business_member(
  uuid,
  text,
  public.member_role,
  text
) from public, anon, authenticated;
grant execute on function public.invite_business_member(
  uuid,
  text,
  public.member_role,
  text
) to authenticated;

revoke all on function public.respond_business_invitation(uuid, text)
  from public, anon, authenticated;
grant execute on function public.respond_business_invitation(uuid, text)
  to authenticated;

revoke all on function public.set_business_member_role(
  uuid,
  uuid,
  public.member_role
) from public, anon, authenticated;
grant execute on function public.set_business_member_role(
  uuid,
  uuid,
  public.member_role
) to authenticated;

revoke all on function public.revoke_business_member(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_business_member(uuid, uuid)
  to authenticated;

revoke all on function public.revoke_business_invitation(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_business_invitation(uuid, uuid)
  to authenticated;

revoke all on function public.transfer_business_ownership(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.transfer_business_ownership(uuid, uuid, text)
  to authenticated;
