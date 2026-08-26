import { assert, assertMatch, assertNotMatch } from 'jsr:@std/assert@1';

const migration = await Deno.readTextFile(new URL(
  '../migrations/20260910000000_business_social_feed_foundation.sql',
  import.meta.url,
));
const edge = await Deno.readTextFile(new URL('../functions/media-stage/index.ts', import.meta.url));
const feed = await Deno.readTextFile(new URL('../../app/(tabs)/feed.tsx', import.meta.url));
const studio = await Deno.readTextFile(new URL('../../app/(tabs)/studio.tsx', import.meta.url));

Deno.test('profile banners and business posts have serialized media grants', () => {
  assertMatch(migration, /'profile_banner'/);
  assertMatch(migration, /'business_post'/);
  assertMatch(migration, /private\.media_stage_grants/);
  assertMatch(migration, /grant_row\.purpose not in/);
  assertMatch(migration, /pg_catalog\.pg_advisory_xact_lock/);
  assertMatch(edge, /selectedPurpose === "business_post"/);
});

Deno.test('business posts are AAL2, member-authorized, professional, bounded, and RPC only', () => {
  assertMatch(migration, /create or replace function public\.create_business_post/);
  assertMatch(migration, /private\.require_aal2\(\)/);
  assertMatch(migration, /array\['owner', 'manager'\]::public\.member_role\[\]/);
  assertMatch(migration, /private\.content_is_professional\(normalized_body\)/);
  assertMatch(migration, /asset_count > 4/);
  assertMatch(migration, /business_post_hour', 12, 3600/);
  assertMatch(migration, /business_post_day', 50, 86400/);
  assertMatch(migration, /private\.lock_idempotency_request\(actor, 'business_post_create', key_hash\)/);
  assertMatch(migration, /IDEMPOTENCY_KEY_REUSED/);
  assertMatch(migration, /revoke all on public\.business_posts from public, anon, authenticated/);
  assertNotMatch(migration, /grant (insert|update|delete) on public\.business_posts/i);
});

Deno.test('post assets must originate from the dedicated approved media lane', () => {
  assertMatch(migration, /grant\.purpose = 'business_post'/);
  assertMatch(migration, /grant\.state = 'registered'/);
  assertMatch(migration, /asset\.quarantine_state = 'clean'/);
  assertMatch(migration, /asset\.moderation = 'approved'/);
});

Deno.test('followed feed is scoped to the viewer and keeps sponsorship out of content order', () => {
  const view = migration.split('create or replace view public.public_followed_feed')[1]
    ?.split('revoke all on function public.consume_media_stage_slot')[0] ?? '';
  assert(view.length > 0);
  assertMatch(view, /follow\.user_id = auth\.uid\(\)/);
  assertMatch(view, /follow\.follower_id = auth\.uid\(\)/);
  assertMatch(view, /private\.users_are_blocked\(auth\.uid\(\), review\.author_id\)/);
  assertNotMatch(view, /sponsor|placement|campaign/i);
  assertMatch(feed, /accessibilityRole="tablist"/);
  assertMatch(studio, /pathname: '\/business-posts'/);
});
