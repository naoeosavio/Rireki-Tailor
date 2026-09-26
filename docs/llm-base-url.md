# LLM providers — when a Base URL is needed

Guide to the **LLM** panel (sidebar, LLM tab): a **Model** field + 13 vendor
rows (`openai`, `anthropic`, `google`, `deepseek`, `xai`, `cerebras`,
`fireworks`, `moonshotai`, `openrouter`, `alibaba`, `zai`, `vast`, `local`),
each with a **key** and a **base url**.
Everything lives in `localStorage["riki.config"]` (`{ model, keys, urls }`) and
is handed to `TellSDK.tell` (`src/js/llm.js`). The **Test connection** button
runs `llmTest()` (expected reply: `OK — model replied: ...`).

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
| `vast` | **Yes** | — (your own Vast.ai server URL) | `vast:<instance-model>` |
| `local` | No (Ollama default) | `http://localhost:11434/v1` | `local:llama3.1` |

Routing details (SDK in `src/vendor/tell/browser.js`):

* A model with `/` goes to the **openrouter** vendor
  (e.g. `z-ai/glm-5.3-flash`). The explicit form also works:
  `openrouter:z-ai/glm-5.3-flash`.
* `alibaba`, `zai`, `vast` and `local` require the colon form
  (`vendor:model[:thinking]`, e.g. `alibaba:qwen-max:high`): with a `/` the
  model would fall onto the openrouter route.
* General form: `alias` (e.g. `j`, `z`, `a`) or `vendor:model:thinking`
  (e.g. `openai:gpt-4o-mini:high`).
* `vast`/`local` do not use a key (the SDK sends `apiKey: "not-needed"`);
  the key fields on those rows are optional.
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
| `baseURL must be a non-empty string` | Empty URL on a vendor that requires one (openrouter, vast) | Fill in the table's `Default` (vast: your own server URL) |
| HTTP 404 with a duplicated `/chat/completions` | You pasted the full URL into the field | Go back to just the base (`.../v1`) |
| HTTP 401 | Wrong or missing vendor key | Check `cfg-key-<vendor>` for the model in use (`alibaba` uses the intl default; China region: switch to the DashScope CN URL) |
| CORS/network failure in the browser | Provider blocks browser access | Use **Route 2** (proxy) |
| `NO_KEY` / `Incomplete LLM config` | No key filled in | Fill in the key for the model's vendor |

## Security

Keys stay only in your browser's `localStorage`. The JSON export
(`riki-secoes-*.json`, `exportSections` in `src/js/app.js`) already strips the
keys — it includes only `model` and `urls`.
