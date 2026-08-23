import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

import {
  createMarketplaceScopeGuard,
  resolveMarketplaceScope,
} from "../../lib/marketplace-scope.ts";

const marketplaceStore = await Deno.readTextFile(
  new URL("../../context/marketplace-store.tsx", import.meta.url),
);
const placeScreen = await Deno.readTextFile(
  new URL("../../app/place/[id].tsx", import.meta.url),
);
const marketplaceApi = await Deno.readTextFile(
  new URL("../../lib/marketplace-api.ts", import.meta.url),
);

Deno.test("marketplace request tokens fail closed across sign-out and account switches", () => {
  const guard = createMarketplaceScopeGuard("account:user-a");
  const accountAAccess = guard.begin("account:user-a", "access");
  const accountAPlace = guard.begin("account:user-a", "place:private-business");
  assert(accountAAccess && accountAPlace);

  guard.activate("session:anonymous:no-account");
  assertEquals(guard.isCurrent(accountAAccess), false);
  assertEquals(guard.isCurrent(accountAPlace), false);

  guard.activate("account:user-b");
  const accountBPlace = guard.begin("account:user-b", "place:private-business");
  assert(accountBPlace);
  assertEquals(guard.isCurrent(accountBPlace), true);
});

Deno.test("new directory generations supersede older results without canceling other lanes", () => {
  const guard = createMarketplaceScopeGuard("account:user-a");
  const olderDirectory = guard.begin("account:user-a", "directory");
  const reviews = guard.begin("account:user-a", "reviews:business-a");
  const newerDirectory = guard.begin("account:user-a", "directory");
  assert(olderDirectory && reviews && newerDirectory);

  assertEquals(guard.isCurrent(olderDirectory), false);
  assertEquals(guard.isCurrent(reviews), true);
  assertEquals(guard.isCurrent(newerDirectory), true);
});

Deno.test("marketplace store hides stale state synchronously and clears every sensitive cache", () => {
  assertMatch(marketplaceStore, /storeState\.scopeKey === scopeKey \? storeState : fallbackState/);
  assertMatch(marketplaceStore, /requestGuard\.activate\(scopeKey\)/);
  assertMatch(marketplaceStore, /activeRefresh\.current = null/);
  assertMatch(marketplaceStore, /activePagination\.current = null/);
  assertMatch(marketplaceStore, /managedPlaceIdsRef\.current = \[\]/);
  assertMatch(marketplaceStore, /followedIdsRef\.current = \[\]/);
  assertMatch(marketplaceStore, /pendingPlaceIdsRef\.current\.clear\(\)/);
  assertMatch(marketplaceStore, /lastOrigin\.current = undefined/);
  assertMatch(marketplaceStore, /lastArea\.current = undefined/);
  assertMatch(marketplaceStore, /setStoreState\(createMarketplaceStoreState\(scopeKey\)\)/);
});

Deno.test("all private marketplace result lanes are account-bound before committing", () => {
  for (const lane of [
    "'directory'",
    "'access'",
    "`place:${placeId}`",
    "`reviews:${placeId}`",
    "`follow:${placeId}`",
  ]) {
    assert(
      marketplaceStore.includes(`requestGuard.begin(scopeKey, ${lane})`),
      `Missing account scope token for ${lane}`,
    );
  }
  assertMatch(marketplaceStore, /if \(!requestGuard\.isCurrent\(token\)\) return marketplaceSessionChanged/);
  assertMatch(marketplaceStore, /fetchFollowedIds\(expectedUserId\)/);
  assertMatch(marketplaceStore, /fetchManagedBusinessIds\(expectedUserId\)/);
  assertMatch(marketplaceApi, /data\.user\.id !== expectedUserId/);
  assert(
    marketplaceStore.match(/requestGuard\.begin\(scopeKey, 'directory'\)/g)?.length === 2,
    "Refresh and pagination must share one superseding directory generation",
  );
});

Deno.test("listing details remount their local cache for every account and route scope", () => {
  assert(placeScreen.includes("key={`${scopeKey}:place:${id ?? ''}`}"));
  assertMatch(placeScreen, /mounted\.current = false/);
  assertMatch(placeScreen, /startMarketplaceConversation\(place\.id, expectedUserId\)/);
});

Deno.test("scope resolution never treats a non-authenticated account object as authoritative", () => {
  assertEquals(resolveMarketplaceScope("loading", "user-a"), {
    authenticatedUserId: null,
    key: "session:loading:account-present",
  });
});
