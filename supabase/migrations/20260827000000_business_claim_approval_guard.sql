-- Pending claims created before the submission guard may still exist. Prevent
-- every approval path, including direct privileged writes, from turning those
-- self-asserted records into owner authority. Rejections and withdrawals stay
-- available so unsafe legacy claims can be cleared.
create or replace function private.require_business_claim_verification_receipt()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if new.state = 'approved' then
    raise exception using
      errcode = '55000',
      message = 'CLAIM_VERIFICATION_RECEIPT_REQUIRED';
  end if;
  return new;
end;
$$;

revoke all on function private.require_business_claim_verification_receipt()
  from public, anon, authenticated;

drop trigger if exists require_business_claim_verification_receipt
  on public.business_claims;
create trigger require_business_claim_verification_receipt
before insert or update of state on public.business_claims
for each row execute function private.require_business_claim_verification_receipt();
