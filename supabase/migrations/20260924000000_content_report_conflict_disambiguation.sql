-- Keep report upserts valid under PL/pgSQL variable-conflict checking.
-- `target_type` is both a public parameter and a table column, so the named
-- unique constraint is the only unambiguous conflict target.

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
  on conflict on constraint content_reports_reporter_id_target_type_target_id_key
  do update set
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

revoke all on function public.submit_content_report(text, uuid, text, text) from public;
grant execute on function public.submit_content_report(text, uuid, text, text) to authenticated;
