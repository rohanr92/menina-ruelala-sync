// Packing slips for Rue Gilt orders, laid out like the Radial packing slip. One page per order.
import PDFDocument from 'pdfkit';

const usDate = (iso) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
};
const phone = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : String(p || '');
};

function addressLines(a, withPhone) {
  if (!a) return [];
  return [
    a.company, a.name, a.line1, a.line2, a.line3,
    [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    withPhone ? phone(a.phone) : null,
  ].filter(Boolean);
}

export const SLIP_FOOTER = "If there's anything we can help you with, you can contact us at customerservice@gilt.com.";

function drawSlip(doc, o, { title = 'PACKING SLIP', footer = SLIP_FOOTER, logo = null } = {}) {
  const L = 34;
  const R = doc.page.width - 34;
  const W = R - L;

  let logoDrawn = false;
  if (logo) {
    try {
      // Centered, max 130 x 30 pt, just above the top rule — same size and place as on the Radial slip.
      doc.image(logo, L + (W - 130) / 2, 46, { fit: [130, 30], align: 'center', valign: 'bottom' });
      logoDrawn = true;
    } catch {
      logoDrawn = false; // unreadable image: fall back to the text heading
    }
  }
  if (!logoDrawn) doc.font('Times-Bold').fontSize(22).fillColor('#000').text(title, L, 46, { width: W, align: 'center', characterSpacing: 2 });
  doc.moveTo(L - 6, 84).lineTo(R + 6, 84).lineWidth(1.5).stroke();

  // Header block: five columns
  const cols = [
    { x: L, label: 'BILL TO', lines: addressLines(o.billTo || o.shipTo, false) },
    { x: L + 114, label: 'SHIP TO', lines: addressLines(o.shipTo, true) },
    { x: L + 228, label: 'ORDER DATE', lines: [usDate(o.orderDate)] },
    { x: L + 342, label: 'SHIP DATE', lines: [usDate(o.shipBy)] },
    { x: L + 456, label: 'ORDER NUMBER', lines: [o.orderNo] },
  ];
  let bottom = 0;
  for (const c of cols) {
    doc.font('Times-Bold').fontSize(9).text(c.label, c.x, 96, { width: 108 });
    doc.font('Times-Roman').fontSize(9).text(c.lines.join('\n'), c.x, 107, { width: 100, lineGap: 1.5 });
    bottom = Math.max(bottom, doc.y);
  }

  // Items table
  let y = bottom + 18;
  const tx = { sku: L, item: L + 114, qty: L + 200, desc: L + 286 };
  doc.font('Times-Bold').fontSize(9);
  doc.text('SKU', tx.sku, y).text('ITEM', tx.item, y).text('QTY', tx.qty, y).text('DESCRIPTION', tx.desc, y);
  y += 13;
  doc.moveTo(L, y).lineTo(R, y).lineWidth(1.2).stroke();
  y += 4;
  doc.font('Times-Roman').fontSize(9);
  for (const l of o.lines) {
    const h = Math.max(
      doc.heightOfString(l.vendorSku, { width: 100 }),
      doc.heightOfString(l.description, { width: R - tx.desc }),
      11,
    );
    if (y + h > 640) { doc.addPage(); y = 50; }
    doc.text(l.vendorSku, tx.sku, y, { width: 100 });
    doc.text(l.hostSku, tx.item, y, { width: 84 });
    doc.text(String(l.qty), tx.qty, y, { width: 80 });
    doc.text(l.description, tx.desc, y, { width: R - tx.desc });
    y += h + 6;
  }

  // Footer
  const fy = 695;
  doc.moveTo(L, fy).lineTo(R, fy).lineWidth(1.5).stroke();
  doc.font('Times-Bold').fontSize(9.5).text('WHAT YOU NEED TO KNOW', L, fy + 40);
  doc.font('Times-Italic').fontSize(10).text(footer, L, fy + 68, { width: W });
}

/** orders: parsed Rue Gilt orders. Returns a PDF Buffer, one page per order. */
export function buildPackingSlips(orders, opts) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 34, autoFirstPage: false, info: { Title: 'Packing slips', Author: 'Menina Step' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    for (const o of orders) {
      doc.addPage();
      drawSlip(doc, o, opts);
    }
    doc.end();
  });
}
