# Spottr product brief

## Position

Spottr's wedge is reliable, live local-food discovery:

> Know what is open, where it is, what it serves, what it costs, and how you can
> pay before you go.

Food trucks remain first in category order, map treatment, and nearby results.
Restaurants, pop-ups, cafes, and bakeries broaden daily usefulness without
erasing that focus.

## Implemented product model

Venue types:

1. Food trucks
2. Restaurants
3. Pop-ups and market vendors
4. Cafes and bakeries
5. Home kitchens, hidden unless a server-controlled jurisdiction is legally
   approved and the business has a current verified permit

The universal client currently supports:

- foreground-location and city/ZIP/business/cuisine discovery;
- map/list results with visually distinct truck markers;
- open-only, venue, cuisine, dietary, payment, price, distance, rating, pickup,
  Nearby, Popular, Trending, and Top rated controls;
- timezone-aware weekly and special hours, mobile stops, expiring status
  overrides, and short owner updates;
- published menus with integer minor-unit prices, availability, dietary tags,
  and payment methods;
- follows, saved places, alert preferences, reviews, reports, and blocks;
- customer workflows plus AAL2-protected business draft, claim, and scheduling
  workflows in one account;
- draft business setup, claims, staged published-listing revisions, and mobile
  stop scheduling.
- AAL2-protected business identity/contact/logo editing and a restricted,
  concurrency-safe staff moderation workspace.

Paid placement is implemented as a separately labelled `Sponsored ad` lane and
never changes organic order. Production campaign serving, charging, reporting,
and native purchase controls remain disabled until the server ledger, fraud,
legal, payment, and store-policy gates in [MONETIZATION.md](MONETIZATION.md)
are complete. Unconfigured builds show no fixture placement.

In live mode, nearby distance and safe coordinates come from PostGIS. Effective
open status comes from the server. The client does not substitute a default city
when the user has not selected an area.

Popular and Trending are presently transparent heuristics over the safe
first-party aggregate projection (rating, review counts, recent reviews,
followers, and active owner updates). They are product navigation aids, not a
fraud-resistant recommendation system. Scale launch requires event-quality
validation, exposure normalization, anti-manipulation monitoring, and documented
ranking changes. Paid placement must be clearly labelled and separate from
organic results.

## Data integrity rules

- Only published, eligible listings appear in anonymous directory projections.
- Public status is computed from the listing timezone, special/weekly schedule,
  current mobile stop, and an unexpired manual override.
- Distance is computed from PostGIS geography and is not stored as display
  text.
- Ratings aggregate only visible first-party Spottr reviews.
- Provider ratings, if licensed later, remain separately labelled and are never
  merged into Spottr ratings.
- Provider, owner, and community provenance remain distinct.
- Imported menus must enter an owner-reviewed draft with source and freshness
  metadata; they are never silently published.
- Published listing changes are staged and audited instead of directly changing
  the live directory.
- Food-truck locations are deliberate public business stops, not background
  tracking.
- Home-kitchen public coordinates are approximate and street/postal details are
  withheld.

## Launch boundary

### Candidate city launch

- Curated, owner-submitted trucks and restaurants
- Guest browsing and verified email/password accounts
- Unique usernames and TOTP-protected business tools
- Nearby/search, hours/stops, payments, menus, follows, and text reviews
- Manual claims, listing publication, correction review, and UGC moderation
- Report/block controls and staffed safety escalation
- In-app account export and deletion

This phase does **not** include automated restaurant ingestion, ordering,
payments, delivery, customer background tracking, home kitchens, photo uploads,
or push delivery unless their separate gates are complete.

### Gated expansion

- Moderated review, logo, menu, and gallery photos after scanner/operations
  acceptance
- Push notifications after the private encrypted-device/outbox foundation is
  deployed and consent, provider receipts, quiet hours, unsubscribe, signed-
  device behavior, credentials, and operational evidence are accepted. The
  current foundation makes no provider call and remains disabled.
- Licensed provider inventory with contractual attribution, field-level
  provenance, refresh, correction, caching, and deletion rules
- Owner-authorized menu OCR into review-before-publish drafts
- Federated sign-in only after platform-specific account-linking and deletion
  behavior is verified
- Home kitchens one jurisdiction at a time after legal, permit, privacy, and
  incident review

Ordering, payments, delivery, tax, insurance, and marketplace-liability
features require a separate product and legal program; they are not implied by
the listing application.

[ORDERING_ARCHITECTURE.md](ORDERING_ARCHITECTURE.md) defines the versioned
catalog, quote, order, payment, refund, capacity, fraud, and future-delivery
boundaries for that gated program. Pure client-domain code or a staff-only pilot cart is
not evidence that production ordering is enabled.

## External product blockers

- No licensed restaurant/provider feed or agreement is included in this
  repository. Do not scrape Yelp, Google, DoorDash, Facebook Marketplace, or
  restaurant sites.
- No production scanner, moderation staffing contract, APNs/FCM setup, or
  provider credential is proved by the source tree.
- Production privacy/terms/safety copy needs a real legal entity, effective
  date, retention schedule, and reachable support/privacy/security contacts.
- Store submissions need signed binaries, store metadata, reviewer access,
  privacy declarations, and owner-controlled Apple/Google accounts.
- Spottr is a working name pending trademark, domain, and store-name clearance.

See [RELEASE.md](RELEASE.md) for the evidence checklist and
[SECURITY.md](SECURITY.md) for trust boundaries.
