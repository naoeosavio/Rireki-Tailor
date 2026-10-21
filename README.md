# RirekiTailor Web — LaTeX compilation in the browser

Compiles the CV (`.tex`) to PDF **100% in the browser**, via the vendored SwiftLaTeX engine
(PDFTeX/Wasm), with no TeX backend whatsoever. A local mirror server (development only)
resolves the engine's kpathsea requests against the installed TeXLive and copies the files
into `src/pdftex/` — after that, the app is **static and offline** (just serve `src/` with
any HTTP server).

## Architecture

```
CV_ATS.tex ──► PdfTeXEngine (wasm, in the browser)
                    │  kpse_find_file (synchronous XHR)
                    ▼
              /pdftex/{formatId}/{name}
                    │
        ┌───────────┴─────────────┐
        │  (production)           │ (development)
        ▼                         ▼
  src/pdftex/ (mirror)      serve.js (TeXLive resolver)
  static, offline            /var/lib/texmf, /usr/share/texmf,
                             /usr/share/texlive/texmf-dist
```

The engine queries the emulated kpathsea: for each requested file (`format+"/"+name`), it
expects a response carrying the `fileid: <basename>` header (the file lands at
`/tex/<fileid>` in the virtual FS) or **301** (file does not exist — cached). In production
the files come straight from the `src/pdftex/{formatId}/{name}` mirror.

## Components

| File | Role |
|---|---|
| `src/index.html` | **Main app** — per-job sections + 3-step stepper + PDF viewer + **global menu (sidebar)** + **per-section chat**. |
| `src/js/app.js` | State, sections (per-job workspaces), auto-save (localStorage), **dark/light theme**, **modals/toasts**, **master/template library**, LLM, engine. |
| `src/js/chat.js` | **Per-section chat** ("Job assistant"): per-section history, contextual system prompt (job/master/CV_OUT/cover/tex), safe markdown-lite, quick-asks. |
| `src/js/store.js` | Pure state normalizers — the shape barrier between localStorage/imported JSON and the app (anti-DoS ceilings, id allowlist, corrupt-value stashing). |
| `src/js/prompts.js` | ATS/cover/tex prompts (identical to the CLI; ATS loads `data/PROMPT_ATS.md`). |
| `src/js/llm.js` | LLM layer via the **tell-ai core runtime** (`TellCore.create_core_runtime`) over the **tell-ai sdk** (`TellSDK.create_ask_ai`): model alias/spec + keys/urls per vendor, legacy config migration, connection test, `chatTell()` (chat mode with `system`/`context`). The core owns the prompt, the no-exec protocol and the tags. When the dev server holds a key in its env, the call goes through the server. |
| `src/vendor/tell/` | **tell-ai sdk** (v0.4.1) and **tell-ai core** (v0.1.2) vendored as native ESM with no bundler: `browser.js` + `core.browser.js` (copies of the self-contained `dist/browser.js` builds) + `sdk.js` / `core.js` (namespace re-exports via import map, expose `window.TellSDK` / `window.TellCore`). MIT. |
| `src/css/app.css` | **Dark/light** themes (`data-theme`), design system (buttons, cards, stepper, toasts, modals, sidebar, chat), responsive, `prefers-reduced-motion`. |
| `src/vendor/swiftlatex/` | Vendored engine. Patches: texlive endpoint → local origin; `ENGINE_PATH` via `document.currentScript`; `compileFormat` returning the fmt bytes (Uint8Array). |
| `src/scripts/serve.js` | Dev server + kpathsea resolver (`TEX_SUBROOTS` and `TEXMF_DIRS` follow TeXLive's order), `fix_extension` (ids → extensions), `fileid` header, 301 for MISS, mirror into `src/pdftex/`, `POST /api/upload-fmt`, `GET /api/llm/config` + `POST /api/llm` (the server holds the key). The static paths use the fail-closed helpers of the core (`canonical_path`), so a symlink inside the tree never reaches the client. |
| `test/test.html` | Diagnostic harness: loads the engine, compiles `test/CV_ATS.tex`, rebuilds the format. `?autostart=format` / `?autostart=compile`. |
| `test/store_test.js` | Unit tests for the `store.js` normalizers. |
| `test/serve_audit.js` / `serve_audit2.js` | Dev-server audit: path traversal, origin/CSRF guard, fmt upload limits, idle timeout. |
| `test/app_audit.js` | Browser audit: corrupt-storage recovery, failed-engine retry, delete-last-section, chat persistence, quota, modals, uploads. |
| `test/smoke.js` / `e2e.js` | Playwright: UI (themes, sidebar/library, modals, chat, persistence, export) and full PDF compile. |
| `test/bootstrap.js` | Playwright: full headless flow (fmt build + compile) — used to populate the mirror. |
| `test/probe.js` / `verify.js` | Diagnostics: headless compile with server logs / verification of the generated PDF. |
| `src/pdftex/` | **Static mirror** (bootstrap complete): 82 files, 34 MB — includes `10/swiftlatexpdftex.fmt` (22 MB, built via wasm, magic `XT2W`). |

## App flow (setup block + 3 steps)

A **setup block** sits on top of every step: the LLM config form and the
CV base (master CV plus visual LaTeX template). It collapses to a summary
bar, so the work area keeps the space.

1. **Vaga** — job description and optional pitch.
   **Generate CV_OUT.md** and **cover.md** via the LLM (one-shot, with spinner + progress bar).
2. **Markdown** — edit/copy/download CV_OUT.md and cover.md. **Convert to LaTeX** → CV.tex
   (same prompt as `gen-pdf`: extracts the template's skeleton and fills it with the CV).
3. **LaTeX → PDF** — edit CV.tex (or upload a ready-made .tex, skipping the LLM),
   **Compile PDF** with the wasm engine → viewer + download. Next to the PDF, the
   **"Job assistant" chat** answers questions and suggests improvements based on the
   section's context.

### Fix with LLM — the chain loop

**Fix with LLM** is a chain of up to **8 rounds** (the cap of the core,
`DEFAULT_MAX_CHAIN_STEPS`):

1. The model repairs the `.tex` (the broken document + the last compiler error).
2. The app **compiles** the answer with the wasm engine.
3. A failed compile comes back as a failed command, and the **next round gets the
   new error** — the model sees its own last attempt and the real log.
4. The chain stops at the first document that compiles (the PDF is shown right
   away, without a second compile) or when the budget is spent.

If the chain ends without a document that compiles, the app says so and asks the
user to **rewrite the `.tex` by hand** (or to regenerate it with *Convert to
LaTeX*). The broken `.tex` is never replaced by a broken answer. The chain also
stops early when the model returns the very same document again — it is not
making progress. The loop is the one of the core (`run_primitive_loop`).

### Global menu (sidebar) and library

- Open buttons: **hamburger** (Library tab) and **LLM** in the header (goes to Step 1); sidebar closes with
  X, the backdrop, or `Esc`.
- **Library**: up to **2 master CVs** (each with an EN/PT language) and **4 user .tex templates**,
  with name, inline editing, upload and deletion (confirmation modal). Auto-seeded on first
  run with one master ("Master (default)" from `data/` or the built-in default).
- **Template models**: 4 read-only starting points (modern, classic, ATS, academic) in
  `src/js/defaults.js`. They appear in the sidebar and in the setup block template dropdown.
  Selecting one **copies** it into the section. The copy stays editable. The model never changes.
- **Per-section copy**: picking an item from a card's dropdown (setup block) **copies** its content
  into the section, which stays editable/independent (`s.masterId`/`s.templateId` flip to
  "customized" if the user edits on top). A new section inherits the current one.
- **Save as model**: captures the active section's master/template into the library (the
  bookmark button on the card, or the equivalent action in the sidebar); limit of 2 masters
  and 4 templates with a toast.
- **LLM config** lives in the setup block (same `#cfg-*` IDs); keys/urls in localStorage. The header LLM button and the sidebar LLM tab open that block.
- Persistence: `localStorage["riki.library"]` = `{masters:[{id,name,lang,content}], templates:[…]}`;
  included in the JSON export/import (`riki-secoes-*.json`).

### Per-section chat ("Job assistant")

- Panel in Step 3 (column beside the PDF; below full width on screens < 1280px).
- History is **per section** (`section.chat`), auto-saved; cleared on duplicate; "clear"
  behind a modal.
- Each message goes through `chatTell()` = `TellSDK.tell(msg, {exec:false, system, context})`:
  - `system`: assistant instructions + a snapshot of the section's non-empty fields
    (job, master, CV_OUT, cover, CV.tex), in the section's language (pt/en);
  - `context`: the last ~14 turns serialized (capped at ~24k chars).
  - One-shot per message (no streaming in the browser bundle) — the UI shows a "thinking…"
    bubble.
- Replies are rendered with **markdown-lite** (HTML escaped first — no XSS; supports
  code blocks, inline code, bold, italic, lists, http/https links, headings).
- **Quick-asks** in the empty state (filtered by the available fields); Enter sends,
  Shift+Enter adds a newline; copy message; context chips show what the assistant "sees".
- No API key: an error bubble with a button that opens the setup block.

### UI (theme, toasts, modals)

- **Dark/light themes** via `data-theme` on `<html>`; toggle in the header; persisted in
  `localStorage["riki.theme"]`; falls back to `prefers-color-scheme`.
- **Toasts** (`#toasts`) replace ephemeral feedback; **custom modals**
  (`modal.confirm/prompt/alert`) replace native `prompt/confirm/alert` (create/rename/
  delete section, save model, clear chat, library deletions).
- Indeterminate progress bar + button spinner during LLM generation/compile;
  character counters; copy buttons; stepper with done/active states.

### LLM (tell-ai core runtime + sdk)

- Generation via the **core runtime** (`TellCore.create_core_runtime`): the core composes the prompt
  (`Previous context:` + the system prompt), runs the primitive loop, strips the `thinking`/`<RUN>`
  tags and refuses every command (no-exec). The model port of the app calls the sdk
  (`TellSDK.create_ask_ai`) or the custom endpoint.
- Model by alias or full spec (`j`, `d`, `g`, `openai:gpt-5.6-sol:high`…), one-shot (no streaming).
- **Global config** in Step 1: a grid of 12 vendor cards (openai, anthropic, google, deepseek,
  xai, cerebras, fireworks, moonshotai, openrouter, alibaba, zai, custom). A click shows the
  detail block: model, provider key (with eye toggle), connection test. The `custom` detail
  adds endpoint URL, API type (`auto`/`chat`/`responses`/`messages`), the model list of the
  endpoint (the button asks the endpoint and fills the picker) and extra JSON headers;
  `custom:<model>` calls that endpoint directly (keyless endpoints allowed). Details in
  `docs/llm-base-url.md`. Everything lives in localStorage.
- The model field completes with the **aliases of the sdk** (152 entries) and the hint below
  shows the resolved spec (`openai · gpt-6.1-sol · medium`). A wrong alias of another provider
  is named there. Each provider card keeps its own model.
- Automatic migration of the legacy config (`apiKey`→`keys.openai`, `baseURL`→`urls.openai`).
- The SDK's IIFE bundle is self-contained (defines its own `process`, no `require()` of node
  builtins) — it loads straight into the browser, no shims.
- The chat history uses the turn format of the **tell-ai core** (`User:` / `Assistant:`) and the
  core cuts it with `truncate_context`, so the context never exceeds the limit and never ends
  in the middle of a turn.
- **The key on the server** (the dev server / VPS): put `OPENAI_API_KEY` (or `ANTHROPIC_API_KEY`,
  `GOOGLE_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, …) in the env of the server and
  `TELL_MODEL` for the default model. The browser asks `GET /api/llm/config` what the server
  holds and sends the call to `POST /api/llm` when the browser has no key of its own. The key
  never reaches the browser, and the call no longer needs CORS. A key in the browser always
  wins. The server runs the same core runtime, so the answer is the same.
- **Stop button**: the chat can cancel a pending answer (the cancel token of the core).

### Sections (per-job workspaces)

- Each section keeps its own snapshot: job, master, template, pitch, cvOut, cover, tex,
  **chat**, and the library references (`masterId`/`templateId`).
- **+ New section** (via modal) inherits master + template + the library choice of the current
  section; **Duplicate** clears generated content (cvOut/cover/tex/chat); everything
  auto-saved to localStorage.
- Export/import sections as JSON (`riki-secoes-*.json`) — includes library and config.
- LLM config (baseURL/model/key) is **global** and lives in the browser's localStorage —
  compatible with any CORS-enabled OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq,
  DeepSeek…).

### Relevant kpathsea format IDs
`3` tfm · `4` afm · `10` fmt · `11` fontmap (.map) · `26` tex · `32` type1 (.pfa) ·
`33` vf · `44` enc · `45` cmap · `47` opentype · `49` lig · `36` truetype · `41` miscfonts.

## Usage

```bash
# development (resolves any TeXLive file + mirrors it):
node src/scripts/serve.js --port 8080          # → http://localhost:8080/  (app) /test.html (diagnostics)

# headless validation (Playwright, channel chromium):
NODE_PATH=$(npm root -g) node test/smoke.js    # UI: sections, persistence, export
NODE_PATH=$(npm root -g) node test/e2e.js      # full compile → assert %PDF-1.5
```

### Test suites

| Command | What it covers |
|---|---|
| `npm run test:all` | Every suite below, plus the smoke test and the browser audit. |
| `npm run test:store` | The shape barrier of the state. |
| `npm run test:fixtex` | The LaTeX helpers and the wiring of the steps. |
| `npm run test:fuzz` | The fuzz, differential, and reduction tests of the browser packages. |
| `npm run test:serve` | The routes of the dev server. |
| `npm run test:serve2` | The idle path of the format upload. |
| `npm run test:servefuzz` | The fuzz tests of the dev server: paths, methods, headers, bodies. |
| `npm run test:updater` | The atomic update of the vendored engine. |
| `npm run test:app` | The browser audit of the app and the chat. |
| `npm run test:llmreal` | A real model through the `tell` CLI. The suite skips itself when the CLI or the network is not there. |

The fuzz suite has a fixed seed. A failure always comes back with the smallest case that still
fails. The real model test uses `openrouter:minimax/minimax-m3.1-flash:free` and measures how
often a small model returns a usable answer.

- **Compilation is fast (~2 s):** the `src/pdftex/` mirror plus in-memory indexes eliminate
  the TeXMF tree walks; only the first compilation on a cold server is slow (walks ~20 min).
  On static hosting (mirror only), it is instant.

- The format (`pdflatex.fmt`) is already at `src/pdftex/10/swiftlatexpdftex.fmt`; if deleted,
  `test.html?autostart=format` rebuilds it in wasm (~5 min) and uploads it via
  `POST /api/upload-fmt`.
- First compile ~20–25 min (format build + 1x1 downloads over synchronous XHR);
  later compiles in the same session reuse the worker cache (`/tex/`, `texlive200_cache`)
  and are fast.
- **Playwright:** use `chromium.launch({ channel: 'chromium' })` — `chrome-headless-shell`
  crashes (SIGSEGV) with this wasm (2022, old emscripten).

## TeXLive notes (Debian)

- `pdftex.map` at `/var/lib/texmf/fonts/map/pdftex/updmap/pdftex.map` is a **symlink** to
  `pdftex_dl14.map` — the resolver follows symlinks.
- tex-gyre has no `.vf` on Debian: the map re-encodes on load (`<q-ec.enc <qhvri.pfb`).
- `uenc.dfu`, `puenc.dfu`, `hyperref.cfg`, `tgheros.sty` do not exist in texmf-dist; they are
  not fatal (tgheros.sty resolves via `/usr/share/texmf`).

## Next steps

1. Test real LLM generation (ATS + cover + tex) with your own key in the "LLM" panel.
2. Remove `test/probe.js` once the harness is no longer needed.
3. Publish to static hosting (all of `src/` is already self-contained).

## License

Copyright (C) 2026 RirekiTailor — `SPDX-License-Identifier: AGPL-3.0-only`.

This project is licensed under the **GNU Affero General Public License v3.0 only**.
See the full text at [`LICENSE`](./LICENSE).

Vendored dependencies (`src/vendor/tell/`, `src/vendor/swiftlatex/`) retain
their own licenses (MIT/upstream); the combined work is distributed as AGPL-3.0.
