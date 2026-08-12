-- Bind order access checks to auth.uid() and permit RLS to invoke the helper.
-- Authenticated clients still have no USAGE on the private schema, so this is
-- callable only through stored policies/functions rather than PostgREST.

create or replace function private.order_access_allowed(target_order_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.orders o where o.id = target_order_id and (
      o.customer_id = auth.uid()
      or private.is_business_member(o.business_id, auth.uid())
      or private.is_platform_staff(auth.uid())
    )
  );
$$;

revoke all on function private.order_access_allowed(uuid) from public, anon, authenticated;
grant execute on function private.order_access_allowed(uuid) to authenticated;

drop policy if exists "order participants read orders" on public.orders;
create policy "order participants read orders" on public.orders
  for select to authenticated using (private.order_access_allowed(id));
drop policy if exists "order participants read items" on public.order_items;
create policy "order participants read items" on public.order_items
  for select to authenticated using (private.order_access_allowed(order_id));
drop policy if exists "order participants read options" on public.order_item_options;
create policy "order participants read options" on public.order_item_options for select to authenticated using (exists (
  select 1 from public.order_items oi where oi.id = order_item_id
    and private.order_access_allowed(oi.order_id)
));
drop policy if exists "order participants read events" on public.order_events;
create policy "order participants read events" on public.order_events
  for select to authenticated using (private.order_access_allowed(order_id));

create or replace function public.get_my_order(target_order_public_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'order_public_id', o.public_id, 'business_id', o.business_id, 'location_id', o.location_id,
    'is_shadow', o.is_shadow, 'currency', o.currency, 'item_subtotal_minor', o.item_subtotal_minor,
    'shadow_discount_minor', o.shadow_discount_minor, 'total_minor', o.total_minor,
    'fulfillment_state', o.fulfillment_state, 'payment_state', o.payment_state,
    'pickup_starts_at', o.pickup_starts_at, 'pickup_ends_at', o.pickup_ends_at, 'version', o.version,
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'name', oi.name, 'quantity', oi.quantity, 'unit_price_minor', oi.unit_price_minor,
      'line_subtotal_minor', oi.line_subtotal_minor, 'allergen_note', oi.allergen_note
    ) order by oi.sort_order) from public.order_items oi where oi.order_id = o.id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object(
      'version', oe.event_version, 'state', oe.current_state, 'reason_code', oe.reason_code,
      'created_at', oe.created_at
    ) order by oe.event_version) from public.order_events oe where oe.order_id = o.id), '[]'::jsonb)
  ) from public.orders o where o.public_id = target_order_public_id
    and private.order_access_allowed(o.id);
$$;

drop function if exists private.order_access_allowed(uuid, uuid);
