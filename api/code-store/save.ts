import { authorizeAdminRequest } from '../_lib/adminAuth.js';
import {
  getGitHubStoreConfig,
  sanitizeBundledCodePayload,
  saveBundledStoreToGitHub,
} from '../_lib/githubCodeStore.js';
import { ApiRequest, ApiResponse, readJsonBody, sendJson } from '../_lib/http.js';

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  const body = await readJsonBody(req);
  const authResult = await authorizeAdminRequest(req, body);

  if (authResult.rateLimited) {
    return sendJson(res, 429, {
      ok: false,
      error: 'សាកល្បងខុសច្រើនដងពេក! សូមរង់ចាំ ១០ នាទីសិន។',
    });
  }

  if (!authResult.ok) {
    return sendJson(res, 401, {
      ok: false,
      requiresPasscode: true,
      error: 'សូមបញ្ជាក់លេខកូដ Admin ដើម្បីរក្សាទុកសំណួរ Real-Time ទៅ GitHub។',
    });
  }

  const sanitized = sanitizeBundledCodePayload(
    body?.questions,
    body?.subjects,
    body?.allowEmpty === true
  );
  if (sanitized.ok === false) {
    return sendJson(res, sanitized.status, {
      ok: false,
      error: sanitized.error,
    });
  }

  const cfg = getGitHubStoreConfig();
  if (!cfg.configured) {
    return sendJson(res, 200, {
      ok: false,
      readOnly: true,
      githubRequired: true,
      githubRepo: cfg.fullRepo || null,
      githubBranch: cfg.branch || null,
      ...(authResult.adminToken ? { adminToken: authResult.adminToken } : {}),
      error:
        'មិនទាន់បានភ្ជាប់ GITHUB_TOKEN លើ Vercel ទេ! សូមកំណត់ GITHUB_TOKEN និង GITHUB_REPO ក្នុង Vercel Settings → Environment Variables ដើម្បីឱ្យរក្សាទុក និងបញ្ជូន Real-Time ស្វ័យប្រវត្តិ។',
    });
  }

  const saveRes = await saveBundledStoreToGitHub(sanitized.payload);
  if (!saveRes.ok) {
    return sendJson(res, 502, {
      ok: false,
      githubConfigured: true,
      githubRepo: saveRes.githubRepo || null,
      githubBranch: saveRes.githubBranch || null,
      ...(authResult.adminToken ? { adminToken: authResult.adminToken } : {}),
      error: saveRes.error,
    });
  }

  return sendJson(res, 200, {
    ok: true,
    githubSynced: true,
    githubConfigured: true,
    githubRepo: saveRes.githubRepo,
    githubBranch: saveRes.githubBranch,
    commitUrl: saveRes.commitUrl,
    commitSha: saveRes.commitSha,
    version: sanitized.payload.version,
    updatedAt: sanitized.payload.updatedAt,
    subjectsCount: sanitized.payload.subjects.length,
    questionsCount: sanitized.payload.questions.length,
    ...(authResult.adminToken ? { adminToken: authResult.adminToken } : {}),
  });
}
