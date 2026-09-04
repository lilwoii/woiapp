import {
  adminClient,
  authenticatedUser,
  corsHeaders,
  HttpError,
  jsonResponse,
  normalizeIdempotencyKey,
  optionsResponse,
  publicError,
  readJson,
} from '../_shared/http.ts';
import {
  paymentAppOrigin,
  providerInteger,
  providerString,
  requirePaymentsEnabled,
  stripeId,
  stripeRequest,
} from '../_shared/stripe.ts';
import {
  PAYMENT_CHECKOUT_MAX_BYTES,
  parsePaymentCheckoutCommand,
  PaymentCheckoutContractError,
} from './contract.ts';

type Json = Record<string, unknown>;

function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(503, 'PAYMENT_STATE_UNAVAILABLE');
  }
  return value as Json;
}

function checkoutPayload(value: unknown) {
  const row = object(value);
  const checkoutPublicId = providerString(row.checkout_public_id, 36);
  const businessName = providerString(row.business_name, 120);
  const providerAccountId = stripeId(row.provider_account_id, 'acct');
  const providerCheckoutId = row.provider_checkout_id === null
    ? null
    : stripeId(row.provider_checkout_id, 'cs');
  const currency = providerString(row.currency, 3).toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) throw new HttpError(503, 'PAYMENT_STATE_UNAVAILABLE');
  const subtotal = providerInteger(row.item_subtotal_minor);
  const applicationFee = providerInteger(row.application_fee_minor);
  if (subtotal < 50 || applicationFee > subtotal || !Array.isArray(row.lines) || row.lines.length < 1 || row.lines.length > 20) {
    throw new HttpError(503, 'PAYMENT_STATE_UNAVAILABLE');
  }
  const lines = row.lines.map((value) => {
    const line = object(value);
    const name = providerString(line.name, 120);
    const quantity = providerInteger(line.quantity, 20);
    const unitPrice = providerInteger(line.unit_price_minor);
    if (quantity < 1) throw new HttpError(503, 'PAYMENT_STATE_UNAVAILABLE');
    return { name, quantity, unitPrice };
  });
  return { checkoutPublicId, businessName, providerAccountId, providerCheckoutId, currency, subtotal, applicationFee, lines };
}

function checkoutUrl(value: unknown): string {
  const raw = providerString(value, 2048);
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new HttpError(502, 'PAYMENT_PROVIDER_INVALID'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'checkout.stripe.com' || parsed.username || parsed.password) {
    throw new HttpError(502, 'PAYMENT_PROVIDER_INVALID');
  }
  return parsed.toString();
}

async function retrieveOpenCheckout(providerCheckoutId: string): Promise<string | null> {
  const session = await stripeRequest('GET', `/v1/checkout/sessions/${providerCheckoutId}`);
  return session.status === 'open' && typeof session.url === 'string' ? checkoutUrl(session.url) : null;
}

Deno.serve(async (request) => {
  let cors: HeadersInit = {};
  try {
    cors = corsHeaders(request);
    if (request.method === 'OPTIONS') return optionsResponse(request);
    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    let command;
    try {
      command = parsePaymentCheckoutCommand(await readJson(request, PAYMENT_CHECKOUT_MAX_BYTES));
    } catch (error) {
      if (error instanceof PaymentCheckoutContractError) throw new HttpError(400, error.code);
      throw error;
    }
    requirePaymentsEnabled();
    const { user, client } = await authenticatedUser(request);

    if (command.action === 'status') {
      const { data, error } = await client.rpc('get_my_prepaid_pickup_checkout_status', {
        target_checkout_public_id: command.checkoutPublicId,
      });
      if (error) throw error;
      return jsonResponse(data, 200, cors);
    }

    const idempotencyKey = normalizeIdempotencyKey(request);
    const admin = adminClient();
    const { data, error } = await admin.rpc('prepare_prepaid_pickup_checkout_server', {
      target_user_id: user.id,
      target_business_id: command.businessId,
      target_location_id: command.locationId,
      target_requested_pickup_at: command.requestedPickupAt,
      target_lines: command.lines.map((line) => ({ menu_item_id: line.menuItemId, quantity: line.quantity })),
      target_customer_note: command.customerNote,
      target_idempotency_key: idempotencyKey,
    });
    if (error) throw error;
    const checkout = checkoutPayload(data);

    if (checkout.providerCheckoutId) {
      const existingUrl = await retrieveOpenCheckout(checkout.providerCheckoutId);
      if (!existingUrl) throw new HttpError(409, 'CHECKOUT_NOT_OPEN');
      return jsonResponse({
        checkoutPublicId: checkout.checkoutPublicId,
        checkoutUrl: existingUrl,
        expiresAt: object(data).expires_at,
      }, 200, cors);
    }

    const origin = paymentAppOrigin();
    const body = new URLSearchParams();
    body.set('mode', 'payment');
    body.set('ui_mode', 'hosted');
    body.set('payment_method_types[0]', 'card');
    body.set('billing_address_collection', 'required');
    body.set('automatic_tax[enabled]', 'true');
    body.set('automatic_tax[liability][type]', 'account');
    body.set('automatic_tax[liability][account]', checkout.providerAccountId);
    body.set('client_reference_id', checkout.checkoutPublicId);
    body.set('origin_context', command.clientPlatform === 'mobile' ? 'mobile_app' : 'web');
    body.set('success_url', `${origin}/orders?checkout=success&spottr_checkout=${checkout.checkoutPublicId}`);
    body.set('cancel_url', `${origin}/pickup/${command.businessId}?checkout=cancelled`);
    body.set('expires_at', String(Math.floor(Date.now() / 1000) + 1800));
    body.set('metadata[spottr_checkout_public_id]', checkout.checkoutPublicId);
    body.set('payment_intent_data[metadata][spottr_checkout_public_id]', checkout.checkoutPublicId);
    body.set('payment_intent_data[on_behalf_of]', checkout.providerAccountId);
    body.set('payment_intent_data[transfer_data][destination]', checkout.providerAccountId);
    if (checkout.applicationFee > 0) {
      body.set('payment_intent_data[application_fee_amount]', String(checkout.applicationFee));
    }
    if (user.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email) && user.email.length <= 254) {
      body.set('customer_email', user.email);
    }
    checkout.lines.forEach((line, index) => {
      body.set(`line_items[${index}][price_data][currency]`, checkout.currency);
      body.set(`line_items[${index}][price_data][product_data][name]`, line.name);
      body.set(`line_items[${index}][price_data][unit_amount]`, String(line.unitPrice));
      body.set(`line_items[${index}][quantity]`, String(line.quantity));
    });

    const session = await stripeRequest(
      'POST', '/v1/checkout/sessions', body, `spottr-checkout-${checkout.checkoutPublicId}`,
    );
    const providerCheckoutId = stripeId(session.id, 'cs');
    const url = checkoutUrl(session.url);
    const { error: attachError } = await admin.rpc('attach_prepaid_checkout_provider_server', {
      target_checkout_public_id: checkout.checkoutPublicId,
      target_provider_checkout_id: providerCheckoutId,
    });
    if (attachError) throw attachError;
    return jsonResponse({
      checkoutPublicId: checkout.checkoutPublicId,
      checkoutUrl: url,
      expiresAt: object(data).expires_at,
    }, 201, cors);
  } catch (error) {
    return publicError(error, cors);
  }
});
