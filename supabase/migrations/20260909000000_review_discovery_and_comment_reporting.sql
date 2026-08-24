-- Evidence-aware review discovery and safety reporting for profile comments.
-- Sponsored placement is deliberately excluded from every organic score.

alter table public.content_reports
  drop constraint if exists content_reports_target_type_check;
alter table public.content_reports
  add constraint content_reports_target_type_check
  check (target_type in ('business', 'review', 'review_comment', 'response', 'update', 'media', 'user'));

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
        select 1 from public.reviews r
        where r.id = new.target_id
          and r.moderation = 'approved'
          and r.deleted_at is null
          and r.author_id <> new.reporter_id
          and private.is_business_publicly_eligible(r.business_id)
      ) into target_exists;
    when 'review_comment' then
      select exists (
        select 1
        from public.review_profile_comments c
        join public.reviews r on r.id = c.review_id
        where c.id = new.target_id
          and c.author_id <> new.reporter_id
          and c.moderation = 'approved'
          and c.deleted_at is null
          and r.moderation = 'approved'
          and r.deleted_at is null
          and private.is_business_publicly_eligible(r.business_id)
          and not private.users_are_blocked(new.reporter_id, c.author_id)
      ) into target_exists;
    when 'response' then
      select exists (
        select 1
        from public.business_responses br
        join public.reviews r on r.id = br.review_id and r.business_id = br.business_id
        where br.review_id = new.target_id
          and br.moderation = 'approved'
          and (br.author_id is null or br.author_id <> new.reporter_id)
          and r.moderation = 'approved'
          and r.deleted_at is null
          and private.is_business_publicly_eligible(br.business_id)
      ) into target_exists;
    when 'update' then
      select exists (
        select 1 from public.business_updates bu
        where bu.id = new.target_id
          and bu.moderation = 'approved'
          and bu.starts_at <= now()
          and bu.expires_at > now()
          and (bu.author_id is null or bu.author_id <> new.reporter_id)
          and private.is_business_publicly_eligible(bu.business_id)
      ) into target_exists;
    when 'media' then
      select exists (
        select 1 from public.media_assets ma
        where ma.id = new.target_id
          and ma.owner_id <> new.reporter_id
          and private.is_media_publicly_eligible(ma.id)
      ) into target_exists;
    when 'user' then
      select exists (
        select 1 from public.profiles p
        where p.user_id = new.target_id
          and p.user_id <> new.reporter_id
          and p.status = 'active'
      ) into target_exists;
  end case;

  if not target_exists then
    raise exception using errcode = '22023', message = 'INVALID_REPORT_TARGET';
  end if;
  return new;
end;
$$;

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
  if target_type not in ('business', 'review', 'review_comment', 'response', 'update', 'media', 'user')
    or report_reason not in ('spam', 'harassment', 'hate', 'sexual', 'violence', 'fraud', 'privacy', 'illegal', 'unsafe', 'other')
    or char_length(coalesce(report_detail, '')) > 2000
    or not private.content_is_professional(report_detail)
  then
    raise exception using errcode = '22023', message = 'Invalid report type or reason';
  end if;

  if target_type = 'user' then
    select p.user_id into resolved_target_id
    from public.profiles p
    where p.public_id = target_id and p.status <> 'deleted' and p.user_id <> actor;
    if resolved_target_id is null then
      raise exception using errcode = '22023', message = 'INVALID_REPORT_TARGET';
    end if;
  end if;

  insert into public.content_reports (reporter_id, target_type, target_id, reason, detail, state)
  values (actor, target_type, resolved_target_id, report_reason, nullif(btrim(report_detail), ''), 'open')
  on conflict (reporter_id, target_type, target_id) do update set
    reason = excluded.reason,
    detail = excluded.detail,
    state = 'open'
  returning id into report_id;

  perform private.write_audit_event(
    actor, null, 'safety.report_submitted', target_type, target_id::text,
    jsonb_build_object('report_id', report_id, 'reason', report_reason)
  );
  return report_id;
end;
$$;

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
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  perform private.require_aal2();
  if not private.is_platform_staff(actor, array['moderator', 'admin']::public.platform_role[]) then
    raise exception using errcode = '42501', message = 'Platform moderation role required';
  end if;

  perform private.write_audit_event(
    actor, null, 'moderation.queue_accessed', 'content', null,
    jsonb_build_object('offset', result_offset, 'limit', result_limit)
  );

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
          'all_media_clean', coalesce(bool_and(
            ma.quarantine_state = 'clean'
            and ma.moderation = 'approved'
            and ma.processed_storage_path is not null
          ), true),
          'assets', coalesce(jsonb_agg(jsonb_build_object(
            'asset_id', ma.id,
            'quarantine_state', ma.quarantine_state,
            'moderation', ma.moderation
          ) order by rm.sort_order, ma.id) filter (where ma.id is not null), '[]'::jsonb)
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
    where r.moderation = 'pending' and r.deleted_at is null

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
        'requested_duration_minutes', greatest(1, floor(extract(epoch from (bu.expires_at - bu.starts_at)) / 60))::integer
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
      jsonb_build_object('review_id', r.id, 'review_rating', r.rating, 'review_excerpt', left(r.body, 240)),
      br.created_at,
      br.updated_at
    from public.business_responses br
    join public.reviews r on r.id = br.review_id and r.business_id = br.business_id
    join public.businesses b on b.id = br.business_id
    left join public.profiles p on p.user_id = br.author_id
    where br.moderation = 'pending' and r.moderation = 'approved' and r.deleted_at is null

    union all

    select
      'review_comment'::text,
      c.id,
      r.business_id,
      b.name,
      p.public_id,
      p.display_name,
      c.body,
      null::smallint,
      jsonb_build_object(
        'review_id', r.id,
        'report_count', count(report.id)::integer,
        'report_reasons', jsonb_agg(distinct report.reason order by report.reason)
      ),
      min(report.created_at),
      c.updated_at
    from public.review_profile_comments c
    join public.reviews r on r.id = c.review_id
    join public.businesses b on b.id = r.business_id
    left join public.profiles p on p.user_id = c.author_id
    join public.content_reports report
      on report.target_type = 'review_comment'
     and report.target_id = c.id
     and report.state in ('open', 'reviewing')
    where c.moderation = 'approved'
      and c.deleted_at is null
      and r.moderation = 'approved'
      and r.deleted_at is null
    group by c.id, r.id, r.business_id, b.name, p.public_id, p.display_name, c.body, c.updated_at
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
    (select count(*) > least(greatest(coalesce(result_limit, 50), 1), 100) from page) as has_more
  from page
  order by page.submitted_at, page.target_type, page.target_id
  limit least(greatest(coalesce(result_limit, 50), 1), 100);
end;
$$;

create or replace function public.decide_reported_review_comment(
  target_comment_id uuid,
  decision text,
  moderation_reason text,
  expected_updated_at timestamptz
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  normalized_reason text := btrim(coalesce(moderation_reason, ''));
  target_business_id uuid;
  current_updated_at timestamptz;
  next_updated_at timestamptz;
begin
  perform private.require_aal2();
  if not private.is_platform_staff(actor, array['moderator', 'admin']::public.platform_role[]) then
    raise exception using errcode = '42501', message = 'Platform moderation role required';
  end if;
  if decision not in ('approved', 'rejected')
    or char_length(normalized_reason) not between 3 and 1000
    or expected_updated_at is null
  then
    raise exception using errcode = '22023', message = 'Invalid moderation decision';
  end if;

  select r.business_id, c.updated_at
  into target_business_id, current_updated_at
  from public.review_profile_comments c
  join public.reviews r on r.id = c.review_id
  where c.id = target_comment_id
    and c.moderation = 'approved'
    and c.deleted_at is null
  for update of c;

  if target_business_id is null then
    raise exception using errcode = '22023', message = 'Moderation target not found';
  end if;
  if current_updated_at is distinct from expected_updated_at then
    raise exception using errcode = '40001', message = 'MODERATION_TARGET_CHANGED';
  end if;
  if not exists (
    select 1 from public.content_reports report
    where report.target_type = 'review_comment'
      and report.target_id = target_comment_id
      and report.state in ('open', 'reviewing')
  ) then
    raise exception using errcode = '40001', message = 'MODERATION_STATE_CHANGED';
  end if;

  perform private.consume_rate_limit(actor, 'content_moderation_decision', 240, 3600);

  if decision = 'rejected' then
    update public.review_profile_comments c
    set moderation = 'removed', updated_at = now()
    where c.id = target_comment_id
    returning c.updated_at into next_updated_at;
  else
    next_updated_at := current_updated_at;
  end if;

  update public.content_reports report
  set state = case when decision = 'rejected' then 'resolved' else 'dismissed' end
  where report.target_type = 'review_comment'
    and report.target_id = target_comment_id
    and report.state in ('open', 'reviewing');

  perform private.write_audit_event(
    actor,
    target_business_id,
    'moderation.reported_comment_decided',
    'review_comment',
    target_comment_id::text,
    jsonb_build_object('decision', decision, 'reason', normalized_reason, 'expected_updated_at', expected_updated_at)
  );
  return next_updated_at;
end;
$$;

-- Append evidence-only ordering fields to the stable public review projection.
-- Badge influence is deliberately capped, while negative reactions can offset
-- positive ones. Ratings are excluded so Top does not mean most flattering.
create or replace view public.public_reviews
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
  r.updated_at,
  least(coalesce(badge_stats.badge_count, 0), 5)::integer as author_badge_count,
  coalesce(reaction_stats.down_count, 0)::integer as not_helpful_count,
  (
    greatest(r.helpful_count, 0) * 4
    - least(coalesce(reaction_stats.down_count, 0), 100) * 2
    + least(coalesce(badge_stats.badge_count, 0), 5) * 3
  )::integer as top_score
from public.reviews r
join public.profiles p on p.user_id = r.author_id and p.status = 'active'
left join lateral (
  select count(*)::integer as badge_count
  from public.profile_badge_awards award
  join public.badge_definitions definition on definition.code = award.badge_code
  where award.user_id = r.author_id
    and award.revoked_at is null
    and (award.expires_at is null or award.expires_at > now())
    and definition.audience = 'reviewer'
) badge_stats on true
left join lateral (
  select count(*) filter (where rr.reaction = -1)::integer as down_count
  from public.review_reactions rr
  join public.profiles reactor on reactor.user_id = rr.user_id and reactor.status = 'active'
  where rr.review_id = r.id
) reaction_stats on true
where r.moderation = 'approved'
  and r.deleted_at is null
  and private.is_business_publicly_eligible(r.business_id)
  and (auth.uid() is null or not private.users_are_blocked(auth.uid(), r.author_id));

revoke all on function private.validate_report_target() from public, anon, authenticated, service_role;
revoke all on function public.submit_content_report(text, uuid, text, text) from public;
grant execute on function public.submit_content_report(text, uuid, text, text) to authenticated;
revoke all on function public.list_pending_content_moderation(integer, integer) from public;
grant execute on function public.list_pending_content_moderation(integer, integer) to authenticated;
revoke all on function public.decide_reported_review_comment(uuid, text, text, timestamptz) from public;
grant execute on function public.decide_reported_review_comment(uuid, text, text, timestamptz) to authenticated;
revoke all on public.public_reviews from public, anon, authenticated;
grant select on public.public_reviews to anon, authenticated;
