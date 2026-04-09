# Sticker Studio — Sistema de Personalização de Adesivos

## Contexto do Projeto

Sistema web para automatizar a produção de adesivos personalizados para e-commerce (Shopee).
O usuário tem 5 lojas (TR Etiquetas, Jd Adesivos, Casa do Condi, VM Adesivos, IG Stickers) 
e vende 18 modelos diferentes de adesivos personalizados com nomes.

### Fluxo de Trabalho
1. Cliente compra na Shopee e envia o nome via chat
2. Operador abre o Sticker Studio, seleciona o modelo, cola os nomes
3. Sistema gera cartelas com os nomes posicionados automaticamente
4. Cartelas vão para a fila de impressão
5. No final do dia, gera um PDF único com todas as cartelas para imprimir

## Stack Técnica

- **Frontend**: React 18 + Vite (arquivo único em `src/App.jsx`)
- **Sem backend** — tudo roda no navegador
- **Persistência**: localStorage
- **Dependências**: jszip (download ZIP), jspdf (geração PDF)

## Estrutura do App (src/App.jsx)

O app é um arquivo monolítico com estas seções:

### Constantes e Estado
- `MODELS` — 18 modelos (MOD001 a MOD018) com configs de fonte, maxWidth, glyphMap, textCenters
- `STORES` — 5 lojas Shopee
- localStorage com chave `sticker_v5`

### Funções Core
- `analyzeSvg(svgText)` — Analisa SVG do Corel Draw:
  - Detecta campos `campo_nome_X`, `codigo_pedido`, `campo_loja`
  - Detecta classe fnt usada (fnt0, fnt1, fnt2...) e extrai font-size/family
  - Encontra o FontID correto via `@font-face` CSS
  - Extrai glyph advances do SVG font para medição precisa
  - Calcula centros de texto por coluna (suporta 2, 5, ou N colunas)

- `measureSvgFont(text, fontSize, glyphMap, defaultAdv)` — Mede largura do texto usando métricas dos glyphs SVG embutidos (preciso para centralização)

- `measureText(text, font, size)` — Mede via Canvas API (fallback, usado para decisão de quebra de linha)

- `breakLines(name, font, fontSize, maxWidth)` — Quebra nome em 2 linhas se exceder maxWidth, encontrando o split mais balanceado

- `injectNames(svgText, namesList, model, fontOverrides)` — Injeta nomes no SVG:
  - Substitui conteúdo dos `<text id="campo_nome_X">`
  - Centraliza cada texto usando `textCenters` calculados por `analyzeSvg`
  - Suporta font-size individual por campo (`fontOverrides`)
  - Também substitui `codigo_pedido` e `campo_loja`

### Componentes
- `Calibration` — Painel de calibração visual com slider de maxWidth e fontSize, barra de progresso, preview ao vivo
- `App` — Componente principal com 5 abas:
  - **Modelos** (gallery) — Grid de 18 modelos com status
  - **Configurar** (config) — Upload SVG/thumb/fonte + calibração
  - **Gerar** (generate) — Input de nomes, código pedido, loja, lista interativa com ajuste de fonte por nome
  - **Preview** (preview) — Visualização das cartelas, download SVG/PNG/ZIP, botão "Adicionar à fila"
  - **Impressão** (print) — Fila de impressão, geração de PDF único

## Estrutura dos SVGs (Corel Draw)

Cada SVG do Corel tem:
- `viewBox` com coordenadas em unidades SVG (não mm)
- Fontes embutidas como `<font>` com `<glyph>` vetoriais (SVG fonts)
- CSS com classes `.fntX` definindo font-size e font-family
- `@font-face` mapeando família → FontID
- Campos de texto: `<text id="campo_nome_X" class="filY fntZ">NOME AQUI</text>`
- Campo pedido: `<text id="codigo_pedido">`
- Campo loja: `<text id="campo_loja">`
- ClipPaths definindo as áreas de cada etiqueta

### ⚠️ Problema Conhecido: Glyphs Faltando
O Corel só embute os glyphs dos caracteres usados no documento. Se o template tem "NOME AQUI", 
só existem glyphs para A, E, I, M, N, O, Q, U. Outras letras ficam invisíveis.

**Solução pendente**: Ao carregar um .TTF da fonte, injetar como `@font-face` CSS no SVG 
e remover a referência aos glyphs embutidos, permitindo renderizar qualquer caractere.

## Layouts Conhecidos

| Modelo | Layout | Fonte | Tamanho |
|--------|--------|-------|---------|
| MOD_001 | 2 col × 5 lin | DK Coal Brush | 715.51px |
| MANT_PR | 2 col × 5 lin | DK Coal Brush | 548.12px |
| MOD_003 | 2 col × 5 lin | DK Coal Brush | 230.64px |
| MOD_004 | 5 col × 2 lin | Misses | 725.83px |
| MOD_005 | 5 col × 2 lin | Misses | 725.83px |
| MOD_006 | 5 col × 2 lin | Misses | 725.83px |

## Próximos Passos / TODO

1. **Resolver glyphs faltando** — Quando o usuário carrega o .TTF:
   - Converter para base64 e injetar `@font-face` CSS no SVG gerado
   - Remover referência ao `<font>` SVG embutido
   - Testar que todos os caracteres renderizam

2. **Melhorar geração de PDF** — O PDF de impressão deve:
   - Arranjar cartelas em grid numa folha grande (~991×1162mm)
   - Manter resolução vetorial (SVG→PDF direto seria ideal vs PNG)
   - Formato PDF/X-1a para impressão profissional

3. **Refatorar App.jsx** — Separar em módulos:
   - `src/utils/svg-analyzer.js`
   - `src/utils/svg-injector.js`
   - `src/utils/text-measurement.js`
   - `src/components/Calibration.jsx`
   - `src/components/Gallery.jsx`
   - `src/components/Generator.jsx`
   - `src/components/Preview.jsx`
   - `src/components/PrintQueue.jsx`

4. **UX melhorias**:
   - Alerta visual quando SVG tem glyphs faltando
   - Preview em tempo real enquanto digita nomes
   - Drag & drop para reordenar fila de impressão
   - Histórico de pedidos

## Comandos

```bash
npm install     # Instalar dependências
npm run dev     # Rodar em desenvolvimento (http://localhost:3000)
npm run build   # Build para produção
npm run preview # Preview do build
```
