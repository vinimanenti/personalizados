import { useEffect, useMemo, useState } from "react";
import { DEFAULT_OPTS, parseEntries, buildLabel, packLabels, sheetToSvg } from "../lib/name-labels.mjs";

const MM = 72 / 25.4; // mm → pt
const STORE_KEY = "name_labels_v1";
const FONT_FILES = { name: "greatvibes.ttf", role: "times.ttf" };
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

let _fonts = null;
const loadFonts = () => _fonts ||= loadLibs().then(async ([, fontkit]) => {
  const base = import.meta.env.BASE_URL || "/";
  const get = async f => { const r = await fetch(`${base}fonts/${f}`); if (!r.ok) throw new Error(`Fonte ${f} não encontrada`); return new Uint8Array(await r.arrayBuffer()); };
  const [name, role] = await Promise.all([get(FONT_FILES.name), get(FONT_FILES.role)]);
  return { name: fontkit.create(name), role: fontkit.create(role) };
}).catch(e => { _fonts = null; throw e; });

const readStore = () => { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; } };

export default function NameLabels() {
  const [text, setText] = useState(() => readStore().text ?? EXAMPLE);
  const [opts, setOpts] = useState(() => ({ ...DEFAULT_OPTS, ...readStore().opts }));
  const [fonts, setFonts] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { loadFonts().then(setFonts, e => setErr(e.message)); }, []);
  useEffect(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify({ text, opts })); } catch { /* sem storage */ } }, [text, opts]);

  const entries = useMemo(() => parseEntries(text, opts), [text, opts]);
  const sheets = useMemo(() => {
    if (!fonts) return [];
    const labels = entries.map(e => buildLabel(e, fonts, opts)).filter(Boolean);
    return packLabels(labels, opts);
  }, [fonts, entries, opts]);
  const tooWide = sheets.some(s => s.placed.some(p => p.box.maxX - p.box.minX > opts.sheetW - 2 * opts.margin));

  const up = (k, v) => setOpts(p => ({ ...p, [k]: v }));
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const download = (blob, name) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  const exportPdf = async () => {
    setBusy(true); setErr("");
    try {
      const [{ PDFDocument, rgb }] = await loadLibs();
      const doc = await PDFDocument.create();
      for (const s of sheets) {
        const pg = doc.addPage([s.w * MM, s.h * MM]);
        for (const p of s.placed) pg.drawSvgPath(p.box.d, { x: p.x * MM, y: pg.getHeight() - p.y * MM, scale: MM, color: rgb(0, 0, 0), borderWidth: 0 });
      }
      download(new Blob([await doc.save()], { type: "application/pdf" }), `etiquetas-nome-${stamp()}.pdf`);
    } catch (e) { setErr(`Erro ao gerar PDF: ${e.message}`); }
    setBusy(false);
  };
  const exportSvg = () => sheets.forEach((s, i) => download(new Blob([sheetToSvg(s)], { type: "image/svg+xml" }), `etiquetas-nome-${stamp()}${sheets.length > 1 ? `-${i + 1}` : ""}.svg`));

  const num = (label, key, unit, step = 1) => (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--t2)" }}>
      <span style={{ width: 120 }}>{label}</span>
      <input type="number" value={opts[key]} step={step} min={0} onChange={e => up(key, parseFloat(e.target.value) || 0)}
        style={{ width: 80, padding: "7px 9px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 13, textAlign: "center" }} />
      <span style={{ fontSize: 11, color: "var(--t3)" }}>{unit}</span>
    </label>
  );
  const card = { background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 14, padding: 18 };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(300px, 380px) 1fr", gap: 20, animation: "fadeIn .3s" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={card}>
          <h3 style={{ fontSize: 15, marginBottom: 6 }}>Nomes</h3>
          <p style={{ fontSize: 11, color: "var(--t3)", marginBottom: 10 }}>Um por linha: <b>Nome - Função</b>. Use <b>x3</b> no fim para repetir.</p>
          <textarea value={text} onChange={e => setText(e.target.value)} rows={12}
            style={{ width: "100%", padding: 10, background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 13, fontFamily: "inherit", resize: "vertical" }} />
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--t2)", marginTop: 10 }}>
            <span style={{ width: 120 }}>Função padrão</span>
            <input value={opts.defaultRole} onChange={e => up("defaultRole", e.target.value)} placeholder="ex.: Madrinha"
              style={{ flex: 1, padding: "7px 9px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 13 }} />
          </label>
        </div>
        <div style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
          <h3 style={{ fontSize: 15, marginBottom: 4 }}>Folha e texto</h3>
          {num("Largura da folha", "sheetW", "mm")}
          {num("Altura máx.", "maxSheetH", "mm (0 = rolo)")}
          {num("Margem", "margin", "mm", 0.5)}
          {num("Espaço entre", "gap", "mm", 0.5)}
          {num("Nome (Great Vibes)", "nameSize", "pt", 0.5)}
          {num("Função (Times)", "roleSize", "pt", 0.5)}
          {num("Nome → função", "roleGap", "mm", 0.5)}
          {num("Folga das pernas", "roleClear", "mm", 0.5)}
          {num("Cópias de cada", "copies", "×")}
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--t2)" }}>
            <input type="checkbox" checked={opts.roleUpper} onChange={e => up("roleUpper", e.target.checked)} /> Função em MAIÚSCULAS
          </label>
          <button className="bs" style={{ marginTop: 6, padding: "6px 10px", fontSize: 12 }} onClick={() => setOpts({ ...DEFAULT_OPTS, defaultRole: opts.defaultRole })}>Restaurar padrão</button>
        </div>
      </div>

      <div style={{ ...card, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
          <h3 style={{ fontSize: 15, flex: 1 }}>
            {entries.length} etiqueta{entries.length === 1 ? "" : "s"}
            {sheets.length > 0 && <span style={{ fontSize: 12, color: "var(--t2)", fontWeight: 400 }}> · {sheets.map(s => `${(s.w / 10).toFixed(1)} × ${(s.h / 10).toFixed(1)} cm`).join(" + ")}</span>}
          </h3>
          <button className="bs" disabled={!sheets.length} onClick={exportSvg}>Baixar SVG</button>
          <button className="bp" disabled={!sheets.length || busy} onClick={exportPdf}>{busy ? "Gerando…" : "Baixar PDF"}</button>
        </div>
        {err && <p style={{ color: "#f87171", fontSize: 13, marginBottom: 10 }}>{err}</p>}
        {tooWide && <p style={{ color: "#fbbf24", fontSize: 13, marginBottom: 10 }}>Algum nome é mais largo que a folha — diminua o tamanho da fonte.</p>}
        {!fonts && !err && <p style={{ color: "var(--t2)", fontSize: 13 }}>Carregando fontes…</p>}
        <div style={{ display: "flex", flexDirection: "column", gap: 16, maxHeight: "75vh", overflow: "auto" }}>
          {sheets.map((s, i) => (
            <div key={i} style={{ background: "#fff", borderRadius: 4, boxShadow: "0 1px 6px rgba(0,0,0,.3)" }}
              dangerouslySetInnerHTML={{ __html: sheetToSvg(s).replace(/width="[^"]+" height="[^"]+"/, 'width="100%" style="display:block"') }} />
          ))}
        </div>
      </div>
    </div>
  );
}
