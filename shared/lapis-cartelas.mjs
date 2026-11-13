import { toLabelFields } from './lapis.mjs';

// Items of a Shopee order as read from the Duoke order panel. One "150 etiquetas"
// pencil item is one cartela, so the quantities say how many cartelas the order needs.
export const MAX_CARTELAS = 10;
const MAX_ITEMS = 20;
const LABEL_LIMIT = 150;

const text = (value, max) => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, max) : '';

export function cleanItems(items) {
  if (!Array.isArray(items)) return undefined;
  const clean = [];
  for (const item of items.slice(0, MAX_ITEMS)) {
    if (!item || typeof item !== 'object') continue;
    const quantity = Number(item.quantity);
    const entry = { title: text(item.title, 200), variation: text(item.variation, 120), sku: text(item.sku, 80), quantity: Number.isInteger(quantity) && quantity >= 1 && quantity <= 99 ? quantity : 1 };
    if (entry.title || entry.sku) clean.push(entry);
  }
  return clean;
}

export const isPencilItem = item => /l[áa]pis/iu.test(`${item.sku} ${item.title}`);
// "Adesivo DTF UV PRETO" -> "DTF UV PRETO": the material is what matters at the printer.
const material = item => text(item.variation.replace(/^adesivo\s+/iu, ''), 40);

// What the items mean for production: cartelas, the material of each one, and other products.
export function itemPlan(items) {
  const list = cleanItems(items);
  if (!list?.length) return { known: false, cartelas: 1, materials: [], others: [], alerts: [] };
  const pencils = list.filter(isPencilItem), others = list.filter(item => !isPencilItem(item));
  const materials = pencils.flatMap(item => Array(item.quantity).fill(material(item)));
  const cartelas = Math.min(MAX_CARTELAS, Math.max(1, materials.length));
  const alerts = [];
  if (materials.length > 1) {
    const kinds = [...new Set(materials.filter(Boolean))];
    alerts.push(`${materials.length} cartelas no pedido${kinds.length > 1 ? ` · materiais diferentes: ${kinds.join(', ')}` : kinds.length ? ` · ${kinds[0]}` : ''}`);
  }
  if (others.length) alerts.push(`Pedido tem outro produto: ${others.map(item => `${item.title || item.sku}${item.variation ? ` (${item.variation})` : ''} x${item.quantity}`).join('; ')}`);
  if (!pencils.length) alerts.push('Nenhum item de lápis encontrado neste pedido.');
  return { known: true, cartelas, materials, others, alerts };
}

const validCartela = (value, count) => Number.isInteger(value) && value >= 1 && value <= count;

// Gives every name a cartela (1..count). Names that already have one keep it, so the
// operator's choice is never undone. Explicit quantities fill the cartelas in order
// (a name may be split between two); names without quantity are spread across them.
export function assignCartelas(names, count) {
  const list = Array.isArray(names) ? names : [];
  if (count <= 1) return list.map(({ cartela, ...entry }) => entry);
  if (list.length && list.every(entry => validCartela(entry.cartela, count))) return list;
  const out = [];
  const fixed = list.filter(entry => validCartela(entry.cartela, count));
  const loose = list.filter(entry => !validCartela(entry.cartela, count)).map(({ cartela, ...entry }) => entry);
  const room = Array.from({ length: count }, (_, i) => LABEL_LIMIT - fixed.filter(entry => entry.cartela === i + 1).reduce((sum, entry) => sum + (entry.quantity ?? 0), 0));
  out.push(...fixed);
  const explicit = loose.filter(entry => entry.quantity !== null && entry.quantity !== undefined);
  const auto = loose.filter(entry => entry.quantity === null || entry.quantity === undefined);
  let current = 0;
  for (const entry of explicit) {
    let left = entry.quantity;
    while (left > 0) {
      while (current < count - 1 && room[current] <= 0) current++;
      const take = current === count - 1 ? left : Math.min(left, room[current]);
      out.push({ ...entry, quantity: take, cartela: current + 1 });
      room[current] -= take; left -= take;
    }
  }
  if (auto.length) {
    if (!explicit.length && !fixed.length && auto.length === 1) {
      // One name, several units: the same name on every cartela.
      for (let i = 1; i <= count; i++) out.push({ ...auto[0], cartela: i });
    } else if (!explicit.length && !fixed.length && auto.length <= 3 && auto.length < count) {
      // Fewer names than cartelas: every cartela carries all of them.
      for (let i = 1; i <= count; i++) for (const entry of auto) out.push({ ...entry, cartela: i });
    } else {
      // One name per cartela in order; leftovers go where there is most room.
      auto.forEach((entry, index) => {
        let target = index < count ? index : room.indexOf(Math.max(...room));
        out.push({ ...entry, cartela: target + 1 });
      });
    }
  }
  return out;
}

const groupLabel = (id, index, count, materials) => count > 1 ? `${id} · ${index}/${count}${materials[index - 1] ? ` · ${materials[index - 1]}` : ''}` : id;

// The orders that go to the print queue: one per cartela. With several cartelas each
// one is named "<pedido> · 1/2 · <material>", which is also what prints on the sheet.
export function cartelaOrders(result, { count = 1, materials = [], shipDate = '' } = {}) {
  const names = assignCartelas(result.names, count);
  return Array.from({ length: Math.max(1, count) }, (_, i) => ({
    ...result, id: groupLabel(result.id, i + 1, count, materials), status: 'found', shipDate,
    names: names.filter(entry => count <= 1 || entry.cartela === i + 1).map(({ cartela, ...entry }) => ({ ...entry })),
  }));
}

// First problem that stops the order from going to the queue, or ''.
export function cartelaError(result, options = {}) {
  const count = options.count || 1;
  const orders = cartelaOrders(result, options);
  for (const [index, order] of orders.entries()) {
    const where = count > 1 ? `Cartela ${index + 1}: ` : '';
    if (!order.names.length) return `${where}sem nomes. Escolha um nome para esta cartela ou diminua o número de cartelas.`;
    try { toLabelFields(order); } catch (error) { return `${where}${error.message}`; }
  }
  return '';
}

// Undoes a split before the number of cartelas changes: same name back to one entry.
export function unassign(names) {
  const merged = [];
  for (const { cartela, ...entry } of Array.isArray(names) ? names : []) {
    const same = merged.find(item => item.name === entry.name && entry.name.trim());
    if (!same) { merged.push({ ...entry }); continue; }
    same.quantity = same.quantity !== null && same.quantity !== undefined && entry.quantity !== null && entry.quantity !== undefined ? same.quantity + entry.quantity : null;
  }
  return merged;
}
