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
