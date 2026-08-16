export const SIDEBAR_COLLAPSED_KEY = 'rdocs:sidebar-collapsed';
export const DESKTOP_SIDEBAR_QUERY = '(min-width: 761px)';
export const HOVER_PEEK_QUERY = '(hover: hover) and (pointer: fine) and (min-width: 761px)';
export const SIDEBAR_UNPEEK_DELAY_MS = 180;

export function readSidebarCollapsed(storage?: Pick<Storage, 'getItem'> | null): boolean {
  try {
    return storage?.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(
  collapsed: boolean,
  storage?: Pick<Storage, 'setItem'> | null,
): void {
  try {
    storage?.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Private mode and quota errors should not break chrome.
  }
}

export function matchesMediaQuery(
  query: string,
  mediaWindow: Pick<Window, 'matchMedia'> | null | undefined = typeof window === 'undefined'
    ? null
    : window,
): boolean {
  try {
    return Boolean(mediaWindow?.matchMedia(query).matches);
  } catch {
    return false;
  }
}

export function shouldIgnoreSidebarShortcut(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object' || !('closest' in target)) return false;
  const closest = (target as { closest?: (selector: string) => unknown }).closest;
  if (typeof closest !== 'function') return false;
  return Boolean(closest.call(target, 'input, textarea, select, [contenteditable="true"]'));
}

export function isSidebarToggleKey(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>,
): boolean {
  if (event.altKey) return false;
  if (event.key === '[' && !event.metaKey && !event.ctrlKey) return true;
  return event.key === '\\' && (event.metaKey || event.ctrlKey);
}

export function appShellClassName(input: {
  publicShare?: boolean;
  publicSiteTheme?: string | null;
  sidebarCollapsed?: boolean;
  sidebarPeek?: boolean;
  contextPanelOpen?: boolean;
}): string {
  return [
    'app-shell',
    input.publicShare ? 'public-share' : '',
    input.publicSiteTheme ? `public-site theme-${input.publicSiteTheme}` : '',
    input.sidebarCollapsed ? 'sidebar-collapsed' : '',
    input.sidebarCollapsed && input.sidebarPeek ? 'sidebar-peek' : '',
    input.contextPanelOpen ? 'context-panel-open' : '',
  ]
    .filter(Boolean)
    .join(' ');
}
