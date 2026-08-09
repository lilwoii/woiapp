-- Service-only queue claim for autonomous account-deletion continuation.
-- The external scheduler never receives a user token; it authenticates to the
-- Edge worker with a dedicated secret, and this RPC returns one frozen request.

create or replace function public.claim_next_account_deletion()
returns table (request_id uuid, user_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return query
  with candidate as (
    select request.id
    from private.account_deletion_requests request
    join private.account_deletion_freezes deletion_freeze
      on deletion_freeze.request_id = request.id and deletion_freeze.user_id = request.user_id
    where request.user_id is not null
      and (
        request.state in ('started', 'failed', 'storage_deleted')
        or (
          request.state = 'processing'
          and request.updated_at < now() - interval '5 minutes'
        )
      )
    order by request.created_at, request.id
    for update of request skip locked
    limit 1
  )
  update private.account_deletion_requests request
  set state = 'processing',
      failure_code = null,
      updated_at = now(),
      expires_at = greatest(request.expires_at, now() + interval '24 hours')
  from candidate
  where request.id = candidate.id
  returning request.id, request.user_id;
end;
$$;
revoke all on function public.claim_next_account_deletion()
  from public, anon, authenticated;
grant execute on function public.claim_next_account_deletion() to service_role;
