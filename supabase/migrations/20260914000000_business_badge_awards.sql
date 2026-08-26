-- Server-owned business and seller achievements. Every award is derived from
-- first-party evidence and can be revoked when the evidence changes.

create or replace function private.refresh_business_badges(target_business_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  business_kind public.business_kind;
  verified boolean := false;
  eligible boolean := false;
  published_menu_items integer := 0;
  review_count integer := 0;
  average_rating numeric := 0;
  completed_stops integer := 0;
  cancelled_stops integer := 0;
  evidence jsonb;
begin
  if target_business_id is null then return; end if;
  select business.kind,
    business.verification = 'verified',
    private.is_business_publicly_eligible(business.id)
  into business_kind, verified, eligible
  from public.businesses business where business.id = target_business_id;

  if business_kind is null then return; end if;
  eligible := eligible and verified;

  select count(*)::integer into published_menu_items
  from public.menu_items item
  join public.menu_sections section on section.id = item.section_id
  where section.business_id = target_business_id and section.is_published and item.is_published
    and item.availability <> 'hidden' and item.updated_at >= now() - interval '60 days';

  select count(*)::integer, coalesce(avg(review.rating), 0)
  into review_count, average_rating
  from public.reviews review
  join public.profiles author on author.user_id = review.author_id and author.status = 'active'
  where review.business_id = target_business_id and review.moderation = 'approved'
    and review.deleted_at is null and review.created_at >= now() - interval '18 months';

  select count(*) filter (where stop.state = 'completed')::integer,
    count(*) filter (where stop.state = 'cancelled')::integer
  into completed_stops, cancelled_stops
  from public.mobile_stops stop
  where stop.business_id = target_business_id and stop.starts_at >= now() - interval '180 days';

  evidence := jsonb_build_object(
    'eligible', eligible, 'verified', verified, 'business_kind', business_kind,
    'published_recent_menu_items', published_menu_items, 'eligible_review_count', review_count,
    'average_rating', round(average_rating, 2), 'completed_stops', completed_stops,
    'cancelled_stops', cancelled_stops, 'evaluated_at', now()
  );

  insert into public.business_badge_awards
    (business_id, badge_code, earned_at, expires_at, evidence_snapshot)
  select target_business_id, candidate.code, now(),
    case when candidate.time_limited then now() + interval '35 days' else null end, evidence
  from (values
    ('verified_business', eligible, false),
    ('fresh_menu', eligible and published_menu_items >= 3, true),
    ('community_favorite', eligible and review_count >= 25 and average_rating >= 4.5, true),
    ('route_reliable', eligible and business_kind = 'food_truck' and completed_stops >= 20
      and cancelled_stops <= greatest(2, floor((completed_stops + cancelled_stops) * 0.1)), true),
    ('verified_seller', eligible and business_kind in ('home_kitchen', 'pop_up'), false)
  ) as candidate(code, qualifies, time_limited)
  where candidate.qualifies
  on conflict (business_id, badge_code) do update set
    earned_at = case when public.business_badge_awards.revoked_at is null
      then public.business_badge_awards.earned_at else now() end,
    expires_at = excluded.expires_at, revoked_at = null, revocation_reason = null,
    evidence_snapshot = excluded.evidence_snapshot;

  update public.business_badge_awards award
  set revoked_at = now(), revocation_reason = 'Current eligibility threshold is no longer met.',
    evidence_snapshot = evidence
  where award.business_id = target_business_id and award.revoked_at is null
    and award.badge_code = any(array[
      'verified_business', 'fresh_menu', 'community_favorite', 'route_reliable', 'verified_seller'
    ]::text[])
    and not case award.badge_code
      when 'verified_business' then eligible
      when 'fresh_menu' then eligible and published_menu_items >= 3
      when 'community_favorite' then eligible and review_count >= 25 and average_rating >= 4.5
      when 'route_reliable' then eligible and business_kind = 'food_truck' and completed_stops >= 20
        and cancelled_stops <= greatest(2, floor((completed_stops + cancelled_stops) * 0.1))
      when 'verified_seller' then eligible and business_kind in ('home_kitchen', 'pop_up')
      else false
    end;
end;
$$;

create or replace function private.refresh_changed_business_badges()
returns trigger language plpgsql security definer set search_path = '' as $$
begin perform private.refresh_business_badges(new.id); return new; end;
$$;

create or replace function private.refresh_menu_business_badges()
returns trigger language plpgsql security definer set search_path = '' as $$
declare target_section_id uuid := coalesce(new.section_id, old.section_id); target_business_id uuid;
begin
  select section.business_id into target_business_id from public.menu_sections section where section.id = target_section_id;
  perform private.refresh_business_badges(target_business_id); return coalesce(new, old);
end;
$$;

create or replace function private.refresh_menu_section_business_badges()
returns trigger language plpgsql security definer set search_path = '' as $$
begin perform private.refresh_business_badges(coalesce(new.business_id, old.business_id)); return coalesce(new, old); end;
$$;

create or replace function private.refresh_review_business_badges()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op <> 'INSERT' then perform private.refresh_business_badges(old.business_id); end if;
  if tg_op <> 'DELETE' then perform private.refresh_business_badges(new.business_id); end if;
  return coalesce(new, old);
end;
$$;

create or replace function private.refresh_stop_business_badges()
returns trigger language plpgsql security definer set search_path = '' as $$
begin perform private.refresh_business_badges(coalesce(new.business_id, old.business_id)); return coalesce(new, old); end;
$$;

drop trigger if exists businesses_refresh_business_badges on public.businesses;
create trigger businesses_refresh_business_badges
after update of state, verification, provenance, jurisdiction_id on public.businesses
for each row execute function private.refresh_changed_business_badges();
drop trigger if exists menu_items_refresh_business_badges on public.menu_items;
create trigger menu_items_refresh_business_badges
after insert or update of is_published, availability, price_minor, updated_at or delete on public.menu_items
for each row execute function private.refresh_menu_business_badges();
drop trigger if exists menu_sections_refresh_business_badges on public.menu_sections;
create trigger menu_sections_refresh_business_badges
after insert or update of is_published or delete on public.menu_sections
for each row execute function private.refresh_menu_section_business_badges();
drop trigger if exists reviews_refresh_business_badges on public.reviews;
create trigger reviews_refresh_business_badges
after insert or update of moderation, deleted_at, rating or delete on public.reviews
for each row execute function private.refresh_review_business_badges();
drop trigger if exists mobile_stops_refresh_business_badges on public.mobile_stops;
create trigger mobile_stops_refresh_business_badges
after insert or update of state, starts_at or delete on public.mobile_stops
for each row execute function private.refresh_stop_business_badges();

create or replace function public.refresh_business_badges_batch(
  result_limit integer default 100, after_business_id uuid default null
)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare actor_role text := auth.role(); subject record; refreshed integer := 0;
begin
  if actor_role <> 'service_role' then
    raise exception using errcode = '42501', message = 'Service role required';
  end if;
  for subject in
    select business.id from public.businesses business
    where business.verification = 'verified' and (after_business_id is null or business.id > after_business_id)
    order by business.id limit least(greatest(coalesce(result_limit, 100), 1), 500)
  loop perform private.refresh_business_badges(subject.id); refreshed := refreshed + 1; end loop;
  return refreshed;
end;
$$;

do $$ declare subject record; begin
  for subject in select business.id from public.businesses business where business.verification = 'verified'
  loop perform private.refresh_business_badges(subject.id); end loop;
end $$;

revoke all on function private.refresh_business_badges(uuid) from public, anon, authenticated, service_role;
revoke all on function private.refresh_changed_business_badges() from public, anon, authenticated, service_role;
revoke all on function private.refresh_menu_business_badges() from public, anon, authenticated, service_role;
revoke all on function private.refresh_menu_section_business_badges() from public, anon, authenticated, service_role;
revoke all on function private.refresh_review_business_badges() from public, anon, authenticated, service_role;
revoke all on function private.refresh_stop_business_badges() from public, anon, authenticated, service_role;
revoke all on function public.refresh_business_badges_batch(integer, uuid) from public, anon, authenticated;
grant execute on function public.refresh_business_badges_batch(integer, uuid) to service_role;
