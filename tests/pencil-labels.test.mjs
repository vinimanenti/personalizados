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
