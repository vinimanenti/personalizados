import test from 'node:test';
import assert from 'node:assert/strict';
import { pencilLines } from '../src/lib/name-labels.mjs';

const measure = t => t.length * 4; // 4 mm por letra

test('short name stays on one line', () => {
  assert.deepEqual(pencilLines('Ana Clara', measure, 50), ['Ana Clara']);
});

test('dash forces the break', () => {
  assert.deepEqual(pencilLines('Ana - Clara', measure, 50), ['Ana', 'Clara']);
  assert.deepEqual(pencilLines('Maria-Eduarda-Silva', measure, 0), ['Maria', 'Eduarda Silva']);
});

test('long name breaks at the most balanced space', () => {
  // "Maria Eduarda Santos" = 80 mm > 50: melhor divisão "Maria Eduarda" / "Santos"
  assert.deepEqual(pencilLines('Maria Eduarda Santos', measure, 50), ['Maria Eduarda', 'Santos']);
  assert.deepEqual(pencilLines('Ana Beatriz de Souza Lima', measure, 50), ['Ana Beatriz', 'de Souza Lima']);
});

test('single long word stays whole (font shrinks later)', () => {
  assert.deepEqual(pencilLines('Maximiliano', measure, 30), ['Maximiliano']);
  assert.deepEqual(pencilLines('   ', measure, 50), []);
});

import { rotateBox, mapPath, packLabels } from '../src/lib/name-labels.mjs';

test('mapPath transforms every point of M/L/Q/C/Z paths', () => {
  assert.equal(mapPath('M1 2L3 4Q5 6 7 8C1 1 2 2 3 3Z', (x, y) => [y, -x]), 'M2 -1L4 -3Q6 -5 8 -7C1 -1 2 -2 3 -3Z');
});

test('rotateBox turns the label upright (90° counter-clockwise) with its emojis', () => {
  const box = { d: 'M0 0L40 0', minX: -20, maxX: 20, minY: -8, maxY: 3, emojis: [{ seq: '💖', x: 2, y: -5, s: 4 }] };
  const r = rotateBox(box);
  assert.deepEqual([r.minX, r.maxX, r.minY, r.maxY], [-8, 3, -20, 20]);
  assert.equal(r.d, 'M0 0L0 -40');
  // um ponto do emoji (u=0.25, v=0.5) estava em (3, -3); girado deve cair em (-3, -3)
  const e = r.emojis[0];
  const [u, v] = [0.5, 0.75]; // (v, 1 - u) do ponto original
  assert.deepEqual([e.x + u * e.s, e.y + v * e.s], [-3, -3]);
});

test('upright labels pack many more per row', () => {
  const flat = { d: '', minX: -22, maxX: 22, minY: -8, maxY: 2 };       // 44 x 10 mm
  const up = rotateBox(flat);                                             // 10 x 44 mm
  const [a] = packLabels(Array(18).fill(up), { sheetW: 290, gap: 6 });
  assert.equal(a.placed.filter(p => p.y === a.placed[0].y).length, 18);
});
