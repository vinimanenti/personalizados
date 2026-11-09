import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from "react";
import * as db from "./lib/db";
import { getUsers, refreshUsers, updateUsers } from "./lib/users";
const PrintLab = lazy(() => import("./PrintLab"));
const NameLabels = lazy(() => import("./components/NameLabels"));
const Vectorize = lazy(() => import("./components/Vectorize"));
const Upscale = lazy(() => import("./components/Upscale"));
import { sendFiles } from "./lib/art-handoff";
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
const CONTOUR_MODELS = new Set(["MOD007", "MOD008", "MOD009"]); // models with text-contour die-cut
const DARK_CONTOUR_MODELS = new Set(["MOD008"]); // contour models with black bg + white text
const MULTI_VARIANT_MODELS = new Set(["MOD031"]); // models with 2 SVG variants + font selector
// Font options for MULTI_VARIANT_MODELS (key = font file stem under public/fonts/, label = display name, family = CSS font-family)
const FONT_OPTIONS = [
  { key: "amatic", file: "amatic.ttf", family: "Amatic SC", label: "Amatic SC" },
  { key: "creamcake", file: "creamcake.otf", family: "Cream Cake", label: "Cream Cake" },
  { key: "farmhouse", file: "farmhouse.otf", family: "Farmhouse", label: "Farmhouse" },
  { key: "fondyscript", file: "fondyscript.ttf", family: "FondyScript", label: "Fondy Script" },
  { key: "greatvibes", file: "greatvibes.ttf", family: "Great Vibes", label: "Great Vibes" },
  { key: "mtcorsiva", file: "mtcorsiva.ttf", family: "Monotype Corsiva", label: "Monotype Corsiva" },
];
// Preloaded base64 for @font-face embedding in generated SVGs
const fontB64Map = {}; // { fontKey: base64String }
let cookieFontB64 = null; // preloaded Cookie font base64 for SVG embedding
let comfortaaFontB64 = null; // preloaded Comfortaa font base64 for SVG embedding
let comfortaaBoldFontB64 = null; // preloaded Comfortaa Bold font base64
// Cache for user-uploaded custom fonts (keyed by font-family name)
// Populated on demand when a model with fontUrl is selected.
const customFontB64Map = {}; // { fontUrl: { b64, format } } — keyed per-model via Supabase storage URL for isolation

/* ─── SVG analysis ─── */
const analyzeSvg = (svgText) => {
  const fieldMap = {};
  let m; // shared cursor for regex exec loops throughout this function
  // Parse via DOMParser so we can compose ancestor <g transform="..."> matrices —
  // critical for CorelDraw exports like MOD016 where each <text> lives inside
  // <g transform="matrix(1 0 0 1 TX TY)"> with local x="-5509.99" y="1279.91"
  // identical across all 3 stickers. Without transforms the fields would all
  // share the same local point and couldn't be matched to their sticker container.
  const parseTransformLocal = (str) => {
    let M = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    if (!str) return M;
    const compose = (A, B) => ({
      a: A.a * B.a + A.c * B.b, b: A.b * B.a + A.d * B.b,
      c: A.a * B.c + A.c * B.d, d: A.b * B.c + A.d * B.d,
      e: A.a * B.e + A.c * B.f + A.e, f: A.b * B.e + A.d * B.f + A.f,
    });
    const opRe = /(matrix|translate|scale|rotate)\s*\(([^)]*)\)/gi;
    let mm;
    while ((mm = opRe.exec(str)) !== null) {
      const op = mm[1].toLowerCase();
      const n = mm[2].split(/[\s,]+/).filter(Boolean).map(Number);
      let B = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
      if (op === "matrix" && n.length >= 6) B = { a: n[0], b: n[1], c: n[2], d: n[3], e: n[4], f: n[5] };
      else if (op === "translate") B = { a: 1, b: 0, c: 0, d: 1, e: n[0] || 0, f: n[1] || 0 };
      else if (op === "scale") { const sx = n[0] || 1; B = { a: sx, b: 0, c: 0, d: n[1] !== undefined ? n[1] : sx, e: 0, f: 0 }; }
      else if (op === "rotate") { const r = (n[0] || 0) * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r); B = { a: cs, b: sn, c: -sn, d: cs, e: 0, f: 0 }; }
      M = compose(M, B);
    }
    return M;
  };
  const ancestorMatrix = (el) => {
    let M = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const compose = (A, B) => ({
      a: A.a * B.a + A.c * B.b, b: A.b * B.a + A.d * B.b,
      c: A.a * B.c + A.c * B.d, d: A.b * B.c + A.d * B.d,
      e: A.a * B.e + A.c * B.f + A.e, f: A.b * B.e + A.d * B.f + A.f,
    });
    const chain = [];
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const tr = cur.getAttribute && cur.getAttribute("transform");
      if (tr) chain.unshift(parseTransformLocal(tr));
      cur = cur.parentNode;
    }
    for (const t of chain) M = compose(M, t);
    return M;
  };
  let _domDoc = null;
  try { _domDoc = new DOMParser().parseFromString(svgText, "image/svg+xml"); } catch {}
  const hasDom = _domDoc && _domDoc.getElementsByTagName("parsererror").length === 0;
  if (hasDom) {
    for (const el of Array.from(_domDoc.getElementsByTagName("text"))) {
      const id = el.getAttribute("id") || "";
      if (!/^campo_nome_\d+$/.test(id)) continue;
      const lx = parseFloat(el.getAttribute("x"));
      const ly = parseFloat(el.getAttribute("y"));
      if (isNaN(lx) || isNaN(ly)) continue;
      const M = ancestorMatrix(el);
      // Store LOCAL coords (injectNames writes back into the same group, so it
      // needs local coords). Tag each position with the ancestor matrix so the
      // container-matching step below can project to world space when needed.
      const content = (el.textContent || "").trim();
      if (!fieldMap[id]) fieldMap[id] = [];
      fieldMap[id].push({ x: lx, y: ly, content, _M: M });
    }
  } else {
    // Regex fallback if DOMParser couldn't parse
    const re = /<text\s[^>]*id="(campo_nome_\d+)"[^>]*x="([^"]*)"[^>]*y="([^"]*)"[^>]*>([^<]*)<\/text>/g;
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
  }

  // Also detect paths with campo_nome id (CorelDraw sometimes exports text as path)
  // Also handle grouped paths: <g id="campo_nome_X"><path d="..."/>...</g>
  // Accept any id starting with campo_nome_ including CorelDraw duplicates like campo_nome_6_536
  const pathRe = /<path\s[^>]*id="(campo_nome_[\w]+)"[^>]*\sd="([^"]+)"/g;
  const pathRe2 = /<path\s[^>]*\sd="([^"]+)"[^>]*\sid="(campo_nome_[\w]+)"/g;
  const groupRe = /<g\s[^>]*id="(campo_nome_[\w]+)"[^>]*>([\s\S]*?)<\/g>/g;
  const computePathBBox = (d) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let curX = 0, curY = 0;
    const numRe = /([MLCQSTAZHVmlcqstahvz])|(-?[0-9]*\.?[0-9]+(?:e[+-]?[0-9]+)?)/gi;
    let cmd = "M", tok;
    const nums = [];
    const flush = () => {
      const updateXY = (x, y) => {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      };
      if (cmd === "M" || cmd === "L" || cmd === "T") {
        for (let i = 0; i < nums.length - 1; i += 2) { curX = nums[i]; curY = nums[i + 1]; updateXY(curX, curY); }
      } else if (cmd === "m" || cmd === "l" || cmd === "t") {
        for (let i = 0; i < nums.length - 1; i += 2) { curX += nums[i]; curY += nums[i + 1]; updateXY(curX, curY); }
      } else if (cmd === "C") {
        for (let i = 0; i < nums.length - 5; i += 6) { curX = nums[i + 4]; curY = nums[i + 5]; updateXY(nums[i], nums[i + 1]); updateXY(nums[i + 2], nums[i + 3]); updateXY(curX, curY); }
      } else if (cmd === "c") {
        for (let i = 0; i < nums.length - 5; i += 6) { updateXY(curX + nums[i], curY + nums[i + 1]); updateXY(curX + nums[i + 2], curY + nums[i + 3]); curX += nums[i + 4]; curY += nums[i + 5]; updateXY(curX, curY); }
      } else if (cmd === "Q" || cmd === "S") {
        for (let i = 0; i < nums.length - 3; i += 4) { updateXY(nums[i], nums[i + 1]); curX = nums[i + 2]; curY = nums[i + 3]; updateXY(curX, curY); }
      } else if (cmd === "q" || cmd === "s") {
        for (let i = 0; i < nums.length - 3; i += 4) { updateXY(curX + nums[i], curY + nums[i + 1]); curX += nums[i + 2]; curY += nums[i + 3]; updateXY(curX, curY); }
      } else if (cmd === "H") { for (const n of nums) { curX = n; updateXY(curX, curY); } }
      else if (cmd === "h") { for (const n of nums) { curX += n; updateXY(curX, curY); } }
      else if (cmd === "V") { for (const n of nums) { curY = n; updateXY(curX, curY); } }
      else if (cmd === "v") { for (const n of nums) { curY += n; updateXY(curX, curY); } }
      nums.length = 0;
    };
    while ((tok = numRe.exec(d)) !== null) {
      if (tok[1]) { flush(); cmd = tok[1]; }
      else nums.push(parseFloat(tok[2]));
    }
    flush();
    return isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  };
  const addPathField = (name, d, content = "") => {
    if (fieldMap[name]) return; // text version wins
    const bb = computePathBBox(d);
    if (!bb) return;
    // y for <text> is the baseline. For typical Latin text, baseline is near bottom of glyphs.
    // Use maxY (bottom of path) as approximation of baseline.
    const x = bb.minX, y = bb.maxY;
    if (!fieldMap[name]) fieldMap[name] = [];
    fieldMap[name].push({ x, y, content: content.trim(), _fromPath: true, _bbox: bb });
  };
  while ((m = pathRe.exec(svgText)) !== null) addPathField(m[1], m[2]);
  while ((m = pathRe2.exec(svgText)) !== null) addPathField(m[2], m[1]);

  // CorelDraw text-to-curves: each letter becomes a separate <path>. The first letter gets
  // id="campo_nome_X", the rest get sequential ids like "_1", "_2", ..., "_10" or suffixed
  // "_1_260". We scan sequentially and group these letter-paths with their parent campo_nome.
  const fieldSiblings = {}; // { campo_nome_1: ["_1", "_2", ...], ... }
  const allPathRe = /<path\s[^>]*id="([^"]+)"[^>]*\sd="([^"]+)"[^>]*\/>/g;
  let curField = null;
  let pm2;
  while ((pm2 = allPathRe.exec(svgText)) !== null) {
    const pid = pm2[1], pd = pm2[2];
    if (/^campo_nome_/.test(pid)) {
      curField = pid;
      if (!fieldSiblings[curField]) fieldSiblings[curField] = [];
    } else if (curField && /^_\d+(_\d+)?$/.test(pid)) {
      fieldSiblings[curField].push(pid);
      // Expand the parent's bbox to include this letter-path
      const bb = computePathBBox(pd);
      if (bb && fieldMap[curField] && fieldMap[curField][0]._bbox) {
        const pbox = fieldMap[curField][0]._bbox;
        pbox.minX = Math.min(pbox.minX, bb.minX);
        pbox.minY = Math.min(pbox.minY, bb.minY);
        pbox.maxX = Math.max(pbox.maxX, bb.maxX);
        pbox.maxY = Math.max(pbox.maxY, bb.maxY);
        fieldMap[curField][0].x = pbox.minX;
        fieldMap[curField][0].y = pbox.maxY;
      }
    } else {
      curField = null;
    }
  }
  // Grouped paths: use combined bbox of all inner paths
  while ((m = groupRe.exec(svgText)) !== null) {
    const gName = m[1], gInner = m[2];
    if (fieldMap[gName]) continue;
    let gMinX = Infinity, gMinY = Infinity, gMaxX = -Infinity, gMaxY = -Infinity;
    const innerPath = /<path\s[^>]*\sd="([^"]+)"/g;
    let pm;
    while ((pm = innerPath.exec(gInner)) !== null) {
      const bb = computePathBBox(pm[1]);
      if (bb) { gMinX = Math.min(gMinX, bb.minX); gMinY = Math.min(gMinY, bb.minY); gMaxX = Math.max(gMaxX, bb.maxX); gMaxY = Math.max(gMaxY, bb.maxY); }
    }
    if (isFinite(gMinX)) {
      fieldMap[gName] = [{ x: gMinX, y: gMaxY, content: "", _fromPath: true, _bbox: { minX: gMinX, minY: gMinY, maxX: gMaxX, maxY: gMaxY } }];
    }
  }
  // Sort fields: primarily by source order (y then x of first occurrence) — works for both
  // well-numbered ids and CorelDraw-duplicated ids like campo_nome_6_536
  const fields = Object.keys(fieldMap).sort((a, b) => {
    const pa = fieldMap[a][0], pb = fieldMap[b][0];
    const parts = s => s.split("_").slice(2).map(p => parseInt(p) || 0);
    const na = parts(a), nb = parts(b);
    for (let i = 0; i < Math.max(na.length, nb.length); i++) {
      const da = na[i] || 0, db = nb[i] || 0;
      if (da !== db) return da - db;
    }
    if (Math.abs(pa.y - pb.y) > 50) return pa.y - pb.y;
    return pa.x - pb.x;
  }).map(name => ({ name, occurrences: fieldMap[name].length, positions: fieldMap[name] }));

  // Detect fnt class PER FIELD for multi-type layouts
  const fieldFntMap = {}; // { campo_nome_1: "fnt1", campo_nome_2: "fnt0", ... }
  // Find the FIRST fnt class that actually exists in CSS (fallback for path fields)
  const cssClassRe = /\.(fnt\d+)\s*\{/g;
  const availableFntClasses = [];
  let ccm;
  while ((ccm = cssClassRe.exec(svgText)) !== null) availableFntClasses.push(ccm[1]);
  const defaultFnt = availableFntClasses[0] || "fnt0";
  for (const f of fields) {
    // Try both attribute orders: id before class, and class before id (for <text>)
    const re1 = new RegExp(`<text[^>]*id="${f.name}"[^>]*class="([^"]*)"`);
    const re2cls = new RegExp(`<text[^>]*class="([^"]*)"[^>]*id="${f.name}"`);
    // Also check <path> and <g> elements (when text was exported as curves)
    const re3 = new RegExp(`<path[^>]*id="${f.name}"[^>]*class="([^"]*)"`);
    const re4 = new RegExp(`<path[^>]*class="([^"]*)"[^>]*id="${f.name}"`);
    const re5 = new RegExp(`<g[^>]*id="${f.name}"[^>]*class="([^"]*)"`);
    const pm = svgText.match(re1) || svgText.match(re2cls) || svgText.match(re3) || svgText.match(re4) || svgText.match(re5);
    const cls = pm ? pm[1] : "";
    const fntMatch = cls.match(/fnt(\d+)/);
    fieldFntMap[f.name] = fntMatch ? `fnt${fntMatch[1]}` : defaultFnt;
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

  // Default maxWidth scales with viewBox — CorelDraw exports use viewBox ~10000+,
  // Illustrator exports often use ~300. A fixed default like 3600 was too small for
  // the former and absurdly too big for the latter. Use ~25% of viewBox width as a
  // sane starting point (the user calibrates from there).
  const vbMatchW = svgText.match(/viewBox="[^"]*\s([0-9.]+)\s[0-9.]+"/);
  const vbWidth = vbMatchW ? parseFloat(vbMatchW[1]) : 10000;
  const defaultMaxW = Math.round(vbWidth * 0.25);

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
        maxWidth: defaultMaxW,
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
      maxWidth: defaultMaxW,
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
  // Size thresholds scale with the viewBox — CorelDraw exports use viewBox ~10000+,
  // Illustrator often ~300. Fixed thresholds of 100-200 would reject every shape on
  // small templates or accept noise on big ones.
  const vbSz = svgText.match(/viewBox="[^"]*\s([0-9.]+)\s([0-9.]+)"/);
  const vbW = vbSz ? parseFloat(vbSz[1]) : 10000;
  const vbH = vbSz ? parseFloat(vbSz[2]) : 10000;
  const minShapeW = vbW * 0.05; // at least 5% of viewBox width
  const minShapeH = vbH * 0.03;
  const minCircleR = Math.min(vbW, vbH) * 0.05;
  // Rectangles
  const rectRe = /<rect[^>]*\bx="([^"]*)"[^>]*\by="([^"]*)"[^>]*\bwidth="([^"]*)"[^>]*\bheight="([^"]*)"/g;
  let rm;
  while ((rm = rectRe.exec(svgText)) !== null) {
    const rx = parseFloat(rm[1]), ry = parseFloat(rm[2]), rw = parseFloat(rm[3]), rh = parseFloat(rm[4]);
    if (rw > minShapeW && rh > minShapeH) containers.push({ x: rx, y: ry, w: rw, h: rh, cx: rx + rw / 2, cy: ry + rh / 2, type: "rect" });
  }
  // Circles — deduplicate by center (CorelDraw often doubles circles for stroke+fill)
  const circRe = /<circle[^>]*\bcx="([^"]*)"[^>]*\bcy="([^"]*)"[^>]*\br="([^"]*)"/g;
  const seenCircles = new Set();
  while ((rm = circRe.exec(svgText)) !== null) {
    const cx = parseFloat(rm[1]), cy = parseFloat(rm[2]), r = parseFloat(rm[3]);
    if (r > minCircleR) {
      const key = `${Math.round(cx)}_${Math.round(cy)}`;
      if (!seenCircles.has(key)) {
        seenCircles.add(key);
        containers.push({ x: cx - r, y: cy - r, w: r * 2, h: r * 2, cx, cy, type: "circle" });
      }
    }
  }

  // ClipPaths — extract bounding box from path data inside <clipPath> (organic sticker shapes)
  // Reuse computePathBBox (which correctly handles cubic/quadratic Bezier per SVG spec)
  if (containers.length < fields.length) {
    const clipRe = /<clipPath[^>]*>[\s\S]*?<path\s[^>]*d="([^"]+)"[\s\S]*?<\/clipPath>/g;
    let cm;
    while ((cm = clipRe.exec(svgText)) !== null) {
      const bb = computePathBBox(cm[1]);
      if (!bb) continue;
      const cw = bb.maxX - bb.minX, ch = bb.maxY - bb.minY;
      if (cw > minShapeW && ch > minShapeH) {
        const key = `${Math.round(bb.minX + cw / 2)}_${Math.round(bb.minY + ch / 2)}`;
        if (!containers.some(c => `${Math.round(c.cx)}_${Math.round(c.cy)}` === key)) {
          containers.push({ x: bb.minX, y: bb.minY, w: cw, h: ch, cx: bb.minX + cw / 2, cy: bb.minY + ch / 2, type: "clip" });
        }
      }
    }
  }

  // Cut paths (<path class="...strN...">) — each sticker's cut outline is a
  // dedicated vector path with the CutContour stroke class. Illustrator exports
  // don't emit <rect>/<circle>/<clipPath> for sticker bounds, so these are our
  // only reliable container source on those templates (e.g. new MOD017).
  if (containers.length < fields.length) {
    const strPathRe = /<path\s[^>]*class="[^"]*\bstr\d+\b[^"]*"[^>]*\bd="([^"]+)"/g;
    const strPathRe2 = /<path\s[^>]*\bd="([^"]+)"[^>]*class="[^"]*\bstr\d+\b[^"]*"/g;
    const seenCuts = new Set();
    const addFromMatch = (d) => {
      const bb = computePathBBox(d);
      if (!bb) return;
      const cw = bb.maxX - bb.minX, ch = bb.maxY - bb.minY;
      if (cw <= minShapeW || ch <= minShapeH) return;
      const key = `${Math.round(bb.minX + cw / 2)}_${Math.round(bb.minY + ch / 2)}`;
      if (seenCuts.has(key)) return;
      seenCuts.add(key);
      if (!containers.some(c => `${Math.round(c.cx)}_${Math.round(c.cy)}` === key)) {
        containers.push({ x: bb.minX, y: bb.minY, w: cw, h: ch, cx: bb.minX + cw / 2, cy: bb.minY + ch / 2, type: "cut" });
      }
    };
    let mm;
    while ((mm = strPathRe.exec(svgText)) !== null) addFromMatch(mm[1]);
    while ((mm = strPathRe2.exec(svgText)) !== null) addFromMatch(mm[1]);
  }

  // Prefer the shape collection that matches the number of fields best.
  // Cut-path containers are Illustrator's equivalent of CorelDraw clipPaths.
  const circles = containers.filter(c => c.type === "circle");
  const clips = containers.filter(c => c.type === "clip");
  const cuts = containers.filter(c => c.type === "cut");
  const rects = containers.filter(c => c.type === "rect");
  const shapes =
    circles.length >= fields.length ? circles :
    clips.length   >= fields.length ? clips   :
    cuts.length    >= fields.length ? cuts    :
    (rects.length > 1 ? rects : containers);

  // Compute text centers: use containing shape center if found, else fallback to glyph measurement
  const measureW = (text, ff, fs) => {
    const g = allGlyphMaps[ff] || primaryGlyphs;
    let t = 0;
    for (const ch of text) t += (g.glyphMap[ch] || g.defaultAdv);
    return t * fs / 1000;
  };

  const textCenters = {};
  for (const f of fields) {
    const fx = f.positions[0].x; // LOCAL x (inside any ancestor <g transform>)
    const fy = f.positions[0].y; // LOCAL y
    const M = f.positions[0]._M; // ancestor matrix (undefined for root-level texts)
    // Project local text point into world space for container matching.
    const wx = M ? (M.a * fx + M.c * fy + M.e) : fx;
    const wy = M ? (M.b * fx + M.d * fy + M.f) : fy;

    // Find the SMALLEST container that contains the WORLD-space text point.
    // This lets each sticker's text match its own cut-path/clipPath even when the
    // text's local coords are identical across stickers (MOD016 pattern).
    let best = null, bestArea = Infinity;
    for (const s of shapes) {
      const contains = wx >= s.x && wx <= s.x + s.w && wy >= s.y && wy <= s.y + s.h;
      if (contains) {
        const area = s.w * s.h;
        if (area < bestArea) { bestArea = area; best = s; }
      }
    }
    // Fallback: nearest center by Euclidean distance (still in world space)
    if (!best) {
      let bestDist = Infinity;
      for (const s of shapes) {
        const dx = wx - s.cx, dy = wy - s.cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < bestDist) { bestDist = dist; best = s; }
      }
    }
    if (best) {
      // textCenters must be in the SAME coord system injectNames writes into
      // (i.e. local, inside the ancestor group). Invert the ancestor transform's
      // x component: local_x = (world_cx - c*local_y - e) / a. For typical
      // CorelDraw translate-only matrices (a=1, c=0), this reduces to cx - e.
      if (M && Math.abs(M.a) > 1e-9) {
        textCenters[f.name] = (best.cx - M.c * fy - M.e) / M.a;
      } else {
        textCenters[f.name] = best.cx;
      }
    } else {
      // Fallback: glyph-based center (local coord)
      const fntCls = fieldFntMap[f.name];
      const ff = fntFamilyMap[fntCls] || fontFamily;
      const fs = fntSizeMap[fntCls] || fontSize;
      const w = measureW(f.positions[0].content, ff, fs);
      textCenters[f.name] = fx + w / 2;
    }
  }

  // Strip internal _M matrix annotation from positions before returning — it was
  // only needed for container matching above and would bloat the serialized model.
  for (const f of fields) {
    f.positions = f.positions.map(({ _M, ...rest }) => rest);
  }
  return { fields, fontSize, fontFamily, glyphMap, defaultAdv, textCenters, fieldTypes, fieldPerType, allGlyphMaps, fieldFntMap, fieldSiblings };
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
  const isContour = CONTOUR_MODELS.has(model.id);

  fieldNames.forEach((fieldName, idx) => {
    const name = idx < namesList.length ? namesList[idx] : "";
    // Get per-type config if available
    const typeIdx = fpt[fieldName] !== undefined ? fpt[fieldName] : 0;
    const typeConfig = ft[typeIdx] || {};
    const typeFontSize = typeConfig.fontSize || model.fontSize;
    const typeMaxWidth = typeConfig.maxWidth || model.maxWidth;
    const typeFontFamily = typeConfig.fontFamily || model.fontFamily;
    const origFontSize = typeConfig.origFontSize || typeFontSize;

    let fieldFontSize = fontOverrides[idx] !== undefined ? fontOverrides[idx] : typeFontSize;
    const fieldMaxWidth = typeMaxWidth;
    // Use fontOverride family for measurement so auto-fit/line-break matches rendered font
    const measureFamily = model.fontOverride || typeFontFamily;
    let lines = breakLines(name, measureFamily, fieldFontSize, fieldMaxWidth);
    const field = model.fields[idx];
    if (!field) return;

    // Auto-fit: shrink font size until the text fits the available width of
    // the sticker. Works regardless of font family (important for MOD031 where
    // the user picks between fonts with wildly different character widths —
    // Great Vibes/Cookie ≫ Comfortaa at the same nominal size). Mirrors the
    // logic of the Lapis Python generator: start at base size, reduce in small
    // steps until it fits, floor at a percentage of the original.
    if (name.trim()) {
      const cx = tc[fieldName];
      if (cx) {
        const allCenters = [...new Set(Object.values(tc))].sort((a, b) => a - b);
        let halfW = 0;
        if (allCenters.length > 1) {
          const ci = allCenters.indexOf(cx);
          const dLeft  = ci > 0                      ? cx - allCenters[ci - 1] : Infinity;
          const dRight = ci < allCenters.length - 1  ? allCenters[ci + 1] - cx : Infinity;
          halfW = Math.min(dLeft, dRight) * 0.48;
        }
        const vbMatch = svgText.match(/viewBox="[^"]*\s([0-9.]+)\s[0-9.]+"/);
        const vbW = vbMatch ? parseFloat(vbMatch[1]) : 0;
        if (allCenters.length <= 1 && vbW > 0) halfW = vbW * 0.42;
        if (halfW > 0) {
          const availW = halfW * 2;
          // Use the tighter of fieldMaxWidth (user-calibrated) or the physical
          // space between sticker centers, so fonts that blow up (Great Vibes)
          // shrink based on real geometry, not just calibration number.
          const targetW = fieldMaxWidth ? Math.min(fieldMaxWidth, availW) : availW;
          const maxLineW = () => Math.max(...lines.map(l => measureText(l, measureFamily, fieldFontSize)));
          // Floor: 25% of original, never below 10px. Enough headroom to fit
          // even very expansive script fonts without becoming illegible.
          const minSize = Math.max(10, origFontSize * 0.25);
          // Step: 4% shrink per iteration. With 200 max iterations, can scale
          // down to ~0.03× of original if needed (way beyond the 25% floor).
          let tries = 0;
          while (maxLineW() > targetW && fieldFontSize > minSize && tries < 200) {
            fieldFontSize *= 0.96;
            lines = breakLines(name, measureFamily, fieldFontSize, targetW);
            tries++;
          }
          // If still overflowing at the minimum size, let it overflow slightly
          // rather than shrinking into illegibility — the operator can bump the
          // calibration width up if this happens often.
        }
      }
    }

    const customSize = Math.abs(fieldFontSize - origFontSize) > 1;
    const fontOverride = model.fontOverride; // optional CSS family override (MOD031)
    const styleParts = [];
    if (customSize) styleParts.push(`font-size:${fieldFontSize}px`);
    if (fontOverride) styleParts.push(`font-family:'${fontOverride}'`);
    const sizeStyle = styleParts.length ? ` style="${styleParts.join(';')}"` : "";

    const removeRe = new RegExp(`<text\\s[^>]*id="${fieldName}"[^>]*>[^<]*<\\/text>`, "g");
    let matches = [...svg.matchAll(removeRe)];
    // Fallback: if the field was exported as <path> (CorelDraw sometimes does this for text)
    // or as a <g id="..."> containing paths, match and remove those instead.
    let isPathField = false;
    let removeRegexes = [removeRe];
    if (matches.length === 0) {
      const pathRe = new RegExp(`<path\\s[^>]*id="${fieldName}"[^>]*\\/>`, "g");
      const pathRe2 = new RegExp(`<path\\s[^>]*id="${fieldName}"[^>]*>[^<]*<\\/path>`, "g");
      const groupRe = new RegExp(`<g\\s[^>]*id="${fieldName}"[^>]*>[\\s\\S]*?<\\/g>`, "g");
      matches = [...svg.matchAll(pathRe), ...svg.matchAll(pathRe2), ...svg.matchAll(groupRe)];
      if (matches.length === 0) return;
      isPathField = true;
      removeRegexes = [pathRe, pathRe2, groupRe];
    }

    const firstPos = field.positions[0];
    // Vertical placement: when the SVG placeholder spans multiple <text> lines
    // with the same id (e.g. MOD018 has "PERSONALIZE" + "AQUI" stacked), using
    // only the first line's y leaves the replacement text visually above the
    // sticker's vertical center. Average the y's so a single-line name lands on
    // the visual midpoint of the original two-line block.
    const baseY = field.positions.length > 1
      ? field.positions.reduce((s, p) => s + p.y, 0) / field.positions.length
      : firstPos.y;
    const classMatch = matches[0][0].match(/class="([^"]*)"/);
    // Build class: path fields need fnt class appended (path only has fil)
    let cls = classMatch ? classMatch[1] : "fil4 fnt0";
    if (isPathField && !/fnt\d+/.test(cls)) {
      // Path has fil but no fnt - append the fnt class detected in analyzeSvg
      const fntCls = model.fieldFntMap?.[fieldName] || "fnt0";
      cls = `${cls} ${fntCls}`.trim();
    }
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    // Text area center for this field — from sticker rect center or template measurement
    const xOffset = posOverrides[idx] || 0;
    const centerX = (tc[fieldName] || (firstPos.x + 1500)) + xOffset;

    // Helper to build a single text tag
    const mkText = (x, y, id, extraStyle, content, dataAttr) => {
      const idAttr = id ? ` id="${id}"` : "";
      const da2 = dataAttr ? ` ${dataAttr}` : "";
      const st = extraStyle ? ` style="${extraStyle}"` : sizeStyle;
      return `<text x="${x.toFixed(2)}" y="${y}" ${idAttr} class="${cls}" text-anchor="middle"${st}${da2}>${esc(content)}</text>`;
    };

    // Build replacement — for contour models, add halo + cut layers behind text
    let replacement;
    const buildLine = (x, y, id, text) => {
      if (isContour && name.trim()) {
        const isDark = DARK_CONTOUR_MODELS.has(model.id);
        const haloW = fieldFontSize * 0.45;
        const cutW = fieldFontSize * 0.02;
        const cutOuterW = haloW + cutW * 2;
        const haloColor = isDark ? "black" : "white";
        const textColor = isDark ? "white" : null;
        const cutStyle = `paint-order:stroke;stroke:#EC2A90;stroke-width:${cutOuterW.toFixed(1)}px;stroke-linejoin:round;stroke-linecap:round;fill:none${customSize ? ";font-size:" + fieldFontSize + "px" : ""}`;
        const haloStyle = `paint-order:stroke;stroke:${haloColor};stroke-width:${haloW.toFixed(1)}px;stroke-linejoin:round;stroke-linecap:round;fill:${haloColor}${customSize ? ";font-size:" + fieldFontSize + "px" : ""}`;
        const textStyle = (customSize || textColor) ? [customSize ? `font-size:${fieldFontSize}px` : "", textColor ? `fill:${textColor}` : ""].filter(Boolean).join(";") : null;
        return [
          mkText(x, y, null, cutStyle, text, 'data-contour="cut"'),
          mkText(x, y, null, haloStyle, text, 'data-contour="halo"'),
          mkText(x, y, id, textStyle, text, null),
        ].join("\n  ");
      }
      return mkText(x, y, id, null, text, null);
    };

    if (lines.length === 1) {
      replacement = buildLine(centerX, baseY, fieldName, lines[0]);
    } else {
      const lineSpacing = fieldFontSize * 0.95;
      const totalHeight = lineSpacing * (lines.length - 1);
      const startY = baseY - totalHeight / 2;
      replacement = lines.map((line, li) => {
        const y = startY + li * lineSpacing;
        return buildLine(centerX, y.toFixed(2), fieldName, line);
      }).join("\n  ");
    }

    let replaced = false;
    for (const re of removeRegexes) {
      svg = svg.replace(re, (match) => {
        if (!replaced) { replaced = true; return replacement; }
        return "";
      });
    }
    // CorelDraw text-to-curves: remove sibling letter-paths (e.g., _1, _2, ..., _10)
    // that represent the remaining letters of the original word.
    if (isPathField) {
      const siblings = (model.fieldSiblings && model.fieldSiblings[fieldName]) || [];
      for (const sid of siblings) {
        const sre = new RegExp(`<path\\s[^>]*id="${sid.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}"[^>]*\\/>`, "g");
        svg = svg.replace(sre, "");
      }
    }
  });

  // Replace codigo_pedido field if present. Fallback by inner text when
  // CorelDraw exported the <text> without an id (e.g. MOD016).
  if (model.orderCode) {
    const escCode = model.orderCode.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const pedidoReId = /(<text\s[^>]*id="codigo_pedido"[^>]*>)[^<]*(<\/text>)/g;
    let didReplace = false;
    svg = svg.replace(pedidoReId, (_m, a, b) => { didReplace = true; return `${a}${escCode}${b}`; });
    if (!didReplace) {
      const pedidoReText = /(<text\b[^>]*>)codigo_pedido(<\/text>)/g;
      svg = svg.replace(pedidoReText, `$1${escCode}$2`);
    }
  }

  // Replace campo_loja / nome_loja field if present
  if (model.store) {
    const escStore = model.store.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const lojaReId = /(<text\s[^>]*id="(?:campo_loja|nome_loja)"[^>]*>)[^<]*(<\/text>)/g;
    let didReplace = false;
    svg = svg.replace(lojaReId, (_m, a, b) => { didReplace = true; return `${a}${escStore}${b}`; });
    if (!didReplace) {
      const lojaReText = /(<text\b[^>]*>)(?:campo_loja|nome_loja)(<\/text>)/g;
      svg = svg.replace(lojaReText, `$1${escStore}$2`);
    }
  }

  // For contour models, inject Cookie font as base64 @font-face for blob URL rendering
  if (isContour && cookieFontB64) {
    const ff = `@font-face{font-family:'Cookie';src:url('data:font/truetype;base64,${cookieFontB64}') format('truetype');}`;
    if (svg.includes("<![CDATA[")) {
      svg = svg.replace("<![CDATA[", "<![CDATA[\n" + ff + "\n");
    } else {
      svg = svg.replace(/<style[^>]*>/, (m) => m + "\n" + ff + "\n");
    }
  }
  // Inject @font-face for FONT_OPTIONS that appear in the SVG (MOD031 selectable fonts)
  for (const fo of FONT_OPTIONS) {
    const b64 = fontB64Map[fo.key];
    if (!b64) continue;
    const famRe = new RegExp(`font-family:\\s*'?${fo.family.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}'?`, "i");
    if (famRe.test(svg)) {
      const fmt = fo.file.endsWith(".otf") ? "opentype" : "truetype";
      const ff = `@font-face{font-family:'${fo.family}';src:url('data:font/${fmt};base64,${b64}') format('${fmt}');}`;
      if (svg.includes("<![CDATA[")) svg = svg.replace("<![CDATA[", "<![CDATA[\n" + ff + "\n");
      else svg = svg.replace(/<style[^>]*>/, (m) => m + "\n" + ff + "\n");
    }
  }
  // Inject user-uploaded custom font (fontUrl) as @font-face so the rendered
  // SVG is self-contained (browsers dropped SVG-font <font> support).
  // Cache keyed by fontUrl (per-model) so each model embeds its own TTF.
  if (model.fontFamily && model.fontUrl && customFontB64Map[model.fontUrl]) {
    const { b64, format } = customFontB64Map[model.fontUrl];
    const ff = `@font-face{font-family:'${model.fontFamily}';src:url('data:font/${format};base64,${b64}') format('${format}');}`;
    if (svg.includes("<![CDATA[")) svg = svg.replace("<![CDATA[", "<![CDATA[\n" + ff + "\n");
    else if (/<style[^>]*>/.test(svg)) svg = svg.replace(/<style[^>]*>/, (m) => m + "\n" + ff + "\n");
    else svg = svg.replace(/<svg\b[^>]*>/, (m) => m + `<style>${ff}</style>`);
  }
  // Inject Comfortaa @font-face when SVG references it (e.g., MOD022)
  if (/font-family:\s*'?Comfortaa'?/i.test(svg)) {
    let ff = "";
    if (comfortaaFontB64) ff += `@font-face{font-family:'Comfortaa';font-weight:normal;src:url('data:font/truetype;base64,${comfortaaFontB64}') format('truetype');}`;
    if (comfortaaBoldFontB64) ff += `@font-face{font-family:'Comfortaa';font-weight:bold;src:url('data:font/truetype;base64,${comfortaaBoldFontB64}') format('truetype');}`;
    if (ff) {
      if (svg.includes("<![CDATA[")) {
        svg = svg.replace("<![CDATA[", "<![CDATA[\n" + ff + "\n");
      } else {
        svg = svg.replace(/<style[^>]*>/, (m) => m + "\n" + ff + "\n");
      }
    }
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
    "check-circle": <><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></>,
    circle: <><circle cx="12" cy="12" r="10"/></>,
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
            <input type="number" value={c.tw} onChange={e => setTc(idx, "tw", parseInt(e.target.value) || 10)} style={{ width: 70, padding: "2px 6px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 6, color, fontSize: 12, fontFamily: "mono", textAlign: "right" }} />
          </div>
          {/* Slider range adapts to template scale. 3 tiers based on origFontSize:
              small (Illustrator ~24px), medium (CorelDraw small viewBox ~90px),
              large (CorelDraw large viewBox ~500px+). Precision is finer for smaller
              ranges so calibration isn't too coarse. */}
          {(() => {
            const [twMin, twMax, twStep] =
              origFontSize < 40  ? [20, 600, 2] :
              origFontSize < 200 ? [100, 4000, 10] :
                                   [500, 8000, 50];
            return <input type="range" min={twMin} max={twMax} step={twStep} value={c.tw} onChange={e => setTc(idx, "tw", parseInt(e.target.value))} style={{ width: "100%", accentColor: color }} />;
          })()}
        </div>
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
            <label style={{ fontSize: 11, color: "var(--t2)" }}>Tamanho fonte</label>
            <input type="number" value={Math.round(c.tf * 100) / 100} onChange={e => setTc(idx, "tf", parseFloat(e.target.value) || 5)} style={{ width: 70, padding: "2px 6px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 6, color, fontSize: 12, fontFamily: "mono", textAlign: "right" }} />
          </div>
          {(() => {
            const [tfMin, tfMax, tfStep] =
              origFontSize < 40  ? [5, 100, 0.5] :
              origFontSize < 200 ? [20, 300, 1]  :
                                   [50, 1500, 5];
            return <input type="range" min={tfMin} max={tfMax} step={tfStep} value={c.tf} onChange={e => setTc(idx, "tf", parseFloat(e.target.value))} style={{ width: "100%", accentColor: color }} />;
          })()}
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
// Usuários: lista no Supabase com cópia local (src/lib/users.js).

function LoginScreen({ onLogin }) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const V = { "--bg": "#0f1117", "--card": "#181b24", "--inp": "#13151d", "--accent": "#e85d3a", "--t1": "#eaedf3", "--t2": "#7a8194", "--t3": "#4a5068", "--brd": "#262a38" };

  // Lista de usuários do Supabase antes de liberar o login
  useEffect(() => { refreshUsers().finally(() => setLoading(false)); }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    if (loading) return;
    if (!user.trim() || !pass.trim()) { setError("Preencha todos os campos"); return; }
    let u = getUsers()[user.trim()];
    // usuário criado há pouco em outro computador: busca a lista de novo antes de recusar
    if (!u || u.pass !== pass) u = (await refreshUsers())[user.trim()];
    if (u && u.pass === pass) {
      localStorage.setItem("ss_session", JSON.stringify({ user: user.trim(), role: u.role, ts: Date.now() }));
      onLogin(user.trim());
    } else {
      setError("Usuário ou senha incorretos");
    }
  };

  return (
    <div style={{ ...V, minHeight: "100vh", background: "var(--bg)", color: "var(--t1)", fontFamily: "'Outfit','Segoe UI',sans-serif", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0}textarea:focus,input:focus{outline:2px solid var(--accent);outline-offset:-1px}@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}`}</style>
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
          <button type="submit" disabled={loading} style={{ width: "100%", background: loading ? "var(--t3)" : "var(--accent)", color: "#fff", border: "none", padding: "14px", borderRadius: 10, fontWeight: 700, cursor: loading ? "wait" : "pointer", fontFamily: "inherit", fontSize: 15, transition: "all .2s" }}
            onMouseEnter={e => { if (!loading) e.currentTarget.style.background = "#ff7b5c"; }} onMouseLeave={e => { if (!loading) e.currentTarget.style.background = "var(--accent)"; }}>
            {loading ? "Conectando..." : "Entrar"}
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
  const [, setUsersVersion] = useState(0);
  useEffect(() => { if (showUserMgmt) refreshUsers().then(() => setUsersVersion(v => v + 1)); }, [showUserMgmt]);
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
  const [selectedVariant, setSelectedVariant] = useState(1); // 1 or 2 (for MULTI_VARIANT_MODELS) — Gerar tab
  const [configVariant, setConfigVariant] = useState(1); // 1 or 2 — Configurar tab calibration
  const [selectedFont, setSelectedFont] = useState(""); // font key from FONT_OPTIONS, "" = default
  const fontBytesRef = useRef({}); // {modelId: Uint8Array} font bytes in memory for PDF
  const [orderCode, setOrderCode] = useState(""); // codigo do pedido Shopee
  const [store, setStore] = useState(STORES[0]); // loja selecionada
  const [printQueue, setPrintQueue] = useState([]); // [{id, svg, label, store, orderCode, model, timestamp}]
  const [pdfGenerating, setPdfGenerating] = useState(false);
  const [dbLoading, setDbLoading] = useState(true);
  const [pedidos, setPedidos] = useState([]); // [{id, pedido, remetente, envio, modelo, quantidade, feito, obs, criadoEm}]
  const [pedidosParsing, setPedidosParsing] = useState(false);
  const [pedidoSearch, setPedidoSearch] = useState("");
  const [pedidoFilter, setPedidoFilter] = useState({ store: "", status: "" });
  const [pedidoSort, setPedidoSort] = useState({ field: null, dir: "asc" });
  const [pedidoSelected, setPedidoSelected] = useState(new Set());
  const [pedidoDrag, setPedidoDrag] = useState(null);
  const [toastMsg, setToastMsg] = useState("");
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
  const fRef = useRef(null), tRef = useRef(null), foRef = useRef(null), fRef2 = useRef(null);

  const sel = models.find(m => m.id === selId);

  // Load from Supabase on mount
  useEffect(() => {
    (async () => {
      try {
        const userFilter = { userId: loggedUser, isAdmin };
        const [dbModels, queue, dbOrders, dbUsers] = await Promise.all([
          db.fetchModels(),
          db.fetchPrintQueue(userFilter),
          db.fetchOrders(200, userFilter),
          db.fetchUsersFromDb(),
        ]);
        refreshUsers(); // lista de usuários do Supabase (src/lib/users.js)
        setModels(prev => prev.map(d => {
          const remote = dbModels.find(r => r.id === d.id);
          return remote ? { ...d, ...remote } : d;
        }));
        setPrintQueue(queue);
        if (dbOrders.length) setPedidos(dbOrders.map(o => ({
          id: o.id, pedido: o.orderCode, remetente: o.store, envio: o.names?.[0] || "",
          modelo: o.fontOverrides?.modelo || "", quantidade: o.sheetsCount || 0,
          feito: o.fontOverrides?.feito || false, semArte: o.fontOverrides?.semArte || false,
          skus: o.fontOverrides?.skus || null, obs: o.fontOverrides?.obs || "", criadoEm: o.createdAt,
        })));
      } catch (e) {
        console.error("Erro ao carregar do Supabase:", e);
      }
      setDbLoading(false);
    })();
    // Preload Cookie font for contour models (MOD007 etc.)
    const bp = import.meta.env.BASE_URL || "/";
    fetch(bp + "fonts/cookie.ttf").then(r => r.arrayBuffer()).then(buf => {
      cookieFontB64 = btoa(Array.from(new Uint8Array(buf), b => String.fromCharCode(b)).join(""));
      // Also load into browser for inline SVG preview
      const fc = new FontFace("Cookie", buf); fc.load().then(f => document.fonts.add(f));
    }).catch(() => {});
    fetch(bp + "fonts/comfortaa.ttf").then(r => r.arrayBuffer()).then(buf => {
      comfortaaFontB64 = btoa(Array.from(new Uint8Array(buf), b => String.fromCharCode(b)).join(""));
      const fc = new FontFace("Comfortaa", buf); fc.load().then(f => document.fonts.add(f));
    }).catch(() => {});
    fetch(bp + "fonts/comfortaabd.ttf").then(r => r.arrayBuffer()).then(buf => {
      comfortaaBoldFontB64 = btoa(Array.from(new Uint8Array(buf), b => String.fromCharCode(b)).join(""));
      const fc = new FontFace("Comfortaa", buf, { weight: "bold" }); fc.load().then(f => document.fonts.add(f));
    }).catch(() => {});
    // Preload MULTI_VARIANT font options (MOD031 selector)
    for (const f of FONT_OPTIONS) {
      fetch(bp + "fonts/" + f.file).then(r => r.arrayBuffer()).then(buf => {
        fontB64Map[f.key] = btoa(Array.from(new Uint8Array(buf), b => String.fromCharCode(b)).join(""));
        const fc = new FontFace(f.family, buf); fc.load().then(ff => document.fonts.add(ff));
      }).catch(() => {});
    }
  }, []);

  // Live-sync model changes across users. Covers EVERY admin edit that goes
  // through upd() → updateModel() → Supabase: SVG uploads (v1 & v2), font
  // uploads, calibration (maxWidth/fontSize), textCenters, fieldTypes,
  // operational flag, displayName rename, resets. Operators see all of it
  // without F5.
  //
  // svgData / svgData2 blobs: we keep the local copy if the URL didn't change
  // (most edits don't touch the SVG, no point re-downloading). If the remote
  // URL differs from what we had cached → null it out, which triggers the
  // on-demand loader useEffect to refetch from Storage with cache-bust.
  useEffect(() => {
    const ch = db.subscribeModels((remote) => {
      setModels(prev => prev.map(m => {
        if (m.id !== remote.id) return m;
        const merged = { ...m, ...remote };
        // Invalidate cached SVG blob if its URL changed (admin re-uploaded)
        if (remote.svgUrl !== m.svgUrl) merged.svgData = null;
        else merged.svgData = m.svgData || null;
        if (remote.svgUrl2 !== m.svgUrl2) merged.svgData2 = null;
        else merged.svgData2 = m.svgData2 || null;
        // Invalidate custom font cache if fontUrl changed
        if (remote.fontUrl && remote.fontUrl !== m.fontUrl) {
          delete customFontB64Map[m.fontUrl];
          // Also drop any registered FontFace under the old family so the new
          // file takes over when the font useEffect re-runs.
          const fam = m.fontFamily;
          if (fam) {
            const toRm = [];
            document.fonts.forEach(f => { if (f.family === fam) toRm.push(f); });
            for (const f of toRm) { try { document.fonts.delete(f); } catch {} }
          }
        }
        return merged;
      }));
    });
    return () => { db.unsubscribe(ch); };
  }, []);

  // Live-sync orders: when admin imports PDFs or any user updates/deletes a
  // pedido, all logged-in users see the change without F5.
  useEffect(() => {
    const dbOrderToPedido = (o) => ({
      id: o.id, pedido: o.orderCode, remetente: o.store, envio: o.names?.[0] || "",
      modelo: o.fontOverrides?.modelo || "", quantidade: o.sheetsCount || 0,
      feito: o.fontOverrides?.feito || false, semArte: o.fontOverrides?.semArte || false,
      skus: o.fontOverrides?.skus || null, obs: o.fontOverrides?.obs || "", criadoEm: o.createdAt,
    });
    const ch = db.subscribeOrders(({ type, order, id }) => {
      if (type === "insert") {
        setPedidos(prev => prev.some(p => p.id === id) ? prev : [dbOrderToPedido(order), ...prev]);
      } else if (type === "update") {
        setPedidos(prev => prev.map(p => p.id === id ? { ...p, ...dbOrderToPedido(order) } : p));
      } else if (type === "delete") {
        setPedidos(prev => prev.filter(p => p.id !== id));
      }
    });
    return () => { db.unsubscribe(ch); };
  }, []);

  // Load SVG data on demand when a model is selected — always re-analyze for accurate centers
  useEffect(() => {
    if (!sel || sel.svgData || !sel.svgUrl) return;
    (async () => {
      try {
        const svgText = await db.downloadSvg(sel.svgUrl);
        const analysis = analyzeSvg(svgText);
        // Merge: keep user-calibrated values (maxWidth, fontSize overrides) but update centers & types
        const merged = { svgData: svgText, textCenters: analysis.textCenters, fieldTypes: analysis.fieldTypes, fieldPerType: analysis.fieldPerType, allGlyphMaps: analysis.allGlyphMaps, fieldFntMap: analysis.fieldFntMap, fieldSiblings: analysis.fieldSiblings, fontFamily: analysis.fontFamily, fontSize: sel.fontSize || analysis.fontSize };
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

  // Load variant 2 SVG data on demand (MULTI_VARIANT_MODELS)
  useEffect(() => {
    if (!sel || !MULTI_VARIANT_MODELS.has(sel.id)) return;
    if (sel.svgData2 || !sel.svgUrl2) return;
    (async () => {
      try {
        const svgText = await db.downloadSvg(sel.svgUrl2);
        const a2 = analyzeSvg(svgText);
        const defaultMaxW2 = a2.fieldTypes?.[0]?.maxWidth || null;
        const merged = {
          svgData2: svgText,
          fields2: a2.fields,
          textCenters2: a2.textCenters,
          fieldFntMap2: a2.fieldFntMap,
          fieldSiblings2: a2.fieldSiblings,
          fontFamily2: a2.fontFamily,
          fontSize2: sel.fontSize2 || a2.fontSize,
          maxWidth2: sel.maxWidth2 || defaultMaxW2,
        };
        setModels(p => p.map(m => m.id === sel.id ? { ...m, ...merged } : m));
      } catch (e) {
        console.error("Erro ao baixar SVG variante 2:", e);
      }
    })();
  }, [sel?.id, sel?.svgUrl2, sel?.svgData2]);

  // Reset variant/font selectors when model changes
  useEffect(() => {
    setSelectedVariant(1);
    setConfigVariant(1);
    setSelectedFont("");
  }, [selId]);

  // Load custom TTF/OTF from Supabase Storage when a model with fontUrl is selected.
  // Isolation: cache is keyed by fontUrl (each model has its own storage URL), and
  // we re-register the browser FontFace for sel.fontFamily on every model switch.
  // Previously the cache was keyed by fontFamily, which caused bleed — if MOD016 and
  // MOD017 both used "DK Coal Brush", uploading a new TTF for one overwrote the other
  // in the shared FontFace registry. Now each model selection replaces any previously
  // registered FontFace with that family name so the active model always wins.
  useEffect(() => {
    if (!sel?.fontUrl || !sel?.fontFamily) return;
    const family = sel.fontFamily;
    const url = sel.fontUrl;
    // Remove any previously registered FontFace under this family (from a prior model)
    // so document.fonts doesn't mix variants.
    const dropExisting = () => {
      const toRemove = [];
      document.fonts.forEach(f => { if (f.family === family) toRemove.push(f); });
      for (const f of toRemove) { try { document.fonts.delete(f); } catch {} }
    };

    const registerFromCache = (entry) => {
      try {
        const bytes = Uint8Array.from(atob(entry.b64), c => c.charCodeAt(0));
        dropExisting();
        const fc = new FontFace(family, bytes.buffer);
        return fc.load().then(ff => { document.fonts.add(ff); });
      } catch { return Promise.resolve(); }
    };

    const cached = customFontB64Map[url];
    if (cached) {
      registerFromCache(cached).then(() => {
        setFontOk(p => ({ ...p, [sel.id]: true }));
        setModels(p => [...p]);
      });
      return;
    }
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) return;
        const buf = await res.arrayBuffer();
        const b64 = btoa(Array.from(new Uint8Array(buf), b => String.fromCharCode(b)).join(""));
        const format = url.toLowerCase().endsWith(".otf") ? "opentype" : "truetype";
        customFontB64Map[url] = { b64, format };
        dropExisting();
        const fc = new FontFace(family, buf);
        await fc.load();
        document.fonts.add(fc);
        setFontOk(p => ({ ...p, [sel.id]: true }));
        // Force a re-render so preview picks up the new font
        setModels(p => [...p]);
      } catch (e) {
        console.error("Erro ao carregar fonte customizada:", e);
      }
    })();
  }, [sel?.id, sel?.fontUrl, sel?.fontFamily]);

  const upd = useCallback((id, u) => {
    // The DB call lives INSIDE the setState updater so we have synchronous
    // access to the freshly merged model. Previously we read a `merged` var
    // set by the updater, but React 18 may defer the updater, so the read
    // happened before the updater ran — leaving merged=null and the DB never
    // touched. Side-effect in updater is pragmatic here (fire-and-forget, no
    // re-render triggered) and the only way to get the latest state cheaply.
    setModels(p => {
      const next = p.map(m => m.id === id ? { ...m, ...u } : m);
      const target = next.find(m => m.id === id);
      if (target && Object.keys(u).length > 0) {
        const dbUpdates = { ...target };
        delete dbUpdates.svgData;
        delete dbUpdates.svgData2;
        db.updateModel(id, dbUpdates)
          .catch(e => console.error("[upd] DB update FAILED:", e.message, e));
      }
      return next;
    });
  }, []);

  const onSvg = (e) => {
    const file = e.target.files[0]; if (!file || !selId) return;
    const r = new FileReader();
    r.onload = async (ev) => {
      const svg = ev.target.result;
      let modelData;
      try {
        const { fields, fontSize, fontFamily, glyphMap, defaultAdv, textCenters, fieldTypes, fieldPerType, allGlyphMaps, fieldFntMap, fieldSiblings } = analyzeSvg(svg);
        modelData = { svgData: svg, fields, fontSize, fontFamily, glyphMap, defaultAdv, textCenters, fieldTypes, fieldPerType, allGlyphMaps, fieldFntMap, fieldSiblings };
      } catch (aerr) {
        console.error("[upload] analyzeSvg falhou:", aerr);
        alert("Falha ao analisar o SVG: " + aerr.message + "\nVer console (F12) para detalhes.");
        return;
      }
      console.log(`[upload] ${selId} analisado: ${modelData.fields.length} campos, fontSize=${modelData.fontSize}, fontFamily=${modelData.fontFamily}, fieldTypes=${modelData.fieldTypes.length}`);
      // Upload to Supabase Storage
      try {
        const svgUrl = await db.uploadSvg(selId, svg);
        upd(selId, { ...modelData, svgUrl });
        console.log(`[upload] ${selId} svgUrl gravado, modelData aplicado via upd`);
      } catch (err) {
        console.error("Erro ao upload SVG:", err);
        upd(selId, modelData);
      }
    };
    r.readAsText(file); e.target.value = "";
  };
  const onSvg2 = (e) => {
    const file = e.target.files[0]; if (!file || !selId) return;
    const r = new FileReader();
    r.onload = async (ev) => {
      const svg = ev.target.result;
      const a2 = analyzeSvg(svg);
      // Pick a sensible default maxWidth for variant 2 from analyzeSvg's
      // fieldTypes[0] (which is already viewBox-scaled: vbW*0.25). Without
      // this, resolveActiveModel would fall back to variant 1's maxWidth,
      // which may be wrong for a different sticker layout (5x2 vs 4x2).
      const defaultMaxW2 = a2.fieldTypes?.[0]?.maxWidth || null;
      const modelData2 = {
        svgData2: svg,
        fields2: a2.fields,
        textCenters2: a2.textCenters,
        fieldFntMap2: a2.fieldFntMap,
        fieldSiblings2: a2.fieldSiblings,
        fontFamily2: a2.fontFamily,
        fontSize2: a2.fontSize,
        maxWidth2: defaultMaxW2,
      };
      try {
        // Upload as <id>_2.svg via a synthetic id suffix
        const path = `svg/${selId}_2.svg`;
        const blob = new Blob([svg], { type: "image/svg+xml" });
        let svgUrl2 = null;
        if (db.isConnected()) {
          const { supabase } = await import("./lib/supabase");
          const { error } = await supabase.storage.from("stickers").upload(path, blob, { upsert: true });
          if (!error) {
            const { data } = supabase.storage.from("stickers").getPublicUrl(path);
            svgUrl2 = data.publicUrl;
          }
        }
        upd(selId, { ...modelData2, svgUrl2 });
      } catch (err) {
        console.error("Erro ao upload SVG variante 2:", err);
        upd(selId, modelData2);
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
        // Remove any previously registered FontFace under this family (from another
        // model or a previous version) so the new bytes take effect immediately.
        const toRemove = [];
        document.fonts.forEach(ff => { if (ff.family === nm) toRemove.push(ff); });
        for (const ff of toRemove) { try { document.fonts.delete(ff); } catch {} }
        const fc = new FontFace(nm, fontBytes.buffer); await fc.load(); document.fonts.add(fc);
        // Keep font bytes in memory for PDF generation
        fontBytesRef.current[selId] = fontBytes;
        // Upload font to Supabase Storage for persistence
        const fontUrl = await db.uploadFont(selId, ev.target.result, f.name);
        // Invalidate cached base64 for this URL so the new font bytes are embedded
        // next time injectNames / useEffect runs for this model.
        const b64 = btoa(Array.from(fontBytes, b => String.fromCharCode(b)).join(""));
        const format = f.name.toLowerCase().endsWith(".otf") ? "opentype" : "truetype";
        customFontB64Map[fontUrl] = { b64, format };
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

  // Resolve active model: for MULTI_VARIANT_MODELS swap variant 2 data if selected
  const resolveActiveModel = () => {
    if (!sel) return sel;
    let m = { ...sel, orderCode, store };
    if (MULTI_VARIANT_MODELS.has(sel.id) && selectedVariant === 2 && sel.svgData2) {
      m.svgData = sel.svgData2;
      m.fields = sel.fields2 || [];
      m.textCenters = sel.textCenters2 || {};
      m.fieldFntMap = sel.fieldFntMap2 || {};
      m.fieldSiblings = sel.fieldSiblings2 || {};
      if (sel.fontFamily2) m.fontFamily = sel.fontFamily2;
      if (sel.fontSize2) m.fontSize = sel.fontSize2;
      if (sel.maxWidth2) m.maxWidth = sel.maxWidth2;
      // Clear variant 1's fieldTypes/fieldPerType so injectNames's auto-fit
      // falls through to variant 2's model.fontSize/maxWidth (just swapped in
      // above). Without this, variant 2 would use variant 1's font size /
      // maxWidth for the shrink loop, which is wrong when the layouts differ
      // (e.g. 5x2 vs 4x2 have different sticker sizes).
      m.fieldTypes = [];
      m.fieldPerType = {};
    }
    if (MULTI_VARIANT_MODELS.has(sel.id) && selectedFont) {
      const fo = FONT_OPTIONS.find(f => f.key === selectedFont);
      if (fo) m.fontOverride = fo.family;
    }
    return m;
  };

  const gen = () => {
    if (!sel) return;
    const active = resolveActiveModel();
    if (!active.svgData || !active.fields.length || (!nl.length && !nl.some(Boolean))) return;
    if (isMultiType && !Object.values(typeLists).some(l => l.length > 0)) return;
    const fps = active.fields.length;
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
      res.push({ i: i + 1, svg: injectNames(active.svgData, sn, active, sheetOv, sheetPos), n: sn, e: fps - sn.length });
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
    // Optimistic UI: append items with temp ids IMMEDIATELY so the user sees
    // them on the print tab without waiting for the Supabase round-trip.
    // Previously the flow was insert + refetch (downloads every SVG already
    // in the queue), which could take 5-10s for big MOD031 cartelas.
    const tempItems = items.map((it, i) => ({
      ...it,
      id: `tmp-${Date.now()}-${i}`,
      _pending: true,
    }));
    setPrintQueue(p => [...p, ...tempItems]);
    // Reset generate data right away
    setNames("");
    setTypeNames({});
    setOrderCode("");
    setFontOv({});
    setPosOv({});
    setSheets([]);
    setPi(0);
    setTab("generate");
    // Background insert — replace temp items with real saved rows when done.
    db.addToPrintQueue(items, null, loggedUser)
      .then((saved) => {
        if (!saved || !saved.length) return;
        setPrintQueue(p => {
          const next = [...p];
          // Replace each temp item (in order) with the matching saved row
          let savedIdx = 0;
          for (let i = 0; i < next.length && savedIdx < saved.length; i++) {
            if (tempItems.some(t => t.id === next[i].id)) {
              next[i] = saved[savedIdx++];
            }
          }
          return next;
        });
      })
      .catch((err) => {
        console.error("Erro ao adicionar à fila:", err);
        // Roll back the optimistic items if the insert failed
        setPrintQueue(p => p.filter(x => !tempItems.some(t => t.id === x.id)));
        alert("Falha ao salvar na fila: " + err.message);
      });
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
        // If the label has an order code but we couldn't extract any SKU/modelo,
        // still import it and flag as "NÃO LOCALIZADO" — operator can edit later.
        // Previously these pedidos silently failed to import.
        const totalQty = skuItems.reduce((sum, s) => sum + s.quantidade, 0);
        const modelo = skuItems.length === 0
          ? "NÃO LOCALIZADO"
          : skuItems.length === 1
            ? skuItems[0].modelo
            : skuItems.map(s => s.modelo).join(" | ");
        results.push({
          id: crypto.randomUUID(),
          pedido,
          remetente,
          envio,
          modelo,
          skus: skuItems.length ? skuItems : [{ modelo: "NÃO LOCALIZADO", quantidade: 0 }],
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
      // Deduplicate by pedido — show which were skipped
      const existing = new Set(pedidos.map(p => p.pedido));
      const newOnes = allResults.filter(r => !existing.has(r.pedido));
      const dupes = allResults.filter(r => existing.has(r.pedido));
      if (newOnes.length === 0) {
        showToast(`Nenhum pedido novo — ${dupes.length} já existiam`, 4000);
        setPedidosParsing(false);
        e.target.value = "";
        return;
      }
      // Save to Supabase and get IDs. Keep only those that actually persisted
      // so a silent DB failure doesn't leave "phantom" orders in memory that
      // would vanish on the next refresh and mislead the operator.
      const saved = [];
      const failed = [];
      // Only send `model_id` to Supabase if it matches a real MOD code — the
      // orders.model_id column has a FK to models(id). SKUs like "5,5 - Preto"
      // or "NÃO LOCALIZADO" would trigger a 409 violation. The full modelo
      // string is preserved in fontOverrides.modelo so nothing is lost.
      const validModelId = (s) => (s && /^MOD\d{3}$/i.test(s.trim())) ? s.trim().toUpperCase() : null;
      for (const p of newOnes) {
        try {
          const dbId = await db.createOrder({
            orderCode: p.pedido,
            store: p.remetente,
            modelId: validModelId(p.modelo),
            names: [p.envio],
            fontOverrides: { modelo: p.modelo, feito: false, skus: p.skus || null },
            sheetsCount: p.quantidade,
            userId: loggedUser,
          });
          if (dbId) { p.id = dbId; saved.push(p); }
          else failed.push(p);
        } catch (err) {
          console.error("Erro ao salvar pedido:", err);
          failed.push(p);
        }
      }
      if (saved.length) setPedidos(prev => [...saved, ...prev]);
      const parts = [`${saved.length} importado(s)`];
      if (dupes.length) parts.push(`${dupes.length} já existiam`);
      if (failed.length) parts.push(`${failed.length} falharam`);
      showToast(parts.join(" · "), 4000);
    } catch (err) {
      alert("Erro ao ler PDF: " + err.message);
      console.error(err);
    }
    setPedidosParsing(false);
    e.target.value = "";
  };

  // Every updateOrder call must send the FULL fontOverrides object — Supabase
  // stores fontOverrides as a single JSONB column, so passing a partial object
  // overwrites the whole thing and drops the other fields. Helper centralizes
  // the shape so no future call forgets a field.
  const fullOverrides = (p) => ({
    modelo: p.modelo || "",
    feito: p.feito || false,
    semArte: p.semArte || false,
    skus: p.skus || null,
    obs: p.obs || "",
  });

  const togglePedidoFeito = async (id) => {
    setPedidos(prev => prev.map(p => {
      if (p.id !== id) return p;
      const updated = { ...p, feito: !p.feito };
      if (id) db.updateOrder(id, { fontOverrides: fullOverrides(updated) }).catch(e => console.error(e));
      return updated;
    }));
  };

  const toggleSemArte = (id) => {
    setPedidos(prev => prev.map(p => {
      if (p.id !== id) return p;
      const updated = { ...p, semArte: !p.semArte };
      if (id) db.updateOrder(id, { fontOverrides: fullOverrides(updated) }).catch(e => console.error(e));
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
      if (pedidoId) {
        db.updateOrder(pedidoId, { fontOverrides: fullOverrides(updated) })
          .catch(e => console.error(e));
      }
      return updated;
    }));
  };

  const removePedido = (id) => {
    setPedidos(prev => prev.filter(p => p.id !== id));
    if (id) db.deleteOrder(id).catch(e => console.error(e));
  };

  // ─── Toast helper ───
  const showToast = (msg, ms = 3000) => { setToastMsg(msg); setTimeout(() => setToastMsg(""), ms); };

  // ─── Bulk select helpers ───
  const toggleSelectPedido = (id) => setPedidoSelected(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  const selectAllVisible = (ids) => setPedidoSelected(prev => prev.size === ids.length ? new Set() : new Set(ids));
  const bulkAction = (action) => {
    const ids = [...pedidoSelected];
    if (!ids.length) return;
    if (action === "feito") {
      setPedidos(prev => {
        const next = prev.map(p => ids.includes(p.id) ? { ...p, feito: true } : p);
        for (const p of next) {
          if (ids.includes(p.id)) db.updateOrder(p.id, { fontOverrides: fullOverrides(p) }).catch(() => {});
        }
        return next;
      });
      showToast(`${ids.length} pedido(s) marcados como feito`);
    } else if (action === "semArte") {
      setPedidos(prev => {
        const next = prev.map(p => ids.includes(p.id) ? { ...p, semArte: true } : p);
        for (const p of next) {
          if (ids.includes(p.id)) db.updateOrder(p.id, { fontOverrides: fullOverrides(p) }).catch(() => {});
        }
        return next;
      });
      showToast(`${ids.length} pedido(s) marcados sem arte`);
    } else if (action === "delete") {
      if (!confirm(`Excluir ${ids.length} pedido(s)?`)) return;
      setPedidos(prev => prev.filter(p => !ids.includes(p.id)));
      ids.forEach(id => db.deleteOrder(id).catch(() => {}));
      showToast(`${ids.length} pedido(s) excluídos`);
    }
    setPedidoSelected(new Set());
  };

  // ─── Update obs (notes) ───
  const updatePedidoObs = (id, obs) => {
    setPedidos(prev => prev.map(p => {
      if (p.id !== id) return p;
      const updated = { ...p, obs };
      db.updateOrder(id, { fontOverrides: fullOverrides(updated) }).catch(() => {});
      return updated;
    }));
  };

  // ─── Export CSV ───
  const exportPedidosCSV = () => {
    const header = "Pedido,Loja,Envio,Modelo,Quantidade,Status,Observações\n";
    const rows = pedidos.map(p =>
      [p.pedido, p.remetente, p.envio, `"${(p.modelo || "").replace(/"/g, '""')}"`, p.quantidade, p.feito ? "Feito" : p.semArte ? "Sem Arte" : "Pendente", `"${(p.obs || "").replace(/"/g, '""')}"`].join(",")
    ).join("\n");
    const blob = new Blob(["\uFEFF" + header + rows], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `pedidos_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    showToast("CSV exportado!");
  };

  // ─── Sort helper ───
  const togglePedidoSort = (field) => {
    setPedidoSort(prev => prev.field === field ? { field, dir: prev.dir === "asc" ? "desc" : "asc" } : { field, dir: "asc" });
  };

  // ─── Filter & sort pipeline ───
  const getFilteredPedidos = () => {
    let list = [...pedidos];
    // Search
    if (pedidoSearch.trim()) {
      const q = pedidoSearch.toLowerCase();
      list = list.filter(p => (p.pedido || "").toLowerCase().includes(q) || (p.remetente || "").toLowerCase().includes(q) || (p.modelo || "").toLowerCase().includes(q) || (p.obs || "").toLowerCase().includes(q));
    }
    // Filter by store
    if (pedidoFilter.store) list = list.filter(p => p.remetente === pedidoFilter.store);
    // Filter by status
    if (pedidoFilter.status === "pendente") list = list.filter(p => !p.feito && !p.semArte);
    else if (pedidoFilter.status === "semArte") list = list.filter(p => p.semArte && !p.feito);
    else if (pedidoFilter.status === "feito") list = list.filter(p => p.feito);
    else if (pedidoFilter.status === "pendentes") list = list.filter(p => !p.feito);
    // Filter by date
    if (pedidoFilter.date === "hoje") {
      const t = new Date(); const td = `${String(t.getDate()).padStart(2,"0")}/${String(t.getMonth()+1).padStart(2,"0")}/${t.getFullYear()}`;
      list = list.filter(p => p.envio === td);
    } else if (pedidoFilter.date === "semana") {
      const now = new Date(); now.setHours(0,0,0,0);
      const end = new Date(now); end.setDate(end.getDate() + 7);
      list = list.filter(p => {
        if (!p.envio) return false;
        const [d,m,y] = p.envio.split("/"); const dt = new Date(`${y}-${m}-${d}`);
        return dt >= now && dt <= end;
      });
    }
    // Sort
    if (pedidoSort.field) {
      const dir = pedidoSort.dir === "asc" ? 1 : -1;
      list.sort((a, b) => {
        let va = a[pedidoSort.field] || "", vb = b[pedidoSort.field] || "";
        if (pedidoSort.field === "quantidade") return (a.quantidade - b.quantidade) * dir;
        if (pedidoSort.field === "envio") {
          const pa = va.split("/"); const pb = vb.split("/");
          va = pa.length === 3 ? `${pa[2]}-${pa[1]}-${pa[0]}` : "";
          vb = pb.length === 3 ? `${pb[2]}-${pb[1]}-${pb[0]}` : "";
        }
        return va < vb ? -dir : va > vb ? dir : 0;
      });
    }
    return list;
  };

  // ─── Drag & drop reorder ───
  const handlePedidoDrop = (targetId) => {
    if (!pedidoDrag || pedidoDrag === targetId) return;
    setPedidos(prev => {
      const arr = [...prev];
      const fromIdx = arr.findIndex(p => p.id === pedidoDrag);
      const toIdx = arr.findIndex(p => p.id === targetId);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const [item] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, item);
      return arr;
    });
    setPedidoDrag(null);
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
        const pageCount = doc.getPageCount();
        for (let pi = 0; pi < pageCount; pi++) {
          const page = doc.getPage(pi);
          const { width, height } = page.getSize();
          items.push({ name: pageCount > 1 ? `${file.name} (p${pi + 1})` : file.name, bytes, width, height, pageIndex: pi });
        }
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
            const pi = item.pageIndex || 0;
            const srcPages = srcDoc.getPages();
            const [embedded] = await doc.embedPages([srcPages[pi]]);
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
      // Uses DOMParser so ancestor <g transform="..."> chains (matrix, translate,
      // scale, rotate) are composed correctly — critical for CorelDraw exports
      // like MOD016 where each <text> lives inside <g transform="matrix(...)">
      // with local x/y far off-page (e.g. x="-5509.99"). Without composing the
      // ancestor transforms, the PDF draws text off the page → invisible.
      const parseTransform = (str) => {
        // Returns { a, b, c, d, e, f } representing matrix [[a c e],[b d f],[0 0 1]]
        let M = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
        if (!str) return M;
        const compose = (A, B) => ({
          a: A.a * B.a + A.c * B.b,
          b: A.b * B.a + A.d * B.b,
          c: A.a * B.c + A.c * B.d,
          d: A.b * B.c + A.d * B.d,
          e: A.a * B.e + A.c * B.f + A.e,
          f: A.b * B.e + A.d * B.f + A.f,
        });
        const opRe = /(matrix|translate|scale|rotate)\s*\(([^)]*)\)/gi;
        let mm;
        while ((mm = opRe.exec(str)) !== null) {
          const op = mm[1].toLowerCase();
          const nums = mm[2].split(/[\s,]+/).filter(Boolean).map(Number);
          let B = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
          if (op === "matrix" && nums.length >= 6) {
            B = { a: nums[0], b: nums[1], c: nums[2], d: nums[3], e: nums[4], f: nums[5] };
          } else if (op === "translate") {
            B = { a: 1, b: 0, c: 0, d: 1, e: nums[0] || 0, f: nums[1] || 0 };
          } else if (op === "scale") {
            const sx = nums[0] || 1;
            B = { a: sx, b: 0, c: 0, d: nums[1] !== undefined ? nums[1] : sx, e: 0, f: 0 };
          } else if (op === "rotate") {
            const rad = (nums[0] || 0) * Math.PI / 180;
            const cs = Math.cos(rad), sn = Math.sin(rad);
            B = { a: cs, b: sn, c: -sn, d: cs, e: 0, f: 0 };
            // TODO: rotate with cx,cy would need pre/post translate; not used here.
          }
          M = compose(M, B);
        }
        return M;
      };
      const applyTransform = (t, x, y) => ({ x: t.a * x + t.c * y + t.e, y: t.b * x + t.d * y + t.f });

      const extractTexts = (svg) => {
        const texts = [];
        let doc;
        try {
          doc = new DOMParser().parseFromString(svg, "image/svg+xml");
        } catch (e) {
          console.warn("[PDF] DOMParser failed:", e);
          return texts;
        }
        // If parsererror was produced (malformed SVG), bail gracefully
        if (doc.getElementsByTagName("parsererror").length) {
          console.warn("[PDF] SVG parse error");
          return texts;
        }
        // Walk up from a <text> element composing every ancestor's transform attribute
        const ancestorTransform = (el) => {
          let M = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
          const compose = (A, B) => ({
            a: A.a * B.a + A.c * B.b,
            b: A.b * B.a + A.d * B.b,
            c: A.a * B.c + A.c * B.d,
            d: A.b * B.c + A.d * B.d,
            e: A.a * B.e + A.c * B.f + A.e,
            f: A.b * B.e + A.d * B.f + A.f,
          });
          const chain = [];
          let cur = el;
          while (cur && cur.nodeType === 1) {
            const tr = cur.getAttribute && cur.getAttribute("transform");
            if (tr) chain.unshift(parseTransform(tr));
            cur = cur.parentNode;
          }
          for (const t of chain) M = compose(M, t);
          return M;
        };

        const textNodes = doc.getElementsByTagName("text");
        for (const el of Array.from(textNodes)) {
          // Skip contour halo/cut layers — only keep the fill text for PDF
          if (el.hasAttribute("data-contour")) continue;
          const content = (el.textContent || "").trim();
          if (!content) continue;
          const x0 = parseFloat(el.getAttribute("x"));
          const y0 = parseFloat(el.getAttribute("y"));
          if (isNaN(x0) || isNaN(y0)) continue;
          const M = ancestorTransform(el);
          const { x, y } = applyTransform(M, x0, y0);
          const cls = el.getAttribute("class") || "";
          const id = el.getAttribute("id") || "";
          const anchor = el.getAttribute("text-anchor") || "start";
          let fontSize = 0;
          const style = el.getAttribute("style") || "";
          const sm = style.match(/font-size:\s*([0-9.]+)px/);
          if (sm) fontSize = parseFloat(sm[1]);
          // Inline fill (from injectNames) takes precedence over the class's
          // filN color. We force fill:#000000 on every injected text so the PDF
          // always draws pure black, regardless of whether the template's .filN
          // would otherwise be white (e.g. MOD002/017 white-on-black designs).
          const fillMatch = style.match(/fill:\s*(#[0-9a-fA-F]{3,6})/);
          const inlineFill = fillMatch ? fillMatch[1] : null;
          texts.push({ x, y, content, cls, id, anchor, fontSize, inlineFill });
        }
        return texts;
      };

      // ── Helper: extract vector cut lines from SVG ──
      const extractCutLines = (svg) => {
        const lines = [];
        // Dedupe key: normalize endpoint order so (A→B) and (B→A) collapse to
        // the same entry. Some CorelDraw exports (MOD010/011/012) include the
        // same cut line 2-3 times — without dedup the cutter tries to cut each
        // line multiple times, which slows down the job and risks over-cutting.
        const seen = new Set();
        const push = (x1, y1, x2, y2, type) => {
          if ([x1, y1, x2, y2].some(isNaN)) return;
          const r = (n) => Math.round(n * 100) / 100; // 2-decimal tolerance
          const a = [r(x1), r(y1)], b = [r(x2), r(y2)];
          const [p1, p2] = (a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1])) ? [a, b] : [b, a];
          const key = `${type}|${p1[0]},${p1[1]}|${p2[0]},${p2[1]}`;
          if (seen.has(key)) return;
          seen.add(key);
          lines.push({ x1, y1, x2, y2, type });
        };

        const strLineRe = /<line\b([^>]*class="[^"]*str[^"]*"[^>]*)\/?\s*>/gi;
        let lm;
        while ((lm = strLineRe.exec(svg)) !== null) {
          const a = lm[1];
          const x1 = parseFloat((a.match(/x1\s*=\s*"([^"]*)"/) || [])[1]);
          const y1 = parseFloat((a.match(/y1\s*=\s*"([^"]*)"/) || [])[1]);
          const x2 = parseFloat((a.match(/x2\s*=\s*"([^"]*)"/) || [])[1]);
          const y2 = parseFloat((a.match(/y2\s*=\s*"([^"]*)"/) || [])[1]);
          push(x1, y1, x2, y2, a.includes("str0") ? "border" : "cut");
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
            push(ax, ay, bx, by, "border");
          }
        }
        return lines;
      };

      // ── Helper: extract cut-contour <path class="...strN..."> as vector ──
      // Emits each path's raw SVG d, its composed ancestor transform matrix, and
      // a "cut" tag. CorelDraw's classic CutContour is str1 with stroke #EC2A90,
      // but any strN is treated as a potential cut/border so the cutter follows
      // the actual curve instead of a raster approximation.
      const extractCutPaths = (svg) => {
        const paths = [];
        let doc;
        try { doc = new DOMParser().parseFromString(svg, "image/svg+xml"); }
        catch { return paths; }
        if (doc.getElementsByTagName("parsererror").length) return paths;
        // Reuse ancestorTransform logic inline (same math as extractTexts)
        const composeMat = (A, B) => ({
          a: A.a * B.a + A.c * B.b,
          b: A.b * B.a + A.d * B.b,
          c: A.a * B.c + A.c * B.d,
          d: A.b * B.c + A.d * B.d,
          e: A.a * B.e + A.c * B.f + A.e,
          f: A.b * B.e + A.d * B.f + A.f,
        });
        const parseMat = (str) => {
          let M = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
          if (!str) return M;
          const opRe = /(matrix|translate|scale|rotate)\s*\(([^)]*)\)/gi;
          let mm;
          while ((mm = opRe.exec(str)) !== null) {
            const op = mm[1].toLowerCase();
            const n = mm[2].split(/[\s,]+/).filter(Boolean).map(Number);
            let B = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
            if (op === "matrix" && n.length >= 6) B = { a: n[0], b: n[1], c: n[2], d: n[3], e: n[4], f: n[5] };
            else if (op === "translate") B = { a: 1, b: 0, c: 0, d: 1, e: n[0] || 0, f: n[1] || 0 };
            else if (op === "scale") { const sx = n[0] || 1; B = { a: sx, b: 0, c: 0, d: n[1] !== undefined ? n[1] : sx, e: 0, f: 0 }; }
            else if (op === "rotate") { const r = (n[0] || 0) * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r); B = { a: cs, b: sn, c: -sn, d: cs, e: 0, f: 0 }; }
            M = composeMat(M, B);
          }
          return M;
        };
        const ancestorMat = (el) => {
          let M = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
          const chain = [];
          let cur = el;
          while (cur && cur.nodeType === 1) {
            const tr = cur.getAttribute && cur.getAttribute("transform");
            if (tr) chain.unshift(parseMat(tr));
            cur = cur.parentNode;
          }
          for (const t of chain) M = composeMat(M, t);
          return M;
        };
        // Helper: convert primitive SVG shapes (circle, ellipse, rect) to a d
        // attribute so they can go through the same Bezier-aware parsePathD +
        // PDF operator pipeline as <path>. Used by MOD004/005/006 which export
        // sticker cut outlines as <circle class="str1"> / <ellipse class="str1">.
        const K = 0.5522847498307936; // quadrant cubic-bezier approximation constant
        const shapeToD = (el) => {
          const tag = el.tagName.toLowerCase();
          if (tag === "circle") {
            const cx = parseFloat(el.getAttribute("cx")) || 0;
            const cy = parseFloat(el.getAttribute("cy")) || 0;
            const r = parseFloat(el.getAttribute("r")) || 0;
            if (r <= 0) return null;
            const k = r * K;
            return `M ${cx + r} ${cy} C ${cx + r} ${cy + k}, ${cx + k} ${cy + r}, ${cx} ${cy + r} C ${cx - k} ${cy + r}, ${cx - r} ${cy + k}, ${cx - r} ${cy} C ${cx - r} ${cy - k}, ${cx - k} ${cy - r}, ${cx} ${cy - r} C ${cx + k} ${cy - r}, ${cx + r} ${cy - k}, ${cx + r} ${cy} Z`;
          }
          if (tag === "ellipse") {
            const cx = parseFloat(el.getAttribute("cx")) || 0;
            const cy = parseFloat(el.getAttribute("cy")) || 0;
            const rx = parseFloat(el.getAttribute("rx")) || 0;
            const ry = parseFloat(el.getAttribute("ry")) || 0;
            if (rx <= 0 || ry <= 0) return null;
            const kx = rx * K, ky = ry * K;
            return `M ${cx + rx} ${cy} C ${cx + rx} ${cy + ky}, ${cx + kx} ${cy + ry}, ${cx} ${cy + ry} C ${cx - kx} ${cy + ry}, ${cx - rx} ${cy + ky}, ${cx - rx} ${cy} C ${cx - rx} ${cy - ky}, ${cx - kx} ${cy - ry}, ${cx} ${cy - ry} C ${cx + kx} ${cy - ry}, ${cx + rx} ${cy - ky}, ${cx + rx} ${cy} Z`;
          }
          if (tag === "rect") {
            const x = parseFloat(el.getAttribute("x")) || 0;
            const y = parseFloat(el.getAttribute("y")) || 0;
            const w = parseFloat(el.getAttribute("width")) || 0;
            const h = parseFloat(el.getAttribute("height")) || 0;
            if (w <= 0 || h <= 0) return null;
            return `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`;
          }
          return null;
        };
        // Only str1+ is the CutContour convention (magenta #EC2A90). str0 is
        // CorelDraw's black page/border stroke — treat separately (stays in the
        // raster as a thin black frame; not a cut line for the machine).
        for (const tag of ["path", "circle", "ellipse", "rect"]) {
          for (const el of Array.from(doc.getElementsByTagName(tag))) {
            const cls = el.getAttribute("class") || "";
            const strMatch = cls.match(/\bstr(\d+)\b/);
            if (!strMatch) continue;
            if (strMatch[1] === "0") continue; // skip black page border
            const d = tag === "path" ? el.getAttribute("d") : shapeToD(el);
            if (!d) continue;
            paths.push({ d, M: ancestorMat(el), cls });
          }
        }
        return paths;
      };

      // Parse SVG path d attribute → flat list of PDF-space path operators
      // after applying matrix M. Supports M/m, L/l, H/h, V/v, C/c, Z/z.
      // Each operator is {op: "m"|"l"|"c"|"h", pts: [{x,y}, ...]} in SVG coords,
      // caller applies final SVG→PDF transform (scX, -scY, pageHpt) when emitting.
      const parsePathD = (d) => {
        const ops = [];
        const tokRe = /([MmLlHhVvCcZzSsQqTtAa])|(-?[0-9]*\.?[0-9]+(?:e[+-]?[0-9]+)?)/gi;
        let tok, cmd = null, nums = [], curX = 0, curY = 0, startX = 0, startY = 0;
        const flush = () => {
          if (!cmd) return;
          if (cmd === "M") {
            for (let i = 0; i + 1 < nums.length; i += 2) {
              const x = nums[i], y = nums[i + 1];
              if (i === 0) { ops.push({ op: "m", pts: [{ x, y }] }); startX = x; startY = y; }
              else ops.push({ op: "l", pts: [{ x, y }] });
              curX = x; curY = y;
            }
          } else if (cmd === "m") {
            for (let i = 0; i + 1 < nums.length; i += 2) {
              const x = curX + nums[i], y = curY + nums[i + 1];
              if (i === 0) { ops.push({ op: "m", pts: [{ x, y }] }); startX = x; startY = y; }
              else ops.push({ op: "l", pts: [{ x, y }] });
              curX = x; curY = y;
            }
          } else if (cmd === "L") {
            for (let i = 0; i + 1 < nums.length; i += 2) { curX = nums[i]; curY = nums[i + 1]; ops.push({ op: "l", pts: [{ x: curX, y: curY }] }); }
          } else if (cmd === "l") {
            for (let i = 0; i + 1 < nums.length; i += 2) { curX += nums[i]; curY += nums[i + 1]; ops.push({ op: "l", pts: [{ x: curX, y: curY }] }); }
          } else if (cmd === "H") { for (const n of nums) { curX = n; ops.push({ op: "l", pts: [{ x: curX, y: curY }] }); } }
          else if (cmd === "h") { for (const n of nums) { curX += n; ops.push({ op: "l", pts: [{ x: curX, y: curY }] }); } }
          else if (cmd === "V") { for (const n of nums) { curY = n; ops.push({ op: "l", pts: [{ x: curX, y: curY }] }); } }
          else if (cmd === "v") { for (const n of nums) { curY += n; ops.push({ op: "l", pts: [{ x: curX, y: curY }] }); } }
          else if (cmd === "C") {
            for (let i = 0; i + 5 < nums.length; i += 6) {
              const c1 = { x: nums[i], y: nums[i + 1] };
              const c2 = { x: nums[i + 2], y: nums[i + 3] };
              const p  = { x: nums[i + 4], y: nums[i + 5] };
              ops.push({ op: "c", pts: [c1, c2, p] });
              curX = p.x; curY = p.y;
            }
          } else if (cmd === "c") {
            for (let i = 0; i + 5 < nums.length; i += 6) {
              const c1 = { x: curX + nums[i],     y: curY + nums[i + 1] };
              const c2 = { x: curX + nums[i + 2], y: curY + nums[i + 3] };
              const p  = { x: curX + nums[i + 4], y: curY + nums[i + 5] };
              ops.push({ op: "c", pts: [c1, c2, p] });
              curX = p.x; curY = p.y;
            }
          } else if (cmd === "Z" || cmd === "z") {
            ops.push({ op: "h", pts: [] });
            curX = startX; curY = startY;
          }
          nums = [];
        };
        while ((tok = tokRe.exec(d)) !== null) {
          if (tok[1]) { flush(); cmd = tok[1]; }
          else nums.push(parseFloat(tok[2]));
        }
        flush();
        return ops;
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
        if (family.includes("cerulean")) return "ceruleanlove";
        if (family.includes("comfortaa")) return isBold ? "comfortaabd" : "comfortaa";
        if (family.includes("cookie")) return "cookie";
        if (family.includes("astral")) return "astralsisters";
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
        "dkcoalbrush": "dkcoalbrush.otf", "misses": "misses.otf", "ceruleanlove": "ceruleanlove.ttf", "comfortaa": "comfortaa.ttf", "comfortaabd": "comfortaabd.ttf", "cookie": "cookie.ttf", "astralsisters": "astralsisters.ttf",
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

      // ── 3b. Load polygon libs for contour die-cut (like Python Shapely+fontTools) ──
      const _hasContour = Object.keys(byModel).some(id => CONTOUR_MODELS.has(id));
      let _opentype = null, _CL = null;
      if (_hasContour) {
        try {
          // Load libs via <script src> to avoid UMD/module detection issues with Vite
          const loadScript = (url) => new Promise((ok, fail) => {
            const s = document.createElement("script");
            s.src = url; s.onload = ok; s.onerror = fail;
            document.head.appendChild(s);
          });
          if (!window.opentype) await loadScript("https://cdn.jsdelivr.net/npm/opentype.js@1.3.4/dist/opentype.min.js");
          if (!window.ClipperLib) await loadScript("https://cdn.jsdelivr.net/npm/clipper-lib@6.4.2/clipper.js");
          _opentype = window.opentype;
          _CL = window.ClipperLib;
          console.log("[PDF] Contour libs loaded:", !!_opentype, !!_CL);
        } catch (e) { console.error("[PDF] Failed to load contour libs:", e); }
      }
      const _otCache = {};

      // Helpers: flatten bezier curves to polylines (same idea as Python's RecordingPen)
      const _flatQ = (x0,y0,cx,cy,x1,y1,n=6) => {
        const r=[];for(let i=1;i<=n;i++){const t=i/n,m=1-t;r.push({x:m*m*x0+2*m*t*cx+t*t*x1,y:m*m*y0+2*m*t*cy+t*t*y1})}return r;
      };
      const _flatC = (x0,y0,a,b,c,d,x1,y1,n=8) => {
        const r=[];for(let i=1;i<=n;i++){const t=i/n,m=1-t;r.push({x:m*m*m*x0+3*m*m*t*a+3*m*t*t*c+t*t*t*x1,y:m*m*m*y0+3*m*m*t*b+3*m*t*t*d+t*t*t*y1})}return r;
      };
      const _pathToPolys = (cmds) => {
        const polys=[]; let cur=[],cx=0,cy=0;
        for(const c of cmds){
          if(c.type==='M'){if(cur.length>=3)polys.push(cur);cur=[{x:c.x,y:c.y}];cx=c.x;cy=c.y;}
          else if(c.type==='L'){cur.push({x:c.x,y:c.y});cx=c.x;cy=c.y;}
          else if(c.type==='Q'){cur.push(..._flatQ(cx,cy,c.x1,c.y1,c.x,c.y));cx=c.x;cy=c.y;}
          else if(c.type==='C'){cur.push(..._flatC(cx,cy,c.x1,c.y1,c.x2,c.y2,c.x,c.y));cx=c.x;cy=c.y;}
          else if(c.type==='Z'){if(cur.length>=3)polys.push(cur);cur=[];}
        }
        if(cur.length>=3)polys.push(cur);
        return polys;
      };
      // Douglas-Peucker polygon simplification — reduces points while keeping shape
      const _simplify = (pts, tol) => {
        if (pts.length <= 2) return pts;
        let maxD = 0, maxI = 0;
        const a = pts[0], b = pts[pts.length - 1];
        const dx = b.X - a.X, dy = b.Y - a.Y, lenSq = dx*dx + dy*dy;
        for (let i = 1; i < pts.length - 1; i++) {
          const px = pts[i].X - a.X, py = pts[i].Y - a.Y;
          let d;
          if (lenSq === 0) d = Math.sqrt(px*px + py*py);
          else { const ex = px - (px*dx+py*dy)/lenSq*dx, ey = py - (px*dx+py*dy)/lenSq*dy; d = Math.sqrt(ex*ex + ey*ey); }
          if (d > maxD) { maxD = d; maxI = i; }
        }
        if (maxD > tol) {
          const l = _simplify(pts.slice(0, maxI+1), tol);
          const r = _simplify(pts.slice(maxI), tol);
          return l.slice(0,-1).concat(r);
        }
        return [a, b];
      };
      // Chaikin corner-cutting smoothing — turns angular polygon into smooth organic curve
      const _chaikin = (pts, iterations = 3) => {
        let p = pts;
        for (let it = 0; it < iterations; it++) {
          const next = [];
          for (let i = 0; i < p.length; i++) {
            const a = p[i], b = p[(i + 1) % p.length];
            next.push({ X: Math.round(0.75 * a.X + 0.25 * b.X), Y: Math.round(0.75 * a.Y + 0.25 * b.Y) });
            next.push({ X: Math.round(0.25 * a.X + 0.75 * b.X), Y: Math.round(0.25 * a.Y + 0.75 * b.Y) });
          }
          p = next;
        }
        return p;
      };

      // ── 4. Generate one PDF per model ──
      for (const [modelId, items] of Object.entries(byModel)) {
        const refSvg = items[0].svg;
        const vbMatch = refSvg.match(/viewBox="([^"]*)"/);
        const [, , vbW, vbH] = (vbMatch ? vbMatch[1] : "0 0 17709 12357").split(/[\s,]+/).map(Number);
        const svgWm = refSvg.match(/width="([0-9.]+)mm"/);
        const svgHm = refSvg.match(/height="([0-9.]+)mm"/);
        // Unit-less viewBox → assume SVG spec default (1 user unit = 1 CSS px =
        // 25.4/96 mm ≈ 0.2646 mm). This is what Illustrator exports use. For
        // CorelDraw exports with viewBox ~10000+, always pair with width="..mm".
        // Heuristic: if viewBox is very large (>4000), keep legacy 0.01214 factor
        // (matches pre-existing CorelDraw imports where mm attr was absent).
        const PX_TO_MM = 25.4 / 96; // 0.2646
        const fallbackFactor = vbW > 4000 ? 0.01214 : PX_TO_MM;
        const cWmm = svgWm ? parseFloat(svgWm[1]) : vbW * fallbackFactor;
        const cHmm = svgHm ? parseFloat(svgHm[1]) : vbH * fallbackFactor;
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
        // Parse .filN fill colors from CSS so PDF text matches template intent
        // (e.g. MOD002 has black sticker backgrounds + white text via fil6=#FEFEFE).
        // Without this the PDF always drew black, making white-on-black text invisible.
        const filColor = {}; // { "fil6": cmyk(...), ... }
        const filRe = /\.fil(\d+)\s*\{[^}]*fill:\s*#([0-9a-fA-F]{3,6})/gi;
        let fim;
        const hexToRgb01 = (hex) => {
          if (hex.length === 3) hex = hex.split("").map(c => c + c).join("");
          const r = parseInt(hex.substring(0, 2), 16) / 255;
          const g = parseInt(hex.substring(2, 4), 16) / 255;
          const b = parseInt(hex.substring(4, 6), 16) / 255;
          return { r, g, b };
        };
        const rgbToCmyk = ({ r, g, b }) => {
          const k = 1 - Math.max(r, g, b);
          if (k >= 0.9995) return cmyk(0, 0, 0, 1);
          const c = (1 - r - k) / (1 - k);
          const m = (1 - g - k) / (1 - k);
          const y = (1 - b - k) / (1 - k);
          return cmyk(c, m, y, k);
        };
        while ((fim = filRe.exec(refSvg)) !== null) {
          const rgb = hexToRgb01(fim[2]);
          // Pure white → CMYK (0,0,0,0). rgbToCmyk handles it (k=0, c=m=y=0).
          filColor["fil" + fim[1]] = rgbToCmyk(rgb);
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
          // Strip strN tokens from the class attribute of all shape elements so
          // the raster doesn't double-draw the magenta cut stroke (vector
          // CutContour is emitted separately above). Applies to path/circle/
          // ellipse/rect/line/polygon/polyline — whichever primitive CorelDraw
          // chose for the sticker outline (MOD004/006 circle, MOD005 ellipse,
          // MOD016 path, etc.). filN tokens stay so sticker backgrounds/fills
          // still render.
          svgClean = svgClean.replace(/(<(?:path|circle|ellipse|rect|line|polygon|polyline)\b[^>]*\sclass=")([^"]*)(")/gi, (_m, pre, cls, post) => {
            // Strip only cut strokes (str1+, magenta CutContour). Keep str0 —
            // that's the black page frame and must stay in the raster.
            const cleaned = cls.replace(/\bstr[1-9]\d*\b/g, "").replace(/\s+/g, " ").trim();
            return pre + cleaned + post;
          });
          svgClean = svgClean.replace(/<text\b[^>]*>[^<]*<\/text>/gi, "");
          const blob = await svgToPng(svgClean, 3);
          const buf = await blob.arrayBuffer();
          const imgData = new Uint8Array(buf);

          const page = doc.addPage([pageWpt, pageHpt]);
          const isJpeg = blob.type.includes("jpeg");
          const img = isJpeg ? await doc.embedJpg(imgData) : await doc.embedPng(imgData);
          page.drawImage(img, { x: 0, y: 0, width: pageWpt, height: pageHpt });

          // Register CutContour color space in page resources (needed before text for contour models)
          const pageDict = page.node;
          let resources = pageDict.get(PDFName.of("Resources"));
          if (!resources) { resources = ctx.obj({}); pageDict.set(PDFName.of("Resources"), resources); }
          let colorSpaces = resources.get(PDFName.of("ColorSpace"));
          if (!colorSpaces) { colorSpaces = ctx.obj({}); resources.set(PDFName.of("ColorSpace"), colorSpaces); }
          colorSpaces.set(PDFName.of("CS_CutContour"), sepRef);

          const isContourPdf = CONTOUR_MODELS.has(modelId);

          // Vector text
          const _dbgTexts = extractTexts(item.svg);
          console.log(`[PDF ${modelId}] texts=${_dbgTexts.length}`, _dbgTexts.map(t => `${t.id||"<no-id>"}@${t.x.toFixed(0)},${t.y.toFixed(0)} cls="${t.cls}" "${t.content}"`));
          console.log(`[PDF ${modelId}] fntInfo=`, JSON.stringify(fntInfo), "pdfFonts=", Object.keys(pdfFonts));
          for (const t of _dbgTexts) {
            const fntClass = (t.cls.match(/fnt\d+/) || [])[0];
            const info = fntClass ? fntInfo[fntClass] : null;
            const fs = t.fontSize || (info ? info.size : 24);
            const pdfFS = fs * scY;
            const font = info && info.fontKey ? pdfFonts[info.fontKey] : null;
            const xPt = t.x * scX;
            const yPt = pageHpt - t.y * scY;
            try {
              const isNameField = !t.id || t.id.startsWith("campo_nome");
              if (isContourPdf && isNameField && font && t.content.trim() && _opentype && _CL) {
                // ── Contour model: polygon-based CutContour (like Python Shapely buffer) ──
                const fResName = "Fcontour_" + (info.fontKey || "def");
                let fontDict = resources.get(PDFName.of("Font"));
                if (!fontDict) { fontDict = ctx.obj({}); resources.set(PDFName.of("Font"), fontDict); }
                fontDict.set(PDFName.of(fResName), font.ref);

                // Parse font with opentype.js (cached)
                if (!_otCache[info.fontKey] && fontBytesCache[info.fontKey]) {
                  try {
                    const ab = fontBytesCache[info.fontKey].buffer.slice(
                      fontBytesCache[info.fontKey].byteOffset,
                      fontBytesCache[info.fontKey].byteOffset + fontBytesCache[info.fontKey].byteLength
                    );
                    _otCache[info.fontKey] = _opentype.parse(ab);
                  } catch(e) { console.warn("[PDF] opentype parse failed:", e); }
                }
                const otFont = _otCache[info.fontKey];

                // Encode text for PDF text rendering (black fill)
                const encoded = font.encodeText(t.content);
                const hexStr = Array.from(encoded.asBytes ? encoded.asBytes() : encoded, b => b.toString(16).padStart(2, "0")).join("");

                // Use opentype.js advance width for consistent centering
                const otTw = otFont ? otFont.getAdvanceWidth(t.content, pdfFS) : font.widthOfTextAtSize(t.content, pdfFS);
                const drawX = t.anchor === "middle" ? xPt - otTw / 2 : xPt;

                console.log("[PDF] otFont parsed:", !!otFont, "fontKey:", info.fontKey);
                if (otFont) {
                  const haloW = pdfFS * 0.45; // offset distance (same as SVG halo)

                  // 1) Get text outline as path commands (positioned at origin, PDF scale)
                  const otPath = otFont.getPath(t.content, 0, 0, pdfFS);
                  const polys = _pathToPolys(otPath.commands);

                  // 2) Convert to ClipperLib integer format (scale ×100 for precision)
                  const SC = 100;
                  const clipPolys = polys.map(p => p.map(pt => ({X: Math.round(pt.x * SC), Y: Math.round(pt.y * SC)})));

                  // 3) Union all letter polygons (handles cursive overlap like Shapely unary_union)
                  const clipper = new _CL.Clipper();
                  clipper.AddPaths(clipPolys, _CL.PolyType.ptSubject, true);
                  const unionResult = [];
                  clipper.Execute(_CL.ClipType.ctUnion, unionResult, _CL.PolyFillType.pftNonZero, _CL.PolyFillType.pftNonZero);

                  // 4) Offset outward by haloW (like Shapely .buffer(padding))
                  const co = new _CL.ClipperOffset();
                  co.ArcTolerance = haloW * SC * 0.025; // smooth round curves with moderate point count
                  co.AddPaths(unionResult, _CL.JoinType.jtRound, _CL.EndType.etClosedPolygon);
                  const offsetResult = [];
                  co.Execute(offsetResult, haloW * SC);

                  // 4b) Simplify → Chaikin smooth → re-simplify for clean organic contour
                  for (let pi = 0; pi < offsetResult.length; pi++) {
                    offsetResult[pi] = _simplify(offsetResult[pi], haloW * SC * 0.06); // aggressive simplify
                    offsetResult[pi] = _chaikin(offsetResult[pi], 3); // smooth curves
                    offsetResult[pi] = _simplify(offsetResult[pi], haloW * SC * 0.01); // clean up excess
                  }

                  console.log("[PDF] polys:", polys.length, "union:", unionResult.length, "offset pts:", offsetResult.reduce((s,p) => s+p.length, 0));
                  // 5) Convert offset polygons to PDF path operators
                  const pathOps = [];
                  for (const poly of offsetResult) {
                    for (let i = 0; i < poly.length; i++) {
                      const px = (drawX + poly[i].X / SC).toFixed(2);
                      const py = (yPt - poly[i].Y / SC).toFixed(2); // flip Y for PDF
                      pathOps.push(i === 0 ? `${px} ${py} m` : `${px} ${py} l`);
                    }
                    pathOps.push("h"); // close subpath
                  }

                  // 6) Draw CutContour outline + optional black fill + text
                  const isDarkPdf = DARK_CONTOUR_MODELS.has(modelId);
                  const ops = ["q", "1 j 1 J"];

                  // For dark models: fill the offset polygon with black background (1mm bleed past cut)
                  if (isDarkPdf) {
                    const bleedPt = 2.835; // 1mm in PDF points
                    ops.push("0 0 0 1 k", "0 0 0 1 K"); // CMYK black fill + stroke
                    ops.push(`${(bleedPt * 2).toFixed(2)} w`); // stroke extends 1mm outward
                    ops.push("1 j 1 J"); // round join + cap
                    ops.push(...pathOps);
                    ops.push("B"); // fill + stroke = black bleeds 1mm past cut line
                  }

                  // CutContour thin outline
                  ops.push(`/CS_CutContour CS`, `1 SCN`);
                  ops.push(`0.75 w`); // thin hairline cut line
                  ops.push(...pathOps);
                  ops.push("S"); // stroke only

                  // Text fill (white for dark models, black for normal)
                  ops.push(isDarkPdf ? "0 0 0 0 k" : "0 0 0 1 k"); // white or black CMYK
                  ops.push(`BT /${fResName} ${pdfFS.toFixed(2)} Tf 0 Tr`);
                  ops.push(`${drawX.toFixed(2)} ${yPt.toFixed(2)} Td`);
                  ops.push(`<${hexStr}> Tj ET`);
                  ops.push("Q");

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
                }
              } else if (font) {
                const tw = font.widthOfTextAtSize(t.content, pdfFS);
                const drawX = t.anchor === "middle" ? xPt - tw / 2 : xPt;
                // Pick the first .filN class on the <text> (CorelDraw pattern)
                // and use its CSS fill color. Fallback to pure black.
                const filCls = (t.cls.match(/fil\d+/) || [])[0];
                const col = (filCls && filColor[filCls]) ? filColor[filCls] : textColor;
                page.drawText(t.content, { x: drawX, y: yPt, size: pdfFS, font, color: col });
              } else {
                const filCls = (t.cls.match(/fil\d+/) || [])[0];
                const col = (filCls && filColor[filCls]) ? filColor[filCls] : textColor;
                page.drawText(t.content, { x: xPt, y: yPt, size: pdfFS, color: col });
              }
            } catch (e) { console.warn("[PDF] drawText failed:", t.content, e.message); }
          }

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

          // Draw curved cut paths as vector CutContour (e.g. MOD002 uses
          // <path class="fil1 str1"> for the sticker outline). Without this the
          // cut line ended up baked only in the raster PNG and the cutter had
          // nothing to follow.
          const cutPaths = extractCutPaths(item.svg);
          if (cutPaths.length) {
            const pathOps = [
              "q",
              "/CS_CutContour CS",
              "1 SCN",
              "0.5 w",
              "1 j 1 J", // round join + cap for smooth curves
            ];
            for (const cp of cutPaths) {
              const ops = parsePathD(cp.d);
              const M = cp.M;
              // Compose path-element transform with viewBox→PDF transform.
              // PDF y-up vs SVG y-down, so we flip y: yPdf = pageHpt - svgY*scY.
              const toPdf = (pt) => {
                // Apply element ancestor transform to get SVG-space world coord
                const sx = M.a * pt.x + M.c * pt.y + M.e;
                const sy = M.b * pt.x + M.d * pt.y + M.f;
                return { x: sx * scX, y: pageHpt - sy * scY };
              };
              for (const op of ops) {
                if (op.op === "m") {
                  const p = toPdf(op.pts[0]);
                  pathOps.push(`${p.x.toFixed(2)} ${p.y.toFixed(2)} m`);
                } else if (op.op === "l") {
                  const p = toPdf(op.pts[0]);
                  pathOps.push(`${p.x.toFixed(2)} ${p.y.toFixed(2)} l`);
                } else if (op.op === "c") {
                  const c1 = toPdf(op.pts[0]);
                  const c2 = toPdf(op.pts[1]);
                  const p  = toPdf(op.pts[2]);
                  pathOps.push(`${c1.x.toFixed(2)} ${c1.y.toFixed(2)} ${c2.x.toFixed(2)} ${c2.y.toFixed(2)} ${p.x.toFixed(2)} ${p.y.toFixed(2)} c`);
                } else if (op.op === "h") {
                  pathOps.push("h");
                }
              }
            }
            pathOps.push("S"); // stroke
            pathOps.push("Q");
            const bytes = new TextEncoder().encode(pathOps.join("\n"));
            const rs = ctx.stream(bytes);
            const rsRef = ctx.register(rs);
            const cont = pageDict.get(PDFName.of("Contents"));
            if (cont instanceof PDFArray) cont.push(rsRef);
            else if (cont) pageDict.set(PDFName.of("Contents"), ctx.obj([cont, rsRef]));
            else pageDict.set(PDFName.of("Contents"), rsRef);
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
          const pageCount = doc.getPageCount();
          for (let pi = 0; pi < pageCount; pi++) {
            const page = doc.getPage(pi);
            const { width, height } = page.getSize();
            layoutItems.push({ name: pageCount > 1 ? `${name} (p${pi + 1})` : name, bytes: new Uint8Array(bytes), width, height, pageIndex: pi });
          }
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

      <header style={{ padding: "20px 32px", borderBottom: "1px solid var(--brd)", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, background: "linear-gradient(180deg,rgba(232,93,58,.06),transparent)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 42, height: 42, borderRadius: 12, background: "linear-gradient(135deg,#e85d3a,#ff9b7b)", display: "flex", alignItems: "center", justifyContent: "center" }}><I n="zap" s={22} /></div>
          <div><h1 style={{ fontSize: 20, fontWeight: 700 }}>Sticker Studio</h1><p style={{ fontSize: 12, color: "var(--t2)" }}>Personalização de Adesivos · Shopee</p></div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, background: "var(--card)", borderRadius: 12, padding: 4, border: "1px solid var(--brd)" }}>
          <Tab active={tab === "gallery"} onClick={() => setTab("gallery")} icon="grid" label="Modelos" />
          <Tab active={tab === "generate"} onClick={() => setTab("generate")} icon="list" label="Gerar" />
          <Tab active={tab === "preview"} onClick={() => setTab("preview")} icon="eye" label="Preview" />
          <Tab active={tab === "print"} onClick={() => setTab("print")} icon="printer" label={`Impressão${printQueue.length ? ` (${printQueue.length})` : ""}`} />
          <Tab active={tab === "pedidos"} onClick={() => setTab("pedidos")} icon="clipboard" label={<>Pedidos{pedidos.length ? ` (${pedidos.length})` : ""}{pedidos.some(p => { if (p.feito || !p.envio) return false; const [d,m,y] = p.envio.split("/"); const dt = new Date(`${y}-${m}-${d}`); const t = new Date(); t.setHours(0,0,0,0); return dt <= t; }) && <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#f87171", marginLeft: 6, animation: "pulse 1.5s infinite" }} />}</>} />
          <Tab active={tab === "cartela"} onClick={() => setTab("cartela")} icon="target" label="Cartelas" />
          <Tab active={tab === "nomes"} onClick={() => setTab("nomes")} icon="list" label="Etiquetas Nome" />
          <Tab active={tab === "lapisdtf"} onClick={() => setTab("lapisdtf")} icon="list" label="Lápis DTF UV" />
          <Tab active={tab === "lapis"} onClick={() => setTab("lapis")} icon="list" label="Lapis" />
          <Tab active={tab === "vetorizar"} onClick={() => setTab("vetorizar")} icon="target" label="Vetorizar" />
          <Tab active={tab === "ampliar"} onClick={() => setTab("ampliar")} icon="zap" label="Ampliar" />
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
            const form = e.target;
            updateUsers(users => {
              if (users[nu]) throw new Error("Usuário já existe");
              users[nu] = { pass: np, role: nr };
            }).then(() => {
              form.reset();
              setShowUserMgmt(false); setTimeout(() => setShowUserMgmt(true), 10);
            }).catch(err => alert(`Não foi possível criar o usuário: ${err.message}`));
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
                  updateUsers(users => {
                    if (!users[name]) throw new Error("usuário não existe mais");
                    users[name].pass = np.trim();
                  }).then(() => alert("Senha alterada!")).catch(err => alert(`Não foi possível alterar a senha: ${err.message}`));
                }} style={{ background: "none", border: "1px solid var(--brd)", borderRadius: 6, padding: "4px 10px", color: "var(--t2)", cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>Alterar senha</button>
                {name !== "admin" && <button onClick={() => {
                  if (!confirm(`Remover usuário "${name}"?`)) return;
                  updateUsers(users => { delete users[name]; })
                    .then(() => { setShowUserMgmt(false); setTimeout(() => setShowUserMgmt(true), 10); })
                    .catch(err => alert(`Não foi possível remover o usuário: ${err.message}`));
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
          <p style={{ color: "var(--t2)", fontSize: 14, marginBottom: 16 }}>Selecione para configurar</p>

          {/* Status panel: compact list of every model with a green/red dot
              indicating operational flag. Purely informational — gallery below
              shows all models to everyone regardless of operational status.
              Admin can toggle via the check icon on each card. */}
          {(() => {
            const opCount = models.filter(m => m.operational).length;
            return (
              <div style={{ background: "var(--card)", borderRadius: 12, border: "1px solid var(--brd)", padding: "14px 16px", marginBottom: 20 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--t1)" }}>Status Operacional</div>
                  <div style={{ fontSize: 12, color: "var(--t2)" }}>
                    <b style={{ color: "#22c55e" }}>{opCount}</b> operacional{opCount !== 1 ? "is" : ""} · <b style={{ color: "#f87171" }}>{models.length - opCount}</b> pendente{(models.length - opCount) !== 1 ? "s" : ""}
                  </div>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {models.map(m => (
                    <div key={m.id} title={m.operational ? "Operacional" : "Não operacional"} style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 9px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--brd)", fontSize: 11, fontFamily: "mono", color: "var(--t2)" }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: m.operational ? "#22c55e" : "#f87171", display: "inline-block", boxShadow: m.operational ? "0 0 6px rgba(34,197,94,.5)" : "none" }} />
                      {m.displayName || m.id}
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: 16 }}>
            {models.map(m => (
              <div key={m.id} className="card-h" onClick={() => { setSelId(m.id); setTab(m.svgData || m.svgUrl ? "generate" : "config"); }} style={{ background: "var(--card)", borderRadius: 14, border: `1px solid ${selId === m.id ? "var(--accent)" : "var(--brd)"}`, cursor: "pointer", overflow: "hidden", transition: "all .25s" }}>
                <div style={{ height: 130, background: m.thumbUrl ? `url(${m.thumbUrl}) center/cover` : "linear-gradient(135deg,#1e2230,#262a38)", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
                  {!m.thumbUrl && <I n="image" s={28} />}
                  {m.svgData && <div style={{ position: "absolute", top: 8, right: 8, background: "#34d399", borderRadius: 20, padding: "2px 8px", fontSize: 10, fontWeight: 700, color: "#000" }}>SVG</div>}
                  {m.operational
                    ? <div style={{ position: "absolute", top: 8, left: 8, background: "#22c55e", borderRadius: 20, padding: "2px 8px", fontSize: 10, fontWeight: 700, color: "#fff", display: "flex", alignItems: "center", gap: 3 }}><I n="check" s={10} />OP</div>
                    : <div style={{ position: "absolute", top: 8, left: 8, background: "#ef4444", borderRadius: 20, padding: "2px 8px", fontSize: 10, fontWeight: 700, color: "#fff", display: "flex", alignItems: "center", gap: 3 }}><I n="alert" s={10} />OFF</div>
                  }
                </div>
                <div style={{ padding: "10px 14px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{m.displayName || m.id}</div>
                    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      {isAdmin && (
                        <button onClick={(e) => {
                          e.stopPropagation();
                          console.log("[toggle operational]", m.id, "from", m.operational, "to", !m.operational);
                          upd(m.id, { operational: !m.operational });
                        }} title={m.operational ? "Marcar como NÃO operacional" : "Marcar como operacional (libera pra usuários)"} style={{ background: "none", border: "none", cursor: "pointer", color: m.operational ? "#22c55e" : "var(--t3)", padding: 2, display: "flex", transition: "color .2s" }} onMouseEnter={e => e.currentTarget.style.color = m.operational ? "#f87171" : "#22c55e"} onMouseLeave={e => e.currentTarget.style.color = m.operational ? "#22c55e" : "var(--t3)"}><I n={m.operational ? "check-circle" : "circle"} s={14} /></button>
                      )}
                      <button onClick={(e) => {
                        e.stopPropagation();
                        setSelId(m.id); setTab("config");
                      }} title="Configurar" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--t3)", padding: 2, display: "flex", transition: "color .2s" }} onMouseEnter={e => e.currentTarget.style.color = "#34d399"} onMouseLeave={e => e.currentTarget.style.color = "var(--t3)"}><I n="settings" s={13} /></button>
                      <button onClick={(e) => {
                        e.stopPropagation();
                        const newName = prompt("Renomear modelo:", m.displayName || m.id);
                        if (newName !== null && newName.trim()) {
                          upd(m.id, { displayName: newName.trim() });
                        }
                      }} title="Renomear" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--t3)", padding: 2, display: "flex", transition: "color .2s" }} onMouseEnter={e => e.currentTarget.style.color = "var(--accent)"} onMouseLeave={e => e.currentTarget.style.color = "var(--t3)"}><I n="edit" s={13} /></button>
                    </div>
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
                    <I n="file" s={18} /> {MULTI_VARIANT_MODELS.has(sel.id) ? "Cartela 5x2" : "Arquivo SVG"}
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
                {/* SVG Variant 2 (MULTI_VARIANT_MODELS) */}
                {MULTI_VARIANT_MODELS.has(sel.id) && (
                  <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", padding: 20 }}>
                    <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
                      <I n="file" s={18} /> Cartela 4x2
                      {sel.svgData2 && <span style={{ padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600, background: "rgba(52,211,153,.15)", color: "#34d399", marginLeft: 8 }}>OK</span>}
                    </h3>
                    <input ref={fRef2} type="file" accept=".svg" onChange={onSvg2} hidden />
                    <button className="bp" onClick={() => fRef2.current?.click()} style={{ width: "100%" }}><I n="upload" s={16} /> {sel.svgData2 ? "Substituir" : "Upload SVG Cartela 4x2"}</button>
                    {sel.svgData2 && sel.fields2 && sel.fields2.length > 0 && (
                      <div style={{ marginTop: 12, padding: 12, background: "var(--bg)", borderRadius: 10, fontSize: 12 }}>
                        <div style={{ color: "var(--t2)", marginBottom: 6 }}>Campos detectados:</div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          {sel.fields2.map(f => <span key={f.name} style={{ background: "rgba(167,139,250,.15)", color: "#a78bfa", padding: "3px 10px", borderRadius: 6, fontSize: 11, fontFamily: "mono" }}>{f.name} {f.occurrences > 1 ? `(×${f.occurrences})` : ""}</span>)}
                        </div>
                      </div>
                    )}
                    {sel.svgData2 && (
                      <button className="bs" onClick={() => upd(selId, { svgData2: null, svgUrl2: null, fields2: [], textCenters2: {}, fieldFntMap2: {}, fieldSiblings2: {} })} style={{ width: "100%", marginTop: 10, color: "#f87171", borderColor: "rgba(248,113,113,.3)" }}><I n="trash" s={14} /> Resetar Cartela 4x2</button>
                    )}
                  </div>
                )}
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
                {MULTI_VARIANT_MODELS.has(sel.id) && (
                  <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
                    {[1, 2].map(v => {
                      const has = v === 1 ? !!sel.svgData : !!sel.svgData2;
                      return (
                        <button key={v} onClick={() => has && setConfigVariant(v)} disabled={!has} style={{
                          flex: 1, padding: "10px 14px", borderRadius: 10, fontSize: 13, fontWeight: 600,
                          cursor: has ? "pointer" : "not-allowed", fontFamily: "inherit", transition: "all .15s",
                          border: configVariant === v ? "2px solid var(--accent)" : "1px solid var(--brd)",
                          background: configVariant === v ? "rgba(232,93,58,.15)" : "var(--card)",
                          color: !has ? "var(--t3)" : (configVariant === v ? "#ff7b5c" : "var(--t2)"),
                          opacity: has ? 1 : 0.5,
                        }}>Calibrar Cartela {v === 1 ? "5x2" : "4x2"}{!has ? " (vazia)" : ""}</button>
                      );
                    })}
                  </div>
                )}
                {(() => {
                  const isV2 = MULTI_VARIANT_MODELS.has(sel.id) && configVariant === 2;
                  if (isV2) {
                    if (!sel.svgData2) {
                      return <div style={{ background: "var(--card)", borderRadius: 14, border: "1px dashed var(--brd)", padding: 40, textAlign: "center", minHeight: 300, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                        <I n="target" s={40} /><p style={{ color: "var(--t2)", marginTop: 16 }}>Upload da Cartela 4x2 para calibrar</p>
                      </div>;
                    }
                    const model2 = {
                      ...sel,
                      svgData: sel.svgData2,
                      fields: sel.fields2 || [],
                      textCenters: sel.textCenters2 || {},
                      fieldFntMap: sel.fieldFntMap2 || {},
                      fieldSiblings: sel.fieldSiblings2 || {},
                      fontFamily: sel.fontFamily2 || sel.fontFamily,
                      fontSize: sel.fontSize2 || sel.fontSize,
                      maxWidth: sel.maxWidth2 || sel.maxWidth,
                      fieldTypes: [], // multi-type not supported in variant 2
                    };
                    const upd2 = (id, u) => {
                      const mapped = {};
                      if (u.maxWidth !== undefined) mapped.maxWidth2 = u.maxWidth;
                      if (u.fontSize !== undefined) mapped.fontSize2 = u.fontSize;
                      if (Object.keys(mapped).length) upd(id, mapped);
                    };
                    return <Calibration key={`${sel.id}-v2`} model={model2} onUpdate={upd2} />;
                  }
                  return sel.svgData ? <Calibration key={`${sel.id}-v1`} model={sel} onUpdate={upd} />
                  : <div style={{ background: "var(--card)", borderRadius: 14, border: "1px dashed var(--brd)", padding: 40, textAlign: "center", minHeight: 300, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                      <I n="target" s={40} /><p style={{ color: "var(--t2)", marginTop: 16 }}>Upload do SVG para calibrar</p>
                    </div>;
                })()}
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

              {/* Cartela + Fonte selectors (MULTI_VARIANT_MODELS) */}
              {MULTI_VARIANT_MODELS.has(sel.id) && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
                  <div style={{ background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 14, padding: 14 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                      <I n="grid" s={14} />
                      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--t2)" }}>Cartela</span>
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      {[1, 2].map(v => {
                        const has = v === 1 ? !!sel.svgData : !!sel.svgData2;
                        return (
                          <button key={v} onClick={() => has && setSelectedVariant(v)} disabled={!has} style={{
                            flex: 1, padding: "10px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600,
                            cursor: has ? "pointer" : "not-allowed", fontFamily: "inherit", transition: "all .15s",
                            border: selectedVariant === v ? "2px solid var(--accent)" : "1px solid var(--brd)",
                            background: selectedVariant === v ? "rgba(232,93,58,.15)" : "var(--inp)",
                            color: !has ? "var(--t3)" : (selectedVariant === v ? "#ff7b5c" : "var(--t2)"),
                            opacity: has ? 1 : 0.5,
                          }}>Cartela {v === 1 ? "5x2" : "4x2"}{!has ? " (vazia)" : ""}</button>
                        );
                      })}
                    </div>
                  </div>
                  <div style={{ background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 14, padding: 14 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                      <I n="font" s={14} />
                      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--t2)" }}>Fonte</span>
                    </div>
                    <select value={selectedFont} onChange={e => setSelectedFont(e.target.value)} style={{
                      width: "100%", padding: "10px 14px", background: "var(--inp)", border: "1px solid var(--brd)",
                      borderRadius: 10, color: "var(--t1)", fontSize: 14, fontFamily: "inherit", cursor: "pointer",
                    }}>
                      <option value="">— Padrão do SVG —</option>
                      {FONT_OPTIONS.map(f => <option key={f.key} value={f.key} style={{ fontFamily: f.family }}>{f.label}</option>)}
                    </select>
                  </div>
                </div>
              )}

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
              {printQueue.length > 0 && <button className="bs" onClick={() => { setPrintQueue([]); db.clearPrintQueue({ userId: loggedUser, isAdmin }).catch(e => console.error(e)); }} style={{ color: "#f87171", borderColor: "rgba(248,113,113,.3)" }}><I n="trash" s={14} /> Limpar</button>}
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
          {/* Toast notification */}
          {toastMsg && <div style={{ position: "fixed", top: 24, right: 24, zIndex: 9999, background: "var(--accent)", color: "#fff", padding: "12px 24px", borderRadius: 12, fontWeight: 600, fontSize: 14, boxShadow: "0 8px 32px rgba(0,0,0,.3)", animation: "fadeIn .3s" }}>{toastMsg}</div>}

          {/* Header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div>
              <h2 style={{ fontSize: 22, fontWeight: 700 }}>Controle de Pedidos</h2>
              <p style={{ color: "var(--t2)", fontSize: 13 }}>
                {pedidos.length} pedido(s) · {pedidos.filter(p => p.feito).length} feito(s) · {pedidos.filter(p => !p.feito).length} pendente(s)
              </p>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="bs" onClick={exportPedidosCSV} style={{ display: "flex", alignItems: "center", gap: 6 }}><I n="download" s={14} /> CSV</button>
              <label className="bp" style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 8, padding: "12px 24px" }}>
                <I n="upload" s={18} /> {pedidosParsing ? "Lendo PDF..." : "Importar Etiquetas"}
                <input type="file" accept=".pdf" multiple onChange={handleLabelUpload} style={{ display: "none" }} disabled={pedidosParsing} />
              </label>
              {pedidos.length > 0 && <button className="bs" onClick={() => { if (confirm("Limpar todos os pedidos?")) { setPedidos([]); db.deleteAllOrders().catch(() => {}); showToast("Pedidos limpos"); } }} style={{ color: "#f87171", borderColor: "rgba(248,113,113,.3)" }}><I n="trash" s={14} /> Limpar</button>}
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
            {(() => {
              const filtered = getFilteredPedidos();
              const pendentes = filtered.filter(p => !p.feito);
              const feitos = filtered.filter(p => p.feito);
              const allStores = [...new Set(pedidos.map(p => p.remetente).filter(Boolean))].sort();
              const storeCounts = {};
              pedidos.filter(p => !p.feito).forEach(p => { const k = p.remetente || "Sem loja"; storeCounts[k] = (storeCounts[k] || 0) + 1; });
              const urgentCount = pedidos.filter(p => { if (p.feito || !p.envio) return false; const [d,m,y] = p.envio.split("/"); const dt = new Date(`${y}-${m}-${d}`); const t = new Date(); t.setHours(0,0,0,0); return dt <= t; }).length;

              const thStyle = { padding: "10px 16px", fontWeight: 600, color: "var(--t2)", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" };
              const sortIcon = (f) => pedidoSort.field === f ? (pedidoSort.dir === "asc" ? " ▲" : " ▼") : "";

              const isUrgent = (p) => { if (!p.envio) return false; const [d,m,y] = p.envio.split("/"); const dt = new Date(`${y}-${m}-${d}`); const t = new Date(); t.setHours(0,0,0,0); return dt <= t; };

              // Render a table row
              const renderRow = (p, isDone) => (
                <tr key={p.id} draggable={!isDone} onDragStart={() => setPedidoDrag(p.id)} onDragOver={e => e.preventDefault()} onDrop={() => handlePedidoDrop(p.id)}
                  style={{ borderBottom: "1px solid var(--brd)", background: isDone ? "rgba(52,211,153,.04)" : p.semArte ? "rgba(251,191,36,.08)" : isUrgent(p) ? "rgba(248,113,113,.06)" : "transparent", transition: "background .2s", cursor: isDone ? "default" : "grab" }}>
                  <td style={{ padding: "8px 12px", textAlign: "center" }}>
                    <input type="checkbox" checked={pedidoSelected.has(p.id)} onChange={() => toggleSelectPedido(p.id)} style={{ accentColor: "var(--accent)", width: 16, height: 16, cursor: "pointer" }} />
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "center" }}>
                    <button onClick={() => togglePedidoFeito(p.id)} style={{ background: isDone ? "#34d399" : "transparent", border: `2px solid ${isDone ? "#34d399" : "var(--brd)"}`, borderRadius: 6, width: 22, height: 22, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {isDone && <I n="check" s={13} />}
                    </button>
                  </td>
                  <td style={{ padding: "8px 12px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontWeight: 600, fontFamily: "mono", fontSize: 12, textDecoration: isDone ? "line-through" : "none", color: isDone ? "var(--t3)" : "var(--t1)" }}>{p.pedido || "—"}</span>
                      {p.pedido && <button onClick={() => { navigator.clipboard.writeText(p.pedido); showToast("Copiado!"); }} title="Copiar" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--t3)", padding: 2, display: "flex", flexShrink: 0 }}><I n="copy" s={12} /></button>}
                      {p.semArte && <span style={{ padding: "2px 6px", borderRadius: 6, fontSize: 9, fontWeight: 700, background: "rgba(251,191,36,.2)", color: "#fbbf24" }}>SEM ARTE</span>}
                    </div>
                  </td>
                  <td style={{ padding: "8px 12px", color: isDone ? "var(--t3)" : "var(--t1)" }}>{p.remetente || "—"}</td>
                  <td style={{ padding: "8px 12px" }}>
                    {p.envio ? <span style={{ padding: "2px 8px", borderRadius: 8, fontSize: 11, fontWeight: 600, background: isDone ? "rgba(52,211,153,.1)" : isUrgent(p) ? "rgba(248,113,113,.15)" : "rgba(251,191,36,.12)", color: isDone ? "#34d399" : isUrgent(p) ? "#f87171" : "#fbbf24" }}>{p.envio}</span> : <span style={{ color: "var(--t3)" }}>—</span>}
                  </td>
                  <td style={{ padding: "8px 12px" }}>
                    {(p.skus && p.skus.length > 1) ? p.skus.map((s, si) => (
                      <div key={si} style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 2 }}>
                        <span style={{ padding: "2px 8px", borderRadius: 8, fontSize: 11, fontWeight: 600, background: isDone ? "rgba(52,211,153,.1)" : "rgba(232,93,58,.12)", color: isDone ? "#34d399" : "#e85d3a" }}>{s.modelo}</span>
                        <button onClick={() => renameSku(p.id, si)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--t3)", padding: 1, display: "flex" }}><I n="edit" s={11} /></button>
                      </div>
                    )) : (
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={{ padding: "2px 8px", borderRadius: 8, fontSize: 11, fontWeight: 600, background: isDone ? "rgba(52,211,153,.1)" : "rgba(232,93,58,.12)", color: isDone ? "#34d399" : "#e85d3a" }}>{p.modelo || "—"}</span>
                        <button onClick={() => renameSku(p.id, 0)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--t3)", padding: 1, display: "flex" }}><I n="edit" s={11} /></button>
                      </div>
                    )}
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "center", fontFamily: "mono", fontWeight: 700, color: isDone ? "var(--t3)" : "var(--t1)" }}>
                    {(p.skus && p.skus.length > 1) ? p.skus.map((s, si) => <div key={si}>{s.quantidade}</div>) : (p.quantidade || "—")}
                  </td>
                  <td style={{ padding: "8px 12px" }}>
                    <input value={p.obs || ""} onChange={e => updatePedidoObs(p.id, e.target.value)} placeholder="Obs..."
                      style={{ background: "transparent", border: "1px solid var(--brd)", borderRadius: 6, padding: "4px 8px", fontSize: 11, color: "var(--t1)", width: 100 }} />
                  </td>
                  <td style={{ padding: "8px 12px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                      <button onClick={() => toggleSemArte(p.id)} title={p.semArte ? "Remover alerta" : "Sem arte"} style={{ background: "none", border: "none", cursor: "pointer", color: p.semArte ? "#fbbf24" : "var(--t3)", padding: 2, display: "flex" }}><I n="alert" s={13} /></button>
                      <button onClick={() => removePedido(p.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--t3)", padding: 2, display: "flex" }}><I n="trash" s={13} /></button>
                    </div>
                  </td>
                </tr>
              );

              return <>
                {/* Summary cards */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, marginBottom: 16 }}>
                  {[
                    { l: "Total", v: pedidos.length, c: "#e85d3a" },
                    { l: "Pendentes", v: pedidos.filter(p => !p.feito).length, c: "#fbbf24" },
                    { l: "Sem Arte", v: pedidos.filter(p => p.semArte && !p.feito).length, c: "#f59e0b" },
                    { l: "Feitos", v: pedidos.filter(p => p.feito).length, c: "#34d399" },
                    { l: "Unidades", v: pedidos.reduce((s, p) => s + (p.quantidade || 0), 0), c: "var(--t1)" },
                  ].map((s, i) => (
                    <div key={i} style={{ background: "var(--card)", borderRadius: 12, border: "1px solid var(--brd)", padding: 14, textAlign: "center" }}>
                      <div style={{ fontSize: 26, fontWeight: 700, color: s.c, fontFamily: "mono" }}>{s.v}</div>
                      <div style={{ fontSize: 10, color: "var(--t3)", marginTop: 2 }}>{s.l}</div>
                    </div>
                  ))}
                </div>

                {/* Store counters */}
                {Object.keys(storeCounts).length > 1 && (
                  <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
                    {Object.entries(storeCounts).sort((a,b) => b[1]-a[1]).map(([store, count]) => (
                      <button key={store} onClick={() => setPedidoFilter(f => ({ ...f, store: f.store === store ? "" : store }))}
                        style={{ padding: "6px 14px", borderRadius: 10, fontSize: 12, fontWeight: 600, cursor: "pointer", border: pedidoFilter.store === store ? "2px solid var(--accent)" : "1px solid var(--brd)", background: pedidoFilter.store === store ? "rgba(232,93,58,.1)" : "var(--card)", color: pedidoFilter.store === store ? "var(--accent)" : "var(--t2)", transition: "all .2s" }}>
                        {store} <span style={{ fontFamily: "mono", marginLeft: 4 }}>{count}</span>
                      </button>
                    ))}
                  </div>
                )}

                {/* Search + Filters bar */}
                <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
                  <input value={pedidoSearch} onChange={e => setPedidoSearch(e.target.value)} placeholder="Buscar pedido, loja, modelo..."
                    style={{ flex: 1, minWidth: 200, background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 10, padding: "10px 16px", fontSize: 13, color: "var(--t1)" }} />
                  <select value={pedidoFilter.status} onChange={e => setPedidoFilter(f => ({ ...f, status: e.target.value }))}
                    style={{ background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 10, padding: "10px 14px", fontSize: 12, color: "var(--t1)", cursor: "pointer" }}>
                    <option value="">Todos status</option>
                    <option value="pendentes">Pendentes</option>
                    <option value="pendente">Pendente (sem alerta)</option>
                    <option value="semArte">Sem Arte</option>
                    <option value="feito">Feitos</option>
                  </select>
                  <select value={pedidoFilter.date} onChange={e => setPedidoFilter(f => ({ ...f, date: e.target.value }))}
                    style={{ background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 10, padding: "10px 14px", fontSize: 12, color: "var(--t1)", cursor: "pointer" }}>
                    <option value="">Todas datas</option>
                    <option value="hoje">Envio hoje</option>
                    <option value="semana">Esta semana</option>
                  </select>
                  {allStores.length > 1 && <select value={pedidoFilter.store} onChange={e => setPedidoFilter(f => ({ ...f, store: e.target.value }))}
                    style={{ background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 10, padding: "10px 14px", fontSize: 12, color: "var(--t1)", cursor: "pointer" }}>
                    <option value="">Todas lojas</option>
                    {allStores.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>}
                  {(pedidoSearch || pedidoFilter.store || pedidoFilter.status || pedidoFilter.date) && (
                    <button onClick={() => { setPedidoSearch(""); setPedidoFilter({ store: "", status: "", date: "" }); }} className="bs" style={{ fontSize: 12, padding: "10px 14px" }}>Limpar filtros</button>
                  )}
                </div>

                {/* Urgent alert */}
                {urgentCount > 0 && (
                  <div style={{ background: "rgba(248,113,113,.1)", border: "1px solid rgba(248,113,113,.3)", borderRadius: 12, padding: "12px 20px", marginBottom: 16, display: "flex", alignItems: "center", gap: 10, animation: "fadeIn .5s" }}>
                    <span style={{ fontSize: 20 }}>⚠️</span>
                    <span style={{ fontWeight: 600, color: "#f87171", fontSize: 13 }}>{urgentCount} pedido(s) com envio para hoje ou atrasado!</span>
                  </div>
                )}

                {/* Bulk action toolbar */}
                {pedidoSelected.size > 0 && (
                  <div style={{ background: "var(--accent)", borderRadius: 12, padding: "10px 20px", marginBottom: 16, display: "flex", alignItems: "center", gap: 12, animation: "fadeIn .2s" }}>
                    <span style={{ fontWeight: 700, color: "#fff", fontSize: 13 }}>{pedidoSelected.size} selecionado(s)</span>
                    <button onClick={() => bulkAction("feito")} style={{ background: "rgba(255,255,255,.2)", border: "none", borderRadius: 8, padding: "6px 14px", color: "#fff", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>✓ Marcar feito</button>
                    <button onClick={() => bulkAction("semArte")} style={{ background: "rgba(255,255,255,.2)", border: "none", borderRadius: 8, padding: "6px 14px", color: "#fff", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>⚠ Sem arte</button>
                    <button onClick={() => bulkAction("delete")} style={{ background: "rgba(255,255,255,.2)", border: "none", borderRadius: 8, padding: "6px 14px", color: "#fff", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>🗑 Excluir</button>
                    <button onClick={() => setPedidoSelected(new Set())} style={{ background: "none", border: "none", color: "rgba(255,255,255,.7)", cursor: "pointer", marginLeft: "auto", fontSize: 12 }}>Cancelar</button>
                  </div>
                )}

                {/* Results info */}
                <div style={{ fontSize: 12, color: "var(--t3)", marginBottom: 8 }}>
                  {filtered.length !== pedidos.length ? `Mostrando ${filtered.length} de ${pedidos.length} pedidos` : `${pendentes.length} pendente(s) · ${feitos.length} feito(s)`}
                </div>

                {/* Table — Pendentes */}
                {pendentes.length > 0 && (
                <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", overflow: "hidden", marginBottom: 20 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: "2px solid var(--brd)", textAlign: "left" }}>
                        <th style={{ ...thStyle, width: 36, cursor: "default" }}>
                          <input type="checkbox" checked={pedidoSelected.size > 0 && pendentes.every(p => pedidoSelected.has(p.id))} onChange={() => selectAllVisible(pendentes.map(p => p.id))} style={{ accentColor: "var(--accent)", width: 16, height: 16, cursor: "pointer" }} />
                        </th>
                        <th style={{ ...thStyle, width: 36, cursor: "default" }}>●</th>
                        <th style={thStyle} onClick={() => togglePedidoSort("pedido")}>Pedido{sortIcon("pedido")}</th>
                        <th style={thStyle} onClick={() => togglePedidoSort("remetente")}>Loja{sortIcon("remetente")}</th>
                        <th style={thStyle} onClick={() => togglePedidoSort("envio")}>Envio{sortIcon("envio")}</th>
                        <th style={thStyle} onClick={() => togglePedidoSort("modelo")}>Modelo{sortIcon("modelo")}</th>
                        <th style={{ ...thStyle, textAlign: "center" }} onClick={() => togglePedidoSort("quantidade")}>Qtd{sortIcon("quantidade")}</th>
                        <th style={{ ...thStyle, cursor: "default" }}>Obs</th>
                        <th style={{ ...thStyle, width: 60, cursor: "default" }}></th>
                      </tr>
                    </thead>
                    <tbody>{pendentes.map(p => renderRow(p, false))}</tbody>
                  </table>
                </div>
                )}

                {/* Feitos section */}
                {feitos.length > 0 && (
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                      <h3 style={{ fontSize: 14, fontWeight: 700, color: "#34d399" }}>Concluídos ({feitos.length})</h3>
                      <button className="bs" onClick={() => {
                        const codes = feitos.map(p => p.pedido).filter(Boolean);
                        if (!codes.length) return;
                        navigator.clipboard.writeText(codes.join("\n"));
                        showToast(`${codes.length} código(s) copiado(s)`);
                      }} style={{ color: "#34d399", borderColor: "rgba(52,211,153,.3)", display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                        <I n="copy" s={13} /> Copiar códigos
                      </button>
                    </div>
                    <div style={{ background: "var(--card)", borderRadius: 14, border: "1px solid var(--brd)", overflow: "hidden" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                        <thead>
                          <tr style={{ borderBottom: "2px solid var(--brd)", textAlign: "left" }}>
                            <th style={{ ...thStyle, width: 36, cursor: "default" }}></th>
                            <th style={{ ...thStyle, width: 36, cursor: "default" }}>●</th>
                            <th style={thStyle}>Pedido</th><th style={thStyle}>Loja</th><th style={thStyle}>Envio</th>
                            <th style={thStyle}>Modelo</th><th style={{ ...thStyle, textAlign: "center" }}>Qtd</th>
                            <th style={{ ...thStyle, cursor: "default" }}>Obs</th>
                            <th style={{ ...thStyle, width: 60, cursor: "default" }}></th>
                          </tr>
                        </thead>
                        <tbody>{feitos.map(p => renderRow(p, true))}</tbody>
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

        {/* LAPIS / PRINTLAB */}
        {tab === "nomes" && <Suspense fallback={<div style={{ textAlign: "center", padding: 60, color: "var(--t2)" }}>Carregando...</div>}><NameLabels /></Suspense>}
        {tab === "lapisdtf" && <Suspense fallback={<div style={{ textAlign: "center", padding: 60, color: "var(--t2)" }}>Carregando...</div>}><NameLabels key="dtf" variant="dtf" /></Suspense>}
        {tab === "lapis" && <Suspense fallback={<div style={{ textAlign: "center", padding: 60, color: "var(--t2)" }}>Carregando PrintLab...</div>}><PrintLab /></Suspense>}
        {tab === "vetorizar" && <Suspense fallback={<div style={{ textAlign: "center", padding: 60, color: "var(--t2)" }}>Carregando...</div>}><Vectorize /></Suspense>}
        {tab === "ampliar" && <Suspense fallback={<div style={{ textAlign: "center", padding: 60, color: "var(--t2)" }}>Carregando...</div>}><Upscale onVectorize={file => { sendFiles([file]); setTab("vetorizar"); }} /></Suspense>}

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
