-- PostgreSQL treats `null not in (...)` as unknown, not true. Keep the
-- established moderation cores intact, but place strict null-safe public
-- boundaries in front of them so every report decision is explicit.
alter function public.decide_reported_review_comment(uuid, text, text, timestamptz)
  rename to decide_reported_review_comment_null_safe_core;
alter function public.decide_reported_review_comment_null_safe_core(uuid, text, text, timestamptz)
  set schema private;

alter function public.decide_reported_review(uuid, text, text, timestamptz)
  rename to decide_reported_review_null_safe_core;
alter function public.decide_reported_review_null_safe_core(uuid, text, text, timestamptz)
  set schema private;

alter function public.decide_reported_business_post(uuid, text, text, timestamptz)
  rename to decide_reported_business_post_null_safe_core;
alter function public.decide_reported_business_post_null_safe_core(uuid, text, text, timestamptz)
  set schema private;

revoke all on function private.decide_reported_business_post_null_safe_core(
  uuid, text, text, timestamptz
) from public, anon, authenticated, service_role;

revoke all on function private.decide_reported_review_comment_null_safe_core(
  uuid, text, text, timestamptz
) from public, anon, authenticated, service_role;
revoke all on function private.decide_reported_review_null_safe_core(
  uuid, text, text, timestamptz
) from public, anon, authenticated, service_role;

create function public.decide_reported_review_comment(
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
begin
  perform private.require_aal2();
  if not private.is_platform_staff(
    auth.uid(),
    array['moderator', 'admin']::public.platform_role[]
  ) then
    raise exception using
      errcode = '42501',
      message = 'Platform moderation role required';
  end if;
  if decision is null then
    raise exception using
      errcode = '22023',
      message = 'Invalid moderation decision';
  end if;

  return private.decide_reported_review_comment_null_safe_core(
    target_comment_id,
    decision,
    moderation_reason,
    expected_updated_at
  );
end;
$$;

create function public.decide_reported_review(
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
begin
  perform private.require_aal2();
  if not private.is_platform_staff(
    auth.uid(),
    array['moderator', 'admin']::public.platform_role[]
  ) then
    raise exception using
      errcode = '42501',
      message = 'Platform moderation role required';
  end if;
  if decision is null then
    raise exception using
      errcode = '22023',
      message = 'Invalid moderation decision';
  end if;

  return private.decide_reported_review_null_safe_core(
    target_review_id,
    decision,
    moderation_reason,
    expected_updated_at
  );
end;
$$;

create function public.decide_reported_business_post(
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
begin
  perform private.require_aal2();
  if not private.is_platform_staff(
    auth.uid(),
    array['moderator', 'admin']::public.platform_role[]
  ) then
    raise exception using
      errcode = '42501',
      message = 'Platform moderation role required';
  end if;
  if decision is null then
    raise exception using
      errcode = '22023',
      message = 'Invalid moderation decision';
  end if;

  return private.decide_reported_business_post_null_safe_core(
    target_post_id,
    decision,
    moderation_reason,
    expected_updated_at
  );
end;
$$;

revoke all on function public.decide_reported_business_post(
  uuid, text, text, timestamptz
) from public, anon, authenticated, service_role;
revoke all on function public.decide_reported_review_comment(
  uuid, text, text, timestamptz
) from public, anon, authenticated, service_role;
revoke all on function public.decide_reported_review(
  uuid, text, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.decide_reported_business_post(
  uuid, text, text, timestamptz
) to authenticated;
grant execute on function public.decide_reported_review_comment(
  uuid, text, text, timestamptz
) to authenticated;
grant execute on function public.decide_reported_review(
  uuid, text, text, timestamptz
) to authenticated;
