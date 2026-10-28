import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiHandler } from '../server/gemini.mjs';

// Fake SDK client and fake Gemini responses only; no network and no real keys.
const env = { GEMINI_API_KEY: 'test-key-not-a-real-secret', STICKER_AI_ACCESS_CODE: 'test-access-code', STICKER_ALLOWED_ORIGINS: 'http://localhost:3000' };
const source = { id: 'ABC123', status: 'collected', text: 'Observação: Nome: Augusto A. Stuepp' };
const extraction = { orders: [{ id: 'ABC123', status: 'found', reason: '', names: [{ name: 'Augusto A. Stuepp', quantity: null, evidence: 'Nome: Augusto A. Stuepp' }] }] };
const request = (headers = {}) => new Request('http://localhost:3000/api/lapis/extract', { method: 'POST',
  headers: { origin: 'http://localhost:3000', 'content-type': 'application/json', 'x-sticker-access-code': 'test-access-code', ...headers },
  body: JSON.stringify({ orders: [source] }) });
const geminiOk = payload => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(payload) }] } }] }));
const claudeMessage = (payload, stop_reason = 'end_turn') => ({ stop_reason, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(payload) }] });
function fakeClaude(reply) {
  const calls = [];
  return { calls, messages: { create: async (params, options) => { calls.push({ params, options }); return typeof reply === 'function' ? reply() : reply; } } };
}
const quiet = fn => async () => {
  const { warn, info } = console; console.warn = () => {}; console.info = () => {};
  try { await fn(); } finally { console.warn = warn; console.info = info; }
};

test('a Gemini network failure falls back to Claude with structured output', quiet(async () => {
  const claude = fakeClaude(claudeMessage(extraction));
  let quotas = 0;
  const handler = createGeminiHandler({ env, claudeClient: claude, consumeQuota: async () => { quotas++; return true; },
    fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } }); } });
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).orders[0].names[0].name, 'Augusto A. Stuepp');
  assert.equal(claude.calls.length, 1); assert.equal(quotas, 2, 'each provider attempt reserves quota');
  const { params, options } = claude.calls[0];
  assert.equal(params.model, 'claude-haiku-5-5');
  assert.equal(params.output_config.format.type, 'json_schema');
  assert.deepEqual(params.output_config.format.schema.properties.orders.items.properties.id.enum, ['ABC123']);
  assert.ok(options.signal instanceof AbortSignal);
  assert.ok(!JSON.stringify(params).includes('test-key'), 'the Gemini key never reaches Claude');
}));

test('Gemini capacity errors after the retry and invalid Gemini output fall back too', quiet(async () => {
  for (const fetchImpl of [async () => new Response('{}', { status: 503 }), async () => geminiOk({ orders: [] })]) {
    const claude = fakeClaude(claudeMessage(extraction));
    const handler = createGeminiHandler({ env, claudeClient: claude, fetchImpl, retryDelayMs: 0, consumeQuota: async () => true });
    assert.equal((await handler(request())).status, 200);
    assert.equal(claude.calls.length, 1);
  }
}));

test('a slow Gemini is cut at its own deadline so Claude can answer', quiet(async () => {
  const claude = fakeClaude(claudeMessage(extraction));
  const handler = createGeminiHandler({ env, claudeClient: claude, geminiTimeoutMs: 20, consumeQuota: async () => true,
    fetchImpl: (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))) });
  assert.equal((await handler(request())).status, 200);
  assert.equal(claude.calls.length, 1);
}));

test('a working Gemini never calls Claude', async () => {
  const claude = fakeClaude(claudeMessage(extraction));
  const handler = createGeminiHandler({ env, claudeClient: claude, fetchImpl: async () => geminiOk(extraction), consumeQuota: async () => true });
  assert.equal((await handler(request())).status, 200);
  assert.equal(claude.calls.length, 0);
});

test('access, origin and Lápis quota errors never fall back', quiet(async () => {
  const claude = fakeClaude(claudeMessage(extraction));
  const fetchImpl = async () => { throw new TypeError('fetch failed'); };
  const handler = createGeminiHandler({ env, claudeClient: claude, fetchImpl, consumeQuota: async () => true });
  assert.equal((await handler(request({ 'x-sticker-access-code': 'wrong' }))).status, 401);
  assert.equal((await handler(request({ origin: 'https://evil.example' }))).status, 403);
  const limited = createGeminiHandler({ env, claudeClient: claude, fetchImpl, consumeQuota: async () => false });
  assert.equal((await limited(request())).status, 429);
  assert.equal(claude.calls.length, 0);
}));

test('Claude results pass the same literal-evidence check', quiet(async () => {
  const invented = { orders: [{ id: 'ABC123', status: 'found', reason: '', names: [{ name: 'Maria', quantity: null, evidence: 'Nome: Maria' }] }] };
  const handler = createGeminiHandler({ env, claudeClient: fakeClaude(claudeMessage(invented)), consumeQuota: async () => true,
    fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  const response = await handler(request());
  assert.equal(response.status, 502); assert.match((await response.json()).error, /inválida ou incompleta/);
}));

test('Claude refusals and errors report that both providers failed', quiet(async () => {
  const failing = { messages: { create: async () => { throw Object.assign(new Error('overloaded'), { status: 529 }); } } };
  for (const claude of [failing, fakeClaude(claudeMessage(extraction, 'refusal'))]) {
    const handler = createGeminiHandler({ env, claudeClient: claude, consumeQuota: async () => true, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    const response = await handler(request());
    assert.equal(response.status, 502);
  }
  const both = createGeminiHandler({ env, claudeClient: failing, consumeQuota: async () => true, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.match((await (await both(request())).json()).error, /Gemini e o Claude falharam/);
}));

test('without a Claude client the Gemini error is returned as before', quiet(async () => {
  const handler = createGeminiHandler({ env, consumeQuota: async () => true, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  const response = await handler(request());
  assert.equal(response.status, 502); assert.equal((await response.json()).error, 'Não foi possível acessar o serviço de extração.');
}));
