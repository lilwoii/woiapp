-- Spottr secure marketplace chat foundation.
--
-- Chat is intentionally limited to published, eligible Neighborhood Kitchens and
-- opted-in pop-ups. Exact pickup details are not chat text or listing fields: they
-- are private, expiring disclosures for staff-reviewed non-residential sites after
-- a customer request and merchant authorization. This technical boundary reduces
-- exposure; it is not a substitute for jurisdiction-specific legal/safety review.

create table if not exists public.business_marketplace_chat_settings (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  enabled boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.marketplace_conversations (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null default gen_random_uuid() unique,
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_id uuid not null references auth.users(id) on delete cascade,
  merchant_id uuid not null references auth.users(id) on delete cascade,
  state text not null default 'open'
    check (state in ('open', 'closed_by_customer', 'closed_by_merchant', 'restricted')),
  last_sequence bigint not null default 0 check (last_sequence >= 0),
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketplace_conversations_distinct_participants
    check (customer_id <> merchant_id),
  unique (business_id, customer_id),
  unique (id, business_id)
);

create index if not exists marketplace_conversations_customer_time_idx
  on public.marketplace_conversations (customer_id, last_message_at desc nulls last, created_at desc);
create index if not exists marketplace_conversations_merchant_time_idx
  on public.marketplace_conversations (merchant_id, last_message_at desc nulls last, created_at desc);
create index if not exists marketplace_conversations_business_time_idx
  on public.marketplace_conversations (business_id, last_message_at desc nulls last, created_at desc);

create table if not exists public.marketplace_messages (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null default gen_random_uuid() unique,
  conversation_id uuid not null references public.marketplace_conversations(id) on delete cascade,
  sender_id uuid references auth.users(id) on delete set null,
  sequence bigint not null check (sequence > 0),
  body text,
  visibility text not null default 'visible'
    check (visibility in ('visible', 'held', 'removed')),
  moderation_reason text,
  sent_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  constraint marketplace_messages_body_length
    check (body is null or char_length(body) between 1 and 1000),
  constraint marketplace_messages_moderation_reason_length
    check (moderation_reason is null or char_length(moderation_reason) between 1 and 240),
  constraint marketplace_messages_edit_time
    check (edited_at is null or edited_at >= sent_at),
  constraint marketplace_messages_delete_shape
    check ((deleted_at is null) or visibility = 'removed'),
  unique (conversation_id, sequence),
  unique (id, conversation_id)
);

create index if not exists marketplace_messages_conversation_sequence_idx
  on public.marketplace_messages (conversation_id, sequence desc);
create index if not exists marketplace_messages_sender_time_idx
  on public.marketplace_messages (sender_id, sent_at desc)
  where sender_id is not null;

create table if not exists public.marketplace_message_media (
  message_id uuid not null references public.marketplace_messages(id) on delete cascade,
  asset_id uuid not null references public.media_assets(id) on delete cascade,
  sort_order smallint not null check (sort_order between 0 and 3),
  created_at timestamptz not null default now(),
  primary key (message_id, asset_id),
  unique (message_id, sort_order)
);

create index if not exists marketplace_message_media_asset_idx
  on public.marketplace_message_media (asset_id, message_id);

create table if not exists public.marketplace_read_receipts (
  conversation_id uuid not null references public.marketplace_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_read_sequence bigint not null default 0 check (last_read_sequence >= 0),
  read_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table if not exists public.marketplace_typing_presence (
  conversation_id uuid not null references public.marketplace_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (conversation_id, user_id),
  constraint marketplace_typing_presence_short_ttl
    check (expires_at > updated_at and expires_at <= updated_at + interval '15 seconds')
);

create index if not exists marketplace_typing_presence_expiry_idx
  on public.marketplace_typing_presence (expires_at);

-- Public-schema pickup records expose workflow state and coarse locality only.
-- Exact address/coordinates and safety review notes stay in the private schema.
create table if not exists public.marketplace_pickup_sites (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null default gen_random_uuid() unique,
  business_id uuid not null references public.businesses(id) on delete cascade,
  label text not null,
  city text not null,
  region text not null,
  site_kind text not null
    check (site_kind in ('public_meeting_place', 'commercial_site')),
  state text not null default 'submitted'
    check (state in ('submitted', 'approved', 'rejected', 'archived')),
  submitted_by uuid references auth.users(id) on delete set null,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketplace_pickup_sites_label_length
    check (char_length(btrim(label)) between 1 and 120),
  constraint marketplace_pickup_sites_city_length
    check (char_length(btrim(city)) between 1 and 120),
  constraint marketplace_pickup_sites_region_length
    check (char_length(btrim(region)) between 1 and 80),
  constraint marketplace_pickup_sites_review_shape check (
    (state = 'submitted' and reviewed_by is null and reviewed_at is null)
    or (state in ('approved', 'rejected') and reviewed_by is not null and reviewed_at is not null)
    or state = 'archived'
  )
);

create index if not exists marketplace_pickup_sites_business_state_idx
  on public.marketplace_pickup_sites (business_id, state, updated_at desc);

create table if not exists private.marketplace_pickup_site_details (
  site_id uuid primary key references public.marketplace_pickup_sites(id) on delete cascade,
  address_line text not null,
  postal_code text,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  review_reason text,
  non_residential_confirmed boolean not null default false,
  non_residential_confirmed_by uuid references auth.users(id) on delete set null,
  non_residential_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketplace_pickup_site_details_address_length
    check (char_length(btrim(address_line)) between 1 and 300),
  constraint marketplace_pickup_site_details_postal_length
    check (postal_code is null or char_length(postal_code) <= 24),
  constraint marketplace_pickup_site_details_review_reason_length
    check (review_reason is null or char_length(btrim(review_reason)) between 10 and 1000),
  constraint marketplace_pickup_site_details_confirmation_shape check (
    (
      not non_residential_confirmed
      and non_residential_confirmed_by is null
      and non_residential_confirmed_at is null
    )
    or (
      non_residential_confirmed
      and non_residential_confirmed_by is not null
      and non_residential_confirmed_at is not null
    )
  )
);

create table if not exists public.marketplace_pickup_requests (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null default gen_random_uuid() unique,
  conversation_id uuid not null references public.marketplace_conversations(id) on delete cascade,
  requested_by uuid references auth.users(id) on delete set null,
  pickup_starts_at timestamptz not null,
  pickup_ends_at timestamptz not null,
  note text,
  state text not null default 'pending'
    check (state in ('pending', 'authorized', 'declined', 'cancelled', 'expired')),
  version integer not null default 1 check (version > 0),
  responded_by uuid references auth.users(id) on delete set null,
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketplace_pickup_requests_window
    check (
      pickup_ends_at >= pickup_starts_at + interval '15 minutes'
      and pickup_ends_at <= pickup_starts_at + interval '4 hours'
    ),
  constraint marketplace_pickup_requests_note_length
    check (note is null or char_length(btrim(note)) between 1 and 240),
  constraint marketplace_pickup_requests_response_shape check (
    (state = 'pending' and responded_by is null and responded_at is null)
    or (state <> 'pending' and responded_at is not null)
  )
);

create unique index if not exists marketplace_pickup_one_pending_idx
  on public.marketplace_pickup_requests (conversation_id)
  where state = 'pending';
create index if not exists marketplace_pickup_requests_conversation_time_idx
  on public.marketplace_pickup_requests (conversation_id, created_at desc);

create table if not exists private.marketplace_pickup_disclosures (
  request_id uuid primary key references public.marketplace_pickup_requests(id) on delete cascade,
  site_id uuid not null references public.marketplace_pickup_sites(id) on delete restrict,
  address_line text not null,
  city text not null,
  region text not null,
  postal_code text,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  authorized_by uuid references auth.users(id) on delete set null,
  authorized_at timestamptz not null default now(),
  reveal_at timestamptz not null,
  expires_at timestamptz not null,
  customer_first_viewed_at timestamptz,
  constraint marketplace_pickup_disclosures_address_length
    check (char_length(btrim(address_line)) between 1 and 300),
  constraint marketplace_pickup_disclosures_city_length
    check (char_length(btrim(city)) between 1 and 120),
  constraint marketplace_pickup_disclosures_region_length
    check (char_length(btrim(region)) between 1 and 80),
  constraint marketplace_pickup_disclosures_postal_length
    check (postal_code is null or char_length(postal_code) <= 24),
  constraint marketplace_pickup_disclosures_window
    check (expires_at > reveal_at and expires_at <= reveal_at + interval '8 days'),
  constraint marketplace_pickup_disclosures_view_time
    check (customer_first_viewed_at is null or customer_first_viewed_at >= authorized_at)
);

create table if not exists private.marketplace_chat_idempotency (
  actor_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  key_hash text not null,
  request_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (actor_id, action, key_hash),
  constraint marketplace_chat_idempotency_action_length
    check (char_length(action) between 1 and 80),
  constraint marketplace_chat_idempotency_key_hash
    check (key_hash ~ '^[0-9a-f]{64}$'),
  constraint marketplace_chat_idempotency_request_hash
    check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint marketplace_chat_idempotency_response_size
    check (octet_length(response::text) <= 16384)
);

create index if not exists marketplace_chat_idempotency_created_idx
  on private.marketplace_chat_idempotency (created_at);

create or replace function private.marketplace_chat_available(target_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.businesses b
    left join public.business_marketplace_chat_settings settings
      on settings.business_id = b.id
    where b.id = target_business_id
      and private.is_business_publicly_eligible(b.id)
      and (
        b.kind = 'home_kitchen'
        or (b.kind = 'pop_up' and coalesce(settings.enabled, false))
      )
  );
$$;

create or replace function private.marketplace_conversation_access_allowed(
  target_conversation_id uuid,
  target_user_id uuid default auth.uid()
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
      from public.marketplace_conversations conversation
      where conversation.id = target_conversation_id
        and target_user_id in (conversation.customer_id, conversation.merchant_id)
    );
$$;

create or replace function private.marketplace_conversation_write_allowed(
  target_conversation_id uuid,
  target_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.marketplace_conversations conversation
    where conversation.id = target_conversation_id
      and conversation.state = 'open'
      and target_user_id in (conversation.customer_id, conversation.merchant_id)
      and private.is_active_user(target_user_id)
      and private.marketplace_chat_available(conversation.business_id)
      and private.is_business_member(
        conversation.business_id,
        conversation.merchant_id,
        array['owner', 'manager']::public.member_role[]
      )
      and not private.users_are_blocked(conversation.customer_id, conversation.merchant_id)
  );
$$;

create or replace function private.marketplace_chat_idempotent_response(
  target_actor_id uuid,
  target_action text,
  target_key_hash text,
  target_request_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  stored private.marketplace_chat_idempotency%rowtype;
begin
  perform private.lock_idempotency_request(target_actor_id, target_action, target_key_hash);

  select *
  into stored
  from private.marketplace_chat_idempotency receipt
  where receipt.actor_id = target_actor_id
    and receipt.action = target_action
    and receipt.key_hash = target_key_hash;

  if found then
    if stored.request_hash <> target_request_hash then
      raise exception using errcode = '23505', message = 'IDEMPOTENCY_CONFLICT';
    end if;
    return stored.response;
  end if;
  return null;
end;
$$;

create or replace function public.get_marketplace_chat_media_states(
  target_conversation_public_id uuid,
  target_asset_ids uuid[]
)
returns table (asset_id uuid, processing_state text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_conversation public.marketplace_conversations%rowtype;
  normalized_assets uuid[] := coalesce(target_asset_ids, '{}'::uuid[]);
begin
  if cardinality(normalized_assets) < 1
    or cardinality(normalized_assets) > 4
    or cardinality(normalized_assets) <> (
      select count(distinct supplied.asset_id)
      from unnest(normalized_assets) supplied(asset_id)
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_CHAT_MEDIA_SET';
  end if;

  select conversation.*
  into target_conversation
  from public.marketplace_conversations conversation
  where conversation.public_id = target_conversation_public_id;
  if not found
    or not private.marketplace_conversation_access_allowed(target_conversation.id, actor)
  then
    raise exception using errcode = '42501', message = 'CHAT_ACCESS_REQUIRED';
  end if;

  return query
  select
    asset.id,
    case
      when asset.quarantine_state = 'clean'
        and asset.moderation = 'approved'
        and asset.processed_storage_path is not null then 'approved'
      when asset.quarantine_state = 'rejected'
        or asset.moderation in ('rejected', 'removed') then 'rejected'
      else 'pending'
    end
  from public.media_assets asset
  where asset.id = any(normalized_assets)
    and asset.owner_id = actor
    and asset.business_id = target_conversation.business_id;
end;
$$;

revoke all on function public.get_marketplace_chat_media_states(uuid, uuid[]) from public;
grant execute on function public.get_marketplace_chat_media_states(uuid, uuid[]) to authenticated;

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

create or replace function private.store_marketplace_chat_idempotency(
  target_actor_id uuid,
  target_action text,
  target_key_hash text,
  target_request_hash text,
  target_response jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into private.marketplace_chat_idempotency (
    actor_id,
    action,
    key_hash,
    request_hash,
    response
  )
  values (
    target_actor_id,
    target_action,
    target_key_hash,
    target_request_hash,
    target_response
  );
end;
$$;

revoke all on function private.marketplace_chat_available(uuid) from public, anon, authenticated;
revoke all on function private.marketplace_conversation_access_allowed(uuid, uuid) from public, anon, authenticated;
revoke all on function private.marketplace_conversation_write_allowed(uuid, uuid) from public, anon, authenticated;
revoke all on function private.marketplace_chat_idempotent_response(uuid, text, text, text) from public, anon, authenticated;
revoke all on function private.store_marketplace_chat_idempotency(uuid, text, text, text, jsonb) from public, anon, authenticated;

alter table public.business_marketplace_chat_settings enable row level security;
alter table public.marketplace_conversations enable row level security;
alter table public.marketplace_messages enable row level security;
alter table public.marketplace_message_media enable row level security;
alter table public.marketplace_read_receipts enable row level security;
alter table public.marketplace_typing_presence enable row level security;
alter table public.marketplace_pickup_sites enable row level security;
alter table public.marketplace_pickup_requests enable row level security;

revoke all privileges on table
  public.business_marketplace_chat_settings,
  public.marketplace_conversations,
  public.marketplace_messages,
  public.marketplace_message_media,
  public.marketplace_read_receipts,
  public.marketplace_typing_presence,
  public.marketplace_pickup_sites,
  public.marketplace_pickup_requests
from public, anon, authenticated;

revoke all privileges on table
  private.marketplace_pickup_site_details,
  private.marketplace_pickup_disclosures,
  private.marketplace_chat_idempotency
from public, anon, authenticated;

grant select on table
  public.business_marketplace_chat_settings,
  public.marketplace_conversations,
  public.marketplace_messages,
  public.marketplace_message_media,
  public.marketplace_read_receipts,
  public.marketplace_typing_presence,
  public.marketplace_pickup_sites,
  public.marketplace_pickup_requests
to authenticated;

drop policy if exists "business members read marketplace chat settings"
  on public.business_marketplace_chat_settings;
create policy "business members read marketplace chat settings"
  on public.business_marketplace_chat_settings
  for select to authenticated
  using (private.is_business_member(business_id, auth.uid()));

drop policy if exists "participants read marketplace conversations"
  on public.marketplace_conversations;
create policy "participants read marketplace conversations"
  on public.marketplace_conversations
  for select to authenticated
  using (private.marketplace_conversation_access_allowed(id, auth.uid()));

drop policy if exists "participants read marketplace messages"
  on public.marketplace_messages;
create policy "participants read marketplace messages"
  on public.marketplace_messages
  for select to authenticated
  using (
    visibility = 'visible'
    and deleted_at is null
    and private.marketplace_conversation_access_allowed(conversation_id, auth.uid())
  );

drop policy if exists "participants read marketplace message media"
  on public.marketplace_message_media;
create policy "participants read marketplace message media"
  on public.marketplace_message_media
  for select to authenticated
  using (
    exists (
      select 1
      from public.marketplace_messages message
      where message.id = marketplace_message_media.message_id
        and message.visibility = 'visible'
        and message.deleted_at is null
        and private.marketplace_conversation_access_allowed(message.conversation_id, auth.uid())
    )
  );

drop policy if exists "participants read marketplace receipts"
  on public.marketplace_read_receipts;
create policy "participants read marketplace receipts"
  on public.marketplace_read_receipts
  for select to authenticated
  using (private.marketplace_conversation_access_allowed(conversation_id, auth.uid()));

drop policy if exists "participants read live marketplace typing"
  on public.marketplace_typing_presence;
create policy "participants read live marketplace typing"
  on public.marketplace_typing_presence
  for select to authenticated
  using (
    expires_at > now()
    and private.marketplace_conversation_access_allowed(conversation_id, auth.uid())
  );

drop policy if exists "business members read pickup site metadata"
  on public.marketplace_pickup_sites;
create policy "business members read pickup site metadata"
  on public.marketplace_pickup_sites
  for select to authenticated
  using (private.is_business_member(business_id, auth.uid()));

drop policy if exists "participants read pickup request state"
  on public.marketplace_pickup_requests;
create policy "participants read pickup request state"
  on public.marketplace_pickup_requests
  for select to authenticated
  using (private.marketplace_conversation_access_allowed(conversation_id, auth.uid()));

create or replace function public.is_marketplace_chat_available(target_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.marketplace_chat_available(target_business_id);
$$;

revoke all on function public.is_marketplace_chat_available(uuid) from public;
grant execute on function public.is_marketplace_chat_available(uuid) to anon, authenticated;

create or replace function public.set_business_marketplace_chat_enabled(
  target_business_id uuid,
  should_enable boolean,
  idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_kind public.business_kind;
  key_hash text;
  request_hash text;
  prior_response jsonb;
  response jsonb;
  effective_enabled boolean;
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  perform private.require_aal2();
  if not private.is_business_member(
    target_business_id,
    actor,
    array['owner', 'manager']::public.member_role[]
  ) then
    raise exception using errcode = '42501', message = 'BUSINESS_MANAGER_REQUIRED';
  end if;

  select b.kind into target_kind
  from public.businesses b
  where b.id = target_business_id;

  if target_kind is null or target_kind not in ('home_kitchen', 'pop_up') then
    raise exception using errcode = '22023', message = 'CHAT_CATEGORY_NOT_ELIGIBLE';
  end if;
  if target_kind = 'home_kitchen' and not should_enable then
    raise exception using errcode = '22023', message = 'HOME_KITCHEN_CHAT_REQUIRED';
  end if;
  effective_enabled := case when target_kind = 'home_kitchen' then true else should_enable end;

  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'business_id', target_business_id,
    'enabled', effective_enabled
  ));
  prior_response := private.marketplace_chat_idempotent_response(
    actor,
    'set_marketplace_chat_enabled',
    key_hash,
    request_hash
  );
  if prior_response is not null then
    return prior_response;
  end if;

  perform private.consume_rate_limit(actor, 'marketplace_chat_settings_hour', 30, 3600);

  insert into public.business_marketplace_chat_settings (
    business_id,
    enabled,
    updated_by,
    updated_at
  )
  values (target_business_id, effective_enabled, actor, now())
  on conflict (business_id)
  do update set
    enabled = excluded.enabled,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  response := jsonb_build_object(
    'business_id', target_business_id,
    'enabled', effective_enabled,
    'required', target_kind = 'home_kitchen'
  );
  perform private.store_marketplace_chat_idempotency(
    actor,
    'set_marketplace_chat_enabled',
    key_hash,
    request_hash,
    response
  );
  perform private.write_audit_event(
    actor,
    target_business_id,
    'marketplace_chat.setting_changed',
    'business',
    target_business_id::text,
    jsonb_build_object('enabled', effective_enabled, 'required', target_kind = 'home_kitchen')
  );
  return response;
end;
$$;

revoke all on function public.set_business_marketplace_chat_enabled(uuid, boolean, text) from public;
grant execute on function public.set_business_marketplace_chat_enabled(uuid, boolean, text) to authenticated;

create or replace function public.start_marketplace_conversation(
  target_business_id uuid,
  idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_conversation public.marketplace_conversations%rowtype;
  selected_merchant_id uuid;
  key_hash text;
  request_hash text;
  prior_response jsonb;
  response jsonb;
  was_created boolean := false;
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  if not private.marketplace_chat_available(target_business_id) then
    raise exception using errcode = '55000', message = 'MARKETPLACE_CHAT_NOT_AVAILABLE';
  end if;
  if private.is_business_member(target_business_id, actor) then
    raise exception using errcode = '22023', message = 'BUSINESS_MEMBERS_CANNOT_START_CUSTOMER_CHAT';
  end if;

  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object('business_id', target_business_id));
  prior_response := private.marketplace_chat_idempotent_response(
    actor,
    'start_marketplace_conversation',
    key_hash,
    request_hash
  );
  if prior_response is not null then
    return prior_response;
  end if;

  perform private.consume_rate_limit(actor, 'marketplace_conversation_start_day', 20, 86400);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      target_business_id::text || ':marketplace_customer:' || actor::text,
      0
    )
  );

  select conversation.*
  into target_conversation
  from public.marketplace_conversations conversation
  where conversation.business_id = target_business_id
    and conversation.customer_id = actor
  for update;

  if found then
    if target_conversation.state = 'restricted' then
      raise exception using errcode = '42501', message = 'CONVERSATION_RESTRICTED';
    end if;
    if target_conversation.state = 'closed_by_merchant' then
      raise exception using errcode = '42501', message = 'CONVERSATION_CLOSED_BY_MERCHANT';
    end if;

    if not private.is_business_member(
      target_business_id,
      target_conversation.merchant_id,
      array['owner', 'manager']::public.member_role[]
    ) then
      select member.user_id
      into selected_merchant_id
      from public.business_members member
      where member.business_id = target_business_id
        and member.status = 'active'
        and member.role in ('owner', 'manager')
        and member.user_id <> actor
        and private.is_active_user(member.user_id)
      order by
        case member.role when 'owner' then 0 else 1 end,
        member.accepted_at nulls last,
        member.created_at,
        member.user_id
      limit 1;

      if selected_merchant_id is null then
        raise exception using errcode = '55000', message = 'CHAT_MERCHANT_UNAVAILABLE';
      end if;
      target_conversation.merchant_id := selected_merchant_id;
    end if;

    if private.users_are_blocked(actor, target_conversation.merchant_id) then
      raise exception using errcode = '42501', message = 'CHAT_BLOCKED';
    end if;

    update public.marketplace_conversations
    set merchant_id = target_conversation.merchant_id,
        state = 'open',
        updated_at = now()
    where id = target_conversation.id
    returning * into target_conversation;
  else
    select member.user_id
    into selected_merchant_id
    from public.business_members member
    where member.business_id = target_business_id
      and member.status = 'active'
      and member.role in ('owner', 'manager')
      and member.user_id <> actor
      and private.is_active_user(member.user_id)
      and not private.users_are_blocked(actor, member.user_id)
    order by
      case member.role when 'owner' then 0 else 1 end,
      member.accepted_at nulls last,
      member.created_at,
      member.user_id
    limit 1;

    if selected_merchant_id is null then
      raise exception using errcode = '55000', message = 'CHAT_MERCHANT_UNAVAILABLE';
    end if;

    insert into public.marketplace_conversations (
      business_id,
      customer_id,
      merchant_id
    )
    values (target_business_id, actor, selected_merchant_id)
    returning * into target_conversation;
    was_created := true;

    insert into public.marketplace_read_receipts (conversation_id, user_id, last_read_sequence)
    values
      (target_conversation.id, actor, 0),
      (target_conversation.id, selected_merchant_id, 0)
    on conflict do nothing;
  end if;

  response := jsonb_build_object(
    'conversation_public_id', target_conversation.public_id,
    'business_id', target_conversation.business_id,
    'state', target_conversation.state,
    'created', was_created
  );
  perform private.store_marketplace_chat_idempotency(
    actor,
    'start_marketplace_conversation',
    key_hash,
    request_hash,
    response
  );
  perform private.write_audit_event(
    actor,
    target_business_id,
    case when was_created
      then 'marketplace_chat.conversation_started'
      else 'marketplace_chat.conversation_reopened'
    end,
    'marketplace_conversation',
    target_conversation.public_id::text,
    '{}'::jsonb
  );
  return response;
end;
$$;

revoke all on function public.start_marketplace_conversation(uuid, text) from public;
grant execute on function public.start_marketplace_conversation(uuid, text) to authenticated;

create or replace function public.list_my_marketplace_conversations(
  cursor_time timestamptz default null,
  cursor_public_id uuid default null,
  result_limit integer default 30
)
returns table (
  conversation_public_id uuid,
  business_id uuid,
  business_name text,
  business_kind public.business_kind,
  conversation_state text,
  counterpart_public_profile_id uuid,
  counterpart_name text,
  counterpart_username text,
  counterpart_avatar_path text,
  last_message_preview text,
  last_message_at timestamptz,
  unread_count bigint,
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
  bounded_limit integer := least(greatest(coalesce(result_limit, 30), 1), 50);
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  if (cursor_time is null) <> (cursor_public_id is null) then
    raise exception using errcode = '22023', message = 'INVALID_CONVERSATION_CURSOR';
  end if;

  return query
  with page as (
    select conversation.*,
      coalesce(conversation.last_message_at, conversation.created_at) as sort_time,
      case
        when actor = conversation.customer_id then conversation.merchant_id
        else conversation.customer_id
      end as counterpart_id
    from public.marketplace_conversations conversation
    where actor in (conversation.customer_id, conversation.merchant_id)
      and (
        cursor_time is null
        or (coalesce(conversation.last_message_at, conversation.created_at), conversation.public_id)
          < (cursor_time, cursor_public_id)
      )
    order by sort_time desc, conversation.public_id desc
    limit bounded_limit + 1
  ), selected as (
    select * from page
    order by sort_time desc, public_id desc
    limit bounded_limit
  )
  select
    selected.public_id,
    selected.business_id,
    business.name,
    business.kind,
    selected.state,
    counterpart.public_id,
    counterpart.display_name,
    counterpart.username::text,
    counterpart.avatar_path,
    (
      select case
        when message.visibility <> 'visible' or message.deleted_at is not null
          then null
        else left(message.body, 140)
      end
      from public.marketplace_messages message
      where message.conversation_id = selected.id
      order by message.sequence desc
      limit 1
    ),
    selected.last_message_at,
    (
      select count(*)
      from public.marketplace_messages message
      left join public.marketplace_read_receipts receipt
        on receipt.conversation_id = selected.id
       and receipt.user_id = actor
      where message.conversation_id = selected.id
        and message.sender_id is distinct from actor
        and message.visibility = 'visible'
        and message.deleted_at is null
        and message.sequence > coalesce(receipt.last_read_sequence, 0)
    ),
    selected.created_at,
    (select count(*) > bounded_limit from page)
  from selected
  join public.businesses business on business.id = selected.business_id
  left join public.profiles counterpart on counterpart.user_id = selected.counterpart_id
  order by selected.sort_time desc, selected.public_id desc;
end;
$$;

revoke all on function public.list_my_marketplace_conversations(timestamptz, uuid, integer) from public;
grant execute on function public.list_my_marketplace_conversations(timestamptz, uuid, integer) to authenticated;

create or replace function public.send_marketplace_message(
  target_conversation_public_id uuid,
  message_body text,
  media_asset_ids uuid[] default '{}'::uuid[],
  idempotency_key text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_conversation public.marketplace_conversations%rowtype;
  normalized_body text := nullif(
    btrim(regexp_replace(coalesce(message_body, ''), '[[:space:]]+', ' ', 'g')),
    ''
  );
  normalized_assets uuid[] := coalesce(media_asset_ids, '{}'::uuid[]);
  target_message_id uuid := gen_random_uuid();
  target_message_public_id uuid := gen_random_uuid();
  next_sequence bigint;
  key_hash text;
  request_hash text;
  prior_response jsonb;
  response jsonb;
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  if normalized_body is null and cardinality(normalized_assets) = 0 then
    raise exception using errcode = '22023', message = 'EMPTY_CHAT_MESSAGE';
  end if;
  if normalized_body is not null and (
    char_length(normalized_body) > 1000
    or not private.content_is_professional(normalized_body)
  ) then
    raise exception using errcode = '23514', message = 'CONTENT_POLICY_VIOLATION';
  end if;
  if cardinality(normalized_assets) > 4
    or cardinality(normalized_assets) <> (
      select count(distinct supplied.asset_id)
      from unnest(normalized_assets) supplied(asset_id)
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_CHAT_MEDIA_SET';
  end if;

  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'conversation_public_id', target_conversation_public_id,
    'body', normalized_body,
    'media_asset_ids', to_jsonb(normalized_assets)
  ));
  prior_response := private.marketplace_chat_idempotent_response(
    actor,
    'send_marketplace_message',
    key_hash,
    request_hash
  );
  if prior_response is not null then
    return prior_response;
  end if;

  perform private.consume_rate_limit(actor, 'marketplace_message_minute', 30, 60);
  perform private.consume_rate_limit(actor, 'marketplace_message_day', 500, 86400);

  select conversation.*
  into target_conversation
  from public.marketplace_conversations conversation
  where conversation.public_id = target_conversation_public_id
  for update;

  if not found or not private.marketplace_conversation_write_allowed(target_conversation.id, actor) then
    raise exception using errcode = '42501', message = 'CHAT_WRITE_NOT_ALLOWED';
  end if;

  if cardinality(normalized_assets) > 0 and (
    select count(*)
    from public.media_assets asset
    where asset.id = any(normalized_assets)
      and asset.owner_id = actor
      and asset.business_id = target_conversation.business_id
      and asset.source = 'chat_upload'
      and asset.quarantine_state = 'clean'
      and asset.moderation = 'approved'
      and asset.processed_storage_path is not null
  ) <> cardinality(normalized_assets) then
    raise exception using errcode = '55000', message = 'CHAT_MEDIA_NOT_CLEAN_OR_OWNED';
  end if;

  next_sequence := target_conversation.last_sequence + 1;
  insert into public.marketplace_messages (
    id,
    public_id,
    conversation_id,
    sender_id,
    sequence,
    body
  )
  values (
    target_message_id,
    target_message_public_id,
    target_conversation.id,
    actor,
    next_sequence,
    normalized_body
  );

  insert into public.marketplace_message_media (message_id, asset_id, sort_order)
  select target_message_id, supplied.asset_id, (supplied.ordinality - 1)::smallint
  from unnest(normalized_assets) with ordinality supplied(asset_id, ordinality);

  update public.marketplace_conversations
  set last_sequence = next_sequence,
      last_message_at = now(),
      updated_at = now()
  where id = target_conversation.id;

  insert into public.marketplace_read_receipts (
    conversation_id,
    user_id,
    last_read_sequence,
    read_at
  )
  values (target_conversation.id, actor, next_sequence, now())
  on conflict (conversation_id, user_id)
  do update set
    last_read_sequence = greatest(
      public.marketplace_read_receipts.last_read_sequence,
      excluded.last_read_sequence
    ),
    read_at = case
      when excluded.last_read_sequence > public.marketplace_read_receipts.last_read_sequence
        then excluded.read_at
      else public.marketplace_read_receipts.read_at
    end;

  delete from public.marketplace_typing_presence presence
  where presence.conversation_id = target_conversation.id
    and presence.user_id = actor;

  response := jsonb_build_object(
    'message_public_id', target_message_public_id,
    'conversation_public_id', target_conversation.public_id,
    'sequence', next_sequence,
    'sent_at', now(),
    'visibility', 'visible'
  );
  perform private.store_marketplace_chat_idempotency(
    actor,
    'send_marketplace_message',
    key_hash,
    request_hash,
    response
  );
  perform private.write_audit_event(
    actor,
    target_conversation.business_id,
    'marketplace_chat.message_sent',
    'marketplace_message',
    target_message_public_id::text,
    jsonb_build_object(
      'conversation_public_id', target_conversation.public_id,
      'sequence', next_sequence,
      'body_length', coalesce(char_length(normalized_body), 0),
      'media_count', cardinality(normalized_assets)
    )
  );
  return response;
end;
$$;

revoke all on function public.send_marketplace_message(uuid, text, uuid[], text) from public;
grant execute on function public.send_marketplace_message(uuid, text, uuid[], text) to authenticated;

create or replace function public.get_marketplace_messages(
  target_conversation_public_id uuid,
  before_sequence bigint default null,
  result_limit integer default 50
)
returns table (
  message_public_id uuid,
  sequence bigint,
  sender_public_profile_id uuid,
  sender_name text,
  sender_username text,
  sender_avatar_path text,
  body text,
  attachments jsonb,
  visibility text,
  sent_at timestamptz,
  edited_at timestamptz,
  deleted_at timestamptz,
  read_by_counterpart_at timestamptz,
  has_more boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_conversation public.marketplace_conversations%rowtype;
  bounded_limit integer := least(greatest(coalesce(result_limit, 50), 1), 100);
begin
  select conversation.*
  into target_conversation
  from public.marketplace_conversations conversation
  where conversation.public_id = target_conversation_public_id;

  if not found or not private.marketplace_conversation_access_allowed(target_conversation.id, actor) then
    raise exception using errcode = '42501', message = 'CHAT_ACCESS_REQUIRED';
  end if;
  if before_sequence is not null and before_sequence < 1 then
    raise exception using errcode = '22023', message = 'INVALID_MESSAGE_CURSOR';
  end if;

  return query
  with page as (
    select message.*
    from public.marketplace_messages message
    where message.conversation_id = target_conversation.id
      and (before_sequence is null or message.sequence < before_sequence)
    order by message.sequence desc
    limit bounded_limit + 1
  ), selected as (
    select * from page order by sequence desc limit bounded_limit
  )
  select
    selected.public_id,
    selected.sequence,
    sender.public_id,
    coalesce(sender.display_name, 'Deleted account'),
    sender.username::text,
    sender.avatar_path,
    case
      when selected.visibility = 'visible' and selected.deleted_at is null then selected.body
      else null
    end,
    case
      when selected.visibility = 'visible' and selected.deleted_at is null then coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'asset_id', asset.id,
            'storage_path', asset.processed_storage_path,
            'mime_type', asset.mime_type,
            'width', asset.width,
            'height', asset.height
          )
          order by link.sort_order
        )
        from public.marketplace_message_media link
        join public.media_assets asset on asset.id = link.asset_id
        where link.message_id = selected.id
          and asset.quarantine_state = 'clean'
          and asset.moderation = 'approved'
          and asset.processed_storage_path is not null
      ), '[]'::jsonb)
      else '[]'::jsonb
    end,
    selected.visibility,
    selected.sent_at,
    selected.edited_at,
    selected.deleted_at,
    (
      select receipt.read_at
      from public.marketplace_read_receipts receipt
      where receipt.conversation_id = target_conversation.id
        and receipt.user_id <> selected.sender_id
        and receipt.last_read_sequence >= selected.sequence
      order by receipt.read_at desc
      limit 1
    ),
    (select count(*) > bounded_limit from page)
  from selected
  left join public.profiles sender on sender.user_id = selected.sender_id
  order by selected.sequence desc;
end;
$$;

revoke all on function public.get_marketplace_messages(uuid, bigint, integer) from public;
grant execute on function public.get_marketplace_messages(uuid, bigint, integer) to authenticated;

create or replace function public.can_stage_marketplace_chat_media(
  target_conversation_public_id uuid,
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
    from public.marketplace_conversations conversation
    where conversation.public_id = target_conversation_public_id
      and conversation.business_id = target_business_id
      and private.marketplace_conversation_write_allowed(conversation.id, auth.uid())
  );
$$;

revoke all on function public.can_stage_marketplace_chat_media(uuid, uuid) from public;
grant execute on function public.can_stage_marketplace_chat_media(uuid, uuid) to authenticated;

create or replace function public.set_marketplace_typing(
  target_conversation_public_id uuid,
  is_typing boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_conversation_id uuid;
begin
  select conversation.id
  into target_conversation_id
  from public.marketplace_conversations conversation
  where conversation.public_id = target_conversation_public_id;

  if target_conversation_id is null
    or not private.marketplace_conversation_write_allowed(target_conversation_id, actor)
  then
    raise exception using errcode = '42501', message = 'CHAT_WRITE_NOT_ALLOWED';
  end if;

  perform private.consume_rate_limit(actor, 'marketplace_typing_minute', 120, 60);
  delete from public.marketplace_typing_presence presence
  where presence.expires_at <= now();

  if is_typing then
    insert into public.marketplace_typing_presence (
      conversation_id,
      user_id,
      updated_at,
      expires_at
    )
    values (target_conversation_id, actor, now(), now() + interval '10 seconds')
    on conflict (conversation_id, user_id)
    do update set
      updated_at = excluded.updated_at,
      expires_at = excluded.expires_at;
  else
    delete from public.marketplace_typing_presence presence
    where presence.conversation_id = target_conversation_id
      and presence.user_id = actor;
  end if;
end;
$$;

revoke all on function public.set_marketplace_typing(uuid, boolean) from public;
grant execute on function public.set_marketplace_typing(uuid, boolean) to authenticated;

create or replace function public.get_marketplace_typing(
  target_conversation_public_id uuid
)
returns table (
  public_profile_id uuid,
  name text,
  username text,
  avatar_path text,
  expires_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_conversation_id uuid;
begin
  select conversation.id
  into target_conversation_id
  from public.marketplace_conversations conversation
  where conversation.public_id = target_conversation_public_id;

  if target_conversation_id is null
    or not private.marketplace_conversation_access_allowed(target_conversation_id, actor)
  then
    raise exception using errcode = '42501', message = 'CHAT_ACCESS_REQUIRED';
  end if;

  return query
  select
    profile.public_id,
    profile.display_name,
    profile.username::text,
    profile.avatar_path,
    presence.expires_at
  from public.marketplace_typing_presence presence
  join public.profiles profile on profile.user_id = presence.user_id
  where presence.conversation_id = target_conversation_id
    and presence.user_id <> actor
    and presence.expires_at > now()
  order by presence.expires_at desc;
end;
$$;

revoke all on function public.get_marketplace_typing(uuid) from public;
grant execute on function public.get_marketplace_typing(uuid) to authenticated;

create or replace function public.mark_marketplace_conversation_read(
  target_conversation_public_id uuid,
  through_sequence bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_conversation public.marketplace_conversations%rowtype;
  resulting_sequence bigint;
  resulting_read_at timestamptz;
begin
  select conversation.*
  into target_conversation
  from public.marketplace_conversations conversation
  where conversation.public_id = target_conversation_public_id;

  if not found or not private.marketplace_conversation_access_allowed(target_conversation.id, actor) then
    raise exception using errcode = '42501', message = 'CHAT_ACCESS_REQUIRED';
  end if;
  if through_sequence < 0 or through_sequence > target_conversation.last_sequence then
    raise exception using errcode = '22023', message = 'INVALID_READ_SEQUENCE';
  end if;

  perform private.consume_rate_limit(actor, 'marketplace_read_receipt_minute', 120, 60);
  insert into public.marketplace_read_receipts (
    conversation_id,
    user_id,
    last_read_sequence,
    read_at
  )
  values (target_conversation.id, actor, through_sequence, now())
  on conflict (conversation_id, user_id)
  do update set
    last_read_sequence = greatest(
      public.marketplace_read_receipts.last_read_sequence,
      excluded.last_read_sequence
    ),
    read_at = case
      when excluded.last_read_sequence > public.marketplace_read_receipts.last_read_sequence
        then excluded.read_at
      else public.marketplace_read_receipts.read_at
    end
  returning last_read_sequence, read_at into resulting_sequence, resulting_read_at;

  return jsonb_build_object(
    'conversation_public_id', target_conversation.public_id,
    'last_read_sequence', resulting_sequence,
    'read_at', resulting_read_at
  );
end;
$$;

revoke all on function public.mark_marketplace_conversation_read(uuid, bigint) from public;
grant execute on function public.mark_marketplace_conversation_read(uuid, bigint) to authenticated;

create or replace function public.close_marketplace_conversation(
  target_conversation_public_id uuid,
  idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_conversation public.marketplace_conversations%rowtype;
  next_state text;
  key_hash text;
  request_hash text;
  prior_response jsonb;
  response jsonb;
begin
  select conversation.*
  into target_conversation
  from public.marketplace_conversations conversation
  where conversation.public_id = target_conversation_public_id
  for update;

  if not found or not private.marketplace_conversation_access_allowed(target_conversation.id, actor) then
    raise exception using errcode = '42501', message = 'CHAT_ACCESS_REQUIRED';
  end if;
  if target_conversation.state = 'restricted' then
    raise exception using errcode = '42501', message = 'CONVERSATION_RESTRICTED';
  end if;
  next_state := case
    when actor = target_conversation.customer_id then 'closed_by_customer'
    else 'closed_by_merchant'
  end;

  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'conversation_public_id', target_conversation_public_id,
    'state', next_state
  ));
  prior_response := private.marketplace_chat_idempotent_response(
    actor,
    'close_marketplace_conversation',
    key_hash,
    request_hash
  );
  if prior_response is not null then
    return prior_response;
  end if;

  perform private.consume_rate_limit(actor, 'marketplace_conversation_close_hour', 20, 3600);
  update public.marketplace_conversations
  set state = next_state,
      updated_at = now()
  where id = target_conversation.id
    and state <> 'restricted';

  delete from public.marketplace_typing_presence presence
  where presence.conversation_id = target_conversation.id;

  response := jsonb_build_object(
    'conversation_public_id', target_conversation.public_id,
    'state', next_state
  );
  perform private.store_marketplace_chat_idempotency(
    actor,
    'close_marketplace_conversation',
    key_hash,
    request_hash,
    response
  );
  perform private.write_audit_event(
    actor,
    target_conversation.business_id,
    'marketplace_chat.conversation_closed',
    'marketplace_conversation',
    target_conversation.public_id::text,
    jsonb_build_object('state', next_state)
  );
  return response;
end;
$$;

revoke all on function public.close_marketplace_conversation(uuid, text) from public;
grant execute on function public.close_marketplace_conversation(uuid, text) to authenticated;

alter table public.content_reports
  drop constraint if exists content_reports_target_type_check;
alter table public.content_reports
  add constraint content_reports_target_type_check
  check (target_type in (
    'business',
    'review',
    'response',
    'update',
    'media',
    'user',
    'chat_message'
  ));

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
        from public.reviews review
        where review.id = new.target_id
          and review.moderation = 'approved'
          and review.deleted_at is null
          and review.author_id <> new.reporter_id
          and private.is_business_publicly_eligible(review.business_id)
      ) into target_exists;
    when 'response' then
      select exists (
        select 1
        from public.business_responses response
        join public.reviews review
          on review.id = response.review_id
         and review.business_id = response.business_id
        where response.review_id = new.target_id
          and response.moderation = 'approved'
          and (response.author_id is null or response.author_id <> new.reporter_id)
          and review.moderation = 'approved'
          and review.deleted_at is null
          and private.is_business_publicly_eligible(response.business_id)
      ) into target_exists;
    when 'update' then
      select exists (
        select 1
        from public.business_updates update_row
        where update_row.id = new.target_id
          and update_row.moderation = 'approved'
          and update_row.starts_at <= now()
          and update_row.expires_at > now()
          and (update_row.author_id is null or update_row.author_id <> new.reporter_id)
          and private.is_business_publicly_eligible(update_row.business_id)
      ) into target_exists;
    when 'media' then
      select exists (
        select 1
        from public.media_assets asset
        where asset.id = new.target_id
          and asset.owner_id <> new.reporter_id
          and private.is_media_publicly_eligible(asset.id)
      ) into target_exists;
    when 'user' then
      select exists (
        select 1
        from public.profiles profile
        where profile.user_id = new.target_id
          and profile.user_id <> new.reporter_id
          and profile.status = 'active'
      ) into target_exists;
    when 'chat_message' then
      select exists (
        select 1
        from public.marketplace_messages message
        where message.id = new.target_id
          and message.sender_id is distinct from new.reporter_id
          and message.deleted_at is null
          and private.marketplace_conversation_access_allowed(
            message.conversation_id,
            new.reporter_id
          )
      ) into target_exists;
  end case;

  if not target_exists then
    raise exception using errcode = '22023', message = 'INVALID_REPORT_TARGET';
  end if;
  return new;
end;
$$;

revoke all on function private.validate_report_target() from public, anon, authenticated;

create or replace function public.report_marketplace_message(
  target_message_public_id uuid,
  report_reason text,
  report_detail text,
  idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_message public.marketplace_messages%rowtype;
  target_conversation public.marketplace_conversations%rowtype;
  normalized_detail text := nullif(btrim(report_detail), '');
  target_report_id uuid;
  key_hash text;
  request_hash text;
  prior_response jsonb;
  response jsonb;
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  if report_reason not in (
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
  ) or (normalized_detail is not null and (
    char_length(normalized_detail) > 2000
    or not private.content_is_professional(normalized_detail)
  )) then
    raise exception using errcode = '22023', message = 'INVALID_CHAT_REPORT';
  end if;

  select message.*
  into target_message
  from public.marketplace_messages message
  where message.public_id = target_message_public_id;

  if not found then
    raise exception using errcode = '22023', message = 'INVALID_REPORT_TARGET';
  end if;
  select conversation.*
  into target_conversation
  from public.marketplace_conversations conversation
  where conversation.id = target_message.conversation_id;

  if not private.marketplace_conversation_access_allowed(target_message.conversation_id, actor)
    or target_message.sender_id is not distinct from actor
    or target_message.deleted_at is not null
  then
    raise exception using errcode = '22023', message = 'INVALID_REPORT_TARGET';
  end if;

  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'message_public_id', target_message_public_id,
    'reason', report_reason,
    'detail', normalized_detail
  ));
  prior_response := private.marketplace_chat_idempotent_response(
    actor,
    'report_marketplace_message',
    key_hash,
    request_hash
  );
  if prior_response is not null then
    return prior_response;
  end if;

  perform private.consume_rate_limit(actor, 'marketplace_message_report_day', 20, 86400);
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
    'chat_message',
    target_message.id,
    report_reason,
    normalized_detail,
    'open'
  )
  on conflict (reporter_id, target_type, target_id)
  do update set
    reason = excluded.reason,
    detail = excluded.detail,
    state = 'open'
  returning id into target_report_id;

  response := jsonb_build_object(
    'report_id', target_report_id,
    'message_public_id', target_message_public_id,
    'state', 'open'
  );
  perform private.store_marketplace_chat_idempotency(
    actor,
    'report_marketplace_message',
    key_hash,
    request_hash,
    response
  );
  perform private.write_audit_event(
    actor,
    target_conversation.business_id,
    'marketplace_chat.message_reported',
    'marketplace_message',
    target_message_public_id::text,
    jsonb_build_object('report_id', target_report_id, 'reason', report_reason)
  );
  return response;
end;
$$;

revoke all on function public.report_marketplace_message(uuid, text, text, text) from public;
grant execute on function public.report_marketplace_message(uuid, text, text, text) to authenticated;

create or replace function public.list_reported_marketplace_messages(
  result_limit integer default 50,
  result_offset integer default 0
)
returns table (
  report_id uuid,
  report_state text,
  report_reason text,
  report_detail text,
  reported_at timestamptz,
  message_public_id uuid,
  message_body text,
  message_visibility text,
  message_sent_at timestamptz,
  sender_public_profile_id uuid,
  sender_name text,
  sender_username text,
  conversation_public_id uuid,
  business_id uuid,
  attachments jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  bounded_limit integer := least(greatest(coalesce(result_limit, 50), 1), 100);
  bounded_offset integer := least(greatest(coalesce(result_offset, 0), 0), 10000);
begin
  perform private.require_aal2();
  if not private.is_platform_staff(actor) then
    raise exception using errcode = '42501', message = 'STAFF_REQUIRED';
  end if;

  return query
  select
    report.id,
    report.state,
    report.reason,
    report.detail,
    report.created_at,
    message.public_id,
    message.body,
    message.visibility,
    message.sent_at,
    sender.public_id,
    coalesce(sender.display_name, 'Deleted account'),
    sender.username::text,
    conversation.public_id,
    conversation.business_id,
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'asset_id', asset.id,
          'storage_path', asset.processed_storage_path,
          'mime_type', asset.mime_type,
          'width', asset.width,
          'height', asset.height
        )
        order by link.sort_order
      )
      from public.marketplace_message_media link
      join public.media_assets asset on asset.id = link.asset_id
      where link.message_id = message.id
        and asset.quarantine_state = 'clean'
        and asset.moderation = 'approved'
        and asset.processed_storage_path is not null
    ), '[]'::jsonb)
  from public.content_reports report
  join public.marketplace_messages message on message.id = report.target_id
  join public.marketplace_conversations conversation on conversation.id = message.conversation_id
  left join public.profiles sender on sender.user_id = message.sender_id
  where report.target_type = 'chat_message'
    and report.state in ('open', 'reviewing')
  order by report.created_at, report.id
  limit bounded_limit
  offset bounded_offset;
end;
$$;

revoke all on function public.list_reported_marketplace_messages(integer, integer) from public;
grant execute on function public.list_reported_marketplace_messages(integer, integer) to authenticated;

create or replace function public.moderate_marketplace_message(
  target_message_public_id uuid,
  next_visibility text,
  moderation_reason text,
  idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_message public.marketplace_messages%rowtype;
  target_conversation public.marketplace_conversations%rowtype;
  normalized_reason text := btrim(coalesce(moderation_reason, ''));
  key_hash text;
  request_hash text;
  prior_response jsonb;
  response jsonb;
begin
  perform private.require_aal2();
  if not private.is_platform_staff(actor) then
    raise exception using errcode = '42501', message = 'STAFF_REQUIRED';
  end if;
  if next_visibility not in ('visible', 'held', 'removed')
    or normalized_reason !~ '^[A-Z0-9_:-]{3,80}$'
  then
    raise exception using errcode = '22023', message = 'INVALID_CHAT_MODERATION';
  end if;

  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'message_public_id', target_message_public_id,
    'visibility', next_visibility,
    'reason', normalized_reason
  ));
  prior_response := private.marketplace_chat_idempotent_response(
    actor,
    'moderate_marketplace_message',
    key_hash,
    request_hash
  );
  if prior_response is not null then
    return prior_response;
  end if;

  perform private.consume_rate_limit(actor, 'marketplace_message_moderation_hour', 240, 3600);
  select message.*
  into target_message
  from public.marketplace_messages message
  where message.public_id = target_message_public_id
  for update;

  if not found or not exists (
    select 1
    from public.content_reports report
    where report.target_type = 'chat_message'
      and report.target_id = target_message.id
  ) then
    raise exception using errcode = '22023', message = 'REPORTED_CHAT_MESSAGE_REQUIRED';
  end if;
  if target_message.visibility = 'removed' and next_visibility <> 'removed' then
    raise exception using errcode = '55000', message = 'REMOVED_CHAT_MESSAGE_IMMUTABLE';
  end if;

  select conversation.*
  into target_conversation
  from public.marketplace_conversations conversation
  where conversation.id = target_message.conversation_id;

  update public.marketplace_messages
  set visibility = next_visibility,
      moderation_reason = normalized_reason,
      deleted_at = case when next_visibility = 'removed' then now() else null end
  where id = target_message.id;

  update public.content_reports
  set state = case
    when next_visibility = 'held' then 'reviewing'
    when next_visibility = 'visible' then 'dismissed'
    else 'resolved'
  end
  where target_type = 'chat_message'
    and target_id = target_message.id
    and state in ('open', 'reviewing');

  response := jsonb_build_object(
    'message_public_id', target_message.public_id,
    'visibility', next_visibility
  );
  perform private.store_marketplace_chat_idempotency(
    actor,
    'moderate_marketplace_message',
    key_hash,
    request_hash,
    response
  );
  perform private.write_audit_event(
    actor,
    target_conversation.business_id,
    'marketplace_chat.message_moderated',
    'marketplace_message',
    target_message.public_id::text,
    jsonb_build_object('visibility', next_visibility, 'reason', normalized_reason)
  );
  return response;
end;
$$;

revoke all on function public.moderate_marketplace_message(uuid, text, text, text) from public;
grant execute on function public.moderate_marketplace_message(uuid, text, text, text) to authenticated;

create or replace function public.submit_marketplace_pickup_site(
  target_business_id uuid,
  site_label text,
  site_kind text,
  address_line text,
  city text,
  region text,
  postal_code text,
  latitude double precision,
  longitude double precision,
  idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_kind public.business_kind;
  normalized_label text := btrim(coalesce(site_label, ''));
  normalized_address text := btrim(coalesce(address_line, ''));
  normalized_city text := btrim(coalesce(city, ''));
  normalized_region text := btrim(coalesce(region, ''));
  normalized_postal text := nullif(btrim(postal_code), '');
  target_site_id uuid := gen_random_uuid();
  target_site_public_id uuid := gen_random_uuid();
  key_hash text;
  request_hash text;
  prior_response jsonb;
  response jsonb;
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  perform private.require_aal2();
  if not private.is_business_member(
    target_business_id,
    actor,
    array['owner', 'manager']::public.member_role[]
  ) then
    raise exception using errcode = '42501', message = 'BUSINESS_MANAGER_REQUIRED';
  end if;

  select business.kind into target_kind
  from public.businesses business
  where business.id = target_business_id;
  if target_kind is null or target_kind not in ('home_kitchen', 'pop_up') then
    raise exception using errcode = '22023', message = 'PICKUP_CATEGORY_NOT_ELIGIBLE';
  end if;
  if site_kind not in ('public_meeting_place', 'commercial_site') then
    raise exception using errcode = '22023', message = 'RESIDENTIAL_PICKUP_SITE_NOT_ALLOWED';
  end if;
  if char_length(normalized_label) not between 1 and 120
    or char_length(normalized_address) not between 1 and 300
    or char_length(normalized_city) not between 1 and 120
    or char_length(normalized_region) not between 1 and 80
    or (normalized_postal is not null and char_length(normalized_postal) > 24)
    or latitude is null or latitude not between -90 and 90
    or longitude is null or longitude not between -180 and 180
    or not private.content_is_professional(concat_ws(
      ' ',
      normalized_label,
      normalized_address,
      normalized_city,
      normalized_region
    ))
  then
    raise exception using errcode = '22023', message = 'INVALID_PICKUP_SITE';
  end if;

  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'business_id', target_business_id,
    'label', normalized_label,
    'site_kind', site_kind,
    'address_line', normalized_address,
    'city', normalized_city,
    'region', normalized_region,
    'postal_code', normalized_postal,
    'latitude', latitude,
    'longitude', longitude
  ));
  prior_response := private.marketplace_chat_idempotent_response(
    actor,
    'submit_marketplace_pickup_site',
    key_hash,
    request_hash
  );
  if prior_response is not null then
    return prior_response;
  end if;

  perform private.consume_rate_limit(actor, 'marketplace_pickup_site_day', 10, 86400);
  insert into public.marketplace_pickup_sites (
    id,
    public_id,
    business_id,
    label,
    city,
    region,
    site_kind,
    submitted_by
  )
  values (
    target_site_id,
    target_site_public_id,
    target_business_id,
    normalized_label,
    normalized_city,
    normalized_region,
    site_kind,
    actor
  );

  insert into private.marketplace_pickup_site_details (
    site_id,
    address_line,
    postal_code,
    latitude,
    longitude
  )
  values (
    target_site_id,
    normalized_address,
    normalized_postal,
    latitude,
    longitude
  );

  response := jsonb_build_object(
    'pickup_site_public_id', target_site_public_id,
    'business_id', target_business_id,
    'state', 'submitted'
  );
  perform private.store_marketplace_chat_idempotency(
    actor,
    'submit_marketplace_pickup_site',
    key_hash,
    request_hash,
    response
  );
  perform private.write_audit_event(
    actor,
    target_business_id,
    'marketplace_pickup.site_submitted',
    'marketplace_pickup_site',
    target_site_public_id::text,
    jsonb_build_object('site_kind', site_kind)
  );
  return response;
end;
$$;

revoke all on function public.submit_marketplace_pickup_site(
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  double precision,
  double precision,
  text
) from public;
grant execute on function public.submit_marketplace_pickup_site(
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  double precision,
  double precision,
  text
) to authenticated;

create or replace function public.list_pending_marketplace_pickup_sites(
  result_limit integer default 50,
  result_offset integer default 0
)
returns table (
  pickup_site_public_id uuid,
  business_id uuid,
  business_name text,
  label text,
  site_kind text,
  address_line text,
  city text,
  region text,
  postal_code text,
  latitude double precision,
  longitude double precision,
  submitted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  bounded_limit integer := least(greatest(coalesce(result_limit, 50), 1), 100);
  bounded_offset integer := least(greatest(coalesce(result_offset, 0), 0), 10000);
  returned_count integer;
begin
  perform private.require_aal2();
  if not private.is_platform_staff(actor) then
    raise exception using errcode = '42501', message = 'STAFF_REQUIRED';
  end if;
  perform private.consume_rate_limit(actor, 'marketplace_pickup_queue_hour', 120, 3600);

  return query
  select
    site.public_id,
    site.business_id,
    business.name,
    site.label,
    site.site_kind,
    details.address_line,
    site.city,
    site.region,
    details.postal_code,
    details.latitude,
    details.longitude,
    site.created_at
  from public.marketplace_pickup_sites site
  join private.marketplace_pickup_site_details details on details.site_id = site.id
  join public.businesses business on business.id = site.business_id
  where site.state = 'submitted'
  order by site.created_at, site.id
  limit bounded_limit
  offset bounded_offset;
  get diagnostics returned_count = row_count;

  perform private.write_audit_event(
    actor,
    null,
    'marketplace_pickup.review_queue_accessed',
    'marketplace_pickup_queue',
    'pending',
    jsonb_build_object('result_count', returned_count)
  );
end;
$$;

revoke all on function public.list_pending_marketplace_pickup_sites(integer, integer) from public;
grant execute on function public.list_pending_marketplace_pickup_sites(integer, integer) to authenticated;

create or replace function public.review_marketplace_pickup_site(
  target_pickup_site_public_id uuid,
  next_state text,
  confirmed_non_residential boolean,
  review_reason text,
  idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_site public.marketplace_pickup_sites%rowtype;
  normalized_reason text := btrim(coalesce(review_reason, ''));
  key_hash text;
  request_hash text;
  prior_response jsonb;
  response jsonb;
begin
  perform private.require_aal2();
  if not private.is_platform_staff(actor) then
    raise exception using errcode = '42501', message = 'STAFF_REQUIRED';
  end if;
  if next_state not in ('approved', 'rejected')
    or (next_state = 'approved' and not coalesce(confirmed_non_residential, false))
    or char_length(normalized_reason) not between 10 and 1000
  then
    raise exception using errcode = '22023', message = 'INVALID_PICKUP_SITE_REVIEW';
  end if;

  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'pickup_site_public_id', target_pickup_site_public_id,
    'state', next_state,
    'confirmed_non_residential', confirmed_non_residential,
    'review_reason', normalized_reason
  ));
  prior_response := private.marketplace_chat_idempotent_response(
    actor,
    'review_marketplace_pickup_site',
    key_hash,
    request_hash
  );
  if prior_response is not null then
    return prior_response;
  end if;

  perform private.consume_rate_limit(actor, 'marketplace_pickup_review_hour', 120, 3600);
  select site.*
  into target_site
  from public.marketplace_pickup_sites site
  where site.public_id = target_pickup_site_public_id
  for update;

  if not found or target_site.state = 'archived' then
    raise exception using errcode = '22023', message = 'PICKUP_SITE_NOT_REVIEWABLE';
  end if;

  update private.marketplace_pickup_site_details
  set review_reason = normalized_reason,
      non_residential_confirmed = next_state = 'approved' and confirmed_non_residential,
      non_residential_confirmed_by = case
        when next_state = 'approved' and confirmed_non_residential then actor
        else null
      end,
      non_residential_confirmed_at = case
        when next_state = 'approved' and confirmed_non_residential then now()
        else null
      end,
      updated_at = now()
  where site_id = target_site.id;

  update public.marketplace_pickup_sites
  set state = next_state,
      reviewed_by = actor,
      reviewed_at = now(),
      updated_at = now()
  where id = target_site.id;

  response := jsonb_build_object(
    'pickup_site_public_id', target_site.public_id,
    'state', next_state
  );
  perform private.store_marketplace_chat_idempotency(
    actor,
    'review_marketplace_pickup_site',
    key_hash,
    request_hash,
    response
  );
  perform private.write_audit_event(
    actor,
    target_site.business_id,
    'marketplace_pickup.site_reviewed',
    'marketplace_pickup_site',
    target_site.public_id::text,
    jsonb_build_object('state', next_state)
  );
  return response;
end;
$$;

revoke all on function public.review_marketplace_pickup_site(uuid, text, boolean, text, text) from public;
grant execute on function public.review_marketplace_pickup_site(uuid, text, boolean, text, text) to authenticated;

create or replace function public.list_marketplace_pickup_options(
  target_conversation_public_id uuid
)
returns table (
  pickup_site_public_id uuid,
  label text,
  city text,
  region text,
  site_kind text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_conversation public.marketplace_conversations%rowtype;
begin
  select conversation.*
  into target_conversation
  from public.marketplace_conversations conversation
  where conversation.public_id = target_conversation_public_id;

  if not found
    or not private.marketplace_conversation_write_allowed(target_conversation.id, actor)
  then
    raise exception using errcode = '42501', message = 'CHAT_WRITE_NOT_ALLOWED';
  end if;

  return query
  select site.public_id, site.label, site.city, site.region, site.site_kind
  from public.marketplace_pickup_sites site
  where site.business_id = target_conversation.business_id
    and site.state = 'approved'
  order by site.label, site.public_id;
end;
$$;

revoke all on function public.list_marketplace_pickup_options(uuid) from public;
grant execute on function public.list_marketplace_pickup_options(uuid) to authenticated;

create or replace function public.request_marketplace_pickup_detail(
  target_conversation_public_id uuid,
  pickup_starts_at timestamptz,
  pickup_ends_at timestamptz,
  request_note text,
  idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_conversation public.marketplace_conversations%rowtype;
  normalized_note text := nullif(btrim(request_note), '');
  target_request_id uuid := gen_random_uuid();
  target_request_public_id uuid := gen_random_uuid();
  key_hash text;
  request_hash text;
  prior_response jsonb;
  response jsonb;
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  if pickup_starts_at is null or pickup_ends_at is null
    or pickup_starts_at < now() + interval '30 minutes'
    or pickup_starts_at > now() + interval '7 days'
    or pickup_ends_at < pickup_starts_at + interval '15 minutes'
    or pickup_ends_at > pickup_starts_at + interval '4 hours'
    or (normalized_note is not null and (
      char_length(normalized_note) > 240
      or not private.content_is_professional(normalized_note)
    ))
  then
    raise exception using errcode = '22023', message = 'INVALID_PICKUP_REQUEST';
  end if;

  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'conversation_public_id', target_conversation_public_id,
    'pickup_starts_at', pickup_starts_at,
    'pickup_ends_at', pickup_ends_at,
    'note', normalized_note
  ));
  prior_response := private.marketplace_chat_idempotent_response(
    actor,
    'request_marketplace_pickup_detail',
    key_hash,
    request_hash
  );
  if prior_response is not null then
    return prior_response;
  end if;

  perform private.consume_rate_limit(actor, 'marketplace_pickup_request_day', 20, 86400);
  select conversation.*
  into target_conversation
  from public.marketplace_conversations conversation
  where conversation.public_id = target_conversation_public_id
  for update;

  if not found
    or actor <> target_conversation.customer_id
    or not private.marketplace_conversation_write_allowed(target_conversation.id, actor)
  then
    raise exception using errcode = '42501', message = 'CUSTOMER_CHAT_ACCESS_REQUIRED';
  end if;
  if exists (
    select 1
    from public.marketplace_pickup_requests existing
    where existing.conversation_id = target_conversation.id
      and existing.state = 'pending'
  ) then
    raise exception using errcode = '55000', message = 'PICKUP_REQUEST_ALREADY_PENDING';
  end if;

  insert into public.marketplace_pickup_requests (
    id,
    public_id,
    conversation_id,
    requested_by,
    pickup_starts_at,
    pickup_ends_at,
    note
  )
  values (
    target_request_id,
    target_request_public_id,
    target_conversation.id,
    actor,
    pickup_starts_at,
    pickup_ends_at,
    normalized_note
  );

  response := jsonb_build_object(
    'pickup_request_public_id', target_request_public_id,
    'conversation_public_id', target_conversation.public_id,
    'state', 'pending',
    'version', 1
  );
  perform private.store_marketplace_chat_idempotency(
    actor,
    'request_marketplace_pickup_detail',
    key_hash,
    request_hash,
    response
  );
  perform private.write_audit_event(
    actor,
    target_conversation.business_id,
    'marketplace_pickup.detail_requested',
    'marketplace_pickup_request',
    target_request_public_id::text,
    jsonb_build_object(
      'conversation_public_id', target_conversation.public_id,
      'pickup_starts_at', pickup_starts_at,
      'pickup_ends_at', pickup_ends_at
    )
  );
  return response;
end;
$$;

revoke all on function public.request_marketplace_pickup_detail(
  uuid,
  timestamptz,
  timestamptz,
  text,
  text
) from public;
grant execute on function public.request_marketplace_pickup_detail(
  uuid,
  timestamptz,
  timestamptz,
  text,
  text
) to authenticated;

create or replace function public.authorize_marketplace_pickup_detail(
  target_conversation_public_id uuid,
  target_pickup_request_public_id uuid,
  target_pickup_site_public_id uuid,
  expected_version integer,
  idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_conversation public.marketplace_conversations%rowtype;
  target_request public.marketplace_pickup_requests%rowtype;
  target_site public.marketplace_pickup_sites%rowtype;
  target_details private.marketplace_pickup_site_details%rowtype;
  key_hash text;
  request_hash text;
  prior_response jsonb;
  response jsonb;
begin
  perform private.require_aal2();
  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'conversation_public_id', target_conversation_public_id,
    'pickup_request_public_id', target_pickup_request_public_id,
    'pickup_site_public_id', target_pickup_site_public_id,
    'expected_version', expected_version
  ));
  prior_response := private.marketplace_chat_idempotent_response(
    actor,
    'authorize_marketplace_pickup_detail',
    key_hash,
    request_hash
  );
  if prior_response is not null then
    return prior_response;
  end if;

  perform private.consume_rate_limit(actor, 'marketplace_pickup_authorize_day', 40, 86400);
  select conversation.*
  into target_conversation
  from public.marketplace_conversations conversation
  where conversation.public_id = target_conversation_public_id
  for update;

  if not found
    or actor <> target_conversation.merchant_id
    or not private.marketplace_conversation_write_allowed(target_conversation.id, actor)
  then
    raise exception using errcode = '42501', message = 'MERCHANT_CHAT_ACCESS_REQUIRED';
  end if;

  select request.*
  into target_request
  from public.marketplace_pickup_requests request
  where request.public_id = target_pickup_request_public_id
    and request.conversation_id = target_conversation.id
  for update;

  if not found or target_request.state <> 'pending'
    or target_request.version <> expected_version
    or target_request.pickup_starts_at <= now()
  then
    raise exception using errcode = '40001', message = 'PICKUP_REQUEST_VERSION_OR_STATE_CONFLICT';
  end if;

  select site.*
  into target_site
  from public.marketplace_pickup_sites site
  where site.public_id = target_pickup_site_public_id
    and site.business_id = target_conversation.business_id
    and site.state = 'approved';

  if not found or target_site.site_kind not in ('public_meeting_place', 'commercial_site') then
    raise exception using errcode = '55000', message = 'APPROVED_NON_RESIDENTIAL_PICKUP_SITE_REQUIRED';
  end if;

  select details.*
  into target_details
  from private.marketplace_pickup_site_details details
  where details.site_id = target_site.id;
  if not found then
    raise exception using errcode = '55000', message = 'PICKUP_SITE_DETAILS_UNAVAILABLE';
  end if;
  if not target_details.non_residential_confirmed then
    raise exception using errcode = '55000', message = 'NON_RESIDENTIAL_PICKUP_CONFIRMATION_REQUIRED';
  end if;

  insert into private.marketplace_pickup_disclosures (
    request_id,
    site_id,
    address_line,
    city,
    region,
    postal_code,
    latitude,
    longitude,
    authorized_by,
    authorized_at,
    reveal_at,
    expires_at
  )
  values (
    target_request.id,
    target_site.id,
    target_details.address_line,
    target_site.city,
    target_site.region,
    target_details.postal_code,
    target_details.latitude,
    target_details.longitude,
    actor,
    now(),
    now(),
    target_request.pickup_ends_at + interval '12 hours'
  );

  update public.marketplace_pickup_requests
  set state = 'authorized',
      version = version + 1,
      responded_by = actor,
      responded_at = now(),
      updated_at = now()
  where id = target_request.id;

  response := jsonb_build_object(
    'pickup_request_public_id', target_request.public_id,
    'pickup_site_public_id', target_site.public_id,
    'state', 'authorized',
    'version', expected_version + 1,
    'detail_expires_at', target_request.pickup_ends_at + interval '12 hours'
  );
  perform private.store_marketplace_chat_idempotency(
    actor,
    'authorize_marketplace_pickup_detail',
    key_hash,
    request_hash,
    response
  );
  perform private.write_audit_event(
    actor,
    target_conversation.business_id,
    'marketplace_pickup.detail_authorized',
    'marketplace_pickup_request',
    target_request.public_id::text,
    jsonb_build_object(
      'pickup_site_public_id', target_site.public_id,
      'expires_at', target_request.pickup_ends_at + interval '12 hours'
    )
  );
  return response;
end;
$$;

revoke all on function public.authorize_marketplace_pickup_detail(
  uuid,
  uuid,
  uuid,
  integer,
  text
) from public;
grant execute on function public.authorize_marketplace_pickup_detail(
  uuid,
  uuid,
  uuid,
  integer,
  text
) to authenticated;

create or replace function public.get_authorized_marketplace_pickup_detail(
  target_conversation_public_id uuid,
  target_pickup_request_public_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_conversation public.marketplace_conversations%rowtype;
  target_request public.marketplace_pickup_requests%rowtype;
  target_site public.marketplace_pickup_sites%rowtype;
  disclosure private.marketplace_pickup_disclosures%rowtype;
  first_customer_view boolean := false;
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;

  select conversation.*
  into target_conversation
  from public.marketplace_conversations conversation
  where conversation.public_id = target_conversation_public_id;

  if not found
    or not private.marketplace_conversation_access_allowed(target_conversation.id, actor)
    or private.users_are_blocked(target_conversation.customer_id, target_conversation.merchant_id)
  then
    raise exception using errcode = '42501', message = 'PICKUP_DETAIL_ACCESS_REQUIRED';
  end if;

  select request.*
  into target_request
  from public.marketplace_pickup_requests request
  where request.public_id = target_pickup_request_public_id
    and request.conversation_id = target_conversation.id
    and request.state = 'authorized';

  if not found then
    raise exception using errcode = '55000', message = 'PICKUP_DETAIL_NOT_AUTHORIZED';
  end if;

  select details.*
  into disclosure
  from private.marketplace_pickup_disclosures details
  where details.request_id = target_request.id
  for update;

  if not found or now() < disclosure.reveal_at or now() >= disclosure.expires_at then
    raise exception using errcode = '55000', message = 'PICKUP_DETAIL_NOT_AVAILABLE';
  end if;

  select site.*
  into target_site
  from public.marketplace_pickup_sites site
  where site.id = disclosure.site_id
    and site.state = 'approved'
    and site.site_kind in ('public_meeting_place', 'commercial_site');
  if not found then
    raise exception using errcode = '55000', message = 'PICKUP_SITE_NO_LONGER_APPROVED';
  end if;

  if actor = target_conversation.customer_id and disclosure.customer_first_viewed_at is null then
    update private.marketplace_pickup_disclosures
    set customer_first_viewed_at = now()
    where request_id = target_request.id
      and customer_first_viewed_at is null;
    first_customer_view := found;
  end if;

  if first_customer_view then
    perform private.write_audit_event(
      actor,
      target_conversation.business_id,
      'marketplace_pickup.detail_first_viewed',
      'marketplace_pickup_request',
      target_request.public_id::text,
      jsonb_build_object('pickup_site_public_id', target_site.public_id)
    );
  end if;

  return jsonb_build_object(
    'pickup_request_public_id', target_request.public_id,
    'pickup_site_public_id', target_site.public_id,
    'label', target_site.label,
    'site_kind', target_site.site_kind,
    'address_line', disclosure.address_line,
    'city', disclosure.city,
    'region', disclosure.region,
    'postal_code', disclosure.postal_code,
    'latitude', disclosure.latitude,
    'longitude', disclosure.longitude,
    'pickup_starts_at', target_request.pickup_starts_at,
    'pickup_ends_at', target_request.pickup_ends_at,
    'expires_at', disclosure.expires_at
  );
end;
$$;

revoke all on function public.get_authorized_marketplace_pickup_detail(uuid, uuid) from public;
grant execute on function public.get_authorized_marketplace_pickup_detail(uuid, uuid) to authenticated;

create or replace function public.resolve_marketplace_pickup_request(
  target_conversation_public_id uuid,
  target_pickup_request_public_id uuid,
  resolution text,
  expected_version integer,
  idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_conversation public.marketplace_conversations%rowtype;
  target_request public.marketplace_pickup_requests%rowtype;
  next_state text;
  key_hash text;
  request_hash text;
  prior_response jsonb;
  response jsonb;
begin
  if resolution not in ('cancel', 'decline', 'revoke') then
    raise exception using errcode = '22023', message = 'INVALID_PICKUP_RESOLUTION';
  end if;

  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'conversation_public_id', target_conversation_public_id,
    'pickup_request_public_id', target_pickup_request_public_id,
    'resolution', resolution,
    'expected_version', expected_version
  ));
  prior_response := private.marketplace_chat_idempotent_response(
    actor,
    'resolve_marketplace_pickup_request',
    key_hash,
    request_hash
  );
  if prior_response is not null then
    return prior_response;
  end if;

  perform private.consume_rate_limit(actor, 'marketplace_pickup_resolve_day', 40, 86400);
  select conversation.*
  into target_conversation
  from public.marketplace_conversations conversation
  where conversation.public_id = target_conversation_public_id
  for update;

  if not found or not private.marketplace_conversation_access_allowed(target_conversation.id, actor) then
    raise exception using errcode = '42501', message = 'CHAT_ACCESS_REQUIRED';
  end if;

  select request.*
  into target_request
  from public.marketplace_pickup_requests request
  where request.public_id = target_pickup_request_public_id
    and request.conversation_id = target_conversation.id
  for update;

  if not found or target_request.version <> expected_version
    or target_request.state not in ('pending', 'authorized')
  then
    raise exception using errcode = '40001', message = 'PICKUP_REQUEST_VERSION_OR_STATE_CONFLICT';
  end if;

  if actor = target_conversation.customer_id and resolution = 'cancel' then
    next_state := 'cancelled';
  elsif actor = target_conversation.merchant_id
    and resolution = 'decline'
    and target_request.state = 'pending'
  then
    next_state := 'declined';
  elsif actor = target_conversation.merchant_id
    and resolution = 'revoke'
    and target_request.state = 'authorized'
  then
    next_state := 'cancelled';
  else
    raise exception using errcode = '42501', message = 'PICKUP_RESOLUTION_NOT_ALLOWED';
  end if;

  update public.marketplace_pickup_requests
  set state = next_state,
      version = version + 1,
      responded_by = actor,
      responded_at = now(),
      updated_at = now()
  where id = target_request.id;
  delete from private.marketplace_pickup_disclosures
  where request_id = target_request.id;

  response := jsonb_build_object(
    'pickup_request_public_id', target_request.public_id,
    'state', next_state,
    'version', expected_version + 1
  );
  perform private.store_marketplace_chat_idempotency(
    actor,
    'resolve_marketplace_pickup_request',
    key_hash,
    request_hash,
    response
  );
  perform private.write_audit_event(
    actor,
    target_conversation.business_id,
    'marketplace_pickup.request_resolved',
    'marketplace_pickup_request',
    target_request.public_id::text,
    jsonb_build_object('state', next_state, 'resolution', resolution)
  );
  return response;
end;
$$;

revoke all on function public.resolve_marketplace_pickup_request(
  uuid,
  uuid,
  text,
  integer,
  text
) from public;
grant execute on function public.resolve_marketplace_pickup_request(
  uuid,
  uuid,
  text,
  integer,
  text
) to authenticated;

create or replace function public.cleanup_marketplace_chat_ephemera()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  typing_deleted integer;
  disclosures_deleted integer;
  receipts_deleted integer;
  requests_expired integer;
begin
  delete from public.marketplace_typing_presence presence
  where presence.expires_at <= now();
  get diagnostics typing_deleted = row_count;

  update public.marketplace_pickup_requests request
  set state = 'expired',
      version = version + 1,
      responded_at = coalesce(responded_at, now()),
      updated_at = now()
  where request.state in ('pending', 'authorized')
    and request.pickup_ends_at + interval '12 hours' <= now();
  get diagnostics requests_expired = row_count;

  delete from private.marketplace_pickup_disclosures disclosure
  where disclosure.expires_at <= now();
  get diagnostics disclosures_deleted = row_count;

  delete from private.marketplace_chat_idempotency receipt
  where receipt.created_at < now() - interval '30 days';
  get diagnostics receipts_deleted = row_count;

  return jsonb_build_object(
    'typing_deleted', typing_deleted,
    'requests_expired', requests_expired,
    'disclosures_deleted', disclosures_deleted,
    'idempotency_receipts_deleted', receipts_deleted
  );
end;
$$;

revoke all on function public.cleanup_marketplace_chat_ephemera() from public, anon, authenticated;
grant execute on function public.cleanup_marketplace_chat_ephemera() to service_role;

drop policy if exists "participants read processed marketplace chat media"
  on storage.objects;
create policy "participants read processed marketplace chat media"
  on storage.objects
  for select to authenticated
  using (
    bucket_id = 'spottr-media'
    and exists (
      select 1
      from public.media_assets asset
      join public.marketplace_message_media link on link.asset_id = asset.id
      join public.marketplace_messages message on message.id = link.message_id
      where asset.processed_storage_path = name
        and asset.quarantine_state = 'clean'
        and asset.moderation = 'approved'
        and message.visibility = 'visible'
        and message.deleted_at is null
        and private.marketplace_conversation_access_allowed(
          message.conversation_id,
          auth.uid()
        )
    )
  );

drop policy if exists "aal2 staff read reported marketplace chat media"
  on storage.objects;
create policy "aal2 staff read reported marketplace chat media"
  on storage.objects
  for select to authenticated
  using (
    bucket_id = 'spottr-media'
    and private.has_aal2()
    and private.is_platform_staff(auth.uid())
    and exists (
      select 1
      from public.media_assets asset
      join public.marketplace_message_media link on link.asset_id = asset.id
      join public.content_reports report
        on report.target_type = 'chat_message'
       and report.target_id = link.message_id
      where asset.processed_storage_path = name
        and asset.quarantine_state = 'clean'
        and asset.moderation = 'approved'
        and report.state in ('open', 'reviewing')
    )
  );

alter table public.marketplace_conversations replica identity full;
alter table public.marketplace_messages replica identity full;
alter table public.marketplace_read_receipts replica identity full;
alter table public.marketplace_typing_presence replica identity full;
alter table public.marketplace_pickup_requests replica identity full;

do $$
declare
  relation_name text;
begin
  if exists (
    select 1
    from pg_catalog.pg_publication publication
    where publication.pubname = 'supabase_realtime'
  ) then
    foreach relation_name in array array[
      'marketplace_conversations',
      'marketplace_messages',
      'marketplace_read_receipts',
      'marketplace_typing_presence',
      'marketplace_pickup_requests'
    ] loop
      if not exists (
        select 1
        from pg_catalog.pg_publication_tables published
        where published.pubname = 'supabase_realtime'
          and published.schemaname = 'public'
          and published.tablename = relation_name
      ) then
        execute pg_catalog.format(
          'alter publication supabase_realtime add table public.%I',
          relation_name
        );
      end if;
    end loop;
  end if;
end;
$$;
