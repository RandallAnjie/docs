import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) return listSourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) && !entry.endsWith('.test.ts') ? [path] : [];
  });
}

describe('in-app dialogs', () => {
  it('does not use browser alert, prompt, or confirm in the web app', () => {
    const files = listSourceFiles(new URL('.', import.meta.url).pathname);
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const matches = source.match(/window\.(alert|prompt|confirm)\s*\(/g);
      if (matches?.length) offenders.push(`${file}: ${matches.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
