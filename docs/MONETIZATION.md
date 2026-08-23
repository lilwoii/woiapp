# Spottr monetization architecture

Status: implementation plan, not evidence that billing is enabled or legally
approved. Policy notes were last checked on 2026-08-01 and must be revalidated
immediately before each mobile-store submission.

## Product promise

Spottr is free and useful for every consumer. Revenue must come from helping a
merchant earn or save money, not from degrading discovery, selling customer
location history, or hiding basic listing accuracy behind a paywall.

The non-negotiable rules are:

1. Basic listing, correct hours, current location, payment methods, menu,
   owner updates, reviews, follows, and organic discovery remain free.
2. Paid placement is a separate inventory lane. It never changes a business's
   organic Popular, Trending, rating, distance, or reliability score.
3. Every paid result is individually labelled **Sponsored ad** on cards, map
   previews, detail-entry surfaces, and shared links. Do not use `Promoted` as
   the only disclosure. The FTC says native ads must be identifiable and that
   `Promoted` can be ambiguous; it recommends direct terms such as `Ad` or
   `Sponsored Advertising Content` ([FTC native-ad guide](https://www.ftc.gov/business-guidance/resources/native-advertising-guide-businesses)).
4. Payment cannot overcome relevance, a user's selected filters, safety state,
   or a closed/unavailable business. A Mexican-restaurant campaign cannot enter
   a food-trucks-only or Chinese-food result set.
5. Spottr never sells precise location, search history, follows, order history,
   email, phone, or review identity. Ad selection is contextual: current coarse
   search area, requested category/cuisine, time, and merchant availability.
6. A merchant sees the price, billing event, attribution rule, maximum budget,
   refund rule, and estimated reach before activation. Pausing is immediate.
7. No merchant is charged both a sponsored click and a sponsored order for the
   same journey.

## Revenue portfolio

| Stream | Customer | Charge basis | Free boundary | Launch phase |
| --- | --- | --- | --- | --- |
| Pickup transaction fee | Merchant | Versioned fixed amount plus basis points on captured food subtotal | Browsing, listing, menu, and off-platform pickup details stay free | After pickup payment pilot |
| Sponsored discovery | Merchant | Pay per completed attributed order when Spottr ordering is enabled; otherwise pay per valid click | Organic rank and all filters stay unchanged | Web-managed pilot |
| Business Growth plan | Merchant | Monthly or annual subscription | One location, core profile, menu, schedule, updates, reviews, and basic order queue stay free | After merchant value is measured |
| Multi-location Operations plan | Merchant group | Subscription by active location, with an explicit cap | No fee to claim or correct a listing | Later |
| Catering/event leads | Merchant | Clearly disclosed fee for an accepted qualified lead or completed booking, never for an unsolicited message | Consumers can request and compare for free | Later |
| Local market sponsorships | Event organizer or brand | Fixed campaign contract for a clearly separated event module | Organic event/market listings stay available | Later |
| Delivery partner revenue share | Delivery provider | Contractual referral or per-delivery share | Pickup remains available independently | Only after delivery program approval |
| Licensed data/API | Enterprise | Contracted usage plan | Public consumer experience is unaffected | Only when Spottr owns or licenses the rights |

Do not monetize by selling personal data, charging for favorable reviews,
removing competitors from a page, suppressing negative reviews, making accurate
hours a premium feature, taking a percentage of tips, or charging businesses to
correct provider errors.

### Business-plan entitlements

The first paid plan should sell operational leverage, not visibility disguised
as software:

- advanced first-party analytics with privacy thresholds;
- scheduled and reusable owner updates;
- bulk menu editing/import into owner-reviewed drafts;
- multi-user roles beyond the free included seats;
- multi-location rollups and templates;
- inventory/sold-out automation and order throttling;
- accounting and point-of-sale exports;
- customer re-engagement tools limited to customers who explicitly opted in;
- priority support with published service targets.

Sponsored inventory is purchased separately. A subscription may include a
clearly valued ad credit, but never an undisclosed ranking boost.

## Unit economics and pricing discipline

Do not hard-code public prices until processor quotes, support cost, fraud loss,
tax treatment, and pilot conversion data exist. All prices reference an
immutable `pricing_version_id` so an accepted order or campaign is reproducible.

Use these definitions:

```text
order_gmv = item_subtotal - merchant_discount + tax + tip
platform_order_revenue = application_fee - fee_refunds
order_contribution = platform_order_revenue
  - processor_cost - fraud_loss - support_variable_cost - credits

valid_ad_spend = sum(finalized ad ledger debits - ad credits)
merchant_roas = attributed_order_gmv / valid_ad_spend
cost_per_order = valid_ad_spend / attributed_completed_orders
subscription_margin = subscription_revenue - billing_cost - allocated support
```

`order_gmv` is not Spottr revenue. Tips and merchant tax proceeds are not
revenue. Dashboard totals must separate gross food sales, tax, tips, processor
fees, Spottr fees, ad spend, refunds, disputes, and merchant net.

Pricing experiments require an approved experiment ID, jurisdiction, enrollment
window, success/stop metrics, and immutable assignment. Never vary prices using
individual vulnerability, device price, inferred income, protected traits, or
precise neighborhood.

## Sponsored discovery

### Inventory design

The default discovery page has one restrained `Sponsored nearby` lane followed
by the unmodified organic list. A sponsored item may not be inserted more often
than one per six organic results. On a map, it uses the normal truck or
restaurant marker shape plus a small `Ad` badge; the business logo remains
visible. Selecting it opens a preview whose first metadata line says
`Sponsored ad · Why this ad?`.

`Why this ad?` gives a plain explanation such as:

> This food truck paid to appear for taco searches near this map area. Payment
> did not change the organic results.

The experience must also provide `Hide this ad` and `Report this ad`. Hiding an
ad does not require an account and lasts for the current device session. Ad
creative uses moderated listing content; custom campaign copy is a separately
moderated asset.

### Eligibility before auction

A campaign is servable only when all are true:

- the business is claimed, published, not suspended, and allowed to advertise;
- its selected public location is currently valid and inside the requested
  geography;
- its logo is approved and processed;
- hours, payment methods, and menu freshness meet the campaign type's minimum;
- the business and campaign pass unresolved-safety and billing-risk gates;
- the business matches every explicit user filter and the contextual query;
- a food-order campaign has an orderable menu and pickup window;
- a home-kitchen campaign is disabled until the jurisdiction, permit,
  advertising, food-safety, and insurance program is separately approved.

Eligibility and contextual relevance run before the auction. The bidder cannot
pay to bypass them.

### Ranking and fairness

Keep two independent functions:

```text
organic_score = documented organic relevance/reliability function
ad_candidate_score = contextual_relevance * listing_quality * bid_factor
```

`organic_score` never reads campaign, bid, subscription, or billing tables.
`ad_candidate_score` never rewrites an organic position. Use a bounded bid
factor and minimum relevance threshold so a high bid cannot win an irrelevant
query. Store a versioned, replayable decision record containing feature
versions, candidate IDs, rejection reasons, winner, price, and disclosure text.

At launch, support one winning ad per placement request. Add a second-price
auction only after auction simulation, budget pacing, merchant education, and
independent fairness review. DoorDash documents a pay-per-order auction where
relevance participates and a winner can pay the next bid after checkout
([DoorDash merchant guidance](https://help.doordash.com/en-us/merchants/article/getting-started-with-self-serve-sponsored-listing)); this is market precedent,
not proof that the same mechanism is right for Spottr.

### Billing models

1. **Ordering-enabled business — cost per completed order (CPO).** Charge only
   when the customer deliberately opened the sponsored placement, placed an
   order at that same business within 24 hours, payment was captured, and the
   order was completed. A rejected, merchant-cancelled, fully refunded,
   fraudulent, test, staff, or merchant-self order creates no ad charge.
2. **Directory-only business — cost per valid click (CPC).** Charge on the first
   eligible detail/menu/directions intent from a signed placement token. Repeat
   taps, background renders, bots, prefetches, staff/member activity, and taps
   after budget exhaustion do not bill.

View-through orders are reported as `unattributed` and are never billed. One
journey has one last eligible sponsored click, one campaign, and one charge.
Partial refunds do not automatically erase the ad charge if food was fulfilled;
the merchant-facing policy must describe the exact credit rule. Support can
issue an auditable credit, never mutate an old debit.

### Campaign controls

The simple setup flow asks for:

- objective: `more pickup orders`, `more menu views`, or `more visits`;
- eligible business location(s);
- contextual category/cuisine and optional normalized keywords;
- radius/city/ZIP target from public business locations;
- schedule/dayparts in the business timezone;
- daily and lifetime maximum budget;
- CPO/CPC maximum bid or a clearly explained bounded automatic strategy;
- approved creative preview;
- terms and pricing-version acceptance.

Controls include draft, submit, schedule, activate, pause, resume, and end.
Budgets are hard caps enforced atomically by the billing ledger, not client-side
estimates. Automatic bidding cannot raise the merchant's maximum or budget.
Campaigns stop on stale location, closed ordering, risk hold, payment failure,
budget exhaustion, end time, or safety suspension.

Yelp publicly describes separate `Sponsored Results`, merchant-controlled
budgets, performance reporting, and cancellation controls
([Yelp Ads](https://business.yelp.com/products/yelp-ads/)). Uber describes
audience/budget/bid editing, pausing, and order/click reporting
([Uber sponsored listings](https://help.uber.com/en/merchants-and-restaurants/article/sponsored-listings-faq?nodeId=b76c227a-9850-42cd-a419-163adae83fed)). Spottr should match those control expectations while differentiating on transparent attribution and live food-truck reliability.

### Metrics

Merchant reports show definitions and data latency alongside:

- eligible impressions and invalid impressions;
- unique reach as a privacy-thresholded estimate;
- valid sponsored opens, menu views, direction intents, carts, orders, and
  completed orders;
- conversion rate, spend, average CPC/CPO, attributed GMV, and merchant ROAS;
- refunds, ad credits, invalid-traffic exclusions, and budget remaining;
- results by campaign, location, contextual category, and daypart.

Never expose an individual consumer, raw search text, exact coordinates, or a
row when the privacy cohort is below the approved threshold. Organic analytics
and sponsored analytics remain labelled separately.

## Proposed data model

Implementation status: migration
`20260830000000_sponsored_placement_foundation.sql` now supplies the fail-closed
contextual sponsored-placement core: immutable approved pricing, service-only
selection, verified-listing and geography eligibility, concurrent budget
reservations, signed short-lived tokens, idempotent interaction receipts, an
append-only debit/credit ledger, merchant-readable RLS projections, and bounded
reservation cleanup. Both the client and Edge serving gates default to off, and
the runtime is shadow-only by default. Merchant campaign authoring, payment
onboarding, real-money enablement, rollup/reconciliation jobs, and finance
approval UI remain blocked by the external requirements below.

This is a new migration program, not a patch to append blindly to
`supabase/schema.sql`. Use integer minor units, ISO 4217 currency, UTC
timestamps, explicit check constraints, RLS, stable public IDs, and append-only
financial entries. Provider customer/payment IDs belong in `private`, never in
public projections.

| Table | Critical fields and invariant |
| --- | --- |
| `public.pricing_versions` | immutable version, region, currency, fee basis points/fixed minor units, effective window, approval metadata |
| `public.business_entitlements` | business, feature key, source (`free`, `subscription`, `staff_grant`), effective/expiry; no client-authored grants |
| `public.business_subscriptions` | business, plan, state, pricing version, period; provider identifiers live in private companion table |
| `public.ad_campaigns` | business, objective, billing model, state, currency, bid cap, daily/lifetime budget, schedule, pricing version, optimistic `updated_at` |
| `public.ad_targets` | campaign, allowed business kinds, normalized cuisines/keywords, public location/radius, dayparts; no user segments |
| `public.ad_creatives` | campaign, listing/media references, moderation state/version; no remote media URL |
| `private.ad_serving_decisions` | request ID, coarse context, candidate/version snapshot, winner, clearing price, signed-token hash, short retention |
| `private.ad_events` | decision, campaign, event type, server time, dedupe key, validity/reason; partition and expire raw events |
| `private.ad_attributions` | order, campaign, eligible click, model version, state; unique order prevents double attribution |
| `private.billing_accounts` | business and payment-provider customer/account references, risk state; no card or bank credentials |
| `private.billing_ledger` | immutable debit/credit/hold/release entries, source type/ID, currency, amount, effective time; reversal points to original entry |
| `private.ad_budget_reservations` | campaign, placement/attribution, reserved amount, expiry/state; prevents concurrent overspend |
| `public.ad_campaign_daily_rollups` | merchant-safe aggregates rebuilt from source events; never the financial authority |

Add foreign keys to existing `businesses`, `business_members`, `business_locations`,
and later `orders`. Add partial indexes for active campaigns by time/geography,
ledger source uniqueness, event dedupe, and unexpired reservations. Financial
rows are never hard-deleted; retention/anonymization must be legally approved.

### RLS and authority

- Anonymous/authenticated clients read only a safe sponsored-placement RPC;
  bids, budgets, targeting, decision features, and billing rows are not public.
- Active business owners/managers can read their campaigns and aggregates.
  Campaign activation, pricing acceptance, and payment changes require AAL2.
- Clients never insert impressions, charges, entitlements, attribution, or
  ledger rows directly. Security-definer functions have fixed empty
  `search_path`, explicit table qualification, narrow grants, rate limits, and
  idempotency receipts consistent with the existing schema.
- Every campaign/budget/billing/risk state transition writes `audit_events`.
  Monetary operations use row locks or serializable transactions and a unique
  source key so retries cannot spend twice.

## Proposed API contracts

Consumer/public:

- `get_sponsored_placements(context, organic_filter_hash, limit)` returns safe
  business projection, `placement_id`, exact `Sponsored ad` disclosure, reason
  categories, signed short-lived token, and no billing data.
- `record_sponsored_interaction(token, event_type, idempotency_key)` validates
  token, foreground eligibility, dedupe, campaign/budget state, and returns a
  receipt. It never trusts client price or campaign ID.
- Organic directory/search RPCs remain unchanged and campaign-table-free.

Merchant (AAL2 for mutations):

- `list_business_campaigns`, `get_campaign_report`;
- `create_campaign_draft`, `update_campaign_draft`, `submit_campaign`;
- `pause_campaign`, `resume_campaign`, `end_campaign` with expected timestamp;
- `get_campaign_quote` returns pricing version, maximum exposure, billing event,
  disclosures, refund policy version, and expiry;
- `accept_campaign_quote` requires an idempotency key and exact quote version.

Server/internal:

- `select_sponsored_placement` performs eligibility and budget reservation;
- `finalize_ad_attribution` consumes order events;
- `expire_budget_reservations`, `rollup_ad_metrics`, and
  `reconcile_ad_ledger` are restartable jobs with checkpoints;
- payment-provider webhooks verify signatures over raw bytes, dedupe provider
  event IDs, tolerate reordering, and reconcile rather than trusting the client.

## Fraud, privacy, and abuse controls

- Signed, single-purpose, short-lived placement tokens bind campaign, decision,
  surface, business, context hash, and expiry.
- Server timestamps are authoritative. Prefetch and invisible/background events
  never count. Apply per-token, account, business-member, session, network-risk,
  and campaign velocity limits.
- Exclude merchant owners/managers/staff, test accounts, known automation,
  duplicate orders, emulator farms detected by approved risk tooling, refunded
  orders, and payment fraud from billing.
- Store raw IP only in access/security logs under the approved short retention;
  ad analytics receives a rotating keyed risk token and coarse region, not IP or
  precise coordinates.
- Do not use third-party cross-app tracking or IDFA/advertising ID for serving.
  Contextual ads must work when tracking permission is denied.
- Risk holds cannot silently consume budget. The dashboard shows pending,
  finalized, credited, and excluded spend.
- Creative, destination, and business safety reports enter the existing
  fail-closed moderation/audit workflow. A business suspension immediately
  disables its ads.
- Finance operations need separation of duties: support can request a credit;
  an authorized finance role approves above a configured threshold.

## Mobile-store and payment boundary

This section is operational guidance, not legal advice.

- A consumer buying prepared food for pickup is purchasing a physical good
  consumed outside the app. Apple says such purchases must use a method other
  than in-app purchase, such as Apple Pay or card entry
  ([App Review Guideline 3.1.3(e)](https://developer.apple.com/app-store/review/guidelines/)). Google says Play Billing must not be used when payment is primarily for physical goods or physical services such as food delivery
  ([Google Play Payments policy](https://support.google.com/googleplay/android-developer/answer/9858738?hl=en)).
- Buying an ad displayed inside the same iOS app is different. Apple explicitly
  says those digital purchases must use in-app purchase; its non-IAP advertising
  exception is for apps whose sole purpose is campaign management and that do
  not display the ads themselves
  ([App Review Guideline 3.1.3(g)](https://developer.apple.com/app-store/review/guidelines/)). Spottr is not such a standalone app.
- Merchant SaaS and advertising are digital services under mobile-store rules.
  Google generally requires Play Billing for digital in-app functionality,
  subject to current regional programs and rules
  ([Google Play Payments policy](https://support.google.com/googleplay/android-developer/answer/9858738?hl=en)). Policies, litigation-driven regional programs, fees, and link allowances are changing; obtain store counsel and written review guidance for the exact build and storefronts.

Therefore the safe first release is:

1. food checkout may use an approved marketplace processor/Apple Pay/Google Pay;
2. campaign purchase and SaaS checkout launch on the authenticated web merchant
   console after legal/payment review;
3. native business tools may display already-active status and reports, but no
   purchase link, price CTA, or upgrade steering until Apple/Google review has
   approved the exact regional implementation;
4. add native store billing only through a server-verified entitlement service
   that handles purchase validation, restoration, refunds, grace periods, and
   cross-platform entitlement conflicts.

## Phased implementation

### Phase M0 — trust and measurement

- Finalize organic-ranking specification and a regression test proving it has
  no paid inputs.
- Define event taxonomy, retention, privacy threshold, pricing-version process,
  finance roles, refund policy, and campaign terms.
- Instrument organic exposure-to-action funnels without cross-app tracking.
- Complete legal/entity, tax, privacy, store-policy, and processor reviews.

### Phase M1 — web-managed sponsored beta

- Build schema/RLS/RPCs, contextual eligibility, one sponsored lane, disclosure,
  hide/report, CPC for non-orderable listings, budget caps, ledger, dashboard,
  and finance reconciliation.
- Restrict to verified businesses and approved pilot cities. Use invoice or an
  approved web billing account; do not put secrets or arbitrary price authority
  in the client.
- Run shadow auctions before billing, then capped real-money pilots with signed
  merchant acceptance and daily reconciliation.

### Phase M2 — pickup and CPO

- Complete `ORDERING_ARCHITECTURE.md` gates.
- Add explicit-click, 24-hour, same-business attribution and CPO billing.
- Void charges for rejected, merchant-cancelled, fraudulent, or fully refunded
  orders. Publish attribution definitions in merchant UI.

### Phase M3 — merchant SaaS

- Launch paid operational features only after free workflows are reliable and
  cohort tests show time/revenue value.
- Implement provider plus store entitlement reconciliation and self-service
  cancellation/export. Do not lock merchant data when a plan ends.

### Phase M4 — extensions

- Catering leads, local event sponsorship, delivery revenue share, and licensed
  enterprise APIs each receive separate contracts, risk review, and ledgers.

## Competitive differentiation

Spottr should not try to win by having more ad inventory. It can win by making a
local-food decision more trustworthy and merchant economics more legible:

- live food-truck stops and owner-confirmed open state;
- payment-method certainty before travel;
- one-tap sold-out/menu updates connected to ads and ordering eligibility;
- organic results that paid products cannot corrupt;
- a visible explanation for every ad and no billed view-through conversion;
- merchant-facing invalid-traffic exclusions and append-only credits;
- pickup economics without forcing delivery participation;
- provider/owner/community provenance and freshness shown separately;
- privacy-safe contextual relevance, not behavioral dossiers.

## External launch blockers

No production monetization claim is valid until all of these exist for the exact
deployment:

- incorporated legal entity, bank account, tax registrations, merchant terms,
  advertiser terms, privacy policy, refund/cancellation policy, and counsel's
  merchant-of-record/marketplace-liability decision;
- Apple and Google developer organizations plus approved billing interpretation
  for ads and SaaS in every supported storefront;
- payment/Connect contract, KYC/KYB onboarding, sanctions checks, payout rules,
  reserves, negative-balance allocation, dispute operations, and webhook keys;
- ad-sales/support/moderation/finance staffing with separation of duties;
- independent RLS/API/payment/fraud/privacy review and load tests;
- finance reconciliation against processor statements and tested ledger
  recovery/backup procedures;
- measured pilot economics. Revenue, ROAS, conversion, and market-size claims
  must never be invented from source code.

