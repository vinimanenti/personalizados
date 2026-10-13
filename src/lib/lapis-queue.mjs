const PREFIX = 'ss_lapis_queue_v1:';
const MAX_SIZE = 2000000;
const EXPIRY = 8 * 60 * 60 * 1000;

export function queueKey(storage) {
  try {
    const session = JSON.parse(storage.getItem('ss_session') || 'null');
    return typeof session?.user === 'string' && session.user && Number.isFinite(session.ts)
      ? `${PREFIX}${JSON.stringify([session.user, session.ts])}` : null;
  } catch { return null; }
}

export const orderRevision = order => JSON.stringify([order.id, order.names.map(({ name, quantity }) => [name, quantity])]);

function compactPages(pages) {
  if (!Array.isArray(pages) || pages.length > 1000) throw new Error('Invalid queue');
  const short = (value, max) => typeof value === 'string' && value.length <= max;
  return pages.map(page => {
    if (!page || !short(page.pedido, 200) || !short(page.dataEnvio, 100) || !Array.isArray(page.fields) || page.fields.length > 3) throw new Error('Invalid page');
    const fields = page.fields.map(field => {
      if (!field || !short(field.nome, 500) || !Number.isInteger(field.qty) || field.qty < 0 || field.qty > 150 ||
          !Number.isFinite(field.fs) || field.fs < 8 || field.fs > 120 || !['cookie', 'bebas'].includes(field.font) ||
          !short(field.emoji, 30) || !['before', 'after'].includes(field.emojiPos)) throw new Error('Invalid field');
      return { nome: field.nome, qty: field.qty, fs: field.fs, font: field.font, emoji: field.emoji, emojiPos: field.emojiPos };
    });
    return { pedido: page.pedido, dataEnvio: page.dataEnvio, fields,
      ...(short(page.importRevision, 2000) ? { importRevision: page.importRevision } : {}) };
  });
}

export function restoreQueue(storage, key, buildLabels, now = Date.now()) {
  if (!key) return [];
  try {
    const raw = storage.getItem(key);
    if (!raw || raw.length > MAX_SIZE) return [];
    const draft = JSON.parse(raw);
    if (draft.version !== 1 || !Number.isFinite(draft.ts) || draft.ts > now || now - draft.ts >= EXPIRY) {
      storage.removeItem(key); return [];
    }
    return compactPages(draft.pages).map(page => ({ ...page, labels: buildLabels(page.fields), names: page.fields.filter(field => field.nome.trim()).map(field => field.nome.trim()) }));
  } catch { return []; }
}

export function saveQueue(storage, key, pages, now = Date.now()) {
  if (!key) return false;
  try {
    const raw = JSON.stringify({ version: 1, ts: now, pages: compactPages(pages) });
    if (raw.length > MAX_SIZE) throw new Error('Queue too large');
    storage.setItem(key, raw);
    return true;
  } catch {
    // Never restore an outdated queue after the latest save failed.
    try { storage.removeItem(key); } catch { /* Storage unavailable. */ }
    return false;
  }
}
