import test from 'node:test';
import assert from 'node:assert/strict';
import { extractOrders, resolveLapisEndpoint, validateExtractionResponse } from '../src/lib/lapis-api.mjs';

const orders = Array.from({ length: 11 }, (_, index) => ({ id: `DEMO${index}`, status: 'collected', text: 'Nas etiquetas, colocar Ana Exemplo.' }));
const payload = source => ({ orders: source.map(({ id, text }) => ({ id, status: 'found', reason: '', names: [{ name: 'Ana Exemplo', quantity: null, evidence: text }] })) });

test('endpoint prefers explicit configuration and otherwise chooses development or Supabase', () => {
  assert.equal(resolveLapisEndpoint({ DEV: true, VITE_SUPABASE_URL: 'https://example.supabase.co' }), '/api/lapis/extract');
  assert.equal(resolveLapisEndpoint({ DEV: false, VITE_SUPABASE_URL: 'https://example.supabase.co/' }), 'https://example.supabase.co/functions/v1/lapis-extract');
  assert.equal(resolveLapisEndpoint({ DEV: true, VITE_LAPIS_API_URL: 'https://api.example.test/extract' }), 'https://api.example.test/extract');
});

test('sixteen conversations use two Gemini requests and apply each group together', async () => {
  const source = Array.from({ length: 16 }, (_, index) => ({ ...orders[0], id: `LOTE${index}` }));
  const requested = [], applied = [];
  const result = await extractOrders({ orders: source, accessCode: 'test-only', endpoint: '/extract',
    fetchImpl: async (_url, options) => {
      const chunk = JSON.parse(options.body).orders; requested.push(chunk.map(order => order.id));
      return Response.json(payload(chunk));
    },
    onChunk: (chunk, completed, total) => applied.push({ ids: chunk.map(order => order.id), completed, total }),
  });
  assert.deepEqual(requested.map(chunk => chunk.length), [10, 6]);
  assert.deepEqual(applied.map(chunk => [chunk.ids.length, chunk.completed, chunk.total]), [[10, 10, 16], [6, 16, 16]]);
  assert.deepEqual(result.map(order => order.id), source.map(order => order.id));
});

test('partial batches stay applied when a subsequent API call fails', async () => {
  const applied = []; let calls = 0;
  await assert.rejects(extractOrders({ orders, accessCode: 'test-only', endpoint: '/extract',
    onChunk: chunk => applied.push(...chunk), fetchImpl: async (_url, options) => {
      calls++;
      assert.equal(options.headers['x-sticker-access-code'], 'test-only');
      const body = JSON.parse(options.body);
      return calls === 1 ? Response.json(payload(body.orders)) : Response.json({ error: 'Unavailable' }, { status: 503 });
    } }), /configurado|indisponível/);
  assert.equal(calls, 2);
  assert.deepEqual(applied.map(order => order.id), orders.slice(0, 10).map(order => order.id));
});

test('cancelling after first batch retains it and prevents subsequent request', async () => {
  const controller = new AbortController(); const applied = []; let calls = 0;
  await assert.rejects(extractOrders({ orders, accessCode: 'test-only', endpoint: '/extract', signal: controller.signal,
    onChunk: chunk => { applied.push(...chunk); controller.abort(); },
    fetchImpl: async (_url, options) => { calls++; return Response.json(payload(JSON.parse(options.body).orders)); } }), { name: 'AbortError' });
  assert.equal(calls, 1); assert.equal(applied.length, 10);
});

test('invalid IDs and fabricated evidence never become applied extraction results', () => {
  for (const mutate of [body => { body.orders[0].id = 'UNKNOWN'; }, body => { body.orders = []; }, body => { body.orders[0].names[0].evidence = 'Fabricated name'; }]) {
    const body = payload(orders.slice(0, 1)); mutate(body);
    assert.throws(() => validateExtractionResponse(body, orders.slice(0, 1)));
  }
});

test('only the failed chunk is flagged; completed and unattempted chunks remain distinct', async () => {
  const source = Array.from({ length: 30 }, (_, i) => ({ ...orders[0], id: `P${i}` }));
  const applied = [], failed = []; let calls = 0;
  await assert.rejects(extractOrders({ orders: source, accessCode: 'test-only', endpoint: '/extract',
    onChunk: chunk => applied.push(...chunk.map(order => order.id)),
    onChunkError: (chunk, error) => { failed.push(...chunk.map(order => order.id)); assert.match(error.message, /limite/); },
    fetchImpl: async (_url, options) => ++calls === 1 ? Response.json(payload(JSON.parse(options.body).orders)) : Response.json({}, { status: 429 }),
  }), /limite/);
  assert.equal(calls, 2);
  assert.deepEqual(applied, source.slice(0, 10).map(order => order.id));
  assert.deepEqual(failed, source.slice(10, 20).map(order => order.id));
});

test('cancellation is not reported as a name or extraction failure', async () => {
  const controller = new AbortController(); let failures = 0;
  await assert.rejects(extractOrders({ orders, accessCode: 'test-only', endpoint: '/extract', signal: controller.signal,
    onChunkError: () => { failures++; }, fetchImpl: async () => { controller.abort(); throw new DOMException('Cancelled', 'AbortError'); },
  }), { name: 'AbortError' });
  assert.equal(failures, 0);
});
