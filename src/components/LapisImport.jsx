import { useEffect, useMemo, useRef, useState } from 'react';
import { parseOrderCodes, parseDuokeText, parseNamesCsv, exportNamesCsv, exportDuokeText, toLabelFields } from '../../shared/lapis.mjs';
import { canExtract, compactDraft, hasNames, MAX_BATCH_FILE_BYTES, mergeCollected, orderBucket, planBatch } from '../../shared/lapis-batch.mjs';
import { extractOrders, resolveLapisEndpoint } from '../lib/lapis-api.mjs';
import { createCollectionRun, createSendRun } from '../lib/lapis-collection.mjs';
import { AUTOPILOT_DEFAULT_MESSAGE, MAX_ASK_MESSAGE, MAX_SEND_ORDERS, classifyForAutopilot, loadAwaiting, planAsk, planAutopilot, recordSends, saveAwaiting, validateAskMessage } from '../../shared/lapis-autopilot.mjs';
import { mergeLabelCodes } from '../../shared/shopee-label.mjs';
import { CYCLE_MINUTES, DEFAULT_CYCLE_MINUTES, addToInbox, applyCycle, awaitingFromState, conversationHash, cycleCodes, expireState, formatCycleMessage, isDue,
  markDone, normalizeState, recordPilotSends, removeFromState, reusableResult, stateList, withAwaiting } from '../../shared/lapis-continuous.mjs';
import { createAutopilotClient, resolveAutopilotEndpoint } from '../lib/lapis-autopilot-api.mjs';
import { orderRevision } from '../lib/lapis-queue.mjs';
import { MAX_CARTELAS, assignCartelas, cartelaError, cartelaOrders, cleanItems, itemPlan, unassign } from '../../shared/lapis-cartelas.mjs';
import './LapisImport.css';

const dict = value => Object.assign(Object.create(null), value);
const EMPTY = { codes: '', raw: '', collected: [], results: dict(), selected: dict(), reviewed: dict(), shipDates: dict(), extractionErrors: dict() };
const SHIP_DATE = /^\d{2}\/\d{2}\/\d{4}$/;
const NO_REVISIONS = [];
const MAX_DRAFT = 8000000;
const PAGE_SIZE = 50;
// One list for the review and the pilot: every order lands in exactly one of these tabs.
const TABS = [['all', 'Todos'], ['conferir', 'Para conferir'], ['duvida', 'Com dúvida'], ['aguardando', 'Aguardando cliente'], ['ler', 'A ler'], ['falha', 'Sem leitura'], ['fila', 'Na fila hoje']];
const TAB_KEY = 'ss_lapis_tab_v1';
function readTab() {
  try { const saved = localStorage.getItem(TAB_KEY); return TABS.some(([key]) => key === saved) ? saved : 'all'; } catch { return 'all'; }
}
const PILOT_BUCKET = { pending: 'ler', awaiting: 'aguardando', review: 'duvida', failed: 'falha', done: 'fila' };
// Review rows: what the operator sees decides the tab; the pilot only fills in what this screen does not know.
function rowBucket(source, result, extractionError, accepted, waiting) {
  if (accepted) return 'fila';
  if (hasNames(result)) return classifyForAutopilot(source, result) === 'auto' ? 'conferir' : 'duvida';
  if (waiting) return 'aguardando';
  const bucket = orderBucket(source, result, extractionError);
  if (bucket === 'errors' || source.status === 'not_found') return 'falha';
  return bucket === 'missing' ? 'aguardando' : 'ler';
}
const ASK_MESSAGE_KEY = 'ss_lapis_ask_message_v1';
const SEND_LABELS = { sent: 'Mensagem enviada', unconfirmed: 'Envio não confirmado — confira no Duoke', failed: 'Mensagem não enviada' };
const EXPIRY = 8 * 60 * 60 * 1000;
const endpoint = resolveLapisEndpoint(import.meta.env);
const autopilotEndpoint = resolveAutopilotEndpoint(import.meta.env);
const PILOT_KEY = 'ss_lapis_pilot_v1';
const PILOT_TICK = 20000;
// Duoke disconnected for this long while the pilot is on triggers one Telegram alert.
const DISCONNECT_ALERT = 20 * 60 * 1000;
const PILOT_OFF = { enabled: false, minutes: DEFAULT_CYCLE_MINUTES, autoAsk: false, telegram: false };

// Per-computer switch: only the computer with the Duoke tab open should run cycles.
function readPilotSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(PILOT_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return PILOT_OFF;
    return { enabled: saved.enabled === true, minutes: CYCLE_MINUTES.includes(saved.minutes) ? saved.minutes : DEFAULT_CYCLE_MINUTES,
      autoAsk: saved.autoAsk === true, telegram: saved.telegram === true };
  } catch { return PILOT_OFF; }
}
const timeText = at => new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
// Today shows the time; other days show the date too.
const whenText = at => new Date(at).toDateString() === new Date().toDateString() ? timeText(at)
  : new Date(at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const READY_REASON = 'Nome encontrado, aguardando sua conferência.';
const PILOT_TONE = { pending: 'muted', awaiting: 'wait', review: 'alert', failed: 'error', done: 'ok' };
const PILOT_STATUS = { pending: 'A ler', awaiting: 'Aguardando cliente', review: 'Com dúvida', failed: 'Sem leitura', done: 'Na fila' };
const PHASE_RANK = { review: 0, failed: 1, awaiting: 2, pending: 3, done: 4 };
const namesText = names => (names || []).map(entry => entry.quantity ? `${entry.name} (${entry.quantity})` : entry.name).join(', ');
function pilotDetail(entry) {
  if (entry.phase === 'done') return namesText(entry.review?.names) || 'Cartela enviada à fila de impressão.';
  if (entry.phase === 'review') return [namesText(entry.review?.names), entry.review?.reason].filter(Boolean).join(' · ') || 'Use Buscar de novo para ver a conversa.';
  if (entry.phase === 'failed') return 'Conversa não encontrada no Duoke em 3 ciclos seguidos.';
  if (entry.phase === 'awaiting') return entry.sentAt ? `Cobrado às ${whenText(entry.sentAt)}${entry.sendStatus === 'unconfirmed' ? ' (envio não confirmado)' : ''}.` : 'Aguardando o cliente mandar o nome.';
  if (entry.lastStatus === 'not_found') return 'Conversa lida, cliente ainda sem nome.';
  if (entry.failures) return `Tentativa ${entry.failures} de 3 sem encontrar a conversa.`;
  return 'Será lido no próximo ciclo.';
}
const requestId = () => globalThis.crypto?.randomUUID?.() || `lapis-${Date.now()}-${Math.random().toString(36).slice(2)}`;
// Fingerprint of what the operator approved, including how the names are split in cartelas.
const revision = order => JSON.stringify([order.id, order.names.map(({ name, quantity, cartela }) => [name, quantity, cartela ?? null]), order.cartelas ?? null]);
// Cartelas of an order: the operator's choice, else what the Duoke items say.
const cartelaOptions = (source, result, shipDate = '') => {
  const plan = itemPlan(source?.items);
  return { count: Math.min(MAX_CARTELAS, result?.cartelas || plan.cartelas), materials: plan.materials, shipDate, plan };
};
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

// Lists waiting to be processed: each pasted list or PDF becomes one, processed in order.
// Kept on this computer so a reload does not lose what was queued.
const BATCH_LIMIT = 40;
const BATCH_TTL = 24 * 60 * 60 * 1000;
function batchesKey() {
  try {
    const user = JSON.parse(localStorage.getItem('ss_session') || 'null')?.user;
    return typeof user === 'string' && user ? `ss_lapis_batches_v1:${user}` : null;
  } catch { return null; }
}
function readBatches(key) {
  if (!key) return [];
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '[]');
    if (!Array.isArray(saved)) return [];
    const now = Date.now();
    return saved.filter(batch => batch && typeof batch.id === 'string' && typeof batch.label === 'string' && Array.isArray(batch.codes) && batch.codes.every(code => typeof code === 'string')
      && Number.isFinite(batch.addedAt) && now - batch.addedAt < BATCH_TTL && ['waiting', 'running', 'done', 'error', 'cancelled'].includes(batch.status))
      // A list that was running when the page closed starts again.
      .map(batch => batch.status === 'running' ? { ...batch, status: 'waiting' } : batch).slice(-BATCH_LIMIT);
  } catch { return []; }
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function batchSummary(summary) {
  if (!summary) return '';
  if (summary.empty) return 'Todos já tinham nomes nesta tela.';
  return [`${summary.ready} para conferir`, `${summary.review} com dúvida`, `${summary.ask} para cobrar`, `${summary.failed} sem leitura`].join(' · ');
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
      if (result) {
        result.text = order.text;
        if (result.cartelas !== undefined && !(Number.isInteger(result.cartelas) && result.cartelas >= 1 && result.cartelas <= MAX_CARTELAS)) delete result.cartelas;
        for (const entry of result.names) if (entry.cartela !== undefined && !Number.isInteger(entry.cartela)) delete entry.cartela;
      }
      const items = cleanItems(order.items);
      if (items) order.items = items; else delete order.items;
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

function queueError(order, source) {
  if (!order || !order.names.length) return 'Adicione pelo menos um nome para montar a cartela.';
  return cartelaError({ ...order, status: 'found' }, cartelaOptions(source, order));
}

const ROW_ICONS = { ok: '✓', names: '●', alert: '!', error: '✕', missing: '?', muted: '○', wait: '…' };

// One compact row per order (GitHub-style list). The row shows status, code and a
// one-line summary with the quick actions; it expands to edit names and read the conversation.
function OrderReview({ bucket, plan, count, onCartelas, onCartela, source, result, extractionError, selected, reviewed, accepted, busy, expanded, onToggle, onSelect, onEdit, onAddName, onRemoveName, onReview, onRetry, onOpen, opening, canOpen, connected, sendStatus, waitingSince, onResend }) {
  const validation = queueError(result, source);
  const canExtract = source.status === 'collected' && source.text.trim() && source.text.length <= 12000;
  const named = hasNames(result);
  const doubt = named && (validation || bucket === 'duvida');
  const status = accepted ? 'Na fila' : named ? (doubt ? 'Com dúvida' : 'Para conferir') : extractionError ? 'Falha na extração' : source.status === 'error' ? 'Falha na coleta' : source.status === 'not_found' ? 'Pedido não encontrado' : result ? 'Nome não encontrado' : source.status === 'collected' && !source.text.trim() ? 'Cliente ainda não escreveu' : 'Conversa pronta';
  const tone = accepted ? 'ok' : named ? (doubt ? 'alert' : 'names') : extractionError || source.status === 'error' || source.status === 'not_found' ? 'error'
    : sendStatus?.status === 'sent' || waitingSince ? 'wait' : result ? 'missing' : 'muted';
  const failure = source.error || extractionError || (source.text.length > 12000 ? `Conversa com ${source.text.length.toLocaleString('pt-BR')} caracteres (máximo 12.000).` : '');
  const summary = named ? result.names.map(entry => entry.quantity ? `${entry.name || '(sem nome)'} (${entry.quantity})` : entry.name || '(sem nome)').join(', ')
    : failure || (sendStatus ? `${SEND_LABELS[sendStatus.status]}${sendStatus.error ? `: ${sendStatus.error}` : ''}` : waitingSince ? `Cliente cobrado ${sinceText(waitingSince)}` : result?.reason || status);
  const multi = count > 1;
  const shown = named && multi ? assignCartelas(result.names, count) : result?.names || [];
  // Auto quantities per name, and one summary line per cartela.
  let quantities = [], groups = [];
  if (!validation && named) {
    const orders = cartelaOrders({ ...result, status: 'found' }, { count, materials: plan.materials });
    groups = orders.map(order => ({ order, fields: toLabelFields(order) }));
    const queues = groups.map(group => group.fields.map(field => field.qty));
    quantities = shown.map(entry => (multi ? queues[entry.cartela - 1] : queues[0])?.shift());
  }
  return <li className={`lapis-row is-${tone}${expanded ? ' is-open' : ''}`}>
    <div className="lapis-row-main">
      <span className="lapis-row-select">{canExtract && !accepted ? <input type="checkbox" checked={Boolean(selected)} disabled={busy} onChange={onSelect} aria-label={`Extrair ${source.id}`} title="Marcar para extrair" /> : null}</span>
      <span className="lapis-row-icon" aria-hidden="true">{ROW_ICONS[tone]}</span>
      <button type="button" className="lapis-row-title" onClick={onToggle} aria-expanded={Boolean(expanded)} title={expanded ? 'Fechar detalhes' : 'Abrir detalhes'}>
        <span className="lapis-row-line"><span className="lapis-row-code">{source.id}</span><span className="lapis-row-status">{status}</span>
          {multi ? <span className="lapis-row-badge">{count} cartelas</span> : null}
          {plan.others.length ? <span className="lapis-row-badge is-alert">+ outro produto</span> : null}
          {plan.known && !plan.others.length && new Set(plan.materials).size > 1 ? <span className="lapis-row-badge is-alert">materiais diferentes</span> : null}</span>
        <span className={`lapis-row-summary${failure && !named ? ' is-error' : ''}`}>{summary}{named && result.reason ? <em> · {result.reason}</em> : null}</span>
      </button>
      <span className="lapis-row-actions">
        {named && !accepted ? <label className="lapis-row-review" title={validation || 'Conferi os nomes e as quantidades'}><input type="checkbox" disabled={busy || Boolean(validation)} checked={Boolean(reviewed)} onChange={onReview} />Conferi</label> : null}
        <button type="button" className="lapis-link-button" disabled={!canOpen} onClick={onOpen} title="Abre a conversa deste pedido na aba do Duoke">{opening ? 'Abrindo…' : 'Conferir no Duoke'}</button>
        {!named ? <button type="button" className="lapis-link-button" disabled={busy || !connected} onClick={onRetry}>Buscar de novo</button> : null}
        <button type="button" className="lapis-row-toggle" onClick={onToggle} aria-label={expanded ? `Fechar ${source.id}` : `Abrir ${source.id}`}>{expanded ? '▴' : '▾'}</button>
      </span>
    </div>
    {expanded ? <div className="lapis-row-body">
      {sendStatus ? <p className={sendStatus.status === 'sent' ? 'lapis-reason' : 'lapis-error'}>{SEND_LABELS[sendStatus.status]}{sendStatus.error ? `: ${sendStatus.error}` : '.'}
        {sendStatus.status === 'failed' ? <> <button type="button" className="lapis-link-button" disabled={busy || !connected} onClick={onResend}>Tentar de novo</button></> : null}</p>
        : waitingSince ? <p className="lapis-reason">Cliente cobrado {sinceText(waitingSince)}. Use Verificar respostas para buscar o nome.</p> : null}
      {failure ? <p className="lapis-error">{failure}</p> : null}
      {plan.alerts.map(alert => <p className="lapis-items-alert" key={alert}>⚠ {alert}</p>)}
      {plan.known ? <ul className="lapis-items" aria-label="Itens do pedido na Shopee">{source.items.map((item, index) => <li key={index}><strong>x{item.quantity}</strong> {item.variation || item.title}{item.sku ? <code>{item.sku}</code> : null}</li>)}</ul> : null}
      {result?.reason ? <p className="lapis-reason">{result.reason}</p> : null}
      {named && !accepted ? <label className="lapis-cartelas" title="Cada cartela tem até 150 etiquetas e 3 nomes">Cartelas<input type="number" min="1" max={MAX_CARTELAS} step="1" value={count} disabled={busy} onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= MAX_CARTELAS) onCartelas(value); }} />
        <small>{plan.known ? `${plan.cartelas} pelo pedido da Shopee` : 'até 150 etiquetas e 3 nomes cada'}</small></label> : null}
      {shown.map((entry, index) => <div className={`lapis-name${multi ? ' has-cartela' : ''}`} key={index}>
        <label>Nome na etiqueta<input value={entry.name} maxLength={200} disabled={busy} onChange={event => onEdit(index, 'name', event.target.value)} /></label>
        <label className="lapis-quantity">Quantidade<input type="number" min="1" max="150" step="1" value={entry.quantity ?? ''} placeholder={quantities[index] ? `Auto · ${quantities[index]}` : 'Auto'} disabled={busy} onChange={event => onEdit(index, 'quantity', event.target.value === '' ? null : Number(event.target.value))} /></label>
        {multi ? <label className="lapis-quantity">Cartela<select value={entry.cartela} disabled={busy} onChange={event => onCartela(index, Number(event.target.value))}>{Array.from({ length: count }, (_, i) => <option key={i} value={i + 1}>{i + 1}{plan.materials[i] ? ` · ${plan.materials[i]}` : ''}</option>)}</select></label> : null}
        <button className="lapis-icon-button" disabled={busy} type="button" onClick={() => onRemoveName(index)} aria-label={`Remover nome ${index + 1}`} title="Remover nome">×</button>
        {entry.evidence ? <p className="lapis-evidence">“{entry.evidence}”</p> : null}
      </div>)}
      <div className="lapis-order-footer">
        <button type="button" className="lapis-link-button" disabled={busy || accepted} onClick={onAddName}>+ Adicionar nome</button>
        {accepted ? <span className="lapis-reason">Revisão adicionada à fila.</span> : null}
      </div>
      {result?.names.length && validation ? <p className="lapis-error">{validation}</p> : null}
      {!validation && !accepted && groups.length === 1 ? <p className="lapis-allocation">Uma cartela · {quantities.reduce((sum, qty) => sum + (qty || 0), 0)} etiquetas{result.names.some(entry => entry.quantity === null) ? ' · quantidades em branco distribuídas automaticamente' : ''}</p> : null}
      {!validation && !accepted && groups.length > 1 ? <ul className="lapis-allocation lapis-cartela-list">{groups.map(({ order, fields }, i) => <li key={i}><strong>Cartela {order.id.slice(source.id.length + 3)}</strong> {fields.map(field => `${field.nome} (${field.qty})`).join(', ')}</li>)}</ul> : null}
      <details className="lapis-source"><summary>Ver conversa de origem{source.text ? ` · ${source.text.length.toLocaleString('pt-BR')} caracteres` : ''}</summary><pre>{source.text || 'Nenhuma conversa foi coletada para este pedido.'}</pre></details>
    </div> : null}
  </li>;
}

// Orders the pilot follows that this screen has not loaded: status, last activity and quick actions.
function PilotRow({ entry, busy, connected, canOpen, opening, onOpen, onRetry }) {
  const tone = PILOT_TONE[entry.phase];
  const when = entry.phase === 'done' && entry.doneAt ? `às ${whenText(entry.doneAt)}` : entry.addedAt ? `desde ${whenText(entry.addedAt)}` : '';
  return <li className={`lapis-row is-${tone}`}>
    <div className="lapis-row-main">
      <span className="lapis-row-select" />
      <span className="lapis-row-icon" aria-hidden="true">{ROW_ICONS[tone]}</span>
      <div className="lapis-row-title is-static">
        <span className="lapis-row-line"><span className="lapis-row-code">{entry.id}</span><span className="lapis-row-status">{PILOT_STATUS[entry.phase]}{when ? ` · ${when}` : ''}</span></span>
        <span className="lapis-row-summary">{pilotDetail(entry)}</span>
      </div>
      <span className="lapis-row-actions">
        <button type="button" className="lapis-link-button" disabled={!canOpen} onClick={onOpen} title="Abre a conversa deste pedido na aba do Duoke">{opening ? 'Abrindo…' : 'Conferir no Duoke'}</button>
        {entry.phase !== 'done' ? <button type="button" className="lapis-link-button" disabled={busy || !connected} onClick={onRetry} title="Coleta e lê este pedido agora">Buscar de novo</button> : null}
      </span>
    </div>
  </li>;
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
  const [filter, setFilterValue] = useState(readTab);
  const setFilter = key => { setFilterValue(key); try { localStorage.setItem(TAB_KEY, key); } catch { /* Storage unavailable. */ } };
  const [reviewPage, setReviewPage] = useState(0);
  const [awaitingStore] = useState(awaitingKey);
  const [awaiting, setAwaiting] = useState(() => { try { return loadAwaiting(localStorage, awaitingStore); } catch { return {}; } });
  const [awaitingSaved, setAwaitingSaved] = useState(true);
  const [askMessage, setAskMessage] = useState(readAskMessage);
  const [sendStatus, setSendStatus] = useState(dict);
  const job = useRef(null), extraction = useRef(null), workflow = useRef(null), mounted = useRef(false), pendingStatus = useRef(new Map()), statusDeadline = useRef(null), enqueuing = useRef(false), pendingOpen = useRef(new Map());
  const busy = phase !== 'idle' || queueBusy || uploading;
  const [pilot, setPilot] = useState(readPilotSettings);
  // null while not loaded: no cycle runs without the shared state.
  const [pilotState, setPilotStateValue] = useState(null);
  const [pilotInfo, setPilotInfo] = useState({ lastRun: 0, summary: '', error: '', loading: false });
  const [openingId, setOpeningId] = useState('');
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const toggleExpanded = id => setExpandedIds(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const [pilotSettingsOpen, setPilotSettingsOpen] = useState(false);
  const [batchStore] = useState(batchesKey);
  const [batches, setBatches] = useState(() => readBatches(batchStore));
  const [batchFilter, setBatchFilter] = useState('');
  const runningBatch = useRef('');
  const updateBatch = (id, patch) => setBatches(current => current.map(batch => batch.id === id ? { ...batch, ...patch } : batch));
  // Adds a list to the processing queue; returns how many codes it took.
  const enqueueBatch = (codes, label) => {
    const unique = [...new Set(codes)];
    if (!unique.length) return 0;
    setBatches(current => {
      const number = current.reduce((max, batch) => Math.max(max, batch.number || 0), 0) + 1;
      const finished = current.filter(batch => batch.status === 'done');
      // Oldest finished lists make room; waiting lists are never dropped.
      const keep = current.length >= BATCH_LIMIT && finished.length ? current.filter(batch => batch !== finished[0]) : current;
      return [...keep, { id: requestId(), number, label: label || `Lista ${number}`, codes: unique, status: 'waiting', addedAt: Date.now() }];
    });
    return unique.length;
  };
  const pilotStateRef = useRef(null), pilotSaved = useRef(new Set()), pilotSaveTimer = useRef(null), lastCycle = useRef(NaN),
    pendingAsk = useRef(null), disconnectedSince = useRef(0), disconnectAlerted = useRef(false), cycleFailureAlerted = useRef(false), tickRef = useRef(null);
  const pilotActive = pilot.enabled && pilotState !== null;
  const pilotClient = useMemo(() => createAutopilotClient({ endpoint: autopilotEndpoint, accessCode }), [accessCode]);
  // The ref is read by cycle code that runs across renders; React state drives the UI.
  const setPilotState = update => {
    const next = typeof update === 'function' ? update(pilotStateRef.current) : update;
    pilotStateRef.current = next; setPilotStateValue(next);
    return next;
  };
  const notifyTelegram = async text => {
    if (!pilot.telegram) return;
    try { await pilotClient.notify(text); }
    catch (failure) { if (mounted.current) setPilotInfo(current => ({ ...current, error: `Telegram: ${failure.message}` })); }
  };

  useEffect(() => {
    try { localStorage.setItem(PILOT_KEY, JSON.stringify(pilot)); } catch { /* Storage unavailable. */ }
  }, [pilot]);

  // Loads the shared state once the pilot is on and the access code is known; the
  // awaiting list of this computer is merged so nothing asked before is lost.
  useEffect(() => {
    if (!pilot.enabled || pilotStateRef.current || !accessCode.trim()) return;
    let cancelled = false;
    setPilotInfo(current => ({ ...current, loading: true, error: '' }));
    pilotClient.load().then(entries => {
      if (cancelled) return;
      const loaded = normalizeState(entries);
      pilotSaved.current = new Set(Object.keys(loaded));
      const remote = awaitingFromState(loaded);
      setPilotState(withAwaiting(loaded, { ...remote, ...awaiting }));
      // The awaiting effect then mirrors any later local change into the state.
      setAwaiting(current => ({ ...remote, ...current }));
      setPilotInfo(current => ({ ...current, loading: false }));
    }).catch(failure => { if (!cancelled) setPilotInfo(current => ({ ...current, loading: false, error: failure.message })); });
    return () => { cancelled = true; };
  }, [pilot.enabled, pilotClient]);

  useEffect(() => {
    if (pilotActive) setPilotState(current => current && withAwaiting(current, awaiting));
  }, [awaiting, pilotActive]);

  // Debounced write of the whole state; orders that left it are deleted remotely.
  useEffect(() => {
    if (pilotState === null) return;
    clearTimeout(pilotSaveTimer.current);
    pilotSaveTimer.current = setTimeout(() => {
      const entries = stateList(pilotState);
      const ids = new Set(entries.map(entry => entry.id));
      const remove = [...pilotSaved.current].filter(id => !ids.has(id));
      pilotClient.save(entries, remove).then(() => {
        pilotSaved.current = ids;
        if (mounted.current) setPilotInfo(current => current.error.startsWith('Estado:') ? { ...current, error: '' } : current);
      }).catch(failure => { if (mounted.current) setPilotInfo(current => ({ ...current, error: `Estado: ${failure.message}` })); });
    }, 1000);
    return () => clearTimeout(pilotSaveTimer.current);
  }, [pilotState, pilotClient]);

  useEffect(() => {
    const ready = stateList(pilotState || {}).filter(entry => entry.phase === 'review' && entry.review?.names?.length);
    if (!ready.length) return;
    setDraft(current => {
      const known = new Set(current.collected.map(order => order.id));
      const fresh = ready.filter(entry => !known.has(entry.id));
      if (!fresh.length) return current;
      const next = mergeCollected(current, fresh.map(entry => ({ id: entry.id, status: 'collected', text: '' })));
      next.results = dict({ ...next.results, ...Object.fromEntries(fresh.map(entry => {
        const ok = entry.review.reason === READY_REASON;
        return [entry.id, { id: entry.id, names: entry.review.names.map(item => ({ name: item.name, quantity: item.quantity ?? null, evidence: '' })), status: ok ? 'found' : 'review', reason: ok ? '' : entry.review.reason || '' }];
      })) });
      for (const entry of fresh) next.selected[entry.id] = false;
      return next;
    });
  }, [pilotState]);

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

  useEffect(() => {
    if (!batchStore) return;
    try { localStorage.setItem(batchStore, JSON.stringify(batches)); } catch { /* Storage unavailable. */ }
  }, [batches, batchStore]);

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
      const opened = pendingOpen.current.get(data.requestId);
      if (opened && ['OPENED', 'ERROR'].includes(data.type)) { pendingOpen.current.delete(data.requestId); opened(data); return; }
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

  // Returns what happened, so the list queue can show a status per list.
  const startCollection = async ({ codes, retry = false, autopilot = false, cycle = false, batch = false } = {}) => {
    if (workflow.current || busy) return { skipped: true };
    const controller = new AbortController();
    try {
      let base = draft;
      const requested = codes || parseOrderCodes(draft.codes);
      if (cycle || batch) {
        // Cycles and lists run all day: drop orders already in the queue so the 500-order review limit is not reached.
        const queuedIds = new Set(base.collected.filter(order => base.results[order.id] && isAccepted(base.results[order.id], order) && !requested.includes(order.id)).map(order => order.id));
        if (queuedIds.size && base.collected.length + requested.length > 400) {
          base = { ...base, collected: base.collected.filter(order => !queuedIds.has(order.id)),
            results: dict(Object.fromEntries(Object.entries(base.results).filter(([id]) => !queuedIds.has(id)))) };
          setDraft(base);
        }
      }
      if (cycle) {
        // Orders the operator already named in this screen are theirs: out of the cycle.
        const named = requested.filter(id => hasNames(base.results[id]));
        if (named.length) setPilotState(current => applyCycle(current, { ids: named,
          classified: Object.fromEntries(named.map(id => [id, isAccepted(base.results[id]) ? 'auto' : 'review'])) }).state);
      }
      const plan = planBatch(base, requested, { retry });
      if (autopilot && !cycle && pilotActive) {
        const { added } = addToInbox(pilotStateRef.current, plan.codes);
        setPilotState(current => addToInbox(current, plan.codes).state);
        if (added) setPilotInfo(current => ({ ...current, summary: `${added} pedido${added === 1 ? ' entrou' : 's entraram'} no piloto contínuo.` }));
      }
      if (!plan.codes.length) { if (!cycle && !batch) setNotice('Todos estes pedidos já têm nomes. Confira os resultados para adicionar à fila.'); return { ok: true, summary: { empty: true } }; }
      if (!accessCode.trim()) throw new Error('Informe o código de acesso à extração antes de iniciar o lote.');
      if (plan.collect.length && (!connected || connection.busy)) throw new Error('Conecte as abas e aguarde a coleta atual antes de continuar.');
      workflow.current = controller; setError('');
      if (!cycle) setReviewPage(0);
      const sources = new Map(plan.sources.map(order => [order.id, order]));
      const known = new Set(base.collected.map(order => order.id));
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
      if (controller.signal.aborted || !mounted.current) return { aborted: true };
      let extractable = [...sources.values()].filter(canExtract);
      const extracted = { results: new Map(), errors: dict() };
      const hashes = new Map();
      if (pilotActive && autopilot) {
        // Same conversation as the last no-name reading: reuse it instead of paying the AI again.
        const reused = [];
        for (const source of extractable) {
          const hash = await conversationHash(source.text);
          hashes.set(source.id, hash);
          const result = cycle ? reusableResult(source, pilotStateRef.current?.[source.id], hash) : null;
          if (result) { reused.push(result); extracted.results.set(source.id, result); }
        }
        if (reused.length) setDraft(current => {
          const results = dict(current.results), selected = dict(current.selected);
          for (const result of reused) { results[result.id] = result; selected[result.id] = false; }
          return { ...current, results, selected };
        });
        extractable = extractable.filter(source => !extracted.results.has(source.id));
      }
      if (extractable.length) await performExtraction(extractable, controller, extracted);
      else if (!autopilot) setNotice('Coleta concluída sem conversas disponíveis para extração. Veja Sem nomes e Falhas para refazer.');
      if (autopilot && !controller.signal.aborted && mounted.current) return { ok: true, summary: await finishAutopilot(plan.codes, sources, extracted, { cycle, batch, hashes }) };
      return { ok: true };
    } catch (failure) {
      reportFailure(failure);
      if (batch) return { ok: false, aborted: failure.name === 'AbortError', error: failure.message };
      if (cycle && failure.name !== 'AbortError' && mounted.current) {
        setPilotInfo(current => ({ ...current, error: `Ciclo: ${failure.message}` }));
        // One alert per failure streak; a successful cycle re-arms it.
        if (!cycleFailureAlerted.current) { cycleFailureAlerted.current = true; notifyTelegram(`Lápis · o ciclo do piloto falhou: ${failure.message}`); }
      }
      return { ok: false, aborted: failure.name === 'AbortError', error: failure.message };
    }
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
      // Each PDF becomes its own list in the processing queue.
      const labels = [];
      let pages = 0, missing = 0, lists = 0, codesQueued = 0;
      const empty = [];
      for (const file of files) {
        const read = await readShopeeLabels(file);
        labels.push(...read.labels); pages += read.pages; missing += read.missing;
        const { added } = mergeLabelCodes('', read.labels);
        if (added.length) { lists++; codesQueued += enqueueBatch(added, file.name.replace(/\.pdf$/iu, '').slice(0, 60) || undefined); }
        else empty.push(file.name);
      }
      if (!mounted.current) return;
      if (!labels.length) throw new Error(`Nenhum código de pedido encontrado em ${pages} página${pages === 1 ? '' : 's'}. Confira se o PDF é a etiqueta de envio da Shopee.`);
      setDraft(current => {
        const shipDates = dict(current.shipDates);
        for (const label of labels) if (label.envio) shipDates[label.pedido] = label.envio;
        return { ...current, shipDates };
      });
      setNotice(`${plural(lists, 'lista adicionada', 'listas adicionadas')} à fila de processamento · ${plural(codesQueued, 'pedido', 'pedidos')}` +
        (missing ? ` · ${plural(missing, 'página', 'páginas')} sem código` : '') + (empty.length ? ` · sem códigos: ${empty.join(', ')}` : '') + '.');
    } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { if (mounted.current) setUploading(false); }
  };

  const acceptedSet = useMemo(() => new Set(queuedRevisions), [queuedRevisions]);
  const sourceById = useMemo(() => new Map(draft.collected.map(order => [order.id, order])), [draft.collected]);
  // In the queue when every cartela of the order is there.
  const isAccepted = (result, source = sourceById.get(result?.id)) => Boolean(result) && cartelaOrders(result, cartelaOptions(source, result)).every(order => acceptedSet.has(orderRevision(order)));
  const selectedOrders = useMemo(() => draft.collected.filter(order => draft.selected[order.id] && canExtract(order) && !(draft.results[order.id] && isAccepted(draft.results[order.id], order))), [draft.collected, draft.selected, draft.results, acceptedSet, sourceById]);
  const readyOrders = useMemo(() => Object.values(draft.results).filter(order => draft.reviewed[order.id] === revision(order) && !isAccepted(order) && !queueError(order, sourceById.get(order.id))), [draft.results, draft.reviewed, acceptedSet, sourceById]);
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
  // The single list: review orders in the order they arrived, then orders only the pilot (or the
  // awaiting list) knows. Expanded rows stay visible while edited, even if their tab changes.
  const unified = useMemo(() => {
    const rows = [], known = new Set();
    const pilotEntries = pilotState || {};
    for (const source of draft.collected) {
      known.add(source.id);
      const result = draft.results[source.id];
      const accepted = isAccepted(result, source) || pilotEntries[source.id]?.phase === 'done';
      rows.push({ id: source.id, source, bucket: rowBucket(source, result, draft.extractionErrors[source.id], accepted, Boolean(awaiting[source.id])) });
    }
    const extra = new Map();
    for (const entry of stateList(pilotEntries)) if (!known.has(entry.id)) extra.set(entry.id, entry);
    for (const [id, value] of Object.entries(awaiting)) if (!known.has(id) && !extra.has(id)) extra.set(id, { id, phase: 'awaiting', sentAt: value.sentAt, sendStatus: value.status });
    const pilotOnly = [...extra.values()].sort((a, b) => PHASE_RANK[a.phase] - PHASE_RANK[b.phase] || (a.phase === 'done' ? (b.doneAt || 0) - (a.doneAt || 0) : (a.addedAt || 0) - (b.addedAt || 0)));
    for (const entry of pilotOnly) rows.push({ id: entry.id, entry, bucket: PILOT_BUCKET[entry.phase] });
    return rows;
  }, [draft.collected, draft.results, draft.extractionErrors, acceptedSet, awaiting, pilotState]);
  const batchCodes = useMemo(() => new Set(batches.find(batch => batch.id === batchFilter)?.codes || []), [batches, batchFilter]);
  const inBatch = row => !batchFilter || batchCodes.has(row.id);
  const tabCounts = Object.fromEntries(TABS.map(([key]) => [key, 0]));
  const batchRows = unified.filter(row => !batchFilter || batchCodes.has(row.id));
  for (const row of batchRows) tabCounts[row.bucket]++;
  tabCounts.all = batchRows.length;
  const filteredOrders = unified.filter(row => inBatch(row) && (filter === 'all' || row.bucket === filter || expandedIds.has(row.id)));
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
  const finishAutopilot = async (ids, sources, extracted, { cycle = false, batch = false, hashes = new Map() } = {}) => {
    const plan = planAutopilot({ ids, sources, results: extracted.results, extractionErrors: extracted.errors,
      isQueued: order => isAccepted(order, sources.get(order.id)), awaiting, shipDates: draft.shipDates });
    setAwaiting(plan.awaiting);
    // Nothing goes to the print queue on its own: orders with clear names wait in the
    // review list until the operator ticks Conferi (which queues that order at once).
    const readyIds = new Set(plan.autoOrders.map(order => order.id));
    const classified = { ...plan.classified };
    const results = new Map(extracted.results);
    for (const id of readyIds) {
      classified[id] = 'review';
      const result = results.get(id);
      if (result && !result.reason) results.set(id, { ...result, reason: READY_REASON });
    }
    // Several cartelas or another product: the alert becomes the reason, so the pilot list and Telegram show it.
    for (const [id, result] of results) {
      const alerts = itemPlan(sources.get(id)?.items).alerts;
      if (alerts.length && hasNames(result)) results.set(id, { ...result, reason: [...alerts, result.reason === READY_REASON ? '' : result.reason].filter(Boolean).join(' · ') });
    }
    let pilotOut = null;
    if (pilotStateRef.current && pilot.enabled) {
      pilotOut = applyCycle(addToInbox(pilotStateRef.current, ids).state, { ids, classified, results, hashes,
        awaiting: plan.awaiting, autoAsk: cycle && pilot.autoAsk });
      setPilotState(pilotOut.state);
      // Sent by the idle effect below, after this workflow releases the Duoke tab.
      if (pilotOut.askIds.length) pendingAsk.current = pilotOut.askIds;
    }
    const counts = { ready: readyIds.size, review: plan.counts.review, ask: plan.askable.length, failed: plan.counts.failed };
    if (!mounted.current) return counts;
    const summary = [`${cycle ? 'Ciclo do piloto' : 'Lote processado'}: ${plural(readyIds.size, 'nome pronto', 'nomes prontos')} para conferir`,
      `${plan.counts.review} com dúvida`,
      plural(plan.askable.length, 'cliente para cobrar', 'clientes para cobrar'),
      `${Object.keys(plan.awaiting).length} aguardando resposta`,
      plural(plan.counts.failed, 'falha', 'falhas')].join(' · ') + (plan.answered.length ? `. ${plural(plan.answered.length, 'cliente respondeu', 'clientes responderam')}.` : '.');
    setNotice(summary);
    if (cycle) {
      cycleFailureAlerted.current = false;
      setPilotInfo(current => ({ ...current, lastRun: Date.now(), summary, error: current.error.startsWith('Ciclo:') ? '' : current.error }));
    } else if (!batch) { setFilter(plan.askable.length ? 'aguardando' : 'all'); setReviewPage(0); }
    // Telegram only when something needs the operator; quiet cycles stay quiet.
    // Only orders with doubts are listed by name; ready ones are a count, so the chat is not flooded.
    const doubtful = pilotOut ? pilotOut.newReview.filter(id => !readyIds.has(id)) : [];
    const newReady = pilotOut ? pilotOut.newReview.filter(id => readyIds.has(id)).length : 0;
    if (pilotOut && (doubtful.length || newReady || pilotOut.newFailed.length)) {
      const review = doubtful.map(id => ({ id, names: results.get(id)?.names || [], reason: results.get(id)?.reason || '' }));
      notifyTelegram(formatCycleMessage({ queued: 0, review, asked: pilotOut.askIds.length, failed: pilotOut.newFailed,
        note: newReady ? `${plural(newReady, 'pedido novo pronto', 'pedidos novos prontos')} para conferir no Studio.` : '',
        awaitingCount: stateList(pilotOut.state).filter(entry => entry.phase === 'awaiting').length }));
    }
    return counts;
  };

  const sendAsk = async (ids, { automatic = false } = {}) => {
    if (workflow.current || busy) return;
    const controller = new AbortController();
    try {
      const message = validateAskMessage(askMessage);
      const codes = planAsk(ids, awaiting).slice(0, MAX_SEND_ORDERS);
      if (!codes.length) { if (automatic) return; throw new Error('Nenhum cliente para cobrar agora. Pedidos cobrados nas últimas 24 horas não recebem nova mensagem.'); }
      if (!connected || connection.busy) throw new Error('Conecte as abas e aguarde a coleta atual antes de enviar.');
      workflow.current = controller; setError('');
      setNotice(automatic ? 'Piloto: cobrando no Duoke os clientes sem nome. Não use o chat do Duoke até terminar.' : 'Enviando a mensagem no Duoke. Não use o chat do Duoke até terminar.');
      setPhase('sending'); setProgress({ completed: 0, total: codes.length });
      const run = createSendRun({ codes, message, send: post, makeId: requestId, signal: controller.signal,
        onOrder: order => { if (mounted.current) setSendStatus(current => dict({ ...current, [order.id]: order })); },
        onProgress: value => { if (mounted.current) setProgress(value); },
      });
      job.current = run;
      const summary = await run.start(); job.current = null;
      // Possibly sent messages are recorded even if this screen closed meanwhile.
      setAwaiting(current => recordSends(current, summary.orders));
      if (pilotStateRef.current && pilot.enabled) setPilotState(current => recordPilotSends(addToInbox(current, codes).state, summary.orders, { automatic }));
      if (!mounted.current) return;
      if (automatic) {
        const sent = summary.orders.filter(order => order.status !== 'failed').length;
        setPilotInfo(current => ({ ...current, summary: `${current.summary} Cobrança automática: ${sent} de ${codes.length} enviada${codes.length === 1 ? '' : 's'}.`.trim() }));
      }
      const count = status => summary.orders.filter(order => order.status === status).length;
      setNotice(`Cobrança concluída: ${count('sent')} enviada${count('sent') === 1 ? '' : 's'}, ${count('unconfirmed')} sem confirmação, ${count('failed')} não enviada${count('failed') === 1 ? '' : 's'}` +
        (summary.notAttempted.length ? `, ${summary.notAttempted.length} não tentada${summary.notAttempted.length === 1 ? '' : 's'}` : '') + '. Use Verificar respostas quando os clientes responderem.');
      if (summary.error) setError(summary.error);
      if (!automatic && count('sent') + count('unconfirmed')) setFilter('aguardando');
    } catch (failure) { reportFailure(failure); }
    finally { finishWorkflow(controller); }
  };

  // Edits work on the names as shown: with several cartelas every name already has its cartela.
  const editOrder = (source, transform, patch = {}) => setDraft(current => {
    const original = { ...(current.results[source.id] || { id: source.id, names: [], status: 'review', reason: '', text: source.text }), ...patch };
    const count = cartelaOptions(source, original).count;
    const next = { ...original, names: transform(assignCartelas(original.names, count)), status: 'review' };
    const reviewed = dict(current.reviewed), extractionErrors = dict(current.extractionErrors);
    delete reviewed[source.id]; delete extractionErrors[source.id];
    return { ...current, results: dict({ ...current.results, [source.id]: next }), reviewed, extractionErrors };
  });

  const addToQueue = async () => {
    if (enqueuing.current || !readyOrders.length) return;
    enqueuing.current = true; setQueueBusy(true); setError('');
    try {
      const orders = readyOrders.flatMap(order => cartelaOrders({ ...order, status: 'found' }, cartelaOptions(sourceById.get(order.id), order, draft.shipDates[order.id] || '')));
      orders.forEach(toLabelFields);
      await onAddOrders(orders);
      if (pilotStateRef.current && pilot.enabled) {
        // A queued order is answered: it leaves the pilot and the awaiting list, or the mirror would bring it back.
        const ids = readyOrders.map(order => order.id);
        setAwaiting(current => Object.fromEntries(Object.entries(current).filter(([id]) => !ids.includes(id))));
        const namesById = new Map(readyOrders.map(order => [order.id, unassign(order.names)]));
        setPilotState(current => markDone(current, ids, { namesById }));
      }
      setNotice(`${orders.length} cartela${orders.length === 1 ? '' : 's'} adicionada${orders.length === 1 ? '' : 's'} à fila de impressão.`);
    } catch (failure) { setError(failure.message || 'Não foi possível adicionar os pedidos à fila.'); }
    finally { enqueuing.current = false; if (mounted.current) setQueueBusy(false); }
  };

  // Ticking Conferi approves the order and sends it to the print queue at once.
  // On failure it stays ticked, so the bottom button can retry.
  const queueOne = async id => {
    const result = draft.results[id];
    const source = sourceById.get(id);
    if (!result || queueError(result, source) || enqueuing.current || typeof onAddOrders !== 'function') return;
    const fingerprint = revision(result);
    setDraft(current => ({ ...current, reviewed: dict({ ...current.reviewed, [id]: fingerprint }) }));
    enqueuing.current = true; setQueueBusy(true); setError('');
    try {
      const orders = cartelaOrders({ ...result, status: 'found' }, cartelaOptions(source, result, draft.shipDates[id] || ''));
      orders.forEach(toLabelFields);
      await onAddOrders(orders);
      if (pilotStateRef.current && pilot.enabled) {
        setAwaiting(current => { const next = { ...current }; delete next[id]; return next; });
        setPilotState(current => markDone(current, [id], { namesById: new Map([[id, unassign(result.names)]]) }));
      }
      if (mounted.current) setNotice(`Pedido ${id} conferido e adicionado à fila de impressão${orders.length > 1 ? ` (${orders.length} cartelas)` : ''}.`);
    } catch (failure) { if (mounted.current) setError(`O pedido ${id} foi conferido, mas não entrou na fila: ${failure.message || 'erro desconhecido'}. Use Adicionar à fila para tentar de novo.`); }
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

  // "Conferir no Duoke": the extension brings the Duoke tab forward and opens the
  // order's conversation (same search as collection, nothing is read back or sent).
  const canOpen = connected && !connection.busy && !busy && !openingId;
  const openInDuoke = async code => {
    if (!canOpen) return;
    setOpeningId(code); setError('');
    const id = requestId();
    const reply = await new Promise(resolve => {
      const timer = setTimeout(() => { pendingOpen.current.delete(id); resolve({ type: 'ERROR', error: 'O Duoke não respondeu a tempo. Confira se a aba continua conectada.' }); }, 50000);
      pendingOpen.current.set(id, data => { clearTimeout(timer); resolve(data); });
      post('OPEN', id, { code });
    });
    if (!mounted.current) return;
    setOpeningId('');
    if (reply.type === 'OPENED' && reply.status === 'collected') setNotice(`Conversa do pedido ${code} aberta no Duoke.`);
    else if (reply.type === 'OPENED' && reply.status === 'not_found') setError(`O pedido ${code} não foi encontrado no Duoke.`);
    else setError(typeof reply.error === 'string' && reply.error ? reply.error : `Não foi possível abrir o pedido ${code} no Duoke.`);
  };

  // Runs every PILOT_TICK from the latest render (via ref), so it always sees current state.
  tickRef.current = ({ force = false } = {}) => {
    if (!pilotActive) return;
    const now = Date.now();
    if (!connected) {
      if (connection.checking) return;
      if (!disconnectedSince.current) disconnectedSince.current = now;
      if (!disconnectAlerted.current && now - disconnectedSince.current >= DISCONNECT_ALERT) {
        disconnectAlerted.current = true;
        notifyTelegram('Lápis · piloto parado: a Ponte Duoke está desconectada há mais de 20 minutos. Abra as abas do Studio e do Duoke e conecte de novo pela extensão.');
      }
      return;
    }
    disconnectedSince.current = 0; disconnectAlerted.current = false;
    if (pendingAsk.current && !pilot.autoAsk) pendingAsk.current = null;
    if (pendingAsk.current || workflow.current || busy || connection.busy || openingId) return;
    // Lists the operator added go first; the cycle runs when the queue is empty.
    if (batches.some(batch => batch.status === 'waiting')) return;
    if (!force && !isDue(lastCycle.current, pilot.minutes, now)) return;
    lastCycle.current = now;
    const current = expireState(pilotStateRef.current, now);
    if (stateList(current).length !== stateList(pilotStateRef.current).length) setPilotState(current);
    const codes = cycleCodes(current);
    if (!codes.length) { setPilotInfo(info => ({ ...info, lastRun: now, summary: 'Nenhum pedido pendente no piloto. Novos lotes processados entram aqui automaticamente.' })); return; }
    startCollection({ codes, retry: true, autopilot: true, cycle: true });
  };

  useEffect(() => {
    const interval = setInterval(() => tickRef.current?.(), PILOT_TICK);
    return () => clearInterval(interval);
  }, []);

  // Automatic asks planned by a cycle go out as soon as the Duoke tab is free.
  useEffect(() => {
    if (phase !== 'idle' || !pendingAsk.current || !pilot.enabled || !pilot.autoAsk || !connected || connection.busy || workflow.current) return;
    const ids = pendingAsk.current; pendingAsk.current = null;
    sendAsk(ids, { automatic: true });
  }, [phase, connected, connection.busy, pilot.enabled, pilot.autoAsk]);

  // Processes the next waiting list whenever the Duoke tab and this screen are free.
  useEffect(() => {
    if (runningBatch.current || workflow.current || busy || !connected || connection.busy || openingId || pendingAsk.current || !accessCode.trim()) return;
    const next = batches.find(batch => batch.status === 'waiting');
    if (!next) return;
    runningBatch.current = next.id;
    updateBatch(next.id, { status: 'running', startedAt: Date.now(), error: '' });
    startCollection({ codes: next.codes, retry: true, autopilot: true, batch: true }).then(out => {
      if (out?.skipped) updateBatch(next.id, { status: 'waiting' });
      else if (out?.ok) updateBatch(next.id, { status: 'done', doneAt: Date.now(), summary: out.summary || null });
      else updateBatch(next.id, { status: out?.aborted ? 'cancelled' : 'error', error: out?.aborted ? '' : (out?.error || 'Falha desconhecida').slice(0, 300) });
    }).finally(() => { runningBatch.current = ''; });
  }, [batches, phase, queueBusy, uploading, connected, connection.busy, openingId, accessCode]);

  const pilotCounts = { pending: 0, awaiting: 0, review: 0, failed: 0, done: 0 };
  for (const entry of stateList(pilotState || {})) pilotCounts[entry.phase]++;
  const pilotIds = phaseName => stateList(pilotState || {}).filter(entry => entry.phase === phaseName).map(entry => entry.id);
  const nextCycle = pilotActive && Number.isFinite(lastCycle.current) ? lastCycle.current + pilot.minutes * 60000 : 0;
  const testTelegram = async () => {
    setPilotInfo(current => ({ ...current, error: '' }));
    try { await pilotClient.notify('Lápis · teste do piloto automático. Os avisos de revisão vão chegar aqui.'); setPilotInfo(current => ({ ...current, summary: 'Mensagem de teste enviada ao Telegram.' })); }
    catch (failure) { setPilotInfo(current => ({ ...current, error: `Telegram: ${failure.message}` })); }
  };

  return <section className="lapis-import" aria-label="Importar pedidos do Duoke">
    <header className="lapis-heading">
      <div className="lapis-monogram" aria-hidden="true">L</div>
      <div><p className="lapis-kicker">DO PEDIDO À CARTELA</p><h2>Nomes para Lápis</h2><p>Cole o lote, colete e extraia os nomes. Confira os resultados e refaça apenas as pendências.</p></div>
      <div className={`lapis-connection${connected ? ' is-connected' : ''}`}><span className="lapis-dot" />{connectionText}<button type="button" onClick={probe} disabled={connection.checking} title="Verificar conexão">↻</button></div>
    </header>
    <div className="lapis-input-grid">
      <div className="lapis-input-panel">
        <div className="lapis-section-title"><span>01</span><h3>Buscar no Duoke</h3></div>
        <label className="lapis-field">Códigos dos pedidos<textarea value={draft.codes} disabled={uploading} maxLength={100000} rows={4} placeholder={'Cole a lista de códigos: ela entra na fila de processamento e o campo fica livre para a próxima\n323265626\n323265627'}
          onChange={event => setDraft(current => ({ ...current, codes: event.target.value }))}
          onPaste={event => {
            // A pasted list goes straight to the processing queue; the field stays free for the next one.
            const codes = parseOrderCodes(event.clipboardData?.getData('text') || '');
            if (!codes.length) return;
            event.preventDefault();
            const count = enqueueBatch(codes);
            setNotice(`${plural(count, 'pedido entrou', 'pedidos entraram')} na fila de processamento.`); setError('');
          }} /></label>
        <p className="lapis-batch-hint">Cole uma lista ou carregue PDFs de etiquetas: cada um entra na fila abaixo e é processado em ordem. Pode adicionar a próxima enquanto a anterior roda.</p>
        <div className="lapis-actions"><button type="button" className="lapis-primary" disabled={!draft.codes.trim()} onClick={() => {
          const count = enqueueBatch(parseOrderCodes(draft.codes));
          if (!count) { setError('Nenhum código de pedido válido no campo.'); return; }
          setDraft(current => ({ ...current, codes: '' }));
          setNotice(`${plural(count, 'pedido entrou', 'pedidos entraram')} na fila de processamento.`); setError('');
        }} title="Manda a lista para a fila de processamento (coleta, extrai e deixa os nomes prontos para conferir) e limpa o campo">Processar lista <span aria-hidden="true">→</span></button><button type="button" disabled={busy || !draft.codes.trim()} onClick={() => startCollection()}>Coletar e extrair</button><label className={`lapis-label-upload${uploading ? ' is-disabled' : ''}`} title="Cada PDF vira uma lista na fila de processamento, com o envio previsto de cada etiqueta">📄 Etiquetas Shopee (PDF)<input type="file" accept=".pdf,application/pdf" multiple disabled={uploading} onChange={uploadLabels} /></label><a href="https://ai.duoke.com/?lang=pt#/dk/main/chat" target="_blank" rel="noreferrer" className="lapis-link-button">Abrir Duoke ↗</a></div>
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
    {batches.length ? <div className="lapis-batches" aria-label="Fila de processamento">
      <div className="lapis-batches-head"><strong>Fila de processamento</strong>
        <span>{plural(batches.filter(batch => batch.status === 'waiting').length, 'na espera', 'na espera')}{!connected ? ' · conecte o Duoke para começar' : !accessCode.trim() ? ' · informe o código de acesso' : ''}</span>
        {batches.some(batch => batch.status === 'done') ? <button type="button" className="lapis-link-button" onClick={() => { setBatches(current => current.filter(batch => batch.status !== 'done')); if (batches.find(batch => batch.id === batchFilter)?.status === 'done') setBatchFilter(''); }}>Limpar concluídas</button> : null}
      </div>
      <ul className="lapis-batch-rows">{batches.map(batch => {
        const running = batch.status === 'running';
        const label = running ? `Processando${phase === 'collecting' ? ' · coletando' : phase === 'extracting' ? ' · extraindo' : ''} ${progress.total ? `${progress.completed}/${progress.total}` : ''}`.trim()
          : batch.status === 'waiting' ? 'Na espera' : batch.status === 'done' ? `Concluída às ${timeText(batch.doneAt || batch.addedAt)}` : batch.status === 'cancelled' ? 'Cancelada' : 'Erro';
        return <li key={batch.id} className={`lapis-batch is-${batch.status}${batchFilter === batch.id ? ' is-selected' : ''}`}>
          <span className="lapis-batch-name" title={batch.label}>{batch.label}</span>
          <span className="lapis-batch-count">{plural(batch.codes.length, 'pedido', 'pedidos')}</span>
          <span className="lapis-batch-status">{label}</span>
          <span className="lapis-batch-detail">{batch.status === 'done' ? batchSummary(batch.summary) : batch.status === 'error' ? batch.error : batch.status === 'waiting' ? `adicionada às ${timeText(batch.addedAt)}` : ''}</span>
          <span className="lapis-batch-actions">
            {batch.status === 'done' ? <button type="button" className="lapis-link-button" onClick={() => { setBatchFilter(current => current === batch.id ? '' : batch.id); setFilter('all'); setReviewPage(0); }}>{batchFilter === batch.id ? 'Ver todos' : 'Ver pedidos'}</button> : null}
            {['error', 'cancelled'].includes(batch.status) ? <button type="button" className="lapis-link-button" onClick={() => updateBatch(batch.id, { status: 'waiting', error: '' })}>Tentar de novo</button> : null}
            {running ? <button type="button" className="lapis-link-button" onClick={cancel} disabled={phase === 'cancelling'}>Cancelar</button>
              : <button type="button" className="lapis-icon-button" onClick={() => { setBatches(current => current.filter(item => item.id !== batch.id)); if (batchFilter === batch.id) setBatchFilter(''); }} aria-label={`Remover ${batch.label}`} title={batch.status === 'waiting' ? 'Tirar da fila' : 'Remover'}>×</button>}
          </span>
        </li>;
      })}</ul>
    </div> : null}
    {phase !== 'idle' ? <div className="lapis-progress" role="status"><div><strong>{phase === 'collecting' ? 'Coletando conversas' : phase === 'cancelling' ? 'Cancelando…' : phase === 'sending' ? 'Enviando mensagens no Duoke' : phase === 'queueing' ? 'Adicionando à fila' : 'Extraindo nomes'}</strong><span>{progress.completed} / {progress.total} pedidos</span></div><progress max={Math.max(1, progress.total)} value={progress.completed} /><button type="button" onClick={cancel} disabled={phase === 'cancelling'}>Cancelar</button></div> : null}
    {error ? <p className="lapis-alert lapis-error" role="alert">{error}</p> : null}
    {uploading ? <p className="lapis-notice" role="status">Lendo arquivo…</p> : null}
    {notice ? <p className="lapis-notice" role="status">{notice}</p> : null}
    {!saved && draft.collected.length > 0 ? <p className="lapis-alert lapis-error" role="alert">O rascunho não pôde ser salvo neste navegador. Baixe o TXT completo e o CSV dos nomes antes de fechar a tela.</p> : null}
    <div className="lapis-review-heading"><div className="lapis-section-title"><span>02</span><h3>Pedidos <small>{unified.length}</small></h3></div><div className="lapis-actions"><button type="button" className="lapis-primary" disabled={busy || !selectedOrders.length} onClick={() => runExtraction()}>Extrair selecionados{selectedOrders.length ? ` · ${selectedOrders.length}` : ''}</button><button type="button" disabled={!draft.collected.length} onClick={() => downloadText()}>Baixar TXT completo</button><button type="button" disabled={busy || !draft.collected.length} onClick={exportCsv}>Exportar CSV</button><button type="button" className="lapis-link-button" disabled={busy || !draft.collected.length} onClick={() => { setDraft(EMPTY); setFilter('all'); setReviewPage(0); setError(''); setNotice('Revisão limpa. As cartelas adicionadas continuam na fila.'); }}>Limpar revisão</button></div></div>
    <div className={`lapis-pilot-bar${pilot.enabled ? ' is-on' : ''}`} aria-label="Piloto contínuo">
      <label className="lapis-switch"><input type="checkbox" checked={pilot.enabled} onChange={event => setPilot(current => ({ ...current, enabled: event.target.checked }))} /><span aria-hidden="true" />Piloto {pilot.enabled ? 'ligado' : 'desligado'}</label>
      <span className="lapis-pilot-meta">{pilot.enabled ? <>a cada {pilot.minutes} min · último {pilotInfo.lastRun ? timeText(pilotInfo.lastRun) : '—'} · {!connected ? 'Duoke desconectado' : `próximo ${busy ? 'agora' : nextCycle ? timeText(Math.max(nextCycle, Date.now())) : 'em instantes'}`}</> : 'Ligue para ler os pedidos sozinho a cada ciclo. Nada vai para a fila sem o seu Conferi.'}</span>
      <span className="lapis-actions">
        {pilot.enabled ? <button type="button" disabled={!pilotActive || busy || !connected || connection.busy} onClick={() => tickRef.current?.({ force: true })}>Rodar agora</button> : null}
        <button type="button" className="lapis-link-button" aria-expanded={pilotSettingsOpen} onClick={() => setPilotSettingsOpen(open => !open)}>⚙ Ajustes</button>
      </span>
    </div>
    {pilotSettingsOpen ? <div className="lapis-pilot-settings">
      <p className="lapis-pilot-lead">O piloto repete o Processar lote sozinho: coleta as conversas, extrai só o que tem mensagem nova e deixa os nomes em Para conferir. Mantenha esta aba e a do Duoke abertas neste computador. Pedidos entram pelo Processar lote, pelas etiquetas em PDF + Incluir códigos colados, ou cobrados por aqui; os que vão para a fila aparecem em Na fila hoje até a meia-noite, os outros ficam no máximo 7 dias.</p>
      <div className="lapis-pilot-options">
        <label className="lapis-field">A cada<select value={pilot.minutes} onChange={event => setPilot(current => ({ ...current, minutes: Number(event.target.value) }))}>{CYCLE_MINUTES.map(value => <option key={value} value={value}>{value} minutos</option>)}</select></label>
        <label className="lapis-check"><input type="checkbox" checked={pilot.autoAsk} onChange={event => setPilot(current => ({ ...current, autoAsk: event.target.checked }))} />Cobrar automaticamente quem não mandou o nome (uma vez por pedido, com a mensagem de cobrança salva)</label>
        <label className="lapis-check"><input type="checkbox" checked={pilot.telegram} onChange={event => setPilot(current => ({ ...current, telegram: event.target.checked }))} />Avisar no Telegram o que precisar de revisão</label>
      </div>
      <div className="lapis-actions">
        <button type="button" disabled={!pilotActive || busy || !draft.codes.trim()} onClick={() => {
          const { state, added } = addToInbox(pilotStateRef.current, parseOrderCodes(draft.codes));
          setPilotState(state); setPilotInfo(current => ({ ...current, summary: `${added} pedido${added === 1 ? '' : 's'} novo${added === 1 ? '' : 's'} no piloto.` }));
        }}>Incluir códigos colados</button>
        {pilot.telegram ? <button type="button" className="lapis-link-button" disabled={!accessCode.trim()} onClick={testTelegram}>Testar Telegram</button> : null}
      </div>
    </div> : null}
    {pilot.enabled && pilotInfo.loading ? <p className="lapis-notice" role="status">Carregando o estado do piloto…</p> : null}
    {pilot.enabled && !accessCode.trim() ? <p className="lapis-alert lapis-error">Informe o código de acesso à extração acima para ligar o piloto.</p> : null}
    {pilot.enabled && pilotInfo.summary ? <p className="lapis-notice lapis-pilot-summary">{pilotInfo.summary}</p> : null}
    {pilot.enabled && pilotInfo.error ? <p className="lapis-alert lapis-error" role="alert">{pilotInfo.error}</p> : null}
    {unified.length > 0 ? <>
      {batchFilter ? <p className="lapis-batch-chip">Mostrando só os pedidos de <strong>{batches.find(batch => batch.id === batchFilter)?.label}</strong> <button type="button" className="lapis-link-button" onClick={() => setBatchFilter('')}>Ver todos</button></p> : null}
      <div className="lapis-filters" role="tablist" aria-label="Filtrar pedidos">
        {TABS.map(([key, label]) => key === 'all' || tabCounts[key] || filter === key ? <button type="button" role="tab" key={key} aria-selected={filter === key} aria-pressed={filter === key} className={`lapis-filter lapis-filter-${key}`} onClick={() => { setFilter(key); setReviewPage(0); }}>{label}<strong>{tabCounts[key]}</strong></button> : null)}
      </div>
    {awaitingIds.length > 0 && filter === 'aguardando' ? <div className="lapis-pending lapis-awaiting">
        <div><strong>{awaitingIds.length} cliente{awaitingIds.length === 1 ? '' : 's'} aguardando resposta</strong><p>Cobrados neste computador nos últimos 7 dias. Verificar respostas coleta só esses pedidos, extrai os nomes e envia à fila os que responderam.</p></div>
      <div className="lapis-actions"><button type="button" disabled={busy || !connected || connection.busy} onClick={() => startCollection({ codes: awaitingIds, retry: true, autopilot: true })}>Verificar respostas · {awaitingIds.length}</button></div>
      {!awaitingSaved ? <p className="lapis-error">Não foi possível guardar a lista neste navegador. Anote os códigos cobrados.</p> : null}
    </div> : null}
      {filter === 'aguardando' && groups.ask.length > 0 ? <div className="lapis-pending lapis-ask">
        <div><strong>{askable.length} cliente{askable.length === 1 ? '' : 's'} sem nome para cobrar</strong><p>A conversa foi lida e nenhum nome foi encontrado. A mensagem abaixo é enviada no chat de cada pedido somente quando você clicar em enviar.{askable.length > MAX_SEND_ORDERS ? ` Serão enviados os primeiros ${MAX_SEND_ORDERS}; repita para os demais.` : ''}{groups.ask.length > askable.length ? ` ${groups.ask.length - askable.length} já foram cobrados nas últimas 24 horas.` : ''}</p></div>
        <label className="lapis-field">Mensagem para o cliente<textarea rows={3} value={askMessage} maxLength={MAX_ASK_MESSAGE} disabled={busy} onChange={event => setAskMessage(event.target.value)} /></label>
        <p className="lapis-batch-hint">{askMessage.trim().length} / {MAX_ASK_MESSAGE} caracteres{askError ? ` · ${askError}` : ''}</p>
        {askQueue.length ? <p className="lapis-ask-codes" aria-label="Pedidos que receberão a mensagem">{askQueue.join(' · ')}</p> : null}
        <div className="lapis-actions"><button type="button" className="lapis-primary" disabled={busy || !connected || connection.busy || !askQueue.length || Boolean(askError)} onClick={() => sendAsk(askQueue)}>Enviar para {askQueue.length} cliente{askQueue.length === 1 ? '' : 's'}</button></div>
      </div> : null}
      {filter === 'falha' && pilotCounts.failed ? <div className="lapis-pending">
        <div><strong>{pilotCounts.failed} pedido{pilotCounts.failed === 1 ? '' : 's'} que o piloto não conseguiu ler</strong><p>A conversa não foi encontrada no Duoke em 3 ciclos seguidos. Confira o código no Duoke, tente de novo ou descarte.</p></div>
        <div className="lapis-actions">
          <button type="button" disabled={busy} onClick={() => setPilotState(current => Object.assign(Object.create(null), current, Object.fromEntries(pilotIds('failed').map(id => [id, { ...current[id], phase: 'pending', failures: 0 }]))))}>Tentar de novo no piloto · {pilotCounts.failed}</button>
          <button type="button" className="lapis-link-button" disabled={busy} onClick={() => setPilotState(current => removeFromState(current, pilotIds('failed')))}>Descartar do piloto</button>
        </div>
      </div> : null}
      {['falha', 'ler'].includes(filter) && pendingOrders.length > 0 ? <div className="lapis-pending">
        <div><strong>{pendingOrders.length} pedido{pendingOrders.length === 1 ? '' : 's'} pendente{pendingOrders.length === 1 ? '' : 's'}</strong><p>Sem nomes: confira a conversa ou busque novamente após a resposta do cliente. Falhas e pedidos a extrair ficam separados.</p></div>
        <div className="lapis-actions">
          <button type="button" disabled={busy || !connected || connection.busy || !retryOrders.length} onClick={() => startCollection({ codes: retryOrders.map(order => order.id), retry: true })}>Refazer pendências{retryOrders.length ? ` · ${retryOrders.length}` : ''}</button>
          <button type="button" disabled={busy || !pendingExtraction.length} onClick={() => runExtraction(pendingExtraction)}>Extrair pendentes{pendingExtraction.length ? ` · ${pendingExtraction.length}` : ''}</button>
          <button type="button" onClick={() => downloadText(true)}>Baixar códigos pendentes</button>
        </div>
      </div> : null}
      <div className="lapis-pagination"><span>{filteredOrders.length ? `${currentPage * PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PAGE_SIZE, filteredOrders.length)} de ${filteredOrders.length} pedidos` : 'Nenhum pedido neste filtro'}</span><div><button type="button" disabled={currentPage === 0} onClick={() => setReviewPage(currentPage - 1)}>Anterior</button><span>{currentPage + 1} / {pageCount}</span><button type="button" disabled={currentPage + 1 >= pageCount} onClick={() => setReviewPage(currentPage + 1)}>Próxima</button></div></div>
    </> : null}
    {unified.length ? <ul className="lapis-orders">{visibleOrders.map(({ id, source, entry, bucket }) => {
      if (!source) return <PilotRow key={id} entry={entry} busy={busy} connected={connected && !connection.busy} canOpen={canOpen} opening={openingId === id}
        onOpen={() => openInDuoke(id)} onRetry={() => startCollection({ codes: [id], retry: true })} />;
      const result = draft.results[source.id];
      const fingerprint = result ? revision(result) : '';
      const options = cartelaOptions(source, result);
      return <OrderReview key={source.id} bucket={bucket} plan={options.plan} count={options.count} source={source} result={result} extractionError={draft.extractionErrors[source.id]} selected={draft.selected[source.id]} reviewed={draft.reviewed[source.id] === fingerprint} accepted={isAccepted(result, source) || pilotState?.[source.id]?.phase === 'done'}
        onCartelas={value => editOrder(source, names => names, { cartelas: value, names: unassign(result.names) })}
        onCartela={(index, value) => editOrder(source, names => names.map((entry, i) => i === index ? { ...entry, cartela: value } : entry))} busy={busy} connected={connected && !connection.busy}
        sendStatus={sendStatus[source.id]} waitingSince={awaiting[source.id]?.sentAt} onResend={() => sendAsk([source.id])}
        onRetry={() => startCollection({ codes: [source.id], retry: true })}
        onOpen={() => openInDuoke(source.id)} opening={openingId === source.id} canOpen={canOpen}
        expanded={expandedIds.has(source.id)} onToggle={() => toggleExpanded(source.id)}
        onSelect={() => setDraft(current => ({ ...current, selected: dict({ ...current.selected, [source.id]: !current.selected[source.id] }) }))}
        onEdit={(index, field, value) => editOrder(source, names => names.map((entry, i) => i === index ? { ...entry, [field]: value } : entry))}
        // The row is expanded, so it stays in view even when the new name moves it to another tab.
        onAddName={() => editOrder(source, names => [...names, { name: '', quantity: null, evidence: '' }])}
        onRemoveName={index => editOrder(source, names => names.filter((_, i) => i !== index))}
        onReview={() => { if (draft.reviewed[source.id] === fingerprint) setDraft(current => ({ ...current, reviewed: dict({ ...current.reviewed, [source.id]: '' }) })); else queueOne(source.id); }} />;
    })}</ul> : <div className="lapis-empty"><span aria-hidden="true">✎</span><strong>As conversas começam aqui</strong><p>Cole os códigos dos pedidos ou importe um arquivo. Com o piloto ligado, os pedidos que ele acompanha aparecem aqui também.</p></div>}
    <footer className="lapis-bottom-bar"><p>{saved ? 'Rascunho mantido nesta sessão por até 8 horas.' : 'Rascunho disponível apenas enquanto esta tela estiver aberta.'}<br /><span>Marque Conferi para mandar o pedido à fila de impressão.</span></p><button type="button" className="lapis-primary" disabled={busy || !readyOrders.length || typeof onAddOrders !== 'function'} onClick={addToQueue}>Adicionar à fila{readyOrders.length ? ` · ${readyOrders.length} cartela${readyOrders.length > 1 ? 's' : ''}` : ''} <span aria-hidden="true">→</span></button></footer>
  </section>;
}
