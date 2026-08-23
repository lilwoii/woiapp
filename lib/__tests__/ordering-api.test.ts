import {
  mapCancelledShadowOrderReceipt,
  mapPlacedShadowOrderReceipt,
  mapShadowOrderQuote,
  mapShadowOrderReceipt,
  mapShadowOrderableMenu,
  orderingFailure,
  prepareShadowCancellationAttempt,
  prepareShadowPlacementAttempt,
  prepareShadowQuoteAttempt,
} from '../ordering-api';

const ids = {
  business: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  capacity: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  catalog: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  group: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  item: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  location: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  option: '11111111-1111-4111-8111-111111111111',
  order: '22222222-2222-4222-8222-222222222222',
  quote: '33333333-3333-4333-8333-333333333333',
  stableItem: '44444444-4444-4444-8444-444444444444',
};

const pickupStartsAt = '2026-09-01T19:00:00.000Z';
const pickupEndsAt = '2026-09-01T19:15:00.000Z';

function menuResponse() {
  return {
    business_id: ids.business,
    catalog_version_id: ids.catalog,
    catalog_version: 7,
    currency: 'USD',
    acceptance_mode: 'manual',
    acceptance_timeout_seconds: 180,
    terms_version: 'pilot-terms-v1',
    refund_policy_version: 'pilot-refund-v1',
    quote_ttl_seconds: 300,
    public_ordering_enabled: false,
    payment_enabled: false,
    items: [
      {
        item_version_id: ids.item,
        stable_item_id: ids.stableItem,
        name: 'Citrus taco',
        description: 'Charred citrus, greens, and salsa.',
        unit_price_minor: 1200,
        maximum_quantity: 10,
        allergen_note: 'Prepared in a shared kitchen.',
        sort_order: 0,
        option_groups: [
          {
            option_group_id: ids.group,
            name: 'Heat',
            minimum_selections: 1,
            maximum_selections: 1,
            sort_order: 0,
            options: [
              {
                option_version_id: ids.option,
                name: 'Medium',
                price_delta_minor: 100,
                sort_order: 0,
              },
            ],
          },
        ],
      },
    ],
    pickup_windows: [
      {
        capacity_slot_id: ids.capacity,
        location_id: ids.location,
        mobile_stop_id: null,
        starts_at: pickupStartsAt,
        ends_at: pickupEndsAt,
        remaining_capacity: 4,
      },
    ],
  };
}

function quoteResponse() {
  return {
    quote_public_id: ids.quote,
    quote_version: 1,
    business_id: ids.business,
    location_id: ids.location,
    mobile_stop_id: null,
    capacity_slot_id: ids.capacity,
    catalog_version_id: ids.catalog,
    currency: 'USD',
    item_subtotal_minor: 2600,
    shadow_discount_minor: 2600,
    tax_minor: 0,
    tip_minor: 0,
    fee_minor: 0,
    total_minor: 0,
    payment_state: 'not_required',
    pickup_starts_at: pickupStartsAt,
    pickup_ends_at: pickupEndsAt,
    expires_at: '2026-09-01T18:55:00.000Z',
    terms_version: 'pilot-terms-v1',
    refund_policy_version: 'pilot-refund-v1',
    acceptance_mode: 'manual',
    is_shadow: true,
    lines: [
      {
        item_version_id: ids.item,
        name: 'Citrus taco',
        quantity: 2,
        base_unit_price_minor: 1200,
        unit_price_minor: 1200,
        option_unit_total_minor: 100,
        unit_total_minor: 1300,
        line_subtotal_minor: 2600,
        allergen_note: 'Prepared in a shared kitchen.',
        options: [
          {
            option_version_id: ids.option,
            name: 'Medium',
            option_name: 'Medium',
            price_delta_minor: 100,
          },
        ],
      },
    ],
  };
}

function receiptResponse(overrides: Record<string, unknown> = {}) {
  return {
    quote_public_id: ids.quote,
    quote_version: 1,
    order_public_id: ids.order,
    version: 1,
    fulfillment_state: 'pending_acceptance',
    payment_state: 'not_required',
    is_shadow: true,
    business_id: ids.business,
    location_id: ids.location,
    mobile_stop_id: null,
    acceptance_mode: 'manual',
    item_subtotal_minor: 2600,
    shadow_discount_minor: 2600,
    tax_minor: 0,
    tip_minor: 0,
    fee_minor: 0,
    total_minor: 0,
    currency: 'USD',
    pickup_starts_at: pickupStartsAt,
    pickup_ends_at: pickupEndsAt,
    acceptance_expires_at: '2026-09-01T18:58:00.000Z',
    terms_version: 'pilot-terms-v1',
    refund_policy_version: 'pilot-refund-v1',
    lines: quoteResponse().lines,
    ...overrides,
  };
}

describe('shadow ordering API contracts', () => {
  it('maps a bounded server menu without trusting discovery prices', () => {
    const menu = mapShadowOrderableMenu(menuResponse());
    expect(menu.businessId).toBe(ids.business);
    expect(menu.items[0].unitPriceMinor).toBe(1200);
    expect(menu.items[0].optionGroups[0].minimumSelections).toBe(1);
    expect(menu.pickupWindows[0].remainingCapacity).toBe(4);
    expect(menu.acceptanceTimeoutSeconds).toBe(180);
    expect(Object.isFrozen(menu)).toBe(true);
  });

  it('clamps sold-out option maxima, omits empty optional groups, and rejects impossible minima', () => {
    const reduced = menuResponse();
    reduced.items[0].option_groups[0].maximum_selections = 2;
    expect(mapShadowOrderableMenu(reduced).items[0].optionGroups[0].maximumSelections).toBe(1);

    const optionalEmpty = menuResponse();
    optionalEmpty.items[0].option_groups[0].minimum_selections = 0;
    optionalEmpty.items[0].option_groups[0].options = [];
    expect(mapShadowOrderableMenu(optionalEmpty).items[0].optionGroups).toHaveLength(0);

    const impossible = menuResponse();
    impossible.items[0].option_groups[0].minimum_selections = 2;
    impossible.items[0].option_groups[0].maximum_selections = 2;
    expect(() => mapShadowOrderableMenu(impossible)).toThrow('invalid option requirements');

    const duplicate = menuResponse();
    duplicate.items.push({ ...duplicate.items[0] });
    expect(() => mapShadowOrderableMenu(duplicate)).toThrow('duplicate menu items');

    expect(() =>
      mapShadowOrderableMenu({ ...menuResponse(), payment_enabled: true })
    ).toThrow('zero-money staff pilot');
    expect(() =>
      mapShadowOrderableMenu({ ...menuResponse(), acceptance_mode: 'automatic' })
    ).toThrow('manual merchant acceptance');
  });

  it('accepts only internally consistent zero-money quote snapshots', () => {
    const quote = mapShadowOrderQuote(quoteResponse());
    expect(quote.itemSubtotalMinor).toBe(2600);
    expect(quote.shadowDiscountMinor).toBe(2600);
    expect(quote.totalMinor).toBe(0);

    expect(() => mapShadowOrderQuote({ ...quoteResponse(), total_minor: 1 })).toThrow(
      'invalid total_minor'
    );
    expect(() =>
      mapShadowOrderQuote({
        ...quoteResponse(),
        lines: [{ ...quoteResponse().lines[0], unit_total_minor: 1200 }],
      })
    ).toThrow('totals are inconsistent');
    expect(() =>
      mapShadowOrderQuote({
        ...quoteResponse(),
        lines: [{ ...quoteResponse().lines[0], unit_price_minor: 1199 }],
      })
    ).toThrow('totals are inconsistent');
    expect(() =>
      mapShadowOrderQuote({
        ...quoteResponse(),
        lines: [{
          ...quoteResponse().lines[0],
          options: [{ ...quoteResponse().lines[0].options[0], option_name: 'Mild' }],
        }],
      })
    ).toThrow('aliases are inconsistent');
  });

  it('rejects any receipt that could represent a charge', () => {
    const response = receiptResponse();
    expect(mapShadowOrderReceipt(response).paymentState).toBe('not_required');
    expect(() => mapShadowOrderReceipt({ ...response, payment_state: 'captured' })).toThrow(
      'zero-money pilot contract'
    );
  });

  it('requires action-specific placement and cancellation receipt states', () => {
    expect(
      mapPlacedShadowOrderReceipt(receiptResponse(), {
        businessId: ids.business,
        quotePublicId: ids.quote,
        quoteVersion: 1,
      }).fulfillmentState
    ).toBe('pending_acceptance');
    expect(() =>
      mapPlacedShadowOrderReceipt(receiptResponse({ fulfillment_state: 'accepted' }), {
        businessId: ids.business,
        quotePublicId: ids.quote,
        quoteVersion: 1,
      })
    ).toThrow('not bound');
    expect(() =>
      mapPlacedShadowOrderReceipt(receiptResponse({ business_id: ids.capacity }), {
        businessId: ids.business,
        quotePublicId: ids.quote,
        quoteVersion: 1,
      })
    ).toThrow('not bound');

    expect(
      mapCancelledShadowOrderReceipt(
        receiptResponse({ fulfillment_state: 'cancelled', version: 2 }),
        { businessId: ids.business, orderPublicId: ids.order, expectedVersion: 1 }
      ).fulfillmentState
    ).toBe('cancelled');
    expect(() =>
      mapCancelledShadowOrderReceipt(
        receiptResponse({ fulfillment_state: 'cancelled', version: 3 }),
        { businessId: ids.business, orderPublicId: ids.order, expectedVersion: 1 }
      )
    ).toThrow('not bound');
  });

  it('normalizes quote intent and retains idempotency across unchanged retries', () => {
    const intent = {
      businessId: ids.business,
      capacitySlotId: ids.capacity,
      pickupStartsAt,
      pickupEndsAt,
      lines: [
        {
          itemVersionId: ids.item,
          quantity: 2,
          optionVersionIds: [ids.option],
        },
      ],
    } as const;
    const first = prepareShadowQuoteAttempt(null, intent);
    const replay = prepareShadowQuoteAttempt(first, intent);
    const changed = prepareShadowQuoteAttempt(first, {
      ...intent,
      lines: [{ ...intent.lines[0], quantity: 3 }],
    });
    expect(replay).toBe(first);
    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('retains placement and cancellation keys only for the same version', () => {
    const placement = prepareShadowPlacementAttempt(null, {
      businessId: ids.business,
      quotePublicId: ids.quote,
      quoteVersion: 1,
    });
    expect(
      prepareShadowPlacementAttempt(placement, {
        businessId: ids.business,
        quotePublicId: ids.quote,
        quoteVersion: 1,
      })
    ).toBe(placement);
    expect(
      prepareShadowPlacementAttempt(placement, {
        businessId: ids.business,
        quotePublicId: ids.quote,
        quoteVersion: 2,
      }).idempotencyKey
    ).not.toBe(placement.idempotencyKey);

    const receipt = { businessId: ids.business, orderPublicId: ids.order, version: 1 };
    const cancellation = prepareShadowCancellationAttempt(null, receipt);
    expect(prepareShadowCancellationAttempt(cancellation, receipt)).toBe(cancellation);
    expect(cancellation.reasonCode).toBe('customer_cancelled_before_acceptance');
  });

  it('maps server business failures to actionable fail-closed outcomes', () => {
    expect(orderingFailure({ message: 'ORDER_QUOTE_NOT_OPEN' }, 'fallback').code).toBe('CONFLICT');
    expect(orderingFailure({ message: 'ORDER_NOT_CANCELLABLE' }, 'fallback').code).toBe('CONFLICT');
    expect(orderingFailure({ message: 'ORDER_OPTION_SELECTIONS_INVALID' }, 'fallback').code).toBe('INVALID');
    expect(orderingFailure({ message: 'ORDER_QUOTE_TOO_LARGE', code: '22003' }, 'fallback').code).toBe('INVALID');
    expect(orderingFailure({ message: 'ORDER_NOT_FOUND', code: 'P0002' }, 'fallback').code).toBe('NOT_FOUND');
  });
});
