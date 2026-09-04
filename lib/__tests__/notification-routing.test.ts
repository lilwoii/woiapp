import { parseNotificationRoute } from '../notification-routing';

describe('notification routing', () => {
  it('accepts only canonical lowercase public place routes', () => {
    expect(parseNotificationRoute('/place/123e4567-e89b-42d3-a456-426614174000'))
      .toBe('/place/123e4567-e89b-42d3-a456-426614174000');
    expect(parseNotificationRoute('/profile/123e4567-e89b-42d3-a456-426614174000')).toBeNull();
    expect(parseNotificationRoute('/place/123E4567-E89B-42D3-A456-426614174000')).toBeNull();
    expect(parseNotificationRoute('/place/123e4567-e89b-42d3-a456-426614174000?admin=true')).toBeNull();
    expect(parseNotificationRoute('https://evil.example/place/123e4567-e89b-42d3-a456-426614174000')).toBeNull();
  });

  it('rejects malformed and non-string payloads', () => {
    expect(parseNotificationRoute('/place/not-a-uuid')).toBeNull();
    expect(parseNotificationRoute(null)).toBeNull();
    expect(parseNotificationRoute({ route: '/place/123e4567-e89b-42d3-a456-426614174000' })).toBeNull();
  });
});
