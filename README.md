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
| `src/js/llm.js` | LLM layer via the **tell-ai sdk** (`TellSDK.tell`): model alias/spec + keys/urls per vendor, legacy config migration, connection test, `chatTell()` (chat mode with `system`/`context`, `exec:false`). |
| `src/vendor/tell/` | **tell-ai sdk** (v0.2.1) vendored as native ESM with no bundler: `browser.js` (copy of `dist/browser.js`, self-contained ESM build) + `sdk.js` (`export * as TellSDK from "@tell-ai/sdk"` via import map, exposes `window.TellSDK`). MIT. |
| `src/css/app.css` | **Dark/light** themes (`data-theme`), design system (buttons, cards, stepper, toasts, modals, sidebar, chat), responsive, `prefers-reduced-motion`. |
| `src/vendor/swiftlatex/` | Vendored engine. Patches: texlive endpoint → local origin; `ENGINE_PATH` via `document.currentScript`; `compileFormat` returning the fmt bytes (Uint8Array). |
| `src/scripts/serve.js` | Dev server + kpathsea resolver (`TEX_SUBROOTS` and `TEXMF_DIRS` follow TeXLive's order), `fix_extension` (ids → extensions), `fileid` header, 301 for MISS, mirror into `src/pdftex/`, `POST /api/upload-fmt`. |
| `test/test.html` | Diagnostic harness: loads the engine, compiles `test/CV_ATS.tex`, rebuilds the format. `?autostart=format` / `?autostart=compile`. |
| `test/store_test.js` | Unit tests for the `store.js` normalizers. |
| `test/serve_audit.js` / `serve_audit2.js` | Dev-server audit: path traversal, origin/CSRF guard, fmt upload limits, idle timeout. |
| `test/app_audit.js` | Browser audit: corrupt-storage recovery, failed-engine retry, delete-last-section, chat persistence, quota, modals, uploads. |
| `test/smoke.js` / `e2e.js` | Playwright: UI (themes, sidebar/library, modals, chat, persistence, export) and full PDF compile. |
| `test/bootstrap.js` | Playwright: full headless flow (fmt build + compile) — used to populate the mirror. |
| `test/probe.js` / `verify.js` | Diagnostics: headless compile with server logs / verification of the generated PDF. |
| `src/pdftex/` | **Static mirror** (bootstrap complete): 82 files, 34 MB — includes `10/swiftlatexpdftex.fmt` (22 MB, built via wasm, magic `XT2W`). |

## App flow (3 steps)

1. **Inputs** — job description, master CV (EN/PT toggle), LaTeX template and optional pitch,
   with file upload, "↺ default" buttons (restore from `data/`), **library dropdowns**
   (copy a global master/template into the section) and **"save as model"** buttons
   (bookmark).
   **Generate CV_OUT.md** and **cover.md** via the LLM (one-shot, with spinner + progress bar).
2. **Markdown** — edit/copy/download CV_OUT.md and cover.md. **Convert to LaTeX** → CV.tex
   (same prompt as `gen-pdf`: extracts the template's skeleton and fills it with the CV).
3. **LaTeX → PDF** — edit CV.tex (or upload a ready-made .tex, skipping the LLM),
   **Compile PDF** with the wasm engine → viewer + download. Next to the PDF, the
   **"Job assistant" chat** answers questions and suggests improvements based on the
   section's context.

### Global menu (sidebar) and library

- Open buttons: **hamburger** (Library tab) and **LLM** in the header (LLM tab); closes with
  X, the backdrop, or `Esc`.
- **Library**: up to **2 master CVs** (each with an EN/PT language) and **2 .tex templates**,
  with name, inline editing, upload and deletion (confirmation modal). Auto-seeded on first
  run ("Master EN (default)" + "CV_ATS (default)" from `data/`).
- **Per-section copy**: picking an item from a card's dropdown (Step 1) **copies** its content
  into the section, which stays editable/independent (`s.masterId`/`s.templateId` flip to
  "customized" if the user edits on top). A new section inherits the current one.
- **Save as model**: captures the active section's master/template into the library (the
  bookmark button on the card, or the equivalent action in the sidebar); limit of 2 with a
  toast.
- **LLM config** lives in the sidebar's LLM tab (same `#cfg-*` IDs); keys/urls in localStorage.
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
- No API key: an error bubble with a button that opens the sidebar on the LLM tab.

### UI (theme, toasts, modals)

- **Dark/light themes** via `data-theme` on `<html>`; toggle in the header; persisted in
  `localStorage["riki.theme"]`; falls back to `prefers-color-scheme`.
- **Toasts** (`#toasts`) replace ephemeral feedback; **custom modals**
  (`modal.confirm/prompt/alert`) replace native `prompt/confirm/alert` (create/rename/
  delete section, save model, clear chat, library deletions).
- Indeterminate progress bar + button spinner during LLM generation/compile;
  character counters; copy buttons; stepper with done/active states.

### LLM (tell-ai sdk)

- Generation via `TellSDK.tell` (the CLI's `tell --no-exec` as a function): no-exec system
  prompt, model by alias or full spec (`j`, `d`, `g`, `openai:gpt-5.6-sol:high`…),
  `thinking`/`<RUN>` tags stripped, one-shot (no streaming).
- **Global config** in the "LLM" panel: Model field (default `j` = google:gemini-3.5-flash-lite)
  + a grid of 13 vendors (openai, anthropic, google, deepseek, xai, cerebras, fireworks,
  moonshotai, openrouter, alibaba, zai, vast, local) with key and base URL. The URLs come
  **pre-filled** with the official endpoints (direct route); if the browser blocks it, swap
  the field for your own CORS proxy URL (second route). Details in `docs/llm-base-url.md`.
  Everything lives in localStorage.
- Automatic migration of the legacy config (`apiKey`→`keys.openai`, `baseURL`→`urls.openai`).
- The SDK's IIFE bundle is self-contained (defines its own `process`, no `require()` of node
  builtins) — it loads straight into the browser, no shims.

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
