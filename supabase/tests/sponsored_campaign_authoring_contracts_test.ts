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
  assertMatch(migration, /member\.role in \('owner', 'manager'\)/);
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
