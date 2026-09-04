export type SponsoredCampaignState = 'draft' | 'submitted' | 'active' | 'paused' | 'ended' | 'rejected';

export type SponsoredCampaignQuote = {
  businessName: string;
  pricingVersion: string;
  currency: 'USD';
  minimumMonthlyMinor: number;
  maximumMonthlyMinor: number;
  billingEvent: string;
  termDays: 30;
  disclosure: 'Sponsored ad';
};

export type SponsoredCampaign = {
  id: string;
  businessId: string;
  state: SponsoredCampaignState;
  currency: 'USD';
  bidCapMinor: number;
  dailyBudgetMinor: number;
  lifetimeBudgetMinor: number;
  startsAt: string;
  endsAt: string;
  updatedAt: string;
  impressions: number;
  opens: number;
  directions: number;
  menuViews: number;
  billedMinor: number;
  creditedMinor: number;
};
