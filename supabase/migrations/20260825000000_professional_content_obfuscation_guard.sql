-- Keep client-facing professionalism checks backed by authoritative database
-- enforcement, including common separator, repetition, and leetspeak bypasses.

create or replace function private.content_is_professional(candidate text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select candidate is null or not exists (
    select 1
    from unnest(array[
      lower(candidate),
      translate(lower(candidate), '013457@$!', 'oieastasi')
    ]) as variant(value)
    where variant.value ~
      '\m(a+[^[:alnum:]]*s+[^[:alnum:]]*s+[^[:alnum:]]*h+[^[:alnum:]]*o+[^[:alnum:]]*l+[^[:alnum:]]*e+|b+[^[:alnum:]]*a+[^[:alnum:]]*s+[^[:alnum:]]*t+[^[:alnum:]]*a+[^[:alnum:]]*r+[^[:alnum:]]*d+|b+[^[:alnum:]]*i+[^[:alnum:]]*t+[^[:alnum:]]*c+[^[:alnum:]]*h+|b+[^[:alnum:]]*u+[^[:alnum:]]*l+[^[:alnum:]]*l+[^[:alnum:]]*s+[^[:alnum:]]*h+[^[:alnum:]]*i+[^[:alnum:]]*t+|c+[^[:alnum:]]*u+[^[:alnum:]]*n+[^[:alnum:]]*t+|d+[^[:alnum:]]*i+[^[:alnum:]]*c+[^[:alnum:]]*k+|f+[^[:alnum:]]*a+[^[:alnum:]]*g+[^[:alnum:]]*g+[^[:alnum:]]*o+[^[:alnum:]]*t+|f+[^[:alnum:]]*u+[^[:alnum:]]*c+[^[:alnum:]]*k+|m+[^[:alnum:]]*o+[^[:alnum:]]*t+[^[:alnum:]]*h+[^[:alnum:]]*e+[^[:alnum:]]*r+[^[:alnum:]]*f+[^[:alnum:]]*u+[^[:alnum:]]*c+[^[:alnum:]]*k+[^[:alnum:]]*e+[^[:alnum:]]*r+|n+[^[:alnum:]]*i+[^[:alnum:]]*g+[^[:alnum:]]*g+[^[:alnum:]]*e+[^[:alnum:]]*r+|s+[^[:alnum:]]*h+[^[:alnum:]]*i+[^[:alnum:]]*t+|s+[^[:alnum:]]*l+[^[:alnum:]]*u+[^[:alnum:]]*t+)\M'
  );
$$;

revoke all on function private.content_is_professional(text) from public, anon, authenticated;
