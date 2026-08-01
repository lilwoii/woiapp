import { phoneHref, safeHttpsUrl } from '@/lib/links';

describe('external contact links', () => {
  it('accepts HTTPS without embedded credentials', () => {
    expect(safeHttpsUrl('https://example.com/menu')).toBe('https://example.com/menu');
    expect(safeHttpsUrl('http://example.com')).toBeNull();
    expect(safeHttpsUrl('https://user:secret@example.com')).toBeNull();
    expect(safeHttpsUrl('javascript:alert(1)')).toBeNull();
  });

  it('normalizes callable phone links and rejects invalid lengths', () => {
    expect(phoneHref('+1 (323) 555-0199')).toBe('tel:+13235550199');
    expect(phoneHref('555')).toBeNull();
    expect(phoneHref('1'.repeat(16))).toBeNull();
  });
});
