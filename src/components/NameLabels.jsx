import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_OPTS, parseEntries, buildLabel, buildCode, packLabels, sheetToSvg, pdfLayers, sheetContent, stackSheets, letterCmyk, cmykToHex, emojisIn, PART_SEP, nameIndex } from "../lib/name-labels.mjs";
import { loadEmojiArt } from "../lib/emoji-art.mjs";

const MM = 72 / 25.4; // mm → pt
const STORE_KEY = "name_labels_v1";
const QUEUE_KEY = "name_labels_queue_v1";
const FONT_FILES = { role: "times.ttf" };
// Fontes do nome (arquivos em public/fonts). Para adicionar outra, é só incluir aqui.
const NAME_FONTS = {
  greatvibes: { label: "Great Vibes", file: "greatvibes.ttf" },
  lobster: { label: "Lobster", file: "lobster.ttf" },
};
const EXAMPLE = "Ana Paula - Madrinha\nCarlos Eduardo - Padrinho\nMaria Clara - Dama de Honra";
const COLOR_PRESETS = [
  ["Vermelho", [0, 100, 100, 0]],
  ["Azul marinho", [100, 80, 0, 30]],
  ["Dourado", [0, 25, 70, 20]],
  ["Rosé", [0, 40, 30, 5]],
  ["Verde", [80, 0, 100, 20]],
  ["Rosa", [0, 60, 0, 0]],
];

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

let _fonts = null;
const loadFonts = () => _fonts ||= loadLibs().then(async ([, fontkit]) => {
  const base = import.meta.env.BASE_URL || "/";
  const get = async f => { const r = await fetch(`${base}fonts/${f}`); if (!r.ok) throw new Error(`Fonte ${f} não encontrada`); return new Uint8Array(await r.arrayBuffer()); };
  const keys = Object.keys(NAME_FONTS);
  const [role, ...names] = await Promise.all([get(FONT_FILES.role), ...keys.map(k => get(NAME_FONTS[k].file))]);
  return { role: fontkit.create(role), names: Object.fromEntries(keys.map((k, i) => [k, fontkit.create(names[i])])) };
}).catch(e => { _fonts = null; throw e; });

// Emojis coloridos em vetor (Twemoji); o desenho de cada um é baixado na primeira vez que aparece.
const EMOJI_PALETTE = ["💖", "❤️", "💕", "💗", "💜", "💙", "🤍", "✨", "⭐", "🌸", "🌹", "🌷", "🦋", "👑", "💍", "🎀", "🎉", "🥂", "🙏", "😍", "🥰", "😘", "👶", "🍼", "🐶", "🐱", "☀️", "🌈", "⚽", "🎂"];
const readJson = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };

function layoutJob(text, opts, loaded) {
  const fonts = { role: loaded.role, name: loaded.names[opts.nameFont] || loaded.names[DEFAULT_OPTS.nameFont] };
  const labels = parseEntries(text, opts).map(e => buildLabel(e, fonts, opts)).filter(Boolean);
  return packLabels(labels, opts, buildCode(fonts, opts));
}

// Gera um PDF com as folhas empilhadas uma embaixo da outra. Cada folha leva as camadas do seu pedido.
async function buildPdf(jobs, gap, art) {
  const [{ PDFDocument, PDFName }] = await loadLibs();
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  // Cores spot (Separation): o RIP reconhece pelo nome; `alt` é só a cor de visualização.
  const spotKeys = new Map(), colorSpaces = {};
  const withLayers = jobs.flatMap(({ sheets, opts }) => {
    const layers = pdfLayers(opts).map(l => {
      if (!l.spot) return l;
      if (!spotKeys.has(l.spot)) {
        const key = `CS${spotKeys.size + 1}`;
        spotKeys.set(l.spot, key);
        const fn = ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: l.alt, N: 1 });
        colorSpaces[key] = ctx.register(ctx.obj([PDFName.of("Separation"), PDFName.of(l.spot), PDFName.of("DeviceCMYK"), fn]));
      }
      return { ...l, cs: spotKeys.get(l.spot) };
    });
    if (!layers.length) throw new Error(`pedido ${opts.orderCode || "sem código"} sem nenhuma camada`);
    return sheets.map(sheet => ({ ...sheet, layers, overprint: opts.overprint }));
  });
  // Sobreposição do preenchimento: /op (preenchimento) e /OP (traço) + OPM 1
  const gsRef = ctx.register(ctx.obj({ Type: "ExtGState", op: true, OP: true, OPM: 1 }));
  for (const page of stackSheets(withLayers, { gap })) {
    const pg = doc.addPage([page.w * MM, page.h * MM]);
    const res = pg.node.normalizedEntries().Resources;
    if (spotKeys.size) res.set(PDFName.of("ColorSpace"), ctx.obj(colorSpaces));
    res.set(PDFName.of("ExtGState"), ctx.obj({ GSOver: gsRef }));
    const content = page.items.map(({ sheet, oy }) => sheetContent(sheet, sheet.layers, pg.getHeight(), sheet.overprint && "GSOver", oy, art)).join("");
    pg.node.addContentStream(ctx.register(ctx.flateStream(content)));
  }
  doc.setTitle(`Etiquetas nome — ${jobs.map(j => j.opts.orderCode).filter(Boolean).join(", ") || "sem código"}`);
  doc.setCreator("Sticker Studio");
  return doc.save();
}

const letterFill = o => o.letter === "white" ? "#fff" : cmykToHex(letterCmyk(o));
const letterName = o => o.letter === "white" ? "Branca" : o.letter === "color" ? `Cor ${(o.cmyk || []).join("/")}` : "Preta";

export default function NameLabels() {
  const [text, setText] = useState(() => readJson(STORE_KEY, {}).text ?? EXAMPLE);
  const [opts, setOpts] = useState(() => ({ ...DEFAULT_OPTS, ...readJson(STORE_KEY, {}).opts }));
  const [queue, setQueue] = useState(() => readJson(QUEUE_KEY, []));
  const [fonts, setFonts] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const [art, setArt] = useState(() => new Map()); // emoji → formas coloridas (null = sem desenho)
  const [lastEmoji, setLastEmoji] = useState("💖");
  const textRef = useRef(null);
  useEffect(() => { loadFonts().then(setFonts, e => setErr(e.message)); }, []);
  const neededEmojis = useMemo(() => [...new Set([text, ...queue.map(j => j.text)].flatMap(emojisIn))], [text, queue]);
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
  useEffect(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify({ text, opts })); } catch { /* sem storage */ } }, [text, opts]);
  useEffect(() => { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch { /* sem storage */ } }, [queue]);

  const entries = useMemo(() => parseEntries(text, opts), [text, opts]);
  const sheets = useMemo(() => fonts ? layoutJob(text, opts, fonts) : [], [fonts, text, opts]);
  const queueJobs = useMemo(() => fonts ? queue.map(j => ({ ...j, sheets: layoutJob(j.text, j.opts, fonts) })) : [], [fonts, queue]);
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
      download(new Blob([await buildPdf(jobs, opts.gap, full)], { type: "application/pdf" }), name);
    }
    catch (e) { setErr(`Erro ao gerar PDF: ${e.message}`); }
    setBusy(false);
  };
  const exportSvg = () => sheets.forEach((s, i) => download(new Blob([sheetToSvg(s, { fill: letterFill(opts), art })], { type: "image/svg+xml" }), `etiquetas-nome-${stamp()}${sheets.length > 1 ? `-${i + 1}` : ""}.svg`));

  const addToQueue = () => {
    setQueue(q => [...q, { id: Date.now(), text, opts, count: entries.length }]);
    setText(""); up("orderCode", "");
  };
  const editJob = job => {
    setText(job.text); setOpts({ ...DEFAULT_OPTS, ...job.opts });
    setQueue(q => q.filter(j => j.id !== job.id));
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, animation: "fadeIn .3s" }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(300px, 380px) 1fr", gap: 20 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
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
            <p style={{ fontSize: 11, color: "var(--t3)" }}>Camadas do RIP: {pdfLayers(opts).map(l => l.label).join(" > ") || "nenhuma"}</p>
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
          </div>

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
        </div>

        <div style={{ ...card, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
            <h3 style={{ fontSize: 15, flex: 1 }}>
              {entries.length} etiqueta{entries.length === 1 ? "" : "s"}
              {sheets.length > 0 && <span style={{ fontSize: 12, color: "var(--t2)", fontWeight: 400 }}> · {sheets.map(s => `${(s.w / 10).toFixed(1)} × ${(s.h / 10).toFixed(1)} cm`).join(" + ")}</span>}
            </h3>
            <button className="bs" disabled={!sheets.length} onClick={exportSvg}>Baixar SVG</button>
            <button className="bs" disabled={!sheets.length || busy} onClick={() => exportPdf([{ sheets, opts }], `etiquetas-nome-${opts.orderCode || stamp()}.pdf`)}>Baixar PDF</button>
            <button className="bp" disabled={!sheets.length} onClick={addToQueue}>+ Adicionar à fila</button>
          </div>
          {err && <p style={{ color: "#f87171", fontSize: 13, marginBottom: 10 }}>{err}</p>}
          {noArt.length > 0 && <p style={{ color: "#fbbf24", fontSize: 13, marginBottom: 10 }}>Sem desenho para: {noArt.join(" ")} — esse emoji não vai sair.</p>}
          {tooWide && <p style={{ color: "#fbbf24", fontSize: 13, marginBottom: 10 }}>Algum nome é mais largo que a folha — diminua o tamanho da fonte.</p>}
          {!fonts && !err && <p style={{ color: "var(--t2)", fontSize: 13 }}>Carregando fontes…</p>}
          <div style={{ display: "flex", flexDirection: "column", gap: 16, maxHeight: "75vh", overflow: "auto" }}>
            {sheets.map((s, i) => (
              <div key={i} style={{ background: opts.letter === "white" ? "#3a3d45" : "#fff", borderRadius: 4, boxShadow: "0 1px 6px rgba(0,0,0,.3)" }}
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
          {queue.length > 0 && <button className="bs" onClick={() => { if (confirm("Limpar a fila de impressão?")) setQueue([]); }}>Limpar fila</button>}
          <button className="bp" disabled={!queueJobs.length || busy} onClick={() => exportPdf(queueJobs, `fila-etiquetas-nome-${stamp()}.pdf`)}>{busy ? "Gerando…" : "Gerar PDF único"}</button>
        </div>
        {!queue.length && <p style={{ fontSize: 13, color: "var(--t3)", marginTop: 8 }}>Monte um pedido acima e clique em "Adicionar à fila". No fim, "Gerar PDF único" junta todos, um embaixo do outro.</p>}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {queue.map((job, i) => {
            const h = queueJobs[i]?.sheets.reduce((t, s) => t + s.h, 0) || 0;
            return (
              <div key={job.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 10 }}>
                <span style={{ width: 22, fontSize: 12, color: "var(--t3)" }}>{i + 1}.</span>
                {swatch(letterFill(job.opts), 18)}
                <span style={{ fontFamily: "monospace", fontSize: 13, minWidth: 140 }}>{job.opts.orderCode || "sem código"}</span>
                <span style={{ fontSize: 12, color: "var(--t2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {job.count} etiqueta{job.count === 1 ? "" : "s"} · {NAME_FONTS[job.opts.nameFont]?.label || "Great Vibes"} · letra {letterName(job.opts)} · {(h / 10).toFixed(1)} cm · {job.text.split(/\r?\n/).filter(Boolean).slice(0, 3).join(", ")}{job.text.split(/\r?\n/).filter(Boolean).length > 3 ? "…" : ""}
                </span>
                <button className="bs" style={small} disabled={i === 0} onClick={() => moveJob(i, -1)} title="Subir">↑</button>
                <button className="bs" style={small} disabled={i === queue.length - 1} onClick={() => moveJob(i, 1)} title="Descer">↓</button>
                <button className="bs" style={small} onClick={() => editJob(job)}>Editar</button>
                <button className="bs" style={small} onClick={() => setQueue(q => q.filter(j => j.id !== job.id))}>Remover</button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
