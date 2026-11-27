import { getGitHubStoreConfig } from './_lib/githubCodeStore.js';
import { ApiRequest, ApiResponse, sendJson } from './_lib/http.js';

export default async function handler(_req: ApiRequest, res: ApiResponse) {
  const cfg = getGitHubStoreConfig();
  return sendJson(res, 200, {
    status: 'ok',
    app: 'Master Quiz KH',
    realtimeMode: 'poll',
    githubConfigured: cfg.configured,
    githubRepo: cfg.fullRepo || null,
    githubBranch: cfg.branch,
  });
}
