# Spottr release and operations runbook

The current evidence snapshot and unresolved owner/external requirements are in
[LAUNCH_STATUS.md](LAUNCH_STATUS.md). This runbook remains the authoritative
acceptance procedure.

Spottr is release-ready only when every required item below is supported by
evidence for the exact source commit and target environment. A green local
build, preview URL, schema file, or unsigned native export is not sufficient on
its own.

## 1. Runtime and configuration

Use Node.js 22.13.0 or newer. The repository is aligned to Expo SDK 57, React
Native 0.86, and React 19.2.

Required client-visible production values:

- `EXPO_PUBLIC_APP_ENV=production`
- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_ANON_KEY`
- `EXPO_PUBLIC_APP_URL` using the final HTTPS origin
- `EXPO_PUBLIC_EAS_PROJECT_ID`
- `EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY`, restricted to the release package and
  signing certificate
- `EXPO_PUBLIC_MAP_STYLE_URL`
- `EXPO_PUBLIC_MAP_ATTRIBUTION`
- `EXPO_PUBLIC_MAP_ATTRIBUTION_URL`

`EXPO_PUBLIC_GOOGLE_MAPS_IOS_KEY` is optional for the current iOS map provider.
All client feature gates in [.env.example](../.env.example) remain false until
their separate acceptance evidence exists.

Configure Sites Worker values through Sites:

- `SPOTTR_MAP_CSP_ORIGINS`
- `SPOTTR_APPLE_TEAM_ID`
- `SPOTTR_IOS_BUNDLE_ID`
- `SPOTTR_ANDROID_PACKAGE`
- `SPOTTR_ANDROID_CERT_SHA256`

Configure Edge Function values from
[supabase/functions/.env.example](../supabase/functions/.env.example) in
Supabase. Service-role, scanner, moderation, provider, SMTP, and push
credentials must never enter an `EXPO_PUBLIC_*` value or a committed `.env`.

The production configuration gate in [app.config.ts](../app.config.ts) rejects
missing/placeholder Supabase, app URL, EAS, Android map, web-map style, and
attribution values.

## 2. Source-quality evidence

Run from a clean checkout with the lockfile:

```bash
npm ci
npm run validate
npm run audit:production
```

Record:

- commit SHA, Node/npm versions, operating system, and UTC timestamp;
- complete command output and exit codes;
- Expo Doctor and dependency-alignment output;
- unit/coverage report and any accepted exclusions;
- web artifact hash;
- iOS and Android Metro export hashes.

[The CI quality workflow](../.github/workflows/quality.yml) runs locked install,
Expo alignment, application and Edge Function type-checks, lint, coverage-gated
application tests, Edge Function contract tests, Expo Doctor, fail-closed
production-config verification, web build, and a high-severity production
dependency audit on Node 22.13.1. A passing workflow proves only those checks on
that commit. The web build also fails when required routes, zoomable viewport
metadata, main/H1 semantics, semantic focus targets, reduced-motion CSS, source-map
exclusion, or compressed JavaScript/CSS/HTML budgets regress. Chromium acceptance
then exercises serious WCAG violations across every unconfigured route shell,
route focus/title and back-focus behavior, bounded fallback-state keyboard traversal,
mobile overflow, and minimum primary-control target size against that exact generated
artifact. A separately exported, non-deployable browser artifact uses a fail-closed
synthetic Supabase-compatible fixture to exercise manual-area discovery, a 1,200-feature
map response, real password sign-in, customer hydration, synthetic AAL2 owner-session
hydration, Studio, and private-conversation listing. These are application-integration
fixtures, not proof of an MFA ceremony or database RLS;
populated production data and authorization still require live staging evidence.
Both web and native release verifiers reject the fixture host, synthetic key,
test credentials, test accounts, fixture role, and refresh-token markers if
they appear in a production artifact. A fixture-contaminated export cannot
satisfy the release gate or be deployed as Spottr.

Two separate least-privilege CI jobs add baseline supply-chain evidence. One
downloads a checksum-pinned TruffleHog binary and scans the complete reachable
Git history while keeping potential credential material out of artifacts and
logs. The other uses the exact npm version pinned for the release to generate
a CycloneDX 1.5 production inventory. npm first rejects invalid or missing
dependency edges; Spottr then rebuilds the cross-platform component inventory
and graph from every production lock entry, replacing npm's checkout-name root,
host-platform omissions, and ambiguous package references with deterministic
path-qualified data. It embeds the exact source commit and validates completeness
and hashes against every production lock entry, then validates against checksum-pinned
official schemas and uploads the canonical SBOM plus SHA-256 sidecar under an
artifact name bound to the exact commit SHA. Review both job results and
preserve the SBOM artifact with the release record. This automation does not
inspect unreachable/deleted Git
objects, rotate credentials, determine exploitability, review licenses, or
replace an independent security and dependency review.

The separate CodeQL workflow analyzes JavaScript/TypeScript application code
and GitHub Actions workflow code on pull requests, main-branch pushes, a weekly
schedule, and manual dispatch. It uses the extended security query suite and
uploads findings through GitHub's code-scanning channel with no repository
secrets. Its actions are immutable-commit pinned and the main quality workflow
tests those controls. A green CodeQL run is static-analysis evidence for the
exact commit; it does not replace authenticated runtime penetration testing,
business-logic review, mobile binary analysis, or target-environment testing.

Required independent evidence before public launch:

- review of the reachable-history secret scan, credential-rotation status, and
  commit-bound dependency/SBOM evidence;
- database migration review and adversarial RLS tests;
- web, mobile, Edge Function, and Supabase API penetration tests;
- accessibility checks on keyboard, screen reader, text scaling, contrast,
  motion, touch target, and focus behavior;
- representative device/browser and poor-network testing;
- abuse, concurrency, and load tests with agreed capacity/SLOs.

## 3. Backend acceptance

Apply [supabase/schema.sql](../supabase/schema.sql) first to an isolated staging
project through a reviewed database-change process. Verify the deployed schema,
not just the file:

- anonymous reads use only safe public projections and approved RPCs;
- Auth user IDs, private contacts, claim evidence, permit data, exact private
  locations, reports, and audit details are not anonymously readable;
- home-kitchen/non-public coordinates and address fields are redacted;
- effective status and nearby results use timezone/mobile-stop-aware server
  logic;
- business draft and publication operations require AAL2 and authorized roles;
- published setup edits use staged, audited revisions;
- reviews, responses, and updates remain private until an AAL2 staff moderation
  decision; photo reviews additionally require every derivative to be clean and
  approved, while reports/blocks affect public reads;
- rate limits and idempotency behave correctly under concurrency.

CI runs its focused PostgreSQL fixture, migration, and RLS test through
`psql -X -v ON_ERROR_STOP=1 -1` and first proves that an intentional
middle-statement error is
fatal. A separate pinned Supabase-native runtime then creates an empty local
database, applies `schema.sql`, runs the baseline schema contracts, applies every
timestamped migration in its own fail-fast transaction, and executes post-chain
anon/authenticated/AAL1 security checks. This proves fresh local reproducibility;
it does not replace protected live-staging migration, RLS, MFA, concurrency, and
operational acceptance required below.

Then apply the reviewed map, provider-ingest, and chat migrations in timestamp
order. The chat migration requires participant/RLS, Realtime authorization,
message sequencing, read/typing races, block/report behavior, clean-media state,
and expiring pickup-disclosure tests against the target PostgreSQL project. The
provider migration requires same-key concurrency, rollback, snapshot recovery,
owner-precedence, PostGIS materialization, and maximum-batch query-plan
evidence.

Treat migrations 20260812000000 through 20260816000000 as one Neighborhood
Kitchen meetup release unit. Verify retired pickup-site RPC grants, private
consent receipts, DLP on pickup notes, route/provider revocation, attachment
hiding after clear, and residence disablement at account-deletion begin.
Schedule cleanup_unavailable_meeting_place_requests at least every five minutes
and retain the evidence required by
[NEIGHBORHOOD_MEETUP_OPERATIONS.md](NEIGHBORHOOD_MEETUP_OPERATIONS.md).

Deploy and test:

- `export-account`
- `delete-account`
- `delete-account-worker`
- `media-stage`
- `media-scan`
- `media-cleanup`
- `route-plan`
- `public-discovery`

Configure `SPOTTR_DISCOVERY_RATE_SECRET` as a dedicated 32+-character random
server secret. Deploy the gateway while no client depends on it, apply
`20260823000000_public_discovery_guard.sql` and
`20260824000000_global_map_geography_bbox_repair.sql` in the same reviewed
database change, smoke-test the gateway, and only then publish the matching
clients. Do not revoke the direct RPC grants while a
supported production client still calls them; use an explicitly reviewed
compatibility rollout if that condition ever exists. Verify in the target
project that `cf-connecting-ip` is supplied
by the trusted Edge platform, that a missing header fails closed, and that raw
IP addresses never appear in application tables or logs. Run map/nearby/search
quota, concurrency, timeout, malformed-response, and lease-release drills under
staging load before accepting the endpoint. Prove that timed-out PostgREST
requests stop consuming database capacity under the target project's timeout
and cancellation policy; the Edge HTTP abort alone is not that proof. The
repository guard does not
replace an external WAF, capacity evidence, or review of Supabase platform-log
retention.

Migration `20260810000000_media_lifecycle_serialization.sql` plus `media-stage`,
`media-scan`, `media-cleanup`, and `route-plan` are one controlled release unit.
Keep both media gates false,
pause cleanup and deletion workers, drain legacy signed URLs for their full TTL
plus scanner grace (or invalidate them), apply the migrations, deploy all
matching functions, configure the internal deletion worker on a five-minute or
shorter schedule, refresh the PostgREST schema cache, and run the concurrency
evidence in [MEDIA_LIFECYCLE.md](MEDIA_LIFECYCLE.md) before resuming workers.
Use the executable schedule and activation evidence in
[PRODUCTION_MAINTENANCE.md](PRODUCTION_MAINTENANCE.md); the committed workflow is
not acceptance evidence until its production secrets, heartbeat, and failure alert
are verified.
The media functions may be deployed while their gates remain false; deployment
does not authorize uploads.

Keep `EXPO_PUBLIC_IN_APP_NAVIGATION_ENABLED=false` and
`SPOTTR_ROUTING_ENABLED=false` until the server-only
`MAPBOX_DIRECTIONS_TOKEN` is restricted to the Directions API, provider billing
alerts and hard quotas are active, the 30-request/15-minute user quota is
verified, and authenticated staging tests cover drive, walk, bike, no-route,
timeout, malformed-provider, foreground pause/resume, Reduce Motion, and
external-Maps fallback behavior. Never put the Directions token in an
`EXPO_PUBLIC_*` value. Spottr does not expose in-app navigation to Neighborhood
Kitchen residence locations, does not request background location, and does not
offer a motorcycle mode because the selected provider has no motorcycle routing
profile.

Supabase production acceptance also requires verified-email policy, exact
redirect allowlists, CAPTCHA/rate limits, breached-password protection where
available, TOTP policy/recovery, monitored SMTP, PITR/backups, log redaction,
alerting, key rotation, and least-privilege operator access.

## 4. Web release through Sites

[.openai/hosting.json](../.openai/hosting.json) already identifies the connected
Sites project. Reuse its opaque `project_id`; do not edit it or create another
site for this repository.

1. Run `npm run build:sites` and complete browser QA against the resulting
   source.
2. Commit the exact validated source and push that exact source state using a
   Sites source credential.
3. Package the validated `dist/` output with the Sites packaging helper.
4. Save one Sites version using the pushed commit SHA and packaged artifact.
5. Deploy the saved version privately.
6. Poll until Sites reports success; then verify the returned production URL,
   response/security headers, PWA assets, deep-link fallbacks, auth/reset
   callbacks, map attribution, and `/.well-known/` association files.

Every Sites deployment URL is production. Do not describe it as live-backend
production if it was built without real backend/runtime configuration. Record
the version ID, commit SHA, access level, URL, deployment result, UTC timestamp,
and post-deploy QA evidence.

The connected owner-only Sites preview currently serves static assets ahead of
the checked-in Worker and ignores both the packaged `_headers` policy and the
Worker-first setting. The exported HTML therefore includes a browser-enforced
Content Security Policy and referrer-policy fallback, but the host does not emit
the required CSP, HSTS, anti-framing, content-type, or permissions response
headers. This is an environment limitation, not a passed security control.
Before public access is allowed, deploy the exact approved artifact behind a
host or custom edge that emits the complete policy in `hosting/headers`, then
retain live response-header and browser evidence for every public route. Keep
the Sites project owner-only until that evidence passes.

## 5. Signed mobile release

Native Metro exports are smoke tests, not installable or signed releases.
Production evidence requires owner-controlled Apple and Google developer
accounts plus:

- EAS project access, distribution certificates/profiles, Android upload/app
  signing keys, and protected CI credentials;
- signed production EAS builds for both platforms from the exact approved
  commit;
- installation and deep-link testing on physical iOS/Android devices;
- final bundle/package IDs, versions/build numbers, icons, screenshots,
  descriptions, support/privacy URLs, age/content ratings, and review notes;
- Apple privacy manifest/nutrition labels and Google Data Safety declarations
  matched to actual SDKs and backend behavior;
- working in-app account deletion, UGC report/block, permission prompts, and
  reviewer account instructions;
- TestFlight and closed-track acceptance before store submission;
- store processing/notarization results and retained artifact hashes.

These artifacts cannot be produced or submitted without the owner's signing,
store, legal, and support access.

## 6. Feature-specific gates

### Media

Keep `EXPO_PUBLIC_MEDIA_UPLOADS_ENABLED`, `SPOTTR_MEDIA_UPLOADS_ENABLED`, and
`SPOTTR_MEDIA_PIPELINE_ENABLED` false until:

- a real malware/content-safety scanner produces decoded, re-encoded,
  metadata-stripped derivatives;
- staging, registration, scanner, moderation, cleanup, appeal, and deletion
  paths pass end-to-end tests;
- the restricted moderation queue is staffed with severity targets;
- unsafe, duplicate, oversized, malformed, decompression-bomb, EXIF/GPS, and
  scanner-timeout cases fail closed;
- approved originals/derivatives and rejected/quarantined objects follow the
  documented retention schedule.

### Provider inventory

There is no licensed provider ingestion in this repository. Before enabling one,
retain the signed agreement and field-by-field rules for attribution, display,
caching, refresh, correction, user deletion, termination, and geographic scope.
Imported listings and menus remain drafts until reviewed. Never scrape or clone
third-party directories, marketplaces, reviews, photos, or menus.

### Business ownership claims

Keep `EXPO_PUBLIC_BUSINESS_CLAIMS_ENABLED=false` until the production claim
service issues single-use, expiring challenge receipts for a contact already
bound to the imported listing, or accepts private document evidence through the
clean-media pipeline. Before enabling it, prove receipt signature, audience,
listing, claimant, method, expiry, replay prevention, rate limits, recovery,
withdrawal, evidence deletion, audit history, and ownership-conflict handling
against the target environment. A checked authorization statement, matching
email domain, listed phone selection, uploaded path, or administrator click is
not ownership proof by itself. The public claim RPC deliberately rejects every
method until this contract and its operational review path are deployed. The
database also blocks approval of legacy pending claims. Before deploying to an
existing environment, export and investigate every previously approved claim
and the owner memberships it created; do not automatically revoke a legitimate
owner or accept a historical approval as proof.

### Home kitchens

Keep `EXPO_PUBLIC_HOME_KITCHENS_ENABLED=false` until each enabled jurisdiction
has signed legal approval, permit verification/renewal, allowed-food rules,
privacy testing, food-safety escalation, suspension-on-expiry, insurance/tax
review, and a named operator. Public residence addresses and precise coordinates
are prohibited.

### Push

Keep `EXPO_PUBLIC_PUSH_NOTIFICATIONS_ENABLED=false` until APNs/FCM credentials,
permission/consent UX, quiet hours, per-business preferences, unsubscribe, token
deletion, delivery telemetry, abuse controls, and incident revocation are
verified.

### UGC

Before accepting public UGC, verify report and block controls on every relevant
surface, moderation and appeal queues, repeat-offender controls, emergency
escalation, copyright and food-safety intake, evidence retention, and published
response targets. Professional-language automation is a filter, not a guarantee.

Marketplace chat additionally requires staffed message-report operations,
scheduled ephemeral cleanup, address/DLP controls, retention and privacy-export
coverage, push-notification redaction, and an independent participant/RLS audit.
Chat is server-readable for moderation and is not end-to-end encrypted.

### Monetization and pickup ordering

Production sponsored placement and ordering remain disabled until the separate
acceptance programs in [MONETIZATION.md](MONETIZATION.md) and
[ORDERING_ARCHITECTURE.md](ORDERING_ARCHITECTURE.md) are complete. In
particular, a client interface, state machine, database schema, processor
sandbox, or unsigned build is not evidence of billing, settlement, tax, refund,
store-policy, or marketplace-liability readiness.

Paid inventory must be individually labelled `Sponsored ad`, remain separate
from organic ranking, match every explicit filter, and support hide/report and
plain-language explanation controls. Consumer food checkout and merchant digital
purchases have different Apple/Google payment-policy boundaries; the exact
regional implementation requires current store and legal review.

The phase-O1 shadow-order migrations are deliberately zero-money and employee
only. Apply and review
`supabase/migrations/20260802000000_shadow_ordering_foundation.sql`, followed by
`supabase/migrations/20260831000000_zero_money_pickup_ordering_vertical_slice.sql`,
`supabase/migrations/20260901000000_shadow_order_merchant_queue.sql`, and
`supabase/migrations/20260902000000_shadow_order_transition_maintenance_hardening.sql`
after the baseline schema. Together they provide the server-owned
menu/quote/place/pending-cancel flow plus the bounded, customer-identity-free
merchant fulfillment queue used by the staff pilot UI. Do not change
`pilot_mode` to `shadow` outside an internal operations environment until its
RLS/runtime/concurrency tests have passed against the target Postgres instance.
No migration in this chain authorizes or implements prepaid checkout.

The zero-money placement and pending-cancellation client persists only the
opaque operation IDs, versions, fixed reason, and original idempotency key before
calling either mutation. A killed app must replay and clear that exact operation
before another ordering mutation is enabled. Activate and verify the
service-role-only `expire_shadow_order_quotes` and `expire_shadow_orders`
production-maintenance passes before any internal pilot; a checked-in schedule
is not evidence that their production secret, heartbeat, or alert is configured.

Keep `EXPO_PUBLIC_PICKUP_ORDERING_ENABLED=false` in every customer build until
the full ordering program is approved. The flag exposes only the staff pilot
surface; it is not authorization to accept customer orders or money.

## 7. Account export and deletion drill

Use a production-like staging user with AAL2, a review, follow, alert
preference, report, block, business membership/claim, staged media, and a chat
conversation with a clean attachment and expired pickup disclosure.

1. Call `GET export-account` and verify the no-store JSON includes only the
   documented account/profile/membership/claim/review/follow/preference/report/
   block/media/chat data plus Auth account metadata. Verify credentials,
   moderation notes, other users' private data, and platform audit logs are
   absent.
2. Call `DELETE delete-account` with the required AAL2 session, idempotency key,
   confirmation header, and confirmation body.
3. Verify owned storage objects are gone before Auth deletion; Auth access is
   revoked; the profile and Auth user are gone; reviews, follows, preferences,
   reports, blocks, claims, memberships, chat participant data, owned media
   rows, and private rate records cascade.
4. Verify a solely owned business is archived. For a business with another
   active owner, verify the business remains and deleted-user attribution on
   retained business updates/responses/audit records is null.
5. Inject a storage or Auth failure and prove the response does not claim
   completion, the same idempotency key can safely retry, and duplicate calls do
   not create contradictory outcomes.
6. Inject a final-receipt persistence failure after Auth deletion. Verify the
   user-facing endpoint returns `202` instead of claiming completion, local Auth
   state is cleared, and the recurring worker changes the sealed orphan receipt
   from `storage_deleted` to `completed` exactly once.
7. Inject an ambiguous Auth-provider response after the deletion request is
   sealed. Verify neither Edge path changes the receipt to `failed`; the next
   worker run either retries the still-present Auth user or finalizes the
   FK-orphaned receipt.
8. Verify the private deletion receipt expires and the public/privacy copy
   matches the observed retention behavior.

Record database queries with personal data redacted, storage/Auth checks,
request IDs, timestamps, retry evidence, and operator sign-off.

## 8. Incident and recovery drills

Before launch, name security, privacy, legal, support, moderation, and
infrastructure owners with a 24/7 escalation path appropriate to the launch
scope.

Run and record:

- **Credential compromise:** rotate/revoke Supabase service role, publishable
  key if needed, map/provider keys, scanner secrets, and signing/CI credentials;
  verify old credentials fail.
- **UGC safety event:** quarantine content, preserve restricted evidence,
  suspend abusive accounts/listings, handle user notice/appeal, and meet the
  severity target.
- **Location/privacy event:** disable the affected projection/feature, verify
  logs and caches do not retain precise residence/customer coordinates, assess
  notification duties, and correct the data.
- **Media scanner outage:** prove all uploads remain private or the gates can be
  disabled immediately; drain/retry without bypassing quarantine.
- **Backend outage/data loss:** restore into an isolated project, validate RLS
  and record-level integrity, and prove the approved RPO/RTO.
- **Web rollback:** deploy the previously approved saved Sites version and
  verify the production URL.
- **Mobile response:** document remote feature disablement, backend containment,
  expedited store release, and minimum-supported-version handling.

Each drill needs a date, participants, environment, scenario, commands/actions,
observed outcome, RTO/RPO or response target, gaps, owners, and due dates.

### Production web artifact boundary

The ordinary Quality workflow validates and exports the fail-closed
release-candidate shell. It is not evidence of a live backend configuration.
The exact public-launch web artifact must be created manually by
`.github/workflows/production-web-release.yml` from the approved commit.

Before running it, create a protected `production-web` GitHub Environment with
required reviewers. Configure the public values named by the workflow as
environment variables, and configure only the restricted Supabase publishable
key and Android Maps client key as environment secrets. The build fails when
required origins, app links, legal policies, attribution, or identifiers are
missing or placeholders. It emits a commit-bound `dist/` artifact only after
the configured build and production dependency audit succeed.

Home kitchens, media uploads, push notifications, pickup ordering, in-app
navigation, business ownership claims, and sponsored placements remain
hard-disabled in this production workflow. Enabling any one
requires its own exact-environment acceptance evidence, reviewed workflow
change, and a new artifact. Never add a service-role key, routing/provider
service credential, scanner secret, maintenance secret, or other server-only
credential to this client workflow.

After downloading the artifact, configure the Sites Worker runtime values
separately, save one version at the same commit, deploy with the existing
access policy, and verify the deployed URL. A configured artifact plus a green
workflow still does not replace the production backend, legal, operations,
mobile-store, or independent-review evidence below.

## 9. External launch blockers

The repository cannot supply or invent:

- licensed restaurant/provider agreements and production inventory;
- malware/content-safety provider service and moderation staffing;
- legal entity, effective terms/privacy/safety policies, retention schedule,
  trademark clearance, and real support/privacy/security contacts;
- APNs/FCM, email-provider, map-provider, or observability credentials;
- Apple/Google developer accounts, signing keys, signed builds, store review, or
  approval;
- a public web host or custom edge proven to emit the checked-in CSP, HSTS,
  anti-framing, content-type, referrer, and permissions response headers;
- independent penetration, legal, privacy, accessibility, and load-test
  sign-off.

Until those items and the evidence above are complete, describe Spottr as a
high-quality prelaunch/release candidate, not "100% complete," "risk-free," or
store-ready.
