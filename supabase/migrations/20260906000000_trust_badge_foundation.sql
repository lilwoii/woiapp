-- Evidence-backed trust achievements. Awards are server-owned and are intentionally
-- isolated from sponsored placement and organic review ordering.

create table if not exists public.badge_definitions (
  code text primary key,
  audience text not null check (audience in ('reviewer', 'business', 'seller')),
  tier text not null check (tier in ('starter', 'bronze', 'silver', 'gold', 'signature')),
  title text not null,
  description text not null,
  requirement text not null,
  is_active boolean not null default true,
  is_time_limited boolean not null default false,
  sort_order smallint not null check (sort_order between 0 and 1000),
  created_at timestamptz not null default now(),
  constraint badge_definitions_code_format check (code ~ '^[a-z0-9_]{3,64}$'),
  constraint badge_definitions_copy_length check (
    char_length(title) between 2 and 60
    and char_length(description) between 10 and 240
    and char_length(requirement) between 10 and 300
  )
);

insert into public.badge_definitions
  (code, audience, tier, title, description, requirement, is_time_limited, sort_order)
values
  ('first_bite', 'reviewer', 'starter', 'First Bite', 'Started sharing useful local food experiences.', 'Publish 1 approved review.', false, 10),
  ('regular_5', 'reviewer', 'bronze', 'Spottr Regular', 'Keeps the community informed with first-hand reviews.', 'Publish 5 approved reviews.', false, 20),
  ('local_voice_10', 'reviewer', 'silver', 'Local Voice', 'A consistent voice in local food discovery.', 'Publish 10 approved reviews.', false, 30),
  ('city_guide_25', 'reviewer', 'gold', 'City Guide', 'Has built a substantial record of local recommendations.', 'Publish 25 approved reviews.', false, 40),
  ('neighborhood_authority_50', 'reviewer', 'signature', 'Neighborhood Authority', 'A long-term contributor across the local food scene.', 'Publish 50 approved reviews.', false, 50),
  ('spottr_standard_100', 'reviewer', 'signature', 'Spottr Standard', 'One hundred approved contributions with an account in good standing.', 'Publish 100 approved reviews and remain in good standing.', false, 60),
  ('photo_scout_5', 'reviewer', 'bronze', 'Photo Scout I', 'Helps people see what to expect before they arrive.', 'Add approved photos to 5 reviews.', false, 70),
  ('photo_scout_20', 'reviewer', 'silver', 'Photo Scout II', 'A dependable visual contributor.', 'Add approved photos to 20 reviews.', false, 80),
  ('photo_scout_50', 'reviewer', 'gold', 'Photo Scout III', 'A standout visual documentarian of local food.', 'Add approved photos to 50 reviews.', false, 90),
  ('helpful_voice_10', 'reviewer', 'bronze', 'Helpful Voice I', 'Other members regularly find these reviews useful.', 'Receive 10 eligible helpful votes.', false, 100),
  ('helpful_voice_50', 'reviewer', 'silver', 'Helpful Voice II', 'Reviews repeatedly help people make a decision.', 'Receive 50 eligible helpful votes.', false, 110),
  ('helpful_voice_200', 'reviewer', 'gold', 'Helpful Voice III', 'Exceptional community usefulness over time.', 'Receive 200 eligible helpful votes.', false, 120),
  ('truck_tracker_5', 'reviewer', 'bronze', 'Truck Tracker I', 'Actively supports mobile food businesses.', 'Publish 5 approved food-truck reviews.', false, 130),
  ('truck_tracker_20', 'reviewer', 'silver', 'Truck Tracker II', 'A seasoned guide to the mobile food scene.', 'Publish 20 approved food-truck reviews.', false, 140),
  ('consistent_voice_6', 'reviewer', 'gold', 'Consistent Voice', 'Contributes across seasons, not just in a burst.', 'Publish approved reviews in 6 distinct months.', false, 150),
  ('verified_business', 'business', 'signature', 'Verified Business', 'Business control and identity checks are complete.', 'Complete Spottr business verification.', false, 300),
  ('quick_reply', 'business', 'bronze', 'Quick Reply', 'Usually answers eligible customer messages promptly.', 'Meet the rolling response-time standard with sufficient message volume.', true, 310),
  ('great_communicator', 'business', 'gold', 'Great Communicator', 'Communicates clearly and reliably with customers.', 'Maintain strong communication feedback and low substantiated report rates.', true, 320),
  ('consistent_service', 'business', 'gold', 'Consistent Service', 'Keeps hours, service status, and customer expectations dependable.', 'Meet the rolling reliability standard for 90 days.', true, 330),
  ('fresh_menu', 'business', 'silver', 'Fresh Menu', 'Keeps menu details and availability current.', 'Maintain a recently confirmed menu with required pricing.', true, 340),
  ('community_favorite', 'business', 'signature', 'Community Favorite', 'Sustained strong ratings from eligible first-party reviews.', 'Meet the minimum review volume, rating, and integrity standards.', true, 350),
  ('rising_spot', 'business', 'silver', 'Rising Spot', 'Earning unusual positive momentum locally.', 'Meet the time-limited local growth and quality threshold.', true, 360),
  ('local_trendsetter', 'business', 'gold', 'Local Trendsetter', 'Currently among the most engaged-with places in its area.', 'Meet the rolling local engagement threshold; recalculated regularly.', true, 370),
  ('route_reliable', 'business', 'gold', 'Route Reliable', 'A mobile business with dependable published stops.', 'Maintain accurate stops with a strong confirmation record.', true, 380),
  ('verified_seller', 'seller', 'signature', 'Verified Seller', 'Seller identity and marketplace eligibility checks are complete.', 'Complete Spottr seller verification.', false, 500),
  ('trusted_seller', 'seller', 'signature', 'Trusted Seller', 'A durable record of reliable communication and completed handoffs.', 'Meet verification, tenure, feedback, and low-dispute standards.', true, 510),
  ('pickup_pro', 'seller', 'gold', 'Pickup Pro', 'Consistently coordinates smooth pickup handoffs.', 'Meet the rolling pickup reliability standard.', true, 520),
  ('spottr_orders_25', 'seller', 'bronze', '25 Spottr Orders', 'Completed 25 verified Spottr pickup orders.', 'Complete 25 non-refunded Spottr orders.', false, 530),
  ('spottr_orders_100', 'seller', 'silver', '100 Spottr Orders', 'Completed 100 verified Spottr pickup orders.', 'Complete 100 non-refunded Spottr orders.', false, 540),
  ('spottr_orders_500', 'seller', 'gold', '500 Spottr Orders', 'Completed 500 verified Spottr pickup orders.', 'Complete 500 non-refunded Spottr orders.', false, 550),
  ('spottr_orders_1000', 'seller', 'signature', '1,000 Spottr Orders', 'Completed 1,000 verified Spottr pickup orders.', 'Complete 1,000 non-refunded Spottr orders.', false, 560)
on conflict (code) do update set
  audience = excluded.audience,
  tier = excluded.tier,
  title = excluded.title,
  description = excluded.description,
  requirement = excluded.requirement,
  is_time_limited = excluded.is_time_limited,
  sort_order = excluded.sort_order;

create table if not exists public.profile_badge_awards (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references public.profiles(user_id) on delete cascade,
  badge_code text not null references public.badge_definitions(code) on delete restrict,
  earned_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revocation_reason text,
  evidence_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (subject_id, badge_code),
  constraint profile_badge_awards_expiry check (expires_at is null or expires_at > earned_at),
  constraint profile_badge_awards_revocation check (
    (revoked_at is null and revocation_reason is null)
    or (revoked_at is not null and char_length(btrim(revocation_reason)) between 3 and 300)
  ),
  constraint profile_badge_awards_evidence_size check (octet_length(evidence_snapshot::text) <= 4096)
);

create table if not exists public.business_badge_awards (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  badge_code text not null references public.badge_definitions(code) on delete restrict,
  earned_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revocation_reason text,
  evidence_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (business_id, badge_code),
  constraint business_badge_awards_expiry check (expires_at is null or expires_at > earned_at),
  constraint business_badge_awards_revocation check (
    (revoked_at is null and revocation_reason is null)
    or (revoked_at is not null and char_length(btrim(revocation_reason)) between 3 and 300)
  ),
  constraint business_badge_awards_evidence_size check (octet_length(evidence_snapshot::text) <= 4096)
);

create index if not exists profile_badge_awards_public_idx
  on public.profile_badge_awards (subject_id, earned_at desc)
  where revoked_at is null;
create index if not exists business_badge_awards_public_idx
  on public.business_badge_awards (business_id, earned_at desc)
  where revoked_at is null;

alter table public.badge_definitions enable row level security;
alter table public.profile_badge_awards enable row level security;
alter table public.business_badge_awards enable row level security;

drop policy if exists "active badge definitions are readable" on public.badge_definitions;
create policy "active badge definitions are readable"
on public.badge_definitions for select
using (is_active);

create or replace function private.refresh_profile_review_badges(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  approved_reviews integer;
  eligible_photo_reviews integer;
  eligible_helpful_votes bigint;
  food_truck_reviews integer;
  active_months integer;
begin
  if target_user_id is null then return; end if;

  select
    count(*)::integer,
    coalesce(sum(r.helpful_count), 0)::bigint,
    count(*) filter (where b.kind = 'food_truck')::integer,
    count(distinct date_trunc('month', r.created_at))::integer
  into approved_reviews, eligible_helpful_votes, food_truck_reviews, active_months
  from public.reviews r
  join public.businesses b on b.id = r.business_id
  where r.author_id = target_user_id
    and r.moderation = 'approved'
    and r.deleted_at is null;

  select count(distinct r.id)::integer
  into eligible_photo_reviews
  from public.reviews r
  join public.review_media rm on rm.review_id = r.id
  join public.media_assets ma on ma.id = rm.asset_id
  where r.author_id = target_user_id
    and r.moderation = 'approved'
    and r.deleted_at is null
    and ma.moderation = 'approved'
    and ma.quarantine_state = 'clean';

  insert into public.profile_badge_awards (subject_id, badge_code, evidence_snapshot)
  select target_user_id, candidate.code, jsonb_build_object(
    'approved_reviews', approved_reviews,
    'eligible_photo_reviews', eligible_photo_reviews,
    'eligible_helpful_votes', eligible_helpful_votes,
    'food_truck_reviews', food_truck_reviews,
    'active_months', active_months
  )
  from (values
    ('first_bite', approved_reviews >= 1),
    ('regular_5', approved_reviews >= 5),
    ('local_voice_10', approved_reviews >= 10),
    ('city_guide_25', approved_reviews >= 25),
    ('neighborhood_authority_50', approved_reviews >= 50),
    ('spottr_standard_100', approved_reviews >= 100),
    ('photo_scout_5', eligible_photo_reviews >= 5),
    ('photo_scout_20', eligible_photo_reviews >= 20),
    ('photo_scout_50', eligible_photo_reviews >= 50),
    ('helpful_voice_10', eligible_helpful_votes >= 10),
    ('helpful_voice_50', eligible_helpful_votes >= 50),
    ('helpful_voice_200', eligible_helpful_votes >= 200),
    ('truck_tracker_5', food_truck_reviews >= 5),
    ('truck_tracker_20', food_truck_reviews >= 20),
    ('consistent_voice_6', active_months >= 6)
  ) as candidate(code, qualifies)
  where candidate.qualifies
  on conflict (subject_id, badge_code) do nothing;
end;
$$;

create or replace function private.refresh_review_author_badges()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    perform private.refresh_profile_review_badges(old.author_id);
  end if;
  if tg_op <> 'DELETE' and (tg_op = 'INSERT' or new.author_id is distinct from old.author_id) then
    perform private.refresh_profile_review_badges(new.author_id);
  elsif tg_op = 'UPDATE' then
    perform private.refresh_profile_review_badges(new.author_id);
  end if;
  return coalesce(new, old);
end;
$$;

create or replace function private.refresh_review_media_author_badges()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_review_id uuid := coalesce(new.review_id, old.review_id);
  target_author_id uuid;
begin
  select r.author_id into target_author_id from public.reviews r where r.id = target_review_id;
  perform private.refresh_profile_review_badges(target_author_id);
  return coalesce(new, old);
end;
$$;

drop trigger if exists reviews_refresh_trust_badges on public.reviews;
create trigger reviews_refresh_trust_badges
after insert or update of moderation, deleted_at, helpful_count or delete on public.reviews
for each row execute function private.refresh_review_author_badges();

drop trigger if exists review_media_refresh_trust_badges on public.review_media;
create trigger review_media_refresh_trust_badges
after insert or delete on public.review_media
for each row execute function private.refresh_review_media_author_badges();

do $$
declare subject record;
begin
  for subject in select distinct r.author_id from public.reviews r loop
    perform private.refresh_profile_review_badges(subject.author_id);
  end loop;
end $$;

create or replace view public.public_profile_badges
with (security_barrier = true, security_invoker = false)
as
select
  p.public_id as subject_public_id,
  a.badge_code,
  a.earned_at,
  a.expires_at
from public.profile_badge_awards a
join public.profiles p on p.user_id = a.subject_id and p.status = 'active'
join public.badge_definitions d on d.code = a.badge_code and d.is_active
where a.revoked_at is null
  and (a.expires_at is null or a.expires_at > now())
order by d.sort_order, a.earned_at;

create or replace view public.public_business_badges
with (security_barrier = true, security_invoker = false)
as
select
  b.public_id as business_public_id,
  a.badge_code,
  a.earned_at,
  a.expires_at
from public.business_badge_awards a
join public.businesses b on b.id = a.business_id and b.state = 'published'
join public.badge_definitions d on d.code = a.badge_code and d.is_active
where a.revoked_at is null
  and (a.expires_at is null or a.expires_at > now())
order by d.sort_order, a.earned_at;

create or replace function public.get_my_profile_badges()
returns table (
  badge_code text,
  earned_at timestamptz,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.badge_code, a.earned_at, a.expires_at
  from public.profile_badge_awards a
  join public.badge_definitions d on d.code = a.badge_code and d.is_active
  join public.profiles p on p.user_id = a.subject_id and p.status = 'active'
  where a.subject_id = auth.uid()
    and a.revoked_at is null
    and (a.expires_at is null or a.expires_at > now())
  order by d.sort_order, a.earned_at;
$$;

revoke all on table public.profile_badge_awards from anon, authenticated, service_role;
revoke all on table public.business_badge_awards from anon, authenticated, service_role;
revoke insert, update, delete on table public.badge_definitions from anon, authenticated, service_role;
grant select on table public.badge_definitions to anon, authenticated;
grant select on table public.public_profile_badges to anon, authenticated;
grant select on table public.public_business_badges to anon, authenticated;

revoke all on function public.get_my_profile_badges() from public, anon, service_role;
grant execute on function public.get_my_profile_badges() to authenticated;

revoke all on function private.refresh_profile_review_badges(uuid) from public, anon, authenticated, service_role;
revoke all on function private.refresh_review_author_badges() from public, anon, authenticated, service_role;
revoke all on function private.refresh_review_media_author_badges() from public, anon, authenticated, service_role;
