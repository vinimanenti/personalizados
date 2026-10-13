// Shopee shipping label text parsing. Browser/Node shared; no PDF or DOM access.
const CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const PEDIDO = /Pedido:\s*([A-Za-z0-9][A-Za-z0-9_-]{0,79})/i;
const ENVIO = /Envio\s+previsto:\s*(\d{2}\/\d{2}\/\d{4})/i;

// Rebuild reading order from pdf.js text items: group by Y (±3 units), top to bottom, then left to right.
export function linesFromTextItems(items) {
  const rows = [];
  for (const item of items) {
    if (typeof item?.str !== 'string' || !item.str.trim()) continue;
    const y = Math.round(item.transform[5]), x = item.transform[4];
    let row = rows.find(r => Math.abs(r.y - y) <= 3);
    if (!row) { row = { y, parts: [] }; rows.push(row); }
    row.parts.push({ x, str: item.str });
  }
  return rows.sort((a, b) => b.y - a.y).map(r => r.parts.sort((a, b) => a.x - b.x).map(p => p.str).join(' '));
}

// Returns { pedido, envio } or null when the page has no order code. envio is '' when absent.
export function parseShopeeLabel(text) {
  const pedido = text.match(PEDIDO)?.[1];
  if (!pedido) return null;
  return { pedido, envio: text.match(ENVIO)?.[1] || '' };
}

// Appends label codes to the textarea content, one per line, skipping codes already present.
export function mergeLabelCodes(codesText, labels) {
  const present = new Set(codesText.split(/[\s,;]+/u).filter(Boolean));
  const added = [];
  let duplicates = 0;
  for (const { pedido } of labels) {
    if (!CODE.test(pedido) || present.has(pedido)) { duplicates++; continue; }
    present.add(pedido); added.push(pedido);
  }
  const base = codesText.replace(/\s+$/u, '');
  const codes = added.length ? (base ? `${base}\n` : '') + added.join('\n') : codesText;
  return { codes, added, duplicates };
}
