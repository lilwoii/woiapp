import { assert } from "jsr:@std/assert@1";

const migrationUrl = new URL(
  "../migrations/20260804000000_provider_ingest_rpc.sql",
  import.meta.url,
);
const schemaUrl = new URL("../schema.sql", import.meta.url);

Deno.test("provider ingest RPC is a service-role-only transactional boundary", async () => {
  const source = await Deno.readTextFile(migrationUrl);

  assert(source.includes("create function public.ingest_licensed_provider_batch("));
  assert(source.includes("security definer"));
  assert(source.includes("set search_path = ''"));
  assert(source.includes("set lock_timeout = '5s'"));
  assert(source.includes("set statement_timeout = '30s'"));
  assert(
    source.includes(
      "from public, anon, authenticated;\ngrant execute on function public.ingest_licensed_provider_batch",
    ),
  );
  assert(source.includes("to service_role;"));
  assert(
    !/grant\s+execute\s+on\s+function\s+public\.ingest_licensed_provider_batch[\s\S]{0,200}\bto\s+(anon|authenticated)\b/i
      .test(source),
  );
  assert(!source.includes("execute format("));
});

Deno.test("provider ingest serializes receipts, rate limits, and source ordering", async () => {
  const source = await Deno.readTextFile(migrationUrl);

  assert(source.includes("pg_advisory_xact_lock"));
  assert(source.includes("for update;"));
  assert(source.includes("PROVIDER_IDEMPOTENCY_CONFLICT"));
  assert(source.includes("PROVIDER_RECEIPT_INCOMPLETE"));
  assert(source.includes("provider_rate_limit_buckets.request_count + 1"));
  assert(source.includes("< provider_account.requests_per_minute"));
  assert(source.includes("PROVIDER_RATE_LIMITED"));
  assert(source.includes("record_updated_at < source_updated_at"));
  assert(source.includes("record_updated_at = source_updated_at"));
  assert(source.includes("PROVIDER_SOURCE_TIMESTAMP_CONFLICT"));
  assert(source.includes("private.provider_source_history"));
});

Deno.test("provider snapshot completion is ordered and non-destructive", async () => {
  const source = await Deno.readTextFile(migrationUrl);

  assert(source.includes("PROVIDER_SNAPSHOT_PAGE_REUSED"));
  assert(source.includes("PROVIDER_SNAPSHOT_RECORD_REPEATED"));
  assert(source.includes("snapshot_session.next_page_index <> sync_page_index"));
  assert(source.includes("PROVIDER_SNAPSHOT_SEQUENCE_INVALID"));
  assert(source.includes("private.provider_snapshot_seen"));
  assert(source.includes("final_page_received = true"));
  assert(source.includes("source_status = 'missing'"));
  assert(source.includes("missing_since = coalesce"));
  assert(!source.includes("delete from public.businesses"));
  assert(!source.includes("delete from private.provider_business_sources"));
});

Deno.test("provider materialization keeps owner precedence and drafts private", async () => {
  const source = await Deno.readTextFile(migrationUrl);

  assert(source.includes("private.provider_field_writable"));
  assert(source.includes("member.status = 'active'"));
  assert(source.includes("business_state <> 'draft'"));
  assert(source.includes("business_provenance <> 'licensed_provider'"));
  assert(source.includes("set ownership = 'owner'"));
  assert(source.includes("source_provider_slug = target_provider_slug"));
  assert(source.includes("private.provider_current_field_hash"));
  assert(source.includes("current_field_hash <> field_row.materialized_value_hash"));
  assert(source.includes("'draft'"));
  assert(source.includes("'unverified'"));
  assert(source.includes("'private'"));
  assert(source.includes("is_published"));
  assert(!source.includes("set state = 'published'"));
  assert(!source.includes("set verification = 'verified'"));
  assert(!source.includes("auto_publish then"));
});

Deno.test("provider receipt exposes only the Edge-safe response shape", async () => {
  const source = await Deno.readTextFile(migrationUrl);
  const safeResponseStart = source.indexOf("result_response := jsonb_build_object(");
  const safeResponseEnd = source.indexOf(");", safeResponseStart);
  assert(safeResponseStart >= 0 && safeResponseEnd > safeResponseStart);
  const safeResponse = source.slice(safeResponseStart, safeResponseEnd);

  assert(safeResponse.includes("'status', 'applied'"));
  assert(safeResponse.includes("'batch_id', idempotency_key"));
  assert(safeResponse.includes("'accepted_records', accepted_records"));
  assert(safeResponse.includes("'inactive_records', inactive_records"));
  assert(!safeResponse.includes("request_payload"));
  assert(!safeResponse.includes("request_sha256"));
  assert(!safeResponse.includes("signing_key_id"));
  assert(!safeResponse.includes("source_url"));
});

Deno.test("provider text validation matches the Edge unsafe-code-point boundary", async () => {
  const source = await Deno.readTextFile(migrationUrl);

  assert(source.includes("unsafe_code_point integer"));
  assert(source.includes("8234, 8235, 8236, 8237, 8238"));
  assert(source.includes("8294, 8295, 8296, 8297"));
  assert(!source.includes("value !~ '[[:cntrl:]]'"));
});

Deno.test("provider signing-key constraints use an immutable helper", async () => {
  const source = await Deno.readTextFile(schemaUrl);
  const constraintStart = source.indexOf("constraint provider_accounts_signing_keys_valid");
  const constraintEnd = source.indexOf("\n  )\n);", constraintStart);
  assert(constraintStart >= 0 && constraintEnd > constraintStart);
  const constraint = source.slice(constraintStart, constraintEnd);

  assert(source.includes("create or replace function private.provider_signing_key_ids_valid"));
  assert(constraint.includes("private.provider_signing_key_ids_valid(accepted_signing_key_ids)"));
  assert(!constraint.includes("select"));
  assert(!constraint.includes("unnest"));
});
