/**
 * Lightweight IndexedDB key-value cache with synchronous in-memory mirror.
 * Avoids localStorage's 5MB QuotaExceededError when storing large question banks.
 */

const DB_NAME = 'master_quiz_kh_cache_v1';
const STORE_NAME = 'kv';

const memoryMirror = new Map<string, unknown>();
let dbPromise: Promise<IDBDatabase | null> | null = null;
let hydrated = false;
let hydratePromise: Promise<void> | null = null;

function openCacheDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

  return dbPromise;
}

export function isCacheHydratedFromIdb(): boolean {
  return hydrated;
}

export async function hydrateCacheFromIdb(): Promise<void> {
  if (hydrated) return;
  if (hydratePromise) return hydratePromise;

  hydratePromise = (async () => {
    const db = await openCacheDb();
    if (!db) {
      hydrated = true;
      return;
    }

    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            if (!memoryMirror.has(String(cursor.key))) {
              memoryMirror.set(String(cursor.key), cursor.value);
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        req.onerror = () => resolve();
      } catch {
        resolve();
      }
    });

    hydrated = true;
  })();

  return hydratePromise;
}

export function getCachedValue<T>(key: string, fallback: T): T {
  if (memoryMirror.has(key)) {
    return memoryMirror.get(key) as T;
  }
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as T;
      memoryMirror.set(key, parsed);
      return parsed;
    }
  } catch {
    // Ignore parse/storage error
  }
  return fallback;
}

export function hasCachedValue(key: string): boolean {
  if (memoryMirror.has(key)) return true;
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

export function setCachedValue<T>(key: string, value: T): void {
  memoryMirror.set(key, value);

  // Best-effort small mirror in localStorage (silently skips if >5MB quota)
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length < 1_500_000) {
      localStorage.setItem(key, serialized);
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // Ignore 5MB localStorage quota; IndexedDB handles large payloads
  }

  void openCacheDb().then((db) => {
    if (!db) return;
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(value, key);
    } catch {
      // Ignore IDB write error
    }
  });
}
