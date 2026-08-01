import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import maplibregl, { LngLatBounds, Map as MapLibreMap, Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { palette, radii } from '@/constants/theme';
import { Place } from '@/types/marketplace';

export type Props = {
  places: Place[];
  selectedId?: string;
  onSelect?: (place: Place) => void;
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

function markerElement(place: Place, selected: boolean) {
  const element = document.createElement('button');
  element.type = 'button';
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
    symbol.textContent = place.name.charAt(0).toLocaleUpperCase('en-US');
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

export default function MapLibreMapView({ places, selectedId, onSelect, userCoordinates }: Props) {
  const containerRef = useRef<View | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRefs = useRef(
    new Map<string, { marker: Marker; element: HTMLButtonElement }>()
  );
  const currentPlaces = useRef(new Map(places.map((place) => [place.id, place])));
  const onSelectRef = useRef(onSelect);
  const fittedPlacesKey = useRef('');
  const userMarkerRef = useRef<Marker | null>(null);
  const initialPlaces = useRef(places);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    const element = containerRef.current as unknown as HTMLElement | null;
    if (!element || mapRef.current) return;
    const markers = markerRefs.current;
    let failureTimer: ReturnType<typeof setTimeout> | null = null;

    try {
      const first = initialPlaces.current[0];
      const map = new maplibregl.Map({
        attributionControl: false,
        center: first ? [first.longitude, first.latitude] : fallbackCenter,
        container: element,
        cooperativeGestures: true,
        maxZoom: 18,
        minZoom: 2,
        style: createMapStyle(),
        zoom: 11.5,
      });
      mapRef.current = map;
      map.on('load', () => {
        setReady(true);
        map.resize();
      });
      map.on('error', (event) => {
        if (!event.error?.message?.includes('tile')) setFailed(true);
      });
    } catch {
      failureTimer = setTimeout(() => setFailed(true), 0);
    }

    return () => {
      if (failureTimer) clearTimeout(failureTimer);
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
    const nextIds = new Set(places.map((place) => place.id));
    markerRefs.current.forEach(({ marker }, id) => {
      if (!nextIds.has(id)) {
        marker.remove();
        markerRefs.current.delete(id);
      }
    });
    for (const place of places) {
      const existing = markerRefs.current.get(place.id);
      if (existing) {
        existing.marker.setLngLat([place.longitude, place.latitude]);
        existing.element.setAttribute(
          'aria-label',
          `${place.name}, ${place.categoryLabel}${
            place.distanceMiles !== null
              ? `, ${place.distanceMiles.toFixed(1)} miles away`
              : ''
          }`
        );
        continue;
      }
      const element = markerElement(place, false);
      element.addEventListener('click', () => {
        const selectedPlace = currentPlaces.current.get(place.id);
        if (selectedPlace) onSelectRef.current?.(selectedPlace);
      });
      const marker = new maplibregl.Marker({ anchor: 'bottom', element })
        .setLngLat([place.longitude, place.latitude])
        .addTo(map);
      markerRefs.current.set(place.id, { marker, element });
    }

    const placesKey = places
      .map((place) => `${place.id}:${place.latitude}:${place.longitude}`)
      .join('|');
    if (placesKey !== fittedPlacesKey.current) {
      fittedPlacesKey.current = placesKey;
      if (places.length === 1) {
        map.easeTo({
          center: [places[0].longitude, places[0].latitude],
          duration: 450,
          zoom: 13,
        });
      } else if (places.length > 1) {
        const bounds = new LngLatBounds();
        places.forEach((place) => bounds.extend([place.longitude, place.latitude]));
        map.fitBounds(bounds, { duration: 450, maxZoom: 14, padding: 70 });
      }
    }
  }, [places, ready]);

  useEffect(() => {
    const map = mapRef.current;
    const selected = places.find((place) => place.id === selectedId);
    markerRefs.current.forEach(({ element }, id) => {
      updateMarkerSelection(element, id === selectedId);
    });
    if (!map || !selected || !ready) return;
    map.easeTo({
      center: [selected.longitude, selected.latitude],
      duration: 380,
      zoom: Math.max(map.getZoom(), 13),
    });
  }, [places, ready, selectedId]);

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
          onPress={() => mapRef.current?.zoomIn({ duration: 180 })}
          style={styles.controlButton}>
          <FontAwesome6 color={palette.ink} name="plus" size={13} />
        </Pressable>
        <Pressable
          accessibilityLabel="Zoom out"
          accessibilityRole="button"
          onPress={() => mapRef.current?.zoomOut({ duration: 180 })}
          style={styles.controlButton}>
          <FontAwesome6 color={palette.ink} name="minus" size={13} />
        </Pressable>
      </View>
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
