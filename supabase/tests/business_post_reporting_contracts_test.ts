import { assertMatch } from 'https://deno.land/std@0.224.0/assert/mod.ts';

const root = new URL('../migrations/20260911000000_business_post_reporting.sql', import.meta.url);
const migration = await Deno.readTextFile(root);

Deno.test('business post reports validate live public non-owned targets', () => {
  assertMatch(migration, /when 'business_post'[\s\S]*post\.deleted_at is null/);
  assertMatch(migration, /not private\.is_business_member\(post\.business_id, new\.reporter_id\)/);
  assertMatch(migration, /private\.consume_rate_limit\(actor, 'content_report_hour', 30, 3600\)/);
});

Deno.test('reported post moderation requires AAL2, staff role, concurrency and audit', () => {
  assertMatch(migration, /function public\.decide_reported_business_post/);
  assertMatch(migration, /private\.require_aal2\(\)/);
  assertMatch(migration, /MODERATION_TARGET_CHANGED/);
  assertMatch(migration, /MODERATION_STATE_CHANGED/);
  assertMatch(migration, /moderation\.reported_business_post_decided/);
});

Deno.test('reported post queue and decisions are not exposed as raw table writes', () => {
  assertMatch(migration, /function public\.list_reported_business_posts/);
  assertMatch(migration, /report\.state in \('open', 'reviewing'\)/);
  assertMatch(migration, /grant execute on function public\.decide_reported_business_post/);
});
