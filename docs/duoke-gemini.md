# Duoke e Gemini na aba Lápis

A integração reúne coleta, extração, revisão e impressão. O computador precisa do Chrome ou Edge, com o Sticker Studio e o Duoke conectados. A chave do Gemini pertence ao servidor, não à extensão nem ao código publicado do site.

## Uso em cada computador

1. Abra **Lápis** e baixe a extensão na área de importação.
2. Extraia o ZIP para uma pasta permanente. Abra `chrome://extensions` ou `edge://extensions`, habilite o modo de desenvolvedor, escolha **Carregar sem compactação** e selecione a pasta que contém `manifest.json`.
3. Na aba `https://vinimanenti.github.io/personalizados/`, abra o popup da extensão e conecte o Sticker Studio.
4. Abra `https://web.duoke.com/?lang=pt#/dk/main/chat`, entre na sua conta e conecte essa aba pelo mesmo popup.
5. Volte à aba Lápis, atualize a conexão e cole os códigos (até 500 pedidos). Informe o **código de acesso à extração** fornecido pelo administrador; ele não é a chave de API do Gemini e fica guardado no navegador deste computador (apague o campo para esquecê-lo).
6. Clique em **Coletar e extrair**. A coleta é dividida automaticamente em etapas de até 200 pedidos; ao terminar, começa a extração. Mantenha a conversa livre de alterações manuais durante a coleta. Cancelar preserva os pedidos concluídos; iniciar novamente reaproveita conversas disponíveis e preserva os pedidos que já têm nomes.
7. Baixe o **TXT completo** como backup das conversas. Confira nomes e quantidades, marque os pedidos revisados e adicione-os à fila. **Exportar CSV** baixa `ID,Nome` somente dos pedidos com nomes; os demais ficam nas pendências.
8. Use **Sem nomes** para nomes ausentes/pedidos não encontrados, **Falhas** para erros de coleta/extração e **A extrair** para conversas ainda não processadas. **Refazer pendências** busca novamente apenas Sem nomes e Falhas e extrai o que conseguir; **Extrair pendentes** reutiliza as conversas disponíveis sem nova busca. **Buscar novamente** refaz um único pedido. **Baixar códigos pendentes** salva todos os códigos ainda sem nomes para uso posterior.

A coleta abre cada conversa no Duoke para ler o conteúdo. A etapa do Gemini processa até 10 conversas por chamada e aplica cada grupo de resultados junto; 16 conversas selecionadas geram chamadas de 10 e 6, preservando os IDs de cada pedido.

Um lote de 300 pedidos usa duas coletas (200 e 100) e até 30 chamadas de extração inicial, conforme as conversas encontradas. Uma falha de extração marca somente o grupo afetado; os seguintes ficam a extrair. Os limites de quota existentes continuam valendo. A revisão mostra 30 pedidos por página e mantém os contadores do lote inteiro.

O TXT consolidado preserva IDs, estados de coleta, erros e conversas. Linhas de conversa têm o prefixo `| ` para impedir que uma mensagem contendo `PEDIDO:` seja confundida com outro pedido. O importador reconhece esse formato e o TXT antigo; o limite de arquivo é 24 MB, com até 500 pedidos e 12.000 caracteres por conversa. O TXT guarda conversas, enquanto o CSV guarda nomes; quantidades e revisão continuam no rascunho/fila.

Para a sequência automática de coletas, atualize a extensão para **1.0.4**: substitua os arquivos pelo ZIP novo, recarregue a extensão, atualize as abas e reconecte-as. Essa versão libera o próximo trabalho durante a confirmação de término do anterior.

Validação do fluxo em 14/10/2026: testes com 300 pedidos fictícios cobrem coleta em 200 + 100, TXT consolidado, 30 chamadas simuladas de extração, classificação de pendências, cancelamento e retomada seletiva. A renderização do componente real confirma 30 cartões por página e contadores do lote inteiro. A conferência visual no navegador e o fluxo com Duoke autenticado não foram executados porque não havia navegador disponível na sessão.

Ao recarregar a página, pode ser necessário conectar a aba novamente no popup. A permissão da extensão no Sticker Studio é temporária, concedida pelo clique. O único site com permissão permanente é `web.duoke.com`.

O rascunho de revisão e a fila de cartelas ficam no armazenamento da sessão do navegador, isolados pelo login, por até oito horas. Trocar de aba dentro do sistema ou recarregar recupera esse trabalho; um novo login inicia outra sessão. O acesso à extração deve ser informado novamente e os resultados restaurados exigem nova revisão. As cartelas que já estão na fila não são adicionadas duas vezes; removê-las da fila permite adicioná-las novamente.

O rascunho mantém uma única cópia de cada conversa. O limite efetivo de armazenamento depende do navegador; se não for possível salvar, um aviso orienta baixar TXT e CSV antes de fechar a tela. Não há gravação desse lote no servidor.

O TXT do coletor antigo pode ser importado diretamente. O código do pedido fica preservado. Dois nomes sem quantidade explícita dividem a cartela em 75/75; três em 50/50/50. Quantidades declaradas na conversa são preservadas. Mais de três nomes ou mais de 150 etiquetas precisam de ajuste antes de entrar na fila. O CSV usa `_1`, `_2` etc. para irmãos; a importação reúne a sequência novamente no pedido original.

## Desenvolvimento local

Use o `.env` existente para `GEMINI_API_KEY` e um `.env.local` ignorado pelo Git para as demais configurações. Variáveis de servidor **não** recebem prefixo `VITE_`.

| Variável | Uso |
| --- | --- |
| `GEMINI_API_KEY` | Chave válida do Gemini, somente no servidor |
| `GEMINI_MODEL` | Modelo configurável; padrão `gemini-3.8-flash` |
| `STICKER_AI_ACCESS_CODE` | Código forte e exclusivo para acesso ao serviço de extração |
| `STICKER_ALLOWED_ORIGINS` | Origens exatas autorizadas, separadas por vírgula |
| `STICKER_AI_DAILY_LIMIT` | Limite global diário de pedidos enviados ao Gemini |
| `STICKER_AI_MINUTE_LIMIT` | Limite global de pedidos enviados por minuto |
| `VITE_LAPIS_API_URL` | Opcional: endereço público da função, nunca uma chave |

Para desenvolvimento, a origem é `http://localhost:3000` (e `http://127.0.0.1:3000` se utilizada). O plugin do Vite atende `/api/lapis/extract`. A ausência da chave ou do código de acesso bloqueia a extração com uma mensagem de configuração.

```powershell
npm run dev
npm run test:lapis
npm run build
```

O `prebuild` prepara `public/downloads/duoke-bridge.zip`. Não há necessidade de instalar Python em cada computador. O script Python enviado serviu de referência para as regras, mas a integração utiliza a API HTTP do Gemini no servidor.

## Ativação para todos os computadores

O GitHub Pages hospeda somente o frontend. Publique `lapis-extract` no projeto Supabase utilizado pelo aplicativo, com estes passos executados por um administrador:

1. Aplique `supabase/migrations/202610130001_lapis_ai_quota.sql` no banco. A tabela e a função de quota só podem ser utilizadas pelo servidor.
2. Configure, nos segredos de Edge Functions, `GEMINI_API_KEY`, `GEMINI_MODEL`, `STICKER_AI_ACCESS_CODE`, `STICKER_ALLOWED_ORIGINS`, `STICKER_AI_DAILY_LIMIT` e `STICKER_AI_MINUTE_LIMIT`. Use `https://vinimanenti.github.io` como origem de produção, sem o caminho `/personalizados/`. Escolha limites compatíveis com o volume da loja. Cada chamada contém até dez pedidos e consome uma unidade por pedido enviado ao Gemini, inclusive em tentativas que falhem depois do envio. O limite diário reinicia à meia-noite UTC; o limite por minuto usa minutos UTC. No desenvolvimento, os padrões são 200 pedidos por dia e 20 por minuto, em memória; em produção, ambos precisam ser configurados e usam o banco.
3. Publique a função e mantenha a configuração de JWT indicada em `supabase/config.toml`. A função valida o código de acesso próprio; a chave pública/anon do Supabase e o login local legado do site não substituem essa validação. `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` são variáveis fornecidas pelo ambiente do Supabase e não devem ir ao frontend.
4. Gere o frontend com as variáveis públicas habituais `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`. Em produção, a integração usa `${VITE_SUPABASE_URL}/functions/v1/lapis-extract`. Para outro servidor, informe `VITE_LAPIS_API_URL` antes do build.
5. Publique a pasta `dist` pelo processo habitual do projeto. Teste um pedido conhecido no Duoke e revise a extração antes de liberar o fluxo para toda a equipe.

Com a CLI do Supabase previamente autenticada e o projeto vinculado:

```powershell
supabase db push
supabase functions deploy lapis-extract
```

Revise as migrações pendentes antes de `db push`. Alternativamente, execute somente o SQL desta entrega no editor do Supabase. Guarde a chave diretamente nos segredos do servidor. Não cole chaves em comandos, no chat, no arquivo de configuração da extensão ou em variáveis `VITE_`.

## Limites e diagnóstico

- **Desconectado:** conecte ambas as abas no popup. A coleta funciona no chat em `web.duoke.com/?lang=pt#/dk/main/chat`.
- **Pesquisa por pedido:** a extensão 1.0.2 seleciona **Pedido**, preenche o código e clica na linha do resultado para abrir a conversa. Se o resultado não aparecer ao digitar, aciona Enter no campo de pesquisa. Após atualizar a extensão, recarregue-a em `chrome://extensions` ou `edge://extensions`, atualize as duas abas e reconecte-as.
- **Conversa não confirmada:** a extensão interrompe aquele pedido quando não consegue confirmar a correspondência; não aproveita as mensagens que estavam abertas antes da busca.
- **Tempo esgotado na coleta:** a versão 1.0.3 reconhece `.order_item_title`, verifica somente mensagens com texto do cliente e lê o conteúdo das notas do pedido correspondente. Rótulos fixos de observação, mensagens da loja e mídias vazias não impedem a confirmação. A conversa tem até 30 segundos para carregar; a mensagem de erro distingue identificação, carregamento, ausência de texto e atualização pendente.
- **Não Encontrado:** distingue ausência de pedido/nome de falhas de rede ou extração. Um erro não vira uma etiqueta com esse texto.
- **Acesso recusado:** confira o código de acesso do serviço. Não coloque a chave do Gemini nesse campo.
- **Quota atingida:** aguarde a janela indicada ou peça ao administrador para revisar os limites.
- **Falha no Gemini:** confira chave, modelo e quota no servidor; os detalhes secretos da resposta não são enviados ao navegador.
- **Gemini indisponível (503):** a função corrigida tenta novamente uma vez dentro do mesmo prazo, respeitando a quota em cada tentativa. Se continuar indisponível, aguarde ou configure outro modelo compatível em `GEMINI_MODEL`. Em 13/10/2026, `gemini-3.8-flash` retornou alta demanda, enquanto `gemini-3.5-flash-lite` concluiu um teste com nome fictício e a chave local. Esse teste não comprova a configuração dos segredos no Supabase.
- **Certificado local:** se o Node 24 retornar `UNABLE_TO_VERIFY_LEAF_SIGNATURE` em uma rede com certificados próprios, inicie o desenvolvimento com `node --use-system-ca node_modules/vite/bin/vite.js` para usar os certificados confiáveis do Windows. Mantenha a verificação TLS habilitada.
- **CSV e quantidades:** `ID,Nome` não contém uma coluna de quantidade. O CSV é compatível com o formato solicitado; para preservar divisões personalizadas, envie os resultados diretamente à fila antes de exportar/reimportar.

Os testes automatizados usam respostas simuladas para conferir erros, evidências, quantidades, comunicação e cancelamento. Não substituem o teste com uma sessão real do Duoke: seletores e estrutura de terceiros podem mudar. A instalação da extensão, migração do banco, configuração de segredos e publicação são etapas de ativação separadas do build local.

## Validação desta entrega

Em 13/10/2026: 51 testes automatizados passaram; o build Vite, a renderização em código da tela e a compilação da função Edge passaram. A rota local rejeitou extração sem configuração de acesso. O ZIP contém apenas os nove arquivos da extensão; nenhuma das credenciais configuradas foi encontrada no código verificado ou no pacote publicado.

Uma chamada ao Gemini com nomes fictícios revelou incompatibilidade no campo `responseFormat`; a integração foi corrigida para os campos documentados `responseMimeType` e `responseJsonSchema`. A tentativa seguinte chegou ao provedor e recebeu HTTP 503 por alta demanda. Portanto, ainda não há uma extração real concluída registrada nesta entrega. Não houve envio de conversas reais. O navegador não estava disponível para validar o Duoke autenticado.

Após a configuração pelo usuário, a função Supabase respondeu ao teste de origem e recusou corretamente uma chamada sem código de acesso. O endereço correto do chat foi confirmado pelo usuário como `https://web.duoke.com/?lang=pt#/dk/main/chat`. A extensão 1.0.1 e o botão do frontend foram corrigidos; 55 testes e o build passaram. A publicação do frontend e do ZIP 1.0.1 foi verificada no site, inclusive pela comparação do pacote com o arquivo local. A coleta na sessão real e a extração autenticada continuam pendentes de validação.

Referências: [chaves Gemini](https://ai.google.dev/gemini-api/docs/api-key), [GenerateContent e GenerationConfig](https://ai.google.dev/api/generate-content), [saídas estruturadas](https://ai.google.dev/gemini-api/docs/generate-content/structured-output), [segredos de Edge Functions](https://supabase.com/docs/guides/functions/secrets), [permissão activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab).

Correção 1.0.2: o relato do usuário e o componente público `ChatSearch` do Duoke confirmaram a seleção de Pedido e o clique na linha do resultado. O botão atual usa `icon_search`, e a pesquisa por Pedido também atende `keyup.enter`. O coletor deixou de exigir a lupa e passou a limitar a busca à barra do chat, confirmar o modo Pedido e aguardar o resultado antes de abrir a conversa. Os 62 testes automatizados e o build passaram. O fluxo autenticado ainda precisa ser confirmado com um pedido na sessão do usuário.

Diagnóstico posterior da extração: a mensagem genérica de recusa foi reproduzida com HTTP 503 do Gemini. O handler agora distingue falhas de chave, permissão, modelo, formato, créditos, quota e indisponibilidade, sem repassar o corpo da resposta do provedor. A tentativa automática é limitada a um único retry de HTTP 503, com nova reserva de quota e o prazo original preservado. Os 70 testes passaram. A extração de `Ana Exemplo` com `gemini-3.5-flash-lite` respondeu HTTP 200 no teste local da API real. A validação do serviço publicado com o código de acesso do usuário permanece pendente.

Correção da coleta 1.0.3: a imagem `ERRO EXEMPLO.png` mostrou pedidos coletados e falhas de confirmação de conversa no mesmo lote. A inspeção do código público do Duoke identificou um título de pedido ausente dos seletores e contêineres de notas que incluíam rótulos fixos. Esses seletores foram corrigidos, as notas foram delimitadas ao cartão do pedido e a espera da conversa foi separada da pesquisa. Os testes cobrem conteúdo antigo, notas de outros pedidos, carregamento demorado e o envio de 16 conversas em dois lotes ao Gemini. O funcionamento na sessão real ainda precisa ser confirmado pelo usuário; as alterações do handler Gemini do diagnóstico anterior não foram publicadas por `FunctionsApiTransportError` da CLI Supabase.

## Piloto automático e cobrança de nomes (extensão 1.1.0)

**Processar lote** faz a coleta e a extração de sempre e, em seguida:

- envia direto à fila os pedidos seguros: status encontrado, de 1 a 3 nomes com evidência literal, cartela válida (até 150 etiquetas) e nenhum motivo de dúvida. Gerar o PDF continua sendo um clique do operador;
- deixa em revisão qualquer outro pedido com nomes;
- separa em **Cobrar nome** os pedidos cuja conversa foi lida sem nenhum nome. Pedidos não encontrados no Duoke e falhas de coleta ou extração nunca são cobrados.

O painel **Cobrar nome** mostra os códigos e a mensagem (editável, salva neste navegador, até 500 caracteres). Nada é enviado até o clique em **Enviar para N clientes**; cada envio atende até 100 pedidos, com intervalo de 2 a 4 segundos. Para cada pedido, a extensão abre a conversa com a mesma confirmação da coleta, preenche o campo de mensagem, confere de novo o pedido e clica em enviar. O resultado é:

- **Mensagem enviada**: a mensagem apareceu na conversa como mensagem da loja;
- **Envio não confirmado**: o clique aconteceu, mas a mensagem não apareceu em 15 segundos. Confira no Duoke; esse pedido não é reenviado automaticamente;
- **Mensagem não enviada**: nada saiu (pedido não encontrado, conversa não confirmada, anexo/citação/rascunho pendente ou modo **Enviar após tradução** ativo). **Tentar de novo** fica disponível.

Pedidos cobrados ficam em **Aguardando cliente** neste computador, por usuário, durante 7 dias, e não recebem nova mensagem por 24 horas. **Verificar respostas** coleta e extrai só esses pedidos, envia à fila os que responderam com nomes seguros e mantém os demais aguardando.

Para atualizar a extensão para 1.1.0, substitua os arquivos pelo ZIP novo, recarregue a extensão, atualize as duas abas e reconecte-as. No Duoke, deixe o botão de envio em **Enviar diretamente**.

Mapeamento do campo de mensagem em 28/10/2026, pelo código público do Duoke (sub-aplicativo `dk-web-vue2`, componente `InputAreaView`): `.cont_footer`, `textarea.el-textarea__inner`, ícone `.icon_send_chatbox` (`.icon_send02_chatbox` no modo de tradução), citação `.quote_content_front_block`, classe `has_attachments` e mensagens da loja em `.message_main > li.rt`. Os testes usam DOM simulado; o envio na sessão real ainda precisa ser confirmado pelo usuário, primeiro com um pedido próprio de teste.
