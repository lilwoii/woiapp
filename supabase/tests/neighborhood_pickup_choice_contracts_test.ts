import { assert, assertMatch } from "jsr:@std/assert@1";

const sql = await Deno.readTextFile(
  new URL(
    "../migrations/20260809000000_neighborhood_pickup_choice.sql",
    import.meta.url,
  ),
);
const launch = await Deno.readTextFile(
  new URL(
    "../migrations/20260812000000_neighborhood_meetup_launch_contract.sql",
    import.meta.url,
  ),
);
const chat = await Deno.readTextFile(
  new URL("../../app/messages/[id].tsx", import.meta.url),
);
const controls = await Deno.readTextFile(
  new URL("../../app/business-marketplace.tsx", import.meta.url),
);

Deno.test("customers only see seller-selected current public routes", () => {
  assertMatch(sql, /create table if not exists private\.safe_meeting_places/);
  assertMatch(
    sql,
    /create table if not exists private\.business_meeting_routes/,
  );
  assertMatch(sql, /cardinality\(choices\) not between 2 and 3/);
  assertMatch(sql, /public\.st_dwithin\(place\.point, origin, 25000\)/);
  const customerChoices = sql.slice(
    sql.indexOf(
      "create or replace function public.list_neighborhood_pickup_choices",
    ),
    sql.indexOf(
      "create or replace function public.request_neighborhood_pickup_choice",
    ),
  );
  assertMatch(customerChoices, /join private\.business_meeting_routes route/);
  assert(!customerChoices.includes("st_distance"));
});

Deno.test("residence pickup requires bilateral versioned consent and expiring disclosure", () => {
  assertMatch(sql, /seller_terms_version = '2026-08-01'/g);
  assertMatch(sql, /buyer_terms_version = '2026-08-01'/g);
  assertMatch(sql, /perform private\.require_aal2\(\)/g);
  assertMatch(launch, /target_request\.pickup_ends_at \+ interval '2 hours'/);
  assertMatch(sql, /RESIDENCE_PICKUP_CONSENT_REQUIRED/);
  assertMatch(chat, /Residence pickup caution/);
  assertMatch(chat, /Spottr does not process or\s+guarantee the transaction/);
});

Deno.test("clear, block, and residence disable revoke exact disclosures", () => {
  assertMatch(sql, /clear_marketplace_conversation_from_inbox/);
  assertMatch(sql, /marketplace_conversation_visibility/);
  assertMatch(sql, /revoke_pickup_disclosures_on_user_block/);
  assertMatch(sql, /delete from private\.neighborhood_pickup_disclosures/g);
  assertMatch(chat, /Clear from your inbox/);
  assertMatch(chat, /other participant keeps their copy/);
});

Deno.test("payment and seller controls are explicit and non-custodial", () => {
  assertMatch(sql, /'platform_payment_enabled', false/);
  assertMatch(sql, /from public\.business_payments payment/);
  assertMatch(chat, /Pay the seller\s+directly/);
  assertMatch(controls, /Choose 2.*3 places/);
  assertMatch(controls, /seller view\s+only/);
});
