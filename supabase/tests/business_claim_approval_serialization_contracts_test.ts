import { assert, assertMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20261002000000_business_claim_approval_serialization.sql",
    import.meta.url,
  ),
);

const reviewStart = migration.indexOf(
  "create or replace function public.review_business_claim",
);
const reviewEnd = migration.indexOf("revoke all on function", reviewStart);
const review = migration.slice(reviewStart, reviewEnd);

Deno.test("claim approval locks the business before the pending claim", () => {
  assert(reviewStart >= 0 && reviewEnd > reviewStart);
  const businessLock = review.indexOf("for update of b;");
  const claimLock = review.indexOf("for update;", businessLock + 1);
  assert(businessLock >= 0 && claimLock > businessLock);
  assertMatch(
    review,
    /from public\.business_claims bc\s+join public\.businesses b on b\.id = bc\.business_id[\s\S]+where bc\.id = target_claim_id[\s\S]+for update of b;/,
  );
  assertMatch(
    review,
    /where bc\.id = target_claim_id[\s\S]+and bc\.business_id = target_business_id[\s\S]+for update;/,
  );
});

Deno.test("claim decisions reject null input and replay terminal decisions idempotently", () => {
  assertMatch(review, /if decision is null[\s\S]+or decision not in \('approved', 'rejected'\)/);
  assertMatch(review, /select bc\.claimant_id, bc\.state[\s\S]+into target_claimant_id, target_claim_state/);
  assertMatch(review, /if target_claim_state = decision then\s+return;/);
  assertMatch(review, /if target_claim_state <> 'pending' then[\s\S]+CLAIM_ALREADY_DECIDED/);
});

Deno.test("denial remains available and retains the claim decision audit", () => {
  const denialBranch = review.indexOf("if decision = 'rejected' then");
  const approvalChecks = review.indexOf("private.is_active_user(target_claimant_id)");
  assert(denialBranch >= 0 && approvalChecks > denialBranch);
  assertMatch(
    review,
    /set state = 'rejected',[\s\S]+reviewed_by = actor,[\s\S]+reviewed_at = now\(\)/,
  );
  assertMatch(
    review,
    /'business\.claim_decided',[\s\S]+'business_claim',[\s\S]+jsonb_build_object\('decision', decision, 'reason', normalized_reason\)/,
  );
});

Deno.test("approval rechecks claimant, listing eligibility, and ownership conflicts", () => {
  assertMatch(review, /join auth\.users u on u\.id = p\.user_id/);
  assertMatch(review, /for update of p;/);
  assertMatch(review, /not private\.is_active_user\(target_claimant_id\)/);
  assertMatch(review, /target_business_state <> 'published'::public\.business_state/);
  assertMatch(review, /target_business_provenance not in \('community', 'licensed_provider'\)/);
  assertMatch(review, /not private\.is_business_publicly_eligible\(target_business_id\)/);
  assertMatch(
    review,
    /from public\.business_members claimant_membership[\s\S]+claimant_membership\.user_id = target_claimant_id[\s\S]+claimant_membership\.status = 'active'/,
  );
  assertMatch(
    review,
    /from public\.business_members bm[\s\S]+bm\.business_id = target_business_id[\s\S]+bm\.role = 'owner'[\s\S]+bm\.status = 'active'/,
  );
  assertMatch(
    review,
    /from public\.business_claims approved_claim[\s\S]+approved_claim\.business_id = target_business_id[\s\S]+approved_claim\.state = 'approved'/,
  );
  assertMatch(review, /CLAIMANT_NOT_ACTIVE/);
  assertMatch(review, /CLAIM_BUSINESS_NOT_ELIGIBLE/);
  assertMatch(review, /CLAIMANT_ALREADY_BUSINESS_MEMBER/);
  assertMatch(review, /BUSINESS_ALREADY_CLAIMED/);
  assertMatch(review, /BUSINESS_CLAIM_CONFLICT/);
});

Deno.test("claim authority and launch gates remain fail-closed", () => {
  assertMatch(
    migration,
    /revoke all on function public\.review_business_claim\(uuid, text, text\)\s+from public, anon, authenticated, service_role;/,
  );
  assertMatch(
    migration,
    /grant execute on function public\.review_business_claim\(uuid, text, text\) to authenticated;/,
  );
  assert(!migration.includes("BUSINESS_CLAIMS_ENABLED"));
  assert(!migration.includes("set_home_kitchen_launch_gate"));
  assert(!migration.includes("set_push"));
});
