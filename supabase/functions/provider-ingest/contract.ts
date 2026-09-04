export const PROVIDER_INGEST_SCHEMA_VERSION = "2026-07-30";
export const PROVIDER_INGEST_MAX_BYTES = 524_288;
export const PROVIDER_INGEST_MAX_RECORDS = 100;
export const PROVIDER_INGEST_MAX_LOCATIONS = 30;
export const PROVIDER_INGEST_MAX_MENU_SECTIONS = 50;
export const PROVIDER_INGEST_MAX_MENU_ITEMS = 500;
export const PROVIDER_INGEST_SIGNATURE_WINDOW_SECONDS = 300;
export const PROVIDER_INGEST_RATE_LIMIT = 60;
export const PROVIDER_INGEST_RATE_WINDOW_MS = 60_000;

const BUSINESS_KINDS = new Set([
  "food_truck",
  "restaurant",
  "pop_up",
  "cafe_bakery",
]);
const PAYMENT_KINDS = new Set([
  "cash",
  "visa",
  "mastercard",
  "amex",
  "apple_pay",
  "google_pay",
  "cash_app",
  "venmo",
]);
const AVAILABILITY_VALUES = new Set(["available", "sold_out", "hidden"]);
const DIETARY_TAGS = new Set([
  "dairy_free",
  "gluten_aware",
  "gluten_free",
  "halal",
  "kosher",
  "nut_free",
  "organic",
  "spicy",
  "vegan",
  "vegetarian",
]);
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;

export class ContractError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type ProviderScheduleWindow =
  | { status: "closed" | "open_24_hours" }
  | { status: "open"; opensAt: string; closesAt: string };

export type ProviderWeeklyHours = ProviderScheduleWindow & { weekday: number };

export type ProviderSpecialHours = ProviderScheduleWindow & {
  serviceDate: string;
  note?: string;
};

export type ProviderLocation = {
  externalId: string;
  label: string;
  addressLine?: string;
  city: string;
  region: string;
  postalCode?: string;
  countryCode: string;
  latitude: number;
  longitude: number;
  isPrimary: boolean;
  isApproximate: boolean;
  publicAddress: boolean;
};

export type ProviderMenuItem = {
  externalId: string;
  name: string;
  description: string;
  priceMinor: number;
  currency: string;
  availability: "available" | "sold_out" | "hidden";
  dietaryTags: string[];
  allergenNote?: string;
  sortOrder: number;
};

export type ProviderMenuSection = {
  externalId: string;
  name: string;
  sortOrder: number;
  items: ProviderMenuItem[];
};

export type ProviderMenu = {
  mode: "replace";
  sections: ProviderMenuSection[];
};

export type ProviderActiveRecord = {
  externalId: string;
  status: "active";
  updatedAt: string;
  name: string;
  kind: "food_truck" | "restaurant" | "pop_up" | "cafe_bakery";
  description: string;
  cuisineLabels: string[];
  priceLevel: number;
  timezone: string;
  websiteUrl?: string;
  phone?: string;
  sourceUrl?: string;
  payments: string[];
  locations: ProviderLocation[];
  weeklyHours: ProviderWeeklyHours[];
  specialHours: ProviderSpecialHours[];
  menu?: ProviderMenu;
};

export type ProviderInactiveRecord = {
  externalId: string;
  status: "inactive";
  updatedAt: string;
  inactiveReason?: "closed" | "removed_by_provider" | "duplicate" | "unknown";
};

export type ProviderRecord = ProviderActiveRecord | ProviderInactiveRecord;

export type ProviderSync =
  | { mode: "delta" }
  | {
    mode: "snapshot";
    snapshotId: string;
    pageIndex: number;
    finalPage: boolean;
  };

export type ProviderBatch = {
  schemaVersion: typeof PROVIDER_INGEST_SCHEMA_VERSION;
  provider: string;
  batchId: string;
  generatedAt: string;
  sync: ProviderSync;
  records: ProviderRecord[];
};

type JsonObject = Record<string, unknown>;

function fail(code: string): never {
  throw new ContractError(code);
}

function asObject(value: unknown, code: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(code);
  }
  return value as JsonObject;
}

function exactKeys(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[],
  code: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key))) fail(code);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail(code);
}

function hasUnsafeCodePoint(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 8 ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      codePoint === 127 ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

function text(
  value: unknown,
  code: string,
  minimum: number,
  maximum: number,
  pattern?: RegExp,
): string {
  if (typeof value !== "string" || value !== value.trim() || hasUnsafeCodePoint(value)) {
    fail(code);
  }
  const length = Array.from(value).length;
  if (length < minimum || length > maximum || (pattern && !pattern.test(value))) {
    fail(code);
  }
  return value;
}

function optionalText(
  value: unknown,
  code: string,
  maximum: number,
  pattern?: RegExp,
): string | undefined {
  if (value === undefined) return undefined;
  return text(value, code, 1, maximum, pattern);
}

function integer(
  value: unknown,
  code: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(code);
  }
  return value as number;
}

function boolean(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") fail(code);
  return value;
}

function array(value: unknown, code: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail(code);
  return value;
}

function unique<T>(values: T[], code: string): T[] {
  if (new Set(values).size !== values.length) fail(code);
  return values;
}

function parseTimestamp(value: unknown, code: string): { value: string; milliseconds: number } {
  const timestamp = text(value, code, 24, 24, TIMESTAMP_PATTERN);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    fail(code);
  }
  return { value: timestamp, milliseconds };
}

function parseDate(value: unknown, code: string): string {
  const date = text(value, code, 10, 10, DATE_PATTERN);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    fail(code);
  }
  return date;
}

function httpsUrl(value: unknown, code: string): string {
  const candidate = text(value, code, 1, 2048);
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    fail(code);
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    fail(code);
  }
  return url.toString();
}

function timezone(value: unknown): string {
  const candidate = text(value, "INVALID_TIMEZONE", 1, 80);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format();
  } catch {
    fail("INVALID_TIMEZONE");
  }
  return candidate;
}

function scheduleWindow(
  object: JsonObject,
  code: string,
  extraRequired: readonly string[],
  extraOptional: readonly string[] = [],
): ProviderScheduleWindow {
  if (object.status === "closed" || object.status === "open_24_hours") {
    exactKeys(object, [...extraRequired, "status"], extraOptional, code);
    return { status: object.status };
  }
  if (object.status !== "open") fail(code);
  exactKeys(
    object,
    [...extraRequired, "status", "opensAt", "closesAt"],
    extraOptional,
    code,
  );
  const opensAt = text(object.opensAt, code, 5, 5, TIME_PATTERN);
  const closesAt = text(object.closesAt, code, 5, 5, TIME_PATTERN);
  if (opensAt === closesAt) fail(code);
  return { status: "open", opensAt, closesAt };
}

function parseWeeklyHours(value: unknown): ProviderWeeklyHours[] {
  const rows = array(value, "INVALID_WEEKLY_HOURS", 7);
  if (rows.length !== 7) fail("INVALID_WEEKLY_HOURS");
  const parsed = rows.map((row): ProviderWeeklyHours => {
    const object = asObject(row, "INVALID_WEEKLY_HOURS");
    const weekday = integer(object.weekday, "INVALID_WEEKLY_HOURS", 0, 6);
    return {
      weekday,
      ...scheduleWindow(object, "INVALID_WEEKLY_HOURS", ["weekday"]),
    };
  });
  unique(parsed.map((row) => row.weekday), "INVALID_WEEKLY_HOURS");
  return parsed.sort((left, right) => left.weekday - right.weekday);
}

function parseSpecialHours(value: unknown, now: number): ProviderSpecialHours[] {
  const rows = array(value, "INVALID_SPECIAL_HOURS", 366);
  const minimum = now - 30 * 86_400_000;
  const maximum = now + 400 * 86_400_000;
  const parsed = rows.map((row): ProviderSpecialHours => {
    const object = asObject(row, "INVALID_SPECIAL_HOURS");
    const serviceDate = parseDate(object.serviceDate, "INVALID_SPECIAL_HOURS");
    const serviceDateMs = Date.parse(`${serviceDate}T00:00:00.000Z`);
    if (serviceDateMs < minimum || serviceDateMs > maximum) fail("INVALID_SPECIAL_HOURS");
    const note = optionalText(object.note, "INVALID_SPECIAL_HOURS", 240);
    const window = scheduleWindow(
      object,
      "INVALID_SPECIAL_HOURS",
      ["serviceDate"],
      ["note"],
    );
    return {
      serviceDate,
      ...window,
      ...(note ? { note } : {}),
    };
  });
  unique(parsed.map((row) => row.serviceDate), "INVALID_SPECIAL_HOURS");
  return parsed.sort((left, right) => left.serviceDate.localeCompare(right.serviceDate));
}

function parseLocation(value: unknown): ProviderLocation {
  const object = asObject(value, "INVALID_LOCATION");
  exactKeys(
    object,
    [
      "externalId",
      "label",
      "city",
      "region",
      "countryCode",
      "latitude",
      "longitude",
      "isPrimary",
      "isApproximate",
      "publicAddress",
    ],
    ["addressLine", "postalCode"],
    "INVALID_LOCATION",
  );
  const latitude = typeof object.latitude === "number" && Number.isFinite(object.latitude)
    ? object.latitude
    : fail("INVALID_LOCATION");
  const longitude = typeof object.longitude === "number" && Number.isFinite(object.longitude)
    ? object.longitude
    : fail("INVALID_LOCATION");
  if (
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180 ||
    (latitude === 0 && longitude === 0)
  ) {
    fail("INVALID_LOCATION");
  }
  const addressLine = optionalText(object.addressLine, "INVALID_LOCATION", 300);
  const postalCode = optionalText(object.postalCode, "INVALID_LOCATION", 24);
  return {
    externalId: text(object.externalId, "INVALID_LOCATION", 1, 128, EXTERNAL_ID_PATTERN),
    label: text(object.label, "INVALID_LOCATION", 1, 120),
    ...(addressLine ? { addressLine } : {}),
    city: text(object.city, "INVALID_LOCATION", 1, 120),
    region: text(object.region, "INVALID_LOCATION", 1, 80),
    ...(postalCode ? { postalCode } : {}),
    countryCode: text(object.countryCode, "INVALID_LOCATION", 2, 2, COUNTRY_PATTERN),
    latitude,
    longitude,
    isPrimary: boolean(object.isPrimary, "INVALID_LOCATION"),
    isApproximate: boolean(object.isApproximate, "INVALID_LOCATION"),
    publicAddress: boolean(object.publicAddress, "INVALID_LOCATION"),
  };
}

function parseLocations(value: unknown): ProviderLocation[] {
  const rows = array(value, "INVALID_LOCATIONS", PROVIDER_INGEST_MAX_LOCATIONS);
  if (rows.length < 1) fail("INVALID_LOCATIONS");
  const locations = rows.map(parseLocation);
  unique(locations.map((location) => location.externalId), "INVALID_LOCATIONS");
  if (locations.filter((location) => location.isPrimary).length !== 1) {
    fail("INVALID_LOCATIONS");
  }
  return locations;
}

function parseMenuItem(value: unknown): ProviderMenuItem {
  const object = asObject(value, "INVALID_MENU_ITEM");
  exactKeys(
    object,
    [
      "externalId",
      "name",
      "priceMinor",
      "currency",
      "availability",
      "sortOrder",
    ],
    ["description", "dietaryTags", "allergenNote"],
    "INVALID_MENU_ITEM",
  );
  const availability = text(object.availability, "INVALID_MENU_ITEM", 1, 20);
  if (!AVAILABILITY_VALUES.has(availability)) fail("INVALID_MENU_ITEM");
  const rawDietaryTags = array(object.dietaryTags ?? [], "INVALID_MENU_ITEM", 12)
    .map((tag) => text(tag, "INVALID_MENU_ITEM", 1, 40));
  if (rawDietaryTags.some((tag) => !DIETARY_TAGS.has(tag))) fail("INVALID_MENU_ITEM");
  const dietaryTags = unique(rawDietaryTags, "INVALID_MENU_ITEM").sort();
  const description = optionalText(object.description, "INVALID_MENU_ITEM", 1000) ?? "";
  const allergenNote = optionalText(object.allergenNote, "INVALID_MENU_ITEM", 500);
  return {
    externalId: text(object.externalId, "INVALID_MENU_ITEM", 1, 128, EXTERNAL_ID_PATTERN),
    name: text(object.name, "INVALID_MENU_ITEM", 1, 120),
    description,
    priceMinor: integer(object.priceMinor, "INVALID_MENU_ITEM", 0, 100_000_000),
    currency: text(object.currency, "INVALID_MENU_ITEM", 3, 3, CURRENCY_PATTERN),
    availability: availability as ProviderMenuItem["availability"],
    dietaryTags,
    ...(allergenNote ? { allergenNote } : {}),
    sortOrder: integer(object.sortOrder, "INVALID_MENU_ITEM", -10_000, 10_000),
  };
}

function parseMenu(value: unknown): ProviderMenu {
  const object = asObject(value, "INVALID_MENU");
  exactKeys(object, ["mode", "sections"], [], "INVALID_MENU");
  if (object.mode !== "replace") fail("INVALID_MENU");
  const sectionRows = array(
    object.sections,
    "INVALID_MENU",
    PROVIDER_INGEST_MAX_MENU_SECTIONS,
  );
  let itemCount = 0;
  const sections = sectionRows.map((section): ProviderMenuSection => {
    const row = asObject(section, "INVALID_MENU_SECTION");
    exactKeys(
      row,
      ["externalId", "name", "sortOrder", "items"],
      [],
      "INVALID_MENU_SECTION",
    );
    const items = array(row.items, "INVALID_MENU_SECTION", PROVIDER_INGEST_MAX_MENU_ITEMS)
      .map(parseMenuItem);
    itemCount += items.length;
    unique(items.map((item) => item.externalId), "INVALID_MENU_SECTION");
    return {
      externalId: text(
        row.externalId,
        "INVALID_MENU_SECTION",
        1,
        128,
        EXTERNAL_ID_PATTERN,
      ),
      name: text(row.name, "INVALID_MENU_SECTION", 1, 80),
      sortOrder: integer(row.sortOrder, "INVALID_MENU_SECTION", -10_000, 10_000),
      items,
    };
  });
  if (itemCount > PROVIDER_INGEST_MAX_MENU_ITEMS) fail("INVALID_MENU");
  unique(sections.map((section) => section.externalId), "INVALID_MENU");
  return { mode: "replace", sections };
}

function parseInactiveRecord(object: JsonObject): ProviderInactiveRecord {
  exactKeys(
    object,
    ["externalId", "status", "updatedAt"],
    ["inactiveReason"],
    "INVALID_INACTIVE_RECORD",
  );
  const inactiveReason = optionalText(object.inactiveReason, "INVALID_INACTIVE_RECORD", 40);
  if (
    inactiveReason &&
    !new Set(["closed", "removed_by_provider", "duplicate", "unknown"]).has(inactiveReason)
  ) {
    fail("INVALID_INACTIVE_RECORD");
  }
  return {
    externalId: text(
      object.externalId,
      "INVALID_INACTIVE_RECORD",
      1,
      128,
      EXTERNAL_ID_PATTERN,
    ),
    status: "inactive",
    updatedAt: parseTimestamp(object.updatedAt, "INVALID_INACTIVE_RECORD").value,
    ...(inactiveReason
      ? { inactiveReason: inactiveReason as ProviderInactiveRecord["inactiveReason"] }
      : {}),
  };
}

function parseActiveRecord(object: JsonObject, now: number): ProviderActiveRecord {
  exactKeys(
    object,
    [
      "externalId",
      "status",
      "updatedAt",
      "name",
      "kind",
      "priceLevel",
      "timezone",
      "locations",
      "weeklyHours",
    ],
    [
      "description",
      "cuisineLabels",
      "websiteUrl",
      "phone",
      "sourceUrl",
      "payments",
      "specialHours",
      "menu",
    ],
    "INVALID_ACTIVE_RECORD",
  );
  const kind = text(object.kind, "INVALID_BUSINESS_KIND", 1, 30);
  if (!BUSINESS_KINDS.has(kind)) fail("INVALID_BUSINESS_KIND");
  const cuisineLabels = unique(
    array(object.cuisineLabels ?? [], "INVALID_CUISINE_LABELS", 12)
      .map((label) => text(label, "INVALID_CUISINE_LABELS", 1, 60)),
    "INVALID_CUISINE_LABELS",
  );
  const payments = unique(
    array(object.payments ?? [], "INVALID_PAYMENTS", PAYMENT_KINDS.size)
      .map((payment) => text(payment, "INVALID_PAYMENTS", 1, 30)),
    "INVALID_PAYMENTS",
  );
  if (payments.some((payment) => !PAYMENT_KINDS.has(payment))) fail("INVALID_PAYMENTS");
  const websiteUrl = object.websiteUrl === undefined
    ? undefined
    : httpsUrl(object.websiteUrl, "INVALID_WEBSITE_URL");
  const sourceUrl = object.sourceUrl === undefined
    ? undefined
    : httpsUrl(object.sourceUrl, "INVALID_SOURCE_URL");
  const phone = optionalText(
    object.phone,
    "INVALID_PHONE",
    40,
    /^\+?\(?[0-9][0-9 ()-]{5,30}( ?(?:x|ext\.?) ?[0-9]{1,8})?$/i,
  );
  return {
    externalId: text(
      object.externalId,
      "INVALID_ACTIVE_RECORD",
      1,
      128,
      EXTERNAL_ID_PATTERN,
    ),
    status: "active",
    updatedAt: parseTimestamp(object.updatedAt, "INVALID_ACTIVE_RECORD").value,
    name: text(object.name, "INVALID_BUSINESS_NAME", 1, 100),
    kind: kind as ProviderActiveRecord["kind"],
    description: optionalText(object.description, "INVALID_DESCRIPTION", 2000) ?? "",
    cuisineLabels,
    priceLevel: integer(object.priceLevel, "INVALID_PRICE_LEVEL", 1, 4),
    timezone: timezone(object.timezone),
    ...(websiteUrl ? { websiteUrl } : {}),
    ...(phone ? { phone } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    payments,
    locations: parseLocations(object.locations),
    weeklyHours: parseWeeklyHours(object.weeklyHours),
    specialHours: parseSpecialHours(object.specialHours ?? [], now),
    ...(object.menu === undefined ? {} : { menu: parseMenu(object.menu) }),
  };
}

function validateRecordTimestamp(
  record: ProviderRecord,
  generatedAt: number,
  now: number,
): void {
  const recordTimestamp = Date.parse(record.updatedAt);
  if (
    recordTimestamp > generatedAt + PROVIDER_INGEST_SIGNATURE_WINDOW_SECONDS * 1000 ||
    recordTimestamp > now + PROVIDER_INGEST_SIGNATURE_WINDOW_SECONDS * 1000 ||
    recordTimestamp < now - 2 * 365 * 86_400_000
  ) {
    fail("INVALID_RECORD_TIMESTAMP");
  }
}

function parseSync(value: unknown): ProviderSync {
  const object = asObject(value, "INVALID_SYNC");
  if (object.mode === "delta") {
    exactKeys(object, ["mode"], [], "INVALID_SYNC");
    return { mode: "delta" };
  }
  if (object.mode !== "snapshot") fail("INVALID_SYNC");
  exactKeys(
    object,
    ["mode", "snapshotId", "pageIndex", "finalPage"],
    [],
    "INVALID_SYNC",
  );
  return {
    mode: "snapshot",
    snapshotId: text(object.snapshotId, "INVALID_SYNC", 16, 128, IDEMPOTENCY_KEY_PATTERN),
    pageIndex: integer(object.pageIndex, "INVALID_SYNC", 0, 100_000),
    finalPage: boolean(object.finalPage, "INVALID_SYNC"),
  };
}

export function validateProviderBatch(
  value: unknown,
  expectedProvider: string,
  now = Date.now(),
): ProviderBatch {
  const object = asObject(value, "INVALID_BATCH");
  exactKeys(
    object,
    ["schemaVersion", "provider", "batchId", "generatedAt", "sync", "records"],
    [],
    "INVALID_BATCH",
  );
  if (object.schemaVersion !== PROVIDER_INGEST_SCHEMA_VERSION) {
    fail("UNSUPPORTED_SCHEMA_VERSION");
  }
  const provider = text(object.provider, "INVALID_PROVIDER", 2, 40, PROVIDER_PATTERN);
  if (provider !== expectedProvider) fail("PROVIDER_MISMATCH");
  const generated = parseTimestamp(object.generatedAt, "INVALID_GENERATED_AT");
  if (
    generated.milliseconds < now - 86_400_000 ||
    generated.milliseconds > now + PROVIDER_INGEST_SIGNATURE_WINDOW_SECONDS * 1000
  ) {
    fail("INVALID_GENERATED_AT");
  }
  const rows = array(object.records, "INVALID_RECORDS", PROVIDER_INGEST_MAX_RECORDS);
  if (rows.length < 1) fail("INVALID_RECORDS");
  const records = rows.map((row): ProviderRecord => {
    const record = asObject(row, "INVALID_RECORD");
    if (record.status === "inactive") return parseInactiveRecord(record);
    if (record.status === "active") return parseActiveRecord(record, now);
    return fail("INVALID_RECORD_STATUS");
  });
  unique(records.map((record) => record.externalId), "DUPLICATE_EXTERNAL_ID");
  for (const record of records) validateRecordTimestamp(record, generated.milliseconds, now);
  return {
    schemaVersion: PROVIDER_INGEST_SCHEMA_VERSION,
    provider,
    batchId: text(object.batchId, "INVALID_BATCH_ID", 16, 128, IDEMPOTENCY_KEY_PATTERN),
    generatedAt: generated.value,
    sync: parseSync(object.sync),
    records,
  };
}

export function validateProviderName(value: string): string {
  return text(value, "INVALID_PROVIDER", 2, 40, PROVIDER_PATTERN);
}

export function validateKeyId(value: string): string {
  return text(value, "INVALID_KEY_ID", 1, 64, KEY_ID_PATTERN);
}

export function validateIdempotencyKey(value: string): string {
  return text(value, "INVALID_IDEMPOTENCY_KEY", 16, 128, IDEMPOTENCY_KEY_PATTERN);
}

export function validateRequestTimestamp(value: string, now = Date.now()): string {
  if (!/^\d{10}$/.test(value)) fail("INVALID_REQUEST_TIMESTAMP");
  const seconds = Number(value);
  if (
    !Number.isSafeInteger(seconds) ||
    Math.abs(Math.floor(now / 1000) - seconds) > PROVIDER_INGEST_SIGNATURE_WINDOW_SECONDS
  ) {
    fail("STALE_REQUEST");
  }
  return value;
}

export function signatureInput(
  provider: string,
  keyId: string,
  timestamp: string,
  idempotencyKey: string,
  bodySha256: string,
): string {
  return [
    "spottr-provider-ingest-v1",
    "POST",
    provider,
    keyId,
    timestamp,
    idempotencyKey,
    bodySha256,
  ].join("\n");
}

export async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(value).buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function hmacSha256Hex(secret: Uint8Array, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(secret).buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function decodeBase64UrlSecret(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43,172}$/.test(value)) fail("SERVICE_NOT_CONFIGURED");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  let binary: string;
  try {
    binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  } catch {
    fail("SERVICE_NOT_CONFIGURED");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength < 32 || bytes.byteLength > 128) fail("SERVICE_NOT_CONFIGURED");
  return bytes;
}

export function providerSecret(
  rawRegistry: string | undefined,
  provider: string,
  keyId: string,
): Uint8Array {
  if (!rawRegistry || new TextEncoder().encode(rawRegistry).byteLength > 65_536) {
    fail("SERVICE_NOT_CONFIGURED");
  }
  let value: unknown;
  try {
    value = JSON.parse(rawRegistry);
  } catch {
    fail("SERVICE_NOT_CONFIGURED");
  }
  const registry = asObject(value, "SERVICE_NOT_CONFIGURED");
  const providerKeys = asObject(registry[provider], "INVALID_INTERNAL_CREDENTIAL");
  const encodedSecret = providerKeys[keyId];
  if (typeof encodedSecret !== "string") fail("INVALID_INTERNAL_CREDENTIAL");
  return decodeBase64UrlSecret(encodedSecret);
}

type RateBucket = { startedAt: number; count: number };
const rateBuckets = new Map<string, RateBucket>();

export function consumeInstanceRateLimit(
  provider: string,
  keyId: string,
  now = Date.now(),
): void {
  const identity = `${provider}:${keyId}`;
  const current = rateBuckets.get(identity);
  if (!current || now - current.startedAt >= PROVIDER_INGEST_RATE_WINDOW_MS) {
    rateBuckets.set(identity, { startedAt: now, count: 1 });
    return;
  }
  if (current.count >= PROVIDER_INGEST_RATE_LIMIT) fail("RATE_LIMITED");
  current.count += 1;
}

export function resetInstanceRateLimitsForTests(): void {
  rateBuckets.clear();
}
