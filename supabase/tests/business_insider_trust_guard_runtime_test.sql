\set ON_ERROR_STOP on

-- This probe deliberately uses a rollback-only fixture and real JWT claims so
-- the guard is exercised through both the authenticated RPCs and the table
-- triggers. It is kept separate from the broad runtime fixture to make the
-- trust boundary easy to diagnose when a migration changes.
begin;

select pg_catalog.set_config('request.jwt.claims', '{}'::text, true);

do $trust_guard_installation$
declare
  review_guard text;
  reaction_guard text;
  reset_guard text;
  reset_trigger text;
begin
  select pg_catalog.pg_get_functiondef(
    'private.guard_business_insider_review()'::regprocedure
  ) into review_guard;
  select pg_catalog.pg_get_functiondef(
    'private.guard_business_insider_review_reaction()'::regprocedure
  ) into reaction_guard;
  select pg_catalog.pg_get_functiondef(
    'private.reset_review_trust_signals_on_revision()'::regprocedure
  ) into reset_guard;
  select pg_catalog.pg_get_triggerdef(trigger_row.oid)
  into reset_trigger
  from pg_catalog.pg_trigger trigger_row
  where trigger_row.tgrelid = 'public.reviews'::regclass
    and not trigger_row.tgisinternal
    and trigger_row.tgname = 'reviews_reset_trust_signals_on_revision';

  if review_guard not like '%private.assert_external_review_trust_actor%'
    or reaction_guard not like '%old.review_id%'
    or reaction_guard not like '%new.review_id%'
    or reset_guard not like '%current_setting%'
    or reset_trigger is null
    or lower(reset_trigger) not like '%before update of rating, body%'
    or not exists (
      select 1
      from pg_catalog.pg_class relation
      where relation.oid = 'public.business_responses'::regclass
    )
  then
    raise exception 'Business-insider trust guard installation is incomplete';
  end if;
end;
$trust_guard_installation$;

insert into auth.users (
  id,
  aud,
  role,
  email,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    'b1000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'trust-reviewer@spottr.invalid',
    now(),
    '{}'::jsonb,
    '{"username":"trust_reviewer","display_name":"Trust Reviewer","terms_accepted":true}'::jsonb,
    now(),
    now()
  ),
  (
    'b2000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'trust-external@spottr.invalid',
    now(),
    '{}'::jsonb,
    '{"username":"trust_external","display_name":"Trust External","terms_accepted":true}'::jsonb,
    now(),
    now()
  ),
  (
    'b3000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'trust-insider@spottr.invalid',
    now(),
    '{}'::jsonb,
    '{"username":"trust_insider","display_name":"Trust Insider","terms_accepted":true}'::jsonb,
    now(),
    now()
  );

insert into public.businesses (
  id,
  kind,
  name,
  slug,
  state,
  verification,
  provenance,
  created_by
)
values
  (
    'b7000000-0000-4000-8000-000000000007',
    'restaurant',
    'Trust Boundary Kitchen',
    'trust-boundary-kitchen',
    'pending',
    'verified',
    'owner',
    'b1000000-0000-4000-8000-000000000001'
  ),
  (
    'b7100000-0000-4000-8000-000000000007',
    'restaurant',
    'Trust Boundary Draft',
    'trust-boundary-draft',
    'draft',
    'pending',
    'owner',
    'b1000000-0000-4000-8000-000000000001'
  );

insert into public.business_members (
  business_id,
  user_id,
  role,
  status,
  accepted_at
)
values
  (
    'b7000000-0000-4000-8000-000000000007',
    'b3000000-0000-4000-8000-000000000003',
    'owner',
    'active',
    now()
  ),
  (
    'b7100000-0000-4000-8000-000000000007',
    'b3000000-0000-4000-8000-000000000003',
    'owner',
    'active',
    now()
  );

-- The primary business is made fully eligible so the canonical RPCs execute
-- the same public-review checks used in production.
insert into public.media_assets (
  id,
  owner_id,
  business_id,
  storage_path,
  mime_type,
  width,
  height,
  byte_size,
  sha256,
  source,
  license_note,
  quarantine_state,
  processed_storage_path,
  scan_completed_at,
  moderation
)
values (
  'b7200000-0000-4000-8000-000000000007',
  'b3000000-0000-4000-8000-000000000003',
  'b7000000-0000-4000-8000-000000000007',
  'published/runtime/trust-boundary-logo.jpg',
  'image/jpeg',
  512,
  512,
  4096,
  repeat('b', 64),
  'licensed_provider',
  'Rollback-only trust-boundary runtime fixture.',
  'clean',
  'published/runtime/trust-boundary-logo-processed.jpg',
  now(),
  'approved'
);

update public.businesses
set logo_asset_id = 'b7200000-0000-4000-8000-000000000007'
where id = 'b7000000-0000-4000-8000-000000000007';

insert into public.business_private_details (
  business_id,
  business_email,
  business_phone
)
values (
  'b7000000-0000-4000-8000-000000000007',
  'trust-boundary@spottr.invalid',
  '+12135550123'
);

insert into public.business_locations (
  id,
  business_id,
  label,
  address_line,
  city,
  region,
  postal_code,
  point,
  is_primary,
  is_approximate,
  public_address,
  publication_state
)
values (
  'b7300000-0000-4000-8000-000000000007',
  'b7000000-0000-4000-8000-000000000007',
  'Trust boundary address',
  '100 Trust Way',
  'Los Angeles',
  'CA',
  '90001',
  public.st_setsrid(public.st_makepoint(-118.24, 34.05), 4326)::public.geography,
  true,
  false,
  true,
  'published'
);

insert into public.weekly_hours (
  business_id,
  weekday,
  opens_at,
  closes_at,
  is_closed
)
select
  'b7000000-0000-4000-8000-000000000007',
  weekday::smallint,
  '00:00'::time,
  '23:59'::time,
  false
from generate_series(0, 6) weekday;

insert into public.business_payments (business_id, payment)
values ('b7000000-0000-4000-8000-000000000007', 'cash');

insert into public.menu_sections (
  id,
  business_id,
  name,
  is_published
)
values (
  'b7400000-0000-4000-8000-000000000007',
  'b7000000-0000-4000-8000-000000000007',
  'Trust menu',
  true
);

insert into public.menu_items (
  id,
  section_id,
  name,
  price_minor,
  currency,
  availability,
  is_published
)
values (
  'b7500000-0000-4000-8000-000000000007',
  'b7400000-0000-4000-8000-000000000007',
  'Trust meal',
  1200,
  'USD',
  'available',
  true
);

update public.businesses
set state = 'published',
    verification = 'verified'
where id = 'b7000000-0000-4000-8000-000000000007';

insert into public.reviews (
  id,
  business_id,
  author_id,
  rating,
  body,
  moderation
)
values
  (
    'b8000000-0000-4000-8000-000000000008',
    'b7000000-0000-4000-8000-000000000007',
    'b1000000-0000-4000-8000-000000000001',
    4,
    'A carefully prepared review for the trust runtime fixture.',
    'approved'
  ),
  (
    'b8100000-0000-4000-8000-000000000008',
    'b7000000-0000-4000-8000-000000000007',
    'b2000000-0000-4000-8000-000000000002',
    4,
    'A second review for direct trigger coverage.',
    'approved'
  ),
  (
    'b8200000-0000-4000-8000-000000000008',
    'b7100000-0000-4000-8000-000000000007',
    'b2000000-0000-4000-8000-000000000002',
    4,
    'A draft-business review for cross-business trigger coverage.',
    'approved'
  );

do $business_insider_trust_acl$
begin
  if not has_function_privilege(
      'authenticated',
      'public.set_review_reaction(uuid, smallint)',
      'execute'
    )
    or not has_function_privilege(
      'authenticated',
      'public.add_review_profile_comment(uuid, text)',
      'execute'
    )
    or has_function_privilege(
      'anon',
      'public.set_review_reaction(uuid, smallint)',
      'execute'
    )
    or has_function_privilege(
      'anon',
      'public.add_review_profile_comment(uuid, text)',
      'execute'
    )
  then
    raise exception 'Canonical trust RPC ACLs are not account-only';
  end if;

  if has_table_privilege('authenticated', 'public.review_reactions', 'insert')
    or has_table_privilege('authenticated', 'public.review_reactions', 'update')
    or has_table_privilege('authenticated', 'public.review_reactions', 'delete')
    or has_table_privilege('authenticated', 'public.review_profile_comments', 'insert')
    or has_table_privilege('authenticated', 'public.review_profile_comments', 'update')
    or has_table_privilege('authenticated', 'public.review_profile_comments', 'delete')
  then
    raise exception 'Trust-signal base tables are directly writable';
  end if;

  if not (
    select relrowsecurity and relforcerowsecurity
    from pg_catalog.pg_class
    where oid = 'public.review_reactions'::regclass
  ) or not (
    select relrowsecurity and relforcerowsecurity
    from pg_catalog.pg_class
    where oid = 'public.review_profile_comments'::regclass
  ) then
    raise exception 'Trust-signal tables are not forced through RLS';
  end if;
end;
$business_insider_trust_acl$;

-- A non-member can leave a reaction through the canonical RPC, including the
-- helpful-count maintenance update emitted by its AFTER trigger.
set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"b2000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}',
  true
);

do $external_reaction$
declare
  result record;
  reaction_summary record;
  review_projection record;
begin
  select * into result
  from public.set_review_reaction(
    'b8000000-0000-4000-8000-000000000008',
    1
  );

  select up_count, down_count, viewer_reaction
  into reaction_summary
  from public.public_review_reaction_summary
  where review_id = 'b8000000-0000-4000-8000-000000000008';

  select helpful_count
  into review_projection
  from public.public_reviews
  where review_id = 'b8000000-0000-4000-8000-000000000008';

  if result.up_count is distinct from 1
    or result.down_count is distinct from 0
    or result.viewer_reaction is distinct from 1
    or reaction_summary.up_count is distinct from 1
    or reaction_summary.down_count is distinct from 0
    or reaction_summary.viewer_reaction is distinct from 1
    or review_projection.helpful_count is distinct from 1
  then
    raise exception 'Non-member reaction did not persist with its helpful count';
  end if;
end;
$external_reaction$;

-- Turn the reactor into a business member. Removing that account's existing
-- reaction remains an allowed cleanup operation, but adding/changing a signal
-- is denied after the role change.
reset role;
select pg_catalog.set_config('request.jwt.claims', '{}'::text, true);
insert into public.business_members (
  business_id,
  user_id,
  role,
  status,
  accepted_at
)
values (
  'b7000000-0000-4000-8000-000000000007',
  'b2000000-0000-4000-8000-000000000002',
  'staff',
  'active',
  now()
);

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"b2000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}',
  true
);

do $external_reaction_cleanup$
declare
  result record;
  reaction_summary record;
begin
  select * into result
  from public.set_review_reaction(
    'b8000000-0000-4000-8000-000000000008',
    0
  );

  select up_count, down_count, viewer_reaction
  into reaction_summary
  from public.public_review_reaction_summary
  where review_id = 'b8000000-0000-4000-8000-000000000008';

  if result.up_count is distinct from 0
    or result.down_count is distinct from 0
    or result.viewer_reaction is distinct from 0
    or reaction_summary.up_count is distinct from 0
    or reaction_summary.down_count is distinct from 0
    or reaction_summary.viewer_reaction is distinct from 0
  then
    raise exception 'A member could not remove its pre-existing reaction';
  end if;
end;
$external_reaction_cleanup$;

-- A business insider is denied on the insert path. Seed a row with a null
-- actor to exercise the later update/no-op paths without granting clients base
-- table access.
reset role;
select pg_catalog.set_config('request.jwt.claims', '{}'::text, true);
insert into public.review_reactions (review_id, user_id, reaction)
values (
  'b8000000-0000-4000-8000-000000000008',
  'b3000000-0000-4000-8000-000000000003',
  -1
);

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"b3000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}',
  true
);

do $insider_rpc_guards$
declare
  operation text;
  target_review_id uuid;
begin
  foreach operation in array array['insert', 'update', 'no-op'] loop
    target_review_id := case
      when operation = 'insert' then 'b8100000-0000-4000-8000-000000000008'::uuid
      else 'b8000000-0000-4000-8000-000000000008'::uuid
    end;
    begin
      perform public.set_review_reaction(
        target_review_id,
        case operation when 'insert' then 1 when 'update' then 1 else -1 end
      );
      raise exception 'Insider % RPC unexpectedly succeeded', operation;
    exception
      when sqlstate '42501' then
        if sqlerrm <> 'BUSINESS_REVIEW_TRUST_BOUNDARY' then
          raise;
        end if;
    end;
  end loop;
end;
$insider_rpc_guards$;

-- Exercise the underlying BEFORE trigger as an insider too. The UPDATE moves
-- a reaction from the protected business to an external draft business; both
-- OLD and NEW business IDs must be checked, so the old-side membership blocks.
reset role;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"b3000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}',
  true
);

do $insider_raw_guards$
begin
  begin
    insert into public.review_reactions (review_id, user_id, reaction)
    values (
      'b8100000-0000-4000-8000-000000000008',
      'b3000000-0000-4000-8000-000000000003',
      1
    );
    raise exception 'Insider direct insert unexpectedly succeeded';
  exception
    when sqlstate '42501' then
      if sqlerrm <> 'BUSINESS_REVIEW_TRUST_BOUNDARY' then raise; end if;
  end;

  begin
    update public.review_reactions reaction
    set review_id = 'b8200000-0000-4000-8000-000000000008'
    where reaction.review_id = 'b8000000-0000-4000-8000-000000000008'
      and reaction.user_id = 'b3000000-0000-4000-8000-000000000003';
    raise exception 'Insider direct update unexpectedly succeeded';
  exception
    when sqlstate '42501' then
      if sqlerrm <> 'BUSINESS_REVIEW_TRUST_BOUNDARY' then raise; end if;
  end;
end;
$insider_raw_guards$;

do $insider_comment_guard$
begin
  begin
    perform public.add_review_profile_comment(
      'b8000000-0000-4000-8000-000000000008',
      'A professional profile question.'
    );
    raise exception 'Insider profile comment unexpectedly succeeded';
  exception
    when sqlstate '42501' then
      if sqlerrm <> 'BUSINESS_REVIEW_TRUST_BOUNDARY' then raise; end if;
  end;
end;
$insider_comment_guard$;

-- Revisions clear every prior reaction and the legacy helpful count in the
-- same parent update. This is the regression test for the nested AFTER DELETE
-- update conflict that the transaction-local marker prevents.
reset role;
select pg_catalog.set_config('request.jwt.claims', '{}'::text, true);
insert into public.review_reactions (review_id, user_id, reaction)
values (
  'b8000000-0000-4000-8000-000000000008',
  'b2000000-0000-4000-8000-000000000002',
  1
);

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',
  true
);

do $review_revision$
declare
  revised_id uuid;
begin
  select review_id
  into revised_id
  from public.submit_review(
    'b7000000-0000-4000-8000-000000000007',
    5,
    'A revised review with fresh evidence and no inherited reactions.',
    'trust-review-revision-0001',
    '{}'::uuid[]
  );

  if revised_id <> 'b8000000-0000-4000-8000-000000000008' then
    raise exception 'Review revision returned the wrong review';
  end if;
end;
$review_revision$;

reset role;
select pg_catalog.set_config('request.jwt.claims', '{}'::text, true);

do $review_revision_state$
declare
  reaction_count integer;
  review_helpful_count integer;
  revision_marker text;
begin
  select count(*)
  into reaction_count
  from public.review_reactions reaction
  where reaction.review_id = 'b8000000-0000-4000-8000-000000000008';

  select review.helpful_count
  into review_helpful_count
  from public.reviews review
  where review.id = 'b8000000-0000-4000-8000-000000000008';

  revision_marker := current_setting('spottr.review_revision_reset', true);
  if reaction_count <> 0
    or review_helpful_count <> 0
    or revision_marker is distinct from ''
    or not exists (
      select 1
      from public.reviews review
      where review.id = 'b8000000-0000-4000-8000-000000000008'
        and review.rating = 5
        and review.body = 'A revised review with fresh evidence and no inherited reactions.'
        and review.moderation = 'pending'
    )
  then
    raise exception 'Review revision did not atomically clear reactions/helpful state';
  end if;
end;
$review_revision_state$;

-- Service-owned and null-actor maintenance must retain the existing ability to
-- repair review rows without being treated as a business insider.
reset role;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);
set local role service_role;
update public.reviews
set rating = 4,
    body = 'Service maintenance rewrite for the trust fixture.'
where id = 'b8000000-0000-4000-8000-000000000008';

reset role;
select pg_catalog.set_config('request.jwt.claims', '{}'::text, true);
update public.reviews
set rating = 3,
    body = 'Null actor maintenance rewrite for the trust fixture.'
where id = 'b8000000-0000-4000-8000-000000000008';

do $maintenance_state$
begin
  if not exists (
    select 1
    from public.reviews review
    where review.id = 'b8000000-0000-4000-8000-000000000008'
      and review.rating = 3
      and review.body = 'Null actor maintenance rewrite for the trust fixture.'
      and review.helpful_count = 0
  ) then
    raise exception 'Service/null actor maintenance could not update the review';
  end if;
end;
$maintenance_state$;

rollback;
select 'business insider trust guard runtime passed' as result;
