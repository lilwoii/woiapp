import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(new URL(
  "../migrations/20260806000000_chat_privacy_lifecycle.sql",
  import.meta.url,
));

function section(start: string, end: string): string {
  const startIndex = migration.indexOf(start);
  const endIndex = migration.indexOf(end, startIndex + start.length);
  assert(startIndex >= 0, `missing section start: ${start}`);
  assert(endIndex > startIndex, `missing section end: ${end}`);
  return migration.slice(startIndex, endIndex);
}

Deno.test("chat participants are pseudonymized without deleting the shared thread", () => {
  assertEquals((migration.match(/on delete set null/g) ?? []).length >= 2, true);
  assertMatch(migration, /alter column customer_id drop not null/);
  assertMatch(migration, /alter column merchant_id drop not null/);
  assertMatch(migration, /marketplace_participant_deletion_stamp/);
  assertMatch(migration, /new\.customer_deleted_at := coalesce/);
  assertMatch(migration, /new\.merchant_deleted_at := coalesce/);
});

Deno.test("one active pickup disclosure is enforced and public pickup fields are DLP checked", () => {
  assertMatch(migration, /marketplace_pickup_one_active_idx/);
  assertMatch(migration, /where state in \('pending', 'authorized'\)/);
  assertMatch(migration, /ACTIVE_PICKUP_REQUEST_DEDUPLICATION_REQUIRED/);
  assertMatch(migration, /concat_ws\([\s\S]*coalesce\(site_label, ''\)[\s\S]*coalesce\(city, ''\)[\s\S]*coalesce\(region, ''\)/);
  assertMatch(migration, /create or replace function public\.review_marketplace_pickup_site/);
  assertMatch(migration, /PUBLIC_PICKUP_FIELDS_SENSITIVE/);
  assertMatch(migration, /revoke all on function public\.review_marketplace_pickup_site_core/);
});

Deno.test("account deletion revokes exact pickup data before Auth deletion", () => {
  const deletion = section(
    "create or replace function public.prepare_account_deletion",
    "revoke all on function public.prepare_account_deletion",
  );
  const disclosureDelete = deletion.indexOf("delete from private.marketplace_pickup_disclosures");
  const conversationClose = deletion.indexOf("update public.marketplace_conversations");
  assert(disclosureDelete >= 0);
  assert(conversationClose > disclosureDelete);
  assertMatch(deletion, /pickup_request\.state in \('pending', 'authorized'\)/);
  assertMatch(deletion, /set state = 'cancelled'/);
  assertMatch(deletion, /'pickup_disclosures_deleted', deleted_disclosures/);
  assert(!deletion.includes("customer_deleted_at ="));
  assert(!deletion.includes("merchant_deleted_at ="));
});

Deno.test("account deletion has one serialized live receipt per user", () => {
  assertMatch(migration, /account_deletion_one_live_request_idx/);
  assertMatch(migration, /state in \('started', 'processing', 'storage_deleted', 'failed'\)/);
  assertMatch(migration, /pg_catalog\.pg_advisory_xact_lock/);
  assertMatch(migration, /where request\.user_id = target_user_id/);
  assertMatch(migration, /ACCOUNT_DELETION_RECEIPT_DEDUPLICATION_REQUIRED/);
});

Deno.test("chat export is scoped to the subject and omits private moderation notes", () => {
  const accountExport = section(
    "create or replace function public.account_export_payload",
    "revoke all on function public.account_export_payload",
  );
  assertMatch(accountExport, /'marketplace_chat'/);
  assertMatch(accountExport, /'authored_messages'/);
  assertMatch(accountExport, /message\.sender_id = target_user_id/);
  assertMatch(accountExport, /target_user_id in \(conversation\.customer_id, conversation\.merchant_id\)/);
  assertMatch(accountExport, /'submitted_or_owned_pickup_sites'/);
  assert(!accountExport.includes("moderation_reason"));
  assert(!accountExport.includes("review_reason"));
});

Deno.test("raw chat tables are not readable and storage uses narrow definer checks", () => {
  assertMatch(migration, /revoke select on table[\s\S]*public\.marketplace_conversations[\s\S]*from authenticated/);
  assertMatch(migration, /private\.can_read_marketplace_chat_media_object\(name, auth\.uid\(\)\)/);
  assertMatch(migration, /private\.can_staff_read_reported_chat_media_object\(name, auth\.uid\(\)\)/);
  assertMatch(migration, /security definer[\s\S]*set search_path = ''/);
  assertMatch(migration, /revoke all on function private\.can_read_marketplace_chat_media_object/);
  assertMatch(migration, /grant execute on function private\.can_read_marketplace_chat_media_object[\s\S]*to authenticated/);
  assertMatch(migration, /grant execute on function private\.can_staff_read_reported_chat_media_object[\s\S]*to authenticated/);
});

Deno.test("chat photos have a private source and cannot inherit public business media access", () => {
  assertMatch(migration, /'chat_upload'/);
  assertMatch(migration, /set source = 'chat_upload'[\s\S]*public\.marketplace_message_media link/);
  assertMatch(migration, /asset\.source <> 'chat_upload'/);
  assertMatch(migration, /not exists \([\s\S]*public\.marketplace_message_media chat_link/);
  assertMatch(migration, /business\.logo_asset_id = asset\.id/);
  assertMatch(migration, /public\.business_media_links/);
  assertMatch(migration, /create or replace function public\.register_quarantined_chat_media/);
  assertMatch(migration, /private\.marketplace_conversation_write_allowed\(conversation\.id, actor\)/);
  assertMatch(migration, /asset\.source = 'chat_upload'/);
  assertMatch(migration, /grant execute on function private\.is_media_publicly_eligible\(uuid\) to anon, authenticated/);
});

Deno.test("server DLP fails closed for high-confidence secrets and precise locations", () => {
  assertMatch(migration, /SENSITIVE_PAYMENT_DATA_BLOCKED/);
  assertMatch(migration, /PRECISE_LOCATION_BLOCKED/);
  assertMatch(migration, /private\.marketplace_chat_safety_code\(coalesce\(message_body, ''\)\)/);
  assertMatch(migration, /revoke all on function public\.send_marketplace_message_core/);
  assertMatch(migration, /grant execute on function public\.send_marketplace_message[\s\S]*to authenticated/);
});
