-- Spottr secure production foundation
-- Run only in a new Supabase project. Review migrations before applying to an existing database.

create extension if not exists pgcrypto;
create extension if not exists citext;
create extension if not exists postgis;

do $$ begin
  create type public.business_kind as enum ('food_truck', 'restaurant', 'pop_up', 'cafe_bakery', 'home_kitchen');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.business_state as enum ('draft', 'pending', 'published', 'suspended', 'archived');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.verification_state as enum ('unverified', 'pending', 'verified', 'rejected', 'expired');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.member_role as enum ('owner', 'manager', 'staff');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.moderation_state as enum ('pending', 'approved', 'rejected', 'removed');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.update_kind as enum ('location', 'availability', 'hours', 'menu');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.payment_kind as enum (
    'cash',
    'visa',
    'mastercard',
    'amex',
    'apple_pay',
    'google_pay',
    'cash_app',
    'venmo'
  );
exception when duplicate_object then null;
end $$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username citext not null unique,
  display_name text not null,
  avatar_path text,
  status text not null default 'active' check (status in ('active', 'restricted', 'suspended', 'deleted')),
  terms_accepted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint profiles_username_length check (char_length(btrim(username::text)) between 1 and 24),
  constraint profiles_username_format check (username::text ~ '^[[:alnum:]_.-]+$'),
  constraint profiles_display_name_length check (char_length(btrim(display_name)) between 1 and 80)
);

create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  kind public.business_kind not null,
  name text not null,
  slug citext not null unique,
  description text not null default '',
  cuisine_labels text[] not null default '{}',
  price_level smallint not null default 2 check (price_level between 1 and 4),
  state public.business_state not null default 'draft',
  verification public.verification_state not null default 'unverified',
  timezone text not null default 'America/Los_Angeles',
  logo_asset_id uuid,
  provenance text not null default 'owner' check (provenance in ('owner', 'community', 'licensed_provider')),
  provider_freshness_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint businesses_name_length check (char_length(btrim(name)) between 1 and 100),
  constraint businesses_description_length check (char_length(description) <= 2000)
);

create table if not exists public.business_private_details (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  legal_name text,
  business_email citext,
  business_phone text,
  website_url text,
  verification_notes text,
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.business_members (
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null,
  invited_by uuid references auth.users(id),
  created_at timestamptz not null default timezone('utc', now()),
  primary key (business_id, user_id)
);

create table if not exists public.business_claims (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  claimant_id uuid not null references auth.users(id) on delete cascade,
  method text not null check (method in ('listed_phone', 'domain_email', 'document', 'permit')),
  evidence_private_path text,
  state text not null default 'pending' check (state in ('pending', 'approved', 'rejected', 'withdrawn')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  unique (business_id, claimant_id, state)
);

create table if not exists public.business_locations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  label text not null,
  address_line text,
  city text not null,
  region text not null,
  postal_code text,
  point geography(point, 4326) not null,
  is_primary boolean not null default false,
  is_approximate boolean not null default false,
  public_address boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists business_locations_point_gix on public.business_locations using gist (point);
create index if not exists business_locations_business_idx on public.business_locations (business_id);

create table if not exists public.mobile_stops (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  location_id uuid not null references public.business_locations(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  state text not null default 'scheduled' check (state in ('draft', 'scheduled', 'live', 'completed', 'cancelled')),
  confirmed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint mobile_stops_valid_window check (ends_at > starts_at)
);

create index if not exists mobile_stops_business_time_idx on public.mobile_stops (business_id, starts_at, ends_at);

create table if not exists public.weekly_hours (
  business_id uuid not null references public.businesses(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  opens_at time,
  closes_at time,
  is_closed boolean not null default false,
  primary key (business_id, weekday),
  constraint weekly_hours_valid check (
    (is_closed and opens_at is null and closes_at is null)
    or
    (not is_closed and opens_at is not null and closes_at is not null)
  )
);

create table if not exists public.special_hours (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  service_date date not null,
  opens_at time,
  closes_at time,
  is_closed boolean not null default false,
  note text,
  unique (business_id, service_date)
);

create table if not exists public.business_payments (
  business_id uuid not null references public.businesses(id) on delete cascade,
  payment public.payment_kind not null,
  primary key (business_id, payment)
);

create table if not exists public.business_updates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  author_id uuid not null references auth.users(id),
  kind public.update_kind not null,
  body text not null,
  starts_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null,
  moderation public.moderation_state not null default 'pending',
  created_at timestamptz not null default timezone('utc', now()),
  constraint business_updates_body_length check (char_length(btrim(body)) between 1 and 120),
  constraint business_updates_expiry check (
    expires_at > starts_at and expires_at <= starts_at + interval '24 hours'
  )
);

create index if not exists business_updates_active_idx
  on public.business_updates (business_id, moderation, starts_at, expires_at);

create table if not exists public.menu_sections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  is_published boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.menu_items (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references public.menu_sections(id) on delete cascade,
  name text not null,
  description text not null default '',
  price_minor integer not null check (price_minor >= 0),
  currency char(3) not null default 'USD',
  availability text not null default 'available' check (availability in ('available', 'sold_out', 'hidden')),
  dietary_tags text[] not null default '{}',
  allergen_note text,
  sort_order integer not null default 0,
  is_published boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint menu_items_name_length check (char_length(btrim(name)) between 1 and 120)
);

create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  business_id uuid references public.businesses(id) on delete cascade,
  storage_path text not null unique,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  width integer not null check (width between 1 and 8192),
  height integer not null check (height between 1 and 8192),
  byte_size bigint not null check (byte_size between 1 and 10485760),
  sha256 text,
  source text not null default 'owner_upload',
  license_note text,
  moderation public.moderation_state not null default 'pending',
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.businesses
  drop constraint if exists businesses_logo_asset_id_fkey;
alter table public.businesses
  add constraint businesses_logo_asset_id_fkey
  foreign key (logo_asset_id) references public.media_assets(id) on delete set null;

create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  body text not null,
  moderation public.moderation_state not null default 'pending',
  helpful_count integer not null default 0 check (helpful_count >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz,
  constraint reviews_body_length check (char_length(btrim(body)) between 1 and 2000),
  unique (business_id, author_id)
);

create table if not exists public.review_media (
  review_id uuid not null references public.reviews(id) on delete cascade,
  asset_id uuid not null references public.media_assets(id) on delete cascade,
  sort_order smallint not null default 0 check (sort_order between 0 and 3),
  primary key (review_id, asset_id)
);

create table if not exists public.business_responses (
  review_id uuid primary key references public.reviews(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  author_id uuid not null references auth.users(id),
  body text not null,
  moderation public.moderation_state not null default 'pending',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint business_responses_body_length check (char_length(btrim(body)) between 1 and 1000)
);

create table if not exists public.follows (
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, business_id)
);

create table if not exists public.notification_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  live_nearby boolean not null default true,
  location_change boolean not null default true,
  owner_update boolean not null default true,
  menu_return boolean not null default false,
  quiet_hours_start time,
  quiet_hours_end time,
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, business_id)
);

create table if not exists public.content_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  target_type text not null check (target_type in ('business', 'review', 'response', 'update', 'media', 'user')),
  target_id uuid not null,
  reason text not null,
  detail text,
  state text not null default 'open' check (state in ('open', 'reviewing', 'resolved', 'dismissed')),
  created_at timestamptz not null default timezone('utc', now()),
  unique (reporter_id, target_type, target_id)
);

create table if not exists public.user_blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (blocker_id, blocked_id),
  constraint user_blocks_not_self check (blocker_id <> blocked_id)
);

create table if not exists public.provider_links (
  business_id uuid not null references public.businesses(id) on delete cascade,
  provider text not null,
  provider_place_id text not null,
  last_fetched_at timestamptz,
  primary key (provider, provider_place_id)
);

create table if not exists public.jurisdictions (
  id uuid primary key default gen_random_uuid(),
  country_code char(2) not null,
  region_code text not null,
  locality text,
  home_kitchens_enabled boolean not null default false,
  legal_reviewed_at timestamptz,
  rules_url text,
  unique (country_code, region_code, locality)
);

create table if not exists public.home_kitchen_permits (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  jurisdiction_id uuid not null references public.jurisdictions(id),
  permit_number_private text not null,
  issuer text not null,
  expires_on date not null,
  verification public.verification_state not null default 'pending',
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz
);

create table if not exists public.audit_events (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id),
  business_id uuid references public.businesses(id) on delete set null,
  event_type text not null,
  target_type text not null,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists audit_events_business_time_idx on public.audit_events (business_id, created_at desc);

create or replace function public.is_business_member(
  target_business_id uuid,
  allowed_roles public.member_role[] default array['owner', 'manager', 'staff']::public.member_role[]
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.business_members bm
    where bm.business_id = target_business_id
      and bm.user_id = auth.uid()
      and bm.role = any(allowed_roles)
  );
$$;

revoke all on function public.is_business_member(uuid, public.member_role[]) from public;
grant execute on function public.is_business_member(uuid, public.member_role[]) to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_username text;
begin
  requested_username := nullif(btrim(new.raw_user_meta_data ->> 'username'), '');

  insert into public.profiles (user_id, username, display_name, terms_accepted_at)
  values (
    new.id,
    coalesce(requested_username, 'user_' || left(replace(new.id::text, '-', ''), 12)),
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), 'Spottr member'),
    case
      when coalesce((new.raw_user_meta_data ->> 'terms_accepted')::boolean, false)
      then timezone('utc', now())
      else null
    end
  );

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists businesses_set_updated_at on public.businesses;
create trigger businesses_set_updated_at before update on public.businesses
for each row execute function public.set_updated_at();

drop trigger if exists locations_set_updated_at on public.business_locations;
create trigger locations_set_updated_at before update on public.business_locations
for each row execute function public.set_updated_at();

drop trigger if exists mobile_stops_set_updated_at on public.mobile_stops;
create trigger mobile_stops_set_updated_at before update on public.mobile_stops
for each row execute function public.set_updated_at();

drop trigger if exists menu_sections_set_updated_at on public.menu_sections;
create trigger menu_sections_set_updated_at before update on public.menu_sections
for each row execute function public.set_updated_at();

drop trigger if exists menu_items_set_updated_at on public.menu_items;
create trigger menu_items_set_updated_at before update on public.menu_items
for each row execute function public.set_updated_at();

drop trigger if exists reviews_set_updated_at on public.reviews;
create trigger reviews_set_updated_at before update on public.reviews
for each row execute function public.set_updated_at();

drop trigger if exists responses_set_updated_at on public.business_responses;
create trigger responses_set_updated_at before update on public.business_responses
for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.businesses enable row level security;
alter table public.business_private_details enable row level security;
alter table public.business_members enable row level security;
alter table public.business_claims enable row level security;
alter table public.business_locations enable row level security;
alter table public.mobile_stops enable row level security;
alter table public.weekly_hours enable row level security;
alter table public.special_hours enable row level security;
alter table public.business_payments enable row level security;
alter table public.business_updates enable row level security;
alter table public.menu_sections enable row level security;
alter table public.menu_items enable row level security;
alter table public.media_assets enable row level security;
alter table public.reviews enable row level security;
alter table public.review_media enable row level security;
alter table public.business_responses enable row level security;
alter table public.follows enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.content_reports enable row level security;
alter table public.user_blocks enable row level security;
alter table public.provider_links enable row level security;
alter table public.jurisdictions enable row level security;
alter table public.home_kitchen_permits enable row level security;
alter table public.audit_events enable row level security;

-- Profiles: no email is stored here. Public identity is exposed through a narrow view below.
create policy "profiles read own" on public.profiles
  for select to authenticated using (user_id = auth.uid());
create policy "profiles update own" on public.profiles
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Public business data can be browsed without an account.
create policy "published businesses are readable" on public.businesses
  for select to anon, authenticated using (state = 'published');
create policy "members read their business drafts" on public.businesses
  for select to authenticated using (public.is_business_member(id));

create policy "members read private details" on public.business_private_details
  for select to authenticated using (public.is_business_member(business_id, array['owner', 'manager']::public.member_role[]));

create policy "members read memberships" on public.business_members
  for select to authenticated using (user_id = auth.uid() or public.is_business_member(business_id, array['owner']::public.member_role[]));

create policy "claimants create claims" on public.business_claims
  for insert to authenticated with check (claimant_id = auth.uid() and state = 'pending');
create policy "claimants read own claims" on public.business_claims
  for select to authenticated using (claimant_id = auth.uid());

-- Raw locations are private to members. A sanitized public view follows.
create policy "members read raw locations" on public.business_locations
  for select to authenticated using (public.is_business_member(business_id));
create policy "members manage raw locations" on public.business_locations
  for all to authenticated
  using (public.is_business_member(business_id, array['owner', 'manager']::public.member_role[]))
  with check (public.is_business_member(business_id, array['owner', 'manager']::public.member_role[]));

create policy "published mobile stops readable" on public.mobile_stops
  for select to anon, authenticated using (
    state in ('scheduled', 'live', 'completed')
    and exists (
      select 1 from public.businesses b
      where b.id = business_id and b.state = 'published'
    )
  );
create policy "members manage stops" on public.mobile_stops
  for all to authenticated
  using (public.is_business_member(business_id))
  with check (public.is_business_member(business_id));

create policy "published weekly hours readable" on public.weekly_hours
  for select to anon, authenticated using (
    exists (select 1 from public.businesses b where b.id = business_id and b.state = 'published')
  );
create policy "members manage weekly hours" on public.weekly_hours
  for all to authenticated
  using (public.is_business_member(business_id))
  with check (public.is_business_member(business_id));

create policy "published special hours readable" on public.special_hours
  for select to anon, authenticated using (
    exists (select 1 from public.businesses b where b.id = business_id and b.state = 'published')
  );
create policy "members manage special hours" on public.special_hours
  for all to authenticated
  using (public.is_business_member(business_id))
  with check (public.is_business_member(business_id));

create policy "published payments readable" on public.business_payments
  for select to anon, authenticated using (
    exists (select 1 from public.businesses b where b.id = business_id and b.state = 'published')
  );
create policy "members manage payments" on public.business_payments
  for all to authenticated
  using (public.is_business_member(business_id))
  with check (public.is_business_member(business_id));

create policy "approved active updates readable" on public.business_updates
  for select to anon, authenticated using (
    moderation = 'approved'
    and starts_at <= timezone('utc', now())
    and expires_at > timezone('utc', now())
    and exists (select 1 from public.businesses b where b.id = business_id and b.state = 'published')
  );
create policy "members submit updates for moderation" on public.business_updates
  for insert to authenticated with check (
    author_id = auth.uid()
    and moderation = 'pending'
    and public.is_business_member(business_id)
  );
create policy "members read own business updates" on public.business_updates
  for select to authenticated using (public.is_business_member(business_id));

create policy "published menu sections readable" on public.menu_sections
  for select to anon, authenticated using (
    is_published
    and exists (select 1 from public.businesses b where b.id = business_id and b.state = 'published')
  );
create policy "members manage menu sections" on public.menu_sections
  for all to authenticated
  using (public.is_business_member(business_id))
  with check (public.is_business_member(business_id));

create policy "published menu items readable" on public.menu_items
  for select to anon, authenticated using (
    is_published
    and exists (
      select 1
      from public.menu_sections ms
      join public.businesses b on b.id = ms.business_id
      where ms.id = section_id and ms.is_published and b.state = 'published'
    )
  );
create policy "members manage menu items" on public.menu_items
  for all to authenticated
  using (
    exists (
      select 1 from public.menu_sections ms
      where ms.id = section_id and public.is_business_member(ms.business_id)
    )
  )
  with check (
    exists (
      select 1 from public.menu_sections ms
      where ms.id = section_id and public.is_business_member(ms.business_id)
    )
  );

create policy "owners read own media records" on public.media_assets
  for select to authenticated using (owner_id = auth.uid() or public.is_business_member(business_id));
create policy "owners create staged media records" on public.media_assets
  for insert to authenticated with check (
    owner_id = auth.uid()
    and moderation = 'pending'
    and (business_id is null or public.is_business_member(business_id))
  );

create policy "approved reviews readable" on public.reviews
  for select to anon, authenticated using (moderation = 'approved' and deleted_at is null);
create policy "authors read own pending reviews" on public.reviews
  for select to authenticated using (author_id = auth.uid());
create policy "verified users submit reviews" on public.reviews
  for insert to authenticated with check (
    author_id = auth.uid()
    and moderation = 'pending'
    and deleted_at is null
  );

create policy "approved review media readable" on public.review_media
  for select to anon, authenticated using (
    exists (
      select 1 from public.reviews r
      join public.media_assets ma on ma.id = asset_id
      where r.id = review_id and r.moderation = 'approved' and r.deleted_at is null and ma.moderation = 'approved'
    )
  );
create policy "authors attach own pending review media" on public.review_media
  for insert to authenticated with check (
    exists (select 1 from public.reviews r where r.id = review_id and r.author_id = auth.uid() and r.moderation = 'pending')
    and exists (select 1 from public.media_assets ma where ma.id = asset_id and ma.owner_id = auth.uid())
  );

create policy "approved responses readable" on public.business_responses
  for select to anon, authenticated using (moderation = 'approved');
create policy "members submit responses" on public.business_responses
  for insert to authenticated with check (
    author_id = auth.uid()
    and moderation = 'pending'
    and public.is_business_member(business_id)
  );

create policy "users read own follows" on public.follows
  for select to authenticated using (user_id = auth.uid());
create policy "users create own follows" on public.follows
  for insert to authenticated with check (user_id = auth.uid());
create policy "users delete own follows" on public.follows
  for delete to authenticated using (user_id = auth.uid());

create policy "users manage own notification preferences" on public.notification_preferences
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "users create reports" on public.content_reports
  for insert to authenticated with check (reporter_id = auth.uid() and state = 'open');
create policy "users read own reports" on public.content_reports
  for select to authenticated using (reporter_id = auth.uid());

create policy "users manage own blocks" on public.user_blocks
  for all to authenticated
  using (blocker_id = auth.uid())
  with check (blocker_id = auth.uid());

create policy "members read provider links" on public.provider_links
  for select to authenticated using (public.is_business_member(business_id));

create policy "enabled jurisdictions readable" on public.jurisdictions
  for select to anon, authenticated using (legal_reviewed_at is not null);

create policy "members read own permit status" on public.home_kitchen_permits
  for select to authenticated using (public.is_business_member(business_id, array['owner', 'manager']::public.member_role[]));

create policy "members read own audit events" on public.audit_events
  for select to authenticated using (
    actor_id = auth.uid()
    or public.is_business_member(business_id, array['owner']::public.member_role[])
  );

create or replace view public.public_profiles as
select user_id, username, display_name, avatar_path
from public.profiles
where status = 'active';

create or replace view public.public_business_locations as
select
  bl.id,
  bl.business_id,
  bl.label,
  case
    when b.kind = 'home_kitchen' or not bl.public_address then null
    else bl.address_line
  end as address_line,
  bl.city,
  bl.region,
  case
    when b.kind = 'home_kitchen' or not bl.public_address then null
    else bl.postal_code
  end as postal_code,
  case
    when b.kind = 'home_kitchen' then
      st_snaptogrid(bl.point::geometry, 0.02)::geography
    else bl.point
  end as point,
  (bl.is_approximate or b.kind = 'home_kitchen') as is_approximate,
  bl.is_primary
from public.business_locations bl
join public.businesses b on b.id = bl.business_id
where b.state = 'published';

revoke all on public.public_profiles from public;
revoke all on public.public_business_locations from public;
grant select on public.public_profiles to anon, authenticated;
grant select on public.public_business_locations to anon, authenticated;

create or replace function public.nearby_businesses(
  search_lat double precision,
  search_lng double precision,
  radius_meters integer default 16093,
  result_limit integer default 50
)
returns table (
  business_id uuid,
  name text,
  kind public.business_kind,
  location_label text,
  city text,
  region text,
  distance_meters double precision,
  is_approximate boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    b.id,
    b.name,
    b.kind,
    pbl.label,
    pbl.city,
    pbl.region,
    st_distance(
      pbl.point,
      st_setsrid(st_makepoint(search_lng, search_lat), 4326)::geography
    ) as distance_meters,
    pbl.is_approximate
  from public.businesses b
  join public.public_business_locations pbl on pbl.business_id = b.id
  where b.state = 'published'
    and st_dwithin(
      pbl.point,
      st_setsrid(st_makepoint(search_lng, search_lat), 4326)::geography,
      least(greatest(radius_meters, 500), 80467)
    )
  order by
    case when b.kind = 'food_truck' then 0 else 1 end,
    distance_meters
  limit least(greatest(result_limit, 1), 100);
$$;

revoke all on function public.nearby_businesses(double precision, double precision, integer, integer) from public;
grant execute on function public.nearby_businesses(double precision, double precision, integer, integer) to anon, authenticated;

-- Storage buckets should be private. Edge Functions validate MIME, re-encode images,
-- strip EXIF data, virus-scan, moderate, and only then mark media_assets approved.
create policy "authenticated users upload staged media"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'spottr-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "users read own staged media"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'spottr-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- No generic client policies exist for:
-- * publishing/suspending businesses
-- * approving claims or permits
-- * changing verification states
-- * approving/rejecting moderation
-- * writing audit events or provider links
-- Those operations must run in audited server-side functions or Edge Functions.
