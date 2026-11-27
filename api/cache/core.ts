import { fetchLatestBundledStore } from '../_lib/githubCodeStore.js';
import { ApiRequest, ApiResponse, getQueryParam, sendJson } from '../_lib/http.js';

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { success: false, error: 'Method not allowed' });
  }

  try {
    const force = getQueryParam(req, 'force') === '1';
    const since = Number(getQueryParam(req, 'since') || 0);
    const result = await fetchLatestBundledStore(force);

    if (!result.data) {
      return sendJson(res, 503, {
        success: false,
        githubConfigured: result.githubConfigured,
        error: result.error || 'Core store unavailable',
      });
    }

    const latestVersion = result.data.version;
    if (!force && since > 0 && since === latestVersion) {
      return sendJson(res, 200, {
        unchanged: true,
        version: latestVersion,
        source: result.source,
        githubConfigured: result.githubConfigured,
      });
    }

    return sendJson(res, 200, {
      unchanged: false,
      version: latestVersion,
      updatedAt: result.data.updatedAt,
      source: result.source,
      githubConfigured: result.githubConfigured,
      partial: false,
      questions: result.data.questions,
      subjects: result.data.subjects,
    });
  } catch (err: any) {
    return sendJson(res, 503, {
      success: false,
      error: err?.message || 'Core cache unavailable',
    });
  }
}
