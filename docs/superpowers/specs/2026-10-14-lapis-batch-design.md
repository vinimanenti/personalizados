# Lotes de lápis e recuperação de pendências

Fluxo aprovado pelo usuário em 14/10/2026: coletar 300 pedidos em etapas automáticas, disponibilizar um TXT consolidado, extrair os nomes e separar pedidos sem nomes para refazer. Não solicitar novamente aprovação desse fluxo.

- Um clique em “Coletar e extrair” coordena até 500 pedidos, em coletas sequenciais de no máximo 200 e extrações de 10. O código de acesso é validado antes de começar e permanece somente na memória.
- Pedidos com nomes, inclusive corrigidos manualmente, são preservados. Retomar reaproveita conversas já coletadas; “Refazer pendências” busca novamente somente os pedidos ainda sem nomes ou com falha.
- Cancelar impede próximas etapas e conserva resultados recebidos. Pedidos não concluídos permanecem identificados, sem serem confundidos com ausência de nome.
- O TXT completo preserva IDs, conversas e estados de coleta. Pode ser reimportado, inclusive se o texto contiver linhas parecidas com cabeçalhos de pedido. Há exportação dos códigos pendentes.
- A revisão oferece filtros com contadores: todos, com nomes, sem nomes, falhas e aguardando extração. Permite repetir a extração das conversas disponíveis e refazer a coleta das pendências. Nomes e quantidades continuam exigindo revisão antes da fila.
- O rascunho local evita duplicar o texto das conversas. Falha de salvamento é visível; este trabalho não cria persistência no servidor.
- A interface segue os estilos atuais, com paginação de 30 pedidos para lotes grandes.

Implementação: funções de classificação/seleção e um coordenador de coleta testáveis fora do React; integração no painel existente; ajuste da finalização da extensão para aceitar a próxima etapa sem corrida; atualização do ZIP e documentação.

Validação: simular 300 pedidos, respostas fora do lote, cancelamento, desconexão, respostas incompletas, reexecução seletiva e exportação/importação. Executar a suíte e o build. A simulação não substitui a confirmação na sessão real do Duoke.
