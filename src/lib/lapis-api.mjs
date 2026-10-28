import { normalizeExtraction } from '../../shared/lapis.mjs';

const TIMEOUT_MS = 90000;

export function resolveLapisEndpoint(env = {}) {
  if (env.VITE_LAPIS_API_URL?.trim()) return env.VITE_LAPIS_API_URL.trim();
  if (env.DEV) return '/api/lapis/extract';
  if (env.VITE_SUPABASE_URL?.trim()) return `${env.VITE_SUPABASE_URL.trim().replace(/\/$/, '')}/functions/v1/lapis-extract`;
  return '/api/lapis/extract';
}

export function validateExtractionResponse(payload, sourceOrders) {
  if (!payload || !Array.isArray(payload.orders)) throw new Error('A extração retornou uma resposta inválida. Tente novamente.');
  const sources = new Map(sourceOrders.map(order => [order.id, order]));
  const seen = new Set();
  const orders = payload.orders.map(order => {
    if (!order || !sources.has(order.id) || seen.has(order.id)) throw new Error('A resposta não corresponde aos pedidos enviados. Nenhum resultado deste lote foi aplicado.');
    seen.add(order.id);
    if (!['found', 'not_found', 'review'].includes(order.status) || !Array.isArray(order.names) || order.names.length > 30 || typeof order.reason !== 'string') throw new Error('A extração retornou dados incompletos. Tente novamente.');
    const names = order.names.map(entry => {
      if (!entry || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 200 || typeof entry.evidence !== 'string' || (entry.quantity !== null && (!Number.isInteger(entry.quantity) || entry.quantity < 1))) throw new Error('A extração retornou um nome ou quantidade inválidos. Tente novamente.');
      return { name: entry.name, quantity: entry.quantity, evidence: entry.evidence };
    });
    if ((order.status === 'not_found' && names.length) || (order.status === 'found' && !names.length)) throw new Error('A extração retornou dados inconsistentes. Tente novamente.');
    return { id: order.id, names, status: order.status, reason: order.reason, text: sources.get(order.id).text };
  });
  if (seen.size !== sources.size) throw new Error('Faltaram pedidos na resposta. Nenhum resultado deste lote foi aplicado.');
  return normalizeExtraction({ orders }, sourceOrders);
}

function responseError(status, message) {
  if (status === 401 || status === 403) return 'Código de acesso não autorizado. Confira o código de acesso à extração e a permissão deste endereço.';
  if (status === 429) return 'O limite de extração foi atingido. Os resultados concluídos foram mantidos. Aguarde antes de tentar novamente.';
  if (status === 404 || status === 405) return 'O serviço de extração não está disponível neste endereço. Confira a configuração do serviço.';
  if (status === 503) return 'O serviço de extração ainda não está configurado ou está indisponível. Confira a configuração com o responsável pelo sistema.';
  if (status === 504) return 'A extração demorou mais que o esperado. Os resultados concluídos foram mantidos; tente os pedidos restantes.';
  return typeof message === 'string' && message.length < 300 ? message : 'Não foi possível extrair este lote. Os resultados concluídos foram mantidos.';
}

export async function extractOrders({ orders, accessCode, endpoint, signal, onChunk, onChunkError, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  if (!accessCode?.trim()) throw new Error('Preencha o código de acesso à extração antes de continuar.');
  if (!Array.isArray(orders) || !orders.length) throw new Error('Selecione pelo menos uma conversa para extrair.');
  for (const order of orders) {
    if (order.status !== 'collected' || typeof order.text !== 'string' || !order.text.trim() || order.text.length > 12000) throw new Error(`O pedido ${order.id} precisa ter uma conversa de até 12.000 caracteres.`);
  }
  const completed = [];
  for (let offset = 0; offset < orders.length; offset += 10) {
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    const chunk = orders.slice(offset, offset + 10);
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-sticker-access-code': accessCode.trim() }, body: JSON.stringify({ orders: chunk }), signal: controller.signal });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(responseError(response.status, body?.error));
      const result = validateExtractionResponse(body, chunk);
      if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
      completed.push(...result);
      onChunk?.(result, completed.length, orders.length);
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
      const failure = timedOut ? new Error('A extração demorou mais que o esperado. Tente os pedidos restantes; os resultados concluídos foram mantidos.')
        : error instanceof TypeError ? new Error('Não foi possível conectar ao serviço de extração. Confira sua conexão e a configuração do serviço para este endereço.') : error;
      onChunkError?.(chunk, failure);
      throw failure;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  return completed;
}
