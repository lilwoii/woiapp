import {
  assert,
  assertEquals,
  assertMatch,
} from "jsr:@std/assert@1";

const root = new URL("../", import.meta.url);

async function text(relativePath: string): Promise<string> {
  return await Deno.readTextFile(new URL(relativePath, root));
}

Deno.test("account function names and methods match the client contract", async () => {
  const config = await text("config.toml");
  const exportSource = await text("functions/export-account/index.ts");
  const deleteSource = await text("functions/delete-account/index.ts");
  const schema = await text("schema.sql");

  assertMatch(config, /\[functions\.export-account\]\s+verify_jwt = true/);
  assertMatch(config, /\[functions\.delete-account\]\s+verify_jwt = true/);
  assert(exportSource.includes('request.method !== "GET"'));
  assert(deleteSource.includes('request.method !== "DELETE"'));
  assert(deleteSource.includes("normalizeIdempotencyKey(request)"));
  assert(deleteSource.includes('x-spottr-delete-confirmation'));
  assert(schema.includes("adr.state in ('started', 'failed', 'storage_deleted')"));
  assert(schema.includes("do update set user_id = adr.user_id"));
  assert(!schema.includes("do update set updated_at = now()\n  returning\n    adr.id"));
  assertEquals(
    (deleteSource.match(/authenticatedUser\(request, true\)/g) ?? []).length,
    1,
  );
});

Deno.test("media is disabled by default and scanner-clean output is server-approved", async () => {
  const stage = await text("functions/media-stage/index.ts");
  const scan = await text("functions/media-scan/index.ts");
  const schema = await text("schema.sql");
  const env = await text("functions/.env.example");
  const config = await text("config.toml");

  assert(stage.includes('SPOTTR_MEDIA_UPLOADS_ENABLED") === "true"'));
  assert(scan.includes('SPOTTR_MEDIA_PIPELINE_ENABLED") !== "true"'));
  assert(scan.includes("malwareClean"));
  assert(scan.includes("metadataStripped"));
  assert(scan.includes("reencoded"));
  assert(scan.includes("SCANNER_HASH_MISMATCH"));
  assert(scan.includes('status: "clean_approved"'));
  assert(schema.includes("when scan_state = 'clean' then 'approved'::public.moderation_state"));
  assert(!schema.includes("'review.media_approved'"));
  assertMatch(env, /SPOTTR_MEDIA_UPLOADS_ENABLED=false/);
  assertMatch(env, /SPOTTR_MEDIA_PIPELINE_ENABLED=false/);
  assertMatch(config, /\[functions\.media-scan\]\s+verify_jwt = false/);
});

Deno.test("shared HTTP layer never enables wildcard CORS", async () => {
  const shared = await text("functions/_shared/http.ts");
  assert(!shared.includes('"Access-Control-Allow-Origin": "*"'));
  assert(shared.includes("SPOTTR_ALLOWED_ORIGINS"));
  assert(shared.includes('"Cache-Control": "no-store"'));
});

Deno.test("route planning is authenticated, server-tokened, and disabled by default", async () => {
  const source = await text("functions/route-plan/index.ts");
  const env = await text("functions/.env.example");
  const config = await text("config.toml");
  assert(source.includes("authenticatedUser(request)"));
  assert(source.includes("MAPBOX_DIRECTIONS_TOKEN"));
  assert(source.includes("SPOTTR_ROUTING_ENABLED"));
  assert(!source.includes("EXPO_PUBLIC_MAPBOX"));
  assertMatch(env, /SPOTTR_ROUTING_ENABLED=false/);
  assertMatch(config, /\[functions\.route-plan\]\s+verify_jwt = true/);
});

Deno.test("database mutation contracts are RPC-only and crash-safe", async () => {
  const schema = await text("schema.sql");

  for (const signature of [
    "function public.submit_review(",
    "function public.submit_business_update(",
    "function public.submit_business_response(",
    "function public.nominate_business_logo(",
    "function public.get_business_team(",
    "function public.invite_business_member(",
    "function public.respond_business_invitation(",
    "function public.transfer_business_ownership(",
    "function public.get_my_pending_business_revision(",
    "function public.list_pending_content_moderation(",
    "function public.decide_content_moderation(",
  ]) {
    assert(schema.includes(signature), `Missing schema contract: ${signature}`);
  }

  assert(schema.includes("'pending'::public.moderation_state"));
  assert(schema.includes("new.moderation := 'pending'::public.moderation_state"));
  assert(schema.includes("MODERATION_TARGET_CHANGED"));
  assert(!schema.includes("grant insert, update on public.reviews to authenticated"));
  assert(!schema.includes("grant insert on public.business_updates to authenticated"));
  assert(!schema.includes("grant insert on public.business_responses to authenticated"));
  assert(schema.includes("proposed_patch = brr.proposed_patch || $2"));
  assert(schema.includes("adr.state in ('started', 'failed', 'storage_deleted')"));
  assert(schema.includes("do update set user_id = adr.user_id"));
  assert(schema.includes("public.st_dwithin(bl.point, p.search_point"));
  assert(schema.includes("businesses_cuisine_search_trgm_idx"));
  assert(schema.includes("from public.business_media_links link"));
  assert(schema.includes("where ma.source in ('owner_upload', 'licensed_provider')"));
  assert(schema.includes("function public.set_business_gallery_media("));
  assert(schema.includes("'schema_version', '2026-07-30'"));
  assert(schema.includes("'owned_businesses'"));
});
