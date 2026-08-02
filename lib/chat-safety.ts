export type ChatSafetyIssue = 'precise_location' | 'sensitive_payment';

const paymentNumberPattern = /(^|\D)(?:\d[ -]?){12,18}\d(\D|$)/;
const paymentCredentialPattern = /\b(?:cvv|cvc|card\s+number|routing\s+number|bank\s+account|account\s+number)\s*[:#=-]*\s*\d/i;
const governmentIdPattern = /\b\d{3}-\d{2}-\d{4}\b/;
const coordinatesPattern = /[-+]?\d{1,2}\.\d{4,}\s*,\s*[-+]?\d{1,3}\.\d{4,}/;
const declaredHomeAddressPattern = /\b(?:my|our|home)\s+address\s+(?:is|:|=)/i;
const streetAddressPattern = /\b\d{1,6}\s+[\p{L}\p{N}.''-]+(?:\s+[\p{L}\p{N}.''-]+){0,5}\s+(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|place|pl|terrace|trail|trl|highway|hwy|calle|rue|strasse|via|rua)\b/iu;

export function chatSafetyIssue(value: string): ChatSafetyIssue | null {
  if (
    paymentNumberPattern.test(value) ||
    paymentCredentialPattern.test(value) ||
    governmentIdPattern.test(value)
  ) {
    return 'sensitive_payment';
  }
  if (
    coordinatesPattern.test(value) ||
    declaredHomeAddressPattern.test(value) ||
    streetAddressPattern.test(value)
  ) {
    return 'precise_location';
  }
  return null;
}

export function chatSafetyMessage(issue: ChatSafetyIssue): string {
  return issue === 'sensitive_payment'
    ? 'Remove card, bank, or identity numbers. Spottr chat never needs payment credentials.'
    : 'Remove the exact address or coordinates. Use the verified, expiring pickup-location flow.';
}
