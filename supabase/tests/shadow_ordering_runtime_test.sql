\set ON_ERROR_STOP on

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select set_config('request.jwt.claim.aal', 'aal2', false);

insert into auth.users values
  ('11111111-1111-4111-8111-111111111111', now()),
  ('22222222-2222-4222-8222-222222222222', now());
insert into public.profiles values
  ('11111111-1111-4111-8111-111111111111', 'active', now()),
  ('22222222-2222-4222-8222-222222222222', 'active', now());
insert into public.businesses values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'published', 'food_truck');
insert into public.business_members values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '11111111-1111-4111-8111-111111111111',
  'owner', 'active'
);
insert into private.platform_roles values (
  '11111111-1111-4111-8111-111111111111', 'admin', true
);
insert into public.business_locations values (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
);
insert into public.business_order_settings (
  business_id, pilot_mode, accepting_orders, refund_policy_version,
  terms_version, updated_by
) values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'shadow', true,
  'refunds-test-v1', 'terms-test-v1', '11111111-1111-4111-8111-111111111111'
);
insert into public.order_catalog_versions (
  id, business_id, version, currency
) values (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 'USD'
);
insert into public.order_item_versions (
  id, catalog_version_id, stable_item_id, name, unit_price_minor, tax_category
) values (
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'Runtime taco', 1250, 'prepared_food'
);
update public.order_catalog_versions
set state = 'published', published_by = '11111111-1111-4111-8111-111111111111', published_at = now()
where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

do $$
begin
  begin
    update public.order_item_versions set name = 'tampered'
    where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    raise exception 'published catalog mutation unexpectedly succeeded';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'PUBLISHED_CATALOG_IMMUTABLE' then raise; end if;
  end;
end;
$$;

insert into public.order_capacity_slots (
  id, business_id, location_id, starts_at, ends_at, capacity
) values (
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  now() + interval '20 minutes', now() + interval '90 minutes', 2
);

create temporary table first_receipt as
select public.create_shadow_order(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  null,
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  now() + interval '30 minutes',
  now() + interval '45 minutes',
  '[{"item_version_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","quantity":2}]'::jsonb,
  'shadow-create-key-0001'
) as receipt;

do $$
declare original jsonb; replay jsonb; target_public_id uuid;
begin
  select receipt into original from first_receipt;
  replay := public.create_shadow_order(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', null,
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    (select pickup_starts_at from public.orders limit 1),
    (select pickup_ends_at from public.orders limit 1),
    '[{"item_version_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","quantity":2}]'::jsonb,
    'shadow-create-key-0001'
  );
  if replay <> original then raise exception 'idempotent replay changed response'; end if;
  select public_id into target_public_id from public.orders;
  if (select count(*) from public.orders) <> 1 then raise exception 'duplicate order created'; end if;
  if not exists (
    select 1 from public.orders where public_id = target_public_id and total_minor = 0
      and payment_state = 'not_required' and item_subtotal_minor = 2500
      and shadow_discount_minor = 2500 and version = 1
  ) then raise exception 'zero-money order invariant failed'; end if;
  if (select reserved_count from public.order_capacity_slots) <> 1 then
    raise exception 'capacity was not reserved';
  end if;
end;
$$;

do $$
declare pid uuid; receipt jsonb;
begin
  select public_id into pid from public.orders;
  receipt := public.transition_shadow_order(pid, 1, 'accepted', null, 'shadow-accept-key-0001');
  if receipt ->> 'fulfillment_state' <> 'accepted' then raise exception 'accept failed'; end if;
  perform public.transition_shadow_order(pid, 2, 'preparing', null, 'shadow-preparing-key-01');
  perform public.transition_shadow_order(pid, 3, 'ready', null, 'shadow-ready-key-0001');
  perform public.transition_shadow_order(pid, 4, 'completed', null, 'shadow-complete-key-01');
  if not exists (select 1 from public.orders where public_id = pid and fulfillment_state = 'completed' and version = 5)
    then raise exception 'completion state failed'; end if;
  if (select reserved_count + accepted_count from public.order_capacity_slots) <> 0
    then raise exception 'capacity was not released'; end if;
  if (select count(*) from public.order_events) <> 5 then raise exception 'event history incomplete'; end if;
end;
$$;

do $$
begin
  begin
    update public.order_events set reason_code = 'tampered';
    raise exception 'event mutation unexpectedly succeeded';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'ORDER_SNAPSHOT_IMMUTABLE' then raise; end if;
  end;
end;
$$;

select set_config('spottr.test_order_id', (select public_id::text from public.orders limit 1), false);
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
select set_config('request.jwt.claim.aal', 'aal2', false);
do $$
begin
  if (select count(*) from public.orders) <> 0 then raise exception 'RLS leaked another user order'; end if;
  if public.get_my_order(current_setting('spottr.test_order_id')::uuid) is not null then
    raise exception 'safe projection unexpectedly returned an order';
  end if;
end;
$$;
reset role;

select 'shadow ordering runtime passed' as result;
