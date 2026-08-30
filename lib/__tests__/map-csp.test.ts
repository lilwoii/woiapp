import { mapStyleOriginIsAllowed, parseMapCspOrigins } from '../map-csp';

describe('web map CSP origins', () => {
  it('normalizes and deduplicates exact public HTTPS origins', () => {
    expect(
      parseMapCspOrigins(
        'https://tiles.spottr.app/, https://glyphs.spottr.app, https://tiles.spottr.app',
      ),
    ).toEqual([
      'https://tiles.spottr.app',
      'https://glyphs.spottr.app',
    ]);
  });

  it.each([
    undefined,
    '',
    'http://tiles.spottr.app',
    'https://user:secret@tiles.spottr.app',
    'https://tiles.spottr.app/style.json',
    'https://tiles.spottr.app?token=public',
    'https://tiles.spottr.app#fragment',
    'https://tiles.spottr.app:8443',
    'https://*.spottr.app',
    'https://localhost',
    'https://localhost.',
    'https://tiles.local.',
    'https://127.0.0.1',
    'https://00000000-0000-0000-0000-000000000000.spottr.app',
    'https://tiles.example.com',
    'https://tiles.spottr.app,not-a-url',
    'https://tiles.spottr.app,',
  ])('rejects malformed or non-public origin lists: %s', (value) => {
    expect(parseMapCspOrigins(value)).toBeNull();
  });

  it('requires the style document origin to be explicitly allowlisted', () => {
    const origins = parseMapCspOrigins(
      'https://tiles.spottr.app,https://glyphs.spottr.app',
    );
    expect(
      mapStyleOriginIsAllowed('https://tiles.spottr.app/style.json', origins),
    ).toBe(true);
    expect(
      mapStyleOriginIsAllowed('https://other.spottr.app/style.json', origins),
    ).toBe(false);
  });
});
