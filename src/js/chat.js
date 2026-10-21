// Per-section chat — RirekiTailor's contextual assistant.
// Uses one-shot TellSDK.tell with a contextual system prompt + history in `context`.
// History persisted per section: section.chat = [{role:'user'|'assistant', content, at}].

(function () {
  'use strict';

  let deps = null;
  let busy = false;
  let ready = false;

  const $ = (id) => document.getElementById(id);

  const FIELD_LABELS = {
    role: 'Job',
    master: 'Master CV',
    cvOut: 'CV_OUT.md',
    cover: 'cover.md',
    tex: 'CV.tex',
  };

  const QUICK_ASKS = [
    {
      req: 'cvOut',
      pt: { label: 'O que melhorar neste CV?', q: 'Analise o CV_OUT.md contra a descrição da vaga e liste as 3–5 melhorias mais impactantes que eu deveria fazer.' },
      en: { label: 'What should I improve in this CV?', q: 'Analyze CV_OUT.md against the job description and list the 3-5 most impactful improvements I should make.' },
    },
    {
      req: 'role',
      pt: { label: 'Gaps entre CV e vaga', q: 'Compare meu CV atual com a descrição da vaga e aponte requisitos importantes que ainda não estão bem evidenciados.' },
      en: { label: 'Gaps between CV and job', q: 'Compare my current CV with the job description and point out important requirements that are still not well highlighted.' },
    },
    {
      req: 'tex',
      pt: { label: 'Revisar o CV.tex', q: 'Revise o CV.tex procurando problemas de sintaxe LaTeX ou formatação que possam quebrar a compilação pdflatex. Seja específico.' },
      en: { label: 'Review CV.tex', q: 'Review CV.tex looking for LaTeX syntax or formatting issues that could break the pdflatex compilation. Be specific.' },
    },
  ];

  // ---------- markdown-lite (safe: escapes HTML first) ----------
  function escHtml(t) {
    return String(t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function inlineMd(t) {
    t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return t;
  }

  function mdLite(src) {
    src = String(src == null ? '' : src);
    /* The source is split into text parts and code parts. The old marker
     * approach lost the code block when a line carried text after the
     * closing fence, and it showed the marker itself to the user. */
    const parts = [];
    const fenceRe = /```[\s\S]*?```/g;
    let last = 0;
    let match = fenceRe.exec(src);
    while (match !== null) {
      if (match.index > last) parts.push({ code: false, text: src.slice(last, match.index) });
      parts.push({ code: true, text: match[0].replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/```$/, '') });
      last = match.index + match[0].length;
      match = fenceRe.exec(src);
    }
    if (last < src.length) parts.push({ code: false, text: src.slice(last) });

    const out = [];
    let list = null;
    const flushList = () => {
      if (list) { out.push('<ul>' + list.map((li) => '<li>' + inlineMd(li) + '</li>').join('') + '</ul>'); list = null; }
    };
    for (const part of parts) {
      if (part.code) {
        flushList();
        out.push('<pre><code>' + escHtml(part.text) + '</code></pre>');
        continue;
      }
      const lines = escHtml(part.text).split('\n');
      for (const raw of lines) {
        const line = raw.replace(/\s+$/, '');
        const h = line.match(/^(#{1,4})\s+(.*)/);
        if (h) { flushList(); out.push('<h' + Math.min(h[1].length, 3) + '>' + inlineMd(h[2]) + '</h' + Math.min(h[1].length, 3) + '>'); continue; }
        const li = line.match(/^\s*[-*•]\s+(.*)/) || line.match(/^\s*\d+[.)]\s+(.*)/);
        if (li) { list = list || []; list.push(li[1]); continue; }
        if (!line.trim()) { flushList(); continue; }
        flushList();
        out.push('<p>' + inlineMd(line) + '</p>');
      }
    }
    flushList();
    return out.join('');
  }

  // ---------- context ----------
  /* The section comes from the store, so the fields are strings. A helper
   * keeps the builder safe when a field is not a string. */
  function fieldText(s, key) {
    const value = s ? s[key] : '';
    return typeof value === 'string' ? value : '';
  }

  function contextParts(s) {
    const isPt = s && s.lang === 'pt';
    const defs = [
      ['role', isPt ? 'Descrição da vaga' : 'Job description'],
      ['master', isPt ? 'CV master' : 'Master CV'],
      ['cvOut', isPt ? 'CV_OUT.md (CV gerado p/ vaga)' : 'CV_OUT.md (tailored CV)'],
      ['cover', isPt ? 'cover.md (pitch)' : 'cover.md (pitch)'],
      ['tex', isPt ? 'CV.tex (LaTeX atual)' : 'CV.tex (current LaTeX)'],
    ];
    return defs
      .filter(([k]) => fieldText(s, k).trim())
      .map(([k, label]) => '### ' + label + '\n\n<snap_' + k + '>\n' + fieldText(s, k).trim() + '\n</snap_' + k + '>');
  }

  function buildSystem(s) {
    const isPt = s && s.lang === 'pt';
    const parts = contextParts(s);
    const ctx = parts.length
      ? parts.join('\n\n---\n\n')
      : (isPt
        ? '(A seção ainda está vazia — oriente o usuário a preencher a vaga/CV na Etapa 1.)'
        : '(The section is still empty — guide the user to fill the job/master CV in Step 1.)');
    return (isPt ? `Você é o assistente do RirekiTailor, especialista em CVs ATS e candidaturas.
Responda SEMPRE em PORTUGUÊS (PT-BR).
Fundamente-se APENAS no contexto da seção abaixo; NÃO invente experiências, skills ou requisitos. Se algo não estiver no contexto, diga o que falta e onde preencher na interface (Etapa 1 entradas · Etapa 2 markdown · Etapa 3 LaTeX/PDF).
Papéis: tirar dúvidas sobre a vaga, sugerir melhorias concretas (com trechos prontos de markdown/LaTeX quando útil), revisar o material e ajudar a preparar a candidatura.
Seja conciso e direto; use listas curtas quando ajudar.` :
`You are the RirekiTailor assistant, an expert in ATS CVs and job applications.
Answer ALWAYS in ENGLISH.
Ground yourself ONLY in the section context below; do NOT invent experience, skills, or requirements. If something is missing from the context, say what is missing and where to fill it in the UI (Step 1 inputs · Step 2 markdown · Step 3 LaTeX/PDF).
Roles: answer questions about the job, suggest concrete improvements (with ready-to-paste markdown/LaTeX snippets when useful), review the material, and help prepare the application.
Be concise and direct; use short lists when helpful.`)
      + '\n\n## CONTEXTO DA SEÇÃO "' + fieldText(s, 'name') + '"\n\n' + ctx;
  }

  /* The history goes into the prompt. A large history costs tokens, and a
   * model rejects a prompt that is too long. */
  const HISTORY_MAX_CHARS = 24000;
  const HISTORY_MAX_MESSAGES = 14;

  function historyText(m) {
    const content = m && m.content;
    return typeof content === 'string' ? content : '';
  }

  function serializeHistory(chat) {
    const list = Array.isArray(chat) ? chat : [];
    const tail = list.slice(-HISTORY_MAX_MESSAGES);
    const lines = tail.map((m) => (m.role === 'user' ? 'Usuário' : 'Assistente') + ':\n' + historyText(m));
    let total = 0;
    const kept = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const size = lines[i].length + 2;
      if (total + size > HISTORY_MAX_CHARS && kept.length) break;
      total += size;
      kept.unshift(lines[i]);
    }
    if (!kept.length) return '';
    /* One message can be longer than the limit on its own. The newest part
     * of it is the useful part. */
    if (kept[0].length > HISTORY_MAX_CHARS - 2) {
      kept[0] = kept[0].slice(-(HISTORY_MAX_CHARS - 2));
    }
    return kept.join('\n\n');
  }

  // ---------- render ----------
  function scrollBottom() {
    const box = $('chat-messages');
    box.scrollTop = box.scrollHeight;
  }

  function renderContextChips(s) {
    const el = $('chat-context');
    el.innerHTML = '';
    Object.keys(FIELD_LABELS).forEach((k) => {
      const c = document.createElement('span');
      c.className = 'chat-chip' + ((s[k] || '').trim() ? '' : ' off');
      c.textContent = FIELD_LABELS[k];
      el.appendChild(c);
    });
  }

  function msgEl(role, html, idx) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.innerHTML = html;
    if (role === 'assistant' && idx != null) {
      const tools = document.createElement('div');
      tools.className = 'msg-tools';
      const btn = document.createElement('button');
      btn.className = 'icon-btn';
      btn.title = 'Copy message';
      btn.setAttribute('aria-label', 'Copy message');
      btn.dataset.copyMsg = String(idx);
      btn.innerHTML = '<svg class="ic"><use href="#i-copy"/></svg>';
      tools.appendChild(btn);
      div.appendChild(tools);
    }
    return div;
  }

  function renderEmptyState(s) {
    const box = $('chat-messages');
    box.innerHTML = '';
    const isPt = s.lang === 'pt';
    box.appendChild(msgEl('assistant', '<p>' + (isPt
      ? 'Oi! Sou o assistente <b>desta seção</b>. Posso analisar a vaga, sugerir melhorias no CV, revisar o LaTeX e tirar dúvidas — sempre com base no que está aqui.'
      : 'Hi! I am the assistant for <b>this section</b>. I can analyze the job posting, suggest CV improvements, review your LaTeX and answer questions — always grounded in what is here.') + '</p>'));
    const wrap = document.createElement('div');
    wrap.className = 'chat-quick';
    QUICK_ASKS.filter((q) => (s[q.req] || '').trim()).forEach((q) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = '· ' + (isPt ? q.pt.label : q.en.label);
      b.addEventListener('click', () => {
        $('chat-input').value = isPt ? q.pt.q : q.en.q;
        send();
      });
      wrap.appendChild(b);
    });
    if (wrap.children.length) box.appendChild(wrap);
  }

  function render() {
    if (!ready || !deps) return;
    const s = deps.getSection();
    const box = $('chat-messages');
    box.innerHTML = '';
    if (!s) {
      box.appendChild(msgEl('assistant', '<p>Create a section to start chatting.</p>'));
      setInputEnabled(false);
      return;
    }
    setInputEnabled(true);
    renderContextChips(s);
    if (!s.chat || !s.chat.length) { renderEmptyState(s); return; }
    s.chat.forEach((m, i) => {
      if (m.role === 'user') {
        const d = msgEl('user', '');
        d.textContent = m.content;
        box.appendChild(d);
      } else {
        box.appendChild(msgEl('assistant', mdLite(m.content), i));
      }
    });
    scrollBottom();
  }

  function addTyping() {
    const box = $('chat-messages');
    const t = document.createElement('div');
    t.className = 'msg assistant typing';
    t.id = 'chat-typing';
    t.innerHTML = '<i></i><i></i><i></i>';
    box.appendChild(t);
    scrollBottom();
  }

  function removeTyping() {
    const t = $('chat-typing');
    if (t) t.remove();
  }

  function renderError(e) {
    removeTyping();
    const box = $('chat-messages');
    const isKeyErr = e && e.code === 'NO_KEY';
    const div = msgEl('error', '<p><b>Failed:</b> ' + escHtml(e.message || e) + '</p>'
      + (isKeyErr ? '<p><button type="button" class="sm" data-open-cfg>Open LLM settings</button></p>' : ''));
    box.appendChild(div);
    scrollBottom();
  }

  function setInputEnabled(on) {
    $('chat-input').disabled = !on;
    $('chat-send').disabled = !on;
  }

  function autogrow() {
    const ta = $('chat-input');
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  }

  // ---------- actions ----------
  /* The clear button raises the number. A pending answer belongs to the old
   * conversation and must not come back. */
  let chatGeneration = 0;

  async function send() {
    const s = deps.getSection();
    const input = $('chat-input');
    const text = (input.value || '').trim();
    if (!text) return;
    if (!s) {
      deps.toast('Create a section before you send a message.', 'warn');
      return;
    }
    if (busy) {
      /* The message is dropped without a hint. The user thinks the message
       * was sent. */
      deps.toast('Wait for the current answer.', 'warn');
      return;
    }

    if (!s.chat) s.chat = [];
    const generation = chatGeneration;
    s.chat.push({ role: 'user', content: text, at: Date.now() });
    input.value = '';
    autogrow();
    render();
    /* Persist before calling the LLM: if the request fails, the saveAll() on
     * success never runs and the question is lost on reload. */
    deps.saveAll();

    busy = true;
    setInputEnabled(false);
    addTyping();
    try {
      const reply = await chatTell(text, deps.getConfig(), {
        system: buildSystem(s),
        context: serializeHistory(s.chat.slice(0, -1)),
      });
      /* The conversation was cleared while the model worked. */
      if (generation !== chatGeneration) return;
      s.chat.push({ role: 'assistant', content: reply, at: Date.now() });
      deps.touch(s);
      deps.saveAll();
      render();
    } catch (e) {
      if (generation !== chatGeneration) return;
      renderError(e);
    } finally {
      busy = false;
      setInputEnabled(true);
    }
  }

  async function clearChat() {
    const s = deps.getSection();
    if (!s) return;
    if (!s.chat || !s.chat.length) return;
    const ok = await deps.confirm({
      title: 'Clear conversation?',
      message: 'The assistant history for this section will be erased. The rest of the section is kept.',
      confirmText: 'Clear',
      danger: true,
    });
    if (!ok) return;
    s.chat = [];
    /* The pending answer of the old conversation must not come back. */
    chatGeneration++;
    deps.touch(s);
    deps.saveAll();
    render();
    deps.toast('Conversation cleared', 'ok');
  }

  async function copyMsg(idx) {
    const s = deps.getSection();
    if (!s || !s.chat || !s.chat[idx]) return;
    try {
      await navigator.clipboard.writeText(s.chat[idx].content);
      deps.toast('Message copied', 'ok');
    } catch (e) {
      deps.toast('Could not copy: ' + e.message, 'err');
    }
  }

  // ---------- init ----------
  function init(d) {
    deps = d;
    ready = true;
    const input = $('chat-input');

    $('chat-send').addEventListener('click', send);
    $('chat-clear').addEventListener('click', clearChat);

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    input.addEventListener('input', autogrow);

    $('chat-messages').addEventListener('click', (e) => {
      const cfgBtn = e.target.closest('[data-open-cfg]');
      if (cfgBtn) { deps.openLlmConfig(); return; }
      const cp = e.target.closest('[data-copy-msg]');
      if (cp) copyMsg(+cp.dataset.copyMsg);
    });

    render();
  }

  window.Chat = { init, render };
})();
