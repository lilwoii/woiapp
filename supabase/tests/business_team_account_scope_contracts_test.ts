import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

const businessTeam = await Deno.readTextFile(
  new URL("../../lib/business-team.ts", import.meta.url),
);
const businessTeamScreen = await Deno.readTextFile(
  new URL("../../app/business-team.tsx", import.meta.url),
);
const schema = await Deno.readTextFile(
  new URL("../schema.sql", import.meta.url),
);
const authoritySerializationMigration = await Deno.readTextFile(
  new URL(
    "../migrations/20260903000000_business_team_authority_serialization.sql",
    import.meta.url,
  ),
);

const screenActionOrder = [
  "sendInvitation",
  "changeRole",
  "removeMember",
  "transferOwnership",
  "respondToInvitation",
  "cancelBusinessInvitation",
] as const;

function sourceFunctionBody(source: string, name: string): string {
  const marker = `export async function ${name}(`;
  const start = source.indexOf(marker);
  const next = source.indexOf("\nexport async function ", start + marker.length);
  assert(start >= 0, `missing source function ${name}`);
  return source.slice(start, next >= 0 ? next : source.length);
}

function screenActionBody(name: string): string {
  const marker = `  const ${name} = async`;
  const start = businessTeamScreen.indexOf(marker);
  assert(start >= 0, `missing screen action ${name}`);
  const actionIndex = screenActionOrder.indexOf(
    name as (typeof screenActionOrder)[number],
  );
  assert(actionIndex >= 0, `missing screen action boundary ${name}`);
  const nextAction = screenActionOrder[actionIndex + 1];
  const nextMarker = nextAction
    ? `\n  const ${nextAction} = async`
    : "\n  const gate =";
  const end = businessTeamScreen.indexOf(nextMarker, start + marker.length);
  assert(end > start, `missing end boundary for screen action ${name}`);
  return businessTeamScreen.slice(start, end);
}

function schemaFunctionBody(name: string): string {
  const start = schema.indexOf(`create or replace function ${name}(`);
  const end = schema.indexOf("$$;", start);
  assert(start >= 0 && end > start, `missing database function ${name}`);
  return schema.slice(start, end);
}

const operations = [
  ["loadBusinessTeam", "get_business_team"],
  ["loadMyBusinessInvitations", "list_my_business_invitations"],
  ["inviteBusinessTeamMember", "invite_business_member"],
  ["respondToBusinessInvitation", "respond_business_invitation"],
  ["changeBusinessMemberRole", "set_business_member_role"],
  ["revokeBusinessTeamAccess", "revoke_business_member"],
  ["revokeBusinessTeamInvitation", "revoke_business_invitation"],
  ["transferBusinessOwnership", "transfer_business_ownership"],
] as const;

const serializedMutations = [
  ["invite_business_member", "select bm.role"],
  ["respond_business_invitation", "select lower(u.email)"],
  ["set_business_member_role", "if not private.is_business_member"],
  ["revoke_business_member", "select bm.role"],
  ["revoke_business_invitation", "select bm.role"],
  ["transfer_business_ownership", "if not private.is_business_member"],
] as const;

Deno.test("every private team operation uses the initiating account's bound client", () => {
  assertMatch(businessTeam, /createAccountBoundSupabaseClient/);
  assertMatch(
    businessTeam,
    /async function secureClient\(expectedUserId: string\)/,
  );
  assertMatch(
    businessTeam,
    /const client = await createAccountBoundSupabaseClient\(expectedUserId\)/,
  );
  assertEquals(
    businessTeam.match(/secureClient\(expectedUserId\)/g)?.length,
    operations.length,
  );
  assert(!businessTeam.includes("supabase.auth.getUser()"));
  assert(!businessTeam.includes("supabase.auth.mfa.getAuthenticatorAssuranceLevel()"));

  for (const [sourceName, rpcName] of operations) {
    const body = sourceFunctionBody(businessTeam, sourceName);
    assertMatch(body, /secureClient\(expectedUserId\)/);
    assert(
      body.includes(`rpc('${rpcName}'`),
      `${sourceName} must call only its account-bound ${rpcName} RPC`,
    );
  }
});

Deno.test("team RPCs independently require AAL2 and server-side authority", () => {
  for (const [, rpcName] of operations) {
    assertMatch(schemaFunctionBody(`public.${rpcName}`), /private\.require_aal2\(\)/);
  }

  assertMatch(
    schemaFunctionBody("public.get_business_team"),
    /actor_role not in \('owner', 'manager'\)/,
  );
  assertMatch(
    schemaFunctionBody("public.set_business_member_role"),
    /array\['owner'\]::public\.member_role\[\]/,
  );
  const transfer = schemaFunctionBody("public.transfer_business_ownership");
  assertMatch(transfer, /business_ownership_transfer/);
  assertMatch(transfer, /for update/);
  assertMatch(transfer, /business\.ownership_transferred/);
});

Deno.test("team authority is serialized before every business mutation", () => {
  for (const [rpcName, authorityMarker] of serializedMutations) {
    const baseline = schemaFunctionBody(`public.${rpcName}`);
    const lockMatch = baseline.match(
      /from public\.businesses [a-z]+[\s\S]*?for update/,
    );
    assert(lockMatch, `${rpcName} must lock its business row`);
    assert(
      baseline.indexOf(lockMatch[0]) < baseline.indexOf(authorityMarker),
      `${rpcName} must lock before evaluating caller authority`,
    );

    const upgraded = (() => {
      const start = authoritySerializationMigration.indexOf(
        `create or replace function public.${rpcName}(`,
      );
      const end = authoritySerializationMigration.indexOf("$$;", start);
      assert(start >= 0 && end > start, `missing upgrade wrapper ${rpcName}`);
      return authoritySerializationMigration.slice(start, end);
    })();
    assertMatch(upgraded, /private\.require_aal2\(\)/);
    assertMatch(
      upgraded,
      /from public\.businesses business[\s\S]*?for update/,
    );
    assert(
      upgraded.includes(`private.${rpcName}_core(`),
      `${rpcName} upgrade wrapper must delegate only after locking`,
    );
    assert(
      authoritySerializationMigration.includes(
        `alter function public.${rpcName}(`,
      ),
      `${rpcName} upgrade must retire the unlocked public implementation`,
    );
    assert(
      authoritySerializationMigration.includes(
        `rename to ${rpcName}_core;`,
      ),
      `${rpcName} upgrade must keep the retired implementation private`,
    );
    assertMatch(
      authoritySerializationMigration,
      new RegExp(
        `revoke all on function private\\.${rpcName}_core\\([\\s\\S]*?from public, anon, authenticated;`,
      ),
    );
  }
});

Deno.test("team UI remounts private state and serializes confirmations and writes", () => {
  assertMatch(
    businessTeamScreen,
    /key=\{`\$\{accountScope\}:\$\{accessScope\}:business-team:\$\{businessId\}`\}/,
  );
  assertMatch(businessTeamScreen, /mounted\.current = false/);
  assertMatch(businessTeamScreen, /requestSequence\.current \+= 1/);
  assertMatch(businessTeamScreen, /mutationGeneration\.current \+= 1/);
  assertMatch(businessTeamScreen, /const mutationBusy = useRef\(false\)/);
  assertMatch(businessTeamScreen, /mutationBusy\.current = true/);
  assertMatch(
    businessTeamScreen,
    /const confirmed = await confirmAction\(options\.confirmation\)[\s\S]*?if \(!isCurrent\(\)\) return false/,
  );
  assertMatch(
    businessTeamScreen,
    /const result = await action\(\)[\s\S]*?if \(!isCurrent\(\)\) return false/,
  );
  assertMatch(
    businessTeamScreen,
    /loadBusinessTeam\(businessId, expectedUserId\)/,
  );
  assertMatch(
    businessTeamScreen,
    /loadMyBusinessInvitations\(expectedUserId\)/,
  );
  assertMatch(businessTeamScreen, /inviteRequestKey\.current = null/);
  assertMatch(businessTeamScreen, /transferRequestKeys\.current = \{\}/);

  for (const [actionName, functionName] of [
    ["sendInvitation", "inviteBusinessTeamMember"],
    ["changeRole", "changeBusinessMemberRole"],
    ["removeMember", "revokeBusinessTeamAccess"],
    ["transferOwnership", "transferBusinessOwnership"],
    ["respondToInvitation", "respondToBusinessInvitation"],
    ["cancelBusinessInvitation", "revokeBusinessTeamInvitation"],
  ] as const) {
    assertMatch(
      screenActionBody(actionName),
      new RegExp(`${functionName}\\([\\s\\S]*?expectedUserId\\s*\\)`),
    );
  }
});
