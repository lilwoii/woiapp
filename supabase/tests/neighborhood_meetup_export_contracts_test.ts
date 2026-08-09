import { assertMatch } from "jsr:@std/assert@1";

const sql = await Deno.readTextFile(
  new URL(
    "../migrations/20260815000000_neighborhood_meetup_export_retention.sql",
    import.meta.url,
  ),
);

Deno.test("account export contains only the requesting user's meetup consent metadata", () => {
  assertMatch(sql, /where receipt\.user_id = target_user_id/);
  assertMatch(sql, /'marketplace_meetup_consents'/);
  assertMatch(sql, /'conversation_public_id', conversation\.public_id/);
  assertMatch(sql, /'pickup_request_public_id', request\.public_id/);
  assertMatch(
    sql,
    /grant execute on function public\.account_export_payload\(uuid\)\s+to service_role/,
  );
});

Deno.test("storage-deleted checkpoint unlinks retained consent receipts", () => {
  assertMatch(sql, /unlink_meetup_consents_after_account_deletion/);
  assertMatch(sql, /if new\.state = 'storage_deleted'/);
  assertMatch(
    sql,
    /set user_id = null,\s+conversation_id = null,\s+request_id = null/,
  );
});
