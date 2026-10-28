import { parseOrderCodes } from '../../shared/lapis.mjs';
import { MAX_SEND_ORDERS, validateAskMessage } from '../../shared/lapis-autopilot.mjs';

// One extension job at a time. The UI owns the encompassing batch and keeps
// partial results even if this coordinator is cancelled or loses its connection.
export function createCollectionRun({ codes, send, makeId, onOrder = () => {}, onProgress = () => {}, signal,
  timeoutMs = 120000, cancelTimeoutMs = 8000 }) {
  const ids = parseOrderCodes(codes.join('\n'));
  if (!ids.length || ids.length > 500) throw new Error('Informe de 1 a 500 pedidos.');
  let active, resolve, reject, timer, settled = false, started = false, cancelling = false;
  const received = new Map();
  const finish = error => {
    if (settled) return;
    settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    if (error) reject(error);
    else resolve(ids.map(id => received.get(id)));
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      send('CANCEL', makeId(), { jobId: active.id });
      finish(new Error('A coleta parou de responder. Os resultados foram mantidos; reconecte as abas e retome o lote.'));
    }, timeoutMs);
  };
  const next = () => {
    const chunk = ids.slice(received.size, received.size + 200);
    active = { id: makeId(), codes: new Set(chunk), seen: new Set() };
    arm(); send('START', active.id, { codes: chunk });
  };
  function cancel() {
    if (settled || cancelling) return;
    cancelling = true; clearTimeout(timer);
    if (active) send('CANCEL', makeId(), { jobId: active.id });
    timer = setTimeout(() => finish(new DOMException('Cancelado', 'AbortError')), cancelTimeoutMs);
  }
  return {
    start() {
      if (started) throw new Error('Coleta já iniciada.');
      started = true;
      return new Promise((res, rej) => {
        resolve = res; reject = rej;
        if (signal?.aborted) { finish(new DOMException('Cancelado', 'AbortError')); return; }
        signal?.addEventListener('abort', cancel, { once: true });
        next();
      });
    },
    receive(data) {
      if (settled || !active || data.requestId !== active.id) return;
      if (data.type === 'PROGRESS') {
        const order = data.order;
        if (!order || !active.codes.has(order.id) || active.seen.has(order.id) ||
          !['collected', 'not_found', 'error'].includes(order.status) || typeof order.text !== 'string' || order.text.length > 12000 ||
          (order.error !== undefined && typeof order.error !== 'string')) return;
        const safeOrder = { id: order.id, status: order.status, text: order.text, ...(order.error ? { error: order.error.slice(0, 300) } : {}) };
        active.seen.add(order.id); received.set(order.id, safeOrder);
        onOrder(safeOrder); onProgress({ completed: received.size, total: ids.length });
        if (!cancelling) arm();
      } else if (data.type === 'COMPLETE') {
        if (cancelling || data.cancelled) { finish(new DOMException('Cancelado', 'AbortError')); return; }
        if (active.seen.size !== active.codes.size) { finish(new Error('A coleta terminou com pedidos pendentes. Retome o lote para buscar apenas os que faltam.')); return; }
        if (received.size === ids.length) finish();
        else next();
      } else if (data.type === 'ERROR') {
        finish(cancelling ? new DOMException('Cancelado', 'AbortError') : new Error(typeof data.error === 'string' ? data.error : 'A coleta foi interrompida. Reconecte as abas e retome o lote.'));
      }
    },
    dispose() {
      if (!started || settled) return;
      if (active && !cancelling) send('CANCEL', makeId(), { jobId: active.id });
      finish(new DOMException('Cancelado', 'AbortError'));
    },
  };
}

// Sends one confirmed message to at most 100 orders in a single extension job.
// Codes without a received status were not attempted and stay askable.
export function createSendRun({ codes, message, send, makeId, onOrder = () => {}, onProgress = () => {}, signal,
  timeoutMs = 120000, cancelTimeoutMs = 8000 }) {
  const text = validateAskMessage(message);
  const ids = parseOrderCodes(codes.join('\n'));
  if (!ids.length || ids.length > MAX_SEND_ORDERS) throw new Error(`Informe de 1 a ${MAX_SEND_ORDERS} pedidos para cobrar.`);
  let active, resolve, timer, settled = false, started = false, cancelling = false, failure = null;
  const received = new Map();
  const finish = error => {
    if (settled) return;
    settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    if (error) failure = error;
    resolve({ orders: ids.filter(id => received.has(id)).map(id => received.get(id)), notAttempted: ids.filter(id => !received.has(id)),
      cancelled: cancelling || Boolean(signal?.aborted), error: failure?.message || null });
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      send('CANCEL', makeId(), { jobId: active.id });
      finish(new Error('O envio parou de responder. Confira no Duoke os pedidos sem confirmação.'));
    }, timeoutMs);
  };
  function cancel() {
    if (settled || cancelling) return;
    cancelling = true; clearTimeout(timer);
    if (active) send('CANCEL', makeId(), { jobId: active.id });
    // A message may already be leaving: wait for its status before finishing.
    timer = setTimeout(() => finish(), cancelTimeoutMs);
  }
  return {
    start() {
      if (started) throw new Error('Envio já iniciado.');
      started = true;
      return new Promise(res => {
        resolve = res;
        if (signal?.aborted) { cancelling = true; finish(); return; }
        signal?.addEventListener('abort', cancel, { once: true });
        active = { id: makeId(), codes: new Set(ids) };
        arm(); send('SEND', active.id, { codes: ids, message: text });
      });
    },
    receive(data) {
      if (settled || !active || data.requestId !== active.id) return;
      if (data.type === 'PROGRESS') {
        const order = data.order;
        if (!order || !active.codes.has(order.id) || received.has(order.id) || !['sent', 'unconfirmed', 'failed'].includes(order.status) ||
          (order.error !== undefined && typeof order.error !== 'string')) return;
        const safeOrder = { id: order.id, status: order.status, ...(order.error ? { error: order.error.slice(0, 300) } : {}) };
        received.set(order.id, safeOrder);
        onOrder(safeOrder); onProgress({ completed: received.size, total: ids.length });
        if (!cancelling) arm();
      } else if (data.type === 'COMPLETE') finish();
      else if (data.type === 'ERROR') finish(new Error(typeof data.error === 'string' ? data.error : 'O envio foi interrompido. Confira no Duoke os pedidos sem confirmação.'));
    },
    dispose() {
      if (!started || settled) return;
      if (active && !cancelling) send('CANCEL', makeId(), { jobId: active.id });
      cancelling = true; finish();
    },
  };
}
