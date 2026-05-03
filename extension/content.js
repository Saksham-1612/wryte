console.log('[Wryte] content script loaded');

let typingTimer;
const typingDelay = 400;
let currentTarget = null;
let currentSuggestion = "";
let ghostContainer = null;
let tabHintEl = null;
let isAccepting = false;
let requestId = 0;
/** Bumped on each input / cancel path so stale completions never apply after deletes etc. */
let inputEpoch = 0;

let rewriteToolbarEl = null;
let rewriteToolbarCleanup = null;
let rewriteSelectionTimer = null;
let rewriteBusy = false;

/** After extension reload/update, the content script is orphaned until the tab is refreshed. */
let extensionContextDead = false;

const NAV_KEYS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown',
]);

function isExtensionOrphanedError(message) {
  const m = (message || '').toLowerCase();
  /** Reload/update disconnects the injected script from chrome.runtime — refresh tab to recover. */
  return (
    m.includes('invalidated')
    || m.includes('extension context')
    || m.includes('context invalidated')
  );
}

function markExtensionOrphaned() {
  if (extensionContextDead) return;
  extensionContextDead = true;
  removeGhostText();
  removeTabHint();
  removeRewriteToolbar();
  currentSuggestion = '';
  clearTimeout(typingTimer);
}

function runtimeUsable() {
  if (extensionContextDead) return false;
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
      markExtensionOrphaned();
      return false;
    }
    return true;
  } catch (_) {
    markExtensionOrphaned();
    return false;
  }
}

document.addEventListener('input', (e) => {
  if (isAccepting) return;
  if (!runtimeUsable()) return;

  const target = resolveEditableTarget(e);
  if (!target) return;

  inputEpoch++;
  const epoch = inputEpoch;

  clearTimeout(typingTimer);
  removeGhostText();
  removeTabHint();
  currentSuggestion = "";
  currentTarget = target;

  const value = getTargetValue(target);
  if (!value || value.trim() === '') return;

  typingTimer = setTimeout(() => {
    if (!runtimeUsable()) return;
    const raw = getTextBeforeCursor(target);
    if (!raw || raw.trim().length < 10) return;
    const liveValue = trimToContext(raw);
    console.log('[Wryte] fetching for:', JSON.stringify(liveValue));
    fetchSuggestion(target, liveValue, location.href, getFieldType(target), epoch);
  }, typingDelay);
}, { capture: true });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && currentSuggestion && currentTarget) {
    const origin = (e.composedPath && e.composedPath()[0]) || e.target;
    const inTarget = origin === currentTarget
      || e.target === currentTarget
      || (origin && origin.closest && origin.closest('[contenteditable]') === currentTarget);
    if (inTarget) {
      e.preventDefault();
      acceptSuggestion();
      return;
    }
  }
  if (e.key === 'Escape') {
    if (rewriteToolbarEl) {
      removeRewriteToolbar();
      return;
    }
    if (currentSuggestion) {
      inputEpoch++;
      removeGhostText();
      removeTabHint();
      currentSuggestion = "";
    }
    return;
  }
  // Arrow / home / end moves the caret without an `input` event — cancel ghost and in-flight fetch
  if (NAV_KEYS.has(e.key)) {
    inputEpoch++;
    if (currentSuggestion) {
      removeGhostText();
      removeTabHint();
      currentSuggestion = "";
    }
  }
}, { capture: true });

document.addEventListener('focusout', (e) => {
  const origin = (e.composedPath && e.composedPath()[0]) || e.target;
  const inTarget = origin === currentTarget
    || e.target === currentTarget
    || (origin && origin.closest && origin.closest('[contenteditable]') === currentTarget);
  if (inTarget) {
    inputEpoch++;
    removeGhostText();
    removeTabHint();
    currentSuggestion = "";
    currentTarget = null;
    clearTimeout(typingTimer);
  }
}, { capture: true });

// Walk composedPath() so we cross shadow DOM boundaries
function resolveEditableTarget(e) {
  const path = (e.composedPath && e.composedPath()) || [e.target];
  for (const node of path) {
    if (!node || !node.tagName) continue;
    if (node === document.body || node === document.documentElement) break;
    if (node.tagName === 'TEXTAREA') return node;
    if (node.tagName === 'INPUT') {
      const t = (node.type || 'text').toLowerCase();
      if (['password', 'hidden', 'checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image'].includes(t)) return null;
      return node;
    }
    if (node.isContentEditable) {
      // Walk up to root contentEditable so getTargetValue captures full text
      let root = node;
      while (root.parentElement && root.parentElement.isContentEditable) {
        root = root.parentElement;
      }
      return root;
    }
  }
  return null;
}

function getTargetValue(target) {
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
    return target.value || '';
  }
  return target.innerText || target.textContent || '';
}

// Returns only the text before the cursor (not the full field value)
function getTextBeforeCursor(target) {
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
    const pos = target.selectionStart != null ? target.selectionStart : target.value.length;
    return target.value.substring(0, pos);
  }
  try {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && target.contains(sel.anchorNode)) {
      const range = document.createRange();
      range.setStart(target, 0);
      range.setEnd(sel.anchorNode, sel.anchorOffset);
      return range.toString();
    }
  } catch (_) { }
  return target.innerText || target.textContent || '';
}

function getFieldType(target) {
  if (target.tagName === 'TEXTAREA') return 'textarea';
  if (target.tagName === 'INPUT') return 'input';
  return 'div';
}

// Trim to last maxLen chars, aligned to word boundary so we don't start mid-word
function trimToContext(text, maxLen = 150) {
  if (text.length <= maxLen) return text;
  const slice = text.slice(text.length - maxLen);
  const firstSpace = slice.indexOf(' ');
  return firstSpace === -1 ? slice : slice.slice(firstSpace + 1);
}

// Ghost text only works reliably when cursor is at end of input/textarea
function canShowGhostText(target) {
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
    return target.selectionStart === target.value.length;
  }
  return false;
}

async function fetchSuggestion(target, text, url, fieldType, epoch) {
  const myId = ++requestId;
  try {
    const response = await new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: "GET_COMPLETION", text, url, fieldType }, (res) => {
          if (chrome.runtime.lastError) {
            const msg = chrome.runtime.lastError.message || '';
            if (isExtensionOrphanedError(msg)) {
              resolve(null);
              return;
            }
            reject(new Error(msg));
            return;
          }
          resolve(res);
        });
      } catch (syncErr) {
        reject(syncErr instanceof Error ? syncErr : new Error(String(syncErr)));
      }
    });

    if (response === null) {
      markExtensionOrphaned();
      return;
    }
    if (epoch !== inputEpoch || myId !== requestId || currentTarget !== target) return;
    if (!response || response.error) return;

    if (response.completion && currentTarget) {
      currentSuggestion = response.completion;
      console.log('[Wryte] rendering:', currentSuggestion);
      if (canShowGhostText(currentTarget)) {
        renderGhostText(currentTarget, currentSuggestion);
      }
      renderTabHint(currentTarget, currentSuggestion);
    }
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    if (isExtensionOrphanedError(msg)) {
      markExtensionOrphaned();
      return;
    }
    console.error('[Wryte] error:', msg);
  }
}

function acceptSuggestion() {
  if (!currentTarget || !currentSuggestion) return;
  isAccepting = true;

  const isEditable = currentTarget.tagName !== 'INPUT' && currentTarget.tagName !== 'TEXTAREA';
  if (isEditable) {
    // execCommand fires an InputEvent that ProseMirror/Draft.js/Quill actually handle
    const inserted = document.execCommand('insertText', false, currentSuggestion);
    if (!inserted) {
      // fallback for browsers/contexts that block execCommand
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(currentSuggestion));
        range.collapse(false);
      }
      currentTarget.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } else {
    const start = currentTarget.selectionStart;
    currentTarget.value =
      currentTarget.value.substring(0, start) +
      currentSuggestion +
      currentTarget.value.substring(start);
    currentTarget.selectionStart = currentTarget.selectionEnd = start + currentSuggestion.length;
    currentTarget.dispatchEvent(new Event('input', { bubbles: true }));
  }

  isAccepting = false;
  removeGhostText();
  removeTabHint();
  currentSuggestion = "";
}

function removeGhostText() {
  if (ghostContainer) {
    if (ghostContainer._scrollCleanup) ghostContainer._scrollCleanup();
    ghostContainer.remove();
    ghostContainer = null;
  }
}

function removeTabHint() {
  if (tabHintEl) {
    if (tabHintEl._cleanup) tabHintEl._cleanup();
    tabHintEl.remove();
    tabHintEl = null;
  }
}

function renderGhostText(target, suggestion) {
  removeGhostText();

  const rect = target.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const computed = window.getComputedStyle(target);

  ghostContainer = document.createElement('div');
  ghostContainer.style.position = 'fixed';
  ghostContainer.style.top = rect.top + 'px';
  ghostContainer.style.left = rect.left + 'px';
  ghostContainer.style.width = rect.width + 'px';
  ghostContainer.style.height = rect.height + 'px';
  ghostContainer.style.pointerEvents = 'none';
  ghostContainer.style.zIndex = '2147483646';
  ghostContainer.style.overflow = 'hidden';
  ghostContainer.style.boxSizing = 'border-box';

  const mirrorDiv = document.createElement('div');
  [
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
    'lineHeight', 'textAlign', 'textTransform', 'wordSpacing', 'textIndent'
  ].forEach(p => { mirrorDiv.style[p] = computed[p]; });

  mirrorDiv.style.borderStyle = 'solid';
  mirrorDiv.style.borderColor = 'transparent';
  mirrorDiv.style.boxSizing = 'border-box';
  mirrorDiv.style.width = '100%';
  mirrorDiv.style.height = '100%';
  mirrorDiv.style.overflow = 'hidden';
  mirrorDiv.style.whiteSpace = target.tagName === 'INPUT' ? 'pre' : 'pre-wrap';
  mirrorDiv.style.wordWrap = 'break-word';

  const originalSpan = document.createElement('span');
  originalSpan.textContent = getTargetValue(target);
  originalSpan.style.color = 'transparent';

  const suggestionSpan = document.createElement('span');
  suggestionSpan.style.color = '#94a3b8';
  suggestionSpan.style.fontWeight = '400';
  suggestionSpan.style.whiteSpace = 'nowrap';
  suggestionSpan.style.animation = 'wryte-fade-in 0.15s ease-out';
  suggestionSpan.textContent = suggestion;

  mirrorDiv.appendChild(originalSpan);
  mirrorDiv.appendChild(suggestionSpan);
  ghostContainer.appendChild(mirrorDiv);
  document.body.appendChild(ghostContainer);

  mirrorDiv.scrollTop = target.scrollTop;
  mirrorDiv.scrollLeft = target.scrollLeft;

  const syncScroll = () => {
    mirrorDiv.scrollTop = target.scrollTop;
    mirrorDiv.scrollLeft = target.scrollLeft;
  };
  target.addEventListener('scroll', syncScroll, { passive: true });
  ghostContainer._scrollCleanup = () => target.removeEventListener('scroll', syncScroll);
}

// Reusable canvas for cursor position measurement
const _measureCanvas = document.createElement('canvas');

// Walk into shadow roots to find the truly focused element (handles web components, Material UI, etc.)
function getDeepActiveElement(root) {
  const el = (root || document).activeElement;
  if (!el) return null;
  return el.shadowRoot ? getDeepActiveElement(el.shadowRoot) : el;
}

function isAllowedTextField(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') {
    const t = (el.type || 'text').toLowerCase();
    return !['password', 'hidden', 'checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image'].includes(t);
  }
  return false;
}

/**
 * Global Selection API does not reflect text selections inside <input>/<textarea> (range stays collapsed).
 * Use selectionStart/selectionEnd on the focused field instead.
 */
function getFieldSelectionPreview(el) {
  const start = el.selectionStart;
  const end = el.selectionEnd;
  if (start == null || end == null || start === end) return null;
  const raw = (el.value || '').substring(start, end);
  const text = raw.trim();
  if (!text.length || text.length > 16000) return null;
  return {
    text,
    snapshot: { mode: 'field', editable: el, start, end },
  };
}

/** Anchor rect near end of selection for floating toolbar (single-line input + newline-based textarea). */
function getFieldSelectionAnchorRect(el, start, end) {
  const fieldRect = el.getBoundingClientRect();
  const computed = getComputedStyle(el);
  const ctx = _measureCanvas.getContext('2d');
  ctx.font = `${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`;
  const pl = parseFloat(computed.paddingLeft) || 0;
  const pr = parseFloat(computed.paddingRight) || 0;
  const pt = parseFloat(computed.paddingTop) || 0;
  const fs = parseFloat(computed.fontSize) || 14;
  const lh = computed.lineHeight === 'normal' ? fs * 1.4 : (parseFloat(computed.lineHeight) || fs * 1.4);
  const val = el.value || '';

  if (el.tagName === 'INPUT') {
    const before = val.substring(0, end);
    const tw = ctx.measureText(before).width;
    const x = Math.min(fieldRect.left + pl + tw, fieldRect.right - 8);
    const top = fieldRect.top + pt;
    const bottom = top + lh;
    return { left: x, top, width: 0, height: lh, bottom, right: x };
  }

  const beforeEnd = val.substring(0, end);
  const lines = beforeEnd.split('\n');
  const lineIdx = lines.length - 1;
  const currentLine = lines[lineIdx];
  const tw = ctx.measureText(currentLine).width;
  // Subtract scrollTop so position is relative to viewport, not document
  const lineTopRaw = fieldRect.top + pt + lineIdx * lh - el.scrollTop;
  const lineTop = Math.max(fieldRect.top, Math.min(lineTopRaw, fieldRect.bottom - lh));
  const x = Math.min(fieldRect.left + pl + tw, fieldRect.right - pr - 4);
  const bottom = lineTop + lh;
  return { left: x, top: lineTop, width: 0, height: lh, bottom, right: x };
}

function getCursorRect(target) {
  // contentEditable: Selection API gives exact cursor position
  if (target.isContentEditable) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const rects = sel.getRangeAt(0).getClientRects();
      if (rects.length > 0) return rects[rects.length - 1];
      const br = sel.getRangeAt(0).getBoundingClientRect();
      if (br.top !== 0 || br.left !== 0) return br;
    }
  }
  // input/textarea: measure text width up to cursor with canvas
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
    const fieldRect = target.getBoundingClientRect();
    const computed = getComputedStyle(target);
    const ctx = _measureCanvas.getContext('2d');
    ctx.font = `${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`;
    const cursorIdx = target.selectionStart != null ? target.selectionStart : target.value.length;
    const tw = ctx.measureText(target.value.substring(0, cursorIdx)).width;
    const pl = parseFloat(computed.paddingLeft) || 0;
    const pt = parseFloat(computed.paddingTop) || 0;
    const fs = parseFloat(computed.fontSize) || 14;
    const lh = computed.lineHeight === 'normal' ? fs * 1.4 : (parseFloat(computed.lineHeight) || fs * 1.4);
    const x = Math.min(fieldRect.left + pl + tw, fieldRect.right - 8);
    return { left: x, right: x, top: fieldRect.top + pt, bottom: fieldRect.top + pt + lh, width: 0, height: lh };
  }
  return target.getBoundingClientRect();
}

function positionTabHint(el, cursorRect) {
  el.style.top = (cursorRect.bottom + 8) + 'px';
  el.style.left = cursorRect.left + 'px';
  el.style.transform = 'none';
}

function clampTabHint(el, cursorRect) {
  const GAP = 8;
  const hr = el.getBoundingClientRect();
  if (hr.right > window.innerWidth - GAP) {
    el.style.left = Math.max(GAP, window.innerWidth - hr.width - GAP) + 'px';
  }
  if (hr.bottom > window.innerHeight - GAP) {
    el.style.top = (cursorRect.top - hr.height - GAP) + 'px';
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderTabHint(target, suggestion) {
  removeTabHint();

  const fieldRect = target.getBoundingClientRect();
  if (!fieldRect.width || !fieldRect.height) return;

  tabHintEl = document.createElement('div');
  tabHintEl.className = 'wryte-tab-hint';

  const preview = suggestion.length > 35 ? suggestion.slice(0, 35) + '…' : suggestion;
  tabHintEl.innerHTML = `<span class="wryte-tab-hint-text">${escapeHtml(preview)}</span><kbd class="wryte-tab-hint-kbd">Tab</kbd>`;

  const cursorRect = getCursorRect(target);
  positionTabHint(tabHintEl, cursorRect);

  tabHintEl.addEventListener('mousedown', (e) => {
    e.preventDefault();
    acceptSuggestion();
  });

  document.body.appendChild(tabHintEl);
  requestAnimationFrame(() => { if (tabHintEl) clampTabHint(tabHintEl, cursorRect); });

  const reposition = () => {
    if (!tabHintEl) return;
    const r = getCursorRect(target);
    positionTabHint(tabHintEl, r);
    requestAnimationFrame(() => { if (tabHintEl) clampTabHint(tabHintEl, r); });
  };
  window.addEventListener('scroll', reposition, { passive: true, capture: true });
  window.addEventListener('resize', reposition, { passive: true });

  tabHintEl._cleanup = () => {
    window.removeEventListener('scroll', reposition, { capture: true });
    window.removeEventListener('resize', reposition);
  };
}

// --- Selection rewrite (Phi-3 presets via backend /rewrite) ---
const REWRITE_STYLES = [
  { id: 'formal', label: 'Formal' },
  { id: 'casual', label: 'Casual' },
  { id: 'shorter', label: 'Shorter' },
  { id: 'expand', label: 'Expand' },
  { id: 'clearer', label: 'Clearer' },
  { id: 'grammar', label: 'Grammar' },
  { id: 'bullets', label: 'Bullets' },
  { id: 'professional', label: 'Professional' },
];

function removeRewriteToolbar() {
  if (rewriteToolbarCleanup) {
    rewriteToolbarCleanup();
    rewriteToolbarCleanup = null;
  }
  if (rewriteToolbarEl) {
    rewriteToolbarEl.remove();
    rewriteToolbarEl = null;
  }
}

function getEditableFromSelection(sel) {
  if (!sel || !sel.anchorNode) return null;
  let el = sel.anchorNode.nodeType === Node.TEXT_NODE ? sel.anchorNode.parentElement : sel.anchorNode;
  if (!el || el.nodeType !== Node.ELEMENT_NODE) el = sel.anchorNode.parentElement;
  while (el) {
    if (el.tagName === 'TEXTAREA') return el;
    if (el.tagName === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      if (['password', 'hidden', 'checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image'].includes(t)) return null;
      return el;
    }
    if (el.isContentEditable) {
      let root = el;
      while (root.parentElement && root.parentElement.isContentEditable) root = root.parentElement;
      return root;
    }
    const parent = el.parentElement;
    if (parent) {
      el = parent;
      continue;
    }
    const rn = el.getRootNode();
    el = rn instanceof ShadowRoot ? rn.host : null;
  }
  return null;
}

/** How to apply a rewrite: form field, rich editor, or copy-only (plain page text). */
function captureRewriteSnapshot(sel, editable) {
  const selectedPlain = (sel.toString() || '').trim();
  if (!selectedPlain) return null;

  if (editable && (editable.tagName === 'INPUT' || editable.tagName === 'TEXTAREA')) {
    const start = editable.selectionStart;
    const end = editable.selectionEnd;
    if (start === end) return null;
    return {
      mode: 'field',
      editable,
      start,
      end,
    };
  }

  let range = null;
  try {
    if (sel.rangeCount > 0) {
      const r = sel.getRangeAt(0);
      if (!r.collapsed) range = r.cloneRange();
    }
  } catch (_) { /* selection may be in a weird DOM state */ }

  if (editable && editable.isContentEditable && range) {
    return { mode: 'ce', editable, range };
  }

  if (range) {
    return { mode: 'clipboard', range };
  }

  /* Selection text exists but range could not be cloned (some shadow/custom DOM cases) — still offer rewrite via copy. */
  return { mode: 'clipboard', range: null };
}

function selectionBoundingRect(sel) {
  try {
    const r = sel.getRangeAt(0);
    const rects = r.getClientRects();
    let top = Infinity; let left = Infinity; let right = -Infinity; let bottom = -Infinity;
    for (let i = 0; i < rects.length; i++) {
      const cr = rects[i];
      if (cr.width === 0 && cr.height === 0) continue;
      top = Math.min(top, cr.top);
      left = Math.min(left, cr.left);
      right = Math.max(right, cr.right);
      bottom = Math.max(bottom, cr.bottom);
    }
    if (top === Infinity) return r.getBoundingClientRect();
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  } catch (_) {
    return {
      left: window.innerWidth / 2,
      top: 120,
      bottom: 120,
      width: 0,
      height: 0,
    };
  }
}

function updateRewriteToolbar(capturedAe) {
  if (rewriteBusy || !runtimeUsable()) return;

  // Use element captured at event time; fall back to current deep active element
  const ae = (capturedAe && capturedAe.isConnected) ? capturedAe : getDeepActiveElement();
  if (isAllowedTextField(ae)) {
    const fieldPick = getFieldSelectionPreview(ae);
    if (fieldPick) {
      if (rewriteToolbarEl && rewriteToolbarEl.dataset.wryteSel === fieldPick.text) return;
      const rect = getFieldSelectionAnchorRect(ae, fieldPick.snapshot.start, fieldPick.snapshot.end);
      showRewriteToolbar(rect, fieldPick.text, fieldPick.snapshot);
      return;
    }
  }

  const sel = window.getSelection();
  if (!sel) {
    removeRewriteToolbar();
    return;
  }

  const raw = sel.toString();
  const text = raw.trim();
  if (!text.length || text.length > 16000) {
    removeRewriteToolbar();
    return;
  }

  const nonCollapsed = sel.rangeCount > 0 && !sel.isCollapsed;
  if (!nonCollapsed) {
    removeRewriteToolbar();
    return;
  }

  const editable = getEditableFromSelection(sel);
  const snapshot = captureRewriteSnapshot(sel, editable);
  if (!snapshot) {
    removeRewriteToolbar();
    return;
  }

  if (rewriteToolbarEl && rewriteToolbarEl.dataset.wryteSel === text) return;

  const rect = selectionBoundingRect(sel);
  showRewriteToolbar(rect, text, snapshot);
}

function scheduleRewriteToolbarCheck(capturedAe) {
  clearTimeout(rewriteSelectionTimer);
  rewriteSelectionTimer = setTimeout(() => updateRewriteToolbar(capturedAe), 100);
}

function showRewriteToolbar(rect, selectedText, snapshot) {
  removeRewriteToolbar();

  const bar = document.createElement('div');
  bar.className = 'wryte-rewrite-toolbar';
  bar.setAttribute('role', 'toolbar');
  bar.dataset.wryteSel = selectedText;

  const label = document.createElement('div');
  label.className = 'wryte-rewrite-label';
  label.textContent = 'Rewrite';

  if (snapshot.mode === 'clipboard') {
    const hint = document.createElement('div');
    hint.className = 'wryte-rewrite-hint';
    hint.textContent = 'Result is copied — paste to replace.';
    bar.appendChild(label);
    bar.appendChild(hint);
  } else {
    bar.appendChild(label);
  }

  const row = document.createElement('div');
  row.className = 'wryte-rewrite-buttons';

  REWRITE_STYLES.forEach(({ id, label: lbl }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wryte-rewrite-btn';
    b.textContent = lbl;
    b.title = lbl;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      runRewrite(id, selectedText, snapshot);
    });
    row.appendChild(b);
  });

  bar.appendChild(row);
  bar.style.visibility = 'hidden';
  document.body.appendChild(bar);
  rewriteToolbarEl = bar;

  requestAnimationFrame(() => {
    if (!rewriteToolbarEl) return;
    const w = bar.offsetWidth;
    const h = bar.offsetHeight;
    const pad = 8;
    let left = rect.left + rect.width / 2 - w / 2;
    let top = (rect.bottom ?? rect.top + rect.height) + 8;
    left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));
    if (top + h > window.innerHeight - pad) top = rect.top - h - 8;
    if (top < pad) top = pad;
    bar.style.left = `${left}px`;
    bar.style.top = `${top}px`;
    bar.style.visibility = '';
  });

  const onScroll = () => removeRewriteToolbar();
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });
  const onResize = () => removeRewriteToolbar();
  window.addEventListener('resize', onResize, { passive: true });
  const onDocDown = (e) => {
    if (rewriteToolbarEl && !rewriteToolbarEl.contains(e.target)) removeRewriteToolbar();
  };
  document.addEventListener('mousedown', onDocDown, true);
  rewriteToolbarCleanup = () => {
    window.removeEventListener('scroll', onScroll, { capture: true });
    window.removeEventListener('resize', onResize);
    document.removeEventListener('mousedown', onDocDown, true);
  };
}

function showRewriteToast(message, isError) {
  const t = document.createElement('div');
  t.className = 'wryte-rewrite-toast' + (isError ? ' wryte-rewrite-error' : '');
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), isError ? 5000 : 2500);
}

async function runRewrite(style, selectedText, snapshot) {
  if (rewriteBusy || !runtimeUsable()) return;
  rewriteBusy = true;
  removeRewriteToolbar();

  const toast = document.createElement('div');
  toast.className = 'wryte-rewrite-toast';
  toast.textContent = 'Rewriting…';
  document.body.appendChild(toast);

  try {
    const res = await new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(
          { type: 'GET_REWRITE', text: selectedText, style },
          (r) => {
            if (chrome.runtime.lastError) {
              const msg = chrome.runtime.lastError.message || '';
              if (isExtensionOrphanedError(msg)) {
                resolve(null);
                return;
              }
              reject(new Error(msg));
              return;
            }
            resolve(r);
          }
        );
      } catch (syncErr) {
        reject(syncErr instanceof Error ? syncErr : new Error(String(syncErr)));
      }
    });
    toast.remove();
    if (res === null) {
      markExtensionOrphaned();
      return;
    }
    if (!res || res.error) {
      showRewriteToast(res?.error || 'Rewrite failed', true);
      return;
    }
    applyRewriteResult(snapshot, res.text);
  } catch (err) {
    toast.remove();
    const msg = err && err.message ? String(err.message) : String(err);
    if (isExtensionOrphanedError(msg)) {
      markExtensionOrphaned();
      return;
    }
    showRewriteToast(msg || 'Rewrite failed', true);
  } finally {
    rewriteBusy = false;
  }
}

function copyRewriteFallback(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    showRewriteToast('Rewritten text copied — paste to replace.', false);
  } catch (_) {
    showRewriteToast('Could not copy — select inside an editable field for inline replace.', true);
  }
  ta.remove();
}

function applyRewriteResult(snapshot, newText) {
  if (snapshot.mode === 'field') {
    const el = snapshot.editable;
    const { start, end } = snapshot;
    const v = el.value;
    el.focus();
    // Set selection to the original range, then use execCommand so React/Vue synthetic
    // event systems see a native input event and sync their state. Plain assignment to
    // el.value is ignored by React-controlled inputs.
    el.selectionStart = start;
    el.selectionEnd = end;
    const ok = document.execCommand('insertText', false, newText);
    if (!ok) {
      // Non-React fallback
      el.value = v.slice(0, start) + newText + v.slice(end);
      const pos = start + newText.length;
      el.selectionStart = el.selectionEnd = pos;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return;
  }

  if (snapshot.mode === 'ce') {
    const editable = snapshot.editable;
    try {
      editable.focus();
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(snapshot.range);
      // execCommand fires a beforeinput event — Lexical, Draft.js, Quill, and ProseMirror
      // all handle this and update their internal state. Direct DOM manipulation bypasses
      // their state trees and gets reverted on the next reconciliation.
      const ok = document.execCommand('insertText', false, newText);
      if (!ok) {
        // Plain contenteditable with no framework — fall back to direct DOM manipulation
        const r = sel.getRangeAt(0);
        r.deleteContents();
        const tn = document.createTextNode(newText);
        r.insertNode(tn);
        r.setStartAfter(tn);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
        editable.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch (_) {
      showRewriteToast('Could not apply rewrite — selection may have changed.', true);
    }
    return;
  }

  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(newText).then(() => {
      showRewriteToast('Rewritten text copied — paste to replace.', false);
    }).catch(() => copyRewriteFallback(newText));
    return;
  }
  copyRewriteFallback(newText);
}

document.addEventListener('selectionchange', () => scheduleRewriteToolbarCheck(getDeepActiveElement()));
document.addEventListener('mouseup', () => scheduleRewriteToolbarCheck(getDeepActiveElement()));
document.addEventListener('keyup', (e) => {
  if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    scheduleRewriteToolbarCheck(getDeepActiveElement());
  }
});
