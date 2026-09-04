-- Boolean mutation intent must be explicit. PostgreSQL routes NULL through an
-- `if value then ... else ...` branch as false, which previously turned a
-- malformed request into an unfollow or unblock operation.
alter function public.set_user_block(uuid, boolean)
  rename to set_user_block_explicit_intent_core;
alter function public.set_user_block_explicit_intent_core(uuid, boolean)
  set schema private;

revoke all on function private.set_user_block_explicit_intent_core(uuid, boolean)
  from public, anon, authenticated, service_role;

create or replace function public.set_user_block_by_public_id(
  target_public_profile_id uuid,
  should_block boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_internal_user_id uuid;
begin
  if not private.is_active_user(actor) then
    raise exception using
      errcode = '42501',
      message = 'Active verified account required';
  end if;
  if should_block is null then
    raise exception using
      errcode = '22023',
      message = 'Invalid block intent';
  end if;

  select profile.user_id
  into target_internal_user_id
  from public.profiles profile
  where profile.public_id = target_public_profile_id
    and profile.status = 'active';

  if target_internal_user_id is null then
    raise exception using
      errcode = '22023',
      message = 'Invalid block target';
  end if;

  perform private.set_user_block_explicit_intent_core(
    target_internal_user_id,
    should_block
  );
end;
$$;

revoke all on function public.set_user_block_by_public_id(uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.set_user_block_by_public_id(uuid, boolean)
  to authenticated;

alter function public.set_profile_follow_by_public_id(uuid, boolean)
  rename to set_profile_follow_explicit_intent_core;
alter function public.set_profile_follow_explicit_intent_core(uuid, boolean)
  set schema private;

revoke all on function private.set_profile_follow_explicit_intent_core(uuid, boolean)
  from public, anon, authenticated, service_role;

create function public.set_profile_follow_by_public_id(
  target_public_id uuid,
  should_follow boolean
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if not private.is_active_user(actor) then
    raise exception using
      errcode = '42501',
      message = 'Active account required';
  end if;
  if should_follow is null then
    raise exception using
      errcode = '22023',
      message = 'Invalid follow intent';
  end if;

  return private.set_profile_follow_explicit_intent_core(
    target_public_id,
    should_follow
  );
end;
$$;

revoke all on function public.set_profile_follow_by_public_id(uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.set_profile_follow_by_public_id(uuid, boolean)
  to authenticated;
