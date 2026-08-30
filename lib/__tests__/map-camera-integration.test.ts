type NodeFs = { readFileSync: (path: string, encoding: 'utf8') => string };
type NodePath = { resolve: (...parts: string[]) => string };
declare function require(name: 'fs'): NodeFs;
declare function require(name: 'path'): NodePath;
declare const __dirname: string;

const { readFileSync } = require('fs');
const { resolve } = require('path');
const discover = readFileSync(resolve(__dirname, '../../app/(tabs)/index.tsx'), 'utf8');
const nativeMap = readFileSync(resolve(__dirname, '../../components/live-map.native.tsx'), 'utf8');
const webMap = readFileSync(resolve(__dirname, '../../components/maplibre-map.web.tsx'), 'utf8');

describe('global map camera integration', () => {
  it('re-centers an untouched native map after delayed non-LA location resolution', () => {
    expect(nativeMap).toMatch(/hasCenteredOnUser\.current \|\| mapWasInteracted\.current/);
    expect(nativeMap).toMatch(/center: userCoordinates, zoom: 13/);
    expect(discover).toMatch(/setMapFocusKey\(`near:/);
  });

  it('starts native maps from actual results and fits deliberate area searches', () => {
    expect(nativeMap).toMatch(/userCoordinates \? \[userCoordinates\] : places/);
    expect(nativeMap).toMatch(/searchAreaKey === fittedSearchAreaKey\.current/);
    expect(nativeMap).toMatch(/regionForMapCoordinates\(routeCoordinates/);
    expect(discover).toMatch(/setMapFocusKey\(`area:/);
  });

  it('uses the short-arc camera region for web bounds and clears stale selection', () => {
    expect(webMap).toMatch(/boundsForMapCoordinates\(places/);
    expect(webMap).toMatch(/boundsForMapCoordinates\(routeCoordinates/);
    expect(webMap).not.toMatch(/routeCoordinates\.forEach\(.+bounds\.extend/s);
    expect(discover.match(/setSelectedId\(undefined\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(discover).toMatch(/selectedId=\{explicitSelection\?\.id\}/);
  });
});
