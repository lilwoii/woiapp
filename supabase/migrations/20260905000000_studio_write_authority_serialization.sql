-- Keep every privileged Studio write on the authority snapshot established
-- after locking its business. Team changes use the same business-row lock, so
-- ownership transfer or member revocation cannot race an authorized write.

alter function public.submit_business_update(
  uuid,
  public.update_kind,
  text,
  integer,
  text
) set schema private;
alter function private.submit_business_update(
  uuid,
  public.update_kind,
  text,
  integer,
  text
) rename to submit_business_update_core;

alter function public.submit_business_response(uuid, text, text)
  set schema private;
alter function private.submit_business_response(uuid, text, text)
  rename to submit_business_response_core;

alter function public.set_business_live_status(
  uuid,
  public.live_business_status
) set schema private;
alter function private.set_business_live_status(
  uuid,
  public.live_business_status
) rename to set_business_live_status_core;

alter function public.set_menu_item_availability(uuid, text)
  set schema private;
alter function private.set_menu_item_availability(uuid, text)
  rename to set_menu_item_availability_core;

revoke all on function private.submit_business_update_core(
  uuid,
  public.update_kind,
  text,
  integer,
  text
) from public, anon, authenticated, service_role;
revoke all on function private.submit_business_response_core(uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.set_business_live_status_core(
  uuid,
  public.live_business_status
) from public, anon, authenticated, service_role;
revoke all on function private.set_menu_item_availability_core(uuid, text)
  from public, anon, authenticated, service_role;

create or replace function public.submit_business_update(
  target_business_id uuid,
  update_kind public.update_kind,
  update_body text,
  active_for_minutes integer,
  idempotency_key text
)
returns table (
  update_id uuid,
  business_id uuid,
  kind public.update_kind,
  body text,
  moderation_state public.moderation_state,
  starts_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz
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
  from private.submit_business_update_core(
    target_business_id,
    update_kind,
    update_body,
    active_for_minutes,
    idempotency_key
  );
end;
$$;

create or replace function public.submit_business_response(
  target_review_id uuid,
  response_body text,
  idempotency_key text
)
returns table (
  review_id uuid,
  business_id uuid,
  body text,
  moderation_state public.moderation_state,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_business_id uuid;
begin
  perform private.require_aal2();
  select review.business_id
  into target_business_id
  from public.reviews review
  where review.id = target_review_id
    and review.moderation = 'approved'
    and review.deleted_at is null;

  if target_business_id is null then
    raise exception using errcode = '42501', message = 'Eligible owner or manager role required';
  end if;

  perform 1
  from public.businesses business
  where business.id = target_business_id
  for update;

  perform 1
  from public.reviews review
  where review.id = target_review_id
    and review.business_id = target_business_id
    and review.moderation = 'approved'
    and review.deleted_at is null
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'Eligible owner or manager role required';
  end if;

  return query
  select *
  from private.submit_business_response_core(
    target_review_id,
    response_body,
    idempotency_key
  );
end;
$$;

create or replace function public.set_business_live_status(
  target_business_id uuid,
  next_status public.live_business_status
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

  perform private.set_business_live_status_core(
    target_business_id,
    next_status
  );
end;
$$;

create or replace function public.set_menu_item_availability(
  target_menu_item_id uuid,
  next_availability text
)
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
  select section.business_id
  into target_business_id
  from public.menu_items item
  join public.menu_sections section on section.id = item.section_id
  join public.businesses business on business.id = section.business_id
  where item.id = target_menu_item_id
    and item.is_published
    and section.is_published
    and business.state = 'published';

  if target_business_id is null then
    raise exception using errcode = '42501', message = 'Published menu owner or manager role required';
  end if;

  perform 1
  from public.businesses business
  where business.id = target_business_id
  for update;

  perform 1
  from public.menu_items item
  join public.menu_sections section on section.id = item.section_id
  join public.businesses business on business.id = section.business_id
  where item.id = target_menu_item_id
    and section.business_id = target_business_id
    and item.is_published
    and section.is_published
    and business.state = 'published'
  for update of item;
  if not found then
    raise exception using errcode = '42501', message = 'Published menu owner or manager role required';
  end if;

  perform private.set_menu_item_availability_core(
    target_menu_item_id,
    next_availability
  );
end;
$$;

revoke all on function public.submit_business_update(
  uuid,
  public.update_kind,
  text,
  integer,
  text
) from public, anon, authenticated;
grant execute on function public.submit_business_update(
  uuid,
  public.update_kind,
  text,
  integer,
  text
) to authenticated;

revoke all on function public.submit_business_response(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.submit_business_response(uuid, text, text)
  to authenticated;

revoke all on function public.set_business_live_status(
  uuid,
  public.live_business_status
) from public, anon, authenticated;
grant execute on function public.set_business_live_status(
  uuid,
  public.live_business_status
) to authenticated;

revoke all on function public.set_menu_item_availability(uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_menu_item_availability(uuid, text)
  to authenticated;
