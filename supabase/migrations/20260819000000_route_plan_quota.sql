-- Authenticated, non-durable quota boundary for paid routing requests.
create or replace function public.consume_route_plan_quota()
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  if actor is null or not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  perform private.consume_rate_limit(actor, 'route_plan', 30, 900);
  return true;
end;
$$;

revoke all on function public.consume_route_plan_quota() from public, anon, authenticated;
grant execute on function public.consume_route_plan_quota() to authenticated;
