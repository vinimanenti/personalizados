// Browser client for the continuous autopilot backend (state + Telegram).

export function resolveAutopilotEndpoint(env = {}) {
  if (env.VITE_LAPIS_AUTOPILOT_URL?.trim()) return env.VITE_LAPIS_AUTOPILOT_URL.trim();
  if (env.DEV) return '/api/lapis/autopilot';
  if (env.VITE_SUPABASE_URL?.trim()) return `${env.VITE_SUPABASE_URL.trim().replace(/\/$/, '')}/functions/v1/lapis-autopilot`;
  return '/api/lapis/autopilot';
}

function failure(status, message) {
  if (status === 401 || status === 403) return 'Código de acesso não autorizado para o piloto automático.';
  if (status === 404 || status === 405) return 'A função lapis-autopilot não está publicada neste endereço.';
  return typeof message === 'string' && message.length < 300 ? message : 'O piloto automático não respondeu. Tente novamente.';
}

export function createAutopilotClient({ endpoint, accessCode, fetchImpl = (...args) => fetch(...args), timeoutMs = 20000 }) {
  const call = async body => {
    if (!accessCode?.trim()) throw new Error('Informe o código de acesso à extração para usar o piloto automático.');
    let response;
    try {
      response = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-sticker-access-code': accessCode.trim() },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch { throw new Error('Não foi possível conectar ao piloto automático. Confira sua conexão.'); }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(failure(response.status, data?.error));
    return data;
  };
  return {
    async load() {
      const data = await call({ action: 'load' });
      if (!Array.isArray(data?.entries)) throw new Error('O piloto automático retornou um estado inválido.');
      return data.entries;
    },
    // clientNow lets the server correct for this computer's clock.
    save: (entries, remove = []) => call({ action: 'save', entries, remove, clientNow: Date.now() }),
    notify: text => call({ action: 'notify', text }),
  };
}
