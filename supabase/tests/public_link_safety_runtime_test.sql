\set ON_ERROR_STOP on

begin;

do $public_link_function_contract$
declare
  candidate text;
begin
  if not private.public_https_url_is_safe(
    'https://food.example.com/menu?q=tacos#today',
    500
  ) then
    raise exception 'A valid public HTTPS URL was rejected';
  end if;

  foreach candidate in array array[
    'http://example.com',
    'https://' || 'user:' || 'password' || '@example.com',
    'https://localhost/menu',
    'https://localhost./menu',
    'https://kitchen.local/menu',
    'https://kitchen.internal/menu',
    'https://intranet/menu',
    'https://127.0.0.1/menu',
    'https://10.0.0.1/menu',
    'https://0x7f.0x0.0x0.0x1/menu',
    'https://[::1]/menu',
    'https://example.com:8443/menu',
    'https://example.com./menu'
  ] loop
    if private.public_https_url_is_safe(candidate, 500) then
      raise exception 'Unsafe public URL was accepted: %', candidate;
    end if;
  end loop;

  if has_function_privilege(
      'anon',
      'private.public_https_url_is_safe(text,integer)',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'private.public_https_url_is_safe(text,integer)',
      'execute'
    )
  then
    raise exception 'Application roles can execute the private public-link validator';
  end if;
end;
$public_link_function_contract$;

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
values (
  'c6000000-0000-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  'public-link-runtime@spottr.invalid',
  now(),
  '{}'::jsonb,
  '{"username":"public_link_runtime","display_name":"Public Link Runtime","terms_accepted":true}'::jsonb,
  now(),
  now()
);

do $profile_link_constraint_contract$
begin
  begin
    update public.profiles
    set links = '[{"label":"Local","url":"https://127.0.0.1/admin"}]'::jsonb
    where user_id = 'c6000000-0000-4000-8000-000000000001';
    raise exception 'Unsafe profile link bypassed the table constraint';
  exception
    when check_violation then null;
  end;

  update public.profiles
  set links = '[{"label":"Menu","url":"https://food.example.com/menu"}]'::jsonb
  where user_id = 'c6000000-0000-4000-8000-000000000001';

  if not found then
    raise exception 'Profile link runtime fixture was not created';
  end if;
end;
$profile_link_constraint_contract$;

insert into public.businesses (
  id,
  kind,
  name,
  slug,
  state,
  verification,
  created_by
)
values (
  'c6000000-0000-4000-8000-000000000002',
  'restaurant',
  'Public Link Runtime Kitchen',
  'public-link-runtime-kitchen',
  'draft',
  'unverified',
  'c6000000-0000-4000-8000-000000000001'
);

insert into public.business_private_details (
  business_id,
  website_url,
  show_website_public
)
values (
  'c6000000-0000-4000-8000-000000000002',
  'https://food.example.com/menu',
  true
);

do $business_link_constraint_contract$
begin
  begin
    update public.business_private_details
    set website_url = 'https://kitchen.internal/menu'
    where business_id = 'c6000000-0000-4000-8000-000000000002';
    raise exception 'Unsafe business link bypassed the table constraint';
  exception
    when check_violation then null;
  end;

  -- Provider ingestion deliberately stores source material with public display
  -- disabled. An unsafe provider website must not abort the rest of the batch,
  -- and the public projection must continue to omit it.
  update public.business_private_details
  set website_url = 'https://example.com:8443/provider-menu',
      show_website_public = false
  where business_id = 'c6000000-0000-4000-8000-000000000002';

  if exists (
    select 1
    from public.public_business_contacts
    where business_id = 'c6000000-0000-4000-8000-000000000002'
      and website_url is not null
  ) then
    raise exception 'Hidden unsafe provider website entered the public projection';
  end if;

  begin
    update public.business_private_details
    set show_website_public = true
    where business_id = 'c6000000-0000-4000-8000-000000000002';
    raise exception 'Unsafe hidden provider website became public';
  exception
    when check_violation then null;
  end;

  update public.business_private_details
  set website_url = 'https://food.example.com/menu',
      show_website_public = true
  where business_id = 'c6000000-0000-4000-8000-000000000002';

  begin
    insert into private.business_revision_requests (
      business_id,
      requested_by,
      base_updated_at,
      proposed_patch
    )
    values (
      'c6000000-0000-4000-8000-000000000002',
      'c6000000-0000-4000-8000-000000000001',
      now(),
      jsonb_build_object(
        'contacts',
        jsonb_build_object(
          'website_url',
          'https://' || 'user:' || 'password' || '@example.com'
        )
      )
    );
    raise exception 'Unsafe staged business link bypassed the revision trigger';
  exception
    when sqlstate '22023' then null;
  end;
end;
$business_link_constraint_contract$;

do $public_link_projection_contract$
declare
  contacts_definition text;
  profiles_definition text;
begin
  select pg_catalog.pg_get_viewdef('public.public_business_contacts'::regclass, true)
  into contacts_definition;
  select pg_catalog.pg_get_viewdef('public.public_profile_directory'::regclass, true)
  into profiles_definition;

  if contacts_definition not like '%public_https_url_is_safe%'
    or profiles_definition not like '%validate_public_profile_links%'
  then
    raise exception 'Public projections do not revalidate user-published links';
  end if;
end;
$public_link_projection_contract$;

rollback;
