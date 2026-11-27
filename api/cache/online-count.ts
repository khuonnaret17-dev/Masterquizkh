import { ApiRequest, ApiResponse, sendJson } from '../_lib/http.js';

export default async function handler(_req: ApiRequest, res: ApiResponse) {
  return sendJson(res, 200, { count: 1 });
}
