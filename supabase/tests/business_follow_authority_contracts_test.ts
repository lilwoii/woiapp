import { assert, assertMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20261016000000_business_follow_authority.sql",
    import.meta.url,
  ),
);
const api = await Deno.readTextFile(
  new URL("../../lib/marketplace-api.ts", import.meta.url),
);
const runtime = await Deno.readTextFile(
  new URL("./full_stack_security_runtime_test.sql", import.meta.url),
);

function sourceFunctionBody(source: string, name: string): string {
  const marker = `export async function ${name}(`;
  const start = source.indexOf(marker);
  const end = source.indexOf("\nexport ", start + marker.length);
  assert(start >= 0, `missing source function ${name}`);
  return source.slice(start, end >= 0 ? end : source.length);
}

Deno.test("business follow writes use one account-bound server authority", () => {
  const setFollow = sourceFunctionBody(api, "setFollow");
  assertMatch(setFollow, /authenticatedUserId\(expectedUserId\)/);
  assertMatch(setFollow, /marketplaceMutationClient\(expectedUserId\)/);
  assertMatch(setFollow, /client\.rpc\('set_business_follow'/);
  assertMatch(setFollow, /target_business_id: placeId/);
  assertMatch(setFollow, /should_follow: following/);
  assertMatch(setFollow, /data !== following/);
  assert(!setFollow.includes(".from('follows')"));
});

Deno.test("business follow authority is active-account, deletion, and eligibility safe", () => {
  assertMatch(migration, /if not private\.is_active_user\(actor\)/);
  assertMatch(
    migration,
    /target_business_id is null or should_follow is null[\s\S]+INVALID_BUSINESS_FOLLOW_REQUEST/,
  );
  assertMatch(migration, /pg_advisory_xact_lock[\s\S]+7741902/);
  assertMatch(
    migration,
    /from public\.profiles profile[\s\S]+profile\.user_id = actor[\s\S]+profile\.status = 'active'[\s\S]+for update/,
  );
  assertMatch(
    migration,
    /from public\.businesses business[\s\S]+private\.is_business_publicly_eligible\(business\.id\)[\s\S]+for key share/,
  );
  const followBranchStart = migration.indexOf("if should_follow then");
  const unfollowBranchStart = migration.indexOf("\n  else", followBranchStart);
  const branchEnd = migration.indexOf("\n  end if;", unfollowBranchStart);
  assert(followBranchStart >= 0 && unfollowBranchStart > followBranchStart);
  assert(branchEnd > unfollowBranchStart);
  assert(
    migration.slice(followBranchStart, unfollowBranchStart).includes(
      "private.is_business_publicly_eligible",
    ),
  );
  assert(
    !migration.slice(unfollowBranchStart, branchEnd).includes(
      "private.is_business_publicly_eligible",
    ),
  );
});

Deno.test("business follow abuse controls are bounded and change-audited", () => {
  assertMatch(
    migration,
    /private\.consume_rate_limit\(actor, 'business_follow', 120, 3600\)/,
  );
  assertMatch(migration, /active_follow_count >= 2000/);
  assertMatch(migration, /BUSINESS_FOLLOW_LIMIT_REACHED/);
  assertMatch(migration, /on conflict \(user_id, business_id\) do nothing/);
  assertMatch(migration, /get diagnostics changed_count = row_count/);
  assertMatch(
    migration,
    /if changed_count = 1[\s\S]+business\.followed[\s\S]+business\.unfollowed/,
  );
});

Deno.test("raw follow mutation ACL is removed after the migration chain", () => {
  assertMatch(
    migration,
    /revoke insert, update, delete on table public\.follows[\s\S]+from public, anon, authenticated, service_role/,
  );
  assertMatch(
    migration,
    /revoke all on function public\.set_business_follow\(uuid, boolean\)[\s\S]+from public, anon, authenticated, service_role;[\s\S]+grant execute on function public\.set_business_follow\(uuid, boolean\)[\s\S]+to authenticated/,
  );
  assertMatch(
    migration,
    /drop policy if exists "active users follow eligible businesses"/,
  );
  assertMatch(migration, /drop policy if exists "users delete own follows"/);
  assertMatch(
    migration,
    /has_table_privilege\('authenticated', 'public\.follows', 'INSERT'\)/,
  );
  assertMatch(
    migration,
    /has_function_privilege[\s\S]+'anon'[\s\S]+'service_role'/,
  );
});

Deno.test("hosted runtime covers denial, null intent, idempotency, rate limit, and audit", () => {
  assertMatch(runtime, /do \$business_follow_authority\$/);
  assertMatch(runtime, /Authenticated user bypassed the business follow RPC/);
  assertMatch(runtime, /Null business follow intent bypassed validation/);
  assertMatch(runtime, /Business follow was not idempotent/);
  assertMatch(runtime, /do \$business_unfollow_ineligible\$/);
  assertMatch(
    runtime,
    /An ineligible saved business could not be unfollowed idempotently/,
  );
  assertMatch(runtime, /Business follow mutation bypassed its rate limit/);
  assertMatch(runtime, /Business follow audit was not change-bound/);
});
