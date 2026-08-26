-- Persistent business posts and the followed-content feed.
-- This also closes the media-stage grant gap for profile banners and reserves a
-- dedicated, business-authorized purpose for post images.

create or replace function public.consume_media_stage_slot(target_user_id uuid, media_purpose text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not private.is_active_user(target_user_id)
    or media_purpose not in (
      'profile_avatar', 'profile_banner', 'business_logo', 'business_gallery',
      'business_post', 'review_photo', 'chat_photo', 'claim_evidence'
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

create or replace function public.create_media_stage_grant(
  target_user_id uuid,
  target_storage_path text,
  media_purpose text,
  target_business_id uuid,
  target_conversation_public_id uuid,
  target_mime_type text,
  target_byte_size bigint
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare grant_id uuid;
begin
  if not private.is_active_user(target_user_id)
    or media_purpose not in (
      'profile_avatar', 'profile_banner', 'business_logo', 'business_gallery',
      'business_post', 'review_photo', 'chat_photo', 'claim_evidence'
    )
    or target_storage_path !~ ('^quarantine/' || target_user_id::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$')
    or target_mime_type not in ('image/jpeg', 'image/png', 'image/webp')
    or target_byte_size not between 1 and 5242880
    or ((media_purpose in ('profile_avatar', 'profile_banner')) <> (target_business_id is null))
    or ((media_purpose = 'chat_photo') <> (target_conversation_public_id is not null))
  then
    raise exception using errcode = '22023', message = 'INVALID_MEDIA_STAGE_GRANT';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_user_id::text, 7741902));
  if not private.is_active_user(target_user_id) then
    raise exception using errcode = '42501', message = 'ACCOUNT_MUTATIONS_FROZEN';
  end if;

  insert into private.media_stage_grants (
    owner_id, storage_path, purpose, business_id, conversation_public_id,
    mime_type, byte_size, expires_at
  ) values (
    target_user_id, target_storage_path, media_purpose, target_business_id,
    target_conversation_public_id, target_mime_type, target_byte_size,
    now() + interval '2 hours 5 minutes'
  ) returning id into grant_id;
  return grant_id;
end;
$$;

create or replace function private.consume_media_stage_grant()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare grant_row private.media_stage_grants%rowtype;
begin
  if new.source = 'licensed_provider' then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.owner_id::text, 7741902));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.storage_path, 7741903));

  select stage_grant.* into grant_row
  from private.media_stage_grants stage_grant
  where stage_grant.storage_path = new.storage_path
  for update;

  if not found
    or grant_row.owner_id <> new.owner_id
    or grant_row.state <> 'issued'
    or grant_row.expires_at <= now()
    or grant_row.mime_type <> new.mime_type
    or grant_row.byte_size <> new.byte_size
    or grant_row.business_id is distinct from new.business_id
    or (new.source = 'review_upload' and grant_row.purpose <> 'review_photo')
    or (new.source = 'chat_upload' and grant_row.purpose <> 'chat_photo')
    or (new.source = 'owner_upload' and grant_row.purpose not in (
      'profile_avatar', 'profile_banner', 'business_logo', 'business_gallery', 'business_post'
    ))
    or exists (
      select 1 from private.media_cleanup_items item
      where item.storage_path = new.storage_path and item.state <> 'finalized'
    )
    or exists (
      select 1 from private.account_deletion_freezes deletion_freeze
      where deletion_freeze.user_id = new.owner_id
    )
  then
    raise exception using errcode = '55000', message = 'MEDIA_STAGE_GRANT_UNAVAILABLE';
  end if;

  update private.media_stage_grants
  set state = 'registered', registered_asset_id = new.id, updated_at = now()
  where id = grant_row.id;
  return new;
end;
$$;

create table if not exists public.business_posts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  author_id uuid references auth.users(id) on delete set null,
  body text not null default '',
  moderation public.moderation_state not null default 'approved',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint business_posts_body_length check (char_length(body) <= 500)
);

create index if not exists business_posts_business_time_idx
  on public.business_posts (business_id, created_at desc)
  where deleted_at is null;

create table if not exists public.business_post_media (
  post_id uuid not null references public.business_posts(id) on delete cascade,
  asset_id uuid not null references public.media_assets(id) on delete cascade,
  sort_order smallint not null check (sort_order between 0 and 3),
  primary key (post_id, asset_id),
  unique (post_id, sort_order)
);

alter table public.business_posts enable row level security;
alter table public.business_posts force row level security;
alter table public.business_post_media enable row level security;
alter table public.business_post_media force row level security;
revoke all on public.business_posts from public, anon, authenticated;
revoke all on public.business_post_media from public, anon, authenticated;

create or replace function public.create_business_post(
  target_business_id uuid,
  post_body text,
  media_asset_ids uuid[] default '{}'::uuid[],
  idempotency_key text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  normalized_body text := btrim(regexp_replace(coalesce(post_body, ''), '[[:space:]]+', ' ', 'g'));
  normalized_assets uuid[] := coalesce(media_asset_ids, '{}'::uuid[]);
  asset_count integer := cardinality(coalesce(media_asset_ids, '{}'::uuid[]));
  target_post_id uuid;
  existing_post_id uuid;
  key_hash text;
  request_hash text;
  stored_request_hash text;
begin
  perform private.require_aal2();
  if not private.is_active_user(actor)
    or not private.is_business_member(target_business_id, actor, array['owner', 'manager']::public.member_role[])
    or not private.is_business_publicly_eligible(target_business_id)
  then
    raise exception using errcode = '42501', message = 'Active business publishing access required';
  end if;
  if char_length(normalized_body) > 500
    or (normalized_body = '' and asset_count = 0)
    or not private.content_is_professional(normalized_body)
    or asset_count > 4
    or array_position(normalized_assets, null) is not null
    or (select count(distinct supplied.id) from unnest(normalized_assets) supplied(id)) <> asset_count
  then
    raise exception using errcode = '22023', message = 'Invalid business post';
  end if;
  if asset_count > 0 and (
    select count(*)
    from public.media_assets asset
    join private.media_stage_grants grant
      on grant.registered_asset_id = asset.id
     and grant.purpose = 'business_post'
     and grant.state = 'registered'
    where asset.id = any(normalized_assets)
      and asset.owner_id = actor
      and asset.business_id = target_business_id
      and asset.source = 'owner_upload'
      and asset.quarantine_state = 'clean'
      and asset.moderation = 'approved'
      and asset.processed_storage_path is not null
  ) <> asset_count then
    raise exception using errcode = '22023', message = 'Post media is not approved';
  end if;

  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'business_id', target_business_id,
    'body', normalized_body,
    'media_asset_ids', to_jsonb(normalized_assets)
  ));
  perform private.lock_idempotency_request(actor, 'business_post_create', key_hash);
  select receipt.response_id, receipt.request_hash
  into existing_post_id, stored_request_hash
  from private.action_idempotency_receipts receipt
  where receipt.actor_id = actor
    and receipt.action = 'business_post_create'
    and receipt.idempotency_key_hash = key_hash;
  if existing_post_id is not null then
    if stored_request_hash is distinct from request_hash then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    if not exists (
      select 1 from public.business_posts post
      where post.id = existing_post_id and post.business_id = target_business_id
    ) then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_RESPONSE_GONE';
    end if;
    return existing_post_id;
  end if;

  perform private.consume_rate_limit(actor, 'business_post_hour', 12, 3600);
  perform private.consume_rate_limit(actor, 'business_post_day', 50, 86400);

  insert into public.business_posts (business_id, author_id, body)
  values (target_business_id, actor, normalized_body)
  returning id into target_post_id;

  insert into public.business_post_media (post_id, asset_id, sort_order)
  select target_post_id, supplied.id, (supplied.ordinality - 1)::smallint
  from unnest(normalized_assets) with ordinality supplied(id, ordinality);

  insert into private.action_idempotency_receipts (
    actor_id, action, idempotency_key_hash, request_hash, response_id
  ) values (
    actor, 'business_post_create', key_hash, request_hash, target_post_id
  );

  perform private.write_audit_event(
    actor, target_business_id, 'business.post_created', 'business_post', target_post_id::text,
    jsonb_build_object('media_count', asset_count, 'body_present', normalized_body <> '')
  );
  return target_post_id;
end;
$$;

create or replace function public.delete_business_post(target_post_id uuid)
returns boolean
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
  select post.business_id into target_business_id
  from public.business_posts post
  where post.id = target_post_id and post.deleted_at is null
  for update;
  if target_business_id is null
    or not private.is_business_member(target_business_id, actor, array['owner', 'manager']::public.member_role[])
  then
    raise exception using errcode = '42501', message = 'Business publishing access required';
  end if;
  perform private.consume_rate_limit(actor, 'business_post_delete', 50, 86400);
  update public.business_posts set deleted_at = now(), updated_at = now()
  where id = target_post_id;
  perform private.write_audit_event(
    actor, target_business_id, 'business.post_deleted', 'business_post', target_post_id::text, '{}'::jsonb
  );
  return true;
end;
$$;

create or replace function public.list_approved_business_post_media(target_business_id uuid)
returns table (asset_id uuid, storage_path text, width integer, height integer, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare actor uuid := auth.uid();
begin
  perform private.require_aal2();
  if not private.is_business_member(target_business_id, actor, array['owner', 'manager']::public.member_role[]) then
    raise exception using errcode = '42501', message = 'Business publishing access required';
  end if;
  return query
  select asset.id, asset.processed_storage_path, asset.width, asset.height, asset.created_at
  from public.media_assets asset
  join private.media_stage_grants grant
    on grant.registered_asset_id = asset.id
   and grant.purpose = 'business_post'
   and grant.state = 'registered'
  where asset.owner_id = actor
    and asset.business_id = target_business_id
    and asset.source = 'owner_upload'
    and asset.quarantine_state = 'clean'
    and asset.moderation = 'approved'
    and asset.processed_storage_path is not null
  order by asset.created_at desc
  limit 100;
end;
$$;

create or replace view public.public_business_posts
with (security_barrier = true, security_invoker = false)
as
select
  post.id as post_id,
  post.business_id,
  business.name as business_name,
  business.slug as business_slug,
  post.body,
  post.created_at,
  post.updated_at
from public.business_posts post
join public.businesses business on business.id = post.business_id
where post.moderation = 'approved'
  and post.deleted_at is null
  and private.is_business_publicly_eligible(post.business_id);

create or replace view public.public_business_post_media
with (security_barrier = true, security_invoker = false)
as
select
  link.post_id,
  post.business_id,
  link.asset_id,
  link.sort_order,
  asset.processed_storage_path as storage_path,
  asset.mime_type,
  asset.width,
  asset.height
from public.business_post_media link
join public.business_posts post on post.id = link.post_id
join public.media_assets asset on asset.id = link.asset_id
where post.moderation = 'approved'
  and post.deleted_at is null
  and private.is_business_publicly_eligible(post.business_id)
  and private.is_media_publicly_eligible(asset.id);

create or replace view public.public_followed_feed
with (security_barrier = true, security_invoker = false)
as
select
  'business_post'::text as feed_type,
  post.id as content_id,
  post.business_id,
  business.name as business_name,
  business.slug as business_slug,
  null::uuid as author_public_id,
  null::text as author_username,
  null::text as author_display_name,
  post.body,
  null::smallint as rating,
  post.created_at,
  post.updated_at
from public.business_posts post
join public.follows follow on follow.business_id = post.business_id and follow.user_id = auth.uid()
join public.businesses business on business.id = post.business_id
where auth.uid() is not null
  and post.moderation = 'approved'
  and post.deleted_at is null
  and private.is_business_publicly_eligible(post.business_id)

union all

select
  'user_review'::text,
  review.id,
  review.business_id,
  business.name,
  business.slug,
  author.public_id,
  author.username::text,
  author.display_name,
  review.body,
  review.rating,
  review.created_at,
  review.updated_at
from public.reviews review
join public.profile_follows follow on follow.followed_id = review.author_id and follow.follower_id = auth.uid()
join public.profiles author on author.user_id = review.author_id and author.status = 'active'
join public.businesses business on business.id = review.business_id
where auth.uid() is not null
  and review.moderation = 'approved'
  and review.deleted_at is null
  and private.is_business_publicly_eligible(review.business_id)
  and not private.users_are_blocked(auth.uid(), review.author_id);

revoke all on function public.consume_media_stage_slot(uuid, text) from public, anon, authenticated;
grant execute on function public.consume_media_stage_slot(uuid, text) to service_role;
revoke all on function public.create_media_stage_grant(uuid, text, text, uuid, uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.create_media_stage_grant(uuid, text, text, uuid, uuid, text, bigint) to service_role;
revoke all on function private.consume_media_stage_grant() from public, anon, authenticated, service_role;
revoke all on function public.create_business_post(uuid, text, uuid[], text) from public;
revoke all on function public.delete_business_post(uuid) from public;
revoke all on function public.list_approved_business_post_media(uuid) from public;
grant execute on function public.create_business_post(uuid, text, uuid[], text) to authenticated;
grant execute on function public.delete_business_post(uuid) to authenticated;
grant execute on function public.list_approved_business_post_media(uuid) to authenticated;
revoke all on public.public_business_posts from public, anon, authenticated;
revoke all on public.public_business_post_media from public, anon, authenticated;
revoke all on public.public_followed_feed from public, anon, authenticated;
grant select on public.public_business_posts to anon, authenticated;
grant select on public.public_business_post_media to anon, authenticated;
grant select on public.public_followed_feed to authenticated;
