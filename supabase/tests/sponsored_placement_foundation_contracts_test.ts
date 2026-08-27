import { assert, assertMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20260830000000_sponsored_placement_foundation.sql",
    import.meta.url,
  ),
);
const edge = await Deno.readTextFile(
  new URL("../functions/public-discovery/index.ts", import.meta.url),
);
const marketplace = await Deno.readTextFile(
  new URL("../../lib/marketplace-api.ts", import.meta.url),
);
const discoveryRanking = await Deno.readTextFile(
  new URL("../../lib/discovery-filters.ts", import.meta.url),
);
const releaseWorkflow = await Deno.readTextFile(
  new URL("../../.github/workflows/production-web-release.yml", import.meta.url),
);
const maintenance = await Deno.readTextFile(
  new URL("../../scripts/production-maintenance.mjs", import.meta.url),
);

Deno.test("sponsored foundation is contextual, private, and disabled by default", () => {
  assertMatch(migration, /create table if not exists private\.ad_runtime_config/);
  assertMatch(migration, /enabled boolean not null default false/);
  assertMatch(migration, /shadow_only boolean not null default true/);
  assertMatch(migration, /create table if not exists private\.ad_serving_decisions/);
  assertMatch(migration, /create table if not exists private\.ad_events/);
  assertMatch(migration, /create table if not exists private\.ad_budget_reservations/);
  assertMatch(migration, /create table if not exists private\.billing_ledger/);
  assertMatch(migration, /BILLING_LEDGER_APPEND_ONLY/);
  assertMatch(
    migration,
    /revoke all on table[\s\S]*private\.billing_ledger[\s\S]*from public, anon, authenticated, service_role/,
  );
});
Deno.test("selection is service-only, budget locked, privacy-safe, and organically separate", () => {
  assertMatch(migration, /create or replace function public\.select_sponsored_placement/);
  assertMatch(migration, /for update of campaign skip locked/);
  assertMatch(migration, /private\.is_business_publicly_eligible\(business\.id\)/);
  assertMatch(migration, /business\.verification = 'verified'/);
  assertMatch(migration, /target_account_id is null[\s\S]*not private\.is_business_member/);
  assertMatch(migration, /organic_filter_hash char\(64\)/);
  assert(!migration.includes("raw_ip"));
  assertMatch(
    migration,
    /revoke all on function public\.select_sponsored_placement[\s\S]*from public, anon, authenticated[\s\S]*grant execute on function public\.select_sponsored_placement[\s\S]*to service_role/,
  );
  assert(!discoveryRanking.includes("sponsoredPlacement"));
  assertMatch(edge, /select_sponsored_placement/);
  assertMatch(edge, /Ads must fail closed without taking organic discovery down/);
});

Deno.test("interaction receipts are token-bound, idempotent, and never trust client price", () => {
  assertMatch(migration, /create or replace function public\.record_sponsored_interaction/);
  assertMatch(migration, /token_hash = private\.ad_sha256_hex\(placement_token\)/);
  assertMatch(migration, /on conflict \(decision_id, event_type\) do nothing/);
  assertMatch(migration, /decision\.reserved_minor/);
  assert(!/record_sponsored_interaction[\s\S]*client_price/i.test(migration));
  assertMatch(
    migration,
    /grant execute on function public\.record_sponsored_interaction\(text, text, text\)[\s\S]*to anon, authenticated/,
  );
  assertMatch(migration, /where decision_id = decision\.id and state = 'held'[\s\S]*returning id into reservation_id/);
  assertMatch(migration, /reservation_unavailable/);
  assert(
    migration.indexOf("returning id into reservation_id") < migration.indexOf("'sponsored_open', event_id"),
    "A real-money debit must only be inserted after consuming a held reservation",
  );
  assertMatch(marketplace, /recordSponsoredInteraction/);
});

Deno.test("production keeps sponsorship fail-closed and maintenance drains reservations", () => {
  assertMatch(
    releaseWorkflow,
    /EXPO_PUBLIC_SPONSORED_PLACEMENTS_ENABLED: "false"/,
  );
  assertMatch(migration, /create or replace function public\.reconcile_sponsored_reservations/);
  assertMatch(migration, /pg_try_advisory_xact_lock/);
  assertMatch(migration, /for update of reservation skip locked/);
  assertMatch(maintenance, /reconcile_sponsored_reservations/);
  assert(
    maintenance.indexOf("reconcile_sponsored_reservations") <
      maintenance.indexOf("const heartbeat = await fetchImpl"),
  );
});
