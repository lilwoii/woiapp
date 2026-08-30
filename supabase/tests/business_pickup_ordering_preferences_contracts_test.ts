import { assert, assertMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20261019000000_business_pickup_ordering_preferences.sql",
    import.meta.url,
  ),
);
const api = await Deno.readTextFile(
  new URL("../../lib/business-pickup-ordering.ts", import.meta.url),
);
const studio = await Deno.readTextFile(
  new URL(
    "../../components/business-pickup-ordering-settings.tsx",
    import.meta.url,
  ),
);

Deno.test("pickup opt-in is owner/manager, AAL2, category, and publication bound", () => {
  assertMatch(migration, /perform private\.require_aal2\(\)/);
  assertMatch(
    migration,
    /array\['owner', 'manager'\]::public\.member_role\[\]/,
  );
  assertMatch(
    migration,
    /target_kind not in \('restaurant', 'food_truck'\)/,
  );
  assertMatch(
    migration,
    /target_state <> 'published' or target_verification <> 'verified'/,
  );
  assertMatch(
    migration,
    /from public\.businesses business[\s\S]+for update;[\s\S]+if not private\.is_business_member/,
  );
  assertMatch(
    migration,
    /private\.consume_rate_limit\([\s\S]+business_pickup_ordering_preferences/,
  );
});

Deno.test("the launch payment selection is database- and RPC-fail-closed", () => {
  assertMatch(
    migration,
    /not opted_in and accepted_payment_options = '\{\}'::text\[\]/,
  );
  assertMatch(
    migration,
    /opted_in and accepted_payment_options = array\['pay_in_person'\]::text\[\]/,
  );
  assertMatch(
    migration,
    /accepted_payment_options && array\['card', 'apple_pay'\]::text\[\][\s\S]+ONLINE_PAYMENT_PROCESSING_UNAVAILABLE/,
  );
  assertMatch(migration, /'customer_ordering_enabled', false/);
  assertMatch(migration, /'online_payment_processing_enabled', false/);
  assertMatch(migration, /'charge_enabled', false/g);
  assertMatch(api, /if \(chargeEnabled\)[\s\S]+not launch-enabled/);
  assertMatch(
    api,
    /customer_ordering_enabled'[\s\S]+online_payment_processing_enabled'/,
  );
});

Deno.test("pickup preferences use RLS for reads and RPC-only writes", () => {
  assertMatch(
    migration,
    /alter table public\.business_pickup_ordering_preferences enable row level security/,
  );
  assertMatch(
    migration,
    /revoke all privileges on table public\.business_pickup_ordering_preferences[\s\S]+grant select on table public\.business_pickup_ordering_preferences to authenticated/,
  );
  assertMatch(
    migration,
    /create policy "owners and managers read pickup preferences"[\s\S]+private\.has_aal2\(\)/,
  );
  assertMatch(
    migration,
    /revoke all on function public\.set_business_pickup_ordering_preferences\([\s\S]+grant execute on function public\.set_business_pickup_ordering_preferences\([\s\S]+to authenticated/,
  );
  assertMatch(migration, /private\.write_audit_event\(/);
  assertMatch(api, /createAccountBoundSupabaseClient\(expectedUserId\)/);
});

Deno.test("Studio discloses every launch option without implying payment availability", () => {
  for (const label of ["Pay in person", "Card in Spottr", "Apple Pay in Spottr"]) {
    assert(migration.includes(`'label', '${label}'`));
  }
  assertMatch(
    studio,
    /Saving an opt-in does not activate customer checkout/,
  );
  assertMatch(studio, /this screen cannot enable payment processing/);
  assertMatch(studio, /Spottr creates no charge/);
  assertMatch(studio, /UNAVAILABLE/);
  assertMatch(studio, /key=\{`\$\{businessId\}:\$\{expectedUserId\}`\}/);
  assertMatch(studio, /if \(!mounted\.current\) return;/);
  assertMatch(studio, /if \(!preferences\) return 'UNAVAILABLE';/);
  assertMatch(
    studio,
    /const preferenceControlDisabled =[\s\S]+!preferences[\s\S]+!preferences\.eligibleKind/,
  );
  assertMatch(studio, /disabled=\{preferenceControlDisabled\}/);
  assertMatch(
    studio,
    /state === 'published' && verification === 'verified'/,
  );
});
