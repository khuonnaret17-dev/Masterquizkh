/**
 * Khmer Language and Number Utilities
 */

const KHMER_DIGITS = ['០', '១', '២', '៣', '៤', '៥', '៦', '៧', '៨', '៩'];

export function toKhmerNum(num: number | string | undefined | null): string {
  if (num === undefined || num === null) return '';
  return String(num).replace(/[0-9]/g, (digit) => KHMER_DIGITS[parseInt(digit, 10)]);
}

export function isEnglishSubject(subjectName: string): boolean {
  if (!subjectName) return false;
  const lower = subjectName.toLowerCase();
  return lower.includes('english') || lower.includes('អង់គ្លេស');
}

export const KHMER_OPTIONS_LABELS = ['ក', 'ខ', 'គ', 'ឃ'];
export const ENGLISH_OPTIONS_LABELS = ['A', 'B', 'C', 'D'];

export function getOptionLabel(index: number, subjectName?: string): string {
  if (subjectName && isEnglishSubject(subjectName)) {
    return ENGLISH_OPTIONS_LABELS[index] || String.fromCharCode(65 + index);
  }
  return KHMER_OPTIONS_LABELS[index] || String(index + 1);
}

/**
 * Fisher-Yates array shuffle for truly fair randomization
 */
export function shuffleArray<T>(array: T[]): T[] {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Khmer Alphabet comparator for Dictionary & Explanations
 */
export function khmerAlphabetSort(a: string, b: string): number {
  return a.localeCompare(b, 'km', { sensitivity: 'base' });
}

/**
 * Sound Effects via Web Audio API + iOS HTMLAudio PCM WAV Fallback
 * Ensures reliable audio on iPhone/iPad Safari & Standalone Home Screen PWAs
 */
let audioCtx: AudioContext | null = null;
let audioUnlocked = false;
let isAudioMuted = false;

function isIOSAudioDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent.toLowerCase();
  const isIPadDesktop =
    ua.includes('macintosh') &&
    typeof navigator.maxTouchPoints === 'number' &&
    navigator.maxTouchPoints > 1;
  return /iphone|ipad|ipod/.test(ua) || isIPadDesktop;
}

function enableIOSPlaybackSession() {
  try {
    const nav = navigator as unknown as {
      audioSession?: { type?: string };
    };
    if (nav?.audioSession && nav.audioSession.type !== 'playback') {
      nav.audioSession.type = 'playback';
    }
  } catch {
    // Ignore when audioSession API is unsupported
  }
}

function getOrCreateAudioContext(): AudioContext | null {
  try {
    if (typeof window === 'undefined') return null;
    if (audioCtx && audioCtx.state === 'closed') {
      audioCtx = null;
    }
    if (!audioCtx) {
      const AudioContextClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioContextClass) {
        audioCtx = new AudioContextClass();
      }
    }
    return audioCtx;
  } catch {
    return null;
  }
}

function unlockWebAudioSync() {
  enableIOSPlaybackSession();
  const ctx = getOrCreateAudioContext();
  if (!ctx) return;

  try {
    if (ctx.state !== 'running') {
      void ctx.resume().catch(() => {});
    }
    if (!audioUnlocked) {
      // Play 1-sample silent buffer inside user gesture to unlock WebKit audio hardware
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
      audioUnlocked = true;
    }
  } catch {
    // Ignore gesture unlock edge cases
  }
}

if (typeof window !== 'undefined') {
  const handleFirstGesture = () => {
    unlockWebAudioSync();
  };
  window.addEventListener('touchstart', handleFirstGesture, { capture: true, passive: true });
  window.addEventListener('pointerdown', handleFirstGesture, { capture: true, passive: true });
  window.addEventListener('click', handleFirstGesture, { capture: true, passive: true });
}

// Synthesize compact mono 16-bit PCM WAV data:audio/wav;base64 URIs for iOS media-channel playback
// (data: URIs avoid blob: isolation in iOS Standalone PWAs and play cleanly even if Ring/Silent switch is muted)
function buildPcmWavUrl(durationSec: number, renderSample: (t: number) => number): string | null {
  if (typeof window === 'undefined' || typeof btoa === 'undefined') {
    return null;
  }
  try {
    const sampleRate = 22050;
    const numSamples = Math.max(1, Math.floor(sampleRate * durationSec));
    const byteLength = 44 + numSamples * 2;
    const buffer = new ArrayBuffer(byteLength);
    const view = new DataView(buffer);

    const writeAscii = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeAscii(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true); // PCM chunk size
    view.setUint16(20, 1, true); // PCM format
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(36, 'data');
    view.setUint32(40, numSamples * 2, true);

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const sample = Math.max(-1, Math.min(1, renderSample(t)));
      view.setInt16(44 + i * 2, Math.round(sample * 32767), true);
    }

    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return `data:audio/wav;base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}

const wavUrlCache: Record<'correct' | 'wrong' | 'click', string | null> = {
  correct: null,
  wrong: null,
  click: null,
};
const wavElementPool: Partial<Record<'correct' | 'wrong' | 'click', HTMLAudioElement>> = {};

const triangleWave = (phase: number) => {
  const frac = phase - Math.floor(phase);
  return 4 * Math.abs(frac - 0.5) - 1;
};

const sawtoothWave = (phase: number) => {
  const frac = phase - Math.floor(phase);
  return 2 * frac - 1;
};

function getWavUrl(kind: 'correct' | 'wrong' | 'click'): string | null {
  if (wavUrlCache[kind]) return wavUrlCache[kind];

  if (kind === 'correct') {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    wavUrlCache.correct = buildPcmWavUrl(0.62, (t) => {
      let mix = 0;
      for (let i = 0; i < notes.length; i++) {
        const start = i * 0.06;
        const localT = t - start;
        if (localT >= 0 && localT <= 0.42) {
          const env =
            localT < 0.02
              ? localT / 0.02
              : Math.pow(0.004, (localT - 0.02) / 0.38);
          mix += triangleWave(notes[i] * localT) * env * 0.24;
        }
      }
      return mix;
    });
  } else if (kind === 'wrong') {
    wavUrlCache.wrong = buildPcmWavUrl(0.36, (t) => {
      // Smooth frequency glide from 220Hz down to 140Hz
      const ratio = Math.min(1, t / 0.3);
      const phase = 220 * t - ((220 - 140) * t * ratio) / 2;
      const env = Math.pow(0.005, t / 0.34);
      return sawtoothWave(phase) * env * 0.2;
    });
  } else {
    wavUrlCache.click = buildPcmWavUrl(0.065, (t) => {
      const ratio = Math.min(1, t / 0.05);
      const freq = 800 - 400 * ratio;
      const env = Math.pow(0.01, t / 0.06);
      return Math.sin(2 * Math.PI * freq * t) * env * 0.14;
    });
  }

  return wavUrlCache[kind];
}

function playWavFallback(kind: 'correct' | 'wrong' | 'click'): boolean {
  const url = getWavUrl(kind);
  if (!url || typeof Audio === 'undefined') return false;
  try {
    let audio = wavElementPool[kind];
    if (!audio) {
      audio = new Audio(url);
      audio.preload = 'auto';
      wavElementPool[kind] = audio;
    } else {
      try {
        audio.currentTime = 0;
      } catch {
        audio = new Audio(url);
        wavElementPool[kind] = audio;
      }
    }
    audio.volume = kind === 'click' ? 0.45 : 0.85;
    const playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

export function setMuteState(muted: boolean) {
  isAudioMuted = muted;
  try {
    localStorage.setItem('master_quiz_sound_muted', muted ? 'true' : 'false');
  } catch {
    // Ignore storage errors
  }
}

export function getMuteState(): boolean {
  try {
    const val = localStorage.getItem('master_quiz_sound_muted');
    if (val !== null) {
      isAudioMuted = val === 'true';
    }
  } catch {
    // Ignore
  }
  return isAudioMuted;
}

/**
 * Play a pleasant golden harmonic chime for correct answer
 */
export function playCorrectSound() {
  if (isAudioMuted) return;
  unlockWebAudioSync();

  const ctx = getOrCreateAudioContext();
  if (isIOSAudioDevice() || !ctx || ctx.state !== 'running') {
    if (playWavFallback('correct')) return;
  }
  if (!ctx) return;

  const schedule = () => {
    const now = ctx.currentTime + 0.005;
    const frequencies = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6

    frequencies.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + idx * 0.06);

      gain.gain.setValueAtTime(0, now + idx * 0.06);
      gain.gain.linearRampToValueAtTime(0.22, now + idx * 0.06 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.06 + 0.4);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now + idx * 0.06);
      osc.stop(now + idx * 0.06 + 0.45);
    });
  };

  if (ctx.state !== 'running') {
    void ctx.resume().then(schedule).catch(() => {});
  } else {
    schedule();
  }
}

/**
 * Play a subtle low gentle buzzer for incorrect answer
 */
export function playWrongSound() {
  if (isAudioMuted) return;
  unlockWebAudioSync();

  const ctx = getOrCreateAudioContext();
  if (isIOSAudioDevice() || !ctx || ctx.state !== 'running') {
    if (playWavFallback('wrong')) return;
  }
  if (!ctx) return;

  const schedule = () => {
    const now = ctx.currentTime + 0.005;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(140, now + 0.3);

    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.36);
  };

  if (ctx.state !== 'running') {
    void ctx.resume().then(schedule).catch(() => {});
  } else {
    schedule();
  }
}

/**
 * Play a click/tap SFX
 */
export function playClickSound() {
  if (isAudioMuted) return;
  unlockWebAudioSync();

  const ctx = getOrCreateAudioContext();
  if (isIOSAudioDevice() || !ctx || ctx.state !== 'running') {
    if (playWavFallback('click')) return;
  }
  if (!ctx) return;

  const schedule = () => {
    const now = ctx.currentTime + 0.005;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, now);
    osc.frequency.exponentialRampToValueAtTime(400, now + 0.05);

    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.07);
  };

  if (ctx.state !== 'running') {
    void ctx.resume().then(schedule).catch(() => {});
  } else {
    schedule();
  }
}

/**
 * Sanitize unsupported CSS color functions (like oklab and oklch from Tailwind v4)
 * into standard hex/rgb format for html2canvas and html2pdf compatibility.
 */
export function fixClonedDocColors(clonedDoc: Document) {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    ctx = canvas.getContext('2d');
  } catch {
    // Ignore context failure
  }

  const fixColor = (colorStr: string): string => {
    if (!ctx) return '#0f172a';
    try {
      ctx.fillStyle = '#0f172a';
      ctx.fillStyle = colorStr;
      const res = ctx.fillStyle;
      return res && res !== '#0f172a' ? res : colorStr;
    } catch {
      return colorStr;
    }
  };

  const colorRegex = /(oklch|oklab)\([^)]+\)/gi;

  // 1. Sanitize all <style> blocks in the cloned document
  const styleElements = clonedDoc.querySelectorAll('style');
  styleElements.forEach((styleTag) => {
    if (styleTag.textContent && colorRegex.test(styleTag.textContent)) {
      console.log('Sanitizing oklab in style tag...');
      styleTag.textContent = styleTag.textContent.replace(colorRegex, (match) => fixColor(match));
    }
  });

  // 2. Sanitize element inline styles
  const allElements = clonedDoc.querySelectorAll('*');
  allElements.forEach((el) => {
    const htmlEl = el as HTMLElement;
    if (htmlEl.style && htmlEl.style.cssText && colorRegex.test(htmlEl.style.cssText)) {
      htmlEl.style.cssText = htmlEl.style.cssText.replace(colorRegex, (match) => fixColor(match));
    }
  });
}

