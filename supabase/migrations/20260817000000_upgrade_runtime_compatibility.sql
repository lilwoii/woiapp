-- Forward-only compatibility for databases created before the fresh-runtime gate.
-- Public discovery must use projections, and PostgreSQL 17 reserves aliases that
-- older PostgreSQL releases accepted inside lazily compiled PL/pgSQL statements.

revoke select on
  public.businesses,
  public.business_updates,
  public.media_assets,
  public.reviews,
  public.business_responses,
  public.business_live_status
from anon;

do $repair$
declare
  routine record;
  definition text;
  repaired text;
  pgcrypto_schema text;
  postgis_schema text;
  citext_schema text;
  digest_call text;
  geometry_type text;
  geography_type text;
  citext_type text;
begin
  select namespace.nspname
  into strict pgcrypto_schema
  from pg_catalog.pg_extension extension
  join pg_catalog.pg_namespace namespace on namespace.oid = extension.extnamespace
  where extension.extname = 'pgcrypto';

  select namespace.nspname
  into strict postgis_schema
  from pg_catalog.pg_extension extension
  join pg_catalog.pg_namespace namespace on namespace.oid = extension.extnamespace
  where extension.extname = 'postgis';

  select namespace.nspname
  into strict citext_schema
  from pg_catalog.pg_extension extension
  join pg_catalog.pg_namespace namespace on namespace.oid = extension.extnamespace
  where extension.extname = 'citext';

  digest_call := pg_catalog.quote_ident(pgcrypto_schema) || '.digest(';
  geometry_type := pg_catalog.quote_ident(postgis_schema) || '.geometry';
  geography_type := pg_catalog.quote_ident(postgis_schema) || '.geography';
  citext_type := pg_catalog.quote_ident(citext_schema) || '.citext';

  for routine in
    select procedure.oid
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
    join pg_catalog.pg_language language on language.oid = procedure.prolang
    where namespace.nspname in ('public', 'private')
      and procedure.prokind = 'f'
      and language.lanname in ('plpgsql', 'sql')
      and not exists (
        select 1
        from pg_catalog.pg_depend dependency
        where dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          and dependency.objid = procedure.oid
          and dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
          and dependency.deptype = 'e'
      )
      and (
        pg_catalog.pg_get_functiondef(procedure.oid) like '%account_deletion_freezes freeze%'
        or pg_catalog.pg_get_functiondef(procedure.oid) like '%media_stage_grants grant%'
        or pg_catalog.pg_get_functiondef(procedure.oid) like '%public.digest(%'
        or pg_catalog.pg_get_functiondef(procedure.oid) like '%extensions.digest(%'
        or pg_catalog.pg_get_functiondef(procedure.oid) like '%::geometry%'
        or pg_catalog.pg_get_functiondef(procedure.oid) like '%::geography%'
        or pg_catalog.pg_get_functiondef(procedure.oid) like '%::citext%'
        or pg_catalog.pg_get_functiondef(procedure.oid) like '% geometry(%'
        or pg_catalog.pg_get_functiondef(procedure.oid) like '% geography(%'
        or pg_catalog.pg_get_functiondef(procedure.oid) like '%target_email citext;%'
        or pg_catalog.pg_get_functiondef(procedure.oid) like '%next_business_email citext;%'
      )
    order by procedure.oid
  loop
    definition := pg_catalog.pg_get_functiondef(routine.oid);
    repaired := pg_catalog.replace(
      pg_catalog.replace(
        pg_catalog.replace(
          pg_catalog.replace(
            pg_catalog.replace(
              pg_catalog.replace(
                pg_catalog.replace(
                  pg_catalog.replace(
                    pg_catalog.replace(
                      pg_catalog.replace(
                        pg_catalog.replace(
                          definition,
                          'public.digest(',
                          digest_call
                        ),
                        'extensions.digest(',
                        digest_call
                      ),
                      '::geometry',
                      '::' || geometry_type
                    ),
                    '::geography',
                    '::' || geography_type
                  ),
                  '::citext',
                  '::' || citext_type
                ),
                'target_email citext;',
                'target_email ' || citext_type || ';'
              ),
              'next_business_email citext;',
              'next_business_email ' || citext_type || ';'
            ),
            'account_deletion_freezes freeze',
            'account_deletion_freezes deletion_freeze'
          ),
          'freeze.',
          'deletion_freeze.'
        ),
        'media_stage_grants grant',
        'media_stage_grants stage_grant'
      ),
      'grant.',
      'stage_grant.'
    );
    repaired := pg_catalog.replace(
      pg_catalog.replace(
        repaired,
        ' geometry(',
        ' ' || geometry_type || '('
      ),
      ' geography(',
      ' ' || geography_type || '('
    );
    if repaired <> definition then
      execute repaired;
    end if;
  end loop;
end;
$repair$;

do $contract$
declare
  pgcrypto_schema text;
begin
  select namespace.nspname
  into strict pgcrypto_schema
  from pg_catalog.pg_extension extension
  join pg_catalog.pg_namespace namespace on namespace.oid = extension.extnamespace
  where extension.extname = 'pgcrypto';

  if exists (
    select 1
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
    join pg_catalog.pg_language language on language.oid = procedure.prolang
    where namespace.nspname in ('public', 'private')
      and procedure.prokind = 'f'
      and language.lanname in ('plpgsql', 'sql')
      and not exists (
        select 1
        from pg_catalog.pg_depend dependency
        where dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          and dependency.objid = procedure.oid
          and dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
          and dependency.deptype = 'e'
      )
      and (
        pg_catalog.pg_get_functiondef(procedure.oid) like '%account_deletion_freezes freeze%'
        or pg_catalog.pg_get_functiondef(procedure.oid) like '%media_stage_grants grant%'
        or pg_catalog.pg_get_functiondef(procedure.oid) like '%::geometry%'
        or pg_catalog.pg_get_functiondef(procedure.oid) like '%::geography%'
        or pg_catalog.pg_get_functiondef(procedure.oid) like '%::citext%'
        or pg_catalog.pg_get_functiondef(procedure.oid) like '% geometry(%'
        or pg_catalog.pg_get_functiondef(procedure.oid) like '% geography(%'
        or pg_catalog.pg_get_functiondef(procedure.oid) like '%target_email citext;%'
        or pg_catalog.pg_get_functiondef(procedure.oid) like '%next_business_email citext;%'
        or (
          pgcrypto_schema <> 'public'
          and pg_catalog.pg_get_functiondef(procedure.oid) like '%public.digest(%'
        )
        or (
          pgcrypto_schema <> 'extensions'
          and pg_catalog.pg_get_functiondef(procedure.oid) like '%extensions.digest(%'
        )
      )
  ) then
    raise exception 'Legacy aliases or extension namespaces remain in stored functions';
  end if;
end;
$contract$;
