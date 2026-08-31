// LLM layer — tell-ai SDK (TellSDK.tell), OpenAI-compatible multi-vendor.
// Config: model alias/spec + keys/urls per vendor (localStorage, via app config).

const LLM_VENDORS = [
  'openai', 'anthropic', 'google', 'deepseek', 'xai',
  'cerebras', 'fireworks', 'moonshotai', 'openrouter',
];

function tellCfg(config) {
  const keys = {};
  const urls = {};
  LLM_VENDORS.forEach((v) => {
    if (config.keys && config.keys[v]) keys[v] = config.keys[v];
    if (config.urls && config.urls[v]) urls[v] = config.urls[v];
  });
  return { model: config.model || 'g', keys, urls };
}

function llmMissingKeyError(cfg) {
  const err = new Error('Config LLM incompleta: informe a API key do vendor do modelo (' + cfg.model + ').');
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
    throw new Error('TellSDK não carregado (@tell-ai/sdk).');
  }
  const cfg = assertKey(config);
  return await sdk.tell(userPrompt, {
    model: cfg.model,
    keys: cfg.keys,
    urls: cfg.urls,
    platform: 'web browser',
  });
}

// Modo chat: system prompt contextual + histórico acumulado em `context`.
// One-shot por mensagem (TellSDK.tell não faz streaming no bundle browser).
async function chatTell(message, config, opts) {
  const sdk = window.TellSDK;
  if (!sdk || typeof sdk.tell !== 'function') {
    throw new Error('TellSDK não carregado (@tell-ai/sdk).');
  }
  const cfg = assertKey(config);
  const options = {
    model: cfg.model,
    keys: cfg.keys,
    urls: cfg.urls,
    platform: 'web browser',
    exec: false, // modo browser: sem <RUN>, responde em texto
  };
  if (opts && opts.system) options.system = opts.system;
  if (opts && opts.context) options.context = opts.context;
  return await sdk.tell(message, options);
}

async function llmTest(config) {
  const out = await tellChat('Reply with exactly: OK', config);
  return 'OK — modelo respondeu: "' + out.trim().slice(0, 60) + '"';
}
