import { readFile } from 'node:fs/promises';
import { loadEnv } from 'vite';
import { createGeminiHandler } from '../server/gemini.mjs';

const env = { ...loadEnv('production', process.cwd(), ''), ...process.env };
const origin = 'https://vinimanenti.github.io';
const mode = process.argv[2] || 'status';
const payload = { orders: [{ id: 'DIAGNOSIS_TEST', status: 'collected', text: 'Nome para as etiquetas: Ana Exemplo.' }] };
const emit = value => console.log(JSON.stringify(value));
const safeMessage = value => {
  let text = typeof value === 'string' ? value : '';
  for (const [name, secret] of Object.entries(env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|ACCESS_CODE/i.test(name) && typeof secret === 'string' && secret) text = text.split(secret).join('[redacted]');
  }
  return text.slice(0, 400);
};
const summary = async response => {
  const body = await response.json().catch(() => null);
  return { status: response.status, error: safeMessage(body?.error), orders: body?.orders?.map(order => ({ id: order.id, status: order.status, names: order.names?.map(entry => entry.name) })) };
};

if (mode === 'status') {
  emit({ config: { geminiKeyPresent: Boolean(env.GEMINI_API_KEY), accessCodePresent: Boolean(env.STICKER_AI_ACCESS_CODE), supabaseTokenPresent: Boolean(env.SUPABASE_ACCESS_TOKEN), model: env.GEMINI_MODEL || '(default)', dailyLimit: env.STICKER_AI_DAILY_LIMIT || '(default)', minuteLimit: env.STICKER_AI_MINUTE_LIMIT || '(default)' } });
  try {
    const linked = JSON.parse(await readFile('supabase/.temp/linked-project.json', 'utf8'));
    emit({ linkedProject: linked.id || linked.ref || linked.project_ref, linkedName: linked.name });
  } catch { emit({ linkedProject: false }); }
  try {
    const response = await fetch(`${origin}/personalizados/`, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
    const html = await response.text();
    const script = /<script[^>]*src="([^"]+)"/.exec(html)?.[1];
    if (!script) { emit({ siteStatus: response.status, hasScript: false }); process.exit(0); }
    const scriptUrl = new URL(script, response.url);
    const main = await (await fetch(scriptUrl, { signal: AbortSignal.timeout(15000) })).text();
    const printFile = /(?:\.\/)?PrintLab-[A-Za-z0-9_-]+\.js/.exec(main)?.[0];
    const print = printFile ? await (await fetch(new URL(printFile, scriptUrl), { signal: AbortSignal.timeout(15000) })).text() : '';
    emit({ siteStatus: response.status, script: scriptUrl.pathname, printBundle: printFile, automaticBatchPublished: print.includes('Coletar e extrair'), genericErrorInFrontend: (main + print).includes('recusou a solicitação') });
  } catch (error) { emit({ siteFetchError: error.cause?.code || error.name }); }
} else if (mode === 'remote') {
  if (!env.STICKER_AI_ACCESS_CODE) { emit({ skipped: 'No local extraction access code' }); process.exit(0); }
  const base = env.VITE_SUPABASE_URL;
  if (!base || !/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(base)) throw new Error('Expected configured Supabase destination');
  const response = await fetch(`${base.replace(/\/$/, '')}/functions/v1/lapis-extract`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'x-sticker-access-code': env.STICKER_AI_ACCESS_CODE },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(70000),
  });
  emit({ remote: await summary(response) });
} else if (mode === 'local') {
  if (!env.GEMINI_API_KEY || !env.STICKER_AI_ACCESS_CODE) { emit({ skipped: 'Missing local test configuration' }); process.exit(0); }
  const handler = createGeminiHandler({ env: { ...env, STICKER_ALLOWED_ORIGINS: origin } });
  const response = await handler(new Request('https://local.test/extract', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'x-sticker-access-code': env.STICKER_AI_ACCESS_CODE }, body: JSON.stringify(payload) }));
  emit({ local: await summary(response) });
}
