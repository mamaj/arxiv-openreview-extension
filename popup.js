// popup.js (v1.7.4.6)
(async function () {
  const root = document.getElementById('root');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';

  if (!/^https:\/\/arxiv\.org\/abs\//.test(url)) {
    root.innerHTML = `<div class="orlink-box"><div class="orlink-status">Open an arXiv abstract page (arxiv.org/abs/...) and click the icon again.</div></div>`;
    return;
  }

  const info = await chrome.tabs.sendMessage(tab.id, { type: 'ORLINK_GET_PAGE_INFO' }).catch(() => null);
  const title = info?.title || '';
  const arxivId = info?.arxivId || '';
  const searchUrl = buildSearchUrl(title);
  const box = createBox(searchUrl);
  root.appendChild(box);

  triggerLookup(false);

  function triggerLookup(forceRefresh) {
    const status = box.querySelector('.orlink-status');
    const actions = box.querySelector('.orlink-actions');
    const versions = box.querySelector('.orlink-versions');
    const refreshBtn = box.querySelector('.orlink-refresh-btn');

    if (status) status.textContent = 'Searching…';
    if (actions) actions.innerHTML = `<a class="orlink-btn" target="_blank" rel="noreferrer" href="${escapeAttr(searchUrl)}">Search OpenReview</a>`;
    if (versions) { versions.style.display = 'none'; versions.innerHTML = ''; }
    setRefreshState(refreshBtn, 'loading');

    chrome.runtime.sendMessage({ type: 'LOOKUP_OPENREVIEW', title, arxivId, forceRefresh: !!forceRefresh }, async (resp) => {
      if (chrome.runtime.lastError) { renderError(box, chrome.runtime.lastError.message); setRefreshState(refreshBtn,'idle'); return; }
      if (!resp?.ok) { renderError(box, resp?.error || 'Unknown error'); setRefreshState(refreshBtn,'idle'); return; }
      renderResult(box, resp.result, resp.cached, searchUrl);
      setRefreshState(refreshBtn,'idle');
    });
  }

  document.addEventListener('click', (ev) => {
    const refresh = ev.target.closest && ev.target.closest('.orlink-refresh-btn');
    if (refresh) { ev.preventDefault(); ev.stopPropagation(); triggerLookup(true); return; }

    const btn = ev.target.closest && ev.target.closest('.orlink-cite-btn');
    if (!btn) return;
    ev.preventDefault(); ev.stopPropagation();
    const forumId = (btn.getAttribute('data-forum-id') || '').trim();
    if (!forumId) return;
    btn.classList.add('loading');
    chrome.runtime.sendMessage({ type: 'FETCH_BIBTEX', forumId }, async (resp) => {
      btn.classList.remove('loading');
      if (chrome.runtime.lastError || !resp?.ok) return;
      await navigator.clipboard.writeText(resp.bibtex || '');
      btn.classList.add('done');
      setTimeout(() => btn.classList.remove('done'), 1500);
    });
  }, true);

  function buildSearchUrl(t) {
    const u = new URL('https://openreview.net/search');
    u.searchParams.set('term', t || '');
    u.searchParams.set('content', 'title');
    u.searchParams.set('group', 'all');
    u.searchParams.set('source', 'forum');
    u.searchParams.set('sort', 'cdate:desc');
    return u.toString();
  }

  function createBox(searchUrl) {
    const div = document.createElement('div');
    div.className = 'orlink-box';
    const logoUrl = 'https://avatars.githubusercontent.com/u/4711862?s=280&v=4';
    div.innerHTML = `
      <div class="orlink-header">
        <div class="orlink-header-left">
          <img class="orlink-logo" src="${logoUrl}" alt="OpenReview" />
          <div class="orlink-headtext">
            <div class="orlink-titletext">OpenReview</div>
            <div class="orlink-status">Searching…</div>
          </div>
        </div>
        <button class="orlink-refresh-btn" type="button" title="Refresh OpenReview search">${iconRefresh()}</button>
      </div>
      <div class="orlink-actions" aria-live="polite">
        <a class="orlink-btn" target="_blank" rel="noreferrer" href="${escapeAttr(searchUrl)}">Search OpenReview</a>
      </div>
      <div class="orlink-versions" style="display:none"></div>`;
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
      versions.style.display = 'none'; versions.innerHTML = '';
      return;
    }

    status.textContent = cached ? 'Found (cached)' : 'Found';
    actions.innerHTML = `<a class="orlink-btn primary" target="_blank" rel="noreferrer" href="${escapeAttr(result.forumUrl)}">Open Forum</a>
<a class="orlink-btn" target="_blank" rel="noreferrer" href="${escapeAttr(sUrl)}">Search OpenReview</a>`;

    const vers = Array.isArray(result.versions) ? result.versions : [];
    if (!vers.length) { versions.style.display='none'; versions.innerHTML=''; return; }

    versions.style.display = 'block';
    versions.innerHTML = `<div class="orlink-versions-title">Versions</div><ul class="orlink-versions-list">${vers.map(v=>`<li><div class="orlink-version-row"><a class="orlink-version" target="_blank" rel="noreferrer" href="${escapeAttr(v.forumUrl)}">${escapeHtml(v.label||v.forumId)}</a><button class="orlink-cite-btn" data-forum-id="${escapeAttr(v.forumId||'')}" title="Copy BibTeX">${iconQuote()}</button></div></li>`).join('')}</ul>`;
  }

  function renderError(box, msg) {
    const status = box.querySelector('.orlink-status');
    status.textContent = 'Error: ' + msg;
  }

  function iconRefresh() {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.36 5.64A8.95 8.95 0 0012 3C7.03 3 3 7.03 3 12h2a7 7 0 017-7c1.77 0 3.39.66 4.62 1.74L14 9h7V2l-2.64 2.64zM21 12h-2a7 7 0 01-7 7c-1.77 0-3.39-.66-4.62-1.74L10 15H3v7l2.64-2.64A8.95 8.95 0 0012 21c4.97 0 9-4.03 9-9z"></path></svg>`;
  }
  function iconQuote() {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.17 6A5 5 0 002 11v7h7v-7H6.5a2.5 2.5 0 012.45-2.5H9V6H7.17zm10 0A5 5 0 0012 11v7h7v-7h-2.5a2.5 2.5 0 012.45-2.5H19V6h-1.83z"></path></svg>`;
  }
  function setRefreshState(btn, state) {
    if (!btn) return;
    btn.classList.remove('loading');
    if (state === 'loading') btn.classList.add('loading');
    if (!btn.innerHTML) btn.innerHTML = iconRefresh();
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function escapeAttr(s) { return String(s).replace(/"/g,'&quot;'); }
})();
