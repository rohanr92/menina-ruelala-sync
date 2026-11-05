/* Rue La La inventory sync — embedded admin UI (no build step). */
(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const view = $('#view');
  const state = { tab: 'overview', overview: null, skus: { filter: 'all', search: '', page: 1 }, history: { kind: '', status: '', page: 1 }, preview: null };
  let pollTimer = null;

  /* ---------- helpers ---------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
  const plural = (n, w) => `${num(n)} ${w}${Number(n) === 1 ? '' : 's'}`;

  function fmtDate(d, opts = {}) {
    if (!d) return '—';
    return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...opts });
  }
  function fmtET(d) {
    return new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }) + ' ET';
  }
  function ago(d) {
    if (!d) return 'Never';
    const s = Math.round((Date.now() - new Date(d)) / 1000);
    if (s < 45) return 'Just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }
  function until(d) {
    if (!d) return '';
    const s = Math.max(0, Math.round((new Date(d) - Date.now()) / 1000));
    if (s < 60) return `in ${s}s`;
    if (s < 3600) return `in ${Math.round(s / 60)} min`;
    const h = Math.floor(s / 3600); const m = Math.round((s % 3600) / 60);
    return `in ${h} h${m ? ` ${m} min` : ''}`;
  }
  function duration(a, b) {
    if (!a || !b) return '';
    const ms = new Date(b) - new Date(a);
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
  }
  const kindLabel = (k) => (k === 'full' ? 'Full inventory' : 'Changed SKUs');
  const triggerLabel = (t) => ({ schedule: 'Scheduled', webhook: 'Inventory change', manual: 'Manual' }[t] || t);
  function statusBadge(s) {
    if (s === 'success') return '<span class="badge success">Sent</span>';
    if (s === 'failed') return '<span class="badge critical">Failed</span>';
    if (s === 'running') return '<span class="badge info"><span class="spinner" style="width:10px;height:10px;border-width:1.5px"></span> Sending</span>';
    return `<span class="badge">${esc(s)}</span>`;
  }

  function toast(msg, isError = false) {
    if (window.shopify?.toast) { window.shopify.toast.show(msg, { isError }); return; }
    const t = $('#toast');
    t.textContent = msg; t.className = `toast${isError ? ' error' : ''}`; t.hidden = false;
    clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, 3500);
  }

  async function authHeaders() {
    if (window.__DEV__ || !window.shopify?.idToken) return {};
    return { Authorization: `Bearer ${await window.shopify.idToken()}` };
  }
  async function api(path, { method = 'GET', body, raw = false } = {}) {
    const headers = await authHeaders();
    let payload = body;
    if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(`/api${path}`, { method, headers, body: payload });
    if (raw) { if (!res.ok) throw new Error(`Download failed (${res.status})`); return res; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
  async function download(path, fallbackName) {
    try {
      const res = await api(path, { raw: true });
      const blob = await res.blob();
      const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || fallbackName;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { toast(e.message, true); }
  }

  function busy(btn, on, label) {
    if (!btn) return;
    if (on) { btn._html = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>${label ? ` ${esc(label)}` : ''}`; }
    else { btn.disabled = false; if (btn._html) btn.innerHTML = btn._html; }
  }

  /* ---------- routing ---------- */
  const TABS = ['overview', 'skus', 'import', 'history', 'settings'];
  function tabFromPath() {
    const p = location.pathname.replace(/^\/|\/$/g, '');
    return TABS.includes(p) ? p : 'overview';
  }
  function go(tab, push = true) {
    state.tab = tab;
    if (push) history.pushState({}, '', `/${tab === 'overview' ? '' : tab}${location.search}`);
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    clearInterval(pollTimer);
    render();
  }
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) go(b.dataset.tab); });
  window.addEventListener('popstate', () => go(tabFromPath(), false));

  function render() {
    renderHeaderActions();
    ({ overview: renderOverview, skus: renderSkus, import: renderImport, history: renderHistory, settings: renderSettings })[state.tab]();
  }

  function loading(rows = 3) {
    view.innerHTML = `<div class="card"><div class="card-body">${Array.from({ length: rows }, (_, i) => `<div class="skeleton" style="width:${90 - i * 15}%;margin:10px 0"></div>`).join('')}</div></div>`;
  }

  /* ---------- header ---------- */
  function renderHeaderActions() {
    const o = state.overview;
    const el = $('#page-actions');
    const pending = o?.instant?.pending || 0;
    const running = Boolean(o?.running);
    el.innerHTML = `
      <button class="btn" id="btn-changes" ${!pending || running ? 'disabled' : ''}>Send changes now${pending ? ` (${num(pending)})` : ''}</button>
      <button class="btn btn-primary" id="btn-full" ${running ? 'disabled' : ''}>${running ? '<span class="spinner"></span> Syncing…' : 'Run full sync'}</button>`;
    $('#btn-full').onclick = (e) => triggerSync('full', e.currentTarget);
    $('#btn-changes').onclick = (e) => triggerSync('changes', e.currentTarget);
  }

  async function triggerSync(kind, btn) {
    busy(btn, true, 'Starting…');
    try {
      const r = await api('/sync', { method: 'POST', body: { kind } });
      if (r.started === false) { toast(r.message); busy(btn, false); return; }
      toast(kind === 'full' ? 'Full inventory sync started' : 'Sending changed SKUs');
      await refreshOverview();
      if (state.tab !== 'overview') go('overview');
      startPolling(true);
    } catch (e) { toast(e.message, true); busy(btn, false); }
  }

  async function refreshOverview() {
    state.overview = await api('/overview');
    const o = state.overview;
    $('#page-sub').innerHTML = `Menina Step → Rue La La · SFTP <span class="mono">${esc(o.sftpHost || '')}</span>`;
    renderHeaderActions();
    return o;
  }

  function startPolling(fast = false) {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const wasRunning = Boolean(state.overview?.running);
        await refreshOverview();
        if (state.tab === 'overview') drawOverview();
        if (wasRunning && !state.overview.running) {
          const last = [state.overview.lastFull, state.overview.lastChanges].filter(Boolean).sort((a, b) => new Date(b.started_at) - new Date(a.started_at))[0];
          if (last?.status === 'failed') toast(`Sync failed: ${last.error || 'unknown error'}`, true);
          else if (last) toast(`Sent ${plural(last.row_count, 'SKU')} to Rue La La`);
          startPolling(false);
        }
      } catch { /* keep polling */ }
    }, fast ? 2500 : 15000);
  }

  /* ---------- overview ---------- */
  async function renderOverview() {
    if (!state.overview) loading(5);
    try { await refreshOverview(); drawOverview(); startPolling(Boolean(state.overview.running)); }
    catch (e) { view.innerHTML = errorBanner(e.message); }
  }

  function errorBanner(msg) {
    return `<div class="banner critical"><div class="icon">!</div><div class="grow"><div class="banner-title">Something went wrong</div><div>${esc(msg)}</div></div></div>`;
  }

  function lastRunTile(title, run, emptyText) {
    if (!run) return `<div class="card tile"><div class="tile-label"><span class="dot"></span>${title}</div><div class="tile-value">Never</div><div class="tile-meta">${emptyText}</div></div>`;
    const ok = run.status === 'success';
    const dot = run.status === 'running' ? 'live' : ok ? 'ok' : 'bad';
    return `<div class="card tile">
      <div class="tile-label"><span class="dot ${dot}"></span>${title}</div>
      <div class="tile-value">${run.status === 'running' ? 'Sending…' : ago(run.started_at)}</div>
      <div class="tile-meta">${ok ? `${plural(run.row_count, 'SKU')} · ${fmtDate(run.started_at)}` : run.status === 'failed' ? `<span style="color:var(--critical)">Failed</span> · ${fmtDate(run.started_at)}` : triggerLabel(run.trigger)}</div>
    </div>`;
  }

  function drawOverview() {
    const o = state.overview; if (!o) return;
    const c = o.catalog;
    const banners = [];
    if (o.running) banners.push(`<div class="banner info"><div class="icon"><span class="spinner" style="width:12px;height:12px;border-width:2px"></span></div><div class="grow"><div class="banner-title">${o.running.kind === 'full' ? 'Full inventory sync in progress' : 'Sending changed SKUs'}</div><div>Started ${ago(o.running.startedAt).toLowerCase()} · ${triggerLabel(o.running.trigger)}. This page updates automatically.</div></div></div>`);
    if (o.paused) banners.push(`<div class="banner warning"><div class="icon">!</div><div class="grow"><div class="banner-title">Syncing is paused</div><div>Scheduled and instant syncs are off. Rue La La keeps the last stock you sent. Manual syncs still work.</div></div><button class="btn" data-act="resume">Resume syncing</button></div>`);
    if (!o.sftpConfigured) banners.push(`<div class="banner warning"><div class="icon">!</div><div class="grow"><div class="banner-title">Add the SFTP password to start sending files</div><div>Files can't be delivered to VendorNet until the SFTP login is complete.</div></div><button class="btn" data-go="settings">Open settings</button></div>`);
    if (!c.mappings) banners.push(`<div class="banner info"><div class="icon">i</div><div class="grow"><div class="banner-title">Upload your Rue La La SKU list</div><div>The app needs each Host SKU's Supplier SKU (e.g. SI-NA-CH) before it can build the file. Upload your current Rue La La export (CSV or Excel).</div></div><button class="btn" data-go="import">Add SKUs</button></div>`);
    if (o.lastFailed && !o.running) {
      const newerOk = [o.lastFull, o.lastChanges].some((r) => r && r.status === 'success' && new Date(r.started_at) > new Date(o.lastFailed.started_at));
      if (!newerOk) banners.push(`<div class="banner critical"><div class="icon">!</div><div class="grow"><div class="banner-title">Last sync failed ${ago(o.lastFailed.started_at).toLowerCase()}</div><div class="mono small" style="margin-top:2px">${esc(o.lastFailed.error)}</div></div><button class="btn" data-go="history">View history</button></div>`);
    }
    if (c.refreshedAt == null && c.shopifyVariants === 0) banners.push(`<div class="banner info"><div class="icon"><span class="spinner" style="width:12px;height:12px;border-width:2px"></span></div><div class="grow"><div class="banner-title">Loading your Shopify products</div><div>Reading every variant whose SKU starts with ${esc(o.skuPrefix || '1311')}. This takes under a minute.</div></div></div>`);

    const next = o.schedule.next;
    const nextTile = `<div class="card tile">
      <div class="tile-label"><span class="dot ${o.schedule.enabled && !o.paused ? 'ok' : ''}"></span>Next full sync</div>
      <div class="tile-value">${next ? fmtET(next) : 'Off'}</div>
      <div class="tile-meta">${next ? `${until(next)} · ${fmtDate(next, { month: undefined, day: undefined })} your time` : o.paused ? 'Paused' : 'Schedule disabled'}</div>
    </div>`;
    const pending = o.instant.pending;
    const pendingTile = `<div class="card tile">
      <div class="tile-label"><span class="dot ${!o.instant.enabled ? '' : pending ? 'warn' : 'ok'}"></span>Instant sync</div>
      <div class="tile-value">${!o.instant.enabled ? 'Off' : pending ? `${plural(pending, 'SKU')} waiting` : 'Up to date'}</div>
      <div class="tile-meta">${!o.instant.enabled ? 'Changes go out with the next full sync' : pending && o.instant.dueAt ? `Sending ${until(o.instant.dueAt)}` : `Sends ${o.instant.mode === 'full' ? 'the full file' : 'changed SKUs'} ${Math.round(o.instant.debounceSeconds / 60) || 1} min after a change`}</div>
    </div>`;

    const recent = o.recent.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Time</th><th>Type</th><th>Triggered by</th><th class="num">SKUs</th><th class="num">Units</th><th>Status</th><th></th></tr></thead>
      <tbody>${o.recent.map((r) => `<tr>
        <td>${fmtDate(r.started_at)}<div class="sub">${ago(r.started_at)}</div></td>
        <td>${kindLabel(r.kind)}</td><td>${triggerLabel(r.trigger)}</td>
        <td class="num">${num(r.row_count)}</td><td class="num">${num(r.units)}</td>
        <td>${statusBadge(r.status)}${r.status === 'failed' ? `<div class="sub" title="${esc(r.error)}" style="max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.error)}</div>` : ''}</td>
        <td class="num">${r.filename && r.status !== 'running' ? `<button class="btn btn-plain btn-sm" data-dl="${r.id}" data-name="${esc(r.filename)}">Download</button>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>`
      : `<div class="empty"><span class="strong">No syncs yet</span>Run a full sync to send your first inventory file to Rue La La.</div>`;

    const s24 = o.stats24h;
    view.innerHTML = `
      ${banners.join('')}
      <div class="grid grid-4">
        ${lastRunTile('Last full sync', o.lastFull, 'Runs twice a day')}
        ${lastRunTile('Last instant sync', o.lastChanges, 'Runs when stock changes')}
        ${nextTile}
        ${pendingTile}
      </div>

      <div class="card">
        <div class="card-head"><h2 class="card-title">What Rue La La receives</h2>
          <span class="muted small">Shopify catalog read ${c.refreshedAt ? ago(c.refreshedAt).toLowerCase() : '—'} · <button class="btn btn-plain btn-sm" data-act="refresh-catalog">Refresh</button></span></div>
        <div class="card-body tight" style="margin-top:10px;border-top:1px solid var(--border)">
          <div class="metrics">
            <div class="metric"><div class="v">${num(c.sending)}</div><div class="l">SKUs in each full file${c.zeroMissing && c.missingInShopify ? ` <span class="subtle">(${num(c.fromShopify)} + ${num(c.missingInShopify)} at 0)</span>` : ''}</div><a href="#" data-skus="ok">View</a></div>
            <div class="metric"><div class="v">${num(c.inStock)}</div><div class="l">In stock</div><a href="#" data-skus="instock">View</a></div>
            <div class="metric"><div class="v">${num(c.units)}</div><div class="l">Units available</div></div>
            <div class="metric"><div class="v" style="${c.unmapped ? 'color:var(--critical)' : ''}">${num(c.unmapped)}</div><div class="l">In Shopify, no Supplier SKU</div>${c.unmapped ? '<a href="#" data-skus="unmapped">Fix</a>' : '<span class="small subtle">All mapped</span>'}</div>
            <div class="metric"><div class="v">${num(c.missingInShopify)}</div><div class="l">Mapped, not in Shopify</div>${c.missingInShopify ? `<span class="small ${c.zeroMissing ? 'muted' : 'subtle'}">${c.zeroMissing ? 'Sent as 0' : 'Not sent'}</span> · <a href="#" data-skus="missing">View</a>` : '<span class="small subtle">None</span>'}</div>
          </div>
        </div>
        ${c.duplicates || c.negatives ? `<div class="card-foot"><span>${c.duplicates ? `${plural(c.duplicates, 'SKU')} used on more than one Shopify variant (only the first is sent). ` : ''}${c.negatives ? `${plural(c.negatives, 'SKU')} with negative stock in Shopify, sent as 0.` : ''}</span>${c.duplicates ? '<a href="#" data-skus="duplicate">Review</a>' : ''}</div>` : ''}
      </div>

      <div class="card">
        <div class="card-head"><h2 class="card-title">Recent activity</h2><span class="muted small">Last 24 h: ${num(s24.ok)} sent${s24.failed ? `, <span style="color:var(--critical)">${num(s24.failed)} failed</span>` : ''} · ${num(s24.instant)} instant updates (${plural(s24.instant_rows, 'SKU')})</span></div>
        <div class="card-body tight" style="margin-top:10px;border-top:1px solid var(--border)">${recent}</div>
        ${o.recent.length ? '<div class="card-foot"><span></span><button class="btn btn-plain" data-go="history">View all syncs</button></div>' : ''}
      </div>`;
  }

  view.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-go],[data-skus],[data-dl],[data-act]');
    if (!t) return;
    e.preventDefault();
    if (t.dataset.go) go(t.dataset.go);
    else if (t.dataset.skus) { state.skus = { filter: t.dataset.skus, search: '', page: 1 }; go('skus'); }
    else if (t.dataset.dl) download(`/runs/${t.dataset.dl}/csv`, t.dataset.name);
    else if (t.dataset.act === 'refresh-catalog') {
      busy(t, true);
      try { const r = await api('/catalog/refresh', { method: 'POST' }); toast(`Read ${plural(r.variants, 'variant')} from Shopify`); await refreshOverview(); drawOverview(); }
      catch (err) { toast(err.message, true); busy(t, false); }
    } else if (t.dataset.act === 'resume') {
      await api('/settings', { method: 'PUT', body: { paused: false } }); toast('Syncing resumed'); renderOverview();
    }
  });

  /* ---------- SKUs ---------- */
  async function renderSkus() {
    const s = state.skus;
    const qs = new URLSearchParams({ filter: s.filter, search: s.search, page: s.page });
    if (!view.querySelector('#sku-card')) loading(6);
    let data;
    try { data = await api(`/skus?${qs}`); } catch (e) { view.innerHTML = errorBanner(e.message); return; }
    const f = [['all', 'All', data.counts.all], ['ok', 'Sending', data.counts.ok], ['instock', 'In stock', data.counts.instock], ['unmapped', 'No Supplier SKU', data.counts.unmapped], ['missing', 'Not in Shopify', data.counts.missing]];
    if (data.counts.duplicate) f.push(['duplicate', 'Duplicate SKU', data.counts.duplicate]);
    const badge = (i) => ({
      ok: i.pending ? '<span class="badge attention">Change waiting</span>' : '<span class="badge success">Sending</span>',
      unmapped: '<span class="badge critical">No Supplier SKU</span>',
      missing: state.overview?.catalog?.zeroMissing === false ? '<span class="badge warning">Not in Shopify · not sent</span>' : '<span class="badge warning">Not in Shopify · sent as 0</span>',
      duplicate: '<span class="badge warning">Duplicate</span>',
    }[i.status]);
    const rows = data.items.map((i) => `<tr>
      <td>${i.supplierSku ? `<span class="strong">${esc(i.supplierSku)}</span>` : `<div class="inline-edit"><input type="text" placeholder="e.g. SI-NA-CH" data-host="${esc(i.hostSku)}"><button class="btn btn-sm" data-save="${esc(i.hostSku)}">Save</button></div>`}</td>
      <td class="mono">${esc(i.hostSku)}</td>
      <td>${esc(i.product || i.description || '—')}${i.variant && i.variant !== 'Default Title' ? `<div class="sub">${esc(i.variant)}</div>` : ''}</td>
      <td class="num">${i.qty == null ? '—' : num(i.qty)}${i.rawQty < 0 ? `<div class="sub">Shopify: ${i.rawQty}</div>` : ''}</td>
      <td>${badge(i)}</td>
    </tr>`).join('');
    const pages = Math.max(1, Math.ceil(data.total / data.per));
    view.innerHTML = `<div class="card" id="sku-card">
      <div class="filters">
        <div class="pills">${f.map(([k, l, n]) => `<button class="pill ${s.filter === k ? 'active' : ''}" data-filter="${k}">${l}<span class="n">${num(n)}</span></button>`).join('')}</div>
        <input type="search" class="search" id="sku-search" placeholder="Search Supplier SKU, Host SKU or product" value="${esc(s.search)}">
        <button class="btn" id="btn-export">Export mapping</button>
      </div>
      ${data.items.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Vendor SKU (Supplier SKU)</th><th>Host SKU</th><th>Shopify product</th><th class="num">Qty sent</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
        <div class="pager"><span>${num((data.page - 1) * data.per + 1)}–${num(Math.min(data.page * data.per, data.total))} of ${num(data.total)}</span>
          <span><button class="btn btn-sm" id="pg-prev" ${data.page <= 1 ? 'disabled' : ''}>Previous</button> <button class="btn btn-sm" id="pg-next" ${data.page >= pages ? 'disabled' : ''}>Next</button></span></div>`
      : `<div class="empty"><span class="strong">No SKUs match</span>${s.search ? 'Try a different search.' : s.filter === 'unmapped' ? 'Every Shopify SKU starting with 1311 has a Supplier SKU.' : 'Nothing here yet.'}</div>`}
    </div>`;
    view.querySelectorAll('[data-filter]').forEach((b) => { b.onclick = () => { s.filter = b.dataset.filter; s.page = 1; renderSkus(); }; });
    const search = $('#sku-search'); let h;
    search.oninput = () => { clearTimeout(h); h = setTimeout(() => { s.search = search.value; s.page = 1; renderSkus().then(() => { const el = $('#sku-search'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }); }, 300); };
    $('#btn-export').onclick = () => download('/mappings/export', 'ruelala-sku-mapping.csv');
    if ($('#pg-prev')) { $('#pg-prev').onclick = () => { s.page--; renderSkus(); }; $('#pg-next').onclick = () => { s.page++; renderSkus(); }; }
    view.querySelectorAll('[data-save]').forEach((b) => {
      b.onclick = async () => {
        const input = view.querySelector(`input[data-host="${b.dataset.save}"]`);
        if (!input.value.trim()) { input.focus(); return; }
        busy(b, true);
        try { await api(`/mappings/${b.dataset.save}`, { method: 'PUT', body: { supplier_sku: input.value.trim() } }); toast('Supplier SKU saved — it will go out with the next sync'); renderSkus(); }
        catch (e) { toast(e.message, true); busy(b, false); }
      };
    });
  }

  /* ---------- Import ---------- */
  function renderImport() {
    if (state.preview) return drawPreview();
    view.innerHTML = `<div class="layout">
      <div>
        <div class="card"><div class="card-head"><h2 class="card-title">Add or update Rue La La SKUs</h2></div>
          <div class="card-body">
            <p class="muted" style="margin-top:0">Upload the SKU list Rue La La gives you for new or upcoming styles. The app matches each <b>Host SKU</b> to the Shopify variant with the same SKU and uses the <b>Supplier SKU</b> as the Vendor SKU in the file.</p>
            <div class="drop" id="drop">
              <div class="file-icon">⇪</div>
              <div class="big">Drop a file here or click to choose</div>
              <div class="muted">CSV or Excel (.xlsx). PDF works for simple tables.</div>
              <input type="file" id="file" accept=".csv,.xlsx,.xlsm,.pdf,.txt" hidden>
            </div>
          </div>
        </div>
      </div>
      <div>
        <div class="card"><div class="card-head"><h2 class="card-title">What the file needs</h2></div>
          <div class="card-body">
            <dl class="kv">
              <dt>Host SKU</dt><dd>Required. The 14-digit Rue La La SKU, e.g. <span class="mono">13110247670000</span></dd>
              <dt>Supplier SKU</dt><dd>Required. Your style code, e.g. <span class="mono">SI-NA-CH</span>. "Vendor SKU" column also works.</dd>
              <dt>Description</dt><dd>Optional.</dd>
            </dl>
            <div class="divider"></div>
            <div class="small muted">Existing SKUs in the file are updated; nothing is deleted. You'll see a preview before anything is saved. New SKUs go to Rue La La with the next instant sync.</div>
          </div>
        </div>
      </div>
    </div>`;
    const drop = $('#drop'); const input = $('#file');
    drop.onclick = () => input.click();
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]); };
    input.onchange = () => input.files[0] && uploadFile(input.files[0]);
  }

  async function uploadFile(file) {
    const drop = $('#drop');
    drop.innerHTML = `<span class="spinner"></span><div class="big">Reading ${esc(file.name)}…</div>`;
    const fd = new FormData(); fd.append('file', file);
    try { state.preview = await api('/mappings/preview', { method: 'POST', body: fd }); drawPreview(); }
    catch (e) { toast(e.message, true); renderImport(); }
  }

  function drawPreview() {
    const p = state.preview; const s = p.summary;
    const changeBadge = (r) => (r.change === 'new' ? '<span class="badge info">New</span>' : r.change === 'changed' ? `<span class="badge attention">Was ${esc(r.previous)}</span>` : '<span class="badge">No change</span>');
    const shown = p.rows.filter((r) => r.change !== 'same').concat(p.rows.filter((r) => r.change === 'same')).slice(0, 200);
    const toImport = s.new + s.changed;
    view.innerHTML = `
      ${p.errors.length ? `<div class="banner critical"><div class="icon">!</div><div class="grow"><div class="banner-title">${plural(p.errors.length, 'row')} can't be imported and will be skipped</div><ul class="clean">${p.errors.slice(0, 8).map((e) => `<li>${esc(e)}</li>`).join('')}${p.errors.length > 8 ? `<li>…and ${p.errors.length - 8} more</li>` : ''}</ul></div></div>` : ''}
      ${p.warnings.length ? `<div class="banner warning"><div class="icon">!</div><div class="grow"><div class="banner-title">Check before importing</div><ul class="clean">${p.warnings.slice(0, 6).map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div></div>` : ''}
      <div class="card">
        <div class="card-head"><div><h2 class="card-title">${esc(p.fileName)}</h2><div class="muted small">${esc(p.source)}${p.columns ? ` · columns used: <b>${esc(p.columns.host)}</b> → <b>${esc(p.columns.supplier)}</b>` : ''}</div></div>
          <div style="display:flex;gap:8px"><button class="btn" id="btn-cancel">Cancel</button><button class="btn btn-primary" id="btn-import" ${toImport ? '' : 'disabled'}>${toImport ? `Import ${plural(toImport, 'SKU')}` : 'Nothing to import'}</button></div></div>
        <div class="card-body tight" style="margin-top:12px;border-top:1px solid var(--border)">
          <div class="metrics">
            <div class="metric"><div class="v">${num(s.total)}</div><div class="l">SKUs in file</div></div>
            <div class="metric"><div class="v">${num(s.styles)}</div><div class="l">Styles</div></div>
            <div class="metric"><div class="v">${num(s.new)}</div><div class="l">New</div></div>
            <div class="metric"><div class="v">${num(s.changed)}</div><div class="l">Supplier SKU changed</div></div>
            <div class="metric"><div class="v">${num(s.notInShopify)}</div><div class="l">Not in Shopify yet</div></div>
          </div>
          <div class="table-wrap" style="border-top:1px solid var(--border)"><table>
            <thead><tr><th>Host SKU</th><th>Supplier SKU</th><th>Description</th><th>Change</th><th>In Shopify</th></tr></thead>
            <tbody>${shown.map((r) => `<tr><td class="mono">${esc(r.host_sku)}</td><td class="strong">${esc(r.supplier_sku)}</td><td>${esc(r.description || '—')}</td><td>${changeBadge(r)}</td><td>${r.inShopify ? '<span class="badge success">Found</span>' : '<span class="badge warning">Not yet</span>'}</td></tr>`).join('')}</tbody>
          </table></div>
          ${p.rows.length > shown.length ? `<div class="pager">Showing ${num(shown.length)} of ${num(p.rows.length)} rows</div>` : ''}
        </div>
      </div>
      ${s.notInShopify ? `<div class="banner info"><div class="icon">i</div><div class="grow">${plural(s.notInShopify, 'SKU')} aren't in Shopify yet. They're saved and start syncing automatically once a variant with that SKU is created in Shopify.</div></div>` : ''}`;
    $('#btn-cancel').onclick = () => { state.preview = null; renderImport(); };
    $('#btn-import').onclick = async (e) => {
      busy(e.currentTarget, true, 'Importing…');
      try {
        const rows = p.rows.filter((r) => r.change !== 'same').map(({ host_sku, supplier_sku, description }) => ({ host_sku, supplier_sku, description }));
        const r = await api('/mappings/import', { method: 'POST', body: { rows, source: p.fileName } });
        toast(`Imported ${plural(r.imported, 'SKU')}`);
        state.preview = null; state.skus = { filter: 'all', search: '', page: 1 };
        go('skus');
      } catch (err) { toast(err.message, true); busy(e.currentTarget, false); }
    };
  }

  /* ---------- History ---------- */
  async function renderHistory() {
    const h = state.history;
    if (!view.querySelector('#hist-card')) loading(6);
    let data;
    try { data = await api(`/runs?${new URLSearchParams(h)}`); } catch (e) { view.innerHTML = errorBanner(e.message); return; }
    const pages = Math.max(1, Math.ceil(data.total / data.per));
    const pill = (key, val, label) => `<button class="pill ${h[key] === val ? 'active' : ''}" data-h="${key}" data-v="${val}">${label}</button>`;
    view.innerHTML = `<div class="card" id="hist-card">
      <div class="filters">
        <div class="pills">${pill('kind', '', 'All types')}${pill('kind', 'full', 'Full inventory')}${pill('kind', 'changes', 'Changed SKUs')}</div>
        <span class="subtle">|</span>
        <div class="pills">${pill('status', '', 'Any status')}${pill('status', 'success', 'Sent')}${pill('status', 'failed', 'Failed')}</div>
      </div>
      ${data.runs.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Started</th><th>Type</th><th>Triggered by</th><th class="num">SKUs</th><th class="num">Units</th><th class="num">Took</th><th>Status</th><th>File</th></tr></thead>
        <tbody>${data.runs.map((r) => `<tr class="clickable" data-run="${r.id}">
          <td>${fmtDate(r.started_at)}<div class="sub">${ago(r.started_at)}</div></td>
          <td>${kindLabel(r.kind)}</td><td>${triggerLabel(r.trigger)}</td>
          <td class="num">${num(r.row_count)}</td><td class="num">${num(r.units)}</td><td class="num">${duration(r.started_at, r.finished_at)}</td>
          <td>${statusBadge(r.status)}</td>
          <td>${r.filename ? `<span class="mono small">${esc(r.filename)}</span>` : '<span class="subtle">—</span>'}</td>
        </tr>`).join('')}</tbody></table></div>
        <div class="pager"><span>${num(data.total)} syncs</span><span><button class="btn btn-sm" id="pg-prev" ${data.page <= 1 ? 'disabled' : ''}>Previous</button> <button class="btn btn-sm" id="pg-next" ${data.page >= pages ? 'disabled' : ''}>Next</button></span></div>`
      : '<div class="empty"><span class="strong">No syncs found</span>Syncs appear here as soon as a file is sent.</div>'}
    </div>`;
    view.querySelectorAll('[data-h]').forEach((b) => { b.onclick = () => { h[b.dataset.h] = b.dataset.v; h.page = 1; renderHistory(); }; });
    if ($('#pg-prev')) { $('#pg-prev').onclick = () => { h.page--; renderHistory(); }; $('#pg-next').onclick = () => { h.page++; renderHistory(); }; }
    view.querySelectorAll('tr[data-run]').forEach((tr) => {
      tr.onclick = async (e) => {
        if (e.target.closest('button')) return;
        const open = tr.nextElementSibling?.classList.contains('detail');
        view.querySelectorAll('tr.detail').forEach((d) => d.remove());
        if (open) return;
        const r = await api(`/runs/${tr.dataset.run}`);
        const d = document.createElement('tr'); d.className = 'detail';
        d.innerHTML = `<td colspan="8"><div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start">
          <dl class="kv" style="flex:1">
            <dt>Status</dt><dd>${statusBadge(r.status)}</dd>
            ${r.remote_path ? `<dt>Uploaded to</dt><dd class="mono">${esc(r.remote_path)}</dd>` : ''}
            ${r.error ? `<dt>Error</dt><dd class="mono" style="color:var(--critical)">${esc(r.error)}</dd>` : ''}
            <dt>Finished</dt><dd>${fmtDate(r.finished_at, { second: '2-digit' })}</dd>
            ${r.skus?.length ? `<dt>SKUs in file</dt><dd class="mono small">${r.skus.slice(0, 40).map(esc).join(', ')}${r.skus.length > 40 ? ` … +${r.skus.length - 40}` : ''}</dd>` : ''}
          </dl>
          ${r.filename ? `<button class="btn" data-dl="${r.id}" data-name="${esc(r.filename)}">Download CSV</button>` : ''}
        </div></td>`;
        tr.after(d);
      };
    });
  }

  /* ---------- Settings ---------- */
  async function renderSettings() {
    loading(8);
    let data;
    try { data = await api('/settings'); } catch (e) { view.innerHTML = errorBanner(e.message); return; }
    const s = data.settings; const locs = data.locations;
    const allLocs = !s.locationIds.length;
    const tzs = ['America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Bogota', 'Asia/Dhaka', 'UTC'];
    view.innerHTML = `<form id="settings-form" autocomplete="off">
      <div class="section-grid"><div><h2>Inventory source</h2><p class="muted">Which Shopify locations count toward the quantity Rue La La sees. Uses Shopify's <b>Available</b> stock (on hand minus committed).</p></div>
        <div class="card"><div class="card-body">
          <label class="check"><input type="checkbox" id="loc-all" ${allLocs ? 'checked' : ''}><span><span class="t">All active locations</span><div class="help">New locations are included automatically.</div></span></label>
          <div id="loc-list" style="padding-left:24px;${allLocs ? 'opacity:.5;pointer-events:none' : ''}">
            ${locs.length ? locs.map((l) => `<label class="check"><input type="checkbox" name="loc" value="${l.id}" ${s.locationIds.includes(l.id) ? 'checked' : ''}><span><span class="t">${esc(l.name)}</span>${l.active ? '' : ' <span class="badge">Inactive</span>'}</span></label>`).join('') : '<div class="help">Locations load after the first catalog read.</div>'}
          </div>
          <div class="divider"></div>
          <label class="field" style="margin:0"><span class="field-label">Shopify SKUs to send</span>
            <div class="row" style="align-items:center"><span style="flex:none" class="muted">Starts with</span><input type="text" name="skuPrefix" value="${esc(s.skuPrefix)}" style="max-width:120px"></div>
            <div class="help">Only variants whose Shopify SKU starts with this are sent as the Host SKU.</div></label>
          <div class="divider"></div>
          <label class="check"><input type="checkbox" name="zeroMissing" ${s.zeroMissing !== false ? 'checked' : ''}><span><span class="t">Send 0 for SKUs not found in Shopify</span><div class="help">On: Host SKUs in your Rue La La list that aren't in Shopify are sent with quantity 0, so Rue La La stops selling them. Off: they are left out of the file.</div></span></label>
        </div></div></div>

      <div class="section-grid"><div><h2>Full inventory sync</h2><p class="muted">Sends every mapped SKU, so Rue La La always has a complete, correct picture.</p></div>
        <div class="card"><div class="card-body">
          <label class="check"><input type="checkbox" name="schedEnabled" ${s.schedule.enabled ? 'checked' : ''}><span class="t">Run on a schedule</span></label>
          <div class="row" style="margin-top:8px">
            <label class="field"><span class="field-label">First run</span><input type="time" name="t1" value="${esc(s.schedule.times[0] || '')}"></label>
            <label class="field"><span class="field-label">Second run</span><input type="time" name="t2" value="${esc(s.schedule.times[1] || '')}"></label>
            <label class="field"><span class="field-label">Time zone</span><select name="tz">${[...new Set([s.schedule.timezone, ...tzs])].map((z) => `<option ${z === s.schedule.timezone ? 'selected' : ''}>${z}</option>`).join('')}</select></label>
          </div>
        </div></div></div>

      <div class="section-grid"><div><h2>Instant sync</h2><p class="muted">When an order, return or stock edit changes a SKU's quantity, it's sent to Rue La La shortly after.</p></div>
        <div class="card"><div class="card-body">
          <label class="check"><input type="checkbox" name="instEnabled" ${s.instant.enabled ? 'checked' : ''}><span class="t">Send stock changes automatically</span></label>
          <div class="divider"></div>
          <span class="field-label">Each instant file contains</span>
          <label class="check"><input type="radio" name="mode" value="changes" ${s.instant.mode !== 'full' ? 'checked' : ''}><span><span class="t">Only the SKUs that changed</span><div class="help">Smallest files. Use this if Rue La La updates only the SKUs listed in a file.</div></span></label>
          <label class="check"><input type="radio" name="mode" value="full" ${s.instant.mode === 'full' ? 'checked' : ''}><span><span class="t">The full inventory</span><div class="help">Safest if Rue La La treats every file as your complete inventory.</div></span></label>
          <label class="field" style="margin-top:8px"><span class="field-label">Wait before sending</span>
            <select name="debounce">${[[60, '1 minute'], [120, '2 minutes'], [300, '5 minutes'], [900, '15 minutes']].map(([v, l]) => `<option value="${v}" ${Number(s.instant.debounceSeconds) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <div class="help">Changes from one order across sizes are grouped into a single file.</div></label>
        </div></div></div>

      <div class="section-grid"><div><h2>VendorNet SFTP</h2><p class="muted">Where the inventory file is uploaded.</p></div>
        <div class="card"><div class="card-body">
          <div class="row">
            <label class="field" style="flex:3"><span class="field-label">Host</span><input type="text" name="host" value="${esc(s.sftp.host)}"></label>
            <label class="field" style="flex:1"><span class="field-label">Port</span><input type="number" name="port" value="${esc(s.sftp.port)}"></label>
          </div>
          <div class="row">
            <label class="field"><span class="field-label">User</span><input type="text" name="username" value="${esc(s.sftp.username)}"></label>
            <label class="field"><span class="field-label">Password</span><input type="password" name="password" placeholder="${s.sftp.hasPassword ? '•••••••••• (saved)' : 'Required'}"><div class="help">${s.sftp.hasPassword ? 'Leave blank to keep the saved password.' : 'Stored encrypted.'}</div></label>
          </div>
          <label class="field"><span class="field-label">Upload folder</span><input type="text" name="directory" value="${esc(s.sftp.directory)}"></label>
          <label class="field"><span class="field-label">File name</span><input type="text" name="filePrefix" value="${esc(s.filePrefix)}"><div class="help">Files are named <span class="mono" id="fname-ex"></span></div></label>
          <div style="display:flex;gap:8px;align-items:center"><button type="button" class="btn" id="btn-test">Test connection</button><span id="test-result" class="small"></span></div>
        </div></div></div>

      <div class="section-grid"><div><h2>Pause</h2><p class="muted">Stops scheduled and instant syncs without losing anything. Changes keep queuing.</p></div>
        <div class="card"><div class="card-body">
          <label class="check"><input type="checkbox" name="paused" ${s.paused ? 'checked' : ''}><span><span class="t">Pause all automatic syncing</span><div class="help">"Run full sync" still works.</div></span></label>
        </div></div></div>

      <div class="save-bar"><button type="button" class="btn" id="btn-discard">Discard</button><button type="submit" class="btn btn-primary" id="btn-save">Save</button></div>
    </form>`;

    const form = $('#settings-form');
    const fnameEx = () => { $('#fname-ex').textContent = `${(form.filePrefix.value || 'inventory').replace(/[^A-Za-z0-9_-]/g, '_')}_20261105_060000.csv`; };
    fnameEx(); form.filePrefix.oninput = fnameEx;
    $('#loc-all').onchange = (e) => { const l = $('#loc-list'); l.style.opacity = e.target.checked ? '.5' : '1'; l.style.pointerEvents = e.target.checked ? 'none' : 'auto'; };
    $('#btn-discard').onclick = () => renderSettings();

    const collect = () => ({
      skuPrefix: form.skuPrefix.value,
      locationIds: $('#loc-all').checked ? [] : [...form.querySelectorAll('input[name=loc]:checked')].map((i) => i.value),
      schedule: { enabled: form.schedEnabled.checked, times: [form.t1.value, form.t2.value].filter(Boolean), timezone: form.tz.value },
      instant: { enabled: form.instEnabled.checked, mode: form.querySelector('input[name=mode]:checked').value, debounceSeconds: Number(form.debounce.value) },
      sftp: { host: form.host.value, port: form.port.value, username: form.username.value, password: form.password.value, directory: form.directory.value },
      filePrefix: form.filePrefix.value,
      paused: form.paused.checked,
      zeroMissing: form.zeroMissing.checked,
    });

    $('#btn-test').onclick = async (e) => {
      const out = $('#test-result'); busy(e.currentTarget, true, 'Connecting…'); out.textContent = '';
      try {
        const r = await api('/settings/test-sftp', { method: 'POST', body: { sftp: collect().sftp } });
        out.innerHTML = r.ok ? `<span class="badge success">Connected</span> <span class="muted">${esc(r.dir)} · ${plural(r.files, 'file')} · ${r.ms} ms</span>` : `<span class="badge critical">Failed</span> <span style="color:var(--critical)">${esc(r.error)}</span>`;
      } catch (err) { out.innerHTML = `<span style="color:var(--critical)">${esc(err.message)}</span>`; }
      busy(e.currentTarget, false);
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const body = collect();
      if (!$('#loc-all').checked && !body.locationIds.length) { toast('Choose at least one location', true); return; }
      const btn = $('#btn-save'); busy(btn, true, 'Saving…');
      try { await api('/settings', { method: 'PUT', body }); toast('Settings saved'); state.overview = null; renderSettings(); }
      catch (err) { toast(err.message, true); busy(btn, false); }
    };
  }

  /* ---------- boot ---------- */
  (async () => {
    state.tab = tabFromPath();
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    loading(4);
    try {
      await api('/bootstrap');
      await refreshOverview().catch(() => {});
      render();
    } catch (e) {
      view.innerHTML = errorBanner(e.message);
    }
  })();
})();
