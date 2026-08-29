-- Business-claim recovery is an account authority boundary. Preserve terminal
-- decision history, enforce one live claim/owner transition, remove raw client
-- table reads, and expose only narrow account-bound recovery RPCs.

-- Create replacement invariants before dropping the legacy all-state unique
-- constraint. The approved index intentionally fails migration replay if
-- legacy data contains multiple approved claims for one business; that state
-- requires an explicit ownership incident review rather than automatic repair.
create unique index business_claims_one_pending_per_claimant_business_idx
  on public.business_claims (business_id, claimant_id)
  where state = 'pending';

create unique index business_claims_one_approved_per_business_idx
  on public.business_claims (business_id)
  where state = 'approved';

alter table public.business_claims
  drop constraint business_claims_business_id_claimant_id_state_key;

-- Claims are no longer readable through PostgREST base-table access. Service
-- role and database-owner maintenance privileges are deliberately untouched.
revoke select on table public.business_claims from public, anon, authenticated;

create or replace function public.list_my_business_claims(
  target_claim_id uuid default null,
  result_limit integer default 100
)
returns table (
  id uuid,
  business_id uuid,
  business_name text,
  method text,
  state text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  perform private.require_aal2();
  if actor is null or not private.is_active_user(actor) then
    raise exception using
      errcode = '42501',
      message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  if result_limit is null or result_limit not between 1 and 100 then
    raise exception using
      errcode = '22023',
      message = 'INVALID_CLAIM_RESULT_LIMIT';
  end if;

  return query
  select
    claim.id,
    claim.business_id,
    business.name,
    claim.method,
    claim.state,
    claim.created_at
  from public.business_claims claim
  join public.businesses business on business.id = claim.business_id
  where claim.claimant_id = actor
    and (target_claim_id is null or claim.id = target_claim_id)
  order by claim.created_at desc, claim.id desc
  limit result_limit;
end;
$$;

revoke all on function public.list_my_business_claims(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.list_my_business_claims(uuid, integer)
  to authenticated;

create or replace function public.withdraw_own_business_claim(
  target_claim_id uuid
)
returns table (
  claim_id uuid,
  state text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_business_id uuid;
  target_state text;
begin
  perform private.require_aal2();
  if actor is null or not private.is_active_user(actor) then
    raise exception using
      errcode = '42501',
      message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  if target_claim_id is null then
    raise exception using
      errcode = '22023',
      message = 'INVALID_CLAIM_ID';
  end if;

  -- Resolve without a row lock, then follow the global authority lock order:
  -- business -> claim. The audit insert references the business row, and claim
  -- review already uses this order, so claim-first withdrawal could deadlock.
  select claim.business_id
  into target_business_id
  from public.business_claims claim
  where claim.id = target_claim_id
    and claim.claimant_id = actor;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'CLAIM_NOT_FOUND';
  end if;

  perform 1
  from public.businesses business
  where business.id = target_business_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'CLAIM_NOT_FOUND';
  end if;

  select claim.state
  into target_state
  from public.business_claims claim
  where claim.id = target_claim_id
    and claim.business_id = target_business_id
    and claim.claimant_id = actor
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'CLAIM_NOT_FOUND';
  end if;

  -- Replays after a committed withdrawal are successful no-ops and do not
  -- create duplicate audit records.
  if target_state = 'withdrawn' then
    return query select target_claim_id, 'withdrawn'::text;
    return;
  end if;

  if target_state <> 'pending' then
    raise exception using
      errcode = '55000',
      message = 'CLAIM_NOT_WITHDRAWABLE';
  end if;

  update public.business_claims claim
  set state = 'withdrawn'
  where claim.id = target_claim_id
    and claim.claimant_id = actor
    and claim.state = 'pending';

  if not found then
    raise exception using
      errcode = '55000',
      message = 'CLAIM_STATE_CHANGED';
  end if;

  perform private.write_audit_event(
    actor,
    target_business_id,
    'business.claim_withdrawn',
    'business_claim',
    target_claim_id::text,
    '{}'::jsonb
  );

  return query select target_claim_id, 'withdrawn'::text;
end;
$$;

revoke all on function public.withdraw_own_business_claim(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.withdraw_own_business_claim(uuid)
  to authenticated;

-- Retain the legacy signature for controlled internal compatibility, but route
-- it through the same lock order. It is intentionally no longer executable by
-- authenticated clients; current clients use withdraw_own_business_claim().
create or replace function public.withdraw_business_claim(target_claim_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform 1
  from public.withdraw_own_business_claim(target_claim_id);
end;
$$;

revoke all on function public.withdraw_business_claim(uuid)
  from public, anon, authenticated, service_role;
