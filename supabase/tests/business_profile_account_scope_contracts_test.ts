import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

const businessProfile = await Deno.readTextFile(
  new URL("../../lib/business-profile.ts", import.meta.url),
);
const businessProfileScreen = await Deno.readTextFile(
  new URL("../../app/business-profile.tsx", import.meta.url),
);
const schema = await Deno.readTextFile(
  new URL("../schema.sql", import.meta.url),
);

function sourceFunctionBody(source: string, name: string): string {
  const marker = `export async function ${name}(`;
  const start = source.indexOf(marker);
  const next = source.indexOf("\nexport async function ", start + marker.length);
  assert(start >= 0, `missing source function ${name}`);
  return source.slice(start, next >= 0 ? next : source.length);
}

function schemaFunctionBody(name: string): string {
  const start = schema.indexOf(`create or replace function ${name}(`);
  const end = schema.indexOf("$$;", start);
  assert(start >= 0 && end > start, `missing database function ${name}`);
  return schema.slice(start, end);
}

function schemaPolicyBody(name: string): string {
  const start = schema.indexOf(`create policy "${name}"`);
  const end = schema.indexOf(";", start);
  assert(start >= 0 && end > start, `missing database policy ${name}`);
  return schema.slice(start, end);
}

Deno.test("business profile operations use one verified account-bound client", () => {
  assertMatch(businessProfile, /createAccountBoundSupabaseClient/);
  assertMatch(
    businessProfile,
    /async function secureClient\(expectedUserId: string, businessId\?: string\)/,
  );
  assertMatch(
    businessProfile,
    /const client = await createAccountBoundSupabaseClient\(expectedUserId\)/,
  );
  assertEquals(
    businessProfile.match(/secureClient\(expectedUserId, businessId\)/g)?.length,
    3,
    "Load, save, and logo staging must bind authorization to the initiating account",
  );
  assertMatch(
    businessProfile,
    /withdrawBusinessProfileRevision[\s\S]*?secureClient\(expectedUserId\)/,
  );
  assert(
    !businessProfile.includes("supabase.auth.getUser()"),
    "The profile layer must not verify one account and return the mutable shared client",
  );
  assert(
    !businessProfile.includes("supabase.auth.mfa.getAuthenticatorAssuranceLevel()"),
    "A shared-session assurance lookup cannot authorize a bound-account operation",
  );
});

Deno.test("business logo stage, upload, registration, and nomination share the bound client", () => {
  const logoStage = sourceFunctionBody(businessProfile, "stageBusinessProfileLogo");
  assertMatch(
    logoStage,
    /stageMediaUpload\(\s*clean,\s*'business_logo',\s*businessId,\s*undefined,\s*client\s*\)/,
  );
  assertMatch(
    logoStage,
    /const \{ client \} = await secureClient\(expectedUserId, businessId\)[\s\S]*?client\.rpc\('nominate_business_logo'/,
  );
});

Deno.test("database profile reads and mutations independently require AAL2", () => {
  for (const name of [
    "public.update_business_draft_profile",
    "public.submit_business_revision",
    "public.get_my_pending_business_revision",
    "public.withdraw_business_revision",
    "public.nominate_business_logo",
  ]) {
    assertMatch(schemaFunctionBody(name), /private\.require_aal2\(\)/);
  }
  const privateDetailsPolicy = schemaPolicyBody(
    "owners and managers read private details",
  );
  assertMatch(privateDetailsPolicy, /private\.has_aal2\(\)/);
  assertMatch(privateDetailsPolicy, /private\.is_business_member/);
});

Deno.test("business profile UI remounts and rejects delayed results for every account scope", () => {
  assertMatch(businessProfileScreen, /const auth = useAuth\(\)/);
  assertMatch(
    businessProfileScreen,
    /key=\{`\$\{accountId\}:business-profile:\$\{businessId\}`\}/,
  );
  assertMatch(businessProfileScreen, /mounted\.current = false/);
  assertMatch(businessProfileScreen, /loadGeneration\.current \+= 1/);
  assertMatch(businessProfileScreen, /mutationGeneration\.current \+= 1/);
  assertMatch(
    businessProfileScreen,
    /if \(!mounted\.current \|\| loadGeneration\.current !== generation\) return/,
  );
  assertMatch(
    businessProfileScreen,
    /mounted\.current && mutationGeneration\.current === generation/,
  );
  assertMatch(
    businessProfileScreen,
    /loadBusinessProfileWorkspace\(businessId, expectedUserId\)/,
  );
  assertMatch(
    businessProfileScreen,
    /stageBusinessProfileLogo\(\s*businessId,\s*workspace\.state,\s*logoSelection,\s*expectedUserId\s*\);/,
  );
  assertMatch(
    businessProfileScreen,
    /saveBusinessProfile\(\s*businessId,\s*workspace\.state,\s*nextValues,\s*expectedUserId\s*\);/,
  );
  assertMatch(
    businessProfileScreen,
    /withdrawBusinessProfileRevision\(\s*revision\.revisionId,\s*expectedUserId\s*\);/,
  );
  assertMatch(
    businessProfileScreen,
    /setWorkspace\(null\)[\s\S]*?setValues\(null\)[\s\S]*?loadBusinessProfileWorkspace/,
  );
});
