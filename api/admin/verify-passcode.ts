import {
  clearAdminFailedAttempts,
  getConfiguredAdminCodes,
  isAdminRateLimited,
  recordAdminFailedAttempt,
  signAdminSessionToken,
  timingSafeCompareStrings,
} from '../_lib/adminAuth.js';
import { ApiRequest, ApiResponse, getClientIp, readJsonBody, sendJson } from '../_lib/http.js';

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { success: false, error: 'Method not allowed' });
  }

  const ipKey = getClientIp(req);
  if (isAdminRateLimited(ipKey)) {
    return sendJson(res, 429, {
      success: false,
      error: 'សាកល្បងខុសច្រើនដងពេក! សូមរង់ចាំ ១០ នាទីសិន។',
    });
  }

  const body = await readJsonBody(req);
  const submitted = typeof body?.passcode === 'string' ? body.passcode.trim() : '';
  if (!submitted || submitted.length > 128) {
    return sendJson(res, 400, {
      success: false,
      error: 'សូមបញ្ចូលលេខកូដ Master Code ឱ្យបានត្រឹមត្រូវ!',
    });
  }

  const validCodes = getConfiguredAdminCodes();
  const isValid = validCodes.some((code) => timingSafeCompareStrings(code, submitted));

  if (!isValid) {
    recordAdminFailedAttempt(ipKey);
    return sendJson(res, 401, {
      success: false,
      error: 'លេខកូដ Master Code មិនត្រឹមត្រូវទេ! សូមពិនិត្យលេខកូដម្ដងទៀត។',
    });
  }

  clearAdminFailedAttempts(ipKey);
  const adminToken = signAdminSessionToken();
  return sendJson(res, 200, { success: true, adminToken });
}
