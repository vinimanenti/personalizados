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
  notes: '.note_detail .note_content .pre_wrap',
  header: "[data-order-id], [data-order-sn], .order_item .order_item_title, .order_sn, .order_no, .order_number, .order_detail, .chat_header, .conversation_header, [class*='chat_header']",
  empty: ".result_empty, .el-empty, .search_no_result, [class*='no_result'], .el-table__empty-text",
  loading: '.el-loading-mask, [aria-busy="true"], .chat_search_bar .el-icon-loading',
  messageLoading: '.message_main > .t_c .el-icon-loading',
  mode: '.chat_search_bar .el-select input', input: '.chat_search_bar .input_with_select input',
  option: '.el-select-dropdown__item', links: '.search_result_item_info_name a[title]',
};
class Node {
  constructor(text = '', attrs = {}, children = []) { this.innerText = text; this.attrs = attrs; this.children = children; this.isConnected = true; this.css = { display: 'block', visibility: 'visible', backgroundColor: 'rgb(236, 238, 242)' }; this.clicks = 0; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  contains(node) { return this.children.includes(node) || this.children.some(child => child.contains(node)); }
  click() { this.clicks++; this.onClick?.(); }
  dispatchEvent(event) { this.onEvent?.(event); return true; }
  focus() { this.focused = true; }
  querySelectorAll(selector) { return this.routes?.get(selector) || []; }
  closest(selector) { return this.ancestors?.get(selector) || null; }
}
function fixture() {
  let time = 0;
  let scheduled = [];
  const routes = new Map();
  class Event { constructor(type, options) { this.type = type; Object.assign(this, options); } }
  const root = { querySelectorAll: selector => routes.get(selector) || [], defaultView: { Event, KeyboardEvent: Event, getComputedStyle: node => node.css } };
  const input = new Node('', { placeholder: 'Clique duas vezes para pesquisar em massa' });
  const container = new Node(); container.routes = routes; container.open = false;
  container.classList = { contains: name => name === 'show_result' && container.open };
  const mode = new Node(); mode.value = 'Pedido';
  const option = new Node('Pedido'); option.css.display = 'none';
  mode.onClick = () => { option.css.display = 'block'; };
  option.onClick = () => { mode.value = 'Pedido'; option.css.display = 'none'; };
  routes.set('.chat_search_container', [container]); routes.set(S.mode, [mode]); routes.set(S.option, [option]); routes.set(S.input, [input]);
  // Existing scenarios model automatic results from typing; no search button exists.
  const search = { onClick: null };
  input.onEvent = event => {
    if (event.type !== 'input') return;
    if (!input.value) { container.open = false; return; }
    container.open = true;
    search.onClick?.();
  };
  const set = (selector, nodes) => { for (const old of routes.get(selector) || []) if (!nodes.includes(old)) old.isConnected = false; routes.set(selector, nodes); };
  const after = (delay, fn) => scheduled.push({ at: time + delay, fn });
  const options = { timeout: 160, settle: 20, interval: 5, now: () => time, sleep: async ms => { time += ms; const due = scheduled.filter(item => item.at <= time); scheduled = scheduled.filter(item => item.at > time); for (const item of due) item.fn(); } };
  const collector = createCollector(root, options);
  const currentCard = { querySelectorAll: selector => selector === '.order_item_title' ? routes.get(S.header) || [] : [] };
  function note(text, card = currentCard) { const node = new Node(text); node.ancestors = new Map([['.order_item', card]]); return node; }
  function conversation(code, text, notes = []) { set(S.header, [new Node(`ID do Pedido: ${code}`)]); set(S.message, text ? [new Node(text)] : []); set(S.notes, notes.map(text => note(text))); }
  function result(code, callback = () => conversation(code, 'Etiquetas: José, 75 unidades.')) { const node = new Node(`Pedido ${code}`); node.onClick = callback; set(S.result, [node]); set(S.fallback, [node]); container.open = true; return node; }
  return { root, routes, set, after, options, collector, input, search, container, mode, option, conversation, result, note, time: () => time };
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

test('selects Pedido before entering the code and clicks the automatic result without a search button', async () => {
  const f = fixture(); const actions = [];
  f.mode.value = 'Comprador';
  f.option.onClick = () => { actions.push('Pedido'); f.mode.value = 'Pedido'; };
  f.search.onClick = () => {
    actions.push(f.input.value);
    f.result(f.input.value, () => { actions.push('conversa'); f.conversation(f.input.value, 'Etiquetas: Ana'); });
  };
  const order = await f.collector.collectOrder('260123ABC');
  assert.equal(order.status, 'collected');
  assert.deepEqual(actions, ['Pedido', '260123ABC', 'conversa']);
  assert.equal(f.mode.clicks, 1); assert.equal(f.input.focused, true);
});

test('already selected Pedido is preserved and Enter is scoped to the input when typing has no result', async () => {
  const f = fixture(); const events = [];
  f.input.onEvent = event => {
    events.push(event.type);
    if (event.type === 'keyup') {
      assert.equal(event.key, 'Enter'); assert.equal(event.keyCode, 13);
      f.result(f.input.value);
    }
  };
  const collector = createCollector(f.root, { ...f.options, timeout: 650 });
  const order = await collector.collectOrder('260123ABC');
  assert.equal(order.status, 'collected'); assert.equal(f.mode.clicks, 0);
  assert.deepEqual(events, ['input', 'input', 'change', 'keyup']);
});

test('missing Pedido option stops before typing or clicking a result', async () => {
  const f = fixture(); f.mode.value = 'Rastreamento'; f.routes.set(S.option, []);
  const old = f.result('260123ABC');
  const summary = await f.collector.run(['260123ABC']);
  assert.equal(summary.orders[0].status, 'error'); assert.match(summary.orders[0].error, /Opção Pedido/);
  assert.equal(f.input.value, undefined); assert.equal(old.clicks, 0);
});

test('selecting a similarly named option cannot confirm Pedido', async () => {
  const f = fixture(); f.mode.value = 'Todos'; f.option.innerText = 'Produtos pedidos';
  const summary = await f.collector.run(['260123ABC']);
  assert.equal(summary.orders[0].status, 'error'); assert.equal(f.option.clicks, 0);
});

test('clicks the order row instead of its details link even with digits in the buyer name', async () => {
  const f = fixture(); const link = new Node('260123ABC', { title: '260123ABC' }); let row;
  f.search.onClick = () => {
    row = f.result('260123ABC'); row.innerText += ' cliente12345 loja67890';
    row.routes = new Map([[S.links, [link]]]);
  };
  const order = await f.collector.collectOrder('260123ABC');
  assert.equal(order.status, 'collected'); assert.equal(row.clicks, 1); assert.equal(link.clicks, 0);
});

test('does not click another order whose buyer name contains the requested code', async () => {
  const f = fixture(); let row;
  f.search.onClick = () => {
    row = f.result('260123ABC');
    row.routes = new Map([[S.links, [new Node('260999XYZ', { title: '260999XYZ' })]]]);
  };
  const summary = await f.collector.run(['260123ABC']);
  assert.equal(summary.orders[0].status, 'error'); assert.equal(row.clicks, 0);
});

test('search changes by the user stop collection before opening a conversation', async () => {
  const f = fixture(); f.search.onClick = () => f.after(10, () => { f.mode.value = 'Comprador'; });
  const summary = await f.collector.run(['260123ABC']);
  assert.equal(summary.orders[0].status, 'error'); assert.match(summary.orders[0].error, /mudou/);
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
      f.set(S.notes, [oldNote, f.note('Lívia — 75')]);
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
  const stale = fixture(); stale.set(S.empty, [new Node('Nenhum resultado encontrado')]); stale.container.open = true;
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

test('fixed note headings, unchanged seller bubbles and empty media do not block fresh customer text', async () => {
  const f = fixture();
  const seller = new Node('Mensagem automática da loja'); seller.css.backgroundColor = 'rgb(255, 255, 255)';
  const emptyMedia = new Node('');
  const fixedNoteHeading = new Node('Observação do vendedor\nObservação do pedido Duoke');
  f.set(S.message, [seller, emptyMedia]);
  f.set(".order_item_remark, .note_detail, [class*='remark'], [class*='note_detail']", [fixedNoteHeading]);
  f.search.onClick = () => f.result('260123ABC', () => {
    f.set(S.header, [new Node('260123ABC', { class: 'order_item_title' })]);
    f.set(S.message, [seller, emptyMedia, new Node('Etiquetas: Ana Clara')]);
  });
  const order = await f.collector.collectOrder('260123ABC');
  assert.equal(order.status, 'collected'); assert.equal(order.text, 'Etiquetas: Ana Clara');
});

test('only the requested order card contributes notes, even when other cards and unrelated notes are visible', async () => {
  const f = fixture();
  const otherCard = new Node(); otherCard.routes = new Map([['.order_item_title', [new Node('260999XYZ')]]]);
  const otherNote = f.note('Nome de outro pedido', otherCard);
  const unscopedNote = new Node('Nota sem pedido identificado');
  f.search.onClick = () => f.result('260123ABC', () => {
    f.conversation('260123ABC', 'Etiquetas: Ana');
    f.set(S.notes, [f.note('Ana Clara, 150 unidades'), otherNote, unscopedNote]);
  });
  const order = await f.collector.collectOrder('260123ABC');
  assert.equal(order.status, 'collected');
  assert.equal(order.text, 'Etiquetas: Ana\n\nObservação: Ana Clara, 150 unidades');
});

test('customer and seller positions take precedence over theme bubble colors', () => {
  const f = fixture();
  const customer = new Node('Para as etiquetas: João'); customer.css.backgroundColor = 'rgb(200, 200, 200)';
  customer.ancestors = new Map([['.message_main > li.lt', new Node()]]);
  const seller = new Node('Olá, Maria'); seller.ancestors = new Map([['.message_main > li.rt, .message_main > li.ct', new Node()]]);
  f.set(S.message, [customer, seller]);
  assert.equal(f.collector.extractText(), 'Para as etiquetas: João');
});

test('conversation has its own longer deadline without extending search time', async () => {
  const f = fixture();
  const collector = createCollector(f.root, { ...f.options, conversationTimeout: 400 });
  f.search.onClick = () => f.result('260123ABC', () => f.after(220, () => f.conversation('260123ABC', 'Etiquetas: Beatriz')));
  const order = await collector.collectOrder('260123ABC');
  assert.equal(order.status, 'collected'); assert.equal(order.text, 'Etiquetas: Beatriz');
  assert.ok(f.time() >= 490);
});

test('Duoke message-loading indicator prevents collecting an incomplete conversation', async () => {
  const f = fixture();
  f.search.onClick = () => f.result('260123ABC', () => {
    f.conversation('260123ABC', 'Etiquetas: Ana'); f.set(S.messageLoading, [new Node()]);
    f.after(80, () => { f.set(S.messageLoading, []); f.conversation('260123ABC', 'Etiquetas: Ana Clara'); });
  });
  const order = await f.collector.collectOrder('260123ABC');
  assert.equal(order.text, 'Etiquetas: Ana Clara'); assert.ok(f.time() >= 350);
});

test('timeout identifies whether the order header, customer text or content refresh is missing', async () => {
  for (const [state, expected] of [['header', /código do pedido no painel/], ['text', /mensagens do cliente ou notas com texto/], ['stale', /atualização das mensagens/]]) {
    const f = fixture();
    if (state === 'stale') f.conversation('OLD99999', 'Nome anterior');
    f.search.onClick = () => f.result('260123ABC', () => {
      if (state !== 'header') f.set(S.header, [new Node('260123ABC')]);
      if (state === 'header') f.set(S.message, [new Node('Não coletar sem identificação')]);
    });
    const summary = await f.collector.run(['260123ABC']);
    assert.equal(summary.orders[0].status, 'error'); assert.equal(summary.orders[0].text, '');
    assert.match(summary.orders[0].error, expected);
  }
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
  const commands = [];
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
        if (['START', 'SEND'].includes(message.type)) { currentJob = message.requestId; commands.push(plain(message)); return { ok: true }; }
        if (message.type === 'CANCEL') return { ok: true };
      },
      onRemoved: { addListener: () => {} },
    },
  };
  vm.runInNewContext(workerSource, { chrome, URL });
  const studio = { id: chrome.runtime.id, tab: { id: 1 }, frameId: 0, origin: values.studio.origin, url: tabs.get(1).url };
  const duoke = { id: chrome.runtime.id, tab: { id: 2 }, frameId: 0, origin: values.duoke.origin, url: tabs.get(2).url };
  const send = (message, sender = studio) => new Promise(resolve => listener(message, sender, resolve));
  return { send, studio, duoke, tabs, events, values, injected, commands, popup: { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') } };
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

test('content accepts the next batch while the previous COMPLETE acknowledgement is pending', async () => {
  const contentSource = await readFile(new URL('../extension/duoke-bridge/duoke-content.js', import.meta.url), 'utf8');
  let listener, finishFirst, releaseAcknowledgement;
  const runs = [], events = [];
  const chrome = { runtime: { id: 'extension-id', onMessage: { addListener: fn => { listener = fn; } },
    sendMessage: message => {
      events.push(message);
      if (message.type === 'COMPLETE') return new Promise(resolve => { releaseAcknowledgement = resolve; });
      return Promise.resolve({ ok: true });
    },
  } };
  const collector = { createCollector: () => ({ run: codes => {
    runs.push([...codes]);
    return new Promise(resolve => { if (runs.length === 1) finishFirst = resolve; });
  } }) };
  vm.runInNewContext(contentSource, { chrome, location: new URL('https://web.duoke.com/?lang=pt#/dk/main/chat'), document: {}, AbortController, StickerDuokeCollector: collector });
  const command = message => {
    let reply;
    listener({ channel: 'duoke-command', ...message }, { id: chrome.runtime.id }, value => { reply = value; });
    return reply;
  };
  assert.equal(command({ type: 'START', requestId: 'first', codes: ['A'] }).ok, true);
  assert.equal(command({ type: 'START', requestId: 'too-early', codes: ['B'] }).ok, false);
  finishFirst({ completed: 1, total: 1, cancelled: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events[0].type, 'COMPLETE');
  assert.equal(command({ type: 'PING' }).jobId, 'first', 'worker can still reconcile the finishing job');
  assert.equal(command({ type: 'START', requestId: 'second', codes: ['B'] }).ok, true);
  releaseAcknowledgement({ ok: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(command({ type: 'PING' }).jobId, 'second', 'old finally must not clear the next batch');
  assert.deepEqual(runs, [['A'], ['B']]);
});

const MSG = 'Olá! Qual nome vai nas etiquetas?';
function composer(f, { translated = false, draft = '', onSend } = {}) {
  const footer = new Node(); footer.routes = new Map(); footer.classList = { contains: () => false };
  const input = new Node(); input.value = draft;
  const icon = new Node(); const button = new Node(); icon.ancestors = new Map([['button', button]]);
  footer.routes.set('textarea.el-textarea__inner', [input]);
  footer.routes.set(translated ? '.icon_send02_chatbox' : '.icon_send_chatbox', [icon]);
  f.routes.set('.cont_footer', [footer]);
  const bubble = text => { const node = new Node(text); node.ancestors = new Map([['.message_main > li.rt', new Node()]]); f.set(S.message, [...(f.routes.get(S.message) || []), node]); };
  button.onClick = () => (onSend ? onSend(input.value, bubble) : bubble(`Loja\n${input.value}`));
  return { footer, input, button };
}
function sendFixture(extra) {
  const f = fixture();
  f.search.onClick = () => f.result(f.input.value, () => f.conversation(f.input.value, 'Comprei 150 etiquetas'));
  return { f, c: composer(f, extra) };
}

test('sends only after confirming the conversation and reports the shop bubble as sent', async () => {
  const { f, c } = sendFixture();
  const order = await f.collector.sendToOrder('260123ABC', MSG);
  assert.deepEqual(plain(order), { id: '260123ABC', status: 'sent' });
  assert.equal(c.button.clicks, 1); assert.equal(c.input.value, MSG);
});

test('a conversation for another order never receives the message', async () => {
  const f = fixture(); const c = composer(f);
  f.search.onClick = () => f.result(f.input.value, () => f.conversation('260999XYZ', 'Outro cliente'));
  const summary = await f.collector.send(['260123ABC'], MSG, { pause: async () => {} });
  assert.equal(summary.orders[0].status, 'failed'); assert.equal(c.button.clicks, 0); assert.equal(c.input.value, '');
});

test('a missing composer fails without clicking', async () => {
  const { f, c } = sendFixture();
  f.routes.set('.cont_footer', []);
  const order = await f.collector.sendToOrder('260123ABC', MSG);
  assert.equal(order.status, 'failed'); assert.equal(c.button.clicks, 0);
});

test('a translated send button and an operator draft are reported clearly', async () => {
  let { f, c } = sendFixture({ translated: true });
  assert.match((await f.collector.sendToOrder('260123ABC', MSG)).error, /tradução/); assert.equal(c.button.clicks, 0);
  ({ f, c } = sendFixture({ draft: 'rascunho' }));
  assert.match((await f.collector.sendToOrder('260123ABC', MSG)).error, /rascunho/); assert.equal(c.input.value, 'rascunho');
});

test('a message that never appears is unconfirmed, never failed', async () => {
  const { f, c } = sendFixture({ onSend: () => {} });
  const collector = createCollector(f.root, { ...f.options, sendTimeout: 100 });
  const order = await collector.sendToOrder('260123ABC', MSG);
  assert.equal(order.status, 'unconfirmed'); assert.equal(c.button.clicks, 1);
});

test('the conversation switching while typing aborts before the click', async () => {
  const { f, c } = sendFixture();
  c.input.onEvent = event => { if (event.type === 'input' && c.input.value) f.set(S.header, [new Node('ID do Pedido: 260999XYZ')]); };
  const order = await f.collector.sendToOrder('260123ABC', MSG);
  assert.equal(order.status, 'failed'); assert.equal(c.button.clicks, 0); assert.equal(c.input.value, '');
});

test('duplicate codes are sent once and cancellation stops the next sends', async () => {
  let { f, c } = sendFixture();
  let summary = await f.collector.send(['260123ABC', '260123ABC'], MSG, { pause: async () => {} });
  assert.equal(summary.total, 1); assert.equal(c.button.clicks, 1);
  ({ f, c } = sendFixture());
  const controller = new AbortController(); const pauses = [];
  summary = await f.collector.send(['260123ABC', '260456DEF', '260789GHI'], MSG, { signal: controller.signal, pause: async () => { pauses.push(1); },
    onProgress: async () => controller.abort() });
  assert.equal(summary.completed, 1); assert.equal(summary.cancelled, true); assert.equal(c.button.clicks, 1); assert.equal(pauses.length, 0);
});

test('rejects empty or oversized messages before touching Duoke', async () => {
  const { f, c } = sendFixture();
  await assert.rejects(f.collector.send(['260123ABC'], '   '));
  await assert.rejects(f.collector.send(['260123ABC'], 'a'.repeat(501)));
  assert.equal(c.button.clicks, 0); assert.equal(f.input.value, undefined);
});

test('worker forwards SEND with the confirmed text only and validates send progress', async () => {
  const f = workerFixture();
  const sendCommand = extra => f.send({ channel: 'duoke-studio', requestId: 'send-1', type: 'SEND', codes: ['260123ABC', '260456DEF'], message: '  Qual o nome?  ', ...extra });
  assert.equal((await sendCommand({ message: '   ' })).type, 'ERROR');
  assert.equal((await sendCommand({ message: 'a'.repeat(501) })).type, 'ERROR');
  assert.equal((await sendCommand({ codes: Array.from({ length: 101 }, (_, i) => `CODE${i}X`) })).type, 'ERROR');
  assert.equal(f.commands.length, 0);
  assert.deepEqual(plain(await sendCommand()), { accepted: true });
  assert.deepEqual(f.commands[0], { channel: 'duoke-command', type: 'SEND', requestId: 'send-1', codes: ['260123ABC', '260456DEF'], message: 'Qual o nome?' });
  assert.equal(f.values.activeJob.kind, 'send');
  assert.equal((await f.send({ channel: 'duoke-studio', requestId: 'job-2', type: 'START', codes: ['260789GHI'] })).type, 'ERROR', 'collection waits for the send job');
  const progress = (order, completed = 1) => f.send({ channel: 'duoke-collector', requestId: 'send-1', type: 'PROGRESS', completed, order }, f.duoke);
  assert.equal((await progress({ id: '260123ABC', status: 'collected', text: 'x' })).ok, false);
  assert.equal((await progress({ id: '260123ABC', status: 'sent' })).ok, true);
  assert.deepEqual(f.events[0].order, { id: '260123ABC', status: 'sent' });
  assert.equal((await progress({ id: '260456DEF', status: 'unconfirmed', error: 'Confira' }, 2)).ok, true);
  assert.equal((await f.send({ channel: 'duoke-collector', requestId: 'send-1', type: 'COMPLETE', cancelled: false }, f.duoke)).ok, true);
  assert.equal(f.values.activeJob, undefined);
});

test('content script runs SEND through the collector send method', async () => {
  const contentSource = await readFile(new URL('../extension/duoke-bridge/duoke-content.js', import.meta.url), 'utf8');
  let listener; const calls = [];
  const chrome = { runtime: { id: 'extension-id', onMessage: { addListener: fn => { listener = fn; } }, sendMessage: async () => ({ ok: true }) } };
  const collector = { createCollector: () => ({
    run: async () => { calls.push('run'); return { completed: 0, total: 0, cancelled: false }; },
    send: async (codes, message) => { calls.push(['send', [...codes], message]); return { completed: 1, total: 1, cancelled: false }; },
  }) };
  vm.runInNewContext(contentSource, { chrome, location: new URL('https://web.duoke.com/?lang=pt#/dk/main/chat'), document: {}, AbortController, StickerDuokeCollector: collector });
  const command = message => { let reply; listener({ channel: 'duoke-command', ...message }, { id: chrome.runtime.id }, value => { reply = value; }); return reply; };
  assert.equal(command({ type: 'SEND', requestId: 'bad', codes: ['260123ABC'], message: '' }).ok, false);
  assert.equal(command({ type: 'SEND', requestId: 'send-1', codes: ['260123ABC'], message: 'Qual o nome?' }).ok, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(plain(calls), [['send', ['260123ABC'], 'Qual o nome?']]);
});
