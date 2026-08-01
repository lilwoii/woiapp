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
