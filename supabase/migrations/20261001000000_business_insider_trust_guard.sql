-- Keep business operators from influencing the trust signals for their own
-- business. Owner responses remain on the separate business_responses path.

create or replace function private.assert_external_review_trust_actor(
  target_business_id uuid,
  target_actor_id uuid default auth.uid()
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if target_actor_id is null then
    return;
  end if;

  if private.is_business_member(target_business_id, target_actor_id) then
    raise exception using
      errcode = '42501',
      message = 'BUSINESS_REVIEW_TRUST_BOUNDARY';
  end if;
end;
$$;

-- The nested helpful-count UPDATE emitted by the reaction trigger is not an
-- author edit. Permit that internal maintenance write, while direct writes
-- by an active business member still fail closed.
create or replace function private.guard_business_insider_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then
    return new;
  end if;

  if tg_op = 'UPDATE'
    and pg_trigger_depth() > 1
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

  -- Moderators may still decide the moderation state of a review. If a
  -- moderator also happens to belong to that business, content/rating edits
  -- remain blocked while moderation-only changes continue to work.
  if tg_op = 'UPDATE'
    and private.is_platform_staff(actor)
    and new.id = old.id
    and new.business_id = old.business_id
    and new.author_id = old.author_id
    and new.rating = old.rating
    and new.body = old.body
    and new.helpful_count = old.helpful_count
    and new.created_at = old.created_at
    and new.deleted_at is not distinct from old.deleted_at
  then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    perform private.assert_external_review_trust_actor(old.business_id, actor);
  end if;
  perform private.assert_external_review_trust_actor(new.business_id, actor);
  return new;
end;
$$;

create or replace function private.guard_business_insider_review_reaction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  old_business_id uuid;
  new_business_id uuid;
begin
  if actor is null then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- A reaction UPDATE can move a row between reviews. Validate both sides;
    -- checking only NEW would let an insider detach an old business signal
    -- through an otherwise external destination review.
    select review.business_id
    into old_business_id
    from public.reviews review
    where review.id = old.review_id;

    select review.business_id
    into new_business_id
    from public.reviews review
    where review.id = new.review_id;

    perform private.assert_external_review_trust_actor(old_business_id, actor);
    if new_business_id is distinct from old_business_id then
      perform private.assert_external_review_trust_actor(new_business_id, actor);
    end if;
  else
    select review.business_id
    into new_business_id
    from public.reviews review
    where review.id = coalesce(new.review_id, old.review_id);
  end if;

  -- Removing one's own pre-existing reaction is a safe cleanup operation;
  -- deleting somebody else's signal remains a business-insider write.
  if tg_op = 'DELETE' and old.user_id = actor then
    return old;
  end if;

  if tg_op <> 'UPDATE' then
    perform private.assert_external_review_trust_actor(new_business_id, actor);
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function private.guard_business_insider_review_comment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_business_id uuid;
begin
  if actor is null then
    return new;
  end if;

  select review.business_id
  into target_business_id
  from public.reviews review
  where review.id = new.review_id;

  perform private.assert_external_review_trust_actor(target_business_id, actor);
  return new;
end;
$$;

-- Reactions are deleted inside the parent review's BEFORE UPDATE trigger when
-- a rating/body revision occurs. The normal AFTER DELETE helpful-count refresh
-- would issue a nested UPDATE against the same review tuple while that parent
-- update is still in flight. A transaction-local marker lets that one refresh
-- return without a nested write; the parent trigger writes zero atomically.
create or replace function private.sync_review_helpful_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_review_id uuid := coalesce(new.review_id, old.review_id);
  revision_marker text := current_setting('spottr.review_revision_reset', true);
begin
  if tg_op = 'DELETE'
    and revision_marker = target_review_id::text
  then
    return old;
  end if;

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

-- A rating/body revision invalidates every prior reaction, including the
-- legacy helpful counter. This runs before the row is written to pending.
create or replace function private.reset_review_trust_signals_on_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_marker text := current_setting('spottr.review_revision_reset', true);
begin
  if new.rating is not distinct from old.rating
    and new.body is not distinct from old.body
  then
    return new;
  end if;

  perform set_config('spottr.review_revision_reset', new.id::text, true);
  begin
    delete from public.review_reactions reaction
    where reaction.review_id = new.id;
  exception when others then
    perform set_config('spottr.review_revision_reset', coalesce(previous_marker, ''), true);
    raise;
  end;
  perform set_config('spottr.review_revision_reset', coalesce(previous_marker, ''), true);
  new.helpful_count := 0;
  return new;
end;
$$;

drop trigger if exists reviews_business_insider_trust_guard on public.reviews;
create trigger reviews_business_insider_trust_guard
before insert or update on public.reviews
for each row execute function private.guard_business_insider_review();

drop trigger if exists review_reactions_business_insider_trust_guard
  on public.review_reactions;
create trigger review_reactions_business_insider_trust_guard
before insert or update or delete on public.review_reactions
for each row execute function private.guard_business_insider_review_reaction();

drop trigger if exists review_profile_comments_business_insider_trust_guard
  on public.review_profile_comments;
create trigger review_profile_comments_business_insider_trust_guard
before insert on public.review_profile_comments
for each row execute function private.guard_business_insider_review_comment();

drop trigger if exists reviews_reset_trust_signals_on_revision on public.reviews;
create trigger reviews_reset_trust_signals_on_revision
before update of rating, body on public.reviews
for each row
when (old.rating is distinct from new.rating or old.body is distinct from new.body)
execute function private.reset_review_trust_signals_on_revision();

-- set_review_reaction has a no-op ON CONFLICT path, so enforce the boundary
-- in the canonical RPC as well as on the underlying table.
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
  review_business_id uuid;
begin
  perform private.require_aal2();
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;
  if target_review_id is null or next_reaction not in (-1, 0, 1) then
    raise exception using errcode = '22023', message = 'Invalid review reaction';
  end if;

  select review.author_id, review.business_id
  into review_author, review_business_id
  from public.reviews review
  where review.id = target_review_id
    and review.moderation = 'approved'
    and review.deleted_at is null
    and private.is_business_publicly_eligible(review.business_id)
  for share;

  if review_author is null then
    raise exception using errcode = 'P0002', message = 'Review not found';
  end if;
  -- Removing a pre-existing reaction remains available after a role change;
  -- only a positive/negative trust signal is forbidden to insiders.
  if next_reaction <> 0 then
    perform private.assert_external_review_trust_actor(review_business_id, actor);
  end if;
  if review_author = actor then
    raise exception using errcode = '42501', message = 'You cannot react to your own review';
  end if;
  if private.users_are_blocked(actor, review_author) then
    raise exception using errcode = '42501', message = 'Interaction unavailable';
  end if;

  perform private.consume_rate_limit(actor, 'review_reaction_hour', 120, 3600);

  if next_reaction = 0 then
    delete from public.review_reactions reaction
    where reaction.review_id = target_review_id and reaction.user_id = actor;
  else
    insert into public.review_reactions (review_id, user_id, reaction)
    values (target_review_id, actor, next_reaction)
    on conflict (review_id, user_id) do update
    set reaction = excluded.reaction, updated_at = now()
    where public.review_reactions.reaction is distinct from excluded.reaction;
  end if;

  perform private.write_audit_event(
    actor, null, 'review.reaction_set', 'review', target_review_id::text,
    jsonb_build_object('reaction', next_reaction)
  );

  return query
  select
    count(*) filter (where reaction.reaction = 1)::integer,
    count(*) filter (where reaction.reaction = -1)::integer,
    coalesce(max(reaction.reaction) filter (where reaction.user_id = actor), 0)::smallint
  from public.review_reactions reaction
  where reaction.review_id = target_review_id;
end;
$$;

-- The profile discussion RPC always inserts a new row, but keep its canonical
-- path explicit so a future trigger/policy change cannot reopen this boundary.
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
  review_business_id uuid;
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

  select review.author_id, review.business_id
  into review_author, review_business_id
  from public.reviews review
  where review.id = target_review_id
    and review.moderation = 'approved'
    and review.deleted_at is null
    and private.is_business_publicly_eligible(review.business_id)
  for share;

  if review_author is null then
    raise exception using errcode = 'P0002', message = 'Review not found';
  end if;
  perform private.assert_external_review_trust_actor(review_business_id, actor);
  if private.users_are_blocked(actor, review_author) then
    raise exception using errcode = '42501', message = 'Interaction unavailable';
  end if;

  perform private.consume_rate_limit(actor, 'review_profile_comment_hour', 30, 3600);
  perform private.consume_rate_limit(actor, 'review_profile_comment_day', 100, 86400);

  insert into public.review_profile_comments (review_id, author_id, body)
  values (target_review_id, actor, normalized_body)
  returning id into comment_id;

  perform private.write_audit_event(
    actor, null, 'review.profile_comment_created', 'review_comment', comment_id::text,
    jsonb_build_object('review_id', target_review_id)
  );
  return comment_id;
end;
$$;

-- Preserve the authenticated cleanup lane while repairing the audit helper's
-- text target contract for the UUID-backed comment identifier.
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

  update public.review_profile_comments comment_row
  set deleted_at = now(), body = '[deleted]', updated_at = now()
  where comment_row.id = target_comment_id
    and comment_row.author_id = actor
    and comment_row.deleted_at is null;
  changed := found;

  if changed then
    perform private.write_audit_event(
      actor,
      null,
      'review.profile_comment_deleted',
      'review_comment',
      target_comment_id::text,
      '{}'::jsonb
    );
  end if;
  return changed;
end;
$$;

revoke all on function private.assert_external_review_trust_actor(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.guard_business_insider_review()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_business_insider_review_reaction()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_business_insider_review_comment()
  from public, anon, authenticated, service_role;
revoke all on function private.reset_review_trust_signals_on_revision()
  from public, anon, authenticated, service_role;
revoke all on function private.sync_review_helpful_count()
  from public, anon, authenticated, service_role;
revoke all on function public.set_review_reaction(uuid, smallint)
  from public, anon, authenticated, service_role;
grant execute on function public.set_review_reaction(uuid, smallint) to authenticated;
revoke all on function public.add_review_profile_comment(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.add_review_profile_comment(uuid, text) to authenticated;
revoke all on function public.delete_own_review_profile_comment(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.delete_own_review_profile_comment(uuid) to authenticated;
