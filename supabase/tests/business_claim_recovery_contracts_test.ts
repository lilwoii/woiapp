import { assert, assertMatch } from "jsr:@std/assert@1";

const api = await Deno.readTextFile(
  new URL("../../lib/marketplace-api.ts", import.meta.url),
);
const onboarding = await Deno.readTextFile(
  new URL("../../components/business-onboarding-screen.tsx", import.meta.url),
);
const onboardingRoute = await Deno.readTextFile(
  new URL("../../app/business-onboarding.tsx", import.meta.url),
);
const recoveryPanel = await Deno.readTextFile(
  new URL(
    "../../components/business-claim-recovery-panel.tsx",
    import.meta.url,
  ),
);
const types = await Deno.readTextFile(
  new URL("../../types/marketplace.ts", import.meta.url),
);
const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20261003000000_business_claim_recovery_boundary.sql",
    import.meta.url,
  ),
);
const aclMigration = await Deno.readTextFile(
  new URL(
    "../migrations/20261005000000_business_claim_acl_drift_hardening.sql",
    import.meta.url,
  ),
);

function sourceFunctionBody(source: string, name: string): string {
  const marker = `export async function ${name}(`;
  const start = source.indexOf(marker);
  const end = source.indexOf("\nexport ", start + marker.length);
  assert(start >= 0, `missing source function ${name}`);
  return source.slice(start, end >= 0 ? end : source.length);
}

Deno.test("claim recovery uses an account-bound, privacy-safe projection", () => {
  const fetchClaims = sourceFunctionBody(api, "fetchMyBusinessClaims");
  const withdrawClaim = sourceFunctionBody(api, "withdrawBusinessClaim");

  for (const body of [fetchClaims, withdrawClaim]) {
    assertMatch(body, /featureFlags\.businessClaims/);
    assertMatch(body, /authenticatedUserId\(expectedUserId\)/);
    assertMatch(body, /marketplaceMutationClient\(expectedUserId\)/);
    assert(!body.includes("evidence_private_path"));
    assert(!body.includes("reviewed_by"));
  }

  assertMatch(fetchClaims, /client\.rpc\('list_my_business_claims'/);
  assertMatch(fetchClaims, /target_claim_id: null/);
  assertMatch(fetchClaims, /result_limit: 100/);
  assert(!fetchClaims.includes(".from('business_claims')"));
  assertMatch(withdrawClaim, /client\.rpc\('withdraw_own_business_claim'/);
  assertMatch(withdrawClaim, /target_claim_id: claimId/);
  assertMatch(withdrawClaim, /receipt\.claimId !== claimId/);
  assertMatch(withdrawClaim, /receipt\.state !== 'withdrawn'/);
  assert(!withdrawClaim.includes(".from('business_claims')"));
});

Deno.test("claim history indexes replace the all-state uniqueness constraint safely", () => {
  const pendingIndex = migration.indexOf(
    "create unique index business_claims_one_pending_per_claimant_business_idx",
  );
  const approvedIndex = migration.indexOf(
    "create unique index business_claims_one_approved_per_business_idx",
  );
  const dropConstraint = migration.indexOf(
    "drop constraint business_claims_business_id_claimant_id_state_key",
  );
  assert(
    pendingIndex >= 0 && approvedIndex > pendingIndex &&
      dropConstraint > approvedIndex,
  );
  assertMatch(
    migration,
    /business_claims_one_pending_per_claimant_business_idx[\s\S]+\(business_id, claimant_id\)[\s\S]+where state = 'pending'/,
  );
  assertMatch(
    migration,
    /business_claims_one_approved_per_business_idx[\s\S]+\(business_id\)[\s\S]+where state = 'approved'/,
  );
});

Deno.test("claim table and submission ACLs are reasserted after the migration chain", () => {
  assertMatch(
    aclMigration,
    /revoke all privileges on table public\.business_claims\s+from public, anon, authenticated;/,
  );
  assertMatch(
    aclMigration,
    /revoke all on function public\.submit_business_claim\(uuid, text, text\)\s+from public, anon, authenticated, service_role;[\s\S]+grant execute on function public\.submit_business_claim\(uuid, text, text\)\s+to authenticated;/,
  );
});

Deno.test("claim reads are RPC-only with a strict safe projection and ACL", () => {
  const listStart = migration.indexOf(
    "create or replace function public.list_my_business_claims",
  );
  const listAcl = migration.indexOf(
    "revoke all on function public.list_my_business_claims",
    listStart,
  );
  const list = migration.slice(listStart, listAcl);
  const header = list.slice(0, list.indexOf("language plpgsql"));
  assert(listStart >= 0 && listAcl > listStart);
  assertMatch(
    migration,
    /revoke select on table public\.business_claims from public, anon, authenticated;/,
  );
  assertMatch(
    header,
    /returns table \(\s*id uuid,\s*business_id uuid,\s*business_name text,\s*method text,\s*state text,\s*created_at timestamptz\s*\)/,
  );
  assert(!header.includes("claimant_id"));
  assert(!list.includes("evidence_private_path"));
  assert(!list.includes("reviewed_by"));
  assertMatch(list, /private\.require_aal2\(\)/);
  assertMatch(list, /private\.is_active_user\(actor\)/);
  assertMatch(list, /target_claim_id is null or claim\.id = target_claim_id/);
  assertMatch(list, /result_limit not between 1 and 100/);
  assertMatch(
    migration,
    /revoke all on function public\.list_my_business_claims\(uuid, integer\)\s+from public, anon, authenticated, service_role;[\s\S]+grant execute on function public\.list_my_business_claims\(uuid, integer\)\s+to authenticated;/,
  );
});

Deno.test("own withdrawal locks business before claim and is server-idempotent", () => {
  const withdrawStart = migration.indexOf(
    "create or replace function public.withdraw_own_business_claim",
  );
  const withdrawAcl = migration.indexOf(
    "revoke all on function public.withdraw_own_business_claim",
    withdrawStart,
  );
  const withdraw = migration.slice(withdrawStart, withdrawAcl);
  const businessLock = withdraw.indexOf("from public.businesses business");
  const businessForUpdate = withdraw.indexOf("for update;", businessLock);
  const claimLock = withdraw.indexOf("select claim.state", businessForUpdate);
  const claimForUpdate = withdraw.indexOf("for update;", claimLock);
  assert(
    withdrawStart >= 0 && withdrawAcl > withdrawStart && businessLock >= 0 &&
      businessForUpdate > businessLock && claimLock > businessForUpdate &&
      claimForUpdate > claimLock,
  );
  assertMatch(withdraw, /private\.require_aal2\(\)/);
  assertMatch(withdraw, /private\.is_active_user\(actor\)/);
  assertMatch(
    withdraw,
    /if target_state = 'withdrawn' then[\s\S]+return query select target_claim_id, 'withdrawn'::text/,
  );
  assertMatch(
    withdraw,
    /if target_state <> 'pending' then[\s\S]+CLAIM_NOT_WITHDRAWABLE/,
  );
  assertMatch(
    withdraw,
    /set state = 'withdrawn'[\s\S]+claim\.state = 'pending'/,
  );
  assertMatch(withdraw, /'business\.claim_withdrawn'/);
  assertMatch(
    migration,
    /revoke all on function public\.withdraw_own_business_claim\(uuid\)\s+from public, anon, authenticated, service_role;[\s\S]+grant execute on function public\.withdraw_own_business_claim\(uuid\)\s+to authenticated;/,
  );
  assertMatch(
    migration,
    /create or replace function public\.withdraw_business_claim[\s\S]+from public\.withdraw_own_business_claim\(target_claim_id\)/,
  );
  assertMatch(
    migration,
    /revoke all on function public\.withdraw_business_claim\(uuid\)\s+from public, anon, authenticated, service_role;\s*$/,
  );
});

Deno.test("claim receipts preserve server identifiers and valid states", () => {
  assertMatch(api, /export function parseBusinessClaimReceipt/);
  assertMatch(api, /value\.length === 1/);
  assertMatch(api, /const claimId = stringValue\(row\.claim_id\)/);
  assertMatch(api, /businessClaimStates\.includes\(rawState/);
  assertMatch(api, /data: receipt/);
  assertMatch(api, /Promise<ActionResult<BusinessClaimReceipt>>/);
  const submitClaim = sourceFunctionBody(api, "submitBusinessClaim");
  assertMatch(submitClaim, /parseSubmittedClaimId\(data\)/);
  assertMatch(submitClaim, /client\.rpc\('list_my_business_claims'/);
  assertMatch(submitClaim, /verifiedClaim\.businessId !== businessId/);
  assertMatch(submitClaim, /verifiedClaim\.method !== method/);
  assertMatch(submitClaim, /verifiedClaim\.state !== 'pending'/);
  assertMatch(submitClaim, /submissionMayExist/);
  assertMatch(
    submitClaim,
    /Refresh the ownership claims list before trying again/,
  );
  assertMatch(
    types,
    /export type BusinessClaimState = 'pending' \| 'approved' \| 'rejected' \| 'withdrawn'/,
  );
  assertMatch(types, /export type BusinessClaimReceipt/);
});

Deno.test("onboarding claim status stays flag-gated and handles recovery states", () => {
  const statuses = ["pending", "approved", "rejected", "withdrawn"];
  assertMatch(
    onboarding,
    /const LazyBusinessClaimRecoveryPanel = lazy\([\s\S]+import\('@\/components\/business-claim-recovery-panel'\)/,
  );
  assertMatch(
    onboardingRoute,
    /useEffect\(\(\) => \{[\s\S]+import\('@\/components\/business-onboarding-screen'\)/,
  );
  assertMatch(
    onboardingRoute,
    /if \(!Screen\) return <BusinessOnboardingLoading \/>/,
  );
  assertMatch(
    onboardingRoute,
    /if \(loadFailed\) return <BusinessOnboardingLoadError \/>/,
  );
  assertMatch(onboardingRoute, /spottr:route-content-ready/);
  assert(!onboardingRoute.includes("lazy("));
  assert(!onboardingRoute.includes("<Suspense"));
  assertMatch(onboarding, /featureFlags\.businessClaims \? \([\s\S]+<Suspense/);
  assertMatch(onboarding, /class ClaimRecoveryBoundary extends Component/);
  assertMatch(onboarding, /<ClaimRecoveryBoundary>[\s\S]+<Suspense/);
  assertMatch(onboarding, /Claim history is temporarily unavailable/);
  assertMatch(onboarding, /You can continue adding or claiming a business/);
  assertMatch(onboarding, /<LazyBusinessClaimRecoveryPanel/);
  assertMatch(onboarding, /expectedUserId=\{expectedUserId\}/);
  assertMatch(onboarding, /secureSession=\{secureSession\}/);
  assertMatch(onboarding, /refreshToken=\{claimsRefreshToken\}/);
  assertMatch(
    onboarding,
    /setClaimsRefreshToken\(\(current\) => current \+ 1\)/,
  );
  assert(!onboarding.includes("fetchMyBusinessClaims"));
  assert(!onboarding.includes("withdrawBusinessClaim"));
  assert(!onboarding.includes("claimsRequestGeneration"));
  assert(!onboarding.includes("claimMutationGeneration"));

  assertMatch(recoveryPanel, /useAuth\(\)/);
  assertMatch(recoveryPanel, /featureFlags\.businessClaims/);
  assertMatch(recoveryPanel, /fetchMyBusinessClaims\(accountAtStart\)/);
  assertMatch(
    recoveryPanel,
    /withdrawBusinessClaim\(claim\.id, accountAtStart\)/,
  );
  assertMatch(recoveryPanel, /claimsRequestGeneration/);
  assertMatch(recoveryPanel, /claimMutationGeneration/);
  for (const state of statuses) {
    assertMatch(recoveryPanel, new RegExp(`${state}:`));
  }
  assertMatch(
    recoveryPanel,
    /Verification evidence and reviewer details are never shown here/,
  );
  assertMatch(
    recoveryPanel,
    /confirmAction\(\{[\s\S]+Withdraw this ownership claim/,
  );
  assertMatch(recoveryPanel, /Refresh ownership claims/);
  assertMatch(
    onboarding,
    /const \[selectedClaimId, setSelectedClaimId\] = useState<string \| null>\(null\)/,
  );
  assertMatch(onboarding, /place\.publicationState === 'published'/);
  assertMatch(onboarding, /place\.sourceLabel === 'Licensed provider'/);
  assertMatch(onboarding, /place\.sourceLabel === 'Community added'/);
  assertMatch(onboarding, /const selectedClaim = claimMatches\.find/);
  assertMatch(recoveryPanel, /claimRefreshButton:[\s\S]+minHeight: 44/);
  assertMatch(recoveryPanel, /claimWithdrawButton:[\s\S]+minHeight: 44/);
});
