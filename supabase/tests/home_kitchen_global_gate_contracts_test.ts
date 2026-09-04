import { assert, assertMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20260929000000_home_kitchen_global_launch_gate.sql",
    import.meta.url,
  ),
);
const legacyPickupWriters = await Deno.readTextFile(
  new URL(
    "../migrations/20260812000000_neighborhood_meetup_launch_contract.sql",
    import.meta.url,
  ),
);
const schema = await Deno.readTextFile(
  new URL("../schema.sql", import.meta.url),
);
const runtime = await Deno.readTextFile(
  new URL("./full_stack_security_runtime_test.sql", import.meta.url),
);
const marketplaceApi = await Deno.readTextFile(
  new URL("../../lib/marketplace-api.ts", import.meta.url),
);
const placeRoute = await Deno.readTextFile(
  new URL("../../app/place/[id].tsx", import.meta.url),
);
const messagesRoute = await Deno.readTextFile(
  new URL("../../app/messages/[id].tsx", import.meta.url),
);
const orderRoute = await Deno.readTextFile(
  new URL("../../app/order/[id].tsx", import.meta.url),
);
const discoveryRoute = await Deno.readTextFile(
  new URL("../../app/(tabs)/index.tsx", import.meta.url),
);
const features = await Deno.readTextFile(
  new URL("../../lib/features.ts", import.meta.url),
);

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert(startIndex >= 0, `missing section start: ${start}`);
  assert(endIndex > startIndex, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

Deno.test("home-kitchen launch state is private and fail-closed by default", () => {
  for (const source of [schema, migration]) {
    assertMatch(
      source,
      /create table if not exists private\.home_kitchen_runtime_settings[\s\S]+enabled boolean not null default false/,
    );
    assertMatch(
      source,
      /insert into private\.home_kitchen_runtime_settings[\s\S]+values \([\s\S]+false[\s\S]+on conflict \(singleton\) do nothing/,
    );
    assertMatch(
      source,
      /create or replace function private\.home_kitchens_globally_enabled\(\)[\s\S]+coalesce\([\s\S]+false/,
    );
  }
  assertMatch(
    migration,
    /revoke all privileges on table private\.home_kitchen_runtime_settings[\s\S]+from public, anon, authenticated, service_role/,
  );
  assertMatch(
    migration,
    /revoke all on function private\.home_kitchens_globally_enabled\(\)[\s\S]+from public, anon, authenticated, service_role/,
  );
});

Deno.test("eligibility keeps the latest provider and permit guards and gates only home kitchens", () => {
  const eligibility = section(
    migration,
    "create or replace function private.is_business_publicly_eligible",
    "-- Exact pickup addresses/coordinates",
  );
  assertMatch(eligibility, /b\.provenance <> 'licensed_provider'/);
  assertMatch(eligibility, /source\.source_status = 'active'/);
  assertMatch(eligibility, /account\.enabled/);
  assertMatch(eligibility, /current_date between account\.license_effective_on/);
  assertMatch(eligibility, /b\.kind <> 'home_kitchen'/);
  assertMatch(eligibility, /private\.home_kitchens_globally_enabled\(\)/);
  assertMatch(eligibility, /b\.verification = 'verified'/);
  assertMatch(eligibility, /j\.home_kitchens_enabled/);
  assertMatch(eligibility, /hp\.verification = 'verified'/);
  assertMatch(eligibility, /hp\.expires_on >= current_date/);
  assertMatch(
    schema,
    /b\.kind <> 'home_kitchen'[\s\S]+private\.home_kitchens_globally_enabled\(\)/,
  );
});

Deno.test("launch toggle and status are audited service-role-only boundaries", () => {
  assertMatch(
    migration,
    /create or replace function public\.set_home_kitchen_launch_gate\(\s*target_enabled boolean,\s*target_reason text\s*\)[\s\S]+pg_advisory_xact_lock/,
  );
  assertMatch(
    migration,
    /public\.set_home_kitchen_launch_gate[\s\S]+auth\.role\(\)[\s\S]+private\.write_audit_event[\s\S]+'home_kitchen\.launch_gate_changed'/,
  );
  assertMatch(
    migration,
    /revoke all on function public\.set_home_kitchen_launch_gate\(boolean, text\)[\s\S]+from public, anon, authenticated[\s\S]+grant execute on function public\.set_home_kitchen_launch_gate\(boolean, text\)[\s\S]+to service_role/,
  );
  assertMatch(
    migration,
    /public\.get_home_kitchen_launch_gate\(\)[\s\S]+auth\.role\(\)[\s\S]+revoke all on function public\.get_home_kitchen_launch_gate\(\)[\s\S]+from public, anon, authenticated[\s\S]+grant execute on function public\.get_home_kitchen_launch_gate\(\)[\s\S]+to service_role/,
  );
  assert(!migration.includes("grant execute on function public.set_home_kitchen_launch_gate(boolean, text)\n  to authenticated"));
});

Deno.test("home-kitchen chat access, inbox enumeration, role, and controls fail closed", () => {
  const access = section(
    migration,
    "create or replace function private.marketplace_conversation_access_allowed",
    "-- The v1 list is the data source for v2",
  );
  assertMatch(access, /business\.kind <> 'home_kitchen'/);
  assertMatch(access, /private\.marketplace_chat_available\(business\.id\)/);

  const list = section(
    migration,
    "create or replace function public.list_my_marketplace_conversations(",
    "create or replace function public.list_my_marketplace_conversations_v2(",
  );
  assertMatch(list, /private\.marketplace_conversation_access_allowed\(conversation\.id, actor\)/);
  assertMatch(
    migration,
    /list_my_marketplace_conversations_v2[\s\S]+private\.marketplace_conversation_access_allowed\(conversation\.id, auth\.uid\(\)\)/,
  );

  const role = section(
    migration,
    "create or replace function public.get_marketplace_conversation_role(",
    "create or replace function public.get_business_marketplace_controls(",
  );
  assertMatch(role, /not private\.marketplace_conversation_access_allowed\(target_conversation\.id, actor\)/);
  assertMatch(
    migration,
    /business\.kind = 'home_kitchen'[\s\S]+private\.home_kitchens_globally_enabled\(\)/,
  );
});

Deno.test("disabling the gate cancels active requests and destroys exact disclosures", () => {
  assertMatch(
    migration,
    /update public\.marketplace_pickup_requests[\s\S]+business\.kind = 'home_kitchen'[\s\S]+request\.state in \('pending', 'authorized'\)/,
  );
  assertMatch(
    migration,
    /delete from private\.neighborhood_pickup_disclosures[\s\S]+business\.kind = 'home_kitchen'/,
  );
  assertMatch(
    migration,
    /delete from private\.marketplace_pickup_disclosures[\s\S]+business\.kind = 'home_kitchen'/,
  );
  assertMatch(migration, /select private\.revoke_home_kitchen_pickup_state\(\)/);
  assertMatch(runtime, /get_home_kitchen_launch_gate\(\)/);
  assertMatch(runtime, /set_home_kitchen_launch_gate\(\s*false/s);
  assertMatch(runtime, /set_home_kitchen_launch_gate\(\s*true/s);
  assertMatch(runtime, /public\.public_business_directory/);
  assertMatch(runtime, /list_my_marketplace_conversations_v2/);
  assertMatch(runtime, /get_marketplace_conversation_role/);
  assertMatch(runtime, /send_marketplace_message/);
});

Deno.test("pickup writers share the gate lock before row locks and legacy writers stay closed", () => {
  const cleanup = section(
    migration,
    "create or replace function private.revoke_home_kitchen_pickup_state()",
    "revoke all on function private.revoke_home_kitchen_pickup_state()",
  );
  const cleanupLock = cleanup.indexOf("pg_catalog.pg_advisory_xact_lock(");
  const cleanupUpdate = cleanup.indexOf(
    "update public.marketplace_pickup_requests",
  );
  assert(cleanupLock >= 0 && cleanupLock < cleanupUpdate);

  const request = section(
    migration,
    "create or replace function public.request_neighborhood_pickup_choice(",
    "revoke all on function public.request_neighborhood_pickup_choice(",
  );
  const requestLock = request.indexOf(
    "pg_catalog.pg_advisory_xact_lock_shared(",
  );
  const requestRowLock = request.indexOf("for update of conversation");
  const requestEligibility = request.indexOf(
    "private.marketplace_conversation_write_allowed",
  );
  assert(
    requestLock >= 0 &&
      requestRowLock > requestLock &&
      requestEligibility > requestLock &&
      requestEligibility > requestRowLock,
  );

  const authorization = section(
    migration,
    "create or replace function public.authorize_neighborhood_pickup_choice(",
    "revoke all on function public.authorize_neighborhood_pickup_choice(",
  );
  const authorizationLock = authorization.indexOf(
    "pg_catalog.pg_advisory_xact_lock_shared(",
  );
  const authorizationRowLock = authorization.indexOf("for update;");
  const authorizationEligibility = authorization.indexOf(
    "private.marketplace_conversation_write_allowed",
  );
  assert(
    authorizationLock >= 0 &&
      authorizationRowLock > authorizationLock &&
      authorizationEligibility > authorizationLock &&
      authorizationEligibility > authorizationRowLock,
  );

  assertMatch(
    legacyPickupWriters,
    /revoke all on function public\.request_marketplace_pickup_detail\([\s\S]+?from public, anon, authenticated/,
  );
  assertMatch(
    legacyPickupWriters,
    /revoke all on function public\.authorize_marketplace_pickup_detail\([\s\S]+?from public, anon, authenticated/,
  );
  assertMatch(
    runtime,
    /request_marketplace_pickup_detail\(uuid,timestamptz,timestamptz,text,text\)/,
  );
  assertMatch(
    runtime,
    /authorize_marketplace_pickup_detail\(uuid,uuid,uuid,integer,text\)/,
  );
  assertMatch(
    runtime,
    /pg_get_functiondef[\s\S]+pg_advisory_xact_lock_shared[\s\S]+for update/,
  );
});

Deno.test("client filtering remains presentation-only while deep links use server data", () => {
  assertMatch(discoveryRoute, /featureFlags\.homeKitchens/);
  assertMatch(marketplaceApi, /fetchMarketplacePlaceById/);
  assertMatch(placeRoute, /ensurePlace\(id, locationId\)/);
  assertMatch(placeRoute, /startMarketplaceConversation/);
  assertMatch(orderRoute, /const \{ ensurePlace, places \} = useMarketplaceStore\(\)/);
  assertMatch(orderRoute, /publicListingRouteUnavailableReason\(loadedPlace\)/);
  assertMatch(orderRoute, /const place = placeBlocked \? undefined : loadedPlace/);
  assertMatch(
    features,
    /publicListingRouteUnavailableReason[\s\S]+isHomeKitchenBlocked\(place\.category\)/,
  );
  assertMatch(orderRoute, /HOME_KITCHEN_UNAVAILABLE_REASON/);
  assertMatch(messagesRoute, /getMarketplaceMessages/);
  assertMatch(messagesRoute, /getMarketplaceConversationContext/);
  assertMatch(messagesRoute, /setMessages\(\[\]\)/);
  assertMatch(messagesRoute, /setPickupDetail\(null\)/);
  assertMatch(messagesRoute, /setPhotos\(\[\]\)/);
  assertMatch(messagesRoute, /setChatContext\(null\)/);
  assertMatch(messagesRoute, /if \(!contextResult\.ok && contextResult\.code === "NOT_FOUND"\)/);
  assertMatch(messagesRoute, /catch \{[\s\S]*?setChatBlocked\(false\)/);
});
