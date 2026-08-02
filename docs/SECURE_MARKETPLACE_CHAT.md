# Secure marketplace chat and pickup disclosure

Spottr chat is a private, server-moderated exposure channel for two categories:

- An eligible, published Neighborhood Kitchen always offers chat. A seller cannot
  disable it while remaining in this category.
- An eligible, published pop-up offers chat only after an owner or manager opts in
  with AAL2.

Restaurants, food trucks, and other categories do not enter this channel. A
conversation has one customer and one explicit active owner/manager. Participant
reads are enforced in PostgreSQL RLS and writes use security-definer RPCs with an
empty `search_path`. Global user blocks stop new conversations, messages, typing,
media staging, and pickup disclosure access. Past participant content remains
available for reporting and evidence unless it has been removed.

## Message and identity boundary

Message projections return only the profile public ID, display name, username,
approved avatar path, body, clean attachment metadata, and timestamps. Internal
Auth IDs are not returned by the RPC projections. Message creation is serialized
per conversation, idempotent, flood-limited, professionally filtered, and audited
without copying message text into the audit log.

Images use the existing signed-upload quarantine pipeline. `chat_photo` staging is
bound to a conversation and business, permission is checked again at registration,
and a message accepts only assets owned by its sender that are clean, approved,
metadata-stripped, and associated with the same business. Processed objects have a
participant-only Storage policy; reported objects are additionally available to
AAL2 platform staff while the report is open or under review.

Chat images use the dedicated `chat_upload` source. Public eligibility now requires
an explicit approved logo, gallery, review, or avatar link; a business association
alone never publishes an asset, and anything linked to a chat message is expressly
excluded. This prevents permissive public-media and participant Storage policies
from combining into anonymous chat-photo access.

Typing is a replaceable 10-second lease and read state is a monotonic sequence.
Both are rate-limited RPC-only writes. They intentionally do not create durable
audit events because that would turn transient behavioral data into permanent
telemetry.

Chat is not end-to-end encrypted: Spottr must be able to moderate reported content.
Production still requires verified TLS, encryption-at-rest configuration, secret
rotation, retention/deletion jobs, abuse operations, and incident response.

Direct table reads are denied to app users even when participant RLS would match.
Clients receive narrow RPC projections so internal Auth IDs, staff fields, raw
read-receipt rows, and typing identifiers do not cross the API boundary. Storage
authorization uses private security-definer predicates instead of requiring raw
chat-table grants.

High-confidence message DLP rejects common street-address, precise-coordinate,
payment-card, bank-credential, and government-ID patterns on both the client and
the authoritative database path. It is deliberately paired with the dedicated
pickup-card flow and human moderation; pattern matching cannot identify every
language, address format, coded disclosure, or text embedded inside a photo.

## Exact pickup details

No residential address is added to a listing or public pickup record. Sellers can
submit only `public_meeting_place` or `commercial_site` candidates. Exact address
and coordinates live in the `private` schema; coarse label/city/region and workflow
state live in `public`. An AAL2 staff reviewer must approve a site before it can be
used. Approval is a workflow gate, not a guarantee that a location is safe.

An exact pickup card is created only through this sequence:

1. The customer requests a bounded pickup window in an eligible, unblocked chat.
2. The assigned merchant authorizes that exact request with AAL2 and chooses a
   previously approved non-residential site.
3. A private address snapshot is revealed only to those two participants and
   expires 12 hours after the pickup window.
4. Cancellation, merchant revocation, a block, loss of site approval, or expiry
   fails closed. A service cleanup deletes expired address snapshots.

Only one `pending` or `authorized` pickup request may exist per conversation. The
database enforces this with a partial unique index, preventing hidden overlapping
address disclosures even when a client bypasses the app UI. Public label, city,
and region fields pass the same precise-location DLP both at submission and again
at staff approval.

The conversation UI exposes this workflow directly: customers choose a bounded
pickup window, merchants with AAL2 select a staff-approved public option, and both
participants receive a dedicated expiring pickup card with a directions action.
The exact destination is never inserted into ordinary message text.

The exact address is never put in a public projection, Realtime row intended for
public consumption, message audit metadata, or marketplace map result. Product UI
must present it as a dedicated pickup card and discourage copying precise
locations into ordinary message text.

## Export, deletion, and retention

An AAL2 account export includes conversation metadata, messages authored by the
requesting user, their pickup-request records, and exact pickup-site data only for
sites they submitted or actively own. It does not include the counterpart's
message bodies, internal Auth IDs, private staff notes, or moderation evidence.

Account deletion first destroys every exact pickup disclosure attached to the
user's conversations, cancels pending or authorized pickup requests, clears
typing/read state, and closes each thread. Auth deletion then nulls participant and
sender identifiers. A shared thread survives for the remaining participant as a
closed conversation with a “Deleted account” identity; the deleting user's media
objects are removed by the account deletion manifest. This is pseudonymization,
not an assertion that every shared message body can always be erased immediately.
The final public retention policy and legal-hold rules must define when shared
message bodies, reports, and orphaned threads are destroyed.

## Launch evidence still required

Static contracts do not prove production behavior. Before launch, run migrations
against the target PostgreSQL version and test concurrent message sequencing,
idempotency conflicts, RLS/Realtime authorization, block races, media state races,
pickup expiry, account deletion, and staff moderation. Complete jurisdiction-by-
jurisdiction food-sale review, marketplace terms, consent/retention disclosures,
law-enforcement process, moderation appeals, safety escalation, and insurance
review. This architecture reduces data exposure; it does not make Spottr immune
from liability.

Home-food marketplace obligations vary by country, state/province, county, and
city. A category is therefore unavailable by default unless its exact
`jurisdictions` row has current legal review, an approved rules URL, enabled
status, verified permits, and operational ownership. Platform terms or a seller
disclaimer never substitute for permits, food-safety controls, required
intermediary disclosures, insurance analysis, tax/payment duties, or incident
response. California, for example, imposes specific duties on an “internet food
service intermediary,” including conspicuous fee and liability-insurance
disclosures; production counsel must review the current statute before enabling
any California locality.
