-- Provider source truth must control public visibility. Missing, stale,
-- inactive, disabled, and unlicensed sources are hidden immediately; a
-- bounded service-only worker advances retention state and archives only
-- unclaimed provider-owned listings after every source grace period expires.
create or replace function private.is_business_publicly_eligible(target_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.businesses b
    where b.id = target_business_id
      and b.state = 'published'
      and (
        b.provenance <> 'licensed_provider'
        or exists (
          select 1
          from private.provider_business_sources source
          join private.provider_accounts account
            on account.provider_slug = source.provider_slug
          where source.business_id = b.id
            and source.source_status = 'active'
            and account.enabled
            and current_date between account.license_effective_on
              and account.license_expires_on
        )
      )
      and (
        b.kind <> 'home_kitchen'
        or (
          b.verification = 'verified'
          and exists (
            select 1
            from public.jurisdictions j
            join public.home_kitchen_permits hp
              on hp.jurisdiction_id = j.id
             and hp.business_id = b.id
            where j.id = b.jurisdiction_id
              and j.home_kitchens_enabled
              and j.legal_reviewed_at is not null
              and hp.verification = 'verified'
              and hp.expires_on >= current_date
          )
        )
      )
  );
$$;

revoke all on function private.is_business_publicly_eligible(uuid)
  from public, anon, authenticated;
grant execute on function private.is_business_publicly_eligible(uuid)
  to anon, authenticated;

create or replace function public.reconcile_licensed_provider_lifecycle(
  result_limit integer default 500
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  bounded_limit integer := greatest(1, least(coalesce(result_limit, 500), 2000));
  now_value timestamptz := pg_catalog.clock_timestamp();
  stale_marked integer := 0;
  archived_count integer := 0;
  backlog boolean := false;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('spottr:provider-lifecycle', 0)
  ) then
    return pg_catalog.jsonb_build_object(
      'sources_marked_stale', 0,
      'businesses_archived', 0,
      'more_work', true,
      'skipped', true
    );
  end if;

  with targets as materialized (
    select source.provider_slug, source.provider_external_id
    from private.provider_business_sources source
    join private.provider_accounts account
      on account.provider_slug = source.provider_slug
    where (
      source.source_status = 'missing'
      and source.missing_since <= now_value - account.stale_after
    ) or (
      source.source_status = 'active'
      and (
        not account.enabled
        or current_date not between account.license_effective_on
          and account.license_expires_on
      )
    )
    order by
      coalesce(source.missing_since, source.last_seen_at),
      source.provider_slug,
      source.provider_external_id
    limit bounded_limit
    for update of source skip locked
  ), updated as (
    update private.provider_business_sources source
    set source_status = 'stale',
        missing_since = coalesce(source.missing_since, now_value),
        inactive_at = null,
        inactive_reason = null
    from targets
    where source.provider_slug = targets.provider_slug
      and source.provider_external_id = targets.provider_external_id
    returning source.provider_slug
  ), audited as (
    insert into private.provider_ingest_audit_events (
      provider_slug,
      event_type,
      metadata
    )
    select
      updated.provider_slug,
      'sources_marked_stale',
      pg_catalog.jsonb_build_object('count', count(*)::integer)
    from updated
    group by updated.provider_slug
    returning 1
  )
  select count(*)::integer into stale_marked from updated;

  with targets as materialized (
    select business.id
    from public.businesses business
    where business.state = 'published'
      and business.provenance = 'licensed_provider'
      and exists (
        select 1
        from private.provider_business_sources source
        where source.business_id = business.id
      )
      and not exists (
        select 1
        from public.business_members member
        where member.business_id = business.id
          and member.status = 'active'
      )
      and not exists (
        select 1
        from public.business_claims claim
        where claim.business_id = business.id
          and claim.state = 'approved'
      )
      and not exists (
        select 1
        from private.provider_business_sources source
        join private.provider_accounts account
          on account.provider_slug = source.provider_slug
        where source.business_id = business.id
          and (
            source.source_status = 'active'
            or (
              source.source_status in ('missing', 'stale')
              and source.missing_since > now_value - account.archive_after
            )
            or (
              source.source_status = 'inactive'
              and source.inactive_at > now_value - account.archive_after
            )
          )
      )
    order by business.updated_at, business.id
    limit bounded_limit
    for update of business skip locked
  ), archived as (
    update public.businesses business
    set state = 'archived'
    from targets
    where business.id = targets.id
    returning business.id
  ), audited as (
    insert into private.provider_ingest_audit_events (
      provider_slug,
      event_type,
      metadata
    )
    select
      null,
      'businesses_archived',
      pg_catalog.jsonb_build_object('count', count(*)::integer)
    from archived
    having count(*) > 0
    returning 1
  )
  select count(*)::integer into archived_count from archived;

  select exists (
    select 1
    from private.provider_business_sources source
    join private.provider_accounts account
      on account.provider_slug = source.provider_slug
    where (
      source.source_status = 'missing'
      and source.missing_since <= now_value - account.stale_after
    ) or (
      source.source_status = 'active'
      and (
        not account.enabled
        or current_date not between account.license_effective_on
          and account.license_expires_on
      )
    )
  ) or exists (
    select 1
    from public.businesses business
    where business.state = 'published'
      and business.provenance = 'licensed_provider'
      and exists (
        select 1
        from private.provider_business_sources source
        where source.business_id = business.id
      )
      and not exists (
        select 1 from public.business_members member
        where member.business_id = business.id and member.status = 'active'
      )
      and not exists (
        select 1 from public.business_claims claim
        where claim.business_id = business.id and claim.state = 'approved'
      )
      and not exists (
        select 1
        from private.provider_business_sources source
        join private.provider_accounts account
          on account.provider_slug = source.provider_slug
        where source.business_id = business.id
          and (
            source.source_status = 'active'
            or (
              source.source_status in ('missing', 'stale')
              and source.missing_since > now_value - account.archive_after
            )
            or (
              source.source_status = 'inactive'
              and source.inactive_at > now_value - account.archive_after
            )
          )
      )
  ) into backlog;

  return pg_catalog.jsonb_build_object(
    'sources_marked_stale', stale_marked,
    'businesses_archived', archived_count,
    'more_work', backlog,
    'skipped', false
  );
end;
$$;

revoke all on function public.reconcile_licensed_provider_lifecycle(integer)
  from public, anon, authenticated;
grant execute on function public.reconcile_licensed_provider_lifecycle(integer)
  to service_role;
