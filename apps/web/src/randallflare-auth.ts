/**
 * Rdocs signs in through the RandallFlare gateway: `/__rf_access/login`
 * sends the visitor to RandallFlare and back to `rd`, and
 * `/__rf_access/logout` drops this app's sign-in. Both are served by the
 * edge, never by the Rdocs bundle, so they must be full page loads.
 */
export const DEFAULT_LOGIN_PATH = '/__rf_access/login';
export const DEFAULT_LOGOUT_PATH = '/__rf_access/logout';

const AUTH_ALIASES = new Set(['/login', '/login/', '/register', '/register/']);

/** The in-app place to come back to: the current URL, or home for the old /login and /register. */
export function returnPath(location: { pathname: string; search: string; hash: string }): string {
  if (AUTH_ALIASES.has(location.pathname)) return '/';
  const path = location.pathname.startsWith('/') ? location.pathname : '/';
  // `//host` would be read as another origin by a lax resolver.
  const safe = path.startsWith('//') ? '/' : path;
  return `${safe}${location.search}${location.hash}`;
}

export function randallFlareLoginUrl(
  location: { pathname: string; search: string; hash: string },
  loginPath = DEFAULT_LOGIN_PATH,
): string {
  return `${loginPath}?rd=${encodeURIComponent(returnPath(location))}`;
}

export function randallFlareLogoutUrl(logoutPath = DEFAULT_LOGOUT_PATH, back = '/'): string {
  return `${logoutPath}?rd=${encodeURIComponent(back)}`;
}
