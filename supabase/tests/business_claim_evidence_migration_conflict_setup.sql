\set ON_ERROR_STOP on

-- This fixture runs only in the disposable Quality database immediately before
-- the claim-evidence retention migration. It represents a legacy claim whose
-- object is already inside an account-deletion manifest, which must make the
-- migration abort without retaining any partial DDL or data changes.
insert into auth.users (
  id,
  aud,
  role,
  email,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values (
  'fa100000-0000-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  'runtime-claim-evidence-conflict@spottr.invalid',
  now(),
  '{}'::jsonb,
  '{"username":"runtime_claim_conflict","display_name":"Runtime Claim Conflict","terms_accepted":true}'::jsonb,
  now(),
  now()
);

insert into public.businesses (
  id,
  kind,
  name,
  slug,
  provenance,
  created_by
) values (
  'fa100000-0000-4000-8000-000000000002',
  'restaurant',
  'Runtime Claim Evidence Conflict',
  'runtime-claim-evidence-conflict',
  'community',
  'fa100000-0000-4000-8000-000000000001'
);

insert into public.business_claims (
  id,
  business_id,
  claimant_id,
  method,
  evidence_private_path,
  state
) values (
  'fa100000-0000-4000-8000-000000000003',
  'fa100000-0000-4000-8000-000000000002',
  'fa100000-0000-4000-8000-000000000001',
  'document',
  'quarantine/fa100000-0000-4000-8000-000000000001/fa100000-0000-4000-8000-000000000004.jpg',
  'pending'
);

insert into storage.objects (bucket_id, name, owner_id)
values (
  'spottr-media',
  'quarantine/fa100000-0000-4000-8000-000000000001/fa100000-0000-4000-8000-000000000004.jpg',
  'fa100000-0000-4000-8000-000000000001'
);

insert into private.account_deletion_requests (
  id,
  user_id,
  request_fingerprint,
  state
) values (
  'fa100000-0000-4000-8000-000000000005',
  'fa100000-0000-4000-8000-000000000001',
  'fa10000000000000000000000000000000000000000000000000000000000005',
  'started'
);

insert into private.account_deletion_storage_items (
  request_id,
  storage_path,
  state
) values (
  'fa100000-0000-4000-8000-000000000005',
  'quarantine/fa100000-0000-4000-8000-000000000001/fa100000-0000-4000-8000-000000000004.jpg',
  'pending'
);
