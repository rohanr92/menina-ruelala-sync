/* Rue Gilt orders tab. Uses helpers exposed by app.js on window.__ui. */
(() => {
  const st = { filter: 'open', open: new Set(), ov: null, showSettings: false };
  let pollTimer = null;
  const U = () => window.__ui;

  const STATUS = {
    new: ['info', 'Ready to import'],
    error: ['critical', 'Needs attention'],
    importing: ['info', 'Importing…'],
    imported: ['attention', 'Waiting to ship'],
    partial: ['warning', 'Partly shipped'],
    shipped: ['success', 'Shipped'],
    old: ['', 'Earlier order'],
    ignored: ['', 'Ignored'],
  };
  const badge = (s) => { const [t, l] = STATUS[s] || ['', s]; return `<span class="badge ${t}">${l}</span>`; };
  const usDate = (iso) => { if (!iso) return '—'; const [y, m, d] = iso.split('-'); return `${Number(m)}/${Number(d)}/${y}`; };
  const money = (n) => `$${Number(n || 0).toFixed(2)}`;

  function shipByBadge(o) {
    if (!o.shipBy || ['shipped', 'old', 'ignored'].includes(o.status)) return usDate(o.shipBy);
    const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    today.setHours(0, 0, 0, 0);
    const [y, m, d] = o.shipBy.split('-').map(Number);
    const days = Math.round((new Date(y, m - 1, d) - today) / 86400000);
    const tone = days < 0 ? 'critical' : days === 0 ? 'critical' : days === 1 ? 'warning' : '';
    const word = days < 0 ? `${-days} d late` : days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `in ${days} d`;
    return `${usDate(o.shipBy)}<div class="sub"><span class="badge ${tone}">${word}</span></div>`;
  }

  async function render() {
    const { view, loading } = U();
    if (!view.querySelector('#gilt')) loading(5);
    try {
      const [ov, list] = await Promise.all([U().api('/gilt/overview'), U().api(`/gilt/orders?filter=${st.filter}`)]);
      st.ov = ov;
      draw(ov, list.orders);
    } catch (e) {
      view.innerHTML = U().errorBanner(e.message);
    }
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (location.pathname.startsWith('/orders') && !document.querySelector('#gilt input:focus, #gilt select:focus')) refresh(); }, 30000);
  }
  async function refresh() {
    try {
      const [ov, list] = await Promise.all([U().api('/gilt/overview'), U().api(`/gilt/orders?filter=${st.filter}`)]);
      st.ov = ov; draw(ov, list.orders);
    } catch { /* ignore */ }
  }

  function draw(ov, orders) {
    const { view, esc, num, ago, until, plural } = U();
    const c = ov.counts || {};
    const s = ov.settings;
    const waitingImport = (c.new || 0) + (c.error || 0);
    const waitingShip = (c.imported || 0) + (c.partial || 0);
    const adminUrl = (id) => ov.shopHandle ? `https://admin.shopify.com/store/${ov.shopHandle}/orders/${id}` : '#';

    const banners = [];
    if (ov.lastError) banners.push(`<div class="banner critical"><div class="icon">!</div><div class="grow"><div class="banner-title">Last check had a problem</div><div class="mono small">${esc(ov.lastError)}</div></div></div>`);
    if (ov.baselineDone && c.old && !waitingImport && !waitingShip && !c.shipped) {
      banners.push(`<div class="banner info"><div class="icon">i</div><div class="grow"><div class="banner-title">${plural(c.old, 'earlier order')} found in ${esc(s.getDir)}</div><div>These were already there before the app started, so they are <b>not</b> imported. Open <b>Earlier orders</b> and click <b>Import</b> on the ones you still need to ship (e.g. today's order).</div></div><button class="btn" data-f="old">Earlier orders</button></div>`);
    }
    if (!ov.lastPoll) banners.push(`<div class="banner info"><div class="icon">i</div><div class="grow"><div class="banner-title">Not checked yet</div><div>Click <b>Check ${esc(s.getDir)} now</b> to read the order files. Nothing is created in Shopify until you import an order.</div></div></div>`);

    const filters = [['open', 'Open'], ['new', 'Needs import'], ['imported', 'Waiting to ship'], ['shipped', 'Shipped'], ['old', 'Earlier orders'], ['all', 'All']];
    const rows = orders.map((o) => {
      const missing = o.lines.filter((l) => l.inShopify === false).length;
      const canImport = ['new', 'error', 'old', 'ignored'].includes(o.status);
      const pendingAsn = o.shipments.filter((a) => a.status !== 'sent').length;
      const isOpen = st.open.has(o.orderNo);
      const main = `<tr class="clickable" data-row="${esc(o.orderNo)}">
        <td><span class="strong mono">${esc(o.orderNo)}</span><div class="sub">${usDate(o.orderDate)} · ${esc(o.shipMethod || '')}</div></td>
        <td>${shipByBadge(o)}</td>
        <td>${esc(o.shipTo?.name || '—')}<div class="sub">${esc([o.shipTo?.city, o.shipTo?.state].filter(Boolean).join(', '))}</div></td>
        <td>${o.lines.map((l) => `<div><span class="strong">${esc(l.vendorSku)}</span> <span class="mono small">${esc(l.hostSku)}</span> × ${l.qty}${l.inShopify === false ? ' <span class="badge critical">Not in Shopify</span>' : ''}</div>`).join('')}</td>
        <td class="num">${money(o.total)}</td>
        <td>${o.shopifyOrderName ? `<a href="${adminUrl(o.shopifyOrderId)}" target="_top">${esc(o.shopifyOrderName)}</a>` : '<span class="subtle">—</span>'}</td>
        <td>${badge(o.status)}${pendingAsn ? '<div class="sub"><span class="badge attention">Shipment file ready</span></div>' : ''}</td>
        <td class="num" style="white-space:nowrap">
          ${canImport ? `<button class="btn btn-primary btn-sm" data-import="${esc(o.orderNo)}" ${missing ? 'disabled title="Fix the missing SKU first"' : ''}>${o.status === 'error' ? 'Retry' : 'Import'}</button>` : ''}
          <button class="btn btn-sm" data-xlsx="${esc(o.orderNo)}" title="FedEx batch upload file">FedEx Excel</button>
        </td>
      </tr>`;
      if (!isOpen) return main;
      const a = (x) => x ? [x.company, x.name, x.line1, x.line2, x.line3, `${x.city}, ${x.state} ${x.zip}`, x.phone].filter(Boolean).map(esc).join('<br>') : '—';
      return `${main}<tr class="detail"><td colspan="8">
        ${o.error ? `<div class="banner critical" style="margin-bottom:12px"><div class="icon">!</div><div class="grow"><div class="banner-title">Import problem</div><div>${esc(o.error)}</div></div></div>` : ''}
        <div class="grid grid-2" style="gap:16px;margin-bottom:12px">
          <dl class="kv"><dt>Ship to</dt><dd>${a(o.shipTo)}</dd><dt>Bill to</dt><dd>${a(o.billTo)}</dd></dl>
          <dl class="kv"><dt>Order date</dt><dd>${usDate(o.orderDate)}</dd><dt>Ship by</dt><dd>${usDate(o.shipBy)}</dd>
            <dt>Ship method</dt><dd>${esc(o.shipMethodName)} (${esc(o.shipMethod)})</dd>
            ${o.comments?.length ? `<dt>Notes</dt><dd>${o.comments.map(esc).join('<br>')}</dd>` : ''}
            <dt>File</dt><dd><button class="btn btn-plain btn-sm" data-raw="${esc(o.file)}">${esc(o.file)}</button></dd>
            ${o.importedAt ? `<dt>Imported</dt><dd>${U().fmtDate(o.importedAt)}</dd>` : ''}</dl>
        </div>
        <div class="card" style="margin-bottom:12px"><div class="table-wrap"><table>
          <thead><tr><th>Vendor SKU</th><th>Host SKU</th><th>Description</th><th class="num">Qty</th><th class="num">Unit cost</th><th class="num">Retail</th><th>Shopify</th></tr></thead>
          <tbody>${o.lines.map((l) => `<tr><td class="strong">${esc(l.vendorSku)}</td><td class="mono">${esc(l.hostSku)}</td><td>${esc(l.description)}</td><td class="num">${l.qty}</td><td class="num">${money(l.unitCost)}</td><td class="num">${money(l.retail)}</td><td>${l.inShopify === false ? '<span class="badge critical">Not found</span>' : '<span class="badge success">Found</span>'}</td></tr>`).join('')}</tbody>
        </table></div></div>
        <div class="strong" style="margin-bottom:6px">Shipment files to Rue La La (${esc(s.shipDir)})</div>
        ${o.shipments.length ? `<div class="card"><div class="table-wrap"><table>
          <thead><tr><th>Tracking</th><th>File</th><th>Status</th><th></th></tr></thead>
          <tbody>${o.shipments.map((x) => `<tr><td class="mono">${esc(x.tracking)}</td><td class="mono small">${esc(x.filename)}</td>
            <td>${x.status === 'sent' ? `<span class="badge success">Sent</span> <span class="sub">${ago(x.sent_at)}</span>` : x.status === 'failed' ? `<span class="badge critical">Failed</span><div class="sub">${esc(x.error)}</div>` : '<span class="badge attention">Ready — not sent yet</span>'}</td>
            <td class="num" style="white-space:nowrap"><button class="btn btn-sm" data-asncsv="${x.id}" data-name="${esc(x.filename)}">Download</button>
            ${x.status !== 'sent' ? ` <button class="btn btn-primary btn-sm" data-asnsend="${x.id}">Send to Rue La La</button>` : ''}</td></tr>`).join('')}</tbody>
        </table></div></div>`
        : `<div class="muted small">${o.shopifyOrderId ? 'Created automatically after you fulfill this order in Shopify and add the tracking number.' : 'Import the order first.'}
            ${o.shopifyOrderId ? ` <button class="btn btn-plain btn-sm" data-chk="${esc(o.orderNo)}">Check Shopify now</button>` : ''}</div>
          ${o.shopifyOrderId ? `<div class="small muted" style="margin-top:10px">Need to create the Shopify order again? Cancel ${esc(o.shopifyOrderName)} in Shopify first (restock the item), then
            <button class="btn btn-sm" data-reimport="${esc(o.orderNo)}">Re-import order</button></div>` : ''}`}
      </td></tr>`;
    }).join('');

    const f = s.fedex;
    view.innerHTML = `<div id="gilt">
      ${banners.join('')}
      <div class="grid grid-4">
        <div class="card tile"><div class="tile-label"><span class="dot ${ov.lastError ? 'bad' : ov.lastPoll ? 'ok' : ''}"></span>${esc(s.getDir)}</div>
          <div class="tile-value">${ov.lastPoll ? ago(ov.lastPoll) : 'Not checked'}</div>
          <div class="tile-meta">${ov.nextPoll ? `Next check ${until(ov.nextPoll)}` : `Checks every ${s.pollMinutes} min`} · ${plural(ov.files, 'file')}</div></div>
        <div class="card tile"><div class="tile-label"><span class="dot ${waitingImport ? 'warn' : 'ok'}"></span>Needs import</div>
          <div class="tile-value">${num(waitingImport)}</div>
          <div class="tile-meta">${s.autoImport ? 'New orders import automatically' : 'Auto-import is off'}</div></div>
        <div class="card tile"><div class="tile-label"><span class="dot ${waitingShip ? 'warn' : 'ok'}"></span>Waiting to ship</div>
          <div class="tile-value">${num(waitingShip)}</div>
          <div class="tile-meta">Tagged "${esc(s.tag)}" in Shopify</div></div>
        <div class="card tile"><div class="tile-label"><span class="dot ${ov.asnWaiting ? 'warn' : 'ok'}"></span>Shipment files</div>
          <div class="tile-value">${ov.asnWaiting ? `${num(ov.asnWaiting)} to send` : 'Up to date'}</div>
          <div class="tile-meta">${s.autoAsn ? `Sent automatically to ${esc(s.shipDir)}` : 'Auto-send is off — review & send'}</div></div>
      </div>

      <div class="card">
        <div class="filters">
          <div class="pills">${filters.map(([k, l]) => `<button class="pill ${st.filter === k ? 'active' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
          <span style="flex:1"></span>
          <button class="btn" id="g-fedex-all" ${waitingShip ? '' : 'disabled'}>FedEx Excel (all waiting to ship)</button>
          <button class="btn btn-primary" id="g-check">Check ${esc(s.getDir)} now</button>
        </div>
        ${orders.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Rue Gilt order</th><th>Ship by</th><th>Ship to</th><th>Items</th><th class="num">Cost</th><th>Shopify</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table></div>`
        : `<div class="empty"><span class="strong">No orders here</span>${st.filter === 'open' ? 'New Rue Gilt orders appear here within a few minutes of arriving in ' + esc(s.getDir) + '.' : 'Try another filter.'}</div>`}
      </div>

      <div class="card">
        <div class="card-head"><h2 class="card-title">Order settings</h2><button class="btn btn-plain" id="g-toggle-settings">${st.showSettings ? 'Hide' : 'Show'}</button></div>
        <div class="card-body" ${st.showSettings ? '' : 'hidden'}>
          <form id="g-form" autocomplete="off">
            <label class="check"><input type="checkbox" name="autoImport" ${s.autoImport ? 'checked' : ''}><span><span class="t">Import new orders automatically</span><div class="help">Every new order in ${esc(s.getDir)} becomes a Shopify order tagged "${esc(s.tag)}" and reduces stock. Earlier orders are never imported automatically.</div></span></label>
            <label class="check"><input type="checkbox" name="autoAsn" ${s.autoAsn ? 'checked' : ''}><span><span class="t">Send shipment files automatically</span><div class="help">When you fulfill an order in Shopify with a tracking number, the shipment CSV is uploaded to ${esc(s.shipDir)} right away. Off: it waits here for you to click Send.</div></span></label>
            <div class="divider"></div>
            <div class="row">
              <label class="field"><span class="field-label">Check for orders every</span><select name="pollMinutes">${[1, 2, 5, 10, 15].map((m) => `<option value="${m}" ${Number(s.pollMinutes) === m ? 'selected' : ''}>${m} min</option>`).join('')}</select></label>
              <label class="field"><span class="field-label">Order folder</span><input type="text" name="getDir" value="${esc(s.getDir)}"></label>
              <label class="field"><span class="field-label">Shipment folder</span><input type="text" name="shipDir" value="${esc(s.shipDir)}"></label>
            </div>
            <div class="row">
              <label class="field"><span class="field-label">Shopify tag</span><input type="text" name="tag" value="${esc(s.tag)}"></label>
              <label class="field"><span class="field-label">Price on Shopify order</span><select name="priceField"><option value="unitCost" ${s.priceField !== 'retail' ? 'selected' : ''}>Unit cost (what Rue Gilt pays)</option><option value="retail" ${s.priceField === 'retail' ? 'selected' : ''}>Retail price</option></select></label>
            </div>
            <div class="divider"></div>
            <div class="strong" style="margin-bottom:8px">FedEx Excel — sender &amp; package</div>
            <div class="row">
              <label class="field"><span class="field-label">Sender name</span><input type="text" name="senderContactName" value="${esc(f.senderContactName)}"></label>
              <label class="field"><span class="field-label">Company</span><input type="text" name="senderCompany" value="${esc(f.senderCompany)}"></label>
              <label class="field"><span class="field-label">Phone</span><input type="text" name="senderContactNumber" value="${esc(f.senderContactNumber)}"></label>
              <label class="field"><span class="field-label">Email</span><input type="text" name="senderEmail" value="${esc(f.senderEmail)}"></label>
            </div>
            <div class="row">
              <label class="field" style="flex:2"><span class="field-label">Address</span><input type="text" name="senderLine1" value="${esc(f.senderLine1)}"></label>
              <label class="field"><span class="field-label">City</span><input type="text" name="senderCity" value="${esc(f.senderCity)}"></label>
              <label class="field"><span class="field-label">State</span><input type="text" name="senderState" value="${esc(f.senderState)}"></label>
              <label class="field"><span class="field-label">ZIP</span><input type="text" name="senderPostcode" value="${esc(f.senderPostcode)}"></label>
            </div>
            <div class="row">
              <label class="field"><span class="field-label">Package type</span><input type="text" name="packageType" value="${esc(f.packageType)}"></label>
              <label class="field"><span class="field-label">Weight (${esc(f.weightUnits)})</span><input type="number" step="0.1" name="packageWeight" value="${esc(f.packageWeight)}"></label>
              <label class="field"><span class="field-label">L × W × H (in)</span><div class="row" style="gap:4px"><input type="number" name="length" value="${esc(f.length)}"><input type="number" name="width" value="${esc(f.width)}"><input type="number" name="height" value="${esc(f.height)}"></div></label>
            </div>
            <div class="row">
              <label class="field"><span class="field-label">Default service</span><input type="text" name="serviceType" value="${esc(f.serviceType)}"><div class="help">FEDH orders always use GROUND_HOME_DELIVERY.</div></label>
              <label class="field"><span class="field-label">Payment type</span><input type="text" name="paymentType" value="${esc(f.paymentType)}"></label>
              <label class="field"><span class="field-label">Bill to FedEx account</span><input type="text" name="payerAccountNumber" value="${esc(f.payerAccountNumber)}"></label>
            </div>
            <div style="display:flex;justify-content:flex-end"><button class="btn btn-primary" type="submit">Save order settings</button></div>
          </form>
        </div>
      </div>
    </div>`;
    bind();
  }

  function bind() {
    const { view, api, toast, busy, download } = U();
    view.querySelectorAll('[data-f]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); st.filter = b.dataset.f; render(); }; });
    view.querySelectorAll('tr[data-row]').forEach((tr) => {
      tr.onclick = (e) => {
        if (e.target.closest('button,a')) return;
        const k = tr.dataset.row;
        st.open.has(k) ? st.open.delete(k) : st.open.add(k);
        refresh();
      };
    });
    view.querySelectorAll('[data-import]').forEach((b) => {
      b.onclick = async () => {
        busy(b, true, 'Creating…');
        try { const r = await api(`/gilt/orders/${encodeURIComponent(b.dataset.import)}/import`, { method: 'POST' }); toast(`Created Shopify order ${r.name}`); }
        catch (e) { toast(e.message, true); }
        refresh();
      };
    });
    view.querySelectorAll('[data-reimport]').forEach((b) => {
      b.onclick = async () => {
        busy(b, true, 'Re-importing…');
        try { const r = await api(`/gilt/orders/${encodeURIComponent(b.dataset.reimport)}/reimport`, { method: 'POST' }); toast(`Created Shopify order ${r.name}`); }
        catch (e) { toast(e.message, true); }
        refresh();
      };
    });
    view.querySelectorAll('[data-xlsx]').forEach((b) => { b.onclick = () => download(`/gilt/orders/${encodeURIComponent(b.dataset.xlsx)}/fedex.xlsx`, `FedEx_RueGilt_${b.dataset.xlsx}.xlsx`); });
    view.querySelectorAll('[data-raw]').forEach((b) => { b.onclick = () => download(`/gilt/files/${encodeURIComponent(b.dataset.raw)}/raw`, b.dataset.raw); });
    view.querySelectorAll('[data-asncsv]').forEach((b) => { b.onclick = () => download(`/gilt/asn/${b.dataset.asncsv}/csv`, b.dataset.name); });
    view.querySelectorAll('[data-asnsend]').forEach((b) => {
      b.onclick = async () => {
        busy(b, true, 'Sending…');
        try { await api(`/gilt/asn/${b.dataset.asnsend}/send`, { method: 'POST' }); toast('Shipment file sent to Rue La La'); }
        catch (e) { toast(e.message, true); }
        refresh();
      };
    });
    view.querySelectorAll('[data-chk]').forEach((b) => {
      b.onclick = async () => {
        busy(b, true);
        try { const r = await api(`/gilt/orders/${encodeURIComponent(b.dataset.chk)}/check-shipment`, { method: 'POST' }); toast(r.created ? 'Shipment found' : 'No fulfillment with tracking yet'); }
        catch (e) { toast(e.message, true); }
        refresh();
      };
    });
    const check = view.querySelector('#g-check');
    check.onclick = async () => {
      busy(check, true, 'Checking…');
      try {
        const r = await api('/gilt/check', { method: 'POST' });
        toast(r.errors?.length ? `Checked with problems: ${r.errors[0]}` : `Checked — ${r.newFiles} new file(s), ${r.newOrders} new order(s)`, Boolean(r.errors?.length));
      } catch (e) { toast(e.message, true); }
      render();
    };
    view.querySelector('#g-fedex-all').onclick = () => download('/gilt/fedex.xlsx', 'FedEx_RueGilt.xlsx');
    view.querySelector('#g-toggle-settings').onclick = () => { st.showSettings = !st.showSettings; refresh(); };
    const form = view.querySelector('#g-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const v = (n) => form.elements[n].value;
      const body = {
        autoImport: form.autoImport.checked, autoAsn: form.autoAsn.checked, pollMinutes: Number(v('pollMinutes')),
        getDir: v('getDir'), shipDir: v('shipDir'), tag: v('tag'), priceField: v('priceField'),
        fedex: Object.fromEntries(['senderContactName', 'senderCompany', 'senderContactNumber', 'senderEmail', 'senderLine1', 'senderCity', 'senderState', 'senderPostcode',
          'packageType', 'packageWeight', 'length', 'width', 'height', 'serviceType', 'paymentType', 'payerAccountNumber'].map((k) => [k, v(k)])),
      };
      const btn = form.querySelector('button[type=submit]'); busy(btn, true, 'Saving…');
      try { await api('/gilt/settings', { method: 'PUT', body }); toast('Order settings saved'); } catch (err) { toast(err.message, true); }
      refresh();
    };
  }

  window.GiltOrders = { render };
})();
