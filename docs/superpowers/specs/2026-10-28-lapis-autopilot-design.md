# Lápis: piloto automático e cobrança de nomes

Desenho apresentado e aprovado pelo usuário em 28/10/2026: processar o lote, aprovar sozinho os pedidos seguros, enviar à fila, cobrar no Duoke os clientes sem nome com confirmação em lote e verificar as respostas por um botão.

## Contrato do produto

- Um clique em **Processar lote** executa a coleta e a extração existentes (até 500 pedidos, coletas de 200, extrações de 10) e classifica cada pedido em um grupo: aprovado automaticamente, para revisar, cobrar nome ou falha.
- **Aprovado automaticamente** exige, ao mesmo tempo: status `found`; de 1 a 3 nomes; evidência literal de cada nome (já garantida por `normalizeExtraction`); `toLabelFields` sem erro; `reason` vazio; revisão ainda não presente na fila. Esses pedidos são enviados à fila por `onAddOrders` sem marcação manual. Gerar o PDF continua sendo um clique do operador.
- **Para revisar** recebe qualquer outro pedido com nomes ou com status `review`. O fluxo de revisão atual não muda.
- **Cobrar nome** recebe somente pedidos coletados (`collected`, com conversa) cuja extração retornou `not_found`. Pedidos não encontrados no Duoke, falhas de coleta e falhas de extração nunca são cobrados.
- A cobrança exige confirmação explícita: um painel mostra a quantidade, os códigos e o texto da mensagem; o envio só começa no clique em **Enviar para todos**. O texto é editável e salvo no navegador. Texto padrão: `Olá! Para personalizarmos seus lápis, pode nos enviar o nome que vai nas etiquetas? 😊`. Texto vazio ou acima de 500 caracteres bloqueia o envio.
- Antes de cada envio, a extensão abre a conversa pela busca por Pedido e confirma a correspondência com a mesma verificação da coleta. Depois preenche o campo do chat, aciona o envio e confirma que uma mensagem da loja com o texto exato apareceu na conversa.
- Estados de envio: `sent` (confirmado), `unconfirmed` (envio acionado sem confirmação), `failed` (nada foi enviado: pedido não encontrado, conversa não confirmada, campo ausente). Somente `failed` pode ser repetido pelo botão. `unconfirmed` nunca é reenviado automaticamente; o operador confere no Duoke.
- Intervalo aleatório de 2 a 4 segundos entre envios; até 100 envios por lote. Cancelar interrompe os próximos envios e preserva os estados recebidos.
- Um pedido com `sent` ou `unconfirmed` nas últimas 24 horas não entra em nova cobrança.
- **Aguardando cliente** guarda `{ id, sentAt, status }` dos pedidos cobrados no `localStorage`, isolado pelo usuário logado, por até 7 dias; registros vencidos são descartados ao carregar. É válido apenas no computador que cobrou.
- **Verificar respostas** coleta e extrai novamente somente os pedidos aguardando, aplica a mesma classificação e remove da lista os que foram aprovados ou foram para revisão. Os que continuam sem nome permanecem aguardando.
- Ao final de cada execução, um resumo: aprovados e enviados à fila, para revisar, cobrados, aguardando, falhas.

## Arquitetura

1. `shared/lapis-autopilot.mjs` (novo, sem React): `classifyForAutopilot(source, result, queuedRevisions)` → `'auto' | 'review' | 'ask' | 'failed'`; `planAsk(orders, awaiting, now)` filtra pedidos cobráveis respeitando 24 horas; `loadAwaiting(storage, key, now)`, `recordSends(awaiting, results, now)` e `resolveAwaiting(awaiting, classified)` com expiração de 7 dias; `validateAskMessage(text)`.
2. `extension/duoke-bridge`, versão **1.1.0**: comando `SEND` com `{ codes, message }` no worker e no content script; `collector.js` ganha `sendToOrder(code, message, signal)`, reutilizando `orderSearch`, a abertura do resultado e a confirmação da conversa. O worker aceita `SEND` somente da aba do Studio pareada, com um trabalho por vez, e rejeita mensagem fora do limite. Eventos `PROGRESS`/`COMPLETE` incluem `{ order: { id, status: 'sent'|'unconfirmed'|'failed', error? } }`.
3. `src/lib/lapis-collection.mjs`: coordenador de envio análogo à coleta (`createSendRun`), com cancelamento e intervalo entre envios.
4. `src/components/LapisImport.jsx` e CSS: botão Processar lote, painel de cobrança com texto editável, filtro **Aguardando cliente** com contador, botão Verificar respostas e resumo. Mantém linguagem, cores e paginação atuais.
5. Documentação: `docs/duoke-gemini.md` passa a descrever o envio, a versão 1.1.0 e o teste na sessão real. A regra "não envia mensagens aos clientes" do design de 13/10/2026 passa a ser "envia somente após confirmação explícita em lote do operador". O ZIP da extensão é regenerado no build.

## Ponte

Requisição: `{ source: 'sticker-studio', version: 1, requestId, type: 'SEND', codes: string[], message: string }`. Respostas seguem o formato atual (`PROGRESS`, `COMPLETE`, `ERROR`) com o mesmo `requestId`. `STATUS` informa `busy` também durante envios; coleta e envio não rodam ao mesmo tempo.

## Riscos

Os seletores do campo de digitação, do botão de envio e das mensagens da loja no Duoke ainda precisam ser identificados no código público do Duoke e podem mudar. O envio real só fica comprovado após teste na sessão do usuário, primeiro com um pedido próprio de teste.

## Validação

Testes de `lapis-autopilot` para cada critério de aprovação, exclusão de não encontrados e falhas da cobrança, bloqueio de 24 horas, expiração de 7 dias e resolução da lista. Testes do coletor com DOM simulado: conversa errada não recebe mensagem, campo ausente gera `failed`, mensagem que não aparece gera `unconfirmed`, cancelamento entre envios, nenhum código enviado duas vezes no mesmo trabalho. Testes do worker para origem, trabalho concorrente e limite de texto. Executar `npm run test:lapis` e `npm run build`.

## Fora do escopo

Persistência no Supabase, recoleta periódica automática, cobrança repetida automática, geração automática do PDF e mensagens personalizadas por IA.
