export const NON_PRODUCTION_ARTIFACT_MARKERS = Object.freeze([
  'spottr-fixture.supabase.co',
  'spottr-public-fixture-anon-key',
  'Fixture-password-123!',
  'owner@spottr.test',
  'customer@spottr.test',
  'spottr_fixture_role',
  'fixture-refresh-',
]);

export function validateProductionArtifactContent(relativePath, content) {
  const bytes = typeof content === 'string'
    ? Buffer.from(content, 'utf8')
    : Buffer.from(content);
  const contaminated = NON_PRODUCTION_ARTIFACT_MARKERS.some((marker) =>
    bytes.includes(Buffer.from(marker, 'utf8'))
  );
  return contaminated
    ? [`${relativePath}: production output contains synthetic fixture state.`]
    : [];
}
