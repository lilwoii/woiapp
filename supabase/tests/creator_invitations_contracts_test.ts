import { assertMatch } from 'https://deno.land/std@0.224.0/assert/mod.ts';

const migration = await Deno.readTextFile(new URL('../migrations/20260915000000_creator_invitations.sql', import.meta.url));

Deno.test('creator invitations are opt-in, established-reviewer only, and block aware', () => {
  assertMatch(migration, /allow_business_invitations boolean not null default false/);
  assertMatch(migration, /count\(\*\) >= 10/);
  assertMatch(migration, /private\.users_are_blocked/);
});

Deno.test('business invitation sending is AAL2, verified, rate limited and idempotent', () => {
  assertMatch(migration, /private\.require_aal2\(\)/);
  assertMatch(migration, /business\.verification = 'verified'/);
  assertMatch(migration, /creator_invite_send_day', 20, 86400/);
  assertMatch(migration, /IDEMPOTENCY_KEY_REUSED/);
  assertMatch(migration, /update_social_profile_with_invitation_consent/);
});

Deno.test('invitations cannot require favorable reviews and raw writes stay closed', () => {
  assertMatch(migration, /review_required boolean not null default false check \(not review_required\)/);
  assertMatch(migration, /positive review\|good review\|required review/);
  assertMatch(migration, /revoke all on public\.creator_invitations/);
  assertMatch(migration, /my_creator_invitations[\s\S]*auth\.uid\(\) in/);
});
