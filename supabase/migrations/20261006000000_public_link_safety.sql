-- User-published destinations must resolve through public DNS names. This
-- rejects credential-bearing, loopback, private-network, single-label, and
-- reserved-development hosts at the database boundary and public projection.

create or replace function private.public_https_url_is_safe(
  candidate text,
  maximum_bytes integer
)
returns boolean
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  raw_url text;
  authority text;
  host_name text;
  host_label text;
  host_labels text[];
  terminal_label text;
begin
  if candidate is null
    or maximum_bytes not between 1 and 2048
    or octet_length(candidate) > maximum_bytes
  then
    return false;
  end if;

  raw_url := btrim(candidate);
  if raw_url = ''
    or raw_url <> candidate
    or raw_url !~* '^https://'
    or raw_url ~ '[[:space:][:cntrl:]<>"\\]'
  then
    return false;
  end if;

  authority := (pg_catalog.regexp_match(raw_url, '^https://([^/?#]+)', 'i'))[1];
  if authority is null or authority ~ '[@:]' then
    return false;
  end if;

  host_name := lower(authority);
  if char_length(host_name) > 253
    or position('.' in host_name) = 0
    or host_name like '%.'
    or host_name !~ '^[a-z0-9.-]+$'
    or host_name ~ '^[0-9.]+$'
    or host_name ~* '^(0x[0-9a-f]+|0[0-7]*|[0-9]+)(\.(0x[0-9a-f]+|0[0-7]*|[0-9]+))+$'
  then
    return false;
  end if;

  host_labels := string_to_array(host_name, '.');
  foreach host_label in array host_labels loop
    if char_length(host_label) not between 1 and 63
      or host_label !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
    then
      return false;
    end if;
  end loop;

  terminal_label := host_labels[array_length(host_labels, 1)];
  if terminal_label in (
    'corp', 'example', 'home', 'internal', 'invalid', 'lan', 'local',
    'localhost', 'onion', 'test'
  ) then
    return false;
  end if;

  return true;
end;
$$;

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
          or jsonb_typeof(item -> 'url') is distinct from 'string'
          or not private.public_https_url_is_safe(item ->> 'url', 500)
      )
  else false end;
$$;

-- Preserve only safe public state during upgrades. Business owners can re-enter
-- a rejected destination after correcting it; unsafe profile links fail closed.
update public.profiles profile
set links = coalesce(
  (
    select jsonb_agg(entry.value order by entry.ordinality)
    from jsonb_array_elements(profile.links) with ordinality entry(value, ordinality)
    where private.validate_public_profile_links(jsonb_build_array(entry.value))
  ),
  '[]'::jsonb
)
where not private.validate_public_profile_links(profile.links);

update public.business_private_details details
set show_website_public = false,
    updated_at = now()
where details.show_website_public
  and (
    details.website_url is null
    or not private.public_https_url_is_safe(details.website_url, 2048)
  );

alter table public.profiles
  drop constraint if exists profiles_public_links_safe;
alter table public.profiles
  add constraint profiles_public_links_safe
  check (private.validate_public_profile_links(links));

alter table public.business_private_details
  drop constraint if exists business_private_website_https;
alter table public.business_private_details
  add constraint business_private_website_https
  check (
    not show_website_public
    or private.public_https_url_is_safe(website_url, 2048)
  );

create or replace function private.enforce_business_revision_public_links()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  contacts_patch jsonb;
  proposed_website jsonb;
  proposed_value text;
begin
  contacts_patch := new.proposed_patch -> 'contacts';
  if contacts_patch is null then
    return new;
  end if;
  if jsonb_typeof(contacts_patch) <> 'object' then
    raise exception using errcode = '22023', message = 'Invalid contact revision';
  end if;
  if not (contacts_patch ? 'website_url') then
    return new;
  end if;

  proposed_website := contacts_patch -> 'website_url';
  if jsonb_typeof(proposed_website) = 'null' then
    return new;
  end if;
  if jsonb_typeof(proposed_website) <> 'string' then
    raise exception using errcode = '22023', message = 'Invalid public website';
  end if;

  proposed_value := nullif(btrim(contacts_patch ->> 'website_url'), '');
  if proposed_value is not null
    and not private.public_https_url_is_safe(proposed_value, 2048)
  then
    raise exception using errcode = '22023', message = 'Invalid public website';
  end if;
  return new;
end;
$$;

drop trigger if exists business_revision_public_links_guard
  on private.business_revision_requests;
create trigger business_revision_public_links_guard
before insert or update of proposed_patch on private.business_revision_requests
for each row execute function private.enforce_business_revision_public_links();

create or replace view public.public_business_contacts
with (security_barrier = true, security_invoker = false)
as
select
  details.business_id,
  case when details.show_phone_public then details.business_phone else null end as phone,
  case
    when details.show_website_public
      and private.public_https_url_is_safe(details.website_url, 2048)
    then details.website_url
    else null
  end as website_url
from public.business_private_details details
where private.is_business_publicly_eligible(details.business_id)
  and (
    (details.show_phone_public and details.business_phone is not null)
    or (
      details.show_website_public
      and private.public_https_url_is_safe(details.website_url, 2048)
    )
  );

create or replace view public.public_profile_directory
with (security_barrier = true, security_invoker = false)
as
select
  profile.public_id,
  profile.username::text as username,
  profile.display_name,
  profile.avatar_path,
  case when review_stats.review_count >= 10 then profile.banner_path else null end as banner_path,
  profile.bio,
  case
    when private.validate_public_profile_links(profile.links) then profile.links
    else '[]'::jsonb
  end as links,
  review_stats.review_count,
  follower_stats.follower_count,
  case when profile.show_following then following_stats.following_count else null end as following_count,
  case when profile.show_favorites then favorite_stats.favorite_count else null end as favorite_count,
  profile.show_following,
  profile.show_favorites,
  exists (
    select 1 from public.profile_follows viewer_follow
    where viewer_follow.follower_id = auth.uid()
      and viewer_follow.followed_id = profile.user_id
  ) as followed_by_viewer,
  profile.created_at
from public.profiles profile
cross join lateral (
  select count(*)::integer as review_count
  from public.reviews review
  where review.author_id = profile.user_id
    and review.moderation = 'approved'
    and review.deleted_at is null
) review_stats
cross join lateral (
  select count(*)::integer as follower_count
  from public.profile_follows follow
  where follow.followed_id = profile.user_id
) follower_stats
cross join lateral (
  select count(*)::integer as following_count
  from public.profile_follows follow
  where follow.follower_id = profile.user_id
) following_stats
cross join lateral (
  select count(*)::integer as favorite_count
  from public.follows follow
  where follow.user_id = profile.user_id
    and private.is_business_publicly_eligible(follow.business_id)
) favorite_stats
where profile.status = 'active'
  and (
    auth.uid() is null
    or auth.uid() = profile.user_id
    or not private.users_are_blocked(auth.uid(), profile.user_id)
  );

revoke all on function private.public_https_url_is_safe(text, integer)
  from public, anon, authenticated, service_role;
revoke all on function private.validate_public_profile_links(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.enforce_business_revision_public_links()
  from public, anon, authenticated, service_role;
