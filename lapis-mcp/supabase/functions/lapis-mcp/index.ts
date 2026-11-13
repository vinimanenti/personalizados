// Read-only MCP endpoint for agents (Hermes). Supabase injects SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY; LAPIS_MCP_TOKEN is a secret only the agent knows.
import { createRestStore } from '../../../server/lapis-autopilot.mjs';
import { createMcpHandler } from '../../../server/lapis-mcp.mjs';

const env = (name: string) => Deno.env.get(name);
const store = createRestStore({ url: env('SUPABASE_URL') || '', serviceRole: env('SUPABASE_SERVICE_ROLE_KEY') || '' });

Deno.serve(createMcpHandler({ env, store }));
