export type TruckStatus = 'Open now' | 'Moving soon' | 'Closed';

export type MenuItem = {
  id: string;
  name: string;
  price: string;
  tag?: string;
};

export type Review = {
  id: string;
  author: string;
  rating: number;
  comment: string;
  createdAt: string;
};

export type Truck = {
  id: string;
  name: string;
  cuisine: string;
  address: string;
  latitude: number;
  longitude: number;
  status: TruckStatus;
  hoursLabel: string;
  nextStop?: string;
  distance: string;
  description: string;
  coverNote: string;
  accent: string;
  menu: MenuItem[];
  reviews: Review[];
};

export type OwnerPostInput = {
  truckName: string;
  cuisine: string;
  address: string;
  hoursLabel: string;
  menuLines: string;
  status: TruckStatus;
  description: string;
};

export type ReviewInput = {
  author: string;
  rating: number;
  comment: string;
};

export type SyncStatus = 'demo' | 'syncing' | 'live' | 'error';
