\set ON_ERROR_STOP on

begin;
-- Statement triggers fire even when no row matches, so this proves the actual
-- provider-account mutation path acquires the shared transaction barrier
-- without changing fixture data.
update private.provider_accounts
set updated_at = updated_at
where false;
\echo SPOTTR_PROVIDER_MUTATION_SHARED_BARRIER_READY
\prompt '' release_signal
rollback;
