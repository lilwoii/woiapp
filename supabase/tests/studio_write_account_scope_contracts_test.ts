import { assert, assertMatch } from "jsr:@std/assert@1";

const studio = await Deno.readTextFile(
  new URL("../../app/(tabs)/studio.tsx", import.meta.url),
);
const responses = await Deno.readTextFile(
  new URL("../../lib/business-responses.ts", import.meta.url),
);
const marketplace = await Deno.readTextFile(
  new URL("../../lib/marketplace-api.ts", import.meta.url),
);
const store = await Deno.readTextFile(
  new URL("../../context/marketplace-store.tsx", import.meta.url),
);
const schema = await Deno.readTextFile(
  new URL("../schema.sql", import.meta.url),
);
const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20260905000000_studio_write_authority_serialization.sql",
    import.meta.url,
  ),
);

function exportedFunctionBody(source: string, name: string): string {
  const marker = `export async function ${name}(`;
  const start = source.indexOf(marker);
  const end = source.indexOf("\nexport ", start + marker.length);
  assert(start >= 0, `missing exported function ${name}`);
  return source.slice(start, end >= 0 ? end : source.length);
}

function constFunctionBody(source: string, name: string): string {
  const marker = `const ${name} =`;
  const start = source.indexOf(marker);
  assert(start >= 0, `missing source handler ${name}`);
  const open = source.indexOf("{", start + marker.length);
  assert(open >= 0, `missing source handler body ${name}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated source handler ${name}`);
}

function sqlFunctionBody(source: string, name: string): string {
  const start = source.indexOf(`create or replace function ${name}(`);
  const end = source.indexOf("$$;", start);
  assert(start >= 0 && end > start, `missing SQL function ${name}`);
  return source.slice(start, end);
}

function sqlStatement(source: string, marker: string): string {
  const start = source.indexOf(marker);
  const end = source.indexOf(";", start + marker.length);
  assert(start >= 0 && end > start, `missing SQL statement ${marker}`);
  return source.slice(start, end + 1);
}

const studioRpcs = [
  ["submit_business_update", "if not private.is_business_member"],
  ["submit_business_response", "or not private.is_business_member"],
  ["set_business_live_status", "if not private.is_business_member"],
  ["set_menu_item_availability", "or not private.is_business_member"],
] as const;

Deno.test("response queue and response writes stay on their initiating account", () => {
  assertMatch(responses, /createAccountBoundSupabaseClient/);
  assertMatch(
    responses,
    /async function authorizedClient\(businessId: string, expectedUserId: string\)/,
  );
  assertMatch(
    responses,
    /const client = await createAccountBoundSupabaseClient\(expectedUserId\)/,
  );
  assert(!responses.includes("supabase.auth.getUser()"));
  assert(!responses.includes("supabase.auth.mfa"));

  for (const name of ["loadBusinessResponseQueue", "submitBusinessResponse"]) {
    const body = exportedFunctionBody(responses, name);
    assertMatch(body, /expectedUserId: string/);
    assertMatch(body, /authorizedClient\(businessId, expectedUserId\)/);
  }

  const responseQueuePolicy = sqlStatement(
    schema,
    'create policy "members read response queue"',
  );
  assertMatch(responseQueuePolicy, /for select to authenticated/);
  assertMatch(responseQueuePolicy, /private\.has_aal2\(\)/);
  assertMatch(responseQueuePolicy, /private\.is_business_member\(business_id, auth\.uid\(\)\)/);
});

Deno.test("owner update, status, and menu helpers require an account-bound mutation", () => {
  for (const name of ["submitOwnerUpdate", "updateVenueStatus"]) {
    const body = exportedFunctionBody(marketplace, name);
    assertMatch(body, /expectedUserId: string/);
    assertMatch(body, /authenticatedUserId\(expectedUserId\)/);
    assertMatch(body, /marketplaceMutationClient\(expectedUserId\)/);
  }

  const menu = exportedFunctionBody(marketplace, "setMenuItemAvailability");
  assertMatch(menu, /expectedUserId: string/);
  assertMatch(menu, /authenticatedUserId\(expectedUserId\)/);
  assertMatch(menu, /marketplaceMutationClient\(expectedUserId\)/);
  assertMatch(menu, /client\.rpc\('set_menu_item_availability'/);

  const publishStore = constFunctionBody(store, "publishUpdate");
  assertMatch(publishStore, /submitOwnerUpdate\([\s\S]*?expectedUserId/);
  assertMatch(publishStore, /requestGuard\.isCurrent\(token\)/);
  const statusStore = constFunctionBody(store, "setVenueStatus");
  assertMatch(statusStore, /updateVenueStatus\([\s\S]*?expectedUserId/);
  assertMatch(statusStore, /requestGuard\.isCurrent\(token\)/);
});

Deno.test("Studio scopes private state and serializes every remaining write lane", () => {
  assertMatch(studio, /const studioWriteScope =/);
  assertMatch(studio, /const studioWriteSession = useMemo<StudioWriteSession \| null>/);
  assertMatch(studio, /const studioWriteSessionRef = useRef<StudioWriteSession \| null>/);
  assertMatch(studio, /const studioWriteBusy = useRef\(new Set<string>\(\)\)/);
  assertMatch(studio, /studioWriteSessionRef\.current === token\.session/);
  assertMatch(studio, /responseQueue\.session === studioWriteSession/);
  assertMatch(studio, /publishingSession === studioWriteSession/);
  assert(!studio.includes("studioWriteEpoch"));
  assertMatch(studio, /const draftKey = `\$\{studioWriteScope\}:\$\{review\.id\}`/);
  assertMatch(
    studio,
    /loadBusinessResponseQueue\(businessId, accountId\)/,
  );

  const beginWrite = constFunctionBody(studio, "beginStudioWrite");
  assertMatch(beginWrite, /const busyKey = `\$\{studioWriteScope\}:\$\{lane\}`/);
  assertMatch(beginWrite, /studioWriteBusy\.current\.add\(busyKey\)/);
  const finishWrite = constFunctionBody(studio, "finishStudioWrite");
  assert(
    finishWrite.indexOf("studioWriteBusy.current.delete(token.busyKey)") <
      finishWrite.indexOf("isCurrentStudioWrite(token)"),
    "every scoped lane must be released even after its UI token becomes stale",
  );
  assert(!studio.includes("studioWriteBusy.current.clear()"));

  assertMatch(studio, /ownerUpdateAttempts = useRef\(new Map<string, string>\(\)\)/);
  assert(!studio.includes("ownerUpdateAttempts.current.clear()"));
  const publish = constFunctionBody(studio, "publish");
  assertMatch(publish, /const fingerprint = `\$\{token\.scope\}/);
  assertMatch(publish, /ownerUpdateAttempts\.current\.get\(fingerprint\)/);
  assert(
    publish.indexOf("finishStudioWrite(token)") <
      publish.indexOf("ownerUpdateAttempts.current.delete(fingerprint)"),
    "a stale owner-update result must retain its scoped idempotency key",
  );

  for (const [handler, call] of [
    ["publish", "publishUpdate"],
    ["submitReviewResponse", "submitBusinessResponse"],
    ["toggleSoldOut", "setMenuItemAvailability"],
  ] as const) {
    const body = constFunctionBody(studio, handler);
    assertMatch(body, /beginStudioWrite\(/);
    assertMatch(body, new RegExp(`${call}\\(`));
    assertMatch(body, /finishStudioWrite\(token\)/);
  }

  const changeStatus = constFunctionBody(studio, "changeStatus");
  assertMatch(changeStatus, /beginStudioWrite\('venue-status'\)/);
  assertMatch(changeStatus, /await confirmAction\(/);
  assertMatch(changeStatus, /isCurrentStudioWrite\(token\)/);
  assertMatch(changeStatus, /finishStudioWrite\(token\)/);
  assert(
    changeStatus.indexOf("beginStudioWrite('venue-status')") <
      changeStatus.indexOf("await confirmAction("),
    "venue-status scope and lane must be captured before confirmation",
  );
  const applyStatus = constFunctionBody(studio, "applyStatus");
  assertMatch(applyStatus, /setVenueStatus\(token\.businessId, status\)/);
  assertMatch(applyStatus, /finishStudioWrite\(token\)/);

  assertMatch(
    constFunctionBody(studio, "submitReviewResponse"),
    /submitBusinessResponse\([\s\S]*?token\.accountId/,
  );
  assertMatch(
    constFunctionBody(studio, "toggleSoldOut"),
    /setMenuItemAvailability\([\s\S]*?token\.accountId/,
  );
});

Deno.test("Studio RPC authority is serialized in baseline and upgrade paths", () => {
  for (const [rpc, authorityMarker] of studioRpcs) {
    const baseline = sqlFunctionBody(schema, `public.${rpc}`);
    assertMatch(baseline, /private\.require_aal2\(\)/);
    const lock = baseline.match(
      /from public\.businesses [a-z]+[\s\S]*?for update/,
    );
    assert(lock, `${rpc} must lock its business`);
    assert(
      baseline.indexOf(lock[0]) < baseline.indexOf(authorityMarker),
      `${rpc} must lock before authority evaluation`,
    );

    const wrapper = sqlFunctionBody(migration, `public.${rpc}`);
    assertMatch(wrapper, /private\.require_aal2\(\)/);
    assertMatch(
      wrapper,
      /from public\.businesses business[\s\S]*?for update/,
    );
    assert(
      wrapper.indexOf("for update") <
        wrapper.indexOf(`private.${rpc}_core(`),
      `${rpc} wrapper must lock before delegating`,
    );
    assertMatch(
      sqlStatement(
        migration,
        `revoke all on function private.${rpc}_core(`,
      ),
      /from public, anon, authenticated, service_role;/,
    );
    assertMatch(
      sqlStatement(migration, `grant execute on function public.${rpc}(`),
      /to authenticated;/,
    );
  }

  for (const source of [schema, migration]) {
    assertMatch(
      sqlFunctionBody(source, "public.submit_business_response"),
      /from public\.reviews [a-z]+[\s\S]*?for update/,
    );
    assertMatch(
      sqlFunctionBody(source, "public.set_menu_item_availability"),
      /from public\.menu_items [a-z]+[\s\S]*?for update of [a-z]+/,
    );
  }

  for (const rpc of ["submit_business_update", "submit_business_response"]) {
    const body = sqlFunctionBody(schema, `public.${rpc}`);
    assertMatch(body, /private\.lock_idempotency_request/);
    assertMatch(body, /private\.action_idempotency_receipts/);
  }
});
