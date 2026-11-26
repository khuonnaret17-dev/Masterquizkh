import { useEffect, useState, useCallback } from 'react';
import { isInsideTelegramMiniApp } from '../services/telegramWebApp';

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export type InstallPlatform = 'ios' | 'android' | 'desktop';

// Module-level shared store so early `beforeinstallprompt` events are never missed before React mounts
let cachedDeferredPrompt: BeforeInstallPromptEvent | null = null;
let cachedIsInstalled = false;
const listeners = new Set<() => void>();
let initialized = false;

function detectStandaloneMode(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: minimal-ui)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function detectPlatform(): InstallPlatform {
  if (typeof window === 'undefined') return 'desktop';
  const ua = window.navigator.userAgent.toLowerCase();
  const isIPadDesktopMode =
    ua.includes('macintosh') &&
    typeof navigator !== 'undefined' &&
    typeof navigator.maxTouchPoints === 'number' &&
    navigator.maxTouchPoints > 1;
  if (/iphone|ipad|ipod/.test(ua) || isIPadDesktopMode) return 'ios';
  if (/android/.test(ua)) return 'android';
  return 'desktop';
}

function detectEmbeddedContext(): { inTelegram: boolean; inAppBrowser: boolean; inIframe: boolean } {
  if (typeof window === 'undefined') {
    return { inTelegram: false, inAppBrowser: false, inIframe: false };
  }
  const ua = window.navigator.userAgent.toLowerCase();
  const inTelegram = isInsideTelegramMiniApp() || ua.includes('telegram');
  const inAppBrowser =
    inTelegram ||
    /fban|fbav|fb_iab|messenger|instagram|line\/|micromessenger|wv\)/.test(ua);
  let inIframe = false;
  try {
    inIframe = window.self !== window.top;
  } catch {
    inIframe = true;
  }
  return { inTelegram, inAppBrowser, inIframe };
}

function notifyAll() {
  listeners.forEach((cb) => cb());
}

function ensureGlobalListeners() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  cachedIsInstalled = detectStandaloneMode();

  window.addEventListener('beforeinstallprompt', (e: Event) => {
    e.preventDefault();
    cachedDeferredPrompt = e as BeforeInstallPromptEvent;
    notifyAll();
  });

  window.addEventListener('appinstalled', () => {
    cachedIsInstalled = true;
    cachedDeferredPrompt = null;
    notifyAll();
  });

  const mediaQuery = window.matchMedia('(display-mode: standalone)');
  const onDisplayModeChange = (ev: MediaQueryListEvent) => {
    if (ev.matches) {
      cachedIsInstalled = true;
      cachedDeferredPrompt = null;
      notifyAll();
    }
  };
  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', onDisplayModeChange);
  }
}

ensureGlobalListeners();

export function usePWAInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(
    () => cachedDeferredPrompt
  );
  const [isInstalled, setIsInstalled] = useState<boolean>(() => cachedIsInstalled || detectStandaloneMode());
  const [platform] = useState<InstallPlatform>(() => detectPlatform());
  const [embedded] = useState(() => detectEmbeddedContext());

  useEffect(() => {
    ensureGlobalListeners();
    const sync = () => {
      setDeferredPrompt(cachedDeferredPrompt);
      setIsInstalled(cachedIsInstalled || detectStandaloneMode());
    };
    sync();
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);

  const install = useCallback(async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    const promptEvent = cachedDeferredPrompt;
    if (!promptEvent) return 'unavailable';
    try {
      await promptEvent.prompt();
      const { outcome } = await promptEvent.userChoice;
      if (outcome === 'accepted') {
        cachedIsInstalled = true;
        cachedDeferredPrompt = null;
        notifyAll();
        return 'accepted';
      }
      return 'dismissed';
    } catch {
      return 'unavailable';
    }
  }, []);

  return {
    isInstallable: Boolean(deferredPrompt),
    isInstalled,
    isIOS: platform === 'ios',
    isAndroid: platform === 'android',
    platform,
    inTelegram: embedded.inTelegram,
    inAppBrowser: embedded.inAppBrowser,
    inIframe: embedded.inIframe,
    install,
  };
}
