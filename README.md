# RirekiTailor Web — Compilação LaTeX no browser

Compila o CV (`.tex`) em PDF **100% no browser**, via engine SwiftLaTeX (PDFTeX/Wasm) vendored,
sem qualquer backend de TeX. Um servidor-espelho local (somente em desenvolvimento) resolve as
requisições kpathsea do engine contra o TeXLive instalado e copia os arquivos para `src/pdftex/`
— depois disso, o app é **estático e offline** (basta servir `src/` com qualquer HTTP server).

## Arquitetura

```
CV_ATS.tex ──► PdfTeXEngine (wasm, no browser)
                    │  kpse_find_file (XHR síncrono)
                    ▼
              /pdftex/{formatId}/{nome}
                    │
        ┌───────────┴─────────────┐
        │  (produção)             │ (desenvolvimento)
        ▼                         ▼
  src/pdftex/ (espelho)     serve.js (resolvedor TeXLive)
  estático, offline         /var/lib/texmf, /usr/share/texmf,
                            /usr/share/texlive/texmf-dist
```

O engine consulta o kpathsea emulado: para cada arquivo pedido (`format+"/"+nome`), espera a
resposta com header `fileid: <basename>` (o arquivo vai para `/tex/<fileid>` no FS virtual) ou
**301** (arquivo não existe — cacheado). Em produção os arquivos vêm direto do espelho
`src/pdftex/{formatId}/{nome}`.

## Componentes

| Arquivo | Papel |
|---|---|
| `src/index.html` | **App principal** — seções por vaga + stepper 3 etapas + PDF viewer + **menu global (sidebar)** + **chat por seção**. |
| `src/js/app.js` | Estado, seções (workspaces por vaga), auto-save (localStorage), **tema dark/light**, **modais/toasts**, **biblioteca de masters/templates**, LLM, engine. |
| `src/js/chat.js` | **Chat por seção** ("Assistente da vaga"): histórico por seção, system prompt contextual (vaga/master/CV_OUT/cover/tex), markdown-lite seguro, quick-asks. |
| `src/js/prompts.js` | Prompts ATS/cover/tex (idênticos ao CLI; ATS carrega `data/PROMPT_ATS.md`). |
| `src/js/llm.js` | Camada LLM via **tell-ai sdk** (`TellSDK.tell`): model alias/spec + keys/urls por vendor, migração de config antigo, teste de conexão, `chatTell()` (modo chat com `system`/`context`, `exec:false`). |
| `src/vendor/tell/` | **tell-ai sdk** (v0.2.1) vendored como ESM nativo sem bundler: `browser.js` (cópia de `dist/browser.js`, build ESM self-contained) + `sdk.js` (`export * as TellSDK from "@tell-ai/sdk"` via import map, expõe `window.TellSDK`). MIT. |
| `src/css/app.css` | Temas **dark/light** (`data-theme`), design system (botões, cards, stepper, toasts, modais, sidebar, chat), responsivo, `prefers-reduced-motion`. |
| `src/vendor/swiftlatex/` | Engine vendored. Patches: endpoint texlive → origin local; `ENGINE_PATH` via `document.currentScript`; `compileFormat` devolvendo os bytes (Uint8Array) do fmt. |
| `src/scripts/serve.js` | Dev server + resolvedor kpathsea (ordem `TEX_SUBROOTS` e `TEXMF_DIRS` como o TeXLive), `fix_extension` (ids → extensões), header `fileid`, 301 para MISS, espelho em `src/pdftex/`, `POST /api/upload-fmt`. |
| `test/test.html` | Harness de diagnóstico: carrega o engine, compila `data/CV_ATS.tex`, reconstrói o formato. `?autostart=format` / `?autostart=compile`. |
| `test/smoke.js` / `e2e.js` | Playwright: UI (temas, sidebar/biblioteca, modais, chat, persistência, export) e compile completo do PDF. |
| `test/bootstrap.js` | Playwright: fluxo completo headless (build do fmt + compile) — usado para popular o espelho. |
| `test/probe.js` / `verify.js` | Diagnóstico: compile headless com logs do servidor / verificação do PDF gerado. |
| `src/pdftex/` | **Espelho estático** (bootstrap concluído): 82 arquivos, 34 MB — inclui `10/swiftlatexpdftex.fmt` (22 MB, built via wasm, magic `XT2W`). |

## Fluxo do app (3 etapas)

1. **Entradas** — descrição da vaga, CV master (toggle EN/PT), template LaTeX e pitch opcional,
   com upload de arquivo, botões "↺ padrão" (restaura `data/`), **dropdowns da biblioteca**
   (copiam master/template globais para a seção) e botões **"salvar como modelo"** (bookmark).
   **Gerar CV_OUT.md** e **cover.md** via LLM (one-shot, com spinner + barra de progresso).
2. **Markdown** — editar/copiar/baixar CV_OUT.md e cover.md. **Converter para LaTeX** → CV.tex
   (mesmo prompt do `gen-pdf`: extrai o skeleton do template e preenche com o CV).
3. **LaTeX → PDF** — editar o CV.tex (ou upload de um .tex pronto, pulando o LLM),
   **Compilar PDF** no engine wasm → viewer + download. Ao lado do PDF, o **chat "Assistente
   da vaga"** responde dúvidas/sugere melhorias com base no contexto da seção.

### Menu global (sidebar) e biblioteca

- Botões de abertura: **hamburger** (aba Biblioteca) e **LLM** no header (aba LLM); fecha com X,
  backdrop ou `Esc`.
- **Biblioteca**: até **2 CV masters** (com idioma EN/PT) e **2 templates .tex**, com nome,
  edição inline, upload e exclusão (modal de confirmação). Seed automático na 1ª execução
  ("Master EN (padrão)" + "CV_ATS (padrão)" a partir de `data/`).
- **Cópia por seção**: selecionar um item no dropdown do card (Etapa 1) **copia** o conteúdo
  para a seção, que continua editável/independente (`s.masterId`/`s.templateId` viram
  "personalizado" se o usuário editar em cima). Nova seção herda a escolha da atual.
- **Salvar como modelo**: captura o master/template da seção ativa para a biblioteca
  (botão bookmark no card ou ação equivalente na sidebar); limite de 2 com toast.
- **Config LLM** vive na aba LLM da sidebar (mesmos IDs `#cfg-*`); keys/urls no localStorage.
- Persistência: `localStorage["riki.library"]` = `{masters:[{id,name,lang,content}], templates:[…]}`;
  incluída no export/import JSON (`riki-secoes-*.json`).

### Chat por seção ("Assistente da vaga")

- Painel na Etapa 3 (coluna ao lado do PDF; em telas < 1280px vai para largura total abaixo).
- Histórico **por seção** (`section.chat`), auto-salvo; limpo ao duplicar; "limpar" com modal.
- Cada mensagem usa `chatTell()` = `TellSDK.tell(msg, {exec:false, system, context})`:
  - `system`: instruções do assistente + snapshot dos campos não vazios da seção
    (vaga, master, CV_OUT, cover, CV.tex), no idioma da seção (pt/en);
  - `context`: últimos ~14 turnos serializados (cap ~24k chars).
  - One-shot por mensagem (sem streaming no bundle browser) — UI mostra bolha "pensando…".
- Respostas renderizadas com **markdown-lite** (HTML escapado antes — sem XSS; suporta
  code blocks, inline code, negrito, itálico, listas, links http/https, headings).
- **Quick-asks** no estado vazio (filtrados pelos campos disponíveis); Enter envia,
  Shift+Enter quebra linha; copiar mensagem; chips de contexto mostram o que o assistente "vê".
- Sem API key: bolha de erro com botão que abre a sidebar na aba LLM.

### UI (tema, toasts, modais)

- **Temas dark/light** via `data-theme` no `<html>`; toggle no header; persistido em
  `localStorage["riki.theme"]`; fallback `prefers-color-scheme`.
- **Toasts** (`#toasts`) substituem feedbacks efêmeros; **modais customizados**
  (`modal.confirm/prompt/alert`) substituem `prompt/confirm/alert` nativos (criar/renomear/
  excluir seção, salvar modelo, limpar chat, exclusões na biblioteca).
- Barra de progresso indeterminada + spinner nos botões durante geração LLM/compile;
  contadores de caracteres; botões de copiar; stepper com estados done/active.

### LLM (tell-ai sdk)

- Geração via `TellSDK.tell` (o mesmo `tell --no-exec` do CLI como função): system prompt
  no-exec, modelo por alias ou spec completo (`j`, `d`, `g`, `openai:gpt-5.6-sol:high`…),
  tags ` thinking`/`<RUN>` removidas, one-shot (sem streaming).
- **Config global** no painel "LLM": campo Model (default `j` = google:gemini-3.5-flash-lite)
  + grade de 9 vendors (openai, anthropic, google, deepseek, xai, cerebras, fireworks,
  moonshotai, openrouter) com key e base URL (URLs servem para CORS proxy quando o provedor
  não libera chamadas de browser). Tudo no localStorage.
- Migração automática do config antigo (`apiKey`→`keys.openai`, `baseURL`→`urls.openai`).
- O bundle IIFE do SDK é self-contained (define `process` próprio, sem `require()` de
  node builtins) — carrega direto no browser, sem shims.

### Seções (workspaces por vaga)

- Cada seção guarda snapshot próprio: vaga, master, template, pitch, cvOut, cover, tex,
  **chat** e as referências da biblioteca (`masterId`/`templateId`).
- **+ Nova seção** (via modal) herda master + template + escolha da biblioteca da seção atual;
  **Duplicar** limpa conteúdo gerado (cvOut/cover/tex/chat); tudo auto-salvo em localStorage.
- Exportar/importar seções como JSON (`riki-secoes-*.json`) — inclui biblioteca e config.
- Config LLM (baseURL/model/key) é **global** e fica no localStorage do browser —
  compatível com qualquer endpoint OpenAI-compatible com CORS (OpenAI, OpenRouter, Groq, DeepSeek…).

### IDs de formato kpathsea relevantes
`3` tfm · `4` afm · `10` fmt · `11` fontmap (.map) · `26` tex · `32` type1 (.pfa) ·
`33` vf · `44` enc · `45` cmap · `47` opentype · `49` lig · `36` truetype · `41` miscfonts.

## Uso

```bash
# desenvolvimento (resolve qualquer arquivo do TeXLive + espelha):
node src/scripts/serve.js --port 8080          # → http://localhost:8080/  (app) /test.html (diagnóstico)

# validação headless (Playwright, channel chromium):
NODE_PATH=$(npm root -g) node test/smoke.js    # UI: seções, persistência, export
NODE_PATH=$(npm root -g) node test/e2e.js      # compile completo → assert %PDF-1.5
```

- **Compile é rápido (~2 s):** o espelho `src/pdftex/` + índices em memória eliminam os
  walks de TeXMF; a 1ª compilação em servidor frio é que demora (walks ~20 min).
  Em hosting estático (só o espelho), é instantâneo.

- O formato (`pdflatex.fmt`) já está em `src/pdftex/10/swiftlatexpdftex.fmt`; se apagado,
  `test.html?autostart=format` o reconstrói no wasm (~5 min) e faz upload via `POST /api/upload-fmt`.
- Primeiro compile ~20–25 min (build do formato + downloads 1x1 via XHR síncrono);
  compiles seguintes na mesma sessão usam o cache do worker (`/tex/`, `texlive200_cache`) e são rápidos.
- **Playwright:** usar `chromium.launch({ channel: 'chromium' })` — o `chrome-headless-shell`
  crasha (SIGSEGV) com esse wasm (2022, emscripten antigo).

## Notas do TeXLive (Debian)

- `pdftex.map` em `/var/lib/texmf/fonts/map/pdftex/updmap/pdftex.map` é **symlink** para
  `pdftex_dl14.map` — o resolvedor segue symlinks.
- tex-gyre não tem `.vf` no Debian: o mapa reencoda na carga (`<q-ec.enc <qhvri.pfb`).
- `uenc.dfu`, `puenc.dfu`, `hyperref.cfg`, `tgheros.sty` não existem em texmf-dist; não são
  fatais (tgheros.sty resolvido via `/usr/share/texmf`).

## Próximos passos

1. Testar a geração LLM real (ATS + cover + tex) com uma chave própria no painel "LLM".
2. Remover `test/probe.js` quando o harness deixar de ser necessário.
3. Publicar em hosting estático (todo o `src/` já é self-contained).
