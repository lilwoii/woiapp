import type { PublicBadge } from '@/lib/trust-badges';

export type PublicProfileLink = {
  label: string;
  url: string;
};

export type PublicProfileReview = {
  id: string;
  businessId: string;
  businessName: string;
  businessSlug: string;
  rating: number;
  body: string;
  postedAt: string;
  postedLabel: string;
  photos: string[];
  helpfulCount: number;
};

export type PublicProfile = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  bannerUrl?: string;
  bio: string;
  links: PublicProfileLink[];
  reviewCount: number;
  followerCount: number;
  followingCount: number | null;
  favoriteCount: number | null;
  showFollowing: boolean;
  showFavorites: boolean;
  followedByViewer: boolean;
  memberSince: string;
  badges: PublicBadge[];
  reviews: PublicProfileReview[];
  hasMoreReviews: boolean;
};
