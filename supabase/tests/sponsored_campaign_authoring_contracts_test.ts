import { assertMatch, assertNotMatch } from 'https://deno.land/std@0.224.0/assert/mod.ts';

const migration = await Deno.readTextFile(new URL('../migrations/20260916000000_sponsored_campaign_authoring.sql', import.meta.url));

Deno.test('campaign authoring keeps pricing and activation server-authoritative', () => {
  assertMatch(migration, /pricing\.state = 'approved'/);
  assertMatch(migration, /billing_model, state[\s\S]*'shadow', 'draft'/);
  assertNotMatch(migration, /state\s*=\s*'active'/);
  assertNotMatch(migration, /insert into private\.billing_ledger/);
});

Deno.test('campaign mutations require AAL2 verified owner or manager and rate limits', () => {
  assertMatch(migration, /private\.require_aal2\(\)/);
  for (const functionName of ['create_sponsored_campaign_draft', 'submit_sponsored_campaign', 'end_sponsored_campaign']) {
    const start = migration.indexOf(`create or replace function public.${functionName}`);
    const end = migration.indexOf('\n$$;', start);
    const body = migration.slice(start, end);
    assertMatch(body, /member\.role in \('owner', 'manager'\)/);
  }
  assertMatch(migration, /business\.verification = 'verified'/);
  assertMatch(migration, /private\.consume_rate_limit/);
});

Deno.test('campaign drafts are idempotent and merchant submission stays review-gated', () => {
  assertMatch(migration, /IDEMPOTENCY_KEY_REUSED/);
  assertMatch(migration, /pg_advisory_xact_lock/);
  assertMatch(migration, /state = 'submitted'/);
  assertMatch(migration, /expected_updated_at/);
  assertMatch(migration, /sponsor\.campaign_(draft_created|submitted|ended)/);
});

Deno.test('campaign authoring rejects nulls, uses the hardened hash helper, and revalidates commercial state', () => {
  assertMatch(migration, /monthly_budget_minor is null/);
  assertMatch(migration, /private\.ad_sha256_hex\(idempotency_key\)/);
  assertNotMatch(migration, /encode\(digest\(/);
  assertMatch(migration, /pricing\.state = 'approved'[\s\S]*pricing\.expires_at/);
  assertMatch(migration, /Campaign pricing, dates, or location must be refreshed/);
  assertMatch(migration, /owners and managers read campaign rollups/);
  assertMatch(migration, /spottr-sponsor-authoring/);
});
