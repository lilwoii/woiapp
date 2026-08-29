import {
  parseAuthIdentityQuarantine,
  serializeAuthIdentityQuarantine,
} from '../auth-identity-quarantine';

const USER_ID = 'c253bce2-87c1-4ad7-a7be-72a0ba237b8f';

describe('native identity quarantine marker', () => {
  it('round-trips a valid non-secret user identifier', () => {
    const stored = serializeAuthIdentityQuarantine(USER_ID);
    expect(stored).toBe(`v1:${USER_ID}`);
    expect(parseAuthIdentityQuarantine(stored)).toEqual({
      status: 'quarantined',
      userId: USER_ID,
    });
  });

  it('treats an absent marker as clear', () => {
    expect(parseAuthIdentityQuarantine(null)).toEqual({ status: 'clear' });
  });

  it.each(['user-b', 'v2:c253bce2-87c1-4ad7-a7be-72a0ba237b8f', 'v1:not-a-uuid'])(
    'fails closed for malformed marker %s',
    (stored) => {
      expect(parseAuthIdentityQuarantine(stored)).toEqual({ status: 'unavailable' });
    }
  );

  it('refuses to serialize an invalid identity', () => {
    expect(serializeAuthIdentityQuarantine('not-a-user-id')).toBeNull();
  });
});
