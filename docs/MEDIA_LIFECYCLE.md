# Media lifecycle and account-deletion boundary

Migration `20260810000000_media_lifecycle_serialization.sql` and the matching
Edge functions form one release unit. Do not deploy the migration while old
`media-stage`, `media-scan`, `media-cleanup`, or `delete-account` code is live.
Keep `SPOTTR_MEDIA_UPLOADS_ENABLED=false` and
`SPOTTR_MEDIA_PIPELINE_ENABLED=false` during the rollout. Before applying the
migration, stop old workers and wait the full legacy signed-upload TTL plus the
15-minute scanner grace (or rotate/invalidate the signing capability) so no
untracked pre-migration URL can write after a deletion snapshot. Then deploy the
migration and all matching functions, refresh the PostgREST schema cache, run
the production concurrency drills, and only then consider enabling media.

## Upload grants

- `media-stage` persists the exact owner, path, purpose, MIME type, size, and
  expiry before minting a signed upload capability.
- Registration and account deletion serialize on the same owner advisory lock.
  Registration and unregistered-object cleanup also serialize on a path lock.
- A successfully minted capability remains a deletion blocker until its expiry,
  including after registration. A failed mint is explicitly cancelled.
- The database registration trigger consumes the matching grant after inserting
  the media row; a mismatch or deletion freeze rolls back registration.

## Scanning and cleanup

- A scanner must claim an asset and receives a five-minute attempt token.
- Clean output uses an attempt-specific immutable path. The path is reserved
  before upload, storage upload uses `upsert: false`, and finalization compares
  the attempt token and lease.
- Expired or abandoned output paths are recorded for cleanup. Generic cleanup
  persists each path before deleting Storage and only finalizes database rows
  after receiving the complete batch receipt. A crash between those operations
  therefore retries instead of stranding a media row.
- Chat attachment cleanup keeps its stricter asset/message locking and runs
  before the generic durable sweep.

## Account deletion

- `begin_account_deletion` takes the owner lifecycle lock, creates or reuses the
  durable request, freezes new mutations, and marks the public profile deleted.
- The worker returns `202 processing` while any minted upload capability or live
  scan lease can still write. It does not claim completion or sign the user out.
- Storage paths are snapshotted into request-scoped items, deleted idempotently,
  and checkpointed in batches. Database preparation and Auth deletion are
  blocked until the storage seal is complete.
- Failed requests remain frozen and retryable. Incomplete deletion intents are
  not purged merely because a worker lease or request deadline elapsed.
- Schedule `delete-account-worker` with the dedicated internal secret at least
  every five minutes. This service-only worker claims frozen requests and
  continues them without a user session; client retries are an acceleration, not
  the sole deletion mechanism.

## Required production evidence

Regex contract tests and TypeScript checks are regression guards, not production
proof. Before enabling media or account deletion, execute the full migration
chain against the target Supabase/PostgreSQL version and exercise:

- register versus deletion-freeze races;
- register versus unregistered cleanup races;
- duplicate and expired scanner workers, including a crash after output upload;
- cleanup crashes after Storage deletion and before database finalization;
- account deletion with outstanding signed grants, scans, more than 500 paths,
  Storage failures, Auth failures, and stale worker reclaim;
- bucket object reconciliation for historical untracked published paths;
- monitoring, alerting, retention, legal hold, restore, and key-rotation drills.

Media must remain disabled if the external scanner does not provide malware
scanning, content-safety classification, metadata stripping, deterministic
decode/re-encode, and production OCR/QR sensitive-data detection. No control in
this document is a claim that the system is perfectly secure.
