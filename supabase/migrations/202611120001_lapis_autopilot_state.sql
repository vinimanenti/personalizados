-- Continuous autopilot state of the Lápis panel: inbox, awaiting customers and
-- conversation hashes. Only the lapis-autopilot Edge Function (service role)
-- reads or writes it; entries are validated by shared/lapis-continuous.mjs.
create table if not exists public.lapis_autopilot_state (
  order_id text primary key check (order_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$'),
  entry jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists idx_lapis_autopilot_state_updated on public.lapis_autopilot_state(updated_at);
alter table public.lapis_autopilot_state enable row level security;
revoke all on table public.lapis_autopilot_state from public, anon, authenticated;
grant select, insert, update, delete on table public.lapis_autopilot_state to service_role;
