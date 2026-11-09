import { useEffect, useRef, useState } from "react";
import { MASK_DEFAULTS, maskLayers, buildLayeredPdf } from "../lib/art-vectorize.mjs";
import { takeFiles } from "../lib/art-handoff";

const MASK_KEY = "vetorizar_mascara";
const readMask = () => { try { return { ...MASK_DEFAULTS, ...JSON.parse(localStorage.getItem(MASK_KEY) || "{}") }; } catch { return { ...MASK_DEFAULTS }; } };

const ACCEPT = ".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp";
const isImage = f => /^image\/(png|jpeg|webp)$/.test(f.type) || /\.(png|jpe?g|webp)$/i.test(f.name);
const svgName = name => name.replace(/\.[^.]+$/, "") + ".svg";
const checker = "repeating-conic-gradient(#bbb 0 25%, #eee 0 50%) 0 0/14px 14px";
const save = (blob, name) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

export default function Vectorize() {
  const [items, setItems] = useState([]); // { id, file, url, status, result, svgUrl, error }
  const [colors, setColors] = useState(4);
  const [removeBg, setRemoveBg] = useState(true);
  const [widthMM, setWidthMM] = useState("");
  const [monoColor, setMonoColor] = useState("#000000");
  const [autoLimit, setAutoLimit] = useState(true);
  const [limit, setLimit] = useState(128);
  const [withMask, setWithMask] = useState(() => readMask().on === true);
  const [mask, setMask] = useState(readMask);
  useEffect(() => { try { localStorage.setItem(MASK_KEY, JSON.stringify({ ...mask, on: withMask })); } catch { /* sem armazenamento: só não lembra */ } }, [mask, withMask]);
  const upMask = (k, v) => setMask(m => ({ ...m, [k]: v }));
  const spots = withMask ? maskLayers(mask) : [];
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const inputRef = useRef(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => () => itemsRef.current.forEach(i => { URL.revokeObjectURL(i.url); if (i.svgUrl) URL.revokeObjectURL(i.svgUrl); }), []);

  const patch = (id, change) => setItems(list => list.map(i => {
    if (i.id !== id) return i;
    if (i.svgUrl && "svgUrl" in change) URL.revokeObjectURL(i.svgUrl);
    return { ...i, ...change };
  }));

  const run = async targets => {
    setBusy(true);
    const { traceImage } = await import("../lib/art-trace.js");
    for (const item of targets) {
      patch(item.id, { status: "working", error: "" });
      try {
        const result = await traceImage(item.file, { colors, removeBg, widthMM: parseFloat(widthMM) || 0, monoColor, threshold: colors === 1 && !autoLimit ? limit : null });
        patch(item.id, { status: "done", result, svgUrl: URL.createObjectURL(new Blob([result.svg], { type: "image/svg+xml" })) });
      } catch (e) {
        patch(item.id, { status: "error", error: e.message || String(e) });
      }
    }
    setBusy(false);
  };

  const addFiles = files => {
    const all = [...(files || [])];
    const valid = all.filter(isImage);
    setNotice(valid.length < all.length ? `${all.length - valid.length} arquivo(s) ignorado(s): use PNG, JPG ou WEBP.` : "");
    if (!valid.length) return;
    const fresh = valid.map((file, n) => ({ id: `${Date.now()}-${n}`, file, url: URL.createObjectURL(file), status: "waiting" }));
    setItems(list => [...list, ...fresh]);
    run(fresh);
  };
  // Arquivos mandados por outra aba (ex.: "Vetorizar" na aba Ampliar).
  useEffect(() => { const sent = takeFiles(); if (sent.length) addFiles(sent); }, []); // eslint-disable-line react-hooks/exhaustive-deps


  const removeItem = item => {
    URL.revokeObjectURL(item.url);
    if (item.svgUrl) URL.revokeObjectURL(item.svgUrl);
    setItems(list => list.filter(i => i.id !== item.id));
  };

  const maskOnly = withMask && mask.only === true;
  // Só máscara: a imagem original vai por baixo e o vetor serve só para a silhueta do Branco/Verniz.
  const pdfBytes = async item => {
    const { pdfImage } = await import("../lib/art-trace.js");
    const image = maskOnly ? await pdfImage(item.file) : null;
    return buildLayeredPdf(item.result.layers, item.result.px, item.result.wMM, item.result.hMM, { mask: spots.length ? mask : null, withColor: !maskOnly, image });
  };
  const pdfName = item => svgName(item.file.name).replace(/\.svg$/, maskOnly ? " - imagem e mascara.pdf" : spots.length ? " - mascara.pdf" : ".pdf");

  const downloadPdf = async item => {
    try {
      save(new Blob([await pdfBytes(item)], { type: "application/pdf" }), pdfName(item));
    } catch (e) {
      patch(item.id, { error: `Não foi possível gerar o PDF: ${e.message || e}` });
    }
  };

  const downloadZip = async () => {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    const used = new Map();
    for (const i of items.filter(i => i.result)) {
      const base = svgName(i.file.name), n = used.get(base) || 0;
      used.set(base, n + 1);
      const name = n ? base.replace(/\.svg$/, ` (${n + 1}).svg`) : base;
      zip.file(name, i.result.svg);
      if (spots.length || maskOnly) zip.file(name.replace(/\.svg$/, maskOnly ? " - imagem e mascara.pdf" : " - mascara.pdf"), await pdfBytes(i));
    }
    save(await zip.generateAsync({ type: "blob" }), "vetores.zip");
  };

  const card = { background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 14, padding: 18 };
  const label = { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--t2)" };
  const field = { padding: "7px 9px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 13, fontFamily: "inherit" };
  const small = { padding: "6px 12px", fontSize: 12 };
  const box = { aspectRatio: "4 / 3", width: "100%", objectFit: "contain", background: checker, borderRadius: 8, display: "block" };
  const finished = items.filter(i => i.result);

  return (
    <div style={{ animation: "fadeIn .3s", display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h2 style={{ fontSize: 22, fontWeight: 700 }}>Vetorizar arquivos</h2>
        <p style={{ fontSize: 13, color: "var(--t2)", marginTop: 4 }}>Transforma PNG, JPG e WEBP em SVG. Com 1 cor, só as partes escuras viram vetor, numa cor só (bom para contorno e corte). Os arquivos são processados neste computador e não são enviados para nenhum servidor.</p>
      </div>

      <div style={{ ...card, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 18 }}>
        <label style={label}>Cores
          <select aria-label="Número de cores" value={colors} onChange={e => setColors(+e.target.value)} style={field}>
            {[1, 2, 3, 4, 6, 8, 12, 16].map(n => <option key={n} value={n}>{n === 1 ? "1 (traço único)" : n}</option>)}
          </select>
        </label>
        {colors === 1 && <>
          <label style={label}>Cor
            <input type="color" aria-label="Cor do traço" value={monoColor} onChange={e => setMonoColor(e.target.value)} style={{ width: 34, height: 30, padding: 0, border: "1px solid var(--brd)", borderRadius: 6, background: "none", cursor: "pointer" }} />
          </label>
          <label style={label}><input type="checkbox" checked={autoLimit} onChange={e => setAutoLimit(e.target.checked)} /> Limite automático</label>
          {!autoLimit && <label style={label}>Limite
            <input type="range" min={1} max={254} value={limit} onChange={e => setLimit(+e.target.value)} aria-label="Limite entre claro e escuro" />
            <span style={{ width: 28, color: "var(--t1)" }}>{limit}</span>
          </label>}
        </>}
        <label style={label}><input type="checkbox" checked={removeBg} onChange={e => setRemoveBg(e.target.checked)} /> Remover fundo</label>
        <label style={label}>Largura final (mm)
          <input type="number" min={1} step={0.5} value={widthMM} onChange={e => setWidthMM(e.target.value)} placeholder="auto" style={{ ...field, width: 90 }} />
        </label>
        <div style={{ flex: 1 }} />
        {items.length > 0 && <button className="bs" disabled={busy} style={small} onClick={() => run(items)}>Vetorizar de novo</button>}
        <div style={{ flexBasis: "100%", display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--brd)", paddingTop: 14 }}>
          <label style={label}><input type="checkbox" checked={withMask} onChange={e => setWithMask(e.target.checked)} /> <b style={{ color: "var(--t1)" }}>Gerar máscara</b> (Branco e Verniz no PDF, como nas etiquetas Lápis)</label>
          {withMask && <>
            <div role="radiogroup" aria-label="O que vai no PDF" style={{ display: "flex", flexWrap: "wrap", gap: 16, fontSize: 12 }}>
              <label style={{ ...label, fontSize: 12 }}><input type="radio" name="mask-mode" checked={!maskOnly} onChange={() => upMask("only", false)} /> Cores vetorizadas + máscara</label>
              <label style={{ ...label, fontSize: 12 }}><input type="radio" name="mask-mode" checked={maskOnly} onChange={() => upMask("only", true)} /> <b style={{ color: "var(--t1)" }}>Imagem original (JPG/PNG) + máscara</b> — não vetoriza as cores</label>
            </div>
            {[["white", "whiteSpot", "Branco"], ["varnish", "varnishSpot", "Verniz"]].map(([on, name, text]) => (
              <label key={on} style={{ ...label, fontSize: 12 }}>
                <input type="checkbox" checked={mask[on]} onChange={e => upMask(on, e.target.checked)} />
                <span style={{ width: 52 }}>{text}</span>
                <input aria-label={`Nome da cor ${text}`} value={mask[name]} onChange={e => upMask(name, e.target.value)} style={{ ...field, width: 200, fontSize: 12, fontFamily: "monospace" }} />
              </label>
            ))}
            <label style={{ ...label, fontSize: 12 }}><input type="checkbox" checked={mask.overprint} onChange={e => upMask("overprint", e.target.checked)} /> Impressão sobreposta do preenchimento (só Branco e Verniz)</label>
            <p style={{ fontSize: 11, color: "var(--t3)" }}>Camadas do RIP: {[maskOnly ? "Imagem original" : "Cores da arte", ...spots.map(s => s.spot)].join(" > ")}. {maskOnly ? "A imagem entra no PDF sem alteração; a vetorização só desenha a silhueta do Branco e do Verniz." : "A máscara é a silhueta do vetor e vai no PDF (o SVG continua só com as cores)."}</p>
            {!removeBg && colors > 1 && <p style={{ fontSize: 12, color: "#fbbf24" }}>Sem "Remover fundo", a silhueta é o retângulo inteiro da imagem.</p>}
          </>}
        </div>
        {finished.length > 1 && <button className="bp" disabled={busy} style={small} onClick={downloadZip}>Baixar todos (ZIP)</button>}
      </div>

      <div role="button" tabIndex={0} onClick={() => inputRef.current?.click()} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inputRef.current?.click(); } }}
        onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
        style={{ border: "2px dashed var(--brd)", borderRadius: 14, padding: 28, textAlign: "center", cursor: "pointer", fontSize: 14, color: "var(--t2)" }}>
        Clique ou arraste aqui um ou mais arquivos <b>PNG, JPG ou WEBP</b>
      </div>
      <input ref={inputRef} type="file" multiple accept={ACCEPT} style={{ display: "none" }} onChange={e => { addFiles(e.target.files); e.target.value = ""; }} />
      {notice && <p style={{ fontSize: 12, color: "#fbbf24" }}>{notice}</p>}

      {items.map(item => (
        <div key={item.id} style={{ ...card, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <strong style={{ fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>{item.file.name}</strong>
            {item.result && <>
              <span style={{ fontSize: 12, color: "var(--t2)" }}>{item.result.wMM.toFixed(1)} × {item.result.hMM.toFixed(1)} mm · {item.result.colors.length === 1 ? `1 cor${item.result.threshold != null ? ` · limite ${Math.round(item.result.threshold)}` : ""}` : `${item.result.colors.length} cores`}</span>
              <button className="bp" style={small} onClick={() => save(new Blob([item.result.svg], { type: "image/svg+xml" }), svgName(item.file.name))}>Baixar SVG</button>
              <button className="bs" style={small} onClick={() => downloadPdf(item)}>{maskOnly ? "Baixar PDF (imagem + máscara)" : spots.length ? "Baixar PDF com máscara" : "Baixar PDF"}</button>
            </>}
            <button className="bs" style={small} disabled={item.status === "working"} onClick={() => removeItem(item)}>Remover</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
            <div><div style={{ fontSize: 12, color: "var(--t2)", marginBottom: 6 }}>Original</div><img src={item.url} alt={`Original de ${item.file.name}`} style={box} /></div>
            <div>
              <div style={{ fontSize: 12, color: "var(--t2)", marginBottom: 6 }}>Vetor</div>
              {item.svgUrl
                ? <img src={item.svgUrl} alt={`Vetor de ${item.file.name}`} style={{ ...box, opacity: item.status === "working" ? 0.4 : 1 }} />
                : <div style={{ ...box, background: "var(--inp)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: "var(--t2)" }}>{item.status === "error" ? "Falhou" : "Vetorizando…"}</div>}
            </div>
          </div>
          {item.error && <p style={{ fontSize: 12, color: "#f87171" }}>Erro: {item.error}</p>}
          {item.result && <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {item.result.colors.map(c => <span key={c} title={c} style={{ width: 18, height: 18, borderRadius: 4, background: c, border: "1px solid var(--brd)" }} />)}
          </div>}
        </div>
      ))}
    </div>
  );
}
