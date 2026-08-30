import { assertMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20261010000000_business_post_moderation_null_guard.sql",
    import.meta.url,
  ),
);
const runtime = await Deno.readTextFile(
  new URL("./full_stack_security_runtime_test.sql", import.meta.url),
);

Deno.test("social moderation rejects null decisions at narrow public boundaries", () => {
  for (const target of ["review_comment", "review", "business_post"]) {
    assertMatch(
      migration,
      new RegExp(
        `alter function public\\.decide_reported_${target}\\(uuid, text, text, timestamptz\\)[\\s\\S]+rename to decide_reported_${target}_null_safe_core`,
      ),
    );
    assertMatch(
      migration,
      new RegExp(
        `create function public\\.decide_reported_${target}\\([\\s\\S]+private\\.require_aal2\\(\\)[\\s\\S]+private\\.is_platform_staff\\([\\s\\S]+if decision is null then[\\s\\S]+return private\\.decide_reported_${target}_null_safe_core`,
      ),
    );
    assertMatch(
      migration,
      new RegExp(
        `revoke all on function public\\.decide_reported_${target}\\([\\s\\S]+from public, anon, authenticated, service_role[\\s\\S]+grant execute on function public\\.decide_reported_${target}\\([\\s\\S]+to authenticated`,
      ),
    );
    assertMatch(
      migration,
      new RegExp(
        `revoke all on function private\\.decide_reported_${target}_null_safe_core\\([\\s\\S]+from public, anon, authenticated, service_role`,
      ),
    );
  }
  assertMatch(
    migration,
    /if decision is null then[\s\S]+errcode = '22023'[\s\S]+message = 'Invalid moderation decision'/,
  );
  assertMatch(
    migration,
    /revoke all on function public\.decide_reported_business_post\([\s\S]+from public, anon, authenticated, service_role[\s\S]+grant execute on function public\.decide_reported_business_post\([\s\S]+to authenticated/,
  );
});

Deno.test("cloud runtime proves null decisions cannot dismiss reports", () => {
  assertMatch(runtime, /\$review_and_comment_null_decision_guard\$/);
  assertMatch(runtime, /\$social_moderation_auth_before_validation\$/);
  assertMatch(runtime, /\$business_post_null_decision_guard\$/);
  assertMatch(runtime, /Null review decision bypassed validation/);
  assertMatch(runtime, /Null review-comment decision bypassed validation/);
  assertMatch(runtime, /Null business-post decision bypassed validation/);
  assertMatch(runtime, /Null review decision changed content or report state/);
  assertMatch(
    runtime,
    /Null business-post decision changed post or report state/,
  );
});
