import { Question, QuestionType, Subject } from '../types';

export interface ExportedSubjectMeta {
  name: string;
  type: QuestionType;
  isActive: boolean;
  order: number;
}

export interface ExportedQuestionItem {
  subject: string;
  type: QuestionType;
  question: string;
  options?: string[];
  correct?: number;
  answer?: string;
  isActive: boolean;
  order?: number;
}

export interface ExportedQuestionsPayload {
  app: 'Master Quiz KH';
  version: 1;
  exportedAt: string;
  subject?: string;
  totalQuestions: number;
  subjects: ExportedSubjectMeta[];
  questions: ExportedQuestionItem[];
}

export interface ParsedQuestionsJsonResult {
  questions: Question[];
  subjectMetaMap: Record<string, Partial<Subject>>;
  skippedCount: number;
}

export const SAMPLE_EXPORT_JSON_STRING = JSON.stringify(
  {
    app: 'Master Quiz KH',
    version: 1,
    exportedAt: '2026-11-25T00:00:00.000Z',
    totalQuestions: 3,
    subjects: [
      {
        name: 'ចំណេះដឹងទូទៅ និងច្បាប់រដ្ឋប្បវេណី',
        type: 'mcq',
        isActive: true,
        order: 0,
      },
    ],
    questions: [
      {
        subject: 'ចំណេះដឹងទូទៅ និងច្បាប់រដ្ឋប្បវេណី',
        type: 'mcq',
        question: 'តើមន្ត្រីរាជការស៊ីវិលអាចទទួលបានច្បាប់ឈប់ប្រចាំឆ្នាំចំនួនប៉ុន្មានថ្ងៃនៃថ្ងៃធ្វើការ ប្រសិនបើមន្ត្រីរាជការនោះបានបម្រើការងារចំនួន ២ ឆ្នាំជាប់គ្នា?',
        options: [
          'ក. ២០ (ម្ភៃ) ថ្ងៃនៃថ្ងៃធ្វើការ',
          'ខ. ២៥ (ម្ភៃប្រាំ) ថ្ងៃនៃថ្ងៃធ្វើការ',
          'គ. ៣០ (សាមសិប) ថ្ងៃនៃថ្ងៃធ្វើការ',
          'ឃ. ៣៥ (សាមសិបប្រាំ) ថ្ងៃនៃថ្ងៃធ្វើការ',
        ],
        correct: 2,
        answer: 'យោង ៖ អនុក្រឹត្យស្ដីពីការគ្រប់គ្រងការឈប់របស់មន្ត្រីរាជការស៊ីវិល។',
        isActive: true,
        order: 1,
      },
      {
        subject: 'ចំណេះដឹងទូទៅ និងច្បាប់រដ្ឋប្បវេណី',
        type: 'short',
        question: 'តើរដ្ឋធម្មនុញ្ញជាអ្វី?',
        answer: 'រដ្ឋធម្មនុញ្ញគឺជាច្បាប់កំពូលនៃព្រះរាជាណាចក្រកម្ពុជា។ ច្បាប់ និងសេចក្តីសម្រេចទាំងឡាយនៃស្ថាប័ននានារបស់រដ្ឋ ត្រូវតែស្របទៅនឹងរដ្ឋធម្មនុញ្ញជាដាច់ខាត។',
        isActive: true,
        order: 2,
      },
      {
        subject: 'ចំណេះដឹងទូទៅ និងច្បាប់រដ្ឋប្បវេណី',
        type: 'explanation',
        question: 'នីតិរដ្ឋ',
        answer: 'រដ្ឋដែលគ្រប់គ្រងដោយគោរពតាមគោលការណ៍ច្បាប់ ដោយគ្មានបុគ្គលណាម្នាក់នៅពីលើច្បាប់ឡើយ។',
        isActive: true,
        order: 3,
      },
    ],
  } satisfies ExportedQuestionsPayload,
  null,
  2
);

export function buildExportJsonPayload(
  targetQuestions: Question[],
  allSubjects: Subject[],
  options?: { subjectLabel?: string }
): ExportedQuestionsPayload {
  const subjectNamesInQuestions = new Set(
    targetQuestions.map((q) => (q.subject || '').trim()).filter(Boolean)
  );

  const exportedSubjects: ExportedSubjectMeta[] = [];
  const includedSubjectNames = new Set<string>();

  for (const sub of allSubjects) {
    if (
      !options?.subjectLabel ||
      options.subjectLabel === '__ALL__' ||
      subjectNamesInQuestions.has(sub.name) ||
      sub.name === options.subjectLabel
    ) {
      includedSubjectNames.add(sub.name);
      exportedSubjects.push({
        name: sub.name,
        type: sub.type || 'mcq',
        isActive: sub.isActive !== false,
        order: typeof sub.order === 'number' ? sub.order : exportedSubjects.length,
      });
    }
  }

  for (const name of subjectNamesInQuestions) {
    if (!includedSubjectNames.has(name)) {
      const sampleQ = targetQuestions.find((q) => q.subject === name);
      exportedSubjects.push({
        name,
        type: sampleQ?.type || 'mcq',
        isActive: true,
        order: exportedSubjects.length,
      });
    }
  }

  const exportedQuestions: ExportedQuestionItem[] = targetQuestions.map((q, idx) => {
    const base: ExportedQuestionItem = {
      subject: (q.subject || '').trim() || 'ចំណេះដឹងទូទៅ',
      type: q.type || 'mcq',
      question: (q.question || '').trim(),
      isActive: q.isActive !== false,
      order: typeof q.order === 'number' ? q.order : idx + 1,
    };

    if (base.type === 'mcq' && Array.isArray(q.options) && q.options.length > 0) {
      base.options = q.options.map((opt) => String(opt).trim());
      base.correct =
        typeof q.correct === 'number' && q.correct >= 0 && q.correct < base.options.length
          ? q.correct
          : 0;
    }

    if (q.answer && String(q.answer).trim()) {
      base.answer = String(q.answer).trim();
    }

    return base;
  });

  const payload: ExportedQuestionsPayload = {
    app: 'Master Quiz KH',
    version: 1,
    exportedAt: new Date().toISOString(),
    totalQuestions: exportedQuestions.length,
    subjects: exportedSubjects,
    questions: exportedQuestions,
  };

  if (options?.subjectLabel && options.subjectLabel !== '__ALL__') {
    payload.subject = options.subjectLabel;
  }

  return payload;
}

export function downloadJsonFile(data: unknown, filename: string) {
  const jsonText = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const blob = new Blob([jsonText], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.json') ? filename : `${filename}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface BundledStoreDataPayload {
  version: number;
  updatedAt: string;
  subjects: Subject[];
  questions: Question[];
}

export function normalizeBundledStorePayload(
  rawQuestions: Question[],
  rawSubjects: Subject[],
  version = Date.now()
): BundledStoreDataPayload {
  const normalizedSubjects: Subject[] = [];
  const seenSubjectNames = new Set<string>();
  const seenSubjectIds = new Set<string>();

  for (let i = 0; i < rawSubjects.length; i++) {
    const sub = rawSubjects[i];
    const name = String(sub?.name || '').trim();
    if (!name) continue;
    const normName = name.toLowerCase();
    if (seenSubjectNames.has(normName)) continue;
    seenSubjectNames.add(normName);

    let id = String(sub?.id || '').trim() || `sub-bundled-${normalizedSubjects.length + 1}`;
    if (seenSubjectIds.has(id)) {
      id = `sub-bundled-${normalizedSubjects.length + 1}-${i}`;
    }
    seenSubjectIds.add(id);

    const type: QuestionType =
      sub?.type === 'short' || sub?.type === 'explanation' ? sub.type : 'mcq';

    normalizedSubjects.push({
      id,
      name,
      type,
      isActive: sub?.isActive !== false,
      order: typeof sub?.order === 'number' && Number.isFinite(sub.order) ? sub.order : normalizedSubjects.length,
      ...(typeof sub?.icon === 'string' && sub.icon.trim() ? { icon: sub.icon.trim() } : {}),
    });
  }

  const normalizedQuestions: Question[] = [];
  const seenQuestionIds = new Set<string>();

  for (let i = 0; i < rawQuestions.length; i++) {
    const q = rawQuestions[i];
    const questionText = String(q?.question || '').trim();
    if (!questionText) continue;

    const subjectName = String(q?.subject || '').trim() || 'ចំណេះដឹងទូទៅ';
    const normSubject = subjectName.toLowerCase();
    const type: QuestionType =
      q?.type === 'short' || q?.type === 'explanation' ? q.type : 'mcq';

    if (!seenSubjectNames.has(normSubject)) {
      seenSubjectNames.add(normSubject);
      const autoId = `sub-bundled-${normalizedSubjects.length + 1}`;
      seenSubjectIds.add(autoId);
      normalizedSubjects.push({
        id: autoId,
        name: subjectName,
        type,
        isActive: true,
        order: normalizedSubjects.length,
      });
    }

    let id = String(q?.id || '').trim() || `q-bundled-${normalizedQuestions.length + 1}`;
    if (seenQuestionIds.has(id)) {
      id = `q-bundled-${normalizedQuestions.length + 1}-${i}`;
    }
    seenQuestionIds.add(id);

    const item: Question = {
      id,
      subject: subjectName,
      type,
      question: questionText,
      isActive: q?.isActive !== false,
      order:
        typeof q?.order === 'number' && Number.isFinite(q.order)
          ? q.order
          : normalizedQuestions.length + 1,
    };

    if (type === 'mcq' && Array.isArray(q?.options) && q.options.length > 0) {
      item.options = q.options.map((opt) => String(opt ?? '').trim());
      item.correct =
        typeof q.correct === 'number' &&
        Number.isFinite(q.correct) &&
        q.correct >= 0 &&
        q.correct < item.options.length
          ? Math.trunc(q.correct)
          : 0;
    }

    if (typeof q?.answer === 'string' && q.answer.trim()) {
      item.answer = q.answer.trim();
    }

    if (typeof q?.createdAt === 'string' && q.createdAt.trim()) {
      item.createdAt = q.createdAt.trim();
    }

    normalizedQuestions.push(item);
  }

  normalizedSubjects.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  normalizedQuestions.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  return {
    version,
    updatedAt: new Date().toISOString(),
    subjects: normalizedSubjects,
    questions: normalizedQuestions,
  };
}

export function generateBundledQuestionsTsContent(
  rawQuestions: Question[],
  rawSubjects: Subject[],
  version = Date.now()
): string {
  const payload = normalizeBundledStorePayload(rawQuestions, rawSubjects, version);
  const serialized = JSON.stringify(payload, null, 2);

  return `import type { Question, Subject } from '../types';

interface BundledStorePayload {
  version: number;
  updatedAt: string;
  subjects: Subject[];
  questions: Question[];
}

// <BUNDLED_JSON_START>
const BUNDLED_DATA: BundledStorePayload = ${serialized};
// <BUNDLED_JSON_END>

export const BUNDLED_VERSION: number = BUNDLED_DATA.version;
export const BUNDLED_UPDATED_AT: string = BUNDLED_DATA.updatedAt;
export const BUNDLED_SUBJECTS: Subject[] = BUNDLED_DATA.subjects;
export const BUNDLED_QUESTIONS: Question[] = BUNDLED_DATA.questions;
`;
}

export function downloadTypeScriptFile(content: string, filename = 'bundledQuestions.ts') {
  const blob = new Blob([content], { type: 'text/typescript;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.ts') ? filename : `${filename}.ts`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function normalizeQuestionType(rawType: unknown, optionsCount: number, forcedType?: 'auto' | QuestionType): QuestionType {
  if (forcedType && forcedType !== 'auto') {
    return forcedType;
  }
  if (typeof rawType === 'string') {
    const t = rawType.trim().toLowerCase();
    if (t === 'mcq' || t === 'qcm' || t === 'multiple_choice' || t === 'multiple-choice') return 'mcq';
    if (t === 'explanation' || t === 'dictionary' || t === 'word' || t === 'explain') return 'explanation';
    if (t === 'short' || t === 'qa' || t === 'q&a' || t === 'short_answer' || t === 'text') return 'short';
  }
  return optionsCount >= 2 ? 'mcq' : 'short';
}

function extractOptionsArray(rawOptions: unknown): string[] {
  if (Array.isArray(rawOptions)) {
    return rawOptions
      .map((item) => (typeof item === 'string' ? item.trim() : String(item ?? '').trim()))
      .filter(Boolean);
  }

  if (rawOptions && typeof rawOptions === 'object') {
    const obj = rawOptions as Record<string, unknown>;
    const khKeys = ['ក', 'ខ', 'គ', 'ឃ'];
    const enKeys = ['A', 'B', 'C', 'D', 'a', 'b', 'c', 'd'];

    const matchedKh = khKeys
      .filter((k) => k in obj && String(obj[k] ?? '').trim())
      .map((k) => `${k}. ${String(obj[k]).trim().replace(/^[ក-ឃA-Da-d]\.\s*/, '')}`);
    if (matchedKh.length >= 2) return matchedKh;

    const matchedEn = enKeys
      .filter((k) => k in obj && String(obj[k] ?? '').trim())
      .map((k, idx) => {
        const prefix = khKeys[idx] || k.toUpperCase();
        return `${prefix}. ${String(obj[k]).trim().replace(/^[ក-ឃA-Da-d]\.\s*/, '')}`;
      });
    if (matchedEn.length >= 2) return matchedEn;

    return Object.values(obj)
      .map((v) => String(v ?? '').trim())
      .filter(Boolean);
  }

  return [];
}

function resolveCorrectIndex(rawCorrect: unknown, options: string[]): number {
  if (options.length === 0) return 0;

  if (typeof rawCorrect === 'number' && Number.isFinite(rawCorrect)) {
    const idx = Math.trunc(rawCorrect);
    if (idx >= 0 && idx < options.length) return idx;
    if (idx === options.length) return options.length - 1;
    return 0;
  }

  if (typeof rawCorrect === 'string') {
    const trimmed = rawCorrect.trim();
    if (!trimmed) return 0;

    if (/^[0-9]+$/.test(trimmed)) {
      const idx = Number(trimmed);
      if (idx >= 0 && idx < options.length) return idx;
      if (idx === options.length) return options.length - 1;
    }

    const firstChar = trimmed.charAt(0).toUpperCase();
    if (firstChar === 'ក' || firstChar === 'A') return 0;
    if ((firstChar === 'ខ' || firstChar === 'B') && options.length > 1) return 1;
    if ((firstChar === 'គ' || firstChar === 'C') && options.length > 2) return 2;
    if ((firstChar === 'ឃ' || firstChar === 'D') && options.length > 3) return 3;

    const stripPrefix = (s: string) => s.replace(/^[ក-ឃA-Da-d][\.\)]\s*/, '').trim().toLowerCase();
    const targetClean = stripPrefix(trimmed);
    const matchedIdx = options.findIndex((opt) => stripPrefix(opt) === targetClean || opt.toLowerCase() === trimmed.toLowerCase());
    if (matchedIdx >= 0) return matchedIdx;
  }

  return 0;
}

export function parseQuestionsJsonInput(
  rawJson: string,
  options: {
    fallbackSubject: string;
    overrideSubject?: string;
    forcedType?: 'auto' | QuestionType;
  }
): ParsedQuestionsJsonResult {
  const trimmed = rawJson.trim();
  if (!trimmed) {
    throw new Error('សូមបញ្ចូល ឬផ្ទុកទិន្នន័យ JSON ជាមុនសិន!');
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(trimmed);
  } catch (err: any) {
    throw new Error(`ទម្រង់ JSON មិនត្រឹមត្រូវ (${err?.message || 'Syntax Error'})`);
  }

  let rawQuestions: unknown[] = [];
  let topLevelSubject = '';
  const subjectMetaMap: Record<string, Partial<Subject>> = {};

  if (Array.isArray(parsedRaw)) {
    rawQuestions = parsedRaw;
  } else if (parsedRaw && typeof parsedRaw === 'object') {
    const obj = parsedRaw as Record<string, unknown>;
    if (typeof obj.subject === 'string') {
      topLevelSubject = obj.subject.trim();
    }

    if (Array.isArray(obj.subjects)) {
      for (const s of obj.subjects) {
        if (s && typeof s === 'object') {
          const sObj = s as Record<string, unknown>;
          const sName = typeof sObj.name === 'string' ? sObj.name.trim() : '';
          if (sName) {
            subjectMetaMap[sName] = {
              name: sName,
              type: normalizeQuestionType(sObj.type, 4),
              isActive: sObj.isActive !== false,
              order: typeof sObj.order === 'number' ? sObj.order : undefined,
            };
          }
        }
      }
    }

    if (Array.isArray(obj.questions)) {
      rawQuestions = obj.questions;
    } else if (Array.isArray(obj.data)) {
      rawQuestions = obj.data;
    } else if (Array.isArray(obj.items)) {
      rawQuestions = obj.items;
    } else if (typeof obj.question === 'string' || typeof obj.title === 'string' || typeof obj.q === 'string') {
      rawQuestions = [obj];
    } else {
      throw new Error('រកមិនឃើញបញ្ជី "questions" ឬ Array នៃសំណួរនៅក្នុង JSON ទេ!');
    }
  } else {
    throw new Error('ទម្រង់ JSON ត្រូវតែជា Object ({ "questions": [...] }) ឬ Array ([ ... ])!');
  }

  const parsedQuestions: Question[] = [];
  let skippedCount = 0;

  for (const item of rawQuestions) {
    if (!item || typeof item !== 'object') {
      skippedCount++;
      continue;
    }

    const row = item as Record<string, unknown>;
    const rawQuestionText =
      row.question ?? row.title ?? row.q ?? row.prompt ?? row.term ?? row.text ?? '';
    const questionText = String(rawQuestionText).trim();

    if (!questionText) {
      skippedCount++;
      continue;
    }

    const itemSubject = String(row.subject ?? row.category ?? row.topic ?? '').trim();
    const resolvedSubject =
      options.overrideSubject?.trim() ||
      itemSubject ||
      topLevelSubject ||
      options.fallbackSubject.trim() ||
      'ចំណេះដឹងទូទៅ';

    const extractedOptions = extractOptionsArray(row.options ?? row.choices);
    const resolvedType = normalizeQuestionType(row.type, extractedOptions.length, options.forcedType);

    const rawAnswer = row.answer ?? row.explanation ?? row.note ?? row.reference ?? row.desc ?? '';
    const answerText = String(rawAnswer).trim();

    if (resolvedType === 'mcq') {
      if (extractedOptions.length < 2) {
        skippedCount++;
        continue;
      }

      const labels = ['ក', 'ខ', 'គ', 'ឃ'];
      const paddedOptions = [...extractedOptions];
      while (paddedOptions.length < 4) {
        paddedOptions.push(`${labels[paddedOptions.length]}. (មិនមាន)`);
      }

      const rawCorrect =
        row.correct ??
        row.correctIndex ??
        row.correct_index ??
        row.correctAnswer ??
        row.correct_answer ??
        row.ans;

      const correctIndex = resolveCorrectIndex(rawCorrect, paddedOptions);

      parsedQuestions.push({
        subject: resolvedSubject,
        question: questionText,
        type: 'mcq',
        options: paddedOptions,
        correct: correctIndex,
        answer: answerText || undefined,
        isActive: row.isActive !== false,
        order: typeof row.order === 'number' ? row.order : undefined,
      });
    } else {
      parsedQuestions.push({
        subject: resolvedSubject,
        question: questionText,
        type: resolvedType,
        answer: answerText || '(មិនមានចម្លើយបកស្រាយ)',
        isActive: row.isActive !== false,
        order: typeof row.order === 'number' ? row.order : undefined,
      });
    }
  }

  return {
    questions: parsedQuestions,
    subjectMetaMap,
    skippedCount,
  };
}
