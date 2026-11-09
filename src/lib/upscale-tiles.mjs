// Divisão em blocos para ampliar imagens grandes com pouca memória de vídeo (sem dependência do navegador).
// Cada bloco é lido com uma sobra (pad) em volta, para não aparecer emenda; só o miolo é aproveitado.
// As janelas têm sempre o mesmo tamanho (encostadas na borda quando preciso), o que evita recompilar na GPU.
export function planTiles(w, h, tile = 256, pad = 12) {
  const winW = Math.min(w, tile + 2 * pad), winH = Math.min(h, tile + 2 * pad);
  const tiles = [];
  for (let y0 = 0; y0 < h; y0 += tile) {
    for (let x0 = 0; x0 < w; x0 += tile) {
      const x1 = Math.min(w, x0 + tile), y1 = Math.min(h, y0 + tile);
      const wx = Math.max(0, Math.min(x0 - pad, w - winW)), wy = Math.max(0, Math.min(y0 - pad, h - winH));
      tiles.push({ x0, y0, x1, y1, wx, wy, ww: winW, wh: winH });
    }
  }
  return tiles;
}

// RGBA (Uint8) → tensor CHW float 0..1 de uma janela.
export function windowToCHW(rgba, w, { wx, wy, ww, wh }) {
  const n = ww * wh, out = new Float32Array(3 * n);
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const i = ((wy + y) * w + wx + x) * 4, p = y * ww + x;
      out[p] = rgba[i] / 255; out[n + p] = rgba[i + 1] / 255; out[2 * n + p] = rgba[i + 2] / 255;
    }
  }
  return out;
}

// Copia o miolo do bloco ampliado (CHW float, escala s) para a imagem final RGBA.
export function pasteCore(dst, dstW, chw, { x0, y0, x1, y1, wx, wy, ww, wh }, s) {
  const ow = ww * s, n = ow * wh * s;
  for (let y = y0 * s; y < y1 * s; y++) {
    const sy = y - wy * s;
    for (let x = x0 * s; x < x1 * s; x++) {
      const p = sy * ow + (x - wx * s), i = (y * dstW + x) * 4;
      // Uint8ClampedArray já arredonda e limita a 0..255.
      dst[i] = chw[p] * 255; dst[i + 1] = chw[n + p] * 255; dst[i + 2] = chw[2 * n + p] * 255; dst[i + 3] = 255;
    }
  }
}
