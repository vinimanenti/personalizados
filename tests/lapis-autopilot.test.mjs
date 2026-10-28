import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTOPILOT_DEFAULT_MESSAGE, classifyForAutopilot, loadAwaiting, planAsk, planAutopilot, recordSends, resolveAwaiting, saveAwaiting, validateAskMessage } from '../shared/lapis-autopilot.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const source = (id = 'A1', extra = {}) => ({ id, status: 'collected', text: 'Nome: Ana Exemplo', ...extra });
const name = (value, quantity = null) => ({ name: value, quantity, evidence: `Nome: ${value}` });
const found = (names = [name('Ana Exemplo')], extra = {}) => ({ id: 'A1', status: 'found', reason: '', names, ...extra });
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key), data };
}

test('auto-approves a found order with up to three valid names', () => {
  assert.equal(classifyForAutopilot(source(), found()), 'auto');
  assert.equal(classifyForAutopilot(source(), found([name('Ana'), name('Bia'), name('Caio')])), 'auto');
});

test('each auto-approval criterion sends the order to review', () => {
  assert.equal(classifyForAutopilot(source(), found([name('Ana'), name('Bia'), name('Caio'), name('Davi')])), 'review');
  assert.equal(classifyForAutopilot(source(), found([name('Ana', 100), name('Bia', 60)])), 'review');
  assert.equal(classifyForAutopilot(source(), found(undefined, { reason: 'Quantidade ambígua.' })), 'review');
  assert.equal(classifyForAutopilot(source(), found(undefined, { status: 'review' })), 'review');
  assert.equal(classifyForAutopilot(source(), found(), { isQueued: () => true }), 'review');
});

test('asks only collected conversations whose extraction found no name', () => {
  const missing = { id: 'A1', status: 'not_found', reason: '', names: [] };
  assert.equal(classifyForAutopilot(source(), missing), 'ask');
  assert.equal(classifyForAutopilot(source('A1', { status: 'not_found', text: '' }), missing), 'failed');
  assert.equal(classifyForAutopilot(source('A1', { status: 'error', text: '', error: 'x' }), null), 'failed');
  assert.equal(classifyForAutopilot(source(), null, { extractionError: 'Gemini indisponível' }), 'failed');
  assert.equal(classifyForAutopilot(source(), null), 'pending');
  assert.equal(classifyForAutopilot(source('A1', { text: '   ' }), null), 'failed');
});

test('validates the ask message', () => {
  assert.equal(validateAskMessage(`  ${AUTOPILOT_DEFAULT_MESSAGE}  `), AUTOPILOT_DEFAULT_MESSAGE);
  assert.throws(() => validateAskMessage('   '));
  assert.throws(() => validateAskMessage('a'.repeat(501)));
  assert.throws(() => validateAskMessage(42));
});

test('blocks a new ask for 24 hours after sent or unconfirmed', () => {
  const now = 10 * DAY;
  const awaiting = { A1: { sentAt: now - DAY + 1, status: 'sent' }, A2: { sentAt: now - DAY, status: 'sent' }, A3: { sentAt: now - HOUR, status: 'unconfirmed' } };
  assert.deepEqual(planAsk(['A1', 'A2', 'A3', 'A4', 'A4'], awaiting, now), ['A2', 'A4']);
});

test('records only confirmed or possibly sent messages', () => {
  const next = recordSends({ A0: { sentAt: 1, status: 'sent' } }, [{ id: 'A1', status: 'sent' }, { id: 'A2', status: 'unconfirmed' }, { id: 'A3', status: 'failed' }], 500);
  assert.deepEqual(next, { A0: { sentAt: 1, status: 'sent' }, A1: { sentAt: 500, status: 'sent' }, A2: { sentAt: 500, status: 'unconfirmed' } });
});

test('awaiting list expires after seven days and ignores malformed data', () => {
  const now = 20 * DAY;
  const storage = memoryStorage({ key: JSON.stringify({ version: 1, awaiting: {
    A1: { sentAt: now - 7 * DAY + 1, status: 'sent' }, A2: { sentAt: now - 7 * DAY, status: 'sent' },
    A3: { sentAt: now + DAY, status: 'sent' }, A4: { sentAt: now, status: 'failed' }, 'bad id!': { sentAt: now, status: 'sent' },
  } }) });
  assert.deepEqual(loadAwaiting(storage, 'key', now), { A1: { sentAt: now - 7 * DAY + 1, status: 'sent' } });
  assert.deepEqual(loadAwaiting(memoryStorage({ key: '{oops' }), 'key', now), {});
  assert.deepEqual(loadAwaiting(storage, null, now), {});
  const broken = { getItem: () => { throw new Error('blocked'); } };
  assert.deepEqual(loadAwaiting(broken, 'key', now), {});
});

test('saves the awaiting list and reports storage failure', () => {
  const storage = memoryStorage();
  assert.equal(saveAwaiting(storage, 'key', { A1: { sentAt: 5, status: 'sent' } }), true);
  assert.deepEqual(loadAwaiting(storage, 'key', 6), { A1: { sentAt: 5, status: 'sent' } });
  assert.equal(saveAwaiting(storage, 'key', {}), true);
  assert.equal(storage.data.has('key'), false);
  assert.equal(saveAwaiting({ setItem: () => { throw new Error('full'); }, removeItem() {} }, 'key', { A1: { sentAt: 5, status: 'sent' } }), false);
  assert.equal(saveAwaiting(storage, null, {}), false);
});

test('resolves awaiting orders that answered', () => {
  const awaiting = { A1: { sentAt: 1, status: 'sent' }, A2: { sentAt: 1, status: 'sent' }, A3: { sentAt: 1, status: 'sent' }, A4: { sentAt: 1, status: 'sent' } };
  assert.deepEqual(resolveAwaiting(awaiting, { A1: 'auto', A2: 'review', A3: 'ask', A4: 'failed' }), { A3: { sentAt: 1, status: 'sent' }, A4: { sentAt: 1, status: 'sent' } });
});

test('plans a processed batch: queue safe orders, ask missing names, resolve answers', () => {
  const now = 10 * DAY;
  const sources = new Map([['A1', source('A1')], ['A2', source('A2')], ['A3', source('A3')], ['A4', source('A4', { status: 'error', text: '' })], ['A5', source('A5')]]);
  const results = new Map([
    ['A1', { ...found(), id: 'A1' }],
    ['A2', { id: 'A2', status: 'not_found', reason: '', names: [] }],
    ['A3', { ...found(undefined, { reason: 'Dois nomes possíveis.' }), id: 'A3' }],
    ['A5', { id: 'A5', status: 'not_found', reason: '', names: [] }],
  ]);
  const awaiting = { A1: { sentAt: now - HOUR, status: 'sent' }, A5: { sentAt: now - HOUR, status: 'sent' } };
  const plan = planAutopilot({ ids: ['A1', 'A2', 'A3', 'A4', 'A5'], sources, results, isQueued: () => false, awaiting, shipDates: { A1: '01/11/2026' }, now });
  assert.deepEqual(plan.counts, { auto: 1, review: 1, ask: 2, failed: 1, pending: 0 });
  assert.deepEqual(plan.autoOrders.map(order => [order.id, order.shipDate, order.status]), [['A1', '01/11/2026', 'found']]);
  assert.deepEqual(plan.askIds, ['A2', 'A5']);
  assert.deepEqual(plan.askable, ['A2'], 'A5 was asked an hour ago');
  assert.deepEqual(plan.awaiting, { A5: awaiting.A5 }); assert.deepEqual(plan.answered, ['A1']);
  assert.notEqual(plan.autoOrders[0].names, results.get('A1').names, 'queued orders are copies');
});
