import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { lazy, Suspense } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { palette, radii } from '@/constants/theme';
import { Place } from '@/types/marketplace';
import type { MapInventoryFeature, MapViewport } from '@/types/map';
import type { NavigationCoordinate, TravelMode } from '@/types/navigation';

type Props = {
  places: Place[];
  selectedId?: string;
  selectedLocationId?: string;
  onSelect?: (place: Place) => void;
  onSelectBusinessId?: (businessId: string, locationId?: string) => void;
  onSearchArea?: (viewport: MapViewport) => Promise<void> | void;
  onViewportChange?: (viewport: MapViewport) => Promise<void> | void;
  onViewportInvalidated?: (viewport: MapViewport) => void;
  onRetryInventory?: () => void;
  inventoryFeatures?: MapInventoryFeature[];
  inventoryError?: string | null;
  markersSuppressed?: boolean;
  searchAreaKey?: string;
  userCoordinates?: { latitude: number; longitude: number } | null;
  routeCoordinates?: NavigationCoordinate[];
  navigationMode?: TravelMode;
};

const MapLibreMap = lazy(() => import('@/components/maplibre-map.web'));

function MapLoading() {
  return (
    <View accessibilityLiveRegion="polite" style={styles.loading}>
      <View style={styles.loadingIcon}>
        <FontAwesome6 color={palette.accentDeep} name="map-location-dot" size={20} />
      </View>
      <Text style={styles.loadingTitle}>Preparing the live map…</Text>
      <Text style={styles.loadingBody}>Listings remain available in the results beside the map.</Text>
    </View>
  );
}

export function LiveMap(props: Props) {
  return (
    <Suspense fallback={<MapLoading />}>
      <MapLibreMap {...props} />
    </Suspense>
  );
}

const styles = StyleSheet.create({
  loading: {
    alignItems: 'center',
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.xl,
    borderWidth: 1,
    gap: 7,
    height: 470,
    justifyContent: 'center',
    padding: 28,
  },
  loadingIcon: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: 999,
    height: 48,
    justifyContent: 'center',
    marginBottom: 4,
    width: 48,
  },
  loadingTitle: {
    color: palette.ink,
    fontSize: 15,
    fontWeight: '900',
  },
  loadingBody: {
    color: palette.muted,
    fontSize: 11,
    lineHeight: 17,
    maxWidth: 320,
    textAlign: 'center',
  },
});
