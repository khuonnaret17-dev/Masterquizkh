import React, { useState, useEffect, useCallback } from 'react';
import { User as FirebaseUser } from 'firebase/auth';
import { QueryDocumentSnapshot, DocumentData } from 'firebase/firestore';
import { UserSession, Question, Subject, AppNotification, LoginRecord, PresenceRecord, Feedback, AppThemeId, BotCommandConfig, QuizContext, GlobalStats } from './types';
import { LandingPage } from './components/LandingPage';
import { Navbar } from './components/Navbar';
import { PlaySection } from './components/PlaySection';
import { QuizGameScreen } from './components/QuizGameScreen';
import { AdminSection } from './components/AdminSection';
import { FloatingMessengerWidget } from './components/FloatingMessengerWidget';
import { ThemeSelectorModal } from './components/ThemeSelectorModal';
import { OfflineIndicator } from './components/OfflineIndicator';
import { getStoredTheme } from './services/theme';
import {
  subscribeAuthState,
  subscribeQuestions,
  subscribeSubjects,
  subscribeNotifications,
  subscribeLogins,
  subscribePresence,
  subscribeFeedbacks,
  subscribeBotCommands,
  subscribeGlobalStats,
  fetchOnlineCount,
  fetchLoginsPage,
  fetchFeedbacksPage,
  fetchPresencePage,
  refreshAdminMonitoringData,
  updatePresenceHeartbeat,
  refreshCoreData,
  signInWithGoogle,
} from './services/firebase';
import { syncTelegramBotTemplates } from './services/telegram';
import {
  initTelegramMiniApp,
  syncTelegramMiniAppTheme,
  setTelegramBackButton,
} from './services/telegramWebApp';
import { getMuteState, setMuteState, shuffleArray, toKhmerNum } from './utils/khmer';

export default function App() {
  // Theme State
  const [currentTheme, setCurrentTheme] = useState<AppThemeId>(() => getStoredTheme());
  const [isThemeModalOpen, setIsThemeModalOpen] = useState(false);

  useEffect(() => {
    const cleanupMiniApp = initTelegramMiniApp();
    const handleThemeChange = (e: any) => {
      if (e.detail) {
        setCurrentTheme(e.detail);
        setTimeout(() => syncTelegramMiniAppTheme(), 0);
      }
    };
    window.addEventListener('appthemechange', handleThemeChange);
    return () => {
      cleanupMiniApp();
      window.removeEventListener('appthemechange', handleThemeChange);
    };
  }, []);

  useEffect(() => {
    syncTelegramMiniAppTheme();
  }, [currentTheme]);

  // Firebase Auth & Session State
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  useEffect(() => {
    const unsubAuth = subscribeAuthState((user) => {
      setFirebaseUser(user);
    });
    return () => unsubAuth();
  }, []);

  const [session, setSession] = useState<UserSession | null>(() => {
    try {
      const saved = localStorage.getItem('master_pro_quiz_session');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  // App View State
  const [activeTab, setActiveTab] = useState<'play' | 'admin'>('play');
  const [activeQuizQuestions, setActiveQuizQuestions] = useState<Question[] | null>(null);
  const [activeQuizTitle, setActiveQuizTitle] = useState<string>('');
  const [activeQuizContext, setActiveQuizContext] = useState<QuizContext | null>(null);
  const [quizSessionKey, setQuizSessionKey] = useState<number>(0);

  // Audio SFX state
  const [isMuted, setIsMuted] = useState<boolean>(() => getMuteState());

  // Firestore Cached State
  const [questions, setQuestions] = useState<Question[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [globalStats, setGlobalStats] = useState<GlobalStats>({});
  const [logins, setLogins] = useState<LoginRecord[]>([]);
  const [loginsCursor, setLoginsCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [hasMoreLogins, setHasMoreLogins] = useState(false);
  const [isLoadingMoreLogins, setIsLoadingMoreLogins] = useState(false);

  const [presence, setPresence] = useState<PresenceRecord[]>([]);
  const [presenceCursor, setPresenceCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [hasMorePresence, setHasMorePresence] = useState(false);
  const [isLoadingMorePresence, setIsLoadingMorePresence] = useState(false);

  const [onlineCount, setOnlineCount] = useState<number>(1);
  const [feedbacks, setFeedbacks] = useState<Feedback[]>([]);
  const [feedbacksCursor, setFeedbacksCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [hasMoreFeedbacks, setHasMoreFeedbacks] = useState(false);
  const [isLoadingMoreFeedbacks, setIsLoadingMoreFeedbacks] = useState(false);

  const [botCommands, setBotCommands] = useState<Record<string, BotCommandConfig>>({});
  const [isSyncingCore, setIsSyncingCore] = useState(false);

  // Core data subscriptions: only attach AFTER user logs in (re-sync cleanly on Firebase Auth sign-in)
  const isLoggedIn = Boolean(session);
  const firebaseUid = firebaseUser?.uid || '';
  useEffect(() => {
    if (!isLoggedIn) return;

    let active = true;
    setIsSyncingCore(true);

    const unsubQ = subscribeQuestions(setQuestions);
    const unsubSub = subscribeSubjects(setSubjects);
    const unsubNotif = subscribeNotifications(setNotifications);
    const unsubStats = subscribeGlobalStats(setGlobalStats);
    const unsubBot = subscribeBotCommands((cmds) => {
      setBotCommands(cmds);
      if (Object.keys(cmds).length > 0) {
        syncTelegramBotTemplates(cmds);
      }
    });

    const syncPromise = firebaseUid ? refreshCoreData() : Promise.resolve();
    void syncPromise.finally(() => {
      setTimeout(() => {
        if (active) setIsSyncingCore(false);
      }, 400);
    });

    return () => {
      active = false;
      unsubQ();
      unsubSub();
      unsubNotif();
      unsubStats();
      unsubBot();
    };
  }, [isLoggedIn, firebaseUid]);

  const handleSyncCoreNow = useCallback(async () => {
    setIsSyncingCore(true);
    try {
      await refreshCoreData();
    } finally {
      setIsSyncingCore(false);
    }
  }, []);

  const handleConnectGoogle = useCallback(async () => {
    setIsSyncingCore(true);
    try {
      await signInWithGoogle();
      await refreshCoreData();
    } catch {
      // Ignore user-cancelled popup
    } finally {
      setIsSyncingCore(false);
    }
  }, []);

  // Admin-only paginated collections (20 per page + startAfter): only load when Admin tab is active
  const isAdminPanelActive = session?.role === 'admin' && activeTab === 'admin';

  const loadInitialMonitoringPages = useCallback(async () => {
    const [logPage, presPage, fbPage] = await Promise.all([
      fetchLoginsPage(null, false),
      fetchPresencePage(null, false),
      fetchFeedbacksPage(null, false),
    ]);
    if (logPage.items.length > 0) {
      setLogins(logPage.items);
      setLoginsCursor(logPage.lastDoc);
      setHasMoreLogins(logPage.hasMore);
    }
    if (presPage.items.length > 0) {
      setPresence(presPage.items);
      setPresenceCursor(presPage.lastDoc);
      setHasMorePresence(presPage.hasMore);
      setOnlineCount(Math.max(1, presPage.items.length));
    }
    if (fbPage.items.length > 0) {
      setFeedbacks(fbPage.items);
      setFeedbacksCursor(fbPage.lastDoc);
      setHasMoreFeedbacks(fbPage.hasMore);
    }
  }, []);

  useEffect(() => {
    if (!isLoggedIn) return;

    if (!isAdminPanelActive) {
      let active = true;
      void fetchOnlineCount(false).then((count) => {
        if (active) setOnlineCount(count);
      });
      return () => {
        active = false;
      };
    }

    const unsubLog = subscribeLogins(setLogins);
    const unsubPres = subscribePresence((list) => {
      setPresence(list);
      setOnlineCount(Math.max(1, list.length));
    });
    const unsubFb = subscribeFeedbacks(setFeedbacks);

    void loadInitialMonitoringPages();

    return () => {
      unsubLog();
      unsubPres();
      unsubFb();
    };
  }, [isLoggedIn, isAdminPanelActive, firebaseUid, loadInitialMonitoringPages]);

  const handleLoadMoreLogins = useCallback(async () => {
    if (isLoadingMoreLogins || !hasMoreLogins || !loginsCursor) return;
    setIsLoadingMoreLogins(true);
    try {
      const page = await fetchLoginsPage(loginsCursor, true);
      setLogins((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        const additions = page.items.filter((x) => !seen.has(x.id));
        return [...prev, ...additions];
      });
      setLoginsCursor(page.lastDoc);
      setHasMoreLogins(page.hasMore);
    } finally {
      setIsLoadingMoreLogins(false);
    }
  }, [isLoadingMoreLogins, hasMoreLogins, loginsCursor]);

  const handleLoadMorePresence = useCallback(async () => {
    if (isLoadingMorePresence || !hasMorePresence || !presenceCursor) return;
    setIsLoadingMorePresence(true);
    try {
      const page = await fetchPresencePage(presenceCursor, true);
      setPresence((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        const additions = page.items.filter((x) => !seen.has(x.id));
        return [...prev, ...additions];
      });
      setPresenceCursor(page.lastDoc);
      setHasMorePresence(page.hasMore);
    } finally {
      setIsLoadingMorePresence(false);
    }
  }, [isLoadingMorePresence, hasMorePresence, presenceCursor]);

  const handleLoadMoreFeedbacks = useCallback(async () => {
    if (isLoadingMoreFeedbacks || !hasMoreFeedbacks || !feedbacksCursor) return;
    setIsLoadingMoreFeedbacks(true);
    try {
      const page = await fetchFeedbacksPage(feedbacksCursor, true);
      setFeedbacks((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        const additions = page.items.filter((x) => !seen.has(x.id));
        return [...prev, ...additions];
      });
      setFeedbacksCursor(page.lastDoc);
      setHasMoreFeedbacks(page.hasMore);
    } finally {
      setIsLoadingMoreFeedbacks(false);
    }
  }, [isLoadingMoreFeedbacks, hasMoreFeedbacks, feedbacksCursor]);

  const handleRefreshMonitoring = useCallback(async () => {
    await refreshAdminMonitoringData();
    const [logPage, presPage, fbPage] = await Promise.all([
      fetchLoginsPage(null, false),
      fetchPresencePage(null, false),
      fetchFeedbacksPage(null, false),
    ]);
    setLogins(logPage.items);
    setLoginsCursor(logPage.lastDoc);
    setHasMoreLogins(logPage.hasMore);
    setPresence(presPage.items);
    setPresenceCursor(presPage.lastDoc);
    setHasMorePresence(presPage.hasMore);
    setFeedbacks(fbPage.items);
    setFeedbacksCursor(fbPage.lastDoc);
    setHasMoreFeedbacks(fbPage.hasMore);
  }, []);

  // Real-time 5-minute Presence Heartbeat (primitive dependencies prevent re-render/loop)
  const sessionUsername = session?.username || '';
  const sessionRole = session?.role;
  useEffect(() => {
    if (!sessionUsername || !sessionRole) return;

    updatePresenceHeartbeat(sessionUsername, sessionRole);

    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      updatePresenceHeartbeat(sessionUsername, sessionRole);
    }, 300000);

    return () => clearInterval(interval);
  }, [sessionUsername, sessionRole, firebaseUid]);

  const handleLoginSuccess = (newSession: UserSession) => {
    setSession(newSession);
    try {
      localStorage.setItem('master_pro_quiz_session', JSON.stringify(newSession));
    } catch {
      // Ignore
    }
  };

  const handleLogout = () => {
    setSession(null);
    setActiveQuizQuestions(null);
    setActiveQuizContext(null);
    try {
      localStorage.removeItem('master_pro_quiz_session');
    } catch {
      // Ignore
    }
  };

  const handleToggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    setMuteState(next);
  };

  const handleStartQuiz = (quizQuestions: Question[], title: string, context?: QuizContext) => {
    setActiveQuizQuestions(quizQuestions);
    setActiveQuizTitle(title);
    setActiveQuizContext(context || null);
    setQuizSessionKey((prev) => prev + 1);
  };

  const handleExitQuiz = () => {
    setActiveQuizQuestions(null);
    setActiveQuizTitle('');
    setActiveQuizContext(null);
  };

  const hasNextPart =
    activeQuizContext?.mode === 'part' &&
    typeof activeQuizContext.partIndex === 'number' &&
    typeof activeQuizContext.totalParts === 'number' &&
    activeQuizContext.partIndex + 1 < activeQuizContext.totalParts &&
    Boolean(activeQuizContext.subjectName);

  const nextPartLabel = hasNextPart
    ? `បន្តទៅភាគ ${toKhmerNum((activeQuizContext?.partIndex ?? 0) + 2)}`
    : undefined;

  const isLastPart =
    activeQuizContext?.mode === 'part' &&
    typeof activeQuizContext.partIndex === 'number' &&
    typeof activeQuizContext.totalParts === 'number' &&
    activeQuizContext.partIndex + 1 >= activeQuizContext.totalParts;

  const handleStartNextPart = () => {
    if (
      !hasNextPart ||
      !activeQuizContext?.subjectName ||
      typeof activeQuizContext.partIndex !== 'number'
    ) {
      return;
    }
    const nextPartIndex = activeQuizContext.partIndex + 1;
    const subjectQuestions = questions.filter(
      (q) => q.isActive !== false && q.subject === activeQuizContext.subjectName
    );
    const totalParts = Math.ceil(subjectQuestions.length / 10);
    const nextSlice = subjectQuestions.slice(nextPartIndex * 10, (nextPartIndex + 1) * 10);
    if (nextSlice.length === 0) return;

    handleStartQuiz(
      shuffleArray(nextSlice),
      `${activeQuizContext.subjectName} (ភាគ ${toKhmerNum(nextPartIndex + 1)})`,
      {
        mode: 'part',
        subjectName: activeQuizContext.subjectName,
        partIndex: nextPartIndex,
        totalParts,
      }
    );
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  useEffect(() => {
    if (!sessionUsername || !sessionRole) return;
    if (activeQuizQuestions) {
      return setTelegramBackButton(true, () => {
        setActiveQuizQuestions(null);
        setActiveQuizTitle('');
        setActiveQuizContext(null);
      });
    }
    if (activeTab === 'admin' && sessionRole === 'admin') {
      return setTelegramBackButton(true, () => setActiveTab('play'));
    }
    return setTelegramBackButton(false);
  }, [sessionUsername, sessionRole, activeQuizQuestions, activeTab]);

  // If not authenticated, show royal landing page with compact Mini App header & role selection
  if (!session) {
    return (
      <LandingPage
        onLoginSuccess={handleLoginSuccess}
        firebaseUserEmail={firebaseUser?.email || null}
      />
    );
  }

  return (
    <div className="min-h-miniapp app-canvas flex flex-col font-kantumruy selection:bg-[var(--theme-accent)] selection:text-white">
      {/* Top Navbar */}
      <Navbar
        session={session}
        activeTab={activeTab}
        onTabChange={(tab) => {
          setActiveQuizQuestions(null);
          setActiveTab(tab);
        }}
        onLogout={handleLogout}
        onlineCount={isAdminPanelActive && presence.length > 0 ? presence.length : onlineCount}
        isMuted={isMuted}
        onToggleMute={handleToggleMute}
        currentTheme={currentTheme}
        onOpenThemeModal={() => setIsThemeModalOpen(true)}
        notificationsCount={notifications.length}
        canGoBack={Boolean(activeQuizQuestions)}
        onBack={activeQuizQuestions ? handleExitQuiz : undefined}
        pageTitle={activeQuizQuestions ? activeQuizTitle : undefined}
        firebaseUserEmail={firebaseUser?.email || null}
      />

      {/* Main Content Area */}
      <main className="flex-1 pb-16">
        {activeQuizQuestions ? (
          <QuizGameScreen
            key={quizSessionKey}
            questions={activeQuizQuestions}
            title={activeQuizTitle}
            isMuted={isMuted}
            onToggleMute={handleToggleMute}
            onExit={handleExitQuiz}
            onNextPart={hasNextPart ? handleStartNextPart : undefined}
            nextPartLabel={nextPartLabel}
            isLastPart={isLastPart}
          />
        ) : activeTab === 'admin' && session.role === 'admin' ? (
          <AdminSection
            questions={questions}
            subjects={subjects}
            logins={logins}
            presence={presence}
            feedbacks={feedbacks}
            notifications={notifications}
            botCommands={botCommands}
            globalStats={globalStats}
            firebaseUserEmail={firebaseUser?.email || null}
            hasMoreLogins={hasMoreLogins}
            isLoadingMoreLogins={isLoadingMoreLogins}
            onLoadMoreLogins={handleLoadMoreLogins}
            hasMorePresence={hasMorePresence}
            isLoadingMorePresence={isLoadingMorePresence}
            onLoadMorePresence={handleLoadMorePresence}
            hasMoreFeedbacks={hasMoreFeedbacks}
            isLoadingMoreFeedbacks={isLoadingMoreFeedbacks}
            onLoadMoreFeedbacks={handleLoadMoreFeedbacks}
            onRefreshMonitoring={handleRefreshMonitoring}
          />
        ) : (
          <PlaySection
            questions={questions}
            subjects={subjects}
            session={session}
            onStartQuiz={handleStartQuiz}
            globalStats={globalStats}
            firebaseUserEmail={firebaseUser?.email || null}
            isSyncingCore={isSyncingCore}
            onSyncNow={handleSyncCoreNow}
            onConnectGoogle={handleConnectGoogle}
          />
        )}
      </main>

      {/* Floating Messenger Widget */}
      <FloatingMessengerWidget
        notifications={notifications}
        session={session}
        botCommands={botCommands}
      />

      {/* Theme Selection Modal */}
      <ThemeSelectorModal
        isOpen={isThemeModalOpen}
        onClose={() => setIsThemeModalOpen(false)}
        currentTheme={currentTheme}
        onThemeSelect={(t) => setCurrentTheme(t)}
      />

      <OfflineIndicator />
    </div>
  );
}
