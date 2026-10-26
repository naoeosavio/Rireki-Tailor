// LLM layer — tell-ai core runtime over the tell-ai sdk.
// The core owns the prompt, the no-exec protocol, the tags and the loop.
// The app owns the config (model alias/spec + keys/urls per vendor) and the
// model port (one sdk ask instance, or the custom endpoint).
// Config: model alias/spec + keys/urls per vendor (localStorage, via app config).
// Urls fall back to DEFAULT_URLS (same as docs/llm-base-url.md), so the
// direct way works out of the box; replace any entry with a CORS proxy
// URL as fallback when the browser blocks the direct call.

/* The vendors of the sdk. The list follows the sdk: a vendor that the sdk
 * does not know cannot be called (`Unsupported vendor for model`). */
const LLM_VENDORS = [
  'openai', 'anthropic', 'google', 'deepseek', 'xai',
  'cerebras', 'moonshotai', 'openrouter',
  'alibaba', 'zai', 'meta', 'xiaomi', 'custom',
];

/* The messages API needs a token limit. The value is the cap of one answer
 * of the chat. */
const CUSTOM_MAX_TOKENS = 8192;

// Official direct base URLs, pre-filled by default (primary way).
// They are the defaults of the sdk, so the app and the sdk always talk to
// the same endpoint. Keep in sync with docs/llm-base-url.md. Loaded
// before app.js, so app.js backfills them into the visible config form.
// Vendors without entry here have no reliable default: fill the
// URL field (custom: your own endpoint URL) or the SDK call fails.
const DEFAULT_URLS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  deepseek: 'https://api.deepseek.com',
  xai: 'https://api.x.ai/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  moonshotai: 'https://api.moonshot.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  alibaba: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  zai: 'https://api.z.ai/api/paas/v4',
  meta: 'https://api.meta.ai/v1',
  xiaomi: 'https://api.xiaomimimo.com/v1',
};

function tellCfg(config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const keys = {};
  const urls = {};
  LLM_VENDORS.forEach((v) => {
    /* Only a string passes. A number or an object in the key map reaches
     * the SDK as a header value and breaks the request. */
    if (cfg.keys && typeof cfg.keys[v] === 'string' && cfg.keys[v]) keys[v] = cfg.keys[v];
    if (cfg.urls && typeof cfg.urls[v] === 'string' && cfg.urls[v]) {
      urls[v] = cfg.urls[v];
    } else if (DEFAULT_URLS[v]) {
      urls[v] = DEFAULT_URLS[v];
    } else {
      // No default for this vendor — leave it out entirely.
    }
  });
  // The SDK reads the zai vendor under the "zhipu" key names, so
  // mirror them; otherwise zai keys/urls would be silently ignored.
  if (keys.zai && !keys.zhipu) keys.zhipu = keys.zai;
  if (urls.zai && !urls.zhipu) urls.zhipu = urls.zai;
  const out = { model: typeof cfg.model === 'string' && cfg.model ? cfg.model : 'g', keys, urls };
  if (typeof cfg.customApi === 'string' && cfg.customApi) out.customApi = cfg.customApi;
  if (typeof cfg.customHeaders === 'string' && cfg.customHeaders) out.customHeaders = cfg.customHeaders;
  return out;
}

// custom: is not an SDK vendor. The app calls the user endpoint directly
// with fetch, so custom key, URL, API type, and headers all take effect.
function customModelOf(model) {
  const m = /^\s*custom\s*:\s*(.+?)\s*$/.exec(model || '');
  return m ? m[1] : null;
}

function customHeadersOf(cfg) {
  const value = cfg && cfg.customHeaders;
  const raw = (typeof value === 'string' ? value : '').trim();
  if (!raw) return {};
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    throw new Error('Custom headers are not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Custom headers must be a JSON object.');
  }
  return parsed;
}

function customTextOf(data, api) {
  if (api === 'responses') {
    const out = data && Array.isArray(data.output) ? data.output : [];
    for (let i = 0; i < out.length; i++) {
      const parts = out[i] && Array.isArray(out[i].content) ? out[i].content : [];
      for (let j = 0; j < parts.length; j++) {
        if (typeof parts[j].text === 'string' && parts[j].text) return parts[j].text;
      }
    }
    throw new Error('Custom endpoint returned no text.');
  } else if (api === 'messages') {
    const out = data && Array.isArray(data.content) ? data.content : [];
    for (let i = 0; i < out.length; i++) {
      if (out[i] && typeof out[i].text === 'string' && out[i].text) return out[i].text;
    }
    throw new Error('Custom endpoint returned no text.');
  } else {
    const text = data && data.choices && data.choices[0] && data.choices[0].message
      && data.choices[0].message.content;
    if (typeof text !== 'string' || !text) throw new Error('Custom endpoint returned no text.');
    return text;
  }
}

// Same-origin forward through the dev server. Rescues endpoints without
// CORS headers. Missing on static hosting — the caller keeps the direct
// error in that case.
async function postViaProxy(url, headers, body) {
  if (typeof location === 'undefined' || !location.origin) {
    throw new Error('no proxy origin');
  }
  const res = await fetch(location.origin + '/api/llm-forward', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: url, headers: headers, body: body }),
  });
  if (!res.ok) throw new Error('proxy HTTP ' + res.status);
  const data = await res.json();
  if (!data || typeof data.status !== 'number' || typeof data.text !== 'string') {
    throw new Error('proxy returned an invalid payload');
  }
  return { status: data.status, text: data.text };
}

/* The wire of the custom endpoint. The SDK owns the rule: a model id that
 * starts with gpt-, grok- or muse- uses the responses API, a claude- model
 * the messages API, the rest the chat API. The user can pin the wire. */
function customWire(cfg) {
  const api = cfg && typeof cfg.customApi === 'string' ? cfg.customApi : 'auto';
  if (api === 'chat' || api === 'responses' || api === 'messages') return api;
  const name = customModelOf(cfg && cfg.model) || '';
  const sdk = typeof window !== 'undefined' ? window.TellSDK : null;
  if (sdk && typeof sdk.resolve_wire === 'function') return sdk.resolve_wire(name);
  return 'chat';
}

/* The model list of the custom endpoint. The SDK does the request, the
 * dedup, the sort and the wire of every id. */
async function customModels(config) {
  const cfg = tellCfg(config);
  const sdk = typeof window !== 'undefined' ? window.TellSDK : null;
  if (!sdk || typeof sdk.list_custom_models !== 'function') {
    throw new Error('TellSDK not loaded (@tell-ai/sdk).');
  }
  if (!cfg.urls.custom) throw new Error('Custom vendor needs the endpoint URL.');
  if (!cfg.keys.custom) throw new Error('The model list needs the API key of the endpoint.');
  return await sdk.list_custom_models({ keys: cfg.keys, urls: cfg.urls });
}

/* The core strips the balanced think and run blocks. A block that the model
 * left open stays in the text, and the cut removes it. */
function cleanAnswer(text) {
  const value = typeof text === 'string' ? text : '';
  const core = typeof globalThis !== 'undefined' ? globalThis.TellCore : null;
  if (!core || typeof core.has_balanced_tags !== 'function') return value;
  if (core.has_balanced_tags(value)) return value;
  const cut = value.search(/<\/?(?:think|run)>/i);
  return cut >= 0 ? value.slice(0, cut).trim() : value;
}

async function customChat(message, cfg, opts) {
  const base = (cfg.urls.custom || '').replace(/\/+$/, '');
  if (!base) throw new Error('Custom vendor needs the endpoint URL.');
  const name = customModelOf(cfg.model);
  if (!name) throw new Error('Custom model needs a name after "custom:".');
  const wire = customWire(cfg);
  const key = cfg.keys.custom;
  const headers = Object.assign({}, customHeadersOf(cfg));
  /* The core already put the context into the message. The endpoint gets
   * the same prompt as every other vendor. */
  const system = opts && opts.system ? opts.system : '';
  let body = null;
  let path = '/chat/completions';
  if (wire === 'messages') {
    path = '/messages';
    if (key) headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model: name,
      max_tokens: CUSTOM_MAX_TOKENS,
      messages: [{ role: 'user', content: message }],
    };
    if (system) body.system = system;
  } else if (wire === 'responses') {
    path = '/responses';
    if (key) headers['Authorization'] = 'Bearer ' + key;
    body = { model: name, input: message };
    if (system) body.instructions = system;
  } else {
    if (key) headers['Authorization'] = 'Bearer ' + key;
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: message });
    body = { model: name, messages: messages };
  }
  headers['Content-Type'] = 'application/json';
  const fullUrl = base + path;
  let status = 0;
  let text = '';
  try {
    const res = await fetch(fullUrl, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
    });
    status = res.status;
    text = await res.text();
  } catch (directErr) {
    // Network failure (offline, DNS, or CORS block). HTTP errors never
    // reach here — they already carry the endpoint answer.
    let proxied = null;
    try {
      proxied = await postViaProxy(fullUrl, headers, body);
    } catch (_) {
      throw new Error('Custom endpoint unreachable: ' + directErr.message);
    }
    status = proxied.status;
    text = proxied.text;
  }
  if (status < 200 || status >= 300) {
    throw new Error('Custom endpoint error HTTP ' + status + ': ' + text.slice(0, 200));
  }
  return customTextOf(JSON.parse(text), wire);
}

/* The server can hold the key. The probe asks once per page: a static
 * host has no endpoint and the browser keeps its own key. */
let serverInfo = null;
let serverInfoAsked = false;

async function serverConfig() {
  if (serverInfoAsked) return serverInfo;
  serverInfoAsked = true;
  try {
    const res = await fetch('/api/llm/config', { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      serverInfo = null;
      return null;
    }
    const data = await res.json();
    serverInfo = data && data.enabled ? data : null;
  } catch (_) {
    serverInfo = null;
  }
  return serverInfo;
}

/* The vendor of a model spec. An alias of the sdk carries its vendor. */
function modelVendor(model) {
  const sdk = typeof window !== 'undefined' ? window.TellSDK : null;
  if (sdk && typeof sdk.resolve_model_spec === 'function') {
    try {
      return sdk.resolve_model_spec(model).vendor;
    } catch (_) {
      /* The spec is unknown: the prefix is the best guess. */
    }
  }
  const m = /^\s*([A-Za-z]+)\s*:/.exec(model || '');
  return m ? m[1].toLowerCase() : null;
}

/* The server holds the key of the vendor: the browser sends the call to
 * the server. A key in the browser wins. */
async function serverHoldsKey(cfg) {
  if (customModelOf(cfg.model)) return false;
  const vendor = modelVendor(cfg.model);
  if (!vendor) return false;
  if (cfg.keys && cfg.keys[vendor]) return false;
  const info = await serverConfig();
  if (!info || !Array.isArray(info.vendors)) return false;
  return info.vendors.indexOf(vendor) !== -1;
}

async function serverAsk(message, cfg, system) {
  const res = await fetch('/api/llm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, message: message, system: system }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data && data.error ? data.error : 'The server refused the call (HTTP ' + res.status + ').');
  }
  if (!data || typeof data.text !== 'string') throw new Error('The server returned no answer.');
  return data.text;
}

/* The core owns the cancel token. The runtime checks it before and after
 * the model call, so a cancelled run never lands. */
function createCancelToken() {
  const core = typeof window !== 'undefined' ? window.TellCore : null;
  if (!core || typeof core.create_cancellation_token !== 'function') return null;
  return core.create_cancellation_token();
}

/* The core owns the default model of the web host. */
function defaultModel() {
  const core = typeof window !== 'undefined' ? window.TellCore : null;
  if (core && core.HOST_DEFAULT_MODEL && typeof core.HOST_DEFAULT_MODEL.web === 'string') {
    return core.HOST_DEFAULT_MODEL.web;
  }
  return 'j';
}

function llmMissingKeyError(cfg) {
  const err = new Error('Incomplete LLM config: provide the API key for the model\'s vendor (' + cfg.model + ').');
  err.code = 'NO_KEY';
  return err;
}

async function assertKey(config) {
  const cfg = tellCfg(config);
  if (customModelOf(cfg.model)) {
    if (!cfg.urls.custom) throw new Error('Custom vendor needs the endpoint URL.');
    return cfg;
  }
  if (Object.values(cfg.keys).some(Boolean)) return cfg;
  /* The server can hold the key of the vendor. */
  if (await serverHoldsKey(cfg)) return cfg;
  throw llmMissingKeyError(cfg);
}

/* The model port of the core. The core sends the whole prompt (the system
 * prompt and the context are already composed) and expects the raw answer.
 * The core strips the think and run tags of the answer. */
function modelPort(cfg) {
  return {
    ask: async (message, options) => {
      const system = options && typeof options.system === 'string' ? options.system : '';
      if (customModelOf(cfg.model)) {
        return await customChat(message, cfg, { system: system });
      }
      /* The server holds the key: the call goes through the server. */
      if (await serverHoldsKey(cfg)) {
        return await serverAsk(message, cfg, system);
      }
      const sdk = window.TellSDK;
      if (!sdk || typeof sdk.create_ask_ai !== 'function') {
        throw new Error('TellSDK not loaded (@tell-ai/sdk).');
      }
      const ai = await sdk.create_ask_ai(cfg.model, { keys: cfg.keys, urls: cfg.urls });
      return await ai.ask(message, { system: system, stream: false });
    },
  };
}

/* The runtime of the core. It owns the prompt, the no-exec protocol and the
 * loop. The exec flag is off: the app never runs a command. */
function coreRuntime(cfg, opts) {
  const core = window.TellCore;
  if (!core || typeof core.create_core_runtime !== 'function') {
    throw new Error('TellCore not loaded (@tell-ai/core).');
  }
  const input = {
    config: core.resolve_core_config({
      host: 'web',
      flag: { model: cfg.model, exec_enabled: false },
    }),
    model: modelPort(cfg),
    platform: 'web browser',
  };
  if (opts && opts.system) input.system = opts.system;
  if (opts && opts.context) input.context = opts.context;
  if (opts && opts.cancellation) input.cancellation = opts.cancellation;
  return core.create_core_runtime(input);
}

/* One turn of the core. The result holds the visible answer, the timeline
 * and the commands the model asked for. */
async function runRuntime(message, cfg, opts) {
  const runtime = coreRuntime(cfg, opts);
  return await runtime.run(message);
}

async function tellChat(userPrompt, config, opts) {
  const cfg = await assertKey(config);
  return cleanAnswer((await runRuntime(userPrompt, cfg, opts || null)).text);
}

// Chat mode: contextual system prompt + accumulated history in `context`.
async function chatTell(message, config, opts) {
  const cfg = await assertKey(config);
  const result = await runRuntime(message, cfg, opts);
  return cleanAnswer(result.text);
}

async function llmTest(config) {
  const out = await tellChat('Reply with exactly: OK', config);
  return 'OK — model replied: "' + out.trim().slice(0, 60) + '"';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LLM_VENDORS: LLM_VENDORS,
    DEFAULT_URLS: DEFAULT_URLS,
    tellCfg: (typeof tellCfg !== 'undefined') ? tellCfg : undefined,
    customWire: (typeof customWire !== 'undefined') ? customWire : undefined,
    customModels: (typeof customModels !== 'undefined') ? customModels : undefined,
    cleanAnswer: (typeof cleanAnswer !== 'undefined') ? cleanAnswer : undefined,
    serverConfig: (typeof serverConfig !== 'undefined') ? serverConfig : undefined,
    createCancelToken: (typeof createCancelToken !== 'undefined') ? createCancelToken : undefined,
    defaultModel: (typeof defaultModel !== 'undefined') ? defaultModel : undefined,
    tellChat: (typeof tellChat !== 'undefined') ? tellChat : undefined,
    chatTell: (typeof chatTell !== 'undefined') ? chatTell : undefined,
    llmTest: (typeof llmTest !== 'undefined') ? llmTest : undefined,
  };
}
