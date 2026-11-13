// Same handler as the Vite dev server; Supabase injects SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY. Telegram credentials are optional secrets.
import { createAutopilotHandler, createRestStore } from '../../../server/lapis-autopilot.mjs';

const env = (name: string) => Deno.env.get(name);
const store = createRestStore({ url: env('SUPABASE_URL') || '', serviceRole: env('SUPABASE_SERVICE_ROLE_KEY') || '' });

Deno.serve(createAutopilotHandler({ env, store }));
