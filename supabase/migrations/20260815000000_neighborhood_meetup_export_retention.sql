-- Export actor-owned consent metadata before deletion and unlink retained
-- consent receipts after the durable deletion request reaches completion.

alter table private.marketplace_consent_receipts
  alter column user_id drop not null;

alter function public.account_export_payload(uuid)
  rename to account_export_payload_pre_meetup;
revoke all on function public.account_export_payload_pre_meetup(uuid)
  from public, anon, authenticated;

create or replace function public.account_export_payload(target_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.account_export_payload_pre_meetup(target_user_id)
    || jsonb_build_object(
      'schema_version', '2026-08-15',
      'marketplace_meetup_consents', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'consent_kind', receipt.consent_kind,
            'policy_version', receipt.policy_version,
            'business_id', receipt.business_id,
            'conversation_public_id', conversation.public_id,
            'pickup_request_public_id', request.public_id,
            'recorded_at', receipt.recorded_at
          )
          order by receipt.recorded_at, receipt.id
        )
        from private.marketplace_consent_receipts receipt
        left join public.marketplace_conversations conversation
          on conversation.id = receipt.conversation_id
        left join public.marketplace_pickup_requests request
          on request.id = receipt.request_id
        where receipt.user_id = target_user_id
      ), '[]'::jsonb)
    );
$$;
revoke all on function public.account_export_payload(uuid)
  from public, anon, authenticated;
grant execute on function public.account_export_payload(uuid)
  to service_role;

create or replace function private.unlink_meetup_consents_after_account_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state = 'storage_deleted' and old.state is distinct from 'storage_deleted' then
    update private.marketplace_consent_receipts
    set user_id = null,
      conversation_id = null,
      request_id = null
    where user_id = new.user_id;
  end if;
  return new;
end;
$$;
revoke all on function private.unlink_meetup_consents_after_account_deletion()
  from public, anon, authenticated;
drop trigger if exists unlink_meetup_consents_after_account_deletion
  on private.account_deletion_requests;
create trigger unlink_meetup_consents_after_account_deletion
after update of state on private.account_deletion_requests
for each row execute function private.unlink_meetup_consents_after_account_deletion();
