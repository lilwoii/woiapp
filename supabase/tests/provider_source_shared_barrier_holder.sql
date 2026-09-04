\set ON_ERROR_STOP on

begin;
update private.provider_business_sources
set source_status = source_status
where false;
\echo SPOTTR_PROVIDER_SOURCE_SHARED_BARRIER_READY
\prompt '' release_signal
rollback;
