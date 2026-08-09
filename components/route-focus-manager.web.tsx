import { usePathname } from 'expo-router';
import { useEffect } from 'react';

export function RouteFocusManager() {
  const pathname = usePathname();

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const mains = [...document.querySelectorAll<HTMLElement>('main')];
      const main = mains.find((candidate) => !candidate.closest('[aria-hidden="true"], [inert]'));
      const target = main?.querySelector<HTMLElement>(
        'h1, [role="heading"][aria-level="1"]'
      ) ?? main;
      if (!target) return;
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
      const title = target.textContent?.trim();
      if (title) document.title = `${title} · Spottr`;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pathname]);

  return null;
}
