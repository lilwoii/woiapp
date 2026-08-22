import {
  checkProfessionalText,
  usernameKey,
  validatePassword,
  validateUsername,
} from '@/lib/moderation';

describe('professional content validation', () => {
  it('normalizes harmless whitespace', () => {
    expect(checkProfessionalText('  Tacos   are ready!  ', 120)).toEqual({
      ok: true,
      clean: 'Tacos are ready!',
    });
  });

  it('rejects empty, oversized, vulgar, and link-spam text', () => {
    expect(checkProfessionalText('   ', 120).ok).toBe(false);
    expect(checkProfessionalText('123456', 5).ok).toBe(false);
    expect(checkProfessionalText('This is bullshit', 120).ok).toBe(false);
    expect(checkProfessionalText('https://a.example https://b.example', 120).ok).toBe(false);
  });

  it('rejects separator, repetition, and common number-substitution bypasses', () => {
    expect(checkProfessionalText('f.u.c.k', 120).ok).toBe(false);
    expect(checkProfessionalText('f!u!c!k', 120).ok).toBe(false);
    expect(checkProfessionalText('sh1t', 120).ok).toBe(false);
    expect(checkProfessionalText('m0therfuuucker', 120).ok).toBe(false);
    expect(checkProfessionalText('This is b-u-l-l-s-h-i-t', 120).ok).toBe(false);
  });

  it('keeps blocked terms boundary-safe', () => {
    expect(checkProfessionalText('Bastille pastries and classical bass', 120)).toEqual({
      ok: true,
      clean: 'Bastille pastries and classical bass',
    });
  });
});

describe('username validation', () => {
  it('uses Unicode normalization for uniqueness', () => {
    expect(usernameKey('  MAYA.Rose ')).toBe('maya.rose');
    expect(validateUsername('MAYA.Rose', ['maya.rose'])).toBe('That username is already taken.');
  });

  it('accepts one safe character and rejects reserved or unsafe values', () => {
    expect(validateUsername('m', [])).toBeNull();
    expect(validateUsername('support', [])).toBe('That username is reserved.');
    expect(validateUsername('bad name', [])).toContain('letters');
    expect(usernameKey('ｍ')).toBe('m');
  });
});

describe('password validation', () => {
  it('enforces length and rejects known weak examples', () => {
    expect(validatePassword('short')).toBe('Use at least 12 characters.');
    expect(validatePassword('password1234')).toBe('Choose a less common password.');
    expect(validatePassword('a unique passphrase 2026')).toBeNull();
  });
});
