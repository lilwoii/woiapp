import { usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';

export function RouteFocusManager() {
  const pathname = usePathname();
  const focusHistory = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    const rememberFocusedElement = (event: FocusEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target !== document.body &&
        !target.closest('[aria-hidden="true"], [inert]')
      ) {
        focusHistory.current.set(pathname, target);
      }
    };
    document.addEventListener('focusin', rememberFocusedElement);
    return () => document.removeEventListener('focusin', rememberFocusedElement);
  }, [pathname]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const mains = [...document.querySelectorAll<HTMLElement>('main')];
      const main = mains.find((candidate) => !candidate.closest('[aria-hidden="true"], [inert]'));
      const heading = main?.querySelector<HTMLElement>(
        'h1, [role="heading"][aria-level="1"]'
      ) ?? main;
      const previousTarget = focusHistory.current.get(pathname);
      const canRestore = previousTarget?.isConnected &&
        !previousTarget.closest('[aria-hidden="true"], [inert]');
      const target = canRestore ? previousTarget : heading;
      if (!target) return;
      target.tabIndex = target.tabIndex < 0 ? -1 : target.tabIndex;
      target.focus({ preventScroll: true });
      const title = heading?.textContent?.trim();
      if (title) document.title = `${title} · Spottr`;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pathname]);

  return null;
}
