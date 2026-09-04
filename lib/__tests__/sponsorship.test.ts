import { mapSponsoredCampaign, mapSponsoredCampaignQuote } from '../sponsorship';

const campaign = {
  public_id: '129694b7-c1e0-42fa-b87e-fd37bd54e776', business_id: 'df1902d6-63fc-4bd3-9b64-a57bc0d865d8',
  state: 'submitted', currency: 'USD', bid_cap_minor: 75, daily_budget_minor: 500,
  lifetime_budget_minor: 15000, starts_at: '2026-10-01T08:00:00Z', ends_at: '2026-10-31T08:00:00Z',
  updated_at: '2026-09-20T08:00:00Z',
  ad_campaign_daily_rollups: [{ impressions: 100, opens: 8, directions: 2, menu_views: 4, billed_minor: 225, credited_minor: 75 }],
};

describe('sponsored campaign client contracts', () => {
  it('maps safe campaign totals without leaking internal billing data', () => {
    const mapped = mapSponsoredCampaign({ ...campaign, request_hash: 'private' });
    expect(mapped).toMatchObject({ state: 'submitted', impressions: 100, opens: 8, billedMinor: 225, creditedMinor: 75 });
    expect(mapped).not.toHaveProperty('requestHash');
  });

  it('rejects unsupported money, malformed totals, and invalid quotes', () => {
    expect(() => mapSponsoredCampaign({ ...campaign, currency: 'EUR' })).toThrow('currency');
    expect(() => mapSponsoredCampaign({ ...campaign, ad_campaign_daily_rollups: [{ impressions: -1 }] })).toThrow('amount');
    expect(() => mapSponsoredCampaignQuote({
      business_name: 'Night Market Kitchen', pricing_version: 'us-2026-01',
      billing_event: 'qualified sponsored open', currency: 'USD',
      minimum_monthly_minor: 15000, maximum_monthly_minor: 300000,
      term_days: 30, disclosure: 'Ad',
    })).toThrow('quote');
  });
});
