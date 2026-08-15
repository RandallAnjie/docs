import { useEffect, useState } from 'react';

export const APP_NAVIGATE_EVENT = 'rdocs:navigate';

export function pagePath(pageId: string, hash = ''): string {
  const normalizedHash = !hash ? '' : hash.startsWith('#') ? hash : `#${hash}`;
  return `/p/${encodeURIComponent(pageId)}${normalizedHash}`;
}

export function pageIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/p\/([^/]+)\/?$/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function commentThreadIdFromHash(hash: string): string | null {
  const value = hash.startsWith('#') ? hash.slice(1) : hash;
  return new URLSearchParams(value).get('comment');
}

export function resolveInAppNavigation(
  href: string,
  origin: string,
):
  | { type: 'page'; pageId: string; hash: string }
  | { type: 'home' }
  | { type: 'path'; path: '/login' | '/register' }
  | null {
  try {
    const url = new URL(href, origin);
    if (url.origin !== origin) return null;
    const pageId = pageIdFromPath(url.pathname);
    if (pageId) return { type: 'page', pageId, hash: url.hash };
    if (url.pathname === '/login' || url.pathname === '/register') {
      return { type: 'path', path: url.pathname };
    }
    if (url.pathname === '/' && url.search === '') return { type: 'home' };
    return null;
  } catch {
    return null;
  }
}

export function shouldInterceptInAppLink(input: {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target: string | null;
  download: boolean;
}): boolean {
  return (
    !input.defaultPrevented &&
    input.button === 0 &&
    !input.metaKey &&
    !input.ctrlKey &&
    !input.shiftKey &&
    !input.altKey &&
    (input.target === null || input.target === '' || input.target === '_self') &&
    !input.download
  );
}

export function currentLocationSnapshot(): { pathname: string; search: string; hash: string } {
  return {
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  };
}

function notifyAppNavigation(): void {
  window.dispatchEvent(new Event(APP_NAVIGATE_EVENT));
}

export function navigateToPage(
  pageId: string,
  options?: { hash?: string; replace?: boolean },
): void {
  const url = pagePath(pageId, options?.hash ?? '');
  const current = `${window.location.pathname}${window.location.hash}`;
  if (current === url) return;
  if (options?.replace) window.history.replaceState(window.history.state, '', url);
  else window.history.pushState(window.history.state, '', url);
  notifyAppNavigation();
}

export function navigateHome(options?: { replace?: boolean }): void {
  const alreadyHome =
    window.location.pathname === '/' &&
    window.location.search === '' &&
    window.location.hash === '';
  if (alreadyHome) return;
  if (options?.replace) window.history.replaceState(window.history.state, '', '/');
  else window.history.pushState(window.history.state, '', '/');
  notifyAppNavigation();
}

export function navigateToPath(
  path: '/login' | '/register' | '/',
  options?: { replace?: boolean },
): void {
  if (
    window.location.pathname === path &&
    window.location.search === '' &&
    window.location.hash === ''
  ) {
    return;
  }
  if (options?.replace) window.history.replaceState(window.history.state, '', path);
  else window.history.pushState(window.history.state, '', path);
  notifyAppNavigation();
}

export function authViewFromPath(pathname: string): 'login' | 'register' | 'landing' {
  if (pathname === '/login' || pathname === '/login/') return 'login';
  if (pathname === '/register' || pathname === '/register/') return 'register';
  return 'landing';
}

export function useAppLocation(): { pathname: string; search: string; hash: string } {
  const [location, setLocation] = useState(currentLocationSnapshot);
  useEffect(() => {
    const sync = () => setLocation(currentLocationSnapshot());
    window.addEventListener(APP_NAVIGATE_EVENT, sync);
    return () => window.removeEventListener(APP_NAVIGATE_EVENT, sync);
  }, []);
  return location;
}

export function installInAppNavigation(): () => void {
  const onClick = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href) return;
    if (
      !shouldInterceptInAppLink({
        defaultPrevented: event.defaultPrevented,
        button: event.button,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        target: anchor.getAttribute('target'),
        download: anchor.hasAttribute('download'),
      })
    ) {
      return;
    }
    const destination = resolveInAppNavigation(href, window.location.origin);
    if (!destination) return;
    event.preventDefault();
    if (destination.type === 'home') navigateHome();
    else if (destination.type === 'path') navigateToPath(destination.path);
    else navigateToPage(destination.pageId, { hash: destination.hash });
  };
  const onPopState = () => notifyAppNavigation();
  document.addEventListener('click', onClick);
  window.addEventListener('popstate', onPopState);
  return () => {
    document.removeEventListener('click', onClick);
    window.removeEventListener('popstate', onPopState);
  };
}
