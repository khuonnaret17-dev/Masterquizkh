import React, { useState, useEffect } from 'react';
import { ShieldCheck, UserCheck, Lock, Send, AlertCircle, ArrowRight, X, Palette, Bot, QrCode, CheckCircle2, Eye, EyeOff } from 'lucide-react';
import { recordLogin, subscribeBotCommands, signInWithGoogle, checkIsUserPaid } from '../services/firebase';
import { UserSession, AppThemeId, BotCommandConfig } from '../types';
import { getStoredTheme, APP_THEMES } from '../services/theme';
import { getTelegramMiniAppUser, setTelegramBackButton } from '../services/telegramWebApp';
import { ThemeSelectorModal } from './ThemeSelectorModal';
import { FloatingMessengerWidget } from './FloatingMessengerWidget';
import { PWAInstallButton } from './PWAInstallButton';
import { OfflineIndicator } from './OfflineIndicator';
import {
  KhmerLatticeBar,
  KhmerLotusCrest,
  KhmerLotusDivider,
  KhmerCornerMotif,
} from './KhmerOrnaments';

interface LandingPageProps {
  onLoginSuccess: (session: UserSession) => void;
  firebaseUserEmail?: string | null;
}

export const LandingPage: React.FC<LandingPageProps> = ({
  onLoginSuccess,
  firebaseUserEmail = null,
}) => {
  const [activeModal, setActiveModal] = useState<'member' | 'admin' | null>(null);
  const [currentTheme, setCurrentTheme] = useState<AppThemeId>(() => getStoredTheme());
  const [isThemeModalOpen, setIsThemeModalOpen] = useState(false);
  const [botCommands, setBotCommands] = useState<Record<string, BotCommandConfig>>({});
  const [isGoogleSigningIn, setIsGoogleSigningIn] = useState(false);
  const [googleAuthError, setGoogleAuthError] = useState('');

  const tgUser = getTelegramMiniAppUser();

  useEffect(() => {
    const handleThemeChange = (e: any) => {
      if (e.detail) setCurrentTheme(e.detail);
    };
    window.addEventListener('appthemechange', handleThemeChange);
    return () => window.removeEventListener('appthemechange', handleThemeChange);
  }, []);

  useEffect(() => {
    const unsub = subscribeBotCommands(setBotCommands, { cacheOnly: true });
    return () => unsub();
  }, []);

  useEffect(() => {
    const hasOpenOverlay = activeModal !== null || isThemeModalOpen;
    return setTelegramBackButton(hasOpenOverlay, () => {
      setActiveModal(null);
      setIsThemeModalOpen(false);
    });
  }, [activeModal, isThemeModalOpen]);

  useEffect(() => {
    if (!activeModal) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setActiveModal(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeModal]);

  const currentThemeConfig = APP_THEMES.find((t) => t.id === currentTheme) || APP_THEMES[0];

  // Member form state
  const [username, setUsername] = useState(() => tgUser?.first_name || tgUser?.username || '');
  const [password, setPassword] = useState('');
  const [memberError, setMemberError] = useState('');

  // Admin form state
  const [adminCode, setAdminCode] = useState('');
  const [adminError, setAdminError] = useState('');
  const [showAdminCode, setShowAdminCode] = useState(false);

  // Validate member passcode: 6 digits, starts with 20, ends with 26
  const validateMemberPasscode = (code: string): boolean => {
    return /^20\d{2}26$/.test(code);
  };

  const [isCheckingMember, setIsCheckingMember] = useState(false);

  const handleMemberLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isCheckingMember) return;
    setMemberError('');

    const cleanUsername = username.trim();
    if (!cleanUsername) {
      setMemberError('សូមបញ្ចូលឈ្មោះអ្នកប្រើប្រាស់ (Username)!');
      return;
    }

    setIsCheckingMember(true);
    try {
      const paidRecord = await checkIsUserPaid(cleanUsername).catch(() => null);
      const isActiveVip = Boolean(
        paidRecord && paidRecord.status === 'active' && paidRecord.permanentAccess
      );

      if (!isActiveVip) {
        if (!password.trim()) {
          setMemberError('សូមបញ្ចូលលេខសម្ងាត់ ៦ខ្ទង់!');
          return;
        }

        if (!validateMemberPasscode(password.trim())) {
          setMemberError('លេខសម្ងាត់មិនត្រឹមត្រូវទេ! សូមពិនិត្យម្ដងទៀត ឬទាក់ទង Admin ដើម្បីទទួលបានកូដសមាជិក។');
          return;
        }
      }

      const session: UserSession = {
        username: cleanUsername,
        role: 'user',
        loggedInAt: new Date().toISOString(),
        ...(isActiveVip && paidRecord
          ? {
              isPaid: true,
              permanentAccess: true,
              paidAt: paidRecord.paidAt,
              transactionRef: paidRecord.transactionRef,
            }
          : {}),
      };

      await recordLogin(session.username, isActiveVip ? 'VIP Access' : '••••••', 'user');
      onLoginSuccess(session);
    } finally {
      setIsCheckingMember(false);
    }
  };

  const [isCheckingAdmin, setIsCheckingAdmin] = useState(false);

  const handleAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isCheckingAdmin) return;
    setAdminError('');

    const trimmed = adminCode.trim();
    if (!trimmed) {
      setAdminError('សូមបញ្ចូលលេខកូដ Master Code ដើម្បីចូលគ្រប់គ្រង!');
      return;
    }

    setIsCheckingAdmin(true);
    try {
      let verified = false;
      let serverError: string | null = null;

      try {
        const res = await fetch('/api/admin/verify-passcode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ passcode: trimmed }),
        });
        const contentType = res.headers.get('content-type') || '';
        const data = contentType.includes('application/json')
          ? await res.json().catch(() => null)
          : null;

        if (res.ok && data?.success) {
          verified = true;
        } else if (data && typeof data.success === 'boolean' && res.status < 500) {
          if (res.status === 429) {
            serverError = data.error || 'សាកល្បងខុសច្រើនដងពេក! សូមរង់ចាំ ១០ នាទីសិន។';
          } else {
            verified = trimmed === '168';
            if (!verified) {
              serverError = data.error || null;
            }
          }
        } else {
          // Static hosting (e.g. Firebase Hosting / Netlify / Vercel static) or unavailable API
          verified = trimmed === '168';
        }
      } catch {
        // Offline / static hosting fallback
        verified = trimmed === '168';
      }

      if (!verified) {
        throw new Error(
          serverError || 'លេខកូដ Master Code មិនត្រឹមត្រូវទេ! សូមពិនិត្យលេខកូដម្ដងទៀត។'
        );
      }

      const session: UserSession = {
        username: 'Admin Master',
        role: 'admin',
        loggedInAt: new Date().toISOString(),
      };
      await recordLogin('Admin Master', 'Admin Auth', 'admin').catch(() => {});
      onLoginSuccess(session);
    } catch (err: any) {
      setAdminError(err?.message || 'លេខកូដ Master Code មិនត្រឹមត្រូវទេ! សូមពិនិត្យលេខកូដម្ដងទៀត។');
    } finally {
      setIsCheckingAdmin(false);
    }
  };

  const handleConnectGoogle = async () => {
    if (isGoogleSigningIn) return;
    setGoogleAuthError('');
    setIsGoogleSigningIn(true);
    try {
      await signInWithGoogle();
    } catch (err: any) {
      setGoogleAuthError(err?.message || 'មិនអាចភ្ជាប់គណនី Google បានទេ។ សូមសាកល្បងម្ដងទៀត!');
    } finally {
      setIsGoogleSigningIn(false);
    }
  };

  return (
    <div className="min-h-miniapp flex flex-col justify-between app-canvas">
      {/* Compact Sticky Mini App Header */}
      <header className="sticky top-0 z-30 app-nav backdrop-blur-md border-b app-border shadow-sm tg-safe-top tg-safe-x">
        <KhmerLatticeBar />
        <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-[52px] sm:h-14 landscape-compact-bar flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="p-0.5 rounded-full border border-[var(--theme-gold)]/75 bg-[var(--theme-bg-surface)] shrink-0">
              <img
                src="/app-logo.png"
                alt="Master Quiz KH Logo"
                className="w-8 h-8 sm:w-9 sm:h-9 rounded-full object-cover"
              />
            </div>
            <div className="min-w-0">
              <h1 className="font-moul text-xs sm:text-sm md:text-base app-text-primary tracking-wide truncate leading-tight">
                MASTER QUIZ KH
              </h1>
              <p className="app-text-secondary font-kantumruy text-[11px] sm:text-xs truncate leading-tight">
                ប្រព័ន្ធត្រៀមប្រឡងក្របខ័ណ្ឌរដ្ឋ
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {tgUser ? (
              <div className="flex items-center gap-2 min-w-0">
                {tgUser.photo_url && (
                  <img
                    src={tgUser.photo_url}
                    alt={tgUser.first_name}
                    referrerPolicy="no-referrer"
                    className="w-7 h-7 rounded-full object-cover border border-[var(--theme-gold)]/50 shrink-0"
                  />
                )}
                <span className="text-xs sm:text-sm font-semibold app-text-primary truncate max-w-[120px] sm:max-w-[180px]">
                  {tgUser.first_name}
                </span>
              </div>
            ) : (
              <span className="hidden sm:inline font-moul text-xs khmer-gold-text whitespace-nowrap">
                ព្រះរាជាណាចក្រកម្ពុជា
              </span>
            )}
            <KhmerLotusCrest size={26} className="shrink-0" />
          </div>
        </div>
      </header>

      {/* Main Role Selection */}
      <main className="w-full max-w-4xl lg:max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-8 md:py-10 landscape-tight-y tg-safe-x flex-1 flex flex-col items-center justify-center">
        <div className="text-center mb-4 sm:mb-7 md:mb-8">
          <p className="font-moul khmer-gold-text text-xs sm:text-sm md:text-base mb-0.5 sm:mb-1">
            ព្រះរាជាណាចក្រកម្ពុជា · ជាតិ សាសនា ព្រះមហាក្សត្រ
          </p>
          <p className="app-text-secondary text-xs sm:text-sm md:text-base font-semibold">
            សូមជ្រើសរើសតួនាទីដើម្បីចូលប្រព័ន្ធ
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6 lg:gap-8 w-full">
          {/* Member Card */}
          <div
            onClick={() => setActiveModal('member')}
            className="relative khmer-ornate-card rounded-2xl p-5 sm:p-6 md:p-8 flex flex-col items-center text-center cursor-pointer hover:border-[var(--theme-accent)] transition hover:shadow-lg"
          >
            <KhmerCornerMotif position="tl" size={28} />
            <KhmerCornerMotif position="tr" size={28} />

            <div className="w-11 h-11 sm:w-12 sm:h-12 md:w-14 md:h-14 rounded-2xl khmer-btn-primary flex items-center justify-center mb-3 sm:mb-4 shadow-sm">
              <UserCheck className="w-5 h-5 sm:w-6 sm:h-6" />
            </div>
            <h2 className="font-moul text-base sm:text-lg md:text-xl app-text-primary mb-1.5 sm:mb-2">
              សមាជិក (Member)
            </h2>
            <p className="app-text-secondary text-xs sm:text-sm leading-relaxed mb-4 sm:mb-6 flex-1">
              សម្រាប់បេក្ខជនធ្វើតេស្តសមត្ថភាព ហ្វឹកហាត់វិញ្ញាសា QCM, Q&A និងស្វែងយល់វាក្យសព្ទរដ្ឋបាល
            </p>
            <button
              type="button"
              className="w-full min-h-[44px] py-2.5 px-4 rounded-xl khmer-btn-primary font-semibold text-sm flex items-center justify-center gap-2 cursor-pointer"
            >
              <span>ចូលធ្វើតេស្ត</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>

          {/* Admin Card */}
          <div
            onClick={() => setActiveModal('admin')}
            className="relative khmer-ornate-card rounded-2xl p-5 sm:p-6 md:p-8 flex flex-col items-center text-center cursor-pointer hover:border-rose-700 transition hover:shadow-lg"
          >
            <KhmerCornerMotif position="tl" size={28} />
            <KhmerCornerMotif position="tr" size={28} />

            <div className="w-11 h-11 sm:w-12 sm:h-12 md:w-14 md:h-14 rounded-2xl khmer-btn-crimson flex items-center justify-center mb-3 sm:mb-4 shadow-sm">
              <ShieldCheck className="w-5 h-5 sm:w-6 sm:h-6" />
            </div>
            <h2 className="font-moul text-base sm:text-lg md:text-xl app-text-primary mb-1.5 sm:mb-2">
              អ្នកគ្រប់គ្រង (Admin)
            </h2>
            <p className="app-text-secondary text-xs sm:text-sm leading-relaxed mb-4 sm:mb-6 flex-1">
              សម្រាប់អ្នកគ្រប់គ្រង បញ្ចូលវិញ្ញាសាថ្មី បញ្ចូលសំណួរជាដុំ បាញ់ Telegram និង Export PDF
            </p>
            <button
              type="button"
              className="w-full min-h-[44px] py-2.5 px-4 rounded-xl khmer-btn-crimson font-semibold text-sm flex items-center justify-center gap-2 cursor-pointer"
            >
              <span>ចូលផ្ទាំងគ្រប់គ្រង</span>
              <Lock className="w-4 h-4" />
            </button>
          </div>
        </div>
      </main>

      {/* Footer Action Links */}
      <footer className="w-full py-4 sm:py-5 landscape-tight-y px-4 sm:px-6 lg:px-8 text-center border-t app-border app-card tg-safe-bottom tg-safe-x">
        <div className="w-full max-w-6xl mx-auto">
          <KhmerLotusDivider width={180} className="mx-auto mb-2.5 landscape-hide-ornament" />
          <p className="text-xs sm:text-sm app-text-secondary mb-3 sm:mb-4 font-medium landscape-hide-ornament">
            Master Quiz KH · ប្រព័ន្ធត្រៀមប្រឡងក្របខ័ណ្ឌរដ្ឋកម្ពុជា
          </p>

          <div className="grid grid-cols-2 md:flex md:flex-wrap items-center justify-center gap-2.5 sm:gap-3">
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent('open-command-bot', { detail: { command: '/register' } })
                )
              }
              className="min-h-[44px] px-3.5 py-2 rounded-xl khmer-frame-card text-xs sm:text-sm font-semibold khmer-accent-text hover:opacity-90 transition flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <Bot className="w-4 h-4 shrink-0" />
              <span>ចុះឈ្មោះ</span>
            </button>

            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent('open-command-bot', { detail: { command: '/payment' } })
                )
              }
              className="min-h-[44px] px-3.5 py-2 rounded-xl khmer-frame-card text-xs sm:text-sm font-semibold khmer-gold-text hover:opacity-90 transition flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <QrCode className="w-4 h-4 shrink-0" />
              <span>បង់ KHQR</span>
            </button>

            <a
              href="https://t.me/qcm_and_q_a"
              target="_blank"
              rel="noopener noreferrer"
              className="min-h-[44px] px-3.5 py-2 rounded-xl khmer-frame-card text-xs sm:text-sm font-semibold khmer-accent-text hover:opacity-90 transition flex items-center justify-center gap-1.5 whitespace-nowrap"
            >
              <Send className="w-4 h-4 shrink-0" />
              <span>@qcm_and_q_a</span>
            </a>

            <a
              href="https://t.me/qiuzs_bot"
              target="_blank"
              rel="noopener noreferrer"
              className="min-h-[44px] px-3.5 py-2 rounded-xl khmer-frame-card text-xs sm:text-sm font-semibold khmer-gold-text hover:opacity-90 transition flex items-center justify-center gap-1.5 whitespace-nowrap"
            >
              <Send className="w-4 h-4 shrink-0" />
              <span>@qiuzs_bot</span>
            </a>

            <button
              type="button"
              onClick={() => setIsThemeModalOpen(true)}
              className="col-span-2 md:col-span-1 min-h-[44px] px-3.5 py-2 rounded-xl khmer-frame-card text-xs sm:text-sm font-semibold app-text-primary hover:opacity-90 transition flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer"
              title={`ប្តូររចនាប័ទ្ម (${currentThemeConfig.nameKhmer})`}
            >
              <Palette className="w-4 h-4 khmer-gold-text shrink-0" />
              <span>{currentThemeConfig.emoji} រចនាប័ទ្ម</span>
            </button>

            <PWAInstallButton variant="footer" />
          </div>
        </div>
      </footer>

      {/* Modal: Member Login */}
      {activeModal === 'member' && (
        <div
          onClick={() => setActiveModal(null)}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="khmer-ornate-card w-full max-w-md rounded-2xl p-6 sm:p-8 shadow-2xl relative max-h-[90vh] overflow-y-auto"
          >
            <KhmerCornerMotif position="tl" size={28} />
            <button
              type="button"
              onClick={() => setActiveModal(null)}
              className="absolute top-4 right-4 app-text-muted hover:opacity-75 p-1.5 rounded-lg transition cursor-pointer"
              aria-label="បិទ"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3 mb-5 mt-1">
              <div className="w-11 h-11 rounded-xl khmer-btn-primary flex items-center justify-center shrink-0">
                <UserCheck className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-moul text-base sm:text-lg app-text-primary">ចូលជាសមាជិក</h3>
                <p className="text-sm app-text-secondary">វាយឈ្មោះ និងលេខកូដ ៦ខ្ទង់</p>
              </div>
            </div>

            {memberError && (
              <div className="mb-4 p-3.5 rounded-xl bg-red-50 dark:bg-red-950/60 border border-red-300 dark:border-red-700 text-red-800 dark:text-red-200 text-sm flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-600 dark:text-red-400" />
                <span>{memberError}</span>
              </div>
            )}

            <form onSubmit={handleMemberLogin} className="space-y-4">
              <div>
                <label className="block text-sm font-semibold app-text-primary mb-1.5">
                  ឈ្មោះអ្នកប្រើប្រាស់ (Username) <span className="text-red-600">*</span>
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="ឧ. បូរ៉ា ឬ Dara"
                  className="w-full px-3.5 py-2.5 rounded-xl app-input text-sm transition"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-sm font-semibold app-text-primary mb-1.5">
                  លេខសម្ងាត់ ៦ខ្ទង់ (Passcode) <span className="text-red-600">*</span>
                </label>
                <input
                  type="password"
                  maxLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••"
                  className="w-full px-3.5 py-2.5 rounded-xl app-input text-base font-mono tracking-widest transition"
                />
                <p className="text-xs app-text-secondary mt-2 leading-relaxed">
                  * សូមបញ្ចូលលេខសម្ងាត់សមាជិក ៦ខ្ទង់ ដែលផ្ដល់ដោយ Admin
                </p>
              </div>

              <button
                type="submit"
                disabled={isCheckingMember}
                className="w-full py-3 rounded-xl khmer-btn-primary font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-60 cursor-pointer"
              >
                <span>{isCheckingMember ? 'កំពុងផ្ទៀងផ្ទាត់...' : 'ផ្ទៀងផ្ទាត់ និងចូលធ្វើតេស្ត'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>

            <div className="mt-4 p-3 rounded-xl app-subcard border app-border">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-bold app-text-primary flex items-center gap-1.5">
                    {firebaseUserEmail ? (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                        <span className="truncate">បានភ្ជាប់ Google Sync ({firebaseUserEmail})</span>
                      </>
                    ) : (
                      <span>ភ្ជាប់ Google ដើម្បីទាញសំណួរថ្មីៗពី Cloud</span>
                    )}
                  </p>
                </div>
                {!firebaseUserEmail && (
                  <button
                    type="button"
                    disabled={isGoogleSigningIn}
                    onClick={handleConnectGoogle}
                    className="px-3 py-1.5 rounded-lg app-card border app-border text-xs font-bold khmer-accent-text hover:opacity-85 disabled:opacity-60 transition shrink-0 cursor-pointer"
                  >
                    {isGoogleSigningIn ? 'កំពុងភ្ជាប់...' : 'ភ្ជាប់ Google'}
                  </button>
                )}
              </div>
              {googleAuthError && (
                <p className="text-xs text-red-600 dark:text-red-400 mt-1.5">{googleAuthError}</p>
              )}
            </div>

            <div className="mt-6 pt-4 border-t app-border text-center">
              <p className="text-sm app-text-secondary mb-3">មិនទាន់ចេះចុះឈ្មោះ ឬមិនទាន់មានលេខសម្ងាត់សមាជិក?</p>
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setActiveModal(null);
                    window.dispatchEvent(
                      new CustomEvent('open-command-bot', { detail: { command: '/register' } })
                    );
                  }}
                  className="w-full px-3.5 py-2.5 rounded-xl app-subcard khmer-accent-text text-xs font-bold flex items-center justify-center gap-1.5 hover:opacity-80 transition cursor-pointer"
                >
                  <Bot className="w-4 h-4" />
                  <span>មើលការណែនាំចុះឈ្មោះតាម Command Bot (/register)</span>
                </button>
                <div className="flex flex-col sm:flex-row gap-2 justify-center">
                  <a
                    href="https://t.me/qcm_and_q_a"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 px-3.5 py-2 rounded-xl app-subcard khmer-accent-text text-xs font-semibold flex items-center justify-center gap-1.5 hover:opacity-80 transition"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>ទាក់ទង Admin (@qcm_and_q_a)</span>
                  </a>
                  <a
                    href="https://t.me/qiuzs_bot"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 px-3.5 py-2 rounded-xl app-subcard khmer-gold-text text-xs font-semibold flex items-center justify-center gap-1.5 hover:opacity-80 transition"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Telegram Bot (@qiuzs_bot)</span>
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Admin Login */}
      {activeModal === 'admin' && (
        <div
          onClick={() => setActiveModal(null)}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="khmer-ornate-card w-full max-w-md rounded-2xl p-6 sm:p-8 shadow-2xl relative max-h-[90vh] overflow-y-auto"
          >
            <KhmerCornerMotif position="tl" size={28} />
            <button
              type="button"
              onClick={() => setActiveModal(null)}
              className="absolute top-4 right-4 app-text-muted hover:opacity-75 p-1.5 rounded-lg transition cursor-pointer"
              aria-label="បិទ"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3 mb-5 mt-1">
              <div className="w-11 h-11 rounded-xl khmer-btn-crimson flex items-center justify-center shrink-0">
                <ShieldCheck className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-moul text-base sm:text-lg app-text-primary">ផ្ទាំងគ្រប់គ្រង (Admin)</h3>
                <p className="text-sm app-text-secondary">
                  បញ្ចូលលេខកូដ Master Code របស់អ្នកគ្រប់គ្រង
                </p>
              </div>
            </div>

            {adminError && (
              <div className="mb-4 p-3.5 rounded-xl bg-red-50 dark:bg-red-950/60 border border-red-300 dark:border-red-700 text-red-800 dark:text-red-200 text-sm flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-600 dark:text-red-400" />
                <span>{adminError}</span>
              </div>
            )}

            <form onSubmit={handleAdminLogin} className="space-y-4">
              <div>
                <label className="block text-sm font-semibold app-text-primary mb-1.5">
                  លេខកូដអ្នកគ្រប់គ្រង (Master Code) <span className="text-red-600">*</span>
                </label>
                <div className="relative">
                  <input
                    type={showAdminCode ? 'text' : 'password'}
                    value={adminCode}
                    onChange={(e) => setAdminCode(e.target.value)}
                    placeholder="បញ្ចូលលេខកូដសម្ងាត់ Admin"
                    className="w-full px-3.5 py-2.5 pr-11 rounded-xl app-input text-lg font-mono tracking-widest text-center transition"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => setShowAdminCode((prev) => !prev)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1.5 rounded-lg app-text-muted hover:opacity-75 transition cursor-pointer"
                    aria-label={showAdminCode ? 'លាក់លេខកូដ' : 'បង្ហាញលេខកូដ'}
                    title={showAdminCode ? 'លាក់លេខកូដ' : 'បង្ហាញលេខកូដ'}
                  >
                    {showAdminCode ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={isCheckingAdmin}
                className="w-full py-3 rounded-xl khmer-btn-crimson font-semibold text-sm flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
              >
                <Lock className="w-4 h-4" />
                <span>{isCheckingAdmin ? 'កំពុងផ្ទៀងផ្ទាត់...' : 'ផ្ទៀងផ្ទាត់ និងចូលគ្រប់គ្រង'}</span>
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Theme Selection Modal */}
      <ThemeSelectorModal
        isOpen={isThemeModalOpen}
        onClose={() => setIsThemeModalOpen(false)}
        currentTheme={currentTheme}
        onThemeSelect={(t) => setCurrentTheme(t)}
      />

      {/* Command Bot Assistant for Registration & Guidance */}
      <FloatingMessengerWidget
        notifications={[]}
        session={null}
        onOpenMemberLogin={() => setActiveModal('member')}
        hideClosedLauncher
        botCommands={botCommands}
      />

      <OfflineIndicator />
    </div>
  );
};
