const blockedTerms = [
  'asshole',
  'bastard',
  'bitch',
  'bullshit',
  'cunt',
  'dick',
  'faggot',
  'fuck',
  'motherfucker',
  'nigger',
  'shit',
  'slut',
];

const leetCharacters: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  '$': 's',
  '!': 'i',
};

function blockedTermPattern(term: string) {
  return [...term]
    .map((letter, index) => `${letter}+${index === term.length - 1 ? '' : '[^\\p{L}\\p{N}]*'}`)
    .join('');
}

const blockedPattern = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])(?:${blockedTerms.map(blockedTermPattern).join('|')})(?=$|[^\\p{L}\\p{N}])`,
  'iu'
);
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

  const normalizedKey = clean.normalize('NFKC').toLocaleLowerCase('en-US');
  const moderationKey = normalizedKey.replace(
    /[013457@$!]/g,
    (character) => leetCharacters[character] ?? character
  );

  if (blockedPattern.test(normalizedKey) || blockedPattern.test(moderationKey)) {
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
  const reserved = new Set([
    'admin',
    'administrator',
    'help',
    'moderator',
    'official',
    'root',
    'spottr',
    'support',
  ]);

  if (!clean.length) return 'Username must contain at least 1 character.';
  if (clean.length > 24) return 'Username must be 24 characters or fewer.';
  if (!/^[A-Za-z0-9._-]+$/.test(clean)) {
    return 'Use A–Z letters, numbers, periods, underscores, or hyphens.';
  }
  if (reserved.has(key)) return 'That username is reserved.';
  if (existing.map(usernameKey).includes(key)) return 'That username is already taken.';
  if (!checkProfessionalText(clean, 24).ok) return 'Choose a professional username.';

  return null;
}

const disallowedPasswords = new Set([
  '123456789012',
  'password1234',
  'qwertyuiop12',
  'letmein123456',
  'spottr123456',
]);

export function validatePassword(value: string) {
  if (value.length < 12) return 'Use at least 12 characters.';
  if (value.length > 128) return 'Use 128 characters or fewer.';
  if (disallowedPasswords.has(value.toLocaleLowerCase('en-US'))) {
    return 'Choose a less common password.';
  }
  return null;
}
