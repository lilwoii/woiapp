import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@1';

const migrationUrl = new URL('../migrations/20260802000000_shadow_ordering_foundation.sql', import.meta.url);
const sql = await Deno.readTextFile(migrationUrl);

Deno.test('shadow ordering cannot charge and is staff/AAL2 gated', () => {
  assertMatch(sql, /check \(is_shadow\)/);
  assertMatch(sql, /total_minor integer not null default 0 check \(total_minor = 0\)/);
  assertMatch(sql, /payment_state text not null default 'not_required' check \(payment_state = 'not_required'\)/);
  assertMatch(sql, /not private\.is_platform_staff\(actor\)/);
  assertMatch(sql, /perform private\.require_aal2\(\)/);
  assert(!sql.includes('service_role_key'));
  assert(!sql.includes('stripe_secret'));
});

Deno.test('ordering mutations are RPC-only, idempotent, rate limited, and audited', () => {
  assertMatch(sql, /private\.idempotency_key_hash\(idempotency_key\)/g);
  assertMatch(sql, /private\.order_idempotent_response/g);
  assertMatch(sql, /private\.consume_rate_limit/g);
  assertMatch(sql, /private\.write_audit_event/g);
  assertMatch(sql, /revoke all on public\.business_order_settings[\s\S]*from public, anon, authenticated/);
  assertMatch(sql, /grant select on public\.business_order_settings[\s\S]*to authenticated/);
  assert(!/grant (insert|update|delete|all) on public\.orders/i.test(sql));
});

Deno.test('pickup, catalog, capacity, and fulfillment invariants fail closed', () => {
  for (const invariant of [
    'PUBLISHED_CATALOG_IMMUTABLE', 'ORDERING_NOT_AVAILABLE', 'ORDERABLE_CATALOG_REQUIRED',
    'PICKUP_CAPACITY_UNAVAILABLE', 'MOBILE_STOP_UNAVAILABLE', 'ORDER_ITEM_UNAVAILABLE',
    'ORDER_VERSION_CONFLICT', 'ORDER_TRANSITION_NOT_ALLOWED', 'CAPACITY_RESERVATION_MISSING',
    'ORDER_SNAPSHOT_IMMUTABLE',
  ]) assert(sql.includes(invariant), `missing ${invariant}`);
  assertMatch(sql, /reserved_count \+ accepted_count <= capacity/);
  assertMatch(sql, /unique nulls not distinct \(business_id, location_id, mobile_stop_id/);
  assertMatch(sql, /for update/g);
  assertMatch(sql, /unique \(order_id, event_version\)/);
  assertMatch(sql, /before insert or update or delete on public\.order_item_versions/);
  assertMatch(sql, /before insert or update or delete on public\.order_option_groups/);
  assertMatch(sql, /before insert or update or delete on public\.order_option_versions/);
  assertMatch(sql, /create trigger order_events_append_only before update or delete/);
  assertMatch(sql, /for update skip locked/);
});

Deno.test('order reads use opaque IDs and participant-scoped projections', () => {
  assertMatch(sql, /public_id uuid not null default gen_random_uuid\(\) unique/);
  assertMatch(sql, /private\.order_access_allowed\(o\.id\)/);
  assertMatch(sql, /grant execute on function private\.order_access_allowed\(uuid\) to authenticated/);
  assertMatch(sql, /o\.customer_id = auth\.uid\(\)/);
  assertMatch(sql, /create policy "order participants read orders"/);
  assertMatch(sql, /create or replace function public\.get_business_shadow_order_queue/);
  assertMatch(sql, /perform private\.require_aal2\(\)/);
  assertEquals((sql.match(/security definer/g) ?? []).length >= 6, true);
  const projection = sql.slice(sql.indexOf('create or replace function public.get_my_order'));
  assert(!projection.includes("'customer_id'"));
});
