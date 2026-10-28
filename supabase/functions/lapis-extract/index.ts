// Bundle the same handler used by Vite; no credentials are sent to the browser.
import Anthropic from 'npm:@anthropic-ai/sdk@1.3.0';
import { createGeminiHandler } from '../../../server/gemini.mjs';

const env = (name: string) => Deno.env.get(name);

async function consumeQuota({ orders, signal }: { orders: number; signal: AbortSignal }): Promise<boolean> {
  const url = env('SUPABASE_URL');
  const serviceRole = env('SUPABASE_SERVICE_ROLE_KEY');
  const daily = Number(env('STICKER_AI_DAILY_LIMIT'));
  const minute = Number(env('STICKER_AI_MINUTE_LIMIT'));
  if (!url || !serviceRole || !Number.isSafeInteger(daily) || daily < 1 || daily > 1_000_000 ||
      !Number.isSafeInteger(minute) || minute < 1 || minute > 100_000) throw new Error('Quota unavailable');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', 'kong'].includes(parsed.hostname))) {
    throw new Error('Quota unavailable');
  }
  const response = await fetch(`${url.replace(/\/$/u, '')}/rest/v1/rpc/consume_lapis_ai_quota`, {
    method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    headers: { 'Content-Type': 'application/json', apikey: serviceRole, Authorization: `Bearer ${serviceRole}` },
    body: JSON.stringify({ p_orders: orders, p_daily_limit: daily, p_minute_limit: minute }),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Quota unavailable'); }
  // A scalar RPC boolean is tiny. Reject unexpected types; never fail open.
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > 100) { await response.body?.cancel(); throw new Error('Quota unavailable'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Quota unavailable');
  let text = '', bytes = 0;
  try {
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 100) { await reader.cancel(); throw new Error('Quota unavailable'); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  const result = JSON.parse(text);
  if (typeof result !== 'boolean') throw new Error('Quota unavailable');
  return result;
}

// Claude is the optional second attempt; without ANTHROPIC_API_KEY only Gemini runs.
const anthropicKey = env('ANTHROPIC_API_KEY')?.trim();
const claudeClient = anthropicKey ? new Anthropic({ apiKey: anthropicKey, maxRetries: 1, timeout: 35000 }) : null;

Deno.serve(createGeminiHandler({ env, consumeQuota, claudeClient }));
