import test from 'node:test';
import assert from 'node:assert/strict';
import { exportDuokeText, parseDuokeText } from '../shared/lapis.mjs';
import { canExtract, compactDraft, mergeCollected, orderBucket, planBatch } from '../shared/lapis-batch.mjs';
import { createCollectionRun } from '../src/lib/lapis-collection.mjs';
import { extractOrders } from '../src/lib/lapis-api.mjs';

const source = id => ({ id, status: 'collected', text: 'Nome: Ana Exemplo' });
const result = id => ({ id, status: 'found', reason: '', text: 'Nome: Ana Exemplo', names: [{ name: 'Ana Exemplo', quantity: null, evidence: 'Nome: Ana Exemplo' }] });
const empty = () => ({ codes: '', raw: '', collected: [], results: {}, selected: {}, reviewed: {}, extractionErrors: {}, shipDates: {} });
function harness(codes, extras = {}) {
  let sequence = 0;
  const commands = [], collected = [], progress = [];
  const run = createCollectionRun({ codes, makeId: () => `job-${++sequence}`, send: (type, requestId, data) => commands.push({ type, requestId, ...data }),
    onOrder: order => collected.push(order), onProgress: value => progress.push(value), ...extras });
  const finishChunk = command => {
    for (const id of command.codes) run.receive({ type: 'PROGRESS', requestId: command.requestId, order: source(id) });
    run.receive({ type: 'COMPLETE', requestId: command.requestId });
  };
  return { run, commands, collected, progress, finishChunk };
}

test('300 orders collect in 200 + 100, round-trip one TXT and extract in thirty calls', async () => {
  const codes = Array.from({ length: 300 }, (_, index) => `ORDER${index + 1}`);
  const h = harness(codes);
  const promise = h.run.start();
  assert.equal(h.commands.length, 1);
  h.finishChunk(h.commands[0]);
  assert.equal(h.commands.length, 2);
  assert.deepEqual(h.commands.map(command => command.codes.length), [200, 100]);
  h.finishChunk(h.commands[1]);
  const collected = await promise;
  assert.deepEqual(collected.map(order => order.id), codes);
  assert.deepEqual(h.progress.at(-1), { completed: 300, total: 300 });
  assert.deepEqual(parseDuokeText(exportDuokeText(collected)), collected);
  let calls = 0, applied = 0;
  const names = await extractOrders({ orders: collected, endpoint: '/extract', accessCode: 'test-only',
    fetchImpl: async (_url, options) => {
      const chunk = JSON.parse(options.body).orders;
      assert.equal(chunk.length, 10); calls++;
      return Response.json({ orders: chunk.map(order => result(order.id)) });
    }, onChunk: chunk => { applied += chunk.length; } });
  assert.equal(calls, 30); assert.equal(applied, 300);
  assert.deepEqual(names.map(order => order.id), codes);
});

test('TXT preserves multiline text, accents, status and error without treating message text as an order', () => {
  const original = [
    { ...source('ABC'), text: 'João D’Ávila\nPEDIDO: NOT_AN_ORDER\n\n| literal\nSTATUS: error\n  ' },
    { id: 'MISSING', status: 'not_found', text: '' },
    { id: 'ERROR', status: 'error', text: 'Texto parcial', error: 'Falha\nPEDIDO: FAKE' },
  ];
  assert.deepEqual(parseDuokeText(exportDuokeText(original)), original);
  assert.throws(() => exportDuokeText([source('A'), source('A')]), /duplicado/);
  assert.throws(() => parseDuokeText(exportDuokeText(original).replace('STATUS: not_found', 'STATUS: unexpected')), /inválido/);
});

test('collection rejects unrelated, repeated, oversized and late events', async () => {
  const h = harness(['A', 'B']);
  const promise = h.run.start();
  const requestId = h.commands[0].requestId;
  h.run.receive({ type: 'PROGRESS', requestId: 'other', order: source('A') });
  h.run.receive({ type: 'PROGRESS', requestId, order: source('UNKNOWN') });
  h.run.receive({ type: 'PROGRESS', requestId, order: { ...source('A'), text: 'x'.repeat(12001) } });
  h.run.receive({ type: 'PROGRESS', requestId, order: source('A') });
  h.run.receive({ type: 'PROGRESS', requestId, order: source('A') });
  assert.equal(h.collected.length, 1);
  h.finishChunk(h.commands[0]);
  assert.equal((await promise).length, 2);
  h.run.receive({ type: 'ERROR', requestId, error: 'Late error' });
  assert.equal(h.collected.length, 2);
});

test('cancel before a COMPLETE stops the next 100 orders and retains delivered results', async () => {
  const controller = new AbortController();
  const h = harness(Array.from({ length: 300 }, (_, i) => `P${i}`), { signal: controller.signal });
  const promise = h.run.start();
  const requestId = h.commands[0].requestId;
  h.run.receive({ type: 'PROGRESS', requestId, order: source('P0') });
  controller.abort();
  h.run.receive({ type: 'COMPLETE', requestId });
  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(h.collected.length, 1);
  assert.deepEqual(h.commands.map(command => command.type), ['START', 'CANCEL']);
});

test('cancel timeout and unmount release work without launching another collection', async () => {
  const controller = new AbortController();
  const h = harness(['A'], { signal: controller.signal, cancelTimeoutMs: 2 });
  const promise = h.run.start(); controller.abort();
  await assert.rejects(promise, { name: 'AbortError' });
  const other = harness(['B']);
  const pending = other.run.start(); other.run.dispose();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(other.commands.map(command => command.type), ['START', 'CANCEL']);
});

test('incomplete completion, disconnect and watchdog fail without losing delivered orders', async () => {
  for (const type of ['COMPLETE', 'ERROR']) {
    const h = harness(['A', 'B']); const promise = h.run.start();
    const requestId = h.commands[0].requestId;
    h.run.receive({ type: 'PROGRESS', requestId, order: source('A') });
    h.run.receive({ type, requestId });
    await assert.rejects(promise, /pendentes|interrompida/);
    assert.equal(h.collected.length, 1); assert.equal(h.commands.length, 1);
  }
  const h = harness(['A'], { timeoutMs: 2 });
  await assert.rejects(h.run.start(), /parou de responder/);
  assert.equal(h.commands.at(-1).type, 'CANCEL');
});

test('retry plan preserves found and manually corrected orders, resumes only missing collection', () => {
  const draft = empty();
  draft.collected = [source('FOUND'), source('READY'), { id: 'MISSING', status: 'not_found', text: '' }, { id: 'MANUAL', status: 'error', text: '' }];
  draft.results = { FOUND: result('FOUND'), MISSING: { id: 'MISSING', names: [], status: 'not_found' }, MANUAL: result('MANUAL') };
  const plan = planBatch(draft, ['FOUND', 'READY', 'MISSING', 'MANUAL', 'NEW']);
  assert.deepEqual(plan.codes, ['READY', 'MISSING', 'NEW']);
  assert.deepEqual(plan.collect, ['MISSING', 'NEW']);
  assert.deepEqual(planBatch(draft, plan.codes, { retry: true }).collect, ['READY', 'MISSING', 'NEW']);
  assert.throws(() => planBatch(draft, Array.from({ length: 501 }, (_, i) => `NEW${i}`)), /500/);
});

test('recollecting a pending order clears only its stale extraction and keeps shipping dates and reviewed peers', () => {
  const draft = { ...empty(), collected: [source('OK'), source('RETRY')],
    results: { OK: result('OK'), RETRY: { id: 'RETRY', status: 'not_found', names: [] } },
    reviewed: { OK: 'reviewed', RETRY: 'stale' }, extractionErrors: { RETRY: 'Timeout' }, shipDates: { RETRY: '14/10/2026' } };
  const next = mergeCollected(draft, [source('RETRY')]);
  assert.equal(next.collected.length, 2);
  assert.equal(next.reviewed.OK, 'reviewed'); assert.equal(next.results.OK, draft.results.OK);
  assert.equal(next.results.RETRY, undefined); assert.equal(next.reviewed.RETRY, undefined);
  assert.equal(next.extractionErrors.RETRY, undefined); assert.equal(next.selected.RETRY, true);
  assert.equal(next.shipDates.RETRY, '14/10/2026');
  assert.ok(draft.results.RETRY); // The prior state is not mutated.
});

test('missing names, unprocessed conversations and API/collection failures have separate groups', () => {
  const s = source('A');
  assert.equal(orderBucket(s, result('A')), 'names');
  assert.equal(orderBucket(s, { names: [], status: 'not_found' }), 'missing');
  assert.equal(orderBucket(s, { names: [], status: 'review' }), 'missing');
  assert.equal(orderBucket(s), 'waiting');
  assert.equal(orderBucket(s, undefined, 'Timeout'), 'errors');
  assert.equal(orderBucket({ ...s, status: 'error' }), 'errors');
  assert.equal(orderBucket({ ...s, status: 'not_found' }), 'missing');
  assert.equal(orderBucket({ ...s, text: '' }), 'missing', 'confirmed conversation where the buyer has not written');
  assert.equal(orderBucket({ ...s, text: 'x'.repeat(12001) }), 'errors');
  assert.equal(orderBucket({ ...s, status: 'error' }, result('A')), 'names');
  assert.equal(canExtract({ ...s, text: 'x'.repeat(12001) }), false);
});

test('compact draft stores one copy of each conversation without persisting review approval', () => {
  const draft = { ...empty(), raw: 'large pasted report', collected: [source('A')], results: { A: result('A') }, reviewed: { A: 'approved' } };
  const compact = compactDraft(draft);
  assert.equal(compact.raw, ''); assert.deepEqual(compact.reviewed, {});
  assert.equal(compact.results.A.text, undefined);
  assert.equal(compact.collected[0].text, draft.collected[0].text);
  assert.ok(draft.results.A.text);
});
