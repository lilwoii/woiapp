import { adminClient, HttpError, jsonResponse, publicError } from '../_shared/http.ts';
import {
  providerBoolean,
  providerInteger,
  providerString,
  stripeId,
  verifyStripeWebhook,
} from '../_shared/stripe.ts';

const MAX_WEBHOOK_BYTES = 1_048_576;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Json = Record<string, unknown>;

function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_WEBHOOK_EVENT');
  }
  return value as Json;
}

async function rawBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) throw new HttpError(413, 'REQUEST_TOO_LARGE');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_WEBHOOK_BYTES) throw new HttpError(413, 'REQUEST_TOO_LARGE');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new HttpError(400, 'INVALID_WEBHOOK_EVENT'); }
}

function checkoutReference(checkout: Json): string {
  const metadata = object(checkout.metadata);
  const reference = providerString(metadata.spottr_checkout_public_id, 36);
  if (!uuidPattern.test(reference)) throw new HttpError(400, 'INVALID_WEBHOOK_EVENT');
  return reference;
}

function businessReference(account: Json): string | null {
  const metadata = account.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Json).spottr_business_id;
  return typeof value === 'string' && uuidPattern.test(value) ? value : null;
}

function accountFields(account: Json) {
  const requirements = object(account.requirements);
  const due = requirements.currently_due;
  if (!Array.isArray(due) || due.length > 1000 || due.some((value) => typeof value !== 'string')) {
    throw new HttpError(400, 'INVALID_WEBHOOK_EVENT');
  }
  const country = providerString(account.country, 2).toUpperCase();
  const defaultCurrency = providerString(account.default_currency, 3).toUpperCase();
  if (!/^[A-Z]{2}$/.test(country) || !/^[A-Z]{3}$/.test(defaultCurrency)) {
    throw new HttpError(400, 'INVALID_WEBHOOK_EVENT');
  }
  return {
    providerAccountId: stripeId(account.id, 'acct'),
    country,
    defaultCurrency,
    detailsSubmitted: providerBoolean(account.details_submitted),
    chargesEnabled: providerBoolean(account.charges_enabled),
    payoutsEnabled: providerBoolean(account.payouts_enabled),
    requirementsDueCount: providerInteger(due.length, 1000),
  };
}

Deno.serve(async (request) => {
  try {
    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const raw = await rawBody(request);
    await verifyStripeWebhook(raw, request.headers.get('stripe-signature'));
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new HttpError(400, 'INVALID_WEBHOOK_EVENT'); }
    const event = object(parsed);
    const eventId = stripeId(event.id, 'evt');
    const type = providerString(event.type, 120);
    const data = object(event.data);
    const providerObject = object(data.object);
    const admin = adminClient();

    if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
      if (providerObject.payment_status !== 'paid') {
        return jsonResponse({ received: true, status: 'awaiting_payment' });
      }
      const details = object(providerObject.total_details);
      const currency = providerString(providerObject.currency, 3).toUpperCase();
      const { data: result, error } = await admin.rpc('complete_prepaid_checkout_server', {
        target_event_id: eventId,
        target_event_type: type,
        target_checkout_public_id: checkoutReference(providerObject),
        target_provider_checkout_id: stripeId(providerObject.id, 'cs'),
        target_provider_payment_intent_id: stripeId(providerObject.payment_intent, 'pi'),
        target_currency: currency,
        target_total_minor: providerInteger(providerObject.amount_total),
        target_tax_minor: providerInteger(details.amount_tax),
      });
      if (error) throw error;
      return jsonResponse({ received: true, result });
    }

    if (type === 'checkout.session.expired' || type === 'checkout.session.async_payment_failed') {
      const { data: result, error } = await admin.rpc('close_prepaid_checkout_server', {
        target_event_id: eventId,
        target_event_type: type,
        target_checkout_public_id: checkoutReference(providerObject),
        target_provider_checkout_id: stripeId(providerObject.id, 'cs'),
        target_state: type === 'checkout.session.expired' ? 'expired' : 'failed',
      });
      if (error) throw error;
      return jsonResponse({ received: true, result });
    }

    if (type === 'account.updated') {
      const businessId = businessReference(providerObject);
      if (!businessId) return jsonResponse({ received: true, status: 'ignored' });
      const account = accountFields(providerObject);
      const { error } = await admin.rpc('refresh_payment_account_server', {
        target_business_id: businessId,
        target_provider_account_id: account.providerAccountId,
        target_country: account.country,
        target_default_currency: account.defaultCurrency,
        target_details_submitted: account.detailsSubmitted,
        target_charges_enabled: account.chargesEnabled,
        target_payouts_enabled: account.payoutsEnabled,
        target_requirements_due_count: account.requirementsDueCount,
      });
      if (error) throw error;
      return jsonResponse({ received: true, status: 'account_updated' });
    }

    if (type === 'charge.refunded') {
      const { data: result, error } = await admin.rpc('apply_refund_webhook_server', {
        target_event_id: eventId,
        target_payment_intent_id: stripeId(providerObject.payment_intent, 'pi'),
        target_fully_refunded: providerBoolean(providerObject.refunded),
      });
      if (error) throw error;
      return jsonResponse({ received: true, result });
    }

    if (type === 'refund.updated' || type === 'refund.failed') {
      const { data: result, error } = await admin.rpc('apply_refund_status_webhook_server', {
        target_event_id: eventId,
        target_event_type: type,
        target_payment_intent_id: stripeId(providerObject.payment_intent, 'pi'),
        target_provider_refund_id: stripeId(providerObject.id, 're'),
        target_provider_status: providerString(providerObject.status, 40),
      });
      if (error) throw error;
      return jsonResponse({ received: true, result });
    }

    if (type === 'charge.dispute.created') {
      const { data: result, error } = await admin.rpc('apply_dispute_webhook_server', {
        target_event_id: eventId,
        target_payment_intent_id: stripeId(providerObject.payment_intent, 'pi'),
      });
      if (error) throw error;
      return jsonResponse({ received: true, result });
    }

    return jsonResponse({ received: true, status: 'ignored' });
  } catch (error) {
    return publicError(error);
  }
});
