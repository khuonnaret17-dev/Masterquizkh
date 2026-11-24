import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  RotateCcw,
  Trophy,
  CheckCircle2,
  XCircle,
  Share2,
  Volume2,
  VolumeX,
  Eye,
  Award,
  BookOpen,
  HelpCircle,
  ListChecks,
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { Question } from '../types';
import { SocialShareModal } from './SocialShareModal';
import { KhmerCornerMotif, KhmerLotusCrest, KhmerLotusDivider } from './KhmerOrnaments';
import { renderQuestionCardImage } from '../services/telegram';
import {
  renderResultCardImage,
  formatQuestionSocialCaption,
  formatResultSocialCaption,
  ShareImageFormat,
} from '../services/socialShare';
import {
  toKhmerNum,
  getOptionLabel,
  playCorrectSound,
  playWrongSound,
  playClickSound,
  shuffleArray,
} from '../utils/khmer';

interface QuizGameScreenProps {
  questions: Question[];
  title: string;
  isMuted: boolean;
  onToggleMute: () => void;
  onExit: () => void;
  onNextPart?: () => void;
  nextPartLabel?: string;
  isLastPart?: boolean;
}

interface PreparedQuizItem {
  original: Question;
  shuffledOptions: string[];
  correctIndex: number;
}

function stripOptionPrefix(opt: string): string {
  return String(opt || '')
    .replace(/^\s*(?:\([ក-ឃA-Da-d]\)|[ក-ឃA-Da-d][.):])\s*/u, '')
    .trim();
}

function prepareRandomizedQuiz(rawQuestions: Question[]): PreparedQuizItem[] {
  const shuffledQuestions = shuffleArray(rawQuestions);
  return shuffledQuestions.map((q) => {
    if (q.type === 'mcq' && q.options && q.options.length > 0) {
      const safeCorrectIdx =
        typeof q.correct === 'number' && q.correct >= 0 && q.correct < q.options.length
          ? q.correct
          : 0;
      const tagged = q.options.map((opt, idx) => ({
        text: stripOptionPrefix(opt),
        isCorrect: idx === safeCorrectIdx,
      }));
      const shuffledTagged = shuffleArray(tagged);
      const newCorrectIndex = Math.max(
        0,
        shuffledTagged.findIndex((item) => item.isCorrect)
      );
      return {
        original: q,
        shuffledOptions: shuffledTagged.map((item) => item.text),
        correctIndex: newCorrectIndex,
      };
    }
    return {
      original: q,
      shuffledOptions: [],
      correctIndex: 0,
    };
  });
}

export const QuizGameScreen: React.FC<QuizGameScreenProps> = ({
  questions,
  title,
  isMuted,
  onToggleMute,
  onExit,
  onNextPart,
  nextPartLabel,
  isLastPart = false,
}) => {
  const [preparedQuestions, setPreparedQuestions] = useState<PreparedQuizItem[]>(() =>
    prepareRandomizedQuiz(questions)
  );
  const [currentIndex, setCurrentIndex] = useState(0);
  const [userAnswers, setUserAnswers] = useState<Record<number, number>>({});
  const [revealedShortAnswers, setRevealedShortAnswers] = useState<Record<number, boolean>>({});
  const [selfAssessment, setSelfAssessment] = useState<Record<number, boolean>>({});
  const [isCompleted, setIsCompleted] = useState(false);
  const [isReviewMode, setIsReviewMode] = useState(false);
  const [reviewFilter, setReviewFilter] = useState<'all' | 'correct' | 'wrong' | 'unanswered'>('all');
  const [shareModalMode, setShareModalMode] = useState<null | 'question' | 'result'>(null);

  useEffect(() => {
    setPreparedQuestions(prepareRandomizedQuiz(questions));
    setUserAnswers({});
    setRevealedShortAnswers({});
    setSelfAssessment({});
    setCurrentIndex(0);
    setIsCompleted(false);
    setIsReviewMode(false);
    setReviewFilter('all');
  }, [questions]);

  const currentItem = preparedQuestions[currentIndex];
  const currentQ = currentItem?.original;
  const qOptionsData = useMemo(
    () => ({
      options: currentItem?.shuffledOptions || currentQ?.options || [],
      correctIndex: currentItem?.correctIndex ?? currentQ?.correct ?? 0,
    }),
    [currentItem, currentQ]
  );

  const totalQuestions = preparedQuestions.length;

  const questionStatuses = useMemo(() => {
    return preparedQuestions.map((item, idx) => {
      const q = item.original;
      if (q.type === 'mcq') {
        const selected = userAnswers[idx];
        if (selected === undefined) return 'unanswered' as const;
        return selected === item.correctIndex ? ('correct' as const) : ('wrong' as const);
      }
      if (selfAssessment[idx] === true) return 'correct' as const;
      if (selfAssessment[idx] === false) return 'wrong' as const;
      return 'unanswered' as const;
    });
  }, [preparedQuestions, userAnswers, selfAssessment]);

  const correctCount = useMemo(
    () => questionStatuses.filter((s) => s === 'correct').length,
    [questionStatuses]
  );
  const wrongCount = useMemo(
    () => questionStatuses.filter((s) => s === 'wrong').length,
    [questionStatuses]
  );
  const unansweredCount = useMemo(
    () => questionStatuses.filter((s) => s === 'unanswered').length,
    [questionStatuses]
  );

  const percentage = totalQuestions > 0 ? Math.round((correctCount / totalQuestions) * 100) : 0;

  const handleSelectOption = (optionIndex: number) => {
    if (userAnswers[currentIndex] !== undefined) return;
    playClickSound();

    const isCorrect = optionIndex === qOptionsData.correctIndex;
    if (isCorrect) {
      playCorrectSound();
    } else {
      playWrongSound();
    }

    setUserAnswers((prev) => ({ ...prev, [currentIndex]: optionIndex }));
  };

  const handleMarkSelfAssessment = (correct: boolean) => {
    if (correct) {
      playCorrectSound();
    } else {
      playWrongSound();
    }
    setSelfAssessment((prev) => ({ ...prev, [currentIndex]: correct }));
  };

  const handleFinishQuiz = () => {
    setIsCompleted(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (percentage >= 50) {
      try {
        confetti({
          particleCount: 90,
          spread: 70,
          origin: { y: 0.6 },
        });
      } catch {
        // Ignore
      }
    }
  };

  const handleRetry = () => {
    setPreparedQuestions(prepareRandomizedQuiz(questions));
    setUserAnswers({});
    setRevealedShortAnswers({});
    setSelfAssessment({});
    setCurrentIndex(0);
    setIsCompleted(false);
    setIsReviewMode(false);
    setReviewFilter('all');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const medalTitle =
    percentage >= 90
      ? 'ឆ្នើមឥតខ្ចោះ — លេខ ១! 🏆'
      : percentage >= 75
      ? 'លទ្ធផលល្អប្រសើរណាស់! 🥇'
      : percentage >= 50
      ? 'ជាប់កម្រិតមធ្យម! 🥈'
      : 'ខំប្រឹងប្រែងបន្ថែមទៀត!';

  const medalClass =
    percentage >= 90
      ? 'bg-amber-50 dark:bg-amber-950/60 border-amber-400 text-amber-900 dark:text-amber-200'
      : percentage >= 75
      ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-400 text-emerald-900 dark:text-emerald-200'
      : percentage >= 50
      ? 'bg-blue-50 dark:bg-blue-950/60 border-blue-400 text-blue-900 dark:text-blue-200'
      : 'app-subcard app-text-primary';

  const resultShareParams = useMemo(
    () => ({
      title,
      correctCount,
      totalQuestions,
      percentage,
      medalTitle,
    }),
    [title, correctCount, totalQuestions, percentage, medalTitle]
  );

  const renderShareImage = useCallback(
    async ({ format, showAnswer }: { format: ShareImageFormat; showAnswer: boolean }) => {
      if (shareModalMode === 'result') {
        return renderResultCardImage({ ...resultShareParams, format });
      }
      if (!currentQ) return '';
      const shareQuestionObj: Question =
        currentQ.type === 'mcq'
          ? {
              ...currentQ,
              options: qOptionsData.options,
              correct: qOptionsData.correctIndex,
            }
          : currentQ;
      return renderQuestionCardImage(shareQuestionObj, currentIndex + 1, {
        showAnswer,
        format,
      });
    },
    [shareModalMode, resultShareParams, currentQ, qOptionsData, currentIndex]
  );

  const hasCurrentUserAnswered =
    userAnswers[currentIndex] !== undefined ||
    Boolean(revealedShortAnswers[currentIndex]) ||
    isReviewMode;

  const shareModal = (
    <SocialShareModal
      isOpen={shareModalMode !== null}
      onClose={() => setShareModalMode(null)}
      title={
        shareModalMode === 'result'
          ? `លទ្ធផលតេស្ត — ${title}`
          : `សំណួរទី ${toKhmerNum(currentIndex + 1)} · ${currentQ?.subject || title}`
      }
      initialCaption={
        shareModalMode === 'result'
          ? formatResultSocialCaption(resultShareParams)
          : currentQ
          ? formatQuestionSocialCaption(
              currentQ.type === 'mcq'
                ? { ...currentQ, options: qOptionsData.options, correct: qOptionsData.correctIndex }
                : currentQ,
              currentIndex + 1
            )
          : ''
      }
      filenameBase={
        shareModalMode === 'result'
          ? 'MasterQuiz_Result'
          : `MasterQuiz_Q${currentIndex + 1}`
      }
      renderImage={renderShareImage}
      allowShowAnswerToggle={shareModalMode === 'question'}
      defaultShowAnswer={hasCurrentUserAnswered}
    />
  );

  // Combined Answer Preview Screen (Preview ចម្លើយដែលបានធ្វើរួម)
  if (isCompleted && isReviewMode) {
    const filteredReviewItems = preparedQuestions
      .map((item, idx) => ({
        item,
        idx,
        status: questionStatuses[idx],
      }))
      .filter((entry) => reviewFilter === 'all' || entry.status === reviewFilter);

    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 sm:py-8 tg-safe-x space-y-5">
        {/* Top Header Card */}
        <div className="relative khmer-ornate-card rounded-2xl p-4 sm:p-6">
          <KhmerCornerMotif position="tl" size={28} />
          <KhmerCornerMotif position="tr" size={28} />

          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={() => {
                  setIsReviewMode(false);
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                className="min-h-[42px] px-3.5 py-2 rounded-xl app-subcard app-text-primary hover:opacity-85 text-xs sm:text-sm font-semibold flex items-center gap-1.5 transition cursor-pointer shrink-0 whitespace-nowrap"
              >
                <ArrowLeft className="w-4 h-4" />
                <span>លទ្ធផល</span>
              </button>
              <div className="min-w-0">
                <h2 className="font-moul text-sm sm:text-lg app-text-primary truncate">
                  Preview ចម្លើយដែលបានធ្វើរួម
                </h2>
                <p className="text-xs sm:text-sm app-text-secondary truncate">
                  {title} · ត្រូវ{' '}
                  <strong className="text-emerald-700 dark:text-emerald-300 tabular-nums">
                    {toKhmerNum(correctCount)} / {toKhmerNum(totalQuestions)}
                  </strong>{' '}
                  ({toKhmerNum(percentage)}%)
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleRetry}
                className="min-h-[40px] px-3.5 py-2 rounded-xl khmer-btn-primary text-xs sm:text-sm font-semibold flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
              >
                <RotateCcw className="w-4 h-4" />
                <span>ធ្វើម្ដងទៀត</span>
              </button>

              {onNextPart && (
                <button
                  type="button"
                  onClick={onNextPart}
                  className="min-h-[40px] px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs sm:text-sm font-bold flex items-center gap-1.5 transition cursor-pointer whitespace-nowrap"
                >
                  <span>{nextPartLabel || 'បន្តទៅភាគបន្ទាប់'}</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {/* Filter Tabs */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mt-4 p-1.5 rounded-xl app-subcard">
            {[
              { id: 'all', label: `ទាំងអស់ (${toKhmerNum(totalQuestions)})` },
              { id: 'correct', label: `ត្រូវ (${toKhmerNum(correctCount)})` },
              { id: 'wrong', label: `ខុស (${toKhmerNum(wrongCount)})` },
              { id: 'unanswered', label: `មិនទាន់ឆ្លើយ (${toKhmerNum(unansweredCount)})` },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setReviewFilter(tab.id as any)}
                className={`min-h-[38px] px-2.5 py-1.5 rounded-lg text-xs sm:text-sm font-semibold transition cursor-pointer whitespace-nowrap ${
                  reviewFilter === tab.id
                    ? 'khmer-btn-primary shadow-sm'
                    : 'app-text-secondary hover:opacity-80'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* All Questions Combined List */}
        {filteredReviewItems.length === 0 ? (
          <div className="khmer-frame-card rounded-2xl p-8 text-center">
            <p className="text-sm sm:text-base app-text-secondary">
              មិនមានសំណួរនៅក្នុងក្រុមចម្រោះនេះទេ។
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {filteredReviewItems.map(({ item, idx, status }) => {
              const q = item.original;
              const selectedIdx = userAnswers[idx];

              return (
                <div
                  key={q.id ? `${q.id}-${idx}` : idx}
                  className="khmer-frame-card rounded-2xl p-4 sm:p-6 space-y-3.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b app-border">
                    <div className="flex items-center gap-2 text-xs sm:text-sm">
                      <span className="font-moul khmer-gold-text tabular-nums">
                        សំណួរទី {toKhmerNum(idx + 1)}
                      </span>
                      <span className="app-text-muted">·</span>
                      <span className="font-semibold app-text-secondary">{q.subject}</span>
                    </div>

                    <div
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold border ${
                        status === 'correct'
                          ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-400 dark:border-emerald-700 text-emerald-800 dark:text-emerald-200'
                          : status === 'wrong'
                          ? 'bg-red-50 dark:bg-red-950/60 border-red-400 dark:border-red-700 text-red-800 dark:text-red-200'
                          : 'app-subcard app-text-secondary'
                      }`}
                    >
                      {status === 'correct' ? (
                        <>
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>ឆ្លើយត្រូវ</span>
                        </>
                      ) : status === 'wrong' ? (
                        <>
                          <XCircle className="w-3.5 h-3.5" />
                          <span>ឆ្លើយខុស</span>
                        </>
                      ) : (
                        <>
                          <HelpCircle className="w-3.5 h-3.5" />
                          <span>មិនទាន់ឆ្លើយ</span>
                        </>
                      )}
                    </div>
                  </div>

                  <p className="font-kantumruy font-bold text-base sm:text-lg app-text-primary leading-relaxed">
                    {q.question}
                  </p>

                  {q.type === 'mcq' && item.shuffledOptions.length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      {item.shuffledOptions.map((opt, oIdx) => {
                        const isCorrectOpt = oIdx === item.correctIndex;
                        const isUserChoice = selectedIdx === oIdx;

                        let optClass = 'app-subcard app-text-primary';
                        if (isCorrectOpt) {
                          optClass =
                            'bg-emerald-50 dark:bg-emerald-950/65 border-emerald-500 text-emerald-950 dark:text-emerald-100';
                        } else if (isUserChoice) {
                          optClass =
                            'bg-red-50 dark:bg-red-950/65 border-red-500 text-red-950 dark:text-red-100';
                        }

                        return (
                          <div
                            key={oIdx}
                            className={`p-3 rounded-xl border text-sm flex items-start justify-between gap-2.5 ${optClass}`}
                          >
                            <div className="flex items-start gap-2 min-w-0">
                              <span
                                className={`w-6 h-6 rounded-md flex items-center justify-center font-bold text-xs shrink-0 mt-0.5 ${
                                  isCorrectOpt
                                    ? 'bg-emerald-600 text-white'
                                    : isUserChoice
                                    ? 'bg-red-600 text-white'
                                    : 'bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-white'
                                }`}
                              >
                                {getOptionLabel(oIdx, q.subject)}
                              </span>
                              <div className="min-w-0">
                                <span className="font-kantumruy font-medium leading-relaxed break-words">
                                  {opt}
                                </span>
                                {(isCorrectOpt || isUserChoice) && (
                                  <span className="block text-[11px] font-bold mt-0.5">
                                    {isCorrectOpt && isUserChoice
                                      ? 'អ្នកបានជ្រើស · ចម្លើយត្រឹមត្រូវ'
                                      : isCorrectOpt
                                      ? 'ចម្លើយត្រឹមត្រូវ'
                                      : 'ចម្លើយដែលអ្នកបានជ្រើស'}
                                  </span>
                                )}
                              </div>
                            </div>
                            {isCorrectOpt && (
                              <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-1" />
                            )}
                            {!isCorrectOpt && isUserChoice && (
                              <XCircle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0 mt-1" />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {q.type === 'mcq' && q.answer && (
                    <div className="p-3.5 sm:p-4 rounded-xl app-answer-box font-siemreap text-sm leading-loose">
                      <p className="font-moul text-xs app-answer-title mb-1 flex items-center gap-1.5">
                        <BookOpen className="w-3.5 h-3.5 shrink-0" />
                        <span>ឯកសារយោង / ការបកស្រាយ៖</span>
                      </p>
                      <div className="whitespace-pre-line">{q.answer}</div>
                    </div>
                  )}

                  {(q.type === 'short' || q.type === 'explanation') && (
                    <div className="p-4 rounded-xl app-answer-box font-siemreap text-sm sm:text-base leading-loose space-y-2">
                      <p className="font-moul text-xs app-answer-title">
                        ចម្លើយបកស្រាយផ្លូវការ៖
                      </p>
                      <div className="whitespace-pre-line">
                        {q.answer || 'មិនទាន់មានការបកស្រាយលម្អិត។'}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Bottom Direct Continuation Bar */}
        <div className="khmer-ornate-card rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setIsReviewMode(false);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              className="min-h-[44px] px-4 py-2 rounded-xl app-subcard app-text-primary font-semibold text-sm flex items-center justify-center gap-1.5 hover:opacity-85 transition cursor-pointer"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>ត្រឡប់ទៅលទ្ធផល</span>
            </button>

            <button
              type="button"
              onClick={handleRetry}
              className="min-h-[44px] px-4 py-2 rounded-xl khmer-btn-primary font-semibold text-sm flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" />
              <span>ធ្វើតេស្តភាគនេះម្ដងទៀត</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 justify-end">
            {onNextPart && (
              <button
                type="button"
                onClick={onNextPart}
                className="flex-1 sm:flex-none min-h-[44px] px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm flex items-center justify-center gap-2 transition cursor-pointer"
              >
                <span>{nextPartLabel || 'បន្តទៅភាគបន្ទាប់'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            )}
            <button
              type="button"
              onClick={onExit}
              className="min-h-[44px] px-4 py-2 rounded-xl app-subcard app-text-secondary hover:opacity-80 text-sm font-medium transition cursor-pointer"
            >
              ត្រឡប់ទៅមឺនុយដើម
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Result Summary Screen
  if (isCompleted && !isReviewMode) {
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-4 sm:py-10 tg-safe-x">
        <div className="relative khmer-ornate-card rounded-2xl p-5 sm:p-9 text-center">
          <KhmerCornerMotif position="tl" size={34} />
          <KhmerCornerMotif position="tr" size={34} />
          <KhmerCornerMotif position="bl" size={34} />
          <KhmerCornerMotif position="br" size={34} />

          <KhmerLotusCrest size={52} className="mx-auto mb-2" />

          <div className="inline-flex mb-4">
            <div className="w-20 h-20 rounded-full bg-amber-600 text-white ring-4 ring-[var(--theme-gold)]/40 flex items-center justify-center shadow-md">
              <Trophy className="w-10 h-10" />
            </div>
          </div>

          <h2 className="font-moul text-xl sm:text-2xl app-text-primary mb-2">
            លទ្ធផលការធ្វើតេស្ត
          </h2>
          <p className="text-sm app-text-secondary mb-2">{title}</p>
          <KhmerLotusDivider width={200} className="mx-auto mb-5" />

          <div className={`p-5 rounded-2xl border max-w-sm mx-auto mb-5 ${medalClass}`}>
            <p className="font-moul text-base sm:text-lg mb-2">{medalTitle}</p>
            <div className="flex items-baseline justify-center gap-1">
              <span className="font-moul text-4xl sm:text-5xl tabular-nums">
                {toKhmerNum(percentage)}
              </span>
              <span className="text-xl font-bold">%</span>
            </div>
            <p className="text-sm mt-2 font-kantumruy font-medium">
              ឆ្លើយត្រូវ <strong className="tabular-nums">{toKhmerNum(correctCount)}</strong> ក្នុងចំណោម{' '}
              <strong className="tabular-nums">{toKhmerNum(totalQuestions)}</strong> សំណួរ
            </p>
          </div>

          {/* Per-question quick status strip */}
          <div className="max-w-md mx-auto mb-6 p-3.5 rounded-2xl app-subcard">
            <div className="flex items-center justify-between text-xs font-semibold app-text-secondary mb-2.5">
              <span>សង្ខេបចម្លើយតាមលេខរៀង</span>
              <span className="tabular-nums">
                ត្រូវ {toKhmerNum(correctCount)} · ខុស {toKhmerNum(wrongCount)}
                {unansweredCount > 0 ? ` · រំលង ${toKhmerNum(unansweredCount)}` : ''}
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-1.5">
              {questionStatuses.map((status, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => {
                    setReviewFilter('all');
                    setIsReviewMode(true);
                  }}
                  title={`សំណួរទី ${toKhmerNum(idx + 1)} — ចុចដើម្បី Preview ចម្លើយ`}
                  className={`min-w-[36px] h-9 px-2 rounded-lg text-xs font-bold flex items-center justify-center gap-1 border transition cursor-pointer tabular-nums ${
                    status === 'correct'
                      ? 'bg-emerald-50 dark:bg-emerald-950/70 border-emerald-500 text-emerald-800 dark:text-emerald-200'
                      : status === 'wrong'
                      ? 'bg-red-50 dark:bg-red-950/70 border-red-500 text-red-800 dark:text-red-200'
                      : 'app-card app-text-muted'
                  }`}
                >
                  <span>{toKhmerNum(idx + 1)}</span>
                  {status === 'correct' ? (
                    <CheckCircle2 className="w-3 h-3" />
                  ) : status === 'wrong' ? (
                    <XCircle className="w-3 h-3" />
                  ) : null}
                </button>
              ))}
            </div>
          </div>

          {isLastPart && (
            <p className="text-xs sm:text-sm font-semibold text-emerald-700 dark:text-emerald-300 mb-4">
              អ្នកបានបញ្ចប់គ្រប់ភាគទាំងអស់នៃមុខវិជ្ជានេះរួចរាល់ហើយ!
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-md mx-auto">
            {onNextPart && (
              <button
                type="button"
                onClick={onNextPart}
                className="sm:col-span-2 min-h-[46px] py-3 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm sm:text-base flex items-center justify-center gap-2 transition shadow-sm cursor-pointer"
              >
                <span>{nextPartLabel || 'បន្តទៅភាគបន្ទាប់'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                setReviewFilter('all');
                setIsReviewMode(true);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              className="min-h-[44px] py-3 px-4 rounded-xl app-subcard app-text-primary font-semibold text-sm flex items-center justify-center gap-2 hover:opacity-85 transition cursor-pointer"
            >
              <ListChecks className="w-4 h-4 khmer-accent-text shrink-0" />
              <span>Preview ចម្លើយរួម</span>
            </button>

            <button
              type="button"
              onClick={handleRetry}
              className="min-h-[44px] py-3 px-4 rounded-xl khmer-btn-primary font-semibold text-sm flex items-center justify-center gap-2 cursor-pointer"
            >
              <RotateCcw className="w-4 h-4 shrink-0" />
              <span>ធ្វើតេស្តម្ដងទៀត</span>
            </button>

            <button
              type="button"
              onClick={() => setShareModalMode('result')}
              className="sm:col-span-2 min-h-[44px] py-3 px-4 rounded-xl khmer-btn-crimson font-bold text-sm flex items-center justify-center gap-2 cursor-pointer"
            >
              <Share2 className="w-4 h-4" />
              <span>ចែករំលែកលទ្ធផល (Facebook / TikTok)</span>
            </button>

            <button
              type="button"
              onClick={onExit}
              className="sm:col-span-2 min-h-[42px] py-2.5 px-4 rounded-xl app-subcard app-text-secondary hover:opacity-80 text-sm font-medium transition cursor-pointer"
            >
              ត្រឡប់ទៅមឺនុយដើម
            </button>
          </div>
        </div>
        {shareModal}
      </div>
    );
  }

  if (!currentQ) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-10 text-center">
        <div className="khmer-frame-card rounded-2xl p-8 space-y-4">
          <p className="text-sm app-text-secondary">មិនមានសំណួរនៅក្នុងភាគនេះទេ។</p>
          <button
            type="button"
            onClick={onExit}
            className="px-5 py-2.5 rounded-xl khmer-btn-primary text-sm font-semibold cursor-pointer"
          >
            ត្រឡប់ទៅមឺនុយដើម
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-3 sm:py-6 tg-safe-x">
      {/* Top Bar */}
      <div className="flex items-center justify-between mb-4 gap-2.5">
        <button
          type="button"
          onClick={onExit}
          className="flex items-center gap-1.5 min-h-[40px] text-xs sm:text-sm font-semibold app-card px-3.5 py-1.5 rounded-xl hover:opacity-80 transition cursor-pointer shrink-0 whitespace-nowrap"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>ចាកចេញ</span>
        </button>

        <div className="text-center min-w-0 px-2">
          <p className="font-moul text-xs sm:text-base app-text-primary truncate">{title}</p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onToggleMute}
            title="បិទ/បើកសំឡេង"
            aria-label="បិទ/បើកសំឡេង"
            className="min-w-[40px] min-h-[40px] p-2 rounded-xl app-card hover:opacity-80 transition cursor-pointer flex items-center justify-center"
          >
            {isMuted ? (
              <VolumeX className="w-4 h-4 text-red-600 dark:text-red-400" />
            ) : (
              <Volume2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            )}
          </button>
          <div className="min-h-[40px] flex items-center px-3 py-1.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-400 dark:border-emerald-700 text-emerald-800 dark:text-emerald-200 font-bold text-xs sm:text-sm tabular-nums whitespace-nowrap">
            ត្រូវ {toKhmerNum(correctCount)}
          </div>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="w-full app-subcard rounded-full h-2.5 mb-6 overflow-hidden">
        <div
          className="h-2.5 rounded-full transition-all duration-300"
          style={{
            width: `${((currentIndex + 1) / totalQuestions) * 100}%`,
            backgroundColor: 'var(--theme-accent)',
          }}
        />
      </div>

      {/* Main Question Card */}
      <div className="relative khmer-ornate-card rounded-2xl p-5 sm:p-8">
        <KhmerCornerMotif position="tl" size={30} />
        <KhmerCornerMotif position="tr" size={30} />
        <KhmerCornerMotif position="bl" size={30} />
        <KhmerCornerMotif position="br" size={30} />

        {/* Card Header info */}
        <div className="flex flex-wrap items-center justify-between gap-2 mb-5 pb-3 border-b app-border">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-moul khmer-accent-text tabular-nums">
              សំណួរទី {toKhmerNum(currentIndex + 1)} / {toKhmerNum(totalQuestions)}
            </span>
            <span className="app-text-muted">·</span>
            <span className="font-semibold app-text-secondary">{currentQ.subject}</span>
          </div>

          <button
            type="button"
            onClick={() => setShareModalMode('question')}
            title="ចែករំលែកឬរក្សាទុកប័ណ្ណសំណួរជារូបភាព"
            className="flex items-center gap-1.5 text-xs font-semibold app-subcard px-3 py-1.5 rounded-xl hover:opacity-80 transition cursor-pointer whitespace-nowrap"
          >
            <Share2 className="w-3.5 h-3.5 khmer-gold-text" />
            <span>ចែករំលែក (FB / TikTok)</span>
          </button>
        </div>

        {/* Question Text */}
        <h2 className="font-kantumruy font-bold text-lg sm:text-xl app-text-primary mb-6 leading-relaxed">
          {currentQ.question}
        </h2>

        {/* MCQ Options */}
        {currentQ.type === 'mcq' && (
          <div className="space-y-3 mb-6">
            {qOptionsData.options.map((option, optIdx) => {
              const selectedIdx = userAnswers[currentIndex];
              const isSelected = selectedIdx === optIdx;
              const isCorrectOpt = optIdx === qOptionsData.correctIndex;
              const hasAnswered = selectedIdx !== undefined;

              let btnStyle = 'app-subcard hover:border-[var(--theme-accent)]';

              if (hasAnswered) {
                if (isCorrectOpt) {
                  btnStyle =
                    'bg-emerald-50 dark:bg-emerald-950/70 border-emerald-600 text-emerald-950 dark:text-emerald-100';
                } else if (isSelected && !isCorrectOpt) {
                  btnStyle =
                    'bg-red-50 dark:bg-red-950/70 border-red-600 text-red-950 dark:text-red-100';
                } else {
                  btnStyle = 'app-subcard opacity-60';
                }
              }

              return (
                <button
                  key={optIdx}
                  type="button"
                  onClick={() => handleSelectOption(optIdx)}
                  disabled={hasAnswered}
                  className={`w-full p-4 rounded-xl border text-left flex items-start gap-3.5 transition cursor-pointer ${btnStyle}`}
                >
                  <span
                    className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold text-sm shrink-0 ${
                      hasAnswered && isCorrectOpt
                        ? 'bg-emerald-600 text-white'
                        : hasAnswered && isSelected && !isCorrectOpt
                        ? 'bg-red-600 text-white'
                        : 'bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-white'
                    }`}
                  >
                    {getOptionLabel(optIdx, currentQ.subject)}
                  </span>
                  <span className="font-kantumruy text-base leading-relaxed flex-1 break-words font-medium">
                    {option}
                  </span>
                  {hasAnswered && isCorrectOpt && (
                    <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-1" />
                  )}
                  {hasAnswered && isSelected && !isCorrectOpt && (
                    <XCircle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0 mt-1" />
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* MCQ Reference Document / Explanation */}
        {currentQ.type === 'mcq' && currentQ.answer && userAnswers[currentIndex] !== undefined && (
          <div className="mb-6 p-4 sm:p-5 rounded-xl app-answer-box font-siemreap text-sm sm:text-base leading-loose">
            <p className="font-moul text-xs sm:text-sm app-answer-title mb-1.5 flex items-center gap-2">
              <BookOpen className="w-4 h-4 shrink-0" />
              <span>ឯកសារយោង / ការបកស្រាយ៖</span>
            </p>
            <div className="whitespace-pre-line">{currentQ.answer}</div>
          </div>
        )}

        {/* Short & Explanation Type Rendering */}
        {(currentQ.type === 'short' || currentQ.type === 'explanation') && (
          <div className="mb-6 space-y-4">
            {!revealedShortAnswers[currentIndex] ? (
              <button
                type="button"
                onClick={() =>
                  setRevealedShortAnswers((prev) => ({ ...prev, [currentIndex]: true }))
                }
                className="w-full py-3.5 px-4 rounded-xl khmer-btn-primary font-semibold text-sm sm:text-base flex items-center justify-center gap-2 cursor-pointer"
              >
                <Eye className="w-4 h-4" />
                <span>ចុចដើម្បីបង្ហាញចម្លើយបកស្រាយ</span>
              </button>
            ) : (
              <div className="p-5 rounded-xl app-answer-box font-siemreap text-base leading-loose">
                <p className="font-moul text-xs sm:text-sm app-answer-title mb-2">
                  ចម្លើយបកស្រាយផ្លូវការ៖
                </p>
                <div className="whitespace-pre-line">{currentQ.answer}</div>

                {selfAssessment[currentIndex] === undefined && (
                  <div className="mt-5 pt-4 border-t app-border flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <span className="text-sm font-semibold app-text-primary">
                      វាយតម្លៃការយល់ដឹងរបស់អ្នក៖
                    </span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => handleMarkSelfAssessment(true)}
                        className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center gap-1.5 transition cursor-pointer"
                      >
                        <CheckCircle2 className="w-4 h-4" />
                        <span>យល់ច្បាស់ / ត្រូវ</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMarkSelfAssessment(false)}
                        className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm font-semibold flex items-center gap-1.5 transition cursor-pointer"
                      >
                        <XCircle className="w-4 h-4" />
                        <span>រៀនបន្ថែម</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Footer Navigation */}
        <div className="flex items-center justify-between pt-4 border-t app-border">
          <button
            type="button"
            onClick={() => setCurrentIndex((prev) => Math.max(0, prev - 1))}
            disabled={currentIndex === 0}
            className="min-h-[44px] px-4 py-2.5 rounded-xl app-subcard app-text-primary disabled:opacity-40 disabled:cursor-not-allowed text-sm font-semibold flex items-center gap-1.5 transition cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>ថយក្រោយ</span>
          </button>

          {currentIndex === totalQuestions - 1 ? (
            <button
              type="button"
              onClick={handleFinishQuiz}
              className="min-h-[44px] px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm flex items-center gap-2 transition cursor-pointer"
            >
              <Award className="w-4 h-4" />
              <span>បញ្ចប់ការធ្វើតេស្ត</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setCurrentIndex((prev) => Math.min(totalQuestions - 1, prev + 1))}
              className="min-h-[44px] px-6 py-2.5 rounded-xl khmer-btn-primary font-bold text-sm flex items-center gap-2 cursor-pointer"
            >
              <span>សំណួរបន្ទាប់</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {shareModal}
    </div>
  );
};
