(() => {
  if (globalThis.__stickerDuokeCollectorInstalled) return;
  globalThis.__stickerDuokeCollectorInstalled = true;
  let job = null;
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.tab || message?.channel !== 'duoke-command' || !['https://ai.duoke.com', 'https://web.duoke.com'].includes(location.origin) || location.pathname !== '/' || !/^#\/dk\/main\/chat(?:[/?]|$)/.test(location.hash)) return;
    if (message.type === 'PING') { respond({ ok: true, busy: Boolean(job), jobId: job?.requestId || null }); return; }
    if (!validId(message.requestId)) { respond({ ok: false }); return; }
    if (message.type === 'CANCEL') {
      if (job?.requestId === message.requestId) job.controller.abort();
      respond({ ok: true }); return;
    }
    // "Conferir no Duoke": search the order and open its conversation for the operator.
    // Same search and confirmation as collection; nothing is sent.
    if (message.type === 'OPEN') {
      if (job && !job.finished) { respond({ ok: false, busy: true }); return; }
      if (typeof message.code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(message.code)) { respond({ ok: false }); return; }
      const openJob = { requestId: message.requestId, controller: new AbortController() };
      job = openJob;
      const timer = setTimeout(() => openJob.controller.abort(), 45000);
      globalThis.StickerDuokeCollector.createCollector(document).collectOrder(message.code, openJob.controller.signal)
        .then(order => respond({ ok: true, status: order.status, ...(typeof order.error === 'string' ? { error: order.error.slice(0, 300) } : {}) }))
        .catch(error => respond({ ok: true, status: 'error', error: String(error?.message || 'Não foi possível abrir a conversa.').slice(0, 300) }))
        .finally(() => { clearTimeout(timer); openJob.finished = true; if (job === openJob) job = null; });
      return true;
    }
    const sending = message.type === 'SEND';
    if (!['START', 'SEND'].includes(message.type) || (job && !job.finished) || !Array.isArray(message.codes) || !message.codes.length || message.codes.length > (sending ? 100 : 200) ||
      (sending && (typeof message.message !== 'string' || !message.message.trim() || message.message.length > 500)) || message.codes.some(code => typeof code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(code))) { respond({ ok: false }); return; }
    const currentJob = { requestId: message.requestId, controller: new AbortController() };
    job = currentJob;
    const send = data => chrome.runtime.sendMessage({ channel: 'duoke-collector', requestId: currentJob.requestId, ...data });
    respond({ ok: true });
    const collector = globalThis.StickerDuokeCollector.createCollector(document);
    const options = {
      signal: currentJob.controller.signal,
      onProgress: async progress => {
        const acknowledged = await send({ type: 'PROGRESS', ...progress });
        if (!acknowledged?.ok) currentJob.controller.abort();
      },
    };
    (sending ? collector.send(message.codes, message.message, options) : collector.run(message.codes, options)).then(summary => {
      // A new batch may START as soon as Studio receives COMPLETE.
      currentJob.finished = true;
      return send({ type: 'COMPLETE', completed: summary.completed, total: summary.total, cancelled: summary.cancelled });
    })
      .catch(() => {
        currentJob.finished = true;
        return send({ type: 'ERROR' }).catch(() => {});
      })
      .finally(() => { if (job === currentJob) job = null; });
  });
})();
