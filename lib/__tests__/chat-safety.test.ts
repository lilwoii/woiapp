import { chatSafetyIssue, chatSafetyMessage } from '@/lib/chat-safety';

describe('marketplace chat safety preflight', () => {
  it.each([
    'My address is 100 Main Street',
    'Meet at 100 Main Street',
    'Coordinates: 34.05220, -118.24370',
  ])('blocks high-confidence precise locations: %s', (value) => {
    expect(chatSafetyIssue(value)).toBe('precise_location');
  });

  it.each([
    'Card number 4111 1111 1111 1111',
    'CVV: 123',
    'My SSN is 123-45-6789',
  ])('blocks sensitive financial or identity numbers: %s', (value) => {
    expect(chatSafetyIssue(value)).toBe('sensitive_payment');
  });

  it('allows ordinary order coordination', () => {
    expect(chatSafetyIssue('Two plates, please. I can meet near the public pickup spot at 6.')).toBeNull();
  });

  it('provides a recovery action instead of a generic rejection', () => {
    expect(chatSafetyMessage('precise_location')).toContain('pickup-location');
    expect(chatSafetyMessage('sensitive_payment')).toContain('payment credentials');
  });
});
