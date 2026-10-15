/**
 * Storage helpers.
 *
 * IMPORTANT: we only ever touch *our own* caches. We never call
 * `caches.keys().forEach(delete)` (which would wipe unrelated apps' caches on a
 * shared origin) and we only delete IndexedDB databases whose names we own.
 */

/** Cache Storage entries created by transformers.js on our behalf. */
const OWNED_CACHE_PATTERN = /^transformers(-|$)/i;

/** IndexedDB databases we consider ours (transformers.js / onnx runtime). */
const OWNED_DB_PATTERN = /^(transformers|onnx)/i;

/** Prefix for our own `localStorage` keys. */
export const PREF_PREFIX = "tabai:";

export interface StorageEstimate {
  usage: number | null;
  quota: number | null;
}

export async function estimateStorage(): Promise<StorageEstimate> {
  try {
    if (navigator.storage?.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage: usage ?? null, quota: quota ?? null };
    }
  } catch {
    // Storage API unavailable (private mode, permissions, ...).
  }
  return { usage: null, quota: null };
}

/** Names of our Cache Storage entries currently present. */
export async function listOwnedCaches(): Promise<string[]> {
  if (typeof caches === "undefined" || !caches.keys) return [];
  try {
    const keys = await caches.keys();
    return keys.filter((name) => OWNED_CACHE_PATTERN.test(name));
  } catch {
    return [];
  }
}

/** Names of our IndexedDB databases currently present. */
export async function listOwnedDatabases(): Promise<string[]> {
  try {
    const idb = indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> };
    if (typeof idb?.databases === "function") {
      const dbs = await idb.databases();
      return dbs.map((db) => db.name).filter((name): name is string => Boolean(name) && OWNED_DB_PATTERN.test(name as string));
    }
  } catch {
    // `indexedDB.databases()` is not universally available.
  }
  return [];
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

/**
 * Delete only the caches we created (Cache Storage + our IndexedDB databases).
 * Returns a short human-readable summary of what was removed.
 */
export async function clearModelCache(): Promise<string> {
  const removed: string[] = [];

  const cacheNames = await listOwnedCaches();
  for (const name of cacheNames) {
    try {
      if (await caches.delete(name)) removed.push(name);
    } catch {
      /* ignore */
    }
  }

  const dbNames = await listOwnedDatabases();
  for (const name of dbNames) {
    await deleteDatabase(name);
    removed.push(name);
  }

  return removed.length > 0 ? removed.join(", ") : "nothing to clear";
}

/** Remove any `localStorage` keys written by this app. */
export function clearAppPreferences(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(PREF_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function readPref<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREF_PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writePref<T>(key: string, value: T): void {
  try {
    localStorage.setItem(PREF_PREFIX + key, JSON.stringify(value));
  } catch {
    /* ignore quota / disabled storage */
  }
}
