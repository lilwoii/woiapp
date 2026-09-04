import { assertMatch, assertNotMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20261011000000_followed_feed_keyset_pagination.sql",
    import.meta.url,
  ),
);
const client = await Deno.readTextFile(
  new URL("../../lib/social-feed.ts", import.meta.url),
);
const screen = await Deno.readTextFile(
  new URL("../../app/(tabs)/feed.tsx", import.meta.url),
);
const runtime = await Deno.readTextFile(
  new URL("./full_stack_security_runtime_test.sql", import.meta.url),
);

Deno.test("followed feed RPC is account-bound, validated, bounded, and keyset ordered", () => {
  assertMatch(migration, /actor uuid := auth\.uid\(\)/);
  assertNotMatch(migration, /target_user_id|expected_user_id/);
  assertMatch(migration, /private\.is_active_user\(actor\)/);
  assertMatch(
    migration,
    /feed_filter not in \('all', 'business_post', 'user_review'\)/,
  );
  assertMatch(
    migration,
    /revoke select on public\.public_followed_feed from authenticated/,
  );
  assertMatch(migration, /cursor_feed_type <> feed_filter/);
  assertMatch(
    migration,
    /least\(greatest\(coalesce\(result_limit, 20\), 1\), 20\)/,
  );
  assertMatch(
    migration,
    /\(feed\.created_at, feed\.feed_type, feed\.content_id\)[\s\S]+< \(cursor_created_at, cursor_feed_type, cursor_content_id\)/,
  );
  assertMatch(
    migration,
    /order by feed\.created_at desc, feed\.feed_type desc, feed\.content_id desc[\s\S]+limit bounded_limit \+ 1/,
  );
  assertMatch(migration, /count\(\*\) > bounded_limit from page/);
  assertMatch(
    migration,
    /revoke all on function public\.list_followed_feed\([\s\S]+from public, anon, authenticated, service_role[\s\S]+grant execute[\s\S]+to authenticated/,
  );
});

Deno.test("client and screen advance the server cursor without offset pagination", () => {
  const followedFeedClient =
    client.split("export async function fetchFollowedFeed")[1]
      ?.split("export async function fetchBusinessPosts")[0] ?? "";
  assertMatch(followedFeedClient, /client\.rpc\('list_followed_feed'/);
  assertMatch(
    followedFeedClient,
    /cursor_created_at: cursor\?\.createdAt \?\? null/,
  );
  assertMatch(client, /export function parseFollowedFeedPage/);
  assertMatch(client, /value\.some\(\(item\)/);
  assertMatch(client, /page\.some\(\(row\)/);
  assertMatch(followedFeedClient, /parseFollowedFeedPage\(data\)/);
  assertMatch(client, /throw new Error\('INVALID_FEED_PAGE'\)/);
  assertNotMatch(followedFeedClient, /\.range\(/);
  assertMatch(screen, /nextCursor\?: FeedCursor/);
  assertMatch(screen, /current\.nextCursor/);
  assertNotMatch(screen, /current\.items\.length\)/);
});

Deno.test("cloud runtime proves tied rows are complete, disjoint, filtered, and validated", () => {
  assertMatch(runtime, /\$followed_feed_keyset_pagination\$/);
  assertMatch(runtime, /cardinality\(first_ids\) <> 20/);
  assertMatch(runtime, /first_has_more is distinct from true/);
  assertMatch(runtime, /cardinality\(second_ids\) <> 4/);
  assertMatch(runtime, /second_has_more is distinct from false/);
  assertMatch(runtime, /join unnest\(second_ids\)/);
  assertMatch(runtime, /user_review_count <> 1/);
  assertMatch(runtime, /Partial followed feed cursor bypassed validation/);
});
