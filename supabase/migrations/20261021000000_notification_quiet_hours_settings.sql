-- Quiet-hours settings are account preferences shared by the user's followed
-- businesses. Push registration, enqueueing, and delivery remain disabled.
-- This RPC updates only the schedule columns so existing per-business alert
-- choices are never flattened as a side effect of changing quiet hours.

create or replace function public.update_follow_notification_quiet_hours(
  target_business_ids uuid[],
  target_timezone text,
  target_quiet_hours_start time,
  target_quiet_hours_end time,
  idempotency_key text
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  normalized_ids uuid[];
  key_hash text;
  request_hash text;
  stored_hash text;
  stored_count integer;
  affected integer;
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active account required';
  end if;
  if idempotency_key is null
    or idempotency_key !~ '^spottr:notification-quiet-hours:[A-Za-z0-9._:-]{12,180}$'
    or not (
      (
        target_timezone is null
        and target_quiet_hours_start is null
        and target_quiet_hours_end is null
      )
      or (
        target_timezone is not null
        and target_quiet_hours_start is not null
        and target_quiet_hours_end is not null
        and target_quiet_hours_start <> target_quiet_hours_end
      )
    )
  then
    raise exception using errcode = '22023', message = 'Invalid notification quiet hours';
  end if;
  if target_timezone is not null and not exists (
    select 1
    from pg_catalog.pg_timezone_names zone
    where zone.name = target_timezone
  ) then
    raise exception using errcode = '22023', message = 'Invalid notification timezone';
  end if;

  select coalesce(array_agg(distinct item.id order by item.id), '{}'::uuid[])
  into normalized_ids
  from unnest(coalesce(target_business_ids, '{}'::uuid[])) item(id)
  where item.id is not null;
  if cardinality(normalized_ids) < 1 or cardinality(normalized_ids) > 200 then
    raise exception using errcode = '22023', message = 'Choose between 1 and 200 followed businesses';
  end if;
  if exists (
    select 1
    from unnest(normalized_ids) item(business_id)
    where not exists (
      select 1
      from public.follows followed
      where followed.user_id = actor
        and followed.business_id = item.business_id
    )
      or not private.is_business_publicly_eligible(item.business_id)
  ) then
    raise exception using
      errcode = '42501',
      message = 'Notification preferences require an eligible followed business';
  end if;

  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'business_ids', normalized_ids,
    'timezone', target_timezone,
    'quiet_hours_start', target_quiet_hours_start,
    'quiet_hours_end', target_quiet_hours_end
  ));
  perform private.lock_idempotency_request(actor, 'notification_preference', key_hash);
  select receipt.request_hash, receipt.affected_count
  into stored_hash, stored_count
  from private.notification_preference_receipts receipt
  where receipt.user_id = actor
    and receipt.idempotency_key_hash = key_hash;
  if found then
    if stored_hash <> request_hash then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return stored_count;
  end if;

  perform private.consume_rate_limit(actor, 'notification_preference_hour', 60, 3600);
  insert into public.notification_preferences (
    user_id,
    business_id,
    live_nearby,
    location_change,
    owner_update,
    menu_return,
    quiet_hours_start,
    quiet_hours_end,
    timezone,
    updated_at
  )
  select
    actor,
    item.business_id,
    false,
    false,
    false,
    false,
    target_quiet_hours_start,
    target_quiet_hours_end,
    target_timezone,
    now()
  from unnest(normalized_ids) item(business_id)
  on conflict (user_id, business_id) do update set
    quiet_hours_start = excluded.quiet_hours_start,
    quiet_hours_end = excluded.quiet_hours_end,
    timezone = excluded.timezone,
    updated_at = now();
  get diagnostics affected = row_count;

  insert into private.notification_preference_receipts (
    user_id,
    idempotency_key_hash,
    request_hash,
    affected_count
  ) values (actor, key_hash, request_hash, affected);
  return affected;
end;
$$;

revoke all on function public.update_follow_notification_quiet_hours(
  uuid[], text, time, time, text
) from public, anon, authenticated, service_role;
grant execute on function public.update_follow_notification_quiet_hours(
  uuid[], text, time, time, text
) to authenticated;
