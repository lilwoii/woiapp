import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

const management = await Deno.readTextFile(
  new URL("../../lib/business-management.ts", import.meta.url),
);
const marketplace = await Deno.readTextFile(
  new URL("../../lib/marketplace-api.ts", import.meta.url),
);
const setupScreen = await Deno.readTextFile(
  new URL("../../app/business-setup.tsx", import.meta.url),
);
const onboardingScreen = await Deno.readTextFile(
  new URL("../../app/business-onboarding.tsx", import.meta.url),
);
const studioScreen = await Deno.readTextFile(
  new URL("../../app/(tabs)/studio.tsx", import.meta.url),
);
const schema = await Deno.readTextFile(
  new URL("../schema.sql", import.meta.url),
);
const serializationMigration = await Deno.readTextFile(
  new URL(
    "../migrations/20260904000000_business_setup_authority_serialization.sql",
    import.meta.url,
  ),
);
const submissionLocationReview = await Deno.readTextFile(
  new URL(
    "../migrations/20260927000000_business_submission_location_review.sql",
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

function sourceConstFunctionBody(source: string, name: string): string {
  const marker = `const ${name} =`;
  const start = source.indexOf(marker);
  assert(start >= 0, `missing source handler ${name}`);
  const open = source.indexOf("{", start + marker.length);
  assert(open >= 0, `missing source handler body ${name}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated source handler ${name}`);
}

function sqlFunctionBody(source: string, name: string): string {
  const start = source.indexOf(`create or replace function ${name}(`);
  const end = source.indexOf("$$;", start);
  assert(start >= 0 && end > start, `missing SQL function ${name}`);
  return source.slice(start, end);
}

function sqlStatement(source: string, marker: string): string {
  const start = source.indexOf(marker);
  const end = source.indexOf(";", start + marker.length);
  assert(start >= 0 && end > start, `missing SQL statement ${marker}`);
  return source.slice(start, end + 1);
}

const managementOperations = [
  "loadBusinessConfiguration",
  "savePrimaryLocation",
  "saveDraftServiceLocations",
  "saveWeeklyHours",
  "saveBusinessPayments",
  "saveBusinessSpecialHours",
  "saveDraftMobileStops",
  "loadPublishedMobileSchedule",
  "schedulePublishedMobileStop",
  "cancelPublishedMobileStop",
  "saveBusinessMenu",
  "submitBusinessConfiguration",
] as const;

const serializedRpcs = [
  ["nominate_business_logo", "if not private.can_manage_business_draft"],
  ["submit_business_revision", "if not private.is_business_member"],
  ["submit_business_for_review", "if not private.is_business_member"],
  ["schedule_mobile_stop", "if not private.is_business_member"],
  ["cancel_mobile_stop", "or not private.is_business_member"],
] as const;

const precedingTeamCores = [
  "invite_business_member",
  "respond_business_invitation",
  "set_business_member_role",
  "revoke_business_member",
  "revoke_business_invitation",
  "transfer_business_ownership",
] as const;

Deno.test("every business-management operation stays on its initiating account", () => {
  assertMatch(management, /createAccountBoundSupabaseClient/);
  assertMatch(
    management,
    /async function authorizeBusiness\(businessId: string, expectedUserId: string\)/,
  );
  assertMatch(
    management,
    /const client = await createAccountBoundSupabaseClient\(expectedUserId\)/,
  );
  assertEquals(
    management.match(/authorizeBusiness\(businessId, expectedUserId\)/g)?.length,
    managementOperations.length,
  );
  assert(!management.includes("client.auth.getUser()"));
  assert(!management.includes("client.auth.mfa.getAuthenticatorAssuranceLevel()"));

  for (const operation of managementOperations) {
    const body = sourceFunctionBody(management, operation);
    assertMatch(body, /expectedUserId: string/);
    assertMatch(body, /authorizeBusiness\(businessId, expectedUserId\)/);
  }
});

Deno.test("onboarding draft, claim, and complete logo flow use one bound client", () => {
  const createDraft = sourceFunctionBody(marketplace, "createBusinessDraft");
  const uploadLogo = sourceFunctionBody(marketplace, "uploadBusinessLogo");
  const submitClaim = sourceFunctionBody(marketplace, "submitBusinessClaim");

  for (const body of [createDraft, uploadLogo, submitClaim]) {
    assertMatch(body, /authenticatedUserId\(expectedUserId\)/);
    assertMatch(body, /marketplaceMutationClient\(expectedUserId\)/);
  }
  assertMatch(createDraft, /client\.rpc\('create_business_draft'/);
  assertMatch(submitClaim, /client\.rpc\('submit_business_claim'/);
  assertMatch(
    uploadLogo,
    /stageMediaUpload\([\s\S]*?businessId,[\s\S]*?undefined,[\s\S]*?client,[\s\S]*?\)/,
  );
  assertMatch(uploadLogo, /client\.rpc\('nominate_business_logo'/);
});

Deno.test("setup and onboarding clear private state and reject stale async results", () => {
  assertMatch(
    setupScreen,
    /key=\{`\$\{accountScope\}:\$\{accessScope\}:business-setup:\$\{businessId\}`\}/,
  );
  assertMatch(setupScreen, /const mounted = useRef\(true\)/);
  assertMatch(setupScreen, /const loadGeneration = useRef\(0\)/);
  assertMatch(setupScreen, /const mutationGeneration = useRef\(0\)/);
  assertMatch(setupScreen, /const mutationBusy = useRef\(false\)/);
  assertMatch(
    setupScreen,
    /loadBusinessConfiguration\(businessId, expectedUserId\)/,
  );
  assertMatch(
    setupScreen,
    /mounted\.current && mutationGeneration\.current === generation/,
  );
  for (const [handlerName, functionName] of [
    ["saveLocation", "saveDraftServiceLocations"],
    ["saveHours", "saveWeeklyHours"],
    ["saveSpecialHours", "saveBusinessSpecialHours"],
    ["saveMobileStops", "saveDraftMobileStops"],
    ["savePayments", "saveBusinessPayments"],
    ["saveMenu", "saveBusinessMenu"],
    ["submit", "submitBusinessConfiguration"],
  ] as const) {
    const handler = sourceConstFunctionBody(setupScreen, handlerName);
    assertMatch(handler, /const generation = beginMutation\(/);
    assertMatch(
      handler,
      new RegExp(`${functionName}\\([\\s\\S]*?expectedUserId\\s*\\)`),
    );
    assertMatch(handler, /isCurrentMutation\(generation\)/);
    assertMatch(handler, /finishMutation\(generation\)/);
  }

  assertMatch(
    onboardingScreen,
    /key=\{`\$\{accountScope\}:\$\{accessScope\}:business-onboarding:/,
  );
  assertMatch(onboardingScreen, /Verify your authenticator first\./);
  assertMatch(onboardingScreen, /router\.push\('\/security'\)/);
  assertMatch(onboardingScreen, /const mutationBusy = useRef\(false\)/);
  assertMatch(onboardingScreen, /mounted\.current = false/);
  const onboardingSubmit = sourceConstFunctionBody(onboardingScreen, "submit");
  assertMatch(onboardingSubmit, /const generation = beginMutation\(\)/);
  assertMatch(
    onboardingSubmit,
    /createBusinessDraft\([\s\S]*?expectedUserId\s*\)/,
  );
  assertMatch(
    onboardingSubmit,
    /uploadBusinessLogo\([\s\S]*?expectedUserId\s*\)/,
  );
  assertMatch(onboardingSubmit, /isCurrentMutation\(generation\)/);
  assertMatch(onboardingSubmit, /finishMutation\(generation\)/);

  const onboardingClaim = sourceConstFunctionBody(
    onboardingScreen,
    "submitClaim",
  );
  assertMatch(onboardingClaim, /const generation = beginMutation\(\)/);
  assertMatch(
    onboardingClaim,
    /submitBusinessClaim\([\s\S]*?expectedUserId\s*\)/,
  );
  assertMatch(onboardingClaim, /isCurrentMutation\(generation\)/);
  assertMatch(onboardingClaim, /finishMutation\(generation\)/);

  assertMatch(studioScreen, /const scheduleAccountId = useRef/);
  assertMatch(studioScreen, /const scheduleMutationBusy = useRef\(false\)/);
  const scheduleLoad = sourceConstFunctionBody(
    studioScreen,
    "refreshMobileSchedule",
  );
  assertMatch(scheduleLoad, /loadPublishedMobileSchedule\(place\.id, accountId\)/);
  assertMatch(scheduleLoad, /scheduleAccountId\.current !== accountId/);
  for (const [handlerName, functionName] of [
    ["saveScheduledStop", "schedulePublishedMobileStop"],
    ["cancelScheduledStop", "cancelPublishedMobileStop"],
  ] as const) {
    const handler = sourceConstFunctionBody(studioScreen, handlerName);
    assertMatch(handler, /scheduleMutationBusy\.current = true/);
    assertMatch(
      handler,
      new RegExp(`${functionName}\\([\\s\\S]*?initiatingAccountId\\s*\\)`),
    );
    assertMatch(handler, /!studioMounted\.current/);
    assertMatch(handler, /scheduleAccountId\.current !== initiatingAccountId/);
    assertMatch(
      handler,
      /scheduleScopeRef\.current !== initiatingScheduleScope/,
    );
    if (handlerName === "cancelScheduledStop") {
      assert(
        handler.indexOf("scheduleMutationBusy.current = true") <
          handler.indexOf("await confirmAction"),
        "cancelScheduledStop must reserve its mutation slot before confirmation",
      );
    }
  }
});

Deno.test("setup RPCs and draft RLS fail closed at AAL2", () => {
  for (const name of [
    "public.create_business_draft",
    "public.nominate_business_logo",
    "public.submit_business_claim",
    "public.submit_business_revision",
    "public.submit_business_for_review",
    "public.schedule_mobile_stop",
    "public.cancel_mobile_stop",
  ]) {
    assertMatch(sqlFunctionBody(schema, name), /private\.require_aal2\(\)/);
  }
  const draftAuthority = sqlFunctionBody(
    schema,
    "private.can_manage_business_draft",
  );
  assertMatch(draftAuthority, /private\.has_aal2\(\)/);
  assertMatch(draftAuthority, /array\['owner', 'manager'\]/);
  assertMatch(
    schema,
    /create policy "owners and managers read permit status"[\s\S]*?using \([\s\S]*?private\.has_aal2\(\)[\s\S]*?private\.is_business_member\([\s\S]*?\);/,
  );
  assertMatch(
    serializationMigration,
    /drop policy if exists "owners and managers read permit status"[\s\S]*?create policy "owners and managers read permit status"[\s\S]*?private\.has_aal2\(\)[\s\S]*?private\.is_business_member\(/,
  );

  const createDraft = sqlFunctionBody(schema, "public.create_business_draft");
  assertMatch(createDraft, /pg_advisory_xact_lock/);
  assertMatch(createDraft, /private\.rpc_idempotency/);
  assertMatch(
    sqlFunctionBody(schema, "public.submit_business_claim"),
    /CLAIM_VERIFICATION_SERVICE_REQUIRED/,
  );
});

Deno.test("mobile submission review selects public pins and initial stops atomically", () => {
  const detail = sqlFunctionBody(
    submissionLocationReview,
    "public.get_pending_business_submission",
  );
  const review = sqlFunctionBody(
    submissionLocationReview,
    "public.review_business_submission",
  );
  const locationPublication = sqlFunctionBody(
    submissionLocationReview,
    "public.set_business_location_publication",
  );
  const legacyPublication = sqlFunctionBody(
    submissionLocationReview,
    "public.set_business_publication",
  );

  for (const body of [detail, review]) {
    assertMatch(body, /private\.require_aal2\(\)/);
    assertMatch(body, /private\.is_platform_staff/);
    assertMatch(body, /array\['admin'\]/);
  }
  assertMatch(review, /from public\.businesses business[\s\S]*?for update/);
  assertMatch(review, /target_kind not in \('food_truck', 'pop_up'\)/);
  assertMatch(review, /primary_location_id = any\(approved_location_ids\)/);
  assertMatch(review, /pg_advisory_xact_lock/);
  assertMatch(review, /MOBILE_STOP_TIME_OVERLAP/);
  assertMatch(review, /stop\.location_id = any\(approved_location_ids\)/);
  assertMatch(review, /stop\.state = 'draft'/);
  assertMatch(review, /stop\.starts_at < now\(\) - interval '15 minutes'/);
  assertMatch(review, /'business\.submission_approved'/);
  assert(
    review.indexOf("update public.business_locations") <
      review.indexOf("update public.businesses"),
    "selected locations must publish before the business publication trigger runs",
  );
  assert(
    review.indexOf("update public.businesses") <
      review.indexOf("update public.mobile_stops"),
    "draft stops must promote only after the business is public",
  );
  assertMatch(locationPublication, /MOBILE_SUBMISSION_SELECTION_REQUIRED/);
  assertMatch(locationPublication, /and not target_is_primary/);
  assertMatch(
    locationPublication,
    /from public\.businesses business[\s\S]*?where business\.id = target_business_id[\s\S]*?for update/,
  );
  assert(
    locationPublication.indexOf("from public.businesses business") <
      locationPublication.indexOf("private.is_business_member"),
    "location publication must lock the business before revalidating membership",
  );
  assertMatch(legacyPublication, /MOBILE_SUBMISSION_SELECTION_REQUIRED/);
  assertMatch(legacyPublication, /old_state = 'pending'/);
  assertMatch(
    submissionLocationReview,
    /revoke all on function public\.get_pending_business_submission\(uuid\) from public;/,
  );
  assertMatch(
    submissionLocationReview,
    /grant execute on function public\.review_business_submission\(uuid, uuid\[\], uuid\[\], text\)[\s\S]*?to authenticated;/,
  );
  assert(!submissionLocationReview.includes("to service_role"));
});

Deno.test("setup authority serialization is identical for baseline and upgrades", () => {
  for (const [rpcName, authorityMarker] of serializedRpcs) {
    const baseline = sqlFunctionBody(schema, `public.${rpcName}`);
    const lock = baseline.match(/from public\.businesses [a-z]+[\s\S]*?for update/);
    assert(lock, `${rpcName} must lock the business`);
    assert(
      baseline.indexOf(lock[0]) < baseline.indexOf(authorityMarker),
      `${rpcName} must lock before authority evaluation`,
    );

    const upgraded = sqlFunctionBody(
      serializationMigration,
      `public.${rpcName}`,
    );
    assertMatch(upgraded, /private\.require_aal2\(\)/);
    assertMatch(
      upgraded,
      /from public\.businesses business[\s\S]*?where business\.id = target_business_id[\s\S]*?for update/,
    );
    assert(
      upgraded.indexOf("for update") <
        upgraded.indexOf(`private.${rpcName}_core(`),
      `${rpcName} wrapper must lock before delegating`,
    );
    assert(
      upgraded.includes(`private.${rpcName}_core(`),
      `${rpcName} wrapper must delegate to its private core`,
    );
    assert(
      serializationMigration.includes(`rename to ${rpcName}_core;`),
      `${rpcName} upgrade must privatize the previous implementation`,
    );
    assertMatch(
      sqlStatement(
        serializationMigration,
        `revoke all on function private.${rpcName}_core(`,
      ),
      /from public, anon, authenticated, service_role;/,
    );
    assertMatch(
      sqlStatement(
        serializationMigration,
        `revoke all on function public.${rpcName}(`,
      ),
      /from public, anon, authenticated;/,
    );
    assertMatch(
      sqlStatement(
        serializationMigration,
        `grant execute on function public.${rpcName}(`,
      ),
      /to authenticated;/,
    );
  }

  for (const rpcName of precedingTeamCores) {
    assertMatch(
      sqlStatement(
        serializationMigration,
        `revoke all on function private.${rpcName}_core(`,
      ),
      /from service_role;/,
    );
  }
});
