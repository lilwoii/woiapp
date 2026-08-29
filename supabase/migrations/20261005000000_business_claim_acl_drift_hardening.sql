-- Business claims remain fail closed. Reassert the intended authority surface
-- after every prior CREATE OR REPLACE so a manually broadened ACL cannot
-- survive the forward migration chain.

revoke all privileges on table public.business_claims
  from public, anon, authenticated;

revoke all on function public.submit_business_claim(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.submit_business_claim(uuid, text, text)
  to authenticated;
