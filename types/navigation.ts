export type TravelMode = 'drive' | 'walk' | 'bike';

export type NavigationCoordinate = {
  latitude: number;
  longitude: number;
};

export type RouteStep = {
  instruction: string;
  distanceMeters: number;
  durationSeconds: number;
  maneuver: NavigationCoordinate;
};

export type RoutePlan = {
  provider: 'mapbox';
  mode: TravelMode;
  distanceMeters: number;
  durationSeconds: number;
  coordinates: NavigationCoordinate[];
  steps: RouteStep[];
  attribution: string;
  attributionUrl: string;
  generatedAt: string;
  expiresAt: string;
};
