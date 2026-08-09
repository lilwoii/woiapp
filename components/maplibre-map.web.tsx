import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import maplibregl, { LngLatBounds, Map as MapLibreMap, Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { palette, radii } from '@/constants/theme';
import {
  clusterInventoryFeatures,
  clusterPlaces,
  normalizeLongitude,
  viewportIsLiveInventoryEligible,
} from '@/lib/map-clustering';
import { motionDuration } from '@/lib/motion';
import type { MapInventoryFeature, MapViewport } from '@/types/map';
import { Place } from '@/types/marketplace';

export type Props = {
  places: Place[];
  selectedId?: string;
  onSelect?: (place: Place) => void;
  onSelectBusinessId?: (businessId: string) => void;
  onSearchArea?: (viewport: MapViewport) => Promise<void> | void;
  onViewportChange?: (viewport: MapViewport) => Promise<void> | void;
  inventoryFeatures?: MapInventoryFeature[];
  userCoordinates?: { latitude: number; longitude: number } | null;
};

const fallbackCenter: [number, number] = [-118.2437, 34.0522];
const mapAttribution = process.env.EXPO_PUBLIC_MAP_ATTRIBUTION?.trim() || '© OpenStreetMap';
const mapAttributionUrl = (() => {
  const candidate =
    process.env.EXPO_PUBLIC_MAP_ATTRIBUTION_URL?.trim() ||
    'https://www.openstreetmap.org/copyright';
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? url.toString() : 'https://www.openstreetmap.org/copyright';
  } catch {
    return 'https://www.openstreetmap.org/copyright';
  }
})();

function createMapStyle(): maplibregl.StyleSpecification | string {
  const configuredStyle = process.env.EXPO_PUBLIC_MAP_STYLE_URL?.trim();
  if (configuredStyle) return configuredStyle;

  return {
    version: 8,
    sources: {
      openstreetmap: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors',
        maxzoom: 19,
      },
    },
    layers: [
      {
        id: 'openstreetmap',
        source: 'openstreetmap',
        type: 'raster',
        paint: {
          'raster-saturation': -0.42,
          'raster-contrast': -0.05,
          'raster-brightness-min': 0.18,
          'raster-brightness-max': 0.97,
        },
      },
    ],
  };
}

function markerElement(
  place: Pick<Place, 'name' | 'category' | 'categoryLabel' | 'distanceMiles' | 'logoUrl'>,
  selected: boolean
) {
  const element = document.createElement('button');
  element.type = 'button';
  element.tabIndex = -1;
  element.setAttribute(
    'aria-label',
    `${place.name}, ${place.categoryLabel}${
      place.distanceMiles !== null ? `, ${place.distanceMiles.toFixed(1)} miles away` : ''
    }`
  );
  element.style.alignItems = 'center';
  element.style.background = place.category === 'food_truck' ? palette.dark : '#FFFFFF';
  element.style.border = `3px solid ${selected ? palette.accentDeep : '#FFFFFF'}`;
  element.style.borderRadius = '999px';
  element.style.boxShadow = '0 6px 18px rgba(23, 44, 42, 0.24)';
  element.style.cursor = 'pointer';
  element.style.display = 'flex';
  element.style.height = selected ? '52px' : '46px';
  element.style.justifyContent = 'center';
  element.style.padding = '0';
  element.style.transition = 'width 160ms ease, height 160ms ease, border-color 160ms ease';
  element.style.width = selected ? '52px' : '46px';

  if (place.category === 'food_truck') {
    const truck = document.createElement('span');
    truck.setAttribute('aria-hidden', 'true');
    truck.style.display = 'block';
    truck.style.height = '18px';
    truck.style.position = 'relative';
    truck.style.width = '25px';

    const body = document.createElement('span');
    body.style.background = '#FFFFFF';
    body.style.borderRadius = '3px 2px 2px 3px';
    body.style.height = '12px';
    body.style.left = '1px';
    body.style.position = 'absolute';
    body.style.top = '1px';
    body.style.width = '15px';
    truck.appendChild(body);

    const cab = document.createElement('span');
    cab.style.background = '#FFFFFF';
    cab.style.borderRadius = '2px 4px 2px 1px';
    cab.style.clipPath = 'polygon(0 25%, 58% 25%, 100% 100%, 0 100%)';
    cab.style.height = '12px';
    cab.style.left = '14px';
    cab.style.position = 'absolute';
    cab.style.top = '1px';
    cab.style.width = '10px';
    truck.appendChild(cab);

    [6, 19].forEach((left) => {
      const wheel = document.createElement('span');
      wheel.style.background = palette.dark;
      wheel.style.border = '2px solid #FFFFFF';
      wheel.style.borderRadius = '999px';
      wheel.style.bottom = '0';
      wheel.style.height = '7px';
      wheel.style.left = `${left}px`;
      wheel.style.position = 'absolute';
      wheel.style.width = '7px';
      truck.appendChild(wheel);
    });
    element.appendChild(truck);
  } else if (place.logoUrl) {
    const image = document.createElement('img');
    image.alt = '';
    image.src = place.logoUrl;
    image.style.borderRadius = '999px';
    image.style.height = selected ? '42px' : '36px';
    image.style.objectFit = 'cover';
    image.style.width = selected ? '42px' : '36px';
    element.appendChild(image);
  } else {
    const symbol = document.createElement('span');
    symbol.setAttribute('aria-hidden', 'true');
    symbol.textContent = {
      restaurant: 'R',
      pop_up: 'P',
      cafe_bakery: 'C',
      home_kitchen: 'N',
      food_truck: 'T',
    }[place.category];
    symbol.style.color = palette.ink;
    symbol.style.fontFamily = 'system-ui, sans-serif';
    symbol.style.fontSize = '14px';
    symbol.style.fontWeight = '900';
    element.appendChild(symbol);
  }

  return element;
}

function updateMarkerSelection(element: HTMLButtonElement, selected: boolean) {
  element.style.borderColor = selected ? palette.accentDeep : '#FFFFFF';
  element.style.height = selected ? '52px' : '46px';
  element.style.width = selected ? '52px' : '46px';
  const image = element.querySelector('img');
  if (image) {
    image.style.height = selected ? '42px' : '36px';
    image.style.width = selected ? '42px' : '36px';
  }
}

function clusterElement(feature: { count: number }) {
  const element = document.createElement('button');
  element.type = 'button';
  element.tabIndex = -1;
  element.setAttribute('aria-label', `${feature.count} food places in this area. Zoom in to explore.`);
  element.style.alignItems = 'center';
  element.style.background = palette.accentDeep;
  element.style.border = '4px solid rgba(255, 255, 255, 0.94)';
  element.style.borderRadius = '999px';
  element.style.boxShadow = '0 7px 22px rgba(23, 44, 42, 0.28)';
  element.style.color = '#FFFFFF';
  element.style.cursor = 'pointer';
  element.style.display = 'flex';
  element.style.fontFamily = 'system-ui, sans-serif';
  element.style.fontSize = feature.count > 99 ? '12px' : '13px';
  element.style.fontWeight = '900';
  element.style.height = feature.count > 99 ? '56px' : '50px';
  element.style.justifyContent = 'center';
  element.style.width = feature.count > 99 ? '56px' : '50px';
  element.textContent = feature.count > 999 ? '999+' : String(feature.count);
  return element;
}

function viewportFromMap(map: MapLibreMap): MapViewport {
  const center = map.getCenter();
  const bounds = map.getBounds();
  const latitudeMeters = Math.abs(bounds.getNorth() - bounds.getSouth()) * 111_320;
  const longitudeMeters =
    Math.abs(bounds.getEast() - bounds.getWest()) *
    111_320 *
    Math.max(0.1, Math.cos((center.lat * Math.PI) / 180));
  return {
    latitude: center.lat,
    longitude: center.lng,
    radiusMeters: Math.round(Math.min(200_000, Math.max(1_000, Math.hypot(latitudeMeters, longitudeMeters) / 2))),
    zoom: map.getZoom(),
    bounds: {
      west: normalizeLongitude(bounds.getWest()),
      south: Math.max(-85.05112878, bounds.getSouth()),
      east: normalizeLongitude(bounds.getEast()),
      north: Math.min(85.05112878, bounds.getNorth()),
    },
  };
}

const categoryLabels: Record<Place['category'], string> = {
  food_truck: 'Food truck',
  restaurant: 'Restaurant',
  pop_up: 'Pop-up',
  cafe_bakery: 'Café & bakery',
  home_kitchen: 'Neighborhood kitchen',
};

export default function MapLibreMapView({
  places,
  selectedId,
  onSelect,
  onSelectBusinessId,
  onSearchArea,
  onViewportChange,
  inventoryFeatures = [],
  userCoordinates,
}: Props) {
  const containerRef = useRef<View | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRefs = useRef(
    new Map<string, { marker: Marker; element: HTMLButtonElement; businessId?: string; signature?: string }>()
  );
  const currentPlaces = useRef(new Map(places.map((place) => [place.id, place])));
  const onSelectRef = useRef(onSelect);
  const onSelectBusinessIdRef = useRef(onSelectBusinessId);
  const onSearchAreaRef = useRef(onSearchArea);
  const onViewportChangeRef = useRef(onViewportChange);
  const fittedPlacesKey = useRef('');
  const userMarkerRef = useRef<Marker | null>(null);
  const initialPlaces = useRef(places);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [mapZoom, setMapZoom] = useState(11.5);
  const [pendingViewport, setPendingViewport] = useState<MapViewport | null>(null);
  const userMovedMap = useRef(false);
  const renderedInventoryFeatures = useMemo(
    () => clusterInventoryFeatures(inventoryFeatures, mapZoom),
    [inventoryFeatures, mapZoom]
  );

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => setReduceMotion(media.matches);
    updatePreference();
    media.addEventListener('change', updatePreference);
    return () => media.removeEventListener('change', updatePreference);
  }, []);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    onSelectBusinessIdRef.current = onSelectBusinessId;
  }, [onSelectBusinessId]);

  useEffect(() => {
    onSearchAreaRef.current = onSearchArea;
  }, [onSearchArea]);

  useEffect(() => {
    onViewportChangeRef.current = onViewportChange;
  }, [onViewportChange]);

  useEffect(() => {
    const element = containerRef.current as unknown as HTMLElement | null;
    if (!element || mapRef.current) return;
    const markers = markerRefs.current;
    let failureTimer: ReturnType<typeof setTimeout> | null = null;
    let inventoryTimer: ReturnType<typeof setTimeout> | null = null;

    try {
      const first = initialPlaces.current[0];
      const map = new maplibregl.Map({
        attributionControl: false,
        center: first ? [first.longitude, first.latitude] : fallbackCenter,
        container: element,
        cooperativeGestures: true,
        maxZoom: 20,
        minZoom: 2,
        style: createMapStyle(),
        zoom: 11.5,
      });
      mapRef.current = map;
      map.on('load', () => {
        setReady(true);
        map.resize();
      });
      map.on('dragstart', () => {
        if (inventoryTimer) clearTimeout(inventoryTimer);
        userMovedMap.current = true;
      });
      map.on('zoomstart', (event) => {
        if (event.originalEvent) {
          if (inventoryTimer) clearTimeout(inventoryTimer);
          userMovedMap.current = true;
        }
      });
      map.on('moveend', () => {
        setMapZoom(map.getZoom());
        if (userMovedMap.current) {
          const viewport = viewportFromMap(map);
          if (onSearchAreaRef.current) setPendingViewport(viewport);
          if (onViewportChangeRef.current && viewportIsLiveInventoryEligible(viewport.bounds)) {
            if (inventoryTimer) clearTimeout(inventoryTimer);
            inventoryTimer = setTimeout(() => {
              void onViewportChangeRef.current?.(viewport);
            }, 220);
          }
        }
        userMovedMap.current = false;
      });
      map.on('error', (event) => {
        if (!event.error?.message?.includes('tile')) setFailed(true);
      });
    } catch {
      failureTimer = setTimeout(() => setFailed(true), 0);
    }

    return () => {
      if (failureTimer) clearTimeout(failureTimer);
      if (inventoryTimer) clearTimeout(inventoryTimer);
      markers.forEach(({ marker }) => marker.remove());
      userMarkerRef.current?.remove();
      mapRef.current?.remove();
      markers.clear();
      userMarkerRef.current = null;
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    currentPlaces.current = new Map(places.map((place) => [place.id, place]));
    const features = renderedInventoryFeatures.length ? [] : clusterPlaces(places, mapZoom);
    const renderedIds = renderedInventoryFeatures.length
      ? renderedInventoryFeatures.map((feature) => feature.id)
      : features.map((feature) => feature.id);
    const nextIds = new Set(renderedIds);
    markerRefs.current.forEach(({ marker }, id) => {
      if (!nextIds.has(id)) {
        marker.remove();
        markerRefs.current.delete(id);
      }
    });
    for (const inventoryFeature of renderedInventoryFeatures) {
      const signature = inventoryFeature.type === 'cluster'
        ? `cluster:${inventoryFeature.count}:${inventoryFeature.dominantCategory}`
        : `place:${inventoryFeature.businessId ?? ''}:${inventoryFeature.name ?? ''}:${inventoryFeature.logoUrl ?? ''}`;
      const existing = markerRefs.current.get(inventoryFeature.id);
      if (existing?.signature === signature) {
        existing.marker.setLngLat([inventoryFeature.longitude, inventoryFeature.latitude]);
        continue;
      }
      if (existing) {
        existing.marker.remove();
        markerRefs.current.delete(inventoryFeature.id);
      }
      const loadedPlace = inventoryFeature.businessId
        ? currentPlaces.current.get(inventoryFeature.businessId)
        : undefined;
      const element = inventoryFeature.type === 'cluster'
        ? clusterElement(inventoryFeature)
        : markerElement(
            loadedPlace ?? {
              name: inventoryFeature.name ?? categoryLabels[inventoryFeature.dominantCategory],
              category: inventoryFeature.dominantCategory,
              categoryLabel: categoryLabels[inventoryFeature.dominantCategory],
              distanceMiles: null,
              logoUrl: inventoryFeature.logoUrl ?? '',
            },
            inventoryFeature.businessId === selectedId
          );
      element.addEventListener('click', () => {
        if (inventoryFeature.type === 'cluster') {
          userMovedMap.current = true;
          map.easeTo({
            center: [inventoryFeature.longitude, inventoryFeature.latitude],
            duration: motionDuration(reduceMotion, 380),
            zoom: Math.min(18, map.getZoom() + 2),
          });
          return;
        }
        const selectedPlace = inventoryFeature.businessId
          ? currentPlaces.current.get(inventoryFeature.businessId)
          : undefined;
        if (selectedPlace) onSelectRef.current?.(selectedPlace);
        else if (inventoryFeature.businessId) onSelectBusinessIdRef.current?.(inventoryFeature.businessId);
      });
      const marker = new maplibregl.Marker({ anchor: 'bottom', element })
        .setLngLat([inventoryFeature.longitude, inventoryFeature.latitude])
        .addTo(map);
      markerRefs.current.set(inventoryFeature.id, {
        marker,
        element,
        businessId: inventoryFeature.businessId,
        signature,
      });
    }

    for (const feature of features) {
      const existing = markerRefs.current.get(feature.id);
      if (existing) {
        existing.marker.setLngLat([feature.longitude, feature.latitude]);
        continue;
      }
      const element = feature.kind === 'cluster'
        ? clusterElement(feature)
        : markerElement(feature.place, false);
      element.addEventListener('click', () => {
        if (feature.kind === 'cluster') {
          userMovedMap.current = true;
          map.easeTo({
            center: [feature.longitude, feature.latitude],
            duration: motionDuration(reduceMotion, 380),
            zoom: Math.min(18, map.getZoom() + 2),
          });
          return;
        }
        const selectedPlace = currentPlaces.current.get(feature.place.id);
        if (selectedPlace) onSelectRef.current?.(selectedPlace);
      });
      const marker = new maplibregl.Marker({ anchor: 'bottom', element })
        .setLngLat([feature.longitude, feature.latitude])
        .addTo(map);
      markerRefs.current.set(feature.id, {
        marker,
        element,
        businessId: feature.kind === 'place' ? feature.place.id : undefined,
      });
    }

    const placesKey = places
      .map((place) => `${place.id}:${place.latitude}:${place.longitude}`)
      .join('|');
    if (placesKey !== fittedPlacesKey.current) {
      fittedPlacesKey.current = placesKey;
      if (places.length === 1) {
        map.easeTo({
          center: [places[0].longitude, places[0].latitude],
          duration: motionDuration(reduceMotion, 450),
          zoom: 13,
        });
      } else if (places.length > 1) {
        const bounds = new LngLatBounds();
        places.forEach((place) => bounds.extend([place.longitude, place.latitude]));
        map.fitBounds(bounds, { duration: motionDuration(reduceMotion, 450), maxZoom: 14, padding: 70 });
      }
    }
  }, [mapZoom, places, ready, reduceMotion, renderedInventoryFeatures, selectedId]);

  useEffect(() => {
    const map = mapRef.current;
    const selected = places.find((place) => place.id === selectedId);
    markerRefs.current.forEach(({ element, businessId }) => {
      if (businessId) updateMarkerSelection(element, businessId === selectedId);
    });
    if (!map || !selected || !ready) return;
    map.easeTo({
      center: [selected.longitude, selected.latitude],
      duration: motionDuration(reduceMotion, 380),
      zoom: Math.max(map.getZoom(), 13),
    });
  }, [places, ready, reduceMotion, selectedId]);

  useEffect(() => {
    const map = mapRef.current;
    userMarkerRef.current?.remove();
    userMarkerRef.current = null;
    if (!map || !userCoordinates || !ready) return;

    const dot = document.createElement('div');
    dot.setAttribute('aria-label', 'Your approximate current location');
    dot.style.background = '#2166D3';
    dot.style.border = '4px solid #FFFFFF';
    dot.style.borderRadius = '999px';
    dot.style.boxShadow = '0 0 0 8px rgba(33, 102, 211, 0.18)';
    dot.style.height = '18px';
    dot.style.width = '18px';
    userMarkerRef.current = new maplibregl.Marker({ element: dot })
      .setLngLat([userCoordinates.longitude, userCoordinates.latitude])
      .addTo(map);
  }, [ready, userCoordinates]);

  if (failed) {
    return (
      <View accessibilityRole="alert" style={styles.fallback}>
        <FontAwesome6 color={palette.accentDeep} name="map-location-dot" size={22} />
        <Text style={styles.fallbackTitle}>The map is temporarily unavailable.</Text>
        <Text style={styles.fallbackBody}>Use the verified list to browse every result and open directions.</Text>
      </View>
    );
  }

  return (
    <View style={styles.frame}>
      <View
        accessibilityLabel="Interactive map of nearby food"
        ref={containerRef}
        style={styles.map}
      />
      <View style={styles.controls}>
        <Pressable
          accessibilityLabel="Zoom in"
          accessibilityRole="button"
          onPress={() => {
            userMovedMap.current = true;
            mapRef.current?.zoomIn({ duration: motionDuration(reduceMotion, 180) });
          }}
          style={styles.controlButton}>
          <FontAwesome6 color={palette.ink} name="plus" size={13} />
        </Pressable>
        <Pressable
          accessibilityLabel="Zoom out"
          accessibilityRole="button"
          onPress={() => {
            userMovedMap.current = true;
            mapRef.current?.zoomOut({ duration: motionDuration(reduceMotion, 180) });
          }}
          style={styles.controlButton}>
          <FontAwesome6 color={palette.ink} name="minus" size={13} />
        </Pressable>
      </View>
      {pendingViewport && onSearchArea ? (
        <Pressable
          accessibilityLabel="Search the visible map area"
          accessibilityRole="button"
          onPress={() => {
            const viewport = pendingViewport;
            setPendingViewport(null);
            void onSearchArea(viewport);
          }}
          style={styles.searchAreaButton}>
          <FontAwesome6 color="#FFFFFF" name="magnifying-glass-location" size={12} />
          <Text style={styles.searchAreaText}>Search this area</Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="link"
        onPress={() => void Linking.openURL(mapAttributionUrl)}
        style={styles.attribution}>
        <Text style={styles.attributionText}>{mapAttribution}</Text>
      </Pressable>
      {!ready ? (
        <View accessibilityLiveRegion="polite" style={styles.loading}>
          <Text style={styles.loadingText}>Loading map…</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    borderColor: palette.line,
    borderRadius: radii.xl,
    borderWidth: 1,
    height: 470,
    overflow: 'hidden',
    position: 'relative',
    width: '100%',
  },
  map: {
    backgroundColor: '#E9EAE3',
    height: '100%',
    width: '100%',
  },
  controls: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
    position: 'absolute',
    right: 14,
    top: 14,
  },
  searchAreaButton: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: palette.ink,
    borderColor: 'rgba(255, 255, 255, 0.9)',
    borderRadius: radii.pill,
    borderWidth: 2,
    flexDirection: 'row',
    gap: 8,
    minHeight: 46,
    paddingHorizontal: 17,
    position: 'absolute',
    top: 14,
  },
  searchAreaText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '900',
  },
  controlButton: {
    alignItems: 'center',
    borderBottomColor: palette.line,
    borderBottomWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  attribution: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 253, 248, 0.92)',
    borderTopRightRadius: 8,
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    minHeight: 44,
    paddingHorizontal: 7,
    position: 'absolute',
  },
  attributionText: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: '700',
  },
  loading: {
    alignItems: 'center',
    backgroundColor: 'rgba(246, 243, 236, 0.88)',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  loadingText: {
    color: palette.muted,
    fontSize: 12,
    fontWeight: '800',
  },
  fallback: {
    alignItems: 'center',
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.xl,
    borderWidth: 1,
    gap: 8,
    height: 470,
    justifyContent: 'center',
    padding: 28,
  },
  fallbackTitle: {
    color: palette.ink,
    fontSize: 17,
    fontWeight: '900',
    textAlign: 'center',
  },
  fallbackBody: {
    color: palette.muted,
    fontSize: 12,
    lineHeight: 18,
    maxWidth: 360,
    textAlign: 'center',
  },
});
