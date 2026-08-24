import { assert, assertMatch, assertNotMatch } from 'jsr:@std/assert@1';

const migration = await Deno.readTextFile(new URL(
  '../migrations/20260909000000_review_discovery_and_comment_reporting.sql',
  import.meta.url,
));
const marketplaceApi = await Deno.readTextFile(new URL('../../lib/marketplace-api.ts', import.meta.url));
const placeScreen = await Deno.readTextFile(new URL('../../app/place/[id].tsx', import.meta.url));
const profileScreen = await Deno.readTextFile(new URL('../../app/profile/[id].tsx', import.meta.url));
const moderationClient = await Deno.readTextFile(new URL('../../lib/content-moderation.ts', import.meta.url));

Deno.test('profile comments have a confidential report path with target validation', () => {
  assertMatch(migration, /'review_comment'/);
  assertMatch(migration, /c\.author_id <> new\.reporter_id/);
  assertMatch(migration, /c\.moderation = 'approved'/);
  assertMatch(migration, /c\.deleted_at is null/);
  assertMatch(migration, /not private\.users_are_blocked\(new\.reporter_id, c\.author_id\)/);
  assertMatch(profileScreen, /targetType: 'review_comment'/);
  assertMatch(migration, /'review_comment'::text/);
  assertMatch(migration, /decide_reported_review_comment/);
  assertMatch(migration, /expected_updated_at/);
  assertMatch(migration, /report\.state in \('open', 'reviewing'\)/);
  assertMatch(migration, /then 'resolved' else 'dismissed'/);
  assertMatch(moderationClient, /item\.targetType === 'review_comment'/);
});

Deno.test('Top review ordering is evidence based and cannot be purchased', () => {
  const view = migration.split('create or replace view public.public_reviews')[1]
    ?.split('revoke all on function private.validate_report_target')[0] ?? '';
  assert(view.length > 0);
  assertMatch(view, /greatest\(r\.helpful_count, 0\) \* 4/);
  assertMatch(view, /least\(coalesce\(badge_stats\.badge_count, 0\), 5\) \* 3/);
  assertMatch(view, /reaction_stats\.down_count/);
  assertNotMatch(view, /sponsor|placement|campaign/i);
  assertNotMatch(view, /r\.rating \*/);
});

Deno.test('Recent and Top are server ordered, paginated, and explained in the UI', () => {
  assertMatch(marketplaceApi, /export type ReviewSort = 'recent' \| 'top'/);
  assertMatch(marketplaceApi, /order\('top_score', \{ ascending: false \}\)/);
  assertMatch(marketplaceApi, /order\('created_at', \{ ascending: false \}\)/);
  assertMatch(placeScreen, /accessibilityRole="tablist"/);
  assertMatch(placeScreen, /Sponsored placement is never included/);
  assertMatch(placeScreen, /reviewView\.reviews\.length/);
});
