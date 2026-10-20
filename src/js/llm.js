// LLM layer — tell-ai SDK (TellSDK.tell), OpenAI-compatible multi-vendor.
// Config: model alias/spec + keys/urls per vendor (localStorage, via app config).
// Urls fall back to DEFAULT_URLS (same as docs/llm-base-url.md), so the
// direct way works out of the box; replace any entry with a CORS proxy
// URL as fallback when the browser blocks the direct call.

const LLM_VENDORS = [
  'openai', 'anthropic', 'google', 'deepseek', 'xai',
  'cerebras', 'fireworks', 'moonshotai', 'openrouter',
  'alibaba', 'zai', 'custom',
];

// Official direct base URLs, pre-filled by default (primary way).
// Keep in sync with docs/llm-base-url.md. Loaded before app.js,
// so app.js backfills them into the visible config form.
// Vendors without entry here have no reliable default: fill the
// URL field (custom: your own endpoint URL) or the SDK call fails.
const DEFAULT_URLS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  deepseek: 'https://api.deepseek.com/v1',
  xai: 'https://api.x.ai/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  moonshotai: 'https://api.moonshot.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  alibaba: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  zai: 'https://api.z.ai/api/paas/v4',
};

function tellCfg(config) {
  const keys = {};
  const urls = {};
  LLM_VENDORS.forEach((v) => {
    if (config.keys && config.keys[v]) keys[v] = config.keys[v];
    if (config.urls && config.urls[v]) {
      urls[v] = config.urls[v];
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
  const out = { model: config.model || 'g', keys, urls };
  if (typeof config.customApi === 'string' && config.customApi) out.customApi = config.customApi;
  if (typeof config.customHeaders === 'string' && config.customHeaders) out.customHeaders = config.customHeaders;
  return out;
}

// custom: is not an SDK vendor. The app calls the user endpoint directly
// with fetch, so custom key, URL, API type, and headers all take effect.
function customModelOf(model) {
  const m = /^\s*custom\s*:\s*(.+?)\s*$/.exec(model || '');
  return m ? m[1] : null;
}

function customHeadersOf(cfg) {
  const raw = (cfg.customHeaders || '').trim();
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
    const out = Array.isArray(data.output) ? data.output : [];
    for (let i = 0; i < out.length; i++) {
      const parts = out[i] && Array.isArray(out[i].content) ? out[i].content : [];
      for (let j = 0; j < parts.length; j++) {
        if (typeof parts[j].text === 'string' && parts[j].text) return parts[j].text;
      }
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

async function customChat(message, cfg, opts) {
  const base = (cfg.urls.custom || '').replace(/\/+$/, '');
  if (!base) throw new Error('Custom vendor needs the endpoint URL.');
  const name = customModelOf(cfg.model);
  if (!name) throw new Error('Custom model needs a name after "custom:".');
  const api = cfg.customApi === 'responses' ? 'responses' : 'chat';
  const headers = Object.assign(
    { 'Content-Type': 'application/json' },
    cfg.keys.custom ? { Authorization: 'Bearer ' + cfg.keys.custom } : {},
    customHeadersOf(cfg)
  );
  const system = opts && opts.system ? opts.system : '';
  const context = opts && opts.context ? opts.context : '';
  let body = null;
  if (api === 'responses') {
    const input = (context ? context + '\n\n' : '') + message;
    body = { model: name, input: input };
    if (system) body.instructions = system;
  } else {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    if (context) messages.push({ role: 'user', content: context });
    messages.push({ role: 'user', content: message });
    body = { model: name, messages: messages };
  }
  const fullUrl = base + (api === 'responses' ? '/responses' : '/chat/completions');
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
  return customTextOf(JSON.parse(text), api);
}

function llmMissingKeyError(cfg) {
  const err = new Error('Incomplete LLM config: provide the API key for the model\'s vendor (' + cfg.model + ').');
  err.code = 'NO_KEY';
  return err;
}

function assertKey(config) {
  const cfg = tellCfg(config);
  if (customModelOf(cfg.model)) {
    if (!cfg.urls.custom) throw new Error('Custom vendor needs the endpoint URL.');
    return cfg;
  }
  if (!Object.values(cfg.keys).some(Boolean)) throw llmMissingKeyError(cfg);
  return cfg;
}

async function tellChat(userPrompt, config) {
  const cfg = assertKey(config);
  if (customModelOf(cfg.model)) return await customChat(userPrompt, cfg, null);
  const sdk = window.TellSDK;
  if (!sdk || typeof sdk.tell !== 'function') {
    throw new Error('TellSDK not loaded (@tell-ai/sdk).');
  }
  return await sdk.tell(userPrompt, {
    model: cfg.model,
    keys: cfg.keys,
    urls: cfg.urls,
    platform: 'web browser',
  });
}

// Chat mode: contextual system prompt + accumulated history in `context`.
// One-shot per message (TellSDK.tell does not stream in the browser bundle).
async function chatTell(message, config, opts) {
  const cfg = assertKey(config);
  if (customModelOf(cfg.model)) {
    const customOptions = { system: null, context: null };
    if (opts && opts.system) customOptions.system = opts.system;
    if (opts && opts.context) customOptions.context = opts.context;
    return await customChat(message, cfg, customOptions);
  }
  const sdk = window.TellSDK;
  if (!sdk || typeof sdk.tell !== 'function') {
    throw new Error('TellSDK not loaded (@tell-ai/sdk).');
  }
  const options = {
    model: cfg.model,
    keys: cfg.keys,
    urls: cfg.urls,
    platform: 'web browser',
    exec: false, // browser mode: no <RUN>, replies in plain text
  };
  if (opts && opts.system) options.system = opts.system;
  if (opts && opts.context) options.context = opts.context;
  return await sdk.tell(message, options);
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
    tellChat: (typeof tellChat !== 'undefined') ? tellChat : undefined,
    chatTell: (typeof chatTell !== 'undefined') ? chatTell : undefined,
    llmTest: (typeof llmTest !== 'undefined') ? llmTest : undefined,
  };
}
