\set ON_ERROR_STOP on

do $claim_evidence_migration_rollback_contract$
begin
  if to_regclass('private.business_claim_evidence') is not null then
    raise exception 'Claim-evidence migration left private DDL after its conflict abort';
  end if;
  if to_regclass('private.business_claim_evidence_runtime_config') is not null
    or to_regclass('private.business_claim_evidence_audit') is not null
  then
    raise exception 'Claim-evidence migration left supporting private DDL after its conflict abort';
  end if;

  if not exists (
    select 1
    from public.business_claims claim
    where claim.id = 'fa100000-0000-4000-8000-000000000003'
      and claim.evidence_private_path =
        'quarantine/fa100000-0000-4000-8000-000000000001/fa100000-0000-4000-8000-000000000004.jpg'
      and claim.state = 'pending'
  ) then
    raise exception 'Claim-evidence migration conflict changed the legacy public claim';
  end if;

  if not exists (
    select 1
    from private.account_deletion_storage_items item
    where item.request_id = 'fa100000-0000-4000-8000-000000000005'
      and item.storage_path =
        'quarantine/fa100000-0000-4000-8000-000000000001/fa100000-0000-4000-8000-000000000004.jpg'
      and item.state = 'pending'
      and item.deleted_at is null
  ) then
    raise exception 'Claim-evidence migration conflict changed the deletion marker';
  end if;

  if not exists (
    select 1
    from storage.objects object
    where object.bucket_id = 'spottr-media'
      and object.name =
        'quarantine/fa100000-0000-4000-8000-000000000001/fa100000-0000-4000-8000-000000000004.jpg'
  ) then
    raise exception 'Claim-evidence migration conflict removed the retained storage object';
  end if;
end;
$claim_evidence_migration_rollback_contract$;

delete from private.account_deletion_storage_items
where request_id = 'fa100000-0000-4000-8000-000000000005';

delete from private.account_deletion_requests
where id = 'fa100000-0000-4000-8000-000000000005';

delete from public.business_claims
where id = 'fa100000-0000-4000-8000-000000000003';

select pg_catalog.set_config('storage.allow_delete_query', 'true', true);

delete from storage.objects
where bucket_id = 'spottr-media'
  and name =
    'quarantine/fa100000-0000-4000-8000-000000000001/fa100000-0000-4000-8000-000000000004.jpg';

delete from public.businesses
where id = 'fa100000-0000-4000-8000-000000000002';

delete from auth.users
where id = 'fa100000-0000-4000-8000-000000000001';
