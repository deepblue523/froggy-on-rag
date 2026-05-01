const fs = require('fs');
const path = require('path');
const { getAppRoot } = require('../../paths');

const MAX_ENTRIES = 10000;

function requestLogFilePath() {
  return path.join(getAppRoot(), 'http-request-log.json');
}

function legacyRequestLogFilePath() {
  return path.join(getAppRoot(), 'mcp-request-log.json');
}

function readEntriesFromFile(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

function readEntriesFromDisk() {
  const primary = readEntriesFromFile(requestLogFilePath());
  if (primary.length) return primary;
  return readEntriesFromFile(legacyRequestLogFilePath());
}

function writeEntriesToDisk(entries) {
  const file = requestLogFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ entries }, null, 0), 'utf8');
}

function clampRetentionDays(raw) {
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return 7;
  return Math.max(1, Math.min(3650, n));
}

function pruneByRetention(entries, retentionDays) {
  const d = clampRetentionDays(retentionDays);
  const cutoff = Date.now() - d * 24 * 60 * 60 * 1000;
  return entries.filter((e) => {
    if (!e || typeof e.timestamp !== 'string') return false;
    const t = new Date(e.timestamp).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
}

/**
 * @param {*} ragService
 * @param {{ method?: string, path?: string, statusCode?: number, durationMs?: number, source?: string }} partial
 * @returns {object | null} persisted entry, or null if logging disabled
 */
function appendRequestLog(ragService, partial) {
  if (!ragService || typeof ragService.getSettings !== 'function') return null;
  const settings = ragService.getSettings();
  if (!settings || settings.mcpRequestLoggingEnabled !== true) return null;

  const retentionDays = clampRetentionDays(settings.mcpRequestLogRetentionDays);
  const entry = {
    timestamp: new Date().toISOString(),
    method: String((partial && partial.method) || ''),
    path: String((partial && partial.path) || ''),
    statusCode: Number((partial && partial.statusCode) || 0) || 0,
    durationMs: Number((partial && partial.durationMs) || 0) || 0,
    source: String((partial && partial.source) || 'rag-rest')
  };

  let entries = pruneByRetention(readEntriesFromDisk(), retentionDays);
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(-MAX_ENTRIES);
  }
  writeEntriesToDisk(entries);
  return entry;
}

/**
 * @param {*} ragService
 * @param {number} [limit]
 */
function getRequestLogs(ragService, limit = 500) {
  const settings =
    ragService && typeof ragService.getSettings === 'function' ? ragService.getSettings() : {};
  const retentionDays = clampRetentionDays(settings && settings.mcpRequestLogRetentionDays);
  const entries = pruneByRetention(readEntriesFromDisk(), retentionDays);
  const lim = Math.max(1, Math.min(5000, Number(limit) || 500));
  return entries.slice(-lim);
}

/**
 * Express middleware: logs each request when settings allow, then calls onRecorded(entry).
 * @param {import('express').Express} app
 * @param {*} ragService
 * @param {string} source
 * @param {(entry: object) => void} [onRecorded]
 */
function attachHttpRequestLogger(app, ragService, source, onRecorded) {
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      try {
        const entry = appendRequestLog(ragService, {
          method: req.method,
          path: req.originalUrl || req.url || '',
          statusCode: res.statusCode,
          durationMs: Date.now() - start,
          source
        });
        if (entry && typeof onRecorded === 'function') {
          onRecorded(entry);
        }
      } catch (_) {
        /* ignore logging failures */
      }
    });
    next();
  });
}

module.exports = {
  appendRequestLog,
  getRequestLogs,
  attachHttpRequestLogger,
  requestLogFilePath,
  legacyRequestLogFilePath
};
