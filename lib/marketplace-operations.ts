import { createMarketplaceOperationsKey, type BusinessMarketplaceResult } from '@/lib/business-marketplace';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

type Row = Record<string, unknown>;
type ChatVisibility = 'visible' | 'held' | 'removed';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ReportedChatMessage = {
  reportId: string;
  reportState: string;
  reportReason: string;
  reportDetail: string | null;
  reportedAt: string;
  messagePublicId: string;
  body: string;
  visibility: ChatVisibility;
  moderationVersion: number;
  sentAt: string;
  senderName: string;
  senderUsername: string | null;
  conversationPublicId: string;
  businessId: string;
  attachmentCount: number;
};

export type PendingPickupSite = {
  publicId: string;
  businessId: string;
  businessName: string;
  label: string;
  kind: 'public_meeting_place' | 'commercial_site';
  addressLine: string;
  city: string;
  region: string;
  postalCode: string | null;
  latitude: number;
  longitude: number;
  submittedAt: string;
};

function isRow(value: unknown): value is Row { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function text(row: Row, key: string, optional = false) {
  const value = row[key];
  if (optional && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${key}`);
  return value.trim();
}
function uuid(row: Row, key: string) { const value = text(row, key)!; if (!uuidPattern.test(value)) throw new Error(`Invalid ${key}`); return value; }
function date(row: Row, key: string) { const value = text(row, key)!; if (!Number.isFinite(new Date(value).getTime())) throw new Error(`Invalid ${key}`); return value; }
function coordinate(row: Row, key: string, min: number, max: number) { const value = row[key]; if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${key}`); return value; }

export function mapReportedChatMessages(value: unknown): ReportedChatMessage[] {
  if (!Array.isArray(value)) throw new Error('Invalid reported chat queue');
  const mapped = value.map((candidate) => {
    if (!isRow(candidate)) throw new Error('Invalid reported chat item');
    const rawVisibility = candidate.message_visibility;
    if (rawVisibility !== 'visible' && rawVisibility !== 'held' && rawVisibility !== 'removed') throw new Error('Invalid message visibility');
    const visibility: ChatVisibility = rawVisibility;
    const version = candidate.message_moderation_version;
    if (!Number.isInteger(version) || Number(version) < 1) throw new Error('Invalid moderation version');
    const attachments = Array.isArray(candidate.attachments) ? candidate.attachments : [];
    return {
      reportId: uuid(candidate, 'report_id'), reportState: text(candidate, 'report_state')!, reportReason: text(candidate, 'report_reason')!,
      reportDetail: text(candidate, 'report_detail', true), reportedAt: date(candidate, 'reported_at'),
      messagePublicId: uuid(candidate, 'message_public_id'), body: text(candidate, 'message_body', true) ?? '[Photo attachment]', visibility, moderationVersion: Number(version),
      sentAt: date(candidate, 'message_sent_at'), senderName: text(candidate, 'sender_name')!,
      senderUsername: text(candidate, 'sender_username', true), conversationPublicId: uuid(candidate, 'conversation_public_id'),
      businessId: uuid(candidate, 'business_id'), attachmentCount: attachments.length,
    };
  });
  const grouped = new Map<string, ReportedChatMessage>();
  for (const item of mapped) {
    const current = grouped.get(item.messagePublicId);
    if (!current) { grouped.set(item.messagePublicId, item); continue; }
    grouped.set(item.messagePublicId, {
      ...current,
      reportReason: [...new Set(`${current.reportReason}|${item.reportReason}`.split('|'))].join(' · '),
      reportDetail: [current.reportDetail, item.reportDetail].filter(Boolean).join(' · ') || null,
      attachmentCount: Math.max(current.attachmentCount, item.attachmentCount),
      reportedAt: new Date(current.reportedAt) <= new Date(item.reportedAt) ? current.reportedAt : item.reportedAt,
    });
  }
  return [...grouped.values()];
}

export function mapPendingPickupSites(value: unknown): PendingPickupSite[] {
  if (!Array.isArray(value)) throw new Error('Invalid pickup review queue');
  return value.map((candidate) => {
    if (!isRow(candidate)) throw new Error('Invalid pickup review item');
    const kind = candidate.site_kind;
    if (kind !== 'public_meeting_place' && kind !== 'commercial_site') throw new Error('Invalid pickup kind');
    return {
      publicId: uuid(candidate, 'pickup_site_public_id'), businessId: uuid(candidate, 'business_id'),
      businessName: text(candidate, 'business_name')!, label: text(candidate, 'label')!, kind,
      addressLine: text(candidate, 'address_line')!, city: text(candidate, 'city')!, region: text(candidate, 'region')!,
      postalCode: text(candidate, 'postal_code', true), latitude: coordinate(candidate, 'latitude', -90, 90),
      longitude: coordinate(candidate, 'longitude', -180, 180), submittedAt: date(candidate, 'submitted_at'),
    };
  });
}

async function client() {
  if (!isSupabaseConfigured || !supabase) throw new Error('Live services are not configured.');
  const [{ data, error }, assurance] = await Promise.all([supabase.auth.getUser(), supabase.auth.mfa.getAuthenticatorAssuranceLevel()]);
  if (error || !data.user) throw Object.assign(error ?? new Error('Not authenticated'), { status: 401 });
  if (assurance.error) throw assurance.error;
  if (assurance.data.currentLevel !== 'aal2') throw Object.assign(new Error('AAL2 required'), { status: 403 });
  return supabase;
}

function fail<T>(error: unknown, fallback: string): BusinessMarketplaceResult<T> {
  const candidate = error as { code?: string; message?: string; status?: number };
  const message = candidate?.message?.toLowerCase() ?? '';
  if (candidate?.status === 401 || message.includes('jwt')) return { ok: false, code: 'AUTH', reason: 'Sign in again before opening trust operations.' };
  if (candidate?.status === 403 || candidate?.code === '42501' || message.includes('aal2') || message.includes('staff')) return { ok: false, code: 'FORBIDDEN', reason: 'A verified Spottr moderator or administrator session is required.' };
  if (candidate?.code === '40001') return { ok: false, code: 'CONFLICT', reason: 'This item changed. Reload the queue.' };
  if (candidate?.code === '22023' || candidate?.code === '23514') return { ok: false, code: 'INVALID', reason: fallback };
  if (message.includes('fetch') || message.includes('network')) return { ok: false, code: 'NETWORK', reason: 'Trust operations could not reach Spottr.' };
  return { ok: false, code: 'UNKNOWN', reason: fallback };
}

export async function loadReportedChatMessages(): Promise<BusinessMarketplaceResult<ReportedChatMessage[]>> {
  try { const c = await client(); const { data, error } = await c.rpc('list_reported_marketplace_messages_v2', { result_limit: 100, result_offset: 0 }); if (error) throw error; return { ok: true, data: mapReportedChatMessages(data) }; }
  catch (error) { return fail(error, 'Reported messages could not be loaded.'); }
}

export async function moderateReportedChatMessage(message: ReportedChatMessage, visibility: ChatVisibility, reason: string): Promise<BusinessMarketplaceResult<void>> {
  try {
    const normalized = reason.normalize('NFKC').trim().toUpperCase().replace(/[^A-Z0-9_:-]+/g, '_').replace(/^_+|_+$/g, '');
    if (normalized.length < 3 || normalized.length > 80) return { ok: false, code: 'INVALID', reason: 'Use a concise internal reason code from 3 to 80 characters.' };
    const c = await client(); const { error } = await c.rpc('moderate_marketplace_message_v2', { target_message_public_id: message.messagePublicId, expected_moderation_version: message.moderationVersion, next_visibility: visibility, moderation_reason: normalized, idempotency_key: createMarketplaceOperationsKey('moderate') }); if (error) throw error;
    return { ok: true, data: undefined };
  } catch (error) { return fail(error, 'The chat decision could not be recorded.'); }
}

export async function loadPendingPickupSites(): Promise<BusinessMarketplaceResult<PendingPickupSite[]>> {
  try { const c = await client(); const { data, error } = await c.rpc('list_pending_marketplace_pickup_sites', { result_limit: 100, result_offset: 0 }); if (error) throw error; return { ok: true, data: mapPendingPickupSites(data) }; }
  catch (error) { return fail(error, 'Pickup sites could not be loaded.'); }
}

export async function reviewPendingPickupSite(site: PendingPickupSite, state: 'approved' | 'rejected', reason: string, confirmedNonResidential: boolean): Promise<BusinessMarketplaceResult<void>> {
  try {
    const normalized = reason.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (normalized.length < 10 || normalized.length > 1000) return { ok: false, code: 'INVALID', reason: 'Record an internal review reason from 10 to 1,000 characters.' };
    if (state === 'approved' && !confirmedNonResidential) return { ok: false, code: 'INVALID', reason: 'Confirm this is a non-residential public or commercial site before approval.' };
    const c = await client(); const { error } = await c.rpc('review_marketplace_pickup_site', { target_pickup_site_public_id: site.publicId, next_state: state, confirmed_non_residential: state === 'approved' && confirmedNonResidential, review_reason: normalized, idempotency_key: createMarketplaceOperationsKey('review-site') }); if (error) throw error;
    return { ok: true, data: undefined };
  } catch (error) { return fail(error, 'The pickup site decision could not be recorded.'); }
}
