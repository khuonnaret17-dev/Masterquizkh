import React, { useState, useEffect } from 'react';
import { UserSession, Question, Subject, AppNotification, LoginRecord, PresenceRecord, Feedback, AppThemeId, BotCommandConfig, QuizContext } from './types';
import { LandingPage } from './components/LandingPage';
import { Navbar } from './components/Navbar';
import { PlaySection } from './components/PlaySection';
import { QuizGameScreen } from './components/QuizGameScreen';
import { AdminSection } from './components/AdminSection';
import { FloatingMessengerWidget } from './components/FloatingMessengerWidget';
import { ThemeSelectorModal } from './components/ThemeSelectorModal';
import { getStoredTheme } from './services/theme';
import {
  subscribeQuestions,
  subscribeSubjects,
  subscribeNotifications,
  subscribeLogins,
  subscribePresence,
  subscribeFeedbacks,
  subscribeBotCommands,
  updatePresenceHeartbeat,
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

  // Session State
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

  // Firestore Real-time State
  const [questions, setQuestions] = useState<Question[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [logins, setLogins] = useState<LoginRecord[]>([]);
  const [presence, setPresence] = useState<PresenceRecord[]>([]);
  const [feedbacks, setFeedbacks] = useState<Feedback[]>([]);
  const [botCommands, setBotCommands] = useState<Record<string, BotCommandConfig>>({});

  // Subscriptions to Firestore
  useEffect(() => {
    const unsubQ = subscribeQuestions(setQuestions);
    const unsubSub = subscribeSubjects(setSubjects);
    const unsubNotif = subscribeNotifications(setNotifications);
    const unsubLog = subscribeLogins(setLogins);
    const unsubPres = subscribePresence(setPresence);
    const unsubFb = subscribeFeedbacks(setFeedbacks);
    const unsubBot = subscribeBotCommands((cmds) => {
      setBotCommands(cmds);
      if (Object.keys(cmds).length > 0) {
        syncTelegramBotTemplates(cmds);
      }
    });

    return () => {
      unsubQ();
      unsubSub();
      unsubNotif();
      unsubLog();
      unsubPres();
      unsubFb();
      unsubBot();
    };
  }, []);

  // Real-time 60-second Presence Heartbeat
  useEffect(() => {
    if (!session) return;

    // Send immediately on login
    updatePresenceHeartbeat(session.username, session.role);

    // Send heartbeat every 60 seconds
    const interval = setInterval(() => {
      updatePresenceHeartbeat(session.username, session.role);
    }, 60000);

    return () => clearInterval(interval);
  }, [session]);

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
    if (!session) return;
    if (activeQuizQuestions) {
      return setTelegramBackButton(true, () => {
        setActiveQuizQuestions(null);
        setActiveQuizTitle('');
        setActiveQuizContext(null);
      });
    }
    if (activeTab === 'admin' && session.role === 'admin') {
      return setTelegramBackButton(true, () => setActiveTab('play'));
    }
    return setTelegramBackButton(false);
  }, [session, activeQuizQuestions, activeTab]);

  // If not authenticated, show royal landing page with compact Mini App header & role selection
  if (!session) {
    return <LandingPage onLoginSuccess={handleLoginSuccess} />;
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
        onlineCount={presence.length}
        isMuted={isMuted}
        onToggleMute={handleToggleMute}
        currentTheme={currentTheme}
        onOpenThemeModal={() => setIsThemeModalOpen(true)}
        notificationsCount={notifications.length}
        canGoBack={Boolean(activeQuizQuestions)}
        onBack={activeQuizQuestions ? handleExitQuiz : undefined}
        pageTitle={activeQuizQuestions ? activeQuizTitle : undefined}
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
          />
        ) : (
          <PlaySection
            questions={questions}
            subjects={subjects}
            session={session}
            onStartQuiz={handleStartQuiz}
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
    </div>
  );
}
