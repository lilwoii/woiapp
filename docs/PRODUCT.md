# Spottr product brief

## Position

Spottr is not another generic restaurant directory. Its wedge is the trusted live-status network for mobile and independent food businesses:

> Know what is open, where it is, what it serves, what it costs, and how you can pay—before you go.

Food trucks remain first in navigation, pins, ranking, and editorial shelves. Restaurants expand usefulness without erasing the differentiator.

## Discovery system

Venue types:

1. Food trucks
2. Restaurants
3. Pop-ups and market vendors
4. Cafés and bakeries
5. Home kitchens, visible only in legally enabled jurisdictions and only after verification

Cuisine, diet, price, payment, distance, and Open now are filters rather than competing venue types.

Core shelves:

- Trucks Near You
- Open Now
- Trending This Week
- Popular Nearby
- New & Noteworthy
- Hidden Gems
- Late Night
- Following Updates

Organic ranking must stay explainable:

- **Nearby:** current/open status, travel time, and location-confirmation freshness.
- **Popular:** Bayesian-adjusted first-party rating plus saves, directions, and verified engagement over 90 days.
- **Trending:** seven-day engagement acceleration versus the listing’s normal baseline, normalized for exposure and protected by fraud controls.
- **Reliable:** accurate hours, recent owner check-ins, and few validated correction reports.
- **Hidden Gems:** strong quality and reliability with lower historical exposure.
- **For You:** explicit cuisine, dietary, payment, distance, and follow preferences.

Paid placement must be clearly labeled and separated from organic ranking.

## Launch sequence

### P0 — defensible city launch

- Guest browsing
- Email/password accounts and unique usernames
- Manually curated trucks and restaurants
- PostGIS nearby search and city/ZIP geocoding
- Recurring truck stops, weekly/special hours, payment methods, and menus
- Follows and in-app inbox
- Short expiring owner updates
- Text reviews
- Manual business claims and moderation
- Report/block controls

Home kitchens and third-party restaurant overlays stay disabled until legal/licensing approval.

### P1 — media and reach

- Moderated review/business photos
- Push notifications
- Licensed Google Places overlay with required attribution
- Owner-authorized menu PDF/photo OCR into a review-before-publish draft
- Sign in with Apple and Google

### P2 — scale

- Licensed bulk inventory where terms permit retention
- Verified-visit signals and richer anti-fraud models
- Multi-region read/cache strategy
- Jurisdiction-by-jurisdiction home-kitchen enablement
- Business analytics, multi-location organizations, and staff audit tooling

## Data integrity rules

- Open now is derived server-side from timezone, weekly/special hours, current stop, and an expiring override.
- Distance is calculated from PostGIS geography; it is never stored as display text.
- Ratings aggregate only visible first-party Spottr reviews.
- Provider ratings, when licensed, stay separately labeled and are never merged into Spottr ratings.
- Owner-entered and verified fields have independent provenance and can override provider display fields without overwriting provider records.
- A menu import is always a draft until the owner approves every item and price.
- Food-truck locations are deliberate public business stops, not continuous owner-device tracking.

## Name diligence

Spottr works as the current internal/preview name, but it has a serious launch-clearance risk: multiple active mobile apps already use Spottr, including a registered U.S. SPOTTR mark covering downloadable location-based social software. Before store submission, obtain trademark counsel review and either secure a defensible food-specific mark or select a clear replacement.
