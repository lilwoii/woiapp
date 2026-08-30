import { assert, assertMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20261015000000_sponsored_viewability_accounting.sql",
    import.meta.url,
  ),
);
const edge = await Deno.readTextFile(
  new URL("../functions/public-discovery/index.ts", import.meta.url),
);
const marketplace = await Deno.readTextFile(
  new URL("../../lib/marketplace-api.ts", import.meta.url),
);
const discover = await Deno.readTextFile(
  new URL("../../app/(tabs)/index.tsx", import.meta.url),
);
const sponsoredLane = await Deno.readTextFile(
  new URL("../../components/sponsored-lane.tsx", import.meta.url),
);
const runtime = await Deno.readTextFile(
  new URL("./full_stack_security_runtime_test.sql", import.meta.url),
);

Deno.test("selection commits no unseen impression or budget reservation", () => {
  assertMatch(migration, /select_sponsored_placement_pre_render/);
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
    runtime,
    /Sponsored selection recorded an unseen impression or reservation/,
  );
});

Deno.test("a rendered impression atomically acquires the one held reservation", () => {
  const interactionStart = migration.indexOf(
    "create or replace function public.record_sponsored_interaction",
  );
  const interactionEnd = migration.indexOf(
    "revoke all on function public.record_sponsored_interaction",
    interactionStart,
  );
  const interaction = migration.slice(interactionStart, interactionEnd);
  assert(interactionStart >= 0 && interactionEnd > interactionStart);
  assertMatch(interaction, /interaction_type = 'impression'/);
  assertMatch(
    interaction,
    /from public\.ad_campaigns current_campaign[\s\S]*?for update/,
  );
  assertMatch(interaction, /budget_unavailable/);
  assertMatch(interaction, /insert into private\.ad_budget_reservations/);
  assertMatch(interaction, /insert into private\.ad_events/);
  assert(
    interaction.indexOf("insert into private.ad_budget_reservations") <
      interaction.indexOf("insert into private.ad_events"),
    "Reservation and impression must commit together in one transaction",
  );
  assertMatch(interaction, /impression_required/);
  assertMatch(interaction, /placement_dismissed/);
  const openLockStart = interaction.indexOf(
    "if interaction_type = 'open' and event_valid then",
  );
  const openCampaignLock = interaction.indexOf(
    "for update;",
    openLockStart,
  );
  const debitInsert = interaction.indexOf(
    "insert into private.billing_ledger",
    openLockStart,
  );
  assert(
    openLockStart >= 0 && openCampaignLock > openLockStart &&
      debitInsert > openCampaignLock,
    "Open must hold the campaign lock through reservation consumption and debit",
  );
  assertMatch(runtime, /duplicate_impression_receipt/);
});

Deno.test("interactions are Edge-only, subject-bound, and rate-limited", () => {
  assertMatch(
    migration,
    /drop function public\.record_sponsored_interaction\(text, text, text\)/,
  );
  assertMatch(
    migration,
    /revoke all on function public\.record_sponsored_interaction\(text, text, text, text\)[\s\S]*?to service_role/,
  );
  assertMatch(migration, /subject_hmac = interaction_subject_hmac/);
  assertMatch(migration, /request_count < 120/);
  assertMatch(edge, /interactionSubjectHmac/);
  assertMatch(edge, /record_sponsored_interaction/);
  assertMatch(edge, /SPONSORED_RATE_LIMITED/);
  assertMatch(
    edge,
    /requestedOperation === "sponsored_interaction"[\s\S]*?SPOTTR_SPONSORED_PLACEMENTS_ENABLED[\s\S]*?!==[\s\S]*?"true"/,
  );
  assertMatch(marketplace, /client\.functions\.invoke\('public-discovery'/);
  assertMatch(
    runtime,
    /Anonymous role unexpectedly recorded a sponsored interaction/,
  );
});

Deno.test("impression rechecks the exact public location snapshot", () => {
  assertMatch(migration, /selected_public_location_id/);
  assertMatch(migration, /from public\.public_business_locations location/);
  assertMatch(
    migration,
    /location\.latitude = decision\.selected_public_latitude/,
  );
  assertMatch(
    migration,
    /location\.longitude = decision\.selected_public_longitude/,
  );
  assertMatch(migration, /location_ineligible/);
  assertMatch(
    runtime,
    /Sponsored impression ignored a withdrawn public location/,
  );
  assertMatch(
    runtime,
    /Sponsored interaction accepted a different subject digest/,
  );
});

Deno.test("client acknowledges only after sustained viewport visibility", () => {
  assertMatch(sponsoredLane, /measureInWindow/);
  assertMatch(sponsoredLane, /MINIMUM_VISIBLE_RATIO = 0\.5/);
  assertMatch(sponsoredLane, /MINIMUM_VISIBLE_DURATION_MS = 1_000/);
  assertMatch(sponsoredLane, /AppState\.addEventListener\('change'/);
  assertMatch(sponsoredLane, /collapsable=\{false\}/);
  assertMatch(
    discover,
    /rankDiscoveryPlaces\(\[sponsoredProjection\], discoveryFilters/,
  );
  assertMatch(discover, /recordVisibleSponsoredImpression/);
  assertMatch(
    discover,
    /recordSponsoredInteraction\(placement\.token, 'impression'\)/,
  );
  assertMatch(
    discover,
    /acknowledgedSponsoredId === sponsoredPlace\.sponsoredPlacement\.id/,
  );
  assertMatch(sponsoredLane, /disabled=\{!interactionReady\}/);
  assert(
    discover.indexOf("rankDiscoveryPlaces([sponsoredProjection]") <
      discover.indexOf("recordVisibleSponsoredImpression"),
  );
});
