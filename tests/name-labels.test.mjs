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

test('page content draws each layer with its color; only spot layers overprint', () => {
  const sheet = { placed: [{ x: 0, y: 0, box: { d: 'M0 0L1 0L1 1Z' } }] };
  const layers = pdfLayers({ letter: 'black', whiteLayer: true, varnishLayer: true, whiteSpot: 'W', varnishSpot: 'V' });
  const c = sheetContent(sheet, layers, 100, 'GS0');
  const fills = c.match(/1 1 1 1 k|\/CS\w+ cs 1 scn/g);
  assert.deepEqual(fills, ['1 1 1 1 k', '/CSWhite cs 1 scn', '/CSVarnish cs 1 scn']);
  assert.deepEqual(c.match(/\/GS0 gs|1 1 1 1 k|\/CS\w+ cs/g), ['1 1 1 1 k', '/GS0 gs', '/CSWhite cs', '/GS0 gs', '/CSVarnish cs']);
});

test('order code sits top-left of every sheet and pushes labels down by gap', () => {
  const box = { d: 'M0 0Z', minX: 0, maxX: 200, minY: -10, maxY: 10 };
  const code = { d: 'M0 0Z', minX: 0.2, maxX: 20, minY: -3, maxY: 0.5 };
  const sheets = packLabels([box, box, box], { sheetW: 290, gap: 6, maxSheetH: 60, margin: 0 }, code);
  assert.equal(sheets.length, 2);
  for (const s of sheets) {
    assert.deepEqual([s.code.x + code.minX, s.code.y + code.minY], [0, 0]);
    assert.equal(s.placed[0].y + box.minY, 3.5 + 6); // altura do código + espaço
  }
  // código em CMYK (sem gs, mesmo com letra branca) e também no Branco, mas não no Verniz
  const layers = [{ key: 'white', cs: 'CSWhite', spot: 'W' }, { key: 'varnish', cs: 'CSVarnish', spot: 'V' }];
  const c = sheetContent(sheets[0], layers, 100, 'GS0');
  assert.match(c, /^q\n1 1 1 1 k\n[^Q]*f\nQ\nq\n\/GS0 gs\n\/CSWhite/);
  const fills = name => c.split(`/${name} cs 1 scn\n`)[1].split('Q\n')[0].split('f\n').length - 1;
  assert.equal(fills('CSWhite'), sheets[0].placed.length + 1);
  assert.equal(fills('CSVarnish'), sheets[0].placed.length);
});

import { stackSheets, letterCmyk } from '../src/lib/name-labels.mjs';

test('custom letter color goes into the CMYK layer', () => {
  const o = { letter: 'color', cmyk: [0, 100, 100, 0], whiteLayer: true, varnishLayer: false, whiteSpot: 'W' };
  assert.deepEqual(letterCmyk(o), [0, 1, 1, 0]);
  const layers = pdfLayers(o);
  assert.equal(layers[0].label, 'CMYK 0/100/100/0');
  const c = sheetContent({ placed: [{ x: 0, y: 0, box: { d: 'M0 0Z' } }] }, layers, 100, 'GS0');
  assert.match(c, /^q\n0 1 1 0 k\n/);
});

test('stacks sheets of several orders one below the other', () => {
  const s = h => ({ w: 290, h, placed: [] });
  const pages = stackSheets([s(40), s(30), s(50)], { gap: 6, maxPageH: 100 });
  assert.deepEqual(pages.map(p => p.items.map(i => i.oy)), [[0, 46], [0]]);
  assert.deepEqual(pages.map(p => p.h), [76, 50]);
});

test('3-line mode: "Cima - Nome - Baixo", defaults fill the missing lines', () => {
  const o = { lines: 3, defaultTop: 'Casamento', defaultRole: 'Madrinha' };
  assert.deepEqual(parseEntries('Padrinhos - Ana Paula - 12.11.2026\nJoão - Pajem\nMaria', o), [
    { top: 'PADRINHOS', name: 'Ana Paula', role: '12.11.2026' },
    { top: 'CASAMENTO', name: 'João', role: 'PAJEM' },
    { top: 'CASAMENTO', name: 'Maria', role: 'MADRINHA' },
  ]);
  // com 2 linhas nada muda: a primeira parte é o nome
  assert.deepEqual(parseEntries('Ana - Madrinha - x'), [{ name: 'Ana', role: 'MADRINHA X' }]);
});
