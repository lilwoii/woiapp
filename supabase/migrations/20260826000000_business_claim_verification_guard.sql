-- Business ownership is an authority boundary. The legacy claim RPC accepted
-- self-selected listed-phone and domain-email methods without a completed
-- challenge receipt, so every claim method remains fail closed until a
-- provider-backed proof contract and operational review path are deployed.
create or replace function public.submit_business_claim(
  target_business_id uuid,
  claim_method text,
  evidence_private_path text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_aal2();
  if not private.is_active_user(auth.uid()) then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;
  raise exception using
    errcode = '55000',
    message = 'CLAIM_VERIFICATION_SERVICE_REQUIRED';
end;
$$;

revoke all on function public.submit_business_claim(uuid, text, text)
  from public, anon;
grant execute on function public.submit_business_claim(uuid, text, text)
  to authenticated;
