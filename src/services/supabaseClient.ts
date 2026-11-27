import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';

export interface RealtimeConfigResponse {
  success: boolean;
  mode: 'dual' | 'supabase' | 'firestore';
  backend: 'supabase' | 'firestore';
  supabase: {
    configured: boolean;
    url: string;
    publishableKey: string;
  };
  firestoreConfigured: boolean;
  sseEndpoint: string;
}

export interface ClientRealtimeDeltaEvent {
  scope:
    | 'questions'
    | 'subjects'
    | 'notifications'
    | 'bot_commands'
    | 'feedbacks'
    | 'logins'
    | 'presence'
    | 'paid_users'
    | 'global_stats'
    | 'db_mode'
    | 'core';
  action: 'upsert' | 'upsertMany' | 'delete' | 'deleteMany' | 'clear' | 'replace' | 'refresh';
  id?: string;
  ids?: string[];
  item?: any;
  items?: any[];
  replace?: any;
  mode?: 'dual' | 'supabase' | 'firestore';
  version?: number;
  source?: 'server' | 'supabase' | 'firestore';
  ts?: number;
}

const SUPABASE_REALTIME_CHANNEL = 'master-quiz-kh-live';

let cachedConfig: RealtimeConfigResponse | null = null;
let configPromise: Promise<RealtimeConfigResponse | null> | null = null;
let browserSupabase: SupabaseClient | null = null;
let browserSupabaseUrl = '';
let activeRealtimeChannel: RealtimeChannel | null = null;
let activeChannelSubscribed = false;

export async function fetchRealtimeConfig(force = false): Promise<RealtimeConfigResponse | null> {
  if (!force && cachedConfig) return cachedConfig;
  if (!force && configPromise) return configPromise;

  configPromise = fetch('/api/db/realtime-config', { cache: 'no-store' })
    .then(async (res) => {
      if (!res.ok) return null;
      const data = (await res.json().catch(() => null)) as RealtimeConfigResponse | null;
      if (data?.success) {
        cachedConfig = data;
        return data;
      }
      return null;
    })
    .catch(() => null)
    .finally(() => {
      configPromise = null;
    });

  return configPromise;
}

export async function getBrowserSupabaseClient(): Promise<SupabaseClient | null> {
  const cfg = await fetchRealtimeConfig(false);
  const url = cfg?.supabase?.url?.trim() || '';
  const key = cfg?.supabase?.publishableKey?.trim() || '';
  if (!cfg?.supabase?.configured || !url || !key) return null;

  if (browserSupabase && browserSupabaseUrl === url) {
    return browserSupabase;
  }

  browserSupabaseUrl = url;
  browserSupabase = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      params: {
        eventsPerSecond: 10,
      },
    },
  });
  return browserSupabase;
}

function mapSupabaseRowToApp(table: string, row: any): any {
  if (!row || typeof row !== 'object') return row;
  switch (table) {
    case 'questions':
      return {
        id: row.id,
        subject: row.subject ?? '',
        type: row.type ?? 'mcq',
        question: row.question ?? '',
        options: Array.isArray(row.options) ? row.options : undefined,
        correct: typeof row.correct === 'number' ? row.correct : undefined,
        answer: row.answer ?? undefined,
        explanation: row.explanation ?? undefined,
        isActive: row.is_active !== false,
        order: typeof row.order_index === 'number' ? row.order_index : 0,
      };
    case 'subjects':
      return {
        id: row.id,
        name: row.name ?? '',
        type: row.type ?? 'mcq',
        isActive: row.is_active !== false,
        order: typeof row.order_index === 'number' ? row.order_index : 0,
      };
    case 'notifications':
      return {
        id: row.id,
        message: row.message ?? '',
        timestamp: row.timestamp || new Date().toISOString(),
        type: row.type || 'info',
      };
    case 'bot_commands':
      return {
        command: row.command,
        titleKh: row.title_kh || '',
        descriptionKh: row.description_kh || '',
        title: row.title || '',
        body: row.body || '',
        imageUrl: row.image_url || undefined,
        imageAlt: row.image_alt || undefined,
        actions: Array.isArray(row.actions) ? row.actions : [],
        updatedAt: row.updated_at || new Date().toISOString(),
      };
    case 'feedbacks':
      return {
        id: row.id,
        username: row.username ?? '',
        text: row.text ?? '',
        createdAt: row.created_at || new Date().toISOString(),
        uid: row.uid || undefined,
      };
    case 'logins':
      return {
        id: row.id,
        username: row.username ?? '',
        passwordUsed: row.password_used ?? '',
        timestamp: row.timestamp || new Date().toISOString(),
        role: row.role === 'admin' ? 'admin' : 'user',
        uid: row.uid || undefined,
      };
    case 'presence':
      return {
        id: row.id,
        username: row.username ?? '',
        role: row.role === 'admin' ? 'admin' : 'user',
        lastSeen: row.last_seen || new Date().toISOString(),
        uid: row.uid || undefined,
      };
    case 'paid_users':
      return {
        id: row.id,
        username: row.username ?? '',
        phoneNumber: row.phone_number || '',
        amount: Number(row.amount ?? 10),
        currency: row.currency || 'USD',
        paidAt: row.paid_at || new Date().toISOString(),
        status: row.status || 'active',
        permanentAccess: row.permanent_access !== false,
        transactionRef: row.transaction_ref || '',
        method: row.method || 'KHQR_BAKONG_ABA',
        note: row.note || '',
        uid: row.uid || undefined,
      };
    case 'global_stats':
      return {
        questionsCount: Number(row.questions_count ?? 0),
        subjectsCount: Number(row.subjects_count ?? 0),
        loginsCount: Number(row.logins_count ?? 0),
        feedbacksCount: Number(row.feedbacks_count ?? 0),
        notificationsCount: Number(row.notifications_count ?? 0),
        updatedAt: row.updated_at || new Date().toISOString(),
      };
    default:
      return row;
  }
}

export function connectSupabaseRealtime(
  onEvent: (event: ClientRealtimeDeltaEvent) => void,
  options?: { includeAdminTables?: boolean }
): () => void {
  let cancelled = false;
  let localChannel: RealtimeChannel | null = null;
  let clientRef: SupabaseClient | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelayMs = 2500;
  let isSubscribed = false;

  const cleanupChannel = () => {
    isSubscribed = false;
    if (localChannel && clientRef) {
      try {
        clientRef.removeChannel(localChannel);
      } catch {
        // Ignore cleanup errors
      }
      if (activeRealtimeChannel === localChannel) {
        activeRealtimeChannel = null;
        activeChannelSubscribed = false;
      }
      localChannel = null;
    }
  };

  const scheduleReconnect = () => {
    if (cancelled || reconnectTimer) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!cancelled) {
        void attachChannel();
      }
    }, delay);
  };

  const attachChannel = async () => {
    if (cancelled) return;
    const sb = clientRef || (await getBrowserSupabaseClient());
    if (cancelled || !sb) return;
    clientRef = sb;

    cleanupChannel();

    const coreTables: ClientRealtimeDeltaEvent['scope'][] = [
      'questions',
      'subjects',
      'notifications',
      'bot_commands',
      'global_stats',
    ];
    const adminTables: ClientRealtimeDeltaEvent['scope'][] = options?.includeAdminTables
      ? ['feedbacks', 'logins', 'presence', 'paid_users']
      : [];
    const tables = [...coreTables, ...adminTables];

    let ch = sb.channel(SUPABASE_REALTIME_CHANNEL, {
      config: {
        broadcast: { self: false },
      },
    });

    for (const tbl of tables) {
      ch = ch.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: tbl },
        (payload: any) => {
          if (cancelled) return;
          const evType = String(payload?.eventType || 'UPDATE').toUpperCase();
          if (evType === 'DELETE') {
            const oldRec = payload?.old ? mapSupabaseRowToApp(tbl, payload.old) : null;
            const id = String(oldRec?.id || oldRec?.command || payload?.old?.id || '');
            if (id) {
              onEvent({
                scope: tbl,
                action: 'delete',
                id,
                source: 'supabase',
                ts: Date.now(),
              });
            }
          } else {
            const rec = payload?.new ? mapSupabaseRowToApp(tbl, payload.new) : null;
            if (rec) {
              onEvent({
                scope: tbl,
                action: tbl === 'global_stats' ? 'replace' : 'upsert',
                id: rec.id || rec.command,
                item: rec,
                replace: tbl === 'global_stats' ? rec : undefined,
                source: 'supabase',
                ts: Date.now(),
              });
            }
          }
        }
      );
    }

    ch = ch.on('broadcast', { event: 'db_sync' }, (msg: any) => {
      if (cancelled) return;
      const payload = msg?.payload as ClientRealtimeDeltaEvent | undefined;
      if (payload?.scope && payload?.action) {
        onEvent({
          ...payload,
          source: payload.source || 'supabase',
        });
      }
    });

    localChannel = ch.subscribe((status) => {
      if (cancelled) return;
      if (status === 'SUBSCRIBED') {
        isSubscribed = true;
        activeChannelSubscribed = true;
        reconnectDelayMs = 2500;
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        isSubscribed = false;
        activeChannelSubscribed = false;
        scheduleReconnect();
      }
    });
    activeRealtimeChannel = localChannel;
  };

  void attachChannel();

  const handleWakeReconnect = () => {
    if (cancelled) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (!isSubscribed) {
      reconnectDelayMs = 2500;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      void attachChannel();
    }
  };

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.addEventListener('online', handleWakeReconnect);
    document.addEventListener('visibilitychange', handleWakeReconnect);
  }

  return () => {
    cancelled = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      window.removeEventListener('online', handleWakeReconnect);
      document.removeEventListener('visibilitychange', handleWakeReconnect);
    }
    cleanupChannel();
  };
}

export async function broadcastClientSupabaseSync(
  event: ClientRealtimeDeltaEvent
): Promise<void> {
  if (!activeRealtimeChannel || !activeChannelSubscribed) return;
  try {
    await activeRealtimeChannel.send({
      type: 'broadcast',
      event: 'db_sync',
      payload: {
        ...event,
        origin: 'client',
        ts: Date.now(),
      },
    });
  } catch {
    // Non-blocking best-effort broadcast
  }
}
