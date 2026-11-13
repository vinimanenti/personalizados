import test from 'node:test';
import assert from 'node:assert/strict';
import { assignCartelas, cartelaError, cartelaOrders, cleanItems, itemPlan, unassign } from '../shared/lapis-cartelas.mjs';
import { classifyForAutopilot } from '../shared/lapis-autopilot.mjs';
import { createCollectionRun } from '../src/lib/lapis-collection.mjs';

const pencil = (variation, quantity = 1, sku = 'LAPIS-X') => ({ title: '150 Etiquetas Escolares Personalizadas para Lápis e Cadernos', variation, sku, quantity });
const names = (...list) => list.map(([name, quantity = null]) => ({ name, quantity, evidence: '' }));

test('items become cartelas, materials and alerts', () => {
  const two = itemPlan([pencil('Adesivo Transparente', 1, 'LAPIS-TRANSPARENTE'), pencil('Adesivo DTF UV PRETO', 1, 'DTF-UV-LAPIS-PRETO')]);
  assert.equal(two.cartelas, 2); assert.deepEqual(two.materials, ['Transparente', 'DTF UV PRETO']);
  assert.match(two.alerts[0], /2 cartelas no pedido · materiais diferentes: Transparente, DTF UV PRETO/u);
  const copies = itemPlan([pencil('Adesivo Branco', 3)]);
  assert.equal(copies.cartelas, 3); assert.match(copies.alerts[0], /3 cartelas no pedido · Branco/u);
  const other = itemPlan([pencil('Adesivo Branco'), { title: 'Caneca Personalizada', variation: 'Azul', sku: 'CANECA', quantity: 1 }]);
  assert.equal(other.cartelas, 1); assert.match(other.alerts[0], /outro produto: Caneca Personalizada \(Azul\) x1/u);
  assert.deepEqual(itemPlan([pencil('Adesivo Branco')]).alerts, [], 'a single cartela is the normal case');
  assert.deepEqual(itemPlan(undefined), { known: false, cartelas: 1, materials: [], others: [], alerts: [] });
  assert.deepEqual(cleanItems([{ title: ' a  b ', quantity: 500 }, null, { variation: 'só variação' }]), [{ title: 'a b', variation: '', sku: '', quantity: 1 }]);
});

test('300 labels for 2 units are split in order, a name may cross cartelas', () => {
  const result = { id: '2611125FTE7ANW', status: 'found', reason: '', names: names(['Yan', 100], ['Bryan', 100], ['Melry', 100]) };
  const orders = cartelaOrders(result, { count: 2, materials: ['Transparente', 'DTF UV PRETO'] });
  assert.deepEqual(orders.map(order => order.id), ['2611125FTE7ANW · 1/2 · Transparente', '2611125FTE7ANW · 2/2 · DTF UV PRETO']);
  assert.deepEqual(orders.map(order => order.names.map(n => `${n.name}:${n.quantity}`)), [['Yan:100', 'Bryan:50'], ['Bryan:50', 'Melry:100']]);
  assert.equal(cartelaError(result, { count: 2 }), '');
  assert.match(cartelaError(result, { count: 1 }), /no máximo 150/u);
  assert.deepEqual(unassign(assignCartelas(result.names, 2)).map(n => n.quantity), [100, 100, 100], 'changing the count rebuilds the split');
});

test('names without quantity: one per cartela, or repeated when there are fewer names', () => {
  assert.deepEqual(assignCartelas(names(['Ana'], ['Bia']), 2).map(n => `${n.name}:${n.cartela}`), ['Ana:1', 'Bia:2']);
  assert.deepEqual(assignCartelas(names(['Ana']), 3).map(n => n.cartela), [1, 2, 3]);
  assert.deepEqual(assignCartelas(names(['Ana'], ['Bia']), 3).length, 6);
  const chosen = names(['Ana'], ['Bia']).map((n, i) => ({ ...n, cartela: 2 - i }));
  assert.deepEqual(assignCartelas(chosen, 2), chosen, 'the operator choice is kept');
  assert.match(cartelaError({ id: 'X', names: [{ ...chosen[0], cartela: 1 }, { ...chosen[1], cartela: 1 }] }, { count: 2 }), /Cartela 2: sem nomes/u);
  assert.deepEqual(assignCartelas(chosen, 1).map(n => n.cartela), [undefined, undefined]);
});

test('an order with several cartelas or another product never skips the operator', () => {
  const result = { id: 'A', status: 'found', reason: '', names: names(['Ana']) };
  assert.equal(classifyForAutopilot({ id: 'A', status: 'collected', text: 'Ana' }, result), 'auto');
  assert.equal(classifyForAutopilot({ id: 'A', status: 'collected', text: 'Ana', items: [pencil('Adesivo Branco', 2)] }, result), 'review');
  assert.equal(classifyForAutopilot({ id: 'A', status: 'collected', text: 'Ana' }, { ...result, cartelas: 2 }), 'review');
});

test('the Studio keeps only clean items from the extension', async () => {
  const sent = [], got = [];
  const run = createCollectionRun({ codes: ['A1'], send: (type, id, extra) => sent.push({ type, id, ...extra }), makeId: () => 'job', onOrder: order => got.push(order) });
  const done = run.start();
  run.receive({ requestId: 'job', type: 'PROGRESS', order: { id: 'A1', status: 'collected', text: 'Ana', items: [{ title: 'Lápis', quantity: 2, evil: '<script>' }] } });
  run.receive({ requestId: 'job', type: 'COMPLETE' });
  await done;
  assert.deepEqual(got[0].items, [{ title: 'Lápis', variation: '', sku: '', quantity: 2 }]);
});
