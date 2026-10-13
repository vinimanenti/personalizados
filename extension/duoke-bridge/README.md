# Ponte Duoke

1. Baixe o ZIP no painel Lápis do Sticker Studio e extraia em uma pasta permanente.
2. No Chrome, abra `chrome://extensions`; no Edge, `edge://extensions`. Ative **Modo do desenvolvedor**, escolha **Carregar sem compactação** e selecione a pasta que contém `manifest.json`.
3. Abra `https://vinimanenti.github.io/personalizados/` (ou `http://localhost:3000/personalizados/`). Clique no ícone da extensão e em **Conectar esta aba**.
4. Abra `https://web.duoke.com/?lang=pt#/dk/main/chat`, entre normalmente e conecte essa aba pelo mesmo popup.
5. No painel Lápis, cole os códigos, colete e revise os resultados. Mantenha as duas abas abertas; reconecte após recarregar uma aba. Use **Cancelar coleta** para preservar os pedidos concluídos.

A extensão só lê a conversa após confirmar o código e uma atualização das mensagens. Resultados antigos, conversas sem identificação, carregamento incompleto e layout incompatível geram erro para revisão. Ela não lê cookies, credenciais ou armazenamento do Duoke e não envia mensagens. Apenas web.duoke.com possui permissão permanente; a conexão ao Studio é concedida pelo clique no popup. Somente o Studio publicado acima e localhost/127.0.0.1:3000 em `/personalizados/` são aceitos.

O coletor foi testado com DOM controlado. Confirme os seletores e a identificação do pedido na sua sessão real antes de usar um lote grande; alterações no layout do Duoke podem exigir atualização da extensão.

Protocolo: mensagens `window.postMessage` usam `version: 1`, `source: 'sticker-studio'` e `requestId` único. `START` contém `codes` (máximo 200, até 80 caracteres alfanuméricos, hífen ou sublinhado por código); `STATUS` consulta conexão. `CANCEL` contém um novo `requestId` e `jobId` igual ao `requestId` do `START`. A extensão responde com `source: 'sticker-duoke'`. `PROGRESS` e a conclusão do trabalho mantêm o ID original; o cancelamento também recebe uma confirmação `COMPLETE` no seu próprio ID com `jobId`. A conclusão do trabalho inclui `completed`, `total` e `cancelled`.

## Atualizar uma instalação existente

A versão 1.0.1 conecta o chat em web.duoke.com. Substitua os arquivos da pasta instalada pelos do novo ZIP, abra chrome://extensions ou edge://extensions e clique em Recarregar na Ponte Duoke. Confirme a nova permissão caso o navegador a solicite. Atualize as abas do Studio e do Duoke e conecte as duas novamente.
