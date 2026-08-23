# Production maintenance control plane

Spottr has eight privacy-, ordering-, finance-, and lifecycle-critical maintenance operations. They
must run without relying on a customer to retry a request or an operator to
remember a dashboard action:

- `delete-account-worker` continues frozen asynchronous account deletions;
- `media-cleanup` removes claimed quarantine and chat objects before database
  finalization;
- `cleanup_marketplace_chat_ephemera` expires pickup disclosures, typing state,
  and other bounded chat data;
- `cleanup_unavailable_meeting_place_requests` cancels meetup choices whose
  licensed public place is no longer usable;
- `expire_shadow_order_quotes` persists expiry for elapsed zero-money pickup
  quotes in a bounded, overlap-safe service-only pass;
- `cleanup_public_discovery_leases` removes expired discovery leases and old
  HMAC-only rate buckets in bounded batches.
- `reconcile_licensed_provider_lifecycle` hides missing, stale, inactive,
  disabled, or unlicensed provider sources from public discovery, advances
  missing sources to stale, and archives only unclaimed provider-owned listings
  after every source's configured archive grace period.
- `reconcile_sponsored_reservations` releases expired ad-budget reservations
  and removes old request-rate buckets so abandoned placements cannot strand
  campaign budget.

The checked-in
[`production-maintenance.yml`](../.github/workflows/production-maintenance.yml)
runs the bounded maintenance client every five minutes and on manual dispatch.
The client performs at most ten account-deletion worker calls, one media cleanup,
and all six database cleanup RPCs. It sends a success heartbeat only after the
deletion worker reaches `idle` or an accepted retryable `waiting` state and every
other cleanup reports bounded completion. Exhausting ten deletion calls with
`deleted` or `more_work` still reported fails the run and withholds the heartbeat.
It never prints response bodies, request IDs, object paths, credentials, or
personal data.

## Required production secrets

Configure these only in the protected repository or organization secret store:

```text
SPOTTR_MAINTENANCE_SUPABASE_URL=https://<project-ref>.supabase.co
SPOTTR_MAINTENANCE_SERVICE_ROLE_KEY=<production service-role key>
SPOTTR_ACCOUNT_DELETE_WORKER_SECRET=<dedicated random secret>
SPOTTR_MEDIA_CLEANUP_SECRET=<different dedicated random secret>
SPOTTR_MAINTENANCE_HEARTBEAT_URL=https://<monitor>/<opaque-check-id>
```

The two worker secrets must exactly match the corresponding Supabase Edge
Function secrets. Never reuse the service-role key as a worker secret. Restrict
secret administration, workflow changes, and default-branch merges to the
smallest practical operator group. The workflow has no pull-request trigger and
declares no GitHub token permissions.

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
2. Configure and rotate the five secrets above. Confirm malformed or missing
   values fail before any request is sent.
3. Manually dispatch the workflow. Its only success output is a small status
   summary with call counts; inspect GitHub secret masking and confirm no response
   bodies are present.
4. Create a staged asynchronous account deletion, expired meetup disclosure,
   unavailable licensed place, expired zero-money pickup quote, expired typing state, cleanup-eligible media
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
   non-overlapping pass reports bounded completion.
   Hold one discovery admission lock, the provider-lifecycle advisory lock, and
   the sponsored-reservation advisory lock during separate cleanup passes and
   verify each skipped operation withholds
   the heartbeat. Confirm active owners and approved ownership claims prevent
   provider lifecycle archival. Confirm sponsored-reservation backlog also
   withholds the heartbeat.
5. Confirm the external heartbeat and missed-heartbeat alert, then inject one
   invalid worker secret and verify the workflow fails without pinging success.
6. Record commit SHA, workflow run URL, Supabase project, UTC timestamps,
   redacted before/after queries, storage checks, alert receipt, operators, and
   sign-off. Do not put secrets or personal data in the evidence bundle.

Account deletion and media cleanup remain release blockers until this evidence
exists in the production target. A committed schedule is executable control
plane code, not proof that its external secrets, monitor, or workflow are active.
