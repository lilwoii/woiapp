# Spottr launch status

Last verified: 2026-08-30 (UTC)

Spottr is not yet authorized for a public launch. The application code and
release automation have reached a strong release-candidate baseline, but the
remaining gates depend on owner-controlled production services, credentials,
legal decisions, staffing, signed mobile binaries, and live-environment tests.

## Verified release-candidate evidence

- Source and web publication commit
  `e11bd21f46c2920548924a01a7a6812f735a5d13` passed the GitHub
  [Quality](https://github.com/lilwoii/woiapp/actions/runs/33286111042) and
  [CodeQL](https://github.com/lilwoii/woiapp/actions/runs/33286110976) workflows.
  A second, manually dispatched
  [Quality run](https://github.com/lilwoii/woiapp/actions/runs/33286418836)
  produced the commit-bound Sites artifact after passing both the full
  PostgreSQL schema/migration/runtime replay and the independent shadow
  migration-order replay.
- Backend hardening commit
  `ba0c0cd8ec6bec8275a76528c83ffc0bb929c164` passed the GitHub
  [Quality](https://github.com/lilwoii/woiapp/actions/runs/33288076844) and
  [CodeQL](https://github.com/lilwoii/woiapp/actions/runs/33288076781) workflows.
  Claim approval now rechecks licensed-provider eligibility behind an
  authorization-first exclusive transaction barrier, while provider account,
  source, and ingest mutations take its shared side. The cloud runtime proves
  all three mutation paths block a concurrent approval barrier and proves an
  unauthorized caller is rejected before it can wait on that barrier. Claim
  submission and evidence intake remain fail-closed.
- Account-portability commit
  `1eeb9f73b181a0079da06ef9a8709e3a3d3a6a6c` passed the GitHub
  [Quality](https://github.com/lilwoii/woiapp/actions/runs/33289445672) and
  [CodeQL](https://github.com/lilwoii/woiapp/actions/runs/33289445608) workflows.
  The final service-only export again preserves chat, neighborhood-meetup, and
  push sections, adds subject-scoped social profile, follow, reaction, comment,
  business-post, invitation, and sanitized media records, and replaces private
  storage paths with opaque asset identifiers. The cloud runtime also proves
  Auth deletion cascades or anonymizes the corresponding social records.
- Global map-camera commit
  `aad85320db62e7131f6f6aad653c27e1e85131d8` passed the GitHub
  [Quality](https://github.com/lilwoii/woiapp/actions/runs/33290028588) and
  [CodeQL](https://github.com/lilwoii/woiapp/actions/runs/33290028574) workflows.
  Native maps now initialize and deliberately refocus from actual returned
  result coordinates or foreground location instead of a fixed-city camera, without
  overriding manual exploration. Native and web place and route fitting share
  latitude-safe shortest-arc geometry for high-latitude and international-date-
  line cases, and stale selections cannot override a new city or ZIP fit.
- Feed and authority hardening commits `e26c7d48fd6a626981753feb0333563e8e0ecbc4`,
  `1f3e725012a4f195e1793df7f4c39f566804793b`, and
  `8deec1ddfb62537da97e919dd65394a37d67b94e` are covered by the cumulative
  green GitHub [Quality](https://github.com/lilwoii/woiapp/actions/runs/33292856619)
  and [CodeQL](https://github.com/lilwoii/woiapp/actions/runs/33292856635)
  workflows. Followed-feed reads now use account-bound deterministic keyset
  pagination rather than offset paging or a directly readable aggregate view.
  Business revisions, business and creator invitation responses, creator
  review-independence acknowledgments, profile follows, and safety blocks all
  require explicit non-null intent after authorization. The rollback-only
  PostgreSQL runtime proves malformed inputs preserve the existing authority,
  follow, and block state.
- Sponsored privacy and viewability commits
  `615e383c0592180966b9ffbe1be0afcfeba63ef9` through
  `1d6f07e034dfa9e79b5b610f0cec0e1df51af757` are covered by the cumulative
  green GitHub [Quality](https://github.com/lilwoii/woiapp/actions/runs/33328978993)
  and [CodeQL](https://github.com/lilwoii/woiapp/actions/runs/33328979081)
  workflows. Sponsored selection now targets only the public redacted location
  projection and cannot create an unseen impression or budget hold. The client
  acknowledges an impression only after the filtered placement remains at
  least 50% visible for one continuous second while the app is foregrounded;
  the service-only interaction boundary then revalidates subject binding,
  campaign and public-location eligibility, budget, and idempotency before it
  atomically acquires the hold. Open billing retains the campaign lock through
  reservation consumption and ledger insertion. The clean PostgreSQL runtime
  replay proves stale provider-location withdrawal, direct-RPC denial,
  duplicate delivery, shadow-mode nonbilling, and reservation release.
- Business-follow authority commits `86e9d0409d87565a33d96c0e3cf0ce5049ab80cb`
  through `f57f2e953782610929768b35763b6b2f2ecb0515` are covered by the green
  GitHub [Quality](https://github.com/lilwoii/woiapp/actions/runs/33330799170)
  and [CodeQL](https://github.com/lilwoii/woiapp/actions/runs/33330799206)
  workflows. Direct authenticated follow-table writes are removed; the
  account-bound mutation authority is active-user, eligibility, deletion,
  rate-limit, follow-cap, idempotency, and change-audit guarded. Stale or
  archived listings remain removable, and the parent lock serializes unfollow
  with hard deletion. The manually dispatched
  [release run](https://github.com/lilwoii/woiapp/actions/runs/33331218617)
  reproduced the full green release suite and commit-bound web artifact. That
  exact artifact is privately published as owner-only Sites version 54 at
  https://noshatlas-live.lilwoi.chatgpt.site/.
- Mobile-map authority commits `0a85b1120e699a63b893f12325e881208779c4e4`
  through `f6f44b8910dcb5b0dee77205eee283a5ed1762eb` are covered by the exact-head
  green GitHub [Quality](https://github.com/lilwoii/woiapp/actions/runs/33333087287)
  and [CodeQL](https://github.com/lilwoii/woiapp/actions/runs/33333087264)
  workflows. Food trucks and pop-ups now expose only their deterministic
  current scheduled/live stop, or their eligible primary fallback, while
  fixed-location categories retain their published multi-location behavior.
  The visible foreground map revalidates on mobile-stop events and bounded
  expiry intervals, reads the latest viewport after debounce, and fails closed
  to the retry state instead of leaving an unverified stale marker visible.
  The manually dispatched
  [release run](https://github.com/lilwoii/woiapp/actions/runs/33333501766)
  reproduced the full green release suite and produced the commit-bound web
  artifact. That exact artifact is privately published as owner-only Sites
  version 55 at https://noshatlas-live.lilwoi.chatgpt.site/.
- Map-first polish commits `209f90faae7186acbe4348249e7b1492a412be35`
  through `b5819e546f90ff0de174ba339bd4b85f80dfb559` are covered by the
  exact-head green GitHub
  [Quality](https://github.com/lilwoii/woiapp/actions/runs/33338197377)
  and [CodeQL](https://github.com/lilwoii/woiapp/actions/runs/33338197370)
  workflows. Discovery now retains the map through empty and disconnected
  states without inventing a city, bounds dense fallback rendering while
  preserving represented counts and the selected listing, cancels stale area
  searches, and refuses oversized live-inventory viewports. Native driving
  mode requests the device platform's traffic layer, with coverage still subject
  to signed-device/provider acceptance. Route requests abort on timeout,
  preserve supported travel modes when opening Apple or Google Maps, and
  discard guidance if a mobile destination moves. Web controls advertise 3D
  only when the loaded style declares a `fill-extrusion` layer; provider
  licensing, layer visibility, and regional building coverage remain release
  evidence. Rendered markers remain keyboard reachable. Foreground native
  notification presentation and strictly parsed notification-tap routes are
  also covered while every production push gate remains false. The rendered
  desktop/mobile suite exercised 100 accessibility and functional cases,
  including customer and owner authentication fixtures, registration
  contracts, duplicate-username rejection, chat, feed, map, navigation, and
  empty-search state.
- The current map-first release candidate adds a food-truck-only “Moving to
  next location” projection backed by a confirmed exact public stop within 12
  hours. Web and native markers clearly identify the scheduled destination and
  never claim to show a vehicle's live position; stale detail state cannot
  override authoritative inventory, and clients batch an authoritative refresh
  when the stop boundary arrives. Navigation now offers conservative on-device
  Auto estimation, traffic-aware driving plus walking and biking routes,
  provider-estimated arrival time for a fresh route, persistent stale guidance
  labelled as an original estimate, explicit refresh and Apple/Google handoff,
  and immediate foreground watcher
  cancellation if a destination disappears or becomes privacy-blocked. Search
  is diacritic-safe and token-aware over public food data, with exact business,
  cuisine, and loaded-menu matches ahead of incidental text.
- Account notification settings now preserve mixed per-business choices and
  offer validated IANA quiet-hours presets without changing consent or delivery
  state. Native and standards-based browser registration/dispatch paths are
  implemented with generic lock-screen content and independent fail-closed
  gates; push remains visibly and technically off pending credentials and live
  acceptance. Verified restaurants and food trucks have a complete gated
  pay-in-person pickup flow. A separate gated Stripe Connect path provides
  hosted merchant onboarding, server-priced card/wallet checkout, automatic
  tax, signed-webhook order creation, durable refunds, and dispute-safe state;
  every payment and ordering gate remains off pending credentials and live
  acceptance. The licensed 3D
  basemap/routing decision and legal data boundary are documented in
  [MAP_PLATFORM.md](MAP_PLATFORM.md).
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
- User-published profile and business links now share a strict public-HTTPS
  policy across iOS, Android, web, database constraints, staged revisions, and
  public projections. Credential-bearing URLs, custom ports, IP literals,
  numeric-address aliases, single-label hosts, and reserved/internal suffixes
  fail closed. Licensed-provider URLs that do not qualify remain private rather
  than rolling back an otherwise valid provider batch.
- The push foundation's private tables, grants, consent/preference races,
  bounded outbox/delivery leases, fanout cursor, device-owner consistency,
  atomic provider handoff, delayed receipt checks, ambiguous-send handling,
  and invalid-token retirement passed the full PostgreSQL migration and
  runtime replay. Active native registrations are now bound to a verified Auth
  session; missing, expired, and removed sessions are rejected or retired, and
  queued deliveries are cancelled. The runtime suite also proves that moving
  one physical installation between accounts revokes the prior owner, cancels
  that owner's queued delivery, and preserves a single active device owner
  through a complete account A-to-B-to-A transition. Removing a follow now
  cancels its queued or leased deliveries, while both worker claim and provider
  handoff revalidate the follow before sending. Native sign-in and account
  creation require an anonymous authoritative session, startup auth callbacks
  wait for persisted identity restoration, and native deep-link exchange waits
  for the same successful restore decision. A direct authenticated identity
  replacement is rejected with a non-secret, restart-persistent quarantine
  marker until local cleanup is proven. Dispatch and receipt Edge contracts use
  fixed Expo endpoints, generic lock-screen copy, bounded provider batches,
  versioned token keys, and independent fail-closed worker/provider switches.
- Sites version 53 was built, saved, and privately deployed from exact verified
  web commit `8deec1ddfb62537da97e919dd65394a37d67b94e` on 2026-08-30 UTC at
  `https://noshatlas-live.lilwoi.chatgpt.site`. The access policy was rechecked
  immediately before deployment: the caller is the owner, custom access allows
  exactly one account user, and no workspace groups, tenant groups, or external
  visitors are allowed.

## Public-launch blockers

### Production web and backend

- Sites has no production environment values. The deployed owner preview is a
  fail-closed interface, not a live-backend release.
- The latest exact-head artifact is not published: Sites is bound to `main`,
  while the verified release candidate remains on the protected
  `production-hardening-rc` branch pending explicit promotion approval. The
  owner-only version 55 publication therefore remains the current preview.
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
- In-app production routing is hard disabled in the client, release workflows,
  native verifier, and server environment. Activation requires a reviewed
  code/config/workflow policy change plus restricted provider credentials,
  billing controls, privacy acceptance, and signed-device route testing.

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
- Business-claim evidence intake remains disabled. The private retention
  foundation defaults every migrated evidence object to legal hold, removes
  raw paths from the public claim row, blocks ordinary cleanup, direct owner
  deletion, and account-deletion manifests from erasing retained evidence, and
  keeps purge behind a separate default-off service gate. Counsel must still
  approve retention duration, hold release, purge, access, appeal, and deletion
  precedence before document evidence or claims can be enabled.
- Push now has private encrypted native-token and browser-subscription storage,
  explicit consent, an event-reference-only outbox, delivery leases,
  preference RPCs, revocation, and fail-closed Expo and Web Push adapters. Expo
  receipt polling and browser invalid-subscription retirement are implemented
  and contract-tested, and the production-maintenance client has an independently
  gated, bounded dispatch/receipt scheduler path with strict response validation
  and heartbeat failure semantics. It has no accepted production credentials,
  scheduler activation/alert evidence, or signed-device/browser evidence;
  registration, enqueueing, delivery, both providers, both workers, the scheduler
  gate, and the client flag remain off. Expo/APNs/FCM credentials and DPA, VAPID,
  key-rotation and receipt drills, production scheduler/alerts, signed-device and
  browser acceptance, and legal/store review remain external blockers.
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
- Pickup payment code is provider-hosted and fail-closed, but production still
  needs Stripe secret/webhook credentials, Connect approval, enabled countries,
  tax registrations, bank settlement, refund-worker scheduling/alerts, live
  webhook replay tests, and real card/wallet/device acceptance.

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
