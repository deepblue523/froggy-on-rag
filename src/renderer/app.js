// Global state
let currentCanvas = null;
let splitterPosition = 250;
let searchSplitterPosition = 300; // Height for horizontal splitter in search
let chunkDetailSplitterPosition = 300; // Width for vertical splitter in chunk details
let vectorStoreSplitterPosition = 280; // Height of documents panel (top) in vector store
let mruSearches = [];
let selectedDocumentId = null;
let selectedChunkId = null;
let expandedDirectories = new Set(); // Track which directories are expanded
let searchCancelled = false; // Track if search was cancelled
let searchTimerInterval = null; // Timer interval for updating search time
let searchStartTime = null; // Start time of current search
let namespaceSelectProgrammatic = false;
/** @type {string | null} */
let llmPassthroughReplyBlobUrl = null;

const LLM_PASSTHROUGH_SEND_DEFAULT_LABEL = 'Send (RAG on latest turn)';
let llmPassthroughSendInFlight = false;
/** @type {null | (() => void)} */
let llmPassthroughSendCancelFn = null;
let llmPassthroughSendUserCancelled = false;

const LLM_INBOUND_TEST_HOST_MRU_MAX = 5;
/** Select value for "type a host not in the MRU list" */
const LLM_INBOUND_TEST_HOST_MRU_NEW = '__mru_new__';

const LLM_TESTER_CHATS_KEY = 'froggyLlmTesterChatsV1';
const LLM_TESTER_MAX_CHATS = 35;
const LLM_TESTER_MAX_MESSAGES = 100;

function randomLlmTesterChatId() {
  return `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function sanitizeLlmTesterMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null;
    if (!role) continue;
    const content = typeof m.content === 'string' ? m.content : '';
    if (!content.trim()) continue;
    out.push({ role, content });
  }
  return out;
}

function createDefaultLlmTesterChatStore() {
  const id = randomLlmTesterChatId();
  return {
    v: 1,
    activeId: id,
    chats: [{ id, title: 'New chat', updatedAt: Date.now(), messages: [] }]
  };
}

function trimLlmTesterChatStore(store) {
  store.chats = (store.chats || []).filter((c) => c && c.id);
  store.chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (store.chats.length > LLM_TESTER_MAX_CHATS) {
    store.chats = store.chats.slice(0, LLM_TESTER_MAX_CHATS);
  }
  if (!store.chats.length) {
    const d = createDefaultLlmTesterChatStore();
    store.v = d.v;
    store.activeId = d.activeId;
    store.chats = d.chats;
    return;
  }
  if (!store.chats.some((c) => c.id === store.activeId)) {
    store.activeId = store.chats[0].id;
  }
  for (const c of store.chats) {
    if (c.messages.length > LLM_TESTER_MAX_MESSAGES) {
      c.messages = c.messages.slice(-LLM_TESTER_MAX_MESSAGES);
    }
  }
}

function loadLlmTesterChatStore() {
  try {
    const raw = localStorage.getItem(LLM_TESTER_CHATS_KEY);
    if (!raw) return createDefaultLlmTesterChatStore();
    const o = JSON.parse(raw);
    if (!o || o.v !== 1 || !Array.isArray(o.chats) || !o.chats.length) {
      return createDefaultLlmTesterChatStore();
    }
    for (const c of o.chats) {
      if (!c || typeof c.id !== 'string') return createDefaultLlmTesterChatStore();
      c.messages = sanitizeLlmTesterMessages(c.messages);
      if (typeof c.title !== 'string' || !c.title.trim()) c.title = 'Chat';
      if (!Number.isFinite(c.updatedAt)) c.updatedAt = Date.now();
    }
    if (!o.chats.some((c) => c.id === o.activeId)) {
      o.activeId = o.chats[0].id;
    }
    trimLlmTesterChatStore(o);
    return o;
  } catch {
    return createDefaultLlmTesterChatStore();
  }
}

function saveLlmTesterChatStore(store) {
  trimLlmTesterChatStore(store);
  try {
    localStorage.setItem(LLM_TESTER_CHATS_KEY, JSON.stringify(store));
  } catch (e) {
    console.warn('saveLlmTesterChatStore', e);
  }
}

function getActiveLlmTesterChatEntry(store) {
  const c = store.chats.find((x) => x.id === store.activeId);
  return c || store.chats[0] || null;
}

function maybeUpgradeLlmTesterTitleFromMessages(chat) {
  const t = (chat.title || '').trim().toLowerCase();
  if (t && t !== 'new chat') return;
  const firstUser = chat.messages.find((m) => m.role === 'user');
  if (!firstUser || !firstUser.content.trim()) return;
  const line = firstUser.content.trim().split(/\r?\n/)[0];
  chat.title = line.length <= 52 ? line : `${line.slice(0, 49)}…`;
}

let llmTesterChatSelectListenerBound = false;
let llmCanvasTabsListenerBound = false;

function renderLlmTesterChatSelect() {
  const sel = document.getElementById('llm-tester-chat-select');
  if (!sel) return;
  const store = loadLlmTesterChatStore();
  const sorted = [...store.chats].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  sel.replaceChildren();
  for (const c of sorted) {
    const opt = document.createElement('option');
    opt.value = c.id;
    const d = new Date(c.updatedAt);
    const timeStr = d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    opt.textContent = `${c.title || 'Chat'} — ${timeStr}`;
    sel.appendChild(opt);
  }
  if (!sorted.some((c) => c.id === store.activeId) && sorted.length) {
    store.activeId = sorted[0].id;
    saveLlmTesterChatStore(store);
  }
  sel.value = store.activeId;
}

function renderLlmTesterTranscript() {
  const wrap = document.getElementById('llm-tester-transcript');
  if (!wrap) return;
  wrap.replaceChildren();
  const store = loadLlmTesterChatStore();
  const chat = getActiveLlmTesterChatEntry(store);
  if (!chat || !chat.messages.length) {
    const p = document.createElement('p');
    p.className = 'llm-tester-transcript-empty';
    p.textContent = 'No messages yet. Type below and send to start.';
    wrap.appendChild(p);
    return;
  }
  for (const m of chat.messages) {
    const row = document.createElement('div');
    const isAsst = m.role === 'assistant';
    row.className = `llm-tester-transcript-msg llm-tester-transcript-msg-${
      isAsst ? 'assistant' : 'user'
    }`;
    const label = document.createElement('div');
    label.className = 'llm-tester-transcript-label';
    label.textContent = isAsst ? 'Assistant' : 'You';
    const body = document.createElement('div');
    body.className = 'llm-tester-transcript-body';
    body.textContent = m.content;
    row.appendChild(label);
    row.appendChild(body);
    wrap.appendChild(row);
  }
  wrap.scrollTop = wrap.scrollHeight;
}

async function refreshLlmTesterLastReplyFromMessages() {
  const store = loadLlmTesterChatStore();
  const chat = getActiveLlmTesterChatEntry(store);
  let last = '';
  if (chat) {
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i].role === 'assistant') {
        last = chat.messages[i].content;
        break;
      }
    }
  }
  if (last && String(last).trim()) {
    await setLlmPassthroughReplyMarkdown(last);
  } else {
    clearLlmPassthroughReply();
  }
}

function refreshLlmTesterChatPanel() {
  renderLlmTesterChatSelect();
  renderLlmTesterTranscript();
  void refreshLlmTesterLastReplyFromMessages();
}

function setupLlmCanvasTabsOnce() {
  if (llmCanvasTabsListenerBound) return;
  const btnSettings = document.getElementById('llm-canvas-tab-settings-btn');
  const btnChat = document.getElementById('llm-canvas-tab-chat-btn');
  const panelSettings = document.getElementById('llm-canvas-panel-settings');
  const panelChat = document.getElementById('llm-canvas-panel-chat');
  if (!btnSettings || !btnChat || !panelSettings || !panelChat) return;
  llmCanvasTabsListenerBound = true;

  /**
   * @param {'settings' | 'chat'} which
   */
  function activateLlmCanvasTab(which) {
    const chat = which === 'chat';
    btnSettings.classList.toggle('is-active', !chat);
    btnChat.classList.toggle('is-active', chat);
    btnSettings.setAttribute('aria-selected', chat ? 'false' : 'true');
    btnChat.setAttribute('aria-selected', chat ? 'true' : 'false');
    btnSettings.tabIndex = chat ? -1 : 0;
    btnChat.tabIndex = chat ? 0 : -1;
    panelSettings.hidden = chat;
    panelChat.hidden = !chat;
  }

  btnSettings.addEventListener('click', () => activateLlmCanvasTab('settings'));
  btnChat.addEventListener('click', () => activateLlmCanvasTab('chat'));

  btnSettings.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      activateLlmCanvasTab('chat');
      btnChat.focus();
    }
  });
  btnChat.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      activateLlmCanvasTab('settings');
      btnSettings.focus();
    }
  });
}

function setupLlmTesterChatControlsOnce() {
  if (llmTesterChatSelectListenerBound) return;
  llmTesterChatSelectListenerBound = true;
  const sel = document.getElementById('llm-tester-chat-select');
  if (sel) {
    sel.addEventListener('change', () => {
      const store = loadLlmTesterChatStore();
      const id = sel.value;
      if (!id || !store.chats.some((c) => c.id === id)) return;
      store.activeId = id;
      saveLlmTesterChatStore(store);
      const pe = document.getElementById('llm-passthrough-prompt');
      if (pe) pe.value = '';
      renderLlmTesterTranscript();
      void refreshLlmTesterLastReplyFromMessages();
    });
  }
  const newBtn = document.getElementById('llm-tester-new-chat-btn');
  if (newBtn) {
    newBtn.addEventListener('click', () => {
      const store = loadLlmTesterChatStore();
      const id = randomLlmTesterChatId();
      store.chats.push({
        id,
        title: 'New chat',
        updatedAt: Date.now(),
        messages: []
      });
      store.activeId = id;
      saveLlmTesterChatStore(store);
      const pe = document.getElementById('llm-passthrough-prompt');
      if (pe) pe.value = '';
      refreshLlmTesterChatPanel();
    });
  }
  const clearBtn = document.getElementById('llm-tester-clear-turns-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      const store = loadLlmTesterChatStore();
      const chat = getActiveLlmTesterChatEntry(store);
      if (!chat) return;
      chat.messages = [];
      chat.updatedAt = Date.now();
      chat.title = 'New chat';
      saveLlmTesterChatStore(store);
      clearLlmPassthroughReply();
      refreshLlmTesterChatPanel();
    });
  }
}

function clearLlmPassthroughReply() {
  const el = document.getElementById('llm-passthrough-reply');
  if (llmPassthroughReplyBlobUrl) {
    URL.revokeObjectURL(llmPassthroughReplyBlobUrl);
    llmPassthroughReplyBlobUrl = null;
  }
  if (el) el.replaceChildren();
}

async function setLlmPassthroughReplyMarkdown(markdown) {
  const el = document.getElementById('llm-passthrough-reply');
  if (!el) return;
  clearLlmPassthroughReply();
  const raw = typeof markdown === 'string' ? markdown : '';
  if (!window.electronAPI || typeof window.electronAPI.renderMarkdown !== 'function') {
    el.textContent = raw;
    return;
  }
  let doc;
  try {
    doc = await window.electronAPI.renderMarkdown(raw);
  } catch {
    doc = null;
  }
  if (!doc || typeof doc !== 'string') {
    el.textContent = raw;
    return;
  }
  const frame = document.createElement('iframe');
  frame.className = 'llm-markdown-viewer-iframe';
  frame.title = 'Model reply (markdown)';
  frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
  llmPassthroughReplyBlobUrl = URL.createObjectURL(new Blob([doc], { type: 'text/html;charset=utf-8' }));
  frame.src = llmPassthroughReplyBlobUrl;
  el.appendChild(frame);
}

async function populateNamespaceSelect() {
  const sel = document.getElementById('namespace-select');
  if (!sel || !window.electronAPI.listNamespaces) return;
  const list = await window.electronAPI.listNamespaces();
  const active = await window.electronAPI.getActiveNamespace();
  namespaceSelectProgrammatic = true;
  sel.innerHTML = '';
  for (const n of list) {
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = n;
    sel.appendChild(opt);
  }
  if (list.includes(active)) {
    sel.value = active;
  } else if (list.length > 0) {
    sel.value = list[0];
  }
  namespaceSelectProgrammatic = false;
}

async function reloadNamespaceContext() {
  await populateNamespaceSelect();
  await loadSettings();
  const tp = document.getElementById('treePanel');
  if (tp) {
    tp.style.width = `${splitterPosition}px`;
  }
  await refreshFiles();
  await refreshDirectories();
  await refreshVectorStore();
  await refreshServerStatus();
  await loadServerSettings();
  await loadWebSearchSettings();
  await loadMetadataFilteringSettings();
  await checkAndAutoStartServer();
  if (currentCanvas === 'llm') {
    void refreshLlmPassthroughPanel();
  }
}

function openNamespacesModal() {
  const overlay = document.getElementById('namespaces-modal-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  renderNamespacesManageList();
}

function closeNamespacesModal() {
  const overlay = document.getElementById('namespaces-modal-overlay');
  if (overlay) overlay.style.display = 'none';
}

async function renderNamespacesManageList() {
  const ul = document.getElementById('namespaces-manage-list');
  if (!ul || !window.electronAPI.listNamespaces) return;
  const list = await window.electronAPI.listNamespaces();
  const active = await window.electronAPI.getActiveNamespace();
  ul.replaceChildren();
  for (const n of list) {
    const li = document.createElement('li');
    li.className = 'namespaces-manage-item';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'ns-name';
    nameSpan.appendChild(document.createTextNode(n));
    if (n === active) {
      nameSpan.appendChild(document.createTextNode(' '));
      const em = document.createElement('em');
      em.textContent = '(active)';
      nameSpan.appendChild(em);
    }
    const actions = document.createElement('span');
    actions.className = 'ns-actions';
    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'btn btn-secondary btn-sm';
    renameBtn.textContent = 'Rename';
    renameBtn.addEventListener('click', async () => {
      const to = prompt(`Rename namespace "${n}" to:`, n);
      if (to === null) return;
      const trimmed = to.trim();
      if (!trimmed || trimmed === n) return;
      const res = await window.electronAPI.renameNamespace(n, trimmed);
      if (!res.ok) {
        alert(res.error || 'Rename failed');
        return;
      }
      await populateNamespaceSelect();
      await renderNamespacesManageList();
    });
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-danger btn-sm';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', async () => {
      if (!confirm(`Delete namespace "${n}" and all its data? This cannot be undone.`)) {
        return;
      }
      const res = await window.electronAPI.deleteNamespace(n);
      if (!res.ok) {
        alert(res.error || 'Delete failed');
        return;
      }
      await populateNamespaceSelect();
      await renderNamespacesManageList();
    });
    actions.appendChild(renameBtn);
    actions.appendChild(deleteBtn);
    li.appendChild(nameSpan);
    li.appendChild(actions);
    ul.appendChild(li);
  }
}

let autoUpdateUiInitialized = false;
let pendingUpdateVersion = null;

function stripReleaseNotes(notes) {
  if (notes == null) return '';
  const s = Array.isArray(notes)
    ? notes.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('\n')
    : String(notes);
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function setUpdateReadyBanner(visible, version) {
  const banner = document.getElementById('update-ready-banner');
  const text = document.getElementById('update-ready-banner-text');
  if (!banner || !text) return;
  if (visible && version) {
    text.textContent = `Version ${version} is ready. Restart the app to finish installing.`;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}

function setUpdatesDownloadProgress(visible, progress) {
  const wrap = document.getElementById('settings-update-progress-wrap');
  const bar = document.getElementById('settings-update-progress-bar');
  const label = document.getElementById('settings-update-progress-label');
  if (!wrap || !bar || !label) return;
  if (!visible) {
    wrap.style.display = 'none';
    bar.style.width = '0%';
    label.textContent = '';
    return;
  }
  wrap.style.display = 'block';
  const p = typeof progress.percent === 'number' ? Math.round(progress.percent) : 0;
  bar.style.width = `${Math.min(100, Math.max(0, p))}%`;
  const transferred = progress.transferred || 0;
  const total = progress.total || 0;
  const mb = (n) => (n / (1024 * 1024)).toFixed(1);
  label.textContent = total > 0 ? `${p}% · ${mb(transferred)} / ${mb(total)} MB` : `${p}%`;
}

function setUpdateRestartControlsEnabled(enabled) {
  const settingsBtn = document.getElementById('settings-update-restart-btn');
  const bannerBtn = document.getElementById('update-banner-restart-btn');
  if (settingsBtn) settingsBtn.disabled = !enabled;
  if (bannerBtn) bannerBtn.disabled = !enabled;
}

function setSettingsUpdateStatus(text) {
  const main = document.getElementById('settings-update-status');
  const general = document.getElementById('settings-update-status-general');
  if (main) main.textContent = text;
  if (general) general.textContent = text;
}

async function loadUpdatesSettingsPanel() {
  if (!window.electronAPI?.getAutoUpdateEnabled) return;
  const enabled = await window.electronAPI.getAutoUpdateEnabled();
  const devNote = document.getElementById('settings-update-dev-note');
  if (devNote) devNote.style.display = enabled ? 'none' : 'block';
  document.querySelectorAll('.settings-check-updates-trigger').forEach((btn) => {
    btn.disabled = !enabled;
  });
  const restartBtn = document.getElementById('settings-update-restart-btn');
  if (restartBtn) restartBtn.disabled = !enabled || !pendingUpdateVersion;
  if (pendingUpdateVersion && enabled) {
    setSettingsUpdateStatus(`Version ${pendingUpdateVersion} is downloaded. Restart to apply.`);
  }
}

function setupAutoUpdateUi() {
  if (!window.electronAPI?.checkForUpdates || autoUpdateUiInitialized) return;
  autoUpdateUiInitialized = true;

  const notesEl = () => document.getElementById('settings-update-notes');

  window.electronAPI.onUpdateAvailable((data) => {
    pendingUpdateVersion = null;
    setUpdateRestartControlsEnabled(false);
    setSettingsUpdateStatus(`Update available: v${data.version}. Downloading…`);
    const n = notesEl();
    if (n) {
      const plain = stripReleaseNotes(data.releaseNotes);
      if (plain) {
        n.style.display = 'block';
        n.textContent = plain;
      } else {
        n.style.display = 'none';
        n.textContent = '';
      }
    }
  });

  window.electronAPI.onUpdateDownloadProgress((p) => {
    setUpdatesDownloadProgress(true, p);
  });

  window.electronAPI.onUpdateDownloaded((data) => {
    pendingUpdateVersion = data.version;
    setUpdatesDownloadProgress(false);
    setUpdateRestartControlsEnabled(true);
    setSettingsUpdateStatus(`Version ${data.version} is ready. Restart to install.`);
    setUpdateReadyBanner(true, data.version);
  });

  window.electronAPI.onUpdateNotAvailable(() => {
    if (!pendingUpdateVersion) {
      setSettingsUpdateStatus('You are on the latest version.');
    }
    setUpdatesDownloadProgress(false);
  });

  window.electronAPI.onUpdateError((err) => {
    setSettingsUpdateStatus(typeof err === 'string' ? err : 'Update check failed.');
    setUpdatesDownloadProgress(false);
  });

  async function runSettingsCheckForUpdates() {
    const enabled = await window.electronAPI.getAutoUpdateEnabled();
    if (!enabled) return;
    setSettingsUpdateStatus('Checking for updates…');
    const n = notesEl();
    if (n) {
      n.style.display = 'none';
      n.textContent = '';
    }
    setUpdatesDownloadProgress(false);
    const r = await window.electronAPI.checkForUpdates();
    if (!r.success) setSettingsUpdateStatus(r.error || 'Check failed.');
  }

  document.querySelectorAll('.settings-check-updates-trigger').forEach((btn) => {
    btn.addEventListener('click', () => void runSettingsCheckForUpdates());
  });

  const restartSettings = document.getElementById('settings-update-restart-btn');
  if (restartSettings) {
    restartSettings.addEventListener('click', async () => {
      await window.electronAPI.installUpdate();
    });
  }

  const restartBanner = document.getElementById('update-banner-restart-btn');
  if (restartBanner) {
    restartBanner.addEventListener('click', async () => {
      await window.electronAPI.installUpdate();
    });
  }

  const dismissBanner = document.getElementById('update-banner-dismiss-btn');
  if (dismissBanner) {
    dismissBanner.addEventListener('click', () => {
      setUpdateReadyBanner(false);
    });
  }
}

// Initialize app
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await initializeApp();
  } finally {
    hideLoadingScreen();
  }
  setupEventListeners();
  loadSettings();
});

async function initializeApp() {
  // Load and display app version
  try {
    const version = await window.electronAPI.getAppVersion();
    const versionElements = document.querySelectorAll('#app-version, #header-version');
    versionElements.forEach(el => {
      if (el) el.textContent = version;
    });
    // Update page title
    document.title = `Froggy RAG MCP (v${version})`;
  } catch (error) {
    console.error('Error loading app version:', error);
  }

  await populateNamespaceSelect();

  // Load settings
  const settings = await window.electronAPI.getSettings();
  if (settings.splitterPosition) {
    splitterPosition = settings.splitterPosition;
    document.getElementById('treePanel').style.width = `${splitterPosition}px`;
  }
  if (settings.searchSplitterPosition) {
    searchSplitterPosition = settings.searchSplitterPosition;
  }
  if (settings.chunkDetailSplitterPosition) {
    chunkDetailSplitterPosition = settings.chunkDetailSplitterPosition;
  }
  if (settings.vectorStoreSplitterPosition) {
    vectorStoreSplitterPosition = settings.vectorStoreSplitterPosition;
  }

  // Load MRU searches
  if (settings.mruSearches) {
    mruSearches = settings.mruSearches;
    updateMRUList();
  }

  // Setup splitters
  setupSplitter();
  setupSearchSplitter();
  setupChunkDetailSplitter();
  setupVectorStoreSplitter();

  // Setup tree navigation
  setupTreeNavigation();

  // Default to Vector Store screen
  const defaultNode = document.querySelector('.tree-item[data-node="vector-store"]');
  if (defaultNode) {
    document.querySelectorAll('.tree-item').forEach(i => i.classList.remove('active'));
    defaultNode.classList.add('active');
    showCanvas('vector-store');
  }

  // Reveal the main UI while RAG services finish loading in the main process (IPC below may wait).
  hideLoadingScreen();

  window.electronAPI.onIngestionUpdate(async (data) => {
    await refreshFiles();
    // Refresh directories but preserve expanded state
    const currentlyExpanded = Array.from(expandedDirectories);
    await refreshDirectories();
    // Re-expand directories that were expanded (refreshDirectories already does this, but ensure it's done)
    // The expandedDirectories set is maintained in refreshDirectories
    // Always refresh vector store when ingestion updates occur (file added/removed/changed)
    await refreshVectorStore();
  });

  window.electronAPI.onMCPServerLog((data) => {
    addServerLog(data);
  });

  if (window.electronAPI.onNamespaceChanged) {
    window.electronAPI.onNamespaceChanged(async () => {
      await reloadNamespaceContext();
    });
  }

  try {
    await refreshFiles();
    await refreshDirectories();
    await refreshVectorStore();
    await refreshServerStatus();
    await checkAndAutoStartServer();
    await loadLlmTestPanelRetrievalSettings();
  } catch (error) {
    console.error('Error loading initial data:', error);
    void refreshAppStatusBar();
  }

  setInterval(() => void refreshAppStatusBar(), 20000);
}

function hideLoadingScreen() {
  const el = document.getElementById('app-loading');
  if (el) el.style.display = 'none';
}

function setupEventListeners() {
  const namespaceSelect = document.getElementById('namespace-select');
  if (namespaceSelect) {
    namespaceSelect.addEventListener('change', async () => {
      if (namespaceSelectProgrammatic) return;
      const name = namespaceSelect.value;
      const res = await window.electronAPI.setActiveNamespace(name);
      if (!res.ok) {
        alert(res.error || 'Could not switch namespace');
        await populateNamespaceSelect();
        return;
      }
      /* reloadNamespaceContext runs via namespace-changed from main */
    });
  }

  const manageNsBtn = document.getElementById('manage-namespaces-btn');
  if (manageNsBtn) {
    manageNsBtn.addEventListener('click', () => openNamespacesModal());
  }

  const nsModalClose = document.getElementById('namespaces-modal-close');
  if (nsModalClose) {
    nsModalClose.addEventListener('click', () => closeNamespacesModal());
  }
  const nsModalDone = document.getElementById('namespaces-modal-done');
  if (nsModalDone) {
    nsModalDone.addEventListener('click', () => closeNamespacesModal());
  }
  const nsModalOverlay = document.getElementById('namespaces-modal-overlay');
  if (nsModalOverlay) {
    nsModalOverlay.addEventListener('click', (e) => {
      if (e.target === nsModalOverlay) closeNamespacesModal();
    });
  }
  const nsAddBtn = document.getElementById('namespace-add-btn');
  if (nsAddBtn) {
    nsAddBtn.addEventListener('click', async () => {
      const input = document.getElementById('namespace-new-name');
      const raw = (input && input.value) ? input.value.trim() : '';
      if (!raw) {
        alert('Enter a namespace name.');
        return;
      }
      const res = await window.electronAPI.createNamespace(raw);
      if (!res.ok) {
        alert(res.error || 'Could not create namespace');
        return;
      }
      if (input) input.value = '';
      await populateNamespaceSelect();
      await renderNamespacesManageList();
    });
  }

  // Settings button
  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', async () => {
      await showSettingsModal();
    });
  }

  // Help button
  const helpBtn = document.getElementById('help-btn');
  if (helpBtn) {
    helpBtn.addEventListener('click', async () => {
      console.log('Help button clicked');
      await showHelpModal();
    });
  } else {
    console.error('Help button element not found when setting up event listeners');
  }

  const searchDevtoolsBtn = document.getElementById('search-devtools-btn');
  if (searchDevtoolsBtn) {
    searchDevtoolsBtn.addEventListener('click', () => {
      window.electronAPI.toggleDevTools();
    });
  }

  // File management
  document.getElementById('add-file-btn').addEventListener('click', () => {
    document.getElementById('file-input').click();
  });

  document.getElementById('file-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    for (const file of files) {
      await window.electronAPI.ingestFile(file.path, false);
    }
    await refreshFiles();
    e.target.value = '';
  });

  // Directory management
  document.getElementById('add-directory-btn').addEventListener('click', async () => {
    const dirPath = await window.electronAPI.showDirectoryDialog();
    if (dirPath) {
      await window.electronAPI.ingestDirectory(dirPath, false, false);
      await refreshDirectories();
    }
  });

  // Search
  document.getElementById('search-btn').addEventListener('click', performSearch);
  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      performSearch();
    }
  });
  
  // MRU dropdown functionality
  setupMRUDropdown();

  // Server controls
  document.getElementById('start-server-btn').addEventListener('click', async () => {
    const settings = await window.electronAPI.getSettings();
    const port = settings.serverPort || 3000;
    try {
      await window.electronAPI.startMCPServer(port);
      await refreshServerStatus();
    } catch (error) {
      alert(`Error starting server: ${error.message}`);
    }
  });

  document.getElementById('stop-server-btn').addEventListener('click', async () => {
    try {
      await window.electronAPI.stopMCPServer();
      await refreshServerStatus();
    } catch (error) {
      alert(`Error stopping server: ${error.message}`);
    }
  });

  document.getElementById('self-test-btn').addEventListener('click', async () => {
    await performSelfTest();
  });

  const llmTestAlgo = document.getElementById('llm-passthrough-search-algorithm-select');
  if (llmTestAlgo) {
    llmTestAlgo.addEventListener('change', () => schedulePersistLlmTestRetrievalSettings());
  }
  const llmTestTimeout = document.getElementById('llm-passthrough-timeout-input');
  if (llmTestTimeout) {
    llmTestTimeout.addEventListener('change', () => schedulePersistLlmTestRetrievalSettings());
    llmTestTimeout.addEventListener('input', () => schedulePersistLlmTestRetrievalSettings());
  }

  const llmTestTransport = document.getElementById('llm-passthrough-test-transport-select');
  if (llmTestTransport) {
    llmTestTransport.addEventListener('change', () => {
      setLlmTestInboundHostSectionVisible(llmTestTransport.value === 'direct-ipc');
      schedulePersistLlmTestRetrievalSettings();
      void refreshLlmPassthroughPanel();
    });
  }

  const llmInboundHostPreset = document.getElementById('llm-passthrough-test-inbound-host-preset-select');
  const llmInboundHostCustomWrap = document.getElementById('llm-passthrough-test-inbound-host-custom-wrap');
  if (llmInboundHostPreset) {
    llmInboundHostPreset.addEventListener('change', async () => {
      if (llmInboundHostCustomWrap) {
        llmInboundHostCustomWrap.style.display =
          llmInboundHostPreset.value === 'custom' ? 'flex' : 'none';
      }
      if (llmInboundHostPreset.value === 'custom') {
        try {
          const s = await window.electronAPI.getSettings();
          refreshLlmTestInboundHostMruSelect(s);
        } catch (e) {
          console.error('refresh inbound host MRU on preset change', e);
        }
      }
      void persistLlmTestRetrievalSettingsFromInputs();
    });
  }
  const llmInboundHostMru = document.getElementById('llm-passthrough-test-inbound-host-mru-select');
  if (llmInboundHostMru) {
    llmInboundHostMru.addEventListener('change', () => {
      const customInClear = document.getElementById('llm-passthrough-test-inbound-host-custom-input');
      if (llmInboundHostMru.value !== LLM_INBOUND_TEST_HOST_MRU_NEW && customInClear) {
        customInClear.value = '';
      }
      schedulePersistLlmTestRetrievalSettings();
    });
  }
  const llmInboundHostCustom = document.getElementById('llm-passthrough-test-inbound-host-custom-input');
  if (llmInboundHostCustom) {
    llmInboundHostCustom.addEventListener('change', () => schedulePersistLlmTestRetrievalSettings());
    llmInboundHostCustom.addEventListener('input', () => schedulePersistLlmTestRetrievalSettings());
  }

  setupLlmTesterChatControlsOnce();
  setupLlmCanvasTabsOnce();

  const llmPassthroughEnabledInput = document.getElementById('settings-llm-passthrough-enabled-input');
  if (llmPassthroughEnabledInput) {
    llmPassthroughEnabledInput.addEventListener('change', () => {
      void refreshLlmPassthroughPanel({
        llmPassthroughEnabled: llmPassthroughEnabledInput.checked === true
      });
    });
  }

  const llmProviderSelect = document.getElementById('settings-llm-passthrough-provider-select');
  if (llmProviderSelect) {
    llmProviderSelect.addEventListener('change', () => {
      const prev = llmProviderSelect.dataset.lastProvider || 'ollama';
      const next = llmProviderSelect.value === 'openai' ? 'openai' : 'ollama';
      flushLlmPassthroughDraftFromInputs(prev);
      applyLlmPassthroughDraftToInputs(next);
      llmProviderSelect.dataset.lastProvider = next;
      syncLlmPassthroughProviderUi();
    });
  }

  const webSearchApiKeyInput = document.getElementById('settings-google-custom-search-api-key-input');
  if (webSearchApiKeyInput) {
    webSearchApiKeyInput.addEventListener('change', () => {
      void persistWebSearchSettingsFromInputs();
    });
  }
  const webSearchCxInput = document.getElementById('settings-google-custom-search-engine-id-input');
  if (webSearchCxInput) {
    webSearchCxInput.addEventListener('change', () => schedulePersistWebSearchSettings());
    webSearchCxInput.addEventListener('input', () => schedulePersistWebSearchSettings());
  }
  const webSearchNumInput = document.getElementById('settings-google-custom-search-num-results-input');
  if (webSearchNumInput) {
    webSearchNumInput.addEventListener('change', () => schedulePersistWebSearchSettings());
    webSearchNumInput.addEventListener('input', () => schedulePersistWebSearchSettings());
  }
  const webSearchIncludeInput = document.getElementById('settings-llm-passthrough-include-web-results-input');
  if (webSearchIncludeInput) {
    webSearchIncludeInput.addEventListener('change', () => {
      void persistWebSearchSettingsFromInputs();
    });
  }
  const webSearchSaveBtn = document.getElementById('settings-web-search-save-btn');
  if (webSearchSaveBtn) {
    webSearchSaveBtn.addEventListener('click', () => {
      void persistWebSearchSettingsFromInputs();
    });
  }

  const llmSendBtn = document.getElementById('llm-passthrough-send-btn');
  if (llmSendBtn) {
    llmSendBtn.addEventListener('click', async () => {
      if (llmPassthroughSendCancelFn) {
        llmPassthroughSendUserCancelled = true;
        runLlmPassthroughSendCancel();
        return;
      }
      if (llmPassthroughSendInFlight) return;

      const promptEl = document.getElementById('llm-passthrough-prompt');
      const ctxEl = document.getElementById('llm-passthrough-context-preview');
      const statusEl = document.getElementById('llm-passthrough-send-status');
      const text = promptEl ? promptEl.value : '';
      if (!text || !String(text).trim()) {
        alert('Enter a message.');
        return;
      }
      const userContent = String(text).trim();
      if (statusEl) statusEl.textContent = 'Calling LLM passthrough…';
      clearLlmPassthroughReply();
      if (ctxEl) {
        ctxEl.textContent =
          'RAG uses the latest user turn. Inbound HTTP does not return chunk text in the chat body; use Search on that turn to inspect hits. Direct IPC fills this preview after each run.';
      }
      try {
        await persistLlmTestRetrievalSettingsFromInputs();
        const settings = await window.electronAPI.getSettings();
        const store = loadLlmTesterChatStore();
        const chat = getActiveLlmTesterChatEntry(store);
        if (!chat) {
          throw new Error('No active chat session.');
        }
        chat.messages.push({ role: 'user', content: userContent });
        chat.updatedAt = Date.now();
        maybeUpgradeLlmTesterTitleFromMessages(chat);
        saveLlmTesterChatStore(store);
        if (promptEl) promptEl.value = '';
        renderLlmTesterChatSelect();
        renderLlmTesterTranscript();

        const messagesPayload = chat.messages.map((m) => ({
          role: m.role,
          content: m.content
        }));

        const useDirectIpc = settings.llmPassthroughTestTransport === 'direct-ipc';
        const activeNs = window.electronAPI.getActiveNamespace
          ? await window.electronAPI.getActiveNamespace()
          : '';
        if (useDirectIpc) {
          if (statusEl) statusEl.textContent = 'Calling LLM passthrough (IPC)…';
          if (ctxEl) {
            ctxEl.textContent = 'Retrieved context appears here after a successful IPC run.';
          }
          if (!window.electronAPI.llmPassthroughTestDirect) {
            throw new Error('This build does not expose llmPassthroughTestDirect; reload the app after update.');
          }
          beginLlmPassthroughSendCancellable(llmSendBtn, () => {
            if (window.electronAPI.llmPassthroughTestDirectCancel) {
              window.electronAPI.llmPassthroughTestDirectCancel();
            }
          });
          const ipcResult = await window.electronAPI.llmPassthroughTestDirect({
            messages: messagesPayload,
            namespace: activeNs && String(activeNs).trim() ? String(activeNs).trim() : undefined
          });
          if (ipcResult && ipcResult.cancelled === true) {
            const err = new Error('Cancelled.');
            err.name = 'UserCancelled';
            throw err;
          }
          if (!ipcResult || ipcResult.ok !== true) {
            throw new Error(
              ipcResult && typeof ipcResult.message === 'string'
                ? ipcResult.message
                : 'IPC LLM test failed.'
            );
          }
          const replyTrim = String(ipcResult.reply || '').trim();
          chat.messages.push({ role: 'assistant', content: replyTrim });
          chat.updatedAt = Date.now();
          saveLlmTesterChatStore(store);
          renderLlmTesterChatSelect();
          renderLlmTesterTranscript();
          await setLlmPassthroughReplyMarkdown(ipcResult.reply);
          if (ctxEl) {
            let block = ipcResult.contextBlock || '(No retrieved text)';
            if (ipcResult.errors && ipcResult.errors.length) {
              block += `\n\n---\nErrors:\n${ipcResult.errors.join('\n')}`;
            }
            if (ipcResult.warnings && ipcResult.warnings.length) {
              block += `\n\n---\nWarnings:\n${ipcResult.warnings.join('\n')}`;
            }
            ctxEl.textContent = block;
          }
          if (statusEl) statusEl.textContent = 'Done (via direct IPC).';
        } else {
          const mcpStatus = await window.electronAPI.getMCPServerStatus();
          const inboundHost = String(
            settings.llmPassthroughTestInboundHostname || '127.0.0.1'
          ).trim() || '127.0.0.1';
          const target = pickInboundLlmPassthroughEndpoint(mcpStatus, inboundHost);
          if (!target) {
            chat.messages.pop();
            saveLlmTesterChatStore(store);
            renderLlmTesterChatSelect();
            renderLlmTesterTranscript();
            if (promptEl) promptEl.value = userContent;
            alert(
              'No inbound passthrough listener is available. Under Settings → Server, enable LLM Passthrough, turn on at least one inbound listener (Ollama-style or OpenAI-compatible), save, and confirm the Server status shows listening. Or choose “Direct IPC” under Test transport to skip HTTP.'
            );
            if (statusEl) statusEl.textContent = '';
            return;
          }
          const timeoutMs =
            Number.isFinite(settings.llmPassthroughTimeoutMs) && settings.llmPassthroughTimeoutMs > 0
              ? settings.llmPassthroughTimeoutMs
              : 120000;
          const headers = { 'Content-Type': 'application/json' };
          if (activeNs && String(activeNs).trim()) {
            headers['X-Froggy-Namespace'] = String(activeNs).trim();
          }
          const bodyObj = {
            messages: messagesPayload,
            stream: false
          };
          const controller = new AbortController();
          let httpTimer = null;
          beginLlmPassthroughSendCancellable(llmSendBtn, () => {
            if (httpTimer != null) clearTimeout(httpTimer);
            controller.abort();
          });
          httpTimer = setTimeout(() => controller.abort(), timeoutMs);
          let response;
          try {
            response = await fetch(target.url, {
              method: 'POST',
              headers,
              body: JSON.stringify(bodyObj),
              signal: controller.signal
            });
          } finally {
            if (httpTimer != null) clearTimeout(httpTimer);
          }
          const rawText = await response.text();
          let data = null;
          try {
            data = rawText ? JSON.parse(rawText) : null;
          } catch {
            data = null;
          }
          if (!response.ok) {
            throw new Error(inboundPassthroughErrorMessage(response.status, data));
          }
          const reply = extractLlmTestReplyFromPassthroughJson(target.kind, data);
          if (!reply || !String(reply).trim()) {
            throw new Error('The model returned an empty response.');
          }
          const replyTrim = String(reply).trim();
          chat.messages.push({ role: 'assistant', content: replyTrim });
          chat.updatedAt = Date.now();
          saveLlmTesterChatStore(store);
          renderLlmTesterChatSelect();
          renderLlmTesterTranscript();
          await setLlmPassthroughReplyMarkdown(reply);
          if (statusEl) {
            statusEl.textContent = `Done (via ${target.kind === 'openai' ? 'OpenAI-compatible' : 'Ollama-style'} inbound).`;
          }
        }
      } catch (e) {
        const rollbackLastUser = () => {
          const st = loadLlmTesterChatStore();
          const ch = getActiveLlmTesterChatEntry(st);
          if (ch && ch.messages.length && ch.messages[ch.messages.length - 1].role === 'user') {
            const last = ch.messages[ch.messages.length - 1];
            if (last.content === userContent) {
              ch.messages.pop();
              ch.updatedAt = Date.now();
              saveLlmTesterChatStore(st);
              renderLlmTesterChatSelect();
              renderLlmTesterTranscript();
              const pe = document.getElementById('llm-passthrough-prompt');
              if (pe) pe.value = userContent;
            }
          }
        };
        if (llmPassthroughSendUserCancelled || (e && e.name === 'UserCancelled')) {
          rollbackLastUser();
          clearLlmPassthroughReply();
          if (statusEl) statusEl.textContent = 'Cancelled.';
        } else {
          const msg =
            e && e.name === 'AbortError'
              ? 'Request timed out.'
              : e && e.message
                ? e.message
                : String(e);
          alert(msg);
          rollbackLastUser();
          clearLlmPassthroughReply();
          if (statusEl) statusEl.textContent = '';
        }
      } finally {
        endLlmPassthroughSendUi(llmSendBtn);
        await refreshLlmPassthroughPanel();
      }
    });
  }

  // Settings page navigation
  setupSettingsNavigation();

  setupAutoUpdateUi();

  // Rebuild vector store
  const regenerateVectorStoreBtn = document.getElementById('regenerate-vector-store-btn');
  if (regenerateVectorStoreBtn) {
    regenerateVectorStoreBtn.addEventListener('click', async () => {
      await regenerateVectorStore();
    });
  }

  // Chunks panel close button: clear selection and show placeholder
  const chunksPanelCloseBtn = document.getElementById('chunks-panel-close-btn');
  if (chunksPanelCloseBtn) {
    chunksPanelCloseBtn.addEventListener('click', () => {
      const tbody = document.getElementById('chunks-tbody');
      const subtitle = document.getElementById('chunks-panel-subtitle');
      if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 20px; color: #757575;">Click a document row above to view its chunks.</td></tr>';
      if (subtitle) subtitle.textContent = '';
      selectedDocumentId = null;
    });
  }

  // Documents table: delegate click so row clicks open chunks (avoids per-row listener issues)
  const documentsTable = document.getElementById('documents-table');
  if (documentsTable) {
    documentsTable.addEventListener('click', (e) => {
      const row = e.target.closest('tbody tr');
      if (!row || !row.dataset.documentId) return;
      e.preventDefault();
      showDocumentChunks(row.dataset.documentId);
    });
  }

  // Drag and drop for files
  setupDragAndDrop();
}

function setupSplitter() {
  const splitter = document.getElementById('splitter');
  const treePanel = document.getElementById('treePanel');
  let isDragging = false;

  splitter.addEventListener('mousedown', (e) => {
    isDragging = true;
    splitter.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    const newPosition = e.clientX;
    if (newPosition >= 200 && newPosition <= 600) {
      splitterPosition = newPosition;
      treePanel.style.width = `${newPosition}px`;
    }
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      splitter.classList.remove('dragging');
      document.body.style.cursor = '';
      saveSettings();
    }
  });
}

function setupSearchSplitter() {
  const splitter = document.getElementById('search-horizontal-splitter');
  if (!splitter) return;
  
  const resultsDiv = document.getElementById('search-results');
  const detailDiv = document.getElementById('search-chunk-detail');
  const container = document.getElementById('search-results-container');
  let isDragging = false;

  splitter.addEventListener('mousedown', (e) => {
    isDragging = true;
    splitter.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    const containerRect = container.getBoundingClientRect();
    const relativeY = e.clientY - containerRect.top;
    
    // Minimum heights for both panels
    const minHeight = 100;
    const maxHeight = containerRect.height - minHeight;
    
    if (relativeY >= minHeight && relativeY <= maxHeight) {
      searchSplitterPosition = relativeY;
      resultsDiv.style.height = `${relativeY}px`;
      resultsDiv.style.overflowY = 'auto';
      resultsDiv.style.flexShrink = '0';
      detailDiv.style.flex = '1';
      detailDiv.style.minHeight = '0';
      detailDiv.style.overflowY = 'auto';
    }
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      splitter.classList.remove('dragging');
      document.body.style.cursor = '';
      saveSettings();
    }
  });
}

function applySearchSplitterPosition() {
  const resultsDiv = document.getElementById('search-results');
  const detailDiv = document.getElementById('search-chunk-detail');
  const container = document.getElementById('search-results-container');
  
  if (resultsDiv && detailDiv && container && container.style.display !== 'none') {
    const containerHeight = container.getBoundingClientRect().height || container.offsetHeight;
    if (containerHeight > 0) {
      // Ensure splitter position is within valid range
      const minHeight = 100;
      const maxHeight = containerHeight - minHeight;
      const adjustedPosition = Math.max(minHeight, Math.min(maxHeight, searchSplitterPosition));
      
      resultsDiv.style.height = `${adjustedPosition}px`;
      resultsDiv.style.overflowY = 'auto';
      resultsDiv.style.flexShrink = '0';
      detailDiv.style.flex = '1';
      detailDiv.style.minHeight = '0';
      detailDiv.style.overflowY = 'auto';
    }
  }
  applyChunkDetailSplitterPosition();
}

function setupChunkDetailSplitter() {
  const splitter = document.getElementById('chunk-detail-vertical-splitter');
  if (!splitter) return;
  
  const textDiv = document.getElementById('search-chunk-content');
  const metadataDiv = document.getElementById('search-chunk-metadata');
  const contentDiv = document.querySelector('.chunk-detail-content');
  let isDragging = false;

  splitter.addEventListener('mousedown', (e) => {
    isDragging = true;
    splitter.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    if (!contentDiv) return;
    const contentRect = contentDiv.getBoundingClientRect();
    const relativeX = e.clientX - contentRect.left;
    
    // Minimum widths for both panels
    const minWidth = 150;
    const maxWidth = contentRect.width - minWidth;
    
    if (relativeX >= minWidth && relativeX <= maxWidth) {
      chunkDetailSplitterPosition = relativeX;
      textDiv.style.width = `${relativeX}px`;
      textDiv.style.flex = '0 0 auto';
      metadataDiv.style.flex = '1';
      metadataDiv.style.minWidth = '0';
    }
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      splitter.classList.remove('dragging');
      document.body.style.cursor = '';
      saveSettings();
    }
  });
}

function applyChunkDetailSplitterPosition() {
  const textDiv = document.getElementById('search-chunk-content');
  const metadataDiv = document.getElementById('search-chunk-metadata');
  const contentDiv = document.querySelector('.chunk-detail-content');
  
  if (textDiv && metadataDiv && contentDiv) {
    const contentWidth = contentDiv.getBoundingClientRect().width || contentDiv.offsetWidth;
    if (contentWidth > 0) {
      // Ensure splitter position is within valid range
      const minWidth = 150;
      const maxWidth = contentWidth - minWidth;
      const adjustedPosition = Math.max(minWidth, Math.min(maxWidth, chunkDetailSplitterPosition));
      
      textDiv.style.width = `${adjustedPosition}px`;
      textDiv.style.flex = '0 0 auto';
      metadataDiv.style.flex = '1';
      metadataDiv.style.minWidth = '0';
    }
  }
}

function setupVectorStoreSplitter() {
  const splitter = document.getElementById('vector-store-horizontal-splitter');
  const topPanel = document.getElementById('vector-store-documents-panel');
  const container = document.getElementById('vector-store-split-container');
  if (!splitter || !topPanel || !container) return;

  let isDragging = false;

  splitter.addEventListener('mousedown', (e) => {
    isDragging = true;
    splitter.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    const containerRect = container.getBoundingClientRect();
    const relativeY = e.clientY - containerRect.top;

    const minHeight = 120;
    const maxHeight = containerRect.height - 120;

    if (relativeY >= minHeight && relativeY <= maxHeight) {
      vectorStoreSplitterPosition = relativeY;
      topPanel.style.height = `${relativeY}px`;
      topPanel.style.flexShrink = '0';
    }
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      splitter.classList.remove('dragging');
      document.body.style.cursor = '';
      saveSettings();
    }
  });
}

function applyVectorStoreSplitterPosition() {
  const topPanel = document.getElementById('vector-store-documents-panel');
  const container = document.getElementById('vector-store-split-container');
  if (!topPanel || !container) return;

  const containerHeight = container.getBoundingClientRect().height || container.offsetHeight;
  if (containerHeight > 0) {
    const minHeight = 120;
    const maxHeight = containerHeight - 120;
    const adjusted = Math.max(minHeight, Math.min(maxHeight, vectorStoreSplitterPosition));
    vectorStoreSplitterPosition = adjusted;
    topPanel.style.height = `${adjusted}px`;
    topPanel.style.flexShrink = '0';
  }
}

function setupTreeNavigation() {
  const treeItems = document.querySelectorAll('.tree-item');
  
  treeItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      
      const node = item.dataset.node;
      const hasExpander = item.querySelector('.tree-expander');
      
      // Toggle expansion for parent nodes
      if (hasExpander) {
        item.classList.toggle('expanded');
        // Don't show canvas for parent nodes - only for leaf nodes
        return;
      }
      
      // Set active state
      treeItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      
      // Show appropriate canvas for leaf nodes
      showCanvas(node);
    });
  });
}

function showCanvas(canvasName) {
  // Hide all canvases
  document.querySelectorAll('.canvas').forEach(canvas => {
    canvas.style.display = 'none';
  });

  // Show selected canvas
  currentCanvas = canvasName;
  
  switch(canvasName) {
    case 'files':
      document.getElementById('files-canvas').style.display = 'block';
      refreshFiles();
      break;
    case 'directories':
      document.getElementById('directories-canvas').style.display = 'block';
      refreshDirectories();
      break;
    case 'vector-store':
      document.getElementById('vector-store-canvas').style.display = 'block';
      refreshVectorStore();
      requestAnimationFrame(() => applyVectorStoreSplitterPosition());
      break;
    case 'search':
      document.getElementById('search-canvas').style.display = 'block';
      // Ensure MRU dropdown is set up
      if (!document.getElementById('mru-dropdown')) {
        setupMRUDropdown();
      }
      // Apply saved splitter positions
      applySearchSplitterPosition();
      break;
    case 'llm':
      document.getElementById('llm-canvas').style.display = 'block';
      setupLlmTesterChatControlsOnce();
      refreshLlmTesterChatPanel();
      void loadLlmTestPanelRetrievalSettings();
      void refreshLlmPassthroughPanel();
      break;
    case 'server':
      document.getElementById('server-canvas').style.display = 'block';
      refreshServerStatus();
      refreshServerLogs();
      break;
  }
}

async function refreshFiles() {
  const files = await window.electronAPI.getFiles();
  const tbody = document.getElementById('files-tbody');
  const status = await window.electronAPI.getIngestionStatus();
  
  tbody.innerHTML = '';
  
  files.forEach(file => {
    const row = document.createElement('tr');
    const queueItem = status.queue.find(q => q.filePath === file.path);
    // If file is inactive, show "inactive" status, otherwise show queue status or "completed"
    const fileStatus = file.active === false ? 'inactive' : (queueItem ? queueItem.status : 'completed');
    
    // Escape HTML and JavaScript in file path
    const escapedPath = file.path.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    
    row.innerHTML = `
      <td>${file.path}</td>
      <td><span class="status-badge status-${fileStatus}">${fileStatus}</span></td>
      <td><input type="checkbox" ${file.active !== false ? 'checked' : ''} 
          data-file-path="${escapedPath}" class="file-active-checkbox" /></td>
      <td><input type="checkbox" ${file.watch ? 'checked' : ''} 
          data-file-path="${escapedPath}" class="file-watch-checkbox" /></td>
      <td><button class="btn btn-danger remove-file-btn" data-file-path="${escapedPath}">Remove</button></td>
    `;
    
    // Add event listeners
    const activeCheckbox = row.querySelector('.file-active-checkbox');
    activeCheckbox.addEventListener('change', async (e) => {
      await window.updateFileActive(file.path, e.target.checked);
    });
    
    const watchCheckbox = row.querySelector('.file-watch-checkbox');
    watchCheckbox.addEventListener('change', async (e) => {
      await window.updateFileWatch(file.path, e.target.checked);
    });
    
    const removeBtn = row.querySelector('.remove-file-btn');
    removeBtn.addEventListener('click', async () => {
      await window.removeFile(file.path);
    });
    
    tbody.appendChild(row);
  });
}

async function refreshDirectories() {
  const directories = await window.electronAPI.getDirectories();
  const tbody = document.getElementById('directories-tbody');
  
  tbody.innerHTML = '';
  
  for (const dir of directories) {
    // Create directory row
    const row = document.createElement('tr');
    row.className = 'directory-row';
    row.dataset.dirPath = dir.path;
    
    // Escape path for use in HTML attributes
    const escapedPath = dir.path.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    
    // Create path cell with clickable link
    const pathCell = document.createElement('td');
    const pathLink = document.createElement('span');
    pathLink.className = 'directory-path-link';
    pathLink.textContent = dir.path;
    pathLink.style.cursor = 'pointer';
    pathLink.style.color = '#1976d2';
    pathLink.style.textDecoration = 'underline';
    pathLink.title = 'Click to expand/collapse • Ctrl+Click to open in Explorer';
    pathLink.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (e.ctrlKey) {
        await window.electronAPI.openPathInExplorer(dir.path);
        return;
      }
      await toggleDirectoryFiles(dir.path, row);
    });
    pathCell.appendChild(pathLink);
    
    // Create other cells
    const recursiveCell = document.createElement('td');
    const recursiveCheckbox = document.createElement('input');
    recursiveCheckbox.type = 'checkbox';
    recursiveCheckbox.checked = dir.recursive || false;
    recursiveCheckbox.addEventListener('change', async () => {
      await window.updateDirectoryRecursive(dir.path, recursiveCheckbox.checked);
      // If the file list is currently visible (expanded), refresh it immediately with the new recursive setting
      const filesRow = row.nextElementSibling;
      if (filesRow?.classList.contains('directory-files-row')) {
        await showDirectoryFiles(dir.path, row);
      }
    });
    recursiveCell.appendChild(recursiveCheckbox);
    
    const activeCell = document.createElement('td');
    const activeCheckbox = document.createElement('input');
    activeCheckbox.type = 'checkbox';
    activeCheckbox.checked = dir.active !== false; // Default to true
    activeCheckbox.addEventListener('change', async () => {
      await window.updateDirectoryActive(dir.path, activeCheckbox.checked);
    });
    activeCell.appendChild(activeCheckbox);
    
    const watchCell = document.createElement('td');
    const watchCheckbox = document.createElement('input');
    watchCheckbox.type = 'checkbox';
    watchCheckbox.checked = dir.watch || false;
    watchCheckbox.addEventListener('change', async () => {
      await window.updateDirectoryWatch(dir.path, watchCheckbox.checked);
    });
    watchCell.appendChild(watchCheckbox);
    
    const actionsCell = document.createElement('td');
    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-danger';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      await window.removeDirectory(dir.path);
    });
    actionsCell.appendChild(removeBtn);
    
    // Append all cells to row
    row.appendChild(pathCell);
    row.appendChild(recursiveCell);
    row.appendChild(activeCell);
    row.appendChild(watchCell);
    row.appendChild(actionsCell);
    
    tbody.appendChild(row);
    
    // If this directory was expanded, show its files
    if (expandedDirectories.has(dir.path)) {
      await showDirectoryFiles(dir.path, row);
    }
  }
}

async function toggleDirectoryFiles(dirPath, row) {
  if (expandedDirectories.has(dirPath)) {
    // Collapse: remove files row
    const filesRow = row.nextElementSibling;
    if (filesRow && filesRow.classList.contains('directory-files-row')) {
      filesRow.remove();
    }
    expandedDirectories.delete(dirPath);
  } else {
    // Expand: show files
    await showDirectoryFiles(dirPath, row);
    expandedDirectories.add(dirPath);
  }
}

async function showDirectoryFiles(dirPath, directoryRow) {
  // Check if files row already exists and remove it to refresh
  let filesRow = directoryRow.nextElementSibling;
  if (filesRow && filesRow.classList.contains('directory-files-row')) {
    filesRow.remove();
  }
  
  try {
    const files = await window.electronAPI.getDirectoryFiles(dirPath);
    
    // Create a new row for files
    filesRow = document.createElement('tr');
    filesRow.className = 'directory-files-row';
    
    const filesCell = document.createElement('td');
    filesCell.colSpan = 4; // Span all columns
    
    if (files.length === 0) {
      filesCell.innerHTML = '<div class="directory-files-empty">No files found in this directory</div>';
    } else {
      const filesTable = document.createElement('table');
      filesTable.className = 'directory-files-table';
      
      const thead = document.createElement('thead');
      thead.innerHTML = `
        <tr>
          <th>File Name</th>
          <th>Status</th>
        </tr>
      `;
      filesTable.appendChild(thead);
      
      const tbody = document.createElement('tbody');
      files.forEach(file => {
        const fileRow = document.createElement('tr');
        const nameCell = document.createElement('td');
        nameCell.textContent = file.name;
        const statusCell = document.createElement('td');
        const statusBadge = document.createElement('span');
        statusBadge.className = `status-badge status-${file.status}`;
        statusBadge.textContent = file.status;
        statusCell.appendChild(statusBadge);
        fileRow.appendChild(nameCell);
        fileRow.appendChild(statusCell);
        tbody.appendChild(fileRow);
      });
      filesTable.appendChild(tbody);
      
      filesCell.appendChild(filesTable);
    }
    
    filesRow.appendChild(filesCell);
    directoryRow.parentNode.insertBefore(filesRow, directoryRow.nextSibling);
  } catch (error) {
    console.error('Error loading directory files:', error);
    const errorRow = document.createElement('tr');
    errorRow.className = 'directory-files-row';
    errorRow.innerHTML = `
      <td colspan="4" style="color: #d32f2f; padding: 10px;">
        Error loading files: ${error.message}
      </td>
    `;
    directoryRow.parentNode.insertBefore(errorRow, directoryRow.nextSibling);
  }
}

function setStatusBarPassthrough(el, inbound) {
  el.textContent = '';
  el.title = 'Inbound LLM passthrough (Settings → Server)';
  el.classList.remove('status-bar-running', 'status-bar-stopped', 'status-bar-warning', 'status-bar-error');

  el.appendChild(document.createTextNode('LLM passthrough: '));

  if (!inbound) {
    const s = document.createElement('span');
    s.className = 'status-bar-stopped';
    s.textContent = '—';
    el.appendChild(s);
    return;
  }

  if (!inbound.masterEnabled) {
    const s = document.createElement('span');
    s.className = 'status-bar-stopped';
    s.textContent = 'off';
    el.appendChild(s);
    return;
  }

  const parts = [];
  if (inbound.ollama && inbound.ollama.enabled) {
    const port = inbound.ollama.port != null ? inbound.ollama.port : '—';
    if (inbound.ollama.listening) {
      parts.push({ label: `Ollama :${port}`, ok: true });
    } else {
      parts.push({
        label: `Ollama :${port} (not listening)`,
        ok: false,
        detail: inbound.ollama.lastError
      });
    }
  }
  if (inbound.openai && inbound.openai.enabled) {
    const port = inbound.openai.port != null ? inbound.openai.port : '—';
    if (inbound.openai.listening) {
      parts.push({ label: `OpenAI :${port}`, ok: true });
    } else {
      parts.push({
        label: `OpenAI :${port} (not listening)`,
        ok: false,
        detail: inbound.openai.lastError
      });
    }
  }

  if (parts.length === 0) {
    const s = document.createElement('span');
    s.className = 'status-bar-warning';
    s.textContent = 'on (no listeners enabled)';
    el.appendChild(s);
    return;
  }

  const allOk = parts.every((p) => p.ok);
  const summary = document.createElement('span');
  summary.className = allOk ? 'status-bar-running' : 'status-bar-warning';
  summary.textContent = parts.map((p) => p.label).join(' · ');
  const tip = parts
    .filter((p) => !p.ok && p.detail)
    .map((p) => `${p.label}: ${p.detail}`)
    .join('\n');
  if (tip) {
    el.title = `Inbound LLM passthrough\n${tip}`;
  }
  el.appendChild(summary);
}

async function refreshAppStatusBar() {
  const nsEl = document.getElementById('status-bar-namespace');
  const serverEl = document.getElementById('status-bar-server');
  const passthroughEl = document.getElementById('status-bar-passthrough');
  const storeEl = document.getElementById('status-bar-store');
  if (!nsEl || !serverEl || !passthroughEl || !storeEl) return;

  nsEl.classList.remove('status-bar-error');
  serverEl.classList.remove('status-bar-running', 'status-bar-stopped', 'status-bar-error');
  passthroughEl.classList.remove('status-bar-running', 'status-bar-stopped', 'status-bar-warning', 'status-bar-error');
  storeEl.classList.remove('status-bar-error');

  try {
    const [mcp, stats, ns] = await Promise.all([
      window.electronAPI.getMCPServerStatus(),
      window.electronAPI.getVectorStoreStats(),
      window.electronAPI.getActiveNamespace()
    ]);

    const nsLabel = ns != null && String(ns).trim() !== '' ? String(ns).trim() : 'default';
    nsEl.textContent = `Namespace: ${nsLabel}`;

    serverEl.textContent = '';
    if (mcp.running && mcp.port) {
      serverEl.appendChild(document.createTextNode('MCP server: '));
      const run = document.createElement('span');
      run.className = 'status-bar-running';
      run.textContent = `running (port ${mcp.port})`;
      serverEl.appendChild(run);
    } else {
      serverEl.appendChild(document.createTextNode('MCP server: '));
      const st = document.createElement('span');
      st.className = 'status-bar-stopped';
      st.textContent = 'stopped';
      serverEl.appendChild(st);
    }

    setStatusBarPassthrough(passthroughEl, mcp.inboundPassthrough);

    const docs = stats.documentCount ?? 0;
    const chunks = stats.chunkCount ?? 0;
    const size = formatBytes(stats.totalSize ?? 0);
    storeEl.textContent = `Vector store: ${docs} documents · ${chunks} chunks · ${size}`;
  } catch (e) {
    console.error('refreshAppStatusBar', e);
    nsEl.textContent = 'Namespace: —';
    nsEl.classList.add('status-bar-error');
    serverEl.textContent = 'MCP server: unavailable';
    serverEl.classList.add('status-bar-error');
    passthroughEl.textContent = 'LLM passthrough: unavailable';
    passthroughEl.classList.add('status-bar-error');
    storeEl.textContent = 'Vector store: unavailable';
    storeEl.classList.add('status-bar-error');
  }
}

async function refreshVectorStore() {
  const stats = await window.electronAPI.getVectorStoreStats();
  const documents = await window.electronAPI.getDocuments();
  
  // Update stats
  const statsBar = document.getElementById('vector-store-stats');
  statsBar.innerHTML = `
    <div class="stats-item">
      <div class="stats-label">Documents</div>
      <div class="stats-value">${stats.documentCount}</div>
    </div>
    <div class="stats-item">
      <div class="stats-label">Chunks</div>
      <div class="stats-value">${stats.chunkCount}</div>
    </div>
    <div class="stats-item">
      <div class="stats-label">Total Size</div>
      <div class="stats-value">${formatBytes(stats.totalSize)}</div>
    </div>
  `;
  
  // Update documents table
  const tbody = document.getElementById('documents-tbody');
  tbody.innerHTML = '';
  
  documents.forEach(doc => {
    const row = document.createElement('tr');
    row.dataset.documentId = doc.id;
    row.style.cursor = 'pointer';
    row.title = 'Click to view chunks';
    
    // Format the last updated timestamp
    const lastUpdated = doc.updated_at 
      ? new Date(doc.updated_at).toLocaleString() 
      : 'N/A';
    
    const chunkCount = doc.chunk_count != null ? String(doc.chunk_count) : '-';
    row.innerHTML = `
      <td>${doc.file_name}</td>
      <td>${doc.file_type}</td>
      <td><span class="status-badge status-${doc.status}">${doc.status}</span></td>
      <td>${lastUpdated}</td>
      <td>${chunkCount}</td>
    `;
    tbody.appendChild(row);
  });

  void refreshAppStatusBar();
}

async function showDocumentChunks(documentId) {
  if (!documentId) return;
  const panel = document.getElementById('chunks-panel');
  const tbody = document.getElementById('chunks-tbody');
  const subtitle = document.getElementById('chunks-panel-subtitle');
  if (!panel || !tbody) return;

  // Show loading state (panel is always visible in split layout)
  if (subtitle) subtitle.textContent = 'Loading…';
  tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 20px;">Loading chunks…</td></tr>';

  selectedDocumentId = documentId;
  let doc = null;
  let chunks = [];
  try {
    chunks = await window.electronAPI.getDocumentChunks(documentId);
    try {
      doc = await window.electronAPI.getDocument(documentId);
    } catch (e) {
      console.error('Error fetching document info:', e);
    }
  } catch (error) {
    console.error('Error loading chunks:', error);
    if (subtitle) subtitle.textContent = '';
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 20px; color: #d32f2f;">Failed to load chunks: ${error.message}</td></tr>`;
    return;
  }

  if (subtitle) {
    const fileName = doc ? doc.file_name : 'document';
    subtitle.textContent = `Chunks for "${fileName}". Click a row or View to see full content and metadata.`;
  }
  tbody.innerHTML = '';
  
  // Update chunk count in documents table
  const docRows = document.querySelectorAll('#documents-tbody tr');
  docRows.forEach(row => {
    if (row.dataset.documentId === documentId) {
      const chunkCountCell = row.querySelector('td:nth-child(5)');
      if (chunkCountCell) {
        chunkCountCell.textContent = chunks.length;
      }
    }
  });
  
  // Format the last updated timestamp
  const lastUpdated = doc && doc.updated_at 
    ? new Date(doc.updated_at).toLocaleString() 
    : 'N/A';
  
  console.log('Last updated value:', lastUpdated);
  console.log('Processing', chunks.length, 'chunks');
  
  chunks.forEach((chunk, index) => {
    if (!chunk.id) {
      console.error('Chunk missing ID:', chunk);
      return;
    }
    
    const row = document.createElement('tr');
    row.style.cursor = 'pointer';
    const preview = chunk.content ? (chunk.content.substring(0, 100) + (chunk.content.length > 100 ? '...' : '')) : '';
    
    // Create button element directly instead of using innerHTML
    const indexCell = document.createElement('td');
    indexCell.textContent = chunk.chunk_index ?? '';
    
    const previewCell = document.createElement('td');
    previewCell.textContent = preview;
    
    const metadataCell = document.createElement('td');
    if (chunk.metadata && typeof chunk.metadata === 'object' && Object.keys(chunk.metadata).length > 0) {
      const metaStr = JSON.stringify(chunk.metadata);
      metadataCell.textContent = metaStr.length > 80 ? metaStr.substring(0, 80) + '...' : metaStr;
      metadataCell.title = metaStr;
    } else {
      metadataCell.textContent = '-';
    }
    
    const lastUpdatedCell = document.createElement('td');
    lastUpdatedCell.textContent = lastUpdated;
    
    const actionsCell = document.createElement('td');
    
    if (index === 0) {
      console.log('First chunk - cells created:', {
        indexCell: indexCell.textContent,
        previewCell: previewCell.textContent.substring(0, 20),
        lastUpdatedCell: lastUpdatedCell.textContent,
        hasActionsCell: !!actionsCell
      });
    }
    const viewBtn = document.createElement('button');
    viewBtn.className = 'btn btn-secondary';
    viewBtn.textContent = 'View';
    viewBtn.type = 'button'; // Prevent form submission if inside a form
    viewBtn.setAttribute('data-chunk-id', chunk.id);
    
    // Add button click handler
    viewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      try {
        showChunkDetail(chunk.id);
      } catch (error) {
        console.error('Error showing chunk detail:', error);
        alert(`Error opening chunk: ${error.message}`);
      }
    });
    
    actionsCell.appendChild(viewBtn);
    
    row.appendChild(indexCell);
    row.appendChild(previewCell);
    row.appendChild(metadataCell);
    row.appendChild(lastUpdatedCell);
    row.appendChild(actionsCell);
    
    // Add row click handler
    row.addEventListener('click', (e) => {
      // Don't trigger if clicking on the button
      if (e.target.closest('button')) return;
      try {
        showChunkDetail(chunk.id);
      } catch (error) {
        console.error('Error showing chunk detail:', error);
        alert(`Error opening chunk: ${error.message}`);
      }
    });
    
    tbody.appendChild(row);
  });
}

// Store event handlers for cleanup
let overlayClickHandler = null;
let escapeKeyHandler = null;

async function showChunkDetail(chunkId) {
  if (!chunkId) {
    console.error('showChunkDetail called with no chunkId');
    alert('Error: No chunk ID provided');
    return;
  }
  
  try {
    selectedChunkId = chunkId;
    const chunk = await window.electronAPI.getChunkContent(chunkId);
    if (!chunk) {
      alert('Chunk not found');
      return;
    }
  
  const overlay = document.getElementById('chunk-modal-overlay');
  const content = document.getElementById('chunk-content');
  const metadata = document.getElementById('chunk-metadata');
  
  // Set content
  content.textContent = chunk.content;
  
  // Format metadata
  metadata.innerHTML = '';
  const metadataItems = [
    { label: 'Chunk ID', value: String(chunk.id || '') },
    { label: 'Chunk Index', value: String(chunk.chunk_index ?? '') },
    { label: 'Document ID', value: String(chunk.document_id || '') },
    { label: 'Created At', value: chunk.created_at ? new Date(chunk.created_at).toLocaleString() : 'N/A' },
    { label: 'Content Length', value: `${chunk.content ? chunk.content.length : 0} characters` },
    { label: 'Has Embedding', value: chunk.embedding ? 'Yes' : 'No' }
  ];
  
  // Add metadata from chunk.metadata object if it exists
  if (chunk.metadata && typeof chunk.metadata === 'object') {
    Object.entries(chunk.metadata).forEach(([key, value]) => {
      let stringValue;
      if (value === null || value === undefined) {
        stringValue = 'N/A';
      } else if (typeof value === 'object') {
        stringValue = JSON.stringify(value, null, 2);
      } else {
        stringValue = String(value);
      }
      metadataItems.push({
        label: key,
        value: stringValue
      });
    });
  }
  
  // Render metadata items
  metadataItems.forEach(item => {
    const itemDiv = document.createElement('div');
    itemDiv.className = 'chunk-metadata-item';
    
    const label = document.createElement('div');
    label.className = 'chunk-metadata-label';
    label.textContent = item.label + ':';
    
    const value = document.createElement('div');
    value.className = 'chunk-metadata-value';
    // Ensure value is always a string
    const stringValue = String(item.value || '');
    if (stringValue.length > 100 || stringValue.includes('\n')) {
      const pre = document.createElement('pre');
      pre.textContent = stringValue;
      value.appendChild(pre);
    } else {
      value.textContent = stringValue;
    }
    
    itemDiv.appendChild(label);
    itemDiv.appendChild(value);
    metadata.appendChild(itemDiv);
  });
  
  // Clean up previous event handlers
  if (overlayClickHandler) {
    overlay.removeEventListener('click', overlayClickHandler);
  }
  if (escapeKeyHandler) {
    document.removeEventListener('keydown', escapeKeyHandler);
  }
  
  // Close on overlay click
  overlayClickHandler = (e) => {
    if (e.target === overlay) {
      closeChunkDetail();
    }
  };
  overlay.addEventListener('click', overlayClickHandler);
  
  // Close on Escape key
  escapeKeyHandler = (e) => {
    if (e.key === 'Escape') {
      closeChunkDetail();
    }
  };
  document.addEventListener('keydown', escapeKeyHandler);
  
  // Show modal
  overlay.style.display = 'flex';
  } catch (error) {
    console.error('Error in showChunkDetail:', error);
    alert(`Error loading chunk: ${error.message}`);
  }
}

window.closeChunkDetail = function() {
  document.getElementById('chunk-modal-overlay').style.display = 'none';
  
  // Clean up event handlers
  const overlay = document.getElementById('chunk-modal-overlay');
  if (overlayClickHandler) {
    overlay.removeEventListener('click', overlayClickHandler);
    overlayClickHandler = null;
  }
  if (escapeKeyHandler) {
    document.removeEventListener('keydown', escapeKeyHandler);
    escapeKeyHandler = null;
  }
};

function updateSearchTimer() {
  if (!searchStartTime) return;
  
  const timerElement = document.getElementById('search-timer');
  if (!timerElement) return;
  
  const elapsedMs = performance.now() - searchStartTime;
  const elapsedSeconds = (elapsedMs / 1000).toFixed(1);
  timerElement.textContent = `${elapsedSeconds}s`;
}

function startSearchTimer() {
  searchStartTime = performance.now();
  updateSearchTimer();
  
  // Update timer every 100ms for smooth display
  if (searchTimerInterval) {
    clearInterval(searchTimerInterval);
  }
  searchTimerInterval = setInterval(updateSearchTimer, 100);
}

function stopSearchTimer() {
  if (searchTimerInterval) {
    clearInterval(searchTimerInterval);
    searchTimerInterval = null;
  }
  searchStartTime = null;
  
  const timerElement = document.getElementById('search-timer');
  if (timerElement) {
    timerElement.textContent = '0.0s';
  }
}

function cancelSearch() {
  searchCancelled = true;
  stopSearchTimer();
  
  // Hide loading spinner
  const loadingSpinner = document.getElementById('search-loading-spinner');
  if (loadingSpinner) {
    loadingSpinner.classList.remove('active');
  }
  
  // Re-enable search button and input
  const searchBtn = document.getElementById('search-btn');
  const searchInput = document.getElementById('search-input');
  if (searchBtn) searchBtn.disabled = false;
  if (searchInput) searchInput.disabled = false;
  
  // Clear search time display
  const timeDisplay = document.getElementById('search-time-display');
  if (timeDisplay) {
    timeDisplay.textContent = '';
  }
}

function escapeSearchHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function performSearch() {
  const query = document.getElementById('search-input').value.trim();
  if (!query) return;
  
  // Reset cancellation flag
  searchCancelled = false;
  
  // Get UI elements
  const searchBtn = document.getElementById('search-btn');
  const searchInput = document.getElementById('search-input');
  const loadingSpinner = document.getElementById('search-loading-spinner');
  const container = document.getElementById('search-results-container');
  const timeDisplay = document.getElementById('search-time-display');
  const cancelBtn = document.getElementById('search-cancel-btn');
  
  // Disable search button and input during search
  if (searchBtn) searchBtn.disabled = true;
  if (searchInput) searchInput.disabled = true;
  
  // Show loading spinner
  if (loadingSpinner) {
    loadingSpinner.classList.add('active');
  }
  
  // Setup cancel button handler
  if (cancelBtn) {
    cancelBtn.onclick = cancelSearch;
  }
  
  // Hide previous results container while searching
  if (container) {
    container.style.display = 'none';
  }
  
  // Clear previous search time
  if (timeDisplay) {
    timeDisplay.textContent = '';
  }

  const warnBoxStart = document.getElementById('search-warnings-errors');
  if (warnBoxStart) {
    warnBoxStart.innerHTML = '';
    warnBoxStart.style.display = 'none';
  }
  
  // Start timer
  startSearchTimer();
  
  // Get selected algorithm
  const algorithmSelect = document.getElementById('search-algorithm');
  const algorithm = algorithmSelect ? algorithmSelect.value : 'hybrid';
  
  // Add to MRU - move to top if exists, otherwise add to top
  const index = mruSearches.indexOf(query);
  if (index !== -1) {
    mruSearches.splice(index, 1);
  }
  mruSearches.unshift(query);
  if (mruSearches.length > 10) {
    mruSearches.pop();
  }
  updateMRUList();
  saveSettings();
  
  // Hide dropdown after search
  hideMRUDropdown();
  
  try {
    // Perform search asynchronously - this won't block the UI
    // Use setTimeout to ensure UI updates (spinner shows) before search starts
    await new Promise(resolve => setTimeout(resolve, 0));
    
    // Check if cancelled before starting search
    if (searchCancelled) {
      return;
    }
    
    const searchPayload = await window.electronAPI.search(query, 10, algorithm);
    const results = searchPayload && Array.isArray(searchPayload.results) ? searchPayload.results : [];
    const searchWarnings = (searchPayload && searchPayload.warnings) || [];
    const searchErrors = (searchPayload && searchPayload.errors) || [];
    for (const w of searchWarnings) console.warn('[search]', w);
    for (const e of searchErrors) console.error('[search]', e);
    
    // Check if cancelled after search completes
    if (searchCancelled) {
      return;
    }
    
    // Get final time before stopping timer
    const endTime = performance.now();
    const elapsedMs = searchStartTime ? (endTime - searchStartTime) : 0;
    const elapsedSeconds = (elapsedMs / 1000).toFixed(3);
    
    // Stop timer
    stopSearchTimer();
    
    // Display search time
    if (timeDisplay) {
      timeDisplay.textContent = `Search completed in ${elapsedSeconds}s`;
    }
    
    const resultsDiv = document.getElementById('search-results');
    const tbody = document.getElementById('search-results-tbody');
    const warnBox = document.getElementById('search-warnings-errors');
    if (warnBox) {
      warnBox.innerHTML = '';
      const parts = [];
      for (const w of searchWarnings) {
        parts.push(`<div class="search-message search-message-warning">${escapeSearchHtml(w)}</div>`);
      }
      for (const e of searchErrors) {
        parts.push(`<div class="search-message search-message-error">${escapeSearchHtml(e)}</div>`);
      }
      if (parts.length) {
        warnBox.innerHTML = `<div class="search-messages-header">Warnings / errors</div>${parts.join('')}`;
        warnBox.style.display = 'block';
      } else {
        warnBox.style.display = 'none';
      }
    }

    if (tbody) {
      tbody.innerHTML = '';
      
      if (results.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">No results found</td></tr>';
      } else {
        results.forEach((result, index) => {
          const row = document.createElement('tr');
          row.style.cursor = 'pointer';
          row.addEventListener('click', () => showSearchChunkDetail(result.chunkId, result));
          const preview = result.content.substring(0, 100) + (result.content.length > 100 ? '...' : '');
          
          // Format score based on algorithm
          let scoreDisplay = '';
          if (result.score !== undefined && result.score !== null) {
            if (result.algorithm === 'Vector' || result.algorithm === 'Hybrid') {
              // For vector/hybrid, show as percentage
              scoreDisplay = `${(result.score * 100).toFixed(4)}%`;
            } else {
              // For BM25/TF-IDF, show raw score with 4 decimal places
              scoreDisplay = result.score.toFixed(4);
            }
          } else {
            scoreDisplay = 'N/A';
          }
          
          const isWeb = result.metadata?.source === 'web';
          const sourceBadge = isWeb
            ? '<span class="source-badge source-web">Web</span>'
            : '<span class="source-badge source-local">Local</span>';
          
          row.innerHTML = `
            <td><span class="similarity-score">${scoreDisplay}</span></td>
            <td><span class="algorithm-badge">${result.algorithm || 'Hybrid'}</span></td>
            <td>${sourceBadge}</td>
            <td>${result.metadata?.fileName || 'Unknown'}</td>
            <td>${preview}</td>
          `;
          tbody.appendChild(row);
        });
      }
    }
    
    // Show results container
    if (container) {
      container.style.display = 'flex';
      container.style.flexDirection = 'column';
      container.style.height = 'calc(100vh - 200px)'; // Adjust based on header and padding
      applySearchSplitterPosition();
    }
  } catch (error) {
    // Only show error if not cancelled
    if (!searchCancelled) {
      console.error('Search error:', error);
      alert(`Search failed: ${error.message}`);
    }
  } finally {
    // Stop timer
    stopSearchTimer();
    
    // Hide loading spinner
    if (loadingSpinner) {
      loadingSpinner.classList.remove('active');
    }
    
    // Re-enable search button and input
    if (searchBtn) searchBtn.disabled = false;
    if (searchInput) searchInput.disabled = false;
    
    // Remove cancel button handler
    if (cancelBtn) {
      cancelBtn.onclick = null;
    }
  }
}

async function showSearchChunkDetail(chunkId, result) {
  const detail = document.getElementById('search-chunk-detail');
  const content = document.getElementById('search-chunk-content');
  const metadata = document.getElementById('search-chunk-metadata');
  
  // If result is provided, use it; otherwise fetch from API
  let chunkData = result;
  if (!chunkData) {
    chunkData = await window.electronAPI.getChunkContent(chunkId);
  }
  
  if (chunkData) {
    // Set content
    content.textContent = chunkData.content || '';
    
    // Format metadata as key/value grid
    metadata.innerHTML = '';
    const metadataItems = [];
    
    // Add standard fields
    if (chunkData.id) metadataItems.push({ label: 'Chunk ID', value: String(chunkData.id) });
    if (chunkData.chunk_index !== undefined) metadataItems.push({ label: 'Chunk Index', value: String(chunkData.chunk_index) });
    if (chunkData.document_id) metadataItems.push({ label: 'Document ID', value: String(chunkData.document_id) });
    if (chunkData.score !== undefined) {
      let scoreValue = '';
      if (chunkData.algorithm === 'Vector' || chunkData.algorithm === 'Hybrid') {
        scoreValue = `${(chunkData.score * 100).toFixed(4)}%`;
      } else {
        scoreValue = chunkData.score.toFixed(4);
      }
      metadataItems.push({ label: 'Score', value: scoreValue });
    }
    if (chunkData.algorithm) metadataItems.push({ label: 'Algorithm', value: String(chunkData.algorithm) });
    
    // Add metadata from result.metadata or chunkData.metadata object
    const metadataObj = chunkData.metadata || {};
    Object.entries(metadataObj).forEach(([key, value]) => {
      let stringValue;
      if (value === null || value === undefined) {
        stringValue = 'N/A';
      } else if (typeof value === 'object') {
        stringValue = JSON.stringify(value, null, 2);
      } else {
        stringValue = String(value);
      }
      metadataItems.push({
        label: key,
        value: stringValue
      });
    });
    
    // Render metadata items in a grid
    metadataItems.forEach(item => {
      const itemDiv = document.createElement('div');
      itemDiv.className = 'search-chunk-metadata-item';
      
      const label = document.createElement('div');
      label.className = 'search-chunk-metadata-label';
      label.textContent = item.label + ':';
      
      const value = document.createElement('div');
      value.className = 'search-chunk-metadata-value';
      const stringValue = String(item.value || '');
      if (stringValue.length > 100 || stringValue.includes('\n')) {
        const pre = document.createElement('pre');
        pre.textContent = stringValue;
        value.appendChild(pre);
      } else {
        value.textContent = stringValue;
      }
      
      itemDiv.appendChild(label);
      itemDiv.appendChild(value);
      metadata.appendChild(itemDiv);
    });
    
    // Apply splitter position after content is loaded
    setTimeout(() => applyChunkDetailSplitterPosition(), 0);
  }
}

window.closeSearchChunkDetail = function() {
  // Don't hide the detail panel, just clear it or keep it visible
  // The splitter should remain visible
};

function updateMRUList() {
  const list = document.getElementById('mru-list');
  list.innerHTML = '';
  
  mruSearches.forEach(query => {
    const item = document.createElement('div');
    item.className = 'mru-item';
    item.textContent = query;
    item.addEventListener('click', () => {
      document.getElementById('search-input').value = query;
      performSearch();
    });
    list.appendChild(item);
  });
  
  // Also update dropdown
  updateMRUDropdown();
}

function setupMRUDropdown() {
  const searchInput = document.getElementById('search-input');
  const searchBox = document.querySelector('.search-box');
  
  if (!searchInput || !searchBox) return;
  
  // Check if dropdown already exists
  if (document.getElementById('mru-dropdown')) {
    return;
  }
  
  // Create dropdown container
  const dropdown = document.createElement('div');
  dropdown.id = 'mru-dropdown';
  dropdown.className = 'mru-dropdown';
  searchBox.style.position = 'relative';
  searchBox.appendChild(dropdown);
  
  // Show dropdown on focus or when typing
  searchInput.addEventListener('focus', showMRUDropdown);
  searchInput.addEventListener('input', (e) => {
    if (e.target.value.trim() || mruSearches.length > 0) {
      showMRUDropdown();
    } else {
      hideMRUDropdown();
    }
  });
  
  // Hide dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!searchBox.contains(e.target)) {
      hideMRUDropdown();
    }
  });
  
  // Handle keyboard navigation
  let selectedIndex = -1;
  searchInput.addEventListener('keydown', (e) => {
    const dropdown = document.getElementById('mru-dropdown');
    if (dropdown.style.display === 'none' || dropdown.style.display === '') {
      selectedIndex = -1;
      return;
    }
    
    const items = dropdown.querySelectorAll('.mru-dropdown-item');
    if (items.length === 0) {
      selectedIndex = -1;
      return;
    }
    
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
      updateDropdownSelection(items, selectedIndex);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, -1);
      updateDropdownSelection(items, selectedIndex);
    } else if (e.key === 'Enter' && selectedIndex >= 0 && selectedIndex < items.length) {
      e.preventDefault();
      items[selectedIndex].click();
      selectedIndex = -1;
    } else if (e.key === 'Escape') {
      hideMRUDropdown();
      selectedIndex = -1;
    } else {
      // Reset selection when typing other keys
      selectedIndex = -1;
      updateDropdownSelection(items, selectedIndex);
    }
  });
}

function updateDropdownSelection(items, index) {
  items.forEach((item, i) => {
    if (i === index) {
      item.classList.add('selected');
      item.scrollIntoView({ block: 'nearest' });
    } else {
      item.classList.remove('selected');
    }
  });
}

function showMRUDropdown() {
  const dropdown = document.getElementById('mru-dropdown');
  if (!dropdown) return;
  if (mruSearches.length > 0) {
    dropdown.style.display = 'block';
    updateMRUDropdown();
  }
}

function hideMRUDropdown() {
  const dropdown = document.getElementById('mru-dropdown');
  if (dropdown) {
    dropdown.style.display = 'none';
  }
}

function updateMRUDropdown() {
  const dropdown = document.getElementById('mru-dropdown');
  if (!dropdown) return;
  
  const searchInput = document.getElementById('search-input');
  if (!searchInput) return;
  
  const query = searchInput.value.trim().toLowerCase();
  
  dropdown.innerHTML = '';
  
  // Filter and show up to 10 matching items
  const filtered = mruSearches
    .filter(item => !query || item.toLowerCase().includes(query))
    .slice(0, 10);
  
  if (filtered.length === 0 && query && mruSearches.length > 0) {
    // If there's a query but no matches, show nothing
    return;
  } else if (filtered.length > 0) {
    // Show filtered results
    filtered.forEach(queryItem => {
      addDropdownItem(dropdown, queryItem);
    });
  } else if (mruSearches.length > 0) {
    // Show all MRU items if no query
    mruSearches.slice(0, 10).forEach(queryItem => {
      addDropdownItem(dropdown, queryItem);
    });
  }
}

function addDropdownItem(dropdown, query) {
  const item = document.createElement('div');
  item.className = 'mru-dropdown-item';
  item.textContent = query;
  item.addEventListener('click', () => {
    document.getElementById('search-input').value = query;
    performSearch();
  });
  dropdown.appendChild(item);
}

async function refreshServerStatus() {
  const status = await window.electronAPI.getMCPServerStatus();
  const statusText = document.getElementById('server-status-text');
  const startBtn = document.getElementById('start-server-btn');
  const stopBtn = document.getElementById('stop-server-btn');
  const endpointsSection = document.getElementById('server-endpoints');
  const restUrlSpan = document.getElementById('rest-url-value');
  const mcpUrlSpan = document.getElementById('mcp-url-value');
  const endpointsTbody = document.getElementById('endpoints-tbody');
  
  statusText.textContent = status.running ? `Running on port ${status.port}` : 'Stopped';
  startBtn.disabled = status.running;
  stopBtn.disabled = !status.running;
  const selfTestBtn = document.getElementById('self-test-btn');
  if (selfTestBtn) {
    selfTestBtn.disabled = !status.running;
  }
  
  // Show/hide endpoints section based on server status
  if (status.running && status.port) {
    endpointsSection.style.display = 'block';
    
    // Display URLs
    restUrlSpan.textContent = status.restUrl || `http://localhost:${status.port}`;
    mcpUrlSpan.textContent = status.mcpUrl || `http://localhost:${status.port}/mcp`;
    
    // Setup copy buttons
    setupCopyButtons();
    
    // Define available endpoints
    const endpoints = [
      { method: 'GET', path: '/health', description: 'Health check endpoint', requiresPayload: false, requiresParams: false },
      { method: 'GET', path: '/status', description: 'Server status (port, MCP URL, admin URL, store URL)', requiresPayload: false, requiresParams: false },
      { method: 'GET', path: '/mcp', description: 'MCP endpoint metadata (use POST for JSON-RPC)', requiresPayload: false, requiresParams: false },
      { method: 'POST', path: '/mcp', description: 'MCP protocol — JSON-RPC 2.0 (initialize, tools/list, tools/call, …)', requiresPayload: true, requiresParams: false },
      { method: 'GET', path: '/admin/stats', description: 'Vector store statistics (?namespace= for a specific corpus)', requiresPayload: false, requiresParams: false },
      { method: 'POST', path: '/admin/corpus-search', description: 'Search corpus (body: query, optional namespace)', requiresPayload: true, requiresParams: false },
      { method: 'GET', path: '/admin/documents', description: 'List documents (?namespace= scopes one corpus)', requiresPayload: false, requiresParams: false },
      { method: 'GET', path: '/admin/documents/:documentId', description: 'Get document by ID (?namespace= if ambiguous)', requiresPayload: false, requiresParams: true, params: [{ name: 'documentId', label: 'Document ID', type: 'text' }] },
      { method: 'GET', path: '/admin/documents/:documentId/chunks', description: 'Chunks for document (?namespace= if ambiguous)', requiresPayload: false, requiresParams: true, params: [{ name: 'documentId', label: 'Document ID', type: 'text' }] },
      { method: 'GET', path: '/admin/chunks/:chunkId', description: 'Get chunk by ID (?namespace= if ambiguous)', requiresPayload: false, requiresParams: true, params: [{ name: 'chunkId', label: 'Chunk ID', type: 'text' }] },
      { method: 'POST', path: '/admin/ingest/file', description: 'Ingest file (?namespace= targets corpus; omit = active)', requiresPayload: true, requiresParams: false },
      { method: 'POST', path: '/admin/ingest/directory', description: 'Ingest directory (?namespace= targets corpus)', requiresPayload: true, requiresParams: false }
    ];
    
    endpointsTbody.innerHTML = '';
    endpoints.forEach((endpoint, index) => {
      const row = document.createElement('tr');
      const methodCell = document.createElement('td');
      methodCell.className = `endpoint-method endpoint-method-${endpoint.method.toLowerCase()}`;
      methodCell.textContent = endpoint.method;
      
      const pathCell = document.createElement('td');
      pathCell.className = 'endpoint-path';
      pathCell.textContent = endpoint.path;
      
      const descCell = document.createElement('td');
      descCell.className = 'endpoint-description';
      descCell.textContent = endpoint.description;
      
      const actionsCell = document.createElement('td');
      const testBtn = document.createElement('button');
      testBtn.className = 'btn btn-secondary';
      testBtn.textContent = 'Test';
      testBtn.style.fontSize = '12px';
      testBtn.style.padding = '6px 12px';
      testBtn.addEventListener('click', () => openEndpointTestModal(endpoint, status.restUrl || `http://localhost:${status.port}`));
      actionsCell.appendChild(testBtn);
      
      row.appendChild(methodCell);
      row.appendChild(pathCell);
      row.appendChild(descCell);
      row.appendChild(actionsCell);
      endpointsTbody.appendChild(row);
    });
  } else {
    endpointsSection.style.display = 'none';
  }

  const inboundEl = document.getElementById('inbound-passthrough-status');
  if (inboundEl && status.inboundPassthrough) {
    const p = status.inboundPassthrough;
    const lines = [];
    if (!p.masterEnabled) {
      lines.push('Inbound LLM passthrough: off (enable LLM Passthrough under Settings → Server).');
    } else {
      lines.push('Inbound LLM passthrough: on (LLM Passthrough + RAG; HTTP entry points below).');
      if (p.ollama.enabled) {
        if (p.ollama.listening) {
          lines.push(
            `· Ollama-style: http://127.0.0.1:${p.ollama.port} — POST /api/chat, GET /api/tags. Optional header X-Froggy-Namespace or ?namespace=.`
          );
        } else {
          lines.push(
            `· Ollama-style: not listening (port ${p.ollama.port || '—'})${p.ollama.lastError ? ' — ' + p.ollama.lastError : ''}`
          );
        }
      }
      if (p.openai.enabled) {
        if (p.openai.listening) {
          lines.push(
            `· OpenAI-compatible: http://127.0.0.1:${p.openai.port}/v1/chat/completions — GET /v1/models.`
          );
        } else {
          lines.push(
            `· OpenAI-compatible: not listening (port ${p.openai.port || '—'})${p.openai.lastError ? ' — ' + p.openai.lastError : ''}`
          );
        }
      }
      if (!p.ollama.enabled && !p.openai.enabled) {
        lines.push('· No listener types enabled (enable Ollama and/or OpenAI-compatible above).');
      }
      lines.push('Streaming (stream: true) is not supported on inbound listeners.');
    }
    inboundEl.textContent = lines.join('\n');
  } else if (inboundEl) {
    inboundEl.textContent = '';
  }

  void refreshAppStatusBar();
}

function setupCopyButtons() {
  // Remove existing event listeners by cloning and replacing buttons
  const copyButtons = document.querySelectorAll('.btn-copy');
  copyButtons.forEach(btn => {
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    
    newBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      const urlType = newBtn.getAttribute('data-url-type');
      let urlToCopy = '';
      
      if (urlType === 'rest') {
        urlToCopy = document.getElementById('rest-url-value').textContent;
      } else if (urlType === 'mcp') {
        urlToCopy = document.getElementById('mcp-url-value').textContent;
      }
      
      if (urlToCopy) {
        try {
          await window.electronAPI.copyToClipboard(urlToCopy);
          // Visual feedback
          const originalText = newBtn.textContent;
          newBtn.textContent = '✓ Copied!';
          newBtn.style.background = '#4caf50';
          setTimeout(() => {
            newBtn.textContent = originalText;
            newBtn.style.background = '';
          }, 2000);
        } catch (error) {
          console.error('Error copying to clipboard:', error);
          alert('Failed to copy to clipboard');
        }
      }
    });
  });
}

async function refreshServerLogs() {
  const logs = await window.electronAPI.getMCPServerLogs(100);
  const container = document.getElementById('log-container');
  
  container.innerHTML = '';
  logs.forEach(log => {
    addServerLog(log);
  });
}

function addServerLog(log) {
  const container = document.getElementById('log-container');
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  
  const levelClass = `log-level-${log.level}`;
  entry.innerHTML = `
    <span class="log-timestamp">${new Date(log.timestamp).toLocaleTimeString()}</span>
    <span class="${levelClass}">[${log.level.toUpperCase()}]</span>
    <span class="log-message">${log.message}</span>
  `;
  
  container.appendChild(entry);
  container.scrollTop = container.scrollHeight;
}

// Global functions for inline handlers
window.removeFile = async function(filePath) {
  if (confirm(`Remove file ${filePath}?`)) {
    try {
      await window.electronAPI.removeFile(filePath);
      await refreshFiles();
      await refreshVectorStore();
    } catch (error) {
      console.error('Error removing file:', error);
      alert(`Error removing file: ${error.message}`);
    }
  }
};

window.removeDirectory = async function(dirPath) {
  if (confirm(`Remove directory ${dirPath}?`)) {
    try {
      await window.electronAPI.removeDirectory(dirPath);
      await refreshDirectories();
      await refreshVectorStore();
    } catch (error) {
      console.error('Error removing directory:', error);
      alert(`Error removing directory: ${error.message}`);
    }
  }
};

window.updateFileWatch = async function(filePath, watch) {
  await window.electronAPI.updateFileWatch(filePath, watch);
};

window.updateDirectoryWatch = async function(dirPath, watch) {
  const dir = (await window.electronAPI.getDirectories()).find(d => d.path === dirPath);
  await window.electronAPI.updateDirectoryWatch(dirPath, watch, dir?.recursive || false);
};

window.updateDirectoryRecursive = async function(dirPath, recursive) {
  const dir = (await window.electronAPI.getDirectories()).find(d => d.path === dirPath);
  await window.electronAPI.updateDirectoryWatch(dirPath, dir?.watch || false, recursive);
};

window.updateFileActive = async function(filePath, active) {
  await window.electronAPI.updateFileActive(filePath, active);
  await refreshFiles();
  await refreshVectorStore();
};

window.updateDirectoryActive = async function(dirPath, active) {
  await window.electronAPI.updateDirectoryActive(dirPath, active);
  await refreshDirectories();
  await refreshVectorStore();
};

function setupDragAndDrop() {
  const filesCanvas = document.getElementById('files-canvas');
  const directoriesCanvas = document.getElementById('directories-canvas');
  
  // Setup files canvas drag and drop
  if (filesCanvas) {
    filesCanvas.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      filesCanvas.style.backgroundColor = '#e3f2fd';
    });
    
    filesCanvas.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Only reset background if we're leaving the canvas (not just entering a child element)
      if (!filesCanvas.contains(e.relatedTarget)) {
        filesCanvas.style.backgroundColor = '';
      }
    });
    
    filesCanvas.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      filesCanvas.style.backgroundColor = '';
      
      const items = Array.from(e.dataTransfer.files);
      for (const item of items) {
        if (item.path) {
          // Check if it's a directory
          const isDir = await window.electronAPI.isDirectory(item.path);
          if (!isDir) {
            // Only process files on the files canvas
            try {
              await window.electronAPI.ingestFile(item.path, false);
            } catch (error) {
              console.error('Error ingesting file:', error);
              alert(`Error adding file ${item.path}: ${error.message}`);
            }
          } else {
            // If it's a directory, show a message
            alert(`Please drop directories on the Directories screen. ${item.path} is a directory.`);
          }
        }
      }
      
      await refreshFiles();
      await refreshDirectories();
    });
  }
  
  // Setup directories canvas drag and drop
  if (directoriesCanvas) {
    directoriesCanvas.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      directoriesCanvas.style.backgroundColor = '#e3f2fd';
    });
    
    directoriesCanvas.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Only reset background if we're leaving the canvas (not just entering a child element)
      if (!directoriesCanvas.contains(e.relatedTarget)) {
        directoriesCanvas.style.backgroundColor = '';
      }
    });
    
    directoriesCanvas.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      directoriesCanvas.style.backgroundColor = '';
      
      const items = Array.from(e.dataTransfer.files);
      const directories = [];
      const files = [];
      
      // Separate directories from files
      for (const item of items) {
        if (item.path) {
          const isDir = await window.electronAPI.isDirectory(item.path);
          if (isDir) {
            directories.push(item.path);
          } else {
            files.push(item.path);
          }
        }
      }
      
      // Process directories
      for (const dirPath of directories) {
        try {
          await window.electronAPI.ingestDirectory(dirPath, false, false);
        } catch (error) {
          console.error('Error ingesting directory:', error);
          alert(`Error adding directory ${dirPath}: ${error.message}`);
        }
      }
      
      // Show message if files were dropped on directories canvas
      if (files.length > 0 && directories.length === 0) {
        alert(`Please drop directories here. Files should be dropped on the Files screen.`);
      } else if (files.length > 0 && directories.length > 0) {
        alert(`Added ${directories.length} directory(ies). ${files.length} file(s) were ignored. Please drop files on the Files screen.`);
      }
      
      await refreshFiles();
      await refreshDirectories();
    });
  }
}


function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

async function saveSettings() {
  const settings = await window.electronAPI.getSettings();
  settings.splitterPosition = splitterPosition;
  settings.searchSplitterPosition = searchSplitterPosition;
  settings.chunkDetailSplitterPosition = chunkDetailSplitterPosition;
  settings.vectorStoreSplitterPosition = vectorStoreSplitterPosition;
  settings.mruSearches = mruSearches;
  await window.electronAPI.saveSettings(settings);
  window.electronAPI.notifyTraySettingsChanged();
}

/** In-memory draft for per-provider LLM upstream while the settings modal is open. */
const llmPassthroughEndpointDraft = {
  ollama: { baseUrl: '', model: '', apiKey: '' },
  openai: { baseUrl: '', model: '', apiKey: '' }
};

function fillLlmPassthroughDraftFromSettings(settings) {
  const d = llmPassthroughEndpointDraft;
  d.ollama.baseUrl =
    settings.llmPassthroughOllamaBaseUrl != null && String(settings.llmPassthroughOllamaBaseUrl).trim() !== ''
      ? String(settings.llmPassthroughOllamaBaseUrl).trim()
      : 'http://127.0.0.1:11434';
  d.ollama.model = String(settings.llmPassthroughOllamaModel || '').trim();
  d.ollama.apiKey = String(settings.llmPassthroughOllamaApiKey || '').trim();
  d.openai.baseUrl = String(settings.llmPassthroughOpenAiBaseUrl || '').trim();
  d.openai.model = String(settings.llmPassthroughOpenAiModel || '').trim();
  d.openai.apiKey = String(settings.llmPassthroughOpenAiApiKey || '').trim();
  const prov = settings.llmPassthroughProvider === 'openai' ? 'openai' : 'ollama';
  if (prov === 'openai') {
    if (!d.openai.baseUrl && settings.llmPassthroughBaseUrl) {
      d.openai.baseUrl = String(settings.llmPassthroughBaseUrl).trim();
    }
    if (!d.openai.model && settings.llmPassthroughModel) {
      d.openai.model = String(settings.llmPassthroughModel).trim();
    }
    if (!d.openai.apiKey && settings.llmPassthroughApiKey) {
      d.openai.apiKey = String(settings.llmPassthroughApiKey).trim();
    }
  } else {
    if (!d.ollama.baseUrl && settings.llmPassthroughBaseUrl) {
      d.ollama.baseUrl = String(settings.llmPassthroughBaseUrl).trim() || 'http://127.0.0.1:11434';
    }
    if (!d.ollama.model && settings.llmPassthroughModel) {
      d.ollama.model = String(settings.llmPassthroughModel).trim();
    }
    if (!d.ollama.apiKey && settings.llmPassthroughApiKey) {
      d.ollama.apiKey = String(settings.llmPassthroughApiKey).trim();
    }
  }
}

function applyLlmPassthroughDraftToInputs(prov) {
  const p = prov === 'openai' ? 'openai' : 'ollama';
  const d = llmPassthroughEndpointDraft[p];
  const baseEl = document.getElementById('settings-llm-passthrough-base-url-input');
  const modelEl = document.getElementById('settings-llm-passthrough-model-input');
  const keyEl = document.getElementById('settings-llm-passthrough-api-key-input');
  if (baseEl) {
    baseEl.value =
      d.baseUrl || (p === 'ollama' ? 'http://127.0.0.1:11434' : '');
  }
  if (modelEl) modelEl.value = d.model || '';
  if (keyEl) keyEl.value = '';
}

/**
 * @param {'ollama' | 'openai'} prov Provider whose values are currently shown in the URL/model/key inputs
 */
function flushLlmPassthroughDraftFromInputs(prov) {
  const p = prov === 'openai' ? 'openai' : 'ollama';
  const baseEl = document.getElementById('settings-llm-passthrough-base-url-input');
  const modelEl = document.getElementById('settings-llm-passthrough-model-input');
  const keyEl = document.getElementById('settings-llm-passthrough-api-key-input');
  const d = llmPassthroughEndpointDraft[p];
  d.baseUrl = baseEl ? String(baseEl.value || '').trim() : '';
  d.model = modelEl ? String(modelEl.value || '').trim() : '';
  const newKey = keyEl ? String(keyEl.value || '').trim() : '';
  if (newKey !== '') {
    d.apiKey = newKey;
  }
}

async function loadServerSettings() {
  const settings = await window.electronAPI.getSettings();

  const llmEnabled = document.getElementById('settings-llm-passthrough-enabled-input');
  if (llmEnabled) {
    llmEnabled.checked = settings.llmPassthroughEnabled === true;
  }

  const serverPortInput = document.getElementById('settings-server-port-input');
  if (serverPortInput) {
    serverPortInput.value = settings.serverPort || 3000;
  }

  const autoStartServerInput = document.getElementById('settings-auto-start-server-input');
  if (autoStartServerInput) {
    autoStartServerInput.checked = settings.autoStartServer || false;
  }

  fillLlmPassthroughDraftFromSettings(settings);
  const provider = document.getElementById('settings-llm-passthrough-provider-select');
  if (provider) {
    provider.value = settings.llmPassthroughProvider === 'openai' ? 'openai' : 'ollama';
    provider.dataset.lastProvider = provider.value;
    applyLlmPassthroughDraftToInputs(provider.value === 'openai' ? 'openai' : 'ollama');
  }
  syncLlmPassthroughProviderUi();

  const oEn = document.getElementById('settings-passthrough-ollama-listen-enabled-input');
  if (oEn) {
    oEn.checked = settings.passthroughOllamaListenEnabled === true;
  }
  const oPort = document.getElementById('settings-passthrough-ollama-listen-port-input');
  if (oPort) {
    oPort.value =
      settings.passthroughOllamaListenPort != null ? settings.passthroughOllamaListenPort : 11435;
  }
  const aiEn = document.getElementById('settings-passthrough-openai-listen-enabled-input');
  if (aiEn) {
    aiEn.checked = settings.passthroughOpenAiListenEnabled === true;
  }
  const aiPort = document.getElementById('settings-passthrough-openai-listen-port-input');
  if (aiPort) {
    aiPort.value =
      settings.passthroughOpenAiListenPort != null ? settings.passthroughOpenAiListenPort : 18080;
  }
}

function loadWebSearchSettingsFrom(settings) {
  const googleKey = document.getElementById('settings-google-custom-search-api-key-input');
  if (googleKey) {
    googleKey.value = '';
    googleKey.placeholder = settings.googleCustomSearchApiKey
      ? 'Saved key is configured; leave blank to keep it'
      : 'Leave blank to keep existing key';
  }
  const googleKeyStatus = document.getElementById('settings-google-custom-search-api-key-status');
  if (googleKeyStatus) {
    googleKeyStatus.textContent = settings.googleCustomSearchApiKey
      ? 'A Google Custom Search API key is saved. Enter a new key only if you want to replace it.'
      : 'No Google Custom Search API key is saved yet.';
  }
  const googleCx = document.getElementById('settings-google-custom-search-engine-id-input');
  if (googleCx) {
    googleCx.value = settings.googleCustomSearchEngineId || '';
  }
  const googleNum = document.getElementById('settings-google-custom-search-num-results-input');
  if (googleNum) {
    googleNum.value =
      settings.googleCustomSearchNumResults != null ? settings.googleCustomSearchNumResults : 5;
  }
  const includeWeb = document.getElementById('settings-llm-passthrough-include-web-results-input');
  if (includeWeb) {
    includeWeb.checked = settings.llmPassthroughIncludeWebResults === true;
  }
  const saveStatus = document.getElementById('settings-web-search-save-status');
  if (saveStatus) {
    saveStatus.textContent = '';
  }
}

async function loadWebSearchSettings() {
  const settings = await window.electronAPI.getSettings();
  loadWebSearchSettingsFrom(settings);
}

function applyWebSearchSettingsFieldsToSettings(settings) {
  const googleApiKeyInput = document.getElementById('settings-google-custom-search-api-key-input');
  const googleCxInput = document.getElementById('settings-google-custom-search-engine-id-input');
  const googleNumInput = document.getElementById('settings-google-custom-search-num-results-input');
  const includeWebInput = document.getElementById('settings-llm-passthrough-include-web-results-input');
  if (!googleApiKeyInput || !googleCxInput || !googleNumInput || !includeWebInput) {
    return { ok: false, message: 'Settings form is missing Web Search fields.' };
  }
  const googleNumResults = parseInt(googleNumInput.value, 10) || 5;
  if (googleNumResults < 1 || googleNumResults > 10) {
    return { ok: false, message: 'Google Custom Search results per search must be between 1 and 10.' };
  }
  const newGoogleApiKey = String(googleApiKeyInput.value || '').trim();
  if (newGoogleApiKey !== '') {
    settings.googleCustomSearchApiKey = newGoogleApiKey;
  }
  settings.googleCustomSearchEngineId = String(googleCxInput.value || '').trim();
  settings.googleCustomSearchNumResults = googleNumResults;
  settings.llmPassthroughIncludeWebResults = includeWebInput.checked === true;
  return { ok: true };
}

let webSearchSettingsSaveTimer = null;

function schedulePersistWebSearchSettings() {
  if (webSearchSettingsSaveTimer) clearTimeout(webSearchSettingsSaveTimer);
  webSearchSettingsSaveTimer = setTimeout(() => {
    webSearchSettingsSaveTimer = null;
    void persistWebSearchSettingsFromInputs({ silent: true });
  }, 450);
}

async function persistWebSearchSettingsFromInputs(options = {}) {
  const saveStatus = document.getElementById('settings-web-search-save-status');
  try {
    const settings = await window.electronAPI.getSettings();
    const result = applyWebSearchSettingsFieldsToSettings(settings);
    if (!result.ok) {
      if (!options.silent) {
        alert(result.message);
      }
      if (saveStatus && !options.silent) {
        saveStatus.textContent = result.message;
      }
      return false;
    }
    settings.__allowWebSearchSettingsSave = true;
    await window.electronAPI.saveSettings(settings);
    window.electronAPI.notifyTraySettingsChanged();
    loadWebSearchSettingsFrom(settings);
    if (saveStatus) {
      saveStatus.textContent = 'Saved.';
    }
    return true;
  } catch (e) {
    console.error('persistWebSearchSettingsFromInputs', e);
    if (!options.silent) {
      alert(`Could not save web search settings: ${e.message}`);
    }
    if (saveStatus && !options.silent) {
      saveStatus.textContent = `Could not save: ${e.message}`;
    }
    return false;
  }
}

function syncLlmPassthroughProviderUi() {
  const sel = document.getElementById('settings-llm-passthrough-provider-select');
  const wrap = document.getElementById('settings-llm-passthrough-api-key-wrap');
  if (!sel || !wrap) return;
  wrap.style.display = sel.value === 'openai' ? 'block' : 'none';
}

function setLlmTestInboundHostSectionVisible(directIpc) {
  const section = document.getElementById('llm-passthrough-inbound-test-host-section');
  if (section) {
    section.style.display = directIpc ? 'none' : 'flex';
  }
}

async function loadLlmTestPanelRetrievalSettings() {
  const settings = await window.electronAPI.getSettings();
  const transportEl = document.getElementById('llm-passthrough-test-transport-select');
  if (transportEl) {
    const tr = settings.llmPassthroughTestTransport === 'direct-ipc' ? 'direct-ipc' : 'inbound-http';
    transportEl.value = tr;
    setLlmTestInboundHostSectionVisible(tr === 'direct-ipc');
  }
  const timeout = document.getElementById('llm-passthrough-timeout-input');
  if (timeout) {
    const ms =
      settings.llmPassthroughTimeoutMs != null ? settings.llmPassthroughTimeoutMs : 120000;
    timeout.value = String(Math.round(Number(ms) / 1000));
  }
  const algo = document.getElementById('llm-passthrough-search-algorithm-select');
  if (algo) {
    const a = settings.llmPassthroughSearchAlgorithm || 'hybrid';
    algo.value = ['hybrid', 'bm25', 'tfidf', 'vector'].includes(a) ? a : 'hybrid';
  }
  const h = String(settings.llmPassthroughTestInboundHostname || '127.0.0.1').trim() || '127.0.0.1';
  const preset = document.getElementById('llm-passthrough-test-inbound-host-preset-select');
  const customWrap = document.getElementById('llm-passthrough-test-inbound-host-custom-wrap');
  if (preset) {
    if (h === '127.0.0.1') {
      preset.value = '127.0.0.1';
    } else if (h.toLowerCase() === 'localhost') {
      preset.value = 'localhost';
    } else {
      preset.value = 'custom';
    }
  }
  if (customWrap) {
    customWrap.style.display = preset && preset.value === 'custom' ? 'flex' : 'none';
  }
  if (preset && preset.value === 'custom') {
    refreshLlmTestInboundHostMruSelect(settings);
  }
}

let llmTestRetrievalSaveTimer = null;
function schedulePersistLlmTestRetrievalSettings() {
  if (llmTestRetrievalSaveTimer) clearTimeout(llmTestRetrievalSaveTimer);
  llmTestRetrievalSaveTimer = setTimeout(() => {
    llmTestRetrievalSaveTimer = null;
    void persistLlmTestRetrievalSettingsFromInputs();
  }, 450);
}

/**
 * @param {unknown} raw
 * @returns {string | null} trimmed hostname / bracketed IPv6, or null if invalid
 */
function normalizeLlmPassthroughTestInboundHostname(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return null;
  if (t.length > 253) return null;
  if (/[\s\u0000-\u001f\/\\]/.test(t)) return null;
  return t;
}

/**
 * @param {unknown} hostname normalized or stored hostname
 * @returns {string} host portion safe inside http://HOST:port/…
 */
function formatHostnameForInboundTestUrl(hostname) {
  const n = normalizeLlmPassthroughTestInboundHostname(hostname);
  const t = n || '127.0.0.1';
  if (t.startsWith('[')) return t;
  if (/^[0-9A-Fa-f:]+$/.test(t) && t.includes(':')) return `[${t}]`;
  return t;
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function sanitizeLlmPassthroughTestInboundHostMru(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const x of raw) {
    const n = normalizeLlmPassthroughTestInboundHostname(x);
    if (!n) continue;
    const low = n.toLowerCase();
    if (low === '127.0.0.1' || low === 'localhost') continue;
    if (n === LLM_INBOUND_TEST_HOST_MRU_NEW) continue;
    if (seen.has(low)) continue;
    seen.add(low);
    out.push(n);
    if (out.length >= LLM_INBOUND_TEST_HOST_MRU_MAX) break;
  }
  return out;
}

/**
 * @param {string[]} mru
 * @param {string} hostname
 * @returns {string | null} canonical entry from MRU matching hostname (case-insensitive), or null
 */
function findCanonicalInboundHostMruMatch(mru, hostname) {
  const hn = String(hostname || '').trim();
  if (!hn) return null;
  const low = hn.toLowerCase();
  for (const x of mru) {
    const t = String(x).trim();
    if (t.toLowerCase() === low) return t;
  }
  return null;
}

/**
 * @param {Record<string, unknown>} settings mutated
 * @param {string} host normalized custom host
 */
function recordLlmPassthroughTestInboundHostMru(settings, host) {
  const n = normalizeLlmPassthroughTestInboundHostname(host);
  if (!n) return;
  const low = n.toLowerCase();
  if (low === '127.0.0.1' || low === 'localhost') return;
  let arr = sanitizeLlmPassthroughTestInboundHostMru(settings.llmPassthroughTestInboundHostMru);
  const idx = arr.findIndex((x) => x.toLowerCase() === low);
  if (idx >= 0) arr.splice(idx, 1);
  arr.unshift(n);
  if (arr.length > LLM_INBOUND_TEST_HOST_MRU_MAX) {
    arr = arr.slice(0, LLM_INBOUND_TEST_HOST_MRU_MAX);
  }
  settings.llmPassthroughTestInboundHostMru = arr;
}

/**
 * Rebuild Recent dropdown from settings and align selection + New field with stored hostname.
 * @param {Record<string, unknown>} settings
 */
function refreshLlmTestInboundHostMruSelect(settings) {
  const sel = document.getElementById('llm-passthrough-test-inbound-host-mru-select');
  const customIn = document.getElementById('llm-passthrough-test-inbound-host-custom-input');
  if (!sel) return;
  const mru = sanitizeLlmPassthroughTestInboundHostMru(settings.llmPassthroughTestInboundHostMru);
  const stored = String(settings.llmPassthroughTestInboundHostname || '').trim();
  sel.textContent = '';
  for (const host of mru) {
    const opt = document.createElement('option');
    opt.value = host;
    opt.textContent = host;
    sel.appendChild(opt);
  }
  const optNew = document.createElement('option');
  optNew.value = LLM_INBOUND_TEST_HOST_MRU_NEW;
  optNew.textContent = 'New host…';
  sel.appendChild(optNew);
  const lowStored = stored.toLowerCase();
  const isPresetBuiltin = stored === '127.0.0.1' || lowStored === 'localhost';
  const canon = !isPresetBuiltin ? findCanonicalInboundHostMruMatch(mru, stored) : null;
  if (canon) {
    sel.value = canon;
    if (customIn) customIn.value = '';
  } else if (!isPresetBuiltin && stored) {
    sel.value = LLM_INBOUND_TEST_HOST_MRU_NEW;
    if (customIn) customIn.value = stored;
  } else {
    sel.value = LLM_INBOUND_TEST_HOST_MRU_NEW;
    if (customIn) customIn.value = '';
  }
}

/**
 * Resolved custom inbound hostname from MRU select + New input (preset must be "custom").
 * @returns {string | null}
 */
function resolveLlmTestInboundCustomHostnameFromInputs() {
  const mruSel = document.getElementById('llm-passthrough-test-inbound-host-mru-select');
  const customIn = document.getElementById('llm-passthrough-test-inbound-host-custom-input');
  if (mruSel && mruSel.value && mruSel.value !== LLM_INBOUND_TEST_HOST_MRU_NEW) {
    return normalizeLlmPassthroughTestInboundHostname(mruSel.value);
  }
  return normalizeLlmPassthroughTestInboundHostname(customIn ? customIn.value : '');
}

async function persistLlmTestRetrievalSettingsFromInputs() {
  const algoEl = document.getElementById('llm-passthrough-search-algorithm-select');
  const timeoutEl = document.getElementById('llm-passthrough-timeout-input');
  if (!algoEl || !timeoutEl) return;
  const llmAlgo = algoEl.value || 'hybrid';
  const llmTimeoutSec = parseInt(timeoutEl.value, 10);
  const llmTimeoutMs = llmTimeoutSec * 1000;
  if (!['hybrid', 'bm25', 'tfidf', 'vector'].includes(llmAlgo)) return;
  if (!Number.isFinite(llmTimeoutSec) || llmTimeoutSec < 5 || llmTimeoutSec > 600) return;
  try {
    const settings = await window.electronAPI.getSettings();
    settings.llmPassthroughTimeoutMs = llmTimeoutMs;
    settings.llmPassthroughSearchAlgorithm = llmAlgo;
    const preset = document.getElementById('llm-passthrough-test-inbound-host-preset-select');
    let hostPatch = null;
    if (preset) {
      if (preset.value === '127.0.0.1') hostPatch = '127.0.0.1';
      else if (preset.value === 'localhost') hostPatch = 'localhost';
      else {
        hostPatch = resolveLlmTestInboundCustomHostnameFromInputs();
      }
      if (hostPatch != null) {
        settings.llmPassthroughTestInboundHostname = hostPatch;
        if (preset.value === 'custom') {
          recordLlmPassthroughTestInboundHostMru(settings, hostPatch);
        }
      }
    }
    const transportEl = document.getElementById('llm-passthrough-test-transport-select');
    if (transportEl) {
      settings.llmPassthroughTestTransport =
        transportEl.value === 'direct-ipc' ? 'direct-ipc' : 'inbound-http';
    }
    await window.electronAPI.saveSettings(settings);
    window.electronAPI.notifyTraySettingsChanged();
    if (preset && preset.value === 'custom' && hostPatch != null) {
      refreshLlmTestInboundHostMruSelect(settings);
    }
  } catch (e) {
    console.error('persistLlmTestRetrievalSettingsFromInputs', e);
  }
}

/**
 * @param {{ inboundPassthrough?: object } | null | undefined} status from getMCPServerStatus()
 * @param {unknown} [inboundHostname] host for the test client URL only (listener ports unchanged)
 * @returns {{ kind: 'openai' | 'ollama', url: string } | null}
 */
function pickInboundLlmPassthroughEndpoint(status, inboundHostname) {
  const hostInUrl = formatHostnameForInboundTestUrl(inboundHostname);
  const p = status && status.inboundPassthrough;
  if (!p || p.masterEnabled !== true) return null;
  if (p.openai && p.openai.enabled === true && p.openai.listening === true && p.openai.port) {
    return { kind: 'openai', url: `http://${hostInUrl}:${p.openai.port}/v1/chat/completions` };
  }
  if (p.ollama && p.ollama.enabled === true && p.ollama.listening === true && p.ollama.port) {
    return { kind: 'ollama', url: `http://${hostInUrl}:${p.ollama.port}/api/chat` };
  }
  return null;
}

/**
 * @param {'openai' | 'ollama'} kind
 * @param {unknown} data parsed JSON from inbound (upstream-shaped body)
 */
function extractLlmTestReplyFromPassthroughJson(kind, data) {
  if (!data || typeof data !== 'object') return '';
  if (kind === 'openai') {
    const c0 = data.choices && data.choices[0];
    if (!c0) return '';
    const m = c0.message;
    if (m && typeof m.content === 'string') return m.content;
    if (typeof c0.text === 'string') return c0.text;
    return '';
  }
  if (data.message && typeof data.message.content === 'string') return data.message.content;
  return '';
}

/** @param {number} statusCode @param {unknown} data */
function inboundPassthroughErrorMessage(statusCode, data) {
  if (data && typeof data === 'object') {
    const err = data.error;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object' && typeof err.message === 'string') return err.message;
    if (typeof data.message === 'string') return data.message;
  }
  return `HTTP ${statusCode}`;
}

function resetLlmPassthroughSendButtonLabel(sendBtn) {
  if (sendBtn) sendBtn.textContent = LLM_PASSTHROUGH_SEND_DEFAULT_LABEL;
}

function setLlmPassthroughSendButtonToCancel(sendBtn) {
  if (!sendBtn) return;
  sendBtn.textContent = 'Cancel';
  sendBtn.disabled = false;
}

function runLlmPassthroughSendCancel() {
  const fn = llmPassthroughSendCancelFn;
  llmPassthroughSendCancelFn = null;
  if (typeof fn === 'function') fn();
}

function beginLlmPassthroughSendCancellable(sendBtn, cancelFn) {
  llmPassthroughSendInFlight = true;
  llmPassthroughSendUserCancelled = false;
  llmPassthroughSendCancelFn = cancelFn;
  setLlmPassthroughSendButtonToCancel(sendBtn);
}

function endLlmPassthroughSendUi(sendBtn) {
  if (!llmPassthroughSendInFlight) return;
  llmPassthroughSendInFlight = false;
  llmPassthroughSendCancelFn = null;
  resetLlmPassthroughSendButtonLabel(sendBtn);
}

/** @param {Record<string, unknown>} [overrides] Merged on top of getSettings() for live Server-tab edits. */
async function refreshLlmPassthroughPanel(overrides) {
  const hint = document.getElementById('llm-passthrough-config-hint');
  const sendBtn = document.getElementById('llm-passthrough-send-btn');
  if (!hint || !sendBtn) return;
  if (llmPassthroughSendInFlight) return;
  try {
    const settings = await window.electronAPI.getSettings();
    const s =
      overrides && typeof overrides === 'object' ? { ...settings, ...overrides } : settings;
    const on = s.llmPassthroughEnabled === true;
    const useOpenAi = s.llmPassthroughProvider === 'openai';
    const base = String(
      useOpenAi
        ? s.llmPassthroughOpenAiBaseUrl || s.llmPassthroughBaseUrl || ''
        : s.llmPassthroughOllamaBaseUrl || s.llmPassthroughBaseUrl || ''
    ).trim();
    const model = String(
      useOpenAi
        ? s.llmPassthroughOpenAiModel || s.llmPassthroughModel || ''
        : s.llmPassthroughOllamaModel || s.llmPassthroughModel || ''
    ).trim();
    const prov = useOpenAi ? 'OpenAI-compatible' : 'Ollama';
    if (!on) {
      hint.textContent =
        'LLM Passthrough is off. Enable it under Settings → Server (LLM upstream), and set base URL and model there.';
      sendBtn.disabled = true;
      return;
    }
    if (!base || !model) {
      hint.textContent =
        'LLM Passthrough is enabled but base URL or model is missing for the selected API style. Complete those fields under Settings → Server.';
      sendBtn.disabled = true;
      return;
    }
    const transportSelect = document.getElementById('llm-passthrough-test-transport-select');
    let transport = s.llmPassthroughTestTransport === 'direct-ipc' ? 'direct-ipc' : 'inbound-http';
    if (transportSelect) {
      transport = transportSelect.value === 'direct-ipc' ? 'direct-ipc' : 'inbound-http';
    }
    if (transport === 'direct-ipc') {
      hint.textContent = `Ready: upstream ${prov} at ${base}, model "${model}". Test transport is Direct IPC — same retrieval and proxy as inbound HTTP, without a loopback POST. Active namespace is applied when set.`;
      sendBtn.disabled = false;
      return;
    }
    let mcpStatus = null;
    try {
      mcpStatus = await window.electronAPI.getMCPServerStatus();
    } catch {
      mcpStatus = null;
    }
    const inboundHost = String(s.llmPassthroughTestInboundHostname || '127.0.0.1').trim() || '127.0.0.1';
    const inbound = pickInboundLlmPassthroughEndpoint(mcpStatus, inboundHost);
    if (!inbound) {
      hint.textContent = `Upstream: ${prov} at ${base}, model "${model}". Inbound HTTP test: enable at least one listener under Settings → Server until status shows listening — or switch Test transport to Direct IPC to skip HTTP.`;
      sendBtn.disabled = true;
      return;
    }
    const inboundLabel =
      inbound.kind === 'openai'
        ? `OpenAI-compatible POST ${inbound.url}`
        : `Ollama-style POST ${inbound.url}`;
    hint.textContent = `Ready: upstream ${prov} at ${base}, model "${model}". End-to-end test: ${inboundLabel} (host from “Inbound test target”; external clients may use 127.0.0.1 or another host). Active namespace is sent as X-Froggy-Namespace when set.`;
    sendBtn.disabled = false;
  } catch (e) {
    hint.textContent = 'Could not load settings for LLM Passthrough.';
    sendBtn.disabled = true;
  }
}

/**
 * Read every Settings modal field into `settings` (mutates). Same validation as the old per-tab saves.
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
function applyAllSettingsModalFieldsToSettings(settings) {
  const chunkSizeInput = document.getElementById('settings-chunk-size-input');
  const chunkOverlapInput = document.getElementById('settings-chunk-overlap-input');
  const minChunkCharsInput = document.getElementById('settings-min-chunk-chars-input');
  const minChunkTokensInput = document.getElementById('settings-min-chunk-tokens-input');
  const maxChunksInput = document.getElementById('settings-max-chunks-input');
  const embeddingModelInput = document.getElementById('settings-embedding-model-input');
  const normalizeEmbeddingsInput = document.getElementById('settings-normalize-embeddings-input');
  if (!chunkSizeInput || !chunkOverlapInput) {
    return { ok: false, message: 'Settings form is missing chunking fields.' };
  }
  const chunkSize = parseInt(chunkSizeInput.value, 10) || 1000;
  const chunkOverlap = parseInt(chunkOverlapInput.value, 10) || 200;
  const minChunkChars = parseInt(minChunkCharsInput?.value, 10) || 0;
  const minChunkTokens = parseInt(minChunkTokensInput?.value, 10) || 0;
  const maxChunks = parseInt(maxChunksInput?.value, 10) || 0;
  const embeddingModel = embeddingModelInput?.value || 'Xenova/all-MiniLM-L6-v2';
  const normalizeEmbeddings = normalizeEmbeddingsInput?.checked !== false;
  if (chunkSize < 100 || chunkSize > 10000) {
    return { ok: false, message: 'Chunk size must be between 100 and 10000 characters' };
  }
  if (chunkOverlap < 0 || chunkOverlap > 5000) {
    return { ok: false, message: 'Overlap must be between 0 and 5000 characters' };
  }
  if (chunkOverlap >= chunkSize) {
    return { ok: false, message: 'Overlap must be less than chunk size' };
  }
  if (minChunkChars < 0 || minChunkChars > 500) {
    return { ok: false, message: 'Min chunk chars must be between 0 and 500' };
  }
  if (minChunkTokens < 0 || minChunkTokens > 200) {
    return { ok: false, message: 'Min chunk tokens must be between 0 and 200' };
  }
  if (maxChunks < 0 || maxChunks > 10000) {
    return { ok: false, message: 'Max chunks per document must be between 0 and 10000' };
  }
  settings.chunkSize = chunkSize;
  settings.chunkOverlap = chunkOverlap;
  settings.minChunkChars = minChunkChars;
  settings.minChunkTokens = minChunkTokens;
  settings.maxChunksPerDocument = maxChunks;
  settings.embeddingModel = embeddingModel;
  settings.normalizeEmbeddings = normalizeEmbeddings;

  const intelligentChunkingInput = document.getElementById('settings-intelligent-chunking-input');
  const hierarchicalChunkingInput = document.getElementById('settings-hierarchical-chunking-input');
  const hierarchicalPartsInput = document.getElementById('settings-hierarchical-coarse-window-input');
  const wholeDocRatioInput = document.getElementById('settings-chunking-whole-doc-ratio-input');
  const chunkingLlmEnabledInput = document.getElementById('settings-chunking-llm-enabled-input');
  const chunkingLlmBaseUrlInput = document.getElementById('settings-chunking-llm-base-url-input');
  const chunkingLlmModelInput = document.getElementById('settings-chunking-llm-model-input');
  const chunkingLlmApiKeyInput = document.getElementById('settings-chunking-llm-api-key-input');
  const chunkingLlmTimeoutInput = document.getElementById('settings-chunking-llm-timeout-input');
  const chunkingLlmParagraphSeamsInput = document.getElementById('settings-chunking-llm-paragraph-seams-input');
  if (
    !intelligentChunkingInput ||
    !hierarchicalChunkingInput ||
    !hierarchicalPartsInput ||
    !wholeDocRatioInput ||
    !chunkingLlmEnabledInput ||
    !chunkingLlmBaseUrlInput ||
    !chunkingLlmModelInput ||
    !chunkingLlmTimeoutInput ||
    !chunkingLlmParagraphSeamsInput
  ) {
    return { ok: false, message: 'Settings form is missing smart chunking / LLM fields.' };
  }
  const hierarchicalCoarseWindowParts = parseInt(hierarchicalPartsInput.value, 10) || 3;
  const chunkingWholeDocMaxRatio = parseFloat(wholeDocRatioInput.value) || 1.15;
  const chunkingLlmTimeoutMs = parseInt(chunkingLlmTimeoutInput.value, 10) || 45000;
  if (hierarchicalCoarseWindowParts < 2 || hierarchicalCoarseWindowParts > 20) {
    return { ok: false, message: 'Coarse window must be between 2 and 20' };
  }
  if (chunkingWholeDocMaxRatio < 1 || chunkingWholeDocMaxRatio > 2.5) {
    return { ok: false, message: 'Whole-doc ratio must be between 1 and 2.5' };
  }
  if (chunkingLlmTimeoutMs < 5000 || chunkingLlmTimeoutMs > 600000) {
    return { ok: false, message: 'Chunking LLM timeout must be between 5000 and 600000 ms' };
  }
  settings.intelligentChunking = intelligentChunkingInput.checked;
  settings.hierarchicalChunking = hierarchicalChunkingInput.checked;
  settings.hierarchicalCoarseWindowParts = hierarchicalCoarseWindowParts;
  settings.chunkingWholeDocMaxRatio = chunkingWholeDocMaxRatio;
  settings.chunkingLlmEnabled = chunkingLlmEnabledInput.checked;
  settings.chunkingLlmBaseUrl = String(chunkingLlmBaseUrlInput.value || '').trim();
  settings.chunkingLlmModel = String(chunkingLlmModelInput.value || '').trim();
  const newApiKey = chunkingLlmApiKeyInput ? String(chunkingLlmApiKeyInput.value || '').trim() : '';
  if (newApiKey !== '') {
    settings.chunkingLlmApiKey = newApiKey;
  }
  settings.chunkingLlmTimeoutMs = chunkingLlmTimeoutMs;
  settings.chunkingLlmParagraphSeams = chunkingLlmParagraphSeamsInput.checked;

  const topKInput = document.getElementById('settings-top-k-input');
  const scoreThresholdInput = document.getElementById('settings-score-threshold-input');
  const maxChunksPerDocInput = document.getElementById('settings-max-chunks-per-doc-input');
  const groupByDocInput = document.getElementById('settings-group-by-doc-input');
  const returnFullDocsInput = document.getElementById('settings-return-full-docs-input');
  const maxContextTokensInput = document.getElementById('settings-max-context-tokens-input');
  if (!topKInput || !scoreThresholdInput) {
    return { ok: false, message: 'Settings form is missing retrieval fields.' };
  }
  const topK = parseInt(topKInput.value, 10) || 10;
  const scoreThreshold = parseFloat(scoreThresholdInput.value) || 0;
  const maxChunksPerDoc = parseInt(maxChunksPerDocInput?.value, 10) || 0;
  const groupByDoc = groupByDocInput?.checked || false;
  const returnFullDocs = returnFullDocsInput?.checked || false;
  const maxContextTokens = parseInt(maxContextTokensInput?.value, 10) || 0;
  if (topK < 1 || topK > 100) {
    return { ok: false, message: 'Top K must be between 1 and 100' };
  }
  if (scoreThreshold < 0 || scoreThreshold > 1) {
    return { ok: false, message: 'Score threshold must be between 0 and 1' };
  }
  if (maxChunksPerDoc < 0 || maxChunksPerDoc > 100) {
    return { ok: false, message: 'Max chunks per document must be between 0 and 100' };
  }
  if (maxContextTokens < 0 || maxContextTokens > 100000) {
    return { ok: false, message: 'Max context tokens must be between 0 and 100000' };
  }
  settings.retrievalTopK = topK;
  settings.retrievalScoreThreshold = scoreThreshold;
  settings.retrievalMaxChunksPerDoc = maxChunksPerDoc;
  settings.retrievalGroupByDoc = groupByDoc;
  settings.retrievalReturnFullDocs = returnFullDocs;
  settings.retrievalMaxContextTokens = maxContextTokens;

  const dedupeChunkGroupsInput = document.getElementById('settings-retrieval-dedupe-chunk-groups-input');
  if (!dedupeChunkGroupsInput) {
    return { ok: false, message: 'Settings form is missing hierarchical dedupe field.' };
  }
  settings.retrievalDedupeChunkGroups = dedupeChunkGroupsInput.checked;

  const sinceDaysInput = document.getElementById('settings-since-days-input');
  const timeDecayEnabledInput = document.getElementById('settings-time-decay-enabled-input');
  const timeDecayHalfLifeInput = document.getElementById('settings-time-decay-half-life-input');
  if (!sinceDaysInput || !timeDecayEnabledInput || !timeDecayHalfLifeInput) {
    return { ok: false, message: 'Settings form is missing metadata / filtering fields.' };
  }
  const sinceDays = parseInt(sinceDaysInput.value, 10) || 0;
  const timeDecayEnabled = timeDecayEnabledInput.checked || false;
  const timeDecayHalfLifeDays = parseInt(timeDecayHalfLifeInput.value, 10) || 30;
  if (sinceDays < 0 || sinceDays > 3650) {
    return { ok: false, message: 'Since days must be between 0 and 3650' };
  }
  if (timeDecayHalfLifeDays < 1 || timeDecayHalfLifeDays > 3650) {
    return { ok: false, message: 'Time decay half life days must be between 1 and 3650' };
  }
  settings.metadataSinceDays = sinceDays;
  settings.metadataTimeDecayEnabled = timeDecayEnabled;
  settings.metadataTimeDecayHalfLifeDays = timeDecayHalfLifeDays;

  const minimizeInput = document.getElementById('settings-minimize-to-tray-input');
  if (minimizeInput) {
    settings.minimizeToTray = minimizeInput.checked;
  }

  const serverPortInput = document.getElementById('settings-server-port-input');
  const autoStartServerInput = document.getElementById('settings-auto-start-server-input');
  if (!serverPortInput || !autoStartServerInput) {
    return { ok: false, message: 'Settings form is missing server fields.' };
  }
  const serverPort = parseInt(serverPortInput.value, 10) || 3000;
  const autoStartServer = autoStartServerInput.checked || false;
  if (serverPort < 1024 || serverPort > 65535) {
    return { ok: false, message: 'Port must be between 1024 and 65535' };
  }
  settings.serverPort = serverPort;
  settings.autoStartServer = autoStartServer;

  const llmEnabledInput = document.getElementById('settings-llm-passthrough-enabled-input');
  const llmProviderSelect = document.getElementById('settings-llm-passthrough-provider-select');
  const llmBaseUrlInput = document.getElementById('settings-llm-passthrough-base-url-input');
  const llmModelInput = document.getElementById('settings-llm-passthrough-model-input');
  const llmTimeoutInput = document.getElementById('llm-passthrough-timeout-input');
  const llmAlgoSelect = document.getElementById('llm-passthrough-search-algorithm-select');
  if (!llmEnabledInput || !llmProviderSelect || !llmBaseUrlInput || !llmModelInput) {
    return { ok: false, message: 'Settings form is missing LLM Passthrough fields.' };
  }
  if (!llmTimeoutInput || !llmAlgoSelect) {
    return { ok: false, message: 'LLM test panel is missing retrieval or timeout fields.' };
  }
  const llmEnabled = llmEnabledInput.checked === true;
  const llmProvider = llmProviderSelect.value === 'openai' ? 'openai' : 'ollama';
  flushLlmPassthroughDraftFromInputs(llmProvider);

  const d = llmPassthroughEndpointDraft;
  const ollamaBase = d.ollama.baseUrl || 'http://127.0.0.1:11434';
  const openAiBase = String(d.openai.baseUrl || '').trim();
  const ollamaModel = d.ollama.model.trim();
  const openAiModel = d.openai.model.trim();

  const llmTimeoutSecRaw = parseInt(llmTimeoutInput.value, 10);
  const llmTimeoutSec = Number.isFinite(llmTimeoutSecRaw) ? llmTimeoutSecRaw : 120;
  const llmTimeoutMs = llmTimeoutSec * 1000;
  const llmAlgo = llmAlgoSelect.value || 'hybrid';
  if (!['hybrid', 'bm25', 'tfidf', 'vector'].includes(llmAlgo)) {
    return { ok: false, message: 'Invalid LLM Passthrough search algorithm.' };
  }
  if (llmTimeoutSec < 5 || llmTimeoutSec > 600) {
    return { ok: false, message: 'LLM Passthrough timeout must be between 5 and 600 seconds.' };
  }
  const llmInboundPreset = document.getElementById('llm-passthrough-test-inbound-host-preset-select');
  const llmInboundCustom = document.getElementById('llm-passthrough-test-inbound-host-custom-input');
  const llmInboundMru = document.getElementById('llm-passthrough-test-inbound-host-mru-select');
  if (llmInboundPreset) {
    let inboundTestHost = '';
    if (llmInboundPreset.value === '127.0.0.1') inboundTestHost = '127.0.0.1';
    else if (llmInboundPreset.value === 'localhost') inboundTestHost = 'localhost';
    else {
      if (
        llmInboundMru &&
        llmInboundMru.value &&
        llmInboundMru.value !== LLM_INBOUND_TEST_HOST_MRU_NEW
      ) {
        inboundTestHost = normalizeLlmPassthroughTestInboundHostname(llmInboundMru.value);
      } else {
        inboundTestHost = normalizeLlmPassthroughTestInboundHostname(
          llmInboundCustom ? llmInboundCustom.value : ''
        );
      }
      if (!inboundTestHost) {
        return {
          ok: false,
          message:
            'Inbound test target: choose loopback or localhost, or pick a recent custom host / enter a valid hostname or IP (no URL path).'
        };
      }
    }
    settings.llmPassthroughTestInboundHostname = inboundTestHost;
    if (llmInboundPreset.value === 'custom') {
      recordLlmPassthroughTestInboundHostMru(settings, inboundTestHost);
    }
  }
  if (llmEnabled) {
    const activeBase = llmProvider === 'openai' ? openAiBase : ollamaBase;
    const activeModel = llmProvider === 'openai' ? openAiModel : ollamaModel;
    if (!activeBase) {
      return { ok: false, message: 'LLM Passthrough base URL is required when passthrough is enabled.' };
    }
    const lower = activeBase.toLowerCase();
    if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
      return { ok: false, message: 'LLM Passthrough base URL must start with http:// or https://.' };
    }
    if (!activeModel) {
      return { ok: false, message: 'LLM Passthrough model is required when passthrough is enabled.' };
    }
  }
  settings.llmPassthroughEnabled = llmEnabled;
  settings.llmPassthroughProvider = llmProvider;
  settings.llmPassthroughOllamaBaseUrl = ollamaBase;
  settings.llmPassthroughOllamaModel = d.ollama.model;
  settings.llmPassthroughOllamaApiKey = d.ollama.apiKey;
  settings.llmPassthroughOpenAiBaseUrl = d.openai.baseUrl;
  settings.llmPassthroughOpenAiModel = d.openai.model;
  settings.llmPassthroughOpenAiApiKey = d.openai.apiKey;
  const activeBaseForLegacy = llmProvider === 'openai' ? openAiBase : ollamaBase;
  const activeModelForLegacy = llmProvider === 'openai' ? openAiModel : ollamaModel;
  const activeKeyForLegacy =
    llmProvider === 'openai' ? d.openai.apiKey : d.ollama.apiKey;
  settings.llmPassthroughBaseUrl = activeBaseForLegacy;
  settings.llmPassthroughModel = activeModelForLegacy;
  settings.llmPassthroughApiKey = activeKeyForLegacy;
  settings.llmPassthroughTimeoutMs = llmTimeoutMs;
  settings.llmPassthroughSearchAlgorithm = llmAlgo;

  const webSearchSettingsResult = applyWebSearchSettingsFieldsToSettings(settings);
  if (!webSearchSettingsResult.ok) {
    return webSearchSettingsResult;
  }

  const llmTransportSelect = document.getElementById('llm-passthrough-test-transport-select');
  if (llmTransportSelect) {
    settings.llmPassthroughTestTransport =
      llmTransportSelect.value === 'direct-ipc' ? 'direct-ipc' : 'inbound-http';
  }

  const ptOllamaEn = document.getElementById('settings-passthrough-ollama-listen-enabled-input');
  const ptOllamaPort = document.getElementById('settings-passthrough-ollama-listen-port-input');
  const ptOpenAiEn = document.getElementById('settings-passthrough-openai-listen-enabled-input');
  const ptOpenAiPort = document.getElementById('settings-passthrough-openai-listen-port-input');
  if (!ptOllamaEn || !ptOllamaPort || !ptOpenAiEn || !ptOpenAiPort) {
    return { ok: false, message: 'Settings form is missing inbound passthrough fields (Server tab).' };
  }
  const passthroughOllamaListenEnabled = ptOllamaEn.checked === true;
  const passthroughOpenAiListenEnabled = ptOpenAiEn.checked === true;
  const ollamaListenPort = parseInt(ptOllamaPort.value, 10) || 0;
  const openAiListenPort = parseInt(ptOpenAiPort.value, 10) || 0;

  if (llmEnabled) {
    if (!passthroughOllamaListenEnabled && !passthroughOpenAiListenEnabled) {
      return {
        ok: false,
        message:
          'When LLM Passthrough is enabled, turn on at least one inbound listener (Ollama-style or OpenAI-compatible) under Inbound HTTP passthrough.'
      };
    }
    if (passthroughOllamaListenEnabled) {
      if (ollamaListenPort < 1024 || ollamaListenPort > 65535) {
        return { ok: false, message: 'Ollama inbound port must be between 1024 and 65535.' };
      }
      if (ollamaListenPort === serverPort) {
        return { ok: false, message: 'Ollama inbound port cannot match the MCP server port.' };
      }
    }
    if (passthroughOpenAiListenEnabled) {
      if (openAiListenPort < 1024 || openAiListenPort > 65535) {
        return { ok: false, message: 'OpenAI inbound port must be between 1024 and 65535.' };
      }
      if (openAiListenPort === serverPort) {
        return { ok: false, message: 'OpenAI inbound port cannot match the MCP server port.' };
      }
    }
    if (
      passthroughOllamaListenEnabled &&
      passthroughOpenAiListenEnabled &&
      ollamaListenPort === openAiListenPort
    ) {
      return { ok: false, message: 'Ollama and OpenAI inbound ports must be different.' };
    }
  }
  settings.passthroughListenEnabled = llmEnabled;
  settings.passthroughOllamaListenEnabled = passthroughOllamaListenEnabled;
  settings.passthroughOllamaListenPort = ollamaListenPort;
  settings.passthroughOpenAiListenEnabled = passthroughOpenAiListenEnabled;
  settings.passthroughOpenAiListenPort = openAiListenPort;

  return { ok: true };
}

async function persistSettingsModal() {
  try {
    const settings = await window.electronAPI.getSettings();
    const prevPassthroughEnabled = settings.llmPassthroughEnabled === true;
    const r = applyAllSettingsModalFieldsToSettings(settings);
    if (!r.ok) {
      alert(r.message);
      return false;
    }
    const nextPassthroughEnabled = settings.llmPassthroughEnabled === true;
    settings.__allowWebSearchSettingsSave = true;
    await window.electronAPI.saveSettings(settings);
    window.electronAPI.notifyTraySettingsChanged();

    if (prevPassthroughEnabled !== nextPassthroughEnabled) {
      try {
        const status = await window.electronAPI.getMCPServerStatus();
        if (nextPassthroughEnabled) {
          if (!status.running) {
            const port = settings.serverPort || 3000;
            await window.electronAPI.startMCPServer(port);
          }
        } else if (status.running) {
          await window.electronAPI.stopMCPServer();
        }
      } catch (e) {
        console.error('MCP server start/stop after LLM Passthrough toggle', e);
        alert(e.message || String(e));
      }
    }

    await refreshServerStatus();
    void refreshLlmPassthroughPanel();
    return true;
  } catch (e) {
    console.error('persistSettingsModal', e);
    alert(`Could not save settings: ${e.message}`);
    return false;
  }
}

async function loadGeneralSettings() {
  const settings = await window.electronAPI.getSettings();
  const input = document.getElementById('settings-minimize-to-tray-input');
  if (input) {
    input.checked = settings.minimizeToTray || false;
  }
}

async function checkAndAutoStartServer() {
  const settings = await window.electronAPI.getSettings();
  if (settings.autoStartServer) {
    const status = await window.electronAPI.getMCPServerStatus();
    if (!status.running) {
      const port = settings.serverPort || 3000;
      try {
        await window.electronAPI.startMCPServer(port);
        await refreshServerStatus();
      } catch (error) {
        console.error('Error auto-starting server:', error);
        // Don't show alert on auto-start failure, just log it
      }
    }
  }
}

async function loadSettings() {
  const settings = await window.electronAPI.getSettings();
  if (settings.splitterPosition) {
    splitterPosition = settings.splitterPosition;
    document.getElementById('treePanel').style.width = `${splitterPosition}px`;
  }
  if (settings.searchSplitterPosition) {
    searchSplitterPosition = settings.searchSplitterPosition;
  }
  if (settings.chunkDetailSplitterPosition) {
    chunkDetailSplitterPosition = settings.chunkDetailSplitterPosition;
  }
  if (settings.vectorStoreSplitterPosition) {
    vectorStoreSplitterPosition = settings.vectorStoreSplitterPosition;
  }
  if (settings.mruSearches) {
    mruSearches = settings.mruSearches;
    updateMRUList();
  }
}

async function loadChunkingSettings() {
  const settings = await window.electronAPI.getSettings();
  
  // Load chunk size (default to 1000 if old value exists, otherwise 512)
  const chunkSizeInput = document.getElementById('settings-chunk-size-input');
  if (chunkSizeInput) {
    chunkSizeInput.value = settings.chunkSize || (settings.chunkSize === undefined ? 512 : 1000);
  }
  
  // Load chunk overlap (default to 200 if old value exists, otherwise 64)
  const chunkOverlapInput = document.getElementById('settings-chunk-overlap-input');
  if (chunkOverlapInput) {
    chunkOverlapInput.value = settings.chunkOverlap || (settings.chunkOverlap === undefined ? 64 : 200);
  }
  
  // Load min chunk chars
  const minChunkCharsInput = document.getElementById('settings-min-chunk-chars-input');
  if (minChunkCharsInput) {
    minChunkCharsInput.value = settings.minChunkChars || 50;
  }
  
  // Load min chunk tokens
  const minChunkTokensInput = document.getElementById('settings-min-chunk-tokens-input');
  if (minChunkTokensInput) {
    minChunkTokensInput.value = settings.minChunkTokens || 10;
  }
  
  // Load max chunks per document
  const maxChunksInput = document.getElementById('settings-max-chunks-input');
  if (maxChunksInput) {
    maxChunksInput.value = settings.maxChunksPerDocument || 0;
  }
  
  // Load embedding model
  const embeddingModelInput = document.getElementById('settings-embedding-model-input');
  if (embeddingModelInput) {
    embeddingModelInput.value = settings.embeddingModel || 'Xenova/all-MiniLM-L6-v2';
  }
  
  // Load normalize embeddings
  const normalizeEmbeddingsInput = document.getElementById('settings-normalize-embeddings-input');
  if (normalizeEmbeddingsInput) {
    normalizeEmbeddingsInput.checked = settings.normalizeEmbeddings !== false; // Default to true
  }

  const intelligentChunkingInput = document.getElementById('settings-intelligent-chunking-input');
  if (intelligentChunkingInput) {
    intelligentChunkingInput.checked = settings.intelligentChunking !== false;
  }
  const hierarchicalChunkingInput = document.getElementById('settings-hierarchical-chunking-input');
  if (hierarchicalChunkingInput) {
    hierarchicalChunkingInput.checked = settings.hierarchicalChunking !== false;
  }
  const hierarchicalPartsInput = document.getElementById('settings-hierarchical-coarse-window-input');
  if (hierarchicalPartsInput) {
    hierarchicalPartsInput.value =
      settings.hierarchicalCoarseWindowParts != null ? settings.hierarchicalCoarseWindowParts : 3;
  }
  const wholeDocRatioInput = document.getElementById('settings-chunking-whole-doc-ratio-input');
  if (wholeDocRatioInput) {
    wholeDocRatioInput.value =
      settings.chunkingWholeDocMaxRatio != null ? settings.chunkingWholeDocMaxRatio : 1.15;
  }
  const chunkingLlmEnabledInput = document.getElementById('settings-chunking-llm-enabled-input');
  if (chunkingLlmEnabledInput) {
    chunkingLlmEnabledInput.checked = settings.chunkingLlmEnabled === true;
  }
  const chunkingLlmBaseUrlInput = document.getElementById('settings-chunking-llm-base-url-input');
  if (chunkingLlmBaseUrlInput) {
    chunkingLlmBaseUrlInput.value = settings.chunkingLlmBaseUrl || '';
  }
  const chunkingLlmModelInput = document.getElementById('settings-chunking-llm-model-input');
  if (chunkingLlmModelInput) {
    chunkingLlmModelInput.value = settings.chunkingLlmModel || '';
  }
  const chunkingLlmApiKeyInput = document.getElementById('settings-chunking-llm-api-key-input');
  if (chunkingLlmApiKeyInput) {
    chunkingLlmApiKeyInput.value = '';
  }
  const chunkingLlmTimeoutInput = document.getElementById('settings-chunking-llm-timeout-input');
  if (chunkingLlmTimeoutInput) {
    chunkingLlmTimeoutInput.value =
      settings.chunkingLlmTimeoutMs != null ? settings.chunkingLlmTimeoutMs : 45000;
  }
  const chunkingLlmParagraphSeamsInput = document.getElementById('settings-chunking-llm-paragraph-seams-input');
  if (chunkingLlmParagraphSeamsInput) {
    chunkingLlmParagraphSeamsInput.checked = settings.chunkingLlmParagraphSeams === true;
  }
}

async function loadRetrievalSettings() {
  const settings = await window.electronAPI.getSettings();
  
  // Load top K
  const topKInput = document.getElementById('settings-top-k-input');
  if (topKInput) {
    topKInput.value = settings.retrievalTopK || 10;
  }
  
  // Load score threshold
  const scoreThresholdInput = document.getElementById('settings-score-threshold-input');
  if (scoreThresholdInput) {
    scoreThresholdInput.value = settings.retrievalScoreThreshold || 0;
  }
  
  // Load max chunks per document (retrieval)
  const maxChunksPerDocInput = document.getElementById('settings-max-chunks-per-doc-input');
  if (maxChunksPerDocInput) {
    maxChunksPerDocInput.value = settings.retrievalMaxChunksPerDoc || 0;
  }
  
  // Load group by document
  const groupByDocInput = document.getElementById('settings-group-by-doc-input');
  if (groupByDocInput) {
    groupByDocInput.checked = settings.retrievalGroupByDoc || false;
  }
  
  // Load return full documents
  const returnFullDocsInput = document.getElementById('settings-return-full-docs-input');
  if (returnFullDocsInput) {
    returnFullDocsInput.checked = settings.retrievalReturnFullDocs || false;
  }
  
  // Load max context tokens
  const maxContextTokensInput = document.getElementById('settings-max-context-tokens-input');
  if (maxContextTokensInput) {
    maxContextTokensInput.value = settings.retrievalMaxContextTokens || 0;
  }

  const dedupeChunkGroupsInput = document.getElementById('settings-retrieval-dedupe-chunk-groups-input');
  if (dedupeChunkGroupsInput) {
    dedupeChunkGroupsInput.checked = settings.retrievalDedupeChunkGroups !== false;
  }
}

async function loadMetadataFilteringSettings() {
  const settings = await window.electronAPI.getSettings();
  
  // Load since days
  const sinceDaysInput = document.getElementById('settings-since-days-input');
  if (sinceDaysInput) {
    sinceDaysInput.value = settings.metadataSinceDays || 0;
  }
  
  // Load time decay enabled
  const timeDecayEnabledInput = document.getElementById('settings-time-decay-enabled-input');
  if (timeDecayEnabledInput) {
    timeDecayEnabledInput.checked = settings.metadataTimeDecayEnabled || false;
  }
  
  // Load time decay half life
  const timeDecayHalfLifeInput = document.getElementById('settings-time-decay-half-life-input');
  if (timeDecayHalfLifeInput) {
    timeDecayHalfLifeInput.value = settings.metadataTimeDecayHalfLifeDays || 30;
  }
}

async function regenerateVectorStore() {
  const btn = document.getElementById('regenerate-vector-store-btn');
  if (!btn) return;
  
  // Confirm action
  const confirmed = confirm('This will clear the entire vector store and re-index all files from your current files/directories settings. This action cannot be undone. Continue?');
  if (!confirmed) {
    return;
  }
  
  try {
    // Disable button during operation
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Regenerating...';
    
    // Call the regenerate function
    const result = await window.electronAPI.regenerateVectorStore();
    
    // Show success message
    btn.textContent = `✓ Queued ${result.queued} files`;
    btn.style.background = '#4caf50';
    
    // Refresh the vector store view
    await refreshVectorStore();
    
    // Reset button after a delay
    setTimeout(() => {
      btn.textContent = originalText;
      btn.style.background = '';
      btn.disabled = false;
    }, 3000);
  } catch (error) {
    console.error('Error regenerating vector store:', error);
    alert(`Error regenerating vector store: ${error.message}`);
    
    // Reset button on error
    btn.textContent = 'Rebuild Vector Store';
    btn.style.background = '';
    btn.disabled = false;
  }
}

async function performSelfTest() {
  const selfTestBtn = document.getElementById('self-test-btn');
  if (!selfTestBtn) return;
  
  const status = await window.electronAPI.getMCPServerStatus();
  if (!status.running || !status.port) {
    alert('Server is not running');
    return;
  }
  
  const restUrl = status.restUrl || `http://localhost:${status.port}`;
  const testUrl = `${restUrl}/admin/documents`;
  
  try {
    // Disable button during test
    selfTestBtn.disabled = true;
    const originalText = selfTestBtn.textContent;
    selfTestBtn.textContent = 'Testing...';
    
    // Make REST call
    const response = await fetch(testUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Show success message with results
    const toolCount = data.documents ? data.documents.length : 0;
    alert(`Self Test Successful!\n\nRetrieved ${toolCount} document(s) from the server.\n\nEndpoint: ${testUrl}`);
    
    // Restore button
    selfTestBtn.textContent = originalText;
    selfTestBtn.disabled = false;
  } catch (error) {
    console.error('Self test error:', error);
    alert(`Self Test Failed!\n\nError: ${error.message}\n\nEndpoint: ${testUrl}`);
    
    // Restore button
    const originalText = selfTestBtn.textContent.replace('Testing...', 'Self Test');
    selfTestBtn.textContent = originalText;
    selfTestBtn.disabled = false;
  }
}

let currentTestEndpoint = null;
let currentTestBaseUrl = null;
// Store event handler for cleanup
let endpointTestOverlayClickHandler = null;
let endpointTestEscapeKeyHandler = null;

// Helper functions for persistent test payloads
async function getEndpointTestPayloads() {
  const settings = await window.electronAPI.getSettings();
  return settings.endpointTestPayloads || {};
}

async function saveEndpointTestPayload(endpointPath, payload, params) {
  const settings = await window.electronAPI.getSettings();
  if (!settings.endpointTestPayloads) {
    settings.endpointTestPayloads = {};
  }
  settings.endpointTestPayloads[endpointPath] = {
    payload: payload,
    params: params
  };
  await window.electronAPI.saveSettings(settings);
  window.electronAPI.notifyTraySettingsChanged();
}

async function getDefaultPayload(endpointPath) {
  let defaultPayload = {};
  if (endpointPath === '/admin/corpus-search') {
    defaultPayload = { query: 'test query', limit: 10, algorithm: 'hybrid' };
  } else if (endpointPath === '/admin/ingest/file') {
    defaultPayload = { filePath: '', watch: false };
  } else if (endpointPath === '/admin/ingest/directory') {
    defaultPayload = { dirPath: '', recursive: false, watch: false };
  } else if (endpointPath === '/mcp') {
    defaultPayload = {
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'froggy-ui-tester', version: '1.0.0' }
      },
      id: 1
    };
  }
  return defaultPayload;
}

async function openEndpointTestModal(endpoint, baseUrl) {
  currentTestEndpoint = endpoint;
  currentTestBaseUrl = baseUrl;
  
  const modal = document.getElementById('endpoint-test-modal');
  const titleElement = document.getElementById('test-modal-title');
  const requestView = document.getElementById('test-modal-request-view');
  const responseView = document.getElementById('test-modal-response-view');
  const methodSpan = document.getElementById('test-modal-method');
  const endpointSpan = document.getElementById('test-modal-endpoint');
  const previewSection = document.getElementById('test-modal-preview-section');
  const previewContent = document.getElementById('test-modal-preview-content');
  const paramsSection = document.getElementById('test-modal-params-section');
  const paramsInputs = document.getElementById('test-modal-params-inputs');
  const payloadSection = document.getElementById('test-modal-payload-section');
  const payloadTextarea = document.getElementById('test-modal-payload');
  const sendBtn = document.getElementById('test-endpoint-send-btn');
  const cancelBtn = document.getElementById('test-endpoint-cancel-btn');
  
  // Show request view, hide response view
  requestView.style.display = 'block';
  responseView.style.display = 'none';
  
  // Set title and buttons
  titleElement.textContent = 'Send Request';
  sendBtn.style.display = 'inline-block';
  sendBtn.textContent = 'Send';
  sendBtn.disabled = false;
  cancelBtn.textContent = 'Cancel';
  
  // Set method and endpoint
  methodSpan.textContent = endpoint.method;
  endpointSpan.textContent = endpoint.path;
  
  // Load saved payloads and params
  const savedPayloads = await getEndpointTestPayloads();
  const savedData = savedPayloads[endpoint.path] || {};
  
  // Handle parameters (URL path params)
  if (endpoint.requiresParams && endpoint.params) {
    paramsSection.style.display = 'block';
    paramsInputs.innerHTML = '';
    
    const paramsResetSection = document.getElementById('test-modal-params-reset-section');
    paramsResetSection.style.display = 'block';
    
    endpoint.params.forEach(param => {
      const inputGroup = document.createElement('div');
      inputGroup.style.marginBottom = '10px';
      
      const label = document.createElement('label');
      label.textContent = `${param.label}:`;
      label.style.display = 'block';
      label.style.marginBottom = '5px';
      label.style.fontWeight = '500';
      
      const input = document.createElement('input');
      input.type = param.type || 'text';
      input.id = `test-param-${param.name}`;
      input.style.width = '100%';
      input.style.padding = '8px';
      input.style.border = '1px solid #ccc';
      input.style.borderRadius = '4px';
      input.placeholder = param.placeholder || `Enter ${param.label.toLowerCase()}`;
      
      // Load saved parameter value if exists
      if (savedData.params && savedData.params[param.name] !== undefined) {
        input.value = savedData.params[param.name];
      }
      
      // Save on blur (when user leaves the field)
      input.addEventListener('blur', async () => {
        await saveCurrentTestPayload();
      });
      
      inputGroup.appendChild(label);
      inputGroup.appendChild(input);
      paramsInputs.appendChild(inputGroup);
    });
  } else {
    paramsSection.style.display = 'none';
    document.getElementById('test-modal-params-reset-section').style.display = 'none';
  }
  
  // Handle request payload
  if (endpoint.requiresPayload) {
    payloadSection.style.display = 'block';
    
    // Load saved payload or use default
    let payloadToUse;
    if (savedData.payload) {
      try {
        payloadToUse = typeof savedData.payload === 'string' ? JSON.parse(savedData.payload) : savedData.payload;
      } catch (e) {
        // If saved payload is invalid JSON, use default
        payloadToUse = await getDefaultPayload(endpoint.path);
      }
    } else {
      payloadToUse = await getDefaultPayload(endpoint.path);
    }
    
    payloadTextarea.value = JSON.stringify(payloadToUse, null, 2);
    
    // Save on blur (when user leaves the textarea) - avoid saving on every keystroke
    payloadTextarea.addEventListener('blur', async () => {
      // Validate JSON before saving
      const text = payloadTextarea.value.trim();
      if (text) {
        try {
          JSON.parse(text);
          await saveCurrentTestPayload();
          updateRequestPreview(); // Update preview when payload changes
        } catch (e) {
          // Don't save invalid JSON, but don't show error either
          // User can fix it and it will save on next blur
        }
      }
    });
  } else {
    payloadSection.style.display = 'none';
  }
  
  // Update request preview
  updateRequestPreview();
  
  // Add input listeners to update preview
  if (endpoint.requiresParams && endpoint.params) {
    endpoint.params.forEach(param => {
      const input = document.getElementById(`test-param-${param.name}`);
      if (input) {
        input.addEventListener('input', updateRequestPreview);
        input.addEventListener('change', updateRequestPreview);
      }
    });
  }
  if (payloadTextarea) {
    payloadTextarea.addEventListener('input', updateRequestPreview);
  }
  
  // Clean up previous event handlers
  if (endpointTestOverlayClickHandler) {
    modal.removeEventListener('click', endpointTestOverlayClickHandler);
  }
  if (endpointTestEscapeKeyHandler) {
    document.removeEventListener('keydown', endpointTestEscapeKeyHandler);
  }
  
  // Close on overlay click
  endpointTestOverlayClickHandler = (e) => {
    if (e.target === modal) {
      closeEndpointTestModal();
    }
  };
  modal.addEventListener('click', endpointTestOverlayClickHandler);
  
  // Close on Escape key
  endpointTestEscapeKeyHandler = (e) => {
    if (e.key === 'Escape') {
      closeEndpointTestModal();
    }
  };
  document.addEventListener('keydown', endpointTestEscapeKeyHandler);
  
  modal.style.display = 'flex';
}

function updateRequestPreview() {
  if (!currentTestEndpoint || !currentTestBaseUrl) return;
  
  const previewContent = document.getElementById('test-modal-preview-content');
  if (!previewContent) return;
  
  // Build URL with path parameters
  let url = currentTestBaseUrl + currentTestEndpoint.path;
  const params = {};
  
  if (currentTestEndpoint.requiresParams && currentTestEndpoint.params) {
    currentTestEndpoint.params.forEach(param => {
      const input = document.getElementById(`test-param-${param.name}`);
      if (input) {
        const value = input.value.trim();
        params[param.name] = value;
        if (value) {
          url = url.replace(`:${param.name}`, encodeURIComponent(value));
        }
      }
    });
  }
  
  let previewHTML = `<div style="margin-bottom: 8px;"><strong>URL:</strong> <span style="color: #1976d2;">${url}</span></div>`;
  
  if (currentTestEndpoint.method === 'POST' && currentTestEndpoint.requiresPayload) {
    const payloadTextarea = document.getElementById('test-modal-payload');
    if (payloadTextarea) {
      const payloadText = payloadTextarea.value.trim();
      if (payloadText) {
        try {
          const payload = JSON.parse(payloadText);
          previewHTML += `<div><strong>Body:</strong></div>`;
          previewHTML += `<pre style="margin: 4px 0 0 0; padding: 8px; background: white; border: 1px solid #e0e0e0; border-radius: 4px; overflow-x: auto; font-size: 11px;">${JSON.stringify(payload, null, 2)}</pre>`;
        } catch (e) {
          previewHTML += `<div style="color: #d32f2f; font-size: 11px; margin-top: 4px;">⚠ Invalid JSON in payload</div>`;
        }
      }
    }
  }
  
  previewContent.innerHTML = previewHTML;
}

async function saveCurrentTestPayload() {
  if (!currentTestEndpoint) return;
  
  const payloadTextarea = document.getElementById('test-modal-payload');
  const params = {};
  
  // Collect parameter values
  if (currentTestEndpoint.requiresParams && currentTestEndpoint.params) {
    currentTestEndpoint.params.forEach(param => {
      const input = document.getElementById(`test-param-${param.name}`);
      if (input) {
        params[param.name] = input.value;
      }
    });
  }
  
  // Get payload value
  let payload = null;
  if (currentTestEndpoint.requiresPayload && payloadTextarea) {
    payload = payloadTextarea.value.trim();
  }
  
  await saveEndpointTestPayload(currentTestEndpoint.path, payload, params);
}

window.resetEndpointTestPayload = async function() {
  if (!currentTestEndpoint) return;
  
  const payloadTextarea = document.getElementById('test-modal-payload');
  if (!payloadTextarea) return;
  
  const defaultPayload = await getDefaultPayload(currentTestEndpoint.path);
  payloadTextarea.value = JSON.stringify(defaultPayload, null, 2);
  
  // Save the reset
  await saveCurrentTestPayload();
};

window.resetEndpointTestParams = async function() {
  if (!currentTestEndpoint || !currentTestEndpoint.requiresParams) return;
  
  if (currentTestEndpoint.params) {
    currentTestEndpoint.params.forEach(param => {
      const input = document.getElementById(`test-param-${param.name}`);
      if (input) {
        input.value = '';
      }
    });
  }
  
  // Save the reset
  await saveCurrentTestPayload();
};

window.closeEndpointTestModal = function() {
  const modal = document.getElementById('endpoint-test-modal');
  if (modal) {
    modal.style.display = 'none';
  }
  
  // Clean up event handlers
  if (endpointTestOverlayClickHandler) {
    modal.removeEventListener('click', endpointTestOverlayClickHandler);
    endpointTestOverlayClickHandler = null;
  }
  if (endpointTestEscapeKeyHandler) {
    document.removeEventListener('keydown', endpointTestEscapeKeyHandler);
    endpointTestEscapeKeyHandler = null;
  }
  
  currentTestEndpoint = null;
  currentTestBaseUrl = null;
};

// Help Modal Functions
async function showHelpModal() {
  try {
    console.log('showHelpModal called');
    const content = await window.electronAPI.readUsageFile();
    console.log('Content loaded:', content ? `${content.length} characters` : 'null');
    
    if (!content) {
      alert('Could not load user guide. Please check if USAGE.md exists.');
      return;
    }
    
    const modal = document.getElementById('help-modal-overlay');
    const contentDiv = document.getElementById('markdown-content');
    
    if (!modal) {
      console.error('Help modal element not found');
      alert('Help modal element not found');
      return;
    }
    
    if (!contentDiv) {
      console.error('Markdown content element not found');
      alert('Markdown content element not found');
      return;
    }
    
    // Content is now HTML directly, no need to render
    console.log('Loading HTML content...');
    console.log('Content length:', content ? `${content.length} characters` : 'null');
    console.log('Content preview:', content ? content.substring(0, 200) : 'null');
    if (content) {
      contentDiv.innerHTML = content;
    } else {
      contentDiv.textContent = 'Error: Could not load user guide';
    }
    
    // Clean up previous event handlers
    if (helpModalOverlayClickHandler) {
      modal.removeEventListener('click', helpModalOverlayClickHandler);
    }
    if (helpModalEscapeKeyHandler) {
      document.removeEventListener('keydown', helpModalEscapeKeyHandler);
    }
    
    // Close on overlay click
    helpModalOverlayClickHandler = (e) => {
      if (e.target === modal) {
        closeHelpModal();
      }
    };
    modal.addEventListener('click', helpModalOverlayClickHandler);
    
    // Close on Escape key
    helpModalEscapeKeyHandler = (e) => {
      if (e.key === 'Escape') {
        closeHelpModal();
      }
    };
    document.addEventListener('keydown', helpModalEscapeKeyHandler);
    
    console.log('Showing modal...');
    modal.style.display = 'flex';
  } catch (error) {
    console.error('Error showing help modal:', error);
    alert('Error loading user guide: ' + error.message);
  }
}

let helpModalOverlayClickHandler = null;
let helpModalEscapeKeyHandler = null;

window.closeHelpModal = function() {
  const modal = document.getElementById('help-modal-overlay');
  if (modal) {
    modal.style.display = 'none';
  }
  
  // Clean up event handlers
  if (helpModalOverlayClickHandler) {
    modal.removeEventListener('click', helpModalOverlayClickHandler);
    helpModalOverlayClickHandler = null;
  }
  if (helpModalEscapeKeyHandler) {
    document.removeEventListener('keydown', helpModalEscapeKeyHandler);
    helpModalEscapeKeyHandler = null;
  }
};

// Settings Modal Functions
let settingsModalOverlayClickHandler = null;
let settingsModalEscapeKeyHandler = null;

async function showSettingsModal() {
  const modal = document.getElementById('settings-modal-overlay');
  if (!modal) {
    console.error('Settings modal element not found');
    return;
  }
  
  // Load all settings when opening modal
  await loadChunkingSettings();
  await loadRetrievalSettings();
  await loadMetadataFilteringSettings();
  await loadGeneralSettings();
  await loadServerSettings();
  await loadWebSearchSettings();
  await loadLlmTestPanelRetrievalSettings();
  await loadUpdatesSettingsPanel();

  // Clean up previous event handlers
  if (settingsModalOverlayClickHandler) {
    modal.removeEventListener('click', settingsModalOverlayClickHandler);
  }
  if (settingsModalEscapeKeyHandler) {
    document.removeEventListener('keydown', settingsModalEscapeKeyHandler);
  }
  
  // Close on overlay click
  settingsModalOverlayClickHandler = (e) => {
    if (e.target === modal) {
      void closeSettingsModal();
    }
  };
  modal.addEventListener('click', settingsModalOverlayClickHandler);
  
  // Close on Escape key
  settingsModalEscapeKeyHandler = (e) => {
    if (e.key === 'Escape') {
      void closeSettingsModal();
    }
  };
  document.addEventListener('keydown', settingsModalEscapeKeyHandler);
  
  // Show modal
  modal.style.display = 'flex';
}

window.closeSettingsModal = async function () {
  const modal = document.getElementById('settings-modal-overlay');
  if (!modal) return;
  const ok = await persistSettingsModal();
  if (!ok) return;

  modal.style.display = 'none';

  if (settingsModalOverlayClickHandler) {
    modal.removeEventListener('click', settingsModalOverlayClickHandler);
    settingsModalOverlayClickHandler = null;
  }
  if (settingsModalEscapeKeyHandler) {
    document.removeEventListener('keydown', settingsModalEscapeKeyHandler);
    settingsModalEscapeKeyHandler = null;
  }
};

function setupSettingsNavigation() {
  const pageItems = document.querySelectorAll('.settings-page-item');
  
  pageItems.forEach(item => {
    item.addEventListener('click', () => {
      const pageName = item.dataset.settingsPage;
      
      // Remove active class from all items
      pageItems.forEach(i => i.classList.remove('active'));
      
      // Add active class to clicked item
      item.classList.add('active');
      
      // Hide all pages
      document.querySelectorAll('.settings-page').forEach(page => {
        page.style.display = 'none';
      });
      
      // Show selected page
      const selectedPage = document.getElementById(`settings-page-${pageName}`);
      if (selectedPage) {
        selectedPage.style.display = 'block';
      }
    });
  });
}

// Help loads prebuilt USAGE.html. LLM replies use electronAPI.renderMarkdown() (marked in main) + sandboxed iframe.

window.sendEndpointTest = async function() {
  if (!currentTestEndpoint || !currentTestBaseUrl) return;
  
  const sendBtn = document.getElementById('test-endpoint-send-btn');
  const requestView = document.getElementById('test-modal-request-view');
  const responseView = document.getElementById('test-modal-response-view');
  const titleElement = document.getElementById('test-modal-title');
  const resultContent = document.getElementById('test-modal-result-content');
  const responseMethodSpan = document.getElementById('test-modal-response-method');
  const responseEndpointSpan = document.getElementById('test-modal-response-endpoint');
  
  try {
    // Disable button during request
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending...';
    
    // Build URL with path parameters
    let url = currentTestBaseUrl + currentTestEndpoint.path;
    if (currentTestEndpoint.requiresParams && currentTestEndpoint.params) {
      currentTestEndpoint.params.forEach(param => {
        const input = document.getElementById(`test-param-${param.name}`);
        const value = input ? input.value.trim() : '';
        if (!value) {
          throw new Error(`${param.label} is required`);
        }
        url = url.replace(`:${param.name}`, encodeURIComponent(value));
      });
    }
    
    // Prepare request options
    const options = {
      method: currentTestEndpoint.method,
      headers: {
        'Content-Type': 'application/json'
      }
    };
    
    // Add body for POST requests with payload
    if (currentTestEndpoint.requiresPayload && currentTestEndpoint.method === 'POST') {
      const payloadTextarea = document.getElementById('test-modal-payload');
      const payloadText = payloadTextarea.value.trim();
      
      if (!payloadText) {
        throw new Error('Request payload is required');
      }
      
      try {
        options.body = payloadText;
        // Validate JSON
        JSON.parse(payloadText);
      } catch (e) {
        throw new Error('Invalid JSON payload: ' + e.message);
      }
    }
    
    // Make the request
    const response = await fetch(url, options);
    
    // Parse response
    let responseData;
    const contentType = response.headers.get('content-type');
    try {
      if (contentType && contentType.includes('application/json')) {
        responseData = await response.json();
      } else {
        responseData = await response.text();
      }
    } catch (parseError) {
      responseData = await response.text();
    }
    
    // Switch to response view
    requestView.style.display = 'none';
    responseView.style.display = 'block';
    titleElement.textContent = 'Response';
    
    // Hide Send button, rename Cancel to Close
    sendBtn.style.display = 'none';
    const cancelBtn = document.getElementById('test-endpoint-cancel-btn');
    cancelBtn.textContent = 'Close';
    
    // Set response details
    responseMethodSpan.textContent = currentTestEndpoint.method;
    responseEndpointSpan.textContent = url;
    
    // Display result
    const statusColor = response.ok ? '#2e7d32' : '#d32f2f';
    const statusText = response.ok ? 'Success' : 'Error';
    resultContent.innerHTML = `<strong style="color: ${statusColor};">Status:</strong> ${response.status} ${response.statusText} (${statusText})\n\n<strong>Response:</strong>\n${typeof responseData === 'string' ? responseData : JSON.stringify(responseData, null, 2)}`;
    resultContent.scrollTop = 0;
    
    // Save payload and params after successful test
    await saveCurrentTestPayload();
    
  } catch (error) {
    console.error('Endpoint test error:', error);
    
    // Switch to response view even on error
    requestView.style.display = 'none';
    responseView.style.display = 'block';
    titleElement.textContent = 'Response';
    
    // Hide Send button, rename Cancel to Close
    sendBtn.style.display = 'none';
    const cancelBtn = document.getElementById('test-endpoint-cancel-btn');
    cancelBtn.textContent = 'Close';
    
    // Set response details
    responseMethodSpan.textContent = currentTestEndpoint.method;
    const url = currentTestBaseUrl + currentTestEndpoint.path;
    responseEndpointSpan.textContent = url;
    
    // Display error
    resultContent.innerHTML = `<strong style="color: #d32f2f;">Error:</strong>\n${error.message}`;
    resultContent.scrollTop = 0;
  }
};

