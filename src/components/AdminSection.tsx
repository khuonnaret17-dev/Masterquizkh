import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  PlusCircle,
  FileSpreadsheet,
  Settings,
  Download,
  Send,
  Users,
  Sparkles,
  Trash2,
  Edit2,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  GripVertical,
  CheckCircle2,
  AlertCircle,
  Eye,
  RefreshCw,
  Bell,
  Check,
  ChevronDown,
  ChevronUp,
  X,
  Layers,
  ListChecks,
  MessageSquare,
  StopCircle,
  Radio,
  BookOpen,
  Terminal,
  Shuffle,
  FileText,
  Image as ImageIcon,
  Share2,
  Bot,
  Search,
  RotateCcw,
  Save,
  FileJson,
  Upload,
  Cloud,
} from 'lucide-react';
import { Question, Subject, LoginRecord, PresenceRecord, Feedback, QuestionType, AppNotification, BotCommandConfig, BotActionButton, GlobalStats } from '../types';
import { toKhmerNum, getOptionLabel, shuffleArray } from '../utils/khmer';
import { KhmerCornerMotif } from './KhmerOrnaments';
import { SocialShareModal, ShareBatchCandidate } from './SocialShareModal';
import {
  formatQuestionSocialCaption,
  formatMultiQuestionsSocialCaption,
  ShareImageFormat,
} from '../services/socialShare';
import { DEFAULT_BOT_COMMANDS, getMergedBotCommands, KHQR_IMAGE_PATH } from '../utils/botCommands';
import {
  addQuestion,
  addQuestionsBatch,
  updateQuestion,
  renameQuestionsSubject,
  deleteQuestion,
  deleteQuestionsBatch,
  swapQuestions,
  addSubject,
  updateSubject,
  deleteSubject,
  moveSubject,
  swapSubjects,
  broadcastNotification,
  deleteNotification,
  deleteAllNotifications,
  deleteLoginRecord,
  deleteLoginsByIds,
  saveBotCommandConfig,
  resetBotCommandConfig,
  resetAllBotCommands,
  refreshCoreData,
  refreshAdminMonitoringData,
  signInWithGoogle,
  migrateAllFirebaseToSupabase,
  exportAllFirebaseDataAsJson,
  importBackupJsonToSupabase,
  fetchDbMode,
  setDbMode,
  DbModeType,
} from '../services/firebase';
import {
  SAMPLE_EXPORT_JSON_STRING,
  buildExportJsonPayload,
  downloadJsonFile,
  parseQuestionsJsonInput,
} from '../services/jsonQuestions';
import {
  testTelegramBot,
  sendTelegramMessage,
  sendTelegramPoll,
  sendTelegramPhoto,
  renderQuestionCardImage,
  renderAppBannerImage,
  formatPhotoCaption,
  sendTelegramQuestionTextWithBanner,
  formatSubjectDigestMessages,
  escapeTgHtml,
  sleep,
  registerTelegramCommands,
  startTelegramCommandBot,
  stopTelegramCommandBot,
  getTelegramCommandBotStatus,
  CommandBotStatus,
  DEFAULT_TELEGRAM_TARGETS,
  TelegramTargetItem,
  normalizeTelegramChatId,
  parseTelegramChatIds,
} from '../services/telegram';
import {
  exportQuestionsToPDF,
  PDF_TEMPLATES,
  PDF_KHMER_FONTS,
  PDF_FONT_SIZES,
  DEFAULT_PDF_SETTINGS,
  getPdfQuestionTypeSummary,
  getPdfAnswerModeSummary,
  PdfExportSettings,
  PdfTemplateId,
  PdfKhmerFontId,
  PdfTitleFontId,
  PdfFontSizeId,
  PdfPageBorderId,
  PdfAnswerMode,
} from '../services/pdfExport';

interface AdminSectionProps {
  questions: Question[];
  subjects: Subject[];
  logins: LoginRecord[];
  presence: PresenceRecord[];
  feedbacks: Feedback[];
  notifications: AppNotification[];
  botCommands?: Record<string, BotCommandConfig>;
  globalStats?: GlobalStats;
  firebaseUserEmail?: string | null;
  hasMoreLogins?: boolean;
  isLoadingMoreLogins?: boolean;
  onLoadMoreLogins?: () => void;
  hasMorePresence?: boolean;
  isLoadingMorePresence?: boolean;
  onLoadMorePresence?: () => void;
  hasMoreFeedbacks?: boolean;
  isLoadingMoreFeedbacks?: boolean;
  onLoadMoreFeedbacks?: () => void;
  onRefreshMonitoring?: () => Promise<void>;
}

export const AdminSection: React.FC<AdminSectionProps> = ({
  questions,
  subjects,
  logins,
  presence,
  feedbacks,
  notifications,
  botCommands = {},
  globalStats,
  firebaseUserEmail = null,
  hasMoreLogins = false,
  isLoadingMoreLogins = false,
  onLoadMoreLogins,
  hasMorePresence = false,
  isLoadingMorePresence = false,
  onLoadMorePresence,
  hasMoreFeedbacks = false,
  isLoadingMoreFeedbacks = false,
  onLoadMoreFeedbacks,
  onRefreshMonitoring,
}) => {
  const [activeSubTab, setActiveSubTab] = useState<
    'single' | 'bulk_ai' | 'manage' | 'export' | 'telegram' | 'monitoring'
  >('single');

  // Single Question Form State
  const [singleSubject, setSingleSubject] = useState(subjects[0]?.name || '');
  const [newSubjectName, setNewSubjectName] = useState('');
  const [singleType, setSingleType] = useState<QuestionType>('mcq');
  const [singleQuestionText, setSingleQuestionText] = useState('');
  const [singleOptions, setSingleOptions] = useState<string[]>([
    'ក. ',
    'ខ. ',
    'គ. ',
    'ឃ. ',
  ]);
  const [singleCorrect, setSingleCorrect] = useState<number>(0);
  const [singleAnswer, setSingleAnswer] = useState('');
  const [singleStatusMsg, setSingleStatusMsg] = useState<{ text: string; success: boolean } | null>(
    null
  );

  // Bulk Import State
  const [bulkInputMode, setBulkInputMode] = useState<'text' | 'json'>('text');
  const [bulkText, setBulkText] = useState('');
  const [bulkJsonText, setBulkJsonText] = useState('');
  const [jsonOverrideSubject, setJsonOverrideSubject] = useState(false);
  const [parsedSubjectMetaMap, setParsedSubjectMetaMap] = useState<Record<string, Partial<Subject>>>({});
  const [isSavingBulkQuestions, setIsSavingBulkQuestions] = useState(false);
  const jsonFileInputRef = useRef<HTMLInputElement | null>(null);
  const [bulkSubject, setBulkSubject] = useState(subjects[0]?.name || '');
  const [newBulkSubjectName, setNewBulkSubjectName] = useState('');
  const [bulkImportType, setBulkImportType] = useState<'auto' | 'mcq' | 'short' | 'explanation'>('auto');
  const [generatedPreview, setGeneratedPreview] = useState<Question[]>([]);
  const [bulkStatusMsg, setBulkStatusMsg] = useState<{ text: string; success: boolean } | null>(
    null
  );

  // Sync selected subject fallbacks safely using functional updaters (prevents redundant re-renders)
  const subjectNamesKey = useMemo(() => subjects.map((s) => s.name).join('||'), [subjects]);
  useEffect(() => {
    if (subjects.length === 0) return;
    const validNames = new Set(subjects.map((s) => s.name));
    const firstName = subjects[0].name;
    setBulkSubject((prev) => (prev && validNames.has(prev) ? prev : firstName));
    setSingleSubject((prev) => (prev && validNames.has(prev) ? prev : firstName));
    setSelectedSubjectToManage((prev) => (prev && validNames.has(prev) ? prev : firstName));
  }, [subjectNamesKey, subjects]);

  // Management State
  const [directSubjectName, setDirectSubjectName] = useState('');
  const [directSubjectType, setDirectSubjectType] = useState<QuestionType>('mcq');
  const [directSubjectStatusMsg, setDirectSubjectStatusMsg] = useState<{ text: string; success: boolean } | null>(null);

  const [selectedSubjectToManage, setSelectedSubjectToManage] = useState<string>(
    subjects[0]?.name || ''
  );
  const [swapFromIndex, setSwapFromIndex] = useState<number>(1);
  const [swapToIndex, setSwapToIndex] = useState<number>(2);
  const [subjectSwapFrom, setSubjectSwapFrom] = useState<number>(1);
  const [subjectSwapTo, setSubjectSwapTo] = useState<number>(2);
  const [subjectOrderStatusMsg, setSubjectOrderStatusMsg] = useState<{ text: string; success: boolean } | null>(null);
  const [isReorderingSubjects, setIsReorderingSubjects] = useState(false);
  const [draggedSubjectIndex, setDraggedSubjectIndex] = useState<number | null>(null);
  const [dragOverSubjectIndex, setDragOverSubjectIndex] = useState<number | null>(null);

  useEffect(() => {
    if (subjects.length <= 1) {
      setSubjectSwapFrom(1);
      setSubjectSwapTo(1);
      return;
    }
    setSubjectSwapFrom((prev) => Math.min(Math.max(1, prev), subjects.length));
    setSubjectSwapTo((prev) => {
      const clamped = Math.min(Math.max(1, prev), subjects.length);
      return clamped === 1 && subjects.length >= 2 ? 2 : clamped;
    });
  }, [subjects.length]);

  const getNextSubjectOrder = () =>
    subjects.length > 0 ? Math.max(...subjects.map((s, idx) => s.order ?? idx)) + 1 : 0;

  const handleAddNewSubjectDirect = async (e: React.FormEvent) => {
    e.preventDefault();
    setDirectSubjectStatusMsg(null);
    const name = directSubjectName.trim();
    if (!name) {
      setDirectSubjectStatusMsg({ text: 'សូមបញ្ចូលឈ្មោះមុខវិជ្ជា!', success: false });
      return;
    }
    if (subjects.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      setDirectSubjectStatusMsg({ text: 'ឈ្មោះមុខវិជ្ជានេះមានក្នុងប្រព័ន្ធរួចហើយ!', success: false });
      return;
    }

    try {
      await addSubject({
        name,
        type: directSubjectType,
        isActive: true,
        order: getNextSubjectOrder(),
      });
      setDirectSubjectStatusMsg({ text: `បានបន្ថែមមុខវិជ្ជាថ្មី "${name}" ជោគជ័យ!`, success: true });
      setDirectSubjectName('');
    } catch (err: any) {
      setDirectSubjectStatusMsg({ text: err.message || 'បរាជ័យក្នុងការបន្ថែមមុខវិជ្ជា', success: false });
    }
  };

  // PDF Export Settings (Persisted in localStorage)
  const [pdfSettings, setPdfSettings] = useState<PdfExportSettings>(() => {
    try {
      const saved = localStorage.getItem('master_quiz_pdf_settings_v1');
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          ...DEFAULT_PDF_SETTINGS,
          ...parsed,
          header: { ...DEFAULT_PDF_SETTINGS.header, ...(parsed.header || {}) },
          footer: { ...DEFAULT_PDF_SETTINGS.footer, ...(parsed.footer || {}) },
        };
      }
    } catch {
      // Ignore storage errors
    }
    return DEFAULT_PDF_SETTINGS;
  });
  const [exportSubject, setExportSubject] = useState<string>(subjects[0]?.name || '__ALL__');
  const [exportCountLimit, setExportCountLimit] = useState<number | 'all'>('all');
  const [exportStartIndex, setExportStartIndex] = useState<number>(1);
  const [exportOrderMode, setExportOrderMode] = useState<'sequential' | 'random'>('sequential');
  const [exportShuffleSeed, setExportShuffleSeed] = useState<number>(0);
  const [isExportingPDF, setIsExportingPDF] = useState(false);
  const [pdfProgress, setPdfProgress] = useState<{ current: number; total: number } | null>(null);
  const [exportStatusMsg, setExportStatusMsg] = useState<{ text: string; success: boolean } | null>(null);

  const [isMigratingDb, setIsMigratingDb] = useState(false);
  const [migrationProgressText, setMigrationProgressText] = useState('');
  const [migrationStatusMsg, setMigrationStatusMsg] = useState<{ text: string; success: boolean } | null>(null);
  const [schemaSqlPreview, setSchemaSqlPreview] = useState<string | null>(null);
  const [dbMode, setDbModeState] = useState<DbModeType>('dual');
  const [isChangingMode, setIsChangingMode] = useState(false);
  const backupImportFileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void fetchDbMode().then((info) => {
      if (info?.mode) setDbModeState(info.mode);
    }).catch(() => {});

    const handleModeChanged = (e: Event) => {
      const next = (e as CustomEvent<DbModeType>).detail;
      if (next === 'dual' || next === 'supabase' || next === 'firestore') {
        setDbModeState(next);
      }
    };
    window.addEventListener('mpq-db-mode-changed', handleModeChanged);
    return () => {
      window.removeEventListener('mpq-db-mode-changed', handleModeChanged);
    };
  }, []);

  const handleSelectDbMode = async (mode: DbModeType) => {
    if (isChangingMode || dbMode === mode) return;
    setIsChangingMode(true);
    setMigrationStatusMsg(null);
    try {
      await setDbMode(mode);
      setDbModeState(mode);
      const modeNames: Record<DbModeType, string> = {
        dual: 'ដំណើរការទ្វេរដង (Dual-Sync ទាំង Supabase និង Firebase)',
        supabase: 'ប្រើប្រាស់ Supabase ទាំងស្រុង',
        firestore: 'ប្រើប្រាស់ Firebase (Firestore) ទាំងស្រុង',
      };
      setMigrationStatusMsg({
        text: `បានប្ដូររបៀប Database ទៅជា៖ ${modeNames[mode]} ជោគជ័យ!`,
        success: true,
      });
    } catch (err: any) {
      setMigrationStatusMsg({
        text: err?.message || 'បរាជ័យក្នុងការប្ដូររបៀប Database',
        success: false,
      });
    } finally {
      setIsChangingMode(false);
    }
  };

  useEffect(() => {
    try {
      localStorage.setItem('master_quiz_pdf_settings_v1', JSON.stringify(pdfSettings));
    } catch {
      // Ignore
    }
  }, [pdfSettings]);

  useEffect(() => {
    if (subjects.length > 0 && (!exportSubject || (exportSubject !== '__ALL__' && !subjects.some((s) => s.name === exportSubject)))) {
      setExportSubject(subjects[0].name);
    }
  }, [subjects, exportSubject]);

  const resolvedExportSubjectName = exportSubject || subjects[0]?.name || '__ALL__';
  const rawExportSubjectQuestions = useMemo(() => {
    return resolvedExportSubjectName === '__ALL__'
      ? questions
      : questions.filter((q) => q.subject === resolvedExportSubjectName);
  }, [questions, resolvedExportSubjectName]);

  const selectedExportQuestions = useMemo(() => {
    const total = rawExportSubjectQuestions.length;
    if (total === 0) return [];
    const limit =
      exportCountLimit === 'all'
        ? total
        : Math.min(Math.max(1, exportCountLimit), total);

    if (exportOrderMode === 'random') {
      void exportShuffleSeed;
      return shuffleArray(rawExportSubjectQuestions).slice(0, limit);
    }

    const safeStart = Math.min(Math.max(1, exportStartIndex), total);
    return rawExportSubjectQuestions.slice(safeStart - 1, safeStart - 1 + limit);
  }, [
    rawExportSubjectQuestions,
    exportCountLimit,
    exportStartIndex,
    exportOrderMode,
    exportShuffleSeed,
  ]);

  const TG_TARGETS_STORAGE_KEY = 'master_quiz_tg_targets_v1';

  // Telegram Bot Settings & Batch State
  const [tgBotToken, setTgBotToken] = useState(() => {
    return localStorage.getItem('master_quiz_tg_token') || '';
  });
  const [tgTargets, setTgTargets] = useState<TelegramTargetItem[]>(() => {
    try {
      const saved = localStorage.getItem(TG_TARGETS_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch {
      // Fallback to default targets
    }
    return DEFAULT_TELEGRAM_TARGETS;
  });
  const [tgChatId, setTgChatId] = useState(() => {
    try {
      const savedTargets = localStorage.getItem(TG_TARGETS_STORAGE_KEY);
      if (savedTargets) {
        const parsed = JSON.parse(savedTargets);
        if (Array.isArray(parsed)) {
          return parsed
            .filter((t: TelegramTargetItem) => t.enabled)
            .map((t: TelegramTargetItem) => t.chatId)
            .join(', ');
        }
      }
    } catch {
      // Ignore
    }
    return DEFAULT_TELEGRAM_TARGETS.map((t) => t.chatId).join(', ');
  });
  const [newTgTargetInput, setNewTgTargetInput] = useState('');
  const [tgSubject, setTgSubject] = useState<string>(subjects[0]?.name || '__ALL__');
  const [tgSendMode, setTgSendMode] = useState<'batch_cards' | 'batch_polls' | 'batch_photos' | 'single_poll'>('batch_cards');
  const [tgTextStyle, setTgTextStyle] = useState<'one_by_one' | 'digest'>('one_by_one');
  const [tgPhotoShowAnswer, setTgPhotoShowAnswer] = useState<boolean>(false);
  const [tgSelectedQuestionId, setTgSelectedQuestionId] = useState<string>('');
  const [socialShareTarget, setSocialShareTarget] = useState<{ q: Question; index: number } | null>(null);
  const [socialShareDefaultMulti, setSocialShareDefaultMulti] = useState<boolean>(false);

  const adminSharePool = useMemo(
    () => (tgSubject === '__ALL__' ? questions : questions.filter((q) => q.subject === tgSubject)),
    [questions, tgSubject]
  );

  const adminBatchCandidates = useMemo<ShareBatchCandidate[]>(() => {
    return adminSharePool.map((q, idx) => {
      const candId = q.id ? `${q.id}__${idx}` : `adm_${idx}`;
      return {
        id: candId,
        label: `សំណួរទី ${toKhmerNum(idx + 1)}`,
        sublabel: q.question,
        renderImage: async ({ format, showAnswer }) =>
          renderQuestionCardImage(q, idx + 1, { showAnswer, format }),
      };
    });
  }, [adminSharePool]);

  const formatAdminBatchCaption = useCallback(
    (selectedIds: string[]) => {
      const picked = selectedIds
        .map((id) => {
          const idx = adminBatchCandidates.findIndex((c) => c.id === id);
          if (idx === -1) return null;
          const q = adminSharePool[idx];
          if (!q) return null;
          return { q, index: idx + 1 };
        })
        .filter((x): x is { q: Question; index: number } => Boolean(x));
      return formatMultiQuestionsSocialCaption(picked);
    },
    [adminBatchCandidates, adminSharePool]
  );

  const initialAdminBatchIds = useMemo(() => {
    if (!socialShareTarget || adminBatchCandidates.length === 0) return undefined;
    const targetIdx = Math.max(0, socialShareTarget.index - 1);
    const firstCand = adminBatchCandidates[targetIdx];
    const others = adminBatchCandidates.filter((_, i) => i !== targetIdx).slice(0, 3);
    return firstCand ? [firstCand.id, ...others.map((o) => o.id)] : undefined;
  }, [socialShareTarget, adminBatchCandidates]);
  const [tgSentIds, setTgSentIds] = useState<string[]>([]);
  const [isSendingTelegram, setIsSendingTelegram] = useState(false);
  const [isTestingBot, setIsTestingBot] = useState(false);
  const [tgBotInfo, setTgBotInfo] = useState<string | null>(null);
  const [telegramStatus, setTelegramStatus] = useState<{ text: string; success: boolean } | null>(null);
  const [tgProgress, setTgProgress] = useState<{ current: number; total: number; isRunning: boolean; message: string }>({
    current: 0,
    total: 0,
    isRunning: false,
    message: '',
  });
  const tgCancelRef = useRef<boolean>(false);
  const [tgLogs, setTgLogs] = useState<Array<{ id: string; time: string; text: string; success: boolean }>>([]);
  const [commandBotStatus, setCommandBotStatus] = useState<CommandBotStatus | null>(null);
  const [isUpdatingCommandBot, setIsUpdatingCommandBot] = useState(false);

  useEffect(() => {
    let active = true;
    const ensureBotStatusAndAutoStart = async () => {
      const st = await getTelegramCommandBotStatus();
      if (!active) return;
      if (st) setCommandBotStatus(st);

      const savedToken = (tgBotToken || localStorage.getItem('master_quiz_tg_token') || '').trim();
      const isPaused = localStorage.getItem('master_quiz_bot_paused') === '1';
      if (savedToken && !isPaused && (!st || !st.isRunning)) {
        try {
          const started = await startTelegramCommandBot(savedToken);
          if (active) {
            setCommandBotStatus({
              isRunning: started.isRunning,
              botUsername: started.botUsername,
              commandsRegistered: true,
              handledCount: started.handledCount || 0,
              lastCommandAt: started.lastCommandAt || null,
              lastCommandText: started.lastCommandText || null,
              lastError: null,
            });
          }
        } catch {
          // Silent on auto-resume failure; user can see error when testing or toggling manually
        }
      }
    };

    ensureBotStatusAndAutoStart();
    if (activeSubTab !== 'telegram') {
      return () => {
        active = false;
      };
    }

    const timer = setInterval(async () => {
      const st = await getTelegramCommandBotStatus();
      if (active && st) setCommandBotStatus(st);
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [activeSubTab]);

  const handleToggleCommandBot = async () => {
    setTelegramStatus(null);
    if (commandBotStatus?.isRunning) {
      setIsUpdatingCommandBot(true);
      try {
        localStorage.setItem('master_quiz_bot_paused', '1');
        await stopTelegramCommandBot();
        const st = await getTelegramCommandBotStatus();
        setCommandBotStatus(st);
        setTelegramStatus({ text: 'បានផ្អាកដំណើរការ Command Bot Auto-Reply រួចរាល់។', success: true });
      } finally {
        setIsUpdatingCommandBot(false);
      }
      return;
    }

    const cleanToken = tgBotToken.trim();
    const hasServerToken = Boolean(commandBotStatus?.hasServerToken);
    if (!cleanToken && !hasServerToken) {
      setTelegramStatus({ text: 'សូមបញ្ចូល Telegram Bot Token ជាមុនសិន!', success: false });
      return;
    }

    setIsUpdatingCommandBot(true);
    try {
      if (cleanToken) {
        localStorage.setItem('master_quiz_tg_token', cleanToken);
      }
      localStorage.removeItem('master_quiz_bot_paused');
      const res = await startTelegramCommandBot(cleanToken);
      setCommandBotStatus({
        isRunning: res.isRunning,
        botUsername: res.botUsername,
        hasServerToken: true,
        commandsRegistered: true,
        handledCount: res.handledCount || 0,
        lastCommandAt: res.lastCommandAt || null,
        lastCommandText: res.lastCommandText || null,
        lastError: null,
      });
      setTelegramStatus({
        text: `Command Bot @${res.botUsername} កំពុងដំណើរការ! អ្នកប្រើប្រាស់អាចវាយ /start ឬ /register លើ Telegram ដើម្បីទទួលការណែនាំចុះឈ្មោះភ្លាមៗ។`,
        success: true,
      });
    } catch (err: any) {
      setTelegramStatus({ text: err.message, success: false });
    } finally {
      setIsUpdatingCommandBot(false);
    }
  };

  const handleRegisterBotCommands = async () => {
    setTelegramStatus(null);
    const cleanToken = tgBotToken.trim();
    const hasServerToken = Boolean(commandBotStatus?.hasServerToken);
    if (!cleanToken && !hasServerToken) {
      setTelegramStatus({ text: 'សូមបញ្ចូល Telegram Bot Token ជាមុនសិន!', success: false });
      return;
    }
    setIsUpdatingCommandBot(true);
    try {
      if (cleanToken) {
        localStorage.setItem('master_quiz_tg_token', cleanToken);
      }
      await registerTelegramCommands(cleanToken);
      let st = await getTelegramCommandBotStatus();
      let botStarted = Boolean(st?.isRunning);
      if ((!st || !st.isRunning) && localStorage.getItem('master_quiz_bot_paused') !== '1') {
        try {
          const started = await startTelegramCommandBot(cleanToken);
          botStarted = Boolean(started.isRunning);
          st = {
            isRunning: started.isRunning,
            botUsername: started.botUsername,
            hasServerToken: true,
            commandsRegistered: true,
            handledCount: started.handledCount || 0,
            lastCommandAt: started.lastCommandAt || null,
            lastCommandText: started.lastCommandText || null,
            lastError: null,
          };
        } catch {
          // Commands are already registered directly with Telegram even without backend worker
        }
      }
      if (st) setCommandBotStatus(st);
      setTelegramStatus({
        text: botStarted
          ? 'បានចុះឈ្មោះបញ្ជី Command (/start, /register, /passcode, /payment, /contact, /help) និងបើកដំណើរការ Bot ជោគជ័យ!'
          : 'បានចុះឈ្មោះបញ្ជី Command (/start, /register, /passcode, /payment, /contact, /help) ទៅកាន់ Telegram ជោគជ័យ!',
        success: true,
      });
    } catch (err: any) {
      setTelegramStatus({ text: err.message, success: false });
    } finally {
      setIsUpdatingCommandBot(false);
    }
  };

  // Command Bot Content Editor State & Handlers
  const [editingBotCommand, setEditingBotCommand] = useState<BotCommandConfig | null>(null);
  const [isSavingBotCommand, setIsSavingBotCommand] = useState(false);
  const [botEditorStatusMsg, setBotEditorStatusMsg] = useState<{ text: string; success: boolean } | null>(null);

  const mergedBotCommands = useMemo(() => getMergedBotCommands(botCommands), [botCommands]);
  const customizedBotCommandsCount = useMemo(
    () => DEFAULT_BOT_COMMANDS.filter((c) => Boolean(botCommands[c.command])).length,
    [botCommands]
  );

  const openBotCommandEditor = (cmd: BotCommandConfig) => {
    setBotEditorStatusMsg(null);
    setEditingBotCommand({
      command: cmd.command,
      titleKh: cmd.titleKh || '',
      descriptionKh: cmd.descriptionKh || '',
      title: cmd.title || '',
      body: cmd.body || '',
      imageUrl: cmd.imageUrl || '',
      imageAlt: cmd.imageAlt || '',
      actions: (cmd.actions || []).map((a) => ({ ...a })),
    });
  };

  const handleSaveBotCommandEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingBotCommand) return;

    if (!editingBotCommand.title.trim() || !editingBotCommand.descriptionKh.trim()) {
      setBotEditorStatusMsg({
        text: 'សូមបំពេញចំណងជើងសារឆ្លើយតប និងការពិពណ៌នាខ្លីក្នុងម៉ឺនុយ Bot!',
        success: false,
      });
      return;
    }

    setIsSavingBotCommand(true);
    setBotEditorStatusMsg(null);
    try {
      const cleanImageUrl = editingBotCommand.imageUrl?.trim() || undefined;
      await saveBotCommandConfig({
        command: editingBotCommand.command,
        titleKh: editingBotCommand.titleKh.trim() || editingBotCommand.command,
        descriptionKh: editingBotCommand.descriptionKh.trim(),
        title: editingBotCommand.title.trim(),
        body: editingBotCommand.body,
        imageUrl: cleanImageUrl,
        imageAlt: cleanImageUrl ? editingBotCommand.imageAlt?.trim() || 'Command Bot Image' : undefined,
        actions: editingBotCommand.actions
          .filter((a) => a.label.trim() && a.value.trim())
          .map((a) => ({
            label: a.label.trim(),
            type: a.type,
            value: a.value.trim(),
          })),
      });

      const savedCmd = editingBotCommand.command;
      setEditingBotCommand(null);
      setBotEditorStatusMsg({
        text: `បានរក្សាទុកខ្លឹមសារ ${savedCmd} និងធ្វើបច្ចុប្បន្នភាពលើ Command Bot ក្នុងកម្មវិធី និង Telegram @qiuzs_bot ជោគជ័យ!`,
        success: true,
      });
    } catch (err: any) {
      setBotEditorStatusMsg({
        text: err?.message || 'បរាជ័យក្នុងការរក្សាទុកខ្លឹមសារ Command Bot!',
        success: false,
      });
    } finally {
      setIsSavingBotCommand(false);
    }
  };

  const handleResetSingleBotCommand = async (command: string) => {
    setIsSavingBotCommand(true);
    setBotEditorStatusMsg(null);
    try {
      await resetBotCommandConfig(command);
      setEditingBotCommand(null);
      setBotEditorStatusMsg({
        text: `បានកំណត់ខ្លឹមសារ ${command} ទៅទម្រង់លំនាំដើមវិញរួចរាល់!`,
        success: true,
      });
    } catch (err: any) {
      setBotEditorStatusMsg({
        text: err?.message || `បរាជ័យក្នុងការកំណត់លំនាំដើមសម្រាប់ ${command}!`,
        success: false,
      });
    } finally {
      setIsSavingBotCommand(false);
    }
  };

  const handleResetAllBotCommandsClick = () => {
    setDeleteConfirmDialog({
      isOpen: true,
      title: 'កំណត់ Command Bot ទាំងអស់ទៅលំនាំដើម?',
      message: 'តើអ្នកពិតជាចង់លុបការកែប្រែទាំងអស់ ហើយត្រឡប់ខ្លឹមសារ Command Bot ទាំង ៦ មកទម្រង់ដើមវិញមែនទេ?',
      subMessage: 'សកម្មភាពនេះនឹងធ្វើបច្ចុប្បន្នភាពទាំងលើ Command Bot ក្នុងកម្មវិធី និង Telegram @qiuzs_bot។',
      onConfirm: async () => {
        await resetAllBotCommands(DEFAULT_BOT_COMMANDS.map((c) => c.command));
        setBotEditorStatusMsg({
          text: 'បានកំណត់ខ្លឹមសារ Command Bot ទាំងអស់ទៅទម្រង់លំនាំដើមវិញជោគជ័យ!',
          success: true,
        });
      },
    });
  };

  // Broadcast Notification Form
  const [broadcastMsg, setBroadcastMsg] = useState('');
  const [broadcastType, setBroadcastType] = useState<'info' | 'success' | 'warning'>('info');

  // Question Edit Modal State
  const [editingQuestion, setEditingQuestion] = useState<Question | null>(null);
  const [editQuestionSubject, setEditQuestionSubject] = useState('');
  const [editQuestionText, setEditQuestionText] = useState('');
  const [editQuestionType, setEditQuestionType] = useState<QuestionType>('mcq');
  const [editQuestionOptions, setEditQuestionOptions] = useState<string[]>(['', '', '', '']);
  const [editQuestionCorrect, setEditQuestionCorrect] = useState<number>(0);
  const [editQuestionAnswer, setEditQuestionAnswer] = useState('');
  const [isSavingQuestionEdit, setIsSavingQuestionEdit] = useState(false);
  const [editQuestionError, setEditQuestionError] = useState<string | null>(null);

  // Subject Edit Modal State
  const [editingSubject, setEditingSubject] = useState<Subject | null>(null);
  const [editSubjectName, setEditSubjectName] = useState('');
  const [editSubjectType, setEditSubjectType] = useState<QuestionType>('mcq');
  const [editSubjectIsActive, setEditSubjectIsActive] = useState<boolean>(true);
  const [isSavingSubjectEdit, setIsSavingSubjectEdit] = useState(false);
  const [editSubjectError, setEditSubjectError] = useState<string | null>(null);

  // Open & save handlers for editing questions
  const handleOpenEditQuestionModal = (q: Question) => {
    setEditQuestionError(null);
    setEditingQuestion(q);
    setEditQuestionSubject(q.subject || subjects[0]?.name || '');
    setEditQuestionText(q.question || '');
    setEditQuestionType(q.type || 'mcq');
    setEditQuestionOptions(
      q.options && q.options.length === 4
        ? [...q.options]
        : ['ក. ', 'ខ. ', 'គ. ', 'ឃ. ']
    );
    setEditQuestionCorrect(q.correct ?? 0);
    setEditQuestionAnswer(q.answer || '');
  };

  const handleSaveQuestionEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingQuestion || !editingQuestion.id || isSavingQuestionEdit) return;
    if (!editQuestionText.trim()) return;

    const updates: Partial<Question> = {
      subject: editQuestionSubject,
      question: editQuestionText.trim(),
      type: editQuestionType,
      options: editQuestionType === 'mcq' ? editQuestionOptions.map((o) => o.trim()) : undefined,
      correct: editQuestionType === 'mcq' ? editQuestionCorrect : undefined,
      answer: editQuestionAnswer.trim() || undefined,
    };

    setIsSavingQuestionEdit(true);
    setEditQuestionError(null);
    try {
      await updateQuestion(editingQuestion.id, updates);
      setEditingQuestion(null);
    } catch (err: any) {
      setEditQuestionError(err?.message || 'បរាជ័យក្នុងការរក្សាទុកការកែប្រែសំណួរ!');
    } finally {
      setIsSavingQuestionEdit(false);
    }
  };

  // Open & save handlers for editing subjects
  const handleOpenEditSubjectModal = (sub: Subject) => {
    setEditSubjectError(null);
    setEditingSubject(sub);
    setEditSubjectName(sub.name);
    setEditSubjectType(sub.type);
    setEditSubjectIsActive(sub.isActive !== false);
  };

  const handleSaveSubjectEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingSubject || !editingSubject.id || isSavingSubjectEdit) return;
    const newName = editSubjectName.trim();
    if (!newName) return;

    const oldName = editingSubject.name;
    setIsSavingSubjectEdit(true);
    setEditSubjectError(null);
    try {
      await updateSubject(editingSubject.id, {
        name: newName,
        type: editSubjectType,
        isActive: editSubjectIsActive,
      });

      if (oldName !== newName) {
        const matchingQuestions = questions.filter((q) => q.subject === oldName);
        if (matchingQuestions.length > 0) {
          await renameQuestionsSubject(oldName, newName, matchingQuestions);
        }
      }

      setEditingSubject(null);
    } catch (err: any) {
      setEditSubjectError(err?.message || 'បរាជ័យក្នុងការរក្សាទុកការកែប្រែមុខវិជ្ជា!');
    } finally {
      setIsSavingSubjectEdit(false);
    }
  };

  const handleToggleSubjectActive = async (sub: Subject) => {
    if (!sub.id) return;
    setSubjectOrderStatusMsg(null);
    try {
      const nextActive = sub.isActive === false;
      await updateSubject(sub.id, { isActive: nextActive });
      setSubjectOrderStatusMsg({
        text: nextActive
          ? `បានបើកដំណើរការមុខវិជ្ជា "${sub.name}" ជោគជ័យ!`
          : `បានបិទមុខវិជ្ជា "${sub.name}" ជាបណ្ដោះអាសន្ន!`,
        success: true,
      });
    } catch (err: any) {
      setSubjectOrderStatusMsg({
        text: err?.message || `បរាជ័យក្នុងការកែប្រែស្ថានភាពមុខវិជ្ជា "${sub.name}"!`,
        success: false,
      });
    }
  };

  // In-App Confirmation Dialog State (avoids iframe window.confirm blocking)
  const [deleteConfirmDialog, setDeleteConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    subMessage?: string;
    onConfirm: () => Promise<void> | void;
  } | null>(null);
  const [isConfirmDeleting, setIsConfirmDeleting] = useState(false);
  const [deleteConfirmError, setDeleteConfirmError] = useState<string | null>(null);

  const handleDeleteSubjectClick = (sub: Subject) => {
    const matchingQuestions = questions.filter((q) => q.subject === sub.name);
    const countStr = matchingQuestions.length > 0 ? ` ព្រមទាំងសំណួរទាំងអស់ចំនួន ${toKhmerNum(matchingQuestions.length)} សំណួរ` : '';
    setDeleteConfirmDialog({
      isOpen: true,
      title: `លុបមុខវិជ្ជា "${sub.name}"`,
      message: `តើអ្នកពិតជាចង់លុបមុខវិជ្ជា "${sub.name}"${countStr} មែនទេ?`,
      subMessage: 'ការលុបនេះនឹងលុបចេញពីប្រព័ន្ធទាំងស្រុង (ទាំង Firebase និង Supabase) និងមិនអាចត្រឡប់វិញបានទេ។',
      onConfirm: async () => {
        const matchingIds = matchingQuestions.map((q) => q.id).filter(Boolean) as string[];
        if (matchingIds.length > 0) {
          await deleteQuestionsBatch(matchingIds);
        }
        await deleteSubject(sub.id);
        if (selectedSubjectToManage === sub.name) {
          const remaining = subjects.filter((s) => s.id !== sub.id);
          setSelectedSubjectToManage(remaining[0]?.name || '');
        }
        setEditingSubject(null);
      },
    });
  };

  const handleDeleteQuestionClick = (q: Question) => {
    if (!q.id) return;
    setDeleteConfirmDialog({
      isOpen: true,
      title: 'លុបសំណួរ',
      message: 'តើអ្នកពិតជាចង់លុបសំណួរនេះចេញពីប្រព័ន្ធមែនទេ?',
      subMessage: q.question.length > 120 ? q.question.slice(0, 117) + '...' : q.question,
      onConfirm: async () => {
        if (q.id) {
          await deleteQuestion(q.id);
        }
        setEditingQuestion(null);
      },
    });
  };

  const handleDeleteAllQuestionsInSubject = (subjectName: string) => {
    const filtered = questions.filter((q) => q.subject === subjectName);
    if (filtered.length === 0) return;
    setDeleteConfirmDialog({
      isOpen: true,
      title: `លុបសំណួរទាំងអស់ក្នុងមុខវិជ្ជា "${subjectName}"`,
      message: `តើអ្នកពិតជាចង់លុបសំណួរទាំង ${toKhmerNum(filtered.length)} សំណួរ មែនទេ?`,
      subMessage: 'រាល់សំណួរ និងចម្លើយទាំងអស់ក្នុងមុខវិជ្ជានេះនឹងត្រូវបានលុបចេញពីប្រព័ន្ធ (ទាំង Firebase និង Supabase)។',
      onConfirm: async () => {
        const ids = filtered.map((q) => q.id).filter(Boolean) as string[];
        if (ids.length > 0) {
          await deleteQuestionsBatch(ids);
        }
      },
    });
  };

  // Handle Single Entry Submit
  const handleSaveSingleQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    setSingleStatusMsg(null);

    const finalSubject = (newSubjectName.trim() ? newSubjectName.trim() : singleSubject).trim();
    if (!finalSubject) {
      setSingleStatusMsg({ text: 'សូមជ្រើសរើស ឬបញ្ចូលឈ្មោះមុខវិជ្ជា!', success: false });
      return;
    }

    if (!singleQuestionText.trim()) {
      setSingleStatusMsg({ text: 'សូមបញ្ចូលអត្ថបទសំណួរ!', success: false });
      return;
    }

    try {
      // Check if new subject needs to be added
      if (newSubjectName.trim() && !subjects.some((s) => s.name.toLowerCase() === newSubjectName.trim().toLowerCase())) {
        await addSubject({
          name: newSubjectName.trim(),
          type: singleType,
          isActive: true,
          order: getNextSubjectOrder(),
        });
      }

      await addQuestion({
        subject: finalSubject,
        question: singleQuestionText.trim(),
        type: singleType,
        options: singleType === 'mcq' ? singleOptions.map((o) => o.trim()) : undefined,
        correct: singleType === 'mcq' ? singleCorrect : undefined,
        answer: singleType !== 'mcq' ? singleAnswer.trim() : singleOptions[singleCorrect],
        isActive: true,
        order: questions.filter((q) => q.subject === finalSubject).length + 1,
      });

      setSingleStatusMsg({ text: 'បានបញ្ចូលសំណួរថ្មីជោគជ័យ!', success: true });
      setSingleQuestionText('');
      setSingleAnswer('');
      setSingleOptions(['ក. ', 'ខ. ', 'គ. ', 'ឃ. ']);
      setNewSubjectName('');
    } catch (err: any) {
      setSingleStatusMsg({ text: err.message || 'បរាជ័យក្នុងការបញ្ចូលសំណួរ', success: false });
    }
  };

  // Delete single preview question
  const handleRemovePreviewItem = (index: number) => {
    setGeneratedPreview((prev) => prev.filter((_, idx) => idx !== index));
  };

  // Save Bulk Questions to Firestore (supports both single-subject Text import & multi-subject Export JSON import)
  const handleSaveGeneratedQuestions = async () => {
    if (generatedPreview.length === 0 || isSavingBulkQuestions) return;
    setIsSavingBulkQuestions(true);
    setBulkStatusMsg(null);
    try {
      const fallbackSubject = (newBulkSubjectName.trim() || bulkSubject || (subjects[0]?.name ?? 'ចំណេះដឹងទូទៅ')).trim();
      const normalizedQuestions: Omit<Question, 'id'>[] = [];
      const countOffsetBySubject: Record<string, number> = {};
      const existingSubjectMap = new Map<string, string>();
      for (const s of subjects) {
        existingSubjectMap.set(s.name.trim().toLowerCase(), s.name);
      }

      let nextSubjectOrder = getNextSubjectOrder();
      let createdSubjectsCount = 0;

      // Ensure all referenced subjects exist in Firestore first
      for (const q of generatedPreview) {
        const rawSub = (q.subject || fallbackSubject).trim() || fallbackSubject;
        const lowerKey = rawSub.toLowerCase();
        if (!existingSubjectMap.has(lowerKey)) {
          const meta = parsedSubjectMetaMap[rawSub];
          await addSubject({
            name: rawSub,
            type: meta?.type || q.type || 'mcq',
            isActive: meta?.isActive ?? true,
            order: nextSubjectOrder++,
          });
          existingSubjectMap.set(lowerKey, rawSub);
          createdSubjectsCount++;
        }
      }

      for (const q of generatedPreview) {
        const rawSub = (q.subject || fallbackSubject).trim() || fallbackSubject;
        const canonicalSubject = existingSubjectMap.get(rawSub.toLowerCase()) || rawSub;

        if (countOffsetBySubject[canonicalSubject] === undefined) {
          countOffsetBySubject[canonicalSubject] = questions.filter((item) => item.subject === canonicalSubject).length;
        }
        countOffsetBySubject[canonicalSubject] += 1;

        normalizedQuestions.push({
          ...q,
          subject: canonicalSubject,
          order: countOffsetBySubject[canonicalSubject],
        });
      }

      await addQuestionsBatch(normalizedQuestions);

      const touchedSubjectsCount = Object.keys(countOffsetBySubject).length;
      const subjectSummary =
        touchedSubjectsCount === 1
          ? `ទៅក្នុងមុខវិជ្ជា "${Object.keys(countOffsetBySubject)[0]}"`
          : `ទៅក្នុង ${toKhmerNum(touchedSubjectsCount)} មុខវិជ្ជា`;
      const newSubNote =
        createdSubjectsCount > 0 ? ` (និងបង្កើតមុខវិជ្ជាថ្មី ${toKhmerNum(createdSubjectsCount)})` : '';

      setBulkStatusMsg({
        text: `បានរក្សាទុក ${toKhmerNum(normalizedQuestions.length)} សំណួរ${subjectSummary}${newSubNote} ជោគជ័យ!`,
        success: true,
      });
      setGeneratedPreview([]);
      setParsedSubjectMetaMap({});
      setBulkText('');
      setBulkJsonText('');
      setNewBulkSubjectName('');
    } catch (err: any) {
      setBulkStatusMsg({ text: err.message || 'បរាជ័យក្នុងការរក្សាទុកសំណួរ', success: false });
    } finally {
      setIsSavingBulkQuestions(false);
    }
  };

  // Parse JSON Import
  const handleParseJsonImport = (rawOverride?: string) => {
    setBulkStatusMsg(null);
    const sourceText = rawOverride ?? bulkJsonText;
    const fallbackSubject = (newBulkSubjectName.trim() || bulkSubject || (subjects[0]?.name ?? 'ចំណេះដឹងទូទៅ')).trim();
    const overrideSub =
      jsonOverrideSubject || Boolean(newBulkSubjectName.trim())
        ? fallbackSubject
        : undefined;

    try {
      const result = parseQuestionsJsonInput(sourceText, {
        fallbackSubject,
        overrideSubject: overrideSub,
        forcedType: bulkImportType,
      });

      if (result.questions.length === 0) {
        setGeneratedPreview([]);
        setBulkStatusMsg({
          text: 'រកមិនឃើញសំណួរត្រឹមត្រូវនៅក្នុងទិន្នន័យ JSON នេះទេ! សូមពិនិត្យទម្រង់ម្ដងទៀត។',
          success: false,
        });
        return;
      }

      setGeneratedPreview(result.questions);
      setParsedSubjectMetaMap(result.subjectMetaMap);
      const uniqueSubjects = Array.from(new Set(result.questions.map((q) => q.subject)));
      const skippedText =
        result.skippedCount > 0 ? ` (រំលងទិន្នន័យមិនពេញលេញ ${toKhmerNum(result.skippedCount)})` : '';
      setBulkStatusMsg({
        text: `បានបំប្លែង ${toKhmerNum(result.questions.length)} សំណួរពី JSON សម្រាប់ ${toKhmerNum(uniqueSubjects.length)} មុខវិជ្ជា${skippedText} រួចរាល់! សូមពិនិត្យ និងចុចរក្សាទុក។`,
        success: true,
      });
    } catch (err: any) {
      setGeneratedPreview([]);
      setBulkStatusMsg({
        text: err?.message || 'ទម្រង់ JSON មិនត្រឹមត្រូវ!',
        success: false,
      });
    }
  };

  const handleJsonFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const content = await file.text();
      setBulkInputMode('json');
      setBulkJsonText(content);
      handleParseJsonImport(content);
    } catch {
      setBulkStatusMsg({ text: 'មិនអាចអានឯកសារ JSON នេះបានទេ!', success: false });
    }
  };

  const handleExportJsonFromBulk = (scope: 'selected' | 'all') => {
    setBulkStatusMsg(null);
    const targetSubject = bulkSubject || subjects[0]?.name || '';
    const targetList =
      scope === 'all'
        ? questions
        : questions.filter((q) => q.subject === targetSubject);

    if (targetList.length === 0) {
      setBulkStatusMsg({
        text:
          scope === 'all'
            ? 'មិនទាន់មានសំណួរនៅក្នុងប្រព័ន្ធសម្រាប់ Export JSON នៅឡើយទេ!'
            : `មិនទាន់មានសំណួរនៅក្នុងមុខវិជ្ជា "${targetSubject}" សម្រាប់ Export JSON ទេ!`,
        success: false,
      });
      return;
    }

    const payload = buildExportJsonPayload(targetList, subjects, {
      subjectLabel: scope === 'all' ? '__ALL__' : targetSubject,
    });
    const filename =
      scope === 'all'
        ? 'Master_Quiz_KH_All_Questions.json'
        : `${targetSubject}_MasterQuiz.json`;
    downloadJsonFile(payload, filename);
    setBulkStatusMsg({
      text: `បាន Export ឯកសារ JSON (${toKhmerNum(targetList.length)} សំណួរ) ជោគជ័យ!`,
      success: true,
    });
  };

  // Parse Bulk Text Import
  const handleParseBulkText = async () => {
    if (!bulkText.trim()) return;

    const assignedSubject = (newBulkSubjectName.trim() || bulkSubject || (subjects[0]?.name ?? 'ចំណេះដឹងទូទៅ')).trim();
    const parsed: Question[] = [];

    // Split text into blocks by double newlines or question numbering (1. / ១. / សំណួរទី... / Q1:)
    const rawBlocks = bulkText.split(/\n\s*\n|\n(?=[0-9០-៩]+[\.\)])|\n(?=(?:សំណួរ|សំណួរទី|Question|Q)\s*[0-9០-៩]+[\:\.\)])/i);

    for (const rawBlock of rawBlocks) {
      const block = rawBlock.trim();
      if (!block) continue;

      const lines = block
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      if (lines.length === 0) continue;

      // Extract question text from first line
      const firstLine = lines[0];
      const qLine = firstLine
        .replace(/^(?:សំណួរទី|សំណួរ|Question|Q)?\s*[0-9០-៩]+[\.\)\:\-]*\s*/i, '')
        .trim();

      const options: string[] = [];
      let correct = 0;
      let answer = '';
      let foundCorrectInOptions = false;

      // Check remaining lines
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];

        // Check if line is an Option: ក., ខ., គ., ឃ. or A., B., C., D. or (ក), (A)
        const isOpt = /^(\(?[A-Da-dក-ឃ]\)?[\.\)]|\([A-Da-dក-ឃ]\))\s*/.test(line);

        if (isOpt && bulkImportType !== 'short' && bulkImportType !== 'explanation') {
          // Check if option contains correct indicator
          const isCorrectOption = /\((ចម្លើយត្រឹមត្រូវ|ចម្លើយត្រូវ|ចម្លើយត្រូវពិតប្រាកដ|ត្រូវ|ត្រឹមត្រូវ|correct|Correct)\)|\*$/i.test(line);

          // Clean out the indicator
          const cleanedOption = line
            .replace(/\s*\((ចម្លើយត្រឹមត្រូវ|ចម្លើយត្រូវ|ចម្លើយត្រូវពិតប្រាកដ|ត្រូវ|ត្រឹមត្រូវ|correct|Correct)\)/gi, '')
            .replace(/\s*\*$/, '')
            .trim();

          if (isCorrectOption) {
            correct = options.length;
            foundCorrectInOptions = true;
          }

          options.push(cleanedOption);
        } else if (/^(?:ចម្លើយ|ចម្លើយត្រឹមត្រូវ|ans|answer|យោង|សម្គាល់|បកស្រាយ)[\:\s\=\-]/i.test(line)) {
          const ansContent = line.replace(/^(?:ចម្លើយ|ចម្លើយត្រឹមត្រូវ|ans|answer|យោង|សម្គាល់|បកស្រាយ)[\:\s\=\-]*/i, '').trim();

          if (options.length > 0 && !foundCorrectInOptions) {
            const upper = ansContent.toUpperCase();
            if (upper.startsWith('A') || upper.startsWith('ក')) correct = 0;
            else if (upper.startsWith('B') || upper.startsWith('ខ')) correct = 1;
            else if (upper.startsWith('C') || upper.startsWith('គ')) correct = 2;
            else if (upper.startsWith('D') || upper.startsWith('ឃ')) correct = 3;
          }

          if (answer) {
            answer += '\n' + line;
          } else {
            answer = line;
          }
        } else {
          // Additional descriptive line
          if (answer) {
            answer += '\n' + line;
          } else if (options.length === 0) {
            answer = line;
          }
        }
      }

      // Determine type
      let resolvedType: QuestionType = 'mcq';
      if (bulkImportType === 'explanation') {
        resolvedType = 'explanation';
      } else if (bulkImportType === 'short') {
        resolvedType = 'short';
      } else if (bulkImportType === 'mcq') {
        resolvedType = 'mcq';
      } else {
        // 'auto' mode
        if (options.length >= 2) {
          resolvedType = 'mcq';
        } else {
          resolvedType = 'short';
        }
      }

      if (resolvedType === 'mcq' && options.length >= 2) {
        // Pad to 4 options if user gave 2 or 3
        while (options.length < 4) {
          const labels = ['ក', 'ខ', 'គ', 'ឃ'];
          options.push(`${labels[options.length]}. (មិនមាន)`);
        }

        parsed.push({
          subject: assignedSubject,
          question: qLine || firstLine,
          type: 'mcq',
          options,
          correct,
          answer: answer.trim() || undefined,
          isActive: true,
        });
      } else if (qLine || firstLine) {
        const finalAnswer = answer.trim() || lines.slice(1).join('\n').trim() || '(មិនមានចម្លើយបកស្រាយ)';
        parsed.push({
          subject: assignedSubject,
          question: qLine || firstLine,
          type: resolvedType === 'explanation' ? 'explanation' : 'short',
          answer: finalAnswer,
          isActive: true,
        });
      }
    }

    if (parsed.length > 0) {
      setGeneratedPreview(parsed);
      setBulkStatusMsg({
        text: `បានស្រង់ចេញ ${toKhmerNum(parsed.length)} សំណួរជោគជ័យសម្រាប់មុខវិជ្ជា "${assignedSubject}"! សូមពិនិត្យផ្ទៀងផ្ទាត់ និងចុចរក្សាទុក`,
        success: true,
      });
    } else {
      setBulkStatusMsg({
        text: 'មិនអាចស្វែងរកទម្រង់សំណួរត្រឹមត្រូវទេ។ សូមពិនិត្យអត្ថបទ ឬជ្រើសរើសប្រភេទសំណួរឱ្យត្រូវ!',
        success: false,
      });
    }
  };

  const [swapStatusMsg, setSwapStatusMsg] = useState<{ text: string; success: boolean } | null>(null);

  // Move or Swap Subjects
  const handleMoveSubjectStep = async (fromIdx: number, toIdx: number) => {
    if (isReorderingSubjects) return;
    if (fromIdx < 0 || fromIdx >= subjects.length || toIdx < 0 || toIdx >= subjects.length || fromIdx === toIdx) {
      return;
    }
    const targetSub = subjects[fromIdx];
    setIsReorderingSubjects(true);
    setSubjectOrderStatusMsg(null);
    try {
      await moveSubject(subjects, fromIdx, toIdx);
      setSubjectOrderStatusMsg({
        text: `បានផ្លាស់ប្ដូរទីតាំងមុខវិជ្ជា "${targetSub.name}" ទៅលេខរៀងទី ${toKhmerNum(toIdx + 1)} ជោគជ័យ!`,
        success: true,
      });
    } catch {
      setSubjectOrderStatusMsg({
        text: 'បរាជ័យក្នុងការផ្លាស់ប្ដូរទីតាំងមុខវិជ្ជា!',
        success: false,
      });
    } finally {
      setIsReorderingSubjects(false);
    }
  };

  const handleMoveSubjectByToolbar = async () => {
    const fromIdx = subjectSwapFrom - 1;
    const toIdx = subjectSwapTo - 1;
    if (!subjects[fromIdx] || !subjects[toIdx] || fromIdx === toIdx) {
      setSubjectOrderStatusMsg({ text: 'សូមជ្រើសរើសលេខរៀងទីតាំងដែលខុសគ្នា!', success: false });
      return;
    }
    await handleMoveSubjectStep(fromIdx, toIdx);
  };

  const handleSwapSubjectsByToolbar = async () => {
    if (isReorderingSubjects) return;
    const fromIdx = subjectSwapFrom - 1;
    const toIdx = subjectSwapTo - 1;
    const sub1 = subjects[fromIdx];
    const sub2 = subjects[toIdx];
    if (!sub1 || !sub2 || fromIdx === toIdx) {
      setSubjectOrderStatusMsg({ text: 'សូមជ្រើសរើសមុខវិជ្ជាពីរផ្សេងគ្នាដើម្បីដោះដូរទីតាំង!', success: false });
      return;
    }
    setIsReorderingSubjects(true);
    setSubjectOrderStatusMsg(null);
    try {
      await swapSubjects(subjects, fromIdx, toIdx);
      setSubjectOrderStatusMsg({
        text: `បានដោះដូរទីតាំងរវាង "${sub1.name}" (លេខ ${toKhmerNum(subjectSwapFrom)}) និង "${sub2.name}" (លេខ ${toKhmerNum(subjectSwapTo)}) ជោគជ័យ!`,
        success: true,
      });
    } catch {
      setSubjectOrderStatusMsg({
        text: 'បរាជ័យក្នុងការដោះដូរទីតាំងមុខវិជ្ជា!',
        success: false,
      });
    } finally {
      setIsReorderingSubjects(false);
    }
  };

  const handleSubjectDrop = async (dropIdx: number) => {
    const fromIdx = draggedSubjectIndex;
    setDraggedSubjectIndex(null);
    setDragOverSubjectIndex(null);
    if (fromIdx === null || fromIdx === dropIdx) return;
    await handleMoveSubjectStep(fromIdx, dropIdx);
  };

  // Swap Questions
  const handleSwapQuestions = async () => {
    setSwapStatusMsg(null);
    const list = questions.filter((q) => q.subject === selectedSubjectToManage);
    const q1 = list[swapFromIndex - 1];
    const q2 = list[swapToIndex - 1];

    if (!q1 || !q2) {
      setSwapStatusMsg({ text: 'សូមជ្រើសរើសលេខរៀងសំណួរដែលត្រឹមត្រូវ!', success: false });
      return;
    }

    await swapQuestions(q1, q2);
    setSwapStatusMsg({
      text: `បានដោះដូរទីតាំងរវាងសំណួរលេខ ${toKhmerNum(swapFromIndex)} និង ${toKhmerNum(swapToIndex)} ជោគជ័យ!`,
      success: true,
    });
  };

  // Cancel Telegram Batch
  const handleCancelTelegramBatch = () => {
    tgCancelRef.current = true;
    setTgProgress((prev) => ({ ...prev, message: 'កំពុងស្នើសុំផ្អាកការផ្ញើ...' }));
  };

  // Test Telegram Bot Connection & auto-activate Command Bot
  const handleTestTelegramConnection = async () => {
    const cleanToken = tgBotToken.trim();
    const hasServerToken = Boolean(commandBotStatus?.hasServerToken);
    if (!cleanToken && !hasServerToken) {
      setTelegramStatus({ text: 'សូមបញ្ចូល Telegram Bot Token ជាមុនសិន!', success: false });
      return;
    }
    setIsTestingBot(true);
    setTelegramStatus(null);
    try {
      const bot = await testTelegramBot(cleanToken);
      const botName = `@${bot.username} (${bot.first_name || 'Bot'})`;
      setTgBotInfo(botName);
      if (cleanToken) {
        localStorage.setItem('master_quiz_tg_token', cleanToken);
      }

      if (localStorage.getItem('master_quiz_bot_paused') !== '1') {
        try {
          const res = await startTelegramCommandBot(cleanToken);
          setCommandBotStatus({
            isRunning: res.isRunning,
            botUsername: res.botUsername,
            hasServerToken: true,
            commandsRegistered: true,
            handledCount: res.handledCount || 0,
            lastCommandAt: res.lastCommandAt || null,
            lastCommandText: res.lastCommandText || null,
            lastError: null,
          });
          setTelegramStatus({
            text: `តភ្ជាប់ជោគជ័យទៅកាន់ Bot៖ ${botName} — Command Bot Auto-Reply កំពុងដំណើរការ!`,
            success: true,
          });
          return;
        } catch {
          // Connection still succeeded; fall through to standard success message
        }
      }

      setTelegramStatus({
        text: `តភ្ជាប់ជោគជ័យទៅកាន់ Bot៖ ${botName}`,
        success: true,
      });
    } catch (err: any) {
      setTelegramStatus({ text: err.message || 'បរាជ័យក្នុងការតភ្ជាប់ទៅកាន់ Bot', success: false });
    } finally {
      setIsTestingBot(false);
    }
  };

  const persistTgTargets = (nextTargets: TelegramTargetItem[], syncInput = true) => {
    setTgTargets(nextTargets);
    try {
      localStorage.setItem(TG_TARGETS_STORAGE_KEY, JSON.stringify(nextTargets));
    } catch {
      // Ignore storage error
    }
    if (syncInput) {
      const joined = nextTargets
        .filter((t) => t.enabled)
        .map((t) => t.chatId)
        .join(', ');
      setTgChatId(joined);
      localStorage.setItem('master_quiz_tg_chat', joined);
    }
  };

  const handleToggleTgTarget = (id: string) => {
    const next = tgTargets.map((t) => (t.id === id ? { ...t, enabled: !t.enabled } : t));
    persistTgTargets(next, true);
  };

  const handleAddTgTarget = () => {
    const raw = newTgTargetInput.trim();
    if (!raw) return;
    const parsedIds = parseTelegramChatIds(raw);
    if (parsedIds.length === 0) return;
    let next = [...tgTargets];
    for (const chatId of parsedIds) {
      const exists = next.some((t) => t.chatId.toLowerCase() === chatId.toLowerCase());
      if (exists) {
        next = next.map((t) =>
          t.chatId.toLowerCase() === chatId.toLowerCase() ? { ...t, enabled: true } : t
        );
      } else {
        next.push({
          id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          chatId,
          label: raw.includes('t.me/') && parsedIds.length === 1 ? raw : chatId,
          enabled: true,
        });
      }
    }
    persistTgTargets(next, true);
    setNewTgTargetInput('');
  };

  const handleRemoveTgTarget = (id: string) => {
    const next = tgTargets.filter((t) => t.id !== id);
    persistTgTargets(next, true);
  };

  const resolveActiveTelegramTargets = (): string[] => {
    const fromInput = parseTelegramChatIds(tgChatId);
    if (fromInput.length > 0) return fromInput;
    return tgTargets
      .filter((t) => t.enabled)
      .map((t) => normalizeTelegramChatId(t.chatId))
      .filter(Boolean);
  };

  // Send Questions & Answers in One Batch by Subject (supports multiple Telegram destinations)
  const handleSendTelegramBatchBySubject = async () => {
    const hasToken = Boolean(tgBotToken.trim() || commandBotStatus?.hasServerToken);
    const activeTargets = resolveActiveTelegramTargets();
    if (!hasToken || activeTargets.length === 0) {
      setTelegramStatus({
        text: 'សូមបញ្ចូល Telegram Bot Token និងជ្រើសរើសគោលដៅ Telegram យ៉ាងតិច ១!',
        success: false,
      });
      return;
    }

    const targetSubject = tgSubject || (subjects[0]?.name || '__ALL__');
    const subjectQuestions = targetSubject === '__ALL__'
      ? [...questions]
      : questions.filter((q) => q.subject === targetSubject);

    if (subjectQuestions.length === 0) {
      setTelegramStatus({
        text: `មិនមានសំណួរក្នុងមុខវិជ្ជា «${targetSubject === '__ALL__' ? 'ទាំងអស់' : targetSubject}» នេះទេ!`,
        success: false,
      });
      return;
    }

    localStorage.setItem('master_quiz_tg_token', tgBotToken.trim());
    localStorage.setItem('master_quiz_tg_chat', tgChatId.trim());

    setIsSendingTelegram(true);
    tgCancelRef.current = false;
    setTelegramStatus(null);
    setTgLogs([]);

    const addLog = (text: string, success: boolean) => {
      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
      setTgLogs((prev) => [{ id: Math.random().toString(), time: timeStr, text, success }, ...prev].slice(0, 150));
    };

    try {
      if (tgSendMode === 'batch_cards' && tgTextStyle === 'digest') {
        // Mode 1B: App Banner Cover + Combined Q&A Text digest messages with hidden Spoiler answers
        const subjectDisplay = targetSubject === '__ALL__' ? 'គ្រប់មុខវិជ្ជាទាំងអស់' : targetSubject;
        const chunks = formatSubjectDigestMessages(subjectDisplay, subjectQuestions);
        const totalSteps = chunks.length * activeTargets.length;

        setTgProgress({
          current: 0,
          total: totalSteps,
          isRunning: true,
          message: `កំពុងរៀបចំផ្ញើកម្រងវិញ្ញាសាទៅ ${toKhmerNum(activeTargets.length)} គោលដៅ...`,
        });

        let coverBanner = '';
        try {
          coverBanner = await renderAppBannerImage(subjectDisplay);
        } catch {
          coverBanner = '';
        }

        let sentOps = 0;
        let stepDone = 0;
        for (let tIdx = 0; tIdx < activeTargets.length; tIdx++) {
          if (tgCancelRef.current) break;
          const dest = activeTargets[tIdx];

          if (coverBanner) {
            try {
              await sendTelegramPhoto(
                tgBotToken.trim(),
                dest,
                coverBanner,
                `🏛️ <b>កម្រងវិញ្ញាសា៖ ${escapeTgHtml(subjectDisplay)}</b> (${toKhmerNum(subjectQuestions.length)} សំណួរ)\n👉 <i>ចម្លើយត្រឹមត្រូវត្រូវបានលាក់ (ចុចដើម្បីមើល)</i>`,
                'HTML'
              );
              await sleep(600);
            } catch {
              // Proceed with digest text even if cover fails
            }
          }

          for (let i = 0; i < chunks.length; i++) {
            if (tgCancelRef.current) {
              addLog(`ផ្អាកការផ្ញើនៅ [${dest}] សារទី ${toKhmerNum(i + 1)}`, false);
              break;
            }

            stepDone++;
            setTgProgress({
              current: stepDone,
              total: totalSteps,
              isRunning: true,
              message: `[${dest}] កំពុងផ្ញើសារទី ${toKhmerNum(i + 1)} / ${toKhmerNum(chunks.length)}...`,
            });

            try {
              await sendTelegramMessage(tgBotToken.trim(), dest, chunks[i], 'HTML');
              sentOps++;
              addLog(`[${dest}] សារទី ${toKhmerNum(i + 1)}/${toKhmerNum(chunks.length)} ✓`, true);
            } catch (destErr: any) {
              addLog(`[${dest}] បរាជ័យសារទី ${toKhmerNum(i + 1)}: ${destErr.message}`, false);
            }

            if (i < chunks.length - 1 || tIdx < activeTargets.length - 1) {
              await sleep(800);
            }
          }
        }

        setTelegramStatus({
          text: tgCancelRef.current
            ? `បានផ្អាកការផ្ញើ (ផ្ញើបាន ${toKhmerNum(sentOps)}/${toKhmerNum(totalSteps)})`
            : `បានផ្ញើកម្រងវិញ្ញាសា «${subjectDisplay}» ទៅកាន់ ${toKhmerNum(activeTargets.length)} គោលដៅ (${toKhmerNum(sentOps)}/${toKhmerNum(totalSteps)} សារជោគជ័យ)!`,
          success: sentOps > 0,
        });
      } else if (tgSendMode === 'batch_polls') {
        // Mode 2: One-by-One Interactive Quiz Polls for MCQs across selected targets
        const mcqs = subjectQuestions.filter((q) => q.type === 'mcq' && q.options && q.options.length >= 2);
        if (mcqs.length === 0) {
          throw new Error(`មិនមានសំណួរប្រភេទ QCM (ពហុជ្រើសរើស) ក្នុងមុខវិជ្ជានេះដើម្បីបង្កើត Quiz Poll ទេ!`);
        }

        const totalOps = mcqs.length * activeTargets.length;
        setTgProgress({
          current: 0,
          total: totalOps,
          isRunning: true,
          message: `កំពុងបាញ់ Quiz Polls ទៅ ${toKhmerNum(activeTargets.length)} គោលដៅ...`,
        });

        let successCount = 0;
        let stepDone = 0;
        for (let i = 0; i < mcqs.length; i++) {
          if (tgCancelRef.current) {
            addLog(`ផ្អាកការបាញ់ Polls នៅសំណួរទី ${toKhmerNum(i + 1)}`, false);
            break;
          }

          const q = mcqs[i];
          for (let tIdx = 0; tIdx < activeTargets.length; tIdx++) {
            if (tgCancelRef.current) break;
            const dest = activeTargets[tIdx];
            stepDone++;
            setTgProgress({
              current: stepDone,
              total: totalOps,
              isRunning: true,
              message: `Poll ទី ${toKhmerNum(i + 1)}/${toKhmerNum(mcqs.length)} → ${dest}...`,
            });

            try {
              await sendTelegramPoll(tgBotToken.trim(), dest, q);
              successCount++;
              addLog(`[${dest}] Poll ទី ${toKhmerNum(i + 1)}: ${q.question.slice(0, 30)}...`, true);
            } catch (itemErr: any) {
              addLog(`[${dest}] បរាជ័យ Poll ទី ${toKhmerNum(i + 1)}: ${itemErr.message}`, false);
            }

            if (tIdx < activeTargets.length - 1) {
              await sleep(350);
            }
          }

          if (i < mcqs.length - 1) {
            await sleep(1400);
          }
        }

        setTelegramStatus({
          text: tgCancelRef.current
            ? `បានផ្អាកការផ្ញើ (បាញ់បាន ${toKhmerNum(successCount)}/${toKhmerNum(totalOps)} Quiz Polls)`
            : `បានបាញ់ Quiz Polls ចំនួន ${toKhmerNum(successCount)}/${toKhmerNum(totalOps)} ទៅកាន់ ${toKhmerNum(activeTargets.length)} គោលដៅរួចរាល់!`,
          success: successCount > 0,
        });
      } else if (tgSendMode === 'batch_photos') {
        // Mode 3: Send Every Question as a Styled Khmer Image Card across selected targets
        const totalOps = subjectQuestions.length * activeTargets.length;
        setTgProgress({
          current: 0,
          total: totalOps,
          isRunning: true,
          message: `កំពុងបង្កើត & ផ្ញើរូបភាពសំណួរទៅ ${toKhmerNum(activeTargets.length)} គោលដៅ...`,
        });

        let successCount = 0;
        let stepDone = 0;
        for (let i = 0; i < subjectQuestions.length; i++) {
          if (tgCancelRef.current) {
            addLog(`ផ្អាកការផ្ញើរូបភាពនៅសំណួរទី ${toKhmerNum(i + 1)}`, false);
            break;
          }

          const q = subjectQuestions[i];
          let photoBase64 = '';
          let caption = '';
          try {
            photoBase64 = await renderQuestionCardImage(q, i + 1, {
              showAnswer: tgPhotoShowAnswer,
            });
            caption = formatPhotoCaption(q, i + 1, tgPhotoShowAnswer);
          } catch (renderErr: any) {
            addLog(`បរាជ័យបង្កើតរូបភាពទី ${toKhmerNum(i + 1)}: ${renderErr.message}`, false);
            stepDone += activeTargets.length;
            continue;
          }

          for (let tIdx = 0; tIdx < activeTargets.length; tIdx++) {
            if (tgCancelRef.current) break;
            const dest = activeTargets[tIdx];
            stepDone++;
            setTgProgress({
              current: stepDone,
              total: totalOps,
              isRunning: true,
              message: `រូបភាពទី ${toKhmerNum(i + 1)}/${toKhmerNum(subjectQuestions.length)} → ${dest}...`,
            });

            try {
              await sendTelegramPhoto(tgBotToken.trim(), dest, photoBase64, caption, 'HTML');
              successCount++;
              addLog(`[${dest}] រូបភាពទី ${toKhmerNum(i + 1)}: ${q.question.slice(0, 30)}...`, true);
            } catch (itemErr: any) {
              addLog(`[${dest}] បរាជ័យរូបភាពទី ${toKhmerNum(i + 1)}: ${itemErr.message}`, false);
            }

            if (tIdx < activeTargets.length - 1) {
              await sleep(350);
            }
          }

          if (i < subjectQuestions.length - 1) {
            await sleep(1400);
          }
        }

        setTelegramStatus({
          text: tgCancelRef.current
            ? `បានផ្អាកការផ្ញើ (ផ្ញើបាន ${toKhmerNum(successCount)}/${toKhmerNum(totalOps)} រូបភាព)`
            : `បានផ្ញើកាតរូបភាពចំនួន ${toKhmerNum(successCount)}/${toKhmerNum(totalOps)} ទៅកាន់ ${toKhmerNum(activeTargets.length)} គោលដៅរួចរាល់!`,
          success: successCount > 0,
        });
      } else if (tgSendMode === 'batch_cards') {
        // Mode 1A (Default Text): Send Designed App Banner Image + Q&A Text with Hidden Spoiler Answer across selected targets
        const totalOps = subjectQuestions.length * activeTargets.length;
        setTgProgress({
          current: 0,
          total: totalOps,
          isRunning: true,
          message: `កំពុងផ្ញើរូបភាពកម្មវិធី + សំណួរទៅ ${toKhmerNum(activeTargets.length)} គោលដៅ...`,
        });

        let successCount = 0;
        let stepDone = 0;
        for (let i = 0; i < subjectQuestions.length; i++) {
          if (tgCancelRef.current) {
            addLog(`ផ្អាកការផ្ញើនៅសំណួរទី ${toKhmerNum(i + 1)}`, false);
            break;
          }

          const q = subjectQuestions[i];
          const bannerBase64 = await renderAppBannerImage(q.subject, i + 1).catch(() => undefined);

          for (let tIdx = 0; tIdx < activeTargets.length; tIdx++) {
            if (tgCancelRef.current) break;
            const dest = activeTargets[tIdx];
            stepDone++;
            setTgProgress({
              current: stepDone,
              total: totalOps,
              isRunning: true,
              message: `សំណួរទី ${toKhmerNum(i + 1)}/${toKhmerNum(subjectQuestions.length)} → ${dest}...`,
            });

            try {
              await sendTelegramQuestionTextWithBanner(tgBotToken.trim(), dest, q, i + 1, bannerBase64);
              successCount++;
              addLog(`[${dest}] សំណួរទី ${toKhmerNum(i + 1)}: ${q.question.slice(0, 30)}...`, true);
            } catch (itemErr: any) {
              addLog(`[${dest}] បរាជ័យសំណួរទី ${toKhmerNum(i + 1)}: ${itemErr.message}`, false);
            }

            if (tIdx < activeTargets.length - 1) {
              await sleep(350);
            }
          }

          if (i < subjectQuestions.length - 1) {
            await sleep(1400);
          }
        }

        setTelegramStatus({
          text: tgCancelRef.current
            ? `បានផ្អាកការផ្ញើ (ផ្ញើបាន ${toKhmerNum(successCount)}/${toKhmerNum(totalOps)} សារ)`
            : `បានផ្ញើសំណួរ & ចម្លើយចំនួន ${toKhmerNum(successCount)}/${toKhmerNum(totalOps)} ទៅកាន់ ${toKhmerNum(activeTargets.length)} គោលដៅរួចរាល់!`,
          success: successCount > 0,
        });
      }
    } catch (err: any) {
      setTelegramStatus({ text: err.message || 'បរាជ័យក្នុងការផ្ញើទៅ Telegram', success: false });
    } finally {
      setIsSendingTelegram(false);
      setTgProgress((prev) => ({ ...prev, isRunning: false }));
    }
  };

  // Send Single Question One-by-One (Text Card, Poll, or Photo) to all active targets and advance
  const handleSendSingleQuestion = async (sendAs: 'card' | 'poll' | 'photo') => {
    const hasToken = Boolean(tgBotToken.trim() || commandBotStatus?.hasServerToken);
    const activeTargets = resolveActiveTelegramTargets();
    if (!hasToken || activeTargets.length === 0) {
      setTelegramStatus({
        text: 'សូមបញ្ចូល Telegram Bot Token និងជ្រើសរើសគោលដៅ Telegram យ៉ាងតិច ១!',
        success: false,
      });
      return;
    }

    localStorage.setItem('master_quiz_tg_token', tgBotToken.trim());
    localStorage.setItem('master_quiz_tg_chat', tgChatId.trim());

    const subjectPool = tgSubject === '__ALL__'
      ? questions
      : questions.filter((q) => q.subject === tgSubject);

    const rawIndex = subjectPool.findIndex((q) => q.id === tgSelectedQuestionId);
    const targetIndex = rawIndex >= 0 ? rawIndex : 0;
    const targetQ = subjectPool[targetIndex];

    if (!targetQ) {
      setTelegramStatus({ text: 'មិនមានសំណួរសម្រាប់ផ្ញើទេ!', success: false });
      return;
    }

    if (sendAs === 'poll' && (targetQ.type !== 'mcq' || !targetQ.options || targetQ.options.length < 2)) {
      setTelegramStatus({ text: 'ទម្រង់ Quiz Poll អាចប្រើបានតែជាមួយសំណួរ QCM ប៉ុណ្ណោះ! សូមជ្រើស "ផ្ញើជា Text" ឬ "ផ្ញើជារូបភាព" ជំនួសវិញ។', success: false });
      return;
    }

    setIsSendingTelegram(true);
    setTelegramStatus(null);

    try {
      let photoBase64 = '';
      let photoCaption = '';
      let bannerBase64 = '';

      if (sendAs === 'photo') {
        photoBase64 = await renderQuestionCardImage(targetQ, targetIndex + 1, {
          showAnswer: tgPhotoShowAnswer,
        });
        photoCaption = formatPhotoCaption(targetQ, targetIndex + 1, tgPhotoShowAnswer);
      } else if (sendAs === 'card') {
        bannerBase64 = await renderAppBannerImage(targetQ.subject, targetIndex + 1);
      }

      const succeededTargets: string[] = [];
      const failedTargets: Array<{ dest: string; error: string }> = [];

      for (let tIdx = 0; tIdx < activeTargets.length; tIdx++) {
        const dest = activeTargets[tIdx];
        try {
          if (sendAs === 'poll') {
            await sendTelegramPoll(tgBotToken.trim(), dest, targetQ);
          } else if (sendAs === 'photo') {
            await sendTelegramPhoto(tgBotToken.trim(), dest, photoBase64, photoCaption, 'HTML');
          } else {
            await sendTelegramQuestionTextWithBanner(
              tgBotToken.trim(),
              dest,
              targetQ,
              targetIndex + 1,
              bannerBase64
            );
          }
          succeededTargets.push(dest);
        } catch (err: any) {
          failedTargets.push({ dest, error: err?.message || 'បរាជ័យ' });
        }

        if (tIdx < activeTargets.length - 1) {
          await sleep(300);
        }
      }

      if (succeededTargets.length > 0) {
        if (targetQ.id) {
          setTgSentIds((prev) => (prev.includes(targetQ.id!) ? prev : [...prev, targetQ.id!]));
        }
        const nextQ = subjectPool[targetIndex + 1];
        if (nextQ?.id) {
          setTgSelectedQuestionId(nextQ.id);
        }
      }

      const modeLabel = sendAs === 'poll' ? 'ជា Poll' : sendAs === 'photo' ? 'ជារូបភាព' : 'ជា Text';
      if (failedTargets.length === 0) {
        setTelegramStatus({
          text: `បានផ្ញើសំណួរទី ${toKhmerNum(targetIndex + 1)} (${modeLabel}) ទៅ ${toKhmerNum(succeededTargets.length)}/${toKhmerNum(activeTargets.length)} គោលដៅ (${succeededTargets.join(', ')}) ជោគជ័យ!`,
          success: true,
        });
      } else if (succeededTargets.length > 0) {
        const failSummary = failedTargets.map((f) => `${f.dest}: ${f.error}`).join(' | ');
        setTelegramStatus({
          text: `ផ្ញើជោគជ័យ ${toKhmerNum(succeededTargets.length)}/${toKhmerNum(activeTargets.length)} គោលដៅ (${succeededTargets.join(', ')}) · មានគោលដៅមិនជោគជ័យ៖ ${failSummary}`,
          success: true,
        });
      } else {
        const failSummary = failedTargets.map((f) => `${f.dest}: ${f.error}`).join(' | ');
        setTelegramStatus({
          text: `បរាជ័យក្នុងការផ្ញើទៅ Telegram៖ ${failSummary}`,
          success: false,
        });
      }
    } catch (err: any) {
      setTelegramStatus({ text: err.message || 'បរាជ័យក្នុងការផ្ញើទៅ Telegram', success: false });
    } finally {
      setIsSendingTelegram(false);
    }
  };

  // Download PDF
  const handleExportPDF = async () => {
    const targetQuestions = selectedExportQuestions;

    if (targetQuestions.length === 0) {
      setExportStatusMsg({
        text: 'មិនមានសំណួរនៅក្នុងមុខវិជ្ជានេះសម្រាប់ទាញយកជា PDF ទេ!',
        success: false,
      });
      return;
    }

    setIsExportingPDF(true);
    setPdfProgress(null);
    setExportStatusMsg(null);

    try {
      const titleLabel =
        resolvedExportSubjectName === '__ALL__'
          ? 'គ្រប់មុខវិជ្ជាទាំងអស់'
          : resolvedExportSubjectName;
      await exportQuestionsToPDF({
        subjectTitle: titleLabel,
        questions: targetQuestions,
        template: pdfSettings.template,
        includeCoverPage: pdfSettings.includeCoverPage !== false,
        answerMode: pdfSettings.answerMode || 'last_page_table',
        settings: pdfSettings,
        filename: `${titleLabel}_MasterQuiz.pdf`,
        onProgress: (current, total) => setPdfProgress({ current, total }),
      });

      setExportStatusMsg({
        text: `បានបង្កើត និងទាញយកឯកសារ PDF («${titleLabel}» — ${toKhmerNum(targetQuestions.length)} សំណួរ) ជោគជ័យ!`,
        success: true,
      });
    } catch (err: any) {
      console.error('Error exporting PDF:', err);
      setExportStatusMsg({
        text: err?.message || 'បរាជ័យក្នុងការបង្កើតឯកសារ PDF សូមព្យាយាមម្ដងទៀត!',
        success: false,
      });
    } finally {
      setIsExportingPDF(false);
      setPdfProgress(null);
    }
  };

  // Download Export JSON from Export Tab
  const handleExportJSON = (scope: 'filtered' | 'all') => {
    const targetQuestions = scope === 'all' ? questions : selectedExportQuestions;
    const titleLabel =
      scope === 'all' || resolvedExportSubjectName === '__ALL__'
        ? 'គ្រប់មុខវិជ្ជាទាំងអស់'
        : resolvedExportSubjectName;

    if (targetQuestions.length === 0) {
      setExportStatusMsg({
        text: 'មិនមានសំណួរនៅក្នុងជម្រើសនេះសម្រាប់ទាញយកជា JSON ទេ!',
        success: false,
      });
      return;
    }

    const payload = buildExportJsonPayload(targetQuestions, subjects, {
      subjectLabel: scope === 'all' ? '__ALL__' : resolvedExportSubjectName,
    });
    const filename =
      scope === 'all' || resolvedExportSubjectName === '__ALL__'
        ? 'Master_Quiz_KH_All_Questions.json'
        : `${resolvedExportSubjectName}_MasterQuiz.json`;
    downloadJsonFile(payload, filename);
    setExportStatusMsg({
      text: `បានទាញយកឯកសារ JSON («${titleLabel}» — ${toKhmerNum(targetQuestions.length)} សំណួរ) ជោគជ័យ!`,
      success: true,
    });
  };

  const formatImportedSummaryKh = (imported: Record<string, number>) => {
    const labels: Record<string, string> = {
      subjects: 'មុខវិជ្ជា',
      questions: 'សំណួរ',
      notifications: 'ដំណឹង',
      botCommands: 'Bot Commands',
      paidUsers: 'សមាជិក VIP',
      feedbacks: 'មតិយោបល់',
      logins: 'ប្រវត្តិ Login',
      presence: 'វត្តមាន',
    };
    return Object.entries(imported)
      .filter(([, count]) => Number(count) > 0)
      .map(([key, count]) => `${labels[key] || key}: ${toKhmerNum(Number(count))}`)
      .join(' · ');
  };

  const handleMigrateAllToSupabase = async () => {
    if (isMigratingDb) return;
    setIsMigratingDb(true);
    setMigrationStatusMsg(null);
    setMigrationProgressText('កំពុងរៀបចំទាញទិន្នន័យទាំងអស់...');
    try {
      const result = await migrateAllFirebaseToSupabase((msg) => setMigrationProgressText(msg));
      const summary = formatImportedSummaryKh(result.imported);
      const warnNote =
        result.warnings.length > 0
          ? ` (កំណត់ចំណាំ៖ ទិន្នន័យខ្លះប្រើ Cache ដោយសារ Firebase ជាប់ដែនកំណត់)`
          : '';
      setMigrationStatusMsg({
        text: `ផ្ទេរទិន្នន័យទៅ Supabase ជោគជ័យ! (${summary || `សរុប ${toKhmerNum(result.totalRecords)}`})${warnNote}`,
        success: true,
      });
    } catch (err: any) {
      setMigrationStatusMsg({
        text: err?.message || 'បរាជ័យក្នុងការផ្ទេរទិន្នន័យទៅ Supabase',
        success: false,
      });
    } finally {
      setIsMigratingDb(false);
      setMigrationProgressText('');
    }
  };

  const handleExportFullBackupJson = async () => {
    if (isMigratingDb) return;
    setIsMigratingDb(true);
    setMigrationStatusMsg(null);
    setMigrationProgressText('កំពុងប្រមូលទិន្នន័យទាំងអស់ជាឯកសារ Backup...');
    try {
      const res = await exportAllFirebaseDataAsJson((msg) => setMigrationProgressText(msg));
      setMigrationStatusMsg({
        text: `បានទាញយកឯកសារ Backup ទាំងអស់ (${res.filename} · សរុប ${toKhmerNum(res.totalRecords)} ទិន្នន័យ) ជោគជ័យ!`,
        success: true,
      });
    } catch (err: any) {
      setMigrationStatusMsg({
        text: err?.message || 'បរាជ័យក្នុងការទាញយក Backup JSON',
        success: false,
      });
    } finally {
      setIsMigratingDb(false);
      setMigrationProgressText('');
    }
  };

  const handleImportFullBackupFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || isMigratingDb) return;

    setIsMigratingDb(true);
    setMigrationStatusMsg(null);
    setMigrationProgressText('កំពុងអានឯកសារ Backup...');
    try {
      const rawText = await file.text();
      const res = await importBackupJsonToSupabase(rawText, (msg) => setMigrationProgressText(msg));
      const summary = formatImportedSummaryKh(res.imported);
      setMigrationStatusMsg({
        text: `បញ្ចូលទិន្នន័យពី Backup ទៅ Supabase ជោគជ័យ! (${summary || `សរុប ${toKhmerNum(res.totalRecords)}`})`,
        success: true,
      });
    } catch (err: any) {
      setMigrationStatusMsg({
        text: err?.message || 'បរាជ័យក្នុងការបញ្ចូលឯកសារ Backup ទៅ Supabase',
        success: false,
      });
    } finally {
      setIsMigratingDb(false);
      setMigrationProgressText('');
    }
  };

  const copyTextSafe = async (text: string): Promise<boolean> => {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fallback for restricted iframes / Safari
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(ta);
      return copied;
    } catch {
      return false;
    }
  };

  const handleCopySupabaseSchemaSql = async () => {
    setMigrationStatusMsg(null);
    try {
      const res = await fetch('/api/db/schema-sql?raw=1', { cache: 'no-store' });
      const rawSql = await res.text();
      if (!res.ok || !rawSql.includes('CREATE TABLE') || rawSql.trim().startsWith('{')) {
        throw new Error('មិនអាចទាញយកកូដ SQL បានទេ');
      }
      setSchemaSqlPreview(rawSql);
      const copied = await copyTextSafe(rawSql);
      setMigrationStatusMsg({
        text: copied
          ? 'បានចម្លង SQL (CREATE TABLE...) រួចរាល់! សូមលុបកូដចាស់ក្នុង Supabase SQL Editor រួច Paste និងចុច Run។'
          : 'សូមចុច Select All & Copy កូដ SQL ខាងក្រោម (កុំ Paste ឯកសារ .json) ទៅ Run ក្នុង Supabase → SQL Editor។',
        success: true,
      });
    } catch (err: any) {
      setMigrationStatusMsg({
        text: err?.message || 'មិនអាចចម្លង SQL បានទេ — សូមបើកឯកសារ supabase/schema.sql ដោយផ្ទាល់។',
        success: false,
      });
    }
  };

  const [broadcastStatusMsg, setBroadcastStatusMsg] = useState<{ text: string; success: boolean } | null>(null);
  const [isBroadcasting, setIsBroadcasting] = useState(false);

  // Broadcast Notification
  const handleBroadcast = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!broadcastMsg.trim() || isBroadcasting) return;

    setBroadcastStatusMsg(null);
    setIsBroadcasting(true);
    try {
      await broadcastNotification(broadcastMsg.trim(), broadcastType);
      setBroadcastMsg('');
      setBroadcastStatusMsg({ text: 'បានផ្សាយដំណឹងទៅកាន់សមាជិកទាំងអស់ជោគជ័យ!', success: true });
    } catch {
      setBroadcastStatusMsg({ text: 'បរាជ័យក្នុងការផ្សាយដំណឹង', success: false });
    } finally {
      setIsBroadcasting(false);
    }
  };

  const handleDeleteSingleNotification = async (id: string) => {
    setBroadcastStatusMsg(null);
    try {
      await deleteNotification(id);
      setBroadcastStatusMsg({ text: 'បានលុបដំណឹងចេញពីប្រព័ន្ធជោគជ័យ!', success: true });
    } catch {
      setBroadcastStatusMsg({ text: 'បរាជ័យក្នុងការលុបដំណឹង', success: false });
    }
  };

  const handleDeleteAllNotificationsClick = () => {
    if (notifications.length === 0) return;
    setDeleteConfirmDialog({
      isOpen: true,
      title: 'បញ្ជាក់ការលុបដំណឹងទាំងអស់',
      message: `តើអ្នកពិតជាចង់លុបដំណឹងទាំង ${toKhmerNum(notifications.length)} ចេញពីប្រព័ន្ធមែនទេ?`,
      subMessage: 'ដំណឹងទាំងអស់នឹងត្រូវលុបចេញពីទំព័រសមាជិក និងអ្នកគ្រប់គ្រងជាអចិន្ត្រៃយ៍។',
      onConfirm: async () => {
        setBroadcastStatusMsg(null);
        try {
          await deleteAllNotifications(notifications.map((n) => n.id));
          setBroadcastStatusMsg({ text: 'បានលុបដំណឹងទាំងអស់ជោគជ័យ!', success: true });
        } catch {
          setBroadcastStatusMsg({ text: 'បរាជ័យក្នុងការលុបដំណឹងទាំងអស់', success: false });
        }
      },
    });
  };

  // Login History Management
  const [loginSearch, setLoginSearch] = useState('');
  const [loginStatusMsg, setLoginStatusMsg] = useState<{ text: string; success: boolean } | null>(null);

  const filteredLogins = useMemo(() => {
    const term = loginSearch.trim().toLowerCase();
    if (!term) return logins;
    return logins.filter(
      (l) =>
        l.username.toLowerCase().includes(term) ||
        l.role.toLowerCase().includes(term)
    );
  }, [logins, loginSearch]);

  const handleDeleteSingleLogin = async (record: LoginRecord) => {
    if (!record.id) return;
    setLoginStatusMsg(null);
    try {
      await deleteLoginRecord(record.id);
      setLoginStatusMsg({
        text: `បានលុបប្រវត្តិ Login របស់ «${record.username}» ជោគជ័យ!`,
        success: true,
      });
    } catch {
      setLoginStatusMsg({ text: 'បរាជ័យក្នុងការលុបប្រវត្តិ Login', success: false });
    }
  };

  const handleDeleteMemberAllLogins = (username: string) => {
    const matching = logins.filter((l) => l.username === username && l.id);
    if (matching.length === 0) return;
    setDeleteConfirmDialog({
      isOpen: true,
      title: 'បញ្ជាក់ការលុបប្រវត្តិ Login សមាជិក',
      message: `តើអ្នកចង់លុបប្រវត្តិ Login ទាំង ${toKhmerNum(matching.length)} ដងរបស់ «${username}» មែនទេ?`,
      subMessage: 'ប្រវត្តិ Login ទាំងអស់របស់គណនីនេះនឹងត្រូវលុបចេញជាអចិន្ត្រៃយ៍។',
      onConfirm: async () => {
        setLoginStatusMsg(null);
        try {
          await deleteLoginsByIds(matching.map((m) => m.id as string));
          setLoginStatusMsg({
            text: `បានលុបប្រវត្តិ Login ទាំងអស់របស់ «${username}» ជោគជ័យ!`,
            success: true,
          });
        } catch {
          setLoginStatusMsg({ text: 'បរាជ័យក្នុងការលុបប្រវត្តិ Login', success: false });
        }
      },
    });
  };

  const handleDeleteAllLoginsClick = () => {
    const targetList = loginSearch.trim() ? filteredLogins : logins;
    const ids = targetList.map((l) => l.id).filter(Boolean) as string[];
    if (ids.length === 0) return;

    const isFiltered = Boolean(loginSearch.trim());
    setDeleteConfirmDialog({
      isOpen: true,
      title: isFiltered ? 'បញ្ជាក់ការលុបប្រវត្តិ Login ដែលបានស្វែងរក' : 'បញ្ជាក់ការលុបប្រវត្តិ Login ទាំងអស់',
      message: `តើអ្នកពិតជាចង់លុបប្រវត្តិ Login ចំនួន ${toKhmerNum(ids.length)} ចេញពីប្រព័ន្ធមែនទេ?`,
      subMessage: 'ទិន្នន័យប្រវត្តិ Login ដែលបានលុបមិនអាចទាញយកវិញបានទេ។',
      onConfirm: async () => {
        setLoginStatusMsg(null);
        try {
          await deleteLoginsByIds(ids);
          if (isFiltered) setLoginSearch('');
          setLoginStatusMsg({ text: 'បានលុបប្រវត្តិ Login ជោគជ័យ!', success: true });
        } catch {
          setLoginStatusMsg({ text: 'បរាជ័យក្នុងការលុបប្រវត្តិ Login', success: false });
        }
      },
    });
  };

  const [isSyncingAdminData, setIsSyncingAdminData] = useState(false);
  const [adminSyncDone, setAdminSyncDone] = useState(false);
  const [isSyncingMonitoring, setIsSyncingMonitoring] = useState(false);
  const [isConnectingGoogle, setIsConnectingGoogle] = useState(false);

  const handleConnectGoogleAdmin = async () => {
    if (isConnectingGoogle) return;
    setIsConnectingGoogle(true);
    try {
      await signInWithGoogle();
      await Promise.all([
        refreshCoreData(),
        onRefreshMonitoring ? onRefreshMonitoring() : refreshAdminMonitoringData(),
      ]);
    } catch {
      // User dismissed or failed popup
    } finally {
      setIsConnectingGoogle(false);
    }
  };

  const handleAdminSyncAll = async () => {
    if (isSyncingAdminData) return;
    setIsSyncingAdminData(true);
    setAdminSyncDone(false);
    try {
      await Promise.all([
        refreshCoreData(),
        onRefreshMonitoring ? onRefreshMonitoring() : refreshAdminMonitoringData(),
      ]);
      setAdminSyncDone(true);
      setTimeout(() => setAdminSyncDone(false), 2500);
    } finally {
      setIsSyncingAdminData(false);
    }
  };

  const handleRefreshMonitoringOnly = async () => {
    if (isSyncingMonitoring) return;
    setIsSyncingMonitoring(true);
    try {
      if (onRefreshMonitoring) {
        await onRefreshMonitoring();
      } else {
        await refreshAdminMonitoringData();
      }
    } finally {
      setIsSyncingMonitoring(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6 lg:py-8 tg-safe-x">
      {/* Admin Title */}
      <div className="relative flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-5 sm:mb-7 khmer-ornate-card p-5 sm:p-6 rounded-2xl">
        <KhmerCornerMotif position="tl" size={30} />
        <KhmerCornerMotif position="tr" size={30} />

        <div className="flex items-center gap-3.5 min-w-0">
          <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-xl khmer-btn-crimson flex items-center justify-center shrink-0 shadow-sm">
            <Settings className="w-5 h-5 sm:w-6 sm:h-6" />
          </div>
          <div className="min-w-0">
            <h1 className="leading-snug sm:leading-normal font-moul text-base sm:text-xl md:text-2xl app-text-primary">
              ផ្ទាំងគ្រប់គ្រង (Admin Control Center)
            </h1>
            <p className="text-xs sm:text-sm app-text-secondary leading-relaxed">
              ប្រព័ន្ធគ្រប់គ្រងវិញ្ញាសា បញ្ចូលសំណួរជាដុំ បាញ់ Telegram និងតាមដានសកម្មភាពសមាជិក
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {!firebaseUserEmail ? (
            <button
              type="button"
              disabled={isConnectingGoogle}
              onClick={handleConnectGoogleAdmin}
              className="px-3.5 py-2 rounded-xl bg-amber-50 dark:bg-amber-950/60 hover:opacity-90 border border-amber-400 dark:border-amber-700 text-amber-900 dark:text-amber-200 text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
              title="ភ្ជាប់គណនី Google Admin ដើម្បីអនុញ្ញាតឱ្យអាន និងរក្សាទុកទិន្នន័យលើ Firestore"
            >
              <Cloud className="w-3.5 h-3.5 shrink-0" />
              <span>{isConnectingGoogle ? 'កំពុងភ្ជាប់...' : 'ភ្ជាប់ Google Admin'}</span>
            </button>
          ) : (
            <span className="px-3 py-1.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-300 dark:border-emerald-700 text-emerald-800 dark:text-emerald-200 text-xs font-semibold flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate max-w-[160px]">{firebaseUserEmail}</span>
            </span>
          )}
          <button
            type="button"
            disabled={isSyncingAdminData}
            onClick={handleAdminSyncAll}
            className="px-3.5 py-2 rounded-xl app-subcard hover:opacity-85 disabled:opacity-60 app-text-primary border app-border text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
            title="ទាញយកទិន្នន័យចុងក្រោយពី Database"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isSyncingAdminData ? 'animate-spin' : ''}`} />
            <span>
              {isSyncingAdminData
                ? 'កំពុង Sync...'
                : adminSyncDone
                  ? 'បានធ្វើបច្ចុប្បន្នភាព ✓'
                  : 'ទាញយកទិន្នន័យថ្មី'}
            </span>
          </button>
          <div className="text-xs sm:text-sm font-bold khmer-gold-text shrink-0">
            សិទ្ធិគ្រប់គ្រង (Admin)
          </div>
        </div>
      </div>

      {/* Admin Tabs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-1.5 mb-6 sm:mb-8 app-subcard p-1.5 rounded-2xl">
        {[
          { id: 'single', label: 'បញ្ចូលសំណួរទោល', icon: PlusCircle },
          { id: 'bulk_ai', label: 'បញ្ចូលជាដុំ / JSON', icon: FileSpreadsheet },
          { id: 'manage', label: 'គ្រប់គ្រងមុខវិជ្ជា/សំណួរ', icon: Settings },
          { id: 'export', label: 'Export (PDF / JSON)', icon: Download },
          { id: 'telegram', label: 'Telegram Bot', icon: Send },
          { id: 'monitoring', label: 'ដំណឹង & វត្តមាន', icon: Bell },
        ].map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              type="button"
              key={tab.id}
              onClick={() => setActiveSubTab(tab.id as any)}
              className={`min-h-[42px] py-2 px-2.5 rounded-xl text-xs sm:text-sm font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer ${
                activeSubTab === tab.id
                  ? 'khmer-btn-crimson shadow-sm'
                  : 'app-text-secondary hover:opacity-80'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span className="truncate">{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* 1. SINGLE QUESTION ENTRY */}
      {activeSubTab === 'single' && (
        <div className="app-card rounded-2xl p-6 sm:p-8 max-w-3xl mx-auto shadow-sm">
          <h2 className="font-moul text-base sm:text-lg app-text-primary mb-1.5">
            បញ្ចូលសំណួរទោល (Single Entry)
          </h2>
          <p className="text-sm app-text-secondary mb-6">
            ជ្រើសរើសមុខវិជ្ជា និងបំពេញព័ត៌មានសំណួរតាមទម្រង់ខាងក្រោម
          </p>

          {singleStatusMsg && (
            <div
              className={`p-3.5 rounded-xl mb-6 text-sm flex items-center gap-2 border ${
                singleStatusMsg.success
                  ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-400 dark:border-emerald-700 text-emerald-900 dark:text-emerald-200'
                  : 'bg-red-50 dark:bg-red-950/60 border-red-400 dark:border-red-700 text-red-900 dark:text-red-200'
              }`}
            >
              {singleStatusMsg.success ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0" />
              )}
              <span>{singleStatusMsg.text}</span>
            </div>
          )}

          <form onSubmit={handleSaveSingleQuestion} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-semibold app-text-primary mb-1.5">
                  មុខវិជ្ជាដែលមានស្រាប់
                </label>
                <select
                  value={singleSubject}
                  onChange={(e) => setSingleSubject(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm"
                >
                  {subjects.length === 0 ? (
                    <option value="">(មិនទាន់មានមុខវិជ្ជា - សូមបង្កើតថ្មីខាងស្តាំ)</option>
                  ) : (
                    subjects.map((sub) => (
                      <option key={sub.id} value={sub.name}>
                        {sub.name}
                      </option>
                    ))
                  )}
                </select>
              </div>

              <div>
                <label className="block text-sm font-semibold app-text-primary mb-1.5">
                  ឬ បង្កើតមុខវិជ្ជាថ្មី
                </label>
                <input
                  type="text"
                  value={newSubjectName}
                  onChange={(e) => setNewSubjectName(e.target.value)}
                  placeholder="វាយឈ្មោះមុខវិជ្ជាថ្មី (ប្រសិនបើមាន)"
                  className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold app-text-primary mb-1.5">ប្រភេទសំណួរ</label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { id: 'mcq', label: 'QCM (ពហុជម្រើស)' },
                  { id: 'short', label: 'Q & A (ខ្លី)' },
                  { id: 'explanation', label: 'ពន្យល់ពាក្យ' },
                ].map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setSingleType(t.id as any)}
                    className={`py-2.5 px-2 rounded-xl text-xs sm:text-sm font-semibold border transition cursor-pointer ${
                      singleType === t.id
                        ? 'bg-red-600 text-white border-red-600'
                        : 'app-subcard app-text-primary hover:opacity-85'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold app-text-primary mb-1.5">
                {singleType === 'explanation' ? 'ពាក្យគន្លឹះ / វាក្យសព្ទ' : 'អត្ថបទសំណួរ'} *
              </label>
              <textarea
                rows={3}
                value={singleQuestionText}
                onChange={(e) => setSingleQuestionText(e.target.value)}
                placeholder="ឧ. តើព្រះរាជាណាចក្រកម្ពុជាប្រកាន់យករបបដឹកនាំរដ្ឋបែបណា?"
                className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm sm:text-base"
                required
              />
            </div>

            {singleType === 'mcq' && (
              <div className="space-y-2.5">
                <label className="block text-sm font-semibold app-text-primary">
                  ជម្រើសទាំង ៤ (ជ្រើសរើស Option ណាជាចម្លើយត្រឹមត្រូវ) *
                </label>
                {singleOptions.map((opt, oIdx) => (
                  <div key={oIdx} className="flex items-center gap-2.5">
                    <input
                      type="radio"
                      name="correctOptionRadio"
                      checked={singleCorrect === oIdx}
                      onChange={() => setSingleCorrect(oIdx)}
                      className="w-4 h-4 text-emerald-600 focus:ring-0 cursor-pointer"
                    />
                    <span className="text-sm font-bold w-6 text-blue-700 dark:text-amber-300">
                      {getOptionLabel(oIdx, singleSubject)}.
                    </span>
                    <input
                      type="text"
                      value={opt}
                      onChange={(e) => {
                        const next = [...singleOptions];
                        next[oIdx] = e.target.value;
                        setSingleOptions(next);
                      }}
                      className="flex-1 px-3.5 py-2.5 rounded-xl app-input text-sm"
                      placeholder={`ជម្រើស ${getOptionLabel(oIdx, singleSubject)}`}
                      required
                    />
                  </div>
                ))}
              </div>
            )}

            {(singleType === 'short' || singleType === 'explanation') && (
              <div>
                <label className="block text-sm font-semibold app-text-primary mb-1.5">
                  ចម្លើយបកស្រាយពេញលេញ *
                </label>
                <textarea
                  rows={4}
                  value={singleAnswer}
                  onChange={(e) => setSingleAnswer(e.target.value)}
                  placeholder="បញ្ចូលការបកស្រាយលម្អិត..."
                  className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm sm:text-base"
                  required
                />
              </div>
            )}

            <button
              type="submit"
              className="w-full py-3 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold text-sm sm:text-base flex items-center justify-center gap-2 transition cursor-pointer"
            >
              <PlusCircle className="w-4 h-4" />
              <span>រក្សាទុកសំណួរទៅក្នុងប្រព័ន្ធ</span>
            </button>
          </form>
        </div>
      )}

      {/* 2. BULK IMPORT (TEXT & EXPORT JSON) */}
      {activeSubTab === 'bulk_ai' && (
        <div className="space-y-8 max-w-4xl mx-auto">
          <div className="app-card rounded-2xl p-6 sm:p-8 shadow-sm">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-amber-600 text-white flex items-center justify-center shrink-0">
                  {bulkInputMode === 'json' ? (
                    <FileJson className="w-5 h-5" />
                  ) : (
                    <FileSpreadsheet className="w-5 h-5" />
                  )}
                </div>
                <div>
                  <h2 className="font-moul text-base sm:text-lg app-text-primary">
                    បញ្ចូលសំណួរ-ចម្លើយជាដុំ (Bulk & Export JSON)
                  </h2>
                  <p className="text-sm app-text-secondary">
                    {bulkInputMode === 'json'
                      ? 'ផ្ទុកឯកសារ .json ឬបិទភ្ជាប់ទម្រង់ Export JSON ដើម្បីនាំចូល និង Export ទិន្នន័យយ៉ាងរហ័ស'
                      : 'ចម្លង និងបិទភ្ជាប់សំណួរចម្លើយច្រើនក្នុងពេលតែមួយ និងចាត់ចែងចូលមុខវិជ្ជាជាក់លាក់'}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl app-subcard shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setBulkInputMode('text');
                    setBulkStatusMsg(null);
                  }}
                  className={`px-3 py-2 rounded-lg text-xs sm:text-sm font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer ${
                    bulkInputMode === 'text'
                      ? 'bg-amber-600 text-white shadow-sm'
                      : 'app-text-secondary hover:opacity-85'
                  }`}
                >
                  <FileText className="w-4 h-4 shrink-0" />
                  <span>ទម្រង់អត្ថបទ</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setBulkInputMode('json');
                    setBulkStatusMsg(null);
                  }}
                  className={`px-3 py-2 rounded-lg text-xs sm:text-sm font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer ${
                    bulkInputMode === 'json'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'app-text-secondary hover:opacity-85'
                  }`}
                >
                  <FileJson className="w-4 h-4 shrink-0" />
                  <span>ទម្រង់ JSON</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5 p-4 rounded-xl app-subcard">
              <div>
                <label className="block text-sm font-semibold app-text-primary mb-1.5">
                  ១. ជ្រើសរើសមុខវិជ្ជាដែលមានស្រាប់
                </label>
                <select
                  value={bulkSubject}
                  onChange={(e) => setBulkSubject(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm"
                >
                  {subjects.length === 0 ? (
                    <option value="">(មិនទាន់មានមុខវិជ្ជា - សូមវាយបង្កើតថ្មីខាងស្តាំ)</option>
                  ) : (
                    subjects.map((sub) => (
                      <option key={sub.id} value={sub.name}>
                        {sub.name}
                      </option>
                    ))
                  )}
                </select>
              </div>

              <div>
                <label className="block text-sm font-semibold app-text-primary mb-1.5">
                  ២. ឬ បញ្ចូល/បង្កើតមុខវិជ្ជាថ្មី
                </label>
                <input
                  type="text"
                  value={newBulkSubjectName}
                  onChange={(e) => setNewBulkSubjectName(e.target.value)}
                  placeholder="ឧ. វប្បធម៌ទូទៅ ២០២៦ ឬ ច្បាប់រដ្ឋបាល"
                  className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm"
                />
                <p className="text-xs app-text-secondary mt-1.5">
                  * បើបំពេញប្រអប់នេះ សំណួរទាំងអស់នឹងត្រូវចាត់ចូលមុខវិជ្ជានេះដោយស្វ័យប្រវត្តិ។
                </p>
              </div>

              {bulkInputMode === 'json' && (
                <div className="sm:col-span-2 pt-2 border-t app-border flex items-start gap-2.5">
                  <input
                    id="json-override-subject-toggle"
                    type="checkbox"
                    checked={jsonOverrideSubject}
                    onChange={(e) => setJsonOverrideSubject(e.target.checked)}
                    className="mt-0.5 w-4 h-4 rounded accent-blue-600 cursor-pointer shrink-0"
                  />
                  <label htmlFor="json-override-subject-toggle" className="text-xs sm:text-sm app-text-primary cursor-pointer">
                    <span className="font-semibold">កំណត់មុខវិជ្ជាដែលជ្រើសរើសខាងលើសម្រាប់គ្រប់សំណួរក្នុង JSON</span>
                    <span className="block text-xs app-text-secondary mt-0.5">
                      ប្រសិនបើមិនធីកទេ កម្មវិធីនឹងប្រើឈ្មោះមុខវិជ្ជា ("subject") ដែលមានស្រាប់ក្នុង JSON និងបង្កើតមុខវិជ្ជាថ្មីដោយស្វ័យប្រវត្តិ (សមស្របសម្រាប់ទាញយក Export JSON ចូលវិញ)។
                    </span>
                  </label>
                </div>
              )}
            </div>

            <div className="mb-4">
              <label className="block text-sm font-semibold app-text-primary mb-2">
                ទម្រង់សំណួរ (Question Format)
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { id: 'auto', label: 'រកស្វ័យប្រវត្តិ (Auto)' },
                  { id: 'mcq', label: 'QCM (ពហុជម្រើស ៤)' },
                  { id: 'short', label: 'Q & A (សំណួរ-ចម្លើយ)' },
                  { id: 'explanation', label: 'ពន្យល់ពាក្យ' },
                ].map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setBulkImportType(t.id as any)}
                    className={`py-2.5 px-2.5 rounded-xl text-xs sm:text-sm font-semibold border transition cursor-pointer ${
                      bulkImportType === t.id
                        ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                        : 'app-subcard app-text-primary hover:opacity-85'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {bulkInputMode === 'text' ? (
              <>
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <span className="text-xs sm:text-sm font-semibold app-text-secondary">ទម្រង់គំរូរហ័ស៖</span>
                  <button
                    type="button"
                    onClick={() => {
                      setBulkImportType('mcq');
                      setBulkText(`១. តើព្រះរាជាណាចក្រកម្ពុជាប្រកាន់យករបបដឹកនាំរដ្ឋបែបណា?
ក. របបរាជានិយមអាស្រ័យរដ្ឋធម្មនុញ្ញ (ចម្លើយត្រឹមត្រូវ)
ខ. របបសាធារណរដ្ឋ
គ. របបប្រជាធិបតេយ្យសេរីពហុបក្ស
ឃ. របបសហព័ន្ធរដ្ឋ
យោង ៖ មាត្រា ១ នៃរដ្ឋធម្មនុញ្ញ ឆ្នាំ១៩៩៣។

២. តើរដ្ឋសភានៃព្រះរាជាណាចក្រកម្ពុជាមានអាណត្តិប៉ុន្មានឆ្នាំ?
ក. ៣ ឆ្នាំ
ខ. ៤ ឆ្នាំ
គ. ៥ ឆ្នាំ (ចម្លើយត្រឹមត្រូវ)
ឃ. ៦ ឆ្នាំ
សម្គាល់ ៖ មាត្រា ៧៨ នៃរដ្ឋធម្មនុញ្ញ។`);
                    }}
                    className="px-3 py-1.5 rounded-lg app-subcard text-blue-700 dark:text-amber-300 text-xs font-semibold hover:opacity-85 transition cursor-pointer"
                  >
                    + គំរូ QCM
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setBulkImportType('short');
                      setBulkText(`១. តើរដ្ឋធម្មនុញ្ញជាអ្វី?
ចម្លើយ ៖ រដ្ឋធម្មនុញ្ញគឺជាច្បាប់កំពូលនៃព្រះរាជាណាចក្រកម្ពុជា។ ច្បាប់ និងសេចក្តីសម្រេចទាំងឡាយនៃស្ថាប័ននានារបស់រដ្ឋ ត្រូវតែស្របទៅនឹងរដ្ឋធម្មនុញ្ញជាដាច់ខាត។

២. តើស្ថាប័នកំពូលនៃអំណាចតុលាការនៅកម្ពុជាជាស្ថាប័នណា?
ចម្លើយ ៖ ឧត្តមក្រុមប្រឹក្សានៃអង្គចៅក្រម និងតុលាការកំពូល។`);
                    }}
                    className="px-3 py-1.5 rounded-lg app-subcard text-emerald-700 dark:text-emerald-300 text-xs font-semibold hover:opacity-85 transition cursor-pointer"
                  >
                    + គំរូ Q & A
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setBulkImportType('explanation');
                      setBulkText(`១. នីតិរដ្ឋ
ចម្លើយ ៖ រដ្ឋដែលគ្រប់គ្រងដោយគោរពតាមគោលការណ៍ច្បាប់ ដោយគ្មានបុគ្គលណាម្នាក់នៅពីលើច្បាប់ឡើយ។

២. អធិបតេយ្យភាព
ចម្លើយ ៖ អំណាចកំពូល និងឯករាជ្យពេញលេញរបស់រដ្ឋក្នុងការសម្រេចកិច្ចការផ្ទៃក្នុង និងកិច្ចការក្រៅប្រទេស។`);
                    }}
                    className="px-3 py-1.5 rounded-lg app-subcard text-purple-700 dark:text-purple-300 text-xs font-semibold hover:opacity-85 transition cursor-pointer"
                  >
                    + គំរូពន្យល់ពាក្យ
                  </button>

                  {bulkText && (
                    <button
                      type="button"
                      onClick={() => setBulkText('')}
                      className="px-3 py-1.5 rounded-lg bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-300 text-xs font-semibold border border-red-300 dark:border-red-700 transition ml-auto cursor-pointer"
                    >
                      សម្អាត (Clear)
                    </button>
                  )}
                </div>

                <textarea
                  rows={9}
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  placeholder={`បិទភ្ជាប់អត្ថបទសំណួររបស់អ្នកនៅទីនេះ...
ឧទាហរណ៍ MCQ៖
១. សំណួរ...
ក. ជម្រើសក
ខ. ជម្រើសខ (ចម្លើយត្រឹមត្រូវ)
គ. ជម្រើសគ
ឃ. ជម្រើសឃ
ចម្លើយ ៖ ខ`}
                  className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm font-mono mb-4"
                />

                <button
                  type="button"
                  onClick={handleParseBulkText}
                  className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm sm:text-base flex items-center justify-center gap-2 transition cursor-pointer"
                >
                  <span>ពិនិត្យ និងបំប្លែងទិន្នន័យ (Parse Preview)</span>
                </button>
              </>
            ) : (
              <>
                <input
                  ref={jsonFileInputRef}
                  type="file"
                  accept=".json,application/json"
                  onChange={handleJsonFileUpload}
                  className="hidden"
                />

                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <button
                    type="button"
                    onClick={() => jsonFileInputRef.current?.click()}
                    className="px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
                  >
                    <Upload className="w-3.5 h-3.5 shrink-0" />
                    <span>ផ្ទុកឯកសារ .json</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setBulkImportType('auto');
                      setBulkJsonText(SAMPLE_EXPORT_JSON_STRING);
                      setBulkStatusMsg(null);
                    }}
                    className="px-3 py-2 rounded-lg app-subcard text-blue-700 dark:text-amber-300 text-xs font-semibold hover:opacity-85 transition cursor-pointer"
                  >
                    + គំរូ Export JSON
                  </button>

                  <button
                    type="button"
                    onClick={() => handleExportJsonFromBulk('selected')}
                    className="px-3 py-2 rounded-lg app-subcard text-emerald-700 dark:text-emerald-300 text-xs font-semibold flex items-center gap-1.5 hover:opacity-85 transition cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5 shrink-0" />
                    <span>Export JSON (មុខវិជ្ជានេះ)</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleExportJsonFromBulk('all')}
                    className="px-3 py-2 rounded-lg app-subcard text-purple-700 dark:text-purple-300 text-xs font-semibold flex items-center gap-1.5 hover:opacity-85 transition cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5 shrink-0" />
                    <span>Export JSON ទាំងអស់</span>
                  </button>

                  {bulkJsonText && (
                    <button
                      type="button"
                      onClick={() => setBulkJsonText('')}
                      className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-300 text-xs font-semibold border border-red-300 dark:border-red-700 transition ml-auto cursor-pointer"
                    >
                      សម្អាត (Clear)
                    </button>
                  )}
                </div>

                <textarea
                  rows={11}
                  value={bulkJsonText}
                  onChange={(e) => setBulkJsonText(e.target.value)}
                  placeholder={`បិទភ្ជាប់ទម្រង់ Export JSON នៅទីនេះ ឬចុច "ផ្ទុកឯកសារ .json" ខាងលើ...
{
  "questions": [
    {
      "subject": "ចំណេះដឹងទូទៅ",
      "type": "mcq",
      "question": "តើរដ្ឋសភាកម្ពុជាមានអាណត្តិប៉ុន្មានឆ្នាំ?",
      "options": ["ក. ៣ ឆ្នាំ", "ខ. ៤ ឆ្នាំ", "គ. ៥ ឆ្នាំ", "ឃ. ៦ ឆ្នាំ"],
      "correct": 2,
      "answer": "យោង ៖ មាត្រា ៧៨ នៃរដ្ឋធម្មនុញ្ញ"
    }
  ]
}`}
                  className="w-full px-3.5 py-2.5 rounded-xl app-input text-xs sm:text-sm font-mono mb-4"
                />

                <button
                  type="button"
                  onClick={() => handleParseJsonImport()}
                  className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm sm:text-base flex items-center justify-center gap-2 transition cursor-pointer"
                >
                  <FileJson className="w-4 h-4" />
                  <span>ពិនិត្យ និងបំប្លែងទិន្នន័យ JSON (Parse JSON Preview)</span>
                </button>
              </>
            )}
          </div>

          {generatedPreview.length > 0 && (() => {
            const previewSubjects = Array.from(
              new Set(
                generatedPreview.map(
                  (q) =>
                    (q.subject || newBulkSubjectName.trim() || bulkSubject || 'មិនទាន់កំណត់').trim()
                )
              )
            );
            const missingSubjectsCount = previewSubjects.filter(
              (subName) => !subjects.some((s) => s.name.trim().toLowerCase() === subName.toLowerCase())
            ).length;

            return (
              <div className="app-card rounded-2xl p-6 sm:p-8 shadow-sm">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6 pb-4 border-b app-border">
                  <div>
                    <h3 className="font-moul text-base text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
                      <CheckCircle2 className="w-5 h-5" />
                      <span>សំណួរដែលបានរៀបចំរួចរាល់ ({toKhmerNum(generatedPreview.length)})</span>
                    </h3>
                    <p className="text-sm app-text-secondary mt-1">
                      មុខវិជ្ជាគោលដៅ៖{' '}
                      <strong className="app-text-primary">
                        {previewSubjects.length === 1
                          ? previewSubjects[0]
                          : `${toKhmerNum(previewSubjects.length)} មុខវិជ្ជា (${previewSubjects.slice(0, 3).join(', ')}${previewSubjects.length > 3 ? '...' : ''})`}
                      </strong>
                      {missingSubjectsCount > 0 &&
                        ` (នឹងបង្កើតមុខវិជ្ជាថ្មី ${toKhmerNum(missingSubjectsCount)} ដោយស្វ័យប្រវត្តិ)`}
                    </p>
                  </div>

                  <button
                    type="button"
                    disabled={isSavingBulkQuestions}
                    onClick={handleSaveGeneratedQuestions}
                    className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-bold text-sm flex items-center justify-center gap-2 transition cursor-pointer disabled:cursor-not-allowed shrink-0"
                  >
                    {isSavingBulkQuestions ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : (
                      <Check className="w-4 h-4" />
                    )}
                    <span>
                      {isSavingBulkQuestions
                        ? 'កំពុងរក្សាទុក...'
                        : 'រក្សាទុកទាំងអស់ទៅក្នុង Database'}
                    </span>
                  </button>
                </div>

              <div className="space-y-3 max-h-[500px] overflow-y-auto pr-1">
                {generatedPreview.map((q, idx) => (
                  <div
                    key={idx}
                    className="p-4 rounded-xl app-subcard text-sm relative"
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2 text-xs font-bold">
                        <span className="tabular-nums app-text-primary">
                          #{toKhmerNum(idx + 1)}
                        </span>
                        <span className="app-text-muted">·</span>
                        <span className="text-blue-700 dark:text-sky-300">
                          {q.type === 'mcq' ? 'QCM' : q.type === 'explanation' ? 'ពន្យល់ពាក្យ' : 'Q & A'}
                        </span>
                        <span className="app-text-muted">·</span>
                        <span className="app-text-secondary">{q.subject}</span>
                      </div>

                      <button
                        type="button"
                        onClick={() => handleRemovePreviewItem(idx)}
                        className="app-text-muted hover:text-red-600 p-1 rounded-lg transition cursor-pointer"
                        title="លុបចេញពីបញ្ជីត្រៀម"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    <p className="font-semibold app-text-primary text-sm sm:text-base mb-2">
                      {q.question}
                    </p>

                    {q.options && q.options.length > 0 && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm pl-2 mt-1">
                        {q.options.map((opt, oIdx) => (
                          <div
                            key={oIdx}
                            className={`px-3 py-1.5 rounded-lg border ${
                              oIdx === q.correct
                                ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-900 dark:text-emerald-200 border-emerald-500 font-semibold'
                                : 'app-card app-text-primary'
                            }`}
                          >
                            <span>{opt}</span>
                            {oIdx === q.correct && ' (ត្រូវ)'}
                          </div>
                        ))}
                      </div>
                    )}

                    {q.answer && (
                      <div className="mt-2 p-3 rounded-xl app-answer-box text-xs sm:text-sm whitespace-pre-wrap">
                        {q.answer}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              </div>
            );
          })()}

          {bulkStatusMsg && (
            <div
              className={`p-4 rounded-xl text-sm flex items-center gap-2 border ${
                bulkStatusMsg.success
                  ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-400 dark:border-emerald-700 text-emerald-900 dark:text-emerald-200'
                  : 'bg-red-50 dark:bg-red-950/60 border-red-400 dark:border-red-700 text-red-900 dark:text-red-200'
              }`}
            >
              {bulkStatusMsg.success ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0" />
              )}
              <span>{bulkStatusMsg.text}</span>
            </div>
          )}
        </div>
      )}

      {/* 3. MANAGE SUBJECTS & QUESTIONS */}
      {activeSubTab === 'manage' && (
        <div className="space-y-8 max-w-5xl mx-auto">
          {/* Add New Subject Panel */}
          <div className="app-card rounded-2xl p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center shrink-0">
                <PlusCircle className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-moul text-base app-text-primary">
                  បន្ថែមមុខវិជ្ជាថ្មី (Add New Subject)
                </h2>
                <p className="text-sm app-text-secondary">
                  បញ្ចូលឈ្មោះមុខវិជ្ជាថ្មី និងជ្រើសរើសប្រភេទសំណួរ (QCM, Q&A ឬ ពន្យល់ពាក្យ)
                </p>
              </div>
            </div>

            {directSubjectStatusMsg && (
              <div
                className={`p-3.5 rounded-xl mb-4 text-sm flex items-center gap-2 border ${
                  directSubjectStatusMsg.success
                    ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-400 dark:border-emerald-700 text-emerald-900 dark:text-emerald-200'
                    : 'bg-red-50 dark:bg-red-950/60 border-red-400 dark:border-red-700 text-red-900 dark:text-red-200'
                }`}
              >
                {directSubjectStatusMsg.success ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0" />
                )}
                <span>{directSubjectStatusMsg.text}</span>
              </div>
            )}

            <form onSubmit={handleAddNewSubjectDirect} className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-semibold app-text-primary mb-1.5">
                  ឈ្មោះមុខវិជ្ជាថ្មី *
                </label>
                <input
                  type="text"
                  value={directSubjectName}
                  onChange={(e) => setDirectSubjectName(e.target.value)}
                  placeholder="ឧ. ភាសាអង់គ្លេស ឬ ច្បាប់ការងារ..."
                  className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-semibold app-text-primary mb-1.5">
                  ប្រភេទសំណួរនៃមុខវិជ្ជានេះ *
                </label>
                <select
                  value={directSubjectType}
                  onChange={(e) => setDirectSubjectType(e.target.value as QuestionType)}
                  className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm"
                >
                  <option value="mcq">QCM (ពហុជ្រើសរើសចម្លើយ)</option>
                  <option value="short">Q & A (សំណួរ-ចម្លើយខ្លី)</option>
                  <option value="explanation">ពន្យល់ពាក្យ (Dictionary)</option>
                </select>
              </div>

              <div className="flex items-end">
                <button
                  type="submit"
                  className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm flex items-center justify-center gap-2 transition cursor-pointer"
                >
                  <PlusCircle className="w-4 h-4" />
                  <span>+ បន្ថែមមុខវិជ្ជាថ្មី</span>
                </button>
              </div>
            </form>
          </div>

          {/* Subjects Table */}
          <div className="app-card rounded-2xl p-6 shadow-sm">
            <h2 className="font-moul text-base app-text-primary mb-4">
              គ្រប់គ្រងមុខវិជ្ជា (Subjects Management)
            </h2>

            {subjects.length > 1 && (
              <div className="p-4 rounded-xl app-subcard mb-5 flex flex-col gap-3 text-sm">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="font-bold app-text-primary flex items-center gap-1.5">
                    <ArrowUpDown className="w-4 h-4 text-blue-600 dark:text-amber-400" />
                    <span>ផ្លាស់ប្ដូរទីតាំងមុខវិជ្ជា៖</span>
                  </span>
                  <select
                    value={subjectSwapFrom}
                    onChange={(e) => setSubjectSwapFrom(Number(e.target.value))}
                    className="px-3 py-1.5 rounded-lg app-input text-sm font-semibold max-w-[240px]"
                    aria-label="ជ្រើសរើសមុខវិជ្ជាដើម"
                  >
                    {subjects.map((s, i) => (
                      <option key={s.id} value={i + 1}>
                        {toKhmerNum(i + 1)}. {s.name}
                      </option>
                    ))}
                  </select>
                  <span className="app-text-secondary">ទៅទីតាំង</span>
                  <select
                    value={subjectSwapTo}
                    onChange={(e) => setSubjectSwapTo(Number(e.target.value))}
                    className="px-3 py-1.5 rounded-lg app-input text-sm font-semibold"
                    aria-label="ជ្រើសរើសលេខរៀងថ្មី"
                  >
                    {subjects.map((s, i) => (
                      <option key={s.id} value={i + 1}>
                        លេខ {toKhmerNum(i + 1)} ({s.name})
                      </option>
                    ))}
                  </select>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={isReorderingSubjects || subjectSwapFrom === subjectSwapTo}
                      onClick={handleMoveSubjectByToolbar}
                      className="px-3.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold transition cursor-pointer disabled:cursor-not-allowed"
                    >
                      រំកិលទៅលេខនេះ
                    </button>
                    <button
                      type="button"
                      disabled={isReorderingSubjects || subjectSwapFrom === subjectSwapTo}
                      onClick={handleSwapSubjectsByToolbar}
                      className="px-3.5 py-1.5 rounded-xl app-card hover:opacity-85 disabled:opacity-50 app-text-primary border app-border font-bold transition cursor-pointer disabled:cursor-not-allowed"
                    >
                      ដោះដូរគ្នា (Swap)
                    </button>
                  </div>
                </div>

                <p className="text-xs app-text-secondary">
                  គន្លឹះ៖ អ្នកអាចចុចប៊ូតុង ↑ / ↓ នៅខាងស្ដាំ ឬអូសទម្លាក់ (Drag & Drop) ជួរមុខវិជ្ជាដោយផ្ទាល់ដើម្បីរៀបចំលំដាប់។
                </p>

                {subjectOrderStatusMsg && (
                  <div
                    className={`w-full p-3 rounded-xl text-sm flex items-center gap-2 border ${
                      subjectOrderStatusMsg.success
                        ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-400 dark:border-emerald-700 text-emerald-900 dark:text-emerald-200'
                        : 'bg-red-50 dark:bg-red-950/60 border-red-400 dark:border-red-700 text-red-900 dark:text-red-200'
                    }`}
                  >
                    {subjectOrderStatusMsg.success ? (
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                    ) : (
                      <AlertCircle className="w-4 h-4 shrink-0" />
                    )}
                    <span>{subjectOrderStatusMsg.text}</span>
                  </div>
                )}
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b app-border app-text-secondary font-bold">
                    <th className="py-3 px-3">ល.រ</th>
                    <th className="py-3 px-3">ឈ្មោះមុខវិជ្ជា</th>
                    <th className="py-3 px-3">ប្រភេទសំណួរ</th>
                    <th className="py-3 px-3">ចំនួនសំណួរ</th>
                    <th className="py-3 px-3">ស្ថានភាព</th>
                    <th className="py-3 px-3 text-right">សកម្មភាព</th>
                  </tr>
                </thead>
                <tbody className="divide-y app-border">
                  {subjects.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center app-text-secondary">
                        មិនទាន់មានមុខវិជ្ជានៅក្នុងប្រព័ន្ធនៅឡើយទេ។ សូមបន្ថែមមុខវិជ្ជាថ្មីខាងលើ ឬបញ្ចូលសំណួរជាដុំ!
                      </td>
                    </tr>
                  ) : (
                    subjects.map((sub, idx) => {
                      const count = questions.filter((q) => q.subject === sub.name).length;
                      const isDragging = draggedSubjectIndex === idx;
                      const isDragOver = dragOverSubjectIndex === idx && draggedSubjectIndex !== idx;
                      return (
                        <tr
                          key={sub.id}
                          draggable={subjects.length > 1 && !isReorderingSubjects}
                          onDragStart={(e) => {
                            setDraggedSubjectIndex(idx);
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('text/plain', sub.id);
                          }}
                          onDragOver={(e) => {
                            e.preventDefault();
                            if (dragOverSubjectIndex !== idx) {
                              setDragOverSubjectIndex(idx);
                            }
                          }}
                          onDragLeave={() => {
                            if (dragOverSubjectIndex === idx) {
                              setDragOverSubjectIndex(null);
                            }
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            void handleSubjectDrop(idx);
                          }}
                          onDragEnd={() => {
                            setDraggedSubjectIndex(null);
                            setDragOverSubjectIndex(null);
                          }}
                          className={`hover:bg-slate-50 dark:hover:bg-slate-800/40 transition ${
                            isDragging ? 'opacity-50' : ''
                          } ${
                            isDragOver ? 'bg-blue-50/80 dark:bg-blue-950/40 ring-2 ring-inset ring-blue-500/60' : ''
                          }`}
                        >
                          <td className="py-3 px-3 font-moul text-blue-700 dark:text-amber-300 tabular-nums whitespace-nowrap">
                            <div className="inline-flex items-center gap-1.5">
                              {subjects.length > 1 && (
                                <GripVertical
                                  className="w-4 h-4 app-text-muted cursor-grab active:cursor-grabbing shrink-0 hidden sm:inline-block"
                                  aria-hidden="true"
                                />
                              )}
                              <span>{toKhmerNum(idx + 1)}</span>
                            </div>
                          </td>
                          <td className="py-3 px-3 font-semibold app-text-primary">{sub.name}</td>
                          <td className="py-3 px-3 text-xs font-bold app-text-secondary whitespace-nowrap">
                            {sub.type === 'mcq' ? 'QCM' : sub.type === 'short' ? 'Q & A' : 'ពន្យល់ពាក្យ'}
                          </td>
                          <td className="py-3 px-3 tabular-nums app-text-primary whitespace-nowrap">{toKhmerNum(count)} សំណួរ</td>
                          <td className="py-3 px-3 whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => void handleToggleSubjectActive(sub)}
                              className={`px-3 py-1 rounded-lg text-xs font-bold cursor-pointer whitespace-nowrap ${
                                sub.isActive !== false
                                  ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-200 border border-emerald-400 dark:border-emerald-700'
                                  : 'app-subcard app-text-muted'
                              }`}
                            >
                              {sub.isActive !== false ? 'បើកដំណើរការ' : 'បានបិទ'}
                            </button>
                          </td>
                          <td className="py-3 px-3 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1.5">
                              {subjects.length > 1 && (
                                <>
                                  <button
                                    type="button"
                                    disabled={idx === 0 || isReorderingSubjects}
                                    onClick={() => void handleMoveSubjectStep(idx, idx - 1)}
                                    className="p-2 min-w-[36px] min-h-[36px] inline-flex items-center justify-center rounded-lg app-subcard app-text-primary hover:opacity-80 disabled:opacity-35 cursor-pointer disabled:cursor-not-allowed"
                                    title="រំកិលមុខវិជ្ជាឡើងលើ"
                                    aria-label={`រំកិល ${sub.name} ឡើងលើ`}
                                  >
                                    <ArrowUp className="w-4 h-4" />
                                  </button>
                                  <button
                                    type="button"
                                    disabled={idx === subjects.length - 1 || isReorderingSubjects}
                                    onClick={() => void handleMoveSubjectStep(idx, idx + 1)}
                                    className="p-2 min-w-[36px] min-h-[36px] inline-flex items-center justify-center rounded-lg app-subcard app-text-primary hover:opacity-80 disabled:opacity-35 cursor-pointer disabled:cursor-not-allowed"
                                    title="រំកិលមុខវិជ្ជាចុះក្រោម"
                                    aria-label={`រំកិល ${sub.name} ចុះក្រោម`}
                                  >
                                    <ArrowDown className="w-4 h-4" />
                                  </button>
                                </>
                              )}
                              <button
                                type="button"
                                onClick={() => handleOpenEditSubjectModal(sub)}
                                className="p-2 min-w-[36px] min-h-[36px] inline-flex items-center justify-center rounded-lg app-subcard app-text-primary hover:opacity-80 cursor-pointer"
                                title="កែប្រែមេរៀន/មុខវិជ្ជា"
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteSubjectClick(sub)}
                                className="p-2 min-w-[36px] min-h-[36px] inline-flex items-center justify-center rounded-lg bg-red-50 dark:bg-red-950/60 hover:opacity-80 text-red-700 dark:text-red-300 border border-red-300 dark:border-red-800 transition cursor-pointer"
                                title="លុបមុខវិជ្ជា និងសំណួរទាំងអស់"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Question List & Swap Tool */}
          <div className="app-card rounded-2xl p-6 shadow-sm">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
              <div>
                <h2 className="font-moul text-base app-text-primary">
                  បញ្ជីសំណួរ និងមុខងារដោះដូរទីតាំង
                </h2>
                <p className="text-sm app-text-secondary">
                  ជ្រើសរើសមុខវិជ្ជាដើម្បីពិនិត្យ កែប្រែ លុប ឬដោះដូរទីតាំងសំណួរ
                </p>
              </div>

              <select
                value={selectedSubjectToManage}
                onChange={(e) => setSelectedSubjectToManage(e.target.value)}
                className="px-3.5 py-2.5 rounded-xl app-input text-sm"
              >
                {subjects.length === 0 ? (
                  <option value="">(មិនទាន់មានមុខវិជ្ជា)</option>
                ) : (
                  subjects.map((s) => (
                    <option key={s.id} value={s.name}>
                      {s.name}
                    </option>
                  ))
                )}
              </select>
            </div>

            <div className="p-4 rounded-xl app-subcard mb-6 flex flex-wrap items-center justify-between gap-3 text-sm">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="font-bold app-text-primary flex items-center gap-1.5">
                  <ArrowUpDown className="w-4 h-4 text-blue-600 dark:text-amber-400" />
                  <span>ដោះដូរទីតាំង (Swap):</span>
                </span>
                <span className="app-text-secondary">ពីលេខ</span>
                <input
                  type="number"
                  min={1}
                  value={swapFromIndex}
                  onChange={(e) => setSwapFromIndex(Number(e.target.value))}
                  className="w-16 px-2 py-1.5 rounded-lg app-input text-center font-bold"
                />
                <span className="app-text-secondary">ទៅលេខ</span>
                <input
                  type="number"
                  min={1}
                  value={swapToIndex}
                  onChange={(e) => setSwapToIndex(Number(e.target.value))}
                  className="w-16 px-2 py-1.5 rounded-lg app-input text-center font-bold"
                />
                <button
                  type="button"
                  onClick={handleSwapQuestions}
                  className="px-4 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold transition cursor-pointer"
                >
                  អនុវត្ត Swap
                </button>
              </div>

              {swapStatusMsg && (
                <div
                  className={`w-full p-3 rounded-xl text-sm flex items-center gap-2 border ${
                    swapStatusMsg.success
                      ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-400 dark:border-emerald-700 text-emerald-900 dark:text-emerald-200'
                      : 'bg-red-50 dark:bg-red-950/60 border-red-400 dark:border-red-700 text-red-900 dark:text-red-200'
                  }`}
                >
                  {swapStatusMsg.success ? (
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                  ) : (
                    <AlertCircle className="w-4 h-4 shrink-0" />
                  )}
                  <span>{swapStatusMsg.text}</span>
                </div>
              )}

              {questions.filter((q) => q.subject === selectedSubjectToManage).length > 0 && (
                <button
                  type="button"
                  onClick={() => handleDeleteAllQuestionsInSubject(selectedSubjectToManage)}
                  className="px-3.5 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold flex items-center gap-1.5 transition text-xs sm:text-sm cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                  <span>
                    លុបសំណួរទាំងអស់ ({toKhmerNum(questions.filter((q) => q.subject === selectedSubjectToManage).length)})
                  </span>
                </button>
              )}
            </div>

            <div className="space-y-3">
              {questions.filter((q) => q.subject === selectedSubjectToManage).length === 0 ? (
                <div className="p-8 text-center app-text-secondary app-subcard rounded-2xl">
                  <p className="text-sm font-medium">មិនទាន់មានសំណួរនៅក្នុងមុខវិជ្ជានេះនៅឡើយទេ។</p>
                  <p className="text-xs app-text-muted mt-1">
                    អ្នកអាចបន្ថែមសំណួរទោល ឬបញ្ចូលសំណួរជាដុំ (Bulk Import) បានគ្រប់ពេល។
                  </p>
                </div>
              ) : (
                questions
                  .filter((q) => q.subject === selectedSubjectToManage)
                  .map((q, idx) => (
                    <div
                      key={q.id || idx}
                      className="p-4 rounded-xl app-subcard flex items-start justify-between gap-4 text-sm"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start gap-2 mb-1">
                          <span className="font-moul text-blue-700 dark:text-amber-300 tabular-nums shrink-0">
                            {toKhmerNum(idx + 1)}.
                          </span>
                          <p className="font-semibold app-text-primary leading-relaxed">{q.question}</p>
                        </div>
                        {q.type === 'mcq' && q.options && (
                          <p className="text-xs sm:text-sm app-text-secondary pl-5 mt-1">
                            ចម្លើយត្រូវ៖{' '}
                            <strong className="text-emerald-700 dark:text-emerald-300">
                              {q.options[q.correct ?? 0]}
                            </strong>
                          </p>
                        )}
                        {q.answer && (
                          <p className="text-xs sm:text-sm app-text-secondary pl-5 truncate max-w-full mt-0.5">
                            {q.answer}
                          </p>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleOpenEditQuestionModal(q)}
                          className="p-2 rounded-lg app-card app-text-primary hover:opacity-80 transition cursor-pointer"
                          title="កែប្រែសំណួរ"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteQuestionClick(q)}
                          className="p-2 rounded-lg bg-red-50 dark:bg-red-950/60 hover:opacity-80 text-red-700 dark:text-red-300 border border-red-300 dark:border-red-800 transition cursor-pointer"
                          title="លុបសំណួរនេះ"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* 4. EXPORT PAPER AS PDF */}
      {activeSubTab === 'export' && (() => {
        const resolvedExportSubject = resolvedExportSubjectName;
        const rawExportCount = rawExportSubjectQuestions.length;
        const exportQuestionsList = selectedExportQuestions;
        const exportTitleLabel =
          resolvedExportSubject === '__ALL__' ? 'គ្រប់មុខវិជ្ជាទាំងអស់' : resolvedExportSubject;
        const safeStartPreview = Math.min(Math.max(1, exportStartIndex), Math.max(1, rawExportCount));

        const activeTpl =
          PDF_TEMPLATES.find((t) => t.id === pdfSettings.template) || PDF_TEMPLATES[0];
        const sizeSpec = PDF_FONT_SIZES[pdfSettings.fontSize] || PDF_FONT_SIZES.medium;
        const bodyFontFamily = `'${pdfSettings.bodyFont}', 'Kantumruy Pro', sans-serif`;
        const titleFontFamily =
          pdfSettings.titleFont === 'Moul' ? `'Moul', serif` : bodyFontFamily;
        const previewDocTitle = pdfSettings.header.documentTitle.trim()
          ? `${pdfSettings.header.documentTitle.trim()}៖ ${exportTitleLabel}`
          : exportTitleLabel;
        const activeAnswerMode: PdfAnswerMode = pdfSettings.answerMode || 'last_page_table';
        const showInlineAnswers = activeAnswerMode === 'inline' || activeAnswerMode === 'both';
        const showLastPageTable =
          activeAnswerMode === 'last_page_table' || activeAnswerMode === 'both';
        const mcqPreviewAnswers = exportQuestionsList
          .map((q, idx) => {
            if (q.type !== 'mcq' || !q.options || q.options.length === 0) return null;
            const cIdx =
              typeof q.correct === 'number' && q.correct >= 0 && q.correct < q.options.length
                ? q.correct
                : 0;
            return {
              num: idx + 1,
              label: getOptionLabel(cIdx, q.subject),
            };
          })
          .filter((item): item is { num: number; label: string } => item !== null);

        return (
          <div className="space-y-6 max-w-5xl mx-auto">
            <div className="app-card rounded-2xl p-6 sm:p-8 shadow-sm space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b app-border">
                <div>
                  <h2 className="font-moul text-base sm:text-lg app-text-primary mb-1">
                    ទាញយកវិញ្ញាសាជា PDF A4 ឬ JSON
                  </h2>
                  <p className="text-sm app-text-secondary">
                    ជ្រើសរើសម៉ូតឯកសារ ពុម្ពអក្សរខ្មែរ កំណត់ក្បាលទំព័រ (Header) / បាតទំព័រ (Footer) ឬ Export ជាឯកសារ JSON
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setPdfSettings(DEFAULT_PDF_SETTINGS)}
                  className="px-3.5 py-2 rounded-xl app-subcard text-xs font-semibold app-text-primary hover:opacity-85 transition cursor-pointer shrink-0"
                >
                  កំណត់លំនាំដើមវិញ (Reset)
                </button>
              </div>

              {exportStatusMsg && (
                <div
                  className={`p-3.5 rounded-xl text-sm flex items-center gap-2 border ${
                    exportStatusMsg.success
                      ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-400 dark:border-emerald-700 text-emerald-900 dark:text-emerald-200'
                      : 'bg-red-50 dark:bg-red-950/60 border-red-400 dark:border-red-700 text-red-900 dark:text-red-200'
                  }`}
                >
                  {exportStatusMsg.success ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0" />
                  )}
                  <span>{exportStatusMsg.text}</span>
                </div>
              )}

              {/* Row 1: Subject & Answer Key */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold app-text-primary mb-1.5">
                    ១. ជ្រើសរើសមុខវិជ្ជា *
                  </label>
                  <select
                    value={resolvedExportSubject}
                    onChange={(e) => setExportSubject(e.target.value)}
                    disabled={isExportingPDF}
                    className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm"
                  >
                    <option value="__ALL__">
                      គ្រប់មុខវិជ្ជាទាំងអស់ ({toKhmerNum(questions.length)} សំណួរ)
                    </option>
                    {subjects.map((s) => {
                      const count = questions.filter((q) => q.subject === s.name).length;
                      return (
                        <option key={s.id} value={s.name}>
                          {s.name} ({toKhmerNum(count)} សំណួរ)
                        </option>
                      );
                    })}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-semibold app-text-primary mb-1.5">
                    ២. ទម្រង់បង្ហាញចម្លើយក្នុង PDF
                  </label>
                  <select
                    value={activeAnswerMode}
                    onChange={(e) =>
                      setPdfSettings((prev) => ({
                        ...prev,
                        answerMode: e.target.value as PdfAnswerMode,
                      }))
                    }
                    disabled={isExportingPDF}
                    className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm"
                  >
                    <option value="last_page_table">
                      បង្កើតតារាងចម្លើយនៅទំព័រចុងក្រោយបង្អស់ (ងាយផ្ទៀងផ្ទាត់)
                    </option>
                    <option value="both">
                      បង្ហាញក្រោមសំណួរ + តារាងចម្លើយនៅទំព័រចុងក្រោយ
                    </option>
                    <option value="inline">
                      បង្ហាញចម្លើយក្រោមសំណួរនីមួយៗប៉ុណ្ណោះ
                    </option>
                    <option value="none">
                      លាក់ចម្លើយទាំងអស់ (សម្រាប់បោះពុម្ពវិញ្ញាសាប្រឡង)
                    </option>
                  </select>
                </div>
              </div>

              {/* Row 2: Question Count, Presets, Start Range / Random */}
              <div className="app-subcard rounded-2xl p-4 sm:p-5 space-y-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-bold app-text-primary">
                    ៣. កំណត់ចំនួនសំណួរត្រូវទាញយក
                  </h3>
                  <span className="text-xs font-semibold text-blue-700 dark:text-amber-300 tabular-nums">
                    {rawExportCount === 0
                      ? 'មិនមានសំណួរ'
                      : exportOrderMode === 'random'
                        ? `ជ្រើសយកដោយចៃដន្យ៖ ${toKhmerNum(exportQuestionsList.length)} / ${toKhmerNum(rawExportCount)} សំណួរ`
                        : `ជ្រើសយក៖ ${toKhmerNum(exportQuestionsList.length)} / ${toKhmerNum(rawExportCount)} សំណួរ (លេខ ${toKhmerNum(safeStartPreview)} - ${toKhmerNum(safeStartPreview + exportQuestionsList.length - 1)})`}
                  </span>
                </div>

                {/* Preset Count Buttons */}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={isExportingPDF || rawExportCount === 0}
                    onClick={() => {
                      setExportCountLimit('all');
                      setExportStartIndex(1);
                    }}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition cursor-pointer disabled:opacity-50 ${
                      exportCountLimit === 'all'
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'app-card app-text-primary hover:opacity-85'
                    }`}
                  >
                    ទាំងអស់ ({toKhmerNum(rawExportCount)})
                  </button>
                  {[10, 20, 30, 50, 100].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      disabled={isExportingPDF || rawExportCount === 0}
                      onClick={() => setExportCountLimit(preset)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition cursor-pointer disabled:opacity-50 tabular-nums ${
                        exportCountLimit === preset
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'app-card app-text-primary hover:opacity-85'
                      }`}
                    >
                      {toKhmerNum(preset)} សំណួរ
                    </button>
                  ))}
                </div>

                {/* Custom Count, Order Mode, Start Index / Shuffle */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-semibold app-text-secondary mb-1">
                      បញ្ចូលចំនួនសំណួរផ្ទាល់ (១ - {toKhmerNum(Math.max(1, rawExportCount))})
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={Math.max(1, rawExportCount)}
                      disabled={isExportingPDF || rawExportCount === 0}
                      placeholder={rawExportCount > 0 ? `${rawExportCount} (ទាំងអស់)` : '0'}
                      value={exportCountLimit === 'all' ? '' : exportCountLimit}
                      onChange={(e) => {
                        const rawVal = e.target.value;
                        if (!rawVal) {
                          setExportCountLimit('all');
                          return;
                        }
                        const num = Math.max(1, parseInt(rawVal, 10) || 1);
                        if (rawExportCount > 0 && num >= rawExportCount) {
                          setExportCountLimit('all');
                        } else {
                          setExportCountLimit(num);
                        }
                      }}
                      className="w-full px-3 py-2 rounded-xl app-input text-sm tabular-nums"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold app-text-secondary mb-1">
                      វិធីជ្រើសរើសសំណួរ
                    </label>
                    <select
                      value={exportOrderMode}
                      onChange={(e) =>
                        setExportOrderMode(e.target.value as 'sequential' | 'random')
                      }
                      disabled={isExportingPDF || rawExportCount === 0}
                      className="w-full px-3 py-2 rounded-xl app-input text-sm"
                    >
                      <option value="sequential">តាមលំដាប់ (ចាប់ពីលេខ...)</option>
                      <option value="random">ជ្រើសរើសដោយចៃដន្យ (Random)</option>
                    </select>
                  </div>

                  {exportOrderMode === 'sequential' ? (
                    <div>
                      <label className="block text-xs font-semibold app-text-secondary mb-1">
                        ចាប់ពីសំណួរទី (លេខរៀងដើម)
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={Math.max(1, rawExportCount)}
                        disabled={isExportingPDF || rawExportCount === 0 || exportCountLimit === 'all'}
                        value={exportCountLimit === 'all' ? 1 : safeStartPreview}
                        onChange={(e) => {
                          const num = Math.max(1, parseInt(e.target.value, 10) || 1);
                          setExportStartIndex(num);
                        }}
                        className="w-full px-3 py-2 rounded-xl app-input text-sm tabular-nums disabled:opacity-60"
                      />
                    </div>
                  ) : (
                    <div className="flex items-end">
                      <button
                        type="button"
                        disabled={isExportingPDF || rawExportCount === 0}
                        onClick={() => setExportShuffleSeed((s) => s + 1)}
                        className="w-full px-3 py-2 rounded-xl app-card border text-xs sm:text-sm font-semibold app-text-primary hover:opacity-85 transition flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                      >
                        <Shuffle className="w-4 h-4 text-blue-600 dark:text-amber-400" />
                        <span>ច្របល់សំណួរម្ដងទៀត</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Row 3: Template Gallery (6 Styles) */}
              <div>
                <label className="block text-sm font-semibold app-text-primary mb-2.5">
                  ៤. ជ្រើសរើសម៉ូតឯកសារ PDF ({toKhmerNum(PDF_TEMPLATES.length)} ម៉ូត)
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {PDF_TEMPLATES.map((tpl) => {
                    const isSelected = pdfSettings.template === tpl.id;
                    return (
                      <button
                        key={tpl.id}
                        type="button"
                        disabled={isExportingPDF}
                        onClick={() =>
                          setPdfSettings((prev) => ({
                            ...prev,
                            template: tpl.id as PdfTemplateId,
                            pageBorder: tpl.defaultBorder,
                          }))
                        }
                        className={`p-3.5 rounded-xl border-2 text-left transition cursor-pointer ${
                          isSelected
                            ? 'app-subcard border-blue-600 dark:border-amber-400 shadow-sm'
                            : 'app-card hover:opacity-90'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 mb-1.5">
                          <div className="flex items-center gap-1.5">
                            <span
                              className="w-4 h-4 rounded-full border border-slate-300 shrink-0"
                              style={{ backgroundColor: tpl.accent }}
                            />
                            <span
                              className="w-4 h-4 rounded-full border border-slate-300 shrink-0"
                              style={{ backgroundColor: tpl.divider }}
                            />
                            <span
                              className="w-4 h-4 rounded-full border border-slate-300 shrink-0"
                              style={{ backgroundColor: tpl.pageBg }}
                            />
                          </div>
                          {isSelected && (
                            <CheckCircle2 className="w-4 h-4 text-blue-600 dark:text-amber-400 shrink-0" />
                          )}
                        </div>
                        <p className="font-bold text-xs sm:text-sm app-text-primary truncate">
                          {tpl.nameKhmer}
                        </p>
                        <p className="text-xs app-text-secondary truncate mt-0.5">
                          {tpl.descKhmer}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Row 4: Khmer Fonts, Title Font, Font Size & Page Frame */}
              <div className="app-subcard rounded-2xl p-4 sm:p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-bold app-text-primary">
                    ៥. កំណត់ពុម្ពអក្សរខ្មែរ (Font Khmer) និងទម្រង់ទំព័រ
                  </h3>
                  <label className="flex items-center gap-2 text-xs font-semibold app-text-primary cursor-pointer bg-blue-50 dark:bg-amber-950/50 border border-blue-200 dark:border-amber-700/60 px-3 py-1.5 rounded-xl">
                    <input
                      type="checkbox"
                      checked={pdfSettings.includeCoverPage !== false}
                      disabled={isExportingPDF}
                      onChange={(e) =>
                        setPdfSettings((prev) => ({
                          ...prev,
                          includeCoverPage: e.target.checked,
                        }))
                      }
                      className="w-4 h-4 rounded"
                    />
                    <span>បង្ហាញទំព័រមុខ (Cover Page រចនាបថខ្មែរ) នៅទំព័រទី ១</span>
                  </label>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
                  <div>
                    <label className="block text-xs font-semibold app-text-secondary mb-1.5">
                      ពុម្ពអក្សរខ្មែរ (ខ្លឹមសារសំណួរ)
                    </label>
                    <select
                      value={pdfSettings.bodyFont}
                      onChange={(e) =>
                        setPdfSettings((prev) => ({
                          ...prev,
                          bodyFont: e.target.value as PdfKhmerFontId,
                        }))
                      }
                      disabled={isExportingPDF}
                      className="w-full px-3 py-2 rounded-xl app-input text-sm"
                    >
                      {PDF_KHMER_FONTS.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.label} ({f.note})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold app-text-secondary mb-1.5">
                      ពុម្ពអក្សរចំណងជើង (Header)
                    </label>
                    <select
                      value={pdfSettings.titleFont}
                      onChange={(e) =>
                        setPdfSettings((prev) => ({
                          ...prev,
                          titleFont: e.target.value as PdfTitleFontId,
                        }))
                      }
                      disabled={isExportingPDF}
                      className="w-full px-3 py-2 rounded-xl app-input text-sm"
                    >
                      <option value="Moul">អក្សរមូល (Moul) — ផ្លូវការ</option>
                      <option value="same">ប្រើដូចពុម្ពអក្សរខ្លឹមសារ</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold app-text-secondary mb-1.5">
                      ទំហំអក្សរ (Font Size)
                    </label>
                    <select
                      value={pdfSettings.fontSize}
                      onChange={(e) =>
                        setPdfSettings((prev) => ({
                          ...prev,
                          fontSize: e.target.value as PdfFontSizeId,
                        }))
                      }
                      disabled={isExportingPDF}
                      className="w-full px-3 py-2 rounded-xl app-input text-sm"
                    >
                      {(Object.keys(PDF_FONT_SIZES) as PdfFontSizeId[]).map((sz) => (
                        <option key={sz} value={sz}>
                          {PDF_FONT_SIZES[sz].label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold app-text-secondary mb-1.5">
                      ស៊ុមជុំវិញទំព័រ A4
                    </label>
                    <select
                      value={pdfSettings.pageBorder}
                      onChange={(e) =>
                        setPdfSettings((prev) => ({
                          ...prev,
                          pageBorder: e.target.value as PdfPageBorderId,
                        }))
                      }
                      disabled={isExportingPDF}
                      className="w-full px-3 py-2 rounded-xl app-input text-sm"
                    >
                      <option value="none">គ្មានស៊ុម (សាមញ្ញ)</option>
                      <option value="single">ស៊ុមបន្ទាត់ទោល</option>
                      <option value="double">ស៊ុមពីរជាន់ (ផ្លូវការ/បុរាណ)</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Row 5: Customizable Header & Footer */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Header Settings */}
                <div className="app-subcard rounded-2xl p-4 sm:p-5 space-y-3.5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-bold app-text-primary">
                      ៦. កំណត់ក្បាលទំព័រ (Header)
                    </h3>
                    <label className="flex items-center gap-2 text-xs font-semibold app-text-primary cursor-pointer">
                      <input
                        type="checkbox"
                        checked={pdfSettings.header.showHeader}
                        onChange={(e) =>
                          setPdfSettings((prev) => ({
                            ...prev,
                            header: { ...prev.header, showHeader: e.target.checked },
                          }))
                        }
                        className="w-4 h-4 rounded"
                      />
                      <span>បង្ហាញ Header</span>
                    </label>
                  </div>

                  {pdfSettings.header.showHeader && (
                    <div className="space-y-3">
                      <div className="flex flex-wrap gap-4">
                        <label className="flex items-center gap-2 text-xs app-text-secondary cursor-pointer">
                          <input
                            type="checkbox"
                            checked={pdfSettings.header.showNationalMotto}
                            onChange={(e) =>
                              setPdfSettings((prev) => ({
                                ...prev,
                                header: { ...prev.header, showNationalMotto: e.target.checked },
                              }))
                            }
                            className="w-4 h-4 rounded"
                          />
                          <span>បង្ហាញបាវចនាជាតិ</span>
                        </label>

                        <label className="flex items-center gap-2 text-xs app-text-secondary cursor-pointer">
                          <input
                            type="checkbox"
                            checked={pdfSettings.header.showCandidateBox}
                            onChange={(e) =>
                              setPdfSettings((prev) => ({
                                ...prev,
                                header: { ...prev.header, showCandidateBox: e.target.checked },
                              }))
                            }
                            className="w-4 h-4 rounded"
                          />
                          <span>បន្ថែមប្រអប់ឈ្មោះបេក្ខជន</span>
                        </label>
                      </div>

                      {pdfSettings.header.showNationalMotto && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                          <div>
                            <label className="block text-xs app-text-secondary mb-1">
                              បន្ទាត់លើ (ប្រទេស/ក្រសួង)
                            </label>
                            <input
                              type="text"
                              value={pdfSettings.header.line1}
                              onChange={(e) =>
                                setPdfSettings((prev) => ({
                                  ...prev,
                                  header: { ...prev.header, line1: e.target.value },
                                }))
                              }
                              className="w-full px-3 py-2 rounded-xl app-input text-xs sm:text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-xs app-text-secondary mb-1">
                              បន្ទាត់ក្រោម (បាវចនា)
                            </label>
                            <input
                              type="text"
                              value={pdfSettings.header.line2}
                              onChange={(e) =>
                                setPdfSettings((prev) => ({
                                  ...prev,
                                  header: { ...prev.header, line2: e.target.value },
                                }))
                              }
                              className="w-full px-3 py-2 rounded-xl app-input text-xs sm:text-sm"
                            />
                          </div>
                        </div>
                      )}

                      <div>
                        <label className="block text-xs app-text-secondary mb-1">
                          ចំណងជើងវិញ្ញាសា (នាំមុខឈ្មោះមុខវិជ្ជា)
                        </label>
                        <input
                          type="text"
                          value={pdfSettings.header.documentTitle}
                          onChange={(e) =>
                            setPdfSettings((prev) => ({
                              ...prev,
                              header: { ...prev.header, documentTitle: e.target.value },
                            }))
                          }
                          placeholder="វិញ្ញាសាត្រៀមប្រឡងក្របខ័ណ្ឌរដ្ឋ"
                          className="w-full px-3 py-2 rounded-xl app-input text-xs sm:text-sm"
                        />
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        <div>
                          <label className="block text-xs app-text-secondary mb-1">
                            ឈ្មោះអង្គភាព / សាលា
                          </label>
                          <input
                            type="text"
                            value={pdfSettings.header.organization}
                            onChange={(e) =>
                              setPdfSettings((prev) => ({
                                ...prev,
                                header: { ...prev.header, organization: e.target.value },
                              }))
                            }
                            placeholder="ប្រព័ន្ធ Master Quiz KH"
                            className="w-full px-3 py-2 rounded-xl app-input text-xs sm:text-sm"
                          />
                        </div>
                        <div>
                          <label className="block text-xs app-text-secondary mb-1">
                            ក្បាលទំព័របន្ត (ទំព័រទី ២+)
                          </label>
                          <input
                            type="text"
                            value={pdfSettings.header.runningHeader}
                            onChange={(e) =>
                              setPdfSettings((prev) => ({
                                ...prev,
                                header: { ...prev.header, runningHeader: e.target.value },
                              }))
                            }
                            placeholder="(ស្វ័យប្រវត្តិតាមឈ្មោះវិញ្ញាសា)"
                            className="w-full px-3 py-2 rounded-xl app-input text-xs sm:text-sm"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Footer Settings */}
                <div className="app-subcard rounded-2xl p-4 sm:p-5 space-y-3.5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-bold app-text-primary">
                      ៧. កំណត់បាតទំព័រ (Footer)
                    </h3>
                    <label className="flex items-center gap-2 text-xs font-semibold app-text-primary cursor-pointer">
                      <input
                        type="checkbox"
                        checked={pdfSettings.footer.showFooter}
                        onChange={(e) =>
                          setPdfSettings((prev) => ({
                            ...prev,
                            footer: { ...prev.footer, showFooter: e.target.checked },
                          }))
                        }
                        className="w-4 h-4 rounded"
                      />
                      <span>បង្ហាញ Footer</span>
                    </label>
                  </div>

                  {pdfSettings.footer.showFooter && (
                    <div className="space-y-3">
                      <label className="flex items-center gap-2 text-xs app-text-secondary cursor-pointer">
                        <input
                          type="checkbox"
                          checked={pdfSettings.footer.showPageNumbers}
                          onChange={(e) =>
                            setPdfSettings((prev) => ({
                              ...prev,
                              footer: { ...prev.footer, showPageNumbers: e.target.checked },
                            }))
                          }
                          className="w-4 h-4 rounded"
                        />
                        <span>បង្ហាញលេខទំព័រស្វ័យប្រវត្តិ (ទំព័រទី ១ / N)</span>
                      </label>

                      <div>
                        <label className="block text-xs app-text-secondary mb-1">
                          អក្សរបាតទំព័រផ្នែកខាងឆ្វេង
                        </label>
                        <input
                          type="text"
                          value={pdfSettings.footer.leftText}
                          onChange={(e) =>
                            setPdfSettings((prev) => ({
                              ...prev,
                              footer: { ...prev.footer, leftText: e.target.value },
                            }))
                          }
                          placeholder="ឧ. Master Quiz KH · សម្រាប់សិក្សាសាធារណៈ"
                          className="w-full px-3 py-2 rounded-xl app-input text-xs sm:text-sm"
                        />
                      </div>

                      <div>
                        <label className="block text-xs app-text-secondary mb-1">
                          អក្សរបាតទំព័រផ្នែកខាងស្ដាំ (បន្ថែម)
                        </label>
                        <input
                          type="text"
                          value={pdfSettings.footer.rightText}
                          onChange={(e) =>
                            setPdfSettings((prev) => ({
                              ...prev,
                              footer: { ...prev.footer, rightText: e.target.value },
                            }))
                          }
                          placeholder="ឧ. រៀបរៀងដោយ... ឬ ឆ្នាំសិក្សា ២០២៦"
                          className="w-full px-3 py-2 rounded-xl app-input text-xs sm:text-sm"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-3">
                <button
                  type="button"
                  onClick={handleExportPDF}
                  disabled={isExportingPDF || exportQuestionsList.length === 0}
                  className="w-full py-3.5 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold text-sm sm:text-base flex items-center justify-center gap-2 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {isExportingPDF ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <Download className="w-4 h-4" />
                  )}
                  <span>
                    {isExportingPDF
                      ? pdfProgress
                        ? `កំពុងបង្កើត PDF ទំព័រ ${toKhmerNum(pdfProgress.current)}/${toKhmerNum(pdfProgress.total)}...`
                        : 'កំពុងរៀបចំឯកសារ PDF...'
                      : `ទាញយកវិញ្ញាសាជា PDF (A4) · ${toKhmerNum(exportQuestionsList.length)} សំណួរ`}
                  </span>
                </button>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => handleExportJSON('filtered')}
                    disabled={exportQuestionsList.length === 0}
                    className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm flex items-center justify-center gap-2 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <FileJson className="w-4 h-4 shrink-0" />
                    <span>Export JSON (តាមជម្រើស · {toKhmerNum(exportQuestionsList.length)} សំណួរ)</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleExportJSON('all')}
                    disabled={questions.length === 0}
                    className="w-full py-3 rounded-xl app-subcard hover:opacity-85 app-text-primary border app-border font-bold text-sm flex items-center justify-center gap-2 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <Download className="w-4 h-4 shrink-0" />
                    <span>Export JSON ទាំងអស់ ({toKhmerNum(questions.length)} សំណួរ)</span>
                  </button>
                </div>

                {/* Full Firebase -> Supabase Migration & Full Backup Section */}
                <div className="pt-4 mt-4 border-t app-border space-y-4">
                  {/* Database Mode Selector Card */}
                  <div className="p-4 rounded-2xl app-subcard border app-border space-y-3">
                    <div>
                      <h4 className="font-bold text-sm app-text-primary flex items-center gap-2">
                        <Layers className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                        <span>ជ្រើសរើសរបៀបដំណើរការ Database (Backend Mode)</span>
                      </h4>
                      <p className="text-xs app-text-muted mt-1 leading-relaxed">
                        អ្នកអាចកំណត់ឱ្យប្រព័ន្ធដំណើរការលើ Supabase, Firebase (Firestore) ឬដំណើរការទ្វេរដងព្រមគ្នា (Dual-Sync)។ រាល់ការលុប ឬបន្ថែមទិន្នន័យ នឹងធ្វើសមកាលកម្មទាំង Firebase និង Supabase ដោយស្វ័យប្រវត្តិ។
                      </p>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      {[
                        { id: 'dual', label: 'Dual-Sync (ទាំងពីរ)' },
                        { id: 'supabase', label: 'Supabase ទាំងស្រុង' },
                        { id: 'firestore', label: 'Firebase ទាំងស្រុង' },
                      ].map((item) => {
                        const isActive = dbMode === item.id;
                        return (
                          <button
                            type="button"
                            key={item.id}
                            disabled={isChangingMode}
                            onClick={() => handleSelectDbMode(item.id as DbModeType)}
                            className={`py-2.5 px-3 rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50 ${
                              isActive
                                ? 'khmer-btn-crimson shadow-sm'
                                : 'app-subcard hover:opacity-85 app-text-primary border app-border'
                            }`}
                          >
                            {isActive && <Check className="w-3.5 h-3.5 shrink-0" />}
                            <span>{item.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <h4 className="font-bold text-sm app-text-primary flex items-center gap-2">
                      <Cloud className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                      <span>ផ្ទេរ និងបម្រុងទុកទិន្នន័យទាំងអស់ (Firebase ⇄ Supabase)</span>
                    </h4>
                    <p className="text-xs app-text-muted mt-1 leading-relaxed">
                      ផ្ទេរមុខវិជ្ជា សំណួរ ដំណឹង សមាជិក VIP មតិយោបល់ ប្រវត្តិ Login និង Bot Commands ទាំងអស់ទៅ Supabase ឬទាញយកឯកសារ Backup ពេញលេញ (.json)។
                    </p>
                  </div>

                  <input
                    ref={backupImportFileRef}
                    type="file"
                    accept="application/json,.json"
                    onChange={handleImportFullBackupFile}
                    className="hidden"
                  />

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onClick={handleMigrateAllToSupabase}
                      disabled={isMigratingDb}
                      className="w-full py-3 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs sm:text-sm flex items-center justify-center gap-2 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {isMigratingDb ? (
                        <RefreshCw className="w-4 h-4 animate-spin shrink-0" />
                      ) : (
                        <Cloud className="w-4 h-4 shrink-0" />
                      )}
                      <span>ផ្ទេរទិន្នន័យ Firebase → Supabase ទាំងអស់</span>
                    </button>

                    <button
                      type="button"
                      onClick={handleCopySupabaseSchemaSql}
                      disabled={isMigratingDb}
                      className="w-full py-3 px-3 rounded-xl app-subcard hover:opacity-85 app-text-primary border app-border font-bold text-xs sm:text-sm flex items-center justify-center gap-2 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    >
                      <FileText className="w-4 h-4 shrink-0" />
                      <span>ចម្លង SQL បង្កើតតារា (schema.sql)</span>
                    </button>

                    <button
                      type="button"
                      onClick={handleExportFullBackupJson}
                      disabled={isMigratingDb}
                      className="w-full py-3 px-3 rounded-xl app-subcard hover:opacity-85 app-text-primary border app-border font-bold text-xs sm:text-sm flex items-center justify-center gap-2 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    >
                      <Download className="w-4 h-4 shrink-0" />
                      <span>ទាញយក Backup ទាំងអស់ (.json)</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => backupImportFileRef.current?.click()}
                      disabled={isMigratingDb}
                      className="w-full py-3 px-3 rounded-xl app-subcard hover:opacity-85 app-text-primary border app-border font-bold text-xs sm:text-sm flex items-center justify-center gap-2 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    >
                      <Upload className="w-4 h-4 shrink-0" />
                      <span>បញ្ចូល Backup ទៅ Supabase (.json)</span>
                    </button>
                  </div>

                  {isMigratingDb && migrationProgressText && (
                    <div className="px-3.5 py-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200 text-xs flex items-center gap-2">
                      <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />
                      <span>{migrationProgressText}</span>
                    </div>
                  )}

                  {migrationStatusMsg && (
                    <div
                      className={`px-3.5 py-2.5 rounded-xl text-xs font-medium flex items-start gap-2 border ${
                        migrationStatusMsg.success
                          ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
                          : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200'
                      }`}
                    >
                      {migrationStatusMsg.success ? (
                        <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                      ) : (
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      )}
                      <span>{migrationStatusMsg.text}</span>
                    </div>
                  )}

                  {schemaSqlPreview && (
                    <div className="p-3 rounded-xl app-subcard border app-border space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-bold app-text-primary">
                          កូដ SQL សម្រាប់ Supabase SQL Editor (ចាប់ផ្ដើមដោយ -- Master Quiz KH)
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={async () => {
                              const ok = await copyTextSafe(schemaSqlPreview);
                              if (ok) {
                                setMigrationStatusMsg({
                                  text: 'បានចម្លង SQL ម្ដងទៀតជោគជ័យ!',
                                  success: true,
                                });
                              }
                            }}
                            className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-bold cursor-pointer"
                          >
                            ចម្លង SQL
                          </button>
                          <button
                            type="button"
                            onClick={() => setSchemaSqlPreview(null)}
                            className="p-1 rounded-lg app-text-muted hover:opacity-80 cursor-pointer"
                            title="បិទ"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                      <textarea
                        readOnly
                        value={schemaSqlPreview}
                        onFocus={(e) => e.currentTarget.select()}
                        rows={7}
                        className="w-full p-2.5 rounded-lg app-input text-[11px] font-mono leading-relaxed"
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Live Printable Preview Container */}
            <div
              id="admin-printable-pdf"
              className="p-8 sm:p-10 rounded-3xl text-slate-900 border shadow-xl relative overflow-hidden"
              style={{
                backgroundColor: activeTpl.pageBg,
                fontFamily: bodyFontFamily,
              }}
            >
              {pdfSettings.pageBorder === 'single' && (
                <div
                  className="absolute inset-3 rounded-xl pointer-events-none"
                  style={{ border: `1.5px solid ${activeTpl.accent}` }}
                />
              )}
              {pdfSettings.pageBorder === 'double' && (
                <div
                  className="absolute inset-3 rounded-xl pointer-events-none"
                  style={{ border: `4px double ${activeTpl.divider}` }}
                />
              )}

              <div className="relative z-10">
                {/* Preview Cover Page (Page 1 - Khmer Style) */}
                {pdfSettings.includeCoverPage !== false && (
                  <div className="mb-10 pb-8 border-b-2 border-dashed border-slate-300">
                    <div className="text-center mb-3">
                      <span className="inline-block px-3 py-1 rounded-full text-[11px] font-bold bg-slate-100 text-slate-600">
                        ទំព័រទី ១៖ ទំព័រមុខរចនាបថខ្មែរ (Khmer Cover Page)
                      </span>
                    </div>

                    <div
                      className="relative p-8 sm:p-12 rounded-2xl overflow-hidden flex flex-col justify-between min-h-[540px]"
                      style={{
                        backgroundColor: activeTpl.pageBg,
                        border: `2.5px solid ${activeTpl.accent}`,
                        boxShadow: `inset 0 0 0 5px ${activeTpl.pageBg}, inset 0 0 0 6px ${activeTpl.divider}`,
                      }}
                    >
                      {/* 4 Traditional Khmer Kbach Corner Ornaments */}
                      {[
                        'top-2 left-2',
                        'top-2 right-2 rotate-90',
                        'bottom-2 right-2 rotate-180',
                        'bottom-2 left-2 -rotate-90',
                      ].map((posClass, idx) => (
                        <svg
                          key={idx}
                          className={`absolute ${posClass} pointer-events-none`}
                          width="64"
                          height="64"
                          viewBox="0 0 96 96"
                          fill="none"
                        >
                          <path
                            d="M4 90 L4 4 L90 4"
                            stroke={activeTpl.accent}
                            strokeWidth="2.4"
                            strokeLinecap="square"
                          />
                          <path
                            d="M11 86 L11 11 L86 11"
                            stroke={activeTpl.divider}
                            strokeWidth="1.3"
                            strokeLinecap="square"
                          />
                          <path
                            d="M15 24 C17 15, 24 14, 34 15 C25 20, 20 25, 15 34 C14 24, 15 24, 15 24 Z"
                            fill={activeTpl.divider}
                            fillOpacity="0.22"
                            stroke={activeTpl.accent}
                            strokeWidth="1.6"
                          />
                          <path d="M18 18 L28 18 L24 24 L18 28 Z" fill={activeTpl.accent} />
                          <path
                            d="M35 15 C45 10, 54 16, 62 11 C57 18, 49 20, 41 19"
                            stroke={activeTpl.accent}
                            strokeWidth="1.4"
                            strokeLinecap="round"
                          />
                          <path
                            d="M15 35 C10 45, 16 54, 11 62 C18 57, 20 49, 19 41"
                            stroke={activeTpl.accent}
                            strokeWidth="1.4"
                            strokeLinecap="round"
                          />
                        </svg>
                      ))}

                      {/* Cover Top: National Motto & Org */}
                      <div className="relative z-10 text-center space-y-1">
                        {pdfSettings.header.showNationalMotto && (
                          <>
                            {pdfSettings.header.line1.trim() && (
                              <p
                                className="text-base sm:text-lg"
                                style={{ fontFamily: titleFontFamily, color: activeTpl.kingdom }}
                              >
                                {pdfSettings.header.line1}
                              </p>
                            )}
                            {pdfSettings.header.line2.trim() && (
                              <p
                                className="text-xs font-bold tracking-wider text-slate-700"
                                style={{ fontFamily: bodyFontFamily }}
                              >
                                {pdfSettings.header.line2}
                              </p>
                            )}
                            <div className="flex justify-center py-1.5">
                              <svg width="200" height="20" viewBox="0 0 260 24" fill="none">
                                <line x1="8" y1="12" x2="104" y2="12" stroke={activeTpl.divider} strokeWidth="1.5" />
                                <line x1="156" y1="12" x2="252" y2="12" stroke={activeTpl.divider} strokeWidth="1.5" />
                                <path
                                  d="M130 3 L139 12 L130 21 L121 12 Z"
                                  fill={activeTpl.divider}
                                  fillOpacity="0.25"
                                  stroke={activeTpl.accent}
                                  strokeWidth="1.5"
                                />
                                <path d="M130 7 L135 12 L130 17 L125 12 Z" fill={activeTpl.accent} />
                              </svg>
                            </div>
                          </>
                        )}
                        <p
                          className="text-xs sm:text-sm font-bold"
                          style={{ color: activeTpl.accent }}
                        >
                          {pdfSettings.header.organization.trim() ||
                            'ប្រព័ន្ធគ្រប់គ្រង និងធ្វើតេស្ត Master Quiz KH'}
                        </p>
                      </div>

                      {/* Cover Center: Hero Title Cartouche */}
                      <div
                        className="relative z-10 my-6 p-6 sm:p-8 rounded-2xl text-center"
                        style={{
                          backgroundColor: activeTpl.answerBg,
                          border: `2px solid ${activeTpl.accent}`,
                          boxShadow: `inset 0 0 0 4px ${activeTpl.pageBg}, inset 0 0 0 5px ${activeTpl.divider}`,
                        }}
                      >
                        <div className="flex justify-center mb-2.5">
                          <svg width="96" height="48" viewBox="0 0 120 60" fill="none">
                            <path
                              d="M60 4 C65 16, 68 26, 60 40 C52 26, 55 16, 60 4 Z"
                              fill={activeTpl.divider}
                              fillOpacity="0.25"
                              stroke={activeTpl.accent}
                              strokeWidth="1.8"
                            />
                            <path
                              d="M60 12 C62.5 20, 63.5 27, 60 36 C56.5 27, 57.5 20, 60 12 Z"
                              fill={activeTpl.accent}
                            />
                            <path
                              d="M54 36 C45 26, 38 19, 28 21 C34 29, 41 36, 50 40"
                              fill={activeTpl.divider}
                              fillOpacity="0.18"
                              stroke={activeTpl.accent}
                              strokeWidth="1.5"
                              strokeLinejoin="round"
                            />
                            <path
                              d="M66 36 C75 26, 82 19, 92 21 C86 29, 79 36, 70 40"
                              fill={activeTpl.divider}
                              fillOpacity="0.18"
                              stroke={activeTpl.accent}
                              strokeWidth="1.5"
                              strokeLinejoin="round"
                            />
                            <path d="M26 49 L94 49" stroke={activeTpl.accent} strokeWidth="1.6" strokeLinecap="round" />
                            <path d="M60 44 L65 49 L60 54 L55 49 Z" fill={activeTpl.divider} stroke={activeTpl.accent} strokeWidth="1.2" />
                          </svg>
                        </div>

                        <p
                          className="text-xs sm:text-sm font-bold mb-1.5"
                          style={{ color: activeTpl.accent }}
                        >
                          {pdfSettings.header.documentTitle.trim() ||
                            'វិញ្ញាសាត្រៀមប្រឡងក្របខ័ណ្ឌរដ្ឋ'}
                        </p>

                        <h2
                          className="text-xl sm:text-2xl leading-relaxed"
                          style={{ fontFamily: titleFontFamily, color: activeTpl.heading }}
                        >
                          {exportTitleLabel}
                        </h2>

                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 mt-5">
                          <div
                            className="bg-white rounded-xl p-2.5 border"
                            style={{ borderColor: activeTpl.divider }}
                          >
                            <p className="text-[11px] text-slate-500 font-semibold">ចំនួនសំណួរ</p>
                            <p className="text-xs sm:text-sm font-bold mt-0.5" style={{ color: activeTpl.accent }}>
                              {toKhmerNum(exportQuestionsList.length)} សំណួរ
                            </p>
                          </div>
                          <div
                            className="bg-white rounded-xl p-2.5 border"
                            style={{ borderColor: activeTpl.divider }}
                          >
                            <p className="text-[11px] text-slate-500 font-semibold">ប្រភេទវិញ្ញាសា</p>
                            <p className="text-xs font-bold mt-0.5" style={{ color: activeTpl.heading }}>
                              {getPdfQuestionTypeSummary(exportQuestionsList)}
                            </p>
                          </div>
                          <div
                            className="bg-white rounded-xl p-2.5 border"
                            style={{ borderColor: activeTpl.divider }}
                          >
                            <p className="text-[11px] text-slate-500 font-semibold">ទម្រង់ចម្លើយ</p>
                            <p className="text-xs font-bold mt-0.5" style={{ color: activeTpl.correctText }}>
                              {getPdfAnswerModeSummary(activeAnswerMode)}
                            </p>
                          </div>
                        </div>

                        {pdfSettings.header.showCandidateBox && (
                          <div
                            className="mt-4 p-3 rounded-xl bg-white border text-left text-xs text-slate-800 grid grid-cols-1 sm:grid-cols-2 gap-1.5"
                            style={{ borderColor: activeTpl.divider }}
                          >
                            <span>ឈ្មោះបេក្ខជន៖ .................................</span>
                            <span>លេខតុ / បន្ទប់៖ ........................</span>
                            <span>កាលបរិច្ឆេទ៖ ...................................</span>
                            <span>ពិន្ទុសរុប៖ ...............................</span>
                          </div>
                        )}
                      </div>

                      {/* Cover Bottom: Attribution */}
                      <div className="relative z-10 text-center space-y-1">
                        <p className="text-xs font-bold" style={{ color: activeTpl.heading }}>
                          {pdfSettings.footer.rightText.trim() ||
                            'ឯកសារជំនួយការសិក្សា និងត្រៀមប្រឡងផ្លូវការ'}
                        </p>
                        <p className="text-[11px] text-slate-500">
                          {pdfSettings.footer.leftText.trim() ||
                            'Master Quiz KH · ប្រព័ន្ធត្រៀមប្រឡងក្របខ័ណ្ឌរដ្ឋ'}
                        </p>
                      </div>
                    </div>

                    <div className="text-center mt-6">
                      <span className="inline-block px-3 py-1 rounded-full text-[11px] font-bold bg-slate-100 text-slate-600">
                        ទំព័រទី ២ តទៅ៖ ខ្លឹមសារសំណួរ
                      </span>
                    </div>
                  </div>
                )}

                {/* Preview Header */}
                {pdfSettings.header.showHeader && (
                  <div
                    className="text-center pb-5 mb-6"
                    style={{ borderBottom: `2px solid ${activeTpl.accent}` }}
                  >
                    {pdfSettings.includeCoverPage === false && pdfSettings.header.showNationalMotto && (
                      <>
                        {pdfSettings.header.line1.trim() && (
                          <p
                            className="text-base"
                            style={{ fontFamily: titleFontFamily, color: activeTpl.kingdom }}
                          >
                            {pdfSettings.header.line1}
                          </p>
                        )}
                        {pdfSettings.header.line2.trim() && (
                          <p
                            className="text-xs text-slate-700 font-bold tracking-wider mt-1"
                            style={{ fontFamily: bodyFontFamily }}
                          >
                            {pdfSettings.header.line2}
                          </p>
                        )}
                        <div
                          className="w-24 h-0.5 mx-auto my-2"
                          style={{ backgroundColor: activeTpl.divider }}
                        />
                      </>
                    )}

                    <h2
                      className="text-lg mt-1"
                      style={{ fontFamily: titleFontFamily, color: activeTpl.heading }}
                    >
                      {previewDocTitle}
                    </h2>

                    {pdfSettings.header.organization.trim() && (
                      <p className="text-xs text-slate-600 mt-1">
                        {pdfSettings.header.organization} · សរុប {toKhmerNum(exportQuestionsList.length)} សំណួរ
                      </p>
                    )}

                    {pdfSettings.header.showCandidateBox && (
                      <div className="mt-4 p-2.5 rounded-lg border border-slate-300 bg-slate-50 flex flex-wrap justify-between gap-2 text-xs text-slate-800 text-left">
                        <span>ឈ្មោះបេក្ខជន៖ ....................................</span>
                        <span>កាលបរិច្ឆេទ៖ .....................</span>
                        <span>ពិន្ទុ៖ ...........</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Questions list */}
                {exportQuestionsList.length === 0 ? (
                  <p className="text-center text-sm text-slate-500 py-10">
                    មិនទាន់មានសំណួរនៅក្នុងមុខវិជ្ជានេះសម្រាប់បង្ហាញ ឬទាញយកជា PDF នៅឡើយទេ។
                  </p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: `${sizeSpec.spacingPx}px` }}>
                    {exportQuestionsList.map((q, idx) => (
                      <div key={q.id || idx} className="pb-3 border-b border-dashed border-slate-200">
                        <p
                          className="font-semibold text-slate-900 leading-relaxed"
                          style={{ fontSize: `${sizeSpec.qPx}px` }}
                        >
                          <span style={{ color: activeTpl.accent }}>{toKhmerNum(idx + 1)}.</span>{' '}
                          {q.question}
                        </p>
                        {q.type === 'mcq' && q.options && (
                          <div
                            className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 mt-1.5 pl-4"
                            style={{ fontSize: `${sizeSpec.optPx}px` }}
                          >
                            {q.options.map((opt, oIdx) => {
                              const isCorrect = showInlineAnswers && oIdx === q.correct;
                              return (
                                <span
                                  key={oIdx}
                                  className="px-2 py-0.5 rounded"
                                  style={
                                    isCorrect
                                      ? {
                                          backgroundColor: activeTpl.correctBg,
                                          color: activeTpl.correctText,
                                          border: `1px solid ${activeTpl.correctBorder}`,
                                          fontWeight: 700,
                                        }
                                      : { color: '#1e293b' }
                                  }
                                >
                                  {getOptionLabel(oIdx, q.subject)}. {opt.replace(/^[ក-ឃA-D]\.\s*/, '')}
                                </span>
                              );
                            })}
                          </div>
                        )}
                        {showInlineAnswers && q.answer && (
                          <div
                            className="mt-2 ml-4 p-2.5 rounded-lg border whitespace-pre-line leading-relaxed"
                            style={{
                              fontSize: `${sizeSpec.ansPx}px`,
                              backgroundColor: activeTpl.answerBg,
                              borderColor: activeTpl.answerBorder,
                              color: activeTpl.answerText,
                            }}
                          >
                            {q.answer}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Preview: Last-Page Answer Key Table */}
                {showLastPageTable && exportQuestionsList.length > 0 && (
                  <div className="mt-8 pt-6 border-t-2 border-dashed border-slate-300 space-y-5">
                    <div className="text-center">
                      <span className="inline-block px-3 py-1 rounded-full text-[11px] font-bold bg-slate-100 text-slate-600 mb-3">
                        ទំព័រចុងក្រោយបង្អស់ (ផ្ដាច់ទំព័រថ្មីក្នុង PDF)
                      </span>
                      <div
                        className="p-3.5 rounded-xl text-center"
                        style={{
                          backgroundColor: activeTpl.answerBg,
                          border: `1.5px solid ${activeTpl.accent}`,
                        }}
                      >
                        <h3
                          className="text-base"
                          style={{ fontFamily: titleFontFamily, color: activeTpl.accent }}
                        >
                          តារាងផ្ទៀងផ្ទាត់ចម្លើយផ្លូវការ
                        </h3>
                        <p className="text-xs text-slate-700 mt-0.5">
                          វិញ្ញាសា៖ <strong>{exportTitleLabel}</strong> · សរុប{' '}
                          {toKhmerNum(exportQuestionsList.length)} សំណួរ
                        </p>
                      </div>
                    </div>

                    {mcqPreviewAnswers.length > 0 && (
                      <div>
                        <p
                          className="text-xs font-bold mb-2 flex items-center gap-1.5"
                          style={{ color: activeTpl.heading }}
                        >
                          <span
                            className="w-2 h-2 rounded-sm inline-block"
                            style={{ backgroundColor: activeTpl.accent }}
                          />
                          <span>តារាងចម្លើយរហ័ស (ពហុជ្រើសរើស)</span>
                        </p>
                        <div className="grid grid-cols-2 sm:grid-cols-5 border-t border-l border-slate-300 text-xs">
                          {mcqPreviewAnswers.map((item) => (
                            <div
                              key={item.num}
                              className="border-r border-b border-slate-300 px-2 py-1.5 text-center bg-white"
                            >
                              <span className="font-bold text-slate-700">
                                {toKhmerNum(item.num)}.
                              </span>
                              <span
                                className="inline-block ml-1.5 px-2 py-0.5 rounded font-bold"
                                style={{
                                  backgroundColor: activeTpl.correctBg,
                                  color: activeTpl.correctText,
                                  border: `1px solid ${activeTpl.correctBorder}`,
                                }}
                              >
                                {item.label}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div>
                      <p
                        className="text-xs font-bold mb-2 flex items-center gap-1.5"
                        style={{ color: activeTpl.heading }}
                      >
                        <span
                          className="w-2 h-2 rounded-sm inline-block"
                          style={{ backgroundColor: activeTpl.accent }}
                        />
                        <span>តារាងផ្ទៀងផ្ទាត់ចម្លើយលម្អិត និងការបកស្រាយ</span>
                      </p>
                      <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-xs">
                          <thead>
                            <tr style={{ backgroundColor: activeTpl.accent, color: '#ffffff' }}>
                              <th className="border border-slate-300 px-2 py-2 text-center w-12">
                                ល.រ
                              </th>
                              <th className="border border-slate-300 px-3 py-2 text-left w-[42%]">
                                សំណួរ
                              </th>
                              <th className="border border-slate-300 px-3 py-2 text-left">
                                ចម្លើយត្រឹមត្រូវ / ការបកស្រាយ
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {exportQuestionsList.map((q, idx) => {
                              const cIdx =
                                q.type === 'mcq' && q.options && q.options.length > 0
                                  ? typeof q.correct === 'number' &&
                                    q.correct >= 0 &&
                                    q.correct < q.options.length
                                    ? q.correct
                                    : 0
                                  : -1;
                              const mcqLabel = cIdx >= 0 ? getOptionLabel(cIdx, q.subject) : '';
                              const mcqText =
                                cIdx >= 0
                                  ? (q.options?.[cIdx] || '').replace(/^[ក-ឃA-D]\.\s*/, '')
                                  : '';
                              return (
                                <tr
                                  key={q.id || idx}
                                  className={idx % 2 === 1 ? 'bg-slate-50' : 'bg-white'}
                                >
                                  <td
                                    className="border border-slate-300 px-2 py-1.5 text-center font-bold align-top"
                                    style={{ color: activeTpl.accent }}
                                  >
                                    {toKhmerNum(idx + 1)}
                                  </td>
                                  <td className="border border-slate-300 px-3 py-1.5 text-slate-900 align-top">
                                    {q.question}
                                  </td>
                                  <td className="border border-slate-300 px-3 py-1.5 align-top">
                                    {cIdx >= 0 ? (
                                      <>
                                        <div
                                          className="font-bold"
                                          style={{ color: activeTpl.correctText }}
                                        >
                                          <span
                                            className="inline-block px-1.5 rounded mr-1"
                                            style={{
                                              backgroundColor: activeTpl.correctBg,
                                              border: `1px solid ${activeTpl.correctBorder}`,
                                            }}
                                          >
                                            {mcqLabel}
                                          </span>
                                          {mcqText}
                                        </div>
                                        {q.answer?.trim() && (
                                          <p className="text-slate-700 mt-1 whitespace-pre-line">
                                            {q.answer.trim()}
                                          </p>
                                        )}
                                      </>
                                    ) : (
                                      <div
                                        className="font-semibold whitespace-pre-line"
                                        style={{ color: activeTpl.answerText }}
                                      >
                                        {q.answer?.trim() || '—'}
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )}

                {/* Preview Footer */}
                {pdfSettings.footer.showFooter && (
                  <div className="mt-8 pt-2.5 border-t border-slate-200 flex flex-wrap justify-between gap-2 text-[11px] text-slate-500">
                    <span>{pdfSettings.footer.leftText}</span>
                    <span>
                      {[
                        pdfSettings.footer.rightText.trim(),
                        pdfSettings.footer.showPageNumbers ? 'ទំព័រទី ១ / N' : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* 5. TELEGRAM BOT INTEGRATION */}
      {activeSubTab === 'telegram' && (
        <div className="khmer-ornate-card rounded-2xl p-6 sm:p-8 max-w-4xl mx-auto space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b app-border">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl khmer-btn-primary flex items-center justify-center shrink-0">
                <Send className="w-6 h-6" />
              </div>
              <div>
                <h2 className="font-moul text-base sm:text-lg app-text-primary">
                  Telegram Bot Integration
                </h2>
                <p className="text-sm app-text-secondary">
                  ផ្ញើសំណួរទៅកាន់ Telegram Channel/Group ជា ៣ ទម្រង់៖ Text, Quiz Poll និងរូបភាព
                </p>
              </div>
            </div>
            {tgBotInfo && (
              <div className="text-xs sm:text-sm font-mono font-bold text-emerald-700 dark:text-emerald-300">
                ភ្ជាប់រួច៖ {tgBotInfo}
              </div>
            )}
          </div>

          {telegramStatus && (
            <div
              className={`p-4 rounded-xl text-sm flex items-center gap-3 border ${
                telegramStatus.success
                  ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-400 dark:border-emerald-700 text-emerald-900 dark:text-emerald-200'
                  : 'bg-red-50 dark:bg-red-950/60 border-red-400 dark:border-red-700 text-red-900 dark:text-red-200'
              }`}
            >
              {telegramStatus.success ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
              ) : (
                <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0" />
              )}
              <div className="flex-1 font-medium leading-relaxed">{telegramStatus.text}</div>
            </div>
          )}

          {/* Section 1: Bot Credentials */}
          <div className="app-subcard rounded-2xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold app-text-primary flex items-center gap-2">
                <Radio className="w-4 h-4 khmer-accent-text" />
                <span>ការកំណត់ការតភ្ជាប់ Telegram Bot</span>
              </h3>
              <button
                type="button"
                onClick={handleTestTelegramConnection}
                disabled={isTestingBot || isSendingTelegram}
                className="px-3.5 py-2 rounded-xl app-card text-xs sm:text-sm font-semibold khmer-accent-text hover:opacity-80 transition flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
              >
                <RefreshCw className={`w-4 h-4 ${isTestingBot ? 'animate-spin' : ''}`} />
                <span>{isTestingBot ? 'កំពុងតភ្ជាប់...' : 'សាកល្បងតភ្ជាប់ (Test Bot)'}</span>
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-semibold app-text-primary mb-1.5">
                  Telegram Bot Token *
                </label>
                <input
                  type="text"
                  value={tgBotToken}
                  onChange={(e) => {
                    const val = e.target.value;
                    setTgBotToken(val);
                    localStorage.setItem('master_quiz_tg_token', val.trim());
                  }}
                  placeholder={
                    commandBotStatus?.hasServerToken
                      ? 'បានភ្ជាប់ Token រួចរាល់លើ Server (ស្រេចចិត្តបើចង់ប្ដូរ)'
                      : '123456789:ABCdefGhIJKlmNoPQRstuVWXyz'
                  }
                  className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm font-mono"
                />
                <p className="text-xs app-text-secondary mt-1.5">
                  {commandBotStatus?.hasServerToken && !tgBotToken.trim() ? (
                    <span className="text-emerald-700 dark:text-emerald-300 font-semibold">
                      ✅ Bot Token ត្រូវបានកំណត់លើ Server រួចរាល់ (@{commandBotStatus.botUsername || 'qiuzs_bot'})
                    </span>
                  ) : (
                    'ទទួលបានពី @BotFather នៅលើ Telegram'
                  )}
                </p>
              </div>

              <div>
                <label className="block text-sm font-semibold app-text-primary mb-1.5">
                  Chat ID ឬ Channel(s) *
                </label>
                <input
                  type="text"
                  value={tgChatId}
                  onChange={(e) => {
                    const val = e.target.value;
                    setTgChatId(val);
                    localStorage.setItem('master_quiz_tg_chat', val.trim());
                  }}
                  placeholder="ឧ. @master_quiz_kh_Channel, 700259660"
                  className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm font-mono"
                />
                <p className="text-xs app-text-secondary mt-1.5">
                  អាចបញ្ចូលច្រើនគោលដៅ (ដកឃ្លា ឬក្បៀស) ឬបិទភ្ជាប់ Link https://t.me/... ដោយផ្ទាល់
                </p>
              </div>
            </div>

            {/* Preset & Custom Telegram Destinations Checklist */}
            <div className="pt-3 border-t app-border space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs sm:text-sm font-bold app-text-primary">
                  គោលដៅ Telegram ដែលត្រូវផ្ញើចេញ ({toKhmerNum(resolveActiveTelegramTargets().length)} បានជ្រើស)
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => persistTgTargets(tgTargets.map((t) => ({ ...t, enabled: true })), true)}
                    className="px-2.5 py-1 rounded-lg app-card text-xs font-semibold app-text-primary hover:opacity-80 cursor-pointer"
                  >
                    ជ្រើសទាំងអស់
                  </button>
                  <button
                    type="button"
                    onClick={() => persistTgTargets(tgTargets.map((t) => ({ ...t, enabled: false })), true)}
                    className="px-2.5 py-1 rounded-lg app-card text-xs font-semibold app-text-secondary hover:opacity-80 cursor-pointer"
                  >
                    ដកទាំងអស់
                  </button>
                  <button
                    type="button"
                    onClick={() => persistTgTargets(DEFAULT_TELEGRAM_TARGETS, true)}
                    className="px-2.5 py-1 rounded-lg app-card text-xs font-semibold khmer-accent-text hover:opacity-80 cursor-pointer"
                  >
                    ស្ដារលំនាំដើម (៤)
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {tgTargets.map((target) => (
                  <div
                    key={target.id}
                    className={`px-3 py-2 rounded-xl border flex items-center justify-between gap-2 transition ${
                      target.enabled
                        ? 'app-card border-[var(--theme-accent)]'
                        : 'app-card border-transparent opacity-65'
                    }`}
                  >
                    <label className="flex items-center gap-2.5 cursor-pointer select-none min-w-0 flex-1">
                      <input
                        type="checkbox"
                        checked={target.enabled}
                        onChange={() => handleToggleTgTarget(target.id)}
                        disabled={isSendingTelegram}
                        className="w-4 h-4 rounded accent-[var(--theme-accent)] shrink-0"
                      />
                      <div className="min-w-0">
                        <div className="text-xs sm:text-sm font-mono font-bold app-text-primary truncate">
                          {target.chatId}
                        </div>
                        {target.label && target.label !== target.chatId && (
                          <div className="text-[11px] app-text-secondary truncate">
                            {target.label}
                          </div>
                        )}
                      </div>
                    </label>
                    <button
                      type="button"
                      onClick={() => handleRemoveTgTarget(target.id)}
                      disabled={isSendingTelegram}
                      aria-label={`លុប ${target.chatId}`}
                      className="w-7 h-7 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/50 text-stone-400 hover:text-red-600 flex items-center justify-center cursor-pointer shrink-0"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>

              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  value={newTgTargetInput}
                  onChange={(e) => setNewTgTargetInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddTgTarget();
                    }
                  }}
                  placeholder="បន្ថែមគោលដៅថ្មី (ឧ. https://t.me/... ឬ -100... ឬ User ID)"
                  className="flex-1 px-3 py-2 rounded-xl app-input text-xs sm:text-sm font-mono"
                />
                <button
                  type="button"
                  onClick={handleAddTgTarget}
                  disabled={!newTgTargetInput.trim() || isSendingTelegram}
                  className="px-4 py-2 rounded-xl app-card text-xs sm:text-sm font-bold khmer-accent-text hover:opacity-85 disabled:opacity-45 cursor-pointer whitespace-nowrap"
                >
                  + បន្ថែមគោលដៅ
                </button>
              </div>
            </div>
          </div>

          {/* Section 1.5: Command Bot Auto-Reply & Slash Command Setup */}
          <div className="app-subcard rounded-2xl p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold app-text-primary flex items-center gap-2">
                  <Bot className="w-4 h-4 khmer-accent-text shrink-0" />
                  <span>Command Bot (ណែនាំអំពីការចុះឈ្មោះដោយស្វ័យប្រវត្តិ)</span>
                </h3>
                <p className="text-xs sm:text-sm app-text-secondary mt-1">
                  បើកឱ្យ Bot ឆ្លើយតបស្វ័យប្រវត្តិលើ Telegram ពេលអ្នកប្រើប្រាស់វាយ Command ដូចជា <code className="font-mono font-bold">/start</code> ឬ <code className="font-mono font-bold">/register</code>
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent('open-command-bot', { detail: { command: '/register' } })
                    )
                  }
                  className="px-3.5 py-2 rounded-xl app-card text-xs font-bold khmer-accent-text hover:opacity-85 transition cursor-pointer whitespace-nowrap"
                >
                  សាកល្បង Bot លើកម្មវិធី
                </button>
                <button
                  type="button"
                  onClick={handleRegisterBotCommands}
                  disabled={isUpdatingCommandBot}
                  className="px-3.5 py-2 rounded-xl app-card text-xs font-bold app-text-primary hover:opacity-85 transition disabled:opacity-50 cursor-pointer whitespace-nowrap"
                >
                  ចុះឈ្មោះបញ្ជី Command
                </button>
                <button
                  type="button"
                  onClick={handleToggleCommandBot}
                  disabled={isUpdatingCommandBot}
                  className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 disabled:opacity-50 cursor-pointer whitespace-nowrap ${
                    commandBotStatus?.isRunning
                      ? 'khmer-btn-crimson'
                      : 'khmer-btn-primary'
                  }`}
                >
                  <Bot className="w-3.5 h-3.5" />
                  <span>
                    {isUpdatingCommandBot
                      ? 'កំពុងដំណើរការ...'
                      : commandBotStatus?.isRunning
                      ? 'ផ្អាក Command Bot'
                      : 'បើក Command Bot Auto-Reply'}
                  </span>
                </button>
              </div>
            </div>

            {commandBotStatus && (
              <div className="p-3 rounded-xl app-card space-y-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-semibold">
                    {commandBotStatus.isRunning ? (
                      <span className="text-emerald-700 dark:text-emerald-300">
                        កំពុងដំណើរការ (@{commandBotStatus.botUsername || 'Bot'})
                      </span>
                    ) : (
                      <span className="app-text-muted">មិនទាន់បើក Auto-Reply លើ Telegram (សូមបញ្ចូល Bot Token រួចចុចបើក)</span>
                    )}
                    <span className="app-text-muted">·</span>
                    <span className="app-text-secondary tabular-nums">
                      ឆ្លើយតបបាន៖ {toKhmerNum(commandBotStatus.handledCount)} ដង
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    {commandBotStatus.lastCommandText && (
                      <span className="font-mono app-text-secondary">
                        ចុងក្រោយ៖ {commandBotStatus.lastCommandText}
                      </span>
                    )}
                    {commandBotStatus.isRunning && commandBotStatus.botUsername && (
                      <a
                        href={`https://t.me/${commandBotStatus.botUsername}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-bold khmer-accent-text hover:underline"
                      >
                        បើក @{commandBotStatus.botUsername}
                      </a>
                    )}
                  </div>
                </div>
                {commandBotStatus.lastError && (
                  <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/60 border border-red-300 dark:border-red-700 text-red-800 dark:text-red-200 font-mono text-xs">
                    កំហុស Bot៖ {commandBotStatus.lastError}
                  </div>
                )}
              </div>
            )}

            <div className="pt-2 border-t app-border space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h4 className="text-xs sm:text-sm font-bold app-text-primary">
                    កែប្រែខ្លឹមសារ Command Bot ទាំង {toKhmerNum(mergedBotCommands.length)}
                  </h4>
                  <p className="text-xs app-text-secondary">
                    រាល់ការកែប្រែនឹងធ្វើបច្ចុប្បន្នភាពភ្លាមៗទាំងលើ Bot ក្នុងកម្មវិធី និង Telegram @qiuzs_bot
                  </p>
                </div>

                {customizedBotCommandsCount > 0 && (
                  <button
                    type="button"
                    onClick={handleResetAllBotCommandsClick}
                    className="px-3 py-1.5 rounded-xl app-card text-xs font-bold text-amber-700 dark:text-amber-300 hover:opacity-85 transition flex items-center gap-1.5 cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>កំណត់លំនាំដើមទាំងអស់ ({toKhmerNum(customizedBotCommandsCount)})</span>
                  </button>
                )}
              </div>

              {botEditorStatusMsg && (
                <div
                  className={`p-3 rounded-xl text-xs sm:text-sm flex items-center gap-2 border ${
                    botEditorStatusMsg.success
                      ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-400 dark:border-emerald-700 text-emerald-900 dark:text-emerald-200'
                      : 'bg-red-50 dark:bg-red-950/60 border-red-400 dark:border-red-700 text-red-900 dark:text-red-200'
                  }`}
                >
                  {botEditorStatusMsg.success ? (
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                  ) : (
                    <AlertCircle className="w-4 h-4 shrink-0" />
                  )}
                  <span className="font-medium">{botEditorStatusMsg.text}</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {mergedBotCommands.map((c) => {
                  const isCustomized = Boolean(botCommands[c.command]);
                  return (
                    <div
                      key={c.command}
                      className="p-3 rounded-xl app-card border app-border flex flex-col justify-between gap-2.5 hover:border-[var(--theme-accent)] transition"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono font-bold text-xs sm:text-sm khmer-accent-text">
                            {c.command}
                          </span>
                          {isCustomized && (
                            <span className="px-2 py-0.5 rounded-md bg-amber-50 dark:bg-amber-950/60 border border-amber-300 dark:border-amber-700 text-[10px] font-bold text-amber-800 dark:text-amber-200">
                              បានកែប្រែ
                            </span>
                          )}
                        </div>
                        <div className="text-xs font-semibold app-text-primary line-clamp-1">
                          {c.title}
                        </div>
                        <div className="text-xs app-text-secondary leading-snug line-clamp-2">
                          {c.descriptionKh}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 pt-2 border-t app-border">
                        <button
                          type="button"
                          onClick={() => openBotCommandEditor(c)}
                          className="flex-1 py-1.5 px-2.5 rounded-lg khmer-btn-primary text-xs font-bold flex items-center justify-center gap-1 cursor-pointer"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                          <span>កែប្រែខ្លឹមសារ</span>
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            window.dispatchEvent(
                              new CustomEvent('open-command-bot', { detail: { command: c.command } })
                            )
                          }
                          title={`សាកល្បង ${c.command}`}
                          className="py-1.5 px-2.5 rounded-lg app-subcard text-xs font-semibold app-text-primary hover:opacity-80 flex items-center justify-center gap-1 cursor-pointer"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>សាកល្បង</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Section 2: Mode Tabs */}
          <div className="flex border-b app-border">
            <button
              type="button"
              onClick={() => {
                if (!isSendingTelegram && tgSendMode === 'single_poll') {
                  setTgSendMode('batch_cards');
                }
              }}
              className={`flex items-center gap-2 px-4 py-3 border-b-2 font-bold text-xs sm:text-sm transition cursor-pointer ${
                tgSendMode !== 'single_poll'
                  ? 'border-[var(--theme-accent)] khmer-accent-text'
                  : 'border-transparent app-text-secondary hover:opacity-80'
              }`}
            >
              <Layers className="w-4 h-4" />
              <span>ផ្ញើម្ដងមួយៗតាមមុខវិជ្ជា (Auto)</span>
            </button>

            <button
              type="button"
              onClick={() => {
                if (!isSendingTelegram) {
                  setTgSendMode('single_poll');
                  const pool = tgSubject === '__ALL__' ? questions : questions.filter((q) => q.subject === tgSubject);
                  if (pool.length > 0 && !pool.some((q) => q.id === tgSelectedQuestionId)) {
                    setTgSelectedQuestionId(pool[0].id || '');
                  }
                }
              }}
              className={`flex items-center gap-2 px-4 py-3 border-b-2 font-bold text-xs sm:text-sm transition cursor-pointer ${
                tgSendMode === 'single_poll'
                  ? 'border-[var(--theme-accent)] khmer-accent-text'
                  : 'border-transparent app-text-secondary hover:opacity-80'
              }`}
            >
              <Send className="w-4 h-4" />
              <span>ផ្ញើម្ដងមួយសំណួរដោយដៃ (Manual)</span>
            </button>
          </div>

          {tgSendMode !== 'single_poll' ? (
            <div className="space-y-6">
              <div className="app-subcard rounded-2xl p-5 space-y-4">
                <label className="text-sm font-bold app-text-primary flex items-center gap-2">
                  <BookOpen className="w-4 h-4 khmer-gold-text" />
                  <span>ជំហានទី ១៖ ជ្រើសរើសមុខវិជ្ជាដើម្បីផ្ញើម្ដងមួយៗ *</span>
                </label>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="sm:col-span-2">
                    <select
                      value={tgSubject}
                      onChange={(e) => setTgSubject(e.target.value)}
                      disabled={isSendingTelegram}
                      className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm"
                    >
                      <option value="__ALL__">គ្រប់មុខវិជ្ជាទាំងអស់ (All Subjects)</option>
                      {subjects.map((s) => {
                        const count = questions.filter((q) => q.subject === s.name).length;
                        return (
                          <option key={s.id || s.name} value={s.name}>
                            {s.name} ({toKhmerNum(count)} សំណួរ)
                          </option>
                        );
                      })}
                    </select>
                  </div>

                  {(() => {
                    const filtered =
                      tgSubject === '__ALL__'
                        ? questions
                        : questions.filter((q) => q.subject === tgSubject);
                    const mcqCount = filtered.filter((q) => q.type === 'mcq').length;
                    const qaCount = filtered.filter((q) => q.type === 'short').length;
                    const wordCount = filtered.filter((q) => q.type === 'explanation').length;

                    return (
                      <div className="flex items-center justify-around app-card px-3 py-2 rounded-xl text-center">
                        <div>
                          <div className="text-sm font-bold text-blue-700 dark:text-sky-300 tabular-nums">
                            {toKhmerNum(filtered.length)}
                          </div>
                          <div className="text-xs app-text-secondary">សរុប</div>
                        </div>
                        <div className="w-px h-6 app-border border-l" />
                        <div>
                          <div className="text-sm font-bold text-amber-700 dark:text-amber-300 tabular-nums">
                            {toKhmerNum(mcqCount)}
                          </div>
                          <div className="text-xs app-text-secondary">QCM</div>
                        </div>
                        <div className="w-px h-6 app-border border-l" />
                        <div>
                          <div className="text-sm font-bold text-emerald-700 dark:text-emerald-300 tabular-nums">
                            {toKhmerNum(qaCount + wordCount)}
                          </div>
                          <div className="text-xs app-text-secondary">Q&A</div>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>

              <div className="app-subcard rounded-2xl p-5 space-y-4">
                <label className="block text-sm font-bold app-text-primary">
                  ជំហានទី ២៖ ជ្រើសរើសទម្រង់នៃការផ្ញើ (៣ ជម្រើស) *
                </label>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {/* Option 1: Text */}
                  <div
                    onClick={() => !isSendingTelegram && setTgSendMode('batch_cards')}
                    className={`p-4 rounded-xl border-2 transition cursor-pointer flex flex-col justify-between ${
                      tgSendMode === 'batch_cards'
                        ? 'app-card border-[var(--theme-accent)] ring-1 ring-[var(--theme-gold)]/45 shadow-sm'
                        : 'app-card opacity-85 hover:opacity-100'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-bold khmer-accent-text flex items-center gap-1.5">
                          <FileText className="w-4 h-4 shrink-0" />
                          <span>១. ផ្ញើជា Text</span>
                        </span>
                        {tgSendMode === 'batch_cards' && (
                          <span className="text-xs font-bold text-emerald-700 dark:text-emerald-300">
                            បានជ្រើស ✓
                          </span>
                        )}
                      </div>
                      <p className="text-xs sm:text-sm app-text-secondary leading-relaxed">
                        ភ្ជាប់រូបភាពកម្មវិធី Master Quiz KH ជាមួយអត្ថបទសំណួរ ជម្រើស ក-ឃ និងលាក់ចម្លើយត្រឹមត្រូវ (Spoiler)។
                      </p>
                    </div>
                  </div>

                  {/* Option 2: Poll */}
                  <div
                    onClick={() => !isSendingTelegram && setTgSendMode('batch_polls')}
                    className={`p-4 rounded-xl border-2 transition cursor-pointer flex flex-col justify-between ${
                      tgSendMode === 'batch_polls'
                        ? 'app-card border-[var(--theme-accent)] ring-1 ring-[var(--theme-gold)]/45 shadow-sm'
                        : 'app-card opacity-85 hover:opacity-100'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-bold khmer-accent-text flex items-center gap-1.5">
                          <ListChecks className="w-4 h-4 shrink-0" />
                          <span>២. ផ្ញើជា Poll</span>
                        </span>
                        {tgSendMode === 'batch_polls' && (
                          <span className="text-xs font-bold text-emerald-700 dark:text-emerald-300">
                            បានជ្រើស ✓
                          </span>
                        )}
                      </div>
                      <p className="text-xs sm:text-sm app-text-secondary leading-relaxed">
                        បាញ់សំណួរ QCM ជា Telegram Quiz Poll (ជម្រើស A. B. C. D. · លាក់ឈ្មោះអ្នកចុច · ភ្ជាប់ Explain & ឯកសារយោង)។
                      </p>
                    </div>
                  </div>

                  {/* Option 3: Image */}
                  <div
                    onClick={() => !isSendingTelegram && setTgSendMode('batch_photos')}
                    className={`p-4 rounded-xl border-2 transition cursor-pointer flex flex-col justify-between ${
                      tgSendMode === 'batch_photos'
                        ? 'app-card border-[var(--theme-accent)] ring-1 ring-[var(--theme-gold)]/45 shadow-sm'
                        : 'app-card opacity-85 hover:opacity-100'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-bold khmer-accent-text flex items-center gap-1.5">
                          <ImageIcon className="w-4 h-4 shrink-0" />
                          <span>៣. ផ្ញើជារូបភាព</span>
                        </span>
                        {tgSendMode === 'batch_photos' && (
                          <span className="text-xs font-bold text-emerald-700 dark:text-emerald-300">
                            បានជ្រើស ✓
                          </span>
                        )}
                      </div>
                      <p className="text-xs sm:text-sm app-text-secondary leading-relaxed">
                        បង្កើតកាតរូបភាពសំណួរខ្មែរ PNG ភ្ជាប់ជាមួយអត្ថបទសំណួរ ជម្រើស ក-ឃ និងលាក់ចម្លើយត្រឹមត្រូវ (Spoiler)។
                      </p>
                    </div>
                  </div>
                </div>

                {/* Sub-options for Text or Image */}
                {tgSendMode === 'batch_cards' && (
                  <div className="pt-2 flex flex-wrap items-center gap-3 text-xs sm:text-sm">
                    <span className="font-semibold app-text-secondary">ទម្រង់ Text៖</span>
                    <button
                      type="button"
                      disabled={isSendingTelegram}
                      onClick={() => setTgTextStyle('one_by_one')}
                      className={`px-3 py-1.5 rounded-lg font-semibold transition cursor-pointer ${
                        tgTextStyle === 'one_by_one'
                          ? 'khmer-btn-primary'
                          : 'app-card app-text-secondary hover:opacity-85'
                      }`}
                    >
                      ម្ដងមួយសំណួរ (១ សារ/សំណួរ)
                    </button>
                    <button
                      type="button"
                      disabled={isSendingTelegram}
                      onClick={() => setTgTextStyle('digest')}
                      className={`px-3 py-1.5 rounded-lg font-semibold transition cursor-pointer ${
                        tgTextStyle === 'digest'
                          ? 'khmer-btn-primary'
                          : 'app-card app-text-secondary hover:opacity-85'
                      }`}
                    >
                      សារសង្ខេបរួមជាកញ្ចប់ (Digest)
                    </button>
                  </div>
                )}

                {tgSendMode === 'batch_photos' && (
                  <div className="pt-2 flex flex-wrap items-center gap-3 text-xs sm:text-sm">
                    <label className="inline-flex items-center gap-2 cursor-pointer select-none font-semibold app-text-primary">
                      <input
                        type="checkbox"
                        checked={tgPhotoShowAnswer}
                        onChange={(e) => setTgPhotoShowAnswer(e.target.checked)}
                        disabled={isSendingTelegram}
                        className="w-4 h-4 rounded accent-[var(--theme-accent)]"
                      />
                      <span>បង្ហាញចម្លើយលើរូបភាពផងដែរ (Text ភ្ជាប់ខាងក្រោមនឹងលាក់ចម្លើយជា Spoiler ជានិច្ច)</span>
                    </label>
                  </div>
                )}
              </div>

              {tgProgress.isRunning && (
                <div className="app-subcard p-4 rounded-xl space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-semibold app-text-primary flex items-center gap-2">
                      <RefreshCw className="w-4 h-4 animate-spin khmer-accent-text" />
                      <span>{tgProgress.message}</span>
                    </span>
                    <span className="font-mono font-bold app-text-primary tabular-nums">
                      {toKhmerNum(tgProgress.current)} / {toKhmerNum(tgProgress.total)} (
                      {tgProgress.total > 0
                        ? Math.round((tgProgress.current / tgProgress.total) * 100)
                        : 0}
                      %)
                    </span>
                  </div>

                  <div className="w-full app-card h-2.5 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{
                        width: `${
                          tgProgress.total > 0
                            ? (tgProgress.current / tgProgress.total) * 100
                            : 0
                        }%`,
                        backgroundColor: 'var(--theme-accent)',
                      }}
                    />
                  </div>

                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={handleCancelTelegramBatch}
                      className="px-3.5 py-1.5 rounded-xl khmer-btn-crimson text-xs sm:text-sm font-semibold flex items-center gap-1.5 cursor-pointer"
                    >
                      <StopCircle className="w-4 h-4" />
                      <span>ផ្អាកការផ្ញើ (Cancel)</span>
                    </button>
                  </div>
                </div>
              )}

              <div className="space-y-2.5">
                <button
                  type="button"
                  onClick={handleSendTelegramBatchBySubject}
                  disabled={isSendingTelegram}
                  className="w-full py-3.5 rounded-xl khmer-btn-primary font-bold text-sm sm:text-base flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
                >
                  {tgSendMode === 'batch_photos' ? (
                    <ImageIcon className="w-5 h-5" />
                  ) : tgSendMode === 'batch_polls' ? (
                    <ListChecks className="w-5 h-5" />
                  ) : (
                    <Send className="w-5 h-5" />
                  )}
                  <span>
                    {isSendingTelegram
                      ? 'កំពុងបញ្ជូនទៅកាន់ Telegram...'
                      : tgSendMode === 'batch_photos'
                      ? `ផ្ញើកាតសំណួរជារូបភាពម្ដងមួយៗ (${tgSubject === '__ALL__' ? 'គ្រប់មុខវិជ្ជា' : tgSubject})`
                      : tgSendMode === 'batch_polls'
                      ? `បាញ់ Quiz Polls ម្ដងមួយៗ (${tgSubject === '__ALL__' ? 'គ្រប់មុខវិជ្ជា' : tgSubject})`
                      : tgTextStyle === 'digest'
                      ? `ផ្ញើជា Text រួមជាកញ្ចប់ (${tgSubject === '__ALL__' ? 'គ្រប់មុខវិជ្ជា' : tgSubject})`
                      : `ផ្ញើជា Text ម្ដងមួយៗ (${tgSubject === '__ALL__' ? 'គ្រប់មុខវិជ្ជា' : tgSubject})`}
                  </span>
                </button>

                {adminSharePool.length > 0 && (
                  <button
                    type="button"
                    disabled={isSendingTelegram}
                    onClick={() => {
                      setSocialShareDefaultMulti(adminSharePool.length > 1);
                      setSocialShareTarget({ q: adminSharePool[0], index: 1 });
                    }}
                    className="w-full py-2.5 px-4 rounded-xl app-subcard app-text-primary hover:opacity-85 font-bold text-xs sm:text-sm flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50"
                  >
                    <Share2 className="w-4 h-4 khmer-accent-text shrink-0" />
                    <span>
                      ចែករំលែករូបភាពច្រើនសន្លឹកក្នុងពេលតែមួយទៅ App (FB / TikTok · {toKhmerNum(adminSharePool.length)} សំណួរ)
                    </span>
                  </button>
                )}
              </div>

              {tgLogs.length > 0 && (
                <div className="app-subcard rounded-2xl p-4 space-y-2">
                  <div className="flex items-center justify-between text-xs sm:text-sm font-bold app-text-primary">
                    <span className="flex items-center gap-1.5">
                      <Terminal className="w-4 h-4 text-blue-600 dark:text-sky-400" />
                      <span>ប្រវត្តិនៃការបញ្ជូន (Logs)</span>
                    </span>
                    <span className="text-xs app-text-secondary font-mono tabular-nums">
                      {toKhmerNum(tgLogs.length)} កំណត់ត្រា
                    </span>
                  </div>
                  <div className="max-h-48 overflow-y-auto space-y-1.5 font-mono text-xs pr-1">
                    {tgLogs.map((log) => (
                      <div
                        key={log.id}
                        className={`p-2 rounded-lg flex items-center gap-2 border ${
                          log.success
                            ? 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-300 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200'
                            : 'bg-red-50 dark:bg-red-950/50 border-red-300 dark:border-red-800 text-red-900 dark:text-red-200'
                        }`}
                      >
                        <span className="app-text-muted text-xs shrink-0">[{log.time}]</span>
                        <span className="truncate flex-1">{log.text}</span>
                        {log.success ? (
                          <CheckCircle2 className="w-4 h-4 shrink-0" />
                        ) : (
                          <AlertCircle className="w-4 h-4 shrink-0" />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            (() => {
              const singlePool =
                tgSubject === '__ALL__'
                  ? questions
                  : questions.filter((q) => q.subject === tgSubject);
              const selectedSingleQ = singlePool.find((q) => q.id === tgSelectedQuestionId) || singlePool[0];

              return (
                <div className="app-subcard rounded-2xl p-5 space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-sm font-semibold app-text-primary mb-1.5">
                        ចម្រោះតាមមុខវិជ្ជា
                      </label>
                      <select
                        value={tgSubject}
                        onChange={(e) => {
                          const nextSub = e.target.value;
                          setTgSubject(nextSub);
                          const nextPool =
                            nextSub === '__ALL__'
                              ? questions
                              : questions.filter((q) => q.subject === nextSub);
                          setTgSelectedQuestionId(nextPool[0]?.id || '');
                        }}
                        disabled={isSendingTelegram}
                        className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm"
                      >
                        <option value="__ALL__">គ្រប់មុខវិជ្ជាទាំងអស់</option>
                        {subjects.map((s) => (
                          <option key={s.id || s.name} value={s.name}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="sm:col-span-2">
                      <label className="block text-sm font-semibold app-text-primary mb-1.5">
                        ជ្រើសរើសសំណួរដើម្បីផ្ញើម្ដងមួយៗ ({toKhmerNum(singlePool.length)} សំណួរ)
                      </label>
                      <select
                        value={selectedSingleQ?.id || ''}
                        onChange={(e) => setTgSelectedQuestionId(e.target.value)}
                        disabled={isSendingTelegram || singlePool.length === 0}
                        className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm"
                      >
                        {singlePool.length === 0 ? (
                          <option value="">-- មិនមានសំណួរក្នុងមុខវិជ្ជានេះទេ --</option>
                        ) : (
                          singlePool.map((q, idx) => {
                            const isSent = q.id ? tgSentIds.includes(q.id) : false;
                            return (
                              <option key={q.id || idx} value={q.id || ''}>
                                {isSent ? '✓ ' : ''}#{toKhmerNum(idx + 1)} [{q.type === 'mcq' ? 'QCM' : q.type === 'explanation' ? 'ពាក្យ' : 'Q&A'}] {q.question.slice(0, 65)}{q.question.length > 65 ? '...' : ''}
                              </option>
                            );
                          })
                        )}
                      </select>
                    </div>
                  </div>

                  {selectedSingleQ && (
                    <div className="app-card p-4 rounded-xl space-y-2">
                      <div className="flex items-center justify-between text-xs font-bold">
                        <span className="text-blue-700 dark:text-amber-300">
                          {selectedSingleQ.subject} · {selectedSingleQ.type === 'mcq' ? 'QCM' : selectedSingleQ.type === 'explanation' ? 'ពន្យល់ពាក្យ' : 'សំណួរ-ចម្លើយ'}
                        </span>
                        {selectedSingleQ.id && tgSentIds.includes(selectedSingleQ.id) && (
                          <span className="text-emerald-700 dark:text-emerald-300">បានផ្ញើរួច ✓</span>
                        )}
                      </div>
                      <p className="text-sm font-semibold app-text-primary leading-relaxed">
                        {selectedSingleQ.question}
                      </p>
                      {selectedSingleQ.answer && (
                        <p className="text-xs sm:text-sm app-text-secondary line-clamp-3">
                          ចម្លើយ៖ {selectedSingleQ.answer}
                        </p>
                      )}
                    </div>
                  )}

                  <div className="flex items-center justify-between pt-1">
                    <label className="inline-flex items-center gap-2 cursor-pointer select-none text-xs sm:text-sm font-medium app-text-secondary">
                      <input
                        type="checkbox"
                        checked={tgPhotoShowAnswer}
                        onChange={(e) => setTgPhotoShowAnswer(e.target.checked)}
                        disabled={isSendingTelegram}
                        className="w-4 h-4 rounded accent-[var(--theme-accent)]"
                      />
                      <span>បង្ហាញចម្លើយលើរូបភាពផងដែរ (Text ភ្ជាប់ខាងក្រោមនឹងលាក់ចម្លើយជា Spoiler ជានិច្ច)</span>
                    </label>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <button
                      type="button"
                      onClick={() => handleSendSingleQuestion('card')}
                      disabled={isSendingTelegram || !selectedSingleQ}
                      className="py-3 px-4 rounded-xl khmer-btn-primary font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
                    >
                      <FileText className="w-4 h-4" />
                      <span>{isSendingTelegram ? 'កំពុងផ្ញើ...' : 'ផ្ញើជា Text'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleSendSingleQuestion('poll')}
                      disabled={isSendingTelegram || !selectedSingleQ || selectedSingleQ.type !== 'mcq'}
                      title={
                        selectedSingleQ && selectedSingleQ.type !== 'mcq'
                          ? 'Quiz Poll អាចប្រើបានតែជាមួយសំណួរ QCM ប៉ុណ្ណោះ'
                          : 'ផ្ញើសំណួរនេះជា Telegram Quiz Poll'
                      }
                      className="py-3 px-4 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-sm flex items-center justify-center gap-2 transition disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer"
                    >
                      <ListChecks className="w-4 h-4" />
                      <span>ផ្ញើជា Poll (QCM)</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleSendSingleQuestion('photo')}
                      disabled={isSendingTelegram || !selectedSingleQ}
                      className="py-3 px-4 rounded-xl khmer-btn-crimson font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
                    >
                      <ImageIcon className="w-4 h-4" />
                      <span>ផ្ញើជារូបភាព</span>
                    </button>
                  </div>

                  {selectedSingleQ && (
                    <div className="pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          const idx = singlePool.findIndex((item) => item.id === selectedSingleQ.id);
                          setSocialShareDefaultMulti(false);
                          setSocialShareTarget({
                            q: selectedSingleQ,
                            index: idx !== -1 ? idx + 1 : 1,
                          });
                        }}
                        className="w-full py-2.5 px-4 rounded-xl app-subcard app-text-primary hover:opacity-85 font-bold text-xs sm:text-sm flex items-center justify-center gap-2 transition cursor-pointer"
                      >
                        <Share2 className="w-4 h-4 khmer-accent-text" />
                        <span>ចែករំលែករូបភាពនេះ ឬច្រើនសន្លឹកទៅ App (FB / TikTok)</span>
                      </button>
                    </div>
                  )}
                </div>
              );
            })()
          )}
        </div>
      )}

      {/* 6. LOGINS, PRESENCE & BROADCAST NOTIFICATIONS */}
      {activeSubTab === 'monitoring' && (
        <div className="space-y-8 max-w-5xl mx-auto">
          {/* Broadcast Announcement & Notifications Management */}
          <div className="app-card rounded-2xl p-6 shadow-sm space-y-5">
            <div>
              <h2 className="font-moul text-base app-text-primary mb-3 flex items-center gap-2">
                <Bell className="w-5 h-5 text-blue-600 dark:text-amber-400" />
                <span>ផ្ញើដំណឹងប្រកាសទៅកាន់សមាជិក (Broadcast)</span>
              </h2>

              <form onSubmit={handleBroadcast} className="space-y-3">
                <div className="flex flex-col sm:flex-row gap-2.5">
                  <input
                    type="text"
                    value={broadcastMsg}
                    onChange={(e) => setBroadcastMsg(e.target.value)}
                    placeholder="វាយអត្ថបទដំណឹងប្រកាសជូនសមាជិកទាំងអស់..."
                    className="flex-1 px-3.5 py-2.5 rounded-xl app-input text-sm"
                    required
                  />
                  <select
                    value={broadcastType}
                    onChange={(e) => setBroadcastType(e.target.value as any)}
                    className="px-3.5 py-2.5 rounded-xl app-input text-sm"
                  >
                    <option value="info">ព័ត៌មាន (Info)</option>
                    <option value="success">ជោគជ័យ (Success)</option>
                    <option value="warning">ការប្រុងប្រយ័ត្ន (Warning)</option>
                  </select>
                  <button
                    type="submit"
                    disabled={isBroadcasting || !broadcastMsg.trim()}
                    className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold text-sm cursor-pointer whitespace-nowrap"
                  >
                    {isBroadcasting ? 'កំពុងផ្សាយ...' : 'ផ្សាយដំណឹង'}
                  </button>
                </div>

                {broadcastStatusMsg && (
                  <div
                    className={`p-3 rounded-xl text-sm flex items-center gap-2 border ${
                      broadcastStatusMsg.success
                        ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-400 dark:border-emerald-700 text-emerald-900 dark:text-emerald-200'
                        : 'bg-red-50 dark:bg-red-950/60 border-red-400 dark:border-red-700 text-red-900 dark:text-red-200'
                    }`}
                  >
                    {broadcastStatusMsg.success ? (
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                    ) : (
                      <AlertCircle className="w-4 h-4 shrink-0" />
                    )}
                    <span>{broadcastStatusMsg.text}</span>
                  </div>
                )}
              </form>
            </div>

            {/* Existing Notifications List & Delete Controls */}
            <div className="pt-4 border-t app-border space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-bold app-text-primary flex items-center gap-2">
                  <span>បញ្ជីដំណឹងដែលបានផ្សាយ ({toKhmerNum(notifications.length)})</span>
                </h3>
                {notifications.length > 0 && (
                  <button
                    type="button"
                    onClick={handleDeleteAllNotificationsClick}
                    className="px-3 py-1.5 rounded-xl bg-red-50 dark:bg-red-950/60 hover:opacity-85 border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 font-bold text-xs flex items-center gap-1.5 transition cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>លុបដំណឹងទាំងអស់</span>
                  </button>
                )}
              </div>

              {notifications.length === 0 ? (
                <p className="text-sm app-text-secondary py-4 text-center app-subcard rounded-xl">
                  មិនទាន់មានដំណឹងប្រកាសនៅក្នុងប្រព័ន្ធទេ
                </p>
              ) : (
                <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
                  {notifications.map((notif) => (
                    <div
                      key={notif.id}
                      className={`p-3.5 rounded-xl border text-sm flex items-start justify-between gap-3 ${
                        notif.type === 'success'
                          ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-700 text-emerald-900 dark:text-emerald-100'
                          : notif.type === 'warning'
                          ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-700 text-amber-950 dark:text-amber-100'
                          : 'app-subcard'
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                          <span className="text-xs font-bold uppercase tracking-wide opacity-80">
                            {notif.type === 'success'
                              ? 'ជោគជ័យ'
                              : notif.type === 'warning'
                              ? 'ប្រុងប្រយ័ត្ន'
                              : 'ព័ត៌មាន'}
                          </span>
                          <span className="text-xs opacity-60">·</span>
                          <span className="text-xs opacity-75 font-mono">
                            {new Date(notif.timestamp).toLocaleString('km-KH')}
                          </span>
                        </div>
                        <p className="font-kantumruy leading-relaxed whitespace-pre-line break-words">
                          {notif.message}
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={() => handleDeleteSingleNotification(notif.id)}
                        title="លុបដំណឹងនេះ"
                        className="px-2.5 py-1.5 rounded-lg bg-red-600/10 hover:bg-red-600 hover:text-white text-red-700 dark:text-red-300 text-xs font-bold flex items-center gap-1 transition shrink-0 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>លុប</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Active Online Presence */}
          <div className="app-card rounded-2xl p-6 shadow-sm space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-moul text-base app-text-primary">
                អ្នកកំពុង Online ក្នុងរង្វង់ ៥នាទីចុងក្រោយ ({toKhmerNum(presence.length)})
              </h2>
              <button
                type="button"
                disabled={isSyncingMonitoring}
                onClick={handleRefreshMonitoringOnly}
                className="px-3 py-1.5 rounded-xl app-subcard hover:opacity-85 disabled:opacity-60 app-text-primary border app-border text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isSyncingMonitoring ? 'animate-spin' : ''}`} />
                <span>{isSyncingMonitoring ? 'កំពុងទាញ...' : 'ធ្វើបច្ចុប្បន្នភាពវត្តមាន/Login/មតិ'}</span>
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {presence.length === 0 ? (
                <p className="text-sm app-text-secondary col-span-full">មិនទាន់មានទិន្នន័យវត្តមាន</p>
              ) : (
                presence.map((p) => (
                  <div
                    key={p.id}
                    className="p-3 rounded-xl app-subcard flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="font-semibold app-text-primary truncate">{p.username}</span>
                    <span className="text-xs app-text-secondary uppercase font-mono">
                      {p.role}
                    </span>
                  </div>
                ))
              )}
            </div>

            {hasMorePresence && onLoadMorePresence && (
              <div className="flex justify-center pt-1">
                <button
                  type="button"
                  disabled={isLoadingMorePresence}
                  onClick={onLoadMorePresence}
                  className="px-4 py-2 rounded-xl app-subcard hover:opacity-85 disabled:opacity-60 app-text-primary border app-border text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isLoadingMorePresence ? 'animate-spin' : ''}`} />
                  <span>{isLoadingMorePresence ? 'កំពុងផ្ទុក...' : 'ផ្ទុកបន្ថែម ២០ ទៀត (Load More)'}</span>
                </button>
              </div>
            )}
          </div>

          {/* Login History Table */}
          <div className="app-card rounded-2xl p-6 shadow-sm space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <h2 className="font-moul text-base app-text-primary">
                ប្រវត្តិនៃការ Login ({toKhmerNum(filteredLogins.length)}
                {typeof globalStats?.loginsCount === 'number' && globalStats.loginsCount > logins.length
                  ? ` / សរុប ${toKhmerNum(globalStats.loginsCount)}`
                  : ''}
                )
              </h2>

              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 sm:w-56">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 app-text-muted" />
                  <input
                    type="text"
                    value={loginSearch}
                    onChange={(e) => setLoginSearch(e.target.value)}
                    placeholder="ស្វែងរកឈ្មោះសមាជិក..."
                    className="w-full pl-9 pr-8 py-2 rounded-xl app-input text-xs sm:text-sm"
                  />
                  {loginSearch && (
                    <button
                      type="button"
                      onClick={() => setLoginSearch('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 app-text-muted hover:opacity-75 cursor-pointer"
                      aria-label="សម្អាត"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {filteredLogins.length > 0 && (
                  <button
                    type="button"
                    onClick={handleDeleteAllLoginsClick}
                    className="px-3 py-2 rounded-xl bg-red-50 dark:bg-red-950/60 hover:opacity-85 border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 font-bold text-xs flex items-center gap-1.5 transition cursor-pointer whitespace-nowrap"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>
                      {loginSearch.trim()
                        ? `លុបលទ្ធផល (${toKhmerNum(filteredLogins.length)})`
                        : 'លុបប្រវត្តិទាំងអស់'}
                    </span>
                  </button>
                )}
              </div>
            </div>

            {loginStatusMsg && (
              <div
                className={`p-3 rounded-xl text-sm flex items-center gap-2 border ${
                  loginStatusMsg.success
                    ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-400 dark:border-emerald-700 text-emerald-900 dark:text-emerald-200'
                    : 'bg-red-50 dark:bg-red-950/60 border-red-400 dark:border-red-700 text-red-900 dark:text-red-200'
                }`}
              >
                {loginStatusMsg.success ? (
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                ) : (
                  <AlertCircle className="w-4 h-4 shrink-0" />
                )}
                <span>{loginStatusMsg.text}</span>
              </div>
            )}

            {filteredLogins.length === 0 ? (
              <p className="text-sm app-text-secondary py-6 text-center app-subcard rounded-xl">
                មិនទាន់មានប្រវត្តិ Login នៅក្នុងប្រព័ន្ធទេ
              </p>
            ) : (
              <div className="overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b app-border app-text-secondary font-bold">
                      <th className="py-2.5 px-3">Username</th>
                      <th className="py-2.5 px-3">លេខកូដដែលបានប្រើ</th>
                      <th className="py-2.5 px-3">តួនាទី</th>
                      <th className="py-2.5 px-3">កាលបរិច្ឆេទ & ម៉ោង</th>
                      <th className="py-2.5 px-3 text-right">សកម្មភាព</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y app-border font-mono">
                    {filteredLogins.map((l) => {
                      const memberCount = logins.filter((x) => x.username === l.username).length;
                      return (
                        <tr key={l.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                          <td className="py-2.5 px-3 font-semibold app-text-primary font-sans whitespace-nowrap">
                            {l.username}
                          </td>
                          <td className="py-2.5 px-3 text-blue-700 dark:text-amber-300 font-bold whitespace-nowrap">
                            {l.passwordUsed}
                          </td>
                          <td className="py-2.5 px-3 uppercase text-xs app-text-secondary whitespace-nowrap">{l.role}</td>
                          <td className="py-2.5 px-3 text-xs app-text-secondary whitespace-nowrap">
                            {new Date(l.timestamp).toLocaleString('km-KH')}
                          </td>
                          <td className="py-2.5 px-3 text-right font-sans whitespace-nowrap">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleDeleteSingleLogin(l)}
                                title="លុបប្រវត្តិ Login នេះ"
                                className="px-2.5 py-1 rounded-lg bg-red-600/10 hover:bg-red-600 hover:text-white text-red-700 dark:text-red-300 text-xs font-bold inline-flex items-center gap-1 transition cursor-pointer whitespace-nowrap"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                <span>លុប</span>
                              </button>
                              {memberCount > 1 && (
                                <button
                                  type="button"
                                  onClick={() => handleDeleteMemberAllLogins(l.username)}
                                  title={`លុបប្រវត្តិទាំង ${memberCount} ដងរបស់ ${l.username}`}
                                  className="px-2 py-1 rounded-lg app-subcard hover:bg-red-600 hover:text-white text-red-700 dark:text-red-300 text-xs font-semibold transition cursor-pointer whitespace-nowrap"
                                >
                                  ទាំងអស់ ({toKhmerNum(memberCount)})
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {hasMoreLogins && onLoadMoreLogins && (
              <div className="flex justify-center pt-1">
                <button
                  type="button"
                  disabled={isLoadingMoreLogins}
                  onClick={onLoadMoreLogins}
                  className="px-4 py-2 rounded-xl app-subcard hover:opacity-85 disabled:opacity-60 app-text-primary border app-border text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isLoadingMoreLogins ? 'animate-spin' : ''}`} />
                  <span>{isLoadingMoreLogins ? 'កំពុងផ្ទុក...' : 'ផ្ទុកបន្ថែម ២០ ទៀត (Load More)'}</span>
                </button>
              </div>
            )}
          </div>

          {/* Feedbacks */}
          <div className="app-card rounded-2xl p-6 shadow-sm space-y-4">
            <h2 className="font-moul text-base app-text-primary">
              មតិយោបល់ពីសមាជិក ({toKhmerNum(feedbacks.length)}
              {typeof globalStats?.feedbacksCount === 'number' && globalStats.feedbacksCount > feedbacks.length
                ? ` / សរុប ${toKhmerNum(globalStats.feedbacksCount)}`
                : ''}
              )
            </h2>

            <div className="space-y-3 max-h-72 overflow-y-auto">
              {feedbacks.length === 0 ? (
                <p className="text-sm app-text-secondary">មិនទាន់មានមតិយោបល់ពីសមាជិកនៅឡើយ</p>
              ) : (
                feedbacks.map((fb) => (
                  <div key={fb.id} className="p-4 rounded-xl app-subcard text-sm">
                    <div className="flex items-center justify-between mb-1.5">
                      <strong className="text-blue-700 dark:text-sky-300">{fb.username}</strong>
                      <span className="text-xs app-text-muted">
                        {new Date(fb.createdAt).toLocaleString('km-KH')}
                      </span>
                    </div>
                    <p className="app-text-primary leading-relaxed">{fb.text}</p>
                  </div>
                ))
              )}
            </div>

            {hasMoreFeedbacks && onLoadMoreFeedbacks && (
              <div className="flex justify-center pt-1">
                <button
                  type="button"
                  disabled={isLoadingMoreFeedbacks}
                  onClick={onLoadMoreFeedbacks}
                  className="px-4 py-2 rounded-xl app-subcard hover:opacity-85 disabled:opacity-60 app-text-primary border app-border text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isLoadingMoreFeedbacks ? 'animate-spin' : ''}`} />
                  <span>{isLoadingMoreFeedbacks ? 'កំពុងផ្ទុក...' : 'ផ្ទុកបន្ថែម ២០ ទៀត (Load More)'}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* MODAL: EDIT QUESTION */}
      {editingQuestion && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="app-card w-full max-w-2xl max-h-[90vh] rounded-2xl p-6 sm:p-8 shadow-2xl relative overflow-y-auto">
            <button
              type="button"
              onClick={() => setEditingQuestion(null)}
              className="absolute top-4 right-4 app-text-muted hover:opacity-75 p-1.5 rounded-lg transition cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center shrink-0">
                <Edit2 className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-moul text-lg app-text-primary">កែប្រែសំណួរ និងចម្លើយ</h3>
                <p className="text-sm app-text-secondary">កែសម្រួលអត្ថបទសំណួរ ជម្រើសចម្លើយ ឬឯកសារយោង</p>
              </div>
            </div>

            <form onSubmit={handleSaveQuestionEdit} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold app-text-primary mb-1.5">មុខវិជ្ជា</label>
                  <select
                    value={editQuestionSubject}
                    onChange={(e) => setEditQuestionSubject(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm"
                  >
                    {subjects.map((sub) => (
                      <option key={sub.id} value={sub.name}>
                        {sub.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-semibold app-text-primary mb-1.5">ប្រភេទសំណួរ</label>
                  <select
                    value={editQuestionType}
                    onChange={(e) => setEditQuestionType(e.target.value as QuestionType)}
                    className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm"
                  >
                    <option value="mcq">QCM (ពហុជម្រើស)</option>
                    <option value="short">Q & A (ខ្លី)</option>
                    <option value="explanation">ពន្យល់ពាក្យ</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-semibold app-text-primary mb-1.5">
                  {editQuestionType === 'explanation' ? 'ពាក្យគន្លឹះ / វាក្យសព្ទ' : 'អត្ថបទសំណួរ'} *
                </label>
                <textarea
                  rows={3}
                  value={editQuestionText}
                  onChange={(e) => setEditQuestionText(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm sm:text-base"
                  required
                />
              </div>

              {editQuestionType === 'mcq' && (
                <div className="space-y-2.5">
                  <label className="block text-sm font-semibold app-text-primary">
                    ជម្រើសទាំង ៤ (ជ្រើសរើស Option ណាជាចម្លើយត្រឹមត្រូវ) *
                  </label>
                  {editQuestionOptions.map((opt, oIdx) => (
                    <div key={oIdx} className="flex items-center gap-2.5">
                      <input
                        type="radio"
                        name="editCorrectOptionRadio"
                        checked={editQuestionCorrect === oIdx}
                        onChange={() => setEditQuestionCorrect(oIdx)}
                        className="w-4 h-4 text-emerald-600 focus:ring-0 cursor-pointer"
                      />
                      <span className="text-sm font-bold w-6 text-blue-700 dark:text-amber-300">
                        {getOptionLabel(oIdx, editQuestionSubject)}.
                      </span>
                      <input
                        type="text"
                        value={opt}
                        onChange={(e) => {
                          const next = [...editQuestionOptions];
                          next[oIdx] = e.target.value;
                          setEditQuestionOptions(next);
                        }}
                        className="flex-1 px-3.5 py-2 rounded-xl app-input text-sm"
                        required
                      />
                    </div>
                  ))}
                </div>
              )}

              <div>
                <label className="block text-sm font-semibold app-text-primary mb-1.5">
                  {editQuestionType === 'mcq'
                    ? 'ឯកសារយោង / ការបកស្រាយចម្លើយ (Optional)'
                    : 'ចម្លើយបកស្រាយពេញលេញ *'}
                </label>
                <textarea
                  rows={3}
                  value={editQuestionAnswer}
                  onChange={(e) => setEditQuestionAnswer(e.target.value)}
                  placeholder="ឧ. យោង ៖ ព្រះរាជក្រមលេខ នស/រកម/០៥២៦/០០៨..."
                  className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm sm:text-base"
                />
              </div>

              {editQuestionError && (
                <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/60 border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 text-xs sm:text-sm flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{editQuestionError}</span>
                </div>
              )}

              <div className="flex items-center justify-between pt-4 border-t app-border">
                <button
                  type="button"
                  disabled={isSavingQuestionEdit}
                  onClick={() => {
                    if (editingQuestion) {
                      handleDeleteQuestionClick(editingQuestion);
                    }
                  }}
                  className="px-4 py-2 rounded-xl bg-red-50 dark:bg-red-950/60 hover:opacity-80 border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 font-bold text-xs sm:text-sm flex items-center gap-1.5 transition disabled:opacity-50 cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                  <span>លុបសំណួរនេះ</span>
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={isSavingQuestionEdit}
                    onClick={() => setEditingQuestion(null)}
                    className="px-4 py-2 rounded-xl app-subcard app-text-primary text-sm font-semibold transition disabled:opacity-50 cursor-pointer"
                  >
                    បោះបង់
                  </button>
                  <button
                    type="submit"
                    disabled={isSavingQuestionEdit}
                    className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm transition disabled:opacity-60 cursor-pointer"
                  >
                    {isSavingQuestionEdit ? 'កំពុងរក្សាទុក...' : 'រក្សាទុកការកែប្រែ'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: EDIT SUBJECT */}
      {editingSubject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="app-card w-full max-w-md rounded-2xl p-6 sm:p-8 shadow-2xl relative">
            <button
              type="button"
              onClick={() => setEditingSubject(null)}
              className="absolute top-4 right-4 app-text-muted hover:opacity-75 p-1.5 rounded-lg transition cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center shrink-0">
                <Edit2 className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-moul text-lg app-text-primary">កែប្រែមុខវិជ្ជា</h3>
                <p className="text-sm app-text-secondary">កែសម្រួលឈ្មោះ ស្ថានភាព និងប្រភេទមុខវិជ្ជា</p>
              </div>
            </div>

            <form onSubmit={handleSaveSubjectEdit} className="space-y-4">
              <div>
                <label className="block text-sm font-semibold app-text-primary mb-1.5">ឈ្មោះមុខវិជ្ជា *</label>
                <input
                  type="text"
                  value={editSubjectName}
                  onChange={(e) => setEditSubjectName(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm sm:text-base"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-semibold app-text-primary mb-1.5">ប្រភេទចម្បង</label>
                <select
                  value={editSubjectType}
                  onChange={(e) => setEditSubjectType(e.target.value as QuestionType)}
                  className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm"
                >
                  <option value="mcq">QCM (ពហុជម្រើស)</option>
                  <option value="short">Q & A (ខ្លី)</option>
                  <option value="explanation">ពន្យល់ពាក្យ</option>
                </select>
              </div>

              <div className="flex items-center justify-between p-3.5 rounded-xl app-subcard">
                <span className="text-sm font-semibold app-text-primary">ស្ថានភាពដំណើរការ</span>
                <button
                  type="button"
                  onClick={() => setEditSubjectIsActive(!editSubjectIsActive)}
                  className={`px-3 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                    editSubjectIsActive
                      ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-200 border border-emerald-400 dark:border-emerald-700'
                      : 'app-card app-text-muted'
                  }`}
                >
                  {editSubjectIsActive ? 'បើកដំណើរការ' : 'បានបិទ'}
                </button>
              </div>

              {editSubjectError && (
                <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/60 border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 text-xs sm:text-sm flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{editSubjectError}</span>
                </div>
              )}

              <div className="flex items-center justify-between pt-4 border-t app-border">
                <button
                  type="button"
                  disabled={isSavingSubjectEdit}
                  onClick={() => {
                    if (editingSubject) {
                      handleDeleteSubjectClick(editingSubject);
                    }
                  }}
                  className="px-3.5 py-2 rounded-xl bg-red-50 dark:bg-red-950/60 hover:opacity-80 border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 font-bold text-xs sm:text-sm flex items-center gap-1.5 transition disabled:opacity-50 cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                  <span>លុបមុខវិជ្ជា</span>
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={isSavingSubjectEdit}
                    onClick={() => setEditingSubject(null)}
                    className="px-4 py-2 rounded-xl app-subcard app-text-primary text-sm font-semibold transition disabled:opacity-50 cursor-pointer"
                  >
                    បោះបង់
                  </button>
                  <button
                    type="submit"
                    disabled={isSavingSubjectEdit}
                    className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm transition disabled:opacity-60 cursor-pointer"
                  >
                    {isSavingSubjectEdit ? 'កំពុងរក្សាទុក...' : 'រក្សាទុក'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: EDIT COMMAND BOT CONTENT */}
      {editingBotCommand && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="app-card w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl p-6 sm:p-8 shadow-2xl relative">
            <button
              type="button"
              onClick={() => !isSavingBotCommand && setEditingBotCommand(null)}
              className="absolute top-4 right-4 app-text-muted hover:opacity-75 p-1.5 rounded-lg transition cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl khmer-btn-primary flex items-center justify-center shrink-0">
                <Bot className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-moul text-base sm:text-lg app-text-primary">
                  កែប្រែខ្លឹមសារ Command Bot ({editingBotCommand.command})
                </h3>
                <p className="text-xs sm:text-sm app-text-secondary">
                  ធ្វើបច្ចុប្បន្នភាពទាំងលើ Command Bot ក្នុងកម្មវិធី និង Telegram @qiuzs_bot
                </p>
              </div>
            </div>

            <form onSubmit={handleSaveBotCommandEdit} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold app-text-primary mb-1.5">
                    ឈ្មោះខ្លី Command (Short Title) *
                  </label>
                  <input
                    type="text"
                    maxLength={120}
                    value={editingBotCommand.titleKh}
                    onChange={(e) =>
                      setEditingBotCommand((prev) =>
                        prev ? { ...prev, titleKh: e.target.value } : prev
                      )
                    }
                    className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold app-text-primary mb-1.5">
                    ការពិពណ៌នាក្នុងម៉ឺនុយ Bot (Menu Description) *
                  </label>
                  <input
                    type="text"
                    maxLength={200}
                    value={editingBotCommand.descriptionKh}
                    onChange={(e) =>
                      setEditingBotCommand((prev) =>
                        prev ? { ...prev, descriptionKh: e.target.value } : prev
                      )
                    }
                    className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-semibold app-text-primary mb-1.5">
                  ចំណងជើងសារឆ្លើយតប (Message Title) *
                </label>
                <input
                  type="text"
                  maxLength={250}
                  value={editingBotCommand.title}
                  onChange={(e) =>
                    setEditingBotCommand((prev) =>
                      prev ? { ...prev, title: e.target.value } : prev
                    )
                  }
                  className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-semibold app-text-primary mb-1.5">
                  ខ្លឹមសារសារឆ្លើយតបទាំងមូល (Message Body)
                </label>
                <textarea
                  rows={8}
                  maxLength={4000}
                  value={editingBotCommand.body}
                  onChange={(e) =>
                    setEditingBotCommand((prev) =>
                      prev ? { ...prev, body: e.target.value } : prev
                    )
                  }
                  placeholder="បញ្ចូលខ្លឹមសារឆ្លើយតបរបស់ Bot..."
                  className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm leading-relaxed"
                />
                <p className="text-xs app-text-muted mt-1">
                  {toKhmerNum(editingBotCommand.body.length)} / ៤០០០ តួអក្សរ
                </p>
              </div>

              {editingBotCommand.command === '/payment' && (
                <div className="p-3.5 rounded-xl app-subcard flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-xs sm:text-sm font-semibold app-text-primary">
                      ភ្ជាប់រូបភាព QR Code KHQR ជាមួយសារ /payment
                    </div>
                    <div className="text-xs app-text-secondary">
                      បង្ហាញរូបភាព KHQR ($10.00) ទាំងលើកម្មវិធី និង Telegram Bot
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setEditingBotCommand((prev) =>
                        prev
                          ? {
                              ...prev,
                              imageUrl: prev.imageUrl ? '' : KHQR_IMAGE_PATH,
                              imageAlt: prev.imageUrl
                                ? ''
                                : 'KHOUN NARET Master QuizKH - KHQR $10.00',
                            }
                          : prev
                      )
                    }
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                      editingBotCommand.imageUrl
                        ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-200 border border-emerald-400 dark:border-emerald-700'
                        : 'app-card app-text-muted'
                    }`}
                  >
                    {editingBotCommand.imageUrl ? 'កំពុងភ្ជាប់ KHQR ✓' : 'បានបិទរូបភាព'}
                  </button>
                </div>
              )}

              {/* Action Buttons Editor */}
              <div className="space-y-2.5 pt-2 border-t app-border">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-sm font-semibold app-text-primary">
                    ប៊ូតុងណែនាំខាងក្រោមសារ (Action Buttons)
                  </label>
                  {editingBotCommand.actions.length < 8 && (
                    <button
                      type="button"
                      onClick={() =>
                        setEditingBotCommand((prev) =>
                          prev
                            ? {
                                ...prev,
                                actions: [
                                  ...prev.actions,
                                  { label: 'ប៊ូតុងថ្មី', type: 'command', value: '/help' },
                                ],
                              }
                            : prev
                        )
                      }
                      className="px-2.5 py-1 rounded-lg app-subcard text-xs font-bold khmer-accent-text hover:opacity-80 transition flex items-center gap-1 cursor-pointer"
                    >
                      <PlusCircle className="w-3.5 h-3.5" />
                      <span>បន្ថែមប៊ូតុង</span>
                    </button>
                  )}
                </div>

                {editingBotCommand.actions.length === 0 ? (
                  <p className="text-xs app-text-muted py-2">
                    មិនមានប៊ូតុងណែនាំទេ។ ចុច «+ បន្ថែមប៊ូតុង» ប្រសិនបើអ្នកចង់បន្ថែម។
                  </p>
                ) : (
                  <div className="space-y-2">
                    {editingBotCommand.actions.map((act, idx) => (
                      <div
                        key={idx}
                        className="p-2.5 rounded-xl app-subcard grid grid-cols-1 sm:grid-cols-12 gap-2 items-center"
                      >
                        <input
                          type="text"
                          maxLength={120}
                          value={act.label}
                          onChange={(e) => {
                            const val = e.target.value;
                            setEditingBotCommand((prev) => {
                              if (!prev) return prev;
                              const nextActions = [...prev.actions];
                              nextActions[idx] = { ...nextActions[idx], label: val };
                              return { ...prev, actions: nextActions };
                            });
                          }}
                          placeholder="អក្សរលើប៊ូតុង"
                          className="sm:col-span-5 px-3 py-1.5 rounded-lg app-input text-xs"
                        />
                        <select
                          value={act.type}
                          onChange={(e) => {
                            const nextType = e.target.value as BotActionButton['type'];
                            setEditingBotCommand((prev) => {
                              if (!prev) return prev;
                              const nextActions = [...prev.actions];
                              const defaultVal =
                                nextType === 'open_member_login'
                                  ? 'member'
                                  : nextType === 'url'
                                  ? 'https://t.me/qcm_and_q_a'
                                  : '/start';
                              nextActions[idx] = {
                                ...nextActions[idx],
                                type: nextType,
                                value:
                                  nextType === 'open_member_login'
                                    ? 'member'
                                    : nextActions[idx].value || defaultVal,
                              };
                              return { ...prev, actions: nextActions };
                            });
                          }}
                          className="sm:col-span-3 px-2.5 py-1.5 rounded-lg app-input text-xs"
                        >
                          <option value="command">ហៅ Command</option>
                          <option value="url">បើកតំណ URL</option>
                          <option value="open_member_login">ផ្ទាំងសមាជិក</option>
                        </select>
                        <input
                          type="text"
                          maxLength={400}
                          value={act.value}
                          disabled={act.type === 'open_member_login'}
                          onChange={(e) => {
                            const val = e.target.value;
                            setEditingBotCommand((prev) => {
                              if (!prev) return prev;
                              const nextActions = [...prev.actions];
                              nextActions[idx] = { ...nextActions[idx], value: val };
                              return { ...prev, actions: nextActions };
                            });
                          }}
                          placeholder={
                            act.type === 'url'
                              ? 'https://...'
                              : act.type === 'open_member_login'
                              ? 'member'
                              : '/register'
                          }
                          className="sm:col-span-3 px-3 py-1.5 rounded-lg app-input text-xs font-mono disabled:opacity-60"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setEditingBotCommand((prev) => {
                              if (!prev) return prev;
                              return {
                                ...prev,
                                actions: prev.actions.filter((_, i) => i !== idx),
                              };
                            })
                          }
                          title="លុបប៊ូតុងនេះ"
                          className="sm:col-span-1 p-1.5 rounded-lg text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/50 transition flex items-center justify-center cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-4 border-t app-border">
                <button
                  type="button"
                  disabled={isSavingBotCommand}
                  onClick={() => handleResetSingleBotCommand(editingBotCommand.command)}
                  className="px-3.5 py-2 rounded-xl app-subcard hover:opacity-80 text-amber-700 dark:text-amber-300 font-bold text-xs sm:text-sm flex items-center gap-1.5 transition disabled:opacity-50 cursor-pointer"
                >
                  <RotateCcw className="w-4 h-4" />
                  <span>កំណត់លំនាំដើមវិញ</span>
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={isSavingBotCommand}
                    onClick={() => setEditingBotCommand(null)}
                    className="px-4 py-2 rounded-xl app-subcard app-text-primary text-sm font-semibold transition disabled:opacity-50 cursor-pointer"
                  >
                    បោះបង់
                  </button>
                  <button
                    type="submit"
                    disabled={isSavingBotCommand}
                    className="px-5 py-2 rounded-xl khmer-btn-primary font-bold text-sm flex items-center gap-1.5 transition disabled:opacity-50 cursor-pointer"
                  >
                    <Save className="w-4 h-4" />
                    <span>
                      {isSavingBotCommand ? 'កំពុងរក្សាទុក...' : 'រក្សាទុក និងធ្វើបច្ចុប្បន្នភាព Bot'}
                    </span>
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* IN-APP CONFIRMATION MODAL */}
      {deleteConfirmDialog && deleteConfirmDialog.isOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="app-card w-full max-w-md rounded-2xl p-6 sm:p-7 shadow-2xl relative text-center">
            <div className="w-14 h-14 rounded-2xl bg-red-50 dark:bg-red-950/80 border border-red-300 dark:border-red-700 flex items-center justify-center text-red-600 dark:text-red-400 mx-auto mb-4">
              <Trash2 className="w-7 h-7" />
            </div>

            <h3 className="font-moul text-base sm:text-lg app-text-primary mb-2">
              {deleteConfirmDialog.title}
            </h3>

            <p className="text-sm app-text-secondary font-kantumruy leading-relaxed mb-3">
              {deleteConfirmDialog.message}
            </p>

            {deleteConfirmDialog.subMessage && (
              <p className="text-xs sm:text-sm text-amber-900 dark:text-amber-200 bg-amber-50 dark:bg-amber-950/50 p-3 rounded-xl border border-amber-300 dark:border-amber-700 mb-6 font-kantumruy">
                {deleteConfirmDialog.subMessage}
              </p>
            )}

            {deleteConfirmError && (
              <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/60 border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 text-xs sm:text-sm flex items-center justify-center gap-2 mb-4">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{deleteConfirmError}</span>
              </div>
            )}

            <div className="flex items-center justify-center gap-3 mt-4">
              <button
                type="button"
                disabled={isConfirmDeleting}
                onClick={() => {
                  setDeleteConfirmError(null);
                  setDeleteConfirmDialog(null);
                }}
                className="flex-1 py-2.5 rounded-xl app-subcard app-text-primary text-sm font-semibold transition disabled:opacity-50 cursor-pointer"
              >
                បោះបង់
              </button>
              <button
                type="button"
                disabled={isConfirmDeleting}
                onClick={async () => {
                  if (isConfirmDeleting) return;
                  setIsConfirmDeleting(true);
                  setDeleteConfirmError(null);
                  try {
                    await deleteConfirmDialog.onConfirm();
                    setDeleteConfirmDialog(null);
                  } catch (err: any) {
                    setDeleteConfirmError(err?.message || 'បរាជ័យក្នុងការលុបទិន្នន័យលើ Server!');
                  } finally {
                    setIsConfirmDeleting(false);
                  }
                }}
                className="flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold text-sm transition flex items-center justify-center gap-1.5 disabled:opacity-60 cursor-pointer"
              >
                <Trash2 className="w-4 h-4" />
                <span>{isConfirmDeleting ? 'កំពុងលុប...' : 'យល់ព្រមលុប'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
      <SocialShareModal
        isOpen={socialShareTarget !== null}
        onClose={() => {
          setSocialShareTarget(null);
          setSocialShareDefaultMulti(false);
        }}
        title={
          socialShareTarget
            ? `សំណួរទី ${toKhmerNum(socialShareTarget.index)} · ${socialShareTarget.q.subject || 'វិញ្ញាសាទូទៅ'}`
            : ''
        }
        initialCaption={
          socialShareTarget
            ? formatQuestionSocialCaption(socialShareTarget.q, socialShareTarget.index)
            : ''
        }
        filenameBase={
          socialShareTarget ? `MasterQuiz_Admin_Q${socialShareTarget.index}` : 'MasterQuiz_Card'
        }
        renderImage={useCallback(
          async ({ format, showAnswer }: { format: ShareImageFormat; showAnswer: boolean }) => {
            if (!socialShareTarget) return '';
            return renderQuestionCardImage(socialShareTarget.q, socialShareTarget.index, {
              showAnswer,
              format,
            });
          },
          [socialShareTarget]
        )}
        allowShowAnswerToggle={true}
        defaultShowAnswer={tgPhotoShowAnswer}
        batchCandidates={adminBatchCandidates}
        initialSelectedBatchIds={initialAdminBatchIds}
        defaultMultiMode={socialShareDefaultMulti}
        formatBatchCaption={formatAdminBatchCaption}
      />
    </div>
  );
};
