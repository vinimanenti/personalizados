import { toLabelFields } from './lapis.mjs';
import { canExtract, hasNames } from './lapis-batch.mjs';

export const AUTOPILOT_DEFAULT_MESSAGE = 'Olá! Para personalizarmos seus lápis, pode nos enviar o nome que vai nas etiquetas? 😊';
export const MAX_SEND_ORDERS = 100;
export const MAX_ASK_MESSAGE = 500;
const ASK_BLOCK = 24 * 60 * 60 * 1000;
const AWAITING_EXPIRY = 7 * 24 * 60 * 60 * 1000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const SENT_STATES = new Set(['sent', 'unconfirmed']);

// Only orders with literal evidence, a printable cartela and no doubts skip review.
export function classifyForAutopilot(source, result, { isQueued = () => false, extractionError } = {}) {
  if (hasNames(result)) {
    if (result.status !== 'found' || result.names.length > 3 || result.reason?.trim() || isQueued(result)) return 'review';
    try { toLabelFields(result); } catch { return 'review'; }
    return 'auto';
  }
  if (extractionError || source?.status !== 'collected' || !canExtract(source)) return 'failed';
  if (!result) return 'pending';
  return result.status === 'not_found' ? 'ask' : 'review';
}

// Classifies a processed batch and says what the UI must do with each order.
export function planAutopilot({ ids, sources, results, extractionErrors = {}, isQueued, awaiting = {}, shipDates = {}, now = Date.now() }) {
  const classified = {};
  const counts = { auto: 0, review: 0, ask: 0, failed: 0, pending: 0 };
  for (const id of new Set(ids)) {
    const kind = classifyForAutopilot(sources.get(id), results.get(id), { isQueued, extractionError: extractionErrors[id] });
    classified[id] = kind; counts[kind]++;
  }
  const autoOrders = Object.keys(classified).filter(id => classified[id] === 'auto').map(id => {
    const result = results.get(id);
    return { ...result, status: 'found', names: result.names.map(entry => ({ ...entry })), shipDate: shipDates[id] || '' };
  });
  const askIds = Object.keys(classified).filter(id => classified[id] === 'ask');
  const nextAwaiting = resolveAwaiting(awaiting, classified);
  return { classified, counts, autoOrders, askIds, askable: planAsk(askIds, nextAwaiting, now), awaiting: nextAwaiting,
    answered: Object.keys(awaiting).filter(id => !(id in nextAwaiting)) };
}

export function validateAskMessage(text) {
  const message = typeof text === 'string' ? text.trim() : '';
  if (!message) throw new Error('Escreva a mensagem que será enviada aos clientes.');
  if (message.length > MAX_ASK_MESSAGE) throw new Error(`A mensagem deve ter no máximo ${MAX_ASK_MESSAGE} caracteres.`);
  return message;
}

// A sent or possibly sent message blocks another ask for 24 hours.
export function planAsk(ids, awaiting, now = Date.now()) {
  return [...new Set(ids)].filter(id => {
    const entry = awaiting[id];
    return !entry || !SENT_STATES.has(entry.status) || now - entry.sentAt >= ASK_BLOCK;
  });
}

export function recordSends(awaiting, results, now = Date.now()) {
  const next = { ...awaiting };
  for (const { id, status } of results) if (SENT_STATES.has(status)) next[id] = { sentAt: now, status };
  return next;
}

export function resolveAwaiting(awaiting, classifiedById) {
  return Object.fromEntries(Object.entries(awaiting).filter(([id]) => !['auto', 'review'].includes(classifiedById[id])));
}

export function loadAwaiting(storage, key, now = Date.now()) {
  if (!key) return {};
  try {
    const data = JSON.parse(storage.getItem(key) || 'null');
    if (data?.version !== 1 || !data.awaiting || typeof data.awaiting !== 'object') return {};
    return Object.fromEntries(Object.entries(data.awaiting).filter(([id, entry]) => ID_PATTERN.test(id) && SENT_STATES.has(entry?.status) &&
      Number.isFinite(entry.sentAt) && entry.sentAt <= now && now - entry.sentAt < AWAITING_EXPIRY)
      .map(([id, entry]) => [id, { sentAt: entry.sentAt, status: entry.status }]));
  } catch { return {}; }
}

export function saveAwaiting(storage, key, awaiting) {
  if (!key) return false;
  try {
    if (Object.keys(awaiting).length) storage.setItem(key, JSON.stringify({ version: 1, awaiting }));
    else storage.removeItem(key);
    return true;
  } catch { return false; }
}
