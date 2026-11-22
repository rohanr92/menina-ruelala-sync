// Rue Gilt (VendorNet) order files, shipment (ASN) CSV and FedEx batch-upload Excel.
import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';

const clean = (v) => String(v ?? '').trim();
const ymd = (s) => {
  const m = clean(s).match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

function address(r) {
  // BT/ST: type, company, name, line1, line2, line3, city, state, zip, phone, country name, country code
  return {
    company: clean(r[1]),
    name: clean(r[2]),
    line1: clean(r[3]),
    line2: clean(r[4]),
    line3: clean(r[5]),
    city: clean(r[6]),
    state: clean(r[7]),
    zip: clean(r[8]),
    phone: clean(r[9]).replace(/[^\d+]/g, ''),
    countryName: clean(r[10]),
    country: clean(r[11]) || 'US',
  };
}

/** Parses a VendorNet order file (HD/BT/ST/OC/PD/TD records). One file can hold many orders. */
export function parseOrderFile(text) {
  const rows = parseCsv(String(text).replace(/^﻿/, ''), {
    relax_column_count: true, relax_quotes: true, skip_empty_lines: true, trim: false,
  });
  const orders = [];
  const warnings = [];
  let cur = null;
  for (const r of rows) {
    const type = clean(r[0]).toUpperCase();
    if (type === 'HD') {
      cur = {
        orderNo: clean(r[1]),
        orderType: clean(r[2]),
        customer: clean(r[3]),
        vendorId: clean(r[4]),
        orderDate: ymd(r[5]),
        shipBy: ymd(r[6]),
        shipMethod: clean(r[8]),
        shipMethodName: clean(r[9]),
        billTo: null,
        shipTo: null,
        comments: [],
        lines: [],
        totals: null,
      };
      orders.push(cur);
    } else if (!cur) {
      if (type) warnings.push(`Record "${type}" before any HD header was ignored.`);
    } else if (type === 'BT') cur.billTo = address(r);
    else if (type === 'ST') cur.shipTo = address(r);
    else if (type === 'OC') cur.comments.push(r.slice(1).map(clean).filter(Boolean).join(' '));
    else if (type === 'PD') {
      cur.lines.push({
        lineNo: clean(r[1]),
        qty: Number(clean(r[2])) || 0,
        uom: clean(r[3]),
        unitCost: Number(clean(r[4])) || 0,
        retail: Number(clean(r[5])) || 0,
        vendorSku: clean(r[6]),
        hostSku: clean(r[7]),
        upc: clean(r[8]),
        description: clean(r[9]),
      });
    } else if (type === 'TD') {
      cur.totals = { lines: Number(clean(r[2])) || 0, units: Number(clean(r[3])) || 0 };
    }
  }
  for (const o of orders) {
    if (!o.orderNo) warnings.push('An order without an order number was found.');
    if (!o.shipTo) warnings.push(`Order ${o.orderNo}: no ship-to address.`);
    if (!o.lines.length) warnings.push(`Order ${o.orderNo}: no item lines.`);
    if (o.totals) {
      const units = o.lines.reduce((a, l) => a + l.qty, 0);
      if (o.totals.lines && o.totals.lines !== o.lines.length) warnings.push(`Order ${o.orderNo}: file says ${o.totals.lines} lines, found ${o.lines.length}.`);
      if (o.totals.units && o.totals.units !== units) warnings.push(`Order ${o.orderNo}: file says ${o.totals.units} units, found ${units}.`);
    }
  }
  return { orders: orders.filter((o) => o.orderNo), warnings };
}

export const looksLikeOrderFile = (text) => /^﻿?\s*"?HD"?,/m.test(String(text));

/* ---------- Shipment confirmation (ASN) ---------- */

export const ASN_HEADER = ['OrderNo', 'ShipDate', 'ShipMethod', 'TrackingNumber', 'SkuNo', 'Quantity'];

export function asnDate(date, timeZone = 'America/New_York') {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: '2-digit', month: 'numeric', day: 'numeric',
  }).formatToParts(new Date(date)).map((x) => [x.type, x.value]));
  return `${p.month}/${p.day}/${p.year}`;
}

/** rows: [{orderNo, shipDate, shipMethod, tracking, sku, qty}] -> CSV text (plain, no quotes, exact numbers). */
export function buildAsnCsv(rows, timeZone) {
  const safe = (v) => String(v ?? '').replace(/[,\r\n"]/g, ' ').trim();
  const lines = [ASN_HEADER.join(',')];
  for (const r of rows) {
    lines.push([r.orderNo, asnDate(r.shipDate, timeZone), r.shipMethod, r.tracking, r.sku, r.qty].map(safe).join(','));
  }
  return lines.join('\n') + '\n';
}

export function asnFileName(orderNo, date, timeZone = 'America/New_York') {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(date)).map((x) => [x.type, x.value]));
  return `856_ASN_${orderNo}_${p.year}${p.month}${p.day}_${p.hour}${p.minute}${p.second}.csv`;
}

/* ---------- FedEx Ship Manager batch upload ---------- */

// Same columns, in the same order, as the FedEx template you use (NOV-20.xlsx).
export const FEDEX_HEADERS = [
  'reference', 'shipmentReference', 'senderContactName', 'senderCompany', 'senderContactNumber', 'senderEmail',
  'senderLine1', 'senderLine2', 'senderPostcode', 'senderState', 'senderCity', 'senderCountry',
  'recipientContactName', 'recipientCompany', 'recipientContactNumber', 'recipientEmail', 'recipientLine1',
  'recipientLine2', 'recipientLine3', 'recipientPostcode', 'recipientState', 'recipientCity', 'recipientResidential',
  'recipientCountry', null, null, 'packageType', 'numberOfPackages', 'packageWeight', 'weightUnits', 'length', 'width',
  'height', 'currencyType', 'oneRatePricing', 'commodityType', 'itemDescription', 'harmonizedCode',
  'manufacturingCountry', 'commodityQuantity', 'commodityMeasureUnit', 'commodityWeight', 'customsValue',
  'documentType', 'documentDescription', 'purposeOfShipment', 'generateInvoice', 'etdEnabled', 'serviceType',
  'recipientDeliveryNotification', 'recipientExceptionNotification', 'recipientShipAlertNotification',
  'recipientNotificationLanguageCode', 'paymentType', 'payerAccountNumber',
];

export const FEDEX_DEFAULTS = {
  senderContactName: 'Menina Step',
  senderCompany: 'Menina Step',
  senderContactNumber: '3052825357',
  senderEmail: 'Beatriz@meninastep.com',
  senderLine1: '9814 SW 77th Ave',
  senderLine2: '',
  senderPostcode: '33156',
  senderState: 'FL',
  senderCity: 'Kendall',
  senderCountry: 'US',
  packageType: 'YOUR_PACKAGING',
  packageWeight: 1,
  weightUnits: 'LBS',
  length: 13,
  width: 7,
  height: 5,
  currencyType: 'USD',
  serviceType: 'GROUND_HOME_DELIVERY',
  serviceByShipMethod: { FEDH: 'GROUND_HOME_DELIVERY', FDEG: 'FEDEX_GROUND', FEDG: 'FEDEX_GROUND' },
  notifications: 'Y',
  languageCode: 'en',
  paymentType: 'THIRD_PARTY',
  payerAccountNumber: '354042690',
};

const cut = (s, n) => clean(s).slice(0, n);

export function fedexRow(order, cfg = FEDEX_DEFAULTS) {
  const c = { ...FEDEX_DEFAULTS, ...cfg };
  const st = order.shipTo || {};
  const service = c.serviceByShipMethod?.[order.shipMethod] || c.serviceType;
  const units = order.lines.reduce((a, l) => a + l.qty, 0) || 1;
  const v = {
    reference: order.orderNo,
    shipmentReference: order.orderNo,
    senderContactName: cut(c.senderContactName, 35),
    senderCompany: cut(c.senderCompany, 35),
    senderContactNumber: cut(c.senderContactNumber, 15),
    senderEmail: c.senderEmail,
    senderLine1: cut(c.senderLine1, 35),
    senderLine2: cut(c.senderLine2, 35),
    senderPostcode: c.senderPostcode,
    senderState: c.senderState,
    senderCity: c.senderCity,
    senderCountry: c.senderCountry,
    recipientContactName: cut(st.name, 35),
    recipientCompany: cut(st.company, 35),
    recipientContactNumber: cut(st.phone, 15),
    recipientEmail: '',
    recipientLine1: cut(st.line1, 35),
    recipientLine2: cut(st.line2, 35),
    recipientLine3: cut(st.line3, 35),
    recipientPostcode: cut(st.zip, 10),
    recipientState: st.state,
    recipientCity: cut(st.city, 35),
    recipientResidential: 'Y',
    recipientCountry: st.country || 'US',
    packageType: c.packageType,
    numberOfPackages: 1,
    packageWeight: Number(c.packageWeight) * (c.weightPerUnit ? units : 1),
    weightUnits: c.weightUnits,
    length: Number(c.length),
    width: Number(c.width),
    height: Number(c.height),
    currencyType: c.currencyType,
    serviceType: service,
    recipientDeliveryNotification: c.notifications,
    recipientExceptionNotification: c.notifications,
    recipientShipAlertNotification: c.notifications,
    recipientNotificationLanguageCode: c.languageCode,
    paymentType: c.paymentType,
    payerAccountNumber: c.payerAccountNumber,
  };
  return FEDEX_HEADERS.map((h) => (h ? v[h] ?? null : null));
}

// Columns that must stay text so Excel keeps leading zeros and long numbers.
const TEXT_COLS = new Set(['reference', 'shipmentReference', 'senderContactNumber', 'senderPostcode',
  'recipientContactNumber', 'recipientPostcode', 'payerAccountNumber']);

export async function buildFedexWorkbook(orders, cfg) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Menina Step Rue La La Sync';
  const ws = wb.addWorksheet('Example');
  ws.addRow(FEDEX_HEADERS);
  ws.getRow(1).font = { bold: true };
  FEDEX_HEADERS.forEach((h, i) => {
    const col = ws.getColumn(i + 1);
    col.width = h ? Math.max(12, Math.min(28, h.length + 2)) : 4;
    if (h && TEXT_COLS.has(h)) col.numFmt = '@';
  });
  for (const o of orders) {
    const row = fedexRow(o, cfg).map((v, i) => (TEXT_COLS.has(FEDEX_HEADERS[i]) && v != null ? String(v) : (v === '' ? null : v)));
    ws.addRow(row);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ---------- Shopify order input ---------- */

function splitName(full) {
  const parts = clean(full).split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: '', lastName: parts[0] || '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1) };
}

function mailing(a) {
  if (!a) return undefined;
  return {
    ...splitName(a.name),
    company: a.company || undefined,
    address1: a.line1,
    address2: [a.line2, a.line3].filter(Boolean).join(', ') || undefined,
    city: a.city,
    provinceCode: a.state || undefined,
    zip: a.zip,
    countryCode: (a.country || 'US').toUpperCase(),
    // Shopify rejects malformed phone numbers; only pass full 10+ digit numbers.
    phone: a.phone && a.phone.replace(/\D/g, '').length >= 10 ? a.phone : undefined,
  };
}

const usDate = (iso) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}/${y}`;
};

/**
 * Builds the orderCreate input.
 * variantBySku: Map(hostSku -> variant gid)
 */
export function shopifyOrderInput(order, variantBySku, { tag = 'Rue Gilt', priceField = 'unitCost', currency = 'USD' } = {}) {
  const lineItems = order.lines.map((l) => ({
    variantId: variantBySku.get(l.hostSku),
    quantity: l.qty,
    requiresShipping: true, // physical shoes: Shopify must treat the order as shippable
    priceSet: { shopMoney: { amount: (priceField === 'retail' ? l.retail : l.unitCost).toFixed(2), currencyCode: currency } },
  }));
  const total = order.lines.reduce((a, l) => a + l.qty * (priceField === 'retail' ? l.retail : l.unitCost), 0);
  const shipBy = usDate(order.shipBy);
  const note = [
    `Rue Gilt order ${order.orderNo}`,
    shipBy && `Ship by ${shipBy}`,
    order.shipMethodName && `Ship via ${order.shipMethodName} (${order.shipMethod})`,
    ...order.comments,
  ].filter(Boolean).join('\n');
  const input = {
    lineItems,
    tags: [tag],
    note,
    poNumber: order.orderNo,
    sourceIdentifier: order.orderNo,
    financialStatus: 'PAID',
    // Record Rue Gilt's payment so the order shows "Paid $xx.xx" instead of "Paid $0.00".
    transactions: [{
      kind: 'SALE', status: 'SUCCESS', gateway: 'Rue Gilt',
      amountSet: { shopMoney: { amount: total.toFixed(2), currencyCode: currency } },
    }],
    currency,
    shippingAddress: mailing(order.shipTo),
    billingAddress: mailing(order.billTo || order.shipTo),
    customAttributes: [
      { key: 'Rue Gilt order', value: order.orderNo },
      ...(shipBy ? [{ key: 'Ship by', value: shipBy }] : []),
      ...(order.shipMethod ? [{ key: 'Ship method', value: `${order.shipMethodName || ''} (${order.shipMethod})`.trim() }] : []),
    ],
    shippingLines: [{
      title: order.shipMethodName ? `${order.shipMethodName} (Rue Gilt)` : 'Rue Gilt shipping',
      code: order.shipMethod || 'RUEGILT',
      priceSet: { shopMoney: { amount: '0.00', currencyCode: currency } },
    }],
  };
  return input;
}
