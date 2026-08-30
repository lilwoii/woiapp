import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import * as Location from 'expo-location';
import { router, useLocalSearchParams } from 'expo-router';
import type { Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { LiveMap } from '@/components/live-map';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { useMarketplaceStore } from '@/context/marketplace-store';
import {
  featureFlags,
  isHomeKitchenBlocked,
  publicListingRouteUnavailableReason,
} from '@/lib/features';
import {
  advanceRouteStepIndex,
  externalDirectionsProviderUrl,
  externalDirectionsUrl,
  formatRouteArrivalTime,
  formatRouteDistance,
  formatRouteDuration,
  inferTravelMode,
  navigationDistanceMeters,
  requestRoutePlan,
  shouldRequestAutomaticReroute,
} from '@/lib/navigation';
import type { ExternalMapProvider } from '@/lib/navigation';
import type { NavigationCoordinate, RoutePlan, TravelMode } from '@/types/navigation';

type TravelModeChoice = TravelMode | 'auto';

const travelModes: { id: TravelModeChoice; label: string; icon: 'location-crosshairs' | 'car-side' | 'person-walking' | 'bicycle' }[] = [
  { id: 'auto', label: 'Auto', icon: 'location-crosshairs' },
  { id: 'drive', label: 'Drive', icon: 'car-side' },
  { id: 'walk', label: 'Walk', icon: 'person-walking' },
  { id: 'bike', label: 'Bike', icon: 'bicycle' },
];
const automaticReroutingPrivacyNotice = 'When on, Spottr may send your updated precise current location to Mapbox after at least 100 m of movement and 90 seconds to refresh the route. Turn it off to stop additional Mapbox route requests while your foreground live marker continues.';
const CURRENT_LOCATION_TIMEOUT_MS = 15_000;

function destinationKey(destination: NavigationCoordinate | null) {
  return destination ? `${destination.latitude}:${destination.longitude}` : '';
}

async function currentPositionWithTimeout() {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let outcome: { kind: 'timeout' } | {
    kind: 'position';
    position: Awaited<ReturnType<typeof Location.getCurrentPositionAsync>>;
  };
  try {
    outcome = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }).then((position) => ({
        kind: 'position' as const,
        position,
      })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: 'timeout' }), CURRENT_LOCATION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (outcome.kind === 'timeout') throw new Error('CURRENT_LOCATION_TIMEOUT');
  return outcome.position;
}

export default function NavigationScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const placeId = Array.isArray(params.id) ? params.id[0] : params.id;
  const { scopeKey } = useMarketplaceStore();
  return <ScopedNavigationScreen key={`${scopeKey}:navigation:${placeId ?? ''}`} placeId={placeId} />;
}

function ScopedNavigationScreen({ placeId }: { placeId?: string }) {
  const auth = useAuth();
  const { ensurePlace, places } = useMarketplaceStore();
  const loadedPlace = places.find((entry) => entry.id === placeId);
  const placeBlockedReason = publicListingRouteUnavailableReason(loadedPlace);
  const placeBlocked = Boolean(placeBlockedReason);
  const place = placeBlocked ? undefined : loadedPlace;
  const [placeRequestPending, setPlaceRequestPending] = useState(Boolean(placeId && !place && !placeBlocked));
  const [route, setRoute] = useState<RoutePlan | null>(null);
  const [routeClock, setRouteClock] = useState(() => Date.now());
  const [routedDestinationKey, setRoutedDestinationKey] = useState<string | null>(null);
  const [routeVisible, setRouteVisible] = useState(true);
  const [routeStepIndex, setRouteStepIndex] = useState(0);
  const [mode, setMode] = useState<TravelMode | null>(null);
  const [modeChoice, setModeChoice] = useState<TravelModeChoice | null>(null);
  const [location, setLocation] = useState<NavigationCoordinate | null>(null);
  const [automaticRerouting, setAutomaticRerouting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingMode, setPendingMode] = useState<TravelModeChoice | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const watcher = useRef<Location.LocationSubscription | null>(null);
  const routeRef = useRef<RoutePlan | null>(null);
  const routeDestinationKey = useRef<string | null>(null);
  const destinationRef = useRef<NavigationCoordinate | null>(null);
  const trackingWanted = useRef(false);
  const modeRef = useRef<TravelMode | null>(null);
  const routeRequestOrigin = useRef<NavigationCoordinate | null>(null);
  const lastRouteRequestAt = useRef(0);
  const routeRequestSequence = useRef(0);
  const activeRouteRequest = useRef<number | null>(null);
  const automaticReroutingRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);
  const watcherGeneration = useRef(0);
  const navigationOperationGeneration = useRef(0);
  const mounted = useRef(true);

  const cancelTrackingSession = useCallback((nextMessage?: string) => {
    trackingWanted.current = false;
    watcherGeneration.current += 1;
    navigationOperationGeneration.current += 1;
    routeRequestSequence.current += 1;
    activeRouteRequest.current = null;
    watcher.current?.remove();
    watcher.current = null;
    modeRef.current = null;
    routeRef.current = null;
    routeDestinationKey.current = null;
    routeRequestOrigin.current = null;
    lastRouteRequestAt.current = 0;
    automaticReroutingRef.current = false;
    setMode(null);
    setModeChoice(null);
    setRoutedDestinationKey(null);
    setRoute(null);
    setRouteVisible(true);
    setRouteStepIndex(0);
    setLocation(null);
    setAutomaticRerouting(false);
    setBusy(false);
    setPendingMode(null);
    if (nextMessage !== undefined) setMessage(nextMessage);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      trackingWanted.current = false;
      watcherGeneration.current += 1;
      navigationOperationGeneration.current += 1;
      routeRequestSequence.current += 1;
      activeRouteRequest.current = null;
      watcher.current?.remove();
      watcher.current = null;
    };
  }, []);

  useEffect(() => {
    if (!placeId || place || placeBlocked) return;
    let active = true;
    void ensurePlace(placeId).then((result) => {
      if (!active) return;
      setPlaceRequestPending(false);
      if (!result.ok) setMessage(result.reason);
    });
    return () => { active = false; };
  }, [ensurePlace, place, placeBlocked, placeId]);

  const destination = useMemo(() => place ? {
    latitude: place.latitude,
    longitude: place.longitude,
  } : null, [place]);
  const currentDestinationKey = destinationKey(destination);
  const routeMatchesDestination = !route || routedDestinationKey === currentDestinationKey;
  const routeIsFresh = !route || Date.parse(route.expiresAt) > routeClock;
  const visibleRoute = routeMatchesDestination && routeIsFresh ? route : null;
  const hasTrackableDestination = Boolean(
    place &&
    destination &&
    place.category !== 'home_kitchen' &&
    !isHomeKitchenBlocked(place.category)
  );

  useEffect(() => {
    if (hasTrackableDestination) return;
    const sessionIsActive =
      trackingWanted.current ||
      watcher.current !== null ||
      activeRouteRequest.current !== null ||
      modeRef.current !== null ||
      routeRef.current !== null ||
      busy;
    if (sessionIsActive) cancelTrackingSession();
  }, [busy, cancelTrackingSession, hasTrackableDestination]);

  useEffect(() => {
    if (!route) return;
    const remaining = Math.max(0, Date.parse(route.expiresAt) - Date.now());
    const timer = setTimeout(() => setRouteClock(Date.now()), remaining + 50);
    return () => clearTimeout(timer);
  }, [route]);

  useEffect(() => {
    destinationRef.current = destination;
  }, [destination]);

  const refreshRoute = useCallback(async (origin: NavigationCoordinate, selectedMode: TravelMode) => {
    const requestedDestination = destinationRef.current;
    if (!mounted.current || !requestedDestination || activeRouteRequest.current !== null) return false;
    const requestedDestinationKey = destinationKey(requestedDestination);
    const requestId = routeRequestSequence.current + 1;
    routeRequestSequence.current = requestId;
    activeRouteRequest.current = requestId;
    lastRouteRequestAt.current = Date.now();
    let result: Awaited<ReturnType<typeof requestRoutePlan>>;
    try {
      result = await requestRoutePlan({ origin, destination: requestedDestination, mode: selectedMode });
    } catch {
      if (activeRouteRequest.current === requestId) activeRouteRequest.current = null;
      if (mounted.current && routeRequestSequence.current === requestId) {
        setMessage('Your route could not be updated. Check your connection and try again.');
      }
      return false;
    }
    if (!mounted.current || activeRouteRequest.current !== requestId || routeRequestSequence.current !== requestId) return false;
    activeRouteRequest.current = null;
    if (destinationKey(destinationRef.current) !== requestedDestinationKey) {
      setMessage('This destination moved while the route was loading. Try the route again.');
      return false;
    }
    if (!result.ok || !result.data) {
      setMessage(result.ok ? 'A route could not be created.' : result.reason);
      return false;
    }
    routeRequestOrigin.current = origin;
    routeRef.current = result.data;
    routeDestinationKey.current = requestedDestinationKey;
    setRoutedDestinationKey(requestedDestinationKey);
    setRouteStepIndex(0);
    setRoute(result.data);
    setRouteVisible(true);
    setMessage(null);
    return true;
  }, []);

  const beginWatching = useCallback(async () => {
    if (!mounted.current) return;
    const generation = watcherGeneration.current + 1;
    watcherGeneration.current = generation;
    watcher.current?.remove();
    watcher.current = null;
    if (!trackingWanted.current || appStateRef.current !== 'active') return;
    const subscription = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, distanceInterval: 10, timeInterval: 4_000 },
      (position) => {
        if (
          !mounted.current ||
          watcherGeneration.current !== generation ||
          !trackingWanted.current ||
          appStateRef.current !== 'active'
        ) return;
        const next = { latitude: position.coords.latitude, longitude: position.coords.longitude };
        setLocation(next);
        const activeRoute = routeRef.current;
        if (activeRoute && routeDestinationKey.current === destinationKey(destinationRef.current)) {
          setRouteStepIndex((current) => advanceRouteStepIndex(activeRoute, next, current));
        }
        const selectedMode = modeRef.current;
        const priorOrigin = routeRequestOrigin.current;
        if (selectedMode && shouldRequestAutomaticReroute({
          enabled: automaticReroutingRef.current,
          previousOrigin: priorOrigin,
          currentOrigin: next,
          lastRequestAt: lastRouteRequestAt.current,
        })) void refreshRoute(next, selectedMode);
      }
    );
    if (
      !mounted.current ||
      watcherGeneration.current !== generation ||
      !trackingWanted.current ||
      appStateRef.current !== 'active'
    ) {
      subscription.remove();
      return;
    }
    watcher.current = subscription;
  }, [refreshRoute]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      appStateRef.current = state;
      if (state !== 'active') {
        watcherGeneration.current += 1;
        watcher.current?.remove();
        watcher.current = null;
      } else if (trackingWanted.current && !watcher.current) {
        void beginWatching().catch(() => {
          if (mounted.current && trackingWanted.current && appStateRef.current === 'active') {
            setMessage('Live tracking could not resume. Check location services and try again.');
          }
        });
      }
    });
    return () => {
      trackingWanted.current = false;
      watcherGeneration.current += 1;
      routeRequestSequence.current += 1;
      activeRouteRequest.current = null;
      watcher.current?.remove();
      watcher.current = null;
      subscription.remove();
    };
  }, [beginWatching]);

  const startNavigation = async (selectedChoice: TravelModeChoice) => {
    if (auth.status !== 'authenticated') {
      router.push({ pathname: '/auth', params: { next: `/navigation/${placeId ?? ''}` } } as Href);
      return;
    }
    if (!place || !destination || isHomeKitchenBlocked(place.category) || place.category === 'home_kitchen') return;
    const navigationGeneration = ++navigationOperationGeneration.current;
    routeRequestSequence.current += 1;
    activeRouteRequest.current = null;
    setBusy(true);
    setPendingMode(selectedChoice);
    setMessage(null);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!mounted.current || navigationOperationGeneration.current !== navigationGeneration) return;
      if (permission.status !== Location.PermissionStatus.GRANTED) {
        setMessage('Allow foreground location access to start live navigation. Spottr does not request background tracking.');
        return;
      }
      const current = await currentPositionWithTimeout();
      if (!mounted.current || navigationOperationGeneration.current !== navigationGeneration) return;
      const origin = { latitude: current.coords.latitude, longitude: current.coords.longitude };
      const selectedMode = selectedChoice === 'auto'
        ? inferTravelMode({
            speedMetersPerSecond: current.coords.speed,
            horizontalAccuracyMeters: current.coords.accuracy,
            distanceMeters: navigationDistanceMeters(origin, destination),
          })
        : selectedChoice;
      setLocation(origin);
      automaticReroutingRef.current = false;
      setAutomaticRerouting(false);
      setMode(selectedMode);
      setModeChoice(selectedChoice);
      modeRef.current = selectedMode;
      const routed = await refreshRoute(origin, selectedMode);
      if (!mounted.current || navigationOperationGeneration.current !== navigationGeneration) return;
      if (!routed) {
        modeRef.current = null;
        setMode(null);
        setModeChoice(null);
        return;
      }
      trackingWanted.current = true;
      await beginWatching();
      if (selectedChoice === 'auto' && mounted.current) {
        setMessage(`Auto estimated ${selectedMode === 'drive' ? 'driving' : 'walking'} from current speed and trip distance. You can change the mode anytime.`);
      }
    } catch {
      if (mounted.current && navigationOperationGeneration.current === navigationGeneration) {
        setMessage('Your current location could not be read. Check location services and try again.');
      }
    } finally {
      if (mounted.current && navigationOperationGeneration.current === navigationGeneration) {
        setBusy(false);
        setPendingMode(null);
      }
    }
  };

  const changeTravelMode = async (selectedChoice: TravelModeChoice) => {
    if (!mode || (selectedChoice === modeChoice && visibleRoute) || busy) return;
    if (!location) {
      setMessage('Your current location is not available yet. Try changing travel mode again.');
      return;
    }
    const navigationGeneration = ++navigationOperationGeneration.current;
    routeRequestSequence.current += 1;
    activeRouteRequest.current = null;
    setBusy(true);
    setPendingMode(selectedChoice);
    setMessage(null);
    try {
      let routeOrigin = location;
      let selectedMode: TravelMode = selectedChoice === 'auto'
        ? inferTravelMode({
            distanceMeters: destination ? navigationDistanceMeters(location, destination) : Number.POSITIVE_INFINITY,
          })
        : selectedChoice;
      if (selectedChoice === 'auto') {
        const current = await currentPositionWithTimeout();
        if (!mounted.current || navigationOperationGeneration.current !== navigationGeneration) return;
        routeOrigin = { latitude: current.coords.latitude, longitude: current.coords.longitude };
        setLocation(routeOrigin);
        selectedMode = inferTravelMode({
          speedMetersPerSecond: current.coords.speed,
          horizontalAccuracyMeters: current.coords.accuracy,
          distanceMeters: destination
            ? navigationDistanceMeters(routeOrigin, destination)
            : Number.POSITIVE_INFINITY,
        });
      }
      const routed = await refreshRoute(routeOrigin, selectedMode);
      if (!mounted.current || navigationOperationGeneration.current !== navigationGeneration) return;
      if (!routed) return;
      modeRef.current = selectedMode;
      setMode(selectedMode);
      setModeChoice(selectedChoice);
      if (selectedChoice === 'auto') {
        setMessage(`Auto estimated ${selectedMode === 'drive' ? 'driving' : 'walking'} from current speed and trip distance. You can change the mode anytime.`);
      }
    } catch {
      if (mounted.current && navigationOperationGeneration.current === navigationGeneration) {
        setMessage('Your route could not be updated. Check your connection and try again.');
      }
    } finally {
      if (mounted.current && navigationOperationGeneration.current === navigationGeneration) {
        setBusy(false);
        setPendingMode(null);
      }
    }
  };

  const stopTracking = () => {
    cancelTrackingSession('Live tracking stopped.');
  };

  const toggleAutomaticRerouting = () => {
    const enabled = !automaticReroutingRef.current;
    automaticReroutingRef.current = enabled;
    setAutomaticRerouting(enabled);
  };

  const openExternalMaps = (provider?: ExternalMapProvider) => {
    if (!place) return;
    const url = provider
      ? externalDirectionsProviderUrl(place, provider, mode)
      : externalDirectionsUrl(place, Platform.OS, mode);
    if (!url) {
      setMessage('This listing does not have a valid public destination.');
      return;
    }
    void Linking.openURL(url).catch(() => {
      if (mounted.current) setMessage('Your maps app could not open this destination.');
    });
  };

  if ((!place && placeRequestPending) || auth.status === 'loading') {
    return <View role="main" style={styles.center}><ActivityIndicator color={palette.accentDeep} /><Text style={styles.centerText}>Preparing navigation…</Text></View>;
  }
  if (!place) {
    return <View role="main" style={styles.center}><Text accessibilityRole="header" style={styles.centerTitle}>This destination is unavailable.</Text><Text style={styles.centerText}>{placeBlockedReason ?? message}</Text></View>;
  }
  if (place.category === 'home_kitchen') {
    return (
      <View role="main" style={styles.center}>
        <FontAwesome6 color={palette.accentDeep} name="shield-halved" size={26} />
        <Text accessibilityRole="header" style={styles.centerTitle}>Private pickup details stay private.</Text>
        <Text style={styles.centerText}>Neighborhood Kitchen directions are shared only through an authorized, expiring pickup card in chat.</Text>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.darkButton}><Text style={styles.darkButtonText}>Go back</Text></Pressable>
      </View>
    );
  }
  if (!featureFlags.inAppNavigation) {
    return (
      <View role="main" style={styles.center}>
        <FontAwesome6 color={palette.accentDeep} name="route" size={26} />
        <Text accessibilityRole="header" style={styles.centerTitle}>Spottr navigation is not available yet.</Text>
        <Text style={styles.centerText}>You can still open this public destination in Apple Maps or Google Maps.</Text>
        <View style={styles.centerActionRow}>
          {Platform.OS !== 'android' ? (
            <Pressable accessibilityRole="link" onPress={() => openExternalMaps('apple')} style={styles.darkButton}>
              <Text style={styles.darkButtonText}>Apple Maps</Text>
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="link" onPress={() => openExternalMaps('google')} style={Platform.OS === 'android' ? styles.darkButton : styles.outlineButton}>
            <Text style={Platform.OS === 'android' ? styles.darkButtonText : styles.outlineButtonText}>Google Maps</Text>
          </Pressable>
        </View>
      </View>
    );
  }
  if (auth.status !== 'authenticated') {
    return (
      <View role="main" style={styles.center}>
        <FontAwesome6 color={palette.accentDeep} name="location-arrow" size={26} />
        <Text accessibilityRole="header" style={styles.centerTitle}>Sign in for live navigation.</Text>
        <Text style={styles.centerText}>Live foreground location and provider route requests require your Spottr account.</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push({ pathname: '/auth', params: { next: `/navigation/${place.id}` } } as Href)}
          style={styles.darkButton}>
          <Text style={styles.darkButtonText}>Sign in securely</Text>
        </Pressable>
        <View style={styles.centerActionRow}>
          {Platform.OS !== 'android' ? (
            <Pressable accessibilityRole="link" onPress={() => openExternalMaps('apple')} style={styles.outlineButton}>
              <Text style={styles.outlineButtonText}>Apple Maps</Text>
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="link" onPress={() => openExternalMaps('google')} style={styles.outlineButton}>
            <Text style={styles.outlineButtonText}>Google Maps</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const nextStep = visibleRoute?.steps[routeStepIndex] ?? null;
  const routeStatusMessage = message ?? (route && !routeMatchesDestination
    ? 'This destination moved. Select your current travel mode to refresh the route.'
    : route && !routeIsFresh
      ? 'This route estimate expired. Select your current travel mode to refresh it.'
      : null);
  const travelModePrivacyNotice = mode
    ? 'Changing travel mode sends your current precise location, this public destination, and the selected route mode to Mapbox. Auto estimates walking or driving on your device from current speed and trip distance before requesting a route.'
    : 'Starting navigation sends your precise current starting location, this public destination, and route mode to Mapbox. Auto estimates walking or driving on your device first. Spottr does not send later movement to Mapbox for rerouting unless you separately turn on Automatic rerouting, and does not save your route to your profile.';
  return (
    <View role="main" style={styles.screen}>
      <View style={styles.topBar}>
        <Pressable accessibilityLabel="Back to destination" accessibilityRole="button" onPress={() => router.back()} style={styles.iconButton}>
          <FontAwesome6 color={palette.ink} name="arrow-left" size={15} />
        </Pressable>
        <View style={styles.destinationCopy}>
          <Text accessibilityRole="header" numberOfLines={1} style={styles.title}>{place.name}</Text>
          <Text numberOfLines={1} style={styles.subtitle}>{place.categoryLabel} · {place.city}</Text>
        </View>
        <Pressable accessibilityLabel="Open destination in external maps" accessibilityRole="link" onPress={() => openExternalMaps()} style={styles.iconButton}>
          <FontAwesome6 color={palette.ink} name="arrow-up-right-from-square" size={14} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {visibleRoute ? (
          <View accessibilityLiveRegion="polite" style={styles.guidanceStrip}>
            <FontAwesome6 color="#FFFFFF" name="diamond-turn-right" size={20} />
            <View style={styles.guidanceCopy}>
              <Text numberOfLines={2} style={styles.guidanceInstruction}>{nextStep?.instruction ?? 'Continue toward your destination'}</Text>
              <Text style={styles.guidanceMeta}>ETA {formatRouteArrivalTime(visibleRoute)} · {formatRouteDuration(visibleRoute.durationSeconds)} · {formatRouteDistance(visibleRoute.distanceMeters)}</Text>
            </View>
          </View>
        ) : null}

        <View style={styles.mapFrame}>
          <LiveMap
            navigationMode={mode ?? undefined}
            places={[place]}
            routeCoordinates={routeVisible ? visibleRoute?.coordinates : []}
            selectedId={place.id}
            userCoordinates={location}
          />
        </View>

        <View style={styles.controlsArea}>
          <Text style={styles.controlHeading}>{modeChoice === 'auto' && mode
            ? `Auto estimated ${mode === 'drive' ? 'driving' : 'walking'}`
            : mode ? 'Travel mode' : 'Choose how you’re traveling'}</Text>
          <Text nativeID="travel-mode-privacy-description" style={styles.providerNotice}>{travelModePrivacyNotice}</Text>
          <View accessibilityLabel="Travel mode" accessibilityRole="radiogroup" style={styles.modeRow}>
            {travelModes.map((item) => {
              const selected = item.id === (modeChoice ?? mode);
              return (
                <Pressable
                  aria-checked={selected}
                  aria-describedby="travel-mode-privacy-description"
                  accessibilityHint={travelModePrivacyNotice}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected, disabled: busy }}
                  disabled={busy}
                  key={item.id}
                  onPress={() => void (mode ? changeTravelMode(item.id) : startNavigation(item.id))}
                  style={[styles.modeButton, selected && styles.modeButtonSelected]}>
                  {busy && pendingMode === item.id
                    ? <ActivityIndicator color={palette.ink} size="small" />
                    : <FontAwesome6 color={palette.ink} name={item.icon} size={16} />}
                  <Text style={styles.modeText}>{item.label}</Text>
                </Pressable>
              );
            })}
          </View>
          {mode ? (
            <>
              <View style={styles.rerouteControl}>
                <View style={styles.rerouteCopy}>
                  <Text style={styles.rerouteTitle}>Automatic rerouting</Text>
                  <Text nativeID="automatic-rerouting-description" style={styles.rerouteDescription}>{automaticReroutingPrivacyNotice}</Text>
                </View>
                <Pressable
                  aria-checked={automaticRerouting}
                  aria-describedby="automatic-rerouting-description"
                  accessibilityHint={automaticReroutingPrivacyNotice}
                  accessibilityLabel="Automatic rerouting"
                  accessibilityRole="switch"
                  accessibilityState={{ checked: automaticRerouting }}
                  onPress={toggleAutomaticRerouting}
                  style={styles.rerouteToggle}>
                  <Text style={styles.rerouteState}>{automaticRerouting ? 'On' : 'Off'}</Text>
                  <View style={[styles.switchTrack, automaticRerouting && styles.switchTrackActive]}>
                    <View style={[styles.switchThumb, automaticRerouting && styles.switchThumbActive]} />
                  </View>
                </Pressable>
              </View>
              <View style={styles.activeControls}>
                {visibleRoute ? (
                  <Pressable accessibilityRole="button" onPress={() => setRouteVisible((value) => !value)} style={styles.secondaryButton}>
                    <FontAwesome6 color={palette.ink} name={routeVisible ? 'route' : 'eye'} size={13} />
                    <Text style={styles.secondaryButtonText}>{routeVisible ? 'Hide route' : 'Show route'}</Text>
                  </Pressable>
                ) : null}
                <Pressable accessibilityRole="button" onPress={stopTracking} style={styles.stopButton}>
                  <FontAwesome6 color="#FFFFFF" name="location-crosshairs" size={13} />
                  <Text style={styles.stopButtonText}>Stop tracking</Text>
                </Pressable>
              </View>
              <View accessibilityLabel="Open route in another maps app" style={styles.externalMapsRow}>
                {Platform.OS !== 'android' ? (
                  <Pressable accessibilityRole="link" onPress={() => openExternalMaps('apple')} style={styles.externalMapsButton}>
                    <Text style={styles.externalMapsButtonText}>Apple Maps</Text>
                  </Pressable>
                ) : null}
                <Pressable accessibilityRole="link" onPress={() => openExternalMaps('google')} style={styles.externalMapsButton}>
                  <Text style={styles.externalMapsButtonText}>Google Maps</Text>
                </Pressable>
              </View>
            </>
          ) : null}
          {routeStatusMessage ? <Text accessibilityLiveRegion="assertive" style={styles.message}>{routeStatusMessage}</Text> : null}
          <Text style={styles.disclaimer}>Foreground only. Routes and ETAs are estimates—follow posted signs, closures, laws, and real-world conditions. Do not interact while driving.</Text>
          {visibleRoute ? <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(visibleRoute.attributionUrl)}><Text style={styles.attribution}>{visibleRoute.attribution}</Text></Pressable> : null}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: palette.bg, flex: 1 },
  topBar: { alignItems: 'center', backgroundColor: palette.surface, borderBottomColor: palette.line, borderBottomWidth: 1, flexDirection: 'row', gap: 12, minHeight: 68, paddingHorizontal: spacing.md, paddingVertical: 10 },
  destinationCopy: { flex: 1, minWidth: 0 },
  title: { color: palette.ink, fontSize: 18, fontWeight: '900', letterSpacing: -0.4 },
  subtitle: { color: palette.muted, fontSize: 11, fontWeight: '700', marginTop: 2 },
  iconButton: { alignItems: 'center', backgroundColor: palette.bg, borderColor: palette.line, borderRadius: 999, borderWidth: 1, height: 44, justifyContent: 'center', width: 44 },
  content: { alignSelf: 'center', paddingBottom: 24, width: '100%', maxWidth: 1100 },
  guidanceStrip: { alignItems: 'center', backgroundColor: palette.ink, flexDirection: 'row', gap: 14, minHeight: 84, paddingHorizontal: 20, paddingVertical: 14 },
  guidanceCopy: { flex: 1 },
  guidanceInstruction: { color: '#FFFFFF', fontSize: 16, fontWeight: '900', lineHeight: 21 },
  guidanceMeta: { color: palette.darkMuted, fontSize: 12, fontWeight: '800', marginTop: 4 },
  mapFrame: { backgroundColor: '#E9EAE3', minHeight: 470 },
  controlsArea: { backgroundColor: palette.surface, borderTopColor: palette.line, borderTopWidth: 1, gap: 14, padding: spacing.lg },
  controlHeading: { color: palette.ink, fontSize: 13, fontWeight: '900' },
  providerNotice: { color: palette.muted, fontSize: 11, lineHeight: 17, maxWidth: 760 },
  modeRow: { flexDirection: 'row', gap: 10 },
  modeButton: { alignItems: 'center', backgroundColor: palette.bg, borderColor: palette.line, borderRadius: radii.md, borderWidth: 1, flex: 1, gap: 7, justifyContent: 'center', minHeight: 64 },
  modeButtonSelected: { backgroundColor: palette.accentSoft, borderColor: palette.accentDeep, borderWidth: 2 },
  modeText: { color: palette.ink, fontSize: 11, fontWeight: '900' },
  activeControls: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  externalMapsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  externalMapsButton: { borderBottomColor: palette.accentDeep, borderBottomWidth: 1, justifyContent: 'center', minHeight: 44, paddingHorizontal: 4 },
  externalMapsButtonText: { color: palette.accentDeep, fontSize: 11, fontWeight: '900' },
  rerouteControl: { alignItems: 'center', backgroundColor: palette.bg, borderColor: palette.line, borderRadius: radii.md, borderWidth: 1, flexDirection: 'row', gap: 16, minHeight: 72, paddingHorizontal: 16, paddingVertical: 12 },
  rerouteCopy: { flex: 1, gap: 3 },
  rerouteTitle: { color: palette.ink, fontSize: 12, fontWeight: '900' },
  rerouteDescription: { color: palette.muted, fontSize: 10, lineHeight: 15, maxWidth: 720 },
  rerouteToggle: { alignItems: 'center', borderRadius: radii.sm, gap: 4, minHeight: 48, minWidth: 56, justifyContent: 'center' },
  rerouteState: { color: palette.ink, fontSize: 10, fontWeight: '900' },
  switchTrack: { backgroundColor: palette.line, borderRadius: 999, height: 28, justifyContent: 'center', paddingHorizontal: 3, width: 48 },
  switchTrackActive: { backgroundColor: palette.accentDeep },
  switchThumb: { backgroundColor: '#FFFFFF', borderRadius: 999, height: 22, width: 22 },
  switchThumbActive: { alignSelf: 'flex-end' },
  secondaryButton: { alignItems: 'center', borderColor: palette.line, borderRadius: radii.pill, borderWidth: 1, flexDirection: 'row', gap: 8, minHeight: 48, paddingHorizontal: 17 },
  secondaryButtonText: { color: palette.ink, fontSize: 11, fontWeight: '900' },
  stopButton: { alignItems: 'center', backgroundColor: palette.ink, borderRadius: radii.pill, flexDirection: 'row', gap: 8, minHeight: 48, paddingHorizontal: 17 },
  stopButtonText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900' },
  message: { color: palette.accentDeep, fontSize: 12, fontWeight: '700', lineHeight: 18 },
  disclaimer: { color: palette.muted, fontSize: 10, lineHeight: 16, maxWidth: 720 },
  attribution: { color: palette.muted, fontSize: 10, fontWeight: '800', textDecorationLine: 'underline' },
  center: { alignItems: 'center', backgroundColor: palette.bg, flex: 1, gap: 14, justifyContent: 'center', padding: 32 },
  centerTitle: { color: palette.ink, fontSize: 22, fontWeight: '900', textAlign: 'center' },
  centerText: { color: palette.muted, fontSize: 13, lineHeight: 20, maxWidth: 520, textAlign: 'center' },
  centerActionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center' },
  darkButton: { backgroundColor: palette.ink, borderRadius: radii.pill, minHeight: 48, justifyContent: 'center', paddingHorizontal: 20 },
  darkButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
  outlineButton: { borderColor: palette.line, borderRadius: radii.pill, borderWidth: 1, minHeight: 48, justifyContent: 'center', paddingHorizontal: 20 },
  outlineButtonText: { color: palette.ink, fontSize: 12, fontWeight: '900' },
});
