import { isReportedReview, mapModerationQueuePage } from '../content-moderation';

const targetId = 'a418d851-2f2a-4ed8-8df8-52a1293c6211';
const businessId = 'cf844b56-696c-48cf-9f72-715d823776f3';

describe('content moderation queue contracts', () => {
  it('maps only public operator-safe fields and pagination state', () => {
    const page = mapModerationQueuePage([
      {
        target_type: 'review',
        target_id: targetId,
        business_id: businessId,
        business_name: 'Copper Coyote',
        author_public_id: null,
        author_display_name: null,
        body: 'Carefully written review.',
        rating: 5,
        context: { media_count: 0, all_media_clean: true },
        submitted_at: '2026-08-01T10:00:00.000Z',
        updated_at: '2026-08-01T10:00:00.000Z',
        has_more: true,
        author_id: 'private-auth-id',
      },
    ], 30);
    expect(page).toMatchObject({ hasMore: true, nextOffset: 31 });
    expect(page.items[0]).toMatchObject({ authorDisplayName: 'Deleted account', rating: 5 });
    expect(page.items[0]).not.toHaveProperty('authorId');
  });

  it('rejects malformed identifiers, dates, target types, and ratings', () => {
    const valid = {
      target_type: 'review',
      target_id: targetId,
      business_id: businessId,
      business_name: 'Copper Coyote',
      author_public_id: null,
      author_display_name: 'Member',
      body: 'Review',
      rating: 5,
      context: {},
      submitted_at: '2026-08-01T10:00:00.000Z',
      updated_at: '2026-08-01T10:00:00.000Z',
      has_more: false,
    };
    expect(() => mapModerationQueuePage([{ ...valid, target_id: 'bad' }])).toThrow();
    expect(() => mapModerationQueuePage([{ ...valid, target_type: 'listing' }])).toThrow();
    expect(() => mapModerationQueuePage([{ ...valid, rating: 6 }])).toThrow();
    expect(() => mapModerationQueuePage([{ ...valid, updated_at: 'never' }])).toThrow();
  });

  it('accepts reported business posts in the shared moderation queue', () => {
    const page = mapModerationQueuePage([{
      target_type: 'business_post',
      target_id: targetId,
      business_id: businessId,
      business_name: 'Copper Coyote',
      author_public_id: null,
      author_display_name: 'Owner',
      body: '[Photo post]',
      rating: null,
      context: { report_count: 2 },
      submitted_at: '2026-08-01T10:00:00.000Z',
      updated_at: '2026-08-01T10:00:00.000Z',
      has_more: false,
    }]);
    expect(page.items[0]?.targetType).toBe('business_post');
  });

  it('distinguishes an approved reported review from a pending review', () => {
    const page = mapModerationQueuePage([{
      target_type: 'review',
      target_id: targetId,
      business_id: businessId,
      business_name: 'Copper Coyote',
      author_public_id: null,
      author_display_name: 'Member',
      body: 'A previously approved review.',
      rating: 4,
      context: { reported: true, report_count: 2, report_reasons: ['spam'] },
      submitted_at: '2026-08-01T10:00:00.000Z',
      updated_at: '2026-08-01T10:00:00.000Z',
      has_more: false,
    }]);

    expect(isReportedReview(page.items[0]!)).toBe(true);
    expect(isReportedReview({ ...page.items[0]!, context: {} })).toBe(false);
  });
});
