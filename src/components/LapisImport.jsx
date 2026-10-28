import { useEffect, useMemo, useRef, useState } from 'react';
import { parseOrderCodes, parseDuokeText, parseNamesCsv, exportNamesCsv, exportDuokeText, toLabelFields } from '../../shared/lapis.mjs';
import { canExtract, compactDraft, hasNames, MAX_BATCH_FILE_BYTES, mergeCollected, orderBucket, planBatch } from '../../shared/lapis-batch.mjs';
import { extractOrders, resolveLapisEndpoint } from '../lib/lapis-api.mjs';
import { createCollectionRun, createSendRun } from '../lib/lapis-collection.mjs';
import { AUTOPILOT_DEFAULT_MESSAGE, MAX_ASK_MESSAGE, MAX_SEND_ORDERS, classifyForAutopilot, loadAwaiting, planAsk, planAutopilot, recordSends, saveAwaiting, validateAskMessage } from '../../shared/lapis-autopilot.mjs';
import { mergeLabelCodes } from '../../shared/shopee-label.mjs';
import './LapisImport.css';

const dict = value => Object.assign(Object.create(null), value);
const EMPTY = { codes: '', raw: '', collected: [], results: dict(), selected: dict(), reviewed: dict(), shipDates: dict(), extractionErrors: dict() };
const SHIP_DATE = /^\d{2}\/\d{2}\/\d{4}$/;
const NO_REVISIONS = [];
const MAX_DRAFT = 8000000;
const PAGE_SIZE = 30;
const FILTERS = [['all', 'Todos'], ['names', 'Com nomes'], ['missing', 'Sem nomes'], ['errors', 'Falhas'], ['waiting', 'A extrair'], ['ask', 'Cobrar nome'], ['awaiting', 'Aguardando cliente']];
const ASK_MESSAGE_KEY = 'ss_lapis_ask_message_v1';
const SEND_LABELS = { sent: 'Mensagem enviada', unconfirmed: 'Envio não confirmado — confira no Duoke', failed: 'Mensagem não enviada' };
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

// Asked customers may answer on another day, so this list outlives the login session.
function awaitingKey() {
  try {
    const user = JSON.parse(localStorage.getItem('ss_session') || 'null')?.user;
    return typeof user === 'string' && user ? `ss_lapis_awaiting_v1:${user}` : null;
  } catch { return null; }
}

// Remembered on this computer at the operator's request; clearing the field forgets it.
const ACCESS_CODE_KEY = 'ss_lapis_access_code_v1';
function readAccessCode() {
  try {
    const saved = localStorage.getItem(ACCESS_CODE_KEY);
    return typeof saved === 'string' && saved.length <= 256 ? saved : '';
  } catch { return ''; }
}
function saveAccessCode(value) {
  try { if (value.trim()) localStorage.setItem(ACCESS_CODE_KEY, value); else localStorage.removeItem(ACCESS_CODE_KEY); } catch { /* Storage unavailable. */ }
}

function readAskMessage() {
  try {
    const saved = localStorage.getItem(ASK_MESSAGE_KEY);
    return typeof saved === 'string' && saved.trim() && saved.length <= MAX_ASK_MESSAGE ? saved : AUTOPILOT_DEFAULT_MESSAGE;
  } catch { return AUTOPILOT_DEFAULT_MESSAGE; }
}

const sinceText = sentAt => {
  const hours = Math.floor((Date.now() - sentAt) / 3600000);
  return hours < 1 ? 'há menos de 1 hora' : hours < 24 ? `há ${hours} h` : `há ${Math.floor(hours / 24)} dia${hours >= 48 ? 's' : ''}`;
};

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
      if (result && (result.id !== order.id || !['found', 'not_found', 'review'].includes(result.status) || typeof result.reason !== 'string' || !Array.isArray(result.names) || result.names.some(n => !n || typeof n.name !== 'string' || typeof n.evidence !== 'string' || (n.quantity !== null && !Number.isFinite(n.quantity))))) return EMPTY;
      if (result) result.text = order.text;
    }
    const knownIds = new Set(d.collected.map(order => order.id));
    if (Object.keys(d.results).some(id => !knownIds.has(id))) return EMPTY;
    // Drafts saved before label import have no shipDates; drop malformed entries instead of the whole draft.
    const shipDates = dict(Object.fromEntries(Object.entries(d.shipDates && typeof d.shipDates === 'object' ? d.shipDates : {}).filter(([, date]) => typeof date === 'string' && SHIP_DATE.test(date))));
    const extractionErrors = dict(Object.fromEntries(Object.entries(d.extractionErrors || {}).filter(([id, error]) => knownIds.has(id) && typeof error === 'string')));
    return { codes: d.codes, raw: d.raw, collected: d.collected, results: dict(d.results), selected: dict(d.selected), reviewed: dict(), shipDates, extractionErrors };
  } catch { return EMPTY; }
}

function checkImportSize(draft, orders) {
  if (new Set([...draft.collected.map(order => order.id), ...orders.map(order => order.id)]).size > 500) throw new Error('O limite é de 500 pedidos por revisão. Exporte ou limpe os pedidos atuais antes de importar mais.');
}

function queueError(order) {
  if (!order || !order.names.length) return 'Adicione pelo menos um nome para montar a cartela.';
  try { toLabelFields({ ...order, status: 'found' }); return ''; }
  catch (error) { return error.message; }
}

function OrderReview({ source, result, extractionError, selected, reviewed, accepted, busy, onSelect, onEdit, onAddName, onRemoveName, onReview, onRetry, connected, sendStatus, waitingSince, onResend }) {
  const validation = queueError(result);
  const canExtract = source.status === 'collected' && source.text.trim() && source.text.length <= 12000;
  const status = accepted ? 'Na fila' : hasNames(result) ? 'Revisar nomes' : extractionError ? 'Falha na extração' : source.status === 'error' ? 'Falha na coleta' : source.status === 'not_found' ? 'Pedido não encontrado' : result ? 'Nome não encontrado' : source.status === 'collected' && !source.text.trim() ? 'Cliente ainda não escreveu' : 'Conversa pronta';
  let quantities = [];
  if (!validation) quantities = toLabelFields({ ...result, status: 'found' }).map(field => field.qty);
  return <article className={`lapis-order${accepted ? ' lapis-order-accepted' : ''}`}>
    <header className="lapis-order-head">
      <div><span className="lapis-kicker">PEDIDO</span><h4>{source.id}</h4></div>
      <span className={`lapis-tag ${source.status === 'error' || extractionError ? 'lapis-tag-error' : ''}`}>{status}</span>
      {canExtract && !accepted ? <label className="lapis-check"><input type="checkbox" checked={Boolean(selected)} disabled={busy} onChange={onSelect} />Extrair</label> : null}
    </header>
    {sendStatus ? <p className={sendStatus.status === 'sent' ? 'lapis-reason' : 'lapis-error'}>{SEND_LABELS[sendStatus.status]}{sendStatus.error ? `: ${sendStatus.error}` : '.'}
      {sendStatus.status === 'failed' ? <> <button type="button" className="lapis-link-button" disabled={busy || !connected} onClick={onResend}>Tentar de novo</button></> : null}</p>
      : waitingSince ? <p className="lapis-reason">Cliente cobrado {sinceText(waitingSince)}. Use Verificar respostas para buscar o nome.</p> : null}
    {source.error ? <p className="lapis-error">{source.error}</p> : null}
    {extractionError ? <p className="lapis-error">{extractionError}</p> : null}
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
      {!hasNames(result) ? <button type="button" disabled={busy || !connected} onClick={onRetry}>Buscar novamente</button> : null}
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
  const [accessCode, setAccessCode] = useState(readAccessCode);
  const [connection, setConnection] = useState({ connected: false, duokeConnected: false, busy: false, checking: true });
  const [phase, setPhase] = useState('idle');
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(Boolean(storageKey));
  const [queueBusy, setQueueBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [filter, setFilter] = useState('all');
  const [reviewPage, setReviewPage] = useState(0);
  const [awaitingStore] = useState(awaitingKey);
  const [awaiting, setAwaiting] = useState(() => { try { return loadAwaiting(localStorage, awaitingStore); } catch { return {}; } });
  const [awaitingSaved, setAwaitingSaved] = useState(true);
  const [askMessage, setAskMessage] = useState(readAskMessage);
  const [sendStatus, setSendStatus] = useState(dict);
  const job = useRef(null), extraction = useRef(null), workflow = useRef(null), mounted = useRef(false), pendingStatus = useRef(new Map()), statusDeadline = useRef(null), enqueuing = useRef(false);
  const busy = phase !== 'idle' || queueBusy || uploading;

  useEffect(() => {
    if (!storageKey) return;
    try {
      const value = JSON.stringify({ version: 1, ts: Date.now(), draft: compactDraft(draft) });
      if (value.length > MAX_DRAFT) { sessionStorage.removeItem(storageKey); setSaved(false); return; }
      sessionStorage.setItem(storageKey, value); setSaved(true);
    } catch { try { sessionStorage.removeItem(storageKey); } catch { /* Storage unavailable. */ } setSaved(false); }
  }, [draft, storageKey]);

  useEffect(() => {
    let ok = false;
    try { ok = saveAwaiting(localStorage, awaitingStore, awaiting); } catch { /* Storage unavailable. */ }
    setAwaitingSaved(ok || !Object.keys(awaiting).length);
  }, [awaiting, awaitingStore]);

  useEffect(() => {
    try { if (askMessage.trim()) localStorage.setItem(ASK_MESSAGE_KEY, askMessage); } catch { /* Storage unavailable. */ }
  }, [askMessage]);

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
      job.current?.receive(data);
    };
    window.addEventListener('message', listener);
    probe();
    const interval = setInterval(probe, 15000);
    return () => {
      mounted.current = false;
      window.removeEventListener('message', listener); clearInterval(interval);
      clearTimeout(statusDeadline.current);
      workflow.current?.abort(); job.current?.dispose(); job.current = null;
      workflow.current = null; extraction.current = null;
    };
  }, []);

  const startCollection = async ({ codes, retry = false, autopilot = false } = {}) => {
    if (workflow.current || busy) return;
    const controller = new AbortController();
    try {
      const plan = planBatch(draft, codes || parseOrderCodes(draft.codes), { retry });
      if (!plan.codes.length) { setNotice('Todos estes pedidos já têm nomes. Confira os resultados para adicionar à fila.'); return; }
      if (!accessCode.trim()) throw new Error('Informe o código de acesso à extração antes de iniciar o lote.');
      if (plan.collect.length && (!connected || connection.busy)) throw new Error('Conecte as abas e aguarde a coleta atual antes de continuar.');
      workflow.current = controller; setError(''); setReviewPage(0);
      const sources = new Map(plan.sources.map(order => [order.id, order]));
      const known = new Set(draft.collected.map(order => order.id));
      setDraft(current => mergeCollected(current, plan.sources.filter(order => !known.has(order.id))));
      if (plan.collect.length) {
        setNotice('Coletando as conversas. A extração começa automaticamente ao concluir a coleta.');
        setPhase('collecting'); setProgress({ completed: 0, total: plan.collect.length });
        const run = createCollectionRun({ codes: plan.collect, send: post, makeId: requestId, signal: controller.signal,
          onOrder: order => {
            sources.set(order.id, order);
            if (mounted.current) setDraft(current => mergeCollected(current, [order]));
          },
          onProgress: value => { if (mounted.current) setProgress(value); },
        });
        job.current = run;
        await run.start(); job.current = null;
      }
      if (controller.signal.aborted || !mounted.current) return;
      const extractable = [...sources.values()].filter(canExtract);
      const extracted = { results: new Map(), errors: dict() };
      if (extractable.length) await performExtraction(extractable, controller, extracted);
      else if (!autopilot) setNotice('Coleta concluída sem conversas disponíveis para extração. Veja Sem nomes e Falhas para refazer.');
      if (autopilot && !controller.signal.aborted && mounted.current) await finishAutopilot(plan.codes, sources, extracted);
    } catch (failure) { reportFailure(failure); }
    finally { finishWorkflow(controller); }
  };

  const cancel = () => {
    if (!workflow.current) return;
    setPhase('cancelling'); setNotice('Cancelando… Os resultados concluídos serão mantidos.');
    workflow.current.abort();
  };

  const importText = text => {
    const orders = parseDuokeText(text);
    if (!orders.length) throw new Error('Nenhum pedido foi identificado. Importe o TXT do coletor com os códigos e as conversas.');
    if (orders.some(order => order.text.length > 12000)) throw new Error('Uma conversa ultrapassou 12.000 caracteres. Revise o arquivo antes de importar; nenhum texto foi cortado.');
    checkImportSize(draft, orders);
    setDraft(current => ({ ...mergeCollected(current, orders), raw: '' }));
    setFilter('all'); setReviewPage(0);
    setNotice(`${orders.length} pedidos importados. Selecione as conversas e extraia os nomes.`); setError('');
  };

  const upload = async event => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    setUploading(true); setError('');
    try {
      if (file.size > MAX_BATCH_FILE_BYTES) throw new Error('O arquivo deve ter até 24 MB. Divida os pedidos em arquivos menores.');
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

  const acceptedSet = useMemo(() => new Set(queuedRevisions), [queuedRevisions]);
  const selectedOrders = useMemo(() => draft.collected.filter(order => draft.selected[order.id] && canExtract(order) && !(draft.results[order.id] && acceptedSet.has(revision(draft.results[order.id])))), [draft.collected, draft.selected, draft.results, acceptedSet]);
  const readyOrders = useMemo(() => Object.values(draft.results).filter(order => draft.reviewed[order.id] === revision(order) && !acceptedSet.has(revision(order)) && !queueError(order)), [draft.results, draft.reviewed, acceptedSet]);
  const groups = useMemo(() => {
    const grouped = { all: draft.collected, names: [], missing: [], errors: [], waiting: [], ask: [], awaiting: [] };
    for (const source of draft.collected) {
      grouped[orderBucket(source, draft.results[source.id], draft.extractionErrors[source.id])].push(source);
      if (awaiting[source.id]) grouped.awaiting.push(source);
      else if (classifyForAutopilot(source, draft.results[source.id], { extractionError: draft.extractionErrors[source.id] }) === 'ask') grouped.ask.push(source);
    }
    return grouped;
  }, [draft.collected, draft.results, draft.extractionErrors, awaiting]);
  const askable = planAsk(groups.ask.map(order => order.id), awaiting);
  const askQueue = askable.slice(0, MAX_SEND_ORDERS);
  const awaitingIds = Object.keys(awaiting);
  let askError = '';
  try { validateAskMessage(askMessage); } catch (failure) { askError = failure.message; }
  const retryOrders = [...groups.missing, ...groups.errors];
  const pendingOrders = draft.collected.filter(source => !hasNames(draft.results[source.id]));
  const pendingExtraction = pendingOrders.filter(canExtract);
  const filteredOrders = groups[filter];
  const pageCount = Math.max(1, Math.ceil(filteredOrders.length / PAGE_SIZE));
  const currentPage = Math.min(reviewPage, pageCount - 1);
  const visibleOrders = filteredOrders.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  const reportFailure = failure => {
    if (!mounted.current) return;
    if (failure.name === 'AbortError') setNotice('Operação cancelada. Os resultados concluídos foram mantidos. Retome o lote ou extraia os pedidos restantes.');
    else setError(failure.message);
  };

  const finishWorkflow = controller => {
    if (workflow.current !== controller) return;
    job.current?.dispose(); job.current = null; extraction.current = null; workflow.current = null;
    if (mounted.current) { setPhase('idle'); probe(); }
  };

  const performExtraction = async (orders, controller, sink) => {
    extraction.current = controller;
    setError(''); setNotice('Extraindo nomes. O TXT consolidado do lote está disponível para download.');
    setPhase('extracting'); setProgress({ completed: 0, total: orders.length });
    await extractOrders({ orders, accessCode, endpoint, signal: controller.signal,
      onChunk: (chunk, completed, total) => {
        if (!mounted.current || controller.signal.aborted) return;
        for (const order of chunk) sink?.results.set(order.id, order);
        setDraft(current => {
          const results = dict(current.results), reviewed = dict(current.reviewed), selected = dict(current.selected), extractionErrors = dict(current.extractionErrors);
          for (const order of chunk) { results[order.id] = order; delete reviewed[order.id]; delete extractionErrors[order.id]; selected[order.id] = false; }
          return { ...current, results, reviewed, selected, extractionErrors };
        });
        setProgress({ completed, total });
      },
      onChunkError: (chunk, failure) => {
        if (!mounted.current || controller.signal.aborted) return;
        for (const order of chunk) if (sink) sink.errors[order.id] = failure.message;
        setDraft(current => ({ ...current, extractionErrors: dict({ ...current.extractionErrors, ...Object.fromEntries(chunk.map(order => [order.id, failure.message])) }) }));
      },
    });
    if (mounted.current) setNotice('Extração concluída. Confira os pedidos com nomes; os demais estão separados em Sem nomes e Falhas.');
  };

  const runExtraction = async (orders = selectedOrders) => {
    if (workflow.current || busy) return;
    const controller = new AbortController(); workflow.current = controller;
    try {
      if (!accessCode.trim()) throw new Error('Informe o código de acesso à extração antes de continuar.');
      await performExtraction(orders, controller);
    } catch (failure) { reportFailure(failure); }
    finally { finishWorkflow(controller); }
  };

  // Safe orders go straight to the queue; customers without names wait for the
  // operator to confirm the ask message. Nothing is sent from here.
  const finishAutopilot = async (ids, sources, extracted) => {
    const plan = planAutopilot({ ids, sources, results: extracted.results, extractionErrors: extracted.errors,
      isQueued: order => acceptedSet.has(revision(order)), awaiting, shipDates: draft.shipDates });
    setAwaiting(plan.awaiting);
    let queued = 0, queueFailure = '';
    if (plan.autoOrders.length && typeof onAddOrders === 'function') {
      setPhase('queueing');
      try {
        await onAddOrders(plan.autoOrders);
        queued = plan.autoOrders.length;
        if (mounted.current) setDraft(current => ({ ...current, reviewed: dict({ ...current.reviewed, ...Object.fromEntries(plan.autoOrders.map(order => [order.id, revision(order)])) }) }));
      } catch (failure) { queueFailure = failure.message || 'Não foi possível adicionar os pedidos à fila.'; }
    }
    if (!mounted.current) return;
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    setNotice([`Lote processado: ${plural(queued, 'cartela enviada', 'cartelas enviadas')} à fila automaticamente`,
      `${plan.counts.review + plan.autoOrders.length - queued} para revisar`,
      plural(plan.askable.length, 'cliente para cobrar', 'clientes para cobrar'),
      `${Object.keys(plan.awaiting).length} aguardando resposta`,
      plural(plan.counts.failed, 'falha', 'falhas')].join(' · ') + (plan.answered.length ? `. ${plural(plan.answered.length, 'cliente respondeu', 'clientes responderam')}.` : '.'));
    if (queueFailure) setError(`As cartelas aprovadas não foram para a fila: ${queueFailure} Confira e adicione manualmente.`);
    setFilter(plan.askable.length ? 'ask' : 'all'); setReviewPage(0);
  };

  const sendAsk = async ids => {
    if (workflow.current || busy) return;
    const controller = new AbortController();
    try {
      const message = validateAskMessage(askMessage);
      const codes = planAsk(ids, awaiting).slice(0, MAX_SEND_ORDERS);
      if (!codes.length) throw new Error('Nenhum cliente para cobrar agora. Pedidos cobrados nas últimas 24 horas não recebem nova mensagem.');
      if (!connected || connection.busy) throw new Error('Conecte as abas e aguarde a coleta atual antes de enviar.');
      workflow.current = controller; setError('');
      setNotice('Enviando a mensagem no Duoke. Não use o chat do Duoke até terminar.');
      setPhase('sending'); setProgress({ completed: 0, total: codes.length });
      const run = createSendRun({ codes, message, send: post, makeId: requestId, signal: controller.signal,
        onOrder: order => { if (mounted.current) setSendStatus(current => dict({ ...current, [order.id]: order })); },
        onProgress: value => { if (mounted.current) setProgress(value); },
      });
      job.current = run;
      const summary = await run.start(); job.current = null;
      // Possibly sent messages are recorded even if this screen closed meanwhile.
      setAwaiting(current => recordSends(current, summary.orders));
      if (!mounted.current) return;
      const count = status => summary.orders.filter(order => order.status === status).length;
      setNotice(`Cobrança concluída: ${count('sent')} enviada${count('sent') === 1 ? '' : 's'}, ${count('unconfirmed')} sem confirmação, ${count('failed')} não enviada${count('failed') === 1 ? '' : 's'}` +
        (summary.notAttempted.length ? `, ${summary.notAttempted.length} não tentada${summary.notAttempted.length === 1 ? '' : 's'}` : '') + '. Use Verificar respostas quando os clientes responderem.');
      if (summary.error) setError(summary.error);
      if (count('sent') + count('unconfirmed')) setFilter('awaiting');
    } catch (failure) { reportFailure(failure); }
    finally { finishWorkflow(controller); }
  };

  const editOrder = (source, transform) => setDraft(current => {
    const original = current.results[source.id] || { id: source.id, names: [], status: 'review', reason: '', text: source.text };
    const next = { ...original, names: transform(original.names), status: 'review' };
    const reviewed = dict(current.reviewed), extractionErrors = dict(current.extractionErrors);
    delete reviewed[source.id]; delete extractionErrors[source.id];
    return { ...current, results: dict({ ...current.results, [source.id]: next }), reviewed, extractionErrors };
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
      const orders = draft.collected.map(source => draft.results[source.id]).filter(hasNames);
      if (!orders.length) throw new Error('Ainda não há nomes para exportar. Baixe os códigos pendentes para refazer.');
      const csv = exportNamesCsv(orders);
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = 'nomes-lapis.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`CSV exportado com ${orders.length} pedidos com nomes. Os pedidos sem nomes e as falhas continuam separados nas pendências.`);
    } catch (failure) { setError(failure.message); }
  };

  const downloadText = (pending = false) => {
    try {
      const text = pending ? pendingOrders.map(order => order.id).join('\r\n') + '\r\n' : exportDuokeText(draft.collected);
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url;
      link.download = pending ? 'pedidos-pendentes-lapis.txt' : 'conversas-lote-lapis.txt';
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { setError(failure.message); }
  };

  const connected = connection.connected && connection.duokeConnected;
  const connectionText = connection.checking && !connection.connected ? 'Verificando conexão…' : connected ? 'Duoke conectado' : connection.connected ? 'Conecte a aba do Duoke' : 'Conecte a extensão';

  return <section className="lapis-import" aria-label="Importar pedidos do Duoke">
    <header className="lapis-heading">
      <div className="lapis-monogram" aria-hidden="true">L</div>
      <div><p className="lapis-kicker">DO PEDIDO À CARTELA</p><h2>Nomes para Lápis</h2><p>Cole o lote, colete e extraia os nomes. Confira os resultados e refaça apenas as pendências.</p></div>
      <div className={`lapis-connection${connected ? ' is-connected' : ''}`}><span className="lapis-dot" />{connectionText}<button type="button" onClick={probe} disabled={connection.checking} title="Verificar conexão">↻</button></div>
    </header>
    <div className="lapis-input-grid">
      <div className="lapis-input-panel">
        <div className="lapis-section-title"><span>01</span><h3>Buscar no Duoke</h3></div>
        <label className="lapis-field">Códigos dos pedidos<textarea value={draft.codes} disabled={busy} maxLength={100000} rows={4} placeholder={'Cole os códigos, um por linha\n323265626\n323265627'} onChange={event => setDraft(current => ({ ...current, codes: event.target.value }))} /></label>
        <p className="lapis-batch-hint">Até 500 pedidos por lote. Coleta em etapas automáticas, com TXT completo para download.</p>
        <div className="lapis-actions"><button type="button" className="lapis-primary" disabled={busy || !draft.codes.trim()} onClick={() => startCollection({ autopilot: true })} title="Coleta, extrai, envia à fila os pedidos seguros e separa os clientes para cobrar">Processar lote <span aria-hidden="true">→</span></button><button type="button" disabled={busy || !draft.codes.trim()} onClick={() => startCollection()}>Coletar e extrair</button><label className={`lapis-label-upload${busy ? ' is-disabled' : ''}`} title="Lê o código do pedido e o envio previsto de cada etiqueta">📄 Etiquetas Shopee (PDF)<input type="file" accept=".pdf,application/pdf" multiple disabled={busy} onChange={uploadLabels} /></label><a href="https://web.duoke.com/?lang=pt#/dk/main/chat" target="_blank" rel="noreferrer" className="lapis-link-button">Abrir Duoke ↗</a></div>
        <label className="lapis-field">Código de acesso à extração<input type="password" value={accessCode} maxLength={256} autoComplete="off" disabled={busy} placeholder="Informe uma vez neste computador" onChange={event => { setAccessCode(event.target.value); saveAccessCode(event.target.value); }} /></label>
        <details className="lapis-help"><summary>Conectar as abas pela primeira vez</summary><ol><li><a href={`${import.meta.env.BASE_URL}downloads/duoke-bridge.zip`} download>Baixe a extensão Duoke</a> e extraia o ZIP.</li><li>Em chrome://extensions ou edge://extensions, ative o modo de desenvolvedor e escolha “Carregar sem compactação”. Selecione a pasta extraída.</li><li>Abra a extensão na aba do Sticker Studio e clique em conectar. Faça o mesmo na aba do Duoke com sua conta aberta.</li><li>Volte aqui e clique em ↻ para verificar a conexão.</li></ol><p>A extensão lê as conversas dos pedidos informados e só envia mensagens quando você confirma a cobrança.</p></details>
      </div>
      <div className="lapis-input-panel">
        <div className="lapis-section-title"><span>OU</span><h3>Importar um arquivo</h3></div>
        <label className={`lapis-upload${busy ? ' is-disabled' : ''}`}><span aria-hidden="true">↥</span><strong>Carregar TXT ou CSV</strong><small>TXT completo do lote, coletor antigo ou nomes já extraídos · até 24 MB</small><input type="file" accept=".txt,.csv,text/plain,text/csv" disabled={busy} onChange={upload} /></label>
        <details className="lapis-help"><summary>Colar o texto do coletor</summary><label className="lapis-field">Pedidos e conversas<textarea rows={5} disabled={busy} value={draft.raw} maxLength={MAX_BATCH_FILE_BYTES} placeholder="Cole o relatório completo do coletor…" onChange={event => setDraft(current => ({ ...current, raw: event.target.value }))} /></label><button type="button" disabled={busy || !draft.raw.trim()} onClick={() => { try { importText(draft.raw); } catch (failure) { setError(failure.message); } }}>Importar texto</button></details>
        <p className="lapis-batch-hint">O código de acesso fica guardado neste navegador. Apague o campo para esquecê-lo.</p>
      </div>
    </div>
    {phase !== 'idle' ? <div className="lapis-progress" role="status"><div><strong>{phase === 'collecting' ? 'Coletando conversas' : phase === 'cancelling' ? 'Cancelando…' : phase === 'sending' ? 'Enviando mensagens no Duoke' : phase === 'queueing' ? 'Adicionando à fila' : 'Extraindo nomes'}</strong><span>{progress.completed} / {progress.total} pedidos</span></div><progress max={Math.max(1, progress.total)} value={progress.completed} /><button type="button" onClick={cancel} disabled={phase === 'cancelling'}>Cancelar</button></div> : null}
    {error ? <p className="lapis-alert lapis-error" role="alert">{error}</p> : null}
    {uploading ? <p className="lapis-notice" role="status">Lendo arquivo…</p> : null}
    {notice ? <p className="lapis-notice" role="status">{notice}</p> : null}
    {!saved && draft.collected.length > 0 ? <p className="lapis-alert lapis-error" role="alert">O rascunho não pôde ser salvo neste navegador. Baixe o TXT completo e o CSV dos nomes antes de fechar a tela.</p> : null}
    {awaitingIds.length > 0 ? <div className="lapis-pending lapis-awaiting">
      <div><strong>{awaitingIds.length} cliente{awaitingIds.length === 1 ? '' : 's'} aguardando resposta</strong><p>Cobrados neste computador nos últimos 7 dias. Verificar respostas coleta só esses pedidos, extrai os nomes e envia à fila os que responderam.</p></div>
      <div className="lapis-actions"><button type="button" disabled={busy || !connected || connection.busy} onClick={() => startCollection({ codes: awaitingIds, retry: true, autopilot: true })}>Verificar respostas · {awaitingIds.length}</button></div>
      {!awaitingSaved ? <p className="lapis-error">Não foi possível guardar a lista neste navegador. Anote os códigos cobrados.</p> : null}
    </div> : null}
    <div className="lapis-review-heading"><div className="lapis-section-title"><span>02</span><h3>Revisar pedidos <small>{draft.collected.length}</small></h3></div><div className="lapis-actions"><button type="button" className="lapis-primary" disabled={busy || !selectedOrders.length} onClick={() => runExtraction()}>Extrair selecionados{selectedOrders.length ? ` · ${selectedOrders.length}` : ''}</button><button type="button" disabled={!draft.collected.length} onClick={() => downloadText()}>Baixar TXT completo</button><button type="button" disabled={busy || !draft.collected.length} onClick={exportCsv}>Exportar CSV</button><button type="button" className="lapis-link-button" disabled={busy || !draft.collected.length} onClick={() => { setDraft(EMPTY); setFilter('all'); setReviewPage(0); setError(''); setNotice('Revisão limpa. As cartelas adicionadas continuam na fila.'); }}>Limpar revisão</button></div></div>
    {draft.collected.length > 0 ? <>
      <div className="lapis-filters" role="group" aria-label="Filtrar pedidos">
        {FILTERS.map(([key, label]) => <button type="button" key={key} aria-pressed={filter === key} className={`lapis-filter lapis-filter-${key}`} onClick={() => { setFilter(key); setReviewPage(0); }}>{label}<strong>{groups[key].length}</strong></button>)}
      </div>
      {groups.ask.length > 0 || filter === 'ask' ? <div className="lapis-pending lapis-ask">
        <div><strong>{askable.length} cliente{askable.length === 1 ? '' : 's'} sem nome para cobrar</strong><p>A conversa foi lida e nenhum nome foi encontrado. A mensagem abaixo é enviada no chat de cada pedido somente quando você clicar em enviar.{askable.length > MAX_SEND_ORDERS ? ` Serão enviados os primeiros ${MAX_SEND_ORDERS}; repita para os demais.` : ''}{groups.ask.length > askable.length ? ` ${groups.ask.length - askable.length} já foram cobrados nas últimas 24 horas.` : ''}</p></div>
        <label className="lapis-field">Mensagem para o cliente<textarea rows={3} value={askMessage} maxLength={MAX_ASK_MESSAGE} disabled={busy} onChange={event => setAskMessage(event.target.value)} /></label>
        <p className="lapis-batch-hint">{askMessage.trim().length} / {MAX_ASK_MESSAGE} caracteres{askError ? ` · ${askError}` : ''}</p>
        {askQueue.length ? <p className="lapis-ask-codes" aria-label="Pedidos que receberão a mensagem">{askQueue.join(' · ')}</p> : null}
        <div className="lapis-actions"><button type="button" className="lapis-primary" disabled={busy || !connected || connection.busy || !askQueue.length || Boolean(askError)} onClick={() => sendAsk(askQueue)}>Enviar para {askQueue.length} cliente{askQueue.length === 1 ? '' : 's'}</button></div>
      </div> : null}
      {pendingOrders.length > 0 ? <div className="lapis-pending">
        <div><strong>{pendingOrders.length} pedido{pendingOrders.length === 1 ? '' : 's'} pendente{pendingOrders.length === 1 ? '' : 's'}</strong><p>Sem nomes: confira a conversa ou busque novamente após a resposta do cliente. Falhas e pedidos a extrair ficam separados.</p></div>
        <div className="lapis-actions">
          <button type="button" disabled={busy || !connected || connection.busy || !retryOrders.length} onClick={() => startCollection({ codes: retryOrders.map(order => order.id), retry: true })}>Refazer pendências{retryOrders.length ? ` · ${retryOrders.length}` : ''}</button>
          <button type="button" disabled={busy || !pendingExtraction.length} onClick={() => runExtraction(pendingExtraction)}>Extrair pendentes{pendingExtraction.length ? ` · ${pendingExtraction.length}` : ''}</button>
          <button type="button" onClick={() => downloadText(true)}>Baixar códigos pendentes</button>
        </div>
      </div> : null}
      <div className="lapis-pagination"><span>{filteredOrders.length ? `${currentPage * PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PAGE_SIZE, filteredOrders.length)} de ${filteredOrders.length} pedidos` : 'Nenhum pedido neste filtro'}</span><div><button type="button" disabled={currentPage === 0} onClick={() => setReviewPage(currentPage - 1)}>Anterior</button><span>{currentPage + 1} / {pageCount}</span><button type="button" disabled={currentPage + 1 >= pageCount} onClick={() => setReviewPage(currentPage + 1)}>Próxima</button></div></div>
    </> : null}
    {draft.collected.length ? <div className="lapis-orders">{visibleOrders.map(source => {
      const result = draft.results[source.id];
      const fingerprint = result ? revision(result) : '';
      return <OrderReview key={source.id} source={source} result={result} extractionError={draft.extractionErrors[source.id]} selected={draft.selected[source.id]} reviewed={draft.reviewed[source.id] === fingerprint} accepted={acceptedSet.has(fingerprint)} busy={busy} connected={connected && !connection.busy}
        sendStatus={sendStatus[source.id]} waitingSince={awaiting[source.id]?.sentAt} onResend={() => sendAsk([source.id])}
        onRetry={() => startCollection({ codes: [source.id], retry: true })}
        onSelect={() => setDraft(current => ({ ...current, selected: dict({ ...current.selected, [source.id]: !current.selected[source.id] }) }))}
        onEdit={(index, field, value) => editOrder(source, names => names.map((entry, i) => i === index ? { ...entry, [field]: value } : entry))}
        onAddName={() => {
          // Keep the card mounted when the first typed character moves an order
          // from Sem nomes/Falhas into Com nomes.
          setFilter('all'); setReviewPage(Math.floor(draft.collected.findIndex(order => order.id === source.id) / PAGE_SIZE));
          editOrder(source, names => [...names, { name: '', quantity: null, evidence: '' }]);
        }}
        onRemoveName={index => editOrder(source, names => names.filter((_, i) => i !== index))}
        onReview={() => setDraft(current => ({ ...current, reviewed: dict({ ...current.reviewed, [source.id]: current.reviewed[source.id] === fingerprint ? '' : fingerprint }) }))} />;
    })}</div> : <div className="lapis-empty"><span aria-hidden="true">✎</span><strong>As conversas começam aqui</strong><p>Cole os códigos dos pedidos ou importe um arquivo para preparar a revisão.</p></div>}
    <footer className="lapis-bottom-bar"><p>{saved ? 'Rascunho mantido nesta sessão por até 8 horas.' : 'Rascunho disponível apenas enquanto esta tela estiver aberta.'}<br /><span>Confira cada pedido para liberar sua cartela.</span></p><button type="button" className="lapis-primary" disabled={busy || !readyOrders.length || typeof onAddOrders !== 'function'} onClick={addToQueue}>Adicionar à fila{readyOrders.length ? ` · ${readyOrders.length} cartela${readyOrders.length > 1 ? 's' : ''}` : ''} <span aria-hidden="true">→</span></button></footer>
  </section>;
}
