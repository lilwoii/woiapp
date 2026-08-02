-- Spottr marketplace-chat privacy lifecycle.
--
-- Shared conversations survive one participant's account deletion so the other
-- participant does not lose their record. The deleted participant is
-- pseudonymized by the existing sender/profile foreign keys, exact pickup
-- disclosures are destroyed before Auth deletion, and the thread is closed.

alter table public.marketplace_conversations
  drop constraint if exists marketplace_conversations_customer_id_fkey,
  drop constraint if exists marketplace_conversations_merchant_id_fkey,
  alter column customer_id drop not null,
  alter column merchant_id drop not null;

alter table public.marketplace_conversations
  add constraint marketplace_conversations_customer_id_fkey
    foreign key (customer_id) references auth.users(id) on delete set null,
  add constraint marketplace_conversations_merchant_id_fkey
    foreign key (merchant_id) references auth.users(id) on delete set null;

alter table public.marketplace_conversations
  add column if not exists customer_deleted_at timestamptz,
  add column if not exists merchant_deleted_at timestamptz;

alter table public.marketplace_conversations
  drop constraint if exists marketplace_conversations_distinct_participants;

alter table public.marketplace_conversations
  add constraint marketplace_conversations_distinct_participants check (
    customer_id is null
    or merchant_id is null
    or customer_id <> merchant_id
  ),
  add constraint marketplace_conversations_customer_deletion_shape check (
    (customer_id is not null and customer_deleted_at is null)
    or (customer_id is null and customer_deleted_at is not null)
  ) not valid,
  add constraint marketplace_conversations_merchant_deletion_shape check (
    (merchant_id is not null and merchant_deleted_at is null)
    or (merchant_id is null and merchant_deleted_at is not null)
  ) not valid;

alter table public.media_assets
  drop constraint if exists media_assets_source_check;
alter table public.media_assets
  add constraint media_assets_source_check
    check (source in ('owner_upload', 'review_upload', 'chat_upload', 'licensed_provider'));

-- Backfill assets already linked by the previous chat release. The explicit chat
-- classification is privacy-preserving even if a legacy asset was dual-linked.
update public.media_assets asset
set source = 'chat_upload'
where asset.source <> 'chat_upload'
  and exists (
    select 1
    from public.marketplace_message_media link
    where link.asset_id = asset.id
  );

do $$
begin
  if exists (
    select 1
    from public.marketplace_pickup_requests request
    where request.state in ('pending', 'authorized')
    group by request.conversation_id
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'ACTIVE_PICKUP_REQUEST_DEDUPLICATION_REQUIRED';
  end if;
end;
$$;

drop index if exists public.marketplace_pickup_one_pending_idx;
create unique index marketplace_pickup_one_active_idx
  on public.marketplace_pickup_requests (conversation_id)
  where state in ('pending', 'authorized');

-- Public media must have a positive, approved public link. A business_id alone is
-- provenance, not publication consent. Chat media is always excluded.
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
        select 1
        from public.marketplace_message_media chat_link
        where chat_link.asset_id = asset.id
      )
      and (
        exists (
          select 1
          from public.businesses business
          where business.logo_asset_id = asset.id
            and private.is_business_publicly_eligible(business.id)
        )
        or exists (
          select 1
          from public.business_media_links business_link
          where business_link.asset_id = asset.id
            and private.is_business_publicly_eligible(business_link.business_id)
        )
        or exists (
          select 1
          from public.review_media review_link
          join public.reviews review on review.id = review_link.review_id
          where review_link.asset_id = asset.id
            and review.moderation = 'approved'
            and review.deleted_at is null
            and private.is_business_publicly_eligible(review.business_id)
        )
        or exists (
          select 1
          from public.profiles profile
          where profile.avatar_path = asset.processed_storage_path
            and profile.status = 'active'
        )
      )
  );
$$;

revoke all on function private.is_media_publicly_eligible(uuid) from public, anon, authenticated;
grant execute on function private.is_media_publicly_eligible(uuid) to anon, authenticated;

drop policy if exists "owners and business members read media queue" on public.media_assets;
create policy "owners and business members read media queue" on public.media_assets
  for select to authenticated
  using (
    private.has_aal2()
    and (
      owner_id = auth.uid()
      or (
        source <> 'chat_upload'
        and business_id is not null
        and private.is_business_member(business_id, auth.uid())
      )
    )
  );

create or replace function public.register_quarantined_chat_media(
  target_storage_path text,
  target_business_id uuid,
  target_conversation_public_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  object_metadata jsonb;
  detected_mime text;
  detected_size bigint;
  asset_id uuid;
begin
  if not private.is_active_user(actor)
    or target_business_id is null
    or target_conversation_public_id is null
    or not exists (
      select 1
      from public.marketplace_conversations conversation
      where conversation.public_id = target_conversation_public_id
        and conversation.business_id = target_business_id
        and private.marketplace_conversation_write_allowed(conversation.id, actor)
    )
  then
    raise exception using errcode = '42501', message = 'CHAT_MEDIA_ACCESS_REQUIRED';
  end if;

  if target_storage_path is null
    or char_length(target_storage_path) > 512
    or target_storage_path !~ ('^quarantine/' || actor::text || '/[A-Za-z0-9][A-Za-z0-9._-]{0,180}$')
  then
    raise exception using errcode = '22023', message = 'Invalid quarantine path';
  end if;

  select object.metadata
  into object_metadata
  from storage.objects object
  where object.bucket_id = 'spottr-media'
    and object.name = target_storage_path;

  if object_metadata is null then
    raise exception using errcode = '22023', message = 'Uploaded object not found';
  end if;

  detected_mime := lower(coalesce(
    object_metadata ->> 'mimetype',
    object_metadata ->> 'contentType',
    ''
  ));
  detected_size := case
    when coalesce(object_metadata ->> 'size', '') ~ '^[0-9]+$'
    then (object_metadata ->> 'size')::bigint
    else null
  end;

  if detected_mime not in ('image/jpeg', 'image/png', 'image/webp')
    or detected_size is null
    or detected_size not between 1 and 5242880
    or (detected_mime = 'image/jpeg' and lower(target_storage_path) !~ '\.(jpg|jpeg)$')
    or (detected_mime = 'image/png' and lower(target_storage_path) !~ '\.png$')
    or (detected_mime = 'image/webp' and lower(target_storage_path) !~ '\.webp$')
  then
    raise exception using errcode = '22023', message = 'Unsupported media object';
  end if;

  perform private.consume_rate_limit(actor, 'media_registration', 20, 86400);

  insert into public.media_assets (
    owner_id,
    business_id,
    storage_path,
    mime_type,
    byte_size,
    source,
    quarantine_state,
    moderation
  )
  values (
    actor,
    target_business_id,
    target_storage_path,
    detected_mime,
    detected_size,
    'chat_upload',
    'uploaded',
    'pending'
  )
  on conflict (storage_path)
  do update set storage_path = excluded.storage_path
  where public.media_assets.owner_id = actor
    and public.media_assets.source = 'chat_upload'
    and public.media_assets.business_id = target_business_id
    and public.media_assets.quarantine_state in ('uploaded', 'scanning')
  returning id into asset_id;

  if asset_id is null then
    raise exception using errcode = '22023', message = 'Media path is already registered';
  end if;

  return asset_id;
end;
$$;

revoke all on function public.register_quarantined_chat_media(text, uuid, uuid)
  from public, anon;
grant execute on function public.register_quarantined_chat_media(text, uuid, uuid)
  to authenticated;

-- Keep the timestamp and FK transition atomic when Auth removes a participant.
create or replace function private.mark_marketplace_participant_deleted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.customer_id is not null and new.customer_id is null then
    new.customer_deleted_at := coalesce(new.customer_deleted_at, now());
  end if;
  if old.merchant_id is not null and new.merchant_id is null then
    new.merchant_deleted_at := coalesce(new.merchant_deleted_at, now());
  end if;
  return new;
end;
$$;

revoke all on function private.mark_marketplace_participant_deleted() from public, anon, authenticated;

drop trigger if exists marketplace_participant_deletion_stamp
  on public.marketplace_conversations;
create trigger marketplace_participant_deletion_stamp
before update of customer_id, merchant_id on public.marketplace_conversations
for each row execute function private.mark_marketplace_participant_deleted();

-- High-confidence DLP blocks common precise-location and financial credential
-- patterns. It is intentionally a safety layer, not a claim that all PII can be
-- recognized across every language and address format.
create or replace function private.marketplace_chat_safety_code(candidate text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when candidate ~* '(^|[^0-9])([0-9][ -]?){12,18}[0-9]([^0-9]|$)'
      or candidate ~* '\m(cvv|cvc|card[[:space:]]+number|routing[[:space:]]+number|bank[[:space:]]+account|account[[:space:]]+number)[[:space:]:#-]*[0-9]'
      or candidate ~* '\m[0-9]{3}-[0-9]{2}-[0-9]{4}\M'
      then 'SENSITIVE_PAYMENT_DATA_BLOCKED'
    when candidate ~* '[-+]?[0-9]{1,2}\.[0-9]{4,}[[:space:]]*,[[:space:]]*[-+]?[0-9]{1,3}\.[0-9]{4,}'
      or candidate ~* '\m(my|our|home)[[:space:]]+address[[:space:]]+(is|:|=)'
      or candidate ~* '\m[0-9]{1,6}[[:space:]]+[[:alnum:].''-]+([[:space:]]+[[:alnum:].''-]+){0,5}[[:space:]]+(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|place|pl|terrace|trail|trl|highway|hwy|calle|rue|strasse|via|rua)\M'
      then 'PRECISE_LOCATION_BLOCKED'
    else null
  end;
$$;

revoke all on function private.marketplace_chat_safety_code(text) from public, anon, authenticated;

-- Chat clients use narrow projections/RPCs. Direct SELECT would reveal internal
-- Auth UUIDs, staff workflow fields, and transient receipt/typing identifiers.
revoke select on table
  public.business_marketplace_chat_settings,
  public.marketplace_conversations,
  public.marketplace_messages,
  public.marketplace_message_media,
  public.marketplace_read_receipts,
  public.marketplace_typing_presence,
  public.marketplace_pickup_sites,
  public.marketplace_pickup_requests
from authenticated;

create or replace function private.can_read_marketplace_chat_media_object(
  target_name text,
  target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.media_assets asset
    join public.marketplace_message_media link on link.asset_id = asset.id
    join public.marketplace_messages message on message.id = link.message_id
    where asset.processed_storage_path = target_name
      and asset.quarantine_state = 'clean'
      and asset.moderation = 'approved'
      and message.visibility = 'visible'
      and message.deleted_at is null
      and private.marketplace_conversation_access_allowed(
        message.conversation_id,
        target_user_id
      )
  );
$$;

create or replace function private.can_staff_read_reported_chat_media_object(
  target_name text,
  target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_aal2()
    and private.is_platform_staff(target_user_id)
    and exists (
      select 1
      from public.media_assets asset
      join public.marketplace_message_media link on link.asset_id = asset.id
      join public.content_reports report
        on report.target_type = 'chat_message'
       and report.target_id = link.message_id
      where asset.processed_storage_path = target_name
        and asset.quarantine_state = 'clean'
        and asset.moderation = 'approved'
        and report.state in ('open', 'reviewing')
    );
$$;

revoke all on function private.can_read_marketplace_chat_media_object(text, uuid)
  from public, anon, authenticated;
revoke all on function private.can_staff_read_reported_chat_media_object(text, uuid)
  from public, anon, authenticated;
grant execute on function private.can_read_marketplace_chat_media_object(text, uuid)
  to authenticated;
grant execute on function private.can_staff_read_reported_chat_media_object(text, uuid)
  to authenticated;

drop policy if exists "participants read processed marketplace chat media"
  on storage.objects;
create policy "participants read processed marketplace chat media"
  on storage.objects
  for select to authenticated
  using (
    bucket_id = 'spottr-media'
    and private.can_read_marketplace_chat_media_object(name, auth.uid())
  );

drop policy if exists "aal2 staff read reported marketplace chat media"
  on storage.objects;
create policy "aal2 staff read reported marketplace chat media"
  on storage.objects
  for select to authenticated
  using (
    bucket_id = 'spottr-media'
    and private.can_staff_read_reported_chat_media_object(name, auth.uid())
  );

-- Recreate the core so upgrades from the prior migration also require the new
-- private chat_upload source (editing an already-applied migration is not enough).
create or replace function public.send_marketplace_message(
  target_conversation_public_id uuid,
  message_body text,
  media_asset_ids uuid[] default '{}'::uuid[],
  idempotency_key text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_conversation public.marketplace_conversations%rowtype;
  normalized_body text := nullif(
    btrim(regexp_replace(coalesce(message_body, ''), '[[:space:]]+', ' ', 'g')),
    ''
  );
  normalized_assets uuid[] := coalesce(media_asset_ids, '{}'::uuid[]);
  target_message_id uuid := gen_random_uuid();
  target_message_public_id uuid := gen_random_uuid();
  next_sequence bigint;
  key_hash text;
  request_hash text;
  prior_response jsonb;
  response jsonb;
begin
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  if normalized_body is null and cardinality(normalized_assets) = 0 then
    raise exception using errcode = '22023', message = 'EMPTY_CHAT_MESSAGE';
  end if;
  if normalized_body is not null and (
    char_length(normalized_body) > 1000
    or not private.content_is_professional(normalized_body)
  ) then
    raise exception using errcode = '23514', message = 'CONTENT_POLICY_VIOLATION';
  end if;
  if cardinality(normalized_assets) > 4
    or cardinality(normalized_assets) <> (
      select count(distinct supplied.asset_id)
      from unnest(normalized_assets) supplied(asset_id)
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_CHAT_MEDIA_SET';
  end if;

  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'conversation_public_id', target_conversation_public_id,
    'body', normalized_body,
    'media_asset_ids', to_jsonb(normalized_assets)
  ));
  prior_response := private.marketplace_chat_idempotent_response(
    actor,
    'send_marketplace_message',
    key_hash,
    request_hash
  );
  if prior_response is not null then
    return prior_response;
  end if;

  perform private.consume_rate_limit(actor, 'marketplace_message_minute', 30, 60);
  perform private.consume_rate_limit(actor, 'marketplace_message_day', 500, 86400);

  select conversation.*
  into target_conversation
  from public.marketplace_conversations conversation
  where conversation.public_id = target_conversation_public_id
  for update;

  if not found or not private.marketplace_conversation_write_allowed(target_conversation.id, actor) then
    raise exception using errcode = '42501', message = 'CHAT_WRITE_NOT_ALLOWED';
  end if;

  if cardinality(normalized_assets) > 0 and (
    select count(*)
    from public.media_assets asset
    where asset.id = any(normalized_assets)
      and asset.owner_id = actor
      and asset.business_id = target_conversation.business_id
      and asset.source = 'chat_upload'
      and asset.quarantine_state = 'clean'
      and asset.moderation = 'approved'
      and asset.processed_storage_path is not null
  ) <> cardinality(normalized_assets) then
    raise exception using errcode = '55000', message = 'CHAT_MEDIA_NOT_CLEAN_OR_OWNED';
  end if;

  next_sequence := target_conversation.last_sequence + 1;
  insert into public.marketplace_messages (
    id,
    public_id,
    conversation_id,
    sender_id,
    sequence,
    body
  )
  values (
    target_message_id,
    target_message_public_id,
    target_conversation.id,
    actor,
    next_sequence,
    normalized_body
  );

  insert into public.marketplace_message_media (message_id, asset_id, sort_order)
  select target_message_id, supplied.asset_id, (supplied.ordinality - 1)::smallint
  from unnest(normalized_assets) with ordinality supplied(asset_id, ordinality);

  update public.marketplace_conversations
  set last_sequence = next_sequence,
      last_message_at = now(),
      updated_at = now()
  where id = target_conversation.id;

  insert into public.marketplace_read_receipts (
    conversation_id,
    user_id,
    last_read_sequence,
    read_at
  )
  values (target_conversation.id, actor, next_sequence, now())
  on conflict (conversation_id, user_id)
  do update set
    last_read_sequence = greatest(
      public.marketplace_read_receipts.last_read_sequence,
      excluded.last_read_sequence
    ),
    read_at = case
      when excluded.last_read_sequence > public.marketplace_read_receipts.last_read_sequence
        then excluded.read_at
      else public.marketplace_read_receipts.read_at
    end;

  delete from public.marketplace_typing_presence presence
  where presence.conversation_id = target_conversation.id
    and presence.user_id = actor;

  response := jsonb_build_object(
    'message_public_id', target_message_public_id,
    'conversation_public_id', target_conversation.public_id,
    'sequence', next_sequence,
    'sent_at', now(),
    'visibility', 'visible'
  );
  perform private.store_marketplace_chat_idempotency(
    actor,
    'send_marketplace_message',
    key_hash,
    request_hash,
    response
  );
  perform private.write_audit_event(
    actor,
    target_conversation.business_id,
    'marketplace_chat.message_sent',
    'marketplace_message',
    target_message_public_id::text,
    jsonb_build_object(
      'conversation_public_id', target_conversation.public_id,
      'sequence', next_sequence,
      'body_length', coalesce(char_length(normalized_body), 0),
      'media_count', cardinality(normalized_assets)
    )
  );
  return response;
end;
$$;

alter function public.send_marketplace_message(uuid, text, uuid[], text)
  rename to send_marketplace_message_core;
revoke all on function public.send_marketplace_message_core(uuid, text, uuid[], text)
  from public, anon, authenticated;

create or replace function public.send_marketplace_message(
  target_conversation_public_id uuid,
  message_body text,
  media_asset_ids uuid[] default '{}'::uuid[],
  idempotency_key text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  safety_code text;
begin
  safety_code := private.marketplace_chat_safety_code(coalesce(message_body, ''));
  if safety_code is not null then
    raise exception using errcode = '23514', message = safety_code;
  end if;

  return public.send_marketplace_message_core(
    target_conversation_public_id,
    message_body,
    media_asset_ids,
    idempotency_key
  );
end;
$$;

revoke all on function public.send_marketplace_message(uuid, text, uuid[], text) from public, anon;
grant execute on function public.send_marketplace_message(uuid, text, uuid[], text) to authenticated;

alter function public.submit_marketplace_pickup_site(
  uuid, text, text, text, text, text, text, double precision, double precision, text
) rename to submit_marketplace_pickup_site_core;
revoke all on function public.submit_marketplace_pickup_site_core(
  uuid, text, text, text, text, text, text, double precision, double precision, text
) from public, anon, authenticated;

create or replace function public.submit_marketplace_pickup_site(
  target_business_id uuid,
  site_label text,
  site_kind text,
  address_line text,
  city text,
  region text,
  postal_code text,
  latitude double precision,
  longitude double precision,
  idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if private.marketplace_chat_safety_code(concat_ws(
    ' ',
    coalesce(site_label, ''),
    coalesce(city, ''),
    coalesce(region, '')
  )) is not null then
    raise exception using errcode = '23514', message = 'PUBLIC_PICKUP_LABEL_SENSITIVE';
  end if;
  return public.submit_marketplace_pickup_site_core(
    target_business_id, site_label, site_kind, address_line, city, region,
    postal_code, latitude, longitude, idempotency_key
  );
end;
$$;

revoke all on function public.submit_marketplace_pickup_site(
  uuid, text, text, text, text, text, text, double precision, double precision, text
) from public, anon;
grant execute on function public.submit_marketplace_pickup_site(
  uuid, text, text, text, text, text, text, double precision, double precision, text
) to authenticated;

alter function public.review_marketplace_pickup_site(uuid, text, boolean, text, text)
  rename to review_marketplace_pickup_site_core;
revoke all on function public.review_marketplace_pickup_site_core(uuid, text, boolean, text, text)
  from public, anon, authenticated;

create or replace function public.review_marketplace_pickup_site(
  target_pickup_site_public_id uuid,
  next_state text,
  confirmed_non_residential boolean,
  review_reason text,
  idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  public_fields text;
begin
  select concat_ws(' ', site.label, site.city, site.region)
  into public_fields
  from public.marketplace_pickup_sites site
  where site.public_id = target_pickup_site_public_id;

  if public_fields is null
    or private.marketplace_chat_safety_code(public_fields) is not null
  then
    raise exception using errcode = '23514', message = 'PUBLIC_PICKUP_FIELDS_SENSITIVE';
  end if;

  return public.review_marketplace_pickup_site_core(
    target_pickup_site_public_id,
    next_state,
    confirmed_non_residential,
    review_reason,
    idempotency_key
  );
end;
$$;

revoke all on function public.review_marketplace_pickup_site(uuid, text, boolean, text, text)
  from public, anon;
grant execute on function public.review_marketplace_pickup_site(uuid, text, boolean, text, text)
  to authenticated;

alter function public.request_marketplace_pickup_detail(
  uuid, timestamptz, timestamptz, text, text
) rename to request_marketplace_pickup_detail_core;
revoke all on function public.request_marketplace_pickup_detail_core(
  uuid, timestamptz, timestamptz, text, text
) from public, anon, authenticated;

create or replace function public.request_marketplace_pickup_detail(
  target_conversation_public_id uuid,
  pickup_starts_at timestamptz,
  pickup_ends_at timestamptz,
  request_note text,
  idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if private.marketplace_chat_safety_code(coalesce(request_note, '')) is not null then
    raise exception using errcode = '23514', message = 'PICKUP_NOTE_SENSITIVE';
  end if;
  return public.request_marketplace_pickup_detail_core(
    target_conversation_public_id,
    pickup_starts_at,
    pickup_ends_at,
    request_note,
    idempotency_key
  );
end;
$$;

revoke all on function public.request_marketplace_pickup_detail(
  uuid, timestamptz, timestamptz, text, text
) from public, anon;
grant execute on function public.request_marketplace_pickup_detail(
  uuid, timestamptz, timestamptz, text, text
) to authenticated;

create or replace function public.list_marketplace_pickup_requests(
  target_conversation_public_id uuid
)
returns table (
  pickup_request_public_id uuid,
  participant_role text,
  pickup_starts_at timestamptz,
  pickup_ends_at timestamptz,
  request_note text,
  request_state text,
  request_version integer,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_conversation public.marketplace_conversations%rowtype;
begin
  select conversation.*
  into target_conversation
  from public.marketplace_conversations conversation
  where conversation.public_id = target_conversation_public_id;

  if not found
    or not private.marketplace_conversation_access_allowed(target_conversation.id, actor)
  then
    raise exception using errcode = '42501', message = 'CHAT_ACCESS_REQUIRED';
  end if;

  return query
  select
    request.public_id,
    case when actor = target_conversation.customer_id then 'customer' else 'merchant' end,
    request.pickup_starts_at,
    request.pickup_ends_at,
    request.note,
    request.state,
    request.version,
    request.created_at,
    request.updated_at
  from public.marketplace_pickup_requests request
  where request.conversation_id = target_conversation.id
  order by request.created_at desc, request.public_id desc
  limit 20;
end;
$$;

revoke all on function public.list_marketplace_pickup_requests(uuid) from public, anon;
grant execute on function public.list_marketplace_pickup_requests(uuid) to authenticated;

create or replace function public.get_marketplace_conversation_role(
  target_conversation_public_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  participant_role text;
begin
  select case
    when conversation.customer_id = actor then 'customer'
    when conversation.merchant_id = actor then 'merchant'
    else null
  end
  into participant_role
  from public.marketplace_conversations conversation
  where conversation.public_id = target_conversation_public_id;

  if participant_role is null then
    raise exception using errcode = '42501', message = 'CHAT_ACCESS_REQUIRED';
  end if;
  return participant_role;
end;
$$;

revoke all on function public.get_marketplace_conversation_role(uuid) from public, anon;
grant execute on function public.get_marketplace_conversation_role(uuid) to authenticated;

-- Extend the existing account export without duplicating its mature core query.
alter function public.account_export_payload(uuid) rename to account_export_payload_core;
revoke all on function public.account_export_payload_core(uuid) from public, anon, authenticated;

create or replace function public.account_export_payload(target_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.account_export_payload_core(target_user_id) || jsonb_build_object(
    'schema_version', '2026-08-06',
    'marketplace_chat', jsonb_build_object(
      'conversations', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'conversation_public_id', conversation.public_id,
            'business_id', conversation.business_id,
            'business_name', business.name,
            'participant_role', case
              when conversation.customer_id = target_user_id then 'customer'
              else 'merchant'
            end,
            'counterpart', (
              select jsonb_build_object(
                'public_profile_id', counterpart.public_id,
                'username', counterpart.username,
                'display_name', counterpart.display_name
              )
              from public.profiles counterpart
              where counterpart.user_id = case
                when conversation.customer_id = target_user_id then conversation.merchant_id
                else conversation.customer_id
              end
            ),
            'state', conversation.state,
            'last_message_at', conversation.last_message_at,
            'created_at', conversation.created_at,
            'updated_at', conversation.updated_at
          )
          order by conversation.created_at, conversation.public_id
        )
        from public.marketplace_conversations conversation
        join public.businesses business on business.id = conversation.business_id
        where target_user_id in (conversation.customer_id, conversation.merchant_id)
      ), '[]'::jsonb),
      'authored_messages', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'message_public_id', message.public_id,
            'conversation_public_id', conversation.public_id,
            'sequence', message.sequence,
            'body', message.body,
            'visibility', message.visibility,
            'sent_at', message.sent_at,
            'edited_at', message.edited_at,
            'deleted_at', message.deleted_at,
            'media_asset_ids', coalesce((
              select jsonb_agg(link.asset_id order by link.sort_order)
              from public.marketplace_message_media link
              where link.message_id = message.id
            ), '[]'::jsonb)
          )
          order by message.sent_at, message.public_id
        )
        from public.marketplace_messages message
        join public.marketplace_conversations conversation
          on conversation.id = message.conversation_id
        where message.sender_id = target_user_id
      ), '[]'::jsonb),
      'pickup_requests', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'pickup_request_public_id', request.public_id,
            'conversation_public_id', conversation.public_id,
            'requested_by_me', request.requested_by = target_user_id,
            'responded_by_me', request.responded_by = target_user_id,
            'pickup_starts_at', request.pickup_starts_at,
            'pickup_ends_at', request.pickup_ends_at,
            'note', request.note,
            'state', request.state,
            'created_at', request.created_at,
            'updated_at', request.updated_at
          )
          order by request.created_at, request.public_id
        )
        from public.marketplace_pickup_requests request
        join public.marketplace_conversations conversation
          on conversation.id = request.conversation_id
        where target_user_id in (conversation.customer_id, conversation.merchant_id)
      ), '[]'::jsonb),
      'submitted_or_owned_pickup_sites', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'pickup_site_public_id', site.public_id,
            'business_id', site.business_id,
            'label', site.label,
            'city', site.city,
            'region', site.region,
            'site_kind', site.site_kind,
            'state', site.state,
            'address_line', details.address_line,
            'postal_code', details.postal_code,
            'latitude', details.latitude,
            'longitude', details.longitude,
            'created_at', site.created_at,
            'updated_at', site.updated_at
          )
          order by site.created_at, site.public_id
        )
        from public.marketplace_pickup_sites site
        join private.marketplace_pickup_site_details details on details.site_id = site.id
        where site.submitted_by = target_user_id
          or exists (
            select 1
            from public.business_members membership
            where membership.business_id = site.business_id
              and membership.user_id = target_user_id
              and membership.role = 'owner'
              and membership.status = 'active'
          )
      ), '[]'::jsonb)
    )
  );
$$;

revoke all on function public.account_export_payload(uuid) from public, anon, authenticated;
grant execute on function public.account_export_payload(uuid) to service_role;

delete from private.account_deletion_requests request
where request.expires_at < now();

do $$
begin
  if exists (
    select 1
    from private.account_deletion_requests request
    where request.user_id is not null
      and request.state in ('started', 'processing', 'storage_deleted', 'failed')
    group by request.user_id
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'ACCOUNT_DELETION_RECEIPT_DEDUPLICATION_REQUIRED';
  end if;
end;
$$;

create unique index if not exists account_deletion_one_live_request_idx
  on private.account_deletion_requests (user_id)
  where user_id is not null
    and state in ('started', 'processing', 'storage_deleted', 'failed');

create or replace function public.begin_account_deletion(
  target_user_id uuid,
  request_key text
)
returns table (
  request_id uuid,
  request_state text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  fingerprint text;
begin
  if target_user_id is null
    or char_length(coalesce(request_key, '')) not between 16 and 128
    or request_key !~ '^[A-Za-z0-9._:-]+$'
    or not exists (select 1 from auth.users account where account.id = target_user_id)
  then
    raise exception using errcode = '22023', message = 'Invalid account deletion request';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_user_id::text, 7741902)
  );

  delete from private.account_deletion_requests request
  where request.expires_at < now();

  select request.id, request.state
  into request_id, request_state
  from private.account_deletion_requests request
  where request.user_id = target_user_id
    and request.state in ('started', 'processing', 'storage_deleted', 'failed')
    and request.expires_at > now()
  order by request.created_at
  limit 1;

  if request_id is not null then
    return next;
    return;
  end if;

  fingerprint := pg_catalog.encode(
    public.digest(target_user_id::text || ':' || request_key, 'sha256'),
    'hex'
  );

  insert into private.account_deletion_requests as request (
    user_id,
    request_fingerprint,
    state
  )
  values (target_user_id, fingerprint, 'started')
  on conflict (request_fingerprint)
  do update set user_id = request.user_id
  returning request.id, request.state
  into request_id, request_state;

  return next;
end;
$$;

revoke all on function public.begin_account_deletion(uuid, text) from public, anon, authenticated;
grant execute on function public.begin_account_deletion(uuid, text) to service_role;

-- Revoke precise pickup snapshots and close shared threads before deleting Auth.
create or replace function public.prepare_account_deletion(
  target_user_id uuid,
  target_request_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  affected_conversations integer := 0;
  deleted_disclosures integer := 0;
begin
  if not exists (
    select 1
    from private.account_deletion_requests request
    where request.id = target_request_id
      and request.user_id = target_user_id
      and request.state in ('processing', 'storage_deleted')
      and request.expires_at > now()
  ) then
    raise exception using errcode = '42501', message = 'Valid account deletion request required';
  end if;
  if not exists (select 1 from auth.users account where account.id = target_user_id) then
    return;
  end if;

  delete from private.marketplace_pickup_disclosures disclosure
  using public.marketplace_pickup_requests pickup_request,
        public.marketplace_conversations conversation
  where disclosure.request_id = pickup_request.id
    and pickup_request.conversation_id = conversation.id
    and target_user_id in (conversation.customer_id, conversation.merchant_id);
  get diagnostics deleted_disclosures = row_count;

  update public.marketplace_pickup_requests pickup_request
  set state = 'cancelled',
      responded_at = coalesce(pickup_request.responded_at, now()),
      version = pickup_request.version + 1,
      updated_at = now()
  from public.marketplace_conversations conversation
  where pickup_request.conversation_id = conversation.id
    and pickup_request.state in ('pending', 'authorized')
    and target_user_id in (conversation.customer_id, conversation.merchant_id);

  delete from public.marketplace_typing_presence presence
  where presence.user_id = target_user_id;
  delete from public.marketplace_read_receipts receipt
  where receipt.user_id = target_user_id;

  update public.marketplace_conversations conversation
  set state = case
        when conversation.customer_id = target_user_id then 'closed_by_customer'
        else 'closed_by_merchant'
      end,
      updated_at = now()
  where target_user_id in (conversation.customer_id, conversation.merchant_id);
  get diagnostics affected_conversations = row_count;

  update public.businesses business
  set state = 'archived',
      created_by = null
  where exists (
    select 1
    from public.business_members owned
    where owned.business_id = business.id
      and owned.user_id = target_user_id
      and owned.role = 'owner'
      and owned.status = 'active'
  )
    and not exists (
      select 1
      from public.business_members other_owner
      where other_owner.business_id = business.id
        and other_owner.user_id <> target_user_id
        and other_owner.role = 'owner'
        and other_owner.status = 'active'
    );

  update public.businesses
  set created_by = null
  where created_by = target_user_id;

  update public.profiles
  set status = 'deleted'
  where user_id = target_user_id;

  perform private.write_audit_event(
    target_user_id,
    null,
    'account.deletion_prepared',
    'account_deletion',
    target_request_id::text,
    jsonb_build_object(
      'marketplace_conversations_closed', affected_conversations,
      'pickup_disclosures_deleted', deleted_disclosures
    )
  );
end;
$$;

revoke all on function public.prepare_account_deletion(uuid, uuid) from public, anon, authenticated;
grant execute on function public.prepare_account_deletion(uuid, uuid) to service_role;
