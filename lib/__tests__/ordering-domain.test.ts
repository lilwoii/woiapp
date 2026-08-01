import {
  BuildPickupQuoteInput,
  CheckoutIntentFingerprintInput,
  MenuItemVersionSnapshot,
  OrderingInvariantCode,
  OrderingInvariantError,
  buildPickupQuote,
  canonicalizeCheckoutIntent,
  createCheckoutIntentFingerprint,
  planRefund,
  transitionFulfillmentState,
  transitionPaymentState,
  transitionRefundState,
  validatePickupWindow,
} from '../ordering-domain';

const NOW = Date.parse('2026-08-01T19:00:00.000Z');
const PICKUP_START = Date.parse('2026-08-01T19:30:00.000Z');
const PICKUP_END = Date.parse('2026-08-01T19:45:00.000Z');

function itemSnapshot(
  overrides: Partial<MenuItemVersionSnapshot> = {}
): MenuItemVersionSnapshot {
  return {
    itemId: 'item-bowl',
    itemVersionId: 'item-bowl-v4',
    catalogVersionId: 'catalog-v7',
    name: 'Market bowl',
    unitPriceMinor: 1_200,
    currency: 'USD',
    maximumQuantity: 10,
    orderable: true,
    optionGroups: [
      {
        optionGroupId: 'group-protein',
        optionGroupVersionId: 'group-protein-v2',
        name: 'Protein',
        minimumSelections: 1,
        maximumSelections: 1,
        options: [
          {
            optionId: 'option-tofu',
            optionVersionId: 'option-tofu-v3',
            name: 'Tofu',
            priceDeltaMinor: 150,
            orderable: true,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function quoteInput(
  overrides: Partial<BuildPickupQuoteInput> = {}
): BuildPickupQuoteInput {
  return {
    quoteId: 'quote-01',
    quoteVersion: 1,
    businessId: 'business-01',
    catalogVersionId: 'catalog-v7',
    pricingVersionId: 'pricing-us-v1',
    termsVersion: 'terms-2026-08',
    refundPolicyVersion: 'refunds-2026-08',
    currency: 'USD',
    createdAtMs: NOW,
    expiresAtMs: NOW + 5 * 60_000,
    acceptanceMode: 'manual',
    pickupWindow: {
      locationId: 'location-01',
      timeZone: 'America/Los_Angeles',
      startsAtMs: PICKUP_START,
      endsAtMs: PICKUP_END,
      minimumLeadMinutes: 10,
      maximumAdvanceMinutes: 180,
      orderCutoffAtMs: NOW + 10 * 60_000,
    },
    availability: {
      businessId: 'business-01',
      locationId: 'location-01',
      catalogVersionId: 'catalog-v7',
      revision: 9,
      acceptingOrders: true,
      capacity: {
        maximumActiveOrders: 20,
        acceptedOrders: 5,
        reservedOrders: 2,
      },
      items: [
        {
          itemVersionId: 'item-bowl-v4',
          state: 'available',
          onHandQuantity: 10,
          reservedQuantity: 1,
          revision: 3,
        },
      ],
      options: [
        {
          optionVersionId: 'option-tofu-v3',
          state: 'available',
          revision: 2,
        },
      ],
    },
    lines: [
      {
        lineId: 'line-01',
        item: itemSnapshot(),
        quantity: 2,
        selectedOptions: [
          {
            optionGroupVersionId: 'group-protein-v2',
            optionVersionId: 'option-tofu-v3',
          },
        ],
      },
    ],
    discounts: [
      {
        code: 'merchant-lunch',
        label: 'Lunch special',
        amountMinor: 200,
        fundedBy: 'merchant',
      },
    ],
    tax: {
      calculationReference: 'tax-calc-01',
      source: 'approved-tax-adapter',
      lines: [{ code: 'sales-tax', label: 'Sales tax', amountMinor: 225 }],
    },
    gratuityMinor: 300,
    consumerFees: [
      { code: 'service-fee', label: 'Service fee', amountMinor: 50 },
    ],
    ...overrides,
  };
}

function expectInvariant(
  operation: () => unknown,
  code: OrderingInvariantCode
): OrderingInvariantError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(OrderingInvariantError);
    expect(error).toMatchObject({ code });
    return error as OrderingInvariantError;
  }
  throw new Error(`Expected ${code}`);
}

describe('pickup quote domain', () => {
  it('uses integer snapshot prices and supplied money lines exactly', () => {
    const quote = buildPickupQuote(quoteInput());

    expect(quote.lines[0]).toMatchObject({
      itemVersionId: 'item-bowl-v4',
      quantity: 2,
      baseUnitPriceMinor: 1_200,
      optionUnitTotalMinor: 150,
      unitTotalMinor: 1_350,
      lineSubtotalMinor: 2_700,
    });
    expect(quote.lines[0].selectedOptions[0]).toMatchObject({
      optionVersionId: 'option-tofu-v3',
      optionGroupVersionId: 'group-protein-v2',
      priceDeltaMinor: 150,
    });
    expect(quote.totals).toEqual({
      subtotalMinor: 2_700,
      discountMinor: 200,
      taxMinor: 225,
      gratuityMinor: 300,
      consumerFeeMinor: 50,
      totalMinor: 3_075,
    });
    expect(quote.availabilityRevision).toBe(9);
    expect(Object.isFrozen(quote)).toBe(true);
    expect(Object.isFrozen(quote.lines)).toBe(true);
    expect(Object.isFrozen(quote.lines[0].selectedOptions[0])).toBe(true);
  });

  it('does not invent a tax rate or recalculate supplied tax', () => {
    const zeroTax = buildPickupQuote(
      quoteInput({
        tax: {
          calculationReference: 'tax-exempt-result',
          source: 'approved-tax-adapter',
          lines: [],
        },
      })
    );
    const suppliedTax = buildPickupQuote(
      quoteInput({
        tax: {
          calculationReference: 'tax-result-two',
          source: 'approved-tax-adapter',
          lines: [{ code: 'authority-total', label: 'Tax', amountMinor: 123 }],
        },
      })
    );

    expect(zeroTax.totals.taxMinor).toBe(0);
    expect(suppliedTax.totals.taxMinor).toBe(123);
    expect(suppliedTax.totals.totalMinor - zeroTax.totals.totalMinor).toBe(123);
  });

  it('rejects fractional money and arithmetic outside safe integer precision', () => {
    expectInvariant(
      () =>
        buildPickupQuote(
          quoteInput({
            lines: [
              {
                ...quoteInput().lines[0],
                item: itemSnapshot({ unitPriceMinor: 1_200.5 }),
              },
            ],
          })
        ),
      'INVALID_MINOR_UNIT'
    );

    expectInvariant(
      () =>
        buildPickupQuote(
          quoteInput({
            lines: [
              {
                ...quoteInput().lines[0],
                item: itemSnapshot({
                  maximumQuantity: 2,
                  unitPriceMinor: Number.MAX_SAFE_INTEGER,
                }),
                quantity: 2,
              },
            ],
          })
        ),
      'MONEY_OVERFLOW'
    );
  });

  it('fails closed on currency, catalog, and availability mismatches', () => {
    expectInvariant(
      () =>
        buildPickupQuote(
          quoteInput({
            lines: [
              {
                ...quoteInput().lines[0],
                item: itemSnapshot({ currency: 'CAD' }),
              },
            ],
          })
        ),
      'CURRENCY_MISMATCH'
    );

    expectInvariant(
      () =>
        buildPickupQuote(
          quoteInput({
            availability: {
              ...quoteInput().availability,
              catalogVersionId: 'catalog-stale',
            },
          })
        ),
      'INVALID_MENU_SNAPSHOT'
    );

    expectInvariant(
      () =>
        buildPickupQuote(
          quoteInput({
            availability: { ...quoteInput().availability, items: [] },
          })
        ),
      'ITEM_UNAVAILABLE'
    );
  });

  it('requires complete, currently available modifier selections', () => {
    expectInvariant(
      () =>
        buildPickupQuote(
          quoteInput({
            lines: [{ ...quoteInput().lines[0], selectedOptions: [] }],
          })
        ),
      'OPTION_UNAVAILABLE'
    );

    expectInvariant(
      () =>
        buildPickupQuote(
          quoteInput({
            availability: {
              ...quoteInput().availability,
              options: [
                {
                  optionVersionId: 'option-tofu-v3',
                  state: 'sold_out',
                  revision: 3,
                },
              ],
            },
          })
        ),
      'OPTION_UNAVAILABLE'
    );
  });

  it('aggregates inventory across cart lines and enforces business capacity', () => {
    const firstLine = quoteInput().lines[0];
    expectInvariant(
      () =>
        buildPickupQuote(
          quoteInput({
            lines: [
              { ...firstLine, lineId: 'line-a', quantity: 5 },
              { ...firstLine, lineId: 'line-b', quantity: 5 },
            ],
          })
        ),
      'INVENTORY_UNAVAILABLE'
    );

    expectInvariant(
      () =>
        buildPickupQuote(
          quoteInput({
            availability: {
              ...quoteInput().availability,
              capacity: {
                maximumActiveOrders: 7,
                acceptedOrders: 5,
                reservedOrders: 2,
              },
            },
          })
        ),
      'CAPACITY_UNAVAILABLE'
    );

    expectInvariant(
      () =>
        buildPickupQuote(
          quoteInput({
            availability: {
              ...quoteInput().availability,
              acceptingOrders: false,
            },
          })
        ),
      'BUSINESS_NOT_ACCEPTING'
    );
  });
});

describe('pickup windows', () => {
  it('accepts a pickup window contained by the food-truck stop safety window', () => {
    const window = validatePickupWindow(
      {
        ...quoteInput().pickupWindow,
        mobileStop: {
          stopId: 'stop-01',
          locationId: 'location-01',
          startsAtMs: NOW + 15 * 60_000,
          endsAtMs: NOW + 60 * 60_000,
          safetyBufferMinutes: 10,
        },
      },
      NOW
    );

    expect(window.mobileStop?.stopId).toBe('stop-01');
    expect(window.endsAtMs).toBe(PICKUP_END);
  });

  it('rejects expired cutoffs and pickup windows outside a mobile stop buffer', () => {
    expectInvariant(
      () =>
        validatePickupWindow(
          { ...quoteInput().pickupWindow, orderCutoffAtMs: NOW - 1 },
          NOW
        ),
      'PICKUP_WINDOW_INVALID'
    );

    expectInvariant(
      () =>
        validatePickupWindow(
          {
            ...quoteInput().pickupWindow,
            mobileStop: {
              stopId: 'stop-01',
              locationId: 'location-01',
              startsAtMs: NOW + 15 * 60_000,
              endsAtMs: NOW + 50 * 60_000,
              safetyBufferMinutes: 10,
            },
          },
          NOW
        ),
      'PICKUP_WINDOW_INVALID'
    );
  });
});

describe('explicit state transitions', () => {
  it('allows merchant acceptance and policy-authorized cancellation', () => {
    expect(
      transitionFulfillmentState({
        currentState: 'pending_acceptance',
        nextState: 'accepted',
        actor: 'merchant',
        occurredAtMs: NOW,
      })
    ).toMatchObject({ previousState: 'pending_acceptance', nextState: 'accepted' });

    expect(
      transitionFulfillmentState({
        currentState: 'accepted',
        nextState: 'cancelled',
        actor: 'merchant',
        occurredAtMs: NOW,
        reasonCode: 'merchant_outage',
        policyAuthorized: true,
      })
    ).toMatchObject({ nextState: 'cancelled', reasonCode: 'merchant_outage' });
  });

  it('rejects unauthorized, terminal, and unapproved cancellation paths', () => {
    expectInvariant(
      () =>
        transitionFulfillmentState({
          currentState: 'pending_acceptance',
          nextState: 'accepted',
          actor: 'customer',
          occurredAtMs: NOW,
        }),
      'TRANSITION_NOT_AUTHORIZED'
    );
    expectInvariant(
      () =>
        transitionFulfillmentState({
          currentState: 'accepted',
          nextState: 'cancelled',
          actor: 'merchant',
          occurredAtMs: NOW,
          reasonCode: 'merchant_outage',
        }),
      'TRANSITION_NOT_AUTHORIZED'
    );
    expectInvariant(
      () =>
        transitionFulfillmentState({
          currentState: 'completed',
          nextState: 'cancelled',
          actor: 'support',
          occurredAtMs: NOW,
          reasonCode: 'late_request',
          policyAuthorized: true,
        }),
      'INVALID_TRANSITION'
    );
  });

  it('separates provider-authoritative payment transitions from fulfillment', () => {
    expect(
      transitionPaymentState({
        currentState: 'authorized',
        nextState: 'captured',
        actor: 'payment_provider',
        occurredAtMs: NOW,
      })
    ).toMatchObject({ nextState: 'captured' });

    expectInvariant(
      () =>
        transitionPaymentState({
          currentState: 'captured',
          nextState: 'authorized',
          actor: 'payment_provider',
          occurredAtMs: NOW,
        }),
      'INVALID_TRANSITION'
    );
    expectInvariant(
      () =>
        transitionPaymentState({
          currentState: 'captured',
          nextState: 'refunded',
          actor: 'customer',
          occurredAtMs: NOW,
          reasonCode: 'customer_request',
        }),
      'TRANSITION_NOT_AUTHORIZED'
    );
  });

  it('requires an explicit refund approval and provider result path', () => {
    expect(
      transitionRefundState({
        currentState: 'requested',
        nextState: 'approved',
        actor: 'support',
        occurredAtMs: NOW,
      })
    ).toMatchObject({ nextState: 'approved' });
    expect(
      transitionRefundState({
        currentState: 'submitted',
        nextState: 'succeeded',
        actor: 'payment_provider',
        occurredAtMs: NOW,
      })
    ).toMatchObject({ nextState: 'succeeded' });
    expectInvariant(
      () =>
        transitionRefundState({
          currentState: 'requested',
          nextState: 'succeeded',
          actor: 'support',
          occurredAtMs: NOW,
        }),
      'INVALID_TRANSITION'
    );
  });
});

describe('refund allocation', () => {
  it('projects partial and final refunds without changing the captured total', () => {
    const partial = planRefund({
      capturedTotalMinor: 3_075,
      previouslyRefundedMinor: 0,
      paymentState: 'captured',
      amountMinor: 1_000,
      allocation: {
        itemsMinor: 850,
        taxMinor: 75,
        gratuityMinor: 50,
        consumerFeesMinor: 25,
      },
    });
    expect(partial).toMatchObject({
      cumulativeRefundedMinor: 1_000,
      remainingAfterRefundMinor: 2_075,
      projectedPaymentState: 'partially_refunded',
    });

    const final = planRefund({
      capturedTotalMinor: 3_075,
      previouslyRefundedMinor: 1_000,
      paymentState: 'partially_refunded',
      amountMinor: 2_075,
      allocation: {
        itemsMinor: 1_650,
        taxMinor: 150,
        gratuityMinor: 250,
        consumerFeesMinor: 25,
      },
    });
    expect(final).toMatchObject({
      cumulativeRefundedMinor: 3_075,
      remainingAfterRefundMinor: 0,
      projectedPaymentState: 'refunded',
    });
  });

  it('rejects allocation mismatch, over-refund, and inconsistent payment state', () => {
    expectInvariant(
      () =>
        planRefund({
          capturedTotalMinor: 1_000,
          previouslyRefundedMinor: 0,
          paymentState: 'captured',
          amountMinor: 500,
          allocation: {
            itemsMinor: 400,
            taxMinor: 0,
            gratuityMinor: 0,
            consumerFeesMinor: 0,
          },
        }),
      'REFUND_INVALID'
    );
    expectInvariant(
      () =>
        planRefund({
          capturedTotalMinor: 1_000,
          previouslyRefundedMinor: 800,
          paymentState: 'partially_refunded',
          amountMinor: 300,
          allocation: {
            itemsMinor: 300,
            taxMinor: 0,
            gratuityMinor: 0,
            consumerFeesMinor: 0,
          },
        }),
      'REFUND_INVALID'
    );
    expectInvariant(
      () =>
        planRefund({
          capturedTotalMinor: 1_000,
          previouslyRefundedMinor: 100,
          paymentState: 'captured',
          amountMinor: 100,
          allocation: {
            itemsMinor: 100,
            taxMinor: 0,
            gratuityMinor: 0,
            consumerFeesMinor: 0,
          },
        }),
      'REFUND_INVALID'
    );
  });
});

describe('checkout intent fingerprinting', () => {
  const intent: CheckoutIntentFingerprintInput = {
    actorPublicId: 'actor-public-01',
    quoteId: 'quote-01',
    quoteVersion: 1,
    businessId: 'business-01',
    totalMinor: 3_075,
    currency: 'USD',
    locationId: 'location-01',
    pickupStartsAtMs: PICKUP_START,
    pickupEndsAtMs: PICKUP_END,
    paymentMethodKind: 'card',
    termsVersion: 'terms-2026-08',
    refundPolicyVersion: 'refunds-2026-08',
  };

  const testDigest = (value: string) => {
    let hash = 2_166_136_261;
    for (let index = 0; index < value.length; index += 1) {
      hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619) >>> 0;
    }
    return hash.toString(16).padStart(64, '0');
  };

  it('canonicalizes the checkout authority fields in a fixed order', () => {
    const first = canonicalizeCheckoutIntent(intent);
    const reordered: CheckoutIntentFingerprintInput = {
      refundPolicyVersion: intent.refundPolicyVersion,
      paymentMethodKind: intent.paymentMethodKind,
      pickupEndsAtMs: intent.pickupEndsAtMs,
      pickupStartsAtMs: intent.pickupStartsAtMs,
      locationId: intent.locationId,
      currency: intent.currency,
      totalMinor: intent.totalMinor,
      businessId: intent.businessId,
      quoteVersion: intent.quoteVersion,
      quoteId: intent.quoteId,
      actorPublicId: intent.actorPublicId,
      termsVersion: intent.termsVersion,
    };

    expect(canonicalizeCheckoutIntent(reordered)).toBe(first);
    expect(JSON.parse(first)[0]).toBe('spottr.checkout.intent.v1');
  });

  it('creates a bounded action-scoped fingerprint and changes with intent', async () => {
    const first = await createCheckoutIntentFingerprint(intent, testDigest);
    const retry = await createCheckoutIntentFingerprint({ ...intent }, testDigest);
    const changed = await createCheckoutIntentFingerprint(
      { ...intent, totalMinor: intent.totalMinor + 1 },
      testDigest
    );

    expect(first).toMatch(/^spottr:place_order:v1:[0-9a-f]{64}$/);
    expect(retry).toBe(first);
    expect(changed).not.toBe(first);
    expect(first.length).toBeLessThanOrEqual(128);
  });

  it('fails closed when the injected digest is absent or malformed', async () => {
    await expect(
      createCheckoutIntentFingerprint(intent, async () => 'not-sha256')
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_INVALID' });
    await expect(
      createCheckoutIntentFingerprint(
        intent,
        undefined as unknown as (value: string) => string
      )
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_INVALID' });
  });
});

