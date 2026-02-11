// background.js (MV3) API-based implementation
// Lookup flow:
// 1) Query OpenReview public API by title.
// 2) Exact-match normalized title to select forum candidates.
// 3) Build version labels from note metadata (no DOM scraping).
// BibTeX flow:
// - Fetch note from API and use provided bibtex field if available.
// - Otherwise generate a stable BibTeX entry from note metadata.

const OR_WEB_BASE = 'https://openreview.net';
const OR_API_BASES = [
  'https://api2.openreview.net',
  'https://api.openreview.net',
  'https://openreview.net'
];
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SEARCH_TIMEOUT_MS = 24000;
const FORUM_TIMEOUT_MS = 20000;
const BIBTEX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const inflight = new Map();
const bibtexInflight = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'LOOKUP_OPENREVIEW') {
    (async () => {
      const title = (msg.title || '').trim();
      const arxivId = (msg.arxivId || '').trim();
      const forceRefresh = !!msg.forceRefresh;
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

  const notes = await withTimeout(searchForumNotesByTitle(title), SEARCH_TIMEOUT_MS, []);
  if (!notes.length) return { found: false, reason: 'No results from OpenReview API', searchUrl };

  const target = normalizeTitle(title);
  const exact = notes.filter(n => normalizeTitle(getNoteTitle(n)) === target);
  if (!exact.length) return { found: false, reason: 'No exact title matches', searchUrl };

  const versions = buildVersionEntries(exact);
  if (!versions.length) return { found: false, reason: 'No forum versions found', searchUrl };

  const primary = versions[0];
  let finalVersions = versions;

  if (versions.length === 1) {
    const forumNote = await withTimeout(fetchNoteById(primary.forumId), FORUM_TIMEOUT_MS, null);
    const singleLabel = pickSingleVenueLabelFromNote(forumNote) || primary.label || 'This version';
    finalVersions = [{ ...primary, label: singleLabel }];
  }

  return {
    found: true,
    forumId: primary.forumId,
    forumUrl: primary.forumUrl,
    versions: finalVersions,
    searchUrl
  };
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

async function searchForumNotesByTitle(title) {
  const safeQuery = buildSafeTitleQuery(title);
  const data = await apiGetPath('/notes/search', {
    query: safeQuery,
    content: 'title',
    source: 'forum',
    sort: 'cdate:desc',
    limit: '100'
  });
  const notes = Array.isArray(data?.notes) ? data.notes : [];
  return notes.filter(n => getForumId(n) && getNoteTitle(n));
}

function buildSafeTitleQuery(title) {
  const raw = String(title || '').trim();
  if (!raw) return raw;
  return `"${escapeLuceneQuery(raw)}"`;
}

function escapeLuceneQuery(s) {
  return String(s || '').replace(/([+\-!(){}\[\]^"~*?:\\/]|&&|\|\|)/g, '\\$1');
}

function buildVersionEntries(notes) {
  const sorted = [...notes].sort((a, b) => (Number(b?.cdate || 0) - Number(a?.cdate || 0)));
  const byForum = new Map();

  for (const n of sorted) {
    const forumId = getForumId(n);
    if (!forumId || byForum.has(forumId)) continue;
    const label = pickVersionLabelFromNote(n) || 'This version';
    byForum.set(forumId, {
      forumId,
      forumUrl: `${OR_WEB_BASE}/forum?id=${encodeURIComponent(forumId)}`,
      label
    });
  }

  return Array.from(byForum.values());
}

function pickVersionLabelFromNote(note) {
  const venue = sanitizeLabel(
    getContentText(note, 'venue')
    || getContentText(note, 'venueid')
    || getContentText(note, 'decision')
    || ''
  );
  if (venue) return venue;

  const year = getYearFromNote(note);
  return year ? `Submitted ${year}` : '';
}

function pickSingleVenueLabelFromNote(note) {
  if (!note) return '';
  return sanitizeLabel(
    getContentText(note, 'venue')
    || getContentText(note, 'venueid')
    || getContentText(note, 'decision')
    || ''
  );
}

async function fetchBibtexForForum(forumId) {
  if (!forumId) throw new Error('Missing forumId');
  const note = await fetchNoteById(forumId);
  if (!note) throw new Error(`Forum note not found: ${forumId}`);

  const fromApi = getContentText(note, '_bibtex') || getContentText(note, 'bibtex');
  if (fromApi && /(^|\n)\s*@\w+\s*\{/.test(fromApi)) return fromApi.trim();

  return generateBibtexFromNote(note, forumId);
}

async function fetchNoteById(noteId) {
  const data = await apiGetPath('/notes', { id: noteId });
  const notes = Array.isArray(data?.notes) ? data.notes : [];
  return notes.length ? notes[0] : null;
}

async function apiGetPath(pathname, params) {
  let lastErr = null;

  for (const base of OR_API_BASES) {
    try {
      const url = new URL(pathname, base);
      for (const [k, v] of Object.entries(params || {})) {
        if (v != null && v !== '') url.searchParams.set(k, String(v));
      }
      return await apiGet(url.toString());
    } catch (e) {
      lastErr = e;
    }
  }

  throw new Error(`OpenReview API unavailable on all hosts: ${OR_API_BASES.join(', ')}. Last error: ${String(lastErr)}`);
}

async function apiGet(url) {
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'omit'
  });
  if (!res.ok) throw new Error(`OpenReview API ${res.status}`);
  return res.json();
}

function getForumId(note) {
  const forum = String(note?.forum || '').trim();
  if (forum) return forum;
  const id = String(note?.id || '').trim();
  return id || '';
}

function getNoteTitle(note) {
  return getContentText(note, 'title');
}

function getContentText(note, key) {
  const v = note?.content?.[key];
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.map(x => String(x || '').trim()).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    if (typeof v.value === 'string') return v.value.trim();
    if (Array.isArray(v.value)) return v.value.map(x => String(x || '').trim()).filter(Boolean).join(', ');
  }
  return '';
}

function getYearFromNote(note) {
  const ms = Number(note?.cdate || note?.tcdate || note?.tmdate || 0);
  if (!ms || !Number.isFinite(ms)) return '';
  const y = new Date(ms).getUTCFullYear();
  return y >= 1990 && y <= 2100 ? String(y) : '';
}

function sanitizeLabel(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (t.length > 140) return '';
  return t;
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

function generateBibtexFromNote(note, forumId) {
  const title = getNoteTitle(note) || 'Untitled';
  const authors = getAuthorsForBibtex(note);
  const year = getYearFromNote(note) || new Date().getUTCFullYear();
  const venue = getContentText(note, 'venue') || getContentText(note, 'venueid');
  const key = buildBibtexKey(authors, year, title, forumId);
  const url = `${OR_WEB_BASE}/forum?id=${encodeURIComponent(forumId)}`;

  const lines = [
    '@inproceedings{' + key + ',',
    '  title={' + bibtexEscape(title) + '},',
    '  author={' + bibtexEscape(authors) + '},',
    '  year={' + year + '},',
    venue ? '  booktitle={' + bibtexEscape(venue) + '},' : '  note={OpenReview},',
    '  url={' + bibtexEscape(url) + '}',
    '}'
  ];
  return lines.join('\n');
}

function getAuthorsForBibtex(note) {
  const raw = note?.content?.authors;
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (raw && Array.isArray(raw.value)) arr = raw.value;
  const cleaned = arr.map(a => String(a || '').trim()).filter(Boolean);
  return cleaned.length ? cleaned.join(' and ') : 'Unknown';
}

function buildBibtexKey(authors, year, title, forumId) {
  const first = String(authors || 'openreview').split(/\sand\s|,/i)[0].trim().split(/\s+/).pop() || 'openreview';
  const word = String(title || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).find(Boolean) || 'paper';
  const suffix = String(forumId || '').slice(0, 6).replace(/[^a-zA-Z0-9]/g, '') || 'id';
  return `${first}${year}${word}${suffix}`;
}

function bibtexEscape(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}');
}

function storageGet(key){ return new Promise(r => chrome.storage.local.get([key], o => r(o[key]))); }
function storageSet(key, value){ return new Promise(r => chrome.storage.local.set({[key]: value}, () => r(true))); }
function withTimeout(p, ms, fb){ let timer; return Promise.race([p, new Promise(r => timer=setTimeout(()=>r(fb), ms))]).finally(()=>clearTimeout(timer)); }
