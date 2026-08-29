import {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useAuth } from '@/context/auth-context';
import {
  fetchFollowedIds,
  fetchBusinessReviewsPage,
  fetchManagedBusinessIds,
  fetchMarketplacePlaceById,
  fetchMarketplacePlaces,
  MarketplacePage,
  searchMarketplacePlaces,
  setFollow,
  submitOwnerUpdate,
  submitReview,
  updateVenueStatus,
} from '@/lib/marketplace-api';
import {
  createMarketplaceScopeGuard,
  MarketplaceRequestToken,
  resolveMarketplaceScope,
} from '@/lib/marketplace-scope';
import {
  filterHomeKitchenPlaces,
  HOME_KITCHEN_UNAVAILABLE_REASON,
  isHomeKitchenBlocked,
} from '@/lib/features';
import { checkProfessionalText } from '@/lib/moderation';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import {
  ActionResult,
  AccountSummary,
  OwnerUpdateInput,
  Place,
  ReviewInput,
  SponsoredPlace,
  SyncStatus,
  VenueStatus,
} from '@/types/marketplace';

type MarketplaceStoreValue = {
  places: Place[];
  publicPlaces: Place[];
  sponsoredPlace?: SponsoredPlace;
  followedIds: string[];
  account: AccountSummary;
  scopeKey: string;
  syncStatus: SyncStatus;
  syncMessage: string;
  hasMoreResults: boolean;
  loadingMoreResults: boolean;
  pendingPlaceIds: string[];
  managedPlaceIds: string[];
  toggleFollow: (placeId: string) => Promise<ActionResult>;
  addReview: (placeId: string, input: ReviewInput) => Promise<ActionResult>;
  publishUpdate: (input: OwnerUpdateInput) => Promise<ActionResult>;
  setVenueStatus: (placeId: string, status: VenueStatus) => Promise<ActionResult>;
  refreshAccess: () => Promise<ActionResult>;
  ensurePlace: (
    placeId: string,
    preferredLocationId?: string,
    source?: 'detail' | 'discovery'
  ) => Promise<ActionResult>;
  searchArea: (searchText: string) => Promise<ActionResult>;
  loadMoreResults: () => Promise<ActionResult>;
  loadMoreReviews: (placeId: string) => Promise<ActionResult>;
  refresh: (origin?: {
    latitude: number;
    longitude: number;
    radiusMeters?: number;
  }) => Promise<ActionResult>;
};

type MarketplaceStoreState = {
  scopeKey: string;
  places: Place[];
  // A place loaded only to satisfy a deep link is detail-route state, not
  // discovery state. Keep the provenance explicit so it cannot affect public
  // ranking, map/count projections, or pagination.
  detailOnlyPlaceIds: string[];
  sponsoredPlace?: SponsoredPlace;
  followedIds: string[];
  syncStatus: SyncStatus;
  syncMessage: string;
  hasMoreResults: boolean;
  loadingMoreResults: boolean;
  pendingPlaceIds: string[];
  managedPlaceIds: string[];
};

type ActiveRefresh = {
  request: Promise<ActionResult<MarketplacePage>>;
  token: MarketplaceRequestToken;
};

const MarketplaceStoreContext = createContext<MarketplaceStoreValue | null>(null);

const guestAccount: AccountSummary = {
  id: 'guest',
  username: 'guest',
  displayName: 'Spottr guest',
  email: '',
  role: 'customer',
};

const liveServicesRequired: Extract<ActionResult, { ok: false }> = {
  ok: false,
  code: 'CONFIG_REQUIRED',
  reason: 'Live Spottr services are not configured for this build.',
};

const marketplaceSessionChanged: Extract<ActionResult, { ok: false }> = {
  ok: false,
  code: 'AUTH_REQUIRED',
  reason: 'The active account changed. Try again from the current account.',
};

const homeKitchenUnavailable: Extract<ActionResult, { ok: false }> = {
  ok: false,
  code: 'NOT_FOUND',
  reason: HOME_KITCHEN_UNAVAILABLE_REASON,
};

function createMarketplaceStoreState(scopeKey: string): MarketplaceStoreState {
  return {
    scopeKey,
    places: [],
    detailOnlyPlaceIds: [],
    sponsoredPlace: undefined,
    followedIds: [],
    syncStatus: isSupabaseConfigured ? 'idle' : 'error',
    syncMessage: isSupabaseConfigured
      ? 'Choose your location, city, or ZIP to load nearby listings.'
      : 'Live Spottr services are not configured. Listings and account changes are unavailable.',
    hasMoreResults: false,
    loadingMoreResults: false,
    pendingPlaceIds: [],
    managedPlaceIds: [],
  };
}

function sameRequest(left: MarketplaceRequestToken | null, right: MarketplaceRequestToken) {
  return left?.epoch === right.epoch &&
    left.lane === right.lane &&
    left.scopeKey === right.scopeKey &&
    left.sequence === right.sequence;
}

export function MarketplaceStoreProvider({ children }: PropsWithChildren) {
  const auth = useAuth();
  const marketplaceScope = resolveMarketplaceScope(auth.status, auth.account?.id);
  const scopeKey = marketplaceScope.key;
  const expectedUserId = marketplaceScope.authenticatedUserId;
  const [requestGuard] = useState(() => createMarketplaceScopeGuard(scopeKey));
  const [storeState, setStoreState] = useState(() => createMarketplaceStoreState(scopeKey));
  const fallbackState = useMemo(() => createMarketplaceStoreState(scopeKey), [scopeKey]);
  const visibleState = storeState.scopeKey === scopeKey ? storeState : fallbackState;
  const {
    places,
    detailOnlyPlaceIds,
    sponsoredPlace: candidateSponsoredPlace,
    followedIds,
    syncStatus,
    syncMessage,
    hasMoreResults,
    loadingMoreResults,
    pendingPlaceIds,
    managedPlaceIds,
  } = visibleState;
  // Keep account-scoped managed records available to Studio, but expose a
  // separately gated collection for public discovery. Detail routes read the
  // raw places collection so deep-link-only records remain usable.
  const detailOnlyPlaceIdSet = useMemo(
    () => new Set(detailOnlyPlaceIds),
    [detailOnlyPlaceIds]
  );
  const publicPlaces = useMemo(
    () => filterHomeKitchenPlaces(
      places.filter((place) =>
        place.publicationState === 'published' &&
        !detailOnlyPlaceIdSet.has(place.id)
      )
    ),
    [detailOnlyPlaceIdSet, places]
  );
  const [sponsoredExpiryTick, setSponsoredExpiryTick] = useState<number | null>(null);
  useEffect(() => {
    const expiresAt = candidateSponsoredPlace?.sponsoredPlacement.expiresAt;
    const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    const delay = expiresAtMs - Date.now();
    if (!Number.isFinite(delay) || delay <= 0) return;
    // Re-check after a small cushion so early timers or clock adjustments
    // reschedule only while the projection is still in its valid window.
    const timer = setTimeout(
      () => setSponsoredExpiryTick(Date.now()),
      Math.min(delay + 250, 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [candidateSponsoredPlace, sponsoredExpiryTick]);
  const sponsoredPlace = useMemo(
    () => {
      if (!candidateSponsoredPlace) return undefined;
      const expiresAtMs = Date.parse(candidateSponsoredPlace.sponsoredPlacement.expiresAt);
      if (
        !Number.isFinite(expiresAtMs) ||
        (sponsoredExpiryTick !== null && expiresAtMs <= sponsoredExpiryTick) ||
        isHomeKitchenBlocked(candidateSponsoredPlace.category)
      ) return undefined;
      return candidateSponsoredPlace;
    },
    [candidateSponsoredPlace, sponsoredExpiryTick]
  );
  const activeRefresh = useRef<ActiveRefresh | null>(null);
  const activePagination = useRef<MarketplaceRequestToken | null>(null);
  const nextResultOffset = useRef(0);
  const managedPlaceIdsRef = useRef<string[]>([]);
  const followedIdsRef = useRef<string[]>([]);
  const pendingPlaceIdsRef = useRef(new Set<string>());
  // Follow writes are serialized across places.  A per-place pending set still
  // prevents duplicate taps, but it is not enough to safely rebase optimistic
  // updates when two different places finish out of order.
  const activeFollowMutation = useRef<Promise<void> | null>(null);
  const followMutationVersion = useRef(0);
  const lastOrigin = useRef<{
    latitude: number;
    longitude: number;
    radiusMeters?: number;
  } | undefined>(undefined);
  const lastArea = useRef<string | undefined>(undefined);

  const commitStore = useCallback(
    (
      token: MarketplaceRequestToken,
      update: (current: MarketplaceStoreState) => MarketplaceStoreState
    ) => {
      if (!requestGuard.isCurrent(token)) return false;
      setStoreState((current) => {
        if (current.scopeKey !== token.scopeKey || !requestGuard.isCurrent(token)) {
          return current;
        }
        return update(current);
      });
      return true;
    },
    [requestGuard]
  );

  useEffect(() => {
    requestGuard.activate(scopeKey);
    activeRefresh.current = null;
    activePagination.current = null;
    nextResultOffset.current = 0;
    managedPlaceIdsRef.current = [];
    followedIdsRef.current = [];
    pendingPlaceIdsRef.current.clear();
    // Do not make a new account wait on an in-flight mutation from the old
    // account.  The old request remains harmless because its scope token is
    // no longer current, and its local lock cleanup is identity-checked.
    activeFollowMutation.current = null;
    followMutationVersion.current += 1;
    lastOrigin.current = undefined;
    lastArea.current = undefined;

    const timer = setTimeout(() => {
      setStoreState(createMarketplaceStoreState(scopeKey));
    }, 0);
    return () => clearTimeout(timer);
  }, [requestGuard, scopeKey]);

  const refresh = useCallback(
    async (origin?: {
      latitude: number;
      longitude: number;
      radiusMeters?: number;
    }): Promise<ActionResult> => {
      const priorRefresh = activeRefresh.current;
      const token = requestGuard.begin(scopeKey, 'directory');
      if (!token) return marketplaceSessionChanged;

      // Remove the previous paid projection as soon as this refresh becomes
      // current. Do this before waiting for an older request so stale paid
      // content cannot remain visible during the handoff.
      commitStore(token, (current) => ({
        ...current,
        sponsoredPlace: undefined,
      }));

      if (!isSupabaseConfigured) {
        commitStore(token, (current) => ({
          ...current,
          places: [],
          detailOnlyPlaceIds: [],
          sponsoredPlace: undefined,
          syncStatus: 'error',
          syncMessage: liveServicesRequired.reason,
          hasMoreResults: false,
        }));
        nextResultOffset.current = 0;
        return liveServicesRequired;
      }
      if (origin) {
        lastOrigin.current = origin;
        lastArea.current = undefined;
      }
      if (priorRefresh?.token.scopeKey === token.scopeKey) {
        await priorRefresh.request;
      }
      if (!requestGuard.isCurrent(token)) return marketplaceSessionChanged;

      const includeBusinessIds = [
        ...new Set([...managedPlaceIdsRef.current, ...followedIdsRef.current]),
      ];
      const activeOrigin = origin ?? lastOrigin.current;
      if (!lastArea.current && !activeOrigin && !includeBusinessIds.length) {
        nextResultOffset.current = 0;
        commitStore(token, (current) => ({
          ...current,
          places: [],
          detailOnlyPlaceIds: [],
          sponsoredPlace: undefined,
          hasMoreResults: false,
          syncStatus: 'idle',
          syncMessage: 'Choose your location, city, or ZIP to load nearby listings.',
        }));
        return { ok: true };
      }

      commitStore(token, (current) => ({
        ...current,
        sponsoredPlace: undefined,
        syncStatus: 'syncing',
        syncMessage: 'Refreshing live listings…',
      }));
      const request = lastArea.current && !origin
        ? searchMarketplacePlaces(lastArea.current, {
            expectedUserId: expectedUserId ?? undefined,
            includeBusinessIds,
            managedBusinessIds: managedPlaceIdsRef.current,
          })
        : fetchMarketplacePlaces({
            expectedUserId: expectedUserId ?? undefined,
            includeBusinessIds,
            managedBusinessIds: managedPlaceIdsRef.current,
            onlyIncludedBusinesses: !activeOrigin,
            origin: activeOrigin,
            resultLimit: 100,
            resultOffset: 0,
          });
      activeRefresh.current = { request, token };
      const result = await request;
      if (sameRequest(activeRefresh.current?.token ?? null, token)) {
        activeRefresh.current = null;
      }
      if (!requestGuard.isCurrent(token)) return marketplaceSessionChanged;
      if (!result.ok) {
        commitStore(token, (current) => ({
          ...current,
          syncStatus: 'error',
          syncMessage: result.reason,
        }));
        return result;
      }

      nextResultOffset.current = result.data?.nextOffset ?? 0;
      commitStore(token, (current) => ({
        ...current,
        places: result.data?.places ?? [],
        // A successful directory response is authoritative for discovery;
        // reconcile all prior deep-link-only provenance against it.
        detailOnlyPlaceIds: [],
        sponsoredPlace: result.data?.sponsoredPlace,
        hasMoreResults: result.data?.hasMore ?? false,
        syncStatus: 'live',
        syncMessage: 'Live owner and community data is connected.',
      }));
      return { ok: true };
    },
    [commitStore, expectedUserId, requestGuard, scopeKey]
  );

  const searchArea = useCallback(
    async (searchText: string): Promise<ActionResult> => {
      const token = requestGuard.begin(scopeKey, 'search-intent');
      if (!token) return marketplaceSessionChanged;
      if (!isSupabaseConfigured) {
        commitStore(token, (current) => ({
          ...current,
          places: [],
          syncStatus: 'error',
          syncMessage: liveServicesRequired.reason,
          hasMoreResults: false,
        }));
        return liveServicesRequired;
      }

      const clean = searchText.replace(/\s+/g, ' ').trim();
      lastArea.current = clean;
      lastOrigin.current = undefined;
      return refresh();
    },
    [commitStore, refresh, requestGuard, scopeKey]
  );

  const loadMoreResults = useCallback(async (): Promise<ActionResult> => {
    if (
      !isSupabaseConfigured ||
      loadingMoreResults ||
      syncStatus === 'syncing' ||
      !hasMoreResults
    ) {
      return { ok: true };
    }
    const currentPagination = activePagination.current;
    if (currentPagination && requestGuard.isCurrent(currentPagination)) {
      return { ok: true };
    }

    const token = requestGuard.begin(scopeKey, 'directory');
    if (!token) return marketplaceSessionChanged;
    const activeOrigin = lastOrigin.current;
    const activeArea = lastArea.current;
    if (!activeOrigin && !activeArea) return { ok: true };

    activePagination.current = token;
    commitStore(token, (current) => ({ ...current, loadingMoreResults: true }));
    const includeBusinessIds = [
      ...new Set([...managedPlaceIdsRef.current, ...followedIdsRef.current]),
    ];
    const result = activeArea
      ? await searchMarketplacePlaces(activeArea, {
          expectedUserId: expectedUserId ?? undefined,
          includeBusinessIds,
          managedBusinessIds: managedPlaceIdsRef.current,
          resultLimit: 100,
          resultOffset: nextResultOffset.current,
        })
      : await fetchMarketplacePlaces({
          expectedUserId: expectedUserId ?? undefined,
          includeBusinessIds,
          managedBusinessIds: managedPlaceIdsRef.current,
          origin: activeOrigin,
          resultLimit: 100,
          resultOffset: nextResultOffset.current,
        });
    if (sameRequest(activePagination.current, token)) activePagination.current = null;
    if (!requestGuard.isCurrent(token)) return marketplaceSessionChanged;
    if (!result.ok) {
      commitStore(token, (current) => ({
        ...current,
        loadingMoreResults: false,
        syncStatus: 'error',
        syncMessage: result.reason,
      }));
      return result;
    }

    nextResultOffset.current = result.data?.nextOffset ?? nextResultOffset.current;
    commitStore(token, (current) => {
      const byId = new Map(current.places.map((place) => [place.id, place]));
      const returnedPlaceIds = new Set<string>();
      for (const place of result.data?.places ?? []) {
        byId.set(place.id, place);
        returnedPlaceIds.add(place.id);
      }
      return {
        ...current,
        places: [...byId.values()],
        detailOnlyPlaceIds: current.detailOnlyPlaceIds.filter(
          (placeId) => !returnedPlaceIds.has(placeId)
        ),
        hasMoreResults: result.data?.hasMore ?? false,
        loadingMoreResults: false,
      };
    });
    return { ok: true };
  }, [
    commitStore,
    expectedUserId,
    hasMoreResults,
    loadingMoreResults,
    requestGuard,
    scopeKey,
    syncStatus,
  ]);

  const refreshAccess = useCallback(async (): Promise<ActionResult> => {
    const token = requestGuard.begin(scopeKey, 'access');
    if (!token) return marketplaceSessionChanged;
    if (!isSupabaseConfigured) return liveServicesRequired;
    if (!expectedUserId) {
      managedPlaceIdsRef.current = [];
      followedIdsRef.current = [];
      commitStore(token, (current) => ({
        ...current,
        managedPlaceIds: [],
        followedIds: [],
      }));
      return { ok: false, code: 'AUTH_REQUIRED', reason: 'Sign in to continue.' };
    }

    // A read started around an optimistic follow must never overwrite the
    // newer local state with a stale server snapshot.  Waiting before the
    // request handles an already-running write; the version/lock check after
    // the request handles a write that began while the request was in flight.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!requestGuard.isCurrent(token)) return marketplaceSessionChanged;
      const priorFollow = activeFollowMutation.current;
      if (priorFollow) await priorFollow;
      if (!requestGuard.isCurrent(token)) return marketplaceSessionChanged;

      const versionAtRequestStart = followMutationVersion.current;
      const [followsResult, membershipsResult] = await Promise.all([
        fetchFollowedIds(expectedUserId),
        fetchManagedBusinessIds(expectedUserId),
      ]);
      if (!requestGuard.isCurrent(token)) return marketplaceSessionChanged;
      if (!followsResult.ok) return followsResult;
      if (!membershipsResult.ok) return membershipsResult;

      const followStartedDuringRequest = activeFollowMutation.current;
      if (
        followStartedDuringRequest ||
        followMutationVersion.current !== versionAtRequestStart
      ) {
        if (followStartedDuringRequest) await followStartedDuringRequest;
        continue;
      }

      const followed = followsResult.data ?? [];
      const ids = membershipsResult.data ?? [];
      followedIdsRef.current = followed;
      managedPlaceIdsRef.current = ids;
      commitStore(token, (current) => ({
        ...current,
        followedIds: followed,
        managedPlaceIds: ids,
      }));
      return refresh();
    }

    return {
      ok: false,
      code: 'CONFLICT',
      reason: 'Saved places changed while Spottr was refreshing. Try again.',
    };
  }, [commitStore, expectedUserId, refresh, requestGuard, scopeKey]);

  const ensurePlace = useCallback(
    async (
      placeId: string,
      preferredLocationId?: string,
      source: 'detail' | 'discovery' = 'detail'
    ): Promise<ActionResult> => {
      const existingPlace = places.find((place) => place.id === placeId);
      if (isHomeKitchenBlocked(existingPlace?.category)) return homeKitchenUnavailable;
      const existingPlaceReady = Boolean(
        existingPlace?.detailsLoaded &&
        (!preferredLocationId || existingPlace.locationId === preferredLocationId)
      );
      if (existingPlaceReady && source !== 'discovery') return { ok: true };
      if (
        existingPlaceReady &&
        source === 'discovery' &&
        existingPlace?.publicationState === 'published'
      ) {
        const promotionToken = requestGuard.begin(scopeKey, `place:${placeId}`);
        if (!promotionToken) return marketplaceSessionChanged;
        commitStore(promotionToken, (current) => ({
          ...current,
          detailOnlyPlaceIds: current.detailOnlyPlaceIds.filter((id) => id !== placeId),
        }));
        return { ok: true };
      }
      if (!isSupabaseConfigured) return liveServicesRequired;

      const token = requestGuard.begin(scopeKey, `place:${placeId}`);
      if (!token) return marketplaceSessionChanged;
      const result = await fetchMarketplacePlaceById(placeId, expectedUserId ?? undefined, preferredLocationId);
      if (!requestGuard.isCurrent(token)) return marketplaceSessionChanged;
      if (!result.ok) {
        return { ok: false, code: result.code, reason: result.reason };
      }
      if (!result.data) {
        return { ok: false, code: 'NOT_FOUND', reason: 'This listing is unavailable.' };
      }
      const loadedPlace = result.data;
      if (isHomeKitchenBlocked(loadedPlace.category)) return homeKitchenUnavailable;
      commitStore(token, (current) => {
        const wasCurrentDiscoveryPlace = source === 'discovery' || (
          current.places.some((place) => place.id === placeId) &&
          !current.detailOnlyPlaceIds.includes(placeId)
        );
        const detailOnlyPlaceIds = wasCurrentDiscoveryPlace
          ? current.detailOnlyPlaceIds.filter((id) => id !== placeId)
          : [...new Set([...current.detailOnlyPlaceIds, placeId])];
        return {
          ...current,
          places: [loadedPlace, ...current.places.filter((place) => place.id !== placeId)],
          detailOnlyPlaceIds,
        };
      });
      return { ok: true };
    },
    [commitStore, expectedUserId, places, requestGuard, scopeKey]
  );

  const loadMoreReviews = useCallback(
    async (placeId: string): Promise<ActionResult> => {
      const place = places.find((entry) => entry.id === placeId);
      if (!place || !isSupabaseConfigured || !place.hasMoreReviews) return { ok: true };

      const token = requestGuard.begin(scopeKey, `reviews:${placeId}`);
      if (!token) return marketplaceSessionChanged;
      const result = await fetchBusinessReviewsPage(
        placeId,
        place.reviews.length,
        expectedUserId ?? undefined
      );
      if (!requestGuard.isCurrent(token)) return marketplaceSessionChanged;
      if (!result.ok) return result;
      commitStore(token, (current) => ({
        ...current,
        places: current.places.map((entry) => {
          if (entry.id !== placeId) return entry;
          const byId = new Map(entry.reviews.map((review) => [review.id, review]));
          for (const review of result.data?.reviews ?? []) byId.set(review.id, review);
          return {
            ...entry,
            reviews: [...byId.values()],
            hasMoreReviews: result.data?.hasMore ?? false,
          };
        }),
      }));
      return { ok: true };
    },
    [commitStore, expectedUserId, places, requestGuard, scopeKey]
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!isSupabaseConfigured || !expectedUserId) return;
      void refreshAccess();
    }, 0);
    return () => clearTimeout(timer);
  }, [expectedUserId, refreshAccess, scopeKey]);

  useEffect(() => {
    const client = supabase;
    if (!client || !isSupabaseConfigured) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const channel = client
      .channel('spottr-public-directory')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'business_public_events' },
        () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => void refresh(), 750);
        }
      )
      .subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      void client.removeChannel(channel);
    };
  }, [refresh]);

  const toggleFollow = useCallback(
    async (placeId: string): Promise<ActionResult> => {
      if (!isSupabaseConfigured) return liveServicesRequired;
      if (!expectedUserId) {
        return { ok: false, code: 'AUTH_REQUIRED', reason: 'Sign in to save places.' };
      }
      if (pendingPlaceIdsRef.current.has(placeId)) {
        return { ok: false, code: 'UNKNOWN', reason: 'This change is already in progress.' };
      }
      const token = requestGuard.begin(scopeKey, `follow:${placeId}`);
      if (!token) return marketplaceSessionChanged;

      pendingPlaceIdsRef.current.add(placeId);
      commitStore(token, (current) => ({
        ...current,
        pendingPlaceIds: [...new Set([...current.pendingPlaceIds, placeId])],
      }));

      const priorFollow = activeFollowMutation.current;
      let releaseFollow!: () => void;
      const followOperation = new Promise<void>((resolve) => {
        releaseFollow = resolve;
      });
      activeFollowMutation.current = followOperation;

      let result: ActionResult;
      try {
        if (priorFollow) await priorFollow;
        if (!requestGuard.isCurrent(token)) return marketplaceSessionChanged;

        // Capture the base only after the previous write has settled.  This
        // makes rollback/rebase lossless for different places.
        const originalIds = [...followedIdsRef.current];
        const wasFollowing = originalIds.includes(placeId);
        const nextFollowing = !wasFollowing;
        const nextIds = nextFollowing
          ? [...new Set([...originalIds, placeId])]
          : originalIds.filter((id) => id !== placeId);
        followedIdsRef.current = nextIds;
        commitStore(token, (current) => ({
          ...current,
          followedIds: nextIds,
        }));

        try {
          result = await setFollow(placeId, nextFollowing, expectedUserId);
        } catch {
          result = {
            ok: false,
            code: 'UNKNOWN',
            reason: nextFollowing
              ? 'This place could not be followed.'
              : 'This place could not be unfollowed.',
          };
        }
        if (!requestGuard.isCurrent(token)) return marketplaceSessionChanged;
        if (!result.ok) followedIdsRef.current = originalIds;
        followMutationVersion.current += 1;
        commitStore(token, (current) => ({
          ...current,
          followedIds: result.ok ? nextIds : originalIds,
        }));
        return result;
      } finally {
        if (requestGuard.isCurrent(token)) {
          pendingPlaceIdsRef.current.delete(placeId);
          commitStore(token, (current) => ({
            ...current,
            pendingPlaceIds: current.pendingPlaceIds.filter((id) => id !== placeId),
          }));
        }
        releaseFollow();
        if (activeFollowMutation.current === followOperation) {
          activeFollowMutation.current = null;
        }
      }
    },
    [commitStore, expectedUserId, requestGuard, scopeKey]
  );

  const addReview = useCallback(
    async (placeId: string, input: ReviewInput): Promise<ActionResult> => {
      const moderation = checkProfessionalText(input.comment, 500);
      if (!moderation.ok) return moderation;
      if (!places.some((entry) => entry.id === placeId)) {
        return { ok: false, reason: 'This place is no longer available.' };
      }
      if (!isSupabaseConfigured) return liveServicesRequired;
      if (!expectedUserId) {
        return { ok: false, code: 'AUTH_REQUIRED', reason: 'Sign in to review places.' };
      }

      const token = requestGuard.begin(scopeKey, `review-submit:${placeId}`);
      if (!token) return marketplaceSessionChanged;
      const result = await submitReview(
        placeId,
        { ...input, comment: moderation.clean },
        expectedUserId
      );
      return requestGuard.isCurrent(token) ? result : marketplaceSessionChanged;
    },
    [expectedUserId, places, requestGuard, scopeKey]
  );

  const publishUpdate = useCallback(
    async (input: OwnerUpdateInput): Promise<ActionResult> => {
      const moderation = checkProfessionalText(input.message, 120);
      if (!moderation.ok) return moderation;
      if (!isSupabaseConfigured) return liveServicesRequired;
      if (!expectedUserId) {
        return { ok: false, code: 'AUTH_REQUIRED', reason: 'Sign in to publish updates.' };
      }

      const token = requestGuard.begin(scopeKey, `owner-update:${input.placeId}`);
      if (!token) return marketplaceSessionChanged;
      const result = await submitOwnerUpdate(
        { ...input, message: moderation.clean },
        expectedUserId
      );
      return requestGuard.isCurrent(token) ? result : marketplaceSessionChanged;
    },
    [expectedUserId, requestGuard, scopeKey]
  );

  const setVenueStatus = useCallback(
    async (placeId: string, status: VenueStatus): Promise<ActionResult> => {
      if (!isSupabaseConfigured) return liveServicesRequired;
      if (!expectedUserId) {
        return { ok: false, code: 'AUTH_REQUIRED', reason: 'Sign in to change live status.' };
      }

      const token = requestGuard.begin(scopeKey, `venue-status:${placeId}`);
      if (!token) return marketplaceSessionChanged;
      const result = await updateVenueStatus(placeId, status, expectedUserId);
      return requestGuard.isCurrent(token) ? result : marketplaceSessionChanged;
    },
    [expectedUserId, requestGuard, scopeKey]
  );

  const value = useMemo(
    () => ({
      places,
      publicPlaces,
      sponsoredPlace,
      followedIds,
      account:
        expectedUserId && auth.account?.id === expectedUserId
          ? (auth.account ?? guestAccount)
          : guestAccount,
      scopeKey,
      syncStatus,
      syncMessage,
      hasMoreResults,
      loadingMoreResults,
      pendingPlaceIds,
      managedPlaceIds,
      toggleFollow,
      addReview,
      publishUpdate,
      setVenueStatus,
      refreshAccess,
      ensurePlace,
      searchArea,
      loadMoreResults,
      loadMoreReviews,
      refresh,
    }),
    [
      addReview,
      auth.account,
      expectedUserId,
      followedIds,
      hasMoreResults,
      ensurePlace,
      managedPlaceIds,
      pendingPlaceIds,
      publicPlaces,
      places,
      publishUpdate,
      refreshAccess,
      refresh,
      sponsoredPlace,
      loadMoreResults,
      loadMoreReviews,
      loadingMoreResults,
      scopeKey,
      searchArea,
      setVenueStatus,
      syncMessage,
      syncStatus,
      toggleFollow,
    ]
  );

  return <MarketplaceStoreContext.Provider value={value}>{children}</MarketplaceStoreContext.Provider>;
}

export function useMarketplaceStore() {
  const value = useContext(MarketplaceStoreContext);
  if (!value) throw new Error('useMarketplaceStore must be used inside MarketplaceStoreProvider');
  return value;
}
