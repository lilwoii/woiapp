# Spottr security and trust model

## Core boundaries

- The mobile/web client receives only a Supabase publishable key and platform-restricted map SDK keys.
- Supabase service-role, Places web-service, moderation, email, and push secrets remain server-side.
- Browsing is public. Reviews, follows, claims, and uploads require verified accounts.
- Business changes require membership; ownership transfer, permit changes, publishing, suspension, and moderation require audited server operations.
- Native auth sessions use device secure storage. Web sessions remain memory-only until a secure-cookie backend-for-frontend is configured.

## Database

`supabase/schema.sql` enables RLS on every application table.

- No anonymous insert, update, or delete policies exist.
- Reviews derive `author_id` from the authenticated user and begin in moderation.
- Business updates are membership-bound, limited to 120 characters, moderation-pending, and must expire.
- Raw business locations are member-only. The public location view hides private addresses and coarsens home-kitchen coordinates.
- Business claim evidence, permit numbers, phones, and emails are private.
- State transitions and audit writes have no generic client policies.
- Money uses integer minor units plus ISO currency, not display strings.

## Accounts

- Username uniqueness is case-insensitive in the database.
- Usernames accept 1–24 characters as requested, with server enforcement, normalization at the account endpoint, a reserved-name list, impersonation protection, and professional-language checks.
- Passwords are handled by Supabase Auth, not stored in application tables.
- Production auth should enable verified email, CAPTCHA/rate limiting, breached-password checks, PKCE, short sessions, and MFA/passkeys for owners and administrators.
- Account deletion must be available in-app and revoke sessions/tokens before deleting or anonymizing data under retention rules.

## Media and user-generated content

Uploads enter a private staging bucket under the authenticated user’s path. A server worker must:

1. MIME-sniff and reject mismatches.
2. Enforce byte and pixel limits.
3. Decode and re-encode to JPEG/PNG/WebP.
4. Strip EXIF and GPS metadata.
5. Virus-scan and run image/text safety moderation.
6. Detect spam, duplicates, and high-velocity abuse.
7. Publish only approved derivatives through short signed URLs or a controlled CDN.

Reviews and owner notes use client guidance plus server-side schema/length checks, profanity/harassment/spam filtering, report/block tools, a moderation queue, human escalation, and appeals. Automated filtering reduces abuse but cannot guarantee that every vulgar or harmful submission is caught.

## Location privacy

- Ask only for foreground location and always provide city/ZIP fallback.
- Do not retain consumer search coordinates or background location history.
- Round or redact coordinates in logs and analytics.
- Truck positions are owner-published stops.
- Home kitchens show an approximate service area; never expose a residence marker or address in public APIs or notification payloads.

## Provider and legal controls

- Google Places content must follow display, attribution, caching, and retention terms. Broad scraping or permanent cloning is prohibited.
- Do not copy Yelp reviews/photos or scrape delivery menus.
- Home kitchens remain behind a server-side jurisdiction feature flag. Enable only after local legal review, permit verification, allowed-food checks, renewal tracking, and suspension on expiry.
- Listing-only is the safe first phase. Ordering, payments, delivery, tax, insurance, and marketplace-liability work require separate review.

## Pre-launch checks

- Independent database/RLS review
- Mobile/web penetration test
- Dependency audit and lockfile review
- CSP, security headers, and secure-cookie web auth
- Rate-limit and abuse/load tests
- Restore-tested backups and incident runbooks
- Apple/Google UGC, privacy, account deletion, and sign-in compliance
- Moderation staffing, escalation, and law-enforcement request policy
