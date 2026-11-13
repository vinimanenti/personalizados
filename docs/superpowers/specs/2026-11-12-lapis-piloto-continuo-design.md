# Lápis: piloto contínuo (Fase 1)

Pedido do usuário em 11/11/2026: transformar o fluxo do Lápis em agentes que trabalham sozinhos para os pedidos não acumularem. Fase 1 roda no próprio Studio, sem VPS. Fases seguintes: worker 24/7 em VPS com Playwright reaproveitando `collector.js` e `shared/`, e um agente (Hermes) no Telegram.

## Contrato

- Interruptor por computador (`localStorage` `ss_lapis_pilot_v1`): ligado, intervalo (10/15/30/60 min), cobrança automática, Telegram.
- Estado compartilhado no Supabase (`lapis_autopilot_state`), validado por `normalizeEntry` no navegador e no servidor. Fases: `pending`, `awaiting`, `review`, `failed`. Expiração de 7 dias desde a entrada.
- Ciclo: `cycleCodes` (pending + awaiting, até 200, mais antigos primeiro) → coleta → hash da conversa → `reusableResult` quando a última leitura foi `not_found` com o mesmo hash → extração do resto → `planAutopilot` → `applyCycle`.
- `auto` sai do estado; falha da fila vira `review`. `review` notifica uma vez na transição. `failed` só depois de 3 ciclos seguidos (`MAX_FAILURES`).
- Cobrança automática: no máximo 1 por pedido (`MAX_AUTO_ASKS`), com `planAsk` (24 h). Disparada só com a aba do Duoke livre.
- Telegram via função `lapis-autopilot` (`action: notify`), texto puro sem `parse_mode`, erros do Telegram nunca ecoados.
- Pedidos já nomeados na tela saem do ciclo como `review` (ou removidos se já estão na fila). Rascunho podado dos pedidos já enfileirados quando chega perto do limite de 500.

## Fora do escopo

Puxar pedidos novos do UpSeller automaticamente (depende da API privada do UpSeller), geração automática do PDF, respostas a dúvidas de clientes, execução sem navegador aberto.
