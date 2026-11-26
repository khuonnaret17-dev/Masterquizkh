import React, { useState } from 'react';
import { Download, Share, PlusSquare, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  variant?: 'footer' | 'menu';
  onAfterTrigger?: () => void;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({
  variant = 'footer',
  onAfterTrigger,
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (!isInstallable && !isIOS) {
    return null;
  }

  const handleClick = async () => {
    if (isInstallable) {
      await install();
      onAfterTrigger?.();
      return;
    }
    if (isIOS) {
      setShowIOSGuide(true);
    }
  };

  return (
    <>
      {variant === 'menu' ? (
        <button
          type="button"
          onClick={handleClick}
          className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-medium app-text-primary hover:bg-[var(--theme-bg-hover)] transition cursor-pointer"
        >
          <span className="flex items-center gap-2.5">
            <Download className="w-4 h-4 khmer-gold-text shrink-0" />
            <span>ដំឡើងលើ Home Screen</span>
          </span>
          <span className="text-xs font-bold khmer-accent-text">App</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={handleClick}
          className="min-h-[44px] px-3.5 py-2 rounded-xl khmer-frame-card text-xs sm:text-sm font-semibold khmer-accent-text hover:opacity-90 transition flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer"
          title="បន្ថែមកម្មវិធីទៅកាន់ Home Screen ដោយភ្ជាប់ Logo កម្មវិធី"
        >
          <Download className="w-4 h-4 shrink-0" />
          <span>ដំឡើង App</span>
        </button>
      )}

      {showIOSGuide && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="khmer-ornate-card w-full max-w-sm rounded-2xl p-6 shadow-2xl relative text-left">
            <button
              type="button"
              onClick={() => setShowIOSGuide(false)}
              className="absolute top-3.5 right-3.5 app-text-muted hover:opacity-75 p-1.5 rounded-lg cursor-pointer"
              aria-label="បិទ"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3 mb-4">
              <img
                src="/apple-touch-icon.png"
                alt="Master Quiz KH"
                className="w-12 h-12 rounded-xl border border-[var(--theme-gold)]/70 shadow-sm shrink-0"
              />
              <div>
                <h3 className="font-moul text-sm sm:text-base app-text-primary">
                  ដំឡើងលើ Home Screen
                </h3>
                <p className="text-xs app-text-secondary">
                  សម្រាប់ iPhone / iPad (Safari)
                </p>
              </div>
            </div>

            <ol className="space-y-2.5 text-xs sm:text-sm app-text-primary leading-relaxed mb-5">
              <li className="flex items-start gap-2">
                <Share className="w-4 h-4 khmer-accent-text shrink-0 mt-0.5" />
                <span>
                  ១. ចុចប៊ូតុង <strong>Share</strong> នៅខាងក្រោម ឬខាងលើក្នុង Safari។
                </span>
              </li>
              <li className="flex items-start gap-2">
                <PlusSquare className="w-4 h-4 khmer-gold-text shrink-0 mt-0.5" />
                <span>
                  ២. អូសចុះក្រោម រួចចុច <strong>Add to Home Screen</strong> ដើម្បីបង្ហាញ Logo កម្មវិធី។
                </span>
              </li>
            </ol>

            <button
              type="button"
              onClick={() => setShowIOSGuide(false)}
              className="w-full py-2.5 rounded-xl khmer-btn-primary font-semibold text-sm cursor-pointer"
            >
              យល់ព្រម
            </button>
          </div>
        </div>
      )}
    </>
  );
};
