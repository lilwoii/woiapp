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
  formatRouteDistance,
  formatRouteDuration,
  navigationDistanceMeters,
  nearestRouteStep,
  requestRoutePlan,
} from '@/lib/navigation';
import type { NavigationCoordinate, RoutePlan, TravelMode } from '@/types/navigation';

const travelModes: { id: TravelMode; label: string; icon: 'car-side' | 'person-walking' | 'bicycle' }[] = [
  { id: 'drive', label: 'Drive', icon: 'car-side' },
  { id: 'walk', label: 'Walk', icon: 'person-walking' },
  { id: 'bike', label: 'Bike', icon: 'bicycle' },
];

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
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const watcher = useRef<Location.LocationSubscription | null>(null);
  const trackingWanted = useRef(false);
  const modeRef = useRef<TravelMode | null>(null);
  const routeRequestOrigin = useRef<NavigationCoordinate | null>(null);
  const lastRouteRequestAt = useRef(0);
  const rerouteInFlight = useRef(false);

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
    watcher.current?.remove();
    watcher.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, distanceInterval: 10, timeInterval: 4_000 },
      (position) => {
        const next = { latitude: position.coords.latitude, longitude: position.coords.longitude };
        setLocation(next);
        const selectedMode = modeRef.current;
        const priorOrigin = routeRequestOrigin.current;
        if (
          selectedMode && priorOrigin && Date.now() - lastRouteRequestAt.current >= 90_000 &&
          navigationDistanceMeters(priorOrigin, next) >= 100
        ) void refreshRoute(next, selectedMode);
      }
    );
  }, [refreshRoute]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        watcher.current?.remove();
        watcher.current = null;
      } else if (trackingWanted.current && !watcher.current) {
        void beginWatching();
      }
    });
    return () => {
      trackingWanted.current = false;
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
    watcher.current?.remove();
    watcher.current = null;
    modeRef.current = null;
    setMode(null);
    setRoute(null);
    setLocation(null);
    setMessage('Live tracking stopped.');
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
              <View accessibilityRole="radiogroup" style={styles.modeRow}>
                {travelModes.map((item) => (
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ checked: false, disabled: busy }}
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
  modeRow: { flexDirection: 'row', gap: 10 },
  modeButton: { alignItems: 'center', backgroundColor: palette.bg, borderColor: palette.line, borderRadius: radii.md, borderWidth: 1, flex: 1, gap: 7, justifyContent: 'center', minHeight: 64 },
  modeText: { color: palette.ink, fontSize: 11, fontWeight: '900' },
  activeControls: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
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
