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

async function tellChat(userPrompt, config) {
  const sdk = window.TellSDK;
  if (!sdk || typeof sdk.tell !== 'function') {
    throw new Error('TellSDK não carregado (@tell-ai/sdk).');
  }
  const cfg = tellCfg(config);
  if (!Object.values(cfg.keys).some(Boolean)) {
    throw new Error('Config LLM incompleta: informe a API key do vendor do modelo (' + cfg.model + ').');
  }
  return await sdk.tell(userPrompt, {
    model: cfg.model,
    keys: cfg.keys,
    urls: cfg.urls,
    platform: 'web browser',
  });
}

async function llmTest(config) {
  const out = await tellChat('Reply with exactly: OK', config);
  return 'OK — modelo respondeu: "' + out.trim().slice(0, 60) + '"';
}
