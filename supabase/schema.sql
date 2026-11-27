-- Master Quiz KH - Supabase PostgreSQL Schema
-- Run this SQL once in Supabase Dashboard -> SQL Editor

CREATE TABLE IF NOT EXISTS public.subjects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('mcq', 'short', 'explanation')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subjects_order ON public.subjects (sort_order ASC);

CREATE TABLE IF NOT EXISTS public.questions (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  question TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('mcq', 'short', 'explanation')),
  options JSONB,
  correct INTEGER,
  answer TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_questions_order ON public.questions (sort_order ASC);
CREATE INDEX IF NOT EXISTS idx_questions_subject ON public.questions (subject);

CREATE TABLE IF NOT EXISTS public.notifications (
  id TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  type TEXT NOT NULL DEFAULT 'info' CHECK (type IN ('info', 'success', 'warning'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_ts ON public.notifications (timestamp DESC);

CREATE TABLE IF NOT EXISTS public.bot_commands (
  id TEXT PRIMARY KEY,
  command TEXT NOT NULL UNIQUE,
  title_kh TEXT NOT NULL DEFAULT '',
  description_kh TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  image_url TEXT,
  image_alt TEXT,
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.feedbacks (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uid TEXT
);

CREATE INDEX IF NOT EXISTS idx_feedbacks_created_at ON public.feedbacks (created_at DESC);

CREATE TABLE IF NOT EXISTS public.logins (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  password_used TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
  uid TEXT
);

CREATE INDEX IF NOT EXISTS idx_logins_ts ON public.logins (timestamp DESC);

CREATE TABLE IF NOT EXISTS public.presence (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uid TEXT
);

CREATE INDEX IF NOT EXISTS idx_presence_last_seen ON public.presence (last_seen DESC);

CREATE TABLE IF NOT EXISTS public.paid_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  phone_number TEXT DEFAULT '',
  amount NUMERIC NOT NULL DEFAULT 10,
  currency TEXT NOT NULL DEFAULT 'USD',
  paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'revoked')),
  permanent_access BOOLEAN NOT NULL DEFAULT TRUE,
  transaction_ref TEXT,
  method TEXT,
  note TEXT,
  uid TEXT
);

CREATE INDEX IF NOT EXISTS idx_paid_users_paid_at ON public.paid_users (paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_paid_users_username_lower ON public.paid_users (LOWER(username));

CREATE TABLE IF NOT EXISTS public.global_stats (
  id TEXT PRIMARY KEY,
  questions_count INTEGER NOT NULL DEFAULT 0,
  subjects_count INTEGER NOT NULL DEFAULT 0,
  logins_count INTEGER NOT NULL DEFAULT 0,
  feedbacks_count INTEGER NOT NULL DEFAULT 0,
  notifications_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.global_stats (id) VALUES ('global') ON CONFLICT (id) DO NOTHING;

-- Allow public/anon access policies and enable Supabase Realtime (postgres_changes) for all tables
DO $$ 
DECLARE
  tbl text;
  rt_tables text[] := ARRAY[
    'subjects',
    'questions',
    'notifications',
    'bot_commands',
    'feedbacks',
    'logins',
    'presence',
    'paid_users',
    'global_stats'
  ];
BEGIN
  FOREACH tbl IN ARRAY rt_tables
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', tbl);
    EXECUTE format('DROP POLICY IF EXISTS "Allow all public %I" ON public.%I;', tbl, tbl);
    EXECUTE format('CREATE POLICY "Allow all public %I" ON public.%I FOR ALL USING (true) WITH CHECK (true);', tbl, tbl);
    EXECUTE format('ALTER TABLE public.%I REPLICA IDENTITY FULL;', tbl);
    BEGIN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I;', tbl);
    EXCEPTION WHEN duplicate_object THEN
      -- Table is already in supabase_realtime publication
    END;
  END LOOP;
END $$;


