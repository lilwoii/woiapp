-- Public social profiles use opaque identifiers and safe projections. Private account
-- identifiers, email, moderation state, and media evidence never enter public views.

alter table public.profiles
  add column if not exists bio text not null default '',
  add column if not exists links jsonb not null default '[]'::jsonb,
  add column if not exists banner_path text,
  add column if not exists show_favorites boolean not null default true,
  add column if not exists show_following boolean not null default true;

alter table public.profiles drop constraint if exists profiles_bio_length;
alter table public.profiles add constraint profiles_bio_length
  check (char_length(bio) <= 240);
alter table public.profiles drop constraint if exists profiles_links_shape;
alter table public.profiles add constraint profiles_links_shape
  check (jsonb_typeof(links) = 'array' and jsonb_array_length(links) <= 3 and octet_length(links::text) <= 2048);
alter table public.profiles drop constraint if exists profiles_banner_path_length;
alter table public.profiles add constraint profiles_banner_path_length
  check (banner_path is null or char_length(banner_path) <= 512);

create table if not exists public.profile_follows (
  follower_id uuid not null references public.profiles(user_id) on delete cascade,
  followed_id uuid not null references public.profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followed_id),
  constraint profile_follows_not_self check (follower_id <> followed_id)
);

create index if not exists profile_follows_followed_idx
  on public.profile_follows (followed_id, created_at desc);

alter table public.profile_follows enable row level security;

drop policy if exists "users read own profile follows" on public.profile_follows;
create policy "users read own profile follows"
on public.profile_follows for select to authenticated
using (follower_id = auth.uid());

grant select on table public.profile_follows to authenticated;
revoke insert, update, delete on table public.profile_follows from anon, authenticated, service_role;

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
      'profile_banner',
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

create or replace function private.validate_public_profile_links(candidate jsonb)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case when jsonb_typeof(candidate) = 'array' then
    jsonb_array_length(candidate) <= 3
      and octet_length(candidate::text) <= 2048
      and not exists (
        select 1
        from jsonb_array_elements(candidate) item
        where jsonb_typeof(item) <> 'object'
          or exists (
            select 1 from jsonb_object_keys(
              case when jsonb_typeof(item) = 'object' then item else '{}'::jsonb end
            ) supplied(key)
            where supplied.key not in ('label', 'url')
          )
          or char_length(btrim(coalesce(item ->> 'label', ''))) not between 1 and 40
          or not private.content_is_professional(btrim(coalesce(item ->> 'label', '')))
          or char_length(coalesce(item ->> 'url', '')) not between 9 and 500
          or coalesce(item ->> 'url', '') !~ '^https://[A-Za-z0-9]'
          or coalesce(item ->> 'url', '') ~ '[[:cntrl:]<>"\\]'
      )
  else false end;
$$;

create or replace function public.update_own_social_profile(payload jsonb)
returns table (
  public_id uuid,
  bio text,
  links jsonb,
  banner_path text,
  show_favorites boolean,
  show_following boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  next_bio text;
  next_links jsonb;
  next_banner_path text;
  next_show_favorites boolean;
  next_show_following boolean;
  requested_banner_id uuid;
  approved_review_count integer;
begin
  perform private.require_aal2();
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception using errcode = '22023', message = 'Payload must be a JSON object';
  end if;
  if exists (
    select 1 from jsonb_object_keys(payload) supplied(key)
    where supplied.key not in ('bio', 'links', 'banner_asset_id', 'show_favorites', 'show_following')
  ) then
    raise exception using errcode = '22023', message = 'Payload contains unsupported fields';
  end if;

  select p.bio, p.links, p.banner_path, p.show_favorites, p.show_following
  into next_bio, next_links, next_banner_path, next_show_favorites, next_show_following
  from public.profiles p
  where p.user_id = actor
  for update;

  if not found then
    raise exception using errcode = '22023', message = 'Profile not found';
  end if;

  if payload ? 'bio' then next_bio := btrim(coalesce(payload ->> 'bio', '')); end if;
  if payload ? 'links' then next_links := coalesce(payload -> 'links', '[]'::jsonb); end if;
  if payload ? 'show_favorites' then
    if jsonb_typeof(payload -> 'show_favorites') <> 'boolean' then
      raise exception using errcode = '22023', message = 'Invalid favorites visibility';
    end if;
    next_show_favorites := (payload ->> 'show_favorites')::boolean;
  end if;
  if payload ? 'show_following' then
    if jsonb_typeof(payload -> 'show_following') <> 'boolean' then
      raise exception using errcode = '22023', message = 'Invalid following visibility';
    end if;
    next_show_following := (payload ->> 'show_following')::boolean;
  end if;

  if char_length(next_bio) > 240 or not private.content_is_professional(next_bio) then
    raise exception using errcode = '22023', message = 'Invalid profile bio';
  end if;
  if not private.validate_public_profile_links(next_links) then
    raise exception using errcode = '22023', message = 'Invalid profile links';
  end if;

  if payload ? 'banner_asset_id' then
    if jsonb_typeof(payload -> 'banner_asset_id') = 'null' then
      next_banner_path := null;
    else
      begin
        requested_banner_id := (payload ->> 'banner_asset_id')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode = '22023', message = 'Invalid banner asset';
      end;

      select count(*)::integer into approved_review_count
      from public.reviews r
      where r.author_id = actor and r.moderation = 'approved' and r.deleted_at is null;
      if approved_review_count < 10 then
        raise exception using errcode = '42501', message = 'Ten approved reviews are required for a profile banner';
      end if;

      select ma.processed_storage_path into next_banner_path
      from public.media_assets ma
      where ma.id = requested_banner_id
        and ma.owner_id = actor
        and ma.business_id is null
        and ma.source = 'owner_upload'
        and ma.quarantine_state = 'clean'
        and ma.moderation = 'approved'
        and ma.width between 900 and 6000
        and ma.height between 300 and 2400
        and ma.width::numeric / nullif(ma.height, 0) between 1.8 and 5.0;
      if next_banner_path is null then
        raise exception using errcode = '22023', message = 'Banner asset is not approved or has invalid dimensions';
      end if;
    end if;
  end if;

  perform private.consume_rate_limit(actor, 'social_profile_update', 20, 3600);

  update public.profiles p set
    bio = next_bio,
    links = next_links,
    banner_path = next_banner_path,
    show_favorites = next_show_favorites,
    show_following = next_show_following
  where p.user_id = actor;

  perform private.write_audit_event(
    actor, null, 'profile.social_updated', 'profile', null,
    jsonb_build_object(
      'bio_present', next_bio <> '',
      'link_count', jsonb_array_length(next_links),
      'banner_present', next_banner_path is not null,
      'show_favorites', next_show_favorites,
      'show_following', next_show_following
    )
  );

  return query
  select p.public_id, p.bio, p.links, p.banner_path, p.show_favorites, p.show_following
  from public.profiles p where p.user_id = actor;
end;
$$;

create or replace function public.set_profile_follow_by_public_id(
  target_public_id uuid,
  should_follow boolean
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_user_id uuid;
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active account required';
  end if;
  select p.user_id into target_user_id
  from public.profiles p
  where p.public_id = target_public_id and p.status = 'active'
  for share;
  if target_user_id is null then
    raise exception using errcode = 'P0002', message = 'Profile not found';
  end if;
  if target_user_id = actor then
    raise exception using errcode = '22023', message = 'A profile cannot follow itself';
  end if;
  if private.users_are_blocked(actor, target_user_id) then
    raise exception using errcode = '42501', message = 'This profile is unavailable';
  end if;

  perform private.consume_rate_limit(actor, 'profile_follow', 120, 3600);
  if should_follow then
    insert into public.profile_follows (follower_id, followed_id)
    values (actor, target_user_id)
    on conflict (follower_id, followed_id) do nothing;
  else
    delete from public.profile_follows pf
    where pf.follower_id = actor and pf.followed_id = target_user_id;
  end if;
  return should_follow;
end;
$$;

create or replace view public.public_profile_directory
with (security_barrier = true, security_invoker = false)
as
select
  p.public_id,
  p.username::text as username,
  p.display_name,
  p.avatar_path,
  case when review_stats.review_count >= 10 then p.banner_path else null end as banner_path,
  p.bio,
  p.links,
  review_stats.review_count,
  follower_stats.follower_count,
  case when p.show_following then following_stats.following_count else null end as following_count,
  case when p.show_favorites then favorite_stats.favorite_count else null end as favorite_count,
  p.show_following,
  p.show_favorites,
  exists (
    select 1 from public.profile_follows viewer_follow
    where viewer_follow.follower_id = auth.uid() and viewer_follow.followed_id = p.user_id
  ) as followed_by_viewer,
  p.created_at
from public.profiles p
cross join lateral (
  select count(*)::integer as review_count
  from public.reviews r
  where r.author_id = p.user_id and r.moderation = 'approved' and r.deleted_at is null
) review_stats
cross join lateral (
  select count(*)::integer as follower_count
  from public.profile_follows pf
  where pf.followed_id = p.user_id
) follower_stats
cross join lateral (
  select count(*)::integer as following_count
  from public.profile_follows pf
  where pf.follower_id = p.user_id
) following_stats
cross join lateral (
  select count(*)::integer as favorite_count
  from public.follows f
  where f.user_id = p.user_id and private.is_business_publicly_eligible(f.business_id)
) favorite_stats
where p.status = 'active'
  and (
    auth.uid() is null
    or auth.uid() = p.user_id
    or not private.users_are_blocked(auth.uid(), p.user_id)
  );

create or replace view public.public_profile_following
with (security_barrier = true, security_invoker = false)
as
select owner.public_id as subject_public_id, followed.public_id as followed_public_id, pf.created_at
from public.profile_follows pf
join public.profiles owner on owner.user_id = pf.follower_id and owner.status = 'active'
join public.profiles followed on followed.user_id = pf.followed_id and followed.status = 'active'
where owner.show_following
  and (
    auth.uid() is null
    or (not private.users_are_blocked(auth.uid(), owner.user_id)
      and not private.users_are_blocked(auth.uid(), followed.user_id))
  );

create or replace view public.public_profile_favorites
with (security_barrier = true, security_invoker = false)
as
select p.public_id as subject_public_id, f.business_id, f.created_at
from public.follows f
join public.profiles p on p.user_id = f.user_id and p.status = 'active'
where p.show_favorites
  and private.is_business_publicly_eligible(f.business_id)
  and (
    auth.uid() is null or not private.users_are_blocked(auth.uid(), p.user_id)
  );

revoke all on function private.validate_public_profile_links(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.update_own_social_profile(jsonb) from public, anon, service_role;
grant execute on function public.update_own_social_profile(jsonb) to authenticated;
revoke all on function public.set_profile_follow_by_public_id(uuid, boolean) from public, anon, service_role;
grant execute on function public.set_profile_follow_by_public_id(uuid, boolean) to authenticated;

grant select on table public.public_profile_directory to anon, authenticated;
grant select on table public.public_profile_following to anon, authenticated;
grant select on table public.public_profile_favorites to anon, authenticated;
