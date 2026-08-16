import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  appShellClassName,
  isSidebarToggleKey,
  readSidebarCollapsed,
  searchShortcutLabel,
  shouldIgnoreSidebarShortcut,
  SIDEBAR_COLLAPSED_KEY,
  writeSidebarCollapsed,
} from './sidebar-chrome';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    key(index: number) {
      return [...data.keys()][index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
}

describe('sidebar chrome helpers', () => {
  it('reads and writes the collapsed preference', () => {
    const storage = memoryStorage();
    expect(readSidebarCollapsed(storage)).toBe(false);
    writeSidebarCollapsed(true, storage);
    expect(storage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('1');
    expect(readSidebarCollapsed(storage)).toBe(true);
    writeSidebarCollapsed(false, storage);
    expect(readSidebarCollapsed(storage)).toBe(false);
  });

  it('survives missing storage', () => {
    expect(readSidebarCollapsed(null)).toBe(false);
    expect(() => writeSidebarCollapsed(true, null)).not.toThrow();
  });

  it('toggles with [ and cmd/ctrl+\\ outside fields', () => {
    expect(isSidebarToggleKey({ key: '[', metaKey: false, ctrlKey: false, altKey: false })).toBe(
      true,
    );
    expect(isSidebarToggleKey({ key: '\\', metaKey: true, ctrlKey: false, altKey: false })).toBe(
      true,
    );
    expect(isSidebarToggleKey({ key: '\\', metaKey: false, ctrlKey: true, altKey: false })).toBe(
      true,
    );
    expect(isSidebarToggleKey({ key: '[', metaKey: true, ctrlKey: false, altKey: false })).toBe(
      false,
    );
    expect(isSidebarToggleKey({ key: 'k', metaKey: true, ctrlKey: false, altKey: false })).toBe(
      false,
    );
  });

  it('does not steal keys from the editor or inputs', () => {
    const field = {
      closest: (selector: string) =>
        selector.includes('input') || selector.includes('contenteditable') ? field : null,
    };
    const button = { closest: () => null };
    expect(shouldIgnoreSidebarShortcut(field as unknown as EventTarget)).toBe(true);
    expect(shouldIgnoreSidebarShortcut(button as unknown as EventTarget)).toBe(false);
    expect(shouldIgnoreSidebarShortcut(null)).toBe(false);
  });

  it('labels the search shortcut for the current platform', () => {
    expect(searchShortcutLabel('Mozilla/5.0 (Macintosh)')).toBe('⌘ K');
    expect(searchShortcutLabel('Mozilla/5.0 (X11; Linux x86_64)')).toBe('Ctrl K');
  });

  it('keeps peek as an overlay class on the collapsed shell', () => {
    expect(
      appShellClassName({
        sidebarCollapsed: true,
        sidebarPeek: true,
        contextPanelOpen: true,
        publicShare: true,
        publicSiteTheme: 'light',
      }),
    ).toBe(
      'app-shell public-share public-site theme-light sidebar-collapsed sidebar-peek context-panel-open',
    );
    expect(appShellClassName({ sidebarCollapsed: false, sidebarPeek: true })).toBe('app-shell');
  });

  it('does not keep a cramped icon rail that stacks the avatar and expand control', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');
    expect(css).not.toMatch(/grid-template-columns:\s*58px/);
    expect(css).toMatch(/\.app-shell\.sidebar-collapsed\s*\{[^}]*minmax\(520px, 1fr\)/s);
    expect(css).toMatch(/\.app-shell\.sidebar-collapsed \.sidebar\s*\{[^}]*position:\s*fixed/s);
    expect(css).toMatch(/\.header-leading/);
    expect(css).toMatch(/\.header-account/);
  });
});
