import { ApiRequest, ApiResponse, sendJson } from '../_lib/http.js';

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }
  return sendJson(res, 200, { ok: true, onlineCount: 1 });
}
