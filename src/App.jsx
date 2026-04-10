import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as db from "./lib/db";
import * as pdfjsLib from "pdfjs-dist";
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).href;

/* ─── constants ─── */
const defaultModel = (id, displayName) => ({
  id,
  displayName: displayName || null,
  thumbUrl: null, svgData: null, svgUrl: null,
  fields: [],
  maxWidth: 3600,
  fontFamily: "DK Coal Brush",
  fontSize: 715.51,
  fontSource: "default",
  glyphMap: {}, defaultAdv: 504, textCenters: {},
  fieldTypes: [], fieldPerType: {}, allGlyphMaps: {},
});
const MODELS = [
  defaultModel("DICIO_5X5_PR", "DICIO 5X5 PR"),
  defaultModel("DICIO_5X5_TR", "DICIO 5X5 TR"),
  defaultModel("DICIO_7X7_PR", "DICIO 7X7 PR"),
  defaultModel("DICIO_7X7", "DICIO 7X7"),
  ...Array.from({ length: 31 }, (_, i) => defaultModel(`MOD${String(i + 1).padStart(3, "0")}`)),
];
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

  // Detect fnt class PER FIELD for multi-type layouts
  const fieldFntMap = {}; // { campo_nome_1: "fnt1", campo_nome_2: "fnt0", ... }
  for (const f of fields) {
    // Try both attribute orders: id before class, and class before id
    const re1 = new RegExp(`<text[^>]*id="${f.name}"[^>]*class="([^"]*)"`);
    const re2cls = new RegExp(`<text[^>]*class="([^"]*)"[^>]*id="${f.name}"`);
    const pm = svgText.match(re1) || svgText.match(re2cls);
    const cls = pm ? pm[1] : "";
    const fntMatch = cls.match(/fnt(\d+)/);
    fieldFntMap[f.name] = fntMatch ? `fnt${fntMatch[1]}` : "fnt0";
  }

  // Extract font-size per fnt class
  const fntSizeMap = {}; // { "fnt0": 278.95, "fnt1": 445, ... }
  const fntFamilyMap = {}; // { "fnt0": "Times New Roman", ... }
  const allFntClasses = [...new Set(Object.values(fieldFntMap))];
  for (const cls of allFntClasses) {
    const fsRe = new RegExp(`\\.${cls}\\s*\\{[^}]*font-size:\\s*([0-9.]+)px`);
    const fsMatch = svgText.match(fsRe);
    fntSizeMap[cls] = fsMatch ? parseFloat(fsMatch[1]) : 715.51;
    const ffRe = new RegExp(`\\.${cls}\\s*\\{[^}]*font-family:\\s*'([^']+)'`);
    const ffMatch = svgText.match(ffRe);
    fntFamilyMap[cls] = ffMatch ? ffMatch[1] : "DK Coal Brush";
  }

  // Use the first field's font as the "primary" font
  const primaryFnt = fieldFntMap[fields[0]?.name] || "fnt0";
  const fontSize = fntSizeMap[primaryFnt] || 715.51;
  const fontFamily = fntFamilyMap[primaryFnt] || "DK Coal Brush";

  // Detect field types: group by font-size to find repeating pattern
  // Each unique font-size = a "type" (e.g., title, subtitle, phrase)
  const fieldPerType = {}; // { fieldName: typeIndex }
  const uniqueSizes = [...new Set(fields.map(f => fntSizeMap[fieldFntMap[f.name]]))];
  // Determine group size (how many types per sticker)
  const groupSize = uniqueSizes.length > 1 ? uniqueSizes.length : 1;

  // If multiple types exist, assign type by position within repeating group
  const fieldTypes = []; // Array of { label, fontSize, maxWidth, fontFamily, fieldNames[] }
  if (groupSize > 1) {
    // Detect the repeating pattern from the first N fields
    const pattern = [];
    const seen = new Map();
    for (let i = 0; i < Math.min(fields.length, groupSize * 2); i++) {
      const sz = fntSizeMap[fieldFntMap[fields[i].name]];
      if (!seen.has(sz) && pattern.length < groupSize) {
        seen.set(sz, pattern.length);
        pattern.push(sz);
      }
    }
    // Create type configs
    for (let t = 0; t < groupSize; t++) {
      const sz = pattern[t];
      const cls = allFntClasses.find(c => fntSizeMap[c] === sz) || primaryFnt;
      const fNames = fields.filter((_, i) => i % groupSize === t).map(f => f.name);
      fieldTypes.push({
        label: `Tipo ${t + 1}`,
        fontSize: sz,
        origFontSize: sz,
        maxWidth: 3600,
        fontFamily: fntFamilyMap[cls] || fontFamily,
        fieldNames: fNames,
      });
      fNames.forEach(fn => { fieldPerType[fn] = t; });
    }
  } else {
    // Single type — all fields share same config
    fields.forEach(f => { fieldPerType[f.name] = 0; });
    fieldTypes.push({
      label: "Tipo 1",
      fontSize,
      origFontSize: fontSize,
      maxWidth: 3600,
      fontFamily,
      fieldNames: fields.map(f => f.name),
    });
  }

  // Extract ALL glyph maps from ALL fonts used
  const allGlyphMaps = {}; // { fontFamily: { glyphMap, defaultAdv } }
  const processedFonts = new Set();
  for (const ff of [...new Set(Object.values(fntFamilyMap))]) {
    if (processedFonts.has(ff)) continue;
    processedFonts.add(ff);
    const fontFaceRe = new RegExp(`font-family:"${ff.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^}]*src:url\\("#(\\w+)"\\)`, "i");
    const fontFaceMatch = svgText.match(fontFaceRe);
    const targetFontId = fontFaceMatch ? fontFaceMatch[1] : "FontID0";
    const defaultAdvRe = new RegExp(`id="${targetFontId}"[^>]*horiz-adv-x="(\\d+)"`);
    const defaultAdvMatch = svgText.match(defaultAdvRe);
    const defAdv = defaultAdvMatch ? parseInt(defaultAdvMatch[1]) : 504;
    const fontStartIdx = svgText.indexOf(`id="${targetFontId}"`);
    const fontEndIdx = svgText.indexOf("</font>", fontStartIdx);
    const fontSection = fontStartIdx >= 0 && fontEndIdx >= 0 ? svgText.substring(fontStartIdx, fontEndIdx) : svgText;
    const gMap = {};
    const glyphRe = /<glyph\s+unicode="(.)"[^>]*horiz-adv-x="(\d+)"/g;
    let gm;
    while ((gm = glyphRe.exec(fontSection)) !== null) gMap[gm[1]] = parseInt(gm[2]);
    allGlyphMaps[ff] = { glyphMap: gMap, defaultAdv: defAdv };
  }

  // Use primary font glyph map as the main one (for backward compat)
  const primaryGlyphs = allGlyphMaps[fontFamily] || { glyphMap: {}, defaultAdv: 504 };
  const glyphMap = primaryGlyphs.glyphMap;
  const defaultAdv = primaryGlyphs.defaultAdv;

  // Detect sticker boundary shapes (rects and circles) to find true center of each sticker area
  const containers = []; // [{cx, cy, x, y, w, h, type}]
  // Rectangles
  const rectRe = /<rect[^>]*\bx="([^"]*)"[^>]*\by="([^"]*)"[^>]*\bwidth="([^"]*)"[^>]*\bheight="([^"]*)"/g;
  let rm;
  while ((rm = rectRe.exec(svgText)) !== null) {
    const rx = parseFloat(rm[1]), ry = parseFloat(rm[2]), rw = parseFloat(rm[3]), rh = parseFloat(rm[4]);
    if (rw > 500 && rh > 500) containers.push({ x: rx, y: ry, w: rw, h: rh, cx: rx + rw / 2, cy: ry + rh / 2, type: "rect" });
  }
  // Circles — deduplicate by center (CorelDraw often doubles circles for stroke+fill)
  const circRe = /<circle[^>]*\bcx="([^"]*)"[^>]*\bcy="([^"]*)"[^>]*\br="([^"]*)"/g;
  const seenCircles = new Set();
  while ((rm = circRe.exec(svgText)) !== null) {
    const cx = parseFloat(rm[1]), cy = parseFloat(rm[2]), r = parseFloat(rm[3]);
    if (r > 200) {
      const key = `${Math.round(cx)}_${Math.round(cy)}`;
      if (!seenCircles.has(key)) {
        seenCircles.add(key);
        containers.push({ x: cx - r, y: cy - r, w: r * 2, h: r * 2, cx, cy, type: "circle" });
      }
    }
  }

  // If we have one big rect + multiple circles, filter out the big rect (it's the page border)
  const circles = containers.filter(c => c.type === "circle");
  const rects = containers.filter(c => c.type === "rect");
  const shapes = circles.length >= fields.length ? circles : (rects.length > 1 ? rects : containers);

  // Compute text centers: use containing shape center if found, else fallback to glyph measurement
  const measureW = (text, ff, fs) => {
    const g = allGlyphMaps[ff] || primaryGlyphs;
    let t = 0;
    for (const ch of text) t += (g.glyphMap[ch] || g.defaultAdv);
    return t * fs / 1000;
  };

  const textCenters = {};
  for (const f of fields) {
    const fx = f.positions[0].x;
    const fy = f.positions[0].y;
    // Find closest shape whose center is nearest to this field
    let best = null, bestDist = Infinity;
    for (const s of shapes) {
      const dx = fx - s.cx, dy = fy - s.cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < bestDist) { bestDist = dist; best = s; }
    }
    if (best && bestDist < best.w) {
      textCenters[f.name] = best.cx;
    } else {
      // Fallback: glyph-based center
      const fntCls = fieldFntMap[f.name];
      const ff = fntFamilyMap[fntCls] || fontFamily;
      const fs = fntSizeMap[fntCls] || fontSize;
      const w = measureW(f.positions[0].content, ff, fs);
      textCenters[f.name] = fx + w / 2;
    }
  }

  return { fields, fontSize, fontFamily, glyphMap, defaultAdv, textCenters, fieldTypes, fieldPerType, allGlyphMaps };
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
const injectNames = (svgText, namesList, model, fontOverrides = {}, posOverrides = {}) => {
  let svg = svgText;
  const fieldNames = model.fields.map(f => f.name);
  const gm = model.glyphMap || {};
  const da = model.defaultAdv || 504;
  const tc = model.textCenters || {};
  const ft = model.fieldTypes || [];
  const fpt = model.fieldPerType || {};
  const agm = model.allGlyphMaps || {};

  fieldNames.forEach((fieldName, idx) => {
    const name = idx < namesList.length ? namesList[idx] : "";
    // Get per-type config if available
    const typeIdx = fpt[fieldName] !== undefined ? fpt[fieldName] : 0;
    const typeConfig = ft[typeIdx] || {};
    const typeFontSize = typeConfig.fontSize || model.fontSize;
    const typeMaxWidth = typeConfig.maxWidth || model.maxWidth;
    const typeFontFamily = typeConfig.fontFamily || model.fontFamily;
    const origFontSize = typeConfig.origFontSize || typeFontSize;

    const fieldFontSize = fontOverrides[idx] !== undefined ? fontOverrides[idx] : typeFontSize;
    const fieldMaxWidth = typeMaxWidth;
    const lines = breakLines(name, typeFontFamily, fieldFontSize, fieldMaxWidth);
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

    // Text area center for this field — from sticker rect center or template measurement
    const xOffset = posOverrides[idx] || 0;
    const centerX = (tc[fieldName] || (firstPos.x + 1500)) + xOffset;

    // Use text-anchor="middle" for precise browser-native centering
    let replacement;
    if (lines.length === 1) {
      replacement = `<text x="${centerX.toFixed(2)}" y="${baseY}" id="${fieldName}" class="${cls}" text-anchor="middle"${sizeStyle}>${esc(lines[0])}</text>`;
    } else {
      const lineSpacing = fieldFontSize * 0.95;
      const totalHeight = lineSpacing * (lines.length - 1);
      const startY = baseY - totalHeight / 2;
      replacement = lines.map((line, li) => {
        return `<text x="${centerX.toFixed(2)}" y="${(startY + li * lineSpacing).toFixed(2)}" id="${fieldName}" class="${cls}" text-anchor="middle"${sizeStyle}>${esc(line)}</text>`;
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
    // Clamp canvas to safe max (browser limit ~16384, but some fail above 8000)
    const maxCanvasDim = 8000;
    const rawMax = Math.max(w, h) * scale;
    if (rawMax > maxCanvasDim) scale = maxCanvasDim / Math.max(w, h);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d");
    const img = new Image();
    const blob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(b => {
        if (b) return resolve(b);
        // Fallback: try JPEG if PNG fails
        canvas.toBlob(b2 => b2 ? resolve(b2) : reject(new Error("Canvas toBlob returned null")), "image/jpeg", 0.95);
      }, "image/png");
    };
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
    clipboard: <><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></>,
    copy: <><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></>,
    alert: <><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></>,
    edit: <><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></>,
    layout: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="4" rx="1"/><rect x="14" y="10" width="7" height="4" rx="1"/><rect x="3" y="13" width="7" height="8" rx="1"/><rect x="14" y="17" width="7" height="4" rx="1"/></>,
    pkg: <><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></>,
    help: <><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></>,
  };
  return <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{d[n]}</svg>;
};

const Tab = ({ active, onClick, icon, label }) => (
  <button onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 20px", background: active ? "var(--accent)" : "transparent", color: active ? "#fff" : "var(--t2)", border: "none", borderRadius: 10, cursor: "pointer", fontWeight: 600, fontSize: 14, transition: "all .2s", fontFamily: "inherit" }}>
    <I n={icon} s={18} />{label}
  </button>
);

/* ── Calibration ── */
const TYPE_COLORS = ["#e85d3a", "#34d399", "#a78bfa", "#fbbf24", "#f472b6"];

const Calibration = ({ model, onUpdate }) => {
  const [test, setTest] = useState("JOAO PEDRO DA SILVA");
  const ft = model.fieldTypes || [];
  const hasMultiTypes = ft.length > 1;

  // State for each type: { 0: { tw, tf }, 1: { tw, tf }, ... }
  const [typeConfigs, setTypeConfigs] = useState(() => {
    const cfg = {};
    ft.forEach((t, i) => { cfg[i] = { tw: t.maxWidth || model.maxWidth, tf: t.fontSize || model.fontSize }; });
    if (!ft.length) cfg[0] = { tw: model.maxWidth, tf: model.fontSize };
    return cfg;
  });
  useEffect(() => {
    const cfg = {};
    ft.forEach((t, i) => { cfg[i] = { tw: t.maxWidth || model.maxWidth, tf: t.fontSize || model.fontSize }; });
    if (!ft.length) cfg[0] = { tw: model.maxWidth, tf: model.fontSize };
    setTypeConfigs(cfg);
  }, [model.id, model.maxWidth, model.fontSize, ft.length]);

  const setTc = (idx, key, val) => setTypeConfigs(p => ({ ...p, [idx]: { ...p[idx], [key]: val } }));

  // Preview with current slider values
  const preview = useMemo(() => {
    if (!model.svgData) return null;
    const previewTypes = ft.map((t, i) => ({ ...t, fontSize: typeConfigs[i]?.tf || t.fontSize, maxWidth: typeConfigs[i]?.tw || t.maxWidth }));
    const previewModel = { ...model, fieldTypes: previewTypes };
    if (!hasMultiTypes) {
      previewModel.fontSize = typeConfigs[0]?.tf || model.fontSize;
      previewModel.maxWidth = typeConfigs[0]?.tw || model.maxWidth;
      if (previewModel.fieldTypes[0]) {
        previewModel.fieldTypes[0].fontSize = previewModel.fontSize;
        previewModel.fieldTypes[0].maxWidth = previewModel.maxWidth;
      }
    }
    const names = model.fields.map((_, i) => i === 0 ? test : "");
    return injectNames(model.svgData, names, previewModel);
  }, [model, test, typeConfigs]);

  const dirty = ft.some((t, i) => {
    const c = typeConfigs[i];
    return c && (c.tw !== (t.maxWidth || model.maxWidth) || c.tf !== (t.fontSize || model.fontSize));
  }) || (!ft.length && (typeConfigs[0]?.tw !== model.maxWidth || typeConfigs[0]?.tf !== model.fontSize));

  const handleApply = () => {
    if (hasMultiTypes) {
      const updatedTypes = ft.map((t, i) => ({
        ...t,
        fontSize: typeConfigs[i]?.tf || t.fontSize,
        maxWidth: typeConfigs[i]?.tw || t.maxWidth,
      }));
      onUpdate(model.id, { fieldTypes: updatedTypes, fontSize: updatedTypes[0].fontSize, maxWidth: updatedTypes[0].maxWidth });
    } else {
      const c = typeConfigs[0];
      const updatedTypes = ft.length ? [{ ...ft[0], fontSize: c.tf, maxWidth: c.tw }] : [];
      onUpdate(model.id, { maxWidth: c.tw, fontSize: c.tf, fieldTypes: updatedTypes });
    }
  };

  const renderTypeSliders = (idx, label, fontFamily, origFontSize, color) => {
    const c = typeConfigs[idx] || { tw: 3600, tf: origFontSize };
    const textW = measureText(test, fontFamily, c.tf);
    const lines = breakLines(test, fontFamily, c.tf, c.tw);
    const fits = textW <= c.tw;
    return (
      <div key={idx} style={{ background: "var(--card)", borderRadius: 14, border: `1px solid ${color}33`, padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: color, display: "inline-block" }} />
            {label}
            <span style={{ fontSize: 11, color: "var(--t3)", fontWeight: 400 }}>· {fontFamily} · {Math.round(origFontSize)}px</span>
          </h3>
          <span style={{ padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600, background: fits ? "rgba(52,211,153,.12)" : lines.length > 1 ? "rgba(251,191,36,.12)" : "rgba(248,113,113,.12)", color: fits ? "#34d399" : lines.length > 1 ? "#fbbf24" : "#f87171" }}>
            {fits ? "1 linha" : lines.length > 1 ? `${lines.length} linhas` : "Excede"}
          </span>
        </div>

        {/* Progress bar */}
        <div style={{ background: "var(--bg)", borderRadius: 10, padding: 10, marginTop: 10, marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--t2)", marginBottom: 4 }}>
            <span>Texto: <b style={{ color: "var(--t1)", fontFamily: "mono" }}>{Math.round(textW)}</b></span>
            <span>Limite: <b style={{ color, fontFamily: "mono" }}>{c.tw}</b></span>
          </div>
          <div style={{ height: 6, background: "var(--brd)", borderRadius: 3, overflow: "hidden" }}>
            <div style={{ height: "100%", borderRadius: 3, transition: "width .15s", width: `${Math.min(100, (textW / c.tw) * 100)}%`, background: fits ? "#34d399" : lines.length > 1 ? "#fbbf24" : "#f87171" }} />
          </div>
          {lines.length > 1 && (
            <div style={{ marginTop: 6, fontSize: 10, color: "#fbbf24" }}>
              {lines.map((l, i) => <div key={i}>↳ Linha {i + 1}: "{l}"</div>)}
            </div>
          )}
        </div>

        {/* Sliders */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
            <label style={{ fontSize: 11, color: "var(--t2)" }}>Largura máxima</label>
            <input type="number" value={c.tw} onChange={e => setTc(idx, "tw", parseInt(e.target.value) || 100)} style={{ width: 70, padding: "2px 6px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 6, color, fontSize: 12, fontFamily: "mono", textAlign: "right" }} />
          </div>
          <input type="range" min="500" max="8000" step="50" value={c.tw} onChange={e => setTc(idx, "tw", parseInt(e.target.value))} style={{ width: "100%", accentColor: color }} />
        </div>
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
            <label style={{ fontSize: 11, color: "var(--t2)" }}>Tamanho fonte</label>
            <input type="number" value={Math.round(c.tf)} onChange={e => setTc(idx, "tf", parseFloat(e.target.value) || 50)} style={{ width: 70, padding: "2px 6px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 6, color, fontSize: 12, fontFamily: "mono", textAlign: "right" }} />
          </div>
          <input type="range" min="50" max="1500" step="5" value={c.tf} onChange={e => setTc(idx, "tf", parseFloat(e.target.value))} style={{ width: "100%", accentColor: color }} />
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Test input */}
      <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 20 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}><I n="target" s={18} /> Calibração Visual</h3>
        <p style={{ fontSize: 12, color: "var(--t3)", marginBottom: 10 }}>
          {hasMultiTypes ? `${ft.length} tipos de campo detectados. Ajuste cada tipo separadamente.` : "Digite um nome longo. Ajuste o slider até caber na moldura."}
        </p>
        <input type="text" value={test} onChange={e => setTest(e.target.value)} placeholder="Joao Pedro da Silva" style={{ width: "100%", padding: "10px 14px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 10, color: "var(--t1)", fontSize: 14, fontFamily: "inherit" }} />
        <div style={{ fontSize: 11, color: "var(--t3)", marginTop: 8 }}>
          Campos: <b style={{ color: "var(--t1)" }}>{model.fields.length}</b>
          {hasMultiTypes && <> · <b style={{ color: "var(--t1)" }}>{ft.length} tipos</b> × <b style={{ color: "var(--t1)" }}>{Math.round(model.fields.length / ft.length)} campos/tipo</b></>}
        </div>
      </div>

      {/* Type sliders */}
      {hasMultiTypes ? ft.map((t, i) => renderTypeSliders(
        i,
        `${t.label} (${t.fieldNames?.length || 0} campos)`,
        t.fontFamily,
        t.origFontSize || t.fontSize,
        TYPE_COLORS[i % TYPE_COLORS.length]
      )) : renderTypeSliders(0, "Calibração", model.fontFamily, model.fontSize, "#e85d3a")}

      {/* Apply button */}
      {dirty && (
        <button onClick={handleApply} style={{ width: "100%", background: "#e85d3a", color: "#fff", border: "none", padding: "14px", borderRadius: 10, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <I n="check" s={16} /> Aplicar Calibração
        </button>
      )}

      {/* Preview */}
      {preview && (
        <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 20 }}>
          <div style={{ fontSize: 12, color: "var(--t2)", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}><I n="eye" s={14} /> Preview ao vivo</div>
          <div style={{ background: "#fff", borderRadius: 10, padding: 6, overflow: "auto", maxHeight: 400, border: "2px solid var(--brd)" }}
            dangerouslySetInnerHTML={{ __html: preview.replace(/<svg/, '<svg style="width:100%;height:auto"') }} />
        </div>
      )}
    </div>
  );
};

/* ═══ App ═══ */
/* ─── Login Screen ─── */
const DEFAULT_USERS = { admin: { pass: "Vinishow434!", role: "admin" } };
const getUsers = () => JSON.parse(localStorage.getItem("ss_users") || JSON.stringify(DEFAULT_USERS));
const saveUsers = (u) => localStorage.setItem("ss_users", JSON.stringify(u));

function LoginScreen({ onLogin }) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [error, setError] = useState("");
  const V = { "--bg": "#0f1117", "--card": "#181b24", "--inp": "#13151d", "--accent": "#e85d3a", "--t1": "#eaedf3", "--t2": "#7a8194", "--t3": "#4a5068", "--brd": "#262a38" };

  const handleLogin = (e) => {
    e.preventDefault();
    if (!user.trim() || !pass.trim()) { setError("Preencha todos os campos"); return; }
    const users = getUsers();
    const u = users[user.trim()];
    if (u && u.pass === pass) {
      localStorage.setItem("ss_session", JSON.stringify({ user: user.trim(), role: u.role, ts: Date.now() }));
      onLogin(user.trim());
    } else {
      setError("Usuário ou senha incorretos");
    }
  };

  return (
    <div style={{ ...V, minHeight: "100vh", background: "var(--bg)", color: "var(--t1)", fontFamily: "'Outfit','Segoe UI',sans-serif", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0}textarea:focus,input:focus{outline:2px solid var(--accent);outline-offset:-1px}@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}`}</style>
      <div style={{ animation: "fadeIn .5s", width: 400, background: "var(--card)", borderRadius: 20, border: "1px solid var(--brd)", padding: 40, textAlign: "center" }}>
        <div style={{ width: 64, height: 64, borderRadius: 16, background: "linear-gradient(135deg,#e85d3a,#ff9b7b)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
          <I n="zap" s={32} />
        </div>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Sticker Studio</h1>
        <p style={{ color: "var(--t2)", fontSize: 13, marginBottom: 32 }}>Personalização de Adesivos · Shopee</p>
        <form onSubmit={handleLogin}>
          <input value={user} onChange={e => { setUser(e.target.value); setError(""); }} placeholder="Usuário"
            style={{ width: "100%", padding: "14px 16px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 10, color: "var(--t1)", fontSize: 14, fontFamily: "inherit", marginBottom: 12 }} />
          <input value={pass} onChange={e => { setPass(e.target.value); setError(""); }} placeholder="Senha" type="password"
            style={{ width: "100%", padding: "14px 16px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 10, color: "var(--t1)", fontSize: 14, fontFamily: "inherit", marginBottom: 16 }} />
          {error && <p style={{ color: "#f87171", fontSize: 13, marginBottom: 12 }}>{error}</p>}
          <button type="submit" style={{ width: "100%", background: "var(--accent)", color: "#fff", border: "none", padding: "14px", borderRadius: 10, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", fontSize: 15, transition: "all .2s" }}
            onMouseEnter={e => e.currentTarget.style.background = "#ff7b5c"} onMouseLeave={e => e.currentTarget.style.background = "var(--accent)"}>
            Entrar
          </button>
        </form>
      </div>
    </div>
  );
}

export default function App() {
  const [loggedUser, setLoggedUser] = useState(() => {
    const s = localStorage.getItem("ss_session");
    if (s) { try { return JSON.parse(s).user; } catch { return null; } }
    return null;
  });
  const isAdmin = (() => {
    const s = localStorage.getItem("ss_session");
    if (s) { try { return JSON.parse(s).role === "admin"; } catch { return false; } }
    return false;
  })();
  const [showUserMgmt, setShowUserMgmt] = useState(false);
  const [models, setModels] = useState(MODELS);
  const [selId, setSelId] = useState(null);
  const [tab, setTab] = useState("gallery");
  const [names, setNames] = useState("");
  const [typeNames, setTypeNames] = useState({}); // { 0: "text\ntext", 1: "text\ntext", ... } for multi-type models
  const [sheets, setSheets] = useState([]);
  const [pi, setPi] = useState(0);
  const [fontOk, setFontOk] = useState({});
  const [fontOv, setFontOv] = useState({}); // {nameIndex: customFontSize}
  const [posOv, setPosOv] = useState({}); // {nameIndex: xOffset} manual horizontal offset
  const fontBytesRef = useRef({}); // {modelId: Uint8Array} font bytes in memory for PDF
  const [orderCode, setOrderCode] = useState(""); // codigo do pedido Shopee
  const [store, setStore] = useState(STORES[0]); // loja selecionada
  const [printQueue, setPrintQueue] = useState([]); // [{id, svg, label, store, orderCode, model, timestamp}]
  const [pdfGenerating, setPdfGenerating] = useState(false);
  const [dbLoading, setDbLoading] = useState(true);
  const [pedidos, setPedidos] = useState([]); // [{id, pedido, remetente, envio, modelo, quantidade, feito, criadoEm}]
  const [pedidosParsing, setPedidosParsing] = useState(false);
  const [layoutFiles, setLayoutFiles] = useState([]); // [{name, bytes, width, height}]
  const [layoutResults, setLayoutResults] = useState([]); // [{name, blob, widthMm, heightMm, items}]
  const [layoutProcessing, setLayoutProcessing] = useState(false);
  const [layoutLimit, setLayoutLimit] = useState(1000); // limite em mm
  // Cartela builder state
  const [cartela, setCartela] = useState({
    sheetW: 110, sheetH: 170, // folha mm
    stickerW: 50, stickerH: 20, // etiqueta mm
    marginTop: 25, marginBottom: 25, marginLeft: 5, marginRight: 5,
    gapX: 0, gapY: 0, // espaçamento entre etiquetas
    safeMargin: 2, // margem de segurança interna mm
    artUrl: null, artData: null, // arte carregada
    artScale: 100, artOffX: 0, artOffY: 0, // ajuste da arte
    cutColor: "#EC2A90", cutWidth: 0.15, // cor/espessura cutcontour
    borderColor: "#373435", borderWidth: 0.4, // cor/espessura borda
    wantedQty: 0, // 0 = auto (máximo possível)
    printLimit: 1000, printResults: [], printProcessing: false, generatedPdfs: [],
    orderCode: "", store: STORES[0], shape: "rect", // "rect" ou "circle"
  });
  const fRef = useRef(null), tRef = useRef(null), foRef = useRef(null);

  const sel = models.find(m => m.id === selId);

  // Load from Supabase on mount
  useEffect(() => {
    (async () => {
      try {
        const [dbModels, queue, dbOrders] = await Promise.all([
          db.fetchModels(),
          db.fetchPrintQueue(),
          db.fetchOrders(200),
        ]);
        setModels(prev => prev.map(d => {
          const remote = dbModels.find(r => r.id === d.id);
          return remote ? { ...d, ...remote } : d;
        }));
        setPrintQueue(queue);
        if (dbOrders.length) setPedidos(dbOrders.map(o => ({
          id: o.id, pedido: o.orderCode, remetente: o.store, envio: o.names?.[0] || "",
          modelo: o.fontOverrides?.modelo || "", quantidade: o.sheetsCount || 0,
          feito: o.fontOverrides?.feito || false, semArte: o.fontOverrides?.semArte || false,
          skus: o.fontOverrides?.skus || null, criadoEm: o.createdAt,
        })));
      } catch (e) {
        console.error("Erro ao carregar do Supabase:", e);
      }
      setDbLoading(false);
    })();
  }, []);

  // Load SVG data on demand when a model is selected — always re-analyze for accurate centers
  useEffect(() => {
    if (!sel || sel.svgData || !sel.svgUrl) return;
    (async () => {
      try {
        const svgText = await db.downloadSvg(sel.svgUrl);
        const analysis = analyzeSvg(svgText);
        // Merge: keep user-calibrated values (maxWidth, fontSize overrides) but update centers & types
        const merged = { svgData: svgText, textCenters: analysis.textCenters, fieldTypes: analysis.fieldTypes, fieldPerType: analysis.fieldPerType, allGlyphMaps: analysis.allGlyphMaps };
        // If no fields were stored yet, also update fields/fonts
        if (!sel.fields || sel.fields.length === 0) Object.assign(merged, analysis);
        setModels(p => p.map(m => m.id === sel.id ? { ...m, ...merged } : m));
        // Persist updated analysis
        const dbUp = { ...merged }; delete dbUp.svgData;
        db.updateModel(sel.id, dbUp).catch(e => console.error("Erro ao atualizar modelo:", e));
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
      const { fields, fontSize, fontFamily, glyphMap, defaultAdv, textCenters, fieldTypes, fieldPerType, allGlyphMaps } = analyzeSvg(svg);
      const modelData = { svgData: svg, fields, fontSize, fontFamily, glyphMap, defaultAdv, textCenters, fieldTypes, fieldPerType, allGlyphMaps };
      // Upload to Supabase Storage
      try {
        const svgUrl = await db.uploadSvg(selId, svg);
        upd(selId, { ...modelData, svgUrl });
      } catch (err) {
        console.error("Erro ao upload SVG:", err);
        upd(selId, modelData);
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
      try {
        const fontBytes = new Uint8Array(ev.target.result);
        const fc = new FontFace(nm, fontBytes.buffer); await fc.load(); document.fonts.add(fc);
        // Keep font bytes in memory for PDF generation
        fontBytesRef.current[selId] = fontBytes;
        // Upload font to Supabase Storage for persistence
        const fontUrl = await db.uploadFont(selId, ev.target.result, f.name);
        upd(selId, { fontFamily: nm, fontSource: "file", fontUrl });
        setFontOk(p => ({ ...p, [selId]: true }));
      } catch (err) { alert("Erro: " + err.message); }
    };
    r.readAsArrayBuffer(f); e.target.value = "";
  };

  const isMultiType = sel?.fieldTypes?.length > 1;
  const groupSize = isMultiType ? sel.fieldTypes.length : 1;

  // For multi-type: parse each type's textarea into lines
  const typeLists = useMemo(() => {
    if (!isMultiType) return {};
    const result = {};
    for (let t = 0; t < groupSize; t++) {
      result[t] = (typeNames[t] || "").split("\n").map(n => n.trim()).filter(Boolean);
    }
    return result;
  }, [isMultiType, groupSize, typeNames]);

  // For multi-type: interleave names (type0[0], type1[0], type2[0], type0[1], type1[1], type2[1], ...)
  // For single-type: just split by newlines as before
  const nl = useMemo(() => {
    if (!isMultiType) return names.split("\n").map(n => n.trim()).filter(Boolean);
    const maxLen = Math.max(0, ...Object.values(typeLists).map(l => l.length));
    const result = [];
    for (let i = 0; i < maxLen; i++) {
      for (let t = 0; t < groupSize; t++) {
        result.push(typeLists[t]?.[i] || "");
      }
    }
    return result;
  }, [isMultiType, names, typeLists, groupSize]);

  const stats = useMemo(() => {
    if (!sel) return null;
    const f = sel.fields.length || 1;
    if (isMultiType) {
      // Count stickers = max lines across types
      const stickers = Math.max(0, ...Object.values(typeLists).map(l => l.length));
      const fieldsPerSheet = f; // all fields in one sheet
      const stickersPerSheet = fieldsPerSheet / groupSize;
      const sheets = stickers > 0 ? Math.ceil(stickers / stickersPerSheet) : 0;
      const totalNames = Object.values(typeLists).reduce((s, l) => s + l.length, 0);
      return { t: totalNames, s: sheets, f, e: sheets > 0 ? sheets * stickersPerSheet * groupSize - nl.filter(Boolean).length : 0, stickers };
    }
    const t = nl.length, s = t > 0 ? Math.ceil(t / f) : 0;
    return { t, s, f, e: s > 0 ? s * f - t : 0 };
  }, [sel, nl, isMultiType, typeLists, groupSize]);

  const gen = () => {
    if (!sel?.svgData || !sel.fields.length || (!nl.length && !nl.some(Boolean))) return;
    if (isMultiType && !Object.values(typeLists).some(l => l.length > 0)) return;
    const fps = sel.fields.length;
    const res = [];
    for (let i = 0; i < Math.ceil(nl.length / fps); i++) {
      const sn = nl.slice(i * fps, (i + 1) * fps);
      // Remap fontOverrides & posOverrides: global name index → per-sheet field index
      const sheetOv = {}, sheetPos = {};
      for (let j = 0; j < sn.length; j++) {
        const globalIdx = i * fps + j;
        if (fontOv[globalIdx] !== undefined) sheetOv[j] = fontOv[globalIdx];
        if (posOv[globalIdx] !== undefined) sheetPos[j] = posOv[globalIdx];
      }
      res.push({ i: i + 1, svg: injectNames(sel.svgData, sn, { ...sel, orderCode, store }, sheetOv, sheetPos), n: sn, e: fps - sn.length });
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
    setTypeNames({});
    setOrderCode("");
    setFontOv({});
    setPosOv({});
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

  /* ─── PDF label parsing for Pedidos ─── */
  const parseLabelPdf = async (file) => {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const results = [];
    for (let i = 0; i < pdf.numPages; i++) {
      const page = await pdf.getPage(i + 1);
      const content = await page.getTextContent();

      // Reconstruct lines by grouping text items by Y coordinate
      const lineMap = new Map(); // y -> [{x, str}]
      for (const item of content.items) {
        if (!item.str.trim()) continue;
        const y = Math.round(item.transform[5]); // round Y to group nearby items
        const x = item.transform[4];
        // Find existing line within tolerance (±3 units)
        let lineY = null;
        for (const key of lineMap.keys()) {
          if (Math.abs(key - y) <= 3) { lineY = key; break; }
        }
        if (lineY === null) { lineY = y; lineMap.set(lineY, []); }
        lineMap.get(lineY).push({ x, str: item.str });
      }
      // Sort lines by Y (descending = top to bottom in PDF coords) then items by X
      const sortedLines = [...lineMap.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([, items]) => items.sort((a, b) => a.x - b.x).map(i => i.str).join(" "));
      const text = sortedLines.join("\n");

      console.log("[Pedidos] Texto extraído da página", i + 1, ":\n", text);

      // Extract: Pedido (number after "Pedido:")
      const pedidoMatch = text.match(/Pedido:\s*(\S+)/i);
      const pedido = pedidoMatch ? pedidoMatch[1] : "";
      // Extract: REMETENTE — the store name is on the NEXT line after "REMETENTE"
      let remetente = "";
      const lines = sortedLines;
      for (let li = 0; li < lines.length; li++) {
        if (/REMETENTE/i.test(lines[li])) {
          // Next line has the store name (e.g., "Casa do Condi SP7")
          const nextLine = lines[li + 1] || "";
          // Remove state code suffix like "SP7", "RJ3", etc.
          remetente = nextLine.replace(/\s+[A-Z]{2}\d*\s*$/, "").trim();
          break;
        }
      }
      // Extract: Envio previsto
      const envioMatch = text.match(/Envio\s+previsto:\s*(\d{2}\/\d{2}\/\d{4})/i);
      const envio = envioMatch ? envioMatch[1] : "";
      // Extract SKU items: numbered lines like "1. MOD002 - 10 (MOD002,10) *1"
      // or "1. 12 PERSO DICI 5,5X5,5 - PR (5,5 - Preto,12) *1"
      // Format in parentheses: (SKU_CODE, QUANTITY)
      const skuItems = [];
      const skuParenMatches = [...text.matchAll(/\((.+),(\d+)\)/g)];
      const seenSkus = new Set();
      for (const sm of skuParenMatches) {
        const sku = sm[1].trim();
        const qty = parseInt(sm[2]) || 0;
        // Skip duplicates (label often repeats: "MOD002 - 10 (MOD002,10)")
        if (seenSkus.has(sku)) continue;
        seenSkus.add(sku);
        skuItems.push({ modelo: sku, quantidade: qty });
      }
      // Fallback: try MODxxx-NN pattern if no parentheses found
      if (!skuItems.length) {
        const modMatches = [...text.matchAll(/\b(MOD\d{3})\s*[-,]\s*(\d+)/gi)];
        const seen = new Set();
        for (const mm of modMatches) {
          const key = mm[1].toUpperCase();
          if (!seen.has(key)) { seen.add(key); skuItems.push({ modelo: key, quantidade: parseInt(mm[2]) || 0 }); }
        }
      }
      if (pedido || skuItems.length) {
        // Combine all SKUs into a single entry per label
        const totalQty = skuItems.reduce((sum, s) => sum + s.quantidade, 0);
        results.push({
          id: crypto.randomUUID(),
          pedido,
          remetente,
          envio,
          modelo: skuItems.length === 1 ? skuItems[0].modelo : skuItems.map(s => s.modelo).join(" | "),
          skus: skuItems, // [{modelo, quantidade}]
          quantidade: totalQty,
          feito: false,
          criadoEm: new Date().toISOString(),
        });
      }
    }
    return results;
  };

  const handleLabelUpload = async (e) => {
    const files = e.target.files;
    if (!files?.length) return;
    setPedidosParsing(true);
    try {
      const allResults = [];
      for (const file of files) {
        const results = await parseLabelPdf(file);
        allResults.push(...results);
      }
      // Deduplicate by pedido
      const existing = new Set(pedidos.map(p => p.pedido));
      const newOnes = allResults.filter(r => !existing.has(r.pedido));
      if (newOnes.length === 0) {
        alert("Nenhum pedido novo encontrado (todos já existem na lista).");
        setPedidosParsing(false);
        e.target.value = "";
        return;
      }
      // Save to Supabase and get IDs
      for (const p of newOnes) {
        try {
          const dbId = await db.createOrder({
            orderCode: p.pedido,
            store: p.remetente,
            modelId: p.modelo,
            names: [p.envio],
            fontOverrides: { modelo: p.modelo, feito: false, skus: p.skus || null },
            sheetsCount: p.quantidade,
          });
          if (dbId) p.id = dbId;
        } catch (err) { console.error("Erro ao salvar pedido:", err); }
      }
      setPedidos(prev => [...newOnes, ...prev]);
      alert(`${newOnes.length} pedido(s) importado(s) com sucesso!`);
    } catch (err) {
      alert("Erro ao ler PDF: " + err.message);
      console.error(err);
    }
    setPedidosParsing(false);
    e.target.value = "";
  };

  const togglePedidoFeito = async (id) => {
    setPedidos(prev => prev.map(p => {
      if (p.id !== id) return p;
      const updated = { ...p, feito: !p.feito };
      // Update in Supabase (reuse orders table font_overrides field)
      if (typeof id === "number") {
        db.updateOrder(id, { fontOverrides: { modelo: updated.modelo, feito: updated.feito, semArte: updated.semArte || false } })
          .catch(e => console.error(e));
      }
      return updated;
    }));
  };

  const toggleSemArte = (id) => {
    setPedidos(prev => prev.map(p => {
      if (p.id !== id) return p;
      const updated = { ...p, semArte: !p.semArte };
      if (typeof id === "number") {
        db.updateOrder(id, { fontOverrides: { modelo: updated.modelo, feito: updated.feito, semArte: updated.semArte } })
          .catch(e => console.error(e));
      }
      return updated;
    }));
  };

  const renameSku = (pedidoId, skuIndex) => {
    const p = pedidos.find(x => x.id === pedidoId);
    if (!p) return;
    const oldName = (p.skus && p.skus[skuIndex]) ? p.skus[skuIndex].modelo : p.modelo;
    const newName = prompt("Renomear modelo:", oldName);
    if (newName === null || newName.trim() === "" || newName === oldName) return;
    setPedidos(prev => prev.map(x => {
      if (x.id !== pedidoId) return x;
      const updated = { ...x };
      if (updated.skus && updated.skus.length > 1) {
        updated.skus = updated.skus.map((s, i) => i === skuIndex ? { ...s, modelo: newName.trim() } : s);
        updated.modelo = updated.skus.map(s => s.modelo).join(" | ");
      } else {
        updated.modelo = newName.trim();
        if (updated.skus && updated.skus[0]) updated.skus = [{ ...updated.skus[0], modelo: newName.trim() }];
      }
      if (typeof pedidoId === "number") {
        db.updateOrder(pedidoId, { fontOverrides: { modelo: updated.modelo, feito: updated.feito, semArte: updated.semArte || false, skus: updated.skus } })
          .catch(e => console.error(e));
      }
      return updated;
    }));
  };

  const removePedido = (id) => {
    setPedidos(prev => prev.filter(p => p.id !== id));
    if (typeof id === "number") db.deleteOrder(id).catch(e => console.error(e));
  };

  /* ─── Layout automático de PDFs ─── */
  const handleLayoutUpload = async (e) => {
    const files = e.target.files;
    if (!files?.length) return;
    const items = [];
    const { PDFDocument } = await import("https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm");
    for (const file of files) {
      if (!file.name.toLowerCase().endsWith(".pdf")) continue;
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        const doc = await PDFDocument.load(bytes);
        const page = doc.getPage(0);
        const { width, height } = page.getSize();
        items.push({ name: file.name, bytes, width, height });
      } catch (err) {
        console.error(`Erro ao ler ${file.name}:`, err);
      }
    }
    setLayoutFiles(prev => [...prev, ...items]);
    setLayoutResults([]);
    e.target.value = "";
  };

  const runLayout = async () => {
    if (!layoutFiles.length) return;
    setLayoutProcessing(true);
    try {
      const { PDFDocument } = await import("https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm");
      const MM_TO_PT = 2.83465;
      const LIMIT_PT = layoutLimit * MM_TO_PT;
      const results = [];
      let remaining = [...layoutFiles];
      let partIndex = 1;

      while (remaining.length > 0) {
        const placed = [];
        let xCur = 0, yCur = 0, maxRowH = 0, maxW = 0;
        const next = [];

        for (const item of remaining) {
          // Tenta encaixar na linha atual
          if (xCur + item.width > LIMIT_PT) {
            xCur = 0;
            yCur += maxRowH;
            maxRowH = 0;
          }
          // Cabe na altura?
          if (yCur + item.height <= LIMIT_PT) {
            placed.push({ ...item, x: xCur, y: yCur });
            xCur += item.width;
            maxW = Math.max(maxW, xCur);
            maxRowH = Math.max(maxRowH, item.height);
          } else {
            next.push(item);
          }
        }

        if (placed.length > 0) {
          const totalH = yCur + maxRowH;
          const totalW = maxW;
          const doc = await PDFDocument.create();
          const page = doc.addPage([totalW, totalH]);

          for (const item of placed) {
            const srcDoc = await PDFDocument.load(item.bytes);
            const [embedded] = await doc.embedPages(srcDoc.getPages());
            page.drawPage(embedded, {
              x: item.x,
              y: totalH - item.y - item.height,
              width: item.width,
              height: item.height,
            });
          }

          const pdfBytes = await doc.save();
          const blob = new Blob([pdfBytes], { type: "application/pdf" });
          results.push({
            name: `RESULTADO_PARTE_${partIndex}.pdf`,
            blob,
            widthMm: totalW / MM_TO_PT,
            heightMm: totalH / MM_TO_PT,
            items: placed,
            totalW,
            totalH,
          });
          partIndex++;
        }
        remaining = next;
      }
      setLayoutResults(results);
    } catch (err) {
      alert("Erro no layout: " + err.message);
      console.error(err);
    }
    setLayoutProcessing(false);
  };

  const downloadLayout = async (result) => {
    const url = URL.createObjectURL(result.blob);
    const a = document.createElement("a");
    a.href = url; a.download = result.name; a.click();
    URL.revokeObjectURL(url);
  };

  const downloadAllLayouts = async () => {
    if (layoutResults.length === 1) return downloadLayout(layoutResults[0]);
    const JSZip = (await import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm")).default;
    const zip = new JSZip();
    for (const r of layoutResults) zip.file(r.name, await r.blob.arrayBuffer());
    const zipBlob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement("a"); a.href = url; a.download = "layout_resultado.zip"; a.click();
    URL.revokeObjectURL(url);
  };

  const generatePdf = async () => {
    if (!printQueue.length) return;
    setPdfGenerating(true);
    try {
      const MM = 2.8346; // mm → pt
      const basePath = import.meta.env.BASE_URL || "/";
      const dateStr = new Date().toISOString().slice(0, 10);

      // ── Helper: extract text elements from SVG ──
      const extractTexts = (svg) => {
        const texts = [];
        const tRe = /<text\b([^>]*)>([^<]*)<\/text>/gi;
        let tm;
        while ((tm = tRe.exec(svg)) !== null) {
          const attrs = tm[1];
          const content = tm[2].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
          if (!content.trim()) continue;
          const x = parseFloat((attrs.match(/x="([^"]*)"/) || [])[1]);
          const y = parseFloat((attrs.match(/y="([^"]*)"/) || [])[1]);
          if (isNaN(x) || isNaN(y)) continue;
          const cls = (attrs.match(/class="([^"]*)"/) || [])[1] || "";
          const anchor = (attrs.match(/text-anchor="([^"]*)"/) || [])[1] || "start";
          let fontSize = 0;
          const styleSize = attrs.match(/font-size:([0-9.]+)px/);
          if (styleSize) fontSize = parseFloat(styleSize[1]);
          texts.push({ x, y, content, cls, anchor, fontSize });
        }
        return texts;
      };

      // ── Helper: extract vector cut lines from SVG ──
      const extractCutLines = (svg) => {
        const lines = [];
        const strLineRe = /<line\b([^>]*class="[^"]*str[^"]*"[^>]*)\/?\s*>/gi;
        let lm;
        while ((lm = strLineRe.exec(svg)) !== null) {
          const a = lm[1];
          const x1 = parseFloat((a.match(/x1\s*=\s*"([^"]*)"/) || [])[1]);
          const y1 = parseFloat((a.match(/y1\s*=\s*"([^"]*)"/) || [])[1]);
          const x2 = parseFloat((a.match(/x2\s*=\s*"([^"]*)"/) || [])[1]);
          const y2 = parseFloat((a.match(/y2\s*=\s*"([^"]*)"/) || [])[1]);
          if ([x1, y1, x2, y2].some(isNaN)) continue;
          lines.push({ x1, y1, x2, y2, type: a.includes("str0") ? "border" : "cut" });
        }
        const strPolyRe = /<polygon\b([^>]*class="[^"]*str0[^"]*"[^>]*)\/?\s*>/gi;
        let pm;
        while ((pm = strPolyRe.exec(svg)) !== null) {
          const pts = (pm[1].match(/points="([^"]*)"/) || [])[1];
          if (!pts) continue;
          const coords = pts.trim().split(/\s+/).filter(s => s.length > 0).map(p => p.split(",").map(Number));
          for (let i = 0; i < coords.length; i++) {
            const [ax, ay] = coords[i];
            const [bx, by] = coords[(i + 1) % coords.length];
            if ([ax, ay, bx, by].some(isNaN)) continue;
            lines.push({ x1: ax, y1: ay, x2: bx, y2: by, type: "border" });
          }
        }
        return lines;
      };

      // ── Helper: map font-family CSS to font file key ──
      const mapFontKey = (family, isBold, isItalic) => {
        if (family.includes("times")) return isBold && isItalic ? "timesbi" : isBold ? "timesbd" : isItalic ? "timesi" : "times";
        if (family.includes("arial")) return isBold ? "arialbd" : isItalic ? "ariali" : "arial";
        if (family.includes("calibri")) return "calibri";
        if (family.includes("georgia")) return "georgia";
        if (family.includes("verdana")) return "verdana";
        if (family.includes("tahoma")) return "tahoma";
        if (family.includes("comic")) return "comic";
        if (family.includes("trebuchet")) return "trebuc";
        if (family.includes("dk coal") || family.includes("coal brush")) return "dkcoalbrush";
        if (family.includes("misses")) return "misses";
        return null;
      };

      // ── 1. Load pdf-lib + fontkit (once) ──
      const pdfLibCode = await fetch("https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js").then(r => r.text());
      const PDFLib = new Function(pdfLibCode + ";return PDFLib;")();
      const { PDFDocument, rgb, cmyk } = PDFLib;
      const fontkitCode = await fetch("https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js").then(r => r.text());
      const fontkit = new Function(fontkitCode + ";return fontkit;")();

      // ── 2. Load font file bytes (once, reused across PDFs) ──
      const FONT_FILES = {
        "times": "times.ttf", "timesbd": "timesbd.ttf", "timesi": "timesi.ttf", "timesbi": "timesbi.ttf",
        "arial": "arial.ttf", "arialbd": "arialbd.ttf", "ariali": "ariali.ttf",
        "calibri": "calibri.ttf", "georgia": "Georgia.ttf", "verdana": "verdana.ttf",
        "tahoma": "tahoma.ttf", "comic": "comic.ttf", "trebuc": "trebuc.ttf",
        "dkcoalbrush": "dkcoalbrush.otf", "misses": "misses.otf",
      };
      const fontBytesCache = {};
      for (const [key, file] of Object.entries(FONT_FILES)) {
        try {
          const res = await fetch(basePath + "fonts/" + file);
          if (res.ok) fontBytesCache[key] = new Uint8Array(await res.arrayBuffer());
        } catch (e) { /* skip */ }
      }

      // CMYK colors for professional printing
      const grayColor = cmyk(0, 0.02, 0.01, 0.78);
      const textColor = cmyk(0, 0, 0, 1);

      // ── 3. Group print queue by model and generate one PDF per model ──
      const pdfResults = [];
      const byModel = {};
      for (const item of printQueue) {
        const key = item.model || item.modelId || "unknown";
        if (!byModel[key]) byModel[key] = [];
        byModel[key].push(item);
      }

      // ── 4. Generate one PDF per model ──
      for (const [modelId, items] of Object.entries(byModel)) {
        const refSvg = items[0].svg;
        const vbMatch = refSvg.match(/viewBox="([^"]*)"/);
        const [, , vbW, vbH] = (vbMatch ? vbMatch[1] : "0 0 17709 12357").split(/[\s,]+/).map(Number);
        const svgWm = refSvg.match(/width="([0-9.]+)mm"/);
        const svgHm = refSvg.match(/height="([0-9.]+)mm"/);
        const cWmm = svgWm ? parseFloat(svgWm[1]) : vbW * 0.01214;
        const cHmm = svgHm ? parseFloat(svgHm[1]) : vbH * 0.01214;
        const pageWpt = cWmm * MM;
        const pageHpt = cHmm * MM;
        const scX = pageWpt / vbW;
        const scY = pageHpt / vbH;

        // Extract cut lines from this model's SVG
        const vectorLines = extractCutLines(refSvg);

        // Parse fnt classes for this model's SVG
        const fntInfo = {};
        const fntRe = /\.fnt(\d+)\s*\{([^}]*)\}/gi;
        let fm;
        while ((fm = fntRe.exec(refSvg)) !== null) {
          const css = fm[2];
          const size = parseFloat((css.match(/font-size:([0-9.]+)px/) || [])[1]) || 24;
          const family = ((css.match(/font-family:'?([^;'"]+)/) || [])[1] || "").trim().toLowerCase();
          fntInfo["fnt" + fm[1]] = { size, fontKey: mapFontKey(family, css.includes("font-weight:bold"), css.includes("font-style:italic")) };
        }

        // Create PDF document for this model
        const doc = await PDFDocument.create();
        doc.registerFontkit(fontkit);
        doc.setTitle(`Sticker Studio - ${modelId}`);

        // Create "CutContour" spot color (Separation color space)
        // FlexiPrint/VersaWorks/etc. recognize this name for cut lines
        const ctx = doc.context;
        const { PDFName, PDFArray, PDFDict, PDFNumber } = PDFLib;
        // Tint transform: maps tint 0→1 to CMYK. At tint=1: C=0 M=1 Y=0 K=0 (pure magenta)
        const tintFn = ctx.obj({
          FunctionType: 2,
          Domain: [0, 1],
          C0: [0, 0, 0, 0],
          C1: [0, 1, 0, 0],
          N: 1,
        });
        const tintFnRef = ctx.register(tintFn);
        // Separation array: [/Separation /CutContour /DeviceCMYK <tintFn>]
        const sepArray = ctx.obj([
          PDFName.of("Separation"),
          PDFName.of("CutContour"),
          PDFName.of("DeviceCMYK"),
          tintFnRef,
        ]);
        const sepRef = ctx.register(sepArray);

        // Embed only the fonts needed by this model
        const neededKeys = new Set(Object.values(fntInfo).map(f => f.fontKey).filter(Boolean));
        const pdfFonts = {};
        for (const key of neededKeys) {
          if (fontBytesCache[key]) {
            try { pdfFonts[key] = await doc.embedFont(fontBytesCache[key]); } catch (e) { /* skip */ }
          }
        }

        // Render cartelas and build pages
        for (const item of items) {
          // Render PNG (ornaments only, no text/lines)
          let svgClean = item.svg;
          svgClean = svgClean.replace(/<line\b[^>]*class="[^"]*str[^"]*"[^>]*\/?\s*>/gi, "");
          svgClean = svgClean.replace(/<polygon\b[^>]*class="[^"]*str0[^"]*"[^>]*\/?\s*>/gi, "");
          svgClean = svgClean.replace(/<text\b[^>]*>[^<]*<\/text>/gi, "");
          const blob = await svgToPng(svgClean, 3);
          const buf = await blob.arrayBuffer();
          const imgData = new Uint8Array(buf);

          const page = doc.addPage([pageWpt, pageHpt]);
          const isJpeg = blob.type.includes("jpeg");
          const img = isJpeg ? await doc.embedJpg(imgData) : await doc.embedPng(imgData);
          page.drawImage(img, { x: 0, y: 0, width: pageWpt, height: pageHpt });

          // Vector text
          for (const t of extractTexts(item.svg)) {
            const fntClass = (t.cls.match(/fnt\d+/) || [])[0];
            const info = fntClass ? fntInfo[fntClass] : null;
            const fs = t.fontSize || (info ? info.size : 24);
            const pdfFS = fs * scY;
            const font = info && info.fontKey ? pdfFonts[info.fontKey] : null;
            const xPt = t.x * scX;
            const yPt = pageHpt - t.y * scY;
            try {
              if (font) {
                const tw = font.widthOfTextAtSize(t.content, pdfFS);
                const drawX = t.anchor === "middle" ? xPt - tw / 2 : xPt;
                page.drawText(t.content, { x: drawX, y: yPt, size: pdfFS, font, color: textColor });
              } else {
                page.drawText(t.content, { x: xPt, y: yPt, size: pdfFS, color: textColor });
              }
            } catch (e) { console.warn("[PDF] drawText failed:", t.content, e.message); }
          }

          // Vector cut lines — border uses CMYK gray, cut uses CutContour spot color
          // Register CutContour color space in page resources
          const pageDict = page.node;
          let resources = pageDict.get(PDFName.of("Resources"));
          if (!resources) { resources = ctx.obj({}); pageDict.set(PDFName.of("Resources"), resources); }
          let colorSpaces = resources.get(PDFName.of("ColorSpace"));
          if (!colorSpaces) { colorSpaces = ctx.obj({}); resources.set(PDFName.of("ColorSpace"), colorSpaces); }
          colorSpaces.set(PDFName.of("CS_CutContour"), sepRef);

          // Draw border lines with CMYK gray
          for (const ln of vectorLines.filter(l => l.type === "border")) {
            page.drawLine({
              start: { x: ln.x1 * scX, y: pageHpt - ln.y1 * scY },
              end:   { x: ln.x2 * scX, y: pageHpt - ln.y2 * scY },
              thickness: 0.5,
              color: grayColor,
            });
          }

          // Draw cut lines with CutContour spot color using raw PDF operators
          const cutLinesArr = vectorLines.filter(l => l.type === "cut");
          if (cutLinesArr.length) {
            const ops = [
              "q",
              "/CS_CutContour CS",
              "1 SCN",
              "0.5 w",
            ];
            for (const ln of cutLinesArr) {
              ops.push(
                `${(ln.x1 * scX).toFixed(2)} ${(pageHpt - ln.y1 * scY).toFixed(2)} m`,
                `${(ln.x2 * scX).toFixed(2)} ${(pageHpt - ln.y2 * scY).toFixed(2)} l`,
                "S"
              );
            }
            ops.push("Q");
            const opsStr = ops.join("\n");
            const opsBytes = new TextEncoder().encode(opsStr);
            // Create a raw PDF stream and append to page contents
            const rawStream = ctx.stream(opsBytes);
            const rawRef = ctx.register(rawStream);
            const contents = pageDict.get(PDFName.of("Contents"));
            if (contents instanceof PDFArray) {
              contents.push(rawRef);
            } else if (contents) {
              pageDict.set(PDFName.of("Contents"), ctx.obj([contents, rawRef]));
            } else {
              pageDict.set(PDFName.of("Contents"), rawRef);
            }
          }
        }

        // Save this model's PDF bytes
        const pdfBytes = await doc.save();
        pdfResults.push({ name: `${modelId}_${dateStr}.pdf`, bytes: pdfBytes });
      }

      // Send generated PDFs to Layout Automático
      const { PDFDocument: PDFDoc } = await import("https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm");
      const layoutItems = [];
      for (const { name, bytes } of pdfResults) {
        try {
          const doc = await PDFDoc.load(bytes);
          const page = doc.getPage(0);
          const { width, height } = page.getSize();
          layoutItems.push({ name, bytes: new Uint8Array(bytes), width, height });
        } catch (err) { console.error("Erro ao processar PDF para layout:", err); }
      }
      if (layoutItems.length) {
        setLayoutFiles(prev => [...prev, ...layoutItems]);
        setLayoutResults([]);
      }

      // Mark as printed in DB
      const ids = printQueue.filter(p => p.id).map(p => p.id);
      if (ids.length) db.markPrinted(ids).catch(e => console.error(e));
    } catch (err) {
      alert("Erro ao gerar PDF: " + err.message);
      console.error(err);
    }
    setPdfGenerating(false);
  };

  const V = { "--bg": "#0f1117", "--card": "#181b24", "--inp": "#13151d", "--accent": "#e85d3a", "--t1": "#eaedf3", "--t2": "#7a8194", "--t3": "#4a5068", "--brd": "#262a38" };

  const handleLogout = () => { localStorage.removeItem("ss_session"); setLoggedUser(null); };

  if (!loggedUser) return <LoginScreen onLogin={setLoggedUser} />;

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
          <Tab active={tab === "pedidos"} onClick={() => setTab("pedidos")} icon="clipboard" label={`Pedidos${pedidos.length ? ` (${pedidos.length})` : ""}`} />
          <Tab active={tab === "cartela"} onClick={() => setTab("cartela")} icon="target" label="Cartelas" />
          <Tab active={tab === "help"} onClick={() => setTab("help")} icon="help" label="Ajuda" />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, color: "var(--t2)" }}>{loggedUser}{isAdmin ? " (admin)" : ""}</span>
          {isAdmin && <button onClick={() => setShowUserMgmt(p => !p)} style={{ background: "none", border: "1px solid var(--brd)", borderRadius: 8, padding: "6px 10px", color: "var(--t2)", cursor: "pointer", fontSize: 12, fontFamily: "inherit", transition: "all .2s", display: "flex", alignItems: "center", gap: 4 }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "#34d399"; e.currentTarget.style.color = "#34d399"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--brd)"; e.currentTarget.style.color = "var(--t2)"; }}>
            <I n="settings" s={12} /> Usuários
          </button>}
          <button onClick={handleLogout} style={{ background: "none", border: "1px solid var(--brd)", borderRadius: 8, padding: "6px 12px", color: "var(--t2)", cursor: "pointer", fontSize: 12, fontFamily: "inherit", transition: "all .2s" }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "#f87171"; e.currentTarget.style.color = "#f87171"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--brd)"; e.currentTarget.style.color = "var(--t2)"; }}>
            Sair
          </button>
        </div>
      </header>

      {/* User Management Modal (admin only) */}
      {showUserMgmt && isAdmin && <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={e => { if (e.target === e.currentTarget) setShowUserMgmt(false); }}>
        <div style={{ background: "var(--card)", borderRadius: 20, border: "1px solid var(--brd)", padding: 32, width: 480, maxHeight: "80vh", overflow: "auto", animation: "fadeIn .2s" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700 }}>Gerenciar Usuários</h2>
            <button onClick={() => setShowUserMgmt(false)} style={{ background: "none", border: "none", color: "var(--t3)", cursor: "pointer", fontSize: 18 }}>✕</button>
          </div>

          {/* New user form */}
          <form onSubmit={e => {
            e.preventDefault();
            const fd = new FormData(e.target);
            const nu = fd.get("newuser")?.trim();
            const np = fd.get("newpass")?.trim();
            const nr = fd.get("newrole");
            if (!nu || !np) { alert("Preencha usuário e senha"); return; }
            const users = getUsers();
            if (users[nu]) { alert("Usuário já existe"); return; }
            users[nu] = { pass: np, role: nr };
            saveUsers(users);
            e.target.reset();
            setShowUserMgmt(false); setTimeout(() => setShowUserMgmt(true), 10);
          }} style={{ background: "var(--inp)", borderRadius: 12, padding: 16, marginBottom: 20, border: "1px solid var(--brd)" }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: "var(--t2)" }}>Criar novo usuário</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <input name="newuser" placeholder="Usuário" required style={{ flex: 1, padding: "10px 12px", background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 13, fontFamily: "inherit" }} />
              <input name="newpass" placeholder="Senha" type="password" required style={{ flex: 1, padding: "10px 12px", background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 13, fontFamily: "inherit" }} />
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <select name="newrole" defaultValue="user" style={{ flex: 1, padding: "10px 12px", background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 13, fontFamily: "inherit" }}>
                <option value="user">Operador</option>
                <option value="admin">Administrador</option>
              </select>
              <button type="submit" style={{ background: "#34d399", color: "#000", border: "none", padding: "10px 20px", borderRadius: 8, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>Criar</button>
            </div>
          </form>

          {/* User list */}
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: "var(--t2)" }}>Usuários cadastrados</div>
          {Object.entries(getUsers()).map(([name, info]) => (
            <div key={name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: "var(--inp)", borderRadius: 10, border: "1px solid var(--brd)", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: info.role === "admin" ? "rgba(232,93,58,.2)" : "rgba(122,129,148,.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: info.role === "admin" ? "#e85d3a" : "var(--t2)" }}>
                  {name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{name}</div>
                  <div style={{ fontSize: 11, color: "var(--t3)" }}>{info.role === "admin" ? "Administrador" : "Operador"}</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => {
                  const np = prompt(`Nova senha para "${name}":`);
                  if (!np?.trim()) return;
                  const users = getUsers();
                  users[name].pass = np.trim();
                  saveUsers(users);
                  alert("Senha alterada!");
                }} style={{ background: "none", border: "1px solid var(--brd)", borderRadius: 6, padding: "4px 10px", color: "var(--t2)", cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>Alterar senha</button>
                {name !== "admin" && <button onClick={() => {
                  if (!confirm(`Remover usuário "${name}"?`)) return;
                  const users = getUsers();
                  delete users[name];
                  saveUsers(users);
                  setShowUserMgmt(false); setTimeout(() => setShowUserMgmt(true), 10);
                }} style={{ background: "none", border: "1px solid rgba(248,113,113,.3)", borderRadius: 6, padding: "4px 10px", color: "#f87171", cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>Remover</button>}
              </div>
            </div>
          ))}
        </div>
      </div>}

      <main style={{ padding: "24px 32px", maxWidth: 1400, margin: "0 auto" }}>
        {dbLoading && <div style={{ textAlign: "center", padding: 40, color: "var(--t2)" }}>Carregando dados...</div>}
        {/* GALLERY */}
        {tab === "gallery" && <div style={{ animation: "fadeIn .3s" }}>
          <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Galeria de Modelos</h2>
          <p style={{ color: "var(--t2)", fontSize: 14, marginBottom: 24 }}>Selecione para configurar</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: 16 }}>
            {models.map(m => (
              <div key={m.id} className="card-h" onClick={() => { setSelId(m.id); setTab(m.svgData || m.svgUrl ? "generate" : "config"); }} style={{ background: "var(--card)", borderRadius: 14, border: `1px solid ${selId === m.id ? "var(--accent)" : "var(--brd)"}`, cursor: "pointer", overflow: "hidden", transition: "all .25s" }}>
                <div style={{ height: 130, background: m.thumbUrl ? `url(${m.thumbUrl}) center/cover` : "linear-gradient(135deg,#1e2230,#262a38)", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
                  {!m.thumbUrl && <I n="image" s={28} />}
                  {m.svgData && <div style={{ position: "absolute", top: 8, right: 8, background: "#34d399", borderRadius: 20, padding: "2px 8px", fontSize: 10, fontWeight: 700, color: "#000" }}>SVG</div>}
                </div>
                <div style={{ padding: "10px 14px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{m.displayName || m.id}</div>
                    <button onClick={(e) => {
                      e.stopPropagation();
                      const newName = prompt("Renomear modelo:", m.displayName || m.id);
                      if (newName !== null && newName.trim()) {
                        upd(m.id, { displayName: newName.trim() });
                      }
                    }} title="Renomear" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--t3)", padding: 2, display: "flex", transition: "color .2s" }} onMouseEnter={e => e.currentTarget.style.color = "var(--accent)"} onMouseLeave={e => e.currentTarget.style.color = "var(--t3)"}><I n="edit" s={13} /></button>
                  </div>
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
              <div><h2 style={{ fontSize: 22, fontWeight: 700 }}>{sel.displayName || sel.id}</h2><p style={{ color: "var(--t2)", fontSize: 13 }}>{sel.displayName ? `${sel.id} · ` : ""}{sel.fields.length} campos · {sel.fontFamily} · {sel.fontSize}px</p></div>
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
          : <div style={{ display: "grid", gridTemplateColumns: isMultiType ? "1fr 280px" : "1fr 340px", gap: 20 }}>
            <div>
              <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Gerar — {sel.id}</h2>
              <p style={{ color: "var(--t2)", fontSize: 13, marginBottom: 16 }}>{isMultiType ? `${groupSize} tipos de campo — preencha cada coluna separadamente` : "Cole os nomes, um por linha"}</p>

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

              {/* Textareas: multi-type shows side-by-side, single-type shows one */}
              {isMultiType ? (
                <div style={{ display: "grid", gridTemplateColumns: `repeat(${groupSize}, 1fr)`, gap: 12 }}>
                  {sel.fieldTypes.map((ft, t) => (
                    <div key={t} style={{ display: "flex", flexDirection: "column" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                        <div style={{ width: 10, height: 10, borderRadius: "50%", background: TYPE_COLORS[t % TYPE_COLORS.length] }} />
                        <span style={{ fontSize: 12, fontWeight: 700, color: TYPE_COLORS[t % TYPE_COLORS.length] }}>{ft.label}</span>
                        <span style={{ fontSize: 10, color: "var(--t3)" }}>({Math.round(ft.fontSize)}px)</span>
                      </div>
                      <textarea
                        value={typeNames[t] || ""}
                        onChange={e => setTypeNames(p => ({ ...p, [t]: e.target.value }))}
                        placeholder={t === 0 ? "MARIA SILVA\nJOAO\nANA CLARA\n..." : t === 1 ? "Texto tipo 2\n..." : "Texto tipo 3\n..."}
                        style={{
                          width: "100%", minHeight: 260, padding: 14, background: "var(--card)",
                          border: `2px solid ${TYPE_COLORS[t % TYPE_COLORS.length]}33`, borderRadius: 14,
                          color: "var(--t1)", fontSize: 13, fontFamily: "mono", lineHeight: 1.8,
                          resize: "vertical",
                        }}
                      />
                      <div style={{ fontSize: 11, color: "var(--t3)", marginTop: 4, textAlign: "right" }}>
                        {(typeLists[t] || []).length} nome(s)
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <textarea value={names} onChange={e => setNames(e.target.value)} placeholder={"Maria Silva\nJoao Pedro da Silva\nAna Clara\n..."} style={{ width: "100%", minHeight: 300, padding: 16, background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 14, color: "var(--t1)", fontSize: 14, fontFamily: "mono", lineHeight: 1.8, resize: "vertical" }} />
              )}
              <button className="bp" onClick={gen} disabled={!nl.length && !nl.some(Boolean)} style={{ width: "100%", justifyContent: "center", padding: "14px", fontSize: 15, marginTop: 16 }}><I n="zap" s={18} /> Gerar Cartelas</button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 20 }}>
                {isMultiType ? (
                  <>
                    {[
                      { l: "Etiquetas", v: stats?.stickers || 0, c: "#e85d3a" },
                      { l: "Campos/cartela", v: stats?.f || 0, c: "var(--t1)" },
                      { l: "Cartelas", v: stats?.s || 0, c: "#34d399" },
                      { l: "Tipos", v: groupSize, c: "#a78bfa" },
                    ].map((s, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: i < 3 ? "1px solid var(--brd)" : "none" }}>
                        <span style={{ fontSize: 13, color: "var(--t2)" }}>{s.l}</span>
                        <span style={{ fontSize: 22, fontWeight: 700, color: s.c, fontFamily: "mono" }}>{s.v}</span>
                      </div>
                    ))}
                    <div style={{ marginTop: 12, borderTop: "1px solid var(--brd)", paddingTop: 12 }}>
                      {sel.fieldTypes.map((ft, t) => (
                        <div key={t} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <div style={{ width: 8, height: 8, borderRadius: "50%", background: TYPE_COLORS[t % TYPE_COLORS.length] }} />
                            <span style={{ fontSize: 12, color: "var(--t2)" }}>{ft.label}</span>
                          </div>
                          <span style={{ fontSize: 14, fontWeight: 600, color: TYPE_COLORS[t % TYPE_COLORS.length], fontFamily: "mono" }}>{(typeLists[t] || []).length}</span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  [{ l: "Nomes", v: nl.length, c: "#e85d3a" }, { l: "Campos/cartela", v: stats?.f || 0, c: "var(--t1)" }, { l: "Cartelas", v: stats?.s || 0, c: "#34d399" }, { l: "Vazios", v: stats?.e || 0, c: "#fbbf24" }].map((s, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: i < 3 ? "1px solid var(--brd)" : "none" }}>
                      <span style={{ fontSize: 13, color: "var(--t2)" }}>{s.l}</span>
                      <span style={{ fontSize: 22, fontWeight: 700, color: s.c, fontFamily: "mono" }}>{s.v}</span>
                    </div>
                  ))
                )}
              </div>
              {nl.length > 0 && <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 16, maxHeight: 400, overflow: "auto" }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--t2)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
                  {isMultiType ? "Campos" : "Nomes"}
                </div>
                {nl.map((n, i) => {
                  if (!n && isMultiType) return null; // skip empty interleaved slots
                  const typeIdx = isMultiType ? i % groupSize : -1;
                  const typeColor = typeIdx >= 0 ? TYPE_COLORS[typeIdx % TYPE_COLORS.length] : null;
                  const fs = fontOv[i] || sel.fontSize;
                  const tw = measureText(n, sel.fontFamily, fs);
                  const willBreak = tw > sel.maxWidth;
                  const hasOv = fontOv[i] !== undefined;
                  const hasPos = posOv[i] !== undefined;
                  const xOff = posOv[i] || 0;
                  return (
                    <div key={i} style={{ padding: "6px 0", borderBottom: "1px solid var(--brd)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                        {typeColor && <div style={{ width: 6, height: 6, borderRadius: "50%", background: typeColor, flexShrink: 0 }} />}
                        <span style={{ color: "var(--t3)", fontFamily: "mono", minWidth: 20, fontSize: 10 }}>{i + 1}</span>
                        <span style={{ flex: 1, fontWeight: willBreak ? 600 : 400, color: willBreak && !hasOv ? "#fbbf24" : "var(--t1)", fontSize: 11 }}>{n}</span>
                        {willBreak && !hasOv && <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 8, background: "rgba(251,191,36,.15)", color: "#fbbf24", whiteSpace: "nowrap" }}>2 lin</span>}
                        {hasPos && <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 8, background: "rgba(167,139,250,.15)", color: "#a78bfa", whiteSpace: "nowrap" }}>{xOff > 0 ? "+" : ""}{xOff}</span>}
                        {/* Position adjust button */}
                        <button onClick={() => {
                          if (hasPos) { setPosOv(p => { const c = { ...p }; delete c[i]; return c; }); }
                          else { setPosOv(p => ({ ...p, [i]: 0 })); }
                        }} style={{ background: "none", border: "none", cursor: "pointer", color: hasPos ? "#a78bfa" : "var(--t3)", padding: 2, display: "flex" }} title="Ajuste posição horizontal">
                          <I n="move" s={13} />
                        </button>
                        {/* Font size adjust button (single-type only) */}
                        {!isMultiType && <button onClick={() => {
                          if (hasOv) { setFontOv(p => { const c = { ...p }; delete c[i]; return c; }); }
                          else { setFontOv(p => ({ ...p, [i]: sel.fontSize })); }
                        }} style={{ background: "none", border: "none", cursor: "pointer", color: hasOv ? "#ff7b5c" : "var(--t3)", padding: 2, display: "flex" }} title="Ajuste tamanho fonte">
                          <I n="settings" s={13} />
                        </button>}
                      </div>
                      {hasPos && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, paddingLeft: 26 }}>
                          <span style={{ fontSize: 9, color: "#a78bfa", whiteSpace: "nowrap" }}>←→</span>
                          <input type="range" min="-800" max="800" step="10" value={xOff}
                            onChange={e => setPosOv(p => ({ ...p, [i]: parseInt(e.target.value) }))}
                            style={{ flex: 1, accentColor: "#a78bfa", height: 4 }}
                          />
                          <input type="number" value={xOff}
                            onChange={e => setPosOv(p => ({ ...p, [i]: parseInt(e.target.value) || 0 }))}
                            style={{ width: 55, padding: "2px 4px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 4, color: "#a78bfa", fontSize: 11, fontFamily: "mono", textAlign: "right" }}
                          />
                        </div>
                      )}
                      {hasOv && !isMultiType && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, paddingLeft: 26 }}>
                          <span style={{ fontSize: 9, color: "#ff7b5c", whiteSpace: "nowrap" }}>Aa</span>
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

          {/* LAYOUT AUTOMÁTICO — integrated section */}
          <div style={{ marginTop: 40, borderTop: "1px solid var(--brd)", paddingTop: 32 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <div>
                <h2 style={{ fontSize: 20, fontWeight: 700, display: "flex", alignItems: "center", gap: 10 }}>
                  <I n="layout" s={22} /> Layout Automático
                </h2>
                <p style={{ color: "var(--t2)", fontSize: 13 }}>Junte vários PDFs em folhas otimizadas (limite {layoutLimit}mm)</p>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <label className="bp" style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 8, padding: "12px 24px" }}>
                  <I n="upload" s={18} /> Adicionar PDFs
                  <input type="file" accept=".pdf" multiple onChange={handleLayoutUpload} style={{ display: "none" }} />
                </label>
                {layoutFiles.length > 0 && <button className="bs" onClick={() => { setLayoutFiles([]); setLayoutResults([]); }} style={{ color: "#f87171", borderColor: "rgba(248,113,113,.3)" }}><I n="trash" s={14} /> Limpar</button>}
              </div>
            </div>

            {/* Limite config */}
            <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 14, marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--t2)", marginBottom: 8 }}>Limite da folha (mm)</div>
              <div style={{ display: "flex", gap: 8 }}>
                {[500, 700, 1000, 1200].map(v => (
                  <button key={v} onClick={() => setLayoutLimit(v)} style={{
                    padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "mono",
                    border: layoutLimit === v ? "2px solid var(--accent)" : "1px solid var(--brd)",
                    background: layoutLimit === v ? "rgba(232,93,58,.15)" : "var(--inp)",
                    color: layoutLimit === v ? "#ff7b5c" : "var(--t2)",
                  }}>{v}mm</button>
                ))}
                <input type="number" value={layoutLimit} onChange={e => setLayoutLimit(Math.max(100, parseInt(e.target.value) || 1000))}
                  style={{ width: 80, padding: "8px 10px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 13, fontFamily: "mono", textAlign: "center" }} />
              </div>
            </div>

            {layoutFiles.length === 0 ? (
              <div style={{ textAlign: "center", padding: 40, color: "var(--t2)", background: "var(--card)", borderRadius: 14, border: "1px dashed var(--brd)" }}>
                <I n="layout" s={36} />
                <p style={{ marginTop: 12, fontSize: 14 }}>Nenhum PDF adicionado</p>
                <p style={{ marginTop: 6, fontSize: 12, color: "var(--t3)" }}>
                  Faça upload dos PDFs que deseja juntar em folhas otimizadas para impressão.
                </p>
              </div>
            ) : (<>
              {/* File list */}
              <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 16, marginBottom: 20 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--t2)", marginBottom: 12 }}>{layoutFiles.length} arquivo(s) carregado(s)</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {layoutFiles.map((f, i) => {
                    const wMm = (f.width / 2.83465).toFixed(0);
                    const hMm = (f.height / 2.83465).toFixed(0);
                    return (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--inp)", borderRadius: 10, padding: "8px 12px", border: "1px solid var(--brd)" }}>
                        <I n="file" s={14} />
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 600 }}>{f.name}</div>
                          <div style={{ fontSize: 10, color: "var(--t3)" }}>{wMm}×{hMm}mm</div>
                        </div>
                        <button onClick={() => { setLayoutFiles(p => p.filter((_, j) => j !== i)); setLayoutResults([]); }}
                          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--t3)", padding: 2, display: "flex" }}>
                          <I n="trash" s={12} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Generate button */}
              <button className="bp" onClick={runLayout} disabled={layoutProcessing}
                style={{ width: "100%", padding: "16px", marginBottom: 20, fontSize: 16, background: layoutProcessing ? "var(--t3)" : undefined }}>
                <I n="layout" s={20} /> {layoutProcessing ? "Processando..." : `Gerar Layout (${layoutFiles.length} PDFs)`}
              </button>

              {/* Results */}
              {layoutResults.length > 0 && (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                    <h3 style={{ fontSize: 16, fontWeight: 700 }}>Resultado — {layoutResults.length} folha(s)</h3>
                    <button className="bp" onClick={downloadAllLayouts} style={{ padding: "10px 20px" }}>
                      <I n="download" s={16} /> {layoutResults.length === 1 ? "Baixar PDF" : "Baixar ZIP"}
                    </button>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
                    {layoutResults.map((r, i) => (
                      <div key={i} style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 16 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 14 }}>{r.name}</div>
                            <div style={{ fontSize: 12, color: "var(--t2)", marginTop: 2 }}>{r.widthMm.toFixed(1)}mm × {r.heightMm.toFixed(1)}mm · {r.items.length} PDF(s)</div>
                          </div>
                          <button className="bs" onClick={() => downloadLayout(r)} style={{ padding: "6px 12px" }}>
                            <I n="download" s={14} />
                          </button>
                        </div>
                        {/* Visual preview of layout */}
                        <div style={{ background: "#fff", borderRadius: 8, padding: 8, position: "relative", overflow: "hidden" }}>
                          {(() => {
                            const scale = 260 / Math.max(r.totalW, r.totalH);
                            const svgW = r.totalW * scale;
                            const svgH = r.totalH * scale;
                            return (
                              <svg width={svgW} height={svgH} viewBox={`0 0 ${r.totalW} ${r.totalH}`} style={{ display: "block" }}>
                                <rect x={0} y={0} width={r.totalW} height={r.totalH} fill="#f0f0f0" stroke="#ccc" strokeWidth={r.totalW * 0.003} />
                                {r.items.map((item, j) => {
                                  const colors = ["#e85d3a33", "#34d39933", "#a78bfa33", "#fbbf2433", "#f472b633", "#60a5fa33"];
                                  return (
                                    <g key={j}>
                                      <rect x={item.x} y={item.y} width={item.width} height={item.height}
                                        fill={colors[j % colors.length]} stroke="#666" strokeWidth={r.totalW * 0.002} />
                                      <text x={item.x + item.width / 2} y={item.y + item.height / 2}
                                        textAnchor="middle" dominantBaseline="middle"
                                        fontSize={Math.min(item.width, item.height) * 0.15} fill="#333" fontFamily="sans-serif">
                                        {item.name.replace(".pdf", "").substring(0, 12)}
                                      </text>
                                    </g>
                                  );
                                })}
                              </svg>
                            );
                          })()}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>)}
          </div>
        </div>}
        {/* PEDIDOS */}
        {tab === "pedidos" && <div style={{ animation: "fadeIn .3s" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
            <div>
              <h2 style={{ fontSize: 22, fontWeight: 700 }}>Controle de Pedidos</h2>
              <p style={{ color: "var(--t2)", fontSize: 13 }}>
                {pedidos.length} pedido(s) · {pedidos.filter(p => p.feito).length} feito(s) · {pedidos.filter(p => !p.feito).length} pendente(s)
              </p>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <label className="bp" style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 8, padding: "12px 24px" }}>
                <I n="upload" s={18} /> {pedidosParsing ? "Lendo PDF..." : "Importar Etiquetas"}
                <input type="file" accept=".pdf" multiple onChange={handleLabelUpload} style={{ display: "none" }} disabled={pedidosParsing} />
              </label>
              {pedidos.length > 0 && <button className="bs" onClick={() => { if (confirm("Limpar todos os pedidos?")) { setPedidos([]); db.deleteAllOrders().catch(e => console.error(e)); } }} style={{ color: "#f87171", borderColor: "rgba(248,113,113,.3)" }}><I n="trash" s={14} /> Limpar</button>}
            </div>
          </div>

          {pedidos.length === 0 ? (
            <div style={{ textAlign: "center", padding: 60, color: "var(--t2)" }}>
              <I n="clipboard" s={48} />
              <p style={{ marginTop: 16, fontSize: 16 }}>Nenhum pedido importado</p>
              <p style={{ marginTop: 8, fontSize: 13, color: "var(--t3)", lineHeight: 1.6 }}>
                Faça upload das etiquetas de envio (PDF) para<br/>importar automaticamente os dados dos pedidos.
              </p>
            </div>
          ) : (<>
            {/* Filter by status */}
            {(() => {
              const pendentes = pedidos.filter(p => !p.feito);
              const feitos = pedidos.filter(p => p.feito);
              // Group pendentes by envio date
              const byDate = {};
              pendentes.forEach(p => {
                const key = p.envio || "Sem data";
                if (!byDate[key]) byDate[key] = [];
                byDate[key].push(p);
              });
              const sortedDates = Object.keys(byDate).sort((a, b) => {
                if (a === "Sem data") return 1;
                if (b === "Sem data") return -1;
                const [da, ma, ya] = a.split("/"); const [db2, mb, yb] = b.split("/");
                return new Date(`${ya}-${ma}-${da}`) - new Date(`${yb}-${mb}-${db2}`);
              });

              return <>
                {/* Summary cards */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 24 }}>
                  {[
                    { l: "Total", v: pedidos.length, c: "#e85d3a" },
                    { l: "Pendentes", v: pendentes.length, c: "#fbbf24" },
                    { l: "Sem Arte", v: pedidos.filter(p => p.semArte && !p.feito).length, c: "#f59e0b" },
                    { l: "Feitos", v: feitos.length, c: "#34d399" },
                    { l: "Unidades", v: pedidos.reduce((s, p) => s + (p.quantidade || 0), 0), c: "var(--t1)" },
                  ].map((s, i) => (
                    <div key={i} style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 16, textAlign: "center" }}>
                      <div style={{ fontSize: 28, fontWeight: 700, color: s.c, fontFamily: "mono" }}>{s.v}</div>
                      <div style={{ fontSize: 11, color: "var(--t3)", marginTop: 4 }}>{s.l}</div>
                    </div>
                  ))}
                </div>

                {/* Table — Pendentes */}
                <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", overflow: "hidden" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: "2px solid var(--brd)", textAlign: "left" }}>
                        <th style={{ padding: "12px 16px", fontWeight: 600, color: "var(--t2)", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, width: 40 }}>Status</th>
                        <th style={{ padding: "12px 16px", fontWeight: 600, color: "var(--t2)", fontSize: 11, textTransform: "uppercase", letterSpacing: 1 }}>Pedido</th>
                        <th style={{ padding: "12px 16px", fontWeight: 600, color: "var(--t2)", fontSize: 11, textTransform: "uppercase", letterSpacing: 1 }}>Loja</th>
                        <th style={{ padding: "12px 16px", fontWeight: 600, color: "var(--t2)", fontSize: 11, textTransform: "uppercase", letterSpacing: 1 }}>Envio Previsto</th>
                        <th style={{ padding: "12px 16px", fontWeight: 600, color: "var(--t2)", fontSize: 11, textTransform: "uppercase", letterSpacing: 1 }}>Modelo</th>
                        <th style={{ padding: "12px 16px", fontWeight: 600, color: "var(--t2)", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, textAlign: "center" }}>Qtd</th>
                        <th style={{ padding: "12px 16px", width: 40 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedDates.map(date => (
                        byDate[date].map((p) => {
                          const isUrgent = (() => {
                            if (!p.envio) return false;
                            const [d, m, y] = p.envio.split("/");
                            const envDate = new Date(`${y}-${m}-${d}`);
                            const today = new Date(); today.setHours(0,0,0,0);
                            return envDate <= today;
                          })();
                          return (
                            <tr key={p.id} style={{ borderBottom: "1px solid var(--brd)", background: p.semArte ? "rgba(251,191,36,.08)" : isUrgent ? "rgba(248,113,113,.06)" : "transparent", transition: "background .2s" }}>
                              <td style={{ padding: "10px 16px", textAlign: "center" }}>
                                <button onClick={() => togglePedidoFeito(p.id)} style={{ background: "transparent", border: "2px solid var(--brd)", borderRadius: 6, width: 24, height: 24, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all .2s" }} />
                              </td>
                              <td style={{ padding: "10px 16px" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                  <span style={{ fontWeight: 600, fontFamily: "mono", fontSize: 12 }}>{p.pedido || "—"}</span>
                                  {p.pedido && <button onClick={() => { navigator.clipboard.writeText(p.pedido); }} title="Copiar" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--t3)", padding: 2, display: "flex", flexShrink: 0, transition: "color .2s" }} onMouseEnter={e => e.currentTarget.style.color = "var(--accent)"} onMouseLeave={e => e.currentTarget.style.color = "var(--t3)"}><I n="copy" s={13} /></button>}
                                  {p.semArte && <span style={{ padding: "2px 8px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: "rgba(251,191,36,.2)", color: "#fbbf24", whiteSpace: "nowrap" }}>SEM ARTE</span>}
                                </div>
                              </td>
                              <td style={{ padding: "10px 16px" }}>{p.remetente || "—"}</td>
                              <td style={{ padding: "10px 16px" }}>
                                {p.envio ? (
                                  <span style={{ padding: "3px 10px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: isUrgent ? "rgba(248,113,113,.15)" : "rgba(251,191,36,.12)", color: isUrgent ? "#f87171" : "#fbbf24" }}>
                                    {p.envio}
                                  </span>
                                ) : <span style={{ color: "var(--t3)" }}>—</span>}
                              </td>
                              <td style={{ padding: "10px 16px" }}>
                                {(p.skus && p.skus.length > 1) ? (
                                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                    {p.skus.map((s, si) => (
                                      <div key={si} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                        <span style={{ padding: "3px 10px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "rgba(232,93,58,.12)", color: "#e85d3a" }}>
                                          {s.modelo}
                                        </span>
                                        <button onClick={() => renameSku(p.id, si)} title="Renomear" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--t3)", padding: 2, display: "flex", flexShrink: 0, transition: "color .2s" }} onMouseEnter={e => e.currentTarget.style.color = "var(--accent)"} onMouseLeave={e => e.currentTarget.style.color = "var(--t3)"}><I n="edit" s={12} /></button>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                    <span style={{ padding: "3px 10px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "rgba(232,93,58,.12)", color: "#e85d3a" }}>
                                      {p.modelo || "—"}
                                    </span>
                                    <button onClick={() => renameSku(p.id, 0)} title="Renomear" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--t3)", padding: 2, display: "flex", flexShrink: 0, transition: "color .2s" }} onMouseEnter={e => e.currentTarget.style.color = "var(--accent)"} onMouseLeave={e => e.currentTarget.style.color = "var(--t3)"}><I n="edit" s={12} /></button>
                                  </div>
                                )}
                              </td>
                              <td style={{ padding: "10px 16px", textAlign: "center", fontFamily: "mono" }}>
                                {(p.skus && p.skus.length > 1) ? (
                                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                    {p.skus.map((s, si) => (
                                      <span key={si} style={{ fontWeight: 700 }}>{s.quantidade}</span>
                                    ))}
                                  </div>
                                ) : (
                                  <span style={{ fontWeight: 700 }}>{p.quantidade || "—"}</span>
                                )}
                              </td>
                              <td style={{ padding: "10px 16px" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                  <button onClick={() => toggleSemArte(p.id)} title={p.semArte ? "Remover alerta" : "Marcar sem arte"} style={{ background: "none", border: "none", cursor: "pointer", color: p.semArte ? "#fbbf24" : "var(--t3)", padding: 2, display: "flex", transition: "color .2s" }} onMouseEnter={e => { if (!p.semArte) e.currentTarget.style.color = "#fbbf24"; }} onMouseLeave={e => { if (!p.semArte) e.currentTarget.style.color = "var(--t3)"; }}>
                                    <I n="alert" s={14} />
                                  </button>
                                  <button onClick={() => removePedido(p.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--t3)", padding: 2, display: "flex" }}>
                                    <I n="trash" s={14} />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Feitos section */}
                {feitos.length > 0 && (
                  <div style={{ marginTop: 24 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                      <h3 style={{ fontSize: 15, fontWeight: 700, color: "#34d399" }}>Concluidos ({feitos.length})</h3>
                      <button className="bs" onClick={() => {
                        const codes = feitos.map(p => p.pedido).filter(Boolean);
                        if (!codes.length) return alert("Nenhum codigo para copiar.");
                        navigator.clipboard.writeText(codes.join("\n"));
                        alert(`${codes.length} codigo(s) copiado(s)!`);
                      }} style={{ color: "#34d399", borderColor: "rgba(52,211,153,.3)", display: "flex", alignItems: "center", gap: 6 }}>
                        <I n="copy" s={14} /> Copiar todos os codigos
                      </button>
                    </div>
                    <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", overflow: "hidden" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                        <thead>
                          <tr style={{ borderBottom: "2px solid var(--brd)", textAlign: "left" }}>
                            <th style={{ padding: "12px 16px", fontWeight: 600, color: "var(--t2)", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, width: 40 }}>Status</th>
                            <th style={{ padding: "12px 16px", fontWeight: 600, color: "var(--t2)", fontSize: 11, textTransform: "uppercase", letterSpacing: 1 }}>Pedido</th>
                            <th style={{ padding: "12px 16px", fontWeight: 600, color: "var(--t2)", fontSize: 11, textTransform: "uppercase", letterSpacing: 1 }}>Loja</th>
                            <th style={{ padding: "12px 16px", fontWeight: 600, color: "var(--t2)", fontSize: 11, textTransform: "uppercase", letterSpacing: 1 }}>Envio Previsto</th>
                            <th style={{ padding: "12px 16px", fontWeight: 600, color: "var(--t2)", fontSize: 11, textTransform: "uppercase", letterSpacing: 1 }}>Modelo</th>
                            <th style={{ padding: "12px 16px", fontWeight: 600, color: "var(--t2)", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, textAlign: "center" }}>Qtd</th>
                            <th style={{ padding: "12px 16px", width: 40 }}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {feitos.map(p => (
                            <tr key={p.id} style={{ borderBottom: "1px solid var(--brd)", background: "rgba(52,211,153,.04)" }}>
                              <td style={{ padding: "10px 16px", textAlign: "center" }}>
                                <button onClick={() => togglePedidoFeito(p.id)} style={{ background: "#34d399", border: "2px solid #34d399", borderRadius: 6, width: 24, height: 24, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                  <I n="check" s={14} />
                                </button>
                              </td>
                              <td style={{ padding: "10px 16px" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                  <span style={{ fontWeight: 600, fontFamily: "mono", fontSize: 12, textDecoration: "line-through", color: "var(--t3)" }}>{p.pedido || "—"}</span>
                                  {p.pedido && <button onClick={() => { navigator.clipboard.writeText(p.pedido); }} title="Copiar" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--t3)", padding: 2, display: "flex", flexShrink: 0 }}><I n="copy" s={13} /></button>}
                                </div>
                              </td>
                              <td style={{ padding: "10px 16px", color: "var(--t3)" }}>{p.remetente || "—"}</td>
                              <td style={{ padding: "10px 16px", color: "var(--t3)" }}>{p.envio || "—"}</td>
                              <td style={{ padding: "10px 16px" }}>
                                {(p.skus && p.skus.length > 1) ? (
                                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                    {p.skus.map((s, si) => (
                                      <div key={si} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                        <span style={{ padding: "3px 10px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "rgba(52,211,153,.1)", color: "#34d399" }}>
                                          {s.modelo}
                                        </span>
                                        <button onClick={() => renameSku(p.id, si)} title="Renomear" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--t3)", padding: 2, display: "flex", flexShrink: 0, transition: "color .2s" }} onMouseEnter={e => e.currentTarget.style.color = "#34d399"} onMouseLeave={e => e.currentTarget.style.color = "var(--t3)"}><I n="edit" s={12} /></button>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                    <span style={{ padding: "3px 10px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "rgba(52,211,153,.1)", color: "#34d399" }}>{p.modelo || "—"}</span>
                                    <button onClick={() => renameSku(p.id, 0)} title="Renomear" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--t3)", padding: 2, display: "flex", flexShrink: 0, transition: "color .2s" }} onMouseEnter={e => e.currentTarget.style.color = "#34d399"} onMouseLeave={e => e.currentTarget.style.color = "var(--t3)"}><I n="edit" s={12} /></button>
                                  </div>
                                )}
                              </td>
                              <td style={{ padding: "10px 16px", textAlign: "center", fontFamily: "mono", color: "var(--t3)" }}>
                                {(p.skus && p.skus.length > 1) ? (
                                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                    {p.skus.map((s, si) => (
                                      <span key={si}>{s.quantidade}</span>
                                    ))}
                                  </div>
                                ) : (
                                  <span>{p.quantidade || "—"}</span>
                                )}
                              </td>
                              <td style={{ padding: "10px 16px" }}>
                                <button onClick={() => removePedido(p.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--t3)", padding: 2, display: "flex" }}>
                                  <I n="trash" s={14} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>;
            })()}
          </>)}
        </div>}

        {/* CARTELA BUILDER */}
        {tab === "cartela" && (() => {
          const c = cartela;
          const MM = 2.83465; // mm to pt/svg units
          const svgW = c.sheetW * MM, svgH = c.sheetH * MM;
          const mTop = c.marginTop * MM, mBot = c.marginBottom * MM, mLeft = c.marginLeft * MM, mRight = c.marginRight * MM;
          const isCircle = c.shape === "circle";
          const rawW = c.stickerW * MM, rawH = c.stickerH * MM;
          // For circles, cell is a square with side = diameter (use stickerW as diameter)
          const cellW = rawW;
          const cellH = isCircle ? rawW : rawH;
          const safe = c.safeMargin * MM; // margem de segurança interna
          const gX = c.gapX * MM, gY = c.gapY * MM;
          const gridW = svgW - mLeft - mRight;
          const gridH = svgH - mTop - mBot;
          const maxCols = cellW > 0 ? Math.max(1, Math.floor((gridW + gX) / (cellW + gX))) : 0;
          const maxRows = cellH > 0 ? Math.max(1, Math.floor((gridH + gY) / (cellH + gY))) : 0;
          const perSheet = maxCols * maxRows; // etiquetas por folha
          const totalWanted = c.wantedQty > 0 ? c.wantedQty : perSheet;
          const numSheets = perSheet > 0 ? Math.ceil(totalWanted / perSheet) : 1;
          const cols = maxCols;
          const rows = maxRows;
          // Center the grid within available space
          const usedW = cols * cellW + (cols - 1) * gX;
          const usedH = rows * cellH + (rows - 1) * gY;
          const offX = mLeft + (gridW - usedW) / 2;
          const offY = mTop + (gridH - usedH) / 2;

          const upC = (key, val) => setCartela(p => ({ ...p, [key]: val }));
          const numField = (label, key, unit = "mm", min = 0, max = 2000, step = 1) => (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label style={{ fontSize: 12, color: "var(--t2)", width: 90, flexShrink: 0 }}>{label}</label>
              <input type="number" value={c[key]} min={min} max={max} step={step}
                onChange={e => upC(key, parseFloat(e.target.value) || 0)}
                style={{ width: 80, padding: "8px 10px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 13, fontFamily: "mono", textAlign: "center" }} />
              <span style={{ fontSize: 11, color: "var(--t3)" }}>{unit}</span>
            </div>
          );

          const handleArtUpload = (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => upC("artData", reader.result);
            if (file.type.startsWith("image/svg")) {
              reader.readAsText(file);
              upC("artUrl", null);
            } else {
              reader.readAsDataURL(file);
              upC("artUrl", "img");
            }
            e.target.value = "";
          };

          // mode: "full" (preview com tudo), "art" (só arte para PNG)
          const buildSheetSvg = (sheetIdx, mode = "full") => {
            const startIdx = sheetIdx * perSheet;
            const cellsOnSheet = Math.min(perSheet, totalWanted - startIdx);
            const sheetRows = cols > 0 ? Math.ceil(cellsOnSheet / cols) : 0;
            const scale = c.artScale / 100;

            // Clip-paths for circular art
            let defs = "";
            if (isCircle && c.artData) {
              let clips = "";
              for (let i = 0; i < cellsOnSheet; i++) {
                const col = i % cols, row = Math.floor(i / cols);
                const cx = offX + col * (cellW + gX) + cellW / 2;
                const cy = offY + row * (cellH + gY) + cellH / 2;
                const r = Math.min(cellW, cellH) / 2 - safe;
                clips += `<clipPath id="clip-${sheetIdx}-${i}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>`;
              }
              defs = `<defs>${clips}</defs>`;
            }

            // Art
            let arts = "";
            if (c.artData) {
              for (let i = 0; i < cellsOnSheet; i++) {
                const col = i % cols, row = Math.floor(i / cols);
                const cellX = offX + col * (cellW + gX);
                const cellY = offY + row * (cellH + gY);
                let artEl = "";
                if (isCircle) {
                  const r = Math.min(cellW, cellH) / 2 - safe;
                  const d = r * 2 * scale;
                  const ax = cellX + cellW / 2 - d / 2 + c.artOffX * MM;
                  const ay = cellY + cellH / 2 - d / 2 + c.artOffY * MM;
                  if (c.artUrl === "img") {
                    artEl = `<image href="${c.artData}" x="${ax}" y="${ay}" width="${d}" height="${d}" preserveAspectRatio="xMidYMid meet"/>`;
                  } else {
                    const inner = c.artData.replace(/<\?xml[^?]*\?>/g, "").replace(/<!DOCTYPE[^>]*>/g, "");
                    artEl = `<g transform="translate(${ax},${ay}) scale(${d / 100},${d / 100})">${inner}</g>`;
                  }
                  arts += `<g clip-path="url(#clip-${sheetIdx}-${i})">${artEl}</g>`;
                } else {
                  const ax = cellX + safe + c.artOffX * MM;
                  const ay = cellY + safe + c.artOffY * MM;
                  const aw = (cellW - safe * 2) * scale;
                  const ah = (cellH - safe * 2) * scale;
                  if (c.artUrl === "img") {
                    artEl = `<image href="${c.artData}" x="${ax}" y="${ay}" width="${aw}" height="${ah}" preserveAspectRatio="xMidYMid meet"/>`;
                  } else {
                    const inner = c.artData.replace(/<\?xml[^?]*\?>/g, "").replace(/<!DOCTYPE[^>]*>/g, "");
                    artEl = `<g transform="translate(${ax},${ay}) scale(${aw / 100},${ah / 100})">${inner}</g>`;
                  }
                  arts += artEl;
                }
              }
            }

            // Cut lines — only for full mode (preview)
            let cuts = "";
            let border = "";
            if (mode === "full") {
              if (isCircle) {
                // Circle cut lines
                for (let i = 0; i < cellsOnSheet; i++) {
                  const col = i % cols, row = Math.floor(i / cols);
                  const cx = offX + col * (cellW + gX) + cellW / 2;
                  const cy = offY + row * (cellH + gY) + cellH / 2;
                  const r = Math.min(cellW, cellH) / 2;
                  cuts += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${c.cutColor}" stroke-width="${c.cutWidth * MM}"/>`;
                }
              } else {
                // Rect cut lines (grid)
                const sheetUsedH = sheetRows * cellH + (sheetRows - 1) * gY;
                for (let r = 0; r <= sheetRows; r++) {
                  const yPos = r === sheetRows ? offY + (sheetRows - 1) * (cellH + gY) + cellH : offY + r * (cellH + gY);
                  cuts += `<line x1="${offX}" y1="${yPos}" x2="${offX + usedW}" y2="${yPos}" stroke="${c.cutColor}" stroke-width="${c.cutWidth * MM}" fill="none"/>`;
                }
                for (let col = 0; col <= cols; col++) {
                  const xPos = col === cols ? offX + (cols - 1) * (cellW + gX) + cellW : offX + col * (cellW + gX);
                  cuts += `<line x1="${xPos}" y1="${offY}" x2="${xPos}" y2="${offY + sheetUsedH}" stroke="${c.cutColor}" stroke-width="${c.cutWidth * MM}" fill="none"/>`;
                }
              }
              border = `<rect x="0.5" y="0.5" width="${(svgW - 1).toFixed(2)}" height="${(svgH - 1).toFixed(2)}" fill="none" stroke="${c.borderColor}" stroke-width="${c.borderWidth * MM}"/>`;
            }

            // Order code + store label near the top border
            let label = "";
            const labelText = [c.orderCode, c.store].filter(Boolean).join(" · ");
            if (labelText) {
              const lblSize = Math.min(mTop * 0.25, 3.5 * MM);
              const lblY = Math.max(lblSize + 1 * MM, mTop * 0.55);
              label = `<text x="${mLeft}" y="${lblY}" font-family="sans-serif" font-size="${lblSize.toFixed(1)}" fill="#666">${labelText.replace(/&/g,"&amp;").replace(/</g,"&lt;")}</text>`;
            }

            return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${c.sheetW}mm" height="${c.sheetH}mm" viewBox="0 0 ${svgW.toFixed(2)} ${svgH.toFixed(2)}">
  ${defs}
  ${border}
  ${label}
  ${arts}
  ${cuts}
</svg>`;
          };

          const generateCartPdfs = async () => {
            upC("printProcessing", true);
            upC("printResults", []);
            try {
              const pdfLibCode = await fetch("https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js").then(r => r.text());
              const PDFLib = new Function(pdfLibCode + ";return PDFLib;")();
              const { PDFDocument, cmyk, PDFName, PDFArray } = PDFLib;
              const MM_TO_PT = 2.83465;
              const pageW = c.sheetW * MM_TO_PT;
              const pageH = c.sheetH * MM_TO_PT;
              const cutThickPt = c.cutWidth * MM_TO_PT;
              const borderThickPt = c.borderWidth * MM_TO_PT;
              const grayColor = cmyk(0, 0.02, 0.01, 0.78);

              // Scale from SVG viewBox units to PDF points
              const sx = pageW / svgW;
              const sy = pageH / svgH;

              const pdfs = [];
              for (let si = 0; si < numSheets; si++) {
                // SVG with ART ONLY (no lines, no border) → render to PNG
                const svgArtOnly = buildSheetSvg(si, "art");
                const pngBlob = await svgToPng(svgArtOnly, 3);
                const pngBuf = new Uint8Array(await pngBlob.arrayBuffer());

                const doc = await PDFDocument.create();
                const ctx = doc.context;

                // CutContour spot color (Separation color space for cutting machines)
                const tintFn = ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 1, 0, 0], N: 1 });
                const tintFnRef = ctx.register(tintFn);
                const sepArray = ctx.obj([PDFName.of("Separation"), PDFName.of("CutContour"), PDFName.of("DeviceCMYK"), tintFnRef]);
                const sepRef = ctx.register(sepArray);

                // 1) Embed art as PNG background
                const page = doc.addPage([pageW, pageH]);
                const isJpeg = pngBlob.type.includes("jpeg");
                const img = isJpeg ? await doc.embedJpg(pngBuf) : await doc.embedPng(pngBuf);
                page.drawImage(img, { x: 0, y: 0, width: pageW, height: pageH });

                // 2) Register CutContour color space in page resources
                const pageDict = page.node;
                let resources = pageDict.get(PDFName.of("Resources"));
                if (!resources) { resources = ctx.obj({}); pageDict.set(PDFName.of("Resources"), resources); }
                let colorSpaces = resources.get(PDFName.of("ColorSpace"));
                if (!colorSpaces) { colorSpaces = ctx.obj({}); resources.set(PDFName.of("ColorSpace"), colorSpaces); }
                colorSpaces.set(PDFName.of("CS_CutContour"), sepRef);

                // 3) Vector border rectangle — CMYK gray
                const startIdx = si * perSheet;
                const cellsOnSheet = Math.min(perSheet, totalWanted - startIdx);
                const sheetRows = cols > 0 ? Math.ceil(cellsOnSheet / cols) : 0;
                const sheetUsedH = sheetRows * cellH + (sheetRows - 1) * gY;

                // Build ALL vector lines using raw PDF operators
                const ops = [];

                // Border rectangle — CMYK gray stroke
                ops.push(
                  "q",
                  `${borderThickPt.toFixed(3)} w`,
                  "0 0.02 0.01 0.78 K", // CMYK gray stroke
                  `0.50 0.50 ${(pageW - 1).toFixed(2)} ${(pageH - 1).toFixed(2)} re`,
                  "S",
                  "Q"
                );

                // 4) CutContour vector lines — spot color for cutting machine
                ops.push(
                  "q",
                  "/CS_CutContour CS",
                  "1 SCN",
                  `${cutThickPt.toFixed(3)} w`
                );

                if (isCircle) {
                  // Circle cut lines using Bézier approximation (kappa = 0.5522847498)
                  const K = 0.5522847498;
                  for (let i = 0; i < cellsOnSheet; i++) {
                    const col = i % cols, row = Math.floor(i / cols);
                    const cxSvg = offX + col * (cellW + gX) + cellW / 2;
                    const cySvg = offY + row * (cellH + gY) + cellH / 2;
                    const rSvg = Math.min(cellW, cellH) / 2;
                    const cx = (cxSvg * sx).toFixed(2);
                    const cy = (pageH - cySvg * sy).toFixed(2);
                    const rx = (rSvg * sx).toFixed(2);
                    const ry = (rSvg * sy).toFixed(2);
                    const kx = (rSvg * sx * K).toFixed(2);
                    const ky = (rSvg * sy * K).toFixed(2);
                    const cxN = cxSvg * sx, cyN = pageH - cySvg * sy, rxN = rSvg * sx, ryN = rSvg * sy, kxN = rSvg * sx * K, kyN = rSvg * sy * K;
                    ops.push(
                      `${(cxN + rxN).toFixed(2)} ${cyN.toFixed(2)} m`,
                      `${(cxN + rxN).toFixed(2)} ${(cyN + kyN).toFixed(2)} ${(cxN + kxN).toFixed(2)} ${(cyN + ryN).toFixed(2)} ${cxN.toFixed(2)} ${(cyN + ryN).toFixed(2)} c`,
                      `${(cxN - kxN).toFixed(2)} ${(cyN + ryN).toFixed(2)} ${(cxN - rxN).toFixed(2)} ${(cyN + kyN).toFixed(2)} ${(cxN - rxN).toFixed(2)} ${cyN.toFixed(2)} c`,
                      `${(cxN - rxN).toFixed(2)} ${(cyN - kyN).toFixed(2)} ${(cxN - kxN).toFixed(2)} ${(cyN - ryN).toFixed(2)} ${cxN.toFixed(2)} ${(cyN - ryN).toFixed(2)} c`,
                      `${(cxN + kxN).toFixed(2)} ${(cyN - ryN).toFixed(2)} ${(cxN + rxN).toFixed(2)} ${(cyN - kyN).toFixed(2)} ${(cxN + rxN).toFixed(2)} ${cyN.toFixed(2)} c`,
                      "S"
                    );
                  }
                } else {
                  // Rectangular cut lines (grid)
                  for (let r = 0; r <= sheetRows; r++) {
                    const ySvg = r === sheetRows ? offY + (sheetRows - 1) * (cellH + gY) + cellH : offY + r * (cellH + gY);
                    const x1Pt = (offX * sx).toFixed(2);
                    const x2Pt = ((offX + usedW) * sx).toFixed(2);
                    const yPt = (pageH - ySvg * sy).toFixed(2);
                    ops.push(`${x1Pt} ${yPt} m`, `${x2Pt} ${yPt} l`, "S");
                  }
                  for (let col = 0; col <= cols; col++) {
                    const xSvg = col === cols ? offX + (cols - 1) * (cellW + gX) + cellW : offX + col * (cellW + gX);
                    const xPt = (xSvg * sx).toFixed(2);
                    const y1Pt = (pageH - offY * sy).toFixed(2);
                    const y2Pt = (pageH - (offY + sheetUsedH) * sy).toFixed(2);
                    ops.push(`${xPt} ${y1Pt} m`, `${xPt} ${y2Pt} l`, "S");
                  }
                }
                ops.push("Q");

                // Append raw vector stream to page contents
                const opsBytes = new TextEncoder().encode(ops.join("\n"));
                const rawStream = ctx.stream(opsBytes);
                const rawRef = ctx.register(rawStream);
                const contents = pageDict.get(PDFName.of("Contents"));
                if (contents instanceof PDFArray) {
                  contents.push(rawRef);
                } else if (contents) {
                  pageDict.set(PDFName.of("Contents"), ctx.obj([contents, rawRef]));
                } else {
                  pageDict.set(PDFName.of("Contents"), rawRef);
                }

                const bytes = await doc.save();
                pdfs.push({ name: `cartela_${si + 1}.pdf`, bytes: new Uint8Array(bytes), width: pageW, height: pageH });
              }
              upC("generatedPdfs", [...(c.generatedPdfs || []), ...pdfs]);
            } catch (err) {
              alert("Erro ao gerar PDFs: " + err.message);
              console.error(err);
            }
            upC("printProcessing", false);
          };

          // Preview scale
          const previewMaxW = 500;
          const previewScale = Math.min(previewMaxW / svgW, 600 / svgH, 1);

          return <div style={{ animation: "fadeIn .3s" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div>
                <h2 style={{ fontSize: 22, fontWeight: 700 }}>Gerador de Cartelas</h2>
                <p style={{ color: "var(--t2)", fontSize: 13 }}>Crie grids de etiquetas com arte e linhas de corte</p>
              </div>
              <button className="bp" onClick={generateCartPdfs} disabled={!cols || !rows || c.printProcessing} style={{ padding: "12px 28px", background: c.printProcessing ? "var(--t3)" : undefined }}>
                <I n="zap" s={18} /> {c.printProcessing ? "Gerando..." : `Gerar ${numSheets} PDF${numSheets > 1 ? "s" : ""}${c.generatedPdfs?.length ? ` (+${c.generatedPdfs.length} na fila)` : ""}`}
              </button>
            </div>

            {/* Pedido + Loja + Forma */}
            <div style={{ display: "flex", gap: 12, marginBottom: 24, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 200 }}>
                <label style={{ fontSize: 12, color: "var(--t2)", whiteSpace: "nowrap" }}>Pedido</label>
                <input type="text" value={c.orderCode} placeholder="Código do pedido"
                  onChange={e => upC("orderCode", e.target.value)}
                  style={{ flex: 1, padding: "8px 12px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 13 }} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <label style={{ fontSize: 12, color: "var(--t2)", whiteSpace: "nowrap" }}>Loja</label>
                <select value={c.store} onChange={e => upC("store", e.target.value)}
                  style={{ padding: "8px 12px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 13, cursor: "pointer" }}>
                  {STORES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                {["rect", "circle"].map(sh => (
                  <button key={sh} onClick={() => upC("shape", sh)} style={{
                    padding: "8px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 6,
                    border: c.shape === sh ? "2px solid var(--accent)" : "1px solid var(--brd)",
                    background: c.shape === sh ? "rgba(232,93,58,.15)" : "var(--inp)",
                    color: c.shape === sh ? "#ff7b5c" : "var(--t2)",
                  }}>
                    {sh === "rect" ? <svg width="14" height="14" viewBox="0 0 14 14"><rect x="1" y="3" width="12" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg>
                      : <svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg>}
                    {sh === "rect" ? "Retangular" : "Circular"}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: 24 }}>
              {/* LEFT: Controls */}
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {/* Sheet size */}
                <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}><I n="file" s={14} /> Tamanho da Folha</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {numField("Largura", "sheetW")}
                    {numField("Altura", "sheetH")}
                  </div>
                </div>

                {/* Sticker size */}
                <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}><I n="target" s={14} /> {isCircle ? "Tamanho do Adesivo Circular" : "Tamanho da Etiqueta"}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {isCircle ? numField("Diâmetro", "stickerW") : numField("Largura", "stickerW")}
                    {!isCircle && numField("Altura", "stickerH")}
                    {numField("Espaço H", "gapX")}
                    {numField("Espaço V", "gapY")}
                    {numField("Margem interna", "safeMargin")}
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <label style={{ fontSize: 12, color: "var(--t2)", width: 90, flexShrink: 0 }}>Quantidade</label>
                      <input type="number" value={c.wantedQty || ""} min={0} max={9999} placeholder={`${perSheet}`}
                        onChange={e => upC("wantedQty", parseInt(e.target.value) || 0)}
                        style={{ width: 80, padding: "8px 10px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 13, fontFamily: "mono", textAlign: "center" }} />
                      <span style={{ fontSize: 11, color: "var(--t3)" }}>{perSheet}/folha</span>
                    </div>
                  </div>
                </div>

                {/* Margins */}
                <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Margens</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {numField("Topo", "marginTop")}
                    {numField("Base", "marginBottom")}
                    {numField("Esquerda", "marginLeft")}
                    {numField("Direita", "marginRight")}
                  </div>
                </div>

                {/* Art upload */}
                <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}><I n="image" s={14} /> Arte</div>
                  <label className="bp" style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 8, padding: "10px 20px", width: "100%", justifyContent: "center", marginBottom: c.artData ? 12 : 0 }}>
                    <I n="upload" s={16} /> {c.artData ? "Trocar Arte" : "Upload Arte"}
                    <input type="file" accept=".svg,.png,.jpg,.jpeg,.webp" onChange={handleArtUpload} style={{ display: "none" }} />
                  </label>
                  {c.artData && <>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {numField("Escala", "artScale", "%", 10, 200)}
                      {numField("Offset X", "artOffX", "mm", -100, 100, 0.5)}
                      {numField("Offset Y", "artOffY", "mm", -100, 100, 0.5)}
                    </div>
                    <button className="bs" onClick={() => { upC("artData", null); upC("artUrl", null); }} style={{ marginTop: 8, width: "100%", justifyContent: "center", color: "#f87171", borderColor: "rgba(248,113,113,.3)" }}>
                      <I n="trash" s={12} /> Remover Arte
                    </button>
                  </>}
                </div>

                {/* Cut line config */}
                <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Linhas de Corte</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <label style={{ fontSize: 12, color: "var(--t2)", width: 90, flexShrink: 0 }}>Cor</label>
                      <input type="color" value={c.cutColor} onChange={e => upC("cutColor", e.target.value)}
                        style={{ width: 40, height: 32, border: "1px solid var(--brd)", borderRadius: 6, background: "var(--inp)", cursor: "pointer" }} />
                      <span style={{ fontSize: 11, color: "var(--t3)", fontFamily: "mono" }}>{c.cutColor}</span>
                    </div>
                    {numField("Espessura", "cutWidth", "mm", 0.05, 2, 0.05)}
                  </div>
                </div>

                {/* Info */}
                <div style={{ background: "rgba(52,211,153,.08)", borderRadius: 14, border: "1px solid rgba(52,211,153,.2)", padding: 16 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    {[
                      { l: "Colunas", v: cols },
                      { l: "Linhas", v: rows },
                      { l: "Por folha", v: perSheet },
                      { l: "Cartelas", v: numSheets },
                      { l: "Total", v: totalWanted },
                      { l: "Grid", v: `${(usedW / MM).toFixed(1)}×${(usedH / MM).toFixed(1)}mm` },
                    ].map((s, i) => (
                      <div key={i} style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 20, fontWeight: 700, color: "#34d399", fontFamily: "mono" }}>{s.v}</div>
                        <div style={{ fontSize: 10, color: "var(--t2)" }}>{s.l}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* RIGHT: Preview */}
              <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 20, display: "flex", flexDirection: "column", alignItems: "center", overflow: "auto", maxHeight: "80vh" }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 16, color: "var(--t2)", textAlign: "center" }}>
                  Preview — {numSheets} cartela(s) · {perSheet}/folha · {totalWanted} etiqueta(s) total
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 16, alignItems: "center" }}>
                  {Array.from({ length: numSheets }, (_, sheetIdx) => {
                    const startIdx = sheetIdx * perSheet;
                    const cellsOnSheet = Math.min(perSheet, totalWanted - startIdx);
                    const sheetRows = cols > 0 ? Math.ceil(cellsOnSheet / cols) : 0;
                    return <div key={sheetIdx} style={{ background: "#fff", borderRadius: 8, padding: 12, display: "inline-block", position: "relative" }}>
                      {numSheets > 1 && <div style={{ position: "absolute", top: 4, left: 12, fontSize: 10, fontWeight: 700, color: "#e85d3a", background: "rgba(232,93,58,.1)", padding: "2px 8px", borderRadius: 6 }}>
                        Cartela {sheetIdx + 1}/{numSheets}
                      </div>}
                      <svg width={svgW * previewScale} height={svgH * previewScale} viewBox={`0 0 ${svgW.toFixed(2)} ${svgH.toFixed(2)}`} style={{ display: "block" }}>
                        <rect x="0.5" y="0.5" width={svgW - 1} height={svgH - 1} fill="#fafafa" stroke={c.borderColor} strokeWidth={c.borderWidth * MM} />
                        {(c.orderCode || c.store) && (() => {
                          const lblSize = Math.min(mTop * 0.25, 3.5 * MM);
                          const lblY = Math.max(lblSize + 1 * MM, mTop * 0.55);
                          return <text x={mLeft} y={lblY} fontFamily="sans-serif" fontSize={lblSize} fill="#666">
                            {[c.orderCode, c.store].filter(Boolean).join(" · ")}
                          </text>;
                        })()}
                        <rect x={mLeft} y={mTop} width={gridW} height={gridH} fill="none" stroke="#ddd" strokeWidth={0.3} strokeDasharray="4 2" />
                        {Array.from({ length: cellsOnSheet }, (_, i) => {
                          const globalIdx = startIdx + i;
                          const col = i % cols, row = Math.floor(i / cols);
                          const cellX = offX + col * (cellW + gX);
                          const cellY = offY + row * (cellH + gY);
                          const scale = c.artScale / 100;
                          if (isCircle) {
                            const ccx = cellX + cellW / 2, ccy = cellY + cellH / 2;
                            const rr = Math.min(cellW, cellH) / 2;
                            const rSafe = rr - safe;
                            const d = rSafe * 2 * scale;
                            const artX = ccx - d / 2 + c.artOffX * MM;
                            const artY = ccy - d / 2 + c.artOffY * MM;
                            return <g key={i}>
                              {safe > 0 && <circle cx={ccx} cy={ccy} r={rSafe} fill="none" stroke="#93c5fd" strokeWidth={0.2} strokeDasharray="2 1" opacity={0.5} />}
                              {c.artData && <>
                                <clipPath id={`cell-${sheetIdx}-${i}`}><circle cx={ccx} cy={ccy} r={rSafe} /></clipPath>
                                <g clipPath={`url(#cell-${sheetIdx}-${i})`}>
                                  {c.artUrl === "img" ? (
                                    <image href={c.artData} x={artX} y={artY} width={d} height={d} preserveAspectRatio="xMidYMid meet" />
                                  ) : (
                                    <image href={`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(c.artData)))}`} x={artX} y={artY} width={d} height={d} preserveAspectRatio="xMidYMid meet" />
                                  )}
                                </g>
                              </>}
                              {!c.artData && <text x={ccx} y={ccy} textAnchor="middle" dominantBaseline="middle"
                                fontSize={rr * 0.5} fill="#ccc" fontFamily="sans-serif">{globalIdx + 1}</text>}
                            </g>;
                          }
                          const artX = cellX + safe + c.artOffX * MM;
                          const artY = cellY + safe + c.artOffY * MM;
                          const artW = (cellW - safe * 2) * scale;
                          const artH = (cellH - safe * 2) * scale;
                          return <g key={i}>
                            {safe > 0 && <rect x={cellX + safe} y={cellY + safe} width={cellW - safe * 2} height={cellH - safe * 2}
                              fill="none" stroke="#93c5fd" strokeWidth={0.2} strokeDasharray="2 1" opacity={0.5} />}
                            {c.artData && <>
                              <clipPath id={`cell-${sheetIdx}-${i}`}><rect x={cellX} y={cellY} width={cellW} height={cellH} /></clipPath>
                              <g clipPath={`url(#cell-${sheetIdx}-${i})`}>
                                {c.artUrl === "img" ? (
                                  <image href={c.artData} x={artX} y={artY} width={artW} height={artH} preserveAspectRatio="xMidYMid meet" />
                                ) : (
                                  <image href={`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(c.artData)))}`} x={artX} y={artY} width={artW} height={artH} preserveAspectRatio="xMidYMid meet" />
                                )}
                              </g>
                            </>}
                            {!c.artData && <text x={cellX + cellW / 2} y={cellY + cellH / 2} textAnchor="middle" dominantBaseline="middle"
                              fontSize={Math.min(cellW, cellH) * 0.25} fill="#ccc" fontFamily="sans-serif">{globalIdx + 1}</text>}
                          </g>;
                        })}
                        {/* Cut lines */}
                        {isCircle && Array.from({ length: cellsOnSheet }, (_, i) => {
                          const col = i % cols, row = Math.floor(i / cols);
                          const ccx = offX + col * (cellW + gX) + cellW / 2;
                          const ccy = offY + row * (cellH + gY) + cellH / 2;
                          const rr = Math.min(cellW, cellH) / 2;
                          return <circle key={`c${i}`} cx={ccx} cy={ccy} r={rr} fill="none" stroke={c.cutColor} strokeWidth={c.cutWidth * MM} />;
                        })}
                        {!isCircle && Array.from({ length: sheetRows + 1 }, (_, r) => {
                          const yPos = r === sheetRows ? offY + (sheetRows - 1) * (cellH + gY) + cellH : offY + r * (cellH + gY);
                          return <line key={`h${r}`} x1={offX} y1={yPos} x2={offX + usedW} y2={yPos} stroke={c.cutColor} strokeWidth={c.cutWidth * MM} />;
                        })}
                        {!isCircle && Array.from({ length: cols + 1 }, (_, col) => {
                          const xPos = col === cols ? offX + (cols - 1) * (cellW + gX) + cellW : offX + col * (cellW + gX);
                          return <line key={`v${col}`} x1={xPos} y1={offY} x2={xPos} y2={offY + (sheetRows * cellH + (sheetRows - 1) * gY)} stroke={c.cutColor} strokeWidth={c.cutWidth * MM} />;
                        })}
                      </svg>
                    </div>;
                  })}
                </div>
              </div>
            </div>

            {/* LAYOUT AUTOMÁTICO DAS CARTELAS */}
            {c.generatedPdfs?.length > 0 && <div style={{ marginTop: 32, borderTop: "1px solid var(--brd)", paddingTop: 24 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                <div>
                  <h2 style={{ fontSize: 20, fontWeight: 700, display: "flex", alignItems: "center", gap: 10 }}>
                    <I n="layout" s={22} /> Layout de Impressão
                  </h2>
                  <p style={{ color: "var(--t2)", fontSize: 13 }}>{c.generatedPdfs.length} PDF(s) na fila — combine em folhas otimizadas para impressão</p>
                </div>
                <button className="bs" onClick={() => { upC("generatedPdfs", []); upC("printResults", []); }}
                  style={{ padding: "8px 16px", color: "#f87171", borderColor: "rgba(248,113,113,.3)" }}>
                  <I n="trash" s={14} /> Limpar fila
                </button>
              </div>

              {/* Limite config */}
              <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 14, marginBottom: 20 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--t2)", marginBottom: 8 }}>Limite da folha de impressão (mm)</div>
                <div style={{ display: "flex", gap: 8 }}>
                  {[500, 700, 1000, 1200].map(v => (
                    <button key={v} onClick={() => upC("printLimit", v)} style={{
                      padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "mono",
                      border: (c.printLimit || 1000) === v ? "2px solid var(--accent)" : "1px solid var(--brd)",
                      background: (c.printLimit || 1000) === v ? "rgba(232,93,58,.15)" : "var(--inp)",
                      color: (c.printLimit || 1000) === v ? "#ff7b5c" : "var(--t2)",
                    }}>{v}mm</button>
                  ))}
                  <input type="number" value={c.printLimit || 1000} onChange={e => upC("printLimit", Math.max(100, parseInt(e.target.value) || 1000))}
                    style={{ width: 80, padding: "8px 10px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 13, fontFamily: "mono", textAlign: "center" }} />
                </div>
              </div>

              {/* Generate layout button */}
              <button className="bp" onClick={async () => {
                upC("printProcessing", true);
                upC("printResults", []);
                try {
                  const { PDFDocument } = await import("https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm");
                  const MM_TO_PT = 2.83465;
                  const limit = (c.printLimit || 1000) * MM_TO_PT;

                  // Bin-packing layout using pre-generated PDFs
                  let remaining = [...c.generatedPdfs];
                  const results = [];
                  let partIdx = 1;

                  while (remaining.length > 0) {
                    const placed = [];
                    let xCur = 0, yCur = 0, maxRowH = 0, maxW = 0;
                    const next = [];

                    for (const item of remaining) {
                      if (xCur + item.width > limit) {
                        xCur = 0;
                        yCur += maxRowH;
                        maxRowH = 0;
                      }
                      if (yCur + item.height <= limit) {
                        placed.push({ ...item, x: xCur, y: yCur });
                        xCur += item.width;
                        maxW = Math.max(maxW, xCur);
                        maxRowH = Math.max(maxRowH, item.height);
                      } else {
                        next.push(item);
                      }
                    }

                    if (placed.length > 0) {
                      const totalH = yCur + maxRowH;
                      const totalW = maxW;
                      const doc = await PDFDocument.create();
                      const page = doc.addPage([totalW, totalH]);

                      for (const item of placed) {
                        const srcDoc = await PDFDocument.load(item.bytes);
                        const [embedded] = await doc.embedPages(srcDoc.getPages());
                        page.drawPage(embedded, {
                          x: item.x,
                          y: totalH - item.y - item.height,
                          width: item.width,
                          height: item.height,
                        });
                      }

                      const pdfBytes = await doc.save();
                      results.push({
                        name: `layout_cartelas_${partIdx}.pdf`,
                        blob: new Blob([pdfBytes], { type: "application/pdf" }),
                        widthMm: totalW / MM_TO_PT,
                        heightMm: totalH / MM_TO_PT,
                        items: placed,
                        totalW, totalH,
                      });
                      partIdx++;
                    }
                    remaining = next;
                  }
                  upC("printResults", results);
                } catch (err) {
                  alert("Erro ao gerar layout: " + err.message);
                  console.error(err);
                }
                upC("printProcessing", false);
              }} disabled={c.printProcessing}
                style={{ width: "100%", padding: "16px", marginBottom: 20, fontSize: 16, background: c.printProcessing ? "var(--t3)" : undefined }}>
                <I n="layout" s={20} /> {c.printProcessing ? "Processando..." : `Gerar Layout (${c.generatedPdfs.length} cartelas de ${c.sheetW}×${c.sheetH}mm)`}
              </button>

              {/* Results */}
              {c.printResults?.length > 0 && (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                    <h3 style={{ fontSize: 16, fontWeight: 700 }}>Resultado — {c.printResults.length} folha(s) de impressão</h3>
                    <button className="bp" onClick={async () => {
                      if (c.printResults.length === 1) {
                        const r = c.printResults[0];
                        const url = URL.createObjectURL(r.blob);
                        const a = document.createElement("a"); a.href = url; a.download = r.name; a.click();
                        URL.revokeObjectURL(url);
                      } else {
                        const JSZip = (await import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm")).default;
                        const zip = new JSZip();
                        for (const r of c.printResults) zip.file(r.name, r.blob);
                        const zipBlob = await zip.generateAsync({ type: "blob" });
                        const url = URL.createObjectURL(zipBlob);
                        const a = document.createElement("a"); a.href = url; a.download = `layout_cartelas.zip`; a.click();
                        URL.revokeObjectURL(url);
                      }
                    }} style={{ padding: "10px 20px" }}>
                      <I n="download" s={16} /> {c.printResults.length === 1 ? "Baixar PDF" : "Baixar ZIP"}
                    </button>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
                    {c.printResults.map((r, i) => (
                      <div key={i} style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 16 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 14 }}>{r.name}</div>
                            <div style={{ fontSize: 12, color: "var(--t2)", marginTop: 2 }}>{r.widthMm.toFixed(1)}mm × {r.heightMm.toFixed(1)}mm · {r.items.length} cartela(s)</div>
                          </div>
                          <button className="bs" onClick={() => {
                            const url = URL.createObjectURL(r.blob);
                            const a = document.createElement("a"); a.href = url; a.download = r.name; a.click();
                            URL.revokeObjectURL(url);
                          }} style={{ padding: "6px 12px" }}>
                            <I n="download" s={14} />
                          </button>
                        </div>
                        {/* Visual preview */}
                        <div style={{ background: "#fff", borderRadius: 8, padding: 8 }}>
                          {(() => {
                            const scale = 260 / Math.max(r.totalW, r.totalH);
                            return (
                              <svg width={r.totalW * scale} height={r.totalH * scale} viewBox={`0 0 ${r.totalW} ${r.totalH}`} style={{ display: "block" }}>
                                <rect x={0} y={0} width={r.totalW} height={r.totalH} fill="#f0f0f0" stroke="#ccc" strokeWidth={r.totalW * 0.003} />
                                {r.items.map((item, j) => {
                                  const colors = ["#e85d3a33", "#34d39933", "#a78bfa33", "#fbbf2433", "#f472b633", "#60a5fa33"];
                                  return (
                                    <g key={j}>
                                      <rect x={item.x} y={item.y} width={item.width} height={item.height}
                                        fill={colors[j % colors.length]} stroke="#666" strokeWidth={r.totalW * 0.002} />
                                      <text x={item.x + item.width / 2} y={item.y + item.height / 2}
                                        textAnchor="middle" dominantBaseline="middle"
                                        fontSize={Math.min(item.width, item.height) * 0.15} fill="#333" fontFamily="sans-serif">
                                        {item.name.replace(".pdf", "")}
                                      </text>
                                    </g>
                                  );
                                })}
                              </svg>
                            );
                          })()}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>}
          </div>;
        })()}

        {/* HELP / MANUAL */}
        {tab === "help" && <div style={{ animation: "fadeIn .3s", maxWidth: 800 }}>
          <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4, display: "flex", alignItems: "center", gap: 10 }}>
            <I n="help" s={24} /> Manual do Sistema
          </h2>
          <p style={{ color: "var(--t2)", fontSize: 13, marginBottom: 24 }}>Guia completo de como utilizar o Sticker Studio</p>

          {[
            { title: "1. Modelos", icon: "grid", color: "#e85d3a", content: [
              { q: "O que são os modelos?", a: "São os 35 templates de adesivos disponíveis (DICIO e MOD001-MOD031). Cada modelo tem seu próprio SVG, fonte e configuração de layout." },
              { q: "Como selecionar um modelo?", a: "Clique no card do modelo na galeria. Se já estiver configurado (com SVG), vai direto para a aba Gerar. Se não, vai para Configurar." },
              { q: "Como renomear um modelo?", a: "Clique no ícone de lápis ao lado do nome do modelo na galeria. Digite o novo nome e confirme." },
            ]},
            { title: "2. Configurar", icon: "settings", color: "#34d399", content: [
              { q: "Como configurar um modelo novo?", a: "Selecione o modelo, vá em Configurar. Faça upload do arquivo SVG exportado do Corel Draw e da thumbnail (imagem de preview)." },
              { q: "Como fazer upload da fonte?", a: "Na seção 'Fonte Customizada', clique em 'Upload .TTF/.OTF' e selecione o arquivo da fonte utilizada no modelo." },
              { q: "O que é a Calibração?", a: "É o ajuste fino da largura máxima do texto e do tamanho da fonte. Use os sliders para ajustar até que o texto fique bem posicionado dentro dos campos do adesivo. A calibração fica salva automaticamente." },
              { q: "Por que alguns caracteres não aparecem?", a: "O Corel só embute os glyphs dos caracteres usados no documento. Faça upload do arquivo .TTF da fonte para resolver." },
            ]},
            { title: "3. Gerar", icon: "list", color: "#a78bfa", content: [
              { q: "Como gerar cartelas?", a: "Selecione o modelo, cole os nomes (um por linha) no campo de texto, defina o código do pedido e a loja. Clique em 'Gerar Cartelas'." },
              { q: "Posso usar maiúsculas e minúsculas?", a: "Sim! O sistema aceita ambas. Digite os nomes exatamente como devem aparecer nos adesivos." },
              { q: "Como ajustar a fonte de um nome específico?", a: "Na lista de nomes, clique no ícone de fonte ao lado do nome para ajustar o tamanho individualmente." },
              { q: "O que acontece com nomes longos?", a: "Nomes que excedem a largura máxima são automaticamente quebrados em 2 linhas, buscando o split mais equilibrado." },
            ]},
            { title: "4. Preview", icon: "eye", color: "#fbbf24", content: [
              { q: "O que posso fazer no Preview?", a: "Visualizar as cartelas geradas, navegar entre elas, e fazer download em SVG ou PNG. Também pode adicionar à fila de impressão." },
              { q: "Como adicionar à fila?", a: "Clique no botão 'Adicionar à fila' no Preview. Todas as cartelas serão enviadas para a fila de impressão." },
            ]},
            { title: "5. Impressão + Layout", icon: "printer", color: "#f472b6", content: [
              { q: "Como funciona a fila de impressão?", a: "A fila acumula todas as cartelas adicionadas. Quando estiver pronto, clique em 'Gerar PDF' para criar os PDFs." },
              { q: "O que é o Layout Automático?", a: "Após gerar os PDFs, eles são enviados automaticamente para o Layout Automático. Ele combina múltiplos PDFs em folhas otimizadas respeitando o limite de tamanho (padrão: 1000mm)." },
              { q: "Como usar o Layout?", a: "1) Gere os PDFs da fila (ou adicione PDFs manualmente). 2) Escolha o limite da folha. 3) Clique em 'Gerar Layout'. 4) Baixe o resultado em PDF ou ZIP." },
              { q: "Posso adicionar PDFs externos?", a: "Sim! Use o botão 'Adicionar PDFs' na seção Layout Automático para incluir PDFs de qualquer fonte." },
            ]},
            { title: "6. Pedidos", icon: "clipboard", color: "#60a5fa", content: [
              { q: "Como importar pedidos?", a: "Clique em 'Importar Etiquetas' e selecione os PDFs das etiquetas de envio da Shopee. O sistema extrai automaticamente: pedido, loja, data de envio e modelos/quantidades." },
              { q: "O que significa 'SEM ARTE'?", a: "Indica que o pedido ainda não tem o arquivo de arte/modelo definido. Clique no ícone de alerta para marcar/desmarcar." },
              { q: "Como marcar pedido como feito?", a: "Clique no checkbox na coluna 'Status'. Pedidos feitos vão para a seção 'Concluídos' abaixo." },
              { q: "Como copiar código do pedido?", a: "Clique no ícone de cópia ao lado do número do pedido. Para copiar todos os códigos pendentes, use o botão 'Copiar todos' na seção de concluídos." },
              { q: "Como renomear o modelo de um pedido?", a: "Clique no ícone de lápis ao lado do nome do modelo na tabela de pedidos." },
            ]},
            { title: "7. Lojas", icon: "pkg", color: "#f59e0b", content: [
              { q: "Quais lojas estão cadastradas?", a: "TR Etiquetas, Jd Adesivos, Casa do Condi, VM Adesivos e IG Stickers." },
              { q: "Como selecionar a loja?", a: "Na aba Gerar, selecione a loja no dropdown antes de gerar as cartelas." },
            ]},
          ].map((section, si) => (
            <div key={si} style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", marginBottom: 16, overflow: "hidden" }}>
              <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--brd)", display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: `${section.color}20`, display: "flex", alignItems: "center", justifyContent: "center", color: section.color }}>
                  <I n={section.icon} s={16} />
                </div>
                <h3 style={{ fontSize: 16, fontWeight: 700 }}>{section.title}</h3>
              </div>
              <div style={{ padding: "12px 20px" }}>
                {section.content.map((item, qi) => (
                  <div key={qi} style={{ padding: "12px 0", borderBottom: qi < section.content.length - 1 ? "1px solid var(--brd)" : "none" }}>
                    <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6, color: section.color }}>{item.q}</div>
                    <div style={{ fontSize: 13, color: "var(--t2)", lineHeight: 1.6 }}>{item.a}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 20, marginTop: 8, textAlign: "center" }}>
            <p style={{ color: "var(--t2)", fontSize: 13 }}>
              Dúvidas ou problemas? Entre em contato com o administrador do sistema.
            </p>
            <p style={{ color: "var(--t3)", fontSize: 11, marginTop: 8 }}>
              Sticker Studio v1.0 · {models.filter(m => m.svgData).length} modelos configurados
            </p>
          </div>
        </div>}

      </main>

      <footer style={{ padding: "16px 32px", borderTop: "1px solid var(--brd)", display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--t3)" }}>
        <span>Sticker Studio · Shopee</span>
        <span>{models.filter(m => m.svgData).length}/{models.length} modelos</span>
      </footer>
    </div>
  );
}
