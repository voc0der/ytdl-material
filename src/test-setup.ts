// Give the specs a plain, stable Storage for localStorage and sessionStorage.
//
// jsdom implements both as accessors bound to its own window wrapper. Vitest copies the
// property descriptors onto globalThis, where that internal binding no longer resolves the
// same way, and what comes back varies by environment: locally the getter yields undefined
// (so PostsService fails on construction), while on CI it returns an object whose identity is
// not stable across reads, so a vi.spyOn installed on one read is missing on the next.
//
// Installing unconditionally rather than only when the getter looks broken keeps the two
// environments identical, which is the only way specs that spy on storage can be reliable.

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

for (const name of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, name, {
    value: createStorage(),
    configurable: true,
    writable: true
  });
}
