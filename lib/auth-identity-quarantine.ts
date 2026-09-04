export type AuthIdentityQuarantineRead =
  | { status: 'clear' }
  | { status: 'quarantined'; userId: string }
  | { status: 'unavailable' };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseAuthIdentityQuarantine(
  stored: string | null
): AuthIdentityQuarantineRead {
  if (!stored) return { status: 'clear' };
  const value = stored.startsWith('v1:') ? stored.slice(3) : '';
  return UUID_PATTERN.test(value)
    ? { status: 'quarantined', userId: value }
    : { status: 'unavailable' };
}

export function serializeAuthIdentityQuarantine(userId: string): string | null {
  const normalized = userId.trim();
  return UUID_PATTERN.test(normalized) ? `v1:${normalized}` : null;
}
