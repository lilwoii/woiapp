import { assert, assertMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20260826000000_business_claim_verification_guard.sql",
    import.meta.url,
  ),
);
const approvalMigration = await Deno.readTextFile(
  new URL(
    "../migrations/20260827000000_business_claim_approval_guard.sql",
    import.meta.url,
  ),
);
const schema = await Deno.readTextFile(new URL("../schema.sql", import.meta.url));
const features = await Deno.readTextFile(
  new URL("../../lib/features.ts", import.meta.url),
);
const marketplaceApi = await Deno.readTextFile(
  new URL("../../lib/marketplace-api.ts", import.meta.url),
);
const onboarding = await Deno.readTextFile(
  new URL("../../app/business-onboarding.tsx", import.meta.url),
);
const place = await Deno.readTextFile(
  new URL("../../app/place/[id].tsx", import.meta.url),
);
const releaseWorkflow = await Deno.readTextFile(
  new URL("../../.github/workflows/production-web-release.yml", import.meta.url),
);

Deno.test("claim authority fails closed in baseline and upgrade SQL", () => {
  for (const source of [schema, migration]) {
    assertMatch(source, /create or replace function public\.submit_business_claim/);
    assertMatch(source, /CLAIM_VERIFICATION_SERVICE_REQUIRED/);
  }
  assertMatch(migration, /revoke all on function public\.submit_business_claim[\s\S]*from public, anon/);
  assert(!migration.includes("submit_business_claim_core("));
  for (const source of [schema, approvalMigration]) {
    assertMatch(source, /require_business_claim_verification_receipt/);
    assertMatch(source, /if new\.state = 'approved'/);
    assertMatch(source, /CLAIM_VERIFICATION_RECEIPT_REQUIRED/);
    assertMatch(source, /before insert or update of state on public\.business_claims/);
  }
});

Deno.test("client and production release hide claims until verified proof exists", () => {
  assertMatch(features, /businessClaims:\s*enabled\(process\.env\.EXPO_PUBLIC_BUSINESS_CLAIMS_ENABLED\)/);
  const clientGuard = marketplaceApi.indexOf("if (!featureFlags.businessClaims)");
  const rpc = marketplaceApi.indexOf("client.rpc('submit_business_claim'", clientGuard);
  assert(clientGuard >= 0 && rpc > clientGuard);
  assertMatch(onboarding, /const claimRequested = value\(claimParams\.claim\) === '1'/);
  assertMatch(onboarding, /featureFlags\.businessClaims && claimRequested/);
  assertMatch(place, /featureFlags\.businessClaims[\s\S]*Claim this place/);
  assertMatch(releaseWorkflow, /EXPO_PUBLIC_BUSINESS_CLAIMS_ENABLED: "false"/);
});
