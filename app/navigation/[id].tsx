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
import { featureFlags } from '@/lib/features';
import {
  formatRouteDistance,
  formatRouteDuration,
  nearestRouteStep,
  requestRoutePlan,
  shouldRequestAutomaticReroute,
} from '@/lib/navigation';
import type { NavigationCoordinate, RoutePlan, TravelMode } from '@/types/navigation';

const travelModes: { id: TravelMode; label: string; icon: 'car-side' | 'person-walking' | 'bicycle' }[] = [
  { id: 'drive', label: 'Drive', icon: 'car-side' },
  { id: 'walk', label: 'Walk', icon: 'person-walking' },
  { id: 'bike', label: 'Bike', icon: 'bicycle' },
];
const automaticReroutingPrivacyNotice = 'When on, Spottr may send your updated precise current location to Mapbox after at least 100 m of movement and 90 seconds to refresh the route. Turn it off to stop additional Mapbox route requests while your foreground live marker continues.';

export default function NavigationScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const placeId = Array.isArray(params.id) ? params.id[0] : params.id;
  const auth = useAuth();
  const { ensurePlace, places } = useMarketplaceStore();
  const place = places.find((entry) => entry.id === placeId);
  const [placeRequestPending, setPlaceRequestPending] = useState(Boolean(placeId && !place));
  const [route, setRoute] = useState<RoutePlan | null>(null);
  const [routeVisible, setRouteVisible] = useState(true);
  const [mode, setMode] = useState<TravelMode | null>(null);
  const [location, setLocation] = useState<NavigationCoordinate | null>(null);
  const [automaticRerouting, setAutomaticRerouting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const watcher = useRef<Location.LocationSubscription | null>(null);
  const trackingWanted = useRef(false);
  const modeRef = useRef<TravelMode | null>(null);
  const routeRequestOrigin = useRef<NavigationCoordinate | null>(null);
  const lastRouteRequestAt = useRef(0);
  const rerouteInFlight = useRef(false);
  const automaticReroutingRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);
  const watcherGeneration = useRef(0);

  useEffect(() => {
    if (!placeId || place) return;
    let active = true;
    void ensurePlace(placeId).then((result) => {
      if (!active) return;
      setPlaceRequestPending(false);
      if (!result.ok) setMessage(result.reason);
    });
    return () => { active = false; };
  }, [ensurePlace, place, placeId]);

  const destination = useMemo(() => place ? {
    latitude: place.latitude,
    longitude: place.longitude,
  } : null, [place]);

  const refreshRoute = useCallback(async (origin: NavigationCoordinate, selectedMode: TravelMode) => {
    if (!destination || rerouteInFlight.current) return false;
    rerouteInFlight.current = true;
    lastRouteRequestAt.current = Date.now();
    const result = await requestRoutePlan({ origin, destination, mode: selectedMode });
    rerouteInFlight.current = false;
    if (!result.ok || !result.data) {
      setMessage(result.ok ? 'A route could not be created.' : result.reason);
      return false;
    }
    routeRequestOrigin.current = origin;
    setRoute(result.data);
    setRouteVisible(true);
    setMessage(null);
    return true;
  }, [destination]);

  const beginWatching = useCallback(async () => {
    const generation = watcherGeneration.current + 1;
    watcherGeneration.current = generation;
    watcher.current?.remove();
    watcher.current = null;
    if (!trackingWanted.current || appStateRef.current !== 'active') return;
    const subscription = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, distanceInterval: 10, timeInterval: 4_000 },
      (position) => {
        if (
          watcherGeneration.current !== generation ||
          !trackingWanted.current ||
          appStateRef.current !== 'active'
        ) return;
        const next = { latitude: position.coords.latitude, longitude: position.coords.longitude };
        setLocation(next);
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
          if (trackingWanted.current && appStateRef.current === 'active') {
            setMessage('Live tracking could not resume. Check location services and try again.');
          }
        });
      }
    });
    return () => {
      trackingWanted.current = false;
      watcherGeneration.current += 1;
      watcher.current?.remove();
      watcher.current = null;
      subscription.remove();
    };
  }, [beginWatching]);

  const startNavigation = async (selectedMode: TravelMode) => {
    if (auth.status !== 'authenticated') {
      router.push({ pathname: '/auth', params: { next: `/navigation/${placeId ?? ''}` } } as Href);
      return;
    }
    if (!place || !destination || place.category === 'home_kitchen') return;
    setBusy(true);
    setMessage(null);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== Location.PermissionStatus.GRANTED) {
        setMessage('Allow foreground location access to start live navigation. Spottr does not request background tracking.');
        return;
      }
      const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const origin = { latitude: current.coords.latitude, longitude: current.coords.longitude };
      setLocation(origin);
      automaticReroutingRef.current = false;
      setAutomaticRerouting(false);
      setMode(selectedMode);
      modeRef.current = selectedMode;
      const routed = await refreshRoute(origin, selectedMode);
      if (!routed) {
        modeRef.current = null;
        setMode(null);
        return;
      }
      trackingWanted.current = true;
      await beginWatching();
    } catch {
      setMessage('Your current location could not be read. Check location services and try again.');
    } finally {
      setBusy(false);
    }
  };

  const stopTracking = () => {
    trackingWanted.current = false;
    watcherGeneration.current += 1;
    watcher.current?.remove();
    watcher.current = null;
    modeRef.current = null;
    setMode(null);
    setRoute(null);
    setLocation(null);
    automaticReroutingRef.current = false;
    setAutomaticRerouting(false);
    setMessage('Live tracking stopped.');
  };

  const toggleAutomaticRerouting = () => {
    const enabled = !automaticReroutingRef.current;
    automaticReroutingRef.current = enabled;
    setAutomaticRerouting(enabled);
  };

  const openExternalMaps = () => {
    if (!place) return;
    const url = Platform.OS === 'ios'
      ? `maps://?daddr=${place.latitude},${place.longitude}`
      : `https://www.google.com/maps/dir/?api=1&destination=${place.latitude},${place.longitude}`;
    void Linking.openURL(url);
  };

  if ((!place && placeRequestPending) || auth.status === 'loading') {
    return <View role="main" style={styles.center}><ActivityIndicator color={palette.accentDeep} /><Text style={styles.centerText}>Preparing navigation…</Text></View>;
  }
  if (!place) {
    return <View role="main" style={styles.center}><Text accessibilityRole="header" style={styles.centerTitle}>This destination is unavailable.</Text><Text style={styles.centerText}>{message}</Text></View>;
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
        <Text style={styles.centerText}>You can still open this public destination in your device’s maps app.</Text>
        <Pressable accessibilityRole="link" onPress={openExternalMaps} style={styles.darkButton}>
          <Text style={styles.darkButtonText}>Open in Maps</Text>
        </Pressable>
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
      </View>
    );
  }

  const nextStep = route && location ? nearestRouteStep(route, location) : route?.steps[0] ?? null;
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
        <Pressable accessibilityLabel="Open destination in external maps" accessibilityRole="link" onPress={openExternalMaps} style={styles.iconButton}>
          <FontAwesome6 color={palette.ink} name="arrow-up-right-from-square" size={14} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {route ? (
          <View accessibilityLiveRegion="polite" style={styles.guidanceStrip}>
            <FontAwesome6 color="#FFFFFF" name="diamond-turn-right" size={20} />
            <View style={styles.guidanceCopy}>
              <Text numberOfLines={2} style={styles.guidanceInstruction}>{nextStep?.instruction ?? 'Continue toward your destination'}</Text>
              <Text style={styles.guidanceMeta}>{formatRouteDuration(route.durationSeconds)} · {formatRouteDistance(route.distanceMeters)}</Text>
            </View>
          </View>
        ) : null}

        <View style={styles.mapFrame}>
          <LiveMap
            navigationMode={mode ?? undefined}
            places={[place]}
            routeCoordinates={routeVisible ? route?.coordinates : []}
            selectedId={place.id}
            userCoordinates={location}
          />
        </View>

        <View style={styles.controlsArea}>
          {!mode ? (
            <>
              <Text style={styles.controlHeading}>Choose how you’re traveling</Text>
              <Text style={styles.providerNotice}>Starting navigation sends your precise current starting location, this public destination, and travel mode to Mapbox to calculate one route. Spottr does not send later movement to Mapbox for rerouting unless you separately turn on Automatic rerouting. Spottr does not save your route to your profile.</Text>
              <View accessibilityRole="radiogroup" style={styles.modeRow}>
                {travelModes.map((item) => (
                  <Pressable
                    aria-checked={false}
                    accessibilityRole="radio"
                    accessibilityState={{ disabled: busy }}
                    disabled={busy}
                    key={item.id}
                    onPress={() => void startNavigation(item.id)}
                    style={styles.modeButton}>
                    {busy ? <ActivityIndicator color={palette.ink} size="small" /> : <FontAwesome6 color={palette.ink} name={item.icon} size={16} />}
                    <Text style={styles.modeText}>{item.label}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : (
            <>
              <View style={styles.rerouteControl}>
                <View style={styles.rerouteCopy}>
                  <Text style={styles.rerouteTitle}>Automatic rerouting</Text>
                  <Text nativeID="automatic-rerouting-description" style={styles.rerouteDescription}>{automaticReroutingPrivacyNotice}</Text>
                </View>
                <Pressable
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
                <Pressable accessibilityRole="button" onPress={() => setRouteVisible((value) => !value)} style={styles.secondaryButton}>
                  <FontAwesome6 color={palette.ink} name={routeVisible ? 'route' : 'eye'} size={13} />
                  <Text style={styles.secondaryButtonText}>{routeVisible ? 'Hide route' : 'Show route'}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={stopTracking} style={styles.stopButton}>
                  <FontAwesome6 color="#FFFFFF" name="location-crosshairs" size={13} />
                  <Text style={styles.stopButtonText}>Stop tracking</Text>
                </Pressable>
              </View>
            </>
          )}
          {message ? <Text accessibilityLiveRegion="assertive" style={styles.message}>{message}</Text> : null}
          <Text style={styles.disclaimer}>Foreground only. Route guidance is informational—follow posted signs, closures, and real-world conditions.</Text>
          {route ? <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(route.attributionUrl)}><Text style={styles.attribution}>{route.attribution}</Text></Pressable> : null}
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
  modeText: { color: palette.ink, fontSize: 11, fontWeight: '900' },
  activeControls: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
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
  darkButton: { backgroundColor: palette.ink, borderRadius: radii.pill, minHeight: 48, justifyContent: 'center', paddingHorizontal: 20 },
  darkButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
});
