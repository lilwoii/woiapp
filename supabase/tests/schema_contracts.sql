begin;

do $contract$
declare
  leaked_column text;
  policy_expression text;
begin
  select format('%I.%I', c.table_name, c.column_name)
  into leaked_column
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name in (
      'public_profiles',
      'public_business_directory',
      'public_business_contacts',
      'public_business_locations',
      'public_business_updates',
      'public_business_live_status',
      'public_reviews',
      'public_business_responses',
      'public_media_assets',
      'public_business_media',
      'public_review_media',
      'public_business_review_aggregates'
    )
    and c.column_name in (
      'user_id',
      'author_id',
      'owner_id',
      'created_by',
      'confirmed_by',
      'reviewed_by',
      'reporter_id',
      'blocked_id',
      'actor_id'
    )
  limit 1;
  if leaked_column is not null then
    raise exception 'Public projection leaks an auth UUID column: %', leaked_column;
  end if;

  if has_table_privilege('anon', 'public.businesses', 'select')
    or has_table_privilege('anon', 'public.business_updates', 'select')
    or has_table_privilege('anon', 'public.media_assets', 'select')
    or has_table_privilege('anon', 'public.reviews', 'select')
    or has_table_privilege('anon', 'public.business_responses', 'select')
    or has_table_privilege('anon', 'public.business_live_status', 'select')
  then
    raise exception 'Anonymous role can select an auth-ID-bearing base table';
  end if;

  if not has_table_privilege('anon', 'public.public_business_directory', 'select')
    or not has_table_privilege('anon', 'public.public_reviews', 'select')
    or not has_table_privilege('anon', 'public.public_media_assets', 'select')
    or not has_table_privilege('anon', 'public.business_public_events', 'select')
  then
    raise exception 'Anonymous role is missing a safe public projection grant';
  end if;

  if not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'public_business_locations'
      and c.column_name = 'location_id'
  ) or not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'public_business_locations'
      and c.column_name = 'latitude'
  ) or not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'public_business_locations'
      and c.column_name = 'longitude'
  ) then
    raise exception 'Safe location projection is missing aligned pin fields';
  end if;

  if not exists (
    select 1
    from information_schema.routines r
    where r.routine_schema = 'public'
      and r.routine_name = 'search_businesses'
  ) or not exists (
    select 1
    from information_schema.routines r
    where r.routine_schema = 'public'
      and r.routine_name = 'nearby_businesses'
  ) then
    raise exception 'Required public discovery RPC is missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'create_business_draft'
      and pg_catalog.pg_get_functiondef(p.oid) like '%extensions.digest%'
  ) then
    raise exception 'create_business_draft does not schema-qualify digest';
  end if;

  select coalesce(p.with_check, p.qual)
  into policy_expression
  from pg_catalog.pg_policies p
  where p.schemaname = 'public'
    and p.tablename = 'weekly_hours'
    and p.policyname = 'active members manage weekly hours';
  if policy_expression not like '%can_manage_business_draft%' then
    raise exception 'Weekly-hours mutation policy is not draft/AAL2 constrained';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'review_business_revision'
  ) then
    raise exception 'Published revision apply RPC is missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'account_export_payload'
      and not pg_catalog.has_function_privilege('authenticated', p.oid, 'execute')
  ) then
    raise exception 'Account export service function is client-executable';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_publication p
    where p.pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_catalog.pg_publication_tables pt
    where pt.pubname = 'supabase_realtime'
      and pt.schemaname = 'public'
      and pt.tablename = 'business_public_events'
  ) then
    raise exception 'Safe public event stream is not in supabase_realtime';
  end if;

  if has_table_privilege('authenticated', 'public.reviews', 'insert')
    or has_table_privilege('authenticated', 'public.reviews', 'update')
    or has_table_privilege('authenticated', 'public.business_updates', 'insert')
    or has_table_privilege('authenticated', 'public.business_responses', 'insert')
    or has_table_privilege('authenticated', 'public.content_reports', 'insert')
    or has_table_privilege('authenticated', 'public.user_blocks', 'insert')
  then
    raise exception 'A moderated write table still has a raw client mutation grant';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'submit_review'
      and p.prosecdef
      and pg_catalog.pg_get_functiondef(p.oid) like '%media_asset_ids%'
      and pg_catalog.pg_get_functiondef(p.oid) like
        '%next_moderation public.moderation_state := ''pending''%'
  ) then
    raise exception 'Review submission is not server-moderated and media-aware';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.proname = 'protect_review_author_fields'
      and pg_catalog.pg_get_functiondef(p.oid) like '%''pending''::public.moderation_state%'
  ) then
    raise exception 'Review author trigger is not fail-closed for moderation';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'decide_content_moderation'
      and p.prosecdef
      and pg_catalog.pg_get_functiondef(p.oid) like '%for update%'
      and pg_catalog.pg_get_functiondef(p.oid) like '%MODERATION_TARGET_CHANGED%'
      and pg_catalog.pg_get_functiondef(p.oid) like '%REVIEW_MEDIA_NOT_READY%'
  ) then
    raise exception 'Text moderation decision is not concurrency/media safe';
  end if;

  if not exists (
    select 1
    from unnest(array[
      'submit_business_update',
      'submit_business_response',
      'list_pending_content_moderation',
      'decide_content_moderation',
      'nominate_business_logo',
      'get_business_team',
      'invite_business_member',
      'list_my_business_invitations',
      'respond_business_invitation',
      'set_business_member_role',
      'revoke_business_member',
      'revoke_business_invitation',
      'transfer_business_ownership'
    ]) required(name)
    where not exists (
      select 1
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = required.name
        and p.prosecdef
        and pg_catalog.pg_get_functiondef(p.oid) like '%require_aal2%'
    )
  ) then
    null;
  else
    raise exception 'A required privileged business RPC is missing AAL2';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'business_members'
      and t.tgname = 'business_members_require_active_owner'
      and not t.tgisinternal
  ) then
    raise exception 'Last-owner invariant trigger is missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_indexes i
    where i.schemaname = 'public'
      and i.tablename = 'business_locations'
      and i.indexname = 'business_locations_point_gix'
      and i.indexdef ilike '%using gist%'
  ) or not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'nearby_businesses'
      and pg_catalog.pg_get_functiondef(p.oid) like '%st_dwithin(bl.point%'
      and pg_catalog.pg_get_functiondef(p.oid) like '%has_more%'
  ) then
    raise exception 'Nearby discovery is missing its index-usable/page contract';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_indexes i
    where i.schemaname = 'public'
      and i.indexname = 'businesses_cuisine_search_trgm_idx'
  ) or not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'search_businesses'
      and pg_catalog.pg_get_functiondef(p.oid) like '%matched_business_ids%'
      and pg_catalog.pg_get_functiondef(p.oid) like '%has_more%'
  ) then
    raise exception 'Search is missing indexed candidate pagination';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'submit_business_revision'
      and pg_catalog.pg_get_functiondef(p.oid) like '%proposed_patch || $2%'
  ) or not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'get_my_pending_business_revision'
  ) then
    raise exception 'Published revision merge/inspection workflow is incomplete';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'claim_account_deletion'
      and pg_catalog.pg_get_functiondef(p.oid) like
        '%state in (''started'', ''failed'', ''storage_deleted'')%'
  ) or not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'begin_account_deletion'
      and pg_catalog.pg_get_functiondef(p.oid) like
        '%do update set user_id = adr.user_id%'
  ) then
    raise exception 'Account deletion retry leases are not crash-resumable';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_views v
    where v.schemaname = 'public'
      and v.viewname = 'public_business_media'
      and v.definition like '%business_media_links%'
      and v.definition like '%owner_upload%'
      and v.definition not like
        '%CASE%logo_asset_id%THEN%logo%ELSE%gallery%'
  ) or not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'set_business_gallery_media'
      and p.prosecdef
      and pg_catalog.pg_get_functiondef(p.oid) like '%source = ''owner_upload''%'
  ) then
    raise exception 'Business gallery projection can absorb unlinked review media';
  end if;

  if not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'public_business_responses'
      and c.column_name = 'response_id'
  ) or not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.proname = 'validate_report_target'
      and pg_catalog.pg_get_functiondef(p.oid) like
        '%private.is_business_publicly_eligible%'
      and pg_catalog.pg_get_functiondef(p.oid) like
        '%private.is_media_publicly_eligible%'
      and pg_catalog.pg_get_functiondef(p.oid) like
        '%r.author_id <> new.reporter_id%'
  ) then
    raise exception 'Report targets are not restricted to public non-self content';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'account_export_payload'
      and pg_catalog.pg_get_functiondef(p.oid) like
        '%''schema_version'', ''2026-07-30''%'
      and pg_catalog.pg_get_functiondef(p.oid) like
        '%''authored_business_updates''%'
      and pg_catalog.pg_get_functiondef(p.oid) like
        '%''authored_business_responses''%'
      and pg_catalog.pg_get_functiondef(p.oid) like
        '%''owned_businesses''%'
      and pg_catalog.pg_get_functiondef(p.oid) like
        '%public.st_y(bl.point::public.geometry)%'
      and pg_catalog.pg_get_functiondef(p.oid) not like '%confirmed_by%'
  ) then
    raise exception 'Account export omits owned business data or leaks staff attribution';
  end if;

  if private.content_is_professional('f.u.c.k')
    or private.content_is_professional('f!u!c!k')
    or private.content_is_professional('sh1t')
    or private.content_is_professional('m0therfuuucker')
    or not private.content_is_professional('Bastille pastries and classical bass')
  then
    raise exception 'Professional-content enforcement is bypassable or over-broad';
  end if;
end;
$contract$;

rollback;
