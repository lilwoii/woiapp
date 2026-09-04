# Spottr map platform

Updated 2026-08-30. Provider prices and terms must be rechecked before a paid
commitment or production activation.

## Launch decision

Use a modular stack so the visual map, global tiles, food inventory, and routes
can scale independently:

- MapLibre renders the branded web map. Native launch builds intentionally use
  the Apple/Google `react-native-maps` bridge so they inherit platform-grade
  buildings, road detail, traffic, accessibility, and camera behavior while
  Spottr supplies the category markers, clusters, live-stop state, route
  overlays, and controls. A later MapLibre Native migration is an optional
  branding/cost optimization, not a launch dependency, and must earn its own
  signed-device acceptance before replacing the native renderers.
- Stadia Maps Starter is the risk-adjusted MapLibre launch choice, not a claim
  that it has the lowest possible bill. Its current commercial
  plan starts at $20/month, includes one million credits, supports MapLibre and
  OpenMapTiles, and exposes building height fields for 3D extrusion where the
  source data contains them. The chosen style must also include an enabled
  `fill-extrusion` layer; height fields alone do not make a visible 3D map.
- Keep the existing server-only Mapbox Directions adapter for walking, cycling,
  and traffic-aware driving routes. The current public pricing includes 100,000
  Directions requests per month before usage charges.
- Keep explicit Apple Maps and Google Maps handoff. Those links are a user
  choice and do not replace Spottr's in-app route consent or provider notice.

This is a launch-cost estimate, not a guaranteed bill. Confirm the final style,
tile mix, monthly credits, route volume, overages, tax, SLA, data processing
terms, and territorial coverage with each provider before activation.
Stadia Starter search output is temporary and is not a persistent restaurant
catalog. Overture Places is the planned durable inventory seed, subject to the
quality, provenance, refresh, and attribution controls in
[GLOBAL_DIRECTORY.md](GLOBAL_DIRECTORY.md).

Primary provider references:

- [Stadia Maps pricing](https://stadiamaps.com/pricing/)
- [Stadia Maps attribution](https://docs.stadiamaps.com/attribution/)
- [Stadia 3D buildings with MapLibre](https://docs.stadiamaps.com/tutorials/adding-3d-buildings-to-your-maps-with-maplibre/)
- [Mapbox pricing](https://www.mapbox.com/pricing)
- [Mapbox Directions API](https://docs.mapbox.com/api/navigation/directions/)
- [Google Maps URLs](https://developers.google.com/maps/documentation/urls/get-started)
- [Apple Map Links](https://developer.apple.com/library/archive/featuredarticles/iPhoneURLScheme_Reference/MapLinks/MapLinks.html)

## Product contract

A detailed basemap is not Spottr's discovery advantage by itself. The product
combines licensed food-place coverage with owner-authoritative hours, menus,
payment and pickup signals, mobile stops, short live updates, first-party
reviews, and category-distinct markers. Search relevance favors exact business,
cuisine, and available public menu matches while preserving explicit filters;
it never fabricates fields that a licensed source or verified owner did not
provide. See [GLOBAL_DIRECTORY.md](GLOBAL_DIRECTORY.md) for inventory provenance
and refresh controls.

The map may promise:

- licensed vector streets, labels, road hierarchy, and building extrusion where
  data exists;
- category-distinct Spottr markers, bounded clustering, and fast viewport loads;
- foreground user movement, walking/driving/biking routes, route steps, distance,
  and provider-calculated ETA;
- traffic-aware driving ETA when the enabled route provider returns it;
- owner-declared food-truck movement toward an approved next public stop, never
  covert continuous truck tracking;
- a provider-independent fallback to Apple Maps or Google Maps.

It must not promise Apple/Google photogrammetry parity, universal trees or street
furniture, exact indoor entrances, or perfect real-time traffic. Coverage follows
licensed source data and must be measured by region.

## Security, privacy, and reliability

- Production must fail closed without a licensed HTTPS style URL, exact CSP
  origins, required attribution, restricted platform keys, quotas, and alerts.
- Basemap keys are separate per environment and platform. Referrer/bundle/package
  restrictions and provider quota limits are mandatory. Route credentials remain
  server-only and rotate independently.
- Precise customer location is used in the foreground. It is not written to a
  customer profile. Re-routing requires a separate opt-in and rate limit.
- The public OpenStreetMap community tile servers are development fallback only.
  They are not a free production CDN or an offline-pack source. See the
  [OSMF raster tile policy](https://operations.osmfoundation.org/policies/tiles/)
  and [vector tile policy](https://operations.osmfoundation.org/policies/vector/).
- Route and tile providers need billing alarms, latency/error SLOs, a kill switch,
  capacity tests, regional acceptance, and a tested handoff fallback before their
  feature gates can be enabled.

## Scale path

At higher traffic, publish dated, licensed OSM-derived vector builds to Spottr's
own object storage/CDN using Protomaps PMTiles or OpenMapTiles. Keep a commercial
route provider for traffic because open basemap data does not supply live traffic.
The renderer and public style URL remain stable while tile origins change.

Relevant references:

- [Protomaps basemap downloads and licensing](https://docs.protomaps.com/basemaps/downloads)
- [Protomaps deployment](https://docs.protomaps.com/deploy/)
- [OpenMapTiles licensing](https://openmaptiles.org/about/)
- [OpenStreetMap copyright and ODbL](https://www.openstreetmap.org/copyright)

## 3D data boundary

Spottr can extrude licensed OSM/Overture/municipal building footprints and can
commission its own capture for selected landmarks with documented property,
privacy, airspace, and asset rights. It must never scan, screenshot, trace, or
copy Apple/Google imagery, meshes, footprints, or 3D models. Google expressly
restricts tracing and creating 3D building models from its imagery; Apple bars
bulk extraction and derivative mapping databases.

- [Google Maps Platform Terms](https://cloud.google.com/maps-platform/terms)
- [Apple Xcode and SDK Agreement](https://www.apple.com/legal/sla/docs/xcode.pdf)

No native renderer replacement, provider key, route gate, or offline download
is activated until its signed-device, legal, attribution, privacy, load, cost,
and rollback evidence is attached to the release record.
