-- Notification delivery revalidates public business eligibility immediately
-- before a provider handoff. Serialize that check with provider lifecycle
-- mutations without taking provider rows after business rows, which can form a
-- business -> provider / provider -> business deadlock with ingest.

create or replace function private.lock_notification_business_eligibility(
  target_business_ids uuid[]
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare normalized_ids uuid[];
begin
  select coalesce(array_agg(distinct item.id order by item.id), '{}'::uuid[])
  into normalized_ids
  from unnest(coalesce(target_business_ids, '{}'::uuid[])) item(id)
  where item.id is not null;

  if cardinality(normalized_ids) > 250 then
    raise exception using
      errcode = '22023',
      message = 'Too many notification businesses to lock';
  end if;
  if cardinality(normalized_ids) = 0 then return; end if;

  -- Provider account/source writes take the shared side of this transaction
  -- barrier through statement triggers. Take the exclusive side before any
  -- business row lock so provider ingest, reconciliation, claim review, and
  -- notification dispatch all have one acyclic order.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('spottr:provider-lifecycle', 0)
  );

  perform business.id
  from public.businesses business
  where business.id = any(normalized_ids)
  order by business.id
  for share of business;

  -- Home-kitchen publication is still fail-closed. These rows are locked only
  -- after the business rows and are never used to expose a private address.
  perform jurisdiction.id
  from public.jurisdictions jurisdiction
  where exists (
    select 1
    from public.businesses business
    where business.id = any(normalized_ids)
      and business.jurisdiction_id = jurisdiction.id
  )
  order by jurisdiction.id
  for share of jurisdiction;

  perform permit.business_id
  from public.home_kitchen_permits permit
  where permit.business_id = any(normalized_ids)
  order by permit.business_id
  for share of permit;
end;
$$;

revoke all on function private.lock_notification_business_eligibility(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function private.lock_notification_business_eligibility(uuid[])
  to service_role;
