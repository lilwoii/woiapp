import { createMarketplaceIdempotencyKey } from '@/lib/marketplace-api';

describe('marketplace idempotency keys', () => {
  it('creates bounded action-scoped unique keys accepted by the backend', () => {
    const keys = Array.from({ length: 50 }, () =>
      createMarketplaceIdempotencyKey('review')
    );

    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key).toMatch(/^spottr:review:[A-Za-z0-9._:-]+$/);
      expect(key.length).toBeGreaterThanOrEqual(16);
      expect(key.length).toBeLessThanOrEqual(128);
    }
  });
});
