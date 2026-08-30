-- Enabled social workflows must be represented in account portability. Keep
-- the existing export chain intact, then add only subject-scoped records and
-- opaque public counterparty identifiers. Storage paths, request hashes,
-- moderation notes, and other users' Auth identifiers are deliberately absent.

do $social_export_core$
begin
  if pg_catalog.to_regprocedure('public.account_export_payload_pre_social(uuid)') is null then
    alter function public.account_export_payload(uuid)
      rename to account_export_payload_pre_social;
  end if;
end;
$social_export_core$;

create or replace function public.account_export_payload(target_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with restored as (
    -- The push migration accidentally called the original core and bypassed
    -- both of these earlier wrappers. Rebuild the complete pre-push chain here.
    select public.account_export_payload_pre_meetup(target_user_id)
      || pg_catalog.jsonb_build_object(
        'marketplace_meetup_consents', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'consent_kind', receipt.consent_kind,
              'policy_version', receipt.policy_version,
              'business_id', receipt.business_id,
              'conversation_public_id', conversation.public_id,
              'pickup_request_public_id', request.public_id,
              'recorded_at', receipt.recorded_at
            )
            order by receipt.recorded_at, receipt.id
          )
          from private.marketplace_consent_receipts receipt
          left join public.marketplace_conversations conversation
            on conversation.id = receipt.conversation_id
          left join public.marketplace_pickup_requests request
            on request.id = receipt.request_id
          where receipt.user_id = target_user_id
        ), '[]'::jsonb)
      ) as payload
  ), push as (
    select public.account_export_payload_pre_social(target_user_id) as payload
  )
  select (restored.payload - 'media') || pg_catalog.jsonb_build_object(
    'schema_version', '2026-10-08',
    'notification_consents', case
      when pg_catalog.jsonb_typeof(push.payload -> 'notification_consents') = 'array'
        then push.payload -> 'notification_consents'
      else '[]'::jsonb
    end,
    'notification_devices', case
      when pg_catalog.jsonb_typeof(push.payload -> 'notification_devices') = 'array'
        then push.payload -> 'notification_devices'
      else '[]'::jsonb
    end,
    'profile', (case
      when pg_catalog.jsonb_typeof(restored.payload -> 'profile') = 'object'
        then restored.payload -> 'profile'
      else '{}'::jsonb
    end - 'avatar_path')
      || coalesce((
        select pg_catalog.jsonb_build_object(
          'bio', profile.bio,
          'links', profile.links,
          'avatar_asset_id', (
            select asset.id
            from public.media_assets asset
            where asset.owner_id = target_user_id
              and asset.business_id is null
              and asset.processed_storage_path = profile.avatar_path
            order by asset.created_at desc, asset.id
            limit 1
          ),
          'banner_asset_id', (
            select asset.id
            from public.media_assets asset
            where asset.owner_id = target_user_id
              and asset.business_id is null
              and asset.processed_storage_path = profile.banner_path
            order by asset.created_at desc, asset.id
            limit 1
          ),
          'show_favorites', profile.show_favorites,
          'show_following', profile.show_following,
          'allow_business_invitations', profile.allow_business_invitations
        )
        from public.profiles profile
        where profile.user_id = target_user_id
      ), '{}'::jsonb),
    'profile_follows', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'followed_public_id', followed.public_id,
          'created_at', follow.created_at
        )
        order by follow.created_at, followed.public_id
      )
      from public.profile_follows follow
      join public.profiles followed on followed.user_id = follow.followed_id
      where follow.follower_id = target_user_id
    ), '[]'::jsonb),
    'profile_followers', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'follower_public_id', follower.public_id,
          'created_at', follow.created_at
        )
        order by follow.created_at, follower.public_id
      )
      from public.profile_follows follow
      join public.profiles follower on follower.user_id = follow.follower_id
      where follow.followed_id = target_user_id
    ), '[]'::jsonb),
    'review_reactions', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'review_id', reaction.review_id,
          'business_id', review.business_id,
          'reaction', reaction.reaction,
          'created_at', reaction.created_at,
          'updated_at', reaction.updated_at
        )
        order by reaction.created_at, reaction.review_id
      )
      from public.review_reactions reaction
      join public.reviews review on review.id = reaction.review_id
      where reaction.user_id = target_user_id
    ), '[]'::jsonb),
    'review_profile_comments', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', comment.id,
          'review_id', comment.review_id,
          'business_id', review.business_id,
          'body', comment.body,
          'moderation', comment.moderation,
          'created_at', comment.created_at,
          'updated_at', comment.updated_at,
          'deleted_at', comment.deleted_at
        )
        order by comment.created_at, comment.id
      )
      from public.review_profile_comments comment
      join public.reviews review on review.id = comment.review_id
      where comment.author_id = target_user_id
    ), '[]'::jsonb),
    'authored_business_posts', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', post.id,
          'business_id', post.business_id,
          'body', post.body,
          'moderation', post.moderation,
          'created_at', post.created_at,
          'updated_at', post.updated_at,
          'deleted_at', post.deleted_at,
          'media', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'asset_id', link.asset_id,
                'sort_order', link.sort_order
              )
              order by link.sort_order, link.asset_id
            )
            from public.business_post_media link
            join public.media_assets asset on asset.id = link.asset_id
            where link.post_id = post.id
              and asset.owner_id = target_user_id
          ), '[]'::jsonb)
        )
        order by post.created_at, post.id
      )
      from public.business_posts post
      where post.author_id = target_user_id
    ), '[]'::jsonb),
    'creator_invitations', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'public_id', invitation.public_id,
          'business_id', invitation.business_id,
          'direction', case
            when invitation.sender_id = target_user_id then 'sent'
            else 'received'
          end,
          'counterparty_public_id', case
            when invitation.sender_id = target_user_id then recipient.public_id
            else sender.public_id
          end,
          'title', invitation.title,
          'message', invitation.message,
          'response_note', invitation.response_note,
          'event_starts_at', invitation.event_starts_at,
          'event_ends_at', invitation.event_ends_at,
          'status', invitation.status,
          'review_required', invitation.review_required,
          'terms_version', invitation.terms_version,
          'responded_at', invitation.responded_at,
          'withdrawn_at', invitation.withdrawn_at,
          'created_at', invitation.created_at,
          'updated_at', invitation.updated_at
        )
        order by invitation.created_at, invitation.public_id
      )
      from public.creator_invitations invitation
      left join public.profiles sender on sender.user_id = invitation.sender_id
      left join public.profiles recipient on recipient.user_id = invitation.recipient_id
      where invitation.sender_id = target_user_id
        or invitation.recipient_id = target_user_id
    ), '[]'::jsonb),
    'media', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'asset_id', asset.id,
          'business_id', asset.business_id,
          'mime_type', asset.mime_type,
          'width', asset.width,
          'height', asset.height,
          'byte_size', asset.byte_size,
          'source', asset.source,
          'quarantine_state', asset.quarantine_state,
          'moderation', asset.moderation,
          'created_at', asset.created_at
        )
        order by asset.created_at, asset.id
      )
      from public.media_assets asset
      where asset.owner_id = target_user_id
    ), '[]'::jsonb)
  )
  from restored
  cross join push;
$$;

revoke all on function public.account_export_payload_pre_meetup(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.account_export_payload_pre_meetup(uuid)
  to service_role;
revoke all on function public.account_export_payload_pre_social(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.account_export_payload_pre_social(uuid)
  to service_role;
revoke all on function public.account_export_payload(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.account_export_payload(uuid)
  to service_role;
