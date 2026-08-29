-- Allow the service-owned account-deletion workflow to apply its terminal
-- profile status even when the database request still carries the user's JWT.
-- The exception is fail-closed: it exists only after a private deletion freeze
-- has been created for the same account and no other server-owned field may
-- change in the same statement.

create or replace function private.protect_profile_server_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  server_fields_changed boolean;
  authorized_deletion_transition boolean := false;
begin
  server_fields_changed :=
    new.user_id is distinct from old.user_id
    or new.status is distinct from old.status
    or new.terms_accepted_at is distinct from old.terms_accepted_at
    or new.terms_version is distinct from old.terms_version
    or new.created_at is distinct from old.created_at;

  if auth.uid() is not null
    and not private.is_platform_staff(auth.uid())
    and server_fields_changed
  then
    authorized_deletion_transition :=
      auth.uid() = old.user_id
      and new.user_id is not distinct from old.user_id
      and new.status = 'deleted'
      and new.status is distinct from old.status
      and new.terms_accepted_at is not distinct from old.terms_accepted_at
      and new.terms_version is not distinct from old.terms_version
      and new.created_at is not distinct from old.created_at
      and exists (
        select 1
        from private.account_deletion_freezes freeze
        join private.account_deletion_requests request
          on request.id = freeze.request_id
         and request.user_id = freeze.user_id
        where freeze.user_id = old.user_id
          and current_setting('spottr.account_deletion_request_id', true) =
            freeze.request_id::text
          and request.state in ('started', 'processing', 'storage_deleted', 'failed')
          and request.expires_at > now()
      );

    if not authorized_deletion_transition then
      raise exception using
        errcode = '42501',
        message = 'Server-owned profile fields cannot be changed';
    end if;
  end if;

  if auth.uid() is not null
    and new.avatar_path is distinct from old.avatar_path
    and new.avatar_path is not null
    and not exists (
      select 1
      from public.media_assets ma
      where ma.owner_id = auth.uid()
        and ma.processed_storage_path = new.avatar_path
        and ma.quarantine_state = 'clean'
        and ma.moderation = 'approved'
    )
  then
    raise exception using errcode = '42501', message = 'Avatar must reference approved media';
  end if;

  new.username := btrim(new.username::text)::public.citext;
  new.display_name := btrim(new.display_name);
  if not private.username_is_valid(new.username::text)
    or not private.content_is_professional(new.username::text)
    or not private.content_is_professional(new.display_name)
  then
    raise exception using errcode = '23514', message = 'Invalid or reserved username';
  end if;
  return new;
end;
$$;

revoke all on function private.protect_profile_server_fields()
  from public, anon, authenticated;

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
  perform pg_catalog.set_config(
    'spottr.account_deletion_request_id', '', true
  );

  if target_user_id is null
    or char_length(coalesce(request_key, '')) not between 16 and 128
    or request_key !~ '^[A-Za-z0-9._:-]+$'
    or not exists (
      select 1 from auth.users account where account.id = target_user_id
    )
  then
    raise exception using
      errcode = '22023',
      message = 'INVALID_ACCOUNT_DELETION_REQUEST';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_user_id::text, 7741902)
  );

  delete from private.account_deletion_requests request
  where request.expires_at < now()
    and request.state = 'completed';

  select request.id, request.state
  into request_id, request_state
  from private.account_deletion_requests request
  where request.user_id = target_user_id
    and request.state in ('started', 'processing', 'storage_deleted', 'failed')
  order by request.created_at
  limit 1;

  if request_id is null then
    fingerprint := pg_catalog.encode(
      extensions.digest(target_user_id::text || ':' || request_key, 'sha256'),
      'hex'
    );
    insert into private.account_deletion_requests as request (
      user_id, request_fingerprint, state
    )
    values (target_user_id, fingerprint, 'started')
    on conflict (request_fingerprint)
    do update set user_id = request.user_id
    returning request.id, request.state into request_id, request_state;
  end if;

  update private.account_deletion_requests
  set expires_at = greatest(expires_at, now() + interval '24 hours'),
      updated_at = now()
  where id = request_id;

  insert into private.account_deletion_freezes (user_id, request_id)
  values (target_user_id, request_id)
  on conflict (user_id) do update set request_id = excluded.request_id;

  perform pg_catalog.set_config(
    'spottr.account_deletion_request_id', request_id::text, true
  );
  begin
    update public.profiles
    set status = 'deleted'
    where user_id = target_user_id;
  exception
    when others then
      perform pg_catalog.set_config(
        'spottr.account_deletion_request_id', '', true
      );
      raise;
  end;
  perform pg_catalog.set_config(
    'spottr.account_deletion_request_id', '', true
  );

  return next;
end;
$$;

revoke all on function public.begin_account_deletion(uuid, text)
  from public, anon, authenticated;
grant execute on function public.begin_account_deletion(uuid, text)
  to service_role;
