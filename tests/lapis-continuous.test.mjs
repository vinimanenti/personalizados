import test from 'node:test';
import assert from 'node:assert/strict';
import { addToInbox, applyCycle, awaitingFromState, conversationHash, cycleCodes, ENTRY_TTL, expireState, formatCycleMessage, isDue, MAX_CYCLE_ORDERS,
  MAX_FAILURES, normalizeEntry, normalizeState, recordPilotSends, removeFromState, reusableResult, stateList, withAwaiting } from '../shared/lapis-continuous.mjs';

const HOUR = 60 * 60 * 1000;
const NOW = 100 * 24 * HOUR;
const entry = (id, extra = {}) => ({ id, phase: 'pending', addedAt: NOW - HOUR, updatedAt: NOW - HOUR, autoAsks: 0, failures: 0, ...extra });
const state = (...entries) => normalizeState(entries, NOW);

test('normalizeEntry keeps only valid fields and drops expired or malformed entries', () => {
  assert.deepEqual(normalizeEntry({ ...entry('A1'), extra: 'x', hash: 'f'.repeat(64), lastStatus: 'not_found', sentAt: NOW, sendStatus: 'sent' }, NOW),
    { ...entry('A1'), hash: 'f'.repeat(64), lastStatus: 'not_found', sentAt: NOW, sendStatus: 'sent' });
  assert.equal(normalizeEntry(entry('A1', { addedAt: NOW - ENTRY_TTL }), NOW), null, 'expired');
  assert.equal(normalizeEntry(entry('bad id'), NOW), null);
  assert.equal(normalizeEntry(entry('A1', { phase: 'done' }), NOW), null);
  assert.equal(normalizeEntry(entry('A1', { addedAt: NOW + 24 * HOUR }), NOW), null, 'future');
  const loose = normalizeEntry(entry('A1', { hash: 'nothex', sendStatus: 'failed', sentAt: NOW, autoAsks: -1 }), NOW);
  assert.equal(loose.hash, undefined); assert.equal(loose.sendStatus, undefined); assert.equal(loose.autoAsks, 0);
});

test('inbox adds new orders once and keeps the history of known orders', () => {
  const start = state(entry('A1', { phase: 'awaiting', autoAsks: 1 }));
  const { state: next, added } = addToInbox(start, ['A1', 'B2', 'B2', 'mau código'], NOW);
  assert.equal(added, 1);
  assert.equal(next.A1.phase, 'awaiting'); assert.equal(next.A1.autoAsks, 1);
  assert.equal(next.B2.phase, 'pending'); assert.equal(next.B2.addedAt, NOW);
  assert.deepEqual(Object.keys(removeFromState(next, ['A1'])), ['B2']);
});

test('cycle takes pending and awaiting, oldest first, and leaves review and failed for the operator', () => {
  const s = state(entry('NEW', { updatedAt: NOW - 1 }), entry('OLD', { phase: 'awaiting', updatedAt: NOW - 5 * HOUR }),
    entry('REV', { phase: 'review' }), entry('BAD', { phase: 'failed' }));
  assert.deepEqual(cycleCodes(s), ['OLD', 'NEW']);
  const many = state(...Array.from({ length: MAX_CYCLE_ORDERS + 5 }, (_, i) => entry(`P${i}`)));
  assert.equal(cycleCodes(many).length, MAX_CYCLE_ORDERS);
});

test('isDue respects the configured interval and only known intervals', () => {
  assert.equal(isDue(undefined, 15, NOW), true);
  assert.equal(isDue(NOW - 14 * 60 * 1000, 15, NOW), false);
  assert.equal(isDue(NOW - 15 * 60 * 1000, 15, NOW), true);
  assert.equal(isDue(undefined, 1, NOW), false);
});

test('a conversation without news is not sent to the AI again', async () => {
  const hash = await conversationHash('Oi,   tudo bem?\n');
  assert.equal(hash, await conversationHash('Oi, tudo bem?'), 'whitespace does not count as news');
  assert.notEqual(hash, await conversationHash('Oi, tudo bem? O nome é Ana'));
  const source = { id: 'A1', status: 'collected', text: 'Oi, tudo bem?' };
  assert.equal(reusableResult(source, entry('A1', { hash, lastStatus: 'not_found' }), hash).status, 'not_found');
  assert.equal(reusableResult(source, entry('A1', { hash, lastStatus: 'review' }), hash), null, 'only no-name readings are reused');
  assert.equal(reusableResult(source, entry('A1', { hash: 'a'.repeat(64), lastStatus: 'not_found' }), hash), null, 'buyer wrote again');
  assert.equal(reusableResult(source, undefined, hash), null);
});

test('applyCycle removes queued orders, flags new reviews once and plans automatic asks', () => {
  const s = state(entry('AUTO'), entry('REV'), entry('OLDREV', { phase: 'review' }), entry('ASK'), entry('ASKED', { autoAsks: 1 }),
    entry('WAIT', { phase: 'awaiting', sendStatus: 'sent', sentAt: NOW - 2 * HOUR }));
  const classified = { AUTO: 'auto', REV: 'review', OLDREV: 'review', ASK: 'ask', ASKED: 'ask', WAIT: 'ask' };
  const results = new Map([['ASK', { status: 'not_found' }]]);
  const hashes = new Map([['ASK', 'b'.repeat(64)]]);
  const awaiting = { WAIT: { sentAt: NOW - 2 * HOUR, status: 'sent' } };
  const out = applyCycle(s, { ids: Object.keys(classified), classified, results, hashes, awaiting, autoAsk: true, now: NOW });
  assert.deepEqual(out.queued, ['AUTO']); assert.equal(out.state.AUTO, undefined);
  assert.deepEqual(out.newReview, ['REV']);
  assert.equal(out.state.ASK.hash, 'b'.repeat(64)); assert.equal(out.state.ASK.lastStatus, 'not_found');
  assert.equal(out.state.WAIT.phase, 'awaiting');
  assert.deepEqual(out.askIds, ['ASK'], 'ASKED already used its automatic ask; WAIT was asked less than 24 h ago');
  assert.deepEqual(applyCycle(s, { ids: ['ASK'], classified, now: NOW }).askIds, [], 'autoAsk off sends nothing');
});

test('a failed queue keeps auto orders for review instead of losing them', () => {
  const out = applyCycle(state(entry('AUTO')), { ids: ['AUTO'], classified: { AUTO: 'auto' }, queueFailed: true, now: NOW });
  assert.equal(out.state.AUTO.phase, 'review'); assert.deepEqual(out.newReview, ['AUTO']);
});

test('orders leave the cycle after repeated failures and are reported once', () => {
  let s = state(entry('X'));
  const run = () => applyCycle(s, { ids: ['X'], classified: { X: 'failed' }, now: NOW });
  for (let i = 1; i < MAX_FAILURES; i++) { const out = run(); s = out.state; assert.equal(s.X.phase, 'pending'); assert.deepEqual(out.newFailed, []); }
  let out = run(); s = out.state;
  assert.equal(s.X.phase, 'failed'); assert.deepEqual(out.newFailed, ['X']);
  out = run(); assert.deepEqual(out.newFailed, [], 'not reported twice');
  assert.equal(applyCycle(s, { ids: ['X'], classified: { X: 'ask' }, now: NOW }).state.X.failures, 0, 'a successful read resets the counter');
});

test('send results move orders to awaiting and count only automatic asks', () => {
  const s = state(entry('A'), entry('B'), entry('C'));
  const results = [{ id: 'A', status: 'sent' }, { id: 'B', status: 'unconfirmed' }, { id: 'C', status: 'failed' }];
  const auto = recordPilotSends(s, results, { automatic: true, now: NOW });
  assert.equal(auto.A.phase, 'awaiting'); assert.equal(auto.A.autoAsks, 1); assert.equal(auto.B.sendStatus, 'unconfirmed');
  assert.equal(auto.C.phase, 'pending');
  assert.equal(recordPilotSends(s, results, { now: NOW }).A.autoAsks, 0);
});

test('the browser awaiting map and the pilot state stay in sync', () => {
  const awaiting = { A: { sentAt: NOW - HOUR, status: 'sent' }, 'bad id': { sentAt: NOW, status: 'sent' }, B: { sentAt: NOW, status: 'failed' } };
  const s = withAwaiting(state(entry('C')), awaiting, NOW);
  assert.deepEqual(stateList(s).map(e => e.id).sort(), ['A', 'C']);
  assert.equal(s.A.phase, 'awaiting');
  assert.deepEqual(awaitingFromState(s), { A: { sentAt: NOW - HOUR, status: 'sent' } });
  assert.deepEqual(Object.keys(expireState(s, NOW + ENTRY_TTL)), []);
});

test('Telegram summary is plain text, bounded and lists what needs the operator', () => {
  const text = formatCycleMessage({ at: NOW, queued: 4, asked: 2, awaitingCount: 3,
    review: [{ id: 'R1', names: [{ name: 'Ana', quantity: 50 }, { name: 'Bia', quantity: null }], reason: 'Dois nomes, quantidades diferentes' }],
    failed: ['F1'] });
  assert.match(text, /Na fila: 4 · cobrados agora: 2 · aguardando cliente: 3/u);
  assert.match(text, /• R1 — Ana \(50\), Bia · Dois nomes/u);
  assert.match(text, /F1/u);
  const long = formatCycleMessage({ review: Array.from({ length: 60 }, (_, i) => ({ id: `R${i}`, names: [{ name: 'x'.repeat(300) }], reason: '' })) });
  assert.ok(long.length <= 3500); assert.match(long, /e mais 45/u);
});
