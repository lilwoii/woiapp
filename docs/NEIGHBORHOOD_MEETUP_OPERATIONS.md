# Neighborhood Kitchen meetup operations

Neighborhood Kitchen is a discovery and private-contact category. Spottr does
not process the seller's payment, certify a kitchen, inspect a meetup place, or
guarantee a transaction. This architecture reduces unnecessary location
exposure; it does not remove legal or operational duties.

## Launch contract

- The customer chooses from two or three seller-enabled public meetup places.
- Public places originate only from a licensed or first-party provider record
  with current provenance, a bounded expiry, and a retained license reference.
- The customer never receives distance or bearing from the seller's private
  service location.
- Residence pickup is off by default and requires AAL2 seller enablement,
  versioned buyer caution acceptance, and AAL2 seller confirmation for each
  request.
- Consent receipts live in the private schema. Public pickup request rows do not
  retain buyer consent timestamps or policy versions.
- An exact address exists only in a structured disclosure card. It expires no
  later than two hours after the meetup window and never later than 24 hours
  after authorization.
- Blocking, clearing the conversation, disabling residence pickup, removing a
  route, withdrawing provider rights, or expiring provider data cancels the
  request and destroys the exact disclosure.
- Clearing is per participant. It hides messages and attachments through the
  current sequence for that person; it does not promise immediate physical
  erasure from safety, legal-hold, or retention systems.
- Turning off pop-up chat prevents new conversations only. Existing
  conversations remain available unless blocked, restricted, or deleted under
  the account lifecycle.

## Required recurring work

Run `cleanup_unavailable_meeting_place_requests` and
`cleanup_marketplace_chat_ephemera` with the service role at least every five
minutes; also run unavailable-place cleanup after each provider ingest. Alert
when it cancels any request, when the job has not succeeded for ten minutes, or
when active provider records lack sufficient future freshness for their
requested meetup windows.

Provider ingestion must fail closed unless each active row contains:

- a stable provider and provider-place identifier;
- `rights_status` of `licensed` or `first_party`;
- a non-empty retained license/provenance reference;
- source and verification timestamps; and
- an expiry no more than 45 days after verification.

Do not source public meetup places with client-side OpenStreetMap queries,
scraping, inferred shopping-center coordinates, or seller-entered coordinates.

## Production evidence

Before enabling the category in a jurisdiction, retain:

1. Database integration evidence for concurrent route changes, provider
   withdrawal, clear, block, account deletion, and disclosure expiry.
2. Scheduler evidence and alert routing for unavailable-place cleanup.
3. Media scanner evidence for malware, abuse imagery, OCR/QR sensitive-data
   detection, metadata stripping, and fail-closed outages.
4. A staffed report escalation path, published response targets, and an abuse
   drill covering a location or payment scam.
5. Counsel-approved, jurisdiction-versioned seller eligibility, required public
   permit/agency wording, platform registration, insurance, complaint handling,
   tax, and marketplace disclosures.

California and every other jurisdiction remain disabled until counsel approves
the complete disclosure and operating contract. Off-platform payment is not a
liability waiver.
