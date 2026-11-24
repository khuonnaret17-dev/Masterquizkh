export interface TelegramMiniAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
}

interface TelegramWebAppInstance {
  initData?: string;
  initDataUnsafe?: {
    user?: TelegramMiniAppUser;
    start_param?: string;
  };
  version?: string;
  platform?: string;
  colorScheme?: 'light' | 'dark';
  isExpanded?: boolean;
  viewportHeight?: number;
  viewportStableHeight?: number;
  ready: () => void;
  expand: () => void;
  close: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  setBottomBarColor?: (color: string) => void;
  disableVerticalSwipes?: () => void;
  enableClosingConfirmation?: () => void;
  onEvent?: (eventType: string, callback: () => void) => void;
  offEvent?: (eventType: string, callback: () => void) => void;
  BackButton?: {
    isVisible: boolean;
    show: () => void;
    hide: () => void;
    onClick: (cb: () => void) => void;
    offClick: (cb: () => void) => void;
  };
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebAppInstance;
    };
  }
}

export function getTelegramWebApp(): TelegramWebAppInstance | null {
  if (typeof window === 'undefined') return null;
  const tg = window.Telegram?.WebApp;
  if (!tg) return null;
  return tg;
}

export function isInsideTelegramMiniApp(): boolean {
  const tg = getTelegramWebApp();
  if (!tg) return false;
  return Boolean(
    (tg.initData && tg.initData.length > 0) ||
      tg.initDataUnsafe?.user ||
      (tg.platform && tg.platform !== 'unknown')
  );
}

export function getTelegramMiniAppUser(): TelegramMiniAppUser | null {
  const tg = getTelegramWebApp();
  return tg?.initDataUnsafe?.user || null;
}

function cssColorToHex(raw: string, fallback: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return fallback;
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed;
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  const rgbMatch = trimmed.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgbMatch) {
    const toHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
    return `#${toHex(Number(rgbMatch[1]))}${toHex(Number(rgbMatch[2]))}${toHex(Number(rgbMatch[3]))}`;
  }
  return fallback;
}

export function syncTelegramMiniAppTheme(): void {
  const tg = getTelegramWebApp();
  if (!tg || typeof document === 'undefined') return;

  try {
    const styles = getComputedStyle(document.documentElement);
    const bodyBg = cssColorToHex(styles.getPropertyValue('--theme-bg-body'), '#f7f2e6');
    const surfaceBg = cssColorToHex(styles.getPropertyValue('--theme-bg-surface'), '#fffdf8');

    tg.setHeaderColor?.(surfaceBg);
    tg.setBackgroundColor?.(bodyBg);
    tg.setBottomBarColor?.(surfaceBg);
  } catch {
    // Ignore when not supported by older Telegram clients
  }
}

export function initTelegramMiniApp(): () => void {
  const tg = getTelegramWebApp();
  if (!tg) return () => {};

  try {
    tg.ready();
    tg.expand();
    tg.disableVerticalSwipes?.();
  } catch {
    // Ignore SDK errors outside Telegram container
  }

  syncTelegramMiniAppTheme();

  const handleThemeSync = () => syncTelegramMiniAppTheme();
  window.addEventListener('appthemechange', handleThemeSync);

  return () => {
    window.removeEventListener('appthemechange', handleThemeSync);
  };
}

export function setTelegramBackButton(visible: boolean, onClick?: () => void): () => void {
  const tg = getTelegramWebApp();
  const backBtn = tg?.BackButton;
  if (!backBtn) return () => {};

  const handler = () => {
    onClick?.();
  };

  try {
    if (visible && onClick) {
      backBtn.show();
      backBtn.onClick(handler);
    } else {
      backBtn.hide();
    }
  } catch {
    // Ignore
  }

  return () => {
    try {
      if (onClick) {
        backBtn.offClick(handler);
      }
      backBtn.hide();
    } catch {
      // Ignore
    }
  };
}
