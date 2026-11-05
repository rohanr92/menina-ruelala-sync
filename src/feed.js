// Builds the Rue La La (VendorNet) inventory file — "IR" records.
// Format matches the file Rue La La provided: every field quoted, LF line endings.

export const HEADER = [
  'REC-TYPE', 'VENDOR SKU NO', 'HOST SKU NO', 'UPC', 'ON HAND QTY',
  'ON HAND DATE', 'BACKORDER QTY', 'BACKORDER DATE', 'EXPECTED QTY', 'EXPECTED DATE',
];

const quote = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/** Sum available qty over the counted locations. Negative stock is sent as 0. */
export function countedQty(levels, locationIds) {
  let total = 0;
  for (const id of locationIds) total += Number(levels?.[id] ?? 0);
  return Math.max(0, total);
}

/**
 * @param variants  [{sku, levels, ...}] Shopify variants (cache)
 * @param mappings  Map(host_sku -> {supplier_sku})
 * @param locationIds  location ids whose stock is counted
 * @param onlySkus  optional Set of host SKUs to include (changes-only file)
 */
export function buildRows({ variants, mappings, locationIds, prefix = '1311', onlySkus = null }) {
  const rows = [];
  const unmapped = [];
  const duplicates = [];
  const negatives = [];
  const seen = new Set();

  for (const v of variants) {
    const sku = (v.sku || '').trim();
    if (!sku.startsWith(prefix)) continue;
    if (onlySkus && !onlySkus.has(sku)) continue;
    if (seen.has(sku)) { duplicates.push(sku); continue; }
    seen.add(sku);
    const m = mappings.get(sku);
    if (!m) { unmapped.push(sku); continue; }
    let raw = 0;
    for (const id of locationIds) raw += Number(v.levels?.[id] ?? 0);
    if (raw < 0) negatives.push({ sku, qty: raw });
    rows.push({ hostSku: sku, vendorSku: m.supplier_sku, qty: Math.max(0, raw) });
  }
  rows.sort((a, b) => a.hostSku.localeCompare(b.hostSku));
  return { rows, unmapped, duplicates, negatives };
}

export function toCsv(rows) {
  const lines = [HEADER.map(quote).join(',')];
  for (const r of rows) {
    lines.push(['IR', r.vendorSku, r.hostSku, '', r.qty, '', '', '', '', ''].map(quote).join(','));
  }
  return lines.join('\n') + '\n';
}

export function fileName(prefix, date, timeZone = 'America/New_York') {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((x) => [x.type, x.value]),
  );
  const safe = String(prefix || 'inventory').replace(/[^A-Za-z0-9_-]/g, '_');
  return `${safe}_${p.year}${p.month}${p.day}_${p.hour}${p.minute}${p.second}.csv`;
}
