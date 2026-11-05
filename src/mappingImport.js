// Reads a Rue La La SKU file (CSV / XLSX / PDF) into host SKU -> supplier SKU rows.
import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const HOST_RE = /host\s*sku/i;
const SUPPLIER_RES = [/supplier\s*sku/i, /vendor\s*sku/i, /style/i];
const DESC_RE = /desc/i;

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toFixed(0) : String(v);
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return cellText(v.result);
  }
  return String(v);
}

function findColumns(header) {
  const h = header.map((c) => cellText(c).trim());
  const host = h.findIndex((c) => HOST_RE.test(c));
  let supplier = -1;
  for (const re of SUPPLIER_RES) {
    supplier = h.findIndex((c, i) => i !== host && re.test(c));
    if (supplier >= 0) break;
  }
  const description = h.findIndex((c) => DESC_RE.test(c));
  return { host, supplier, description, headers: h };
}

function fromTable(table, source, prefix) {
  const headerIdx = table.findIndex((r) => r.some((c) => HOST_RE.test(cellText(c))));
  if (headerIdx < 0) throw new Error('Could not find a "Host SKU" column in this file.');
  const cols = findColumns(table[headerIdx]);
  if (cols.supplier < 0) throw new Error('Found "Host SKU" but no "Supplier SKU" / "Vendor SKU" column.');
  const rows = [];
  for (let i = headerIdx + 1; i < table.length; i++) {
    const r = table[i];
    const host = cellText(r[cols.host]).trim();
    const supplier = cellText(r[cols.supplier]).trim();
    if (!host && !supplier) continue;
    rows.push({
      line: i + 1,
      host_sku: host,
      supplier_sku: supplier,
      description: cols.description >= 0 ? cellText(r[cols.description]).trim() : '',
    });
  }
  return validate(rows, source, prefix, {
    host: cols.headers[cols.host],
    supplier: cols.headers[cols.supplier],
    description: cols.description >= 0 ? cols.headers[cols.description] : null,
  });
}

function validate(rawRows, source, prefix, columns = null) {
  const errors = [];
  const warnings = [];
  const byHost = new Map();
  let nameLike = 0;
  for (const r of rawRows) {
    const host = r.host_sku.replace(/\s+/g, '');
    if (/e\+/i.test(host)) {
      errors.push(`Row ${r.line}: Host SKU "${r.host_sku}" is in scientific notation — format the column as Text in Excel and re-export.`);
      continue;
    }
    if (!/^\d{14}$/.test(host) || !host.startsWith(prefix)) {
      errors.push(`Row ${r.line}: "${r.host_sku}" is not a valid Host SKU (must be 14 digits starting with ${prefix}).`);
      continue;
    }
    if (!r.supplier_sku) {
      errors.push(`Row ${r.line}: Host SKU ${host} has no Supplier SKU.`);
      continue;
    }
    if (/\s/.test(r.supplier_sku)) nameLike++;
    if (byHost.has(host) && byHost.get(host).supplier_sku !== r.supplier_sku) {
      warnings.push(`Host SKU ${host} appears more than once with different Supplier SKUs — the last one (${r.supplier_sku}) is used.`);
    }
    byHost.set(host, { host_sku: host, supplier_sku: r.supplier_sku, description: r.description || '' });
  }
  if (nameLike) {
    warnings.push(`${nameLike} Supplier SKU value(s) contain spaces (e.g. product names). Rue La La expects the style code, like "SI-NA-CH".`);
  }
  return { source, columns, rows: [...byHost.values()], errors, warnings };
}

async function fromXlsx(buffer, prefix) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  let lastErr = null;
  for (const ws of wb.worksheets) {
    const table = [];
    ws.eachRow({ includeEmpty: true }, (row) => {
      const vals = row.values.slice(1); // exceljs is 1-indexed
      table.push(vals.map(cellText));
    });
    try {
      const res = fromTable(table, `Excel · sheet "${ws.name}"`, prefix);
      return res;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('The workbook is empty.');
}

async function fromPdf(buffer, prefix) {
  const { text } = await pdfParse(buffer);
  const hostRe = new RegExp(`\\b(${prefix}\\d{${14 - prefix.length}})\\b`);
  const styleRe = /\b([A-Z0-9]{2,}(?:-[A-Z0-9]+){1,4})\b/;
  const rows = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const host = line.match(hostRe)?.[1];
    if (!host) return;
    const rest = line.replace(host, ' ');
    const style = rest.match(styleRe)?.[1];
    rows.push({ line: i + 1, host_sku: host, supplier_sku: style || '', description: '' });
  });
  if (!rows.length) throw new Error(`No Host SKUs starting with ${prefix} were found in this PDF.`);
  const res = validate(rows, 'PDF (text extraction)', prefix);
  res.warnings.unshift('PDF tables are read line by line — check the preview carefully before importing.');
  return res;
}

export async function parseMappingFile(buffer, filename, prefix = '1311') {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'csv' || ext === 'txt') {
    const table = parseCsv(buffer, { bom: true, relax_column_count: true, skip_empty_lines: true, relax_quotes: true });
    return fromTable(table, 'CSV', prefix);
  }
  if (ext === 'xlsx' || ext === 'xlsm') return fromXlsx(buffer, prefix);
  if (ext === 'xls') throw new Error('Old .xls files are not supported. Open it in Excel and "Save As" .xlsx or .csv.');
  if (ext === 'pdf') return fromPdf(buffer, prefix);
  throw new Error(`Unsupported file type ".${ext}". Use CSV, XLSX or PDF.`);
}
