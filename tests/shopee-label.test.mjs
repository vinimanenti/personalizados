import test from 'node:test';
import assert from 'node:assert/strict';
import { linesFromTextItems, parseShopeeLabel, mergeLabelCodes } from '../shared/shopee-label.mjs';

// Fictitious data in the Shopee label layout (pdf.js items: str + transform[4]=x, transform[5]=y).
const item = (str, x, y) => ({ str, transform: [1, 0, 0, 1, x, y] });
const labelItems = [
  item('DESTINATÁRIO', 10, 800),
  item('Fulano de Tal', 10, 780),
  item('R', 200, 741),
  item('Pedido:', 10, 740), item('2610ABCDEF1234', 50, 739),
  item('REMETENTE SOC', 10, 600),
  item('Envio previsto: 15/10/2026', 10, 500),
  item('1. LAPIS-TRANSPARENTE (Adesivo Transparente) *1', 10, 300),
];

test('lines follow reading order and group nearby Y values', () => {
  const lines = linesFromTextItems([item(' ', 0, 900), ...labelItems]);
  assert.equal(lines[0], 'DESTINATÁRIO');
  assert.equal(lines[2], 'Pedido: 2610ABCDEF1234 R');
});

test('label yields order code and shipping date', () => {
  assert.deepEqual(parseShopeeLabel(linesFromTextItems(labelItems).join('\n')), { pedido: '2610ABCDEF1234', envio: '15/10/2026' });
  assert.deepEqual(parseShopeeLabel('Pedido: XYZ123'), { pedido: 'XYZ123', envio: '' });
  assert.equal(parseShopeeLabel('DANFE sem código'), null);
});

test('merge appends new codes without repeating', () => {
  const labels = [{ pedido: 'AAA111' }, { pedido: 'BBB222' }, { pedido: 'AAA111' }];
  assert.deepEqual(mergeLabelCodes('', labels), { codes: 'AAA111\nBBB222', added: ['AAA111', 'BBB222'], duplicates: 1 });
  assert.deepEqual(mergeLabelCodes('BBB222\n', labels), { codes: 'BBB222\nAAA111', added: ['AAA111'], duplicates: 2 });
  assert.equal(mergeLabelCodes('CCC333', [{ pedido: 'CCC333' }]).codes, 'CCC333');
});
