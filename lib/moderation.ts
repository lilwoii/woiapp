const blockedTerms = [
  'asshole',
  'bastard',
  'bitch',
  'bullshit',
  'cunt',
  'dick',
  'fuck',
  'motherfucker',
  'shit',
  'slut',
];

const blockedPattern = new RegExp(`\\b(${blockedTerms.join('|')})\\b`, 'i');
const repeatedLinkPattern = /(https?:\/\/|www\.)/gi;

export function checkProfessionalText(value: string, maxLength: number) {
  const clean = value.replace(/\s+/g, ' ').trim();
  const links = clean.match(repeatedLinkPattern)?.length ?? 0;

  if (!clean) {
    return { ok: false as const, reason: 'Add a short, useful message.' };
  }

  if (clean.length > maxLength) {
    return { ok: false as const, reason: `Keep this to ${maxLength} characters or fewer.` };
  }

  if (blockedPattern.test(clean)) {
    return { ok: false as const, reason: 'Please use professional, respectful language.' };
  }

  if (links > 1) {
    return { ok: false as const, reason: 'Please include no more than one link.' };
  }

  return { ok: true as const, clean };
}

export function usernameKey(value: string) {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

export function validateUsername(value: string, existing: string[]) {
  const clean = value.normalize('NFKC').trim();
  const key = usernameKey(clean);
  const reserved = new Set(['admin', 'help', 'official', 'spottr', 'support']);

  if (!clean.length) return 'Username must contain at least 1 character.';
  if (clean.length > 24) return 'Username must be 24 characters or fewer.';
  if (!/^[\p{L}\p{N}._-]+$/u.test(clean)) return 'Use letters, numbers, periods, underscores, or hyphens.';
  if (reserved.has(key)) return 'That username is reserved.';
  if (existing.map(usernameKey).includes(key)) return 'That username is already taken.';
  if (!checkProfessionalText(clean, 24).ok) return 'Choose a professional username.';

  return null;
}
