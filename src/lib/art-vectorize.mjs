// Vetorização de PNG/JPG: partes sem navegador (testáveis). O traçado com Potrace está em art-prepare.js.
// Fluxo: remove o fundo → reduz a paleta → limpa ruído do JPG → gera uma máscara por cor → monta o SVG.

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const hex = c => "#" + c.map(v => Math.round(v).toString(16).padStart(2, "0")).join("");

// Cor mais comum na borda da imagem (agrupada de 16 em 16 por canal para resistir ao ruído do JPG).
function borderColor(rgba, w, h) {
  const seen = new Map();
  const add = i => {
    if (rgba[i + 3] < 128) return;
    const key = (rgba[i] >> 4) << 8 | (rgba[i + 1] >> 4) << 4 | rgba[i + 2] >> 4;
    const e = seen.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += rgba[i]; e.g += rgba[i + 1]; e.b += rgba[i + 2];
    seen.set(key, e);
  };
  for (let x = 0; x < w; x++) { add(x * 4); add(((h - 1) * w + x) * 4); }
  for (let y = 0; y < h; y++) { add(y * w * 4); add((y * w + w - 1) * 4); }
  let best = null;
  for (const e of seen.values()) if (!best || e.n > best.n) best = e;
  return best ? [best.r / best.n, best.g / best.n, best.b / best.n] : null;
}

// Apaga (alfa 0) só o fundo ligado à borda: o branco de dentro de letras e desenhos fica.
export function removeBackground(rgba, w, h, tolerance = 40) {
  const bg = borderColor(rgba, w, h);
  if (!bg) return rgba;
  const limit = tolerance ** 2;
  const out = new Uint8ClampedArray(rgba);
  const seen = new Uint8Array(w * h);
  const stack = [];
  const push = p => {
    if (seen[p]) return;
    seen[p] = 1;
    const i = p * 4;
    if (out[i + 3] < 128 || dist2([out[i], out[i + 1], out[i + 2]], bg) <= limit) stack.push(p);
  };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const p = stack.pop();
    out[p * 4 + 3] = 0;
    const x = p % w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (p >= w) push(p - w);
    if (p < w * (h - 1)) push(p + w);
  }
  return out;
}

// Paleta real da imagem (corte pela mediana + ajuste k-means), sem deslocar branco e preto.
export function buildPalette(rgba, colors) {
  const step = Math.max(1, Math.floor(rgba.length / 4 / 60000));
  const px = [];
  for (let i = 0; i < rgba.length; i += 4 * step) if (rgba[i + 3] >= 128) px.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
  if (!px.length) return [];
  const boxes = [px];
  while (boxes.length < colors) {
    let bi = -1, ch = 0, spread = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 255, hi = 0;
        for (const p of b) { if (p[c] < lo) lo = p[c]; if (p[c] > hi) hi = p[c]; }
        // Pesa o tamanho do grupo: áreas grandes dividem antes de pixels raros de ruído.
        const s = (hi - lo) * Math.sqrt(b.length);
        if (s > spread) { spread = s; bi = i; ch = c; }
      }
    });
    if (bi < 0) break;
    const sorted = boxes[bi].sort((a, b) => a[ch] - b[ch]);
    const mid = sorted.length >> 1;
    boxes.splice(bi, 1, sorted.slice(0, mid), sorted.slice(mid));
  }
  const mean = b => [0, 1, 2].map(c => b.reduce((s, p) => s + p[c], 0) / b.length);
  let pal = boxes.filter(b => b.length).map(mean);
  for (let round = 0; round < 6; round++) {
    const sum = pal.map(() => [0, 0, 0, 0]);
    for (const p of px) {
      let bi = 0, bd = Infinity;
      pal.forEach((c, i) => { const d = dist2(p, c); if (d < bd) { bd = d; bi = i; } });
      const s = sum[bi]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++;
    }
    pal = sum.filter(s => s[3]).map(s => [s[0] / s[3], s[1] / s[3], s[2] / s[3]]);
  }
  // Tons quase iguais viram um só.
  const merged = [];
  for (const c of pal) if (!merged.some(m => dist2(m, c) < 24 ** 2)) merged.push(c);
  // Branco e preto quase puros voltam a ser puros: o JPG costuma sujá-los.
  return merged.map(c => (dist2(c, [255, 255, 255]) < 22 ** 2 ? [255, 255, 255] : dist2(c, [0, 0, 0]) < 22 ** 2 ? [0, 0, 0] : c));
}

// Rótulo de cada pixel: índice da paleta ou 255 (transparente).
export function labelPixels(rgba, w, h, palette) {
  const labels = new Uint8Array(w * h);
  const cache = new Map();
  for (let p = 0, i = 0; p < labels.length; p++, i += 4) {
    if (rgba[i + 3] < 128) { labels[p] = 255; continue; }
    const key = rgba[i] << 16 | rgba[i + 1] << 8 | rgba[i + 2];
    let l = cache.get(key);
    if (l === undefined) {
      let bd = Infinity;
      const q = [rgba[i], rgba[i + 1], rgba[i + 2]];
      palette.forEach((c, k) => { const d = dist2(q, c); if (d < bd) { bd = d; l = k; } });
      cache.set(key, l);
    }
    labels[p] = l;
  }
  return labels;
}

// Filtro de maioria 3×3: tira o chiado do JPG e os halos de tons intermediários nas bordas.
export function smoothLabels(labels, w, h, passes = 2) {
  let cur = labels;
  for (let n = 0; n < passes; n++) {
    const next = cur.slice();
    const count = new Map();
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        count.clear();
        for (let dy = -w; dy <= w; dy += w) for (let dx = -1; dx <= 1; dx++) {
          const v = cur[p + dy + dx];
          count.set(v, (count.get(v) || 0) + 1);
        }
        let best = cur[p], bn = count.get(best);
        for (const [v, c] of count) if (c > bn) { best = v; bn = c; }
        next[p] = best;
      }
    }
    cur = next;
  }
  return cur;
}

// Camadas empilhadas da maior área para a menor; cada máscara inclui as camadas de cima,
// assim não sobra fresta entre cores vizinhas no corte nem na impressão.
export function stackLayers(labels, palette) {
  const area = palette.map(() => 0);
  for (const l of labels) if (l !== 255) area[l]++;
  const order = palette.map((_, i) => i).filter(i => area[i] > 0).sort((a, b) => area[b] - area[a]);
  return order.map((_, k) => ({ color: hex(palette[order[k]]), include: new Set(order.slice(k)) }));
}

// Pintura preta sobre branco, a entrada que o Potrace traça.
export function layerMask(labels, include) {
  const out = new Uint8ClampedArray(labels.length * 4);
  for (let p = 0, i = 0; p < labels.length; p++, i += 4) {
    const v = include.has(labels[p]) ? 0 : 255;
    out[i] = out[i + 1] = out[i + 2] = v;
    out[i + 3] = 255;
  }
  return out;
}

// SVG com a medida física (mm). O Potrace devolve os caminhos em décimos de pixel, com Y invertido.
export function buildSvg(layers, pxW, pxH, wMM, hMM) {
  const body = layers.filter(l => l.d).map(l => `<path fill="${l.color}" fill-rule="evenodd" d="${l.d}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${+wMM.toFixed(3)}mm" height="${+hMM.toFixed(3)}mm" viewBox="0 0 ${pxW} ${pxH}"><g transform="translate(0 ${pxH}) scale(0.1 -0.1)">${body}</g></svg>`;
}

// ── Modo 1 cor ──
const luma = (rgba, i) => 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];

// Limite automático (Otsu) entre claro e escuro, contando só pixels visíveis.
export function otsuThreshold(rgba) {
  const hist = new Array(256).fill(0);
  let total = 0;
  for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 3] >= 128) { hist[Math.round(luma(rgba, i))]++; total++; }
  if (!total) return 128;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 128, bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const diff = sumB / wB - (sum - sumB) / wF;
    const v = wB * wF * diff * diff;
    if (v > bestVar) { bestVar = v; best = t; }
  }
  return best + 0.5; // entre as duas classes, assim o escuro fica dentro do limite
}

// Rótulo 0 para o que é mais escuro que o limite; 255 para claro ou transparente.
export function monoLabels(rgba, w, h, threshold) {
  const labels = new Uint8Array(w * h);
  for (let p = 0, i = 0; p < labels.length; p++, i += 4) labels[p] = rgba[i + 3] >= 128 && luma(rgba, i) < threshold ? 0 : 255;
  return labels;
}

// ── PDF com máscara (mesmo padrão das etiquetas Lápis) ──
// Camadas na ordem do RIP: cores da arte > Branco > Verniz. Branco e Verniz são cores spot
// (Separation) que o RIP reconhece pelo nome; `alt` é só a cor de visualização.
export const MASK_DEFAULTS = { white: true, varnish: true, whiteSpot: "TOYO 0024pc*", varnishSpot: "TOYO 0044pc*", overprint: true };
const SPOT_ALT = { white: [0, 0, 0, 0.15], varnish: [0, 0, 0.3, 0] };

export function maskLayers(mask) {
  const out = [];
  if (mask?.white && mask.whiteSpot?.trim()) out.push({ key: "white", spot: mask.whiteSpot.trim(), alt: SPOT_ALT.white });
  if (mask?.varnish && mask.varnishSpot?.trim()) out.push({ key: "varnish", spot: mask.varnishSpot.trim(), alt: SPOT_ALT.varnish });
  return out;
}

const num = v => (Math.round(v * 100) / 100).toString();

// Caminho do Potrace (M/m, L/l, C/c, Z/z, com repetição implícita) → operadores de caminho do PDF.
export function pathToPdf(d) {
  const t = String(d).match(/[MmLlCcZz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) || [];
  const out = [];
  let i = 0, cmd = null, x = 0, y = 0, sx = 0, sy = 0;
  const n = () => parseFloat(t[i++]);
  while (i < t.length) {
    if (/[A-Za-z]/.test(t[i])) cmd = t[i++];
    const rel = cmd === cmd?.toLowerCase();
    switch (cmd?.toUpperCase()) {
      case "M": {
        const nx = n(), ny = n();
        x = rel ? x + nx : nx; y = rel ? y + ny : ny; sx = x; sy = y;
        out.push(`${num(x)} ${num(y)} m`);
        cmd = rel ? "l" : "L"; // pares seguintes são linhas
        break;
      }
      case "L": {
        const nx = n(), ny = n();
        x = rel ? x + nx : nx; y = rel ? y + ny : ny;
        out.push(`${num(x)} ${num(y)} l`);
        break;
      }
      case "C": {
        const v = [n(), n(), n(), n(), n(), n()];
        const p = rel ? v.map((a, k) => a + (k % 2 ? y : x)) : v;
        out.push(`${p.map(num).join(" ")} c`);
        x = p[4]; y = p[5];
        break;
      }
      case "Z":
        out.push("h");
        x = sx; y = sy; cmd = null;
        break;
      default:
        i++; // número solto sem comando: ignora
    }
  }
  return out.join("\n");
}

// Nome PDF: escapa espaço e caracteres especiais como #xx ("TOYO 0024pc*" → /TOYO#200024pc*).
const pdfName = s => "/" + [...new TextEncoder().encode(s)].map(b => (b > 0x20 && b < 0x7f && !"()<>[]{}/%#".includes(String.fromCharCode(b)) ? String.fromCharCode(b) : "#" + b.toString(16).padStart(2, "0"))).join("");
const hexRgb = h => [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16) / 255);

// Lê o cabeçalho de um JPG: largura, altura e número de canais (1 cinza, 3 RGB, 4 CMYK).
export function jpegInfo(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const m = bytes[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8], components: bytes[i + 9] };
    }
    i += 2 + len;
  }
  return null;
}

// layers: [{ color: "#rrggbb", d }] do traçado (a primeira é a silhueta inteira, ver stackLayers);
// px: [w, h] do traçado; wMM × hMM: tamanho da página.
// withColor: desenha as cores vetorizadas. image: imagem original por baixo (modo "só máscara"):
//   { w, h, filter: "DCTDecode" | "FlateDecode", colorSpace, decode?, data, smask? (alfa, Flate) }.
// Devolve os bytes do PDF.
export function buildLayeredPdf(layers, px, wMM, hMM, { withColor = true, mask = null, image = null } = {}) {
  const PT = 72 / 25.4, wPt = wMM * PT, hPt = hMM * PT;
  const spots = maskLayers(mask);
  const shapes = layers.filter(l => l.d);
  const silhouette = shapes[0] ? pathToPdf(shapes[0].d) : "";
  const scale = v => +v.toPrecision(8); // fator pequeno: precisa de mais casas que as coordenadas
  let content = image ? `q\n${scale(wPt)} 0 0 ${scale(hPt)} 0 0 cm\n/Im1 Do\nQ\n` : "";
  // O Potrace usa décimos de pixel com Y para cima, igual ao PDF: só falta a escala.
  content += `q\n${scale(wPt / (px[0] * 10))} 0 0 ${scale(hPt / (px[1] * 10))} 0 0 cm\n`;
  if (withColor) for (const l of shapes) content += `${hexRgb(l.color).map(num).join(" ")} rg\n${pathToPdf(l.d)}\nf*\n`;
  spots.forEach((s, k) => {
    content += `q\n${mask.overprint ? "/GSOver gs\n" : ""}/CS${k + 1} cs 1 scn\n${silhouette}\nf*\nQ\n`;
  });
  content += "Q\n";
  // Objetos: 1 catálogo, 2 páginas, 3 página, 4 conteúdo, 5 ExtGState, depois spots e imagem.
  const objs = [];
  const add = parts => { objs.push(parts); return objs.length; };
  const stream = (dict, data) => [`<< ${dict} /Length ${data.length} >>\nstream\n`, data, "\nendstream"];
  add(["<< /Type /Catalog /Pages 2 0 R >>"]);
  add(["<< /Type /Pages /Kids [3 0 R] /Count 1 >>"]);
  const page = add(null);
  add(stream("", content));
  add(["<< /Type /ExtGState /op true /OP true /OPM 1 >>"]);
  const csRefs = spots.map(s => add([`[/Separation ${pdfName(s.spot)} /DeviceCMYK << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [${s.alt.join(" ")}] /N 1 >>]`]));
  let imRef = 0;
  if (image) {
    const sm = image.smask ? add(stream(`/Type /XObject /Subtype /Image /Width ${image.w} /Height ${image.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, image.smask)) : 0;
    imRef = add(stream(`/Type /XObject /Subtype /Image /Width ${image.w} /Height ${image.h} /ColorSpace /${image.colorSpace} /BitsPerComponent 8 /Filter /${image.filter}${image.decode ? ` /Decode [${image.decode.join(" ")}]` : ""}${sm ? ` /SMask ${sm} 0 R` : ""}`, image.data));
  }
  const csDict = csRefs.length ? `/ColorSpace << ${csRefs.map((r, k) => `/CS${k + 1} ${r} 0 R`).join(" ")} >> ` : "";
  const xo = imRef ? `/XObject << /Im1 ${imRef} 0 R >> ` : "";
  objs[page - 1] = [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(wPt)} ${num(hPt)}] /Resources << ${csDict}${xo}/ExtGState << /GSOver 5 0 R >> >> /Contents 4 0 R >>`];
  // Monta em bytes: a imagem é binária, então a posição de cada objeto é contada em bytes.
  const enc = new TextEncoder(), chunks = [];
  let size = 0;
  const put = x => { const b = typeof x === "string" ? enc.encode(x) : x; chunks.push(b); size += b.length; };
  put("%PDF-1.4\n");
  const offsets = objs.map((parts, k) => { const at = size; put(`${k + 1} 0 obj\n`); parts.forEach(put); put("\nendobj\n"); return at; });
  const xref = size;
  put(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`);
  put(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
