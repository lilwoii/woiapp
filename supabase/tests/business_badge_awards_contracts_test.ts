import { assertMatch } from 'https://deno.land/std@0.224.0/assert/mod.ts';

const migration = await Deno.readTextFile(new URL('../migrations/20260914000000_business_badge_awards.sql', import.meta.url));

Deno.test('business and seller awards use verified first-party evidence and revoke', () => {
  assertMatch(migration, /private\.is_business_publicly_eligible/);
  assertMatch(migration, /business\.verification = 'verified'/);
  assertMatch(migration, /'verified_seller'.*business_kind in \('home_kitchen', 'pop_up'\)/);
  assertMatch(migration, /set revoked_at = now\(\)/);
});

Deno.test('business awards refresh from menu, reviews, routes, and business state', () => {
  assertMatch(migration, /menu_items_refresh_business_badges/);
  assertMatch(migration, /reviews_refresh_business_badges/);
  assertMatch(migration, /mobile_stops_refresh_business_badges/);
  assertMatch(migration, /businesses_refresh_business_badges/);
});

Deno.test('badge backfill is bounded and service-only', () => {
  assertMatch(migration, /least\(greatest\(coalesce\(result_limit, 100\), 1\), 500\)/);
  assertMatch(migration, /grant execute on function public\.refresh_business_badges_batch.*service_role/);
});
