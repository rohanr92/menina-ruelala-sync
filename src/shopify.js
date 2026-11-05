import crypto from 'node:crypto';
import { q } from './db.js';
import { timingSafeEqual, sleep } from './util.js';

const API_KEY = () => process.env.SHOPIFY_API_KEY;
const API_SECRET = () => process.env.SHOPIFY_API_SECRET;
const API_VERSION = () => process.env.SHOPIFY_API_VERSION || '2026-10';

const gid = (type, id) => `gid://shopify/${type}/${id}`;
export const idFromGid = (g) => (g ? Number(String(g).split('/').pop()) : null);

/* ---------- Session tokens (App Bridge) ---------- */

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function verifySessionToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed session token');
  const [h, p, s] = parts;
  const expected = b64url(crypto.createHmac('sha256', API_SECRET()).update(`${h}.${p}`).digest());
  if (!timingSafeEqual(expected, s)) throw new Error('Bad session token signature');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now > payload.exp + 5) throw new Error('Session token expired');
  if (payload.nbf && now < payload.nbf - 5) throw new Error('Session token not yet valid');
  if (payload.aud !== API_KEY()) throw new Error('Session token audience mismatch');
  const shop = new URL(payload.dest).hostname;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw new Error('Invalid shop');
  return { ...payload, shop };
}

export function verifyWebhookHmac(rawBody, hmacHeader) {
  const digest = crypto.createHmac('sha256', API_SECRET()).update(rawBody).digest('base64');
  return timingSafeEqual(digest, hmacHeader);
}

/* ---------- Offline access token (token exchange) ---------- */

async function storeTokenResponse(shop, data) {
  const now = Date.now();
  await q(
    `INSERT INTO shop_sessions (shop, access_token, scope, refresh_token, expires_at, refresh_expires_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (shop) DO UPDATE SET access_token=EXCLUDED.access_token, scope=EXCLUDED.scope,
       refresh_token=EXCLUDED.refresh_token, expires_at=EXCLUDED.expires_at,
       refresh_expires_at=EXCLUDED.refresh_expires_at, updated_at=now()`,
    [
      shop,
      data.access_token,
      data.scope || null,
      data.refresh_token || null,
      data.expires_in ? new Date(now + data.expires_in * 1000) : null,
      data.refresh_token_expires_in ? new Date(now + data.refresh_token_expires_in * 1000) : null,
    ],
  );
}

export async function exchangeToken(shop, idToken) {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: API_KEY(),
      client_secret: API_SECRET(),
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: idToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  await storeTokenResponse(shop, await res.json());
}

async function refreshToken(shop, refresh) {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: API_KEY(),
      client_secret: API_SECRET(),
      grant_type: 'refresh_token',
      refresh_token: refresh,
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
  await storeTokenResponse(shop, await res.json());
}

export async function getSession() {
  const shop = process.env.SHOPIFY_SHOP;
  const { rows } = shop
    ? await q('SELECT * FROM shop_sessions WHERE shop = $1', [shop])
    : await q('SELECT * FROM shop_sessions ORDER BY updated_at DESC LIMIT 1');
  const s = rows[0];
  if (!s) return null;
  if (s.expires_at && s.refresh_token && new Date(s.expires_at).getTime() - Date.now() < 5 * 60000) {
    await refreshToken(s.shop, s.refresh_token);
    return getSession();
  }
  return s;
}

export async function deleteSession(shop) {
  await q('DELETE FROM shop_sessions WHERE shop = $1', [shop]);
}

/* ---------- Admin GraphQL ---------- */

export async function graphql(query, variables = {}, attempt = 0) {
  const session = await getSession();
  if (!session) throw new Error('App is not connected to a store yet. Open the app once from Shopify admin.');
  const res = await fetch(`https://${session.shop}/admin/api/${API_VERSION()}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': session.access_token },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt < 5) {
      await sleep(1000 * 2 ** attempt);
      return graphql(query, variables, attempt + 1);
    }
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Shopify API ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  if (body.errors?.length) {
    if (body.errors.some((e) => e.extensions?.code === 'THROTTLED') && attempt < 6) {
      await sleep(2000 * (attempt + 1));
      return graphql(query, variables, attempt + 1);
    }
    throw new Error(`Shopify GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  // Be polite with the cost bucket during big pulls.
  const cost = body.extensions?.cost;
  if (cost?.throttleStatus && cost.throttleStatus.currentlyAvailable < 200) await sleep(1500);
  return body.data;
}

/* ---------- Data pulls ---------- */

export async function fetchLocations() {
  const data = await graphql(`{
    locations(first: 50, includeInactive: true) {
      nodes { id name isActive }
    }
  }`);
  return data.locations.nodes.map((l) => ({ id: idFromGid(l.id), name: l.name, active: l.isActive }));
}

const VARIANT_FIELDS = `
  id sku title
  product { id title }
  inventoryItem {
    id
    inventoryLevels(first: 15) {
      nodes { location { id } quantities(names: ["available"]) { name quantity } }
    }
  }
`;

function normalizeVariant(v) {
  const levels = {};
  for (const lvl of v.inventoryItem?.inventoryLevels?.nodes || []) {
    const qty = lvl.quantities?.find((x) => x.name === 'available')?.quantity ?? 0;
    levels[idFromGid(lvl.location.id)] = qty;
  }
  return {
    inventory_item_id: idFromGid(v.inventoryItem?.id),
    variant_id: idFromGid(v.id),
    product_id: idFromGid(v.product?.id),
    sku: (v.sku || '').trim(),
    product_title: v.product?.title || '',
    variant_title: v.title || '',
    levels,
  };
}

/** All variants whose SKU starts with `prefix`, with per-location available qty. */
export async function fetchVariantsBySkuPrefix(prefix, searchAll = false) {
  const out = [];
  let after = null;
  do {
    const data = await graphql(
      `query($after: String, $q: String!) {
        productVariants(first: 50, after: $after, query: $q) {
          pageInfo { hasNextPage endCursor }
          nodes { ${VARIANT_FIELDS} }
        }
      }`,
      { after, q: searchAll ? '' : `sku:${prefix}*` },
    );
    const page = data.productVariants;
    for (const v of page.nodes) {
      const n = normalizeVariant(v);
      if (n.sku.startsWith(prefix) && n.inventory_item_id) out.push(n);
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  // If Shopify's search index returns nothing for the prefix query, scan every variant instead.
  if (!out.length && !searchAll) return fetchVariantsBySkuPrefix(prefix, true);
  return out;
}

export async function fetchVariantByInventoryItem(inventoryItemId) {
  const data = await graphql(
    `query($id: ID!) {
      inventoryItem(id: $id) {
        id
        variant { ${VARIANT_FIELDS} }
      }
    }`,
    { id: gid('InventoryItem', inventoryItemId) },
  );
  const v = data.inventoryItem?.variant;
  return v ? normalizeVariant(v) : null;
}

/* ---------- Webhooks ---------- */

const TOPICS = ['INVENTORY_LEVELS_UPDATE', 'PRODUCTS_UPDATE', 'APP_UNINSTALLED'];

export async function registerWebhooks(appUrl) {
  const uri = `${appUrl.replace(/\/$/, '')}/webhooks`;
  const existing = await graphql(`{
    webhookSubscriptions(first: 50) { nodes { id topic uri } }
  }`);
  const have = new Set(
    existing.webhookSubscriptions.nodes.filter((w) => w.uri === uri).map((w) => w.topic),
  );
  // Remove subscriptions pointing at an old URL (e.g. after a domain change).
  for (const w of existing.webhookSubscriptions.nodes) {
    if (TOPICS.includes(w.topic) && w.uri !== uri && /\/webhooks$/.test(w.uri || '')) {
      await graphql(`mutation($id: ID!) { webhookSubscriptionDelete(id: $id) { userErrors { message } } }`, { id: w.id });
    }
  }
  const created = [];
  for (const topic of TOPICS) {
    if (have.has(topic)) continue;
    const r = await graphql(
      `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
          webhookSubscription { id }
          userErrors { field message }
        }
      }`,
      { topic, sub: { uri, format: 'JSON' } },
    );
    const errs = r.webhookSubscriptionCreate.userErrors;
    if (errs?.length) throw new Error(`Webhook ${topic}: ${errs.map((e) => e.message).join('; ')}`);
    created.push(topic);
  }
  return created;
}
