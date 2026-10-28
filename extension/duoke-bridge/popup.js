const button = document.getElementById('connect');
const status = document.getElementById('status');
async function refresh() {
  const response = await chrome.runtime.sendMessage({ channel: 'duoke-popup', type: 'PAIR_STATUS' });
  status.textContent = `Studio: ${response?.studio ? 'conectado' : 'abra e conecte'}\nDuoke: ${response?.duoke ? 'conectado' : 'abra e conecte'}`;
}
button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const response = await chrome.runtime.sendMessage({ channel: 'duoke-popup', type: 'PAIR', tabId: tab?.id });
    if (!response?.ok) throw new Error(response?.error || 'Não foi possível conectar esta aba.');
    await refresh();
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});
refresh().catch(() => { status.textContent = 'Abra novamente a extensão para conectar.'; });
