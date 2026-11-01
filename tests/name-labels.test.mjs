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

import { pdfLayers, svgPathToPdf, sheetContent } from '../src/lib/name-labels.mjs';

test('layers follow CMYK > Branco > Verniz and white letters skip CMYK', () => {
  const o = { letter: 'black', whiteLayer: true, varnishLayer: true, whiteSpot: 'TOYO 0024pc*', varnishSpot: 'TOYO 0044pc*' };
  assert.deepEqual(pdfLayers(o).map(l => l.key), ['cmyk', 'white', 'varnish']);
  assert.deepEqual(pdfLayers({ ...o, letter: 'white' }).map(l => l.key), ['white', 'varnish']);
});

test('converts svg path (mm, y down) to pdf operators (pt, y up)', () => {
  const ops = svgPathToPdf('M0 0L25.4 0Q25.4 25.4 0 25.4Z', 0, 0, 100);
  assert.equal(ops.split('\n')[0], '0 100 m');
  assert.equal(ops.split('\n')[1], '72 100 l');
  assert.match(ops, /0 28 c\nh\n$/);
});

test('page content draws each layer with overprint state and its color', () => {
  const sheet = { placed: [{ x: 0, y: 0, box: { d: 'M0 0L1 0L1 1Z' } }] };
  const layers = pdfLayers({ letter: 'black', whiteLayer: true, varnishLayer: true, whiteSpot: 'W', varnishSpot: 'V' });
  const c = sheetContent(sheet, layers, 100, 'GS0');
  const fills = c.match(/1 1 1 1 k|\/CS\w+ cs 1 scn/g);
  assert.deepEqual(fills, ['1 1 1 1 k', '/CSWhite cs 1 scn', '/CSVarnish cs 1 scn']);
  assert.equal(c.match(/\/GS0 gs/g).length, 3);
});
