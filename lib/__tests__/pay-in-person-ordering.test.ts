import {
  mapPayInPersonPickupMenu,
  mapPickupOrderReceipt,
} from '../pay-in-person-ordering';

const businessId = '74c00da5-6f88-46a7-a28b-704029a7cfa5';
const locationId = '20b409cf-4547-41da-a0fe-7db03de7c40f';
const itemId = '34d69e96-36ec-4937-8543-2644222f5a0a';

function menu() {
  return {
    business_id: businessId,
    business_name: 'Cedar & Salt',
    customer_ordering_enabled: true,
    payment_method: 'pay_in_person',
    payment_label: 'Pay in person',
    minimum_lead_minutes: 20,
    maximum_advance_minutes: 10080,
    terms_version: 'pickup-pay-in-person-v1',
    locations: [{
      id: locationId,
      label: 'Main counter',
      address: '12 Market Street',
      city: 'San Francisco',
      region: 'CA',
      postal_code: '94105',
    }],
    sections: [{
      id: 'df99ea83-348d-4573-961c-c0be79a00e47',
      name: 'Lunch',
      items: [{
        id: itemId,
        name: 'Market bowl',
        description: 'Seasonal vegetables and grains.',
        price_minor: 1450,
        currency: 'USD',
        dietary_tags: ['vegan'],
        allergen_note: null,
      }],
    }],
  };
}

function receipt() {
  return {
    order_public_id: '8c67c070-580a-4702-b29a-361fc344bc73',
    business_id: businessId,
    business_name: 'Cedar & Salt',
    location_id: locationId,
    state: 'pending_acceptance',
    payment_method: 'pay_in_person',
    payment_state: 'due_at_pickup',
    currency: 'USD',
    item_subtotal_minor: 2900,
    requested_pickup_at: '2026-10-24T20:30:00.000Z',
    acceptance_expires_at: '2026-10-24T20:10:00.000Z',
    customer_note: null,
    terms_version: 'pickup-pay-in-person-v1',
    version: 1,
    created_at: '2026-10-24T20:00:00.000Z',
    updated_at: '2026-10-24T20:00:00.000Z',
    lines: [{
      menu_item_id: itemId,
      name: 'Market bowl',
      quantity: 2,
      unit_price_minor: 1450,
      line_subtotal_minor: 2900,
      allergen_note: null,
    }],
  };
}

describe('pay-in-person pickup contracts', () => {
  it('maps a server-enabled menu without exposing a payment rail', () => {
    const mapped = mapPayInPersonPickupMenu(menu());
    expect(mapped.paymentMethod).toBe('pay_in_person');
    expect(mapped.sections[0].items[0].priceMinor).toBe(1450);
    expect(Object.isFrozen(mapped)).toBe(true);
  });

  it('rejects a menu unless the protected runtime enabled ordering', () => {
    expect(() => mapPayInPersonPickupMenu({
      ...menu(),
      customer_ordering_enabled: false,
    })).toThrow('not explicitly enabled');
  });

  it('maps a bound due-at-pickup receipt', () => {
    const mapped = mapPickupOrderReceipt(receipt());
    expect(mapped.paymentState).toBe('due_at_pickup');
    expect(mapped.lines).toHaveLength(1);
  });

  it('rejects simulated online payment and invalid acceptance windows', () => {
    expect(() => mapPickupOrderReceipt({ ...receipt(), payment_state: 'paid' })).toThrow('state was invalid');
    expect(() => mapPickupOrderReceipt({
      ...receipt(),
      acceptance_expires_at: '2026-10-24T20:40:00.000Z',
    })).toThrow('acceptance window was invalid');
  });
});
