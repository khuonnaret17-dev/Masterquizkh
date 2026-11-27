import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  X,
  Share2,
  Copy,
  Check,
  Download,
  ExternalLink,
  Smartphone,
  LayoutGrid,
  RefreshCw,
  Image as ImageIcon,
  Link2,
  Images,
  CheckSquare,
  Square,
} from 'lucide-react';
import { KhmerCornerMotif } from './KhmerOrnaments';
import { toKhmerNum } from '../utils/khmer';
import {
  ShareImageFormat,
  HostedShareInfo,
  ShareBatchImageItem,
  shareImageNative,
  shareMultipleImagesNative,
  copyImageToClipboard,
  copyTextToClipboard,
  downloadImageDataUrl,
  downloadMultipleImagesDataUrls,
  publishShareCard,
  updateShareCardCaption,
  buildFacebookShareUrl,
  buildTelegramShareUrl,
  TIKTOK_UPLOAD_URL,
} from '../services/socialShare';

const MAX_MULTI_SHARE = 10;

export interface ShareBatchCandidate {
  id: string;
  label: string;
  sublabel?: string;
  renderImage: (opts: { format: ShareImageFormat; showAnswer: boolean }) => Promise<string>;
}

export interface RenderedBatchImage {
  id: string;
  label: string;
  dataUrl: string;
}

export interface SocialShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  initialCaption: string;
  filenameBase: string;
  renderImage: (opts: { format: ShareImageFormat; showAnswer: boolean }) => Promise<string>;
  allowShowAnswerToggle?: boolean;
  defaultShowAnswer?: boolean;
  batchCandidates?: ShareBatchCandidate[];
  initialSelectedBatchIds?: string[];
  defaultMultiMode?: boolean;
  formatBatchCaption?: (selectedIds: string[]) => string;
}

export const SocialShareModal: React.FC<SocialShareModalProps> = ({
  isOpen,
  onClose,
  title,
  initialCaption,
  filenameBase,
  renderImage,
  allowShowAnswerToggle = false,
  defaultShowAnswer = false,
  batchCandidates,
  initialSelectedBatchIds,
  defaultMultiMode = false,
  formatBatchCaption,
}) => {
  const hasBatchSupport = Boolean(batchCandidates && batchCandidates.length > 1);

  const [shareMode, setShareMode] = useState<'single' | 'multi'>(
    defaultMultiMode && hasBatchSupport ? 'multi' : 'single'
  );
  const [format, setFormat] = useState<ShareImageFormat>('card');
  const [showAnswer, setShowAnswer] = useState<boolean>(defaultShowAnswer);

  // Single-image state
  const [imageDataUrl, setImageDataUrl] = useState<string>('');

  // Multi-image state
  const [selectedBatchIds, setSelectedBatchIds] = useState<string[]>([]);
  const [multiImages, setMultiImages] = useState<RenderedBatchImage[]>([]);
  const [renderProgress, setRenderProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });

  const [isRendering, setIsRendering] = useState<boolean>(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [caption, setCaption] = useState<string>(initialCaption);
  const [captionManuallyEdited, setCaptionManuallyEdited] = useState<boolean>(false);

  const [hostedShare, setHostedShare] = useState<HostedShareInfo | null>(null);
  const [isPublishingHost, setIsPublishingHost] = useState<boolean>(false);

  const [copiedImage, setCopiedImage] = useState<boolean>(false);
  const [copiedCaption, setCopiedCaption] = useState<boolean>(false);
  const [copiedLink, setCopiedLink] = useState<boolean>(false);
  const [statusNotice, setStatusNotice] = useState<{
    text: string;
    type: 'success' | 'info' | 'error';
  } | null>(null);

  const latestCaptionRef = useRef<string>(initialCaption);
  latestCaptionRef.current = caption;

  const candidateMap = useMemo(() => {
    const map = new Map<string, ShareBatchCandidate>();
    (batchCandidates || []).forEach((c) => map.set(c.id, c));
    return map;
  }, [batchCandidates]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  // Reset modal state on open
  useEffect(() => {
    if (!isOpen) return;
    const useMulti = Boolean(defaultMultiMode && batchCandidates && batchCandidates.length > 1);
    setShareMode(useMulti ? 'multi' : 'single');
    setShowAnswer(defaultShowAnswer);
    setHostedShare(null);
    setStatusNotice(null);
    setCopiedImage(false);
    setCopiedCaption(false);
    setCopiedLink(false);
    setCaptionManuallyEdited(false);

    let nextIds: string[] = [];
    if (batchCandidates && batchCandidates.length > 0) {
      if (initialSelectedBatchIds && initialSelectedBatchIds.length > 0) {
        nextIds = initialSelectedBatchIds
          .filter((id) => batchCandidates.some((c) => c.id === id))
          .slice(0, MAX_MULTI_SHARE);
      }
      if (nextIds.length === 0) {
        nextIds = batchCandidates.slice(0, Math.min(4, batchCandidates.length)).map((c) => c.id);
      }
    }
    setSelectedBatchIds(nextIds);

    const startCaption =
      useMulti && formatBatchCaption && nextIds.length > 0
        ? formatBatchCaption(nextIds)
        : initialCaption;
    setCaption(startCaption);
    latestCaptionRef.current = startCaption;
  }, [
    isOpen,
    initialCaption,
    defaultShowAnswer,
    defaultMultiMode,
    batchCandidates,
    initialSelectedBatchIds,
    formatBatchCaption,
  ]);

  // Sync caption automatically when toggling modes or selected IDs unless manually edited
  useEffect(() => {
    if (!isOpen || captionManuallyEdited) return;
    if (shareMode === 'multi') {
      if (formatBatchCaption && selectedBatchIds.length > 0) {
        const nextCap = formatBatchCaption(selectedBatchIds);
        setCaption(nextCap);
        latestCaptionRef.current = nextCap;
      }
    } else {
      setCaption(initialCaption);
      latestCaptionRef.current = initialCaption;
    }
  }, [isOpen, shareMode, selectedBatchIds, formatBatchCaption, initialCaption, captionManuallyEdited]);

  // Render Single or Multiple Images + Publish to Hosted Share Endpoint
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    const generateAndPublish = async () => {
      setRenderError(null);
      setHostedShare(null);

      if (shareMode === 'single') {
        setIsRendering(true);
        setRenderProgress({ done: 0, total: 1 });
        try {
          const dataUrl = await renderImage({ format, showAnswer });
          if (cancelled) return;
          setImageDataUrl(dataUrl);
          setRenderProgress({ done: 1, total: 1 });
          setIsRendering(false);

          setIsPublishingHost(true);
          const published = await publishShareCard({
            imageDataUrl: dataUrl,
            title,
            caption: latestCaptionRef.current,
            format,
          });
          if (!cancelled && published) {
            setHostedShare(published);
          }
        } catch (err) {
          console.error('Error generating share image:', err);
          if (!cancelled) {
            setRenderError('មិនអាចបង្កើតរូបភាពបានទេ សូមព្យាយាមម្ដងទៀត');
          }
        } finally {
          if (!cancelled) {
            setIsRendering(false);
            setIsPublishingHost(false);
          }
        }
        return;
      }

      // Multi-image generation
      const targets = selectedBatchIds
        .map((id) => candidateMap.get(id))
        .filter((item): item is ShareBatchCandidate => Boolean(item))
        .slice(0, MAX_MULTI_SHARE);

      if (targets.length === 0) {
        setMultiImages([]);
        setIsRendering(false);
        setRenderProgress({ done: 0, total: 0 });
        return;
      }

      setIsRendering(true);
      setMultiImages([]);
      setRenderProgress({ done: 0, total: targets.length });

      const renderedList: RenderedBatchImage[] = [];
      try {
        for (let i = 0; i < targets.length; i++) {
          if (cancelled) return;
          const candidate = targets[i];
          const dataUrl = await candidate.renderImage({ format, showAnswer });
          if (cancelled) return;
          if (dataUrl) {
            renderedList.push({
              id: candidate.id,
              label: candidate.label,
              dataUrl,
            });
          }
          setMultiImages([...renderedList]);
          setRenderProgress({ done: i + 1, total: targets.length });
        }

        if (cancelled || renderedList.length === 0) return;
        setIsRendering(false);

        setIsPublishingHost(true);
        const published = await publishShareCard({
          imageDataUrl: renderedList[0].dataUrl,
          extraImagesDataUrls: renderedList.slice(1).map((item) => item.dataUrl),
          title: `${title} (${toKhmerNum(renderedList.length)} រូបភាព)`,
          caption: latestCaptionRef.current,
          format,
        });
        if (!cancelled && published) {
          setHostedShare(published);
        }
      } catch (err) {
        console.error('Error generating multi share images:', err);
        if (!cancelled) {
          setRenderError('មានបញ្ហាក្នុងការបង្កើតរូបភាពច្រើនសន្លឹក សូមព្យាយាមម្ដងទៀត');
        }
      } finally {
        if (!cancelled) {
          setIsRendering(false);
          setIsPublishingHost(false);
        }
      }
    };

    generateAndPublish();
    return () => {
      cancelled = true;
    };
  }, [isOpen, shareMode, format, showAnswer, renderImage, title, selectedBatchIds, candidateMap]);

  // Keep hosted Open Graph caption synced when user edits caption
  useEffect(() => {
    if (!hostedShare?.id) return;
    const timer = setTimeout(() => {
      updateShareCardCaption(hostedShare.id, caption);
    }, 350);
    return () => clearTimeout(timer);
  }, [caption, hostedShare?.id]);

  if (!isOpen) return null;

  const isMultiMode = shareMode === 'multi' && hasBatchSupport;
  const suffix = format === 'tiktok' ? '9x16' : 'card';
  const targetFilename = `${filenameBase}_${suffix}.png`;

  const multiShareItems: ShareBatchImageItem[] = multiImages.map((img, idx) => ({
    dataUrl: img.dataUrl,
    filename: `${filenameBase}_${suffix}_${idx + 1}.png`,
    label: img.label,
  }));

  const hasShareableImages = isMultiMode ? multiImages.length > 0 : Boolean(imageDataUrl);
  const primaryImageDataUrl = isMultiMode ? multiImages[0]?.dataUrl || '' : imageDataUrl;

  const handleToggleCandidate = (id: string) => {
    setStatusNotice(null);
    setSelectedBatchIds((prev) => {
      if (prev.includes(id)) {
        return prev.filter((item) => item !== id);
      }
      if (prev.length >= MAX_MULTI_SHARE) {
        setStatusNotice({
          text: `អាចជ្រើសរើសបានច្រើនបំផុត ${toKhmerNum(MAX_MULTI_SHARE)} រូបភាពក្នុងពេលតែមួយ ដើម្បីឱ្យ App ទូរស័ព្ទទទួលស្គាល់ពេញលេញ។`,
          type: 'info',
        });
        return prev;
      }
      return [...prev, id];
    });
  };

  const handleQuickSelectCount = (count: number) => {
    if (!batchCandidates) return;
    setStatusNotice(null);
    const limit = Math.min(count, MAX_MULTI_SHARE, batchCandidates.length);
    setSelectedBatchIds(batchCandidates.slice(0, limit).map((c) => c.id));
  };

  const handleNativeShare = async () => {
    if (!hasShareableImages) return;
    setStatusNotice(null);

    if (isMultiMode) {
      const result = await shareMultipleImagesNative(
        multiShareItems,
        `${title} (${toKhmerNum(multiShareItems.length)} រូបភាព)`,
        caption
      );
      if (result === 'shared') {
        setStatusNotice({
          text: `បានបើកផ្ទាំងចែករំលែករូបភាពទាំង ${toKhmerNum(multiShareItems.length)} និងអត្ថបទរួចរាល់!`,
          type: 'success',
        });
      } else if (result === 'unsupported') {
        await copyTextToClipboard(caption);
        setStatusNotice({
          text: hostedShare?.shareUrl
            ? `ផ្ទាំងមើលសាកល្បង (iframe) ឬកុំព្យូទ័រមិនអនុញ្ញាត Share File ច្រើនផ្ទាល់ទេ — បានចម្លងអត្ថបទជូនរួច! សូមចុច "បើកផ្ទាំង Share ក្រៅស៊ុម" ដើម្បីបញ្ជូនរូបភាពទាំង ${toKhmerNum(multiShareItems.length)} ទៅ TikTok/FB លើទូរស័ព្ទ ឬចុច "ទាញយកទាំង ${toKhmerNum(multiShareItems.length)} PNG"។`
            : `កម្មវិធីរុករកមិនគាំទ្រ OS Share ច្រើនរូបភាពផ្ទាល់ទេ — បានចម្លងអត្ថបទជូនរួច! សូមចុច "ទាញយកទាំង ${toKhmerNum(multiShareItems.length)} PNG" ដើម្បីបង្ហោះរួមគ្នា។`,
          type: 'info',
        });
      }
      return;
    }

    const result = await shareImageNative(imageDataUrl, targetFilename, title, caption);
    if (result === 'shared') {
      setStatusNotice({
        text: 'បានបើកផ្ទាំងចែករំលែករូបភាព និងអត្ថបទរួចរាល់!',
        type: 'success',
      });
    } else if (result === 'unsupported') {
      await copyTextToClipboard(caption);
      const imgCopied = await copyImageToClipboard(imageDataUrl);
      setStatusNotice({
        text: imgCopied
          ? 'ផ្ទាំងមើលសាកល្បង (iframe) មិនអនុញ្ញាតឱ្យបើក OS Share ផ្ទាល់ទេ — បានចម្លងរូបភាព + អត្ថបទជូនរួច! លោកអ្នកអាចចុច "បើកផ្ទាំង Share ក្រៅស៊ុម" ដើម្បីបញ្ជូនផ្ទាល់ទៅ TikTok/FB លើទូរស័ព្ទ ឬចុច Facebook / TikTok ខាងក្រោម។'
          : 'កម្មវិធីរុករកលើកុំព្យូទ័រ ឬផ្ទាំងមើលសាកល្បងមិនគាំទ្រ OS Share File ផ្ទាល់ទេ — សូមចុច Facebook / TikTok ខាងក្រោម ឬបើក "ផ្ទាំង Share ក្រៅស៊ុម" នៅលើទូរស័ព្ទ។',
        type: 'info',
      });
    }
  };

  const handleCopyImage = async () => {
    if (!primaryImageDataUrl) return;
    const ok = await copyImageToClipboard(primaryImageDataUrl);
    if (ok) {
      setCopiedImage(true);
      setStatusNotice({
        text: isMultiMode
          ? 'បានចម្លងរូបភាពទី ១ ជោគជ័យ! (សម្រាប់គ្រប់រូបភាព សូមប្រើ "ចែករំលែកផ្ទាល់ទៅ App" ឬ "ទាញយកទាំងអស់")'
          : 'បានចម្លងរូបភាពជោគជ័យ! អ្នកអាចចុច Paste (Ctrl+V) លើ Facebook បានភ្លាមៗ។',
        type: 'success',
      });
      setTimeout(() => setCopiedImage(false), 2500);
    } else {
      downloadImageDataUrl(primaryImageDataUrl, targetFilename);
      setStatusNotice({
        text: 'កម្មវិធីរុករកមិនអនុញ្ញាត Copy រូបភាពផ្ទាល់ទេ — បានទាញយករូបភាព PNG ជូនជំនួសរួចរាល់។',
        type: 'info',
      });
    }
  };

  const handleDownloadImages = async () => {
    if (!hasShareableImages) return;
    if (isMultiMode) {
      await downloadMultipleImagesDataUrls(multiShareItems);
      setStatusNotice({
        text: `បានទាញយករូបភាពទាំង ${toKhmerNum(multiShareItems.length)} PNG ជោគជ័យ!`,
        type: 'success',
      });
      return;
    }
    downloadImageDataUrl(imageDataUrl, targetFilename);
    setStatusNotice({
      text: `បានទាញយករូបភាព ${targetFilename} ជោគជ័យ!`,
      type: 'success',
    });
  };

  const handleCopyCaption = async () => {
    const ok = await copyTextToClipboard(caption);
    if (ok) {
      setCopiedCaption(true);
      setTimeout(() => setCopiedCaption(false), 2000);
    }
  };

  const handleCopyShareLink = async () => {
    if (!hostedShare?.shareUrl) return;
    const ok = await copyTextToClipboard(hostedShare.shareUrl);
    if (ok) {
      setCopiedLink(true);
      setStatusNotice({
        text: isMultiMode
          ? `បានចម្លងតំណភ្ជាប់កម្រងរូបភាព (${toKhmerNum(multiImages.length)} សន្លឹក) + អត្ថបទរួចរាល់!`
          : 'បានចម្លងតំណភ្ជាប់កាតរូបភាព + អត្ថបទរួចរាល់! អាច Paste លើ Facebook ឬ Messenger ដើម្បីបង្ហាញរូបភាពភ្លាមៗ។',
        type: 'success',
      });
      setTimeout(() => setCopiedLink(false), 2500);
    }
  };

  const handlePrepareExternalPost = async (platformName: 'Facebook' | 'TikTok' | 'Telegram') => {
    await copyTextToClipboard(caption);
    if (platformName === 'Facebook') {
      const copiedPng = !isMultiMode && primaryImageDataUrl
        ? await copyImageToClipboard(primaryImageDataUrl)
        : false;
      setStatusNotice({
        text: hostedShare?.shareUrl
          ? 'បានភ្ជាប់ Link រូបភាព + អត្ថបទជូន Facebook Sharer រួចរាល់!'
          : copiedPng
          ? 'បានចម្លងរូបភាព និង Caption រួចរាល់! សូម Paste (Ctrl+V) ក្នុងផុស Facebook របស់អ្នក។'
          : 'បានចម្លង Caption រួចរាល់! សូមទាញយករូបភាព PNG ដើម្បីភ្ជាប់ក្នុងផុស Facebook។',
        type: 'success',
      });
    } else if (platformName === 'TikTok') {
      if (isMultiMode && multiShareItems.length > 0) {
        await downloadMultipleImagesDataUrls(multiShareItems);
        setStatusNotice({
          text: `បានទាញយករូបភាពទាំង ${toKhmerNum(multiShareItems.length)} PNG និងចម្លង Caption រួច! សូមជ្រើសរូបភាពទាំងអស់ក្នុង TikTok Photo Carousel ឬចុច "បើកផ្ទាំង Share ក្រៅស៊ុម" លើទូរស័ព្ទ។`,
          type: 'success',
        });
      } else if (imageDataUrl) {
        downloadImageDataUrl(imageDataUrl, targetFilename);
        setStatusNotice({
          text: 'បានទាញយករូបភាព PNG និងចម្លងអត្ថបទ Caption រួចរាល់! សូមជ្រើសរូបភាពដែលទើបទាញយក ហើយ Paste Caption ក្នុង TikTok (ឬប្រើ "បើកផ្ទាំង Share ក្រៅស៊ុម" លើទូរស័ព្ទ)។',
          type: 'success',
        });
      }
    } else {
      setStatusNotice({
        text: 'បានបើក Telegram Share ជាមួយតំណភ្ជាប់រូបភាព និងអត្ថបទរួចរាល់!',
        type: 'info',
      });
    }
  };

  const fbHref = buildFacebookShareUrl(caption, hostedShare?.shareUrl);
  const tgHref = buildTelegramShareUrl(caption, hostedShare?.shareUrl);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-5 bg-black/65 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="social-share-modal-title"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative khmer-ornate-card w-full max-w-4xl max-h-[92vh] overflow-y-auto rounded-2xl p-5 sm:p-7 shadow-2xl"
      >
        <KhmerCornerMotif position="tl" size={28} />
        <KhmerCornerMotif position="tr" size={28} />
        <KhmerCornerMotif position="bl" size={28} />
        <KhmerCornerMotif position="br" size={28} />

        {/* Header */}
        <div className="flex items-start justify-between gap-3 pb-4 mb-5 border-b app-border">
          <div>
            <h3
              id="social-share-modal-title"
              className="font-moul text-base sm:text-lg app-text-primary flex items-center gap-2"
            >
              <Share2 className="w-5 h-5 khmer-accent-text shrink-0" />
              <span>ចែករំលែករូបភាពទៅបណ្ដាញសង្គម</span>
            </h3>
            <p className="text-xs sm:text-sm app-text-secondary mt-1">
              {title}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="បិទផ្ទាំងចែករំលែក"
            className="w-10 h-10 rounded-xl app-subcard app-text-primary flex items-center justify-center hover:opacity-80 transition cursor-pointer shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Single vs Multi-Image Mode Toggle */}
        {hasBatchSupport && batchCandidates && (
          <div className="grid grid-cols-2 gap-2 p-1.5 rounded-xl app-subcard mb-5">
            <button
              type="button"
              onClick={() => setShareMode('single')}
              className={`min-h-[42px] py-2 px-3 rounded-lg text-xs sm:text-sm font-bold flex items-center justify-center gap-1.5 transition cursor-pointer ${
                shareMode === 'single'
                  ? 'khmer-btn-primary shadow-sm'
                  : 'app-text-secondary hover:app-text-primary'
              }`}
            >
              <ImageIcon className="w-4 h-4 shrink-0" />
              <span>១ រូបភាព</span>
            </button>
            <button
              type="button"
              onClick={() => setShareMode('multi')}
              className={`min-h-[42px] py-2 px-3 rounded-lg text-xs sm:text-sm font-bold flex items-center justify-center gap-1.5 transition cursor-pointer ${
                shareMode === 'multi'
                  ? 'khmer-btn-primary shadow-sm'
                  : 'app-text-secondary hover:app-text-primary'
              }`}
            >
              <Images className="w-4 h-4 shrink-0" />
              <span>ច្រើនរូបភាពក្នុងពេលតែមួយ ({toKhmerNum(batchCandidates.length)})</span>
            </button>
          </div>
        )}

        {/* Two-column layout: Preview / Multi-Selector left, Controls right */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left: Format selector + Candidate checklist (multi) + Live Image Preview */}
          <div className="lg:col-span-6 space-y-3">
            {/* Aspect Format Segmented Control */}
            <div className="grid grid-cols-2 gap-1.5 p-1.5 rounded-xl app-subcard">
              <button
                type="button"
                onClick={() => setFormat('card')}
                className={`py-2 px-3 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition cursor-pointer whitespace-nowrap ${
                  format === 'card'
                    ? 'khmer-btn-primary shadow-sm'
                    : 'app-text-secondary hover:app-text-primary'
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5 shrink-0" />
                <span>កាត Facebook / ទូទៅ</span>
              </button>
              <button
                type="button"
                onClick={() => setFormat('tiktok')}
                className={`py-2 px-3 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition cursor-pointer whitespace-nowrap ${
                  format === 'tiktok'
                    ? 'khmer-btn-primary shadow-sm'
                    : 'app-text-secondary hover:app-text-primary'
                }`}
              >
                <Smartphone className="w-3.5 h-3.5 shrink-0" />
                <span>បញ្ឈរ 9:16 (TikTok)</span>
              </button>
            </div>

            {allowShowAnswerToggle && (
              <label className="flex items-center gap-2.5 p-2.5 rounded-xl app-subcard cursor-pointer select-none text-xs sm:text-sm font-medium app-text-primary">
                <input
                  type="checkbox"
                  checked={showAnswer}
                  onChange={(e) => setShowAnswer(e.target.checked)}
                  className="w-4 h-4 rounded accent-[var(--theme-accent)]"
                />
                <span>បង្ហាញចម្លើយត្រឹមត្រូវនៅលើរូបភាព</span>
              </label>
            )}

            {/* Multi-Image Question Checklist */}
            {isMultiMode && batchCandidates && (
              <div className="rounded-2xl app-subcard p-3 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-bold app-text-primary tabular-nums">
                    ជ្រើសរើសរូបភាព៖ {toKhmerNum(selectedBatchIds.length)} / {toKhmerNum(MAX_MULTI_SHARE)} អតិបរមា
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleQuickSelectCount(5)}
                      className="px-2.5 py-1 rounded-lg app-card text-xs font-semibold app-text-primary hover:opacity-80 cursor-pointer"
                    >
                      ៥ ដំបូង
                    </button>
                    {batchCandidates.length > 5 && (
                      <button
                        type="button"
                        onClick={() => handleQuickSelectCount(10)}
                        className="px-2.5 py-1 rounded-lg app-card text-xs font-semibold app-text-primary hover:opacity-80 cursor-pointer"
                      >
                        ១០ ដំបូង
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setSelectedBatchIds([])}
                      className="px-2.5 py-1 rounded-lg app-card text-xs font-semibold app-text-secondary hover:opacity-80 cursor-pointer"
                    >
                      សម្អាត
                    </button>
                  </div>
                </div>

                <div className="max-h-40 overflow-y-auto space-y-1.5 pr-1">
                  {batchCandidates.map((cand) => {
                    const checked = selectedBatchIds.includes(cand.id);
                    const orderIdx = selectedBatchIds.indexOf(cand.id);
                    return (
                      <button
                        key={cand.id}
                        type="button"
                        onClick={() => handleToggleCandidate(cand.id)}
                        className={`w-full min-h-[40px] px-2.5 py-2 rounded-xl border text-left flex items-start gap-2 transition cursor-pointer ${
                          checked
                            ? 'bg-amber-50/80 dark:bg-amber-950/40 border-[var(--theme-accent)] app-text-primary'
                            : 'app-card border-transparent app-text-secondary hover:opacity-90'
                        }`}
                      >
                        {checked ? (
                          <CheckSquare className="w-4 h-4 khmer-accent-text shrink-0 mt-0.5" />
                        ) : (
                          <Square className="w-4 h-4 app-text-muted shrink-0 mt-0.5" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-bold truncate">
                            {checked ? `[#${toKhmerNum(orderIdx + 1)}] ` : ''}
                            {cand.label}
                          </div>
                          {cand.sublabel && (
                            <div className="text-[11px] app-text-secondary truncate">
                              {cand.sublabel}
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Preview Box */}
            <div className="rounded-2xl app-subcard p-3 flex flex-col items-center justify-center min-h-[240px] max-h-[400px] overflow-hidden">
              {isMultiMode ? (
                selectedBatchIds.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 py-10 text-center app-text-secondary">
                    <Images className="w-8 h-8 app-text-muted" />
                    <p className="text-xs font-semibold">
                      សូមធីកជ្រើសរើសសំណួរខាងលើ ដើម្បីបង្កើតរូបភាពច្រើនសន្លឹកក្នុងពេលតែមួយ
                    </p>
                  </div>
                ) : isRendering && multiImages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2.5 py-12 app-text-secondary">
                    <RefreshCw className="w-7 h-7 animate-spin khmer-accent-text" />
                    <span className="text-xs font-semibold tabular-nums">
                      កំពុងបង្កើតរូបភាព {toKhmerNum(renderProgress.done)} / {toKhmerNum(renderProgress.total)}...
                    </span>
                  </div>
                ) : renderError ? (
                  <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                    <ImageIcon className="w-8 h-8 app-text-muted" />
                    <p className="text-xs font-semibold text-red-600 dark:text-red-400">{renderError}</p>
                  </div>
                ) : (
                  <div className="w-full space-y-2">
                    {isRendering && (
                      <div className="flex items-center justify-center gap-2 text-xs font-semibold app-text-secondary py-1">
                        <RefreshCw className="w-3.5 h-3.5 animate-spin khmer-accent-text" />
                        <span className="tabular-nums">
                          កំពុងបង្កើតរូបភាព {toKhmerNum(renderProgress.done)} / {toKhmerNum(renderProgress.total)}...
                        </span>
                      </div>
                    )}
                    <div className="w-full max-h-[340px] overflow-y-auto grid grid-cols-2 sm:grid-cols-3 gap-2.5 pr-1">
                      {multiImages.map((img, idx) => (
                        <div
                          key={img.id}
                          className="relative rounded-xl app-card p-1.5 flex flex-col gap-1 border app-border"
                        >
                          <button
                            type="button"
                            onClick={() => handleToggleCandidate(img.id)}
                            aria-label={`ដក ${img.label}`}
                            className="absolute top-2 right-2 w-6 h-6 rounded-full bg-black/65 text-white flex items-center justify-center hover:bg-black cursor-pointer z-10"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                          <img
                            src={img.dataUrl}
                            alt={img.label}
                            referrerPolicy="no-referrer"
                            className="w-full h-32 object-contain rounded-lg bg-stone-100/50 dark:bg-stone-900/50"
                          />
                          <div className="text-[11px] font-bold app-text-primary truncate px-1">
                            {toKhmerNum(idx + 1)}. {img.label}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              ) : isRendering ? (
                <div className="flex flex-col items-center justify-center gap-2.5 py-12 app-text-secondary">
                  <RefreshCw className="w-7 h-7 animate-spin khmer-accent-text" />
                  <span className="text-xs font-semibold">កំពុងបង្កើតរូបភាពគុណភាពខ្ពស់...</span>
                </div>
              ) : renderError ? (
                <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                  <ImageIcon className="w-8 h-8 app-text-muted" />
                  <p className="text-xs font-semibold text-red-600 dark:text-red-400">{renderError}</p>
                </div>
              ) : imageDataUrl ? (
                <img
                  src={imageDataUrl}
                  alt={title}
                  referrerPolicy="no-referrer"
                  className={`rounded-xl shadow-md object-contain ${
                    format === 'tiktok' ? 'max-h-[365px] w-auto' : 'w-full max-h-[350px]'
                  }`}
                />
              ) : null}
            </div>
          </div>

          {/* Right: Share Actions, Caption, Platform Links */}
          <div className="lg:col-span-6 space-y-4">
            {/* Primary Direct Actions */}
            <div className="space-y-2.5">
              <button
                type="button"
                onClick={handleNativeShare}
                disabled={isRendering || !hasShareableImages}
                className="w-full min-h-[46px] py-3 px-4 rounded-xl khmer-btn-primary font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
              >
                <Share2 className="w-4 h-4 shrink-0" />
                <span>
                  {isMultiMode
                    ? `ចែករំលែកផ្ទាល់ទៅ App (${toKhmerNum(multiImages.length)} រូបភាព + អត្ថបទ)`
                    : 'ចែករំលែកផ្ទាល់ទៅ App (រូបភាព + អត្ថបទ)'}
                </span>
              </button>

              {hostedShare?.shareUrl && (
                <a
                  href={hostedShare.shareUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full min-h-[42px] py-2.5 px-3 rounded-xl app-subcard app-text-primary hover:opacity-85 font-semibold text-xs flex items-center justify-center gap-1.5 transition"
                >
                  <ExternalLink className="w-3.5 h-3.5 khmer-accent-text shrink-0" />
                  <span>
                    {isMultiMode && multiImages.length > 1
                      ? `បើកផ្ទាំង Share ក្រៅស៊ុម (បញ្ជូន ${toKhmerNum(multiImages.length)} រូបភាពលើទូរស័ព្ទទៅ TikTok/FB)`
                      : 'បើកផ្ទាំង Share ក្រៅស៊ុម (បញ្ជូនផ្ទាល់លើទូរស័ព្ទទៅ TikTok/FB)'}
                  </span>
                </a>
              )}

              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={handleCopyImage}
                  disabled={isRendering || !primaryImageDataUrl}
                  className="min-h-[42px] py-2.5 px-3 rounded-xl app-subcard app-text-primary hover:opacity-85 font-semibold text-xs sm:text-sm flex items-center justify-center gap-1.5 transition disabled:opacity-50 cursor-pointer whitespace-nowrap"
                >
                  {copiedImage ? (
                    <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  ) : (
                    <Copy className="w-4 h-4 khmer-gold-text shrink-0" />
                  )}
                  <span>
                    {copiedImage
                      ? 'បានចម្លងរូប'
                      : isMultiMode
                      ? 'ចម្លងរូបទី ១'
                      : 'ចម្លងរូបភាព'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={handleDownloadImages}
                  disabled={isRendering || !hasShareableImages}
                  className="min-h-[42px] py-2.5 px-3 rounded-xl app-subcard app-text-primary hover:opacity-85 font-semibold text-xs sm:text-sm flex items-center justify-center gap-1.5 transition disabled:opacity-50 cursor-pointer whitespace-nowrap"
                >
                  <Download className="w-4 h-4 khmer-accent-text shrink-0" />
                  <span>
                    {isMultiMode
                      ? `ទាញយកទាំង ${toKhmerNum(multiImages.length)} PNG`
                      : 'ទាញយក PNG'}
                  </span>
                </button>
              </div>
            </div>

            {/* Caption Editor */}
            <div>
              <div className="flex items-center justify-between mb-1.5 gap-2">
                <label className="text-xs sm:text-sm font-bold app-text-primary">
                  អត្ថបទ Caption សម្រាប់បង្ហោះ
                </label>
                <div className="flex items-center gap-3">
                  {captionManuallyEdited && (
                    <button
                      type="button"
                      onClick={() => setCaptionManuallyEdited(false)}
                      className="text-xs font-semibold app-text-secondary hover:underline cursor-pointer"
                    >
                      ស្ដារដើម
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleCopyCaption}
                    className="text-xs font-semibold khmer-accent-text hover:underline flex items-center gap-1 cursor-pointer"
                  >
                    {copiedCaption ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedCaption ? 'បានចម្លងអត្ថបទ' : 'ចម្លងអត្ថបទ'}</span>
                  </button>
                </div>
              </div>
              <textarea
                value={caption}
                onChange={(e) => {
                  setCaptionManuallyEdited(true);
                  setCaption(e.target.value);
                }}
                rows={4}
                className="w-full px-3.5 py-2.5 rounded-xl app-input text-xs sm:text-sm leading-relaxed resize-none"
              />
            </div>

            {/* Direct Platform Shortcuts (Carrying hosted card link + image(s) + caption) */}
            <div>
              <div className="flex items-center justify-between mb-2 gap-2">
                <p className="text-xs font-bold app-text-secondary">
                  បើកកម្មវិធីបណ្ដាញសង្គម (ភ្ជាប់ទាំងរូបភាព + អត្ថបទ)៖
                </p>
                {hostedShare?.shareUrl && (
                  <button
                    type="button"
                    onClick={handleCopyShareLink}
                    className="text-xs font-semibold khmer-gold-text hover:underline flex items-center gap-1 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    {copiedLink ? <Check className="w-3 h-3" /> : <Link2 className="w-3 h-3" />}
                    <span>{copiedLink ? 'បានចម្លង Link' : 'ចម្លង Link កាត'}</span>
                  </button>
                )}
              </div>

              <div className="grid grid-cols-3 gap-2">
                <a
                  href={fbHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => handlePrepareExternalPost('Facebook')}
                  aria-disabled={isRendering || isPublishingHost}
                  className="min-h-[42px] py-2.5 px-3 rounded-xl bg-[#1877F2] hover:bg-[#166FE5] text-white font-bold text-xs flex items-center justify-center gap-1.5 transition whitespace-nowrap"
                >
                  <span>Facebook</span>
                  <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                </a>

                <a
                  href={TIKTOK_UPLOAD_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => handlePrepareExternalPost('TikTok')}
                  className="min-h-[42px] py-2.5 px-3 rounded-xl bg-stone-900 hover:bg-black text-white font-bold text-xs flex items-center justify-center gap-1.5 transition whitespace-nowrap"
                >
                  <span>TikTok</span>
                  <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                </a>

                <a
                  href={tgHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => handlePrepareExternalPost('Telegram')}
                  className="min-h-[42px] py-2.5 px-3 rounded-xl bg-[#0088cc] hover:bg-[#0077b3] text-white font-bold text-xs flex items-center justify-center gap-1.5 transition whitespace-nowrap"
                >
                  <span>Telegram</span>
                  <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                </a>
              </div>
            </div>

            {statusNotice && (
              <div
                className={`p-3 rounded-xl border text-xs leading-relaxed font-medium ${
                  statusNotice.type === 'success'
                    ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-300 dark:border-emerald-700 text-emerald-900 dark:text-emerald-200'
                    : statusNotice.type === 'error'
                    ? 'bg-red-50 dark:bg-red-950/60 border-red-300 dark:border-red-700 text-red-900 dark:text-red-200'
                    : 'bg-amber-50 dark:bg-amber-950/60 border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-200'
                }`}
              >
                {statusNotice.text}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
