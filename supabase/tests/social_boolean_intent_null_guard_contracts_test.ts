import { assertMatch } from 'jsr:@std/assert@1';

const migration = await Deno.readTextFile(
  new URL('../migrations/20261013000000_social_boolean_intent_null_guard.sql', import.meta.url),
);
const runtime = await Deno.readTextFile(
  new URL('./full_stack_security_runtime_test.sql', import.meta.url),
);

Deno.test('block intent is explicit after active-account authorization', () => {
  assertMatch(
    migration,
    /set_user_block_explicit_intent_core[\s\S]*is_active_user\(actor\)[\s\S]*should_block is null[\s\S]*Invalid block intent[\s\S]*set_user_block_explicit_intent_core/,
  );
});

Deno.test('follow intent is explicit after active-account authorization', () => {
  assertMatch(
    migration,
    /set_profile_follow_explicit_intent_core[\s\S]*is_active_user\(actor\)[\s\S]*should_follow is null[\s\S]*Invalid follow intent[\s\S]*set_profile_follow_explicit_intent_core/,
  );
});

Deno.test('social mutation cores are private and public ACLs are exact', () => {
  assertMatch(
    migration,
    /revoke all on function private\.set_user_block_explicit_intent_core\(uuid, boolean\)[\s\S]*from public, anon, authenticated, service_role/,
  );
  assertMatch(
    migration,
    /revoke all on function public\.set_user_block_by_public_id\(uuid, boolean\)[\s\S]*from public, anon, authenticated, service_role[\s\S]*grant execute[\s\S]*to authenticated/,
  );
  assertMatch(
    migration,
    /revoke all on function private\.set_profile_follow_explicit_intent_core\(uuid, boolean\)[\s\S]*from public, anon, authenticated, service_role/,
  );
});

Deno.test('runtime coverage proves malformed intents preserve both relationships', () => {
  assertMatch(
    runtime,
    /set_config\([\s\S]*'spottr\.runtime\.social_target_public_id'[\s\S]*profile\.public_id::text[\s\S]*set local role authenticated[\s\S]*current_setting\([\s\S]*'spottr\.runtime\.social_target_public_id'/,
  );
  assertMatch(
    runtime,
    /set_profile_follow_by_public_id\([\s\S]*null[\s\S]*Invalid follow intent[\s\S]*Null follow intent removed an existing follow/,
  );
  assertMatch(
    runtime,
    /set_user_block_by_public_id\([\s\S]*null[\s\S]*Invalid block intent[\s\S]*Null block intent removed an existing safety block/,
  );
});
