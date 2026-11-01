// Emojis coloridos em vetor (Twemoji, CC-BY 4.0 — https://github.com/jdecked/twemoji).
// Cada emoji vira uma lista de formas { d, fill } com path absoluto (M/L/C/Z) num quadrado 0–1,
// pronta para o PDF (cores) e para as máscaras de Branco/Verniz (silhueta = as mesmas formas).

export const TWEMOJI_BASE = "https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg/";

// Nome do arquivo do Twemoji: códigos em hex separados por "-"; o FE0F sai quando não há ZWJ.
export function emojiFileName(seq) {
  let cps = [...seq].map(c => c.codePointAt(0));
  if (!cps.includes(0x200d)) cps = cps.filter(c => c !== 0xfe0f);
  return cps.map(c => c.toString(16)).join("-");
}

/* ─── Path SVG → só M/L/C/Z absolutos ─── */
const ARGS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

function tokenize(d) {
  const out = [];
  const re = /([MLHVCSQTAZmlhvcsqtaz])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/g;
  let m;
  while ((m = re.exec(d))) out.push(m[1] || parseFloat(m[2]));
  return out;
}

// Arco elíptico → curvas cúbicas (SVG 1.1, apêndice F.6).
function arcToCubics(x1, y1, rx, ry, phi, fa, fs, x2, y2) {
  if (!rx || !ry) return [[x1, y1, x2, y2, x2, y2]];
  rx = Math.abs(rx); ry = Math.abs(ry);
  const r = (phi * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy, yp = -sin * dx + cos * dy;
  const lam = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const co = (fa === fs ? -1 : 1) * Math.sqrt(Math.max(0, num / (rx * rx * yp * yp + ry * ry * xp * xp)));
  const cxp = (co * rx * yp) / ry, cyp = (-co * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let dt = ang((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!fs && dt > 0) dt -= 2 * Math.PI;
  if (fs && dt < 0) dt += 2 * Math.PI;
  const n = Math.ceil(Math.abs(dt) / (Math.PI / 2));
  const seg = dt / n, k = (4 / 3) * Math.tan(seg / 4);
  const pt = t => [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos];
  const dpt = t => [-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos];
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = t1 + i * seg, b = a + seg;
    const [ax, ay] = pt(a), [bx, by] = pt(b), [dax, day] = dpt(a), [dbx, dby] = dpt(b);
    out.push([ax + k * dax, ay + k * day, bx - k * dbx, by - k * dby, bx, by]);
  }
  return out;
}

export function normalizePath(d) {
  const t = tokenize(d);
  const out = [];
  let i = 0, cmd = null, x = 0, y = 0, sx = 0, sy = 0, lc = null, lq = null;
  while (i < t.length) {
    if (typeof t[i] === "string") cmd = t[i++];
    else if (!cmd) break;
    const C = cmd.toUpperCase(), rel = cmd !== C, n = ARGS[C];
    const a = t.slice(i, i + n); i += n;
    if (a.length < n || a.some(v => typeof v !== "number")) break;
    const ox = rel ? x : 0, oy = rel ? y : 0;
    let nlc = null, nlq = null;
    if (C === "M") { x = a[0] + ox; y = a[1] + oy; sx = x; sy = y; out.push(["M", x, y]); cmd = rel ? "l" : "L"; }
    else if (C === "L") { x = a[0] + ox; y = a[1] + oy; out.push(["L", x, y]); }
    else if (C === "H") { x = a[0] + (rel ? x : 0); out.push(["L", x, y]); }
    else if (C === "V") { y = a[0] + (rel ? y : 0); out.push(["L", x, y]); }
    else if (C === "C" || C === "S") {
      const [c1x, c1y] = C === "C" ? [a[0] + ox, a[1] + oy] : lc ? [2 * x - lc[0], 2 * y - lc[1]] : [x, y];
      const r = C === "C" ? a.slice(2) : a;
      const c2x = r[0] + ox, c2y = r[1] + oy, ex = r[2] + ox, ey = r[3] + oy;
      out.push(["C", c1x, c1y, c2x, c2y, ex, ey]); nlc = [c2x, c2y]; x = ex; y = ey;
    } else if (C === "Q" || C === "T") {
      const [qx, qy] = C === "Q" ? [a[0] + ox, a[1] + oy] : lq ? [2 * x - lq[0], 2 * y - lq[1]] : [x, y];
      const r = C === "Q" ? a.slice(2) : a;
      const ex = r[0] + ox, ey = r[1] + oy;
      out.push(["C", x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey]);
      nlq = [qx, qy]; x = ex; y = ey;
    } else if (C === "A") {
      const ex = a[5] + ox, ey = a[6] + oy;
      for (const c of arcToCubics(x, y, a[0], a[1], a[2], a[3] ? 1 : 0, a[4] ? 1 : 0, ex, ey)) out.push(["C", ...c]);
      x = ex; y = ey;
    } else if (C === "Z") { out.push(["Z"]); x = sx; y = sy; }
    lc = nlc; lq = nlq;
  }
  return out;
}

/* ─── Transformações e formas básicas ─── */
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
export function parseTransform(str) {
  let m = [1, 0, 0, 1, 0, 0];
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let r;
  while ((r = re.exec(str || ""))) {
    const v = r[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let n;
    if (r[1] === "matrix") n = v;
    else if (r[1] === "translate") n = [1, 0, 0, 1, v[0], v[1] || 0];
    else if (r[1] === "scale") n = [v[0], 0, 0, v[1] ?? v[0], 0, 0];
    else if (r[1] === "rotate") {
      const a = (v[0] * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      n = [c, s, -s, c, 0, 0];
      if (v.length > 2) n = mul(mul([1, 0, 0, 1, v[1], v[2]], n), [1, 0, 0, 1, -v[1], -v[2]]);
    } else if (r[1] === "skewX") n = [1, 0, Math.tan((v[0] * Math.PI) / 180), 1, 0, 0];
    else n = [1, Math.tan((v[0] * Math.PI) / 180), 0, 1, 0, 0];
    m = mul(m, n);
  }
  return m;
}

const K = 0.5522847498;
const ellipsePath = (cx, cy, rx, ry) =>
  `M${cx + rx} ${cy}C${cx + rx} ${cy + K * ry} ${cx + K * rx} ${cy + ry} ${cx} ${cy + ry}C${cx - K * rx} ${cy + ry} ${cx - rx} ${cy + K * ry} ${cx - rx} ${cy}` +
  `C${cx - rx} ${cy - K * ry} ${cx - K * rx} ${cy - ry} ${cx} ${cy - ry}C${cx + K * rx} ${cy - ry} ${cx + rx} ${cy - K * ry} ${cx + rx} ${cy}Z`;

function elementPath(el) {
  const n = k => parseFloat(el.getAttribute(k) || 0);
  switch (el.tagName.toLowerCase()) {
    case "path": return el.getAttribute("d") || "";
    case "circle": return ellipsePath(n("cx"), n("cy"), n("r"), n("r"));
    case "ellipse": return ellipsePath(n("cx"), n("cy"), n("rx"), n("ry"));
    case "rect": { const x = n("x"), y = n("y"), w = n("width"), h = n("height"); return `M${x} ${y}H${x + w}V${y + h}H${x}Z`; }
    case "polygon": case "polyline": {
      const p = (el.getAttribute("points") || "").trim().split(/[\s,]+/).map(Number);
      return p.length >= 4 ? `M${p[0]} ${p[1]}` + p.slice(2).reduce((s, v, i) => s + (i % 2 ? ` ${v}` : `L${v}`), "") + (el.tagName === "polygon" ? "Z" : "") : "";
    }
    default: return "";
  }
}

const fmt = v => +v.toFixed(4);
function toD(cmds, m, scale) {
  const P = (x, y) => `${fmt((m[0] * x + m[2] * y + m[4]) * scale)} ${fmt((m[1] * x + m[3] * y + m[5]) * scale)}`;
  return cmds.map(c => c[0] === "Z" ? "Z" : c[0] === "C" ? `C${P(c[1], c[2])} ${P(c[3], c[4])} ${P(c[5], c[6])}` : `${c[0]}${P(c[1], c[2])}`).join("");
}

// SVG do Twemoji → [{ d, fill }] com coordenadas 0–1 (o quadrado do viewBox).
export function parseEmojiSvg(svgText, DOMParserImpl = globalThis.DOMParser) {
  const doc = new DOMParserImpl().parseFromString(svgText, "image/svg+xml");
  const svg = doc.documentElement;
  const vb = (svg.getAttribute("viewBox") || "0 0 36 36").split(/[\s,]+/).map(Number);
  const scale = 1 / (vb[2] || 36);
  const shapes = [];
  const walk = (el, m, fill) => {
    if (el.nodeType !== 1) return;
    const tag = el.tagName.toLowerCase();
    if (["defs", "clippath", "mask", "title", "desc", "style"].includes(tag)) return;
    const mm = mul(m, parseTransform(el.getAttribute("transform")));
    const f = el.getAttribute("fill") ?? fill;
    const d = elementPath(el);
    if (d && f && f !== "none") shapes.push({ d: toD(normalizePath(d), mul([1, 0, 0, 1, -vb[0], -vb[1]], mm), scale), fill: f });
    for (const c of el.childNodes) walk(c, mm, f);
  };
  walk(svg, [1, 0, 0, 1, 0, 0], "#000");
  return shapes;
}

const NAMED = { white: "fff", black: "000", red: "f00", none: "000" };
export const hexToRgb = hex => {
  let h = NAMED[hex.toLowerCase()] ?? hex.replace("#", "");
  if (h.length === 3) h = h.replace(/./g, c => c + c);
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
};

const cache = new Map();
export function loadEmojiArt(seq) {
  if (!cache.has(seq)) {
    cache.set(seq, (async () => {
      const name = emojiFileName(seq);
      for (const f of [name, name.replace(/-fe0f/g, "")]) {
        const r = await fetch(`${TWEMOJI_BASE}${f}.svg`);
        if (r.ok) return parseEmojiSvg(await r.text());
      }
      return null; // emoji sem desenho no Twemoji
    })().catch(() => { cache.delete(seq); return null; }));
  }
  return cache.get(seq);
}
