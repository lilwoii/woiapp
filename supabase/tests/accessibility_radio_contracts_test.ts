import { assert, assertEquals } from "jsr:@std/assert@1";

const workspace = new URL("../../", import.meta.url);

async function tsxFiles(directory: URL): Promise<URL[]> {
  const files: URL[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const child = new URL(
      entry.name + (entry.isDirectory ? "/" : ""),
      directory,
    );
    if (entry.isDirectory) files.push(...await tsxFiles(child));
    else if (entry.isFile && entry.name.endsWith(".tsx")) files.push(child);
  }
  return files;
}

function radioOpeningTags(source: string): string[] {
  const openings: string[] = [];
  let cursor = 0;
  while (true) {
    const role = source.indexOf('accessibilityRole="radio"', cursor);
    if (role === -1) return openings;
    const start = source.lastIndexOf("<Pressable", role);
    const end = source.indexOf(">", role);
    assert(
      start !== -1 && end !== -1,
      "Radio must be declared on a Pressable opening tag",
    );
    openings.push(source.slice(start, end + 1));
    cursor = role + 1;
  }
}

function assertLabeledRadioGroup(source: string, labelSource: string): void {
  const label = source.indexOf(labelSource);
  assert(label !== -1, `Missing radio-group label source: ${labelSource}`);
  const viewStart = source.lastIndexOf("<View", label);
  const scrollStart = source.lastIndexOf("<ScrollView", label);
  const start = Math.max(viewStart, scrollStart);
  const end = source.indexOf(">", label);
  assert(
    start !== -1 && end !== -1,
    `Missing radio-group container for: ${labelSource}`,
  );
  assert(
    source.slice(start, end + 1).includes('accessibilityRole="radiogroup"'),
    `Radio-group label is not attached to a radiogroup: ${labelSource}`,
  );
}

Deno.test("every custom radio exposes its checked state on web", async () => {
  const files = [
    ...await tsxFiles(new URL("app/", workspace)),
    ...await tsxFiles(new URL("components/", workspace)),
  ];
  let radioCount = 0;
  for (const file of files) {
    const source = await Deno.readTextFile(file);
    for (const opening of radioOpeningTags(source)) {
      radioCount += 1;
      assert(
        opening.includes("aria-checked="),
        `Custom radio is missing explicit aria-checked in ${file.pathname}`,
      );
    }
  }
  assertEquals(radioCount, 32);
});

Deno.test("radio choices added outside native inputs keep labeled group context", async () => {
  const expectations = new Map<string, string[]>([
    ["app/auth.tsx", ['accessibilityLabel="Account type"']],
    ["app/(tabs)/index.tsx", [
      'accessibilityLabel="Cuisine filter"',
      'accessibilityLabel="Distance filter"',
      'accessibilityLabel="Rating filter"',
    ]],
    ["components/business-onboarding-screen.tsx", [
      'accessibilityLabel="Listing setup mode"',
      'accessibilityLabel="Listing to claim"',
      'accessibilityLabel="Claim verification method"',
    ]],
    ["app/(tabs)/saved.tsx", ['accessibilityLabel="Saved place category"']],
    ["app/(tabs)/studio.tsx", [
      'accessibilityLabel="Choose a managed business"',
      'accessibilityLabel="Owner update type"',
    ]],
    ["app/business-profile.tsx", ['accessibilityLabel="Business price level"']],
    ["app/business-setup.tsx", [
      "accessibilityLabel={`Availability for ${item.name",
    ]],
    ["app/messages/[id].tsx", ['accessibilityLabel="Pickup location options"']],
    ["app/order/[id].tsx", ['accessibilityLabel="Pickup window"']],
    ["app/pickup/[id].tsx", [
      'accessibilityLabel="Pickup location"',
      'accessibilityLabel="Pickup time"',
      'accessibilityLabel="Payment method"',
    ]],
  ]);

  for (const [relativePath, labels] of expectations) {
    const source = await Deno.readTextFile(new URL(relativePath, workspace));
    for (const label of labels) assertLabeledRadioGroup(source, label);
  }
});
