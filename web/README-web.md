# RirekiTailor Web — Compilação LaTeX no browser

Compila o CV (`.tex`) em PDF **100% no browser**, via engine SwiftLaTeX (PDFTeX/Wasm) vendored,
sem qualquer backend de TeX. Um servidor-espelho local (somente em desenvolvimento) resolve as
requisições kpathsea do engine contra o TeXLive instalado e copia os arquivos para `web/pdftex/`
— depois disso, o app é **estático e offline** (basta servir `web/` com qualquer HTTP server).

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
  web/pdftex/ (espelho)     serve.js (resolvedor TeXLive)
  estático, offline         /var/lib/texmf, /usr/share/texmf,
                            /usr/share/texlive/texmf-dist
```

O engine consulta o kpathsea emulado: para cada arquivo pedido (`format+"/"+nome`), espera a
resposta com header `fileid: <basename>` (o arquivo vai para `/tex/<fileid>` no FS virtual) ou
**301** (arquivo não existe — cacheado). Em produção os arquivos vêm direto do espelho
`web/pdftex/{formatId}/{nome}`.

## Componentes

| Arquivo | Papel |
|---|---|
| `index.html` | **App principal** — seções por vaga + stepper 3 etapas + PDF viewer. |
| `js/app.js` | Estado, seções (workspaces por vaga), auto-save (localStorage), LLM, engine. |
| `js/prompts.js` | Prompts ATS/cover/tex (idênticos ao CLI; ATS carrega `data/PROMPT_ATS.md`). |
| `js/llm.js` | Camada LLM via **tell-ai sdk** (`TellSDK.tell`): model alias/spec + keys/urls por vendor, migração de config antigo, teste de conexão. |
| `vendor/tell/` | Bundle browser do `@tell-ai/sdk` (IIFE `TellSDK`), copiado do npm (`dist/browser-global.global.js`, v0.2.0). MIT. |
| `css/app.css` | Tema dark. |
| `vendor/swiftlatex/` | Engine vendored. Patches: endpoint texlive → origin local; `ENGINE_PATH` via `document.currentScript`; `compileFormat` devolvendo os bytes (Uint8Array) do fmt. |
| `scripts/serve.js` | Dev server + resolvedor kpathsea (ordem `TEX_SUBROOTS` e `TEXMF_DIRS` como o TeXLive), `fix_extension` (ids → extensões), header `fileid`, 301 para MISS, espelho em `web/pdftex/`, `POST /api/upload-fmt`. |
| `test.html` | Harness de diagnóstico: carrega o engine, compila `data/CV_ATS.tex`, reconstrói o formato. `?autostart=format` / `?autostart=compile`. |
| `scripts/smoke.js` / `e2e.js` | Playwright: UI (seções, persistência, export) e compile completo do PDF. |
| `scripts/bootstrap.js` | Playwright: fluxo completo headless (build do fmt + compile) — usado para popular o espelho. |
| `scripts/probe.js` / `verify.js` | Diagnóstico: compile headless com logs do servidor / verificação do PDF gerado. |
| `pdftex/` | **Espelho estático** (bootstrap concluído): 82 arquivos, 34 MB — inclui `10/swiftlatexpdftex.fmt` (22 MB, built via wasm, magic `XT2W`). |

## Fluxo do app (3 etapas)

1. **Entradas** — descrição da vaga, CV master (toggle EN/PT), template LaTeX e pitch opcional,
   com upload de arquivo e botões "↺ padrão" (restaura `data/`). **Gerar CV_OUT.md** e **cover.md**
   via LLM (streaming no textarea).
2. **Markdown** — editar/baixar CV_OUT.md e cover.md. **Converter para LaTeX** → CV.tex
   (mesmo prompt do `gen-pdf`: extrai o skeleton do template e preenche com o CV).
3. **LaTeX → PDF** — editar o CV.tex (ou fazer upload de um .tex pronto, pulando o LLM),
   **Compilar PDF** no engine wasm → viewer + download.

### LLM (tell-ai sdk)

- Geração via `TellSDK.tell` (o mesmo `tell --no-exec` do CLI como função): system prompt
  no-exec, modelo por alias ou spec completo (`j`, `d`, `g`, `openai:gpt-5.6-sol:high`…),
  tags `<think>`/`<RUN>` removidas, one-shot (sem streaming).
- **Config global** no painel "LLM": campo Model (default `j` = google:gemini-3.5-flash-lite)
  + grade de 9 vendors (openai, anthropic, google, deepseek, xai, cerebras, fireworks,
  moonshotai, openrouter) com key e base URL (URLs servem para CORS proxy quando o provedor
  não libera chamadas de browser). Tudo no localStorage.
- Migração automática do config antigo (`apiKey`→`keys.openai`, `baseURL`→`urls.openai`).
- O bundle IIFE do SDK é self-contained (define `process` próprio, sem `require()` de
  node builtins) — carrega direto no browser, sem shims.

### Seções (workspaces por vaga)

- Cada seção guarda snapshot próprio: vaga, master, template, pitch, cvOut, cover, tex.
- **+ Nova seção** herda master + template da seção atual; tudo auto-salvo em localStorage.
- Exportar/importar seções como JSON (`riki-secoes-*.json`).
- Config LLM (baseURL/model/key) é **global** e fica no localStorage do browser —
  compatível com qualquer endpoint OpenAI-compatible com CORS (OpenAI, OpenRouter, Groq, DeepSeek…).

### IDs de formato kpathsea relevantes
`3` tfm · `4` afm · `10` fmt · `11` fontmap (.map) · `26` tex · `32` type1 (.pfa) ·
`33` vf · `44` enc · `45` cmap · `47` opentype · `49` lig · `36` truetype · `41` miscfonts.

## Uso

```bash
# desenvolvimento (resolve qualquer arquivo do TeXLive + espelha):
node web/scripts/serve.js --port 8080        # → http://localhost:8080/  (app) /test.html (diagnóstico)

# validação headless (Playwright, channel chromium):
NODE_PATH=$(npm root -g) node web/scripts/smoke.js   # UI: seções, persistência, export
NODE_PATH=$(npm root -g) node web/scripts/e2e.js     # compile completo → assert %PDF-1.5
```

- **Compile é rápido (~2 s):** o espelho `web/pdftex/` + índices em memória eliminam os
  walks de TeXMF; a 1ª compilação em servidor frio é que demora (walks ~20 min).
  Em hosting estático (só o espelho), é instantâneo.

- O formato (`pdflatex.fmt`) já está em `web/pdftex/10/swiftlatexpdftex.fmt`; se apagado,
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
2. Remover `scripts/probe.js` quando o harness deixar de ser necessário.
3. Publicar em hosting estático (todo o `web/` já é self-contained).
