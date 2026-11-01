import test from 'node:test';
import assert from 'node:assert/strict';
import { emojiFileName, normalizePath, parseTransform } from '../src/lib/emoji-art.mjs';
import { splitEmoji, sheetContent, pdfLayers } from '../src/lib/name-labels.mjs';

test('twemoji file names drop FE0F except in ZWJ sequences', () => {
  assert.equal(emojiFileName('💖'), '1f496');
  assert.equal(emojiFileName('❤️'), '2764');
  assert.equal(emojiFileName('👨‍👩‍👧'), '1f468-200d-1f469-200d-1f467');
  assert.equal(emojiFileName('👍🏽'), '1f44d-1f3fd');
});

test('splits names into text and emoji runs', () => {
  assert.deepEqual(splitEmoji('Vovó Vera 💖'), [{ text: 'Vovó Vera ', emoji: false }, { text: '💖', emoji: true }]);
});

test('normalizes relative, H/V, S and arc commands to absolute M/L/C/Z', () => {
  const p = normalizePath('M1 2h3v4l-1 1s1 1 2 2a1 1 0 0 1 2 0z');
  assert.deepEqual(p.slice(0, 4), [['M', 1, 2], ['L', 4, 2], ['L', 4, 6], ['L', 3, 7]]);
  assert.deepEqual(p[4], ['C', 3, 7, 4, 8, 5, 9]);
  const arcEnd = p[p.length - 2];
  assert.equal(arcEnd[0], 'C');
  assert.deepEqual(arcEnd.slice(5).map(v => +v.toFixed(6)), [7, 9]);
  assert.deepEqual(p.at(-1), ['Z']);
});

test('implicit lineto after moveto keeps relative mode', () => {
  assert.deepEqual(normalizePath('m1 1 2 0 0 2'), [['M', 1, 1], ['L', 3, 1], ['L', 3, 3]]);
});

test('parses transforms', () => {
  assert.deepEqual(parseTransform('translate(2 3) scale(2)'), [2, 0, 0, 2, 2, 3]);
});

test('emoji keeps its colors after the CMYK layer and is a mask on white/varnish', () => {
  const box = { d: 'M0 0L1 0L1 1Z', emojis: [{ seq: '💖', x: 0, y: -5, s: 5 }] };
  const sheet = { placed: [{ x: 10, y: 10, box }] };
  const art = new Map([['💖', [{ d: 'M0 0L1 0L1 1Z', fill: '#DD2E44' }]]]);
  const layers = pdfLayers({ letter: 'black', whiteLayer: true, varnishLayer: true, whiteSpot: 'W', varnishSpot: 'V' });
  const c = sheetContent(sheet, layers, 100, 'GS0', 0, art);
  assert.deepEqual(c.match(/1 1 1 1 k|[\d.]+ [\d.]+ [\d.]+ rg|\/CS\w+ cs|\/GS0 gs/g),
    ['1 1 1 1 k', '0.867 0.18 0.267 rg', '/GS0 gs', '/CSWhite cs', '/GS0 gs', '/CSVarnish cs']);
  const white = c.split('/CSWhite cs')[1].split('Q\n')[0];
  assert.equal(white.match(/\nf\n|^f\n/g)?.length ?? white.split('f\n').length - 1, 2); // letra + emoji
  // letra branca: sem CMYK, mas o emoji continua colorido antes do branco
  const w = sheetContent(sheet, pdfLayers({ letter: 'white', whiteLayer: true, varnishLayer: false, whiteSpot: 'W' }), 100, 'GS0', 0, art);
  assert.match(w, /^q\n0\.867 0\.18 0\.267 rg/);
});
