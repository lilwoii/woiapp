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
import { checkProfessionalText } from '@/lib/moderation';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import {
  ActionResult,
  AccountSummary,
  OwnerUpdateInput,
  Place,
  ReviewInput,
  SyncStatus,
  VenueStatus,
} from '@/types/marketplace';

type MarketplaceStoreValue = {
  places: Place[];
  followedIds: string[];
  account: AccountSummary;
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
  ensurePlace: (placeId: string) => Promise<ActionResult>;
  searchArea: (searchText: string) => Promise<ActionResult>;
  loadMoreResults: () => Promise<ActionResult>;
  loadMoreReviews: (placeId: string) => Promise<ActionResult>;
  refresh: (origin?: {
    latitude: number;
    longitude: number;
    radiusMeters?: number;
  }) => Promise<ActionResult>;
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

export function MarketplaceStoreProvider({ children }: PropsWithChildren) {
  const auth = useAuth();
  const [places, setPlaces] = useState<Place[]>([]);
  const [followedIds, setFollowedIds] = useState<string[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(
    isSupabaseConfigured ? 'idle' : 'error'
  );
  const [syncMessage, setSyncMessage] = useState(
    isSupabaseConfigured
      ? 'Choose your location, city, or ZIP to load nearby listings.'
      : 'Live Spottr services are not configured. Listings and account changes are unavailable.'
  );
  const [pendingPlaceIds, setPendingPlaceIds] = useState<string[]>([]);
  const [managedPlaceIds, setManagedPlaceIds] = useState<string[]>([]);
  const [hasMoreResults, setHasMoreResults] = useState(false);
  const [loadingMoreResults, setLoadingMoreResults] = useState(false);
  const activeRefresh = useRef<Promise<ActionResult<MarketplacePage>> | null>(null);
  const nextResultOffset = useRef(0);
  const managedPlaceIdsRef = useRef<string[]>([]);
  const followedIdsRef = useRef<string[]>([]);
  const lastOrigin = useRef<{
    latitude: number;
    longitude: number;
    radiusMeters?: number;
  } | undefined>(undefined);
  const lastArea = useRef<string | undefined>(undefined);

  const refresh = useCallback(async (origin?: {
    latitude: number;
    longitude: number;
    radiusMeters?: number;
  }): Promise<ActionResult> => {
    if (!isSupabaseConfigured) {
      setPlaces([]);
      setSyncStatus('error');
      setSyncMessage(liveServicesRequired.reason);
      setHasMoreResults(false);
      nextResultOffset.current = 0;
      return liveServicesRequired;
    }
    if (origin) {
      lastOrigin.current = origin;
      lastArea.current = undefined;
    }
    if (activeRefresh.current) await activeRefresh.current;

    const includeBusinessIds = [
      ...new Set([...managedPlaceIdsRef.current, ...followedIdsRef.current]),
    ];
    const activeOrigin = origin ?? lastOrigin.current;
    if (!lastArea.current && !activeOrigin && !includeBusinessIds.length) {
      setPlaces([]);
      setHasMoreResults(false);
      nextResultOffset.current = 0;
      setSyncStatus('idle');
      setSyncMessage('Choose your location, city, or ZIP to load nearby listings.');
      return { ok: true };
    }

    setSyncStatus('syncing');
    setSyncMessage('Refreshing live listings…');
    const request = lastArea.current && !origin
      ? searchMarketplacePlaces(lastArea.current, {
          includeBusinessIds,
          managedBusinessIds: managedPlaceIdsRef.current,
        })
      : fetchMarketplacePlaces({
          includeBusinessIds,
          managedBusinessIds: managedPlaceIdsRef.current,
        onlyIncludedBusinesses: !activeOrigin,
        origin: activeOrigin,
        resultLimit: 100,
        resultOffset: 0,
      });
    activeRefresh.current = request;
    const result = await request;
    if (activeRefresh.current === request) activeRefresh.current = null;
    if (!result.ok) {
      setSyncStatus('error');
      setSyncMessage(result.reason);
      return result;
    }

    setPlaces(result.data?.places ?? []);
    setHasMoreResults(result.data?.hasMore ?? false);
    nextResultOffset.current = result.data?.nextOffset ?? 0;
    setSyncStatus('live');
    setSyncMessage('Live owner and community data is connected.');
    return { ok: true };
  }, []);

  const searchArea = useCallback(async (searchText: string): Promise<ActionResult> => {
    if (!isSupabaseConfigured) {
      setPlaces([]);
      setSyncStatus('error');
      setSyncMessage(liveServicesRequired.reason);
      return liveServicesRequired;
    }

    const clean = searchText.replace(/\s+/g, ' ').trim();
    lastArea.current = clean;
    lastOrigin.current = undefined;
    return refresh();
  }, [refresh]);

  const loadMoreResults = useCallback(async (): Promise<ActionResult> => {
    if (!isSupabaseConfigured || loadingMoreResults || !hasMoreResults) {
      return { ok: true };
    }
    const activeOrigin = lastOrigin.current;
    const activeArea = lastArea.current;
    if (!activeOrigin && !activeArea) return { ok: true };

    setLoadingMoreResults(true);
    const includeBusinessIds = [
      ...new Set([...managedPlaceIdsRef.current, ...followedIdsRef.current]),
    ];
    const result = activeArea
      ? await searchMarketplacePlaces(activeArea, {
          includeBusinessIds,
          managedBusinessIds: managedPlaceIdsRef.current,
          resultLimit: 100,
          resultOffset: nextResultOffset.current,
        })
      : await fetchMarketplacePlaces({
          includeBusinessIds,
          managedBusinessIds: managedPlaceIdsRef.current,
          origin: activeOrigin,
          resultLimit: 100,
          resultOffset: nextResultOffset.current,
        });
    setLoadingMoreResults(false);
    if (!result.ok) {
      setSyncStatus('error');
      setSyncMessage(result.reason);
      return result;
    }

    setPlaces((current) => {
      const byId = new Map(current.map((place) => [place.id, place]));
      for (const place of result.data?.places ?? []) byId.set(place.id, place);
      return [...byId.values()];
    });
    setHasMoreResults(result.data?.hasMore ?? false);
    nextResultOffset.current = result.data?.nextOffset ?? nextResultOffset.current;
    return { ok: true };
  }, [hasMoreResults, loadingMoreResults]);

  const refreshAccess = useCallback(async (): Promise<ActionResult> => {
    if (!isSupabaseConfigured) return liveServicesRequired;
    if (auth.status !== 'authenticated') {
      managedPlaceIdsRef.current = [];
      followedIdsRef.current = [];
      setManagedPlaceIds([]);
      setFollowedIds([]);
      return { ok: false, code: 'AUTH_REQUIRED', reason: 'Sign in to continue.' };
    }

    const [followsResult, membershipsResult] = await Promise.all([
      fetchFollowedIds(),
      fetchManagedBusinessIds(),
    ]);
    if (!followsResult.ok) return followsResult;
    if (!membershipsResult.ok) return membershipsResult;

    const followed = followsResult.data ?? [];
    followedIdsRef.current = followed;
    setFollowedIds(followed);
    const ids = membershipsResult.data ?? [];
    managedPlaceIdsRef.current = ids;
    setManagedPlaceIds(ids);
    return refresh();
  }, [auth.status, refresh]);

  const ensurePlace = useCallback(
    async (placeId: string): Promise<ActionResult> => {
      const existingPlace = places.find((place) => place.id === placeId);
      if (existingPlace?.detailsLoaded) {
        return { ok: true };
      }
      if (!isSupabaseConfigured) {
        return liveServicesRequired;
      }

      const result = await fetchMarketplacePlaceById(placeId);
      if (!result.ok) {
        return { ok: false, code: result.code, reason: result.reason };
      }
      if (!result.data) {
        return { ok: false, code: 'NOT_FOUND', reason: 'This listing is unavailable.' };
      }
      setPlaces((current) => [
        result.data as Place,
        ...current.filter((place) => place.id !== placeId),
      ]);
      return { ok: true };
    },
    [places]
  );

  const loadMoreReviews = useCallback(
    async (placeId: string): Promise<ActionResult> => {
      const place = places.find((entry) => entry.id === placeId);
      if (!place || !isSupabaseConfigured || !place.hasMoreReviews) {
        return { ok: true };
      }
      const result = await fetchBusinessReviewsPage(placeId, place.reviews.length);
      if (!result.ok) return result;
      setPlaces((current) =>
        current.map((entry) => {
          if (entry.id !== placeId) return entry;
          const byId = new Map(entry.reviews.map((review) => [review.id, review]));
          for (const review of result.data?.reviews ?? []) byId.set(review.id, review);
          return {
            ...entry,
            reviews: [...byId.values()],
            hasMoreReviews: result.data?.hasMore ?? false,
          };
        })
      );
      return { ok: true };
    },
    [places]
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!isSupabaseConfigured || auth.status !== 'authenticated') {
        if (!isSupabaseConfigured) return;
        setFollowedIds([]);
        managedPlaceIdsRef.current = [];
        setManagedPlaceIds([]);
        return;
      }

      void refreshAccess();
    }, 0);
    return () => clearTimeout(timer);
  }, [auth.account?.id, auth.status, refreshAccess]);

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
      if (pendingPlaceIds.includes(placeId)) {
        return { ok: false, code: 'UNKNOWN', reason: 'This change is already in progress.' };
      }
      const wasFollowing = followedIds.includes(placeId);
      const nextFollowing = !wasFollowing;
      const nextIds = nextFollowing
        ? [...new Set([...followedIds, placeId])]
        : followedIds.filter((id) => id !== placeId);
      setPendingPlaceIds((current) => [...current, placeId]);
      followedIdsRef.current = nextIds;
      setFollowedIds(nextIds);

      const result = await setFollow(placeId, nextFollowing);
      if (!result.ok) {
        const rollbackIds = wasFollowing
          ? [...new Set([...followedIds, placeId])]
          : followedIds.filter((id) => id !== placeId);
        followedIdsRef.current = rollbackIds;
        setFollowedIds(rollbackIds);
      }
      setPendingPlaceIds((current) => current.filter((id) => id !== placeId));
      return result;
    },
    [followedIds, pendingPlaceIds]
  );

  const addReview = useCallback(async (placeId: string, input: ReviewInput): Promise<ActionResult> => {
    const moderation = checkProfessionalText(input.comment, 500);
    if (!moderation.ok) return moderation;

    const place = places.find((entry) => entry.id === placeId);
    if (!place) return { ok: false, reason: 'This place is no longer available.' };

    if (!isSupabaseConfigured) return liveServicesRequired;
    return submitReview(placeId, { ...input, comment: moderation.clean });
  }, [places]);

  const publishUpdate = useCallback(async (input: OwnerUpdateInput): Promise<ActionResult> => {
    const moderation = checkProfessionalText(input.message, 120);
    if (!moderation.ok) return moderation;

    if (!isSupabaseConfigured) return liveServicesRequired;
    return submitOwnerUpdate({ ...input, message: moderation.clean });
  }, []);

  const setVenueStatus = useCallback(async (placeId: string, status: VenueStatus): Promise<ActionResult> => {
    if (!isSupabaseConfigured) return liveServicesRequired;
    return updateVenueStatus(placeId, status);
  }, []);

  const value = useMemo(
    () => ({
      places,
      followedIds,
      account: auth.account ?? guestAccount,
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
      followedIds,
      hasMoreResults,
      ensurePlace,
      managedPlaceIds,
      pendingPlaceIds,
      places,
      publishUpdate,
      refreshAccess,
      refresh,
      loadMoreResults,
      loadMoreReviews,
      loadingMoreResults,
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
