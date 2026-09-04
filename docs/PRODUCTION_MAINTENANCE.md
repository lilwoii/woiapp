# Production maintenance control plane

Spottr has nine always-on privacy-, ordering-, finance-, and lifecycle-critical
maintenance operations plus two independently gated push operations and two
independently gated prepaid-payment operations. They must
run without relying on a customer to retry a request or an operator to remember
a dashboard action:

- `delete-account-worker` continues frozen asynchronous account deletions;
- `media-cleanup` removes claimed quarantine and chat objects before database
  finalization;
- `cleanup_marketplace_chat_ephemera` expires pickup disclosures, typing state,
  and other bounded chat data;
- `cleanup_unavailable_meeting_place_requests` cancels meetup choices whose
  licensed public place is no longer usable;
- `expire_shadow_order_quotes` persists expiry for elapsed zero-money pickup
  quotes in a bounded, overlap-safe service-only pass;
- `expire_shadow_orders` closes elapsed merchant-acceptance windows and releases
  their reserved pickup capacity in a bounded, overlap-safe service-only pass;
- `cleanup_public_discovery_leases` removes expired discovery leases and old
  HMAC-only rate buckets in bounded batches.
- `reconcile_licensed_provider_lifecycle` hides missing, stale, inactive,
  disabled, or unlicensed provider sources from public discovery, advances
  missing sources to stale, and archives only unclaimed provider-owned listings
  after every source's configured archive grace period.
- `reconcile_sponsored_reservations` releases expired ad-budget reservations
  and removes old request-rate buckets so abandoned placements cannot strand
  campaign budget.
- `notification-dispatch`, only when the separate maintenance push gate is
  enabled, performs bounded outbox expansion and provider handoff;
- `notification-receipt`, under the same maintenance gate but its own worker
  secret and Edge gate, performs bounded delayed receipt finalization without
  resending content.
- `expire_prepaid_checkout_drafts`, only when the separate payment-maintenance
  gate is enabled, closes stale checkout attempts without creating orders;
- `payment-refund-worker`, under the same maintenance gate but its own internal
  secret and Edge gate, claims and submits at most 20 durable refunds.

The checked-in
[`production-maintenance.yml`](../.github/workflows/production-maintenance.yml)
runs the bounded maintenance client every five minutes and on manual dispatch.
The client performs at most ten account-deletion worker calls, one media cleanup,
and all seven database cleanup RPCs. When the repository-level push scheduler
gate is true, it additionally calls dispatch with at most 20 outbox rows, 200
recipients per outbox row, and 50 delivery rows, then polls at most 100 receipt
rows. It validates every returned count and sends a success heartbeat only after
the deletion worker reaches `idle` or an accepted retryable `waiting` state and
every enabled operation reports bounded, internally consistent completion.
Exhausting ten deletion calls with `deleted` or `more_work`, a saturated push
batch, malformed push counts, or either push worker failing withholds the
heartbeat. It never prints response bodies, request IDs, object paths,
credentials, provider tickets, or personal data.

## Required production secrets

Configure these only in the protected repository or organization secret store:

```text
SPOTTR_MAINTENANCE_SUPABASE_URL=https://<project-ref>.supabase.co
SPOTTR_MAINTENANCE_SERVICE_ROLE_KEY=<production service-role key>
SPOTTR_ACCOUNT_DELETE_WORKER_SECRET=<dedicated random secret>
SPOTTR_MEDIA_CLEANUP_SECRET=<different dedicated random secret>
SPOTTR_MAINTENANCE_HEARTBEAT_URL=https://<monitor>/<opaque-check-id>
```

Push scheduling remains off unless this protected repository variable is
exactly `true`:

```text
SPOTTR_MAINTENANCE_PUSH_ENABLED=false
SPOTTR_MAINTENANCE_PAYMENTS_ENABLED=false
```

Only after isolated staging acceptance, configure two additional protected
secrets and set that variable to `true`:

```text
SPOTTR_PUSH_DISPATCH_SECRET=<dedicated dispatch worker secret>
SPOTTR_PUSH_RECEIPT_SECRET=<different receipt worker secret>
SPOTTR_PAYMENT_REFUND_WORKER_SECRET=<different refund worker secret>
```

Every worker secret must exactly match its corresponding Supabase Edge Function
secret. Never reuse the service-role key or another worker's secret. Restrict
secret/variable administration, workflow changes, and default-branch merges to
the smallest practical operator group. The workflow has no pull-request trigger
and declares no GitHub token permissions. Enabling the repository variable while
either Edge worker/provider gate is false deliberately fails the run and
withholds the heartbeat.

The heartbeat monitor must alert the named infrastructure and privacy on-call
when no success arrives for 12 minutes. A failed maintenance request deliberately
skips the heartbeat so a silent cleanup failure becomes an alert. GitHub schedule
delivery can be delayed; before high-volume public launch, run the same checked-in
client from a production scheduler with an availability target appropriate to
the deletion and privacy SLO, while keeping one active scheduler to avoid
unnecessary duplicate work.

## Activation and acceptance

1. Apply the exact reviewed database migrations and deploy the matching Edge
   Functions before enabling the schedule.
2. Configure and rotate the five base secrets above. Confirm malformed or
   missing values fail before any request is sent. Leave
   `SPOTTR_MAINTENANCE_PUSH_ENABLED=false` and
   `SPOTTR_MAINTENANCE_PAYMENTS_ENABLED=false` until their acceptance programs
   are complete.
3. Manually dispatch the workflow. Its only success output is a small status
   summary with call counts; inspect GitHub secret masking and confirm no response
   bodies are present.
4. Create a staged asynchronous account deletion, expired meetup disclosure,
   unavailable licensed place, expired zero-money pickup quote, expired pending
   pickup order, expired typing state, cleanup-eligible media
   object, expired discovery lease, old discovery rate bucket, stale provider
   source, archive-eligible unclaimed provider listing, and expired sponsored
   reservation. Verify each
   reaches its documented terminal state and storage is deleted before database
   finalization. Seed more than ten account-deletion work items and verify the
   bounded pass completes the other cleanups but withholds its heartbeat until a
   later pass observes `idle` or `waiting`. Seed more than one discovery-cleanup
   batch and verify the reported backlog withholds the success heartbeat until a
   later run drains it. Seed more than one quote-expiry batch and verify both
   backlog and overlapping-worker receipts withhold the heartbeat until a later
   non-overlapping pass reports bounded completion. Repeat the same backlog and
   overlapping-worker proof for pending-order expiry, and verify every expired
   order releases exactly one reserved capacity unit and appends an
   `acceptance_timeout` system event.
   Hold one discovery admission lock, the provider-lifecycle advisory lock, and
   the sponsored-reservation advisory lock during separate cleanup passes and
   verify each skipped operation withholds
   the heartbeat. Confirm active owners and approved ownership claims prevent
   provider lifecycle archival. Confirm sponsored-reservation backlog also
   withholds the heartbeat.
5. Confirm the external heartbeat and missed-heartbeat alert, then inject one
   invalid worker secret and verify the workflow fails without pinging success.
6. In isolated push staging, configure the two dedicated push worker secrets,
   enable the Edge database/provider/dispatch/receipt gates, and only then set
   `SPOTTR_MAINTENANCE_PUSH_ENABLED=true`. Seed bounded dispatch and receipt
   work; verify accepted, unknown, retry, dead, delivered, failed, and invalid-
   token outcomes, provider timeouts, inconsistent response rejection, missed-
   heartbeat alerting, and that receipt polling never resends a notification.
7. In isolated payment staging, configure the dedicated refund worker secret,
   enable the payment database/Edge/refund-worker gates, and only then set
   `SPOTTR_MAINTENANCE_PAYMENTS_ENABLED=true`. Prove checkout expiry, captured
   order cancellation, refund retry, asynchronous refund completion, dispute,
   malformed provider response, backlog, and missed-heartbeat behavior.
8. Record commit SHA, workflow run URL, Supabase project, UTC timestamps,
   redacted before/after queries, storage checks, alert receipt, operators, and
   sign-off. Do not put secrets or personal data in the evidence bundle.

Account deletion and media cleanup remain release blockers until this evidence
exists in the production target. A committed schedule is executable control
plane code, not proof that its external secrets, monitor, or workflow are active.
