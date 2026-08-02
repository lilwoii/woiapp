import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

const migrationUrl = new URL(
  "../migrations/20260805000000_secure_marketplace_chat.sql",
  import.meta.url,
);
const mediaStageUrl = new URL("../functions/media-stage/index.ts", import.meta.url);
const migration = await Deno.readTextFile(migrationUrl);
const mediaStage = await Deno.readTextFile(mediaStageUrl);

function section(start: string, end: string): string {
  const startIndex = migration.indexOf(start);
  const endIndex = migration.indexOf(end, startIndex + start.length);
  assert(startIndex >= 0, `missing section start: ${start}`);
  assert(endIndex > startIndex, `missing section end: ${end}`);
  return migration.slice(startIndex, endIndex);
}

Deno.test("chat eligibility is Neighborhood Kitchen mandatory and pop-up opt-in", () => {
  const availability = section(
    "create or replace function private.marketplace_chat_available",
    "create or replace function private.marketplace_conversation_access_allowed",
  );
  assertMatch(availability, /b\.kind = 'home_kitchen'/);
  assertMatch(availability, /b\.kind = 'pop_up' and coalesce\(settings\.enabled, false\)/);
  assertMatch(availability, /private\.is_business_publicly_eligible\(b\.id\)/);
  assertMatch(migration, /HOME_KITCHEN_CHAT_REQUIRED/);
  assertMatch(migration, /CHAT_CATEGORY_NOT_ELIGIBLE/);
  assertMatch(migration, /array\['owner', 'manager'\]::public\.member_role\[\]/);
});

Deno.test("chat tables are participant-RLS protected and mutations are RPC-only", () => {
  for (const table of [
    "marketplace_conversations",
    "marketplace_messages",
    "marketplace_message_media",
    "marketplace_read_receipts",
    "marketplace_typing_presence",
    "marketplace_pickup_requests",
  ]) {
    assert(
      migration.includes(`alter table public.${table} enable row level security`),
      `missing RLS for ${table}`,
    );
  }
  assertMatch(migration, /participants read marketplace conversations/);
  assertMatch(migration, /participants read marketplace messages/);
  assertMatch(migration, /private\.marketplace_conversation_access_allowed/g);
  assertMatch(
    migration,
    /revoke all privileges on table[\s\S]*public\.marketplace_conversations[\s\S]*from public, anon, authenticated/,
  );
  assert(!/grant\s+(insert|update|delete|all)[\s\S]{0,120}marketplace_/i.test(migration));

  const definerFunctions = migration.match(
    /create or replace function[\s\S]*?security definer[\s\S]*?as \$\$/g,
  ) ?? [];
  assert(definerFunctions.length >= 20);
  for (const declaration of definerFunctions) {
    assertMatch(declaration, /set search_path = ''/);
  }
});

Deno.test("message identity projections, sequencing, receipts, and typing are bounded", () => {
  assertMatch(migration, /counterpart_public_profile_id uuid/);
  assertMatch(migration, /sender_public_profile_id uuid/);
  assertMatch(migration, /counterpart_name text/);
  assertMatch(migration, /sender_username text/);
  assertMatch(migration, /sender_avatar_path text/);
  assertMatch(migration, /for update;[\s\S]*next_sequence := target_conversation\.last_sequence \+ 1/);
  assertMatch(migration, /unique \(conversation_id, sequence\)/);
  assertMatch(migration, /greatest\([\s\S]*last_read_sequence/);
  assertMatch(migration, /expires_at <= updated_at \+ interval '15 seconds'/);
  assertMatch(migration, /now\(\) \+ interval '10 seconds'/);
  assertMatch(migration, /marketplace_typing_minute', 120, 60/);
  assertMatch(migration, /marketplace_read_receipt_minute', 120, 60/);
});

Deno.test("chat photos reuse quarantine scanning and fail closed on stale access", () => {
  assert(mediaStage.includes('| "chat_photo"'));
  assertMatch(migration, /media_purpose in \('review_photo', 'chat_photo'\) then 12/);
  assert(mediaStage.includes("can_stage_marketplace_chat_media"));
  assertEquals(
    (mediaStage.match(/await requireChatAccess\(\)/g) ?? []).length,
    2,
  );
  assert(mediaStage.includes('media_source: selectedPurpose === "review_photo" || selectedPurpose === "chat_photo"'));
  assertMatch(migration, /asset\.owner_id = actor/);
  assertMatch(migration, /asset\.business_id = target_conversation\.business_id/);
  assertMatch(migration, /asset\.quarantine_state = 'clean'/);
  assertMatch(migration, /asset\.moderation = 'approved'/);
  assertMatch(migration, /asset\.processed_storage_path is not null/);
  assertMatch(migration, /create or replace function public\.get_marketplace_chat_media_states/);
  assertMatch(migration, /asset\.owner_id = actor/);
  assertMatch(migration, /asset\.business_id = target_conversation\.business_id/);
  assertMatch(migration, /participants read processed marketplace chat media/);
  assertMatch(migration, /aal2 staff read reported marketplace chat media/);
});

Deno.test("blocks, reports, and moderation are enforced without public chat content", () => {
  assertMatch(migration, /not private\.users_are_blocked\(conversation\.customer_id, conversation\.merchant_id\)/);
  assertMatch(migration, /'chat_message'/g);
  assertMatch(migration, /private\.marketplace_conversation_access_allowed\([\s\S]*new\.reporter_id/);
  assertMatch(migration, /target_message\.sender_id is not distinct from actor/);
  assertMatch(migration, /perform private\.require_aal2\(\);[\s\S]*private\.is_platform_staff\(actor\)/);
  assertMatch(migration, /REPORTED_CHAT_MESSAGE_REQUIRED/);
  assertMatch(migration, /CONTENT_POLICY_VIOLATION/);
  assert(!migration.includes("grant execute on function private.marketplace_conversation_access_allowed"));
});

Deno.test("exact pickup details stay private and require mutual authorization", () => {
  const publicSites = section(
    "create table if not exists public.marketplace_pickup_sites",
    "create index if not exists marketplace_pickup_sites_business_state_idx",
  );
  assert(!publicSites.includes("address_line"));
  assert(!publicSites.includes("postal_code"));
  assert(!publicSites.includes("latitude"));
  assert(!publicSites.includes("longitude"));
  assertMatch(migration, /create table if not exists private\.marketplace_pickup_site_details/);
  assertMatch(migration, /create table if not exists private\.marketplace_pickup_disclosures/);
  assertMatch(migration, /site_kind in \('public_meeting_place', 'commercial_site'\)/);
  assertMatch(migration, /RESIDENTIAL_PICKUP_SITE_NOT_ALLOWED/);
  assertMatch(migration, /site\.state = 'approved'/);
  assertMatch(migration, /actor <> target_conversation\.customer_id/);
  assertMatch(migration, /actor <> target_conversation\.merchant_id/);
  assertMatch(migration, /request\.state = 'authorized'/);
  assertMatch(migration, /target_request\.pickup_ends_at \+ interval '12 hours'/);
  assertMatch(migration, /delete from private\.marketplace_pickup_disclosures/);
  const auditCalls = migration.match(
    /perform private\.write_audit_event\([\s\S]*?\n\s+\);/g,
  ) ?? [];
  assert(auditCalls.length >= 10);
  for (const auditCall of auditCalls) {
    assert(!auditCall.includes("disclosure.address_line"));
    assert(!auditCall.includes("target_details.address_line"));
    assert(!auditCall.includes("target_details.latitude"));
    assert(!auditCall.includes("target_details.longitude"));
  }
});

Deno.test("durable mutations are idempotent, flood-limited, and redacted in audit", () => {
  assertMatch(migration, /private\.idempotency_key_hash\(idempotency_key\)/g);
  assertMatch(migration, /private\.marketplace_chat_idempotent_response/g);
  assertMatch(migration, /private\.store_marketplace_chat_idempotency/g);
  assertMatch(migration, /private\.consume_rate_limit/g);
  assertMatch(migration, /private\.write_audit_event/g);
  assertMatch(migration, /marketplace_message_minute', 30, 60/);
  assertMatch(migration, /marketplace_message_day', 500, 86400/);
  assertMatch(migration, /'body_length', coalesce\(char_length\(normalized_body\), 0\)/);
  assert(!/write_audit_event\([\s\S]{0,500}'body', normalized_body/i.test(migration));
  assertMatch(migration, /cleanup_marketplace_chat_ephemera/);
  assertMatch(migration, /grant execute on function public\.cleanup_marketplace_chat_ephemera\(\) to service_role/);
});
