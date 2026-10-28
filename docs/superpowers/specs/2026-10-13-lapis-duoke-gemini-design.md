# Lápis: Duoke e Gemini

Fluxo aprovado pelo usuário em 13/10/2026: colar pedidos, coletar conversas no Duoke conectado, extrair nomes pelo Gemini, revisar, exportar CSV ou adicionar à fila de etiquetas. Duoke: https://web.duoke.com/?lang=pt#/dk/main/chat.

## Contrato do produto

- Uma extensão Chrome/Edge faz a ponte entre a aba do Sticker Studio e a aba do Duoke. Instalação uma vez por computador; conexão explícita de cada aba pelo popup da extensão. Não coleta cookies nem senhas, não envia mensagens aos clientes.
- A coleta usa a busca e os elementos de conversa fornecidos pelo usuário, atravessando shadow roots abertos. Confirma o código do resultado e a troca/carregamento da conversa antes de extrair. Erros, tempo esgotado e pedido não encontrado são estados diferentes. Exibe progresso e permite cancelar, mantendo resultados concluídos.
- Importar TXT do coletor antigo continua possível. O sistema envia somente os pedidos selecionados ao Gemini após o clique em Extrair nomes.
- Gemini recebe mensagens como dados não confiáveis, não como instruções. Extrai somente nomes explicitamente destinados às etiquetas, com evidência literal. Ignora adultos, saudações e logística; preserva acentos, usa Title Case e retorna Não Encontrado quando não há identificação clara. Não deduz idades por nome.
- Internamente mantém o ID original, uma lista de nomes e quantidades. CSV final tem exatamente ID,Nome; irmãos recebem sufixos _1, _2 etc. Na fila, nomes do mesmo pedido compartilham uma cartela: 150 para um nome, 75 para dois, 50 para três quando a quantidade não é explícita. Quantidades explícitas são preservadas e revisadas. Mais de três nomes ou total acima de 150 impedem adicionar a cartela até correção, sem descarte silencioso.
- Revisão obrigatória por pedido antes de adicionar à fila. Mostra mensagem de origem, nome editável, quantidade e pendências. Exportação inclui Não Encontrado. Não interpreta erro de rede como nome ausente.

## Arquitetura

1. `extension/duoke-bridge`: Manifest V3, popup de pareamento, service worker e dois scripts separados (ponte do Studio e coletor Duoke). Apenas `web.duoke.com` tem permissão permanente; Sticker Studio usa a permissão temporária activeTab ao conectar. A comunicação verifica aba, origem, tipo, versão e identificador do trabalho. O pacote ZIP é gerado no build e pode ser baixado na aba Lápis.
2. `shared/lapis.mjs`: validação de códigos, parser TXT/CSV, normalização, CSV seguro e criação dos dados da cartela. Não depende de React nem acessa segredos.
3. `server/gemini.mjs`: handler HTTP universal com configuração por ambiente, autenticação por código de acesso do serviço, limites de entrada/saída, JSON estruturado, timeout e erros sem segredos. Chave Gemini somente no servidor; nenhuma variável VITE contém a chave. Modelo padrão atual configurável por GEMINI_MODEL.
4. Desenvolvimento local: plugin Vite expõe `/api/lapis/extract`. Produção: Supabase Edge Function com o mesmo handler, segredo GEMINI_API_KEY, código STICKER_AI_ACCESS_CODE, origens autorizadas e quota persistente. A autenticação local legada do aplicativo não é tratada como autenticação confiável de API.
5. `src/components/LapisImport.jsx` e CSS próprio: painel integrado ao PrintLab, conexão, importação, progresso, extração, revisão, exportação e fila. Mantém linguagem, cores e fontes do produto. Código de acesso fica apenas na memória da aba.

## Interfaces

Pedido coletado: `{ id: string, status: 'collected'|'not_found'|'error', text: string, error?: string }`.

Pedido extraído/revisado: `{ id: string, names: [{ name: string, quantity: number|null, evidence: string }], status: 'found'|'not_found'|'review', reason: string, text: string }`.

API: POST JSON `{ orders: CollectedOrder[] }`, cabeçalho `x-sticker-access-code`. Resposta `{ orders: ExtractedOrder[] }`; erros `{ error: string }` com status HTTP adequado. Lotes de no máximo 10 pedidos; até 12.000 caracteres por pedido e 120.000 no total. Nenhuma tentativa automática de outro modelo/provedor.

Ponte window.postMessage: `{ source: 'sticker-studio', version: 1, requestId, type: 'STATUS'|'START'|'CANCEL', codes?: string[] }`. Respostas `{ source: 'sticker-duoke', version: 1, requestId, type: 'STATUS'|'PROGRESS'|'COMPLETE'|'ERROR', ... }`. PROGRESS inclui `{ completed, total, order }`; STATUS inclui `{ connected, duokeConnected, busy }`. Todo trabalho tem um requestId e a aba não aceita eventos de outro trabalho.

## Validação e ativação

Testes de contrato para TXT, CSV com aspas/acentos, irmãos 75/75, Não Encontrado, IDs inesperados/duplicados, evidência ausente, quantidades inválidas, autorização e erro/timeout do Gemini. Testes do coletor com DOM simulado para evitar coletar conversa antiga e exercício de cancelamento. Build de produção e verificação do pacote da extensão. Validação real no Duoke depende da sessão conectada do usuário; publicar a função requer acesso administrativo ao Supabase. Não declarar esses passos realizados sem evidência.

## Decisões de escopo

O usuário aprovou o fluxo apresentado; não repetir aprovação do mesmo design. Preservar todas as modificações preexistentes em App.jsx, db.js e modelos. Não enviar a chave postada no chat para arquivos ou testes. Não corrigir o sistema de usuários legado inteiro nesta entrega; proteger a nova API independentemente. Não publicar nem instalar a extensão silenciosamente.
