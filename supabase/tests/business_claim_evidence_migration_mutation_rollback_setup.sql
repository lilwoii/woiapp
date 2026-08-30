\set ON_ERROR_STOP on

-- This fixture has no preflight conflict. The runtime harness appends a
-- test-only failure after the exact migration body so the transaction must
-- roll back the completed backfill, public-path clear, constraints, and DDL.
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
  'fa200000-0000-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  'runtime-claim-evidence-rollback@spottr.invalid',
  now(),
  '{}'::jsonb,
  '{"username":"runtime_claim_rollback","display_name":"Runtime Claim Rollback","terms_accepted":true}'::jsonb,
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
  'fa200000-0000-4000-8000-000000000002',
  'restaurant',
  'Runtime Claim Evidence Rollback',
  'runtime-claim-evidence-rollback',
  'community',
  'fa200000-0000-4000-8000-000000000001'
);

insert into public.business_claims (
  id,
  business_id,
  claimant_id,
  method,
  evidence_private_path,
  state
) values (
  'fa200000-0000-4000-8000-000000000003',
  'fa200000-0000-4000-8000-000000000002',
  'fa200000-0000-4000-8000-000000000001',
  'document',
  'quarantine/fa200000-0000-4000-8000-000000000001/fa200000-0000-4000-8000-000000000004.jpg',
  'pending'
);

insert into storage.objects (bucket_id, name, owner_id)
values (
  'spottr-media',
  'quarantine/fa200000-0000-4000-8000-000000000001/fa200000-0000-4000-8000-000000000004.jpg',
  'fa200000-0000-4000-8000-000000000001'
);
