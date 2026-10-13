import { useEffect, useMemo, useRef, useState } from 'react';
import { parseOrderCodes, parseDuokeText, parseNamesCsv, exportNamesCsv, toLabelFields } from '../../shared/lapis.mjs';
import { extractOrders, resolveLapisEndpoint } from '../lib/lapis-api.mjs';
import { mergeLabelCodes } from '../../shared/shopee-label.mjs';
import './LapisImport.css';

const dict = value => Object.assign(Object.create(null), value);
const EMPTY = { codes: '', raw: '', collected: [], results: dict(), selected: dict(), reviewed: dict(), shipDates: dict() };
const SHIP_DATE = /^\d{2}\/\d{2}\/\d{4}$/;
const NO_REVISIONS = [];
const MAX_DRAFT = 1500000;
const EXPIRY = 8 * 60 * 60 * 1000;
const endpoint = resolveLapisEndpoint(import.meta.env);
const requestId = () => globalThis.crypto?.randomUUID?.() || `lapis-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const revision = order => JSON.stringify([order.id, order.names.map(({ name, quantity }) => [name, quantity])]);
const post = (type, id, extra = {}) => window.postMessage({ source: 'sticker-studio', version: 1, requestId: id, type, ...extra }, window.location.origin);

function draftKey() {
  try {
    const session = JSON.parse(localStorage.getItem('ss_session') || 'null');
    const user = session?.user;
    return typeof user === 'string' && user ? `ss_lapis_v1:${user}:${session.ts || 'session'}` : null;
  } catch { return null; }
}

function readDraft(key) {
  if (!key) return EMPTY;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw || raw.length > MAX_DRAFT) return EMPTY;
    const saved = JSON.parse(raw);
    if (saved.version !== 1 || !Number.isFinite(saved.ts) || saved.ts > Date.now() || Date.now() - saved.ts > EXPIRY) { sessionStorage.removeItem(key); return EMPTY; }
    const d = saved.draft;
    if (!d || !Array.isArray(d.collected) || d.collected.length > 500 || typeof d.codes !== 'string' || typeof d.raw !== 'string' || !d.results || !d.selected || !d.reviewed) return EMPTY;
    for (const order of d.collected) {
      if (!order || typeof order.id !== 'string' || typeof order.text !== 'string' || !['collected', 'not_found', 'error'].includes(order.status)) return EMPTY;
      const result = Object.hasOwn(d.results, order.id) ? d.results[order.id] : null;
      if (result && (result.id !== order.id || !['found', 'not_found', 'review'].includes(result.status) || typeof result.reason !== 'string' || typeof result.text !== 'string' || !Array.isArray(result.names) || result.names.some(n => !n || typeof n.name !== 'string' || typeof n.evidence !== 'string' || (n.quantity !== null && !Number.isFinite(n.quantity))))) return EMPTY;
    }
    const knownIds = new Set(d.collected.map(order => order.id));
    if (Object.keys(d.results).some(id => !knownIds.has(id))) return EMPTY;
    // Drafts saved before label import have no shipDates; drop malformed entries instead of the whole draft.
    const shipDates = dict(Object.fromEntries(Object.entries(d.shipDates && typeof d.shipDates === 'object' ? d.shipDates : {}).filter(([, date]) => typeof date === 'string' && SHIP_DATE.test(date))));
    return { codes: d.codes, raw: d.raw, collected: d.collected, results: dict(d.results), selected: dict(d.selected), reviewed: dict(), shipDates };
  } catch { return EMPTY; }
}

function mergeCollected(draft, orders) {
  const map = new Map(draft.collected.map(order => [order.id, order]));
  const results = dict(draft.results), selected = dict(draft.selected), reviewed = dict(draft.reviewed);
  for (const order of orders) {
    map.set(order.id, order);
    delete results[order.id];
    delete reviewed[order.id];
    selected[order.id] = order.status === 'collected' && order.text.length <= 12000;
  }
  return { ...draft, collected: [...map.values()], results, selected, reviewed };
}

function checkImportSize(draft, orders) {
  if (new Set([...draft.collected.map(order => order.id), ...orders.map(order => order.id)]).size > 500) throw new Error('O limite é de 500 pedidos por revisão. Exporte ou limpe os pedidos atuais antes de importar mais.');
}

function queueError(order) {
  if (!order || !order.names.length) return 'Adicione pelo menos um nome para montar a cartela.';
  try { toLabelFields({ ...order, status: 'found' }); return ''; }
  catch (error) { return error.message; }
}

function OrderReview({ source, result, selected, reviewed, accepted, busy, onSelect, onEdit, onAddName, onRemoveName, onReview }) {
  const validation = queueError(result);
  const canExtract = source.status === 'collected' && source.text.trim() && source.text.length <= 12000;
  const status = accepted ? 'Na fila' : result?.status === 'not_found' ? 'Não Encontrado' : result ? 'Revisar nomes' : source.status === 'not_found' ? 'Pedido não encontrado' : source.status === 'error' ? 'Falha na coleta' : 'Conversa pronta';
  let quantities = [];
  if (!validation) quantities = toLabelFields({ ...result, status: 'found' }).map(field => field.qty);
  return <article className={`lapis-order${accepted ? ' lapis-order-accepted' : ''}`}>
    <header className="lapis-order-head">
      <div><span className="lapis-kicker">PEDIDO</span><h4>{source.id}</h4></div>
      <span className={`lapis-tag ${source.status === 'error' ? 'lapis-tag-error' : ''}`}>{status}</span>
      {canExtract ? <label className="lapis-check"><input type="checkbox" checked={Boolean(selected)} disabled={busy} onChange={onSelect} />Extrair</label> : null}
    </header>
    {source.error ? <p className="lapis-error">{source.error}</p> : null}
    {source.text.length > 12000 ? <p className="lapis-error">Esta conversa tem {source.text.length.toLocaleString('pt-BR')} caracteres. Importe uma versão de até 12.000 caracteres para extrair.</p> : null}
    {result?.reason ? <p className="lapis-reason">{result.reason}</p> : null}
    {result?.names.map((entry, index) => <div className="lapis-name" key={index}>
      <label>Nome na etiqueta<input value={entry.name} maxLength={200} disabled={busy} onChange={event => onEdit(index, 'name', event.target.value)} /></label>
      <label className="lapis-quantity">Quantidade<input type="number" min="1" max="150" step="1" value={entry.quantity ?? ''} placeholder={quantities[index] ? `Auto · ${quantities[index]}` : 'Auto'} disabled={busy} onChange={event => onEdit(index, 'quantity', event.target.value === '' ? null : Number(event.target.value))} /></label>
      <button className="lapis-icon-button" disabled={busy} type="button" onClick={() => onRemoveName(index)} aria-label={`Remover nome ${index + 1}`} title="Remover nome">×</button>
      {entry.evidence ? <p className="lapis-evidence">“{entry.evidence}”</p> : null}
    </div>)}
    <div className="lapis-order-footer">
      <button type="button" className="lapis-link-button" disabled={busy} onClick={onAddName}>+ Adicionar nome</button>
      {result?.names.length ? <label className="lapis-check lapis-review-check"><input type="checkbox" disabled={busy || Boolean(validation) || accepted} checked={Boolean(reviewed)} onChange={onReview} />{accepted ? 'Revisão adicionada à fila' : 'Conferi os nomes e as quantidades'}</label> : null}
    </div>
    {result?.names.length && validation ? <p className="lapis-error">{validation}</p> : null}
    {!validation && !accepted ? <p className="lapis-allocation">Uma cartela · {quantities.reduce((sum, qty) => sum + qty, 0)} etiquetas{result.names.some(entry => entry.quantity === null) ? ' · quantidades em branco distribuídas automaticamente' : ''}</p> : null}
    <details className="lapis-source"><summary>Ver conversa de origem{source.text ? ` · ${source.text.length.toLocaleString('pt-BR')} caracteres` : ''}</summary><pre>{source.text || 'Nenhuma conversa foi coletada para este pedido.'}</pre></details>
  </article>;
}

export default function LapisImport({ onAddOrders, queuedRevisions = NO_REVISIONS }) {
  const [storageKey] = useState(draftKey);
  const [draft, setDraft] = useState(() => readDraft(storageKey));
  const [accessCode, setAccessCode] = useState('');
  const [connection, setConnection] = useState({ connected: false, duokeConnected: false, busy: false, checking: true });
  const [phase, setPhase] = useState('idle');
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(Boolean(storageKey));
  const [queueBusy, setQueueBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const job = useRef(null), extraction = useRef(null), mounted = useRef(false), pendingStatus = useRef(new Map()), statusDeadline = useRef(null), watchdog = useRef(null), cancelTimer = useRef(null), enqueuing = useRef(false);
  const busy = phase !== 'idle' || queueBusy || uploading;

  useEffect(() => {
    if (!storageKey) return;
    try {
      const value = JSON.stringify({ version: 1, ts: Date.now(), draft: { ...draft, reviewed: {} } });
      if (value.length > MAX_DRAFT) { sessionStorage.removeItem(storageKey); setSaved(false); return; }
      sessionStorage.setItem(storageKey, value); setSaved(true);
    } catch { setSaved(false); }
  }, [draft, storageKey]);

  const probe = () => {
    const id = requestId();
    pendingStatus.current.clear(); pendingStatus.current.set(id, Date.now());
    setConnection(current => ({ ...current, checking: true }));
    post('STATUS', id);
    clearTimeout(statusDeadline.current);
    statusDeadline.current = setTimeout(() => {
      pendingStatus.current.delete(id);
      if (mounted.current) setConnection({ connected: false, duokeConnected: false, busy: false, checking: false });
    }, 8000);
  };

  useEffect(() => {
    mounted.current = true;
    const finish = message => {
      clearTimeout(watchdog.current); clearTimeout(cancelTimer.current);
      job.current = null; setPhase('idle');
      if (message) setNotice(message);
    };
    const armWatchdog = () => {
      clearTimeout(watchdog.current);
      watchdog.current = setTimeout(() => {
        if (!job.current) return;
        post('CANCEL', requestId(), { jobId: job.current.id });
        finish('A coleta parou de responder. Os pedidos já coletados foram mantidos. Conecte as abas novamente antes de tentar.');
        setConnection({ connected: false, duokeConnected: false, busy: false, checking: false });
      }, 120000);
    };
    const listener = event => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.source !== 'sticker-duoke' || data.version !== 1 || typeof data.requestId !== 'string') return;
      if (pendingStatus.current.has(data.requestId) && data.type === 'ERROR') {
        pendingStatus.current.delete(data.requestId); clearTimeout(statusDeadline.current);
        setConnection({ connected: false, duokeConnected: false, busy: false, checking: false });
        return;
      }
      if (data.type === 'STATUS' && pendingStatus.current.has(data.requestId)) {
        pendingStatus.current.delete(data.requestId); clearTimeout(statusDeadline.current);
        setConnection({ connected: data.connected === true, duokeConnected: data.duokeConnected === true, busy: data.busy === true, checking: false });
        return;
      }
      const active = job.current;
      if (!active || data.requestId !== active.id) return;
      if (data.type === 'PROGRESS') {
        const order = data.order;
        if (!order || !active.codes.has(order.id) || !['collected', 'not_found', 'error'].includes(order.status) || typeof order.text !== 'string' || active.seen.has(order.id)) return;
        if (order.text.length > 500000 || (order.error !== undefined && typeof order.error !== 'string')) { setError(`A conversa do pedido ${order.id} excedeu o limite de importação.`); return; }
        active.seen.add(order.id);
        setDraft(current => mergeCollected(current, [order]));
        setProgress({ completed: active.seen.size, total: active.codes.size });
        armWatchdog();
      } else if (data.type === 'COMPLETE') {
        finish(data.cancelled ? 'Coleta cancelada. Os pedidos concluídos foram mantidos.' : `Coleta concluída: ${active.seen.size} de ${active.codes.size} pedidos. Selecione as conversas para extrair os nomes.`);
        if (!data.cancelled && active.seen.size !== active.codes.size) setError('Alguns pedidos não retornaram resultado. Confira os pedidos restantes antes de repetir a coleta.');
        probe();
      } else if (data.type === 'ERROR') {
        setError(typeof data.error === 'string' ? data.error : 'Não foi possível coletar. Confira se as duas abas estão conectadas.'); finish(); probe();
      }
    };
    window.addEventListener('message', listener);
    probe();
    const interval = setInterval(probe, 15000);
    return () => {
      mounted.current = false;
      window.removeEventListener('message', listener); clearInterval(interval);
      clearTimeout(statusDeadline.current); clearTimeout(watchdog.current); clearTimeout(cancelTimer.current);
      if (job.current) post('CANCEL', requestId(), { jobId: job.current.id });
      job.current = null; extraction.current?.abort(); extraction.current = null;
    };
  }, []);

  const startCollection = () => {
    try {
      const codes = parseOrderCodes(draft.codes);
      if (!codes.length) throw new Error('Cole pelo menos um código de pedido.');
      if (codes.length > 200) throw new Error('Cole até 200 pedidos por coleta. Você pode coletar os próximos depois.');
      if (new Set([...draft.collected.map(order => order.id), ...codes]).size > 500) throw new Error('O limite é de 500 pedidos por revisão. Limpe os pedidos atuais antes de coletar mais.');
      const id = requestId();
      job.current = { id, codes: new Set(codes), seen: new Set() };
      setError(''); setNotice('Buscando as conversas no Duoke…'); setPhase('collecting'); setProgress({ completed: 0, total: codes.length });
      post('START', id, { codes });
      clearTimeout(watchdog.current);
      watchdog.current = setTimeout(() => {
        if (job.current?.id !== id) return;
        post('CANCEL', requestId(), { jobId: id }); job.current = null; setPhase('idle');
        setError('A coleta não respondeu. Abra a extensão e conecte as abas do Sticker Studio e do Duoke.'); probe();
      }, 120000);
    } catch (failure) { setError(failure.message); }
  };

  const cancel = () => {
    if (extraction.current) { extraction.current.abort(); setPhase('cancelling'); return; }
    if (job.current) {
      const id = job.current.id;
      post('CANCEL', requestId(), { jobId: id }); setPhase('cancelling'); setNotice('Cancelando a coleta…');
      cancelTimer.current = setTimeout(() => {
        if (job.current?.id !== id) return;
        job.current = null; clearTimeout(watchdog.current); setPhase('idle');
        setNotice('Coleta cancelada. Os resultados concluídos foram mantidos.'); probe();
      }, 8000);
    }
  };

  const importText = text => {
    const orders = parseDuokeText(text);
    if (!orders.length) throw new Error('Nenhum pedido foi identificado. Importe o TXT do coletor com os códigos e as conversas.');
    if (orders.some(order => order.text.length > 12000)) throw new Error('Uma conversa ultrapassou 12.000 caracteres. Revise o arquivo antes de importar; nenhum texto foi cortado.');
    checkImportSize(draft, orders);
    setDraft(current => mergeCollected(current, orders));
    setNotice(`${orders.length} pedidos importados. Selecione as conversas e extraia os nomes.`); setError('');
  };

  const upload = async event => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    setUploading(true); setError('');
    try {
      if (file.size > 2000000) throw new Error('O arquivo deve ter até 2 MB. Divida os pedidos em arquivos menores.');
      const text = await file.text();
      if (!mounted.current) return;
      if (/\.csv$/i.test(file.name)) {
        const orders = parseNamesCsv(text);
        if (!orders.length) throw new Error('O CSV não contém pedidos. Use as colunas ID e Nome.');
        checkImportSize(draft, orders);
        setDraft(current => {
          const next = mergeCollected(current, orders.map(order => ({ id: order.id, text: order.text || '', status: 'collected' })));
          next.results = dict({ ...next.results, ...Object.fromEntries(orders.map(order => [order.id, order])) });
          for (const order of orders) next.selected[order.id] = false;
          return next;
        });
        setError(''); setNotice(`${orders.length} pedidos carregados do CSV. Confira cada pedido antes de adicionar à fila.`);
      } else importText(text);
    } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { if (mounted.current) setUploading(false); }
  };

  const uploadLabels = async event => {
    const files = [...(event.target.files || [])]; event.target.value = '';
    if (!files.length) return;
    setUploading(true); setError('');
    try {
      // Loaded on demand so pdf.js stays out of the Lápis bundle until labels are used.
      const { readShopeeLabels } = await import('../lib/shopee-label-pdf.mjs');
      const labels = [];
      let pages = 0, missing = 0;
      for (const file of files) {
        const read = await readShopeeLabels(file);
        labels.push(...read.labels); pages += read.pages; missing += read.missing;
      }
      if (!mounted.current) return;
      if (!labels.length) throw new Error(`Nenhum código de pedido encontrado em ${pages} página${pages === 1 ? '' : 's'}. Confira se o PDF é a etiqueta de envio da Shopee.`);
      // The codes textarea is disabled while uploading, so draft.codes is current here.
      const { codes, added, duplicates } = mergeLabelCodes(draft.codes, labels);
      setDraft(current => {
        const shipDates = dict(current.shipDates);
        for (const label of labels) if (label.envio) shipDates[label.pedido] = label.envio;
        return { ...current, codes, shipDates };
      });
      setNotice(`${labels.length} etiqueta${labels.length === 1 ? ' lida' : 's lidas'} · ${added.length} código${added.length === 1 ? ' adicionado' : 's adicionados'}` +
        (duplicates ? ` · ${duplicates} já estava${duplicates === 1 ? '' : 'm'} na lista` : '') +
        (missing ? ` · ${missing} página${missing === 1 ? '' : 's'} sem código` : '') + '.');
    } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { if (mounted.current) setUploading(false); }
  };

  const selectedOrders = useMemo(() => draft.collected.filter(order => draft.selected[order.id] && order.status === 'collected' && order.text.trim() && order.text.length <= 12000), [draft.collected, draft.selected]);
  const acceptedSet = useMemo(() => new Set(queuedRevisions), [queuedRevisions]);
  const readyOrders = useMemo(() => Object.values(draft.results).filter(order => draft.reviewed[order.id] === revision(order) && !acceptedSet.has(revision(order)) && !queueError(order)), [draft.results, draft.reviewed, acceptedSet]);

  const runExtraction = async () => {
    if (extraction.current || job.current) return;
    const controller = new AbortController(); extraction.current = controller;
    setError(''); setNotice('Extraindo os nomes das conversas selecionadas…'); setPhase('extracting'); setProgress({ completed: 0, total: selectedOrders.length });
    try {
      await extractOrders({ orders: selectedOrders, accessCode, endpoint, signal: controller.signal, onChunk: (orders, completed, total) => {
        if (!mounted.current || extraction.current !== controller || controller.signal.aborted) return;
        setDraft(current => {
          const results = dict(current.results), reviewed = dict(current.reviewed), selected = dict(current.selected);
          for (const order of orders) { results[order.id] = order; delete reviewed[order.id]; selected[order.id] = false; }
          return { ...current, results, reviewed, selected };
        });
        setProgress({ completed, total });
      } });
      if (mounted.current) setNotice('Nomes extraídos. Confira os nomes, as quantidades e a conversa de cada pedido.');
    } catch (failure) {
      if (mounted.current) {
        if (failure.name === 'AbortError') setNotice('Extração cancelada. Os lotes concluídos foram mantidos.');
        else setError(failure.message);
      }
    } finally {
      if (extraction.current === controller) { extraction.current = null; if (mounted.current) setPhase('idle'); }
    }
  };

  const editOrder = (source, transform) => setDraft(current => {
    const original = current.results[source.id] || { id: source.id, names: [], status: 'review', reason: '', text: source.text };
    const next = { ...original, names: transform(original.names), status: 'review' };
    const reviewed = dict(current.reviewed); delete reviewed[source.id];
    return { ...current, results: dict({ ...current.results, [source.id]: next }), reviewed };
  });

  const addToQueue = async () => {
    if (enqueuing.current || !readyOrders.length) return;
    enqueuing.current = true; setQueueBusy(true); setError('');
    try {
      const orders = readyOrders.map(order => ({ ...order, status: 'found', names: order.names.map(entry => ({ ...entry })), shipDate: draft.shipDates[order.id] || '' }));
      orders.forEach(toLabelFields);
      await onAddOrders(orders);
      setNotice(`${orders.length} cartela${orders.length === 1 ? '' : 's'} adicionada${orders.length === 1 ? '' : 's'} à fila de impressão.`);
    } catch (failure) { setError(failure.message || 'Não foi possível adicionar os pedidos à fila.'); }
    finally { enqueuing.current = false; if (mounted.current) setQueueBusy(false); }
  };

  const exportCsv = () => {
    try {
      const orders = draft.collected.map(source => draft.results[source.id] || (source.status === 'not_found' ? { id: source.id, names: [], status: 'not_found', reason: '', text: source.text } : null)).filter(Boolean);
      if (!orders.length) throw new Error('Extraia os nomes ou importe um CSV antes de exportar.');
      const csv = exportNamesCsv(orders);
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = 'nomes-lapis.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`CSV exportado com ${orders.length} pedidos. Falhas de coleta e conversas ainda não extraídas ficam pendentes na revisão.`);
    } catch (failure) { setError(failure.message); }
  };

  const connected = connection.connected && connection.duokeConnected;
  const connectionText = connection.checking && !connection.connected ? 'Verificando conexão…' : connected ? 'Duoke conectado' : connection.connected ? 'Conecte a aba do Duoke' : 'Conecte a extensão';

  return <section className="lapis-import" aria-label="Importar pedidos do Duoke">
    <header className="lapis-heading">
      <div className="lapis-monogram" aria-hidden="true">L</div>
      <div><p className="lapis-kicker">DO PEDIDO À CARTELA</p><h2>Nomes para Lápis</h2><p>Busque as conversas, extraia os nomes e confira antes de imprimir.</p></div>
      <div className={`lapis-connection${connected ? ' is-connected' : ''}`}><span className="lapis-dot" />{connectionText}<button type="button" onClick={probe} disabled={connection.checking} title="Verificar conexão">↻</button></div>
    </header>
    <div className="lapis-input-grid">
      <div className="lapis-input-panel">
        <div className="lapis-section-title"><span>01</span><h3>Buscar no Duoke</h3></div>
        <label className="lapis-field">Códigos dos pedidos<textarea value={draft.codes} disabled={busy} maxLength={100000} rows={4} placeholder={'Cole os códigos, um por linha\n323265626\n323265627'} onChange={event => setDraft(current => ({ ...current, codes: event.target.value }))} /></label>
        <div className="lapis-actions"><button type="button" className="lapis-primary" disabled={busy || !connected || connection.busy || !draft.codes.trim()} onClick={startCollection}>Coletar conversas <span aria-hidden="true">→</span></button><label className={`lapis-label-upload${busy ? ' is-disabled' : ''}`} title="Lê o código do pedido e o envio previsto de cada etiqueta">📄 Etiquetas Shopee (PDF)<input type="file" accept=".pdf,application/pdf" multiple disabled={busy} onChange={uploadLabels} /></label><a href="https://web.duoke.com/?lang=pt#/dk/main/chat" target="_blank" rel="noreferrer" className="lapis-link-button">Abrir Duoke ↗</a></div>
        <details className="lapis-help"><summary>Conectar as abas pela primeira vez</summary><ol><li><a href={`${import.meta.env.BASE_URL}downloads/duoke-bridge.zip`} download>Baixe a extensão Duoke</a> e extraia o ZIP.</li><li>Em chrome://extensions ou edge://extensions, ative o modo de desenvolvedor e escolha “Carregar sem compactação”. Selecione a pasta extraída.</li><li>Abra a extensão na aba do Sticker Studio e clique em conectar. Faça o mesmo na aba do Duoke com sua conta aberta.</li><li>Volte aqui e clique em ↻ para verificar a conexão.</li></ol><p>A extensão apenas lê as conversas dos pedidos informados.</p></details>
      </div>
      <div className="lapis-input-panel">
        <div className="lapis-section-title"><span>OU</span><h3>Importar um arquivo</h3></div>
        <label className={`lapis-upload${busy ? ' is-disabled' : ''}`}><span aria-hidden="true">↥</span><strong>Carregar TXT ou CSV</strong><small>Conversa do coletor antigo ou nomes já extraídos · até 2 MB</small><input type="file" accept=".txt,.csv,text/plain,text/csv" disabled={busy} onChange={upload} /></label>
        <details className="lapis-help"><summary>Colar o texto do coletor</summary><label className="lapis-field">Pedidos e conversas<textarea rows={5} disabled={busy} value={draft.raw} maxLength={2000000} placeholder="Cole o relatório completo do coletor…" onChange={event => setDraft(current => ({ ...current, raw: event.target.value }))} /></label><button type="button" disabled={busy || !draft.raw.trim()} onClick={() => { try { importText(draft.raw); } catch (failure) { setError(failure.message); } }}>Importar texto</button></details>
        <details className="lapis-help"><summary>Código de acesso à extração</summary><label className="lapis-field">Código de acesso<input type="password" value={accessCode} maxLength={256} autoComplete="off" disabled={busy} placeholder="Informe o código fornecido pelo responsável" onChange={event => setAccessCode(event.target.value)} /></label><p>O código é usado para autorizar a extração e fica apenas na memória desta tela. Ao recarregar a página, informe-o novamente.</p></details>
      </div>
    </div>
    {phase !== 'idle' ? <div className="lapis-progress" role="status"><div><strong>{phase === 'collecting' ? 'Coletando conversas' : phase === 'cancelling' ? 'Cancelando…' : 'Extraindo nomes'}</strong><span>{progress.completed} / {progress.total} pedidos</span></div><progress max={Math.max(1, progress.total)} value={progress.completed} /><button type="button" onClick={cancel} disabled={phase === 'cancelling'}>Cancelar</button></div> : null}
    {error ? <p className="lapis-alert lapis-error" role="alert">{error}</p> : null}
    {uploading ? <p className="lapis-notice" role="status">Lendo arquivo…</p> : null}
    {notice ? <p className="lapis-notice" role="status">{notice}</p> : null}
    <div className="lapis-review-heading"><div className="lapis-section-title"><span>02</span><h3>Revisar pedidos <small>{draft.collected.length}</small></h3></div><div className="lapis-actions"><button type="button" className="lapis-primary" disabled={busy || !selectedOrders.length} onClick={runExtraction}>Extrair nomes{selectedOrders.length ? ` · ${selectedOrders.length}` : ''}</button><button type="button" disabled={busy || !draft.collected.length} onClick={exportCsv}>Exportar CSV</button><button type="button" className="lapis-link-button" disabled={busy || !draft.collected.length} onClick={() => { setDraft(EMPTY); setError(''); setNotice('Revisão limpa. As cartelas adicionadas continuam na fila.'); }}>Limpar revisão</button></div></div>
    {draft.collected.length ? <div className="lapis-orders">{draft.collected.map(source => {
      const result = draft.results[source.id];
      const fingerprint = result ? revision(result) : '';
      return <OrderReview key={source.id} source={source} result={result} selected={draft.selected[source.id]} reviewed={draft.reviewed[source.id] === fingerprint} accepted={acceptedSet.has(fingerprint)} busy={busy}
        onSelect={() => setDraft(current => ({ ...current, selected: dict({ ...current.selected, [source.id]: !current.selected[source.id] }) }))}
        onEdit={(index, field, value) => editOrder(source, names => names.map((entry, i) => i === index ? { ...entry, [field]: value } : entry))}
        onAddName={() => editOrder(source, names => [...names, { name: '', quantity: null, evidence: '' }])}
        onRemoveName={index => editOrder(source, names => names.filter((_, i) => i !== index))}
        onReview={() => setDraft(current => ({ ...current, reviewed: dict({ ...current.reviewed, [source.id]: current.reviewed[source.id] === fingerprint ? '' : fingerprint }) }))} />;
    })}</div> : <div className="lapis-empty"><span aria-hidden="true">✎</span><strong>As conversas começam aqui</strong><p>Cole os códigos dos pedidos ou importe um arquivo para preparar a revisão.</p></div>}
    <footer className="lapis-bottom-bar"><p>{saved ? 'Rascunho mantido nesta sessão por até 8 horas.' : 'Rascunho disponível apenas enquanto esta tela estiver aberta.'}<br /><span>Confira cada pedido para liberar sua cartela.</span></p><button type="button" className="lapis-primary" disabled={busy || !readyOrders.length || typeof onAddOrders !== 'function'} onClick={addToQueue}>Adicionar à fila{readyOrders.length ? ` · ${readyOrders.length} cartela${readyOrders.length > 1 ? 's' : ''}` : ''} <span aria-hidden="true">→</span></button></footer>
  </section>;
}
