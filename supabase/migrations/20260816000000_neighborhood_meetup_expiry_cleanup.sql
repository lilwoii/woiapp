-- Make the recurring chat cleanup honor the shortened Neighborhood Kitchen
-- disclosure lifetime instead of the legacy pickup-end plus 12-hour window.

create or replace function public.cleanup_marketplace_chat_ephemera()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  typing_deleted integer := 0;
  legacy_disclosures_deleted integer := 0;
  neighborhood_disclosures_deleted integer := 0;
  receipts_deleted integer := 0;
  requests_expired integer := 0;
  affected integer := 0;
begin
  delete from public.marketplace_typing_presence presence
  where presence.expires_at <= now();
  get diagnostics typing_deleted = row_count;

  -- Updating request state invokes the disclosure-destruction trigger in the
  -- same transaction. Count the rows that carried an expired exact snapshot
  -- before that trigger removes them.
  select count(*)::integer into neighborhood_disclosures_deleted
  from private.neighborhood_pickup_disclosures disclosure
  join public.marketplace_pickup_requests request
    on request.id = disclosure.request_id
  where disclosure.expires_at <= now()
    and request.state = 'authorized';

  update public.marketplace_pickup_requests request
  set state = 'expired',
    version = version + 1,
    responded_at = coalesce(responded_at, now()),
    updated_at = now()
  where request.choice_kind in ('safe_meeting_place', 'seller_residence')
    and request.state = 'authorized'
    and exists (
      select 1
      from private.neighborhood_pickup_disclosures disclosure
      where disclosure.request_id = request.id
        and disclosure.expires_at <= now()
    );
  get diagnostics affected = row_count;
  requests_expired := requests_expired + affected;

  update public.marketplace_pickup_requests request
  set state = 'expired',
    version = version + 1,
    responded_at = coalesce(responded_at, now()),
    updated_at = now()
  where request.choice_kind in ('safe_meeting_place', 'seller_residence')
    and request.state = 'pending'
    and request.pickup_ends_at <= now();
  get diagnostics affected = row_count;
  requests_expired := requests_expired + affected;

  update public.marketplace_pickup_requests request
  set state = 'expired',
    version = version + 1,
    responded_at = coalesce(responded_at, now()),
    updated_at = now()
  where request.choice_kind is null
    and request.state in ('pending', 'authorized')
    and request.pickup_ends_at + interval '12 hours' <= now();
  get diagnostics affected = row_count;
  requests_expired := requests_expired + affected;

  -- Defense in depth for historical or externally corrupted rows whose request
  -- was already non-active when its snapshot expired.
  delete from private.neighborhood_pickup_disclosures disclosure
  where disclosure.expires_at <= now();
  get diagnostics affected = row_count;
  neighborhood_disclosures_deleted :=
    neighborhood_disclosures_deleted + affected;

  delete from private.marketplace_pickup_disclosures disclosure
  where disclosure.expires_at <= now();
  get diagnostics legacy_disclosures_deleted = row_count;

  delete from private.marketplace_chat_idempotency receipt
  where receipt.created_at < now() - interval '30 days';
  get diagnostics receipts_deleted = row_count;

  return jsonb_build_object(
    'typing_deleted', typing_deleted,
    'requests_expired', requests_expired,
    'disclosures_deleted', legacy_disclosures_deleted,
    'neighborhood_disclosures_deleted', neighborhood_disclosures_deleted,
    'idempotency_receipts_deleted', receipts_deleted
  );
end;
$$;
revoke all on function public.cleanup_marketplace_chat_ephemera()
  from public, anon, authenticated;
grant execute on function public.cleanup_marketplace_chat_ephemera()
  to service_role;
