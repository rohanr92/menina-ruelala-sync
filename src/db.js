import pg from 'pg';

const { Pool } = pg;

const useSsl = process.env.DATABASE_SSL === 'true';
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  max: 5,
});

export const q = (text, params) => pool.query(text, params);

export const DEFAULT_SETTINGS = {
  sftp: {
    host: 'prd-transfer.vendornet.com',
    port: 22,
    username: 'RLL_218509',
    passwordEnc: null,
    directory: '/Live/Put/Inventory',
  },
  filePrefix: 'MeninaStep_Inventory',
  skuPrefix: '1311',
  locationIds: [], // empty = all active locations
  schedule: { enabled: true, times: ['06:00', '18:00'], timezone: 'America/New_York' },
  instant: { enabled: true, mode: 'changes', debounceSeconds: 120 },
  paused: false,
};

export async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS shop_sessions (
      shop TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      scope TEXT,
      refresh_token TEXT,
      expires_at TIMESTAMPTZ,
      refresh_expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS settings (
      id INT PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS mappings (
      host_sku TEXT PRIMARY KEY,
      supplier_sku TEXT NOT NULL,
      description TEXT,
      source TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS variants (
      inventory_item_id BIGINT PRIMARY KEY,
      variant_id BIGINT,
      product_id BIGINT,
      sku TEXT,
      product_title TEXT,
      variant_title TEXT,
      levels JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS variants_sku_idx ON variants (sku);
    CREATE TABLE IF NOT EXISTS locations (
      id BIGINT PRIMARY KEY,
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS pending_changes (
      host_sku TEXT PRIMARY KEY,
      queued_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sync_runs (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      row_count INT,
      units INT,
      filename TEXT,
      remote_path TEXT,
      error TEXT,
      csv TEXT,
      skus TEXT[],
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS sync_runs_started_idx ON sync_runs (started_at DESC);
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

export async function getSettings() {
  const { rows } = await q('SELECT data FROM settings WHERE id = 1');
  const stored = rows[0]?.data || {};
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    sftp: { ...DEFAULT_SETTINGS.sftp, ...(stored.sftp || {}) },
    schedule: { ...DEFAULT_SETTINGS.schedule, ...(stored.schedule || {}) },
    instant: { ...DEFAULT_SETTINGS.instant, ...(stored.instant || {}) },
  };
}

export async function saveSettings(data) {
  await q(
    `INSERT INTO settings (id, data, updated_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [data],
  );
}

export async function kvGet(key) {
  const { rows } = await q('SELECT value FROM kv WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

export async function kvSet(key, value) {
  await q(
    `INSERT INTO kv (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}
