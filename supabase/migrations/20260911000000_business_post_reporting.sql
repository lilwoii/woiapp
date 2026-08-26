-- Confidential reports and audited moderation for individual business posts.

alter table public.content_reports
  drop constraint if exists content_reports_target_type_check;
alter table public.content_reports
  add constraint content_reports_target_type_check
  check (target_type in ('business', 'business_post', 'review', 'review_comment', 'response', 'update', 'media', 'user'));

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
    when 'business_post' then
      select exists (
        select 1
        from public.business_posts post
        where post.id = new.target_id
          and post.deleted_at is null
          and (post.author_id is null or post.author_id <> new.reporter_id)
          and not private.is_business_member(post.business_id, new.reporter_id)
          and private.is_business_publicly_eligible(post.business_id)
      ) into target_exists;
    when 'review' then
      select exists (
        select 1 from public.reviews r
        where r.id = new.target_id and r.moderation = 'approved' and r.deleted_at is null
          and r.author_id <> new.reporter_id and private.is_business_publicly_eligible(r.business_id)
      ) into target_exists;
    when 'review_comment' then
      select exists (
        select 1 from public.review_profile_comments c
        join public.reviews r on r.id = c.review_id
        where c.id = new.target_id and c.author_id <> new.reporter_id
          and c.moderation = 'approved' and c.deleted_at is null
          and r.moderation = 'approved' and r.deleted_at is null
          and private.is_business_publicly_eligible(r.business_id)
          and not private.users_are_blocked(new.reporter_id, c.author_id)
      ) into target_exists;
    when 'response' then
      select exists (
        select 1 from public.business_responses br
        join public.reviews r on r.id = br.review_id and r.business_id = br.business_id
        where br.review_id = new.target_id and br.moderation = 'approved'
          and (br.author_id is null or br.author_id <> new.reporter_id)
          and r.moderation = 'approved' and r.deleted_at is null
          and private.is_business_publicly_eligible(br.business_id)
      ) into target_exists;
    when 'update' then
      select exists (
        select 1 from public.business_updates bu
        where bu.id = new.target_id and bu.moderation = 'approved'
          and bu.starts_at <= now() and bu.expires_at > now()
          and (bu.author_id is null or bu.author_id <> new.reporter_id)
          and private.is_business_publicly_eligible(bu.business_id)
      ) into target_exists;
    when 'media' then
      select exists (
        select 1 from public.media_assets ma
        where ma.id = new.target_id and ma.owner_id <> new.reporter_id
          and private.is_media_publicly_eligible(ma.id)
      ) into target_exists;
    when 'user' then
      select exists (
        select 1 from public.profiles p
        where p.user_id = new.target_id and p.user_id <> new.reporter_id and p.status = 'active'
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
  if target_type not in ('business', 'business_post', 'review', 'review_comment', 'response', 'update', 'media', 'user')
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

  perform private.consume_rate_limit(actor, 'content_report_hour', 30, 3600);
  insert into public.content_reports (reporter_id, target_type, target_id, reason, detail, state)
  values (actor, target_type, resolved_target_id, report_reason, nullif(btrim(report_detail), ''), 'open')
  on conflict (reporter_id, target_type, target_id) do update set
    reason = excluded.reason, detail = excluded.detail, state = 'open'
  returning id into report_id;

  perform private.write_audit_event(
    actor, null, 'safety.report_submitted', target_type, target_id::text,
    jsonb_build_object('report_id', report_id, 'reason', report_reason)
  );
  return report_id;
end;
$$;

create or replace function public.decide_reported_business_post(
  target_post_id uuid,
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

  select post.business_id, post.updated_at into target_business_id, current_updated_at
  from public.business_posts post
  where post.id = target_post_id and post.deleted_at is null
  for update of post;

  if target_business_id is null then
    raise exception using errcode = '22023', message = 'Moderation target not found';
  end if;
  if current_updated_at is distinct from expected_updated_at then
    raise exception using errcode = '40001', message = 'MODERATION_TARGET_CHANGED';
  end if;
  if not exists (
    select 1 from public.content_reports report
    where report.target_type = 'business_post' and report.target_id = target_post_id
      and report.state in ('open', 'reviewing')
  ) then
    raise exception using errcode = '40001', message = 'MODERATION_STATE_CHANGED';
  end if;

  perform private.consume_rate_limit(actor, 'content_moderation_decision', 240, 3600);
  if decision = 'rejected' then
    update public.business_posts post
    set deleted_at = now(), updated_at = now()
    where post.id = target_post_id
    returning post.updated_at into next_updated_at;
  else
    next_updated_at := current_updated_at;
  end if;

  update public.content_reports report
  set state = case when decision = 'rejected' then 'resolved' else 'dismissed' end
  where report.target_type = 'business_post' and report.target_id = target_post_id
    and report.state in ('open', 'reviewing');

  perform private.write_audit_event(
    actor, target_business_id, 'moderation.reported_business_post_decided', 'business_post', target_post_id::text,
    jsonb_build_object('decision', decision, 'reason', normalized_reason, 'expected_updated_at', expected_updated_at)
  );
  return next_updated_at;
end;
$$;

-- Keep the established moderation queue stable and append reported posts.
create or replace function public.list_reported_business_posts(
  result_limit integer default 50,
  result_offset integer default 0
)
returns table (
  target_type text, target_id uuid, business_id uuid, business_name text,
  author_public_id uuid, author_display_name text, body text, rating smallint,
  context jsonb, submitted_at timestamptz, updated_at timestamptz, has_more boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare actor uuid := auth.uid();
begin
  perform private.require_aal2();
  if not private.is_platform_staff(actor, array['moderator', 'admin']::public.platform_role[]) then
    raise exception using errcode = '42501', message = 'Platform moderation role required';
  end if;
  perform private.write_audit_event(actor, null, 'moderation.queue_accessed', 'business_post', null,
    jsonb_build_object('offset', result_offset, 'limit', result_limit));

  return query
  with pending as (
    select
      'business_post'::text as target_type, post.id as target_id, post.business_id,
      business.name as business_name, profile.public_id as author_public_id,
      profile.display_name as author_display_name, coalesce(post.body, '[Photo post]') as body,
      null::smallint as rating,
      jsonb_build_object(
        'report_count', count(report.id)::integer,
        'report_reasons', jsonb_agg(distinct report.reason order by report.reason),
        'media_count', (select count(*)::integer from public.business_post_media media where media.post_id = post.id)
      ) as context,
      min(report.created_at) as submitted_at, post.updated_at
    from public.business_posts post
    join public.businesses business on business.id = post.business_id
    left join public.profiles profile on profile.user_id = post.author_id
    join public.content_reports report on report.target_type = 'business_post'
      and report.target_id = post.id and report.state in ('open', 'reviewing')
    where post.deleted_at is null
    group by post.id, post.business_id, business.name, profile.public_id, profile.display_name, post.body, post.updated_at
  ), page as materialized (
    select pending.* from pending
    order by pending.submitted_at, pending.target_id
    offset least(greatest(coalesce(result_offset, 0), 0), 10000)
    limit least(greatest(coalesce(result_limit, 50), 1), 100) + 1
  )
  select page.target_type, page.target_id, page.business_id, page.business_name,
    page.author_public_id, page.author_display_name, page.body, page.rating, page.context,
    page.submitted_at, page.updated_at,
    (select count(*) > least(greatest(coalesce(result_limit, 50), 1), 100) from page) as has_more
  from page order by page.submitted_at, page.target_id
  limit least(greatest(coalesce(result_limit, 50), 1), 100);
end;
$$;

revoke all on function private.validate_report_target() from public, anon, authenticated, service_role;
revoke all on function public.submit_content_report(text, uuid, text, text) from public;
grant execute on function public.submit_content_report(text, uuid, text, text) to authenticated;
revoke all on function public.decide_reported_business_post(uuid, text, text, timestamptz) from public;
grant execute on function public.decide_reported_business_post(uuid, text, text, timestamptz) to authenticated;
revoke all on function public.list_reported_business_posts(integer, integer) from public;
grant execute on function public.list_reported_business_posts(integer, integer) to authenticated;
