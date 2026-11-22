// Rue Gilt orders: /Live/Get -> Shopify orders; Shopify fulfillments -> shipment CSV in /Live/Put/Ship.
import SftpClient from 'ssh2-sftp-client';
import { q, getSettings, saveSettings, kvGet, kvSet } from './db.js';
import { graphql, getSession, idFromGid } from './shopify.js';
import { sftpConfig } from './sync.js';
import {
  parseOrderFile, looksLikeOrderFile, buildAsnCsv, asnFileName, buildFedexWorkbook,
  shopifyOrderInput, FEDEX_DEFAULTS,
} from './gilt.js';
import { buildPackingSlips } from './slip.js';
import multer from 'multer';

const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

async function slipLogo() {
  const b64 = await kvGet('slipLogo');
  return b64 ? Buffer.from(b64, 'base64') : null;
}

const log = (...a) => console.log(new Date().toISOString(), '[orders]', ...a);

export const ORDER_DEFAULTS = {
  autoImport: false,
  autoAsn: false,
  pollMinutes: 2,
  getDir: '/Live/Get',
  shipDir: '/Live/Put/Ship',
  priceField: 'unitCost',
  tag: 'Rue Gilt',
  fedex: FEDEX_DEFAULTS,
};

export async function getOrderSettings() {
  const s = await getSettings();
  const o = s.orders || {};
  return { ...ORDER_DEFAULTS, ...o, fedex: { ...FEDEX_DEFAULTS, ...(o.fedex || {}) } };
}

async function saveOrderSettings(next) {
  const s = await getSettings();
  await saveSettings({ ...s, orders: next });
}

export async function migrateOrders() {
  await q(`
    CREATE TABLE IF NOT EXISTS gilt_files (
      name TEXT PRIMARY KEY,
      size BIGINT,
      mtime TIMESTAMPTZ,
      seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL,
      order_count INT NOT NULL DEFAULT 0,
      content TEXT,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS gilt_orders (
      order_no TEXT PRIMARY KEY,
      file_name TEXT,
      data JSONB NOT NULL,
      status TEXT NOT NULL,
      shopify_order_id BIGINT,
      shopify_order_name TEXT,
      error TEXT,
      warnings TEXT[],
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      imported_at TIMESTAMPTZ,
      shipped_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS gilt_orders_status_idx ON gilt_orders (status);
    CREATE TABLE IF NOT EXISTS gilt_asn (
      id SERIAL PRIMARY KEY,
      order_no TEXT NOT NULL,
      fulfillment_id TEXT UNIQUE,
      tracking TEXT,
      rows JSONB,
      filename TEXT,
      csv TEXT,
      status TEXT NOT NULL,
      error TEXT,
      remote_path TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      sent_at TIMESTAMPTZ
    );
  `);
}

/* ---------- serialize work ---------- */
let chain = Promise.resolve();
const exclusive = (fn) => { const n = chain.then(fn, fn); chain = n.catch(() => {}); return n; };

async function withSftp(fn) {
  const settings = await getSettings();
  const sftp = new SftpClient();
  try {
    await sftp.connect(sftpConfig(settings));
    return await fn(sftp);
  } finally {
    await sftp.end().catch(() => {});
  }
}

/* ---------- 1. Read /Live/Get ---------- */

const MAX_BASELINE_DOWNLOADS = 300;

export function pollInbox({ trigger = 'schedule' } = {}) {
  return exclusive(async () => {
    const cfg = await getOrderSettings();
    const started = new Date();
    const result = { newFiles: 0, newOrders: 0, imported: 0, errors: [] };
    try {
      if (!(await getSession())) throw new Error('App is not connected to Shopify yet.');
      const firstScan = (await kvGet('ordersBaselineDone')) !== '1';
      await withSftp(async (sftp) => {
        const dir = cfg.getDir.replace(/\/+$/, '');
        const list = (await sftp.list(dir)).filter((f) => f.type === '-');
        const { rows } = await q('SELECT name FROM gilt_files');
        const known = new Set(rows.map((r) => r.name));
        const fresh = list.filter((f) => !known.has(f.name)).sort((a, b) => b.modifyTime - a.modifyTime);
        for (const [i, f] of fresh.entries()) {
          const mtime = f.modifyTime ? new Date(f.modifyTime) : null;
          if (firstScan && i >= MAX_BASELINE_DOWNLOADS) {
            await q(`INSERT INTO gilt_files (name, size, mtime, status) VALUES ($1,$2,$3,'old') ON CONFLICT DO NOTHING`, [f.name, f.size, mtime]);
            continue;
          }
          let text;
          try {
            text = (await sftp.get(`${dir}/${f.name}`)).toString('utf8');
          } catch (e) {
            result.errors.push(`${f.name}: ${e.message}`);
            continue; // try again next time
          }
          result.newFiles++;
          if (!looksLikeOrderFile(text)) {
            await q(`INSERT INTO gilt_files (name, size, mtime, status, content) VALUES ($1,$2,$3,'ignored',$4) ON CONFLICT DO NOTHING`, [f.name, f.size, mtime, text.slice(0, 200000)]);
            continue;
          }
          const parsed = parseOrderFile(text);
          let added = 0;
          for (const o of parsed.orders) {
            const r = await q(
              `INSERT INTO gilt_orders (order_no, file_name, data, status, warnings) VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (order_no) DO NOTHING RETURNING order_no`,
              [o.orderNo, f.name, o, firstScan ? 'old' : 'new', parsed.warnings.filter((w) => w.includes(o.orderNo))],
            );
            if (r.rows.length) added++;
          }
          result.newOrders += firstScan ? 0 : added;
          await q(
            `INSERT INTO gilt_files (name, size, mtime, status, order_count, content, error) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
            [f.name, f.size, mtime, firstScan ? 'old' : 'read', parsed.orders.length, text, parsed.warnings.join('\n') || null],
          );
        }
      });
      if (firstScan) await kvSet('ordersBaselineDone', '1');
      if (cfg.autoImport) {
        const { rows } = await q(`SELECT order_no FROM gilt_orders WHERE status = 'new' ORDER BY created_at`);
        for (const r of rows) {
          const res = await importOrderInner(r.order_no, cfg).catch((e) => ({ error: e.message }));
          if (res?.error) result.errors.push(`${r.order_no}: ${res.error}`); else result.imported++;
        }
      }
      await checkShipmentsInner(null, cfg).catch((e) => result.errors.push(`Shipments: ${e.message}`));
      await kvSet('ordersLastError', result.errors.join('\n'));
      if (result.newOrders || result.imported || trigger === 'manual') log(`poll (${trigger}):`, JSON.stringify(result));
    } catch (e) {
      result.errors.push(e.message);
      await kvSet('ordersLastError', e.message);
      log('poll failed:', e.message);
    }
    await kvSet('ordersLastPoll', started.toISOString());
    return result;
  });
}

/* ---------- 2. Create the Shopify order ---------- */

async function variantIdsFor(skus) {
  const map = new Map();
  const { rows } = await q('SELECT sku, variant_id FROM variants WHERE sku = ANY($1)', [skus]);
  for (const r of rows) if (r.variant_id && !map.has(r.sku)) map.set(r.sku, `gid://shopify/ProductVariant/${r.variant_id}`);
  for (const sku of skus.filter((s) => !map.has(s))) {
    const d = await graphql(
      `query($q: String!) { productVariants(first: 5, query: $q) { nodes { id sku } } }`,
      { q: `sku:"${sku.replace(/"/g, '')}"` },
    );
    const hit = d.productVariants.nodes.find((n) => (n.sku || '').trim() === sku);
    if (hit) map.set(sku, hit.id);
  }
  return map;
}

async function importOrderInner(orderNo, cfg) {
  const lock = await q(
    `UPDATE gilt_orders SET status='importing', error=NULL WHERE order_no=$1 AND status IN ('new','old','error','ignored') RETURNING data`,
    [orderNo],
  );
  if (!lock.rows[0]) {
    const { rows } = await q('SELECT status, shopify_order_name FROM gilt_orders WHERE order_no=$1', [orderNo]);
    if (!rows[0]) return { error: 'Order not found.' };
    return { error: `Already ${rows[0].status}${rows[0].shopify_order_name ? ` as ${rows[0].shopify_order_name}` : ''}.` };
  }
  const order = lock.rows[0].data;
  const fail = async (msg) => {
    await q(`UPDATE gilt_orders SET status='error', error=$2 WHERE order_no=$1`, [orderNo, msg]);
    log(`import ${orderNo} failed: ${msg}`);
    return { error: msg };
  };
  try {
    const skus = [...new Set(order.lines.map((l) => l.hostSku))];
    const variantBySku = await variantIdsFor(skus);
    const missing = skus.filter((s) => !variantBySku.has(s));
    if (missing.length) return fail(`SKU not found in Shopify: ${missing.join(', ')}`);

    const input = shopifyOrderInput(order, variantBySku, { tag: cfg.tag, priceField: cfg.priceField });
    const d = await graphql(
      `mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
        orderCreate(order: $order, options: $options) {
          order { id name }
          userErrors { field message }
        }
      }`,
      {
        order: input,
        options: { inventoryBehaviour: 'DECREMENT_IGNORING_POLICY', sendReceipt: false, sendFulfillmentReceipt: false },
      },
    );
    const errs = d.orderCreate.userErrors;
    if (errs?.length) return fail(errs.map((e) => `${(e.field || []).join('.')}: ${e.message}`).join('; '));
    const created = d.orderCreate.order;
    await q(
      `UPDATE gilt_orders SET status='imported', shopify_order_id=$2, shopify_order_name=$3, imported_at=now(), error=NULL WHERE order_no=$1`,
      [orderNo, idFromGid(created.id), created.name],
    );
    log(`imported ${orderNo} as ${created.name}`);
    return { ok: true, name: created.name, id: idFromGid(created.id) };
  } catch (e) {
    const unsure = /fetch failed|ECONN|ETIMEDOUT|socket|5\d\d/i.test(e.message);
    return fail(unsure ? `${e.message} — check Shopify for a "Rue Gilt" order ${orderNo} before retrying.` : e.message);
  }
}

export const importOrder = (orderNo) => exclusive(async () => importOrderInner(orderNo, await getOrderSettings()));

/* ---------- 3. Shipments -> ASN ---------- */

async function sendAsnInner(id, cfg) {
  const { rows } = await q('SELECT * FROM gilt_asn WHERE id=$1', [id]);
  const a = rows[0];
  if (!a) return { error: 'Not found' };
  if (a.status === 'sent') return { ok: true, already: true };
  try {
    const remote = `${cfg.shipDir.replace(/\/+$/, '')}/${a.filename}`;
    await withSftp((sftp) => sftp.put(Buffer.from(a.csv, 'utf8'), remote));
    await q(`UPDATE gilt_asn SET status='sent', remote_path=$2, sent_at=now(), error=NULL WHERE id=$1`, [id, remote]);
    log(`ASN sent for ${a.order_no}: ${remote}`);
    await refreshShipStatus(a.order_no);
    return { ok: true, remote };
  } catch (e) {
    await q(`UPDATE gilt_asn SET status='failed', error=$2 WHERE id=$1`, [id, e.message]);
    return { error: e.message };
  }
}

export const sendAsn = (id) => exclusive(async () => sendAsnInner(id, await getOrderSettings()));

async function refreshShipStatus(orderNo) {
  const { rows } = await q('SELECT data FROM gilt_orders WHERE order_no=$1', [orderNo]);
  if (!rows[0]) return;
  const ordered = rows[0].data.lines.reduce((a, l) => a + l.qty, 0);
  const asn = await q(`SELECT rows FROM gilt_asn WHERE order_no=$1 AND status='sent'`, [orderNo]);
  const shipped = asn.rows.flatMap((r) => r.rows || []).reduce((a, r) => a + Number(r.qty || 0), 0);
  if (!shipped) return;
  const status = shipped >= ordered ? 'shipped' : 'partial';
  await q(`UPDATE gilt_orders SET status=$2, shipped_at=COALESCE(shipped_at, now()) WHERE order_no=$1 AND status IN ('imported','partial')`, [orderNo, status]);
}

async function checkShipmentsInner(orderNo, cfg) {
  const { rows } = orderNo
    ? await q(`SELECT * FROM gilt_orders WHERE order_no=$1 AND shopify_order_id IS NOT NULL`, [orderNo])
    : await q(`SELECT * FROM gilt_orders WHERE status IN ('imported','partial') AND shopify_order_id IS NOT NULL`);
  let created = 0;
  for (const o of rows) {
    const d = await graphql(
      `query($id: ID!) {
        order(id: $id) {
          id name
          fulfillments(first: 20) {
            id createdAt status
            trackingInfo { number company }
            fulfillmentLineItems(first: 50) { nodes { quantity lineItem { sku } } }
          }
        }
      }`,
      { id: `gid://shopify/Order/${o.shopify_order_id}` },
    );
    for (const f of d.order?.fulfillments || []) {
      if (f.status !== 'SUCCESS') continue;
      const tracking = f.trackingInfo?.find((t) => t.number)?.number;
      if (!tracking) continue; // wait until tracking is added
      const exists = await q('SELECT 1 FROM gilt_asn WHERE fulfillment_id=$1', [f.id]);
      if (exists.rows.length) continue;
      const asnRows = f.fulfillmentLineItems.nodes
        .filter((n) => n.quantity > 0 && n.lineItem?.sku)
        .map((n) => ({
          orderNo: o.order_no, shipDate: f.createdAt, shipMethod: o.data.shipMethod || 'FEDH',
          tracking: tracking.replace(/\s+/g, ''), sku: n.lineItem.sku.trim(), qty: n.quantity,
        }));
      if (!asnRows.length) continue;
      const csv = buildAsnCsv(asnRows);
      const ins = await q(
        `INSERT INTO gilt_asn (order_no, fulfillment_id, tracking, rows, filename, csv, status)
         VALUES ($1,$2,$3,$4,$5,$6,'ready') ON CONFLICT (fulfillment_id) DO NOTHING RETURNING id`,
        [o.order_no, f.id, tracking, JSON.stringify(asnRows), asnFileName(o.order_no, new Date()), csv],
      );
      if (!ins.rows[0]) continue;
      created++;
      log(`shipment ready for ${o.order_no} (${d.order.name}), tracking ${tracking}`);
      if (cfg.autoAsn) await sendAsnInner(ins.rows[0].id, cfg);
    }
  }
  return { created };
}

export const checkShipments = (orderNo) => exclusive(async () => checkShipmentsInner(orderNo, await getOrderSettings()));

export async function onFulfillmentWebhook(payload) {
  const orderId = Number(payload.order_id);
  if (!orderId) return;
  const { rows } = await q('SELECT order_no FROM gilt_orders WHERE shopify_order_id=$1', [orderId]);
  if (!rows[0]) return; // not a Rue Gilt order
  setTimeout(() => checkShipments(rows[0].order_no).catch((e) => log('shipment check failed:', e.message)), 5000);
}

/* ---------- poller ---------- */

export function startOrderPoller() {
  setInterval(async () => {
    try {
      const cfg = await getOrderSettings();
      const last = Date.parse((await kvGet('ordersLastPoll')) || 0) || 0;
      if (Date.now() - last >= Math.max(1, Number(cfg.pollMinutes) || 2) * 60000) await pollInbox({ trigger: 'schedule' });
    } catch (e) {
      log('poller error:', e.message);
    }
  }, 30000);
}

/* ---------- API ---------- */

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function summarize(r, skuSet) {
  const o = r.data;
  return {
    orderNo: r.order_no,
    status: r.status,
    file: r.file_name,
    orderDate: o.orderDate,
    shipBy: o.shipBy,
    shipMethod: o.shipMethod,
    shipMethodName: o.shipMethodName,
    shipTo: o.shipTo,
    billTo: o.billTo,
    comments: o.comments,
    lines: o.lines.map((l) => ({ ...l, inShopify: skuSet ? skuSet.has(l.hostSku) : null })),
    units: o.lines.reduce((a, l) => a + l.qty, 0),
    total: o.lines.reduce((a, l) => a + l.qty * l.unitCost, 0),
    shopifyOrderId: r.shopify_order_id,
    shopifyOrderName: r.shopify_order_name,
    error: r.error,
    warnings: r.warnings || [],
    createdAt: r.created_at,
    importedAt: r.imported_at,
    shippedAt: r.shipped_at,
  };
}

export function registerOrderRoutes(api) {
  api.get('/gilt/overview', wrap(async (req, res) => {
    const cfg = await getOrderSettings();
    const session = await getSession();
    const [counts, files, last, err, readyAsn] = await Promise.all([
      q(`SELECT status, count(*)::int AS n FROM gilt_orders GROUP BY status`),
      q(`SELECT count(*)::int AS n FROM gilt_files`),
      kvGet('ordersLastPoll'),
      kvGet('ordersLastError'),
      q(`SELECT count(*)::int AS n FROM gilt_asn WHERE status IN ('ready','failed')`),
    ]);
    const byStatus = Object.fromEntries(counts.rows.map((r) => [r.status, r.n]));
    res.json({
      settings: cfg,
      counts: byStatus,
      files: files.rows[0].n,
      asnWaiting: readyAsn.rows[0].n,
      lastPoll: last,
      nextPoll: last ? new Date(Date.parse(last) + cfg.pollMinutes * 60000).toISOString() : null,
      lastError: err || null,
      baselineDone: (await kvGet('ordersBaselineDone')) === '1',
      shopHandle: session?.shop?.replace(/\.myshopify\.com$/, '') || null,
    });
  }));

  api.post('/gilt/check', wrap(async (req, res) => res.json(await pollInbox({ trigger: 'manual' }))));

  api.get('/gilt/orders', wrap(async (req, res) => {
    const filter = String(req.query.filter || 'open');
    const where = {
      open: `status IN ('new','error','importing','imported','partial')`,
      new: `status IN ('new','error')`,
      imported: `status IN ('imported','partial')`,
      shipped: `status = 'shipped'`,
      old: `status IN ('old','ignored')`,
      all: 'true',
    }[filter] || 'true';
    const { rows } = await q(`SELECT * FROM gilt_orders WHERE ${where} ORDER BY (data->>'orderDate') DESC NULLS LAST, created_at DESC LIMIT 300`);
    const skus = [...new Set(rows.flatMap((r) => r.data.lines.map((l) => l.hostSku)))];
    const have = await q('SELECT DISTINCT sku FROM variants WHERE sku = ANY($1)', [skus]);
    const skuSet = new Set(have.rows.map((r) => r.sku));
    const asn = await q(
      `SELECT id, order_no, tracking, status, filename, error, created_at, sent_at FROM gilt_asn WHERE order_no = ANY($1) ORDER BY created_at`,
      [rows.map((r) => r.order_no)],
    );
    const asnBy = {};
    for (const a of asn.rows) (asnBy[a.order_no] ||= []).push(a);
    res.json({ orders: rows.map((r) => ({ ...summarize(r, skuSet), shipments: asnBy[r.order_no] || [] })) });
  }));

  api.post('/gilt/orders/:no/import', wrap(async (req, res) => {
    const r = await importOrder(req.params.no);
    if (r.error) return res.status(422).json(r);
    res.json(r);
  }));

  // Allows creating the order again after its Shopify order was cancelled.
  api.post('/gilt/orders/:no/reimport', wrap(async (req, res) => {
    const { rows } = await q('SELECT * FROM gilt_orders WHERE order_no=$1', [req.params.no]);
    const o = rows[0];
    if (!o) return res.status(404).json({ error: 'Not found' });
    if (o.shopify_order_id) {
      const d = await graphql(`query($id: ID!) { order(id: $id) { name cancelledAt } }`, { id: `gid://shopify/Order/${o.shopify_order_id}` });
      if (d.order && !d.order.cancelledAt) {
        return res.status(422).json({ error: `Cancel ${d.order.name} in Shopify first (More actions → Cancel order, restock the item), then try again.` });
      }
    }
    const sent = await q(`SELECT 1 FROM gilt_asn WHERE order_no=$1 AND status='sent'`, [o.order_no]);
    if (sent.rows.length) return res.status(422).json({ error: 'A shipment file was already sent for this order.' });
    await q(`DELETE FROM gilt_asn WHERE order_no=$1`, [o.order_no]);
    await q(`UPDATE gilt_orders SET status='new', shopify_order_id=NULL, shopify_order_name=NULL, imported_at=NULL, error=NULL WHERE order_no=$1`, [o.order_no]);
    const r = await importOrder(o.order_no);
    if (r.error) return res.status(422).json(r);
    res.json(r);
  }));

  api.post('/gilt/orders/:no/ignore', wrap(async (req, res) => {
    await q(`UPDATE gilt_orders SET status='ignored' WHERE order_no=$1 AND status IN ('new','error','old')`, [req.params.no]);
    res.json({ ok: true });
  }));

  api.post('/gilt/orders/:no/check-shipment', wrap(async (req, res) => res.json(await checkShipments(req.params.no))));

  async function sendXlsx(res, orders, name) {
    const cfg = await getOrderSettings();
    const buf = await buildFedexWorkbook(orders, cfg.fedex);
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);
  }

  api.get('/gilt/orders/:no/fedex.xlsx', wrap(async (req, res) => {
    const { rows } = await q('SELECT data FROM gilt_orders WHERE order_no=$1', [req.params.no]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    await sendXlsx(res, [rows[0].data], `FedEx_RueGilt_${req.params.no}.xlsx`);
  }));

  api.get('/gilt/fedex.xlsx', wrap(async (req, res) => {
    const list = String(req.query.orders || '').split(',').map((s) => s.trim()).filter(Boolean);
    const { rows } = list.length
      ? await q(`SELECT data FROM gilt_orders WHERE order_no = ANY($1) ORDER BY order_no`, [list])
      : await q(`SELECT data FROM gilt_orders WHERE status IN ('imported','partial') ORDER BY order_no`);
    if (!rows.length) return res.status(404).json({ error: 'No orders waiting to ship.' });
    const day = new Date().toISOString().slice(0, 10);
    await sendXlsx(res, rows.map((r) => r.data), `FedEx_RueGilt_${day}_${rows.length}orders.xlsx`);
  }));

  // Packing slips (PDF), one page per order — same layout as the Radial slip.
  async function sendSlips(res, orders, name) {
    const buf = await buildPackingSlips(orders, { logo: await slipLogo() });
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    res.type('application/pdf').send(buf);
  }

  // Logo printed at the top of packing slips (PNG or JPG you upload).
  api.get('/gilt/slip-logo', wrap(async (req, res) => {
    const logo = await slipLogo();
    if (!logo) return res.status(404).json({ error: 'No logo uploaded' });
    res.type(logo[0] === 0x89 ? 'image/png' : 'image/jpeg').send(logo);
  }));

  api.post('/gilt/slip-logo', logoUpload.single('file'), wrap(async (req, res) => {
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'No file uploaded' });
    const isPng = f.buffer.subarray(0, 4).toString('hex') === '89504e47';
    const isJpg = f.buffer.subarray(0, 3).toString('hex') === 'ffd8ff';
    if (!isPng && !isJpg) return res.status(422).json({ error: 'Use a PNG or JPG image.' });
    try {
      await buildPackingSlips([{ orderNo: 'TEST', lines: [] }], { logo: f.buffer });
    } catch (e) {
      return res.status(422).json({ error: `This image can't be used: ${e.message}` });
    }
    await kvSet('slipLogo', f.buffer.toString('base64'));
    res.json({ ok: true });
  }));

  api.delete('/gilt/slip-logo', wrap(async (req, res) => {
    await kvSet('slipLogo', '');
    res.json({ ok: true });
  }));

  api.get('/gilt/orders/:no/slip.pdf', wrap(async (req, res) => {
    const { rows } = await q('SELECT data FROM gilt_orders WHERE order_no=$1', [req.params.no]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    await sendSlips(res, [rows[0].data], `PackingSlip_RueGilt_${req.params.no}.pdf`);
  }));

  api.get('/gilt/slips.pdf', wrap(async (req, res) => {
    const list = String(req.query.orders || '').split(',').map((s) => s.trim()).filter(Boolean);
    const { rows } = list.length
      ? await q(`SELECT data FROM gilt_orders WHERE order_no = ANY($1) ORDER BY order_no`, [list])
      : await q(`SELECT data FROM gilt_orders WHERE status IN ('imported','partial') ORDER BY order_no`);
    if (!rows.length) return res.status(404).json({ error: 'No orders waiting to ship.' });
    const day = new Date().toISOString().slice(0, 10);
    await sendSlips(res, rows.map((r) => r.data), `PackingSlips_RueGilt_${day}_${rows.length}orders.pdf`);
  }));

  api.get('/gilt/asn/:id/csv', wrap(async (req, res) => {
    const { rows } = await q('SELECT filename, csv FROM gilt_asn WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.set('Content-Disposition', `attachment; filename="${rows[0].filename}"`);
    res.type('text/csv').send(rows[0].csv);
  }));

  api.post('/gilt/asn/:id/send', wrap(async (req, res) => {
    const r = await sendAsn(Number(req.params.id));
    if (r.error) return res.status(422).json(r);
    res.json(r);
  }));

  api.get('/gilt/files', wrap(async (req, res) => {
    const { rows } = await q(`SELECT name, size, mtime, seen_at, status, order_count, error FROM gilt_files ORDER BY mtime DESC NULLS LAST, seen_at DESC LIMIT 200`);
    res.json({ files: rows });
  }));

  api.get('/gilt/files/:name/raw', wrap(async (req, res) => {
    const { rows } = await q('SELECT name, content FROM gilt_files WHERE name=$1', [req.params.name]);
    if (!rows[0]?.content) return res.status(404).json({ error: 'File content not stored (older file).' });
    res.set('Content-Disposition', `attachment; filename="${rows[0].name}"`);
    res.type('text/plain').send(rows[0].content);
  }));

  api.put('/gilt/settings', wrap(async (req, res) => {
    const cur = await getOrderSettings();
    const b = req.body || {};
    const next = structuredClone(cur);
    for (const k of ['autoImport', 'autoAsn']) if (typeof b[k] === 'boolean') next[k] = b[k];
    if (b.pollMinutes !== undefined) next.pollMinutes = Math.min(60, Math.max(1, Number(b.pollMinutes) || 2));
    for (const k of ['getDir', 'shipDir', 'tag']) if (typeof b[k] === 'string' && b[k].trim()) next[k] = b[k].trim();
    if (['unitCost', 'retail'].includes(b.priceField)) next.priceField = b.priceField;
    if (b.fedex && typeof b.fedex === 'object') {
      for (const [k, v] of Object.entries(b.fedex)) {
        if (k in FEDEX_DEFAULTS && k !== 'serviceByShipMethod' && (typeof v === 'string' || typeof v === 'number')) next.fedex[k] = v;
      }
    }
    await saveOrderSettings(next);
    res.json({ settings: next });
  }));
}
