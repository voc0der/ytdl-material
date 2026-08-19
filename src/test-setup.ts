// jsdom implements localStorage as an accessor bound to its own window wrapper. Vitest copies
// the property descriptor onto globalThis, where that internal binding no longer resolves, so
// the getter yields undefined even though 'localStorage' in window is true. PostsService reads
// localStorage while constructing, so install a working in-memory Storage when that happens.

function createStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    key(index: number) {
      return Array.from(entries.keys())[index] ?? null;
    },
    getItem(key: string) {
      return entries.has(key) ? entries.get(key) : null;
    },
    setItem(key: string, value: string) {
      entries.set(key, String(value));
    },
    removeItem(key: string) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    }
  } as Storage;
}

function isUsable(name: string): boolean {
  try {
    const existing = (globalThis as any)[name];
    return !!existing && typeof existing.getItem === 'function';
  } catch {
    // jsdom throws for an opaque origin rather than returning undefined.
    return false;
  }
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  if (!isUsable(name)) {
    Object.defineProperty(globalThis, name, {
      value: createStorage(),
      configurable: true,
      writable: true
    });
  }
}
