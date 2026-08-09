# tell-ai sdk (vendored)

Browser bundle of the [`@tell-ai/sdk`](https://github.com/naoeosavio/Tell-ai) (v0.1.0)
used by RirekiTailor Web for LLM generation.

| File | Purpose |
|---|---|
| `tell.bundle.js` | IIFE bundle exposing `window.TellSDK` (tell, create_ask_ai, MODELS, resolve_model_spec, get_system_prompt, strip_*_tags, summarize_context). Built from the SDK source with tsup: `src/browser-global.ts` -> `format: iife`, `noExternal: ['ai','@ai-sdk/*']`. |
| `node-shims.js` | Browser stubs for node builtins (`require` returning minimal `path`/`fs`/`os`/`crypto`/... modules + a `process` global). Required because the AI-SDK auth-config helpers `require()` them at module scope; we always pass explicit `apiKey`/`baseURL`, so the auth helpers are never exercised. |

License: GPL-3.0 (see https://github.com/naoeosavio/Tell-ai).
