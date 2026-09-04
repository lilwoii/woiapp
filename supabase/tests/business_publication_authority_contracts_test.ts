import { assertMatch } from "jsr:@std/assert@1";

const schema = await Deno.readTextFile(new URL("../schema.sql", import.meta.url));
const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20260828000000_business_publication_authority_guard.sql",
    import.meta.url,
  ),
);

Deno.test("publication authority is enforced in baseline and upgrade SQL", () => {
  for (const source of [schema, migration]) {
    assertMatch(source, /new\.state = 'published'[\s\S]*old\.state <> 'published'/);
    assertMatch(source, /new\.provenance in \('owner', 'community'\)/);
    assertMatch(source, /old\.state not in \('pending', 'suspended'\)/);
    assertMatch(source, /new\.verification <> 'verified'/);
    assertMatch(source, /BUSINESS_REVIEW_REQUIRED/);
    assertMatch(source, /new\.provenance = 'licensed_provider'/);
    assertMatch(source, /private\.provider_business_sources/);
    assertMatch(source, /source\.source_status = 'active'/);
    assertMatch(source, /current_date between account\.license_effective_on/);
    assertMatch(source, /LICENSED_SOURCE_NOT_ACTIVE/);
  }
});
