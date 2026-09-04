-- Recover the narrow post-Auth deletion window where the durable request still
-- needs its final completion receipt. Auth deletion nulls request.user_id via
-- the foreign key, so only sealed, orphaned receipts are eligible.

create or replace function public.finalize_account_deletion_receipt(
  target_request_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  request private.account_deletion_requests%rowtype;
begin
  if target_request_id is null then
    raise exception using errcode = '22023', message = 'INVALID_ACCOUNT_DELETION_RECEIPT';
  end if;

  select current_request.*
  into request
  from private.account_deletion_requests current_request
  where current_request.id = target_request_id
  for update;

  if not found
    or request.user_id is not null
    or request.state not in ('storage_deleted', 'completed')
    or exists (
      select 1
      from private.account_deletion_storage_items item
      where item.request_id = target_request_id
        and item.state <> 'deleted'
    )
  then
    raise exception using errcode = '55000', message = 'ACCOUNT_DELETION_RECEIPT_NOT_READY';
  end if;

  if request.state = 'completed' then
    return true;
  end if;

  update private.account_deletion_requests current_request
  set state = 'completed',
      failure_code = null,
      updated_at = now()
  where current_request.id = target_request_id;

  return true;
end;
$$;

revoke all on function public.finalize_account_deletion_receipt(uuid)
  from public, anon, authenticated;
grant execute on function public.finalize_account_deletion_receipt(uuid)
  to service_role;

create or replace function public.finalize_next_account_deletion_receipt()
returns table (request_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return query
  with candidate as (
    select current_request.id
    from private.account_deletion_requests current_request
    where current_request.user_id is null
      and current_request.state = 'storage_deleted'
      and not exists (
        select 1
        from private.account_deletion_storage_items item
        where item.request_id = current_request.id
          and item.state <> 'deleted'
      )
    order by current_request.updated_at, current_request.id
    for update of current_request skip locked
    limit 1
  )
  update private.account_deletion_requests current_request
  set state = 'completed',
      failure_code = null,
      updated_at = now()
  from candidate
  where current_request.id = candidate.id
  returning current_request.id;
end;
$$;

revoke all on function public.finalize_next_account_deletion_receipt()
  from public, anon, authenticated;
grant execute on function public.finalize_next_account_deletion_receipt()
  to service_role;
