// FedEx Ship API (REST): creates labels from Menina Step's FedEx account,
// always billed THIRD_PARTY to the Rue Gilt account.

const BASE = () => (process.env.FEDEX_ENV === 'production' ? 'https://apis.fedex.com' : 'https://apis-sandbox.fedex.com');

export const fedexConfigured = () => Boolean(process.env.FEDEX_API_KEY && process.env.FEDEX_SECRET_KEY && process.env.FEDEX_ACCOUNT_NUMBER);
export const fedexEnv = () => (process.env.FEDEX_ENV === 'production' ? 'production' : 'sandbox');

let token = null;
let tokenExp = 0;

async function getToken() {
  if (token && Date.now() < tokenExp) return token;
  const res = await fetch(`${BASE()}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.FEDEX_API_KEY,
      client_secret: process.env.FEDEX_SECRET_KEY,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`FedEx login failed (${res.status}): ${fedexErrors(data) || 'check FEDEX_API_KEY / FEDEX_SECRET_KEY'}`);
  token = data.access_token;
  tokenExp = Date.now() + (Number(data.expires_in || 3600) - 120) * 1000;
  return token;
}

export function fedexErrors(data) {
  return (data?.errors || []).map((e) => `${e.code || ''} ${e.message || ''}`.trim()).join('; ');
}

async function call(method, path, body) {
  const res = await fetch(`${BASE()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      'Content-Type': 'application/json',
      'X-locale': 'en_US',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.errors?.length) {
    throw new Error(`FedEx ${res.status}: ${fedexErrors(data) || JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

const digits = (s) => String(s || '').replace(/\D/g, '');
const cut = (s, n) => String(s || '').trim().slice(0, n);

function todayET() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Builds the Ship API request. Throws if third-party billing is missing — it is never skipped. */
export function shipmentRequest(order, cfg, accountNumber = process.env.FEDEX_ACCOUNT_NUMBER) {
  const f = cfg.fedex;
  const payer = digits(f.payerAccountNumber);
  if (payer.length !== 9) throw new Error('Third-party billing account (Bill to FedEx account) must be a 9-digit FedEx account. Label not created.');
  const st = order.shipTo || {};
  if (!st.line1 || !st.zip || !st.city) throw new Error('Ship-to address is incomplete in the Rue Gilt order.');
  const units = order.lines.reduce((a, l) => a + l.qty, 0) || 1;
  const weight = Math.max(0.1, Number(f.packageWeight || 1) * (f.weightPerPair === false ? 1 : units));
  const service = f.serviceByShipMethod?.[order.shipMethod] || f.serviceType || 'GROUND_HOME_DELIVERY';
  const refs = [
    { customerReferenceType: 'CUSTOMER_REFERENCE', value: cut(order.orderNo, 30) },
    { customerReferenceType: 'P_O_NUMBER', value: cut(order.orderNo, 30) },
  ];
  return {
    labelResponseOptions: 'LABEL',
    accountNumber: { value: digits(accountNumber) },
    requestedShipment: {
      shipDatestamp: todayET(),
      serviceType: service,
      packagingType: f.packageType || 'YOUR_PACKAGING',
      pickupType: f.pickupType || 'USE_SCHEDULED_PICKUP',
      blockInsightVisibility: false,
      shipper: {
        contact: { personName: cut(f.senderContactName, 35), companyName: cut(f.senderCompany, 35), phoneNumber: digits(f.senderContactNumber) },
        address: {
          streetLines: [f.senderLine1, f.senderLine2].map((x) => cut(x, 35)).filter(Boolean),
          city: f.senderCity, stateOrProvinceCode: f.senderState, postalCode: String(f.senderPostcode), countryCode: f.senderCountry || 'US',
        },
      },
      recipients: [{
        contact: {
          personName: cut(st.name, 35),
          ...(st.company ? { companyName: cut(st.company, 35) } : {}),
          phoneNumber: digits(st.phone).length >= 10 ? digits(st.phone) : digits(f.senderContactNumber),
          ...(f.recipientEmail ? { emailAddress: f.recipientEmail } : {}),
        },
        address: {
          streetLines: [st.line1, st.line2, st.line3].map((x) => cut(x, 35)).filter(Boolean),
          city: st.city, stateOrProvinceCode: st.state, postalCode: String(st.zip), countryCode: st.country || 'US',
          residential: true,
        },
      }],
      shippingChargesPayment: {
        paymentType: 'THIRD_PARTY',
        payor: { responsibleParty: { accountNumber: { value: payer } } },
      },
      labelSpecification: { imageType: 'PDF', labelStockType: f.labelStockType || 'PAPER_4X6' },
      totalPackageCount: 1,
      requestedPackageLineItems: [{
        sequenceNumber: 1,
        weight: { units: f.weightUnits === 'KGS' ? 'KG' : 'LB', value: Math.round(weight * 10) / 10 },
        dimensions: { length: Number(f.length), width: Number(f.width), height: Number(f.height), units: f.weightUnits === 'KGS' ? 'CM' : 'IN' },
        customerReferences: refs,
      }],
    },
  };
}

/** Creates the label. Returns { tracking, labelPdf (Buffer), service, request }. */
export async function createLabel(order, cfg) {
  if (!fedexConfigured()) throw new Error('FedEx keys are missing. Add FEDEX_API_KEY, FEDEX_SECRET_KEY and FEDEX_ACCOUNT_NUMBER in Railway.');
  const request = shipmentRequest(order, cfg);
  const data = await call('POST', '/ship/v1/shipments', request);
  const ts = data.output?.transactionShipments?.[0];
  const piece = ts?.pieceResponses?.[0];
  const tracking = piece?.trackingNumber || ts?.masterTrackingNumber;
  const doc = piece?.packageDocuments?.find((d) => d.encodedLabel) || ts?.shipmentDocuments?.find((d) => d.encodedLabel);
  if (!tracking) throw new Error('FedEx did not return a tracking number.');
  if (!doc) throw new Error(`FedEx created ${tracking} but returned no label image.`);
  return {
    tracking,
    labelPdf: Buffer.from(doc.encodedLabel, 'base64'),
    service: ts?.serviceType || request.requestedShipment.serviceType,
    alerts: (data.output?.alerts || ts?.alerts || []).map((a) => a.message).filter(Boolean),
  };
}

export async function cancelLabel(tracking) {
  return call('PUT', '/ship/v1/shipments/cancel', {
    accountNumber: { value: digits(process.env.FEDEX_ACCOUNT_NUMBER) },
    trackingNumber: tracking,
    deletionControl: 'DELETE_ALL_PACKAGES',
  });
}

/** Quick check that the keys work (login only, no label). */
export async function testFedexLogin() {
  token = null;
  await getToken();
  return { ok: true, env: fedexEnv(), account: `•••${digits(process.env.FEDEX_ACCOUNT_NUMBER).slice(-3)}` };
}
