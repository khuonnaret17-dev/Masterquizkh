import React, { useState } from 'react';
import {
  Download,
  Share,
  PlusSquare,
  X,
  Smartphone,
  MoreVertical,
  Monitor,
  ExternalLink,
  Copy,
  Check,
  CheckCircle2,
} from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  variant?: 'footer' | 'menu' | 'banner' | 'header';
  onAfterTrigger?: () => void;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({
  variant = 'footer',
  onAfterTrigger,
}) => {
  const {
    isInstallable,
    isInstalled,
    isIOS,
    isAndroid,
    inAppBrowser,
    inIframe,
    install,
  } = usePWAInstall();

  const [showGuideModal, setShowGuideModal] = useState(false);
  const [selectedGuideTab, setSelectedGuideTab] = useState<'ios' | 'android' | 'desktop'>(() => {
    if (isIOS) return 'ios';
    if (isAndroid) return 'android';
    return 'desktop';
  });
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [justInstalled, setJustInstalled] = useState(false);

  // Hide only when already running inside installed standalone App (and not showing confirmation)
  if (isInstalled && !justInstalled) {
    return null;
  }

  const appOriginUrl =
    typeof window !== 'undefined' ? window.location.origin : '';

  const handleInstallClick = async () => {
    if (isInstallable) {
      const outcome = await install();
      if (outcome === 'accepted') {
        setJustInstalled(true);
        setShowGuideModal(false);
        onAfterTrigger?.();
        return;
      }
      if (outcome === 'dismissed') {
        return;
      }
    }

    // Fallback when native beforeinstallprompt is unavailable (iOS Safari, in-app WebView, iframe, desktop Safari/Firefox)
    setSelectedGuideTab(isIOS ? 'ios' : isAndroid ? 'android' : 'desktop');
    setShowGuideModal(true);
  };

  const handleCopyUrl = async () => {
    if (!appOriginUrl) return;
    try {
      await navigator.clipboard.writeText(appOriginUrl);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2500);
    } catch {
      // Clipboard blocked in restricted iframe
    }
  };

  return (
    <>
      {variant === 'banner' ? (
        <div className="w-full mt-4 sm:mt-6">
          <div className="khmer-ornate-card rounded-2xl p-3.5 sm:p-4 flex flex-col sm:flex-row items-center justify-between gap-3 sm:gap-4 shadow-sm">
            <div className="flex items-center gap-3 min-w-0 w-full sm:w-auto">
              <div className="p-0.5 rounded-2xl border border-[var(--theme-gold)]/80 bg-[var(--theme-bg-surface)] shrink-0 shadow-xs">
                <img
                  src="/pwa-192x192.png"
                  alt="Master Quiz KH App Icon"
                  className="w-11 h-11 sm:w-12 sm:h-12 rounded-[14px] object-cover"
                />
              </div>
              <div className="min-w-0 text-left">
                <h3 className="font-moul text-xs sm:text-sm app-text-primary truncate">
                  ទាញកម្មវិធីទៅប្រើជា App
                </h3>
                <p className="text-xs app-text-secondary leading-snug mt-0.5">
                  ដំឡើងលើទូរស័ព្ទ Android, iPhone ឬកុំព្យូទ័រ ងាយស្រួលបើកប្រើរហ័ស មាន Logo កម្មវិធីផ្ទាល់
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={handleInstallClick}
              className="w-full sm:w-auto min-h-[44px] px-4 py-2.5 rounded-xl khmer-btn-primary text-xs sm:text-sm font-semibold flex items-center justify-center gap-2 whitespace-nowrap shrink-0 cursor-pointer shadow-sm"
            >
              <Download className="w-4 h-4 shrink-0" />
              <span>{isInstallable ? 'ដំឡើង App ឥឡូវនេះ' : 'ទាញយក App'}</span>
            </button>
          </div>
        </div>
      ) : variant === 'menu' ? (
        <button
          type="button"
          onClick={handleInstallClick}
          className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-medium app-text-primary hover:bg-[var(--theme-bg-hover)] transition cursor-pointer"
        >
          <span className="flex items-center gap-2.5">
            <Download className="w-4 h-4 khmer-gold-text shrink-0" />
            <span>ទាញកម្មវិធីទៅប្រើ App</span>
          </span>
          <span className="text-xs font-bold khmer-accent-text">
            {isInstallable ? 'ដំឡើង' : 'App'}
          </span>
        </button>
      ) : variant === 'header' ? (
        <button
          type="button"
          onClick={handleInstallClick}
          className="min-h-[38px] px-2.5 sm:px-3 py-1 rounded-xl app-card border app-border hover:opacity-90 transition flex items-center gap-1.5 text-xs font-semibold khmer-accent-text whitespace-nowrap cursor-pointer"
          title="ទាញកម្មវិធី Master Quiz KH ទៅដំឡើងជា App"
        >
          <Download className="w-3.5 h-3.5 shrink-0" />
          <span>ដំឡើង App</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={handleInstallClick}
          className="min-h-[44px] px-3.5 py-2 rounded-xl khmer-frame-card text-xs sm:text-sm font-semibold khmer-accent-text hover:opacity-90 transition flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer"
          title="ទាញកម្មវិធី Master Quiz KH ទៅដំឡើងលើ Home Screen ជា App"
        >
          <Download className="w-4 h-4 shrink-0" />
          <span>ទាញយក App</span>
        </button>
      )}

      {/* Install Guide / Status Modal */}
      {showGuideModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowGuideModal(false);
          }}
        >
          <div className="khmer-ornate-card w-full max-w-md rounded-2xl p-5 sm:p-6 shadow-2xl relative text-left max-h-[90vh] overflow-y-auto">
            <button
              type="button"
              onClick={() => setShowGuideModal(false)}
              className="absolute top-3.5 right-3.5 app-text-muted hover:opacity-75 p-1.5 rounded-lg cursor-pointer"
              aria-label="បិទ"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3 mb-4 pr-7">
              <img
                src="/apple-touch-icon.png"
                alt="Master Quiz KH"
                className="w-12 h-12 rounded-2xl border border-[var(--theme-gold)]/80 shadow-sm shrink-0"
              />
              <div className="min-w-0">
                <h3 className="font-moul text-sm sm:text-base app-text-primary leading-snug">
                  ទាញកម្មវិធី Master Quiz KH
                </h3>
                <p className="text-xs app-text-secondary mt-0.5">
                  ដំឡើងលើអេក្រង់ដើម ដើម្បីប្រើជា App ពេញលេញ
                </p>
              </div>
            </div>

            {justInstalled && (
              <div className="mb-4 p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-300 dark:border-emerald-700 text-emerald-800 dark:text-emerald-200 text-xs sm:text-sm flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <span>កម្មវិធីត្រូវបានដំឡើងជោគជ័យហើយ! សូមបើកពីអេក្រង់ដើមរបស់អ្នក។</span>
              </div>
            )}

            {(inAppBrowser || inIframe) && appOriginUrl && (
              <div className="mb-4 p-3.5 rounded-xl app-subcard border border-[var(--theme-gold)]/50 space-y-2.5">
                <p className="text-xs sm:text-sm app-text-primary leading-relaxed font-medium">
                  កម្មវិធីកំពុងបើកក្នុងផ្ទាំងខាងក្នុង (Telegram ឬ Preview)។ សូមបើកតំណខាងក្រោមក្នុង{' '}
                  <strong>Chrome</strong> (Android) ឬ <strong>Safari</strong> (iPhone) ដើម្បីដំឡើងជា App៖
                </p>
                <div className="flex flex-wrap gap-2">
                  <a
                    href={appOriginUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 min-h-[40px] px-3 py-2 rounded-xl khmer-btn-primary text-xs font-semibold flex items-center justify-center gap-1.5"
                  >
                    <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                    <span>បើកក្នុង Browser</span>
                  </a>
                  <button
                    type="button"
                    onClick={handleCopyUrl}
                    className="min-h-[40px] px-3 py-2 rounded-xl app-card border app-border text-xs font-semibold app-text-primary hover:opacity-85 flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    {copiedUrl ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                        <span>បានចម្លង</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5 shrink-0" />
                        <span>ចម្លងតំណ</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}

            {/* Platform Tabs */}
            <div className="grid grid-cols-3 gap-1.5 p-1 rounded-xl app-subcard border app-border mb-4">
              <button
                type="button"
                onClick={() => setSelectedGuideTab('android')}
                className={`py-2 px-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer ${
                  selectedGuideTab === 'android'
                    ? 'khmer-btn-primary shadow-xs'
                    : 'app-text-secondary hover:opacity-80'
                }`}
              >
                <Smartphone className="w-3.5 h-3.5 shrink-0" />
                <span>Android</span>
              </button>
              <button
                type="button"
                onClick={() => setSelectedGuideTab('ios')}
                className={`py-2 px-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer ${
                  selectedGuideTab === 'ios'
                    ? 'khmer-btn-primary shadow-xs'
                    : 'app-text-secondary hover:opacity-80'
                }`}
              >
                <Share className="w-3.5 h-3.5 shrink-0" />
                <span>iPhone / iPad</span>
              </button>
              <button
                type="button"
                onClick={() => setSelectedGuideTab('desktop')}
                className={`py-2 px-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer ${
                  selectedGuideTab === 'desktop'
                    ? 'khmer-btn-primary shadow-xs'
                    : 'app-text-secondary hover:opacity-80'
                }`}
              >
                <Monitor className="w-3.5 h-3.5 shrink-0" />
                <span>កុំព្យូទ័រ</span>
              </button>
            </div>

            {selectedGuideTab === 'android' && (
              <ol className="space-y-2.5 text-xs sm:text-sm app-text-primary leading-relaxed mb-5">
                <li className="flex items-start gap-2.5">
                  <MoreVertical className="w-4 h-4 khmer-accent-text shrink-0 mt-0.5" />
                  <span>
                    ១. បើកគេហទំព័រនេះក្នុងកម្មវិធី <strong>Google Chrome</strong> រួចចុចសញ្ញាចុច ៣ (<strong>⋮</strong>) នៅជ្រុងខាងស្ដាំផ្នែកខាងលើ។
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <Download className="w-4 h-4 khmer-gold-text shrink-0 mt-0.5" />
                  <span>
                    ២. ជ្រើសរើស <strong>Install app</strong> ឬ <strong>Add to Home screen (បន្ថែមទៅអេក្រង់ដើម)</strong>។
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span>
                    ៣. ចុច <strong>Install</strong> ដើម្បីទទួលបាន Icon កម្មវិធីផ្ទាល់លើអេក្រង់ទូរស័ព្ទ។
                  </span>
                </li>
              </ol>
            )}

            {selectedGuideTab === 'ios' && (
              <ol className="space-y-2.5 text-xs sm:text-sm app-text-primary leading-relaxed mb-5">
                <li className="flex items-start gap-2.5">
                  <Share className="w-4 h-4 khmer-accent-text shrink-0 mt-0.5" />
                  <span>
                    ១. បើកគេហទំព័រនេះក្នុង <strong>Safari</strong> រួចចុចប៊ូតុង <strong>Share (ចែករំលែក)</strong> នៅរបារខាងក្រោម ឬខាងលើ។
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <PlusSquare className="w-4 h-4 khmer-gold-text shrink-0 mt-0.5" />
                  <span>
                    ២. អូសចុះក្រោម រួចចុច <strong>Add to Home Screen (បន្ថែមទៅអេក្រង់ដើម)</strong>។
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span>
                    ៣. ចុច <strong>Add (បន្ថែម)</strong> ដើម្បីរក្សាទុក Logo កម្មវិធីលើអេក្រង់ iPhone/iPad។
                  </span>
                </li>
              </ol>
            )}

            {selectedGuideTab === 'desktop' && (
              <ol className="space-y-2.5 text-xs sm:text-sm app-text-primary leading-relaxed mb-5">
                <li className="flex items-start gap-2.5">
                  <Download className="w-4 h-4 khmer-accent-text shrink-0 mt-0.5" />
                  <span>
                    ១. ក្នុង <strong>Chrome</strong> ឬ <strong>Edge</strong> ចុចសញ្ញាដំឡើង (Install App) នៅចុងខាងស្ដាំនៃរបារអាសយដ្ឋាន (Address Bar)។
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <Monitor className="w-4 h-4 khmer-gold-text shrink-0 mt-0.5" />
                  <span>
                    ២. ឬបើកម៉ឺនុយ Browser (<strong>⋮</strong>) → <strong>Cast, save, and share</strong> → <strong>Install Master Quiz KH</strong> (Safari Mac: <strong>File → Add to Dock</strong>)។
                  </span>
                </li>
              </ol>
            )}

            <div className="flex items-center gap-2">
              {isInstallable && (
                <button
                  type="button"
                  onClick={handleInstallClick}
                  className="flex-1 py-2.5 px-4 rounded-xl khmer-btn-primary font-semibold text-sm flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Download className="w-4 h-4" />
                  <span>ដំឡើងឥឡូវនេះ</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowGuideModal(false)}
                className={`${isInstallable ? 'px-4' : 'w-full'} py-2.5 rounded-xl app-subcard border app-border font-semibold text-sm app-text-primary hover:opacity-85 cursor-pointer`}
              >
                បិទ
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
