# Spottr release and operations runbook

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
All three feature gates in [.env.example](../.env.example) remain false until
their separate acceptance evidence exists.

Configure Sites Worker values through Sites:

- `SPOTTR_MAP_CSP_ORIGINS`
- `SPOTTR_APPLE_TEAM_ID`
- `SPOTTR_IOS_BUNDLE_ID`
- `SPOTTR_ANDROID_PACKAGE`
- `SPOTTR_ANDROID_CERT_SHA256`

Configure Edge Function values from
[supabase/functions/.env.example](../supabase/functions/.env.example) in
Supabase. Service-role, scanner, moderation, provider, SMTP, and push credentials
must never enter an `EXPO_PUBLIC_*` value or a committed `.env`.

The production configuration gate in [app.config.ts](../app.config.ts) rejects
missing/placeholder Supabase, app URL, EAS, Android map, web-map style, and
attribution values.

## 2. Source-quality evidence

Run from a clean checkout with the lockfile:

```bash
npm ci
npm run validate
npm audit --omit=dev --audit-level=high
npx expo export --platform ios
npx expo export --platform android
```

Record:

- commit SHA, Node/npm versions, operating system, and UTC timestamp;
- complete command output and exit codes;
- Expo Doctor and dependency-alignment output;
- unit/coverage report and any accepted exclusions;
- web artifact hash;
- iOS and Android Metro export hashes.

[The CI quality workflow](../.github/workflows/quality.yml) runs locked install,
Expo alignment, application and Edge Function type-checks, lint,
coverage-gated application tests, Edge Function contract tests, Expo Doctor,
fail-closed production-config verification, web build, and a high-severity
production dependency audit on Node 22.13.1. A passing workflow proves only
those checks on that commit.

Required independent evidence before public launch:

- secret scan and dependency/SBOM review;
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

Deploy and test:

- `export-account`
- `delete-account`
- `media-stage`
- `media-scan`
- `media-cleanup`

The three media functions may be deployed while their gates remain false.
Deployment does not authorize uploads.

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

Keep `EXPO_PUBLIC_MEDIA_UPLOADS_ENABLED`,
`SPOTTR_MEDIA_UPLOADS_ENABLED`, and `SPOTTR_MEDIA_PIPELINE_ENABLED` false until:

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

There is no licensed provider ingestion in this repository. Before enabling
one, retain the signed agreement and field-by-field rules for attribution,
display, caching, refresh, correction, user deletion, termination, and
geographic scope. Imported listings and menus remain drafts until reviewed.
Never scrape or clone third-party directories, marketplaces, reviews, photos,
or menus.

### Home kitchens

Keep `EXPO_PUBLIC_HOME_KITCHENS_ENABLED=false` until each enabled jurisdiction
has signed legal approval, permit verification/renewal, allowed-food rules,
privacy testing, food-safety escalation, suspension-on-expiry, insurance/tax
review, and a named operator. Public residence addresses and precise
coordinates are prohibited.

### Push

Keep `EXPO_PUBLIC_PUSH_NOTIFICATIONS_ENABLED=false` until APNs/FCM credentials,
permission/consent UX, quiet hours, per-business preferences, unsubscribe,
token deletion, delivery telemetry, abuse controls, and incident revocation are
verified.

### UGC

Before accepting public UGC, verify report and block controls on every relevant
surface, moderation and appeal queues, repeat-offender controls, emergency
escalation, copyright and food-safety intake, evidence retention, and published
response targets. Professional-language automation is a filter, not a
guarantee.

### Monetization and pickup ordering

Production sponsored placement and ordering remain disabled until the separate
acceptance programs in [MONETIZATION.md](MONETIZATION.md) and
[ORDERING_ARCHITECTURE.md](ORDERING_ARCHITECTURE.md) are complete. In
particular, a UI preview, client state machine, database schema, processor
sandbox, or unsigned build is not evidence of billing, settlement, tax,
refund, store-policy, or marketplace-liability readiness.

Paid inventory must be individually labelled `Sponsored ad`, remain separate
from organic ranking, match every explicit filter, and support hide/report and
plain-language explanation controls. Consumer food checkout and merchant
digital purchases have different Apple/Google payment-policy boundaries; the
exact regional implementation requires current store and legal review.

## 7. Account export and deletion drill

Use a production-like staging user with AAL2, a review, follow, alert
preference, report, block, business membership/claim, and staged media.

1. Call `GET export-account` and verify the no-store JSON includes only the
   documented account/profile/membership/claim/review/follow/preference/report/
   block/media data plus Auth account metadata. Verify credentials, moderation
   notes, other users' private data, and platform audit logs are absent.
2. Call `DELETE delete-account` with the required AAL2 session, idempotency key,
   confirmation header, and confirmation body.
3. Verify owned storage objects are gone before Auth deletion; Auth access is
   revoked; the profile and Auth user are gone; reviews, follows, preferences,
   reports, blocks, claims, memberships, owned media rows, and private rate
   records cascade.
4. Verify a solely owned business is archived. For a business with another
   active owner, verify the business remains and deleted-user attribution on
   retained business updates/responses/audit records is null.
5. Inject a storage or Auth failure and prove the response does not claim
   completion, the same idempotency key can safely retry, and duplicate calls do
   not create contradictory outcomes.
6. Verify the private deletion receipt expires and the public/privacy copy
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

## 9. External launch blockers

The repository cannot supply or invent:

- licensed restaurant/provider agreements and production inventory;
- malware/content-safety provider service and moderation staffing;
- legal entity, effective terms/privacy/safety policies, retention schedule,
  trademark clearance, and real support/privacy/security contacts;
- APNs/FCM, email-provider, map-provider, or observability credentials;
- Apple/Google developer accounts, signing keys, signed builds, store review,
  or approval;
- independent penetration, legal, privacy, accessibility, and load-test
  sign-off.

Until those items and the evidence above are complete, describe Spottr as a
high-quality prelaunch/release candidate, not "100% complete," "risk-free," or
store-ready.
