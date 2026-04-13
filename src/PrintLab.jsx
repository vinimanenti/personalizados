import { useState, useRef, useEffect } from "react";

/* ─── Constants ─── */
const COLS = 6, ROWS = 25, LPP = COLS * ROWS, PPP = 12;
const PW = 328, PH = 497, LW = 50, LH = 18, MM = 2.8346;
const GW = COLS * LW, GH = ROWS * LH, ML = (PW - GW) / 2, MT = (PH - GH) / 2;
const PW_PT = PW * MM, PH_PT = PH * MM, LW_PT = LW * MM, LH_PT = LH * MM;
const CLW = 0.5, DFS = 24, MFS = 8, HFS = 16, PAD = 2 * MM, AW = LW_PT - 2 * PAD, MLFS = 16;
const SKIP = new Set(["NÃO ENCONTRADO", "NOT FOUND", "NÃO DETECTADO", "NAO DETECTADO", ""]);
const QO = [50, 75, 100, 150];
const FONTS = {
  cookie: { label: "Cookie", urls: ["https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/cookie/Cookie-Regular.ttf", "https://github.com/google/fonts/raw/main/ofl/cookie/Cookie-Regular.ttf"], css: "'Cookie',cursive", yO: 0.25, ls: 1.2, cw: 0.48 },
  bebas: { label: "Bebas Neue", urls: ["https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/bebasneue/BebasNeue-Regular.ttf", "https://github.com/google/fonts/raw/main/ofl/bebasneue/BebasNeue-Regular.ttf"], css: "'Bebas Neue',sans-serif", yO: 0.2, ls: 1.0, cw: 0.35 },
};
const FK = Object.keys(FONTS), DF = "cookie";
const EMOJIS = ["😀","😂","🥰","😍","😘","🤩","😎","🥳","😇","🤗","❤️","🧡","💛","💚","💙","💜","🖤","🤍","💖","💝","👍","👏","🙏","✌️","🤞","💪","👋","🤝","✨","🔥","🌸","🌺","🌻","🌹","🌷","🌼","🍀","🌈","⭐","🌙","🦋","🐾","🐶","🐱","🦄","🐻","🐰","🦊","🐝","🕊️","👑","💎","🎀","🎁","🎉","🎂","🎈","💐","📿","🧿","🍕","🍰","🧁","🍫","☕","🍷","🥂","🍓","🍒","🫶"];

const emptyFields = () => [
  { nome: "", qty: 150, fs: DFS, font: DF, emoji: "", emojiPos: "before" },
  { nome: "", qty: 150, fs: DFS, font: DF, emoji: "", emojiPos: "before" },
  { nome: "", qty: 150, fs: DFS, font: DF, emoji: "", emojiPos: "before" },
];

function splitN(n) { return n.split("-").map(s => s.trim()).filter(s => s.length > 0); }

function buildLabels(fields) {
  const o = [];
  for (const f of fields) {
    const nm = f.nome.trim();
    if (!nm || SKIP.has(nm.toUpperCase())) continue;
    let d = nm;
    if (f.emoji) d = f.emojiPos === "after" ? `${nm} ${f.emoji}` : `${f.emoji} ${nm}`;
    for (let i = 0; i < f.qty; i++) o.push({ name: d, fs: f.fs || DFS, font: f.font || DF });
  }
  return o.slice(0, LPP);
}

function autoQty(names) {
  const f = names.filter(n => n.trim() && !SKIP.has(n.trim().toUpperCase()));
  return f.length <= 1 ? 150 : f.length === 2 ? 75 : 50;
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const sep = lines[0].includes(";") ? ";" : ",";
  const hdr = lines[0].split(sep).map(h => h.trim().replace(/^["'\uFEFF]+|["']+$/g, ""));
  const hU = hdr.map(h => h.toUpperCase().replace(/[\s_-]+/g, ""));
  const idI = hU.findIndex(h => h === "ID"), n1 = hU.findIndex(h => h === "NOME1"), n2 = hU.findIndex(h => h === "NOME2"), n3 = hU.findIndex(h => h === "NOME3"), nF = hU.findIndex(h => h === "NOME");
  const pages = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(sep).map(x => x.trim().replace(/^["']+|["']+$/g, ""));
    const id = idI >= 0 ? (c[idI] || "").trim() : "";
    let names;
    if (n1 >= 0) names = [(c[n1] || "").trim(), n2 >= 0 ? (c[n2] || "").trim() : "", n3 >= 0 ? (c[n3] || "").trim() : ""];
    else if (nF >= 0) names = [(c[nF] || "").trim(), "", ""];
    else continue;
    const cl = names.map(n => (n && !SKIP.has(n.toUpperCase())) ? n : "");
    if (cl.every(n => !n)) continue;
    const q = autoQty(cl);
    const fields = cl.map(n => ({ nome: n, qty: n ? q : 0, fs: DFS, font: DF, emoji: "", emojiPos: "before" }));
    const labels = buildLabels(fields);
    if (labels.length > 0) pages.push({ pedido: id, dataEnvio: "", labels, fields, names: cl.filter(n => n) });
  }
  return pages;
}

function groupPDFs(p) { const g = []; for (let i = 0; i < p.length; i += PPP) g.push(p.slice(i, i + PPP)); return g; }

/* ─── Font / lib loaders ─── */
let _pl = null;
async function loadPdfLib() {
  if (_pl) return _pl;
  for (const u of ["https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js", "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js"]) {
    try { const r = await fetch(u); if (!r.ok) continue; const c = await r.text(); _pl = new Function(c + ";return PDFLib;")(); return _pl; } catch (e) { /* try next */ }
  }
  throw new Error("pdf-lib failed");
}
let _fk = null;
async function loadFontkit() {
  if (_fk) return _fk;
  for (const u of ["https://unpkg.com/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js", "https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js"]) {
    try { const r = await fetch(u); if (!r.ok) continue; const c = await r.text(); _fk = new Function(c + ";return fontkit;")(); return _fk; } catch (e) { /* try next */ }
  }
  return null;
}
let _fc = {};
async function loadFont(key) {
  if (_fc[key]) return _fc[key];
  const fc = FONTS[key];
  if (!fc) return null;
  for (const u of fc.urls) {
    try {
      const r = await fetch(u);
      if (!r.ok) continue;
      const b = await r.arrayBuffer();
      if (b.byteLength < 1000) continue;
      const m = new DataView(b).getUint32(0);
      if (m !== 0x00010000 && m !== 0x74727565) continue;
      _fc[key] = b;
      return b;
    } catch (e) { /* try next */ }
  }
  return null;
}

/* ─── Component ─── */
export default function PrintLab() {
  const [pedido, setPedido] = useState("");
  const [dataEnvio, setDataEnvio] = useState("");
  const [fields, setFields] = useState(emptyFields());
  const [pages, setPages] = useState([]);
  const [pvIdx, setPvIdx] = useState(-1);
  const [manualOpen, setManualOpen] = useState(true);
  const fileRef = useRef(null);
  const [gen, setGen] = useState(false);
  const [prog, setProg] = useState("");
  const [links, setLinks] = useState([]);
  const [expQ, setExpQ] = useState(null);
  const [emojiO, setEmojiO] = useState(null);
  const [toast, setToast] = useState(null);
  const [material, setMaterial] = useState("Branco"); // "Branco" ou "Transparente"

  const total = pages.length;
  const curL = buildLabels(fields);
  const hasC = curL.length > 0;
  const isEd = pvIdx === -1;
  const pvP = isEd ? { pedido, dataEnvio, labels: curL } : pages[pvIdx] ? { ...pages[pvIdx], pedido: pages[pvIdx].pedido || pedido, dataEnvio: pages[pvIdx].dataEnvio || dataEnvio } : { pedido: "", dataEnvio: "", labels: [] };
  const pvL = pvP.labels || [];

  const show = (msg, type = "success") => setToast({ msg, type });

  // Load Google Fonts CSS for preview
  useEffect(() => {
    if (!document.getElementById("printlab-fonts")) {
      const link = document.createElement("link");
      link.id = "printlab-fonts";
      link.rel = "stylesheet";
      link.href = "https://fonts.googleapis.com/css2?family=Cookie&family=Bebas+Neue&display=swap";
      document.head.appendChild(link);
    }
  }, []);

  const upF = (i, k, v) => { setFields(p => { const n = [...p]; n[i] = { ...n[i], [k]: k === "qty" || k === "fs" ? Number(v) : v }; return n; }); if (!isEd) setPvIdx(-1); setLinks([]); };
  const upN = (i, v) => {
    setFields(p => {
      const n = [...p]; n[i] = { ...n[i], nome: v };
      const an = n.map((f, j) => j === i ? v.trim() : f.nome.trim());
      const q = autoQty(an);
      return n.map((f, j) => ({ ...f, nome: j === i ? v : f.nome, qty: (j === i ? v : f.nome).trim() ? q : f.qty }));
    });
    if (!isEd) setPvIdx(-1); setLinks([]);
  };
  const addPage = () => { if (!hasC) return; setPages(p => [...p, { pedido, dataEnvio, labels: curL, fields: [...fields], names: fields.filter(f => f.nome.trim()).map(f => f.nome.trim()) }]); setFields(emptyFields()); setPvIdx(-1); setLinks([]); show("Pagina adicionada"); };
  const rmPage = i => { setPages(p => p.filter((_, j) => j !== i)); if (pvIdx >= pages.length - 1) setPvIdx(-1); if (expQ === i) setExpQ(null); setLinks([]); };
  const handleCSV = e => {
    const f = e.target.files[0]; if (!f) return; setLinks([]);
    const r = new FileReader();
    r.onload = ev => {
      const parsed = parseCSV(ev.target.result);
      if (!parsed.length) { show("CSV invalido", "error"); return; }
      setPages(prev => [...prev, ...parsed]); setPvIdx(pages.length);
      show(`${parsed.length} pagina${parsed.length > 1 ? "s" : ""} importada${parsed.length > 1 ? "s" : ""}`);
    };
    r.readAsText(f, "UTF-8"); e.target.value = "";
  };
  const upQF = (pi, fi, k, v) => {
    setPages(prev => {
      const n = [...prev]; const pg = { ...n[pi] }; const fl = [...pg.fields];
      fl[fi] = { ...fl[fi], [k]: k === "fs" ? Number(v) : v };
      pg.fields = fl; pg.labels = buildLabels(fl);
      pg.names = fl.filter(f => f.nome.trim()).map(f => f.nome.trim());
      n[pi] = pg; return n;
    }); setLinks([]);
  };
  const clearAll = () => { if (pages.length && confirm("Limpar toda a fila?")) { setPages([]); setPvIdx(-1); setExpQ(null); setLinks([]); } };

  /* ─── PDF Generation ─── */
  const drawLabelText = (pg, x, y, name, fm, rgb, fs, fk) => {
    const cf = fm[fk] || fm[DF];
    const fc = FONTS[fk] || FONTS[DF];
    const cn = name.replace(/[\u{1F600}-\u{1F9FF}\u{2600}-\u{2B55}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, "").trim();
    if (!cn) return;
    const lines = splitN(cn);
    if (!lines.length) return;
    if (lines.length === 1) {
      let sz = fs;
      while (sz > MFS && cf.widthOfTextAtSize(lines[0], sz) > AW) sz -= 0.5;
      const tw = cf.widthOfTextAtSize(lines[0], sz);
      pg.drawText(lines[0], { x: x + (LW_PT - tw) / 2, y: y + (LH_PT - sz) / 2 + sz * fc.yO, size: sz, font: cf, color: rgb(0.216, 0.204, 0.208) });
    } else {
      const mb = Math.min(fs, MLFS);
      const info = lines.map(l => { let sz = mb; while (sz > MFS && cf.widthOfTextAtSize(l, sz) > AW) sz -= 0.5; return { t: l, s: Math.min(sz, mb) }; });
      const ls = fc.ls;
      let th = info.reduce((s, li) => s + li.s * ls, 0);
      if (th > LH_PT) { const r = LH_PT / th; info.forEach(li => { li.s = Math.max(MFS, li.s * r); }); th = info.reduce((s, li) => s + li.s * ls, 0); }
      let cy = y + (LH_PT + th) / 2 - info[0].s * (ls - 0.2);
      for (const li of info) {
        const tw = cf.widthOfTextAtSize(li.t, li.s);
        pg.drawText(li.t, { x: x + (LW_PT - tw) / 2, y: cy, size: li.s, font: cf, color: rgb(0.216, 0.204, 0.208) });
        cy -= li.s * ls;
      }
    }
  };

  const drawGridCutContour = (pg, ctx, sepRef, PDFLib) => {
    const { PDFName, PDFArray } = PDFLib;
    // Register CutContour color space in page resources
    const pageDict = pg.node;
    let resources = pageDict.get(PDFName.of("Resources"));
    if (!resources) { resources = ctx.obj({}); pageDict.set(PDFName.of("Resources"), resources); }
    let colorSpaces = resources.get(PDFName.of("ColorSpace"));
    if (!colorSpaces) { colorSpaces = ctx.obj({}); resources.set(PDFName.of("ColorSpace"), colorSpaces); }
    colorSpaces.set(PDFName.of("CS_CutContour"), sepRef);

    const gL = ML * MM, gT = PH_PT - MT * MM, gB = gT - ROWS * LH_PT, gR = gL + COLS * LW_PT;
    const ops = [
      "q",
      "/CS_CutContour CS",
      "1 SCN",
      `${CLW.toFixed(2)} w`,
    ];
    // Vertical lines
    for (let c = 0; c <= COLS; c++) {
      const x = gL + c * LW_PT;
      ops.push(`${x.toFixed(2)} ${gT.toFixed(2)} m`, `${x.toFixed(2)} ${gB.toFixed(2)} l`, "S");
    }
    // Horizontal lines
    for (let r = 0; r <= ROWS; r++) {
      const y = gT - r * LH_PT;
      ops.push(`${gL.toFixed(2)} ${y.toFixed(2)} m`, `${gR.toFixed(2)} ${y.toFixed(2)} l`, "S");
    }
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
      pageDict.set(PDFName.of("Contents"), ctx.obj([rawRef]));
    }
  };

  const drawPage = (pg, pd, fm, af, rgb, ctx, sepRef, PDFLib, mat) => {
    // Gray border at page edge (cartela limit)
    const bw = 0.4;
    pg.drawRectangle({ x: bw / 2, y: bw / 2, width: PW_PT - bw, height: PH_PT - bw, borderWidth: bw, borderColor: rgb(0.216, 0.204, 0.208), color: undefined });

    const hA = MT * MM;
    // Material label — top left
    if (mat) {
      let sz = 10;
      pg.drawText(mat, { x: 6, y: PH_PT - hA * 0.55, size: sz, font: af, color: rgb(0.15, 0.15, 0.15) });
    }
    if (pd.pedido) {
      let sz = HFS;
      while (sz > MFS && af.widthOfTextAtSize(pd.pedido, sz) > PW_PT * 0.4) sz -= 0.5;
      pg.drawText(pd.pedido, { x: PW_PT * 0.38, y: PH_PT - hA * 0.55, size: sz, font: af, color: rgb(0.15, 0.15, 0.15) });
    }
    if (pd.dataEnvio) {
      let sz = HFS;
      while (sz > MFS && af.widthOfTextAtSize(pd.dataEnvio, sz) > PW_PT * 0.3) sz -= 0.5;
      pg.drawText(pd.dataEnvio, { x: PW_PT * 0.75, y: PH_PT - hA * 0.55, size: sz, font: af, color: rgb(0.15, 0.15, 0.15) });
    }
    // Text labels first, then CutContour grid on top
    for (let i = 0; i < pd.labels.length; i++) {
      const col = i % COLS, row = Math.floor(i / COLS);
      if (row >= ROWS) break;
      const lb = pd.labels[i];
      drawLabelText(pg, ML * MM + col * LW_PT, PH_PT - MT * MM - (row + 1) * LH_PT, lb.name, fm, rgb, lb.fs, lb.font);
    }
    drawGridCutContour(pg, ctx, sepRef, PDFLib);
  };

  const genPDFs = async () => {
    if (!total) return;
    setGen(true); setLinks([]); setProg("Carregando...");
    try {
      const PL = await loadPdfLib();
      const { PDFDocument, rgb, StandardFonts, PDFName, PDFArray } = PL;
      const fk = await loadFontkit();
      setProg("Fontes...");
      const fb = {};
      for (const k of FK) { fb[k] = await loadFont(k); }
      const allP = pages.map(p => ({ ...p, pedido: p.pedido || pedido, dataEnvio: p.dataEnvio || dataEnvio }));
      const groups = groupPDFs(allP);
      const lk = [];
      for (let gi = 0; gi < groups.length; gi++) {
        setProg(`PDF ${gi + 1}/${groups.length}`);
        const doc = await PDFDocument.create();
        if (fk) doc.registerFontkit(fk);
        const fm = {};
        for (const [k, b] of Object.entries(fb)) { if (b) try { fm[k] = await doc.embedFont(b); } catch (e) { /* fallback */ } }
        const hf = await doc.embedFont(StandardFonts.Helvetica);
        if (!fm.cookie) fm.cookie = hf;
        if (!fm.bebas) fm.bebas = hf;

        // Create CutContour spot color (Separation color space)
        const ctx = doc.context;
        const tintFn = ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 1, 0, 0], N: 1 });
        const tintFnRef = ctx.register(tintFn);
        const sepArray = ctx.obj([PDFName.of("Separation"), PDFName.of("CutContour"), PDFName.of("DeviceCMYK"), tintFnRef]);
        const sepRef = ctx.register(sepArray);

        for (const pd of groups[gi]) { const pg = doc.addPage([PW_PT, PH_PT]); drawPage(pg, pd, fm, hf, rgb, ctx, sepRef, PL, material); }
        const bytes = await doc.save();
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
        const d = new Date();
        lk.push({ url, name: `${material}_${String(d.getDate()).padStart(2, "0")}${String(d.getMonth() + 1).padStart(2, "0")}_${String(gi + 1).padStart(4, "0")}.pdf`, ct: groups[gi].length });
      }
      setLinks(lk); setProg("");
      show(`${lk.length} PDF${lk.length > 1 ? "s" : ""} gerado${lk.length > 1 ? "s" : ""}!`);
    } catch (err) {
      show(`Erro: ${err.message}`, "error");
    } finally { setGen(false); }
  };

  /* ─── Preview label render ─── */
  const S = 2.0;
  const renderName = (name, cw, ch, fs, fk) => {
    const fc = FONTS[fk] || FONTS[DF];
    const lines = splitN(name);
    const pp = S * 0.353;
    if (lines.length <= 1) {
      let sz = fs * pp;
      while (sz > 4 && name.length * sz * fc.cw > cw) sz *= 0.95;
      return <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", fontFamily: fc.css, fontSize: sz, color: "#e0e0e0", whiteSpace: "nowrap", textAlign: "center" }}>{name}</div>;
    }
    let sz = fs * pp;
    const lo = Math.max(...lines.map(l => l.length));
    while (sz > 4 && lo * sz * fc.cw > cw) sz *= 0.95;
    const th = lines.length * sz * fc.ls;
    if (th > ch) sz = ch / (lines.length * fc.ls);
    return <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", fontFamily: fc.css, textAlign: "center", lineHeight: fc.ls, color: "#e0e0e0" }}>{lines.map((l, i) => <div key={i} style={{ fontSize: sz, whiteSpace: "nowrap" }}>{l}</div>)}</div>;
  };

  /* ─── Styles adapted for dark theme ─── */
  const cardBg = "var(--card, #1e1e2e)";
  const brd = "var(--brd, #333)";
  const accent = "#4361ee";
  const accentBg = "rgba(67,97,238,0.12)";
  const t1 = "var(--t1, #e0e0e0)";
  const t2 = "var(--t2, #999)";
  const t3 = "var(--t3, #666)";
  const pink = "#e91e8c";

  return (
    <div style={{ display: "flex", gap: 24, animation: "fadeIn .3s" }}>
      {/* Toast */}
      {toast && (
        <div style={{ position: "fixed", top: 20, right: 20, padding: "12px 20px", borderRadius: 10, background: toast.type === "error" ? "rgba(239,68,68,0.15)" : "rgba(16,185,129,0.15)", border: `1px solid ${toast.type === "error" ? "#ef4444" : "#10b981"}`, color: toast.type === "error" ? "#ef4444" : "#10b981", fontSize: 13, fontWeight: 500, boxShadow: "0 8px 30px rgba(0,0,0,0.3)", zIndex: 999, display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 16 }}>{toast.type === "error" ? "!" : "ok"}</span>{toast.msg}
          <AutoDismiss onClose={() => setToast(null)} />
        </div>
      )}

      {/* LEFT PANEL — Controls */}
      <div style={{ width: 360, flexShrink: 0, display: "flex", flexDirection: "column", gap: 0, background: cardBg, borderRadius: 14, border: `1px solid ${brd}`, overflow: "hidden", height: PH * S + 40 }}>

        {/* Header */}
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${brd}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: accent, display: "flex", alignItems: "center", justifyContent: "center" }}><span style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>PL</span></div>
            <div><div style={{ fontSize: 16, fontWeight: 700, color: t1 }}>PrintLab</div><div style={{ fontSize: 11, color: t3 }}>Gerador de Etiquetas para Lapis</div></div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: "block", fontSize: 10, fontWeight: 600, color: t3, marginBottom: 4, textTransform: "uppercase", letterSpacing: 1 }}>N Pedido</label>
              <input placeholder="323265626" value={pedido} onChange={e => setPedido(e.target.value)} style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: `1px solid ${brd}`, background: "var(--bg, #12121a)", color: t1, fontSize: 13, fontFamily: "inherit", outline: "none" }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: "block", fontSize: 10, fontWeight: 600, color: t3, marginBottom: 4, textTransform: "uppercase", letterSpacing: 1 }}>Data Envio</label>
              <input placeholder="01/04/2026" value={dataEnvio} onChange={e => setDataEnvio(e.target.value)} style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: `1px solid ${brd}`, background: "var(--bg, #12121a)", color: t1, fontSize: 13, fontFamily: "inherit", outline: "none" }} />
            </div>
          </div>
        </div>

        {/* Material selector */}
        <div style={{ padding: "10px 20px", borderBottom: `1px solid ${brd}`, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: t3, textTransform: "uppercase", letterSpacing: 1 }}>Material</span>
          {["Branco", "Transparente"].map(m => (
            <button key={m} onClick={() => { setMaterial(m); setLinks([]); }} style={{ flex: 1, padding: "7px", borderRadius: 8, border: `1px solid ${material === m ? accent : brd}`, background: material === m ? accentBg : "transparent", color: material === m ? accent : t2, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{m}</button>
          ))}
        </div>

        {/* Actions */}
        <div style={{ padding: "10px 20px", borderBottom: `1px solid ${brd}`, display: "flex", gap: 6 }}>
          <button onClick={() => setManualOpen(!manualOpen)} style={{ flex: 1, padding: "8px", borderRadius: 8, border: `1px solid ${manualOpen ? accent : brd}`, background: manualOpen ? accentBg : "transparent", color: manualOpen ? accent : t2, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{manualOpen ? "X Fechar" : "+ Manual"}</button>
          <button onClick={() => fileRef.current?.click()} style={{ flex: 1, padding: "8px", borderRadius: 8, border: `1px solid ${brd}`, background: "transparent", color: t2, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>CSV</button>
          <input ref={fileRef} type="file" accept=".csv,.txt" onChange={handleCSV} style={{ display: "none" }} />
          {total > 0 && <button onClick={clearAll} style={{ padding: "8px 12px", borderRadius: 8, border: `1px solid ${brd}`, background: "transparent", color: "#ef4444", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }} title="Limpar fila">Limpar</button>}
        </div>

        {/* Manual form */}
        {manualOpen && (
          <div style={{ padding: "14px 20px", borderBottom: `1px solid ${brd}`, overflowY: "auto", flex: pages.length > 0 ? "none" : 1, minHeight: 0, maxHeight: pages.length > 0 ? 360 : undefined }}>
            {fields.map((f, idx) => (
              <div key={idx} style={{ background: "var(--bg, #12121a)", border: `1px solid ${f.nome.trim() ? "#34d399" : brd}`, borderRadius: 10, padding: 12, marginBottom: 8 }}>
                <input placeholder={`Nome ${idx + 1}`} value={f.nome} onChange={e => upN(idx, e.target.value)}
                  style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: `1px solid ${brd}`, background: cardBg, color: t1, fontSize: 14, fontFamily: "inherit", marginBottom: 8, outline: "none" }} />

                {/* Qty buttons */}
                <div style={{ display: "flex", gap: 3, marginBottom: 8 }}>
                  {QO.map(q => (
                    <button key={q} onClick={() => upF(idx, "qty", q)} style={{ flex: 1, padding: "5px", borderRadius: 6, border: `1px solid ${f.qty === q ? accent : brd}`, background: f.qty === q ? accentBg : "transparent", color: f.qty === q ? accent : t3, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{q}</button>
                  ))}
                </div>

                {/* Font selection */}
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontSize: 10, color: t3, fontWeight: 600 }}>FONTE</span>
                  {FK.map(k => (
                    <button key={k} onClick={() => upF(idx, "font", k)} style={{ padding: "5px 14px", borderRadius: 8, border: `1px solid ${f.font === k ? accent : brd}`, background: f.font === k ? accentBg : "transparent", color: f.font === k ? accent : t3, fontSize: 12, fontWeight: 600, fontFamily: FONTS[k].css, cursor: "pointer" }}>{FONTS[k].label}</button>
                  ))}
                </div>

                {/* Font size slider */}
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontSize: 10, color: t3, fontWeight: 600 }}>TAM</span>
                  <input type="range" min="8" max="120" step="1" value={f.fs} onChange={e => upF(idx, "fs", e.target.value)} style={{ flex: 1 }} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: accent, fontFamily: "monospace", minWidth: 34, textAlign: "right" }}>{f.fs}pt</span>
                </div>

                {/* Emoji */}
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <span style={{ fontSize: 10, color: t3, fontWeight: 600 }}>EMOJI</span>
                  <button onClick={() => setEmojiO(emojiO === idx ? null : idx)} style={{ padding: "2px 10px", borderRadius: 6, border: `1px solid ${emojiO === idx ? accent : brd}`, background: emojiO === idx ? accentBg : "transparent", color: t1, fontSize: 14, cursor: "pointer" }}>{f.emoji || "+"}</button>
                  {f.emoji && <>
                    <button onClick={() => upF(idx, "emojiPos", f.emojiPos === "before" ? "after" : "before")} style={{ padding: "2px 8px", borderRadius: 5, border: `1px solid ${brd}`, background: "transparent", color: t3, fontSize: 10, fontWeight: 600, cursor: "pointer" }}>{f.emojiPos === "before" ? "<-" : "->"}</button>
                    <button onClick={() => upF(idx, "emoji", "")} style={{ background: "none", border: "none", color: "#ef4444", fontSize: 12, cursor: "pointer" }}>X</button>
                  </>}
                </div>
                {emojiO === idx && (
                  <div style={{ marginTop: 6, padding: 6, background: cardBg, border: `1px solid ${brd}`, borderRadius: 8, display: "flex", flexWrap: "wrap", gap: 2, maxHeight: 90, overflowY: "auto" }}>
                    {EMOJIS.map((em, ei) => (
                      <button key={ei} onClick={() => { upF(idx, "emoji", em); setEmojiO(null); }} style={{ width: 28, height: 28, borderRadius: 5, border: "none", background: f.emoji === em ? accentBg : "transparent", fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>{em}</button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Add to queue button — always visible when manual is open */}
        {manualOpen && (
          <div style={{ padding: "8px 20px", borderBottom: `1px solid ${brd}` }}>
            <button onClick={addPage} disabled={!hasC} style={{ width: "100%", padding: "10px", borderRadius: 8, border: "none", background: hasC ? accent : brd, color: hasC ? "#fff" : t3, fontSize: 13, fontWeight: 600, cursor: hasC ? "pointer" : "not-allowed", fontFamily: "inherit" }}>Adicionar a fila</button>
          </div>
        )}

        {/* Queue */}
        <div style={{ flex: 1, overflowY: "auto", padding: "10px 20px" }}>
          {pages.length > 0 ? <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: t3, textTransform: "uppercase", letterSpacing: 1 }}>Fila de impressao</span>
              <span style={{ fontSize: 11, color: t3, fontFamily: "monospace" }}>{total} pag | {Math.ceil(total / PPP)} PDF{Math.ceil(total / PPP) > 1 ? "s" : ""}</span>
            </div>
            {pages.map((p, i) => {
              const isX = expQ === i;
              const isSel = pvIdx === i;
              return (
                <div key={i} style={{ marginBottom: 4, borderRadius: 8, overflow: "hidden", border: `1px solid ${isSel ? accent : isX ? t3 : brd}`, background: isSel ? accentBg : cardBg, transition: "border-color 0.12s" }}>
                  <div onClick={() => setPvIdx(i)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", cursor: "pointer", minHeight: 38 }}>
                    <span style={{ fontSize: 11, color: t3, fontWeight: 600, fontFamily: "monospace", minWidth: 22 }}>{String(i + 1).padStart(2, "0")}</span>
                    <div style={{ flex: 1, overflow: "hidden" }}>
                      <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: t1 }}>{(p.names || []).join(" | ") || "(vazio)"}</div>
                      {p.pedido && <div style={{ fontSize: 10, color: t3, marginTop: 1 }}>{p.pedido}</div>}
                    </div>
                    <button onClick={ev => { ev.stopPropagation(); setExpQ(isX ? null : i); }} style={{ background: "none", border: `1px solid ${brd}`, borderRadius: 6, color: isX ? accent : t3, fontSize: 10, padding: "2px 8px", fontWeight: 600, cursor: "pointer" }}>{isX ? "^" : "v"}</button>
                    <button onClick={ev => { ev.stopPropagation(); rmPage(i); }} style={{ background: "none", border: "none", color: "#ef4444", fontSize: 13, opacity: 0.5, cursor: "pointer" }}>X</button>
                  </div>
                  {isX && (
                    <div style={{ padding: "8px 12px 12px", borderTop: `1px solid ${brd}`, background: "var(--bg, #12121a)" }}>
                      {p.fields.map((f, fi) => {
                        if (!f.nome.trim() && fi > 0) return null;
                        return (
                          <div key={fi} style={{ marginBottom: fi < p.fields.length - 1 ? 10 : 0 }}>
                            <div style={{ display: "flex", gap: 6, marginBottom: 5 }} onClick={ev => ev.stopPropagation()}>
                              <input value={f.nome} onChange={ev => upQF(i, fi, "nome", ev.target.value)} placeholder={`Nome ${fi + 1}`}
                                style={{ flex: 1, fontSize: 13, padding: "7px 10px", borderRadius: 8, border: `1px solid ${brd}`, background: cardBg, color: t1, fontFamily: "inherit", outline: "none" }} />
                              <span style={{ fontSize: 11, color: t3, alignSelf: "center", flexShrink: 0, fontFamily: "monospace" }}>{f.qty}</span>
                            </div>
                            <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 4 }} onClick={ev => ev.stopPropagation()}>
                              <span style={{ fontSize: 9, color: t3, fontWeight: 600 }}>FONTE</span>
                              {FK.map(k => (
                                <button key={k} onClick={() => upQF(i, fi, "font", k)} style={{ padding: "3px 10px", borderRadius: 8, border: `1px solid ${f.font === k ? accent : brd}`, background: f.font === k ? accentBg : "transparent", color: f.font === k ? accent : t3, fontSize: 10, fontWeight: 600, fontFamily: FONTS[k].css, cursor: "pointer" }}>{FONTS[k].label}</button>
                              ))}
                            </div>
                            <div style={{ display: "flex", gap: 4, alignItems: "center" }} onClick={ev => ev.stopPropagation()}>
                              <span style={{ fontSize: 9, color: t3, fontWeight: 600 }}>TAM</span>
                              <input type="range" min="8" max="120" step="1" value={f.fs} onChange={ev => upQF(i, fi, "fs", ev.target.value)} style={{ flex: 1 }} />
                              <span style={{ fontSize: 12, fontWeight: 700, color: accent, fontFamily: "monospace", minWidth: 30, textAlign: "right" }}>{f.fs}pt</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </> : (
            <div style={{ textAlign: "center", padding: "48px 20px", color: t3 }}>
              <div style={{ fontSize: 14, fontWeight: 500 }}>Fila vazia</div>
              <div style={{ fontSize: 12, marginTop: 4 }}>Adicione manualmente ou importe CSV</div>
            </div>
          )}
        </div>

        {/* Bottom — PDF gen */}
        <div style={{ padding: "12px 20px", borderTop: `1px solid ${brd}` }}>
          {links.length > 0 && (
            <div style={{ marginBottom: 8, display: "flex", flexDirection: "column", gap: 3 }}>
              {links.map((l, i) => (
                <a key={i} href={l.url} download={l.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8, background: "rgba(16,185,129,0.1)", border: "1px solid rgba(16,185,129,0.3)", color: t1, textDecoration: "none", fontSize: 13, fontWeight: 500 }}>
                  <span style={{ color: "#10b981" }}>DL</span>
                  <span style={{ flex: 1 }}>{l.name}</span>
                  <span style={{ color: "#10b981", fontSize: 11, fontFamily: "monospace" }}>{l.ct}pg</span>
                </a>
              ))}
            </div>
          )}
          <button onClick={genPDFs} disabled={total === 0 || gen} style={{ width: "100%", padding: "12px", borderRadius: 8, border: "none", background: total === 0 ? brd : gen ? t3 : accent, color: total === 0 ? t3 : "#fff", fontSize: 14, fontWeight: 600, cursor: total === 0 || gen ? "not-allowed" : "pointer", fontFamily: "inherit", boxShadow: total > 0 && !gen ? "0 2px 12px rgba(67,97,238,0.2)" : "none" }}>
            {gen ? `${prog}` : `Gerar ${total > 0 ? Math.ceil(total / PPP) : 0} PDF${Math.ceil(total / PPP) > 1 ? "s" : ""}`}
          </button>
        </div>
      </div>

      {/* RIGHT PANEL — Preview */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
        {/* Navigation */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          {total > 0 && <button onClick={() => setPvIdx(p => Math.max(0, (p === -1 ? pages.length : p) - 1))} style={{ padding: "7px 16px", borderRadius: 8, border: `1px solid ${brd}`, background: cardBg, color: t2, fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" }}>{"<"}</button>}
          <span style={{ fontSize: 13, fontWeight: isEd ? 600 : 400, color: isEd ? "#10b981" : t2, fontFamily: "monospace" }}>
            {isEd ? "Editor" : ` ${pvIdx + 1} / ${total}`}
            {!isEd && <span style={{ color: t3, marginLeft: 6 }}>PDF {Math.floor(pvIdx / PPP) + 1}</span>}
          </span>
          {total > 0 && <button onClick={() => setPvIdx(p => p === -1 ? -1 : p < pages.length - 1 ? p + 1 : -1)} style={{ padding: "7px 16px", borderRadius: 8, border: `1px solid ${brd}`, background: cardBg, color: t2, fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" }}>{">"}</button>}
          {!isEd && <button onClick={() => setPvIdx(-1)} style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid rgba(16,185,129,0.3)", background: "rgba(16,185,129,0.1)", color: "#10b981", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Editor</button>}
        </div>

        {/* Page preview */}
        <div style={{ position: "relative", width: PW * S, height: PH * S, background: "#ffffff", borderRadius: 8, boxShadow: "0 4px 32px rgba(0,0,0,0.3)", border: `1px solid ${brd}`, overflow: "hidden" }}>
          {/* Gray border — cartela limit */}
          <div style={{ position: "absolute", inset: 0, border: "1.5px solid #373435", borderRadius: 0, pointerEvents: "none", zIndex: 5 }} />
          {/* Material label — top left */}
          <div style={{ position: "absolute", left: 6 * S, top: (MT * 0.5 - 5) * S, fontSize: 10 * S * 0.35, fontFamily: "Arial", fontWeight: 700, color: "#1a1a1a", whiteSpace: "nowrap", zIndex: 2 }}>{material}</div>
          {pvP.pedido && <div style={{ position: "absolute", left: PW * S * 0.38, top: (MT * 0.5 - 5) * S, fontSize: Math.min(30 * 0.3 * S, PW * S * 0.28 / Math.max(1, pvP.pedido.length * 0.5)), fontFamily: "Arial", fontWeight: 700, color: "#1a1a1a", whiteSpace: "nowrap" }}>{pvP.pedido}</div>}
          {pvP.dataEnvio && <div style={{ position: "absolute", left: PW * S * 0.75, top: (MT * 0.5 - 5) * S, fontSize: Math.min(30 * 0.3 * S, PW * S * 0.18 / Math.max(1, pvP.dataEnvio.length * 0.5)), fontFamily: "Arial", fontWeight: 700, color: "#1a1a1a", whiteSpace: "nowrap" }}>{pvP.dataEnvio}</div>}

          {/* Grid lines */}
          {Array.from({ length: COLS + 1 }).map((_, c) => (
            <div key={`v${c}`} style={{ position: "absolute", left: (ML + c * LW) * S, top: MT * S, width: 1, height: GH * S, background: pink, opacity: 0.25 }} />
          ))}
          {Array.from({ length: ROWS + 1 }).map((_, r) => (
            <div key={`h${r}`} style={{ position: "absolute", left: ML * S, top: (MT + r * LH) * S, width: GW * S, height: 1, background: pink, opacity: 0.25 }} />
          ))}

          {/* Labels */}
          {pvL.map((lb, i) => {
            const col = i % COLS, row = Math.floor(i / COLS);
            if (row >= ROWS) return null;
            return (
              <div key={i} style={{ position: "absolute", left: (ML + col * LW) * S + 1, top: (MT + row * LH) * S, width: LW * S - 2, height: LH * S, overflow: "hidden" }}>
                {renderName(lb.name, LW * S, LH * S, lb.fs, lb.font)}
              </div>
            );
          })}

          {/* Empty state */}
          {pvL.length === 0 && (
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: accent, display: "flex", alignItems: "center", justifyContent: "center" }}><span style={{ fontSize: 18, fontWeight: 700, color: "#fff" }}>PL</span></div>
              <span style={{ fontSize: 14, fontWeight: 600, color: "#666" }}>PrintLab</span>
              <span style={{ fontSize: 12, color: "#999" }}>Adicione nomes ou importe CSV</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* Auto-dismiss helper */
function AutoDismiss({ onClose }) {
  useEffect(() => { const t = setTimeout(onClose, 3500); return () => clearTimeout(t); }, []);
  return null;
}
