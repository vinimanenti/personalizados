const DUOKE_ORIGIN = 'https://web.duoke.com';
let activeJob = null;
const jobReady = chrome.storage.session.get('activeJob').then(({ activeJob: saved }) => {
  if (saved?.requestId && Array.isArray(saved.codes) && Number.isInteger(saved.studioTabId)) activeJob = { ...saved, seen: new Set(saved.seen || []) };
});
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const validCode = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
async function saveJob() {
  if (activeJob) await chrome.storage.session.set({ activeJob: { ...activeJob, seen: [...activeJob.seen] } });
  else await chrome.storage.session.remove('activeJob');
}
function roleForUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin === DUOKE_ORIGIN && url.pathname === '/' && /^#\/dk\/main\/chat(?:[/?]|$)/.test(url.hash)) return 'duoke';
    if ((url.origin === 'https://vinimanenti.github.io' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '3000')) && (url.pathname === '/personalizados' || url.pathname.startsWith('/personalizados/'))) return 'studio';
  } catch { /* Invalid URL. */ }
  return null;
}
async function getPair(role) {
  const data = await chrome.storage.session.get(role);
  const pair = data[role];
  if (!pair || !Number.isInteger(pair.tabId)) return null;
  try {
    const tab = await chrome.tabs.get(pair.tabId);
    if (roleForUrl(tab.url) !== role || new URL(tab.url).origin !== pair.origin) return null;
    return pair;
  } catch { return null; }
}
async function senderMatches(sender, role) {
  const pair = await getPair(role);
  return pair && sender.id === chrome.runtime.id && sender.tab?.id === pair.tabId && sender.frameId === 0 && sender.origin === pair.origin && roleForUrl(sender.url) === role ? pair : null;
}
async function deliver(studioTabId, event) {
  await chrome.tabs.sendMessage(studioTabId, { ...event, channel: 'duoke-event' });
}
async function reconcileJob() {
  if (!activeJob) return;
  const duoke = await getPair('duoke');
  let current = null;
  if (duoke) try { current = await chrome.tabs.sendMessage(duoke.tabId, { channel: 'duoke-command', type: 'PING' }); } catch { /* A reloaded tab has no collector. */ }
  if (!current?.ok || current.jobId !== activeJob.requestId) {
    const lost = activeJob;
    activeJob = null;
    await saveJob();
    await deliver(lost.studioTabId, { type: 'ERROR', requestId: lost.requestId, error: 'A coleta perdeu a conexão com o Duoke. Os pedidos concluídos foram preservados.' }).catch(() => {});
  }
}
async function handle(message, sender) {
  await jobReady;
  if (message?.channel === 'duoke-popup') {
    if (sender.tab || sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return { ok: false, error: 'Origem inválida.' };
    if (message.type === 'PAIR_STATUS') return { studio: Boolean(await getPair('studio')), duoke: Boolean(await getPair('duoke')) };
    if (message.type !== 'PAIR' || !Number.isInteger(message.tabId)) return { ok: false, error: 'Comando inválido.' };
    await reconcileJob();
    if (activeJob) return { ok: false, error: 'Cancele ou aguarde a coleta antes de conectar outra aba.' };
    const tab = await chrome.tabs.get(message.tabId);
    const role = roleForUrl(tab.url);
    if (!role) return { ok: false, error: 'Abra o Sticker Studio em /personalizados/ ou o chat em https://web.duoke.com/?lang=pt#/dk/main/chat.' };
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [role === 'studio' ? 'studio-bridge.js' : 'collector.js', ...(role === 'duoke' ? ['duoke-content.js'] : [])] });
    await chrome.storage.session.set({ [role]: { tabId: tab.id, origin: new URL(tab.url).origin } });
    return { ok: true, role };
  }
  if (message?.channel === 'duoke-collector') {
    if (!activeJob || !await senderMatches(sender, 'duoke') || message.requestId !== activeJob.requestId || !['PROGRESS', 'COMPLETE', 'ERROR'].includes(message.type)) return { ok: false };
    const studio = await getPair('studio');
    if (!studio || studio.tabId !== activeJob.studioTabId) return { ok: false };
    const event = { type: message.type, requestId: activeJob.requestId };
    if (message.type === 'PROGRESS') {
      const order = message.order;
      if (!order || !activeJob.codes.includes(order.id) || !['collected', 'not_found', 'error'].includes(order.status) || typeof order.text !== 'string' || order.text.length > 12000 || !Number.isInteger(message.completed) || message.completed !== activeJob.completed + 1 || activeJob.seen.has(order.id)) return { ok: false };
      activeJob.completed = message.completed;
      activeJob.seen.add(order.id);
      await saveJob();
      Object.assign(event, { completed: message.completed, total: activeJob.codes.length, order: { id: order.id, status: order.status, text: order.text, ...(typeof order.error === 'string' ? { error: order.error.slice(0, 300) } : {}) } });
    } else if (message.type === 'COMPLETE') Object.assign(event, { completed: activeJob.completed, total: activeJob.codes.length, cancelled: Boolean(message.cancelled) });
    else event.error = 'A coleta foi interrompida. Conecte as abas novamente.';
    if (message.type !== 'PROGRESS') { activeJob = null; await saveJob(); }
    await deliver(studio.tabId, event);
    return { ok: true };
  }
  if (message?.channel !== 'duoke-studio' || !validId(message.requestId) || !['STATUS', 'START', 'CANCEL'].includes(message.type)) return { type: 'ERROR', error: 'Comando inválido.' };
  const studio = await senderMatches(sender, 'studio');
  if (!studio) return { type: 'ERROR', error: 'Conecte esta aba do Studio pelo popup da extensão.' };
  await reconcileJob();
  const duoke = await getPair('duoke');
  if (message.type === 'STATUS') {
    let ready = false;
    if (duoke) try { ready = Boolean((await chrome.tabs.sendMessage(duoke.tabId, { channel: 'duoke-command', type: 'PING' }))?.ok); } catch { /* Reloaded tab needs pairing. */ }
    return { type: 'STATUS', connected: true, duokeConnected: ready, busy: Boolean(activeJob) };
  }
  if (message.type === 'CANCEL') {
    if (!validId(message.jobId) || !activeJob || message.jobId !== activeJob.requestId || activeJob.studioTabId !== studio.tabId) return { type: 'ERROR', error: 'Trabalho de coleta não está ativo.' };
    if (!duoke) return { type: 'ERROR', error: 'A aba Duoke foi desconectada.' };
    await chrome.tabs.sendMessage(duoke.tabId, { channel: 'duoke-command', type: 'CANCEL', requestId: activeJob.requestId });
    return { type: 'COMPLETE', cancelled: true, jobId: message.jobId };
  }
  if (!duoke) return { type: 'ERROR', error: 'Conecte a aba Duoke pelo popup da extensão.' };
  if (activeJob) return { type: 'ERROR', error: 'Já existe uma coleta em andamento.' };
  if (!Array.isArray(message.codes) || !message.codes.length || message.codes.length > 200 || message.codes.some(code => !validCode(code))) return { type: 'ERROR', error: 'Lista de pedidos inválida (máximo 200 códigos).' };
  activeJob = { requestId: message.requestId, studioTabId: studio.tabId, codes: [...new Set(message.codes)], completed: 0, seen: new Set() };
  await saveJob();
  try {
    const accepted = await chrome.tabs.sendMessage(duoke.tabId, { channel: 'duoke-command', type: 'START', requestId: message.requestId, codes: activeJob.codes });
    if (!accepted?.ok) throw new Error('Collector not ready');
    return { accepted: true };
  } catch {
    activeJob = null;
    await saveJob();
    return { type: 'ERROR', error: 'A aba Duoke foi recarregada ou desconectada. Conecte-a novamente.' };
  }
}
let commandQueue = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  commandQueue = commandQueue.then(() => handle(message, sender)).then(respond).catch(() => respond({ type: 'ERROR', error: 'Não foi possível acessar as abas. Conecte-as novamente.' }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  jobReady.then(() => chrome.storage.session.get(['studio', 'duoke'])).then(async pairs => {
    if (activeJob && tabId === activeJob.studioTabId) {
      const duoke = await getPair('duoke');
      if (duoke) await chrome.tabs.sendMessage(duoke.tabId, { channel: 'duoke-command', type: 'CANCEL', requestId: activeJob.requestId }).catch(() => {});
      activeJob = null;
      await saveJob();
    }
    for (const role of ['studio', 'duoke']) if (pairs[role]?.tabId === tabId) {
      await chrome.storage.session.remove(role);
      if (role === 'duoke' && activeJob) {
        const job = activeJob;
        activeJob = null;
        await saveJob();
        deliver(job.studioTabId, { type: 'ERROR', requestId: job.requestId, error: 'A aba Duoke foi fechada. Os pedidos já coletados foram preservados.' }).catch(() => {});
      }
    }
  });
});
