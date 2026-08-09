import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  consumeInstanceRateLimit,
  ContractError,
  decodeBase64UrlSecret,
  hmacSha256Hex,
  PROVIDER_INGEST_MAX_BYTES,
  PROVIDER_INGEST_MAX_RECORDS,
  PROVIDER_INGEST_RATE_LIMIT,
  providerSecret,
  resetInstanceRateLimitsForTests,
  sha256Hex,
  signatureInput,
  validateProviderBatch,
  validateRequestTimestamp,
} from "../functions/provider-ingest/contract.ts";

const NOW = Date.parse("2026-07-30T20:00:00.000Z");

function schedule() {
  return Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    status: weekday === 0 ? "closed" : "open",
    ...(weekday === 0 ? {} : { opensAt: "09:00", closesAt: "17:00" }),
  }));
}

function validBatch(): Record<string, unknown> {
  return {
    schemaVersion: "2026-07-30",
    provider: "licensed_vendor",
    batchId: "batch:20260730:000001",
    generatedAt: "2026-07-30T19:59:00.000Z",
    sync: { mode: "delta" },
    records: [{
      externalId: "place/123",
      status: "active",
      updatedAt: "2026-07-30T19:58:00.000Z",
      name: "Cedar & Salt",
      kind: "restaurant",
      description: "Seasonal neighborhood cooking.",
      cuisineLabels: ["Mediterranean"],
      priceLevel: 2,
      timezone: "America/Los_Angeles",
      websiteUrl: "https://example.com/cedar-salt",
      phone: "+1 415 555 0123",
      sourceUrl: "https://provider.example/places/123",
      payments: ["cash", "visa", "apple_pay"],
      locations: [{
        externalId: "location/primary",
        label: "Main dining room",
        addressLine: "12 Market Street",
        city: "San Francisco",
        region: "CA",
        postalCode: "94105",
        countryCode: "US",
        latitude: 37.7936,
        longitude: -122.3958,
        isPrimary: true,
        isApproximate: false,
        publicAddress: true,
      }],
      weeklyHours: schedule(),
      specialHours: [{
        serviceDate: "2026-12-25",
        status: "closed",
        note: "Closed for the holiday",
      }],
      menu: {
        mode: "replace",
        sections: [{
          externalId: "section/lunch",
          name: "Lunch",
          sortOrder: 0,
          items: [{
            externalId: "item/bowl",
            name: "Market bowl",
            description: "Seasonal vegetables and grains.",
            priceMinor: 1450,
            currency: "USD",
            availability: "available",
            dietaryTags: ["vegan"],
            allergenNote: "Prepared in a kitchen that handles nuts.",
            sortOrder: 0,
          }],
        }],
      },
    }],
  };
}

Deno.test("validates and normalizes a complete licensed-provider batch", () => {
  const batch = validateProviderBatch(validBatch(), "licensed_vendor", NOW);
  assertEquals(batch.provider, "licensed_vendor");
  assertEquals(batch.records.length, 1);
  assertEquals(batch.records[0].status, "active");
  if (batch.records[0].status === "active") {
    assertEquals(batch.records[0].weeklyHours.map((row) => row.weekday), [
      0,
      1,
      2,
      3,
      4,
      5,
      6,
    ]);
    assertEquals(batch.records[0].menu?.sections[0].items[0].priceMinor, 1450);
  }
});

Deno.test("rejects unknown fields, home kitchens, invalid coordinates, and ambiguous hours", () => {
  const unknownField = structuredClone(validBatch());
  Object.assign(unknownField, { secret: "must-not-pass" });
  assertThrows(
    () => validateProviderBatch(unknownField, "licensed_vendor", NOW),
    ContractError,
    "INVALID_BATCH",
  );

  const homeKitchen = structuredClone(validBatch());
  const homeKitchenRecords = homeKitchen.records as Array<
    Record<string, unknown>
  >;
  homeKitchenRecords[0].kind = "home_kitchen";
  assertThrows(
    () => validateProviderBatch(homeKitchen, "licensed_vendor", NOW),
    ContractError,
    "INVALID_BUSINESS_KIND",
  );

  const invalidCoordinate = structuredClone(validBatch());
  const invalidCoordinateRecords = invalidCoordinate.records as Array<
    Record<string, unknown>
  >;
  const invalidLocations = invalidCoordinateRecords[0].locations as Array<
    Record<string, unknown>
  >;
  invalidLocations[0].latitude = 0;
  invalidLocations[0].longitude = 0;
  assertThrows(
    () => validateProviderBatch(invalidCoordinate, "licensed_vendor", NOW),
    ContractError,
    "INVALID_LOCATION",
  );

  const ambiguousHours = structuredClone(validBatch());
  const ambiguousRecords = ambiguousHours.records as Array<
    Record<string, unknown>
  >;
  const ambiguousSchedule = ambiguousRecords[0].weeklyHours as Array<
    Record<string, unknown>
  >;
  ambiguousSchedule[1] = {
    weekday: 1,
    status: "open",
    opensAt: "09:00",
    closesAt: "09:00",
  };
  assertThrows(
    () => validateProviderBatch(ambiguousHours, "licensed_vendor", NOW),
    ContractError,
    "INVALID_WEEKLY_HOURS",
  );
});

Deno.test("enforces record, menu, identity, and timestamp boundaries", () => {
  const tooManyRecords = structuredClone(validBatch());
  tooManyRecords.records = Array.from(
    { length: PROVIDER_INGEST_MAX_RECORDS + 1 },
    (_, index) => ({
      externalId: `place/${index}`,
      status: "inactive",
      updatedAt: "2026-07-30T19:58:00.000Z",
    }),
  );
  assertThrows(
    () => validateProviderBatch(tooManyRecords, "licensed_vendor", NOW),
    ContractError,
    "INVALID_RECORDS",
  );

  const duplicate = structuredClone(validBatch());
  const duplicateRecords = duplicate.records as unknown[];
  duplicateRecords.push(structuredClone(duplicateRecords[0]));
  assertThrows(
    () => validateProviderBatch(duplicate, "licensed_vendor", NOW),
    ContractError,
    "DUPLICATE_EXTERNAL_ID",
  );

  assertThrows(
    () => validateProviderBatch(validBatch(), "other_vendor", NOW),
    ContractError,
    "PROVIDER_MISMATCH",
  );
  assertThrows(
    () => validateRequestTimestamp(String(Math.floor(NOW / 1000) - 301), NOW),
    ContractError,
    "STALE_REQUEST",
  );
  assertEquals(PROVIDER_INGEST_MAX_BYTES, 524_288);
});

Deno.test("accepts minimal explicit inactive records without destructive payload fields", () => {
  const batch = validBatch();
  batch.records = [{
    externalId: "place/closed",
    status: "inactive",
    updatedAt: "2026-07-30T19:58:00.000Z",
    inactiveReason: "closed",
  }];
  const parsed = validateProviderBatch(batch, "licensed_vendor", NOW);
  assertEquals(parsed.records[0], {
    externalId: "place/closed",
    status: "inactive",
    updatedAt: "2026-07-30T19:58:00.000Z",
    inactiveReason: "closed",
  });
});

Deno.test("HMAC signing binds provider, key, timestamp, idempotency key, and body hash", async () => {
  const secret = new Uint8Array(32).fill(7);
  const body = new TextEncoder().encode(JSON.stringify(validBatch()));
  const bodyHash = await sha256Hex(body);
  const input = signatureInput(
    "licensed_vendor",
    "primary-2026",
    "1785441600",
    "batch:20260730:000001",
    bodyHash,
  );
  const first = await hmacSha256Hex(secret, input);
  const second = await hmacSha256Hex(secret, input.replace("000001", "000002"));
  assert(/^[0-9a-f]{64}$/.test(first));
  assert(first !== second);
});

Deno.test("provider key registry requires provider-specific base64url secrets of 32+ bytes", () => {
  const encoded = btoa(String.fromCharCode(...new Uint8Array(32).fill(11)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
  const registry = JSON.stringify({
    licensed_vendor: { "primary-2026": encoded },
  });
  assertEquals(
    providerSecret(registry, "licensed_vendor", "primary-2026"),
    new Uint8Array(32).fill(11),
  );
  assertEquals(decodeBase64UrlSecret(encoded).byteLength, 32);
  assertThrows(
    () => providerSecret(registry, "licensed_vendor", "unknown"),
    ContractError,
    "INVALID_INTERNAL_CREDENTIAL",
  );
  assertThrows(
    () => decodeBase64UrlSecret("short"),
    ContractError,
    "SERVICE_NOT_CONFIGURED",
  );
});

Deno.test("per-isolate limiter is strict and resets only after its window", () => {
  resetInstanceRateLimitsForTests();
  for (let index = 0; index < PROVIDER_INGEST_RATE_LIMIT; index += 1) {
    consumeInstanceRateLimit("licensed_vendor", "primary-2026", NOW);
  }
  assertThrows(
    () => consumeInstanceRateLimit("licensed_vendor", "primary-2026", NOW),
    ContractError,
    "RATE_LIMITED",
  );
  consumeInstanceRateLimit("licensed_vendor", "primary-2026", NOW + 60_000);
});

Deno.test("edge entrypoint stays fail-closed and never performs direct table writes", async () => {
  const source = await Deno.readTextFile(
    new URL("../functions/provider-ingest/index.ts", import.meta.url),
  );
  assert(source.includes('SPOTTR_PROVIDER_INGEST_ENABLED") !== "true"'));
  assert(source.includes("SPOTTR_PROVIDER_INGEST_KEYS_JSON"));
  assert(source.includes("ingest_licensed_provider_batch"));
  assert(source.includes("IDEMPOTENCY_KEY_MISMATCH"));
  assert(!source.includes('.from("businesses")'));
  assert(!source.includes(".upsert("));
  assert(!source.includes("console.log"));
  assert(!source.includes("console.error"));
});
Deno.test("provider gateway delegates authentication to the HMAC contract", async () => {
  const config = await Deno.readTextFile(
    new URL("../config.toml", import.meta.url),
  );
  const section = config.match(
    /\[functions\.provider-ingest\]\s+verify_jwt\s*=\s*(true|false)/,
  );
  assertEquals(section?.[1], "false");
});
