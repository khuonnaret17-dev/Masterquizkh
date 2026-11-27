import type { IncomingMessage, ServerResponse } from 'http';

export interface ApiRequest extends IncomingMessage {
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
  ip?: string;
}

export interface ApiResponse extends ServerResponse {
  status?: (code: number) => ApiResponse;
  json?: (data: unknown) => void;
  send?: (data: unknown) => void;
}

const MAX_JSON_BODY_BYTES = 12 * 1024 * 1024;

export async function readJsonBody<T = Record<string, any>>(req: ApiRequest): Promise<T> {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body as T;
  }
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body) as T;
    } catch {
      return {} as T;
    }
  }
  if (Buffer.isBuffer(req.body)) {
    try {
      return JSON.parse(req.body.toString('utf8')) as T;
    } catch {
      return {} as T;
    }
  }

  return new Promise<T>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (val: T) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    req.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      total += buf.length;
      if (total > MAX_JSON_BODY_BYTES) {
        finish({} as T);
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        finish({} as T);
        return;
      }
      try {
        finish(JSON.parse(raw) as T);
      } catch {
        finish({} as T);
      }
    });
    req.on('error', () => finish({} as T));
  });
}

export function sendJson(res: ApiResponse, statusCode: number, data: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

export function getQueryParam(req: ApiRequest, key: string): string {
  if (req.query && req.query[key] !== undefined) {
    const val = req.query[key];
    return Array.isArray(val) ? String(val[0] ?? '') : String(val ?? '');
  }
  try {
    const parsed = new URL(req.url || '/', 'http://localhost');
    return parsed.searchParams.get(key) || '';
  } catch {
    return '';
  }
}

export function getHeaderValue(req: ApiRequest, name: string): string {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return String(raw[0] ?? '').trim();
  return typeof raw === 'string' ? raw.trim() : '';
}

export function getClientIp(req: ApiRequest): string {
  const xff = getHeaderValue(req, 'x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const realIp = getHeaderValue(req, 'x-real-ip');
  if (realIp) return realIp;
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
