\set ON_ERROR_STOP on

begin;
insert into private.provider_rate_limit_buckets (
  provider_slug,
  signing_key_id,
  window_started_at,
  request_count
)
select
  null::text,
  null::text,
  null::timestamptz,
  null::integer
where false;
\echo SPOTTR_PROVIDER_INGEST_SHARED_BARRIER_READY
\prompt '' release_signal
rollback;
