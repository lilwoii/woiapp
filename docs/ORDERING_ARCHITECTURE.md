# Spottr pickup-ordering architecture

Status: phase O1 foundation implemented; prepaid ordering remains gated. The repository does not prove that payments,
merchant onboarding, tax calculation, refunds, payouts, or delivery are
production-enabled. Policy notes were last checked on 2026-08-01 and require
review for the exact release, legal entity, processor contract, and storefront.

See [MONETIZATION.md](MONETIZATION.md) for the pricing ledger, sponsored-order
attribution, and mobile-store boundary.

## Version-one promise and boundary

The first order product is **prepaid pickup from one business at one current
location or food-truck stop**. It must answer, before payment:

- exactly what is being ordered and which options were selected;
- item price, discount, tax, tip, fees, and final total;
- where pickup is, including the truck's current stop/landmark;
- the earliest realistic pickup time and whether merchant acceptance is manual;
- cancellation/refund terms and how to get help;
- whether the merchant accepted, is preparing, is ready, or cancelled.

Version one excludes delivery, courier dispatch/tracking, multi-business carts,
split tender, cash-on-pickup reservations, alcohol/controlled goods, gift cards,
stored-value wallets, recurring food orders, home kitchens, and customer-created
custom substitutions. Those are separate legal and operational programs, not
small checkout options.

Browsing and menus remain available without login. The controlled pilot should
require a verified Spottr user for payment and status access; guest checkout can
be added only after order-scoped access tokens, contact verification, abuse
controls, deletion/export behavior, and support recovery have been tested.

## Merchant eligibility

`pickup_enabled` is server-controlled and false until all are true:

- business is claimed, published, not suspended, and has a current verified
  owner plus an AAL2-capable business account;
- payment-provider onboarding reports the required charges/payout capabilities;
- legal business identity, bank/payout destination, tax configuration, support
  contact, refund policy, and pickup instructions are accepted and current;
- an approved public location or scheduled food-truck stop covers the complete
  pickup window;
- an orderable, owner-approved menu version has currency, tax category,
  availability, modifier rules, and allergen disclosure fields;
- the merchant has chosen manual or automatic acceptance, preparation-time
  bounds, capacity, lead time, order cutoff, and no-response behavior;
- finance, fraud, food-safety, moderation, or incident controls have not placed
  the business on hold.

Food trucks require additional invariants: an order is bound to a specific
`mobile_stop_id`; pickup must finish before the stop ends minus a configurable
safety buffer; moving/cancelling the stop disables new orders and starts an
audited resolution flow for accepted ones.

## Consumer flow

1. **Choose an orderable place.** The detail page shows `Order pickup` only when
   the server returns an eligible location and pickup window. `Open now` alone
   is not enough.
2. **Build one-business cart.** Add items and required modifiers from a versioned
   orderable menu. Changing business asks before clearing the cart.
3. **Choose pickup window and contact.** Default to earliest available; show the
   actual public stop/location, timezone, preparation estimate, and cutoff.
4. **Request a server quote.** The server rechecks menu version, availability,
   capacity, pickup stop, promotions, tax, pricing plan, and currency. A quote
   has a short explicit expiry (initially five minutes, configurable).
5. **Review total and policy.** Present every monetary line before the pay
   control. Tip defaults to no preselected percentage; Spottr takes no
   percentage of the tip.
6. **Confirm payment.** A single `Place order` intent has a stable idempotency key
   retained through network retries and payment authentication.
7. **Wait for acceptance.** Show `Awaiting confirmation` and the exact timeout.
   Never imply food is accepted merely because payment was authorized.
8. **Track fulfillment.** A compact timeline shows accepted, preparing, ready,
   and completed, with accessible notification alternatives and support.

No client-supplied price, tax, fee, discount, inventory, preparation time,
merchant ID, or payment state is authoritative.

## Merchant flow

The Studio order surface is operational, not a consumer-style dashboard:

- large current queue ordered by promised pickup time;
- persistent `Accepting pickup orders` control with pause duration and reason;
- new-order alert showing exact items/options, allergies note, total, pickup
  time, and accept/reject countdown;
- one action each for `Accept`, `Reject`, `Preparing`, `Ready`, and `Completed`;
- quick preparation-time adjustment and capacity throttling;
- one-tap item sold-out and `pause new orders` controls;
- an optional short owner update suggested when an ingredient outage affects
  discovery, but never auto-published;
- refund/issue entry with reason and a preview of customer/merchant/Spottr
  amounts before confirmation;
- offline/reconnect state. A merchant cannot accept an order on stale data.

For version one a merchant accepts the exact order or rejects it. Item removal,
substitution, price increase, or tip change is forbidden without a later,
explicit customer-approved amendment protocol.

## Catalog and availability

The existing `menu_sections` and `menu_items` are suitable for discovery but
not sufficient as a financial catalog. Ordering adds immutable published menu
versions. Editing creates a draft; publishing creates a new version while old
versions remain for receipts, disputes, refunds, and analytics.

Each orderable item needs:

- stable item identity plus immutable version identity;
- integer `price_minor`, ISO 4217 currency, tax category, and quantity limits;
- required/optional option groups with min/max selections;
- option price deltas in integer minor units;
- availability mode, optional counted inventory, and order cutoff;
- merchant-authored allergen note plus a standard cross-contact warning that
  Spottr cannot guarantee an allergen-free preparation environment;
- location applicability and daypart schedule;
- approved photo reference, never a remote unlicensed URL.

An order snapshot copies item/option names, quantities, unit prices, tax
category/result, discounts, and totals. Receipts never re-render historical
orders from the merchant's current menu.

### Capacity and inventory

Capacity is separate from ingredient inventory:

- `order_capacity_slots` limits accepted workload by business, location/stop,
  and pickup interval;
- `menu_item_inventory` optionally tracks counted quantity for an item version;
- uncounted items still obey `available/sold_out/hidden` and merchant capacity;
- checkout atomically validates/reserves inventory and capacity. A cart or
  expired quote does not permanently consume either;
- reservations have an expiry and restartable cleanup job;
- acceptance converts reservations to consumption; rejection/cancellation
  releases them exactly once.

The database transaction, not a realtime UI, is the oversell authority.

## Quote and money invariants

Use integer minor units throughout. Currency is one value per cart/order and is
never inferred from device locale.

```text
item_line_subtotal = quantity * (item_unit_price + selected_option_deltas)
subtotal = sum(item_line_subtotal)
discount = sum(eligible server-calculated discounts)
taxable_basis = jurisdiction/provider-defined amount
tax = authoritative tax result, rounded once under approved rules
tip = customer-selected amount, never included in percentage platform fees
consumer_fee = explicitly disclosed fee, initially zero unless approved
total = subtotal - discount + tax + tip + consumer_fee
merchant_gross = subtotal - merchant_funded_discount + tax + tip
merchant_net = merchant_gross - processor_allocation - Spottr_application_fee
```

These formulas describe categories, not universal tax law. Counsel and the tax
provider must decide taxability, marketplace-facilitator duties, rounding,
inclusive pricing, refunds, filing, and receipt rules per jurisdiction.

Every quote contains:

- `quote_id`, user, business, location/stop, menu version, currency;
- exact item/option snapshot and inventory reservation references;
- subtotal, each discount/funder, tax lines, tip, consumer fee, total;
- merchant and platform fee estimate under immutable `pricing_version_id`;
- pickup window, merchant acceptance mode, expiry, terms/refund-policy version;
- canonical request hash.

Checkout rejects an expired or changed quote and returns a structured re-quote,
never silently changes the total under the pay control.

## Independent state machines

Do not collapse fulfillment and payment into one `status`; their combinations
matter during timeouts, disputes, and refunds.

### Fulfillment state

```text
pending_acceptance
  -> accepted -> preparing -> ready -> completed
  -> rejected
  -> cancelled

accepted/preparing/ready
  -> cancelled (only through policy-authorized resolution)
```

### Payment state

```text
created -> requires_action -> authorized -> captured
                     |              |          |
                     v              v          v
                   failed         voided    partially_refunded -> refunded
                                                |
                                                v
                                             disputed
```

Actual transitions are constrained by the selected provider/payment method.
Store the provider state separately from Spottr's normalized state. An
append-only `order_events` history records prior/current state, actor type,
reason code, correlation ID, and server time. State updates use expected version
or timestamp to reject stale merchant actions.

### Capture strategy

The preferred pilot is authorize at checkout and capture on merchant acceptance
when the chosen processor, payment method, authorization window, and region
support that safely. Automatic-accept merchants may capture immediately after
the atomic acceptance check. If a payment method cannot support the required
authorization flow, that method stays disabled until a separately approved
capture-and-refund experience exists.

The client callback is never proof of payment. Signed provider webhooks plus
server retrieval/reconciliation are authoritative. Food preparation does not
start until the normalized order is both `accepted` and in an approved payment
state.

## Cancellation and refund policy matrix

Exact consumer terms require counsel, but implementation must support these
minimum outcomes:

| Situation | Fulfillment action | Payment action | Spottr/ad treatment |
| --- | --- | --- | --- |
| Customer cancels before acceptance | Cancel | Void authorization; refund if capture raced | No order fee; no CPO ad charge |
| Merchant rejects or times out | Reject | Void/full refund | No order fee; no CPO ad charge; capacity released |
| Merchant cancels accepted order | Cancel with reason | Full refund unless customer explicitly accepted a fulfilled partial order | Application/ad fees credited under policy |
| Item unavailable before acceptance | Reject exact order | Void/full refund | Suggest sold-out update; no charge |
| Duplicate order/payment | Keep one intended order | Void/refund duplicate | Dedupe and incident audit |
| Customer requests cancellation after preparation | Policy/support decision | Full, partial, or no refund as disclosed | Ledger records decision; never rewrite original charge |
| Full post-completion quality refund | Completed plus issue outcome | Full refund | Versioned policy decides application/ad credit; dashboard explains it |
| Chargeback/dispute | Preserve fulfillment record | Provider dispute workflow | Risk hold and separate dispute ledger |

Refunds are first-class records with line-level reason, initiator, approver,
provider IDs, tax/tip/application/ad allocation, and immutable debit/credit
ledger entries. A refund API retry returns the original receipt. Support cannot
silently edit an order total or delete its financial history.

## Proposed data model

Create reviewed migrations; do not append tables directly to a deployed schema.
Continue the repository's RLS, AAL2, fixed-`search_path`, public-ID, rate-limit,
idempotency, safe-projection, and audit conventions.

| Table | Critical fields and invariant |
| --- | --- |
| `public.business_order_settings` | business, pickup flag, acceptance mode/timeout, prep bounds, cutoff, capacity defaults, policy version; published business members read, AAL2 mutations |
| `private.merchant_payment_accounts` | business, processor, connected-account/customer IDs, capability/KYB/payout/risk states; no bank/card credentials |
| `public.menu_catalog_versions` | business, version number, currency, state, published time/by; immutable once published |
| `public.menu_item_versions` | catalog version, stable item ID, discovery item reference, name/description/price/tax/allergen/order schedule snapshot |
| `public.menu_option_groups` | item version, min/max selections, required flag, sort order |
| `public.menu_option_versions` | group, stable option ID, name, price delta, availability |
| `public.menu_item_inventory` | item version/location, counted quantity or uncounted availability, optimistic version |
| `public.order_capacity_slots` | business/location/stop/window, capacity, reserved, accepted; database checks prevent negative/over-capacity values |
| `public.carts` | owner, one business/location/stop/currency, active/checked-out/expired, version/expiry |
| `public.cart_items` and `cart_item_options` | item/option versions and quantity; server mutations only |
| `private.order_quotes` | canonical cart snapshot/hash, all money/tax/fee lines, pricing/policy versions, reservation IDs, expiry |
| `public.orders` | opaque public ID, owner, business/location/stop, quote, fulfillment/payment summaries, pickup time, version; no public directory access |
| `private.order_contacts` | order-scoped name, verified email/phone, notification consent and retention class |
| `public.order_items` and `order_item_options` | immutable receipt snapshots and integer money components |
| `public.order_events` | append-only normalized fulfillment timeline; consumer/merchant safe projection omits internal risk notes |
| `private.payment_attempts` | order, provider/payment-intent reference, normalized/provider states, amounts, idempotency key hash |
| `private.refunds` | order/payment attempt, amount/allocation/reason/state/provider reference/idempotency receipt |
| `private.inventory_reservations` | quote/order, item/capacity units, expiry/state; unique conversion/release guards |
| `private.payment_webhook_receipts` | provider event ID/hash/type/times/processing result; unique event ID and replay audit |
| `private.order_risk_reviews` | risk state/reason/action, restricted roles and retention |
| `public.order_issues` | customer-safe issue category/state, support receipt; evidence stored privately |
| `private.billing_ledger` | shared append-only financial ledger defined in `MONETIZATION.md`; unique source entry/reversal |

Partition high-volume event/webhook tables by time. Index customer/merchant open
orders, promised pickup time, unexpired reservations, provider reconciliation,
and unique source IDs. Keep order receipt/financial retention distinct from
deletable marketing analytics; legal retention and account-export/deletion
behavior must be documented before launch.

## API contracts

All mutation endpoints require a 16–128 character idempotency key, canonical
request hash, rate limit, authorization check, and audit correlation ID. Reusing
a key with a different request is a conflict. Retrying the same request returns
the original safe receipt.

### Consumer

- `get_orderable_menu(business_id, location_or_stop_id, pickup_time)` returns a
  safe catalog version and current capabilities; discovery menus remain
  independent.
- `create_cart(business_id, location_or_stop_id, idempotency_key)`;
- `set_cart_item(cart_id, expected_version, item_version_id, options, quantity,
  idempotency_key)`;
- `remove_cart_item`, `set_pickup_window`, and `set_tip` use the same optimistic
  and idempotent pattern;
- `quote_cart(cart_id, expected_version, idempotency_key)` returns the exact
  expiring quote and required payment methods;
- an Edge checkout endpoint creates/confirms the provider payment attempt and
  calls one database transaction to place the order from that quote;
- `get_my_order(order_public_id)` and a Realtime-safe order projection expose
  only the user's receipt/timeline;
- `cancel_my_order(order_public_id, expected_version, reason, idempotency_key)`;
- `submit_order_issue` accepts categorized text/evidence through the existing
  fail-closed media/moderation pipeline.

### Merchant (active member, AAL2)

- `get_business_order_queue(business_id, cursor, limit)`;
- `set_order_acceptance(business_id, enabled, pause_until, reason,
  expected_updated_at)`;
- `accept_order(order_id, promised_ready_at, expected_version,
  idempotency_key)` atomically checks payment, inventory, capacity, stop, and
  timeout;
- `reject_order`, `mark_order_preparing`, `mark_order_ready`, and
  `mark_order_completed` enforce legal transitions;
- `set_menu_item_order_availability` integrates the existing live menu event;
- `request_order_refund` returns an allocation preview; a separate confirmed
  call performs the authorized provider action.

### Server/internal

- `expire_quotes_and_reservations` and `timeout_unaccepted_orders` are
  restartable, checkpointed jobs;
- `process_payment_webhook(raw_body, signature)` verifies before parsing into
  authority, inserts one receipt, locks the payment/order, applies monotonic
  transitions, and schedules reconciliation for ambiguity;
- `reconcile_payments`, `reconcile_payouts`, and `reconcile_ledger` compare local
  state to processor reports and alert without inventing a successful state;
- `emit_order_notification` uses an outbox row committed with the state change,
  preventing a push message from becoming the source of truth.

## Payment-provider boundary

Use a small server-only adapter rather than importing provider semantics into
the app/domain model:

```text
create_or_update_merchant_account
get_merchant_capabilities
create_payment_attempt
confirm_payment_attempt
capture_authorization
void_authorization
refund_payment
retrieve_payment
verify_and_parse_webhook
retrieve_balance_transaction
```

The adapter accepts server-calculated amounts and opaque internal IDs. Provider
secret keys, webhook secrets, connected-account credentials, and raw bank/card
data never enter Expo configuration, Supabase public tables, logs, analytics,
or client storage. The client receives only the narrow provider artifact needed
to complete its own order and cannot use it for another user, amount, or
business.

Stripe Connect is a candidate, not a selected or configured dependency. Its
documentation says destination charges put the charge on the platform and debit
platform balance for processor fees, refunds, and chargebacks
([Stripe destination charges](https://docs.stripe.com/connect/destination-charges)). Stripe also documents materially different negative-balance, refund, dispute, fee, merchant-of-record, and reporting behavior between indirect and direct charges
([Stripe Connect configuration guidance](https://docs.stripe.com/connect/configuration-migration-guide)). Counsel, finance, risk, and the processor must choose the charge type and merchant-of-record model before schema/provider implementation is finalized.

### Mobile checkout

Prepared food for pickup is a physical good consumed outside the app. Apple says
to use a method other than in-app purchase, such as Apple Pay or card entry
([App Review Guideline 3.1.3(e)](https://developer.apple.com/app-store/review/guidelines/)). Google says Play Billing must not be used when payment is primarily for physical goods or physical services such as food delivery
([Google Play Payments policy](https://support.google.com/googleplay/android-developer/answer/9858738?hl=en)).

That physical-food rule does not authorize Spottr to sell merchant SaaS or ads
through the same processor in native UI; those digital purchases follow the
separate restrictions in `MONETIZATION.md`.

## Security and fraud controls

- Checkout performs one database-authoritative quote consumption under lock.
  A quote is single-use and bound to user, cart, business, location/stop,
  currency, total, and request hash.
- Webhooks verify signature on exact raw bytes, enforce timestamp tolerance,
  dedupe provider event ID, tolerate retries/out-of-order delivery, and retrieve
  the provider object when local state is ambiguous.
- Every payment/refund/cancel transition is idempotent and has a unique provider
  plus internal source key. Financial correction is an append-only reversal.
- RLS tests cover unrelated users, former/revoked business members, anonymous
  callers, cross-business IDs, guessed public order IDs, and staff-role misuse.
- AAL2 protects payment-account changes, payout/KYB data, refund approval,
  acceptance settings, and order operations. Recovery requires the documented
  staffed process from `SECURITY.md`.
- Rate/velocity limits cover cart creation, quotes, payment attempts, promo use,
  cancellations, refunds, issue submissions, merchant transitions, and webhook
  failures. Limits are keyed across appropriate account, order, business, and
  rotating privacy-safe risk signals.
- Exclude business owners/managers/staff from their own paid acquisition and
  flag self-orders, repeated refund loops, card testing, account farms, pickup
  non-completion, synthetic reviews after orders, and merchant collusion for
  review—not automatic guilt.
- Never store PAN, CVV, magnetic-stripe data, Apple Pay cryptograms, or Google
  Pay tokens after provider use. Obtain a formal PCI scope determination and
  attestation; using a processor SDK reduces exposure but is not a Spottr
  certification.
- Logs carry correlation/public IDs and money categories, not full contact,
  payment artifacts, free-form issue text, raw IP, or precise customer
  coordinates. Security logs use separate approved retention/access.
- Payment SDKs, analytics, maps, crash reporting, and notification providers
  require supply-chain, data-processing, privacy-label, and secret-rotation
  review for the exact versions shipped.

## Privacy, support, and accessibility

- Pickup requires no delivery address and never persists customer search/GPS
  coordinates. The order stores the merchant's public location/stop snapshot.
- Contact data is order-scoped, encrypted/protected, withheld from public
  projections, and shown to the merchant only to the minimum needed for pickup.
- Marketing opt-in is separate, unchecked, revocable, and never bundled with a
  receipt or status notification.
- Account export includes receipts, events, refunds, issues, and consent state.
  Deletion anonymizes where legally allowed while preserving legally required
  financial records under a published schedule.
- Receipts and status work with screen readers, large text, reduced motion,
  keyboard navigation on web, color-independent states, and local timezone plus
  absolute date/time. Payment errors keep context and never rely on color alone.
- Support has authenticated order lookup, redacted role-based views, issue
  severity/ownership, customer and merchant notice, appeal/escalation, refund
  approval limits, and a complete audit trail.

## Notifications and realtime behavior

Database state is authoritative; Realtime/push/email/SMS are delivery channels.

- Commit an outbox event in the same transaction as each state transition.
- At-least-once workers dedupe by `(order_id, event_version, channel)`.
- A push tap fetches current state and cannot execute a transition.
- Merchant new-order alerts escalate through approved channels before the
  acceptance timeout; notification failure is observable and can auto-pause new
  orders rather than silently accumulating orders.
- Consumer transactional notifications do not require marketing consent, but
  each channel follows its legal consent/quiet-hours rules.
- Do not put full order contents, contact details, or sensitive issue text on a
  lock screen; use `Your pickup order has an update` where necessary.

## Failure behavior

| Failure | Required behavior |
| --- | --- |
| Menu/price changed after cart | Invalidate quote, show exact changed lines, require a new confirmation |
| Item sells out during checkout | Atomic placement fails safely, reservation releases, cart remains editable |
| Food truck stop moves/cancels | Disable new orders; alert operations and every affected accepted order; require explicit resolution/refund |
| Merchant does not respond | Timeout to reject/cancel, void/refund, release capacity, no fees/ad charge, optionally auto-pause merchant |
| Client loses network after pay tap | Retry same idempotency key; fetch order/payment status; never invite a second payment |
| Payment webhook is duplicated/reordered | Unique receipt plus monotonic transition/retrieval; no duplicate capture/refund |
| Capture fails after acceptance | Stop preparation state, alert merchant/operations, resolve payment; never mark paid |
| Notification fails | State remains valid; retry outbox and show in-app status; alert at threshold |
| Processor outage | Disable new checkout or hold at a clearly reversible step; browsing stays available |
| Tax/fee provider unavailable | Fail closed for new quotes unless an approved jurisdiction-specific fallback exists |

## Future delivery boundary

Delivery is a separate bounded context behind a provider adapter. Pickup order
records cannot acquire courier fields ad hoc.

The future adapter may receive only after consumer consent:

- ready window, pickup contact/location, delivery address/contact, package
  constraints, quoted delivery fee, and internal order reference;
- provider delivery ID, state, proof-of-delivery reference, and coarse ETA;
- cancellation/failure/refund allocations under a versioned contract.

Spottr must not launch delivery until counsel and operations decide courier
contracting, licensing, insurance, background checks, worker classification,
vehicle/food handling, tips, taxes, accessibility, age-restricted goods,
undeliverable food, customer address safety, emergency escalation, location
retention, and provider outage responsibility. Background courier/customer
tracking is not authorized by the pickup architecture.

Delivery partners cannot receive reviews, follows, search history, advertising
IDs, unrelated orders, or continuous customer location. A provider outage must
not remove pickup. Contractual attribution and revenue share use separate ledger
entries from food, tax, merchant tip, and sponsored spend.

## Verification program

Automated tests must include:

- property tests for integer-money conservation and refund allocations;
- state-transition matrices for every actor and stale version;
- idempotency replay/same-key-different-body conflicts across all mutations;
- concurrent inventory/capacity/order placement and budget reservation;
- webhook invalid signature, replay, duplicate, delay, and reordering cases;
- RLS/auth/AAL2 adversarial tests across customer, unrelated customer, each
  business role, revoked role, moderator, admin, service role, and anonymous;
- DST, overnight hours, food-truck stop cutoff, timezone, and clock-skew tests;
- processor sandbox authorization/action/capture/void/refund/dispute paths;
- accessibility tests for cart, checkout, payment errors, merchant alerts, and
  status timelines on web/iOS/Android;
- offline/reconnect, killed-app recovery, duplicate-tap, slow network, processor
  timeout, Realtime loss, and notification loss;
- load tests around lunch spikes and one popular truck, plus reconciliation and
  restore drills.

Release evidence includes processor dashboard reconciliation, zero unexplained
ledger variance, signed refund/cancellation samples, test merchant payouts,
support drills, monitoring alerts, key rotation, backup restore, independent
payment/API/RLS penetration review, store review approval, and on-device
checkout evidence for exact signed binaries.

## Phased implementation

### Phase O0 — design and legal decisions

- Decide legal entity, merchant of record, processor/charge model, tax duties,
  fee/tip/refund policy, supported jurisdiction/currency, and support ownership.
- Threat-model checkout, webhooks, payouts, refunds, merchant compromise, menu
  fraud, and food-truck movement.
- Approve data retention, PCI scope, provider DPAs, and store disclosures.

### Phase O1 — catalog and shadow orders

- Add versioned orderable catalog, modifiers, location/stop eligibility,
  inventory/capacity, settings, quotes, state machines, audit, RLS, and tests
  behind server/client feature flags defaulted off.
- Run employee-only zero-money shadow orders to verify timing and operations.

The reviewed migration
`supabase/migrations/20260802000000_shadow_ordering_foundation.sql` now provides
an immutable catalog, capacity locking, opaque order receipts, append-only
event history, participant RLS, idempotent creation and merchant transitions,
rate limits, and audit events for employee-only zero-money shadow orders. It
cannot represent or create a charge: `payment_state` is constrained to
`not_required`, every financial addition is constrained to zero, and creation
requires AAL2 platform staff. Cart/quote UX, modifier selection, notification
outbox, support issue intake, scheduled expiry, and an operations pilot remain
before phase O1 is complete.

### Phase O2 — capped prepaid pickup pilot

- One processor, country, currency, city cohort, and verified merchant group.
- No promotions, guest checkout, partial modifications, delivery, or home
  kitchens. Use authorization/capture only for approved payment methods.
- Daily payment/payout/refund/ledger reconciliation and published support hours.

### Phase O3 — reliability and scale

- Add guest checkout only after recovery/abuse/deletion gates.
- Add privacy-safe merchant analytics, POS/accounting exports, promotions with a
  dedicated anti-abuse ledger, preparation predictions, and controlled
  multi-location operations.
- Enable sponsored CPO only after order completion/refund attribution is proven.

### Phase O4 — delivery partner pilot

- Build a separate consented delivery adapter and run new legal, privacy,
  security, insurance, operations, store, and incident gates. Pickup remains an
  independent fallback.

## External launch blockers

Ordering cannot be called complete or production-ready from repository code
alone. It requires:

- an incorporated entity, bank account, processor/Connect approval, merchant
  underwriting/KYB, sanctions screening, payout/reserve/negative-balance terms,
  webhook credentials, and tested live settlement;
- counsel decisions for merchant of record, marketplace facilitator/sales tax,
  receipts, tips, fees, refunds, disputes, food safety, privacy, accessibility,
  home kitchens, and each jurisdiction served;
- merchant/customer/order/payment/refund/support terms and reachable human
  support with escalation and business-continuity coverage;
- a production tax solution or approved jurisdiction-specific tax service;
- PCI assessment, independent penetration/RLS/payment review, fraud tooling,
  reconciliation ownership, incident response, backups/restores, and load tests;
- Apple Pay/Google Pay/payment-provider production entitlements, domains,
  certificates, signed binaries, privacy declarations, and Apple/Google review;
- measured pilot acceptance time, cancellation/refund rate, fraud/chargeback
  loss, support cost, processor cost, and order contribution. Source code cannot
  justify invented profitability or safety claims.
