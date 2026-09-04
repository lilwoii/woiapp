-- Business-claim approval must not observe licensed-provider eligibility while
-- an ingest, account change, or lifecycle reconciliation is changing the
-- provider rows that define that eligibility. Provider mutations take the
-- shared side of one transaction-level barrier; the rare administrator claim
-- decision takes the exclusive side before it locks the business and claim.

create or replace function private.acquire_provider_mutation_barrier()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('spottr:provider-lifecycle', 0)
  );
  return null;
end;
$$;

revoke all on function private.acquire_provider_mutation_barrier()
  from public, anon, authenticated, service_role;

drop trigger if exists provider_accounts_mutation_barrier
  on private.provider_accounts;
create trigger provider_accounts_mutation_barrier
before insert or update or delete on private.provider_accounts
for each statement execute function private.acquire_provider_mutation_barrier();

drop trigger if exists provider_sources_mutation_barrier
  on private.provider_business_sources;
create trigger provider_sources_mutation_barrier
before insert or update or delete on private.provider_business_sources
for each statement execute function private.acquire_provider_mutation_barrier();

-- Ingest locks its provider account before this first write. Reconciliation
-- and claim review never take an account row lock, so acquiring the shared
-- barrier here preserves the existing ingest order without creating a cycle.
drop trigger if exists provider_ingest_mutation_barrier
  on private.provider_rate_limit_buckets;
create trigger provider_ingest_mutation_barrier
before insert on private.provider_rate_limit_buckets
for each statement execute function private.acquire_provider_mutation_barrier();

-- Keep the reviewed decision implementation private and unreachable through
-- PostgREST. The public wrapper owns the global provider barrier and then calls
-- the unchanged business -> claim -> claimant-profile implementation.
alter function public.review_business_claim(uuid, text, text)
  rename to review_business_claim_provider_serialized_core;
alter function public.review_business_claim_provider_serialized_core(uuid, text, text)
  set schema private;

revoke all on function private.review_business_claim_provider_serialized_core(uuid, text, text)
  from public, anon, authenticated, service_role;

create function public.review_business_claim(
  target_claim_id uuid,
  decision text,
  moderation_reason text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  -- Reject untrusted callers before they can acquire the provider-wide lock.
  perform private.require_aal2();
  if not private.is_platform_staff(
    actor,
    array['admin']::public.platform_role[]
  ) then
    raise exception using
      errcode = '42501',
      message = 'Platform administrator role required';
  end if;

  if decision = 'approved' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('spottr:provider-lifecycle', 0)
    );
  end if;
  perform private.review_business_claim_provider_serialized_core(
    target_claim_id,
    decision,
    moderation_reason
  );
end;
$$;

revoke all on function public.review_business_claim(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.review_business_claim(uuid, text, text)
  to authenticated;
