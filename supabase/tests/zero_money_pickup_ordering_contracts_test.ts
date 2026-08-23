import { assert, assertMatch } from "jsr:@std/assert@1";

const sql = await Deno.readTextFile(
  new URL(
    "../migrations/20260831000000_zero_money_pickup_ordering_vertical_slice.sql",
    import.meta.url,
  ),
);

function functionBody(name: string): string {
  const start = sql.indexOf(`create or replace function ${name}`);
  const end = sql.indexOf("$$;", start);
  assert(start >= 0 && end > start, `missing function ${name}`);
  return sql.slice(start, end);
}

Deno.test("shadow menu and mutations are authenticated employee-only RPCs", () => {
  for (const name of [
    "public.get_shadow_orderable_menu",
    "public.quote_shadow_order",
    "public.place_shadow_order",
    "public.cancel_shadow_order",
  ]) {
    const body = functionBody(name);
    assertMatch(body, /security definer/);
    assertMatch(body, /set search_path = ''/);
    assertMatch(body, /private\.is_active_user\(actor\)/);
    assertMatch(body, /private\.is_platform_staff\(actor\)/);
    assertMatch(body, /private\.require_aal2\(\)/);
    assertMatch(body, /private\.consume_rate_limit\(/);
  }
  assertMatch(sql, /grant execute on function public\.get_shadow_orderable_menu\(uuid\) to authenticated/);
  assertMatch(sql, /grant execute on function public\.quote_shadow_order\(uuid, uuid, timestamptz, timestamptz, jsonb, text\)\s+to authenticated/);
  assertMatch(sql, /grant execute on function public\.place_shadow_order\(uuid, integer, text\) to authenticated/);
  assertMatch(sql, /grant execute on function public\.cancel_shadow_order\(uuid, integer, text, text\) to authenticated/);
  assertMatch(sql, /revoke all on function public\.expire_shadow_order_quotes\(integer\)\s+from public, anon, authenticated/);
  assertMatch(sql, /grant execute on function public\.expire_shadow_order_quotes\(integer\)\s+to service_role/);
  assertMatch(sql, /public_ordering_enabled', false/);
  assertMatch(sql, /payment_enabled', false/);
  assertMatch(functionBody("public.get_shadow_orderable_menu"), /octet_length\(result::text\) > 262144/);
  assertMatch(functionBody("public.get_shadow_orderable_menu"), /ORDER_MENU_TOO_LARGE/);
  assertMatch(functionBody("public.get_shadow_orderable_menu"), /SHADOW_MANUAL_ACCEPTANCE_REQUIRED/);
});

Deno.test("quotes are immutable, expiring, and bound to one order", () => {
  assertMatch(sql, /create table if not exists public\.pickup_order_quotes/);
  assertMatch(sql, /snapshot_hash text not null check \(snapshot_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
  assertMatch(sql, /pickup_order_quotes_zero_money check \(shadow_discount_minor = item_subtotal_minor\)/);
  assertMatch(sql, /payment_state text not null default 'not_required' check \(payment_state = 'not_required'\)/);
  assertMatch(sql, /create or replace function private\.prevent_pickup_order_quote_mutation/);
  assertMatch(sql, /ORDER_QUOTE_IMMUTABLE/);
  assertMatch(sql, /create trigger pickup_order_quote_immutable/);
  assertMatch(sql, /quote_expires_at := least\([\s\S]*interval '5 minutes'/);
  assertMatch(sql, /orders_quote_once_idx/);
  assertMatch(sql, /orders_quote_id_fkey/);
  assertMatch(sql, /expected_quote_version/);
  assertMatch(functionBody("public.place_shadow_order"), /ORDER_QUOTE_VERSION_CONFLICT/);
  assertMatch(sql, /'quote_version', 1/);
  assertMatch(sql, /'base_unit_price_minor'/);
  assertMatch(sql, /'unit_total_minor'/);
  assertMatch(sql, /'acceptance_mode'/);
  assertMatch(sql, /'acceptance_timeout_seconds'/);
  assertMatch(functionBody("public.quote_shadow_order"), /settings\.acceptance_mode <> 'manual'/);
  assertMatch(functionBody("public.place_shadow_order"), /ORDER_QUOTE_POLICY_CHANGED/);
  assertMatch(functionBody("public.place_shadow_order"), /target_quote_acceptance_timeout_seconds/);
  assertMatch(functionBody("public.place_shadow_order"), /'acceptance_mode', target_quote_acceptance_mode/);
});

Deno.test("quote is non-consuming and placement consumes capacity under lock", () => {
  const quote = functionBody("public.quote_shadow_order");
  const menu = functionBody("public.get_shadow_orderable_menu");
  const place = functionBody("public.place_shadow_order");
  assertMatch(quote, /from public\.order_capacity_slots target_capacity[\s\S]*for update/);
  assert(!quote.includes("reserved_count = reserved_count + 1"));
  assertMatch(place, /from public\.pickup_order_quotes quote[\s\S]*for update/);
  assertMatch(place, /from public\.order_capacity_slots target_capacity[\s\S]*for update/);
  assert(place.indexOf("insert into public.orders") < place.indexOf("insert into public.order_items"));
  assertMatch(place, /reserved_count = reserved_count \+ 1/);
  assertMatch(place, /reserved_count \+ accepted_count < capacity\.capacity/);
  assertMatch(place, /target_quote\.mobile_stop_id is not null and not exists/);
  assertMatch(place, /stop\.state in \('scheduled', 'live'\)/);
  assertMatch(place, /MOBILE_STOP_UNAVAILABLE/);
  assertMatch(place, /quote_id, currency/);
  assertMatch(place, /payment_state', 'not_required'/);
  assertMatch(place, /total_minor', 0/);
  assertMatch(place, /ORDER_QUOTE_EXPIRED/);
  assert(!place.includes("set status = 'expired'"));
  assertMatch(quote, /target_option_total > 100000000/);
  assertMatch(menu, /required_group\.minimum_selections > \([\s\S]*available_option/);
  assertMatch(menu, /'maximum_selections', least\(/);
  assertMatch(menu, /option_group\.item_version_id = item\.id[\s\S]*available_option\.orderable/);
});

Deno.test("cancel is owner-bound and releases exactly the matching capacity bucket", () => {
  const cancel = functionBody("public.cancel_shadow_order");
  assertMatch(cancel, /order_row\.customer_id = actor/);
  assertMatch(cancel, /ORDER_OWNERSHIP_REQUIRED|ORDER_NOT_FOUND/);
  assertMatch(cancel, /fulfillment_state <> 'pending_acceptance'/);
  assertMatch(cancel, /ORDER_NOT_CANCELLABLE/);
  assertMatch(cancel, /reason_code is distinct from 'customer_cancelled_before_acceptance'/);
  assertMatch(cancel, /ORDER_QUOTE_REQUIRED/);
  assertMatch(cancel, /target_quote\.snapshot/);
  assertMatch(cancel, /'acceptance_mode', target_acceptance_mode/);
  assertMatch(cancel, /reserved_count = reserved_count - 1/);
  assert(!cancel.includes("accepted_count = accepted_count - 1"));
  assertMatch(cancel, /CAPACITY_RESERVATION_MISSING/);
  assertMatch(cancel, /pickup_starts_at/);
  assertMatch(cancel, /acceptance_expires_at/);
  assertMatch(cancel, /lines', target_lines/);
  assertMatch(cancel, /order_events/);
});

Deno.test("quote RLS is enabled and direct snapshot writes are denied", () => {
  assertMatch(sql, /alter table public\.pickup_order_quotes enable row level security/);
  assertMatch(sql, /create policy "quote owners read own shadow quotes"/);
  assertMatch(sql, /customer_id = auth\.uid\(\)/);
  assertMatch(sql, /revoke all on public\.pickup_order_quotes from public, anon, authenticated/);
  assertMatch(sql, /revoke all on function private\.expire_shadow_order_quotes\(integer\) from public, anon, authenticated/);
  assertMatch(sql, /create or replace function private\.expire_shadow_order_quotes/);
  assertMatch(sql, /for update skip locked/);
  assertMatch(sql, /shadow_order\.quote_expired/);
});

Deno.test("expiry maintenance wrapper is bounded, serialized, and service-only", () => {
  const wrapper = functionBody("public.expire_shadow_order_quotes");
  assertMatch(wrapper, /auth\.role\(\)/);
  assertMatch(wrapper, /SERVICE_ROLE_REQUIRED/);
  assertMatch(wrapper, /bounded_limit not between 1 and 500/);
  assertMatch(wrapper, /pg_try_advisory_xact_lock/);
  assertMatch(wrapper, /private\.expire_shadow_order_quotes\(bounded_limit\)/);
  assertMatch(wrapper, /'expired', 0/);
  assertMatch(wrapper, /'more_work'/);
  assertMatch(wrapper, /'skipped'/);
});

Deno.test("all quote and order money fields remain zero-money shadow values", () => {
  for (const body of [
    functionBody("public.quote_shadow_order"),
    functionBody("public.place_shadow_order"),
    functionBody("public.cancel_shadow_order"),
  ]) {
    assertMatch(body, /payment_state.*not_required/);
    assertMatch(body, /total_minor.*0/);
  }
  assertMatch(sql, /is_shadow boolean not null default true check \(is_shadow\)/);
  assertMatch(sql, /total_minor integer not null default 0 check \(total_minor = 0\)/);
});
