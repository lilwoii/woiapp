import { createContext, PropsWithChildren, useContext, useMemo, useState } from 'react';

import { seedPlaces } from '@/data/places';
import { checkProfessionalText } from '@/lib/moderation';
import {
  AccountRole,
  BusinessUpdate,
  DemoAccount,
  OwnerUpdateInput,
  Place,
  ReviewInput,
  SyncStatus,
  VenueStatus,
} from '@/types/marketplace';

type MarketplaceStoreValue = {
  places: Place[];
  followedIds: string[];
  account: DemoAccount;
  syncStatus: SyncStatus;
  syncMessage: string;
  toggleFollow: (placeId: string) => void;
  addReview: (placeId: string, input: ReviewInput) => { ok: boolean; reason?: string };
  publishUpdate: (input: OwnerUpdateInput) => { ok: boolean; reason?: string };
  setVenueStatus: (placeId: string, status: VenueStatus) => void;
  setRole: (role: AccountRole) => void;
};

const MarketplaceStoreContext = createContext<MarketplaceStoreValue | null>(null);

const demoAccount: DemoAccount = {
  id: 'demo-user',
  username: 'maya.rose',
  displayName: 'Maya Rose',
  email: 'maya@example.com',
  role: 'customer',
};

export function MarketplaceStoreProvider({ children }: PropsWithChildren) {
  const [places, setPlaces] = useState(seedPlaces);
  const [followedIds, setFollowedIds] = useState(['copper-coyote', 'soft-corner-bakes']);
  const [account, setAccount] = useState(demoAccount);
  const [syncStatus] = useState<SyncStatus>('demo');
  const [syncMessage] = useState(
    'Preview data is active. Connect a secured Supabase project to publish real listings and accounts.'
  );

  const toggleFollow = (placeId: string) => {
    setFollowedIds((current) =>
      current.includes(placeId) ? current.filter((id) => id !== placeId) : [...current, placeId]
    );
  };

  const addReview = (placeId: string, input: ReviewInput) => {
    const moderation = checkProfessionalText(input.comment, 500);
    if (!moderation.ok) return moderation;

    const place = places.find((entry) => entry.id === placeId);
    if (!place) return { ok: false, reason: 'This place is no longer available.' };

    setPlaces((current) =>
      current.map((entry) => {
        if (entry.id !== placeId) return entry;

        const nextCount = entry.reviewCount + 1;
        const nextRating = (entry.rating * entry.reviewCount + input.rating) / nextCount;

        return {
          ...entry,
          rating: Number(nextRating.toFixed(2)),
          reviewCount: nextCount,
          reviews: [
            {
              id: `${placeId}-${Date.now()}`,
              username: account.username,
              displayName: account.displayName,
              rating: input.rating,
              comment: moderation.clean,
              createdAt: 'Just now',
              photos: input.photos ?? [],
              helpfulCount: 0,
            },
            ...entry.reviews,
          ],
        };
      })
    );

    return { ok: true };
  };

  const publishUpdate = (input: OwnerUpdateInput) => {
    const moderation = checkProfessionalText(input.message, 120);
    if (!moderation.ok) return moderation;

    const update: BusinessUpdate = {
      id: `${input.placeId}-${Date.now()}`,
      type: input.type,
      message: moderation.clean,
      createdAt: 'Just now',
      expiresAt: 'Expires automatically in 6 hours',
    };

    setPlaces((current) =>
      current.map((place) => (place.id === input.placeId ? { ...place, update } : place))
    );

    return { ok: true };
  };

  const setVenueStatus = (placeId: string, status: VenueStatus) => {
    setPlaces((current) =>
      current.map((place) =>
        place.id === placeId
          ? { ...place, status, lastConfirmedAt: 'Just now', sourceLabel: 'Owner verified' }
          : place
      )
    );
  };

  const setRole = (role: AccountRole) => {
    setAccount((current) => ({ ...current, role }));
  };

  const value = useMemo(
    () => ({
      places,
      followedIds,
      account,
      syncStatus,
      syncMessage,
      toggleFollow,
      addReview,
      publishUpdate,
      setVenueStatus,
      setRole,
    }),
    [account, followedIds, places, syncMessage, syncStatus]
  );

  return <MarketplaceStoreContext.Provider value={value}>{children}</MarketplaceStoreContext.Provider>;
}

export function useMarketplaceStore() {
  const value = useContext(MarketplaceStoreContext);
  if (!value) throw new Error('useMarketplaceStore must be used inside MarketplaceStoreProvider');
  return value;
}

