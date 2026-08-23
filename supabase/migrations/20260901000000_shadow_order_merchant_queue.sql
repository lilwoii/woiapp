-- Spottr ordering phase O1: merchant-facing zero-money pickup queue.
-- The queue exposes immutable item/option snapshots plus the order-bound pickup
-- context needed for fulfillment. It deliberately omits customer identity and
-- contact data and remains AAL2/member gated. Public/live ordering and every
-- payment path remain disabled.

create or replace function public.get_business_shadow_order_queue(
  target_business_id uuid,
  result_limit integer default 25
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  result jsonb;
begin
  if actor is null or not private.is_business_member(target_business_id, actor) then
    raise exception using errcode = '42501', message = 'BUSINESS_MEMBERSHIP_REQUIRED';
  end if;
  perform private.require_aal2();
  perform private.consume_rate_limit(actor, 'get_business_shadow_order_queue', 240, 3600);

  select coalesce(jsonb_agg(jsonb_build_object(
    'order_public_id', queue.public_id,
    'fulfillment_state', queue.fulfillment_state,
    'payment_state', queue.payment_state,
    'pickup_starts_at', queue.pickup_starts_at,
    'pickup_ends_at', queue.pickup_ends_at,
    'acceptance_expires_at', queue.acceptance_expires_at,
    'location_id', queue.location_id,
    'mobile_stop_id', queue.mobile_stop_id,
    'location_label', queue.location_label,
    'address_line', queue.address_line,
    'city', queue.city,
    'region', queue.region,
    'postal_code', queue.postal_code,
    'time_zone', queue.time_zone,
    'version', queue.version,
    'item_count', queue.item_count,
    'item_subtotal_minor', queue.item_subtotal_minor,
    'shadow_discount_minor', queue.shadow_discount_minor,
    'total_minor', queue.total_minor,
    'currency', queue.currency,
    'is_shadow', true,
    'items', queue.items
  ) order by queue.pickup_starts_at, queue.created_at, queue.public_id), '[]'::jsonb)
  into result
  from (
    select
      order_row.public_id,
      order_row.fulfillment_state,
      order_row.payment_state,
      order_row.pickup_starts_at,
      order_row.pickup_ends_at,
      order_row.acceptance_expires_at,
      order_row.location_id,
      order_row.mobile_stop_id,
      pickup_location.label as location_label,
      pickup_location.address_line,
      pickup_location.city,
      pickup_location.region,
      pickup_location.postal_code,
      business.timezone as time_zone,
      order_row.version,
      order_row.item_subtotal_minor,
      order_row.shadow_discount_minor,
      order_row.total_minor,
      order_row.currency,
      order_row.created_at,
      coalesce((
        select sum(order_item.quantity)::integer
        from public.order_items order_item
        where order_item.order_id = order_row.id
      ), 0) as item_count,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'name', order_item.name,
          'quantity', order_item.quantity,
          'allergen_note', order_item.allergen_note,
          'options', coalesce((
            select jsonb_agg(jsonb_build_object(
              'group_name', order_option.group_name,
              'option_name', order_option.option_name
            ) order by order_option.sort_order, order_option.id)
            from public.order_item_options order_option
            where order_option.order_item_id = order_item.id
          ), '[]'::jsonb)
        ) order by order_item.sort_order, order_item.id)
        from public.order_items order_item
        where order_item.order_id = order_row.id
      ), '[]'::jsonb) as items
    from public.orders order_row
    join public.businesses business on business.id = order_row.business_id
    join public.business_locations pickup_location
      on pickup_location.id = order_row.location_id
      and pickup_location.business_id = order_row.business_id
    where order_row.business_id = target_business_id
      and order_row.is_shadow
      and order_row.fulfillment_state in ('pending_acceptance', 'accepted', 'preparing', 'ready')
    order by order_row.pickup_starts_at, order_row.created_at, order_row.public_id
    limit least(greatest(coalesce(result_limit, 25), 1), 25)
  ) queue;

  if octet_length(result::text) > 524288 then
    raise exception using errcode = '22003', message = 'ORDER_QUEUE_TOO_LARGE';
  end if;
  return result;
end;
$$;

revoke all on function public.get_business_shadow_order_queue(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.get_business_shadow_order_queue(uuid, integer)
  to authenticated;
