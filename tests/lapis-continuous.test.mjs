import test from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, markDone, normalizeReview, addToInbox, applyCycle, awaitingFromState, conversationHash, cycleCodes, ENTRY_TTL, expireState, formatCycleMessage, isDue, MAX_CYCLE_ORDERS,
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
  assert.deepEqual(out.queued, ['AUTO']); assert.equal(out.state.AUTO.phase, 'done'); assert.equal(out.state.AUTO.doneAt, NOW);
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

test('orders in review keep their suggested names and reason, bounded and plain', () => {
  const s = normalizeState([{ id: 'R1', phase: 'pending', addedAt: NOW - HOUR, updatedAt: NOW - HOUR, autoAsks: 0, failures: 0 }], NOW);
  const results = new Map([['R1', { status: 'review', reason: 'Dois nomes\ncom quantidades', names: [{ name: 'Ana', quantity: 50, evidence: 'Ana 50' }, { name: 'Bia', quantity: 999 }] }]]);
  const out = applyCycle(s, { ids: ['R1'], classified: { R1: 'review' }, results, now: NOW });
  assert.deepEqual(out.state.R1.review, { names: [{ name: 'Ana', quantity: 50 }, { name: 'Bia', quantity: null }], reason: 'Dois nomes com quantidades' });
  assert.deepEqual(normalizeEntry(out.state.R1, NOW).review, out.state.R1.review, 'survives the server validation');
  const asked = applyCycle(out.state, { ids: ['R1'], classified: { R1: 'ask' }, now: NOW });
  assert.equal(asked.state.R1.review, undefined, 'leaving review drops the details');
  assert.equal(normalizeEntry({ ...out.state.R1, phase: 'pending' }, NOW).review, undefined, 'only review entries carry details');
  assert.equal(normalizeReview({ names: Array.from({ length: 20 }, () => ({ name: 'x'.repeat(500) })) }).names.length, 10);
  assert.equal(normalizeReview({ names: [{ name: 'x'.repeat(500) }] }).names[0].name.length, 120);
  assert.equal(normalizeReview({ names: [], reason: '' }), null);
  const failedQueue = applyCycle(s, { ids: ['R1'], classified: { R1: 'auto' }, results: new Map([['R1', { status: 'found', names: [{ name: 'Caio' }], reason: '' }]]), queueFailed: true, now: NOW });
  assert.match(failedQueue.state.R1.review.reason, /não entrou na fila/u);
});

test('orders sent to the queue stay visible as done until the end of the day in São Paulo', () => {
  const results = new Map([['A', { status: 'found', names: [{ name: 'SOPHIA', quantity: null, evidence: 'SOPHIA' }] }]]);
  const out = applyCycle(normalizeState([{ id: 'A', phase: 'pending', addedAt: NOW - HOUR, updatedAt: NOW - HOUR, autoAsks: 0, failures: 0 }], NOW),
    { ids: ['A'], classified: { A: 'auto' }, results, now: NOW });
  assert.deepEqual(out.state.A.review, { names: [{ name: 'SOPHIA', quantity: null }], reason: '' });
  assert.deepEqual(cycleCodes(out.state), [], 'done never enters a cycle');
  assert.equal(normalizeEntry(out.state.A, NOW).phase, 'done', 'survives the server validation the same day');
  const endOfDay = (dayKey(NOW) + 1) * 24 * HOUR + 3 * HOUR;
  assert.equal(normalizeEntry(out.state.A, endOfDay - 1)?.phase, 'done', 'still there at 23:59 in São Paulo');
  assert.equal(normalizeEntry(out.state.A, endOfDay), null, 'gone at midnight in São Paulo');
  assert.equal(normalizeEntry({ ...out.state.A, doneAt: undefined }, NOW), null, 'done needs a valid doneAt');
});

test('a done order is not reopened by a pasted code, a later cycle or a send result', () => {
  const done = normalizeState([{ id: 'A', phase: 'done', doneAt: NOW - HOUR, addedAt: NOW - 2 * HOUR, updatedAt: NOW - HOUR, autoAsks: 0, failures: 0 }], NOW);
  assert.equal(addToInbox(done, ['A'], NOW).added, 0);
  assert.equal(applyCycle(done, { ids: ['A'], classified: { A: 'ask' }, now: NOW }).state.A.phase, 'done');
  assert.equal(applyCycle(done, { ids: ['A'], classified: { A: 'review' }, now: NOW }).newReview.length, 0);
  assert.equal(recordPilotSends(done, [{ id: 'A', status: 'sent' }], { now: NOW }).A.phase, 'done');
});

test('orders queued by hand become done with their names', () => {
  const s = normalizeState([{ id: 'R', phase: 'review', addedAt: NOW - HOUR, updatedAt: NOW - HOUR, autoAsks: 0, failures: 0, review: { names: [{ name: 'Ana', quantity: 50 }], reason: 'dúvida' } }], NOW);
  const byHand = markDone(s, ['R', 'missing'], { namesById: new Map([['R', [{ name: 'Ana Clara', quantity: 50 }]]]), now: NOW });
  assert.equal(byHand.R.phase, 'done'); assert.deepEqual(byHand.R.review, { names: [{ name: 'Ana Clara', quantity: 50 }], reason: '' });
  assert.equal(byHand.missing, undefined);
  assert.deepEqual(markDone(s, ['R'], { now: NOW }).R.review, { names: [{ name: 'Ana', quantity: 50 }], reason: '' }, 'keeps the suggested names without a correction');
});

test('Telegram summary leaves out the queue count when nothing was queued and carries the note', () => {
  const text = formatCycleMessage({ at: NOW, asked: 1, awaitingCount: 2, note: '3 pedidos novos prontos para conferir no Studio.' });
  assert.doesNotMatch(text, /Na fila/u);
  assert.match(text, /3 pedidos novos prontos para conferir/u);
  assert.match(text, /cobrados agora: 1 · aguardando cliente: 2/u);
});
