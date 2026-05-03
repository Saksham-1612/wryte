const MODEL = 'qwen/qwen-2.5-7b-instruct';

console.log('[Wryte] background service worker started');

// LRU cache: domain|fieldType|text → completion (max 50 entries)
const CACHE_MAX = 50;
const cache = new Map();

function cacheKey(text, url, fieldType) {
  let domain = '';
  try { domain = new URL(url || '').hostname; } catch (e) { }
  return `${domain}|${fieldType || ''}|${text}`;
}

function cacheGet(key) {
  if (!cache.has(key)) return null;
  const val = cache.get(key);
  cache.delete(key);
  cache.set(key, val); // move to end (most recently used)
  return val;
}

function cacheSet(key, value) {
  if (cache.has(key)) cache.delete(key);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

async function readErrorDetail(response) {
  const ct = response.headers.get('content-type') || '';
  try {
    if (ct.includes('application/json')) {
      const data = await response.json();
      if (typeof data.detail === 'string') return data.detail;
      if (data.detail != null) return JSON.stringify(data.detail);
      return JSON.stringify(data);
    }
  } catch (_) { /* fall through */ }
  try {
    const text = await response.text();
    return text.slice(0, 300) || `HTTP ${response.status}`;
  } catch (_) {
    return `HTTP ${response.status}`;
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[Wryte] message received:', request.type);
  if (request.type === "GET_REWRITE") {
    (async () => {
      const res = await handleRewrite(request.text, request.style);
      sendResponse(res);
    })();
    return true;
  }
  if (request.type === "GET_COMPLETION") {
    (async () => {
      const { text, url = '', fieldType = '' } = request;
      const key = cacheKey(text, url, fieldType);
      const cached = cacheGet(key);
      if (cached) {
        console.log('[Wryte] cache hit');
        sendResponse({ completion: cached });
        return;
      }
      const res = await handleCompletion(text, url, fieldType);
      if (res && !res.error) cacheSet(key, res.completion);
      sendResponse(res);
    })();
    return true;
  }
});

async function handleRewrite(text, style) {
  console.log('[Wryte] rewrite:', style, text?.length);
  try {
    const response = await fetch("http://127.0.0.1:8000/rewrite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, style })
    });
    if (!response.ok) {
      const detail = await readErrorDetail(response);
      console.error('[Wryte] rewrite error:', detail);
      return { error: detail };
    }
    const data = await response.json();
    return data.text ? { text: data.text } : { error: "No rewritten text returned." };
  } catch (error) {
    console.error('[Wryte] rewrite fetch failed:', error.message);
    return { error: "Failed to connect to backend. Is it running on port 8000?" };
  }
}

async function handleCompletion(text, url, fieldType) {
  console.log('[Wryte] fetching completion for:', JSON.stringify(text));
  try {
    const response = await fetch("http://127.0.0.1:8000/autocomplete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model: MODEL,
        url,
        field_type: fieldType,
      })
    });

    console.log('[Wryte] backend responded with status:', response.status);

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      console.error('[Wryte] backend error:', detail);
      return { error: detail };
    }

    const data = await response.json();

    console.log('[Wryte] completion:', data.completion);
    return data.completion
      ? { completion: data.completion }
      : { error: "No completion returned from backend." };
  } catch (error) {
    console.error('[Wryte] fetch failed:', error.message);
    return { error: "Failed to connect to backend. Is it running on port 8000?" };
  }
}
