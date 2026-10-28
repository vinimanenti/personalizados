import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire } from 'node:module';
import vm from 'node:vm';

// Render the real React component with a restored 300-order draft. No production
// credentials, browser session, remote API or customer records are used.
const compiled = await build({ entryPoints: ['src/components/LapisImport.jsx'], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'], loader: { '.css': 'empty' }, define: { 'import.meta.env': '{}' }, logLevel: 'silent' });

test('300 restored orders render counters and only thirty review cards', () => {
  const collected = Array.from({ length: 300 }, (_, i) => ({ id: `ORDER${i}`, status: i < 10 ? 'not_found' : i < 20 ? 'error' : 'collected', text: i < 20 ? '' : 'Nome: Ana Exemplo' }));
  const results = Object.fromEntries(collected.slice(20, 40).map(order => [order.id, { id: order.id, names: [{ name: 'Ana Exemplo', quantity: null, evidence: order.text }], status: 'found', reason: '' }]));
  const draft = { codes: collected.map(order => order.id).join('\n'), raw: '', collected, results, selected: {}, reviewed: {}, shipDates: {}, extractionErrors: { ORDER40: 'Falha temporária' } };
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url), console, URL, setTimeout, clearTimeout,
    localStorage: { getItem: () => JSON.stringify({ user: 'test-only', ts: 1 }) },
    sessionStorage: { getItem: () => JSON.stringify({ version: 1, ts: Date.now(), draft }) },
  });
  const markup = renderToStaticMarkup(React.createElement(module.exports.default));
  assert.equal((markup.match(/<article/g) || []).length, 30);
  assert.match(markup, /Com nomes<strong>20<\/strong>/);
  assert.match(markup, /Sem nomes<strong>10<\/strong>/);
  assert.match(markup, /Falhas<strong>11<\/strong>/);
  assert.match(markup, /A extrair<strong>259<\/strong>/);
  assert.match(markup, /280 pedidos pendentes/);
  assert.match(markup, /1–30 de 300 pedidos/);
  assert.match(markup, /Baixar TXT completo/);
  assert.match(markup, /Refazer pendências · 21/);
  assert.match(markup, /Coletar e extrair/);
  assert.doesNotMatch(markup, /value="test-only"/);
});

test('ask panel lists only askable customers and awaiting orders show Verificar respostas', () => {
  const now = Date.now();
  const collected = ['ASK1', 'ASK2', 'ASKED3', 'NOTFOUND4', 'OK5'].map(id => ({ id, status: id === 'NOTFOUND4' ? 'not_found' : 'collected', text: id === 'NOTFOUND4' ? '' : 'Bom dia, comprei' }));
  const missing = id => ({ id, names: [], status: 'not_found', reason: '' });
  const results = { ASK1: missing('ASK1'), ASK2: missing('ASK2'), ASKED3: missing('ASKED3'),
    OK5: { id: 'OK5', names: [{ name: 'Ana', quantity: null, evidence: 'Ana' }], status: 'found', reason: '' } };
  const draft = { codes: '', raw: '', collected, results, selected: {}, reviewed: {}, shipDates: {}, extractionErrors: {} };
  const store = { ss_session: JSON.stringify({ user: 'test-only', ts: 1 }),
    'ss_lapis_awaiting_v1:test-only': JSON.stringify({ version: 1, awaiting: { ASKED3: { sentAt: now - 3600000, status: 'sent' }, OLD9: { sentAt: now - 7200000, status: 'unconfirmed' } } }),
    ss_lapis_ask_message_v1: 'Qual nome vai no lápis?', ss_lapis_access_code_v1: 'codigo-de-teste' };
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url), console, URL, setTimeout, clearTimeout,
    localStorage: { getItem: key => store[key] ?? null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => JSON.stringify({ version: 1, ts: Date.now(), draft }), setItem() {}, removeItem() {} },
  });
  const markup = renderToStaticMarkup(React.createElement(module.exports.default));
  assert.match(markup, /Cobrar nome<strong>2<\/strong>/);
  assert.match(markup, /Aguardando cliente<strong>1<\/strong>/);
  assert.match(markup, /2 clientes sem nome para cobrar/);
  assert.match(markup, /ASK1 · ASK2</);
  assert.doesNotMatch(markup, /ASKED3 ·|· ASKED3/);
  assert.match(markup, /Qual nome vai no lápis\?<\/textarea>/);
  assert.match(markup, /Enviar para 2 clientes<\/button>/);
  assert.match(markup, /2 clientes aguardando resposta/);
  assert.match(markup, /Verificar respostas · 2/);
  assert.match(markup, /Processar lote/);
  assert.match(markup, /type="password"[^>]*value="codigo-de-teste"/, 'remembered access code is restored');
});
