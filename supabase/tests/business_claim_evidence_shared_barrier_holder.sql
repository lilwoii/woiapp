\set ON_ERROR_STOP on

begin;
select public.prepare_media_cleanup_batch();
\echo SPOTTR_CLAIM_EVIDENCE_SHARED_BARRIER_READY
\prompt '' release_signal
rollback;
