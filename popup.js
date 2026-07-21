// ============================================================
//  MangaLens — Popup Script
// ============================================================

// ── DOM refs ────────────────────────────────────────────────
const toggleEnabled  = document.getElementById('toggle-enabled');
const toggleAuto     = document.getElementById('toggle-auto');
const modelSelect    = document.getElementById('model-select');
const customModelIn  = document.getElementById('custom-model-input');
const checkModelsBtn = document.getElementById('check-models-btn');
const modelStatus    = document.getElementById('model-status');
const apiKeyInput   = document.getElementById('api-key');
const toggleKeyVis  = document.getElementById('toggle-key-vis');
const keyDot        = document.getElementById('key-dot');
const keyStatusText = document.getElementById('key-status-text');
const saveKeyBtn    = document.getElementById('save-key');
const clearCacheBtn = document.getElementById('clear-cache');
const reloadTabBtn  = document.getElementById('reload-tab');
const disabledBanner= document.getElementById('disabled-banner');
const statToday     = document.getElementById('stat-today');
const statTotal     = document.getElementById('stat-total');
const statCache     = document.getElementById('stat-cache');
const studioLink    = document.getElementById('studio-link');

// ── Boot ────────────────────────────────────────────────────

(async function boot() {
  const settings = await storageGet(['apiKey', 'enabled', 'autoTranslate', 'model']);

  // Apply saved settings to UI
  toggleEnabled.checked = settings.enabled !== false;
  toggleAuto.checked    = settings.autoTranslate !== false;

  // Restore saved model — handle custom value
  const savedModel = settings.model || 'gemini-2.5-flash-lite';
  const knownOpts  = ['gemini-2.5-flash-lite','gemini-2.5-flash','gemini-2.5-pro',
                      'gemini-3.5-flash','gemini-3.1-flash','gemini-3.1-flash-lite'];
  if (knownOpts.includes(savedModel)) {
    modelSelect.value = savedModel;
  } else {
    // It's a custom model name saved previously
    modelSelect.value           = 'custom';
    customModelIn.value         = savedModel;
    customModelIn.style.display = 'block';
  }

  if (settings.apiKey) {
    apiKeyInput.value = settings.apiKey;
    setKeyStatus(true, `Key saved (${maskKey(settings.apiKey)})`);
  }

  updateDisabledBanner();
  await loadStats();
})();

// ── Event Listeners ──────────────────────────────────────────

toggleEnabled.addEventListener('change', async () => {
  await storageSet({ enabled: toggleEnabled.checked });
  updateDisabledBanner();
  notifyContentScript();
});

toggleAuto.addEventListener('change', async () => {
  await storageSet({ autoTranslate: toggleAuto.checked });
  notifyContentScript();
});

modelSelect.addEventListener('change', async () => {
  if (modelSelect.value === 'custom') {
    customModelIn.style.display = 'block';
    customModelIn.focus();
  } else {
    customModelIn.style.display = 'none';
    await storageSet({ model: modelSelect.value });
    modelStatus.textContent = `✓ Saved: ${modelSelect.value}`;
    modelStatus.style.color = '#22c55e';
    setTimeout(() => { modelStatus.textContent = ''; }, 2000);
  }
});

customModelIn.addEventListener('change', async () => {
  const val = customModelIn.value.trim();
  if (val) {
    await storageSet({ model: val });
    modelStatus.textContent = `✓ Custom model saved: ${val}`;
    modelStatus.style.color = '#22c55e';
    setTimeout(() => { modelStatus.textContent = ''; }, 2500);
  }
});

// API key: save on button click
saveKeyBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    setKeyStatus(false, 'Please enter an API key');
    shake(apiKeyInput);
    return;
  }
  if (!key.startsWith('AI') && key.length < 30) {
    setKeyStatus(false, 'Key looks invalid — Gemini keys start with "AI"');
    return;
  }

  await storageSet({ apiKey: key });
  setKeyStatus(true, `Saved ✓  (${maskKey(key)})`);

  saveKeyBtn.textContent = '✓ Saved!';
  saveKeyBtn.classList.add('saved');
  setTimeout(() => {
    saveKeyBtn.textContent = 'Save API Key';
    saveKeyBtn.classList.remove('saved');
  }, 2000);
});

// Show / hide key
toggleKeyVis.addEventListener('click', () => {
  const isPassword = apiKeyInput.type === 'password';
  apiKeyInput.type = isPassword ? 'text' : 'password';
  toggleKeyVis.querySelector('svg').innerHTML = isPassword
    ? `<path fill-rule="evenodd" d="M3.707 2.293a1 1 0 00-1.414 1.414l14 14a1 1 0 001.414-1.414l-1.473-1.473A10.014 10.014 0 0019.542 10C18.268 5.943 14.478 3 10 3a9.958 9.958 0 00-4.512 1.074l-1.78-1.781zm4.261 4.26l1.514 1.515a2.003 2.003 0 012.45 2.45l1.514 1.514a4 4 0 00-5.478-5.478z" clip-rule="evenodd"/><path d="M12.454 16.697L9.75 13.992a4 4 0 01-3.742-3.741L2.335 6.578A9.98 9.98 0 00.458 10c1.274 4.057 5.064 7 9.542 7 .847 0 1.669-.105 2.454-.303z"/>`
    : `<path d="M10 12a2 2 0 100-4 2 2 0 000 4z"/><path fill-rule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clip-rule="evenodd"/>`;
});

// Clear cache
clearCacheBtn.addEventListener('click', async () => {
  clearCacheBtn.textContent = '🗑 Clearing…';
  clearCacheBtn.disabled = true;
  await chrome.runtime.sendMessage({ action: 'clearCache' });
  await loadStats();
  clearCacheBtn.textContent = '✓ Cleared!';
  setTimeout(() => {
    clearCacheBtn.textContent = '🗑 Clear Cache';
    clearCacheBtn.disabled = false;
  }, 2000);
});

// Check which models are actually available with this key
checkModelsBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim() || (await storageGet(['apiKey'])).apiKey;
  if (!key) {
    modelStatus.textContent = '⚠️ Save your API key first.';
    modelStatus.style.color = '#fca5a5';
    return;
  }

  checkModelsBtn.textContent = '⏳';
  checkModelsBtn.disabled = true;
  modelStatus.textContent = 'Fetching available models…';
  modelStatus.style.color = '#888';

  const result = await chrome.runtime.sendMessage({ action: 'listModels', apiKey: key });

  checkModelsBtn.textContent = '🔍';
  checkModelsBtn.disabled = false;

  if (result.error) {
    modelStatus.textContent = '❌ ' + result.error;
    modelStatus.style.color = '#fca5a5';
    return;
  }

  const models = result.models || [];
  if (models.length === 0) {
    modelStatus.textContent = 'No generateContent models found for this key.';
    modelStatus.style.color = '#fca5a5';
    return;
  }

  // Rebuild the dropdown with real available models
  const currentVal = modelSelect.value;
  modelSelect.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.name;
    opt.textContent = m.name;
    if (m.name === currentVal) opt.selected = true;
    modelSelect.appendChild(opt);
  }

  // Auto-select a good default
  const preferred = ['gemini-2.5-flash','gemini-2.0-flash','gemini-1.5-flash'];
  if (!models.find(m => m.name === currentVal)) {
    const best = preferred.find(p => models.find(m => m.name === p));
    if (best) modelSelect.value = best;
  }

  // Save the chosen model
  await storageSet({ model: modelSelect.value });

  modelStatus.textContent = `✅ ${models.length} models found. Selected: ${modelSelect.value}`;
  modelStatus.style.color = '#22c55e';
});

// Reload active tab
reloadTabBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.reload(tab.id);
    window.close();
  }
});

// Open AI Studio link in new tab (popup links don't open by default)
studioLink.addEventListener('click', e => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://aistudio.google.com/apikey' });
});

// ── Helpers ──────────────────────────────────────────────────

async function loadStats() {
  const stats = await chrome.runtime.sendMessage({ action: 'getStats' });
  statToday.textContent = stats?.today   ?? '—';
  statTotal.textContent = stats?.total   ?? '—';
  statCache.textContent = stats?.cacheCount ?? '—';
}

function setKeyStatus(valid, msg) {
  keyDot.className = `status-dot ${valid ? 'valid' : 'invalid'}`;
  keyStatusText.textContent = msg;
}

function maskKey(key) {
  if (!key || key.length < 8) return '****';
  return key.slice(0, 4) + '…' + key.slice(-4);
}

function updateDisabledBanner() {
  disabledBanner.classList.toggle('visible', !toggleEnabled.checked);
}

function notifyContentScript() {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        action: 'settingsChanged',
        enabled:       toggleEnabled.checked,
        autoTranslate: toggleAuto.checked
      }).catch(() => {}); // tab might not have the content script
    }
  });
}

function shake(el) {
  el.style.animation = 'none';
  el.offsetHeight; // reflow
  el.style.animation = 'ml-shake 0.4s ease';
  setTimeout(() => el.style.animation = '', 500);
}

function storageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function storageSet(obj) {
  return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}
