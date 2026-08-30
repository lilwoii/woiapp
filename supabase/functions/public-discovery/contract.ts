export const PUBLIC_DISCOVERY_MAX_BYTES = 4_096;
export const PUBLIC_DISCOVERY_MAX_MAP_FEATURES = 1_200;
export const PUBLIC_DISCOVERY_MAX_PAGE_SIZE = 100;
export const PUBLIC_DISCOVERY_MAX_OFFSET = 10_000;
export const PUBLIC_DISCOVERY_MAX_RADIUS_METERS = 80_467;
export const PUBLIC_DISCOVERY_MIN_RADIUS_METERS = 500;
export const PUBLIC_DISCOVERY_MAX_CLUSTER_PLACES = 100_000_000;
export const PUBLIC_DISCOVERY_MAX_VIEWPORT_DEGREES = 12;
export const PUBLIC_DISCOVERY_MIN_LATITUDE = -85.05112878;
export const PUBLIC_DISCOVERY_MAX_LATITUDE = 85.05112878;

export const discoveryOperations = ["map", "nearby", "search"] as const;
export type DiscoveryOperation = typeof discoveryOperations[number];

export const discoveryKinds = [
  "food_truck",
  "restaurant",
  "pop_up",
  "cafe_bakery",
  "home_kitchen",
] as const;
export type DiscoveryKind = typeof discoveryKinds[number];

export const sponsoredInteractionTypes = [
  "impression",
  "open",
  "menu_view",
  "directions",
  "hide",
  "report",
] as const;
export type SponsoredInteractionType = typeof sponsoredInteractionTypes[number];

const SPONSORED_TOKEN_PATTERN = /^[0-9a-f-]{36}\.[0-9]{10}\.[0-9a-f]{64}$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_TEXT_PATTERN = /^[^\u0000-\u001f\u007f]*$/u;

export class DiscoveryContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DiscoveryContractError";
  }
}

function fail(code: string): never {
  throw new DiscoveryContractError(code);
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_REQUEST");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  object: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(object);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(object, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    fail("INVALID_REQUEST");
  }
}

function numberInRange(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function integerInRange(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function text(value: unknown, minimum: number, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    !SAFE_TEXT_PATTERN.test(value)
  ) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function longitudeSpan(west: number, east: number): number {
  return west <= east ? east - west : (180 - west) + (east + 180);
}

function mapKinds(value: unknown): DiscoveryKind[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length < 1 || value.length > discoveryKinds.length) {
    fail("INVALID_REQUEST");
  }
  const kinds = value.map((kind) => {
    if (!discoveryKinds.includes(kind as DiscoveryKind)) fail("INVALID_REQUEST");
    return kind as DiscoveryKind;
  });
  if (new Set(kinds).size !== kinds.length) fail("INVALID_REQUEST");
  return kinds;
}

function operation(value: unknown): DiscoveryOperation {
  if (!discoveryOperations.includes(value as DiscoveryOperation)) fail("INVALID_REQUEST");
  return value as DiscoveryOperation;
}

export type PublicDiscoveryRequest =
  | {
    operation: "map";
    west_longitude: number;
    south_latitude: number;
    east_longitude: number;
    north_latitude: number;
    map_zoom: number;
    requested_kinds: DiscoveryKind[] | null;
    max_features: number;
  }
  | {
    operation: "nearby";
    search_lat: number;
    search_lng: number;
    radius_meters: number;
    result_limit: number;
    result_offset: number;
  }
  | {
    operation: "search";
    search_text: string;
    result_limit: number;
    result_offset: number;
  };

export type SponsoredInteractionRequest = {
  operation: "sponsored_interaction";
  placement_token: string;
  interaction_type: SponsoredInteractionType;
  idempotency_key: string;
};

function validateMapRequest(object: Record<string, unknown>): PublicDiscoveryRequest {
  exactKeys(
    object,
    [
      "operation",
      "west_longitude",
      "south_latitude",
      "east_longitude",
      "north_latitude",
    ],
    ["map_zoom", "requested_kinds", "max_features"],
  );
  const west = numberInRange(object.west_longitude, -180, 180);
  const south = numberInRange(
    object.south_latitude,
    PUBLIC_DISCOVERY_MIN_LATITUDE,
    PUBLIC_DISCOVERY_MAX_LATITUDE,
  );
  const east = numberInRange(object.east_longitude, -180, 180);
  const north = numberInRange(
    object.north_latitude,
    PUBLIC_DISCOVERY_MIN_LATITUDE,
    PUBLIC_DISCOVERY_MAX_LATITUDE,
  );
  if (
    south >= north ||
    north - south > PUBLIC_DISCOVERY_MAX_VIEWPORT_DEGREES ||
    longitudeSpan(west, east) > PUBLIC_DISCOVERY_MAX_VIEWPORT_DEGREES
  ) {
    fail("INVALID_REQUEST");
  }
  const zoom = object.map_zoom === undefined ? 11 : integerInRange(object.map_zoom, 2, 18);
  const kinds = mapKinds(object.requested_kinds);
  const maxFeatures = object.max_features === undefined
    ? PUBLIC_DISCOVERY_MAX_MAP_FEATURES
    : integerInRange(object.max_features, 1, PUBLIC_DISCOVERY_MAX_MAP_FEATURES);
  return {
    operation: "map",
    west_longitude: west,
    south_latitude: south,
    east_longitude: east,
    north_latitude: north,
    map_zoom: zoom,
    requested_kinds: kinds,
    max_features: maxFeatures,
  };
}

function validateNearbyRequest(object: Record<string, unknown>): PublicDiscoveryRequest {
  exactKeys(
    object,
    ["operation", "search_lat", "search_lng"],
    ["radius_meters", "result_limit", "result_offset"],
  );
  return {
    operation: "nearby",
    search_lat: numberInRange(object.search_lat, -90, 90),
    search_lng: numberInRange(object.search_lng, -180, 180),
    radius_meters: object.radius_meters === undefined ? 16_093 : integerInRange(
      object.radius_meters,
      PUBLIC_DISCOVERY_MIN_RADIUS_METERS,
      PUBLIC_DISCOVERY_MAX_RADIUS_METERS,
    ),
    result_limit: object.result_limit === undefined
      ? PUBLIC_DISCOVERY_MAX_PAGE_SIZE
      : integerInRange(object.result_limit, 1, PUBLIC_DISCOVERY_MAX_PAGE_SIZE),
    result_offset: object.result_offset === undefined
      ? 0
      : integerInRange(object.result_offset, 0, PUBLIC_DISCOVERY_MAX_OFFSET),
  };
}

function validateSearchRequest(object: Record<string, unknown>): PublicDiscoveryRequest {
  exactKeys(
    object,
    ["operation", "search_text"],
    ["result_limit", "result_offset"],
  );
  const searchText = text(object.search_text, 1, 120).replace(/\s+/gu, " ").trim();
  if (searchText.length < 1) fail("INVALID_REQUEST");
  return {
    operation: "search",
    search_text: searchText,
    result_limit: object.result_limit === undefined
      ? PUBLIC_DISCOVERY_MAX_PAGE_SIZE
      : integerInRange(object.result_limit, 1, PUBLIC_DISCOVERY_MAX_PAGE_SIZE),
    result_offset: object.result_offset === undefined
      ? 0
      : integerInRange(object.result_offset, 0, PUBLIC_DISCOVERY_MAX_OFFSET),
  };
}

export function validatePublicDiscoveryRequest(value: unknown): PublicDiscoveryRequest {
  const object = asObject(value);
  const requestedOperation = operation(object.operation);
  if (requestedOperation === "map") return validateMapRequest(object);
  if (requestedOperation === "nearby") return validateNearbyRequest(object);
  return validateSearchRequest(object);
}

export function validateSponsoredInteractionRequest(
  value: unknown,
): SponsoredInteractionRequest {
  const object = asObject(value);
  exactKeys(object, [
    "operation",
    "placement_token",
    "interaction_type",
    "idempotency_key",
  ]);
  if (
    object.operation !== "sponsored_interaction" ||
    typeof object.placement_token !== "string" ||
    !SPONSORED_TOKEN_PATTERN.test(object.placement_token) ||
    !sponsoredInteractionTypes.includes(
      object.interaction_type as SponsoredInteractionType,
    ) ||
    typeof object.idempotency_key !== "string" ||
    !/^[A-Za-z0-9._:-]{16,128}$/.test(object.idempotency_key)
  ) {
    fail("INVALID_REQUEST");
  }
  return {
    operation: "sponsored_interaction",
    placement_token: object.placement_token,
    interaction_type: object.interaction_type as SponsoredInteractionType,
    idempotency_key: object.idempotency_key,
  };
}

export function normalizeSponsoredInteractionReceipt(value: unknown) {
  const row = asObject(value);
  exactKeys(row, ["receipt_id", "accepted", "duplicate", "billed"]);
  if (
    !isUuid(row.receipt_id) ||
    typeof row.accepted !== "boolean" ||
    typeof row.duplicate !== "boolean" ||
    typeof row.billed !== "boolean"
  ) {
    fail("INVALID_SPONSORED_RESPONSE");
  }
  return {
    receipt_id: row.receipt_id,
    accepted: row.accepted,
    duplicate: row.duplicate,
    billed: row.billed,
  };
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isSafeText(value: unknown, maximum: number): value is string {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    SAFE_TEXT_PATTERN.test(value);
}

export function isDiscoveryKind(value: unknown): value is DiscoveryKind {
  return discoveryKinds.includes(value as DiscoveryKind);
}

/** Whitelists the complete sponsored lane projection. Billing and targeting
 * details are intentionally impossible to forward across the Edge boundary. */
export function normalizeSponsoredPlacement(value: unknown) {
  if (value === null) return null;
  const row = asObject(value);
  exactKeys(row, [
    "business_id",
    "placement_id",
    "disclosure",
    "reason",
    "placement_token",
    "expires_at",
  ]);
  if (
    !isUuid(row.business_id) ||
    !isUuid(row.placement_id) ||
    row.disclosure !== "Sponsored ad" ||
    !isSafeText(row.reason, 120) ||
    typeof row.placement_token !== "string" ||
    !SPONSORED_TOKEN_PATTERN.test(row.placement_token) ||
    typeof row.expires_at !== "string" ||
    !Number.isFinite(Date.parse(row.expires_at))
  ) {
    fail("INVALID_SPONSORED_RESPONSE");
  }
  return {
    business_id: row.business_id,
    placement_id: row.placement_id,
    disclosure: "Sponsored ad" as const,
    reason: row.reason,
    placement_token: row.placement_token,
    expires_at: row.expires_at,
  };
}

function nullableSafeText(value: unknown, maximum: number): string | null {
  if (value === null) return null;
  if (!isSafeText(value, maximum)) fail("INVALID_DISCOVERY_RESPONSE");
  return value;
}

function finiteNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail("INVALID_DISCOVERY_RESPONSE");
  }
  return value;
}

function positiveInteger(value: unknown, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    fail("INVALID_DISCOVERY_RESPONSE");
  }
  return value;
}

function resultRows(value: unknown, maximum: number): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > maximum) {
    fail("INVALID_DISCOVERY_RESPONSE");
  }
  return value.map((row) => asObject(row));
}

function searchPageRow(row: Record<string, unknown>) {
  if (!isUuid(row.business_id) || typeof row.has_more !== "boolean") {
    fail("INVALID_DISCOVERY_RESPONSE");
  }
  return {
    business_id: row.business_id,
    has_more: row.has_more,
  };
}

function nearbyPageRow(row: Record<string, unknown>) {
  if (
    !isUuid(row.business_id) ||
    !isUuid(row.location_id) ||
    typeof row.is_approximate !== "boolean" ||
    typeof row.has_more !== "boolean"
  ) {
    fail("INVALID_DISCOVERY_RESPONSE");
  }
  return {
    business_id: row.business_id,
    location_id: row.location_id,
    distance_meters: finiteNumber(
      row.distance_meters,
      0,
      PUBLIC_DISCOVERY_MAX_RADIUS_METERS,
    ),
    is_approximate: row.is_approximate,
    has_more: row.has_more,
  };
}

const sourceLabels = [
  "Owner verified",
  "Owner provided",
  "Community added",
  "Licensed provider",
] as const;

function mapResponseRow(
  row: Record<string, unknown>,
  request: Extract<PublicDiscoveryRequest, { operation: "map" }>,
) {
  const featureType = row.feature_type;
  if (featureType !== "cluster" && featureType !== "place") {
    fail("INVALID_DISCOVERY_RESPONSE");
  }
  if (!isSafeText(row.feature_id, 120)) fail("INVALID_DISCOVERY_RESPONSE");
  const placeCount = positiveInteger(
    row.place_count,
    PUBLIC_DISCOVERY_MAX_CLUSTER_PLACES,
  );
  const latitude = finiteNumber(
    row.latitude,
    PUBLIC_DISCOVERY_MIN_LATITUDE,
    PUBLIC_DISCOVERY_MAX_LATITUDE,
  );
  const longitude = finiteNumber(row.longitude, -180, 180);
  if (!isDiscoveryKind(row.dominant_kind)) fail("INVALID_DISCOVERY_RESPONSE");
  if (
    request.requested_kinds !== null &&
    !request.requested_kinds.includes(row.dominant_kind)
  ) {
    fail("INVALID_DISCOVERY_RESPONSE");
  }

  const rawCounts = asObject(row.category_counts);
  const categoryCounts: Partial<Record<DiscoveryKind, number>> = {};
  let categoryTotal = 0;
  for (const [kind, value] of Object.entries(rawCounts)) {
    if (
      !isDiscoveryKind(kind) ||
      (request.requested_kinds !== null && !request.requested_kinds.includes(kind)) ||
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > PUBLIC_DISCOVERY_MAX_CLUSTER_PLACES
    ) {
      fail("INVALID_DISCOVERY_RESPONSE");
    }
    categoryCounts[kind] = value;
    categoryTotal += value;
  }
  if (
    categoryTotal !== placeCount ||
    categoryCounts[row.dominant_kind] === undefined
  ) {
    fail("INVALID_DISCOVERY_RESPONSE");
  }

  const businessId = row.business_id === null ? null : row.business_id;
  const locationId = row.location_id === null ? null : row.location_id;
  const businessName = nullableSafeText(row.business_name, 200);
  const logoPath = nullableSafeText(row.logo_path, 512);
  const sourceLabel = nullableSafeText(row.source_label, 40);
  const mobilityState = row.mobility_state == null
    ? null
    : row.mobility_state === "moving_to_next_location"
    ? row.mobility_state
    : fail("INVALID_DISCOVERY_RESPONSE");
  if (featureType === "cluster") {
    if (
      businessId !== null || locationId !== null || businessName !== null ||
      logoPath !== null || sourceLabel !== null || mobilityState !== null
    ) {
      fail("INVALID_DISCOVERY_RESPONSE");
    }
  } else if (
    !isUuid(businessId) ||
    !isUuid(locationId) ||
    businessName === null ||
    sourceLabel === null ||
    !sourceLabels.includes(sourceLabel as typeof sourceLabels[number]) ||
    (mobilityState !== null && row.dominant_kind !== "food_truck") ||
    placeCount !== 1
  ) {
    fail("INVALID_DISCOVERY_RESPONSE");
  }

  return {
    feature_type: featureType,
    feature_id: row.feature_id,
    place_count: placeCount,
    latitude,
    longitude,
    category_counts: categoryCounts,
    dominant_kind: row.dominant_kind,
    business_id: businessId,
    location_id: locationId,
    business_name: businessName,
    logo_path: logoPath,
    source_label: sourceLabel,
    mobility_state: mobilityState,
  };
}

/** Whitelists every field returned across the service-role boundary. */
export function normalizePublicDiscoveryRows(
  request: PublicDiscoveryRequest,
  value: unknown,
): Record<string, unknown>[] {
  if (request.operation === "map") {
    return resultRows(value, request.max_features).map((row) => mapResponseRow(row, request));
  }
  const pageRows = resultRows(value, request.result_limit);
  return request.operation === "nearby" ? pageRows.map(nearbyPageRow) : pageRows.map(searchPageRow);
}
