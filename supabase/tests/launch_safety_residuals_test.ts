import { assert, assertMatch } from "jsr:@std/assert@1";

const root = new URL("../", import.meta.url);

async function text(relativePath: string): Promise<string> {
  return await Deno.readTextFile(new URL(relativePath, root));
}

Deno.test("reported approved reviews have a protected queue and decision contract", async () => {
  const migration = await text(
    "migrations/20260921000000_reported_review_moderation.sql",
  );
  const client = await Deno.readTextFile(
    new URL("../../lib/content-moderation.ts", import.meta.url),
  );

  assert(migration.includes("'reported', true"));
  assert(migration.includes("report.target_type = 'review'"));
  assert(migration.includes("function public.decide_reported_review("));
  assert(migration.includes("perform private.require_aal2()"));
  assert(migration.includes("for update of review"));
  assert(migration.includes("MODERATION_TARGET_CHANGED"));
  assert(migration.includes("set moderation = 'removed'"));
  assertMatch(client, /context\.reported === true/);
  assertMatch(client, /rpc\('decide_reported_review'/);
});

Deno.test("content report upserts use an unambiguous conflict target", async () => {
  const schema = await text("schema.sql");
  const repair = await text(
    "migrations/20260924000000_content_report_conflict_disambiguation.sql",
  );
  const safeTarget =
    "on conflict on constraint content_reports_reporter_id_target_type_target_id_key";

  assert(
    schema.includes(
      "constraint content_reports_reporter_id_target_type_target_id_key\n    unique",
    ),
  );
  assert(schema.includes(safeTarget));
  assert(repair.includes("rename constraint %I to %I"));
  assert(repair.includes("add constraint content_reports_reporter_id_target_type_target_id_key"));
  assert(repair.includes(safeTarget));
  assert(!repair.includes("on conflict (reporter_id, target_type, target_id)"));
});

Deno.test("map viewport predicates never inspect a redacted raw point", async () => {
  const migration = await text(
    "migrations/20260922000000_map_redacted_viewport_privacy.sql",
  );
  const candidateSection = migration.slice(
    migration.indexOf("candidates as materialized"),
    migration.indexOf("redacted as materialized"),
  );
  const visibleSection = migration.slice(
    migration.indexOf("visible as materialized"),
    migration.indexOf("bucketed as"),
  );

  assert(candidateSection.includes("st_intersects(\n            bl.point"));
  assert(migration.includes("redaction_margin constant double precision := 0.026"));
  assert(visibleSection.includes("redacted.safe_point::public.geography"));
  assert(visibleSection.includes("st_y(redacted.safe_point)"));
  assert(visibleSection.includes("st_x(redacted.safe_point)"));
  assert(!visibleSection.includes("bl.point"));
});

Deno.test("account deletion cancels and revalidates queued notification work", async () => {
  const migration = await text(
    "migrations/20260923000000_notification_deletion_lifecycle.sql",
  );

  assert(migration.includes("cancel_notification_deliveries_for_account_deletion"));
  assert(migration.includes("last_provider_code = 'account_deletion'"));
  assert(migration.includes("for key share of followed"));
  assert(migration.includes("'dead', 'expired', 'cancelled'"));
  assertMatch(
    migration,
    /claim_notification_deliveries[\s\S]+private\.is_active_user\(delivery\.user_id\)/,
  );
  assertMatch(
    migration,
    /mark_notification_delivery_batch_sending[\s\S]+private\.is_active_user\(delivery\.user_id\)/,
  );
});

Deno.test("queued notifications stop when a business loses public eligibility", async () => {
  const migration = await text(
    "migrations/20260926000000_notification_business_eligibility_lifecycle.sql",
  );

  assertMatch(
    migration,
    /claim_notification_deliveries[\s\S]+private\.is_business_publicly_eligible\(delivery\.business_id\)/,
  );
  assertMatch(
    migration,
    /mark_notification_delivery_batch_sending[\s\S]+private\.is_business_publicly_eligible\(delivery\.business_id\)/,
  );
  assert(migration.includes("lock_notification_business_eligibility"));
  assert(migration.includes("for share of business"));
  assert(migration.includes("for share of account"));
  assert(migration.includes("for share of source"));
  assert(migration.includes("for share of jurisdiction"));
  assert(migration.includes("for share of permit"));
  assertMatch(
    migration,
    /claim_notification_deliveries[\s\S]+perform private\.lock_notification_business_eligibility\(locked_business_ids\)[\s\S]+return query[\s\S]+delivery\.business_id = any\(locked_business_ids\)/,
  );
  assertMatch(
    migration,
    /mark_notification_delivery_batch_sending[\s\S]+perform private\.lock_notification_business_eligibility\(locked_business_ids\)[\s\S]+update private\.notification_deliveries/,
  );
  assert(migration.includes("affected <> cardinality(target_delivery_ids)"));
});

Deno.test("mobile listing approval cannot strand or bulk-publish submitted stops", async () => {
  const migration = await text(
    "migrations/20260927000000_business_submission_location_review.sql",
  );
  const review = migration.slice(
    migration.indexOf("create or replace function public.review_business_submission"),
    migration.indexOf("revoke all on function public.review_business_submission"),
  );

  assert(review.includes("primary_location_id = any(approved_location_ids)"));
  assert(review.includes("stop.location_id = any(approved_location_ids)"));
  assert(review.includes("stop.id = any(approved_stop_ids)"));
  assert(review.includes("else 'private'::public.location_publication_state"));
  assert(review.includes("stop.state = 'draft'"));
  assert(review.includes("MOBILE_STOP_TIME_OVERLAP"));
  assertMatch(
    migration,
    /set_business_publication[\s\S]+MOBILE_SUBMISSION_SELECTION_REQUIRED/,
  );
  assertMatch(
    migration,
    /set_business_location_publication[\s\S]+and not target_is_primary/,
  );
});

Deno.test("account deletion can apply only its frozen terminal profile transition", async () => {
  const migration = await text(
    "migrations/20260925000000_account_deletion_profile_transition.sql",
  );

  assert(migration.includes("server_fields_changed"));
  assert(migration.includes("new.status = 'deleted'"));
  assert(migration.includes("auth.uid() = old.user_id"));
  assert(migration.includes("new.user_id is not distinct from old.user_id"));
  assert(migration.includes("private.account_deletion_freezes deletion_freeze"));
  assert(migration.includes("request.user_id = deletion_freeze.user_id"));
  assert(
    migration.includes(
      "current_setting('spottr.account_deletion_request_id', true)",
    ),
  );
  assert(migration.includes("deletion_freeze.request_id::text"));
  assert(
    migration.includes(
      "request.state in ('started', 'processing', 'storage_deleted', 'failed')",
    ),
  );
  assert(migration.includes("request.expires_at > now()"));
  assert(migration.includes("if not authorized_deletion_transition then"));
  assert(
    migration.includes("Server-owned profile fields cannot be changed"),
  );
  assert(
    migration.includes(
      "revoke all on function private.protect_profile_server_fields()",
    ),
  );
  assertMatch(
    migration,
    /insert into private\.account_deletion_freezes[\s\S]+set_config\([\s\S]+spottr\.account_deletion_request_id[\s\S]+update public\.profiles[\s\S]+set status = 'deleted'/,
  );
  assertMatch(
    migration,
    /begin\s+perform pg_catalog\.set_config\([\s\S]+spottr\.account_deletion_request_id', '', true/,
  );
  assertMatch(
    migration,
    /exception[\s\S]+when others then[\s\S]+spottr\.account_deletion_request_id', '', true[\s\S]+raise/,
  );
  assert(
    migration.includes(
      "revoke all on function public.begin_account_deletion(uuid, text)",
    ),
  );
});
