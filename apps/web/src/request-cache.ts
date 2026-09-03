const inflight = new Map<string, Promise<unknown>>();

export function cachedRequest<T>(key: string, load: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const pending = load().finally(() => {
    globalThis.setTimeout(() => {
      if (inflight.get(key) === pending) inflight.delete(key);
    }, 15_000);
  });
  inflight.set(key, pending);
  return pending;
}

export function clearCachedRequest(key?: string): void {
  if (key) inflight.delete(key);
  else inflight.clear();
}
