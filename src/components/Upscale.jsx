import { useEffect, useRef, useState } from "react";

const ACCEPT = ".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp";
const isImage = f => /^image\/(png|jpeg|webp)$/.test(f.type) || /\.(png|jpe?g|webp)$/i.test(f.name);
const checker = "repeating-conic-gradient(#bbb 0 25%, #eee 0 50%) 0 0/14px 14px";
const outName = (name, scale) => `${name.replace(/\.[^.]+$/, "")}_${scale}x.png`;
const save = (blob, name) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
const cm = px => ((px / 300) * 2.54).toFixed(1); // tamanho impresso a 300 dpi

// onVectorize(file): manda o resultado para a aba Vetorizar.
export default function Upscale({ onVectorize }) {
  const [items, setItems] = useState([]); // { id, file, url, status, progress, result, outUrl, error, scale }
  const [model, setModel] = useState("foto");
  const [strength, setStrength] = useState(100);
  const [scale, setScale] = useState(4);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const inputRef = useRef(null);
  const abortRef = useRef(null);
  const queueRef = useRef([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => () => {
    abortRef.current?.abort();
    itemsRef.current.forEach(i => { URL.revokeObjectURL(i.url); if (i.outUrl) URL.revokeObjectURL(i.outUrl); });
  }, []);

  const patch = (id, change) => setItems(list => list.map(i => {
    if (i.id !== id) return i;
    if (i.outUrl && "outUrl" in change) URL.revokeObjectURL(i.outUrl);
    return { ...i, ...change };
  }));

  // Uma imagem por vez: a placa de vídeo é uma só.
  const pump = async () => {
    if (abortRef.current) return;
    setBusy(true);
    const { upscaleImage } = await import("../lib/upscale.js");
    while (queueRef.current.length) {
      const { item, model: m, scale: s, strength: st } = queueRef.current.shift();
      if (!itemsRef.current.some(i => i.id === item.id)) continue; // removida antes de começar
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      patch(item.id, { status: "working", progress: 0, error: "" });
      try {
        const result = await upscaleImage(item.file, { model: m, scale: s, strength: st / 100, signal: ctrl.signal, onProgress: p => patch(item.id, { progress: p }) });
        patch(item.id, { status: "done", result, scale: s, outUrl: URL.createObjectURL(result.blob) });
      } catch (e) {
        const cancelled = ctrl.signal.aborted;
        patch(item.id, { status: cancelled ? "cancelled" : "error", error: cancelled ? "" : (e.message || String(e)) });
        if (cancelled) queueRef.current = [];
      }
    }
    abortRef.current = null;
    setBusy(false);
  };

  const enqueue = list => {
    list.forEach(item => patch(item.id, { status: "waiting", progress: 0, error: "" }));
    queueRef.current.push(...list.map(item => ({ item, model, scale, strength })));
    pump();
  };

  const addFiles = files => {
    const all = [...(files || [])];
    const valid = all.filter(isImage);
    setNotice(valid.length < all.length ? `${all.length - valid.length} arquivo(s) ignorado(s): use PNG, JPG ou WEBP.` : "");
    if (!valid.length) return;
    const fresh = valid.map((file, n) => ({ id: `${Date.now()}-${n}`, file, url: URL.createObjectURL(file), status: "waiting", progress: 0 }));
    setItems(list => [...list, ...fresh]);
    queueRef.current.push(...fresh.map(item => ({ item, model, scale, strength })));
    setTimeout(pump); // depois do setItems, para a fila enxergar os itens novos
  };

  const removeItem = item => {
    if (item.status === "working") abortRef.current?.abort();
    URL.revokeObjectURL(item.url);
    if (item.outUrl) URL.revokeObjectURL(item.outUrl);
    setItems(list => list.filter(i => i.id !== item.id));
  };

  const downloadZip = async () => {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    const used = new Map();
    for (const i of items.filter(i => i.result)) {
      const base = outName(i.file.name, i.scale), n = used.get(base) || 0;
      used.set(base, n + 1);
      zip.file(n ? base.replace(/\.png$/, ` (${n + 1}).png`) : base, i.result.blob);
    }
    save(await zip.generateAsync({ type: "blob" }), "ampliadas.zip");
  };

  const card = { background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 14, padding: 18 };
  const label = { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--t2)" };
  const field = { padding: "7px 9px", background: "var(--inp)", border: "1px solid var(--brd)", borderRadius: 8, color: "var(--t1)", fontSize: 13, fontFamily: "inherit" };
  const small = { padding: "6px 12px", fontSize: 12 };
  const box = { aspectRatio: "4 / 3", width: "100%", objectFit: "contain", background: checker, borderRadius: 8, display: "block" };
  const finished = items.filter(i => i.result);
  const statusText = i => ({ waiting: "Na fila…", working: `Ampliando… ${Math.round((i.progress || 0) * 100)}%`, error: "Falhou", cancelled: "Cancelado" }[i.status] || "");

  return (
    <div style={{ animation: "fadeIn .3s", display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h2 style={{ fontSize: 22, fontWeight: 700 }}>Ampliar imagens</h2>
        <p style={{ fontSize: 13, color: "var(--t2)", marginTop: 4 }}>Aumenta a resolução com IA (Real-ESRGAN): limpa os blocos do JPG, o ruído e o desfoque leve enquanto amplia. Roda neste computador, na placa de vídeo quando possível. Use <b>Foto</b> para fotos e mockups e <b>Arte</b> para desenhos, logos e etiquetas.</p>
      </div>

      <div style={{ ...card, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 18 }}>
        <label style={label}>Modelo
          <select aria-label="Modelo" value={model} onChange={e => setModel(e.target.value)} style={field}>
            <option value="foto">Foto (Real-ESRGAN)</option>
            <option value="arte">Arte / ilustração</option>
          </select>
        </label>
        <label style={label}>Ampliar
          <select aria-label="Escala" value={scale} onChange={e => setScale(+e.target.value)} style={field}>
            {[2, 3, 4].map(n => <option key={n} value={n}>{n}×</option>)}
          </select>
        </label>
        <label style={label} title="Abaixo de 100% mistura com o aumento comum, para suavizar halos e exageros da IA">Intensidade
          <input type="range" min={0} max={100} step={5} value={strength} onChange={e => setStrength(+e.target.value)} aria-label="Intensidade da IA" />
          <span style={{ width: 36, color: "var(--t1)" }}>{strength}%</span>
        </label>
        <div style={{ flex: 1 }} />
        {busy && <button className="bs" style={small} onClick={() => abortRef.current?.abort()}>Cancelar</button>}
        {items.length > 0 && <button className="bs" disabled={busy} style={small} onClick={() => enqueue(items)}>Ampliar de novo</button>}
        {finished.length > 1 && <button className="bp" disabled={busy} style={small} onClick={downloadZip}>Baixar todas (ZIP)</button>}
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
              <span style={{ fontSize: 12, color: "var(--t2)" }}>{item.result.srcW} × {item.result.srcH} → {item.result.w} × {item.result.h} px · {cm(item.result.w)} × {cm(item.result.h)} cm a 300 dpi</span>
              <button className="bp" style={small} onClick={() => save(item.result.blob, outName(item.file.name, item.scale))}>Baixar PNG</button>
              {onVectorize && <button className="bs" style={small} onClick={() => onVectorize(new File([item.result.blob], outName(item.file.name, item.scale), { type: "image/png" }))}>Vetorizar</button>}
            </>}
            <button className="bs" style={small} onClick={() => removeItem(item)}>Remover</button>
          </div>
          {item.status === "working" && <div style={{ height: 4, background: "var(--inp)", borderRadius: 2, overflow: "hidden" }}><div style={{ height: "100%", width: `${Math.round((item.progress || 0) * 100)}%`, background: "var(--accent)", transition: "width .2s" }} /></div>}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
            <div><div style={{ fontSize: 12, color: "var(--t2)", marginBottom: 6 }}>Original</div><img src={item.url} alt={`Original de ${item.file.name}`} style={box} /></div>
            <div>
              <div style={{ fontSize: 12, color: "var(--t2)", marginBottom: 6 }}>Ampliada</div>
              {item.outUrl
                ? <a href={item.outUrl} target="_blank" rel="noreferrer" title="Abrir em tamanho real"><img src={item.outUrl} alt={`${item.file.name} ampliada`} style={{ ...box, opacity: item.status === "working" ? 0.4 : 1 }} /></a>
                : <div style={{ ...box, background: "var(--inp)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: "var(--t2)" }}>{statusText(item)}</div>}
            </div>
          </div>
          {item.result && <p style={{ fontSize: 11, color: "var(--t3)" }}>Clique na imagem ampliada para ver em tamanho real. Levou {(item.result.ms / 1000).toFixed(1)} s no {item.result.device}.</p>}
          {item.error && <p style={{ fontSize: 12, color: "#f87171" }}>Erro: {item.error}</p>}
        </div>
      ))}
    </div>
  );
}
