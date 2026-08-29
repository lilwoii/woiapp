import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

const contentModeration = await Deno.readTextFile(
  new URL("../../lib/content-moderation.ts", import.meta.url),
);
const marketplaceOperations = await Deno.readTextFile(
  new URL("../../lib/marketplace-operations.ts", import.meta.url),
);
const businessModeration = await Deno.readTextFile(
  new URL("../../lib/business-submission-moderation.ts", import.meta.url),
);
const contentScreen = await Deno.readTextFile(
  new URL("../../app/moderation.tsx", import.meta.url),
);
const marketplaceScreen = await Deno.readTextFile(
  new URL("../../app/marketplace-moderation.tsx", import.meta.url),
);
const businessScreen = await Deno.readTextFile(
  new URL("../../app/business-submission-moderation.tsx", import.meta.url),
);
const businessScreenImplementation = await Deno.readTextFile(
  new URL(
    "../../components/business-submission-moderation-screen.tsx",
    import.meta.url,
  ),
);
const layout = await Deno.readTextFile(
  new URL("../../app/_layout.tsx", import.meta.url),
);

Deno.test("all privileged moderation clients bind calls to the initiating account", () => {
  for (const source of [contentModeration, marketplaceOperations, businessModeration]) {
    assertMatch(source, /createAccountBoundSupabaseClient/);
    assertMatch(source, /createAccountBoundSupabaseClient\(expectedAccountId\)/);
    assert(
      !source.includes("supabase.auth.getUser()"),
      "A privileged moderation layer must not return the mutable shared client",
    );
  }
  assertEquals(
    contentModeration.match(/await secureClient\(expectedAccountId\)/g)?.length,
    2,
  );
  assertEquals(
    marketplaceOperations.match(/await client\(expectedAccountId\)/g)?.length,
    4,
  );
  assertEquals(
    businessModeration.match(/await secureClient\(expectedAccountId\)/g)?.length,
    4,
  );
});

Deno.test("moderation workspaces remount and invalidate requests on identity changes", () => {
  for (const source of [
    contentScreen,
    marketplaceScreen,
    businessScreenImplementation,
  ]) {
    assertMatch(source, /workspaceKey/);
    assertMatch(source, /auth\.account\?\.id/);
    assertMatch(source, /auth\.securityStatus/);
    assertMatch(source, /auth\.assuranceLevel/);
    assertMatch(source, /auth\.mfaEnrolled/);
    assertMatch(source, /mounted\.current = false/);
    assertMatch(source, /Generation\.current \+= 1/);
  }
  assertMatch(
    contentScreen,
    /loadModerationQueue\(accountId, offset\)/,
  );
  assertMatch(
    contentScreen,
    /decideModerationItem\(accountId, item, decision, reason\)/,
  );
  assertMatch(
    marketplaceScreen,
    /loadReportedChatMessages\(accountId\)/,
  );
  assertMatch(
    marketplaceScreen,
    /moderateReportedChatMessage\(accountId, item, visibility, reason\)/,
  );
});

Deno.test("business approval UI exposes exact selection without persisting protected detail", () => {
  assertMatch(
    businessScreenImplementation,
    /loadPendingMobileSubmission\(accountId, submission\.businessId\)/,
  );
  assertMatch(
    businessScreenImplementation,
    /locations\.filter\(\(location\) => location\.isPrimary\)/,
  );
  assertMatch(businessScreenImplementation, /validateMobileReviewSelection/);
  assertMatch(businessScreenImplementation, /Approve &amp; publish/);
  assertMatch(businessScreenImplementation, /Return for changes/);
  assert(!businessScreenImplementation.includes("localStorage"));
  assert(!businessScreenImplementation.includes("AsyncStorage"));
  assert(!businessScreenImplementation.includes("analytics"));
  assertMatch(
    layout,
    /Stack\.Screen name="business-submission-moderation"/,
  );
  assertMatch(
    contentScreen,
    /router\.push\('\/business-submission-moderation' as Href\)/,
  );
});

Deno.test(
  "business approval route lazy-loads the protected workspace with an accessible fallback",
  () => {
    assertMatch(
      businessScreen,
      /lazy\(\s*\(\) => import\('@\/components\/business-submission-moderation-screen'\)/,
    );
    assertMatch(businessScreen, /Suspense/);
    assertMatch(businessScreen, /<PageShell narrow>/);
    assertMatch(businessScreen, /accessibilityRole="header"/);
    assertMatch(businessScreen, /Loading the secure approval workspace…/);
    assert(
      !businessScreen.includes("loadPendingMobileSubmission"),
      "The route shell must not eagerly include the protected moderation implementation",
    );
  },
);
