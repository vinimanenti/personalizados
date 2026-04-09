-- Sticker Studio: Schema do banco de dados
-- Rodar no SQL Editor do Supabase (supabase.com > seu projeto > SQL Editor)

-- 1. Tabela de modelos (18 modelos com configs de fonte e calibração)
create table models (
  id text primary key,              -- MOD001, MOD002, etc.
  thumb_url text,                   -- URL da imagem de referência (Storage)
  svg_url text,                     -- URL do SVG no Storage (sem limite de tamanho)
  fields jsonb default '[]',        -- Campos detectados [{name, occurrences, positions}]
  max_width numeric default 3600,
  font_family text default 'DK Coal Brush',
  font_size numeric default 715.51,
  font_source text default 'default',
  glyph_map jsonb default '{}',
  default_adv integer default 504,
  text_centers jsonb default '{}',
  updated_at timestamptz default now()
);

-- 2. Tabela de pedidos (histórico completo)
create table orders (
  id uuid primary key default gen_random_uuid(),
  order_code text not null,          -- Código do pedido Shopee
  store text not null,               -- Loja (TR Etiquetas, etc.)
  model_id text references models(id),
  names text[] not null,             -- Array de nomes do pedido
  font_overrides jsonb default '{}', -- Overrides de fonte por índice
  sheets_count integer default 0,    -- Quantas cartelas geradas
  created_at timestamptz default now()
);

-- 3. Fila de impressão (persistente entre sessões)
create table print_queue (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders(id) on delete set null,
  model_id text references models(id),
  svg_data text not null,            -- SVG da cartela gerada
  label text,                        -- "MOD001 - Cartela 1"
  store text,
  order_code text,
  names text[],
  status text default 'pending' check (status in ('pending', 'printed', 'cancelled')),
  position integer default 0,        -- Ordem na fila
  created_at timestamptz default now(),
  printed_at timestamptz
);

-- Índices para queries comuns
create index idx_orders_store on orders(store);
create index idx_orders_created on orders(created_at desc);
create index idx_orders_code on orders(order_code);
create index idx_print_queue_status on print_queue(status);
create index idx_print_queue_position on print_queue(position);

-- Trigger para atualizar updated_at nos models
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger models_updated_at
  before update on models
  for each row execute function update_updated_at();

-- Inserir os 18 modelos vazios
insert into models (id) values
  ('MOD001'), ('MOD002'), ('MOD003'), ('MOD004'), ('MOD005'),
  ('MOD006'), ('MOD007'), ('MOD008'), ('MOD009'), ('MOD010'),
  ('MOD011'), ('MOD012'), ('MOD013'), ('MOD014'), ('MOD015'),
  ('MOD016'), ('MOD017'), ('MOD018');

-- Habilitar RLS (Row Level Security) - acesso público por enquanto
alter table models enable row level security;
alter table orders enable row level security;
alter table print_queue enable row level security;

-- Políticas de acesso público (sem auth por enquanto)
create policy "Public read models" on models for select using (true);
create policy "Public write models" on models for all using (true);

create policy "Public read orders" on orders for select using (true);
create policy "Public write orders" on orders for all using (true);

create policy "Public read print_queue" on print_queue for select using (true);
create policy "Public write print_queue" on print_queue for all using (true);

-- Storage bucket para SVGs e thumbnails
insert into storage.buckets (id, name, public) values ('stickers', 'stickers', true);

create policy "Public read stickers" on storage.objects for select using (bucket_id = 'stickers');
create policy "Public upload stickers" on storage.objects for insert with check (bucket_id = 'stickers');
create policy "Public update stickers" on storage.objects for update using (bucket_id = 'stickers');
create policy "Public delete stickers" on storage.objects for delete using (bucket_id = 'stickers');
