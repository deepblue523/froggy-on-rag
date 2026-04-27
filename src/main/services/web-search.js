const GOOGLE_CUSTOM_SEARCH_ENDPOINT = 'https://www.googleapis.com/customsearch/v1';

function normalizePositiveInt(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(max, Math.floor(n));
}

function getGoogleCustomSearchConfig(settings) {
  const apiKey = String(settings.googleCustomSearchApiKey || '').trim();
  const searchEngineId = String(settings.googleCustomSearchEngineId || '').trim();
  const defaultNumResults = normalizePositiveInt(settings.googleCustomSearchNumResults, 5, 10);
  return { apiKey, searchEngineId, defaultNumResults };
}

function assertGoogleCustomSearchConfigured(settings) {
  const config = getGoogleCustomSearchConfig(settings || {});
  if (!config.apiKey) {
    throw new Error('Google Custom Search API key is required. Configure it under Settings -> Web Search.');
  }
  if (!config.searchEngineId) {
    throw new Error('Google Custom Search engine ID is required. Configure it under Settings -> Web Search.');
  }
  return config;
}

function formatWebResultsForContext(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return '';
  }
  return results
    .map((r, idx) => {
      const title = String(r.title || 'Untitled result').trim();
      const url = String(r.url || '').trim();
      const snippet = String(r.snippet || '').trim();
      const lines = [`[W${idx + 1}] Source: ${title}${url ? ` (${url})` : ''}`];
      if (snippet) lines.push(snippet);
      return lines.join('\n');
    })
    .join('\n\n---\n\n');
}

async function searchGoogleCustomSearch(settings, query, options = {}) {
  const config = assertGoogleCustomSearchConfigured(settings);
  const q = String(query || '').trim();
  if (!q) {
    throw new Error('query is required');
  }
  const numResults = normalizePositiveInt(options.numResults, config.defaultNumResults, 10);
  const controller = new AbortController();
  const timeoutMs = normalizePositiveInt(options.timeoutMs, 15000, 60000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(GOOGLE_CUSTOM_SEARCH_ENDPOINT);
    url.searchParams.set('key', config.apiKey);
    url.searchParams.set('cx', config.searchEngineId);
    url.searchParams.set('q', q);
    url.searchParams.set('num', String(numResults));

    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const message =
        data && data.error && data.error.message
          ? String(data.error.message)
          : `Google Custom Search failed with HTTP ${res.status}`;
      throw new Error(message);
    }

    const items = Array.isArray(data && data.items) ? data.items : [];
    const results = items.map((item) => ({
      title: String(item.title || '').trim(),
      url: String(item.link || '').trim(),
      displayLink: String(item.displayLink || '').trim(),
      snippet: String(item.snippet || '').trim(),
      formattedUrl: String(item.formattedUrl || '').trim()
    }));
    return {
      query: q,
      results,
      context: formatWebResultsForContext(results),
      searchInformation: data && data.searchInformation ? data.searchInformation : undefined
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  searchGoogleCustomSearch,
  formatWebResultsForContext,
  getGoogleCustomSearchConfig,
  assertGoogleCustomSearchConfigured
};
