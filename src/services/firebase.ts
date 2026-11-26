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
  QueryConstraint,
  QueryDocumentSnapshot,
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

function syncMutationToServerCache(
  scope: 'questions' | 'subjects' | 'notifications' | 'bot_commands',
  replace: unknown
) {
  if (typeof fetch === 'undefined') return;
  void fetch('/api/cache/mutate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, replace }),
  })
    .then(async (res) => {
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (typeof data?.version === 'number') {
          setLocal(STORAGE_KEYS.CORE_SERVER_VERSION, data.version);
          setSyncTimestamp('CORE_CHECK');
        }
      }
    })
    .catch(() => {
      // Ignore when running purely offline
    });
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
  forceServer = false
): Promise<PaginatedPageResult<T>> {
  const pageConstraints = cursorDoc
    ? [...constraints, startAfter(cursorDoc), limit(MAX_QUERY_LIMIT)]
    : [...constraints, limit(MAX_QUERY_LIMIT)];
  const q = query(collection(db, collectionName), ...pageConstraints);

  if (!forceServer) {
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
 * Paginated sequential cursor loader for full datasets (uses limit(20) + startAfter() per page)
 */
async function fetchAllPagesWithLimit20<T>(
  collectionName: string,
  constraints: QueryConstraint[],
  mapDoc: (d: QueryDocumentSnapshot<DocumentData>) => T,
  forceServer = false,
  maxPages = 40
): Promise<T[]> {
  const collected: T[] = [];
  let cursorDoc: QueryDocumentSnapshot<DocumentData> | null = null;
  let pageCount = 0;

  while (pageCount < maxPages) {
    const page: PaginatedPageResult<T> = await fetchCollectionPageFromFirestore<T>(
      collectionName,
      constraints,
      cursorDoc,
      mapDoc,
      forceServer
    );
    collected.push(...page.items);
    pageCount += 1;
    if (!page.hasMore || !page.lastDoc) break;
    cursorDoc = page.lastDoc;
  }

  return collected;
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
async function syncCoreFromServer(force = false): Promise<boolean> {
  await hydrateCacheFromIdb();

  if (
    !force &&
    (isQuotaCooldownActive(false) ||
      (isCacheFresh('CORE_CHECK') &&
        hasCachedValue(STORAGE_KEYS.QUESTIONS) &&
        hasCachedValue(STORAGE_KEYS.SUBJECTS)))
  ) {
    return true;
  }

  return runDeduplicated(`core_server:${force ? 'force' : 'ttl'}`, async () => {
    if (
      !force &&
      (isQuotaCooldownActive(false) ||
        (isCacheFresh('CORE_CHECK') &&
          hasCachedValue(STORAGE_KEYS.QUESTIONS) &&
          hasCachedValue(STORAGE_KEYS.SUBJECTS)))
    ) {
      return true;
    }

    try {
      const hasAllLocal =
        hasCachedValue(STORAGE_KEYS.QUESTIONS) &&
        hasCachedValue(STORAGE_KEYS.SUBJECTS) &&
        hasCachedValue(STORAGE_KEYS.BOT_COMMANDS);
      const savedVersion = hasAllLocal
        ? getLocal<number>(STORAGE_KEYS.CORE_SERVER_VERSION, 0)
        : 0;

      const params = new URLSearchParams();
      if (force) params.set('force', '1');
      if (!force && savedVersion > 0) params.set('since', String(savedVersion));

      const authHeader = await getAuthBearerHeader();
      const headers: Record<string, string> = {};
      if (authHeader) headers['Authorization'] = authHeader;

      const res = await fetch(`/api/cache/core?${params.toString()}`, {
        cache: 'no-store',
        headers,
      });
      const payload = await res.json().catch(() => null);

      if (payload?.quotaLimited) {
        clientQuotaCooldownUntil = Date.now() + 5 * 60 * 1000;
      }

      if (!res.ok || !payload) {
        return false;
      }

      setSyncTimestamp('CORE_CHECK');

      if (payload?.unchanged) {
        setSyncTimestamp('QUESTIONS');
        setSyncTimestamp('SUBJECTS');
        setSyncTimestamp('NOTIFICATIONS');
        setSyncTimestamp('BOT_COMMANDS');
        return true;
      }

      if (Array.isArray(payload?.questions)) {
        const sortedQ = sortQuestions(payload.questions);
        setLocal(STORAGE_KEYS.QUESTIONS, sortedQ);
        setSyncTimestamp('QUESTIONS');
        window.dispatchEvent(new CustomEvent('mpq-questions-changed', { detail: sortedQ }));
      }

      if (Array.isArray(payload?.subjects)) {
        const sortedSub = sortSubjects(payload.subjects);
        setLocal(STORAGE_KEYS.SUBJECTS, sortedSub);
        setSyncTimestamp('SUBJECTS');
        window.dispatchEvent(new CustomEvent('mpq-subjects-changed', { detail: sortedSub }));
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

      if (typeof payload?.version === 'number') {
        setLocal(STORAGE_KEYS.CORE_SERVER_VERSION, payload.version);
      }

      return true;
    } catch {
      return false;
    }
  });
}

// ---------------- Cached Fetchers & Paginated Loaders ----------------

export async function fetchQuestionsCached(force = false): Promise<Question[]> {
  await hydrateCacheFromIdb();

  if (!force && isCacheFresh('QUESTIONS', STORAGE_KEYS.QUESTIONS, true)) {
    return sortQuestions(getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []));
  }

  const syncedFromServer = await syncCoreFromServer(force);
  const afterServer = sortQuestions(getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []));
  if (syncedFromServer && afterServer.length > 0) {
    return afterServer;
  }

  return runDeduplicated(`questions:${force ? 'force' : 'ttl'}`, async () => {
    if (!force && isCacheFresh('QUESTIONS', STORAGE_KEYS.QUESTIONS, true)) {
      return sortQuestions(getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []));
    }
    try {
      if (!force) {
        const cachedSnap = await getDocsFromCache(
          query(collection(db, 'questions'), limit(MAX_QUERY_LIMIT))
        ).catch(() => null);
        if (cachedSnap && !cachedSnap.empty) {
          const cachedAll = await fetchAllPagesWithLimit20<Question>(
            'questions',
            [],
            (d) => ({ id: d.id, ...(d.data() as Omit<Question, 'id'>) }),
            false
          );
          if (cachedAll.length > 0) {
            const sorted = sortQuestions(cachedAll);
            setLocal(STORAGE_KEYS.QUESTIONS, sorted);
            setSyncTimestamp('QUESTIONS');
            window.dispatchEvent(new CustomEvent('mpq-questions-changed', { detail: sorted }));
            return sorted;
          }
        }
      }

      if (isQuotaCooldownActive(force) || !auth.currentUser) {
        return sortQuestions(getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []));
      }

      const questions = await fetchAllPagesWithLimit20<Question>(
        'questions',
        [],
        (d) => ({ id: d.id, ...(d.data() as Omit<Question, 'id'>) }),
        force
      );
      const sorted = sortQuestions(questions);
      setLocal(STORAGE_KEYS.QUESTIONS, sorted);
      setSyncTimestamp('QUESTIONS');
      if (sorted.length > 0) {
        syncMutationToServerCache('questions', sorted);
      }
      window.dispatchEvent(new CustomEvent('mpq-questions-changed', { detail: sorted }));
      return sorted;
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

  if (!force && isCacheFresh('SUBJECTS', STORAGE_KEYS.SUBJECTS, true)) {
    return sortSubjects(getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []));
  }

  const syncedFromServer = await syncCoreFromServer(force);
  const afterServer = sortSubjects(getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []));
  if (syncedFromServer && afterServer.length > 0) {
    return afterServer;
  }

  return runDeduplicated(`subjects:${force ? 'force' : 'ttl'}`, async () => {
    if (!force && isCacheFresh('SUBJECTS', STORAGE_KEYS.SUBJECTS, true)) {
      return sortSubjects(getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []));
    }
    try {
      if (!force) {
        const cachedSubs = await fetchAllPagesWithLimit20<Subject>(
          'subjects',
          [],
          (d) => ({ id: d.id, ...(d.data() as Omit<Subject, 'id'>) }),
          false
        ).catch(() => []);
        if (cachedSubs.length > 0) {
          const sorted = sortSubjects(cachedSubs);
          setLocal(STORAGE_KEYS.SUBJECTS, sorted);
          setSyncTimestamp('SUBJECTS');
          window.dispatchEvent(new CustomEvent('mpq-subjects-changed', { detail: sorted }));
          return sorted;
        }
      }

      if (isQuotaCooldownActive(force) || !auth.currentUser) {
        return sortSubjects(getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []));
      }

      const subs = await fetchAllPagesWithLimit20<Subject>(
        'subjects',
        [],
        (d) => ({ id: d.id, ...(d.data() as Omit<Subject, 'id'>) }),
        force
      );
      const sorted = sortSubjects(subs);
      setLocal(STORAGE_KEYS.SUBJECTS, sorted);
      setSyncTimestamp('SUBJECTS');
      if (sorted.length > 0) {
        syncMutationToServerCache('subjects', sorted);
      }
      window.dispatchEvent(new CustomEvent('mpq-subjects-changed', { detail: sorted }));
      return sorted;
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
    if (!auth.currentUser || isQuotaCooldownActive(force)) {
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
  if (!synced) {
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

  try {
    await setDoc(doc(db, 'questions', id), newQuestion);
    syncMutationToServerCache('questions', next);
    adjustGlobalStat('questionsCount', 1);
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'questions');
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
    syncMutationToServerCache('questions', next);
    adjustGlobalStat('questionsCount', created.length);
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'questions');
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

  try {
    await updateDoc(doc(db, 'questions', id), cleanUpdates);
    syncMutationToServerCache('questions', next);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `questions/${id}`);
  }
}

export async function deleteQuestion(id: string) {
  const cached = getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []);
  const next = cached.filter((q) => q.id !== id);
  setLocal(STORAGE_KEYS.QUESTIONS, next);
  setSyncTimestamp('QUESTIONS');
  window.dispatchEvent(new CustomEvent('mpq-questions-changed', { detail: next }));

  try {
    await deleteDoc(doc(db, 'questions', id));
    syncMutationToServerCache('questions', next);
    adjustGlobalStat('questionsCount', -1);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `questions/${id}`);
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

  try {
    await setDoc(doc(db, 'subjects', id), newSub);
    syncMutationToServerCache('subjects', next);
    adjustGlobalStat('subjectsCount', 1);
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'subjects');
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

  try {
    await updateDoc(doc(db, 'subjects', id), cleanUpdates);
    syncMutationToServerCache('subjects', next);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `subjects/${id}`);
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
    syncMutationToServerCache('subjects', normalized);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, 'subjects');
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

  try {
    await deleteDoc(doc(db, 'subjects', id));
    syncMutationToServerCache('subjects', next);
    adjustGlobalStat('subjectsCount', -1);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `subjects/${id}`);
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

export async function updatePresenceHeartbeat(username: string, role: 'user' | 'admin') {
  const safeId = `user-${encodeURIComponent(username).replace(/%/g, '_')}`;
  const lastPing = getLocal<{ id: string; at: number } | null>(STORAGE_KEYS.LAST_PRESENCE_PING, null);
  const nowMs = Date.now();

  if (lastPing && lastPing.id === safeId && nowMs - lastPing.at < 270000) {
    return;
  }

  setLocal(STORAGE_KEYS.LAST_PRESENCE_PING, { id: safeId, at: nowMs });
  if (!auth.currentUser) return;

  const record: PresenceRecord = sanitizeData({
    id: safeId,
    username,
    role,
    lastSeen: new Date(nowMs).toISOString(),
    uid: auth.currentUser.uid,
  });
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

  try {
    await setDoc(doc(db, 'notifications', id), item);
    syncMutationToServerCache('notifications', next);
    adjustGlobalStat('notificationsCount', 1);
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'notifications');
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

  try {
    await deleteDoc(doc(db, 'notifications', id));
    syncMutationToServerCache('notifications', next);
    adjustGlobalStat('notificationsCount', -1);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `notifications/${id}`);
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

  try {
    const CHUNK_SIZE = 450;
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const batch = writeBatch(db);
      for (const id of ids.slice(i, i + CHUNK_SIZE)) {
        batch.delete(doc(db, 'notifications', id));
      }
      await batch.commit();
    }
    syncMutationToServerCache('notifications', []);
    adjustGlobalStat('notificationsCount', -ids.length);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, 'notifications');
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

  if (!force && isCacheFresh('BOT_COMMANDS', STORAGE_KEYS.BOT_COMMANDS)) {
    return getLocal<Record<string, BotCommandConfig>>(STORAGE_KEYS.BOT_COMMANDS, {});
  }

  const syncedFromServer = await syncCoreFromServer(force);
  if (syncedFromServer && hasCachedValue(STORAGE_KEYS.BOT_COMMANDS)) {
    return getLocal<Record<string, BotCommandConfig>>(STORAGE_KEYS.BOT_COMMANDS, {});
  }

  return runDeduplicated(`bot_commands:${force ? 'force' : 'ttl'}`, async () => {
    if (!force && isCacheFresh('BOT_COMMANDS', STORAGE_KEYS.BOT_COMMANDS)) {
      return getLocal<Record<string, BotCommandConfig>>(STORAGE_KEYS.BOT_COMMANDS, {});
    }
    try {
      if (!force) {
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
          setSyncTimestamp('BOT_COMMANDS');
          window.dispatchEvent(new CustomEvent('mpq-bot-commands-changed', { detail: cachedMap }));
          return cachedMap;
        }
      }

      if (isQuotaCooldownActive(force) || !auth.currentUser) {
        return getLocal<Record<string, BotCommandConfig>>(STORAGE_KEYS.BOT_COMMANDS, {});
      }

      const list = await fetchAllPagesWithLimit20<BotCommandConfig>(
        'bot_commands',
        [],
        (d) => d.data() as BotCommandConfig,
        force
      );
      const map: Record<string, BotCommandConfig> = {};
      for (const item of list) {
        if (item?.command) {
          map[item.command] = item;
        }
      }
      setLocal(STORAGE_KEYS.BOT_COMMANDS, map);
      setSyncTimestamp('BOT_COMMANDS');
      window.dispatchEvent(new CustomEvent('mpq-bot-commands-changed', { detail: map }));
      return map;
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

  try {
    await setDoc(doc(db, 'bot_commands', docId), payload);
    syncMutationToServerCache('bot_commands', next);
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `bot_commands/${docId}`);
    throw err;
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

  try {
    await deleteDoc(doc(db, 'bot_commands', docId));
    syncMutationToServerCache('bot_commands', next);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `bot_commands/${docId}`);
  }

  await syncTelegramBotTemplates(next);
}

export async function resetAllBotCommands(commands: string[]) {
  setLocal(STORAGE_KEYS.BOT_COMMANDS, {});
  setSyncTimestamp('BOT_COMMANDS');
  window.dispatchEvent(new CustomEvent('mpq-bot-commands-changed', { detail: {} }));

  try {
    const CHUNK_SIZE = 450;
    for (let i = 0; i < commands.length; i += CHUNK_SIZE) {
      const batch = writeBatch(db);
      for (const cmd of commands.slice(i, i + CHUNK_SIZE)) {
        batch.delete(doc(db, 'bot_commands', getBotCommandDocId(cmd)));
      }
      await batch.commit();
    }
    syncMutationToServerCache('bot_commands', {});
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, 'bot_commands');
  }

  await syncTelegramBotTemplates({});
}
