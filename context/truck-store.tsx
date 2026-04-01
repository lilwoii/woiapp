import { createContext, PropsWithChildren, useContext, useEffect, useMemo, useState } from 'react';

import { seedTrucks } from '@/data/seed';
import { fetchRemoteTrucks, insertRemoteReview, upsertRemoteTruck } from '@/lib/truck-repository';
import { isSupabaseConfigured } from '@/lib/supabase';
import { OwnerPostInput, ReviewInput, SyncStatus, Truck } from '@/types/truck';

type TruckStoreValue = {
  trucks: Truck[];
  syncStatus: SyncStatus;
  syncMessage: string;
  addReview: (truckId: string, input: ReviewInput) => void;
  postOwnerUpdate: (input: OwnerPostInput) => Truck;
  refreshFromRemote: () => Promise<void>;
};

const TruckStoreContext = createContext<TruckStoreValue | null>(null);

const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

const parseMenuLines = (menuLines: string) =>
  menuLines
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [namePart, pricePart] = line.split('-').map((part) => part.trim());
      return {
        id: `${slugify(namePart || `item-${index}`)}-${index}`,
        name: namePart || `Menu item ${index + 1}`,
        price: pricePart || '$0',
      };
    });

export const averageRating = (truck: Truck) => {
  if (!truck.reviews.length) return 0;
  const total = truck.reviews.reduce((sum, review) => sum + review.rating, 0);
  return total / truck.reviews.length;
};

export function TruckStoreProvider({ children }: PropsWithChildren) {
  const [trucks, setTrucks] = useState(seedTrucks);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(isSupabaseConfigured ? 'syncing' : 'demo');
  const [syncMessage, setSyncMessage] = useState(
    isSupabaseConfigured
      ? 'Connecting to Supabase for live truck data.'
      : 'Running in demo mode until Supabase keys are added.'
  );

  const refreshFromRemote = async () => {
    if (!isSupabaseConfigured) return;

    setSyncStatus('syncing');
    setSyncMessage('Refreshing live truck data from Supabase.');

    try {
      const remoteTrucks = await fetchRemoteTrucks();
      if (remoteTrucks.length) {
        setTrucks(remoteTrucks);
      }
      setSyncStatus('live');
      setSyncMessage(
        remoteTrucks.length
          ? 'Live data is connected to Supabase.'
          : 'Supabase is connected. Add your first truck from the Owners tab.'
      );
    } catch (error) {
      setSyncStatus('error');
      setSyncMessage('Supabase connection failed, so the app stayed on demo data.');
    }
  };

  useEffect(() => {
    refreshFromRemote();
  }, []);

  const addReview = (truckId: string, input: ReviewInput) => {
    let createdReview: Truck['reviews'][number] | null = null;

    setTrucks((current) =>
      current.map((truck) =>
        truck.id === truckId
          ? {
              ...truck,
              reviews: [
                (createdReview = {
                  id: `${truckId}-${Date.now()}`,
                  author: input.author.trim() || 'Anonymous',
                  rating: input.rating,
                  comment: input.comment.trim(),
                  createdAt: new Date().toISOString(),
                }),
                ...truck.reviews,
              ],
            }
          : truck
      )
    );

    if (createdReview && isSupabaseConfigured) {
      setSyncStatus('syncing');
      setSyncMessage('Saving review to Supabase.');

      insertRemoteReview(truckId, createdReview)
        .then(() => {
          setSyncStatus('live');
          setSyncMessage('Review saved to Supabase.');
        })
        .catch(() => {
          setSyncStatus('error');
          setSyncMessage('Review was added locally, but the Supabase save failed.');
        });
    }
  };

  const postOwnerUpdate = (input: OwnerPostInput) => {
    const existingId = slugify(input.truckName);
    let savedTruck: Truck | null = null;

    setTrucks((current) => {
      const index = current.findIndex((truck) => truck.id === existingId);
      const menu = parseMenuLines(input.menuLines);
      const existingTruck = index >= 0 ? current[index] : null;
      const latBase = 34.0522 + current.length * 0.012;
      const lngBase = -118.2437 + current.length * 0.008;

      const truck: Truck = {
        id: existingId,
        name: input.truckName.trim(),
        cuisine: input.cuisine.trim(),
        address: input.address.trim(),
        latitude: existingTruck?.latitude ?? latBase,
        longitude: existingTruck?.longitude ?? lngBase,
        status: input.status,
        hoursLabel: input.hoursLabel.trim(),
        nextStop: existingTruck?.nextStop ?? 'Add your next stop in the next owner update',
        distance: existingTruck?.distance ?? 'New',
        description: input.description.trim(),
        coverNote: existingTruck?.coverNote ?? 'Owner-posted live update',
        accent: existingTruck?.accent ?? '#C95C31',
        menu: menu.length ? menu : existingTruck?.menu ?? [],
        reviews: existingTruck?.reviews ?? [],
      };

      savedTruck = truck;

      if (index >= 0) {
        const next = [...current];
        next[index] = truck;
        return next;
      }

      return [truck, ...current];
    });

    if (!savedTruck) {
      throw new Error('Truck could not be saved');
    }

    if (isSupabaseConfigured) {
      setSyncStatus('syncing');
      setSyncMessage('Publishing owner update to Supabase.');

      upsertRemoteTruck(savedTruck)
        .then(() => {
          setSyncStatus('live');
          setSyncMessage('Owner update saved to Supabase.');
        })
        .catch(() => {
          setSyncStatus('error');
          setSyncMessage('Owner update was added locally, but the Supabase save failed.');
        });
    }

    return savedTruck;
  };

  const value = useMemo(
    () => ({
      trucks,
      syncStatus,
      syncMessage,
      addReview,
      postOwnerUpdate,
      refreshFromRemote,
    }),
    [syncMessage, syncStatus, trucks]
  );

  return <TruckStoreContext.Provider value={value}>{children}</TruckStoreContext.Provider>;
}

export function useTruckStore() {
  const context = useContext(TruckStoreContext);

  if (!context) {
    throw new Error('useTruckStore must be used inside TruckStoreProvider');
  }

  return context;
}
