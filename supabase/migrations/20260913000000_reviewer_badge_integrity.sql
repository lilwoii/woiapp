-- Reviewer badge integrity: current evidence, reversible awards, and privacy-safe
-- public projections. Sponsored placement remains excluded from every score.

create or replace function private.refresh_profile_review_badges(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  profile_active boolean := false;
  approved_reviews integer := 0;
  eligible_photo_reviews integer := 0;
  eligible_helpful_votes bigint := 0;
  food_truck_reviews integer := 0;
  active_months integer := 0;
  evidence jsonb;
begin
  if target_user_id is null then return; end if;
  select exists (
    select 1 from public.profiles profile
    where profile.user_id = target_user_id and profile.status = 'active'
  ) into profile_active;

  if profile_active then
    select count(*)::integer,
      count(*) filter (where business.kind = 'food_truck')::integer,
      count(distinct date_trunc('month', review.created_at))::integer
    into approved_reviews, food_truck_reviews, active_months
    from public.reviews review
    join public.businesses business on business.id = review.business_id
    where review.author_id = target_user_id
      and review.moderation = 'approved' and review.deleted_at is null
      and private.is_business_publicly_eligible(review.business_id);

    select count(distinct review.id)::integer into eligible_photo_reviews
    from public.reviews review
    join public.review_media link on link.review_id = review.id
    join public.media_assets asset on asset.id = link.asset_id
    where review.author_id = target_user_id
      and review.moderation = 'approved' and review.deleted_at is null
      and private.is_business_publicly_eligible(review.business_id)
      and asset.moderation = 'approved' and asset.quarantine_state = 'clean'
      and asset.processed_storage_path is not null;

    select count(*)::bigint into eligible_helpful_votes
    from public.reviews review
    join public.review_reactions reaction on reaction.review_id = review.id and reaction.reaction = 1
    join public.profiles reactor on reactor.user_id = reaction.user_id and reactor.status = 'active'
    where review.author_id = target_user_id
      and review.moderation = 'approved' and review.deleted_at is null
      and private.is_business_publicly_eligible(review.business_id)
      and not private.users_are_blocked(target_user_id, reaction.user_id);
  end if;

  evidence := jsonb_build_object(
    'approved_reviews', approved_reviews,
    'eligible_photo_reviews', eligible_photo_reviews,
    'eligible_helpful_votes', eligible_helpful_votes,
    'food_truck_reviews', food_truck_reviews,
    'active_months', active_months,
    'account_active', profile_active,
    'evaluated_at', now()
  );

  insert into public.profile_badge_awards (subject_id, badge_code, evidence_snapshot)
  select target_user_id, candidate.code, evidence
  from (values
    ('first_bite', profile_active and approved_reviews >= 1),
    ('regular_5', profile_active and approved_reviews >= 5),
    ('local_voice_10', profile_active and approved_reviews >= 10),
    ('city_guide_25', profile_active and approved_reviews >= 25),
    ('neighborhood_authority_50', profile_active and approved_reviews >= 50),
    ('spottr_standard_100', profile_active and approved_reviews >= 100),
    ('photo_scout_5', profile_active and eligible_photo_reviews >= 5),
    ('photo_scout_20', profile_active and eligible_photo_reviews >= 20),
    ('photo_scout_50', profile_active and eligible_photo_reviews >= 50),
    ('helpful_voice_10', profile_active and eligible_helpful_votes >= 10),
    ('helpful_voice_50', profile_active and eligible_helpful_votes >= 50),
    ('helpful_voice_200', profile_active and eligible_helpful_votes >= 200),
    ('truck_tracker_5', profile_active and food_truck_reviews >= 5),
    ('truck_tracker_20', profile_active and food_truck_reviews >= 20),
    ('consistent_voice_6', profile_active and active_months >= 6)
  ) as candidate(code, qualifies)
  where candidate.qualifies
  on conflict (subject_id, badge_code) do update set
    earned_at = case when public.profile_badge_awards.revoked_at is null
      then public.profile_badge_awards.earned_at else now() end,
    revoked_at = null,
    revocation_reason = null,
    evidence_snapshot = excluded.evidence_snapshot;

  update public.profile_badge_awards award
  set revoked_at = now(),
      revocation_reason = case when profile_active then 'Current eligibility threshold is no longer met.'
        else 'Account is not active.' end,
      evidence_snapshot = evidence
  where award.subject_id = target_user_id
    and award.revoked_at is null
    and award.badge_code = any(array[
      'first_bite', 'regular_5', 'local_voice_10', 'city_guide_25',
      'neighborhood_authority_50', 'spottr_standard_100', 'photo_scout_5',
      'photo_scout_20', 'photo_scout_50', 'helpful_voice_10',
      'helpful_voice_50', 'helpful_voice_200', 'truck_tracker_5',
      'truck_tracker_20', 'consistent_voice_6'
    ]::text[])
    and not case award.badge_code
      when 'first_bite' then profile_active and approved_reviews >= 1
      when 'regular_5' then profile_active and approved_reviews >= 5
      when 'local_voice_10' then profile_active and approved_reviews >= 10
      when 'city_guide_25' then profile_active and approved_reviews >= 25
      when 'neighborhood_authority_50' then profile_active and approved_reviews >= 50
      when 'spottr_standard_100' then profile_active and approved_reviews >= 100
      when 'photo_scout_5' then profile_active and eligible_photo_reviews >= 5
      when 'photo_scout_20' then profile_active and eligible_photo_reviews >= 20
      when 'photo_scout_50' then profile_active and eligible_photo_reviews >= 50
      when 'helpful_voice_10' then profile_active and eligible_helpful_votes >= 10
      when 'helpful_voice_50' then profile_active and eligible_helpful_votes >= 50
      when 'helpful_voice_200' then profile_active and eligible_helpful_votes >= 200
      when 'truck_tracker_5' then profile_active and food_truck_reviews >= 5
      when 'truck_tracker_20' then profile_active and food_truck_reviews >= 20
      when 'consistent_voice_6' then profile_active and active_months >= 6
      else false
    end;
end;
$$;

create or replace function private.refresh_reaction_review_author_badges()
returns trigger language plpgsql security definer set search_path = '' as $$
declare target_review_id uuid := coalesce(new.review_id, old.review_id); target_author_id uuid;
begin
  select review.author_id into target_author_id from public.reviews review where review.id = target_review_id;
  perform private.refresh_profile_review_badges(target_author_id);
  return coalesce(new, old);
end;
$$;

create or replace function private.refresh_asset_review_author_badges()
returns trigger language plpgsql security definer set search_path = '' as $$
declare subject record;
begin
  for subject in
    select distinct review.author_id
    from public.review_media link join public.reviews review on review.id = link.review_id
    where link.asset_id = new.id
  loop perform private.refresh_profile_review_badges(subject.author_id); end loop;
  return new;
end;
$$;

create or replace function private.refresh_profile_status_badges()
returns trigger language plpgsql security definer set search_path = '' as $$
declare subject record;
begin
  perform private.refresh_profile_review_badges(new.user_id);
  for subject in
    select distinct review.author_id
    from public.review_reactions reaction
    join public.reviews review on review.id = reaction.review_id
    where reaction.user_id = new.user_id
  loop perform private.refresh_profile_review_badges(subject.author_id); end loop;
  return new;
end;
$$;

create or replace function private.refresh_business_review_author_badges()
returns trigger language plpgsql security definer set search_path = '' as $$
declare subject record;
begin
  for subject in select distinct review.author_id from public.reviews review where review.business_id = new.id
  loop perform private.refresh_profile_review_badges(subject.author_id); end loop;
  return new;
end;
$$;

drop trigger if exists review_reactions_refresh_trust_badges on public.review_reactions;
create trigger review_reactions_refresh_trust_badges
after insert or update of reaction or delete on public.review_reactions
for each row execute function private.refresh_reaction_review_author_badges();

drop trigger if exists media_assets_refresh_review_trust_badges on public.media_assets;
create trigger media_assets_refresh_review_trust_badges
after update of moderation, quarantine_state, processed_storage_path on public.media_assets
for each row execute function private.refresh_asset_review_author_badges();

drop trigger if exists profiles_refresh_trust_badges on public.profiles;
create trigger profiles_refresh_trust_badges
after update of status on public.profiles
for each row when (old.status is distinct from new.status)
execute function private.refresh_profile_status_badges();

drop trigger if exists businesses_refresh_reviewer_trust_badges on public.businesses;
create trigger businesses_refresh_reviewer_trust_badges
after update of state, verification, provenance, jurisdiction_id on public.businesses
for each row execute function private.refresh_business_review_author_badges();

create or replace view public.public_profile_badges
with (security_barrier = true, security_invoker = false) as
select profile.public_id as subject_public_id, award.badge_code, award.earned_at, award.expires_at
from public.profile_badge_awards award
join public.profiles profile on profile.user_id = award.subject_id and profile.status = 'active'
join public.badge_definitions definition on definition.code = award.badge_code and definition.is_active
where award.revoked_at is null and (award.expires_at is null or award.expires_at > now())
  and (auth.uid() is null or not private.users_are_blocked(auth.uid(), award.subject_id))
order by definition.sort_order, award.earned_at;

create or replace view public.public_business_badges
with (security_barrier = true, security_invoker = false) as
select business.id as business_id, award.badge_code, award.earned_at, award.expires_at
from public.business_badge_awards award
join public.businesses business on business.id = award.business_id
join public.badge_definitions definition on definition.code = award.badge_code and definition.is_active
where private.is_business_publicly_eligible(business.id)
  and award.revoked_at is null and (award.expires_at is null or award.expires_at > now())
order by definition.sort_order, award.earned_at;

create or replace view public.public_reviews
with (security_barrier = true, security_invoker = false) as
select review.id as review_id, review.business_id, profile.public_id as author_public_id,
  profile.username::text as author_username, profile.display_name as author_display_name,
  profile.avatar_path as author_avatar_path, review.rating, review.body,
  coalesce(reaction_stats.up_count, 0)::integer as helpful_count,
  review.created_at, review.updated_at,
  least(coalesce(badge_stats.badge_count, 0), 5)::integer as author_badge_count,
  coalesce(reaction_stats.down_count, 0)::integer as not_helpful_count,
  (coalesce(reaction_stats.up_count, 0) * 4
    - least(coalesce(reaction_stats.down_count, 0), 100) * 2
    + least(coalesce(badge_stats.badge_count, 0), 5) * 3)::integer as top_score
from public.reviews review
join public.profiles profile on profile.user_id = review.author_id and profile.status = 'active'
left join lateral (
  select count(*)::integer as badge_count
  from public.profile_badge_awards award
  join public.badge_definitions definition on definition.code = award.badge_code
  where award.subject_id = review.author_id and award.revoked_at is null
    and (award.expires_at is null or award.expires_at > now()) and definition.audience = 'reviewer'
) badge_stats on true
left join lateral (
  select count(*) filter (where reaction.reaction = 1)::integer as up_count,
    count(*) filter (where reaction.reaction = -1)::integer as down_count
  from public.review_reactions reaction
  join public.profiles reactor on reactor.user_id = reaction.user_id and reactor.status = 'active'
  where reaction.review_id = review.id
    and not private.users_are_blocked(review.author_id, reaction.user_id)
) reaction_stats on true
where review.moderation = 'approved' and review.deleted_at is null
  and private.is_business_publicly_eligible(review.business_id)
  and (auth.uid() is null or not private.users_are_blocked(auth.uid(), review.author_id));

revoke all on function private.refresh_profile_review_badges(uuid) from public, anon, authenticated, service_role;
revoke all on function private.refresh_reaction_review_author_badges() from public, anon, authenticated, service_role;
revoke all on function private.refresh_asset_review_author_badges() from public, anon, authenticated, service_role;
revoke all on function private.refresh_profile_status_badges() from public, anon, authenticated, service_role;
revoke all on function private.refresh_business_review_author_badges() from public, anon, authenticated, service_role;
revoke all on public.public_profile_badges from public, anon, authenticated;
revoke all on public.public_business_badges from public, anon, authenticated;
revoke all on public.public_reviews from public, anon, authenticated;
grant select on public.public_profile_badges to anon, authenticated;
grant select on public.public_business_badges to anon, authenticated;
grant select on public.public_reviews to anon, authenticated;
