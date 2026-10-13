import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/duoke-bridge/collector.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context);
const { createCollector, deepQuery, hasExactCode } = context.StickerDuokeCollector;
const S = {
  result: '.search_result_item', fallback: "[class*='search_result']", message: '.msg_cont',
  notes: ".order_item_remark, .note_detail, [class*='remark'], [class*='note_detail']",
  header: "[data-order-id], [data-order-sn], .order_sn, .order_no, .order_number, .order_detail, .chat_header, .conversation_header, [class*='chat_header']",
  empty: ".el-empty, .search_no_result, [class*='no_result'], .el-table__empty-text",
  loading: '.el-loading-mask, [aria-busy="true"]', search: ".el-icon-search, [class*='search'] > i",
};
class Node {
  constructor(text = '', attrs = {}, children = []) { this.innerText = text; this.attrs = attrs; this.children = children; this.isConnected = true; this.css = { display: 'block', visibility: 'visible', backgroundColor: 'rgb(236, 238, 242)' }; this.clicks = 0; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  contains(node) { return this.children.includes(node) || this.children.some(child => child.contains(node)); }
  click() { this.clicks++; this.onClick?.(); }
  dispatchEvent() { return true; }
  closest() { return null; }
}
function fixture() {
  let time = 0;
  let scheduled = [];
  const routes = new Map();
  const root = { querySelectorAll: selector => routes.get(selector) || [], defaultView: { Event: class { constructor(type) { this.type = type; } }, getComputedStyle: node => node.css } };
  const input = new Node('', { placeholder: 'Clique duas vezes para pesquisar em massa' });
  const search = new Node();
  routes.set('input', [input]); routes.set(S.search, [search]);
  const set = (selector, nodes) => { for (const old of routes.get(selector) || []) if (!nodes.includes(old)) old.isConnected = false; routes.set(selector, nodes); };
  const after = (delay, fn) => scheduled.push({ at: time + delay, fn });
  const options = { timeout: 160, settle: 20, interval: 5, now: () => time, sleep: async ms => { time += ms; const due = scheduled.filter(item => item.at <= time); scheduled = scheduled.filter(item => item.at > time); for (const item of due) item.fn(); } };
  const collector = createCollector(root, options);
  function conversation(code, text, notes = []) { set(S.header, [new Node(`ID do Pedido: ${code}`)]); set(S.message, text ? [new Node(text)] : []); set(S.notes, notes.map(note => new Node(note))); }
  function result(code, callback = () => conversation(code, 'Etiquetas: José, 75 unidades.')) { const node = new Node(`Pedido ${code}`); node.onClick = callback; set(S.result, [node]); set(S.fallback, [node]); return node; }
  return { root, routes, set, after, options, collector, input, search, conversation, result, time: () => time };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('exact order code matching never accepts a substring', () => {
  assert.equal(hasExactCode('Pedido 260123ABC99', '260123ABC'), false);
  assert.equal(hasExactCode('ID do Pedido: 260123ABC', '260123ABC'), true);
});
test('traverses nested open shadow roots without duplicating nodes', () => {
  const target = new Node('Ana');
  const inner = { querySelectorAll: selector => selector === S.message ? [target] : [] };
  const host = new Node(); host.shadowRoot = inner;
  const outer = { querySelectorAll: selector => selector === '*' ? [host] : [] };
  const outerHost = new Node(); outerHost.shadowRoot = outer;
  const root = { querySelectorAll: selector => selector === '*' ? [outerHost] : [] };
  assert.deepEqual([...deepQuery(root, S.message)], [target]);
});
test('unchanged exact search result times out without clicking or collecting stale messages', async () => {
  const f = fixture();
  const old = f.result('260123ABC'); f.conversation('260123ABC', 'Nome antigo');
  const summary = await f.collector.run(['260123ABC']);
  assert.equal(old.clicks, 0); assert.equal(summary.orders[0].status, 'error'); assert.equal(summary.orders[0].text, '');
  assert.match(summary.orders[0].error, /resultado novo/);
});
test('fresh result waits for exact conversation and delayed messages, deduplicates notes and preserves accents/quantities', async () => {
  const f = fixture();
  f.conversation('OLD99999', 'Não coletar: nome antigo');
  f.search.onClick = () => f.after(10, () => f.result('260123ABC', () => {
    f.set(S.header, [new Node('Pedido 260123ABC')]);
    f.after(50, () => f.conversation('260123ABC', 'José Ávila — 75 unidades; Lívia — 75.', ['José Ávila — 75 unidades', 'José Ávila — 75 unidades']));
  }));
  const progress = [];
  const summary = await f.collector.run(['260123ABC'], { onProgress: event => progress.push(plain(event)) });
  assert.equal(summary.orders[0].status, 'collected');
  assert.match(summary.orders[0].text, /José Ávila — 75 unidades; Lívia — 75/);
  assert.doesNotMatch(summary.orders[0].text, /nome antigo/);
  assert.equal(summary.orders[0].text.match(/Observação:/g).length, 1);
  assert.ok(f.time() >= 80); assert.equal(progress[0].completed, 1);
});
test('matching header with unchanged messages cannot validate the previous conversation', async () => {
  const f = fixture(); f.conversation('OLD99999', 'Nome antigo');
  f.search.onClick = () => f.result('260123ABC', () => f.set(S.header, [new Node('Pedido 260123ABC')]));
  const summary = await f.collector.run(['260123ABC']);
  assert.equal(summary.orders[0].status, 'error'); assert.equal(summary.orders[0].text, '');
  assert.match(summary.orders[0].error, /confirmar a conversa/);
});
test('a broad header ancestor containing the search result cannot attribute a conversation', async () => {
  const f = fixture();
  f.search.onClick = () => {
    const result = f.result('260123ABC', () => f.set(S.message, [new Node('Nome que não deve ser coletado')]));
    f.set(S.header, [new Node('ID do Pedido: 260123ABC', { class: 'order_detail' }, [result])]);
  };
  const summary = await f.collector.run(['260123ABC']);
  assert.equal(summary.orders[0].status, 'error'); assert.equal(summary.orders[0].text, '');
});
test('one new message cannot validate mixed stale messages from the previous conversation', async () => {
  const f = fixture(); f.conversation('OLD99999', 'Nome antigo');
  const old = f.routes.get(S.message)[0];
  f.search.onClick = () => f.result('260123ABC', () => {
    f.set(S.header, [new Node('Pedido 260123ABC')]); f.set(S.message, [old, new Node('Carregando nome novo')]);
  });
  const summary = await f.collector.run(['260123ABC']);
  assert.equal(summary.orders[0].status, 'error'); assert.equal(summary.orders[0].text, '');
});
test('note-only conversation is collected after confirmed order and refreshed notes', async () => {
  const f = fixture();
  f.search.onClick = () => f.result('260123ABC', () => f.conversation('260123ABC', '', ['Etiquetas: João — 150 unidades']));
  const summary = await f.collector.run(['260123ABC']);
  assert.equal(summary.orders[0].status, 'collected'); assert.equal(summary.orders[0].text, 'Observação: Etiquetas: João — 150 unidades');
});
test('stale notes block collection even when message and header refresh', async () => {
  const f = fixture(); f.conversation('OLD99999', 'Nome antigo', ['Observação antiga']);
  f.search.onClick = () => f.result('260123ABC', () => {
    f.set(S.header, [new Node('Pedido 260123ABC')]); f.set(S.message, [new Node('Nome novo')]);
  });
  const summary = await f.collector.run(['260123ABC']);
  assert.equal(summary.orders[0].status, 'error'); assert.equal(summary.orders[0].text, '');
});
for (const ancestry of ['parent panel', 'shadow host']) {
  test(`hidden stale messages and notes under a ${ancestry} cannot block or contaminate collection`, async () => {
    const f = fixture();
    const hidden = new Node();
    const oldMessage = new Node('Nome antigo oculto');
    const oldNote = new Node('Observação antiga oculta');
    for (const node of [oldMessage, oldNote]) {
      if (ancestry === 'shadow host') node.getRootNode = () => ({ host: hidden });
      else node.parentElement = hidden;
    }
    f.set(S.message, [oldMessage]); f.set(S.notes, [oldNote]);
    f.search.onClick = () => f.result('260123ABC', () => {
      hidden.css.display = 'none';
      f.set(S.header, [new Node('Pedido 260123ABC')]);
      f.set(S.message, [oldMessage, new Node('Etiquetas: José — 75')]);
      f.set(S.notes, [oldNote, new Node('Lívia — 75')]);
    });
    const summary = await f.collector.run(['260123ABC']);
    assert.equal(summary.orders[0].status, 'collected');
    assert.equal(summary.orders[0].text, 'Etiquetas: José — 75\n\nObservação: Lívia — 75');
    assert.doesNotMatch(summary.orders[0].text, /antig/);
  });
}
test('native rendered visibility rejects skipped content even with visible computed display', () => {
  const f = fixture();
  const skipped = new Node('Nome fora do conteúdo renderizado');
  skipped.checkVisibility = () => false;
  f.set(S.message, [skipped, new Node('Etiquetas: Ana')]);
  assert.equal(f.collector.extractText(), 'Etiquetas: Ana');
});
test('new explicit no-result state differs from a search timeout', async () => {
  const f = fixture(); f.search.onClick = () => f.after(10, () => f.set(S.empty, [new Node('Nenhum resultado encontrado')]));
  const summary = await f.collector.run(['260123ABC']);
  assert.deepEqual(plain(summary.orders[0]), { id: '260123ABC', status: 'not_found', text: '' });
  const stale = fixture(); stale.set(S.empty, [new Node('Nenhum resultado encontrado')]);
  assert.equal((await stale.collector.run(['260123ABC'])).orders[0].status, 'error');
});
test('generic search group containing another order is never clicked', async () => {
  const f = fixture(); const group = new Node('260123ABC 260999XYZ');
  f.search.onClick = () => f.set(S.fallback, [group]);
  const summary = await f.collector.run(['260123ABC']);
  assert.equal(group.clicks, 0); assert.equal(summary.orders[0].status, 'error');
});
test('cancel while waiting ends without an error or stale result', async () => {
  const f = fixture(); const controller = new AbortController(); f.after(20, () => controller.abort());
  const summary = await f.collector.run(['260123ABC'], { signal: controller.signal });
  assert.equal(summary.cancelled, true); assert.equal(summary.completed, 0); assert.equal(summary.orders.length, 0);
});
test('cancellation preserves completed orders and never searches subsequent codes', async () => {
  const f = fixture(); const controller = new AbortController(); let searches = 0;
  f.search.onClick = () => { searches++; f.result(f.input.value); };
  const summary = await f.collector.run(['260123ABC', '260999XYZ'], { signal: controller.signal, onProgress: () => controller.abort() });
  assert.equal(summary.cancelled, true); assert.equal(summary.completed, 1); assert.equal(summary.total, 2); assert.equal(searches, 1);
  assert.equal(summary.orders[0].status, 'collected');
});
test('customer color filter excludes seller messages', async () => {
  const f = fixture(); const customer = new Node('Para as etiquetas: Ana'); const seller = new Node('Olá, Maria'); seller.css.backgroundColor = 'rgb(255, 255, 255)';
  f.set(S.message, [customer, seller]);
  assert.equal(f.collector.extractText(), 'Para as etiquetas: Ana');
});

const workerSource = await readFile(new URL('../extension/duoke-bridge/worker.js', import.meta.url), 'utf8');
function workerFixture({ savedJob = null, collectorJob = null } = {}) {
  let listener;
  let currentJob = collectorJob;
  const values = {
    studio: { tabId: 1, origin: 'https://vinimanenti.github.io' },
    duoke: { tabId: 2, origin: 'https://web.duoke.com' },
    ...(savedJob ? { activeJob: savedJob } : {}),
  };
  const tabs = new Map([[1, { id: 1, url: 'https://vinimanenti.github.io/personalizados/' }], [2, { id: 2, url: 'https://web.duoke.com/?lang=pt#/dk/main/chat' }], [3, { id: 3, url: 'https://example.com/personalizados/' }]]);
  const events = [];
  const injected = [];
  const chrome = {
    runtime: { id: 'extension-id', getURL: file => `chrome-extension://extension-id/${file}`, onMessage: { addListener: fn => { listener = fn; } } },
    storage: { session: {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in values).map(key => [key, structuredClone(values[key])])),
      set: async data => Object.assign(values, structuredClone(data)),
      remove: async key => { delete values[key]; },
    } },
    scripting: { executeScript: async options => { injected.push(options); } },
    tabs: {
      get: async id => { if (!tabs.has(id)) throw new Error('closed'); return tabs.get(id); },
      sendMessage: async (id, message) => {
        if (id === 1) { events.push(plain(message)); return {}; }
        if (id !== 2) throw new Error('unpaired');
        if (message.type === 'PING') return { ok: true, jobId: currentJob, busy: Boolean(currentJob) };
        if (message.type === 'START') { currentJob = message.requestId; return { ok: true }; }
        if (message.type === 'CANCEL') return { ok: true };
      },
      onRemoved: { addListener: () => {} },
    },
  };
  vm.runInNewContext(workerSource, { chrome, URL });
  const studio = { id: chrome.runtime.id, tab: { id: 1 }, frameId: 0, origin: values.studio.origin, url: tabs.get(1).url };
  const duoke = { id: chrome.runtime.id, tab: { id: 2 }, frameId: 0, origin: values.duoke.origin, url: tabs.get(2).url };
  const send = (message, sender = studio) => new Promise(resolve => listener(message, sender, resolve));
  return { send, studio, duoke, tabs, events, values, injected, popup: { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') } };
}
test('worker rejects unpaired tab, wrong origin, subframe and arbitrary commands', async () => {
  const f = workerFixture();
  const status = { channel: 'duoke-studio', requestId: 'status-1', type: 'STATUS' };
  for (const sender of [{ ...f.studio, tab: { id: 3 } }, { ...f.studio, origin: 'https://example.com' }, { ...f.studio, frameId: 1 }]) {
    assert.equal((await f.send(status, sender)).type, 'ERROR');
  }
  assert.equal((await f.send({ ...status, type: 'EXECUTE', script: 'anything' })).type, 'ERROR');
  assert.equal(f.injected.length, 0);
});
test('worker starts exact paired tab, persists job and checks cancellation jobId', async () => {
  const f = workerFixture();
  assert.deepEqual(plain(await f.send({ channel: 'duoke-studio', requestId: 'job-1', type: 'START', codes: ['260123ABC'] })), { accepted: true });
  assert.equal(f.values.activeJob.requestId, 'job-1');
  assert.equal((await f.send({ channel: 'duoke-studio', requestId: 'status-1', type: 'STATUS' })).busy, true);
  assert.equal((await f.send({ channel: 'duoke-studio', requestId: 'cancel-1', type: 'CANCEL', jobId: 'different' })).type, 'ERROR');
  assert.deepEqual(plain(await f.send({ channel: 'duoke-studio', requestId: 'cancel-2', type: 'CANCEL', jobId: 'job-1' })), { type: 'COMPLETE', cancelled: true, jobId: 'job-1' });
});
test('worker restores MV3 job metadata and relays only exact paired collector events', async () => {
  const f = workerFixture({ savedJob: { requestId: 'job-1', studioTabId: 1, codes: ['FIRST1', 'SECOND2'], completed: 1, seen: ['FIRST1'] }, collectorJob: 'job-1' });
  const event = { channel: 'duoke-collector', requestId: 'job-1', type: 'PROGRESS', completed: 2, order: { id: 'SECOND2', status: 'collected', text: 'João — 75' } };
  assert.equal((await f.send(event, { ...f.duoke, origin: 'https://example.com' })).ok, false);
  assert.equal((await f.send({ ...event, requestId: 'wrong-job' }, f.duoke)).ok, false);
  assert.equal((await f.send(event, f.duoke)).ok, true);
  assert.equal(f.values.activeJob.completed, 2); assert.equal(f.events.length, 1);
  assert.equal(f.events[0].requestId, 'job-1'); assert.equal(f.events[0].total, 2);
  assert.equal((await f.send(event, f.duoke)).ok, false, 'duplicate progress rejected');
  assert.equal((await f.send({ channel: 'duoke-collector', requestId: 'job-1', type: 'COMPLETE', cancelled: false }, f.duoke)).ok, true);
  assert.equal(f.values.activeJob, undefined); assert.equal(f.events[1].type, 'COMPLETE');
});
test('worker detects reloaded collector after suspension and reports loss without discarding frontend results', async () => {
  const f = workerFixture({ savedJob: { requestId: 'job-1', studioTabId: 1, codes: ['FIRST1', 'SECOND2'], completed: 1, seen: ['FIRST1'] } });
  const status = await f.send({ channel: 'duoke-studio', requestId: 'status-1', type: 'STATUS' });
  assert.equal(status.busy, false); assert.equal(f.values.activeJob, undefined);
  assert.equal(f.events[0].type, 'ERROR'); assert.equal(f.events[0].requestId, 'job-1');
  assert.match(f.events[0].error, /preservados/);
});
test('popup cannot inject into an unrelated origin and pairs Studio only on explicit popup command', async () => {
  const f = workerFixture();
  assert.equal((await f.send({ channel: 'duoke-popup', type: 'PAIR', tabId: 3 }, f.popup)).ok, false);
  assert.equal(f.injected.length, 0);
  assert.equal((await f.send({ channel: 'duoke-popup', type: 'PAIR', tabId: 1 }, f.studio)).ok, false);
  assert.equal((await f.send({ channel: 'duoke-popup', type: 'PAIR', tabId: 1 }, f.popup)).ok, true);
  assert.deepEqual(plain(f.injected[0]), { target: { tabId: 1 }, files: ['studio-bridge.js'] });
});

test('popup pairs the web Duoke chat with language query and injects the collector', async () => {
  const f = workerFixture();
  assert.deepEqual(plain(await f.send({ channel: 'duoke-popup', type: 'PAIR', tabId: 2 }, f.popup)), { ok: true, role: 'duoke' });
  assert.deepEqual(plain(f.injected[0]), { target: { tabId: 2 }, files: ['collector.js', 'duoke-content.js'] });
  assert.deepEqual(plain(f.values.duoke), { tabId: 2, origin: 'https://web.duoke.com' });
});

const rejectedDuokeUrls = [
  'https://classic.duoke.com/pt/index.html',
  'https://web.duoke.com/?lang=pt#/dk/main/orders',
  'https://web.duoke.com/?lang=pt#/dk/main/chatting',
  'https://web.duoke.com/?lang=pt',
  'https://web.duoke.com.example.org/?lang=pt#/dk/main/chat',
  'http://web.duoke.com/?lang=pt#/dk/main/chat',
];
test('pairing and connection status reject other domains and non-chat routes', async () => {
  for (const url of rejectedDuokeUrls) {
    const f = workerFixture();
    f.tabs.set(2, { id: 2, url });
    assert.equal((await f.send({ channel: 'duoke-popup', type: 'PAIR', tabId: 2 }, f.popup)).ok, false, url);
    assert.equal(f.injected.length, 0);
    assert.equal((await f.send({ channel: 'duoke-studio', requestId: 'status-1', type: 'STATUS' })).duokeConnected, false, url);
  }
});

test('content script accepts the web chat and stops responding after leaving its route', async () => {
  const contentSource = await readFile(new URL('../extension/duoke-bridge/duoke-content.js', import.meta.url), 'utf8');
  for (const url of ['https://web.duoke.com/?lang=pt#/dk/main/chat', 'https://web.duoke.com/?lang=pt#/dk/main/chat/?shop=demo']) {
    let listener, reply;
    const location = new URL(url);
    const chrome = { runtime: { id: 'extension-id', onMessage: { addListener: fn => { listener = fn; } } } };
    vm.runInNewContext(contentSource, { chrome, location });
    const ping = () => { reply = undefined; listener({ channel: 'duoke-command', type: 'PING' }, { id: chrome.runtime.id }, value => { reply = value; }); };
    ping(); assert.equal(reply.ok, true, url);
    for (const denied of rejectedDuokeUrls) { location.href = denied; ping(); assert.equal(reply, undefined, denied); }
  }
});

test('extension permissions only grant persistent access to the corrected web domain', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/duoke-bridge/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.host_permissions, ['https://web.duoke.com/*']);
});
