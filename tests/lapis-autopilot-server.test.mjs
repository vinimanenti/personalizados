import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutopilotHandler, createMemoryStore, createRestStore } from '../server/lapis-autopilot.mjs';
import { createAutopilotClient, resolveAutopilotEndpoint } from '../src/lib/lapis-autopilot-api.mjs';

const NOW = 100 * 24 * 60 * 60 * 1000;
const env = { STICKER_AI_ACCESS_CODE: 'test-access-code', STICKER_ALLOWED_ORIGINS: 'http://localhost:3000',
  TELEGRAM_BOT_TOKEN: '123456:ABCdefGHIjklMNOpqrSTUvwxYZ_0123456789', TELEGRAM_CHAT_ID: '987654' };
const entry = id => ({ id, phase: 'pending', addedAt: NOW - 1000, updatedAt: NOW - 1000, autoAsks: 0, failures: 0 });
const request = (body, headers = {}) => new Request('http://localhost:3000/api/lapis/autopilot', { method: 'POST',
  headers: { origin: 'http://localhost:3000', 'content-type': 'application/json', 'x-sticker-access-code': 'test-access-code', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body) });

test('access code and Origin are enforced before touching the store or Telegram', async () => {
  let telegram = 0;
  const store = createMemoryStore([entry('A1')]);
  const handler = createAutopilotHandler({ env, store, now: () => NOW, fetchImpl: async () => { telegram++; return new Response('{}'); } });
  for (const code of ['', 'wrong']) assert.equal((await handler(request({ action: 'load' }, { 'x-sticker-access-code': code }))).status, 401);
  for (const origin of ['', 'https://evil.example']) assert.equal((await handler(request({ action: 'notify', text: 'x' }, { origin }))).status, 403);
  assert.equal(telegram, 0);
  assert.equal((await handler(request({ action: 'load' }))).status, 200);
});

test('save validates every entry and load returns only valid, unexpired entries', async () => {
  const store = createMemoryStore([entry('A1'), { id: 'OLD', phase: 'pending', addedAt: 1, updatedAt: 1 }]);
  const handler = createAutopilotHandler({ env, store, now: () => NOW });
  assert.deepEqual((await (await handler(request({ action: 'load' }))).json()).entries.map(e => e.id), ['A1']);
  assert.equal((await handler(request({ action: 'save', entries: [{ ...entry('B2'), phase: 'hack' }] }))).status, 400);
  assert.equal((await handler(request({ action: 'save', entries: [], remove: ['a,b'] }))).status, 400, 'ids are checked before reaching the in() filter');
  assert.equal((await handler(request({ action: 'save', entries: [entry('B2')], remove: ['A1'] }))).status, 200);
  assert.deepEqual([...store.rows.keys()].sort(), ['B2', 'OLD']);
});

test('without a store the state endpoints explain the missing setup', async () => {
  const response = await createAutopilotHandler({ env, store: null })(request({ action: 'load' }));
  assert.equal(response.status, 503); assert.match((await response.json()).error, /migração/u);
});

test('notify sends plain text to the configured chat and never echoes Telegram errors', async () => {
  let call;
  const ok = createAutopilotHandler({ env, fetchImpl: async (url, options) => { call = { url, body: JSON.parse(options.body) }; return new Response('{"ok":true}'); } });
  assert.equal((await ok(request({ action: 'notify', text: 'Lápis: 2 para revisar' }))).status, 200);
  assert.ok(call.url.startsWith('https://api.telegram.org/bot123456:'));
  assert.deepEqual(call.body, { chat_id: '987654', text: 'Lápis: 2 para revisar', disable_web_page_preview: true });
  const refused = createAutopilotHandler({ env, fetchImpl: async () => new Response('{"description":"secret detail"}', { status: 403 }) });
  const body = await (await refused(request({ action: 'notify', text: 'x' }))).json();
  assert.doesNotMatch(body.error, /secret/u); assert.match(body.error, /TELEGRAM_CHAT_ID/u);
  const unset = createAutopilotHandler({ env: { ...env, TELEGRAM_BOT_TOKEN: '' } });
  assert.equal((await unset(request({ action: 'notify', text: 'x' }))).status, 503);
  assert.equal((await ok(request({ action: 'notify', text: 'x'.repeat(3501) }))).status, 400);
});

test('REST store upserts by order and deletes with a validated in() filter', async () => {
  const calls = [];
  const store = createRestStore({ url: 'https://example.supabase.co/', serviceRole: 'service-test', fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method || 'GET', prefer: options.headers.Prefer, body: options.body });
    return new Response(options.method ? null : JSON.stringify([{ entry: entry('A1') }]), { status: options.method ? 201 : 200 });
  } });
  assert.deepEqual((await store.load()).map(e => e.id), ['A1']);
  await store.save([entry('B2')], ['A1', 'C3']);
  assert.equal(calls[1].url, 'https://example.supabase.co/rest/v1/lapis_autopilot_state?on_conflict=order_id');
  assert.match(calls[1].prefer, /merge-duplicates/u);
  assert.equal(JSON.parse(calls[1].body)[0].order_id, 'B2');
  assert.equal(calls[2].url, 'https://example.supabase.co/rest/v1/lapis_autopilot_state?order_id=in.(A1,C3)');
  assert.equal(createRestStore({ url: 'http://example.com', serviceRole: 'x' }), null, 'plain http only for local Supabase');
});

test('browser client resolves the endpoint and surfaces readable errors', async () => {
  assert.equal(resolveAutopilotEndpoint({ DEV: true }), '/api/lapis/autopilot');
  assert.equal(resolveAutopilotEndpoint({ VITE_SUPABASE_URL: 'https://x.supabase.co/' }), 'https://x.supabase.co/functions/v1/lapis-autopilot');
  const handler = createAutopilotHandler({ env, store: createMemoryStore([entry('A1')]), now: () => NOW });
  const client = createAutopilotClient({ endpoint: 'http://localhost:3000/api/lapis/autopilot', accessCode: 'test-access-code',
    fetchImpl: (url, options) => handler(new Request(url, { ...options, headers: { ...options.headers, origin: 'http://localhost:3000' } })) });
  assert.deepEqual((await client.load()).map(e => e.id), ['A1']);
  const denied = createAutopilotClient({ endpoint: '/x', accessCode: 'nope', fetchImpl: async () => Response.json({ error: 'x' }, { status: 401 }) });
  await assert.rejects(denied.load(), /não autorizado/u);
  await assert.rejects(createAutopilotClient({ endpoint: '/x', accessCode: '' }).load(), /código de acesso/u);
});

test('a computer clock running ahead is corrected and a rejected save names the order and the reason', async () => {
  const store = createMemoryStore([]);
  const handler = createAutopilotHandler({ env, store, now: () => NOW });
  const ahead = NOW + 10 * 60 * 1000;
  const fresh = { ...entry('F1'), addedAt: ahead, updatedAt: ahead };
  assert.equal((await handler(request({ action: 'save', entries: [fresh] }))).status, 400, 'without clientNow the future time is rejected');
  const refused = await (await handler(request({ action: 'save', entries: [fresh] }))).json();
  assert.match(refused.error, /pedido F1 — horário no futuro/u);
  assert.equal((await handler(request({ action: 'save', entries: [fresh], clientNow: ahead }))).status, 200);
  assert.equal(store.rows.get('F1').addedAt, NOW, 'stored in server time');
  const old = await (await handler(request({ action: 'save', entries: [{ ...entry('O1'), addedAt: NOW - 8 * 24 * 3600000 }] }))).json();
  assert.match(old.error, /pedido O1 — mais de 7 dias/u);
});

