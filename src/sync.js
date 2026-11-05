import SftpClient from 'ssh2-sftp-client';
import { pool, q, getSettings, kvGet, kvSet } from './db.js';
import { decrypt, zonedParts } from './util.js';
import { buildRows, toCsv, fileName, countedQty } from './feed.js';
import {
  fetchLocations, fetchVariantsBySkuPrefix, fetchVariantByInventoryItem, getSession,
} from './shopify.js';

const log = (...a) => console.log(new Date().toISOString(), '[sync]', ...a);

/* ---------- serialize all syncs in this process ---------- */
let chain = Promise.resolve();
let running = null; // { kind, trigger, startedAt }
function exclusive(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}
export const currentRun = () => running;

/* ---------- locations / catalog cache ---------- */

export async function countedLocationIds(settings) {
  if (settings.locationIds?.length) return settings.locationIds.map(String);
  const { rows } = await q('SELECT id FROM locations WHERE active');
  return rows.map((r) => String(r.id));
}

export async function refreshCatalog() {
  const settings = await getSettings();
  const locations = await fetchLocations();
  const variants = await fetchVariantsBySkuPrefix(settings.skuPrefix);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const l of locations) {
      await client.query(
        `INSERT INTO locations (id, name, active) VALUES ($1,$2,$3)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, active=EXCLUDED.active`,
        [l.id, l.name, l.active],
      );
    }
    await client.query('DELETE FROM variants');
    for (const v of variants) {
      await client.query(
        `INSERT INTO variants (inventory_item_id, variant_id, product_id, sku, product_title, variant_title, levels, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (inventory_item_id) DO NOTHING`,
        [v.inventory_item_id, v.variant_id, v.product_id, v.sku, v.product_title, v.variant_title, v.levels],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await kvSet('catalogRefreshedAt', new Date().toISOString());
  log(`catalog refreshed: ${variants.length} variants, ${locations.length} locations`);
  return { variants: variants.length, locations: locations.length };
}

async function loadMappings() {
  const { rows } = await q('SELECT host_sku, supplier_sku FROM mappings');
  return new Map(rows.map((r) => [r.host_sku, r]));
}

async function loadVariants() {
  const { rows } = await q('SELECT sku, levels, inventory_item_id FROM variants');
  return rows;
}

/* ---------- SFTP ---------- */

function sftpConfig(settings) {
  const s = settings.sftp;
  const password = process.env.SFTP_PASSWORD || decrypt(s.passwordEnc);
  if (!s.host || !s.username || !password) throw new Error('SFTP is not configured (host, user and password are required).');
  return {
    host: s.host,
    port: Number(s.port) || 22,
    username: s.username,
    password,
    readyTimeout: 20000,
    retries: 2,
    retry_minTimeout: 2000,
  };
}

const remoteDir = (settings) => (settings.sftp.directory || '/').replace(/\/+$/, '') || '';

export async function testSftp(settingsOverride) {
  const settings = settingsOverride || (await getSettings());
  const sftp = new SftpClient();
  const started = Date.now();
  try {
    await sftp.connect(sftpConfig(settings));
    const dir = remoteDir(settings) || '/';
    const exists = await sftp.exists(dir);
    if (!exists) throw new Error(`Connected, but folder "${dir}" does not exist.`);
    const list = await sftp.list(dir);
    return { ok: true, ms: Date.now() - started, files: list.length, dir };
  } finally {
    await sftp.end().catch(() => {});
  }
}

async function upload(settings, name, csv) {
  const sftp = new SftpClient();
  try {
    await sftp.connect(sftpConfig(settings));
    const path = `${remoteDir(settings)}/${name}`;
    await sftp.put(Buffer.from(csv, 'utf8'), path);
    return path;
  } finally {
    await sftp.end().catch(() => {});
  }
}

/* ---------- the sync itself ---------- */

let lastFileName = null;

/**
 * kind: 'full' | 'changes'
 * trigger: 'schedule' | 'webhook' | 'manual'
 * Returns the sync_runs row, or null when there was nothing to send.
 */
export function runSync({ kind, trigger }) {
  return exclusive(async () => {
    const settings = await getSettings();
    if (settings.paused && trigger !== 'manual') {
      log(`skipped ${kind}/${trigger}: syncing is paused`);
      return null;
    }
    if (!(await getSession())) throw new Error('App is not connected to a store yet.');

    const startedAt = new Date();
    running = { kind, trigger, startedAt };
    let pendingSnapshot = [];
    let runId = null;
    try {
      if (kind === 'full' && trigger !== 'webhook') await refreshCatalog();

      if (kind === 'changes') {
        const { rows } = await q('SELECT host_sku FROM pending_changes WHERE queued_at <= $1', [startedAt]);
        pendingSnapshot = rows.map((r) => r.host_sku);
        if (!pendingSnapshot.length) return null;
      }

      const [variants, mappings, locationIds] = await Promise.all([
        loadVariants(), loadMappings(), countedLocationIds(settings),
      ]);
      const { rows } = buildRows({
        variants,
        mappings,
        locationIds,
        prefix: settings.skuPrefix,
        onlySkus: kind === 'changes' ? new Set(pendingSnapshot) : null,
      });

      if (kind === 'changes' && !rows.length) {
        await q('DELETE FROM pending_changes WHERE host_sku = ANY($1)', [pendingSnapshot]);
        return null;
      }

      const csv = toCsv(rows);
      let name = fileName(settings.filePrefix, startedAt, settings.schedule.timezone);
      if (name === lastFileName) name = name.replace(/\.csv$/, '_2.csv');
      lastFileName = name;
      const units = rows.reduce((a, r) => a + r.qty, 0);

      const ins = await q(
        `INSERT INTO sync_runs (kind, trigger, status, row_count, units, filename, csv, skus, started_at)
         VALUES ($1,$2,'running',$3,$4,$5,$6,$7,$8) RETURNING id`,
        [kind, trigger, rows.length, units, name, csv,
          kind === 'changes' ? rows.map((r) => r.hostSku) : null, startedAt],
      );
      runId = ins.rows[0].id;

      const remotePath = await upload(settings, name, csv);

      if (kind === 'full') await q('DELETE FROM pending_changes WHERE queued_at <= $1', [startedAt]);
      else await q('DELETE FROM pending_changes WHERE host_sku = ANY($1) AND queued_at <= $2', [pendingSnapshot, startedAt]);

      const done = await q(
        `UPDATE sync_runs SET status='success', remote_path=$2, finished_at=now() WHERE id=$1 RETURNING *`,
        [runId, remotePath],
      );
      log(`${kind}/${trigger} ok: ${rows.length} rows -> ${remotePath}`);
      return done.rows[0];
    } catch (err) {
      log(`${kind}/${trigger} FAILED:`, err.message);
      if (runId) {
        await q(`UPDATE sync_runs SET status='failed', error=$2, finished_at=now() WHERE id=$1`, [runId, err.message]);
      } else {
        await q(
          `INSERT INTO sync_runs (kind, trigger, status, error, started_at, finished_at)
           VALUES ($1,$2,'failed',$3,$4, now())`,
          [kind, trigger, err.message, startedAt],
        );
      }
      throw err;
    } finally {
      running = null;
    }
  });
}

/* ---------- instant sync (webhooks + debounce) ---------- */

let debounceTimer = null;
let debounceDueAt = null;
export const instantDueAt = () => debounceDueAt;

export async function scheduleInstant() {
  const settings = await getSettings();
  if (!settings.instant.enabled || settings.paused) return;
  if (debounceTimer) return; // a batch is already waiting; it will pick these up
  const wait = Math.max(10, Number(settings.instant.debounceSeconds) || 120) * 1000;
  debounceDueAt = new Date(Date.now() + wait);
  debounceTimer = setTimeout(async () => {
    debounceTimer = null;
    debounceDueAt = null;
    const s = await getSettings();
    const kind = s.instant.mode === 'full' ? 'full' : 'changes';
    try {
      await runSync({ kind, trigger: 'webhook' });
    } catch {
      // Pending changes stay queued; retry in a few minutes.
      setTimeout(() => scheduleInstant().catch(() => {}), 5 * 60000);
    }
  }, wait);
}

async function queueChange(sku) {
  await q(
    `INSERT INTO pending_changes (host_sku, queued_at) VALUES ($1, now())
     ON CONFLICT (host_sku) DO UPDATE SET queued_at = now()`,
    [sku],
  );
  await scheduleInstant();
}

async function upsertVariant(v) {
  await q(
    `INSERT INTO variants (inventory_item_id, variant_id, product_id, sku, product_title, variant_title, levels, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (inventory_item_id) DO UPDATE SET variant_id=EXCLUDED.variant_id, product_id=EXCLUDED.product_id,
       sku=EXCLUDED.sku, product_title=EXCLUDED.product_title, variant_title=EXCLUDED.variant_title,
       levels=EXCLUDED.levels, updated_at=now()`,
    [v.inventory_item_id, v.variant_id, v.product_id, v.sku, v.product_title, v.variant_title, v.levels],
  );
}

export async function onInventoryLevelUpdate(payload) {
  const itemId = Number(payload.inventory_item_id);
  const locationId = String(payload.location_id);
  const available = Number(payload.available ?? 0);
  const settings = await getSettings();

  const { rows } = await q('SELECT * FROM variants WHERE inventory_item_id = $1', [itemId]);
  let v = rows[0];
  if (!v) {
    // Unknown item: maybe a new product. Look it up once.
    const fresh = await fetchVariantByInventoryItem(itemId).catch(() => null);
    if (!fresh || !fresh.sku.startsWith(settings.skuPrefix)) return;
    await upsertVariant(fresh);
    await queueChange(fresh.sku);
    return;
  }
  if (!String(v.sku || '').startsWith(settings.skuPrefix)) return;

  const locationIds = await countedLocationIds(settings);
  const before = countedQty(v.levels, locationIds);
  const levels = { ...v.levels, [locationId]: available };
  await q('UPDATE variants SET levels=$2, updated_at=now() WHERE inventory_item_id=$1', [itemId, levels]);
  const after = countedQty(levels, locationIds);
  if (before !== after) await queueChange(v.sku);
}

export async function onProductUpdate(payload) {
  const settings = await getSettings();
  for (const pv of payload.variants || []) {
    const itemId = Number(pv.inventory_item_id);
    if (!itemId) continue;
    const sku = (pv.sku || '').trim();
    const { rows } = await q('SELECT sku FROM variants WHERE inventory_item_id = $1', [itemId]);
    if (rows[0]) {
      await q(
        'UPDATE variants SET sku=$2, product_title=$3, variant_title=$4, updated_at=now() WHERE inventory_item_id=$1',
        [itemId, sku, payload.title || '', pv.title || ''],
      );
      if (rows[0].sku !== sku && sku.startsWith(settings.skuPrefix)) await queueChange(sku);
    } else if (sku.startsWith(settings.skuPrefix)) {
      const fresh = await fetchVariantByInventoryItem(itemId).catch(() => null);
      if (fresh) {
        await upsertVariant(fresh);
        await queueChange(fresh.sku);
      }
    }
  }
}

/* ---------- twice-daily schedule ---------- */

let retryTimer = null;

async function tick() {
  const settings = await getSettings();
  if (!settings.schedule.enabled || settings.paused) return;
  const { date, time } = zonedParts(new Date(), settings.schedule.timezone);
  if (!settings.schedule.times.includes(time)) return;
  const slot = `${date} ${time}`;
  if ((await kvGet('lastScheduledSlot')) === slot) return;
  await kvSet('lastScheduledSlot', slot);
  log(`scheduled full sync for ${slot} ${settings.schedule.timezone}`);
  try {
    await runSync({ kind: 'full', trigger: 'schedule' });
  } catch {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => runSync({ kind: 'full', trigger: 'schedule' }).catch(() => {}), 10 * 60000);
  }
}

export function startScheduler() {
  setInterval(() => tick().catch((e) => log('scheduler error', e.message)), 20000);
  // Resume any instant sync that was waiting when the server restarted.
  q('SELECT count(*)::int AS n FROM pending_changes')
    .then(({ rows }) => rows[0].n && scheduleInstant())
    .catch(() => {});
}
