import { fetchLatestBundledStore, getGitHubStoreConfig } from '../_lib/githubCodeStore.js';
import { ApiRequest, ApiResponse, sendJson } from '../_lib/http.js';

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  const cfg = getGitHubStoreConfig();
  const result = await fetchLatestBundledStore(false);

  return sendJson(res, 200, {
    ok: true,
    version: result.data?.version || 0,
    updatedAt: result.data?.updatedAt || null,
    subjectsCount: result.data?.subjects.length || 0,
    questionsCount: result.data?.questions.length || 0,
    writable: cfg.configured,
    githubConfigured: cfg.configured,
    hasToken: cfg.hasToken,
    hasRepo: cfg.hasRepo,
    missingVars: cfg.missingVars,
    githubRepo: cfg.fullRepo || null,
    githubBranch: cfg.branch || null,
    storageMode: cfg.configured ? 'github' : 'readonly',
    source: result.source,
    ...(result.error ? { warning: result.error } : {}),
  });
}
