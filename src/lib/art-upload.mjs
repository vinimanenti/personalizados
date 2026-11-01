// Artes enviadas pelo operador (PNG, JPG, SVG, PDF): cópias na folha com Branco e Verniz por baixo.
// Aqui ficam as partes sem navegador (testáveis); a leitura dos arquivos está em art-prepare.js.

export const ART_KINDS = { png: "PNG", jpg: "JPG", svg: "SVG", pdf: "PDF" };

export function artKind(name = "", type = "") {
  const ext = name.toLowerCase().split(".").pop();
  if (type === "image/png" || ext === "png") return "png";
  if (type === "image/jpeg" || ext === "jpg" || ext === "jpeg") return "jpg";
  if (type === "image/svg+xml" || ext === "svg") return "svg";
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  return null;
}

const UNIT_MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, "": 25.4 / 96 };

// Tamanho natural de um SVG em mm: width/height com unidade (o Corel exporta em mm) ou o viewBox a 96 dpi.
export function svgSizeMM(svgText) {
  const root = (svgText.match(/<svg\b[^>]*>/i) || [""])[0];
  const attr = n => (root.match(new RegExp(`\\s${n}\\s*=\\s*["']([^"']+)["']`, "i")) || [])[1];
  const len = v => {
    const m = String(v || "").trim().match(/^([\d.]+)\s*(mm|cm|in|pt|pc|px)?$/i);
    return m ? parseFloat(m[1]) * UNIT_MM[(m[2] || "").toLowerCase()] : null;
  };
  const vb = (attr("viewBox") || "").split(/[\s,]+/).map(Number);
  let w = len(attr("width")), h = len(attr("height"));
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    if (w && !h) h = (w * vb[3]) / vb[2];
    if (h && !w) w = (h * vb[2]) / vb[3];
    if (!w && !h) { w = vb[2] * UNIT_MM.px; h = vb[3] * UNIT_MM.px; }
  }
  return w && h ? { w, h } : { w: 50, h: 50 };
}

// Máscara 1 bit (PDF /ImageMask) a partir do canal alfa: 0 = pinta (tem arte), 1 = transparente.
// Linhas completadas até o byte, como o PDF pede.
export function alphaToStencil(rgba, w, h, threshold = 128) {
  const row = Math.ceil(w / 8);
  const bits = new Uint8Array(row * h).fill(0xff);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] >= threshold) bits[y * row + (x >> 3)] &= ~(0x80 >> (x & 7));
    }
  }
  return bits;
}

// Caixas das cópias no formato do packLabels (origem no canto inferior esquerdo da arte).
export function artBoxes(qty, w, h, extra = {}) {
  return Array.from({ length: Math.max(0, qty | 0) }, () => ({ art: true, d: "", emojis: [], w, h, minX: 0, maxX: w, minY: -h, maxY: 0, ...extra }));
}
