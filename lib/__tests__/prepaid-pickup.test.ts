import {
  createPrepaidCheckoutIdempotencyKey,
  mapMerchantPaymentStatus,
  mapPrepaidCheckout,
  mapPrepaidCheckoutStatus,
} from '@/lib/prepaid-pickup';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('prepaid pickup boundary mapping', () => {
  it('creates bounded server-compatible checkout retry keys', () => {
    expect(createPrepaidCheckoutIdempotencyKey()).toMatch(/^[A-Za-z0-9._:-]{16,128}$/);
  });

  it('accepts only Stripe-hosted unexpired checkout URLs', () => {
    const value = mapPrepaidCheckout({
      checkoutPublicId: id,
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_safe_value',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(value.checkoutPublicId).toBe(id);
    for (const checkoutUrl of [
      'http://checkout.stripe.com/c/pay/test',
      'https://checkout.stripe.com.evil.example/c/pay/test',
      ['https://', 'user:', 'secret@', 'checkout.stripe.com/c/pay/test'].join(''),
    ]) {
      expect(() => mapPrepaidCheckout({
        checkoutPublicId: id,
        checkoutUrl,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })).toThrow();
    }
  });

  it('rejects inconsistent merchant payment readiness', () => {
    const ready = {
      business_id: id,
      onboarding_started: true,
      country: 'US',
      default_currency: 'USD',
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
      accept_prepaid: true,
      requirements_due_count: 0,
      updated_at: '2026-09-04T00:00:00.000Z',
    };
    expect(mapMerchantPaymentStatus(ready).acceptPrepaid).toBe(true);
    expect(() => mapMerchantPaymentStatus({ ...ready, payouts_enabled: false })).toThrow();
  });

  it('requires a completed checkout to carry an order projection', () => {
    const base = {
      checkout_public_id: id,
      state: 'open',
      order: null,
      expires_at: '2026-09-05T00:00:00.000Z',
      updated_at: '2026-09-04T00:00:00.000Z',
    };
    expect(mapPrepaidCheckoutStatus(base).state).toBe('open');
    expect(() => mapPrepaidCheckoutStatus({ ...base, state: 'completed' })).toThrow();
    expect(mapPrepaidCheckoutStatus({ ...base, state: 'completed', order: { order_public_id: id } }).state).toBe('completed');
  });
});
