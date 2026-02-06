// content.js (v1.7.4.7)

(function () {
  const title = extractTitle();
  const arxivId = extractArxivId();
  const searchUrl = buildSearchUrl(title);
  const mount = findRightColumn() || findMountFallback();
  if (!mount) return;

  const old = document.querySelector('.orlink-box');
  if (old) old.remove();

  const box = createBox(searchUrl);

  const access = findAccessPaperHeading();
  if (access) {
    const parent = access.closest('.full-text') || access.closest('div') || mount;
    parent.appendChild(box);
  } else {
    mount.appendChild(box);
  }

  triggerLookup(false);

  function triggerLookup(forceRefresh) {
    const status = box.querySelector('.orlink-status');
    const actions = box.querySelector('.orlink-actions');
    const versions = box.querySelector('.orlink-versions');
    const refreshBtn = box.querySelector('.orlink-refresh-btn');

    if (status) status.textContent = 'Searching…';
    if (actions) actions.innerHTML = `<a class=\"orlink-btn\" target=\"_blank\" rel=\"noreferrer\" href=\"${escapeAttr(searchUrl)}\">Search OpenReview</a>`;
    if (versions) { versions.style.display = 'none'; versions.innerHTML = ''; }
    setRefreshState(refreshBtn, 'loading');

    chrome.runtime.sendMessage({ type: 'LOOKUP_OPENREVIEW', title, arxivId, forceRefresh: !!forceRefresh }, (resp) => {
    if (chrome.runtime.lastError) {
      renderError(box, chrome.runtime.lastError.message);
      setRefreshState(refreshBtn, 'idle');
      return;
    }
    if (!resp?.ok) {
      renderError(box, resp?.error || 'Unknown error');
      setRefreshState(refreshBtn, 'idle');
      return;
    }
    renderResult(box, resp.result, resp.cached, searchUrl);
      setRefreshState(refreshBtn, 'idle');
    });
  }

  function buildSearchUrl(t) {
    const url = new URL('https://openreview.net/search');
    url.searchParams.set('term', t || '');
    url.searchParams.set('content', 'title');
    url.searchParams.set('group', 'all');
    url.searchParams.set('source', 'forum');
    url.searchParams.set('sort', 'cdate:desc');
    return url.toString();
  }

  function extractTitle() {
    const h1 = document.querySelector('h1.title');
    if (!h1) return null;
    const clone = h1.cloneNode(true);
    const label = clone.querySelector('.descriptor');
    if (label) label.remove();
    return clone.textContent.trim().replace(/\s+/g, ' ');
  }

  function findRightColumn() {
    return document.querySelector('.full-text') || document.querySelector('#abs .full-text');
  }

  function findAccessPaperHeading() {
    const scope = document.querySelector('.full-text') || document;
    for (const el of Array.from(scope.querySelectorAll('*'))) {
      if (el.childElementCount !== 0) continue;
      const t = (el.textContent || '').trim().toLowerCase();
      if (t === 'access paper:' || t === 'access paper') return el;
    }
    return null;
  }

  function findMountFallback() {
    return document.querySelector('h1.title')?.parentElement || document.body;
  }

  function createBox(searchUrl) {
    const div = document.createElement('div');
    div.className = 'orlink-box';

    const logoUrl = 'https://avatars.githubusercontent.com/u/4711862?s=280&v=4';

    div.innerHTML = `
      <div class=\"orlink-header\">
        <div class=\"orlink-header-left\">
          <img class=\"orlink-logo\" src=\"${logoUrl}\" alt=\"OpenReview\" />
          <div class=\"orlink-headtext\">
          <div class="orlink-titletext">OpenReview</div>
          <div class="orlink-status">Searching…</div>
          </div>
        </div>
        <button class=\"orlink-refresh-btn\" type=\"button\" title=\"Refresh OpenReview search\" aria-label=\"Refresh OpenReview search\">${iconRefresh()}</button>
      </div>
      <div class=\"orlink-actions\" aria-live="polite">
        <a class="orlink-btn" target="_blank" rel="noreferrer" href="${escapeAttr(searchUrl)}">Search OpenReview</a>
      </div>
      <div class="orlink-versions" style="display:none"></div>
    `;
    return div;
  }

  function renderResult(box, result, cached, fallbackSearchUrl) {
    const status = box.querySelector('.orlink-status');
    const actions = box.querySelector('.orlink-actions');
    const versions = box.querySelector('.orlink-versions');

    const sUrl = result?.searchUrl || fallbackSearchUrl || 'https://openreview.net/search';

    if (!result?.found) {
      status.textContent = cached ? 'Not found (cached)' : 'Not found';
      actions.innerHTML = `<a class="orlink-btn" target="_blank" rel="noreferrer" href="${escapeAttr(sUrl)}">Search OpenReview</a>`;
      versions.style.display = 'none';
      versions.innerHTML = '';
      return;
    }

    status.textContent = cached ? 'Found (cached)' : 'Found';

    actions.innerHTML = `
      <a class="orlink-btn primary" target="_blank" rel="noreferrer" href="${escapeAttr(result.forumUrl)}">Open Forum</a>
      <a class="orlink-btn" target="_blank" rel="noreferrer" href="${escapeAttr(sUrl)}">Search OpenReview</a>
    `;

    const vers = Array.isArray(result.versions) ? result.versions : [];
    if (vers.length) {
      versions.style.display = 'block';
      versions.innerHTML = `
        <div class="orlink-versions-title">Versions</div>
        <ul class="orlink-versions-list">
          ${vers.map(v => `
            <li>
              <div class="orlink-version-row">
                <a class="orlink-version" target="_blank" rel="noreferrer" href="${escapeAttr(v.forumUrl)}">${escapeHtml(v.label || v.forumId)}</a>
                <button class="orlink-cite-btn" type="button" data-forum-id="${escapeHtml(v.forumId || '')}" title="Copy BibTeX" aria-label="Copy BibTeX">${iconQuote()}</button>
              </div>
            </li>
          `).join('')}
        </ul>
      `;
    } else {
      versions.style.display = 'none';
      versions.innerHTML = '';
    }
  }

  function renderError(box, message) {
    const status = box.querySelector('.orlink-status');
    const actions = box.querySelector('.orlink-actions');
    status.textContent = 'Error';
    actions.innerHTML = `<div class="orlink-error">${escapeHtml(message)}</div>`;
  }

  function iconQuote() {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M7.2 6C4.9 6 3 7.9 3 10.2V18h7v-7H6.6v-.8c0-.9.7-1.6 1.6-1.6H10V6H7.2zm9.6 0c-2.3 0-4.2 1.9-4.2 4.2V18h7v-7h-3.4v-.8c0-.9.7-1.6 1.6-1.6H20V6h-3.2z"/>
      </svg>`;
  }

  function iconSpinner() {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 4a8 8 0 1 0 8 8h-2a6 6 0 1 1-6-6V4z"/>
      </svg>`;
  }

  function iconCheck() {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/>
      </svg>`;
  }

  function iconRefresh() {
    return `
      <svg viewBox=\"0 0 24 24\" aria-hidden=\"true\">
        <path d=\"M18.36 5.64A8.95 8.95 0 0012 3C7.03 3 3 7.03 3 12h2a7 7 0 017-7c1.77 0 3.39.66 4.62 1.74L14 9h7V2l-2.64 2.64zM21 12h-2a7 7 0 01-7 7c-1.77 0-3.39-.66-4.62-1.74L10 15H3v7l2.64-2.64A8.95 8.95 0 0012 21c4.97 0 9-4.03 9-9z\"></path>
      </svg>`;
  }

  function setRefreshState(btn, state) {
    if (!btn) return;
    btn.classList.remove('loading');
    if (state === 'loading') btn.classList.add('loading');
    if (!btn.innerHTML) btn.innerHTML = iconRefresh();
  }

  function extractArxivId() {
    try {
      const m = location.pathname.match(/^\/abs\/([^\/?#]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    } catch {
      return '';
    }
  }

  function setBtnState(btn, state) {
    btn.classList.remove('loading', 'done');
    if (state === 'loading') {
      btn.classList.add('loading');
      btn.innerHTML = iconSpinner();
    } else if (state === 'done') {
      btn.classList.add('done');
      btn.innerHTML = iconCheck();
    } else {
      btn.innerHTML = iconQuote();
    }
  }

  async function copyTextToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    }
  }

  function getForumIdFromRow(btn) {
    const direct = (btn.getAttribute('data-forum-id') || '').trim();
    if (direct) return direct;
    // fallback: parse from sibling link
    const row = btn.closest('.orlink-version-row');
    const a = row ? row.querySelector('a[href*="openreview.net/forum?id="]') : null;
    if (!a) return '';
    try {
      return new URL(a.getAttribute('href')).searchParams.get('id') || '';
    } catch {
      const m = (a.getAttribute('href') || '').match(/forum\?id=([^&]+)/);
      return m ? m[1] : '';
    }
  }

  document.addEventListener('click', (ev) => {
    const refresh = ev.target.closest && ev.target.closest('.orlink-refresh-btn');
    if (refresh) {
      ev.preventDefault();
      ev.stopPropagation();
      triggerLookup(true);
      return;
    }

    const btn = ev.target.closest && ev.target.closest('.orlink-cite-btn');
    if (!btn) return;

    ev.preventDefault();
    ev.stopPropagation();

    const forumId = getForumIdFromRow(btn);
    if (!forumId) {
      setBtnState(btn, 'idle');
      return;
    }

    setBtnState(btn, 'loading');

    chrome.runtime.sendMessage({ type: 'FETCH_BIBTEX', forumId }, async (resp) => {
      if (chrome.runtime.lastError || !resp?.ok) {
        setBtnState(btn, 'idle');
        return;
      }

      const bibtex = resp.bibtex || '';
      const ok = await copyTextToClipboard(bibtex);
      if (!ok) {
        setBtnState(btn, 'idle');
        return;
      }

      setBtnState(btn, 'done');
      setTimeout(() => setBtnState(btn, 'idle'), 2500);
    });
  }, true);

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;');
  }

  // Provide page info to the extension popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'ORLINK_GET_PAGE_INFO') {
      sendResponse({ title: extractTitle(), arxivId: extractArxivId(), url: location.href });
      return true;
    }
  });

})();
