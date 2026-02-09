// background.js (MV3) v1.7.4.7
// Lookup flow:
// 1) OpenReview /search in background tab -> scrape results, exact-title match.
// 2) Open matched forum page -> scrape versions dropdown labels.
// 3) If only one version/no dropdown, scrape concise venue metadata (e.g., folder-icon item).
// BibTeX flow (lazy):
// - On demand per forum id, open its forum page, click "Show Bibtex" and scrape BibTeX.
// - Robust extraction: only accept text that contains a BibTeX entry (line begins with '@').

const OR_WEB_BASE = 'https://openreview.net';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SEARCH_TIMEOUT_MS = 24000;
const FORUM_TIMEOUT_MS = 20000;
const BIBTEX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SEARCH_DOM_WAIT_MS = 10000;
const SEARCH_DOM_POLL_MS = 300;

const inflight = new Map();
const bibtexInflight = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'LOOKUP_OPENREVIEW') {
    (async () => {
      const title = (msg.title || '').trim();
      const arxivId = (msg.arxivId || '').trim();
      const forceRefresh = !!msg.forceRefresh;
      // Cache is per arXiv id including version (e.g., 2405.17394v1 vs 2405.17394).
      const cacheKey = `orlink:arxiv:${arxivId || 'unknown'}:title:${title.slice(0, 220)}`;

      try {
        const cached = await storageGet(cacheKey);
        if (!forceRefresh && cached && (Date.now() - cached.savedAt) < CACHE_TTL_MS) {
          sendResponse({ ok: true, result: cached.result, cached: true });
          return;
        }
        if (forceRefresh) inflight.delete(cacheKey);
        if (!inflight.has(cacheKey)) {
          inflight.set(cacheKey, withTimeout(doLookup(title), SEARCH_TIMEOUT_MS + FORUM_TIMEOUT_MS, {
            found: false,
            reason: 'Timed out',
            searchUrl: buildSearchUrl(title)
          }).finally(() => inflight.delete(cacheKey)));
        }

        const result = await inflight.get(cacheKey);
        await storageSet(cacheKey, { savedAt: Date.now(), result });
        sendResponse({ ok: true, result, cached: false });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();

    return true;
  }

  if (msg?.type === 'FETCH_BIBTEX') {
    (async () => {
      const forumId = (msg.forumId || '').trim();
      const key = `orlink:bibtex:${forumId}`;
      try {
        const cached = await storageGet(key);
        if (cached && cached.savedAt && (Date.now() - cached.savedAt) < BIBTEX_TTL_MS && cached.bibtex) {
          sendResponse({ ok: true, bibtex: cached.bibtex, cached: true });
          return;
        }

        if (!bibtexInflight.has(key)) {
          bibtexInflight.set(key, fetchBibtexForForum(forumId).finally(() => bibtexInflight.delete(key)));
        }
        const bibtex = await bibtexInflight.get(key);
        await storageSet(key, { savedAt: Date.now(), bibtex });
        sendResponse({ ok: true, bibtex, cached: false });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();

    return true;
  }
});

async function doLookup(title) {
  const searchUrl = buildSearchUrl(title);
  if (!title) return { found: false, reason: 'No title available', searchUrl };

  const searchResult = await withTimeout(findMatchViaRenderedSearch(title), SEARCH_TIMEOUT_MS, {
    found: false,
    reason: 'Timed out waiting for OpenReview search to render',
    searchUrl
  });

  if (!searchResult.found) return { found: false, reason: searchResult.reason || 'Not found', searchUrl };

  const forumId = searchResult.forumId;

  const forumResult = await withTimeout(scrapeForumVersionsAndVenue(forumId), FORUM_TIMEOUT_MS, {
    found: true,
    forumId,
    forumUrl: `${OR_WEB_BASE}/forum?id=${encodeURIComponent(forumId)}`,
    versions: [{ forumId, forumUrl: `${OR_WEB_BASE}/forum?id=${encodeURIComponent(forumId)}`, label: 'This version' }]
  });

  forumResult.searchUrl = searchUrl;
  return forumResult;
}

function buildSearchUrl(title) {
  const url = new URL(`${OR_WEB_BASE}/search`);
  url.searchParams.set('term', title || '');
  url.searchParams.set('content', 'title');
  url.searchParams.set('group', 'all');
  url.searchParams.set('source', 'forum');
  url.searchParams.set('sort', 'cdate:desc');
  return url.toString();
}

function normalizeTitle(s) {
  return String(s || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function findMatchViaRenderedSearch(title) {
  const searchUrl = buildSearchUrl(title);
  const tab = await tabsCreate({ url: searchUrl, active: false });
  try {
    await waitForTabComplete(tab.id, 15000);
    await waitForSearchDOM(tab.id, SEARCH_DOM_WAIT_MS, SEARCH_DOM_POLL_MS);

    const execRes = await scriptingExecute({ tabId: tab.id, func: scrapeRenderedSearchCards });
    const data = execRes?.result || execRes;
    const results = Array.isArray(data?.results) ? data.results : [];

    const target = normalizeTitle(title);
    for (const r of results) {
      if (!r?.forumId || !r?.title) continue;
      if (normalizeTitle(r.title) === target) {
        return { found: true, forumId: r.forumId, forumUrl: `${OR_WEB_BASE}/forum?id=${encodeURIComponent(r.forumId)}`, searchUrl };
      }
    }

    return { found: false, reason: data?.reason || 'No exact title matches', searchUrl };
  } finally {
    try { await tabsRemove(tab.id); } catch {}
  }
}

async function waitForSearchDOM(tabId, maxWaitMs, pollMs) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const execRes = await scriptingExecute({ tabId, func: inspectSearchDOMState });
      const state = execRes?.result || execRes;
      if (state?.hasForumCards || state?.hasNoResults) return true;
    } catch {
      // Ignore transient script-execution failures during page hydration.
    }
    await sleep(pollMs);
  }
  return false;
}

function scrapeRenderedSearchCards() {
  const results = [];
  const seen = new Set();
  const links = Array.from(document.querySelectorAll('a[href*="/forum?id="]'));

  for (const a of links) {
    const href = a.getAttribute('href') || '';
    if (!href.includes('/forum?id=')) continue;

    let forumId = null;
    try {
      forumId = new URL(href, location.origin).searchParams.get('id');
    } catch {
      const m = href.match(/\/forum\?id=([^&]+)/);
      if (m) forumId = m[1];
    }
    if (!forumId) continue;

    const card = a.closest('article') || a.closest('li') || a.closest('div');
    if (!card) continue;

    let title = '';
    const h = card.querySelector('h1,h2,h3,h4,h5');
    if (h) title = (h.innerText || h.textContent || '').trim();
    if (!title) title = (a.innerText || a.textContent || '').trim();
    if (!title || title.length < 6) continue;

    const key = forumId + '::' + title;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ forumId, title });
    if (results.length >= 120) break;
  }

  return { results, reason: results.length ? 'ok' : 'No forum results found in DOM' };
}

function inspectSearchDOMState() {
  const forumLinks = document.querySelectorAll('a[href*="/forum?id="]').length;
  const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').toLowerCase();
  const hasNoResults = /no results|no papers|no submissions|could not find/i.test(bodyText);
  return {
    hasForumCards: forumLinks > 0,
    hasNoResults
  };
}

async function scrapeForumVersionsAndVenue(forumId) {
  const forumUrl = `${OR_WEB_BASE}/forum?id=${encodeURIComponent(forumId)}`;
  const tab = await tabsCreate({ url: forumUrl, active: false });

  try {
    await waitForTabComplete(tab.id, 15000);
    await sleep(1600);

    const execRes = await scriptingExecute({ tabId: tab.id, func: scrapeForumVersions });
    const data = execRes?.result || execRes;

    const versions = Array.isArray(data?.versions) ? data.versions : [];
    const singleVenue = data?.singleVenue || null;

    if (!versions.length) {
      const label = singleVenue || 'This version';
      return { found: true, forumId, forumUrl, versions: [{ forumId, forumUrl, label }] };
    }

    if (versions.length === 1) {
      const v = versions[0];
      const label = singleVenue || v.label || 'This version';
      return { found: true, forumId, forumUrl, versions: [{ forumId: v.forumId, forumUrl: `${OR_WEB_BASE}/forum?id=${encodeURIComponent(v.forumId)}`, label }] };
    }

    return {
      found: true,
      forumId,
      forumUrl,
      versions: versions.map(v => ({ forumId: v.forumId, forumUrl: `${OR_WEB_BASE}/forum?id=${encodeURIComponent(v.forumId)}`, label: v.label }))
    };
  } finally {
    try { await tabsRemove(tab.id); } catch {}
  }
}

function scrapeForumVersions() {
  const versions = [];
  const seen = new Set();
  const MAX_VERSION_LABEL_CHARS = 120;
  const MAX_VERSION_LABEL_WORDS = 18;

  const versionBtn = findVersionsButton();
  if (versionBtn && versionBtn.click) {
    try { versionBtn.click(); } catch {}
  }

  const anchors = Array.from(document.querySelectorAll('a[href*="/forum?id="]'));
  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    if (!href.includes('/forum?id=')) continue;

    let id = null;
    try {
      id = new URL(href, location.origin).searchParams.get('id');
    } catch {
      const m = href.match(/\/forum\?id=([^&]+)/);
      if (m) id = m[1];
    }
    if (!id) continue;

    const label = sanitizeVersionLabel(a.innerText || a.textContent || '');
    if (!label || label.length < 6) continue;
    if (!isLikelyVersionOrVenueLabel(label)) continue;

    const key = id + '::' + label;
    if (seen.has(key)) continue;
    seen.add(key);
    versions.push({ forumId: id, label });
  }

  return { versions, singleVenue: pickSingleVenueLabel() };

  function pickSingleVenueLabel() {
    // Single-version case: extract the text that sits in the same "item"
    // as the folder icon (glyphicon-folder-open) on OpenReview forum pages.
    const folderIcons = Array.from(document.querySelectorAll('.glyphicon.glyphicon-folder-open, .glyphicon-folder-open'));
    for (const icon of folderIcons) {
      const container = icon.closest('.item') || icon.parentElement;
      const label = sanitizeVersionLabel(container ? (container.innerText || container.textContent || '') : '');
      if (!label) continue;
      if (/submitted to/i.test(label) || isLikelyVersionOrVenueLabel(label)) return label;
    }

    // Backup: keep generic "Submitted to ..." extraction without conference names.
    const nodes = Array.from(document.querySelectorAll('span, div, p, a')).slice(0, 350);
    for (const el of nodes) {
      const t = sanitizeVersionLabel(el.innerText || el.textContent || '');
      if (!t) continue;
      if (/^Submitted to\s+/i.test(t)) return t;
      if (isLikelyVersionOrVenueLabel(t)) return t;
    }
    return null;
  }

  function findVersionsButton() {
    const btnCandidates = Array.from(document.querySelectorAll('button, [role="button"], a'));
    return btnCandidates.find(el => {
      const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      const aria = (el.getAttribute && (el.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim();
      return /^\d+\s+versions?$/i.test(t) || /^\d+\s+versions?$/i.test(aria);
    }) || null;
  }

  function isLikelyVersionOrVenueLabel(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (/^Submitted to\s+/i.test(t)) return true;

    // Generic cues only (no conference-name matching).
    const hasYear = /(19|20)\d{2}/.test(t);
    const hasMonthYear = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b[\s,/-]*(19|20)\d{2}/i.test(t);
    const hasDecisionWord = /\b(?:oral|poster|spotlight|workshop|accept|accepted|reject|rejected|withdrawn|conditional)\b/i.test(t);
    return hasYear || hasMonthYear || hasDecisionWord;
  }

  function sanitizeVersionLabel(raw) {
    let label = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!label) return '';

    if (!label || label.length > MAX_VERSION_LABEL_CHARS) return '';
    if (label.split(/\s+/).length > MAX_VERSION_LABEL_WORDS) return '';
    if (/openreview\.net notifications|activity tasks|keywords:|abstract:/i.test(label)) return '';
    if (/authors|published:|last modified|everyone revisions|go to/i.test(label)) return '';
    return label;
  }
}

async function fetchBibtexForForum(forumId) {
  if (!forumId) throw new Error('Missing forumId');
  const forumUrl = `${OR_WEB_BASE}/forum?id=${encodeURIComponent(forumId)}`;
  const tab = await tabsCreate({ url: forumUrl, active: false });
  try {
    await waitForTabComplete(tab.id, 15000);
    await sleep(1600);

    // Try to open the BibTeX popover
    await scriptingExecute({ tabId: tab.id, func: clickShowBibtex });

    // Poll a few times: OpenReview is JS-heavy
    for (let i = 0; i < 10; i++) {
      await sleep(250);
      const execRes = await scriptingExecute({ tabId: tab.id, func: extractBibtexText });
      const data = execRes?.result || execRes;
      const bibtex = (data && data.bibtex) ? data.bibtex : '';
      if (bibtex && bibtex.length > 20) {
        return bibtex;
      }
    }

    throw new Error('Could not extract BibTeX');
  } finally {
    try { await tabsRemove(tab.id); } catch {}
  }
}

function clickShowBibtex() {
  const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
  const btn = candidates.find(el => {
    const t = (el.innerText || el.textContent || '').replace(/\s+/g,' ').trim().toLowerCase();
    return t === 'show bibtex' || t === 'bibtex' || t.includes('bibtex');
  });
  if (btn && btn.click) {
    try { btn.click(); } catch (e) {}
  }
  return { clicked: !!btn };
}

function extractBibtexText() {
  // robust bibtex extraction: accept only text that has a line starting with '@'
  // and does NOT look like Next.js hydration payload.
  const bad = (t) => /self\.__next_f\./.test(t);

  const findBibtexInText = (t) => {
    if (!t) return '';
    if (bad(t)) return '';
    // Find first bibtex entry start at beginning of line
    const m = t.match(/(^|\n)@\w+\s*\{/);
    if (!m) return '';
    const idx = m.index + (m[1] ? m[1].length : 0);
    const sliced = t.slice(idx).trim();
    // must start with @
    if (!sliced.startsWith('@')) return '';
    // basic sanity: must contain closing brace later
    if (!sliced.includes('\n}') && !sliced.endsWith('}')) return '';
    // Keep it reasonably sized
    if (sliced.length > 20000) return '';
    return sliced;
  };

  // Prefer textarea/pre/code inside dialogs/modals
  const dialogRoots = Array.from(document.querySelectorAll('[role="dialog"], .modal, .ui.modal')).slice(0, 10);
  const roots = dialogRoots.length ? dialogRoots : [document];

  for (const root of roots) {
    // textarea
    for (const el of Array.from(root.querySelectorAll('textarea'))) {
      const t = (el.value || '').trim();
      const bib = findBibtexInText(t);
      if (bib) return { bibtex: bib };
    }
    // pre/code
    for (const el of Array.from(root.querySelectorAll('pre, code'))) {
      const t = (el.innerText || el.textContent || '').trim();
      const bib = findBibtexInText(t);
      if (bib) return { bibtex: bib };
    }
  }

  // Last resort: limited scan of text nodes
  const nodes = Array.from(document.querySelectorAll('textarea, pre, code, div, span')).slice(0, 800);
  for (const el of nodes) {
    const t = (el.value || el.innerText || el.textContent || '').trim();
    const bib = findBibtexInText(t);
    if (bib) return { bibtex: bib };
  }

  return { bibtex: '' };
}

// ---- wrappers ----
function storageGet(key){ return new Promise(r => chrome.storage.local.get([key], o => r(o[key]))); }
function storageSet(key, value){ return new Promise(r => chrome.storage.local.set({[key]: value}, () => r(true))); }
function tabsCreate(props){ return new Promise((res, rej) => chrome.tabs.create(props, t => chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(t))); }
function tabsRemove(id){ return new Promise(res => chrome.tabs.remove(id, () => res(true))); }
function tabsGet(id){ return new Promise((res, rej) => chrome.tabs.get(id, t => chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(t))); }
function scriptingExecute({tabId, func}){ return new Promise((res, rej) => chrome.scripting.executeScript({target:{tabId}, func}, out => chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(Array.isArray(out)&&out.length?out[0]:out))); }
function waitForTabComplete(tabId, timeoutMs){
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    (async function poll(){
      try{
        const t = await tabsGet(tabId);
        if (t && t.status === 'complete'){
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(true); return;
        }
        if (Date.now()-start > timeoutMs){
          chrome.tabs.onUpdated.removeListener(listener);
          reject(new Error('Timed out waiting for tab to load')); return;
        }
        setTimeout(poll, 200);
      } catch(e){
        chrome.tabs.onUpdated.removeListener(listener);
        reject(e);
      }
    })();
  });
}
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function withTimeout(p, ms, fb){ let timer; return Promise.race([p, new Promise(r => timer=setTimeout(()=>r(fb), ms))]).finally(()=>clearTimeout(timer)); }
