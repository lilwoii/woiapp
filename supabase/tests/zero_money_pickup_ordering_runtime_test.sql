\set ON_ERROR_STOP on

-- Run after shadow_ordering_runtime_setup.sql, the foundation migration, and
-- 20260831000000_zero_money_pickup_ordering_vertical_slice.sql.  This is kept
-- as a standalone SQL probe so CI can run it without changing client code.

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select set_config('request.jwt.claim.aal', 'aal2', false);

insert into public.order_capacity_slots (
  id, business_id, location_id, starts_at, ends_at, capacity
) values (
  'abababab-abab-4aba-8aba-abababababab',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  now() + interval '20 minutes', now() + interval '90 minutes', 1
);

do $$
declare
  menu jsonb;
  item jsonb;
  option_group jsonb;
  available_options integer;
begin
  menu := public.get_shadow_orderable_menu(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  if menu ->> 'currency' <> 'USD'
    or menu ->> 'acceptance_mode' <> 'manual'
    or menu ->> 'public_ordering_enabled' <> 'false'
    or menu ->> 'payment_enabled' <> 'false'
    or jsonb_array_length(menu -> 'items') <> 1
  then
    raise exception 'shadow menu projection is not fail-closed';
  end if;
  for item in select value from jsonb_array_elements(menu -> 'items') loop
    for option_group in select value from jsonb_array_elements(item -> 'option_groups') loop
      available_options := jsonb_array_length(option_group -> 'options');
      if (option_group ->> 'minimum_selections')::integer > available_options
        or (option_group ->> 'maximum_selections')::integer > available_options
        or available_options = 0
      then
        raise exception 'menu exposed an unavailable modifier group';
      end if;
    end loop;
  end loop;
end;
$$;

create temporary table shadow_quote_receipt as
select public.quote_shadow_order(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'abababab-abab-4aba-8aba-abababababab',
  now() + interval '30 minutes',
  now() + interval '45 minutes',
  '[{"item_version_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","quantity":2,"option_version_ids":[]}]'::jsonb,
  'quote-shadow-runtime-key-0001'
) as receipt;

do $$
declare
  original jsonb;
  replay jsonb;
  quote_id uuid;
begin
  select receipt into original from shadow_quote_receipt;
  replay := public.quote_shadow_order(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'abababab-abab-4aba-8aba-abababababab',
    (original ->> 'pickup_starts_at')::timestamptz,
    (original ->> 'pickup_ends_at')::timestamptz,
    '[{"item_version_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","quantity":2,"option_version_ids":[]}]'::jsonb,
    'quote-shadow-runtime-key-0001'
  );
  if replay <> original then raise exception 'quote replay changed response'; end if;
  quote_id := (original ->> 'quote_public_id')::uuid;
  if (select count(*) from public.pickup_order_quotes where public_id = quote_id) <> 1
    or (select reserved_count from public.order_capacity_slots
        where id = 'abababab-abab-4aba-8aba-abababababab') <> 0
    or (original ->> 'acceptance_mode') <> 'manual'
    or (select quote.snapshot ->> 'acceptance_mode'
        from public.pickup_order_quotes quote where quote.public_id = quote_id) <> 'manual'
    or (select (quote.snapshot ->> 'acceptance_timeout_seconds')::integer
        from public.pickup_order_quotes quote where quote.public_id = quote_id) <> 300
  then
    raise exception 'quote consumed capacity or was not persisted';
  end if;
end;
$$;

do $$
begin
  begin
    perform public.quote_shadow_order(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'abababab-abab-4aba-8aba-abababababab',
      now() + interval '30 minutes', now() + interval '45 minutes',
      '[{"item_version_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","quantity":2,"option_version_ids":[],"client_price_minor":1}]'::jsonb,
      'quote-shadow-extra-field-key'
    );
    raise exception 'client-supplied price/extra field was accepted';
  exception when others then
    if sqlerrm = 'client-supplied price/extra field was accepted'
      or sqlerrm <> 'INVALID_ORDER_LINE'
    then raise; end if;
  end;
  begin
    perform public.quote_shadow_order(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'abababab-abab-4aba-8aba-abababababab',
      now() + interval '30 minutes', now() + interval '45 minutes',
      '[{"item_version_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","quantity":2,"option_version_ids":["99999999-9999-4999-8999-999999999999"]}]'::jsonb,
      'quote-shadow-mismatched-option'
    );
    raise exception 'mismatched option was accepted';
  exception when others then
    if sqlerrm = 'mismatched option was accepted'
      or sqlerrm <> 'ORDER_OPTION_UNAVAILABLE'
    then raise; end if;
  end;
  begin
    perform public.quote_shadow_order(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'abababab-abab-4aba-8aba-abababababab',
      now() + interval '30 minutes', now() + interval '45 minutes',
      '[{"item_version_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","quantity":2,"option_version_ids":["99999999-9999-4999-8999-999999999999","99999999-9999-4999-8999-999999999999"]}]'::jsonb,
      'quote-shadow-duplicate-option'
    );
    raise exception 'duplicate option was accepted';
  exception when others then
    if sqlerrm = 'duplicate option was accepted'
      or sqlerrm <> 'INVALID_ORDER_OPTION_SET'
    then raise; end if;
  end;
  begin
    perform public.quote_shadow_order(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'abababab-abab-4aba-8aba-abababababab',
      now() + interval '30 minutes', now() + interval '45 minutes',
      '[{"item_version_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","quantity":1,"option_version_ids":[]}]'::jsonb,
      'quote-shadow-runtime-key-0001'
    );
    raise exception 'same idempotency key accepted changed intent';
  exception when others then
    if sqlerrm = 'same idempotency key accepted changed intent'
      or sqlerrm <> 'IDEMPOTENCY_CONFLICT'
    then raise; end if;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
select set_config('request.jwt.claim.aal', 'aal2', false);
do $$
begin
  begin
    perform public.quote_shadow_order(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'abababab-abab-4aba-8aba-abababababab',
      now() + interval '30 minutes', now() + interval '45 minutes',
      '[{"item_version_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","quantity":2,"option_version_ids":[]}]'::jsonb,
      'quote-shadow-nonstaff-key'
    );
    raise exception 'nonstaff quote unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'nonstaff quote unexpectedly succeeded'
      or sqlerrm <> 'STAFF_REQUIRED'
    then raise; end if;
  end;
  begin
    perform public.place_shadow_order(
      (select (receipt ->> 'quote_public_id')::uuid from shadow_quote_receipt),
      1,
      'place-shadow-nonstaff-key'
    );
    raise exception 'nonstaff placement unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'nonstaff placement unexpectedly succeeded'
      or sqlerrm <> 'STAFF_REQUIRED'
    then raise; end if;
  end;
  begin
    perform public.cancel_shadow_order(
      '33333333-3333-4333-8333-333333333333',
      1,
      'customer_cancelled_before_acceptance',
      'cancel-shadow-nonstaff-key'
    );
    raise exception 'nonstaff cancellation unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'nonstaff cancellation unexpectedly succeeded'
      or sqlerrm <> 'STAFF_REQUIRED'
    then raise; end if;
  end;
end;
$$;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select set_config('request.jwt.claim.aal', 'aal1', false);
do $$
begin
  begin
    perform public.quote_shadow_order(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'abababab-abab-4aba-8aba-abababababab',
      now() + interval '30 minutes', now() + interval '45 minutes',
      '[{"item_version_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","quantity":2,"option_version_ids":[]}]'::jsonb,
      'quote-shadow-aal1-key'
    );
    raise exception 'AAL1 quote unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'AAL1 quote unexpectedly succeeded'
      or sqlerrm <> 'AAL2_REQUIRED'
    then raise; end if;
  end;
  begin
    perform public.place_shadow_order(
      (select (receipt ->> 'quote_public_id')::uuid from shadow_quote_receipt),
      1,
      'place-shadow-aal1-key'
    );
    raise exception 'AAL1 placement unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'AAL1 placement unexpectedly succeeded'
      or sqlerrm <> 'AAL2_REQUIRED'
    then raise; end if;
  end;
  begin
    perform public.cancel_shadow_order(
      '33333333-3333-4333-8333-333333333333',
      1,
      'customer_cancelled_before_acceptance',
      'cancel-shadow-aal1-key'
    );
    raise exception 'AAL1 cancellation unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'AAL1 cancellation unexpectedly succeeded'
      or sqlerrm <> 'AAL2_REQUIRED'
    then raise; end if;
  end;
end;
$$;
select set_config('request.jwt.claim.aal', 'aal2', false);

insert into private.platform_roles (user_id, role, active)
values ('22222222-2222-4222-8222-222222222222', 'admin', true)
on conflict (user_id, role) do update set active = true;
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
do $$
begin
  begin
    perform public.place_shadow_order(
      (select (receipt ->> 'quote_public_id')::uuid from shadow_quote_receipt),
      1,
      'place-shadow-nonowner-key'
    );
    raise exception 'non-owner placement unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'non-owner placement unexpectedly succeeded'
      or sqlerrm <> 'ORDER_QUOTE_NOT_FOUND'
    then raise; end if;
  end;
end;
$$;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);

do $$
begin
  begin
    perform public.place_shadow_order(
      (select (receipt ->> 'quote_public_id')::uuid from shadow_quote_receipt),
      2,
      'place-shadow-version-conflict-key'
    );
    raise exception 'quote version conflict was accepted';
  exception when others then
    if sqlerrm = 'quote version conflict was accepted'
      or sqlerrm <> 'ORDER_QUOTE_VERSION_CONFLICT'
    then raise; end if;
  end;
end;
$$;

do $$
declare
  quote_public_id uuid;
begin
  select (receipt ->> 'quote_public_id')::uuid into quote_public_id
  from shadow_quote_receipt;
  update public.business_order_settings
  set acceptance_mode = 'automatic'
  where business_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  begin
    perform public.get_shadow_orderable_menu(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    );
    raise exception 'automatic shadow menu unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'automatic shadow menu unexpectedly succeeded'
      or sqlerrm <> 'SHADOW_MANUAL_ACCEPTANCE_REQUIRED'
    then raise; end if;
  end;
  begin
    perform public.place_shadow_order(
      quote_public_id,
      1,
      'place-shadow-policy-changed-key'
    );
    raise exception 'automatic policy change unexpectedly placed quote';
  exception when others then
    if sqlerrm = 'automatic policy change unexpectedly placed quote'
      or sqlerrm <> 'ORDER_QUOTE_POLICY_CHANGED'
    then raise; end if;
  end;
  if exists (
       select 1 from public.orders order_row
       join public.pickup_order_quotes quote on quote.id = order_row.quote_id
       where quote.public_id = quote_public_id
     )
     or (select reserved_count from public.order_capacity_slots
         where id = 'abababab-abab-4aba-8aba-abababababab') <> 0
     or (select status from public.pickup_order_quotes where public_id = quote_public_id) <> 'open'
  then
    raise exception 'automatic policy change mutated order or capacity';
  end if;
  update public.business_order_settings
  set acceptance_mode = 'manual'
  where business_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
end;
$$;

create temporary table shadow_place_receipt as
select public.place_shadow_order(
  (select (receipt ->> 'quote_public_id')::uuid from shadow_quote_receipt),
  1,
  'place-shadow-runtime-key-0001'
) as receipt;

do $$
declare
  original jsonb;
  replay jsonb;
  order_id uuid;
begin
  select receipt into original from shadow_place_receipt;
  replay := public.place_shadow_order(
    (original ->> 'quote_public_id')::uuid,
    1,
    'place-shadow-runtime-key-0001'
  );
  if replay <> original then raise exception 'place replay changed response'; end if;
  order_id := (original ->> 'order_public_id')::uuid;
  if not exists (
    select 1 from public.orders
    where public_id = order_id and is_shadow and payment_state = 'not_required'
      and total_minor = 0 and shadow_discount_minor = item_subtotal_minor
      and quote_id is not null
  ) then
    raise exception 'placed order is not an immutable zero-money receipt';
  end if;
  if (select status from public.pickup_order_quotes
      where public_id = (original ->> 'quote_public_id')::uuid) <> 'placed'
    or (select reserved_count from public.order_capacity_slots
        where id = 'abababab-abab-4aba-8aba-abababababab') <> 1
  then
    raise exception 'placement did not atomically consume capacity';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
do $$
begin
  begin
    perform public.cancel_shadow_order(
      (select (receipt ->> 'order_public_id')::uuid from shadow_place_receipt),
      1,
      'customer_cancelled_before_acceptance',
      'cancel-shadow-nonowner-key'
    );
    raise exception 'non-owner cancellation unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'non-owner cancellation unexpectedly succeeded'
      or sqlerrm <> 'ORDER_NOT_FOUND'
    then raise; end if;
  end;
end;
$$;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);

do $$
begin
  begin
    perform public.place_shadow_order(
      (select (receipt ->> 'quote_public_id')::uuid from shadow_place_receipt),
      1,
      'place-shadow-runtime-key-0002'
    );
    raise exception 'same quote was placed twice';
  exception when others then
    if sqlerrm = 'same quote was placed twice'
      or sqlerrm <> 'ORDER_QUOTE_NOT_OPEN'
    then raise; end if;
  end;
  if (select reserved_count from public.order_capacity_slots
      where id = 'abababab-abab-4aba-8aba-abababababab') <> 1
  then
    raise exception 'second placement changed capacity';
  end if;
end;
$$;

do $$
declare
  order_public_id uuid;
begin
  select (receipt ->> 'order_public_id')::uuid into order_public_id
  from shadow_place_receipt;
  begin
    perform public.cancel_shadow_order(
      order_public_id,
      2,
      'customer_cancelled_before_acceptance',
      'cancel-shadow-version-conflict-key'
    );
    raise exception 'order version conflict was accepted';
  exception when others then
    if sqlerrm = 'order version conflict was accepted'
      or sqlerrm <> 'ORDER_VERSION_CONFLICT'
    then raise; end if;
  end;
  begin
    perform public.cancel_shadow_order(
      order_public_id,
      1,
      'merchant_cancelled',
      'cancel-shadow-invalid-reason-key'
    );
    raise exception 'customer cancellation accepted a merchant reason';
  exception when others then
    if sqlerrm = 'customer cancellation accepted a merchant reason'
      or sqlerrm <> 'INVALID_ORDER_CANCELLATION'
    then raise; end if;
  end;
  if (select fulfillment_state from public.orders where public_id = order_public_id) <> 'pending_acceptance'
    or (select reserved_count from public.order_capacity_slots
        where id = 'abababab-abab-4aba-8aba-abababababab') <> 1
  then
    raise exception 'rejected cancellation changed order or capacity';
  end if;
end;
$$;

create temporary table shadow_cancel_receipt as
select public.cancel_shadow_order(
  (select (receipt ->> 'order_public_id')::uuid from shadow_place_receipt),
  1,
  'customer_cancelled_before_acceptance',
  'cancel-shadow-runtime-key-0001'
) as receipt;

do $$
declare
  original jsonb;
  replay jsonb;
begin
  select receipt into original from shadow_cancel_receipt;
  replay := public.cancel_shadow_order(
    (original ->> 'order_public_id')::uuid,
    1,
    'customer_cancelled_before_acceptance',
    'cancel-shadow-runtime-key-0001'
  );
  if replay <> original then raise exception 'cancel replay changed response'; end if;
  if not exists (
    select 1 from public.orders
    where public_id = (original ->> 'order_public_id')::uuid
      and fulfillment_state = 'cancelled' and version = 2 and total_minor = 0
  ) then
    raise exception 'cancel did not move the zero-money order';
  end if;
  if (select reserved_count + accepted_count from public.order_capacity_slots
      where id = 'abababab-abab-4aba-8aba-abababababab') <> 0
  then
    raise exception 'cancel did not release capacity exactly once';
  end if;
end;
$$;

insert into public.order_capacity_slots (
  id, business_id, location_id, starts_at, ends_at, capacity
) values (
  'acacacac-acac-4aca-8aca-acacacacacac',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  now() + interval '20 minutes', now() + interval '90 minutes', 1
);

create temporary table shadow_accepted_quote_receipt as
select public.quote_shadow_order(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'acacacac-acac-4aca-8aca-acacacacacac',
  now() + interval '30 minutes', now() + interval '45 minutes',
  '[{"item_version_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","quantity":1,"option_version_ids":[]}]'::jsonb,
  'quote-shadow-accepted-key-0001'
) as receipt;
create temporary table shadow_accepted_place_receipt as
select public.place_shadow_order(
  (select (receipt ->> 'quote_public_id')::uuid from shadow_accepted_quote_receipt),
  1,
  'place-shadow-accepted-key-0001'
) as receipt;
select public.transition_shadow_order(
  (select (receipt ->> 'order_public_id')::uuid from shadow_accepted_place_receipt),
  1, 'accepted', null, 'accept-shadow-runtime-key-0001'
);
do $$
begin
  begin
    perform public.cancel_shadow_order(
      (select (receipt ->> 'order_public_id')::uuid from shadow_accepted_place_receipt),
      2,
      'customer_cancelled_before_acceptance',
      'cancel-shadow-accepted-key-0001'
    );
    raise exception 'customer cancelled an accepted order';
  exception when others then
    if sqlerrm = 'customer cancelled an accepted order'
      or sqlerrm <> 'ORDER_NOT_CANCELLABLE'
    then raise; end if;
  end;
  if (select accepted_count from public.order_capacity_slots
      where id = 'acacacac-acac-4aca-8aca-acacacacacac') <> 1
  then
    raise exception 'rejected customer cancellation released accepted capacity';
  end if;
end;
$$;
select public.transition_shadow_order(
  (select (receipt ->> 'order_public_id')::uuid from shadow_accepted_place_receipt),
  2, 'cancelled', 'merchant_cancelled', 'merchant-cancel-runtime-key-0001'
);

insert into public.mobile_stops (
  id, business_id, location_id, starts_at, ends_at, state
) values (
  'adadadad-adad-4ada-8ada-adadadadadad',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  now() + interval '20 minutes', now() + interval '90 minutes', 'scheduled'
);
insert into public.order_capacity_slots (
  id, business_id, location_id, mobile_stop_id, starts_at, ends_at, capacity
) values (
  'aeaeaeae-aeae-4aea-8aea-aeaeaeaeaeae',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'adadadad-adad-4ada-8ada-adadadadadad',
  now() + interval '20 minutes', now() + interval '90 minutes', 1
);
create temporary table shadow_stale_stop_quote_receipt as
select public.quote_shadow_order(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'aeaeaeae-aeae-4aea-8aea-aeaeaeaeaeae',
  now() + interval '30 minutes', now() + interval '45 minutes',
  '[{"item_version_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","quantity":1,"option_version_ids":[]}]'::jsonb,
  'quote-shadow-stale-stop-key-0001'
) as receipt;
update public.mobile_stops set state = 'cancelled'
where id = 'adadadad-adad-4ada-8ada-adadadadadad';
do $$
begin
  begin
    perform public.place_shadow_order(
      (select (receipt ->> 'quote_public_id')::uuid from shadow_stale_stop_quote_receipt),
      1,
      'place-shadow-stale-stop-key-0001'
    );
    raise exception 'cancelled mobile stop accepted a stale quote';
  exception when others then
    if sqlerrm = 'cancelled mobile stop accepted a stale quote'
      or sqlerrm <> 'MOBILE_STOP_UNAVAILABLE'
    then raise; end if;
  end;
  if (select reserved_count + accepted_count from public.order_capacity_slots
      where id = 'aeaeaeae-aeae-4aea-8aea-aeaeaeaeaeae') <> 0
  then
    raise exception 'stale mobile-stop quote consumed capacity';
  end if;
end;
$$;

-- Seed an already-expired open quote only as test fixture data.  The public
-- RPC cannot forge expiry because the quote snapshot/expiry fields are
-- immutable; placement must reject it before touching capacity.
insert into public.pickup_order_quotes (
  id, public_id, customer_id, business_id, location_id, mobile_stop_id,
  catalog_version_id, capacity_slot_id, is_shadow, currency,
  item_subtotal_minor, shadow_discount_minor, tax_minor, tip_minor, fee_minor,
  total_minor, payment_state, pickup_starts_at, pickup_ends_at,
  terms_version, refund_policy_version, version, snapshot, snapshot_hash,
  status, placed_order_id, expires_at, created_at, updated_at
)
select
  'edededed-eded-4ede-8ede-edededededed',
  'efefefef-efef-4efe-8efe-efefefefefef',
  quote.customer_id, quote.business_id, quote.location_id, quote.mobile_stop_id,
  quote.catalog_version_id, quote.capacity_slot_id, true, quote.currency,
  quote.item_subtotal_minor, quote.shadow_discount_minor, 0, 0, 0, 0,
  'not_required', quote.pickup_starts_at, quote.pickup_ends_at,
  quote.terms_version, quote.refund_policy_version, 1, quote.snapshot,
  quote.snapshot_hash, 'open', null, now() - interval '2 minutes',
  now() - interval '10 minutes', now() - interval '10 minutes'
from public.pickup_order_quotes quote
where quote.public_id = (select (receipt ->> 'quote_public_id')::uuid from shadow_accepted_quote_receipt);
insert into public.pickup_order_quotes (
  id, public_id, customer_id, business_id, location_id, mobile_stop_id,
  catalog_version_id, capacity_slot_id, is_shadow, currency,
  item_subtotal_minor, shadow_discount_minor, tax_minor, tip_minor, fee_minor,
  total_minor, payment_state, pickup_starts_at, pickup_ends_at,
  terms_version, refund_policy_version, version, snapshot, snapshot_hash,
  status, placed_order_id, expires_at, created_at, updated_at
)
select
  'fdfdfdfd-fdfd-4fdf-8fdf-fdfdfdfdfdfd',
  'fefefefe-fefe-4efe-8efe-fefefefefefe',
  quote.customer_id, quote.business_id, quote.location_id, quote.mobile_stop_id,
  quote.catalog_version_id, quote.capacity_slot_id, true, quote.currency,
  quote.item_subtotal_minor, quote.shadow_discount_minor, 0, 0, 0, 0,
  'not_required', quote.pickup_starts_at, quote.pickup_ends_at,
  quote.terms_version, quote.refund_policy_version, 1, quote.snapshot,
  quote.snapshot_hash, 'open', null, now() - interval '1 minute',
  now() - interval '10 minutes', now() - interval '10 minutes'
from public.pickup_order_quotes quote
where quote.public_id = (select (receipt ->> 'quote_public_id')::uuid from shadow_accepted_quote_receipt);
do $$
begin
  begin
    perform public.place_shadow_order(
      'efefefef-efef-4efe-8efe-efefefefefef', 1,
      'place-shadow-expired-key-0001'
    );
    raise exception 'expired quote was placed';
  exception when others then
    if sqlerrm = 'expired quote was placed'
      or sqlerrm <> 'ORDER_QUOTE_EXPIRED'
    then raise; end if;
  end;
end;
$$;
select set_config('request.jwt.claim.role', 'authenticated', false);
do $$
begin
  begin
    perform public.expire_shadow_order_quotes(1);
    raise exception 'authenticated expiry maintenance unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'authenticated expiry maintenance unexpectedly succeeded'
      or sqlerrm <> 'SERVICE_ROLE_REQUIRED'
    then raise; end if;
  end;
end;
$$;
select set_config('request.jwt.claim.role', 'service_role', false);
do $$
declare
  maintenance jsonb;
begin
  select public.expire_shadow_order_quotes(1) into maintenance;
  if (maintenance ->> 'expired')::integer <> 1
    or not (maintenance ->> 'more_work')::boolean
    or (maintenance ->> 'skipped')::boolean
  then
    raise exception 'expired quote maintenance did not report remaining work';
  end if;
  if (select status from public.pickup_order_quotes
      where public_id = 'efefefef-efef-4efe-8efe-efefefefefef') <> 'expired' then
    raise exception 'expired quote worker did not persist expired state';
  end if;
  select public.expire_shadow_order_quotes(10) into maintenance;
  if (maintenance ->> 'expired')::integer <> 1
    or (maintenance ->> 'more_work')::boolean
    or (maintenance ->> 'skipped')::boolean
  then
    raise exception 'expired quote maintenance did not drain remaining work';
  end if;
  if (select status from public.pickup_order_quotes
      where public_id = 'fefefefe-fefe-4efe-8efe-fefefefefefe') <> 'expired' then
    raise exception 'second expired quote was not persisted';
  end if;
end;
$$;

select 'zero-money pickup ordering runtime passed' as result;
