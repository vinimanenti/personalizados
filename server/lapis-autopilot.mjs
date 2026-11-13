import { MAX_NOTIFY_CHARS, MAX_STATE_ENTRIES, normalizeEntry, entryProblem, shiftEntryTimes, ENTRY_TTL } from '../shared/lapis-continuous.mjs';

// Continuous-autopilot backend shared by the Vite dev server and the Supabase Edge
// Function: stores the pilot state and relays the summary to Telegram. Same access
// code and Origin allowlist as lapis-extract; secrets never reach the browser.

// 1000 entries of up to ~1.5 KB each (review names included).
export const MAX_AUTOPILOT_BYTES = 1_600_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function equalCode(actual, expected) {
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

/** Pilot state in Supabase through PostgREST, with the service role (Edge Function or local .env only). */
export function createRestStore({ url, serviceRole, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  if (typeof url !== 'string' || !url || typeof serviceRole !== 'string' || !serviceRole) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', 'kong'].includes(parsed.hostname))) return null;
  const base = `${url.replace(/\/$/u, '')}/rest/v1/lapis_autopilot_state`;
  const headers = { apikey: serviceRole, Authorization: `Bearer ${serviceRole}`, 'Content-Type': 'application/json' };
  const call = async (path, options = {}) => {
    const response = await fetchImpl(`${base}${path}`, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Store HTTP ${response.status}`); }
    return response;
  };
  return {
    async load() {
      const rows = await (await call(`?select=entry&limit=${MAX_STATE_ENTRIES}`)).json();
      return Array.isArray(rows) ? rows.map(row => row?.entry) : [];
    },
    async save(entries, remove) {
      if (entries.length) await call('?on_conflict=order_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(entries.map(entry => ({ order_id: entry.id, entry, updated_at: new Date().toISOString() }))) });
      // IDs are validated against ID_PATTERN, so they are safe inside the in.() filter.
      for (let i = 0; i < remove.length; i += 100) {
        await call(`?order_id=in.(${remove.slice(i, i + 100).join(',')})`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      }
    },
  };
}

/** In-memory store (tests, or a dev server without Supabase credentials). */
export function createMemoryStore(initial = []) {
  const rows = new Map(initial.map(entry => [entry.id, entry]));
  return {
    rows,
    async load() { return [...rows.values()]; },
    async save(entries, remove) { for (const entry of entries) rows.set(entry.id, entry); for (const id of remove) rows.delete(id); },
  };
}

/** env: plain object or (name)=>string. store: { load(), save(entries, removeIds) } or null when not configured. */
export function createAutopilotHandler({ env = {}, store = null, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const get = name => typeof env === 'function' ? env(name) : env[name];
  return async function handler(request) {
    const origin = request.headers.get('origin');
    const cors = { 'Vary': 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    const reply = (status, data) => new Response(data === null ? null : JSON.stringify(data), {
      status, headers: { ...cors, ...(data === null ? {} : { 'Content-Type': 'application/json; charset=utf-8' }) },
    });
    try {
      const allowed = String(get('STICKER_ALLOWED_ORIGINS') || '').split(',').map(value => value.trim()).filter(Boolean);
      if (!allowed.length || allowed.some(value => {
        try { const url = new URL(value); return !['https:', 'http:'].includes(url.protocol) || url.origin !== value; }
        catch { return true; }
      })) throw new HttpError(503, 'Piloto automático não configurado.');
      if (!origin || !allowed.includes(origin)) throw new HttpError(403, 'Origem não autorizada.');
      cors['Access-Control-Allow-Origin'] = origin;
      if (request.method === 'OPTIONS') {
        if (request.headers.get('access-control-request-method') !== 'POST') throw new HttpError(405, 'Método não permitido.');
        cors['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
        cors['Access-Control-Allow-Headers'] = 'content-type, x-sticker-access-code, apikey, authorization';
        cors['Access-Control-Max-Age'] = '600';
        return reply(204, null);
      }
      if (request.method !== 'POST') throw new HttpError(405, 'Método não permitido.');
      const accessCode = get('STICKER_AI_ACCESS_CODE');
      if (typeof accessCode !== 'string' || !accessCode.trim() || accessCode.length > 256) throw new HttpError(503, 'Piloto automático não configurado.');
      const supplied = request.headers.get('x-sticker-access-code');
      if (!supplied || supplied.length > 256 || !equalCode(supplied, accessCode)) throw new HttpError(401, 'Código de acesso inválido.');
      if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get('content-type') || '')) throw new HttpError(415, 'Envie conteúdo JSON.');
      const declared = request.headers.get('content-length');
      if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_AUTOPILOT_BYTES)) throw new HttpError(413, 'Conteúdo excede o limite permitido.');
      let body;
      try { body = JSON.parse(await readBounded(request.body, MAX_AUTOPILOT_BYTES)); }
      catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'JSON inválido.'); }

      if (body?.action === 'load' || body?.action === 'save') {
        if (!store) throw new HttpError(503, 'O armazenamento do piloto não está configurado. Rode a migração e publique a função lapis-autopilot.');
        if (body.action === 'load') {
          let rows;
          try { rows = await store.load(); } catch { throw new HttpError(502, 'Não foi possível ler o estado do piloto.'); }
          const at = now();
          return reply(200, { entries: rows.map(row => normalizeEntry(row, at)).filter(Boolean) });
        }
        const entries = Array.isArray(body.entries) ? body.entries : [];
        const remove = Array.isArray(body.remove) ? body.remove : [];
        if (entries.length > MAX_STATE_ENTRIES || remove.length > MAX_STATE_ENTRIES) throw new HttpError(400, 'Estado do piloto acima do limite.');
        const at = now();
        // The browser stamps entries with its own clock; a computer running ahead of the
        // server would otherwise see every new entry rejected as "in the future".
        const skew = Number.isFinite(body.clientNow) ? at - body.clientNow : 0;
        const offset = Math.abs(skew) > 60000 && Math.abs(skew) < ENTRY_TTL ? skew : 0;
        const shifted = entries.map(entry => shiftEntryTimes(entry, offset));
        const clean = shifted.map(entry => normalizeEntry(entry, at));
        const bad = clean.findIndex(entry => !entry);
        if (bad >= 0) {
          const id = typeof shifted[bad]?.id === 'string' ? shifted[bad].id.slice(0, 40) : '?';
          throw new HttpError(400, `Estado do piloto inválido: pedido ${id} — ${entryProblem(shifted[bad], at) || 'dados inválidos'}.`);
        }
        if (remove.some(id => typeof id !== 'string' || !ID_PATTERN.test(id))) throw new HttpError(400, 'Pedido inválido na remoção.');
        try { await store.save(clean, [...new Set(remove)].filter(id => !clean.some(entry => entry.id === id))); }
        catch { throw new HttpError(502, 'Não foi possível gravar o estado do piloto.'); }
        return reply(200, { ok: true });
      }

      if (body?.action === 'notify') {
        const token = get('TELEGRAM_BOT_TOKEN'), chat = get('TELEGRAM_CHAT_ID');
        if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]{20,100}$/u.test(token.trim()) || typeof chat !== 'string' || !/^-?\d{1,20}$/u.test(chat.trim())) {
          throw new HttpError(503, 'Telegram não configurado. Defina TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID.');
        }
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > MAX_NOTIFY_CHARS) throw new HttpError(400, 'Mensagem inválida.');
        let response;
        try {
          // No parse_mode: customer text is sent literally and cannot format or inject links.
          response = await fetchImpl(`https://api.telegram.org/bot${token.trim()}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
            body: JSON.stringify({ chat_id: chat.trim(), text: body.text, disable_web_page_preview: true }),
          });
        } catch { throw new HttpError(502, 'Não foi possível acessar o Telegram.'); }
        await response.body?.cancel().catch(() => {});
        // The Telegram error body can echo the request; never return it.
        if (response.status === 401 || response.status === 404) throw new HttpError(502, 'O Telegram recusou o token. Confira TELEGRAM_BOT_TOKEN.');
        if (response.status === 400 || response.status === 403) throw new HttpError(502, 'O Telegram recusou o chat. Confira TELEGRAM_CHAT_ID e se você já mandou /start para o bot.');
        if (!response.ok) throw new HttpError(502, 'O Telegram está indisponível. A notificação não foi enviada.');
        return reply(200, { ok: true });
      }

      throw new HttpError(400, 'Ação desconhecida.');
    } catch (error) {
      return reply(error instanceof HttpError ? error.status : 500,
        { error: error instanceof HttpError ? error.message : 'Falha interna no piloto automático.' });
    }
  };
}
