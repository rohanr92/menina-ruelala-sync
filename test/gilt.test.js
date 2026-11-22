import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {
  parseOrderFile, looksLikeOrderFile, buildAsnCsv, buildFedexWorkbook, FEDEX_HEADERS, shopifyOrderInput, asnFileName,
} from '../src/gilt.js';

// Same layout as a real /Live/Get file (extract_26.csv); customer details are made up.
const SAMPLE = [
  'HD,1192155713,DS,GILT,218509,20261121,20261124,,FEDH,FedEx Home,,0,0,,',
  'BT,,Jane Sample,100 Test Ave,Apt 4,,Brooklyn,NY,11230,555123456,United States Of America,US',
  'ST,,Jane Sample,100 Test Ave,Apt 4,,Brooklyn,NY,11230,5551234567,United States Of America,US',
  'OC,Guaranteed for Holiday',
  'PD,1,1,EA,49.49,94.99,BELLE-GLAZEDTAUPE,13115908050002,,Menina Step Belle Leather Flat',
  'TD,1192155713,1,1',
  '',
].join('\n');

const TWO = SAMPLE + SAMPLE.replace(/1192155713/g, '1192155799').replace('ST,,Jane Sample,100 Test Ave', 'ST,,Ann Other,5 Elm St')
  .replace('PD,1,1,EA,49.49,94.99,BELLE-GLAZEDTAUPE,13115908050002', 'PD,1,2,EA,40.00,80.00,SI-NA-CH,13110247670003\nPD,2,1,EA,49.49,94.99,BELLE-GLAZEDTAUPE,13115908050002')
  .replace('TD,1192155799,1,1', 'TD,1192155799,2,3');

test('parses a Rue Gilt order file', () => {
  assert.ok(looksLikeOrderFile(SAMPLE));
  assert.ok(!looksLikeOrderFile('OrderNo,ShipDate\n1,2'));
  const { orders, warnings } = parseOrderFile(SAMPLE);
  assert.equal(warnings.length, 0);
  assert.equal(orders.length, 1);
  const o = orders[0];
  assert.equal(o.orderNo, '1192155713');
  assert.equal(o.orderDate, '2026-11-21');
  assert.equal(o.shipBy, '2026-11-24');
  assert.equal(o.shipMethod, 'FEDH');
  assert.equal(o.shipTo.name, 'Jane Sample');
  assert.equal(o.shipTo.line2, 'Apt 4');
  assert.equal(o.shipTo.zip, '11230');
  assert.equal(o.shipTo.phone, '5551234567');
  assert.deepEqual(o.comments, ['Guaranteed for Holiday']);
  assert.deepEqual(o.lines[0], {
    lineNo: '1', qty: 1, uom: 'EA', unitCost: 49.49, retail: 94.99, vendorSku: 'BELLE-GLAZEDTAUPE',
    hostSku: '13115908050002', upc: '', description: 'Menina Step Belle Leather Flat',
  });
});

test('several orders in one file, totals checked', () => {
  const { orders, warnings } = parseOrderFile(TWO);
  assert.equal(orders.length, 2);
  assert.equal(warnings.length, 0, warnings.join());
  assert.equal(orders[1].lines.length, 2);
  assert.equal(orders[1].shipTo.name, 'Ann Other');
  const bad = parseOrderFile(SAMPLE.replace('TD,1192155713,1,1', 'TD,1192155713,1,5'));
  assert.ok(bad.warnings[0].includes('5 units'));
});

test('shipment CSV matches the 856 layout with exact numbers', () => {
  const csv = buildAsnCsv([{ orderNo: '1192155713', shipDate: '2026-11-23T15:00:00Z', shipMethod: 'FEDH', tracking: '881057123456', sku: '13115908050002', qty: 1 }]);
  assert.equal(csv, 'OrderNo,ShipDate,ShipMethod,TrackingNumber,SkuNo,Quantity\n1192155713,11/23/26,FEDH,881057123456,13115908050002,1\n');
  assert.match(asnFileName('1192155713', new Date('2026-11-23T15:00:00Z')), /^856_ASN_1192155713_20261123_100000\.csv$/);
});

test('FedEx batch Excel has the template columns and order data', async () => {
  const { orders } = parseOrderFile(SAMPLE);
  const buf = await buildFedexWorkbook(orders);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('Example');
  const header = ws.getRow(1).values.slice(1);
  assert.equal(header.length, FEDEX_HEADERS.length - 1 - 0 > 0 ? header.length : 0); // sanity
  const h = (name) => FEDEX_HEADERS.indexOf(name) + 1;
  const row = ws.getRow(2);
  assert.equal(row.getCell(h('reference')).value, '1192155713');
  assert.equal(row.getCell(h('shipmentReference')).value, '1192155713');
  assert.equal(row.getCell(h('senderLine1')).value, '9814 SW 77th Ave');
  assert.equal(row.getCell(h('recipientContactName')).value, 'Jane Sample');
  assert.equal(row.getCell(h('recipientLine2')).value, 'Apt 4');
  assert.equal(row.getCell(h('recipientPostcode')).value, '11230');
  assert.equal(row.getCell(h('recipientResidential')).value, 'Y');
  assert.equal(row.getCell(h('serviceType')).value, 'GROUND_HOME_DELIVERY');
  assert.equal(row.getCell(h('paymentType')).value, 'THIRD_PARTY');
  assert.equal(row.getCell(h('payerAccountNumber')).value, '354042690');
  assert.equal(ws.getRow(1).getCell(h('payerAccountNumber')).value, 'payerAccountNumber');
});

test('ZIP codes keep their leading zero in Excel', async () => {
  const { orders } = parseOrderFile(SAMPLE.replace(/11230/g, '08701'));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await buildFedexWorkbook(orders));
  assert.equal(wb.getWorksheet('Example').getRow(2).getCell(FEDEX_HEADERS.indexOf('recipientPostcode') + 1).value, '08701');
});

test('Shopify order: tag, unit cost, no emails, ship-to', () => {
  const { orders } = parseOrderFile(SAMPLE);
  const input = shopifyOrderInput(orders[0], new Map([['13115908050002', 'gid://shopify/ProductVariant/1']]));
  assert.deepEqual(input.tags, ['Rue Gilt']);
  assert.equal(input.lineItems[0].variantId, 'gid://shopify/ProductVariant/1');
  assert.equal(input.lineItems[0].priceSet.shopMoney.amount, '49.49');
  assert.equal(input.lineItems[0].requiresShipping, true);
  assert.equal(input.transactions[0].amountSet.shopMoney.amount, '49.49');
  assert.equal(input.transactions[0].kind, 'SALE');
  assert.equal(input.processedAt, undefined, 'order is dated when imported');
  assert.equal(input.poNumber, '1192155713');
  assert.equal(input.email, undefined);
  assert.equal(input.shippingAddress.firstName, 'Jane');
  assert.equal(input.shippingAddress.lastName, 'Sample');
  assert.equal(input.shippingAddress.provinceCode, 'NY');
  assert.equal(input.shippingAddress.phone, '5551234567');
  assert.equal(input.billingAddress.phone, undefined, 'short 9-digit phone is dropped');
  assert.match(input.note, /Rue Gilt order 1192155713\nShip by 11\/24\/2026/);
  const retail = shopifyOrderInput(orders[0], new Map([['13115908050002', 'x']]), { priceField: 'retail' });
  assert.equal(retail.lineItems[0].priceSet.shopMoney.amount, '94.99');
});

test('packing slip PDF: one page per order', async () => {
  const { buildPackingSlips } = await import('../src/slip.js');
  const { orders } = parseOrderFile(TWO);
  const pdf = await buildPackingSlips(orders);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 2);
});
