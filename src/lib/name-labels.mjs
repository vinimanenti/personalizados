// Etiquetas de nome (ex.: "Ana Paula" em Great Vibes + "MADRINHA" em Times).
// Tudo em milímetros, eixo Y para baixo. O texto vira curvas (paths), então o
// PDF/SVG não depende da fonte instalada e a medida é exatamente a tinta impressa.

export const PT_TO_MM = 25.4 / 72;

export const DEFAULT_OPTS = {
  sheetW: 290,      // largura da folha (mm)
  maxSheetH: 0,     // altura máxima por folha (mm); 0 = rolo contínuo
  margin: 0,        // margem da folha (mm)
  gap: 6,           // espaço entre etiquetas (mm), medido na tinta
  nameSize: 32,     // pt
  roleSize: 11,     // pt
  roleGap: 4,       // linha de base do nome → topo da função (mm)
  roleUpper: true,
  defaultRole: "",
  copies: 1,
};

// "Ana Paula - Madrinha", "Ana Paula; Madrinha", "Ana Paula | Madrinha", tab.
// Sufixo " x3" repete a etiqueta.
export function parseEntries(text, { defaultRole = "", copies = 1, roleUpper = true } = {}) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    let qty = 1;
    const q = line.match(/\s+x\s*(\d+)$/i);
    if (q) { qty = Math.max(1, parseInt(q[1], 10)); line = line.slice(0, q.index).trim(); }
    const parts = line.split(/\s+[-–—]\s+|\s*[;|\t]\s*/);
    const name = parts[0].trim();
    let role = (parts.length > 1 ? parts.slice(1).join(" ") : defaultRole).trim();
    if (roleUpper) role = role.toLocaleUpperCase("pt-BR");
    if (!name) continue;
    for (let i = 0; i < qty * Math.max(1, copies | 0); i++) out.push({ name, role });
  }
  return out;
}

// Converte uma linha de texto em path SVG (mm) centralizado em x = 0, linha de base em y = baseY.
function textShape(font, text, sizePt, baseY) {
  if (!text) return null;
  const run = font.layout(text);
  const k = (sizePt * PT_TO_MM) / font.unitsPerEm;
  let pen = 0;
  const placed = run.glyphs.map((g, i) => {
    const p = run.positions[i];
    const at = { g, x: pen + p.xOffset, y: p.yOffset };
    pen += p.xAdvance;
    return at;
  });
  const shift = -(pen * k) / 2;
  let d = "", minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const { g, x, y } of placed) {
    const b = g.bbox;
    if (!g.path.commands.length || b.minX === Infinity) continue;
    d += g.path.translate(x, y).scale(k, -k).translate(shift, baseY).toSVG();
    minX = Math.min(minX, shift + (x + b.minX) * k);
    maxX = Math.max(maxX, shift + (x + b.maxX) * k);
    minY = Math.min(minY, baseY - (y + b.maxY) * k);
    maxY = Math.max(maxY, baseY - (y + b.minY) * k);
  }
  if (!d) return null;
  return { d, minX, maxX, minY, maxY };
}

// Uma etiqueta: nome com linha de base em y = 0 e função centralizada abaixo.
export function buildLabel(entry, fonts, opts) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const name = textShape(fonts.name, entry.name, o.nameSize, 0);
  const capH = ((fonts.role["OS/2"]?.capHeight || fonts.role.capHeight || fonts.role.unitsPerEm * 0.66) / fonts.role.unitsPerEm) * o.roleSize * PT_TO_MM;
  const role = textShape(fonts.role, entry.role, o.roleSize, o.roleGap + capH);
  const parts = [name, role].filter(Boolean);
  if (!parts.length) return null;
  return {
    entry,
    d: parts.map(p => p.d).join(""),
    minX: Math.min(...parts.map(p => p.minX)),
    maxX: Math.max(...parts.map(p => p.maxX)),
    minY: Math.min(...parts.map(p => p.minY)),
    maxY: Math.max(...parts.map(p => p.maxY)),
  };
}

// Encaixe em prateleiras: da esquerda para a direita, linhas alinhadas pela linha de base
// do nome. `gap` é a distância mínima entre a tinta de duas etiquetas vizinhas.
// Recebe caixas { minX, maxX, minY, maxY } (relativas à origem da etiqueta) e devolve
// folhas com { x, y } = posição da origem de cada etiqueta.
export function packLabels(boxes, opts) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const usable = o.sheetW - 2 * o.margin;
  const rows = [];
  let row = null;
  for (const box of boxes) {
    const w = box.maxX - box.minX;
    if (!row || (row.items.length && row.w + o.gap + w > usable + 1e-6)) {
      row = { items: [], w: 0, up: 0, down: 0 };
      rows.push(row);
    }
    if (row.items.length) row.w += o.gap;
    row.items.push({ box, left: row.w });
    row.w += w;
    row.up = Math.max(row.up, -box.minY);
    row.down = Math.max(row.down, box.maxY);
  }

  const limit = o.maxSheetH > 0 ? o.maxSheetH - 2 * o.margin : Infinity;
  const sheets = [];
  let sheet = null, y = 0;
  for (const r of rows) {
    const h = r.up + r.down;
    if (!sheet || (sheet.placed.length && y + o.gap + h > limit + 1e-6)) {
      sheet = { placed: [], contentH: 0 };
      sheets.push(sheet);
      y = 0;
    } else if (sheet.placed.length) {
      y += o.gap;
    }
    const base = o.margin + y + r.up;
    for (const it of r.items) {
      sheet.placed.push({ box: it.box, x: o.margin + it.left - it.box.minX, y: base });
    }
    y += h;
    sheet.contentH = y;
  }
  for (const s of sheets) {
    s.w = o.sheetW;
    s.h = o.maxSheetH > 0 ? o.maxSheetH : Math.ceil((s.contentH + 2 * o.margin) * 10) / 10;
  }
  return sheets;
}

const fmt = n => +n.toFixed(3);

export function sheetToSvg(sheet) {
  const paths = sheet.placed.map(p => `<path transform="translate(${fmt(p.x)} ${fmt(p.y)})" d="${p.box.d}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.w}mm" height="${sheet.h}mm" viewBox="0 0 ${sheet.w} ${sheet.h}"><g fill="#000">${paths}</g></svg>`;
}
