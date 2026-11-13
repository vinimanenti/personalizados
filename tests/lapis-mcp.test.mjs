import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler } from '../server/lapis-mcp.mjs';
import { createMemoryStore } from '../server/lapis-autopilot.mjs';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 13, 15, 0);
const TOKEN = 'mcp-test-token-0123456789abcdefghijklmnop';
const entry = (id, phase, extra = {}) => ({ id, phase, addedAt: NOW - 5 * HOUR, updatedAt: NOW - HOUR, autoAsks: 0, failures: 0, ...extra });
const rows = () => [
  entry('A1', 'pending', { lastStatus: 'not_found', addedAt: NOW - 30 * HOUR }),
  entry('W1', 'awaiting', { sendStatus: 'sent', sentAt: NOW - 26 * HOUR, autoAsks: 1 }),
  entry('R1', 'review', { review: { names: [{ name: 'Ana', quantity: 50 }, { name: 'Bia', quantity: null }], reason: 'Quantidades diferentes' } }),
  entry('F1', 'failed', { failures: 3 }),
];
const call = (handler, body, headers = {}) => handler(new Request('https://x.supabase.co/functions/v1/lapis-mcp', { method: 'POST',
  headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body) }));
const make = (store = createMemoryStore(rows())) => createMcpHandler({ env: { LAPIS_MCP_TOKEN: TOKEN }, store, now: () => NOW });
const rpc = async (handler, method, params, id = 1) => (await (await call(handler, { jsonrpc: '2.0', id, method, params })).json());
const tool = async (handler, name, args) => (await rpc(handler, 'tools/call', { name, arguments: args })).result;

test('requires its own bearer token and rejects browser origins that were not allowed', async () => {
  const handler = make();
  for (const authorization of ['', 'Bearer wrong', `Basic ${TOKEN}`]) {
    const response = await call(handler, { jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization });
    assert.equal(response.status, 401); assert.match(response.headers.get('www-authenticate'), /Bearer/u);
  }
  assert.equal((await call(handler, { jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await createMcpHandler({ env: { LAPIS_MCP_TOKEN: 'short' } })(new Request('https://x/', { method: 'POST' }))).status, 503, 'weak token disables the server');
  assert.equal((await handler(new Request('https://x/', { headers: { authorization: `Bearer ${TOKEN}` } }))).status, 405, 'GET stream is not offered');
});

test('initialize negotiates the protocol, notifications get 202 and tools are read-only', async () => {
  const handler = make();
  const init = await rpc(handler, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-03-26'); assert.equal(init.result.serverInfo.name, 'lapis-mcp');
  assert.equal((await rpc(handler, 'initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-06-18');
  assert.equal((await call(handler, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const { tools } = (await rpc(handler, 'tools/list')).result;
  assert.deepEqual(tools.map(t => t.name), ['resumo_piloto', 'listar_pedidos', 'consultar_pedido']);
  assert.ok(tools.every(t => t.annotations.readOnlyHint && !t.annotations.destructiveHint));
  assert.equal((await rpc(handler, 'resources/list')).error.code, -32601);
  assert.equal((await (await call(handler, '[{"jsonrpc":"2.0","id":1,"method":"ping"}]')).json()).error.code, -32600);
  assert.equal((await (await call(handler, '{bad')).json()).error.code, -32700);
});

test('resumo_piloto counts phases and flags customers waiting more than 24 h', async () => {
  const data = (await tool(make(), 'resumo_piloto', {})).structuredContent;
  assert.deepEqual(data.por_fase, { a_ler: 1, aguardando_cliente: 1, para_revisar: 1, sem_leitura: 1 });
  assert.equal(data.precisam_do_operador, 2); assert.equal(data.aguardando_ha_mais_de_24h, 1);
  assert.equal(data.pedido_mais_antigo.codigo, 'A1'); assert.equal(data.cobrancas_automaticas_enviadas, 1);
  assert.match(data.ultima_atividade, /13\/11\/2026/u);
});

test('listar_pedidos puts the operator first and explains reviews with names and reason', async () => {
  const handler = make();
  const all = (await tool(handler, 'listar_pedidos', {})).structuredContent;
  assert.deepEqual(all.pedidos.map(p => p.codigo), ['R1', 'F1', 'W1', 'A1']);
  const review = (await tool(handler, 'listar_pedidos', { fase: 'para_revisar' })).structuredContent.pedidos[0];
  assert.deepEqual(review.nomes_sugeridos, ['Ana (50)', 'Bia']); assert.equal(review.motivo, 'Quantidades diferentes');
  assert.equal((await tool(handler, 'listar_pedidos', { limite: 1 })).structuredContent.pedidos.length, 1);
  const bad = await tool(handler, 'listar_pedidos', { fase: 'tudo' });
  assert.equal(bad.isError, true); assert.match(bad.content[0].text, /para_revisar/u);
  assert.equal((await tool(handler, 'listar_pedidos', { limite: 500 })).isError, true);
});

test('consultar_pedido finds a code case-insensitively and explains when it left the pilot', async () => {
  const handler = make();
  const found = (await tool(handler, 'consultar_pedido', { codigo: ' #w1 ' })).structuredContent;
  assert.equal(found.encontrado, true); assert.equal(found.pedido.envio, 'enviado'); assert.equal(found.pedido.horas_desde_cobranca, 26);
  const missing = (await tool(handler, 'consultar_pedido', { codigo: '2611135XBM2J42' })).structuredContent;
  assert.equal(missing.encontrado, false); assert.match(missing.mensagem, /fila de impressão/u);
  assert.equal((await tool(handler, 'consultar_pedido', { codigo: 'a b;c' })).isError, true);
  assert.equal((await rpc(handler, 'tools/call', { name: 'apagar_tudo', arguments: {} })).error.code, -32602);
});

test('a store failure is a tool error, never a crash or a leak', async () => {
  const handler = make({ load: async () => { throw new Error('secret db detail'); } });
  const result = await tool(handler, 'resumo_piloto', {});
  assert.equal(result.isError, true); assert.doesNotMatch(result.content[0].text, /secret/u);
  const unconfigured = await tool(createMcpHandler({ env: { LAPIS_MCP_TOKEN: TOKEN }, store: null }), 'resumo_piloto', {});
  assert.equal(unconfigured.isError, true);
});
