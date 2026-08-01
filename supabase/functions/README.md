# Spottr Edge Function contracts

All public functions are fail-closed and return `Cache-Control: no-store`. Browser
origins must appear in the comma-separated `SPOTTR_ALLOWED_ORIGINS` environment
variable. Native requests may omit `Origin`.

## Text moderation

Reviews, owner updates, and business responses are always created in `pending`.
The database profanity filter is only an early rejection layer, never an
approval signal. A moderator or administrator at `aal2` reads the public-ID-only
queue through `list_pending_content_moderation` and decides an unchanged row
through `decide_content_moderation`; stale timestamps fail with
`MODERATION_TARGET_CHANGED`. Review approval also requires every linked image
to have completed the clean scanner path. All decisions are rate-limited and
audited.

## Account export

`GET /functions/v1/export-account` requires a valid `aal2` Supabase bearer JWT.
It streams the authenticated member's JSON export directly with an attachment
filename; it never returns a long-lived public download URL. Schema version
`2026-07-30` includes authored reviews/updates/responses and complete
configuration for businesses where the member is an active owner (private
contacts, portable coordinates, schedules, payments, menus, stops, and gallery)
without other users' Auth UUIDs or private moderator attribution.

## Account deletion

`DELETE /functions/v1/delete-account` requires:

- a valid `aal2` bearer JWT;
- an `Idempotency-Key` of 16–128 characters;
- `X-Spottr-Delete-Confirmation: DELETE`; and
- JSON `{ "confirmation": "DELETE" }`.

The function removes owned storage objects, archives a sole-owned business,
anonymizes retained audit attribution, deletes the Auth user, and records a
short-lived idempotency receipt. A failed storage or Auth operation returns a
retryable error without claiming completion.

## Media staging

Media is disabled unless `SPOTTR_MEDIA_UPLOADS_ENABLED=true`.
`POST /functions/v1/media-stage` uses one of two actions:

1. `stage`: `{ action, purpose, businessId?, mimeType, byteSize }` returns a
   one-time signed upload URL under `quarantine/<auth-user-id>/<random-id>`.
2. `register`: `{ action, purpose, businessId?, storagePath }` verifies the
   uploaded object's server metadata and returns an asset in `uploaded/pending`.

Owner/profile purposes require `aal2`; review photos require an active account.
No staged or merely scanned asset is public.

There is no generic Storage `INSERT` policy. Only signed staging tokens can
create objects. A scheduled internal call to `media-cleanup`, authenticated by
`SPOTTR_MEDIA_CLEANUP_SECRET`, removes unregistered objects after one hour,
stalled scans after 24 hours, and rejected media after seven days. Pending or
approved claim evidence is excluded from that sweep.

## Scanner adapter

`media-scan` is an internal-only adapter and is disabled unless all of these are
configured:

- `SPOTTR_MEDIA_PIPELINE_ENABLED=true`
- `SPOTTR_MEDIA_SCAN_SECRET` (32+ random characters)
- `SPOTTR_MEDIA_SCANNER_URL` (HTTPS)
- `SPOTTR_MEDIA_SCANNER_API_KEY` (32+ random characters)

The scanner must malware-scan, moderate unsafe imagery, strip metadata, and
decode/re-encode the file. Its synchronous JSON response is:

```json
{
  "verdict": "clean",
  "malwareClean": true,
  "contentSafe": true,
  "reencoded": true,
  "metadataStripped": true,
  "outputBase64": "...",
  "mimeType": "image/webp",
  "width": 1200,
  "height": 900,
  "sha256": "64 lowercase hex characters"
}
```

A rejection uses `{ "verdict": "rejected", "reasonCode": "SAFE_ENUM_CODE" }`.
Spottr independently checks size, magic bytes, dimensions, and SHA-256 before
writing a deterministic processed path. Because the adapter requires both a
malware-clean and content-safe verdict plus a metadata-stripped re-encode, a
successful internal finalization marks that asset approved. Review text and
owner-authored updates/responses always remain pending for a human moderator;
clean review photos only make the submission eligible for approval, while one
rejected photo rejects the review. Nominated business logos remain private
until approved and publication readiness rechecks them. Production launch must keep uploads
disabled until a real scanner, content-safety provider, moderation appeals
process, retention policy, and deletion drill are configured and verified.
