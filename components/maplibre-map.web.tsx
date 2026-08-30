import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import maplibregl, { GeoJSONSource, LngLatBounds, Map as MapLibreMap, Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { palette, radii } from '@/constants/theme';
import {
  clusterInventoryFeatures,
  clusterPlacesWithSelection,
  normalizeLongitude,
  shouldRenderMapInventory,
  viewportIsLiveInventoryEligible,
} from '@/lib/map-clustering';
import { boundsForMapCoordinates } from '@/lib/map-camera';
import {
  categoryMarkerLabel,
  mapCategoryPresentation,
  mapClusterCategorySignature,
  mapClusterCategorySummary,
  mapPlaceMarkerSignature,
} from '@/lib/map-presentation';
import { motionDuration } from '@/lib/motion';
import type { MapInventoryFeature, MapViewport } from '@/types/map';
import type { NavigationCoordinate, TravelMode } from '@/types/navigation';
import { MOVING_TO_NEXT_LOCATION_LABEL, Place } from '@/types/marketplace';

export type Props = {
  places: Place[];
  selectedId?: string;
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

const fallbackCenter: [number, number] = [0, 20];
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
  selected: boolean,
  moving = false,
) {
  const presentation = mapCategoryPresentation[place.category];
  const element = document.createElement('button');
  element.type = 'button';
  element.tabIndex = 0;
  element.setAttribute(
    'aria-label',
    `${categoryMarkerLabel(place.category, place.name)}${moving ? `, ${MOVING_TO_NEXT_LOCATION_LABEL}. Scheduled next-stop destination; not a live vehicle position` : ''}${
      place.distanceMiles !== null ? `, ${place.distanceMiles.toFixed(1)} miles away` : ''
    }`
  );
  element.dataset.category = place.category;
  element.dataset.markerShape = presentation.shape;
  element.dataset.mobilityState = moving ? 'moving_to_next_location' : '';
  element.style.alignItems = 'center';
  element.style.background = moving ? palette.warningSoft : '#FFFFFF';
  element.style.border = `3px solid ${selected ? palette.accentDeep : moving ? palette.warning : '#FFFFFF'}`;
  element.style.borderRadius = {
    capsule: '15px',
    circle: '999px',
    market: '11px',
    cup: '18px 18px 9px 9px',
    home: '9px 9px 16px 16px',
  }[presentation.shape];
  element.style.boxShadow = selected
    ? '0 10px 26px rgba(23, 44, 42, 0.34)'
    : moving
      ? '0 7px 20px rgba(182, 122, 42, 0.38)'
      : '0 6px 18px rgba(23, 44, 42, 0.24)';
  element.style.cursor = 'pointer';
  element.style.display = 'flex';
  element.style.height = '46px';
  element.style.justifyContent = 'center';
  element.style.padding = '0';
  element.style.transform = selected ? 'translateY(-3px) scale(1.1)' : 'none';
  element.style.transition = 'transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease';
  element.style.width = presentation.shape === 'capsule' ? '56px' : '46px';

  const appendFallbackSymbol = () => {
    const symbol = document.createElement('span');
    symbol.setAttribute('aria-hidden', 'true');
    symbol.textContent = presentation.badge;
    symbol.style.color = palette.ink;
    symbol.style.fontFamily = 'system-ui, sans-serif';
    symbol.style.fontSize = presentation.badge.length > 2 ? '10px' : '14px';
    symbol.style.fontWeight = '900';
    element.appendChild(symbol);
  };

  if (place.logoUrl) {
    const image = document.createElement('img');
    image.alt = '';
    image.src = place.logoUrl;
    image.style.borderRadius = presentation.shape === 'circle' ? '999px' : '8px';
    image.style.height = '36px';
    image.style.objectFit = 'cover';
    image.style.width = presentation.shape === 'capsule' ? '46px' : '36px';
    image.addEventListener('error', () => {
      image.remove();
      appendFallbackSymbol();
    }, { once: true });
    element.appendChild(image);
  } else {
    appendFallbackSymbol();
  }

  const badge = document.createElement('span');
  badge.setAttribute('aria-hidden', 'true');
  badge.textContent = presentation.badge;
  badge.style.alignItems = 'center';
  badge.style.background = place.category === 'food_truck' ? palette.dark : palette.ink;
  badge.style.border = '2px solid #FFFFFF';
  badge.style.borderRadius = presentation.shape === 'market' ? '5px' : '999px';
  badge.style.bottom = '-7px';
  badge.style.color = '#FFFFFF';
  badge.style.display = 'flex';
  badge.style.fontFamily = 'system-ui, sans-serif';
  badge.style.fontSize = presentation.badge.length > 2 ? '7px' : '8px';
  badge.style.fontWeight = '900';
  badge.style.height = '21px';
  badge.style.justifyContent = 'center';
  badge.style.letterSpacing = '-0.2px';
  badge.style.minWidth = '21px';
  badge.style.padding = '0 3px';
  badge.style.position = 'absolute';
  badge.style.right = '-7px';
  element.appendChild(badge);

  if (moving) {
    const movingBadge = document.createElement('span');
    movingBadge.setAttribute('aria-hidden', 'true');
    movingBadge.textContent = 'NEXT';
    movingBadge.style.background = palette.warning;
    movingBadge.style.border = '2px solid #FFFFFF';
    movingBadge.style.borderRadius = '999px';
    movingBadge.style.bottom = '-7px';
    movingBadge.style.color = '#FFFFFF';
    movingBadge.style.fontFamily = 'system-ui, sans-serif';
    movingBadge.style.fontSize = '7px';
    movingBadge.style.fontWeight = '900';
    movingBadge.style.left = '-11px';
    movingBadge.style.letterSpacing = '0.2px';
    movingBadge.style.padding = '4px 6px';
    movingBadge.style.position = 'absolute';
    element.appendChild(movingBadge);
  }

  return element;
}

function updateMarkerSelection(element: HTMLButtonElement, selected: boolean) {
  const moving = element.dataset.mobilityState === 'moving_to_next_location';
  element.style.borderColor = selected ? palette.accentDeep : moving ? palette.warning : '#FFFFFF';
  element.style.boxShadow = selected
    ? '0 10px 26px rgba(23, 44, 42, 0.34)'
    : moving
      ? '0 7px 20px rgba(182, 122, 42, 0.38)'
      : '0 6px 18px rgba(23, 44, 42, 0.24)';
  element.style.transform = selected ? 'translateY(-3px) scale(1.1)' : 'none';
}

function clusterElement(feature: { count: number; categories: Partial<Record<Place['category'], number>> }) {
  const summary = mapClusterCategorySummary(feature.categories);
  const element = document.createElement('button');
  element.type = 'button';
  element.tabIndex = 0;
  element.setAttribute('aria-label', `${feature.count} food places in this area. ${summary.accessibilityLabel}. Zoom in to explore.`);
  element.style.alignItems = 'center';
  element.style.background = palette.accentDeep;
  element.style.border = '4px solid rgba(255, 255, 255, 0.94)';
  element.style.borderRadius = '999px';
  element.style.boxShadow = '0 7px 22px rgba(23, 44, 42, 0.28)';
  element.style.color = '#FFFFFF';
  element.style.cursor = 'pointer';
  element.style.display = 'flex';
  element.style.flexDirection = 'column';
  element.style.fontFamily = 'system-ui, sans-serif';
  element.style.fontSize = feature.count > 99 ? '12px' : '13px';
  element.style.fontWeight = '900';
  element.style.height = '56px';
  element.style.justifyContent = 'center';
  element.style.width = '56px';
  const count = document.createElement('span');
  count.textContent = feature.count > 999 ? '999+' : String(feature.count);
  element.appendChild(count);
  const kinds = document.createElement('span');
  kinds.setAttribute('aria-hidden', 'true');
  kinds.textContent = summary.badges.join(' · ');
  kinds.style.color = 'rgba(255,255,255,0.82)';
  kinds.style.fontSize = '8px';
  kinds.style.letterSpacing = '-0.2px';
  kinds.style.marginTop = '1px';
  element.appendChild(kinds);
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
  onViewportInvalidated,
  onRetryInventory,
  inventoryFeatures,
  inventoryError = null,
  markersSuppressed = false,
  searchAreaKey,
  userCoordinates,
  routeCoordinates = [],
  navigationMode,
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
  const onViewportInvalidatedRef = useRef(onViewportInvalidated);
  const fittedPlacesKey = useRef('');
  const userMarkerRef = useRef<Marker | null>(null);
  const fittedRouteKey = useRef('');
  const initialPlaces = useRef(places);
  const mapWasInteracted = useRef(false);
  const hasCenteredOnUser = useRef(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [perspective, setPerspective] = useState(false);
  const [supports3D, setSupports3D] = useState(false);
  const [mapZoom, setMapZoom] = useState(11.5);
  const [pendingViewport, setPendingViewport] = useState<MapViewport | null>(null);
  const [inventoryViewportEligible, setInventoryViewportEligible] = useState(true);
  const userMovedMap = useRef(false);
  const authoritativeInventory = inventoryFeatures !== undefined;
  const renderedInventoryFeatures = useMemo(
    () => clusterInventoryFeatures(inventoryFeatures ?? [], mapZoom),
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
    onViewportInvalidatedRef.current = onViewportInvalidated;
  }, [onViewportInvalidated]);

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
        maxPitch: 60,
        maxZoom: 20,
        minZoom: 2,
        pitchWithRotate: true,
        style: createMapStyle(),
        zoom: first ? 11.5 : 2.35,
      });
      mapRef.current = map;
      map.on('load', () => {
        setSupports3D(Boolean(map.getStyle().layers?.some((layer) => layer.type === 'fill-extrusion')));
        setReady(true);
        map.resize();
      });
      map.on('dragstart', () => {
        if (inventoryTimer) clearTimeout(inventoryTimer);
        mapWasInteracted.current = true;
        userMovedMap.current = true;
      });
      map.on('zoomstart', (event) => {
        if (event.originalEvent) {
          if (inventoryTimer) clearTimeout(inventoryTimer);
          mapWasInteracted.current = true;
          userMovedMap.current = true;
        }
      });
      map.on('moveend', () => {
        setMapZoom(map.getZoom());
        if (userMovedMap.current) {
          const viewport = viewportFromMap(map);
          const eligible = viewportIsLiveInventoryEligible(viewport.bounds);
          setPendingViewport(eligible && onSearchAreaRef.current ? viewport : null);
          setInventoryViewportEligible(eligible);
          onViewportInvalidatedRef.current?.(viewport);
          if (!eligible) {
            if (inventoryTimer) clearTimeout(inventoryTimer);
          } else if (onViewportChangeRef.current) {
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
    const markersVisible = shouldRenderMapInventory({
      viewportEligible: inventoryViewportEligible,
      inventorySuppressed: markersSuppressed,
    });
    const visibleInventoryFeatures = markersVisible ? renderedInventoryFeatures : [];
    const features = markersVisible && !authoritativeInventory
      ? clusterPlacesWithSelection(places, mapZoom, selectedId, 300)
      : [];
    const renderedIds = visibleInventoryFeatures.length
      ? visibleInventoryFeatures.map((feature) => feature.id)
      : features.map((feature) => feature.id);
    const nextIds = new Set(renderedIds);
    markerRefs.current.forEach(({ marker }, id) => {
      if (!nextIds.has(id)) {
        marker.remove();
        markerRefs.current.delete(id);
      }
    });
    for (const inventoryFeature of visibleInventoryFeatures) {
      const signature = inventoryFeature.type === 'cluster'
        ? `cluster:${inventoryFeature.count}:${inventoryFeature.dominantCategory}:${mapClusterCategorySignature(inventoryFeature.categoryCounts)}`
        : `place:${inventoryFeature.businessId ?? ''}:${inventoryFeature.name ?? ''}:${inventoryFeature.logoUrl ?? ''}:${inventoryFeature.mobilityState ?? ''}`;
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
        ? clusterElement({ count: inventoryFeature.count, categories: inventoryFeature.categoryCounts })
        : markerElement(
            loadedPlace ?? {
              name: inventoryFeature.name ?? categoryLabels[inventoryFeature.dominantCategory],
              category: inventoryFeature.dominantCategory,
              categoryLabel: categoryLabels[inventoryFeature.dominantCategory],
              distanceMiles: null,
              logoUrl: inventoryFeature.logoUrl ?? '',
            },
            inventoryFeature.businessId === selectedId,
            inventoryFeature.mobilityState === 'moving_to_next_location',
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
        if (selectedPlace && (!inventoryFeature.locationId || selectedPlace.locationId === inventoryFeature.locationId)) {
          onSelectRef.current?.(selectedPlace);
        } else if (inventoryFeature.businessId) {
          onSelectBusinessIdRef.current?.(inventoryFeature.businessId, inventoryFeature.locationId);
        }
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
      const signature = feature.kind === 'cluster'
        ? `client-cluster:${feature.count}:${mapClusterCategorySignature(feature.categories)}`
        : `client-place:${mapPlaceMarkerSignature(feature.place)}`;
      const existing = markerRefs.current.get(feature.id);
      if (existing?.signature === signature) {
        existing.marker.setLngLat([feature.longitude, feature.latitude]);
        continue;
      }
      if (existing) {
        existing.marker.remove();
        markerRefs.current.delete(feature.id);
      }
      const element = feature.kind === 'cluster'
        ? clusterElement({ count: feature.count, categories: feature.categories })
        : markerElement(feature.place, false, Boolean(feature.place.mobility));
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
        signature,
      });
    }

    const fitRequestKey = searchAreaKey || (!mapWasInteracted.current ? 'initial-results' : '');
    if (fitRequestKey && fitRequestKey !== fittedPlacesKey.current && places.length) {
      fittedPlacesKey.current = fitRequestKey;
      if (places.length === 1) {
        map.easeTo({
          center: [places[0].longitude, places[0].latitude],
          duration: motionDuration(reduceMotion, 450),
          zoom: 13,
        });
      } else if (places.length > 1) {
        const fitBounds = boundsForMapCoordinates(places, {
          latitude: fallbackCenter[1],
          longitude: fallbackCenter[0],
          latitudeDelta: 0.18,
          longitudeDelta: 0.17,
        });
        const bounds = new LngLatBounds(
          [fitBounds.west, fitBounds.south],
          [fitBounds.east, fitBounds.north],
        );
        map.fitBounds(bounds, { duration: motionDuration(reduceMotion, 450), maxZoom: 14, padding: 70 });
      }
    }
  }, [authoritativeInventory, inventoryViewportEligible, mapZoom, markersSuppressed, places, ready, reduceMotion, renderedInventoryFeatures, searchAreaKey, selectedId]);

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
    dot.setAttribute('aria-label', navigationMode ? `Your live ${navigationMode} position` : 'Your approximate current location');
    dot.setAttribute('role', 'img');
    const navigationIcon = navigationMode === 'drive'
      ? 'car-side'
      : navigationMode === 'walk'
        ? 'person-walking'
        : navigationMode === 'bike'
          ? 'bicycle'
          : null;
    const navigationGlyphMap = navigationIcon
      ? FontAwesome6.getRawGlyphMap?.('solid') as Record<string, number> | undefined
      : undefined;
    const navigationCodePoint = navigationIcon ? navigationGlyphMap?.[navigationIcon] : undefined;
    const navigationFontFamily = navigationIcon ? FontAwesome6.getFontFamily?.('solid') : undefined;
    const hasNavigationGlyph =
      Number.isInteger(navigationCodePoint) &&
      typeof navigationFontFamily === 'string' &&
      navigationFontFamily.length > 0;
    dot.textContent = hasNavigationGlyph
      ? String.fromCodePoint(navigationCodePoint as number)
      : '';
    dot.style.alignItems = 'center';
    dot.style.background = '#2166D3';
    dot.style.border = '4px solid #FFFFFF';
    dot.style.borderRadius = '999px';
    dot.style.boxShadow = '0 0 0 8px rgba(33, 102, 211, 0.18)';
    dot.style.color = '#FFFFFF';
    dot.style.display = 'flex';
    dot.style.fontFamily = hasNavigationGlyph
      ? navigationFontFamily
      : 'system-ui, sans-serif';
    dot.style.fontSize = hasNavigationGlyph ? '15px' : '0';
    dot.style.fontWeight = '900';
    dot.style.height = navigationMode ? '34px' : '18px';
    dot.style.justifyContent = 'center';
    dot.style.width = navigationMode ? '34px' : '18px';
    userMarkerRef.current = new maplibregl.Marker({ element: dot })
      .setLngLat([userCoordinates.longitude, userCoordinates.latitude])
      .addTo(map);
    if (!hasCenteredOnUser.current && !initialPlaces.current.length && !mapWasInteracted.current) {
      hasCenteredOnUser.current = true;
      map.easeTo({
        center: [userCoordinates.longitude, userCoordinates.latitude],
        duration: motionDuration(reduceMotion, 380),
        zoom: Math.max(map.getZoom(), 13),
      });
    }
  }, [navigationMode, ready, reduceMotion, userCoordinates]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const routeSource = map.getSource('spottr-route') as GeoJSONSource | undefined;
    if (routeCoordinates.length < 2) {
      routeSource?.setData({ type: 'FeatureCollection', features: [] });
      fittedRouteKey.current = '';
      return;
    }
    const routeData: GeoJSON.Feature<GeoJSON.LineString> = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: routeCoordinates.map((point) => [point.longitude, point.latitude]),
      },
    };
    if (routeSource) routeSource.setData(routeData);
    else {
      map.addSource('spottr-route', { type: 'geojson', data: routeData });
      map.addLayer({
        id: 'spottr-route-casing', type: 'line', source: 'spottr-route',
        paint: { 'line-color': 'rgba(255,255,255,0.94)', 'line-width': 9, 'line-opacity': 0.96 },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
      map.addLayer({
        id: 'spottr-route-line', type: 'line', source: 'spottr-route',
        paint: { 'line-color': palette.accent, 'line-width': 5, 'line-opacity': 1 },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
    }
    const key = `${routeCoordinates[0].latitude}:${routeCoordinates[0].longitude}:${routeCoordinates.at(-1)?.latitude}:${routeCoordinates.at(-1)?.longitude}`;
    if (key === fittedRouteKey.current) return;
    fittedRouteKey.current = key;
    const routeBounds = boundsForMapCoordinates(routeCoordinates, {
      latitude: fallbackCenter[1],
      longitude: fallbackCenter[0],
      latitudeDelta: 0.18,
      longitudeDelta: 0.17,
    });
    const bounds = new LngLatBounds(
      [routeBounds.west, routeBounds.south],
      [routeBounds.east, routeBounds.north],
    );
    map.fitBounds(bounds, { duration: motionDuration(reduceMotion, 450), maxZoom: 17, padding: 84 });
  }, [ready, reduceMotion, routeCoordinates]);

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
            mapWasInteracted.current = true;
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
            mapWasInteracted.current = true;
            userMovedMap.current = true;
            mapRef.current?.zoomOut({ duration: motionDuration(reduceMotion, 180) });
          }}
          style={styles.controlButton}>
          <FontAwesome6 color={palette.ink} name="minus" size={13} />
        </Pressable>
        {supports3D ? (
          <Pressable
            accessibilityLabel={perspective ? 'Use flat map view' : 'Use 3D map perspective'}
            accessibilityRole="button"
            aria-pressed={perspective}
            onPress={() => {
              mapWasInteracted.current = true;
              const next = !perspective;
              setPerspective(next);
              mapRef.current?.easeTo({
                bearing: next ? -12 : 0,
                duration: motionDuration(reduceMotion, 320),
                pitch: next ? 48 : 0,
              });
            }}
            style={[styles.controlButton, perspective && styles.controlButtonActive]}>
            <FontAwesome6 color={perspective ? '#FFFFFF' : palette.ink} name="cube" size={12} />
            <Text style={[styles.controlText, perspective && styles.controlTextActive]}>3D</Text>
          </Pressable>
        ) : null}
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
      {ready && (!inventoryViewportEligible || markersSuppressed) ? (
        <View
          accessibilityLiveRegion="polite"
          accessibilityRole={inventoryError ? 'alert' : undefined}
          style={styles.inventoryStatus}>
          <Text style={styles.inventoryStatusText}>
            {!inventoryViewportEligible
              ? 'Zoom in to show place markers'
              : inventoryError
                ? 'Map places need a refresh'
                : 'Refreshing this map area…'}
          </Text>
          {inventoryViewportEligible && inventoryError && onRetryInventory ? (
            <Pressable
              accessibilityRole="button"
              onPress={onRetryInventory}
              style={styles.inventoryRetry}>
              <Text style={styles.inventoryRetryText}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
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
  inventoryStatus: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: 'rgba(255, 253, 248, 0.94)',
    borderColor: 'rgba(23, 44, 42, 0.12)',
    borderRadius: radii.pill,
    borderWidth: 1,
    bottom: 14,
    flexDirection: 'row',
    gap: 10,
    minHeight: 34,
    paddingHorizontal: 13,
    position: 'absolute',
    justifyContent: 'center',
  },
  inventoryStatusText: {
    color: palette.ink,
    fontSize: 10,
    fontWeight: '900',
  },
  inventoryRetry: {
    borderLeftColor: palette.line,
    borderLeftWidth: 1,
    minHeight: 26,
    paddingLeft: 10,
    justifyContent: 'center',
  },
  inventoryRetryText: {
    color: palette.accentDeep,
    fontSize: 10,
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
  controlButtonActive: {
    backgroundColor: palette.ink,
  },
  controlText: {
    color: palette.ink,
    fontSize: 8,
    fontWeight: '900',
    marginTop: 1,
  },
  controlTextActive: {
    color: '#FFFFFF',
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
