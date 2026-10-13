import test from 'node:test';
import assert from 'node:assert/strict';
import { queueKey, restoreQueue, saveQueue, orderRevision } from '../src/lib/lapis-queue.mjs';
import { toLabelFields } from '../shared/lapis.mjs';

const order = { id: 'DEMO1', status: 'found', names: [{ name: 'Ana Exemplo', quantity: 75 }, { name: 'Bia Exemplo', quantity: 75 }] };
const page = { pedido: order.id, dataEnvio: '', fields: toLabelFields(order), importRevision: orderRevision(order) };
const labels = fields => fields.flatMap(field => Array.from({ length: field.qty }, () => ({ name: field.nome })));
function storage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}

test('restores one sibling cartela with 75 labels each and original revision', () => {
  const store = storage();
  assert.equal(saveQueue(store, 'session-a', [page], 1000), true);
  const restored = restoreQueue(store, 'session-a', labels, 1001);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].labels.length, 150);
  assert.equal(restored[0].labels.filter(label => label.name === 'Ana Exemplo').length, 75);
  assert.equal(restored[0].importRevision, orderRevision(order));
  assert.equal(JSON.parse(store.getItem('session-a')).pages[0].labels, undefined);
});

test('isolates queues by login session, expires them, and persists clearing', () => {
  const store = storage();
  store.setItem('ss_session', JSON.stringify({ user: 'operator', ts: 1 }));
  const first = queueKey(store);
  store.setItem('ss_session', JSON.stringify({ user: 'operator', ts: 2 }));
  assert.notEqual(queueKey(store), first);
  saveQueue(store, first, [page], 1000);
  assert.deepEqual(restoreQueue(store, queueKey(store), labels, 1001), []);
  assert.deepEqual(restoreQueue(store, first, labels, 1000 + 8 * 60 * 60 * 1000), []);
  assert.equal(store.getItem(first), null);
  saveQueue(store, first, [page]);
  saveQueue(store, first, []);
  assert.deepEqual(restoreQueue(store, first, labels), []);
});

test('malformed or failed storage never restores an old or invalid queue', () => {
  const store = storage();
  store.setItem('queue', '{broken');
  assert.deepEqual(restoreQueue(store, 'queue', labels), []);
  saveQueue(store, 'queue', [page]);
  assert.equal(saveQueue(store, 'queue', [{ ...page, fields: [{ ...page.fields[0], qty: 999 }] }]), false);
  assert.equal(store.getItem('queue'), null);
  assert.equal(saveQueue({ ...store, setItem: () => { throw new Error('Full'); } }, 'queue', [page]), false);
});
