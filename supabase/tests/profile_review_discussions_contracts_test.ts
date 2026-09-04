import { assert, assertMatch, assertNotMatch } from 'jsr:@std/assert@1';

const migrationUrl = new URL(
  '../migrations/20260908000000_profile_review_discussions.sql',
  import.meta.url,
);
const migration = await Deno.readTextFile(migrationUrl);

Deno.test('review reactions are unique, RPC-only, and reject self-voting', () => {
  assertMatch(migration, /primary key \(review_id, user_id\)/);
  assertMatch(migration, /if review_author = actor then/);
  assertMatch(migration, /You cannot react to your own review/);
  assertMatch(migration, /private\.users_are_blocked\(actor, review_author\)/);
  assertMatch(migration, /review_reaction_hour', 120, 3600/);
  assertMatch(migration, /revoke all on table public\.review_reactions from public, anon, authenticated/);
  assertNotMatch(migration, /grant (insert|update|delete) on public\.review_reactions/i);
});

Deno.test('helpful counts use active positive reactions and protected nested updates', () => {
  assertMatch(migration, /rr\.reaction = 1/);
  assertMatch(migration, /p\.status = 'active'/);
  assertMatch(migration, /pg_trigger_depth\(\) > 1/);
  assertMatch(migration, /new\.helpful_count := old\.helpful_count/);
  assertMatch(migration, /update public\.reviews r/);
});

Deno.test('profile discussion comments are bounded, professional, blocked, and rate limited', () => {
  assertMatch(migration, /char_length\(btrim\(body\)\) between 1 and 500/);
  assertMatch(migration, /private\.content_is_professional\(normalized_body\)/);
  assertMatch(migration, /review_profile_comment_hour', 30, 3600/);
  assertMatch(migration, /review_profile_comment_day', 100, 86400/);
  assertMatch(migration, /public\.public_profile_review_comments/);
  assertMatch(migration, /review_author_public_id/);
  assertMatch(migration, /c\.author_id = auth\.uid\(\)/);
});

Deno.test('profile review discussion views expose opaque identities without auth ids', () => {
  const commentsView = migration.split(
    'create or replace view public.public_profile_review_comments',
  )[1]?.split('revoke all on function public.set_review_reaction')[0] ?? '';
  assert(commentsView.length > 0);
  assertMatch(commentsView, /commenter\.public_id as author_public_id/);
  assertNotMatch(commentsView, /as author_id/);
  assertNotMatch(commentsView, /review_author\.user_id as/);
});
