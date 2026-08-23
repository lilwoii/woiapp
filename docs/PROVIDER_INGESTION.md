# Licensed provider ingestion

Spottr may ingest restaurant and food-truck records only from a provider whose
contract explicitly licenses storage, transformation, display, refresh, and
deletion of every supplied field. This adapter is not a scraper and must not be
pointed at Google Maps, Yelp, DoorDash, Facebook Marketplace, or another source
whose terms do not grant those rights.

The checked-in Edge Function is a strict validator and authenticated mutation
gateway. The schema contains the private provider/source/precedence foundation,
but the final transactional ingestion RPC is intentionally not enabled until
its concurrency and reconciliation suite passes against the target database.
Do not replace the single RPC call with direct service-role writes.

## Request contract

Endpoint: `POST /functions/v1/provider-ingest`

Limits:

- uncompressed UTF-8 JSON only;
- 512 KiB per request;
- 1–100 records per batch;
- 30 locations per business;
- 50 menu sections and 500 total menu items per business;
- seven explicit weekly schedule rows, one per weekday;
- 366 special-hour rows;
- one request per signing key per second on average (60/minute per Edge
  isolate), plus the required database-wide 60/minute limit.

Required headers:

```text
Content-Type: application/json
Idempotency-Key: batch:20260730:000001
X-Spottr-Provider: licensed_vendor
X-Spottr-Key-Id: primary-2026
X-Spottr-Timestamp: 1785441600
X-Spottr-Signature: v1=<64 lowercase hex characters>
```

The timestamp is Unix seconds and has a five-minute acceptance window. The
signature is lowercase HMAC-SHA256 over:

```text
spottr-provider-ingest-v1
POST
<provider>
<key-id>
<timestamp>
<idempotency-key>
<sha256-of-exact-request-bytes>
```

The `Idempotency-Key` must exactly equal `batchId`. A replay with the same key
and hash returns the original safe receipt. Reusing the key with a different
hash must fail with an idempotency conflict. The database transaction, not Edge
memory, is the authority for replay protection.

The secret registry is server-only JSON:

```json
{
  "licensed_vendor": {
    "primary-2026": "<base64url-encoded 32-to-128-byte random secret>",
    "previous-2026": "<overlap key used only during a bounded rotation>"
  }
}
```

Set it in `SPOTTR_PROVIDER_INGEST_KEYS_JSON`, never an Expo/public environment
variable. Keep `SPOTTR_PROVIDER_INGEST_ENABLED=false` until the provider
contract, migration, load test, reconciliation job, key rotation, and incident
runbook are approved. Remove previous keys after the provider has rotated.
Requests with an `Origin` header are rejected because this is not a browser API.

Example payload:

```json
{
  "schemaVersion": "2026-07-30",
  "provider": "licensed_vendor",
  "batchId": "batch:20260730:000001",
  "generatedAt": "2026-07-30T19:59:00.000Z",
  "sync": { "mode": "delta" },
  "records": [
    {
      "externalId": "place/123",
      "status": "active",
      "updatedAt": "2026-07-30T19:58:00.000Z",
      "name": "Cedar & Salt",
      "kind": "restaurant",
      "description": "Seasonal neighborhood cooking.",
      "cuisineLabels": ["Mediterranean"],
      "priceLevel": 2,
      "timezone": "America/Los_Angeles",
      "websiteUrl": "https://example.com/cedar-salt",
      "sourceUrl": "https://provider.example/places/123",
      "payments": ["cash", "visa", "apple_pay"],
      "locations": [
        {
          "externalId": "location/primary",
          "label": "Main dining room",
          "addressLine": "12 Market Street",
          "city": "San Francisco",
          "region": "CA",
          "postalCode": "94105",
          "countryCode": "US",
          "latitude": 37.7936,
          "longitude": -122.3958,
          "isPrimary": true,
          "isApproximate": false,
          "publicAddress": true
        }
      ],
      "weeklyHours": [
        { "weekday": 0, "status": "closed" },
        { "weekday": 1, "status": "open", "opensAt": "09:00", "closesAt": "17:00" },
        { "weekday": 2, "status": "open", "opensAt": "09:00", "closesAt": "17:00" },
        { "weekday": 3, "status": "open", "opensAt": "09:00", "closesAt": "17:00" },
        { "weekday": 4, "status": "open", "opensAt": "09:00", "closesAt": "17:00" },
        { "weekday": 5, "status": "open", "opensAt": "09:00", "closesAt": "17:00" },
        { "weekday": 6, "status": "closed" }
      ],
      "specialHours": [
        {
          "serviceDate": "2026-12-25",
          "status": "closed",
          "note": "Closed for the holiday"
        }
      ],
      "menu": {
        "mode": "replace",
        "sections": [
          {
            "externalId": "section/lunch",
            "name": "Lunch",
            "sortOrder": 0,
            "items": [
              {
                "externalId": "item/bowl",
                "name": "Market bowl",
                "description": "Seasonal vegetables and grains.",
                "priceMinor": 1450,
                "currency": "USD",
                "availability": "available",
                "dietaryTags": ["vegan"],
                "sortOrder": 0
              }
            ]
          }
        ]
      }
    }
  ]
}
```

Overnight windows are represented by a closing time earlier than the opening
time. `open_24_hours` is explicit; equal opening and closing values are
rejected. Weekday `0` is Sunday and `6` is Saturday. Missing menu data means
“do not change provider menu data.” An
included `{ "mode": "replace", "sections": [] }` means the provider
authoritatively reports no menu. Empty batches are rejected.

`home_kitchen` is not accepted through provider ingestion. Home-cooked meal
listings need jurisdiction enablement, permit verification, address privacy,
and a separate legally reviewed workflow.

The payload intentionally has no remote logo or food-photo URL. Provider media
may be added only after its license grants those image rights and the bytes pass
Spottr's quarantine, malware scan, metadata stripping, decode/re-encode, content
safety, moderation, attribution, and deletion pipeline. A URL is never treated
as permission to copy or publish an image.

## Database ingestion boundary

The current `businesses.provenance`, `businesses.provider_freshness_at`, and
`provider_links(provider, provider_place_id, last_fetched_at)` columns identify
a source at business level. They cannot safely provide field ownership,
child-record idempotency, replay protection, paginated snapshot completion, or
owner/provider conflict handling. The reviewed implementation is checked in at
`supabase/migrations/20260804000000_provider_ingest_rpc.sql`; it must be applied
to a disposable production-equivalent PostgreSQL/Supabase environment and pass
the runtime scenarios below before this function is enabled.

1. `private.provider_accounts`

   - `provider_slug` primary key with the same lowercase format as the adapter;
   - `enabled`, `requests_per_minute`, `stale_after`, `archive_after`;
   - a separately approved `auto_publish` policy; otherwise new records remain
     pending until review;
   - license agreement identifier, effective/expiry dates, allowed field
     classes, retention/deletion terms, and a non-secret configuration version;
   - timestamps and staff audit attribution.

2. `private.provider_ingest_receipts`

   - `(provider_slug, idempotency_key_hash)` primary key;
   - exact request SHA-256, batch ID, status, safe response JSON, created and
     completed timestamps;
   - no signature, secret, or raw provider payload. The non-secret `batchId` is
     retained because the protocol intentionally makes it the idempotency key
     and returns it in the safe receipt;
   - a retention job long enough to cover provider retries.

3. `private.provider_rate_limit_buckets`

   - provider/key ID and fixed window as the primary key;
   - an atomic insert/on-conflict increment capped at the configured rate;
   - cleanup index and scheduled retention.

4. Source staging and identity tables

   - a durable batch/snapshot session with provider, snapshot ID, page index,
     final-page state, record counts, request hash, generated time, and status;
   - unique `(provider_slug, provider_external_id)` business identity;
   - unique provider external IDs for locations, menu sections, and menu items;
   - source-updated, first-seen, last-seen, missing-since, inactive-at, source
     URL, license reference, and normalized payload hash on every source row;
   - ISO country code on source locations;
   - immutable source history or an equivalent audit trail sufficient to
     explain every public field.

5. A field-precedence/materialization layer

   - provider fields may populate only a provider-owned listing or fields the
     owner has not overridden;
   - an approved claim or active owner membership always wins, and provider
     refreshes must never overwrite owner profile, locations, hours, payments,
     menu, logo, moderation, publication, or verification choices;
   - two providers must not overwrite each other. Deterministic source priority
     and conflict review are required;
   - normalized source records are materialized into the current public tables
     only after the complete batch validates.

6. `private.ingest_licensed_provider_batch(...)`

   Expose a `public.ingest_licensed_provider_batch(provider_slug text,
   signing_key_id text, idempotency_key text, request_sha256 text,
   request_payload jsonb)` security-definer wrapper with an empty search path.
   Revoke it from `public`, `anon`, and `authenticated`; grant only
   `service_role`. The transaction must:

   - lock or create the idempotency receipt and compare hashes;
   - atomically enforce the database-wide rate limit;
   - re-check provider enablement, license validity, schema version, all
     cardinality limits, and normalized payload size;
   - reject stale/out-of-order source updates;
   - upsert source identities and children by provider external ID;
   - materialize according to field precedence;
   - record counts and a safe receipt;
   - return only `{status, batch_id, accepted_records, inactive_records}`.

   No partial batch may become public. SQL exceptions returned to the Edge
   Function must use stable safe codes and must not include provider data.

7. Stale and inactive lifecycle

   - explicit inactive records deactivate the source identity; they do not
     delete a business;
   - snapshot pages accumulate “seen” identities. Only a valid final page may
     close the snapshot, and repeated/missing pages must fail;
   - identities absent from a completed snapshot become `missing`, not
     immediately inactive;
   - a scheduled job marks them `stale` only after the provider-specific grace
     period;
   - archive a public business only after the longer archive grace period and
     only when it is provider-owned, unclaimed, has no active member, and has no
     other active licensed source;
   - owner-claimed listings keep owner data and merely lose stale
     provider-supplied fields according to the approved retention policy;
   - hard deletion occurs only under the provider license/deletion policy and
     Spottr retention obligations, with an audit receipt.

Add database tests for concurrent same-key replay, same-key/different-hash
conflict, out-of-order updates, partial snapshot failure, empty snapshot
protection, owner-override preservation, multi-provider conflict, stale grace
period, and transaction rollback.

## Deployment and operations

The function needs a Supabase config entry with JWT gateway verification off
because it uses its own per-provider HMAC:

```toml
[functions.provider-ingest]
verify_jwt = false
```

That setting is safe only with application-level HMAC verification enabled and
the function feature flag false by default. Configure:

```text
SPOTTR_PROVIDER_INGEST_ENABLED=false
SPOTTR_PROVIDER_INGEST_KEYS_JSON=<server-only JSON secret registry>
```

Production rollout also requires:

- contract and licensing review for each provider and field;
- provider-side signing test vectors and clock synchronization;
- load, replay, concurrency, rollback, and stale-data drills;
- dashboards for safe status codes and counts only;
- alerts on authentication failures, signature failures, rate limiting,
  reconciliation drift, stale sources, and failed snapshots;
- dead-letter/retry tooling that stores encrypted payloads under an approved
  short retention period;
- daily reconciliation samples against licensed provider output;
- key rotation and provider offboarding drills;
- a kill switch that leaves the public directory on last-known-good data.

Never log or send to telemetry the signature, signing registry, authorization
headers, raw request body, provider URLs containing licensed identifiers,
business contact details, or SQL error text. The implementation returns stable
error codes and intentionally logs none of those values.

## Current limitations

- The private source, snapshot, receipt, rate-limit, history, and field-
  precedence tables and the transactional RPC migration are checked in. CI
  applies the baseline and every migration to its pinned Supabase runtime and
  runs post-chain security contracts. That proves fresh-chain compatibility,
  not provider-ingestion behavior in the target staging or production project.
  Until the approved deployment applies this migration, the Edge Function
  returns `INGESTION_STORE_UNAVAILABLE` and performs no writes.
- Runtime evidence is still required for concurrent same-key calls, full
  rollback, source-order conflicts, paginated snapshot recovery, owner-edit
  hash detection, PostGIS materialization, and query plans at the contractual
  maximum batch size. Static SQL assertions are not a substitute for those
  database tests.
- The checked-in lifecycle worker hides non-active licensed sources, marks old
  missing sources stale, and archives only unclaimed provider-owned listings
  after all source grace periods. Production still requires staged evidence for
  multi-provider grace timing, active-owner and approved-claim preservation,
  advisory-lock contention, bounded backlog draining, audit receipts, and the
  missed-heartbeat alert before provider ingestion may be enabled.
- `supabase/config.toml` delegates gateway authentication to the checked-in HMAC
  contract. The server environment and provider-specific secrets still require
  controlled production configuration after migration approval.
- No provider is configured or licensed, and no provider data ships with this
  scaffold.
- The database bucket is the global authority for committed apply/replay
  transactions. PostgreSQL rolls the bucket increment back with any later SQL
  exception, so production still needs a gateway/distributed limiter if
  rejected signed attempts must count toward a strict global budget. The Edge
  per-isolate limiter remains defense in depth, not that distributed control.
- The existing public model supports one weekly and one special-hours interval
  per day. Providers with split service periods require a separately reviewed
  schedule-model migration rather than lossy merging.
