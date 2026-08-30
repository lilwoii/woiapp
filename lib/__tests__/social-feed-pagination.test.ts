import { parseFollowedFeedPage } from '@/lib/social-feed';

function row(id: string, hasMore = true) {
  return {
    feed_type: 'business_post',
    content_id: id,
    business_id: '70000000-0000-4000-8000-000000000007',
    created_at: '2026-08-29T12:00:00.000Z',
    has_more: hasMore,
  };
}

describe('followed feed page parsing', () => {
  it('derives the next cursor from the final fully validated row', () => {
    const parsed = parseFollowedFeedPage([
      row('75400000-0000-4000-8000-000000000007'),
      row('75500000-0000-4000-8000-000000000007'),
    ]);

    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextCursor).toEqual({
      createdAt: '2026-08-29T12:00:00.000Z',
      feedType: 'business_post',
      contentId: '75500000-0000-4000-8000-000000000007',
    });
  });

  it('rejects a malformed middle row before hydration', () => {
    expect(() => parseFollowedFeedPage([
      row('75400000-0000-4000-8000-000000000007'),
      { ...row('75500000-0000-4000-8000-000000000007'), content_id: 'not-a-uuid' },
      row('75600000-0000-4000-8000-000000000007'),
    ])).toThrow('INVALID_FEED_PAGE');
  });

  it('rejects inconsistent lookahead metadata', () => {
    expect(() => parseFollowedFeedPage([
      row('75400000-0000-4000-8000-000000000007', true),
      row('75500000-0000-4000-8000-000000000007', false),
    ])).toThrow('INVALID_FEED_PAGE');
  });
});
