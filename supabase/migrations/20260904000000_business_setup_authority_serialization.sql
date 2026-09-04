-- Keep setup and live-schedule authority stable for the whole mutation. The
-- public wrappers lock the business before delegating to the previous private
-- implementation, so ownership transfer or member revocation cannot race an
-- already-authorized write on another device.

drop policy if exists "owners and managers read permit status"
  on public.home_kitchen_permits;
create policy "owners and managers read permit status"
  on public.home_kitchen_permits
  for select to authenticated
  using (
    private.has_aal2()
    and private.is_business_member(
      business_id,
      auth.uid(),
      array['owner', 'manager']::public.member_role[]
    )
  );

alter function public.nominate_business_logo(uuid, uuid) set schema private;
alter function private.nominate_business_logo(uuid, uuid)
  rename to nominate_business_logo_core;

alter function public.schedule_mobile_stop(
  uuid,
  uuid,
  timestamptz,
  timestamptz,
  uuid
) set schema private;
alter function private.schedule_mobile_stop(
  uuid,
  uuid,
  timestamptz,
  timestamptz,
  uuid
) rename to schedule_mobile_stop_core;

alter function public.cancel_mobile_stop(uuid) set schema private;
alter function private.cancel_mobile_stop(uuid)
  rename to cancel_mobile_stop_core;

alter function public.submit_business_revision(uuid, jsonb) set schema private;
alter function private.submit_business_revision(uuid, jsonb)
  rename to submit_business_revision_core;

alter function public.submit_business_for_review(uuid) set schema private;
alter function private.submit_business_for_review(uuid)
  rename to submit_business_for_review_core;

revoke all on function private.nominate_business_logo_core(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.schedule_mobile_stop_core(
  uuid,
  uuid,
  timestamptz,
  timestamptz,
  uuid
) from public, anon, authenticated, service_role;
revoke all on function private.cancel_mobile_stop_core(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.submit_business_revision_core(uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.submit_business_for_review_core(uuid)
  from public, anon, authenticated, service_role;

-- The preceding team-authority migration introduced the same wrapper/core
-- boundary. Explicitly remove any environment-provided service-role grants so
-- every account-facing team write must still traverse its locked public RPC.
revoke all on function private.invite_business_member_core(
  uuid,
  text,
  public.member_role,
  text
) from service_role;
revoke all on function private.respond_business_invitation_core(uuid, text)
  from service_role;
revoke all on function private.set_business_member_role_core(
  uuid,
  uuid,
  public.member_role
) from service_role;
revoke all on function private.revoke_business_member_core(uuid, uuid)
  from service_role;
revoke all on function private.revoke_business_invitation_core(uuid, uuid)
  from service_role;
revoke all on function private.transfer_business_ownership_core(uuid, uuid, text)
  from service_role;

create or replace function public.nominate_business_logo(
  target_business_id uuid,
  target_asset_id uuid
)
returns table (
  asset_id uuid,
  quarantine_state text,
  moderation_state public.moderation_state
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
  from private.nominate_business_logo_core(
    target_business_id,
    target_asset_id
  );
end;
$$;

create or replace function public.schedule_mobile_stop(
  target_business_id uuid,
  target_location_id uuid,
  stop_starts_at timestamptz,
  stop_ends_at timestamptz,
  target_stop_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  saved_stop_id uuid;
begin
  perform private.require_aal2();
  perform 1
  from public.businesses business
  where business.id = target_business_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Business not found';
  end if;

  select private.schedule_mobile_stop_core(
    target_business_id,
    target_location_id,
    stop_starts_at,
    stop_ends_at,
    target_stop_id
  )
  into saved_stop_id;
  return saved_stop_id;
end;
$$;

create or replace function public.cancel_mobile_stop(target_stop_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_business_id uuid;
begin
  perform private.require_aal2();
  select stop.business_id
  into target_business_id
  from public.mobile_stops stop
  join public.businesses business on business.id = stop.business_id
  where stop.id = target_stop_id
    and stop.state in ('draft', 'scheduled', 'live')
    and business.state = 'published';

  if target_business_id is null then
    raise exception using errcode = '42501', message = 'Editable mobile stop owner or manager role required';
  end if;

  perform 1
  from public.businesses business
  where business.id = target_business_id
  for update;

  perform private.cancel_mobile_stop_core(target_stop_id);
end;
$$;

create or replace function public.submit_business_revision(
  target_business_id uuid,
  proposed_patch jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  revision_id uuid;
begin
  perform private.require_aal2();
  perform 1
  from public.businesses business
  where business.id = target_business_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Business not found';
  end if;

  select private.submit_business_revision_core(
    target_business_id,
    proposed_patch
  )
  into revision_id;
  return revision_id;
end;
$$;

create or replace function public.submit_business_for_review(
  target_business_id uuid
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

  perform private.submit_business_for_review_core(target_business_id);
end;
$$;

revoke all on function public.nominate_business_logo(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.nominate_business_logo(uuid, uuid)
  to authenticated;

revoke all on function public.schedule_mobile_stop(
  uuid,
  uuid,
  timestamptz,
  timestamptz,
  uuid
) from public, anon, authenticated;
grant execute on function public.schedule_mobile_stop(
  uuid,
  uuid,
  timestamptz,
  timestamptz,
  uuid
) to authenticated;

revoke all on function public.cancel_mobile_stop(uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_mobile_stop(uuid) to authenticated;

revoke all on function public.submit_business_revision(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.submit_business_revision(uuid, jsonb)
  to authenticated;

revoke all on function public.submit_business_for_review(uuid)
  from public, anon, authenticated;
grant execute on function public.submit_business_for_review(uuid)
  to authenticated;
