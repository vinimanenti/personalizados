import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEntries, packLabels } from '../src/lib/name-labels.mjs';

test('parses name/role separators, default role and repeat suffix', () => {
  const e = parseEntries('Ana Paula - Madrinha\nJoão; padrinho x2\nMaria Clara\n\n', { defaultRole: 'Dama' });
  assert.deepEqual(e, [
    { name: 'Ana Paula', role: 'MADRINHA' },
    { name: 'João', role: 'PADRINHO' },
    { name: 'João', role: 'PADRINHO' },
    { name: 'Maria Clara', role: 'DAMA' },
  ]);
});

test('keeps hyphenated names intact', () => {
  assert.deepEqual(parseEntries('Ana-Lu - Madrinha'), [{ name: 'Ana-Lu', role: 'MADRINHA' }]);
});

test('packs rows with exact ink gap and wraps at sheet width', () => {
  const box = { minX: -40, maxX: 40, minY: -10, maxY: 8 }; // 80 x 18 mm
  const [sheet] = packLabels([box, box, box, box], { sheetW: 290, margin: 0, gap: 6 });
  const xs = sheet.placed.map(p => p.x + box.minX);
  assert.deepEqual(xs, [0, 86, 172, 0]);              // 3 cabem em 290 (80*3+12=252), o 4º quebra
  assert.equal(sheet.placed[3].y - sheet.placed[0].y, 18 + 6);
  assert.equal(sheet.h, 18 * 2 + 6);
});

test('splits into sheets when max height is set', () => {
  const box = { minX: 0, maxX: 200, minY: -10, maxY: 10 };
  const sheets = packLabels([box, box, box], { sheetW: 290, gap: 6, maxSheetH: 50 });
  assert.equal(sheets.length, 2);
  assert.equal(sheets[0].placed.length, 2);
});
