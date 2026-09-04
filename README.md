# Spottr

**Live local food, mapped.**

Spottr is a universal Expo application for iOS, Android, and web. Food trucks
lead discovery, while restaurants, pop-ups, cafes, and bakeries share the same
directory.

This repository is prelaunch source, not evidence of a live production
marketplace. When production services are absent, the app fails closed: it
shows no fixture listings, accepts no credentials, and performs no simulated
account, safety, review, claim, or business mutations.

## Current product surface

- Foreground-location or city/ZIP discovery, with no fabricated live-area
  fallback
- Food-truck-first categories, distinctive map markers, and a gated employee-only zero-money pickup pilot
- Nearby, Popular, and Trending views
- Server-computed effective status from timezone-aware hours, special hours,
  mobile stops, and expiring owner overrides
- Listing details with published locations, hours, menus, prices, payment
  methods, short owner updates, first-party ratings, and reviews
- Follows, saved places, and per-business alert preferences
- Customer and business modes in one application
- Email/password accounts, case-insensitive unique usernames, PKCE recovery,
  TOTP enrollment/challenge, and global sign-out
- AAL2-gated business onboarding, draft configuration, claims, mobile-stop
  scheduling, protected pickup fulfillment, account export, and account deletion
- Safe public database projections for directory, contact, location, review,
  aggregate, status, update, and approved-media reads
- Report and block flows, server-controlled moderation states, rate limits,
  deterministic professional-language checks, and staffed escalation paths

Public media reads and a quarantine/scanner adapter exist, but customer and
business uploads remain disabled by default. They must stay disabled until a
real malware/content-safety scanner and staffed moderation operation pass the
acceptance drills in [RELEASE.md](docs/RELEASE.md).

## Toolchain

- Node.js 22.13.0 or newer
- Expo SDK 57
- React Native 0.86
- React 19.2

Install and run:

```bash
npm ci
npm run web
```

Native development:

```bash
npm run ios
npm run android
```

Repository validation:

```bash
npm run validate
```

`npm run validate` type-checks, lints, runs coverage-gated tests, verifies that
production configuration fails closed, checks Expo dependency health, and
builds the Sites web artifact. Native Metro export checks are separate:

```bash
npx expo export --platform ios
npx expo export --platform android
```

These exports are not signed applications and do not prove App Store or Play
Store readiness.

## Production configuration

Copy [.env.example](.env.example) to an ignored `.env` for local work. The
production build gate requires real Supabase, public application URL, EAS,
Android Maps, and licensed web-map style/attribution values. Feature flags for
home kitchens, uploads, and push are false by default.

Only publishable client values belong in `EXPO_PUBLIC_*`. Supabase service-role
keys, scanner credentials, moderation secrets, provider web-service keys, and
push credentials are server-side values. See
[the Edge Function environment template](supabase/functions/.env.example).

Apply [supabase/schema.sql](supabase/schema.sql) and then the ordered files in
[supabase/migrations](supabase/migrations) only through a reviewed staging and
production database-change process. Deploy and test the account and media Edge
Functions separately; SQL or function source in version control is not proof
that a production project has received or safely exercised it.

## Deliberate launch gates

- Restaurant inventory must be owner-submitted or supplied under a licensed
  provider agreement. Spottr must not scrape or clone Yelp, Google, DoorDash,
  Facebook Marketplace, or restaurant sites.
- Home kitchens remain disabled until each jurisdiction has documented legal
  approval, permit operations, privacy review, and incident ownership. The
  `EXPO_PUBLIC_HOME_KITCHENS_ENABLED` flag only controls client presentation;
  migration `20260929000000_home_kitchen_global_launch_gate.sql` adds the
  authoritative private, default-false server gate that also protects direct
  place links, discovery projections, and marketplace chat. Only the
  service-role launch-gate boundary may read or change that state.
- Photo uploads remain disabled until scanning, re-encoding, moderation,
  retention, appeals, and deletion are operational.
- Push remains disabled. The repository contains a private encrypted-token,
  explicit-consent, event-reference outbox, bounded delivery, preference RPC,
  sign-out revocation, fail-closed Expo dispatch/receipt adapter, and an
  independently gated production-maintenance scheduler path. Production
  credentials, scheduler activation and alerts, key-rotation drills, web VAPID,
  signed-device tests, legal review, and delivery/opt-out evidence are still
  required.
- Sponsored placements remain disabled and shadow-only until advertiser terms,
  payment/store-policy review, fraud operations, and finance reconciliation are
  approved for the exact production deployment.
- Production legal, privacy, safety, and support contacts must be supplied and
  reviewed; the repository does not invent them.
- Signed iOS/Android builds, store metadata, privacy declarations, reviewer
  accounts, and submission evidence require the owner's Apple/Google accounts
  and signing access.
- Spottr is a working name until trademark, domain, and store-name clearance is
  completed.

The connected web project is identified by
[.openai/hosting.json](.openai/hosting.json). Reuse that project through the
Sites workflow; do not create a duplicate project. See [RELEASE.md](docs/RELEASE.md)
for the exact evidence and deployment checklist, [PRODUCT.md](docs/PRODUCT.md)
for scope, [GLOBAL_DIRECTORY.md](docs/GLOBAL_DIRECTORY.md) for worldwide food
inventory and map clustering, [MAP_PLATFORM.md](docs/MAP_PLATFORM.md) for the
licensed 3D/routing provider plan, and [SECURITY.md](docs/SECURITY.md) for security boundaries.

The ordinary Quality workflow exports only the fail-closed release-candidate
shell. A public-launch web artifact must come from the manual **Production web
release artifact** workflow at the exact approved commit. Configure its
`production-web` GitHub Environment with required reviewers, the publishable
variables named in `.env.example`, and only the two restricted client keys used
by that workflow. Server-role, provider-service, scanner, and worker secrets
must never enter the client build. High-risk feature flags remain disabled in
that workflow until their separate release evidence is approved.
