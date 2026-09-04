-- Publication is a trust decision, not merely a completeness check. Enforce
-- the owner-review lifecycle and licensed-source eligibility even for direct
-- privileged writes; the existing publication trigger calls this function.
create or replace function private.enforce_business_publication()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception using errcode = '23514', message = 'Invalid business timezone';
  end if;

  if new.state = 'published'
    and (tg_op = 'INSERT' or old.state <> 'published')
  then
    if new.provenance in ('owner', 'community')
      and (
        tg_op = 'INSERT'
        or old.state not in ('pending', 'suspended')
        or new.verification <> 'verified'
      )
    then
      raise exception using errcode = '55000', message = 'BUSINESS_REVIEW_REQUIRED';
    end if;

    if new.provenance = 'licensed_provider'
      and not exists (
        select 1
        from private.provider_business_sources source
        join private.provider_accounts account
          on account.provider_slug = source.provider_slug
        where source.business_id = new.id
          and source.source_status = 'active'
          and account.enabled
          and current_date between account.license_effective_on
            and account.license_expires_on
      )
    then
      raise exception using errcode = '55000', message = 'LICENSED_SOURCE_NOT_ACTIVE';
    end if;

    perform private.assert_business_publication_ready(new.id);
  end if;

  if new.state = 'published' and new.kind = 'home_kitchen' then
    if new.verification <> 'verified'
      or new.jurisdiction_id is null
      or not exists (
        select 1
        from public.jurisdictions j
        join public.home_kitchen_permits hp
          on hp.jurisdiction_id = j.id
         and hp.business_id = new.id
        where j.id = new.jurisdiction_id
          and j.home_kitchens_enabled
          and j.legal_reviewed_at is not null
          and hp.verification = 'verified'
          and hp.expires_on >= current_date
      )
    then
      raise exception using errcode = '23514', message = 'HOME_KITCHEN_NOT_ELIGIBLE';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_business_publication()
  from public, anon, authenticated;
