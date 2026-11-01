import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_OPTS, parseEntries, buildLabel, buildPencilLabel, rotateBox, buildCode, packLabels, sheetToSvg, pdfLayers, sheetContent, stackSheets, letterCmyk, cmykToHex, emojisIn, PART_SEP, nameIndex, COLOR_PRESETS, PENCIL_COLORS, pencilInk, expandPencilRows, parsePencilList } from "../lib/name-labels.mjs";
import { loadEmojiArt } from "../lib/emoji-art.mjs";
import { ART_KINDS, fitArtBoxes, planRotation } from "../lib/art-upload.mjs";
import { saveArtFile, loadArtFile, deleteArtFile } from "../lib/art-store.js";

const MM = 72 / 25.4; // mm → pt
const STORE_KEY = "name_labels_v1";
const QUEUE_KEY = "name_labels_queue_v1";
const FONT_FILES = { role: "times.ttf" };
// Fontes do nome (arquivos em public/fonts). Para adicionar outra, é só incluir aqui.
const NAME_FONTS = {
  greatvibes: { label: "Great Vibes", file: "greatvibes.ttf" },
  lobster: { label: "Lobster", file: "lobster.ttf" },
};
// Fontes do Lápis DTF UV; `upper` = sempre em maiúsculas.
const PENCIL_FONTS = {
  cookie: { label: "Cookie", file: "cookie.ttf" },
  arialbd: { label: "Arial Negrito", file: "arialbd.ttf", upper: true },
};
const PENCIL_QTYS = [50, 100, 150];
const emptyPencil = () => Array.from({ length: 3 }, () => ({ name: "", qty: 150, color: "", color2: "" }));

// Cada aba tem a sua configuração, rascunho e fila (o Lápis DTF UV é outro material).
const VARIANTS = {
  names: { storeKey: STORE_KEY, queueKey: QUEUE_KEY, fonts: NAME_FONTS, defaults: {}, file: "fila-etiquetas-nome" },
  dtf: { storeKey: "pencil_dtf_v1", queueKey: "pencil_dtf_queue_v1", fonts: PENCIL_FONTS, defaults: { nameFont: "cookie", nameSize: 24, maxWidth: 50, autoRotate: true }, file: "fila-lapis-dtf-uv" },
};
const EXAMPLE = "Ana Paula - Madrinha\nCarlos Eduardo - Padrinho\nMaria Clara - Dama de Honra";

/* ─── Loaders (mesmo CDN usado pelo PrintLab) ─── */
const loadScript = async (urls, global) => {
  for (const u of urls) {
    try { const r = await fetch(u); if (!r.ok) continue; return new Function(`${await r.text()};return ${global};`)(); } catch { /* próximo */ }
  }
  throw new Error(`Falha ao carregar ${global}`);
};
let _libs = null;
const loadLibs = () => _libs ||= Promise.all([
  loadScript(["https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js", "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js"], "PDFLib"),
  loadScript(["https://unpkg.com/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js", "https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js"], "fontkit"),
]).catch(e => { _libs = null; throw e; });

// Carrega a Times (função e código do pedido) e as fontes de nome da aba (`fontMap`).
const _fonts = new Map();
const loadFonts = fontMap => {
  const key = Object.keys(fontMap).join(",");
  if (!_fonts.has(key)) {
    _fonts.set(key, loadLibs().then(async ([, fontkit]) => {
      const base = import.meta.env.BASE_URL || "/";
      const get = async f => { const r = await fetch(`${base}fonts/${f}`); if (!r.ok) throw new Error(`Fonte ${f} não encontrada`); return new Uint8Array(await r.arrayBuffer()); };
      const keys = Object.keys(fontMap);
      const [role, ...names] = await Promise.all([get(FONT_FILES.role), ...keys.map(k => get(fontMap[k].file))]);
      return { role: fontkit.create(role), names: Object.fromEntries(keys.map((k, i) => [k, fontkit.create(names[i])])) };
    }).catch(e => { _fonts.delete(key); throw e; }));
  }
  return _fonts.get(key);
};

// Emojis coloridos em vetor (Twemoji); o desenho de cada um é baixado na primeira vez que aparece.
const EMOJI_PALETTE = ["💖", "❤️", "💕", "💗", "💜", "💙", "🤍", "✨", "⭐", "🌸", "🌹", "🌷", "🦋", "👑", "💍", "🎀", "🎉", "🥂", "🙏", "😍", "🥰", "😘", "👶", "🍼", "🐶", "🐱", "☀️", "🌈", "⚽", "🎂"];
const readJson = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };

function layoutJob(text, opts, loaded) {
  const fonts = { role: loaded.role, name: loaded.names[opts.nameFont] || loaded.names[DEFAULT_OPTS.nameFont] };
  const labels = parseEntries(text, opts).map(e => buildLabel(e, fonts, opts)).filter(Boolean);
  return packLabels(labels, opts, buildCode(fonts, opts));
}

// Lápis DTF UV: cada nome vira `qty` etiquetas iguais (até 2 linhas, no máximo `maxWidth` mm).
// Com autoRotate, cada nome escolhe quantas etiquetas vão deitadas e quantas em pé (giradas 90°)
// para gastar menos altura de rolo; as em pé vêm primeiro, para não misturar alturas na mesma linha.
function layoutPencilJob(names, opts, loaded) {
  const f = PENCIL_FONTS[opts.nameFont] || PENCIL_FONTS.cookie;
  const font = loaded.names[opts.nameFont] || Object.values(loaded.names)[0];
  const W = opts.sheetW - 2 * opts.margin;
  const upright = [], flat = [];
  for (const n of names.filter(n => n.name.trim())) {
    const label = buildPencilLabel(n.name, font, { ...opts, upper: !!f.upper });
    const box = label && n.color ? { ...label, ink: pencilInk(n.color) } : label;
    const qty = Math.max(0, n.qty | 0);
    if (!box || !qty) continue;
    const w = box.maxX - box.minX, h = box.maxY - box.minY;
    if (opts.autoRotate === false || w === h) { flat.push(...Array(qty).fill(box)); continue; }
    const p = planRotation(qty, w, h, W, opts.gap);
    const [tallBox, shortBox] = p.tallRot ? [rotateBox(box), box] : [box, rotateBox(box)];
    upright.push(...Array(p.tall).fill(tallBox));
    flat.push(...Array(p.short).fill(shortBox));
  }
  return packLabels([...upright, ...flat], opts, buildCode({ role: loaded.role }, opts));
}

// Arte enviada: `qty` cópias de w × h mm, com o código do pedido no canto, como as etiquetas.
// Com autoRotate, parte das cópias pode ser girada 90° para gastar menos altura de rolo.
function layoutArtJob(job, loaded, prepared) {
  const o = { ...DEFAULT_OPTS, ...job.opts };
  const boxes = fitArtBoxes(job.qty, job.w, job.h, { W: o.sheetW - 2 * o.margin, gap: o.gap, autoRotate: job.autoRotate !== false }, { artId: job.id, preview: prepared?.preview });
  return packLabels(boxes, job.opts, buildCode({ role: loaded.role }, job.opts));
}

// Coloca no PDF a cor (imagem ou página vetorial) e a máscara de contorno de cada arte enviada.
async function embedArts(doc, jobs, arts) {
  const ctx = doc.context, artRes = new Map(), xobjects = {}, embedded = new Map();
  for (const job of jobs.filter(j => j.kind === "art")) {
    const p = arts.get(job.artId);
    if (!p) throw new Error(`arquivo de ${job.name} não carregado`);
    if (!embedded.has(job.artId)) {
      const n = embedded.size + 1;
      let color, form = null, mask = null;
      if (p.kind === "png") color = await doc.embedPng(p.bytes);
      else if (p.kind === "jpg") color = await doc.embedJpg(p.bytes);
      else { [color] = await doc.embedPdf(p.pdfBytes, [0]); form = { w: color.width, h: color.height }; }
      xobjects[`Art${n}`] = color.ref;
      if (p.stencil) {
        const { w, h, bits } = p.stencil;
        xobjects[`Mask${n}`] = ctx.register(ctx.flateStream(bits, { Type: "XObject", Subtype: "Image", Width: w, Height: h, ImageMask: true, BitsPerComponent: 1 }));
        mask = `Mask${n}`;
      }
      embedded.set(job.artId, { color: `Art${n}`, form, mask });
    }
    const e = embedded.get(job.artId);
    artRes.set(job.id, { ...e, mask: job.mask === "shape" ? e.mask : null });
  }
  return { artRes, xobjects: ctx.obj(xobjects), hasArt: embedded.size > 0 };
}

// Gera um PDF com as folhas empilhadas uma embaixo da outra. Cada folha leva as camadas do seu pedido.
async function buildPdf(jobs, gap, art, arts = new Map()) {
  const [{ PDFDocument, PDFName }] = await loadLibs();
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const { artRes, xobjects, hasArt } = await embedArts(doc, jobs, arts);
  // Cores spot (Separation): o RIP reconhece pelo nome; `alt` é só a cor de visualização.
  const spotKeys = new Map(), colorSpaces = {};
  const withLayers = jobs.flatMap(({ sheets, opts, kind }) => {
    const layers = pdfLayers(kind === "art" ? { ...opts, letter: "white" } : opts).map(l => {
      if (!l.spot) return l;
      if (!spotKeys.has(l.spot)) {
        const key = `CS${spotKeys.size + 1}`;
        spotKeys.set(l.spot, key);
        const fn = ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: l.alt, N: 1 });
        colorSpaces[key] = ctx.register(ctx.obj([PDFName.of("Separation"), PDFName.of(l.spot), PDFName.of("DeviceCMYK"), fn]));
      }
      return { ...l, cs: spotKeys.get(l.spot) };
    });
    if (!layers.length && kind !== "art") throw new Error(`pedido ${opts.orderCode || "sem código"} sem nenhuma camada`);
    return sheets.map(sheet => ({ ...sheet, layers, overprint: opts.overprint }));
  });
  // Sobreposição do preenchimento: /op (preenchimento) e /OP (traço) + OPM 1
  const gsRef = ctx.register(ctx.obj({ Type: "ExtGState", op: true, OP: true, OPM: 1 }));
  for (const page of stackSheets(withLayers, { gap })) {
    const pg = doc.addPage([page.w * MM, page.h * MM]);
    const res = pg.node.normalizedEntries().Resources;
    if (spotKeys.size) res.set(PDFName.of("ColorSpace"), ctx.obj(colorSpaces));
    res.set(PDFName.of("ExtGState"), ctx.obj({ GSOver: gsRef }));
    if (hasArt) res.set(PDFName.of("XObject"), xobjects);
    const content = page.items.map(({ sheet, oy }) => sheetContent(sheet, sheet.layers, pg.getHeight(), sheet.overprint && "GSOver", oy, art, artRes)).join("");
    pg.node.addContentStream(ctx.register(ctx.flateStream(content)));
  }
  doc.setTitle(`Etiquetas nome — ${jobs.map(j => j.opts.orderCode).filter(Boolean).join(", ") || "sem código"}`);
  doc.setCreator("Sticker Studio");
  return doc.save();
}

const letterFill = o => o.letter === "white" ? "#fff" : cmykToHex(letterCmyk(o));
const letterName = o => o.letter === "white" ? "Branca" : o.letter === "color" ? `Cor ${(o.cmyk || []).join("/")}` : "Preta";

// variant "names" = aba Etiquetas Nome (nomes + upload de arte); "dtf" = aba Lápis DTF UV.
export default function NameLabels({ variant = "names" }) {
  const V = VARIANTS[variant];
  const STORE_KEY = V.storeKey, QUEUE_KEY = V.queueKey; // eslint-disable-line no-shadow
  const isDtf = variant === "dtf";
  const [text, setText] = useState(() => readJson(STORE_KEY, {}).text ?? (isDtf ? "" : EXAMPLE));
  const [opts, setOpts] = useState(() => ({ ...DEFAULT_OPTS, ...V.defaults, ...readJson(STORE_KEY, {}).opts }));
  const [queue, setQueue] = useState(() => readJson(QUEUE_KEY, []));
  const [fonts, setFonts] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // Lápis DTF UV: até 3 nomes, cada um com a sua quantidade.
  const [pencil, setPencil] = useState(() => readJson(STORE_KEY, {}).pencil ?? emptyPencil());
  const [pencilMode, setPencilMode] = useState(() => readJson(STORE_KEY, {}).pencilMode || "rows"); // "rows" (até 3) ou "list"
  const [listText, setListText] = useState(() => readJson(STORE_KEY, {}).listText || "");
  const [listQty, setListQty] = useState(() => readJson(STORE_KEY, {}).listQty || 50);
  const parsedList = useMemo(() => parsePencilList(listText, listQty), [listText, listQty]);
  const pencilEntries = useMemo(() => expandPencilRows(pencilMode === "list" ? parsedList.rows : pencil), [pencilMode, parsedList, pencil]);
  const upPencil = (i, k, v) => setPencil(ps => ps.map((p, j) => (j === i ? { ...p, [k]: v } : p)));

  // ─── Modo Arquivo: arte enviada (PNG/JPG/SVG/PDF) com Branco e Verniz ───
  const [mode, setMode] = useState(() => (isDtf ? "dtf" : readJson(STORE_KEY, {}).mode || "names"));
  const [arts, setArts] = useState(() => new Map()); // id do arquivo → arte preparada (art-prepare.js)
  const [cur, setCur] = useState(null);              // { fileId, w, h, qty, mask, lock } da arte no editor
  const [loadingArt, setLoadingArt] = useState(false);
  const fileRef = useRef(null);
  const curArt = cur && arts.get(cur.fileId);
  const readArt = async (id, file) => {
    const { prepareArt } = await import("../lib/art-prepare.js");
    const prepared = await prepareArt(file);
    setArts(m => new Map(m).set(id, prepared));
    return prepared;
  };
  // Artes da fila: os arquivos ficam no IndexedDB e são lidos de novo ao abrir a aba.
  useEffect(() => {
    for (const j of readJson(QUEUE_KEY, []).filter(j => j.kind === "art")) {
      loadArtFile(j.artId).then(f => f ? readArt(j.artId, f) : setErr(`Arquivo de ${j.name} não encontrado — remova e envie de novo`))
        .catch(e => setErr(`Erro ao ler ${j.name}: ${e.message}`));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const onFile = async file => {
    if (!file) return;
    setErr(""); setLoadingArt(true);
    try {
      const id = `art-${Date.now()}`;
      const data = { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) };
      const p = await readArt(id, data);
      await saveArtFile(id, data);
      if (cur && !queue.some(j => j.artId === cur.fileId)) deleteArtFile(cur.fileId).catch(() => {});
      const maxW = opts.sheetW - 2 * opts.margin;
      const k = p.w > maxW ? maxW / p.w : 1;
      setCur({ fileId: id, w: +(p.w * k).toFixed(1), h: +(p.h * k).toFixed(1), qty: 1, mask: p.stencil ? "shape" : "rect", lock: true, autoRotate: true });
    } catch (e) { setErr(`Não foi possível ler ${file.name}: ${e.message}`); }
    setLoadingArt(false);
  };
  const setSize = (k, v) => setCur(c => {
    const n = { ...c, [k]: v };
    if (c.lock && curArt && v > 0) {
      if (k === "w") n.h = +((v * curArt.h) / curArt.w).toFixed(1);
      if (k === "h") n.w = +((v * curArt.w) / curArt.h).toFixed(1);
    }
    return n;
  });
  const curArtJob = cur && curArt ? { id: "current", kind: "art", artId: cur.fileId, name: curArt.name, fileType: curArt.kind, w: cur.w, h: cur.h, qty: cur.qty, mask: cur.mask, autoRotate: cur.autoRotate !== false, opts, count: cur.qty } : null;

  const [art, setArt] = useState(() => new Map()); // emoji → formas coloridas (null = sem desenho)
  const [lastEmoji, setLastEmoji] = useState("💖");
  const textRef = useRef(null);
  useEffect(() => { loadFonts(V.fonts).then(setFonts, e => setErr(e.message)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const neededEmojis = useMemo(() => [...new Set([text, ...pencilEntries.map(p => p.name), ...queue.flatMap(j => j.names ? j.names.map(n => n.name) : [j.text || ""])].flatMap(emojisIn))], [text, pencilEntries, queue]);
  const loadArt = async seqs => {
    const got = await Promise.all(seqs.map(async q => [q, await loadEmojiArt(q)]));
    const next = new Map([...art, ...got]);
    setArt(next);
    return next;
  };
  useEffect(() => {
    const missing = neededEmojis.filter(q => !art.has(q));
    if (missing.length) loadArt(missing);
  }, [neededEmojis]); // eslint-disable-line react-hooks/exhaustive-deps
  const noArt = neededEmojis.filter(q => art.has(q) && !art.get(q));

  const insertEmoji = e => {
    setLastEmoji(e);
    const el = textRef.current;
    const a = el?.selectionStart ?? text.length, b = el?.selectionEnd ?? text.length;
    const before = text.slice(0, a), ins = (before && !/\s$/.test(before) ? " " : "") + e;
    setText(before + ins + text.slice(b));
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(a + ins.length, a + ins.length); });
  };
  // Coloca o emoji depois do nome em toda linha que ainda não tem emoji no nome.
  const emojiOnAll = e => setText(t => t.split(/\r?\n/).map(line => {
    if (!line.trim()) return line;
    const q = line.match(/\s+x\s*\d+\s*$/i);
    const body = q ? line.slice(0, q.index) : line;
    const pieces = body.split(new RegExp(`(${PART_SEP.source})`)); // [parte, separador, parte, …]
    const i = 2 * nameIndex(pieces.filter((_, j) => j % 2 === 0), opts.lines);
    if (emojisIn(pieces[i]).length) return line;
    pieces[i] = `${pieces[i].trimEnd()} ${e}`;
    return pieces.join("") + (q ? q[0] : "");
  }).join("\n"));
  useEffect(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify({ text, opts, mode, pencil, pencilMode, listText, listQty })); } catch { /* sem storage */ } }, [text, opts, mode, pencil, pencilMode, listText, listQty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch { /* sem storage */ } }, [queue]); // eslint-disable-line react-hooks/exhaustive-deps

  const entries = useMemo(() => parseEntries(text, opts), [text, opts]);
  const pencilCount = pencilEntries.reduce((n, p) => n + p.qty, 0);
  const nameSheets = useMemo(() => fonts && !isDtf ? layoutJob(text, opts, fonts) : [], [fonts, text, opts, isDtf]);
  const pencilSheets = useMemo(() => fonts && isDtf ? layoutPencilJob(pencilEntries, opts, fonts) : [], [fonts, pencilEntries, opts, isDtf]);
  const artSheets = fonts && curArtJob ? layoutArtJob(curArtJob, fonts, curArt) : [];
  const sheets = mode === "art" ? artSheets : isDtf ? pencilSheets : nameSheets;
  const rotatedCount = sheets.reduce((n, s) => n + s.placed.filter(p => p.box.rot).length, 0);
  const layoutQueued = j => j.kind === "art" ? layoutArtJob(j, fonts, arts.get(j.artId)) : j.kind === "dtf" ? layoutPencilJob(j.names, j.opts, fonts) : layoutJob(j.text, j.opts, fonts);
  const queueJobs = useMemo(() => fonts ? queue.map(j => ({ ...j, sheets: layoutQueued(j) })) : [], [fonts, queue, arts]); // eslint-disable-line react-hooks/exhaustive-deps
  const queueH = queueJobs.flatMap(j => j.sheets).reduce((h, s, i) => h + s.h + (i ? opts.gap : 0), 0);
  const tooWide = sheets.some(s => s.placed.some(p => p.box.maxX - p.box.minX > opts.sheetW - 2 * opts.margin));

  const up = (k, v) => setOpts(p => ({ ...p, [k]: v }));
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const download = (blob, name) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  const exportPdf = async (jobs, name) => {
    setBusy(true); setErr("");
    try {
      const seqs = [...new Set(jobs.flatMap(j => j.sheets.flatMap(s => s.placed.flatMap(p => (p.box.emojis || []).map(e => e.seq)))))];
      const full = seqs.every(q => art.has(q)) ? art : await loadArt(seqs);
      download(new Blob([await buildPdf(jobs, opts.gap, full, arts)], { type: "application/pdf" }), name);
    }
    catch (e) { setErr(`Erro ao gerar PDF: ${e.message}`); }
    setBusy(false);
  };
  const exportSvg = () => sheets.forEach((s, i) => download(new Blob([sheetToSvg(s, { fill: letterFill(opts), art })], { type: "image/svg+xml" }), `${isDtf ? "lapis-dtf-uv" : "etiquetas-nome"}-${stamp()}${sheets.length > 1 ? `-${i + 1}` : ""}.svg`));

  const addToQueue = () => {
    if (isDtf) {
      setQueue(q => [...q, { id: Date.now(), kind: "dtf", names: pencilEntries, opts, count: pencilCount }]);
      setPencil(emptyPencil()); setListText("");
    } else if (mode === "art") {
      const { opts: o, ...job } = curArtJob;
      setQueue(q => [...q, { ...job, id: Date.now(), opts: o }]);
      setCur(null);
    } else {
      setQueue(q => [...q, { id: Date.now(), text, opts, count: entries.length }]);
      setText("");
    }
    up("orderCode", "");
  };
  const editJob = job => {
    setOpts({ ...DEFAULT_OPTS, ...V.defaults, ...job.opts });
    if (job.kind === "dtf") {
      // Até 3 nomes diferentes volta para os campos (juntando as metades de cor); mais que isso, como lista.
      const groups = [];
      for (const n of job.names) {
        const g = groups.find(x => x.name === n.name && !x.color2 && x.color !== n.color);
        if (g && groups.length && g === groups[groups.length - 1]) { g.qty += n.qty; g.color2 = n.color || ""; }
        else groups.push({ name: n.name, qty: n.qty, color: n.color || "", color2: "" });
      }
      if (groups.length <= 3) { setPencilMode("rows"); setPencil([...groups.map(g => ({ ...g, custom: !PENCIL_QTYS.includes(g.qty) })), ...emptyPencil()].slice(0, 3)); }
      else { setPencilMode("list"); setListText(job.names.map(n => `${n.name}; ${n.qty}`).join(String.fromCharCode(10))); }
    } else if (job.kind === "art") {
      if (cur && !queue.some(j => j.artId === cur.fileId)) deleteArtFile(cur.fileId).catch(() => {});
      setMode("art");
      setCur({ fileId: job.artId, w: job.w, h: job.h, qty: job.qty, mask: job.mask, lock: true, autoRotate: job.autoRotate !== false });
    } else {
      setMode("names");
      setText(job.text);
    }
    setQueue(q => q.filter(j => j.id !== job.id));
  };
  const removeJob = job => {
    if (job.kind === "art" && cur?.fileId !== job.artId) deleteArtFile(job.artId).catch(() => {});
    setQueue(q => q.filter(j => j.id !== job.id));
  };
  const clearQueue = () => {
    queue.filter(j => j.kind === "art" && j.artId !== cur?.fileId).forEach(j => deleteArtFile(j.artId).catch(() => {}));
    setQueue([]);
  };
  const moveJob = (i, d) => setQueue(q => { const n = [...q]; [n[i], n[i + d]] = [n[i + d], n[i]]; return n; });

  const num = (label, key, unit, step = 1) => (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--t2)" }}>
      <span style={{ width: 120 }}>{label}</span>
      <input type="number" value={opts[key]} step={step} min={0} onChange={e => up(key, parseFloat(e.target.value) || 0)}
        style={{ width: 80, padding: "7px 9px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 13, textAlign: "center" }} />
      <span style={{ fontSize: 11, color: "var(--t3)" }}>{unit}</span>
    </label>
  );
  const card = { background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 14, padding: 18 };
  const swatch = (color, size = 14) => <span style={{ display: "inline-block", width: size, height: size, borderRadius: 4, background: color, border: "1px solid var(--brd)", flexShrink: 0 }} />;
  const small = { padding: "5px 9px", fontSize: 12 };

  const layerControls = <>
      <p style={{ fontSize: 11, color: "var(--t3)" }}>Camadas do RIP: {(mode === "art" ? ["Cores da arte", ...pdfLayers({ ...opts, letter: "white" }).map(l => l.label)] : pdfLayers(opts).map(l => l.label)).join(" > ") || "nenhuma"}</p>
      {[["whiteLayer", "whiteSpot", "Branco"], ["varnishLayer", "varnishSpot", "Verniz"]].map(([on, name, label]) => (
        <label key={on} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--t2)" }}>
          <input type="checkbox" checked={opts[on]} onChange={e => up(on, e.target.checked)} />
          <span style={{ width: 60 }}>{label}</span>
          <input value={opts[name]} onChange={e => up(name, e.target.value)}
            style={{ flex: 1, padding: "6px 9px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 12, fontFamily: "monospace" }} />
        </label>
      ))}
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--t2)" }}>
        <input type="checkbox" checked={opts.overprint} onChange={e => up("overprint", e.target.checked)} /> Impressão sobreposta do preenchimento (só Branco e Verniz)
      </label>
    </>;

  const field = { width: 80, padding: "7px 9px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 13, textAlign: "center" };
  const warn = t => <p style={{ fontSize: 12, color: "#fbbf24" }}>{t}</p>;
  const dpi = curArt?.px && cur?.w > 0 ? Math.round(curArt.px[0] / (cur.w / 25.4)) : null;
  const artEditor = <>
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--t2)" }}>
        <span style={{ width: 120, fontWeight: 600 }}>Código do pedido</span>
        <input value={opts.orderCode} onChange={e => up("orderCode", e.target.value)} placeholder="ex.: 251101ABC123"
          style={{ flex: 1, padding: "7px 9px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 13, fontFamily: "monospace" }} />
      </label>
      <h3 style={{ fontSize: 15 }}>Arquivo</h3>
      <div onClick={() => fileRef.current?.click()} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]); }}
        style={{ border: "2px dashed var(--brd)", borderRadius: 10, padding: 14, textAlign: "center", cursor: "pointer", fontSize: 13, color: "var(--t2)" }}>
        {loadingArt ? "Lendo arquivo…" : curArt
          ? <div style={{ display: "flex", alignItems: "center", gap: 12, textAlign: "left" }}>
              <img src={curArt.preview} alt="" style={{ width: 64, height: 64, objectFit: "contain", background: "repeating-conic-gradient(#bbb 0 25%, #eee 0 50%) 0 0/12px 12px", borderRadius: 6 }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{curArt.name}</div>
                <div style={{ fontSize: 11 }}>{ART_KINDS[curArt.kind]} · original {curArt.w.toFixed(1)} × {curArt.h.toFixed(1)} mm · clique para trocar</div>
              </div>
            </div>
          : <>Clique ou arraste aqui um <b>PNG, JPG, SVG ou PDF</b></>}
      </div>
      <input ref={fileRef} type="file" accept=".png,.jpg,.jpeg,.svg,.pdf,image/png,image/jpeg,image/svg+xml,application/pdf" style={{ display: "none" }}
        onChange={e => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
      {cur && curArt && <>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--t2)" }}>
          <span style={{ width: 60 }}>Medida</span>
          <input type="number" min={1} step={0.5} value={cur.w} onChange={e => setSize("w", parseFloat(e.target.value) || 0)} style={field} />
          ×
          <input type="number" min={1} step={0.5} value={cur.h} onChange={e => setSize("h", parseFloat(e.target.value) || 0)} style={field} />
          mm
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--t2)" }}>
          <input type="checkbox" checked={cur.lock} onChange={e => setCur(c => ({ ...c, lock: e.target.checked }))} /> Manter proporção
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--t2)" }}>
          <input type="checkbox" checked={cur.autoRotate !== false} onChange={e => setCur(c => ({ ...c, autoRotate: e.target.checked }))} /> Girar automaticamente para economizar material
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--t2)" }}>
          <span style={{ width: 60 }}>Quantidade</span>
          <input type="number" min={1} value={cur.qty} onChange={e => setCur(c => ({ ...c, qty: Math.max(1, parseInt(e.target.value, 10) || 1) }))} style={field} />
        </label>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--t2)" }}>
          <span style={{ width: 60 }}>Branco/Verniz</span>
          {[["shape", "Contorno"], ["rect", "Retângulo"]].map(([v, l]) => (
            <button key={v} className={cur.mask === v ? "bp" : "bs"} disabled={v === "shape" && !curArt.stencil} style={{ flex: 1, padding: "6px 10px", fontSize: 12 }}
              onClick={() => setCur(c => ({ ...c, mask: v }))}>{l}</button>
          ))}
        </div>
        {curArt.kind === "jpg" && warn("JPG não tem transparência: Branco e Verniz saem no retângulo da imagem.")}
        {cur.mask === "shape" && curArt.coverage > 0.97 && warn("Este arquivo não tem fundo transparente — o contorno vai sair igual ao retângulo.")}
        {curArt.hasText && warn("O SVG tem textos que não foram convertidos em curvas; eles podem sair com outra fonte. Converta em curvas no Corel antes de exportar.")}
        {curArt.pages > 1 && warn(`O PDF tem ${curArt.pages} páginas; só a primeira é usada.`)}
        {dpi && dpi < 200 && warn(`Resolução baixa para esse tamanho: ${dpi} dpi (o ideal é 300).`)}
        {Math.min(cur.w, cur.h) > opts.sheetW - 2 * opts.margin ? warn("A arte não cabe na largura da folha nem girada.")
          : cur.w > opts.sheetW - 2 * opts.margin && cur.autoRotate === false ? warn("A arte é mais larga que a folha — ative o giro automático ou diminua a medida.") : null}
      </>}
    </div>
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
      <h3 style={{ fontSize: 15, marginBottom: 4 }}>Camadas</h3>
      {layerControls}
    </div>
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
      <h3 style={{ fontSize: 15, marginBottom: 4 }}>Folha</h3>
      {num("Largura da folha", "sheetW", "mm")}
      {num("Altura máx.", "maxSheetH", "mm (0 = rolo)")}
      {num("Margem", "margin", "mm", 0.5)}
      {num("Espaço entre", "gap", "mm", 0.5)}
      {num("Código do pedido", "codeSize", "pt", 0.5)}
    </div>
  </>;

  const colorCard = (
  <div style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
    <h3 style={{ fontSize: 15, marginBottom: 4 }}>Cor da letra</h3>
    <div style={{ display: "flex", gap: 6 }}>
      {[["black", "Preta"], ["white", "Branca"], ["color", "Colorida"]].map(([v, l]) => (
        <button key={v} className={opts.letter === v ? "bp" : "bs"} style={{ flex: 1, padding: "7px 10px", fontSize: 12 }} onClick={() => up("letter", v)}>{l}</button>
      ))}
    </div>
    {opts.letter === "color" && <>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {swatch(letterFill(opts), 30)}
        {["C", "M", "Y", "K"].map((ch, i) => (
          <label key={ch} style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 12, color: "var(--t2)" }}>
            {ch}
            <input type="number" min={0} max={100} value={opts.cmyk[i]}
              onChange={e => up("cmyk", opts.cmyk.map((v, j) => j === i ? Math.min(100, Math.max(0, parseFloat(e.target.value) || 0)) : v))}
              style={{ width: 52, padding: "6px 4px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 12, textAlign: "center" }} />
          </label>
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {COLOR_PRESETS.map(([name, c]) => (
          <button key={name} className="bs" style={{ ...small, display: "flex", alignItems: "center", gap: 6 }} onClick={() => up("cmyk", c)}>
            {swatch(cmykToHex(c.map(v => v / 100)))}{name}
          </button>
        ))}
      </div>
    </>}
    {layerControls}
  </div>
  );

  const pencilEditor = <>
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--t2)" }}>
        <span style={{ width: 120, fontWeight: 600 }}>Código do pedido</span>
        <input value={opts.orderCode} onChange={e => up("orderCode", e.target.value)} placeholder="ex.: 251101ABC123"
          style={{ flex: 1, padding: "7px 9px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 13, fontFamily: "monospace" }} />
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h3 style={{ fontSize: 15, flex: 1 }}>Nomes</h3>
        {Object.entries(PENCIL_FONTS).map(([k, f]) => (
          <button key={k} className={opts.nameFont === k ? "bp" : "bs"} style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => up("nameFont", k)}>{f.label}</button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {[["rows", "Até 3 nomes"], ["list", "Lista (muitos nomes)"]].map(([m, l]) => (
          <button key={m} className={pencilMode === m ? "bp" : "bs"} style={{ flex: 1, padding: "6px 10px", fontSize: 12 }} onClick={() => setPencilMode(m)}>{l}</button>
        ))}
      </div>
      <p style={{ fontSize: 11, color: "var(--t3)" }}>
        Nome maior que {opts.maxWidth} mm vai para 2 linhas; use <b>-</b> para escolher onde quebrar (ex.: <b>Maria - Clara</b>).
        {PENCIL_FONTS[opts.nameFont]?.upper && " Arial Negrito sai sempre em MAIÚSCULAS."}
        {pencilMode === "rows" && " Cor \"Padrão\" segue a Cor da letra abaixo."}
      </p>
      {pencilMode === "list" ? <>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--t2)", flexWrap: "wrap" }}>
          <span>Quantidade de cada:</span>
          {PENCIL_QTYS.map(q => (
            <button key={q} className={listQty === q ? "bp" : "bs"} style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => setListQty(q)}>{q}</button>
          ))}
          <input type="number" min={1} value={listQty} onChange={e => setListQty(Math.max(1, parseInt(e.target.value, 10) || 1))} style={{ ...field, width: 70 }} title="Personalizado" />
        </div>
        <textarea value={listText} onChange={e => setListText(e.target.value)} rows={12} placeholder={"Ana Clara\nBia; 100\nCaio\nDudu; 150"}
          style={{ width: "100%", padding: 10, background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 13, fontFamily: "inherit", resize: "vertical" }} />
        <p style={{ fontSize: 11, color: "var(--t3)" }}>
          Um nome por linha. Para mudar a quantidade de um nome, coloque <b>;</b> e o número (ex.: <b>Bia; 100</b>).
          A lista inteira sai na <b>Cor da letra</b> abaixo.
        </p>
        {parsedList.errors.map(e => <p key={e} style={{ fontSize: 12, color: "#fbbf24" }}>{e} — fica com a quantidade de cada.</p>)}
      </> : pencil.map((p, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6, padding: 10, background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 10 }}>
          <input value={p.name} onChange={e => upPencil(i, "name", e.target.value)} placeholder={`Nome ${i + 1}`}
            style={{ padding: "7px 9px", background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 14 }} />
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--t2)" }}>
            {PENCIL_QTYS.map(q => (
              <button key={q} className={p.qty === q && !p.custom ? "bp" : "bs"} style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => setPencil(ps => ps.map((x, j) => (j === i ? { ...x, qty: q, custom: false } : x)))}>{q}</button>
            ))}
            <button className={p.custom ? "bp" : "bs"} style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => upPencil(i, "custom", true)}>Personalizado</button>
            {p.custom && <input type="number" min={1} value={p.qty} onChange={e => upPencil(i, "qty", Math.max(1, parseInt(e.target.value, 10) || 1))} style={{ ...field, width: 70 }} />}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--t2)", flexWrap: "wrap" }}>
            {[["color", "Cor"], ["color2", "Metade em"]].map(([k, l]) => (
              <label key={k} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                {l}
                {swatch(p[k] ? (pencilInk(p[k]).letter === "white" ? "#fff" : cmykToHex(letterCmyk(pencilInk(p[k])))) : k === "color" ? letterFill(opts) : "transparent")}
                <select value={p[k] || ""} onChange={e => upPencil(i, k, e.target.value)}
                  style={{ padding: "5px 6px", background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 12 }}>
                  <option value="">{k === "color" ? "Padrão" : "—"}</option>
                  {PENCIL_COLORS.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              </label>
            ))}
            {p.color2 && p.qty > 0 && <span style={{ fontSize: 11, color: "var(--t3)" }}>{Math.ceil(p.qty / 2)} + {Math.floor(p.qty / 2)}</span>}
          </div>
        </div>
      ))}
    </div>
    {colorCard}
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
      <h3 style={{ fontSize: 15, marginBottom: 4 }}>Folha e texto</h3>
      {num("Largura da folha", "sheetW", "mm")}
      {num("Altura máx.", "maxSheetH", "mm (0 = rolo)")}
      {num("Margem", "margin", "mm", 0.5)}
      {num("Espaço entre", "gap", "mm", 0.5)}
      {num("Tamanho da fonte", "nameSize", "pt", 0.5)}
      {num("Largura máx. do nome", "maxWidth", "mm", 1)}
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--t2)" }}>
        <input type="checkbox" checked={opts.autoRotate !== false} onChange={e => up("autoRotate", e.target.checked)} /> Girar nomes (em pé) para economizar material
      </label>
      {num("Código do pedido", "codeSize", "pt", 0.5)}
      {num("Emoji (× texto)", "emojiScale", "×", 0.05)}
      <button className="bs" style={{ marginTop: 6, ...small }} onClick={() => setOpts({ ...DEFAULT_OPTS, ...V.defaults, orderCode: opts.orderCode, nameFont: opts.nameFont, letter: opts.letter, cmyk: opts.cmyk, whiteSpot: opts.whiteSpot, varnishSpot: opts.varnishSpot })}>Restaurar padrão</button>
    </div>
  </>;


  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, animation: "fadeIn .3s" }}>
      {!isDtf && <div style={{ display: "flex", gap: 6 }}>
        {[["names", "Etiquetas de nome"], ["art", "Arquivo (upload)"]].map(([m, l]) => (
          <button key={m} className={mode === m ? "bp" : "bs"} style={{ padding: "8px 16px", fontSize: 13 }} onClick={() => setMode(m)}>{l}</button>
        ))}
      </div>}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(300px, 380px) 1fr", gap: 20 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {mode === "art" ? artEditor : isDtf ? pencilEditor : <>
          <div style={card}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--t2)", marginBottom: 14 }}>
              <span style={{ width: 120, fontWeight: 600 }}>Código do pedido</span>
              <input value={opts.orderCode} onChange={e => up("orderCode", e.target.value)} placeholder="ex.: 251101ABC123"
                style={{ flex: 1, padding: "7px 9px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 13, fontFamily: "monospace" }} />
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <h3 style={{ fontSize: 15, flex: 1 }}>Nomes</h3>
              {[[2, "2 linhas"], [3, "3 linhas"]].map(([n, l]) => (
                <button key={n} className={opts.lines === n ? "bp" : "bs"} style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => up("lines", n)}>{l}</button>
              ))}
            </div>
            <p style={{ fontSize: 11, color: "var(--t3)", marginBottom: 10 }}>
              {opts.lines === 3
                ? <>Um por linha: <b>Cima - Nome - Baixo</b> (Times / {NAME_FONTS[opts.nameFont]?.label} / Times). Com só <b>Nome - Baixo</b> ou só o <b>Nome</b>, o resto vem dos padrões abaixo.</>
                : <>Um por linha: <b>Nome - Função</b>.</>} Use <b>x3</b> no fim para repetir.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 2, marginBottom: 6 }}>
              {EMOJI_PALETTE.map(e => (
                <button key={e} title="Inserir no cursor" onClick={() => insertEmoji(e)}
                  style={{ fontSize: 17, lineHeight: 1, padding: 4, background: lastEmoji === e ? "var(--inp)" : "none", border: `1px solid ${lastEmoji === e ? "var(--brd)" : "transparent"}`, borderRadius: 6, cursor: "pointer" }}>{e}</button>
              ))}
            </div>
            <button className="bs" style={{ padding: "5px 9px", fontSize: 12, marginBottom: 8 }} onClick={() => emojiOnAll(lastEmoji)}>Colocar {lastEmoji} em todos os nomes</button>
            <textarea ref={textRef} value={text} onChange={e => setText(e.target.value)} rows={12}
              style={{ width: "100%", padding: 10, background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 13, fontFamily: "inherit", resize: "vertical" }} />
            {opts.lines === 3 && (
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--t2)", marginTop: 10 }}>
                <span style={{ width: 120 }}>Cima padrão</span>
                <input value={opts.defaultTop} onChange={e => up("defaultTop", e.target.value)} placeholder="ex.: Padrinhos"
                  style={{ flex: 1, padding: "7px 9px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 13 }} />
              </label>
            )}
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--t2)", marginTop: 10 }}>
              <span style={{ width: 120 }}>{opts.lines === 3 ? "Baixo padrão" : "Função padrão"}</span>
              <input value={opts.defaultRole} onChange={e => up("defaultRole", e.target.value)} placeholder="ex.: Madrinha"
                style={{ flex: 1, padding: "7px 9px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 13 }} />
            </label>
          </div>

          {colorCard}

          <div style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
            <h3 style={{ fontSize: 15, marginBottom: 4 }}>Folha e texto</h3>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--t2)" }}>
              <span style={{ width: 120 }}>Fonte do nome</span>
              <div style={{ display: "flex", gap: 6, flex: 1 }}>
                {Object.entries(NAME_FONTS).map(([k, f]) => (
                  <button key={k} className={opts.nameFont === k ? "bp" : "bs"} style={{ flex: 1, padding: "6px 10px", fontSize: 12 }} onClick={() => up("nameFont", k)}>{f.label}</button>
                ))}
              </div>
            </label>
            {num("Largura da folha", "sheetW", "mm")}
            {num("Altura máx.", "maxSheetH", "mm (0 = rolo)")}
            {num("Margem", "margin", "mm", 0.5)}
            {num("Espaço entre", "gap", "mm", 0.5)}
            {num("Nome", "nameSize", "pt", 0.5)}
            {opts.lines === 3 && num("Cima (Times)", "topSize", "pt", 0.5)}
            {opts.lines === 3 && num("Cima → nome", "topGap", "mm", 0.5)}
            {num(opts.lines === 3 ? "Baixo (Times)" : "Função (Times)", "roleSize", "pt", 0.5)}
            {num(opts.lines === 3 ? "Nome → baixo" : "Nome → função", "roleGap", "mm", 0.5)}
            {num("Folga das pernas", "roleClear", "mm", 0.5)}
            {num("Cópias de cada", "copies", "×")}
            {num("Código do pedido", "codeSize", "pt", 0.5)}
            {num("Emoji (× texto)", "emojiScale", "×", 0.05)}
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--t2)" }}>
              <input type="checkbox" checked={opts.roleUpper} onChange={e => up("roleUpper", e.target.checked)} /> Linhas em Times em MAIÚSCULAS
            </label>
            <button className="bs" style={{ marginTop: 6, ...small }} onClick={() => setOpts({ ...DEFAULT_OPTS, defaultRole: opts.defaultRole, orderCode: opts.orderCode, letter: opts.letter, cmyk: opts.cmyk, nameFont: opts.nameFont, lines: opts.lines, defaultTop: opts.defaultTop, whiteSpot: opts.whiteSpot, varnishSpot: opts.varnishSpot })}>Restaurar padrão</button>
          </div>
          </>}
        </div>

        <div style={{ ...card, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
            <h3 style={{ fontSize: 15, flex: 1 }}>
              {mode === "art" ? `${cur && curArt ? cur.qty : 0} cópia${cur?.qty === 1 ? "" : "s"}${rotatedCount ? ` (${rotatedCount} girada${rotatedCount === 1 ? "" : "s"})` : ""}` : isDtf ? `${pencilCount} etiqueta${pencilCount === 1 ? "" : "s"}${rotatedCount ? ` (${rotatedCount} em pé)` : ""}` : `${entries.length} etiqueta${entries.length === 1 ? "" : "s"}`}
              {sheets.length > 0 && <span style={{ fontSize: 12, color: "var(--t2)", fontWeight: 400 }}> · {sheets.map(s => `${(s.w / 10).toFixed(1)} × ${(s.h / 10).toFixed(1)} cm`).join(" + ")}</span>}
            </h3>
            {mode !== "art" && <button className="bs" disabled={!sheets.length} onClick={exportSvg}>Baixar SVG</button>}
            <button className="bs" disabled={!sheets.length || busy} onClick={() => exportPdf([mode === "art" ? { ...curArtJob, sheets } : { sheets, opts }], `${mode === "art" ? "arte" : isDtf ? "lapis-dtf-uv" : "etiquetas-nome"}-${opts.orderCode || stamp()}.pdf`)}>Baixar PDF</button>
            <button className="bp" disabled={!sheets.length} onClick={addToQueue}>+ Adicionar à fila</button>
          </div>
          {err && <p style={{ color: "#f87171", fontSize: 13, marginBottom: 10 }}>{err}</p>}
          {noArt.length > 0 && <p style={{ color: "#fbbf24", fontSize: 13, marginBottom: 10 }}>Sem desenho para: {noArt.join(" ")} — esse emoji não vai sair.</p>}
          {mode === "art" && !curArt && !loadingArt && <p style={{ color: "var(--t2)", fontSize: 13 }}>Envie um arquivo para ver as cópias na folha.</p>}
          {mode === "names" && tooWide && <p style={{ color: "#fbbf24", fontSize: 13, marginBottom: 10 }}>Algum nome é mais largo que a folha — diminua o tamanho da fonte.</p>}
          {!fonts && !err && <p style={{ color: "var(--t2)", fontSize: 13 }}>Carregando fontes…</p>}
          <div style={{ display: "flex", flexDirection: "column", gap: 16, maxHeight: "75vh", overflow: "auto" }}>
            {sheets.map((s, i) => (
              <div key={i} style={{ background: mode === "art" ? "repeating-conic-gradient(#d6d6d6 0 25%, #f4f4f4 0 50%) 0 0/16px 16px" : opts.letter === "white" ? "#3a3d45" : isDtf && pencilEntries.some(e => e.color === "branca") ? "#9aa0aa" : "#fff", borderRadius: 4, boxShadow: "0 1px 6px rgba(0,0,0,.3)" }}
                dangerouslySetInnerHTML={{ __html: sheetToSvg(s, { fill: letterFill(opts), codeFill: opts.letter === "white" ? "#b8bcc6" : "#000", art }).replace(/width="[^"]+" height="[^"]+"/, 'width="100%" style="display:block"') }} />
            ))}
          </div>
        </div>
      </div>

      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: queue.length ? 14 : 0 }}>
          <h3 style={{ fontSize: 15, flex: 1 }}>
            Fila de impressão ({queue.length})
            {queueH > 0 && <span style={{ fontSize: 12, color: "var(--t2)", fontWeight: 400 }}> · PDF único com {(opts.sheetW / 10).toFixed(1)} × {(queueH / 10).toFixed(1)} cm</span>}
          </h3>
          {queue.length > 0 && <button className="bs" onClick={() => { if (confirm("Limpar a fila de impressão?")) clearQueue(); }}>Limpar fila</button>}
          <button className="bp" disabled={!queueJobs.length || busy} onClick={() => exportPdf(queueJobs, `${V.file}-${stamp()}.pdf`)}>{busy ? "Gerando…" : "Gerar PDF único"}</button>
        </div>
        {!queue.length && <p style={{ fontSize: 13, color: "var(--t3)", marginTop: 8 }}>Monte um pedido ou envie um arquivo acima e clique em "Adicionar à fila". No fim, "Gerar PDF único" junta todos, um embaixo do outro.</p>}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {queue.map((job, i) => {
            const h = queueJobs[i]?.sheets.reduce((t, s) => t + s.h, 0) || 0;
            return (
              <div key={job.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 10 }}>
                <span style={{ width: 22, fontSize: 12, color: "var(--t3)" }}>{i + 1}.</span>
                {job.kind === "art"
                  ? <img src={arts.get(job.artId)?.preview} alt="" style={{ width: 18, height: 18, objectFit: "contain", flexShrink: 0 }} />
                  : swatch(letterFill(job.opts), 18)}
                <span style={{ fontFamily: "monospace", fontSize: 13, minWidth: 140 }}>{job.opts.orderCode || "sem código"}</span>
                <span style={{ fontSize: 12, color: "var(--t2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {job.kind === "art"
                    ? <>{job.qty} cópia{job.qty === 1 ? "" : "s"} · {job.name} · {job.w} × {job.h} mm · branco/verniz: {job.mask === "shape" ? "contorno" : "retângulo"} · {(h / 10).toFixed(1)} cm</>
                    : job.kind === "dtf"
                    ? <>{job.count} etiquetas · {PENCIL_FONTS[job.opts.nameFont]?.label || "Cookie"} · letra {letterName(job.opts)} · {(h / 10).toFixed(1)} cm · {job.names.map(n => `${n.name} ×${n.qty}${n.color ? ` (${PENCIL_COLORS.find(c => c.key === n.color)?.label})` : ""}`).join(", ")}</>
                    : <>{job.count} etiqueta{job.count === 1 ? "" : "s"} · {NAME_FONTS[job.opts.nameFont]?.label || "Great Vibes"} · letra {letterName(job.opts)} · {(h / 10).toFixed(1)} cm · {job.text.split(/\r?\n/).filter(Boolean).slice(0, 3).join(", ")}{job.text.split(/\r?\n/).filter(Boolean).length > 3 ? "…" : ""}</>}
                </span>
                <button className="bs" style={small} disabled={i === 0} onClick={() => moveJob(i, -1)} title="Subir">↑</button>
                <button className="bs" style={small} disabled={i === queue.length - 1} onClick={() => moveJob(i, 1)} title="Descer">↓</button>
                <button className="bs" style={small} onClick={() => editJob(job)}>Editar</button>
                <button className="bs" style={small} onClick={() => removeJob(job)}>Remover</button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
