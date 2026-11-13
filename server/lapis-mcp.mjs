import { ENTRY_TTL, MAX_FAILURES, normalizeEntry } from '../shared/lapis-continuous.mjs';

// Read-only MCP server (Streamable HTTP, JSON responses) over the continuous
// autopilot state, for agents such as Hermes. It never writes, sends messages or
// touches the print queue. Own bearer token (LAPIS_MCP_TOKEN), separate from the
// Studio access code, so a leaked agent config cannot change anything.

export const MAX_MCP_BYTES = 64_000;
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u;
const PHASE_LABEL = { pending: 'a_ler', awaiting: 'aguardando_cliente', review: 'para_revisar', failed: 'sem_leitura' };
const PHASE_BY_LABEL = Object.fromEntries(Object.entries(PHASE_LABEL).map(([phase, label]) => [label, phase]));
const PHASE_ORDER = { review: 0, failed: 1, awaiting: 2, pending: 3 };
const HOUR = 60 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function equalToken(actual, expected) {
  const a = new TextEncoder().encode(actual || '');
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}

async function readBounded(stream, limit) {
  if (!stream) return '';
  const reader = stream.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new HttpError(413, 'Conteúdo excede o limite permitido.');
      chunks.push(value);
    }
  } catch (error) { reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

const when = at => Number.isFinite(at) ? new Date(at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : null;
const hoursAgo = (at, now) => Number.isFinite(at) ? Math.max(0, Math.round((now - at) / HOUR * 10) / 10) : null;

function describe(entry, now) {
  const item = { codigo: entry.id, fase: PHASE_LABEL[entry.phase], entrou_em: when(entry.addedAt), horas_no_piloto: hoursAgo(entry.addedAt, now),
    ultima_atividade: when(entry.updatedAt), expira_em: when(entry.addedAt + ENTRY_TTL) };
  if (entry.sendStatus) Object.assign(item, { cobrado_em: when(entry.sentAt), horas_desde_cobranca: hoursAgo(entry.sentAt, now),
    envio: entry.sendStatus === 'sent' ? 'enviado' : 'possivelmente enviado (não confirmado)' });
  if (entry.autoAsks) item.cobrancas_automaticas = entry.autoAsks;
  if (entry.failures) item.tentativas_sem_leitura = entry.failures;
  if (entry.phase === 'review') {
    item.nomes_sugeridos = (entry.review?.names || []).map(name => name.quantity ? `${name.name} (${name.quantity})` : name.name);
    item.motivo = entry.review?.reason || 'Sem detalhe guardado. Use "Trazer para revisão" no Lápis.';
  }
  if (entry.phase === 'failed') item.motivo = `Conversa não encontrada no Duoke em ${MAX_FAILURES} ciclos seguidos.`;
  if (entry.phase === 'pending' && entry.lastStatus === 'not_found') item.observacao = 'Conversa lida, cliente ainda não mandou o nome.';
  return item;
}

const TOOLS = [
  { name: 'resumo_piloto', title: 'Resumo do piloto do Lápis',
    description: 'Situação atual do piloto contínuo de nomes para lápis (Sticker Studio): quantos pedidos estão a ler, aguardando o cliente mandar o nome, para revisar e sem leitura, mais o pedido mais antigo e a última atividade. Pedidos que já foram para a fila de impressão não aparecem.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'listar_pedidos', title: 'Listar pedidos do piloto',
    description: 'Lista pedidos do piloto contínuo. Sem fase, traz todos começando pelos que precisam do operador (para_revisar, depois sem_leitura). Para revisão, inclui os nomes sugeridos pela IA e o motivo da dúvida.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      fase: { type: 'string', enum: Object.values(PHASE_LABEL), description: 'Filtra por fase.' },
      limite: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Máximo de pedidos na resposta.' } } } },
  { name: 'consultar_pedido', title: 'Consultar um pedido',
    description: 'Situação de um pedido da Shopee no piloto contínuo pelo código (ex.: 2611135XBM2J42). Se não estiver no piloto, ele já foi para a fila de impressão, expirou após 7 dias ou nunca entrou.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['codigo'], properties: {
      codigo: { type: 'string', minLength: 1, maxLength: 80, description: 'Código do pedido Shopee.' } } } },
].map(tool => ({ ...tool, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }));

class ToolInputError extends Error {}

async function runTool(name, args, { store, now }) {
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) throw new ToolInputError('Argumentos inválidos.');
  args = args || {};
  let rows;
  try { rows = await store.load(); } catch { return { error: 'Não foi possível ler o estado do piloto no Supabase agora. Tente de novo em instantes.' }; }
  const entries = rows.map(row => normalizeEntry(row, now)).filter(Boolean);
  if (name === 'resumo_piloto') {
    const counts = Object.fromEntries(Object.values(PHASE_LABEL).map(label => [label, 0]));
    for (const entry of entries) counts[PHASE_LABEL[entry.phase]]++;
    const oldest = entries.filter(entry => entry.phase !== 'failed').sort((a, b) => a.addedAt - b.addedAt)[0];
    const latest = Math.max(...entries.map(entry => entry.updatedAt));
    return { total: entries.length, por_fase: counts,
      precisam_do_operador: counts.para_revisar + counts.sem_leitura,
      aguardando_ha_mais_de_24h: entries.filter(entry => entry.phase === 'awaiting' && entry.sentAt && now - entry.sentAt > 24 * HOUR).length,
      pedido_mais_antigo: oldest ? describe(oldest, now) : null,
      ultima_atividade: entries.length ? when(latest) : null,
      cobrancas_automaticas_enviadas: entries.reduce((sum, entry) => sum + entry.autoAsks, 0),
      observacao: 'Pedidos que foram para a fila de impressão saem do piloto. Última atividade é a última mudança registrada em algum pedido.' };
  }
  if (name === 'listar_pedidos') {
    if (args.fase !== undefined && !PHASE_BY_LABEL[args.fase]) throw new ToolInputError(`fase deve ser uma de: ${Object.values(PHASE_LABEL).join(', ')}.`);
    if (args.limite !== undefined && !(Number.isInteger(args.limite) && args.limite >= 1 && args.limite <= 100)) throw new ToolInputError('limite deve ser um inteiro de 1 a 100.');
    const limit = args.limite || 20;
    const chosen = entries.filter(entry => !args.fase || entry.phase === PHASE_BY_LABEL[args.fase])
      .sort((a, b) => PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase] || a.addedAt - b.addedAt);
    return { total: chosen.length, mostrando: Math.min(limit, chosen.length), pedidos: chosen.slice(0, limit).map(entry => describe(entry, now)) };
  }
  if (name === 'consultar_pedido') {
    const code = typeof args.codigo === 'string' ? args.codigo.trim().replace(/^#\s*/u, '').toUpperCase() : '';
    if (!ID_PATTERN.test(code)) throw new ToolInputError('codigo inválido: use só letras, números, _ ou -.');
    const entry = entries.find(item => item.id.toUpperCase() === code);
    return entry ? { encontrado: true, pedido: describe(entry, now) }
      : { encontrado: false, codigo: code, mensagem: 'Pedido não está no piloto: já foi para a fila de impressão, expirou após 7 dias ou nunca entrou no piloto.' };
  }
  throw new ToolInputError(`Ferramenta desconhecida: ${name}.`);
}

/** env: plain object or (name)=>string. store: { load() } or null when not configured. */
export function createMcpHandler({ env = {}, store = null, now = () => Date.now() } = {}) {
  const get = name => typeof env === 'function' ? env(name) : env[name];
  return async function handler(request) {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    const reply = (status, data, extra = {}) => new Response(data === null ? null : JSON.stringify(data), {
      status, headers: { ...headers, ...extra, ...(data === null ? {} : { 'Content-Type': 'application/json; charset=utf-8' }) } });
    const rpcError = (id, code, message) => reply(200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
    try {
      // Agents call from servers. A browser Origin is only accepted if explicitly listed (DNS rebinding protection).
      const origin = request.headers.get('origin');
      if (origin) {
        const allowed = String(get('LAPIS_MCP_ALLOWED_ORIGINS') || '').split(',').map(value => value.trim()).filter(Boolean);
        if (!allowed.includes(origin)) throw new HttpError(403, 'Origem não autorizada.');
      }
      const token = get('LAPIS_MCP_TOKEN');
      if (typeof token !== 'string' || token.trim().length < 32 || token.length > 512) throw new HttpError(503, 'MCP do Lápis não configurado. Defina LAPIS_MCP_TOKEN com pelo menos 32 caracteres.');
      const auth = request.headers.get('authorization') || '';
      const supplied = /^Bearer\s+(.+)$/iu.exec(auth)?.[1]?.trim();
      if (!supplied || supplied.length > 512 || !equalToken(supplied, token.trim())) {
        return reply(401, { error: 'Token inválido.' }, { 'WWW-Authenticate': 'Bearer realm="lapis-mcp"' });
      }
      if (request.method !== 'POST') return reply(405, { error: 'Use POST (Streamable HTTP sem stream do servidor).' }, { Allow: 'POST' });
      if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get('content-type') || '')) throw new HttpError(415, 'Envie conteúdo JSON.');
      const declared = request.headers.get('content-length');
      if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_MCP_BYTES)) throw new HttpError(413, 'Conteúdo excede o limite permitido.');
      let message;
      try { message = JSON.parse(await readBounded(request.body, MAX_MCP_BYTES)); }
      catch (error) { if (error instanceof HttpError) throw error; return rpcError(null, -32700, 'JSON inválido.'); }
      if (Array.isArray(message)) return rpcError(null, -32600, 'Lotes JSON-RPC não são suportados.');
      if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        // Responses or malformed objects sent by the client: nothing to answer.
        if (message && message.jsonrpc === '2.0' && message.method === undefined && ('result' in message || 'error' in message)) return reply(202, null);
        return rpcError(message?.id, -32600, 'Requisição JSON-RPC inválida.');
      }
      const { id, method, params } = message;
      if (id === undefined || id === null) return reply(202, null); // Notifications (e.g. notifications/initialized).
      if (!['string', 'number'].includes(typeof id)) return rpcError(null, -32600, 'id JSON-RPC inválido.');
      const ok = result => reply(200, { jsonrpc: '2.0', id, result });
      if (method === 'initialize') {
        const requested = params?.protocolVersion;
        return ok({ protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'lapis-mcp', title: 'Lápis · Sticker Studio', version: '1.0.0' },
          instructions: 'Consulta somente leitura do piloto contínuo de nomes para lápis (pedidos Shopee). Use resumo_piloto para a visão geral, listar_pedidos com fase=para_revisar para o que precisa do operador e consultar_pedido para um código. Não há ferramentas que alterem pedidos ou enviem mensagens.' });
      }
      if (method === 'ping') return ok({});
      if (method === 'tools/list') return ok({ tools: TOOLS });
      if (method === 'tools/call') {
        const name = params?.name;
        if (!TOOLS.some(tool => tool.name === name)) return rpcError(id, -32602, `Ferramenta desconhecida: ${String(name).slice(0, 60)}.`);
        if (!store) return ok({ isError: true, content: [{ type: 'text', text: 'O armazenamento do piloto não está configurado nesta função.' }] });
        let data;
        try { data = await runTool(name, params.arguments, { store, now: now() }); }
        catch (error) { if (error instanceof ToolInputError) return ok({ isError: true, content: [{ type: 'text', text: error.message }] }); throw error; }
        if (data.error) return ok({ isError: true, content: [{ type: 'text', text: data.error }] });
        return ok({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data });
      }
      return rpcError(id, -32601, `Método não suportado: ${method.slice(0, 60)}.`);
    } catch (error) {
      return reply(error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'Falha interna no MCP do Lápis.' });
    }
  };
}
