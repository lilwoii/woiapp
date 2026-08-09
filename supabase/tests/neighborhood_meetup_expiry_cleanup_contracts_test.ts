import { assertMatch } from "jsr:@std/assert@1";

const sql = await Deno.readTextFile(
  new URL(
    "../migrations/20260816000000_neighborhood_meetup_expiry_cleanup.sql",
    import.meta.url,
  ),
);

Deno.test("recurring cleanup expires neighborhood cards at their own deadline", () => {
  assertMatch(sql, /from private\.neighborhood_pickup_disclosures disclosure/);
  assertMatch(sql, /disclosure\.expires_at <= now\(\)/);
  assertMatch(
    sql,
    /request\.choice_kind in \('safe_meeting_place', 'seller_residence'\)/,
  );
  assertMatch(sql, /request\.state = 'authorized'/);
  assertMatch(
    sql,
    /request\.state = 'pending'\s+and request\.pickup_ends_at <= now\(\)/,
  );
  assertMatch(sql, /'neighborhood_disclosures_deleted'/);
  assertMatch(
    sql,
    /grant execute on function public\.cleanup_marketplace_chat_ephemera\(\)\s+to service_role/,
  );
});

Deno.test("legacy cleanup behavior and counters remain available", () => {
  assertMatch(sql, /request\.choice_kind is null/);
  assertMatch(sql, /request\.pickup_ends_at \+ interval '12 hours'/);
  assertMatch(sql, /delete from private\.marketplace_pickup_disclosures/);
  assertMatch(sql, /delete from private\.marketplace_chat_idempotency/);
  assertMatch(sql, /'disclosures_deleted'/);
});
