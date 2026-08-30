import { mapBusinessPickupOrderingPreferences } from '../business-pickup-ordering';

const businessId = '74c00da5-6f88-46a7-a28b-704029a7cfa5';

function response() {
  return {
    business_id: businessId,
    eligible_kind: true,
    merchant_opted_in: true,
    accepted_payment_options: ['pay_in_person'],
    customer_ordering_enabled: false,
    online_payment_processing_enabled: false,
    listing_state: 'published',
    verification_state: 'verified',
    payment_options: [
      {
        kind: 'pay_in_person',
        label: 'Pay in person',
        configuration_allowed: true,
        charge_enabled: false,
        unavailable_reason: null,
      },
      {
        kind: 'card',
        label: 'Card in Spottr',
        configuration_allowed: false,
        charge_enabled: false,
        unavailable_reason: 'Provider and compliance controls are not approved.',
      },
      {
        kind: 'apple_pay',
        label: 'Apple Pay in Spottr',
        configuration_allowed: false,
        charge_enabled: false,
        unavailable_reason: 'Provider and compliance controls are not approved.',
      },
    ],
  };
}

describe('business pickup-ordering launch contract', () => {
  it('maps the merchant opt-in while keeping customer ordering and charging off', () => {
    const preferences = mapBusinessPickupOrderingPreferences(response());

    expect(preferences).toMatchObject({
      businessId,
      eligibleKind: true,
      merchantOptedIn: true,
      acceptedPaymentOptions: ['pay_in_person'],
      customerOrderingEnabled: false,
      onlinePaymentProcessingEnabled: false,
    });
    expect(preferences.paymentOptions.map((option) => option.kind)).toEqual([
      'pay_in_person',
      'card',
      'apple_pay',
    ]);
    expect(preferences.paymentOptions.every((option) => !option.chargeEnabled)).toBe(true);
    expect(Object.isFrozen(preferences)).toBe(true);
    expect(Object.isFrozen(preferences.paymentOptions)).toBe(true);
  });

  it('rejects any server response that turns on ordering or a charge rail', () => {
    expect(() =>
      mapBusinessPickupOrderingPreferences({
        ...response(),
        customer_ordering_enabled: true,
      })
    ).toThrow('unavailable launch capability');

    expect(() =>
      mapBusinessPickupOrderingPreferences({
        ...response(),
        payment_options: response().payment_options.map((option) =>
          option.kind === 'card' ? { ...option, charge_enabled: true } : option
        ),
      })
    ).toThrow('not launch-enabled');
  });

  it('rejects online methods in the accepted launch selection', () => {
    expect(() =>
      mapBusinessPickupOrderingPreferences({
        ...response(),
        accepted_payment_options: ['pay_in_person', 'card'],
      })
    ).toThrow('exceeded the launch slice');

    expect(() =>
      mapBusinessPickupOrderingPreferences({
        ...response(),
        eligible_kind: false,
      })
    ).toThrow('ineligible category');
  });

  it('requires the complete, ordered, disabled capability disclosure', () => {
    expect(() =>
      mapBusinessPickupOrderingPreferences({
        ...response(),
        payment_options: response().payment_options.slice().reverse(),
      })
    ).toThrow('capability order');

    expect(() =>
      mapBusinessPickupOrderingPreferences({
        ...response(),
        payment_options: response().payment_options.map((option) =>
          option.kind === 'apple_pay'
            ? { ...option, configuration_allowed: true }
            : option
        ),
      })
    ).toThrow('capability was inconsistent');
  });
});
