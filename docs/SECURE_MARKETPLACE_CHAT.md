# Secure marketplace chat and pickup disclosure

Spottr chat is a private, server-moderated exposure channel for two categories:

- An eligible, published Neighborhood Kitchen always offers chat. A seller
  cannot disable it while remaining in this category.
- An eligible, published pop-up offers chat only after an owner or manager opts
  in with AAL2.

Restaurants, food trucks, and other categories do not enter this channel. A
conversation has one customer and one explicit active owner/manager. Participant
reads are enforced in PostgreSQL RLS and writes use security-definer RPCs with
an empty `search_path`. Global user blocks stop new conversations, messages,
typing, media staging, and pickup disclosure access. Past participant content
remains available for reporting and evidence unless it has been removed.

## Message and identity boundary

Message projections return only the profile public ID, display name, username,
approved avatar path, body, clean attachment metadata, and timestamps. Internal
Auth IDs are not returned by the RPC projections. Message creation is serialized
per conversation, idempotent, flood-limited, professionally filtered, and
audited without copying message text into the audit log.

Images use the existing signed-upload quarantine pipeline. `chat_photo` staging
is bound to a conversation and business, permission is checked again at
registration, and a message accepts only assets owned by its sender that are
clean, approved, metadata-stripped, and associated with the same business.
Processed objects have a participant-only Storage policy; reported objects are
additionally available to AAL2 platform staff while the report is open or under
review.

Chat images use the dedicated `chat_upload` source. Public eligibility now
requires an explicit approved logo, gallery, review, or avatar link; a business
association alone never publishes an asset, and anything linked to a chat
message is expressly excluded. This prevents permissive public-media and
participant Storage policies from combining into anonymous chat-photo access.

Typing is a replaceable 10-second lease and read state is a monotonic sequence.
Both are rate-limited RPC-only writes. They intentionally do not create durable
audit events because that would turn transient behavioral data into permanent
telemetry.

Chat is not end-to-end encrypted: Spottr must be able to moderate reported
content. Production still requires verified TLS, encryption-at-rest
configuration, secret rotation, retention/deletion jobs, abuse operations, and
incident response.

Direct table reads are denied to app users even when participant RLS would
match. Clients receive narrow RPC projections so internal Auth IDs, staff
fields, raw read-receipt rows, and typing identifiers do not cross the API
boundary. Storage authorization uses private security-definer predicates instead
of requiring raw chat-table grants.

High-confidence message DLP rejects common street-address, precise-coordinate,
payment-card, bank-credential, and government-ID patterns on both the client and
the authoritative database path. It is deliberately paired with the dedicated
pickup-card flow and human moderation; pattern matching cannot identify every
language, address format, coded disclosure, or text embedded inside a photo.

## Neighborhood Kitchen pickup preferences

Neighborhood Kitchen customers choose from two or three public shopping-center
or market routes that the seller selected from a licensed, freshness-bounded
place catalog. Nearby ranking is computed only in the seller's AAL2 controls;
customers never receive a distance or bearing from the seller's private service
location. If the provider catalog is unavailable or stale, public choices fail
closed instead of using scraped or invented places.

Residence pickup is off by default. Enabling it requires an AAL2 seller
acknowledgment. The customer must separately accept a prominent caution, and the
seller must confirm that specific pickup window before the address is copied to
an expiring structured card. The residence address is never placed in a public
listing, map pin, option row, or message body. Public centers are recommended;
Spottr does not describe any location as inspected, safe, or guaranteed.

Payment methods are seller-reported. Spottr does not process payment, collect
fulfillment proof, or represent that a transaction occurred. Chat continues to
block card, bank, identity, and precise-location text.

“Clear from my inbox” is participant-specific. It hides history through the
current sequence for that participant and revokes any active exact pickup card;
the other participant is unchanged, a later message can make the thread
reappear, and safety/legal retention can continue. It is not represented as an
immediate server erasure.

## Exact pickup details

No residential address is added to a listing or public pickup record. Pop-up
businesses use the public location on their listing; the legacy free-form,
staff-approved pickup-site workflow is retired. Neighborhood Kitchen does not
accept seller-entered public coordinates: it uses the provider catalog and
seller-selected routes described above. Exact residence details and consent
receipts live only in the `private` schema.

An exact pickup card is created only through this sequence:

1. The customer chooses one seller-configured public route or the optional
   residence pseudo-option and requests a bounded window in an eligible chat.
2. Residence selection requires the current buyer caution acknowledgment.
3. The assigned merchant confirms the customer-selected choice with AAL2; the
   merchant cannot silently substitute a different location.
4. A private address snapshot is revealed only to those two participants and
   expires no later than two hours after the pickup window and never later than
   24 hours after authorization.
5. Cancellation, merchant revocation, a block, seller residence disable, inbox
   clear, provider-place expiry, or expiry fails closed. A service cleanup
   deletes expired address snapshots.

Only one `pending` or `authorized` pickup request may exist per conversation.
The database enforces this with a partial unique index, preventing hidden
overlapping address disclosures even when a client bypasses the app UI.

The conversation UI exposes this workflow directly: customers choose the place
and bounded pickup window, merchants with AAL2 confirm that choice, and both
participants receive a dedicated expiring pickup card with a directions action.
The exact destination is never inserted into ordinary message text.

The exact address is never put in a public projection, Realtime row intended for
public consumption, message audit metadata, or marketplace map result. Product
UI must present it as a dedicated pickup card and discourage copying precise
locations into ordinary message text.

## Export, deletion, and retention

An AAL2 account export includes conversation metadata, messages authored by the
requesting user, their pickup-request records, and exact pickup-site data only
for sites they submitted or actively own. It does not include the counterpart's
message bodies, internal Auth IDs, private staff notes, or moderation evidence.

Account deletion first destroys every exact pickup disclosure attached to the
user's conversations, cancels pending or authorized pickup requests, clears
typing/read state, and closes each thread. Auth deletion then nulls participant
and sender identifiers. A shared thread survives for the remaining participant
as a closed conversation with a â€œDeleted accountâ€ identity; the deleting
user's media objects are frozen, snapshotted, deleted, and checkpointed by the
durable account-deletion storage workflow before Auth removal. This is
pseudonymization, not an assertion that every shared message body can always be
erased immediately. The final public retention policy and legal-hold rules must
define when shared message bodies, reports, and orphaned threads are destroyed.

## Launch evidence still required

Static contracts do not prove production behavior. Before launch, run migrations
against the target PostgreSQL version and test concurrent message sequencing,
idempotency conflicts, RLS/Realtime authorization, block races, media state
races, pickup expiry, account deletion, and staff moderation. Complete
jurisdiction-by- jurisdiction food-sale review, marketplace terms,
consent/retention disclosures, law-enforcement process, moderation appeals,
safety escalation, and insurance review. This architecture reduces data
exposure; it does not make Spottr immune from liability.

Home-food marketplace obligations vary by country, state/province, county, and
city. A category is therefore unavailable by default unless its exact
`jurisdictions` row has current legal review, an approved rules URL, enabled
status, verified permits, and operational ownership. Platform terms or a seller
disclaimer never substitute for permits, food-safety controls, required
intermediary disclosures, insurance analysis, tax/payment duties, or incident
response. California, for example, imposes specific duties on an â€œinternet
food service intermediary,â€ including conspicuous fee and liability-insurance
disclosures; production counsel must review the current statute before enabling
any California locality.

California must remain disabled until counsel-approved, jurisdiction-versioned
public disclosures are implemented for the issuing enforcement agency, permit
number, required home-kitchen wording, seller consent, intermediary
registration, fees, insurance status, complaints, and any threshold reporting.
The existing private permit field must not be exposed directly as a shortcut.
