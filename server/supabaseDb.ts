import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cachedClient: SupabaseClient | null = null;
let cachedSignature = '';

function resolveSupabaseUrl(): string {
  return (
    process.env.SUPABASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
    ''
  );
}

function resolveSupabaseServiceKey(): string {
  return (
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SUPABASE_SECRET_KEY?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ||
    process.env.SUPABASE_ANON_KEY?.trim() ||
    ''
  );
}

export function isSupabaseConfigured(): boolean {
  return Boolean(resolveSupabaseUrl() && resolveSupabaseServiceKey());
}

export function getSupabaseAdmin(): SupabaseClient {
  const url = resolveSupabaseUrl();
  const serviceKey = resolveSupabaseServiceKey();
  if (!url || !serviceKey) {
    throw new Error('Supabase environment variables are not configured');
  }
  const sig = `${url}|${serviceKey.slice(0, 12)}`;
  if (!cachedClient || cachedSignature !== sig) {
    cachedClient = createClient(url, serviceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
    cachedSignature = sig;
  }
  return cachedClient;
}

// ---------------- Row Mappers (PostgreSQL snake_case <-> App camelCase) ----------------

function mapSubjectFromRow(row: any) {
  return {
    id: String(row.id),
    name: String(row.name || ''),
    type: row.type as 'mcq' | 'short' | 'explanation',
    isActive: row.is_active !== false,
    order: typeof row.sort_order === 'number' ? row.sort_order : Number(row.sort_order || 0),
  };
}

function mapSubjectToRow(item: any) {
  return {
    id: String(item.id),
    name: String(item.name || '').slice(0, 200),
    type: item.type || 'mcq',
    is_active: item.isActive !== false,
    sort_order: typeof item.order === 'number' ? Math.trunc(item.order) : 0,
  };
}

function mapQuestionFromRow(row: any) {
  const out: any = {
    id: String(row.id),
    subject: String(row.subject || ''),
    question: String(row.question || ''),
    type: row.type as 'mcq' | 'short' | 'explanation',
    isActive: row.is_active !== false,
    order: typeof row.sort_order === 'number' ? row.sort_order : Number(row.sort_order || 0),
  };
  if (Array.isArray(row.options)) out.options = row.options;
  if (typeof row.correct === 'number') out.correct = row.correct;
  if (typeof row.answer === 'string') out.answer = row.answer;
  return out;
}

function mapQuestionToRow(item: any) {
  return {
    id: String(item.id),
    subject: String(item.subject || '').slice(0, 200),
    question: String(item.question || '').slice(0, 4000),
    type: item.type || 'mcq',
    options: Array.isArray(item.options) ? item.options : null,
    correct: typeof item.correct === 'number' ? Math.trunc(item.correct) : null,
    answer: typeof item.answer === 'string' ? item.answer.slice(0, 8000) : null,
    is_active: item.isActive !== false,
    sort_order: typeof item.order === 'number' ? Math.trunc(item.order) : 0,
  };
}

function mapNotificationFromRow(row: any) {
  return {
    id: String(row.id),
    message: String(row.message || ''),
    timestamp: row.timestamp ? new Date(row.timestamp).toISOString() : new Date().toISOString(),
    type: (row.type || 'info') as 'info' | 'success' | 'warning',
  };
}

function mapNotificationToRow(item: any) {
  return {
    id: String(item.id),
    message: String(item.message || '').slice(0, 1000),
    timestamp: item.timestamp ? new Date(item.timestamp).toISOString() : new Date().toISOString(),
    type: item.type || 'info',
  };
}

function mapBotCommandFromRow(row: any) {
  const out: any = {
    command: String(row.command || ''),
    titleKh: String(row.title_kh || ''),
    descriptionKh: String(row.description_kh || ''),
    title: String(row.title || ''),
    body: String(row.body || ''),
    actions: Array.isArray(row.actions) ? row.actions : [],
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
  };
  if (row.image_url) out.imageUrl = String(row.image_url);
  if (row.image_alt) out.imageAlt = String(row.image_alt);
  return out;
}

function getBotCommandRowId(command: string): string {
  return String(command || '').replace(/^\//, '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function mapBotCommandToRow(item: any) {
  return {
    id: item.id ? String(item.id) : getBotCommandRowId(item.command),
    command: String(item.command || '').trim().slice(0, 32),
    title_kh: String(item.titleKh || '').trim().slice(0, 120),
    description_kh: String(item.descriptionKh || '').trim().slice(0, 200),
    title: String(item.title || '').trim().slice(0, 250),
    body: String(item.body || '').slice(0, 4000),
    image_url: item.imageUrl ? String(item.imageUrl).trim().slice(0, 500) : null,
    image_alt: item.imageAlt ? String(item.imageAlt).trim().slice(0, 200) : null,
    actions: Array.isArray(item.actions) ? item.actions : [],
    updated_at: item.updatedAt ? new Date(item.updatedAt).toISOString() : new Date().toISOString(),
  };
}

function mapFeedbackFromRow(row: any) {
  const out: any = {
    id: String(row.id),
    username: String(row.username || ''),
    text: String(row.text || ''),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
  };
  if (row.uid) out.uid = String(row.uid);
  return out;
}

function mapLoginFromRow(row: any) {
  const out: any = {
    id: String(row.id),
    username: String(row.username || ''),
    passwordUsed: row.password_used ? String(row.password_used) : '',
    timestamp: row.timestamp ? new Date(row.timestamp).toISOString() : new Date().toISOString(),
    role: row.role === 'admin' ? 'admin' : 'user',
  };
  if (row.uid) out.uid = String(row.uid);
  return out;
}

function mapPresenceFromRow(row: any) {
  const out: any = {
    id: String(row.id),
    username: String(row.username || ''),
    role: row.role === 'admin' ? 'admin' : 'user',
    lastSeen: row.last_seen ? new Date(row.last_seen).toISOString() : new Date().toISOString(),
  };
  if (row.uid) out.uid = String(row.uid);
  return out;
}

function mapPaidUserFromRow(row: any) {
  const out: any = {
    id: String(row.id),
    username: String(row.username || ''),
    phoneNumber: row.phone_number ? String(row.phone_number) : '',
    amount: Number(row.amount ?? 10),
    currency: String(row.currency || 'USD'),
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : new Date().toISOString(),
    status: (row.status || 'active') as 'active' | 'pending' | 'revoked',
    permanentAccess: Boolean(row.permanent_access),
  };
  if (row.transaction_ref) out.transactionRef = String(row.transaction_ref);
  if (row.method) out.method = String(row.method);
  if (row.note) out.note = String(row.note);
  if (row.uid) out.uid = String(row.uid);
  return out;
}

function mapPaidUserToRow(item: any) {
  return {
    id: String(item.id),
    username: String(item.username || '').slice(0, 120),
    phone_number: item.phoneNumber ? String(item.phoneNumber).slice(0, 64) : '',
    amount: typeof item.amount === 'number' ? item.amount : Number(item.amount ?? 10),
    currency: String(item.currency || 'USD').slice(0, 16),
    paid_at: item.paidAt ? new Date(item.paidAt).toISOString() : new Date().toISOString(),
    status: item.status || 'active',
    permanent_access: Boolean(item.permanentAccess),
    transaction_ref: item.transactionRef ? String(item.transactionRef).slice(0, 120) : null,
    method: item.method ? String(item.method).slice(0, 64) : null,
    note: item.note ? String(item.note).slice(0, 500) : null,
    uid: item.uid ? String(item.uid).slice(0, 128) : null,
  };
}

// ---------------- Generic Paginated Reader (handles > 1000 rows safely) ----------------

async function fetchAllTableRows(
  table: string,
  orderCol: string,
  ascending = true
): Promise<any[]> {
  const sb = getSupabaseAdmin();
  const pageSize = 500;
  const collected: any[] = [];
  let from = 0;

  while (from < 50000) {
    const { data, error } = await sb
      .from(table)
      .select('*')
      .order(orderCol, { ascending })
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(`Supabase read ${table} failed: ${error.message}`);
    }
    const rows = Array.isArray(data) ? data : [];
    collected.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }

  return collected;
}

async function upsertInChunks(table: string, rows: any[], chunkSize = 250) {
  if (rows.length === 0) return;
  const sb = getSupabaseAdmin();
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await sb.from(table).upsert(chunk, { onConflict: 'id' });
    if (error) {
      throw new Error(`Supabase upsert ${table} failed: ${error.message}`);
    }
  }
}

// ---------------- Public Catalog & Core Read Helpers ----------------

export async function sbFetchAllQuestions() {
  const rows = await fetchAllTableRows('questions', 'sort_order', true);
  return rows.map(mapQuestionFromRow);
}

export async function sbFetchAllSubjects() {
  const rows = await fetchAllTableRows('subjects', 'sort_order', true);
  return rows.map(mapSubjectFromRow);
}

export async function sbFetchNotifications(maxItems = 50) {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from('notifications')
    .select('*')
    .order('timestamp', { ascending: false })
    .limit(maxItems);
  if (error) throw new Error(`Supabase read notifications failed: ${error.message}`);
  return (data || []).map(mapNotificationFromRow);
}

export async function sbFetchBotCommandsMap() {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb.from('bot_commands').select('*');
  if (error) throw new Error(`Supabase read bot_commands failed: ${error.message}`);
  const map: Record<string, any> = {};
  for (const row of data || []) {
    const mapped = mapBotCommandFromRow(row);
    if (mapped.command) {
      map[mapped.command] = mapped;
    }
  }
  return map;
}

export async function sbFetchOnlineCount(): Promise<number> {
  const sb = getSupabaseAdmin();
  const fiveMinsAgoIso = new Date(Date.now() - 300000).toISOString();
  const { count, error } = await sb
    .from('presence')
    .select('id', { count: 'exact', head: true })
    .gte('last_seen', fiveMinsAgoIso);
  if (error) throw new Error(`Supabase presence count failed: ${error.message}`);
  return Math.max(1, Number(count || 0));
}

export async function sbFetchGlobalStats() {
  const sb = getSupabaseAdmin();
  const [qRes, sRes, lRes, fRes, nRes] = await Promise.all([
    sb.from('questions').select('id', { count: 'exact', head: true }),
    sb.from('subjects').select('id', { count: 'exact', head: true }),
    sb.from('logins').select('id', { count: 'exact', head: true }),
    sb.from('feedbacks').select('id', { count: 'exact', head: true }),
    sb.from('notifications').select('id', { count: 'exact', head: true }),
  ]);

  return {
    questionsCount: Number(qRes.count || 0),
    subjectsCount: Number(sRes.count || 0),
    loginsCount: Number(lRes.count || 0),
    feedbacksCount: Number(fRes.count || 0),
    notificationsCount: Number(nRes.count || 0),
    updatedAt: new Date().toISOString(),
  };
}

// ---------------- CRUD Mutations ----------------

export async function sbUpsertQuestions(items: any[]) {
  await upsertInChunks('questions', items.map(mapQuestionToRow));
}

export async function sbUpdateQuestion(id: string, updates: any) {
  const sb = getSupabaseAdmin();
  const patch: Record<string, any> = {};
  if (typeof updates.subject === 'string') patch.subject = updates.subject.slice(0, 200);
  if (typeof updates.question === 'string') patch.question = updates.question.slice(0, 4000);
  if (typeof updates.type === 'string') patch.type = updates.type;
  if ('options' in updates) patch.options = Array.isArray(updates.options) ? updates.options : null;
  if ('correct' in updates) patch.correct = typeof updates.correct === 'number' ? Math.trunc(updates.correct) : null;
  if ('answer' in updates) patch.answer = typeof updates.answer === 'string' ? updates.answer.slice(0, 8000) : null;
  if (typeof updates.isActive === 'boolean') patch.is_active = updates.isActive;
  if (typeof updates.order === 'number') patch.sort_order = Math.trunc(updates.order);

  if (Object.keys(patch).length === 0) return;
  const { error } = await sb.from('questions').update(patch).eq('id', id);
  if (error) throw new Error(`Supabase update question failed: ${error.message}`);
}

export async function sbDeleteQuestion(id: string) {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from('questions').delete().eq('id', id);
  if (error) throw new Error(`Supabase delete question failed: ${error.message}`);
}

export async function sbDeleteQuestionsByIds(ids: string[]) {
  if (ids.length === 0) return;
  const sb = getSupabaseAdmin();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { error } = await sb.from('questions').delete().in('id', chunk);
    if (error) throw new Error(`Supabase delete questions batch failed: ${error.message}`);
  }
}

export async function sbUpsertSubjects(items: any[]) {
  await upsertInChunks('subjects', items.map(mapSubjectToRow));
}

export async function sbUpdateSubject(id: string, updates: any) {
  const sb = getSupabaseAdmin();
  const patch: Record<string, any> = {};
  if (typeof updates.name === 'string') patch.name = updates.name.slice(0, 200);
  if (typeof updates.type === 'string') patch.type = updates.type;
  if (typeof updates.isActive === 'boolean') patch.is_active = updates.isActive;
  if (typeof updates.order === 'number') patch.sort_order = Math.trunc(updates.order);

  if (Object.keys(patch).length === 0) return;
  const { error } = await sb.from('subjects').update(patch).eq('id', id);
  if (error) throw new Error(`Supabase update subject failed: ${error.message}`);
}

export async function sbDeleteSubject(id: string) {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from('subjects').delete().eq('id', id);
  if (error) throw new Error(`Supabase delete subject failed: ${error.message}`);
}

export async function sbUpsertNotification(item: any) {
  await upsertInChunks('notifications', [mapNotificationToRow(item)]);
}

export async function sbUpsertNotifications(items: any[]) {
  if (!Array.isArray(items) || items.length === 0) return;
  await upsertInChunks('notifications', items.map(mapNotificationToRow));
}

export async function sbDeleteNotification(id: string) {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from('notifications').delete().eq('id', id);
  if (error) throw new Error(`Supabase delete notification failed: ${error.message}`);
}

export async function sbDeleteNotificationsByIds(ids: string[]) {
  if (ids.length === 0) return;
  const sb = getSupabaseAdmin();
  const { error } = await sb.from('notifications').delete().in('id', ids);
  if (error) throw new Error(`Supabase delete notifications failed: ${error.message}`);
}

export async function sbSaveBotCommand(config: any) {
  await upsertInChunks('bot_commands', [mapBotCommandToRow(config)]);
}

export async function sbUpsertBotCommandsMap(commandsMap: Record<string, any>) {
  const rows = Object.values(commandsMap || {})
    .filter((c: any) => c?.command)
    .map(mapBotCommandToRow);
  await upsertInChunks('bot_commands', rows);
}

export async function sbDeleteBotCommand(command: string) {
  const sb = getSupabaseAdmin();
  const rowId = getBotCommandRowId(command);
  const { error } = await sb.from('bot_commands').delete().eq('id', rowId);
  if (error) throw new Error(`Supabase delete bot_command failed: ${error.message}`);
}

export async function sbDeleteBotCommands(commands: string[]) {
  if (commands.length === 0) return;
  const sb = getSupabaseAdmin();
  const ids = commands.map(getBotCommandRowId);
  const { error } = await sb.from('bot_commands').delete().in('id', ids);
  if (error) throw new Error(`Supabase delete bot_commands failed: ${error.message}`);
}

// ---------------- Monitoring & Paid Users ----------------

export async function sbFetchFeedbacksPage(offset = 0, pageSize = 20) {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from('feedbacks')
    .select('*')
    .order('created_at', { ascending: false })
    .range(offset, offset + pageSize);
  if (error) throw new Error(`Supabase feedbacks failed: ${error.message}`);
  const rows = data || [];
  const hasMore = rows.length > pageSize;
  const items = rows.slice(0, pageSize).map(mapFeedbackFromRow);
  return { items, nextOffset: offset + items.length, hasMore };
}

export async function sbInsertFeedback(item: any) {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from('feedbacks').upsert(
    {
      id: String(item.id),
      username: String(item.username || '').slice(0, 120),
      text: String(item.text || '').slice(0, 2000),
      created_at: item.createdAt ? new Date(item.createdAt).toISOString() : new Date().toISOString(),
      uid: item.uid ? String(item.uid).slice(0, 128) : null,
    },
    { onConflict: 'id' }
  );
  if (error) throw new Error(`Supabase insert feedback failed: ${error.message}`);
}

export async function sbUpsertFeedbacks(items: any[]) {
  if (!Array.isArray(items) || items.length === 0) return;
  const rows = items
    .filter((item) => item?.id && item?.username && item?.text)
    .map((item) => ({
      id: String(item.id),
      username: String(item.username || '').slice(0, 120),
      text: String(item.text || '').slice(0, 2000),
      created_at: item.createdAt ? new Date(item.createdAt).toISOString() : new Date().toISOString(),
      uid: item.uid ? String(item.uid).slice(0, 128) : null,
    }));
  await upsertInChunks('feedbacks', rows);
}

export async function sbFetchLoginsPage(offset = 0, pageSize = 20) {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from('logins')
    .select('*')
    .order('timestamp', { ascending: false })
    .range(offset, offset + pageSize);
  if (error) throw new Error(`Supabase logins failed: ${error.message}`);
  const rows = data || [];
  const hasMore = rows.length > pageSize;
  const items = rows.slice(0, pageSize).map(mapLoginFromRow);
  return { items, nextOffset: offset + items.length, hasMore };
}

export async function sbInsertLogin(item: any) {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from('logins').upsert(
    {
      id: String(item.id),
      username: String(item.username || '').slice(0, 120),
      password_used: item.passwordUsed ? String(item.passwordUsed).slice(0, 64) : '',
      timestamp: item.timestamp ? new Date(item.timestamp).toISOString() : new Date().toISOString(),
      role: item.role === 'admin' ? 'admin' : 'user',
      uid: item.uid ? String(item.uid).slice(0, 128) : null,
    },
    { onConflict: 'id' }
  );
  if (error) throw new Error(`Supabase insert login failed: ${error.message}`);
}

export async function sbUpsertLogins(items: any[]) {
  if (!Array.isArray(items) || items.length === 0) return;
  const rows = items
    .filter((item) => item?.id && item?.username)
    .map((item) => ({
      id: String(item.id),
      username: String(item.username || '').slice(0, 120),
      password_used: item.passwordUsed ? String(item.passwordUsed).slice(0, 64) : '',
      timestamp: item.timestamp ? new Date(item.timestamp).toISOString() : new Date().toISOString(),
      role: item.role === 'admin' ? 'admin' : 'user',
      uid: item.uid ? String(item.uid).slice(0, 128) : null,
    }));
  await upsertInChunks('logins', rows);
}

export async function sbDeleteLogin(id: string) {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from('logins').delete().eq('id', id);
  if (error) throw new Error(`Supabase delete login failed: ${error.message}`);
}

export async function sbDeleteLoginsByIds(ids: string[]) {
  if (ids.length === 0) return;
  const sb = getSupabaseAdmin();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { error } = await sb.from('logins').delete().in('id', chunk);
    if (error) throw new Error(`Supabase delete logins batch failed: ${error.message}`);
  }
}

export async function sbFetchPresencePage(offset = 0, pageSize = 20) {
  const sb = getSupabaseAdmin();
  const fiveMinsAgoIso = new Date(Date.now() - 300000).toISOString();
  const { data, error } = await sb
    .from('presence')
    .select('*')
    .gte('last_seen', fiveMinsAgoIso)
    .order('last_seen', { ascending: false })
    .range(offset, offset + pageSize);
  if (error) throw new Error(`Supabase presence failed: ${error.message}`);
  const rows = data || [];
  const hasMore = rows.length > pageSize;
  const items = rows.slice(0, pageSize).map(mapPresenceFromRow);
  return { items, nextOffset: offset + items.length, hasMore };
}

export async function sbUpsertPresence(item: any) {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from('presence').upsert(
    {
      id: String(item.id),
      username: String(item.username || '').slice(0, 120),
      role: item.role === 'admin' ? 'admin' : 'user',
      last_seen: item.lastSeen ? new Date(item.lastSeen).toISOString() : new Date().toISOString(),
      uid: item.uid ? String(item.uid).slice(0, 128) : null,
    },
    { onConflict: 'id' }
  );
  if (error) throw new Error(`Supabase upsert presence failed: ${error.message}`);
}

export async function sbUpsertPresenceBatch(items: any[]) {
  if (!Array.isArray(items) || items.length === 0) return;
  const rows = items
    .filter((item) => item?.id && item?.username)
    .map((item) => ({
      id: String(item.id),
      username: String(item.username || '').slice(0, 120),
      role: item.role === 'admin' ? 'admin' : 'user',
      last_seen: item.lastSeen ? new Date(item.lastSeen).toISOString() : new Date().toISOString(),
      uid: item.uid ? String(item.uid).slice(0, 128) : null,
    }));
  await upsertInChunks('presence', rows);
}

export async function sbFetchPaidUsersPage(offset = 0, pageSize = 100) {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from('paid_users')
    .select('*')
    .order('paid_at', { ascending: false })
    .range(offset, offset + pageSize - 1);
  if (error) throw new Error(`Supabase paid_users failed: ${error.message}`);
  return (data || []).map(mapPaidUserFromRow);
}

export async function sbCheckIsUserPaid(rawUsername: string) {
  const norm = rawUsername.trim().toLowerCase();
  if (!norm) return null;
  const sb = getSupabaseAdmin();
  const docId = `user-${encodeURIComponent(norm)}`;

  const { data: byId } = await sb
    .from('paid_users')
    .select('*')
    .eq('id', docId)
    .eq('status', 'active')
    .eq('permanent_access', true)
    .maybeSingle();

  if (byId) return mapPaidUserFromRow(byId);

  const { data: byName } = await sb
    .from('paid_users')
    .select('*')
    .ilike('username', norm)
    .eq('status', 'active')
    .eq('permanent_access', true)
    .limit(1);

  if (byName && byName.length > 0) {
    return mapPaidUserFromRow(byName[0]);
  }
  return null;
}

export async function sbUpsertPaidUsers(items: any[]) {
  await upsertInChunks('paid_users', items.map(mapPaidUserToRow));
}

export async function sbUpdatePaidUserStatus(
  id: string,
  status: 'active' | 'pending' | 'revoked',
  permanentAccess: boolean
) {
  const sb = getSupabaseAdmin();
  const { error } = await sb
    .from('paid_users')
    .update({ status, permanent_access: permanentAccess })
    .eq('id', id);
  if (error) throw new Error(`Supabase update paid_user failed: ${error.message}`);
}

export async function sbDeletePaidUser(id: string) {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from('paid_users').delete().eq('id', id);
  if (error) throw new Error(`Supabase delete paid_user failed: ${error.message}`);
}

export async function sbRefreshGlobalStatsRow() {
  const stats = await sbFetchGlobalStats();
  const sb = getSupabaseAdmin();
  await sb.from('global_stats').upsert(
    {
      id: 'global',
      questions_count: stats.questionsCount,
      subjects_count: stats.subjectsCount,
      logins_count: stats.loginsCount,
      feedbacks_count: stats.feedbacksCount,
      notifications_count: stats.notificationsCount,
      updated_at: stats.updatedAt,
    },
    { onConflict: 'id' }
  );
  return stats;
}

export function getSupabasePublicConfig(): {
  configured: boolean;
  url: string;
  publishableKey: string;
} {
  const url = resolveSupabaseUrl();
  const candidates = [
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim(),
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim(),
    process.env.SUPABASE_ANON_KEY?.trim(),
    process.env.VITE_SUPABASE_ANON_KEY?.trim(),
    // Only reuse SUPABASE_SERVICE_ROLE_KEY if it is actually a public sb_publishable_ key
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()?.startsWith('sb_publishable_')
      ? process.env.SUPABASE_SERVICE_ROLE_KEY.trim()
      : '',
  ];
  const publishableKey = candidates.find((k) => Boolean(k)) || '';
  return {
    configured: Boolean(url && publishableKey),
    url,
    publishableKey,
  };
}

export async function sbEnsureSubjectsFromQuestions(questionsInput?: any[]): Promise<any[]> {
  const [questions, existingSubjects] = await Promise.all([
    Array.isArray(questionsInput) ? Promise.resolve(questionsInput) : sbFetchAllQuestions(),
    sbFetchAllSubjects(),
  ]);

  const existingNames = new Set(
    existingSubjects.map((s) => String(s.name || '').trim().toLowerCase()).filter(Boolean)
  );
  const missing: any[] = [];
  let nextOrder = existingSubjects.reduce(
    (max, s) => Math.max(max, typeof s.order === 'number' ? s.order : 0),
    -1
  ) + 1;

  for (const q of questions) {
    const name = String(q?.subject || '').trim();
    if (!name) continue;
    const norm = name.toLowerCase();
    if (existingNames.has(norm)) continue;
    existingNames.add(norm);
    const slug = Buffer.from(norm).toString('base64url').slice(0, 40);
    missing.push({
      id: `sub-auto-${slug}`,
      name,
      type: q?.type === 'short' || q?.type === 'explanation' ? q.type : 'mcq',
      isActive: true,
      order: nextOrder++,
    });
  }

  if (missing.length > 0) {
    await sbUpsertSubjects(missing);
    await sbRefreshGlobalStatsRow().catch(() => {});
    return [...existingSubjects, ...missing].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  return existingSubjects;
}

export interface SupabaseRealtimeServerEvent {
  table: string;
  eventType: 'INSERT' | 'UPDATE' | 'DELETE' | 'BROADCAST';
  record?: any;
  oldRecord?: any;
  broadcastPayload?: any;
}

const SUPABASE_REALTIME_CHANNEL = 'master-quiz-kh-live';
let realtimeChannel: ReturnType<SupabaseClient['channel']> | null = null;
let realtimeSubscribed = false;

function mapRealtimeRow(table: string, row: any): any {
  if (!row || typeof row !== 'object') return row;
  switch (table) {
    case 'questions':
      return mapQuestionFromRow(row);
    case 'subjects':
      return mapSubjectFromRow(row);
    case 'notifications':
      return mapNotificationFromRow(row);
    case 'bot_commands':
      return mapBotCommandFromRow(row);
    case 'feedbacks':
      return mapFeedbackFromRow(row);
    case 'logins':
      return mapLoginFromRow(row);
    case 'presence':
      return mapPresenceFromRow(row);
    case 'paid_users':
      return mapPaidUserFromRow(row);
    default:
      return row;
  }
}

export function startServerSupabaseRealtime(
  onEvent: (event: SupabaseRealtimeServerEvent) => void
): () => void {
  if (!isSupabaseConfigured()) return () => {};
  try {
    const sb = getSupabaseAdmin();
    if (realtimeChannel) {
      try {
        sb.removeChannel(realtimeChannel);
      } catch {
        // Ignore
      }
      realtimeChannel = null;
      realtimeSubscribed = false;
    }

    const tables = [
      'questions',
      'subjects',
      'notifications',
      'bot_commands',
      'feedbacks',
      'logins',
      'presence',
      'paid_users',
      'global_stats',
    ];

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
          const eventType = String(payload?.eventType || 'UPDATE').toUpperCase() as
            | 'INSERT'
            | 'UPDATE'
            | 'DELETE';
          onEvent({
            table: tbl,
            eventType,
            record: payload?.new ? mapRealtimeRow(tbl, payload.new) : undefined,
            oldRecord: payload?.old ? mapRealtimeRow(tbl, payload.old) : undefined,
          });
        }
      );
    }

    ch = ch.on('broadcast', { event: 'db_sync' }, (payload: any) => {
      if (payload?.payload) {
        onEvent({
          table: String(payload.payload.scope || 'core'),
          eventType: 'BROADCAST',
          broadcastPayload: payload.payload,
        });
      }
    });

    realtimeChannel = ch.subscribe((status) => {
      realtimeSubscribed = status === 'SUBSCRIBED';
      if (status === 'SUBSCRIBED') {
        console.log('[Supabase Realtime] Server channel connected & listening.');
      }
    });

    return () => {
      if (realtimeChannel) {
        try {
          sb.removeChannel(realtimeChannel);
        } catch {
          // Ignore
        }
        realtimeChannel = null;
        realtimeSubscribed = false;
      }
    };
  } catch (err) {
    console.warn('[Supabase Realtime] Server setup note:', err);
    return () => {};
  }
}

export async function broadcastSupabaseRealtime(payload: Record<string, any>): Promise<void> {
  if (!realtimeChannel || !realtimeSubscribed) return;
  try {
    await realtimeChannel.send({
      type: 'broadcast',
      event: 'db_sync',
      payload: {
        ...payload,
        origin: 'server',
        ts: Date.now(),
      },
    });
  } catch {
    // Non-blocking best-effort broadcast
  }
}

