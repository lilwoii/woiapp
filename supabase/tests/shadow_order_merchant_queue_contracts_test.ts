import { assert, assertMatch } from "jsr:@std/assert@1";

const sql = await Deno.readTextFile(
  new URL(
    "../migrations/20260901000000_shadow_order_merchant_queue.sql",
    import.meta.url,
  ),
);

Deno.test("merchant shadow queue is member, AAL2, rate, and size gated", () => {
  assertMatch(sql, /create or replace function public\.get_business_shadow_order_queue/);
  assertMatch(sql, /security definer set search_path = ''/);
  assertMatch(sql, /private\.is_business_member\(target_business_id, actor\)/);
  assertMatch(sql, /private\.require_aal2\(\)/);
  assertMatch(sql, /private\.consume_rate_limit\(actor, 'get_business_shadow_order_queue'/);
  assertMatch(sql, /limit least\(greatest\(coalesce\(result_limit, 25\), 1\), 25\)/);
  assertMatch(sql, /octet_length\(result::text\) > 524288/);
  assertMatch(sql, /ORDER_QUEUE_TOO_LARGE/);
  assertMatch(
    sql,
    /revoke all on function public\.get_business_shadow_order_queue\(uuid, integer\)[\s\S]*from public, anon, authenticated/,
  );
  assertMatch(
    sql,
    /grant execute on function public\.get_business_shadow_order_queue\(uuid, integer\)[\s\S]*to authenticated/,
  );
});

Deno.test("merchant queue exposes fulfillment snapshots without customer identity", () => {
  for (const field of [
    "'acceptance_expires_at'",
    "'location_id'",
    "'mobile_stop_id'",
    "'location_label'",
    "'address_line'",
    "'city'",
    "'region'",
    "'postal_code'",
    "'time_zone'",
    "'item_subtotal_minor'",
    "'shadow_discount_minor'",
    "'total_minor'",
    "'is_shadow', true",
    "'items'",
    "'allergen_note'",
    "'group_name'",
    "'option_name'",
  ]) assert(sql.includes(field), `missing queue field ${field}`);

  assertMatch(
    sql,
    /fulfillment_state in \('pending_acceptance', 'accepted', 'preparing', 'ready'\)/,
  );
  assert(!sql.includes("'customer_id'"));
  assert(!sql.includes("'email'"));
  assert(!sql.includes("'phone'"));
  assert(!sql.includes("order_contacts"));
  assertMatch(sql, /join public\.business_locations pickup_location/);
  assertMatch(sql, /join public\.businesses business/);
});
