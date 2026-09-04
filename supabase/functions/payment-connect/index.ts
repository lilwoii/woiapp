import {
  adminClient,
  authenticatedUser,
  corsHeaders,
  HttpError,
  jsonResponse,
  optionsResponse,
  publicError,
  readJson,
} from '../_shared/http.ts';
import {
  paymentAppOrigin,
  providerBoolean,
  providerInteger,
  providerString,
  requirePaymentsEnabled,
  stripeId,
  stripeRequest,
} from '../_shared/stripe.ts';
import {
  PAYMENT_CONNECT_MAX_BYTES,
  parsePaymentConnectCommand,
  PaymentConnectContractError,
} from './contract.ts';

type Json = Record<string, unknown>;

function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(502, 'PAYMENT_PROVIDER_INVALID');
  }
  return value as Json;
}

function allowedCountry(country: string): void {
  const configured = (Deno.env.get('SPOTTR_STRIPE_CONNECT_COUNTRIES') ?? '')
    .split(',').map((value) => value.trim()).filter(Boolean);
  if (configured.length < 1 || configured.length > 80 || configured.some((value) => !/^[A-Z]{2}$/.test(value))) {
    throw new HttpError(503, 'PAYMENTS_NOT_CONFIGURED');
  }
  if (!configured.includes(country)) throw new HttpError(422, 'PAYMENT_COUNTRY_UNAVAILABLE');
}

function onboardingUrl(value: unknown): string {
  const raw = providerString(value, 2048);
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new HttpError(502, 'PAYMENT_PROVIDER_INVALID'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'connect.stripe.com' || parsed.username || parsed.password) {
    throw new HttpError(502, 'PAYMENT_PROVIDER_INVALID');
  }
  return parsed.toString();
}

function parseAccount(account: Json) {
  const requirements = account.requirements === null ? {} : object(account.requirements);
  const currentlyDue = requirements.currently_due;
  if (!Array.isArray(currentlyDue) || currentlyDue.length > 1000 || currentlyDue.some((value) => typeof value !== 'string')) {
    throw new HttpError(502, 'PAYMENT_PROVIDER_INVALID');
  }
  const country = providerString(account.country, 2).toUpperCase();
  const defaultCurrency = providerString(account.default_currency, 3).toUpperCase();
  if (!/^[A-Z]{2}$/.test(country) || !/^[A-Z]{3}$/.test(defaultCurrency)) {
    throw new HttpError(502, 'PAYMENT_PROVIDER_INVALID');
  }
  return {
    providerAccountId: stripeId(account.id, 'acct'),
    country,
    defaultCurrency,
    detailsSubmitted: providerBoolean(account.details_submitted),
    chargesEnabled: providerBoolean(account.charges_enabled),
    payoutsEnabled: providerBoolean(account.payouts_enabled),
    requirementsDueCount: providerInteger(currentlyDue.length, 1000),
  };
}

Deno.serve(async (request) => {
  let cors: HeadersInit = {};
  try {
    cors = corsHeaders(request);
    if (request.method === 'OPTIONS') return optionsResponse(request);
    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    let command;
    try {
      command = parsePaymentConnectCommand(await readJson(request, PAYMENT_CONNECT_MAX_BYTES));
    } catch (error) {
      if (error instanceof PaymentConnectContractError) throw new HttpError(400, error.code);
      throw error;
    }
    requirePaymentsEnabled();
    const { user, client } = await authenticatedUser(request, true);
    const { error: authorizationError } = await client.rpc('authorize_business_payment_management', {
      target_business_id: command.businessId,
    });
    if (authorizationError) throw authorizationError;

    if (command.action === 'set_acceptance') {
      const { data, error } = await client.rpc('set_business_prepaid_acceptance', {
        target_business_id: command.businessId,
        should_accept: command.accepted,
      });
      if (error) throw error;
      return jsonResponse(data, 200, cors);
    }

    const admin = adminClient();
    const { data: current, error: currentError } = await admin.rpc('get_payment_account_server', {
      target_business_id: command.businessId,
    });
    if (currentError) throw currentError;
    const currentRow = current && typeof current === 'object' && !Array.isArray(current)
      ? current as Json
      : null;
    let providerAccountId = currentRow?.provider_account_id
      ? stripeId(currentRow.provider_account_id, 'acct')
      : null;

    if (!providerAccountId) {
      if (command.action !== 'start') {
        const { data, error } = await client.rpc('get_business_prepaid_payment_status', {
          target_business_id: command.businessId,
        });
        if (error) throw error;
        return jsonResponse(data, 200, cors);
      }
      allowedCountry(command.country);
      const origin = paymentAppOrigin();
      const body = new URLSearchParams();
      body.set('type', 'express');
      body.set('country', command.country);
      body.set('capabilities[card_payments][requested]', 'true');
      body.set('capabilities[transfers][requested]', 'true');
      body.set('metadata[spottr_business_id]', command.businessId);
      body.set('business_profile[url]', `${origin}/place/${command.businessId}`);
      if (user.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email) && user.email.length <= 254) {
        body.set('email', user.email);
      }
      const created = await stripeRequest(
        'POST', '/v1/accounts', body, `spottr-connect-${command.businessId}`,
      );
      providerAccountId = stripeId(created.id, 'acct');
    }

    const providerAccount = parseAccount(await stripeRequest('GET', `/v1/accounts/${providerAccountId}`));
    const { error: upsertError } = await admin.rpc('upsert_payment_account_server', {
      target_business_id: command.businessId,
      target_provider_account_id: providerAccount.providerAccountId,
      target_country: providerAccount.country,
      target_default_currency: providerAccount.defaultCurrency,
      target_details_submitted: providerAccount.detailsSubmitted,
      target_charges_enabled: providerAccount.chargesEnabled,
      target_payouts_enabled: providerAccount.payoutsEnabled,
      target_requirements_due_count: providerAccount.requirementsDueCount,
    });
    if (upsertError) throw upsertError;

    if (command.action === 'start') {
      if (providerAccount.country !== command.country) throw new HttpError(409, 'PAYMENT_COUNTRY_CONFLICT');
      const origin = paymentAppOrigin();
      const linkBody = new URLSearchParams();
      linkBody.set('account', providerAccount.providerAccountId);
      linkBody.set('type', 'account_onboarding');
      linkBody.set('refresh_url', `${origin}/studio?payment=refresh&business=${command.businessId}`);
      linkBody.set('return_url', `${origin}/studio?payment=return&business=${command.businessId}`);
      const link = await stripeRequest('POST', '/v1/account_links', linkBody);
      return jsonResponse({ onboardingUrl: onboardingUrl(link.url) }, 201, cors);
    }

    const { data, error } = await client.rpc('get_business_prepaid_payment_status', {
      target_business_id: command.businessId,
    });
    if (error) throw error;
    return jsonResponse(data, 200, cors);
  } catch (error) {
    return publicError(error, cors);
  }
});
