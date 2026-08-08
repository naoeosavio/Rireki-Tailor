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
| `vendor/swiftlatex/` | Engine vendored. Patches: endpoint texlive → origin local; `ENGINE_PATH` via `document.currentScript`; `compileFormat` devolvendo os bytes (Uint8Array) do fmt. |
| `scripts/serve.js` | Dev server + resolvedor kpathsea (ordem `TEX_SUBROOTS` e `TEXMF_DIRS` como o TeXLive), `fix_extension` (ids → extensões), header `fileid`, 301 para MISS, espelho em `web/pdftex/`, `POST /api/upload-fmt`. |
| `test.html` | Harness de diagnóstico: carrega o engine, compila `data/CV_ATS.tex`, reconstrói o formato. `?autostart=format` / `?autostart=compile`. |
| `scripts/bootstrap.js` | Playwright: fluxo completo headless (build do fmt + compile) — usado para popular o espelho. |
| `scripts/probe.js` / `verify.js` | Diagnóstico: compile headless com logs do servidor / verificação do PDF gerado. |
| `pdftex/` | **Espelho estático** (bootstrap concluído): 82 arquivos, 34 MB — inclui `10/swiftlatexpdftex.fmt` (22 MB, built via wasm, magic `XT2W`). |

### IDs de formato kpathsea relevantes
`3` tfm · `4` afm · `10` fmt · `11` fontmap (.map) · `26` tex · `32` type1 (.pfa) ·
`33` vf · `44` enc · `45` cmap · `47` opentype · `49` lig · `36` truetype · `41` miscfonts.

## Uso

```bash
# desenvolvimento (resolve qualquer arquivo do TeXLive + espelha):
node web/scripts/serve.js --port 8080        # → http://localhost:8080/test.html

# re-popular o espelho / validar o pipeline headless (Playwright):
NODE_PATH=$(npm root -g) node web/scripts/verify.js   # status + header do PDF
```

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

1. App real (`index.html` + editor: editar `CV_ATS.tex` → compilar → PDF + log).
2. Remover `scripts/probe.js` quando o app substituir o harness.
