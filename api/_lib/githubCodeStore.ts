import fs from 'fs';
import path from 'path';

export const BUNDLED_JSON_START_MARKER = '// <BUNDLED_JSON_START>';
export const BUNDLED_JSON_END_MARKER = '// <BUNDLED_JSON_END>';
export const BUNDLED_FILE_REPO_PATH = 'src/data/bundledQuestions.ts';

export interface BundledCodeStoreData {
  version: number;
  updatedAt: string;
  subjects: any[];
  questions: any[];
}

export interface GitHubStoreConfig {
  configured: boolean;
  hasToken: boolean;
  hasRepo: boolean;
  missingVars: string[];
  token: string;
  owner: string;
  repo: string;
  fullRepo: string;
  branch: string;
  filePath: string;
}

const REPO_SEGMENT_REGEX = /^[A-Za-z0-9_.-]+$/;
const BRANCH_REGEX = /^[A-Za-z0-9_./-]+$/;

function cleanEnvValue(raw: string | undefined): string {
  return (raw || '').trim().replace(/^["']+|["']+$/g, '').trim();
}

export function getGitHubStoreConfig(): GitHubStoreConfig {
  const token = cleanEnvValue(process.env.GITHUB_TOKEN) || cleanEnvValue(process.env.GH_TOKEN);
  const explicitRepo = (
    cleanEnvValue(process.env.GITHUB_REPO) || cleanEnvValue(process.env.GITHUB_REPOSITORY)
  )
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');

  let owner = '';
  let repo = '';
  if (explicitRepo.includes('/')) {
    const parts = explicitRepo.split('/').filter(Boolean);
    if (parts.length >= 2 && REPO_SEGMENT_REGEX.test(parts[0]) && REPO_SEGMENT_REGEX.test(parts[1])) {
      owner = parts[0];
      repo = parts[1];
    }
  }

  if (!owner || !repo) {
    const vercelOwner = cleanEnvValue(process.env.VERCEL_GIT_REPO_OWNER);
    const vercelSlug = cleanEnvValue(process.env.VERCEL_GIT_REPO_SLUG);
    if (
      vercelOwner &&
      vercelSlug &&
      REPO_SEGMENT_REGEX.test(vercelOwner) &&
      REPO_SEGMENT_REGEX.test(vercelSlug)
    ) {
      owner = vercelOwner;
      repo = vercelSlug;
    }
  }

  const rawBranch =
    cleanEnvValue(process.env.GITHUB_BRANCH) ||
    cleanEnvValue(process.env.VERCEL_GIT_COMMIT_REF) ||
    'main';
  const branch =
    rawBranch && BRANCH_REGEX.test(rawBranch) && !rawBranch.includes('..') ? rawBranch : 'main';

  const hasToken = Boolean(token);
  const hasRepo = Boolean(owner && repo);
  const configured = hasToken && hasRepo;
  const missingVars: string[] = [];
  if (!hasToken) missingVars.push('GITHUB_TOKEN');
  if (!hasRepo) missingVars.push('GITHUB_REPO');

  return {
    configured,
    hasToken,
    hasRepo,
    missingVars,
    token,
    owner,
    repo,
    fullRepo: hasRepo ? `${owner}/${repo}` : '',
    branch,
    filePath: BUNDLED_FILE_REPO_PATH,
  };
}

export function formatGitHubMissingError(cfg: GitHubStoreConfig): string {
  if (!cfg.hasToken && !cfg.hasRepo) {
    return 'Vercel មិនទាន់ទទួលបាន GITHUB_TOKEN និង GITHUB_REPO ទេ! សូមពិនិត្យថាបានបន្ថែមក្នុង Vercel Settings → Environment Variables (ជ្រើស Production & Preview) ហើយចុច Deployments → Redeploy ម្ដងទៀត។';
  }
  if (!cfg.hasToken) {
    return 'ខ្វះ GITHUB_TOKEN ក្នុង Vercel Environment Variables (ឬមិនទាន់ Redeploy ក្រោយពេលបន្ថែម)! សូមពិនិត្យហើយចុច Redeploy លើ Vercel។';
  }
  if (!cfg.hasRepo) {
    return 'បានភ្ជាប់ GITHUB_TOKEN រួចហើយ ប៉ុន្តែខ្វះ GITHUB_REPO! សូមបន្ថែម GITHUB_REPO ជាទម្រង់ username/repo-name ក្នុង Vercel Environment Variables រួចចុច Redeploy។';
  }
  return '';
}

export function parseBundledTsText(raw: string): BundledCodeStoreData | null {
  try {
    const startMarkerIdx = raw.indexOf(BUNDLED_JSON_START_MARKER);
    const endMarkerIdx = raw.indexOf(BUNDLED_JSON_END_MARKER);
    if (startMarkerIdx === -1 || endMarkerIdx === -1 || endMarkerIdx <= startMarkerIdx) {
      return null;
    }
    const section = raw.slice(startMarkerIdx + BUNDLED_JSON_START_MARKER.length, endMarkerIdx);
    const braceStart = section.indexOf('{');
    const braceEnd = section.lastIndexOf('}');
    if (braceStart === -1 || braceEnd === -1 || braceEnd <= braceStart) {
      return null;
    }
    const parsed = JSON.parse(section.slice(braceStart, braceEnd + 1));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      version: typeof parsed.version === 'number' ? parsed.version : Date.now(),
      updatedAt:
        typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      subjects: Array.isArray(parsed.subjects) ? parsed.subjects : [],
      questions: Array.isArray(parsed.questions) ? parsed.questions : [],
    };
  } catch {
    return null;
  }
}

export function readLocalBundledCodeStore(): BundledCodeStoreData | null {
  const candidates = [
    path.resolve(process.cwd(), 'src', 'data', 'bundledQuestions.ts'),
    path.resolve(process.cwd(), '..', 'src', 'data', 'bundledQuestions.ts'),
  ];
  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const parsed = parseBundledTsText(fs.readFileSync(filePath, 'utf8'));
      if (parsed) return parsed;
    } catch {
      // Try next candidate
    }
  }
  return null;
}

export function sanitizeBundledCodePayload(
  rawQuestions: unknown,
  rawSubjects: unknown,
  allowEmpty = false
): { ok: true; payload: BundledCodeStoreData } | { ok: false; status: number; error: string } {
  if (!Array.isArray(rawQuestions) || !Array.isArray(rawSubjects)) {
    return {
      ok: false,
      status: 400,
      error: 'ទម្រង់ទិន្នន័យ questions និង subjects មិនត្រឹមត្រូវទេ!',
    };
  }
  if (rawQuestions.length > 25000 || rawSubjects.length > 1000) {
    return {
      ok: false,
      status: 400,
      error: 'ចំនួនសំណួរ ឬមុខវិជ្ជាលើសកម្រិតកំណត់!',
    };
  }
  if (rawQuestions.length === 0 && !allowEmpty) {
    return {
      ok: false,
      status: 400,
      error: 'មិនមានសំណួរសម្រាប់រក្សាទុកចូលក្នុង Code ទេ!',
    };
  }

  const sanitizedSubjects: any[] = [];
  const seenSubjectNames = new Set<string>();
  const seenSubjectIds = new Set<string>();

  for (let i = 0; i < rawSubjects.length; i++) {
    const s = rawSubjects[i];
    if (!s || typeof s !== 'object') continue;
    const name = typeof s.name === 'string' ? s.name.trim().slice(0, 300) : '';
    if (!name) continue;
    const normName = name.toLowerCase();
    if (seenSubjectNames.has(normName)) continue;
    seenSubjectNames.add(normName);

    let id =
      typeof s.id === 'string' && s.id.trim()
        ? s.id.trim().slice(0, 120)
        : `sub-bundled-${sanitizedSubjects.length + 1}`;
    if (seenSubjectIds.has(id)) {
      id = `sub-bundled-${sanitizedSubjects.length + 1}-${i}`;
    }
    seenSubjectIds.add(id);

    const type = s.type === 'short' || s.type === 'explanation' ? s.type : 'mcq';
    sanitizedSubjects.push({
      id,
      name,
      type,
      isActive: s.isActive !== false,
      order:
        typeof s.order === 'number' && Number.isFinite(s.order)
          ? s.order
          : sanitizedSubjects.length,
      ...(typeof s.icon === 'string' && s.icon.trim() ? { icon: s.icon.trim().slice(0, 40) } : {}),
    });
  }

  const sanitizedQuestions: any[] = [];
  const seenQuestionIds = new Set<string>();

  for (let i = 0; i < rawQuestions.length; i++) {
    const q = rawQuestions[i];
    if (!q || typeof q !== 'object') continue;
    const questionText = typeof q.question === 'string' ? q.question.trim().slice(0, 8000) : '';
    if (!questionText) continue;

    const subjectName =
      typeof q.subject === 'string' && q.subject.trim()
        ? q.subject.trim().slice(0, 300)
        : 'ចំណេះដឹងទូទៅ';
    const normSubject = subjectName.toLowerCase();
    const type = q.type === 'short' || q.type === 'explanation' ? q.type : 'mcq';

    if (!seenSubjectNames.has(normSubject)) {
      seenSubjectNames.add(normSubject);
      const autoId = `sub-bundled-${sanitizedSubjects.length + 1}`;
      seenSubjectIds.add(autoId);
      sanitizedSubjects.push({
        id: autoId,
        name: subjectName,
        type,
        isActive: true,
        order: sanitizedSubjects.length,
      });
    }

    let id =
      typeof q.id === 'string' && q.id.trim()
        ? q.id.trim().slice(0, 120)
        : `q-bundled-${sanitizedQuestions.length + 1}`;
    if (seenQuestionIds.has(id)) {
      id = `q-bundled-${sanitizedQuestions.length + 1}-${i}`;
    }
    seenQuestionIds.add(id);

    const item: Record<string, any> = {
      id,
      subject: subjectName,
      type,
      question: questionText,
      isActive: q.isActive !== false,
      order:
        typeof q.order === 'number' && Number.isFinite(q.order)
          ? q.order
          : sanitizedQuestions.length + 1,
    };

    if (type === 'mcq' && Array.isArray(q.options) && q.options.length > 0) {
      item.options = q.options
        .slice(0, 8)
        .map((opt: unknown) => String(opt ?? '').trim().slice(0, 2000));
      item.correct =
        typeof q.correct === 'number' &&
        Number.isFinite(q.correct) &&
        q.correct >= 0 &&
        q.correct < item.options.length
          ? Math.trunc(q.correct)
          : 0;
    }

    if (typeof q.answer === 'string' && q.answer.trim()) {
      item.answer = q.answer.trim().slice(0, 12000);
    }

    if (typeof q.createdAt === 'string' && q.createdAt.trim()) {
      item.createdAt = q.createdAt.trim().slice(0, 64);
    }

    sanitizedQuestions.push(item);
  }

  sanitizedSubjects.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  sanitizedQuestions.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const version = Date.now();
  const updatedAt = new Date(version).toISOString();

  return {
    ok: true,
    payload: {
      version,
      updatedAt,
      subjects: sanitizedSubjects,
      questions: sanitizedQuestions,
    },
  };
}

export function renderBundledQuestionsTsContent(payload: BundledCodeStoreData, compact = true): string {
  const serialized = compact ? JSON.stringify(payload) : JSON.stringify(payload, null, 2);
  return `import type { Question, Subject } from '../types';

interface BundledStorePayload {
  version: number;
  updatedAt: string;
  subjects: Subject[];
  questions: Question[];
}

${BUNDLED_JSON_START_MARKER}
const BUNDLED_DATA: BundledStorePayload = ${serialized};
${BUNDLED_JSON_END_MARKER}

export const BUNDLED_VERSION: number = BUNDLED_DATA.version;
export const BUNDLED_UPDATED_AT: string = BUNDLED_DATA.updatedAt;
export const BUNDLED_SUBJECTS: Subject[] = BUNDLED_DATA.subjects;
export const BUNDLED_QUESTIONS: Question[] = BUNDLED_DATA.questions;
`;
}

interface CachedGitHubStoreEntry {
  cacheKey: string;
  etag: string | null;
  checkedAt: number;
  data: BundledCodeStoreData;
}

let remoteCache: CachedGitHubStoreEntry | null = null;
let inFlightGitHubFetch: Promise<BundledCodeStoreData | null> | null = null;

const GITHUB_FETCH_COALESCE_MS = 2000;

export async function fetchLatestBundledStore(force = false): Promise<{
  data: BundledCodeStoreData | null;
  source: 'github' | 'local' | 'none';
  githubConfigured: boolean;
  githubRepo: string;
  githubBranch: string;
  error?: string;
}> {
  const cfg = getGitHubStoreConfig();
  const localData = readLocalBundledCodeStore();

  if (!cfg.configured) {
    return {
      data: localData,
      source: localData ? 'local' : 'none',
      githubConfigured: false,
      githubRepo: cfg.fullRepo,
      githubBranch: cfg.branch,
    };
  }

  const cacheKey = `${cfg.fullRepo}@${cfg.branch}`;
  const now = Date.now();
  if (
    !force &&
    remoteCache &&
    remoteCache.cacheKey === cacheKey &&
    now - remoteCache.checkedAt < GITHUB_FETCH_COALESCE_MS
  ) {
    const best =
      localData && localData.version > remoteCache.data.version ? localData : remoteCache.data;
    return {
      data: best,
      source: best === localData ? 'local' : 'github',
      githubConfigured: true,
      githubRepo: cfg.fullRepo,
      githubBranch: cfg.branch,
    };
  }

  if (!inFlightGitHubFetch) {
    inFlightGitHubFetch = (async () => {
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github.raw+json',
        Authorization: `Bearer ${cfg.token}`,
        'User-Agent': 'Master-Quiz-KH-Vercel-Sync',
        'X-GitHub-Api-Version': '2022-11-28',
      };
      if (remoteCache && remoteCache.cacheKey === cacheKey && remoteCache.etag && !force) {
        headers['If-None-Match'] = remoteCache.etag;
      }

      const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.filePath}?ref=${encodeURIComponent(cfg.branch)}`;
      const res = await fetch(url, { headers });

      if (res.status === 304 && remoteCache && remoteCache.cacheKey === cacheKey) {
        remoteCache.checkedAt = Date.now();
        return remoteCache.data;
      }

      if (!res.ok) {
        const msg = await res.text().catch(() => '');
        throw new Error(`GitHub GET HTTP ${res.status}: ${msg.slice(0, 160)}`);
      }

      const rawText = await res.text();
      const parsed = parseBundledTsText(rawText);
      if (!parsed) {
        throw new Error('Could not parse bundledQuestions.ts from GitHub');
      }

      const etag = res.headers.get('etag');
      remoteCache = {
        cacheKey,
        etag,
        checkedAt: Date.now(),
        data: parsed,
      };
      return parsed;
    })().finally(() => {
      inFlightGitHubFetch = null;
    });
  }

  try {
    const ghData = await inFlightGitHubFetch;
    if (ghData && (!localData || ghData.version >= localData.version)) {
      return {
        data: ghData,
        source: 'github',
        githubConfigured: true,
        githubRepo: cfg.fullRepo,
        githubBranch: cfg.branch,
      };
    }
    if (localData) {
      return {
        data: localData,
        source: 'local',
        githubConfigured: true,
        githubRepo: cfg.fullRepo,
        githubBranch: cfg.branch,
      };
    }
    return {
      data: ghData,
      source: ghData ? 'github' : 'none',
      githubConfigured: true,
      githubRepo: cfg.fullRepo,
      githubBranch: cfg.branch,
    };
  } catch (err: any) {
    const cachedFallback =
      remoteCache && remoteCache.cacheKey === cacheKey ? remoteCache.data : null;
    const best =
      cachedFallback && (!localData || cachedFallback.version >= localData.version)
        ? cachedFallback
        : localData;
    return {
      data: best,
      source: best ? (best === cachedFallback ? 'github' : 'local') : 'none',
      githubConfigured: true,
      githubRepo: cfg.fullRepo,
      githubBranch: cfg.branch,
      error: err?.message || 'GitHub fetch failed',
    };
  }
}

async function resolveDefaultBranchIfMissing(cfg: GitHubStoreConfig): Promise<string | null> {
  try {
    const repoUrl = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}`;
    const res = await fetch(repoUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${cfg.token}`,
        'User-Agent': 'Master-Quiz-KH-Vercel-Sync',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) return null;
    const data: any = await res.json().catch(() => null);
    return typeof data?.default_branch === 'string' && data.default_branch.trim()
      ? data.default_branch.trim()
      : null;
  } catch {
    return null;
  }
}

export async function testGitHubConnection(): Promise<{
  ok: boolean;
  configured: boolean;
  hasToken: boolean;
  hasRepo: boolean;
  missingVars: string[];
  githubRepo: string | null;
  githubBranch: string;
  defaultBranch?: string | null;
  canPush?: boolean;
  statusCode?: number;
  error?: string;
}> {
  const cfg = getGitHubStoreConfig();
  if (!cfg.configured) {
    return {
      ok: false,
      configured: false,
      hasToken: cfg.hasToken,
      hasRepo: cfg.hasRepo,
      missingVars: cfg.missingVars,
      githubRepo: cfg.fullRepo || null,
      githubBranch: cfg.branch,
      error: formatGitHubMissingError(cfg),
    };
  }

  try {
    const repoUrl = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}`;
    const res = await fetch(repoUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${cfg.token}`,
        'User-Agent': 'Master-Quiz-KH-Vercel-Sync',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    const data: any = await res.json().catch(() => null);
    if (!res.ok) {
      const ghMsg = typeof data?.message === 'string' ? data.message : `HTTP ${res.status}`;
      let khError = `តភ្ជាប់ GitHub មិនជោគជ័យ (${ghMsg})`;
      if (res.status === 401) {
        khError = 'GITHUB_TOKEN មិនត្រឹមត្រូវ ឬផុតកំណត់ (401 Bad credentials) — សូមបង្កើត Token ថ្មី!';
      } else if (res.status === 404) {
        khError = `រកមិនឃើញ Repository «${cfg.fullRepo}» ទេ (404) ឬ Token គ្មានសិទ្ធិចូល Repo នេះ!`;
      } else if (res.status === 403) {
        khError = `GITHUB_TOKEN គ្មានសិទ្ធិចូល Repository «${cfg.fullRepo}» ទេ (403 Forbidden)!`;
      }
      return {
        ok: false,
        configured: true,
        hasToken: true,
        hasRepo: true,
        missingVars: [],
        githubRepo: cfg.fullRepo,
        githubBranch: cfg.branch,
        statusCode: res.status,
        error: khError,
      };
    }

    const canPush = data?.permissions?.push === true || data?.permissions?.admin === true || data?.permissions?.maintain === true;
    const defaultBranch = typeof data?.default_branch === 'string' ? data.default_branch : cfg.branch;

    // Fine-grained tokens don't always populate data.permissions.push on GET /repos; verify contents read as well
    const dirRes = await fetch(
      `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/src/data?ref=${encodeURIComponent(cfg.branch)}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${cfg.token}`,
          'User-Agent': 'Master-Quiz-KH-Vercel-Sync',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    );

    if (!dirRes.ok && defaultBranch !== cfg.branch && !cleanEnvValue(process.env.GITHUB_BRANCH)) {
      return {
        ok: false,
        configured: true,
        hasToken: true,
        hasRepo: true,
        missingVars: [],
        githubRepo: cfg.fullRepo,
        githubBranch: cfg.branch,
        defaultBranch,
        canPush,
        statusCode: dirRes.status,
        error: `Branch «${cfg.branch}» មិនមានក្នុង Repo ទេ (Default branch គឺ «${defaultBranch}») — សូមកំណត់ GITHUB_BRANCH=${defaultBranch} លើ Vercel!`,
      };
    }

    return {
      ok: true,
      configured: true,
      hasToken: true,
      hasRepo: true,
      missingVars: [],
      githubRepo: cfg.fullRepo,
      githubBranch: cfg.branch,
      defaultBranch,
      canPush,
    };
  } catch (err: any) {
    return {
      ok: false,
      configured: true,
      hasToken: true,
      hasRepo: true,
      missingVars: [],
      githubRepo: cfg.fullRepo,
      githubBranch: cfg.branch,
      error: `មិនអាចតភ្ជាប់ទៅ GitHub API បានទេ៖ ${err?.message || 'Network error'}`,
    };
  }
}

async function fetchGitHubFileSha(cfg: GitHubStoreConfig, branchOverride?: string): Promise<string | undefined> {
  const targetBranch = branchOverride || cfg.branch;
  // List parent directory (src/data) to obtain exact blob SHA reliably even when file > 1MB
  const dirUrl = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/src/data?ref=${encodeURIComponent(targetBranch)}`;
  const res = await fetch(dirUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${cfg.token}`,
      'User-Agent': 'Master-Quiz-KH-Vercel-Sync',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (res.status === 404) return undefined;
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const err: any = new Error(`GitHub metadata HTTP ${res.status}: ${txt.slice(0, 160)}`);
    err.status = res.status;
    throw err;
  }

  const list = await res.json().catch(() => null);
  if (!Array.isArray(list)) return undefined;
  const target = list.find(
    (entry: any) => entry?.name === 'bundledQuestions.ts' && typeof entry?.sha === 'string'
  );
  return target?.sha;
}

export async function saveBundledStoreToGitHub(payload: BundledCodeStoreData): Promise<{
  ok: boolean;
  commitUrl?: string;
  commitSha?: string;
  githubRepo: string;
  githubBranch: string;
  error?: string;
}> {
  const cfg = getGitHubStoreConfig();
  if (!cfg.configured) {
    return {
      ok: false,
      githubRepo: cfg.fullRepo,
      githubBranch: cfg.branch,
      error: formatGitHubMissingError(cfg),
    };
  }

  const fileContent = renderBundledQuestionsTsContent(payload, true);
  const contentBase64 = Buffer.from(fileContent, 'utf8').toString('base64');
  const putUrl = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.filePath}`;
  const commitMessage = `chore(quiz): sync ${payload.questions.length} questions, ${payload.subjects.length} subjects [v${payload.version}]`;

  let activeBranch = cfg.branch;

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      let sha = await fetchGitHubFileSha(cfg, activeBranch);
      if (!sha && attempt === 0 && !cleanEnvValue(process.env.GITHUB_BRANCH)) {
        const detectedDefault = await resolveDefaultBranchIfMissing(cfg);
        if (detectedDefault && detectedDefault !== activeBranch) {
          activeBranch = detectedDefault;
          sha = await fetchGitHubFileSha(cfg, activeBranch);
        }
      }

      const bodyPayload: Record<string, any> = {
        message: commitMessage,
        content: contentBase64,
        branch: activeBranch,
      };
      if (sha) {
        bodyPayload.sha = sha;
      }

      const res = await fetch(putUrl, {
        method: 'PUT',
        headers: {
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.token}`,
          'User-Agent': 'Master-Quiz-KH-Vercel-Sync',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify(bodyPayload),
      });

      if (res.status === 409 && attempt < 2) {
        // Concurrent write conflict — retry with fresh SHA
        continue;
      }

      const data: any = await res.json().catch(() => null);
      if (!res.ok) {
        const ghMsg =
          typeof data?.message === 'string' ? data.message : `GitHub HTTP ${res.status}`;
        let hint = 'សូមពិនិត្យសិទ្ធិ Contents: Read & Write របស់ GITHUB_TOKEN។';
        if (res.status === 401) {
          hint = 'GITHUB_TOKEN មិនត្រឹមត្រូវ ឬផុតកំណត់។';
        } else if (res.status === 404) {
          hint = `រកមិនឃើញ Repo «${cfg.fullRepo}» ឬ Branch «${activeBranch}» ទេ — សូមពិនិត្យ GITHUB_REPO និង GITHUB_BRANCH!`;
        } else if (res.status === 403) {
          hint = 'Token គ្មានសិទ្ធិ Write ទៅ Repo នេះទេ (ត្រូវបើក Contents: Read and write)។';
        }
        return {
          ok: false,
          githubRepo: cfg.fullRepo,
          githubBranch: activeBranch,
          error: `បរាជ័យក្នុងការរក្សាទុកទៅ GitHub (${ghMsg}) — ${hint}`,
        };
      }

      const cacheKey = `${cfg.fullRepo}@${activeBranch}`;
      remoteCache = {
        cacheKey,
        etag: null,
        checkedAt: Date.now(),
        data: payload,
      };

      return {
        ok: true,
        commitUrl: data?.commit?.html_url || undefined,
        commitSha: data?.commit?.sha || undefined,
        githubRepo: cfg.fullRepo,
        githubBranch: activeBranch,
      };
    }

    return {
      ok: false,
      githubRepo: cfg.fullRepo,
      githubBranch: activeBranch,
      error: 'មានការប៉ះទង្គិចទិន្នន័យលើ GitHub (409 Conflict) — សូមព្យាយាមម្ដងទៀត!',
    };
  } catch (err: any) {
    return {
      ok: false,
      githubRepo: cfg.fullRepo,
      githubBranch: activeBranch,
      error: `បរាជ័យក្នុងការតភ្ជាប់ទៅ GitHub (${err?.message || 'Network error'}) — សូមពិនិត្យ GITHUB_TOKEN និង GITHUB_REPO ម្ដងទៀត!`,
    };
  }
}
