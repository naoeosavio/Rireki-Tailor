// LLM layer — tell-ai SDK (TellSDK.tell), OpenAI-compatible multi-vendor.
// Config: model alias/spec + keys/urls per vendor (localStorage, via app config).
// Urls fall back to DEFAULT_URLS (same as docs/llm-base-url.md), so the
// direct way works out of the box; replace any entry with a CORS proxy
// URL as fallback when the browser blocks the direct call.

const LLM_VENDORS = [
  'openai', 'anthropic', 'google', 'deepseek', 'xai',
  'cerebras', 'fireworks', 'moonshotai', 'openrouter',
  'alibaba', 'zai', 'vast', 'local',
];

// Official direct base URLs, pre-filled by default (primary way).
// Keep in sync with docs/llm-base-url.md. Loaded before app.js,
// so app.js backfills them into the visible config form.
// Vendors without entry here have no reliable default: fill the
// URL field (vast: your own server URL) or the SDK call fails.
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
  local: 'http://localhost:11434/v1',
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
  return { model: config.model || 'g', keys, urls };
}

function llmMissingKeyError(cfg) {
  const err = new Error('Incomplete LLM config: provide the API key for the model\'s vendor (' + cfg.model + ').');
  err.code = 'NO_KEY';
  return err;
}

function assertKey(config) {
  const cfg = tellCfg(config);
  if (!Object.values(cfg.keys).some(Boolean)) throw llmMissingKeyError(cfg);
  return cfg;
}

async function tellChat(userPrompt, config) {
  const sdk = window.TellSDK;
  if (!sdk || typeof sdk.tell !== 'function') {
    throw new Error('TellSDK not loaded (@tell-ai/sdk).');
  }
  const cfg = assertKey(config);
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
  const sdk = window.TellSDK;
  if (!sdk || typeof sdk.tell !== 'function') {
    throw new Error('TellSDK not loaded (@tell-ai/sdk).');
  }
  const cfg = assertKey(config);
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
