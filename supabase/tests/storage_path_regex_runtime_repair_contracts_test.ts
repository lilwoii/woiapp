import { assert, assertMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20260822000000_storage_path_regex_runtime_repair.sql",
    import.meta.url,
  ),
);

Deno.test("media storage path validation avoids unsupported PostgreSQL bounds", () => {
  assertMatch(
    migration,
    /create or replace function private\.is_valid_media_storage_path/,
  );
  assertMatch(migration, /char_length\(target_path\) <= 512/);
  assertMatch(
    migration,
    /target_path ~ '\^\(quarantine\|published\)\/\[A-Za-z0-9\]\[A-Za-z0-9\/_.-\]\*\$'/,
  );
  assert(!migration.includes("{0,499}"));
  assert(!migration.includes("{0,510}"));
});

Deno.test("every affected cleanup and deletion boundary uses the shared validator", () => {
  assertMatch(migration, /drop constraint if exists media_cleanup_items_path/);
  assertMatch(migration, /drop constraint if exists account_deletion_storage_path/);
  assertMatch(
    migration,
    /create or replace function public\.prepare_media_cleanup_batch\(\)/,
  );
  assertMatch(
    migration,
    /create or replace function public\.finalize_media_cleanup_batch/,
  );
  assertMatch(
    migration,
    /create or replace function public\.checkpoint_account_deletion_storage_batch/,
  );
  assertMatch(
    migration,
    /private\.is_valid_media_storage_path\(object\.name\)/,
  );
  assertMatch(
    migration,
    /private\.is_valid_media_storage_path\(supplied\.path\)/,
  );
  assertMatch(
    migration,
    /revoke all on function private\.is_valid_media_storage_path\(text\)[\s\S]*from public, anon, authenticated/,
  );
});
