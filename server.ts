import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

async function safeTelegramJson(res: Response): Promise<any> {
  const raw = await res.text();
  if (!raw) return { ok: false, description: `Empty response (HTTP ${res.status})` };
  try {
    return JSON.parse(raw);
  } catch {
    return { ok: false, description: `HTTP ${res.status}: ${raw.slice(0, 140)}` };
  }
}

app.use(express.json({ limit: '35mb' }));
app.use(express.urlencoded({ extended: true, limit: '35mb' }));

interface StoredShareImage {
  buffer: Buffer;
  mimeType: string;
}

interface StoredShareCard {
  id: string;
  images: StoredShareImage[];
  title: string;
  caption: string;
  format: 'card' | 'tiktok';
  createdAt: number;
}

const SHARE_CARD_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_STORED_SHARE_CARDS = 120;
const MAX_IMAGES_PER_SHARE_CARD = 10;
const sharedCardsStore = new Map<string, StoredShareCard>();

function pruneSharedCards() {
  const now = Date.now();
  for (const [id, entry] of sharedCardsStore.entries()) {
    if (now - entry.createdAt > SHARE_CARD_TTL_MS) {
      sharedCardsStore.delete(id);
    }
  }
  while (sharedCardsStore.size > MAX_STORED_SHARE_CARDS) {
    const oldestKey = sharedCardsStore.keys().next().value;
    if (!oldestKey) break;
    sharedCardsStore.delete(oldestKey);
  }
}

function parseShareImageDataUrl(raw: unknown): StoredShareImage | null {
  if (!raw || typeof raw !== 'string') return null;
  const matches = raw.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!matches || matches.length !== 3) return null;
  const mimeType = matches[1] === 'image/jpg' ? 'image/jpeg' : matches[1];
  const buffer = Buffer.from(matches[2], 'base64');
  if (buffer.length === 0 || buffer.length > 12 * 1024 * 1024) return null;
  return { buffer, mimeType };
}

function escapeServerHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeInlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function getBaseOrigin(req: express.Request): string {
  const forwardedHost = req.headers['x-forwarded-host'];
  const host = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost || req.get('host');
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) || req.protocol || 'https';
  if (host) {
    return `${proto.split(',')[0].trim()}://${host.split(',')[0].trim()}`;
  }
  if (process.env.APP_URL && process.env.APP_URL !== 'MY_APP_URL') {
    return process.env.APP_URL.replace(/\/+$/, '');
  }
  return `http://localhost:${PORT}`;
}

// Endpoint: Publish temporary share card image(s) & metadata for Facebook Open Graph & mobile multi-image share handoff
app.post('/api/share-card', (req, res) => {
  try {
    const { imageBase64, extraImagesBase64, imagesBase64, title, caption, format } = req.body || {};
    const rawInputs: unknown[] = Array.isArray(imagesBase64) && imagesBase64.length > 0
      ? imagesBase64
      : [
          ...(typeof imageBase64 === 'string' ? [imageBase64] : []),
          ...(Array.isArray(extraImagesBase64) ? extraImagesBase64 : []),
        ];

    if (rawInputs.length === 0) {
      return res.status(400).json({ success: false, error: 'Missing imageBase64' });
    }
    if (rawInputs.length > MAX_IMAGES_PER_SHARE_CARD) {
      return res.status(400).json({
        success: false,
        error: `Too many images (max ${MAX_IMAGES_PER_SHARE_CARD})`,
      });
    }

    const parsedImages: StoredShareImage[] = [];
    let totalBytes = 0;
    for (const rawImg of rawInputs) {
      const parsed = parseShareImageDataUrl(rawImg);
      if (!parsed) {
        return res.status(400).json({ success: false, error: 'Invalid or oversized image data URL' });
      }
      totalBytes += parsed.buffer.length;
      if (totalBytes > 32 * 1024 * 1024) {
        return res.status(413).json({ success: false, error: 'Total images payload too large' });
      }
      parsedImages.push(parsed);
    }

    pruneSharedCards();

    const id = crypto.randomBytes(6).toString('base64url');
    const safeFormat: 'card' | 'tiktok' = format === 'tiktok' ? 'tiktok' : 'card';

    sharedCardsStore.set(id, {
      id,
      images: parsedImages,
      title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 180) : 'Master Quiz KH',
      caption: typeof caption === 'string' ? caption.trim().slice(0, 3600) : '',
      format: safeFormat,
      createdAt: Date.now(),
    });

    const origin = getBaseOrigin(req);
    const sharePath = `/s/${id}`;
    const imagePath = `/api/share-card/${id}.png`;
    const imagePaths = parsedImages.map((_, idx) => `/api/share-card/${id}/${idx}.png`);
    const imageUrls = imagePaths.map((p) => `${origin}${p}`);

    res.json({
      success: true,
      id,
      sharePath,
      imagePath,
      imagePaths,
      shareUrl: `${origin}${sharePath}`,
      imageUrl: `${origin}${imagePath}`,
      imageUrls,
      imageCount: parsedImages.length,
    });
  } catch (err: any) {
    console.error('Error storing share card:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint: Update caption on an existing temporary share card
app.put('/api/share-card/:id', (req, res) => {
  const { id } = req.params;
  if (!/^[a-zA-Z0-9_-]{4,32}$/.test(id)) {
    return res.status(400).json({ success: false, error: 'Invalid ID' });
  }
  const entry = sharedCardsStore.get(id);
  if (!entry) {
    return res.status(404).json({ success: false, error: 'Share card not found' });
  }
  const { caption } = req.body || {};
  if (typeof caption === 'string') {
    entry.caption = caption.trim().slice(0, 3600);
  }
  res.json({ success: true });
});

// Endpoint: Serve primary PNG image for Open Graph crawlers & direct download
app.get('/api/share-card/:id.png', (req, res) => {
  const { id } = req.params;
  if (!/^[a-zA-Z0-9_-]{4,32}$/.test(id)) {
    return res.status(400).send('Invalid ID');
  }
  pruneSharedCards();
  const entry = sharedCardsStore.get(id);
  if (!entry || entry.images.length === 0) {
    return res.status(404).send('Share card expired or not found');
  }
  res.setHeader('Content-Type', entry.images[0].mimeType);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(entry.images[0].buffer);
});

// Endpoint: Serve indexed PNG image from multi-image share card
app.get('/api/share-card/:id/:idx.png', (req, res) => {
  const { id, idx } = req.params;
  if (!/^[a-zA-Z0-9_-]{4,32}$/.test(id) || !/^\d{1,2}$/.test(idx)) {
    return res.status(400).send('Invalid parameters');
  }
  const indexNum = Number(idx);
  pruneSharedCards();
  const entry = sharedCardsStore.get(id);
  if (!entry || indexNum < 0 || indexNum >= entry.images.length) {
    return res.status(404).send('Share image expired or not found');
  }
  const target = entry.images[indexNum];
  res.setHeader('Content-Type', target.mimeType);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(target.buffer);
});

// Endpoint: Standalone Open Graph Share Page (enables Facebook link preview + top-level native mobile Share to TikTok/FB with single or multiple images)
app.get('/s/:id', (req, res) => {
  const { id } = req.params;
  if (!/^[a-zA-Z0-9_-]{4,32}$/.test(id)) {
    return res.status(400).send('Invalid share link');
  }
  pruneSharedCards();
  const entry = sharedCardsStore.get(id);
  if (!entry || entry.images.length === 0) {
    return res.status(404).send(`<!DOCTYPE html>
<html lang="km">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Master Quiz KH</title></head>
<body style="font-family:sans-serif;background:#f7f2e6;color:#1c1917;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;text-align:center;">
  <div style="background:#fffdf8;border:2px solid #b45309;border-radius:18px;padding:32px;max-width:460px;">
    <h1 style="color:#9a3412;margin-top:0;">តំណភ្ជាប់រូបភាពផុតកំណត់</h1>
    <p>សូមចូលទៅកាន់កម្មវិធី Master Quiz KH ដើម្បីបង្កើតរូបភាពសំណួរ ឬលទ្ធផលថ្មី។</p>
    <a href="/" style="display:inline-block;margin-top:12px;padding:10px 20px;background:#9a3412;color:#fff;text-decoration:none;border-radius:10px;font-weight:bold;">បើក Master Quiz KH</a>
  </div>
</body></html>`);
  }

  const origin = getBaseOrigin(req);
  const shareUrl = `${origin}/s/${entry.id}`;
  const imageUrls = entry.images.map((_, idx) => `${origin}/api/share-card/${entry.id}/${idx}.png`);
  const primaryImageUrl = imageUrls[0];
  const isMulti = imageUrls.length > 1;
  const safeTitle = escapeServerHtml(entry.title);
  const plainDesc = (entry.caption || 'ប្រព័ន្ធត្រៀមប្រឡងក្របខ័ណ្ឌរដ្ឋកម្ពុជា — @qiuzs_bot').replace(/\s+/g, ' ').slice(0, 260);
  const safeDesc = escapeServerHtml(plainDesc);
  const safeFullCaption = escapeServerHtml(entry.caption || '');
  const imgWidth = entry.format === 'tiktok' ? '1440' : '1560';
  const imgHeight = entry.format === 'tiktok' ? '2560' : '1100';
  const fbShareHref = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}&quote=${encodeURIComponent(entry.caption || entry.title)}`;

  const ogImageTags = imageUrls
    .map(
      (url, i) => `  <meta property="og:image" content="${escapeServerHtml(url)}" />
  <meta property="og:image:type" content="${escapeServerHtml(entry.images[i].mimeType)}" />
  <meta property="og:image:width" content="${imgWidth}" />
  <meta property="og:image:height" content="${imgHeight}" />`
    )
    .join('\n');

  const galleryHtml = isMulti
    ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px;background:#efe7d5;border-radius:14px;padding:12px;margin-bottom:18px;">
        ${imageUrls
          .map(
            (url, i) => `<div style="position:relative;background:#fffdf8;border:1px solid #d5c5a3;border-radius:10px;padding:6px;text-align:center;">
              <img src="${escapeServerHtml(url)}" alt="${safeTitle} (${i + 1})" style="width:100%;max-height:240px;object-fit:contain;border-radius:8px;display:block;margin:0 auto;" />
              <div style="margin-top:6px;font-size:11px;font-weight:700;color:#78350f;">រូបភាពទី ${i + 1} / ${imageUrls.length}</div>
            </div>`
          )
          .join('')}
      </div>`
    : `<div style="background:#efe7d5;border-radius:14px;padding:12px;text-align:center;margin-bottom:18px;">
        <img src="${escapeServerHtml(primaryImageUrl)}" alt="${safeTitle}" style="max-width:100%;max-height:540px;border-radius:10px;box-shadow:0 4px 12px rgba(0,0,0,0.12);" />
      </div>`;

  const shareBtnText = isMulti
    ? `📤 ចែករំលែកផ្ទាល់ (${imageUrls.length} រូបភាព + អត្ថបទ ទៅ TikTok / Facebook)`
    : `📤 ចែករំលែកផ្ទាល់ (រូបភាព + អត្ថបទ ទៅ TikTok / Facebook)`;

  const downloadBtnText = isMulti
    ? `⬇️ ទាញយករូបភាពទាំង ${imageUrls.length} PNG`
    : `⬇️ ទាញយករូបភាព PNG`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="km">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle} — Master Quiz KH</title>
  <meta name="description" content="${safeDesc}" />
  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="Master Quiz KH" />
  <meta property="og:url" content="${escapeServerHtml(shareUrl)}" />
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeDesc}" />
${ogImageTags}
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${safeTitle}" />
  <meta name="twitter:description" content="${safeDesc}" />
  <meta name="twitter:image" content="${escapeServerHtml(primaryImageUrl)}" />
  <link href="https://fonts.googleapis.com/css2?family=Kantumruy+Pro:wght@500;700&family=Moul&display=swap" rel="stylesheet">
</head>
<body style="margin:0;background:#f7f2e6;color:#1c1917;font-family:'Kantumruy Pro',sans-serif;padding:24px 16px;">
  <main style="max-width:680px;margin:0 auto;background:#fffdf8;border:2px solid #b45309;border-radius:20px;padding:24px;box-shadow:0 12px 32px rgba(154,52,18,0.12);">
    <div style="text-align:center;margin-bottom:16px;">
      <div style="font-family:'Moul',serif;font-size:18px;color:#9a3412;">MASTER QUIZ KH</div>
      <h1 style="font-size:16px;margin:6px 0 0;color:#44403c;">${safeTitle}</h1>
    </div>

    ${galleryHtml}

    <div style="display:grid;grid-template-columns:1fr;gap:10px;margin-bottom:16px;">
      <button id="nativeShareBtn" type="button" style="padding:13px 18px;border:none;border-radius:12px;background:#9a3412;color:#fff;font-family:inherit;font-size:15px;font-weight:700;cursor:pointer;">
        ${shareBtnText}
      </button>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <a href="${escapeServerHtml(fbShareHref)}" target="_blank" rel="noopener noreferrer" style="padding:11px 14px;border-radius:12px;background:#1877F2;color:#fff;text-decoration:none;font-size:13px;font-weight:700;text-align:center;">
          បង្ហោះលើ Facebook
        </a>
        <a href="https://www.tiktok.com/upload" target="_blank" rel="noopener noreferrer" id="tiktokLink" style="padding:11px 14px;border-radius:12px;background:#1c1917;color:#fff;text-decoration:none;font-size:13px;font-weight:700;text-align:center;">
          បង្ហោះលើ TikTok
        </a>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <button id="downloadAllBtn" type="button" style="padding:10px 14px;border-radius:12px;background:#efe7d5;color:#1c1917;border:1px solid #d5c5a3;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;">
          ${downloadBtnText}
        </button>
        <button id="copyCaptionBtn" type="button" style="padding:10px 14px;border-radius:12px;background:#efe7d5;color:#1c1917;border:1px solid #d5c5a3;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;">
          📋 ចម្លងអត្ថបទ Caption
        </button>
      </div>
    </div>

    <div id="statusMsg" style="display:none;margin-bottom:14px;padding:10px 14px;border-radius:10px;background:#fef3c7;border:1px solid #d5c5a3;font-size:13px;color:#78350f;"></div>

    <pre id="captionText" style="white-space:pre-wrap;font-family:inherit;font-size:13px;line-height:1.65;background:#faf5e8;border:1px solid #d5c5a3;border-radius:12px;padding:12px;margin:0 0 16px;">${safeFullCaption}</pre>

    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;font-size:13px;border-top:1px solid #d5c5a3;padding-top:12px;">
      <a href="/" style="color:#9a3412;font-weight:700;text-decoration:none;">← ចូលលេងតេស្តលើ Master Quiz KH</a>
      <a href="https://t.me/qiuzs_bot" target="_blank" rel="noopener noreferrer" style="color:#0088cc;font-weight:700;text-decoration:none;">🤖 Telegram Bot @qiuzs_bot</a>
    </div>
  </main>
  <script>
    (function(){
      var imgUrls = ${safeInlineJson(imageUrls)};
      var shareId = ${safeInlineJson(entry.id)};
      var shareTitle = ${safeInlineJson(entry.title)};
      var captionText = ${safeInlineJson(entry.caption || '')};
      var statusEl = document.getElementById('statusMsg');
      function showStatus(msg) {
        statusEl.textContent = msg;
        statusEl.style.display = 'block';
      }
      function triggerDownloads() {
        imgUrls.forEach(function(url, idx) {
          setTimeout(function() {
            var a = document.createElement('a');
            a.href = url;
            a.download = imgUrls.length > 1
              ? ('MasterQuiz_' + shareId + '_' + (idx + 1) + '.png')
              : ('MasterQuiz_' + shareId + '.png');
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          }, idx * 240);
        });
      }
      document.getElementById('downloadAllBtn').addEventListener('click', function() {
        triggerDownloads();
        showStatus('កំពុងទាញយករូបភាពចំនួន ' + imgUrls.length + ' PNG...');
      });
      document.getElementById('copyCaptionBtn').addEventListener('click', function() {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(captionText).then(function(){
            showStatus('បានចម្លងអត្ថបទ Caption រួចរាល់!');
          });
        }
      });
      document.getElementById('tiktokLink').addEventListener('click', function() {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(captionText).catch(function(){});
        }
        triggerDownloads();
      });
      document.getElementById('nativeShareBtn').addEventListener('click', async function() {
        try {
          var files = await Promise.all(imgUrls.map(async function(url, idx) {
            var resp = await fetch(url);
            var blob = await resp.blob();
            var name = imgUrls.length > 1
              ? ('MasterQuizKH_' + (idx + 1) + '.png')
              : 'MasterQuizKH.png';
            return new File([blob], name, { type: blob.type || 'image/png' });
          }));
          if (navigator.share && navigator.canShare && navigator.canShare({ files: files })) {
            await navigator.share({ files: files, title: shareTitle, text: captionText });
            showStatus('បានចែករំលែករូបភាពចំនួន ' + files.length + ' និងអត្ថបទរួចរាល់!');
            return;
          }
        } catch (err) {
          if (err && err.name === 'AbortError') return;
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(captionText).catch(function(){});
        }
        showStatus('កម្មវិធីរុករកលើកុំព្យូទ័រមិនអនុញ្ញាត Share File ផ្ទាល់ទេ — សូមចុច "ទាញយករូបភាព PNG" ឬ "បង្ហោះលើ Facebook / TikTok" ខាងក្រោម!');
      });
    })();
  </script>
</body>
</html>`);
});

function normalizeServerTelegramChatId(raw: unknown): string {
  const trimmed = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
  if (!trimmed) return '';
  const urlMatch = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{3,})(?:[/?#].*)?$/i
  );
  if (urlMatch && urlMatch[1]) {
    const slug = urlMatch[1];
    if (!['joinchat', 'c', 's', 'addstickers', 'addtheme', 'proxy', 'socks'].includes(slug.toLowerCase())) {
      return `@${slug}`;
    }
  }
  return trimmed;
}

// Endpoint: Send Quiz Poll to Telegram Bot
app.post('/api/telegram/send-poll', async (req, res) => {
  try {
    const {
      botToken,
      chatId,
      question,
      options,
      correct_option_id,
      explanation,
      explanation_parse_mode,
      is_anonymous,
    } = req.body;
    const resolvedToken = resolveServerBotToken(botToken);
    const cleanChatId = normalizeServerTelegramChatId(chatId);
    if (!resolvedToken || !cleanChatId || !question || !options) {
      return res.status(400).json({ success: false, error: 'Missing required parameters' });
    }

    const payload: any = {
      chat_id: cleanChatId,
      question: question.length > 300 ? question.slice(0, 297) + '...' : question,
      options: options.slice(0, 10).map((opt: string) => (opt.length > 100 ? opt.slice(0, 97) + '...' : opt)),
      type: 'quiz',
      correct_option_id: typeof correct_option_id === 'number' ? correct_option_id : 0,
      is_anonymous: is_anonymous === false ? false : true,
    };

    if (explanation) {
      if (explanation_parse_mode) {
        payload.explanation = explanation;
        payload.explanation_parse_mode = explanation_parse_mode;
      } else {
        payload.explanation = explanation.length > 200 ? explanation.slice(0, 197) + '...' : explanation;
      }
    }

    const tgRes = await fetch(`https://api.telegram.org/bot${resolvedToken}/sendPoll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await safeTelegramJson(tgRes);
    if (!tgRes.ok || !data.ok) {
      // Fallback: if HTML explanation fails parsing or exceeds 200 chars, strip HTML tags & truncate cleanly
      if (
        payload.explanation_parse_mode &&
        data.description &&
        (data.description.includes("can't parse entities") ||
          data.description.includes('EXPLANATION') ||
          data.description.includes('too long'))
      ) {
        const plainExp = String(explanation).replace(/<[^>]+>/g, '');
        const fallbackPayload = {
          ...payload,
          explanation: plainExp.length > 200 ? plainExp.slice(0, 197) + '...' : plainExp,
        };
        delete fallbackPayload.explanation_parse_mode;

        const retryRes = await fetch(`https://api.telegram.org/bot${resolvedToken}/sendPoll`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fallbackPayload),
        });
        const retryData = await safeTelegramJson(retryRes);
        if (retryRes.ok && retryData.ok) {
          return res.json({ success: true, result: retryData.result });
        }
      }

      return res.status(tgRes.status === 429 ? 429 : 400).json({
        success: false,
        error: data.description || 'Telegram API error',
        retry_after: data.parameters?.retry_after,
      });
    }

    res.json({ success: true, result: data.result });
  } catch (err: any) {
    console.error('Error sending Telegram poll:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint: Send Formatted Message to Telegram Channel or Group
app.post('/api/telegram/send-message', async (req, res) => {
  try {
    const { botToken, chatId, text, parse_mode } = req.body;
    const resolvedToken = resolveServerBotToken(botToken);
    const cleanChatId = normalizeServerTelegramChatId(chatId);
    if (!resolvedToken || !cleanChatId || !text) {
      return res.status(400).json({ success: false, error: 'Missing required parameters (botToken, chatId, text)' });
    }

    const payload: any = {
      chat_id: cleanChatId,
      text: text,
      disable_web_page_preview: true,
    };
    if (parse_mode) {
      payload.parse_mode = parse_mode;
    }

    const tgRes = await fetch(`https://api.telegram.org/bot${resolvedToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await safeTelegramJson(tgRes);
    if (!tgRes.ok || !data.ok) {
      // If HTML parsing failed, attempt plain text fallback
      if (payload.parse_mode && data.description && data.description.includes('can\'t parse entities')) {
        delete payload.parse_mode;
        const retryRes = await fetch(`https://api.telegram.org/bot${resolvedToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const retryData = await safeTelegramJson(retryRes);
        if (retryRes.ok && retryData.ok) {
          return res.json({ success: true, result: retryData.result });
        }
      }
      return res.status(tgRes.status === 429 ? 429 : 400).json({
        success: false,
        error: data.description || 'Telegram API error',
        retry_after: data.parameters?.retry_after,
      });
    }

    res.json({ success: true, result: data.result });
  } catch (err: any) {
    console.error('Error sending Telegram message:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint: Send Photo to Telegram Channel
app.post('/api/telegram/send-photo', async (req, res) => {
  try {
    const { botToken, chatId, photoBase64, caption, parse_mode, reply_markup } = req.body;
    const resolvedToken = resolveServerBotToken(botToken);
    const cleanChatId = normalizeServerTelegramChatId(chatId);
    if (!resolvedToken || !cleanChatId || !photoBase64) {
      return res.status(400).json({ success: false, error: 'Missing parameters' });
    }

    // Convert data URL to Blob / FormData
    const matches = photoBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      return res.status(400).json({ success: false, error: 'Invalid base64 photo' });
    }

    const mimeType = matches[1] || 'image/png';
    const ext = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : 'png';
    const buffer = Buffer.from(matches[2], 'base64');
    const serializedMarkup = reply_markup
      ? typeof reply_markup === 'string'
        ? reply_markup
        : JSON.stringify(reply_markup)
      : undefined;

    const buildMultipartBody = (cap?: string, mode?: string) => {
      const b = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
      const chunks: Buffer[] = [];
      const addFld = (name: string, value: string) => {
        chunks.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
      };
      addFld('chat_id', cleanChatId);
      if (cap) {
        const finalCap = !mode && cap.length > 1024 ? cap.slice(0, 1020) + '...' : cap;
        addFld('caption', finalCap);
        if (mode) {
          addFld('parse_mode', mode);
        }
      }
      if (serializedMarkup) {
        addFld('reply_markup', serializedMarkup);
      }
      chunks.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="photo"; filename="quiz_card.${ext}"\r\nContent-Type: ${mimeType}\r\n\r\n`));
      chunks.push(buffer);
      chunks.push(Buffer.from(`\r\n--${b}--\r\n`));
      return { boundary: b, totalBuffer: Buffer.concat(chunks) };
    };

    const firstBody = buildMultipartBody(caption, parse_mode);
    const tgRes = await fetch(`https://api.telegram.org/bot${resolvedToken}/sendPhoto`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${firstBody.boundary}`,
      },
      body: firstBody.totalBuffer,
    });

    const data = await safeTelegramJson(tgRes);
    if (!tgRes.ok || !data.ok) {
      if (parse_mode && data.description && data.description.includes("can't parse entities") && caption) {
        const plainCaption = caption.replace(/<[^>]+>/g, '');
        const fallbackBody = buildMultipartBody(plainCaption, undefined);
        const retryRes = await fetch(`https://api.telegram.org/bot${resolvedToken}/sendPhoto`, {
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${fallbackBody.boundary}`,
          },
          body: fallbackBody.totalBuffer,
        });
        const retryData = await safeTelegramJson(retryRes);
        if (retryRes.ok && retryData.ok) {
          return res.json({ success: true, result: retryData.result });
        }
      }
      return res.status(tgRes.status === 429 ? 429 : 400).json({
        success: false,
        error: data.description || 'Telegram API photo error',
        retry_after: data.parameters?.retry_after,
      });
    }

    res.json({ success: true, result: data.result });
  } catch (err: any) {
    console.error('Error sending Telegram photo:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================================
// TELEGRAM COMMAND BOT ENGINE (/start, /register, /passcode, /payment, /contact, /help)
// =========================================================================
const TELEGRAM_BOT_COMMANDS = [
  { command: 'start', description: 'ចាប់ផ្ដើម និងបើកមឺនុយណែនាំប្រើប្រាស់កម្មវិធី' },
  { command: 'register', description: 'ណែនាំជំហានចុះឈ្មោះប្រើប្រាស់ Master Quiz KH' },
  { command: 'passcode', description: 'របៀបស្នើសុំលេខសម្ងាត់សមាជិកពី Admin' },
  { command: 'payment', description: 'ណែនាំការបង់ប្រាក់ KHQR ប្រើប្រាស់ពេញមួយជីវិត' },
  { command: 'contact', description: 'ទំនាក់ទំនង Admin និងចូលក្រុម Telegram' },
  { command: 'help', description: 'បង្ហាញបញ្ជី Command ទាំងអស់របស់ Bot' },
];

interface ServerBotActionButton {
  label: string;
  type: 'command' | 'url' | 'open_member_login';
  value: string;
}

interface ServerBotCommandTemplate {
  command: string;
  descriptionKh?: string;
  title: string;
  body: string;
  imageUrl?: string;
  actions?: ServerBotActionButton[];
}

const BOT_COMMANDS_FILE = path.resolve(__dirname, '.tg_bot_commands.json');

function loadCustomBotTemplates(): Record<string, ServerBotCommandTemplate> {
  try {
    if (!fs.existsSync(BOT_COMMANDS_FILE)) return {};
    const raw = fs.readFileSync(BOT_COMMANDS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveCustomBotTemplates(templates: Record<string, ServerBotCommandTemplate>) {
  try {
    fs.writeFileSync(BOT_COMMANDS_FILE, JSON.stringify(templates, null, 2), { mode: 0o600 });
  } catch {
    // Ignore filesystem errors
  }
}

function getEffectiveTelegramBotCommands() {
  const custom = loadCustomBotTemplates();
  return TELEGRAM_BOT_COMMANDS.map((c) => {
    const ov = custom[`/${c.command}`];
    const desc = ov?.descriptionKh?.trim();
    return {
      command: c.command,
      description: desc ? desc.slice(0, 250) : c.description,
    };
  });
}

interface BotWorkerState {
  isRunning: boolean;
  botToken: string;
  botUsername: string;
  appUrl: string;
  offset: number;
  commandsRegistered: boolean;
  handledCount: number;
  lastCommandAt: string | null;
  lastCommandText: string | null;
  lastError: string | null;
  abortController: AbortController | null;
}

const botWorker: BotWorkerState = {
  isRunning: false,
  botToken: '',
  botUsername: '',
  appUrl: '',
  offset: 0,
  commandsRegistered: false,
  handledCount: 0,
  lastCommandAt: null,
  lastCommandText: null,
  lastError: null,
  abortController: null,
};

const BOT_STATE_FILE = path.resolve(__dirname, '.tg_bot_state.json');

function saveBotStateFile(state: { isRunning: boolean; botToken: string; appUrl: string }) {
  try {
    fs.writeFileSync(BOT_STATE_FILE, JSON.stringify(state), { mode: 0o600 });
  } catch {
    // Ignore filesystem errors
  }
}

function loadBotStateFile(): { isRunning: boolean; botToken: string; appUrl: string } | null {
  try {
    if (!fs.existsSync(BOT_STATE_FILE)) return null;
    const raw = fs.readFileSync(BOT_STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.botToken === 'string') {
      return {
        isRunning: Boolean(parsed.isRunning),
        botToken: parsed.botToken,
        appUrl: typeof parsed.appUrl === 'string' ? parsed.appUrl : '',
      };
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

function isValidTelegramHttpsUrl(u: string): boolean {
  if (!u || typeof u !== 'string') return false;
  const trimmed = u.trim();
  if (!trimmed.startsWith('https://')) return false;
  if (trimmed.includes('localhost') || trimmed.includes('127.0.0.1') || trimmed.includes('0.0.0.0')) {
    return false;
  }
  return /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(?:[/?#].*)?$/i.test(trimmed);
}

function resolveServerBotToken(clientToken?: string): string {
  const fromClient = typeof clientToken === 'string' ? clientToken.trim() : '';
  if (fromClient) return fromClient;
  if (botWorker.botToken) return botWorker.botToken;
  const saved = loadBotStateFile();
  if (saved?.botToken) return saved.botToken.trim();
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
}

const PAYWAY_PAYMENT_LINK = 'https://link.payway.com.kh/ABAPAYox450999g';
const KHQR_PHOTO_PATH = path.resolve(__dirname, 'public/assets/aistudio/image_13971c05.png');

function buildTelegramBotReply(
  rawCmd: string,
  appUrl: string,
  isPrivateChat = true
): { text: string; reply_markup: any; photoPath?: string } {
  const cleaned = (rawCmd || '').trim();
  const cmdToken = cleaned.split(/\s+/)[0].toLowerCase().replace(/@[a-z0-9_]+$/i, '');

  const normalized =
    cmdToken === '/register' || cmdToken === '/signup' || cmdToken === '/login' || cmdToken === 'cmd:register' || cleaned.includes('ចុះឈ្មោះ')
      ? 'register'
      : cmdToken === '/passcode' || cmdToken === '/code' || cmdToken === 'cmd:passcode' || cleaned.includes('លេខសម្ងាត់')
      ? 'passcode'
      : cmdToken === '/payment' || cmdToken === '/khqr' || cmdToken === '/vip' || cmdToken === 'cmd:payment' || cleaned.includes('បង់ប្រាក់')
      ? 'payment'
      : cmdToken === '/contact' || cmdToken === '/admin' || cmdToken === 'cmd:contact' || cleaned.includes('ទាក់ទង')
      ? 'contact'
      : cmdToken === '/help' || cmdToken === 'cmd:help' || cleaned.includes('ជំនួយ')
      ? 'help'
      : 'start';

  const envAppUrl = process.env.APP_URL && process.env.APP_URL !== 'MY_APP_URL' ? process.env.APP_URL : '';
  const candidateUrl = isValidTelegramHttpsUrl(appUrl)
    ? appUrl.trim()
    : isValidTelegramHttpsUrl(envAppUrl)
    ? envAppUrl.trim()
    : 'https://ais-pre-465pdvc3s6xpdxzfakguy4-895267791362.asia-southeast1.run.app';

  const createOpenAppButton = (label: string) =>
    isPrivateChat
      ? { text: label, web_app: { url: candidateUrl } }
      : { text: label, url: candidateUrl };

  const openAppRow = isValidTelegramHttpsUrl(candidateUrl)
    ? [createOpenAppButton('📱 បើកកម្មវិធី Master Quiz KH')]
    : [];

  const customTemplates = loadCustomBotTemplates();
  const custom = customTemplates[`/${normalized}`];
  if (custom && typeof custom.title === 'string' && typeof custom.body === 'string') {
    const customButtons: any[] = [];
    for (const act of Array.isArray(custom.actions) ? custom.actions : []) {
      if (!act || !act.label || !act.value) continue;
      if (act.type === 'command') {
        const cleanTarget = act.value.trim().replace(/^\//, '');
        customButtons.push({ text: act.label.slice(0, 64), callback_data: `cmd:${cleanTarget}` });
      } else if (act.type === 'url') {
        if (isValidTelegramHttpsUrl(act.value)) {
          customButtons.push({ text: act.label.slice(0, 64), url: act.value.trim() });
        }
      } else if (act.type === 'open_member_login') {
        if (isValidTelegramHttpsUrl(candidateUrl)) {
          customButtons.push(createOpenAppButton(act.label.slice(0, 64)));
        }
      }
    }

    const inlineRows: any[][] = [];
    for (const btn of customButtons) {
      inlineRows.push([btn]);
    }
    if (openAppRow.length > 0 && !customButtons.some((b) => b.url === candidateUrl || b.web_app?.url === candidateUrl)) {
      inlineRows.push(openAppRow);
    }

    const bodyText = custom.body.trim();
    const formattedText =
      `<b>${escapeServerHtml(custom.title.trim())}</b>` +
      (bodyText ? `\n\n${escapeServerHtml(bodyText)}` : '');

    return {
      photoPath:
        normalized === 'payment' && custom.imageUrl !== '' && fs.existsSync(KHQR_PHOTO_PATH)
          ? KHQR_PHOTO_PATH
          : undefined,
      text: formattedText,
      reply_markup: inlineRows.length > 0 ? { inline_keyboard: inlineRows } : undefined,
    };
  }

  if (normalized === 'register') {
    return {
      text:
        `<b>📝 ការណែនាំចុះឈ្មោះប្រើប្រាស់ Master Quiz KH</b>\n\n` +
        `ដើម្បីចុះឈ្មោះ និងចូលធ្វើតេស្ត សូមអនុវត្តតាម ៤ ជំហានងាយៗ៖\n` +
        `<b>១.</b> ចុចបើកកម្មវិធី រួចជ្រើសរើសកាត <b>«សមាជិក (Member)»</b>\n` +
        `<b>២.</b> បំពេញ <b>ឈ្មោះអ្នកប្រើប្រាស់ (Username)</b> របស់អ្នក (ឧ. Dara ឬ សុខា)\n` +
        `<b>៣.</b> បញ្ចូល <b>លេខសម្ងាត់សមាជិក (Passcode)</b> ដែលអ្នកបានទទួលពី Admin\n` +
        `<b>៤.</b> ចុច <b>«ផ្ទៀងផ្ទាត់ និងចូលធ្វើតេស្ត»</b> ដើម្បីចាប់ផ្ដើមហ្វឹកហាត់វិញ្ញាសាភ្លាមៗ!\n\n` +
        `✨ <i>សាកល្បងឥតគិតថ្លៃ ២៥ សំណួរ/មុខវិជ្ជា ឬដំឡើងសិទ្ធិពេញមួយជីវិត (/payment)។</i>`,
      reply_markup: {
        inline_keyboard: [
          ...(openAppRow.length > 0 ? [openAppRow] : []),
          [
            { text: '🔐 ស្នើសុំលេខសម្ងាត់', callback_data: 'cmd:passcode' },
            { text: '💎 បង់ប្រាក់ KHQR', callback_data: 'cmd:payment' },
          ],
          [{ text: '📞 ទាក់ទង Admin (@qcm_and_q_a)', url: 'https://t.me/qcm_and_q_a' }],
        ],
      },
    };
  }

  if (normalized === 'passcode') {
    return {
      text:
        `<b>🔐 ការស្នើសុំលេខសម្ងាត់សមាជិក (Passcode)</b>\n\n` +
        `ដើម្បីសុវត្ថិភាពគណនី កម្មវិធីមិនបង្ហាញ ឬផ្ដល់ទិន្នន័យអំពីលេខសម្ងាត់ជាសាធារណៈតាម Bot នោះទេ។\n\n` +
        `<b>📌 របៀបទទួលបានលេខសម្ងាត់ ឬស្នើសុំកូដថ្មី៖</b>\n` +
        `១. ចុចទាក់ទង Admin តាម Telegram ខាងក្រោម (@qcm_and_q_a)\n` +
        `២. ផ្ញើឈ្មោះអ្នកប្រើប្រាស់ (Username) របស់អ្នក ដើម្បីឱ្យ Admin ផ្ដល់កូដសមាជិកជូនដោយផ្ទាល់។`,
      reply_markup: {
        inline_keyboard: [
          ...(openAppRow.length > 0 ? [openAppRow] : []),
          [
            { text: '📞 ទាក់ទង Admin (@qcm_and_q_a)', url: 'https://t.me/qcm_and_q_a' },
            { text: '📝 ជំហានចុះឈ្មោះ', callback_data: 'cmd:register' },
          ],
        ],
      },
    };
  }

  if (normalized === 'payment') {
    return {
      photoPath: fs.existsSync(KHQR_PHOTO_PATH) ? KHQR_PHOTO_PATH : undefined,
      text:
        `<b>💎 ការចុះឈ្មោះគណនីពេញមួយជីវិត (KHQR / ABA PayWay $10.00)</b>\n\n` +
        `✅ ធ្វើតេស្ត QCM, Q&A និងពន្យល់ពាក្យគ្មានដែនកំណត់\n` +
        `✅ ទាញយកឯកសារវិញ្ញាសា PDF (មានក្របខ្មែរ & តារាងចម្លើយ)\n\n` +
        `<b>📌 ព័ត៌មានទូទាត់ ($10.00 USD)៖</b>\n` +
        `• គណនីទទួល៖ <b>KHOUN NARET Master QuizKH</b>\n` +
        `• ស្កេន KHQR ខាងលើ ឬចុចប៊ូតុង <b>«បើក Link បង់ប្រាក់ ABA PayWay»</b>\n` +
        `• រួចរាល់សូមផ្ញើវិក្កយបត្រមកកាន់ @qcm_and_q_a ដើម្បីបើកសិទ្ធិពេញមួយជីវិតភ្លាមៗ!`,
      reply_markup: {
        inline_keyboard: [
          [{ text: '💳 បើក Link បង់ប្រាក់ ABA PayWay ($10)', url: PAYWAY_PAYMENT_LINK }],
          [
            { text: '📞 ផ្ញើវិក្កយបត្រទៅ @qcm_and_q_a', url: 'https://t.me/qcm_and_q_a' },
            { text: '📝 ជំហានចុះឈ្មោះ', callback_data: 'cmd:register' },
          ],
          ...(openAppRow.length > 0 ? [openAppRow] : []),
        ],
      },
    };
  }

  if (normalized === 'contact') {
    return {
      text:
        `<b>📞 ទំនាក់ទំនង Admin និងបណ្ដាញ Telegram</b>\n\n` +
        `• ទំនាក់ទំនង & ក្រុមសិក្សា QCM & Q&A៖ <a href="https://t.me/qcm_and_q_a">@qcm_and_q_a</a>\n` +
        `• Telegram Bot ផ្លូវការ៖ <a href="https://t.me/qiuzs_bot">@qiuzs_bot</a>`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '💬 ទាក់ទង @qcm_and_q_a', url: 'https://t.me/qcm_and_q_a' },
            { text: '🤖 Bot @qiuzs_bot', url: 'https://t.me/qiuzs_bot' },
          ],
          ...(openAppRow.length > 0 ? [openAppRow] : []),
        ],
      },
    };
  }

  if (normalized === 'help') {
    return {
      text:
        `<b>📚 បញ្ជី Command របស់ Master Quiz KH Bot</b>\n\n` +
        `/start — មឺនុយស្វាគមន៍ និងការចាប់ផ្ដើម\n` +
        `/register — ណែនាំជំហានចុះឈ្មោះប្រើប្រាស់កម្មវិធី\n` +
        `/passcode — របៀបស្នើសុំលេខសម្ងាត់ពី Admin\n` +
        `/payment — ការបង់ប្រាក់ KHQR ពេញមួយជីវិត\n` +
        `/contact — ទំនាក់ទំនង Admin និងក្រុម Telegram\n` +
        `/help — មើលបញ្ជី Command ទាំងអស់`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📝 /register', callback_data: 'cmd:register' },
            { text: '🔐 /passcode', callback_data: 'cmd:passcode' },
          ],
          [
            { text: '💎 /payment', callback_data: 'cmd:payment' },
            { text: '📞 /contact', callback_data: 'cmd:contact' },
          ],
          ...(openAppRow.length > 0 ? [openAppRow] : []),
        ],
      },
    };
  }

  // Default: /start welcome
  return {
    text:
      `<b>🙏 សូមស្វាគមន៍មកកាន់ Master Quiz KH Bot!</b>\n\n` +
      `ប្រព័ន្ធត្រៀមប្រឡងក្របខ័ណ្ឌរដ្ឋកម្ពុជា (QCM, Q&A, ពន្យល់ពាក្យ និង PDF)។\n\n` +
      `ចុចប៊ូតុងខាងក្រោម ឬវាយ Command ដើម្បីទទួលការណែនាំ៖\n` +
      `• /register — ណែនាំជំហានចុះឈ្មោះប្រើប្រាស់\n` +
      `• /passcode — របៀបស្នើសុំលេខសម្ងាត់ពី Admin\n` +
      `• /payment — គណនីពេញមួយជីវិត ($10 KHQR)\n` +
      `• /help — បញ្ជី Command ទាំងអស់`,
    reply_markup: {
      inline_keyboard: [
        [{ text: '📝 ណែនាំចុះឈ្មោះ (/register)', callback_data: 'cmd:register' }],
        [
          { text: '🔐 ស្នើសុំលេខសម្ងាត់ (/passcode)', callback_data: 'cmd:passcode' },
          { text: '💎 បង់ប្រាក់ (/payment)', callback_data: 'cmd:payment' },
        ],
        [
          { text: '📞 ទាក់ទង @qcm_and_q_a', url: 'https://t.me/qcm_and_q_a' },
          { text: '📚 Commands (/help)', callback_data: 'cmd:help' },
        ],
        ...(openAppRow.length > 0 ? [openAppRow] : []),
      ],
    },
  };
}

async function registerCommandsWithTelegram(botToken: string): Promise<boolean> {
  const effectiveCommands = getEffectiveTelegramBotCommands();
  const res = await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands: effectiveCommands }),
  });
  const data = await safeTelegramJson(res);
  if (!res.ok || !data.ok) {
    throw new Error(data.description || 'Failed to register Bot Commands');
  }

  // Note: Do NOT modify Bot Info (setMyDescription / setMyShortDescription / setMyName)
  // or Mini App / Menu Button (setChatMenuButton) so the owner can manage them manually in Telegram.

  return true;
}

function isTelegramDeliveryBlockedError(status: number, description?: string): boolean {
  if (status === 403) return true;
  const desc = (description || '').toLowerCase();
  return (
    desc.includes('blocked by the user') ||
    desc.includes('user is deactivated') ||
    desc.includes('bot was kicked') ||
    desc.includes("can't initiate conversation") ||
    desc.includes('chat not found')
  );
}

async function processTelegramUpdate(botToken: string, update: any, appUrl: string) {
  if (!update) return;

  let chatId: number | string | null = null;
  let commandInput = '';
  let isPrivateChat = true;

  if (update.message && update.message.chat && typeof update.message.text === 'string') {
    if (update.message.from?.is_bot) return;
    const text = update.message.text.trim();
    isPrivateChat = update.message.chat.type === 'private';
    if (text.startsWith('/') || isPrivateChat) {
      chatId = update.message.chat.id;
      commandInput = text;
    }
  } else if (update.callback_query && update.callback_query.data) {
    const cq = update.callback_query;
    if (String(cq.data).startsWith('cmd:')) {
      chatId = cq.message?.chat?.id ?? cq.from?.id ?? null;
      isPrivateChat = cq.message?.chat?.type ? cq.message.chat.type === 'private' : true;
      commandInput = String(cq.data);
      await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cq.id }),
      }).catch(() => {});
    }
  }

  if (!chatId || !commandInput) return;

  const reply = buildTelegramBotReply(commandInput, appUrl, isPrivateChat);

  // If reply includes a local photo card (e.g. KHQR payment QR), send via sendPhoto first
  if (reply.photoPath) {
    try {
      const imgBuffer = fs.readFileSync(reply.photoPath);
      const b = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
      const chunks: Buffer[] = [];
      const addFld = (name: string, value: string) => {
        chunks.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
      };
      addFld('chat_id', String(chatId));
      addFld('caption', reply.text.slice(0, 1020));
      addFld('parse_mode', 'HTML');
      if (reply.reply_markup) {
        addFld('reply_markup', JSON.stringify(reply.reply_markup));
      }
      chunks.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="photo"; filename="khqr_payment.png"\r\nContent-Type: image/png\r\n\r\n`));
      chunks.push(imgBuffer);
      chunks.push(Buffer.from(`\r\n--${b}--\r\n`));

      const photoRes = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${b}` },
        body: Buffer.concat(chunks),
      });
      const photoData = await safeTelegramJson(photoRes);
      if (photoRes.ok && photoData.ok) {
        botWorker.lastError = null;
        botWorker.handledCount += 1;
        botWorker.lastCommandAt = new Date().toISOString();
        botWorker.lastCommandText = commandInput.slice(0, 60);
        return;
      }
      if (isTelegramDeliveryBlockedError(photoRes.status, photoData?.description)) {
        return;
      }
      botWorker.lastError = photoData?.description || `Telegram sendPhoto error (${photoRes.status})`;
      console.warn('Telegram Command Bot sendPhoto failed, falling back to sendMessage:', botWorker.lastError);
    } catch (photoErr: any) {
      console.warn('Telegram Command Bot photo read/send error, falling back:', photoErr?.message || photoErr);
    }
  }

  const sendRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: reply.text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: reply.reply_markup,
    }),
  });
  const sendData = await safeTelegramJson(sendRes);

  if (!sendRes.ok || !sendData.ok) {
    if (isTelegramDeliveryBlockedError(sendRes.status, sendData?.description)) {
      return;
    }
    botWorker.lastError = sendData?.description || `Telegram sendMessage error (${sendRes.status})`;
    console.warn('Telegram Command Bot primary sendMessage failed:', botWorker.lastError);
    // Fallback retry without inline keyboard URL buttons / HTML in case Telegram rejected a button URL
    const fallbackRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: reply.text.replace(/<[^>]+>/g, ''),
        disable_web_page_preview: true,
      }),
    });
    const fallbackData = await safeTelegramJson(fallbackRes);
    if (!fallbackRes.ok || !fallbackData.ok) {
      return;
    }
  }

  botWorker.lastError = null;
  botWorker.handledCount += 1;
  botWorker.lastCommandAt = new Date().toISOString();
  botWorker.lastCommandText = commandInput.slice(0, 60);
}

async function startCommandBotWorker(cleanToken: string, origin: string) {
  const meRes = await fetch(`https://api.telegram.org/bot${cleanToken}/getMe`);
  const meData = await safeTelegramJson(meRes);
  if (!meRes.ok || !meData.ok) {
    throw new Error(meData.description || 'មិនអាចតភ្ជាប់ទៅ Telegram Bot Token នេះបានទេ');
  }

  // Clear webhook so getUpdates polling runs without 409 conflicts
  await fetch(`https://api.telegram.org/bot${cleanToken}/deleteWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ drop_pending_updates: false }),
  });

  await registerCommandsWithTelegram(cleanToken);

  if (botWorker.abortController) {
    botWorker.abortController.abort();
    botWorker.abortController = null;
  }

  botWorker.isRunning = true;
  botWorker.botToken = cleanToken;
  botWorker.botUsername = meData.result?.username || '';
  botWorker.appUrl = origin;
  botWorker.commandsRegistered = true;
  botWorker.lastError = null;

  saveBotStateFile({
    isRunning: true,
    botToken: cleanToken,
    appUrl: origin,
  });

  runTelegramPollingLoop(cleanToken, origin).catch((err) => {
    console.error('Telegram polling loop stopped:', err);
  });
}

async function runTelegramPollingLoop(botToken: string, appUrl: string) {
  while (botWorker.isRunning && botWorker.botToken === botToken) {
    try {
      const controller = new AbortController();
      botWorker.abortController = controller;
      const res = await fetch(
        `https://api.telegram.org/bot${botToken}/getUpdates?offset=${botWorker.offset}&timeout=20&allowed_updates=${encodeURIComponent(
          JSON.stringify(['message', 'callback_query'])
        )}`,
        { signal: controller.signal }
      );
      const data = await safeTelegramJson(res);
      if (!res.ok || !data.ok) {
        botWorker.lastError = data.description || 'Polling error';
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      botWorker.lastError = null;
      const updates: any[] = Array.isArray(data.result) ? data.result : [];
      for (const upd of updates) {
        if (typeof upd.update_id === 'number') {
          botWorker.offset = Math.max(botWorker.offset, upd.update_id + 1);
        }
        await processTelegramUpdate(botToken, upd, appUrl).catch((err) => {
          console.error('Error handling Telegram update:', err);
        });
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') break;
      botWorker.lastError = err?.message || 'Polling network error';
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// Endpoint: Test Telegram Bot Connection (supports client token or server-configured token)
app.post('/api/telegram/bot/test', async (req, res) => {
  try {
    const cleanToken = resolveServerBotToken(req.body?.botToken);
    if (!cleanToken) {
      return res.status(400).json({ success: false, error: 'សូមបញ្ចូល Telegram Bot Token ជាមុនសិន!' });
    }
    const meRes = await fetch(`https://api.telegram.org/bot${cleanToken}/getMe`);
    const meData = await safeTelegramJson(meRes);
    if (!meRes.ok || !meData.ok) {
      return res.status(400).json({
        success: false,
        error: meData.description || 'មិនអាចតភ្ជាប់ទៅកាន់ Telegram Bot បានទេ',
      });
    }
    res.json({ success: true, result: meData.result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint: Register Telegram Bot Slash Commands menu (setMyCommands only; leaves Bot Info and Mini App untouched)
app.post('/api/telegram/bot/set-commands', async (req, res) => {
  try {
    const cleanToken = resolveServerBotToken(req.body?.botToken);
    if (!cleanToken) {
      return res.status(400).json({ success: false, error: 'Missing botToken' });
    }
    await registerCommandsWithTelegram(cleanToken);
    botWorker.commandsRegistered = true;
    res.json({ success: true, commands: getEffectiveTelegramBotCommands() });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Endpoint: Read or Update Custom Command Bot Reply Templates
app.get('/api/telegram/bot/templates', (_req, res) => {
  res.json({ success: true, templates: loadCustomBotTemplates() });
});

app.post('/api/telegram/bot/templates', async (req, res) => {
  try {
    const incoming = req.body?.templates;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return res.status(400).json({ success: false, error: 'Invalid templates payload' });
    }
    saveCustomBotTemplates(incoming);
    if (botWorker.isRunning && botWorker.botToken) {
      await registerCommandsWithTelegram(botWorker.botToken).catch(() => {});
    }
    res.json({ success: true, templates: incoming });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint: Start Telegram Command Bot Auto-Reply Worker (Long Polling + setMyCommands)
app.post('/api/telegram/bot/start', async (req, res) => {
  try {
    const { botToken, appUrl } = req.body || {};
    const cleanToken = resolveServerBotToken(botToken);
    if (!cleanToken) {
      return res.status(400).json({ success: false, error: 'សូមបញ្ចូល Telegram Bot Token ជាមុនសិន!' });
    }

    const origin =
      typeof appUrl === 'string' && isValidTelegramHttpsUrl(appUrl)
        ? appUrl.trim().replace(/\/+$/, '')
        : getBaseOrigin(req);

    await startCommandBotWorker(cleanToken, origin);

    res.json({
      success: true,
      isRunning: true,
      botUsername: botWorker.botUsername,
      hasServerToken: true,
      commands: TELEGRAM_BOT_COMMANDS,
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Endpoint: Stop Telegram Command Bot Auto-Reply Worker
app.post('/api/telegram/bot/stop', (_req, res) => {
  botWorker.isRunning = false;
  if (botWorker.abortController) {
    botWorker.abortController.abort();
    botWorker.abortController = null;
  }
  if (botWorker.botToken) {
    saveBotStateFile({
      isRunning: false,
      botToken: botWorker.botToken,
      appUrl: botWorker.appUrl,
    });
  }
  res.json({ success: true, isRunning: false });
});

// Endpoint: Check Telegram Command Bot Status (never leaks secret token)
app.get('/api/telegram/bot/status', (_req, res) => {
  res.json({
    isRunning: botWorker.isRunning,
    botUsername: botWorker.botUsername,
    hasServerToken: Boolean(resolveServerBotToken()),
    commandsRegistered: botWorker.commandsRegistered,
    handledCount: botWorker.handledCount,
    lastCommandAt: botWorker.lastCommandAt,
    lastCommandText: botWorker.lastCommandText,
    lastError: botWorker.lastError,
    commands: TELEGRAM_BOT_COMMANDS,
  });
});

// Endpoint: Optional Webhook Receiver for Telegram Bot Commands
app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const token =
      (req.headers['x-telegram-bot-token'] as string) ||
      botWorker.botToken ||
      process.env.TELEGRAM_BOT_TOKEN ||
      '';
    if (token && req.body) {
      await processTelegramUpdate(token, req.body, getBaseOrigin(req));
    }
    res.json({ ok: true });
  } catch (err: any) {
    console.error('Telegram webhook error:', err);
    res.json({ ok: true });
  }
});

// ---------------- Shared Server-Side Firestore Read-Through Cache ----------------
// Eliminates redundant Firestore reads when multiple users/students load the app.
interface FirebaseAppletConfig {
  projectId: string;
  apiKey: string;
  firestoreDatabaseId: string;
}

function loadFirebaseAppletConfig(): FirebaseAppletConfig | null {
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, 'firebase-applet-config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.projectId && parsed?.apiKey && parsed?.firestoreDatabaseId) {
      return {
        projectId: parsed.projectId,
        apiKey: parsed.apiKey,
        firestoreDatabaseId: parsed.firestoreDatabaseId,
      };
    }
  } catch {
    // Config absent or unreadable
  }
  return null;
}

const serverFbConfig = loadFirebaseAppletConfig();

function decodeFirestoreValue(val: any): any {
  if (!val || typeof val !== 'object') return undefined;
  if ('stringValue' in val) return String(val.stringValue);
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('booleanValue' in val) return Boolean(val.booleanValue);
  if ('nullValue' in val) return null;
  if ('timestampValue' in val) return String(val.timestampValue);
  if ('arrayValue' in val) {
    const arr = Array.isArray(val.arrayValue?.values) ? val.arrayValue.values : [];
    return arr.map((item: any) => decodeFirestoreValue(item));
  }
  if ('mapValue' in val) {
    return decodeFirestoreFields(val.mapValue?.fields || {});
  }
  return undefined;
}

function decodeFirestoreFields(fields: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(fields || {})) {
    const decoded = decodeFirestoreValue(v);
    if (decoded !== undefined) {
      out[k] = decoded;
    }
  }
  return out;
}

async function fetchCollectionViaFirestoreRest(collectionName: string, authHeader?: string): Promise<any[]> {
  if (!serverFbConfig) {
    throw new Error('Firebase config unavailable on server');
  }
  const { projectId, firestoreDatabaseId, apiKey } = serverFbConfig;
  const docs: any[] = [];
  const seenIds = new Set<string>();
  let lastDocName = '';
  const maxPages = 500;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authHeader && authHeader.startsWith('Bearer ')) {
    headers['Authorization'] = authHeader;
  }

  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(firestoreDatabaseId)}/documents:runQuery?key=${encodeURIComponent(apiKey)}`;

  for (let page = 0; page < maxPages; page++) {
    const structuredQuery: Record<string, any> = {
      from: [{ collectionId: collectionName }],
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      limit: 20,
    };
    if (lastDocName) {
      structuredQuery.startAt = {
        values: [{ referenceValue: lastDocName }],
        before: false,
      };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ structuredQuery }),
    });
    if (!res.ok) {
      const err: any = new Error(`Firestore REST ${collectionName} HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const rows = await res.json();
    const list = Array.isArray(rows) ? rows.filter((r: any) => Boolean(r?.document)) : [];
    for (const row of list) {
      const d = row.document;
      const name = typeof d.name === 'string' ? d.name : '';
      const id = name ? name.split('/').pop() || '' : '';
      if (name) lastDocName = name;
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      docs.push({
        id,
        ...decodeFirestoreFields(d.fields || {}),
      });
    }

    if (list.length < 20) {
      break;
    }
  }

  return docs;
}

async function fetchActivePresenceCountViaRest(authHeader?: string): Promise<number> {
  if (!serverFbConfig) throw new Error('Firebase config unavailable on server');
  const { projectId, firestoreDatabaseId, apiKey } = serverFbConfig;
  const fiveMinsAgoIso = new Date(Date.now() - 300000).toISOString();
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(firestoreDatabaseId)}/documents:runAggregationQuery?key=${encodeURIComponent(apiKey)}`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authHeader && authHeader.startsWith('Bearer ')) {
    headers['Authorization'] = authHeader;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      structuredAggregationQuery: {
        structuredQuery: {
          from: [{ collectionId: 'presence' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'lastSeen' },
              op: 'GREATER_THAN_OR_EQUAL',
              value: { stringValue: fiveMinsAgoIso },
            },
          },
          limit: 20,
        },
        aggregations: [{ alias: 'total', count: {} }],
      },
    }),
  });

  if (!res.ok) {
    const err: any = new Error(`Firestore REST aggregation HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const rows = await res.json();
  const countVal = rows?.[0]?.result?.aggregateFields?.total?.integerValue;
  return Math.max(1, Number(countVal || 0));
}

const SERVER_CACHE_TTLS = {
  questions: 6 * 60 * 60 * 1000, // 6 hours (admin mutations update cache in-place)
  subjects: 6 * 60 * 60 * 1000, // 6 hours
  bot_commands: 6 * 60 * 60 * 1000, // 6 hours
  notifications: 60 * 60 * 1000, // 1 hour
  onlineCount: 5 * 60 * 1000, // 5 minutes
};

const SERVER_DISK_CACHE_PRIMARY = path.resolve(__dirname, '.mpq_server_core_cache.json');
const SERVER_DISK_CACHE_FALLBACK = path.join(os.tmpdir(), 'mpq-server-core-cache-v1.json');

interface ServerCoreCacheState {
  version: number;
  lastForceAt: number;
  quotaCooldownUntil: number;
  questions: { data: any[]; fetchedAt: number } | null;
  subjects: { data: any[]; fetchedAt: number } | null;
  notifications: { data: any[]; fetchedAt: number } | null;
  bot_commands: { data: Record<string, any>; fetchedAt: number } | null;
  onlineCount: { count: number; fetchedAt: number } | null;
}

function loadServerCoreCacheFromDisk(): ServerCoreCacheState {
  const empty: ServerCoreCacheState = {
    version: Date.now(),
    lastForceAt: 0,
    quotaCooldownUntil: 0,
    questions: null,
    subjects: null,
    notifications: null,
    bot_commands: null,
    onlineCount: null,
  };
  for (const cachePath of [SERVER_DISK_CACHE_PRIMARY, SERVER_DISK_CACHE_FALLBACK]) {
    try {
      if (!fs.existsSync(cachePath)) continue;
      const raw = fs.readFileSync(cachePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return {
          ...empty,
          version: typeof parsed.version === 'number' ? parsed.version : Date.now(),
          questions:
            Array.isArray(parsed.questions?.data) && parsed.questions.data.length > 0
              ? parsed.questions
              : null,
          subjects:
            Array.isArray(parsed.subjects?.data) && parsed.subjects.data.length > 0
              ? parsed.subjects
              : null,
          notifications: Array.isArray(parsed.notifications?.data) ? parsed.notifications : null,
          bot_commands:
            parsed.bot_commands?.data && typeof parsed.bot_commands.data === 'object'
              ? parsed.bot_commands
              : null,
          onlineCount: parsed.onlineCount?.count ? parsed.onlineCount : null,
        };
      }
    } catch {
      // Try next cache location
    }
  }
  return empty;
}

const serverCoreCache: ServerCoreCacheState = loadServerCoreCacheFromDisk();
let persistCacheTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersistServerCoreCache() {
  if (persistCacheTimer) return;
  persistCacheTimer = setTimeout(() => {
    persistCacheTimer = null;
    const serialized = JSON.stringify({
      version: serverCoreCache.version,
      questions: serverCoreCache.questions,
      subjects: serverCoreCache.subjects,
      notifications: serverCoreCache.notifications,
      bot_commands: serverCoreCache.bot_commands,
      onlineCount: serverCoreCache.onlineCount,
    });
    try {
      fs.writeFileSync(SERVER_DISK_CACHE_PRIMARY, serialized, { mode: 0o600 });
    } catch {
      try {
        fs.writeFileSync(SERVER_DISK_CACHE_FALLBACK, serialized);
      } catch {
        // Ignore disk write failure on read-only environments
      }
    }
  }, 400);
}

const serverCacheInFlight = new Map<string, Promise<any>>();

function markQuotaCooldownIfNeeded(err: any) {
  if (err?.status === 429 || String(err?.message || '').includes('429')) {
    serverCoreCache.quotaCooldownUntil = Date.now() + 5 * 60 * 1000; // 5-min backoff
  }
}

async function getServerCachedQuestions(force = false, authHeader?: string): Promise<any[]> {
  const now = Date.now();
  if (
    !force &&
    serverCoreCache.questions &&
    serverCoreCache.questions.data.length > 0 &&
    (now - serverCoreCache.questions.fetchedAt < SERVER_CACHE_TTLS.questions ||
      now < serverCoreCache.quotaCooldownUntil)
  ) {
    return serverCoreCache.questions.data;
  }
  if (now < serverCoreCache.quotaCooldownUntil) {
    const err: any = new Error('Firestore quota cooldown active');
    err.status = 429;
    throw err;
  }

  const key = 'questions';
  if (serverCacheInFlight.has(key)) return serverCacheInFlight.get(key)!;

  const p = (async () => {
    try {
      const raw = await fetchCollectionViaFirestoreRest('questions', authHeader);
      raw.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      serverCoreCache.questions = { data: raw, fetchedAt: Date.now() };
      schedulePersistServerCoreCache();
      return raw;
    } catch (err: any) {
      markQuotaCooldownIfNeeded(err);
      if (serverCoreCache.questions) {
        return serverCoreCache.questions.data;
      }
      throw err;
    }
  })().finally(() => serverCacheInFlight.delete(key));

  serverCacheInFlight.set(key, p);
  return p;
}

async function getServerCachedSubjects(force = false, authHeader?: string): Promise<any[]> {
  const now = Date.now();
  if (
    !force &&
    serverCoreCache.subjects &&
    serverCoreCache.subjects.data.length > 0 &&
    (now - serverCoreCache.subjects.fetchedAt < SERVER_CACHE_TTLS.subjects ||
      now < serverCoreCache.quotaCooldownUntil)
  ) {
    return serverCoreCache.subjects.data;
  }
  if (now < serverCoreCache.quotaCooldownUntil) {
    const err: any = new Error('Firestore quota cooldown active');
    err.status = 429;
    throw err;
  }

  const key = 'subjects';
  if (serverCacheInFlight.has(key)) return serverCacheInFlight.get(key)!;

  const p = (async () => {
    try {
      const raw = await fetchCollectionViaFirestoreRest('subjects', authHeader);
      raw.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      serverCoreCache.subjects = { data: raw, fetchedAt: Date.now() };
      schedulePersistServerCoreCache();
      return raw;
    } catch (err: any) {
      markQuotaCooldownIfNeeded(err);
      if (serverCoreCache.subjects) {
        return serverCoreCache.subjects.data;
      }
      throw err;
    }
  })().finally(() => serverCacheInFlight.delete(key));

  serverCacheInFlight.set(key, p);
  return p;
}

async function getServerCachedNotifications(force = false, authHeader?: string): Promise<any[]> {
  const now = Date.now();
  if (
    !force &&
    serverCoreCache.notifications &&
    (now - serverCoreCache.notifications.fetchedAt < SERVER_CACHE_TTLS.notifications ||
      now < serverCoreCache.quotaCooldownUntil)
  ) {
    return serverCoreCache.notifications.data;
  }
  if (now < serverCoreCache.quotaCooldownUntil) {
    const err: any = new Error('Firestore quota cooldown active');
    err.status = 429;
    throw err;
  }

  const key = 'notifications';
  if (serverCacheInFlight.has(key)) return serverCacheInFlight.get(key)!;

  const p = (async () => {
    try {
      const raw = await fetchCollectionViaFirestoreRest('notifications', authHeader);
      raw.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
      serverCoreCache.notifications = { data: raw.slice(0, 20), fetchedAt: Date.now() };
      schedulePersistServerCoreCache();
      return serverCoreCache.notifications.data;
    } catch (err: any) {
      markQuotaCooldownIfNeeded(err);
      if (serverCoreCache.notifications) {
        return serverCoreCache.notifications.data;
      }
      throw err;
    }
  })().finally(() => serverCacheInFlight.delete(key));

  serverCacheInFlight.set(key, p);
  return p;
}

async function getServerCachedBotCommands(force = false, authHeader?: string): Promise<Record<string, any>> {
  const now = Date.now();
  if (
    !force &&
    serverCoreCache.bot_commands &&
    (now - serverCoreCache.bot_commands.fetchedAt < SERVER_CACHE_TTLS.bot_commands ||
      now < serverCoreCache.quotaCooldownUntil)
  ) {
    return serverCoreCache.bot_commands.data;
  }
  if (now < serverCoreCache.quotaCooldownUntil) {
    const err: any = new Error('Firestore quota cooldown active');
    err.status = 429;
    throw err;
  }

  const key = 'bot_commands';
  if (serverCacheInFlight.has(key)) return serverCacheInFlight.get(key)!;

  const p = (async () => {
    try {
      const raw = await fetchCollectionViaFirestoreRest('bot_commands', authHeader);
      const map: Record<string, any> = {};
      for (const item of raw) {
        if (item?.command) {
          map[item.command] = item;
        }
      }
      serverCoreCache.bot_commands = { data: map, fetchedAt: Date.now() };
      schedulePersistServerCoreCache();
      return map;
    } catch (err: any) {
      markQuotaCooldownIfNeeded(err);
      if (serverCoreCache.bot_commands) {
        return serverCoreCache.bot_commands.data;
      }
      throw err;
    }
  })().finally(() => serverCacheInFlight.delete(key));

  serverCacheInFlight.set(key, p);
  return p;
}

app.get('/api/cache/core', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const now = Date.now();
    const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
    const rawForce = req.query.force === '1';
    const forceCooldownMs = authHeader ? 2000 : 10000;
    const allowForce =
      rawForce &&
      now >= serverCoreCache.quotaCooldownUntil &&
      now - serverCoreCache.lastForceAt > forceCooldownMs;
    if (allowForce) {
      serverCoreCache.lastForceAt = now;
      serverCoreCache.version = now;
    }

    const since = Number(req.query.since || 0);
    const hasWarmCore =
      Boolean(serverCoreCache.questions?.data?.length) &&
      Boolean(serverCoreCache.subjects?.data?.length) &&
      Boolean(serverCoreCache.notifications) &&
      Boolean(serverCoreCache.bot_commands) &&
      (now < serverCoreCache.quotaCooldownUntil ||
        (now - serverCoreCache.questions!.fetchedAt < SERVER_CACHE_TTLS.questions &&
          now - serverCoreCache.subjects!.fetchedAt < SERVER_CACHE_TTLS.subjects &&
          now - serverCoreCache.notifications!.fetchedAt < SERVER_CACHE_TTLS.notifications &&
          now - serverCoreCache.bot_commands!.fetchedAt < SERVER_CACHE_TTLS.bot_commands));

    if (!allowForce && hasWarmCore && since > 0 && since === serverCoreCache.version) {
      return res.json({
        unchanged: true,
        version: serverCoreCache.version,
        quotaLimited: now < serverCoreCache.quotaCooldownUntil,
      });
    }

    const [qRes, sRes, nRes, bcRes] = await Promise.allSettled([
      getServerCachedQuestions(allowForce, authHeader),
      getServerCachedSubjects(allowForce, authHeader),
      getServerCachedNotifications(allowForce, authHeader),
      getServerCachedBotCommands(allowForce, authHeader),
    ]);

    const questions = qRes.status === 'fulfilled' ? qRes.value : serverCoreCache.questions?.data;
    const subjects = sRes.status === 'fulfilled' ? sRes.value : serverCoreCache.subjects?.data;
    const notifications =
      nRes.status === 'fulfilled' ? nRes.value : serverCoreCache.notifications?.data;
    const botCommands =
      bcRes.status === 'fulfilled' ? bcRes.value : serverCoreCache.bot_commands?.data;

    const anyRejected = [qRes, sRes, nRes, bcRes].some((r) => r.status === 'rejected');
    const quotaLimited =
      Date.now() < serverCoreCache.quotaCooldownUntil ||
      [qRes, sRes, nRes, bcRes].some(
        (r) => r.status === 'rejected' && (r.reason?.status === 429 || String(r.reason?.message || '').includes('429'))
      );
    const requiresAuth = [qRes, sRes, nRes, bcRes].some(
      (r) => r.status === 'rejected' && (r.reason?.status === 401 || r.reason?.status === 403)
    );

    const hasAnyData = Boolean(questions || subjects || notifications || botCommands);
    if (!hasAnyData && anyRejected) {
      return res.status(requiresAuth ? 401 : 503).json({
        success: false,
        quotaLimited,
        requiresAuth,
        error: quotaLimited
          ? 'Firestore daily read quota exceeded'
          : requiresAuth
            ? 'Authentication required for Firestore read'
            : 'Cache unavailable',
      });
    }

    res.json({
      unchanged: false,
      version: serverCoreCache.version,
      quotaLimited,
      requiresAuth,
      partial: !questions || !subjects,
      ...(questions ? { questions } : {}),
      ...(subjects ? { subjects } : {}),
      ...(notifications ? { notifications } : {}),
      ...(botCommands ? { botCommands } : {}),
    });
  } catch (err: any) {
    res.status(503).json({
      success: false,
      quotaLimited: Date.now() < serverCoreCache.quotaCooldownUntil,
      error: err?.message || 'Cache unavailable',
    });
  }
});

// ---------------- Real-Time SSE Hub & Live Presence ----------------
interface RealtimePresenceEntry {
  username: string;
  role: string;
  lastSeen: number;
}

const sseClients = new Set<express.Response>();
const activeRealtimePresence = new Map<string, RealtimePresenceEntry>();

function pruneRealtimePresence(now = Date.now()) {
  for (const [key, entry] of activeRealtimePresence.entries()) {
    if (now - entry.lastSeen > 5 * 60 * 1000) {
      activeRealtimePresence.delete(key);
    }
  }
}

function getEffectiveOnlineCount(): number {
  pruneRealtimePresence();
  return Math.max(
    1,
    activeRealtimePresence.size,
    sseClients.size,
    serverCoreCache.onlineCount?.count || 0
  );
}

function broadcastRealtimeEvent(payload: Record<string, any>) {
  if (sseClients.size === 0) return;
  const serialized = `event: sync\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(serialized);
    } catch {
      sseClients.delete(client);
    }
  }
}

app.get('/api/realtime/stream', (req, res) => {
  req.setTimeout(0);
  res.setTimeout(0);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const clientId =
    typeof req.query.clientId === 'string' && req.query.clientId.trim()
      ? req.query.clientId.trim().slice(0, 80)
      : crypto.randomBytes(6).toString('hex');
  const username =
    typeof req.query.username === 'string' ? req.query.username.trim().slice(0, 80) : '';
  const role = req.query.role === 'admin' ? 'admin' : 'user';

  sseClients.add(res);
  if (username) {
    activeRealtimePresence.set(clientId, { username, role, lastSeen: Date.now() });
  }

  const initialOnlineCount = getEffectiveOnlineCount();
  res.write(
    `event: connected\ndata: ${JSON.stringify({
      version: serverCoreCache.version,
      onlineCount: initialOnlineCount,
      ts: Date.now(),
    })}\n\n`
  );

  broadcastRealtimeEvent({
    scope: 'online_count',
    action: 'replace',
    onlineCount: initialOnlineCount,
    version: serverCoreCache.version,
    ts: Date.now(),
  });

  const keepAliveTimer = setInterval(() => {
    try {
      if (username) {
        activeRealtimePresence.set(clientId, { username, role, lastSeen: Date.now() });
      }
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      clearInterval(keepAliveTimer);
      sseClients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAliveTimer);
    sseClients.delete(res);
    activeRealtimePresence.delete(clientId);
    broadcastRealtimeEvent({
      scope: 'online_count',
      action: 'replace',
      onlineCount: getEffectiveOnlineCount(),
      version: serverCoreCache.version,
      ts: Date.now(),
    });
  });
});

app.post('/api/realtime/publish', (req, res) => {
  const { scope, action, id, ids, item, items, replace, clientId } = req.body || {};
  const allowedScopes = new Set([
    'presence',
    'feedbacks',
    'logins',
    'paid_users',
    'global_stats',
    'online_count',
  ]);
  if (typeof scope !== 'string' || !allowedScopes.has(scope)) {
    return res.status(400).json({ ok: false, error: 'Invalid realtime scope' });
  }

  const now = Date.now();
  if (scope === 'presence' && item?.username) {
    const key = String(clientId || item.id || item.username).slice(0, 80);
    activeRealtimePresence.set(key, {
      username: String(item.username).slice(0, 80),
      role: item.role === 'admin' ? 'admin' : 'user',
      lastSeen: now,
    });
    const nextOnlineCount = getEffectiveOnlineCount();
    broadcastRealtimeEvent({
      scope: 'online_count',
      action: 'replace',
      onlineCount: nextOnlineCount,
      version: serverCoreCache.version,
      ts: now,
    });
  }

  broadcastRealtimeEvent({
    scope,
    action: typeof action === 'string' ? action : 'upsert',
    ...(id ? { id } : {}),
    ...(Array.isArray(ids) ? { ids } : {}),
    ...(item !== undefined ? { item } : {}),
    ...(Array.isArray(items) ? { items } : {}),
    ...(replace !== undefined ? { replace } : {}),
    ...(typeof clientId === 'string' && clientId ? { sourceClientId: clientId } : {}),
    version: serverCoreCache.version,
    ts: now,
  });

  res.json({ ok: true, onlineCount: getEffectiveOnlineCount() });
});

app.get('/api/cache/online-count', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const now = Date.now();
    const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
    if (now < serverCoreCache.quotaCooldownUntil || !authHeader) {
      return res.json({
        count: getEffectiveOnlineCount(),
        quotaLimited: now < serverCoreCache.quotaCooldownUntil,
      });
    }
    const force = req.query.force === '1' && (!serverCoreCache.onlineCount || now - serverCoreCache.onlineCount.fetchedAt > 15000);
    if (!force && serverCoreCache.onlineCount && now - serverCoreCache.onlineCount.fetchedAt < SERVER_CACHE_TTLS.onlineCount) {
      return res.json({ count: getEffectiveOnlineCount() });
    }

    if (serverCacheInFlight.has('onlineCount')) {
      const count = await serverCacheInFlight.get('onlineCount')!;
      return res.json({ count: Math.max(getEffectiveOnlineCount(), count) });
    }

    const p = (async () => {
      const count = await fetchActivePresenceCountViaRest(authHeader);
      serverCoreCache.onlineCount = { count, fetchedAt: Date.now() };
      schedulePersistServerCoreCache();
      return count;
    })().finally(() => serverCacheInFlight.delete('onlineCount'));

    serverCacheInFlight.set('onlineCount', p);
    const count = await p;
    res.json({ count: Math.max(getEffectiveOnlineCount(), count) });
  } catch (err: any) {
    markQuotaCooldownIfNeeded(err);
    res.json({ count: getEffectiveOnlineCount() });
  }
});

// Safe in-place cache updates: supports atomic deltas (upsert/upsertMany/delete/reorder)
// and authoritative full replacements so a partial client cache never overwrites complete server data
app.post('/api/cache/mutate', (req, res) => {
  const { scope, action, item, items, id, ids, replace, authoritative, clientId } = req.body || {};
  const now = Date.now();
  let updated = false;

  const sortByOrder = (arr: any[]) => {
    const map = new Map<string, any>();
    const noId: any[] = [];
    for (const entry of arr) {
      if (entry?.id) {
        map.set(entry.id, entry);
      } else {
        noId.push(entry);
      }
    }
    return [...Array.from(map.values()), ...noId].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  };

  if (scope === 'questions' || scope === 'subjects') {
    const typedScope: 'questions' | 'subjects' = scope;
    const existing = serverCoreCache[typedScope]?.data;
    if (authoritative && Array.isArray(replace) && replace.length > 0) {
      serverCoreCache[typedScope] = { data: sortByOrder(replace), fetchedAt: now };
      updated = true;
    } else if (action === 'upsert' && item?.id && Array.isArray(existing)) {
      const map = new Map(existing.map((x: any) => [x.id, x]));
      map.set(item.id, { ...(map.get(item.id) || {}), ...item });
      serverCoreCache[typedScope] = { data: sortByOrder(Array.from(map.values())), fetchedAt: now };
      updated = true;
    } else if (action === 'upsertMany' && Array.isArray(items) && Array.isArray(existing)) {
      const map = new Map(existing.map((x: any) => [x.id, x]));
      for (const entry of items) {
        if (entry?.id) {
          map.set(entry.id, { ...(map.get(entry.id) || {}), ...entry });
        }
      }
      serverCoreCache[typedScope] = { data: sortByOrder(Array.from(map.values())), fetchedAt: now };
      updated = true;
    } else if (action === 'delete' && id && Array.isArray(existing)) {
      serverCoreCache[typedScope] = {
        data: existing.filter((x: any) => x.id !== id),
        fetchedAt: now,
      };
      updated = true;
    } else if (action === 'deleteMany' && Array.isArray(ids) && ids.length > 0 && Array.isArray(existing)) {
      const idSet = new Set<string>(ids.filter((x: unknown): x is string => typeof x === 'string' && Boolean(x)));
      serverCoreCache[typedScope] = {
        data: existing.filter((x: any) => !idSet.has(x.id)),
        fetchedAt: now,
      };
      updated = true;
    } else if (!action && Array.isArray(replace) && replace.length > 0) {
      // Legacy fallback: merge instead of blindly truncating if server already has more items
      if (Array.isArray(existing) && existing.length > replace.length) {
        const map = new Map(existing.map((x: any) => [x.id, x]));
        for (const entry of replace) {
          if (entry?.id) map.set(entry.id, entry);
        }
        serverCoreCache[typedScope] = { data: sortByOrder(Array.from(map.values())), fetchedAt: now };
      } else {
        serverCoreCache[typedScope] = { data: sortByOrder(replace), fetchedAt: now };
      }
      updated = true;
    }
  } else if (scope === 'notifications') {
    const sortNotifs = (arr: any[]) =>
      [...arr]
        .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
        .slice(0, 50);

    const existing = serverCoreCache.notifications?.data;
    if (action === 'upsert' && item?.id) {
      const base = Array.isArray(existing) ? existing.filter((x: any) => x.id !== item.id) : [];
      serverCoreCache.notifications = { data: sortNotifs([item, ...base]), fetchedAt: now };
      updated = true;
    } else if (action === 'delete' && id && Array.isArray(existing)) {
      serverCoreCache.notifications = {
        data: existing.filter((x: any) => x.id !== id),
        fetchedAt: now,
      };
      updated = true;
    } else if (action === 'clear' || (authoritative && Array.isArray(replace))) {
      serverCoreCache.notifications = { data: sortNotifs(replace || []), fetchedAt: now };
      updated = true;
    } else if (Array.isArray(replace)) {
      serverCoreCache.notifications = { data: sortNotifs(replace), fetchedAt: now };
      updated = true;
    }
  } else if (scope === 'bot_commands' && replace && typeof replace === 'object' && !Array.isArray(replace)) {
    serverCoreCache.bot_commands = { data: replace, fetchedAt: now };
    updated = true;
  }

  if (updated) {
    serverCoreCache.version = now;
    schedulePersistServerCoreCache();
  }

  if (
    updated ||
    scope === 'questions' ||
    scope === 'subjects' ||
    scope === 'notifications' ||
    scope === 'bot_commands'
  ) {
    if (!updated) {
      serverCoreCache.version = now;
    }
    broadcastRealtimeEvent({
      scope,
      action: action || 'replace',
      ...(item !== undefined ? { item } : {}),
      ...(Array.isArray(items) ? { items } : {}),
      ...(id ? { id } : {}),
      ...(Array.isArray(ids) ? { ids } : {}),
      ...(replace !== undefined ? { replace } : {}),
      ...(authoritative ? { authoritative: true } : {}),
      ...(typeof clientId === 'string' && clientId ? { sourceClientId: clientId } : {}),
      version: serverCoreCache.version,
      ts: now,
    });
  }

  res.json({ ok: true, updated, version: serverCoreCache.version });
});

app.post('/api/cache/invalidate', (req, res) => {
  const scopes: string[] = Array.isArray(req.body?.scopes)
    ? req.body.scopes
    : ['questions', 'subjects', 'notifications', 'bot_commands'];

  for (const scope of scopes) {
    if (scope === 'questions') serverCoreCache.questions = null;
    if (scope === 'subjects') serverCoreCache.subjects = null;
    if (scope === 'notifications') serverCoreCache.notifications = null;
    if (scope === 'bot_commands') serverCoreCache.bot_commands = null;
  }
  serverCoreCache.version = Date.now();
  schedulePersistServerCoreCache();
  broadcastRealtimeEvent({
    scope: 'core',
    action: 'refresh',
    scopes,
    version: serverCoreCache.version,
    ts: serverCoreCache.version,
  });
  res.json({ ok: true, version: serverCoreCache.version });
});

const adminVerifyAttempts = new Map<string, number[]>();

function getConfiguredAdminCode(): string {
  return (process.env.ADMIN_MASTER_CODE || process.env.ADMIN_PASSCODE || '').trim();
}

function timingSafeCompareStrings(aStr: string, bStr: string): boolean {
  const aHash = crypto.createHash('sha256').update(aStr).digest();
  const bHash = crypto.createHash('sha256').update(bStr).digest();
  return crypto.timingSafeEqual(aHash, bHash);
}

function isAdminRateLimited(ipKey: string): boolean {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const recent = (adminVerifyAttempts.get(ipKey) || []).filter((ts) => now - ts < windowMs);
  adminVerifyAttempts.set(ipKey, recent);
  return recent.length >= 15;
}

function recordAdminFailedAttempt(ipKey: string) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const recent = (adminVerifyAttempts.get(ipKey) || []).filter((ts) => now - ts < windowMs);
  recent.push(now);
  adminVerifyAttempts.set(ipKey, recent);
}

app.post('/api/admin/verify-passcode', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const ipKey = req.ip || 'unknown';
  if (isAdminRateLimited(ipKey)) {
    return res.status(429).json({
      success: false,
      error: 'សាកល្បងខុសច្រើនដងពេក! សូមរង់ចាំ ១០ នាទីសិន។',
    });
  }

  const submitted = typeof req.body?.passcode === 'string' ? req.body.passcode.trim() : '';
  if (!submitted || submitted.length > 128) {
    return res.status(400).json({
      success: false,
      error: 'សូមបញ្ចូលលេខកូដ Master Code ឱ្យបានត្រឹមត្រូវ!',
    });
  }

  const configuredCode = getConfiguredAdminCode();
  if (!configuredCode) {
    return res.status(503).json({
      success: false,
      error: 'មិនទាន់បានកំណត់ ADMIN_MASTER_CODE នៅលើ Server នៅឡើយទេ!',
    });
  }

  if (!timingSafeCompareStrings(configuredCode, submitted)) {
    recordAdminFailedAttempt(ipKey);
    return res.status(401).json({
      success: false,
      error: 'លេខកូដ Master Code មិនត្រឹមត្រូវទេ! សូមពិនិត្យលេខកូដម្ដងទៀត។',
    });
  }

  adminVerifyAttempts.delete(ipKey);
  res.json({ success: true });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'Master Quiz KH' });
});

// Mount Vite or static dist in production
async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        watch: null,
      },
      appType: 'spa',
    });

    // Suppress Vite HMR WebSocket attempts when HMR is disabled in AI Studio / Cloud Run preview
    app.get('/@vite/client', async (_req, res, next) => {
      try {
        const transformed = await vite.transformRequest('/@vite/client');
        if (!transformed?.code) return next();
        const patched = transformed.code
          .replace(
            /const transport = normalizeModuleRunnerTransport\(\(\(\) => \{[\s\S]*?\}\)\(\)\);/,
            'const transport = normalizeModuleRunnerTransport({ async connect() {}, async disconnect() {}, send() {} });'
          )
          .replace(
            'console.debug("[vite] connecting...");',
            'console.debug("[vite] HMR disabled");'
          );
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        return res.send(patched);
      } catch {
        return next();
      }
    });

    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Master Quiz KH server running on http://0.0.0.0:${PORT}`);

    // Auto-resume Telegram Command Bot if token was previously saved or set via env
    const savedState = loadBotStateFile();
    const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
    const tokenToResume =
      savedState && savedState.isRunning && savedState.botToken
        ? savedState.botToken
        : envToken;
    const resumeAppUrl =
      (savedState?.appUrl && isValidTelegramHttpsUrl(savedState.appUrl) ? savedState.appUrl : '') ||
      (process.env.APP_URL && isValidTelegramHttpsUrl(process.env.APP_URL) ? process.env.APP_URL : '');

    if (tokenToResume) {
      startCommandBotWorker(tokenToResume, resumeAppUrl).catch((err) => {
        console.warn('Could not auto-resume Telegram Command Bot:', err?.message || err);
      });
    }
  });
}

startServer();
