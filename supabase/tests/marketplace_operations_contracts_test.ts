import { assert, assertMatch } from "jsr:@std/assert@1";

const sql = await Deno.readTextFile(new URL("../migrations/20260807000000_marketplace_operations.sql", import.meta.url));

Deno.test("merchant operations use narrow AAL2 manager projections", () => {
  assertMatch(sql, /create or replace function public\.get_business_marketplace_controls/);
  assertMatch(sql, /create or replace function public\.list_managed_marketplace_pickup_sites/);
  assertMatch(sql, /perform private\.require_aal2\(\)/g);
  assertMatch(sql, /array\['owner', 'manager'\]::public\.member_role\[\]/g);
  assertMatch(sql, /join private\.marketplace_pickup_site_details/);
  assert(!sql.includes("grant select on"));
});

Deno.test("archiving destroys active disclosure before hiding a site", () => {
  assertMatch(sql, /create or replace function public\.archive_marketplace_pickup_site/);
  assertMatch(sql, /for update;/);
  assertMatch(sql, /target_site\.updated_at <> expected_updated_at/);
  const cancel = sql.indexOf("update public.marketplace_pickup_requests request");
  const destroy = sql.indexOf("delete from private.marketplace_pickup_disclosures disclosure");
  const archive = sql.indexOf("update public.marketplace_pickup_sites", destroy);
  assert(cancel > 0 && destroy > cancel && archive > destroy);
  assertMatch(sql, /private\.store_marketplace_chat_idempotency/);
  assertMatch(sql, /active_disclosures_destroyed/);
});

Deno.test("all public operations functions fail closed and grants stay scoped", () => {
  const declarations = sql.match(/create or replace function[\s\S]*?security definer[\s\S]*?as \$\$/g) ?? [];
  assert(declarations.length === 7);
  for (const declaration of declarations) assertMatch(declaration, /set search_path = ''/);
  assertMatch(sql, /revoke all on function public\.get_business_marketplace_controls\(uuid\) from public, anon/);
  assertMatch(sql, /to authenticated/g);
});

Deno.test("chat disable and operator races fail closed", () => {
  assertMatch(sql, /close_pop_up_chat_on_disable/);
  assertMatch(sql, /state = 'closed_by_merchant'/);
  assertMatch(sql, /delete from private\.marketplace_pickup_disclosures/);
  assertMatch(sql, /enforce_pickup_site_state_transition/);
  assertMatch(sql, /old\.state = 'submitted' and new\.state in \('approved', 'rejected'\)/);
  assertMatch(sql, /message_moderation_version integer/);
  assertMatch(sql, /target_message\.moderation_version <> expected_moderation_version/);
  assertMatch(sql, /reported_chat_queue_hour/);
  assertMatch(sql, /marketplace_chat\.report_queue_accessed/);
});
