-- Spottr secure production foundation
-- Run only in a new Supabase project. Review migrations before applying to an existing database.

create extension if not exists pgcrypto;
create extension if not exists citext;
create extension if not exists postgis;
create extension if not exists pg_trgm;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

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

do $$ begin
  create type public.location_publication_state as enum ('private', 'published', 'archived');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.live_business_status as enum ('open', 'opening_soon', 'moving_soon', 'closed');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.platform_role as enum ('moderator', 'admin');
exception when duplicate_object then null;
end $$;

create table if not exists public.jurisdictions (
  id uuid primary key default gen_random_uuid(),
  country_code char(2) not null,
  region_code text not null,
  locality text,
  home_kitchens_enabled boolean not null default false,
  legal_reviewed_at timestamptz,
  rules_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint jurisdictions_country_code_format check (country_code ~ '^[A-Z]{2}$'),
  constraint jurisdictions_region_code_length check (char_length(btrim(region_code)) between 1 and 80),
  constraint jurisdictions_locality_length check (locality is null or char_length(btrim(locality)) between 1 and 120),
  constraint jurisdictions_rules_url_length check (rules_url is null or char_length(rules_url) <= 2048),
  unique nulls not distinct (country_code, region_code, locality)
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  public_id uuid not null default gen_random_uuid() unique,
  username public.citext not null unique,
  display_name text not null,
  avatar_path text,
  status text not null default 'active' check (status in ('active', 'restricted', 'suspended', 'deleted')),
  terms_accepted_at timestamptz,
  terms_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_username_length check (char_length(btrim(username::text)) between 1 and 24),
  constraint profiles_username_format check (username::text ~ '^[A-Za-z0-9_.-]+$'),
  constraint profiles_display_name_length check (char_length(btrim(display_name)) between 1 and 80),
  constraint profiles_avatar_path_length check (avatar_path is null or char_length(avatar_path) <= 512),
  constraint profiles_terms_version_length check (terms_version is null or char_length(terms_version) between 1 and 40)
);

create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  kind public.business_kind not null,
  name text not null,
  slug public.citext not null unique,
  description text not null default '',
  cuisine_labels text[] not null default '{}',
  price_level smallint not null default 2 check (price_level between 1 and 4),
  state public.business_state not null default 'draft',
  verification public.verification_state not null default 'unverified',
  timezone text not null default 'America/Los_Angeles',
  jurisdiction_id uuid references public.jurisdictions(id),
  logo_asset_id uuid,
  provenance text not null default 'owner' check (provenance in ('owner', 'community', 'licensed_provider')),
  provider_freshness_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint businesses_name_length check (char_length(btrim(name)) between 1 and 100),
  constraint businesses_description_length check (char_length(description) <= 2000),
  constraint businesses_slug_length check (char_length(slug::text) between 1 and 140),
  constraint businesses_slug_format check (slug::text ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint businesses_cuisine_count check (cardinality(cuisine_labels) <= 12),
  constraint businesses_timezone_length check (char_length(timezone) between 1 and 80),
  constraint businesses_home_jurisdiction check (kind <> 'home_kitchen' or jurisdiction_id is not null)
);

create table if not exists public.business_private_details (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  legal_name text,
  business_email public.citext,
  business_phone text,
  website_url text,
  submitted_address_line text,
  submitted_city text,
  submitted_region text,
  submitted_postal_code text,
  show_phone_public boolean not null default false,
  show_website_public boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint business_private_legal_name_length check (legal_name is null or char_length(legal_name) <= 160),
  constraint business_private_email_length check (business_email is null or char_length(business_email::text) <= 320),
  constraint business_private_phone_length check (business_phone is null or char_length(business_phone) <= 40),
  constraint business_private_phone_format check (
    business_phone is null
    or business_phone ~ '^\+?\(?[0-9][0-9 ()-]{5,30}( ?(x|ext\.?) ?[0-9]{1,8})?$'
  ),
  constraint business_private_website_length check (website_url is null or char_length(website_url) <= 2048),
  constraint business_private_website_https check (
    website_url is null or website_url ~* '^https://[A-Za-z0-9]'
  ),
  constraint business_private_address_length check (
    submitted_address_line is null or char_length(submitted_address_line) <= 300
  ),
  constraint business_private_city_length check (
    submitted_city is null or char_length(submitted_city) between 1 and 120
  ),
  constraint business_private_region_length check (
    submitted_region is null or char_length(submitted_region) between 1 and 80
  ),
  constraint business_private_postal_length check (
    submitted_postal_code is null or char_length(submitted_postal_code) <= 24
  )
);

create table if not exists private.business_verification_notes (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  notes text not null default '',
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint business_verification_notes_length check (char_length(notes) <= 10000)
);

create table if not exists public.business_members (
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null,
  status text not null default 'active' check (status in ('invited', 'active', 'revoked')),
  invited_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (business_id, user_id)
);

create index if not exists business_members_user_idx
  on public.business_members (user_id, status, business_id);

create table if not exists public.business_claims (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  claimant_id uuid not null references auth.users(id) on delete cascade,
  method text not null check (method in ('listed_phone', 'domain_email', 'document', 'permit')),
  evidence_private_path text,
  state text not null default 'pending' check (state in ('pending', 'approved', 'rejected', 'withdrawn')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint business_claims_evidence_path_length check (
    evidence_private_path is null or char_length(evidence_private_path) <= 512
  ),
  unique (business_id, claimant_id, state)
);

create or replace function private.require_business_claim_verification_receipt()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if new.state = 'approved' then
    raise exception using
      errcode = '55000',
      message = 'CLAIM_VERIFICATION_RECEIPT_REQUIRED';
  end if;
  return new;
end;
$$;

revoke all on function private.require_business_claim_verification_receipt()
  from public, anon, authenticated;

drop trigger if exists require_business_claim_verification_receipt
  on public.business_claims;
create trigger require_business_claim_verification_receipt
before insert or update of state on public.business_claims
for each row execute function private.require_business_claim_verification_receipt();

create table if not exists public.business_locations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  label text not null,
  address_line text,
  city text not null,
  region text not null,
  postal_code text,
  point public.geography(point, 4326) not null,
  is_primary boolean not null default false,
  is_approximate boolean not null default false,
  public_address boolean not null default true,
  publication_state public.location_publication_state not null default 'private',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_locations_label_length check (char_length(btrim(label)) between 1 and 120),
  constraint business_locations_address_length check (address_line is null or char_length(address_line) <= 300),
  constraint business_locations_city_length check (char_length(btrim(city)) between 1 and 120),
  constraint business_locations_region_length check (char_length(btrim(region)) between 1 and 80),
  constraint business_locations_postal_length check (postal_code is null or char_length(postal_code) <= 24),
  constraint business_locations_coordinate_bounds check (
    public.st_y(point::public.geometry) between -90 and 90
    and public.st_x(point::public.geometry) between -180 and 180
  ),
  unique (id, business_id)
);

create index if not exists business_locations_point_gix on public.business_locations using gist (point);
create index if not exists business_locations_business_idx on public.business_locations (business_id);
create unique index if not exists business_locations_one_primary_idx
  on public.business_locations (business_id)
  where is_primary and publication_state <> 'archived';

create table if not exists public.mobile_stops (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  location_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  state text not null default 'scheduled' check (state in ('draft', 'scheduled', 'live', 'completed', 'cancelled')),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mobile_stops_valid_window check (ends_at > starts_at),
  constraint mobile_stops_max_window check (ends_at <= starts_at + interval '7 days'),
  constraint mobile_stops_location_business_fkey
    foreign key (location_id, business_id)
    references public.business_locations(id, business_id)
    on delete cascade
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
  unique (business_id, service_date),
  constraint special_hours_valid check (
    (is_closed and opens_at is null and closes_at is null)
    or
    (not is_closed and opens_at is not null and closes_at is not null)
  ),
  constraint special_hours_note_length check (note is null or char_length(note) <= 240)
);

create table if not exists public.business_payments (
  business_id uuid not null references public.businesses(id) on delete cascade,
  payment public.payment_kind not null,
  primary key (business_id, payment)
);

create table if not exists public.business_updates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  author_id uuid references auth.users(id) on delete set null,
  kind public.update_kind not null,
  body text not null,
  starts_at timestamptz not null default now(),
  expires_at timestamptz not null,
  moderation public.moderation_state not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint menu_sections_name_length check (char_length(btrim(name)) between 1 and 80),
  constraint menu_sections_sort_range check (sort_order between -10000 and 10000)
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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint menu_items_name_length check (char_length(btrim(name)) between 1 and 120),
  constraint menu_items_description_length check (char_length(description) <= 1000),
  constraint menu_items_price_max check (price_minor <= 100000000),
  constraint menu_items_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint menu_items_dietary_count check (cardinality(dietary_tags) <= 12),
  constraint menu_items_allergen_length check (allergen_note is null or char_length(allergen_note) <= 500),
  constraint menu_items_sort_range check (sort_order between -10000 and 10000)
);

create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete cascade,
  storage_path text not null unique,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  width integer check (width between 1 and 8192),
  height integer check (height between 1 and 8192),
  byte_size bigint not null check (byte_size between 1 and 10485760),
  sha256 text,
  source text not null default 'owner_upload' check (source in ('owner_upload', 'review_upload', 'licensed_provider')),
  license_note text,
  quarantine_state text not null default 'uploaded'
    check (quarantine_state in ('uploaded', 'scanning', 'clean', 'rejected')),
  processed_storage_path text unique,
  scan_completed_at timestamptz,
  rejection_reason text,
  moderation public.moderation_state not null default 'pending',
  created_at timestamptz not null default now(),
  constraint media_assets_storage_path_length check (char_length(storage_path) between 1 and 512),
  constraint media_assets_processed_path_length check (
    processed_storage_path is null or char_length(processed_storage_path) <= 512
  ),
  constraint media_assets_sha256_format check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  constraint media_assets_license_note_length check (license_note is null or char_length(license_note) <= 1000),
  constraint media_assets_rejection_reason_length check (
    rejection_reason is null or char_length(rejection_reason) <= 1000
  ),
  constraint media_assets_clean_metadata check (
    quarantine_state <> 'clean'
    or (
      processed_storage_path is not null
      and scan_completed_at is not null
      and width is not null
      and height is not null
      and sha256 is not null
    )
  ),
  constraint media_assets_approval_requires_clean check (
    moderation <> 'approved' or quarantine_state = 'clean'
  )
);

alter table public.businesses
  drop constraint if exists businesses_logo_asset_id_fkey;
alter table public.businesses
  add constraint businesses_logo_asset_id_fkey
  foreign key (logo_asset_id) references public.media_assets(id) on delete set null;

create table if not exists public.business_media_links (
  business_id uuid not null references public.businesses(id) on delete cascade,
  asset_id uuid not null references public.media_assets(id) on delete cascade,
  media_role text not null default 'gallery' check (media_role = 'gallery'),
  sort_order smallint not null check (sort_order between 0 and 11),
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (business_id, asset_id),
  unique (business_id, sort_order)
);

create index if not exists business_media_links_asset_idx
  on public.business_media_links (asset_id, business_id);

create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  body text not null,
  moderation public.moderation_state not null default 'pending',
  helpful_count integer not null default 0 check (helpful_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint reviews_body_length check (char_length(btrim(body)) between 1 and 2000),
  unique (business_id, author_id),
  unique (id, business_id)
);

create table if not exists public.review_media (
  review_id uuid not null references public.reviews(id) on delete cascade,
  asset_id uuid not null references public.media_assets(id) on delete cascade,
  sort_order smallint not null default 0 check (sort_order between 0 and 3),
  primary key (review_id, asset_id),
  unique (review_id, sort_order)
);

create table if not exists public.business_responses (
  review_id uuid primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  author_id uuid references auth.users(id) on delete set null,
  body text not null,
  moderation public.moderation_state not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_responses_body_length check (char_length(btrim(body)) between 1 and 1000),
  constraint business_responses_review_business_fkey
    foreign key (review_id, business_id)
    references public.reviews(id, business_id)
    on delete cascade
);

create table if not exists public.follows (
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  created_at timestamptz not null default now(),
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
  updated_at timestamptz not null default now(),
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
  created_at timestamptz not null default now(),
  constraint content_reports_reason_valid check (
    reason in (
      'spam',
      'harassment',
      'hate',
      'sexual',
      'violence',
      'fraud',
      'privacy',
      'illegal',
      'unsafe',
      'other'
    )
  ),
  constraint content_reports_detail_length check (detail is null or char_length(detail) <= 2000),
  constraint content_reports_reporter_id_target_type_target_id_key
    unique (reporter_id, target_type, target_id)
);

create table if not exists public.user_blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
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

create table if not exists public.home_kitchen_permits (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  jurisdiction_id uuid not null references public.jurisdictions(id),
  permit_number_private text not null,
  issuer text,
  expires_on date,
  verification public.verification_state not null default 'pending',
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  constraint home_kitchen_permits_number_length check (char_length(permit_number_private) between 1 and 160),
  constraint home_kitchen_permits_issuer_length check (
    issuer is null or char_length(btrim(issuer)) between 1 and 160
  ),
  constraint home_kitchen_permits_verified_complete check (
    verification <> 'verified'
    or (issuer is not null and expires_on is not null and reviewed_at is not null)
  )
);

create table if not exists public.business_live_status (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  status public.live_business_status not null,
  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint business_live_status_expiry check (
    expires_at > confirmed_at and expires_at <= confirmed_at + interval '24 hours'
  )
);

create table if not exists public.business_public_events (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  event_type text not null
    check (event_type in ('live_status', 'owner_update', 'mobile_stop', 'menu_availability')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  constraint business_public_events_payload_size
    check (octet_length(payload::text) <= 8192),
  constraint business_public_events_expiry
    check (expires_at > created_at and expires_at <= created_at + interval '7 days')
);

create index if not exists business_public_events_business_time_idx
  on public.business_public_events (business_id, created_at desc);

create index if not exists business_public_events_expiry_idx
  on public.business_public_events (expires_at);

create table if not exists private.platform_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.platform_role not null,
  active boolean not null default true,
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table if not exists private.rate_limit_buckets (
  actor_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  bucket_started_at timestamptz not null,
  request_count integer not null default 1 check (request_count > 0),
  primary key (actor_id, action, bucket_started_at),
  constraint rate_limit_action_length check (char_length(action) between 1 and 80)
);

create index if not exists rate_limit_buckets_cleanup_idx
  on private.rate_limit_buckets (bucket_started_at);

create table if not exists private.rpc_idempotency (
  actor_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  request_hash text not null,
  response_id uuid not null references public.businesses(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (actor_id, action, request_hash),
  constraint rpc_idempotency_action_length check (char_length(action) between 1 and 80),
  constraint rpc_idempotency_hash_format check (request_hash ~ '^[0-9a-f]{64}$')
);

create index if not exists rpc_idempotency_created_idx
  on private.rpc_idempotency (created_at);

-- Generic mutation receipts make retrying create/transfer RPCs safe without
-- coupling every response to the businesses table. Only hashes are persisted.
create table if not exists private.action_idempotency_receipts (
  actor_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  idempotency_key_hash text not null,
  request_hash text not null,
  response_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (actor_id, action, idempotency_key_hash),
  constraint action_idempotency_action_length
    check (char_length(action) between 1 and 80),
  constraint action_idempotency_key_hash_format
    check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  constraint action_idempotency_request_hash_format
    check (request_hash ~ '^[0-9a-f]{64}$')
);

create index if not exists action_idempotency_receipts_created_idx
  on private.action_idempotency_receipts (created_at);

create table if not exists private.account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  request_fingerprint text not null unique,
  state text not null default 'started'
    check (state in ('started', 'processing', 'storage_deleted', 'completed', 'failed')),
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  constraint account_deletion_requests_fingerprint_format
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint account_deletion_requests_failure_code_length
    check (failure_code is null or char_length(failure_code) between 1 and 80),
  constraint account_deletion_requests_expiry
    check (expires_at > created_at and expires_at <= created_at + interval '7 days')
);

create index if not exists account_deletion_requests_expiry_idx
  on private.account_deletion_requests (expires_at);

-- Published listing edits are intentionally staged instead of directly mutating the
-- live directory. A later operator workflow may approve these patches after verifying
-- business identity and field-level evidence; no client role can apply them directly.
create table if not exists private.business_revision_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  requested_by uuid references auth.users(id) on delete set null,
  base_updated_at timestamptz not null,
  proposed_patch jsonb not null,
  state text not null default 'pending'
    check (state in ('pending', 'approved', 'rejected', 'withdrawn')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_revision_patch_object
    check (jsonb_typeof(proposed_patch) = 'object'),
  constraint business_revision_patch_size
    check (octet_length(proposed_patch::text) <= 32768),
  constraint business_revision_reason_length
    check (review_reason is null or char_length(review_reason) <= 1000)
);

create unique index if not exists business_revision_one_pending_idx
  on private.business_revision_requests (business_id, requested_by)
  where state = 'pending';

-- Invitations are deliberately private because their target can be an email
-- address. Public RPCs return only a masked hint and never reveal whether the
-- supplied email or username currently belongs to an account.
create table if not exists private.business_invitations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  target_type text not null check (target_type in ('email', 'username')),
  target_normalized public.citext not null,
  target_hint text not null,
  target_user_id uuid references auth.users(id) on delete set null,
  role public.member_role not null check (role in ('manager', 'staff')),
  state text not null default 'pending'
    check (state in ('pending', 'accepted', 'declined', 'revoked', 'expired')),
  invited_by uuid references auth.users(id) on delete set null,
  accepted_by uuid references auth.users(id) on delete set null,
  responded_at timestamptz,
  expires_at timestamptz not null default (now() + interval '14 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_invitations_target_length
    check (char_length(target_normalized::text) between 1 and 320),
  constraint business_invitations_hint_length
    check (char_length(target_hint) between 1 and 160),
  constraint business_invitations_expiry
    check (expires_at > created_at and expires_at <= created_at + interval '30 days'),
  constraint business_invitations_response_shape check (
    (state = 'pending' and accepted_by is null and responded_at is null)
    or (state = 'accepted' and accepted_by is not null and responded_at is not null)
    or (state in ('declined', 'revoked', 'expired') and accepted_by is null and responded_at is not null)
  )
);

create unique index if not exists business_invitations_one_pending_target_idx
  on private.business_invitations (business_id, target_type, target_normalized)
  where state = 'pending';

create index if not exists business_invitations_target_user_idx
  on private.business_invitations (target_user_id, state, expires_at);

create index if not exists business_invitations_business_state_idx
  on private.business_invitations (business_id, state, created_at desc);

-- Licensed-provider configuration and source records are private by design.
-- They can contain contract metadata, provider identifiers, contact details,
-- and exact locations that must never be exposed through the Data API.
create or replace function private.provider_signing_key_ids_valid(candidate text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select cardinality(candidate) between 1 and 8
    and count(*) = count(key_id)
    and count(*) = count(distinct key_id)
    and coalesce(
      bool_and(key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
      false
    )
  from unnest(candidate) key_id;
$$;

revoke all on function private.provider_signing_key_ids_valid(text[]) from public;

create table if not exists private.provider_accounts (
  provider_slug text primary key,
  enabled boolean not null default false,
  requests_per_minute integer not null default 60,
  stale_after interval not null default interval '7 days',
  archive_after interval not null default interval '90 days',
  auto_publish boolean not null default false,
  license_agreement_id text not null,
  license_effective_on date not null,
  license_expires_on date not null,
  allowed_field_classes text[] not null,
  accepted_signing_key_ids text[] not null,
  retention_terms text not null,
  deletion_terms text not null,
  configuration_version text not null,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint provider_accounts_slug_format
    check (provider_slug ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  constraint provider_accounts_request_limit
    check (requests_per_minute between 1 and 600),
  constraint provider_accounts_stale_window
    check (stale_after >= interval '1 day'),
  constraint provider_accounts_archive_window
    check (archive_after > stale_after),
  constraint provider_accounts_license_window
    check (license_expires_on >= license_effective_on),
  constraint provider_accounts_license_id_length
    check (char_length(license_agreement_id) between 1 and 160),
  constraint provider_accounts_configuration_version_length
    check (char_length(configuration_version) between 1 and 80),
  constraint provider_accounts_retention_terms_length
    check (char_length(retention_terms) between 1 and 4000),
  constraint provider_accounts_deletion_terms_length
    check (char_length(deletion_terms) between 1 and 4000),
  constraint provider_accounts_field_classes_valid check (
    cardinality(allowed_field_classes) between 1 and 7
    and allowed_field_classes <@ array[
      'profile',
      'contact',
      'locations',
      'hours',
      'payments',
      'menu',
      'source_url'
    ]::text[]
  ),
  constraint provider_accounts_signing_keys_valid check (
    private.provider_signing_key_ids_valid(accepted_signing_key_ids)
  )
);

create table if not exists private.provider_ingest_receipts (
  provider_slug text not null
    references private.provider_accounts(provider_slug) on delete restrict,
  idempotency_key_hash text not null,
  request_sha256 text not null,
  batch_id text not null,
  status text not null default 'processing'
    check (status in ('processing', 'completed')),
  safe_response jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (provider_slug, idempotency_key_hash),
  constraint provider_ingest_receipts_key_hash_format
    check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  constraint provider_ingest_receipts_request_hash_format
    check (request_sha256 ~ '^[0-9a-f]{64}$'),
  constraint provider_ingest_receipts_batch_id_length
    check (char_length(batch_id) between 16 and 128),
  constraint provider_ingest_receipts_completion_shape check (
    (status = 'processing' and safe_response is null and completed_at is null)
    or (
      status = 'completed'
      and jsonb_typeof(safe_response) = 'object'
      and completed_at is not null
    )
  )
);

create index if not exists provider_ingest_receipts_created_idx
  on private.provider_ingest_receipts (created_at);

create table if not exists private.provider_rate_limit_buckets (
  provider_slug text not null
    references private.provider_accounts(provider_slug) on delete cascade,
  signing_key_id text not null,
  window_started_at timestamptz not null,
  request_count integer not null default 1 check (request_count > 0),
  primary key (provider_slug, signing_key_id, window_started_at),
  constraint provider_rate_limit_key_id_length
    check (char_length(signing_key_id) between 1 and 64)
);

create index if not exists provider_rate_limit_buckets_cleanup_idx
  on private.provider_rate_limit_buckets (window_started_at);

create table if not exists private.provider_snapshot_sessions (
  provider_slug text not null
    references private.provider_accounts(provider_slug) on delete cascade,
  snapshot_id text not null,
  first_generated_at timestamptz not null,
  last_generated_at timestamptz not null,
  next_page_index integer not null default 0 check (next_page_index >= 0),
  final_page_received boolean not null default false,
  seen_record_count integer not null default 0 check (seen_record_count >= 0),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (provider_slug, snapshot_id),
  constraint provider_snapshot_id_length
    check (char_length(snapshot_id) between 16 and 128),
  constraint provider_snapshot_completion_shape check (
    (not final_page_received and completed_at is null)
    or (final_page_received and completed_at is not null)
  )
);

create unique index if not exists provider_snapshot_one_open_idx
  on private.provider_snapshot_sessions (provider_slug)
  where not final_page_received;

create index if not exists provider_snapshot_sessions_completed_idx
  on private.provider_snapshot_sessions (completed_at);

create table if not exists private.provider_ingest_batches (
  id uuid primary key default gen_random_uuid(),
  provider_slug text not null
    references private.provider_accounts(provider_slug) on delete restrict,
  receipt_key_hash text not null,
  signing_key_id text not null,
  batch_id text not null,
  request_sha256 text not null,
  generated_at timestamptz not null,
  sync_mode text not null check (sync_mode in ('delta', 'snapshot')),
  snapshot_id text,
  page_index integer,
  final_page boolean,
  accepted_records integer not null check (accepted_records between 0 and 100),
  inactive_records integer not null check (inactive_records between 0 and 100),
  status text not null default 'applied' check (status = 'applied'),
  created_at timestamptz not null default now(),
  completed_at timestamptz not null default now(),
  constraint provider_ingest_batches_request_hash_format
    check (request_sha256 ~ '^[0-9a-f]{64}$'),
  constraint provider_ingest_batches_receipt_hash_format
    check (receipt_key_hash ~ '^[0-9a-f]{64}$'),
  constraint provider_ingest_batches_counts
    check (accepted_records + inactive_records between 1 and 100),
  constraint provider_ingest_batches_sync_shape check (
    (
      sync_mode = 'delta'
      and snapshot_id is null
      and page_index is null
      and final_page is null
    )
    or (
      sync_mode = 'snapshot'
      and char_length(snapshot_id) between 16 and 128
      and page_index >= 0
      and final_page is not null
    )
  ),
  unique (provider_slug, receipt_key_hash)
);

create unique index if not exists provider_ingest_batches_snapshot_page_idx
  on private.provider_ingest_batches (provider_slug, snapshot_id, page_index)
  where sync_mode = 'snapshot';

create table if not exists private.provider_business_sources (
  provider_slug text not null
    references private.provider_accounts(provider_slug) on delete restrict,
  provider_external_id text not null,
  business_id uuid references public.businesses(id) on delete set null,
  source_status text not null default 'active'
    check (source_status in ('active', 'missing', 'stale', 'inactive')),
  source_updated_at timestamptz not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  missing_since timestamptz,
  inactive_at timestamptz,
  source_url text,
  license_agreement_id text not null,
  normalized_payload_hash text not null,
  inactive_reason text,
  primary key (provider_slug, provider_external_id),
  constraint provider_business_source_external_id_format
    check (provider_external_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
  constraint provider_business_source_hash_format
    check (normalized_payload_hash ~ '^[0-9a-f]{64}$'),
  constraint provider_business_source_url_length
    check (source_url is null or char_length(source_url) <= 2048),
  constraint provider_business_source_inactive_reason
    check (
      inactive_reason is null
      or inactive_reason in ('closed', 'removed_by_provider', 'duplicate', 'unknown')
    ),
  constraint provider_business_source_state_shape check (
    (source_status = 'active' and missing_since is null and inactive_at is null)
    or (source_status in ('missing', 'stale') and missing_since is not null and inactive_at is null)
    or (source_status = 'inactive' and inactive_at is not null)
  )
);

create index if not exists provider_business_sources_business_idx
  on private.provider_business_sources (business_id, source_status);
create index if not exists provider_business_sources_lifecycle_idx
  on private.provider_business_sources (
    provider_slug,
    source_status,
    missing_since,
    inactive_at
  );

create table if not exists private.provider_location_sources (
  provider_slug text not null,
  business_external_id text not null,
  location_external_id text not null,
  materialized_location_id uuid
    references public.business_locations(id) on delete set null,
  source_status text not null default 'active'
    check (source_status in ('active', 'missing', 'stale', 'inactive')),
  source_updated_at timestamptz not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  missing_since timestamptz,
  inactive_at timestamptz,
  source_url text,
  license_agreement_id text not null,
  normalized_payload jsonb not null,
  normalized_payload_hash text not null,
  primary key (provider_slug, business_external_id, location_external_id),
  foreign key (provider_slug, business_external_id)
    references private.provider_business_sources(provider_slug, provider_external_id)
    on delete cascade,
  constraint provider_location_source_external_id_format
    check (location_external_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
  constraint provider_location_source_payload_object
    check (jsonb_typeof(normalized_payload) = 'object'),
  constraint provider_location_source_hash_format
    check (normalized_payload_hash ~ '^[0-9a-f]{64}$')
);

create table if not exists private.provider_menu_section_sources (
  provider_slug text not null,
  business_external_id text not null,
  section_external_id text not null,
  materialized_section_id uuid
    references public.menu_sections(id) on delete set null,
  source_status text not null default 'active'
    check (source_status in ('active', 'missing', 'stale', 'inactive')),
  source_updated_at timestamptz not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  missing_since timestamptz,
  inactive_at timestamptz,
  source_url text,
  license_agreement_id text not null,
  normalized_payload jsonb not null,
  normalized_payload_hash text not null,
  primary key (provider_slug, business_external_id, section_external_id),
  foreign key (provider_slug, business_external_id)
    references private.provider_business_sources(provider_slug, provider_external_id)
    on delete cascade,
  constraint provider_menu_section_external_id_format
    check (section_external_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
  constraint provider_menu_section_payload_object
    check (jsonb_typeof(normalized_payload) = 'object'),
  constraint provider_menu_section_hash_format
    check (normalized_payload_hash ~ '^[0-9a-f]{64}$')
);

create table if not exists private.provider_menu_item_sources (
  provider_slug text not null,
  business_external_id text not null,
  section_external_id text not null,
  item_external_id text not null,
  materialized_item_id uuid
    references public.menu_items(id) on delete set null,
  source_status text not null default 'active'
    check (source_status in ('active', 'missing', 'stale', 'inactive')),
  source_updated_at timestamptz not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  missing_since timestamptz,
  inactive_at timestamptz,
  source_url text,
  license_agreement_id text not null,
  normalized_payload jsonb not null,
  normalized_payload_hash text not null,
  primary key (
    provider_slug,
    business_external_id,
    section_external_id,
    item_external_id
  ),
  foreign key (provider_slug, business_external_id, section_external_id)
    references private.provider_menu_section_sources(
      provider_slug,
      business_external_id,
      section_external_id
    )
    on delete cascade,
  constraint provider_menu_item_external_id_format
    check (item_external_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
  constraint provider_menu_item_payload_object
    check (jsonb_typeof(normalized_payload) = 'object'),
  constraint provider_menu_item_hash_format
    check (normalized_payload_hash ~ '^[0-9a-f]{64}$')
);

create table if not exists private.provider_source_history (
  id bigint generated always as identity primary key,
  ingest_batch_id uuid not null
    references private.provider_ingest_batches(id) on delete restrict,
  provider_slug text not null,
  provider_external_id text not null,
  source_updated_at timestamptz not null,
  record_status text not null check (record_status in ('active', 'inactive')),
  normalized_payload jsonb not null,
  normalized_payload_hash text not null,
  license_agreement_id text not null,
  recorded_at timestamptz not null default now(),
  constraint provider_source_history_payload_object
    check (jsonb_typeof(normalized_payload) = 'object'),
  constraint provider_source_history_hash_format
    check (normalized_payload_hash ~ '^[0-9a-f]{64}$'),
  unique (
    provider_slug,
    provider_external_id,
    source_updated_at,
    normalized_payload_hash
  )
);

create index if not exists provider_source_history_lookup_idx
  on private.provider_source_history (
    provider_slug,
    provider_external_id,
    source_updated_at desc
  );

create table if not exists private.provider_snapshot_seen (
  provider_slug text not null,
  snapshot_id text not null,
  provider_external_id text not null,
  first_seen_page integer not null check (first_seen_page >= 0),
  seen_at timestamptz not null default now(),
  primary key (provider_slug, snapshot_id, provider_external_id),
  foreign key (provider_slug, snapshot_id)
    references private.provider_snapshot_sessions(provider_slug, snapshot_id)
    on delete cascade
);

-- A provider may continue to refresh only fields it previously materialized.
-- A mismatched current hash, an active owner, or another provider converts the
-- field to owner precedence and future imports leave it untouched.
create table if not exists private.provider_field_materializations (
  business_id uuid not null references public.businesses(id) on delete cascade,
  field_name text not null,
  source_provider_slug text
    references private.provider_accounts(provider_slug) on delete restrict,
  source_external_id text,
  ownership text not null default 'provider'
    check (ownership in ('provider', 'owner')),
  source_value_hash text not null,
  materialized_value_hash text not null,
  materialized_at timestamptz not null default now(),
  overridden_at timestamptz,
  primary key (business_id, field_name),
  constraint provider_field_name_valid check (
    field_name in (
      'name',
      'kind',
      'description',
      'cuisine_labels',
      'price_level',
      'timezone',
      'website_url',
      'business_phone',
      'locations',
      'weekly_hours',
      'special_hours',
      'payments',
      'menu'
    )
  ),
  constraint provider_field_source_hash_format
    check (source_value_hash ~ '^[0-9a-f]{64}$'),
  constraint provider_field_materialized_hash_format
    check (materialized_value_hash ~ '^[0-9a-f]{64}$'),
  constraint provider_field_ownership_shape check (
    (
      ownership = 'provider'
      and source_provider_slug is not null
      and source_external_id is not null
      and overridden_at is null
    )
    or (ownership = 'owner' and overridden_at is not null)
  )
);

create table if not exists private.provider_ingest_audit_events (
  id bigint generated always as identity primary key,
  provider_slug text
    references private.provider_accounts(provider_slug) on delete set null,
  event_type text not null
    check (event_type in (
      'batch_applied',
      'batch_replayed',
      'snapshot_completed',
      'sources_marked_stale',
      'businesses_archived'
    )),
  batch_id_hash text,
  accepted_records integer,
  inactive_records integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint provider_ingest_audit_batch_hash_format
    check (batch_id_hash is null or batch_id_hash ~ '^[0-9a-f]{64}$'),
  constraint provider_ingest_audit_metadata_size
    check (octet_length(metadata::text) <= 8192)
);

create index if not exists provider_ingest_audit_time_idx
  on private.provider_ingest_audit_events (provider_slug, created_at desc);

create or replace function public.reconcile_licensed_provider_lifecycle(
  result_limit integer default 500
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  bounded_limit integer := greatest(1, least(coalesce(result_limit, 500), 2000));
  now_value timestamptz := pg_catalog.clock_timestamp();
  stale_marked integer := 0;
  archived_count integer := 0;
  backlog boolean := false;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('spottr:provider-lifecycle', 0)
  ) then
    return pg_catalog.jsonb_build_object(
      'sources_marked_stale', 0,
      'businesses_archived', 0,
      'more_work', true,
      'skipped', true
    );
  end if;

  with targets as materialized (
    select source.provider_slug, source.provider_external_id
    from private.provider_business_sources source
    join private.provider_accounts account
      on account.provider_slug = source.provider_slug
    where (
      source.source_status = 'missing'
      and source.missing_since <= now_value - account.stale_after
    ) or (
      source.source_status = 'active'
      and (
        not account.enabled
        or current_date not between account.license_effective_on
          and account.license_expires_on
      )
    )
    order by
      coalesce(source.missing_since, source.last_seen_at),
      source.provider_slug,
      source.provider_external_id
    limit bounded_limit
    for update of source skip locked
  ), updated as (
    update private.provider_business_sources source
    set source_status = 'stale',
        missing_since = coalesce(source.missing_since, now_value),
        inactive_at = null,
        inactive_reason = null
    from targets
    where source.provider_slug = targets.provider_slug
      and source.provider_external_id = targets.provider_external_id
    returning source.provider_slug
  ), audited as (
    insert into private.provider_ingest_audit_events (
      provider_slug,
      event_type,
      metadata
    )
    select
      updated.provider_slug,
      'sources_marked_stale',
      pg_catalog.jsonb_build_object('count', count(*)::integer)
    from updated
    group by updated.provider_slug
    returning 1
  )
  select count(*)::integer into stale_marked from updated;

  with targets as materialized (
    select business.id
    from public.businesses business
    where business.state = 'published'
      and business.provenance = 'licensed_provider'
      and exists (
        select 1
        from private.provider_business_sources source
        where source.business_id = business.id
      )
      and not exists (
        select 1
        from public.business_members member
        where member.business_id = business.id
          and member.status = 'active'
      )
      and not exists (
        select 1
        from public.business_claims claim
        where claim.business_id = business.id
          and claim.state = 'approved'
      )
      and not exists (
        select 1
        from private.provider_business_sources source
        join private.provider_accounts account
          on account.provider_slug = source.provider_slug
        where source.business_id = business.id
          and (
            source.source_status = 'active'
            or (
              source.source_status in ('missing', 'stale')
              and source.missing_since > now_value - account.archive_after
            )
            or (
              source.source_status = 'inactive'
              and source.inactive_at > now_value - account.archive_after
            )
          )
      )
    order by business.updated_at, business.id
    limit bounded_limit
    for update of business skip locked
  ), archived as (
    update public.businesses business
    set state = 'archived'
    from targets
    where business.id = targets.id
    returning business.id
  ), audited as (
    insert into private.provider_ingest_audit_events (
      provider_slug,
      event_type,
      metadata
    )
    select
      null,
      'businesses_archived',
      pg_catalog.jsonb_build_object('count', count(*)::integer)
    from archived
    having count(*) > 0
    returning 1
  )
  select count(*)::integer into archived_count from archived;

  select exists (
    select 1
    from private.provider_business_sources source
    join private.provider_accounts account
      on account.provider_slug = source.provider_slug
    where (
      source.source_status = 'missing'
      and source.missing_since <= now_value - account.stale_after
    ) or (
      source.source_status = 'active'
      and (
        not account.enabled
        or current_date not between account.license_effective_on
          and account.license_expires_on
      )
    )
  ) or exists (
    select 1
    from public.businesses business
    where business.state = 'published'
      and business.provenance = 'licensed_provider'
      and exists (
        select 1
        from private.provider_business_sources source
        where source.business_id = business.id
      )
      and not exists (
        select 1 from public.business_members member
        where member.business_id = business.id and member.status = 'active'
      )
      and not exists (
        select 1 from public.business_claims claim
        where claim.business_id = business.id and claim.state = 'approved'
      )
      and not exists (
        select 1
        from private.provider_business_sources source
        join private.provider_accounts account
          on account.provider_slug = source.provider_slug
        where source.business_id = business.id
          and (
            source.source_status = 'active'
            or (
              source.source_status in ('missing', 'stale')
              and source.missing_since > now_value - account.archive_after
            )
            or (
              source.source_status = 'inactive'
              and source.inactive_at > now_value - account.archive_after
            )
          )
      )
  ) into backlog;

  return pg_catalog.jsonb_build_object(
    'sources_marked_stale', stale_marked,
    'businesses_archived', archived_count,
    'more_work', backlog,
    'skipped', false
  );
end;
$$;

revoke all on function public.reconcile_licensed_provider_lifecycle(integer)
  from public, anon, authenticated;
grant execute on function public.reconcile_licensed_provider_lifecycle(integer)
  to service_role;

create table if not exists public.audit_events (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  business_id uuid references public.businesses(id) on delete set null,
  event_type text not null,
  target_type text not null,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint audit_events_event_type_length check (char_length(event_type) between 1 and 120),
  constraint audit_events_target_type_length check (char_length(target_type) between 1 and 80),
  constraint audit_events_metadata_size check (octet_length(metadata::text) <= 32768)
);

create index if not exists audit_events_business_time_idx on public.audit_events (business_id, created_at desc);

-- High-cardinality marketplace access paths. These cover public directory
-- filtering, aggregate lookups, owner queues, menu hydration, media moderation,
-- and mobile-stop selection without exposing additional columns.
create index if not exists businesses_public_directory_idx
  on public.businesses (state, kind, updated_at desc);
create index if not exists businesses_name_trgm_idx
  on public.businesses using gin (lower(name) gin_trgm_ops);
create index if not exists businesses_description_trgm_idx
  on public.businesses using gin (lower(description) gin_trgm_ops);
create index if not exists businesses_name_lower_pattern_idx
  on public.businesses (lower(name) text_pattern_ops);
create index if not exists businesses_cuisine_labels_gin
  on public.businesses using gin (cuisine_labels);
create index if not exists business_claims_claimant_state_idx
  on public.business_claims (claimant_id, state, created_at desc);
create index if not exists business_locations_city_trgm_idx
  on public.business_locations using gin (lower(city) gin_trgm_ops);
create index if not exists business_locations_region_trgm_idx
  on public.business_locations using gin (lower(region) gin_trgm_ops);
create index if not exists business_locations_city_lower_pattern_idx
  on public.business_locations (lower(city) text_pattern_ops);
create index if not exists business_locations_region_lower_pattern_idx
  on public.business_locations (lower(region) text_pattern_ops);
create index if not exists business_locations_postal_idx
  on public.business_locations (lower(postal_code))
  where postal_code is not null;
create index if not exists business_locations_postal_pattern_idx
  on public.business_locations (lower(postal_code) text_pattern_ops)
  where postal_code is not null;
create index if not exists mobile_stops_location_state_time_idx
  on public.mobile_stops (location_id, state, starts_at, ends_at);
create index if not exists weekly_hours_business_weekday_idx
  on public.weekly_hours (business_id, weekday);
create index if not exists special_hours_business_date_idx
  on public.special_hours (business_id, service_date);
create index if not exists menu_sections_business_publish_sort_idx
  on public.menu_sections (business_id, is_published, sort_order, id);
create index if not exists menu_items_section_publish_sort_idx
  on public.menu_items (section_id, is_published, sort_order, id);
create index if not exists media_assets_business_public_idx
  on public.media_assets (business_id, moderation, quarantine_state, created_at desc)
  where business_id is not null;
create index if not exists media_assets_owner_queue_idx
  on public.media_assets (owner_id, quarantine_state, moderation, created_at desc);
create index if not exists media_assets_processed_path_idx
  on public.media_assets (processed_storage_path)
  where processed_storage_path is not null;
create index if not exists reviews_business_public_idx
  on public.reviews (business_id, moderation, deleted_at, created_at desc)
  include (rating);
create index if not exists reviews_author_time_idx
  on public.reviews (author_id, created_at desc);
create index if not exists review_media_asset_idx
  on public.review_media (asset_id, review_id);
create index if not exists business_responses_business_idx
  on public.business_responses (business_id, moderation, created_at desc);
create index if not exists follows_business_time_idx
  on public.follows (business_id, created_at desc);
create index if not exists notification_preferences_business_idx
  on public.notification_preferences (business_id, user_id);
create index if not exists user_blocks_blocked_idx
  on public.user_blocks (blocked_id, blocker_id);
create index if not exists provider_links_business_idx
  on public.provider_links (business_id);
create index if not exists live_status_expiry_idx
  on public.business_live_status (expires_at, business_id);

create or replace function private.has_aal2()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
$$;

create or replace function private.require_aal2()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_aal2() then
    raise exception using errcode = '42501', message = 'AAL2_REQUIRED';
  end if;
end;
$$;

create or replace function private.is_active_user(target_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select target_user_id is not null
    and exists (
      select 1
      from public.profiles p
      join auth.users u on u.id = p.user_id
      where p.user_id = target_user_id
        and p.status = 'active'
        and p.terms_accepted_at is not null
        and u.email_confirmed_at is not null
    );
$$;

create or replace function private.is_business_member(
  target_business_id uuid,
  target_user_id uuid default auth.uid(),
  allowed_roles public.member_role[] default array['owner', 'manager', 'staff']::public.member_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_active_user(target_user_id)
    and exists (
      select 1
      from public.business_members bm
      where bm.business_id = target_business_id
        and bm.user_id = target_user_id
        and bm.status = 'active'
        and bm.role = any(allowed_roles)
    );
$$;

create or replace function public.is_business_member(
  target_business_id uuid,
  allowed_roles public.member_role[] default array['owner', 'manager', 'staff']::public.member_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_business_member(target_business_id, auth.uid(), allowed_roles);
$$;

revoke all on function public.is_business_member(uuid, public.member_role[]) from public;
grant execute on function public.is_business_member(uuid, public.member_role[]) to authenticated;

create or replace function private.can_manage_business_draft(
  target_business_id uuid,
  target_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_business_member(
    target_business_id,
    target_user_id,
    array['owner', 'manager']::public.member_role[]
  )
  and private.has_aal2()
  and exists (
    select 1
    from public.businesses b
    where b.id = target_business_id
      and b.state = 'draft'
  );
$$;

create or replace function private.is_platform_staff(
  target_user_id uuid default auth.uid(),
  allowed_roles public.platform_role[] default array['moderator', 'admin']::public.platform_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_active_user(target_user_id)
    and exists (
      select 1
      from private.platform_roles pr
      where pr.user_id = target_user_id
        and pr.active
        and pr.role = any(allowed_roles)
    );
$$;

create or replace function private.is_business_publicly_eligible(target_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.businesses b
    where b.id = target_business_id
      and b.state = 'published'
      and (
        b.provenance <> 'licensed_provider'
        or exists (
          select 1
          from private.provider_business_sources source
          join private.provider_accounts account
            on account.provider_slug = source.provider_slug
          where source.business_id = b.id
            and source.source_status = 'active'
            and account.enabled
            and current_date between account.license_effective_on
              and account.license_expires_on
        )
      )
      and (
        b.kind <> 'home_kitchen'
        or (
          b.verification = 'verified'
          and exists (
            select 1
            from public.jurisdictions j
            join public.home_kitchen_permits hp
              on hp.jurisdiction_id = j.id
             and hp.business_id = b.id
            where j.id = b.jurisdiction_id
              and j.home_kitchens_enabled
              and j.legal_reviewed_at is not null
              and hp.verification = 'verified'
              and hp.expires_on >= current_date
          )
        )
      )
  );
$$;

revoke all on function private.is_business_publicly_eligible(uuid)
  from public, anon, authenticated;
grant execute on function private.is_business_publicly_eligible(uuid)
  to anon, authenticated;

create or replace function private.time_window_is_open(
  opens_at time,
  closes_at time,
  local_time time
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select opens_at is not null
    and closes_at is not null
    and (
      (opens_at < closes_at and local_time >= opens_at and local_time < closes_at)
      or
      (opens_at > closes_at and (local_time >= opens_at or local_time < closes_at))
      or
      (opens_at = closes_at)
    );
$$;

create or replace function private.business_effective_status(
  target_business_id uuid,
  target_timezone text
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  manual_status public.live_business_status;
  target_kind public.business_kind;
  local_timestamp timestamp;
  local_date date;
  local_time time;
  local_weekday smallint;
  previous_date date;
  previous_weekday smallint;
  schedule_opens time;
  schedule_closes time;
  schedule_closed boolean;
  previous_opens time;
  previous_closes time;
  previous_closed boolean;
begin
  select bls.status
  into manual_status
  from public.business_live_status bls
  where bls.business_id = target_business_id
    and bls.expires_at > now();

  if manual_status is not null then
    return manual_status::text;
  end if;

  select b.kind
  into target_kind
  from public.businesses b
  where b.id = target_business_id;

  if target_kind in ('food_truck', 'pop_up') then
    if exists (
      select 1
      from public.mobile_stops ms
      where ms.business_id = target_business_id
        and ms.state in ('scheduled', 'live')
        and now() >= ms.starts_at
        and now() < ms.ends_at
    ) then
      return 'open';
    end if;
    if exists (
      select 1
      from public.mobile_stops ms
      where ms.business_id = target_business_id
        and ms.state = 'scheduled'
        and ms.starts_at > now()
        and ms.starts_at <= now() + interval '60 minutes'
    ) then
      return 'opening_soon';
    end if;
  end if;

  local_timestamp := now() at time zone target_timezone;
  local_date := local_timestamp::date;
  local_time := local_timestamp::time;
  local_weekday := extract(dow from local_timestamp)::smallint;
  previous_date := local_date - 1;
  previous_weekday := ((local_weekday + 6) % 7)::smallint;

  select sh.opens_at, sh.closes_at, sh.is_closed
  into schedule_opens, schedule_closes, schedule_closed
  from public.special_hours sh
  where sh.business_id = target_business_id
    and sh.service_date = local_date;

  if not found then
    select wh.opens_at, wh.closes_at, wh.is_closed
    into schedule_opens, schedule_closes, schedule_closed
    from public.weekly_hours wh
    where wh.business_id = target_business_id
      and wh.weekday = local_weekday;
  end if;

  if coalesce(schedule_closed, false) then
    return 'closed';
  end if;
  if schedule_opens is not null
    and schedule_closes is not null
    and (
      (schedule_opens < schedule_closes and local_time >= schedule_opens and local_time < schedule_closes)
      or (schedule_opens > schedule_closes and local_time >= schedule_opens)
      or schedule_opens = schedule_closes
    )
  then
    return 'open';
  end if;

  select sh.opens_at, sh.closes_at, sh.is_closed
  into previous_opens, previous_closes, previous_closed
  from public.special_hours sh
  where sh.business_id = target_business_id
    and sh.service_date = previous_date;

  if not found then
    select wh.opens_at, wh.closes_at, wh.is_closed
    into previous_opens, previous_closes, previous_closed
    from public.weekly_hours wh
    where wh.business_id = target_business_id
      and wh.weekday = previous_weekday;
  end if;

  if not coalesce(previous_closed, true)
    and previous_opens > previous_closes
    and local_time < previous_closes
  then
    return 'open';
  end if;

  if schedule_opens is not null
    and schedule_opens > local_time
    and schedule_opens <= local_time + interval '60 minutes'
  then
    return 'opening_soon';
  end if;

  return case when schedule_closed is null then 'unknown' else 'closed' end;
end;
$$;

create or replace function private.users_are_blocked(first_user_id uuid, second_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select first_user_id is not null
    and second_user_id is not null
    and exists (
      select 1
      from public.user_blocks ub
      where (ub.blocker_id = first_user_id and ub.blocked_id = second_user_id)
         or (ub.blocker_id = second_user_id and ub.blocked_id = first_user_id)
  );
$$;

create or replace function private.is_published_business_location(
  target_location_id uuid,
  target_business_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.business_locations bl
    where bl.id = target_location_id
      and bl.business_id = target_business_id
      and bl.publication_state = 'published'
  );
$$;

create or replace function private.is_media_publicly_eligible(target_asset_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.media_assets ma
    where ma.id = target_asset_id
      and ma.moderation = 'approved'
      and ma.quarantine_state = 'clean'
      and ma.processed_storage_path is not null
      and (
        (
          ma.business_id is not null
          and private.is_business_publicly_eligible(ma.business_id)
        )
        or exists (
          select 1
          from public.review_media rm
          join public.reviews r on r.id = rm.review_id
          where rm.asset_id = ma.id
            and r.moderation = 'approved'
            and r.deleted_at is null
            and private.is_business_publicly_eligible(r.business_id)
        )
        or exists (
          select 1
          from public.profiles p
          where p.avatar_path = ma.processed_storage_path
            and p.status = 'active'
        )
      )
  );
$$;

create or replace function private.consume_rate_limit(
  target_actor_id uuid,
  target_action text,
  max_requests integer,
  window_seconds integer
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  bucket_start timestamptz;
  accepted_count integer;
begin
  if target_actor_id is null
    or max_requests < 1
    or window_seconds < 1
    or char_length(target_action) not between 1 and 80
  then
    raise exception using errcode = '22023', message = 'Invalid rate-limit parameters';
  end if;

  bucket_start := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / window_seconds) * window_seconds
  );

  insert into private.rate_limit_buckets (
    actor_id,
    action,
    bucket_started_at,
    request_count
  )
  values (target_actor_id, target_action, bucket_start, 1)
  on conflict (actor_id, action, bucket_started_at)
  do update
    set request_count = private.rate_limit_buckets.request_count + 1
    where private.rate_limit_buckets.request_count < max_requests
  returning request_count into accepted_count;

  if accepted_count is null then
    raise exception using errcode = 'P0001', message = 'RATE_LIMITED';
  end if;
end;
$$;

create or replace function private.idempotency_key_hash(candidate text)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  normalized_key text := btrim(coalesce(candidate, ''));
begin
  if char_length(normalized_key) not between 16 and 128
    or normalized_key ~ '[^[:graph:]]'
  then
    raise exception using errcode = '22023', message = 'INVALID_IDEMPOTENCY_KEY';
  end if;

  return pg_catalog.encode(extensions.digest(normalized_key, 'sha256'), 'hex');
end;
$$;

create or replace function private.json_request_hash(payload jsonb)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.digest(coalesce(payload, 'null'::jsonb)::text, 'sha256'),
    'hex'
  );
$$;

create or replace function private.lock_idempotency_request(
  target_actor_id uuid,
  target_action text,
  target_key_hash text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if target_actor_id is null
    or char_length(target_action) not between 1 and 80
    or target_key_hash !~ '^[0-9a-f]{64}$'
  then
    raise exception using errcode = '22023', message = 'Invalid idempotency request';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      target_actor_id::text || ':' || target_action || ':' || target_key_hash,
      0
    )
  );
end;
$$;

create or replace function private.mask_invitation_target(
  target_type text,
  normalized_target text
)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  separator integer;
  local_part text;
  domain_part text;
begin
  if target_type = 'email' then
    separator := strpos(normalized_target, '@');
    local_part := left(normalized_target, greatest(separator - 1, 0));
    domain_part := substr(normalized_target, separator + 1);
    return left(local_part, 1) || '***@' || domain_part;
  end if;

  return left(normalized_target, least(2, char_length(normalized_target))) || '***';
end;
$$;

create or replace function private.write_audit_event(
  target_actor_id uuid,
  target_business_id uuid,
  target_event_type text,
  target_type text,
  target_id text,
  target_metadata jsonb default '{}'::jsonb
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.audit_events (
    actor_id,
    business_id,
    event_type,
    target_type,
    target_id,
    metadata
  )
  values (
    target_actor_id,
    target_business_id,
    left(target_event_type, 120),
    left(target_type, 80),
    left(target_id, 500),
    case
      when octet_length(coalesce(target_metadata, '{}'::jsonb)::text) <= 32768
      then coalesce(target_metadata, '{}'::jsonb)
      else jsonb_build_object('truncated', true)
    end
  );
$$;

create or replace function private.username_is_valid(candidate text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select candidate is not null
    and char_length(btrim(candidate)) between 1 and 24
    and btrim(candidate) ~ '^[A-Za-z0-9_.-]+$'
    and lower(btrim(candidate)) not in (
      'admin',
      'administrator',
      'help',
      'moderator',
      'official',
      'root',
      'spottr',
      'support'
    );
$$;

create or replace function private.searchable_text_array(candidate text[])
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select lower(pg_catalog.array_to_string(coalesce(candidate, '{}'::text[]), ' '));
$$;

create index if not exists businesses_cuisine_search_trgm_idx
  on public.businesses using gin (
    private.searchable_text_array(cuisine_labels) gin_trgm_ops
  );

create or replace function public.is_username_available(candidate text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.username_is_valid(candidate)
    and not exists (
      select 1
      from public.profiles p
      where p.username = btrim(candidate)::public.citext
    );
$$;

revoke all on function public.is_username_available(text) from public;
grant execute on function public.is_username_available(text) to anon, authenticated;

create or replace function public.update_own_profile(payload jsonb)
returns table (
  public_id uuid,
  username text,
  display_name text,
  avatar_path text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  previous_username text;
  next_username text;
  next_display_name text;
  next_avatar_path text;
  requested_avatar_id uuid;
begin
  perform private.require_aal2();
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception using errcode = '22023', message = 'Payload must be a JSON object';
  end if;
  if exists (
    select 1
    from jsonb_object_keys(payload) as supplied(key)
    where supplied.key not in ('username', 'display_name', 'avatar_asset_id')
  ) then
    raise exception using errcode = '22023', message = 'Payload contains unsupported fields';
  end if;

  select p.username::text, p.display_name, p.avatar_path
  into next_username, next_display_name, next_avatar_path
  from public.profiles p
  where p.user_id = actor
  for update;

  if next_username is null then
    raise exception using errcode = '22023', message = 'Profile not found';
  end if;
  previous_username := next_username;

  if payload ? 'username' then
    next_username := btrim(coalesce(payload ->> 'username', ''));
  end if;
  if payload ? 'display_name' then
    next_display_name := btrim(coalesce(payload ->> 'display_name', ''));
  end if;
  if not private.username_is_valid(next_username)
    or not private.content_is_professional(next_username)
    or char_length(next_display_name) not between 1 and 80
    or not private.content_is_professional(next_display_name)
  then
    raise exception using errcode = '22023', message = 'Invalid profile details';
  end if;

  if payload ? 'avatar_asset_id' then
    if jsonb_typeof(payload -> 'avatar_asset_id') = 'null' then
      next_avatar_path := null;
    else
      begin
        requested_avatar_id := (payload ->> 'avatar_asset_id')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode = '22023', message = 'Invalid avatar asset';
      end;

      select ma.processed_storage_path
      into next_avatar_path
      from public.media_assets ma
      where ma.id = requested_avatar_id
        and ma.owner_id = actor
        and ma.business_id is null
        and ma.source = 'owner_upload'
        and ma.quarantine_state = 'clean'
        and ma.moderation = 'approved';

      if next_avatar_path is null then
        raise exception using errcode = '22023', message = 'Avatar asset is not approved';
      end if;
    end if;
  end if;

  perform private.consume_rate_limit(actor, 'profile_update', 20, 3600);

  update public.profiles p
  set username = next_username::public.citext,
      display_name = next_display_name,
      avatar_path = next_avatar_path
  where p.user_id = actor;

  perform private.write_audit_event(
    actor,
    null,
    'profile.updated',
    'profile',
    null,
    jsonb_build_object(
      'username_changed', next_username is distinct from previous_username,
      'avatar_present', next_avatar_path is not null
    )
  );

  return query
  select p.public_id, p.username::text, p.display_name, p.avatar_path
  from public.profiles p
  where p.user_id = actor;
end;
$$;

revoke all on function public.update_own_profile(jsonb) from public;
grant execute on function public.update_own_profile(jsonb) to authenticated;

create or replace function private.protect_profile_server_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and not private.is_platform_staff(auth.uid()) then
    if new.user_id is distinct from old.user_id
      or new.status is distinct from old.status
      or new.terms_accepted_at is distinct from old.terms_accepted_at
      or new.terms_version is distinct from old.terms_version
      or new.created_at is distinct from old.created_at
    then
      raise exception using errcode = '42501', message = 'Server-owned profile fields cannot be changed';
    end if;
  end if;

  if auth.uid() is not null
    and new.avatar_path is distinct from old.avatar_path
    and new.avatar_path is not null
    and not exists (
      select 1
      from public.media_assets ma
      where ma.owner_id = auth.uid()
        and ma.processed_storage_path = new.avatar_path
        and ma.quarantine_state = 'clean'
        and ma.moderation = 'approved'
    )
  then
    raise exception using errcode = '42501', message = 'Avatar must reference approved media';
  end if;

  new.username := btrim(new.username::text)::public.citext;
  new.display_name := btrim(new.display_name);
  if not private.username_is_valid(new.username::text)
    or not private.content_is_professional(new.username::text)
    or not private.content_is_professional(new.display_name)
  then
    raise exception using errcode = '23514', message = 'Invalid or reserved username';
  end if;
  return new;
end;
$$;

create or replace function private.assert_business_submission_ready(
  target_business_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.business_locations bl
    where bl.business_id = target_business_id
      and bl.is_primary
      and bl.publication_state in ('private', 'published')
  ) then
    raise exception using errcode = '23514', message = 'SUBMISSION_MISSING_PRIMARY_LOCATION';
  end if;

  if exists (
    select 1
    from public.businesses b
    join public.business_locations bl on bl.business_id = b.id
    where b.id = target_business_id
      and b.kind = 'home_kitchen'
      and (bl.public_address or not bl.is_approximate)
  ) then
    raise exception using errcode = '23514', message = 'HOME_KITCHEN_LOCATION_MUST_BE_APPROXIMATE';
  end if;

  if not exists (
    select 1
    from public.business_private_details bpd
    where bpd.business_id = target_business_id
      and bpd.business_email is not null
      and bpd.business_phone is not null
  ) then
    raise exception using errcode = '23514', message = 'SUBMISSION_MISSING_CONTACT';
  end if;

  if (
    select count(distinct wh.weekday)
    from public.weekly_hours wh
    where wh.business_id = target_business_id
  ) <> 7 then
    raise exception using errcode = '23514', message = 'PUBLICATION_INCOMPLETE_WEEKLY_HOURS';
  end if;

  if not exists (
    select 1
    from public.business_payments bp
    where bp.business_id = target_business_id
  ) then
    raise exception using errcode = '23514', message = 'PUBLICATION_MISSING_PAYMENT_METHOD';
  end if;

  if not exists (
    select 1
    from public.menu_sections ms
    join public.menu_items mi on mi.section_id = ms.id
    where ms.business_id = target_business_id
      and ms.is_published
      and mi.is_published
      and mi.availability <> 'hidden'
  ) then
    raise exception using errcode = '23514', message = 'PUBLICATION_MISSING_MENU';
  end if;
end;
$$;

create or replace function private.assert_business_publication_ready(
  target_business_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_business_submission_ready(target_business_id);

  if not exists (
    select 1
    from public.businesses b
    join public.media_assets ma
      on ma.id = b.logo_asset_id
     and ma.business_id = b.id
    where b.id = target_business_id
      and ma.source in ('owner_upload', 'licensed_provider')
      and ma.quarantine_state = 'clean'
      and ma.moderation = 'approved'
      and ma.processed_storage_path is not null
  ) then
    raise exception using errcode = '23514', message = 'PUBLICATION_MISSING_APPROVED_LOGO';
  end if;

  if not exists (
    select 1
    from public.business_locations bl
    where bl.business_id = target_business_id
      and bl.is_primary
      and bl.publication_state = 'published'
  ) then
    raise exception using errcode = '23514', message = 'PUBLICATION_MISSING_PUBLISHED_LOCATION';
  end if;
end;
$$;

create or replace function private.enforce_business_publication()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception using errcode = '23514', message = 'Invalid business timezone';
  end if;

  if new.state = 'published'
    and (tg_op = 'INSERT' or old.state <> 'published')
  then
    if new.provenance in ('owner', 'community')
      and (
        tg_op = 'INSERT'
        or old.state not in ('pending', 'suspended')
        or new.verification <> 'verified'
      )
    then
      raise exception using errcode = '55000', message = 'BUSINESS_REVIEW_REQUIRED';
    end if;

    if new.provenance = 'licensed_provider'
      and not exists (
        select 1
        from private.provider_business_sources source
        join private.provider_accounts account
          on account.provider_slug = source.provider_slug
        where source.business_id = new.id
          and source.source_status = 'active'
          and account.enabled
          and current_date between account.license_effective_on
            and account.license_expires_on
      )
    then
      raise exception using errcode = '55000', message = 'LICENSED_SOURCE_NOT_ACTIVE';
    end if;

    perform private.assert_business_publication_ready(new.id);
  end if;

  if new.state = 'published' and new.kind = 'home_kitchen' then
    if new.verification <> 'verified'
      or new.jurisdiction_id is null
      or not exists (
        select 1
        from public.jurisdictions j
        join public.home_kitchen_permits hp
          on hp.jurisdiction_id = j.id
         and hp.business_id = new.id
        where j.id = new.jurisdiction_id
          and j.home_kitchens_enabled
          and j.legal_reviewed_at is not null
          and hp.verification = 'verified'
          and hp.expires_on >= current_date
      )
    then
      raise exception using errcode = '23514', message = 'HOME_KITCHEN_NOT_ELIGIBLE';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_business_publication()
  from public, anon, authenticated;

create or replace function private.prevent_published_setup_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_business_id uuid;
  previous_business_id uuid;
  row_payload jsonb;
  previous_payload jsonb;
begin
  row_payload := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  previous_payload := case when tg_op = 'INSERT' then null else to_jsonb(old) end;

  if tg_table_name = 'menu_items' then
    select ms.business_id
    into affected_business_id
    from public.menu_sections ms
    where ms.id = (row_payload ->> 'section_id')::uuid;

    if previous_payload is not null then
      select ms.business_id
      into previous_business_id
      from public.menu_sections ms
      where ms.id = (previous_payload ->> 'section_id')::uuid;
    end if;
  else
    affected_business_id := (row_payload ->> 'business_id')::uuid;
    previous_business_id := case
      when previous_payload is null then null
      else (previous_payload ->> 'business_id')::uuid
    end;
  end if;

  if tg_table_name = 'menu_items'
    and tg_op = 'UPDATE'
    and (
      to_jsonb(new) - array['availability', 'updated_at']::text[]
    ) = (
      to_jsonb(old) - array['availability', 'updated_at']::text[]
    )
  then
    return new;
  end if;

  if exists (
    select 1
    from public.businesses b
    where b.id in (affected_business_id, previous_business_id)
      and b.state = 'published'
  ) then
    if tg_table_name = 'business_locations'
      and tg_op = 'INSERT'
      and current_setting('spottr.mobile_location_business_id', true) = affected_business_id::text
      and private.has_aal2()
      and private.is_business_member(
        affected_business_id,
        auth.uid(),
        array['owner', 'manager']::public.member_role[]
      )
      and exists (
        select 1
        from public.businesses mobile_business
        where mobile_business.id = affected_business_id
          and mobile_business.kind in ('food_truck', 'pop_up')
      )
    then
      return new;
    end if;

    if current_setting('spottr.applying_revision_id', true) ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and private.has_aal2()
      and private.is_platform_staff(
        auth.uid(),
        array['admin']::public.platform_role[]
      )
      and exists (
        select 1
        from private.business_revision_requests brr
        where brr.id = current_setting('spottr.applying_revision_id', true)::uuid
          and brr.business_id = affected_business_id
          and brr.state = 'pending'
      )
    then
      if tg_op = 'DELETE' then
        return old;
      end if;
      return new;
    end if;

    raise exception using
      errcode = '42501',
      message = 'PUBLISHED_LISTING_REQUIRES_STAGED_REVISION';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function private.enforce_home_kitchen_location_privacy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.businesses b
    where b.id = new.business_id
      and b.kind = 'home_kitchen'
  ) then
    new.public_address := false;
    new.is_approximate := true;
  end if;
  return new;
end;
$$;

create or replace function private.emit_public_business_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_business_id uuid;
  target_event_type text;
  target_payload jsonb;
  target_expiry timestamptz := now() + interval '24 hours';
begin
  case tg_table_name
    when 'business_live_status' then
      target_business_id := new.business_id;
      if new.expires_at <= now() then
        return new;
      end if;
      target_event_type := 'live_status';
      target_expiry := least(new.expires_at, now() + interval '7 days');
      target_payload := jsonb_build_object(
        'status', new.status,
        'confirmed_at', new.confirmed_at,
        'expires_at', new.expires_at
      );
    when 'business_updates' then
      target_business_id := new.business_id;
      if new.moderation <> 'approved'
        or new.starts_at > now()
        or new.expires_at <= now()
      then
        return new;
      end if;
      target_event_type := 'owner_update';
      target_expiry := least(new.expires_at, now() + interval '7 days');
      target_payload := jsonb_build_object(
        'update_id', new.id,
        'kind', new.kind,
        'body', new.body,
        'starts_at', new.starts_at,
        'expires_at', new.expires_at
      );
    when 'mobile_stops' then
      target_business_id := new.business_id;
      if new.ends_at <= now()
        or new.state not in ('scheduled', 'live', 'cancelled')
        or (
          tg_op = 'UPDATE'
          and new.state = 'cancelled'
          and old.state = 'draft'
        )
      then
        return new;
      end if;
      target_event_type := 'mobile_stop';
      target_expiry := least(new.ends_at, now() + interval '7 days');
      target_payload := jsonb_build_object(
        'stop_id', new.id,
        'location_id', new.location_id,
        'starts_at', new.starts_at,
        'ends_at', new.ends_at,
        'state', new.state
      );
    when 'menu_items' then
      if tg_op = 'UPDATE' and new.availability is not distinct from old.availability then
        return new;
      end if;
      select ms.business_id
      into target_business_id
      from public.menu_sections ms
      where ms.id = new.section_id
        and ms.is_published
        and new.is_published;
      target_event_type := 'menu_availability';
      target_payload := jsonb_build_object(
        'menu_item_id', new.id,
        'availability', new.availability,
        'updated_at', new.updated_at
      );
    else
      return new;
  end case;

  if target_business_id is null
    or not private.is_business_publicly_eligible(target_business_id)
  then
    return new;
  end if;

  insert into public.business_public_events (
    business_id,
    event_type,
    payload,
    expires_at
  )
  values (
    target_business_id,
    target_event_type,
    target_payload,
    target_expiry
  );

  return new;
end;
$$;

create or replace function private.protect_review_author_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and not private.is_platform_staff(auth.uid()) then
    if old.author_id <> auth.uid() then
      raise exception using errcode = '42501', message = 'Review does not belong to the current user';
    end if;
    if old.moderation in ('rejected', 'removed') then
      raise exception using errcode = '42501', message = 'REVIEW_NOT_EDITABLE';
    end if;
    new.id := old.id;
    new.business_id := old.business_id;
    new.author_id := old.author_id;
    new.helpful_count := old.helpful_count;
    new.created_at := old.created_at;
    new.deleted_at := null;
    new.moderation := 'pending'::public.moderation_state;
    perform private.consume_rate_limit(auth.uid(), 'review_update', 10, 86400);
  end if;
  return new;
end;
$$;

create or replace function private.enforce_content_insert_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  action_name text;
  action_max integer;
  action_window integer;
begin
  if auth.uid() is null then
    return new;
  end if;

  case tg_table_name
    when 'reviews' then
      actor := new.author_id;
      action_name := 'review_create';
      action_max := 10;
      action_window := 86400;
    when 'business_updates' then
      actor := new.author_id;
      action_name := 'business_update_create';
      action_max := 24;
      action_window := 3600;
    when 'business_claims' then
      actor := new.claimant_id;
      action_name := 'business_claim_create';
      action_max := 5;
      action_window := 86400;
    when 'content_reports' then
      actor := new.reporter_id;
      action_name := 'content_report_create';
      action_max := 30;
      action_window := 86400;
    when 'business_responses' then
      actor := new.author_id;
      action_name := 'business_response_create';
      action_max := 20;
      action_window := 86400;
    when 'user_blocks' then
      actor := new.blocker_id;
      action_name := 'user_block';
      action_max := 100;
      action_window := 86400;
    else
      return new;
  end case;

  if actor <> auth.uid() or not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;
  perform private.consume_rate_limit(actor, action_name, action_max, action_window);
  return new;
end;
$$;

create or replace function private.content_is_professional(candidate text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select candidate is null or not exists (
    select 1
    from unnest(array[
      lower(candidate),
      translate(lower(candidate), '013457@$!', 'oieastasi')
    ]) as variant(value)
    where variant.value ~
      '\m(a+[^[:alnum:]]*s+[^[:alnum:]]*s+[^[:alnum:]]*h+[^[:alnum:]]*o+[^[:alnum:]]*l+[^[:alnum:]]*e+|b+[^[:alnum:]]*a+[^[:alnum:]]*s+[^[:alnum:]]*t+[^[:alnum:]]*a+[^[:alnum:]]*r+[^[:alnum:]]*d+|b+[^[:alnum:]]*i+[^[:alnum:]]*t+[^[:alnum:]]*c+[^[:alnum:]]*h+|b+[^[:alnum:]]*u+[^[:alnum:]]*l+[^[:alnum:]]*l+[^[:alnum:]]*s+[^[:alnum:]]*h+[^[:alnum:]]*i+[^[:alnum:]]*t+|c+[^[:alnum:]]*u+[^[:alnum:]]*n+[^[:alnum:]]*t+|d+[^[:alnum:]]*i+[^[:alnum:]]*c+[^[:alnum:]]*k+|f+[^[:alnum:]]*a+[^[:alnum:]]*g+[^[:alnum:]]*g+[^[:alnum:]]*o+[^[:alnum:]]*t+|f+[^[:alnum:]]*u+[^[:alnum:]]*c+[^[:alnum:]]*k+|m+[^[:alnum:]]*o+[^[:alnum:]]*t+[^[:alnum:]]*h+[^[:alnum:]]*e+[^[:alnum:]]*r+[^[:alnum:]]*f+[^[:alnum:]]*u+[^[:alnum:]]*c+[^[:alnum:]]*k+[^[:alnum:]]*e+[^[:alnum:]]*r+|n+[^[:alnum:]]*i+[^[:alnum:]]*g+[^[:alnum:]]*g+[^[:alnum:]]*e+[^[:alnum:]]*r+|s+[^[:alnum:]]*h+[^[:alnum:]]*i+[^[:alnum:]]*t+|s+[^[:alnum:]]*l+[^[:alnum:]]*u+[^[:alnum:]]*t+)\M'
  );
$$;

create or replace function private.enforce_professional_content()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate_text text;
begin
  case tg_table_name
    when 'businesses' then
      candidate_text := concat_ws(' ', new.name, new.description, array_to_string(new.cuisine_labels, ' '));
    when 'business_updates' then
      candidate_text := new.body;
    when 'reviews' then
      candidate_text := new.body;
    when 'business_responses' then
      candidate_text := new.body;
    when 'menu_sections' then
      candidate_text := new.name;
    when 'menu_items' then
      candidate_text := concat_ws(' ', new.name, new.description, new.allergen_note);
    when 'business_locations' then
      candidate_text := concat_ws(' ', new.label, new.address_line, new.city, new.region);
    when 'special_hours' then
      candidate_text := new.note;
    else
      return new;
  end case;

  if not private.content_is_professional(candidate_text) then
    raise exception using errcode = '23514', message = 'CONTENT_POLICY_VIOLATION';
  end if;
  return new;
end;
$$;

create or replace function private.enforce_business_has_active_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_business_id uuid;
begin
  affected_business_id := case
    when tg_op = 'DELETE' then old.business_id
    else new.business_id
  end;

  if exists (
    select 1
    from public.businesses b
    where b.id = affected_business_id
      and b.state <> 'archived'
  ) and not exists (
    select 1
    from public.business_members bm
    where bm.business_id = affected_business_id
      and bm.role = 'owner'
      and bm.status = 'active'
  ) then
    raise exception using errcode = '23514', message = 'BUSINESS_REQUIRES_ACTIVE_OWNER';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function private.remove_logo_from_gallery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.logo_asset_id is not null then
    delete from public.business_media_links link
    where link.business_id = new.id
      and link.asset_id = new.logo_asset_id;
  end if;
  return new;
end;
$$;

create or replace function public.submit_review(
  target_business_id uuid,
  review_rating smallint,
  review_body text,
  idempotency_key text,
  media_asset_ids uuid[] default '{}'::uuid[]
)
returns table (
  review_id uuid,
  business_id uuid,
  rating smallint,
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
  actor uuid := auth.uid();
  normalized_body text := btrim(
    regexp_replace(coalesce(review_body, ''), '[[:space:]]+', ' ', 'g')
  );
  normalized_assets uuid[] := coalesce(media_asset_ids, '{}'::uuid[]);
  key_hash text;
  request_hash text;
  existing_response_id uuid;
  target_review_id uuid;
  previous_moderation public.moderation_state;
  next_moderation public.moderation_state := 'pending';
  asset_count integer := cardinality(normalized_assets);
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;
  if review_rating not between 1 and 5
    or char_length(normalized_body) not between 1 and 2000
    or not private.content_is_professional(normalized_body)
    or target_business_id is null
    or not private.is_business_publicly_eligible(target_business_id)
    or asset_count > 4
    or array_position(normalized_assets, null) is not null
    or (
      select count(distinct supplied.asset_id)
      from unnest(normalized_assets) supplied(asset_id)
    ) <> asset_count
  then
    raise exception using errcode = '22023', message = 'Invalid review submission';
  end if;

  if asset_count > 0 and (
    select count(*)
    from public.media_assets ma
    where ma.id = any(normalized_assets)
      and ma.owner_id = actor
      and ma.business_id = target_business_id
      and ma.source = 'review_upload'
      and ma.quarantine_state in ('uploaded', 'scanning', 'clean')
      and ma.moderation in ('pending', 'approved')
  ) <> asset_count then
    raise exception using errcode = '22023', message = 'Review media is not eligible';
  end if;

  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'business_id', target_business_id,
    'rating', review_rating,
    'body', normalized_body,
    'media_asset_ids', to_jsonb(normalized_assets)
  ));
  perform private.lock_idempotency_request(actor, 'review_submit', key_hash);

  select receipt.response_id, receipt.request_hash
  into existing_response_id, request_hash
  from private.action_idempotency_receipts receipt
  where receipt.actor_id = actor
    and receipt.action = 'review_submit'
    and receipt.idempotency_key_hash = key_hash;

  if existing_response_id is not null then
    if request_hash is distinct from private.json_request_hash(jsonb_build_object(
      'business_id', target_business_id,
      'rating', review_rating,
      'body', normalized_body,
      'media_asset_ids', to_jsonb(normalized_assets)
    )) then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;

    return query
    select
      r.id,
      r.business_id,
      r.rating,
      r.body,
      r.moderation,
      r.created_at,
      r.updated_at
    from public.reviews r
    where r.id = existing_response_id
      and r.author_id = actor;
    if not found then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_RESPONSE_GONE';
    end if;
    return;
  end if;

  -- Recompute because the receipt lookup above intentionally used the same local
  -- variable to avoid retaining an untrusted stored hash.
  request_hash := private.json_request_hash(jsonb_build_object(
    'business_id', target_business_id,
    'rating', review_rating,
    'body', normalized_body,
    'media_asset_ids', to_jsonb(normalized_assets)
  ));

  select r.id, r.moderation
  into target_review_id, previous_moderation
  from public.reviews r
  where r.business_id = target_business_id
    and r.author_id = actor
  for update;

  if target_review_id is null then
    insert into public.reviews (
      business_id,
      author_id,
      rating,
      body,
      moderation,
      helpful_count,
      deleted_at
    )
    values (
      target_business_id,
      actor,
      review_rating,
      normalized_body,
      next_moderation,
      0,
      null
    )
    returning id into target_review_id;
  else
    if previous_moderation in ('rejected', 'removed') then
      raise exception using errcode = '42501', message = 'REVIEW_NOT_EDITABLE';
    end if;

    update public.reviews r
    set rating = review_rating,
        body = normalized_body,
        moderation = next_moderation,
        deleted_at = null
    where r.id = target_review_id;

    delete from public.review_media rm
    where rm.review_id = target_review_id;
  end if;

  insert into public.review_media (review_id, asset_id, sort_order)
  select target_review_id, supplied.asset_id, (supplied.ordinality - 1)::smallint
  from unnest(normalized_assets) with ordinality supplied(asset_id, ordinality);

  insert into private.action_idempotency_receipts (
    actor_id,
    action,
    idempotency_key_hash,
    request_hash,
    response_id
  )
  values (
    actor,
    'review_submit',
    key_hash,
    request_hash,
    target_review_id
  );

  perform private.write_audit_event(
    actor,
    target_business_id,
    case
      when previous_moderation is null then 'review.submitted'
      else 'review.revised'
    end,
    'review',
    target_review_id::text,
    jsonb_build_object(
      'moderation', next_moderation::text,
      'media_count', asset_count
    )
  );

  return query
  select
    r.id,
    r.business_id,
    r.rating,
    r.body,
    r.moderation,
    r.created_at,
    r.updated_at
  from public.reviews r
  where r.id = target_review_id;
end;
$$;

revoke all on function public.submit_review(uuid, smallint, text, text, uuid[]) from public;
grant execute on function public.submit_review(uuid, smallint, text, text, uuid[]) to authenticated;

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
declare
  actor uuid := auth.uid();
  normalized_body text := btrim(
    regexp_replace(coalesce(update_body, ''), '[[:space:]]+', ' ', 'g')
  );
  key_hash text;
  supplied_request_hash text;
  stored_request_hash text;
  existing_response_id uuid;
  target_update_id uuid;
  begins_at timestamptz := statement_timestamp();
  ends_at timestamptz;
begin
  perform private.require_aal2();
  perform 1
  from public.businesses b
  where b.id = target_business_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Business not found';
  end if;

  if not private.is_business_member(
    target_business_id,
    actor,
    array['owner', 'manager']::public.member_role[]
  ) then
    raise exception using errcode = '42501', message = 'Owner or manager role required';
  end if;
  if not private.is_business_publicly_eligible(target_business_id)
    or update_kind is null
    or active_for_minutes not between 5 and 1440
    or char_length(normalized_body) not between 1 and 120
    or not private.content_is_professional(normalized_body)
  then
    raise exception using errcode = '22023', message = 'Invalid business update';
  end if;

  ends_at := begins_at + make_interval(mins => active_for_minutes);
  key_hash := private.idempotency_key_hash(idempotency_key);
  supplied_request_hash := private.json_request_hash(jsonb_build_object(
    'business_id', target_business_id,
    'kind', update_kind::text,
    'body', normalized_body,
    'active_for_minutes', active_for_minutes
  ));
  perform private.lock_idempotency_request(actor, 'business_update_submit', key_hash);

  select receipt.response_id, receipt.request_hash
  into existing_response_id, stored_request_hash
  from private.action_idempotency_receipts receipt
  where receipt.actor_id = actor
    and receipt.action = 'business_update_submit'
    and receipt.idempotency_key_hash = key_hash;

  if existing_response_id is not null then
    if stored_request_hash is distinct from supplied_request_hash then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return query
    select
      bu.id,
      bu.business_id,
      bu.kind,
      bu.body,
      bu.moderation,
      bu.starts_at,
      bu.expires_at,
      bu.created_at
    from public.business_updates bu
    where bu.id = existing_response_id
      and bu.author_id = actor;
    if not found then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_RESPONSE_GONE';
    end if;
    return;
  end if;

  insert into public.business_updates (
    business_id,
    author_id,
    kind,
    body,
    starts_at,
    expires_at,
    moderation
  )
  values (
    target_business_id,
    actor,
    update_kind,
    normalized_body,
    begins_at,
    ends_at,
    'pending'
  )
  returning id into target_update_id;

  insert into private.action_idempotency_receipts (
    actor_id,
    action,
    idempotency_key_hash,
    request_hash,
    response_id
  )
  values (
    actor,
    'business_update_submit',
    key_hash,
    supplied_request_hash,
    target_update_id
  );

  perform private.write_audit_event(
    actor,
    target_business_id,
    'business.update_published',
    'update',
    target_update_id::text,
    jsonb_build_object(
      'kind', update_kind::text,
      'active_for_minutes', active_for_minutes
    )
  );

  return query
  select
    bu.id,
    bu.business_id,
    bu.kind,
    bu.body,
    bu.moderation,
    bu.starts_at,
    bu.expires_at,
    bu.created_at
  from public.business_updates bu
  where bu.id = target_update_id;
end;
$$;

revoke all on function public.submit_business_update(
  uuid,
  public.update_kind,
  text,
  integer,
  text
) from public;
grant execute on function public.submit_business_update(
  uuid,
  public.update_kind,
  text,
  integer,
  text
) to authenticated;

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
  actor uuid := auth.uid();
  normalized_body text := btrim(
    regexp_replace(coalesce(response_body, ''), '[[:space:]]+', ' ', 'g')
  );
  target_business_id uuid;
  previous_moderation public.moderation_state;
  key_hash text;
  supplied_request_hash text;
  stored_request_hash text;
  existing_response_id uuid;
begin
  perform private.require_aal2();

  select r.business_id
  into target_business_id
  from public.reviews r
  where r.id = target_review_id
    and r.moderation = 'approved'
    and r.deleted_at is null;

  if target_business_id is null then
    raise exception using errcode = '42501', message = 'Eligible owner or manager role required';
  end if;

  perform 1
  from public.businesses b
  where b.id = target_business_id
  for update;

  perform 1
  from public.reviews r
  where r.id = target_review_id
    and r.business_id = target_business_id
    and r.moderation = 'approved'
    and r.deleted_at is null
  for update;

  if not found
    or not private.is_business_publicly_eligible(target_business_id)
    or not private.is_business_member(
      target_business_id,
      actor,
      array['owner', 'manager']::public.member_role[]
    )
  then
    raise exception using errcode = '42501', message = 'Eligible owner or manager role required';
  end if;
  if char_length(normalized_body) not between 1 and 1000
    or not private.content_is_professional(normalized_body)
  then
    raise exception using errcode = '22023', message = 'Invalid business response';
  end if;

  key_hash := private.idempotency_key_hash(idempotency_key);
  supplied_request_hash := private.json_request_hash(jsonb_build_object(
    'review_id', target_review_id,
    'body', normalized_body
  ));
  perform private.lock_idempotency_request(actor, 'business_response_submit', key_hash);

  select receipt.response_id, receipt.request_hash
  into existing_response_id, stored_request_hash
  from private.action_idempotency_receipts receipt
  where receipt.actor_id = actor
    and receipt.action = 'business_response_submit'
    and receipt.idempotency_key_hash = key_hash;

  if existing_response_id is not null then
    if stored_request_hash is distinct from supplied_request_hash then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return query
    select
      br.review_id,
      br.business_id,
      br.body,
      br.moderation,
      br.created_at,
      br.updated_at
    from public.business_responses br
    where br.review_id = existing_response_id
      and br.business_id = target_business_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_RESPONSE_GONE';
    end if;
    return;
  end if;

  select br.moderation
  into previous_moderation
  from public.business_responses br
  where br.review_id = target_review_id
  for update;

  if previous_moderation in ('rejected', 'removed') then
    raise exception using errcode = '42501', message = 'RESPONSE_NOT_EDITABLE';
  elsif previous_moderation is null then
    insert into public.business_responses (
      review_id,
      business_id,
      author_id,
      body,
      moderation
    )
    values (
      target_review_id,
      target_business_id,
      actor,
      normalized_body,
      'pending'
    );
  else
    perform private.consume_rate_limit(actor, 'business_response_update', 20, 86400);
    update public.business_responses br
    set author_id = actor,
        body = normalized_body,
        moderation = 'pending'
    where br.review_id = target_review_id;
  end if;

  insert into private.action_idempotency_receipts (
    actor_id,
    action,
    idempotency_key_hash,
    request_hash,
    response_id
  )
  values (
    actor,
    'business_response_submit',
    key_hash,
    supplied_request_hash,
    target_review_id
  );

  perform private.write_audit_event(
    actor,
    target_business_id,
    case
      when previous_moderation is null then 'business.response_published'
      else 'business.response_revised'
    end,
    'response',
    target_review_id::text,
    '{}'::jsonb
  );

  return query
  select
    br.review_id,
    br.business_id,
    br.body,
    br.moderation,
    br.created_at,
    br.updated_at
  from public.business_responses br
  where br.review_id = target_review_id;
end;
$$;

revoke all on function public.submit_business_response(uuid, text, text) from public;
grant execute on function public.submit_business_response(uuid, text, text) to authenticated;

create or replace function public.nominate_business_logo(
  target_business_id uuid,
  target_asset_id uuid
)
returns table (
  asset_id uuid,
  quarantine_state text,
  moderation_state public.moderation_state
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  perform private.require_aal2();

  perform 1
  from public.businesses b
  where b.id = target_business_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Business not found';
  end if;

  if not private.can_manage_business_draft(target_business_id, actor) then
    raise exception using errcode = '42501', message = 'Draft owner or manager role required';
  end if;

  if target_asset_id is not null and not exists (
    select 1
    from public.media_assets ma
    where ma.id = target_asset_id
      and ma.business_id = target_business_id
      and ma.owner_id = actor
      and ma.source = 'owner_upload'
      and ma.quarantine_state in ('uploaded', 'scanning', 'clean')
      and ma.moderation in ('pending', 'approved')
  ) then
    raise exception using errcode = '22023', message = 'Logo asset is not eligible';
  end if;

  perform private.consume_rate_limit(actor, 'business_logo_nominate', 20, 3600);

  update public.businesses b
  set logo_asset_id = target_asset_id
  where b.id = target_business_id;

  if target_asset_id is not null then
    delete from public.business_media_links link
    where link.business_id = target_business_id
      and link.asset_id = target_asset_id;
  end if;

  perform private.write_audit_event(
    actor,
    target_business_id,
    'business.logo_nominated',
    'media',
    target_asset_id::text,
    jsonb_build_object('cleared', target_asset_id is null)
  );

  if target_asset_id is null then
    return;
  end if;

  return query
  select ma.id, ma.quarantine_state, ma.moderation
  from public.media_assets ma
  where ma.id = target_asset_id;
end;
$$;

revoke all on function public.nominate_business_logo(uuid, uuid) from public;
grant execute on function public.nominate_business_logo(uuid, uuid) to authenticated;

create or replace function public.set_business_gallery_media(
  target_business_id uuid,
  target_asset_ids uuid[]
)
returns table (
  asset_id uuid,
  sort_order smallint,
  quarantine_state text,
  moderation_state public.moderation_state,
  processed_storage_path text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  normalized_assets uuid[] := coalesce(target_asset_ids, '{}'::uuid[]);
  asset_count integer := cardinality(normalized_assets);
begin
  perform private.require_aal2();
  if not private.is_business_member(
    target_business_id,
    actor,
    array['owner', 'manager']::public.member_role[]
  ) then
    raise exception using errcode = '42501', message = 'Owner or manager role required';
  end if;
  if asset_count > 12
    or array_position(normalized_assets, null) is not null
    or (
      select count(distinct supplied.asset_id)
      from unnest(normalized_assets) supplied(asset_id)
    ) <> asset_count
  then
    raise exception using errcode = '22023', message = 'Invalid gallery assets';
  end if;

  if asset_count > 0 and (
    select count(*)
    from public.media_assets ma
    where ma.id = any(normalized_assets)
      and ma.business_id = target_business_id
      and ma.source = 'owner_upload'
      and ma.quarantine_state in ('uploaded', 'scanning', 'clean')
      and ma.moderation in ('pending', 'approved')
      and exists (
        select 1
        from public.business_members uploader
        where uploader.business_id = target_business_id
          and uploader.user_id = ma.owner_id
          and uploader.status = 'active'
      )
      and not exists (
        select 1
        from public.businesses b
        where b.id = target_business_id
          and b.logo_asset_id = ma.id
      )
  ) <> asset_count then
    raise exception using errcode = '22023', message = 'Gallery asset is not eligible';
  end if;

  perform private.consume_rate_limit(actor, 'business_gallery_set', 20, 3600);

  delete from public.business_media_links link
  where link.business_id = target_business_id;

  insert into public.business_media_links (
    business_id,
    asset_id,
    media_role,
    sort_order,
    added_by
  )
  select
    target_business_id,
    supplied.asset_id,
    'gallery',
    (supplied.ordinality - 1)::smallint,
    actor
  from unnest(normalized_assets) with ordinality supplied(asset_id, ordinality);

  perform private.write_audit_event(
    actor,
    target_business_id,
    'business.gallery_set',
    'business_media',
    target_business_id::text,
    jsonb_build_object('asset_count', asset_count)
  );

  return query
  select
    ma.id,
    link.sort_order,
    ma.quarantine_state,
    ma.moderation,
    ma.processed_storage_path
  from public.business_media_links link
  join public.media_assets ma on ma.id = link.asset_id
  where link.business_id = target_business_id
  order by link.sort_order, ma.id;
end;
$$;

revoke all on function public.set_business_gallery_media(uuid, uuid[]) from public;
grant execute on function public.set_business_gallery_media(uuid, uuid[]) to authenticated;

create or replace function public.get_business_media_management(
  target_business_id uuid
)
returns table (
  asset_id uuid,
  media_role text,
  sort_order smallint,
  quarantine_state text,
  moderation_state public.moderation_state,
  processed_storage_path text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  perform private.require_aal2();
  if not private.is_business_member(
    target_business_id,
    actor,
    array['owner', 'manager']::public.member_role[]
  ) then
    raise exception using errcode = '42501', message = 'Owner or manager role required';
  end if;

  return query
  select
    ma.id,
    media.media_role,
    media.sort_order,
    ma.quarantine_state,
    ma.moderation,
    ma.processed_storage_path
  from (
    select
      b.logo_asset_id as asset_id,
      'logo'::text as media_role,
      (-1)::smallint as sort_order
    from public.businesses b
    where b.id = target_business_id
      and b.logo_asset_id is not null
    union all
    select link.asset_id, link.media_role, link.sort_order
    from public.business_media_links link
    where link.business_id = target_business_id
  ) media
  join public.media_assets ma on ma.id = media.asset_id
  order by media.sort_order, ma.id;
end;
$$;

revoke all on function public.get_business_media_management(uuid) from public;
grant execute on function public.get_business_media_management(uuid) to authenticated;

create or replace function public.get_business_team(target_business_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role public.member_role;
  result jsonb;
begin
  perform private.require_aal2();
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;

  select bm.role
  into actor_role
  from public.business_members bm
  where bm.business_id = target_business_id
    and bm.user_id = actor
    and bm.status = 'active';

  if actor_role not in ('owner', 'manager') then
    raise exception using errcode = '42501', message = 'Owner or manager role required';
  end if;

  select jsonb_build_object(
    'business_id', b.id,
    'business_name', b.name,
    'actor_role', actor_role,
    'members', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'public_id', p.public_id,
          'username', p.username::text,
          'display_name', p.display_name,
          'avatar_path', p.avatar_path,
          'role', bm.role,
          'status', bm.status,
          'is_actor', bm.user_id = actor,
          'accepted_at', bm.accepted_at,
          'created_at', bm.created_at
        )
        order by
          case bm.role when 'owner' then 0 when 'manager' then 1 else 2 end,
          lower(p.display_name),
          p.public_id
      )
      from public.business_members bm
      join public.profiles p on p.user_id = bm.user_id
      where bm.business_id = b.id
        and bm.status = 'active'
        and p.status <> 'deleted'
    ), '[]'::jsonb),
    'invitations', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'invitation_id', bi.id,
          'target_type', bi.target_type,
          'target_hint', bi.target_hint,
          'role', bi.role,
          'state', case
            when bi.state = 'pending' and bi.expires_at <= now() then 'expired'
            else bi.state
          end,
          'created_at', bi.created_at,
          'expires_at', bi.expires_at
        )
        order by bi.created_at desc, bi.id
      )
      from private.business_invitations bi
      where bi.business_id = b.id
        and (
          bi.state = 'pending'
          or bi.created_at >= now() - interval '30 days'
        )
    ), '[]'::jsonb)
  )
  into result
  from public.businesses b
  where b.id = target_business_id;

  if result is null then
    raise exception using errcode = '22023', message = 'Business not found';
  end if;
  return result;
end;
$$;

revoke all on function public.get_business_team(uuid) from public;
grant execute on function public.get_business_team(uuid) to authenticated;

create or replace function public.invite_business_member(
  target_business_id uuid,
  invite_target text,
  invite_role public.member_role,
  idempotency_key text
)
returns table (
  invitation_id uuid,
  target_type text,
  target_hint text,
  role public.member_role,
  state text,
  expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role public.member_role;
  normalized_target text := lower(btrim(coalesce(invite_target, '')));
  resolved_target_type text;
  masked_target text;
  resolved_target_user_id uuid;
  key_hash text;
  supplied_request_hash text;
  stored_request_hash text;
  existing_response_id uuid;
  target_invitation_id uuid;
begin
  perform private.require_aal2();
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;

  perform 1
  from public.businesses b
  where b.id = target_business_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Business not found';
  end if;

  select bm.role
  into actor_role
  from public.business_members bm
  where bm.business_id = target_business_id
    and bm.user_id = actor
    and bm.status = 'active';

  if actor_role = 'owner' then
    if invite_role not in ('manager', 'staff') then
      raise exception using errcode = '42501', message = 'Ownership must use the transfer workflow';
    end if;
  elsif actor_role = 'manager' then
    if invite_role <> 'staff' then
      raise exception using errcode = '42501', message = 'Managers may invite staff only';
    end if;
  else
    raise exception using errcode = '42501', message = 'Owner or manager role required';
  end if;

  if strpos(normalized_target, '@') > 0 then
    resolved_target_type := 'email';
    if char_length(normalized_target) > 320
      or normalized_target !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      or normalized_target ~ '[[:cntrl:]]'
    then
      raise exception using errcode = '22023', message = 'Invalid invitation target';
    end if;

    select u.id
    into resolved_target_user_id
    from auth.users u
    where lower(u.email) = normalized_target
    order by u.created_at
    limit 1;
  else
    resolved_target_type := 'username';
    if not private.username_is_valid(normalized_target) then
      raise exception using errcode = '22023', message = 'Invalid invitation target';
    end if;

    select p.user_id
    into resolved_target_user_id
    from public.profiles p
    where p.username = normalized_target::public.citext
    limit 1;
  end if;

  masked_target := private.mask_invitation_target(
    resolved_target_type,
    normalized_target
  );
  key_hash := private.idempotency_key_hash(idempotency_key);
  supplied_request_hash := private.json_request_hash(jsonb_build_object(
    'business_id', target_business_id,
    'target_type', resolved_target_type,
    'target', normalized_target,
    'role', invite_role::text
  ));
  perform private.lock_idempotency_request(actor, 'business_member_invite', key_hash);

  select receipt.response_id, receipt.request_hash
  into existing_response_id, stored_request_hash
  from private.action_idempotency_receipts receipt
  where receipt.actor_id = actor
    and receipt.action = 'business_member_invite'
    and receipt.idempotency_key_hash = key_hash;

  if existing_response_id is not null then
    if stored_request_hash is distinct from supplied_request_hash then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return query
    select
      bi.id,
      bi.target_type,
      bi.target_hint,
      bi.role,
      case
        when bi.state = 'pending' and bi.expires_at <= now() then 'expired'
        else bi.state
      end,
      bi.expires_at
    from private.business_invitations bi
    where bi.id = existing_response_id
      and bi.business_id = target_business_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_RESPONSE_GONE';
    end if;
    return;
  end if;

  perform private.consume_rate_limit(actor, 'business_member_invite', 30, 86400);

  insert into private.business_invitations (
    business_id,
    target_type,
    target_normalized,
    target_hint,
    target_user_id,
    role,
    state,
    invited_by,
    expires_at
  )
  values (
    target_business_id,
    resolved_target_type,
    normalized_target::public.citext,
    masked_target,
    resolved_target_user_id,
    invite_role,
    'pending',
    actor,
    now() + interval '14 days'
  )
  on conflict (business_id, target_type, target_normalized)
    where state = 'pending'
  do update set
    target_hint = excluded.target_hint,
    target_user_id = coalesce(excluded.target_user_id, private.business_invitations.target_user_id),
    role = excluded.role,
    invited_by = excluded.invited_by,
    created_at = now(),
    expires_at = now() + interval '14 days',
    updated_at = now()
  returning id into target_invitation_id;

  insert into private.action_idempotency_receipts (
    actor_id,
    action,
    idempotency_key_hash,
    request_hash,
    response_id
  )
  values (
    actor,
    'business_member_invite',
    key_hash,
    supplied_request_hash,
    target_invitation_id
  );

  perform private.write_audit_event(
    actor,
    target_business_id,
    'business.member_invited',
    'business_invitation',
    target_invitation_id::text,
    jsonb_build_object(
      'target_type', resolved_target_type,
      'target_hint', masked_target,
      'role', invite_role::text
    )
  );

  return query
  select
    bi.id,
    bi.target_type,
    bi.target_hint,
    bi.role,
    bi.state,
    bi.expires_at
  from private.business_invitations bi
  where bi.id = target_invitation_id;
end;
$$;

revoke all on function public.invite_business_member(
  uuid,
  text,
  public.member_role,
  text
) from public;
grant execute on function public.invite_business_member(
  uuid,
  text,
  public.member_role,
  text
) to authenticated;

create or replace function public.list_my_business_invitations()
returns table (
  invitation_id uuid,
  business_id uuid,
  business_name text,
  role public.member_role,
  state text,
  target_hint text,
  invited_at timestamptz,
  expires_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_email text;
  actor_username text;
begin
  perform private.require_aal2();
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;

  select lower(u.email), lower(p.username::text)
  into actor_email, actor_username
  from auth.users u
  join public.profiles p on p.user_id = u.id
  where u.id = actor;

  return query
  select
    bi.id,
    bi.business_id,
    b.name,
    bi.role,
    bi.state,
    bi.target_hint,
    bi.created_at,
    bi.expires_at
  from private.business_invitations bi
  join public.businesses b on b.id = bi.business_id
  where bi.state = 'pending'
    and bi.expires_at > now()
    and (
      bi.target_user_id = actor
      or (bi.target_type = 'email' and bi.target_normalized = actor_email::public.citext)
      or (bi.target_type = 'username' and bi.target_normalized = actor_username::public.citext)
    )
  order by bi.created_at desc, bi.id;
end;
$$;

revoke all on function public.list_my_business_invitations() from public;
grant execute on function public.list_my_business_invitations() to authenticated;

create or replace function public.respond_business_invitation(
  target_invitation_id uuid,
  decision text
)
returns table (
  business_id uuid,
  business_name text,
  role public.member_role,
  state text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_email text;
  actor_username text;
  invitation_business_id uuid;
  invitation private.business_invitations%rowtype;
  assigned_role public.member_role;
begin
  perform private.require_aal2();
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;
  if decision not in ('accept', 'decline') then
    raise exception using errcode = '22023', message = 'Invalid invitation decision';
  end if;

  select bi.business_id
  into invitation_business_id
  from private.business_invitations bi
  where bi.id = target_invitation_id;

  if invitation_business_id is null then
    raise exception using errcode = '22023', message = 'Invitation not found';
  end if;

  perform 1
  from public.businesses b
  where b.id = invitation_business_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Invitation not found';
  end if;

  select lower(u.email), lower(p.username::text)
  into actor_email, actor_username
  from auth.users u
  join public.profiles p on p.user_id = u.id
  where u.id = actor;

  select bi.*
  into invitation
  from private.business_invitations bi
  where bi.id = target_invitation_id
  for update;

  if invitation.id is null or not (
    invitation.target_user_id = actor
    or (
      invitation.target_type = 'email'
      and invitation.target_normalized = actor_email::public.citext
    )
    or (
      invitation.target_type = 'username'
      and invitation.target_normalized = actor_username::public.citext
    )
  ) then
    raise exception using errcode = '22023', message = 'Invitation not found';
  end if;

  if invitation.state = 'accepted'
    and invitation.accepted_by = actor
    and decision = 'accept'
  then
    return query
    select b.id, b.name, bm.role, 'accepted'::text
    from public.businesses b
    join public.business_members bm
      on bm.business_id = b.id
     and bm.user_id = actor
     and bm.status = 'active'
    where b.id = invitation.business_id;
    return;
  elsif invitation.state = 'declined' and decision = 'decline' then
    return query
    select b.id, b.name, invitation.role, 'declined'::text
    from public.businesses b
    where b.id = invitation.business_id;
    return;
  elsif invitation.state <> 'pending' then
    raise exception using errcode = '22023', message = 'Invitation is no longer pending';
  end if;

  if invitation.expires_at <= now() then
    raise exception using errcode = '22023', message = 'INVITATION_EXPIRED';
  end if;

  perform private.consume_rate_limit(actor, 'business_invitation_response', 30, 86400);

  if decision = 'accept' then
    insert into public.business_members (
      business_id,
      user_id,
      role,
      status,
      invited_by,
      accepted_at,
      revoked_at
    )
    values (
      invitation.business_id,
      actor,
      invitation.role,
      'active',
      invitation.invited_by,
      now(),
      null
    )
    on conflict (business_id, user_id)
    do update set
      role = case
        when public.business_members.status = 'active'
          then public.business_members.role
        else excluded.role
      end,
      status = 'active',
      invited_by = excluded.invited_by,
      accepted_at = coalesce(public.business_members.accepted_at, now()),
      revoked_at = null;

    update private.business_invitations bi
    set state = 'accepted',
        target_user_id = actor,
        accepted_by = actor,
        responded_at = now(),
        updated_at = now()
    where bi.id = invitation.id;

    select bm.role
    into assigned_role
    from public.business_members bm
    where bm.business_id = invitation.business_id
      and bm.user_id = actor
      and bm.status = 'active';
  else
    update private.business_invitations bi
    set state = 'declined',
        target_user_id = coalesce(bi.target_user_id, actor),
        accepted_by = null,
        responded_at = now(),
        updated_at = now()
    where bi.id = invitation.id;
    assigned_role := invitation.role;
  end if;

  perform private.write_audit_event(
    actor,
    invitation.business_id,
    case
      when decision = 'accept' then 'business.invitation_accepted'
      else 'business.invitation_declined'
    end,
    'business_invitation',
    invitation.id::text,
    jsonb_build_object('role', assigned_role::text)
  );

  return query
  select
    b.id,
    b.name,
    assigned_role,
    case when decision = 'accept' then 'accepted' else 'declined' end
  from public.businesses b
  where b.id = invitation.business_id;
end;
$$;

revoke all on function public.respond_business_invitation(uuid, text) from public;
grant execute on function public.respond_business_invitation(uuid, text) to authenticated;

create or replace function public.set_business_member_role(
  target_business_id uuid,
  target_member_public_id uuid,
  next_role public.member_role
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_user_id uuid;
  previous_role public.member_role;
begin
  perform private.require_aal2();

  perform 1
  from public.businesses b
  where b.id = target_business_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Business not found';
  end if;

  if not private.is_business_member(
    target_business_id,
    actor,
    array['owner']::public.member_role[]
  ) then
    raise exception using errcode = '42501', message = 'Business owner role required';
  end if;
  if next_role not in ('manager', 'staff') then
    raise exception using errcode = '42501', message = 'Ownership must use the transfer workflow';
  end if;

  select p.user_id, bm.role
  into target_user_id, previous_role
  from public.profiles p
  join public.business_members bm on bm.user_id = p.user_id
  where p.public_id = target_member_public_id
    and bm.business_id = target_business_id
    and bm.status = 'active'
  for update of bm;

  if target_user_id is null or previous_role = 'owner' then
    raise exception using errcode = '22023', message = 'Eligible team member not found';
  end if;

  perform private.consume_rate_limit(actor, 'business_member_role_change', 30, 3600);

  update public.business_members bm
  set role = next_role
  where bm.business_id = target_business_id
    and bm.user_id = target_user_id;

  perform private.write_audit_event(
    actor,
    target_business_id,
    'business.member_role_changed',
    'business_member',
    target_member_public_id::text,
    jsonb_build_object(
      'previous_role', previous_role::text,
      'next_role', next_role::text
    )
  );
end;
$$;

revoke all on function public.set_business_member_role(
  uuid,
  uuid,
  public.member_role
) from public;
grant execute on function public.set_business_member_role(
  uuid,
  uuid,
  public.member_role
) to authenticated;

create or replace function public.revoke_business_member(
  target_business_id uuid,
  target_member_public_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role public.member_role;
  target_user_id uuid;
  target_role public.member_role;
  target_status text;
begin
  perform private.require_aal2();

  perform 1
  from public.businesses b
  where b.id = target_business_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Business not found';
  end if;

  select bm.role
  into actor_role
  from public.business_members bm
  where bm.business_id = target_business_id
    and bm.user_id = actor
    and bm.status = 'active';

  select p.user_id, bm.role, bm.status
  into target_user_id, target_role, target_status
  from public.profiles p
  join public.business_members bm on bm.user_id = p.user_id
  where p.public_id = target_member_public_id
    and bm.business_id = target_business_id
  for update of bm;

  if target_user_id is null or target_role = 'owner' then
    raise exception using errcode = '22023', message = 'Eligible team member not found';
  end if;
  if actor_role = 'owner' then
    null;
  elsif actor_role = 'manager' and target_role = 'staff' then
    null;
  else
    raise exception using errcode = '42501', message = 'Insufficient team role';
  end if;

  if target_status = 'revoked' then
    return;
  elsif target_status <> 'active' then
    raise exception using errcode = '22023', message = 'Eligible team member not found';
  end if;

  perform private.consume_rate_limit(actor, 'business_member_revoke', 30, 3600);

  update public.business_members bm
  set status = 'revoked',
      revoked_at = now()
  where bm.business_id = target_business_id
    and bm.user_id = target_user_id;

  perform private.write_audit_event(
    actor,
    target_business_id,
    'business.member_revoked',
    'business_member',
    target_member_public_id::text,
    jsonb_build_object('role', target_role::text)
  );
end;
$$;

revoke all on function public.revoke_business_member(uuid, uuid) from public;
grant execute on function public.revoke_business_member(uuid, uuid) to authenticated;

create or replace function public.revoke_business_invitation(
  target_business_id uuid,
  target_invitation_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role public.member_role;
  invitation_role public.member_role;
  invitation_state text;
begin
  perform private.require_aal2();

  perform 1
  from public.businesses b
  where b.id = target_business_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Business not found';
  end if;

  select bm.role
  into actor_role
  from public.business_members bm
  where bm.business_id = target_business_id
    and bm.user_id = actor
    and bm.status = 'active';

  select bi.role, bi.state
  into invitation_role, invitation_state
  from private.business_invitations bi
  where bi.id = target_invitation_id
    and bi.business_id = target_business_id
  for update;

  if invitation_role is null then
    raise exception using errcode = '22023', message = 'Invitation not found';
  end if;
  if actor_role = 'owner' then
    null;
  elsif actor_role = 'manager' and invitation_role = 'staff' then
    null;
  else
    raise exception using errcode = '42501', message = 'Insufficient team role';
  end if;

  if invitation_state = 'revoked' then
    return;
  elsif invitation_state <> 'pending' or not exists (
    select 1
    from private.business_invitations bi
    where bi.id = target_invitation_id
      and bi.expires_at > now()
  ) then
    raise exception using errcode = '22023', message = 'Pending invitation not found';
  end if;

  perform private.consume_rate_limit(actor, 'business_invitation_revoke', 30, 3600);

  update private.business_invitations bi
  set state = 'revoked',
      accepted_by = null,
      responded_at = now(),
      updated_at = now()
  where bi.id = target_invitation_id;

  perform private.write_audit_event(
    actor,
    target_business_id,
    'business.invitation_revoked',
    'business_invitation',
    target_invitation_id::text,
    jsonb_build_object('role', invitation_role::text)
  );
end;
$$;

revoke all on function public.revoke_business_invitation(uuid, uuid) from public;
grant execute on function public.revoke_business_invitation(uuid, uuid) to authenticated;

create or replace function public.transfer_business_ownership(
  target_business_id uuid,
  target_member_public_id uuid,
  idempotency_key text
)
returns table (
  previous_owner_public_id uuid,
  new_owner_public_id uuid,
  previous_owner_role public.member_role,
  new_owner_role public.member_role
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_public_id uuid;
  target_user_id uuid;
  target_previous_role public.member_role;
  key_hash text;
  supplied_request_hash text;
  stored_request_hash text;
  existing_response_id uuid;
begin
  perform private.require_aal2();
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;

  key_hash := private.idempotency_key_hash(idempotency_key);
  supplied_request_hash := private.json_request_hash(jsonb_build_object(
    'business_id', target_business_id,
    'target_member_public_id', target_member_public_id
  ));
  perform private.lock_idempotency_request(actor, 'business_ownership_transfer', key_hash);

  select receipt.response_id, receipt.request_hash
  into existing_response_id, stored_request_hash
  from private.action_idempotency_receipts receipt
  where receipt.actor_id = actor
    and receipt.action = 'business_ownership_transfer'
    and receipt.idempotency_key_hash = key_hash;

  select p.public_id
  into actor_public_id
  from public.profiles p
  where p.user_id = actor;

  if existing_response_id is not null then
    if stored_request_hash is distinct from supplied_request_hash then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return query
    select
      actor_public_id,
      existing_response_id,
      'manager'::public.member_role,
      'owner'::public.member_role;
    return;
  end if;

  perform 1
  from public.businesses b
  where b.id = target_business_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Business not found';
  end if;

  if not private.is_business_member(
    target_business_id,
    actor,
    array['owner']::public.member_role[]
  ) then
    raise exception using errcode = '42501', message = 'Business owner role required';
  end if;

  select p.user_id, bm.role
  into target_user_id, target_previous_role
  from public.profiles p
  join public.business_members bm on bm.user_id = p.user_id
  where p.public_id = target_member_public_id
    and bm.business_id = target_business_id
    and bm.status = 'active'
  for update of bm;

  if target_user_id is null
    or target_user_id = actor
    or target_previous_role not in ('manager', 'staff')
  then
    raise exception using errcode = '22023', message = 'Eligible ownership recipient not found';
  end if;

  perform private.consume_rate_limit(actor, 'business_ownership_transfer', 5, 86400);

  -- Promote first, then demote, so the invariant is true after every statement as
  -- well as at transaction commit.
  update public.business_members bm
  set role = 'owner'
  where bm.business_id = target_business_id
    and bm.user_id = target_user_id;

  update public.business_members bm
  set role = 'manager'
  where bm.business_id = target_business_id
    and bm.user_id = actor
    and bm.role = 'owner'
    and bm.status = 'active';

  insert into private.action_idempotency_receipts (
    actor_id,
    action,
    idempotency_key_hash,
    request_hash,
    response_id
  )
  values (
    actor,
    'business_ownership_transfer',
    key_hash,
    supplied_request_hash,
    target_member_public_id
  );

  perform private.write_audit_event(
    actor,
    target_business_id,
    'business.ownership_transferred',
    'business_member',
    target_member_public_id::text,
    jsonb_build_object(
      'previous_owner_public_id', actor_public_id,
      'recipient_previous_role', target_previous_role::text
    )
  );

  return query
  select
    actor_public_id,
    target_member_public_id,
    'manager'::public.member_role,
    'owner'::public.member_role;
end;
$$;

revoke all on function public.transfer_business_ownership(uuid, uuid, text) from public;
grant execute on function public.transfer_business_ownership(uuid, uuid, text) to authenticated;

create or replace function public.get_business_audit_events(
  target_business_id uuid,
  result_limit integer default 50,
  result_offset integer default 0
)
returns table (
  event_id bigint,
  actor_public_id uuid,
  actor_display_name text,
  event_type text,
  target_type text,
  target_id text,
  metadata jsonb,
  created_at timestamptz,
  has_more boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  perform private.require_aal2();
  if not private.is_business_member(
    target_business_id,
    actor,
    array['owner']::public.member_role[]
  ) then
    raise exception using errcode = '42501', message = 'Business owner role required';
  end if;

  return query
  with page as materialized (
    select
      ae.id as event_id,
      p.public_id as actor_public_id,
      p.display_name as actor_display_name,
      ae.event_type,
      ae.target_type,
      ae.target_id,
      ae.metadata,
      ae.created_at
    from public.audit_events ae
    left join public.profiles p on p.user_id = ae.actor_id
    where ae.business_id = target_business_id
    order by ae.created_at desc, ae.id desc
    offset least(greatest(coalesce(result_offset, 0), 0), 10000)
    limit least(greatest(coalesce(result_limit, 50), 1), 100) + 1
  )
  select
    page.event_id,
    page.actor_public_id,
    page.actor_display_name,
    page.event_type,
    page.target_type,
    page.target_id,
    page.metadata,
    page.created_at,
    (
      select count(*) >
        least(greatest(coalesce(result_limit, 50), 1), 100)
      from page page_count
    ) as has_more
  from page
  order by page.created_at desc, page.event_id desc
  limit least(greatest(coalesce(result_limit, 50), 1), 100);
end;
$$;

revoke all on function public.get_business_audit_events(uuid, integer, integer)
  from public;
grant execute on function public.get_business_audit_events(uuid, integer, integer)
  to authenticated;

create or replace function private.validate_report_target()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_exists boolean := false;
begin
  new.detail := nullif(btrim(new.detail), '');

  case new.target_type
    when 'business' then
      select private.is_business_publicly_eligible(new.target_id)
        and not private.is_business_member(new.target_id, new.reporter_id)
        into target_exists;
    when 'review' then
      select exists (
        select 1
        from public.reviews r
        where r.id = new.target_id
          and r.moderation = 'approved'
          and r.deleted_at is null
          and r.author_id <> new.reporter_id
          and private.is_business_publicly_eligible(r.business_id)
      )
        into target_exists;
    when 'response' then
      select exists (
        select 1
        from public.business_responses br
        join public.reviews r
          on r.id = br.review_id
         and r.business_id = br.business_id
        where br.review_id = new.target_id
          and br.moderation = 'approved'
          and (br.author_id is null or br.author_id <> new.reporter_id)
          and r.moderation = 'approved'
          and r.deleted_at is null
          and private.is_business_publicly_eligible(br.business_id)
      )
        into target_exists;
    when 'update' then
      select exists (
        select 1
        from public.business_updates bu
        where bu.id = new.target_id
          and bu.moderation = 'approved'
          and bu.starts_at <= now()
          and bu.expires_at > now()
          and (bu.author_id is null or bu.author_id <> new.reporter_id)
          and private.is_business_publicly_eligible(bu.business_id)
      )
        into target_exists;
    when 'media' then
      select exists (
        select 1
        from public.media_assets ma
        where ma.id = new.target_id
          and ma.owner_id <> new.reporter_id
          and private.is_media_publicly_eligible(ma.id)
      )
        into target_exists;
    when 'user' then
      select exists (
        select 1
        from public.profiles p
        where p.user_id = new.target_id
          and p.user_id <> new.reporter_id
          and p.status = 'active'
      )
        into target_exists;
  end case;

  if not target_exists then
    raise exception using errcode = '22023', message = 'INVALID_REPORT_TARGET';
  end if;
  return new;
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
declare
  actor uuid := auth.uid();
  status_expiry timestamptz;
begin
  perform private.require_aal2();
  perform 1
  from public.businesses b
  where b.id = target_business_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Business not found';
  end if;

  if not private.is_business_member(target_business_id, actor) then
    raise exception using errcode = '42501', message = 'Business membership required';
  end if;
  if not private.is_business_publicly_eligible(target_business_id) then
    raise exception using errcode = '22023', message = 'Business is not publicly eligible';
  end if;

  perform private.consume_rate_limit(actor, 'business_live_status', 30, 3600);
  status_expiry := now() + case when next_status = 'closed' then interval '24 hours' else interval '12 hours' end;

  insert into public.business_live_status (
    business_id,
    status,
    confirmed_by,
    confirmed_at,
    expires_at
  )
  values (
    target_business_id,
    next_status,
    actor,
    now(),
    status_expiry
  )
  on conflict (business_id)
  do update set
    status = excluded.status,
    confirmed_by = excluded.confirmed_by,
    confirmed_at = excluded.confirmed_at,
    expires_at = excluded.expires_at;

  perform private.write_audit_event(
    actor,
    target_business_id,
    'business.live_status_changed',
    'business',
    target_business_id::text,
    jsonb_build_object('status', next_status::text, 'expires_at', status_expiry)
  );
end;
$$;

revoke all on function public.set_business_live_status(uuid, public.live_business_status) from public;
grant execute on function public.set_business_live_status(uuid, public.live_business_status) to authenticated;

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
  actor uuid := auth.uid();
  target_business_id uuid;
begin
  perform private.require_aal2();
  if next_availability not in ('available', 'sold_out') then
    raise exception using errcode = '22023', message = 'Invalid live menu availability';
  end if;

  select ms.business_id
  into target_business_id
  from public.menu_items mi
  join public.menu_sections ms on ms.id = mi.section_id
  join public.businesses b on b.id = ms.business_id
  where mi.id = target_menu_item_id
    and mi.is_published
    and ms.is_published
    and b.state = 'published';

  if target_business_id is null then
    raise exception using errcode = '42501', message = 'Published menu owner or manager role required';
  end if;

  perform 1
  from public.businesses b
  where b.id = target_business_id
  for update;

  perform 1
  from public.menu_items mi
  join public.menu_sections ms on ms.id = mi.section_id
  join public.businesses b on b.id = ms.business_id
  where mi.id = target_menu_item_id
    and ms.business_id = target_business_id
    and mi.is_published
    and ms.is_published
    and b.state = 'published'
  for update of mi;

  if not found
    or not private.is_business_member(
      target_business_id,
      actor,
      array['owner', 'manager']::public.member_role[]
    )
  then
    raise exception using errcode = '42501', message = 'Published menu owner or manager role required';
  end if;

  perform private.consume_rate_limit(actor, 'menu_live_availability', 60, 3600);

  update public.menu_items
  set availability = next_availability
  where id = target_menu_item_id;

  perform private.write_audit_event(
    actor,
    target_business_id,
    'business.menu_availability_changed',
    'menu_item',
    target_menu_item_id::text,
    jsonb_build_object('availability', next_availability)
  );
end;
$$;

revoke all on function public.set_menu_item_availability(uuid, text) from public;
grant execute on function public.set_menu_item_availability(uuid, text) to authenticated;

create or replace function public.schedule_mobile_stop(
  target_business_id uuid,
  target_location_id uuid,
  stop_starts_at timestamptz,
  stop_ends_at timestamptz,
  target_stop_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  saved_stop_id uuid;
  next_stop_state text;
  existing_starts_at timestamptz;
  existing_state text;
begin
  perform private.require_aal2();

  perform 1
  from public.businesses b
  where b.id = target_business_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Business not found';
  end if;

  if not private.is_business_member(
    target_business_id,
    actor,
    array['owner', 'manager']::public.member_role[]
  ) then
    raise exception using errcode = '42501', message = 'Business owner or manager role required';
  end if;
  if not exists (
    select 1
    from public.businesses b
    where b.id = target_business_id
      and b.state = 'published'
      and b.kind in ('food_truck', 'pop_up')
  ) or not private.is_published_business_location(target_location_id, target_business_id) then
    raise exception using errcode = '22023', message = 'Published mobile business location required';
  end if;

  if target_stop_id is not null then
    select ms.starts_at, ms.state
    into existing_starts_at, existing_state
    from public.mobile_stops ms
    where ms.id = target_stop_id
      and ms.business_id = target_business_id
      and ms.state in ('draft', 'scheduled', 'live')
    for update;

    if existing_starts_at is null then
      raise exception using errcode = '22023', message = 'Editable mobile stop not found';
    end if;
  end if;

  if stop_starts_at is null
    or stop_ends_at is null
    or (
      stop_starts_at < now() - interval '15 minutes'
      and not (
        target_stop_id is not null
        and existing_state = 'live'
        and stop_starts_at = existing_starts_at
      )
    )
    or stop_starts_at > now() + interval '90 days'
    or stop_ends_at <= stop_starts_at
    or stop_ends_at > stop_starts_at + interval '7 days'
  then
    raise exception using errcode = '22023', message = 'Invalid mobile stop window';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('mobile_stop:' || target_business_id::text, 0)
  );
  if exists (
    select 1
    from public.mobile_stops ms
    where ms.business_id = target_business_id
      and ms.state in ('scheduled', 'live')
      and (target_stop_id is null or ms.id <> target_stop_id)
      and tstzrange(ms.starts_at, ms.ends_at, '[)')
        && tstzrange(stop_starts_at, stop_ends_at, '[)')
  ) then
    raise exception using errcode = '23P01', message = 'MOBILE_STOP_TIME_OVERLAP';
  end if;

  perform private.consume_rate_limit(actor, 'mobile_stop_schedule', 60, 3600);
  next_stop_state := case
    when now() between stop_starts_at and stop_ends_at then 'live'
    else 'scheduled'
  end;

  if target_stop_id is null then
    insert into public.mobile_stops (
      business_id,
      location_id,
      starts_at,
      ends_at,
      state,
      confirmed_at
    )
    values (
      target_business_id,
      target_location_id,
      stop_starts_at,
      stop_ends_at,
      next_stop_state,
      now()
    )
    returning id into saved_stop_id;
  else
    update public.mobile_stops
    set location_id = target_location_id,
        starts_at = stop_starts_at,
        ends_at = stop_ends_at,
        state = next_stop_state,
        confirmed_at = now()
    where id = target_stop_id
      and business_id = target_business_id
      and state in ('draft', 'scheduled', 'live')
    returning id into saved_stop_id;

    if saved_stop_id is null then
      raise exception using errcode = '22023', message = 'Editable mobile stop not found';
    end if;
  end if;

  perform private.write_audit_event(
    actor,
    target_business_id,
    'business.mobile_stop_scheduled',
    'mobile_stop',
    saved_stop_id::text,
    jsonb_build_object(
      'location_id', target_location_id,
      'starts_at', stop_starts_at,
      'ends_at', stop_ends_at,
      'state', next_stop_state
    )
  );
  return saved_stop_id;
end;
$$;

revoke all on function public.schedule_mobile_stop(uuid, uuid, timestamptz, timestamptz, uuid) from public;
grant execute on function public.schedule_mobile_stop(uuid, uuid, timestamptz, timestamptz, uuid) to authenticated;

create or replace function public.cancel_mobile_stop(target_stop_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_business_id uuid;
begin
  perform private.require_aal2();

  select ms.business_id
  into target_business_id
  from public.mobile_stops ms
  join public.businesses b on b.id = ms.business_id
  where ms.id = target_stop_id
    and ms.state in ('draft', 'scheduled', 'live')
    and b.state = 'published';

  if target_business_id is null then
    raise exception using errcode = '42501', message = 'Editable mobile stop owner or manager role required';
  end if;

  perform 1
  from public.businesses b
  where b.id = target_business_id
  for update;

  perform 1
  from public.mobile_stops ms
  join public.businesses b on b.id = ms.business_id
  where ms.id = target_stop_id
    and ms.business_id = target_business_id
    and ms.state in ('draft', 'scheduled', 'live')
    and b.state = 'published'
  for update of ms;

  if not found
    or not private.is_business_member(
      target_business_id,
      actor,
      array['owner', 'manager']::public.member_role[]
    )
  then
    raise exception using errcode = '42501', message = 'Editable mobile stop owner or manager role required';
  end if;

  perform private.consume_rate_limit(actor, 'mobile_stop_cancel', 30, 3600);

  update public.mobile_stops
  set state = 'cancelled',
      confirmed_at = now()
  where id = target_stop_id;

  perform private.write_audit_event(
    actor,
    target_business_id,
    'business.mobile_stop_cancelled',
    'mobile_stop',
    target_stop_id::text,
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.cancel_mobile_stop(uuid) from public;
grant execute on function public.cancel_mobile_stop(uuid) to authenticated;

create or replace function public.create_mobile_stop_location(
  target_business_id uuid,
  payload jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  location_id uuid;
  location_label text;
  location_address text;
  location_city text;
  location_region text;
  location_postal text;
  location_latitude double precision;
  location_longitude double precision;
  location_public_address boolean;
  location_is_approximate boolean;
begin
  perform private.require_aal2();
  if not private.is_business_member(
    target_business_id,
    actor,
    array['owner', 'manager']::public.member_role[]
  ) or not exists (
    select 1
    from public.businesses b
    where b.id = target_business_id
      and b.state = 'published'
      and b.kind in ('food_truck', 'pop_up')
  ) then
    raise exception using errcode = '42501', message = 'Published mobile business owner or manager role required';
  end if;
  if payload is null or jsonb_typeof(payload) <> 'object' or exists (
    select 1
    from jsonb_object_keys(payload) supplied(key)
    where supplied.key not in (
      'label',
      'address_line',
      'city',
      'region',
      'postal_code',
      'latitude',
      'longitude',
      'public_address',
      'is_approximate'
    )
  ) then
    raise exception using errcode = '22023', message = 'Invalid mobile location payload';
  end if;

  location_label := btrim(coalesce(payload ->> 'label', ''));
  location_address := nullif(btrim(payload ->> 'address_line'), '');
  location_city := btrim(coalesce(payload ->> 'city', ''));
  location_region := btrim(coalesce(payload ->> 'region', ''));
  location_postal := nullif(btrim(payload ->> 'postal_code'), '');
  begin
    location_latitude := (payload ->> 'latitude')::double precision;
    location_longitude := (payload ->> 'longitude')::double precision;
    location_public_address := coalesce((payload ->> 'public_address')::boolean, true);
    location_is_approximate := coalesce((payload ->> 'is_approximate')::boolean, false);
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = '22023', message = 'Invalid mobile location coordinate';
  end;

  if char_length(location_label) not between 1 and 120
    or char_length(location_city) not between 1 and 120
    or char_length(location_region) not between 1 and 80
    or (location_address is not null and char_length(location_address) > 300)
    or (location_postal is not null and char_length(location_postal) > 24)
    or location_latitude not between -90 and 90
    or location_longitude not between -180 and 180
    or not private.content_is_professional(
      concat_ws(' ', location_label, location_address, location_city, location_region)
    )
  then
    raise exception using errcode = '22023', message = 'Invalid mobile location';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('mobile_location:' || target_business_id::text, 0)
  );
  if (
    select count(*)
    from public.business_locations bl
    where bl.business_id = target_business_id
      and bl.publication_state <> 'archived'
  ) >= 50 then
    raise exception using errcode = '54000', message = 'MOBILE_LOCATION_LIMIT_REACHED';
  end if;

  select bl.id
  into location_id
  from public.business_locations bl
  where bl.business_id = target_business_id
    and bl.publication_state = 'published'
    and lower(bl.label) = lower(location_label)
    and public.st_dwithin(
      bl.point,
      public.st_setsrid(
        public.st_makepoint(location_longitude, location_latitude),
        4326
      )::public.geography,
      25
    )
  order by bl.updated_at desc
  limit 1;

  if location_id is not null then
    return location_id;
  end if;

  perform private.consume_rate_limit(actor, 'mobile_location_create', 20, 86400);
  perform set_config('spottr.mobile_location_business_id', target_business_id::text, true);

  insert into public.business_locations (
    business_id,
    label,
    address_line,
    city,
    region,
    postal_code,
    point,
    is_primary,
    is_approximate,
    public_address,
    publication_state
  )
  values (
    target_business_id,
    location_label,
    location_address,
    location_city,
    location_region,
    location_postal,
    public.st_setsrid(
      public.st_makepoint(location_longitude, location_latitude),
      4326
    )::public.geography,
    false,
    location_is_approximate,
    location_public_address,
    'published'
  )
  returning id into location_id;

  perform private.write_audit_event(
    actor,
    target_business_id,
    'business.mobile_location_created',
    'business_location',
    location_id::text,
    jsonb_build_object(
      'public_address', location_public_address,
      'is_approximate', location_is_approximate
    )
  );
  return location_id;
end;
$$;

revoke all on function public.create_mobile_stop_location(uuid, jsonb) from public;
grant execute on function public.create_mobile_stop_location(uuid, jsonb) to authenticated;

create or replace function public.create_business_draft(payload jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  request_hash text;
  existing_business_id uuid;
  new_business_id uuid := gen_random_uuid();
  target_kind public.business_kind;
  target_name text;
  target_description text;
  target_cuisines text[];
  target_email public.citext;
  target_phone text;
  target_website text;
  target_address text;
  target_city text;
  target_region text;
  target_postal text;
  target_timezone text;
  target_payments public.payment_kind[];
  target_permit text;
  target_jurisdiction_id uuid;
  slug_base text;
begin
  perform private.require_aal2();
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception using errcode = '22023', message = 'Payload must be a JSON object';
  end if;
  if exists (
    select 1
    from jsonb_object_keys(payload) as supplied(key)
    where supplied.key not in (
      'kind',
      'name',
      'description',
      'cuisine_labels',
      'business_email',
      'business_phone',
      'website_url',
      'address_line',
      'city',
      'region',
      'postal_code',
      'payments',
      'permit_number',
      'timezone'
    )
  ) then
    raise exception using errcode = '22023', message = 'Payload contains unsupported fields';
  end if;

  request_hash := pg_catalog.encode(extensions.digest(payload::text, 'sha256'), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(actor::text || ':create_business_draft:' || request_hash, 0)
  );

  select ri.response_id
  into existing_business_id
  from private.rpc_idempotency ri
  where ri.actor_id = actor
    and ri.action = 'create_business_draft'
    and ri.request_hash = request_hash;

  if existing_business_id is not null then
    return existing_business_id;
  end if;

  perform private.consume_rate_limit(actor, 'create_business_draft', 5, 86400);

  if payload ->> 'kind' is null
    or payload ->> 'kind' not in ('food_truck', 'restaurant', 'pop_up', 'cafe_bakery', 'home_kitchen')
  then
    raise exception using errcode = '22023', message = 'Invalid business kind';
  end if;
  target_kind := (payload ->> 'kind')::public.business_kind;
  target_name := btrim(coalesce(payload ->> 'name', ''));
  target_description := btrim(coalesce(payload ->> 'description', ''));
  target_email := nullif(btrim(payload ->> 'business_email'), '')::public.citext;
  target_phone := nullif(btrim(payload ->> 'business_phone'), '');
  target_website := nullif(btrim(payload ->> 'website_url'), '');
  target_address := nullif(btrim(payload ->> 'address_line'), '');
  target_city := btrim(coalesce(payload ->> 'city', ''));
  target_region := upper(btrim(coalesce(payload ->> 'region', '')));
  target_postal := nullif(btrim(payload ->> 'postal_code'), '');
  target_timezone := coalesce(nullif(btrim(payload ->> 'timezone'), ''), 'America/Los_Angeles');
  target_permit := nullif(btrim(payload ->> 'permit_number'), '');

  if char_length(target_name) not between 2 and 100
    or char_length(target_description) > 2000
    or char_length(target_city) not between 1 and 120
    or char_length(target_region) not between 1 and 80
    or target_email is null
    or char_length(target_email::text) > 320
    or target_email::text !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or target_phone is null
    or char_length(target_phone) not between 7 and 40
    or target_phone !~ '^\+?\(?[0-9][0-9 ()-]{5,30}( ?(x|ext\.?) ?[0-9]{1,8})?$'
    or (target_website is not null and (char_length(target_website) > 2048 or target_website !~* '^https://'))
    or (target_address is not null and char_length(target_address) > 300)
    or (target_postal is not null and char_length(target_postal) > 24)
    or not exists (select 1 from pg_catalog.pg_timezone_names where name = target_timezone)
  then
    raise exception using errcode = '22023', message = 'Invalid business details';
  end if;

  if not private.content_is_professional(
    concat_ws(' ', target_name, target_description)
  ) then
    raise exception using errcode = '23514', message = 'CONTENT_POLICY_VIOLATION';
  end if;

  if payload ? 'cuisine_labels'
    and jsonb_typeof(payload -> 'cuisine_labels') is distinct from 'array'
  then
    raise exception using errcode = '22023', message = 'cuisine_labels must be an array';
  end if;
  select coalesce(array_agg(distinct btrim(value)) filter (where btrim(value) <> ''), '{}'::text[])
  into target_cuisines
  from jsonb_array_elements_text(coalesce(payload -> 'cuisine_labels', '[]'::jsonb)) as cuisine(value);
  if cardinality(target_cuisines) > 12
    or exists (
      select 1
      from unnest(target_cuisines) label
      where char_length(label) > 60 or not private.content_is_professional(label)
    )
  then
    raise exception using errcode = '22023', message = 'Invalid cuisine labels';
  end if;

  if jsonb_typeof(payload -> 'payments') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'payments must be an array';
  end if;
  if exists (
    select 1
    from jsonb_array_elements_text(payload -> 'payments') payment(value)
    where payment.value not in (
      'cash',
      'visa',
      'mastercard',
      'amex',
      'apple_pay',
      'google_pay',
      'cash_app',
      'venmo'
    )
  ) then
    raise exception using errcode = '22023', message = 'Invalid payment method';
  end if;
  select coalesce(array_agg(distinct value::public.payment_kind), '{}'::public.payment_kind[])
  into target_payments
  from jsonb_array_elements_text(payload -> 'payments') payment(value);
  if cardinality(target_payments) < 1 then
    raise exception using errcode = '22023', message = 'At least one payment method is required';
  end if;

  if target_kind = 'home_kitchen' then
    select j.id
    into target_jurisdiction_id
    from public.jurisdictions j
    where j.country_code = 'US'
      and upper(j.region_code) = target_region
      and (j.locality is null or lower(j.locality) = lower(target_city))
      and j.home_kitchens_enabled
      and j.legal_reviewed_at is not null
    order by (j.locality is not null) desc
    limit 1;

    if target_jurisdiction_id is null or target_permit is null then
      raise exception using errcode = '22023', message = 'HOME_KITCHEN_JURISDICTION_OR_PERMIT_REQUIRED';
    end if;
    if char_length(target_permit) > 160 then
      raise exception using errcode = '22023', message = 'Invalid permit number';
    end if;
  end if;

  slug_base := trim(both '-' from regexp_replace(lower(target_name), '[^a-z0-9]+', '-', 'g'));
  if slug_base = '' then
    slug_base := 'business';
  end if;

  insert into public.businesses (
    id,
    kind,
    name,
    slug,
    description,
    cuisine_labels,
    state,
    verification,
    timezone,
    jurisdiction_id,
    provenance,
    created_by
  )
  values (
    new_business_id,
    target_kind,
    target_name,
    left(slug_base, 100) || '-' || left(replace(new_business_id::text, '-', ''), 12),
    target_description,
    target_cuisines,
    'draft',
    'pending',
    target_timezone,
    target_jurisdiction_id,
    'owner',
    actor
  );

  insert into public.business_members (
    business_id,
    user_id,
    role,
    status,
    accepted_at
  )
  values (new_business_id, actor, 'owner', 'active', now());

  insert into public.business_private_details (
    business_id,
    legal_name,
    business_email,
    business_phone,
    website_url,
    submitted_address_line,
    submitted_city,
    submitted_region,
    submitted_postal_code
  )
  values (
    new_business_id,
    target_name,
    target_email,
    target_phone,
    target_website,
    target_address,
    target_city,
    target_region,
    target_postal
  );

  insert into public.business_payments (business_id, payment)
  select new_business_id, payment
  from unnest(target_payments) payment;

  if target_kind = 'home_kitchen' then
    insert into public.home_kitchen_permits (
      business_id,
      jurisdiction_id,
      permit_number_private,
      issuer,
      expires_on,
      verification
    )
    values (
      new_business_id,
      target_jurisdiction_id,
      target_permit,
      null,
      null,
      'pending'
    );
  end if;

  insert into private.rpc_idempotency (
    actor_id,
    action,
    request_hash,
    response_id
  )
  values (actor, 'create_business_draft', request_hash, new_business_id);

  perform private.write_audit_event(
    actor,
    new_business_id,
    'business.draft_created',
    'business',
    new_business_id::text,
    jsonb_build_object('kind', target_kind::text)
  );

  return new_business_id;
end;
$$;

revoke all on function public.create_business_draft(jsonb) from public;
grant execute on function public.create_business_draft(jsonb) to authenticated;

create or replace function public.update_business_draft_profile(
  target_business_id uuid,
  payload jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  next_name text;
  next_description text;
  next_cuisines text[];
  next_price_level smallint;
  next_timezone text;
  next_business_email public.citext;
  next_business_phone text;
  next_website_url text;
  next_show_phone boolean;
  next_show_website boolean;
  next_logo_asset_id uuid;
begin
  perform private.require_aal2();
  if not private.can_manage_business_draft(target_business_id, actor) then
    raise exception using errcode = '42501', message = 'Draft owner or manager role required';
  end if;
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception using errcode = '22023', message = 'Payload must be a JSON object';
  end if;
  if exists (
    select 1
    from jsonb_object_keys(payload) as supplied(key)
    where supplied.key not in (
      'name',
      'description',
      'cuisine_labels',
      'price_level',
      'timezone',
      'business_email',
      'business_phone',
      'website_url',
      'show_phone_public',
      'show_website_public',
      'logo_asset_id'
    )
  ) then
    raise exception using errcode = '22023', message = 'Payload contains unsupported fields';
  end if;

  select
    b.name,
    b.description,
    b.cuisine_labels,
    b.price_level,
    b.timezone,
    b.logo_asset_id,
    bpd.business_email,
    bpd.business_phone,
    bpd.website_url,
    bpd.show_phone_public,
    bpd.show_website_public
  into
    next_name,
    next_description,
    next_cuisines,
    next_price_level,
    next_timezone,
    next_logo_asset_id,
    next_business_email,
    next_business_phone,
    next_website_url,
    next_show_phone,
    next_show_website
  from public.businesses b
  join public.business_private_details bpd on bpd.business_id = b.id
  where b.id = target_business_id
  for update of b, bpd;

  if payload ? 'name' then
    next_name := btrim(coalesce(payload ->> 'name', ''));
  end if;
  if payload ? 'description' then
    next_description := btrim(coalesce(payload ->> 'description', ''));
  end if;
  if payload ? 'cuisine_labels' then
    if jsonb_typeof(payload -> 'cuisine_labels') is distinct from 'array' then
      raise exception using errcode = '22023', message = 'cuisine_labels must be an array';
    end if;
    select coalesce(
      array_agg(distinct btrim(value)) filter (where btrim(value) <> ''),
      '{}'::text[]
    )
    into next_cuisines
    from jsonb_array_elements_text(payload -> 'cuisine_labels') as cuisine(value);
  end if;
  begin
    if payload ? 'price_level' then
      next_price_level := (payload ->> 'price_level')::smallint;
    end if;
    if payload ? 'show_phone_public' then
      next_show_phone := (payload ->> 'show_phone_public')::boolean;
    end if;
    if payload ? 'show_website_public' then
      next_show_website := (payload ->> 'show_website_public')::boolean;
    end if;
    if payload ? 'logo_asset_id' then
      next_logo_asset_id := case
        when jsonb_typeof(payload -> 'logo_asset_id') = 'null' then null
        else (payload ->> 'logo_asset_id')::uuid
      end;
    end if;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = '22023', message = 'Invalid typed business field';
  end;
  if payload ? 'timezone' then
    next_timezone := btrim(coalesce(payload ->> 'timezone', ''));
  end if;
  if payload ? 'business_email' then
    next_business_email := nullif(btrim(payload ->> 'business_email'), '')::public.citext;
  end if;
  if payload ? 'business_phone' then
    next_business_phone := nullif(btrim(payload ->> 'business_phone'), '');
  end if;
  if payload ? 'website_url' then
    next_website_url := nullif(btrim(payload ->> 'website_url'), '');
  end if;

  if char_length(next_name) not between 2 and 100
    or char_length(next_description) > 2000
    or cardinality(next_cuisines) > 12
    or exists (
      select 1 from unnest(next_cuisines) label
      where char_length(label) > 60 or not private.content_is_professional(label)
    )
    or next_price_level not between 1 and 4
    or not exists (select 1 from pg_catalog.pg_timezone_names where name = next_timezone)
    or next_business_email is null
    or char_length(next_business_email::text) > 320
    or next_business_email::text !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or next_business_phone is null
    or char_length(next_business_phone) not between 7 and 40
    or next_business_phone !~ '^\+?\(?[0-9][0-9 ()-]{5,30}( ?(x|ext\.?) ?[0-9]{1,8})?$'
    or (
      next_website_url is not null
      and (
        char_length(next_website_url) > 2048
        or next_website_url !~* '^https://'
      )
    )
    or (next_show_phone and next_business_phone is null)
    or (next_show_website and next_website_url is null)
    or not private.content_is_professional(concat_ws(' ', next_name, next_description))
  then
    raise exception using errcode = '22023', message = 'Invalid business profile';
  end if;

  -- A draft may nominate its own quarantined logo before scanning completes.
  -- Public projections and publication readiness still require clean+approved.
  if next_logo_asset_id is not null and not exists (
    select 1
    from public.media_assets ma
    where ma.id = next_logo_asset_id
      and ma.business_id = target_business_id
      and ma.owner_id = actor
      and ma.source = 'owner_upload'
      and ma.quarantine_state in ('uploaded', 'scanning', 'clean')
      and ma.moderation in ('pending', 'approved')
  ) then
    raise exception using errcode = '22023', message = 'Logo asset is not eligible';
  end if;

  perform private.consume_rate_limit(actor, 'business_draft_profile_update', 30, 3600);

  update public.businesses
  set name = next_name,
      description = next_description,
      cuisine_labels = next_cuisines,
      price_level = next_price_level,
      timezone = next_timezone,
      logo_asset_id = next_logo_asset_id
  where id = target_business_id;

  update public.business_private_details
  set business_email = next_business_email,
      business_phone = next_business_phone,
      website_url = next_website_url,
      show_phone_public = next_show_phone,
      show_website_public = next_show_website
  where business_id = target_business_id;

  perform private.write_audit_event(
    actor,
    target_business_id,
    'business.draft_profile_updated',
    'business',
    target_business_id::text,
    jsonb_build_object(
      'fields', coalesce(
        (select jsonb_agg(key order by key) from jsonb_object_keys(payload) field(key)),
        '[]'::jsonb
      )
    )
  );
end;
$$;

revoke all on function public.update_business_draft_profile(uuid, jsonb) from public;
grant execute on function public.update_business_draft_profile(uuid, jsonb) to authenticated;

create or replace function public.submit_business_revision(
  target_business_id uuid,
  proposed_patch jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  revision_id uuid;
  target_updated_at timestamptz;
  merged_patch jsonb;
begin
  perform private.require_aal2();

  perform 1
  from public.businesses b
  where b.id = target_business_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Business not found';
  end if;

  if not private.is_business_member(
    target_business_id,
    actor,
    array['owner', 'manager']::public.member_role[]
  ) then
    raise exception using errcode = '42501', message = 'Business owner or manager role required';
  end if;
  if proposed_patch is null
    or jsonb_typeof(proposed_patch) <> 'object'
    or proposed_patch = '{}'::jsonb
    or octet_length(proposed_patch::text) > 32768
  then
    raise exception using errcode = '22023', message = 'Invalid revision patch';
  end if;
  if exists (
    select 1
    from jsonb_object_keys(proposed_patch) as supplied(key)
    where supplied.key not in (
      'profile',
      'contacts',
      'locations',
      'weekly_hours',
      'special_hours',
      'payments',
      'menu'
    )
  ) then
    raise exception using errcode = '22023', message = 'Revision contains unsupported sections';
  end if;

  select b.updated_at
  into target_updated_at
  from public.businesses b
  where b.id = target_business_id
    and b.state = 'published'
  for update;

  if target_updated_at is null then
    raise exception using errcode = '22023', message = 'Only published listings use staged revisions';
  end if;

  perform private.consume_rate_limit(actor, 'business_revision_submit', 10, 86400);

  select brr.id
  into revision_id
  from private.business_revision_requests brr
  where brr.business_id = target_business_id
    and brr.requested_by = actor
    and brr.state = 'pending'
  for update;

  if revision_id is null then
    insert into private.business_revision_requests as inserted (
      business_id,
      requested_by,
      base_updated_at,
      proposed_patch
    )
    values (target_business_id, actor, target_updated_at, proposed_patch)
    returning inserted.id, inserted.proposed_patch
    into revision_id, merged_patch;
  else
    update private.business_revision_requests brr
    set proposed_patch = brr.proposed_patch || $2,
        updated_at = now()
    where brr.id = revision_id
      and octet_length((brr.proposed_patch || $2)::text) <= 32768
    returning brr.proposed_patch into merged_patch;

    if merged_patch is null then
      raise exception using errcode = '22023', message = 'Merged revision patch is too large';
    end if;
  end if;

  perform private.write_audit_event(
    actor,
    target_business_id,
    'business.revision_submitted',
    'business_revision',
    revision_id::text,
    jsonb_build_object(
      'sections', coalesce(
        (select jsonb_agg(key order by key) from jsonb_object_keys(merged_patch) section(key)),
        '[]'::jsonb
      )
    )
  );

  return revision_id;
end;
$$;

revoke all on function public.submit_business_revision(uuid, jsonb) from public;
grant execute on function public.submit_business_revision(uuid, jsonb) to authenticated;

create or replace function public.get_my_pending_business_revision(
  target_business_id uuid
)
returns table (
  revision_id uuid,
  business_id uuid,
  state text,
  sections text[],
  proposed_patch jsonb,
  base_updated_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  perform private.require_aal2();
  if not private.is_business_member(
    target_business_id,
    actor,
    array['owner', 'manager']::public.member_role[]
  ) then
    raise exception using errcode = '42501', message = 'Business owner or manager role required';
  end if;

  return query
  select
    brr.id,
    brr.business_id,
    brr.state,
    array(
      select section.key
      from jsonb_object_keys(brr.proposed_patch) section(key)
      order by section.key
    ),
    brr.proposed_patch,
    brr.base_updated_at,
    brr.created_at,
    brr.updated_at
  from private.business_revision_requests brr
  where brr.business_id = target_business_id
    and brr.requested_by = actor
    and brr.state = 'pending';
end;
$$;

revoke all on function public.get_my_pending_business_revision(uuid) from public;
grant execute on function public.get_my_pending_business_revision(uuid) to authenticated;

create or replace function public.withdraw_business_revision(
  target_revision_id uuid
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
begin
  perform private.require_aal2();

  select brr.business_id
  into target_business_id
  from private.business_revision_requests brr
  where brr.id = target_revision_id
    and brr.requested_by = actor
    and brr.state = 'pending'
  for update;

  if target_business_id is null or not private.is_business_member(
    target_business_id,
    actor,
    array['owner', 'manager']::public.member_role[]
  ) then
    raise exception using errcode = '22023', message = 'Pending revision not found';
  end if;

  perform private.consume_rate_limit(actor, 'business_revision_withdraw', 10, 86400);

  update private.business_revision_requests brr
  set state = 'withdrawn',
      reviewed_at = now(),
      updated_at = now()
  where brr.id = target_revision_id;

  perform private.write_audit_event(
    actor,
    target_business_id,
    'business.revision_withdrawn',
    'business_revision',
    target_revision_id::text,
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.withdraw_business_revision(uuid) from public;
grant execute on function public.withdraw_business_revision(uuid) to authenticated;

create or replace function public.list_pending_business_revisions(
  result_limit integer default 50,
  result_offset integer default 0
)
returns table (
  revision_id uuid,
  business_id uuid,
  business_name text,
  requester_public_id uuid,
  sections text[],
  proposed_patch jsonb,
  base_updated_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  has_more boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  perform private.require_aal2();
  if not private.is_platform_staff(
    actor,
    array['admin']::public.platform_role[]
  ) then
    raise exception using errcode = '42501', message = 'Platform administrator role required';
  end if;

  return query
  with page as materialized (
    select
      brr.id as revision_id,
      brr.business_id,
      b.name as business_name,
      p.public_id as requester_public_id,
      array(
        select section.key
        from jsonb_object_keys(brr.proposed_patch) section(key)
        order by section.key
      ) as sections,
      brr.proposed_patch,
      brr.base_updated_at,
      brr.created_at,
      brr.updated_at
    from private.business_revision_requests brr
    join public.businesses b on b.id = brr.business_id
    left join public.profiles p on p.user_id = brr.requested_by
    where brr.state = 'pending'
    order by brr.updated_at, brr.id
    offset least(greatest(coalesce(result_offset, 0), 0), 10000)
    limit least(greatest(coalesce(result_limit, 50), 1), 100) + 1
  )
  select
    page.revision_id,
    page.business_id,
    page.business_name,
    page.requester_public_id,
    page.sections,
    page.proposed_patch,
    page.base_updated_at,
    page.created_at,
    page.updated_at,
    (
      select count(*) >
        least(greatest(coalesce(result_limit, 50), 1), 100)
      from page page_count
    ) as has_more
  from page
  order by page.updated_at, page.revision_id
  limit least(greatest(coalesce(result_limit, 50), 1), 100);
end;
$$;

revoke all on function public.list_pending_business_revisions(integer, integer) from public;
grant execute on function public.list_pending_business_revisions(integer, integer)
  to authenticated;

create or replace function public.review_business_revision(
  target_revision_id uuid,
  decision text,
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
  target_business_id uuid;
  patch jsonb;
  revision_base_updated_at timestamptz;
  current_business_updated_at timestamptz;
  current_business_state public.business_state;
  normalized_reason text := btrim(coalesce(moderation_reason, ''));
  profile_patch jsonb;
  contacts_patch jsonb;
  weekly_patch jsonb;
  special_patch jsonb;
  payments_patch jsonb;
  locations_patch jsonb;
  menu_patch jsonb;
  location_patch jsonb;
  section_patch jsonb;
  item_patch jsonb;
  new_section_id uuid;
  target_location_id uuid;
  next_location_state public.location_publication_state;
  next_dietary_tags text[];
begin
  perform private.require_aal2();
  if not private.is_platform_staff(
    actor,
    array['admin']::public.platform_role[]
  ) then
    raise exception using errcode = '42501', message = 'Platform administrator role required';
  end if;
  if decision not in ('approved', 'rejected')
    or char_length(normalized_reason) not between 3 and 1000
  then
    raise exception using errcode = '22023', message = 'Invalid revision decision';
  end if;

  select
    brr.business_id,
    brr.proposed_patch,
    brr.base_updated_at,
    b.updated_at,
    b.state
  into
    target_business_id,
    patch,
    revision_base_updated_at,
    current_business_updated_at,
    current_business_state
  from private.business_revision_requests brr
  join public.businesses b on b.id = brr.business_id
  where brr.id = target_revision_id
    and brr.state = 'pending'
  for update of brr, b;

  if target_business_id is null then
    raise exception using errcode = '22023', message = 'Pending business revision not found';
  end if;

  if decision = 'rejected' then
    update private.business_revision_requests
    set state = 'rejected',
        reviewed_by = actor,
        reviewed_at = now(),
        review_reason = normalized_reason,
        updated_at = now()
    where id = target_revision_id;

    perform private.write_audit_event(
      actor,
      target_business_id,
      'business.revision_rejected',
      'business_revision',
      target_revision_id::text,
      jsonb_build_object('reason', normalized_reason)
    );
    return;
  end if;

  if current_business_state <> 'published' then
    raise exception using errcode = '22023', message = 'Revision target is no longer published';
  end if;
  if revision_base_updated_at is distinct from current_business_updated_at then
    raise exception using errcode = '40001', message = 'BUSINESS_REVISION_STALE';
  end if;

  perform set_config('spottr.applying_revision_id', target_revision_id::text, true);

  if patch ? 'profile' then
    profile_patch := patch -> 'profile';
    if jsonb_typeof(profile_patch) <> 'object' or exists (
      select 1
      from jsonb_object_keys(profile_patch) supplied(key)
      where supplied.key not in (
        'name',
        'description',
        'cuisine_labels',
        'price_level',
        'timezone',
        'logo_asset_id'
      )
    ) then
      raise exception using errcode = '22023', message = 'Invalid profile revision';
    end if;

    update public.businesses b
    set name = case
          when profile_patch ? 'name' then btrim(coalesce(profile_patch ->> 'name', ''))
          else b.name
        end,
        description = case
          when profile_patch ? 'description' then btrim(coalesce(profile_patch ->> 'description', ''))
          else b.description
        end,
        cuisine_labels = case
          when profile_patch ? 'cuisine_labels' then array(
            select distinct btrim(value)
            from jsonb_array_elements_text(profile_patch -> 'cuisine_labels') cuisine(value)
            where btrim(value) <> ''
          )
          else b.cuisine_labels
        end,
        price_level = case
          when profile_patch ? 'price_level' then (profile_patch ->> 'price_level')::smallint
          else b.price_level
        end,
        timezone = case
          when profile_patch ? 'timezone' then btrim(coalesce(profile_patch ->> 'timezone', ''))
          else b.timezone
        end,
        logo_asset_id = case
          when not (profile_patch ? 'logo_asset_id') then b.logo_asset_id
          when jsonb_typeof(profile_patch -> 'logo_asset_id') = 'null' then null
          else (profile_patch ->> 'logo_asset_id')::uuid
        end
    where b.id = target_business_id;
  end if;

  if patch ? 'contacts' then
    contacts_patch := patch -> 'contacts';
    if jsonb_typeof(contacts_patch) <> 'object' or exists (
      select 1
      from jsonb_object_keys(contacts_patch) supplied(key)
      where supplied.key not in (
        'business_email',
        'business_phone',
        'website_url',
        'show_phone_public',
        'show_website_public'
      )
    ) then
      raise exception using errcode = '22023', message = 'Invalid contact revision';
    end if;

    update public.business_private_details bpd
    set business_email = case
          when contacts_patch ? 'business_email'
          then nullif(btrim(contacts_patch ->> 'business_email'), '')::public.citext
          else bpd.business_email
        end,
        business_phone = case
          when contacts_patch ? 'business_phone'
          then nullif(btrim(contacts_patch ->> 'business_phone'), '')
          else bpd.business_phone
        end,
        website_url = case
          when contacts_patch ? 'website_url'
          then nullif(btrim(contacts_patch ->> 'website_url'), '')
          else bpd.website_url
        end,
        show_phone_public = case
          when contacts_patch ? 'show_phone_public'
          then (contacts_patch ->> 'show_phone_public')::boolean
          else bpd.show_phone_public
        end,
        show_website_public = case
          when contacts_patch ? 'show_website_public'
          then (contacts_patch ->> 'show_website_public')::boolean
          else bpd.show_website_public
        end
    where bpd.business_id = target_business_id;

    if exists (
      select 1
      from public.business_private_details bpd
      where bpd.business_id = target_business_id
        and (
          (bpd.show_phone_public and bpd.business_phone is null)
          or (bpd.show_website_public and bpd.website_url is null)
        )
    ) then
      raise exception using errcode = '22023', message = 'Public contact value required';
    end if;
  end if;

  if patch ? 'weekly_hours' then
    weekly_patch := patch -> 'weekly_hours';
    if jsonb_typeof(weekly_patch) <> 'array'
      or jsonb_array_length(weekly_patch) <> 7
      or exists (
        select 1
        from jsonb_array_elements(weekly_patch) entry(value)
        cross join lateral jsonb_object_keys(entry.value) supplied(key)
        where jsonb_typeof(entry.value) <> 'object'
          or supplied.key not in ('weekday', 'opens_at', 'closes_at', 'is_closed')
      )
      or (
        select count(distinct (entry.value ->> 'weekday')::smallint)
        from jsonb_array_elements(weekly_patch) entry(value)
      ) <> 7
    then
      raise exception using errcode = '22023', message = 'Weekly revision must define seven unique days';
    end if;

    delete from public.weekly_hours where business_id = target_business_id;
    insert into public.weekly_hours (
      business_id,
      weekday,
      opens_at,
      closes_at,
      is_closed
    )
    select
      target_business_id,
      entry.weekday,
      entry.opens_at,
      entry.closes_at,
      entry.is_closed
    from jsonb_to_recordset(weekly_patch) as entry(
      weekday smallint,
      opens_at time,
      closes_at time,
      is_closed boolean
    );
  end if;

  if patch ? 'special_hours' then
    special_patch := patch -> 'special_hours';
    if jsonb_typeof(special_patch) <> 'array'
      or jsonb_array_length(special_patch) > 366
      or exists (
        select 1
        from jsonb_array_elements(special_patch) entry(value)
        cross join lateral jsonb_object_keys(entry.value) supplied(key)
        where jsonb_typeof(entry.value) <> 'object'
          or supplied.key not in ('service_date', 'opens_at', 'closes_at', 'is_closed', 'note')
      )
    then
      raise exception using errcode = '22023', message = 'Invalid special-hours revision';
    end if;

    delete from public.special_hours where business_id = target_business_id;
    insert into public.special_hours (
      business_id,
      service_date,
      opens_at,
      closes_at,
      is_closed,
      note
    )
    select
      target_business_id,
      entry.service_date,
      entry.opens_at,
      entry.closes_at,
      entry.is_closed,
      nullif(btrim(entry.note), '')
    from jsonb_to_recordset(special_patch) as entry(
      service_date date,
      opens_at time,
      closes_at time,
      is_closed boolean,
      note text
    );
  end if;

  if patch ? 'payments' then
    payments_patch := patch -> 'payments';
    if jsonb_typeof(payments_patch) <> 'array'
      or jsonb_array_length(payments_patch) not between 1 and 8
      or exists (
        select 1
        from jsonb_array_elements_text(payments_patch) payment(value)
        where payment.value not in (
          'cash',
          'visa',
          'mastercard',
          'amex',
          'apple_pay',
          'google_pay',
          'cash_app',
          'venmo'
        )
      )
    then
      raise exception using errcode = '22023', message = 'Invalid payment revision';
    end if;

    delete from public.business_payments where business_id = target_business_id;
    insert into public.business_payments (business_id, payment)
    select distinct target_business_id, payment.value::public.payment_kind
    from jsonb_array_elements_text(payments_patch) payment(value);
  end if;

  if patch ? 'locations' then
    locations_patch := patch -> 'locations';
    if jsonb_typeof(locations_patch) <> 'array'
      or jsonb_array_length(locations_patch) not between 1 and 50
    then
      raise exception using errcode = '22023', message = 'Invalid location revision';
    end if;

    if exists (
      select 1
      from jsonb_array_elements(locations_patch) entry(value)
      where coalesce((entry.value ->> 'is_primary')::boolean, false)
    ) then
      update public.business_locations
      set is_primary = false
      where business_id = target_business_id
        and is_primary;
    end if;

    for location_patch in
      select entry.value from jsonb_array_elements(locations_patch) entry(value)
    loop
      if jsonb_typeof(location_patch) <> 'object' or exists (
        select 1
        from jsonb_object_keys(location_patch) supplied(key)
        where supplied.key not in (
          'location_id',
          'label',
          'address_line',
          'city',
          'region',
          'postal_code',
          'latitude',
          'longitude',
          'is_primary',
          'is_approximate',
          'public_address',
          'publication_state'
        )
      ) then
        raise exception using errcode = '22023', message = 'Invalid location revision entry';
      end if;

      target_location_id := case
        when not (location_patch ? 'location_id')
          or jsonb_typeof(location_patch -> 'location_id') = 'null'
        then null
        else (location_patch ->> 'location_id')::uuid
      end;
      next_location_state := coalesce(
        nullif(location_patch ->> 'publication_state', '')::public.location_publication_state,
        'published'::public.location_publication_state
      );
      if next_location_state = 'private' then
        raise exception using errcode = '22023', message = 'Approved location must be published or archived';
      end if;

      if target_location_id is null then
        insert into public.business_locations (
          business_id,
          label,
          address_line,
          city,
          region,
          postal_code,
          point,
          is_primary,
          is_approximate,
          public_address,
          publication_state
        )
        values (
          target_business_id,
          btrim(coalesce(location_patch ->> 'label', '')),
          nullif(btrim(location_patch ->> 'address_line'), ''),
          btrim(coalesce(location_patch ->> 'city', '')),
          btrim(coalesce(location_patch ->> 'region', '')),
          nullif(btrim(location_patch ->> 'postal_code'), ''),
          public.st_setsrid(
            public.st_makepoint(
              (location_patch ->> 'longitude')::double precision,
              (location_patch ->> 'latitude')::double precision
            ),
            4326
          )::public.geography,
          coalesce((location_patch ->> 'is_primary')::boolean, false),
          coalesce((location_patch ->> 'is_approximate')::boolean, false),
          coalesce((location_patch ->> 'public_address')::boolean, true),
          next_location_state
        );
      else
        update public.business_locations bl
        set label = btrim(coalesce(location_patch ->> 'label', '')),
            address_line = nullif(btrim(location_patch ->> 'address_line'), ''),
            city = btrim(coalesce(location_patch ->> 'city', '')),
            region = btrim(coalesce(location_patch ->> 'region', '')),
            postal_code = nullif(btrim(location_patch ->> 'postal_code'), ''),
            point = public.st_setsrid(
              public.st_makepoint(
                (location_patch ->> 'longitude')::double precision,
                (location_patch ->> 'latitude')::double precision
              ),
              4326
            )::public.geography,
            is_primary = coalesce((location_patch ->> 'is_primary')::boolean, false),
            is_approximate = coalesce((location_patch ->> 'is_approximate')::boolean, false),
            public_address = coalesce((location_patch ->> 'public_address')::boolean, true),
            publication_state = next_location_state
        where bl.id = target_location_id
          and bl.business_id = target_business_id;
        if not found then
          raise exception using errcode = '22023', message = 'Revision location not found';
        end if;
      end if;
    end loop;
  end if;

  if patch ? 'menu' then
    menu_patch := patch -> 'menu';
    if jsonb_typeof(menu_patch) <> 'array'
      or jsonb_array_length(menu_patch) not between 1 and 30
    then
      raise exception using errcode = '22023', message = 'Invalid menu revision';
    end if;

    delete from public.menu_sections where business_id = target_business_id;

    for section_patch in
      select entry.value from jsonb_array_elements(menu_patch) entry(value)
    loop
      if jsonb_typeof(section_patch) <> 'object'
        or not (section_patch ? 'items')
        or jsonb_typeof(section_patch -> 'items') <> 'array'
        or jsonb_array_length(section_patch -> 'items') not between 1 and 100
        or exists (
          select 1
          from jsonb_object_keys(section_patch) supplied(key)
          where supplied.key not in ('name', 'sort_order', 'items')
        )
      then
        raise exception using errcode = '22023', message = 'Invalid menu section revision';
      end if;

      insert into public.menu_sections (
        business_id,
        name,
        sort_order,
        is_published
      )
      values (
        target_business_id,
        btrim(coalesce(section_patch ->> 'name', '')),
        coalesce((section_patch ->> 'sort_order')::integer, 0),
        true
      )
      returning id into new_section_id;

      for item_patch in
        select entry.value from jsonb_array_elements(section_patch -> 'items') entry(value)
      loop
        if jsonb_typeof(item_patch) <> 'object' or exists (
          select 1
          from jsonb_object_keys(item_patch) supplied(key)
          where supplied.key not in (
            'name',
            'description',
            'price_minor',
            'currency',
            'availability',
            'dietary_tags',
            'allergen_note',
            'sort_order'
          )
        ) then
          raise exception using errcode = '22023', message = 'Invalid menu item revision';
        end if;

        if item_patch ? 'dietary_tags' then
          if jsonb_typeof(item_patch -> 'dietary_tags') <> 'array' then
            raise exception using errcode = '22023', message = 'Invalid dietary tags';
          end if;
          select coalesce(array_agg(distinct btrim(value)), '{}'::text[])
          into next_dietary_tags
          from jsonb_array_elements_text(item_patch -> 'dietary_tags') tag(value)
          where btrim(value) <> '';
        else
          next_dietary_tags := '{}'::text[];
        end if;

        insert into public.menu_items (
          section_id,
          name,
          description,
          price_minor,
          currency,
          availability,
          dietary_tags,
          allergen_note,
          sort_order,
          is_published
        )
        values (
          new_section_id,
          btrim(coalesce(item_patch ->> 'name', '')),
          btrim(coalesce(item_patch ->> 'description', '')),
          (item_patch ->> 'price_minor')::integer,
          upper(coalesce(nullif(item_patch ->> 'currency', ''), 'USD'))::char(3),
          coalesce(nullif(item_patch ->> 'availability', ''), 'available'),
          next_dietary_tags,
          nullif(btrim(item_patch ->> 'allergen_note'), ''),
          coalesce((item_patch ->> 'sort_order')::integer, 0),
          true
        );
      end loop;
    end loop;
  end if;

  perform private.assert_business_publication_ready(target_business_id);

  update public.businesses
  set updated_at = now()
  where id = target_business_id;

  update private.business_revision_requests
  set state = 'approved',
      reviewed_by = actor,
      reviewed_at = now(),
      review_reason = normalized_reason,
      updated_at = now()
  where id = target_revision_id;

  perform private.write_audit_event(
    actor,
    target_business_id,
    'business.revision_approved',
    'business_revision',
    target_revision_id::text,
    jsonb_build_object(
      'reason', normalized_reason,
      'sections', (
        select jsonb_agg(key order by key)
        from jsonb_object_keys(patch) section(key)
      )
    )
  );
end;
$$;

revoke all on function public.review_business_revision(uuid, text, text) from public;
grant execute on function public.review_business_revision(uuid, text, text) to authenticated;

create or replace function public.submit_business_for_review(target_business_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  current_state public.business_state;
  current_kind public.business_kind;
begin
  perform private.require_aal2();

  perform 1
  from public.businesses b
  where b.id = target_business_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Business not found';
  end if;

  if not private.is_business_member(
    target_business_id,
    actor,
    array['owner']::public.member_role[]
  ) then
    raise exception using errcode = '42501', message = 'Business owner role required';
  end if;

  select b.state, b.kind
  into current_state, current_kind
  from public.businesses b
  where b.id = target_business_id
  for update;

  if current_state is null then
    raise exception using errcode = '22023', message = 'Business not found';
  end if;
  if current_state = 'pending' then
    return;
  end if;
  if current_state <> 'draft' then
    raise exception using errcode = '22023', message = 'Only drafts may be submitted';
  end if;
  if not exists (
    select 1
    from public.business_private_details bpd
    where bpd.business_id = target_business_id
      and bpd.business_email is not null
      and bpd.business_phone is not null
  ) or not exists (
    select 1
    from public.business_payments bp
    where bp.business_id = target_business_id
  ) then
    raise exception using errcode = '22023', message = 'Business contact and payment details are required';
  end if;
  if current_kind = 'home_kitchen' and not exists (
    select 1
    from public.home_kitchen_permits hp
    where hp.business_id = target_business_id
  ) then
    raise exception using errcode = '22023', message = 'Home-kitchen permit submission required';
  end if;

  perform private.assert_business_submission_ready(target_business_id);
  perform private.consume_rate_limit(actor, 'submit_business_review', 10, 86400);

  update public.businesses
  set state = 'pending',
      verification = 'pending'
  where id = target_business_id;

  perform private.write_audit_event(
    actor,
    target_business_id,
    'business.submitted_for_review',
    'business',
    target_business_id::text,
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.submit_business_for_review(uuid) from public;
grant execute on function public.submit_business_for_review(uuid) to authenticated;

create or replace function public.list_pending_business_submissions(
  result_limit integer default 50,
  result_offset integer default 0
)
returns table (
  business_id uuid,
  business_name text,
  kind public.business_kind,
  verification public.verification_state,
  owner_public_ids uuid[],
  submission_snapshot jsonb,
  submitted_at timestamptz,
  has_more boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  perform private.require_aal2();
  if not private.is_platform_staff(
    actor,
    array['admin']::public.platform_role[]
  ) then
    raise exception using errcode = '42501', message = 'Platform administrator role required';
  end if;

  return query
  with page as materialized (
    select
      b.id as business_id,
      b.name as business_name,
      b.kind,
      b.verification,
      array(
        select p.public_id
        from public.business_members bm
        join public.profiles p on p.user_id = bm.user_id
        where bm.business_id = b.id
          and bm.role = 'owner'
          and bm.status = 'active'
        order by p.public_id
      ) as owner_public_ids,
      jsonb_build_object(
        'description', b.description,
        'cuisine_labels', b.cuisine_labels,
        'price_level', b.price_level,
        'timezone', b.timezone,
        'jurisdiction_id', b.jurisdiction_id,
        'contacts', (
          select jsonb_build_object(
            'legal_name', bpd.legal_name,
            'business_email', bpd.business_email,
            'business_phone', bpd.business_phone,
            'website_url', bpd.website_url,
            'show_phone_public', bpd.show_phone_public,
            'show_website_public', bpd.show_website_public
          )
          from public.business_private_details bpd
          where bpd.business_id = b.id
        ),
        'location_count', (
          select count(*)::integer
          from public.business_locations bl
          where bl.business_id = b.id
            and bl.publication_state <> 'archived'
        ),
        'weekly_day_count', (
          select count(distinct wh.weekday)::integer
          from public.weekly_hours wh
          where wh.business_id = b.id
        ),
        'payments', (
          select coalesce(jsonb_agg(bp.payment order by bp.payment), '[]'::jsonb)
          from public.business_payments bp
          where bp.business_id = b.id
        ),
        'published_menu_item_count', (
          select count(*)::integer
          from public.menu_sections ms
          join public.menu_items mi on mi.section_id = ms.id
          where ms.business_id = b.id
            and ms.is_published
            and mi.is_published
            and mi.availability <> 'hidden'
        ),
        'logo', (
          select jsonb_build_object(
            'asset_id', ma.id,
            'quarantine_state', ma.quarantine_state,
            'moderation', ma.moderation
          )
          from public.media_assets ma
          where ma.id = b.logo_asset_id
            and ma.business_id = b.id
        )
      ) as submission_snapshot,
      b.updated_at as submitted_at
    from public.businesses b
    where b.state = 'pending'
    order by b.updated_at, b.id
    offset least(greatest(coalesce(result_offset, 0), 0), 10000)
    limit least(greatest(coalesce(result_limit, 50), 1), 100) + 1
  )
  select
    page.business_id,
    page.business_name,
    page.kind,
    page.verification,
    page.owner_public_ids,
    page.submission_snapshot,
    page.submitted_at,
    (
      select count(*) >
        least(greatest(coalesce(result_limit, 50), 1), 100)
      from page page_count
    ) as has_more
  from page
  order by page.submitted_at, page.business_id
  limit least(greatest(coalesce(result_limit, 50), 1), 100);
end;
$$;

revoke all on function public.list_pending_business_submissions(integer, integer)
  from public;
grant execute on function public.list_pending_business_submissions(integer, integer)
  to authenticated;

create or replace function public.submit_business_claim(
  target_business_id uuid,
  claim_method text,
  evidence_private_path text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_aal2();
  if not private.is_active_user(auth.uid()) then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;
  raise exception using
    errcode = '55000',
    message = 'CLAIM_VERIFICATION_SERVICE_REQUIRED';
end;
$$;

revoke all on function public.submit_business_claim(uuid, text, text) from public;
grant execute on function public.submit_business_claim(uuid, text, text) to authenticated;

create or replace function public.withdraw_business_claim(target_claim_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_business_id uuid;
begin
  perform private.require_aal2();
  update public.business_claims
  set state = 'withdrawn'
  where id = target_claim_id
    and claimant_id = actor
    and state = 'pending'
  returning business_id into target_business_id;

  if target_business_id is null then
    raise exception using errcode = '22023', message = 'Pending claim not found';
  end if;

  perform private.write_audit_event(
    actor,
    target_business_id,
    'business.claim_withdrawn',
    'business_claim',
    target_claim_id::text,
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.withdraw_business_claim(uuid) from public;
grant execute on function public.withdraw_business_claim(uuid) to authenticated;

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
begin
  perform private.require_aal2();
  select bl.business_id, b.kind, b.state
  into target_business_id, target_kind, target_business_state
  from public.business_locations bl
  join public.businesses b on b.id = bl.business_id
  where bl.id = target_location_id
  for update of bl;

  if target_business_id is null
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

  if next_state = 'published' and target_kind = 'home_kitchen' then
    if not exists (
      select 1
      from public.businesses b
      join public.jurisdictions j on j.id = b.jurisdiction_id
      join public.home_kitchen_permits hp
        on hp.business_id = b.id
       and hp.jurisdiction_id = j.id
      where b.id = target_business_id
        and b.verification = 'verified'
        and j.home_kitchens_enabled
        and j.legal_reviewed_at is not null
        and hp.verification = 'verified'
        and hp.expires_on >= current_date
    ) then
      raise exception using errcode = '22023', message = 'HOME_KITCHEN_NOT_ELIGIBLE';
    end if;
  end if;

  perform private.consume_rate_limit(actor, 'location_publication', 30, 3600);

  update public.business_locations
  set publication_state = next_state,
      public_address = case when target_kind = 'home_kitchen' then false else public_address end,
      is_approximate = case
        when target_kind = 'home_kitchen' or not public_address then true
        else is_approximate
      end
  where id = target_location_id;

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

  select b.state, b.verification
  into old_state, old_verification
  from public.businesses b
  where b.id = target_business_id
  for update;

  if old_state is null then
    raise exception using errcode = '22023', message = 'Business not found';
  end if;

  if next_state = 'published' then
    update public.business_locations
    set publication_state = 'published'
    where business_id = target_business_id
      and is_primary
      and publication_state = 'private';
  end if;

  update public.businesses
  set state = next_state,
      verification = next_verification
  where id = target_business_id;

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

create or replace function public.submit_content_report(
  target_type text,
  target_id uuid,
  report_reason text,
  report_detail text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  report_id uuid;
  resolved_target_id uuid := target_id;
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;
  if target_type not in ('business', 'review', 'response', 'update', 'media', 'user')
    or report_reason not in (
      'spam',
      'harassment',
      'hate',
      'sexual',
      'violence',
      'fraud',
      'privacy',
      'illegal',
      'unsafe',
      'other'
    )
  then
    raise exception using errcode = '22023', message = 'Invalid report type or reason';
  end if;

  if target_type = 'user' then
    select p.user_id
    into resolved_target_id
    from public.profiles p
    where p.public_id = target_id
      and p.status <> 'deleted'
      and p.user_id <> actor;

    if resolved_target_id is null then
      raise exception using errcode = '22023', message = 'INVALID_REPORT_TARGET';
    end if;
  end if;

  insert into public.content_reports (
    reporter_id,
    target_type,
    target_id,
    reason,
    detail,
    state
  )
  values (
    actor,
    target_type,
    resolved_target_id,
    report_reason,
    nullif(btrim(report_detail), ''),
    'open'
  )
  on conflict on constraint content_reports_reporter_id_target_type_target_id_key
  do update set
    reason = excluded.reason,
    detail = excluded.detail,
    state = 'open'
  returning id into report_id;

  perform private.write_audit_event(
    actor,
    null,
    'safety.report_submitted',
    target_type,
    target_id::text,
    jsonb_build_object('report_id', report_id, 'reason', report_reason)
  );
  return report_id;
end;
$$;

revoke all on function public.submit_content_report(text, uuid, text, text) from public;
grant execute on function public.submit_content_report(text, uuid, text, text) to authenticated;

create or replace function public.set_user_block(
  target_user_id uuid,
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
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;
  if target_user_id is null
    or target_user_id = actor
    or not exists (select 1 from public.profiles p where p.user_id = target_user_id)
  then
    raise exception using errcode = '22023', message = 'Invalid block target';
  end if;

  if should_block then
    insert into public.user_blocks (blocker_id, blocked_id)
    values (actor, target_user_id)
    on conflict do nothing;
  else
    delete from public.user_blocks
    where blocker_id = actor and blocked_id = target_user_id;
  end if;

  perform private.write_audit_event(
    actor,
    null,
    case when should_block then 'safety.user_blocked' else 'safety.user_unblocked' end,
    'user',
    (
      select p.public_id::text
      from public.profiles p
      where p.user_id = target_user_id
    ),
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.set_user_block(uuid, boolean) from public;
revoke execute on function public.set_user_block(uuid, boolean) from anon, authenticated;

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
  target_internal_user_id uuid;
begin
  select p.user_id
  into target_internal_user_id
  from public.profiles p
  where p.public_id = target_public_profile_id
    and p.status = 'active';

  if target_internal_user_id is null then
    raise exception using errcode = '22023', message = 'Invalid block target';
  end if;

  perform public.set_user_block(target_internal_user_id, should_block);
end;
$$;

revoke all on function public.set_user_block_by_public_id(uuid, boolean) from public;
grant execute on function public.set_user_block_by_public_id(uuid, boolean) to authenticated;

create or replace function public.list_pending_content_moderation(
  result_limit integer default 50,
  result_offset integer default 0
)
returns table (
  target_type text,
  target_id uuid,
  business_id uuid,
  business_name text,
  author_public_id uuid,
  author_display_name text,
  body text,
  rating smallint,
  context jsonb,
  submitted_at timestamptz,
  updated_at timestamptz,
  has_more boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  perform private.require_aal2();
  if not private.is_platform_staff(
    actor,
    array['moderator', 'admin']::public.platform_role[]
  ) then
    raise exception using errcode = '42501', message = 'Platform moderation role required';
  end if;

  return query
  with pending as (
    select
      'review'::text as target_type,
      r.id as target_id,
      r.business_id,
      b.name as business_name,
      p.public_id as author_public_id,
      p.display_name as author_display_name,
      r.body,
      r.rating,
      (
        select jsonb_build_object(
          'media_count', count(rm.asset_id)::integer,
          'all_media_clean', coalesce(
            bool_and(
              ma.quarantine_state = 'clean'
              and ma.moderation = 'approved'
              and ma.processed_storage_path is not null
            ),
            true
          ),
          'assets', coalesce(
            jsonb_agg(
              jsonb_build_object(
                'asset_id', ma.id,
                'quarantine_state', ma.quarantine_state,
                'moderation', ma.moderation
              )
              order by rm.sort_order, ma.id
            ) filter (where ma.id is not null),
            '[]'::jsonb
          )
        )
        from public.review_media rm
        join public.media_assets ma on ma.id = rm.asset_id
        where rm.review_id = r.id
      ) as context,
      r.created_at as submitted_at,
      r.updated_at
    from public.reviews r
    join public.businesses b on b.id = r.business_id
    left join public.profiles p on p.user_id = r.author_id
    where r.moderation = 'pending'
      and r.deleted_at is null

    union all

    select
      'update'::text,
      bu.id,
      bu.business_id,
      b.name,
      p.public_id,
      p.display_name,
      bu.body,
      null::smallint,
      jsonb_build_object(
        'kind', bu.kind,
        'requested_duration_minutes',
          greatest(1, floor(extract(epoch from (bu.expires_at - bu.starts_at)) / 60))::integer
      ),
      bu.created_at,
      bu.updated_at
    from public.business_updates bu
    join public.businesses b on b.id = bu.business_id
    left join public.profiles p on p.user_id = bu.author_id
    where bu.moderation = 'pending'

    union all

    select
      'response'::text,
      br.review_id,
      br.business_id,
      b.name,
      p.public_id,
      p.display_name,
      br.body,
      null::smallint,
      jsonb_build_object(
        'review_id', r.id,
        'review_rating', r.rating,
        'review_excerpt', left(r.body, 240)
      ),
      br.created_at,
      br.updated_at
    from public.business_responses br
    join public.reviews r
      on r.id = br.review_id
     and r.business_id = br.business_id
    join public.businesses b on b.id = br.business_id
    left join public.profiles p on p.user_id = br.author_id
    where br.moderation = 'pending'
      and r.moderation = 'approved'
      and r.deleted_at is null
  ),
  page as materialized (
    select pending.*
    from pending
    order by pending.submitted_at, pending.target_type, pending.target_id
    offset least(greatest(coalesce(result_offset, 0), 0), 10000)
    limit least(greatest(coalesce(result_limit, 50), 1), 100) + 1
  )
  select
    page.target_type,
    page.target_id,
    page.business_id,
    page.business_name,
    page.author_public_id,
    page.author_display_name,
    page.body,
    page.rating,
    page.context,
    page.submitted_at,
    page.updated_at,
    (
      select count(*) >
        least(greatest(coalesce(result_limit, 50), 1), 100)
      from page page_count
    ) as has_more
  from page
  order by page.submitted_at, page.target_type, page.target_id
  limit least(greatest(coalesce(result_limit, 50), 1), 100);
end;
$$;

revoke all on function public.list_pending_content_moderation(integer, integer)
  from public;
grant execute on function public.list_pending_content_moderation(integer, integer)
  to authenticated;

create or replace function public.decide_content_moderation(
  target_type text,
  target_id uuid,
  decision public.moderation_state,
  moderation_reason text,
  expected_updated_at timestamptz
)
returns table (
  decided_target_type text,
  decided_target_id uuid,
  moderation_state public.moderation_state,
  decided_updated_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  normalized_reason text := btrim(coalesce(moderation_reason, ''));
  target_business_id uuid;
  current_state public.moderation_state;
  current_updated_at timestamptz;
  next_updated_at timestamptz;
  requested_duration interval;
begin
  perform private.require_aal2();
  if not private.is_platform_staff(
    actor,
    array['moderator', 'admin']::public.platform_role[]
  ) then
    raise exception using errcode = '42501', message = 'Platform moderation role required';
  end if;
  if target_type not in ('review', 'update', 'response')
    or decision not in ('approved', 'rejected', 'removed')
    or char_length(normalized_reason) not between 3 and 1000
    or expected_updated_at is null
  then
    raise exception using errcode = '22023', message = 'Invalid moderation decision';
  end if;

  case target_type
    when 'review' then
      select r.business_id, r.moderation, r.updated_at
      into target_business_id, current_state, current_updated_at
      from public.reviews r
      where r.id = target_id
        and r.deleted_at is null
      for update;

      if decision = 'approved' and exists (
        select 1
        from public.review_media rm
        join public.media_assets ma on ma.id = rm.asset_id
        where rm.review_id = target_id
          and (
            ma.quarantine_state <> 'clean'
            or ma.moderation <> 'approved'
            or ma.processed_storage_path is null
          )
      ) then
        raise exception using errcode = '22023', message = 'REVIEW_MEDIA_NOT_READY';
      end if;
    when 'update' then
      select
        bu.business_id,
        bu.moderation,
        bu.updated_at,
        bu.expires_at - bu.starts_at
      into
        target_business_id,
        current_state,
        current_updated_at,
        requested_duration
      from public.business_updates bu
      where bu.id = target_id
      for update;
    when 'response' then
      select br.business_id, br.moderation, br.updated_at
      into target_business_id, current_state, current_updated_at
      from public.business_responses br
      where br.review_id = target_id
      for update;
  end case;

  if target_business_id is null then
    raise exception using errcode = '22023', message = 'Moderation target not found';
  end if;
  if current_updated_at is distinct from expected_updated_at then
    raise exception using errcode = '40001', message = 'MODERATION_TARGET_CHANGED';
  end if;
  if (
    decision in ('approved', 'rejected')
    and current_state <> 'pending'
  ) or (
    decision = 'removed'
    and current_state <> 'approved'
  ) then
    raise exception using errcode = '40001', message = 'MODERATION_STATE_CHANGED';
  end if;

  perform private.consume_rate_limit(actor, 'content_moderation_decision', 240, 3600);

  case target_type
    when 'review' then
      update public.reviews r
      set moderation = decision
      where r.id = target_id
      returning r.updated_at into next_updated_at;
    when 'update' then
      update public.business_updates bu
      set moderation = decision,
          starts_at = case when decision = 'approved' then now() else bu.starts_at end,
          expires_at = case
            when decision = 'approved' then now() + requested_duration
            else bu.expires_at
          end
      where bu.id = target_id
      returning bu.updated_at into next_updated_at;
    when 'response' then
      update public.business_responses br
      set moderation = decision
      where br.review_id = target_id
      returning br.updated_at into next_updated_at;
  end case;

  perform private.write_audit_event(
    actor,
    target_business_id,
    'moderation.content_decided',
    target_type,
    target_id::text,
    jsonb_build_object(
      'state', decision::text,
      'reason', normalized_reason,
      'expected_updated_at', expected_updated_at
    )
  );

  return query
  select target_type, target_id, decision, next_updated_at;
end;
$$;

revoke all on function public.decide_content_moderation(
  text,
  uuid,
  public.moderation_state,
  text,
  timestamptz
) from public;
grant execute on function public.decide_content_moderation(
  text,
  uuid,
  public.moderation_state,
  text,
  timestamptz
) to authenticated;

create or replace function public.moderate_content(
  target_type text,
  target_id uuid,
  next_state public.moderation_state,
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
  normalized_reason text := btrim(coalesce(moderation_reason, ''));
  target_business_id uuid;
begin
  perform private.require_aal2();
  if not private.is_platform_staff(actor) then
    raise exception using errcode = '42501', message = 'Platform moderation role required';
  end if;
  if target_type <> 'media' then
    raise exception using errcode = '22023', message = 'Use decide_content_moderation for text content';
  end if;
  if next_state not in ('approved', 'rejected', 'removed')
    or char_length(normalized_reason) not between 3 and 1000
  then
    raise exception using errcode = '22023', message = 'Invalid moderation decision';
  end if;

  case target_type
    when 'review' then
      update public.reviews
      set moderation = next_state
      where id = target_id
      returning business_id into target_business_id;
    when 'response' then
      update public.business_responses
      set moderation = next_state
      where review_id = target_id
      returning business_id into target_business_id;
    when 'update' then
      update public.business_updates
      set moderation = next_state
      where id = target_id
      returning business_id into target_business_id;
    when 'media' then
      update public.media_assets
      set moderation = next_state
      where id = target_id
        and (next_state <> 'approved' or quarantine_state = 'clean')
      returning business_id into target_business_id;
    else
      raise exception using errcode = '22023', message = 'Unsupported moderation target';
  end case;

  if not found then
    raise exception using errcode = '22023', message = 'Moderation target not found or not eligible';
  end if;

  perform private.write_audit_event(
    actor,
    target_business_id,
    'moderation.content_decided',
    target_type,
    target_id::text,
    jsonb_build_object('state', next_state::text, 'reason', normalized_reason)
  );
end;
$$;

revoke all on function public.moderate_content(text, uuid, public.moderation_state, text) from public;
grant execute on function public.moderate_content(text, uuid, public.moderation_state, text) to authenticated;

create or replace function public.review_business_claim(
  target_claim_id uuid,
  decision text,
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
  target_business_id uuid;
  target_claimant_id uuid;
  normalized_reason text := btrim(coalesce(moderation_reason, ''));
begin
  perform private.require_aal2();
  if not private.is_platform_staff(
    actor,
    array['admin']::public.platform_role[]
  ) then
    raise exception using errcode = '42501', message = 'Platform administrator role required';
  end if;
  if decision not in ('approved', 'rejected')
    or char_length(normalized_reason) not between 3 and 1000
  then
    raise exception using errcode = '22023', message = 'Invalid claim decision';
  end if;

  select bc.business_id, bc.claimant_id
  into target_business_id, target_claimant_id
  from public.business_claims bc
  where bc.id = target_claim_id
    and bc.state = 'pending'
  for update;

  if target_business_id is null then
    raise exception using errcode = '22023', message = 'Pending claim not found';
  end if;

  update public.business_claims
  set state = decision,
      reviewed_by = actor,
      reviewed_at = now()
  where id = target_claim_id;

  if decision = 'approved' then
    insert into public.business_members (
      business_id,
      user_id,
      role,
      status,
      invited_by,
      accepted_at,
      revoked_at
    )
    values (
      target_business_id,
      target_claimant_id,
      'owner',
      'active',
      actor,
      now(),
      null
    )
    on conflict (business_id, user_id)
    do update set
      role = 'owner',
      status = 'active',
      accepted_at = now(),
      revoked_at = null;

    update public.businesses
    set provenance = 'owner',
        verification = case
          when verification = 'unverified' then 'pending'::public.verification_state
          else verification
        end
    where id = target_business_id;
  end if;

  perform private.write_audit_event(
    actor,
    target_business_id,
    'business.claim_decided',
    'business_claim',
    target_claim_id::text,
    jsonb_build_object('decision', decision, 'reason', normalized_reason)
  );
end;
$$;

revoke all on function public.review_business_claim(uuid, text, text) from public;
grant execute on function public.review_business_claim(uuid, text, text) to authenticated;

create or replace function public.review_home_kitchen_permit(
  target_business_id uuid,
  decision public.verification_state,
  verified_issuer text,
  verified_expiry date,
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
  normalized_reason text := btrim(coalesce(moderation_reason, ''));
  normalized_issuer text := nullif(btrim(verified_issuer), '');
  target_jurisdiction_id uuid;
begin
  perform private.require_aal2();
  if not private.is_platform_staff(
    actor,
    array['admin']::public.platform_role[]
  ) then
    raise exception using errcode = '42501', message = 'Platform administrator role required';
  end if;
  if decision not in ('verified', 'rejected')
    or char_length(normalized_reason) not between 3 and 1000
  then
    raise exception using errcode = '22023', message = 'Invalid permit decision';
  end if;

  select hp.jurisdiction_id
  into target_jurisdiction_id
  from public.home_kitchen_permits hp
  join public.businesses b
    on b.id = hp.business_id
   and b.kind = 'home_kitchen'
  where hp.business_id = target_business_id
  for update of hp;

  if target_jurisdiction_id is null then
    raise exception using errcode = '22023', message = 'Home-kitchen permit not found';
  end if;

  if decision = 'verified' then
    if normalized_issuer is null
      or char_length(normalized_issuer) > 160
      or verified_expiry is null
      or verified_expiry < current_date
      or not exists (
        select 1
        from public.jurisdictions j
        where j.id = target_jurisdiction_id
          and j.home_kitchens_enabled
          and j.legal_reviewed_at is not null
      )
    then
      raise exception using errcode = '22023', message = 'Permit or jurisdiction is not eligible';
    end if;
  end if;

  update public.home_kitchen_permits
  set verification = decision,
      issuer = case when decision = 'verified' then normalized_issuer else issuer end,
      expires_on = case when decision = 'verified' then verified_expiry else expires_on end,
      reviewed_by = actor,
      reviewed_at = now()
  where business_id = target_business_id;

  update public.businesses
  set verification = decision
  where id = target_business_id;

  perform private.write_audit_event(
    actor,
    target_business_id,
    'home_kitchen.permit_decided',
    'home_kitchen_permit',
    target_business_id::text,
    jsonb_build_object(
      'decision', decision::text,
      'expires_on', verified_expiry,
      'reason', normalized_reason
    )
  );
end;
$$;

revoke all on function public.review_home_kitchen_permit(
  uuid,
  public.verification_state,
  text,
  date,
  text
) from public;
grant execute on function public.review_home_kitchen_permit(
  uuid,
  public.verification_state,
  text,
  date,
  text
) to authenticated;

create or replace function public.consume_media_stage_slot(
  target_user_id uuid,
  media_purpose text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not private.is_active_user(target_user_id)
    or media_purpose not in (
      'profile_avatar',
      'business_logo',
      'business_gallery',
      'review_photo',
      'chat_photo',
      'claim_evidence'
    )
  then
    raise exception using errcode = '42501', message = 'Active account and valid media purpose required';
  end if;

  perform private.consume_rate_limit(
    target_user_id,
    'media_stage_' || media_purpose,
    case when media_purpose in ('review_photo', 'chat_photo') then 12 else 20 end,
    86400
  );
end;
$$;

revoke all on function public.consume_media_stage_slot(uuid, text) from public, anon, authenticated;
grant execute on function public.consume_media_stage_slot(uuid, text) to service_role;

create or replace function public.register_quarantined_media(
  target_storage_path text,
  target_business_id uuid default null,
  media_source text default 'owner_upload'
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  object_metadata jsonb;
  detected_mime text;
  detected_size bigint;
  asset_id uuid;
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;
  if media_source not in ('owner_upload', 'review_upload') then
    raise exception using errcode = '22023', message = 'Invalid client media source';
  end if;
  if media_source = 'owner_upload' then
    perform private.require_aal2();
  end if;
  if target_storage_path is null
    or char_length(target_storage_path) > 512
    or target_storage_path !~ ('^quarantine/' || actor::text || '/[A-Za-z0-9][A-Za-z0-9._-]{0,180}$')
  then
    raise exception using errcode = '22023', message = 'Invalid quarantine path';
  end if;
  if target_business_id is not null and (
    (media_source = 'owner_upload' and not private.is_business_member(
      target_business_id,
      actor,
      array['owner', 'manager']::public.member_role[]
    ))
    or
    (media_source = 'review_upload' and not private.is_business_publicly_eligible(target_business_id))
  ) then
    raise exception using errcode = '42501', message = 'Media target is not allowed';
  end if;

  select so.metadata
  into object_metadata
  from storage.objects so
  where so.bucket_id = 'spottr-media'
    and so.name = target_storage_path;

  if object_metadata is null then
    raise exception using errcode = '22023', message = 'Uploaded object not found';
  end if;

  detected_mime := lower(coalesce(
    object_metadata ->> 'mimetype',
    object_metadata ->> 'contentType',
    ''
  ));
  detected_size := case
    when coalesce(object_metadata ->> 'size', '') ~ '^[0-9]+$'
    then (object_metadata ->> 'size')::bigint
    else null
  end;

  if detected_mime not in ('image/jpeg', 'image/png', 'image/webp')
    or detected_size is null
    or detected_size not between 1 and 5242880
    or (
      detected_mime = 'image/jpeg'
      and lower(target_storage_path) !~ '\.(jpg|jpeg)$'
    )
    or (
      detected_mime = 'image/png'
      and lower(target_storage_path) !~ '\.png$'
    )
    or (
      detected_mime = 'image/webp'
      and lower(target_storage_path) !~ '\.webp$'
    )
  then
    raise exception using errcode = '22023', message = 'Unsupported media object';
  end if;

  perform private.consume_rate_limit(actor, 'media_registration', 20, 86400);

  insert into public.media_assets (
    owner_id,
    business_id,
    storage_path,
    mime_type,
    byte_size,
    source,
    quarantine_state,
    moderation
  )
  values (
    actor,
    target_business_id,
    target_storage_path,
    detected_mime,
    detected_size,
    media_source,
    'uploaded',
    'pending'
  )
  on conflict (storage_path)
  do update set storage_path = excluded.storage_path
  where public.media_assets.owner_id = actor
    and public.media_assets.quarantine_state in ('uploaded', 'scanning')
  returning id into asset_id;

  if asset_id is null then
    raise exception using errcode = '22023', message = 'Media path is already registered';
  end if;

  return asset_id;
end;
$$;

revoke all on function public.register_quarantined_media(text, uuid, text) from public;
grant execute on function public.register_quarantined_media(text, uuid, text) to authenticated;

create or replace function public.record_media_scan_result(
  target_asset_id uuid,
  scan_state text,
  clean_storage_path text default null,
  clean_mime_type text default null,
  clean_width integer default null,
  clean_height integer default null,
  clean_byte_size bigint default null,
  clean_sha256 text default null,
  scan_rejection_reason text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_business_id uuid;
  target_source text;
  affected_review_id uuid;
begin
  if scan_state not in ('scanning', 'clean', 'rejected') then
    raise exception using errcode = '22023', message = 'Invalid scan state';
  end if;

  if scan_state = 'clean' then
    if clean_storage_path is null
      or clean_storage_path !~ '^published/[A-Za-z0-9/_-]+\.(jpg|jpeg|png|webp)$'
      or clean_mime_type not in ('image/jpeg', 'image/png', 'image/webp')
      or clean_width not between 1 and 8192
      or clean_height not between 1 and 8192
      or clean_byte_size not between 1 and 5242880
      or clean_sha256 !~ '^[0-9a-f]{64}$'
      or not exists (
        select 1
        from storage.objects so
        where so.bucket_id = 'spottr-media'
          and so.name = clean_storage_path
      )
    then
      raise exception using errcode = '22023', message = 'Invalid clean media metadata';
    end if;
  elsif scan_state = 'rejected' and nullif(btrim(scan_rejection_reason), '') is null then
    raise exception using errcode = '22023', message = 'Rejection reason required';
  end if;

  update public.media_assets
  set quarantine_state = scan_state,
      processed_storage_path = case when scan_state = 'clean' then clean_storage_path else null end,
      mime_type = case when scan_state = 'clean' then clean_mime_type else mime_type end,
      width = case when scan_state = 'clean' then clean_width else null end,
      height = case when scan_state = 'clean' then clean_height else null end,
      byte_size = case when scan_state = 'clean' then clean_byte_size else byte_size end,
      sha256 = case when scan_state = 'clean' then lower(clean_sha256) else null end,
      scan_completed_at = case when scan_state in ('clean', 'rejected') then now() else null end,
      rejection_reason = case
        when scan_state = 'rejected' then left(btrim(scan_rejection_reason), 1000)
        else null
      end,
      moderation = case
        when scan_state = 'clean' then 'approved'::public.moderation_state
        when scan_state = 'rejected' then 'rejected'::public.moderation_state
        else moderation
      end
  where id = target_asset_id
    and quarantine_state in ('uploaded', 'scanning')
  returning business_id, source
  into target_business_id, target_source;

  if not found then
    raise exception using errcode = '22023', message = 'Media asset not found or already finalized';
  end if;

  if target_source = 'review_upload' and scan_state = 'rejected' then
    for affected_review_id in
      update public.reviews r
      set moderation = 'rejected'
      where r.moderation = 'pending'
        and exists (
          select 1
          from public.review_media rm
          where rm.review_id = r.id
            and rm.asset_id = target_asset_id
        )
      returning r.id
    loop
      perform private.write_audit_event(
        auth.uid(),
        target_business_id,
        'review.media_rejected',
        'review',
        affected_review_id::text,
        jsonb_build_object('asset_id', target_asset_id)
      );
    end loop;
  end if;

  perform private.write_audit_event(
    auth.uid(),
    target_business_id,
    'media.scan_recorded',
    'media',
    target_asset_id::text,
    jsonb_build_object('scan_state', scan_state)
  );
end;
$$;

revoke all on function public.record_media_scan_result(
  uuid,
  text,
  text,
  text,
  integer,
  integer,
  bigint,
  text,
  text
) from public, anon, authenticated;
grant execute on function public.record_media_scan_result(
  uuid,
  text,
  text,
  text,
  integer,
  integer,
  bigint,
  text,
  text
) to service_role;

create or replace function public.media_quarantine_cleanup_manifest()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with expired as (
    select so.name as storage_path
    from storage.objects so
    left join public.media_assets ma
      on ma.storage_path = so.name
    where so.bucket_id = 'spottr-media'
      and so.name like 'quarantine/%'
      and not exists (
        select 1
        from public.business_claims bc
        where bc.evidence_private_path = so.name
          and bc.state in ('pending', 'approved')
      )
      and (
        (ma.id is null and so.created_at < now() - interval '1 hour')
        or (
          ma.quarantine_state in ('uploaded', 'scanning')
          and ma.created_at < now() - interval '24 hours'
        )
        or (
          ma.quarantine_state = 'rejected'
          and ma.created_at < now() - interval '7 days'
        )
      )
    order by so.created_at
    limit 500
  )
  select jsonb_build_object(
    'storage_paths',
    coalesce(jsonb_agg(e.storage_path order by e.storage_path), '[]'::jsonb)
  )
  from expired e;
$$;

revoke all on function public.media_quarantine_cleanup_manifest() from public, anon, authenticated;
grant execute on function public.media_quarantine_cleanup_manifest() to service_role;

create or replace function public.finalize_media_quarantine_cleanup(
  target_storage_paths text[]
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  deleted_count integer;
begin
  if cardinality(target_storage_paths) > 500
    or exists (
      select 1
      from unnest(target_storage_paths) path
      where path !~ '^quarantine/[0-9a-f-]{36}/[A-Za-z0-9._-]+$'
    )
  then
    raise exception using errcode = '22023', message = 'Invalid cleanup manifest';
  end if;

  delete from public.media_assets ma
  where ma.storage_path = any(target_storage_paths)
    and ma.quarantine_state in ('uploaded', 'scanning', 'rejected')
    and ma.moderation <> 'approved'
    and not exists (
      select 1
      from public.business_claims bc
      where bc.evidence_private_path = ma.storage_path
        and bc.state in ('pending', 'approved')
    );
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.finalize_media_quarantine_cleanup(text[]) from public, anon, authenticated;
grant execute on function public.finalize_media_quarantine_cleanup(text[]) to service_role;

create or replace function public.account_export_payload(target_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'schema_version', '2026-07-30',
    'generated_at', now(),
    'profile', (
      select jsonb_build_object(
        'public_id', p.public_id,
        'username', p.username,
        'display_name', p.display_name,
        'avatar_path', p.avatar_path,
        'status', p.status,
        'terms_accepted_at', p.terms_accepted_at,
        'terms_version', p.terms_version,
        'created_at', p.created_at,
        'updated_at', p.updated_at
      )
      from public.profiles p
      where p.user_id = target_user_id
    ),
    'business_memberships', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'business_id', bm.business_id,
          'business_name', b.name,
          'role', bm.role,
          'status', bm.status,
          'accepted_at', bm.accepted_at,
          'created_at', bm.created_at
        )
        order by bm.created_at
      )
      from public.business_members bm
      join public.businesses b on b.id = bm.business_id
      where bm.user_id = target_user_id
    ), '[]'::jsonb),
    'business_claims', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', bc.id,
          'business_id', bc.business_id,
          'method', bc.method,
          'state', bc.state,
          'reviewed_at', bc.reviewed_at,
          'created_at', bc.created_at
        )
        order by bc.created_at
      )
      from public.business_claims bc
      where bc.claimant_id = target_user_id
    ), '[]'::jsonb),
    'reviews', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', r.id,
          'business_id', r.business_id,
          'rating', r.rating,
          'body', r.body,
          'moderation', r.moderation,
          'created_at', r.created_at,
          'updated_at', r.updated_at,
          'deleted_at', r.deleted_at
        )
        order by r.created_at
      )
      from public.reviews r
      where r.author_id = target_user_id
    ), '[]'::jsonb),
    'authored_business_updates', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', bu.id,
          'business_id', bu.business_id,
          'kind', bu.kind,
          'body', bu.body,
          'starts_at', bu.starts_at,
          'expires_at', bu.expires_at,
          'moderation', bu.moderation,
          'created_at', bu.created_at,
          'updated_at', bu.updated_at
        )
        order by bu.created_at
      )
      from public.business_updates bu
      where bu.author_id = target_user_id
    ), '[]'::jsonb),
    'authored_business_responses', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'review_id', br.review_id,
          'business_id', br.business_id,
          'body', br.body,
          'moderation', br.moderation,
          'created_at', br.created_at,
          'updated_at', br.updated_at
        )
        order by br.created_at
      )
      from public.business_responses br
      where br.author_id = target_user_id
    ), '[]'::jsonb),
    'owned_businesses', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', b.id,
          'kind', b.kind,
          'name', b.name,
          'slug', b.slug,
          'description', b.description,
          'cuisine_labels', b.cuisine_labels,
          'price_level', b.price_level,
          'state', b.state,
          'verification', b.verification,
          'timezone', b.timezone,
          'jurisdiction_id', b.jurisdiction_id,
          'logo_asset_id', b.logo_asset_id,
          'provenance', b.provenance,
          'provider_freshness_at', b.provider_freshness_at,
          'created_at', b.created_at,
          'updated_at', b.updated_at,
          'private_details', (
            select to_jsonb(bpd) - 'business_id'
            from public.business_private_details bpd
            where bpd.business_id = b.id
          ),
          'locations', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', bl.id,
                'label', bl.label,
                'address_line', bl.address_line,
                'city', bl.city,
                'region', bl.region,
                'postal_code', bl.postal_code,
                'latitude', public.st_y(bl.point::public.geometry),
                'longitude', public.st_x(bl.point::public.geometry),
                'is_primary', bl.is_primary,
                'is_approximate', bl.is_approximate,
                'public_address', bl.public_address,
                'publication_state', bl.publication_state,
                'created_at', bl.created_at,
                'updated_at', bl.updated_at
              )
              order by bl.is_primary desc, bl.created_at, bl.id
            )
            from public.business_locations bl
            where bl.business_id = b.id
          ), '[]'::jsonb),
          'weekly_hours', coalesce((
            select jsonb_agg(
              to_jsonb(wh) - 'business_id'
              order by wh.weekday
            )
            from public.weekly_hours wh
            where wh.business_id = b.id
          ), '[]'::jsonb),
          'special_hours', coalesce((
            select jsonb_agg(
              to_jsonb(sh) - 'business_id'
              order by sh.service_date
            )
            from public.special_hours sh
            where sh.business_id = b.id
          ), '[]'::jsonb),
          'payments', coalesce((
            select jsonb_agg(bp.payment order by bp.payment)
            from public.business_payments bp
            where bp.business_id = b.id
          ), '[]'::jsonb),
          'menu', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', ms.id,
                'name', ms.name,
                'sort_order', ms.sort_order,
                'is_published', ms.is_published,
                'created_at', ms.created_at,
                'updated_at', ms.updated_at,
                'items', coalesce((
                  select jsonb_agg(
                    to_jsonb(mi) - 'section_id'
                    order by mi.sort_order, mi.id
                  )
                  from public.menu_items mi
                  where mi.section_id = ms.id
                ), '[]'::jsonb)
              )
              order by ms.sort_order, ms.id
            )
            from public.menu_sections ms
            where ms.business_id = b.id
          ), '[]'::jsonb),
          'mobile_stops', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', ms.id,
                'location_id', ms.location_id,
                'starts_at', ms.starts_at,
                'ends_at', ms.ends_at,
                'state', ms.state,
                'confirmed_at', ms.confirmed_at,
                'created_at', ms.created_at,
                'updated_at', ms.updated_at
              )
              order by ms.starts_at, ms.id
            )
            from public.mobile_stops ms
            where ms.business_id = b.id
          ), '[]'::jsonb),
          'gallery', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'asset_id', link.asset_id,
                'media_role', link.media_role,
                'sort_order', link.sort_order,
                'created_at', link.created_at
              )
              order by link.sort_order, link.asset_id
            )
            from public.business_media_links link
            where link.business_id = b.id
          ), '[]'::jsonb)
        )
        order by b.created_at, b.id
      )
      from public.businesses b
      join public.business_members owner_membership
        on owner_membership.business_id = b.id
       and owner_membership.user_id = target_user_id
       and owner_membership.role = 'owner'
       and owner_membership.status = 'active'
    ), '[]'::jsonb),
    'follows', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'business_id', f.business_id,
          'created_at', f.created_at
        )
        order by f.created_at
      )
      from public.follows f
      where f.user_id = target_user_id
    ), '[]'::jsonb),
    'notification_preferences', coalesce((
      select jsonb_agg(to_jsonb(np) - 'user_id' order by np.business_id)
      from public.notification_preferences np
      where np.user_id = target_user_id
    ), '[]'::jsonb),
    'reports', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', cr.id,
          'target_type', cr.target_type,
          'target_id', case
            when cr.target_type = 'user' then (
              select target_profile.public_id
              from public.profiles target_profile
              where target_profile.user_id = cr.target_id
            )
            else cr.target_id
          end,
          'reason', cr.reason,
          'detail', cr.detail,
          'state', cr.state,
          'created_at', cr.created_at
        )
        order by cr.created_at
      )
      from public.content_reports cr
      where cr.reporter_id = target_user_id
    ), '[]'::jsonb),
    'blocked_profiles', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'public_profile_id', blocked.public_id,
          'created_at', ub.created_at
        )
        order by ub.created_at
      )
      from public.user_blocks ub
      join public.profiles blocked on blocked.user_id = ub.blocked_id
      where ub.blocker_id = target_user_id
    ), '[]'::jsonb),
    'media', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', ma.id,
          'business_id', ma.business_id,
          'storage_path', ma.storage_path,
          'processed_storage_path', ma.processed_storage_path,
          'mime_type', ma.mime_type,
          'width', ma.width,
          'height', ma.height,
          'byte_size', ma.byte_size,
          'source', ma.source,
          'quarantine_state', ma.quarantine_state,
          'moderation', ma.moderation,
          'created_at', ma.created_at
        )
        order by ma.created_at
      )
      from public.media_assets ma
      where ma.owner_id = target_user_id
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.account_export_payload(uuid) from public, anon, authenticated;
grant execute on function public.account_export_payload(uuid) to service_role;

create or replace function public.account_deletion_manifest(target_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with owned_paths as (
    select ma.storage_path as path
    from public.media_assets ma
    where ma.owner_id = target_user_id
    union
    select ma.processed_storage_path
    from public.media_assets ma
    where ma.owner_id = target_user_id
      and ma.processed_storage_path is not null
    union
    select p.avatar_path
    from public.profiles p
    where p.user_id = target_user_id
      and (
        p.avatar_path like 'quarantine/%'
        or p.avatar_path like 'published/%'
      )
    union
    select bc.evidence_private_path
    from public.business_claims bc
    where bc.claimant_id = target_user_id
      and bc.evidence_private_path is not null
  )
  select jsonb_build_object(
    'storage_paths', coalesce(
      jsonb_agg(op.path order by op.path) filter (where op.path is not null),
      '[]'::jsonb
    )
  )
  from owned_paths op;
$$;

revoke all on function public.account_deletion_manifest(uuid) from public, anon, authenticated;
grant execute on function public.account_deletion_manifest(uuid) to service_role;

create or replace function public.begin_account_deletion(
  target_user_id uuid,
  request_key text
)
returns table (
  request_id uuid,
  request_state text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  fingerprint text;
begin
  if target_user_id is null
    or char_length(coalesce(request_key, '')) not between 16 and 128
    or request_key !~ '^[A-Za-z0-9._:-]+$'
    or not exists (select 1 from auth.users u where u.id = target_user_id)
  then
    raise exception using errcode = '22023', message = 'Invalid account deletion request';
  end if;

  delete from private.account_deletion_requests adr
  where adr.expires_at < now();

  fingerprint := pg_catalog.encode(
    extensions.digest(target_user_id::text || ':' || request_key, 'sha256'),
    'hex'
  );

  insert into private.account_deletion_requests as adr (
    user_id,
    request_fingerprint,
    state
  )
  values (target_user_id, fingerprint, 'started')
  on conflict (request_fingerprint)
  -- Preserve the last worker heartbeat. Refreshing updated_at here would make a
  -- crashed processing request permanently ineligible for stale-lease reclaim.
  do update set user_id = adr.user_id
  returning
    adr.id,
    adr.state
  into request_id, request_state;

  return next;
end;
$$;

revoke all on function public.begin_account_deletion(uuid, text) from public, anon, authenticated;
grant execute on function public.begin_account_deletion(uuid, text) to service_role;

create or replace function public.advance_account_deletion(
  target_request_id uuid,
  next_state text,
  target_failure_code text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if next_state not in ('started', 'processing', 'storage_deleted', 'completed', 'failed')
    or (
      next_state = 'failed'
      and (
        char_length(coalesce(target_failure_code, '')) not between 1 and 80
        or target_failure_code !~ '^[A-Z0-9_]+$'
      )
    )
  then
    raise exception using errcode = '22023', message = 'Invalid account deletion transition';
  end if;

  update private.account_deletion_requests adr
  set state = next_state,
      failure_code = case when next_state = 'failed' then target_failure_code else null end,
      updated_at = now()
  where adr.id = target_request_id
    and adr.state <> 'completed';

  if not found and not exists (
    select 1
    from private.account_deletion_requests adr
    where adr.id = target_request_id
      and adr.state = 'completed'
  ) then
    raise exception using errcode = '22023', message = 'Account deletion request not found';
  end if;
end;
$$;

revoke all on function public.advance_account_deletion(uuid, text, text) from public, anon, authenticated;
grant execute on function public.advance_account_deletion(uuid, text, text) to service_role;

create or replace function public.claim_account_deletion(
  target_request_id uuid,
  target_user_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  claimed boolean;
begin
  update private.account_deletion_requests adr
  set state = 'processing',
      failure_code = null,
      updated_at = now()
  where adr.id = target_request_id
    and adr.user_id = target_user_id
    and adr.expires_at > now()
    and (
      adr.state in ('started', 'failed', 'storage_deleted')
      or (
        adr.state = 'processing'
        and adr.updated_at < now() - interval '5 minutes'
      )
    )
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;

revoke all on function public.claim_account_deletion(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_account_deletion(uuid, uuid) to service_role;

create or replace function public.prepare_account_deletion(
  target_user_id uuid,
  target_request_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from private.account_deletion_requests adr
    where adr.id = target_request_id
      and adr.user_id = target_user_id
      and adr.state in ('processing', 'storage_deleted')
      and adr.expires_at > now()
  ) then
    raise exception using errcode = '42501', message = 'Valid account deletion request required';
  end if;
  if not exists (select 1 from auth.users u where u.id = target_user_id) then
    return;
  end if;

  update public.businesses b
  set state = 'archived',
      created_by = null
  where exists (
    select 1
    from public.business_members owned
    where owned.business_id = b.id
      and owned.user_id = target_user_id
      and owned.role = 'owner'
      and owned.status = 'active'
  )
    and not exists (
      select 1
      from public.business_members other_owner
      where other_owner.business_id = b.id
        and other_owner.user_id <> target_user_id
        and other_owner.role = 'owner'
        and other_owner.status = 'active'
    );

  update public.businesses
  set created_by = null
  where created_by = target_user_id;

  update public.profiles
  set status = 'deleted'
  where user_id = target_user_id;

  perform private.write_audit_event(
    target_user_id,
    null,
    'account.deletion_prepared',
    'account_deletion',
    target_request_id::text,
    '{}'::jsonb
  );
end;
$$;

drop function if exists public.prepare_account_deletion(uuid);
revoke all on function public.prepare_account_deletion(uuid, uuid) from public, anon, authenticated;
grant execute on function public.prepare_account_deletion(uuid, uuid) to service_role;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_username text;
  requested_display_name text;
  accepted_terms boolean;
begin
  requested_username := nullif(btrim(new.raw_user_meta_data ->> 'username'), '');
  requested_display_name := left(
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), 'Spottr member'),
    80
  );
  accepted_terms := lower(coalesce(new.raw_user_meta_data ->> 'terms_accepted', 'false')) in ('true', '1');

  if not private.username_is_valid(requested_username)
    or not private.content_is_professional(requested_username)
  then
    requested_username := 'user_' || left(replace(new.id::text, '-', ''), 12);
  end if;
  if not private.content_is_professional(requested_display_name) then
    requested_display_name := 'Spottr member';
  end if;

  insert into public.profiles (
    user_id,
    username,
    display_name,
    terms_accepted_at,
    terms_version
  )
  values (
    new.id,
    requested_username,
    requested_display_name,
    case when accepted_terms then now() else null end,
    case when accepted_terms then '2026-07-27' else null end
  );

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure private.handle_new_user();

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists profiles_protect_server_fields on public.profiles;
create trigger profiles_protect_server_fields
before update on public.profiles
for each row execute function private.protect_profile_server_fields();

drop trigger if exists businesses_set_updated_at on public.businesses;
create trigger businesses_set_updated_at before update on public.businesses
for each row execute function public.set_updated_at();

drop trigger if exists businesses_enforce_publication on public.businesses;
create trigger businesses_enforce_publication
before insert or update of kind, state, verification, jurisdiction_id, timezone
on public.businesses
for each row execute function private.enforce_business_publication();

drop trigger if exists businesses_professional_content on public.businesses;
create trigger businesses_professional_content
before insert or update of name, description, cuisine_labels on public.businesses
for each row execute function private.enforce_professional_content();

drop trigger if exists businesses_remove_logo_from_gallery on public.businesses;
create trigger businesses_remove_logo_from_gallery
after insert or update of logo_asset_id on public.businesses
for each row execute function private.remove_logo_from_gallery();

drop trigger if exists business_private_details_set_updated_at on public.business_private_details;
create trigger business_private_details_set_updated_at
before update on public.business_private_details
for each row execute function public.set_updated_at();

drop trigger if exists business_members_require_active_owner on public.business_members;
create constraint trigger business_members_require_active_owner
after insert or update or delete on public.business_members
deferrable initially immediate
for each row execute function private.enforce_business_has_active_owner();

drop trigger if exists business_invitations_set_updated_at
  on private.business_invitations;
create trigger business_invitations_set_updated_at
before update on private.business_invitations
for each row execute function public.set_updated_at();

drop trigger if exists locations_set_updated_at on public.business_locations;
create trigger locations_set_updated_at before update on public.business_locations
for each row execute function public.set_updated_at();

drop trigger if exists locations_enforce_home_privacy on public.business_locations;
create trigger locations_enforce_home_privacy
before insert or update of business_id, public_address, is_approximate
on public.business_locations
for each row execute function private.enforce_home_kitchen_location_privacy();

drop trigger if exists locations_professional_content on public.business_locations;
create trigger locations_professional_content
before insert or update of label, address_line, city, region
on public.business_locations
for each row execute function private.enforce_professional_content();

drop trigger if exists locations_protect_published_setup on public.business_locations;
create trigger locations_protect_published_setup
before insert or update or delete on public.business_locations
for each row execute function private.prevent_published_setup_mutation();

drop trigger if exists mobile_stops_set_updated_at on public.mobile_stops;
create trigger mobile_stops_set_updated_at before update on public.mobile_stops
for each row execute function public.set_updated_at();

drop trigger if exists mobile_stops_emit_public_event on public.mobile_stops;
create trigger mobile_stops_emit_public_event
after insert or update on public.mobile_stops
for each row execute function private.emit_public_business_event();

drop trigger if exists menu_sections_set_updated_at on public.menu_sections;
create trigger menu_sections_set_updated_at before update on public.menu_sections
for each row execute function public.set_updated_at();

drop trigger if exists menu_sections_protect_published_setup on public.menu_sections;
create trigger menu_sections_protect_published_setup
before insert or update or delete on public.menu_sections
for each row execute function private.prevent_published_setup_mutation();

drop trigger if exists menu_sections_professional_content on public.menu_sections;
create trigger menu_sections_professional_content
before insert or update of name on public.menu_sections
for each row execute function private.enforce_professional_content();

drop trigger if exists menu_items_set_updated_at on public.menu_items;
create trigger menu_items_set_updated_at before update on public.menu_items
for each row execute function public.set_updated_at();

drop trigger if exists menu_items_protect_published_setup on public.menu_items;
create trigger menu_items_protect_published_setup
before insert or update or delete on public.menu_items
for each row execute function private.prevent_published_setup_mutation();

drop trigger if exists menu_items_professional_content on public.menu_items;
create trigger menu_items_professional_content
before insert or update of name, description, allergen_note on public.menu_items
for each row execute function private.enforce_professional_content();

drop trigger if exists menu_items_emit_public_event on public.menu_items;
create trigger menu_items_emit_public_event
after insert or update of availability on public.menu_items
for each row execute function private.emit_public_business_event();

drop trigger if exists reviews_set_updated_at on public.reviews;
create trigger reviews_set_updated_at before update on public.reviews
for each row execute function public.set_updated_at();

drop trigger if exists reviews_professional_content on public.reviews;
create trigger reviews_professional_content
before insert or update of body on public.reviews
for each row execute function private.enforce_professional_content();

drop trigger if exists reviews_protect_author_fields on public.reviews;
create trigger reviews_protect_author_fields
before update on public.reviews
for each row execute function private.protect_review_author_fields();

drop trigger if exists responses_set_updated_at on public.business_responses;
create trigger responses_set_updated_at before update on public.business_responses
for each row execute function public.set_updated_at();

drop trigger if exists responses_professional_content on public.business_responses;
create trigger responses_professional_content
before insert or update of body on public.business_responses
for each row execute function private.enforce_professional_content();

drop trigger if exists updates_professional_content on public.business_updates;
drop trigger if exists business_updates_set_updated_at on public.business_updates;
create trigger business_updates_set_updated_at
before update on public.business_updates
for each row execute function public.set_updated_at();

create trigger updates_professional_content
before insert or update of body on public.business_updates
for each row execute function private.enforce_professional_content();

drop trigger if exists business_updates_emit_public_event on public.business_updates;
create trigger business_updates_emit_public_event
after insert or update of moderation, starts_at, expires_at, body on public.business_updates
for each row execute function private.emit_public_business_event();

drop trigger if exists jurisdictions_set_updated_at on public.jurisdictions;
create trigger jurisdictions_set_updated_at before update on public.jurisdictions
for each row execute function public.set_updated_at();

drop trigger if exists live_status_set_updated_at on public.business_live_status;
create trigger live_status_set_updated_at before update on public.business_live_status
for each row execute function public.set_updated_at();

drop trigger if exists live_status_emit_public_event on public.business_live_status;
create trigger live_status_emit_public_event
after insert or update on public.business_live_status
for each row execute function private.emit_public_business_event();

drop trigger if exists reviews_rate_limit_insert on public.reviews;
create trigger reviews_rate_limit_insert
before insert on public.reviews
for each row execute function private.enforce_content_insert_rate_limit();

drop trigger if exists business_updates_rate_limit_insert on public.business_updates;
create trigger business_updates_rate_limit_insert
before insert on public.business_updates
for each row execute function private.enforce_content_insert_rate_limit();

drop trigger if exists business_claims_rate_limit_insert on public.business_claims;
create trigger business_claims_rate_limit_insert
before insert on public.business_claims
for each row execute function private.enforce_content_insert_rate_limit();

drop trigger if exists content_reports_rate_limit_insert on public.content_reports;
create trigger content_reports_rate_limit_insert
before insert on public.content_reports
for each row execute function private.enforce_content_insert_rate_limit();

drop trigger if exists content_reports_validate_target on public.content_reports;
create trigger content_reports_validate_target
before insert or update of target_type, target_id, reporter_id, detail on public.content_reports
for each row execute function private.validate_report_target();

drop trigger if exists business_responses_rate_limit_insert on public.business_responses;
create trigger business_responses_rate_limit_insert
before insert on public.business_responses
for each row execute function private.enforce_content_insert_rate_limit();

drop trigger if exists user_blocks_rate_limit_insert on public.user_blocks;
create trigger user_blocks_rate_limit_insert
before insert on public.user_blocks
for each row execute function private.enforce_content_insert_rate_limit();

drop trigger if exists weekly_hours_protect_published_setup on public.weekly_hours;
create trigger weekly_hours_protect_published_setup
before insert or update or delete on public.weekly_hours
for each row execute function private.prevent_published_setup_mutation();

drop trigger if exists special_hours_protect_published_setup on public.special_hours;
create trigger special_hours_protect_published_setup
before insert or update or delete on public.special_hours
for each row execute function private.prevent_published_setup_mutation();

drop trigger if exists special_hours_professional_content on public.special_hours;
create trigger special_hours_professional_content
before insert or update of note on public.special_hours
for each row execute function private.enforce_professional_content();

drop trigger if exists business_payments_protect_published_setup on public.business_payments;
create trigger business_payments_protect_published_setup
before insert or update or delete on public.business_payments
for each row execute function private.prevent_published_setup_mutation();

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
alter table public.business_media_links enable row level security;
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
alter table public.business_live_status enable row level security;
alter table public.business_public_events enable row level security;
alter table public.audit_events enable row level security;

-- Explicit table grants pair with RLS. Server-owned columns and moderation records
-- cannot be written through PostgREST even if a future policy is accidentally broad.
revoke all privileges on table
  public.profiles,
  public.businesses,
  public.business_private_details,
  public.business_members,
  public.business_claims,
  public.business_locations,
  public.mobile_stops,
  public.weekly_hours,
  public.special_hours,
  public.business_payments,
  public.business_updates,
  public.menu_sections,
  public.menu_items,
  public.media_assets,
  public.business_media_links,
  public.reviews,
  public.review_media,
  public.business_responses,
  public.follows,
  public.notification_preferences,
  public.content_reports,
  public.user_blocks,
  public.provider_links,
  public.jurisdictions,
  public.home_kitchen_permits,
  public.business_live_status,
  public.business_public_events,
  public.audit_events
from anon, authenticated;

grant select on table
  public.businesses,
  public.mobile_stops,
  public.weekly_hours,
  public.special_hours,
  public.business_payments,
  public.business_updates,
  public.menu_sections,
  public.menu_items,
  public.media_assets,
  public.reviews,
  public.review_media,
  public.business_responses,
  public.jurisdictions,
  public.business_live_status,
  public.business_public_events
to anon;

grant select on table
  public.profiles,
  public.businesses,
  public.business_private_details,
  public.business_members,
  public.business_claims,
  public.business_locations,
  public.mobile_stops,
  public.weekly_hours,
  public.special_hours,
  public.business_payments,
  public.business_updates,
  public.menu_sections,
  public.menu_items,
  public.media_assets,
  public.reviews,
  public.review_media,
  public.business_responses,
  public.follows,
  public.notification_preferences,
  public.content_reports,
  public.user_blocks,
  public.provider_links,
  public.jurisdictions,
  public.home_kitchen_permits,
  public.business_live_status,
  public.business_public_events
to authenticated;

-- Profile writes go through update_own_profile(jsonb), which validates the complete
-- payload, rate-limits changes, resolves approved avatar assets, and audits the event.
grant insert, update, delete on public.business_locations to authenticated;
grant insert, update, delete on public.mobile_stops to authenticated;
grant insert, update, delete on public.weekly_hours to authenticated;
grant insert, update, delete on public.special_hours to authenticated;
grant insert, delete on public.business_payments to authenticated;
grant insert, update, delete on public.menu_sections to authenticated;
grant insert, update, delete on public.menu_items to authenticated;
grant insert, delete on public.follows to authenticated;
grant insert, update, delete on public.notification_preferences to authenticated;

-- Profiles contain no email. Only narrow self-service columns are client-writable.
create policy "profiles read own" on public.profiles
  for select to authenticated
  using (user_id = auth.uid());
create policy "active users update own profile" on public.profiles
  for update to authenticated
  using (user_id = auth.uid() and private.is_active_user(auth.uid()))
  with check (user_id = auth.uid() and private.is_active_user(auth.uid()));

create policy "eligible businesses are readable" on public.businesses
  for select to anon
  using (private.is_business_publicly_eligible(id));
create policy "active members read business drafts" on public.businesses
  for select to authenticated
  using (private.has_aal2() and private.is_business_member(id, auth.uid()));

create policy "owners and managers read private details" on public.business_private_details
  for select to authenticated
  using (
    private.has_aal2()
    and
    private.is_business_member(
      business_id,
      auth.uid(),
      array['owner', 'manager']::public.member_role[]
    )
  );

create policy "members read own membership rows" on public.business_members
  for select to authenticated
  using (private.has_aal2() and user_id = auth.uid());

-- Claims are created only by submit_business_claim(), never by raw client inserts.
create policy "claimants read own claims" on public.business_claims
  for select to authenticated
  using (private.has_aal2() and claimant_id = auth.uid());

-- Exact coordinates and unpublished locations remain member-only.
create policy "active members read exact locations" on public.business_locations
  for select to authenticated
  using (
    private.has_aal2()
    and private.is_business_member(business_id, auth.uid())
  );
create policy "owners and managers create private locations" on public.business_locations
  for insert to authenticated
  with check (
    publication_state = 'private'
    and private.can_manage_business_draft(business_id, auth.uid())
  );
create policy "owners and managers update private locations" on public.business_locations
  for update to authenticated
  using (
    private.can_manage_business_draft(business_id, auth.uid())
  )
  with check (
    publication_state = 'private'
    and private.can_manage_business_draft(business_id, auth.uid())
  );
create policy "owners and managers delete locations" on public.business_locations
  for delete to authenticated
  using (private.can_manage_business_draft(business_id, auth.uid()));

create policy "eligible published stops are readable" on public.mobile_stops
  for select to anon, authenticated
  using (
    state in ('scheduled', 'live', 'completed')
    and private.is_business_publicly_eligible(business_id)
    and private.is_published_business_location(location_id, business_id)
  );
create policy "active members manage stops" on public.mobile_stops
  for all to authenticated
  using (
    state = 'draft'
    and private.can_manage_business_draft(business_id, auth.uid())
  )
  with check (
    state = 'draft'
    and private.can_manage_business_draft(business_id, auth.uid())
  );
create policy "active members read all business stops" on public.mobile_stops
  for select to authenticated
  using (
    private.has_aal2()
    and private.is_business_member(business_id, auth.uid())
  );

create policy "eligible weekly hours are readable" on public.weekly_hours
  for select to anon, authenticated
  using (private.is_business_publicly_eligible(business_id));
create policy "active members manage weekly hours" on public.weekly_hours
  for all to authenticated
  using (private.can_manage_business_draft(business_id, auth.uid()))
  with check (private.can_manage_business_draft(business_id, auth.uid()));

create policy "eligible special hours are readable" on public.special_hours
  for select to anon, authenticated
  using (private.is_business_publicly_eligible(business_id));
create policy "active members manage special hours" on public.special_hours
  for all to authenticated
  using (private.can_manage_business_draft(business_id, auth.uid()))
  with check (private.can_manage_business_draft(business_id, auth.uid()));

create policy "eligible payments are readable" on public.business_payments
  for select to anon, authenticated
  using (private.is_business_publicly_eligible(business_id));
create policy "owners and managers manage payments" on public.business_payments
  for all to authenticated
  using (private.can_manage_business_draft(business_id, auth.uid()))
  with check (private.can_manage_business_draft(business_id, auth.uid()));

create policy "approved active updates are readable" on public.business_updates
  for select to anon
  using (
    moderation = 'approved'
    and starts_at <= now()
    and expires_at > now()
    and private.is_business_publicly_eligible(business_id)
  );
create policy "active members submit updates" on public.business_updates
  for insert to authenticated
  with check (
    private.has_aal2()
    and
    author_id = auth.uid()
    and moderation = 'pending'
    and private.is_business_member(business_id, auth.uid())
  );
create policy "members read business update queue" on public.business_updates
  for select to authenticated
  using (
    private.has_aal2()
    and private.is_business_member(business_id, auth.uid())
  );

create policy "eligible menu sections are readable" on public.menu_sections
  for select to anon, authenticated
  using (is_published and private.is_business_publicly_eligible(business_id));
create policy "active members manage menu sections" on public.menu_sections
  for all to authenticated
  using (private.can_manage_business_draft(business_id, auth.uid()))
  with check (private.can_manage_business_draft(business_id, auth.uid()));

create policy "eligible menu items are readable" on public.menu_items
  for select to anon, authenticated
  using (
    is_published
    and exists (
      select 1
      from public.menu_sections ms
      where ms.id = section_id
        and ms.is_published
        and private.is_business_publicly_eligible(ms.business_id)
    )
  );
create policy "active members manage menu items" on public.menu_items
  for all to authenticated
  using (
    exists (
      select 1
      from public.menu_sections ms
      where ms.id = section_id
        and private.can_manage_business_draft(ms.business_id, auth.uid())
    )
  )
  with check (
    exists (
      select 1
      from public.menu_sections ms
      where ms.id = section_id
        and private.can_manage_business_draft(ms.business_id, auth.uid())
    )
  );

create policy "approved clean media records are readable" on public.media_assets
  for select to anon
  using (private.is_media_publicly_eligible(id));
create policy "owners and business members read media queue" on public.media_assets
  for select to authenticated
  using (
    private.has_aal2()
    and (
      owner_id = auth.uid()
    or (
      business_id is not null
      and private.is_business_member(business_id, auth.uid())
    )
    )
  );

create policy "approved eligible reviews are readable" on public.reviews
  for select to anon
  using (
    moderation = 'approved'
    and deleted_at is null
    and private.is_business_publicly_eligible(business_id)
    and (
      auth.uid() is null
      or not private.users_are_blocked(auth.uid(), author_id)
    )
  );
create policy "authors read own review submissions" on public.reviews
  for select to authenticated
  using (author_id = auth.uid());
create policy "active users submit reviews" on public.reviews
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and moderation = 'pending'
    and helpful_count = 0
    and deleted_at is null
    and private.is_active_user(auth.uid())
    and private.is_business_publicly_eligible(business_id)
  );
create policy "active authors revise reviews" on public.reviews
  for update to authenticated
  using (
    author_id = auth.uid()
    and private.is_active_user(auth.uid())
  )
  with check (
    author_id = auth.uid()
    and private.is_active_user(auth.uid())
    and private.is_business_publicly_eligible(business_id)
  );

create policy "approved review media links are readable" on public.review_media
  for select to anon, authenticated
  using (
    exists (
      select 1
      from public.reviews r
      join public.media_assets ma on ma.id = review_media.asset_id
      where r.id = review_media.review_id
        and r.moderation = 'approved'
        and r.deleted_at is null
        and ma.moderation = 'approved'
        and ma.quarantine_state = 'clean'
        and private.is_business_publicly_eligible(r.business_id)
        and (
          auth.uid() is null
          or not private.users_are_blocked(auth.uid(), r.author_id)
        )
    )
  );
create policy "authors attach own quarantined review media" on public.review_media
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.reviews r
      where r.id = review_id
        and r.author_id = auth.uid()
        and r.moderation = 'pending'
    )
    and exists (
      select 1
      from public.media_assets ma
      where ma.id = asset_id
        and ma.owner_id = auth.uid()
        and ma.source = 'review_upload'
        and ma.moderation = 'pending'
    )
  );
create policy "authors detach own pending review media" on public.review_media
  for delete to authenticated
  using (
    exists (
      select 1
      from public.reviews r
      where r.id = review_id
        and r.author_id = auth.uid()
        and r.moderation = 'pending'
    )
  );

create policy "approved eligible responses are readable" on public.business_responses
  for select to anon
  using (
    moderation = 'approved'
    and private.is_business_publicly_eligible(business_id)
    and exists (
      select 1
      from public.reviews r
      where r.id = review_id
        and r.business_id = business_responses.business_id
        and r.moderation = 'approved'
        and r.deleted_at is null
    )
    and (
      auth.uid() is null
      or author_id is null
      or not private.users_are_blocked(auth.uid(), author_id)
    )
  );
create policy "members read response queue" on public.business_responses
  for select to authenticated
  using (
    private.has_aal2()
    and private.is_business_member(business_id, auth.uid())
  );
create policy "active members submit responses" on public.business_responses
  for insert to authenticated
  with check (
    private.has_aal2()
    and
    author_id = auth.uid()
    and moderation = 'pending'
    and private.is_business_member(business_id, auth.uid())
  );

create policy "users read own follows" on public.follows
  for select to authenticated
  using (user_id = auth.uid());
create policy "active users follow eligible businesses" on public.follows
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and private.is_active_user(auth.uid())
    and private.is_business_publicly_eligible(business_id)
  );
create policy "users delete own follows" on public.follows
  for delete to authenticated
  using (user_id = auth.uid());

create policy "users manage own notification preferences" on public.notification_preferences
  for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and private.is_active_user(auth.uid())
    and private.is_business_publicly_eligible(business_id)
  );

create policy "active users create reports" on public.content_reports
  for insert to authenticated
  with check (
    reporter_id = auth.uid()
    and state = 'open'
    and private.is_active_user(auth.uid())
  );
create policy "users read own reports" on public.content_reports
  for select to authenticated
  using (reporter_id = auth.uid());

create policy "users read own blocks" on public.user_blocks
  for select to authenticated
  using (blocker_id = auth.uid());
create policy "active users create own blocks" on public.user_blocks
  for insert to authenticated
  with check (
    blocker_id = auth.uid()
    and private.is_active_user(auth.uid())
  );
create policy "users delete own blocks" on public.user_blocks
  for delete to authenticated
  using (blocker_id = auth.uid());

create policy "owners and managers read provider links" on public.provider_links
  for select to authenticated
  using (
    private.is_business_member(
      business_id,
      auth.uid(),
      array['owner', 'manager']::public.member_role[]
    )
  );

create policy "legally reviewed jurisdictions are readable" on public.jurisdictions
  for select to anon, authenticated
  using (legal_reviewed_at is not null);

create policy "owners and managers read permit status" on public.home_kitchen_permits
  for select to authenticated
  using (
    private.has_aal2()
    and private.is_business_member(
      business_id,
      auth.uid(),
      array['owner', 'manager']::public.member_role[]
    )
  );

create policy "active eligible live status is readable" on public.business_live_status
  for select to anon
  using (
    expires_at > now()
    and private.is_business_publicly_eligible(business_id)
  );
create policy "members read their live status history" on public.business_live_status
  for select to authenticated
  using (
    private.has_aal2()
    and private.is_business_member(business_id, auth.uid())
  );

create policy "active public business events are readable" on public.business_public_events
  for select to anon, authenticated
  using (
    expires_at > now()
    and private.is_business_publicly_eligible(business_id)
  );

create policy "actors and owners read audit events" on public.audit_events
  for select to authenticated
  using (
    private.has_aal2()
    and (
      actor_id = auth.uid()
      or (
        business_id is not null
        and private.is_business_member(
          business_id,
          auth.uid(),
          array['owner']::public.member_role[]
        )
      )
    )
  );

drop view if exists public.public_review_media;
drop view if exists public.public_business_media;
drop view if exists public.public_business_review_aggregates;
drop view if exists public.public_business_responses;
drop view if exists public.public_reviews;
drop view if exists public.public_business_updates;
drop view if exists public.public_business_live_status;
drop view if exists public.public_media_assets;
drop view if exists public.public_business_locations;
drop view if exists public.public_business_contacts;
drop view if exists public.public_business_directory;
drop view if exists public.public_profiles;

-- Public projections deliberately contain no auth.users UUID, moderation actor,
-- private verification evidence, raw quarantine path, or non-opted-in contact.
create view public.public_profiles
with (security_barrier = true, security_invoker = false)
as
select
  p.public_id,
  p.username::text as username,
  p.display_name,
  p.avatar_path
from public.profiles p
where p.status = 'active'
  and exists (
    select 1
    from public.reviews r
    where r.author_id = p.user_id
      and r.moderation = 'approved'
      and r.deleted_at is null
      and private.is_business_publicly_eligible(r.business_id)
  );

create view public.public_business_directory
with (security_barrier = true, security_invoker = false)
as
select
  b.id as business_id,
  b.kind,
  b.name,
  b.slug::text as slug,
  b.description,
  b.cuisine_labels,
  b.price_level,
  b.verification,
  b.timezone,
  b.provenance,
  b.provider_freshness_at,
  logo.id as logo_asset_id,
  logo.processed_storage_path as logo_path,
  private.business_effective_status(b.id, b.timezone) as effective_status,
  (now() at time zone b.timezone)::date as today_service_date,
  effective_hours.opens_at as today_opens_at,
  effective_hours.closes_at as today_closes_at,
  effective_hours.is_closed as today_is_closed,
  effective_hours.hours_source,
  now() as status_computed_at,
  b.created_at,
  b.updated_at
from public.businesses b
left join public.media_assets logo
  on logo.id = b.logo_asset_id
 and logo.business_id = b.id
 and logo.quarantine_state = 'clean'
 and logo.moderation = 'approved'
 and logo.processed_storage_path is not null
left join lateral (
  select
    sh.opens_at,
    sh.closes_at,
    sh.is_closed,
    'special'::text as hours_source
  from public.special_hours sh
  where sh.business_id = b.id
    and sh.service_date = (now() at time zone b.timezone)::date
  union all
  select
    wh.opens_at,
    wh.closes_at,
    wh.is_closed,
    'weekly'::text as hours_source
  from public.weekly_hours wh
  where wh.business_id = b.id
    and wh.weekday = extract(dow from now() at time zone b.timezone)::smallint
    and not exists (
      select 1
      from public.special_hours override
      where override.business_id = b.id
        and override.service_date = (now() at time zone b.timezone)::date
    )
  limit 1
) effective_hours on true
where private.is_business_publicly_eligible(b.id);

create view public.public_business_contacts
with (security_barrier = true, security_invoker = false)
as
select
  bpd.business_id,
  case when bpd.show_phone_public then bpd.business_phone else null end as phone,
  case when bpd.show_website_public then bpd.website_url else null end as website_url
from public.business_private_details bpd
where private.is_business_publicly_eligible(bpd.business_id)
  and (
    (bpd.show_phone_public and bpd.business_phone is not null)
    or (bpd.show_website_public and bpd.website_url is not null)
  );

create view public.public_business_locations
with (security_barrier = true, security_invoker = false)
as
with redacted as (
  select
    bl.id as location_id,
    bl.business_id,
    case
      when b.kind = 'home_kitchen' or not bl.public_address then 'Approximate area'
      else bl.label
    end as label,
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
      when b.kind = 'home_kitchen' or not bl.public_address or bl.is_approximate then
        public.st_snaptogrid(bl.point::public.geometry, 0.05)
      else bl.point::public.geometry
    end as safe_point,
    (bl.is_approximate or not bl.public_address or b.kind = 'home_kitchen') as is_approximate,
    bl.is_primary
  from public.business_locations bl
  join public.businesses b on b.id = bl.business_id
  where bl.publication_state = 'published'
    and private.is_business_publicly_eligible(bl.business_id)
)
select
  r.location_id,
  r.business_id,
  r.label,
  r.address_line,
  r.city,
  r.region,
  r.postal_code,
  public.st_y(r.safe_point) as latitude,
  public.st_x(r.safe_point) as longitude,
  r.is_approximate,
  r.is_primary
from redacted r;

create view public.public_business_updates
with (security_barrier = true, security_invoker = false)
as
select
  bu.id as update_id,
  bu.business_id,
  bu.kind,
  bu.body,
  bu.starts_at,
  bu.expires_at,
  bu.created_at
from public.business_updates bu
where bu.moderation = 'approved'
  and bu.starts_at <= now()
  and bu.expires_at > now()
  and private.is_business_publicly_eligible(bu.business_id);

create view public.public_business_live_status
with (security_barrier = true, security_invoker = false)
as
select
  bls.business_id,
  bls.status,
  bls.confirmed_at,
  bls.expires_at,
  bls.updated_at
from public.business_live_status bls
where bls.expires_at > now()
  and private.is_business_publicly_eligible(bls.business_id);

create view public.public_reviews
with (security_barrier = true, security_invoker = false)
as
select
  r.id as review_id,
  r.business_id,
  p.public_id as author_public_id,
  p.username::text as author_username,
  p.display_name as author_display_name,
  p.avatar_path as author_avatar_path,
  r.rating,
  r.body,
  r.helpful_count,
  r.created_at,
  r.updated_at
from public.reviews r
join public.profiles p
  on p.user_id = r.author_id
 and p.status = 'active'
where r.moderation = 'approved'
  and r.deleted_at is null
  and private.is_business_publicly_eligible(r.business_id)
  and (
    auth.uid() is null
    or not private.users_are_blocked(auth.uid(), r.author_id)
  );

create view public.public_business_responses
with (security_barrier = true, security_invoker = false)
as
select
  br.review_id as response_id,
  br.review_id,
  br.business_id,
  br.body,
  br.created_at,
  br.updated_at
from public.business_responses br
join public.reviews r
  on r.id = br.review_id
 and r.business_id = br.business_id
where br.moderation = 'approved'
  and r.moderation = 'approved'
  and r.deleted_at is null
  and private.is_business_publicly_eligible(br.business_id)
  and (
    auth.uid() is null
    or br.author_id is null
    or not private.users_are_blocked(auth.uid(), br.author_id)
  );

create view public.public_media_assets
with (security_barrier = true, security_invoker = false)
as
select
  ma.id as asset_id,
  ma.business_id,
  ma.processed_storage_path as storage_path,
  ma.mime_type,
  ma.width,
  ma.height,
  ma.byte_size,
  ma.source,
  ma.license_note,
  ma.created_at
from public.media_assets ma
where private.is_media_publicly_eligible(ma.id);

create view public.public_business_media
with (security_barrier = true, security_invoker = false)
as
select
  selected.business_id,
  ma.id as asset_id,
  selected.media_role,
  selected.sort_order,
  ma.processed_storage_path as storage_path,
  ma.mime_type,
  ma.width,
  ma.height,
  ma.byte_size,
  ma.source,
  ma.license_note,
  ma.created_at
from (
  select
    b.id as business_id,
    b.logo_asset_id as asset_id,
    'logo'::text as media_role,
    (-1)::smallint as sort_order
  from public.businesses b
  where b.logo_asset_id is not null
  union all
  select
    link.business_id,
    link.asset_id,
    link.media_role,
    link.sort_order
  from public.business_media_links link
) selected
join public.media_assets ma
  on ma.id = selected.asset_id
 and ma.business_id = selected.business_id
where ma.source in ('owner_upload', 'licensed_provider')
  and private.is_media_publicly_eligible(ma.id);

create view public.public_review_media
with (security_barrier = true, security_invoker = false)
as
select
  rm.review_id,
  rm.asset_id,
  rm.sort_order,
  ma.processed_storage_path as storage_path,
  ma.mime_type,
  ma.width,
  ma.height
from public.review_media rm
join public.reviews r on r.id = rm.review_id
join public.media_assets ma on ma.id = rm.asset_id
where r.moderation = 'approved'
  and r.deleted_at is null
  and private.is_business_publicly_eligible(r.business_id)
  and private.is_media_publicly_eligible(ma.id)
  and (
    auth.uid() is null
    or not private.users_are_blocked(auth.uid(), r.author_id)
  );

create view public.public_business_review_aggregates
with (security_barrier = true, security_invoker = false)
as
select
  b.id as business_id,
  count(r.id)::integer as review_count,
  coalesce(round(avg(r.rating)::numeric, 2), 0::numeric) as average_rating,
  count(r.id) filter (where r.created_at >= now() - interval '7 days')::integer
    as recent_review_count_7d,
  count(r.id) filter (where r.created_at >= now() - interval '30 days')::integer
    as recent_review_count_30d,
  (
    select count(*)::integer
    from public.follows f
    where f.business_id = b.id
  ) as follower_count,
  exists (
    select 1
    from public.business_updates bu
    where bu.business_id = b.id
      and bu.moderation = 'approved'
      and bu.starts_at <= now()
      and bu.expires_at > now()
  ) as has_active_owner_update
from public.businesses b
left join public.reviews r
  on r.business_id = b.id
 and r.moderation = 'approved'
 and r.deleted_at is null
where private.is_business_publicly_eligible(b.id)
group by b.id;

revoke all privileges on
  public.public_profiles,
  public.public_business_directory,
  public.public_business_contacts,
  public.public_business_locations,
  public.public_business_updates,
  public.public_business_live_status,
  public.public_reviews,
  public.public_business_responses,
  public.public_media_assets,
  public.public_business_media,
  public.public_review_media,
  public.public_business_review_aggregates
from public, anon, authenticated;

grant select on
  public.public_profiles,
  public.public_business_directory,
  public.public_business_contacts,
  public.public_business_locations,
  public.public_business_updates,
  public.public_business_live_status,
  public.public_reviews,
  public.public_business_responses,
  public.public_media_assets,
  public.public_business_media,
  public.public_review_media,
  public.public_business_review_aggregates
to anon, authenticated;

-- Auth-ID-bearing base tables are never part of the anonymous API. Authenticated
-- users retain only their RLS-scoped self/member reads; public reads use projections.
revoke select on
  public.businesses,
  public.business_updates,
  public.media_assets,
  public.reviews,
  public.business_responses,
  public.business_live_status
from anon;

drop function if exists public.nearby_businesses(
  double precision,
  double precision,
  integer,
  integer
);
drop function if exists public.nearby_businesses(
  double precision,
  double precision,
  integer,
  integer,
  integer
);

create function public.nearby_businesses(
  search_lat double precision,
  search_lng double precision,
  radius_meters integer default 16093,
  result_limit integer default 50,
  result_offset integer default 0
)
returns table (
  business_id uuid,
  name text,
  kind public.business_kind,
  location_id uuid,
  location_label text,
  city text,
  region text,
  latitude double precision,
  longitude double precision,
  distance_meters double precision,
  is_approximate boolean,
  has_more boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with params as (
    select
      public.st_setsrid(
        public.st_makepoint(search_lng, search_lat),
        4326
      )::public.geography as search_point,
      least(greatest(coalesce(radius_meters, 16093), 500), 80467)::double precision
        as exact_radius
    where search_lat between -90 and 90
      and search_lng between -180 and 180
  ),
  -- This materialized pass deliberately references the indexed base geography.
  -- The extra 10 km covers worst-case 0.05-degree privacy snapping before the
  -- exact distance is evaluated against the redacted point.
  coarse_candidates as materialized (
    select
      b.id as business_id,
      b.name,
      b.kind,
      bl.id as location_id,
      case
        when b.kind = 'home_kitchen' or not bl.public_address
          then 'Approximate area'
        else bl.label
      end as location_label,
      bl.city,
      bl.region,
      case
        when b.kind = 'home_kitchen' or not bl.public_address or bl.is_approximate
          then public.st_snaptogrid(bl.point::public.geometry, 0.05)::public.geography
        else bl.point
      end as safe_point,
      (bl.is_approximate or not bl.public_address or b.kind = 'home_kitchen')
        as is_approximate,
      bl.is_primary
    from params p
    join public.business_locations bl
      on public.st_dwithin(bl.point, p.search_point, p.exact_radius + 10000)
    join public.businesses b on b.id = bl.business_id
    where bl.publication_state = 'published'
      and private.is_business_publicly_eligible(b.id)
      and (
        b.kind not in ('food_truck', 'pop_up')
        or bl.id = coalesce(
          (
            select ms.location_id
            from public.mobile_stops ms
            where ms.business_id = b.id
              and ms.state in ('scheduled', 'live')
              and now() >= ms.starts_at
              and now() < ms.ends_at
            order by
              case when ms.state = 'live' then 0 else 1 end,
              ms.confirmed_at desc nulls last,
              ms.starts_at desc,
              ms.id
            limit 1
          ),
          (
            select primary_location.id
            from public.business_locations primary_location
            where primary_location.business_id = b.id
              and primary_location.publication_state = 'published'
            order by
              primary_location.is_primary desc,
              primary_location.id
            limit 1
          )
        )
      )
  ),
  exact_candidates as (
    select
      coarse.business_id,
      coarse.name,
      coarse.kind,
      coarse.location_id,
      coarse.location_label,
      coarse.city,
      coarse.region,
      public.st_y(coarse.safe_point::public.geometry) as latitude,
      public.st_x(coarse.safe_point::public.geometry) as longitude,
      public.st_distance(coarse.safe_point, p.search_point) as distance_meters,
      coarse.is_approximate,
      row_number() over (
        partition by coarse.business_id
        order by
          public.st_distance(coarse.safe_point, p.search_point),
          coarse.is_primary desc,
          coarse.location_id
      ) as location_rank
    from coarse_candidates coarse
    cross join params p
    where public.st_dwithin(coarse.safe_point, p.search_point, p.exact_radius)
  ),
  page_candidates as materialized (
    select c.*
    from exact_candidates c
    where c.location_rank = 1
    order by
      case when c.kind = 'food_truck' then 0 else 1 end,
      c.distance_meters,
      c.business_id
    offset least(greatest(coalesce(result_offset, 0), 0), 10000)
    limit least(greatest(coalesce(result_limit, 50), 1), 100) + 1
  )
  select
    c.business_id,
    c.name,
    c.kind,
    c.location_id,
    c.location_label,
    c.city,
    c.region,
    c.latitude,
    c.longitude,
    c.distance_meters,
    c.is_approximate,
    (
      select count(*) >
        least(greatest(coalesce(result_limit, 50), 1), 100)
      from page_candidates page_count
    ) as has_more
  from page_candidates c
  order by
    case when c.kind = 'food_truck' then 0 else 1 end,
    c.distance_meters,
    c.business_id
  limit least(greatest(coalesce(result_limit, 50), 1), 100);
$$;

revoke all on function public.nearby_businesses(
  double precision,
  double precision,
  integer,
  integer,
  integer
) from public;
grant execute on function public.nearby_businesses(
  double precision,
  double precision,
  integer,
  integer,
  integer
) to anon, authenticated;

drop function if exists public.search_businesses(text, integer);
drop function if exists public.search_businesses(text, integer, integer);

create function public.search_businesses(
  search_text text,
  result_limit integer default 25,
  result_offset integer default 0
)
returns table (
  business_id uuid,
  name text,
  kind public.business_kind,
  cuisine_labels text[],
  price_level smallint,
  logo_path text,
  location_id uuid,
  city text,
  region text,
  postal_code text,
  latitude double precision,
  longitude double precision,
  is_approximate boolean,
  review_count integer,
  average_rating numeric,
  has_more boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_search text := lower(
    regexp_replace(btrim(coalesce(search_text, '')), '[[:space:]]+', ' ', 'g')
  );
  escaped_search text;
  substring_pattern text;
  prefix_pattern text;
begin
  if char_length(normalized_search) not between 1 and 120
    or normalized_search ~ '[[:cntrl:]]'
  then
    raise exception using errcode = '22023', message = 'Invalid search text';
  end if;
  escaped_search := replace(
    replace(replace(normalized_search, E'\\', E'\\\\'), '%', E'\\%'),
    '_',
    E'\\_'
  );
  substring_pattern := '%' || escaped_search || '%';
  prefix_pattern := escaped_search || '%';

  return query
  with matched_business_ids as materialized (
    select b.id as business_id
    from public.businesses b
    where char_length(normalized_search) >= 3
      and (
        lower(b.name) like substring_pattern escape E'\\'
        or lower(b.description) like substring_pattern escape E'\\'
        or private.searchable_text_array(b.cuisine_labels)
          like substring_pattern escape E'\\'
      )
    union
    select b.id
    from public.businesses b
    where char_length(normalized_search) < 3
      and lower(b.name) like prefix_pattern escape E'\\'
    union
    select bl.business_id
    from public.business_locations bl
    where bl.publication_state = 'published'
      and (
        (
          char_length(normalized_search) >= 3
          and (
            lower(bl.city) like substring_pattern escape E'\\'
            or lower(bl.region) like substring_pattern escape E'\\'
            or (
              bl.postal_code is not null
              and lower(bl.postal_code) like substring_pattern escape E'\\'
            )
          )
        )
        or (
          char_length(normalized_search) < 3
          and (
            lower(bl.city) like prefix_pattern escape E'\\'
            or lower(bl.region) like prefix_pattern escape E'\\'
            or (
              bl.postal_code is not null
              and lower(bl.postal_code) like prefix_pattern escape E'\\'
            )
          )
        )
      )
  ),
  page_candidates as materialized (
  select
    d.business_id,
    d.name,
    d.kind,
    d.cuisine_labels,
    d.price_level,
    d.logo_path,
    loc.location_id,
    loc.city,
    loc.region,
    loc.postal_code,
    loc.latitude,
    loc.longitude,
    loc.is_approximate,
    agg.review_count,
    agg.average_rating
  from public.public_business_directory d
  join matched_business_ids matched on matched.business_id = d.business_id
  join lateral (
    select pbl.*
    from public.public_business_locations pbl
    where pbl.business_id = d.business_id
    order by
      case
        when lower(coalesce(pbl.postal_code, '')) = normalized_search then 0
        when lower(pbl.city) like substring_pattern escape E'\\' then 1
        when lower(pbl.region) like substring_pattern escape E'\\' then 2
        else 3
      end,
      pbl.is_primary desc,
      pbl.location_id
    limit 1
  ) loc on true
  join public.public_business_review_aggregates agg on agg.business_id = d.business_id
  order by
    case
      when lower(d.name) = normalized_search then 0
      when lower(d.name) like prefix_pattern escape E'\\' then 1
      when lower(coalesce(loc.postal_code, '')) = normalized_search then 2
      when lower(loc.city) like prefix_pattern escape E'\\' then 3
      else 4
    end,
    case when d.kind = 'food_truck' then 0 else 1 end,
    agg.review_count desc,
    d.name,
    d.business_id
  offset least(greatest(coalesce(result_offset, 0), 0), 10000)
  limit least(greatest(coalesce(result_limit, 25), 1), 100) + 1
  )
  select
    page.business_id,
    page.name,
    page.kind,
    page.cuisine_labels,
    page.price_level,
    page.logo_path,
    page.location_id,
    page.city,
    page.region,
    page.postal_code,
    page.latitude,
    page.longitude,
    page.is_approximate,
    page.review_count,
    page.average_rating,
    (
      select count(*) >
        least(greatest(coalesce(result_limit, 25), 1), 100)
      from page_candidates page_count
    ) as has_more
  from page_candidates page
  order by
    case
      when lower(page.name) = normalized_search then 0
      when lower(page.name) like prefix_pattern escape E'\\' then 1
      when lower(coalesce(page.postal_code, '')) = normalized_search then 2
      when lower(page.city) like prefix_pattern escape E'\\' then 3
      else 4
    end,
    case when page.kind = 'food_truck' then 0 else 1 end,
    page.review_count desc,
    page.name,
    page.business_id
  limit least(greatest(coalesce(result_limit, 25), 1), 100);
end;
$$;

revoke all on function public.search_businesses(text, integer, integer) from public;
grant execute on function public.search_businesses(text, integer, integer) to anon, authenticated;

alter table public.business_public_events replica identity full;

do $$
begin
  if exists (
    select 1
    from pg_catalog.pg_publication p
    where p.pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_catalog.pg_publication_tables pt
    where pt.pubname = 'supabase_realtime'
      and pt.schemaname = 'public'
      and pt.tablename = 'business_public_events'
  ) then
    alter publication supabase_realtime add table public.business_public_events;
  end if;
end;
$$;

-- Uploads enter a private quarantine namespace. Client code cannot mark an object
-- clean or approved; a service-role scanner records clean, re-encoded output.
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'spottr-media',
  'spottr-media',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id)
do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "authenticated users upload staged media" on storage.objects;
drop policy if exists "users read own staged media" on storage.objects;
drop policy if exists "authenticated users upload quarantine media" on storage.objects;

-- There is deliberately no generic INSERT policy. Upload capability is a
-- short-lived, random-path signed token minted by the media-stage Edge Function
-- after active-account, purpose, AAL2, size, membership, and rate-limit checks.

create policy "users read own quarantine media"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'spottr-media'
    and (storage.foldername(name))[1] = 'quarantine'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

create policy "users delete own quarantine media"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'spottr-media'
    and (storage.foldername(name))[1] = 'quarantine'
    and (storage.foldername(name))[2] = auth.uid()::text
    and not exists (
      select 1
      from public.media_assets ma
      where ma.storage_path = name
        and ma.quarantine_state = 'clean'
    )
  );

create policy "approved processed media is readable"
  on storage.objects for select to anon, authenticated
  using (
    bucket_id = 'spottr-media'
    and exists (
      select 1
      from public.media_assets ma
      where ma.processed_storage_path = name
        and private.is_media_publicly_eligible(ma.id)
    )
  );

-- There are intentionally no generic client policies for publishing businesses or
-- locations, approving claims/permits/content, changing verification, writing audit
-- events, or promoting quarantined media. Those actions are audited RPC/service paths.
