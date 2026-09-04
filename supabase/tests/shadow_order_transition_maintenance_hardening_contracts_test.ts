import { assert, assertMatch } from "jsr:@std/assert@1";

const sql = await Deno.readTextFile(
  new URL(
    "../migrations/20260902000000_shadow_order_transition_maintenance_hardening.sql",
    import.meta.url,
  ),
);
const foundationSql = await Deno.readTextFile(
  new URL(
    "../migrations/20260802000000_shadow_ordering_foundation.sql",
    import.meta.url,
  ),
);

function functionBody(signature: string) {
  const start = sql.indexOf(`create or replace function ${signature}`);
  if (start < 0) throw new Error(`missing ${signature}`);
  const end = sql.indexOf("$$;", start);
  if (end < 0) throw new Error(`unterminated ${signature}`);
  return sql.slice(start, end);
}

Deno.test("merchant transitions enforce exact server reason policy", () => {
  const transition = functionBody(
    "public.transition_shadow_order(\n  target_order_public_id uuid,",
  );
  assertMatch(
    transition,
    /next_state in \('accepted', 'preparing', 'ready', 'completed'\) and reason_code is not null/,
  );
  assertMatch(transition, /target_order_public_id is null/);
  assertMatch(transition, /next_state is null/);
  assertMatch(transition, /expected_version is null/);
  assertMatch(
    transition,
    /next_state = 'rejected'[\s\S]*reason_code is distinct from 'merchant_rejected_unavailable'/,
  );
  assertMatch(
    transition,
    /next_state = 'cancelled'[\s\S]*reason_code is distinct from 'merchant_cancelled_unavailable'/,
  );
  assertMatch(transition, /reason_code is null[\s\S]*ORDER_REASON_REQUIRED/);
  assertMatch(transition, /private\.require_aal2\(\)/);
  assertMatch(transition, /private\.consume_rate_limit\(actor, 'transition_shadow_order'/);
  assertMatch(transition, /private\.order_idempotent_response/);
  assertMatch(transition, /private\.is_business_member\(target_order\.business_id, actor\)/);
  assertMatch(transition, /where order_row\.public_id = target_order_public_id[\s\S]*for update/);
  assertMatch(transition, /reserved_count = reserved_count - 1/);
  assertMatch(transition, /accepted_count = accepted_count - 1/);
  assertMatch(transition, /private\.write_audit_event/);
});

Deno.test("acceptance timeout maintenance is bounded, overlap-safe, and service-only", () => {
  const wrapper = functionBody(
    "public.expire_shadow_orders(batch_limit integer default 100)",
  );
  assertMatch(foundationSql, /create or replace function private\.expire_shadow_orders/);
  assertMatch(wrapper, /coalesce\(auth\.role\(\), ''\) <> 'service_role'/);
  assertMatch(wrapper, /SERVICE_ROLE_REQUIRED/);
  assertMatch(wrapper, /bounded_limit not between 1 and 500/);
  assertMatch(wrapper, /pg_catalog\.pg_try_advisory_xact_lock/);
  assertMatch(wrapper, /spottr:shadow-order-expiry/);
  assertMatch(wrapper, /private\.expire_shadow_orders\(bounded_limit\)/);
  assertMatch(
    wrapper,
    /fulfillment_state = 'pending_acceptance'[\s\S]*acceptance_expires_at <= now\(\)/,
  );
  assertMatch(wrapper, /'expired', 0/);
  assertMatch(wrapper, /'more_work', true/);
  assertMatch(wrapper, /'skipped', true/);
  assertMatch(wrapper, /'expired', greatest\(coalesce\(expired_count, 0\), 0\)/);
  assertMatch(
    sql,
    /revoke all on function public\.expire_shadow_orders\(integer\)[\s\S]*from public, anon, authenticated/,
  );
  assertMatch(
    sql,
    /grant execute on function public\.expire_shadow_orders\(integer\)[\s\S]*to service_role/,
  );
});
