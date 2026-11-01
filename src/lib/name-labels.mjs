// Etiquetas de nome (ex.: "Ana Paula" em Great Vibes + "MADRINHA" em Times).
// Tudo em milímetros, eixo Y para baixo. O texto vira curvas (paths), então o
// PDF/SVG não depende da fonte instalada e a medida é exatamente a tinta impressa.

import { hexToRgb } from "./emoji-art.mjs";

export const PT_TO_MM = 25.4 / 72;

export const DEFAULT_OPTS = {
  sheetW: 290,      // largura da folha (mm)
  maxSheetH: 0,     // altura máxima por folha (mm); 0 = rolo contínuo
  margin: 0,        // margem da folha (mm)
  gap: 6,           // espaço entre etiquetas (mm), medido na tinta
  nameFont: "greatvibes", // fonte do nome (ver NAME_FONTS em NameLabels.jsx)
  nameSize: 32,     // pt
  roleSize: 11,     // pt
  roleGap: 4,       // linha de base do nome → topo da função (mm)
  roleClear: 1,     // folga mínima entre a perna das letras (J, g, p…) e a função (mm)
  roleUpper: true,
  overprint: true,  // "Impressão sobreposta do preenchimento" no PDF
  letter: "black",  // "black" = CMYK 100/100/100/100 + Branco + Verniz; "white" = Branco + Verniz; "color" = CMYK `cmyk` + Branco + Verniz
  cmyk: [0, 100, 100, 0], // cor da letra quando letter = "color" (C, M, Y, K em %)
  whiteLayer: true,
  varnishLayer: true,
  whiteSpot: "TOYO 0024pc*",
  varnishSpot: "TOYO 0044pc*",
  defaultRole: "",
  lines: 2,         // 2 = nome / função; 3 = linha de cima (Times) / nome / linha de baixo (Times)
  defaultTop: "",   // linha de cima quando a linha da lista não traz uma
  topSize: 11,      // pt (Times)
  topGap: 3,        // linha de base da linha de cima → topo das letras do nome logo abaixo (mm)
  copies: 1,
  orderCode: "",    // código do pedido, no canto superior esquerdo de cada folha
  codeSize: 10,     // pt (Times)
  emojiScale: 0.6,  // tamanho do emoji em relação ao texto
};

// Separadores entre as partes de uma linha: " - ", ";", "|" ou tab.
export const PART_SEP = /\s+[-–—]\s+|\s*[;|\t]\s*/;

// Qual parte da linha é o nome: com 3 linhas e 3 partes ("Cima - Nome - Baixo") é a do meio.
export const nameIndex = (parts, lines) => (lines === 3 && parts.length >= 3 ? 1 : 0);

// 2 linhas: "Ana Paula - Madrinha", "Ana Paula; Madrinha", "Ana Paula | Madrinha", tab.
// 3 linhas: "Cima - Nome - Baixo"; com 2 partes é "Nome - Baixo" e com 1 só o nome (o resto vem
// dos padrões). Sufixo " x3" repete a etiqueta.
export function parseEntries(text, { defaultRole = "", defaultTop = "", lines = 2, copies = 1, roleUpper = true } = {}) {
  const out = [];
  const up = s => (roleUpper ? s.toLocaleUpperCase("pt-BR") : s);
  for (const raw of String(text || "").split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    let qty = 1;
    const q = line.match(/\s+x\s*(\d+)$/i);
    if (q) { qty = Math.max(1, parseInt(q[1], 10)); line = line.slice(0, q.index).trim(); }
    const parts = line.split(PART_SEP).map(s => s.trim());
    const ni = nameIndex(parts, lines);
    const name = parts[ni];
    if (!name) continue;
    const rest = parts.slice(ni + 1).join(" ");
    const entry = { name, role: up(rest || defaultRole.trim()) };
    if (lines === 3) entry.top = up(ni ? parts[0] : defaultTop.trim());
    for (let i = 0; i < qty * Math.max(1, copies | 0); i++) out.push({ ...entry });
  }
  return out;
}

// Emojis (com tom de pele, ZWJ 👨‍👩‍👧 e bandeiras) viram trechos separados: no lugar deles fica um
// quadrado reservado, preenchido depois com o desenho colorido (ver emoji-art.mjs).
const EMOJI_RE = /(\p{Extended_Pictographic}(?:\uFE0F|\uFE0E|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic}\uFE0F?)*|[\u{1F1E6}-\u{1F1FF}]{2})/u;
export const hasEmoji = text => EMOJI_RE.test(String(text || ""));
export function splitEmoji(text) {
  return String(text).split(EMOJI_RE).map((t, i) => ({ text: t, emoji: i % 2 === 1 })).filter(s => s.text);
}
export const emojisIn = text => splitEmoji(text).filter(s => s.emoji).map(s => s.text);

// Converte uma linha de texto em path SVG (mm) centralizado em x = 0, linha de base em y = baseY.
// Cada emoji ocupa um quadrado de lado `emojiScale` × tamanho do texto, apoiado um pouco abaixo da
// linha de base; vai em `emojis` como { seq, x, y (topo), s } para ser desenhado em cores.
function textShape(font, text, sizePt, baseY, emojiScale = 1) {
  if (!text) return null;
  const placed = [], emojis = [];
  const k = (sizePt * PT_TO_MM) / font.unitsPerEm;
  let pen = 0; // mm
  for (const seg of splitEmoji(text)) {
    if (seg.emoji) {
      const s = sizePt * emojiScale * PT_TO_MM;
      emojis.push({ seq: seg.text, x: pen + s * 0.08, y: -s * 0.85, s });
      pen += s * 1.16;
      continue;
    }
    const run = font.layout(seg.text);
    run.glyphs.forEach((g, i) => {
      const p = run.positions[i];
      if (g.id !== 0) placed.push({ g, x: pen + p.xOffset * k, y: p.yOffset * k }); // id 0 = sem desenho na fonte (o "quadradinho")
      pen += p.xAdvance * k;
    });
  }
  const shift = -pen / 2;
  const boxes = [];
  let d = "";
  for (const { g, x, y } of placed) {
    const b = g.bbox;
    if (!g.path.commands.length || b.minX === Infinity) continue;
    d += g.path.scale(k, -k).translate(shift + x, baseY - y).toSVG();
    boxes.push({ minX: shift + x + b.minX * k, maxX: shift + x + b.maxX * k, minY: baseY - y - b.maxY * k, maxY: baseY - y - b.minY * k });
  }
  const em = emojis.map(e => ({ ...e, x: shift + e.x, y: baseY + e.y }));
  for (const e of em) boxes.push({ minX: e.x, maxX: e.x + e.s, minY: e.y, maxY: e.y + e.s });
  if (!boxes.length) return null;
  return {
    d, emojis: em, boxes,
    minX: Math.min(...boxes.map(b => b.minX)), maxX: Math.max(...boxes.map(b => b.maxX)),
    minY: Math.min(...boxes.map(b => b.minY)), maxY: Math.max(...boxes.map(b => b.maxY)),
  };
}

// Uma etiqueta: nome com linha de base em y = 0, função centralizada abaixo e, com 3 linhas,
// a linha de cima centralizada acima.
export function buildLabel(entry, fonts, opts) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const name = textShape(fonts.name, entry.name, o.nameSize, 0, o.emojiScale);
  const capH = ((fonts.role["OS/2"]?.capHeight || fonts.role.capHeight || fonts.role.unitsPerEm * 0.66) / fonts.role.unitsPerEm) * o.roleSize * PT_TO_MM;
  // Se uma letra do nome desce sobre a área da função (ex.: o J de "Jane"), a função desce junto.
  let roleTop = o.roleGap;
  const probe = name && textShape(fonts.role, entry.role, o.roleSize, 0, o.emojiScale);
  if (probe) {
    for (const g of name.boxes) {
      if (g.maxX > probe.minX - o.roleClear && g.minX < probe.maxX + o.roleClear) roleTop = Math.max(roleTop, g.maxY + o.roleClear);
    }
  }
  const role = textShape(fonts.role, entry.role, o.roleSize, roleTop + capH, o.emojiScale);
  // Linha de cima (3 linhas): fica `topGap` acima da letra mais alta do nome que está embaixo dela
  // (ex.: o "P" de "Paula"), descontando o que ela própria desce abaixo da linha de base.
  let top = null;
  const topProbe = entry.top && textShape(fonts.role, entry.top, o.topSize, 0, o.emojiScale);
  if (topProbe) {
    const under = name ? name.boxes.filter(g => g.maxX > topProbe.minX && g.minX < topProbe.maxX) : [];
    const nameTop = under.length ? Math.min(...under.map(g => g.minY)) : name ? name.minY : 0;
    top = textShape(fonts.role, entry.top, o.topSize, nameTop - o.topGap - Math.max(0, topProbe.maxY), o.emojiScale);
  }
  const parts = [top, name, role].filter(Boolean);
  if (!parts.length) return null;
  return {
    entry,
    d: parts.map(p => p.d).join(""),
    emojis: parts.flatMap(p => p.emojis),
    minX: Math.min(...parts.map(p => p.minX)),
    maxX: Math.max(...parts.map(p => p.maxX)),
    minY: Math.min(...parts.map(p => p.minY)),
    maxY: Math.max(...parts.map(p => p.maxY)),
  };
}

// Código do pedido: caixa no mesmo formato de uma etiqueta (origem na linha de base).
export function buildCode(fonts, opts) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const code = String(o.orderCode || "").trim();
  return code ? textShape(fonts.role, code, o.codeSize, 0) : null;
}

// Encaixe em prateleiras: da esquerda para a direita, linhas alinhadas pela linha de base
// do nome. `gap` é a distância mínima entre a tinta de duas etiquetas vizinhas.
// Recebe caixas { minX, maxX, minY, maxY } (relativas à origem da etiqueta) e devolve
// folhas com { x, y } = posição da origem de cada etiqueta. Com `code`, cada folha
// leva o código no canto superior esquerdo e as etiquetas começam `gap` abaixo dele.
export function packLabels(boxes, opts, code = null) {
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
  const top = code ? code.maxY - code.minY + o.gap : 0;
  const sheets = [];
  let sheet = null, y = 0;
  for (const r of rows) {
    const h = r.up + r.down;
    if (!sheet || (sheet.placed.length && y + o.gap + h > limit + 1e-6)) {
      sheet = { placed: [], contentH: 0 };
      if (code) sheet.code = { box: code, x: o.margin - code.minX, y: o.margin - code.minY };
      sheets.push(sheet);
      y = top;
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

const svgPath = p => `<path transform="translate(${fmt(p.x)} ${fmt(p.y)})" d="${p.box.d}"/>`;

// Emojis de todas as etiquetas da folha, já na posição da folha (mm).
export const sheetEmojis = sheet => sheet.placed.flatMap(p => (p.box.emojis || []).map(e => ({ ...e, x: p.x + e.x, y: p.y + e.y })));

// `art`: Map emoji → [{ d, fill }] (coordenadas 0–1), de emoji-art.mjs. Emoji ainda não carregado não aparece.
export function sheetToSvg(sheet, { fill = "#000", codeFill = "#000", art = null } = {}) {
  const code = sheet.code ? `<g fill="${codeFill}">${svgPath(sheet.code)}</g>` : "";
  const emojis = sheetEmojis(sheet).map(e => {
    const shapes = art?.get(e.seq);
    return shapes ? `<g transform="translate(${fmt(e.x)} ${fmt(e.y)}) scale(${fmt(e.s)})">${shapes.map(s => `<path fill="${s.fill}" d="${s.d}"/>`).join("")}</g>` : "";
  }).join("");
  // Artes enviadas (art-upload.mjs): a prévia da arte no lugar de cada cópia.
  const arts = sheet.placed.filter(p => p.box.art && p.box.preview).map(p =>
    `<image x="${fmt(p.x)}" y="${fmt(p.y - p.box.h)}" width="${fmt(p.box.w)}" height="${fmt(p.box.h)}" preserveAspectRatio="none" href="${p.box.preview}"/>`).join("");
  const texts = sheet.placed.filter(p => !p.box.art).map(svgPath).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.w}mm" height="${sheet.h}mm" viewBox="0 0 ${sheet.w} ${sheet.h}">${code}<g fill="${fill}">${texts}</g>${emojis}${arts}</svg>`;
}

// Camadas do RIP, na ordem em que são impressas: CMYK > Branco > Verniz.
// `cs` é o nome do recurso de espaço de cor da página (null = processo CMYK com `cmyk`, 0–1).
export function letterCmyk(o) {
  if (o.letter === "white") return null;
  if (o.letter === "color") return (o.cmyk || DEFAULT_OPTS.cmyk).map(v => Math.min(100, Math.max(0, +v || 0)) / 100);
  return [1, 1, 1, 1];
}

export function pdfLayers(o) {
  const out = [];
  const cmyk = letterCmyk(o);
  if (cmyk) out.push({ key: "cmyk", label: `CMYK ${cmyk.map(v => Math.round(v * 100)).join("/")}`, cs: null, cmyk });
  if (o.whiteLayer) out.push({ key: "white", label: o.whiteSpot, cs: "CSWhite", spot: o.whiteSpot, alt: [0, 0, 0, 0.15] });
  if (o.varnishLayer) out.push({ key: "varnish", label: o.varnishSpot, cs: "CSVarnish", spot: o.varnishSpot, alt: [0, 0, 0.3, 0] });
  return out;
}

// Path SVG absoluto (M/L/Q/C/Z, como o fontkit gera) → operadores de caminho do PDF.
// (tx, ty) e o path em mm com Y para baixo (path multiplicado por `scale`); a saída em pt com Y para
// cima, numa página de altura pageH pt.
export function svgPathToPdf(d, tx, ty, pageH, scale = 1) {
  const MM = 72 / 25.4;
  const X = x => fmt((tx + x * scale) * MM), Y = y => fmt(pageH - (ty + y * scale) * MM);
  const t = d.match(/[MLQCZ]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || [];
  let i = 0, cx = 0, cy = 0;
  const out = [];
  const n = () => parseFloat(t[i++]);
  while (i < t.length) {
    const c = t[i++].toUpperCase();
    if (c === "M" || c === "L") { cx = n(); cy = n(); out.push(`${X(cx)} ${Y(cy)} ${c === "M" ? "m" : "l"}`); }
    else if (c === "C") { const v = [n(), n(), n(), n(), n(), n()]; out.push(`${X(v[0])} ${Y(v[1])} ${X(v[2])} ${Y(v[3])} ${X(v[4])} ${Y(v[5])} c`); cx = v[4]; cy = v[5]; }
    else if (c === "Q") {
      const qx = n(), qy = n(), x = n(), y = n();
      out.push(`${X(cx + (2 / 3) * (qx - cx))} ${Y(cy + (2 / 3) * (qy - cy))} ${X(x + (2 / 3) * (qx - x))} ${Y(y + (2 / 3) * (qy - y))} ${X(x)} ${Y(y)} c`);
      cx = x; cy = y;
    } else if (c === "Z") out.push("h");
  }
  return out.map(l => l + "\n").join("");
}

// Conteúdo da página: cada camada repete as mesmas letras, por cima da anterior.
// Só as camadas spot (Branco, Verniz) levam sobreposição (gs); o CMYK fica sem.
// O código do pedido sai em CMYK 100/100/100/100 (sem sobreposição, mesmo com letra branca) e
// também na camada Branco; não leva verniz.
// `oy` desloca a folha para baixo (mm), para empilhar várias numa página só.
// Emojis (`art`, ver sheetToSvg) saem nas cores originais logo depois da camada CMYK, sem sobreposição;
// nas camadas Branco e Verniz entra a silhueta deles, como máscara.
// Artes enviadas (`artRes`: Map artId → { color, form: { w, h } | null, mask }, nomes de XObject da
// página): a arte sai nas cores dela depois da camada CMYK, sem sobreposição; no Branco e no Verniz
// entra a máscara 1 bit do contorno (`mask`) ou, sem ela, o retângulo da cópia.
export function sheetContent(sheet, layers, pageH, gs, oy = 0, art = null, artRes = null) {
  const codePath = sheet.code ? svgPathToPdf(sheet.code.box.d, sheet.code.x, sheet.code.y + oy, pageH) + "f\n" : "";
  const code = codePath && `q\n1 1 1 1 k\n${codePath}Q\n`;
  const paths = sheet.placed.filter(p => !p.box.art).map(p => svgPathToPdf(p.box.d, p.x, p.y + oy, pageH) + "f\n").join("");
  const arts = sheet.placed.filter(p => p.box.art && artRes?.get(p.box.artId)).map(p => {
    const MM = 72 / 25.4, r = artRes.get(p.box.artId);
    const x = fmt(p.x * MM), y = fmt(pageH - (p.y + oy) * MM), w = p.box.w * MM, h = p.box.h * MM;
    const cm = (sx, sy) => `${fmt(sx)} 0 0 ${fmt(sy)} ${x} ${y} cm`;
    return {
      color: `q\n${r.form ? cm(w / r.form.w, h / r.form.h) : cm(w, h)}\n/${r.color} Do\nQ\n`,
      mask: r.mask ? `q\n${cm(w, h)}\n/${r.mask} Do\nQ\n` : `${x} ${y} ${fmt(w)} ${fmt(h)} re\nf\n`,
    };
  });
  const artColor = arts.map(a => a.color).join(""), artMask = arts.map(a => a.mask).join("");
  const emojis = sheetEmojis(sheet).map(e => ({ e, shapes: art?.get(e.seq) })).filter(x => x.shapes);
  const emojiPath = (e, s) => svgPathToPdf(s.d, e.x, e.y + oy, pageH, e.s) + "f\n";
  const masks = emojis.map(({ e, shapes }) => shapes.map(s => emojiPath(e, s)).join("")).join("");
  const color = emojis.length ? `q\n${emojis.map(({ e, shapes }) => shapes.map(s => `${hexToRgb(s.fill).map(fmt).join(" ")} rg\n${emojiPath(e, s)}`).join("")).join("")}Q\n` : "";
  const fill = l => l.cs ? `/${l.cs} cs 1 scn` : `${(l.cmyk || [1, 1, 1, 1]).map(fmt).join(" ")} k`;
  const layer = l => ["q", gs && l.spot && `/${gs} gs`, fill(l)].filter(Boolean).join("\n") + "\n" + paths + (l.spot ? masks + artMask : "") + (l.key === "white" ? codePath : "") + "Q\n";
  const cmyk = layers.filter(l => !l.spot), spots = layers.filter(l => l.spot);
  return cmyk.map(layer).join("") + color + artColor + code + spots.map(layer).join("");
}

// Junta as folhas de vários pedidos uma embaixo da outra, com `gap` mm entre elas.
// Abre página nova quando passa de `maxPageH` mm (o Acrobat não abre página com mais de ~5 m).
export function stackSheets(sheets, { gap = DEFAULT_OPTS.gap, maxPageH = 5000 } = {}) {
  const pages = [];
  let page = null;
  for (const sheet of sheets) {
    if (!page || page.h + gap + sheet.h > maxPageH) {
      page = { w: 0, h: 0, items: [] };
      pages.push(page);
    } else page.h += gap;
    page.items.push({ sheet, oy: page.h });
    page.h += sheet.h;
    page.w = Math.max(page.w, sheet.w);
  }
  return pages;
}

// Cor aproximada para a tela (o RIP usa os valores CMYK de verdade).
export function cmykToHex([c, m, y, k]) {
  const ch = v => Math.round(255 * (1 - v) * (1 - k)).toString(16).padStart(2, "0");
  return `#${ch(c)}${ch(m)}${ch(y)}`;
}
