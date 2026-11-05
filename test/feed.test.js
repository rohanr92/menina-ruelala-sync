import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRows, toCsv, fileName, HEADER } from '../src/feed.js';
import { parseMappingFile } from '../src/mappingImport.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const MAPPING = path.join(FIX, 'mapping.csv');
const RUE = path.join(FIX, 'rue_format.csv');
const noMapping = !fs.existsSync(MAPPING) && 'put current-data-for_supplier_sku.csv in test/fixtures/mapping.csv';
const noRue = !fs.existsSync(RUE) && 'put testing_1.csv in test/fixtures/rue_format.csv';

const RUE_HEADER = '"REC-TYPE","VENDOR SKU NO","HOST SKU NO","UPC","ON HAND QTY","ON HAND DATE","BACKORDER QTY","BACKORDER DATE","EXPECTED QTY","EXPECTED DATE"';

test('CSV header and row format match the Rue La La file exactly', () => {
  const csv = toCsv([{ hostSku: '13114749550004', vendorSku: 'JI-HI-TA', qty: 1 }]).split('\n');
  assert.equal(csv[0], RUE_HEADER);
  assert.equal(csv[1], '"IR","JI-HI-TA","13114749550004","","1","","","","",""');
  assert.equal(HEADER.length, 10);
});

test('only 1311 SKUs, mapped vendor SKU, location sum, negatives -> 0', () => {
  const variants = [
    { sku: '13110247670000', levels: { 1: 2, 2: 3 } },
    { sku: '13110247670001', levels: { 1: -1 } },
    { sku: 'MS-OTHER-01', levels: { 1: 9 } },
    { sku: '13119999990000', levels: { 1: 4 } },
    { sku: '13110247670000', levels: { 1: 7 } },
  ];
  const mappings = new Map([
    ['13110247670000', { supplier_sku: 'SI-NA-CH' }],
    ['13110247670001', { supplier_sku: 'SI-NA-CH' }],
  ]);
  const r = buildRows({ variants, mappings, locationIds: ['1', '2'] });
  assert.deepEqual(r.rows, [
    { hostSku: '13110247670000', vendorSku: 'SI-NA-CH', qty: 5 },
    { hostSku: '13110247670001', vendorSku: 'SI-NA-CH', qty: 0 },
  ]);
  assert.deepEqual(r.unmapped, ['13119999990000']);
  assert.deepEqual(r.duplicates, ['13110247670000']);
  const onlyOne = buildRows({ variants, mappings, locationIds: ['1'], onlySkus: new Set(['13110247670000']) });
  assert.deepEqual(onlyOne.rows, [{ hostSku: '13110247670000', vendorSku: 'SI-NA-CH', qty: 2 }]);
});

test('file name uses Eastern time', () => {
  assert.equal(fileName('MeninaStep_Inventory', new Date('2026-11-05T11:00:00Z')), 'MeninaStep_Inventory_20261105_060000.csv');
});

test('Rue La La sample file has the same header', { skip: noRue }, () => {
  const first = fs.readFileSync(RUE, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[0];
  assert.equal(first, RUE_HEADER);
});

test('imports the current Rue La La export (916 SKUs)', { skip: noMapping }, async () => {
  const res = await parseMappingFile(fs.readFileSync(MAPPING), 'mapping.csv');
  assert.equal(res.errors.length, 0, res.errors.join('\n'));
  assert.equal(res.rows.length, 916);
  assert.equal(res.rows.find((r) => r.host_sku === '13110247670000').supplier_sku, 'SI-NA-CH');
});

test('inventory-format file: uses VENDOR SKU and warns about names', { skip: noRue }, async () => {
  const res = await parseMappingFile(fs.readFileSync(RUE), 'rue.csv');
  assert.equal(res.columns.supplier, 'VENDOR SKU NO');
  assert.ok(res.warnings.some((w) => /contain spaces/.test(w)));
  assert.ok(res.errors.some((e) => /131119407800001/.test(e)));
});

test('XLSX import', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('New styles');
  ws.addRow(['Upcoming styles']);
  ws.addRow(['Host SKU', 'Supplier SKU', 'Host Item Description']);
  ws.addRow([13119000010000, 'NE-WS-TY', 'New Style 6']);
  ws.addRow(['13119000010001', 'NE-WS-TY', 'New Style 7']);
  ws.addRow(['1.311E+13', 'NE-WS-TY', 'broken']);
  const res = await parseMappingFile(Buffer.from(await wb.xlsx.writeBuffer()), 'new.xlsx');
  assert.equal(res.rows.length, 2);
  assert.equal(res.rows[0].host_sku, '13119000010000');
  assert.equal(res.errors.length, 1);
});
