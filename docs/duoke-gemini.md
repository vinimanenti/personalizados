# Duoke e Gemini na aba Lápis

A integração reúne coleta, extração, revisão e impressão. O computador precisa do Chrome ou Edge, com o Sticker Studio e o Duoke conectados. A chave do Gemini pertence ao servidor, não à extensão nem ao código publicado do site.

## Uso em cada computador

1. Abra **Lápis** e baixe a extensão na área de importação.
2. Extraia o ZIP para uma pasta permanente. Abra `chrome://extensions` ou `edge://extensions`, habilite o modo de desenvolvedor, escolha **Carregar sem compactação** e selecione a pasta que contém `manifest.json`.
3. Na aba `https://vinimanenti.github.io/personalizados/`, abra o popup da extensão e conecte o Sticker Studio.
4. Abra `https://web.duoke.com/?lang=pt#/dk/main/chat`, entre na sua conta e conecte essa aba pelo mesmo popup.
5. Volte à aba Lápis, atualize a conexão, cole os códigos e inicie a busca. Mantenha a conversa livre de alterações manuais durante a coleta. Cancelar preserva os pedidos concluídos.
6. Informe o **código de acesso à extração** fornecido pelo administrador. Esse código não é a chave de API do Gemini. Ele fica na memória da aba e deve ser informado novamente após recarregar.
7. Clique para extrair, confira os nomes e as quantidades, marque os pedidos revisados e adicione-os à fila. Também é possível baixar o CSV `ID,Nome`.

Ao recarregar a página, pode ser necessário conectar a aba novamente no popup. A permissão da extensão no Sticker Studio é temporária, concedida pelo clique. O único site com permissão permanente é `web.duoke.com`.

O rascunho de revisão e a fila de cartelas ficam no armazenamento da sessão do navegador, isolados pelo login, por até oito horas. Trocar de aba dentro do sistema ou recarregar recupera esse trabalho; um novo login inicia outra sessão. O acesso à extração deve ser informado novamente e os resultados restaurados exigem nova revisão. As cartelas que já estão na fila não são adicionadas duas vezes; removê-las da fila permite adicioná-las novamente.

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
- **Não Encontrado:** distingue ausência de pedido/nome de falhas de rede ou extração. Um erro não vira uma etiqueta com esse texto.
- **Acesso recusado:** confira o código de acesso do serviço. Não coloque a chave do Gemini nesse campo.
- **Quota atingida:** aguarde a janela indicada ou peça ao administrador para revisar os limites.
- **Falha no Gemini:** confira chave, modelo e quota no servidor; os detalhes secretos da resposta não são enviados ao navegador.
- **Certificado local:** se o Node 24 retornar `UNABLE_TO_VERIFY_LEAF_SIGNATURE` em uma rede com certificados próprios, inicie o desenvolvimento com `node --use-system-ca node_modules/vite/bin/vite.js` para usar os certificados confiáveis do Windows. Mantenha a verificação TLS habilitada.
- **CSV e quantidades:** `ID,Nome` não contém uma coluna de quantidade. O CSV é compatível com o formato solicitado; para preservar divisões personalizadas, envie os resultados diretamente à fila antes de exportar/reimportar.

Os testes automatizados usam respostas simuladas para conferir erros, evidências, quantidades, comunicação e cancelamento. Não substituem o teste com uma sessão real do Duoke: seletores e estrutura de terceiros podem mudar. A instalação da extensão, migração do banco, configuração de segredos e publicação são etapas de ativação separadas do build local.

## Validação desta entrega

Em 13/10/2026: 51 testes automatizados passaram; o build Vite, a renderização em código da tela e a compilação da função Edge passaram. A rota local rejeitou extração sem configuração de acesso. O ZIP contém apenas os nove arquivos da extensão; nenhuma das credenciais configuradas foi encontrada no código verificado ou no pacote publicado.

Uma chamada ao Gemini com nomes fictícios revelou incompatibilidade no campo `responseFormat`; a integração foi corrigida para os campos documentados `responseMimeType` e `responseJsonSchema`. A tentativa seguinte chegou ao provedor e recebeu HTTP 503 por alta demanda. Portanto, ainda não há uma extração real concluída registrada nesta entrega. Não houve envio de conversas reais. O navegador não estava disponível para validar o Duoke autenticado.

Após a configuração pelo usuário, a função Supabase respondeu ao teste de origem e recusou corretamente uma chamada sem código de acesso. O endereço correto do chat foi confirmado pelo usuário como `https://web.duoke.com/?lang=pt#/dk/main/chat`. A extensão 1.0.1 e o botão do frontend foram corrigidos; 55 testes e o build passaram. A publicação do frontend e do ZIP 1.0.1 foi verificada no site, inclusive pela comparação do pacote com o arquivo local. A coleta na sessão real e a extração autenticada continuam pendentes de validação.

Referências: [chaves Gemini](https://ai.google.dev/gemini-api/docs/api-key), [GenerateContent e GenerationConfig](https://ai.google.dev/api/generate-content), [saídas estruturadas](https://ai.google.dev/gemini-api/docs/generate-content/structured-output), [segredos de Edge Functions](https://supabase.com/docs/guides/functions/secrets), [permissão activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab).

Correção 1.0.2: o relato do usuário e o componente público `ChatSearch` do Duoke confirmaram a seleção de Pedido e o clique na linha do resultado. O botão atual usa `icon_search`, e a pesquisa por Pedido também atende `keyup.enter`. O coletor deixou de exigir a lupa e passou a limitar a busca à barra do chat, confirmar o modo Pedido e aguardar o resultado antes de abrir a conversa. Os 62 testes automatizados e o build passaram. O fluxo autenticado ainda precisa ser confirmado com um pedido na sessão do usuário.
