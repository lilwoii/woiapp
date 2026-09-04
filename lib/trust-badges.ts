import type { ComponentProps } from 'react';
import FontAwesome6 from '@expo/vector-icons/FontAwesome6';

export type BadgeAudience = 'reviewer' | 'business' | 'seller';
export type BadgeTier = 'starter' | 'bronze' | 'silver' | 'gold' | 'signature';

export type PublicBadge = {
  code: string;
  title: string;
  shortLabel: string;
  description: string;
  requirement: string;
  audience: BadgeAudience;
  tier: BadgeTier;
  icon: ComponentProps<typeof FontAwesome6>['name'];
  earnedAt?: string;
  expiresAt?: string;
};

type BadgeDefinition = Omit<PublicBadge, 'earnedAt' | 'expiresAt'>;

export const TRUST_BADGES: readonly BadgeDefinition[] = [
  { code: 'first_bite', title: 'First Bite', shortLabel: 'First Bite', description: 'Started sharing useful local food experiences.', requirement: 'Publish 1 approved review.', audience: 'reviewer', tier: 'starter', icon: 'utensils' },
  { code: 'regular_5', title: 'Spottr Regular', shortLabel: 'Regular', description: 'Keeps the community informed with first-hand reviews.', requirement: 'Publish 5 approved reviews.', audience: 'reviewer', tier: 'bronze', icon: 'location-dot' },
  { code: 'local_voice_10', title: 'Local Voice', shortLabel: 'Local Voice', description: 'A consistent voice in local food discovery.', requirement: 'Publish 10 approved reviews.', audience: 'reviewer', tier: 'silver', icon: 'bullhorn' },
  { code: 'city_guide_25', title: 'City Guide', shortLabel: 'City Guide', description: 'Has built a substantial record of local recommendations.', requirement: 'Publish 25 approved reviews.', audience: 'reviewer', tier: 'gold', icon: 'map' },
  { code: 'neighborhood_authority_50', title: 'Neighborhood Authority', shortLabel: 'Authority', description: 'A long-term contributor across the local food scene.', requirement: 'Publish 50 approved reviews.', audience: 'reviewer', tier: 'signature', icon: 'compass' },
  { code: 'spottr_standard_100', title: 'Spottr Standard', shortLabel: 'Spottr 100', description: 'One hundred approved contributions with an account in good standing.', requirement: 'Publish 100 approved reviews and remain in good standing.', audience: 'reviewer', tier: 'signature', icon: 'award' },
  { code: 'photo_scout_5', title: 'Photo Scout I', shortLabel: 'Photo I', description: 'Helps people see what to expect before they arrive.', requirement: 'Add approved photos to 5 reviews.', audience: 'reviewer', tier: 'bronze', icon: 'camera' },
  { code: 'photo_scout_20', title: 'Photo Scout II', shortLabel: 'Photo II', description: 'A dependable visual contributor.', requirement: 'Add approved photos to 20 reviews.', audience: 'reviewer', tier: 'silver', icon: 'camera-retro' },
  { code: 'photo_scout_50', title: 'Photo Scout III', shortLabel: 'Photo III', description: 'A standout visual documentarian of local food.', requirement: 'Add approved photos to 50 reviews.', audience: 'reviewer', tier: 'gold', icon: 'images' },
  { code: 'helpful_voice_10', title: 'Helpful Voice I', shortLabel: 'Helpful I', description: 'Other members regularly find these reviews useful.', requirement: 'Receive 10 eligible helpful votes.', audience: 'reviewer', tier: 'bronze', icon: 'thumbs-up' },
  { code: 'helpful_voice_50', title: 'Helpful Voice II', shortLabel: 'Helpful II', description: 'Reviews repeatedly help people make a decision.', requirement: 'Receive 50 eligible helpful votes.', audience: 'reviewer', tier: 'silver', icon: 'hands-clapping' },
  { code: 'helpful_voice_200', title: 'Helpful Voice III', shortLabel: 'Helpful III', description: 'Exceptional community usefulness over time.', requirement: 'Receive 200 eligible helpful votes.', audience: 'reviewer', tier: 'gold', icon: 'hand-holding-heart' },
  { code: 'truck_tracker_5', title: 'Truck Tracker I', shortLabel: 'Truck I', description: 'Actively supports mobile food businesses.', requirement: 'Publish 5 approved food-truck reviews.', audience: 'reviewer', tier: 'bronze', icon: 'truck' },
  { code: 'truck_tracker_20', title: 'Truck Tracker II', shortLabel: 'Truck II', description: 'A seasoned guide to the mobile food scene.', requirement: 'Publish 20 approved food-truck reviews.', audience: 'reviewer', tier: 'silver', icon: 'truck-fast' },
  { code: 'consistent_voice_6', title: 'Consistent Voice', shortLabel: 'Consistent', description: 'Contributes across seasons, not just in a burst.', requirement: 'Publish approved reviews in 6 distinct months.', audience: 'reviewer', tier: 'gold', icon: 'calendar-check' },
  { code: 'verified_business', title: 'Verified Business', shortLabel: 'Verified', description: 'Business control and identity checks are complete.', requirement: 'Complete Spottr business verification.', audience: 'business', tier: 'signature', icon: 'circle-check' },
  { code: 'quick_reply', title: 'Quick Reply', shortLabel: 'Quick Reply', description: 'Usually answers eligible customer messages promptly.', requirement: 'Meet the rolling response-time standard with sufficient message volume.', audience: 'business', tier: 'bronze', icon: 'bolt' },
  { code: 'great_communicator', title: 'Great Communicator', shortLabel: 'Communicator', description: 'Communicates clearly and reliably with customers.', requirement: 'Maintain strong communication feedback and low substantiated report rates.', audience: 'business', tier: 'gold', icon: 'comments' },
  { code: 'consistent_service', title: 'Consistent Service', shortLabel: 'Consistent', description: 'Keeps hours, service status, and customer expectations dependable.', requirement: 'Meet the rolling reliability standard for 90 days.', audience: 'business', tier: 'gold', icon: 'clock' },
  { code: 'fresh_menu', title: 'Fresh Menu', shortLabel: 'Fresh Menu', description: 'Keeps menu details and availability current.', requirement: 'Maintain a recently confirmed menu with required pricing.', audience: 'business', tier: 'silver', icon: 'list-check' },
  { code: 'community_favorite', title: 'Community Favorite', shortLabel: 'Favorite', description: 'Sustained strong ratings from eligible first-party reviews.', requirement: 'Meet the minimum review volume, rating, and integrity standards.', audience: 'business', tier: 'signature', icon: 'heart' },
  { code: 'rising_spot', title: 'Rising Spot', shortLabel: 'Rising', description: 'Earning unusual positive momentum locally.', requirement: 'Meet the time-limited local growth and quality threshold.', audience: 'business', tier: 'silver', icon: 'arrow-trend-up' },
  { code: 'local_trendsetter', title: 'Local Trendsetter', shortLabel: 'Trending', description: 'Currently among the most engaged-with places in its area.', requirement: 'Meet the rolling local engagement threshold; recalculated regularly.', audience: 'business', tier: 'gold', icon: 'fire' },
  { code: 'route_reliable', title: 'Route Reliable', shortLabel: 'Route Ready', description: 'A mobile business with dependable published stops.', requirement: 'Maintain accurate stops with a strong confirmation record.', audience: 'business', tier: 'gold', icon: 'route' },
  { code: 'verified_seller', title: 'Verified Seller', shortLabel: 'Verified', description: 'Seller identity and marketplace eligibility checks are complete.', requirement: 'Complete Spottr seller verification.', audience: 'seller', tier: 'signature', icon: 'shield-halved' },
  { code: 'trusted_seller', title: 'Trusted Seller', shortLabel: 'Trusted', description: 'A durable record of reliable communication and completed handoffs.', requirement: 'Meet verification, tenure, feedback, and low-dispute standards.', audience: 'seller', tier: 'signature', icon: 'handshake' },
  { code: 'pickup_pro', title: 'Pickup Pro', shortLabel: 'Pickup Pro', description: 'Consistently coordinates smooth pickup handoffs.', requirement: 'Meet the rolling pickup reliability standard.', audience: 'seller', tier: 'gold', icon: 'bag-shopping' },
  { code: 'spottr_orders_25', title: '25 Spottr Orders', shortLabel: '25 Orders', description: 'Completed 25 verified Spottr pickup orders.', requirement: 'Complete 25 non-refunded Spottr orders.', audience: 'seller', tier: 'bronze', icon: 'receipt' },
  { code: 'spottr_orders_100', title: '100 Spottr Orders', shortLabel: '100 Orders', description: 'Completed 100 verified Spottr pickup orders.', requirement: 'Complete 100 non-refunded Spottr orders.', audience: 'seller', tier: 'silver', icon: 'receipt' },
  { code: 'spottr_orders_500', title: '500 Spottr Orders', shortLabel: '500 Orders', description: 'Completed 500 verified Spottr pickup orders.', requirement: 'Complete 500 non-refunded Spottr orders.', audience: 'seller', tier: 'gold', icon: 'store' },
  { code: 'spottr_orders_1000', title: '1,000 Spottr Orders', shortLabel: '1K Orders', description: 'Completed 1,000 verified Spottr pickup orders.', requirement: 'Complete 1,000 non-refunded Spottr orders.', audience: 'seller', tier: 'signature', icon: 'trophy' },
] as const;

export const BADGE_BY_CODE = new Map(TRUST_BADGES.map((badge) => [badge.code, badge]));

export function publicBadgeFromCode(
  code: string,
  earnedAt?: string,
  expiresAt?: string
): PublicBadge | null {
  const definition = BADGE_BY_CODE.get(code);
  if (!definition) return null;
  return {
    ...definition,
    ...(earnedAt ? { earnedAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

export function badgeAccessibilityLabel(badge: PublicBadge) {
  return `${badge.title}. ${badge.description} Requirement: ${badge.requirement}`;
}
