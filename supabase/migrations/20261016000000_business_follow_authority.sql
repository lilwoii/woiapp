-- Business saves affect public popularity, social feeds, and notification fanout.
-- Keep that mutation behind one account-bound, rate-limited authority boundary.

create or replace function public.set_business_follow(
  target_business_id uuid,
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
  eligible_business_id uuid;
  changed_count integer := 0;
  active_follow_count integer := 0;
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active account required';
  end if;
  if target_business_id is null or should_follow is null then
    raise exception using errcode = '22023', message = 'INVALID_BUSINESS_FOLLOW_REQUEST';
  end if;

  -- Serialize with the supported account-deletion transition before taking
  -- profile or business row locks.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(actor::text, 7741902)
  );
  perform 1
  from public.profiles profile
  where profile.user_id = actor
    and profile.status = 'active'
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'Active account required';
  end if;

  perform private.consume_rate_limit(actor, 'business_follow', 120, 3600);

  if should_follow then
    select business.id
    into eligible_business_id
    from public.businesses business
    where business.id = target_business_id
      and private.is_business_publicly_eligible(business.id)
    for key share;
    if eligible_business_id is null then
      raise exception using errcode = 'P0002', message = 'Business not found';
    end if;

    if not exists (
      select 1
      from public.follows follow
      where follow.user_id = actor
        and follow.business_id = eligible_business_id
    ) then
      select count(*)
      into active_follow_count
      from public.follows follow
      where follow.user_id = actor;
      if active_follow_count >= 2000 then
        raise exception using errcode = 'P0001', message = 'BUSINESS_FOLLOW_LIMIT_REACHED';
      end if;
    end if;

    insert into public.follows (user_id, business_id)
    values (actor, eligible_business_id)
    on conflict (user_id, business_id) do nothing;
    get diagnostics changed_count = row_count;
  else
    -- Removing a saved listing must remain possible after the listing becomes
    -- archived, provider-stale, or otherwise ineligible for public discovery.
    -- The parent lock serializes the follow delete and audit FK with a
    -- concurrent hard business deletion without reapplying eligibility.
    select business.id
    into eligible_business_id
    from public.businesses business
    where business.id = target_business_id
    for key share;
    if eligible_business_id is null then
      return false;
    end if;

    delete from public.follows follow
    where follow.user_id = actor
      and follow.business_id = eligible_business_id;
    get diagnostics changed_count = row_count;
  end if;

  if changed_count = 1 then
    perform private.write_audit_event(
      actor,
      eligible_business_id,
      case when should_follow then 'business.followed' else 'business.unfollowed' end,
      'business',
      eligible_business_id::text,
      pg_catalog.jsonb_build_object('following', should_follow)
    );
  end if;

  return should_follow;
end;
$$;

revoke all on function public.set_business_follow(uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.set_business_follow(uuid, boolean)
  to authenticated;

revoke insert, update, delete on table public.follows
  from public, anon, authenticated, service_role;

drop policy if exists "active users follow eligible businesses" on public.follows;
drop policy if exists "users delete own follows" on public.follows;

do $$
begin
  if pg_catalog.has_table_privilege('authenticated', 'public.follows', 'INSERT')
    or pg_catalog.has_table_privilege('authenticated', 'public.follows', 'UPDATE')
    or pg_catalog.has_table_privilege('authenticated', 'public.follows', 'DELETE')
    or not pg_catalog.has_table_privilege('authenticated', 'public.follows', 'SELECT')
    or not pg_catalog.has_function_privilege(
      'authenticated', 'public.set_business_follow(uuid,boolean)', 'EXECUTE'
    )
    or pg_catalog.has_function_privilege(
      'anon', 'public.set_business_follow(uuid,boolean)', 'EXECUTE'
    )
    or pg_catalog.has_function_privilege(
      'service_role', 'public.set_business_follow(uuid,boolean)', 'EXECUTE'
    )
  then
    raise exception 'Business follow authority ACL is incomplete';
  end if;
end;
$$;
