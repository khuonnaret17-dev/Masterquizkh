import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ApiRequest, getClientIp, getHeaderValue } from './http.js';

const DEFAULT_ADMIN_CODE = '168';
const ADMIN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const adminVerifyAttempts = new Map<string, number[]>();

let fallbackRandomSecret: string | null = null;

function getAdminSessionSecret(): string {
  const explicit = (process.env.ADMIN_SESSION_SECRET || '').trim();
  if (explicit) return explicit;

  // Deterministic across stateless Vercel serverless containers when GitHub sync secret is set
  const ghToken = (process.env.GITHUB_TOKEN || '').trim();
  if (ghToken) {
    return crypto
      .createHmac('sha256', 'mpq-vercel-admin-session-v1')
      .update(ghToken)
      .digest('hex');
  }

  if (!fallbackRandomSecret) {
    fallbackRandomSecret = crypto.randomBytes(32).toString('hex');
  }
  return fallbackRandomSecret;
}

export function timingSafeCompareStrings(aStr: string, bStr: string): boolean {
  const aHash = crypto.createHash('sha256').update(aStr).digest();
  const bHash = crypto.createHash('sha256').update(bStr).digest();
  return crypto.timingSafeEqual(aHash, bHash);
}

export function getConfiguredAdminCodes(): string[] {
  const envCode = (process.env.ADMIN_MASTER_CODE || process.env.ADMIN_PASSCODE || '').trim();
  return envCode && envCode !== DEFAULT_ADMIN_CODE
    ? [envCode, DEFAULT_ADMIN_CODE]
    : [DEFAULT_ADMIN_CODE];
}

export function isAdminRateLimited(ipKey: string): boolean {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const recent = (adminVerifyAttempts.get(ipKey) || []).filter((ts) => now - ts < windowMs);
  adminVerifyAttempts.set(ipKey, recent);
  return recent.length >= 15;
}

export function recordAdminFailedAttempt(ipKey: string): void {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const recent = (adminVerifyAttempts.get(ipKey) || []).filter((ts) => now - ts < windowMs);
  recent.push(now);
  adminVerifyAttempts.set(ipKey, recent);
}

export function clearAdminFailedAttempts(ipKey: string): void {
  adminVerifyAttempts.delete(ipKey);
}

export function signAdminSessionToken(): string {
  const secret = getAdminSessionSecret();
  const payload = Buffer.from(
    JSON.stringify({ role: 'admin', exp: Date.now() + ADMIN_TOKEN_TTL_MS }),
    'utf8'
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyAdminSessionToken(token: string): boolean {
  try {
    const secret = getAdminSessionSecret();
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [payloadB64, sigB64] = parts;
    if (!payloadB64 || !sigB64) return false;
    const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
    if (!timingSafeCompareStrings(expectedSig, sigB64)) return false;
    const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    return parsed?.role === 'admin' && typeof parsed?.exp === 'number' && parsed.exp > Date.now();
  } catch {
    return false;
  }
}

let cachedFirebaseApiKey: string | null | undefined;

function getFirebaseApiKey(): string | null {
  if (cachedFirebaseApiKey !== undefined) return cachedFirebaseApiKey;
  try {
    const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const resolvedKey = typeof parsed?.apiKey === 'string' ? parsed.apiKey : null;
      cachedFirebaseApiKey = resolvedKey;
      return resolvedKey;
    }
  } catch {
    // Ignore missing config
  }
  cachedFirebaseApiKey = null;
  return null;
}

export async function verifyFirebaseAdminBearerToken(idToken: string): Promise<boolean> {
  const apiKey = getFirebaseApiKey();
  if (!apiKey || !idToken || idToken.length > 8192) return false;
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    const user = Array.isArray(data?.users) ? data.users[0] : null;
    return (
      typeof user?.email === 'string' &&
      user.email.toLowerCase() === 'reaksmey8114@gmail.com' &&
      user.emailVerified === true
    );
  } catch {
    return false;
  }
}

export async function authorizeAdminRequest(
  req: ApiRequest,
  body?: Record<string, any> | null
): Promise<{
  ok: boolean;
  rateLimited?: boolean;
  adminToken?: string;
}> {
  const headerToken = getHeaderValue(req, 'x-admin-token');
  if (headerToken && verifyAdminSessionToken(headerToken)) {
    return { ok: true };
  }

  const authHeader = getHeaderValue(req, 'authorization');
  if (authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice(7).trim();
    if (bearer && verifyAdminSessionToken(bearer)) {
      return { ok: true };
    }
    if (bearer && (await verifyFirebaseAdminBearerToken(bearer))) {
      return { ok: true, adminToken: signAdminSessionToken() };
    }
  }

  const headerPasscode =
    getHeaderValue(req, 'x-admin-passcode') ||
    (typeof body?.passcode === 'string' ? body.passcode.trim() : '');

  if (headerPasscode) {
    const ipKey = getClientIp(req);
    if (isAdminRateLimited(ipKey)) {
      return { ok: false, rateLimited: true };
    }
    const isValid = getConfiguredAdminCodes().some((code) =>
      timingSafeCompareStrings(code, headerPasscode)
    );
    if (isValid) {
      clearAdminFailedAttempts(ipKey);
      return { ok: true, adminToken: signAdminSessionToken() };
    }
    recordAdminFailedAttempt(ipKey);
  }

  return { ok: false };
}
