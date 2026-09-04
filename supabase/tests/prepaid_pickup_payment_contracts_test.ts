import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';

import {
  parsePaymentCheckoutCommand,
  PaymentCheckoutContractError,
} from '../functions/payment-checkout/contract.ts';
import {
  parsePaymentConnectCommand,
  PaymentConnectContractError,
} from '../functions/payment-connect/contract.ts';

const businessId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const locationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const itemId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

Deno.test('prepaid checkout accepts only price-free bounded customer intent', () => {
  const command = parsePaymentCheckoutCommand({
    action: 'create',
    businessId,
    locationId,
    requestedPickupAt: '2026-09-05T20:00:00.000Z',
    lines: [{ menuItemId: itemId, quantity: 2 }],
    customerNote: null,
    clientPlatform: 'mobile',
  });
  assertEquals(command.action, 'create');
  if (command.action === 'create') assertEquals(command.lines, [{ menuItemId: itemId, quantity: 2 }]);
  for (const invalid of [
    { action: 'create', businessId, locationId, requestedPickupAt: '2026-09-05T20:00:00.000Z', lines: [{ menuItemId: itemId, quantity: 2, priceMinor: 1 }], customerNote: null, clientPlatform: 'mobile' },
    { action: 'create', businessId: businessId.toUpperCase(), locationId, requestedPickupAt: '2026-09-05T20:00:00.000Z', lines: [{ menuItemId: itemId, quantity: 2 }], customerNote: null, clientPlatform: 'mobile' },
    { action: 'create', businessId, locationId, requestedPickupAt: 'not-a-date', lines: [{ menuItemId: itemId, quantity: 2 }], customerNote: null, clientPlatform: 'mobile' },
    { action: 'status', checkoutPublicId: businessId, extra: true },
  ]) {
    assertRejects(async () => parsePaymentCheckoutCommand(invalid), PaymentCheckoutContractError);
  }
});

Deno.test('merchant payment management uses action-specific exact schemas', () => {
  assertEquals(parsePaymentConnectCommand({ action: 'status', businessId }), { action: 'status', businessId });
  assertEquals(parsePaymentConnectCommand({ action: 'start', businessId, country: 'US' }), { action: 'start', businessId, country: 'US' });
  assertEquals(parsePaymentConnectCommand({ action: 'set_acceptance', businessId, accepted: true }), { action: 'set_acceptance', businessId, accepted: true });
  for (const invalid of [
    { action: 'start', businessId, country: 'usa' },
    { action: 'status', businessId, country: 'US' },
    { action: 'set_acceptance', businessId, accepted: 'true' },
  ]) assertRejects(async () => parsePaymentConnectCommand(invalid), PaymentConnectContractError);
});

Deno.test('prepaid database foundation is private, provider-bound, refund-safe, and fail closed', async () => {
  const sql = await Deno.readTextFile(new URL('../migrations/20261025000000_stripe_connect_prepaid_pickup.sql', import.meta.url));
  for (const required of [
    'enabled boolean not null default false',
    'revoke all privileges on table private.prepaid_pickup_runtime_config',
    "payment_method in ('pay_in_person', 'card_or_wallet')",
    "payment_state in ('due_at_pickup', 'captured', 'refund_pending', 'refunded', 'partially_refunded', 'disputed')",
    'public.prepare_prepaid_pickup_checkout_server',
    "target_line - array['menu_item_id', 'quantity']",
    "and item.availability = 'available'",
    'enqueue_pickup_refund_on_terminal_state',
    'for update skip locked',
    "target.state in ('pending', 'retry', 'provider_pending')",
    'target.attempts < 20',
    'RETRY_LIMIT_EXCEEDED',
    'public.refresh_payment_account_server',
    "auth.role() <> 'service_role'",
    "grant execute on function public.get_my_prepaid_pickup_checkout_status(uuid) to authenticated",
  ]) assert(sql.includes(required), `missing prepaid invariant: ${required}`);
  assert(!/grant\s+(?:select|insert|update|delete|all)[\s\S]{0,120}private\.(?:merchant_payment_accounts|pickup_checkout_drafts|pickup_payment_refunds)[\s\S]{0,80}authenticated/i.test(sql));
});

Deno.test('payment Edge code pins Stripe, verifies raw webhooks, and never accepts client amounts', async () => {
  const shared = await Deno.readTextFile(new URL('../functions/_shared/stripe.ts', import.meta.url));
  const checkout = await Deno.readTextFile(new URL('../functions/payment-checkout/index.ts', import.meta.url));
  const webhook = await Deno.readTextFile(new URL('../functions/payment-webhook/index.ts', import.meta.url));
  const refund = await Deno.readTextFile(new URL('../functions/payment-refund-worker/index.ts', import.meta.url));
  assert(shared.includes("STRIPE_API_VERSION = '2026-02-25.clover'"));
  assert(shared.includes("`${timestamp}.${rawBody}`"));
  assert(shared.includes("Math.abs(nowSeconds - timestamp) > 300"));
  assert(checkout.includes("body.set('automatic_tax[enabled]', 'true')"));
  assert(checkout.includes("body.set('automatic_tax[liability][type]', 'account')"));
  assert(checkout.includes("body.set('payment_intent_data[on_behalf_of]'"));
  assert(checkout.includes("body.set('payment_intent_data[transfer_data][destination]'"));
  assert(checkout.includes("target_lines: command.lines.map"));
  assert(!checkout.includes('priceMinor'));
  assert(webhook.includes("request.headers.get('stripe-signature')"));
  assert(webhook.includes("providerObject.payment_status !== 'paid'"));
  assert(webhook.includes("rpc('refresh_payment_account_server'"));
  assert(refund.includes('spottr-refund-${publicId}'));
  assert(refund.includes("body.set('reverse_transfer', 'true')"));
  assert(refund.includes("body.set('refund_application_fee', 'true')"));
  assert(refund.includes("stripeRequest('GET', `/v1/refunds/${priorRefundId}`)"));
  assert(refund.includes("SPOTTR_PAYMENT_REFUND_WORKER_ENABLED") && refund.includes("internalBearer"));
});
