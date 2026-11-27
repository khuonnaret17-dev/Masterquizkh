import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged,
  User as FirebaseUser,
} from 'firebase/auth';
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getDocsFromCache,
  getCountFromServer,
  collection,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  setDoc,
  deleteDoc,
  updateDoc,
  writeBatch,
  increment,
  onSnapshot,
  Query,
  QueryConstraint,
  QueryDocumentSnapshot,
  QuerySnapshot,
  DocumentData,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import {
  Question,
  Subject,
  Feedback,
  AppNotification,
  LoginRecord,
  PresenceRecord,
  PaidUser,
  BotCommandConfig,
  GlobalStats,
} from '../types';
import { INITIAL_NOTIFICATIONS } from './initialData';
import { syncTelegramBotTemplates } from './telegram';
import {
  hydrateCacheFromIdb,
  getCachedValue,
  hasCachedValue,
  setCachedValue,
} from './localCacheDb';
import {
  connectSupabaseRealtime,
  broadcastClientSupabaseSync,
  fetchRealtimeConfig,
  ClientRealtimeDeltaEvent,
} from './supabaseClient';

// Strict maximum items per single Firestore list query (aligned with firestore.rules limit <= 20)
export const MAX_QUERY_LIMIT = 20;

export type PaginationCursor = QueryDocumentSnapshot<DocumentData> | number | null;

export interface PaginatedPageResult<T> {
  items: T[];
  lastDoc: PaginationCursor;
  hasMore: boolean;
}

type DbBackendType = 'supabase' | 'firestore';
let detectedDbBackend: DbBackendType | null = null;
let backendDetectPromise: Promise<DbBackendType> | null = null;

export type DbModeType = 'dual' | 'supabase' | 'firestore';

export async function fetchDbMode(): Promise<{
  mode: DbModeType;
  backend: DbBackendType;
  supabaseConfigured: boolean;
}> {
  try {
    const res = await fetch('/api/db/mode', { cache: 'no-store' });
    if (!res.ok) return { mode: 'dual', backend: 'supabase', supabaseConfigured: false };
    const data = await res.json();
    return {
      mode: data?.mode || 'dual',
      backend: data?.backend === 'firestore' ? 'firestore' : 'supabase',
      supabaseConfigured: Boolean(data?.supabaseConfigured),
    };
  } catch {
    return { mode: 'dual', backend: 'supabase', supabaseConfigured: false };
  }
}

export async function getDbExecutionTargets(): Promise<{
  mode: DbModeType;
  useSupabase: boolean;
  useFirestore: boolean;
}> {
  const info = await fetchDbMode();
  const mode = info.mode || 'dual';
  if (mode === 'dual') {
    return {
      mode: 'dual',
      useSupabase: info.supabaseConfigured !== false,
      useFirestore: true,
    };
  }
  if (mode === 'supabase') {
    return {
      mode: 'supabase',
      useSupabase: true,
      useFirestore: false,
    };
  }
  return {
    mode: 'firestore',
    useSupabase: false,
    useFirestore: true,
  };
}

export async function setDbMode(mode: DbModeType): Promise<DbModeType> {
  const res = await dbApiRequest('/api/db/mode', {
    method: 'POST',
    body: JSON.stringify({ mode }),
  });
  detectedDbBackend = null;
  return res?.mode || mode;
}

async function ensureDbBackend(): Promise<DbBackendType> {
  if (detectedDbBackend) return detectedDbBackend;
  if (backendDetectPromise) return backendDetectPromise;
  backendDetectPromise = fetchDbMode()
    .then((info) => {
      const b = info.backend;
      detectedDbBackend = b;
      return b;
    })
    .catch(() => 'firestore' as DbBackendType)
    .finally(() => {
      backendDetectPromise = null;
    });
  return backendDetectPromise;
}

const ADMIN_SESSION_TOKEN_KEY = 'mpq_admin_session_token_v1';
const LOCAL_BROADCAST_CHANNEL_NAME = 'master-quiz-kh-sync';

export function getAdminSessionToken(): string | null {
  try {
    const token = localStorage.getItem(ADMIN_SESSION_TOKEN_KEY);
    return token && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

export function clearAdminSessionToken(): void {
  try {
    localStorage.removeItem(ADMIN_SESSION_TOKEN_KEY);
  } catch {
    // Ignore storage error
  }
}

export async function loginAdminWithPasscode(passcode: string): Promise<boolean> {
  const res = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: passcode.trim() }),
    cache: 'no-store',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success || !data?.token) {
    throw new Error(data?.error || 'លេខកូដ Master Code មិនត្រឹមត្រូវទេ!');
  }
  try {
    localStorage.setItem(ADMIN_SESSION_TOKEN_KEY, String(data.token));
  } catch {
    // Ignore storage error
  }
  return true;
}

export type AdminSessionVerification = 'valid' | 'invalid' | 'network_error';

export async function verifyAdminSession(): Promise<AdminSessionVerification> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'network_error';
  }
  try {
    const authHeader = await getAuthBearerHeader();
    const adminToken = getAdminSessionToken();
    if (!authHeader && !adminToken) return 'invalid';
    const headers: Record<string, string> = {};
    if (authHeader) headers['Authorization'] = authHeader;
    if (adminToken) headers['X-Admin-Token'] = adminToken;
    const res = await fetch('/api/admin/verify', { headers, cache: 'no-store' });
    if (res.ok) return 'valid';
    if (res.status === 401 || res.status === 403) return 'invalid';
    return 'network_error';
  } catch {
    return 'network_error';
  }
}

function notifyRealtimeMutation(event: ClientRealtimeDeltaEvent) {
  const payload: ClientRealtimeDeltaEvent = {
    ...event,
    ts: event.ts ?? Date.now(),
  };
  // Instant <5ms sync across tabs in the same browser
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      const bc = new BroadcastChannel(LOCAL_BROADCAST_CHANNEL_NAME);
      bc.postMessage(payload);
      bc.close();
    } catch {
      // Ignore BroadcastChannel unavailability
    }
  }
  // Instant cross-device / cross-instance sync via Supabase Realtime Broadcast
  void broadcastClientSupabaseSync(payload);
}

async function dbApiRequest<T = any>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const authHeader = await getAuthBearerHeader();
  const adminToken = getAdminSessionToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };
  if (authHeader) {
    headers['Authorization'] = authHeader;
  }
  if (adminToken) {
    headers['X-Admin-Token'] = adminToken;
  }
  const res = await fetch(url, {
    ...options,
    headers,
    cache: 'no-store',
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(payload?.error || `Database API error (${res.status})`);
  }
  return payload as T;
}

// Initialize Firebase App, Auth, & Firestore with persistent IndexedDB local cache
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

export const db = (() => {
  try {
    return initializeFirestore(
      app,
      {
        localCache: persistentLocalCache({
          tabManager: persistentMultipleTabManager(),
        }),
      },
      firebaseConfig.firestoreDatabaseId
    );
  } catch {
    return getFirestore(app, firebaseConfig.firestoreDatabaseId);
  }
})();

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid || null,
      email: auth.currentUser?.email || null,
      emailVerified: auth.currentUser?.emailVerified ?? null,
      isAnonymous: auth.currentUser?.isAnonymous ?? null,
      tenantId: auth.currentUser?.tenantId || null,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.warn('Firestore Operation Info: ', JSON.stringify(errInfo));
}

// Handle OAuth redirect completion (used automatically when iOS Home Screen PWA blocks popups)
void getRedirectResult(auth)
  .then((res) => {
    if (res?.user) {
      try {
        localStorage.removeItem('mpq_conn_tested_at_v2');
      } catch {
        // Ignore storage error
      }
      void testConnection(true);
    }
  })
  .catch(() => {
    // Ignore no-op or blocked redirect errors
  });

// Auth Helpers (with proper unsubscribe cleanup support)
export function subscribeAuthState(callback: (user: FirebaseUser | null) => void): () => void {
  return onAuthStateChanged(auth, callback);
}

export async function signInWithGoogle(): Promise<FirebaseUser | null> {
  const isStandalonePWA =
    typeof window !== 'undefined' &&
    (window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true);

  try {
    const result = await signInWithPopup(auth, googleProvider);
    // Reset connection test & core check so newly authenticated user can sync immediately
    try {
      localStorage.removeItem('mpq_conn_tested_at_v2');
    } catch {
      // Ignore storage error
    }
    void testConnection(true);
    return result.user;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code || '';
    const shouldFallbackRedirect =
      isStandalonePWA ||
      code === 'auth/popup-blocked' ||
      code === 'auth/operation-not-supported-in-this-environment';
    if (shouldFallbackRedirect) {
      await signInWithRedirect(auth, googleProvider);
      return null;
    }
    throw err;
  }
}

export async function signOutFirebase(): Promise<void> {
  await signOut(auth);
}

async function getAuthBearerHeader(): Promise<string | undefined> {
  if (!auth.currentUser) return undefined;
  try {
    const token = await auth.currentUser.getIdToken();
    return token ? `Bearer ${token}` : undefined;
  } catch {
    return undefined;
  }
}

// Startup Connection Validation (runs only if Firestore backend is active)
async function testConnection(force = false) {
  try {
    const backend = await ensureDbBackend();
    if (backend === 'supabase') return;
    if (!auth.currentUser) return;
    const lastTested = Number(localStorage.getItem('mpq_conn_tested_at_v2') || '0');
    if (!force && lastTested && Date.now() - lastTested < 24 * 60 * 60 * 1000) {
      return;
    }
    localStorage.setItem('mpq_conn_tested_at_v2', String(Date.now()));
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn('Firebase client in offline/cache mode');
    }
  }
}
void testConnection();

// Local Cache Keys & Long TTLs to prevent hitting Firestore Read Quota
const STORAGE_KEYS = {
  QUESTIONS: 'mpq_cached_questions',
  SUBJECTS: 'mpq_cached_subjects',
  NOTIFICATIONS: 'mpq_cached_notifications',
  DISMISSED_NOTIFS: 'mpq_dismissed_notifs',
  FEEDBACKS: 'mpq_cached_feedbacks',
  LOGINS: 'mpq_cached_logins',
  PRESENCE: 'mpq_cached_presence',
  PAID_USERS: 'mpq_cached_paid_users',
  BOT_COMMANDS: 'mpq_cached_bot_commands',
  GLOBAL_STATS: 'mpq_cached_global_stats_v1',
  SYNC_META: 'mpq_sync_meta_v2',
  CORE_SERVER_VERSION: 'mpq_core_server_version_v1',
  ONLINE_COUNT: 'mpq_cached_online_count_v1',
  LAST_PRESENCE_PING: 'mpq_last_presence_ping_v1',
};

const SYNC_TTLS_MS = {
  QUESTIONS: 6 * 60 * 60 * 1000, // 6 hours client cache (server RAM shares across all users)
  SUBJECTS: 6 * 60 * 60 * 1000, // 6 hours
  BOT_COMMANDS: 6 * 60 * 60 * 1000, // 6 hours
  NOTIFICATIONS: 30 * 60 * 1000, // 30 minutes
  PAID_USERS: 15 * 60 * 1000, // 15 minutes
  GLOBAL_STATS: 15 * 60 * 1000, // 15 minutes
  LOGINS: 5 * 60 * 1000, // 5 minutes (Admin only, 20 per page)
  FEEDBACKS: 5 * 60 * 1000, // 5 minutes (Admin only, 20 per page)
  PRESENCE: 2 * 60 * 1000, // 2 minutes (Admin only, 20 per page)
  ONLINE_COUNT: 5 * 60 * 1000, // 5 minutes (1 shared aggregation read)
  CORE_CHECK: 5 * 60 * 1000, // Check /api/cache/core version every 5 minutes
};

type SyncKey = keyof typeof SYNC_TTLS_MS;

function getLocal<T>(key: string, fallback: T): T {
  return getCachedValue<T>(key, fallback);
}

function setLocal<T>(key: string, data: T) {
  setCachedValue<T>(key, data);
}

function getSyncTimestamp(key: SyncKey): number {
  const meta = getLocal<Partial<Record<SyncKey, number>>>(STORAGE_KEYS.SYNC_META, {});
  return typeof meta[key] === 'number' ? meta[key]! : 0;
}

function setSyncTimestamp(key: SyncKey, timestamp = Date.now()) {
  const meta = getLocal<Partial<Record<SyncKey, number>>>(STORAGE_KEYS.SYNC_META, {});
  meta[key] = timestamp;
  setLocal(STORAGE_KEYS.SYNC_META, meta);
}

function isCacheFresh(key: SyncKey, storageKey?: string, requireNonEmptyArray = false): boolean {
  const lastSync = getSyncTimestamp(key);
  if (!lastSync) return false;
  if (storageKey) {
    if (!hasCachedValue(storageKey)) return false;
    if (requireNonEmptyArray) {
      const val = getLocal<unknown>(storageKey, null);
      if (Array.isArray(val) && val.length === 0) return false;
      if (val && typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length === 0) {
        return false;
      }
    }
  }
  return Date.now() - lastSync < SYNC_TTLS_MS[key];
}

// Deduplicate concurrent network fetches across components / StrictMode mounts
const inFlightFetches = new Map<string, Promise<unknown>>();
let clientQuotaCooldownUntil = 0;

function isQuotaCooldownActive(force = false): boolean {
  return !force && Date.now() < clientQuotaCooldownUntil;
}

function markClientQuotaCooldownIfNeeded(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err || '');
  if (msg.includes('resource-exhausted') || msg.includes('Quota') || msg.includes('429')) {
    clientQuotaCooldownUntil = Date.now() + 5 * 60 * 1000;
  }
}

function runDeduplicated<T>(key: string, task: () => Promise<T>): Promise<T> {
  const existing = inFlightFetches.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const promise = task().finally(() => {
    inFlightFetches.delete(key);
  });
  inFlightFetches.set(key, promise);
  return promise;
}

const sortQuestions = (list: Question[]) =>
  [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

const sortSubjects = (list: Subject[]) =>
  [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

type ServerCacheMutationPayload =
  | { action: 'upsert'; item: unknown }
  | { action: 'upsertMany'; items: unknown[] }
  | { action: 'delete'; id: string }
  | { action: 'clear' }
  | { replace: unknown; authoritative?: boolean };

function syncMutationToServerCache(
  scope: 'questions' | 'subjects' | 'notifications' | 'bot_commands',
  payload: ServerCacheMutationPayload
) {
  const adminToken = getAdminSessionToken();
  if (typeof fetch === 'undefined' || (!auth.currentUser && !adminToken)) return;
  void getAuthBearerHeader()
    .then((authHeader) => {
      if (!authHeader && !adminToken) return null;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (authHeader) headers['Authorization'] = authHeader;
      if (adminToken) headers['X-Admin-Token'] = adminToken;
      return fetch('/api/cache/mutate', {
        method: 'POST',
        headers,
        body: JSON.stringify({ scope, ...payload }),
      });
    })
    .then(async (res) => {
      if (res && res.ok) {
        const data = await res.json().catch(() => null);
        if (typeof data?.version === 'number') {
          setLocal(STORAGE_KEYS.CORE_SERVER_VERSION, data.version);
          if (hasNonEmptyCoreArrays()) {
            setSyncTimestamp('CORE_CHECK');
          }
        }
      }
    })
    .catch(() => {
      // Ignore when running purely offline
    });
}

function hasNonEmptyCoreArrays(): boolean {
  const qs = getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []);
  const subs = getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []);
  return Array.isArray(qs) && qs.length > 0 && Array.isArray(subs) && subs.length > 0;
}

function resolveNotificationsWithDismissed(rawNotifs: AppNotification[]): AppNotification[] {
  const dismissed = new Set<string>(getLocal<string[]>(STORAGE_KEYS.DISMISSED_NOTIFS, []));
  if (rawNotifs.length > 0) {
    const filtered = rawNotifs.filter((n) => !dismissed.has(n.id));
    filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return filtered;
  }
  const hasStored = hasCachedValue(STORAGE_KEYS.NOTIFICATIONS);
  if (dismissed.has('__ALL__') || hasStored) {
    return [];
  }
  return INITIAL_NOTIFICATIONS.filter((n) => !dismissed.has(n.id));
}

/**
 * Reusable Cursor Pagination Helper (strictly <= 20 items per query using limit() + startAfter())
 */
async function fetchCollectionPageFromFirestore<T>(
  collectionName: string,
  constraints: QueryConstraint[],
  cursorDoc: QueryDocumentSnapshot<DocumentData> | null,
  mapDoc: (d: QueryDocumentSnapshot<DocumentData>) => T,
  forceServer = false,
  useCacheFirst = true
): Promise<PaginatedPageResult<T>> {
  const pageConstraints = cursorDoc
    ? [...constraints, startAfter(cursorDoc), limit(MAX_QUERY_LIMIT)]
    : [...constraints, limit(MAX_QUERY_LIMIT)];
  const q = query(collection(db, collectionName), ...pageConstraints);

  if (!forceServer && useCacheFirst) {
    const cachedSnap = await getDocsFromCache(q).catch(() => null);
    if (cachedSnap && !cachedSnap.empty) {
      const items: T[] = [];
      cachedSnap.forEach((d) => items.push(mapDoc(d)));
      return {
        items,
        lastDoc: cachedSnap.docs[cachedSnap.docs.length - 1] || null,
        hasMore: cachedSnap.docs.length === MAX_QUERY_LIMIT,
      };
    }
  }

  if (!auth.currentUser) {
    if (useCacheFirst) {
      return { items: [], lastDoc: null, hasMore: false };
    }
    const cachedSnap = await getDocsFromCache(q).catch(() => null);
    if (cachedSnap && !cachedSnap.empty) {
      const items: T[] = [];
      cachedSnap.forEach((d) => items.push(mapDoc(d)));
      return {
        items,
        lastDoc: cachedSnap.docs[cachedSnap.docs.length - 1] || null,
        hasMore: cachedSnap.docs.length === MAX_QUERY_LIMIT,
      };
    }
    return { items: [], lastDoc: null, hasMore: false };
  }

  const snap = await getDocs(q);
  const items: T[] = [];
  snap.forEach((d) => items.push(mapDoc(d)));
  return {
    items,
    lastDoc: snap.docs[snap.docs.length - 1] || null,
    hasMore: snap.docs.length === MAX_QUERY_LIMIT,
  };
}

/**
 * Paginated sequential cursor loader for full datasets (uses limit(20) + startAfter() per page).
 * Always queries Firestore directly when online & authenticated so partial local IndexedDB cache
 * never truncates pagination mid-way. Falls back to offline cache only if offline or unauthenticated.
 */
async function fetchAllPagesWithLimit20<T>(
  collectionName: string,
  constraints: QueryConstraint[],
  mapDoc: (d: QueryDocumentSnapshot<DocumentData>) => T,
  forceServer = false,
  maxPages = 500
): Promise<T[]> {
  const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const shouldUseCacheOnly = !forceServer && isOffline;

  const runLoop = async (cacheOnly: boolean): Promise<T[]> => {
    const collected: T[] = [];
    let cursorDoc: QueryDocumentSnapshot<DocumentData> | null = null;
    let pageCount = 0;

    while (pageCount < maxPages) {
      const pageConstraints: QueryConstraint[] = cursorDoc
        ? [...constraints, startAfter(cursorDoc), limit(MAX_QUERY_LIMIT)]
        : [...constraints, limit(MAX_QUERY_LIMIT)];
      const q: Query<DocumentData> = query(collection(db, collectionName), ...pageConstraints);

      const snap: QuerySnapshot<DocumentData> = cacheOnly
        ? await getDocsFromCache(q)
        : await getDocs(q);
      snap.forEach((d: QueryDocumentSnapshot<DocumentData>) => collected.push(mapDoc(d)));
      pageCount += 1;

      if (snap.docs.length < MAX_QUERY_LIMIT || snap.docs.length === 0) {
        break;
      }
      cursorDoc = snap.docs[snap.docs.length - 1];
    }

    return collected;
  };

  if (shouldUseCacheOnly) {
    return runLoop(true).catch(() => []);
  }

  try {
    return await runLoop(false);
  } catch (err) {
    // Only fall back to local IndexedDB pages if network/offline failure occurred
    const cached = await runLoop(true).catch(() => []);
    if (cached.length > 0) return cached;
    throw err;
  }
}

// Non-blocking atomic counter helper on stats/global
function adjustGlobalStat(field: keyof Omit<GlobalStats, 'updatedAt'>, delta: number) {
  if (!auth.currentUser || delta === 0) return;
  const cached = getLocal<GlobalStats>(STORAGE_KEYS.GLOBAL_STATS, {});
  const currentVal = Number(cached[field] || 0);
  const nextStats: GlobalStats = {
    ...cached,
    [field]: Math.max(0, currentVal + delta),
    updatedAt: new Date().toISOString(),
  };
  setLocal(STORAGE_KEYS.GLOBAL_STATS, nextStats);
  window.dispatchEvent(new CustomEvent('mpq-global-stats-changed', { detail: nextStats }));

  void setDoc(
    doc(db, 'stats', 'global'),
    {
      [field]: increment(delta),
      updatedAt: nextStats.updatedAt,
    },
    { merge: true }
  ).catch(() => {
    // Ignore non-critical counter sync error
  });
}

/**
 * Shared Server Cache Sync:
 * Fetches questions, subjects, notifications, and bot_commands from Node server RAM cache first
 * (0 Firestore reads for 99.9% of users), with IndexedDB + Firestore limit(20) fallback.
 */
async function syncCoreFromServer(force = false, bypassLocalTtl = false): Promise<boolean> {
  await hydrateCacheFromIdb();

  if (
    !force &&
    !bypassLocalTtl &&
    hasNonEmptyCoreArrays() &&
    (isQuotaCooldownActive(false) || isCacheFresh('CORE_CHECK'))
  ) {
    return true;
  }

  return runDeduplicated(`core_server:${force ? 'force' : bypassLocalTtl ? 'check' : 'ttl'}`, async () => {
    if (
      !force &&
      !bypassLocalTtl &&
      hasNonEmptyCoreArrays() &&
      (isQuotaCooldownActive(false) || isCacheFresh('CORE_CHECK'))
    ) {
      return true;
    }

    const requestCore = async (useSince: boolean) => {
      const localQuestions = getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []);
      const localSubjects = getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []);
      const hasAllLocal =
        localQuestions.length > 0 &&
        localSubjects.length > 0 &&
        hasCachedValue(STORAGE_KEYS.NOTIFICATIONS) &&
        hasCachedValue(STORAGE_KEYS.BOT_COMMANDS);
      const savedVersion = hasAllLocal
        ? getLocal<number>(STORAGE_KEYS.CORE_SERVER_VERSION, 0)
        : 0;

      const params = new URLSearchParams();
      if (force) params.set('force', '1');
      if (useSince && !force && savedVersion > 0) params.set('since', String(savedVersion));

      const authHeader = await getAuthBearerHeader();
      const adminToken = getAdminSessionToken();
      const headers: Record<string, string> = {};
      if (authHeader) headers['Authorization'] = authHeader;
      if (adminToken) headers['X-Admin-Token'] = adminToken;

      const res = await fetch(`/api/cache/core?${params.toString()}`, {
        cache: 'no-store',
        headers,
      });
      const payload = await res.json().catch(() => null);
      return { res, payload };
    };

    try {
      let { res, payload } = await requestCore(true);

      if (payload?.backend === 'supabase' || payload?.backend === 'firestore') {
        detectedDbBackend = payload.backend;
      }
      if (payload?.quotaLimited) {
        clientQuotaCooldownUntil = Date.now() + 5 * 60 * 1000;
      }

      if (!res.ok || !payload) {
        return false;
      }

      // Auto-backfill Supabase once when Admin opens app with cached local catalog while Supabase is empty
      const isAdminEmail =
        auth.currentUser?.email?.toLowerCase() === 'reaksmey8114@gmail.com' &&
        auth.currentUser?.emailVerified;
      if (
        !payload?.unchanged &&
        !payload?.partial &&
        payload?.backend === 'supabase' &&
        isAdminEmail &&
        Array.isArray(payload?.questions) &&
        payload.questions.length === 0
      ) {
        const localQ = getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []);
        const localS = getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []);
        const localN = getLocal<AppNotification[]>(STORAGE_KEYS.NOTIFICATIONS, []);
        const localBC = getLocal<Record<string, BotCommandConfig>>(STORAGE_KEYS.BOT_COMMANDS, {});
        const localPU = getLocal<PaidUser[]>(STORAGE_KEYS.PAID_USERS, []);
        if (localQ.length > 0 || localS.length > 0) {
          void dbApiRequest('/api/db/migrate', {
            method: 'POST',
            body: JSON.stringify({
              questions: localQ,
              subjects: localS,
              notifications: localN,
              botCommands: localBC,
              paidUsers: localPU,
            }),
          }).catch(() => {});
        }
      }

      if (payload?.unchanged) {
        if (!hasNonEmptyCoreArrays()) {
          // Local storage lost/empty despite version match — re-request full payload
          const retry = await requestCore(false);
          res = retry.res;
          payload = retry.payload;
          if (!res.ok || !payload) return false;
        } else {
          setSyncTimestamp('CORE_CHECK');
          setSyncTimestamp('QUESTIONS');
          setSyncTimestamp('SUBJECTS');
          setSyncTimestamp('NOTIFICATIONS');
          setSyncTimestamp('BOT_COMMANDS');
          return true;
        }
      }

      let updatedQuestionsCount: number | null = null;
      let updatedSubjectsCount: number | null = null;

      if (Array.isArray(payload?.questions) && (payload.questions.length > 0 || !payload?.partial)) {
        const sortedQ = sortQuestions(payload.questions);
        setLocal(STORAGE_KEYS.QUESTIONS, sortedQ);
        setSyncTimestamp('QUESTIONS');
        updatedQuestionsCount = sortedQ.length;
        window.dispatchEvent(new CustomEvent('mpq-questions-changed', { detail: sortedQ }));
      }

      if (Array.isArray(payload?.subjects) && (payload.subjects.length > 0 || !payload?.partial)) {
        const sortedSub = sortSubjects(payload.subjects);
        setLocal(STORAGE_KEYS.SUBJECTS, sortedSub);
        setSyncTimestamp('SUBJECTS');
        updatedSubjectsCount = sortedSub.length;
        window.dispatchEvent(new CustomEvent('mpq-subjects-changed', { detail: sortedSub }));
      }

      if (updatedQuestionsCount !== null || updatedSubjectsCount !== null) {
        const prevStats = getLocal<GlobalStats>(STORAGE_KEYS.GLOBAL_STATS, {});
        const nextStats: GlobalStats = {
          ...prevStats,
          ...(updatedQuestionsCount !== null ? { questionsCount: updatedQuestionsCount } : {}),
          ...(updatedSubjectsCount !== null ? { subjectsCount: updatedSubjectsCount } : {}),
        };
        setLocal(STORAGE_KEYS.GLOBAL_STATS, nextStats);
        window.dispatchEvent(new CustomEvent('mpq-global-stats-changed', { detail: nextStats }));
      }

      if (Array.isArray(payload?.notifications)) {
        const notifs = resolveNotificationsWithDismissed(payload.notifications);
        setLocal(STORAGE_KEYS.NOTIFICATIONS, notifs);
        setSyncTimestamp('NOTIFICATIONS');
        window.dispatchEvent(new CustomEvent('mpq-notifications-changed', { detail: notifs }));
      }

      if (payload?.botCommands && typeof payload.botCommands === 'object') {
        setLocal(STORAGE_KEYS.BOT_COMMANDS, payload.botCommands);
        setSyncTimestamp('BOT_COMMANDS');
        window.dispatchEvent(
          new CustomEvent('mpq-bot-commands-changed', { detail: payload.botCommands })
        );
      }

      const completeNow = !payload?.partial && hasNonEmptyCoreArrays();
      if (completeNow) {
        if (typeof payload?.version === 'number') {
          setLocal(STORAGE_KEYS.CORE_SERVER_VERSION, payload.version);
        }
        setSyncTimestamp('CORE_CHECK');
      }

      return completeNow;
    } catch {
      return false;
    }
  });
}

// ---------------- Cached Fetchers & Paginated Loaders ----------------

export async function fetchQuestionsCached(force = false): Promise<Question[]> {
  await hydrateCacheFromIdb();

  // Always perform a zero-DB-cost server version check (?since=<ver>) so refreshes pick up Admin changes immediately
  const syncedFromServer = await syncCoreFromServer(force, true);
  const afterServer = sortQuestions(getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []));
  if (syncedFromServer && afterServer.length > 0) {
    return afterServer;
  }

  if (
    !force &&
    isCacheFresh('CORE_CHECK') &&
    isCacheFresh('QUESTIONS', STORAGE_KEYS.QUESTIONS, true)
  ) {
    return sortQuestions(getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []));
  }

  return runDeduplicated(`questions:${force ? 'force' : 'ttl'}`, async () => {
    if (
      !force &&
      isCacheFresh('CORE_CHECK') &&
      isCacheFresh('QUESTIONS', STORAGE_KEYS.QUESTIONS, true)
    ) {
      return sortQuestions(getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []));
    }
    try {
      const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
      if (!isOffline && !isQuotaCooldownActive(force)) {
        const questions = await fetchAllPagesWithLimit20<Question>(
          'questions',
          [],
          (d) => ({ id: d.id, ...(d.data() as Omit<Question, 'id'>) }),
          true
        );
        if (questions.length > 0) {
          const sorted = sortQuestions(questions);
          setLocal(STORAGE_KEYS.QUESTIONS, sorted);
          setSyncTimestamp('QUESTIONS');
          syncMutationToServerCache('questions', { replace: sorted, authoritative: true });
          window.dispatchEvent(new CustomEvent('mpq-questions-changed', { detail: sorted }));
          return sorted;
        }
      }

      // Offline / unauthenticated fallback: read all paginated docs from IndexedDB persistence
      const cachedAll = await fetchAllPagesWithLimit20<Question>(
        'questions',
        [],
        (d) => ({ id: d.id, ...(d.data() as Omit<Question, 'id'>) }),
        false
      ).catch(() => []);
      if (cachedAll.length > 0) {
        const sorted = sortQuestions(cachedAll);
        const existingLocal = getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []);
        if (sorted.length >= existingLocal.length) {
          setLocal(STORAGE_KEYS.QUESTIONS, sorted);
          window.dispatchEvent(new CustomEvent('mpq-questions-changed', { detail: sorted }));
          return sorted;
        }
      }

      return sortQuestions(getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []));
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.LIST, 'questions');
      return sortQuestions(getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []));
    }
  });
}

export function subscribeQuestions(callback: (questions: Question[]) => void) {
  const cached = sortQuestions(getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []));
  if (cached.length > 0) {
    callback(cached);
  }

  const handleLocalChange = (e: Event) => {
    const customEvent = e as CustomEvent<Question[]>;
    if (Array.isArray(customEvent.detail)) {
      callback(sortQuestions(customEvent.detail));
    }
  };
  window.addEventListener('mpq-questions-changed', handleLocalChange);

  let active = true;
  void hydrateCacheFromIdb().then(() => {
    if (!active) return;
    const idbCached = sortQuestions(getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []));
    if (idbCached.length > 0 || hasCachedValue(STORAGE_KEYS.QUESTIONS)) {
      callback(idbCached);
    }
    void fetchQuestionsCached(false).then((fresh) => {
      if (active) callback(fresh);
    });
  });

  return () => {
    active = false;
    window.removeEventListener('mpq-questions-changed', handleLocalChange);
  };
}

export async function fetchSubjectsCached(force = false): Promise<Subject[]> {
  await hydrateCacheFromIdb();

  const syncedFromServer = await syncCoreFromServer(force, true);
  const afterServer = sortSubjects(getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []));
  if (syncedFromServer && afterServer.length > 0) {
    return afterServer;
  }

  if (
    !force &&
    isCacheFresh('CORE_CHECK') &&
    isCacheFresh('SUBJECTS', STORAGE_KEYS.SUBJECTS, true)
  ) {
    return sortSubjects(getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []));
  }

  return runDeduplicated(`subjects:${force ? 'force' : 'ttl'}`, async () => {
    if (
      !force &&
      isCacheFresh('CORE_CHECK') &&
      isCacheFresh('SUBJECTS', STORAGE_KEYS.SUBJECTS, true)
    ) {
      return sortSubjects(getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []));
    }
    try {
      const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
      if (!isOffline && !isQuotaCooldownActive(force)) {
        const subs = await fetchAllPagesWithLimit20<Subject>(
          'subjects',
          [],
          (d) => ({ id: d.id, ...(d.data() as Omit<Subject, 'id'>) }),
          true
        );
        if (subs.length > 0) {
          const sorted = sortSubjects(subs);
          setLocal(STORAGE_KEYS.SUBJECTS, sorted);
          setSyncTimestamp('SUBJECTS');
          syncMutationToServerCache('subjects', { replace: sorted, authoritative: true });
          window.dispatchEvent(new CustomEvent('mpq-subjects-changed', { detail: sorted }));
          return sorted;
        }
      }

      const cachedSubs = await fetchAllPagesWithLimit20<Subject>(
        'subjects',
        [],
        (d) => ({ id: d.id, ...(d.data() as Omit<Subject, 'id'>) }),
        false
      ).catch(() => []);
      if (cachedSubs.length > 0) {
        const sorted = sortSubjects(cachedSubs);
        const existingLocal = getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []);
        if (sorted.length >= existingLocal.length) {
          setLocal(STORAGE_KEYS.SUBJECTS, sorted);
          window.dispatchEvent(new CustomEvent('mpq-subjects-changed', { detail: sorted }));
          return sorted;
        }
      }

      return sortSubjects(getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []));
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.LIST, 'subjects');
      return sortSubjects(getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []));
    }
  });
}

export function subscribeSubjects(callback: (subjects: Subject[]) => void) {
  const cached = sortSubjects(getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []));
  if (cached.length > 0) {
    callback(cached);
  }

  const handleLocalChange = (e: Event) => {
    const customEvent = e as CustomEvent<Subject[]>;
    if (Array.isArray(customEvent.detail)) {
      callback(sortSubjects(customEvent.detail));
    }
  };
  window.addEventListener('mpq-subjects-changed', handleLocalChange);

  let active = true;
  void hydrateCacheFromIdb().then(() => {
    if (!active) return;
    const idbCached = sortSubjects(getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []));
    if (idbCached.length > 0 || hasCachedValue(STORAGE_KEYS.SUBJECTS)) {
      callback(idbCached);
    }
    void fetchSubjectsCached(false).then((fresh) => {
      if (active) callback(fresh);
    });
  });

  return () => {
    active = false;
    window.removeEventListener('mpq-subjects-changed', handleLocalChange);
  };
}

export async function fetchNotificationsCached(force = false): Promise<AppNotification[]> {
  await hydrateCacheFromIdb();

  const dismissed = new Set<string>(getLocal<string[]>(STORAGE_KEYS.DISMISSED_NOTIFS, []));
  const fallbackDefaults = dismissed.has('__ALL__')
    ? []
    : INITIAL_NOTIFICATIONS.filter((n) => !dismissed.has(n.id));

  const syncedFromServer = await syncCoreFromServer(force, true);
  if (syncedFromServer && hasCachedValue(STORAGE_KEYS.NOTIFICATIONS)) {
    return getLocal<AppNotification[]>(STORAGE_KEYS.NOTIFICATIONS, fallbackDefaults);
  }

  if (!force && isCacheFresh('CORE_CHECK') && isCacheFresh('NOTIFICATIONS', STORAGE_KEYS.NOTIFICATIONS)) {
    return getLocal<AppNotification[]>(STORAGE_KEYS.NOTIFICATIONS, fallbackDefaults);
  }

  return runDeduplicated(`notifications:${force ? 'force' : 'ttl'}`, async () => {
    if (!force && isCacheFresh('NOTIFICATIONS', STORAGE_KEYS.NOTIFICATIONS)) {
      return getLocal<AppNotification[]>(STORAGE_KEYS.NOTIFICATIONS, fallbackDefaults);
    }
    try {
      const page = await fetchCollectionPageFromFirestore<AppNotification>(
        'notifications',
        [orderBy('timestamp', 'desc')],
        null,
        (d) => ({ id: d.id, ...(d.data() as Omit<AppNotification, 'id'>) }),
        force
      );
      if (page.items.length === 0 && (isQuotaCooldownActive(force) || !auth.currentUser)) {
        return getLocal<AppNotification[]>(STORAGE_KEYS.NOTIFICATIONS, fallbackDefaults);
      }
      const next = resolveNotificationsWithDismissed(page.items);
      setLocal(STORAGE_KEYS.NOTIFICATIONS, next);
      setSyncTimestamp('NOTIFICATIONS');
      window.dispatchEvent(new CustomEvent('mpq-notifications-changed', { detail: next }));
      return next;
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.LIST, 'notifications');
      return getLocal<AppNotification[]>(STORAGE_KEYS.NOTIFICATIONS, fallbackDefaults);
    }
  });
}

export function subscribeNotifications(callback: (notifications: AppNotification[]) => void) {
  const dismissedInitial = new Set<string>(getLocal<string[]>(STORAGE_KEYS.DISMISSED_NOTIFS, []));
  const hasStoredCache = hasCachedValue(STORAGE_KEYS.NOTIFICATIONS);
  const initialFallback = dismissedInitial.has('__ALL__')
    ? []
    : INITIAL_NOTIFICATIONS.filter((n) => !dismissedInitial.has(n.id));
  const cached = hasStoredCache
    ? getLocal<AppNotification[]>(STORAGE_KEYS.NOTIFICATIONS, [])
    : initialFallback;
  callback(cached);

  const handleLocalChange = (e: Event) => {
    const customEvent = e as CustomEvent<AppNotification[]>;
    if (Array.isArray(customEvent.detail)) {
      callback(customEvent.detail);
    }
  };
  window.addEventListener('mpq-notifications-changed', handleLocalChange);

  let active = true;
  void hydrateCacheFromIdb().then(() => {
    if (!active) return;
    void fetchNotificationsCached(false).then((fresh) => {
      if (active) callback(fresh);
    });
  });

  return () => {
    active = false;
    window.removeEventListener('mpq-notifications-changed', handleLocalChange);
  };
}

// ---------------- Paginated Admin Feeds (20 per page + startAfter) ----------------

export async function fetchFeedbacksPage(
  cursorDoc: PaginationCursor = null,
  force = false
): Promise<PaginatedPageResult<Feedback>> {
  await hydrateCacheFromIdb();
  const backend = await ensureDbBackend();
  if (backend === 'supabase') {
    const offset = typeof cursorDoc === 'number' ? cursorDoc : 0;
    try {
      const data = await dbApiRequest<{
        items: Feedback[];
        nextOffset: number;
        hasMore: boolean;
      }>(`/api/db/feedbacks?offset=${offset}&limit=${MAX_QUERY_LIMIT}`);
      return {
        items: data.items || [],
        lastDoc: data.nextOffset,
        hasMore: Boolean(data.hasMore),
      };
    } catch {
      return {
        items: offset === 0 ? getLocal<Feedback[]>(STORAGE_KEYS.FEEDBACKS, []) : [],
        lastDoc: null,
        hasMore: false,
      };
    }
  }

  if (isQuotaCooldownActive(force)) {
    return {
      items: cursorDoc ? [] : getLocal<Feedback[]>(STORAGE_KEYS.FEEDBACKS, []),
      lastDoc: null,
      hasMore: false,
    };
  }
  try {
    const fsCursor = typeof cursorDoc === 'number' ? null : cursorDoc;
    const page = await fetchCollectionPageFromFirestore<Feedback>(
      'feedbacks',
      [orderBy('createdAt', 'desc')],
      fsCursor,
      (d) => ({ id: d.id, ...(d.data() as Omit<Feedback, 'id'>) }),
      force
    );
    return page;
  } catch (err) {
    markClientQuotaCooldownIfNeeded(err);
    handleFirestoreError(err, OperationType.LIST, 'feedbacks');
    return {
      items: cursorDoc ? [] : getLocal<Feedback[]>(STORAGE_KEYS.FEEDBACKS, []),
      lastDoc: null,
      hasMore: false,
    };
  }
}

export async function fetchFeedbacksCached(force = false): Promise<Feedback[]> {
  await hydrateCacheFromIdb();

  if (!force && isCacheFresh('FEEDBACKS', STORAGE_KEYS.FEEDBACKS)) {
    return getLocal<Feedback[]>(STORAGE_KEYS.FEEDBACKS, []);
  }

  return runDeduplicated(`feedbacks:${force ? 'force' : 'ttl'}`, async () => {
    if (!force && isCacheFresh('FEEDBACKS', STORAGE_KEYS.FEEDBACKS)) {
      return getLocal<Feedback[]>(STORAGE_KEYS.FEEDBACKS, []);
    }
    const page = await fetchFeedbacksPage(null, force);
    if (page.items.length > 0 || auth.currentUser) {
      setLocal(STORAGE_KEYS.FEEDBACKS, page.items);
      setSyncTimestamp('FEEDBACKS');
      window.dispatchEvent(new CustomEvent('mpq-feedbacks-changed', { detail: page.items }));
      return page.items;
    }
    return getLocal<Feedback[]>(STORAGE_KEYS.FEEDBACKS, []);
  });
}

export function subscribeFeedbacks(callback: (feedbacks: Feedback[]) => void) {
  const cached = getLocal<Feedback[]>(STORAGE_KEYS.FEEDBACKS, []);
  callback(cached);

  const handleLocalChange = (e: Event) => {
    const customEvent = e as CustomEvent<Feedback[]>;
    if (Array.isArray(customEvent.detail)) {
      callback(customEvent.detail);
    }
  };
  window.addEventListener('mpq-feedbacks-changed', handleLocalChange);

  let active = true;
  void fetchFeedbacksCached(false).then((fresh) => {
    if (active) callback(fresh);
  });

  return () => {
    active = false;
    window.removeEventListener('mpq-feedbacks-changed', handleLocalChange);
  };
}

export async function fetchLoginsPage(
  cursorDoc: PaginationCursor = null,
  force = false
): Promise<PaginatedPageResult<LoginRecord>> {
  await hydrateCacheFromIdb();
  const backend = await ensureDbBackend();
  if (backend === 'supabase') {
    const offset = typeof cursorDoc === 'number' ? cursorDoc : 0;
    try {
      const data = await dbApiRequest<{
        items: LoginRecord[];
        nextOffset: number;
        hasMore: boolean;
      }>(`/api/db/logins?offset=${offset}&limit=${MAX_QUERY_LIMIT}`);
      return {
        items: data.items || [],
        lastDoc: data.nextOffset,
        hasMore: Boolean(data.hasMore),
      };
    } catch {
      return {
        items: offset === 0 ? getLocal<LoginRecord[]>(STORAGE_KEYS.LOGINS, []) : [],
        lastDoc: null,
        hasMore: false,
      };
    }
  }

  if (isQuotaCooldownActive(force)) {
    return {
      items: cursorDoc ? [] : getLocal<LoginRecord[]>(STORAGE_KEYS.LOGINS, []),
      lastDoc: null,
      hasMore: false,
    };
  }
  try {
    const fsCursor = typeof cursorDoc === 'number' ? null : cursorDoc;
    const page = await fetchCollectionPageFromFirestore<LoginRecord>(
      'logins',
      [orderBy('timestamp', 'desc')],
      fsCursor,
      (d) => ({ id: d.id, ...(d.data() as Omit<LoginRecord, 'id'>) }),
      force
    );
    return page;
  } catch (err) {
    markClientQuotaCooldownIfNeeded(err);
    handleFirestoreError(err, OperationType.LIST, 'logins');
    return {
      items: cursorDoc ? [] : getLocal<LoginRecord[]>(STORAGE_KEYS.LOGINS, []),
      lastDoc: null,
      hasMore: false,
    };
  }
}

export async function fetchLoginsCached(force = false): Promise<LoginRecord[]> {
  await hydrateCacheFromIdb();

  if (!force && isCacheFresh('LOGINS', STORAGE_KEYS.LOGINS)) {
    return getLocal<LoginRecord[]>(STORAGE_KEYS.LOGINS, []);
  }

  return runDeduplicated(`logins:${force ? 'force' : 'ttl'}`, async () => {
    if (!force && isCacheFresh('LOGINS', STORAGE_KEYS.LOGINS)) {
      return getLocal<LoginRecord[]>(STORAGE_KEYS.LOGINS, []);
    }
    const page = await fetchLoginsPage(null, force);
    if (page.items.length > 0 || auth.currentUser) {
      setLocal(STORAGE_KEYS.LOGINS, page.items);
      setSyncTimestamp('LOGINS');
      window.dispatchEvent(new CustomEvent('mpq-logins-changed', { detail: page.items }));
      return page.items;
    }
    return getLocal<LoginRecord[]>(STORAGE_KEYS.LOGINS, []);
  });
}

export function subscribeLogins(callback: (logins: LoginRecord[]) => void) {
  const cached = getLocal<LoginRecord[]>(STORAGE_KEYS.LOGINS, []);
  callback(cached);

  const handleLocalChange = (e: Event) => {
    const customEvent = e as CustomEvent<LoginRecord[]>;
    if (Array.isArray(customEvent.detail)) {
      callback(customEvent.detail);
    }
  };
  window.addEventListener('mpq-logins-changed', handleLocalChange);

  let active = true;
  void fetchLoginsCached(false).then((fresh) => {
    if (active) callback(fresh);
  });

  return () => {
    active = false;
    window.removeEventListener('mpq-logins-changed', handleLocalChange);
  };
}

export async function fetchPresencePage(
  cursorDoc: PaginationCursor = null,
  force = false
): Promise<PaginatedPageResult<PresenceRecord>> {
  await hydrateCacheFromIdb();
  const filterActive = (list: PresenceRecord[]) => {
    const now = Date.now();
    return list.filter((item) => now - new Date(item.lastSeen).getTime() < 300000);
  };

  const backend = await ensureDbBackend();
  if (backend === 'supabase') {
    const offset = typeof cursorDoc === 'number' ? cursorDoc : 0;
    try {
      const data = await dbApiRequest<{
        items: PresenceRecord[];
        nextOffset: number;
        hasMore: boolean;
      }>(`/api/db/presence?offset=${offset}&limit=${MAX_QUERY_LIMIT}`);
      return {
        items: filterActive(data.items || []),
        lastDoc: data.nextOffset,
        hasMore: Boolean(data.hasMore),
      };
    } catch {
      return {
        items: offset === 0 ? filterActive(getLocal<PresenceRecord[]>(STORAGE_KEYS.PRESENCE, [])) : [],
        lastDoc: null,
        hasMore: false,
      };
    }
  }

  if (isQuotaCooldownActive(force)) {
    return {
      items: cursorDoc ? [] : filterActive(getLocal<PresenceRecord[]>(STORAGE_KEYS.PRESENCE, [])),
      lastDoc: null,
      hasMore: false,
    };
  }
  try {
    const fiveMinsAgoIso = new Date(Date.now() - 300000).toISOString();
    const fsCursor = typeof cursorDoc === 'number' ? null : cursorDoc;
    const page = await fetchCollectionPageFromFirestore<PresenceRecord>(
      'presence',
      [where('lastSeen', '>=', fiveMinsAgoIso), orderBy('lastSeen', 'desc')],
      fsCursor,
      (d) => ({ id: d.id, ...(d.data() as Omit<PresenceRecord, 'id'>) }),
      force
    );
    return {
      ...page,
      items: filterActive(page.items),
    };
  } catch (err) {
    markClientQuotaCooldownIfNeeded(err);
    handleFirestoreError(err, OperationType.LIST, 'presence');
    return {
      items: cursorDoc ? [] : filterActive(getLocal<PresenceRecord[]>(STORAGE_KEYS.PRESENCE, [])),
      lastDoc: null,
      hasMore: false,
    };
  }
}

export async function fetchPresenceCached(force = false): Promise<PresenceRecord[]> {
  await hydrateCacheFromIdb();

  const filterActive = (list: PresenceRecord[]) => {
    const now = Date.now();
    return list.filter((item) => now - new Date(item.lastSeen).getTime() < 300000);
  };

  if (!force && isCacheFresh('PRESENCE', STORAGE_KEYS.PRESENCE)) {
    return filterActive(getLocal<PresenceRecord[]>(STORAGE_KEYS.PRESENCE, []));
  }

  return runDeduplicated(`presence:${force ? 'force' : 'ttl'}`, async () => {
    if (!force && isCacheFresh('PRESENCE', STORAGE_KEYS.PRESENCE)) {
      return filterActive(getLocal<PresenceRecord[]>(STORAGE_KEYS.PRESENCE, []));
    }
    const page = await fetchPresencePage(null, force);
    if (page.items.length > 0 || auth.currentUser) {
      setLocal(STORAGE_KEYS.PRESENCE, page.items);
      setSyncTimestamp('PRESENCE');
      window.dispatchEvent(new CustomEvent('mpq-presence-changed', { detail: page.items }));
      return page.items;
    }
    return filterActive(getLocal<PresenceRecord[]>(STORAGE_KEYS.PRESENCE, []));
  });
}

export function subscribePresence(callback: (presence: PresenceRecord[]) => void) {
  const cached = getLocal<PresenceRecord[]>(STORAGE_KEYS.PRESENCE, []);
  callback(cached);

  const handleLocalChange = (e: Event) => {
    const customEvent = e as CustomEvent<PresenceRecord[]>;
    if (Array.isArray(customEvent.detail)) {
      callback(customEvent.detail);
    }
  };
  window.addEventListener('mpq-presence-changed', handleLocalChange);

  let active = true;
  void fetchPresenceCached(false).then((fresh) => {
    if (active) callback(fresh);
  });

  return () => {
    active = false;
    window.removeEventListener('mpq-presence-changed', handleLocalChange);
  };
}

/**
 * Lightweight Online Count via Server Aggregation Cache + getCountFromServer(limit(20))
 */
export async function fetchOnlineCount(force = false): Promise<number> {
  await hydrateCacheFromIdb();
  if (!force && isCacheFresh('ONLINE_COUNT', STORAGE_KEYS.ONLINE_COUNT)) {
    return getLocal<number>(STORAGE_KEYS.ONLINE_COUNT, 1);
  }

  return runDeduplicated(`online_count:${force ? 'force' : 'ttl'}`, async () => {
    if (!force && isCacheFresh('ONLINE_COUNT', STORAGE_KEYS.ONLINE_COUNT)) {
      return getLocal<number>(STORAGE_KEYS.ONLINE_COUNT, 1);
    }
    try {
      const authHeader = await getAuthBearerHeader();
      const headers: Record<string, string> = {};
      if (authHeader) headers['Authorization'] = authHeader;

      const serverRes = await fetch(`/api/cache/online-count${force ? '?force=1' : ''}`, {
        cache: 'no-store',
        headers,
      }).catch(() => null);
      if (serverRes && serverRes.ok) {
        const data = await serverRes.json();
        const count = Math.max(1, Number(data?.count || 1));
        setLocal(STORAGE_KEYS.ONLINE_COUNT, count);
        setSyncTimestamp('ONLINE_COUNT');
        return count;
      }

      const backend = await ensureDbBackend();
      if (backend === 'supabase' || !auth.currentUser || isQuotaCooldownActive(force)) {
        return getLocal<number>(STORAGE_KEYS.ONLINE_COUNT, 1);
      }

      const fiveMinsAgoIso = new Date(Date.now() - 300000).toISOString();
      const agg = await getCountFromServer(
        query(collection(db, 'presence'), where('lastSeen', '>=', fiveMinsAgoIso), limit(MAX_QUERY_LIMIT))
      );
      const count = Math.max(1, agg.data().count || 0);
      setLocal(STORAGE_KEYS.ONLINE_COUNT, count);
      setSyncTimestamp('ONLINE_COUNT');
      return count;
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.LIST, 'presence/count');
      return getLocal<number>(STORAGE_KEYS.ONLINE_COUNT, 1);
    }
  });
}

/**
 * Aggregated Collection Counts via Supabase /api/db/stats or Firestore stats/global
 */
export async function fetchGlobalStatsCached(force = false): Promise<GlobalStats> {
  await hydrateCacheFromIdb();
  if (!force && isCacheFresh('GLOBAL_STATS', STORAGE_KEYS.GLOBAL_STATS)) {
    return getLocal<GlobalStats>(STORAGE_KEYS.GLOBAL_STATS, {});
  }

  return runDeduplicated(`global_stats:${force ? 'force' : 'ttl'}`, async () => {
    if (!force && isCacheFresh('GLOBAL_STATS', STORAGE_KEYS.GLOBAL_STATS)) {
      return getLocal<GlobalStats>(STORAGE_KEYS.GLOBAL_STATS, {});
    }
    const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (isOffline) {
      return getLocal<GlobalStats>(STORAGE_KEYS.GLOBAL_STATS, {});
    }

    const backend = await ensureDbBackend();
    if (backend === 'supabase') {
      try {
        const res = await dbApiRequest<{ stats: GlobalStats }>('/api/db/stats');
        const data = res.stats || {};
        setLocal(STORAGE_KEYS.GLOBAL_STATS, data);
        setSyncTimestamp('GLOBAL_STATS');
        window.dispatchEvent(new CustomEvent('mpq-global-stats-changed', { detail: data }));
        return data;
      } catch {
        return getLocal<GlobalStats>(STORAGE_KEYS.GLOBAL_STATS, {});
      }
    }

    if (isQuotaCooldownActive(force)) {
      return getLocal<GlobalStats>(STORAGE_KEYS.GLOBAL_STATS, {});
    }
    try {
      const snap = await getDoc(doc(db, 'stats', 'global'));
      if (snap.exists()) {
        const data = snap.data() as GlobalStats;
        setLocal(STORAGE_KEYS.GLOBAL_STATS, data);
        setSyncTimestamp('GLOBAL_STATS');
        window.dispatchEvent(new CustomEvent('mpq-global-stats-changed', { detail: data }));
        return data;
      }
      if (!auth.currentUser) {
        return getLocal<GlobalStats>(STORAGE_KEYS.GLOBAL_STATS, {});
      }

      // Bootstrap counts via bounded getCountFromServer queries (obeying limit <= 20 rule)
      const [qAgg, sAgg, nAgg, fAgg] = await Promise.allSettled([
        getCountFromServer(query(collection(db, 'questions'), limit(MAX_QUERY_LIMIT))),
        getCountFromServer(query(collection(db, 'subjects'), limit(MAX_QUERY_LIMIT))),
        getCountFromServer(query(collection(db, 'notifications'), limit(MAX_QUERY_LIMIT))),
        getCountFromServer(query(collection(db, 'feedbacks'), limit(MAX_QUERY_LIMIT))),
      ]);
      const fallbackStats: GlobalStats = {
        questionsCount: qAgg.status === 'fulfilled' ? qAgg.value.data().count : undefined,
        subjectsCount: sAgg.status === 'fulfilled' ? sAgg.value.data().count : undefined,
        notificationsCount: nAgg.status === 'fulfilled' ? nAgg.value.data().count : undefined,
        feedbacksCount: fAgg.status === 'fulfilled' ? fAgg.value.data().count : undefined,
        updatedAt: new Date().toISOString(),
      };
      setLocal(STORAGE_KEYS.GLOBAL_STATS, fallbackStats);
      setSyncTimestamp('GLOBAL_STATS');
      return fallbackStats;
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.GET, 'stats/global');
      return getLocal<GlobalStats>(STORAGE_KEYS.GLOBAL_STATS, {});
    }
  });
}

export function subscribeGlobalStats(callback: (stats: GlobalStats) => void) {
  callback(getLocal<GlobalStats>(STORAGE_KEYS.GLOBAL_STATS, {}));
  const handleChange = (e: Event) => {
    const customEvent = e as CustomEvent<GlobalStats>;
    if (customEvent.detail) callback(customEvent.detail);
  };
  window.addEventListener('mpq-global-stats-changed', handleChange);

  let active = true;
  void fetchGlobalStatsCached(false).then((stats) => {
    if (active) callback(stats);
  });

  return () => {
    active = false;
    window.removeEventListener('mpq-global-stats-changed', handleChange);
  };
}

/**
 * On-demand manual refresh helpers so users/admins can sync latest changes anytime
 */
export async function refreshCoreData() {
  const synced = await syncCoreFromServer(true);
  const qs = getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []);
  const subs = getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []);
  const stats = getLocal<GlobalStats>(STORAGE_KEYS.GLOBAL_STATS, {});
  const incompleteVsStats =
    (typeof stats.questionsCount === 'number' && qs.length < stats.questionsCount) ||
    (typeof stats.subjectsCount === 'number' && subs.length < stats.subjectsCount);

  if (!synced || qs.length === 0 || subs.length === 0 || incompleteVsStats) {
    await Promise.all([
      fetchQuestionsCached(true),
      fetchSubjectsCached(true),
      fetchNotificationsCached(true),
      fetchBotCommandsCached(true),
    ]);
  }
  await fetchGlobalStatsCached(true);
}

export async function refreshAdminMonitoringData() {
  await Promise.all([
    fetchPresenceCached(true),
    fetchLoginsCached(true),
    fetchFeedbacksCached(true),
    fetchGlobalStatsCached(true),
  ]);
}

// ---------------- Database Actions ----------------

function sanitizeData<T extends Record<string, any>>(obj: T): T {
  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

export async function addQuestion(q: Omit<Question, 'id'>) {
  const id = `q-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const cleanQ = sanitizeData(q);
  const newQuestion: Question = { ...cleanQ, id } as Question;

  const cached = getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []);
  const next = [...cached, newQuestion];
  setLocal(STORAGE_KEYS.QUESTIONS, next);
  setSyncTimestamp('QUESTIONS');
  window.dispatchEvent(new CustomEvent('mpq-questions-changed', { detail: next }));

  const { mode, useSupabase, useFirestore } = await getDbExecutionTargets();
  let supabaseOk = false;
  let firestoreOk = false;
  let lastError: unknown = null;

  if (useSupabase || mode === 'dual') {
    try {
      const res = await dbApiRequest<{ version?: number }>('/api/db/questions', {
        method: 'POST',
        body: JSON.stringify({ item: newQuestion }),
      });
      supabaseOk = true;
      if (typeof res?.version === 'number') setLocal(STORAGE_KEYS.CORE_SERVER_VERSION, res.version);
    } catch (err) {
      lastError = err;
      console.warn('[Dual Sync] Supabase addQuestion note:', err);
    }
  }
  if ((useFirestore || mode === 'dual') && auth.currentUser) {
    try {
      await setDoc(doc(db, 'questions', id), newQuestion);
      firestoreOk = true;
    } catch (err) {
      lastError = err;
      handleFirestoreError(err, OperationType.WRITE, 'questions');
    }
  }

  if (!supabaseOk && !firestoreOk) {
    void syncCoreFromServer(false, true).catch(() => {});
    throw new Error(
      lastError instanceof Error
        ? `មិនអាចបន្ថែមសំណួរលើ Server បានទេ (${lastError.message})។ សូមចេញរួចចូល Admin ម្ដងទៀត!`
        : 'មិនអាចបន្ថែមសំណួរលើ Server បានទេ! សូមចេញរួចចូល Admin ម្ដងទៀត!'
    );
  }

  if (!supabaseOk) {
    syncMutationToServerCache('questions', { action: 'upsert', item: newQuestion });
  }
  notifyRealtimeMutation({ scope: 'questions', action: 'upsert', id, item: newQuestion, source: supabaseOk ? 'supabase' : 'firestore' });
  adjustGlobalStat('questionsCount', 1);
  return newQuestion;
}

export async function addQuestionsBatch(items: Omit<Question, 'id'>[]): Promise<Question[]> {
  if (items.length === 0) return [];

  const stamp = Date.now();
  const created: Question[] = items.map((item, idx) => {
    const id = `q-${stamp}-${idx}-${Math.random().toString(36).substring(2, 6)}`;
    const cleanQ = sanitizeData(item);
    return { ...cleanQ, id } as Question;
  });

  const cached = getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []);
  const next = [...cached, ...created];
  setLocal(STORAGE_KEYS.QUESTIONS, next);
  setSyncTimestamp('QUESTIONS');
  window.dispatchEvent(new CustomEvent('mpq-questions-changed', { detail: next }));

  const { mode, useSupabase, useFirestore } = await getDbExecutionTargets();
  let supabaseOk = false;
  let firestoreOk = false;
  let lastError: unknown = null;

  if (useSupabase || mode === 'dual') {
    try {
      const res = await dbApiRequest<{ version?: number }>('/api/db/questions', {
        method: 'POST',
        body: JSON.stringify({ items: created }),
      });
      supabaseOk = true;
      if (typeof res?.version === 'number') setLocal(STORAGE_KEYS.CORE_SERVER_VERSION, res.version);
    } catch (err) {
      lastError = err;
      console.warn('[Dual Sync] Supabase addQuestionsBatch note:', err);
    }
  }
  if ((useFirestore || mode === 'dual') && auth.currentUser) {
    try {
      const CHUNK_SIZE = 450;
      for (let i = 0; i < created.length; i += CHUNK_SIZE) {
        const batch = writeBatch(db);
        const chunk = created.slice(i, i + CHUNK_SIZE);
        for (const q of chunk) {
          if (q.id) {
            batch.set(doc(db, 'questions', q.id), q);
          }
        }
        await batch.commit();
      }
      firestoreOk = true;
    } catch (err) {
      lastError = err;
      handleFirestoreError(err, OperationType.WRITE, 'questions');
    }
  }

  if (!supabaseOk && !firestoreOk) {
    void syncCoreFromServer(false, true).catch(() => {});
    throw new Error(
      lastError instanceof Error
        ? `មិនអាចបន្ថែមសំណួរជាបាច់លើ Server បានទេ (${lastError.message})។ សូមចេញរួចចូល Admin ម្ដងទៀត!`
        : 'មិនអាចបន្ថែមសំណួរជាបាច់លើ Server បានទេ! សូមចេញរួចចូល Admin ម្ដងទៀត!'
    );
  }

  if (!supabaseOk) {
    syncMutationToServerCache('questions', { action: 'upsertMany', items: created });
  }
  notifyRealtimeMutation({ scope: 'questions', action: 'upsertMany', items: created, source: supabaseOk ? 'supabase' : 'firestore' });
  adjustGlobalStat('questionsCount', created.length);

  return created;
}

export async function updateQuestion(id: string, updates: Partial<Question>) {
  const cleanUpdates = sanitizeData(updates);

  const cached = getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []);
  const next = cached.map((q) => (q.id === id ? { ...q, ...cleanUpdates } : q));
  setLocal(STORAGE_KEYS.QUESTIONS, next);
  setSyncTimestamp('QUESTIONS');
  window.dispatchEvent(new CustomEvent('mpq-questions-changed', { detail: next }));

  const { mode, useSupabase, useFirestore } = await getDbExecutionTargets();
  let supabaseOk = false;
  let firestoreOk = false;
  let lastError: unknown = null;

  if (useSupabase || mode === 'dual') {
    try {
      const res = await dbApiRequest<{ version?: number }>(`/api/db/questions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ updates: cleanUpdates }),
      });
      supabaseOk = true;
      if (typeof res?.version === 'number') setLocal(STORAGE_KEYS.CORE_SERVER_VERSION, res.version);
    } catch (err) {
      lastError = err;
      console.warn('[Dual Sync] Supabase updateQuestion note:', err);
    }
  }
  if ((useFirestore || mode === 'dual') && auth.currentUser) {
    try {
      await updateDoc(doc(db, 'questions', id), cleanUpdates);
      firestoreOk = true;
    } catch (err) {
      lastError = err;
      handleFirestoreError(err, OperationType.UPDATE, `questions/${id}`);
    }
  }

  if (!supabaseOk && !firestoreOk) {
    void syncCoreFromServer(false, true).catch(() => {});
    throw new Error(
      lastError instanceof Error
        ? `មិនអាចកែសម្រួលសំណួរលើ Server បានទេ (${lastError.message})។ សូមចេញរួចចូល Admin ម្ដងទៀត!`
        : 'មិនអាចកែសម្រួលសំណួរលើ Server បានទេ!'
    );
  }

  const updatedItem = next.find((q) => q.id === id);
  if (updatedItem) {
    if (!supabaseOk) {
      syncMutationToServerCache('questions', { action: 'upsert', item: updatedItem });
    }
    notifyRealtimeMutation({ scope: 'questions', action: 'upsert', id, item: updatedItem, source: supabaseOk ? 'supabase' : 'firestore' });
  }
}

export async function renameQuestionsSubject(
  oldSubject: string,
  newSubject: string,
  matchingQuestions: Question[]
): Promise<Question[]> {
  const cleanOld = oldSubject.trim();
  const cleanNew = newSubject.trim();
  if (!cleanOld || !cleanNew || cleanOld === cleanNew) return [];

  const cached = getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []);
  const targetIds = new Set(matchingQuestions.map((q) => q.id).filter(Boolean) as string[]);
  const updatedQuestions: Question[] = [];
  const next = cached.map((q) => {
    if ((q.id && targetIds.has(q.id)) || q.subject === cleanOld) {
      const updated = { ...q, subject: cleanNew };
      updatedQuestions.push(updated);
      return updated;
    }
    return q;
  });

  if (updatedQuestions.length === 0) return [];

  setLocal(STORAGE_KEYS.QUESTIONS, next);
  setSyncTimestamp('QUESTIONS');
  window.dispatchEvent(new CustomEvent('mpq-questions-changed', { detail: next }));

  const { mode, useSupabase, useFirestore } = await getDbExecutionTargets();
  let supabaseOk = false;
  let firestoreOk = false;
  let lastError: unknown = null;

  if (useSupabase || mode === 'dual') {
    try {
      const res = await dbApiRequest<{ version?: number }>('/api/db/questions/rename-subject', {
        method: 'POST',
        body: JSON.stringify({ oldSubject: cleanOld, newSubject: cleanNew }),
      });
      supabaseOk = true;
      if (typeof res?.version === 'number') setLocal(STORAGE_KEYS.CORE_SERVER_VERSION, res.version);
    } catch (err) {
      lastError = err;
      console.warn('[Dual Sync] Supabase renameQuestionsSubject note:', err);
    }
  }

  if ((useFirestore || mode === 'dual') && auth.currentUser) {
    try {
      const CHUNK_SIZE = 450;
      for (let i = 0; i < updatedQuestions.length; i += CHUNK_SIZE) {
        const batch = writeBatch(db);
        for (const q of updatedQuestions.slice(i, i + CHUNK_SIZE)) {
          if (q.id) {
            batch.update(doc(db, 'questions', q.id), { subject: cleanNew });
          }
        }
        await batch.commit();
      }
      firestoreOk = true;
    } catch (err) {
      lastError = err;
      handleFirestoreError(err, OperationType.UPDATE, 'questions');
    }
  }

  if (!supabaseOk && !firestoreOk) {
    void syncCoreFromServer(false, true).catch(() => {});
    throw new Error(
      lastError instanceof Error
        ? `មិនអាចប្តូរឈ្មោះមុខវិជ្ជាលើសំណួរបានទេ (${lastError.message})។`
        : 'មិនអាចប្តូរឈ្មោះមុខវិជ្ជាលើសំណួរបានទេ!'
    );
  }

  if (!supabaseOk) {
    syncMutationToServerCache('questions', { action: 'upsertMany', items: updatedQuestions });
  }
  notifyRealtimeMutation({
    scope: 'questions',
    action: 'upsertMany',
    items: updatedQuestions,
    source: supabaseOk ? 'supabase' : 'firestore',
  });
  return updatedQuestions;
}

export async function deleteQuestion(id: string) {
  const cached = getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []);
  const next = cached.filter((q) => q.id !== id);
  setLocal(STORAGE_KEYS.QUESTIONS, next);
  setSyncTimestamp('QUESTIONS');
  window.dispatchEvent(new CustomEvent('mpq-questions-changed', { detail: next }));

  const { mode, useSupabase, useFirestore } = await getDbExecutionTargets();
  let supabaseOk = false;
  let firestoreOk = false;
  let lastError: unknown = null;

  // 1. Delete in Supabase (in dual or supabase mode)
  if (useSupabase || mode === 'dual') {
    try {
      const res = await dbApiRequest<{ version?: number }>(`/api/db/questions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      supabaseOk = true;
      if (typeof res?.version === 'number') setLocal(STORAGE_KEYS.CORE_SERVER_VERSION, res.version);
    } catch (err) {
      lastError = err;
      console.warn('[Dual Delete] Supabase deleteQuestion note:', err);
    }
  }

  // 2. Dual-delete in Firestore SDK
  if ((useFirestore || mode === 'dual') && auth.currentUser) {
    try {
      await deleteDoc(doc(db, 'questions', id));
      firestoreOk = true;
    } catch (err) {
      lastError = err;
      console.warn('[Dual Delete] Firestore deleteQuestion note:', err);
    }
  }

  if (!supabaseOk && !firestoreOk) {
    void syncCoreFromServer(false, true).catch(() => {});
    throw new Error(
      lastError instanceof Error
        ? `មិនអាចលុបសំណួរលើ Server បានទេ (${lastError.message})។ សូមចេញរួចចូល Admin ម្ដងទៀត!`
        : 'មិនអាចលុបសំណួរលើ Server បានទេ!'
    );
  }

  if (!supabaseOk) {
    syncMutationToServerCache('questions', { action: 'delete', id });
  }
  notifyRealtimeMutation({ scope: 'questions', action: 'delete', id, source: supabaseOk ? 'supabase' : 'firestore' });
  adjustGlobalStat('questionsCount', -1);
}

export async function deleteQuestionsBatch(ids: string[]): Promise<void> {
  if (!ids || ids.length === 0) return;
  const idSet = new Set(ids);
  const cached = getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []);
  const next = cached.filter((q) => !q.id || !idSet.has(q.id));
  setLocal(STORAGE_KEYS.QUESTIONS, next);
  setSyncTimestamp('QUESTIONS');
  window.dispatchEvent(new CustomEvent('mpq-questions-changed', { detail: next }));

  const { mode, useSupabase, useFirestore } = await getDbExecutionTargets();
  let supabaseOk = false;
  let firestoreOk = false;
  let lastError: unknown = null;

  // 1. Delete batch in Supabase
  if (useSupabase || mode === 'dual') {
    try {
      const res = await dbApiRequest<{ version?: number; count?: number }>('/api/db/questions/delete-batch', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
      supabaseOk = true;
      if (typeof res?.version === 'number') setLocal(STORAGE_KEYS.CORE_SERVER_VERSION, res.version);
    } catch (err) {
      lastError = err;
      console.warn('[Dual Delete] Supabase deleteQuestionsBatch note:', err);
    }
  }

  // 2. Dual-delete batch in Firestore SDK (chunked by 450)
  if ((useFirestore || mode === 'dual') && auth.currentUser) {
    try {
      const CHUNK_SIZE = 450;
      for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
        const batch = writeBatch(db);
        for (const id of ids.slice(i, i + CHUNK_SIZE)) {
          batch.delete(doc(db, 'questions', id));
        }
        await batch.commit();
      }
      firestoreOk = true;
    } catch (err) {
      lastError = err;
      console.warn('[Dual Delete] Firestore deleteQuestionsBatch note:', err);
    }
  }

  if (!supabaseOk && !firestoreOk) {
    void syncCoreFromServer(false, true).catch(() => {});
    throw new Error(
      lastError instanceof Error
        ? `មិនអាចលុបសំណួរជាបាច់លើ Server បានទេ (${lastError.message})។ សូមចេញរួចចូល Admin ម្ដងទៀត!`
        : 'មិនអាចលុបសំណួរជាបាច់លើ Server បានទេ!'
    );
  }

  if (!supabaseOk) {
    for (const id of ids) {
      syncMutationToServerCache('questions', { action: 'delete', id });
    }
  }
  notifyRealtimeMutation({ scope: 'questions', action: 'deleteMany', ids, source: supabaseOk ? 'supabase' : 'firestore' });
  adjustGlobalStat('questionsCount', -ids.length);
}

export async function swapQuestions(q1: Question, q2: Question) {
  if (!q1.id || !q2.id) return;
  const tempOrder = q1.order ?? 0;
  const newOrder2 = q2.order ?? 0;

  await updateQuestion(q1.id, { order: newOrder2 });
  await updateQuestion(q2.id, { order: tempOrder });
}

export async function addSubject(sub: Omit<Subject, 'id'>) {
  const id = `sub-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  const cleanSub = sanitizeData(sub);
  const newSub: Subject = { ...cleanSub, id } as Subject;

  const cached = getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []);
  const next = [...cached, newSub];
  setLocal(STORAGE_KEYS.SUBJECTS, next);
  setSyncTimestamp('SUBJECTS');
  window.dispatchEvent(new CustomEvent('mpq-subjects-changed', { detail: next }));

  const { mode, useSupabase, useFirestore } = await getDbExecutionTargets();
  let supabaseOk = false;
  let firestoreOk = false;
  let lastError: unknown = null;

  if (useSupabase || mode === 'dual') {
    try {
      const res = await dbApiRequest<{ version?: number }>('/api/db/subjects', {
        method: 'POST',
        body: JSON.stringify({ item: newSub }),
      });
      supabaseOk = true;
      if (typeof res?.version === 'number') setLocal(STORAGE_KEYS.CORE_SERVER_VERSION, res.version);
    } catch (err) {
      lastError = err;
      console.warn('[Dual Sync] Supabase addSubject note:', err);
    }
  }
  if ((useFirestore || mode === 'dual') && auth.currentUser) {
    try {
      await setDoc(doc(db, 'subjects', id), newSub);
      firestoreOk = true;
    } catch (err) {
      lastError = err;
      handleFirestoreError(err, OperationType.WRITE, 'subjects');
    }
  }

  if (!supabaseOk && !firestoreOk) {
    void syncCoreFromServer(false, true).catch(() => {});
    throw new Error(
      lastError instanceof Error
        ? `មិនអាចបន្ថែមមុខវិជ្ជាលើ Server បានទេ (${lastError.message})។ សូមចេញរួចចូល Admin ម្ដងទៀត!`
        : 'មិនអាចបន្ថែមមុខវិជ្ជាលើ Server បានទេ!'
    );
  }

  if (!supabaseOk) {
    syncMutationToServerCache('subjects', { action: 'upsert', item: newSub });
  }
  notifyRealtimeMutation({ scope: 'subjects', action: 'upsert', id, item: newSub, source: supabaseOk ? 'supabase' : 'firestore' });
  adjustGlobalStat('subjectsCount', 1);
  return newSub;
}

export async function updateSubject(id: string, updates: Partial<Subject>) {
  const cleanUpdates = sanitizeData(updates);

  const cached = getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []);
  const next = cached.map((s) => (s.id === id ? { ...s, ...cleanUpdates } : s));
  setLocal(STORAGE_KEYS.SUBJECTS, next);
  setSyncTimestamp('SUBJECTS');
  window.dispatchEvent(new CustomEvent('mpq-subjects-changed', { detail: next }));

  const { mode, useSupabase, useFirestore } = await getDbExecutionTargets();
  let supabaseOk = false;
  let firestoreOk = false;
  let lastError: unknown = null;

  if (useSupabase || mode === 'dual') {
    try {
      const res = await dbApiRequest<{ version?: number }>(`/api/db/subjects/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ updates: cleanUpdates }),
      });
      supabaseOk = true;
      if (typeof res?.version === 'number') setLocal(STORAGE_KEYS.CORE_SERVER_VERSION, res.version);
    } catch (err) {
      lastError = err;
      console.warn('[Dual Sync] Supabase updateSubject note:', err);
    }
  }
  if ((useFirestore || mode === 'dual') && auth.currentUser) {
    try {
      await updateDoc(doc(db, 'subjects', id), cleanUpdates);
      firestoreOk = true;
    } catch (err) {
      lastError = err;
      handleFirestoreError(err, OperationType.UPDATE, `subjects/${id}`);
    }
  }

  if (!supabaseOk && !firestoreOk) {
    void syncCoreFromServer(false, true).catch(() => {});
    throw new Error(
      lastError instanceof Error
        ? `មិនអាចកែសម្រួលមុខវិជ្ជាលើ Server បានទេ (${lastError.message})។`
        : 'មិនអាចកែសម្រួលមុខវិជ្ជាលើ Server បានទេ!'
    );
  }

  const updatedSub = next.find((s) => s.id === id);
  if (updatedSub) {
    if (!supabaseOk) {
      syncMutationToServerCache('subjects', { action: 'upsert', item: updatedSub });
    }
    notifyRealtimeMutation({ scope: 'subjects', action: 'upsert', id, item: updatedSub, source: supabaseOk ? 'supabase' : 'firestore' });
  }
}

export async function reorderSubjects(orderedSubjects: Subject[]): Promise<Subject[]> {
  if (orderedSubjects.length === 0) return [];

  const normalized: Subject[] = orderedSubjects.map((sub, idx) => ({
    ...sub,
    order: idx,
  }));

  setLocal(STORAGE_KEYS.SUBJECTS, normalized);
  setSyncTimestamp('SUBJECTS');
  window.dispatchEvent(new CustomEvent('mpq-subjects-changed', { detail: normalized }));

  const changed = normalized.filter((sub, idx) => orderedSubjects[idx]?.order !== idx);
  if (changed.length === 0) return normalized;

  const { mode, useSupabase, useFirestore } = await getDbExecutionTargets();
  let supabaseOk = false;
  let firestoreOk = false;
  let lastError: unknown = null;

  if (useSupabase || mode === 'dual') {
    try {
      const res = await dbApiRequest<{ version?: number }>('/api/db/subjects', {
        method: 'POST',
        body: JSON.stringify({ items: normalized }),
      });
      supabaseOk = true;
      if (typeof res?.version === 'number') setLocal(STORAGE_KEYS.CORE_SERVER_VERSION, res.version);
    } catch (err) {
      lastError = err;
      console.warn('[Dual Sync] Supabase reorderSubjects note:', err);
    }
  }
  if ((useFirestore || mode === 'dual') && auth.currentUser) {
    try {
      const CHUNK_SIZE = 450;
      for (let i = 0; i < changed.length; i += CHUNK_SIZE) {
        const batch = writeBatch(db);
        const chunk = changed.slice(i, i + CHUNK_SIZE);
        for (const sub of chunk) {
          if (sub.id) {
            batch.update(doc(db, 'subjects', sub.id), { order: sub.order });
          }
        }
        await batch.commit();
      }
      firestoreOk = true;
    } catch (err) {
      lastError = err;
      handleFirestoreError(err, OperationType.UPDATE, 'subjects');
    }
  }
  if (!supabaseOk && !firestoreOk) {
    void syncCoreFromServer(false, true).catch(() => {});
    throw new Error(
      lastError instanceof Error
        ? `មិនអាចរៀបចំលំដាប់មុខវិជ្ជាលើ Server បានទេ (${lastError.message})។`
        : 'មិនអាចរៀបចំលំដាប់មុខវិជ្ជាលើ Server បានទេ!'
    );
  }
  if (!supabaseOk) {
    syncMutationToServerCache('subjects', { action: 'upsertMany', items: normalized });
  }
  notifyRealtimeMutation({ scope: 'subjects', action: 'upsertMany', items: normalized, source: supabaseOk ? 'supabase' : 'firestore' });

  return normalized;
}

export async function moveSubject(
  subjects: Subject[],
  fromIndex: number,
  toIndex: number
): Promise<Subject[]> {
  if (
    fromIndex < 0 ||
    fromIndex >= subjects.length ||
    toIndex < 0 ||
    toIndex >= subjects.length ||
    fromIndex === toIndex
  ) {
    return subjects;
  }

  const next = [...subjects];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return reorderSubjects(next);
}

export async function swapSubjects(
  subjects: Subject[],
  fromIndex: number,
  toIndex: number
): Promise<Subject[]> {
  if (
    fromIndex < 0 ||
    fromIndex >= subjects.length ||
    toIndex < 0 ||
    toIndex >= subjects.length ||
    fromIndex === toIndex
  ) {
    return subjects;
  }

  const next = [...subjects];
  const temp = next[fromIndex];
  next[fromIndex] = next[toIndex];
  next[toIndex] = temp;
  return reorderSubjects(next);
}

export async function deleteSubject(id: string) {
  const cached = getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []);
  const next = cached.filter((s) => s.id !== id);
  setLocal(STORAGE_KEYS.SUBJECTS, next);
  setSyncTimestamp('SUBJECTS');
  window.dispatchEvent(new CustomEvent('mpq-subjects-changed', { detail: next }));

  const { mode, useSupabase, useFirestore } = await getDbExecutionTargets();
  let supabaseOk = false;
  let firestoreOk = false;
  let lastError: unknown = null;

  // 1. Delete in Supabase (in dual or supabase mode)
  if (useSupabase || mode === 'dual') {
    try {
      const res = await dbApiRequest<{ version?: number }>(`/api/db/subjects/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      supabaseOk = true;
      if (typeof res?.version === 'number') setLocal(STORAGE_KEYS.CORE_SERVER_VERSION, res.version);
    } catch (err) {
      lastError = err;
      console.warn('[Dual Delete] Supabase deleteSubject note:', err);
    }
  }

  // 2. Dual-delete in Firestore SDK
  if ((useFirestore || mode === 'dual') && auth.currentUser) {
    try {
      await deleteDoc(doc(db, 'subjects', id));
      firestoreOk = true;
    } catch (err) {
      lastError = err;
      console.warn('[Dual Delete] Firestore deleteSubject note:', err);
    }
  }

  if (!supabaseOk && !firestoreOk) {
    void syncCoreFromServer(false, true).catch(() => {});
    throw new Error(
      lastError instanceof Error
        ? `មិនអាចលុបមុខវិជ្ជាលើ Server បានទេ (${lastError.message})។ សូមចេញរួចចូល Admin ម្ដងទៀត!`
        : 'មិនអាចលុបមុខវិជ្ជាលើ Server បានទេ!'
    );
  }

  if (!supabaseOk) {
    syncMutationToServerCache('subjects', { action: 'delete', id });
  }
  notifyRealtimeMutation({ scope: 'subjects', action: 'delete', id, source: supabaseOk ? 'supabase' : 'firestore' });
  adjustGlobalStat('subjectsCount', -1);
}

export async function recordLogin(username: string, passwordUsed: string, role: 'user' | 'admin') {
  const id = `login-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  const record: LoginRecord = sanitizeData({
    id,
    username,
    passwordUsed,
    timestamp: new Date().toISOString(),
    role,
    uid: auth.currentUser?.uid,
  });
  const cached = getLocal<LoginRecord[]>(STORAGE_KEYS.LOGINS, []);
  const next = [record, ...cached].slice(0, 100);
  setLocal(STORAGE_KEYS.LOGINS, next);
  window.dispatchEvent(new CustomEvent('mpq-logins-changed', { detail: next }));

  const { mode, useSupabase, useFirestore } = await getDbExecutionTargets();
  if (useSupabase || mode === 'dual') {
    try {
      await dbApiRequest('/api/db/logins', {
        method: 'POST',
        body: JSON.stringify(record),
      });
    } catch {
      // Ignore network hiccup on non-critical audit log
    }
  }

  if ((useFirestore || mode === 'dual') && auth.currentUser) {
    try {
      await setDoc(doc(db, 'logins', id), record);
      adjustGlobalStat('loginsCount', 1);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'logins');
    }
  }
}

export async function deleteLoginRecord(id: string) {
  const cached = getLocal<LoginRecord[]>(STORAGE_KEYS.LOGINS, []);
  const next = cached.filter((l) => l.id !== id);
  setLocal(STORAGE_KEYS.LOGINS, next);
  window.dispatchEvent(new CustomEvent('mpq-logins-changed', { detail: next }));

  const { mode, useSupabase, useFirestore } = await getDbExecutionTargets();
  let supabaseOk = false;
  let firestoreOk = false;
  let lastError: unknown = null;

  if (useSupabase || mode === 'dual') {
    try {
      await dbApiRequest(`/api/db/logins/${encodeURIComponent(id)}`, { method: 'DELETE' });
      supabaseOk = true;
    } catch (err) {
      lastError = err;
      console.warn('[Dual Delete] Supabase deleteLoginRecord note:', err);
    }
  }

  if ((useFirestore || mode === 'dual') && auth.currentUser) {
    try {
      await deleteDoc(doc(db, 'logins', id));
      firestoreOk = true;
    } catch (err) {
      lastError = err;
      handleFirestoreError(err, OperationType.DELETE, `logins/${id}`);
    }
  }

  if (!supabaseOk && !firestoreOk) {
    void fetchLoginsCached(true).catch(() => {});
    throw new Error(
      lastError instanceof Error
        ? `មិនអាចលុបប្រវត្តិ Login លើ Server បានទេ (${lastError.message})។`
        : 'មិនអាចលុបប្រវត្តិ Login លើ Server បានទេ!'
    );
  }

  notifyRealtimeMutation({ scope: 'logins', action: 'delete', id, source: supabaseOk ? 'supabase' : 'firestore' });
  adjustGlobalStat('loginsCount', -1);
}

export async function deleteLoginsByIds(ids: string[]) {
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  const cached = getLocal<LoginRecord[]>(STORAGE_KEYS.LOGINS, []);
  const next = cached.filter((l) => !idSet.has(l.id));
  setLocal(STORAGE_KEYS.LOGINS, next);
  window.dispatchEvent(new CustomEvent('mpq-logins-changed', { detail: next }));

  const { mode, useSupabase, useFirestore } = await getDbExecutionTargets();
  let supabaseOk = false;
  let firestoreOk = false;
  let lastError: unknown = null;

  if (useSupabase || mode === 'dual') {
    try {
      await dbApiRequest('/api/db/logins/delete-batch', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
      supabaseOk = true;
    } catch (err) {
      lastError = err;
      console.warn('[Dual Delete] Supabase deleteLoginsByIds note:', err);
    }
  }

  if ((useFirestore || mode === 'dual') && auth.currentUser) {
    try {
      const CHUNK_SIZE = 450;
      for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
        const batch = writeBatch(db);
        for (const id of ids.slice(i, i + CHUNK_SIZE)) {
          batch.delete(doc(db, 'logins', id));
        }
        await batch.commit();
      }
      firestoreOk = true;
    } catch (err) {
      lastError = err;
      handleFirestoreError(err, OperationType.DELETE, 'logins');
    }
  }

  if (!supabaseOk && !firestoreOk) {
    void fetchLoginsCached(true).catch(() => {});
    throw new Error(
      lastError instanceof Error
        ? `មិនអាចលុបប្រវត្តិ Login ជាបាច់លើ Server បានទេ (${lastError.message})។`
        : 'មិនអាចលុបប្រវត្តិ Login ជាបាច់លើ Server បានទេ!'
    );
  }

  notifyRealtimeMutation({ scope: 'logins', action: 'deleteMany', ids, source: supabaseOk ? 'supabase' : 'firestore' });
  adjustGlobalStat('loginsCount', -ids.length);
}

export async function updatePresenceHeartbeat(username: string, role: 'user' | 'admin') {
  const safeId = `user-${encodeURIComponent(username).replace(/%/g, '_')}`;
  const lastPing = getLocal<{ id: string; at: number } | null>(STORAGE_KEYS.LAST_PRESENCE_PING, null);
  const nowMs = Date.now();

  if (lastPing && lastPing.id === safeId && nowMs - lastPing.at < 270000) {
    return;
  }

  setLocal(STORAGE_KEYS.LAST_PRESENCE_PING, { id: safeId, at: nowMs });
  const { mode, useSupabase, useFirestore } = await getDbExecutionTargets();

  const record: PresenceRecord = sanitizeData({
    id: safeId,
    username,
    role,
    lastSeen: new Date(nowMs).toISOString(),
    uid: auth.currentUser?.uid,
  });

  if (useSupabase || mode === 'dual') {
    try {
      await dbApiRequest('/api/db/presence', {
        method: 'POST',
        body: JSON.stringify(record),
      });
    } catch {
      // Ignore
    }
  }

  if ((useFirestore || mode === 'dual') && auth.currentUser) {
    try {
      await setDoc(doc(db, 'presence', safeId), record, { merge: true });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'presence');
    }
  }
}

export async function submitFeedback(username: string, text: string) {
  const id = `fb-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const item: Feedback = sanitizeData({
    id,
    username,
    text,
    createdAt: new Date().toISOString(),
    uid: auth.currentUser?.uid,
  });

  const cached = getLocal<Feedback[]>(STORAGE_KEYS.FEEDBACKS, []);
  const next = [item, ...cached].slice(0, 100);
  setLocal(STORAGE_KEYS.FEEDBACKS, next);
  window.dispatchEvent(new CustomEvent('mpq-feedbacks-changed', { detail: next }));

  const { mode, useSupabase, useFirestore } = await getDbExecutionTargets();
  if (useSupabase || mode === 'dual') {
    try {
      await dbApiRequest('/api/db/feedbacks', {
        method: 'POST',
        body: JSON.stringify(item),
      });
    } catch {
      // Ignore
    }
  }

  if ((useFirestore || mode === 'dual') && auth.currentUser) {
    try {
      await setDoc(doc(db, 'feedbacks', id), item);
      adjustGlobalStat('feedbacksCount', 1);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'feedbacks');
    }
  }
  return item;
}

export async function broadcastNotification(
  message: string,
  type: 'info' | 'success' | 'warning' = 'info',
  vipWelcome = false
) {
  const id = `notif-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  const item: AppNotification = {
    id,
    message,
    timestamp: new Date().toISOString(),
    type,
  };

  const cached = getLocal<AppNotification[]>(STORAGE_KEYS.NOTIFICATIONS, []);
  const next = [item, ...cached.filter((n) => n.id !== id)];
  setLocal(STORAGE_KEYS.NOTIFICATIONS, next);
  setSyncTimestamp('NOTIFICATIONS');
  window.dispatchEvent(new CustomEvent('mpq-notifications-changed', { detail: next }));

  const { mode, useSupabase, useFirestore } = await getDbExecutionTargets();
  let supabaseOk = false;
  let firestoreOk = false;
  let lastError: unknown = null;

  if (useSupabase || mode === 'dual') {
    try {
      const res = await dbApiRequest<{ version?: number }>('/api/db/notifications', {
        method: 'POST',
        body: JSON.stringify({ item, vipWelcome }),
      });
      supabaseOk = true;
      if (typeof res?.version === 'number') setLocal(STORAGE_KEYS.CORE_SERVER_VERSION, res.version);
    } catch (err) {
      lastError = err;
      console.warn('[Dual Sync] Supabase broadcastNotification note:', err);
    }
  }
  if ((useFirestore || mode === 'dual') && auth.currentUser) {
    try {
      await setDoc(doc(db, 'notifications', id), item);
      firestoreOk = true;
    } catch (err) {
      lastError = err;
      handleFirestoreError(err, OperationType.WRITE, 'notifications');
    }
  }

  if (!supabaseOk && !firestoreOk) {
    void syncCoreFromServer(false, true).catch(() => {});
    throw new Error(
      lastError instanceof Error
        ? `មិនអាចផ្សាយដំណឹងលើ Server បានទេ (${lastError.message})។`
        : 'មិនអាចផ្សាយដំណឹងលើ Server បានទេ!'
    );
  }

  if (!supabaseOk) {
    syncMutationToServerCache('notifications', { action: 'upsert', item });
  }
  notifyRealtimeMutation({ scope: 'notifications', action: 'upsert', id, item, source: supabaseOk ? 'supabase' : 'firestore' });
  adjustGlobalStat('notificationsCount', 1);
  return item;
}

export async function deleteNotification(id: string) {
  const dismissed = getLocal<string[]>(STORAGE_KEYS.DISMISSED_NOTIFS, []);
  if (!dismissed.includes(id)) {
    setLocal(STORAGE_KEYS.DISMISSED_NOTIFS, [...dismissed, id]);
  }

  const cached = getLocal<AppNotification[]>(STORAGE_KEYS.NOTIFICATIONS, []);
  const next = cached.filter((n) => n.id !== id);
  setLocal(STORAGE_KEYS.NOTIFICATIONS, next);
  setSyncTimestamp('NOTIFICATIONS');
  window.dispatchEvent(new CustomEvent('mpq-notifications-changed', { detail: next }));

  const { mode, useSupabase, useFirestore } = await getDbExecutionTargets();
  let supabaseOk = false;
  let firestoreOk = false;
  let lastError: unknown = null;

  if (useSupabase || mode === 'dual') {
    try {
      const res = await dbApiRequest<{ version?: number }>(`/api/db/notifications/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      supabaseOk = true;
      if (typeof res?.version === 'number') setLocal(STORAGE_KEYS.CORE_SERVER_VERSION, res.version);
    } catch (err) {
      lastError = err;
      console.warn('[Dual Delete] Supabase deleteNotification note:', err);
    }
  }

  if ((useFirestore || mode === 'dual') && auth.currentUser) {
    try {
      await deleteDoc(doc(db, 'notifications', id));
      firestoreOk = true;
    } catch (err) {
      lastError = err;
      handleFirestoreError(err, OperationType.DELETE, `notifications/${id}`);
    }
  }

  if (!supabaseOk && !firestoreOk) {
    void syncCoreFromServer(false, true).catch(() => {});
    throw new Error(
      lastError instanceof Error
        ? `មិនអាចលុបដំណឹងលើ Server បានទេ (${lastError.message})។`
        : 'មិនអាចលុបដំណឹងលើ Server បានទេ!'
    );
  }

  if (!supabaseOk) {
    syncMutationToServerCache('notifications', { action: 'delete', id });
  }
  notifyRealtimeMutation({ scope: 'notifications', action: 'delete', id, source: supabaseOk ? 'supabase' : 'firestore' });
  adjustGlobalStat('notificationsCount', -1);
}

export async function deleteAllNotifications(ids: string[]) {
  const dismissed = new Set<string>(getLocal<string[]>(STORAGE_KEYS.DISMISSED_NOTIFS, []));
  dismissed.add('__ALL__');
  ids.forEach((id) => dismissed.add(id));
  setLocal(STORAGE_KEYS.DISMISSED_NOTIFS, Array.from(dismissed));

  setLocal(STORAGE_KEYS.NOTIFICATIONS, []);
  setSyncTimestamp('NOTIFICATIONS');
  window.dispatchEvent(new CustomEvent('mpq-notifications-changed', { detail: [] }));

  const { mode, useSupabase, useFirestore } = await getDbExecutionTargets();
  let supabaseOk = false;
  let firestoreOk = false;
  let lastError: unknown = null;

  if (useSupabase || mode === 'dual') {
    try {
      const res = await dbApiRequest<{ version?: number }>('/api/db/notifications', {
        method: 'DELETE',
        body: JSON.stringify({ ids }),
      });
      supabaseOk = true;
      if (typeof res?.version === 'number') setLocal(STORAGE_KEYS.CORE_SERVER_VERSION, res.version);
    } catch (err) {
      lastError = err;
      console.warn('[Dual Delete] Supabase deleteAllNotifications note:', err);
    }
  }

  if ((useFirestore || mode === 'dual') && auth.currentUser) {
    try {
      const CHUNK_SIZE = 450;
      for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
        const batch = writeBatch(db);
        for (const id of ids.slice(i, i + CHUNK_SIZE)) {
          batch.delete(doc(db, 'notifications', id));
        }
        await batch.commit();
      }
      firestoreOk = true;
    } catch (err) {
      lastError = err;
      handleFirestoreError(err, OperationType.DELETE, 'notifications');
    }
  }

  if (!supabaseOk && !firestoreOk) {
    void syncCoreFromServer(false, true).catch(() => {});
    throw new Error(
      lastError instanceof Error
        ? `មិនអាចលុបដំណឹងទាំងអស់លើ Server បានទេ (${lastError.message})។`
        : 'មិនអាចលុបដំណឹងទាំងអស់លើ Server បានទេ!'
    );
  }

  if (!supabaseOk) {
    syncMutationToServerCache('notifications', { action: 'clear' });
  }
  notifyRealtimeMutation({ scope: 'notifications', action: 'clear', source: supabaseOk ? 'supabase' : 'firestore' });
  adjustGlobalStat('notificationsCount', -ids.length);
}

export async function fetchPaidUsersCached(force = false): Promise<PaidUser[]> {
  await hydrateCacheFromIdb();

  if (!force && isCacheFresh('PAID_USERS', STORAGE_KEYS.PAID_USERS)) {
    return getLocal<PaidUser[]>(STORAGE_KEYS.PAID_USERS, []);
  }

  return runDeduplicated(`paid_users:${force ? 'force' : 'ttl'}`, async () => {
    if (!force && isCacheFresh('PAID_USERS', STORAGE_KEYS.PAID_USERS)) {
      return getLocal<PaidUser[]>(STORAGE_KEYS.PAID_USERS, []);
    }
    const backend = await ensureDbBackend();
    if (backend === 'supabase') {
      try {
        const res = await dbApiRequest<{ items: PaidUser[] }>('/api/db/paid-users?offset=0&limit=100');
        const items = res.items || [];
        setLocal(STORAGE_KEYS.PAID_USERS, items);
        setSyncTimestamp('PAID_USERS');
        window.dispatchEvent(new CustomEvent('mpq-paid-users-changed', { detail: items }));
        return items;
      } catch {
        return getLocal<PaidUser[]>(STORAGE_KEYS.PAID_USERS, []);
      }
    }

    try {
      const page = await fetchCollectionPageFromFirestore<PaidUser>(
        'paid_users',
        [orderBy('paidAt', 'desc')],
        null,
        (d) => ({ id: d.id, ...(d.data() as Omit<PaidUser, 'id'>) }),
        force
      );
      if (page.items.length > 0 || auth.currentUser) {
        setLocal(STORAGE_KEYS.PAID_USERS, page.items);
        setSyncTimestamp('PAID_USERS');
        window.dispatchEvent(new CustomEvent('mpq-paid-users-changed', { detail: page.items }));
        return page.items;
      }
      return getLocal<PaidUser[]>(STORAGE_KEYS.PAID_USERS, []);
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.LIST, 'paid_users');
      return getLocal<PaidUser[]>(STORAGE_KEYS.PAID_USERS, []);
    }
  });
}

export function subscribePaidUsers(callback: (users: PaidUser[]) => void) {
  const cached = getLocal<PaidUser[]>(STORAGE_KEYS.PAID_USERS, []);
  callback(cached);

  const handleLocalChange = (e: Event) => {
    const customEvent = e as CustomEvent<PaidUser[]>;
    if (Array.isArray(customEvent.detail)) {
      callback(customEvent.detail);
    }
  };
  window.addEventListener('mpq-paid-users-changed', handleLocalChange);

  let active = true;
  void fetchPaidUsersCached(false).then((fresh) => {
    if (active) callback(fresh);
  });

  return () => {
    active = false;
    window.removeEventListener('mpq-paid-users-changed', handleLocalChange);
  };
}

const checkedNonPaidAt = new Map<string, number>();

export async function checkIsUserPaid(rawUsername: string): Promise<PaidUser | null> {
  const norm = rawUsername.trim().toLowerCase();
  if (!norm) return null;

  await hydrateCacheFromIdb();
  const cached = getLocal<PaidUser[]>(STORAGE_KEYS.PAID_USERS, []);
  const localMatch = cached.find(
    (u) => u.username.trim().toLowerCase() === norm && u.status === 'active' && u.permanentAccess
  );
  if (localMatch) return localMatch;

  const lastMiss = checkedNonPaidAt.get(norm) || 0;
  if (Date.now() - lastMiss < 5 * 60 * 1000) {
    return null;
  }

  const backend = await ensureDbBackend();
  if (backend === 'supabase') {
    try {
      const res = await dbApiRequest<{ isPaid: boolean; paidUser: PaidUser | null }>(
        `/api/db/paid-check?username=${encodeURIComponent(norm)}`
      );
      if (res.isPaid && res.paidUser) {
        const matched = res.paidUser;
        setLocal(STORAGE_KEYS.PAID_USERS, [matched, ...cached.filter((u) => u.id !== matched.id)]);
        return matched;
      }
      checkedNonPaidAt.set(norm, Date.now());
    } catch {
      // Ignore transient failure
    }
    return null;
  }

  if (!auth.currentUser || isQuotaCooldownActive(false)) {
    return null;
  }

  try {
    const snap = await getDoc(doc(db, 'paid_users', `user-${encodeURIComponent(norm)}`));
    if (snap.exists()) {
      const data = snap.data() as PaidUser;
      if (data.status === 'active' && data.permanentAccess) {
        const matched = { ...data, id: snap.id };
        setLocal(STORAGE_KEYS.PAID_USERS, [matched, ...cached.filter((u) => u.id !== matched.id)]);
        return matched;
      }
    }
    checkedNonPaidAt.set(norm, Date.now());
  } catch (err) {
    markClientQuotaCooldownIfNeeded(err);
    handleFirestoreError(err, OperationType.GET, `paid_users/user-${norm}`);
  }

  return null;
}

export async function registerPaidUser(params: {
  username: string;
  phoneNumber?: string;
  transactionRef?: string;
  note?: string;
  method?: string;
}): Promise<PaidUser> {
  const norm = params.username.trim().toLowerCase();
  const id = `user-${encodeURIComponent(norm)}`;
  const now = new Date().toISOString();

  const record: PaidUser = sanitizeData({
    id,
    username: params.username.trim(),
    phoneNumber: params.phoneNumber?.trim() || '',
    amount: 10,
    currency: 'USD',
    paidAt: now,
    status: 'active',
    permanentAccess: true,
    transactionRef: params.transactionRef?.trim() || `KHQR-${Date.now().toString(36).toUpperCase()}`,
    method: params.method || 'KHQR_BAKONG_ABA',
    note: params.note || 'បង់ប្រាក់ជោគជ័យតាម KHQR ($10.00) ទទួលបានសិទ្ធិប្រើប្រាស់ពេញមួយជីវិត',
    uid: auth.currentUser?.uid,
  });

  let finalRecord: PaidUser = record;
  const cached = getLocal<PaidUser[]>(STORAGE_KEYS.PAID_USERS, []);
  const upsertCachedPaidUser = (rec: PaidUser) => {
    const cur = getLocal<PaidUser[]>(STORAGE_KEYS.PAID_USERS, []);
    const idx = cur.findIndex((u) => u.id === rec.id);
    const nextList = idx >= 0 ? cur.map((u, i) => (i === idx ? rec : u)) : [rec, ...cur];
    setLocal(STORAGE_KEYS.PAID_USERS, nextList);
    window.dispatchEvent(new CustomEvent('mpq-paid-users-changed', { detail: nextList }));
  };
  upsertCachedPaidUser(cached.find((u) => u.id === id) ? record : record);

  const { mode, useSupabase, useFirestore } = await getDbExecutionTargets();
  let supabaseOk = false;
  let firestoreOk = false;
  let lastError: unknown = null;

  if (useSupabase || mode === 'dual') {
    try {
      const res = await dbApiRequest<{ record?: PaidUser }>('/api/db/paid-users', {
        method: 'POST',
        body: JSON.stringify({ record }),
      });
      supabaseOk = true;
      if (res?.record) {
        finalRecord = res.record;
        upsertCachedPaidUser(finalRecord);
      }
    } catch (err) {
      lastError = err;
      console.warn('[Dual Sync] Supabase registerPaidUser note:', err);
    }
  }
  if ((useFirestore || mode === 'dual') && auth.currentUser) {
    try {
      await setDoc(doc(db, 'paid_users', id), sanitizeData(finalRecord), { merge: true });
      firestoreOk = true;
    } catch (err) {
      lastError = err;
      handleFirestoreError(err, OperationType.WRITE, 'paid_users');
    }
  }

  if (!supabaseOk && !firestoreOk) {
    void fetchPaidUsersCached(true).catch(() => {});
    throw new Error(
      lastError instanceof Error
        ? `មិនអាចរក្សាទុកព័ត៌មានសមាជិក VIP លើ Server បានទេ (${lastError.message})។`
        : 'មិនអាចរក្សាទុកព័ត៌មានសមាជិក VIP លើ Server បានទេ!'
    );
  }

  notifyRealtimeMutation({
    scope: 'paid_users',
    action: 'upsert',
    id,
    item: finalRecord,
    source: supabaseOk ? 'supabase' : 'firestore',
  });

  const welcomeMessage =
    finalRecord.status === 'active'
      ? `🎉 សូមស្វាគមន៍សមាជិក VIP ថ្មី «${finalRecord.username}» បានបង់ប្រាក់ $10 ជោគជ័យ និងទទួលបានសិទ្ធិចូលប្រើប្រាស់ពេញមួយជីវិត!`
      : `💳 សមាជិក «${finalRecord.username}» បានបញ្ជូនសំណើបង់ប្រាក់ VIP ($10) — កំពុងរង់ចាំ Admin ផ្ទៀងផ្ទាត់!`;
  await broadcastNotification(welcomeMessage, finalRecord.status === 'active' ? 'success' : 'info', true).catch(() => {});

  return finalRecord;
}

export async function grantManualPermanentAccess(username: string, note?: string): Promise<PaidUser> {
  return registerPaidUser({
    username,
    method: 'ADMIN_MANUAL',
    note: note || 'អ្នកគ្រប់គ្រង (Admin) បានផ្តល់សិទ្ធិប្រើប្រាស់ពេញមួយជីវិតដោយផ្ទាល់',
    transactionRef: `MANUAL-${Date.now().toString(36).toUpperCase()}`,
  });
}

export async function updatePaidUserStatus(id: string, status: 'active' | 'pending' | 'revoked', permanentAccess: boolean) {
  const cached = getLocal<PaidUser[]>(STORAGE_KEYS.PAID_USERS, []);
  const next = cached.map((u) => (u.id === id ? { ...u, status, permanentAccess } : u));
  setLocal(STORAGE_KEYS.PAID_USERS, next);
  window.dispatchEvent(new CustomEvent('mpq-paid-users-changed', { detail: next }));

  const { mode, useSupabase, useFirestore } = await getDbExecutionTargets();
  let supabaseOk = false;
  let firestoreOk = false;
  let lastError: unknown = null;

  if (useSupabase || mode === 'dual') {
    try {
      await dbApiRequest(`/api/db/paid-users/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, permanentAccess }),
      });
      supabaseOk = true;
    } catch (err) {
      lastError = err;
      console.warn('[Dual Sync] Supabase updatePaidUserStatus note:', err);
    }
  }
  if ((useFirestore || mode === 'dual') && auth.currentUser) {
    try {
      await updateDoc(doc(db, 'paid_users', id), { status, permanentAccess });
      firestoreOk = true;
    } catch (err) {
      lastError = err;
      handleFirestoreError(err, OperationType.UPDATE, `paid_users/${id}`);
    }
  }

  if (!supabaseOk && !firestoreOk) {
    void fetchPaidUsersCached(true).catch(() => {});
    throw new Error(
      lastError instanceof Error
        ? `មិនអាចកែស្ថានភាពសមាជិក VIP លើ Server បានទេ (${lastError.message})។`
        : 'មិនអាចកែស្ថានភាពសមាជិក VIP លើ Server បានទេ!'
    );
  }

  const updated = next.find((u) => u.id === id);
  if (updated) {
    notifyRealtimeMutation({ scope: 'paid_users', action: 'upsert', id, item: updated, source: supabaseOk ? 'supabase' : 'firestore' });
  }
}

export async function deletePaidUser(id: string) {
  const cached = getLocal<PaidUser[]>(STORAGE_KEYS.PAID_USERS, []);
  const next = cached.filter((u) => u.id !== id);
  setLocal(STORAGE_KEYS.PAID_USERS, next);
  window.dispatchEvent(new CustomEvent('mpq-paid-users-changed', { detail: next }));

  const { mode, useSupabase, useFirestore } = await getDbExecutionTargets();
  let supabaseOk = false;
  let firestoreOk = false;
  let lastError: unknown = null;

  if (useSupabase || mode === 'dual') {
    try {
      await dbApiRequest(`/api/db/paid-users/${encodeURIComponent(id)}`, { method: 'DELETE' });
      supabaseOk = true;
    } catch (err) {
      lastError = err;
      console.warn('[Dual Delete] Supabase deletePaidUser note:', err);
    }
  }

  if ((useFirestore || mode === 'dual') && auth.currentUser) {
    try {
      await deleteDoc(doc(db, 'paid_users', id));
      firestoreOk = true;
    } catch (err) {
      lastError = err;
      handleFirestoreError(err, OperationType.DELETE, `paid_users/${id}`);
    }
  }

  if (!supabaseOk && !firestoreOk) {
    void fetchPaidUsersCached(true).catch(() => {});
    throw new Error(
      lastError instanceof Error
        ? `មិនអាចលុបសមាជិក VIP លើ Server បានទេ (${lastError.message})។`
        : 'មិនអាចលុបសមាជិក VIP លើ Server បានទេ!'
    );
  }

  notifyRealtimeMutation({ scope: 'paid_users', action: 'delete', id, source: supabaseOk ? 'supabase' : 'firestore' });
}

function getBotCommandDocId(command: string): string {
  return command.replace(/^\//, '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

export async function fetchBotCommandsCached(force = false): Promise<Record<string, BotCommandConfig>> {
  await hydrateCacheFromIdb();

  const syncedFromServer = await syncCoreFromServer(force, true);
  if (syncedFromServer && hasCachedValue(STORAGE_KEYS.BOT_COMMANDS)) {
    return getLocal<Record<string, BotCommandConfig>>(STORAGE_KEYS.BOT_COMMANDS, {});
  }

  if (
    !force &&
    isCacheFresh('CORE_CHECK') &&
    isCacheFresh('BOT_COMMANDS', STORAGE_KEYS.BOT_COMMANDS)
  ) {
    return getLocal<Record<string, BotCommandConfig>>(STORAGE_KEYS.BOT_COMMANDS, {});
  }

  return runDeduplicated(`bot_commands:${force ? 'force' : 'ttl'}`, async () => {
    if (
      !force &&
      isCacheFresh('CORE_CHECK') &&
      isCacheFresh('BOT_COMMANDS', STORAGE_KEYS.BOT_COMMANDS, true)
    ) {
      return getLocal<Record<string, BotCommandConfig>>(STORAGE_KEYS.BOT_COMMANDS, {});
    }
    try {
      const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
      if (!isOffline && !isQuotaCooldownActive(force)) {
        const list = await fetchAllPagesWithLimit20<BotCommandConfig>(
          'bot_commands',
          [],
          (d) => d.data() as BotCommandConfig,
          true
        );
        if (list.length > 0) {
          const map: Record<string, BotCommandConfig> = {};
          for (const item of list) {
            if (item?.command) {
              map[item.command] = item;
            }
          }
          setLocal(STORAGE_KEYS.BOT_COMMANDS, map);
          setSyncTimestamp('BOT_COMMANDS');
          syncMutationToServerCache('bot_commands', { replace: map, authoritative: true });
          window.dispatchEvent(new CustomEvent('mpq-bot-commands-changed', { detail: map }));
          return map;
        }
      }

      const cachedList = await fetchAllPagesWithLimit20<BotCommandConfig>(
        'bot_commands',
        [],
        (d) => d.data() as BotCommandConfig,
        false
      ).catch(() => []);
      if (cachedList.length > 0) {
        const cachedMap: Record<string, BotCommandConfig> = {};
        for (const item of cachedList) {
          if (item?.command) cachedMap[item.command] = item;
        }
        setLocal(STORAGE_KEYS.BOT_COMMANDS, cachedMap);
        window.dispatchEvent(new CustomEvent('mpq-bot-commands-changed', { detail: cachedMap }));
        return cachedMap;
      }

      return getLocal<Record<string, BotCommandConfig>>(STORAGE_KEYS.BOT_COMMANDS, {});
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.LIST, 'bot_commands');
      return getLocal<Record<string, BotCommandConfig>>(STORAGE_KEYS.BOT_COMMANDS, {});
    }
  });
}

export function subscribeBotCommands(
  callback: (commands: Record<string, BotCommandConfig>) => void,
  options?: { cacheOnly?: boolean }
) {
  const cached = getLocal<Record<string, BotCommandConfig>>(STORAGE_KEYS.BOT_COMMANDS, {});
  callback(cached);

  const handleLocalChange = (e: Event) => {
    const customEvent = e as CustomEvent<Record<string, BotCommandConfig>>;
    if (customEvent.detail && typeof customEvent.detail === 'object') {
      callback(customEvent.detail);
    }
  };
  window.addEventListener('mpq-bot-commands-changed', handleLocalChange);

  let active = true;
  void hydrateCacheFromIdb().then(() => {
    if (!active) return;
    const idbCached = getLocal<Record<string, BotCommandConfig>>(STORAGE_KEYS.BOT_COMMANDS, {});
    callback(idbCached);
    if (!options?.cacheOnly) {
      void fetchBotCommandsCached(false).then((fresh) => {
        if (active) callback(fresh);
      });
    }
  });

  return () => {
    active = false;
    window.removeEventListener('mpq-bot-commands-changed', handleLocalChange);
  };
}

export async function saveBotCommandConfig(config: BotCommandConfig) {
  const docId = getBotCommandDocId(config.command);
  const payload = sanitizeData({
    command: config.command.trim().slice(0, 32),
    titleKh: (config.titleKh || '').trim().slice(0, 120),
    descriptionKh: config.descriptionKh.trim().slice(0, 200),
    title: config.title.trim().slice(0, 250),
    body: config.body.slice(0, 4000),
    imageUrl: config.imageUrl ? config.imageUrl.trim().slice(0, 500) : undefined,
    imageAlt: config.imageAlt ? config.imageAlt.trim().slice(0, 200) : undefined,
    actions: (config.actions || [])
      .slice(0, 10)
      .filter((a) => a.label.trim() && a.value.trim())
      .map((a) => ({
        label: a.label.trim().slice(0, 120),
        type: a.type,
        value: a.value.trim().slice(0, 400),
      })),
    updatedAt: new Date().toISOString(),
  }) as BotCommandConfig;

  const cached = getLocal<Record<string, BotCommandConfig>>(STORAGE_KEYS.BOT_COMMANDS, {});
  const next = { ...cached, [payload.command]: payload };
  setLocal(STORAGE_KEYS.BOT_COMMANDS, next);
  setSyncTimestamp('BOT_COMMANDS');
  window.dispatchEvent(new CustomEvent('mpq-bot-commands-changed', { detail: next }));

  const { mode, useSupabase, useFirestore } = await getDbExecutionTargets();
  let supabaseOk = false;
  let firestoreOk = false;
  let lastError: unknown = null;

  if (useSupabase || mode === 'dual') {
    try {
      const res = await dbApiRequest<{ version?: number }>('/api/db/bot-commands', {
        method: 'POST',
        body: JSON.stringify({ config: payload }),
      });
      supabaseOk = true;
      if (typeof res?.version === 'number') setLocal(STORAGE_KEYS.CORE_SERVER_VERSION, res.version);
    } catch (err) {
      lastError = err;
      console.warn('[Dual Sync] Supabase saveBotCommandConfig note:', err);
    }
  }
  if ((useFirestore || mode === 'dual') && auth.currentUser) {
    try {
      await setDoc(doc(db, 'bot_commands', docId), payload);
      firestoreOk = true;
    } catch (err) {
      lastError = err;
      handleFirestoreError(err, OperationType.WRITE, `bot_commands/${docId}`);
    }
  }

  if (!supabaseOk && !firestoreOk) {
    void syncCoreFromServer(false, true).catch(() => {});
    throw new Error(
      lastError instanceof Error
        ? `មិនអាចរក្សាទុក Command Bot លើ Server បានទេ (${lastError.message})។`
        : 'មិនអាចរក្សាទុក Command Bot លើ Server បានទេ!'
    );
  }

  if (!supabaseOk) {
    syncMutationToServerCache('bot_commands', { replace: next, authoritative: true });
  }
  notifyRealtimeMutation({ scope: 'bot_commands', action: 'upsert', id: payload.command, item: payload, source: supabaseOk ? 'supabase' : 'firestore' });

  await syncTelegramBotTemplates(next);
  return payload;
}

export async function resetBotCommandConfig(command: string) {
  const docId = getBotCommandDocId(command);
  const cached = getLocal<Record<string, BotCommandConfig>>(STORAGE_KEYS.BOT_COMMANDS, {});
  const next = { ...cached };
  delete next[command];
  setLocal(STORAGE_KEYS.BOT_COMMANDS, next);
  setSyncTimestamp('BOT_COMMANDS');
  window.dispatchEvent(new CustomEvent('mpq-bot-commands-changed', { detail: next }));

  const { mode, useSupabase, useFirestore } = await getDbExecutionTargets();
  let supabaseOk = false;
  let firestoreOk = false;
  let lastError: unknown = null;

  if (useSupabase || mode === 'dual') {
    try {
      const res = await dbApiRequest<{ version?: number }>(
        `/api/db/bot-commands/${encodeURIComponent(command)}`,
        { method: 'DELETE' }
      );
      supabaseOk = true;
      if (typeof res?.version === 'number') setLocal(STORAGE_KEYS.CORE_SERVER_VERSION, res.version);
    } catch (err) {
      lastError = err;
      console.warn('[Dual Delete] Supabase resetBotCommandConfig note:', err);
    }
  }

  if ((useFirestore || mode === 'dual') && auth.currentUser) {
    try {
      await deleteDoc(doc(db, 'bot_commands', docId));
      firestoreOk = true;
    } catch (err) {
      lastError = err;
      handleFirestoreError(err, OperationType.DELETE, `bot_commands/${docId}`);
    }
  }

  if (!supabaseOk && !firestoreOk) {
    void syncCoreFromServer(false, true).catch(() => {});
    throw new Error(
      lastError instanceof Error
        ? `មិនអាចកំណត់ Command Bot លំនាំដើមលើ Server បានទេ (${lastError.message})។`
        : 'មិនអាចកំណត់ Command Bot លំនាំដើមលើ Server បានទេ!'
    );
  }

  if (!supabaseOk) {
    syncMutationToServerCache('bot_commands', { replace: next, authoritative: true });
  }
  notifyRealtimeMutation({ scope: 'bot_commands', action: 'delete', id: command, source: supabaseOk ? 'supabase' : 'firestore' });

  await syncTelegramBotTemplates(next);
}

export async function resetAllBotCommands(commands: string[]) {
  setLocal(STORAGE_KEYS.BOT_COMMANDS, {});
  setSyncTimestamp('BOT_COMMANDS');
  window.dispatchEvent(new CustomEvent('mpq-bot-commands-changed', { detail: {} }));

  const { mode, useSupabase, useFirestore } = await getDbExecutionTargets();
  let supabaseOk = false;
  let firestoreOk = false;
  let lastError: unknown = null;

  if (useSupabase || mode === 'dual') {
    try {
      const res = await dbApiRequest<{ version?: number }>('/api/db/bot-commands', {
        method: 'DELETE',
        body: JSON.stringify({ commands }),
      });
      supabaseOk = true;
      if (typeof res?.version === 'number') setLocal(STORAGE_KEYS.CORE_SERVER_VERSION, res.version);
    } catch (err) {
      lastError = err;
      console.warn('[Dual Delete] Supabase resetAllBotCommands note:', err);
    }
  }

  if ((useFirestore || mode === 'dual') && auth.currentUser) {
    try {
      const CHUNK_SIZE = 450;
      for (let i = 0; i < commands.length; i += CHUNK_SIZE) {
        const batch = writeBatch(db);
        for (const cmd of commands.slice(i, i + CHUNK_SIZE)) {
          batch.delete(doc(db, 'bot_commands', getBotCommandDocId(cmd)));
        }
        await batch.commit();
      }
      firestoreOk = true;
    } catch (err) {
      lastError = err;
      handleFirestoreError(err, OperationType.DELETE, 'bot_commands');
    }
  }

  if (!supabaseOk && !firestoreOk) {
    void syncCoreFromServer(false, true).catch(() => {});
    throw new Error(
      lastError instanceof Error
        ? `មិនអាចកំណត់ Command Bot ទាំងអស់លើ Server បានទេ (${lastError.message})។`
        : 'មិនអាចកំណត់ Command Bot ទាំងអស់លើ Server បានទេ!'
    );
  }

  if (!supabaseOk) {
    syncMutationToServerCache('bot_commands', { replace: {}, authoritative: true });
  }
  notifyRealtimeMutation({ scope: 'bot_commands', action: 'clear', source: supabaseOk ? 'supabase' : 'firestore' });

  await syncTelegramBotTemplates({});
}

// ---------------- Complete Firebase -> Supabase Migration & Full JSON Backup ----------------

export interface FullDatabaseBackupPayload {
  version: number;
  exportedAt: string;
  source: string;
  subjects: Subject[];
  questions: Question[];
  notifications: AppNotification[];
  botCommands: Record<string, BotCommandConfig>;
  paidUsers: PaidUser[];
  feedbacks: Feedback[];
  logins: LoginRecord[];
  presence: PresenceRecord[];
}

function mergeById<T extends { id?: string }>(...lists: (T[] | undefined | null)[]): T[] {
  const map = new Map<string, T>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const key = item.id ? String(item.id) : '';
      if (!key) continue;
      map.set(key, { ...(map.get(key) || ({} as T)), ...item });
    }
  }
  return Array.from(map.values());
}

async function fetchDbStatusSafe(): Promise<{ backend: DbBackendType; supabaseConfigured: boolean }> {
  try {
    const res = await fetch('/api/db/status', { cache: 'no-store' });
    if (!res.ok) return { backend: 'firestore', supabaseConfigured: false };
    const data = await res.json().catch(() => null);
    return {
      backend: data?.backend === 'supabase' ? 'supabase' : 'firestore',
      supabaseConfigured: Boolean(data?.supabaseConfigured),
    };
  } catch {
    return { backend: 'firestore', supabaseConfigured: false };
  }
}

export async function collectAllFirebaseAndCachedData(
  onProgress?: (msg: string) => void
): Promise<{
  payload: FullDatabaseBackupPayload;
  warnings: string[];
  totalRecords: number;
}> {
  await hydrateCacheFromIdb();
  const warnings: string[] = [];

  onProgress?.('កំពុងអានទិន្នន័យពី Server Cache និង Browser Cache...');
  let serverSnap: {
    questions?: Question[];
    subjects?: Subject[];
    notifications?: AppNotification[];
    botCommands?: Record<string, BotCommandConfig>;
  } = {};

  if (auth.currentUser) {
    try {
      serverSnap = await dbApiRequest('/api/db/server-cache-snapshot');
    } catch {
      // Fall through to public cache snapshot below
    }
  }
  if (!serverSnap.questions?.length && !serverSnap.subjects?.length) {
    try {
      const res = await fetch('/api/cache/core', { cache: 'no-store' });
      if (res.ok) {
        const core = await res.json().catch(() => null);
        if (core) serverSnap = core;
      }
    } catch {
      // Ignore offline cache miss
    }
  }

  let liveSubjects: Subject[] = [];
  let liveQuestions: Question[] = [];
  let liveNotifications: AppNotification[] = [];
  let liveBotCommandsList: BotCommandConfig[] = [];
  let livePaidUsers: PaidUser[] = [];
  let liveFeedbacks: Feedback[] = [];
  let liveLogins: LoginRecord[] = [];
  let livePresence: PresenceRecord[] = [];

  const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (!isOffline && auth.currentUser) {
    const tryPull = async <T>(
      labelKh: string,
      collectionName: string,
      mapDoc: (d: QueryDocumentSnapshot<DocumentData>) => T
    ): Promise<T[]> => {
      onProgress?.(`កំពុងទាញទិន្នន័យ ${labelKh} ពី Firebase...`);
      try {
        return await fetchAllPagesWithLimit20<T>(collectionName, [], mapDoc, true);
      } catch (err) {
        markClientQuotaCooldownIfNeeded(err);
        const msg = err instanceof Error ? err.message : String(err || '');
        warnings.push(`${collectionName}: ${msg}`);
        return [];
      }
    };

    liveSubjects = await tryPull<Subject>('មុខវិជ្ជា (subjects)', 'subjects', (d) => ({
      id: d.id,
      ...(d.data() as Omit<Subject, 'id'>),
    }));
    liveQuestions = await tryPull<Question>('សំណួរ (questions)', 'questions', (d) => ({
      id: d.id,
      ...(d.data() as Omit<Question, 'id'>),
    }));
    liveNotifications = await tryPull<AppNotification>(
      'ដំណឹង (notifications)',
      'notifications',
      (d) => ({ id: d.id, ...(d.data() as Omit<AppNotification, 'id'>) })
    );
    liveBotCommandsList = await tryPull<BotCommandConfig>(
      'ពាក្យបញ្ជា Bot (bot_commands)',
      'bot_commands',
      (d) => d.data() as BotCommandConfig
    );
    livePaidUsers = await tryPull<PaidUser>('សមាជិក VIP (paid_users)', 'paid_users', (d) => ({
      id: d.id,
      ...(d.data() as Omit<PaidUser, 'id'>),
    }));
    liveFeedbacks = await tryPull<Feedback>('មតិយោបល់ (feedbacks)', 'feedbacks', (d) => ({
      id: d.id,
      ...(d.data() as Omit<Feedback, 'id'>),
    }));
    liveLogins = await tryPull<LoginRecord>('ប្រវត្តិ Login (logins)', 'logins', (d) => ({
      id: d.id,
      ...(d.data() as Omit<LoginRecord, 'id'>),
    }));
    livePresence = await tryPull<PresenceRecord>('វត្តមាន (presence)', 'presence', (d) => ({
      id: d.id,
      ...(d.data() as Omit<PresenceRecord, 'id'>),
    }));
  } else if (!auth.currentUser) {
    warnings.push('មិនទាន់ភ្ជាប់ Google Admin — ទាញបានតែទិន្នន័យក្នុង Cache ប៉ុណ្ណោះ');
  }

  const localSubjects = getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []);
  const localQuestions = getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []);
  const localNotifications = getLocal<AppNotification[]>(STORAGE_KEYS.NOTIFICATIONS, []);
  const localBotCommands = getLocal<Record<string, BotCommandConfig>>(STORAGE_KEYS.BOT_COMMANDS, {});
  const localPaidUsers = getLocal<PaidUser[]>(STORAGE_KEYS.PAID_USERS, []);
  const localFeedbacks = getLocal<Feedback[]>(STORAGE_KEYS.FEEDBACKS, []);
  const localLogins = getLocal<LoginRecord[]>(STORAGE_KEYS.LOGINS, []);
  const localPresence = getLocal<PresenceRecord[]>(STORAGE_KEYS.PRESENCE, []);

  const subjects = sortSubjects(
    mergeById(localSubjects, serverSnap.subjects, liveSubjects)
  );
  const questions = sortQuestions(
    mergeById(localQuestions, serverSnap.questions, liveQuestions)
  );
  const notifications = mergeById(
    localNotifications,
    serverSnap.notifications,
    liveNotifications
  );
  const paidUsers = mergeById(localPaidUsers, livePaidUsers);
  const feedbacks = mergeById(localFeedbacks, liveFeedbacks);
  const logins = mergeById(localLogins, liveLogins);
  const presence = mergeById(localPresence, livePresence);

  const botCommands: Record<string, BotCommandConfig> = {
    ...localBotCommands,
    ...(serverSnap.botCommands || {}),
  };
  for (const item of liveBotCommandsList) {
    if (item?.command) {
      botCommands[item.command] = item;
    }
  }

  const totalRecords =
    subjects.length +
    questions.length +
    notifications.length +
    Object.keys(botCommands).length +
    paidUsers.length +
    feedbacks.length +
    logins.length +
    presence.length;

  const payload: FullDatabaseBackupPayload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    source: 'master-quiz-kh-full-backup',
    subjects,
    questions,
    notifications,
    botCommands,
    paidUsers,
    feedbacks,
    logins,
    presence,
  };

  return { payload, warnings, totalRecords };
}

async function uploadBackupPayloadToSupabase(
  payload: FullDatabaseBackupPayload,
  onProgress?: (msg: string) => void
): Promise<Record<string, number>> {
  const status = await fetchDbStatusSafe();
  if (!status.supabaseConfigured) {
    throw new Error(
      'មិនទាន់បានកំណត់ SUPABASE_URL និង SUPABASE_SERVICE_ROLE_KEY ក្នុង AI Studio Secrets នៅឡើយទេ! សូមដំណើរការ supabase/schema.sql ក្នុង Supabase SQL Editor រួចបញ្ចូល Secrets ជាមុនសិន។'
    );
  }
  if (!auth.currentUser && !getAdminSessionToken()) {
    throw new Error(
      'សូមចូលប្រើជា Admin (Passcode ឬ ភ្ជាប់ Google Admin) ជាមុនសិន ដើម្បីផ្ទៀងផ្ទាត់សិទ្ធិផ្ទេរទិន្នន័យ!'
    );
  }

  const imported: Record<string, number> = {};
  const CHUNK = 200;

  // Step 1: Upload metadata & core small collections first
  const hasCoreMeta =
    payload.subjects.length > 0 ||
    payload.notifications.length > 0 ||
    Object.keys(payload.botCommands || {}).length > 0 ||
    payload.paidUsers.length > 0;

  const hasChunkedArrays =
    payload.questions.length > 0 ||
    payload.feedbacks.length > 0 ||
    payload.logins.length > 0 ||
    payload.presence.length > 0;

  if (hasCoreMeta || !hasChunkedArrays) {
    onProgress?.('កំពុងផ្ទេរមុខវិជ្ជា ដំណឹង សមាជិក VIP និង Bot Commands ទៅ Supabase...');
    const res = await dbApiRequest<{ imported?: Record<string, number> }>('/api/db/migrate', {
      method: 'POST',
      body: JSON.stringify({
        subjects: payload.subjects,
        notifications: payload.notifications,
        botCommands: payload.botCommands,
        paidUsers: payload.paidUsers,
        refreshCache: !hasChunkedArrays,
        refreshStats: !hasChunkedArrays,
      }),
    });
    for (const [k, v] of Object.entries(res.imported || {})) {
      imported[k] = (imported[k] || 0) + Number(v || 0);
    }
  }

  // Step 2: Upload larger collections in safe 200-item chunks
  const rawTasks: Array<{
    key: 'questions' | 'feedbacks' | 'logins' | 'presence';
    label: string;
    items: any[];
  }> = [
    { key: 'questions', label: 'សំណួរ', items: payload.questions },
    { key: 'feedbacks', label: 'មតិយោបល់', items: payload.feedbacks },
    { key: 'logins', label: 'ប្រវត្តិ Login', items: payload.logins },
    { key: 'presence', label: 'វត្តមាន', items: payload.presence },
  ];
  const arrayTasks = rawTasks.filter((t) => t.items.length > 0);

  for (let tIdx = 0; tIdx < arrayTasks.length; tIdx++) {
    const task = arrayTasks[tIdx];
    const isLastTask = tIdx === arrayTasks.length - 1;
    for (let i = 0; i < task.items.length; i += CHUNK) {
      const slice = task.items.slice(i, i + CHUNK);
      const isLastChunk = isLastTask && i + CHUNK >= task.items.length;
      const done = Math.min(i + slice.length, task.items.length);
      onProgress?.(
        `កំពុងផ្ទេរ ${task.label}: ${done}/${task.items.length} ទៅ Supabase...`
      );
      const res = await dbApiRequest<{ imported?: Record<string, number> }>('/api/db/migrate', {
        method: 'POST',
        body: JSON.stringify({
          [task.key]: slice,
          refreshCache: isLastChunk,
          refreshStats: isLastChunk,
        }),
      });
      for (const [k, v] of Object.entries(res.imported || {})) {
        imported[k] = (imported[k] || 0) + Number(v || 0);
      }
    }
  }

  return imported;
}

export async function migrateAllFirebaseToSupabase(onProgress?: (msg: string) => void): Promise<{
  imported: Record<string, number>;
  warnings: string[];
  totalRecords: number;
}> {
  const status = await fetchDbStatusSafe();
  if (!status.supabaseConfigured) {
    throw new Error(
      'មិនទាន់បានកំណត់ SUPABASE_URL និង SUPABASE_SERVICE_ROLE_KEY ក្នុង AI Studio Secrets នៅឡើយទេ! សូមដំណើរការ supabase/schema.sql ក្នុង Supabase SQL Editor រួចបញ្ចូល Secrets ជាមុនសិន។'
    );
  }
  if (!auth.currentUser) {
    throw new Error(
      'សូមចុចប៊ូតុង "ភ្ជាប់ Google Admin" (reaksmey8114@gmail.com) នៅផ្នែកខាងលើជាមុនសិន ដើម្បីផ្ទៀងផ្ទាត់សិទ្ធិផ្ទេរទិន្នន័យ!'
    );
  }

  const { payload, warnings, totalRecords } = await collectAllFirebaseAndCachedData(onProgress);
  const imported = await uploadBackupPayloadToSupabase(payload, onProgress);

  // Run server-side Firestore REST fallback sweep if client encountered partial errors or sparse counts
  if (warnings.length > 0 || totalRecords === 0) {
    onProgress?.('កំពុងផ្ទៀងផ្ទាត់ និងទាញបន្ថែមពី Firebase Server...');
    try {
      const srvRes = await dbApiRequest<{
        imported?: Record<string, number>;
        warnings?: string[];
      }>('/api/db/migrate-from-firestore', { method: 'POST', body: '{}' });
      for (const [k, v] of Object.entries(srvRes.imported || {})) {
        imported[k] = Math.max(imported[k] || 0, Number(v || 0));
      }
      if (Array.isArray(srvRes.warnings)) {
        warnings.push(...srvRes.warnings);
      }
    } catch {
      // Keep client-migrated counts cleanly
    }
  }

  detectedDbBackend = 'supabase';
  onProgress?.('កំពុងធ្វើបច្ចុប្បន្នភាពទិន្នន័យប្រើប្រាស់...');
  await Promise.all([refreshCoreData(), refreshAdminMonitoringData()]).catch(() => {});

  return {
    imported,
    warnings: Array.from(new Set(warnings)),
    totalRecords: Object.values(imported).reduce((acc, n) => acc + Number(n || 0), 0) || totalRecords,
  };
}

export async function exportAllFirebaseDataAsJson(onProgress?: (msg: string) => void): Promise<{
  filename: string;
  payload: FullDatabaseBackupPayload;
  warnings: string[];
  totalRecords: number;
}> {
  const { payload, warnings, totalRecords } = await collectAllFirebaseAndCachedData(onProgress);
  const dateStamp = new Date().toISOString().slice(0, 10);
  const filename = `masterquiz-firebase-backup-${dateStamp}.json`;

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  return { filename, payload, warnings, totalRecords };
}

export async function importBackupJsonToSupabase(
  rawJson: string,
  onProgress?: (msg: string) => void
): Promise<{ imported: Record<string, number>; totalRecords: number }> {
  let parsed: any;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('ឯកសារ JSON មិនត្រឹមត្រូវទេ! សូមពិនិត្យទម្រង់ឯកសារ Backup ម្ដងទៀត។');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('ទម្រង់ឯកសារ Backup មិនត្រឹមត្រូវ!');
  }

  const normalized: FullDatabaseBackupPayload = {
    version: Number(parsed.version || 1),
    exportedAt: String(parsed.exportedAt || new Date().toISOString()),
    source: String(parsed.source || 'json-backup-import'),
    subjects: Array.isArray(parsed.subjects) ? parsed.subjects : [],
    questions: Array.isArray(parsed.questions) ? parsed.questions : [],
    notifications: Array.isArray(parsed.notifications) ? parsed.notifications : [],
    botCommands:
      parsed.botCommands && typeof parsed.botCommands === 'object' && !Array.isArray(parsed.botCommands)
        ? parsed.botCommands
        : {},
    paidUsers: Array.isArray(parsed.paidUsers) ? parsed.paidUsers : [],
    feedbacks: Array.isArray(parsed.feedbacks) ? parsed.feedbacks : [],
    logins: Array.isArray(parsed.logins) ? parsed.logins : [],
    presence: Array.isArray(parsed.presence) ? parsed.presence : [],
  };

  const countAll =
    normalized.subjects.length +
    normalized.questions.length +
    normalized.notifications.length +
    Object.keys(normalized.botCommands).length +
    normalized.paidUsers.length +
    normalized.feedbacks.length +
    normalized.logins.length +
    normalized.presence.length;

  if (countAll === 0) {
    throw new Error('មិនមានទិន្នន័យនៅក្នុងឯកសារ Backup នេះទេ!');
  }

  const imported = await uploadBackupPayloadToSupabase(normalized, onProgress);
  detectedDbBackend = 'supabase';
  await Promise.all([refreshCoreData(), refreshAdminMonitoringData()]).catch(() => {});

  return {
    imported,
    totalRecords: Object.values(imported).reduce((acc, n) => acc + Number(n || 0), 0) || countAll,
  };
}

// ---------------- Unified Real-Time Sync Engine (SSE + Supabase Realtime + Firestore onSnapshot) ----------------

function applyRealtimeDelta(event: ClientRealtimeDeltaEvent) {
  if (!event || !event.scope || !event.action) return;

  if (typeof event.version === 'number' && event.version > 0) {
    const prevVer = getLocal<number>(STORAGE_KEYS.CORE_SERVER_VERSION, 0);
    if (event.version > prevVer) {
      setLocal(STORAGE_KEYS.CORE_SERVER_VERSION, event.version);
    }
  }

  const { scope, action, id, ids, item, items, replace, mode } = event;

  if (scope === 'db_mode' && mode) {
    detectedDbBackend = null;
    window.dispatchEvent(new CustomEvent('mpq-db-mode-changed', { detail: mode }));
    void refreshCoreData().catch(() => {});
    return;
  }

  if (scope === 'core' && action === 'refresh') {
    void refreshCoreData().catch(() => {});
    return;
  }

  if (scope === 'questions') {
    const current = getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []);
    let next: Question[] | null = null;
    if (action === 'replace' && Array.isArray(replace)) {
      next = sortQuestions(replace);
    } else if (action === 'upsert' && item?.id) {
      const exists = current.some((q) => q.id === item.id);
      next = sortQuestions(
        exists
          ? current.map((q) => (q.id === item.id ? { ...q, ...item } : q))
          : [...current, item]
      );
    } else if (action === 'upsertMany' && Array.isArray(items)) {
      const map = new Map(current.map((q) => [q.id, q]));
      for (const it of items) {
        if (it?.id) map.set(it.id, { ...(map.get(it.id) || {}), ...it });
      }
      next = sortQuestions(Array.from(map.values()));
    } else if (action === 'delete' && id) {
      if (current.some((q) => q.id === id)) {
        next = current.filter((q) => q.id !== id);
      }
    } else if (action === 'deleteMany' && Array.isArray(ids) && ids.length > 0) {
      const idSet = new Set(ids);
      next = current.filter((q) => !q.id || !idSet.has(q.id));
    }
    if (next !== null) {
      setLocal(STORAGE_KEYS.QUESTIONS, next);
      setSyncTimestamp('QUESTIONS');
      window.dispatchEvent(new CustomEvent('mpq-questions-changed', { detail: next }));
      const prevStats = getLocal<GlobalStats>(STORAGE_KEYS.GLOBAL_STATS, {});
      const updatedStats: GlobalStats = { ...prevStats, questionsCount: next.length };
      setLocal(STORAGE_KEYS.GLOBAL_STATS, updatedStats);
      window.dispatchEvent(new CustomEvent('mpq-global-stats-changed', { detail: updatedStats }));
    }
    return;
  }

  if (scope === 'subjects') {
    const current = getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []);
    let next: Subject[] | null = null;
    if (action === 'replace' && Array.isArray(replace)) {
      next = sortSubjects(replace);
    } else if (action === 'upsert' && item?.id) {
      const exists = current.some((s) => s.id === item.id);
      next = sortSubjects(
        exists
          ? current.map((s) => (s.id === item.id ? { ...s, ...item } : s))
          : [...current, item]
      );
    } else if (action === 'upsertMany' && Array.isArray(items)) {
      const map = new Map(current.map((s) => [s.id, s]));
      for (const it of items) {
        if (it?.id) map.set(it.id, { ...(map.get(it.id) || {}), ...it });
      }
      next = sortSubjects(Array.from(map.values()));
    } else if (action === 'delete' && id) {
      if (current.some((s) => s.id === id)) {
        next = current.filter((s) => s.id !== id);
      }
    }
    if (next !== null) {
      setLocal(STORAGE_KEYS.SUBJECTS, next);
      setSyncTimestamp('SUBJECTS');
      window.dispatchEvent(new CustomEvent('mpq-subjects-changed', { detail: next }));
      const prevStats = getLocal<GlobalStats>(STORAGE_KEYS.GLOBAL_STATS, {});
      const updatedStats: GlobalStats = { ...prevStats, subjectsCount: next.length };
      setLocal(STORAGE_KEYS.GLOBAL_STATS, updatedStats);
      window.dispatchEvent(new CustomEvent('mpq-global-stats-changed', { detail: updatedStats }));
    }
    return;
  }

  if (scope === 'notifications') {
    const current = getLocal<AppNotification[]>(STORAGE_KEYS.NOTIFICATIONS, []);
    let next: AppNotification[] | null = null;
    if (action === 'clear') {
      next = [];
    } else if (action === 'replace' && Array.isArray(replace)) {
      next = resolveNotificationsWithDismissed(replace);
    } else if (action === 'upsert' && item?.id) {
      const merged = [item, ...current.filter((n) => n.id !== item.id)];
      next = resolveNotificationsWithDismissed(merged).slice(0, 50);
    } else if (action === 'delete' && id) {
      if (current.some((n) => n.id === id)) {
        next = current.filter((n) => n.id !== id);
      }
    }
    if (next !== null) {
      setLocal(STORAGE_KEYS.NOTIFICATIONS, next);
      setSyncTimestamp('NOTIFICATIONS');
      window.dispatchEvent(new CustomEvent('mpq-notifications-changed', { detail: next }));
    }
    return;
  }

  if (scope === 'bot_commands') {
    const current = getLocal<Record<string, BotCommandConfig>>(STORAGE_KEYS.BOT_COMMANDS, {});
    let next: Record<string, BotCommandConfig> | null = null;
    if (action === 'clear') {
      next = {};
    } else if (action === 'replace' && replace && typeof replace === 'object' && !Array.isArray(replace)) {
      next = replace;
    } else if (action === 'upsert' && item?.command) {
      next = { ...current, [item.command]: item };
    } else if (action === 'delete' && id) {
      next = { ...current };
      delete next[id];
    }
    if (next !== null) {
      setLocal(STORAGE_KEYS.BOT_COMMANDS, next);
      setSyncTimestamp('BOT_COMMANDS');
      window.dispatchEvent(new CustomEvent('mpq-bot-commands-changed', { detail: next }));
    }
    return;
  }

  if (scope === 'global_stats') {
    const incoming = (action === 'replace' ? replace : item) as GlobalStats | undefined;
    if (incoming && typeof incoming === 'object') {
      const current = getLocal<GlobalStats>(STORAGE_KEYS.GLOBAL_STATS, {});
      const merged = { ...current, ...incoming };
      setLocal(STORAGE_KEYS.GLOBAL_STATS, merged);
      setSyncTimestamp('GLOBAL_STATS');
      window.dispatchEvent(new CustomEvent('mpq-global-stats-changed', { detail: merged }));
    }
    return;
  }

  if (scope === 'logins') {
    const current = getLocal<LoginRecord[]>(STORAGE_KEYS.LOGINS, []);
    let next: LoginRecord[] | null = null;
    if (action === 'upsert' && item?.id) {
      const rest = current.filter((l) => l.id !== item.id);
      next = [item, ...rest]
        .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
        .slice(0, 100);
    } else if (action === 'delete' && id) {
      if (current.some((l) => l.id === id)) next = current.filter((l) => l.id !== id);
    } else if (action === 'deleteMany' && Array.isArray(ids)) {
      const idSet = new Set(ids);
      next = current.filter((l) => !idSet.has(l.id));
    }
    if (next !== null) {
      setLocal(STORAGE_KEYS.LOGINS, next);
      window.dispatchEvent(new CustomEvent('mpq-logins-changed', { detail: next }));
    }
    return;
  }

  if (scope === 'feedbacks') {
    const current = getLocal<Feedback[]>(STORAGE_KEYS.FEEDBACKS, []);
    if (action === 'upsert' && item?.id) {
      const rest = current.filter((f) => f.id !== item.id);
      const next = [item, ...rest]
        .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
        .slice(0, 100);
      setLocal(STORAGE_KEYS.FEEDBACKS, next);
      window.dispatchEvent(new CustomEvent('mpq-feedbacks-changed', { detail: next }));
    } else if (action === 'delete' && id && current.some((f) => f.id === id)) {
      const next = current.filter((f) => f.id !== id);
      setLocal(STORAGE_KEYS.FEEDBACKS, next);
      window.dispatchEvent(new CustomEvent('mpq-feedbacks-changed', { detail: next }));
    }
    return;
  }

  if (scope === 'presence') {
    const current = getLocal<PresenceRecord[]>(STORAGE_KEYS.PRESENCE, []);
    const cutoff = Date.now() - 300000;
    if (action === 'upsert' && item?.id) {
      const rest = current.filter((p) => p.id !== item.id);
      const next = [item, ...rest]
        .filter((p) => new Date(p.lastSeen || 0).getTime() >= cutoff)
        .sort((a, b) => new Date(b.lastSeen || 0).getTime() - new Date(a.lastSeen || 0).getTime())
        .slice(0, 100);
      setLocal(STORAGE_KEYS.PRESENCE, next);
      window.dispatchEvent(new CustomEvent('mpq-presence-changed', { detail: next }));
      window.dispatchEvent(
        new CustomEvent('mpq-online-count-changed', { detail: Math.max(1, next.length) })
      );
    } else if (action === 'delete' && id && current.some((p) => p.id === id)) {
      const next = current.filter((p) => p.id !== id);
      setLocal(STORAGE_KEYS.PRESENCE, next);
      window.dispatchEvent(new CustomEvent('mpq-presence-changed', { detail: next }));
    }
    return;
  }

  if (scope === 'paid_users') {
    const current = getLocal<PaidUser[]>(STORAGE_KEYS.PAID_USERS, []);
    let next: PaidUser[] | null = null;
    if (action === 'upsert' && item?.id) {
      const exists = current.some((u) => u.id === item.id);
      next = exists
        ? current.map((u) => (u.id === item.id ? { ...u, ...item } : u))
        : [item, ...current];
    } else if (action === 'delete' && id) {
      if (current.some((u) => u.id === id)) next = current.filter((u) => u.id !== id);
    }
    if (next !== null) {
      setLocal(STORAGE_KEYS.PAID_USERS, next);
      window.dispatchEvent(new CustomEvent('mpq-paid-users-changed', { detail: next }));
    }
  }
}

export function startCoreRealtimeSync(options?: { isAdmin?: boolean }): () => void {
  if (typeof window === 'undefined') return () => {};

  let disposed = false;
  let sse: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelayMs = 2000;
  let unsubSupabase: (() => void) | null = null;
  const firestoreUnsubs: Array<() => void> = [];

  const detachFirestoreListeners = () => {
    while (firestoreUnsubs.length > 0) {
      const fn = firestoreUnsubs.pop();
      try {
        fn?.();
      } catch {
        // Ignore cleanup errors
      }
    }
  };

  // Layer 0: Instant Same-Browser Multi-Tab Sync (<5ms via BroadcastChannel)
  let localBc: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      localBc = new BroadcastChannel(LOCAL_BROADCAST_CHANNEL_NAME);
      localBc.onmessage = (evt: MessageEvent) => {
        if (!disposed && evt.data?.scope && evt.data?.action) {
          applyRealtimeDelta(evt.data as ClientRealtimeDeltaEvent);
        }
      };
    } catch {
      localBc = null;
    }
  }

  // Layer 1: Express Server-Sent Events (SSE) for instant push across all clients
  const connectSse = () => {
    if (disposed || typeof EventSource === 'undefined') return;
    if (sse) {
      try {
        sse.close();
      } catch {
        // Ignore
      }
      sse = null;
    }
    try {
      sse = new EventSource('/api/realtime/events');

      sse.addEventListener('connected', (evt: MessageEvent) => {
        reconnectDelayMs = 2000;
        try {
          const data = JSON.parse(evt.data);
          if (typeof data?.onlineCount === 'number' && data.onlineCount > 0) {
            window.dispatchEvent(
              new CustomEvent('mpq-online-count-changed', { detail: data.onlineCount })
            );
          }
          if (typeof data?.version === 'number') {
            const localVer = getLocal<number>(STORAGE_KEYS.CORE_SERVER_VERSION, 0);
            if (data.version !== localVer) {
              void syncCoreFromServer(false, true).catch(() => {});
            }
          }
        } catch {
          // Ignore malformed frame
        }
      });

      sse.addEventListener('online_count', (evt: MessageEvent) => {
        try {
          const data = JSON.parse(evt.data);
          if (typeof data?.onlineCount === 'number' && data.onlineCount > 0) {
            window.dispatchEvent(
              new CustomEvent('mpq-online-count-changed', { detail: data.onlineCount })
            );
          }
        } catch {
          // Ignore malformed frame
        }
      });

      sse.addEventListener('db_change', (evt: MessageEvent) => {
        try {
          const payload = JSON.parse(evt.data) as ClientRealtimeDeltaEvent;
          applyRealtimeDelta(payload);
        } catch {
          // Ignore malformed frame
        }
      });

      sse.onerror = () => {
        if (sse) {
          try {
            sse.close();
          } catch {
            // Ignore
          }
          sse = null;
        }
        if (!disposed) {
          if (reconnectTimer) clearTimeout(reconnectTimer);
          const delay = reconnectDelayMs;
          reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30000);
          reconnectTimer = setTimeout(connectSse, delay);
        }
      };
    } catch {
      // Ignore if EventSource unavailable
    }
  };

  connectSse();

  // Mobile Safari / Android PWA wake-from-background & network reconnect recovery
  let lastWakeSyncAt = 0;
  const handleWakeOrOnline = () => {
    if (disposed) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

    // Immediately revive frozen/closed EventSource after OS sleep
    if (!sse || sse.readyState !== EventSource.OPEN) {
      reconnectDelayMs = 2000;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      connectSse();
    }

    // Lightweight version catch-up (bypasses 5m TTL; 0 DB reads if unchanged!)
    const now = Date.now();
    if (now - lastWakeSyncAt > 5000) {
      lastWakeSyncAt = now;
      void syncCoreFromServer(false, true).catch(() => {});
    }
  };

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      handleWakeOrOnline();
    }
  };

  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('pageshow', handleWakeOrOnline);
  window.addEventListener('online', handleWakeOrOnline);

  // Layer 4 Safety Net: 30s lightweight version check (0 DB reads if unchanged; heals proxies that buffer SSE)
  const versionCheckInterval = setInterval(() => {
    if (disposed) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    void syncCoreFromServer(false, true).catch(() => {});
  }, 30000);

  // Layer 2 & Layer 3: Supabase Realtime + Firebase Firestore onSnapshot
  void fetchRealtimeConfig(true).then((cfg) => {
    if (disposed || !cfg) return;

    // Layer 2: Supabase Realtime WebSockets (postgres_changes + broadcast)
    if (cfg.supabase?.configured && cfg.mode !== 'firestore') {
      unsubSupabase = connectSupabaseRealtime(
        (delta) => {
          if (!disposed) applyRealtimeDelta(delta);
        },
        { includeAdminTables: Boolean(options?.isAdmin) }
      );
    }

    // Layer 3: Firebase Firestore onSnapshot (strict limit(20) aligned with firestore.rules)
    if (cfg.mode !== 'supabase' && auth.currentUser && !isQuotaCooldownActive(false)) {
      const onFsError = (path: string) => (err: unknown) => {
        markClientQuotaCooldownIfNeeded(err);
        handleFirestoreError(err, OperationType.LIST, path);
        if (isQuotaCooldownActive(false)) {
          detachFirestoreListeners();
        }
      };

      const attachCollectionDelta = (
        colName: ClientRealtimeDeltaEvent['scope'],
        constraints: QueryConstraint[],
        mapDoc: (d: QueryDocumentSnapshot<DocumentData>) => any
      ) => {
        let isInitialSnapshot = true;
        const q = query(collection(db, colName), ...constraints, limit(MAX_QUERY_LIMIT));
        const unsub = onSnapshot(
          q,
          (snap) => {
            if (disposed) return;
            // Skip initial snapshot if it's from local cache only; apply real server deltas via docChanges()
            const changes = snap.docChanges();
            if (isInitialSnapshot) {
              isInitialSnapshot = false;
              if (snap.metadata.fromCache) return;
            }
            for (const change of changes) {
              if (change.type === 'removed') {
                applyRealtimeDelta({
                  scope: colName,
                  action: 'delete',
                  id:
                    colName === 'bot_commands'
                      ? String(change.doc.data()?.command || change.doc.id)
                      : change.doc.id,
                  source: 'firestore',
                  ts: Date.now(),
                });
              } else {
                const mapped = mapDoc(change.doc);
                applyRealtimeDelta({
                  scope: colName,
                  action: 'upsert',
                  id: mapped?.id || mapped?.command || change.doc.id,
                  item: mapped,
                  source: 'firestore',
                  ts: Date.now(),
                });
              }
            }
          },
          onFsError(colName)
        );
        firestoreUnsubs.push(unsub);
      };

      attachCollectionDelta('subjects', [], (d) => ({
        id: d.id,
        ...(d.data() as Omit<Subject, 'id'>),
      }));
      attachCollectionDelta('questions', [], (d) => ({
        id: d.id,
        ...(d.data() as Omit<Question, 'id'>),
      }));
      attachCollectionDelta('notifications', [orderBy('timestamp', 'desc')], (d) => ({
        id: d.id,
        ...(d.data() as Omit<AppNotification, 'id'>),
      }));
      attachCollectionDelta('bot_commands', [], (d) => d.data() as BotCommandConfig);

      // Single-document global stats listener (1 read only when changed)
      const unsubStatsDoc = onSnapshot(
        doc(db, 'stats', 'global'),
        (snap) => {
          if (disposed || !snap.exists()) return;
          applyRealtimeDelta({
            scope: 'global_stats',
            action: 'replace',
            replace: snap.data() as GlobalStats,
            source: 'firestore',
            ts: Date.now(),
          });
        },
        onFsError('stats/global')
      );
      firestoreUnsubs.push(unsubStatsDoc);

      // Admin monitoring real-time listeners (strictly when Admin panel is open)
      if (options?.isAdmin) {
        attachCollectionDelta('logins', [orderBy('timestamp', 'desc')], (d) => ({
          id: d.id,
          ...(d.data() as Omit<LoginRecord, 'id'>),
        }));
        attachCollectionDelta('presence', [orderBy('lastSeen', 'desc')], (d) => ({
          id: d.id,
          ...(d.data() as Omit<PresenceRecord, 'id'>),
        }));
        attachCollectionDelta('feedbacks', [orderBy('createdAt', 'desc')], (d) => ({
          id: d.id,
          ...(d.data() as Omit<Feedback, 'id'>),
        }));
        attachCollectionDelta('paid_users', [orderBy('paidAt', 'desc')], (d) => ({
          id: d.id,
          ...(d.data() as Omit<PaidUser, 'id'>),
        }));
      }
    }
  });

  return () => {
    disposed = true;
    clearInterval(versionCheckInterval);
    if (localBc) {
      try {
        localBc.close();
      } catch {
        // Ignore
      }
      localBc = null;
    }
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('pageshow', handleWakeOrOnline);
    window.removeEventListener('online', handleWakeOrOnline);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (sse) {
      try {
        sse.close();
      } catch {
        // Ignore
      }
      sse = null;
    }
    if (unsubSupabase) {
      try {
        unsubSupabase();
      } catch {
        // Ignore
      }
      unsubSupabase = null;
    }
    detachFirestoreListeners();
  };
}


