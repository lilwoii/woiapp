export type BusinessCategory =
  | 'food_truck'
  | 'restaurant'
  | 'pop_up'
  | 'cafe_bakery'
  | 'home_kitchen';

export type VenueStatus = 'open' | 'opening_soon' | 'moving_soon' | 'closed';

export const MOVING_TO_NEXT_LOCATION_LABEL = 'Moving to next location' as const;

export type MovingServiceState = {
  state: 'moving_to_next_location';
  label: typeof MOVING_TO_NEXT_LOCATION_LABEL;
  nextStop: {
    locationId: string;
    address: string;
    city: string;
    region?: string;
    postalCode?: string;
    startsAt: string;
    endsAt: string;
    timeWindow: string;
  };
};

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
  moderation?: 'pending' | 'approved' | 'rejected' | 'removed';
};

export type Review = {
  id: string;
  authorId?: string;
  username: string;
  displayName: string;
  rating: number;
  comment: string;
  createdAt: string;
  photos: string[];
  photoMediaIds?: string[];
  helpfulCount: number;
  badges?: import('@/lib/trust-badges').PublicBadge[];
  ownerResponse?: string;
  ownerResponseId?: string;
  moderation?: 'pending' | 'approved' | 'rejected' | 'removed';
};

export type Place = {
  id: string;
  locationId?: string;
  slug: string;
  name: string;
  category: BusinessCategory;
  categoryLabel: string;
  cuisines: string[];
  address: string;
  city: string;
  region?: string;
  postalCode: string;
  phone?: string;
  websiteUrl?: string;
  latitude: number;
  longitude: number;
  distanceMiles: number | null;
  status: VenueStatus;
  todayHours: string;
  weeklyHours: WeeklyHours[];
  nextStop?: string;
  mobility?: MovingServiceState;
  description: string;
  priceLevel: 1 | 2 | 3 | 4;
  accent: string;
  logoUrl: string;
  coverImageUrl: string;
  gallery: string[];
  galleryMediaIds?: string[];
  rating: number;
  reviewCount: number;
  verified: boolean;
  lastConfirmedAt: string;
  payments: PaymentMethod[];
  menu: MenuSection[];
  reviews: Review[];
  hasMoreReviews?: boolean;
  update?: BusinessUpdate;
  features: string[];
  trendingScore: number;
  popularityScore: number;
  reliabilityScore?: number;
  serviceArea?: string;
  pickup?: {
    enabled: boolean;
    orderingMode: 'spottr' | 'external' | 'phone' | 'none';
    estimatedMinutes?: number;
  };
  sourceLabel: 'Owner verified' | 'Owner provided' | 'Community added' | 'Licensed provider';
  publicationState?: 'draft' | 'pending' | 'published' | 'suspended' | 'archived';
  detailsLoaded?: boolean;
};

export type SponsoredPlace = Place & {
  sponsoredPlacement: {
    id: string;
    disclosure: 'Sponsored ad';
    reason: string;
    token: string;
    expiresAt: string;
  };
};

export type ReviewInput = {
  rating: number;
  comment: string;
  photos?: string[];
  photoUploads?: ReviewPhotoInput[];
  idempotencyKey?: string;
};

export type ReviewPhotoInput = {
  uri: string;
  mimeType?: string | null;
  fileSize?: number | null;
};

export type OwnerUpdateInput = {
  placeId: string;
  type: BusinessUpdate['type'];
  message: string;
  idempotencyKey?: string;
};

export type AccountRole = 'customer' | 'business';

export type AccountSummary = {
  id: string;
  username: string;
  displayName: string;
  email: string;
  role: AccountRole;
  emailVerified?: boolean;
  avatarPath?: string | null;
};

export type SyncStatus = 'idle' | 'syncing' | 'live' | 'error';

export type ActionResult<T = undefined> =
  | {
      ok: true;
      data?: T;
      message?: string;
    }
  | {
      ok: false;
      reason: string;
      code?:
        | 'AUTH_REQUIRED'
        | 'CONFIG_REQUIRED'
        | 'CONFLICT'
        | 'FORBIDDEN'
        | 'INVALID'
        | 'NETWORK'
        | 'NOT_FOUND'
        | 'RATE_LIMITED'
        | 'UNKNOWN';
    };

export type BusinessClaimState = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export type BusinessClaimMethod =
  | 'listed_phone'
  | 'domain_email'
  | 'document'
  | 'permit';

/**
 * The account-facing claim projection intentionally contains no evidence path
 * or reviewer identity. Those fields are private operational data and never
 * belong in a client response.
 */
export type BusinessClaim = {
  id: string;
  businessId: string;
  businessName: string | null;
  method: BusinessClaimMethod;
  state: BusinessClaimState;
  createdAt: string;
};

export type BusinessClaimReceipt = {
  claimId: string;
  state: BusinessClaimState;
};
