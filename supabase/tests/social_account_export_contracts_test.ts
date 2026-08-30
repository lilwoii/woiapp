import { assert, assertMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20261008000000_social_account_export_completeness.sql",
    import.meta.url,
  ),
);
const runtime = await Deno.readTextFile(
  new URL("./full_stack_security_runtime_test.sql", import.meta.url),
);

Deno.test("social account export preserves the prior chain and remains service-only", () => {
  assertMatch(
    migration,
    /alter function public\.account_export_payload\(uuid\)[\s\S]+rename to account_export_payload_pre_social/,
  );
  assertMatch(
    migration,
    /revoke all on function public\.account_export_payload\(uuid\)[\s\S]+from public, anon, authenticated, service_role;[\s\S]+grant execute on function public\.account_export_payload\(uuid\)[\s\S]+to service_role/,
  );
  assertMatch(
    migration,
    /revoke all on function public\.account_export_payload_pre_social\(uuid\)[\s\S]+from public, anon, authenticated, service_role/,
  );
  assertMatch(
    migration,
    /account_export_payload_pre_meetup\(target_user_id\)[\s\S]+'marketplace_meetup_consents'/,
  );
  assert(
    !migration.includes("account_export_payload_core(target_user_id)"),
    "the final wrapper must not bypass the chat and meetup export chain",
  );
  assertMatch(
    migration,
    /'notification_consents'[\s\S]+'notification_devices'/,
  );
  assertMatch(
    migration,
    /revoke all on function public\.account_export_payload_pre_meetup\(uuid\)[\s\S]+from public, anon, authenticated, service_role/,
  );
});

Deno.test("enabled social workflows receive subject-scoped sanitized sections", () => {
  for (
    const section of [
      "profile_follows",
      "profile_followers",
      "review_reactions",
      "review_profile_comments",
      "authored_business_posts",
      "creator_invitations",
    ]
  ) {
    assert(migration.includes(`'${section}'`));
  }
  assertMatch(migration, /where follow\.follower_id = target_user_id/);
  assertMatch(migration, /where follow\.followed_id = target_user_id/);
  assertMatch(migration, /where reaction\.user_id = target_user_id/);
  assertMatch(migration, /where comment\.author_id = target_user_id/);
  assertMatch(migration, /where post\.author_id = target_user_id/);
  assertMatch(
    migration,
    /where invitation\.sender_id = target_user_id[\s\S]+or invitation\.recipient_id = target_user_id/,
  );
  assertMatch(migration, /'banner_asset_id'/);
  assert(!/'banner_path'/u.test(migration));
  assert(!/'avatar_path'\s*,/u.test(migration));
  assert(!/'storage_path'\s*,/u.test(migration));
  assert(!/'idempotency_key_hash'/u.test(migration));
  assert(!/'request_hash'/u.test(migration));
  assert(!/'sender_id'/u.test(migration));
  assert(!/'recipient_id'/u.test(migration));
});

Deno.test("cloud runtime exercises social export contents and deletion cascades", () => {
  assertMatch(runtime, /\$social_account_export_contract\$/);
  assertMatch(runtime, /account_export_payload\(social_user_id\)/);
  assertMatch(
    runtime,
    /Final account export dropped chat, meetup, or notification sections/,
  );
  assertMatch(
    runtime,
    /Social profile fields were absent from the account export/,
  );
  assertMatch(
    runtime,
    /Social export leaked a private path, request hash, or Auth identifier/,
  );
  assertMatch(runtime, /\$social_account_deletion_contract\$/);
  assertMatch(runtime, /Social rows survived Auth-account deletion/);
});
