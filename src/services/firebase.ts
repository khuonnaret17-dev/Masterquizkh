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
import {
  INITIAL_BUNDLED_VERSION,
  INITIAL_SUBJECTS,
  INITIAL_QUESTIONS,
  INITIAL_NOTIFICATIONS,
} from './initialData';
import { syncTelegramBotTemplates } from './telegram';
import {
  hydrateCacheFromIdb,
  isCacheHydratedFromIdb,
  getCachedValue,
  hasCachedValue,
  setCachedValue,
} from './localCacheDb';

let inMemoryAdminToken: string | null = null;

export function setAdminSessionToken(token: string | null) {
  inMemoryAdminToken = token && token.trim() ? token.trim() : null;
}

export function getAdminSessionToken(): string | null {
  return inMemoryAdminToken;
}

// Strict maximum items per single Firestore list query (aligned with firestore.rules limit <= 20)
export const MAX_QUERY_LIMIT = 20;

export interface PaginatedPageResult<T> {
  items: T[];
  lastDoc: QueryDocumentSnapshot<DocumentData> | null;
  hasMore: boolean;
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

export async function verifyFirebaseAdminAccess(triggerSignIn = false): Promise<{ ok: boolean; email?: string | null }> {
  let user = auth.currentUser;
  if (!user && triggerSignIn) {
    user = await signInWithGoogle();
  }
  if (!user) return { ok: false, email: null };

  const email = user.email?.toLowerCase() || '';
  if (email === 'reaksmey8114@gmail.com' && user.emailVerified) {
    return { ok: true, email: user.email };
  }

  try {
    const adminSnap = await getDoc(doc(db, 'admins', user.uid));
    if (adminSnap.exists()) {
      return { ok: true, email: user.email };
    }
  } catch {
    // Ignore permission errors if non-admin
  }
  return { ok: false, email: user.email };
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

// Startup Connection Validation (runs once per 24h when authenticated to avoid unauthenticated reads)
async function testConnection(force = false) {
  try {
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
  BUNDLED_REVISION: 'mpq_bundled_version_v1',
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
  if (
    msg.includes('resource-exhausted') ||
    msg.includes('Quota') ||
    msg.includes('429') ||
    msg.includes('requires billing') ||
    msg.includes('billing to be enabled')
  ) {
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

function dedupeById<T extends { id?: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of list) {
    const id = item?.id;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(item);
  }
  return out;
}

const sortQuestions = (list: Question[]) =>
  dedupeById(list).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

const sortSubjects = (list: Subject[]) =>
  dedupeById(list).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

const normTextKey = (val?: string) => String(val || '').trim().toLowerCase().replace(/\s+/g, ' ');

let lastHydratedBundledVer = 0;

function ensureBundledCodeDataHydrated() {
  if (!isCacheHydratedFromIdb()) return;
  const savedVer = getLocal<number>(STORAGE_KEYS.BUNDLED_REVISION, 0);
  const currentQuestions = getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []);
  const currentSubjects = getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []);

  const needsInitialQ =
    INITIAL_QUESTIONS.length > 0 && (!hasCachedValue(STORAGE_KEYS.QUESTIONS) || currentQuestions.length === 0);
  const needsInitialS =
    INITIAL_SUBJECTS.length > 0 && (!hasCachedValue(STORAGE_KEYS.SUBJECTS) || currentSubjects.length === 0);
  const hasNewBundledVersion =
    INITIAL_BUNDLED_VERSION > 0 &&
    INITIAL_BUNDLED_VERSION > savedVer &&
    INITIAL_BUNDLED_VERSION > lastHydratedBundledVer;

  if (!needsInitialQ && !needsInitialS && !hasNewBundledVersion) {
    return;
  }

  if ((needsInitialS || hasNewBundledVersion) && INITIAL_SUBJECTS.length > 0) {
    const sortedS = sortSubjects([...INITIAL_SUBJECTS]);
    setLocal(STORAGE_KEYS.SUBJECTS, sortedS);
    setSyncTimestamp('SUBJECTS');
    window.dispatchEvent(new CustomEvent('mpq-subjects-changed', { detail: sortedS }));
  }

  if ((needsInitialQ || hasNewBundledVersion) && INITIAL_QUESTIONS.length > 0) {
    const sortedQ = sortQuestions([...INITIAL_QUESTIONS]);
    setLocal(STORAGE_KEYS.QUESTIONS, sortedQ);
    setSyncTimestamp('QUESTIONS');
    window.dispatchEvent(new CustomEvent('mpq-questions-changed', { detail: sortedQ }));
  }

  if (INITIAL_BUNDLED_VERSION > 0) {
    lastHydratedBundledVer = INITIAL_BUNDLED_VERSION;
    setLocal(STORAGE_KEYS.BUNDLED_REVISION, INITIAL_BUNDLED_VERSION);
    const prevCoreVer = getLocal<number>(STORAGE_KEYS.CORE_SERVER_VERSION, 0);
    if (INITIAL_BUNDLED_VERSION > prevCoreVer) {
      setLocal(STORAGE_KEYS.CORE_SERVER_VERSION, INITIAL_BUNDLED_VERSION);
    }
  }
}

type ServerCacheMutationPayload =
  | { action: 'upsert'; item: unknown }
  | { action: 'upsertMany'; items: unknown[] }
  | { action: 'delete'; id: string }
  | { action: 'deleteMany'; ids: string[] }
  | { action: 'clear' }
  | { replace: unknown; authoritative?: boolean };

const REALTIME_CLIENT_ID = (() => {
  const key = 'mpq_realtime_client_id_v1';
  try {
    const existing = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(key) : null;
    if (existing) return existing;
    const generated = `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(key, generated);
    return generated;
  } catch {
    return `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
})();

let realtimeBroadcastChannel: BroadcastChannel | null = null;
function getRealtimeBroadcastChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  if (!realtimeBroadcastChannel) {
    try {
      realtimeBroadcastChannel = new BroadcastChannel('mpq_realtime_v1');
    } catch {
      return null;
    }
  }
  return realtimeBroadcastChannel;
}

function postToBroadcastChannel(payload: Record<string, unknown>) {
  const ch = getRealtimeBroadcastChannel();
  if (!ch) return;
  try {
    ch.postMessage({ ...payload, sourceClientId: REALTIME_CLIENT_ID, ts: Date.now() });
  } catch {
    // Ignore serialization or closed-channel errors
  }
}

interface RealtimeDeltaEvent {
  scope:
    | 'questions'
    | 'subjects'
    | 'notifications'
    | 'bot_commands'
    | 'global_stats'
    | 'online_count'
    | 'feedbacks'
    | 'logins'
    | 'presence'
    | 'paid_users'
    | 'core';
  action?: 'upsert' | 'upsertMany' | 'delete' | 'deleteMany' | 'clear' | 'replace' | 'refresh';
  item?: any;
  items?: any[];
  id?: string;
  ids?: string[];
  replace?: any;
  authoritative?: boolean;
  onlineCount?: number;
  scopes?: string[];
  version?: number;
  ts?: number;
  sourceClientId?: string;
}

function publishRealtimeDelta(payload: {
  scope: 'presence' | 'feedbacks' | 'logins' | 'paid_users' | 'global_stats' | 'online_count';
  action?: 'upsert' | 'upsertMany' | 'delete' | 'deleteMany' | 'clear' | 'replace';
  id?: string;
  ids?: string[];
  item?: unknown;
  items?: unknown[];
  replace?: unknown;
}) {
  postToBroadcastChannel(payload);
  if (typeof fetch === 'undefined') return;
  void fetch('/api/realtime/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, clientId: REALTIME_CLIENT_ID }),
  })
    .then(async (res) => {
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      if (typeof data?.onlineCount === 'number' && data.onlineCount >= 1) {
        setLocal(STORAGE_KEYS.ONLINE_COUNT, data.onlineCount);
        setSyncTimestamp('ONLINE_COUNT');
        window.dispatchEvent(new CustomEvent('mpq-online-count-changed', { detail: data.onlineCount }));
      }
    })
    .catch(() => {
      // Ignore offline publish errors
    });
}

function syncMutationToServerCache(
  scope: 'questions' | 'subjects' | 'notifications' | 'bot_commands',
  payload: ServerCacheMutationPayload
) {
  postToBroadcastChannel({ scope, ...payload });
  if (typeof fetch === 'undefined') return;
  void fetch('/api/cache/mutate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, ...payload, clientId: REALTIME_CLIENT_ID }),
  })
    .then(async (res) => {
      if (res.ok) {
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
    const seenDocIds = new Set<string>();
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
      snap.forEach((d: QueryDocumentSnapshot<DocumentData>) => {
        if (seenDocIds.has(d.id)) return;
        seenDocIds.add(d.id);
        collected.push(mapDoc(d));
      });
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
  publishRealtimeDelta({ scope: 'global_stats', action: 'replace', replace: nextStats });

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
async function syncCoreFromServer(force = false, bypassFreshCheck = false): Promise<boolean> {
  await hydrateCacheFromIdb();

  if (
    !force &&
    !bypassFreshCheck &&
    hasNonEmptyCoreArrays() &&
    (isQuotaCooldownActive(false) || isCacheFresh('CORE_CHECK'))
  ) {
    return true;
  }

  return runDeduplicated(`core_server:${force ? 'force' : bypassFreshCheck ? 'poll' : 'ttl'}`, async () => {
    if (
      !force &&
      !bypassFreshCheck &&
      hasNonEmptyCoreArrays() &&
      (isQuotaCooldownActive(false) || isCacheFresh('CORE_CHECK'))
    ) {
      return true;
    }

    const requestCore = async (useSince: boolean) => {
      const localQuestions = getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []);
      const localSubjects = getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []);
      const localBotCommands = getLocal<Record<string, BotCommandConfig>>(STORAGE_KEYS.BOT_COMMANDS, {});
      const hasCoreCatalog = localQuestions.length > 0 && localSubjects.length > 0;
      const needMeta =
        Object.keys(localBotCommands).length === 0 || !hasCachedValue(STORAGE_KEYS.NOTIFICATIONS);
      const savedVersion = hasCoreCatalog
        ? Math.max(getLocal<number>(STORAGE_KEYS.CORE_SERVER_VERSION, 0), INITIAL_BUNDLED_VERSION)
        : 0;

      const params = new URLSearchParams();
      if (force) params.set('force', '1');
      if (useSince && !force && savedVersion > 0) {
        params.set('since', String(savedVersion));
        if (needMeta) params.set('needMeta', '1');
      }

      const authHeader = await getAuthBearerHeader();
      const headers: Record<string, string> = {};
      if (authHeader) headers['Authorization'] = authHeader;

      const res = await fetch(`/api/cache/core?${params.toString()}`, {
        cache: 'no-store',
        headers,
      });
      const payload = await res.json().catch(() => null);
      return { res, payload };
    };

    try {
      let { res, payload } = await requestCore(true);

      if (payload?.quotaLimited) {
        clientQuotaCooldownUntil = Date.now() + 5 * 60 * 1000;
      }

      if (!res.ok || !payload) {
        return false;
      }

      if (payload?.unchanged) {
        if (!hasNonEmptyCoreArrays()) {
          // Local storage lost/empty despite version match — re-request full payload
          const retry = await requestCore(false);
          res = retry.res;
          payload = retry.payload;
          if (!res.ok || !payload) return false;
        } else {
          if (Array.isArray(payload?.notifications)) {
            const notifs = resolveNotificationsWithDismissed(payload.notifications);
            setLocal(STORAGE_KEYS.NOTIFICATIONS, notifs);
            window.dispatchEvent(new CustomEvent('mpq-notifications-changed', { detail: notifs }));
          }
          if (payload?.botCommands && typeof payload.botCommands === 'object') {
            setLocal(STORAGE_KEYS.BOT_COMMANDS, payload.botCommands);
            window.dispatchEvent(
              new CustomEvent('mpq-bot-commands-changed', { detail: payload.botCommands })
            );
          }
          if (typeof payload?.version === 'number') {
            setLocal(STORAGE_KEYS.CORE_SERVER_VERSION, payload.version);
          }
          setSyncTimestamp('CORE_CHECK');
          setSyncTimestamp('QUESTIONS');
          setSyncTimestamp('SUBJECTS');
          setSyncTimestamp('NOTIFICATIONS');
          setSyncTimestamp('BOT_COMMANDS');
          return true;
        }
      }

      if (Array.isArray(payload?.questions) && payload.questions.length > 0) {
        const existingLocalQ = getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []);
        const isOlderStarterDowngrade =
          typeof payload?.version === 'number' &&
          INITIAL_BUNDLED_VERSION > 0 &&
          payload.version < INITIAL_BUNDLED_VERSION &&
          payload.questions.length < existingLocalQ.length;
        if (!isOlderStarterDowngrade) {
          const sortedQ = sortQuestions(payload.questions);
          setLocal(STORAGE_KEYS.QUESTIONS, sortedQ);
          setSyncTimestamp('QUESTIONS');
          window.dispatchEvent(new CustomEvent('mpq-questions-changed', { detail: sortedQ }));
        }
      }

      if (Array.isArray(payload?.subjects) && payload.subjects.length > 0) {
        const existingLocalS = getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []);
        const isOlderStarterDowngradeS =
          typeof payload?.version === 'number' &&
          INITIAL_BUNDLED_VERSION > 0 &&
          payload.version < INITIAL_BUNDLED_VERSION &&
          payload.subjects.length < existingLocalS.length;
        if (!isOlderStarterDowngradeS) {
          const sortedSub = sortSubjects(payload.subjects);
          setLocal(STORAGE_KEYS.SUBJECTS, sortedSub);
          setSyncTimestamp('SUBJECTS');
          window.dispatchEvent(new CustomEvent('mpq-subjects-changed', { detail: sortedSub }));
        }
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
  ensureBundledCodeDataHydrated();

  if (
    !force &&
    isCacheFresh('CORE_CHECK') &&
    isCacheFresh('QUESTIONS', STORAGE_KEYS.QUESTIONS, true)
  ) {
    return sortQuestions(getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []));
  }

  const syncedFromServer = await syncCoreFromServer(force);
  ensureBundledCodeDataHydrated();
  const afterServer = sortQuestions(getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []));
  if (syncedFromServer && afterServer.length > 0) {
    return afterServer;
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
      if (!isOffline && !isQuotaCooldownActive(force) && auth.currentUser) {
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

      ensureBundledCodeDataHydrated();
      return sortQuestions(getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []));
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.LIST, 'questions');
      ensureBundledCodeDataHydrated();
      return sortQuestions(getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []));
    }
  });
}

export function subscribeQuestions(callback: (questions: Question[]) => void) {
  const cached = sortQuestions(getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []));
  if (cached.length > 0) {
    callback(cached);
  } else if (INITIAL_QUESTIONS.length > 0) {
    callback(sortQuestions([...INITIAL_QUESTIONS]));
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
    ensureBundledCodeDataHydrated();
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
  ensureBundledCodeDataHydrated();

  if (
    !force &&
    isCacheFresh('CORE_CHECK') &&
    isCacheFresh('SUBJECTS', STORAGE_KEYS.SUBJECTS, true)
  ) {
    return sortSubjects(getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []));
  }

  const syncedFromServer = await syncCoreFromServer(force);
  ensureBundledCodeDataHydrated();
  const afterServer = sortSubjects(getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []));
  if (syncedFromServer && afterServer.length > 0) {
    return afterServer;
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
      if (!isOffline && !isQuotaCooldownActive(force) && auth.currentUser) {
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

      ensureBundledCodeDataHydrated();
      return sortSubjects(getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []));
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.LIST, 'subjects');
      ensureBundledCodeDataHydrated();
      return sortSubjects(getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []));
    }
  });
}

export function subscribeSubjects(callback: (subjects: Subject[]) => void) {
  const cached = sortSubjects(getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []));
  if (cached.length > 0) {
    callback(cached);
  } else if (INITIAL_SUBJECTS.length > 0) {
    callback(sortSubjects([...INITIAL_SUBJECTS]));
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
    ensureBundledCodeDataHydrated();
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

  if (!force && isCacheFresh('NOTIFICATIONS', STORAGE_KEYS.NOTIFICATIONS)) {
    return getLocal<AppNotification[]>(STORAGE_KEYS.NOTIFICATIONS, fallbackDefaults);
  }

  const syncedFromServer = await syncCoreFromServer(force);
  if (syncedFromServer && hasCachedValue(STORAGE_KEYS.NOTIFICATIONS)) {
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
  cursorDoc: QueryDocumentSnapshot<DocumentData> | null = null,
  force = false
): Promise<PaginatedPageResult<Feedback>> {
  await hydrateCacheFromIdb();
  if (isQuotaCooldownActive(force)) {
    return {
      items: cursorDoc ? [] : getLocal<Feedback[]>(STORAGE_KEYS.FEEDBACKS, []),
      lastDoc: null,
      hasMore: false,
    };
  }
  try {
    const page = await fetchCollectionPageFromFirestore<Feedback>(
      'feedbacks',
      [orderBy('createdAt', 'desc')],
      cursorDoc,
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
  cursorDoc: QueryDocumentSnapshot<DocumentData> | null = null,
  force = false
): Promise<PaginatedPageResult<LoginRecord>> {
  await hydrateCacheFromIdb();
  if (isQuotaCooldownActive(force)) {
    return {
      items: cursorDoc ? [] : getLocal<LoginRecord[]>(STORAGE_KEYS.LOGINS, []),
      lastDoc: null,
      hasMore: false,
    };
  }
  try {
    const page = await fetchCollectionPageFromFirestore<LoginRecord>(
      'logins',
      [orderBy('timestamp', 'desc')],
      cursorDoc,
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
  cursorDoc: QueryDocumentSnapshot<DocumentData> | null = null,
  force = false
): Promise<PaginatedPageResult<PresenceRecord>> {
  await hydrateCacheFromIdb();
  const filterActive = (list: PresenceRecord[]) => {
    const now = Date.now();
    return list.filter((item) => now - new Date(item.lastSeen).getTime() < 300000);
  };
  if (isQuotaCooldownActive(force)) {
    return {
      items: cursorDoc ? [] : filterActive(getLocal<PresenceRecord[]>(STORAGE_KEYS.PRESENCE, [])),
      lastDoc: null,
      hasMore: false,
    };
  }
  try {
    const fiveMinsAgoIso = new Date(Date.now() - 300000).toISOString();
    const page = await fetchCollectionPageFromFirestore<PresenceRecord>(
      'presence',
      [where('lastSeen', '>=', fiveMinsAgoIso), orderBy('lastSeen', 'desc')],
      cursorDoc,
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
        window.dispatchEvent(new CustomEvent('mpq-online-count-changed', { detail: count }));
        return count;
      }

      if (!auth.currentUser || isQuotaCooldownActive(force)) {
        return getLocal<number>(STORAGE_KEYS.ONLINE_COUNT, 1);
      }

      const fiveMinsAgoIso = new Date(Date.now() - 300000).toISOString();
      const agg = await getCountFromServer(
        query(collection(db, 'presence'), where('lastSeen', '>=', fiveMinsAgoIso), limit(MAX_QUERY_LIMIT))
      );
      const count = Math.max(1, agg.data().count || 0);
      setLocal(STORAGE_KEYS.ONLINE_COUNT, count);
      setSyncTimestamp('ONLINE_COUNT');
      window.dispatchEvent(new CustomEvent('mpq-online-count-changed', { detail: count }));
      return count;
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.LIST, 'presence/count');
      return getLocal<number>(STORAGE_KEYS.ONLINE_COUNT, 1);
    }
  });
}

/**
 * Aggregated Collection Counts using stats/global (1 getDoc) + getCountFromServer(limit(20))
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
    if (isOffline || isQuotaCooldownActive(force)) {
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

let autoSyncCodeStoreTimer: ReturnType<typeof setTimeout> | null = null;
let isCodeStoreSaveRunning = false;
let codeStoreDirtyWhileSaving = false;

async function flushAutoSyncCodeStore() {
  if (typeof window === 'undefined') return;
  if (isCodeStoreSaveRunning) {
    codeStoreDirtyWhileSaving = true;
    return;
  }
  const latestQuestions = sortQuestions(getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []));
  const latestSubjects = sortSubjects(getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []));
  if (latestQuestions.length === 0) return;

  if (!inMemoryAdminToken && !auth.currentUser) {
    window.dispatchEvent(new CustomEvent('mpq-code-store-auth-needed'));
    return;
  }

  isCodeStoreSaveRunning = true;
  window.dispatchEvent(new CustomEvent('mpq-code-store-syncing'));
  try {
    const res = await saveAllToCodeStore({
      questions: latestQuestions,
      subjects: latestSubjects,
    });
    if (res.ok) {
      window.dispatchEvent(new CustomEvent('mpq-code-store-synced', { detail: res }));
    } else if (res.requiresPasscode) {
      window.dispatchEvent(new CustomEvent('mpq-code-store-auth-needed', { detail: res }));
    } else {
      window.dispatchEvent(new CustomEvent('mpq-code-store-error', { detail: res }));
    }
  } finally {
    isCodeStoreSaveRunning = false;
    if (codeStoreDirtyWhileSaving) {
      codeStoreDirtyWhileSaving = false;
      scheduleAutoSyncCodeStore(450);
    }
  }
}

function scheduleAutoSyncCodeStore(delayMs = 1500) {
  if (typeof window === 'undefined') return;
  if (!inMemoryAdminToken && !auth.currentUser) {
    window.dispatchEvent(new CustomEvent('mpq-code-store-auth-needed'));
    return;
  }
  if (autoSyncCodeStoreTimer) {
    clearTimeout(autoSyncCodeStoreTimer);
  }
  autoSyncCodeStoreTimer = setTimeout(() => {
    autoSyncCodeStoreTimer = null;
    void flushAutoSyncCodeStore();
  }, delayMs);
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
  syncMutationToServerCache('questions', { action: 'upsert', item: newQuestion });
  adjustGlobalStat('questionsCount', 1);
  scheduleAutoSyncCodeStore();

  if (auth.currentUser && !isQuotaCooldownActive(false)) {
    try {
      await setDoc(doc(db, 'questions', id), newQuestion);
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.WRITE, 'questions');
    }
  }
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
  syncMutationToServerCache('questions', { action: 'upsertMany', items: created });
  adjustGlobalStat('questionsCount', created.length);
  scheduleAutoSyncCodeStore();

  if (auth.currentUser && !isQuotaCooldownActive(false)) {
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
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.WRITE, 'questions');
    }
  }

  return created;
}

export async function updateQuestion(id: string, updates: Partial<Question>) {
  const cleanUpdates = sanitizeData(updates);

  const cached = getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []);
  const next = cached.map((q) => (q.id === id ? { ...q, ...cleanUpdates } : q));
  setLocal(STORAGE_KEYS.QUESTIONS, next);
  setSyncTimestamp('QUESTIONS');
  window.dispatchEvent(new CustomEvent('mpq-questions-changed', { detail: next }));
  const updatedItem = next.find((q) => q.id === id);
  if (updatedItem) {
    syncMutationToServerCache('questions', { action: 'upsert', item: updatedItem });
  }
  scheduleAutoSyncCodeStore();

  if (auth.currentUser && !isQuotaCooldownActive(false)) {
    try {
      await updateDoc(doc(db, 'questions', id), cleanUpdates);
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.UPDATE, `questions/${id}`);
    }
  }
}

export async function deleteQuestion(id: string) {
  const cached = getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []);
  const next = cached.filter((q) => q.id !== id);
  setLocal(STORAGE_KEYS.QUESTIONS, next);
  setSyncTimestamp('QUESTIONS');
  window.dispatchEvent(new CustomEvent('mpq-questions-changed', { detail: next }));
  syncMutationToServerCache('questions', { action: 'delete', id });
  adjustGlobalStat('questionsCount', -1);
  scheduleAutoSyncCodeStore();

  if (auth.currentUser && !isQuotaCooldownActive(false)) {
    try {
      await deleteDoc(doc(db, 'questions', id));
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.DELETE, `questions/${id}`);
    }
  }
}

export async function deleteQuestionsBatch(ids: string[]): Promise<number> {
  const uniqueIds = Array.from(new Set(ids.filter((id): id is string => Boolean(id))));
  if (uniqueIds.length === 0) return 0;

  const idSet = new Set(uniqueIds);
  const cached = getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []);
  const next = cached.filter((q) => !q.id || !idSet.has(q.id));
  setLocal(STORAGE_KEYS.QUESTIONS, next);
  setSyncTimestamp('QUESTIONS');
  window.dispatchEvent(new CustomEvent('mpq-questions-changed', { detail: next }));
  syncMutationToServerCache('questions', { action: 'deleteMany', ids: uniqueIds });
  adjustGlobalStat('questionsCount', -uniqueIds.length);
  scheduleAutoSyncCodeStore();

  if (auth.currentUser && !isQuotaCooldownActive(false)) {
    const CHUNK_SIZE = 450;
    try {
      for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
        const batch = writeBatch(db);
        const chunk = uniqueIds.slice(i, i + CHUNK_SIZE);
        for (const id of chunk) {
          batch.delete(doc(db, 'questions', id));
        }
        await batch.commit();
      }
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.DELETE, 'questions');
    }
  }

  return uniqueIds.length;
}

export async function syncGlobalStatsExact(counts: { questionsCount: number; subjectsCount: number }) {
  const nextStats: GlobalStats = {
    ...getLocal<GlobalStats>(STORAGE_KEYS.GLOBAL_STATS, {}),
    questionsCount: Math.max(0, counts.questionsCount),
    subjectsCount: Math.max(0, counts.subjectsCount),
    updatedAt: new Date().toISOString(),
  };
  setLocal(STORAGE_KEYS.GLOBAL_STATS, nextStats);
  window.dispatchEvent(new CustomEvent('mpq-global-stats-changed', { detail: nextStats }));
  publishRealtimeDelta({ scope: 'global_stats', action: 'replace', replace: nextStats });

  if (!auth.currentUser) return;
  try {
    await setDoc(
      doc(db, 'stats', 'global'),
      {
        questionsCount: nextStats.questionsCount,
        subjectsCount: nextStats.subjectsCount,
        updatedAt: nextStats.updatedAt,
      },
      { merge: true }
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'stats/global');
  }
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
  syncMutationToServerCache('subjects', { action: 'upsert', item: newSub });
  adjustGlobalStat('subjectsCount', 1);
  scheduleAutoSyncCodeStore();

  if (auth.currentUser && !isQuotaCooldownActive(false)) {
    try {
      await setDoc(doc(db, 'subjects', id), newSub);
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.WRITE, 'subjects');
    }
  }
  return newSub;
}

export async function updateSubject(id: string, updates: Partial<Subject>) {
  const cleanUpdates = sanitizeData(updates);

  const cached = getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []);
  const next = cached.map((s) => (s.id === id ? { ...s, ...cleanUpdates } : s));
  setLocal(STORAGE_KEYS.SUBJECTS, next);
  setSyncTimestamp('SUBJECTS');
  window.dispatchEvent(new CustomEvent('mpq-subjects-changed', { detail: next }));
  const updatedSub = next.find((s) => s.id === id);
  if (updatedSub) {
    syncMutationToServerCache('subjects', { action: 'upsert', item: updatedSub });
  }
  scheduleAutoSyncCodeStore();

  if (auth.currentUser && !isQuotaCooldownActive(false)) {
    try {
      await updateDoc(doc(db, 'subjects', id), cleanUpdates);
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.UPDATE, `subjects/${id}`);
    }
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

  syncMutationToServerCache('subjects', { action: 'upsertMany', items: normalized });
  scheduleAutoSyncCodeStore();

  if (auth.currentUser && !isQuotaCooldownActive(false)) {
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
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.UPDATE, 'subjects');
    }
  }

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
  syncMutationToServerCache('subjects', { action: 'delete', id });
  adjustGlobalStat('subjectsCount', -1);
  scheduleAutoSyncCodeStore();

  if (auth.currentUser && !isQuotaCooldownActive(false)) {
    try {
      await deleteDoc(doc(db, 'subjects', id));
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.DELETE, `subjects/${id}`);
    }
  }
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
  publishRealtimeDelta({ scope: 'logins', action: 'upsert', item: record });

  if (!auth.currentUser) return;
  try {
    await setDoc(doc(db, 'logins', id), record);
    adjustGlobalStat('loginsCount', 1);
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'logins');
  }
}

export async function deleteLoginRecord(id: string) {
  const cached = getLocal<LoginRecord[]>(STORAGE_KEYS.LOGINS, []);
  const next = cached.filter((l) => l.id !== id);
  setLocal(STORAGE_KEYS.LOGINS, next);
  window.dispatchEvent(new CustomEvent('mpq-logins-changed', { detail: next }));
  publishRealtimeDelta({ scope: 'logins', action: 'delete', id });

  if (!auth.currentUser) return;
  try {
    await deleteDoc(doc(db, 'logins', id));
    adjustGlobalStat('loginsCount', -1);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `logins/${id}`);
  }
}

export async function deleteLoginsByIds(ids: string[]) {
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  const cached = getLocal<LoginRecord[]>(STORAGE_KEYS.LOGINS, []);
  const next = cached.filter((l) => !idSet.has(l.id));
  setLocal(STORAGE_KEYS.LOGINS, next);
  window.dispatchEvent(new CustomEvent('mpq-logins-changed', { detail: next }));
  publishRealtimeDelta({ scope: 'logins', action: 'deleteMany', ids });

  if (!auth.currentUser) return;
  try {
    const CHUNK_SIZE = 450;
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const batch = writeBatch(db);
      for (const id of ids.slice(i, i + CHUNK_SIZE)) {
        batch.delete(doc(db, 'logins', id));
      }
      await batch.commit();
    }
    adjustGlobalStat('loginsCount', -ids.length);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, 'logins');
  }
}

export async function updatePresenceHeartbeat(
  username: string,
  role: 'user' | 'admin',
  force = false
) {
  const safeId = `user-${encodeURIComponent(username).replace(/%/g, '_')}`;
  const lastPing = getLocal<{ id: string; at: number } | null>(STORAGE_KEYS.LAST_PRESENCE_PING, null);
  const nowMs = Date.now();
  const isSameUser = lastPing && lastPing.id === safeId;

  const shouldPublishServer = force || !isSameUser || nowMs - lastPing.at >= 120000;
  const shouldWriteFirestore = force || !isSameUser || nowMs - lastPing.at >= 270000;

  if (!shouldPublishServer && !shouldWriteFirestore) {
    return;
  }

  const record: PresenceRecord = sanitizeData({
    id: safeId,
    username,
    role,
    lastSeen: new Date(nowMs).toISOString(),
    uid: auth.currentUser?.uid,
  });

  if (shouldPublishServer) {
    publishRealtimeDelta({ scope: 'presence', action: 'upsert', item: record });
  }

  if (!shouldWriteFirestore) {
    return;
  }

  setLocal(STORAGE_KEYS.LAST_PRESENCE_PING, { id: safeId, at: nowMs });
  if (!auth.currentUser) return;

  try {
    await setDoc(doc(db, 'presence', safeId), record, { merge: true });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'presence');
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
  publishRealtimeDelta({ scope: 'feedbacks', action: 'upsert', item });

  if (!auth.currentUser) return item;
  try {
    await setDoc(doc(db, 'feedbacks', id), item);
    adjustGlobalStat('feedbacksCount', 1);
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'feedbacks');
  }
  return item;
}

export async function broadcastNotification(message: string, type: 'info' | 'success' | 'warning' = 'info') {
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
  syncMutationToServerCache('notifications', { action: 'upsert', item });
  adjustGlobalStat('notificationsCount', 1);

  if (auth.currentUser && !isQuotaCooldownActive(false)) {
    try {
      await setDoc(doc(db, 'notifications', id), item);
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.WRITE, 'notifications');
    }
  }
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
  syncMutationToServerCache('notifications', { action: 'delete', id });
  adjustGlobalStat('notificationsCount', -1);

  if (auth.currentUser && !isQuotaCooldownActive(false)) {
    try {
      await deleteDoc(doc(db, 'notifications', id));
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.DELETE, `notifications/${id}`);
    }
  }
}

export async function deleteAllNotifications(ids: string[]) {
  const dismissed = new Set<string>(getLocal<string[]>(STORAGE_KEYS.DISMISSED_NOTIFS, []));
  dismissed.add('__ALL__');
  ids.forEach((id) => dismissed.add(id));
  setLocal(STORAGE_KEYS.DISMISSED_NOTIFS, Array.from(dismissed));

  setLocal(STORAGE_KEYS.NOTIFICATIONS, []);
  setSyncTimestamp('NOTIFICATIONS');
  window.dispatchEvent(new CustomEvent('mpq-notifications-changed', { detail: [] }));
  syncMutationToServerCache('notifications', { action: 'clear' });
  adjustGlobalStat('notificationsCount', -ids.length);

  if (auth.currentUser && !isQuotaCooldownActive(false)) {
    try {
      const CHUNK_SIZE = 450;
      for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
        const batch = writeBatch(db);
        for (const id of ids.slice(i, i + CHUNK_SIZE)) {
          batch.delete(doc(db, 'notifications', id));
        }
        await batch.commit();
      }
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.DELETE, 'notifications');
    }
  }
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
  if (!auth.currentUser || Date.now() - lastMiss < 5 * 60 * 1000 || isQuotaCooldownActive(false)) {
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

  const cached = getLocal<PaidUser[]>(STORAGE_KEYS.PAID_USERS, []);
  const existingIdx = cached.findIndex((u) => u.id === id);
  if (existingIdx >= 0) {
    cached[existingIdx] = record;
  } else {
    cached.unshift(record);
  }
  setLocal(STORAGE_KEYS.PAID_USERS, cached);
  window.dispatchEvent(new CustomEvent('mpq-paid-users-changed', { detail: cached }));
  publishRealtimeDelta({ scope: 'paid_users', action: 'upsert', item: record });

  try {
    await setDoc(doc(db, 'paid_users', id), sanitizeData(record), { merge: true });
    await broadcastNotification(
      `🎉 សូមស្វាគមន៍សមាជិក VIP ថ្មី «${record.username}» បានបង់ប្រាក់ $10 ជោគជ័យ និងទទួលបានសិទ្ធិចូលប្រើប្រាស់ពេញមួយជីវិត!`,
      'success'
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'paid_users');
  }

  return record;
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
  const updatedItem = next.find((u) => u.id === id);
  if (updatedItem) {
    publishRealtimeDelta({ scope: 'paid_users', action: 'upsert', item: updatedItem });
  }

  try {
    await updateDoc(doc(db, 'paid_users', id), { status, permanentAccess });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `paid_users/${id}`);
  }
}

export async function deletePaidUser(id: string) {
  const cached = getLocal<PaidUser[]>(STORAGE_KEYS.PAID_USERS, []);
  const next = cached.filter((u) => u.id !== id);
  setLocal(STORAGE_KEYS.PAID_USERS, next);
  window.dispatchEvent(new CustomEvent('mpq-paid-users-changed', { detail: next }));
  publishRealtimeDelta({ scope: 'paid_users', action: 'delete', id });

  try {
    await deleteDoc(doc(db, 'paid_users', id));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `paid_users/${id}`);
  }
}

function getBotCommandDocId(command: string): string {
  return command.replace(/^\//, '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

export async function fetchBotCommandsCached(force = false): Promise<Record<string, BotCommandConfig>> {
  await hydrateCacheFromIdb();

  if (
    !force &&
    isCacheFresh('CORE_CHECK') &&
    isCacheFresh('BOT_COMMANDS', STORAGE_KEYS.BOT_COMMANDS, true)
  ) {
    return getLocal<Record<string, BotCommandConfig>>(STORAGE_KEYS.BOT_COMMANDS, {});
  }

  const syncedFromServer = await syncCoreFromServer(force);
  const afterServer = getLocal<Record<string, BotCommandConfig>>(STORAGE_KEYS.BOT_COMMANDS, {});
  if (syncedFromServer && Object.keys(afterServer).length > 0) {
    return afterServer;
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

  syncMutationToServerCache('bot_commands', { replace: next, authoritative: true });

  if (auth.currentUser && !isQuotaCooldownActive(false)) {
    try {
      await setDoc(doc(db, 'bot_commands', docId), payload);
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.WRITE, `bot_commands/${docId}`);
    }
  }

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
  syncMutationToServerCache('bot_commands', { replace: next, authoritative: true });

  if (auth.currentUser && !isQuotaCooldownActive(false)) {
    try {
      await deleteDoc(doc(db, 'bot_commands', docId));
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.DELETE, `bot_commands/${docId}`);
    }
  }

  await syncTelegramBotTemplates(next);
}

export async function resetAllBotCommands(commands: string[]) {
  setLocal(STORAGE_KEYS.BOT_COMMANDS, {});
  setSyncTimestamp('BOT_COMMANDS');
  window.dispatchEvent(new CustomEvent('mpq-bot-commands-changed', { detail: {} }));
  syncMutationToServerCache('bot_commands', { replace: {}, authoritative: true });

  if (auth.currentUser && !isQuotaCooldownActive(false)) {
    try {
      const CHUNK_SIZE = 450;
      for (let i = 0; i < commands.length; i += CHUNK_SIZE) {
        const batch = writeBatch(db);
        for (const cmd of commands.slice(i, i + CHUNK_SIZE)) {
          batch.delete(doc(db, 'bot_commands', getBotCommandDocId(cmd)));
        }
        await batch.commit();
      }
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.DELETE, 'bot_commands');
    }
  }

  await syncTelegramBotTemplates({});
}

// ---------------- Real-Time Synchronization Engine (SSE + BroadcastChannel + Firestore onSnapshot) ----------------

function mergeByIdWithAction<T extends { id?: string }>(
  existing: T[],
  evt: RealtimeDeltaEvent
): { changed: boolean; next: T[] } {
  const action = evt.action || 'replace';
  if (action === 'clear') {
    return { changed: existing.length > 0, next: [] };
  }
  if (action === 'upsert' && evt.item?.id) {
    const map = new Map<string, T>();
    for (const entry of existing) {
      if (entry?.id) map.set(entry.id, entry);
    }
    const prev = map.get(evt.item.id);
    map.set(evt.item.id, prev ? { ...prev, ...evt.item } : evt.item);
    return { changed: true, next: Array.from(map.values()) };
  }
  if (action === 'upsertMany' && Array.isArray(evt.items)) {
    const map = new Map<string, T>();
    for (const entry of existing) {
      if (entry?.id) map.set(entry.id, entry);
    }
    let mutated = false;
    for (const item of evt.items) {
      if (item?.id) {
        const prev = map.get(item.id);
        map.set(item.id, prev ? { ...prev, ...item } : item);
        mutated = true;
      }
    }
    return { changed: mutated, next: Array.from(map.values()) };
  }
  if (action === 'delete' && evt.id) {
    const next = existing.filter((entry) => entry?.id !== evt.id);
    return { changed: next.length !== existing.length, next };
  }
  if (action === 'deleteMany' && Array.isArray(evt.ids) && evt.ids.length > 0) {
    const idSet = new Set(evt.ids);
    const next = existing.filter((entry) => !entry?.id || !idSet.has(entry.id));
    return { changed: next.length !== existing.length, next };
  }
  if (Array.isArray(evt.replace)) {
    return { changed: true, next: dedupeById(evt.replace as T[]) };
  }
  return { changed: false, next: existing };
}

function applyRealtimeDeltaEvent(evt: RealtimeDeltaEvent) {
  if (!evt || typeof evt.scope !== 'string') return;

  const isCoreScope =
    evt.scope === 'questions' ||
    evt.scope === 'subjects' ||
    evt.scope === 'notifications' ||
    evt.scope === 'bot_commands';

  if (typeof evt.version === 'number' && evt.version > 0 && !(evt.scope === 'core' && evt.action === 'refresh')) {
    const prevVersion = getLocal<number>(STORAGE_KEYS.CORE_SERVER_VERSION, 0);
    if (evt.version > prevVersion) {
      if (isCoreScope) {
        setLocal(STORAGE_KEYS.CORE_SERVER_VERSION, evt.version);
        if (hasNonEmptyCoreArrays()) {
          setSyncTimestamp('CORE_CHECK');
        }
      } else if (evt.sourceClientId !== REALTIME_CLIENT_ID) {
        // Server core version advanced while this client wasn't synced — catch up immediately
        void syncCoreFromServer(true);
      }
    }
  }

  // Skip self-originated echoes (except online_count which is computed centrally on the server)
  if (evt.sourceClientId && evt.sourceClientId === REALTIME_CLIENT_ID && evt.scope !== 'online_count') {
    return;
  }

  switch (evt.scope) {
    case 'online_count': {
      const nextCount = Math.max(1, Number(evt.onlineCount ?? evt.replace ?? 1));
      const prevCount = getLocal<number>(STORAGE_KEYS.ONLINE_COUNT, 1);
      setLocal(STORAGE_KEYS.ONLINE_COUNT, nextCount);
      setSyncTimestamp('ONLINE_COUNT');
      if (nextCount !== prevCount) {
        window.dispatchEvent(new CustomEvent('mpq-online-count-changed', { detail: nextCount }));
      }
      return;
    }

    case 'core': {
      if (evt.action === 'refresh') {
        void syncCoreFromServer(true);
      }
      return;
    }

    case 'questions': {
      const existing = getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []);
      if (
        !evt.action &&
        Array.isArray(evt.replace) &&
        !evt.authoritative &&
        evt.replace.length < existing.length
      ) {
        return;
      }
      const { changed, next } = mergeByIdWithAction(existing, evt);
      if (!changed) return;
      const sorted = sortQuestions(next);
      setLocal(STORAGE_KEYS.QUESTIONS, sorted);
      setSyncTimestamp('QUESTIONS');
      window.dispatchEvent(new CustomEvent('mpq-questions-changed', { detail: sorted }));
      return;
    }

    case 'subjects': {
      const existing = getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []);
      if (
        !evt.action &&
        Array.isArray(evt.replace) &&
        !evt.authoritative &&
        evt.replace.length < existing.length
      ) {
        return;
      }
      const { changed, next } = mergeByIdWithAction(existing, evt);
      if (!changed) return;
      const sorted = sortSubjects(next);
      setLocal(STORAGE_KEYS.SUBJECTS, sorted);
      setSyncTimestamp('SUBJECTS');
      window.dispatchEvent(new CustomEvent('mpq-subjects-changed', { detail: sorted }));
      return;
    }

    case 'notifications': {
      const existing = getLocal<AppNotification[]>(STORAGE_KEYS.NOTIFICATIONS, []);
      const { changed, next } = mergeByIdWithAction(existing, evt);
      if (!changed && evt.action !== 'clear') return;
      const resolved = resolveNotificationsWithDismissed(next);
      setLocal(STORAGE_KEYS.NOTIFICATIONS, resolved);
      setSyncTimestamp('NOTIFICATIONS');
      window.dispatchEvent(new CustomEvent('mpq-notifications-changed', { detail: resolved }));
      return;
    }

    case 'bot_commands': {
      if (evt.replace && typeof evt.replace === 'object' && !Array.isArray(evt.replace)) {
        const next = evt.replace as Record<string, BotCommandConfig>;
        setLocal(STORAGE_KEYS.BOT_COMMANDS, next);
        setSyncTimestamp('BOT_COMMANDS');
        window.dispatchEvent(new CustomEvent('mpq-bot-commands-changed', { detail: next }));
      }
      return;
    }

    case 'global_stats': {
      const incoming = (evt.replace || evt.item) as GlobalStats | undefined;
      if (!incoming || typeof incoming !== 'object') return;
      const prev = getLocal<GlobalStats>(STORAGE_KEYS.GLOBAL_STATS, {});
      const next: GlobalStats = { ...prev, ...incoming };
      setLocal(STORAGE_KEYS.GLOBAL_STATS, next);
      setSyncTimestamp('GLOBAL_STATS');
      window.dispatchEvent(new CustomEvent('mpq-global-stats-changed', { detail: next }));
      return;
    }

    case 'feedbacks': {
      const existing = getLocal<Feedback[]>(STORAGE_KEYS.FEEDBACKS, []);
      const { changed, next } = mergeByIdWithAction(existing, evt);
      if (!changed) return;
      const sorted = [...next]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 100);
      setLocal(STORAGE_KEYS.FEEDBACKS, sorted);
      setSyncTimestamp('FEEDBACKS');
      window.dispatchEvent(new CustomEvent('mpq-feedbacks-changed', { detail: sorted }));
      return;
    }

    case 'logins': {
      const existing = getLocal<LoginRecord[]>(STORAGE_KEYS.LOGINS, []);
      const { changed, next } = mergeByIdWithAction(existing, evt);
      if (!changed) return;
      const sorted = [...next]
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, 100);
      setLocal(STORAGE_KEYS.LOGINS, sorted);
      setSyncTimestamp('LOGINS');
      window.dispatchEvent(new CustomEvent('mpq-logins-changed', { detail: sorted }));
      return;
    }

    case 'presence': {
      const existing = getLocal<PresenceRecord[]>(STORAGE_KEYS.PRESENCE, []);
      const { changed, next } = mergeByIdWithAction(existing, evt);
      if (!changed) return;
      const now = Date.now();
      const activeList = next
        .filter((item) => now - new Date(item.lastSeen).getTime() < 300000)
        .sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
      setLocal(STORAGE_KEYS.PRESENCE, activeList);
      setSyncTimestamp('PRESENCE');
      window.dispatchEvent(new CustomEvent('mpq-presence-changed', { detail: activeList }));
      return;
    }

    case 'paid_users': {
      const existing = getLocal<PaidUser[]>(STORAGE_KEYS.PAID_USERS, []);
      const { changed, next } = mergeByIdWithAction(existing, evt);
      if (!changed) return;
      const sorted = [...next].sort(
        (a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime()
      );
      setLocal(STORAGE_KEYS.PAID_USERS, sorted);
      setSyncTimestamp('PAID_USERS');
      window.dispatchEvent(new CustomEvent('mpq-paid-users-changed', { detail: sorted }));
      return;
    }
  }
}

export function startCoreRealtimeSync(options?: {
  isAdmin?: boolean;
  username?: string;
  role?: 'user' | 'admin';
}): () => void {
  if (typeof window === 'undefined') return () => {};

  let disposed = false;
  let eventSource: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let usePollingMode = false;
  let sseFailureCount = 0;
  const firestoreUnsubs: Array<() => void> = [];

  const startLivePolling = (immediate = true) => {
    if (disposed) return;
    usePollingMode = true;
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (immediate && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
      void syncCoreFromServer(false, true);
    }
    if (!pollTimer) {
      pollTimer = setInterval(() => {
        if (disposed) return;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
        void syncCoreFromServer(false, true);
      }, 8000);
    }
  };

  const connectSse = () => {
    if (disposed || usePollingMode || typeof EventSource === 'undefined') return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

    if (eventSource && eventSource.readyState !== EventSource.CLOSED) {
      return;
    }

    const params = new URLSearchParams({ clientId: REALTIME_CLIENT_ID });
    if (options?.username) params.set('username', options.username);
    if (options?.role) params.set('role', options.role);

    try {
      const es = new EventSource(`/api/realtime/stream?${params.toString()}`);
      eventSource = es;

      es.addEventListener('connected', (event: MessageEvent) => {
        if (disposed) return;
        sseFailureCount = 0;
        try {
          const data = JSON.parse(event.data || '{}') as {
            version?: number;
            onlineCount?: number;
          };
          if (typeof data.onlineCount === 'number') {
            const count = Math.max(1, data.onlineCount);
            setLocal(STORAGE_KEYS.ONLINE_COUNT, count);
            setSyncTimestamp('ONLINE_COUNT');
            window.dispatchEvent(new CustomEvent('mpq-online-count-changed', { detail: count }));
          }
          const localVer = getLocal<number>(STORAGE_KEYS.CORE_SERVER_VERSION, 0);
          if (
            (typeof data.version === 'number' && data.version > localVer) ||
            !hasNonEmptyCoreArrays()
          ) {
            void syncCoreFromServer(true);
          }
        } catch {
          // Ignore malformed SSE payload
        }
      });

      es.addEventListener('sync', (event: MessageEvent) => {
        if (disposed) return;
        try {
          const data = JSON.parse(event.data || '{}') as RealtimeDeltaEvent;
          applyRealtimeDeltaEvent(data);
        } catch {
          // Ignore malformed SSE sync payload
        }
      });

      es.onerror = () => {
        if (disposed) return;
        sseFailureCount += 1;
        if (sseFailureCount >= 2) {
          // Serverless environment (e.g. Vercel) without persistent SSE — switch cleanly to ETag polling
          startLivePolling(true);
          return;
        }
        if (es.readyState === EventSource.CLOSED && !reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connectSse();
          }, 5000);
        }
      };
    } catch {
      startLivePolling(true);
    }
  };

  // Detect whether backend supports persistent SSE (Node/Express) or Serverless ETag Polling (Vercel)
  void fetch('/api/health', { cache: 'no-store' })
    .then(async (res) => {
      if (disposed) return;
      const contentType = res.headers.get('content-type') || '';
      if (!res.ok || !contentType.includes('application/json')) {
        startLivePolling(true);
        return;
      }
      const health = await res.json().catch(() => null);
      if (disposed) return;
      if (health?.realtimeMode === 'poll') {
        startLivePolling(true);
      } else {
        connectSse();
      }
    })
    .catch(() => {
      if (!disposed) startLivePolling(false);
    });

  // Same-browser multi-tab instant synchronization via BroadcastChannel
  const channel = getRealtimeBroadcastChannel();
  const handleChannelMessage = (event: MessageEvent) => {
    if (disposed || !event?.data) return;
    applyRealtimeDeltaEvent(event.data as RealtimeDeltaEvent);
  };
  if (channel) {
    channel.addEventListener('message', handleChannelMessage);
  }

  // Reconnect SSE & refresh presence/core if needed when network returns or tab wakes up
  const handleResume = () => {
    if (disposed) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (usePollingMode) {
      void syncCoreFromServer(false, true);
    } else {
      if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
        connectSse();
      }
      if (!isCacheFresh('CORE_CHECK') || !hasNonEmptyCoreArrays()) {
        void syncCoreFromServer(false);
      }
    }
    if (options?.username && options?.role) {
      void updatePresenceHeartbeat(options.username, options.role, false);
    }
  };
  const handleVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      handleResume();
    }
  };
  window.addEventListener('online', handleResume);
  window.addEventListener('focus', handleResume);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  const watchdogTimer = setInterval(() => {
    if (disposed) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (usePollingMode) {
      if (!pollTimer) startLivePolling(true);
      return;
    }
    if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
      connectSse();
    }
    if (!isCacheFresh('CORE_CHECK') || !hasNonEmptyCoreArrays()) {
      void syncCoreFromServer(false);
    }
  }, 60000);

  // Targeted, quota-safe Firestore real-time listeners (strictly limit <= 20)
  const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (!isOffline && !isQuotaCooldownActive(false)) {
    const notifQuery = query(
      collection(db, 'notifications'),
      orderBy('timestamp', 'desc'),
      limit(MAX_QUERY_LIMIT)
    );
    firestoreUnsubs.push(
      onSnapshot(
        notifQuery,
        (snap) => {
          if (disposed) return;
          if (snap.empty && snap.metadata.fromCache && hasCachedValue(STORAGE_KEYS.NOTIFICATIONS)) {
            return;
          }
          const raw: AppNotification[] = [];
          snap.forEach((d) =>
            raw.push({ id: d.id, ...(d.data() as Omit<AppNotification, 'id'>) })
          );
          const resolved = resolveNotificationsWithDismissed(raw);
          setLocal(STORAGE_KEYS.NOTIFICATIONS, resolved);
          setSyncTimestamp('NOTIFICATIONS');
          window.dispatchEvent(new CustomEvent('mpq-notifications-changed', { detail: resolved }));
        },
        (err) => {
          markClientQuotaCooldownIfNeeded(err);
          handleFirestoreError(err, OperationType.LIST, 'notifications');
        }
      )
    );

    firestoreUnsubs.push(
      onSnapshot(
        doc(db, 'stats', 'global'),
        (snap) => {
          if (disposed || !snap.exists()) return;
          const data = snap.data() as GlobalStats;
          setLocal(STORAGE_KEYS.GLOBAL_STATS, data);
          setSyncTimestamp('GLOBAL_STATS');
          window.dispatchEvent(new CustomEvent('mpq-global-stats-changed', { detail: data }));
        },
        (err) => {
          markClientQuotaCooldownIfNeeded(err);
          handleFirestoreError(err, OperationType.GET, 'stats/global');
        }
      )
    );

    if (options?.isAdmin && auth.currentUser) {
      firestoreUnsubs.push(
        onSnapshot(
          query(collection(db, 'feedbacks'), orderBy('createdAt', 'desc'), limit(MAX_QUERY_LIMIT)),
          (snap) => {
            if (disposed) return;
            const items: Feedback[] = [];
            snap.forEach((d) => items.push({ id: d.id, ...(d.data() as Omit<Feedback, 'id'>) }));
            setLocal(STORAGE_KEYS.FEEDBACKS, items);
            setSyncTimestamp('FEEDBACKS');
            window.dispatchEvent(new CustomEvent('mpq-feedbacks-changed', { detail: items }));
          },
          (err) => {
            markClientQuotaCooldownIfNeeded(err);
            handleFirestoreError(err, OperationType.LIST, 'feedbacks');
          }
        )
      );

      firestoreUnsubs.push(
        onSnapshot(
          query(collection(db, 'logins'), orderBy('timestamp', 'desc'), limit(MAX_QUERY_LIMIT)),
          (snap) => {
            if (disposed) return;
            const items: LoginRecord[] = [];
            snap.forEach((d) =>
              items.push({ id: d.id, ...(d.data() as Omit<LoginRecord, 'id'>) })
            );
            setLocal(STORAGE_KEYS.LOGINS, items);
            setSyncTimestamp('LOGINS');
            window.dispatchEvent(new CustomEvent('mpq-logins-changed', { detail: items }));
          },
          (err) => {
            markClientQuotaCooldownIfNeeded(err);
            handleFirestoreError(err, OperationType.LIST, 'logins');
          }
        )
      );

      const fiveMinsAgoIso = new Date(Date.now() - 300000).toISOString();
      firestoreUnsubs.push(
        onSnapshot(
          query(
            collection(db, 'presence'),
            where('lastSeen', '>=', fiveMinsAgoIso),
            orderBy('lastSeen', 'desc'),
            limit(MAX_QUERY_LIMIT)
          ),
          (snap) => {
            if (disposed) return;
            const now = Date.now();
            const items: PresenceRecord[] = [];
            snap.forEach((d) =>
              items.push({ id: d.id, ...(d.data() as Omit<PresenceRecord, 'id'>) })
            );
            const activeList = items.filter(
              (item) => now - new Date(item.lastSeen).getTime() < 300000
            );
            setLocal(STORAGE_KEYS.PRESENCE, activeList);
            setSyncTimestamp('PRESENCE');
            window.dispatchEvent(new CustomEvent('mpq-presence-changed', { detail: activeList }));
          },
          (err) => {
            markClientQuotaCooldownIfNeeded(err);
            handleFirestoreError(err, OperationType.LIST, 'presence');
          }
        )
      );

      firestoreUnsubs.push(
        onSnapshot(
          query(collection(db, 'paid_users'), orderBy('paidAt', 'desc'), limit(MAX_QUERY_LIMIT)),
          (snap) => {
            if (disposed) return;
            const items: PaidUser[] = [];
            snap.forEach((d) => items.push({ id: d.id, ...(d.data() as Omit<PaidUser, 'id'>) }));
            setLocal(STORAGE_KEYS.PAID_USERS, items);
            setSyncTimestamp('PAID_USERS');
            window.dispatchEvent(new CustomEvent('mpq-paid-users-changed', { detail: items }));
          },
          (err) => {
            markClientQuotaCooldownIfNeeded(err);
            handleFirestoreError(err, OperationType.LIST, 'paid_users');
          }
        )
      );
    }
  }

  return () => {
    disposed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    if (channel) {
      channel.removeEventListener('message', handleChannelMessage);
    }
    clearInterval(watchdogTimer);
    window.removeEventListener('online', handleResume);
    window.removeEventListener('focus', handleResume);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    for (const unsub of firestoreUnsubs) {
      try {
        unsub();
      } catch {
        // Ignore unsubscribe error
      }
    }
  };
}

// ---------------- Code Store Status & Save Helpers ----------------

export interface CodeStoreStatus {
  version: number;
  updatedAt: string | null;
  subjectsCount: number;
  questionsCount: number;
  writable: boolean;
  githubConfigured?: boolean;
  hasToken?: boolean;
  hasRepo?: boolean;
  missingVars?: string[];
  githubRepo?: string | null;
  githubBranch?: string | null;
  storageMode?: 'github' | 'disk' | 'hybrid' | 'readonly';
  githubReachable?: boolean;
  githubCheckError?: string | null;
  canPush?: boolean;
  defaultBranch?: string | null;
  statusError?: string | null;
}

export interface SaveToCodeStoreResult {
  ok: boolean;
  readOnly?: boolean;
  requiresPasscode?: boolean;
  githubRequired?: boolean;
  githubConfigured?: boolean;
  hasToken?: boolean;
  hasRepo?: boolean;
  missingVars?: string[];
  githubSynced?: boolean;
  diskSaved?: boolean;
  githubRepo?: string | null;
  githubBranch?: string | null;
  commitUrl?: string;
  commitSha?: string;
  version?: number;
  updatedAt?: string;
  subjectsCount?: number;
  questionsCount?: number;
  error?: string;
}

export async function fetchCodeStoreStatus(checkGitHub = false): Promise<CodeStoreStatus> {
  const endpoint = `/api/code-store/status${checkGitHub ? '?check=github' : ''}`;
  try {
    const res = await fetch(endpoint, { cache: 'no-store' });
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        return {
          version: Number(data.version || INITIAL_BUNDLED_VERSION),
          updatedAt: data.updatedAt || null,
          subjectsCount: Number(data.subjectsCount ?? INITIAL_SUBJECTS.length),
          questionsCount: Number(data.questionsCount ?? INITIAL_QUESTIONS.length),
          writable: Boolean(data.writable),
          githubConfigured: Boolean(data.githubConfigured),
          hasToken: typeof data.hasToken === 'boolean' ? data.hasToken : undefined,
          hasRepo: typeof data.hasRepo === 'boolean' ? data.hasRepo : undefined,
          missingVars: Array.isArray(data.missingVars) ? data.missingVars : undefined,
          githubRepo: data.githubRepo || null,
          githubBranch: data.githubBranch || null,
          storageMode: data.storageMode,
          githubReachable:
            typeof data.githubReachable === 'boolean' ? data.githubReachable : undefined,
          githubCheckError:
            typeof data.githubCheckError === 'string' ? data.githubCheckError : null,
          canPush: typeof data.canPush === 'boolean' ? data.canPush : undefined,
          defaultBranch: typeof data.defaultBranch === 'string' ? data.defaultBranch : null,
          statusError: typeof data.warning === 'string' ? data.warning : null,
        };
      }
      const errText =
        typeof data?.error === 'string' && data.error
          ? data.error
          : `API Status Error (HTTP ${res.status})`;
      return {
        version: INITIAL_BUNDLED_VERSION,
        updatedAt: null,
        subjectsCount: INITIAL_SUBJECTS.length,
        questionsCount: INITIAL_QUESTIONS.length,
        writable: false,
        githubConfigured: false,
        storageMode: 'readonly',
        statusError: errText,
      };
    }

    const rawSnippet = (await res.text().catch(() => ''))
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 140);

    const statusError =
      res.status >= 400
        ? `API /api/code-store/status បរាជ័យ (HTTP ${res.status})${rawSnippet ? `: ${rawSnippet}` : ' — សូមពិនិត្យថា Vercel មាន Folder /api និង Redeploy ម្ដងទៀត!'}`
        : 'Hosting នេះកំពុងដំណើរការជា Static (មិនមាន Vercel Serverless /api/code-store/status ទេ)';

    return {
      version: INITIAL_BUNDLED_VERSION,
      updatedAt: null,
      subjectsCount: INITIAL_SUBJECTS.length,
      questionsCount: INITIAL_QUESTIONS.length,
      writable: false,
      githubConfigured: false,
      storageMode: 'readonly',
      statusError,
    };
  } catch (err: any) {
    return {
      version: INITIAL_BUNDLED_VERSION,
      updatedAt: null,
      subjectsCount: INITIAL_SUBJECTS.length,
      questionsCount: INITIAL_QUESTIONS.length,
      writable: false,
      githubConfigured: false,
      storageMode: 'readonly',
      statusError: `មិនអាចតភ្ជាប់ទៅ /api/code-store/status បានទេ៖ ${err?.message || 'Network error'}`,
    };
  }
}

export async function saveAllToCodeStore(params: {
  questions: Question[];
  subjects: Subject[];
  passcode?: string;
}): Promise<SaveToCodeStoreResult> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (inMemoryAdminToken) {
      headers['X-Admin-Token'] = inMemoryAdminToken;
    }
    const authHeader = await getAuthBearerHeader();
    if (authHeader) {
      headers['Authorization'] = authHeader;
    }
    if (params.passcode && params.passcode.trim()) {
      headers['X-Admin-Passcode'] = params.passcode.trim();
    }

    const res = await fetch('/api/code-store/save', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        questions: params.questions,
        subjects: params.subjects,
        clientId: REALTIME_CLIENT_ID,
      }),
    });

    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json')
      ? await res.json().catch(() => null)
      : null;

    if (!data) {
      if (res.status === 413) {
        return {
          ok: false,
          error: 'ទំហំទិន្នន័យលើសកម្រិត Vercel (4.5 MB)! សូមពិនិត្យទំហំសំណួរ។',
        };
      }

      const rawText = await res.text().catch(() => '');
      const cleanSnippet = rawText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

      if (res.status >= 400) {
        return {
          ok: false,
          error: `Serverless API /api/code-store/save បរាជ័យ (HTTP ${res.status})${cleanSnippet ? `: ${cleanSnippet}` : ' — សូមពិនិត្យថាបាន Deploy Folder /api ទៅ GitHub/Vercel រួចរាល់!'}`,
        };
      }

      return {
        ok: false,
        readOnly: true,
        error: 'បរិយាកាស Hosting នេះមិនគាំទ្រការសរសេរផ្ទាល់លើ Code ទេ — កម្មវិធីនឹងទាញយកឯកសារ bundledQuestions.ts ជំនួសវិញ។',
      };
    }

    if (typeof data.adminToken === 'string' && data.adminToken) {
      setAdminSessionToken(data.adminToken);
    }

    if (data.ok && typeof data.version === 'number') {
      lastHydratedBundledVer = data.version;
      setLocal(STORAGE_KEYS.BUNDLED_REVISION, data.version);
      setLocal(STORAGE_KEYS.CORE_SERVER_VERSION, data.version);
    }

    return data as SaveToCodeStoreResult;
  } catch (err: any) {
    return {
      ok: false,
      error: `មិនអាចតភ្ជាប់ទៅ Server (/api/code-store/save) បានទេ៖ ${err?.message || 'សូមពិនិត្យអ៊ីនធឺណិត ឬស្ថានភាព Vercel Deployment'}`,
    };
  }
}
