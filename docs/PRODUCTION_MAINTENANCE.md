# Production maintenance control plane

Spottr has five privacy- and lifecycle-critical maintenance operations. They
must run without relying on a customer to retry a request or an operator to
remember a dashboard action:

- `delete-account-worker` continues frozen asynchronous account deletions;
- `media-cleanup` removes claimed quarantine and chat objects before database
  finalization;
- `cleanup_marketplace_chat_ephemera` expires pickup disclosures, typing state,
  and other bounded chat data;
- `cleanup_unavailable_meeting_place_requests` cancels meetup choices whose
  licensed public place is no longer usable;
- `cleanup_public_discovery_leases` removes expired discovery leases and old
  HMAC-only rate buckets in bounded batches.

The checked-in
[`production-maintenance.yml`](../.github/workflows/production-maintenance.yml)
runs the bounded maintenance client every five minutes and on manual dispatch.
The client performs at most ten account-deletion worker calls, one media cleanup,
all three database cleanup RPCs, and then a success heartbeat. It never prints
response bodies, request IDs, object paths, credentials, or personal data.

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
   unavailable licensed place, expired typing state, cleanup-eligible media
   object, expired discovery lease, and old discovery rate bucket. Verify each
   reaches its documented terminal state and storage is deleted before database
   finalization. Seed more than one discovery-cleanup batch and verify the
   reported backlog withholds the success heartbeat until a later run drains it.
   Hold one discovery admission lock during a cleanup pass and verify that its
   skipped operation also withholds the heartbeat.
5. Confirm the external heartbeat and missed-heartbeat alert, then inject one
   invalid worker secret and verify the workflow fails without pinging success.
6. Record commit SHA, workflow run URL, Supabase project, UTC timestamps,
   redacted before/after queries, storage checks, alert receipt, operators, and
   sign-off. Do not put secrets or personal data in the evidence bundle.

Account deletion and media cleanup remain release blockers until this evidence
exists in the production target. A committed schedule is executable control
plane code, not proof that its external secrets, monitor, or workflow are active.
