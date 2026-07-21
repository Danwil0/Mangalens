// ============================================================
//  MangaLens — Background Service Worker
//  Handles: image fetching, Gemini API, caching, message routing
// ============================================================

const GEMINI_MODEL    = 'gemini-2.5-flash-lite';  // 15 RPM, 1000 req/day FREE — best for manga
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const CACHE_PREFIX    = 'ml_cache_';

// Rate limits per model (RPM) — used to set queue delay
const MODEL_RPM = {
  'gemini-2.5-flash-lite':  15,   // 1000 RPD
  'gemini-2.5-flash':       10,   // 250 RPD
  'gemini-2.5-pro':          5,   // 100 RPD
  'gemini-3.5-flash':       10,   // dynamic preview
  'gemini-3.1-flash':       10,
  'gemini-3.1-flash-lite':  15,
};

// Models to try in order if the primary fails
const MODEL_FALLBACKS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash',
  'gemini-3.1-flash-lite',
];

const TRANSLATE_PROMPT = `You are a professional manga/comic OCR and translation AI.
Examine this image carefully for ALL text, speech bubbles, thought bubbles, captions, titles, sound effects, and side text.
Detect the source language automatically (e.g. Vietnamese, Japanese, Korean, Chinese, Thai).

For EVERY piece of text found, locate its bounding box on a 1000x1000 normalized grid as [ymin, xmin, ymax, xmax].
Provide:
1. "original": The exact text in the original language
2. "translation": A natural, accurate English translation
3. "box_2d": [ymin, xmin, ymax, xmax] as integer coordinates between 0 and 1000.

Output MUST be strictly valid JSON without markdown code fences:
{
  "language": "Vietnamese",
  "panels": [
    {
      "original": "Text here",
      "translation": "English translation here",
      "box_2d": [120, 150, 280, 450]
    }
  ]
}

If no text is present in the image, return: {"language":"none","panels":[]}`;

// ─── Message Router ────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id ?? null;

  if (msg.action === 'translate') {
    handleTranslate(msg, tabId).then(sendResponse).catch(err =>
      sendResponse({ error: err.message })
    );
    return true; // keep channel open for async
  }

  if (msg.action === 'getStats') {
    getStats().then(sendResponse);
    return true;
  }

  if (msg.action === 'clearCache') {
    clearCache().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.action === 'listModels') {
    listAvailableModels(msg.apiKey).then(sendResponse);
    return true;
  }
});

// ─── Main Translate Handler ────────────────────────────────

async function handleTranslate({ imgSrc, viewportRect }, tabId) {
  // 1. Check API key and settings
  let { apiKey, enabled, model } = await storageGet(['apiKey', 'enabled', 'model']);
  if (enabled === false) return { error: 'MangaLens is disabled.' };
  if (!apiKey)           return { error: 'NO_API_KEY' };

  // Auto-migrate deprecated saved model
  if (model === 'gemini-2.5-flash') {
    model = 'gemini-2.5-flash-lite';
    await storageSet({ model });
  }

  let selectedModel = model || GEMINI_MODEL;

  // 2. Fetch image as base64 (we need it even for cached results for canvas inpainting)
  let base64, mimeType;
  try {
    ({ base64, mimeType } = await fetchImage(imgSrc, tabId, viewportRect));
  } catch (e) {
    console.error('[MangaLens] Image fetch failed:', e.message);
    // If fetch fails, we'll return undefined base64, and content.js will fallback to HTML bubbles
  }

  // 3. Check cache
  const cacheKey = CACHE_PREFIX + hashStr(imgSrc || '').slice(0, 60);
  const cached   = await storageGet([cacheKey]);
  if (cached[cacheKey]) {
    console.log('[MangaLens] Cache hit');
    return { ok: true, data: cached[cacheKey], fromCache: true, base64 };
  }

  // 4. Call Gemini with automatic model fallbacks
  const modelsToTry = Array.from(new Set([selectedModel, ...MODEL_FALLBACKS]));
  let lastError;
  let result;
  let workingModel = selectedModel;

  for (const candidateModel of modelsToTry) {
    try {
      console.log(`[MangaLens] Trying model: ${candidateModel}`);
      result = await callGemini(base64, mimeType, apiKey, candidateModel);
      workingModel = candidateModel;
      lastError = null;
      break; // Success!
    } catch (e) {
      lastError = e;
      console.warn(`[MangaLens] Model ${candidateModel} failed:`, e.message);

      // If it's an API key error or quota=0 error, don't keep trying other models
      if (e.message.includes('Invalid API key') || e.message.includes('quota of 0')) {
        return { error: e.message };
      }
      // If 404 (deprecated/not found) or 503 (overloaded) or abort, continue loop to try next model
    }
  }

  if (lastError || !result) {
    console.error('[MangaLens] All models failed:', lastError?.message);
    return { error: lastError?.message || 'All models failed.' };
  }

  // If fallback changed the model, save it for future calls
  if (workingModel !== model) {
    console.log(`[MangaLens] Auto-switching saved model to: ${workingModel}`);
    await storageSet({ model: workingModel });
  }

  const rpm = MODEL_RPM[workingModel] || 10;

  // 5. Cache + stats
  await storageSet({ [cacheKey]: result });
  await incrementCount();

  return { ok: true, data: result, model: workingModel, rpm, base64 };
}

// ─── Image Fetching ────────────────────────────────────────

async function fetchImage(imgSrc, tabId, viewportRect) {
  // Method A: Direct fetch (works for most CDNs via extension context)
  if (imgSrc && !imgSrc.startsWith('blob:') && !imgSrc.startsWith('data:')) {
    try {
      const resp = await fetchWithTimeout(imgSrc, 12000);
      if (resp.ok) {
        const blob    = await resp.blob();
        const base64  = await blobToBase64(blob);
        const mimeType = detectMime(imgSrc, blob.type);
        return { base64, mimeType };
      }
    } catch (e) {
      console.warn('[MangaLens] Direct fetch failed, using captureVisibleTab:', e.message);
    }
  }

  // Method B: captureVisibleTab + crop (handles blob: URLs, CORS-blocked CDNs)
  if (tabId && viewportRect) {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 88 });
    const base64  = await cropScreenshot(dataUrl, viewportRect);
    return { base64, mimeType: 'image/jpeg' };
  }

  throw new Error('No accessible image source. Try scrolling so the panel is fully visible.');
}

async function fetchWithTimeout(url, ms, options = {}) {
  const ctrl = new AbortController();
  const id   = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError' || e.message?.includes('aborted')) {
      throw new Error(`Request timed out after ${Math.round(ms/1000)}s.`);
    }
    throw e;
  } finally {
    clearTimeout(id);
  }
}

async function cropScreenshot(dataUrl, rect) {
  const { x, y, width, height, dpr = 1 } = rect;

  const resp   = await fetch(dataUrl);
  const blob   = await resp.blob();
  const bitmap = await createImageBitmap(blob);

  // Clamp crop rectangle strictly inside bitmap dimensions
  const cropX = Math.max(0, Math.min(bitmap.width - 1, Math.round(x * dpr)));
  const cropY = Math.max(0, Math.min(bitmap.height - 1, Math.round(y * dpr)));
  const cropW = Math.max(1, Math.min(bitmap.width - cropX, Math.round(width * dpr)));
  const cropH = Math.max(1, Math.min(bitmap.height - cropY, Math.round(height * dpr)));

  const canvas = new OffscreenCanvas(cropW, cropH);
  const ctx    = canvas.getContext('2d');
  ctx.drawImage(bitmap, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

  const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  return await blobToBase64(outBlob);
}

async function blobToBase64(blob) {
  const buf   = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary  = '';
  // chunk to avoid stack overflow on large images
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function detectMime(url, blobType) {
  if (blobType && blobType !== 'application/octet-stream') return blobType;
  const lc = url.toLowerCase();
  if (lc.includes('.png'))  return 'image/png';
  if (lc.includes('.webp')) return 'image/webp';
  if (lc.includes('.gif'))  return 'image/gif';
  return 'image/jpeg';
}

// ─── Gemini API ────────────────────────────────────────────

async function callGemini(base64, mimeType, apiKey, modelName = 'gemini-2.5-flash') {
  const url  = `${GEMINI_BASE_URL}/${modelName}:generateContent?key=${apiKey}`;
  console.log(`[MangaLens] Calling Gemini → ${modelName}  url=${url.replace(apiKey, 'KEY_HIDDEN')}`);

  // NOTE: responseMimeType removed — it causes 400 errors on some model/key combos.
  // We parse JSON from the raw text response instead.
  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: base64 } },
        { text: TRANSLATE_PROMPT }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      topP: 0.8
    }
  };

  const resp = await fetchWithTimeout(url, 30000, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errJson = await resp.json().catch(() => ({}));
    const msg = errJson?.error?.message || `HTTP ${resp.status}`;
    console.error(`[MangaLens] API error ${resp.status}:`, msg);

    if (resp.status === 400) throw new Error(`Bad request: ${msg}`);
    if (resp.status === 401 || resp.status === 403) throw new Error(`Invalid API key — re-enter your key in the MangaLens popup.`);
    if (resp.status === 404) {
      if (msg.includes('no longer available to new users')) {
        throw new Error(`Model "${modelName}" is deprecated. Click 🔍 in the popup to find working models for your key.`);
      }
      throw new Error(`Model "${modelName}" not found. Click 🔍 in the popup to discover available models.`);
    }
    if (resp.status === 429) {
      // Detect limit:0 — means billing-project key with no free quota
      if (msg.includes('limit: 0')) {
        throw new Error(
          'Your API key has a free-tier quota of 0. This happens when your key is from a billing-enabled Google Cloud project. ' +
          'Fix: Go to aistudio.google.com/apikey and create a fresh key there (it will have the real free quota).'
        );
      }
      const retryMatch = msg.match(/(\d+\.\d+)s/);
      const wait = retryMatch ? ` Retry in ${Math.ceil(parseFloat(retryMatch[1]))}s.` : '';
      throw new Error(`Rate limit hit.${wait} Auto-translate will retry.`);
    }
    if (resp.status === 503) throw new Error(`Gemini is overloaded — will retry shortly.`);
    throw new Error(`Gemini error ${resp.status}: ${msg}`);
  }

  const json = await resp.json();
  const raw  = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('Empty response from Gemini. The image may be too large or contain no text.');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Gemini sometimes wraps in markdown code fences despite instructions
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) parsed = JSON.parse(match[0]);
    else throw new Error('Could not parse Gemini response as JSON.');
  }

  // Convert box_2d [ymin, xmin, ymax, xmax] (0-1000 integer scale) to x, y, width, height floats (0-1)
  if (parsed && Array.isArray(parsed.panels)) {
    for (const panel of parsed.panels) {
      if (panel.box_2d && Array.isArray(panel.box_2d) && panel.box_2d.length === 4) {
        const [ymin, xmin, ymax, xmax] = panel.box_2d;
        panel.x      = Math.max(0, Math.min(1, xmin / 1000));
        panel.y      = Math.max(0, Math.min(1, ymin / 1000));
        panel.width  = Math.max(0.02, Math.min(1 - panel.x, (xmax - xmin) / 1000));
        panel.height = Math.max(0.02, Math.min(1 - panel.y, (ymax - ymin) / 1000));
      }
    }
  }

  return parsed;
}

// ─── Stats & Cache ─────────────────────────────────────────

async function incrementCount() {
  const today = new Date().toDateString();
  const data  = await storageGet(['ml_date', 'ml_today', 'ml_total']);
  const isNew = data.ml_date !== today;
  await storageSet({
    ml_date:  today,
    ml_today: isNew ? 1 : (data.ml_today || 0) + 1,
    ml_total: (data.ml_total || 0) + 1
  });
}

async function getStats() {
  const today = new Date().toDateString();
  const all   = await storageGet(null);
  const cacheKeys = Object.keys(all).filter(k => k.startsWith(CACHE_PREFIX));
  const isNew = all.ml_date !== today;
  return {
    today:      isNew ? 0 : (all.ml_today || 0),
    total:      all.ml_total || 0,
    cacheCount: cacheKeys.length
  };
}

async function clearCache() {
  const all       = await storageGet(null);
  const cacheKeys = Object.keys(all).filter(k => k.startsWith(CACHE_PREFIX));
  if (cacheKeys.length) await chrome.storage.local.remove(cacheKeys);
}

// ─── Utilities ─────────────────────────────────────────────

function storageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}
function storageSet(obj) {
  return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}

function hashStr(str) {
  // Simple hash for cache key (not cryptographic)
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  // Make positive and combine with the URL tail for readability
  return Math.abs(h).toString(36) + '_' + str.slice(-20).replace(/[^a-z0-9]/gi, '_');
}

// ─── List available models for this API key ─────────────────

async function listAvailableModels(apiKey) {
  if (!apiKey) return { error: 'No API key provided' };
  try {
    const url  = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=50`;
    const resp = await fetchWithTimeout(url, 10000, { method: 'GET' });

    if (!resp.ok) {
      const errJson = await resp.json().catch(() => ({}));
      const msg = errJson?.error?.message || `HTTP ${resp.status}`;
      return { error: `Could not list models: ${msg}` };
    }

    const data   = await resp.json();
    const models = (data.models || [])
      .filter(m => {
        // Must support generateContent
        if (!m.supportedGenerationMethods?.includes('generateContent')) return false;
        const name = (m.name || '').toLowerCase();
        // Exclude image-generation models (not for translation)
        if (name.endsWith('-image'))              return false;
        if (name.includes('imagen'))              return false;
        if (name.includes('-image-generation'))   return false;
        if (name.includes('preview-image'))       return false;
        // Exclude embedding and other non-chat models
        if (name.includes('embedding'))           return false;
        if (name.includes('aqa'))                 return false;
        return true;
      })
      .map(m => ({
        name:        m.name.replace('models/', ''),
        displayName: m.displayName || m.name,
        inputLimit:  m.inputTokenLimit || 0
      }))
      .sort((a, b) => {
        // Prefer newer/higher version numbers first
        return b.name.localeCompare(a.name);
      });

    console.log('[MangaLens] Vision models available:', models.map(m => m.name));
    return { models };
  } catch (e) {
    return { error: `listModels failed: ${e.message}` };
  }
}
