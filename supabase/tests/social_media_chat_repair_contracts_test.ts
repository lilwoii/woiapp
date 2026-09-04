import { assertMatch } from 'https://deno.land/std@0.224.0/assert/mod.ts';

const migration = await Deno.readTextFile(
  new URL('../migrations/20260912000000_social_media_and_chat_report_repair.sql', import.meta.url),
);

Deno.test('social media purposes are accepted by the durable grant constraint', () => {
  assertMatch(migration, /media_stage_grants_purpose_check[\s\S]*'profile_banner'[\s\S]*'business_post'/);
});

Deno.test('public media requires a clean public banner or post link', () => {
  assertMatch(migration, /asset\.quarantine_state = 'clean'/);
  assertMatch(migration, /from public\.business_post_media post_link[\s\S]*post\.moderation = 'approved'/);
  assertMatch(migration, /profile\.banner_path = asset\.processed_storage_path/);
  assertMatch(migration, /not exists \([\s\S]*public\.marketplace_message_media chat_link/);
});

Deno.test('marketplace chat reporting remains valid after report catalog expansion', () => {
  assertMatch(migration, /'chat_message'/);
  assertMatch(migration, /when 'chat_message'[\s\S]*marketplace_conversation_access_allowed/);
  assertMatch(migration, /when 'business_post'[\s\S]*post\.moderation = 'approved'/);
});
