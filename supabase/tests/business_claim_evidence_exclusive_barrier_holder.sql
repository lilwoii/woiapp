\set ON_ERROR_STOP on

begin;
select pg_catalog.pg_advisory_xact_lock(7742004, 1);
\echo SPOTTR_CLAIM_EVIDENCE_EXCLUSIVE_BARRIER_READY
\prompt '' release_signal
rollback;
