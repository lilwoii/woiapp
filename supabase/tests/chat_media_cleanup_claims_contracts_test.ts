import {
  assert,
  assertEquals,
  assertMatch,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  chunkPaths,
  parseCleanupBatch,
  parseLegacyCleanupPaths,
} from "../functions/media-cleanup/contract.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20260808000000_chat_media_cleanup_claims.sql",
    import.meta.url,
  ),
);
const cleanup = await Deno.readTextFile(
  new URL("../functions/media-cleanup/index.ts", import.meta.url),
);
const scanner = await Deno.readTextFile(
  new URL("../functions/media-scan/index.ts", import.meta.url),
);

Deno.test("cleanup claims serialize selection with message attachment", () => {
  assertMatch(
    migration,
    /create table if not exists private\.chat_media_cleanup_claims/,
  );
  assertMatch(migration, /for update of asset skip locked/);
  assertMatch(migration, /claim\.lease_expires_at <= now\(\)/);
  assertMatch(migration, /for update;/);
  assertMatch(migration, /CHAT_MEDIA_CLEANUP_CLAIMED/);
  assertMatch(migration, /source = 'chat_upload'/);
  assertMatch(migration, /quarantine_state = 'clean'/);
  assertMatch(migration, /moderation = 'approved'/);
  assertMatch(migration, /not exists \([\s\S]*marketplace_message_media/);
});

Deno.test("cleanup finalization requires a complete storage receipt", () => {
  assertMatch(migration, /INCOMPLETE_CHAT_MEDIA_CLEANUP_RECEIPT/);
  assertMatch(
    migration,
    /not \(asset\.storage_path = any\(normalized_paths\)\)/,
  );
  assertMatch(
    migration,
    /not \(asset\.processed_storage_path = any\(normalized_paths\)\)/,
  );
  assertMatch(
    migration,
    /revoke all on function public\.prepare_chat_media_cleanup_batch\(\)[\s\S]*to service_role/,
  );
  assertMatch(
    migration,
    /revoke all on function public\.finalize_chat_media_cleanup_batch/,
  );
});

Deno.test("edge worker validates, deletes, and finalizes claimed media first", () => {
  const prepare = cleanup.indexOf("prepare_chat_media_cleanup_batch");
  const finalize = cleanup.indexOf("finalize_chat_media_cleanup_batch");
  const durable = cleanup.indexOf("prepare_media_cleanup_batch");
  assert(prepare >= 0 && finalize > prepare && durable > finalize);
  assertMatch(scanner, /MEDIA_RAW_SOURCE_CLEANUP_DEFERRED/);
});

Deno.test("cleanup manifest parsing fails closed", () => {
  const valid = parseCleanupBatch({
    batch_id: "22222222-2222-4222-8222-222222222222",
    storage_paths: [
      "quarantine/users/abc/photo.jpg",
      "published/profiles/abc.webp",
    ],
  });
  assertEquals(valid.paths.length, 2);
  assertThrows(() => parseCleanupBatch({ batch_id: "bad", storage_paths: [] }));
  assertThrows(() =>
    parseCleanupBatch({
      batch_id: "22222222-2222-4222-8222-222222222222",
      storage_paths: ["../../secret"],
    })
  );
  assertThrows(() =>
    parseLegacyCleanupPaths({
      storage_paths: ["quarantine/a/x.png", "quarantine/a/x.png"],
    })
  );
  assertEquals(
    chunkPaths(Array.from({ length: 201 }, (_, index) => `path-${index}`)).map((
      part,
    ) => part.length),
    [100, 100, 1],
  );
});
