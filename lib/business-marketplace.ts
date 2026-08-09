import { isSupabaseConfigured, supabase } from "@/lib/supabase";

export type MarketplaceBusinessKind = "home_kitchen" | "pop_up";
export type PickupSiteKind = "public_meeting_place" | "commercial_site";
export type PickupSiteState = "submitted" | "approved" | "rejected";

export type MarketplaceControls = {
  businessId: string;
  businessName: string;
  businessKind: MarketplaceBusinessKind;
  chatEnabled: boolean;
  chatRequired: boolean;
  canToggleChat: boolean;
};

export type NeighborhoodPickupSettings = {
  residencePickupEnabled: boolean;
  serviceLocationReady: boolean;
};

export type MeetingPlaceSuggestion = {
  publicId: string;
  label: string;
  addressLine: string;
  city: string;
  region: string;
  postalCode: string | null;
  distanceMeters: number;
  selectedOrdinal: number | null;
};

export type ManagedPickupSite = {
  publicId: string;
  label: string;
  kind: PickupSiteKind;
  state: PickupSiteState;
  addressLine: string;
  city: string;
  region: string;
  postalCode: string | null;
  latitude: number;
  longitude: number;
  submittedAt: string;
  reviewedAt: string | null;
  updatedAt: string;
};

export type PickupSiteDraft = {
  label: string;
  kind: PickupSiteKind;
  addressLine: string;
  city: string;
  region: string;
  postalCode: string;
  latitude: string;
  longitude: string;
};

export type BusinessMarketplaceResult<T> =
  | { ok: true; data: T }
  | {
    ok: false;
    code: "AUTH" | "CONFLICT" | "FORBIDDEN" | "INVALID" | "NETWORK" | "UNKNOWN";
    reason: string;
  };

type Row = Record<string, unknown>;
type ErrorLike = { code?: string; message?: string; status?: number };
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let keySequence = 0;

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rowFrom(value: unknown) {
  const row = Array.isArray(value) ? value[0] : value;
  if (!isRow(row)) throw new Error("Invalid marketplace controls response");
  return row;
}

function stringValue(row: Row, key: string, optional = false) {
  const value = row[key];
  if (optional && (value === null || value === undefined || value === "")) {
    return null;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid ${key}`);
  }
  return value.trim();
}

function uuidValue(row: Row, key: string) {
  const value = stringValue(row, key);
  if (!value || !uuidPattern.test(value)) throw new Error(`Invalid ${key}`);
  return value;
}

function dateValue(row: Row, key: string, optional = false) {
  const value = stringValue(row, key, optional);
  if (value === null) return null;
  if (!Number.isFinite(new Date(value).getTime())) {
    throw new Error(`Invalid ${key}`);
  }
  return value;
}

function numberValue(row: Row, key: string, minimum: number, maximum: number) {
  const value = row[key];
  if (
    typeof value !== "number" || !Number.isFinite(value) || value < minimum ||
    value > maximum
  ) {
    throw new Error(`Invalid ${key}`);
  }
  return value;
}

export function mapMarketplaceControls(value: unknown): MarketplaceControls {
  const row = rowFrom(value);
  const kind = row.business_kind;
  if (kind !== "home_kitchen" && kind !== "pop_up") {
    throw new Error("Invalid business kind");
  }
  if (
    typeof row.chat_enabled !== "boolean" ||
    typeof row.chat_required !== "boolean" ||
    typeof row.can_toggle_chat !== "boolean"
  ) {
    throw new Error("Invalid chat settings");
  }
  return {
    businessId: uuidValue(row, "business_id"),
    businessName: stringValue(row, "business_name")!,
    businessKind: kind,
    chatEnabled: row.chat_enabled,
    chatRequired: row.chat_required,
    canToggleChat: row.can_toggle_chat,
  };
}

export function mapManagedPickupSites(value: unknown): ManagedPickupSite[] {
  if (!Array.isArray(value)) throw new Error("Invalid pickup site list");
  return value.map((candidate) => {
    if (!isRow(candidate)) throw new Error("Invalid pickup site");
    const kind = candidate.site_kind;
    const state = candidate.state;
    if (kind !== "public_meeting_place" && kind !== "commercial_site") {
      throw new Error("Invalid pickup site kind");
    }
    if (state !== "submitted" && state !== "approved" && state !== "rejected") {
      throw new Error("Invalid pickup site state");
    }
    return {
      publicId: uuidValue(candidate, "pickup_site_public_id"),
      label: stringValue(candidate, "label")!,
      kind,
      state,
      addressLine: stringValue(candidate, "address_line")!,
      city: stringValue(candidate, "city")!,
      region: stringValue(candidate, "region")!,
      postalCode: stringValue(candidate, "postal_code", true),
      latitude: numberValue(candidate, "latitude", -90, 90),
      longitude: numberValue(candidate, "longitude", -180, 180),
      submittedAt: dateValue(candidate, "submitted_at")!,
      reviewedAt: dateValue(candidate, "reviewed_at", true),
      updatedAt: dateValue(candidate, "updated_at")!,
    };
  });
}

export function validatePickupSiteDraft(draft: PickupSiteDraft) {
  const clean = {
    label: draft.label.normalize("NFKC").replace(/\s+/g, " ").trim(),
    kind: draft.kind,
    addressLine: draft.addressLine.normalize("NFKC").replace(/\s+/g, " ")
      .trim(),
    city: draft.city.normalize("NFKC").replace(/\s+/g, " ").trim(),
    region: draft.region.normalize("NFKC").replace(/\s+/g, " ").trim(),
    postalCode: draft.postalCode.normalize("NFKC").replace(/\s+/g, " ").trim(),
    latitude: Number(draft.latitude),
    longitude: Number(draft.longitude),
  };
  if (!clean.label || clean.label.length > 120) {
    throw new Error("Use a short public place label, up to 120 characters.");
  }
  if (!clean.addressLine || clean.addressLine.length > 300) {
    throw new Error(
      "Enter the exact street address of the public or commercial meeting place.",
    );
  }
  if (
    !clean.city || clean.city.length > 120 || !clean.region ||
    clean.region.length > 80
  ) throw new Error("Enter a valid city and state, province, or region.");
  if (clean.postalCode.length > 24) {
    throw new Error("The postal code is too long.");
  }
  if (
    !Number.isFinite(clean.latitude) || clean.latitude < -90 ||
    clean.latitude > 90 || !Number.isFinite(clean.longitude) ||
    clean.longitude < -180 || clean.longitude > 180
  ) {
    throw new Error("Add valid latitude and longitude coordinates.");
  }
  return clean;
}

export function createMarketplaceOperationsKey(action: string) {
  const cryptoApi = (globalThis as typeof globalThis & {
    crypto?: { randomUUID?: () => string };
  }).crypto;
  keySequence = (keySequence + 1) % Number.MAX_SAFE_INTEGER;
  const nonce = cryptoApi?.randomUUID?.() ??
    `${Date.now().toString(36)}-${keySequence.toString(36)}-${
      Math.random().toString(36).slice(2)
    }`;
  return `marketplace-${action}-${nonce}`.slice(0, 128);
}

async function secureClient() {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error("Live services are not configured.");
  }
  const [{ data: userData, error: userError }, assurance] = await Promise.all([
    supabase.auth.getUser(),
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
  ]);
  if (userError || !userData.user) {
    throw Object.assign(userError ?? new Error("Not authenticated"), {
      status: 401,
    });
  }
  if (assurance.error) throw assurance.error;
  if (assurance.data.currentLevel !== "aal2") {
    throw Object.assign(new Error("AAL2 required"), { status: 403 });
  }
  return supabase;
}

function failure<T>(
  error: unknown,
  fallback: string,
): BusinessMarketplaceResult<T> {
  const candidate = error as ErrorLike;
  const message = candidate?.message?.toLocaleLowerCase("en-US") ?? "";
  if (
    candidate?.status === 401 || message.includes("jwt") ||
    message.includes("not authenticated")
  ) {
    return {
      ok: false,
      code: "AUTH",
      reason: "Sign in again to manage marketplace safety.",
    };
  }
  if (
    candidate?.status === 403 || candidate?.code === "42501" ||
    message.includes("aal2") || message.includes("manager")
  ) {
    return {
      ok: false,
      code: "FORBIDDEN",
      reason: message.includes("aal2")
        ? "Verify a current authenticator code before managing private pickup details."
        : "Only an owner or manager can change these controls.",
    };
  }
  if (candidate?.code === "40001" || message.includes("changed")) {
    return {
      ok: false,
      code: "CONFLICT",
      reason: "This pickup site changed. Reload before trying again.",
    };
  }
  if (
    candidate?.code === "22023" || candidate?.code === "23514" ||
    message.includes("invalid") || message.includes("sensitive")
  ) return { ok: false, code: "INVALID", reason: fallback };
  if (message.includes("fetch") || message.includes("network")) {
    return {
      ok: false,
      code: "NETWORK",
      reason: "Spottr could not be reached. Check the connection and retry.",
    };
  }
  return { ok: false, code: "UNKNOWN", reason: fallback };
}

export async function loadBusinessMarketplace(
  businessId: string,
): Promise<
  BusinessMarketplaceResult<
    {
      controls: MarketplaceControls;
      neighborhoodSettings: NeighborhoodPickupSettings | null;
      meetingSuggestions: MeetingPlaceSuggestion[];
    }
  >
> {
  try {
    if (!uuidPattern.test(businessId)) {
      throw new Error("Invalid business reference");
    }
    const client = await secureClient();
    const controls = await client.rpc("get_business_marketplace_controls", {
      target_business_id: businessId,
    });
    if (controls.error) throw controls.error;
    const mappedControls = mapMarketplaceControls(controls.data);
    const [settings, suggestions] = await Promise.all([
      mappedControls.businessKind === "home_kitchen"
        ? client.rpc("get_neighborhood_pickup_settings", {
          target_business_id: businessId,
        })
        : Promise.resolve({ data: null, error: null }),
      mappedControls.businessKind === "home_kitchen"
        ? client.rpc("list_business_meeting_place_suggestions", {
          target_business_id: businessId,
        })
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (settings.error) throw settings.error;
    if (suggestions.error) throw suggestions.error;
    const settingsRow = settings.data && isRow(settings.data)
      ? settings.data
      : null;
    const meetingSuggestions = Array.isArray(suggestions.data)
      ? suggestions.data.map((candidate) => {
        if (!isRow(candidate)) {
          throw new Error("Invalid meeting place suggestion");
        }
        const ordinal = candidate.selected_ordinal;
        return {
          publicId: uuidValue(candidate, "choice_public_id"),
          label: stringValue(candidate, "label")!,
          addressLine: stringValue(candidate, "address_line")!,
          city: stringValue(candidate, "city")!,
          region: stringValue(candidate, "region")!,
          postalCode: stringValue(candidate, "postal_code", true),
          distanceMeters: numberValue(candidate, "distance_meters", 0, 25000),
          selectedOrdinal:
            typeof ordinal === "number" && Number.isInteger(ordinal) &&
              ordinal >= 1 && ordinal <= 3
              ? ordinal
              : null,
        };
      })
      : [];
    return {
      ok: true,
      data: {
        controls: mappedControls,
        neighborhoodSettings: settingsRow
          ? {
            residencePickupEnabled:
              settingsRow.residence_pickup_enabled === true,
            serviceLocationReady: settingsRow.service_location_ready === true,
          }
          : null,
        meetingSuggestions,
      },
    };
  } catch (error) {
    return failure(
      error,
      "Marketplace controls could not be loaded. This category may not support private pickup chat.",
    );
  }
}

export async function setBusinessMeetingRoutes(
  businessId: string,
  choiceIds: string[],
): Promise<BusinessMarketplaceResult<number>> {
  try {
    if (
      choiceIds.length < 2 || choiceIds.length > 3 ||
      new Set(choiceIds).size !== choiceIds.length || choiceIds.some((id) =>
        !uuidPattern.test(id)
      )
    ) {
      throw new Error("Choose two or three public meeting places.");
    }
    const client = await secureClient();
    const { data, error } = await client.rpc("set_business_meeting_routes", {
      target_business_id: businessId,
      selected_choice_public_ids: choiceIds,
      accepted_attestation_version: "2026-08-01",
      idempotency_key: createMarketplaceOperationsKey("routes"),
    });
    if (error) throw error;
    const row = rowFrom(data);
    return { ok: true, data: numberValue(row, "selected_count", 2, 3) };
  } catch (error) {
    return failure(
      error,
      error instanceof Error
        ? error.message
        : "Meeting places could not be saved.",
    );
  }
}

export async function setNeighborhoodResidencePickup(
  businessId: string,
  enabled: boolean,
): Promise<BusinessMarketplaceResult<boolean>> {
  try {
    const client = await secureClient();
    const { data, error } = await client.rpc(
      "set_neighborhood_residence_pickup",
      {
        target_business_id: businessId,
        should_enable: enabled,
        accepted_terms_version: enabled ? "2026-08-01" : null,
        idempotency_key: createMarketplaceOperationsKey("residence"),
      },
    );
    if (error) throw error;
    const row = rowFrom(data);
    if (typeof row.residence_pickup_enabled !== "boolean") {
      throw new Error("Invalid residence setting receipt");
    }
    return { ok: true, data: row.residence_pickup_enabled };
  } catch (error) {
    return failure(error, "Residence pickup could not be changed.");
  }
}

export async function setBusinessMarketplaceChat(
  businessId: string,
  enabled: boolean,
): Promise<BusinessMarketplaceResult<boolean>> {
  try {
    const client = await secureClient();
    const { data, error } = await client.rpc(
      "set_business_marketplace_chat_enabled",
      {
        target_business_id: businessId,
        should_enable: enabled,
        idempotency_key: createMarketplaceOperationsKey("chat"),
      },
    );
    if (error) throw error;
    const row = rowFrom(data);
    if (typeof row.enabled !== "boolean") {
      throw new Error("Invalid chat setting receipt");
    }
    return { ok: true, data: row.enabled };
  } catch (error) {
    return failure(error, "Chat availability could not be changed.");
  }
}

export async function submitPickupSite(
  businessId: string,
  draft: PickupSiteDraft,
): Promise<BusinessMarketplaceResult<string>> {
  try {
    const clean = validatePickupSiteDraft(draft);
    const client = await secureClient();
    const { data, error } = await client.rpc("submit_marketplace_pickup_site", {
      target_business_id: businessId,
      site_label: clean.label,
      site_kind: clean.kind,
      address_line: clean.addressLine,
      city: clean.city,
      region: clean.region,
      postal_code: clean.postalCode || null,
      latitude: clean.latitude,
      longitude: clean.longitude,
      idempotency_key: createMarketplaceOperationsKey("site"),
    });
    if (error) throw error;
    return {
      ok: true,
      data: uuidValue(rowFrom(data), "pickup_site_public_id"),
    };
  } catch (error) {
    return failure(
      error,
      error instanceof Error
        ? error.message
        : "The pickup site could not be submitted.",
    );
  }
}

export async function archivePickupSite(
  site: ManagedPickupSite,
): Promise<BusinessMarketplaceResult<void>> {
  try {
    const client = await secureClient();
    const { error } = await client.rpc("archive_marketplace_pickup_site", {
      target_pickup_site_public_id: site.publicId,
      expected_updated_at: site.updatedAt,
      idempotency_key: createMarketplaceOperationsKey("archive"),
    });
    if (error) throw error;
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error, "The pickup site could not be archived.");
  }
}
