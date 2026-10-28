import test from 'node:test';
import assert from 'node:assert/strict';
import { createSendRun } from '../src/lib/lapis-collection.mjs';

function harness(codes, extras = {}) {
  let sequence = 0;
  const commands = [], received = [];
  const run = createSendRun({ codes, message: '  Qual o nome?  ', makeId: () => `send-${++sequence}`,
    send: (type, requestId, data) => commands.push({ type, requestId, ...data }), onOrder: order => received.push(order), ...extras });
  return { run, commands, received };
}

test('sends one SEND job with the trimmed message and resolves the statuses', async () => {
  const h = harness(['260123ABC', '260456DEF', '260123ABC']);
  const promise = h.run.start();
  assert.deepEqual(h.commands, [{ type: 'SEND', requestId: 'send-1', codes: ['260123ABC', '260456DEF'], message: 'Qual o nome?' }]);
  h.run.receive({ type: 'PROGRESS', requestId: 'send-1', order: { id: '260123ABC', status: 'sent' } });
  h.run.receive({ type: 'PROGRESS', requestId: 'send-1', order: { id: '260456DEF', status: 'unconfirmed', error: 'Confira' } });
  h.run.receive({ type: 'COMPLETE', requestId: 'send-1' });
  const summary = await promise;
  assert.deepEqual(summary.orders, [{ id: '260123ABC', status: 'sent' }, { id: '260456DEF', status: 'unconfirmed', error: 'Confira' }]);
  assert.deepEqual(summary.notAttempted, []); assert.equal(summary.error, null);
});

test('ignores foreign, repeated and invalid events', async () => {
  const h = harness(['260123ABC']);
  const promise = h.run.start();
  h.run.receive({ type: 'PROGRESS', requestId: 'other', order: { id: '260123ABC', status: 'sent' } });
  h.run.receive({ type: 'PROGRESS', requestId: 'send-1', order: { id: '999999ZZZ', status: 'sent' } });
  h.run.receive({ type: 'PROGRESS', requestId: 'send-1', order: { id: '260123ABC', status: 'collected' } });
  h.run.receive({ type: 'PROGRESS', requestId: 'send-1', order: { id: '260123ABC', status: 'failed', error: 'x' } });
  h.run.receive({ type: 'PROGRESS', requestId: 'send-1', order: { id: '260123ABC', status: 'sent' } });
  h.run.receive({ type: 'COMPLETE', requestId: 'send-1' });
  assert.deepEqual((await promise).orders, [{ id: '260123ABC', status: 'failed', error: 'x' }]);
  assert.equal(h.received.length, 1);
});

test('cancel keeps received statuses and waits for the in-flight order', async () => {
  const controller = new AbortController();
  const h = harness(['260123ABC', '260456DEF'], { signal: controller.signal });
  const promise = h.run.start();
  controller.abort();
  assert.equal(h.commands[1].type, 'CANCEL'); assert.equal(h.commands[1].jobId, 'send-1');
  h.run.receive({ type: 'PROGRESS', requestId: 'send-1', order: { id: '260123ABC', status: 'sent' } });
  h.run.receive({ type: 'COMPLETE', requestId: 'send-1', cancelled: true });
  const summary = await promise;
  assert.equal(summary.cancelled, true);
  assert.deepEqual(summary.orders, [{ id: '260123ABC', status: 'sent' }]); assert.deepEqual(summary.notAttempted, ['260456DEF']);
});

test('timeout and errors leave unreceived codes as not attempted, never sent', async () => {
  const h = harness(['260123ABC', '260456DEF'], { timeoutMs: 5 });
  const summary = await h.run.start();
  assert.match(summary.error, /parou de responder/); assert.deepEqual(summary.notAttempted, ['260123ABC', '260456DEF']);
  const e = harness(['260123ABC']);
  const promise = e.run.start();
  e.run.receive({ type: 'ERROR', requestId: 'send-1', error: 'Desconectado' });
  assert.equal((await promise).error, 'Desconectado');
});

test('rejects invalid messages and more than 100 orders before sending', () => {
  assert.throws(() => createSendRun({ codes: ['260123ABC'], message: ' ', send() {}, makeId: () => 'x' }));
  assert.throws(() => createSendRun({ codes: Array.from({ length: 101 }, (_, i) => `CODE${i}X`), message: 'Oi', send() {}, makeId: () => 'x' }));
});
