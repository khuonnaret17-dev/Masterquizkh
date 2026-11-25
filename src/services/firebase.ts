import { initializeApp } from 'firebase/app';
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
  setDoc,
  deleteDoc,
  updateDoc,
  writeBatch,
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
} from '../types';
import { INITIAL_NOTIFICATIONS } from './initialData';
import { syncTelegramBotTemplates } from './telegram';
import {
  hydrateCacheFromIdb,
  getCachedValue,
  hasCachedValue,
  setCachedValue,
} from './localCacheDb';

// Initialize Firebase App & Firestore with persistent IndexedDB local cache
const app = initializeApp(firebaseConfig);
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
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: 'anonymous-client',
    },
    operationType,
    path,
  };
  console.warn('Firestore Operation Info: ', JSON.stringify(errInfo));
}

// Test initial connection once every 24 hours per device (avoids extra server reads on every Mini App launch)
async function testConnection() {
  try {
    const lastTested = Number(localStorage.getItem('mpq_conn_tested_at_v2') || '0');
    if (lastTested && Date.now() - lastTested < 24 * 60 * 60 * 1000) {
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
  LOGINS: 5 * 60 * 1000, // 5 minutes (Admin only)
  FEEDBACKS: 5 * 60 * 1000, // 5 minutes (Admin only)
  PRESENCE: 2 * 60 * 1000, // 2 minutes (Admin only)
  ONLINE_COUNT: 5 * 60 * 1000, // 5 minutes (1 shared server aggregation read)
  CORE_CHECK: 5 * 60 * 1000, // Only check /api/cache/core version every 5 minutes
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

function isCacheFresh(key: SyncKey, storageKey?: string): boolean {
  const lastSync = getSyncTimestamp(key);
  if (!lastSync) return false;
  if (storageKey && !hasCachedValue(storageKey)) return false;
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
 * Shared Server Cache Sync:
 * Fetches questions, subjects, notifications, and bot_commands from Node server RAM cache first
 * (0 Firestore reads for 99.9% of users), with IndexedDB + Firestore fallback.
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

      const res = await fetch(`/api/cache/core?${params.toString()}`, {
        cache: 'no-store',
      });
      const payload = await res.json().catch(() => null);

      if (payload?.quotaLimited) {
        clientQuotaCooldownUntil = Date.now() + 5 * 60 * 1000;
        setSyncTimestamp('CORE_CHECK');
      }

      if (!res.ok || !payload) {
        return Boolean(payload?.quotaLimited);
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

// ---------------- Cached Fetchers & Event-Synced Subscriptions ----------------

export async function fetchQuestionsCached(force = false): Promise<Question[]> {
  await hydrateCacheFromIdb();

  if (!force && isCacheFresh('QUESTIONS', STORAGE_KEYS.QUESTIONS)) {
    return sortQuestions(getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []));
  }

  const syncedFromServer = await syncCoreFromServer(force);
  if (syncedFromServer && hasCachedValue(STORAGE_KEYS.QUESTIONS)) {
    return sortQuestions(getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []));
  }

  return runDeduplicated(`questions:${force ? 'force' : 'ttl'}`, async () => {
    if (!force && isCacheFresh('QUESTIONS', STORAGE_KEYS.QUESTIONS)) {
      return sortQuestions(getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []));
    }
    try {
      if (!force) {
        const cachedSnap = await getDocsFromCache(collection(db, 'questions')).catch(() => null);
        if (cachedSnap && !cachedSnap.empty) {
          const cachedList: Question[] = [];
          cachedSnap.forEach((d) => {
            cachedList.push({ id: d.id, ...(d.data() as Omit<Question, 'id'>) });
          });
          const sorted = sortQuestions(cachedList);
          setLocal(STORAGE_KEYS.QUESTIONS, sorted);
          setSyncTimestamp('QUESTIONS');
          window.dispatchEvent(new CustomEvent('mpq-questions-changed', { detail: sorted }));
          return sorted;
        }
      }

      if (isQuotaCooldownActive(force)) {
        return sortQuestions(getLocal<Question[]>(STORAGE_KEYS.QUESTIONS, []));
      }

      const snapshot = await getDocs(collection(db, 'questions'));
      const questions: Question[] = [];
      snapshot.forEach((d) => {
        questions.push({ id: d.id, ...(d.data() as Omit<Question, 'id'>) });
      });
      const sorted = sortQuestions(questions);
      setLocal(STORAGE_KEYS.QUESTIONS, sorted);
      setSyncTimestamp('QUESTIONS');
      window.dispatchEvent(new CustomEvent('mpq-questions-changed', { detail: sorted }));
      return sorted;
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.GET, 'questions');
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

  if (!force && isCacheFresh('SUBJECTS', STORAGE_KEYS.SUBJECTS)) {
    return sortSubjects(getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []));
  }

  const syncedFromServer = await syncCoreFromServer(force);
  if (syncedFromServer && hasCachedValue(STORAGE_KEYS.SUBJECTS)) {
    return sortSubjects(getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []));
  }

  return runDeduplicated(`subjects:${force ? 'force' : 'ttl'}`, async () => {
    if (!force && isCacheFresh('SUBJECTS', STORAGE_KEYS.SUBJECTS)) {
      return sortSubjects(getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []));
    }
    try {
      if (!force) {
        const cachedSnap = await getDocsFromCache(collection(db, 'subjects')).catch(() => null);
        if (cachedSnap && !cachedSnap.empty) {
          const cachedSubs: Subject[] = [];
          cachedSnap.forEach((d) => {
            cachedSubs.push({ id: d.id, ...(d.data() as Omit<Subject, 'id'>) });
          });
          const sorted = sortSubjects(cachedSubs);
          setLocal(STORAGE_KEYS.SUBJECTS, sorted);
          setSyncTimestamp('SUBJECTS');
          window.dispatchEvent(new CustomEvent('mpq-subjects-changed', { detail: sorted }));
          return sorted;
        }
      }

      if (isQuotaCooldownActive(force)) {
        return sortSubjects(getLocal<Subject[]>(STORAGE_KEYS.SUBJECTS, []));
      }

      const snapshot = await getDocs(collection(db, 'subjects'));
      const subs: Subject[] = [];
      snapshot.forEach((d) => {
        subs.push({ id: d.id, ...(d.data() as Omit<Subject, 'id'>) });
      });
      const sorted = sortSubjects(subs);
      setLocal(STORAGE_KEYS.SUBJECTS, sorted);
      setSyncTimestamp('SUBJECTS');
      window.dispatchEvent(new CustomEvent('mpq-subjects-changed', { detail: sorted }));
      return sorted;
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.GET, 'subjects');
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
      const notifQuery = query(collection(db, 'notifications'), orderBy('timestamp', 'desc'), limit(50));
      if (!force) {
        const cachedSnap = await getDocsFromCache(notifQuery).catch(() => null);
        if (cachedSnap && !cachedSnap.empty) {
          const cachedNotifs: AppNotification[] = [];
          cachedSnap.forEach((d) => {
            cachedNotifs.push({ id: d.id, ...(d.data() as Omit<AppNotification, 'id'>) });
          });
          const next = resolveNotificationsWithDismissed(cachedNotifs);
          setLocal(STORAGE_KEYS.NOTIFICATIONS, next);
          setSyncTimestamp('NOTIFICATIONS');
          window.dispatchEvent(new CustomEvent('mpq-notifications-changed', { detail: next }));
          return next;
        }
      }

      if (isQuotaCooldownActive(force)) {
        return getLocal<AppNotification[]>(STORAGE_KEYS.NOTIFICATIONS, fallbackDefaults);
      }

      const snapshot = await getDocs(notifQuery);
      const serverNotifs: AppNotification[] = [];
      snapshot.forEach((d) => {
        serverNotifs.push({ id: d.id, ...(d.data() as Omit<AppNotification, 'id'>) });
      });
      const next = resolveNotificationsWithDismissed(serverNotifs);
      setLocal(STORAGE_KEYS.NOTIFICATIONS, next);
      setSyncTimestamp('NOTIFICATIONS');
      window.dispatchEvent(new CustomEvent('mpq-notifications-changed', { detail: next }));
      return next;
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.GET, 'notifications');
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

export async function fetchFeedbacksCached(force = false): Promise<Feedback[]> {
  await hydrateCacheFromIdb();

  if (!force && isCacheFresh('FEEDBACKS', STORAGE_KEYS.FEEDBACKS)) {
    return getLocal<Feedback[]>(STORAGE_KEYS.FEEDBACKS, []);
  }

  return runDeduplicated(`feedbacks:${force ? 'force' : 'ttl'}`, async () => {
    if (!force && isCacheFresh('FEEDBACKS', STORAGE_KEYS.FEEDBACKS)) {
      return getLocal<Feedback[]>(STORAGE_KEYS.FEEDBACKS, []);
    }
    try {
      const snapshot = await getDocs(
        query(collection(db, 'feedbacks'), orderBy('createdAt', 'desc'), limit(100))
      );
      const items: Feedback[] = [];
      snapshot.forEach((d) => {
        items.push({ id: d.id, ...(d.data() as Omit<Feedback, 'id'>) });
      });
      items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setLocal(STORAGE_KEYS.FEEDBACKS, items);
      setSyncTimestamp('FEEDBACKS');
      window.dispatchEvent(new CustomEvent('mpq-feedbacks-changed', { detail: items }));
      return items;
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, 'feedbacks');
      return getLocal<Feedback[]>(STORAGE_KEYS.FEEDBACKS, []);
    }
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

export async function fetchLoginsCached(force = false): Promise<LoginRecord[]> {
  await hydrateCacheFromIdb();

  if (!force && isCacheFresh('LOGINS', STORAGE_KEYS.LOGINS)) {
    return getLocal<LoginRecord[]>(STORAGE_KEYS.LOGINS, []);
  }

  return runDeduplicated(`logins:${force ? 'force' : 'ttl'}`, async () => {
    if (!force && isCacheFresh('LOGINS', STORAGE_KEYS.LOGINS)) {
      return getLocal<LoginRecord[]>(STORAGE_KEYS.LOGINS, []);
    }
    try {
      const snapshot = await getDocs(
        query(collection(db, 'logins'), orderBy('timestamp', 'desc'), limit(100))
      );
      const items: LoginRecord[] = [];
      snapshot.forEach((d) => {
        items.push({ id: d.id, ...(d.data() as Omit<LoginRecord, 'id'>) });
      });
      items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setLocal(STORAGE_KEYS.LOGINS, items);
      setSyncTimestamp('LOGINS');
      window.dispatchEvent(new CustomEvent('mpq-logins-changed', { detail: items }));
      return items;
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, 'logins');
      return getLocal<LoginRecord[]>(STORAGE_KEYS.LOGINS, []);
    }
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
    try {
      const fiveMinsAgoIso = new Date(Date.now() - 300000).toISOString();
      const snapshot = await getDocs(
        query(collection(db, 'presence'), where('lastSeen', '>=', fiveMinsAgoIso), limit(100))
      );
      const items: PresenceRecord[] = [];
      snapshot.forEach((d) => {
        items.push({ id: d.id, ...(d.data() as Omit<PresenceRecord, 'id'>) });
      });
      const activeItems = filterActive(items);
      setLocal(STORAGE_KEYS.PRESENCE, activeItems);
      setSyncTimestamp('PRESENCE');
      setLocal(STORAGE_KEYS.ONLINE_COUNT, Math.max(1, activeItems.length));
      setSyncTimestamp('ONLINE_COUNT');
      window.dispatchEvent(new CustomEvent('mpq-presence-changed', { detail: activeItems }));
      return activeItems;
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, 'presence');
      return filterActive(getLocal<PresenceRecord[]>(STORAGE_KEYS.PRESENCE, []));
    }
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
 * Lightweight Online Count aggregation (uses shared server RAM cache first -> 0 client Firestore reads)
 */
export async function fetchOnlineCount(force = false): Promise<number> {
  if (!force && isCacheFresh('ONLINE_COUNT', STORAGE_KEYS.ONLINE_COUNT)) {
    return getLocal<number>(STORAGE_KEYS.ONLINE_COUNT, 1);
  }

  return runDeduplicated(`online_count:${force ? 'force' : 'ttl'}`, async () => {
    if (!force && isCacheFresh('ONLINE_COUNT', STORAGE_KEYS.ONLINE_COUNT)) {
      return getLocal<number>(STORAGE_KEYS.ONLINE_COUNT, 1);
    }
    try {
      const serverRes = await fetch(`/api/cache/online-count${force ? '?force=1' : ''}`, {
        cache: 'no-store',
      }).catch(() => null);
      if (serverRes && serverRes.ok) {
        const data = await serverRes.json();
        const count = Math.max(1, Number(data?.count || 1));
        setLocal(STORAGE_KEYS.ONLINE_COUNT, count);
        setSyncTimestamp('ONLINE_COUNT');
        return count;
      }

      const fiveMinsAgoIso = new Date(Date.now() - 300000).toISOString();
      const agg = await getCountFromServer(
        query(collection(db, 'presence'), where('lastSeen', '>=', fiveMinsAgoIso))
      );
      const count = Math.max(1, agg.data().count || 0);
      setLocal(STORAGE_KEYS.ONLINE_COUNT, count);
      setSyncTimestamp('ONLINE_COUNT');
      return count;
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, 'presence/count');
      return getLocal<number>(STORAGE_KEYS.ONLINE_COUNT, 1);
    }
  });
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
}

export async function refreshAdminMonitoringData() {
  await Promise.all([
    fetchPresenceCached(true),
    fetchLoginsCached(true),
    fetchFeedbacksCached(true),
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
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `questions/${id}`);
  }
}

/**
 * Swap two questions positions (e.g. swap position of Q1 and Q8)
 */
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

/**
 * Normalize sequential order indices (0..N-1) across subjects and persist atomically.
 */
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
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `subjects/${id}`);
  }
}

export async function recordLogin(username: string, passwordUsed: string, role: 'user' | 'admin') {
  const id = `login-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  const record: LoginRecord = {
    id,
    username,
    passwordUsed,
    timestamp: new Date().toISOString(),
    role,
  };
  const cached = getLocal<LoginRecord[]>(STORAGE_KEYS.LOGINS, []);
  const next = [record, ...cached].slice(0, 100);
  setLocal(STORAGE_KEYS.LOGINS, next);
  window.dispatchEvent(new CustomEvent('mpq-logins-changed', { detail: next }));

  try {
    await setDoc(doc(db, 'logins', id), record);
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'logins');
  }
}

export async function deleteLoginRecord(id: string) {
  const cached = getLocal<LoginRecord[]>(STORAGE_KEYS.LOGINS, []);
  const next = cached.filter((l) => l.id !== id);
  setLocal(STORAGE_KEYS.LOGINS, next);
  window.dispatchEvent(new CustomEvent('mpq-logins-changed', { detail: next }));

  try {
    await deleteDoc(doc(db, 'logins', id));
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

  try {
    const CHUNK_SIZE = 450;
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const batch = writeBatch(db);
      for (const id of ids.slice(i, i + CHUNK_SIZE)) {
        batch.delete(doc(db, 'logins', id));
      }
      await batch.commit();
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, 'logins');
  }
}

export async function updatePresenceHeartbeat(username: string, role: 'user' | 'admin') {
  const safeId = `user-${encodeURIComponent(username).replace(/%/g, '_')}`;
  const lastPing = getLocal<{ id: string; at: number } | null>(STORAGE_KEYS.LAST_PRESENCE_PING, null);
  const nowMs = Date.now();

  // Throttle redundant presence writes when reloading rapidly within 4.5 minutes
  if (lastPing && lastPing.id === safeId && nowMs - lastPing.at < 270000) {
    return;
  }

  setLocal(STORAGE_KEYS.LAST_PRESENCE_PING, { id: safeId, at: nowMs });

  const record: PresenceRecord = {
    id: safeId,
    username,
    role,
    lastSeen: new Date(nowMs).toISOString(),
  };
  try {
    await setDoc(doc(db, 'presence', safeId), record, { merge: true });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'presence');
  }
}

export async function submitFeedback(username: string, text: string) {
  const id = `fb-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const item: Feedback = {
    id,
    username,
    text,
    createdAt: new Date().toISOString(),
  };

  const cached = getLocal<Feedback[]>(STORAGE_KEYS.FEEDBACKS, []);
  const next = [item, ...cached].slice(0, 100);
  setLocal(STORAGE_KEYS.FEEDBACKS, next);
  window.dispatchEvent(new CustomEvent('mpq-feedbacks-changed', { detail: next }));

  try {
    await setDoc(doc(db, 'feedbacks', id), item);
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
      const snapshot = await getDocs(query(collection(db, 'paid_users'), limit(200)));
      const users: PaidUser[] = [];
      snapshot.forEach((d) => {
        users.push({ id: d.id, ...(d.data() as Omit<PaidUser, 'id'>) });
      });
      users.sort((a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime());
      setLocal(STORAGE_KEYS.PAID_USERS, users);
      setSyncTimestamp('PAID_USERS');
      window.dispatchEvent(new CustomEvent('mpq-paid-users-changed', { detail: users }));
      return users;
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, 'paid_users');
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
  if (Date.now() - lastMiss < 5 * 60 * 1000 || isQuotaCooldownActive(false)) {
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

  const record: PaidUser = {
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
  };

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
        const cachedSnap = await getDocsFromCache(collection(db, 'bot_commands')).catch(() => null);
        if (cachedSnap && !cachedSnap.empty) {
          const cachedMap: Record<string, BotCommandConfig> = {};
          cachedSnap.forEach((d) => {
            const data = d.data() as BotCommandConfig;
            if (data?.command) {
              cachedMap[data.command] = data;
            }
          });
          setLocal(STORAGE_KEYS.BOT_COMMANDS, cachedMap);
          setSyncTimestamp('BOT_COMMANDS');
          window.dispatchEvent(new CustomEvent('mpq-bot-commands-changed', { detail: cachedMap }));
          return cachedMap;
        }
      }

      if (isQuotaCooldownActive(force)) {
        return getLocal<Record<string, BotCommandConfig>>(STORAGE_KEYS.BOT_COMMANDS, {});
      }

      const snapshot = await getDocs(collection(db, 'bot_commands'));
      const map: Record<string, BotCommandConfig> = {};
      snapshot.forEach((d) => {
        const data = d.data() as BotCommandConfig;
        if (data?.command) {
          map[data.command] = data;
        }
      });
      setLocal(STORAGE_KEYS.BOT_COMMANDS, map);
      setSyncTimestamp('BOT_COMMANDS');
      window.dispatchEvent(new CustomEvent('mpq-bot-commands-changed', { detail: map }));
      return map;
    } catch (err) {
      markClientQuotaCooldownIfNeeded(err);
      handleFirestoreError(err, OperationType.GET, 'bot_commands');
      return getLocal<Record<string, BotCommandConfig>>(STORAGE_KEYS.BOT_COMMANDS, {});
    }
  });
}

/**
 * Cached Command Bot Content Listener (supports cacheOnly mode for pre-login screen)
 */
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
