import { assertMatch } from 'https://deno.land/std@0.224.0/assert/mod.ts';

const migration = await Deno.readTextFile(new URL('../migrations/20260913000000_reviewer_badge_integrity.sql', import.meta.url));

Deno.test('reviewer awards revoke and reactivate from current eligible evidence', () => {
  assertMatch(migration, /private\.is_business_publicly_eligible\(review\.business_id\)/);
  assertMatch(migration, /set revoked_at = now\(\)/);
  assertMatch(migration, /revoked_at = null/);
  assertMatch(migration, /reactor\.status = 'active'/);
});

Deno.test('badge refresh follows reactions, photo approval, account and business eligibility', () => {
  assertMatch(migration, /review_reactions_refresh_trust_badges/);
  assertMatch(migration, /media_assets_refresh_review_trust_badges/);
  assertMatch(migration, /profiles_refresh_trust_badges/);
  assertMatch(migration, /businesses_refresh_reviewer_trust_badges/);
});

Deno.test('public badge and top-review projections enforce privacy and current reactions', () => {
  assertMatch(migration, /public_profile_badges[\s\S]*users_are_blocked/);
  assertMatch(migration, /public_business_badges[\s\S]*is_business_publicly_eligible/);
  assertMatch(migration, /public_reviews[\s\S]*reaction_stats\.up_count/);
});
