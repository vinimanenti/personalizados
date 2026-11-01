import test from 'node:test';
import assert from 'node:assert/strict';
import { artKind, svgSizeMM, alphaToStencil, artBoxes } from '../src/lib/art-upload.mjs';
import { packLabels } from '../src/lib/name-labels.mjs';

test('detects file kind by type or extension', () => {
  assert.equal(artKind('logo.PNG'), 'png');
  assert.equal(artKind('foto.jpeg'), 'jpg');
  assert.equal(artKind('x', 'image/svg+xml'), 'svg');
  assert.equal(artKind('arte.pdf'), 'pdf');
  assert.equal(artKind('arte.cdr'), null);
});

test('reads SVG size in mm from units or viewBox', () => {
  assert.deepEqual(svgSizeMM('<svg width="100mm" height="50mm" viewBox="0 0 1000 500">'), { w: 100, h: 50 });
  assert.deepEqual(svgSizeMM('<svg width="10cm" viewBox="0 0 200 100">'), { w: 100, h: 50 });
  const px = svgSizeMM('<svg viewBox="0 0 96 192">');
  assert.deepEqual([px.w, px.h].map(v => +v.toFixed(3)), [25.4, 50.8]);
});

test('alpha becomes a 1-bit stencil (0 = paint), rows padded to bytes', () => {
  // 10 x 1: só os pixels 0 e 9 opacos
  const rgba = new Uint8Array(10 * 4);
  rgba[3] = 255; rgba[9 * 4 + 3] = 200;
  assert.deepEqual([...alphaToStencil(rgba, 10, 1)], [0b01111111, 0b10111111]);
});

test('art copies pack in rows with gap', () => {
  const sheets = packLabels(artBoxes(5, 80, 40), { sheetW: 290, gap: 6, margin: 0 });
  assert.equal(sheets[0].placed.length, 5);
  assert.deepEqual(sheets[0].placed.map(p => [p.x, p.y]), [[0, 40], [86, 40], [172, 40], [0, 86], [86, 86]]);
  assert.equal(sheets[0].h, 86);
});

import { sheetContent, pdfLayers } from '../src/lib/name-labels.mjs';

test('art: colors after CMYK, then mask (stencil or rectangle) in white and varnish', () => {
  const [sheet] = packLabels([...artBoxes(1, 25.4, 25.4, { artId: 'a' }), ...artBoxes(1, 25.4, 25.4, { artId: 'b' })], { sheetW: 290, gap: 6 });
  const artRes = new Map([['a', { color: 'A1', form: null, mask: 'M1' }], ['b', { color: 'F2', form: { w: 36, h: 36 }, mask: null }]]);
  const layers = pdfLayers({ letter: 'white', whiteLayer: true, varnishLayer: true, whiteSpot: 'W', varnishSpot: 'V' });
  const c = sheetContent(sheet, layers, 100, 'GS0', 0, null, artRes);
  const seq = c.match(/\/A1 Do|\/F2 Do|\/M1 Do|re\nf|\/CS\w+ cs/g);
  assert.deepEqual(seq, ['/A1 Do', '/F2 Do', '/CSWhite cs', '/M1 Do', 're\nf', '/CSVarnish cs', '/M1 Do', 're\nf']);
  assert.match(c, /q\n72 0 0 72 0 28 cm\n\/A1 Do/);      // imagem: escala = tamanho em pt
  assert.match(c, /q\n2 0 0 2 89\.008 28 cm\n\/F2 Do/);  // PDF/SVG: escala = tamanho / tamanho da página
  assert.doesNotMatch(c, /^q\n\nQ/m);                     // sem path vazio das artes no texto
});
