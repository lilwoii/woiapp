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
const marketplaceApi = readFileSync(resolve(__dirname, '../../lib/marketplace-api.ts'), 'utf8');
const placeDetail = readFileSync(resolve(__dirname, '../../app/place/[id].tsx'), 'utf8');
const orderScreen = readFileSync(resolve(__dirname, '../../app/order/[id].tsx'), 'utf8');

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
    expect(webMap).toMatch(/zoom: restoredCamera\?\.zoom \?\? \(first \? 11\.5 : 2\.35\)/);
    expect(nativeMap).toMatch(/latitude: 20,[\s\S]*longitude: 0,[\s\S]*latitudeDelta: 100,[\s\S]*longitudeDelta: 160/);
  });

  it('invalidates stale searches and refuses oversized live-inventory viewports', () => {
    expect(discover).toMatch(/locationRequestGeneration\.current \+= 1;[\s\S]*mapInventoryRequest\.current\.invalidate\(\)/);
    expect(discover).toMatch(/if \(!viewportIsLiveInventoryEligible\(viewport\.bounds\)\)/);
    expect(webMap).toMatch(/setPendingViewport\(eligible && onSearchAreaRef\.current \? viewport : null\)/);
    expect(nativeMap).toMatch(/setPendingViewport\(eligible && onSearchArea \? viewport : null\)/);
    expect(nativeMap).toMatch(
      /onRegionChangeComplete[\s\S]*const eligible = viewportIsLiveInventoryEligible[\s\S]*const changedByGesture = userMovedMap\.current \|\| details\?\.isGesture === true[\s\S]*setInventoryViewportEligible\(eligible\)[\s\S]*if \(!eligible\)[\s\S]*if \(changedByGesture\)/,
    );
  });

  it('never sends a precise nearby request after Discover blurs or backgrounds', () => {
    expect(discover).toMatch(
      /const isCurrent = \(\) =>[\s\S]*focusedRef\.current &&[\s\S]*appForegroundRef\.current &&[\s\S]*locationRequestGeneration\.current === generation/,
    );
    expect(discover).toMatch(
      /requestForegroundPermissionsAsync\(\)[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*getCurrentPositionAsync\([\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*const searchResult = await refresh/,
    );
    expect(discover).toMatch(
      /setSortMode\('nearby'\);[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*loadMapInventory\(viewportAroundPoint/,
    );
    expect(discover).toMatch(
      /useFocusEffect\(useCallback\(\(\) => \{[\s\S]*focusedRef\.current = true;[\s\S]*focusedRef\.current = false;[\s\S]*locationRequestGeneration\.current \+= 1;[\s\S]*setLocating\(false\)/,
    );
    expect(discover).toMatch(
      /AppState\.addEventListener\('change'[\s\S]*appForegroundRef\.current = active;[\s\S]*if \(active\) return;[\s\S]*locationRequestGeneration\.current \+= 1;[\s\S]*setLocating\(false\)/,
    );
    expect(discover).toMatch(
      /if \(!isSupabaseConfigured \|\| !focused \|\| !appForeground\)[\s\S]*Location\.getForegroundPermissionsAsync\(\)/,
    );
    expect(discover.match(/!focusedRef\.current \|\| !appForegroundRef\.current/g)?.length)
      .toBeGreaterThanOrEqual(2);
  });

  it('never silently re-shares location after resume or a manual area choice', () => {
    expect(discover).toMatch(
      /if \(automaticNearbyAttempted\.current\) return;[\s\S]*automaticNearbyAttempted\.current = true;[\s\S]*Location\.getForegroundPermissionsAsync\(\)/,
    );
    expect(discover).toMatch(
      /const applyManualArea[\s\S]*automaticNearbyAttempted\.current = true;[\s\S]*searchArea\(clean\)/,
    );
    expect(discover).toMatch(
      /const searchVisibleMap[\s\S]*automaticNearbyAttempted\.current = true;[\s\S]*refresh\(\{/,
    );
    expect(discover).not.toMatch(/automaticNearbyAttempted\.current = false/);
    expect(discover).toMatch(
      /const expireForegroundLocation[\s\S]*setUserCoordinates\(null\)[\s\S]*Last nearby search · refresh location/,
    );
    expect(discover.match(/expireForegroundLocation\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(discover).toMatch(/if \(\(result\.data\?\.areaMatchCount \?\? 0\) === 0\)[\s\S]*map stayed on your previous area/);
  });

  it('clears stale search-area targets after programmatic camera moves without refreshing inventory', () => {
    expect(nativeMap).toMatch(
      /if \(changedByGesture\) \{[\s\S]*onViewportInvalidated\?\.\(viewport\)[\s\S]*\} else \{[\s\S]*setPendingViewport\(null\);[\s\S]*\}\s*userMovedMap\.current = false/,
    );
    expect(nativeMap).toMatch(/onTouchStart=\{\(\) => \{[^}]*mapWasInteracted\.current = true;[^}]*\}\}\s*onTouchMove/);
    expect(nativeMap).not.toMatch(/onTouchStart=\{\(\) => \{[^}]*userMovedMap\.current = true/);
    expect(webMap).toMatch(
      /if \(userMovedMap\.current\) \{[\s\S]*onViewportInvalidatedRef\.current\?\.\(viewport\)[\s\S]*\} else \{[\s\S]*setPendingViewport\(null\);[\s\S]*\}\s*userMovedMap\.current = false/,
    );
  });

  it('makes web markers keyboard reachable and offers 3D only when the loaded style supports it', () => {
    expect(webMap.match(/element\.tabIndex = 0/g)?.length).toBe(2);
    expect(webMap).toMatch(/accessibilityLabel="Interactive map of nearby food"[\s\S]*role="region"/);
    expect(webMap).toMatch(/\{supports3D \? \(/);
    expect(webMap).not.toMatch(/Use tilted map perspective/);
  });

  it('offers explicit native zoom controls for touch, keyboard, and assistive technology users', () => {
    expect(nativeMap).toMatch(/const adjustZoom = \(delta: number\) =>/);
    expect(nativeMap).toMatch(/accessibilityLabel="Map zoom controls"/);
    expect(nativeMap).toMatch(/accessibilityLabel="Zoom in"[\s\S]*onPress=\{\(\) => adjustZoom\(1\)\}/);
    expect(nativeMap).toMatch(/accessibilityLabel="Zoom out"[\s\S]*onPress=\{\(\) => adjustZoom\(-1\)\}/);
  });

  it('keeps map discovery ahead of ads and preserves a selected branch identity', () => {
    expect(discover).toMatch(/const \[locationPanelOpen, setLocationPanelOpen\] = useState\(false\)/);
    expect(discover).toMatch(/selectedLocationId=\{explicitSelection\?\.locationId\}/);
    expect(webMap).toMatch(/inventoryFeature\.locationId === selectedLocationId/);
    expect(nativeMap).toMatch(/feature\.locationId === selectedLocationId/);
    expect(nativeMap).toContain('key={`${mapPlaceIdentity(place.id, place.locationId)}:${place.logoUrl}:${isSelected}`}');
    expect(discover.indexOf('<SponsoredLane')).toBeGreaterThan(discover.indexOf('style={styles.resultsHeader}'));
    expect(discover.indexOf('<SponsoredLane')).toBeLessThan(discover.indexOf('style={styles.resultsList}'));
  });

  it('recovers from a provider-wide web tile failure and keeps navigation recenterable', () => {
    expect(webMap).toMatch(/tileFailureCount >= 12/);
    expect(webMap).toMatch(/Retry map/);
    expect(webMap).toMatch(/retryCamera\.current = \{/);
    expect(webMap).toMatch(/fittedPlacesKey\.current = ''/);
    expect(webMap).toMatch(/fittedRouteKey\.current = ''/);
    expect(webMap).toMatch(/Recenter map on your live position/);
    expect(nativeMap).toMatch(/Recenter map on your live position/);
    expect(nativeMap).toMatch(/Use angled map perspective/);
    expect(nativeMap).toMatch(/if \(!mapReady\.current\) setMapStartupTimedOut\(true\)/);
    expect(nativeMap).toMatch(/onMapReady=\{\(\) => \{[\s\S]*mapReady\.current = true/);
    expect(nativeMap).toMatch(/Retry map/);
  });

  it('preserves an exact public location through detail, navigation, and pickup', () => {
    expect(discover).toMatch(/placeLocationRouteParams\(selected\.id, selected\.locationId\)/);
    expect(placeDetail).toMatch(/ensurePlace\(id, locationId\)/);
    expect(placeDetail).toMatch(
      /placeLocationRouteParams\(place\.id, place\.locationId\)/,
    );
    expect(navigationScreen).toMatch(/ensurePlace\(placeId, locationId\)/);
    expect(orderScreen).toMatch(/ensurePlace\(placeId, locationId\)/);
    expect(orderScreen).toMatch(/window\.locationId === locationId/);
    expect(marketplaceApi).toMatch(/findExactMarketplacePlace\([\s\S]*preferredLocationId/);
  });

  it('reconciles same-id web fallback markers when visible mobility content changes', () => {
    expect(webMap).toMatch(/client-place:\$\{mapPlaceMarkerSignature\(feature\.place\)\}/);
    expect(webMap).toMatch(/if \(existing\?\.signature === signature\)/);
    expect(webMap).toMatch(/existing\.marker\.remove\(\)[\s\S]*markerRefs\.current\.delete\(feature\.id\)/);
    expect(webMap).toMatch(/businessId: feature\.kind === 'place'[\s\S]*signature,/);
  });

  it('zooms reused web clusters from their current marker centroid', () => {
    expect(webMap).toMatch(
      /markerRefs\.current\s*\.get\(inventoryFeature\.id\)\s*\?\.marker\.getLngLat\(\)/,
    );
    expect(webMap).toMatch(
      /markerRefs\.current\s*\.get\(feature\.id\)\s*\?\.marker\.getLngLat\(\)/,
    );
    expect(webMap.match(/center: currentCenter/g)?.length).toBe(2);
  });

  it('keeps moved-destination routes only as refreshable references', () => {
    expect(navigationScreen).toMatch(/destinationKey\(destinationRef\.current\) !== requestedDestinationKey/);
    expect(navigationScreen).toMatch(/const visibleRoute = route;/);
    expect(navigationScreen).toMatch(/Destination changed — refresh route/);
    expect(navigationScreen).toMatch(/This is the original route estimate/);
    expect(navigationScreen).toMatch(/Refresh route/);
    expect(navigationScreen).toMatch(/Original estimate/);
    expect(navigationScreen).toMatch(/A route refresh is already in progress/);
    expect(navigationScreen).toMatch(
      /!navigationOperationActive\.current && selectedMode && shouldRequestAutomaticReroute/,
    );
    expect(navigationScreen).toMatch(
      /const refreshActiveRoute[\s\S]*currentPositionWithTimeout\(\)[\s\S]*refreshRoute\(routeOrigin, mode\)/,
    );
    expect(navigationLibrary).toMatch(/signal: controller\.signal/);
    expect(navigationLibrary).toMatch(/finally \{[\s\S]*clearTimeout\(timeout\)/);
  });

  it('invalidates one-shot location and route work as soon as the app leaves the foreground', () => {
    expect(navigationScreen).toMatch(
      /if \(state !== 'active'\) \{[\s\S]*navigationOperationGeneration\.current \+= 1;[\s\S]*routeRequestSequence\.current \+= 1;[\s\S]*activeRouteRequest\.current = null;/,
    );
    expect(navigationScreen.match(/appStateRef\.current !== 'active'/g)?.length)
      .toBeGreaterThanOrEqual(8);
    expect(navigationScreen).toMatch(
      /const refreshRoute = useCallback[\s\S]*appStateRef\.current !== 'active'[\s\S]*requestRoutePlan/,
    );
    expect(navigationScreen).toMatch(
      /const routed = await refreshRoute\(origin, selectedMode\);[\s\S]*if \(!routed\) return;[\s\S]*modeRef\.current = selectedMode;[\s\S]*trackingWanted\.current = true/,
    );
  });

  it('keeps stale routes as references while suppressing unsafe turn guidance', () => {
    expect(navigationScreen).toMatch(
      /const actionableGuidance = Boolean\([\s\S]*routeMatchesDestination && routeIsFresh && !routeGuidanceNeedsRefresh/,
    );
    expect(navigationScreen).toMatch(
      /const nextStep = actionableGuidance[\s\S]*\? visibleRoute\?\.steps\[routeStepIndex\][\s\S]*: null/,
    );
    expect(navigationScreen).toMatch(/Route expired — refresh for current turns/);
    expect(navigationScreen).toMatch(/Location changed — refresh route guidance/);
    expect(navigationScreen).toMatch(
      /routeCoordinates=\{routeVisible \? visibleRoute\?\.coordinates : \[\]\}/,
    );
    expect(navigationScreen).toMatch(
      /visibleRoute && \([\s\S]*!routeMatchesDestination \|\| !routeIsFresh \|\| routeGuidanceNeedsRefresh/,
    );
  });

  it('allows one bounded recovery after foreground resume and surfaces an unmatched gap', () => {
    expect(navigationScreen).toMatch(
      /else if \(trackingWanted\.current && !watcher\.current\) \{[\s\S]*boundedRecoveryPending\.current = true;[\s\S]*beginWatching/,
    );
    expect(navigationScreen).toMatch(
      /const allowBoundedRecovery = boundedRecoveryPending\.current;[\s\S]*boundedRecoveryPending\.current = false;[\s\S]*\{ allowBoundedRecovery \}/,
    );
    expect(navigationScreen).toMatch(
      /setRouteGuidanceNeedsRefresh\(!nextProgress\.matched\)/,
    );
    expect(navigationLibrary).toMatch(/!recoveryProjection\.ambiguous/);
    expect(navigationLibrary).toMatch(/ROUTE_RECOVERY_MAX_INSPECTED_SEGMENTS/);
  });

  it('offers on-device travel detection, traffic ETA, and explicit external map choices', () => {
    expect(navigationLibrary).toMatch(/export function inferTravelMode/);
    expect(navigationScreen).toMatch(/Auto estimated/);
    expect(navigationScreen).toMatch(
      /actionableGuidance[\s\S]*routeProgress\?\.durationSeconds[\s\S]*formatRouteArrivalTime\([\s\S]*guidanceDurationSeconds/,
    );
    expect(navigationScreen).toMatch(/openExternalMaps\('apple'\)/);
    expect(navigationScreen).toMatch(/openExternalMaps\('google'\)/);
    expect(nativeMap).toMatch(
      /if \(!navigationMode\)[\s\S]*navigationPerspectiveInitialized\.current = false[\s\S]*setPerspective\(true\)[\s\S]*pitch: 48/,
    );
    expect(webMap).toMatch(
      /!map \|\| !ready \|\| !supports3D[\s\S]*setPerspective\(true\)[\s\S]*pitch: 48/,
    );
  });

  it('cancels hidden tracking when a public destination disappears or becomes blocked without unmounting', () => {
    expect(navigationScreen).toMatch(/const cancelTrackingSession = useCallback/);
    expect(navigationScreen).toMatch(
      /const hasTrackableDestination = Boolean\([\s\S]*place\.category !== 'home_kitchen'[\s\S]*!isHomeKitchenBlocked\(place\.category\)/,
    );
    expect(navigationScreen).toMatch(
      /if \(hasTrackableDestination\) return;[\s\S]*watcher\.current !== null[\s\S]*activeRouteRequest\.current !== null[\s\S]*if \(sessionIsActive\) cancelTrackingSession\(\)/,
    );
    expect(navigationScreen).toMatch(
      /const cancelTrackingSession = useCallback\([\s\S]*routeRequestSequence\.current \+= 1[\s\S]*watcher\.current\?\.remove\(\)[\s\S]*setRoute\(null\)[\s\S]*setLocation\(null\)/,
    );
    expect(navigationScreen).toMatch(
      /const stopTracking = \(\) => \{\s*cancelTrackingSession\('Live tracking stopped\.'\);\s*\}/,
    );
  });
});
