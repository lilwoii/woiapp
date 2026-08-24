import { validateUsername } from '@/lib/moderation';
import {
  createAccountBoundSupabaseClient,
  isSupabaseConfigured,
  supabase,
} from '@/lib/supabase';

export type BusinessTeamRole = 'owner' | 'manager' | 'staff';
export type AssignableBusinessTeamRole = Exclude<BusinessTeamRole, 'owner'>;
export type BusinessInvitationDecision = 'accept' | 'decline';
export type BusinessInvitationState =
  | 'pending'
  | 'accepted'
  | 'declined'
  | 'revoked'
  | 'expired';

export type BusinessTeamMember = {
  memberPublicId: string;
  username: string;
  displayName: string;
  avatarPath: string | null;
  role: BusinessTeamRole;
  joinedAt: string | null;
  isCurrentUser: boolean;
};

export type BusinessTeamInvitation = {
  invitationId: string;
  businessId: string;
  businessName: string;
  targetHint: string;
  targetType: 'email' | 'username' | null;
  role: AssignableBusinessTeamRole;
  state: BusinessInvitationState;
  invitedAt: string;
  expiresAt: string | null;
  invitedByDisplayName: string | null;
};

export type BusinessTeamWorkspace = {
  businessId: string;
  businessName: string;
  viewerRole: 'owner' | 'manager';
  members: BusinessTeamMember[];
  invitations: BusinessTeamInvitation[];
};

export type TeamCapabilities = {
  canInviteManager: boolean;
  canInviteStaff: boolean;
  canChangeManagerRoles: boolean;
  canChangeStaffRoles: boolean;
  canRevokeManagers: boolean;
  canRevokeStaff: boolean;
  canTransferOwnership: boolean;
};

export type BusinessTeamResult<T = undefined> =
  | { ok: true; data: T; message?: string }
  | {
      ok: false;
      code:
        | 'AUTH_REQUIRED'
        | 'CONFIG_REQUIRED'
        | 'CONFLICT'
        | 'FORBIDDEN'
        | 'INVALID'
        | 'NETWORK'
        | 'NOT_FOUND'
        | 'RATE_LIMITED'
        | 'UNKNOWN';
      reason: string;
    };

type JsonRecord = Record<string, unknown>;

class TeamValidationError extends Error {}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let idempotencySequence = 0;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(record: JsonRecord, key: string, label: string) {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new TeamValidationError(`The team response is missing ${label}.`);
  }
  return value.trim();
}

function optionalString(record: JsonRecord, key: string) {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstString(record: JsonRecord, keys: string[]) {
  for (const key of keys) {
    const value = optionalString(record, key);
    if (value) return value;
  }
  return null;
}

function parseRole(value: unknown): BusinessTeamRole {
  if (value === 'owner' || value === 'manager' || value === 'staff') return value;
  throw new TeamValidationError('The team response contains an unsupported role.');
}

function parseAssignableRole(value: unknown): AssignableBusinessTeamRole {
  const role = parseRole(value);
  if (role === 'owner') {
    throw new TeamValidationError(
      'Ownership must be transferred separately from invitations.'
    );
  }
  return role;
}

function parseInvitationState(value: unknown): BusinessInvitationState {
  if (
    value === 'pending' ||
    value === 'accepted' ||
    value === 'declined' ||
    value === 'revoked' ||
    value === 'expired'
  ) {
    return value;
  }
  throw new TeamValidationError(
    'The team response contains an unsupported invitation state.'
  );
}

function parseDate(value: unknown, label: string, optional = false) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || !Number.isFinite(new Date(value).getTime())) {
    throw new TeamValidationError(`The team response contains an invalid ${label}.`);
  }
  return value;
}

function normalizedPayload(value: unknown): JsonRecord {
  const candidate = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (!isRecord(candidate)) {
    throw new TeamValidationError('Spottr received an invalid team response.');
  }
  return candidate;
}

function mapMember(value: unknown): BusinessTeamMember {
  if (!isRecord(value)) {
    throw new TeamValidationError('The team response contains an invalid member.');
  }
  return {
    memberPublicId:
      firstString(value, ['public_id', 'member_public_id']) ??
      (() => {
        throw new TeamValidationError(
          'The team response is missing a member reference.'
        );
      })(),
    username: requiredString(value, 'username', 'a member username'),
    displayName: requiredString(value, 'display_name', 'a member display name'),
    avatarPath: optionalString(value, 'avatar_path'),
    role: parseRole(value.role),
    joinedAt: parseDate(
      value.accepted_at ?? value.joined_at,
      'member join date',
      true
    ),
    isCurrentUser: value.is_actor === true || value.is_current_user === true,
  };
}

function mapInvitation(
  value: unknown,
  fallbackBusinessId: string,
  fallbackBusinessName: string
): BusinessTeamInvitation {
  if (!isRecord(value)) {
    throw new TeamValidationError('The team response contains an invalid invitation.');
  }
  return {
    invitationId: requiredString(value, 'invitation_id', 'an invitation reference'),
    businessId: optionalString(value, 'business_id') ?? fallbackBusinessId,
    businessName: optionalString(value, 'business_name') ?? fallbackBusinessName,
    targetHint:
      firstString(value, ['target_hint', 'recipient_label']) ??
      'Private recipient',
    targetType:
      value.target_type === 'email' || value.target_type === 'username'
        ? value.target_type
        : null,
    role: parseAssignableRole(value.role),
    state: parseInvitationState(value.state ?? 'pending'),
    invitedAt: parseDate(
      value.invited_at ?? value.created_at,
      'invitation date'
    )!,
    expiresAt: parseDate(value.expires_at, 'invitation expiration', true),
    invitedByDisplayName: optionalString(value, 'invited_by_display_name'),
  };
}

function compareMembers(left: BusinessTeamMember, right: BusinessTeamMember) {
  const rank: Record<BusinessTeamRole, number> = { owner: 0, manager: 1, staff: 2 };
  if (rank[left.role] !== rank[right.role]) return rank[left.role] - rank[right.role];
  if (left.isCurrentUser !== right.isCurrentUser) return left.isCurrentUser ? -1 : 1;
  return left.displayName.localeCompare(right.displayName, undefined, {
    sensitivity: 'base',
  });
}

export function mapBusinessTeamWorkspace(value: unknown): BusinessTeamWorkspace {
  const payload = normalizedPayload(value);
  const businessId = requiredString(payload, 'business_id', 'the business reference');
  const businessName = requiredString(payload, 'business_name', 'the business name');
  const viewerRole = parseRole(payload.actor_role ?? payload.viewer_role);
  if (viewerRole !== 'owner' && viewerRole !== 'manager') {
    throw new TeamValidationError('Owner or manager access is required.');
  }
  if (!Array.isArray(payload.members) || !Array.isArray(payload.invitations)) {
    throw new TeamValidationError('The team response is incomplete.');
  }

  return {
    businessId,
    businessName,
    viewerRole,
    members: payload.members.map(mapMember).sort(compareMembers),
    invitations: payload.invitations
      .map((invitation) => mapInvitation(invitation, businessId, businessName))
      .sort(
        (left, right) =>
          new Date(right.invitedAt).getTime() - new Date(left.invitedAt).getTime()
      ),
  };
}

export function mapBusinessInvitations(value: unknown): BusinessTeamInvitation[] {
  const payload = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.invitations)
      ? value.invitations
      : null;
  if (!payload) {
    throw new TeamValidationError('Spottr received an invalid invitation response.');
  }
  return payload
    .map((invitation) => mapInvitation(invitation, '', 'Business'))
    .sort(
      (left, right) =>
        new Date(right.invitedAt).getTime() - new Date(left.invitedAt).getTime()
    );
}

export function capabilitiesForRole(role: 'owner' | 'manager'): TeamCapabilities {
  return role === 'owner'
    ? {
        canInviteManager: true,
        canInviteStaff: true,
        canChangeManagerRoles: true,
        canChangeStaffRoles: true,
        canRevokeManagers: true,
        canRevokeStaff: true,
        canTransferOwnership: true,
      }
    : {
        canInviteManager: false,
        canInviteStaff: true,
        canChangeManagerRoles: false,
        canChangeStaffRoles: false,
        canRevokeManagers: false,
        canRevokeStaff: true,
        canTransferOwnership: false,
      };
}

export function validateInviteTarget(value: string) {
  const normalized = value.normalize('NFKC').trim();
  if (!normalized) {
    throw new TeamValidationError('Enter an email address or Spottr username.');
  }
  if (normalized.includes('@') && !normalized.startsWith('@')) {
    const email = normalized.toLocaleLowerCase('en-US');
    if (email.length > 254 || !emailPattern.test(email)) {
      throw new TeamValidationError('Enter a complete email address.');
    }
    return { kind: 'email' as const, value: email };
  }

  const username = normalized.startsWith('@') ? normalized.slice(1) : normalized;
  const issue = validateUsername(username, []);
  if (issue) throw new TeamValidationError(issue);
  return { kind: 'username' as const, value: username };
}

export function createTeamIdempotencyKey(scope: 'invite' | 'transfer') {
  const cryptoApi = (
    globalThis as typeof globalThis & {
      crypto?: {
        getRandomValues?: <T extends ArrayBufferView | null>(array: T) => T;
        randomUUID?: () => string;
      };
    }
  ).crypto;
  const cryptoValue = cryptoApi?.randomUUID?.();
  let randomValue: string | undefined = cryptoValue;
  if (!randomValue && cryptoApi?.getRandomValues) {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    randomValue = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
      ''
    );
  }
  idempotencySequence = (idempotencySequence + 1) % Number.MAX_SAFE_INTEGER;
  const nonce =
    randomValue ??
    `${Date.now().toString(36)}-${idempotencySequence.toString(36)}-${Math.round(
      globalThis.performance?.now?.() ?? 0
    ).toString(36)}`;
  return `spottr-team:${scope}:${nonce}`;
}

function assertUuid(value: string, label: string) {
  if (!uuidPattern.test(value)) {
    throw new TeamValidationError(`${label} is invalid.`);
  }
}

function isNetworkError(error: unknown) {
  const message =
    error instanceof Error ? error.message.toLocaleLowerCase('en-US') : '';
  return (
    message.includes('network') ||
    message.includes('fetch') ||
    message.includes('offline')
  );
}

function failure<T>(error: unknown, fallback: string): BusinessTeamResult<T> {
  if (error instanceof TeamValidationError) {
    return { ok: false, code: 'INVALID', reason: error.message };
  }
  const candidate = error as
    | { code?: string; message?: string; status?: number }
    | null;
  const message = candidate?.message?.toLocaleLowerCase('en-US') ?? '';

  if (candidate?.code === 'CONFIG_REQUIRED') {
    return {
      ok: false,
      code: 'CONFIG_REQUIRED',
      reason: 'Connect Spottr live services before managing a team.',
    };
  }
  if (candidate?.status === 401 || message.includes('not authenticated')) {
    return {
      ok: false,
      code: 'AUTH_REQUIRED',
      reason: 'Sign in again to manage this team.',
    };
  }
  if (
    message.includes('aal2') ||
    message.includes('authenticator verification required')
  ) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      reason: 'Verify a current authenticator code in Security, then try again.',
    };
  }
  if (
    candidate?.status === 403 ||
    candidate?.code === '42501' ||
    message.includes('permission') ||
    message.includes('owner or manager')
  ) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      reason: 'Active owner or manager access is required.',
    };
  }
  if (
    candidate?.code === '23505' ||
    message.includes('already a member') ||
    message.includes('already invited') ||
    message.includes('last owner') ||
    message.includes('invitation_expired') ||
    message.includes('no longer pending')
  ) {
    return {
      ok: false,
      code: 'CONFLICT',
      reason: message.includes('last owner')
        ? 'Transfer ownership before removing the last owner.'
        : message.includes('invitation')
          ? 'That invitation has expired or was already answered. Refresh the list.'
        : 'That person is already a member or has a pending invitation.',
    };
  }
  if (message.includes('rate_limited') || candidate?.status === 429) {
    return {
      ok: false,
      code: 'RATE_LIMITED',
      reason:
        'Too many team changes were requested. Wait a moment before trying again.',
    };
  }
  if (
    candidate?.code === 'P0002' ||
    message.includes('not found') ||
    message.includes('no account')
  ) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      reason: 'That team record is no longer available. Refresh and try again.',
    };
  }
  if (
    candidate?.code === '22023' ||
    candidate?.code === '23514' ||
    message.includes('invalid')
  ) {
    return { ok: false, code: 'INVALID', reason: fallback };
  }
  if (candidate?.status === 0 || isNetworkError(error)) {
    return {
      ok: false,
      code: 'NETWORK',
      reason: 'Spottr could not connect. Check your connection and try again.',
    };
  }
  return { ok: false, code: 'UNKNOWN', reason: fallback };
}

async function secureClient(expectedUserId: string) {
  if (!isSupabaseConfigured || !supabase) {
    throw Object.assign(new Error('Live services are not configured.'), {
      code: 'CONFIG_REQUIRED',
    });
  }
  if (!expectedUserId || !uuidPattern.test(expectedUserId)) {
    throw Object.assign(new Error('The active account could not be verified.'), {
      status: 401,
    });
  }
  const client = await createAccountBoundSupabaseClient(expectedUserId);
  if (!client) {
    throw Object.assign(new Error('The active account changed.'), {
      status: 401,
    });
  }
  return client;
}

export async function loadBusinessTeam(
  businessId: string,
  expectedUserId: string
): Promise<BusinessTeamResult<BusinessTeamWorkspace>> {
  try {
    assertUuid(businessId, 'This business link');
    const client = await secureClient(expectedUserId);
    const { data, error } = await client.rpc('get_business_team', {
      target_business_id: businessId,
    });
    if (error) throw error;
    return { ok: true, data: mapBusinessTeamWorkspace(data) };
  } catch (error) {
    return failure(error, 'This team could not be loaded.');
  }
}

export async function loadMyBusinessInvitations(expectedUserId: string): Promise<
  BusinessTeamResult<BusinessTeamInvitation[]>
> {
  try {
    const client = await secureClient(expectedUserId);
    const { data, error } = await client.rpc('list_my_business_invitations');
    if (error) throw error;
    return { ok: true, data: mapBusinessInvitations(data) };
  } catch (error) {
    return failure(error, 'Your invitations could not be loaded.');
  }
}

export async function inviteBusinessTeamMember(
  input: {
    businessId: string;
    target: string;
    role: AssignableBusinessTeamRole;
    idempotencyKey: string;
  },
  expectedUserId: string
): Promise<BusinessTeamResult> {
  try {
    assertUuid(input.businessId, 'This business link');
    const recipient = validateInviteTarget(input.target);
    if (
      input.idempotencyKey.length < 16 ||
      input.idempotencyKey.length > 128
    ) {
      throw new TeamValidationError('This invitation request is invalid.');
    }
    const client = await secureClient(expectedUserId);
    const { error } = await client.rpc('invite_business_member', {
      target_business_id: input.businessId,
      invite_target: recipient.value,
      invite_role: input.role,
      idempotency_key: input.idempotencyKey,
    });
    if (error) throw error;
    return {
      ok: true,
      data: undefined,
      message:
        'Invitation recorded. For privacy, Spottr does not reveal whether an account matched.',
    };
  } catch (error) {
    return failure(error, 'This invitation could not be sent.');
  }
}

export async function respondToBusinessInvitation(
  input: {
    invitationId: string;
    decision: BusinessInvitationDecision;
  },
  expectedUserId: string
): Promise<BusinessTeamResult> {
  try {
    assertUuid(input.invitationId, 'This invitation');
    const client = await secureClient(expectedUserId);
    const { error } = await client.rpc('respond_business_invitation', {
      target_invitation_id: input.invitationId,
      decision: input.decision,
    });
    if (error) throw error;
    return {
      ok: true,
      data: undefined,
      message:
        input.decision === 'accept'
          ? 'Invitation accepted.'
          : 'Invitation declined.',
    };
  } catch (error) {
    return failure(error, 'This invitation could not be updated.');
  }
}

export async function changeBusinessMemberRole(
  input: {
    businessId: string;
    memberPublicId: string;
    role: AssignableBusinessTeamRole;
  },
  expectedUserId: string
): Promise<BusinessTeamResult> {
  try {
    assertUuid(input.businessId, 'This business link');
    assertUuid(input.memberPublicId, 'This member reference');
    const client = await secureClient(expectedUserId);
    const { error } = await client.rpc('set_business_member_role', {
      target_business_id: input.businessId,
      target_member_public_id: input.memberPublicId,
      next_role: input.role,
    });
    if (error) throw error;
    return {
      ok: true,
      data: undefined,
      message: 'Team role updated.',
    };
  } catch (error) {
    return failure(error, 'This role could not be updated.');
  }
}

export async function revokeBusinessTeamAccess(
  input: {
    businessId: string;
    memberPublicId: string;
  },
  expectedUserId: string
): Promise<BusinessTeamResult> {
  try {
    assertUuid(input.businessId, 'This business link');
    assertUuid(input.memberPublicId, 'This member reference');
    const client = await secureClient(expectedUserId);
    const { error } = await client.rpc('revoke_business_member', {
      target_business_id: input.businessId,
      target_member_public_id: input.memberPublicId,
    });
    if (error) throw error;
    return {
      ok: true,
      data: undefined,
      message: 'Team access removed.',
    };
  } catch (error) {
    return failure(error, 'This access change could not be completed.');
  }
}

export async function revokeBusinessTeamInvitation(
  input: {
    businessId: string;
    invitationId: string;
  },
  expectedUserId: string
): Promise<BusinessTeamResult> {
  try {
    assertUuid(input.businessId, 'This business link');
    assertUuid(input.invitationId, 'This invitation');
    const client = await secureClient(expectedUserId);
    const { error } = await client.rpc('revoke_business_invitation', {
      target_business_id: input.businessId,
      target_invitation_id: input.invitationId,
    });
    if (error) throw error;
    return {
      ok: true,
      data: undefined,
      message: 'Pending invitation cancelled.',
    };
  } catch (error) {
    return failure(error, 'This invitation could not be cancelled.');
  }
}

export async function transferBusinessOwnership(
  input: {
    businessId: string;
    memberPublicId: string;
    idempotencyKey: string;
  },
  expectedUserId: string
): Promise<BusinessTeamResult> {
  try {
    assertUuid(input.businessId, 'This business link');
    assertUuid(input.memberPublicId, 'This member reference');
    if (
      input.idempotencyKey.length < 16 ||
      input.idempotencyKey.length > 128
    ) {
      throw new TeamValidationError('This ownership request is invalid.');
    }
    const client = await secureClient(expectedUserId);
    const { error } = await client.rpc('transfer_business_ownership', {
      target_business_id: input.businessId,
      target_member_public_id: input.memberPublicId,
      idempotency_key: input.idempotencyKey,
    });
    if (error) throw error;
    return {
      ok: true,
      data: undefined,
      message: 'Ownership transferred. Your role is now manager.',
    };
  } catch (error) {
    return failure(error, 'Ownership could not be transferred.');
  }
}
