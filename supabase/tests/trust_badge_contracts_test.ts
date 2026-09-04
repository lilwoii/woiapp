import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

const catalog = await Deno.readTextFile(
  new URL("../../lib/trust-badges.ts", import.meta.url),
);
const strip = await Deno.readTextFile(
  new URL("../../components/trust-badge-strip.tsx", import.meta.url),
);
const place = await Deno.readTextFile(
  new URL("../../app/place/[id].tsx", import.meta.url),
);
const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20260906000000_trust_badge_foundation.sql",
    import.meta.url,
  ),
);

function codes(source: string, pattern: RegExp) {
  return [...source.matchAll(pattern)].map((match) => match[1]).sort();
}

Deno.test("client and database badge catalogs stay synchronized", () => {
  const clientCodes = codes(catalog, /code: '([a-z0-9_]+)'/g);
  const databaseCodes = codes(
    migration,
    /^\s{2}\('([a-z0-9_]+)', '(?:reviewer|business|seller)'/gm,
  );
  assert(clientCodes.length >= 30, "Spottr must launch with a meaningful achievement catalog");
  assertEquals(databaseCodes, clientCodes);
  assert(clientCodes.includes("spottr_orders_1000"));
  assert(clientCodes.includes("truck_tracker_20"));
  assert(!catalog.toLocaleLowerCase().includes("elite squad"));
});

Deno.test("badge awards are server-owned and public projections hide evidence", () => {
  assertMatch(migration, /alter table public\.profile_badge_awards enable row level security/);
  assertMatch(migration, /alter table public\.business_badge_awards enable row level security/);
  assertMatch(
    migration,
    /revoke all on table public\.profile_badge_awards from anon, authenticated, service_role/,
  );
  assertMatch(
    migration,
    /revoke all on function private\.refresh_profile_review_badges\(uuid\) from public, anon, authenticated, service_role/,
  );
  const publicProfileView = migration.slice(
    migration.indexOf("create or replace view public.public_profile_badges"),
    migration.indexOf("create or replace view public.public_business_badges"),
  );
  assert(!publicProfileView.includes("evidence_snapshot"));
  assert(!publicProfileView.includes("subject_id,"));
  assertMatch(publicProfileView, /a\.revoked_at is null/);
  assertMatch(publicProfileView, /a\.expires_at > now\(\)/);
});

Deno.test("review badges are inspectable with hover, tap, and a full guide", () => {
  assertMatch(strip, /onHoverIn/);
  assertMatch(strip, /onPress/);
  assertMatch(strip, /badgeAccessibilityLabel/);
  assertMatch(strip, /router\.push\('\/badges'\)/);
  assertMatch(place, /<TrustBadgeStrip badges=\{item\.badges \?\? \[\]\}/);
});

Deno.test("automatic reviewer awards use approved eligible activity", () => {
  assertMatch(migration, /r\.moderation = 'approved'/);
  assertMatch(migration, /r\.deleted_at is null/);
  assertMatch(migration, /ma\.moderation = 'approved'/);
  assertMatch(migration, /ma\.quarantine_state = 'clean'/);
  assertMatch(migration, /on conflict \(subject_id, badge_code\) do nothing/);
  assertMatch(migration, /after insert or update of moderation, deleted_at, helpful_count or delete on public\.reviews/);
});
