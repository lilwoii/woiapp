-- A verified ownership claim must never double as an implicit invitation
-- acceptance or role transfer. Active and invited memberships require their
-- dedicated team/transfer workflows; only a revoked historical membership may
-- be restored by a future verified claim approval.
create or replace function private.reject_business_claim_membership_escalation()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.business_id is distinct from old.business_id
      or new.claimant_id is distinct from old.claimant_id
      or new.method is distinct from old.method
      or new.created_at is distinct from old.created_at
    then
      raise exception using
        errcode = '55000',
        message = 'CLAIM_IDENTITY_IMMUTABLE';
    end if;
  end if;
  if new.state <> 'approved' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.state = 'approved' then
    return new;
  end if;
  if exists (
      select 1
      from public.business_members membership
      where membership.business_id = new.business_id
        and membership.user_id = new.claimant_id
        and membership.status in ('active', 'invited')
    ) then
    raise exception using
      errcode = '55000',
      message = 'CLAIMANT_ALREADY_BUSINESS_MEMBER';
  end if;
  return new;
end;
$$;

revoke all on function private.reject_business_claim_membership_escalation()
  from public, anon, authenticated, service_role;

drop trigger if exists business_claim_membership_escalation_guard
  on public.business_claims;
create trigger business_claim_membership_escalation_guard
before insert or update of id, business_id, claimant_id, method, state, created_at
on public.business_claims
for each row execute function private.reject_business_claim_membership_escalation();

-- Close the inverse race as well: a pending claimant cannot accept or acquire
-- a team membership while the ownership-review transaction is unresolved.
-- Supported team and claim paths both lock the business first, so these two
-- transition guards observe a serialized authority decision.
create or replace function private.reject_membership_with_pending_claim()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if new.status not in ('active', 'invited') then
    return new;
  end if;
  if exists (
      select 1
      from public.business_claims claim
      where claim.business_id = new.business_id
        and claim.claimant_id = new.user_id
        and claim.state = 'pending'
    ) then
    raise exception using
      errcode = '55000',
      message = 'BUSINESS_CLAIM_PENDING_FOR_MEMBER';
  end if;
  return new;
end;
$$;

revoke all on function private.reject_membership_with_pending_claim()
  from public, anon, authenticated, service_role;

drop trigger if exists business_membership_pending_claim_guard
  on public.business_members;
create trigger business_membership_pending_claim_guard
before insert or update of business_id, user_id, status on public.business_members
for each row execute function private.reject_membership_with_pending_claim();
