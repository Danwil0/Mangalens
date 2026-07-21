// ============================================================
//  MangaLens — Content Script
//  Watches pages for manga images, injects translation overlays
// ============================================================

(function () {
  'use strict';

  // ── Guard: prevent double-injection ──────────────────────
  if (window.__mangaLensLoaded) return;
  window.__mangaLensLoaded = true;

  // ── Constants ─────────────────────────────────────────────
  const PROCESSED_ATTR = 'data-ml-done';   // marks already-scanned imgs
  const MIN_PX = 250;              // min px dimension to consider
  const MAX_RATIO = 3.5;             // width/height — skip wide banners
  const BASE_DELAY_MS = 4200;            // default delay (matches 15 RPM + safety margin)
  const MIN_DELAY_MS = 4000;            // never go faster than this

  // RPM → delay lookup (ms), matches MODEL_RPM in background.js
  const RPM_TO_DELAY = {
    15: 4200,   // gemini-2.5-flash-lite, gemini-3.1-flash-lite
    10: 6200,   // gemini-2.5-flash, gemini-3.x-flash
    5: 12500,  // gemini-2.5-pro
  };

  // ── State ─────────────────────────────────────────────────
  let autoTranslate = true;
  let enabled = true;
  let intersectionObs;
  const overlayMap = new WeakMap();  // img → overlay div
  const triggerMap = new WeakMap();  // img → trigger button
  const loaderMap = new WeakMap();  // img → loader div
  let queue = [];
  let processing = false;
  let queueDelayMs = BASE_DELAY_MS;  // updated dynamically from API response

  // ── Boot ──────────────────────────────────────────────────
  loadSettings().then(boot);

  async function loadSettings() {
    return new Promise(resolve =>
      chrome.storage.local.get(['apiKey', 'enabled', 'autoTranslate'], resolve)
    );
  }

  async function boot(settings) {
    enabled = settings.enabled !== false;
    autoTranslate = settings.autoTranslate !== false;

    if (!enabled) return;

    setupIntersectionObserver();
    setupMutationObserver();
    scanImages(document.body);

    // Listen for setting changes from popup
    chrome.storage.onChanged.addListener(onStorageChange);

    // Listen for SPA navigation (MangaDex, etc.)
    window.addEventListener('popstate', handleNavigation);
    window.addEventListener('hashchange', handleNavigation);
    document.addEventListener('turbo:load', handleNavigation);
  }

  function onStorageChange(changes) {
    if ('enabled' in changes) enabled = changes.enabled.newValue !== false;
    if ('autoTranslate' in changes) autoTranslate = changes.autoTranslate.newValue !== false;
  }

  function handleNavigation() {
    // Remove old overlays/triggers that are now orphaned
    document.querySelectorAll('.ml-overlay, .ml-trigger, .ml-loader').forEach(el => el.remove());
    document.querySelectorAll('img[' + PROCESSED_ATTR + ']').forEach(resetImageState);
    setTimeout(() => scanImages(document.body), 500);
  }

  // ── Observers ─────────────────────────────────────────────

  function setupIntersectionObserver() {
    intersectionObs = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target;
        if (!isQualifiedImage(img)) continue;
        if (overlayMap.has(img) || loaderMap.has(img)) continue;

        if (autoTranslate && enabled) {
          enqueue(img);
        }
      }
    }, { threshold: 0.3 });
  }

  function setupMutationObserver() {
    const obs = new MutationObserver(mutations => {
      for (const m of mutations) {
        // New nodes added (lazy-load)
        for (const node of m.addedNodes) {
          if (node.nodeName === 'IMG') {
            scheduleProcess(node);
          } else if (node.querySelectorAll) {
            node.querySelectorAll('img').forEach(scheduleProcess);
          }
        }

        // Attributes changed (src, class, style, hidden)
        if (m.type === 'attributes') {
          let targetImg = null;
          if (m.target.nodeName === 'IMG') {
            targetImg = m.target;
          } else if (m.target.querySelector) {
            targetImg = m.target.querySelector('img');
          }

          if (targetImg) {
            if (m.attributeName === 'src') {
              if (targetImg.src === targetImg.dataset.mlInpaintedSrc || targetImg.src === targetImg.dataset.mlOriginalSrc) {
                return; // Ignore internal MangaLens src toggles
              }
              resetImageState(targetImg);
            }
            scheduleProcess(targetImg);
          }
        }
      }
    });

    obs.observe(document.body, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['src', 'class', 'style', 'hidden']
    });
  }

  // ── Image Scanning ─────────────────────────────────────────

  function scanImages(root) {
    root.querySelectorAll('img').forEach(scheduleProcess);
  }

  // Retries checking image loading until natural dimensions are ready
  function scheduleProcess(img) {
    if (!img || !img.isConnected) return;

    let retries = 0;
    const checkAndProcess = () => {
      if (!img.isConnected) return;

      // If image is still downloading or naturalWidth is 0, retry up to 20 times (4 seconds max)
      if ((!img.complete || img.naturalWidth === 0) && retries < 20) {
        retries++;
        setTimeout(checkAndProcess, 200);
        return;
      }

      processImage(img);
    };

    checkAndProcess();
  }

  function processImage(img) {
    if (img.getAttribute(PROCESSED_ATTR)) return;
    if (!isQualifiedImage(img)) return;

    img.setAttribute(PROCESSED_ATTR, '1');

    // Hover trigger button
    addTriggerButton(img);

    // Watch for viewport entry
    if (intersectionObs) intersectionObs.observe(img);

    // If autoTranslate is ON and image is in viewport, translate immediately!
    if (autoTranslate && enabled && isElementInViewport(img)) {
      enqueue(img);
    }
  }

  function isQualifiedImage(img) {
    if (!img || !img.isConnected) return false;

    const src = img.src || img.currentSrc || '';
    if (!src || src.startsWith('data:image/svg') || src === window.location.href) return false;

    // Must have valid natural dimensions
    const w = img.naturalWidth || img.offsetWidth || 0;
    const h = img.naturalHeight || img.offsetHeight || 0;

    if (w < MIN_PX || h < MIN_PX) return false;

    // Skip very wide banners and very thin strips
    const ratio = w / h;
    if (ratio > MAX_RATIO || ratio < (1 / MAX_RATIO)) return false;

    // Must be actually rendered and visible on screen (skips hidden preloaders)
    const rect = img.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 50) return false;

    const style = window.getComputedStyle(img);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) return false;

    return true;
  }

  // ── Trigger Button ─────────────────────────────────────────

  function addTriggerButton(img) {
    if (triggerMap.has(img)) return;

    const btn = document.createElement('button');
    btn.className = autoTranslate ? 'ml-trigger' : 'ml-trigger ml-trigger--visible';
    btn.title = 'Translate with MangaLens';
    btn.innerHTML = `
      <svg viewBox="0 0 20 20" fill="currentColor">
        <path d="M3 4a1 1 0 011-1h6a1 1 0 010 2H5.414l7.293 7.293a1 1 0 01-1.414 1.414L4 6.414V9a1 1 0 01-2 0V4z"/>
        <path d="M17 16a1 1 0 01-1 1h-6a1 1 0 010-2h3.586L6.293 7.707a1 1 0 011.414-1.414L15 13.586V11a1 1 0 012 0v5z"/>
      </svg>
      Translate
    `;

    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      onTriggerClick(img);
    });

    // Show/hide on img hover
    img.addEventListener('mouseenter', () => btn.classList.add('ml-trigger--visible'));
    img.addEventListener('mouseleave', () => {
      if (!btn.classList.contains('ml-trigger--done')) {
        btn.classList.remove('ml-trigger--visible');
      }
    });
    btn.addEventListener('mouseenter', () => btn.classList.add('ml-trigger--visible'));
    btn.addEventListener('mouseleave', () => {
      if (!btn.classList.contains('ml-trigger--done')) {
        btn.classList.remove('ml-trigger--visible');
      }
    });

    triggerMap.set(img, btn);

    positionElement(btn, img, 10, 10);
    trackPosition(btn, img);
  }

  function onTriggerClick(img) {
    if (overlayMap.has(img) || img.dataset.mlInpaintedSrc) {
      toggleOverlay(img);
    } else {
      translateImage(img);
    }
  }

  // ── Translation Queue ──────────────────────────────────────

  function enqueue(img) {
    if (queue.includes(img) || overlayMap.has(img) || loaderMap.has(img)) return;
    queue.push(img);
    if (!processing) drainQueue();
  }

  async function drainQueue() {
    processing = true;
    while (queue.length > 0) {
      const img = queue.shift();
      if (!img.isConnected) continue;
      if (!isQualifiedImage(img)) continue;
      if (overlayMap.has(img) || loaderMap.has(img)) continue;

      await translateImage(img);
      await sleep(queueDelayMs);   // dynamic delay based on model RPM
    }
    processing = false;
  }

  // ── Core: Translate a Single Image ────────────────────────

  async function translateImage(img) {
    if (!enabled) return;
    if (loaderMap.has(img)) return; // already in progress

    // If image has already been inpainted, just toggle visibility instead of re-translating!
    if (img.dataset.mlInpaintedSrc) {
      toggleOverlay(img);
      return;
    }

    const src = img.currentSrc || img.src;

    // Ensure the browser has actually painted the image to the screen
    // before we ask the background script to take a screenshot
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 100)));

    const rect = img.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    showLoader(img, rect);
    setTriggerState(img, 'loading');

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        action: 'translate',
        imgSrc: src,
        viewportRect: {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
          dpr: dpr
        }
      });
    } catch (e) {
      hideLoader(img);
      setTriggerState(img, 'error');
      showToast(`MangaLens: ${e.message}`);
      return;
    }

    hideLoader(img);

    if (!response || response.error) {
      const msg = response?.error || 'Unknown error';
      if (msg === 'NO_API_KEY') {
        showToast('MangaLens: No API key set — click the extension icon to add your Gemini API key.');
      } else if (msg.includes('limit: 0') || msg.includes('free-tier quota of 0')) {
        showToast('MangaLens: ⚠️ Key quota=0. Get a new key at aistudio.google.com/apikey (not Cloud Console!)');
      } else if (msg.includes('Rate limit hit')) {
        // Extract retry time and pause the queue
        const retryMatch = msg.match(/Retry in (\d+)s/);
        const waitMs = retryMatch ? parseInt(retryMatch[1]) * 1000 + 1000 : 60000;
        showToast(`MangaLens: Rate limit hit. Pausing ${Math.ceil(waitMs / 1000)}s then resuming…`);
        setTriggerState(img, 'error');
        hideLoader(img);
        // Re-queue this image after wait
        setTimeout(() => { queue.unshift(img); if (!processing) drainQueue(); }, waitMs);
        return;
      } else {
        showToast(`MangaLens: ${msg}`);
      }
      setTriggerState(img, 'error');
      return;
    }

    // Update queue delay from the model's actual RPM
    if (response.rpm) {
      queueDelayMs = RPM_TO_DELAY[response.rpm] || BASE_DELAY_MS;
    }

    const data = response.data;
    if (!data?.panels?.length) {
      setTriggerState(img, 'done');
      showNoTextNotice(img);
      return;
    }

    // Attempt Canvas Inpainting (Directly paints text over the manga image pixels!)
    const inpaintedDataUrl = await inpaintMangaImage(img, data.panels, response.base64);
    if (inpaintedDataUrl) {
      img.dataset.mlOriginalSrc = img.currentSrc || img.src;
      img.dataset.mlInpaintedSrc = inpaintedDataUrl;
      img.src = inpaintedDataUrl;
    }

    renderOverlay(img, data, !!inpaintedDataUrl);
    setTriggerState(img, 'done');
  }

  // ── Overlay Rendering ──────────────────────────────────────

  function renderOverlay(img, data, isInpainted = false) {
    removeOverlay(img);

    const { panels = [], language = '' } = data;

    const container = document.createElement('div');
    container.className = 'ml-overlay';
    positionElementOverImage(container, img);

    // Language badge
    if (language && language !== 'none') {
      const badge = document.createElement('div');
      badge.className = 'ml-lang-badge';
      badge.textContent = `${language} → EN`;
      container.appendChild(badge);
    }

    // Toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'ml-toggle-btn';
    toggleBtn.textContent = isInpainted ? '👁 Show Original' : '👁 Hide Overlay';
    toggleBtn.addEventListener('click', e => {
      e.stopPropagation();
      toggleOverlay(img);
    });
    container.appendChild(toggleBtn);

    if (isInpainted) {
      console.log(`[MangaLens] Canvas inpainting applied for ${panels.length} text blocks.`);
    } else {
      console.log(`[MangaLens] Rendering ${panels.length} HTML translated bubbles for image (lang: ${language})`);
    }

    if (!isInpainted) {

      for (const panel of panels) {
        if (!panel.translation) continue;

        const bubble = document.createElement('div');
        bubble.className = 'ml-bubble';
        bubble.textContent = panel.translation;
        bubble.dataset.original = panel.original || '';

        // English text needs more horizontal space than vertical Japanese/Vietnamese text.
        // If the original box is very tall and thin, we expand its width dynamically.
        let baseW = panel.width != null ? panel.width : 0.3;
        let baseH = panel.height != null ? panel.height : 0.08;

        if (baseH > baseW * 1.2) {
          baseW = Math.max(baseW * 1.8, 0.25); // Expand width significantly for vertical text
        }

        const x = clamp(panel.x != null ? panel.x : 0.1, 0.01, 0.85);
        const y = clamp(panel.y != null ? panel.y : 0.1, 0.01, 0.85);
        const w = clamp(baseW, 0.15, 0.98 - x);
        const h = clamp(baseH, 0.04, 0.98 - y);

        bubble.style.left = `${(x * 100).toFixed(2)}%`;
        bubble.style.top = `${(y * 100).toFixed(2)}%`;
        // Use minWidth so text can push it wider if absolutely necessary, but keep a base width
        bubble.style.width = `${(w * 100).toFixed(2)}%`;
        bubble.style.minHeight = `${(h * 100).toFixed(2)}%`;

        container.appendChild(bubble);
      }
    } // End of !isInpainted block

    if (panels.length === 0) {
      const notice = document.createElement('div');
      notice.className = 'ml-no-text';
      notice.textContent = '✓ No text detected';
      container.appendChild(notice);
    }

    overlayMap.set(img, container);

    // Keep overlay synced with image position
    trackPosition(container, img);
  }

  function toggleOverlay(img) {
    // If the image was natively inpainted into the <img> src:
    if (img.dataset.mlInpaintedSrc && img.dataset.mlOriginalSrc) {
      const isCurrentlyInpainted = img.src === img.dataset.mlInpaintedSrc;
      img.src = isCurrentlyInpainted ? img.dataset.mlOriginalSrc : img.dataset.mlInpaintedSrc;
    }

    const overlay = overlayMap.get(img);
    if (!overlay) return;

    const isHidden = overlay.classList.toggle('ml-hidden');
    const toggleBtn = overlay.querySelector('.ml-toggle-btn');
    const triggerBtn = triggerMap.get(img);

    if (isHidden) {
      if (toggleBtn) toggleBtn.textContent = img.dataset.mlInpaintedSrc ? '👁 Show Translation' : '👁 Show Overlay';
      if (triggerBtn) setTriggerState(img, 'done', 'Original');
    } else {
      if (toggleBtn) toggleBtn.textContent = img.dataset.mlInpaintedSrc ? '👁 Show Original' : '👁 Hide Overlay';
      if (triggerBtn) setTriggerState(img, 'done', 'Active');
    }
  }

  function removeOverlay(img) {
    const overlay = overlayMap.get(img);
    if (overlay) { overlay.remove(); overlayMap.delete(img); }
  }

  function resetImageState(img) {
    if (img.dataset.mlOriginalSrc && img.src === img.dataset.mlInpaintedSrc) {
      img.src = img.dataset.mlOriginalSrc;
    }
    delete img.dataset.mlOriginalSrc;
    delete img.dataset.mlInpaintedSrc;
    img.removeAttribute(PROCESSED_ATTR);
    removeOverlay(img);
    hideLoader(img);
    const trigger = triggerMap.get(img);
    if (trigger) {
      trigger.remove();
      triggerMap.delete(img);
    }
    const qIndex = queue.indexOf(img);
    if (qIndex > -1) queue.splice(qIndex, 1);
  }

  // ── Loader ─────────────────────────────────────────────────

  function showLoader(img) {
    hideLoader(img);
    const loader = document.createElement('div');
    loader.className = 'ml-loader';
    positionElementOverImage(loader, img);
    loader.innerHTML = `
      <div class="ml-loader-inner">
        <div class="ml-spinner"></div>
        <span>Translating…</span>
      </div>
    `;
    loaderMap.set(img, loader);
    trackPosition(loader, img);
  }

  function hideLoader(img) {
    const loader = loaderMap.get(img);
    if (loader) { loader.remove(); loaderMap.delete(img); }
  }

  // ── No-text notice ─────────────────────────────────────────

  function showNoTextNotice(img) {
    const overlay = overlayMap.get(img);
    const container = overlay || document.body;

    const notice = document.createElement('div');
    notice.className = 'ml-no-text';
    notice.textContent = '✓ No text found in this panel';

    if (overlay) {
      overlay.appendChild(notice);
    } else {
      const rect = img.getBoundingClientRect();
      notice.style.position = 'absolute';
      notice.style.top = `${rect.bottom + window.scrollY - 32}px`;
      notice.style.left = `${rect.left + window.scrollX + rect.width / 2}px`;
      document.body.appendChild(notice);
    }

    setTimeout(() => notice.remove(), 3000);
  }

  // ── Trigger Button States ──────────────────────────────────

  function setTriggerState(img, state, customLabel) {
    const btn = triggerMap.get(img);
    if (!btn) return;

    btn.classList.add('ml-trigger--done', 'ml-trigger--visible');

    const icons = {
      loading: `<svg class="ml-spin-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd"/></svg>`,
      done: `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>`,
      error: `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/></svg>`
    };
    const defaultLabels = { loading: 'Translating…', done: 'Translated ✓', error: 'Retry' };

    btn.innerHTML = `${icons[state] || icons.done} ${customLabel || defaultLabels[state] || 'Translated'}`;

    if (state === 'error') {
      btn.style.background = 'rgba(239,68,68,0.8)';
      btn.addEventListener('click', () => {
        btn.style.background = '';
        removeOverlay(img);
        translateImage(img);
      }, { once: true });
    }
  }

  // ── Toast ──────────────────────────────────────────────────

  function showToast(msg) {
    // Remove existing
    document.querySelector('.ml-error-toast')?.remove();

    const toast = document.createElement('div');
    toast.className = 'ml-error-toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 6000);
  }



  // Gets the exact bounding rect of the rendered image pixels, factoring in object-fit
  function getRenderedRect(img) {
    const rect = img.getBoundingClientRect();
    const style = window.getComputedStyle(img);
    const objectFit = style.objectFit;

    let renderWidth = rect.width;
    let renderHeight = rect.height;
    let offsetX = 0;
    let offsetY = 0;

    if ((objectFit === 'contain' || objectFit === 'scale-down') && img.naturalWidth && img.naturalHeight) {
      const imgRatio = img.naturalWidth / img.naturalHeight;
      const elRatio = rect.width / rect.height;

      let posX = 0.5, posY = 0.5;
      const objPos = style.objectPosition || '50% 50%';
      const parts = objPos.split(' ');
      const parsePos = (str) => {
        if (!str) return 0.5;
        if (str === 'left' || str === 'top') return 0;
        if (str === 'right' || str === 'bottom') return 1;
        if (str === 'center') return 0.5;
        if (str.endsWith('%')) return parseFloat(str) / 100;
        return 0.5; // fallback for px/calc
      };
      posX = parsePos(parts[0]);
      posY = parsePos(parts.length > 1 ? parts[1] : '50%');

      if (imgRatio > elRatio) {
        renderWidth = rect.width;
        renderHeight = rect.width / imgRatio;
        offsetY = (rect.height - renderHeight) * posY;
      } else {
        renderHeight = rect.height;
        renderWidth = rect.height * imgRatio;
        offsetX = (rect.width - renderWidth) * posX;
      }
    }

    return {
      top: rect.top + offsetY,
      left: rect.left + offsetX,
      width: renderWidth,
      height: renderHeight
    };
  }

  function positionElementOverImage(el, img) {
    const renderRect = getRenderedRect(img);

    el.style.position = 'absolute';
    el.style.top = `${renderRect.top + window.scrollY}px`;
    el.style.left = `${renderRect.left + window.scrollX}px`;
    el.style.width = `${renderRect.width}px`;
    el.style.height = `${renderRect.height}px`;

    if (!el.parentElement) {
      document.body.appendChild(el);
    }
  }

  function positionElement(el, img, offsetX = 10, offsetY = 10) {
    const renderRect = getRenderedRect(img);

    el.style.position = 'absolute';
    el.style.top = `${renderRect.top + window.scrollY + offsetY}px`;
    el.style.left = `${renderRect.left + window.scrollX + offsetX}px`;

    if (!el.parentElement) {
      document.body.appendChild(el);
    }
  }

  // Track element position as image resizes, scrolls, or is transformed
  function trackPosition(el, img) {
    let ticking = false;
    const update = () => {
      if (!el.isConnected || !img.isConnected) {
        if (!img.isConnected) resetImageState(img);
        return;
      }

      // Hide overlay if target image is currently hidden or off-screen
      const rect = img.getBoundingClientRect();
      const style = window.getComputedStyle(img);
      const isVisible = rect.width > 50 && rect.height > 50 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        parseFloat(style.opacity || '1') > 0;

      if (!isVisible) {
        el.style.display = 'none';
        const trigger = triggerMap.get(img);
        if (trigger) trigger.style.display = 'none';
        return;
      } else {
        el.style.display = '';
        const trigger = triggerMap.get(img);
        if (trigger) trigger.style.display = '';
      }

      if (!ticking) {
        requestAnimationFrame(() => {
          positionElementOverImage(el, img);

          // Also dynamically sync the hover trigger button if it exists
          const trigger = triggerMap.get(img);
          if (trigger && trigger.isConnected) {
            positionElement(trigger, img);
          }
          ticking = false;
        });
        ticking = true;
      }
    };

    window.addEventListener('resize', update, { passive: true });
    window.addEventListener('scroll', update, { passive: true, capture: true });

    const ro = new ResizeObserver(update);
    ro.observe(img);

    // Watch for CSS transform/translate panning on any ancestor
    const mo = new MutationObserver(update);
    let curr = img;
    while (curr && curr !== document.body) {
      mo.observe(curr, { attributes: true, attributeFilter: ['style', 'class'] });
      curr = curr.parentElement;
    }

    // Cleanup when element or image is removed
    const cleanObs = new MutationObserver(() => {
      if (!img.isConnected || !el.isConnected) {
        if (!img.isConnected) {
          resetImageState(img);
        }
        window.removeEventListener('resize', update);
        window.removeEventListener('scroll', update, { capture: true });
        ro.disconnect();
        mo.disconnect();
        cleanObs.disconnect();
      }
    });
    cleanObs.observe(document.body, { childList: true, subtree: true });

    // Force initial alignment
    update();
  }

  // ── Canvas Inpainting ──────────────────────────────────────

  async function inpaintMangaImage(img, panels, base64Src) {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      const tempImg = new Image();
      // Always use the raw original source image, never an already inpainted canvas image!
      const srcToUse = img.dataset.mlOriginalSrc
        || (base64Src ? `data:image/jpeg;base64,${base64Src}` : (img.currentSrc || img.src));

      if (!srcToUse.startsWith('data:')) {
        tempImg.crossOrigin = 'anonymous';
      }

      tempImg.onload = () => {
        const W = tempImg.naturalWidth || tempImg.width || 1000;
        const H = tempImg.naturalHeight || tempImg.height || 1400;

        canvas.width = W;
        canvas.height = H;

        // Draw original manga page onto canvas
        ctx.drawImage(tempImg, 0, 0, W, H);

        for (const panel of panels) {
          if (!panel.translation) continue;

          let baseW = panel.width != null ? panel.width : 0.3;
          let baseH = panel.height != null ? panel.height : 0.08;

          if (baseH > baseW * 1.2) {
            baseW = Math.max(baseW * 1.8, 0.25);
          }

          const xRatio = clamp(panel.x != null ? panel.x : 0.1, 0.01, 0.85);
          const yRatio = clamp(panel.y != null ? panel.y : 0.1, 0.01, 0.85);
          const wRatio = clamp(baseW, 0.15, 0.98 - xRatio);
          const hRatio = clamp(baseH, 0.04, 0.98 - yRatio);

          const x = xRatio * W;
          const y = yRatio * H;
          const w = wRatio * W;
          const h = hRatio * H;

          // 1. Erase Vietnamese/Japanese text by painting a white rounded rectangle over the speech bubble
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(x - 2, y - 2, w + 4, h + 4, 8);
          } else {
            ctx.rect(x - 2, y - 2, w + 4, h + 4);
          }
          ctx.fill();

          // 2. Render English translation text directly into the bubble
          drawTextInBox(ctx, panel.translation, x, y, w, h);
        }

        try {
          const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
          resolve(dataUrl);
        } catch (e) {
          console.warn('[MangaLens] Inpainting canvas failed:', e);
          resolve(null);
        }
      };

      tempImg.onerror = (err) => {
        console.warn('[MangaLens] TempImg load error:', err);
        resolve(null);
      };

      tempImg.src = srcToUse;
    });
  }

  function drawTextInBox(ctx, text, x, y, w, h) {
    ctx.save();

    const padding = Math.max(4, w * 0.03);
    const availW = w - padding * 2;
    const availH = h - padding * 2;

    // Calculate font size
    let fontSize = Math.min(availH * 0.28, availW * 0.14, 28);
    fontSize = Math.max(fontSize, 11);

    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const words = text.split(' ');
    let lines = [];
    let currentLine = '';

    for (let word of words) {
      ctx.font = `bold ${fontSize}px "CC Wild Words", "Comic Sans MS", "Wild Words", sans-serif`;
      let testLine = currentLine ? `${currentLine} ${word}` : word;
      if (ctx.measureText(testLine).width > availW && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) lines.push(currentLine);

    // If text spills out vertically, shrink font size slightly
    const lineHeight = fontSize * 1.2;
    if (lines.length * lineHeight > availH && fontSize > 10) {
      fontSize = Math.max(10, fontSize * 0.85);
      lines = [];
      currentLine = '';
      for (let word of words) {
        ctx.font = `bold ${fontSize}px "CC Wild Words", "Comic Sans MS", "Wild Words", sans-serif`;
        let testLine = currentLine ? `${currentLine} ${word}` : word;
        if (ctx.measureText(testLine).width > availW && currentLine) {
          lines.push(currentLine);
          currentLine = word;
        } else {
          currentLine = testLine;
        }
      }
      if (currentLine) lines.push(currentLine);
    }

    const totalH = lines.length * lineHeight;
    const startY = y + h / 2 - totalH / 2 + lineHeight / 2;

    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], x + w / 2, startY + i * lineHeight);
    }

    ctx.restore();
  }

  // ── Helpers ────────────────────────────────────────────────

  function isElementInViewport(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    const vH = window.innerHeight || document.documentElement.clientHeight;
    const vW = window.innerWidth || document.documentElement.clientWidth;

    return (
      rect.bottom > 0 &&
      rect.top < vH &&
      rect.right > 0 &&
      rect.left < vW &&
      rect.width >= 50 &&
      rect.height >= 50
    );
  }

  function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

})();
