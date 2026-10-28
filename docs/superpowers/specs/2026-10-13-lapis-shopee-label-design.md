# Etiquetas Shopee na aba Lápis

Aprovado em 13/10/2026.

## Objetivo

Preencher os códigos dos pedidos na aba Lápis a partir dos PDFs de etiqueta da Shopee, sem digitação. O PDF enviado contém apenas etiquetas de lápis; todas as páginas são lidas.

## Comportamento

- Botão "Etiquetas Shopee (PDF)" na seção "01 Buscar no Duoke". Aceita um ou vários PDFs.
- Cada página é lida no navegador com o pdf.js; nada é enviado ao Gemini.
- De cada página saem `Pedido: <código>` e `Envio previsto: dd/mm/aaaa`.
- Os códigos são acrescentados ao campo "Códigos dos pedidos", preservando o conteúdo e sem repetir.
- Um aviso resume: etiquetas lidas, códigos adicionados, repetidos e páginas sem código.
- A data de cada pedido fica no rascunho da revisão (`shipDates`). Ao entrar na fila, a cartela usa essa data; sem ela, usa o campo manual "Data de envio".
- PDF ilegível ou sem etiquetas gera erro claro e não altera o rascunho.

## Unidades

- `shared/shopee-label.mjs`: reconstrução de linhas a partir dos itens de texto, leitura de pedido/envio e junção com o campo de códigos. Sem dependência de navegador.
- `src/lib/shopee-label-pdf.mjs`: abre o PDF com pdf.js e aplica as funções acima.
- `src/components/LapisImport.jsx`: botão, aviso e `shipDates` no rascunho.
- `src/PrintLab.jsx`: usa `order.shipDate` antes do campo manual.
- A leitura de etiquetas da aba Pedidos (`App.jsx`) não muda.

## Testes

- `tests/shopee-label.test.mjs` com texto fictício no layout da etiqueta: código, data, página sem código e junção sem duplicar.
- Verificação manual com uma etiqueta real, que não é versionada por conter dados do cliente.
