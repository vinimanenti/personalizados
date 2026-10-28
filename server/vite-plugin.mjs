import { loadEnv } from 'vite';
import { Readable } from 'node:stream';
import Anthropic from '@anthropic-ai/sdk';
import { createGeminiHandler } from './gemini.mjs';

function localQuota(env) {
  let day = '', minute = '', dailyUsed = 0, minuteUsed = 0;
  const daily = Number(env.STICKER_AI_DAILY_LIMIT || 200);
  const perMinute = Number(env.STICKER_AI_MINUTE_LIMIT || 20);
  return async ({ orders }) => {
    if (!Number.isSafeInteger(daily) || daily < 1 || !Number.isSafeInteger(perMinute) || perMinute < 1) throw new Error('Invalid quota configuration');
    const now = new Date().toISOString();
    if (day !== now.slice(0, 10)) { day = now.slice(0, 10); dailyUsed = 0; }
    if (minute !== now.slice(0, 16)) { minute = now.slice(0, 16); minuteUsed = 0; }
    if (dailyUsed + orders > daily || minuteUsed + orders > perMinute) return false;
    dailyUsed += orders; minuteUsed += orders; return true;
  };
}

/** Vite development server only: secrets never enter define/import.meta.env. */
export function lapisGeminiPlugin() {
  let handler;
  let base = '/';
  return {
    name: 'sticker-lapis-gemini', apply: 'serve',
    configResolved(config) {
      const loaded = loadEnv(config.mode, config.envDir || config.root, '');
      const names = ['GEMINI_API_KEY', 'GEMINI_MODEL', 'CLAUDE_MODEL', 'STICKER_AI_ACCESS_CODE', 'STICKER_ALLOWED_ORIGINS', 'STICKER_AI_DAILY_LIMIT', 'STICKER_AI_MINUTE_LIMIT'];
      const env = Object.fromEntries(names.map(name => [name, process.env[name] ?? loaded[name]]));
      env.STICKER_ALLOWED_ORIGINS ||= 'http://localhost:3000,http://127.0.0.1:3000';
      // Claude is the optional second attempt; without a key only Gemini runs.
      const anthropicKey = (process.env.ANTHROPIC_API_KEY ?? loaded.ANTHROPIC_API_KEY)?.trim();
      const claudeClient = anthropicKey ? new Anthropic({ apiKey: anthropicKey, maxRetries: 1, timeout: 35000 }) : null;
      handler = createGeminiHandler({ env, consumeQuota: localQuota(env), claudeClient });
      base = config.base.startsWith('/') ? config.base : '/';
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = String(req.url || '').split('?')[0];
        // Supports middleware before or after Vite strips the deployment base.
        if (path !== '/api/lapis/extract' && path !== `${base.replace(/\/$/u, '')}/api/lapis/extract`) return next();
        const controller = new AbortController();
        const onClose = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', onClose);
        try {
          const headers = new Headers();
          for (const [name, value] of Object.entries(req.headers)) {
            if (Array.isArray(value)) headers.set(name, value.join(', '));
            else if (value !== undefined) headers.set(name, value);
          }
          const method = req.method || 'GET';
          const request = new Request('http://localhost:3000/api/lapis/extract', { method, headers, signal: controller.signal,
            ...(method === 'GET' || method === 'HEAD' ? {} : { body: Readable.toWeb(req), duplex: 'half' }) });
          const response = await handler(request);
          res.statusCode = response.status;
          for (const [name, value] of response.headers) res.setHeader(name, value);
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch {
          if (!res.headersSent) { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); }
          res.end(JSON.stringify({ error: 'Falha interna na extração.' }));
        } finally { res.off('close', onClose); }
      });
    },
  };
}
export default lapisGeminiPlugin;
