(() => {
  if (window.__stickerDuokeBridgeInstalled) return;
  window.__stickerDuokeBridgeInstalled = true;
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
  const pending = new Set();
  const publish = message => window.postMessage({ ...message, source: 'sticker-duoke', version: 1 }, location.origin);
  window.addEventListener('message', async event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.source !== 'sticker-studio' || message.version !== 1 || !validId(message.requestId)) return;
    if (!['STATUS', 'START', 'SEND', 'CANCEL'].includes(message.type)) return;
    if (message.type === 'CANCEL' && !validId(message.jobId)) return;
    if (message.type === 'START' && (!Array.isArray(message.codes) || !message.codes.length || message.codes.length > 200 || message.codes.some(code => typeof code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(code)))) { publish({ type: 'ERROR', requestId: message.requestId, error: 'Lista de pedidos inválida (máximo 200 códigos).' }); return; }
    if (message.type === 'SEND' && (!Array.isArray(message.codes) || !message.codes.length || message.codes.length > 100 || message.codes.some(code => typeof code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(code)) ||
        typeof message.message !== 'string' || !message.message.trim() || message.message.trim().length > 500)) { publish({ type: 'ERROR', requestId: message.requestId, error: 'Envio inválido (máximo 100 pedidos e 500 caracteres).' }); return; }
    pending.add(message.requestId);
    try {
      const response = await chrome.runtime.sendMessage({ channel: 'duoke-studio', type: message.type, requestId: message.requestId, ...(message.type === 'START' ? { codes: message.codes } : {}), ...(message.type === 'SEND' ? { codes: message.codes, message: message.message.trim() } : {}), ...(message.type === 'CANCEL' ? { jobId: message.jobId } : {}) });
      if (response?.type) { publish({ ...response, requestId: message.requestId }); pending.delete(message.requestId); }
    } catch {
      publish({ type: 'ERROR', requestId: message.requestId, error: 'A extensão foi desconectada. Conecte esta aba novamente pelo popup.' });
      pending.delete(message.requestId);
    }
  });
  chrome.runtime.onMessage.addListener(message => {
    if (message?.channel !== 'duoke-event' || !validId(message.requestId) || !pending.has(message.requestId) || !['PROGRESS', 'COMPLETE', 'ERROR'].includes(message.type)) return;
    const { channel, ...data } = message;
    publish(data);
    if (['COMPLETE', 'ERROR'].includes(message.type)) pending.delete(message.requestId);
  });
})();
