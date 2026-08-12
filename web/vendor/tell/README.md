# tell-ai sdk (vendored)

Browser bundle of the [`@tell-ai/sdk`](https://github.com/naoeosavio/Tell-ai) (v0.2.0)
used by RirekiTailor Web for LLM generation.

| File | Purpose |
|---|---|
| `tell.bundle.js` | IIFE bundle exposing `window.TellSDK` (tell, create_ask_ai, MODELS, resolve_model_spec, get_system_prompt, strip_*_tags, summarize_context). Copied verbatim from the npm package: `node_modules/@tell-ai/sdk/dist/browser-global.global.js`. Self-contained — defines its own `process` and performs no `require()` calls, so no node shims are needed. |

To update: `npm update @tell-ai/sdk`, then re-copy `dist/browser-global.global.js` here.

License: MIT (see https://github.com/naoeosavio/Tell-ai).