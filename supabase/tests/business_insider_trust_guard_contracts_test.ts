import { assert, assertMatch, assertNotMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20261001000000_business_insider_trust_guard.sql",
    import.meta.url,
  ),
);
const discussionMigration = await Deno.readTextFile(
  new URL(
    "../migrations/20260908000000_profile_review_discussions.sql",
    import.meta.url,
  ),
);
const runtime = await Deno.readTextFile(
  new URL("./business_insider_trust_guard_runtime_test.sql", import.meta.url),
);
const runtimeGate = await Deno.readTextFile(
  new URL("../../scripts/database-runtime-gate.mjs", import.meta.url),
);

Deno.test("business members cannot author or revise their business reviews", () => {
  assertMatch(migration, /create or replace function private\.assert_external_review_trust_actor/);
  assertMatch(migration, /private\.is_business_member\(target_business_id, target_actor_id\)/);
  assertMatch(migration, /message = 'BUSINESS_REVIEW_TRUST_BOUNDARY'/);
  assertMatch(
    migration,
    /create trigger reviews_business_insider_trust_guard\s+before insert or update on public\.reviews/,
  );
  assertMatch(migration, /perform private\.assert_external_review_trust_actor\(old\.business_id, actor\)/);
  assertMatch(migration, /perform private\.assert_external_review_trust_actor\(new\.business_id, actor\)/);
  assertMatch(
    migration,
    /private\.is_platform_staff\(actor\)[\s\S]+new\.rating = old\.rating[\s\S]+new\.body = old\.body/,
  );
  assertMatch(migration, /new\.helpful_count = old\.helpful_count/);
  assertMatch(migration, /new\.deleted_at is not distinct from old\.deleted_at/);
});

Deno.test("reactions and profile discussion comments have the same server boundary", () => {
  assertMatch(
    migration,
    /create trigger review_reactions_business_insider_trust_guard\s+before insert or update or delete on public\.review_reactions/,
  );
  assertMatch(
    migration,
    /create trigger review_profile_comments_business_insider_trust_guard\s+before insert on public\.review_profile_comments/,
  );
  assertMatch(
    migration,
    /if next_reaction <> 0 then\s+perform private\.assert_external_review_trust_actor\(review_business_id, actor\);/,
  );
  assertMatch(
    migration,
    /perform private\.assert_external_review_trust_actor\(review_business_id, actor\);[\s\S]+private\.users_are_blocked\(actor, review_author\)/,
  );
  assertMatch(
    migration,
    /if tg_op = 'UPDATE' then[\s\S]+select review\.business_id[\s\S]+where review\.id = old\.review_id[\s\S]+select review\.business_id[\s\S]+where review\.id = new\.review_id[\s\S]+perform private\.assert_external_review_trust_actor\(old_business_id, actor\)/,
  );
  assertNotMatch(migration, /business_responses_business_insider_trust_guard/);
});

Deno.test("rating and body revisions atomically clear reactions and helpful state", () => {
  assertMatch(
    migration,
    /create or replace function private\.reset_review_trust_signals_on_revision\(\)/,
  );
  assertMatch(migration, /delete from public\.review_reactions reaction/);
  assertMatch(migration, /new\.helpful_count := 0/);
  assertMatch(
    migration,
    /create trigger reviews_reset_trust_signals_on_revision\s+before update of rating, body on public\.reviews/,
  );
  assertMatch(
    migration,
    /when \(old\.rating is distinct from new\.rating or old\.body is distinct from new\.body\)/,
  );
  assertMatch(migration, /current_setting\('spottr\.review_revision_reset', true\)/);
  assertMatch(migration, /set_config\('spottr\.review_revision_reset', new\.id::text, true\)/);
  assertMatch(
    migration,
    /revision_marker = target_review_id::text[\s\S]+perform set_config\('spottr\.review_revision_reset', coalesce\(previous_marker, ''\), true\)/,
  );
  assertMatch(
    migration,
    /revoke all on function private\.sync_review_helpful_count\(\)\s+from public, anon, authenticated, service_role/,
  );
  assertMatch(
    discussionMigration,
    /new\.moderation := 'pending'::public\.moderation_state/,
  );
});

Deno.test("canonical reaction/comment RPCs retain account-only execution", () => {
  assertMatch(
    migration,
    /revoke all on function public\.set_review_reaction\(uuid, smallint\)\s+from public, anon, authenticated, service_role/,
  );
  assertMatch(migration, /grant execute on function public\.set_review_reaction\(uuid, smallint\) to authenticated/);
  assertMatch(
    migration,
    /revoke all on function public\.add_review_profile_comment\(uuid, text\)\s+from public, anon, authenticated, service_role/,
  );
  assertMatch(migration, /grant execute on function public\.add_review_profile_comment\(uuid, text\) to authenticated/);
  assertMatch(
    migration,
    /revoke all on function public\.delete_own_review_profile_comment\(uuid\)\s+from public, anon, authenticated, service_role/,
  );
  assertMatch(
    migration,
    /grant execute on function public\.delete_own_review_profile_comment\(uuid\) to authenticated/,
  );
  assert(migration.includes("Removing a pre-existing reaction remains available"));
});

Deno.test("the focused runtime probe is part of the pinned database gate", () => {
  assertMatch(runtime, /pg_get_functiondef/);
  assertMatch(runtime, /reviews_reset_trust_signals_on_revision/);
  assertMatch(runtime, /public\.business_responses/);
  assertMatch(runtimeGate, /business_insider_trust_guard_runtime_test\.sql/);
});
