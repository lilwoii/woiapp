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
const conversationScreen = await Deno.readTextFile(
  new URL("../../app/messages/[id].tsx", import.meta.url),
);
const discoverScreen = await Deno.readTextFile(
  new URL("../../app/(tabs)/index.tsx", import.meta.url),
);
const navigationScreen = await Deno.readTextFile(
  new URL("../../app/navigation/[id].tsx", import.meta.url),
);
const marketplaceApi = await Deno.readTextFile(
  new URL("../../lib/marketplace-api.ts", import.meta.url),
);
const marketplaceChat = await Deno.readTextFile(
  new URL("../../lib/marketplace-chat.ts", import.meta.url),
);
const webSupabaseClient = await Deno.readTextFile(
  new URL("../../lib/supabase.ts", import.meta.url),
);
const nativeSupabaseClient = await Deno.readTextFile(
  new URL("../../lib/supabase.native.ts", import.meta.url),
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
  assertMatch(marketplaceStore, /activeFollowMutation\.current = null/);
  assertMatch(marketplaceStore, /lastOrigin\.current = undefined/);
  assertMatch(marketplaceStore, /lastArea\.current = undefined/);
  assertMatch(marketplaceStore, /setStoreState\(createMarketplaceStoreState\(scopeKey\)\)/);
});

Deno.test("public marketplace projection excludes unpublished records while retaining raw store state", () => {
  const projectionStart = marketplaceStore.indexOf("const publicPlaces = useMemo(");
  const projectionEnd = marketplaceStore.indexOf(
    "const [sponsoredExpiryTick",
    projectionStart,
  );
  assert(projectionStart >= 0 && projectionEnd > projectionStart);
  const projection = marketplaceStore.slice(projectionStart, projectionEnd);

  assertMatch(projection, /places\.filter\(\(place\) =>[\s\S]*place\.publicationState === 'published'/);
  assertMatch(projection, /!detailOnlyPlaceIdSet\.has\(place\.id\)/);
  assertMatch(projection, /filterHomeKitchenPlaces/);
  assertMatch(
    marketplaceStore,
    /places:\s*\[loadedPlace, \.\.\.current\.places\.filter\(\(place\) => place\.id !== placeId\)/,
  );
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

Deno.test("follow writes serialize and access refresh retries around optimistic changes", () => {
  assertMatch(marketplaceStore, /activeFollowMutation = useRef<Promise<void> \| null>\(null\)/);
  assertMatch(marketplaceStore, /const priorFollow = activeFollowMutation\.current/);
  assertMatch(marketplaceStore, /if \(priorFollow\) await priorFollow/);
  assertMatch(marketplaceStore, /const originalIds = \[\.\.\.followedIdsRef\.current\]/);
  assertMatch(marketplaceStore, /followMutationVersion\.current !== versionAtRequestStart/);
  assertMatch(marketplaceStore, /Saved places changed while Spottr was refreshing/);
});

Deno.test("listing details remount their local cache for every account and route scope", () => {
  assert(
    placeScreen.includes(
      "key={`${scopeKey}:place:${id ?? ''}:${locationId ?? ''}:${locationParamInvalid}`}",
    ),
  );
  assertMatch(placeScreen, /mounted\.current = false/);
  assertMatch(
    placeScreen,
    /startMarketplaceConversation\(place\.id, expectedUserId, place\.category\)/,
  );
});

Deno.test("private conversations reject delayed account A results after a scope change", () => {
  assertMatch(
    conversationScreen,
    /key=\{`\$\{scopeKey\}:conversation:\$\{id \?\? ""\}`\}/,
  );
  assertMatch(conversationScreen, /mounted\.current = false/);
  assertMatch(
    conversationScreen,
    /refreshGeneration\.current !== generation/,
  );
  assertMatch(
    conversationScreen,
    /sendMarketplaceMessage\([\s\S]*?expectedUserId/,
  );
  assertMatch(
    conversationScreen,
    /markMarketplaceConversationRead\(id, latest, expectedUserId\)/,
  );
});

Deno.test("discovery and live navigation remount precise location by account scope", () => {
  assertMatch(discoverScreen, /key=\{`discover:\$\{scopeKey\}`\}/);
  assertMatch(
    discoverScreen,
    /mounted\.current &&\s+focusedRef\.current &&\s+appForegroundRef\.current &&\s+locationRequestGeneration\.current === generation/,
  );
  assertMatch(
    navigationScreen,
    /key=\{`\$\{scopeKey\}:navigation:\$\{placeId \?\? ''\}:\$\{locationId \?\? ''\}:\$\{locationParamInvalid\}`\}/,
  );
  assertMatch(navigationScreen, /watcher\.current\?\.remove\(\)/);
  assertMatch(navigationScreen, /navigationOperationGeneration\.current \+= 1/);
  assertMatch(navigationScreen, /routeRequestSequence\.current \+= 1/);
});

Deno.test("marketplace writes use a verified non-persisting account-bound token", () => {
  for (const clientSource of [webSupabaseClient, nativeSupabaseClient]) {
    assertMatch(clientSource, /createAccountBoundSupabaseClient/);
    assertMatch(clientSource, /persistSession: false/);
    assertMatch(clientSource, /autoRefreshToken: false/);
    assertMatch(clientSource, /accessToken: async \(\) => accessToken/);
    assertMatch(clientSource, /userData\.user\?\.id !== expectedUserId/);
  }
  assertMatch(marketplaceApi, /marketplaceMutationClient\(expectedUserId\)/);
  assertMatch(marketplaceChat, /marketplaceMutationClient\(expectedUserId\)/);
  assertMatch(marketplaceApi, /if \(!expectedUserId\) return null/);
  assertMatch(marketplaceChat, /if \(!expectedUserId\) return null/);
});

Deno.test("scope resolution never treats a non-authenticated account object as authoritative", () => {
  assertEquals(resolveMarketplaceScope("loading", "user-a"), {
    authenticatedUserId: null,
    key: "session:loading:account-present",
  });
});
