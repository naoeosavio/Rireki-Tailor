// LLM wrapper — OpenAI-compatible chat completions, direto do browser.
// baseURL/model/key configuráveis no app; key fica no localStorage.

async function llmChat(cfg, userPrompt, { onToken } = {}) {
  if (!cfg.apiKey) throw new Error('Config LLM incompleta: informe a API key.');
  const base = (cfg.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 600000);
  try {
    const body = {
      model: cfg.model || 'gpt-4o-mini',
      messages: [{ role: 'user', content: userPrompt }],
      temperature: cfg.temperature ?? 0.7,
    };
    if (onToken) {
      body.stream = true;
      let acc = '';
      const r = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + cfg.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!r.ok) throw new Error('LLM HTTP ' + r.status + ': ' + (await r.text()).slice(0, 300));
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const json = JSON.parse(payload);
            const delta = json.choices && json.choices[0] && json.choices[0].delta;
            if (delta && delta.content) {
              acc += delta.content;
              onToken(delta.content);
            }
          } catch (_) { /* chunk incompleto */ }
        }
      }
      return acc;
    }
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!r.ok) throw new Error('LLM HTTP ' + r.status + ': ' + (await r.text()).slice(0, 300));
    const json = await r.json();
    return json.choices && json.choices[0] && json.choices[0].message
      ? json.choices[0].message.content
      : '';
  } finally {
    clearTimeout(timer);
  }
}

async function llmTest(cfg) {
  if (!cfg.apiKey) throw new Error('Informe a API key.');
  const base = (cfg.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const r = await fetch(base + '/models', {
    headers: { Authorization: 'Bearer ' + cfg.apiKey },
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return 'OK — ' + (await r.json()).data.length + ' modelos disponíveis';
}
