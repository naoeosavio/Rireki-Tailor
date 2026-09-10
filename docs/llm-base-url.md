# Provedores LLM — quando a Base URL é necessária

Guia do painel **LLM** (sidebar, aba LLM): campo **Model** + 13 linhas de
vendor (`openai`, `anthropic`, `google`, `deepseek`, `xai`, `cerebras`,
`fireworks`, `moonshotai`, `openrouter`, `alibaba`, `zai`, `vast`, `local`),
cada uma com **key** e **base url**.
Tudo fica em `localStorage["riki.config"]` (`{ model, keys, urls }`) e é
repassado a `TellSDK.tell` (`src/js/llm.js`). O botão **Testar conexão**
roda `llmTest()` (resposta esperada: `OK — modelo respondeu: ...`).

## Regra do campo Base URL

Informe **só a base** (o SDK completa com `/chat/completions`).
Com ou sem `/` no final — o SDK normaliza. Exemplos:

```text
certo:  https://openrouter.ai/api/v1
errado: https://openrouter.ai/api/v1/chat/completions
```

## Tabela dos vendors

`Padrão` = valor já pré-preenchido no app (editável). `Exige` = sem ele
a chamada falha (ver coluna de erros). `—` = sem default confiável:
preencha o campo.

| Vendor | Exige URL? | Padrão pré-preenchido | Exemplo de Model |
|---|---|---|---|
| `openai` | Não (tem default) | `https://api.openai.com/v1` | `gpt-4o-mini` |
| `anthropic` | Não (tem default) | `https://api.anthropic.com` | `claude-sonnet-4-6` |
| `google` | Não (tem default) | `https://generativelanguage.googleapis.com/v1beta` | `gemini-2.5-flash` |
| `deepseek` | Não (tem default) | `https://api.deepseek.com/v1` | `deepseek-chat` |
| `xai` | Não (tem default) | `https://api.x.ai/v1` | `grok-4` |
| `cerebras` | Não (tem default) | `https://api.cerebras.ai/v1` | `llama-3.3-70b` |
| `fireworks` | Não (tem default) | `https://api.fireworks.ai/inference/v1` | `llama-v3p1-8b-instruct` |
| `moonshotai` | Não (tem default) | `https://api.moonshot.ai/v1` | `kimi-k2` |
| `openrouter` | **Sim** | `https://openrouter.ai/api/v1` | `z-ai/glm-5.3-flash` |
| `alibaba` | **Sim** | — (endpoint DashScope `compatible-mode` da sua região) | `alibaba:qwen-max` |
| `zai` | Não (tem default) | `https://api.z.ai/api/paas/v4` | `zai:glm-5.3` (ou atalho `z`) |
| `vast` | **Sim** | — (URL do seu servidor Vast.ai) | `vast:<modelo-da-instancia>` |
| `local` | Não (padrão Ollama) | `http://localhost:11434/v1` | `local:llama3.1` |

Detalhes de roteamento (SDK em `src/vendor/tell/browser.js`):

* Modelo com `/` vai para o vendor **openrouter**
  (ex. `z-ai/glm-5.3-flash`). Forma explícita também vale:
  `openrouter:z-ai/glm-5.3-flash`.
* `alibaba`, `zai`, `vast` e `local` exigem a forma com dois-pontos
  (`vendor:model[:thinking]`, ex. `alibaba:qwen-max:high`): com `/`
  o modelo cairia na rota openrouter.
* Forma geral: `alias` (ex. `j`, `z`, `a`) ou `vendor:model:thinking`
  (ex. `openai:gpt-4o-mini:high`).
* `vast`/`local` não usam key (o SDK envia `apiKey: "not-needed"`);
  os campos de key dessas linhas são opcionais.
* Interno: o SDK lê o vendor `zai` sob os nomes `zhipu`
  (`keys.zhipu`/`urls.zhipu`); o app (`tellCfg` em `src/js/llm.js`)
  espelha automaticamente — preencha só a linha `zai`.

## Duas vias: direta (padrão) e proxy (fallback)

**Via 1 — direta (padrão).** Os campos já vêm preenchidos com as URLs
oficiais acima. Se o provedor libera chamadas de browser (OpenRouter
libera), basta colocar a key e testar. É o caminho recomendado.

**Via 2 — proxy CORS (fallback).** Se o browser bloquear a chamada direta
(erro de CORS/rede) ou a rede exigir saída por proxy, troque **só o campo
URL** da linha do vendor pela base do seu proxy OpenAI-compatible,
mantendo key e model. Exemplo de formato (qualquer proxy compatível):

```text
https://SEU-PROXY/exemplo/v1
```

Nada mais muda: o app envia o mesmo `model`, `keys` e `urls` ao SDK.
Para voltar à via direta, restaure o valor da coluna `Padrão` acima.

## Caso guiado: OpenRouter + GLM 5.3 Flash

1. `cfg-model` = `z-ai/glm-5.3-flash`
2. `cfg-key-openrouter` = sua key `sk-or-...` (da OpenRouter, não da Z.ai)
3. `cfg-url-openrouter` = `https://openrouter.ai/api/v1` (já vem preenchido)
4. **Testar conexão** e conferir `OK — modelo respondeu`.

Atenção: os atalhos `z`, `z-`, `z+` do SDK apontam para a rota direta
Zhipu (`zai:glm-5.3`), não para a OpenRouter. Para usar via OpenRouter,
use sempre o slug com `/`.

## Erros comuns

| Erro | Causa | Ação |
|---|---|---|
| `baseURL must be a non-empty string` | URL vazia em vendor que exige (openrouter, vast) | Preencher com o `Padrão` da tabela (vast: URL do seu servidor) |
| HTTP 404 com `/chat/completions` duplicado | Colou a URL completa no campo | Voltar para só a base (`.../v1`) |
| HTTP 401 | Key do vendor errado ou ausente — ou URL vazia no `alibaba` (cai no endpoint errado) | Conferir `cfg-key-<vendor>` do modelo em uso; no `alibaba`, preencher a URL do DashScope |
| Falha de CORS/rede no browser | Provedor bloqueia browser | Usar a **Via 2** (proxy) |
| `NO_KEY` / `Config LLM incompleta` | Nenhuma key preenchida | Preencher a key do vendor do modelo |

## Segurança

Keys ficam só no `localStorage` do seu browser. O export JSON
(`riki-secoes-*.json`, `exportSections` em `src/js/app.js`) já remove as
keys — inclui só `model` e `urls`.
