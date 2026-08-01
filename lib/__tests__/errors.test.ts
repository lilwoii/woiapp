import { requireConfigured, toActionError } from '@/lib/errors';

describe('safe error mapping', () => {
  it.each([
    [{ status: 0 }, 'NETWORK'],
    [{ code: '23505' }, 'CONFLICT'],
    [{ status: 401 }, 'AUTH_REQUIRED'],
    [{ status: 429 }, 'UNKNOWN'],
  ])('maps expected service errors without exposing internals', (error, code) => {
    const result = toActionError(error, 'Fallback');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(code);
      expect(result.reason).not.toContain('23505');
    }
  });

  it('falls back to a user-safe message', () => {
    expect(toActionError(new Error('database exploded'), 'Please retry.')).toEqual({
      ok: false,
      code: 'UNKNOWN',
      reason: 'Please retry.',
    });
  });

  it('requires live configuration when unavailable', () => {
    expect(requireConfigured(true)).toBeNull();
    expect(requireConfigured(false)?.ok).toBe(false);
  });
});
