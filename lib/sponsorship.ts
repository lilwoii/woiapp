import { toActionError } from '@/lib/errors';
import { createMarketplaceIdempotencyKey } from '@/lib/marketplace-api';
import { createAccountBoundSupabaseClient } from '@/lib/supabase';
import type { ActionResult } from '@/types/marketplace';
import type { SponsoredCampaign, SponsoredCampaignQuote, SponsoredCampaignState } from '@/types/sponsorship';

type Row = Record<string, unknown>;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const states: SponsoredCampaignState[] = ['draft', 'submitted', 'active', 'paused', 'ended', 'rejected'];

async function clientFor(expectedUserId: string) {
  if (!uuidPattern.test(expectedUserId)) throw Object.assign(new Error('The active account changed.'), { status: 401 });
  const client = await createAccountBoundSupabaseClient(expectedUserId);
  if (!client) throw Object.assign(new Error('Live promotion services are not configured.'), { code: 'CONFIG_REQUIRED' });
  return client;
}

function safeInteger(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid campaign amount');
  return value;
}

export function mapSponsoredCampaign(value: unknown): SponsoredCampaign {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid campaign');
  const row = value as Row;
  const id = String(row.public_id ?? '');
  const businessId = String(row.business_id ?? '');
  const state = String(row.state ?? '') as SponsoredCampaignState;
  const startsAt = String(row.starts_at ?? '');
  const endsAt = String(row.ends_at ?? '');
  const updatedAt = String(row.updated_at ?? '');
  if (!uuidPattern.test(id) || !uuidPattern.test(businessId) || !states.includes(state)) throw new Error('Invalid campaign reference');
  const dates = [startsAt, endsAt, updatedAt].map((value) => new Date(value).getTime());
  if (dates.some((value) => !Number.isFinite(value)) || dates[1] <= dates[0]) throw new Error('Invalid campaign dates');
  if (row.currency !== 'USD') throw new Error('Unsupported campaign currency');
  const rollups = Array.isArray(row.ad_campaign_daily_rollups) ? row.ad_campaign_daily_rollups : [];
  const totals = rollups.reduce((sum, candidate) => {
    const item = candidate && typeof candidate === 'object' ? candidate as Row : {};
    return {
      impressions: sum.impressions + safeInteger(item.impressions ?? 0),
      opens: sum.opens + safeInteger(item.opens ?? 0),
      directions: sum.directions + safeInteger(item.directions ?? 0),
      menuViews: sum.menuViews + safeInteger(item.menu_views ?? 0),
      billedMinor: sum.billedMinor + safeInteger(item.billed_minor ?? 0),
      creditedMinor: sum.creditedMinor + safeInteger(item.credited_minor ?? 0),
    };
  }, { impressions: 0, opens: 0, directions: 0, menuViews: 0, billedMinor: 0, creditedMinor: 0 });
  return {
    id, businessId, state, currency: 'USD', startsAt, endsAt, updatedAt,
    bidCapMinor: safeInteger(row.bid_cap_minor),
    dailyBudgetMinor: safeInteger(row.daily_budget_minor),
    lifetimeBudgetMinor: safeInteger(row.lifetime_budget_minor),
    ...totals,
  };
}

export function mapSponsoredCampaignQuote(value: unknown): SponsoredCampaignQuote {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid campaign quote');
  const row = value as Row;
  const minimum = safeInteger(row.minimum_monthly_minor);
  const maximum = safeInteger(row.maximum_monthly_minor);
  const businessName = String(row.business_name ?? '').trim();
  const pricingVersion = String(row.pricing_version ?? '').trim();
  const billingEvent = String(row.billing_event ?? '').trim();
  if (!businessName || !pricingVersion || !billingEvent || maximum < minimum || row.currency !== 'USD' || row.term_days !== 30 || row.disclosure !== 'Sponsored ad') {
    throw new Error('Invalid campaign quote');
  }
  return { businessName, pricingVersion, billingEvent, currency: 'USD', minimumMonthlyMinor: minimum, maximumMonthlyMinor: maximum, termDays: 30, disclosure: 'Sponsored ad' };
}

export async function loadSponsoredCampaigns(businessIds: string[], expectedUserId: string): Promise<ActionResult<SponsoredCampaign[]>> {
  const ids = [...new Set(businessIds)].filter((id) => uuidPattern.test(id)).slice(0, 50);
  if (!ids.length) return { ok: true, data: [] };
  try {
    const client = await clientFor(expectedUserId);
    const { data, error } = await client.from('ad_campaigns')
      .select('public_id,business_id,state,currency,bid_cap_minor,daily_budget_minor,lifetime_budget_minor,starts_at,ends_at,updated_at,ad_campaign_daily_rollups(impressions,opens,directions,menu_views,billed_minor,credited_minor)')
      .in('business_id', ids).order('updated_at', { ascending: false }).limit(100);
    if (error) throw error;
    return { ok: true, data: (data ?? []).map(mapSponsoredCampaign) };
  } catch (error) {
    return toActionError(error, 'Campaigns could not be loaded.');
  }
}

export async function loadSponsoredCampaignQuote(businessId: string, expectedUserId: string): Promise<ActionResult<SponsoredCampaignQuote | null>> {
  if (!uuidPattern.test(businessId)) return { ok: false, code: 'INVALID', reason: 'Choose a verified business.' };
  try {
    const client = await clientFor(expectedUserId);
    const { data, error } = await client.rpc('get_sponsored_campaign_quote', { target_business_id: businessId });
    if (error) throw error;
    return { ok: true, data: data === null ? null : mapSponsoredCampaignQuote(data) };
  } catch (error) {
    return toActionError(error, 'Campaign pricing could not be loaded.');
  }
}

export async function createSponsoredCampaignDraft(input: {
  businessId: string; monthlyBudgetMinor: number; radiusMeters: number; startsAt: string; idempotencyKey?: string;
}, expectedUserId: string): Promise<ActionResult<string>> {
  if (!uuidPattern.test(input.businessId) || !Number.isSafeInteger(input.monthlyBudgetMinor) || !Number.isSafeInteger(input.radiusMeters)) {
    return { ok: false, code: 'INVALID', reason: 'Check the campaign details.' };
  }
  try {
    const client = await clientFor(expectedUserId);
    const { data, error } = await client.rpc('create_sponsored_campaign_draft', {
      target_business_id: input.businessId,
      monthly_budget_minor: input.monthlyBudgetMinor,
      radius_meters: input.radiusMeters,
      campaign_starts_at: input.startsAt,
      idempotency_key: input.idempotencyKey ?? createMarketplaceIdempotencyKey('sponsor'),
    });
    if (error) throw error;
    if (typeof data !== 'string' || !uuidPattern.test(data)) throw new Error('Invalid campaign receipt');
    return { ok: true, data, message: 'Campaign draft created.' };
  } catch (error) {
    return toActionError(error, 'The campaign draft could not be created.');
  }
}

async function transitionCampaign(functionName: 'submit_sponsored_campaign' | 'end_sponsored_campaign', campaign: SponsoredCampaign, expectedUserId: string): Promise<ActionResult<SponsoredCampaignState>> {
  try {
    const client = await clientFor(expectedUserId);
    const { data, error } = await client.rpc(functionName, { target_campaign_public_id: campaign.id, expected_updated_at: campaign.updatedAt });
    if (error) throw error;
    if (data !== 'submitted' && data !== 'ended') throw new Error('Invalid campaign state');
    return { ok: true, data };
  } catch (error) {
    return toActionError(error, 'The campaign state could not be changed.');
  }
}

export const submitSponsoredCampaign = (campaign: SponsoredCampaign, expectedUserId: string) =>
  transitionCampaign('submit_sponsored_campaign', campaign, expectedUserId);
export const endSponsoredCampaign = (campaign: SponsoredCampaign, expectedUserId: string) =>
  transitionCampaign('end_sponsored_campaign', campaign, expectedUserId);
