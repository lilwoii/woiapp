\set ON_ERROR_STOP on

do $claim_evidence_migration_mutation_rollback_contract$
begin
  if to_regclass('private.business_claim_evidence') is not null
    or to_regclass('private.business_claim_evidence_runtime_config') is not null
    or to_regclass('private.business_claim_evidence_audit') is not null
    or to_regclass('private.business_claim_evidence_account_deletion_exceptions') is not null
    or to_regclass('private.business_claim_evidence_purge_receipts') is not null
  then
    raise exception 'Forced claim-evidence rollback left private DDL behind';
  end if;

  if to_regprocedure(
    'private.is_valid_sorted_sha256_hash_array(text[],integer)'
  ) is not null
    or to_regprocedure('private.audit_business_claim_evidence_insert()') is not null
    or to_regprocedure('private.audit_business_claim_evidence_transition()') is not null
    or to_regprocedure('private.is_protected_business_claim_evidence_path(text)') is not null
    or to_regprocedure('private.enforce_claim_evidence_account_deletion_seal()') is not null
    or to_regprocedure('public.business_claim_evidence_intake_enabled()') is not null
    or to_regprocedure('public.prepare_business_claim_evidence_purge_batch()') is not null
    or to_regprocedure(
      'public.finalize_business_claim_evidence_purge_batch(uuid,text[])'
    ) is not null
  then
    raise exception 'Forced claim-evidence rollback left claim-evidence functions behind';
  end if;

  if not exists (
    select 1
    from public.business_claims claim
    where claim.id = 'fa200000-0000-4000-8000-000000000003'
      and claim.evidence_private_path =
        'quarantine/fa200000-0000-4000-8000-000000000001/fa200000-0000-4000-8000-000000000004.jpg'
      and claim.state = 'pending'
  ) then
    raise exception 'Forced claim-evidence rollback did not restore the public path';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.business_claims'::regclass
      and constraint_row.conname = 'business_claims_legacy_evidence_path_retired'
  ) then
    raise exception 'Forced claim-evidence rollback left the path-retirement constraint behind';
  end if;

  if pg_catalog.pg_get_functiondef(
    'public.prepare_media_cleanup_batch()'::regprocedure
  ) like '%private.business_claim_evidence%'
    or pg_catalog.pg_get_functiondef(
      'public.prepare_account_deletion_storage_batch(uuid,uuid)'::regprocedure
    ) like '%private.business_claim_evidence%'
    or pg_catalog.pg_get_functiondef(
      'public.checkpoint_account_deletion_storage_batch(uuid,uuid,text[])'::regprocedure
    ) like '%private.business_claim_evidence%'
  then
    raise exception 'Forced claim-evidence rollback left replacement cleanup definitions behind';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_policy policy_row
    where policy_row.polrelid = 'storage.objects'::regclass
      and policy_row.polname = 'users delete own quarantine media'
      and (
        pg_catalog.pg_get_expr(policy_row.polqual, policy_row.polrelid)
          like '%is_protected_business_claim_evidence_path%'
        or pg_catalog.pg_get_expr(policy_row.polwithcheck, policy_row.polrelid)
          like '%is_protected_business_claim_evidence_path%'
      )
  ) then
    raise exception 'Forced claim-evidence rollback left the replacement storage policy behind';
  end if;

  if not exists (
    select 1
    from storage.objects object
    where object.bucket_id = 'spottr-media'
      and object.name =
        'quarantine/fa200000-0000-4000-8000-000000000001/fa200000-0000-4000-8000-000000000004.jpg'
  ) then
    raise exception 'Forced claim-evidence rollback removed the retained storage object';
  end if;
end;
$claim_evidence_migration_mutation_rollback_contract$;

delete from public.business_claims
where id = 'fa200000-0000-4000-8000-000000000003';

select pg_catalog.set_config('storage.allow_delete_query', 'true', true);

delete from storage.objects
where bucket_id = 'spottr-media'
  and name =
    'quarantine/fa200000-0000-4000-8000-000000000001/fa200000-0000-4000-8000-000000000004.jpg';

delete from public.businesses
where id = 'fa200000-0000-4000-8000-000000000002';

delete from auth.users
where id = 'fa200000-0000-4000-8000-000000000001';
