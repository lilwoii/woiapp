-- Repair cross-feature invariants introduced by banners, business posts, and
-- the expanded generic report catalog.

alter table private.media_stage_grants
  drop constraint if exists media_stage_grants_purpose_check;
alter table private.media_stage_grants
  add constraint media_stage_grants_purpose_check
  check (purpose in (
    'profile_avatar', 'profile_banner', 'business_logo', 'business_gallery',
    'business_post', 'review_photo', 'chat_photo', 'claim_evidence'
  ));

-- Public media requires both clean processing and a currently public link.
-- Merely carrying a business_id never makes an upload public.
create or replace function private.is_media_publicly_eligible(target_asset_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.media_assets asset
    where asset.id = target_asset_id
      and asset.source <> 'chat_upload'
      and asset.moderation = 'approved'
      and asset.quarantine_state = 'clean'
      and asset.processed_storage_path is not null
      and not exists (
        select 1 from public.marketplace_message_media chat_link
        where chat_link.asset_id = asset.id
      )
      and (
        exists (
          select 1 from public.businesses business
          where business.logo_asset_id = asset.id
            and private.is_business_publicly_eligible(business.id)
        )
        or exists (
          select 1 from public.business_media_links business_link
          where business_link.asset_id = asset.id
            and private.is_business_publicly_eligible(business_link.business_id)
        )
        or exists (
          select 1 from public.business_post_media post_link
          join public.business_posts post on post.id = post_link.post_id
          where post_link.asset_id = asset.id
            and post.moderation = 'approved'
            and post.deleted_at is null
            and private.is_business_publicly_eligible(post.business_id)
        )
        or exists (
          select 1 from public.review_media review_link
          join public.reviews review on review.id = review_link.review_id
          where review_link.asset_id = asset.id
            and review.moderation = 'approved'
            and review.deleted_at is null
            and private.is_business_publicly_eligible(review.business_id)
        )
        or exists (
          select 1 from public.profiles profile
          where (profile.avatar_path = asset.processed_storage_path
              or profile.banner_path = asset.processed_storage_path)
            and profile.status = 'active'
        )
      )
  );
$$;

alter table public.content_reports
  drop constraint if exists content_reports_target_type_check;
alter table public.content_reports
  add constraint content_reports_target_type_check
  check (target_type in (
    'business', 'business_post', 'review', 'review_comment', 'response',
    'update', 'media', 'user', 'chat_message'
  ));

create or replace function private.validate_report_target()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare target_exists boolean := false;
begin
  new.detail := nullif(btrim(new.detail), '');
  case new.target_type
    when 'business' then
      select private.is_business_publicly_eligible(new.target_id)
        and not private.is_business_member(new.target_id, new.reporter_id)
        into target_exists;
    when 'business_post' then
      select exists (
        select 1 from public.business_posts post
        where post.id = new.target_id and post.moderation = 'approved'
          and post.deleted_at is null
          and (post.author_id is null or post.author_id <> new.reporter_id)
          and not private.is_business_member(post.business_id, new.reporter_id)
          and private.is_business_publicly_eligible(post.business_id)
      ) into target_exists;
    when 'review' then
      select exists (
        select 1 from public.reviews review
        where review.id = new.target_id and review.moderation = 'approved'
          and review.deleted_at is null and review.author_id <> new.reporter_id
          and private.is_business_publicly_eligible(review.business_id)
      ) into target_exists;
    when 'review_comment' then
      select exists (
        select 1 from public.review_profile_comments comment
        join public.reviews review on review.id = comment.review_id
        where comment.id = new.target_id and comment.author_id <> new.reporter_id
          and comment.moderation = 'approved' and comment.deleted_at is null
          and review.moderation = 'approved' and review.deleted_at is null
          and private.is_business_publicly_eligible(review.business_id)
          and not private.users_are_blocked(new.reporter_id, comment.author_id)
      ) into target_exists;
    when 'response' then
      select exists (
        select 1 from public.business_responses response
        join public.reviews review on review.id = response.review_id
          and review.business_id = response.business_id
        where response.review_id = new.target_id and response.moderation = 'approved'
          and (response.author_id is null or response.author_id <> new.reporter_id)
          and review.moderation = 'approved' and review.deleted_at is null
          and private.is_business_publicly_eligible(response.business_id)
      ) into target_exists;
    when 'update' then
      select exists (
        select 1 from public.business_updates update_row
        where update_row.id = new.target_id and update_row.moderation = 'approved'
          and update_row.starts_at <= now() and update_row.expires_at > now()
          and (update_row.author_id is null or update_row.author_id <> new.reporter_id)
          and private.is_business_publicly_eligible(update_row.business_id)
      ) into target_exists;
    when 'media' then
      select exists (
        select 1 from public.media_assets asset
        where asset.id = new.target_id and asset.owner_id <> new.reporter_id
          and private.is_media_publicly_eligible(asset.id)
      ) into target_exists;
    when 'user' then
      select exists (
        select 1 from public.profiles profile
        where profile.user_id = new.target_id and profile.user_id <> new.reporter_id
          and profile.status = 'active'
      ) into target_exists;
    when 'chat_message' then
      select exists (
        select 1 from public.marketplace_messages message
        where message.id = new.target_id
          and message.sender_id is distinct from new.reporter_id
          and message.deleted_at is null
          and private.marketplace_conversation_access_allowed(message.conversation_id, new.reporter_id)
      ) into target_exists;
  end case;
  if not target_exists then
    raise exception using errcode = '22023', message = 'INVALID_REPORT_TARGET';
  end if;
  return new;
end;
$$;

revoke all on function private.is_media_publicly_eligible(uuid) from public, anon, authenticated;
grant execute on function private.is_media_publicly_eligible(uuid) to anon, authenticated;
revoke all on function private.validate_report_target() from public, anon, authenticated, service_role;
