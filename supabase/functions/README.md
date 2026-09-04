# Spottr Edge Function contracts

All public functions are fail-closed and return `Cache-Control: no-store`.
Browser origins must appear in the comma-separated `SPOTTR_ALLOWED_ORIGINS`
environment variable. Native requests may omit `Origin`.

## Public discovery

`POST /functions/v1/public-discovery` is the only client boundary for the
costly `map`, `nearby`, and `search` database queries. The request is limited to
4 KB, has an exact operation-specific shape, and the response is field-
whitelisted. The original RPCs are executable only by `service_role`. The Edge
request aborts its database HTTP call after 2.5 seconds; production acceptance
must separately prove backend query cancellation and database-side timeout
policy because a timeout set from inside a PostgreSQL function cannot bound the
already-running outer statement.

The gateway fails closed unless Supabase supplies `cf-connecting-ip` and
`SPOTTR_DISCOVERY_RATE_SECRET` contains at least 32 random characters. It HMACs
the address before database admission; raw addresses and Auth user IDs are not
stored in Spottr discovery tables or written to application logs. Every request
must first pass the 60-per-minute operation/network quota before an unrecognized
bearer token can reach Auth. A validated user session must also pass its
240-per-minute operation/account quota. Successful calls release their lease in
`finally`. If HTTP cancellation or a transport failure cannot prove that the
outer database statement stopped, the two-minute lease is deliberately retained until expiry so the
concurrency cap fails closed. A `429` includes `Retry-After`; clients retain
their last successful map instead of automatically retrying.

Before production activation, prove that the deployed Edge environment owns
and supplies `cf-connecting-ip`. If that trust property is unavailable, keep
the endpoint unavailable and put an owned WAF/gateway in front of it. Configure
and review Supabase platform-log retention separately because provider-level
request metadata is outside the application tables.

When both `SPOTTR_SPONSORED_PLACEMENTS_ENABLED=true` and the private sponsored
runtime switch are approved, nearby discovery may include one separately
labelled sponsored projection. Selection is a service-role RPC behind the same
trusted-IP/Auth boundary; malformed or unavailable ad selection is discarded
without changing or failing organic results. The production web and native
client flags remain false until the monetization gates in `docs/MONETIZATION.md`
are complete.

## Text moderation

Reviews, owner updates, and business responses are always created in `pending`.
The database profanity filter is only an early rejection layer, never an
approval signal. A moderator or administrator at `aal2` reads the public-ID-only
queue through `list_pending_content_moderation` and decides an unchanged row
through `decide_content_moderation`; stale timestamps fail with
`MODERATION_TARGET_CHANGED`. Review approval also requires every linked image to
have completed the clean scanner path. All decisions are rate-limited and
audited.

## Account export

`GET /functions/v1/export-account` requires a valid `aal2` Supabase bearer JWT.
It streams the authenticated member's JSON export directly with an attachment
filename; it never returns a long-lived public download URL. Schema version
`2026-07-30` includes authored reviews/updates/responses and complete
configuration for businesses where the member is an active owner (private
contacts, portable coordinates, schedules, payments, menus, stops, and gallery)
without other users' Auth UUIDs or private moderator attribution.

## Account deletion

`DELETE /functions/v1/delete-account` requires:

- a valid `aal2` bearer JWT;
- an `Idempotency-Key` of 16–128 characters;
- `X-Spottr-Delete-Confirmation: DELETE`; and
- JSON `{ "confirmation": "DELETE" }`.

The function freezes account mutations before storage discovery, waits for
outstanding signed upload capabilities and scan leases, checkpoints owned
storage objects in durable request-scoped batches, archives a sole-owned
business, anonymizes retained audit attribution, and only then deletes the Auth
user. A failed storage or Auth operation leaves the request frozen and retryable
without claiming completion. If Auth deletion succeeds but final receipt
persistence is interrupted, the function returns `202` and the account is
signed out locally; it does not claim the deletion receipt is complete. An
ambiguous Auth-provider response leaves the sealed request retryable because the
provider may have committed the deletion before the response was lost.

The service-only `delete-account-worker` continues frozen deletion requests
without relying on the user's browser session. Invoke it on a recurring schedule
with `SPOTTR_ACCOUNT_DELETE_WORKER_SECRET`; it claims one request at a time and
uses the same durable storage seal as the user-facing function. The worker first
atomically finalizes one sealed receipt orphaned by a successful Auth deletion,
then continues ordinary frozen requests. Do not launch
account deletion until that schedule, secret rotation, alerts, and retry drills
are operational.

## Media staging

Media is disabled unless `SPOTTR_MEDIA_UPLOADS_ENABLED=true`.
`POST /functions/v1/media-stage` uses one of two actions:

1. `stage`:
   `{ action, purpose, businessId?, conversationId?, mimeType, byteSize }`
   returns a one-time signed upload URL under
   `quarantine/<auth-user-id>/<random-id>`.
2. `register`: `{ action, purpose, businessId?, conversationId?, storagePath }`
   verifies the uploaded object's server metadata and returns an asset in
   `uploaded/pending`.

Owner/profile purposes require `aal2`; review photos require an active account.
`chat_photo` requires both the public conversation ID and business ID, and the
participant/write-eligibility check runs at staging and registration so a block,
closure, or eligibility change fails closed. Chat media still must complete the
same scan, metadata-stripping, re-encoding, and approval pipeline before an RPC
can attach it to a message. No staged or merely scanned asset is public.

There is no generic Storage `INSERT` policy. Before a signed staging token is
minted, its exact path, owner, purpose, metadata, and expiry are persisted.
Registration consumes that grant under the same owner lifecycle lock used by
account deletion. A scheduled internal call to `media-cleanup`, authenticated by
`SPOTTR_MEDIA_CLEANUP_SECRET`, persists generic cleanup items before removing
Storage objects and finalizes database rows only after a complete receipt. It
handles unregistered objects after one hour, stalled scans after 24 hours, and
rejected media after seven days. Pending or approved claim evidence is excluded.
Clean, unlinked chat uploads older than 24 hours retain their stricter database
claim and shared row lock with message attachment. Crashed workers retry claimed
items after their leases. Successful scanning deletes the raw quarantine input
on a best-effort basis.

## Scanner adapter

`media-scan` is an internal-only adapter and is disabled unless all of these are
configured:

- `SPOTTR_MEDIA_PIPELINE_ENABLED=true`
- `SPOTTR_MEDIA_SCAN_SECRET` (32+ random characters)
- `SPOTTR_MEDIA_SCANNER_URL` (HTTPS)
- `SPOTTR_MEDIA_SCANNER_API_KEY` (32+ random characters)

The scanner must malware-scan, moderate unsafe imagery, strip metadata, and
decode/re-encode the file. Its synchronous JSON response is:

```json
{
  "verdict": "clean",
  "malwareClean": true,
  "contentSafe": true,
  "reencoded": true,
  "metadataStripped": true,
  "outputBase64": "...",
  "mimeType": "image/webp",
  "width": 1200,
  "height": 900,
  "sha256": "64 lowercase hex characters"
}
```

A rejection uses `{ "verdict": "rejected", "reasonCode": "SAFE_ENUM_CODE" }`.
Spottr independently checks size, magic bytes, dimensions, and SHA-256. One
leased scanner owns an asset at a time, reserves an attempt-specific immutable
processed path, uploads with overwrite disabled, and finalizes through a token
comparison. Because the adapter requires both a malware-clean and content-safe
verdict plus a metadata-stripped re-encode, a successful internal finalization
marks that asset approved. Review text and owner-authored updates/responses
always remain pending for a human moderator; clean review photos only make the
submission eligible for approval, while one rejected photo rejects the review.
Nominated business logos remain private until approved and publication readiness
rechecks them. Production launch must keep uploads disabled until a real
scanner, content-safety provider, moderation appeals process, retention policy,
and deletion drill are configured and verified.

The complete rollout and failure-recovery contract is documented in
[`docs/MEDIA_LIFECYCLE.md`](../../docs/MEDIA_LIFECYCLE.md).

## Notification device registration

`POST /functions/v1/notification-device` is the only native-token or browser-
subscription boundary. Registration requires an active `aal2` account,
explicit consent, and the provider-specific server gate. Native registration
also requires the exact Expo project ID. Web registration requires HTTPS, the
exact VAPID public key, and a push-service origin from the configured allowlist.
The Edge function HMACs the token or canonical subscription with a separate
server-only key for deduplication and encrypts it with AES-GCM before calling a
service-role-only RPC; raw values are never stored, returned, exported, or
logged. A token, subscription, or installation moving between accounts revokes
its old ownership before the new registration becomes active.

Current-device and all-device revocation remain callable with a valid session
even while new registration is disabled, so sign-out fails safe. Auth-user
deletion cascades device, consent, outbox-delivery, and preference records.
The standards-based web client requests permission only after an explicit user
action, keeps subscriptions out of local storage, and uses a same-origin service
worker that accepts only generic copy and canonical place routes. Web
registration and delivery have independent default-false gates and still
require VAPID credentials plus browser/device acceptance before activation.

The private transactional outbox stores only an eligible public-event reference,
never owner-update text. Enqueueing and delivery are separate runtime switches
and both default to false. Bounded `SKIP LOCKED` leases, device/event dedupe,
explicit consent, per-business preferences, timezone-aware quiet hours, and an
`unknown` outcome for ambiguous provider requests are database contracts.

`notification-dispatch` adds bounded, internal-authenticated Expo and Web Push
adapters. It decrypts a token or subscription only at send time through a
versioned AES-GCM key ring, validates fixed/allowlisted provider origins, emits
generic lock-screen copy and a canonical place route only, and never retries an
ambiguous send. Accepted Expo tickets create receipt checks no earlier than 15
minutes after submission. Web Push acceptance is recorded without inventing a
device-delivery receipt; HTTP 404/410 retires the subscription, 429 is retryable,
and ambiguous network/provider failures remain terminally unknown.
`notification-receipt` resolves those tickets without resending, retires tokens
that return `DeviceNotRegistered`, and bounds every lease and retry. Provider
5xx responses and expired send leases remain `unknown` for a fixed two-hour
grace window before a service-only finalizer records the terminal `failed`
state; receipt expiry and the 20-attempt ceiling are finalized atomically with
their accepted delivery. Outbox fan-out rows also have a service-only
20-attempt finalizer, while active leases remain untouched. Maintenance treats
any finalizer backlog as unfinished work and withholds its heartbeat.

The Expo provider, Web Push provider, provider-specific registration, dispatch
worker, receipt worker, database enqueue/delivery, and client switches are
independent and all default false. Keep them false until Expo and VAPID
credentials/agreements, receipt/key-rotation drills, scheduler and alerts,
signed-device/browser tests, legal review, and store declarations are approved.
Source code and fake-provider tests are not production acceptance.

## Pickup payments

`payment-connect` is the authenticated AAL2 owner/manager boundary for Stripe
Connect account creation, hosted onboarding, capability refresh, and explicit
prepaid acceptance. `payment-checkout` accepts only business, location, pickup
time, item quantities, and a professional note; the database rebuilds the cart
from current published menu prices before the Edge function creates a hosted
Checkout Session. Card and wallet details remain on Stripe-hosted pages.

`payment-webhook` verifies the raw request body with the pinned Stripe signature
contract before any parsing or mutation. Only signed completion can create a
captured order. Expired/failed checkout, refund, and dispute events are
idempotent. `payment-refund-worker` is internal-bearer protected, claims bounded
leased work, uses stable provider idempotency keys, and never converts an
ambiguous provider result into success.

The customer flag, database runtime gate, checkout/connect Edge gate, refund
worker gate, and maintenance scheduler gate all default false. Keep them false
until Stripe Connect, secret/webhook, tax, payout, refund/dispute, alerting,
signed-device, and legal acceptance is recorded. Provider secrets and connected
account identifiers are server-only and must never enter `EXPO_PUBLIC_*`.
