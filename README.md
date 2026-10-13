# ⚡ Sticker Studio

Sistema de personalização de adesivos para e-commerce Shopee.

## Setup

```bash
npm install
npm run dev
```

Acesse `http://localhost:3000`

## Como usar

1. **Modelos** → Clique num modelo para configurar
2. **Configurar** → Upload do SVG exportado do Corel Draw + imagem de referência
3. **Gerar** → Selecione a loja, cole o código do pedido e os nomes
4. **Preview** → Visualize e adicione à fila de impressão
5. **Impressão** → Gere o PDF final com todas as cartelas

## Lápis: Duoke e Gemini

A aba **Lápis** permite coletar conversas no Duoke por uma extensão de navegador,
extrair nomes pelo Gemini, revisar as quantidades e enviar os pedidos à fila de
etiquetas ou exportar CSV. A API roda no servidor; a chave não vai para o site.

Veja [instalação e ativação](docs/duoke-gemini.md) e o
[TXT de demonstração com dados fictícios](docs/examples/lapis-demo.txt).

```bash
npm run test:lapis
npm run build
```

## SVGs do Corel Draw

Os SVGs devem ter:
- Campos de texto com `id="campo_nome_1"` até `campo_nome_10`
- Campo `id="codigo_pedido"` para o código do pedido
- Campo `id="campo_loja"` para o nome da loja
- **Importante**: Adicione uma caixa de texto invisível com o alfabeto completo 
  (ABCDEFGHIJKLMNOPQRSTUVWXYZ + minúsculas) para que o Corel embuta todos os glyphs
