import { assert, assertMatch } from "jsr:@std/assert@1";

const root = new URL("../", import.meta.url);

async function text(relativePath: string): Promise<string> {
  return await Deno.readTextFile(new URL(relativePath, root));
}

Deno.test("quiet-hours RPC validates IANA schedules and preserves per-business alert types", async () => {
  const migration = await text(
    "migrations/20261021000000_notification_quiet_hours_settings.sql",
  );
  assert(migration.includes("public.update_follow_notification_quiet_hours"));
  assertMatch(
    migration,
    /target_timezone is null[\s\S]*target_quiet_hours_start is null[\s\S]*target_quiet_hours_end is null/,
  );
  assertMatch(
    migration,
    /target_timezone is not null[\s\S]*target_quiet_hours_start is not null[\s\S]*target_quiet_hours_end is not null[\s\S]*target_quiet_hours_start <> target_quiet_hours_end/,
  );
  assert(migration.includes("from pg_catalog.pg_timezone_names zone"));
  assert(migration.includes("private.is_business_publicly_eligible(item.business_id)"));
  assert(migration.includes("public.follows followed"));

  const conflictStart = migration.indexOf(
    "on conflict (user_id, business_id) do update set",
  );
  const conflictEnd = migration.indexOf(
    "get diagnostics affected = row_count",
    conflictStart,
  );
  const conflictUpdate = migration.slice(conflictStart, conflictEnd);
  assert(conflictStart >= 0 && conflictEnd > conflictStart);
  assert(conflictUpdate.includes("quiet_hours_start = excluded.quiet_hours_start"));
  assert(conflictUpdate.includes("quiet_hours_end = excluded.quiet_hours_end"));
  assert(conflictUpdate.includes("timezone = excluded.timezone"));
  assert(!conflictUpdate.includes("live_nearby ="));
  assert(!conflictUpdate.includes("location_change ="));
  assert(!conflictUpdate.includes("owner_update ="));
  assert(!conflictUpdate.includes("menu_return ="));
  assert(!conflictUpdate.includes("coalesce(excluded.quiet_hours"));

  assert(!migration.includes("update private.notification_deliveries"));
  assert(!migration.includes("state = 'pending'"));
  assert(!migration.includes("delivery.state = 'leased'"));
  assertMatch(
    migration,
    /revoke all on function public\.update_follow_notification_quiet_hours[\s\S]*grant execute[\s\S]*to authenticated/,
  );
  assert(!migration.includes("update private.notification_runtime_settings"));
  assert(!migration.includes("private.set_notification_consent"));
});

Deno.test("quiet-hours UI is account-scoped, portable, and push stays fail-closed", async () => {
  const saved = await text("../app/(tabs)/saved.tsx");
  const preferences = await text("../lib/notification-preferences.ts");
  const marketplaceApi = await text("../lib/marketplace-api.ts");
  const eas = JSON.parse(await text("../eas.json"));
  const edgeEnv = await text("functions/.env.example");

  assert(saved.includes("Business choices and quiet hours are saved to your account."));
  assert(saved.includes("Delivery on this device is separate."));
  assert(saved.includes("<Text style={styles.inAppBadgeText}>Push off</Text>"));
  assert(saved.includes("QUIET_HOURS_PRESETS.map"));
  assert(saved.includes('accessibilityRole="radiogroup"'));
  assert(saved.includes('accessibilityRole="radio"'));
  assert(saved.includes("aria-checked={selected}"));
  assert(saved.includes("do not request background location or opt you into marketing"));
  assert(!saved.includes("expo-location"));
  assert(!saved.includes("DateTimePicker"));
  assert(preferences.includes("Intl.DateTimeFormat('en-US', { timeZone: value })"));
  assert(preferences.includes("Intl.DateTimeFormat().resolvedOptions().timeZone"));
  assert(preferences.includes("night_22_07"));
  assert(marketplaceApi.includes("update_follow_notification_quiet_hours"));
  assert(
    marketplaceApi.includes(
      "quiet_hours_start, quiet_hours_end, timezone",
    ),
  );
  assert(
    eas.build.production.env.EXPO_PUBLIC_PUSH_NOTIFICATIONS_ENABLED === "false",
  );
  assert(edgeEnv.includes("SPOTTR_PUSH_DEVICE_REGISTRATION_ENABLED=false"));
  assert(edgeEnv.includes("SPOTTR_PUSH_DISPATCH_WORKER_ENABLED=false"));
  assert(edgeEnv.includes("SPOTTR_PUSH_RECEIPT_WORKER_ENABLED=false"));
  assert(edgeEnv.includes("SPOTTR_PUSH_EXPO_PROVIDER_ENABLED=false"));
});

Deno.test("provider handoff still revalidates quiet hours after a schedule change", async () => {
  const lifecycle = await text(
    "migrations/20260926000000_notification_business_eligibility_lifecycle.sql",
  );
  const handoffStart = lifecycle.indexOf(
    "create or replace function private.mark_notification_delivery_batch_sending",
  );
  const grantsStart = lifecycle.indexOf(
    "revoke all on function private.lock_notification_business_eligibility",
    handoffStart,
  );
  const handoff = lifecycle.slice(handoffStart, grantsStart);
  assert(handoffStart >= 0 && grantsStart > handoffStart);
  assert(handoff.includes("delivery.state = 'leased'"));
  assert(handoff.includes("preference.quiet_hours_start is not null"));
  assert(handoff.includes("now() at time zone coalesce(preference.timezone, device.timezone)"));
  assert(handoff.includes("affected <> cardinality(target_delivery_ids)"));
});
