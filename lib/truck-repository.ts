import { Truck } from '@/types/truck';
import { supabase } from '@/lib/supabase';

type TruckRow = {
  id: string;
  name: string;
  cuisine: string;
  address: string;
  latitude: number;
  longitude: number;
  status: Truck['status'];
  hours_label: string;
  next_stop: string | null;
  distance: string;
  description: string;
  cover_note: string;
  accent: string;
};

type MenuRow = {
  id: string;
  truck_id: string;
  name: string;
  price: string;
  tag: string | null;
  sort_order: number;
};

type ReviewRow = {
  id: string;
  truck_id: string;
  author: string;
  rating: number;
  comment: string;
  created_at: string;
};

const mapTruck = (truck: TruckRow, menuRows: MenuRow[], reviewRows: ReviewRow[]): Truck => ({
  id: truck.id,
  name: truck.name,
  cuisine: truck.cuisine,
  address: truck.address,
  latitude: truck.latitude,
  longitude: truck.longitude,
  status: truck.status,
  hoursLabel: truck.hours_label,
  nextStop: truck.next_stop ?? undefined,
  distance: truck.distance,
  description: truck.description,
  coverNote: truck.cover_note,
  accent: truck.accent,
  menu: menuRows
    .filter((item) => item.truck_id === truck.id)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((item) => ({
      id: item.id,
      name: item.name,
      price: item.price,
      tag: item.tag ?? undefined,
    })),
  reviews: reviewRows
    .filter((item) => item.truck_id === truck.id)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map((item) => ({
      id: item.id,
      author: item.author,
      rating: item.rating,
      comment: item.comment,
      createdAt: item.created_at,
    })),
});

export async function fetchRemoteTrucks() {
  if (!supabase) return [];

  const [{ data: trucks, error: truckError }, { data: menuItems, error: menuError }, { data: reviews, error: reviewError }] =
    await Promise.all([
      supabase.from('trucks').select('*').order('name'),
      supabase.from('menu_items').select('*').order('sort_order'),
      supabase.from('reviews').select('*').order('created_at', { ascending: false }),
    ]);

  if (truckError) throw truckError;
  if (menuError) throw menuError;
  if (reviewError) throw reviewError;

  return (trucks ?? []).map((truck) => mapTruck(truck, menuItems ?? [], reviews ?? []));
}

export async function upsertRemoteTruck(truck: Truck) {
  if (!supabase) return;

  const { error: truckError } = await supabase.from('trucks').upsert(
    {
      id: truck.id,
      name: truck.name,
      cuisine: truck.cuisine,
      address: truck.address,
      latitude: truck.latitude,
      longitude: truck.longitude,
      status: truck.status,
      hours_label: truck.hoursLabel,
      next_stop: truck.nextStop ?? null,
      distance: truck.distance,
      description: truck.description,
      cover_note: truck.coverNote,
      accent: truck.accent,
    },
    { onConflict: 'id' }
  );

  if (truckError) throw truckError;

  const { error: deleteMenuError } = await supabase.from('menu_items').delete().eq('truck_id', truck.id);
  if (deleteMenuError) throw deleteMenuError;

  if (truck.menu.length) {
    const { error: menuError } = await supabase.from('menu_items').insert(
      truck.menu.map((item, index) => ({
        id: item.id,
        truck_id: truck.id,
        name: item.name,
        price: item.price,
        tag: item.tag ?? null,
        sort_order: index,
      }))
    );

    if (menuError) throw menuError;
  }
}

export async function insertRemoteReview(truckId: string, review: Truck['reviews'][number]) {
  if (!supabase) return;

  const { error } = await supabase.from('reviews').insert({
    id: review.id,
    truck_id: truckId,
    author: review.author,
    rating: review.rating,
    comment: review.comment,
    created_at: review.createdAt,
  });

  if (error) throw error;
}
