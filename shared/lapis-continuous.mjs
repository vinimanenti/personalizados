import { planAsk } from './lapis-autopilot.mjs';

// Continuous autopilot: the Studio tab repeats Processar lote on a timer for the
// orders in the pilot inbox. State lives in Supabase so it survives reloads and
// other computers; this module only plans and never touches React, storage or network.

export const CYCLE_MINUTES = [10, 15, 30, 60];
export const DEFAULT_CYCLE_MINUTES = 15;
export const MAX_CYCLE_ORDERS = 200;
export const MAX_STATE_ENTRIES = 1000;
// Automatic asks per order. Further asks stay a manual decision of the operator.
export const MAX_AUTO_ASKS = 1;
// Consecutive failed cycles (not found in Duoke, collection error) before the
// order leaves the cycle and waits for the operator.
export const MAX_FAILURES = 3;
export const ENTRY_TTL = 7 * 24 * 60 * 60 * 1000;
export const MAX_NOTIFY_CHARS = 3500;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
// done: sent to the print queue today. Kept only until the end of the day in São Paulo,
// so the waiting list shows what already left; it never enters a cycle again.
const PHASES = new Set(['pending', 'awaiting', 'review', 'failed', 'done']);
const DAY = 24 * 60 * 60 * 1000;
// Brazil has no daylight saving time since 2019: São Paulo is always UTC-3.
const SAO_PAULO_OFFSET = 3 * 60 * 60 * 1000;
export const dayKey = at => Math.floor((at - SAO_PAULO_OFFSET) / DAY);
const LAST_STATUS = new Set(['found', 'not_found', 'review']);
const SENT_STATES = new Set(['sent', 'unconfirmed']);
const CLOCK_SKEW = 5 * 60 * 1000;

const isTime = (value, now) => Number.isFinite(value) && value > 0 && value <= now + CLOCK_SKEW;
const count = (value, max) => Number.isInteger(value) && value >= 0 && value <= max ? value : 0;

/** Returns a clean entry or null. Used by the browser and, before storing, by the server. */
export function normalizeEntry(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id) || !PHASES.has(raw.phase)) return null;
  if (!isTime(raw.addedAt, now) || now - raw.addedAt >= ENTRY_TTL) return null;
  if (raw.phase === 'done' && (!isTime(raw.doneAt, now) || dayKey(raw.doneAt) !== dayKey(now))) return null;
  const entry = { id: raw.id, phase: raw.phase, addedAt: raw.addedAt, updatedAt: isTime(raw.updatedAt, now) ? raw.updatedAt : raw.addedAt,
    autoAsks: count(raw.autoAsks, 20), failures: count(raw.failures, 20) };
  if (typeof raw.hash === 'string' && HASH_PATTERN.test(raw.hash)) entry.hash = raw.hash;
  if (LAST_STATUS.has(raw.lastStatus)) entry.lastStatus = raw.lastStatus;
  if (SENT_STATES.has(raw.sendStatus) && isTime(raw.sentAt, now)) { entry.sendStatus = raw.sendStatus; entry.sentAt = raw.sentAt; }
  if (entry.phase === 'review' || entry.phase === 'done') { const review = normalizeReview(raw.review); if (review) entry.review = review; }
  if (entry.phase === 'done') entry.doneAt = raw.doneAt;
  return entry;
}

/** Why normalizeEntry rejects an entry, in words the operator can act on ('' when it is valid). */
export function entryProblem(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) return 'código de pedido inválido';
  if (!PHASES.has(raw.phase)) return 'fase desconhecida';
  const future = value => Number.isFinite(value) && value > now + CLOCK_SKEW;
  if (future(raw.addedAt) || future(raw.doneAt)) return 'horário no futuro (o relógio deste computador parece adiantado)';
  if (!isTime(raw.addedAt, now)) return 'sem horário de entrada';
  if (now - raw.addedAt >= ENTRY_TTL) return 'mais de 7 dias no piloto';
  if (raw.phase === 'done' && (!isTime(raw.doneAt, now) || dayKey(raw.doneAt) !== dayKey(now))) return 'foi para a fila em outro dia';
  return '';
}

/** Moves every time of an entry by offset ms (the difference between this computer's clock and the server's). */
export function shiftEntryTimes(raw, offset) {
  if (!offset || !raw || typeof raw !== 'object') return raw;
  const next = { ...raw };
  for (const key of ['addedAt', 'updatedAt', 'sentAt', 'doneAt']) if (Number.isFinite(next[key])) next[key] += offset;
  return next;
}

const CONTROL = /[\u0000-\u001f\u007f]/gu;
const cleanText = (value, size) => typeof value === 'string' ? value.replace(CONTROL, ' ').trim().slice(0, size) : '';
/** Suggested names and reason of an order in review, so read-only tools (MCP) can explain it. Bounded and plain text. */
export function normalizeReview(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const names = (Array.isArray(raw.names) ? raw.names : []).slice(0, 10).map(item => {
    const name = cleanText(item?.name, 120);
    const quantity = Number.isInteger(item?.quantity) && item.quantity >= 1 && item.quantity <= 150 ? item.quantity : null;
    return name ? { name, quantity } : null;
  }).filter(Boolean);
  const reason = cleanText(raw.reason, 200);
  return names.length || reason ? { names, reason } : null;
}

export function normalizeState(list, now = Date.now()) {
  const state = Object.create(null);
  if (!Array.isArray(list)) return state;
  for (const raw of list.slice(0, MAX_STATE_ENTRIES)) {
    const entry = normalizeEntry(raw, now);
    if (entry && !state[entry.id]) state[entry.id] = entry;
  }
  return state;
}

export const stateList = state => Object.values(state);

/** Orders typed or pasted by the operator enter the inbox once; known orders keep their history. */
export function addToInbox(state, ids, now = Date.now()) {
  const next = Object.assign(Object.create(null), state);
  let added = 0;
  for (const id of new Set(ids)) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id) || next[id]) continue;
    if (Object.keys(next).length >= MAX_STATE_ENTRIES) break;
    next[id] = { id, phase: 'pending', addedAt: now, updatedAt: now, autoAsks: 0, failures: 0 };
    added++;
  }
  return { state: next, added };
}

export function removeFromState(state, ids) {
  const next = Object.assign(Object.create(null), state);
  for (const id of ids) delete next[id];
  return next;
}

/** Drops orders older than the TTL; the operator decides about them in the review screen. */
export function expireState(state, now = Date.now()) {
  return normalizeState(stateList(state), now);
}

/** Orders for the next cycle: pending and awaiting, oldest activity first. Review and failed wait for the operator. */
export function cycleCodes(state, limit = MAX_CYCLE_ORDERS) {
  return stateList(state).filter(entry => entry.phase === 'pending' || entry.phase === 'awaiting')
    .sort((a, b) => a.updatedAt - b.updatedAt || (a.id < b.id ? -1 : 1)).slice(0, limit).map(entry => entry.id);
}

export function isDue(lastRunAt, minutes, now = Date.now()) {
  if (!CYCLE_MINUTES.includes(minutes)) return false;
  return !Number.isFinite(lastRunAt) || now - lastRunAt >= minutes * 60 * 1000;
}

/** Whitespace-insensitive SHA-256 of a conversation. Works in browsers, Node 20 and Deno. */
export async function conversationHash(text) {
  const normalized = String(text || '').replace(/\s+/gu, ' ').trim();
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// The AI is paid per call. A conversation already read without a name is not sent
// again until the buyer writes something new.
export function reusableResult(source, entry, hash) {
  if (!entry || entry.lastStatus !== 'not_found' || !entry.hash || entry.hash !== hash) return null;
  return { id: source.id, status: 'not_found', names: [], reason: 'Sem mensagem nova do cliente desde a última leitura.', text: source.text };
}

/** Mirrors the browser awaiting map ({ id: { sentAt, status } }) into the pilot state. */
export function withAwaiting(state, awaiting, now = Date.now()) {
  const next = Object.assign(Object.create(null), state);
  for (const [id, sent] of Object.entries(awaiting || {})) {
    if (!ID_PATTERN.test(id) || !SENT_STATES.has(sent?.status) || !isTime(sent.sentAt, now)) continue;
    const entry = next[id] || { id, phase: 'awaiting', addedAt: Math.min(sent.sentAt, now), updatedAt: sent.sentAt, autoAsks: 0, failures: 0 };
    next[id] = { ...entry, phase: entry.phase === 'pending' ? 'awaiting' : entry.phase, sentAt: sent.sentAt, sendStatus: sent.status };
  }
  return expireState(next, now);
}

export function awaitingFromState(state) {
  const awaiting = {};
  for (const entry of stateList(state)) if (entry.phase === 'awaiting' && entry.sendStatus) awaiting[entry.id] = { sentAt: entry.sentAt, status: entry.sendStatus };
  return awaiting;
}

/**
 * Applies a processed cycle (planAutopilot output) to the pilot state.
 * results: Map id -> extraction result; hashes: Map id -> conversation hash.
 * Returns the new state, the orders to ask automatically and what is new for the operator.
 */
export function applyCycle(state, { ids, classified, results = new Map(), hashes = new Map(), awaiting = {}, queueFailed = false, autoAsk = false, now = Date.now() }) {
  const next = Object.assign(Object.create(null), state);
  const queued = [], newReview = [], newFailed = [], askCandidates = [];
  for (const id of new Set(ids)) {
    const previous = next[id] || { id, phase: 'pending', addedAt: now, updatedAt: now, autoAsks: 0, failures: 0 };
    let kind = classified[id];
    if (kind === 'auto' && queueFailed) kind = 'review';
    // An order already sent to the queue today stays there (e.g. its code pasted again).
    if (previous.phase === 'done') { if (kind === 'auto') queued.push(id); continue; }
    if (kind === 'auto') { next[id] = doneEntry(previous, results.get(id)?.names, now); queued.push(id); continue; }
    if (!kind || kind === 'pending') continue;
    const entry = { ...previous, updatedAt: now };
    if (hashes.has(id)) entry.hash = hashes.get(id);
    const status = results.get(id)?.status;
    if (LAST_STATUS.has(status)) entry.lastStatus = status;
    delete entry.review;
    if (kind === 'review') {
      if (previous.phase !== 'review') newReview.push(id);
      Object.assign(entry, { phase: 'review', failures: 0 });
      const result = results.get(id);
      const review = normalizeReview({ names: result?.names, reason: result?.reason || (queueFailed ? 'Aprovado, mas não entrou na fila de impressão.' : '') });
      if (review) entry.review = review;
      else if (previous.review) entry.review = previous.review;
    } else if (kind === 'ask') {
      Object.assign(entry, { phase: awaiting[id] ? 'awaiting' : 'pending', failures: 0 });
      if (entry.autoAsks < MAX_AUTO_ASKS) askCandidates.push(id);
    } else if (kind === 'failed') {
      entry.failures = Math.min(20, entry.failures + 1);
      if (entry.failures >= MAX_FAILURES) { if (previous.phase !== 'failed') newFailed.push(id); entry.phase = 'failed'; }
      else entry.phase = 'pending';
    }
    next[id] = entry;
  }
  const askIds = autoAsk ? planAsk(askCandidates, awaiting, now) : [];
  return { state: next, askIds, queued, newReview, newFailed };
}

function doneEntry(previous, names, now) {
  const { review: _review, failures: _failures, ...rest } = previous;
  const entry = { ...rest, phase: 'done', doneAt: now, updatedAt: now, failures: 0 };
  const review = normalizeReview({ names, reason: '' });
  if (review) entry.review = review;
  else if (previous.review?.names?.length) entry.review = { names: previous.review.names, reason: '' };
  return entry;
}

/**
 * Orders the operator sent to the print queue by hand. They stay visible as done
 * until the end of the day. namesById: Map id -> [{ name, quantity }].
 */
export function markDone(state, ids, { namesById = new Map(), now = Date.now() } = {}) {
  const next = Object.assign(Object.create(null), state);
  for (const id of new Set(ids)) {
    if (!next[id] || next[id].phase === 'done') continue;
    next[id] = doneEntry(next[id], namesById.get(id), now);
  }
  return next;
}

/** Records the outcome of a send run. Automatic sends count toward MAX_AUTO_ASKS. */
export function recordPilotSends(state, results, { automatic = false, now = Date.now() } = {}) {
  const next = Object.assign(Object.create(null), state);
  for (const { id, status } of results) {
    if (!SENT_STATES.has(status) || !next[id] || next[id].phase === 'done') continue;
    next[id] = { ...next[id], phase: next[id].phase === 'review' ? 'review' : 'awaiting', sentAt: now, sendStatus: status, updatedAt: now,
      autoAsks: next[id].autoAsks + (automatic ? 1 : 0) };
  }
  return next;
}

const clip = (text, size) => text.length > size ? `${text.slice(0, size - 1)}…` : text;

/** Plain-text Telegram message (no parse mode, so conversation text cannot format or inject links). */
export function formatCycleMessage({ at = Date.now(), queued = 0, review = [], asked = 0, awaitingCount = 0, failed = [], note = '' }) {
  const time = new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  const lines = [`Lápis · piloto automático · ${time}`];
  if (note) lines.push(clip(note, 300));
  lines.push(`${queued ? `Na fila: ${queued} · ` : ''}cobrados agora: ${asked} · aguardando cliente: ${awaitingCount}`);
  if (review.length) {
    lines.push('', `Para revisar (${review.length}):`);
    // 15 lines of up to 160 characters keep the message far below Telegram's limit,
    // so the "e mais" line is never cut.
    for (const order of review.slice(0, 15)) {
      const names = (order.names || []).map(entry => entry.quantity ? `${entry.name} (${entry.quantity})` : entry.name).join(', ');
      lines.push(clip(`• ${order.id}${names ? ` — ${names}` : ''}${order.reason ? ` · ${order.reason}` : ''}`, 160));
    }
    if (review.length > 15) lines.push(`… e mais ${review.length - 15}. Confira no Studio.`);
  }
  if (failed.length) lines.push('', clip(`Sem leitura após ${MAX_FAILURES} tentativas (${failed.length}): ${failed.join(', ')}`, 600));
  return clip(lines.join('\n'), MAX_NOTIFY_CHARS);
}
