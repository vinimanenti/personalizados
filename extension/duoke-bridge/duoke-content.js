(() => {
  if (globalThis.__stickerDuokeCollectorInstalled) return;
  globalThis.__stickerDuokeCollectorInstalled = true;
  let job = null;
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.tab || message?.channel !== 'duoke-command' || location.origin !== 'https://web.duoke.com' || location.pathname !== '/' || !/^#\/dk\/main\/chat(?:[/?]|$)/.test(location.hash)) return;
    if (message.type === 'PING') { respond({ ok: true, busy: Boolean(job), jobId: job?.requestId || null }); return; }
    if (!validId(message.requestId)) { respond({ ok: false }); return; }
    if (message.type === 'CANCEL') {
      if (job?.requestId === message.requestId) job.controller.abort();
      respond({ ok: true }); return;
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
