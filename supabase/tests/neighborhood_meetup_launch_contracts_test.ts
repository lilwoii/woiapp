import { assert, assertMatch, assertNotMatch } from "jsr:@std/assert@1";

const launch = await Deno.readTextFile(
  new URL(
    "../migrations/20260812000000_neighborhood_meetup_launch_contract.sql",
    import.meta.url,
  ),
);
const privacy = await Deno.readTextFile(
  new URL(
    "../migrations/20260813000000_neighborhood_meetup_privacy_repairs.sql",
    import.meta.url,
  ),
);
const lifecycle = await Deno.readTextFile(
  new URL(
    "../migrations/20260814000000_neighborhood_meetup_lifecycle_guards.sql",
    import.meta.url,
  ),
);
const seller = await Deno.readTextFile(
  new URL("../../app/business-marketplace.tsx", import.meta.url),
);
const moderation = await Deno.readTextFile(
  new URL("../../app/marketplace-moderation.tsx", import.meta.url),
);
const chat = await Deno.readTextFile(
  new URL("../../app/messages/[id].tsx", import.meta.url),
);

Deno.test("legacy free-form pickup and global close APIs are retired", () => {
  assertMatch(
    launch,
    /revoke all on function public\.close_marketplace_conversation/,
  );
  assertMatch(
    launch,
    /revoke all on function public\.submit_marketplace_pickup_site/,
  );
  assertMatch(
    launch,
    /revoke all on function public\.review_marketplace_pickup_site/,
  );
  assertMatch(
    launch,
    /revoke all on function public\.authorize_marketplace_pickup_detail/,
  );
  assertMatch(launch, /drop trigger if exists close_pop_up_chat_on_disable/);
  assertNotMatch(
    seller,
    /Use my current coordinates|Submit for safety review|submitPickupSite/,
  );
  assertNotMatch(
    moderation,
    /Pickup sites|loadPendingPickupSites|reviewPendingPickupSite/,
  );
});

Deno.test("provider places require provenance and fail closed after withdrawal", () => {
  assertMatch(launch, /rights_status in \('licensed', 'first_party'\)/);
  assertMatch(launch, /source_license_ref is not null/);
  assertMatch(privacy, /cancel_unavailable_meeting_place_requests/);
  assertMatch(privacy, /cleanup_unavailable_meeting_place_requests/);
  assertMatch(privacy, /join private\.business_meeting_routes route/);
  assertMatch(
    privacy,
    /place\.expires_at > (?:pickup_ends_at|request\.pickup_ends_at)/,
  );
  assertMatch(lifecycle, /place\.expires_at > new\.pickup_ends_at/);
});

Deno.test("residence consent is private and exact cards have a hard short lifetime", () => {
  assertMatch(
    launch,
    /create table if not exists private\.marketplace_consent_receipts/,
  );
  assertMatch(
    lifecycle,
    /before insert on public\.marketplace_pickup_requests/,
  );
  assertMatch(lifecycle, /new\.buyer_terms_version := null/);
  assertMatch(lifecycle, /new\.buyer_acknowledged_at := null/);
  assertMatch(launch, /target_request\.pickup_ends_at \+ interval '2 hours'/);
  assertMatch(launch, /new\.authorized_at \+ interval '24 hours'/);
  assertMatch(chat, /expires no later|expires/);
});

Deno.test("pickup notes use chat DLP and cleared media paths stop resolving", () => {
  assertMatch(
    privacy,
    /private\.marketplace_chat_safety_code\(normalized_note\) is not null/,
  );
  assertMatch(
    privacy,
    /left join private\.marketplace_conversation_visibility visibility/,
  );
  assertMatch(
    privacy,
    /message\.sequence > visibility\.hidden_through_sequence/,
  );
});

Deno.test("account deletion disables residence pickup before asynchronous deletion", () => {
  assertMatch(lifecycle, /freeze_neighborhood_residence_on_account_deletion/);
  assertMatch(
    lifecycle,
    /after insert or update on private\.account_deletion_requests/,
  );
  assertMatch(lifecycle, /residence_pickup_enabled = false/);
  assertMatch(lifecycle, /request\.choice_kind = 'seller_residence'/);
});

Deno.test("seller payment methods carry explicit confirmation provenance", () => {
  assertMatch(
    launch,
    /create table if not exists private\.business_payment_confirmations/,
  );
  assertMatch(launch, /'payment_methods_confirmed_at'/);
  assertMatch(chat, /Seller-reported:/);
  assertMatch(chat, /confirmation date unavailable/);
  assertMatch(chat, /Pay the seller\s+directly/);
});
