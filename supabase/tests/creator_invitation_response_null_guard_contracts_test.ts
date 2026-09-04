import { assertMatch } from 'jsr:@std/assert@1';

const migration = await Deno.readTextFile(
  new URL('../migrations/20261012000000_creator_invitation_response_null_guard.sql', import.meta.url),
);
const runtime = await Deno.readTextFile(
  new URL('./full_stack_security_runtime_test.sql', import.meta.url),
);

Deno.test('business revision approval requires an explicit admin decision', () => {
  assertMatch(
    migration,
    /review_business_revision_null_safe_core[\s\S]*private\.require_aal2\(\)[\s\S]*is_platform_staff\([\s\S]*'admin'[\s\S]*if decision is null[\s\S]*review_business_revision_null_safe_core/,
  );
});

Deno.test('creator invitation acknowledgment is exactly true after owner authorization', () => {
  assertMatch(
    migration,
    /send_creator_invitation_explicit_ack_core[\s\S]*is_active_user\(actor\)[\s\S]*Verified owner or manager required[\s\S]*no_review_required_ack is distinct from true[\s\S]*Review independence acknowledgment required/,
  );
});

Deno.test('business invitation response rejects null before invitation lookup', () => {
  assertMatch(
    migration,
    /create or replace function public\.respond_business_invitation[\s\S]*is_active_user\(actor\)[\s\S]*if decision is null[\s\S]*select invitation\.business_id/,
  );
});

Deno.test('creator invitation responses require an explicit decision after authentication', () => {
  assertMatch(
    migration,
    /if not private\.is_active_user\(actor\)[\s\S]*if decision is null[\s\S]*respond_creator_invitation_null_safe_core/,
  );
  assertMatch(migration, /errcode = '22023'[\s\S]*message = 'Invalid invitation response'/);
});

Deno.test('creator invitation response core is private and the public ACL is exact', () => {
  assertMatch(
    migration,
    /set schema private[\s\S]*revoke all on function private\.respond_creator_invitation_null_safe_core\([\s\S]*from public, anon, authenticated, service_role/,
  );
  assertMatch(
    migration,
    /revoke all on function public\.respond_creator_invitation\(uuid, text, text\)[\s\S]*from public, anon, authenticated, service_role[\s\S]*grant execute on function public\.respond_creator_invitation\(uuid, text, text\)[\s\S]*to authenticated/,
  );
});

Deno.test('runtime coverage proves the effective ACL and null response contract', () => {
  assertMatch(
    runtime,
    /has_function_privilege\([\s\S]*'anon',[\s\S]*'public\.respond_creator_invitation\(uuid,text,text\)'[\s\S]*has_function_privilege\([\s\S]*'service_role',[\s\S]*not has_function_privilege\([\s\S]*'authenticated'/,
  );
  assertMatch(
    runtime,
    /perform public\.respond_creator_invitation\([\s\S]*null,[\s\S]*when sqlstate '22023'[\s\S]*sqlerrm <> 'Invalid invitation response'/,
  );
  assertMatch(
    runtime,
    /perform public\.review_business_revision\([\s\S]*null,[\s\S]*Invalid revision decision[\s\S]*Null business revision decision changed revision or business state/,
  );
  assertMatch(
    runtime,
    /perform public\.respond_business_invitation\([\s\S]*null[\s\S]*Invalid invitation decision[\s\S]*Null business invitation response changed invitation state/,
  );
  assertMatch(
    runtime,
    /perform public\.send_creator_invitation\([\s\S]*null,[\s\S]*Review independence acknowledgment required/,
  );
});
