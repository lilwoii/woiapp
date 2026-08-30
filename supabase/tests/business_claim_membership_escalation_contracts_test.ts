import { assertMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20261009000000_business_claim_membership_escalation_guard.sql",
    import.meta.url,
  ),
);
const runtime = await Deno.readTextFile(
  new URL("./full_stack_security_runtime_test.sql", import.meta.url),
);

Deno.test("claim approval cannot accept invitations or escalate memberships", () => {
  assertMatch(
    migration,
    /new\.id is distinct from old\.id[\s\S]+new\.business_id is distinct from old\.business_id[\s\S]+new\.claimant_id is distinct from old\.claimant_id[\s\S]+new\.method is distinct from old\.method[\s\S]+new\.created_at is distinct from old\.created_at/,
  );
  assertMatch(migration, /CLAIM_IDENTITY_IMMUTABLE/);
  assertMatch(
    migration,
    /new\.state <> 'approved'[\s\S]+tg_op = 'UPDATE' and old\.state = 'approved'/,
  );
  assertMatch(
    migration,
    /membership\.business_id = new\.business_id[\s\S]+membership\.user_id = new\.claimant_id[\s\S]+membership\.status in \('active', 'invited'\)/,
  );
  assertMatch(migration, /CLAIMANT_ALREADY_BUSINESS_MEMBER/);
  assertMatch(
    migration,
    /revoke all on function private\.reject_business_claim_membership_escalation\(\)[\s\S]+from public, anon, authenticated, service_role/,
  );
  assertMatch(
    migration,
    /create trigger business_claim_membership_escalation_guard[\s\S]+before insert or update of id, business_id, claimant_id, method, state, created_at[\s\S]+on public\.business_claims/,
  );
  assertMatch(
    migration,
    /new\.status not in \('active', 'invited'\)[\s\S]+claim\.business_id = new\.business_id[\s\S]+claim\.claimant_id = new\.user_id[\s\S]+claim\.state = 'pending'/,
  );
  assertMatch(migration, /BUSINESS_CLAIM_PENDING_FOR_MEMBER/);
  assertMatch(
    migration,
    /create trigger business_membership_pending_claim_guard[\s\S]+before insert or update of business_id, user_id, status on public\.business_members/,
  );
});

Deno.test("cloud runtime proves invited rejection and revoked restoration boundary", () => {
  assertMatch(runtime, /\$business_claim_membership_escalation_behavior\$/);
  assertMatch(
    runtime,
    /Invited membership was silently escalated by claim approval/,
  );
  assertMatch(
    runtime,
    /Revoked membership was incorrectly blocked from verified restoration/,
  );
  assertMatch(
    runtime,
    /Pending ownership claim allowed a conflicting membership activation/,
  );
  assertMatch(runtime, /Approved claim identity was mutable/);
  assertMatch(runtime, /Approved claim identifier was mutable/);
  assertMatch(runtime, /CLAIM_IDENTITY_IMMUTABLE/);
});
