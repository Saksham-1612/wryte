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

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[Wryte] message received:', request.type);
  if (request.type === "GET_COMPLETION") {
    const { text, url = '', fieldType = '' } = request;
    const key = cacheKey(text, url, fieldType);
    const cached = cacheGet(key);
    if (cached) {
      console.log('[Wryte] cache hit');
      sendResponse({ completion: cached });
      return true;
    }
    handleCompletion(text, url, fieldType).then(res => {
      if (res && !res.error) cacheSet(key, res.completion);
      sendResponse(res);
    });
    return true;
  }
});

async function handleCompletion(text, url, fieldType) {
  console.log('[Wryte] fetching completion for:', JSON.stringify(text));
  try {
    const response = await fetch("http://127.0.0.1:8000/autocomplete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, model: MODEL, url, field_type: fieldType })
    });

    console.log('[Wryte] backend responded with status:', response.status);
    const data = await response.json();

    if (!response.ok) {
      console.error('[Wryte] backend error:', data.detail);
      return { error: data.detail || "Unknown backend error" };
    }

    console.log('[Wryte] completion:', data.completion);
    return data.completion
      ? { completion: data.completion }
      : { error: "No completion returned from backend." };
  } catch (error) {
    console.error('[Wryte] fetch failed:', error.message);
    return { error: "Failed to connect to backend. Is it running on port 8000?" };
  }
}
