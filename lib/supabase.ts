import { createClient } from '@supabase/supabase-js';

import { isPkceVerifierKey } from '@/lib/auth-storage';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

// A static web client cannot issue HttpOnly session cookies without a BFF.
// Sessions stay tab-scoped, while the short-lived PKCE verifier uses local
// storage so email links opened in another tab can complete safely. Supabase
// removes the verifier after exchange. A strict CSP and short server-side token
// lifetimes remain mandatory in production.
const webAuthStorage = {
  getItem: (key: string) => {
    if (typeof window === 'undefined') return null;
    return isPkceVerifierKey(key)
      ? window.localStorage.getItem(key)
      : window.sessionStorage.getItem(key);
  },
  setItem: (key: string, value: string) => {
    if (typeof window === 'undefined') return;
    if (isPkceVerifierKey(key)) {
      window.localStorage.setItem(key, value);
      return;
    }
    window.sessionStorage.setItem(key, value);
  },
  removeItem: (key: string) => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.removeItem(key);
    window.localStorage.removeItem(key);
  },
};

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl as string, supabaseAnonKey as string, {
      auth: {
        autoRefreshToken: true,
        flowType: 'pkce',
        storage: webAuthStorage,
        persistSession: true,
        detectSessionInUrl: true,
      },
    })
  : null;
