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
const navigationScreen = readFileSync(resolve(__dirname, '../../app/navigation/[id].tsx'), 'utf8');
const navigationLibrary = readFileSync(resolve(__dirname, '../../lib/navigation.ts'), 'utf8');

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
    expect(nativeMap).toMatch(/showsTraffic=\{navigationMode === 'drive'\}/);
    expect(discover).toMatch(/setMapFocusKey\(`area:/);
  });

  it('uses the short-arc camera region for web bounds and clears stale selection', () => {
    expect(webMap).toMatch(/boundsForMapCoordinates\(places/);
    expect(webMap).toMatch(/boundsForMapCoordinates\(routeCoordinates/);
    expect(webMap).not.toMatch(/routeCoordinates\.forEach\(.+bounds\.extend/s);
    expect(discover.match(/setSelectedId\(undefined\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(discover).toMatch(/selectedId=\{explicitSelection\?\.id\}/);
  });

  it('keeps the map available in empty and disconnected areas without inventing a nearby city', () => {
    expect(discover).toMatch(/clientHydrated && focused && pathname === '\/' \? \([\s\S]*<View style=\{\[styles\.workspace, wide && styles\.workspaceWide\]\}>/);
    expect(discover).not.toMatch(/ranked\.length \|\| visibleMapInventory\.length \|\| mapMarkersSuppressed \? \(/);
    expect(discover).toMatch(/The map is ready when listings reconnect/);
    expect(webMap).toMatch(/const fallbackCenter: \[number, number\] = \[0, 20\]/);
    expect(webMap).toMatch(/zoom: first \? 11\.5 : 2\.35/);
    expect(nativeMap).toMatch(/latitude: 20,[\s\S]*longitude: 0,[\s\S]*latitudeDelta: 100,[\s\S]*longitudeDelta: 160/);
  });

  it('invalidates stale searches and refuses oversized live-inventory viewports', () => {
    expect(discover).toMatch(/locationRequestGeneration\.current \+= 1;[\s\S]*mapInventoryRequest\.current\.invalidate\(\)/);
    expect(discover).toMatch(/if \(!viewportIsLiveInventoryEligible\(viewport\.bounds\)\)/);
    expect(webMap).toMatch(/setPendingViewport\(eligible && onSearchAreaRef\.current \? viewport : null\)/);
    expect(nativeMap).toMatch(/setPendingViewport\(eligible && onSearchArea \? viewport : null\)/);
  });

  it('makes web markers keyboard reachable and offers 3D only when the loaded style supports it', () => {
    expect(webMap.match(/element\.tabIndex = 0/g)?.length).toBe(2);
    expect(webMap).toMatch(/\{supports3D \? \(/);
    expect(webMap).not.toMatch(/Use tilted map perspective/);
  });

  it('drops routes for moved destinations and aborts timed-out provider work', () => {
    expect(navigationScreen).toMatch(/destinationKey\(destinationRef\.current\) !== requestedDestinationKey/);
    expect(navigationScreen).toMatch(/const visibleRoute = routeMatchesDestination \? route : null/);
    expect(navigationLibrary).toMatch(/signal: controller\.signal/);
    expect(navigationLibrary).toMatch(/finally \{[\s\S]*clearTimeout\(timeout\)/);
  });
});
