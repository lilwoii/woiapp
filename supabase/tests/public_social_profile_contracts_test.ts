import { assert, assertMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(new URL(
  "../migrations/20260907000000_public_social_profiles.sql",
  import.meta.url,
));
const api = await Deno.readTextFile(new URL("../../lib/marketplace-api.ts", import.meta.url));
const editorApi = await Deno.readTextFile(new URL("../../lib/social-profile.ts", import.meta.url));
const place = await Deno.readTextFile(new URL("../../app/place/[id].tsx", import.meta.url));
const profile = await Deno.readTextFile(new URL("../../app/profile/[id].tsx", import.meta.url));
const editor = await Deno.readTextFile(new URL("../../app/profile-edit.tsx", import.meta.url));
const mediaStage = await Deno.readTextFile(new URL("../functions/media-stage/index.ts", import.meta.url));

function sqlFunction(name: string) {
  const start = migration.indexOf(`create or replace function ${name}(`);
  const end = migration.indexOf("$$;", start);
  assert(start >= 0 && end > start, `missing SQL function ${name}`);
  return migration.slice(start, end);
}

function sqlView(name: string, nextMarker: string) {
  const start = migration.indexOf(`create or replace view ${name}`);
  const end = migration.indexOf(nextMarker, start + 1);
  assert(start >= 0 && end > start, `missing SQL view ${name}`);
  return migration.slice(start, end);
}

Deno.test("public social projections use opaque identifiers and honor blocks", () => {
  const directory = sqlView("public.public_profile_directory", "create or replace view public.public_profile_following");
  assertMatch(directory, /p\.public_id/);
  assert(!directory.includes("p.user_id as"));
  assert(!directory.includes("email"));
  assert(!directory.includes("evidence_snapshot"));
  assertMatch(directory, /private\.users_are_blocked\(auth\.uid\(\), p\.user_id\)/);
  assertMatch(directory, /case when p\.show_following/);
  assertMatch(directory, /case when p\.show_favorites/);
});

Deno.test("profile follows reject self, blocked, inactive, and unbounded writes", () => {
  const follow = sqlFunction("public.set_profile_follow_by_public_id");
  assertMatch(follow, /p\.status = 'active'/);
  assertMatch(follow, /target_user_id = actor/);
  assertMatch(follow, /private\.users_are_blocked\(actor, target_user_id\)/);
  assertMatch(follow, /private\.consume_rate_limit\(actor, 'profile_follow', 120, 3600\)/);
  assertMatch(follow, /on conflict \(follower_id, followed_id\) do nothing/);
  assertMatch(migration, /constraint profile_follows_not_self check \(follower_id <> followed_id\)/);
  assertMatch(migration, /revoke insert, update, delete on table public\.profile_follows from anon, authenticated, service_role/);
  assertMatch(api, /createAccountBoundSupabaseClient\(expectedUserId\)/);
  assertMatch(api, /set_profile_follow_by_public_id/);
});

Deno.test("profile banners require earned access and approved wide media", () => {
  const update = sqlFunction("public.update_own_social_profile");
  assertMatch(update, /approved_review_count < 10/);
  assertMatch(update, /ma\.owner_id = actor/);
  assertMatch(update, /ma\.quarantine_state = 'clean'/);
  assertMatch(update, /ma\.moderation = 'approved'/);
  assertMatch(update, /ma\.width between 900 and 6000/);
  assertMatch(update, /between 1\.8 and 5\.0/);
  assertMatch(update, /private\.require_aal2\(\)/);
  assertMatch(mediaStage, /\| "profile_banner"/);
  assertMatch(mediaStage, /selectedPurpose !== "profile_avatar" && selectedPurpose !== "profile_banner"/);
  assertMatch(editorApi, /stageMediaUpload\(media, 'profile_banner', undefined, undefined, client\)/);
});

Deno.test("profile copy and links are moderated with bounded public controls", () => {
  const update = sqlFunction("public.update_own_social_profile");
  assertMatch(update, /char_length\(next_bio\) > 240/);
  assertMatch(update, /private\.content_is_professional\(next_bio\)/);
  assertMatch(update, /private\.validate_public_profile_links\(next_links\)/);
  assertMatch(migration, /jsonb_array_length\(candidate\) <= 3/);
  assertMatch(migration, /\^https:\/\//);
  assertMatch(editor, /maxLength=\{240\}/);
  assertMatch(editor, /links\.length < 3/);
});

Deno.test("review authors open public histories with inspectable badges", () => {
  assertMatch(place, /pathname: '\/profile\/\[id\]'/);
  assertMatch(profile, /fetchPublicProfile\(id\)/);
  assertMatch(profile, /<TrustBadgeStrip badges=\{profile\.badges\}/);
  assertMatch(profile, /Reviews by \{profile\.displayName\}/);
  assertMatch(profile, /targetType: 'user'/);
});
