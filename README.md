# Spottr

**Live local food, mapped.**

Spottr is a universal Expo app for iOS, Android, and web. Food trucks lead discovery, while restaurants, pop-ups, cafés, bakeries, and legally enabled home kitchens share one trusted local-food network.

## What is included

- Nearby-first discovery with city, ZIP, business, and cuisine search
- Food-truck-first category ordering and visually distinct map markers
- Nearby, Popular, and Trending ranking views
- Live/open/moving/closed status and location freshness
- Short expiring owner updates with professional-language checks
- Menus with real numeric prices, sold-out state, dietary tags, and photos
- Accepted payment methods shown before a customer travels
- Rich listings with photos, hours, future stops, reviews, owner responses, and location reliability
- Follows, saved places, and granular alert preferences
- Customer and business modes in one account
- Email/password account UX, unique username validation, and in-app deletion controls
- Business add/claim flow with logo validation, role/ownership verification, and legal gating
- Review photo picker and four-photo limit
- Secure Supabase/PostGIS schema with least-privilege row-level security
- EAS build profiles for iOS and Android

The app uses polished seeded data when credentials are absent. That preview mode is intentional: it makes every product flow testable without pretending external provider data or production authentication is connected.

## Run

```bash
npm install
npm run web
```

For native development:

```bash
npm run ios
npm run android
```

Validation:

```bash
npm run typecheck
npm run export:web
```

## Production configuration

Copy `.env.example` to `.env` and set:

- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_ANON_KEY`
- platform-restricted Google Maps SDK keys

Never place a Supabase service-role key, Places web-service key, moderation secret, or push credential in an `EXPO_PUBLIC_*` variable. Those belong only in server-side functions.

Apply `supabase/schema.sql` to a **new** reviewed Supabase project. The replacement schema intentionally provides no anonymous write access and no generic client path for publishing, ownership transfers, permit approval, or moderation decisions.

## Credential-gated work

Real accounts, persistence, claims, follows, reviews, storage, and realtime require a Supabase project. Android/web maps and geocoding require properly restricted map keys. Push notifications require APNs/FCM/VAPID credentials. Store releases require Apple and Google developer accounts and signing.

Restaurant inventory must come from owner submissions or a licensed provider integration. Do not scrape Yelp, DoorDash, Google, or restaurant sites. Imported menus should enter as owner-reviewed drafts with source and freshness metadata.

See [PRODUCT.md](docs/PRODUCT.md) and [SECURITY.md](docs/SECURITY.md) for the launch strategy and production guardrails.
