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
  await loadMetadataFilteringSettings();
  await checkAndAutoStartServer();
  const reloadedSettings = await window.electronAPI.getSettings();
  initWebSearchCheckbox(reloadedSettings);
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

async function loadUpdatesSettingsPanel() {
  if (!window.electronAPI?.getAutoUpdateEnabled) return;
  const enabled = await window.electronAPI.getAutoUpdateEnabled();
  const devNote = document.getElementById('settings-update-dev-note');
  if (devNote) devNote.style.display = enabled ? 'none' : 'block';
  const checkBtn = document.getElementById('settings-check-updates-btn');
  const restartBtn = document.getElementById('settings-update-restart-btn');
  if (checkBtn) checkBtn.disabled = !enabled;
  if (restartBtn) restartBtn.disabled = !enabled || !pendingUpdateVersion;
  const statusEl = document.getElementById('settings-update-status');
  if (statusEl && pendingUpdateVersion && enabled) {
    statusEl.textContent = `Version ${pendingUpdateVersion} is downloaded. Restart to apply.`;
  }
}

function setupAutoUpdateUi() {
  if (!window.electronAPI?.checkForUpdates || autoUpdateUiInitialized) return;
  autoUpdateUiInitialized = true;

  const statusEl = () => document.getElementById('settings-update-status');
  const notesEl = () => document.getElementById('settings-update-notes');

  window.electronAPI.onUpdateAvailable((data) => {
    pendingUpdateVersion = null;
    setUpdateRestartControlsEnabled(false);
    const s = statusEl();
    if (s) s.textContent = `Update available: v${data.version}. Downloading…`;
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
    const s = statusEl();
    if (s) s.textContent = `Version ${data.version} is ready. Restart to install.`;
    setUpdateReadyBanner(true, data.version);
  });

  window.electronAPI.onUpdateNotAvailable(() => {
    if (!pendingUpdateVersion) {
      const s = statusEl();
      if (s) s.textContent = 'You are on the latest version.';
    }
    setUpdatesDownloadProgress(false);
  });

  window.electronAPI.onUpdateError((err) => {
    const s = statusEl();
    if (s) s.textContent = typeof err === 'string' ? err : 'Update check failed.';
    setUpdatesDownloadProgress(false);
  });

  const checkBtn = document.getElementById('settings-check-updates-btn');
  if (checkBtn) {
    checkBtn.addEventListener('click', async () => {
      const enabled = await window.electronAPI.getAutoUpdateEnabled();
      if (!enabled) return;
      const s = statusEl();
      if (s) s.textContent = 'Checking for updates…';
      const n = notesEl();
      if (n) {
        n.style.display = 'none';
        n.textContent = '';
      }
      setUpdatesDownloadProgress(false);
      const r = await window.electronAPI.checkForUpdates();
      if (!r.success && s) s.textContent = r.error || 'Check failed.';
    });
  }

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

  // Initialize web search checkbox
  initWebSearchCheckbox(settings);

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

  // Load initial data
  await refreshFiles();
  await refreshDirectories();
  await refreshVectorStore();
  await refreshServerStatus();
  
  // Auto-start server if enabled
  await checkAndAutoStartServer();

  // Setup event listeners for updates
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

  // Toggle API key visibility
  const toggleApiKeyBtn = document.getElementById('toggle-api-key-visibility-btn');
  if (toggleApiKeyBtn) {
    toggleApiKeyBtn.addEventListener('click', () => {
      const apiKeyInput = document.getElementById('settings-web-search-api-key-input');
      if (apiKeyInput) {
        const isPassword = apiKeyInput.type === 'password';
        apiKeyInput.type = isPassword ? 'text' : 'password';
        toggleApiKeyBtn.textContent = isPassword ? 'Hide' : 'Show';
      }
    });
  }

  // Settings page navigation
  setupSettingsNavigation();

  setupAutoUpdateUi();

  // Regenerate vector store
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

function initWebSearchCheckbox(settings) {
  const checkbox = document.getElementById('web-search-enabled');
  const status = document.getElementById('web-search-status');
  if (!checkbox || !status) return;

  const configured = settings.webSearchEnabled && settings.webSearchApiKey && settings.webSearchCx;
  if (!configured) {
    checkbox.disabled = true;
    checkbox.checked = false;
    status.textContent = '(configure in Settings > Web Search)';
    status.style.color = '#999';
  } else {
    checkbox.disabled = false;
    checkbox.checked = true;
    status.textContent = '';
  }
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
    
    const webSearchCheckbox = document.getElementById('web-search-enabled');
    const webSearchEnabled = webSearchCheckbox ? webSearchCheckbox.checked : false;
    const searchPayload = await window.electronAPI.search(query, 10, algorithm, { webSearch: webSearchEnabled });
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
      { method: 'GET', path: '/status', description: 'Check connection status', requiresPayload: false, requiresParams: false },
      { method: 'GET', path: '/tools', description: 'List all available tools', requiresPayload: false, requiresParams: false },
      { method: 'POST', path: '/tools/search', description: 'Search the vector store', requiresPayload: true, requiresParams: false },
      { method: 'GET', path: '/tools/documents', description: 'Get all documents', requiresPayload: false, requiresParams: false },
      { method: 'GET', path: '/tools/documents/:documentId/chunks', description: 'Get chunks for a document', requiresPayload: false, requiresParams: true, params: [{ name: 'documentId', label: 'Document ID', type: 'text' }] },
      { method: 'GET', path: '/tools/chunks/:chunkId', description: 'Get chunk content by ID', requiresPayload: false, requiresParams: true, params: [{ name: 'chunkId', label: 'Chunk ID', type: 'text' }] },
      { method: 'GET', path: '/tools/stats', description: 'Get vector store statistics', requiresPayload: false, requiresParams: false },
      { method: 'POST', path: '/tools/ingest/file', description: 'Ingest a file', requiresPayload: true, requiresParams: false },
      { method: 'POST', path: '/tools/ingest/directory', description: 'Ingest a directory', requiresPayload: true, requiresParams: false },
      { method: 'POST', path: '/tools/:toolId', description: 'Invoke a specific tool w/ args', requiresPayload: true, requiresParams: true, params: [{ name: 'toolId', label: 'Tool ID', type: 'text' }] },
      { method: 'POST', path: '/mcp', description: 'MCP Protocol (JSON-RPC 2.0)', requiresPayload: true, requiresParams: false }
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
}

async function loadServerSettings() {
  const settings = await window.electronAPI.getSettings();
  
  // Load server port
  const serverPortInput = document.getElementById('settings-server-port-input');
  if (serverPortInput) {
    serverPortInput.value = settings.serverPort || 3000;
  }
  
  // Load auto-start server
  const autoStartServerInput = document.getElementById('settings-auto-start-server-input');
  if (autoStartServerInput) {
    autoStartServerInput.checked = settings.autoStartServer || false;
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

  const enabledInput = document.getElementById('settings-web-search-enabled-input');
  const apiKeyInput = document.getElementById('settings-web-search-api-key-input');
  const cxInput = document.getElementById('settings-web-search-cx-input');
  const maxResultsInput = document.getElementById('settings-web-search-max-results-input');
  const timeoutSecondsInput = document.getElementById('settings-web-search-timeout-seconds-input');
  const safeSearchInput = document.getElementById('settings-web-search-safe-search-input');
  const fetchPagesInput = document.getElementById('settings-web-search-fetch-pages-input');
  const fetchMaxMbInput = document.getElementById('settings-web-search-fetch-max-mb-input');
  const pageTimeoutSecondsInput = document.getElementById('settings-web-search-page-timeout-seconds-input');
  if (
    !enabledInput ||
    !apiKeyInput ||
    !cxInput ||
    !maxResultsInput ||
    !timeoutSecondsInput ||
    !safeSearchInput ||
    !fetchPagesInput ||
    !fetchMaxMbInput ||
    !pageTimeoutSecondsInput
  ) {
    return { ok: false, message: 'Settings form is missing web search fields.' };
  }
  const webEnabled = enabledInput.checked || false;
  const apiKey = apiKeyInput.value?.trim() || '';
  const cx = cxInput.value?.trim() || '';
  const maxResults = parseInt(maxResultsInput.value, 10) || 5;
  const timeoutSeconds = parseInt(timeoutSecondsInput.value, 10);
  const safeSearch = safeSearchInput.value || 'off';
  if (webEnabled && !apiKey) {
    return { ok: false, message: 'API Key is required when Web Search is enabled.' };
  }
  if (webEnabled && !cx) {
    return { ok: false, message: 'Search Engine ID (CX) is required when Web Search is enabled.' };
  }
  if (maxResults < 1 || maxResults > 10) {
    return { ok: false, message: 'Max results must be between 1 and 10.' };
  }
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 120) {
    return { ok: false, message: 'Web search timeout must be between 0 and 120 seconds (0 = no limit).' };
  }
  const fetchMaxMb = parseFloat(fetchMaxMbInput.value);
  if (!Number.isFinite(fetchMaxMb) || fetchMaxMb < 0.25 || fetchMaxMb > 10) {
    return { ok: false, message: 'Max page size must be between 0.25 and 10 MB.' };
  }
  const pageTimeoutSeconds = parseInt(pageTimeoutSecondsInput.value, 10);
  if (!Number.isFinite(pageTimeoutSeconds) || pageTimeoutSeconds < 0 || pageTimeoutSeconds > 120) {
    return { ok: false, message: 'Per-page timeout must be between 0 and 120 seconds (0 = no limit).' };
  }
  settings.webSearchEnabled = webEnabled;
  settings.webSearchApiKey = apiKey;
  settings.webSearchCx = cx;
  settings.webSearchMaxResults = maxResults;
  settings.webSearchSafeSearch = safeSearch;
  settings.webSearchTimeoutMs = timeoutSeconds <= 0 ? 0 : Math.round(timeoutSeconds * 1000);
  settings.webSearchFetchPages = fetchPagesInput.checked;
  settings.webSearchFetchMaxBytes = Math.min(
    Math.max(Math.round(fetchMaxMb * 1048576), 4096),
    10 * 1024 * 1024
  );
  settings.webSearchPageFetchTimeoutMs =
    pageTimeoutSeconds <= 0 ? 0 : Math.round(pageTimeoutSeconds * 1000);

  return { ok: true };
}

async function persistSettingsModal() {
  try {
    const settings = await window.electronAPI.getSettings();
    const r = applyAllSettingsModalFieldsToSettings(settings);
    if (!r.ok) {
      alert(r.message);
      return false;
    }
    await window.electronAPI.saveSettings(settings);
    initWebSearchCheckbox(await window.electronAPI.getSettings());
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

async function loadWebSearchSettings() {
  const settings = await window.electronAPI.getSettings();
  
  const enabledInput = document.getElementById('settings-web-search-enabled-input');
  if (enabledInput) {
    enabledInput.checked = settings.webSearchEnabled || false;
  }
  
  const apiKeyInput = document.getElementById('settings-web-search-api-key-input');
  if (apiKeyInput) {
    apiKeyInput.value = settings.webSearchApiKey || '';
    apiKeyInput.type = 'password';
  }
  
  const toggleBtn = document.getElementById('toggle-api-key-visibility-btn');
  if (toggleBtn) {
    toggleBtn.textContent = 'Show';
  }
  
  const cxInput = document.getElementById('settings-web-search-cx-input');
  if (cxInput) {
    cxInput.value = settings.webSearchCx || '';
  }
  
  const maxResultsInput = document.getElementById('settings-web-search-max-results-input');
  if (maxResultsInput) {
    maxResultsInput.value = settings.webSearchMaxResults || 5;
  }
  
  const timeoutSecondsInput = document.getElementById('settings-web-search-timeout-seconds-input');
  if (timeoutSecondsInput) {
    const ms = settings.webSearchTimeoutMs;
    const sec = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
    timeoutSecondsInput.value = sec;
  }

  const safeSearchInput = document.getElementById('settings-web-search-safe-search-input');
  if (safeSearchInput) {
    safeSearchInput.value = settings.webSearchSafeSearch || 'off';
  }

  const fetchPagesInput = document.getElementById('settings-web-search-fetch-pages-input');
  if (fetchPagesInput) {
    fetchPagesInput.checked = settings.webSearchFetchPages !== false;
  }

  const fetchMaxMbInput = document.getElementById('settings-web-search-fetch-max-mb-input');
  if (fetchMaxMbInput) {
    const b = Number(settings.webSearchFetchMaxBytes) || 1048576;
    const mb = Math.round((b / 1048576) * 1000) / 1000;
    fetchMaxMbInput.value = String(Math.min(10, Math.max(0.25, mb || 1)));
  }

  const pageTimeoutSecondsInput = document.getElementById('settings-web-search-page-timeout-seconds-input');
  if (pageTimeoutSecondsInput) {
    const ms = Number(settings.webSearchPageFetchTimeoutMs);
    const sec = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
    pageTimeoutSecondsInput.value = sec;
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
    btn.textContent = 'Regenerate Vector Store';
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
  const testUrl = `${restUrl}/tools/documents`;
  
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
}

async function getDefaultPayload(endpointPath) {
  let defaultPayload = {};
  if (endpointPath === '/tools/search') {
    defaultPayload = { query: 'test query', limit: 10, algorithm: 'hybrid' };
  } else if (endpointPath === '/tools/ingest/file') {
    defaultPayload = { filePath: '', watch: false };
  } else if (endpointPath === '/tools/ingest/directory') {
    defaultPayload = { dirPath: '', recursive: false, watch: false };
  } else if (endpointPath === '/tools/:toolId') {
    defaultPayload = { query: 'test query', limit: 10 };
  } else if (endpointPath === '/mcp') {
    defaultPayload = {
      jsonrpc: '2.0',
      method: 'initialize',
      params: {},
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

// Markdown rendering is now handled by the marked library via electronAPI.renderMarkdown()
// The old convertMarkdownToHTML function has been removed in favor of marked

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

