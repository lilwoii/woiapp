-- Staff must review the exact public pins and initial mobile stops submitted by
-- a food truck or pop-up. The legacy publication RPC remains available for
-- simple single-location listings, but cannot bypass this selection workflow.

create or replace function public.get_pending_business_submission(
  target_business_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  result jsonb;
begin
  perform private.require_aal2();
  if not private.is_platform_staff(
    actor,
    array['admin']::public.platform_role[]
  ) then
    raise exception using errcode = '42501', message = 'Platform administrator role required';
  end if;

  select jsonb_build_object(
    'business_id', business.id,
    'business_name', business.name,
    'kind', business.kind::text,
    'state', business.state::text,
    'verification', business.verification::text,
    'locations', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', location.id,
          'label', location.label,
          'address_line', location.address_line,
          'city', location.city,
          'region', location.region,
          'postal_code', location.postal_code,
          'latitude', public.st_y(location.point::public.geometry),
          'longitude', public.st_x(location.point::public.geometry),
          'is_primary', location.is_primary,
          'is_approximate', location.is_approximate,
          'public_address', location.public_address,
          'publication_state', location.publication_state::text
        ) order by location.is_primary desc, location.created_at, location.id
      )
      from public.business_locations location
      where location.business_id = business.id
        and location.publication_state <> 'archived'
    ), '[]'::jsonb),
    'draft_stops', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', stop.id,
          'location_id', stop.location_id,
          'starts_at', stop.starts_at,
          'ends_at', stop.ends_at,
          'state', stop.state
        ) order by stop.starts_at, stop.id
      )
      from public.mobile_stops stop
      where stop.business_id = business.id
        and stop.state = 'draft'
    ), '[]'::jsonb)
  ) into result
  from public.businesses business
  where business.id = target_business_id
    and business.state = 'pending';

  if result is null then
    raise exception using errcode = '22023', message = 'Pending business submission not found';
  end if;
  return result;
end;
$$;

revoke all on function public.get_pending_business_submission(uuid) from public;
grant execute on function public.get_pending_business_submission(uuid) to authenticated;

create or replace function public.review_business_submission(
  target_business_id uuid,
  approved_location_ids uuid[],
  approved_stop_ids uuid[],
  moderation_reason text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_kind public.business_kind;
  target_state public.business_state;
  primary_location_id uuid;
  selected_location_count integer;
  selected_stop_count integer;
  normalized_reason text := btrim(coalesce(moderation_reason, ''));
begin
  perform private.require_aal2();
  if not private.is_platform_staff(
    actor,
    array['admin']::public.platform_role[]
  ) then
    raise exception using errcode = '42501', message = 'Platform administrator role required';
  end if;
  if char_length(normalized_reason) not between 3 and 1000
    or not private.content_is_professional(normalized_reason)
  then
    raise exception using errcode = '22023', message = 'A professional moderation reason is required';
  end if;
  if approved_location_ids is null
    or cardinality(approved_location_ids) < 1
    or cardinality(approved_location_ids) > 100
    or exists (select 1 from unnest(approved_location_ids) item(id) where item.id is null)
    or (select count(distinct item.id) from unnest(approved_location_ids) item(id))
      <> cardinality(approved_location_ids)
    or approved_stop_ids is null
    or cardinality(approved_stop_ids) > 100
    or exists (select 1 from unnest(approved_stop_ids) item(id) where item.id is null)
    or (select count(distinct item.id) from unnest(approved_stop_ids) item(id))
      <> cardinality(approved_stop_ids)
  then
    raise exception using errcode = '22023', message = 'Invalid business submission selection';
  end if;

  select business.kind, business.state
  into target_kind, target_state
  from public.businesses business
  where business.id = target_business_id
  for update;

  if target_state is null then
    raise exception using errcode = '22023', message = 'Business not found';
  end if;
  if target_state <> 'pending' or target_kind not in ('food_truck', 'pop_up') then
    raise exception using errcode = '22023', message = 'Pending mobile business submission required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('mobile_stop:' || target_business_id::text, 0)
  );

  perform 1
  from public.business_locations location
  where location.business_id = target_business_id
  order by location.id
  for update;

  select location.id into primary_location_id
  from public.business_locations location
  where location.business_id = target_business_id
    and location.is_primary
    and location.publication_state <> 'archived';
  if primary_location_id is null
    or not (primary_location_id = any(approved_location_ids))
  then
    raise exception using errcode = '22023', message = 'Primary location approval is required';
  end if;

  select count(*)::integer into selected_location_count
  from public.business_locations location
  where location.business_id = target_business_id
    and location.id = any(approved_location_ids)
    and location.publication_state <> 'archived';
  if selected_location_count <> cardinality(approved_location_ids) then
    raise exception using errcode = '22023', message = 'Approved location selection is invalid';
  end if;

  perform 1
  from public.mobile_stops stop
  where stop.business_id = target_business_id
  order by stop.id
  for update;

  select count(*)::integer into selected_stop_count
  from public.mobile_stops stop
  where stop.business_id = target_business_id
    and stop.id = any(approved_stop_ids);
  if selected_stop_count <> cardinality(approved_stop_ids)
    or exists (
      select 1
      from public.mobile_stops stop
      where stop.id = any(approved_stop_ids)
        and (
          stop.business_id <> target_business_id
          or stop.state <> 'draft'
          or not (stop.location_id = any(approved_location_ids))
          or stop.starts_at < now() - interval '15 minutes'
          or stop.ends_at <= now()
          or stop.starts_at > now() + interval '90 days'
        )
    )
  then
    raise exception using errcode = '22023', message = 'Approved mobile stop selection is invalid';
  end if;

  if exists (
    select 1
    from public.mobile_stops candidate
    join public.mobile_stops other
      on other.business_id = candidate.business_id
     and other.id <> candidate.id
     and tstzrange(other.starts_at, other.ends_at, '[)')
       && tstzrange(candidate.starts_at, candidate.ends_at, '[)')
    where candidate.business_id = target_business_id
      and candidate.id = any(approved_stop_ids)
      and (
        other.state in ('scheduled', 'live')
        or other.id = any(approved_stop_ids)
      )
  ) then
    raise exception using errcode = '23P01', message = 'MOBILE_STOP_TIME_OVERLAP';
  end if;

  update public.business_locations location
  set publication_state = case
    when location.id = any(approved_location_ids) then 'published'::public.location_publication_state
    else 'private'::public.location_publication_state
  end
  where location.business_id = target_business_id
    and location.publication_state <> 'archived';

  update public.businesses business
  set state = 'published',
      verification = 'verified'
  where business.id = target_business_id
    and business.state = 'pending';
  if not found then
    raise exception using errcode = '40001', message = 'BUSINESS_SUBMISSION_CHANGED';
  end if;

  update public.mobile_stops stop
  set state = case
        when stop.starts_at <= now() and stop.ends_at > now() then 'live'
        else 'scheduled'
      end,
      confirmed_at = now()
  where stop.business_id = target_business_id
    and stop.id = any(approved_stop_ids)
    and stop.state = 'draft';
  get diagnostics selected_stop_count = row_count;
  if selected_stop_count <> cardinality(approved_stop_ids) then
    raise exception using errcode = '40001', message = 'BUSINESS_SUBMISSION_CHANGED';
  end if;

  perform private.write_audit_event(
    actor,
    target_business_id,
    'business.submission_approved',
    'business',
    target_business_id::text,
    jsonb_build_object(
      'approved_location_ids', approved_location_ids,
      'approved_stop_ids', approved_stop_ids,
      'reason', normalized_reason
    )
  );
end;
$$;

revoke all on function public.review_business_submission(uuid, uuid[], uuid[], text)
  from public;
grant execute on function public.review_business_submission(uuid, uuid[], uuid[], text)
  to authenticated;

create or replace function public.set_business_location_publication(
  target_location_id uuid,
  next_state public.location_publication_state
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_business_id uuid;
  target_kind public.business_kind;
  target_business_state public.business_state;
  target_is_primary boolean;
begin
  perform private.require_aal2();
  select location.business_id
  into target_business_id
  from public.business_locations location
  where location.id = target_location_id;

  if target_business_id is null then
    raise exception using errcode = '42501', message = 'Business owner or manager role required';
  end if;

  select business.kind, business.state
  into target_kind, target_business_state
  from public.businesses business
  where business.id = target_business_id
  for update;

  select location.is_primary
  into target_is_primary
  from public.business_locations location
  where location.id = target_location_id
    and location.business_id = target_business_id
  for update;

  if target_kind is null
    or target_is_primary is null
    or not private.is_business_member(
      target_business_id,
      actor,
      array['owner', 'manager']::public.member_role[]
    )
  then
    raise exception using errcode = '42501', message = 'Business owner or manager role required';
  end if;
  if target_business_state <> 'draft' then
    raise exception using errcode = '42501', message = 'PUBLISHED_LISTING_REQUIRES_STAGED_REVISION';
  end if;
  if next_state = 'published'
    and target_kind in ('food_truck', 'pop_up')
    and not target_is_primary
  then
    raise exception using errcode = '55000', message = 'MOBILE_SUBMISSION_SELECTION_REQUIRED';
  end if;

  if next_state = 'published' and target_kind = 'home_kitchen' then
    if not exists (
      select 1
      from public.businesses business
      join public.jurisdictions jurisdiction on jurisdiction.id = business.jurisdiction_id
      join public.home_kitchen_permits permit
        on permit.business_id = business.id
       and permit.jurisdiction_id = jurisdiction.id
      where business.id = target_business_id
        and business.verification = 'verified'
        and jurisdiction.home_kitchens_enabled
        and jurisdiction.legal_reviewed_at is not null
        and permit.verification = 'verified'
        and permit.expires_on >= current_date
    ) then
      raise exception using errcode = '22023', message = 'HOME_KITCHEN_NOT_ELIGIBLE';
    end if;
  end if;

  perform private.consume_rate_limit(actor, 'location_publication', 30, 3600);

  update public.business_locations location
  set publication_state = next_state,
      public_address = case when target_kind = 'home_kitchen' then false else location.public_address end,
      is_approximate = case
        when target_kind = 'home_kitchen' or not location.public_address then true
        else location.is_approximate
      end
  where location.id = target_location_id;

  perform private.write_audit_event(
    actor,
    target_business_id,
    'business.location_publication_changed',
    'business_location',
    target_location_id::text,
    jsonb_build_object('publication_state', next_state::text)
  );
end;
$$;

revoke all on function public.set_business_location_publication(uuid, public.location_publication_state) from public;
grant execute on function public.set_business_location_publication(uuid, public.location_publication_state) to authenticated;

create or replace function public.set_business_publication(
  target_business_id uuid,
  next_state public.business_state,
  next_verification public.verification_state,
  moderation_reason text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  old_state public.business_state;
  old_verification public.verification_state;
  target_kind public.business_kind;
  normalized_reason text := btrim(coalesce(moderation_reason, ''));
begin
  perform private.require_aal2();
  if not private.is_platform_staff(
    actor,
    array['admin']::public.platform_role[]
  ) then
    raise exception using errcode = '42501', message = 'Platform administrator role required';
  end if;
  if char_length(normalized_reason) not between 3 and 1000 then
    raise exception using errcode = '22023', message = 'A moderation reason is required';
  end if;

  select business.state, business.verification, business.kind
  into old_state, old_verification, target_kind
  from public.businesses business
  where business.id = target_business_id
  for update;

  if old_state is null then
    raise exception using errcode = '22023', message = 'Business not found';
  end if;
  if next_state = 'published'
    and old_state = 'pending'
    and target_kind in ('food_truck', 'pop_up')
    and (
      (
        select count(*)
        from public.business_locations location
        where location.business_id = target_business_id
          and location.publication_state <> 'archived'
      ) > 1
      or exists (
        select 1
        from public.mobile_stops stop
        where stop.business_id = target_business_id
          and stop.state = 'draft'
      )
    )
  then
    raise exception using errcode = '55000', message = 'MOBILE_SUBMISSION_SELECTION_REQUIRED';
  end if;

  if next_state = 'published' then
    update public.business_locations location
    set publication_state = 'published'
    where location.business_id = target_business_id
      and location.is_primary
      and location.publication_state = 'private';
  end if;

  update public.businesses business
  set state = next_state,
      verification = next_verification
  where business.id = target_business_id;

  perform private.write_audit_event(
    actor,
    target_business_id,
    'business.publication_changed',
    'business',
    target_business_id::text,
    jsonb_build_object(
      'old_state', old_state::text,
      'new_state', next_state::text,
      'old_verification', old_verification::text,
      'new_verification', next_verification::text,
      'reason', normalized_reason
    )
  );
end;
$$;

revoke all on function public.set_business_publication(
  uuid,
  public.business_state,
  public.verification_state,
  text
) from public;
grant execute on function public.set_business_publication(
  uuid,
  public.business_state,
  public.verification_state,
  text
) to authenticated;
