# tell-ai sdk + core (vendored)

Native ESM vendoring of the [`@tell-ai/sdk`](https://github.com/naoeosavio/Tell-ai) (v0.4.1)
and the [`@tell-ai/core`](https://github.com/naoeosavio/Tell-ai) (v0.1.2)
used by RirekiTailor Web for LLM generation. No bundler.

| File | Purpose |
|---|---|
| `browser.js` | Cópia de `node_modules/@tell-ai/sdk/dist/browser.js` — o build **ESM** do SDK (self-contained: `ai`, `@ai-sdk/*`, `zod` etc. já embutidos, `export{...}` reais, define seu próprio `process`). Alvo do import map. |
| `core.browser.js` | Cópia de `node_modules/@tell-ai/core/dist/browser.js` — o build **ESM** do core (self-contained, sem `import` nem `require` de fora). Alvo do import map. |
| `sdk.js` | Entry module: `export * as TellSDK from "@tell-ai/sdk"` (namespace re-export, ES2020) + `globalThis.TellSDK = TellSDK`. Carregado com `<script type="module">`. |
| `core.js` | Entry module: `export * as TellCore from "@tell-ai/core"` + `globalThis.TellCore = TellCore`. O chat corta o histórico com `truncate_context` do core. |

Carregado em `index.html` via import map:

```html
<script type="importmap">{"imports":{"@tell-ai/sdk":"./vendor/tell/browser.js","@tell-ai/core":"./vendor/tell/core.browser.js"}}</script>
<script type="module" src="vendor/tell/sdk.js"></script>
<script type="module" src="vendor/tell/core.js"></script>
```

Expõe `window.TellSDK` (tell, create_ask_ai, extract_runs, MODELS, resolve_model_spec,
get_system_prompt, get_model, sanitize_reasoning, strip_*_tags, summarize_context,
list_custom_models, custom_headers, resolve_wire) e `window.TellCore` (runtime, loop,
limites de runtime, `truncate_context`, `split_context_turns`, risk, chain decision).

O app usa `TellCore.create_core_runtime` (o runtime e o loop) e `TellSDK.create_ask_ai`
(o model port). O `tell` do sdk fica disponível para uso direto.

O `src/scripts/serve.js` usa a entrada **Node** do core (`@tell-ai/core`): `canonical_path` /
`canonical_write_path` (caminhos fail-closed) e `build_sdk_config_from_env` (a chave no
servidor).

Update: `npm update @tell-ai/sdk @tell-ai/core`, então re-copiar `dist/browser.js` do SDK para
`browser.js` e `dist/browser.js` do core para `core.browser.js`.

License: MIT (see https://github.com/naoeosavio/Tell-ai).
