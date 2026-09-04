import { assert, assertMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20261006000000_public_link_safety.sql",
    import.meta.url,
  ),
);
const links = await Deno.readTextFile(
  new URL("../../lib/links.ts", import.meta.url),
);
const businessProfile = await Deno.readTextFile(
  new URL("../../lib/business-profile.ts", import.meta.url),
);
const marketplaceApi = await Deno.readTextFile(
  new URL("../../lib/marketplace-api.ts", import.meta.url),
);
const socialProfile = await Deno.readTextFile(
  new URL("../../lib/social-profile.ts", import.meta.url),
);
const profileScreen = await Deno.readTextFile(
  new URL("../../app/profile/[id].tsx", import.meta.url),
);
const placeScreen = await Deno.readTextFile(
  new URL("../../app/place/[id].tsx", import.meta.url),
);
const providerIngestMigration = await Deno.readTextFile(
  new URL(
    "../migrations/20260804000000_provider_ingest_rpc.sql",
    import.meta.url,
  ),
);

Deno.test("public URL policy rejects credentials, ports, IP literals, and reserved hosts", () => {
  assertMatch(links, /export function safePublicHttpsUrl/);
  assertMatch(links, /authority\.includes\(':'\)/);
  assertMatch(links, /\^\[a-z0-9\.\-\]\+\$/);
  assertMatch(links, /url\.username/);
  assertMatch(links, /url\.password/);
  assertMatch(links, /\^\[0-9\.\]\+\$/);
  assertMatch(
    migration,
    /0x\[0-9a-f\]\+\|0\[0-7\]\*\|\[0-9\]\+/,
  );
  for (
    const suffix of [
      "local",
      "localhost",
      "internal",
      "test",
      "example",
      "invalid",
    ]
  ) {
    assert(links.includes(`'${suffix}'`));
    assert(migration.includes(`'${suffix}'`));
  }
});

Deno.test("profile and business clients share the public URL policy before storage or opening", () => {
  assertMatch(businessProfile, /safePublicHttpsUrl\(websiteInput\)/);
  assertMatch(marketplaceApi, /safePublicHttpsUrl\(stringValue\(row\.url\)\)/);
  assertMatch(socialProfile, /safePublicHttpsUrl\(link\.url\)/);
  assertMatch(profileScreen, /safePublicHttpsUrl\(value\)/);
  assertMatch(profileScreen, /await Linking\.openURL\(url\)/);
  assertMatch(placeScreen, /safePublicHttpsUrl\(place\.websiteUrl\)/);
});

Deno.test("database constraints and projections enforce public URL safety", () => {
  assertMatch(
    migration,
    /create or replace function private\.public_https_url_is_safe/,
  );
  assertMatch(migration, /authority ~ '\[@:\]'/);
  assertMatch(migration, /position\('\.' in host_name\) = 0/);
  assertMatch(migration, /host_name ~ '\^\[0-9\.\]\+\$'/);
  assertMatch(migration, /profiles_public_links_safe/);
  assertMatch(migration, /business_private_website_https/);
  assertMatch(
    migration,
    /where details\.show_website_public\s+and \(\s+details\.website_url is null\s+or not private\.public_https_url_is_safe/,
  );
  assertMatch(
    migration,
    /not show_website_public\s+or private\.public_https_url_is_safe\(website_url, 2048\)/,
  );
  assertMatch(migration, /business_revision_public_links_guard/);
  assertMatch(
    migration,
    /private\.public_https_url_is_safe\(details\.website_url, 2048\)/,
  );
  assertMatch(
    migration,
    /private\.validate_public_profile_links\(profile\.links\)/,
  );
  assertMatch(
    migration,
    /revoke all on function private\.public_https_url_is_safe\(text, integer\)[\s\S]*from public, anon, authenticated, service_role/,
  );
});

Deno.test("provider websites remain private until they satisfy public-link policy", () => {
  assertMatch(
    providerIngestMigration,
    /set website_url = nullif\(record_value->>'websiteUrl', ''\),\s+show_website_public = false/,
  );
  assertMatch(
    migration,
    /not show_website_public\s+or private\.public_https_url_is_safe\(website_url, 2048\)/,
  );
  assertMatch(
    migration,
    /when details\.show_website_public\s+and private\.public_https_url_is_safe/,
  );
});
