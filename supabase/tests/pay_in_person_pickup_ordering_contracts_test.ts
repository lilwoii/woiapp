import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(new URL(
  "../migrations/20261024000000_pay_in_person_pickup_orders.sql",
  import.meta.url,
));

Deno.test("pickup ordering is private and fail-closed", () => {
  assertMatch(migration, /pickup_ordering_runtime_config[\s\S]*enabled boolean not null default false/);
  assertMatch(migration, /create table private\.pickup_orders/);
  assertMatch(migration, /revoke all privileges on table private\.pickup_ordering_runtime_config,[\s\S]*from public, anon, authenticated, service_role/);
  assert(!/grant select, insert, update on table private\.pickup_orders/.test(migration));
  assertMatch(migration, /payment_method text not null default 'pay_in_person' check \(payment_method = 'pay_in_person'\)/);
  assertMatch(migration, /payment_state text not null default 'due_at_pickup' check \(payment_state = 'due_at_pickup'\)/);
});

Deno.test("customer creation re-prices published inventory and requires exact public pickup", () => {
  assertMatch(migration, /create or replace function public\.create_pay_in_person_pickup_order/);
  assertMatch(migration, /private\.is_business_publicly_eligible\(target_business_id\)/);
  assertMatch(migration, /business\.verification = 'verified'/);
  assertMatch(migration, /preference\.accepted_payment_options = array\['pay_in_person'\]::text\[\]/);
  assertMatch(migration, /location\.publication_state = 'published'[\s\S]*location\.public_address[\s\S]*not location\.is_approximate/);
  assertMatch(migration, /join public\.menu_sections section[\s\S]*item\.availability = 'available'/);
  assertMatch(migration, /target_item\.price_minor::bigint \* target_quantity/);
  assertMatch(migration, /private\.content_is_professional\(target_customer_note\)/);
  assertMatch(migration, /private\.order_idempotent_response\([\s\S]*create_pay_in_person_pickup_order/);
});

Deno.test("pickup transitions are versioned, bounded, and merchant authorized", () => {
  assertMatch(migration, /create or replace function public\.transition_pay_in_person_pickup_order/);
  assertMatch(migration, /perform private\.require_aal2\(\)/);
  assertMatch(migration, /array\['owner', 'manager', 'staff'\]::public\.member_role\[\]/);
  assertMatch(migration, /target\.version <> expected_version/);
  assertMatch(migration, /for update skip locked/);
  assertMatch(migration, /grant execute on function private\.expire_pay_in_person_pickup_orders\(integer\) to service_role/);
});

Deno.test("only authenticated callers receive the public pickup RPCs", () => {
  const revoke = migration.match(/revoke all on function public\.get_pay_in_person_pickup_menu[\s\S]*?from public, anon, authenticated, service_role;/)?.[0];
  const grant = migration.match(/grant execute on function public\.get_pay_in_person_pickup_menu[\s\S]*?to authenticated;/)?.[0];
  assert(revoke);
  assert(grant);
  assertEquals((grant.match(/to authenticated/g) ?? []).length, 1);
});

Deno.test("account portability includes customer orders before Auth anonymization", () => {
  assertMatch(migration, /customer_id uuid references auth\.users\(id\) on delete set null/);
  assertMatch(migration, /rename to account_export_payload_pre_pickup/);
  assertMatch(migration, /'pay_in_person_pickup_orders'[\s\S]*target\.customer_id = target_user_id/);
  assertMatch(migration, /grant execute on function public\.account_export_payload\(uuid\) to service_role/);
});
