import {
  BUSINESS_RESPONSE_MAX_LENGTH,
  createBusinessResponseIdempotencyKey,
  mapBusinessResponseRecord,
  normalizeBusinessResponseBody,
  prepareBusinessResponseAttempt,
} from '../business-responses';

const reviewId = '53e70e98-ac80-4978-a7d2-4a1284c29f7b';
const businessId = '74c00da5-6f88-46a7-a28b-704029a7cfa5';

describe('business review responses', () => {
  it('normalizes whitespace and enforces the exact server body limit', () => {
    expect(normalizeBusinessResponseBody('  Thank you   for visiting. ')).toBe(
      'Thank you for visiting.'
    );
    expect(normalizeBusinessResponseBody('a'.repeat(BUSINESS_RESPONSE_MAX_LENGTH))).toHaveLength(
      1000
    );
    expect(() =>
      normalizeBusinessResponseBody('a'.repeat(BUSINESS_RESPONSE_MAX_LENGTH + 1))
    ).toThrow('1000 characters or fewer');
  });

  it('retains the same idempotency key for an unchanged ambiguous retry', () => {
    const first = prepareBusinessResponseAttempt(
      undefined,
      reviewId,
      'Thanks for the thoughtful feedback.'
    );
    const retry = prepareBusinessResponseAttempt(
      first,
      reviewId,
      '  Thanks for the thoughtful   feedback. '
    );
    const revision = prepareBusinessResponseAttempt(
      first,
      reviewId,
      'Thanks for the thoughtful feedback. We shared this with our team.'
    );

    expect(retry).toBe(first);
    expect(revision.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('creates bounded server-compatible idempotency keys', () => {
    const first = createBusinessResponseIdempotencyKey();
    const second = createBusinessResponseIdempotencyKey();

    expect(first).toMatch(/^spottr-response:/);
    expect(first.length).toBeGreaterThanOrEqual(16);
    expect(first.length).toBeLessThanOrEqual(128);
    expect(first).not.toMatch(/\s/);
    expect(second).not.toBe(first);
  });

  it('maps only the public response contract and rejects malformed records', () => {
    const mapped = mapBusinessResponseRecord({
      review_id: reviewId,
      business_id: businessId,
      body: 'Thank you for stopping by.',
      moderation_state: 'pending',
      created_at: '2026-07-30T12:00:00.000Z',
      updated_at: '2026-07-30T12:00:00.000Z',
      author_id: 'private-auth-id-must-not-leak',
    });

    expect(mapped).toEqual({
      reviewId,
      businessId,
      body: 'Thank you for stopping by.',
      moderationState: 'pending',
      createdAt: '2026-07-30T12:00:00.000Z',
      updatedAt: '2026-07-30T12:00:00.000Z',
    });
    expect(mapped).not.toHaveProperty('authorId');
    expect(() =>
      mapBusinessResponseRecord({
        review_id: reviewId,
        business_id: businessId,
        body: 'Hello',
        moderation_state: 'unknown',
        created_at: '2026-07-30T12:00:00.000Z',
        updated_at: '2026-07-30T12:00:00.000Z',
      })
    ).toThrow('invalid record');
  });
});
