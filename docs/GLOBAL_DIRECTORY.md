# Global food directory

Spottr's launch inventory must come from sources that expressly permit the
required storage, transformation, display, refresh, correction, and deletion.
The app must never scrape or persist Google Maps, Yelp, DoorDash, or Facebook
Marketplace content.

## Coverage strategy

1. Use Overture Maps Places as the open global baseline. Import only food and
   drink categories, preserve record-level source and license metadata, and
   synchronize by published release rather than copying records into source
   control.
2. Add a contracted commercial provider, such as Foursquare Places, only after
   legal approval of the exact fields, territories, retention, media rights,
   attribution, and deletion requirements.
3. Merge duplicates by provider identity first and conservative geographic,
   name, phone, and domain evidence second. Ambiguous candidates go to review;
   they are never silently merged.
4. Let verified owners claim an existing record. Owner-authored profile,
   location, hours, payments, menu, status, and media always take precedence
   over provider refreshes.
5. Let communities submit missing trucks, pop-ups, stands, and restaurants.
   Publication is moderated and provenance remains visible.

“Neighborhood Kitchens” use a separate jurisdiction and permit workflow. They
are never imported from a general places provider, and public map coordinates
remain approximate.

## Production data flow

```text
Overture release / licensed vendor
  -> isolated ETL and category mapping
  -> schema and license validation
  -> signed, idempotent provider batches
  -> private source history + precedence rules
  -> reviewed public materialization
  -> server-clustered viewport RPC
  -> Spottr web / iOS / Android map
```

The viewport RPC is installed by
`20260803000000_global_map_viewport.sql`. Below street zoom it returns bounded
clusters with per-category counts; at street zoom it returns public place
features. It supports antimeridian viewports, prioritizes food trucks in stable
ordering, and applies the same home-kitchen coordinate redaction as public
listing views.

The checked-in extractor stages the full `food_and_drink` taxonomy branch from
an explicitly reviewed Overture release. It uses the new taxonomy hierarchy
rather than the deprecated legacy category field and preserves the GERS ID,
release, confidence, source metadata, and available contact/address fields:

```powershell
npm run inventory:overture:extract -- `
  --release 2026-07-22.0 `
  --output .private-data/overture-food-2026-07-22.parquet `
  --min-confidence 0.65
```

The output is private staging data, not automatically public. It still passes
license review, country/address normalization, duplicate review, source-field
validation, signed batch ingestion, and materialization. The release is never
silently selected as “latest”; an operator must review and name it.

## Launch controls

- No dataset is enabled until its source account, license dates, allowed field
  classes, signing keys, rate limits, stale windows, and kill switch are set.
- Unknown hours, payments, prices, menus, and ownership remain unknown. The ETL
  must never invent them.
- Provider images require explicit media rights plus the quarantine, scanning,
  metadata stripping, re-encoding, moderation, attribution, and deletion path.
- Snapshot completion, stale-source reconciliation, correction intake, owner
  claims, and provider offboarding are monitored and drilled before launch.
- Global coverage is measured by country/category freshness dashboards. No
  product claim may promise literally every restaurant.
