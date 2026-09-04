import { assert, assertMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20261022000000_sponsored_exact_location_projection.sql",
    import.meta.url,
  ),
);
const edgeContract = await Deno.readTextFile(
  new URL("../functions/public-discovery/contract.ts", import.meta.url),
);
const marketplace = await Deno.readTextFile(
  new URL("../../lib/marketplace-api.ts", import.meta.url),
);
const marketplaceTypes = await Deno.readTextFile(
  new URL("../../types/marketplace.ts", import.meta.url),
);
const productionWorkflow = await Deno.readTextFile(
  new URL(
    "../../.github/workflows/production-web-release.yml",
    import.meta.url,
  ),
);
const runtime = await Deno.readTextFile(
  new URL("./full_stack_security_runtime_test.sql", import.meta.url),
);
const mobileAuthority = await Deno.readTextFile(
  new URL(
    "../migrations/20260904000000_business_setup_authority_serialization.sql",
    import.meta.url,
  ),
);

Deno.test("sponsored selection binds a deterministic eligible public branch", () => {
  const selectorStart = migration.indexOf(
    "create or replace function public.select_sponsored_placement",
  );
  const selectorEnd = migration.indexOf(
    "revoke all on function public.select_sponsored_placement",
    selectorStart,
  );
  const selector = migration.slice(selectorStart, selectorEnd);

  assert(selectorStart >= 0 && selectorEnd > selectorStart);
  assertMatch(selector, /security definer\s+set search_path = ''/);
  assertMatch(selector, /from public\.public_business_locations location/);
  assertMatch(
    selector,
    /order by public\.st_distance\([\s\S]*?\), location\.location_id\s+limit 1/,
  );
  assertMatch(
    selector,
    /selected_public_location_id = selected_location_id/,
  );
  assertMatch(selector, /'location_id', selected_location_id/);
  assert(
    !selector.includes("from public.business_locations location"),
    "Sponsored branch selection must not cross the public redaction boundary",
  );
});

Deno.test("sponsorship and nearby discovery share mobile branch authority", () => {
  assertMatch(
    migration,
    /create or replace function private\.effective_mobile_public_location_id\(/,
  );
  assertMatch(
    migration,
    /from public\.mobile_stops stop[\s\S]*?case when stop\.state = 'live' then 0 else 1 end[\s\S]*?from public\.public_business_mobile_service moving[\s\S]*?primary_location\.is_primary desc, primary_location\.id/,
  );
  const selectorStart = migration.indexOf(
    "create or replace function public.select_sponsored_placement",
  );
  const nearbyStart = migration.indexOf(
    "create or replace function public.nearby_businesses",
  );
  assert(
    selectorStart >= 0 && nearbyStart >= 0 &&
      migration.indexOf(
          "private.effective_mobile_public_location_id(business.id)",
          selectorStart,
        ) > selectorStart &&
      migration.indexOf(
          "private.effective_mobile_public_location_id(business.id)",
          nearbyStart,
        ) > nearbyStart,
  );
  assertMatch(
    migration,
    /revoke all on function private\.effective_mobile_public_location_id\(uuid\)[\s\S]*?from public, anon, authenticated, service_role/,
  );
});

Deno.test("exact branch projection preserves viewability and service-only ACLs", () => {
  assertMatch(
    migration,
    /delete from private\.ad_events event[\s\S]*?event\.event_type = 'impression'/,
  );
  assertMatch(
    migration,
    /delete from private\.ad_budget_reservations reservation/,
  );
  assertMatch(
    migration,
    /removed_event_count <> 1 or removed_reservation_count <> 1[\s\S]*?SPONSORED_SELECTION_INVALID/,
  );
  assertMatch(
    migration,
    /revoke all on function public\.select_sponsored_placement\([\s\S]*?from public, anon, authenticated, service_role/,
  );
  assertMatch(
    migration,
    /grant execute on function public\.select_sponsored_placement\([\s\S]*?to service_role/,
  );
});

Deno.test("billable open revalidates the exact branch and releases stale holds", () => {
  const interactionStart = migration.indexOf(
    "create or replace function public.record_sponsored_interaction",
  );
  const interactionEnd = migration.indexOf(
    "revoke all on function public.record_sponsored_interaction",
    interactionStart,
  );
  const interaction = migration.slice(interactionStart, interactionEnd);
  const snapshotChecks = interaction.match(
    /private\.is_sponsored_public_location_snapshot_current/g,
  ) ?? [];
  const decisionQuery = interaction.indexOf("select * into decision");
  const decisionLock = interaction.indexOf("for update;", decisionQuery);
  const impressionStart = interaction.indexOf(
    "if interaction_type = 'impression' and event_valid then",
  );
  const directInteractionStart = interaction.indexOf(
    "elsif interaction_type in ('open', 'menu_view', 'directions')",
    impressionStart,
  );
  const impressionCampaignQuery = interaction.indexOf(
    "from public.ad_campaigns current_campaign",
    impressionStart,
  );
  const impressionCampaignLock = interaction.indexOf(
    "for update;",
    impressionCampaignQuery,
  );
  const impressionBusinessQuery = interaction.indexOf(
    "from public.businesses target_business",
    impressionCampaignLock,
  );
  const impressionBusinessLock = interaction.indexOf(
    "for update;",
    impressionBusinessQuery,
  );
  const impressionSnapshot = interaction.indexOf(
    "private.is_sponsored_public_location_snapshot_current",
    impressionBusinessLock,
  );
  const impressionReservation = interaction.indexOf(
    "insert into private.ad_budget_reservations",
    impressionSnapshot,
  );
  const openEligibilityStart = interaction.indexOf(
    "if interaction_type = 'open' and event_valid then",
    directInteractionStart,
  );
  const openCampaignQuery = interaction.indexOf(
    "from public.ad_campaigns current_campaign",
    openEligibilityStart,
  );
  const openCampaignLock = interaction.indexOf(
    "for update;",
    openCampaignQuery,
  );
  const openBusinessQuery = interaction.indexOf(
    "from public.businesses target_business",
    openCampaignLock,
  );
  const openBusinessLock = interaction.indexOf(
    "for update;",
    openBusinessQuery,
  );
  const openBoundary = interaction.indexOf("if interaction_type = 'open' then");
  const finalLocationCheck = interaction.indexOf(
    "private.is_sponsored_public_location_snapshot_current",
    openBoundary,
  );
  const consume = interaction.indexOf("set state = 'consumed'", openBoundary);
  const debit = interaction.indexOf(
    "insert into private.billing_ledger",
    openBoundary,
  );

  assert(interactionStart >= 0 && interactionEnd > interactionStart);
  assert(
    snapshotChecks.length >= 2,
    "Impression and open must both revalidate the mobile-aware location snapshot",
  );
  assert(
    decisionQuery >= 0 && decisionLock > decisionQuery &&
      impressionStart > decisionLock &&
      impressionCampaignLock > impressionCampaignQuery &&
      impressionBusinessLock > impressionBusinessQuery &&
      impressionCampaignLock < impressionBusinessLock &&
      impressionBusinessLock < impressionSnapshot &&
      impressionSnapshot < impressionReservation &&
      impressionReservation < directInteractionStart,
    "Impression lock order must be decision -> campaign -> business -> snapshot -> reservation",
  );
  assert(
    openCampaignLock > openCampaignQuery &&
      openBusinessLock > openBusinessQuery &&
      openCampaignLock < openBusinessLock &&
      openBusinessLock < openBoundary &&
      openBoundary < finalLocationCheck &&
      finalLocationCheck < consume && consume < debit,
    "Open must hold campaign then business across snapshot, reservation, and debit",
  );
  assert(openBoundary >= 0 && finalLocationCheck > openBoundary);
  assertMatch(
    interaction.slice(openBoundary),
    /invalid_reason_value := 'location_ineligible'[\s\S]*?set valid = false[\s\S]*?set state = 'released'/,
  );
  assertMatch(
    migration,
    /revoke all on function public\.record_sponsored_interaction\(text, text, text, text\)[\s\S]*?to service_role/,
  );
});

Deno.test("supported mobile mutations take the same business row barrier", () => {
  const scheduleStart = mobileAuthority.indexOf(
    "create or replace function public.schedule_mobile_stop",
  );
  const cancelStart = mobileAuthority.indexOf(
    "create or replace function public.cancel_mobile_stop",
  );
  const scheduleBody = mobileAuthority.slice(scheduleStart, cancelStart);
  const cancelBody = mobileAuthority.slice(cancelStart);

  assert(scheduleStart >= 0 && cancelStart > scheduleStart);
  assertMatch(
    scheduleBody,
    /from public\.businesses business[\s\S]*?for update;[\s\S]*?private\.schedule_mobile_stop_core/,
  );
  assertMatch(
    cancelBody,
    /from public\.businesses business[\s\S]*?for update;[\s\S]*?private\.cancel_mobile_stop_core/,
  );
});

Deno.test("runtime probe covers mobile selection and impression-to-open movement", () => {
  assertMatch(runtime, /sponsored_mobile_location_authority/);
  assertMatch(
    runtime,
    /result->>'location_id' <> '73100000-0000-4000-8000-000000000007'/,
  );
  assertMatch(runtime, /runtime:sponsor:mobile:impression/);
  assertMatch(runtime, /runtime:sponsor:mobile:open/);
  assertMatch(
    runtime,
    /Sponsored open ignored an impression-to-open location change/,
  );
});

Deno.test("Edge and client require and retain the server-selected branch", () => {
  assertMatch(
    edgeContract,
    /exactKeys\(row, \[[\s\S]*?"business_id",[\s\S]*?"location_id",[\s\S]*?"placement_id"/,
  );
  assertMatch(edgeContract, /!isUuid\(row\.location_id\)/);
  assertMatch(edgeContract, /location_id: row\.location_id/);
  assertMatch(
    marketplaceTypes,
    /sponsoredPlacement: \{[\s\S]*?locationId: string/,
  );
  assertMatch(
    marketplace,
    /const sponsoredLocationId = normalizePublicUuid\(\s*stringValue\(sponsoredRow\?\.location_id\),?\s*\)/,
  );
  assertMatch(marketplace, /locationId: sponsoredLocationId/);
  assertMatch(
    marketplace,
    /sponsoredLocationPlace\.locationId === sponsoredPlacement\.locationId/,
  );
  assertMatch(
    marketplace,
    /rows\(locationsResult\.data\)\.find\([\s\S]*?locationIdOf\(location\) === sponsoredPlacement\.locationId/,
  );
});

Deno.test("production sponsored serving remains disabled", () => {
  assertMatch(
    productionWorkflow,
    /EXPO_PUBLIC_SPONSORED_PLACEMENTS_ENABLED: "false"/,
  );
  assert(!migration.includes("update private.ad_runtime_config"));
  assert(!migration.includes("enabled = true"));
});
