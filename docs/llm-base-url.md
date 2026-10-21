# LLM providers — when a Base URL is needed

Guide to the **LLM** panel (setup block, top of the app): a **Model** field + 12 vendor
rows (`openai`, `anthropic`, `google`, `deepseek`, `xai`, `cerebras`,
`fireworks`, `moonshotai`, `openrouter`, `alibaba`, `zai`, `custom`),
each with a **key** and a **base url**.
Everything lives in `localStorage["riki.config"]` (`{ model, keys, urls, models }`) and
is handed to the core runtime (`src/js/llm.js`). The **Test connection** button
runs `llmTest()` (expected reply: `OK — model replied: ...`).

The **Model** field completes with the aliases of the sdk (152 entries) of the chosen
provider, and the hint under the field shows the resolved spec
(`openai · gpt-6.1-sol · medium`). Each provider row keeps its own model in
`config.models`, so switching rows and coming back keeps the model.

## The key on the server (dev server / VPS)

The dev server can hold the key, so the browser never sees it and the call never needs CORS.

| Env | Meaning |
|---|---|
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` (or `GEMINI_API_KEY`), `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `CEREBRAS_API_KEY`, `MOONSHOTAI_API_KEY`, `OPENROUTER_API_KEY`, `ALIBABA_API_KEY`, `ZHIPU_API_KEY` | the key of the vendor |
| `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, … | the base url of the vendor (a proxy, for example) |
| `TELL_MODEL` | the default model of the server (an alias or a full spec) |

The mapping is the one of the core (`build_sdk_config_from_env`), so the CLI and this server
read the same env. The browser asks `GET /api/llm/config` what the server holds and sends the
call to `POST /api/llm` when the browser has no key of that vendor. A key in the browser wins.

The endpoint calls only the vendors of the env, so it is not an open proxy. It answers 503
when the server holds no key, 403 to a cross-origin request, 400 to a payload without a
message, and 413 to a payload over the caps of the core.

## The Base URL field rule

Enter **only the base** (the SDK appends `/chat/completions`).
With or without a trailing `/` — the SDK normalizes it. Examples:

```text
right:  https://openrouter.ai/api/v1
wrong:  https://openrouter.ai/api/v1/chat/completions
```

## Vendor table

`Default` = value already pre-filled in the app (editable). `Required` =
without it the call fails (see the errors column). `—` = no reliable default:
fill the field in.

| Vendor | URL required? | Pre-filled default | Model example |
|---|---|---|---|
| `openai` | No (has a default) | `https://api.openai.com/v1` | `gpt-4o-mini` |
| `anthropic` | No (has a default) | `https://api.anthropic.com` | `claude-sonnet-4-6` |
| `google` | No (has a default) | `https://generativelanguage.googleapis.com/v1beta` | `gemini-2.5-flash` |
| `deepseek` | No (has a default) | `https://api.deepseek.com/v1` | `deepseek-chat` |
| `xai` | No (has a default) | `https://api.x.ai/v1` | `grok-4` |
| `cerebras` | No (has a default) | `https://api.cerebras.ai/v1` | `llama-3.3-70b` |
| `fireworks` | No (has a default) | `https://api.fireworks.ai/inference/v1` | `llama-v3p1-8b-instruct` |
| `moonshotai` | No (has a default) | `https://api.moonshot.ai/v1` | `kimi-k2` |
| `openrouter` | **Yes** | `https://openrouter.ai/api/v1` | `z-ai/glm-5.3-flash` |
| `alibaba` | No (has an intl default) | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `alibaba:qwen-max` |
| `zai` | No (has a default) | `https://api.z.ai/api/paas/v4` | `zai:glm-5.3` (or the `z` shortcut) |
| `custom` | **Yes** | — (your own endpoint URL) | `custom:kimi-k3` |

Routing details (SDK in `src/vendor/tell/browser.js`, custom shim in `src/js/llm.js`):

* A model with `/` goes to the **openrouter** vendor
  (e.g. `z-ai/glm-5.3-flash`). The explicit form also works:
  `openrouter:z-ai/glm-5.3-flash`.
* `alibaba`, `zai` and `custom` require the colon form
  (`vendor:model[:thinking]`, e.g. `alibaba:qwen-max:high`): with a `/` the
  model would fall onto the openrouter route.
* General form: `alias` (e.g. `j`, `z`, `a`) or `vendor:model:thinking`
  (e.g. `openai:gpt-4o-mini:high`).
* `custom` is a generic user-supplied endpoint (any OpenAI-shaped API).
  The app calls it directly with fetch, not through the SDK: `custom:<model>`
  posts to `<url>/chat/completions` (or `<url>/responses` with API type
  `responses`, or `<url>/messages` with API type `messages`), sends the key as
  `Bearer` auth (the `messages` wire uses `x-api-key` plus
  `anthropic-version`) plus the extra JSON headers, and reads the reply text.
  Keyless endpoints work: only the URL is required.
  The API type `auto` lets the sdk infer the wire from the model id: a
  `gpt-`, `grok-` or `muse-` id uses `responses`, a `claude-` id uses
  `messages`, the rest uses `chat`.
  The **model list** button asks the endpoint (`GET <url>/models`) and fills
  the picker with the ids and the wire of each one. The endpoint needs a key
  for that request.
  Example (opencode zen): URL `https://opencode.ai/zen/go/v1`, model
  `muse-spark-1.3-contributor`, key `$OPENCODE_API_KEY`, API `chat`,
  headers `{"x-opencode-session":"$OPENCODE_SESSION_ID"}`.
* Internally: the SDK reads the `zai` vendor under the `zhipu` names
  (`keys.zhipu`/`urls.zhipu`); the app (`tellCfg` in `src/js/llm.js`)
  mirrors them automatically — just fill in the `zai` row.

## Two routes: direct (default) and proxy (fallback)

**Route 1 — direct (default).** The fields already come filled with the
official URLs above. If the provider allows browser calls (OpenRouter does),
just enter the key and test. This is the recommended path.

**Route 2 — CORS proxy (fallback).** If the browser blocks the direct call
(CORS/network error) or the network requires a proxy egress, replace **only
the URL field** of the vendor row with the base of your OpenAI-compatible
proxy, keeping the key and model. Format example (any compatible proxy):

```text
https://YOUR-PROXY/example/v1
```

Nothing else changes: the app sends the same `model`, `keys` and `urls` to
the SDK. To go back to the direct route, restore the value from the `Default`
column above.

## Guided case: OpenRouter + GLM 5.3 Flash

1. `cfg-model` = `z-ai/glm-5.3-flash`
2. `cfg-key-openrouter` = your `sk-or-...` key (from OpenRouter, not Z.ai)
3. `cfg-url-openrouter` = `https://openrouter.ai/api/v1` (already pre-filled)
4. **Test connection** and check for `OK — model replied`.

Note: the SDK's `z`, `z-`, `z+` shortcuts point at the direct Zhipu route
(`zai:glm-5.3`), not at OpenRouter. To go through OpenRouter, always use the
slug with the `/`.

## Common errors

| Error | Cause | Action |
|---|---|---|
| `baseURL must be a non-empty string` | Empty URL on a vendor that requires one (openrouter, custom) | Fill in the table's `Default` (custom: your own endpoint URL) |
| HTTP 404 with a duplicated `/chat/completions` | You pasted the full URL into the field | Go back to just the base (`.../v1`) |
| HTTP 401 | Wrong or missing vendor key | Check `cfg-key-<vendor>` for the model in use (`alibaba` uses the intl default; China region: switch to the DashScope CN URL) |
| CORS/network failure in the browser | Provider blocks browser access | Use **Route 2** (proxy) |
| `NO_KEY` / `Incomplete LLM config` | No key filled in | Fill in the key for the model's vendor |

## Security

Keys stay only in your browser's `localStorage`. The JSON export
(`riki-secoes-*.json`, `exportSections` in `src/js/app.js`) already strips the
keys — it includes only `model`, `urls` and `models`.
