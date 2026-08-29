# tell-ai sdk (vendored)

Native ESM vendoring of the [`@tell-ai/sdk`](https://github.com/naoeosavio/Tell-ai) (v0.2.1)
used by RirekiTailor Web for LLM generation. No bundler.

| File | Purpose |
|---|---|
| `browser.js` | Cópia de `node_modules/@tell-ai/sdk/dist/browser.js` — o build **ESM** do SDK (self-contained: `ai`, `@ai-sdk/*`, `zod` etc. já embutidos, `export{...}` reais, define seu próprio `process`). Alvo do import map. |
| `sdk.js` | Entry module: `export * as TellSDK from "@tell-ai/sdk"` (namespace re-export, ES2020) + `globalThis.TellSDK = TellSDK`. Carregado com `<script type="module">`. |

Carregado em `index.html` via import map:

```html
<script type="importmap">{"imports":{"@tell-ai/sdk":"./vendor/tell/browser.js"}}</script>
<script type="module" src="vendor/tell/sdk.js"></script>
```

Expõe `window.TellSDK` (tell, create_ask_ai, extract_runs, MODELS, resolve_model_spec,
get_system_prompt, strip_*_tags, summarize_context).

Update: `npm update @tell-ai/sdk`, então re-copiar `dist/browser.js` para `browser.js`.

License: MIT (see https://github.com/naoeosavio/Tell-ai).