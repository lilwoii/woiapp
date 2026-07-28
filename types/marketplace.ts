export type BusinessCategory =
  | 'food_truck'
  | 'restaurant'
  | 'pop_up'
  | 'cafe_bakery'
  | 'home_kitchen';

export type VenueStatus = 'open' | 'opening_soon' | 'moving_soon' | 'closed';

export type PaymentMethod =
  | 'Cash'
  | 'Visa'
  | 'Mastercard'
  | 'Amex'
  | 'Apple Pay'
  | 'Google Pay'
  | 'Cash App'
  | 'Venmo';

export type DietaryTag = 'Vegetarian' | 'Vegan' | 'Gluten-aware' | 'Halal' | 'Spicy';

export type MenuItem = {
  id: string;
  name: string;
  description: string;
  price: number;
  dietary?: DietaryTag[];
  photoUrl?: string;
  popular?: boolean;
  soldOut?: boolean;
};

export type MenuSection = {
  id: string;
  name: string;
  items: MenuItem[];
};

export type WeeklyHours = {
  day: string;
  hours: string;
  closed?: boolean;
};

export type BusinessUpdate = {
  id: string;
  type: 'location' | 'availability' | 'hours' | 'menu';
  message: string;
  createdAt: string;
  expiresAt: string;
};

export type Review = {
  id: string;
  username: string;
  displayName: string;
  rating: number;
  comment: string;
  createdAt: string;
  photos: string[];
  helpfulCount: number;
  ownerResponse?: string;
};

export type Place = {
  id: string;
  slug: string;
  name: string;
  category: BusinessCategory;
  categoryLabel: string;
  cuisines: string[];
  address: string;
  city: string;
  postalCode: string;
  latitude: number;
  longitude: number;
  distanceMiles: number;
  status: VenueStatus;
  todayHours: string;
  weeklyHours: WeeklyHours[];
  nextStop?: string;
  description: string;
  priceLevel: 1 | 2 | 3 | 4;
  accent: string;
  logoUrl: string;
  coverImageUrl: string;
  gallery: string[];
  rating: number;
  reviewCount: number;
  verified: boolean;
  lastConfirmedAt: string;
  payments: PaymentMethod[];
  menu: MenuSection[];
  reviews: Review[];
  update?: BusinessUpdate;
  features: string[];
  trendingScore: number;
  popularityScore: number;
  reliabilityScore: number;
  serviceArea?: string;
  sourceLabel: 'Owner verified' | 'Community added' | 'Licensed provider';
};

export type ReviewInput = {
  rating: number;
  comment: string;
  photos?: string[];
};

export type OwnerUpdateInput = {
  placeId: string;
  type: BusinessUpdate['type'];
  message: string;
};

export type AccountRole = 'customer' | 'business';

export type DemoAccount = {
  id: string;
  username: string;
  displayName: string;
  email: string;
  role: AccountRole;
};

export type SyncStatus = 'demo' | 'syncing' | 'live' | 'error';

