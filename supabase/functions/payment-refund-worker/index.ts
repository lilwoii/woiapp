import {
  adminClient,
  HttpError,
  internalBearer,
  jsonResponse,
  publicError,
} from '../_shared/http.ts';
import { providerBoolean, providerString, stripeId, stripeRequest } from '../_shared/stripe.ts';

type Json = Record<string, unknown>;

function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(503, 'REFUND_QUEUE_INVALID');
  }
  return value as Json;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new HttpError(503, 'REFUND_QUEUE_INVALID');
  }
  return value;
}

Deno.serve(async (request) => {
  try {
    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    internalBearer(request, 'SPOTTR_PAYMENT_REFUND_WORKER_SECRET');
    if (Deno.env.get('SPOTTR_PAYMENT_REFUND_WORKER_ENABLED') !== 'true') {
      throw new HttpError(503, 'REFUND_WORKER_DISABLED');
    }
    const admin = adminClient();
    const { data, error } = await admin.rpc('claim_pickup_payment_refunds', { batch_size: 20 });
    if (error) throw error;
    if (!Array.isArray(data) || data.length > 20) throw new HttpError(503, 'REFUND_QUEUE_INVALID');
    let succeeded = 0;
    let pending = 0;
    let retried = 0;
    let failed = 0;

    for (const candidate of data) {
      const operation = object(candidate);
      const publicId = uuid(operation.public_id);
      const leaseToken = uuid(operation.lease_token);
      const paymentIntentId = stripeId(operation.provider_payment_intent_id, 'pi');
      const refundApplicationFee = providerBoolean(operation.refund_application_fee);
      try {
        const priorRefundId = operation.provider_refund_id === null
          ? null
          : stripeId(operation.provider_refund_id, 're');
        let refund: Json;
        if (priorRefundId) {
          refund = await stripeRequest('GET', `/v1/refunds/${priorRefundId}`);
        } else {
          const body = new URLSearchParams();
          body.set('payment_intent', paymentIntentId);
          body.set('reverse_transfer', 'true');
          if (refundApplicationFee) body.set('refund_application_fee', 'true');
          body.set('metadata[spottr_refund_operation_id]', publicId);
          refund = await stripeRequest(
            'POST', '/v1/refunds', body, `spottr-refund-${publicId}`,
          );
        }
        const refundId = stripeId(refund.id, 're');
        const status = providerString(refund.status, 40);
        const outcome = status === 'succeeded'
          ? 'succeeded'
          : status === 'pending'
            ? 'provider_pending'
            : status === 'failed'
              ? 'failed'
              : 'retry';
        const { error: finishError } = await admin.rpc('finish_pickup_payment_refund', {
          target_public_id: publicId,
          target_lease_token: leaseToken,
          target_outcome: outcome,
          target_provider_refund_id: refundId,
          target_error_code: outcome === 'failed' ? 'PROVIDER_REFUND_FAILED' : null,
        });
        if (finishError) throw finishError;
        if (outcome === 'succeeded') succeeded += 1;
        else if (outcome === 'provider_pending') pending += 1;
        else if (outcome === 'failed') failed += 1;
        else retried += 1;
      } catch (providerError) {
        const permanent = providerError instanceof HttpError && providerError.status === 422;
        const { error: finishError } = await admin.rpc('finish_pickup_payment_refund', {
          target_public_id: publicId,
          target_lease_token: leaseToken,
          target_outcome: permanent ? 'failed' : 'retry',
          target_provider_refund_id: null,
          target_error_code: permanent ? 'PAYMENT_PROVIDER_REJECTED' : 'PAYMENT_PROVIDER_UNAVAILABLE',
        });
        if (finishError) throw finishError;
        if (permanent) failed += 1; else retried += 1;
      }
    }
    return jsonResponse({ claimed: data.length, succeeded, providerPending: pending, retried, failed });
  } catch (error) {
    return publicError(error);
  }
});
