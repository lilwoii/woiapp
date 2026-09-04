-- Surface reports against already-approved reviews in the protected moderation
-- queue and give staff a concurrency-safe keep/remove decision path.

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
      'review'::text,
      r.id,
      r.business_id,
      b.name,
      p.public_id,
      p.display_name,
      r.body,
      r.rating,
      coalesce(media.context, jsonb_build_object(
        'media_count', 0,
        'all_media_clean', true,
        'assets', '[]'::jsonb
      )) || jsonb_build_object(
        'reported', true,
        'report_count', report_stats.report_count,
        'report_reasons', report_stats.report_reasons
      ),
      report_stats.first_reported_at,
      r.updated_at
    from public.reviews r
    join public.businesses b on b.id = r.business_id
    left join public.profiles p on p.user_id = r.author_id
    join lateral (
      select
        count(*)::integer as report_count,
        jsonb_agg(distinct report.reason order by report.reason) as report_reasons,
        min(report.created_at) as first_reported_at
      from public.content_reports report
      where report.target_type = 'review'
        and report.target_id = r.id
        and report.state in ('open', 'reviewing')
    ) report_stats on report_stats.report_count > 0
    left join lateral (
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
      ) as context
      from public.review_media rm
      join public.media_assets ma on ma.id = rm.asset_id
      where rm.review_id = r.id
    ) media on true
    where r.moderation = 'approved' and r.deleted_at is null

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

create or replace function public.decide_reported_review(
  target_review_id uuid,
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

  select review.business_id, review.updated_at
  into target_business_id, current_updated_at
  from public.reviews review
  where review.id = target_review_id
    and review.moderation = 'approved'
    and review.deleted_at is null
  for update of review;

  if target_business_id is null then
    raise exception using errcode = '22023', message = 'Moderation target not found';
  end if;
  if current_updated_at is distinct from expected_updated_at then
    raise exception using errcode = '40001', message = 'MODERATION_TARGET_CHANGED';
  end if;
  if not exists (
    select 1 from public.content_reports report
    where report.target_type = 'review'
      and report.target_id = target_review_id
      and report.state in ('open', 'reviewing')
  ) then
    raise exception using errcode = '40001', message = 'MODERATION_STATE_CHANGED';
  end if;

  perform private.consume_rate_limit(actor, 'content_moderation_decision', 240, 3600);

  if decision = 'rejected' then
    update public.reviews review
    set moderation = 'removed', updated_at = now()
    where review.id = target_review_id
    returning review.updated_at into next_updated_at;
  else
    next_updated_at := current_updated_at;
  end if;

  update public.content_reports report
  set state = case when decision = 'rejected' then 'resolved' else 'dismissed' end
  where report.target_type = 'review'
    and report.target_id = target_review_id
    and report.state in ('open', 'reviewing');

  perform private.write_audit_event(
    actor,
    target_business_id,
    'moderation.reported_review_decided',
    'review',
    target_review_id::text,
    jsonb_build_object('decision', decision, 'reason', normalized_reason, 'expected_updated_at', expected_updated_at)
  );
  return next_updated_at;
end;
$$;

revoke all on function public.list_pending_content_moderation(integer, integer) from public;
grant execute on function public.list_pending_content_moderation(integer, integer) to authenticated;
revoke all on function public.decide_reported_review(uuid, text, text, timestamptz) from public;
grant execute on function public.decide_reported_review(uuid, text, text, timestamptz) to authenticated;
