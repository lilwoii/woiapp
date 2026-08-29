# Spottr security and trust model

This document describes controls present in the repository and the operational
evidence required before launch. It is not a certification, penetration-test
report, or claim that production is risk-free.

## Client and secret boundaries

- The client receives a Supabase publishable key and restricted platform/map
  configuration only.
- Supabase service-role keys, licensed-provider web-service keys, scanner
  credentials, moderation secrets, email credentials, and push credentials
  remain in server-managed environments.
- Native auth persistence uses Expo SecureStore with
  `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.
- The static web client stores the session in tab-scoped `sessionStorage`. Only
  the short-lived PKCE code verifier uses `localStorage` so an email callback
  opened in another tab can complete. Neither storage mechanism is HttpOnly;
  strict CSP, short token lifetimes, dependency control, and XSS testing remain
  mandatory.
- Production deep links are restricted to the configured HTTPS application
  origin and the supported `/auth`, `/reset-password`, and `/place` routes.

No client-side check is treated as authorization.

Home-kitchen launch state follows the same rule. The client
`EXPO_PUBLIC_HOME_KITCHENS_ENABLED` value is only a presentation filter. The
private `home_kitchen_runtime_settings` singleton and
`private.home_kitchens_globally_enabled()` helper are default-false; the
service-role-only audited toggle/status boundary owns changes and inspection.
`private.is_business_publicly_eligible` applies that gate only to
`home_kitchen`, so direct `/place` links, public projections, map/nearby/search
RPCs, RLS-backed reads, and marketplace chat cannot bypass a disabled launch.
Existing home-kitchen conversations also require current chat eligibility.
Disabling cancels active pickup requests and destroys exact disclosures but
does not delete conversation history, staff evidence, or account-export data.

## Authentication and privileged actions

- Supabase Auth owns password hashes; application tables never store passwords.
- Email verification and accepted terms are part of the active-user database
  predicate.
- Usernames are normalized and case-insensitively unique. Database constraints
  and triggers enforce length, reserved-name, impersonation, and
  professional-language rules.
- TOTP is implemented through Supabase MFA. Business onboarding, draft
  configuration, claims, staged publication decisions, mobile-stop scheduling,
  account export, and account deletion require a current `aal2` session.
- Password recovery becomes active only after a recovery event or an allowed
  reset-code exchange. A normal signed-in session is not enough to reach the
  reset operation.
- Recovery from a lost second factor still needs a documented, staffed,
  identity-verified support process before business accounts can launch.

Production Supabase configuration must separately enable verified email,
redirect allowlists, CAPTCHA/rate limits, breached-password protection where
available, appropriate token lifetimes, SMTP monitoring, and TOTP recovery
procedures.

## Database exposure

[supabase/schema.sql](../supabase/schema.sql) enables RLS on application tables,
uses explicit grants, and routes anonymous reads through security-barrier
projections:

- `public_business_directory`
- `public_business_contacts`
- `public_business_locations`
- `public_business_updates`
- `public_business_live_status`
- `public_reviews`
- `public_business_responses`
- `public_business_review_aggregates`
- approved public media projections

Anonymous access to Auth-ID-bearing base tables is revoked. Authenticated base
table reads remain limited to self/member policies. Public profiles expose a
generated public identifier only for people with eligible approved content.
Private business contacts are projected only when the owner has opted to show
them.

Home-kitchen and non-public locations remove street/postal details and snap
coordinates to an approximate grid. Public directory status is computed on the
server from the business timezone, weekly/special hours, active mobile stops,
and unexpired overrides.

Published listing setup cannot be directly rewritten by a member. Material
changes use staged revisions and audited staff decisions. Publication requires
a complete listing, a published location, and an approved processed logo.

These controls still require a migration review and adversarial RLS test against
the exact production schema. Source inspection alone does not prove the deployed
database matches this file.

## Accounts, export, and deletion

`export-account` accepts `GET` with an `aal2` bearer session and returns a
no-store JSON attachment directly to the authenticated user. The current export
contains Auth account metadata, profile, business memberships and claims,
reviews, follows, notification preferences, submitted reports, blocked public
profiles, owned-media metadata, marketplace conversation metadata, authored
messages, pickup requests, and pickup sites submitted or actively owned by the
subject. It does not return credentials, counterpart message bodies, private
moderation notes, or the platform audit log.

`delete-account` accepts `DELETE` with:

- an `aal2` bearer session;
- a 16-128 character idempotency key;
- `X-Spottr-Delete-Confirmation: DELETE`; and
- JSON `{ "confirmation": "DELETE" }`.

The function first removes owned storage objects. It then archives a business
for which the member is the only active owner, clears creator attribution,
destroys exact marketplace pickup disclosures, cancels active pickup requests,
clears ephemeral chat state, closes shared conversations, marks the profile
deleted, and hard-deletes the Supabase Auth user. Chat participant and sender
references become null so the other participant retains a closed, pseudonymized
shared record. Auth-linked
reviews, follows, notification preferences, reports, blocks, memberships,
claims, owned media rows, and rate-limit/idempotency rows cascade with the Auth
user. Business updates/responses and audit records may remain for marketplace
integrity, with the deleted actor reference set to null. A private deletion
exception preserves any non-purged business-claim evidence object and records
the preservation decision without copying its path. Its claim, business, and
claimant references use `ON DELETE SET NULL`, so Auth deletion can remove the
account without deleting held evidence or reintroducing an identity foreign
key. The ordinary storage manifest excludes those paths, and the storage seal
fails closed if a retained evidence path was included or lacks its exact
private exception. Retention duration, hold release, staff access, and purge
authorization remain external legal/security decisions; both evidence intake
and the dedicated purge boundary default off. A private deletion
receipt is idempotent and expires; failures return a retryable error rather than
claiming completion. A per-user advisory lock and live-request unique index reuse
one deletion receipt across devices. The client keeps its verified session open
when a concurrent worker reports `processing`, allowing a safe retry instead of
signing out before Auth deletion is confirmed. If Auth deletion succeeds but the
final private receipt write is interrupted, the endpoint returns `202` with the
receipt-finalization phase, signs the now-deleted account out locally, and the
service-only worker atomically completes that sealed orphan receipt on its next
run. An ambiguous Auth-provider response also leaves the sealed request
retryable instead of downgrading it to failed. Neither endpoint reports
`deleted` until the receipt is durable.

Private notification consents, encrypted device registrations, and pending
delivery rows also reference the Auth user with `ON DELETE CASCADE`. Account
exports include user-controlled preferences, consent history, and sanitized
device lifecycle metadata, but deliberately omit installation/project IDs,
device token hashes, ciphertext, nonces, provider tickets, and credentials.
Raw push tokens may exist only transiently inside the authenticated registration
Edge request and are encrypted before persistence. Token deduplication uses a
separate server-only HMAC key rather than an offline-testable plain digest. Raw
tokens and cryptographic material must never enter logs, Realtime, lock-screen
payloads, analytics, or account exports.

Each active native registration is also bound to the verified Supabase Auth
`session_id` that registered it. Legacy unbound rows are revoked during the
forward migration. Registration validates session ownership server-side;
delivery claim and provider handoff require the same user/session row to remain
present and before `not_after`. Ended sessions revoke the device and cancel
queued work. The app does not allow a native verification or recovery link to
replace an already active account; it requires the existing account's guarded
sign-out flow first. An abnormal direct native A-to-B Auth transition is never
accepted: the prior verified token is retained only in memory long enough to
detach the device and attempt to revoke that server session, the replacement is
rejected, and the user must explicitly sign in again. A non-secret SecureStore
quarantine marker blocks restore across restarts until local replacement
removal is proven; captured tokens are never written to storage or logs. Push
device calls use aborting request timeouts instead of leaving late client
requests running after the caller continues.

Revocation cannot recall a request that already crossed the provider boundary.
A `sending` delivery remains ambiguous and may produce at most the one
already-handed-off notification; it is never converted into a blind retry.

Provider dispatch is internal-authenticated, bounded, and separately gated from
registration and database enqueueing. Tokens are decrypted only at send time
with an explicitly versioned AES-GCM key ring. The provider host is fixed in
source, lock-screen text is generic, and tap data contains only a canonical place
route and public-event identifier. An ambiguous send is recorded as `unknown`
and is never blindly retried. Receipt checks begin after the provider's minimum
recommended delay, do not resend content, and retire devices reported as
`DeviceNotRegistered`. All provider and worker gates default false.
The production-maintenance scheduler path adds another default-false gate and
separate dispatch/receipt worker secrets. It sends only fixed bounded commands,
rejects malformed or inconsistent counters, treats a saturated batch as a
backlog, and withholds its success heartbeat if either push phase fails. It does
not log response bodies, tickets, tokens, or provider errors. Production
activation and missed-heartbeat evidence remain external acceptance
requirements.

The production privacy policy must disclose this behavior and the actual
retention periods. The deletion drill in [RELEASE.md](RELEASE.md) must prove the
behavior against a production-like environment.

## Media and user-generated content

Media is fail-closed:

1. An authenticated request obtains a one-time upload URL in a private
   quarantine namespace.
2. Registration checks the stored object's ownership and server metadata.
3. An internal scanner adapter requires malware-clean, content-safe,
   decoded/re-encoded, metadata-stripped output.
4. Spottr independently checks magic bytes, size, dimensions, and SHA-256.
5. A valid malware-clean, content-safe, re-encoded result is approved by the
   trusted scanner adapter; invalid, failed, or rejected results remain private.
6. Public projections expose only approved processed derivatives. Reports,
   appeals, and removals remain explicit audited staff actions.

Both client and server media gates must remain false until the external scanner,
moderation queue, retention schedule, deletion worker, alerting, and drills are
real. A stub endpoint or a configured flag is not acceptance evidence.

Text reviews, business responses, and short owner updates use length checks,
rate limits, professional-language checks, server-controlled moderation states,
report flows, block relationships, and staff decisions. New text stays private
until an AAL2 staff moderator approves it through the audited, concurrency-safe
queue. The local filter is only an early rejection aid; it is never treated as
proof that content is safe.
Launch requires:

- visible report and block controls wherever eligible UGC or its author appears;
- a staffed moderation queue with severity targets and emergency escalation;
- notice, appeal, repeat-offender, and evidence-preservation procedures;
- documented handling for copyright, food-safety, threats, and lawful requests;
- abuse/load tests covering creation, reporting, blocking, and moderation RPCs.

## Location privacy

- Request foreground location only and always provide city/ZIP fallback.
- Do not persist customer search coordinates to profiles or marketplace tables.
- Redact or round coordinates in telemetry and security logs.
- Public map/search admission stores only server-keyed HMAC digests for network
  and account rate buckets. Raw client addresses and Auth IDs never enter those
  discovery tables or application logs. Supabase platform-log retention and
  access remain a separate production privacy control.
- Food-truck locations are owner-published stops, not continuous owner-device
  tracking.
- Never expose a home residence address or precise marker in public APIs,
  notifications, exports, screenshots, or logs.

## External verification required

Before public launch, retain evidence of:

- independent web/mobile/API penetration testing;
- database/RLS and staged-publication review;
- abuse, rate-limit, and load tests;
- dependency/SBOM and secret-scanning review;
- backup restoration with approved RPO/RTO;
- key rotation and incident-response drills;
- Apple/Google privacy, UGC, authentication, and account-deletion compliance;
- real support/security/privacy contacts and moderation staffing.

The release may be called production-ready only after the checklist in
[RELEASE.md](RELEASE.md) is complete for the exact commit and deployed
environment.
