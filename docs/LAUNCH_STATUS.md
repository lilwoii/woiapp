# Spottr launch status

Last verified: 2026-08-28 (UTC)

Spottr is not yet authorized for a public launch. The application code and
release automation have reached a strong release-candidate baseline, but the
remaining gates depend on owner-controlled production services, credentials,
legal decisions, staffing, signed mobile binaries, and live-environment tests.

## Verified release-candidate evidence

- Source commit `1576e5e3b628736b90ddce9de721cc2c71586083` passed the GitHub Quality and
  CodeQL workflows.
- The Quality workflow replayed the full Supabase schema and migration chain,
  ran application and Edge Function type checks, lint, coverage-gated tests,
  Edge contracts, Expo alignment and Doctor, iOS and Android exports,
  production configuration rejection tests, the production web build,
  rendered desktop/mobile accessibility checks, the production dependency
  audit, secret-history scan, and the commit-bound SBOM job.
- The rendered discovery fixture exercised a bounded 1,200-place response on
  desktop and mobile. Map clusters retain venue-category identity, detailed
  filters cannot contradict the result list, dense viewports disclose that the
  user should zoom or search the area, and multi-location selections preserve
  the exact tapped location.
- Sponsored authoring remains separate from organic ranking, owner/manager and
  AAL2 gated, server priced, idempotent, review gated, and unable to activate or
  charge itself. A released budget reservation cannot later create a debit.
- The push foundation's private tables, grants, consent/preference races,
  bounded outbox/delivery leases, fanout cursor, and device-owner consistency
  passed the full PostgreSQL migration and runtime replay.
- Sites version 45 was built from the exact verified commit and deployed to
  `https://noshatlas-live.lilwoi.chatgpt.site` with owner-only access.
  Anonymous requests return `401`, proving it is not publicly accessible.

## Public-launch blockers

### Production web and backend

- Sites has no production environment values. The deployed owner preview is a
  fail-closed interface, not a live-backend release.
- The current Sites publication does not emit Spottr's required CSP, HSTS,
  anti-framing, content-type, referrer, and permissions headers. It must remain
  private until the verified artifact is placed behind a supported Worker-first
  or custom edge that emits the complete policy in `hosting/headers`.
- `/.well-known/apple-app-site-association` and
  `/.well-known/assetlinks.json` return `404` until the final Apple team/bundle
  identifiers and Android package/signing-certificate hash are configured and
  the host serves the generated association responses.
- A real Supabase production project must receive the reviewed schema,
  migrations, Edge Functions, secrets, schedules, backups/PITR, alerting,
  restricted operator access, Auth policy, redirect allowlist, SMTP, CAPTCHA,
  rate limits, breached-password protection, TOTP recovery, and live RLS/API
  acceptance evidence.
- Production map launch requires a licensed, globally appropriate vector style
  and tile capacity with correct attribution, building/road coverage, key or
  URL restrictions, quotas, billing alerts, and representative geography/load
  tests. The unlicensed public OSM raster fallback is for development only.

### iOS and Android

- Metro exports are verified but are not signed, installable store releases.
- Apple and Google developer organizations, final bundle/package IDs, EAS
  project access, signing certificates/profiles/keys, protected build
  credentials, physical-device tests, TestFlight/closed-track acceptance,
  store listings, screenshots, review accounts, privacy/data-safety
  declarations, age/content ratings, and store approval are still required.
- Deep links, universal/app links, location permissions, account deletion,
  report/block, text scaling, screen readers, poor networks, and supported
  device/OS matrices must be verified against the signed binaries and live
  backend.

### Operations, legal, and safety

- Independent web/mobile/API/RLS penetration testing, abuse/concurrency/load
  testing, capacity targets, incident drills, and recovery evidence remain
  external acceptance requirements.
- Public UGC, media, chat, home kitchens, imported provider listings, business
  claims, navigation, push, ordering, and paid promotion stay behind their
  existing fail-closed feature gates until their runbooks have live evidence.
- Push now has a private encrypted-device, explicit-consent, outbox, delivery-
  lease, preference-RPC, and revocation foundation. It still has no live provider
  adapter or web-push path; enqueueing, delivery, and the client flag remain off.
  APNs/FCM or Expo credentials and DPA, VAPID, receipt handling, key rotation,
  scheduler/alerts, signed-device acceptance, and legal/store review remain
  external blockers.
- Launch requires a legal entity, counsel-reviewed terms/privacy and
  marketplace/food-liability decisions, jurisdiction-by-jurisdiction home
  kitchen approval, licensed data/provider agreements, insurance/tax review,
  and staffed moderation, appeals, support, safety, finance, and incident
  response.
- Paid activation additionally requires an approved payment provider,
  KYB/KYC/sanctions controls, raw-body signed webhooks, event deduplication and
  reordering tests, tax/refund/dispute/cancellation rules, reconciliation,
  finance separation of duties, and Apple/Google approval for the exact native
  advertising and SaaS boundary.

## Required owner inputs

1. Provide the production Supabase project, final HTTPS app domain, EAS project,
   restricted Android map key, licensed web map style/attribution, and the
   server-only secrets listed in `supabase/functions/.env.example`.
2. Provide Apple/Google organization access, final identifiers, signing
   material through the protected build service, store metadata, and the
   Android release certificate SHA-256 value.
3. Select and contract the map, routing, inventory, media-safety, moderation,
   email, push, and payment providers; supply only scoped production secrets.
4. Complete counsel, insurance, tax, food-safety, privacy, store-policy, and
   moderation/operations approvals.
5. Commission the independent staging security, accessibility, device,
   concurrency, abuse, and load acceptance program.

## Safe release sequence

1. Keep every high-risk feature gate false and the Sites project owner-only.
2. Provision the production services and configure secrets outside source.
3. Deploy the reviewed backend chain to isolated staging and complete the live
   acceptance matrices in `docs/RELEASE.md`.
4. Build signed iOS/Android release candidates from one green commit and test
   them with the exact staged backend.
5. Deploy the same verified web artifact behind the compliant edge, verify
   headers/deep links/live flows, then retain hashes and evidence.
6. Obtain explicit legal, security, operations, finance, and store sign-off
   before changing public access or enabling any high-risk feature.
