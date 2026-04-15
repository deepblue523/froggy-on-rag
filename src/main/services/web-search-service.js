const { v4: uuidv4 } = require('uuid');
const { convert: htmlToText } = require('html-to-text');

/** When unset or empty, debug is on (same as DEBUG_WEB_SEARCH=1). Set to 0/false/off/no to disable. */
function isDebugWebSearch() {
  const v = process.env.DEBUG_WEB_SEARCH;
  if (v === undefined || v === '') return true;
  const s = String(v).trim().toLowerCase();
  return s !== '0' && s !== 'false' && s !== 'off' && s !== 'no';
}

function webSearchDebug(...args) {
  if (!isDebugWebSearch()) return;
  console.log('[web-search]', ...args);
}

class WebSearchService {
  constructor() {
    this.apiKey = null;
    this.cx = null;
    this.maxResults = 5;
    this.safeSearch = 'off';
    this.enabled = false;
    /** 0 = no timeout; otherwise max time for the Google HTTP request (ms). */
    this.timeoutMs = 10000;
    /** Fetch each result URL and chunk extracted page text (HTML → plain text). */
    this.fetchPages = true;
    /** Max bytes read per page body (cap memory and slow pages). */
    this.fetchMaxBytes = 1048576;
    /** Per-URL timeout when fetching pages (ms). 0 = no limit. */
    this.pageFetchTimeoutMs = 8000;
  }

  configure(settings) {
    this.enabled = settings.webSearchEnabled || false;
    this.apiKey = settings.webSearchApiKey || null;
    this.cx = settings.webSearchCx || null;
    this.maxResults = settings.webSearchMaxResults || 5;
    this.safeSearch = settings.webSearchSafeSearch || 'off';
    const t = Number(settings.webSearchTimeoutMs);
    this.timeoutMs = Number.isFinite(t) && t >= 0 ? Math.min(Math.floor(t), 600000) : 10000;
    this.fetchPages = settings.webSearchFetchPages !== false;
    const maxB = Number(settings.webSearchFetchMaxBytes);
    this.fetchMaxBytes =
      Number.isFinite(maxB) && maxB >= 4096 ? Math.min(Math.floor(maxB), 10 * 1024 * 1024) : 1048576;
    const pt = Number(settings.webSearchPageFetchTimeoutMs);
    this.pageFetchTimeoutMs =
      Number.isFinite(pt) && pt >= 0 ? Math.min(Math.floor(pt), 120000) : 8000;
  }

  isAvailable() {
    return this.enabled && this.apiKey && this.cx;
  }

  /**
   * Fetch results from Google Custom Search JSON API.
   * Returns raw items array from the API response.
   * @param {string} query
   * @param {{ maxResults?: number }} [options] When set, caps `num` for this request only (API max 10).
   */
  async fetchResults(query, options = {}) {
    if (!this.isAvailable()) {
      throw new Error('Web search is not configured. Set API key and Search Engine ID in Settings > Web Search.');
    }

    const cap = Number.isFinite(options.maxResults) ? options.maxResults : this.maxResults;
    const num = Math.min(Math.max(1, Math.floor(cap)), 10);

    const params = new URLSearchParams({
      key: this.apiKey,
      cx: this.cx,
      q: query,
      num: String(num),
      safe: this.safeSearch
    });

    const url = `https://www.googleapis.com/customsearch/v1?${params.toString()}`;

    webSearchDebug('Custom Search API request', {
      q: query,
      num: String(num),
      safe: this.safeSearch,
      cx: this.cx,
      timeoutMs: this.timeoutMs
    });

    let response;
    const timeoutMs = this.timeoutMs;
    if (timeoutMs > 0) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        response = await fetch(url, { signal: ac.signal });
      } finally {
        clearTimeout(timer);
      }
    } else {
      response = await fetch(url);
    }
    if (!response.ok) {
      const body = await response.text();
      webSearchDebug('Custom Search API error', { status: response.status, bodyPreview: body.slice(0, 200) });
      throw new Error(`Google Custom Search API error (${response.status}): ${body}`);
    }

    const data = await response.json();
    const items = data.items || [];
    webSearchDebug('Custom Search API ok', { status: response.status, itemCount: items.length });
    return items;
  }

  _htmlToPlain(html) {
    return htmlToText(html, {
      wordwrap: false,
      selectors: [
        { selector: 'script', format: 'skip' },
        { selector: 'style', format: 'skip' },
        { selector: 'noscript', format: 'skip' }
      ]
    });
  }

  _isAllowedHttpUrl(urlString) {
    try {
      const u = new URL(urlString);
      return (u.protocol === 'http:' || u.protocol === 'https:') && Boolean(u.hostname);
    } catch {
      return false;
    }
  }

  /**
   * Read response body up to maxBytes (streaming) to avoid huge downloads.
   */
  async _readBodyLimited(response, maxBytes) {
    if (!response.body) {
      return Buffer.alloc(0);
    }
    const reader = response.body.getReader();
    const parts = [];
    let total = 0;
    try {
      while (total < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || !value.length) continue;
        const remaining = maxBytes - total;
        if (value.length > remaining) {
          parts.push(Buffer.from(value.subarray(0, remaining)));
          total = maxBytes;
          await reader.cancel().catch(() => {});
          break;
        }
        parts.push(Buffer.from(value));
        total += value.length;
      }
    } finally {
      reader.releaseLock();
    }
    return parts.length === 0 ? Buffer.alloc(0) : Buffer.concat(parts);
  }

  /**
   * Fetch a result URL and return plain text (HTML/XML → text, text/* as UTF-8).
   */
  async fetchPageText(url) {
    if (!this._isAllowedHttpUrl(url)) {
      webSearchDebug('page fetch skipped', { url, reason: 'invalid-url' });
      return { text: '', contentType: '', fetched: false, error: 'invalid-url' };
    }

    const timeoutMs = this.pageFetchTimeoutMs;
    const maxBytes = this.fetchMaxBytes;
    webSearchDebug('page fetch request', { url, timeoutMs, maxBytes });
    let response;
    try {
      const init = {
        redirect: 'follow',
        headers: {
          'User-Agent': 'FroggyRAG/1.0 (compatible; research assistant)',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8'
        }
      };
      if (timeoutMs > 0) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        try {
          response = await fetch(url, { ...init, signal: ac.signal });
        } finally {
          clearTimeout(timer);
        }
      } else {
        response = await fetch(url, init);
      }
    } catch (err) {
      const msg = err && err.message ? String(err.message) : String(err);
      webSearchDebug('page fetch error', { url, error: msg });
      return { text: '', contentType: '', fetched: false, error: msg };
    }

    if (!response.ok) {
      webSearchDebug('page fetch HTTP error', { url, status: response.status });
      return {
        text: '',
        contentType: response.headers.get('content-type') || '',
        fetched: false,
        error: `HTTP ${response.status}`
      };
    }

    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const raw = await this._readBodyLimited(response, maxBytes);
    const asString = raw.toString('utf8');

    const isHtml =
      contentType.includes('html') ||
      contentType.includes('xml') ||
      /^\s*</.test(asString);

    let text;
    if (contentType.startsWith('text/plain') || contentType === 'text/csv') {
      text = asString;
    } else if (isHtml) {
      try {
        text = this._htmlToPlain(asString);
      } catch {
        text = asString.replace(/<[^>]+>/g, ' ');
      }
    } else if (contentType.startsWith('text/')) {
      text = asString;
    } else {
      text = '';
    }

    text = (text || '').replace(/\u0000/g, '').trim();
    webSearchDebug('page fetch ok', { url, contentType, textLength: text.length });
    return { text, contentType, fetched: true, error: null };
  }

  /**
   * Perform a web search and return results chunked into the same shape
   * used by the vector store search so they can be scored together.
   *
   * When page fetch is enabled, each result URL is downloaded, HTML (or other
   * text) is converted to plain text, then split with the same size/overlap
   * as local documents. Otherwise title + snippet are chunked only.
   */
  async searchAndChunk(query, chunkSize = 1000, chunkOverlap = 200, opts = {}) {
    webSearchDebug('searchAndChunk start', {
      queryPreview: query.length > 120 ? `${query.slice(0, 120)}…` : query,
      chunkSize,
      chunkOverlap,
      fetchPages: this.fetchPages
    });
    const items = await this.fetchResults(query, {
      maxResults: Number.isFinite(opts.maxResults) ? opts.maxResults : undefined
    });
    const fetchPages = this.fetchPages;

    const enriched = await Promise.all(
      items.map(async (item) => {
        const link = item.link || '';
        let pageText = '';
        let pageMeta = { pageFetched: false, pageContentType: '', pageFetchError: null };
        if (fetchPages && link) {
          const page = await this.fetchPageText(link);
          pageText = page.text;
          pageMeta = {
            pageFetched: page.fetched,
            pageContentType: page.contentType || '',
            pageFetchError: page.error || null
          };
        }
        return { item, pageText, pageMeta };
      })
    );

    const chunks = [];
    for (const { item, pageText, pageMeta } of enriched) {
      const title = item.title || '';
      const snippet = item.snippet || '';
      const link = item.link || '';
      const displayLink = item.displayLink || '';

      const header = [title, snippet].filter(Boolean).join('\n\n');
      let fullText;
      if (pageText && pageText.length > 0) {
        fullText = header ? `${header}\n\n---\n\n${pageText}` : pageText;
      } else {
        fullText = header;
      }
      if (!fullText.trim()) continue;

      const textChunks = this._splitText(fullText, chunkSize, chunkOverlap);

      for (let i = 0; i < textChunks.length; i++) {
        chunks.push({
          id: `web-${uuidv4()}`,
          document_id: `web-${link}`,
          chunk_index: i,
          content: textChunks[i],
          metadata: {
            source: 'web',
            fileName: title || displayLink,
            filePath: link,
            url: link,
            displayLink,
            webTitle: title,
            webSnippet: snippet,
            ...pageMeta
          },
          created_at: Date.now()
        });
      }
    }

    webSearchDebug('searchAndChunk done', {
      googleHitCount: items.length,
      chunkCount: chunks.length
    });
    return chunks;
  }

  /**
   * Simple text splitter with overlap, matching the app's chunking approach.
   */
  _splitText(text, chunkSize, overlap) {
    if (text.length <= chunkSize) return [text];

    const chunks = [];
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length);
      chunks.push(text.slice(start, end));
      start += chunkSize - overlap;
      if (start >= text.length) break;
    }
    return chunks;
  }
}

module.exports = { WebSearchService };
