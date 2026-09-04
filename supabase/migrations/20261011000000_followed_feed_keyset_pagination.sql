-- Stable cursor pagination for a mutable followed-content feed. The cursor is
-- the complete descending sort tuple, so new content and timestamp ties cannot
-- shift an offset and silently skip or repeat older rows.
create function public.list_followed_feed(
  feed_filter text default 'all',
  cursor_created_at timestamptz default null,
  cursor_feed_type text default null,
  cursor_content_id uuid default null,
  result_limit integer default 20
)
returns table (
  feed_type text,
  content_id uuid,
  business_id uuid,
  business_name text,
  business_slug text,
  author_public_id uuid,
  author_username text,
  author_display_name text,
  body text,
  rating smallint,
  created_at timestamptz,
  updated_at timestamptz,
  has_more boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  bounded_limit integer := least(greatest(coalesce(result_limit, 20), 1), 20);
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;
  if feed_filter is null
    or feed_filter not in ('all', 'business_post', 'user_review')
    or (
      (cursor_created_at is null or cursor_feed_type is null or cursor_content_id is null)
      and not (cursor_created_at is null and cursor_feed_type is null and cursor_content_id is null)
    )
    or (
      cursor_created_at is not null
      and cursor_feed_type not in ('business_post', 'user_review')
    )
    or (
      cursor_created_at is not null
      and feed_filter <> 'all'
      and cursor_feed_type <> feed_filter
    )
  then
    raise exception using errcode = '22023', message = 'Invalid followed feed cursor';
  end if;

  return query
  with page as materialized (
    select feed.*
    from public.public_followed_feed feed
    where (feed_filter = 'all' or feed.feed_type = feed_filter)
      and (
        cursor_created_at is null
        or (feed.created_at, feed.feed_type, feed.content_id)
          < (cursor_created_at, cursor_feed_type, cursor_content_id)
      )
    order by feed.created_at desc, feed.feed_type desc, feed.content_id desc
    limit bounded_limit + 1
  )
  select
    page.feed_type,
    page.content_id,
    page.business_id,
    page.business_name,
    page.business_slug::text,
    page.author_public_id,
    page.author_username,
    page.author_display_name,
    page.body,
    page.rating,
    page.created_at,
    page.updated_at,
    (select count(*) > bounded_limit from page) as has_more
  from page
  order by page.created_at desc, page.feed_type desc, page.content_id desc
  limit bounded_limit;
end;
$$;

revoke all on function public.list_followed_feed(
  text, timestamptz, text, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function public.list_followed_feed(
  text, timestamptz, text, uuid, integer
) to authenticated;

-- Spottr has no supported legacy mobile feed release. Make the account-active,
-- cursor-bound RPC the only authenticated feed read boundary before launch.
revoke select on public.public_followed_feed from authenticated;
