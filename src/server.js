import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, q, getSettings, saveSettings, kvGet, kvSet } from './db.js';
import { encrypt, nextScheduled } from './util.js';
import {
  verifySessionToken, verifyWebhookHmac, exchangeToken, getSession, deleteSession, registerWebhooks,
} from './shopify.js';
import {
  runSync, refreshCatalog, testSftp, onInventoryLevelUpdate, onProductUpdate,
  startScheduler, currentRun, instantDueAt, countedLocationIds, scheduleInstant,
} from './sync.js';
import { buildRows } from './feed.js';
import { parseMappingFile } from './mappingImport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;
const APP_URL = (process.env.SHOPIFY_APP_URL || '').replace(/\/$/, '');
const DEV = process.env.DEV_BYPASS_AUTH === 'true';

const app = express();
app.disable('x-powered-by');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const log = (...a) => console.log(new Date().toISOString(), '[web]', ...a);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ---------- Webhooks (raw body for HMAC) ---------- */

app.post('/webhooks', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  if (!verifyWebhookHmac(req.body, req.get('X-Shopify-Hmac-Sha256'))) return res.sendStatus(401);
  res.sendStatus(200); // acknowledge fast; Shopify retries on slow responses
  const topic = req.get('X-Shopify-Topic');
  const shop = req.get('X-Shopify-Shop-Domain');
  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); } catch { return; }
  const handle = {
    'inventory_levels/update': () => onInventoryLevelUpdate(payload),
    'products/update': () => onProductUpdate(payload),
    'app/uninstalled': () => deleteSession(shop),
  }[topic];
  if (handle) handle().catch((e) => log(`webhook ${topic} error:`, e.message));
});

app.use(express.json({ limit: '5mb' }));

/* ---------- Embedded page ---------- */

function sendIndex(req, res) {
  const shop = String(req.query.shop || '');
  const frame = /^[a-z0-9-]+\.myshopify\.com$/.test(shop) ? `https://${shop}` : '';
  res.set('Content-Security-Policy', `frame-ancestors https://admin.shopify.com ${frame}`.trim());
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
    .replace('__SHOPIFY_API_KEY__', process.env.SHOPIFY_API_KEY || '')
    .replace('{{DEV}}', DEV ? 'true' : 'false')
    .replace('__APP_BRIDGE__', DEV ? '' : '<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>');
  res.type('html').send(html);
}

app.get('/', sendIndex);
app.use('/assets', express.static(path.join(PUBLIC, 'assets'), { maxAge: '1h' }));
app.get('/healthz', (req, res) => res.json({ ok: true }));

/* ---------- API auth (App Bridge session token) ---------- */

const api = express.Router();

api.use(wrap(async (req, res, next) => {
  if (DEV) { req.shop = 'dev'; return next(); }
  const token = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  try {
    const payload = verifySessionToken(token);
    req.shop = payload.shop;
    req.idToken = token;
    next();
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
}));

api.get('/bootstrap', wrap(async (req, res) => {
  let session = await getSession();
  if (!DEV && (!session || session.shop !== req.shop)) {
    await exchangeToken(req.shop, req.idToken);
    session = await getSession();
  }
  let webhookError = null;
  if (!DEV && APP_URL && (await kvGet('webhooksFor')) !== APP_URL) {
    try {
      await registerWebhooks(APP_URL);
      await kvSet('webhooksFor', APP_URL);
    } catch (e) {
      webhookError = e.message;
      log('webhook registration failed:', e.message);
    }
  }
  const { rows } = await q('SELECT count(*)::int AS n FROM variants');
  if (!DEV && rows[0].n === 0 && !(await kvGet('catalogRefreshedAt'))) {
    refreshCatalog().catch((e) => log('initial catalog load failed:', e.message));
  }
  res.json({ shop: session?.shop || req.shop, webhookError });
}));

/* ---------- Overview ---------- */

api.get('/overview', wrap(async (req, res) => {
  const settings = await getSettings();
  const locationIds = await countedLocationIds(settings);
  const [vars, maps, pending, lastFull, lastChanges, lastFailed, stats, recent, catalogAt] = await Promise.all([
    q('SELECT sku, levels FROM variants'),
    q('SELECT host_sku, supplier_sku FROM mappings'),
    q('SELECT count(*)::int AS n FROM pending_changes'),
    q(`SELECT id, status, row_count, units, filename, started_at, finished_at, trigger, error
       FROM sync_runs WHERE kind='full' ORDER BY started_at DESC LIMIT 1`),
    q(`SELECT id, status, row_count, units, filename, started_at, finished_at, trigger, error
       FROM sync_runs WHERE kind='changes' ORDER BY started_at DESC LIMIT 1`),
    q(`SELECT id, kind, error, started_at FROM sync_runs
       WHERE status='failed' AND started_at > now() - interval '24 hours'
       ORDER BY started_at DESC LIMIT 1`),
    q(`SELECT count(*) FILTER (WHERE status='success')::int AS ok,
              count(*) FILTER (WHERE status='failed')::int AS failed,
              count(*) FILTER (WHERE status='success' AND kind='changes')::int AS instant,
              coalesce(sum(row_count) FILTER (WHERE status='success' AND kind='changes'),0)::int AS instant_rows
       FROM sync_runs WHERE started_at > now() - interval '24 hours'`),
    q(`SELECT id, kind, trigger, status, row_count, units, filename, error, started_at, finished_at
       FROM sync_runs ORDER BY started_at DESC LIMIT 6`),
    kvGet('catalogRefreshedAt'),
  ]);
  const mappings = new Map(maps.rows.map((r) => [r.host_sku, r]));
  const built = buildRows({ variants: vars.rows, mappings, locationIds, prefix: settings.skuPrefix, zeroMissing: settings.zeroMissing !== false });
  const shopifySkus = new Set(vars.rows.map((v) => v.sku));
  const missingInShopify = maps.rows.filter((m) => !shopifySkus.has(m.host_sku)).length;
  const run = currentRun();

  res.json({
    paused: settings.paused,
    running: run,
    sftpHost: settings.sftp.host,
    skuPrefix: settings.skuPrefix,
    sftpConfigured: Boolean(settings.sftp.host && settings.sftp.username && (settings.sftp.passwordEnc || process.env.SFTP_PASSWORD)),
    schedule: {
      enabled: settings.schedule.enabled,
      times: settings.schedule.times,
      timezone: settings.schedule.timezone,
      next: settings.schedule.enabled && !settings.paused
        ? nextScheduled(settings.schedule.times, settings.schedule.timezone) : null,
    },
    instant: { ...settings.instant, pending: pending.rows[0].n, dueAt: instantDueAt() },
    lastFull: lastFull.rows[0] || null,
    lastChanges: lastChanges.rows[0] || null,
    lastFailed: lastFailed.rows[0] || null,
    stats24h: stats.rows[0],
    catalog: {
      refreshedAt: catalogAt,
      shopifyVariants: shopifySkus.size,
      mappings: maps.rows.length,
      sending: built.rows.length,
      units: built.rows.reduce((a, r) => a + r.qty, 0),
      inStock: built.rows.filter((r) => r.qty > 0).length,
      unmapped: built.unmapped.length,
      missingInShopify,
      zeroMissing: settings.zeroMissing !== false,
      fromShopify: built.rows.filter((r) => !r.missing).length,
      duplicates: built.duplicates.length,
      negatives: built.negatives.length,
    },
    recent: recent.rows,
  });
}));

/* ---------- Sync actions ---------- */

api.post('/sync', wrap(async (req, res) => {
  const kind = req.body.kind === 'changes' ? 'changes' : 'full';
  if (kind === 'changes') {
    const { rows } = await q('SELECT count(*)::int AS n FROM pending_changes');
    if (!rows[0].n) return res.json({ started: false, message: 'No inventory changes are waiting to be sent.' });
  }
  runSync({ kind, trigger: 'manual' }).catch(() => {});
  res.json({ started: true });
}));

api.post('/catalog/refresh', wrap(async (req, res) => {
  const r = await refreshCatalog();
  res.json(r);
}));

/* ---------- History ---------- */

api.get('/runs', wrap(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const per = 25;
  const where = [];
  const params = [];
  if (['full', 'changes'].includes(req.query.kind)) { params.push(req.query.kind); where.push(`kind = $${params.length}`); }
  if (['success', 'failed'].includes(req.query.status)) { params.push(req.query.status); where.push(`status = $${params.length}`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [list, count] = await Promise.all([
    q(`SELECT id, kind, trigger, status, row_count, units, filename, remote_path, error, started_at, finished_at
       FROM sync_runs ${w} ORDER BY started_at DESC LIMIT ${per} OFFSET ${(page - 1) * per}`, params),
    q(`SELECT count(*)::int AS n FROM sync_runs ${w}`, params),
  ]);
  res.json({ runs: list.rows, total: count.rows[0].n, page, per });
}));

api.get('/runs/:id', wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT id, kind, trigger, status, row_count, units, filename, remote_path, error, skus, started_at, finished_at
     FROM sync_runs WHERE id = $1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
}));

api.get('/runs/:id/csv', wrap(async (req, res) => {
  const { rows } = await q('SELECT filename, csv FROM sync_runs WHERE id = $1', [req.params.id]);
  if (!rows[0]?.csv) return res.status(404).json({ error: 'No file for this run' });
  res.set('Content-Disposition', `attachment; filename="${rows[0].filename}"`);
  res.type('text/csv').send(rows[0].csv);
}));

/* ---------- SKUs ---------- */

api.get('/skus', wrap(async (req, res) => {
  const settings = await getSettings();
  const locationIds = await countedLocationIds(settings);
  const search = String(req.query.search || '').trim().toLowerCase();
  const filter = String(req.query.filter || 'all');
  const page = Math.max(1, Number(req.query.page) || 1);
  const per = 50;

  const [vars, maps, pend] = await Promise.all([
    q('SELECT sku, product_title, variant_title, levels, product_id FROM variants'),
    q('SELECT host_sku, supplier_sku, description, source, updated_at FROM mappings'),
    q('SELECT host_sku FROM pending_changes'),
  ]);
  const pending = new Set(pend.rows.map((r) => r.host_sku));
  const bySku = new Map();
  for (const v of vars.rows) {
    if (!v.sku.startsWith(settings.skuPrefix)) continue;
    const entry = bySku.get(v.sku);
    if (entry) { entry.duplicate = true; continue; }
    let raw = 0;
    for (const id of locationIds) raw += Number(v.levels?.[id] ?? 0);
    bySku.set(v.sku, {
      hostSku: v.sku, product: v.product_title, variant: v.variant_title, productId: v.product_id,
      qty: Math.max(0, raw), rawQty: raw, inShopify: true,
    });
  }
  for (const m of maps.rows) {
    const e = bySku.get(m.host_sku) || { hostSku: m.host_sku, product: m.description, inShopify: false, qty: null };
    e.supplierSku = m.supplier_sku;
    e.description = m.description;
    bySku.set(m.host_sku, e);
  }
  const zeroMissing = settings.zeroMissing !== false;
  let items = [...bySku.values()].map((e) => ({
    ...e,
    qty: !e.inShopify && e.supplierSku && zeroMissing ? 0 : e.qty,
    pending: pending.has(e.hostSku),
    status: !e.inShopify ? 'missing' : !e.supplierSku ? 'unmapped' : e.duplicate ? 'duplicate' : 'ok',
  }));
  const counts = {
    all: items.length,
    ok: items.filter((i) => i.status === 'ok').length,
    unmapped: items.filter((i) => i.status === 'unmapped').length,
    missing: items.filter((i) => i.status === 'missing').length,
    duplicate: items.filter((i) => i.status === 'duplicate').length,
    instock: items.filter((i) => i.status === 'ok' && i.qty > 0).length,
  };
  if (filter === 'instock') items = items.filter((i) => i.status === 'ok' && i.qty > 0);
  else if (filter !== 'all') items = items.filter((i) => i.status === filter);
  if (search) {
    items = items.filter((i) => [i.hostSku, i.supplierSku, i.product, i.variant, i.description]
      .some((x) => String(x || '').toLowerCase().includes(search)));
  }
  items.sort((a, b) => (a.supplierSku || 'zzz').localeCompare(b.supplierSku || 'zzz') || a.hostSku.localeCompare(b.hostSku));
  const total = items.length;
  res.json({ items: items.slice((page - 1) * per, page * per), total, page, per, counts });
}));

/* ---------- SKU mapping import ---------- */

api.post('/mappings/preview', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const settings = await getSettings();
  let parsed;
  try {
    parsed = await parseMappingFile(req.file.buffer, req.file.originalname, settings.skuPrefix);
  } catch (e) {
    return res.status(422).json({ error: e.message });
  }
  const [maps, vars] = await Promise.all([
    q('SELECT host_sku, supplier_sku FROM mappings'),
    q('SELECT sku FROM variants'),
  ]);
  const existing = new Map(maps.rows.map((r) => [r.host_sku, r.supplier_sku]));
  const inShopify = new Set(vars.rows.map((r) => r.sku));
  const rows = parsed.rows.map((r) => ({
    ...r,
    change: !existing.has(r.host_sku) ? 'new' : existing.get(r.host_sku) !== r.supplier_sku ? 'changed' : 'same',
    previous: existing.get(r.host_sku) || null,
    inShopify: inShopify.has(r.host_sku),
  }));
  res.json({
    fileName: req.file.originalname,
    source: parsed.source,
    columns: parsed.columns,
    errors: parsed.errors,
    warnings: parsed.warnings,
    rows,
    summary: {
      total: rows.length,
      new: rows.filter((r) => r.change === 'new').length,
      changed: rows.filter((r) => r.change === 'changed').length,
      same: rows.filter((r) => r.change === 'same').length,
      notInShopify: rows.filter((r) => !r.inShopify).length,
      styles: new Set(rows.map((r) => r.supplier_sku)).size,
    },
  });
}));

api.post('/mappings/import', wrap(async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  const source = String(req.body.source || 'import').slice(0, 200);
  let n = 0;
  const changedSkus = [];
  for (const r of rows) {
    const host = String(r.host_sku || '').trim();
    const supplier = String(r.supplier_sku || '').trim();
    if (!/^\d{14}$/.test(host) || !supplier) continue;
    const { rows: prev } = await q('SELECT supplier_sku FROM mappings WHERE host_sku=$1', [host]);
    await q(
      `INSERT INTO mappings (host_sku, supplier_sku, description, source, updated_at) VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (host_sku) DO UPDATE SET supplier_sku=EXCLUDED.supplier_sku,
         description=COALESCE(NULLIF(EXCLUDED.description,''), mappings.description),
         source=EXCLUDED.source, updated_at=now()`,
      [host, supplier, String(r.description || ''), source],
    );
    if (prev[0]?.supplier_sku !== supplier) changedSkus.push(host);
    n++;
  }
  // New or changed SKUs go out with the next instant sync.
  for (const sku of changedSkus) {
    await q(`INSERT INTO pending_changes (host_sku) VALUES ($1) ON CONFLICT (host_sku) DO UPDATE SET queued_at = now()`, [sku]);
  }
  if (changedSkus.length) {
    scheduleInstant().catch(() => {});
  }
  res.json({ imported: n, queued: changedSkus.length });
}));

api.put('/mappings/:host', wrap(async (req, res) => {
  const supplier = String(req.body.supplier_sku || '').trim();
  if (!supplier) return res.status(400).json({ error: 'Supplier SKU is required' });
  await q(
    `INSERT INTO mappings (host_sku, supplier_sku, source, updated_at) VALUES ($1,$2,'manual edit', now())
     ON CONFLICT (host_sku) DO UPDATE SET supplier_sku=EXCLUDED.supplier_sku, source='manual edit', updated_at=now()`,
    [req.params.host, supplier],
  );
  await q(`INSERT INTO pending_changes (host_sku) VALUES ($1) ON CONFLICT (host_sku) DO UPDATE SET queued_at = now()`, [req.params.host]);
  scheduleInstant().catch(() => {});
  res.json({ ok: true });
}));

api.delete('/mappings/:host', wrap(async (req, res) => {
  await q('DELETE FROM mappings WHERE host_sku = $1', [req.params.host]);
  res.json({ ok: true });
}));

api.get('/mappings/export', wrap(async (req, res) => {
  const { rows } = await q('SELECT host_sku, supplier_sku, description FROM mappings ORDER BY supplier_sku, host_sku');
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = ['Host SKU,Supplier SKU,Description', ...rows.map((r) => [r.host_sku, r.supplier_sku, r.description].map(esc).join(','))].join('\n') + '\n';
  res.set('Content-Disposition', 'attachment; filename="ruelala-sku-mapping.csv"');
  res.type('text/csv').send(csv);
}));

/* ---------- Settings ---------- */

function publicSettings(s) {
  const { passwordEnc, ...sftp } = s.sftp;
  return { ...s, sftp: { ...sftp, hasPassword: Boolean(passwordEnc) || Boolean(process.env.SFTP_PASSWORD) } };
}

api.get('/settings', wrap(async (req, res) => {
  const [settings, locs] = await Promise.all([getSettings(), q('SELECT id, name, active FROM locations ORDER BY name')]);
  res.json({ settings: publicSettings(settings), locations: locs.rows.map((l) => ({ ...l, id: String(l.id) })) });
}));

function mergeSettings(current, body) {
  const next = structuredClone(current);
  const b = body || {};
  if (b.sftp) {
    for (const k of ['host', 'username', 'directory']) if (typeof b.sftp[k] === 'string') next.sftp[k] = b.sftp[k].trim();
    if (b.sftp.port !== undefined) next.sftp.port = Number(b.sftp.port) || 22;
    if (typeof b.sftp.password === 'string' && b.sftp.password.length) next.sftp.passwordEnc = encrypt(b.sftp.password);
  }
  if (typeof b.filePrefix === 'string') next.filePrefix = b.filePrefix.trim() || current.filePrefix;
  if (typeof b.skuPrefix === 'string' && /^\d{1,8}$/.test(b.skuPrefix.trim())) next.skuPrefix = b.skuPrefix.trim();
  if (Array.isArray(b.locationIds)) next.locationIds = b.locationIds.map(String);
  if (b.schedule) {
    if (typeof b.schedule.enabled === 'boolean') next.schedule.enabled = b.schedule.enabled;
    if (Array.isArray(b.schedule.times)) {
      next.schedule.times = [...new Set(b.schedule.times.filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)))].sort();
    }
    if (typeof b.schedule.timezone === 'string') next.schedule.timezone = b.schedule.timezone;
  }
  if (b.instant) {
    if (typeof b.instant.enabled === 'boolean') next.instant.enabled = b.instant.enabled;
    if (['changes', 'full'].includes(b.instant.mode)) next.instant.mode = b.instant.mode;
    if (b.instant.debounceSeconds !== undefined) {
      next.instant.debounceSeconds = Math.min(3600, Math.max(60, Number(b.instant.debounceSeconds) || 120));
    }
  }
  if (typeof b.paused === 'boolean') next.paused = b.paused;
  if (typeof b.zeroMissing === 'boolean') next.zeroMissing = b.zeroMissing;
  return next;
}

api.put('/settings', wrap(async (req, res) => {
  const current = await getSettings();
  const next = mergeSettings(current, req.body);
  try { new Intl.DateTimeFormat('en-US', { timeZone: next.schedule.timezone }); } catch {
    return res.status(400).json({ error: 'Unknown time zone' });
  }
  await saveSettings(next);
  res.json({ settings: publicSettings(next) });
}));

api.post('/settings/test-sftp', wrap(async (req, res) => {
  const current = await getSettings();
  const candidate = mergeSettings(current, { sftp: req.body.sftp || {} });
  try {
    res.json(await testSftp(candidate));
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
}));

app.use('/api', api);

// Any other page path (App Bridge navigation) -> the app shell.
app.get(/^\/(overview|skus|import|history|settings)?\/?$/, sendIndex);

app.use((err, req, res, next) => {
  log('error:', err.stack || err.message);
  res.status(500).json({ error: err.message || 'Server error' });
});

await migrate();
startScheduler();
app.listen(PORT, () => log(`listening on :${PORT}${DEV ? ' (DEV auth bypass)' : ''}`));
