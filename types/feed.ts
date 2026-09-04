import type { PublicBadge } from '@/lib/trust-badges';

export type FeedFilter = 'all' | 'business_post' | 'user_review';

export type FeedCursor = {
  createdAt: string;
  feedType: Exclude<FeedFilter, 'all'>;
  contentId: string;
};

export type FeedItem = {
  type: 'business_post' | 'user_review';
  id: string;
  businessId: string;
  businessName: string;
  businessSlug: string;
  businessLogoUrl?: string;
  authorId?: string;
  authorUsername?: string;
  authorDisplayName?: string;
  body: string;
  rating?: number;
  photos: string[];
  createdAt: string;
  createdLabel: string;
  createdDateTimeLabel: string;
  badges: PublicBadge[];
};

export type BusinessPostMediaCandidate = {
  id: string;
  url: string;
  width: number;
  height: number;
  createdAt: string;
};
