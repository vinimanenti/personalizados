import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as db from "./lib/db";

/* ─── constants ─── */
const MODELS = Array.from({ length: 18 }, (_, i) => {
  const id = String(i + 1).padStart(3, "0");
  return {
    id: `MOD${id}`,
    thumbUrl: null, svgData: null, svgUrl: null,
    fields: [],
    maxWidth: 3600,
    fontFamily: "DK Coal Brush",
    fontSize: 715.51,
    fontSource: "default",
    glyphMap: {}, defaultAdv: 504, textCenters: {},
  };
});
const STORES = ["TR Etiquetas", "Jd Adesivos", "Casa do Condi", "VM Adesivos", "IG Stickers"];

/* ─── SVG analysis ─── */
const analyzeSvg = (svgText) => {
  const fieldMap = {};
  const re = /<text\s[^>]*id="(campo_nome_\d+)"[^>]*x="([^"]*)"[^>]*y="([^"]*)"[^>]*>([^<]*)<\/text>/g;
  let m;
  while ((m = re.exec(svgText)) !== null) {
    const [, name, x, y, content] = m;
    if (!fieldMap[name]) fieldMap[name] = [];
    fieldMap[name].push({ x: parseFloat(x), y: parseFloat(y), content: content.trim() });
  }
  const re2 = /<text\s[^>]*x="([^"]*)"[^>]*y="([^"]*)"[^>]*id="(campo_nome_\d+)"[^>]*>([^<]*)<\/text>/g;
  while ((m = re2.exec(svgText)) !== null) {
    const [, x, y, name, content] = m;
    if (!fieldMap[name]) fieldMap[name] = [];
    const px = parseFloat(x), py = parseFloat(y);
    if (!fieldMap[name].some(e => e.x === px && e.y === py))
      fieldMap[name].push({ x: px, y: py, content: content.trim() });
  }
  const fields = Object.keys(fieldMap).sort((a, b) => parseInt(a.split("_")[2]) - parseInt(b.split("_")[2]))
    .map(name => ({ name, occurrences: fieldMap[name].length, positions: fieldMap[name] }));

  // Detect which fnt class is used by campo_nome fields
  const fntClassMatch = svgText.match(/id="campo_nome_\d+"[^>]*class="[^"]*\b(fnt\d+)\b/);
  const fntClass = fntClassMatch ? fntClassMatch[1] : "fnt0";

  let fontSize = 715.51;
  const fsRe = new RegExp(`\\.${fntClass}\\s*\\{[^}]*font-size:\\s*([0-9.]+)px`);
  const fsMatch = svgText.match(fsRe);
  if (fsMatch) fontSize = parseFloat(fsMatch[1]);

  let fontFamily = "DK Coal Brush";
  const ffRe = new RegExp(`\\.${fntClass}\\s*\\{[^}]*font-family:\\s*'([^']+)'`);
  const ffMatch = svgText.match(ffRe);
  if (ffMatch) fontFamily = ffMatch[1];

  // Extract SVG embedded font glyph widths for precise text centering
  // Step 1: Find which FontID is used by the campo_nome font family via @font-face CSS
  const fontFaceRe = new RegExp(`font-family:"${fontFamily.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^}]*src:url\\("#(\\w+)"\\)`, "i");
  const fontFaceMatch = svgText.match(fontFaceRe);
  const targetFontId = fontFaceMatch ? fontFaceMatch[1] : "FontID0";

  // Step 2: Get default horiz-adv-x for that specific font
  const defaultAdvRe = new RegExp(`id="${targetFontId}"[^>]*horiz-adv-x="(\\d+)"`);
  const defaultAdvMatch = svgText.match(defaultAdvRe);
  const defaultAdv = defaultAdvMatch ? parseInt(defaultAdvMatch[1]) : 504;

  // Step 3: Extract glyphs ONLY from the correct font section
  const fontStartIdx = svgText.indexOf(`id="${targetFontId}"`);
  const fontEndIdx = svgText.indexOf("</font>", fontStartIdx);
  const fontSection = fontStartIdx >= 0 && fontEndIdx >= 0 ? svgText.substring(fontStartIdx, fontEndIdx) : svgText;
  const glyphMap = {};
  const glyphRe = /<glyph\s+unicode="(.)"[^>]*horiz-adv-x="(\d+)"/g;
  let gm;
  while ((gm = glyphRe.exec(fontSection)) !== null) glyphMap[gm[1]] = parseInt(gm[2]);

  // Step 4: Compute text centers per column dynamically
  // Group fields by their X position (fields in the same column share the same X)
  const measureW = (text) => {
    let t = 0;
    for (const ch of text) t += (glyphMap[ch] || defaultAdv);
    return t * fontSize / 1000;
  };

  // Find reference text — the template placeholder (could be "NOME AQUI", "Nome Aqui", etc.)
  // Use the most common text content across fields as the reference
  const contentCounts = {};
  for (const f of fields) {
    const c = f.positions[0].content;
    contentCounts[c] = (contentCounts[c] || 0) + 1;
  }
  const refText = Object.entries(contentCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "NOME AQUI";
  const refWidth = measureW(refText);

  // Group fields by unique X positions (each unique X = a column)
  const xGroups = {};
  for (const f of fields) {
    const x = Math.round(f.positions[0].x);
    if (!xGroups[x]) xGroups[x] = [];
    xGroups[x].push(f);
  }

  // For each column, compute center from the reference field's position
  const colCenterMap = {}; // {roundedX: centerX}
  for (const [xStr, colFields] of Object.entries(xGroups)) {
    // Use a field with the reference text to compute center, fall back to first field
    const ref = colFields.find(f => f.positions[0].content === refText) || colFields[0];
    const refX = ref.positions[0].x;
    const w = measureW(ref.positions[0].content);
    colCenterMap[xStr] = refX + w / 2;
  }

  // Assign center to each field based on its column
  const textCenters = {};
  for (const f of fields) {
    const x = Math.round(f.positions[0].x);
    textCenters[f.name] = colCenterMap[x] || (f.positions[0].x + refWidth / 2);
  }

  return { fields, fontSize, fontFamily, glyphMap, defaultAdv, textCenters };
};

/* ─── SVG font text width (uses embedded glyph advances — precise) ─── */
const measureSvgFont = (text, fontSize, glyphMap, defaultAdv) => {
  let total = 0;
  for (const ch of text) total += (glyphMap[ch] || defaultAdv);
  return total * fontSize / 1000;
};

/* ─── Canvas text measurement (fallback / for line break decisions) ─── */
const measureText = (text, font, size) => {
  const c = document.createElement("canvas").getContext("2d");
  c.font = `${size}px "${font}"`;
  return c.measureText(text).width;
};

/* ─── Line breaking ─── */
const breakLines = (name, font, fontSize, maxWidth) => {
  if (!name || !name.trim()) return [name || ""];
  const w = measureText(name, font, fontSize);
  if (w <= maxWidth) return [name];
  const words = name.split(/\s+/);
  if (words.length < 2) return [name];
  // Find the most balanced split
  let best = [name], bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const l1 = words.slice(0, i).join(" ");
    const l2 = words.slice(i).join(" ");
    const diff = Math.abs(measureText(l1, font, fontSize) - measureText(l2, font, fontSize));
    if (diff < bestDiff) { bestDiff = diff; best = [l1, l2]; }
  }
  return best;
};

/* ─── SVG injection ─── */
const injectNames = (svgText, namesList, model, fontOverrides = {}) => {
  let svg = svgText;
  const fieldNames = model.fields.map(f => f.name);
  const gm = model.glyphMap || {};
  const da = model.defaultAdv || 504;
  const tc = model.textCenters || {};

  // Detect original font size from the campo_nome fnt class
  const fntClsMatch = svgText.match(/id="campo_nome_\d+"[^>]*class="[^"]*\b(fnt\d+)\b/);
  const fntCls = fntClsMatch ? fntClsMatch[1] : "fnt0";
  const origSizeRe = new RegExp(`\\.${fntCls}\\s*\\{[^}]*font-size:\\s*([0-9.]+)px`);
  const origSizeMatch = svgText.match(origSizeRe);
  const origFontSize = origSizeMatch ? parseFloat(origSizeMatch[1]) : model.fontSize;

  fieldNames.forEach((fieldName, idx) => {
    const name = idx < namesList.length ? namesList[idx] : "";
    const fieldFontSize = fontOverrides[idx] !== undefined ? fontOverrides[idx] : model.fontSize;
    const lines = breakLines(name, model.fontFamily, fieldFontSize, model.maxWidth);
    const field = model.fields[idx];
    if (!field) return;

    const customSize = Math.abs(fieldFontSize - origFontSize) > 1;
    const sizeStyle = customSize ? ` style="font-size:${fieldFontSize}px"` : "";

    const removeRe = new RegExp(`<text\\s[^>]*id="${fieldName}"[^>]*>[^<]*<\\/text>`, "g");
    const matches = [...svg.matchAll(removeRe)];
    if (matches.length === 0) return;

    const firstPos = field.positions[0];
    const baseY = firstPos.y;
    const classMatch = matches[0][0].match(/class="([^"]*)"/);
    const cls = classMatch ? classMatch[1] : "fil4 fnt0";
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    // Text area center for this field — computed from original Corel position + template text width
    const centerX = tc[fieldName] || (firstPos.x + 1500);

    let replacement;
    if (lines.length === 1) {
      const tw = measureSvgFont(lines[0], fieldFontSize, gm, da);
      const cx = centerX - tw / 2;
      replacement = `<text x="${cx.toFixed(2)}" y="${baseY}" id="${fieldName}" class="${cls}"${sizeStyle}>${esc(lines[0])}</text>`;
    } else {
      const lineSpacing = fieldFontSize * 0.95;
      const totalHeight = lineSpacing * (lines.length - 1);
      const startY = baseY - totalHeight / 2;
      replacement = lines.map((line, li) => {
        const tw = measureSvgFont(line, fieldFontSize, gm, da);
        const cx = centerX - tw / 2;
        return `<text x="${cx.toFixed(2)}" y="${(startY + li * lineSpacing).toFixed(2)}" id="${fieldName}" class="${cls}"${sizeStyle}>${esc(line)}</text>`;
      }).join("\n  ");
    }

    let replaced = false;
    svg = svg.replace(removeRe, (match) => {
      if (!replaced) { replaced = true; return replacement; }
      return "";
    });
  });

  // Replace codigo_pedido field if present
  if (model.orderCode) {
    const pedidoRe = /(<text\s[^>]*id="codigo_pedido"[^>]*>)[^<]*(<\/text>)/g;
    const escCode = model.orderCode.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    svg = svg.replace(pedidoRe, `$1${escCode}$2`);
  }

  // Replace campo_loja field if present
  if (model.store) {
    const lojaRe = /(<text\s[^>]*id="campo_loja"[^>]*>)[^<]*(<\/text>)/g;
    const escStore = model.store.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    svg = svg.replace(lojaRe, `$1${escStore}$2`);
  }

  return svg;
};

/* ─── SVG to PNG ─── */
const svgToPng = async (svgStr, scale = 3) => {
  return new Promise((resolve, reject) => {
    const m = svgStr.match(/viewBox="([^"]*)"/);
    let w = 800, h = 600;
    if (m) { const p = m[1].split(/[\s,]+/).map(Number); w = p[2]; h = p[3]; }
    const canvas = document.createElement("canvas");
    canvas.width = w * scale; canvas.height = h * scale;
    const ctx = canvas.getContext("2d");
    const img = new Image();
    const blob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    img.onload = () => { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); URL.revokeObjectURL(url); canvas.toBlob(b => resolve(b), "image/png", 1.0); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Render failed")); };
    img.src = url;
  });
};

/* ─── Icons ─── */
const I = ({ n, s = 20 }) => {
  const d = {
    upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></>,
    check: <><polyline points="20 6 9 17 4 12"/></>,
    download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></>,
    grid: <><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></>,
    list: <><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></>,
    eye: <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>,
    zap: <><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></>,
    font: <><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></>,
    file: <><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></>,
    printer: <><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></>,
    trash: <><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></>,
    target: <><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></>,
    pkg: <><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></>,
  };
  return <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{d[n]}</svg>;
};

const Tab = ({ active, onClick, icon, label }) => (
  <button onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 20px", background: active ? "var(--accent)" : "transparent", color: active ? "#fff" : "var(--t2)", border: "none", borderRadius: 10, cursor: "pointer", fontWeight: 600, fontSize: 14, transition: "all .2s", fontFamily: "inherit" }}>
    <I n={icon} s={18} />{label}
  </button>
);

/* ── Calibration ── */
const Calibration = ({ model, onUpdate }) => {
  const [test, setTest] = useState("JOAO PEDRO DA SILVA");
  const [tw, setTw] = useState(model.maxWidth);
  const [tf, setTf] = useState(model.fontSize);
  useEffect(() => { setTw(model.maxWidth); setTf(model.fontSize); }, [model.id]);

  const textW = useMemo(() => measureText(test, model.fontFamily, tf), [test, model.fontFamily, tf]);
  const lines = useMemo(() => breakLines(test, model.fontFamily, tf, tw), [test, model.fontFamily, tf, tw]);
  const fits = textW <= tw;

  const preview = useMemo(() => {
    if (!model.svgData) return null;
    const names = model.fields.map((_, i) => i === 0 ? test : "NOME AQUI");
    return injectNames(model.svgData, names, { ...model, maxWidth: tw, fontSize: tf });
  }, [model, test, tw, tf]);

  const dirty = tw !== model.maxWidth || tf !== model.fontSize;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}><I n="target" s={18} /> Calibração Visual</h3>
          <span style={{ padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600, background: fits ? "rgba(52,211,153,.12)" : lines.length > 1 ? "rgba(251,191,36,.12)" : "rgba(248,113,113,.12)", color: fits ? "#34d399" : lines.length > 1 ? "#fbbf24" : "#f87171" }}>
            {fits ? "1 linha" : lines.length > 1 ? `${lines.length} linhas` : "Excede"}
          </span>
        </div>
        <p style={{ fontSize: 12, color: "var(--t3)", marginBottom: 14 }}>
          Digite um nome longo. Ajuste o slider até caber na moldura do adesivo.
        </p>

        <input type="text" value={test} onChange={e => setTest(e.target.value.toUpperCase())} style={{ width: "100%", padding: "10px 14px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 10, color: "var(--t1)", fontSize: 14, fontFamily: "inherit", marginBottom: 14, textTransform: "uppercase" }} />

        {/* Bar */}
        <div style={{ background: "var(--bg)", borderRadius: 10, padding: 12, marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--t2)", marginBottom: 6 }}>
            <span>Texto: <b style={{ color: "var(--t1)", fontFamily: "mono" }}>{Math.round(textW)}</b></span>
            <span>Limite: <b style={{ color: "#ff7b5c", fontFamily: "mono" }}>{tw}</b></span>
          </div>
          <div style={{ height: 8, background: "var(--brd)", borderRadius: 4, overflow: "hidden" }}>
            <div style={{ height: "100%", borderRadius: 4, transition: "width .15s", width: `${Math.min(100, (textW / tw) * 100)}%`, background: fits ? "#34d399" : lines.length > 1 ? "#fbbf24" : "#f87171" }} />
          </div>
          {lines.length > 1 && (
            <div style={{ marginTop: 8, fontSize: 11, color: "#fbbf24" }}>
              {lines.map((l, i) => <div key={i}>↳ Linha {i + 1}: "{l}"</div>)}
            </div>
          )}
        </div>

        {/* Slider: largura */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <label style={{ fontSize: 12, color: "var(--t2)" }}>Largura máxima (unidades SVG)</label>
            <input type="number" value={tw} onChange={e => setTw(parseInt(e.target.value) || 100)} style={{ width: 80, padding: "3px 8px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 6, color: "#ff7b5c", fontSize: 13, fontFamily: "mono", textAlign: "right" }} />
          </div>
          <input type="range" min="1000" max="6000" step="50" value={tw} onChange={e => setTw(parseInt(e.target.value))} style={{ width: "100%", accentColor: "#e85d3a" }} />
        </div>

        {/* Slider: fonte */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <label style={{ fontSize: 12, color: "var(--t2)" }}>Tamanho da fonte (px)</label>
            <input type="number" value={Math.round(tf)} onChange={e => setTf(parseFloat(e.target.value) || 100)} style={{ width: 80, padding: "3px 8px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 6, color: "#ff7b5c", fontSize: 13, fontFamily: "mono", textAlign: "right" }} />
          </div>
          <input type="range" min="100" max="1500" step="5" value={tf} onChange={e => setTf(parseFloat(e.target.value))} style={{ width: "100%", accentColor: "#e85d3a" }} />
        </div>

        {/* Info */}
        <div style={{ fontSize: 11, color: "var(--t3)", padding: 10, background: "var(--bg)", borderRadius: 8 }}>
          <div>Fonte: <b style={{ color: "var(--t1)" }}>{model.fontFamily}</b> · {Math.round(tf)}px {tf !== model.fontSize && <span style={{ color: "#fbbf24" }}>(original: {model.fontSize}px)</span>}</div>
          <div>Campos: <b style={{ color: "var(--t1)" }}>{model.fields.length}</b> ({model.fields.filter(f => f.occurrences > 1).length > 0 ? "com linhas duplas no Corel" : "linha única"})</div>
        </div>

        {dirty && (
          <button onClick={() => onUpdate(model.id, { maxWidth: tw, fontSize: tf })} style={{ width: "100%", marginTop: 12, background: "#e85d3a", color: "#fff", border: "none", padding: "12px", borderRadius: 10, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <I n="check" s={16} /> Aplicar: Largura {tw} · Fonte {Math.round(tf)}px
          </button>
        )}
      </div>

      {preview && (
        <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 20 }}>
          <div style={{ fontSize: 12, color: "var(--t2)", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}><I n="eye" s={14} /> Preview ao vivo</div>
          <div style={{ background: "#fff", borderRadius: 10, padding: 6, overflow: "auto", maxHeight: 400, border: `2px solid ${fits ? "#34d399" : "#fbbf24"}` }}
            dangerouslySetInnerHTML={{ __html: preview.replace(/<svg/, '<svg style="width:100%;height:auto"') }} />
        </div>
      )}
    </div>
  );
};

/* ═══ App ═══ */
export default function App() {
  const [models, setModels] = useState(MODELS);
  const [selId, setSelId] = useState(null);
  const [tab, setTab] = useState("gallery");
  const [names, setNames] = useState("");
  const [sheets, setSheets] = useState([]);
  const [pi, setPi] = useState(0);
  const [fontOk, setFontOk] = useState({});
  const [fontOv, setFontOv] = useState({}); // {nameIndex: customFontSize}
  const [orderCode, setOrderCode] = useState(""); // codigo do pedido Shopee
  const [store, setStore] = useState(STORES[0]); // loja selecionada
  const [printQueue, setPrintQueue] = useState([]); // [{id, svg, label, store, orderCode, model, timestamp}]
  const [pdfGenerating, setPdfGenerating] = useState(false);
  const [dbLoading, setDbLoading] = useState(true);
  const fRef = useRef(null), tRef = useRef(null), foRef = useRef(null);

  const sel = models.find(m => m.id === selId);

  // Load from Supabase on mount
  useEffect(() => {
    (async () => {
      try {
        const [dbModels, queue] = await Promise.all([
          db.fetchModels(),
          db.fetchPrintQueue(),
        ]);
        setModels(prev => prev.map(d => {
          const remote = dbModels.find(r => r.id === d.id);
          return remote ? { ...d, ...remote } : d;
        }));
        setPrintQueue(queue);
      } catch (e) {
        console.error("Erro ao carregar do Supabase:", e);
      }
      setDbLoading(false);
    })();
  }, []);

  // Load SVG data on demand when a model is selected
  useEffect(() => {
    if (!sel || sel.svgData || !sel.svgUrl) return;
    (async () => {
      try {
        const svgText = await db.downloadSvg(sel.svgUrl);
        setModels(p => p.map(m => m.id === sel.id ? { ...m, svgData: svgText } : m));
      } catch (e) {
        console.error("Erro ao baixar SVG:", e);
      }
    })();
  }, [sel?.id, sel?.svgUrl, sel?.svgData]);

  const upd = useCallback((id, u) => {
    setModels(p => p.map(m => m.id === id ? { ...m, ...u } : m));
    // Persist to Supabase (fire and forget, non-blocking)
    const dbUpdates = { ...u };
    delete dbUpdates.svgData; // SVG data goes to Storage, not DB
    if (Object.keys(dbUpdates).length > 0) {
      db.updateModel(id, dbUpdates).catch(e => console.error("Erro ao salvar modelo:", e));
    }
  }, []);

  const onSvg = (e) => {
    const file = e.target.files[0]; if (!file || !selId) return;
    const r = new FileReader();
    r.onload = async (ev) => {
      const svg = ev.target.result;
      const { fields, fontSize, fontFamily, glyphMap, defaultAdv, textCenters } = analyzeSvg(svg);
      // Upload to Supabase Storage
      try {
        const svgUrl = await db.uploadSvg(selId, svg);
        upd(selId, { svgData: svg, svgUrl, fields, fontSize, fontFamily, glyphMap, defaultAdv, textCenters });
      } catch (err) {
        console.error("Erro ao upload SVG:", err);
        // Still update locally even if upload fails
        upd(selId, { svgData: svg, fields, fontSize, fontFamily, glyphMap, defaultAdv, textCenters });
      }
    };
    r.readAsText(file); e.target.value = "";
  };
  const onThumb = (e) => {
    const f = e.target.files[0]; if (!f || !selId) return;
    const r = new FileReader();
    r.onload = async (ev) => {
      const dataUrl = ev.target.result;
      try {
        const thumbUrl = await db.uploadThumb(selId, dataUrl);
        upd(selId, { thumbUrl });
      } catch (err) {
        console.error("Erro ao upload thumb:", err);
        upd(selId, { thumbUrl: dataUrl });
      }
    };
    r.readAsDataURL(f); e.target.value = "";
  };
  const onFont = async (e) => {
    const f = e.target.files[0]; if (!f || !selId) return;
    const r = new FileReader();
    r.onload = async (ev) => {
      const nm = f.name.replace(/\.(ttf|otf|woff|woff2)$/i, "").replace(/[^a-zA-Z0-9\s-]/g, "");
      try { const fc = new FontFace(nm, ev.target.result); await fc.load(); document.fonts.add(fc); upd(selId, { fontFamily: nm, fontSource: "file" }); setFontOk(p => ({ ...p, [selId]: true })); } catch (err) { alert("Erro: " + err.message); }
    };
    r.readAsArrayBuffer(f); e.target.value = "";
  };

  const nl = useMemo(() => names.split("\n").map(n => n.trim()).filter(Boolean), [names]);
  const stats = useMemo(() => { if (!sel) return null; const f = sel.fields.length || 1, t = nl.length, s = t > 0 ? Math.ceil(t / f) : 0; return { t, s, f, e: s > 0 ? s * f - t : 0 }; }, [sel, nl]);

  const gen = () => {
    if (!sel?.svgData || !sel.fields.length || !nl.length) return;
    const fps = sel.fields.length;
    const res = [];
    for (let i = 0; i < Math.ceil(nl.length / fps); i++) {
      const sn = nl.slice(i * fps, (i + 1) * fps);
      // Remap fontOverrides: global name index → per-sheet field index
      const sheetOv = {};
      for (let j = 0; j < sn.length; j++) {
        const globalIdx = i * fps + j;
        if (fontOv[globalIdx] !== undefined) sheetOv[j] = fontOv[globalIdx];
      }
      res.push({ i: i + 1, svg: injectNames(sel.svgData, sn, { ...sel, orderCode, store }, sheetOv), n: sn, e: fps - sn.length });
    }
    setSheets(res); setPi(0); setTab("preview");
  };

  const filePrefix = (idx) => `${sel.id}${store ? `_${store.replace(/\s+/g, "")}` : ""}${orderCode ? `_${orderCode}` : ""}_cartela_${String(idx).padStart(2, "0")}`;
  const dlSvg = (s) => { const b = new Blob([s.svg], { type: "image/svg+xml" }); const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href = u; a.download = `${filePrefix(s.i)}.svg`; a.click(); URL.revokeObjectURL(u); };
  const dlPng = async (s) => { try { const b = await svgToPng(s.svg, 3); const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href = u; a.download = `${filePrefix(s.i)}.png`; a.click(); URL.revokeObjectURL(u); } catch (e) { alert(e.message); } };
  const dlZip = async () => {
    const JSZip = (await import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm")).default;
    const z = new JSZip();
    for (const s of sheets) { z.file(`${filePrefix(s.i)}.svg`, s.svg); try { z.file(`${filePrefix(s.i)}.png`, await svgToPng(s.svg, 3)); } catch {} }
    const b = await z.generateAsync({ type: "blob" }); const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href = u; a.download = `${sel.id}${store ? `_${store.replace(/\s+/g, "")}` : ""}${orderCode ? `_${orderCode}` : ""}_cartelas.zip`; a.click(); URL.revokeObjectURL(u);
  };

  const addToQueue = async () => {
    if (!sheets.length || !sel) return;
    const items = sheets.map(s => ({
      svg: s.svg,
      label: `${sel.id} #${s.i} (${s.n.length} nomes)`,
      store, orderCode, model: sel.id,
      names: s.n,
      timestamp: Date.now(),
    }));
    try {
      // Create order in DB
      const orderId = await db.createOrder({
        orderCode: orderCode || "SEM_CODIGO",
        store,
        modelId: sel.id,
        names: nl,
        fontOverrides: fontOv,
        sheetsCount: sheets.length,
      });
      // Add to print queue in DB
      await db.addToPrintQueue(items, orderId);
      // Reload queue from DB to get IDs
      const queue = await db.fetchPrintQueue();
      setPrintQueue(queue);
    } catch (err) {
      console.error("Erro ao adicionar à fila:", err);
      // Fallback: add locally
      setPrintQueue(p => [...p, ...items]);
    }
    // Reset generate data for new order
    setNames("");
    setOrderCode("");
    setFontOv({});
    setSheets([]);
    setPi(0);
    setTab("generate");
  };

  const removeFromQueue = async (idx) => {
    const item = printQueue[idx];
    setPrintQueue(p => p.filter((_, i) => i !== idx));
    if (item?.id) {
      db.removeFromPrintQueue(item.id).catch(e => console.error("Erro ao remover:", e));
    }
  };

  const generatePdf = async () => {
    if (!printQueue.length) return;
    setPdfGenerating(true);
    try {
      // Render all SVGs to PNG images
      const images = [];
      for (const item of printQueue) {
        const blob = await svgToPng(item.svg, 3);
        const url = URL.createObjectURL(blob);
        // Get dimensions from SVG
        const dimMatch = item.svg.match(/viewBox="([^"]*)"/);
        let w = 800, h = 600;
        if (dimMatch) { const p = dimMatch[1].split(/[\s,]+/).map(Number); w = p[2]; h = p[3]; }
        images.push({ url, w, h, blob });
      }

      // Calculate page layout: fit cartelas side by side
      // Based on example PDF: ~991 x 1162 mm page
      // Each cartela SVG is 110.2mm x 170.2mm (from viewBox 11005.76 x 16998)
      // That means ~9 columns x 6 rows could fit, but the example shows them arranged
      // We'll use a large page and place cartelas in a grid

      // SVG dimensions in mm (from the SVG header)
      const cartelaWmm = 110.2;
      const cartelaHmm = 170.2;
      const marginMm = 2;

      // Calculate grid: how many fit on a large sheet
      // Use a standard large format: fit as many as needed
      const cols = Math.ceil(Math.sqrt(printQueue.length * (cartelaHmm / cartelaWmm)));
      const rows = Math.ceil(printQueue.length / cols);
      const pageWmm = cols * cartelaWmm + (cols + 1) * marginMm;
      const pageHmm = rows * cartelaHmm + (rows + 1) * marginMm;

      // Convert mm to points (1mm = 2.83465pt)
      const mmToPt = 2.83465;
      const pageWpt = pageWmm * mmToPt;
      const pageHpt = pageHmm * mmToPt;
      const cwPt = cartelaWmm * mmToPt;
      const chPt = cartelaHmm * mmToPt;
      const mPt = marginMm * mmToPt;

      // Use jsPDF
      const jspdfModule = await import("https://cdn.jsdelivr.net/npm/jspdf@2.5.1/+esm");
      const { jsPDF } = jspdfModule;
      const pdf = new jsPDF({
        orientation: pageWmm > pageHmm ? "landscape" : "portrait",
        unit: "pt",
        format: [pageWpt, pageHpt],
      });

      // Place each cartela
      for (let idx = 0; idx < printQueue.length; idx++) {
        const col = idx % cols;
        const row = Math.floor(idx / cols);
        const x = mPt + col * (cwPt + mPt);
        const y = mPt + row * (chPt + mPt);

        // Convert blob to base64
        const arrayBuf = await images[idx].blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuf);
        let binary = "";
        for (let b = 0; b < bytes.length; b++) binary += String.fromCharCode(bytes[b]);
        const base64 = btoa(binary);

        pdf.addImage("data:image/png;base64," + base64, "PNG", x, y, cwPt, chPt);
      }

      // Cleanup
      images.forEach(img => URL.revokeObjectURL(img.url));

      // Mark as printed in DB
      const ids = printQueue.filter(p => p.id).map(p => p.id);
      if (ids.length) db.markPrinted(ids).catch(e => console.error(e));

      // Download
      pdf.save(`impressao_${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (err) {
      alert("Erro ao gerar PDF: " + err.message);
      console.error(err);
    }
    setPdfGenerating(false);
  };

  const V = { "--bg": "#0f1117", "--card": "#181b24", "--inp": "#13151d", "--accent": "#e85d3a", "--t1": "#eaedf3", "--t2": "#7a8194", "--t3": "#4a5068", "--brd": "#262a38" };

  return (
    <div style={{ ...V, minHeight: "100vh", background: "var(--bg)", color: "var(--t1)", fontFamily: "'Outfit','Segoe UI',sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:6px}::-webkit-scrollbar-thumb{background:var(--brd);border-radius:3px}
        ::selection{background:var(--accent);color:#fff}
        textarea:focus,input:focus{outline:2px solid var(--accent);outline-offset:-1px}
        @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        .card-h:hover{transform:translateY(-2px);box-shadow:0 8px 32px rgba(0,0,0,.3);border-color:var(--accent)!important}
        .bp{background:var(--accent);color:#fff;border:none;padding:12px 24px;border-radius:10px;font-weight:600;cursor:pointer;font-family:inherit;font-size:14px;transition:all .2s;display:inline-flex;align-items:center;gap:8px}
        .bp:hover{background:#ff7b5c;transform:translateY(-1px);box-shadow:0 4px 16px rgba(232,93,58,.25)}
        .bp:disabled{opacity:.4;cursor:not-allowed;transform:none}
        .bs{background:var(--card);color:var(--t1);border:1px solid var(--brd);padding:10px 18px;border-radius:10px;font-weight:500;cursor:pointer;font-family:inherit;font-size:13px;transition:all .2s;display:inline-flex;align-items:center;gap:6px}
        .bs:hover{border-color:var(--accent);color:var(--accent)}
      `}</style>

      <header style={{ padding: "20px 32px", borderBottom: "1px solid var(--brd)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "linear-gradient(180deg,rgba(232,93,58,.06),transparent)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 42, height: 42, borderRadius: 12, background: "linear-gradient(135deg,#e85d3a,#ff9b7b)", display: "flex", alignItems: "center", justifyContent: "center" }}><I n="zap" s={22} /></div>
          <div><h1 style={{ fontSize: 20, fontWeight: 700 }}>Sticker Studio</h1><p style={{ fontSize: 12, color: "var(--t2)" }}>Personalização de Adesivos · Shopee</p></div>
        </div>
        <div style={{ display: "flex", gap: 4, background: "var(--card)", borderRadius: 12, padding: 4, border: "1px solid var(--brd)" }}>
          <Tab active={tab === "gallery"} onClick={() => setTab("gallery")} icon="grid" label="Modelos" />
          <Tab active={tab === "config"} onClick={() => setTab("config")} icon="settings" label="Configurar" />
          <Tab active={tab === "generate"} onClick={() => setTab("generate")} icon="list" label="Gerar" />
          <Tab active={tab === "preview"} onClick={() => setTab("preview")} icon="eye" label="Preview" />
          <Tab active={tab === "print"} onClick={() => setTab("print")} icon="printer" label={`Impressão${printQueue.length ? ` (${printQueue.length})` : ""}`} />
        </div>
      </header>

      <main style={{ padding: "24px 32px", maxWidth: 1400, margin: "0 auto" }}>
        {dbLoading && <div style={{ textAlign: "center", padding: 40, color: "var(--t2)" }}>Carregando dados...</div>}
        {/* GALLERY */}
        {tab === "gallery" && <div style={{ animation: "fadeIn .3s" }}>
          <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Galeria de Modelos</h2>
          <p style={{ color: "var(--t2)", fontSize: 14, marginBottom: 24 }}>Selecione para configurar</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: 16 }}>
            {models.map(m => (
              <div key={m.id} className="card-h" onClick={() => { setSelId(m.id); setTab("config"); }} style={{ background: "var(--card)", borderRadius: 14, border: `1px solid ${selId === m.id ? "var(--accent)" : "var(--brd)"}`, cursor: "pointer", overflow: "hidden", transition: "all .25s" }}>
                <div style={{ height: 130, background: m.thumbUrl ? `url(${m.thumbUrl}) center/cover` : "linear-gradient(135deg,#1e2230,#262a38)", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
                  {!m.thumbUrl && <I n="image" s={28} />}
                  {m.svgData && <div style={{ position: "absolute", top: 8, right: 8, background: "#34d399", borderRadius: 20, padding: "2px 8px", fontSize: 10, fontWeight: 700, color: "#000" }}>SVG</div>}
                </div>
                <div style={{ padding: "10px 14px" }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{m.id}</div>
                  <div style={{ fontSize: 11, color: "var(--t2)", marginTop: 2 }}>{m.fields.length > 0 ? `${m.fields.length} campos · ${m.fontFamily}` : "Sem SVG"}</div>
                </div>
              </div>
            ))}
          </div>
        </div>}

        {/* CONFIG */}
        {tab === "config" && <div style={{ animation: "fadeIn .3s" }}>
          {!sel ? <div style={{ textAlign: "center", padding: 60, color: "var(--t2)" }}><I n="settings" s={48} /><p style={{ marginTop: 16 }}>Selecione um modelo</p><button className="bp" style={{ marginTop: 16 }} onClick={() => setTab("gallery")}>Galeria</button></div>
          : <>
            <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
              <button className="bs" onClick={() => setTab("gallery")} style={{ padding: "8px 14px" }}>← Voltar</button>
              <div><h2 style={{ fontSize: 22, fontWeight: 700 }}>{sel.id}</h2><p style={{ color: "var(--t2)", fontSize: 13 }}>{sel.fields.length} campos · {sel.fontFamily} · {sel.fontSize}px</p></div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {/* Thumb */}
                <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 20 }}>
                  <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}><I n="image" s={18} /> Referência</h3>
                  {sel.thumbUrl && <img src={sel.thumbUrl} alt="" style={{ width: "100%", borderRadius: 10, marginBottom: 12, maxHeight: 200, objectFit: "contain", background: "#000" }} />}
                  <input ref={tRef} type="file" accept="image/*" onChange={onThumb} hidden />
                  <button className="bs" onClick={() => tRef.current?.click()} style={{ width: "100%" }}><I n="upload" s={16} /> {sel.thumbUrl ? "Trocar" : "Upload Imagem"}</button>
                </div>
                {/* SVG */}
                <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 20 }}>
                  <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
                    <I n="file" s={18} /> Arquivo SVG
                    {sel.svgData && <span style={{ padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600, background: "rgba(52,211,153,.15)", color: "#34d399", marginLeft: 8 }}>OK</span>}
                  </h3>
                  <input ref={fRef} type="file" accept=".svg" onChange={onSvg} hidden />
                  <button className="bp" onClick={() => fRef.current?.click()} style={{ width: "100%" }}><I n="upload" s={16} /> {sel.svgData ? "Substituir" : "Upload SVG do Corel"}</button>
                  {sel.svgData && sel.fields.length > 0 && (
                    <div style={{ marginTop: 12, padding: 12, background: "var(--bg)", borderRadius: 10, fontSize: 12 }}>
                      <div style={{ color: "var(--t2)", marginBottom: 6 }}>Campos detectados:</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {sel.fields.map(f => <span key={f.name} style={{ background: "rgba(232,93,58,.12)", color: "#ff7b5c", padding: "3px 10px", borderRadius: 6, fontSize: 11, fontFamily: "mono" }}>{f.name} {f.occurrences > 1 ? `(×${f.occurrences})` : ""}</span>)}
                      </div>
                    </div>
                  )}
                </div>
                {/* Font */}
                <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 20 }}>
                  <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}><I n="font" s={18} /> Fonte p/ medição</h3>
                  <div style={{ fontSize: 13, color: "var(--t2)", marginBottom: 12 }}>Atual: <b style={{ color: "var(--t1)" }}>{sel.fontFamily}</b> · {sel.fontSize}px</div>
                  <div style={{ fontSize: 11, color: "var(--t3)", marginBottom: 12 }}>A fonte no SVG usa glyphs embutidos. Para a medição de largura funcionar corretamente, carregue o .TTF da mesma fonte aqui.</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input ref={foRef} type="file" accept=".ttf,.otf,.woff,.woff2" onChange={onFont} hidden />
                    <button className="bs" onClick={() => foRef.current?.click()} style={{ flex: 1 }}><I n="upload" s={14} /> .TTF / .OTF</button>
                    <button className="bs" onClick={() => { const n = prompt("Google Font:"); if (n) { const l = document.createElement("link"); l.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(n)}&display=swap`; l.rel = "stylesheet"; document.head.appendChild(l); setTimeout(() => { upd(selId, { fontFamily: n, fontSource: "google" }); setFontOk(p => ({ ...p, [selId]: true })); }, 1000); } }} style={{ flex: 1 }}>Google Fonts</button>
                  </div>
                </div>
                {sel.svgData && <button className="bs" onClick={() => upd(selId, { svgData: null, svgUrl: null, fields: [], thumbUrl: null, glyphMap: {}, defaultAdv: 504, textCenters: {} })} style={{ color: "#f87171", borderColor: "rgba(248,113,113,.3)" }}><I n="trash" s={16} /> Resetar</button>}
              </div>
              <div>
                {sel.svgData ? <Calibration model={sel} onUpdate={upd} />
                : <div style={{ background: "var(--card)", borderRadius: 14, border: "1px dashed var(--brd)", padding: 40, textAlign: "center", minHeight: 300, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                    <I n="target" s={40} /><p style={{ color: "var(--t2)", marginTop: 16 }}>Upload do SVG para calibrar</p>
                  </div>}
              </div>
            </div>
          </>}
        </div>}

        {/* GENERATE */}
        {tab === "generate" && <div style={{ animation: "fadeIn .3s" }}>
          {!sel?.svgData ? <div style={{ textAlign: "center", padding: 60, color: "var(--t2)" }}><I n="pkg" s={48} /><p style={{ marginTop: 16 }}>Configure um modelo primeiro</p><button className="bp" style={{ marginTop: 16 }} onClick={() => setTab("gallery")}>Galeria</button></div>
          : <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 20 }}>
            <div>
              <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Gerar — {sel.id}</h2>
              <p style={{ color: "var(--t2)", fontSize: 13, marginBottom: 16 }}>Cole os nomes, um por linha</p>

              {/* Código do pedido + Loja */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
                <div style={{ background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 14, padding: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                    <I n="pkg" s={14} />
                    <span style={{ fontSize: 12, fontWeight: 600, color: "var(--t2)" }}>Pedido Shopee</span>
                  </div>
                  <input type="text" value={orderCode} onChange={e => setOrderCode(e.target.value)}
                    placeholder="Ex: 2503194XKHSDWV"
                    style={{ width: "100%", padding: "10px 14px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 10, color: "var(--t1)", fontSize: 15, fontFamily: "mono", fontWeight: 600, letterSpacing: 1 }}
                  />
                </div>
                <div style={{ background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 14, padding: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                    <I n="grid" s={14} />
                    <span style={{ fontSize: 12, fontWeight: 600, color: "var(--t2)" }}>Loja</span>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {STORES.map(s => (
                      <button key={s} onClick={() => setStore(s)} style={{
                        padding: "8px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer",
                        fontFamily: "inherit", transition: "all .15s",
                        border: store === s ? "2px solid var(--accent)" : "1px solid var(--brd)",
                        background: store === s ? "rgba(232,93,58,.15)" : "var(--inp)",
                        color: store === s ? "#ff7b5c" : "var(--t2)",
                      }}>{s}</button>
                    ))}
                  </div>
                </div>
              </div>

              <textarea value={names} onChange={e => setNames(e.target.value)} placeholder={"MARIA SILVA\nJOAO PEDRO DA SILVA\nANA CLARA\n..."} style={{ width: "100%", minHeight: 300, padding: 16, background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 14, color: "var(--t1)", fontSize: 14, fontFamily: "mono", lineHeight: 1.8, resize: "vertical", textTransform: "uppercase" }} />
              <button className="bp" onClick={gen} disabled={!nl.length} style={{ width: "100%", justifyContent: "center", padding: "14px", fontSize: 15, marginTop: 16 }}><I n="zap" s={18} /> Gerar Cartelas</button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 20 }}>
                {[{ l: "Nomes", v: nl.length, c: "#e85d3a" }, { l: "Campos/cartela", v: stats?.f || 0, c: "var(--t1)" }, { l: "Cartelas", v: stats?.s || 0, c: "#34d399" }, { l: "Vazios", v: stats?.e || 0, c: "#fbbf24" }].map((s, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: i < 3 ? "1px solid var(--brd)" : "none" }}>
                    <span style={{ fontSize: 13, color: "var(--t2)" }}>{s.l}</span>
                    <span style={{ fontSize: 22, fontWeight: 700, color: s.c, fontFamily: "mono" }}>{s.v}</span>
                  </div>
                ))}
              </div>
              {nl.length > 0 && <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 16, maxHeight: 400, overflow: "auto" }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--t2)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>Nomes</div>
                {nl.map((n, i) => {
                  const fs = fontOv[i] || sel.fontSize;
                  const tw = measureText(n, sel.fontFamily, fs);
                  const willBreak = tw > sel.maxWidth;
                  const hasOv = fontOv[i] !== undefined;
                  return (
                    <div key={i} style={{ padding: "6px 0", borderBottom: "1px solid var(--brd)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                        <span style={{ color: "var(--t3)", fontFamily: "mono", minWidth: 24 }}>{i + 1}.</span>
                        <span style={{ flex: 1, fontWeight: willBreak ? 600 : 400, color: willBreak && !hasOv ? "#fbbf24" : "var(--t1)" }}>{n}</span>
                        {willBreak && !hasOv && <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 8, background: "rgba(251,191,36,.15)", color: "#fbbf24", whiteSpace: "nowrap" }}>2 linhas</span>}
                        {hasOv && <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 8, background: "rgba(232,93,58,.15)", color: "#ff7b5c", whiteSpace: "nowrap" }}>{Math.round(fs)}px</span>}
                        <button onClick={() => {
                          if (hasOv) { setFontOv(p => { const c = { ...p }; delete c[i]; return c; }); }
                          else { setFontOv(p => ({ ...p, [i]: sel.fontSize })); }
                        }} style={{ background: "none", border: "none", cursor: "pointer", color: hasOv ? "#ff7b5c" : "var(--t3)", padding: 2, display: "flex" }}>
                          <I n={hasOv ? "target" : "settings"} s={14} />
                        </button>
                      </div>
                      {hasOv && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, paddingLeft: 30 }}>
                          <input type="range" min="200" max="1200" step="10" value={fs}
                            onChange={e => setFontOv(p => ({ ...p, [i]: parseInt(e.target.value) }))}
                            style={{ flex: 1, accentColor: "#e85d3a", height: 4 }}
                          />
                          <input type="number" value={Math.round(fs)}
                            onChange={e => setFontOv(p => ({ ...p, [i]: parseInt(e.target.value) || 200 }))}
                            style={{ width: 55, padding: "2px 4px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 4, color: "#ff7b5c", fontSize: 11, fontFamily: "mono", textAlign: "right" }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>}
            </div>
          </div>}
        </div>}

        {/* PREVIEW */}
        {tab === "preview" && <div style={{ animation: "fadeIn .3s" }}>
          {!sheets.length ? <div style={{ textAlign: "center", padding: 60, color: "var(--t2)" }}><I n="eye" s={48} /><p style={{ marginTop: 16 }}>Nenhuma cartela</p><button className="bp" style={{ marginTop: 16 }} onClick={() => setTab("generate")}>Gerar</button></div>
          : <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <div><h2 style={{ fontSize: 22, fontWeight: 700 }}>Cartelas</h2><p style={{ color: "var(--t2)", fontSize: 13 }}>{sheets.length} cartela(s) — {sel.id}</p></div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="bp" onClick={addToQueue} style={{ background: "#34d399", gap: 6 }}><I n="printer" s={16} /> Adicionar à fila ({sheets.length})</button>
                <button className="bp" onClick={dlZip}><I n="download" s={16} /> ZIP</button>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 20, overflowX: "auto" }}>
              {sheets.map((s, i) => <button key={i} onClick={() => setPi(i)} style={{ padding: "8px 18px", borderRadius: 10, border: "1px solid", borderColor: pi === i ? "var(--accent)" : "var(--brd)", background: pi === i ? "rgba(232,93,58,.12)" : "var(--card)", color: pi === i ? "#ff7b5c" : "var(--t2)", cursor: "pointer", fontFamily: "inherit", fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" }}>Cartela {s.i}{s.e > 0 && ` (${s.e} vazios)`}</button>)}
            </div>
            {sheets[pi] && <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <span style={{ fontWeight: 600 }}>Cartela {sheets[pi].i} — {sheets[pi].n.length} nome(s)</span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="bs" onClick={() => dlSvg(sheets[pi])}><I n="file" s={14} /> SVG</button>
                  <button className="bs" onClick={() => dlPng(sheets[pi])}><I n="printer" s={14} /> PNG</button>
                </div>
              </div>
              <div style={{ background: "#fff", borderRadius: 10, padding: 8, overflow: "auto", maxHeight: 600 }} dangerouslySetInnerHTML={{ __html: sheets[pi].svg.replace(/<svg/, '<svg style="width:100%;height:auto"') }} />
              <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 6 }}>
                {sheets[pi].n.map((n, i) => <span key={i} style={{ background: "rgba(232,93,58,.1)", color: "#ff7b5c", padding: "4px 10px", borderRadius: 6, fontSize: 11 }}>{n}</span>)}
                {Array.from({ length: sheets[pi].e }).map((_, i) => <span key={`e${i}`} style={{ background: "rgba(251,191,36,.1)", color: "#fbbf24", padding: "4px 10px", borderRadius: 6, fontSize: 11, fontStyle: "italic" }}>vazio</span>)}
              </div>
            </div>}
          </>}
        </div>}

        {/* PRINT QUEUE */}
        {tab === "print" && <div style={{ animation: "fadeIn .3s" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
            <div>
              <h2 style={{ fontSize: 22, fontWeight: 700 }}>Fila de Impressão</h2>
              <p style={{ color: "var(--t2)", fontSize: 13 }}>{printQueue.length} cartela(s) na fila</p>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {printQueue.length > 0 && <button className="bs" onClick={() => { setPrintQueue([]); db.clearPrintQueue().catch(e => console.error(e)); }} style={{ color: "#f87171", borderColor: "rgba(248,113,113,.3)" }}><I n="trash" s={14} /> Limpar</button>}
              <button className="bp" onClick={generatePdf} disabled={!printQueue.length || pdfGenerating} style={{ background: printQueue.length ? "#34d399" : undefined, padding: "12px 28px" }}>
                <I n="printer" s={18} /> {pdfGenerating ? "Gerando PDF..." : `Gerar PDF (${printQueue.length})`}
              </button>
            </div>
          </div>

          {printQueue.length === 0 ? (
            <div style={{ textAlign: "center", padding: 60, color: "var(--t2)" }}>
              <I n="printer" s={48} />
              <p style={{ marginTop: 16, fontSize: 16 }}>A fila está vazia</p>
              <p style={{ marginTop: 8, fontSize: 13, color: "var(--t3)", lineHeight: 1.6 }}>
                Personalize seus pedidos e clique em<br/><b style={{ color: "#34d399" }}>"Adicionar à fila"</b> na aba Preview.
              </p>
              <button className="bp" style={{ marginTop: 20 }} onClick={() => setTab("generate")}>Ir para Gerar</button>
            </div>
          ) : (<>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 12 }}>
              {printQueue.map((item, idx) => (
                <div key={idx} style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", overflow: "hidden" }}>
                  <div style={{ background: "#fff", padding: 4, height: 150, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}
                    dangerouslySetInnerHTML={{ __html: item.svg.replace(/<svg/, '<svg style="width:100%;height:auto;max-height:142px"') }} />
                  <div style={{ padding: "10px 12px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 13 }}>{item.label}</div>
                        <div style={{ fontSize: 10, color: "var(--t2)", marginTop: 2 }}>{item.store}{item.orderCode ? ` · ${item.orderCode}` : ""}</div>
                      </div>
                      <button onClick={() => removeFromQueue(idx)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--t3)", padding: 2, display: "flex", flexShrink: 0 }}>
                        <I n="trash" s={14} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Summary */}
            <div style={{ marginTop: 20, background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 20 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 14, color: "var(--t2)", textTransform: "uppercase", letterSpacing: 1 }}>Resumo</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
                {[
                  { l: "Cartelas", v: printQueue.length, c: "#e85d3a" },
                  { l: "Modelos", v: [...new Set(printQueue.map(p => p.model))].length, c: "var(--t1)" },
                  { l: "Lojas", v: [...new Set(printQueue.map(p => p.store))].length, c: "#34d399" },
                  { l: "Pedidos", v: [...new Set(printQueue.map(p => p.orderCode).filter(Boolean))].length || "—", c: "#fbbf24" },
                ].map((s, i) => (
                  <div key={i} style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 28, fontWeight: 700, color: s.c, fontFamily: "mono" }}>{s.v}</div>
                    <div style={{ fontSize: 11, color: "var(--t3)", marginTop: 4 }}>{s.l}</div>
                  </div>
                ))}
              </div>
            </div>
          </>)}
        </div>}
      </main>

      <footer style={{ padding: "16px 32px", borderTop: "1px solid var(--brd)", display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--t3)" }}>
        <span>Sticker Studio · Shopee</span>
        <span>{models.filter(m => m.svgData).length}/18 modelos</span>
      </footer>
    </div>
  );
}
