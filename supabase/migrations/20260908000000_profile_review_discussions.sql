-- Profile-only review discussions and evidence-backed reactions.
-- Reactions are never paid placement signals. Only unique positive reactions
-- from active, non-blocked accounts contribute to the legacy helpful counter.

create table if not exists public.review_reactions (
  review_id uuid not null references public.reviews(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  reaction smallint not null check (reaction in (-1, 1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (review_id, user_id)
);

create index if not exists review_reactions_user_time_idx
  on public.review_reactions (user_id, updated_at desc);

create table if not exists public.review_profile_comments (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.reviews(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  moderation public.moderation_state not null default 'approved',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint review_profile_comments_body_length
    check (char_length(btrim(body)) between 1 and 500)
);

create index if not exists review_profile_comments_review_time_idx
  on public.review_profile_comments (review_id, created_at asc)
  where deleted_at is null;

create index if not exists review_profile_comments_author_time_idx
  on public.review_profile_comments (author_id, created_at desc)
  where deleted_at is null;

alter table public.review_reactions enable row level security;
alter table public.review_reactions force row level security;
alter table public.review_profile_comments enable row level security;
alter table public.review_profile_comments force row level security;

revoke all on table public.review_reactions from public, anon, authenticated;
revoke all on table public.review_profile_comments from public, anon, authenticated;

-- Permit only a nested, trigger-originated helpful-count refresh to pass the
-- review author guard. Direct client updates still preserve the stored count.
create or replace function private.protect_review_author_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and not private.is_platform_staff(auth.uid()) then
    if pg_trigger_depth() > 1
      and new.id = old.id
      and new.business_id = old.business_id
      and new.author_id = old.author_id
      and new.rating = old.rating
      and new.body = old.body
      and new.moderation = old.moderation
      and new.created_at = old.created_at
      and new.deleted_at is not distinct from old.deleted_at
    then
      return new;
    end if;
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

create or replace function private.sync_review_helpful_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_review_id uuid := coalesce(new.review_id, old.review_id);
begin
  update public.reviews r
  set helpful_count = (
    select count(*)::integer
    from public.review_reactions rr
    join public.profiles p on p.user_id = rr.user_id and p.status = 'active'
    where rr.review_id = target_review_id and rr.reaction = 1
  )
  where r.id = target_review_id;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists review_reactions_sync_helpful on public.review_reactions;
create trigger review_reactions_sync_helpful
after insert or update of reaction or delete on public.review_reactions
for each row execute function private.sync_review_helpful_count();

create or replace function public.set_review_reaction(
  target_review_id uuid,
  next_reaction smallint
)
returns table (
  up_count integer,
  down_count integer,
  viewer_reaction smallint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  review_author uuid;
begin
  perform private.require_aal2();
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;
  if target_review_id is null or next_reaction not in (-1, 0, 1) then
    raise exception using errcode = '22023', message = 'Invalid review reaction';
  end if;

  select r.author_id into review_author
  from public.reviews r
  where r.id = target_review_id
    and r.moderation = 'approved'
    and r.deleted_at is null
    and private.is_business_publicly_eligible(r.business_id)
  for share;

  if review_author is null then
    raise exception using errcode = 'P0002', message = 'Review not found';
  end if;
  if review_author = actor then
    raise exception using errcode = '42501', message = 'You cannot react to your own review';
  end if;
  if private.users_are_blocked(actor, review_author) then
    raise exception using errcode = '42501', message = 'Interaction unavailable';
  end if;

  perform private.consume_rate_limit(actor, 'review_reaction_hour', 120, 3600);

  if next_reaction = 0 then
    delete from public.review_reactions rr
    where rr.review_id = target_review_id and rr.user_id = actor;
  else
    insert into public.review_reactions (review_id, user_id, reaction)
    values (target_review_id, actor, next_reaction)
    on conflict (review_id, user_id) do update
    set reaction = excluded.reaction, updated_at = now()
    where public.review_reactions.reaction is distinct from excluded.reaction;
  end if;

  perform private.write_audit_event(
    actor, null, 'review.reaction_set', 'review', target_review_id,
    jsonb_build_object('reaction', next_reaction)
  );

  return query
  select
    count(*) filter (where rr.reaction = 1)::integer,
    count(*) filter (where rr.reaction = -1)::integer,
    coalesce(max(rr.reaction) filter (where rr.user_id = actor), 0)::smallint
  from public.review_reactions rr
  where rr.review_id = target_review_id;
end;
$$;

create or replace function public.add_review_profile_comment(
  target_review_id uuid,
  comment_body text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  review_author uuid;
  normalized_body text := btrim(regexp_replace(coalesce(comment_body, ''), '[[:space:]]+', ' ', 'g'));
  comment_id uuid;
begin
  perform private.require_aal2();
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;
  if char_length(normalized_body) not between 1 and 500
    or not private.content_is_professional(normalized_body)
  then
    raise exception using errcode = '22023', message = 'Comment must be professional and no more than 500 characters';
  end if;

  select r.author_id into review_author
  from public.reviews r
  where r.id = target_review_id
    and r.moderation = 'approved'
    and r.deleted_at is null
    and private.is_business_publicly_eligible(r.business_id)
  for share;

  if review_author is null then
    raise exception using errcode = 'P0002', message = 'Review not found';
  end if;
  if private.users_are_blocked(actor, review_author) then
    raise exception using errcode = '42501', message = 'Interaction unavailable';
  end if;

  perform private.consume_rate_limit(actor, 'review_profile_comment_hour', 30, 3600);
  perform private.consume_rate_limit(actor, 'review_profile_comment_day', 100, 86400);

  insert into public.review_profile_comments (review_id, author_id, body)
  values (target_review_id, actor, normalized_body)
  returning id into comment_id;

  perform private.write_audit_event(
    actor, null, 'review.profile_comment_created', 'review_comment', comment_id,
    jsonb_build_object('review_id', target_review_id)
  );
  return comment_id;
end;
$$;

create or replace function public.delete_own_review_profile_comment(target_comment_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  changed boolean;
begin
  perform private.require_aal2();
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;
  update public.review_profile_comments c
  set deleted_at = now(), body = '[deleted]', updated_at = now()
  where c.id = target_comment_id and c.author_id = actor and c.deleted_at is null;
  changed := found;
  if changed then
    perform private.write_audit_event(
      actor, null, 'review.profile_comment_deleted', 'review_comment', target_comment_id, '{}'::jsonb
    );
  end if;
  return changed;
end;
$$;

create or replace view public.public_review_reaction_summary
with (security_barrier = true, security_invoker = false)
as
select
  r.id as review_id,
  count(rr.user_id) filter (where rr.reaction = 1)::integer as up_count,
  count(rr.user_id) filter (where rr.reaction = -1)::integer as down_count,
  coalesce(max(rr.reaction) filter (where rr.user_id = auth.uid()), 0)::smallint as viewer_reaction
from public.reviews r
left join public.review_reactions rr on rr.review_id = r.id
where r.moderation = 'approved'
  and r.deleted_at is null
  and private.is_business_publicly_eligible(r.business_id)
  and (
    auth.uid() is null
    or not private.users_are_blocked(auth.uid(), r.author_id)
  )
group by r.id;

create or replace view public.public_profile_review_comments
with (security_barrier = true, security_invoker = false)
as
select
  c.id as comment_id,
  c.review_id,
  review_author.public_id as review_author_public_id,
  commenter.public_id as author_public_id,
  commenter.username::text as author_username,
  commenter.display_name as author_display_name,
  commenter.avatar_path as author_avatar_path,
  c.body,
  c.created_at,
  c.updated_at,
  (c.author_id = auth.uid()) as viewer_can_delete
from public.review_profile_comments c
join public.reviews r on r.id = c.review_id
join public.profiles review_author on review_author.user_id = r.author_id and review_author.status = 'active'
join public.profiles commenter on commenter.user_id = c.author_id and commenter.status = 'active'
where c.moderation = 'approved'
  and c.deleted_at is null
  and r.moderation = 'approved'
  and r.deleted_at is null
  and private.is_business_publicly_eligible(r.business_id)
  and (
    auth.uid() is null
    or (
      not private.users_are_blocked(auth.uid(), r.author_id)
      and not private.users_are_blocked(auth.uid(), c.author_id)
    )
  );

revoke all on function public.set_review_reaction(uuid, smallint) from public;
revoke all on function public.add_review_profile_comment(uuid, text) from public;
revoke all on function public.delete_own_review_profile_comment(uuid) from public;
grant execute on function public.set_review_reaction(uuid, smallint) to authenticated;
grant execute on function public.add_review_profile_comment(uuid, text) to authenticated;
grant execute on function public.delete_own_review_profile_comment(uuid) to authenticated;

revoke all on public.public_review_reaction_summary from public, anon, authenticated;
revoke all on public.public_profile_review_comments from public, anon, authenticated;
grant select on public.public_review_reaction_summary to anon, authenticated;
grant select on public.public_profile_review_comments to anon, authenticated;

revoke all on function private.sync_review_helpful_count() from public, anon, authenticated, service_role;
revoke all on function private.protect_review_author_fields() from public, anon, authenticated, service_role;
