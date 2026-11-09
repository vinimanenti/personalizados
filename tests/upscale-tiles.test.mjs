import test from "node:test";
import assert from "node:assert/strict";
import { planTiles, windowToCHW, pasteCore } from "../src/lib/upscale-tiles.mjs";

test("planTiles cobre a imagem inteira sem sobrepor miolos e com janelas de tamanho fixo", () => {
  const w = 600, h = 300, tiles = planTiles(w, h, 256, 12);
  const hit = new Uint8Array(w * h);
  for (const t of tiles) {
    assert.equal(t.ww, 280); assert.equal(t.wh, 280);
    assert.ok(t.wx <= t.x0 && t.wy <= t.y0 && t.wx + t.ww >= t.x1 && t.wy + t.wh >= t.y1);
    assert.ok(t.wx >= 0 && t.wy >= 0 && t.wx + t.ww <= w && t.wy + t.wh <= h);
    for (let y = t.y0; y < t.y1; y++) for (let x = t.x0; x < t.x1; x++) hit[y * w + x]++;
  }
  assert.ok(hit.every(v => v === 1));
});

test("imagem menor que o bloco vira uma janela só", () => {
  assert.deepEqual(planTiles(100, 50), [{ x0: 0, y0: 0, x1: 100, y1: 50, wx: 0, wy: 0, ww: 100, wh: 50 }]);
});

test("windowToCHW + pasteCore com ampliação 'identidade 2×' reconstrói a imagem", () => {
  const w = 37, h = 23, rgba = new Uint8ClampedArray(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 7) % 256));
  const s = 2, dst = new Uint8ClampedArray(w * s * h * s * 4);
  for (const t of planTiles(w, h, 16, 3)) {
    const chw = windowToCHW(rgba, w, t), n = t.ww * t.wh;
    // amplia por repetição (vizinho mais próximo), como se fosse o modelo
    const up = new Float32Array(3 * n * s * s), ow = t.ww * s;
    for (let c = 0; c < 3; c++) for (let y = 0; y < t.wh * s; y++) for (let x = 0; x < ow; x++) up[c * n * s * s + y * ow + x] = chw[c * n + (y >> 1) * t.ww + (x >> 1)];
    pasteCore(dst, w * s, up, t, s);
  }
  for (let y = 0; y < h * s; y++) for (let x = 0; x < w * s; x++) {
    const a = ((y >> 1) * w + (x >> 1)) * 4, b = (y * w * s + x) * 4;
    assert.deepEqual([dst[b], dst[b + 1], dst[b + 2], dst[b + 3]], [rgba[a], rgba[a + 1], rgba[a + 2], 255]);
  }
});
