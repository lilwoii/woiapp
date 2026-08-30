import { phoneHref, safeHttpsUrl, safePublicHttpsUrl } from '@/lib/links';

describe('external contact links', () => {
  it('accepts HTTPS without embedded credentials', () => {
    expect(safeHttpsUrl('https://example.com/menu')).toBe('https://example.com/menu');
    expect(safeHttpsUrl('http://example.com')).toBeNull();
    expect(safeHttpsUrl('https://user:secret@example.com')).toBeNull();
    expect(safeHttpsUrl('javascript:alert(1)')).toBeNull();
  });

  it('allows only public DNS HTTPS destinations for user-published links', () => {
    expect(safePublicHttpsUrl(' https://Food.Example.com/menu ')).toBe(
      'https://food.example.com/menu',
    );
    for (const value of [
      'http://example.com',
      'https://user@example.com',
      'https://localhost',
      'https://localhost.',
      'https://kitchen.local/menu',
      'https://kitchen.internal/menu',
      'https://intranet/menu',
      'https://127.0.0.1/menu',
      'https://10.0.0.1/menu',
      'https://0x7f.0x0.0x0.0x1/menu',
      'https://[::1]/menu',
      'https://example.com:8443/menu',
      'https://example.com./menu',
      'https://café.fr/menu',
    ]) {
      expect(safePublicHttpsUrl(value)).toBeNull();
    }
  });

  it('normalizes callable phone links and rejects invalid lengths', () => {
    expect(phoneHref('+1 (323) 555-0199')).toBe('tel:+13235550199');
    expect(phoneHref('555')).toBeNull();
    expect(phoneHref('1'.repeat(16))).toBeNull();
  });
});
