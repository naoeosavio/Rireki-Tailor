// RirekiTailor Web — app principal.
// Seções (workspaces por vaga) + stepper 3 etapas + LLM + engine SwiftLaTeX.

(function () {
  'use strict';

  // ---------- Estado ----------
  const LS_SECTIONS = 'riki.sections';
  const LS_ACTIVE = 'riki.active';
  const LS_CONFIG = 'riki.config';

  const DEFAULT_FILES = {
    role: 'data/role.md',
    masterEn: 'data/CV_MASTER_EN.md',
    masterPt: 'data/CV_MASTER_PT.md',
    template: 'data/CV_ATS.tex',
    pitch: 'data/pitch.md',
  };

  let config = {
    model: 'j',
    keys: {},
    urls: {},
  };
  let sections = {};
  let activeId = null;
  let engine = null;
  let enginePromise = null;
  let pdfUrl = null;

  const $ = (id) => document.getElementById(id);
  const step = (n) => document.querySelectorAll('.panel')[n - 1];

  function defaultSection() {
    return {
      name: 'Vaga nova',
      role: '',
      master: '',
      lang: 'en',
      template: '',
      pitch: '',
      genCover: false,
      cvOut: '',
      cover: '',
      tex: '',
      updatedAt: Date.now(),
    };
  }

  function now() { return new Date().toLocaleString('pt-BR'); }
  function touch(s) { s.updatedAt = Date.now(); }

  // ---------- Persistência ----------
  function saveAll() {
    localStorage.setItem(LS_CONFIG, JSON.stringify(config));
    localStorage.setItem(LS_SECTIONS, JSON.stringify(sections));
    localStorage.setItem(LS_ACTIVE, activeId || '');
  }

  function loadAll() {
    try {
      const c = JSON.parse(localStorage.getItem(LS_CONFIG) || '{}');
      config = migrateConfig(c);
      sections = JSON.parse(localStorage.getItem(LS_SECTIONS) || '{}');
      const a = localStorage.getItem(LS_ACTIVE);
      if (a && sections[a]) activeId = a;
    } catch (e) {
      console.error('load failed', e);
      sections = {};
    }
  }

  function migrateConfig(c) {
    const out = {
      model: c.model || 'j',
      keys: Object.assign({}, c.keys),
      urls: Object.assign({}, c.urls),
    };
    if (c.apiKey && !out.keys.openai) out.keys.openai = c.apiKey;
    if (c.baseURL && !out.urls.openai) out.urls.openai = c.baseURL;
    return out;
  }

  // ---------- Helpers ----------
  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function readFile(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(r.error);
      r.readAsText(file);
    });
  }

  function setStatus(txt, cls) {
    const el = $('status');
    el.textContent = txt;
    el.className = 'status ' + (cls || '');
  }

  function log(...lines) {
    const el = $('log');
    el.textContent += lines.join('\n') + '\n';
    el.scrollTop = el.scrollHeight;
  }

  function setBusy(btnId, busy, labelWhile) {
    const b = $(btnId);
    if (!b) return;
    if (busy) {
      b.dataset.label = b.textContent;
      b.textContent = labelWhile || b.textContent + '…';
      b.disabled = true;
    } else {
      b.textContent = b.dataset.label || b.textContent;
      b.disabled = false;
    }
  }

  // ---------- Seções ----------
  function active() {
    return sections[activeId] || null;
  }

  function renderSections() {
    const sel = $('section-select');
    sel.innerHTML = '';
    Object.keys(sections).sort((a, b) => sections[b].updatedAt - sections[a].updatedAt).forEach((id) => {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = sections[id].name + ' — ' + new Date(sections[id].updatedAt).toLocaleDateString('pt-BR');
      sel.appendChild(o);
    });
    sel.value = activeId || '';
  }

  function switchSection(id) {
    if (!sections[id]) return;
    activeId = id;
    saveAll();
    renderSections();
    fillStep1();
  }

  async function createSection() {
    const src = active() || defaultSection();
    const def = defaultSection();
    def.name = prompt('Nome da seção (vaga):', 'Vaga — ' + new Date().toLocaleDateString('pt-BR'));
    if (def.name === null) return;
    def.name = def.name.trim() || 'Vaga nova';
    if (src) {
      def.master = src.master;
      def.lang = src.lang;
      def.template = src.template;
      def.pitch = src.pitch;
    } else {
      def.master = await fetchText(DEFAULT_FILES.masterEn);
      def.template = await fetchText(DEFAULT_FILES.template);
    }
    const id = 's' + Date.now().toString(36);
    sections[id] = def;
    activeId = id;
    saveAll();
    renderSections();
    fillStep1();
    goTo(1);
  }

  function renameSection() {
    const s = active();
    if (!s) return;
    const n = prompt('Renomear seção:', s.name);
    if (n && n.trim()) { s.name = n.trim(); touch(s); saveAll(); renderSections(); }
  }

  async function duplicateSection() {
    const s = active();
    if (!s) return;
    const copy = Object.assign(defaultSection(), JSON.parse(JSON.stringify(s)));
    copy.name = s.name + ' (cópia)';
    copy.cvOut = '';
    copy.cover = '';
    copy.tex = '';
    const id = 's' + Date.now().toString(36);
    sections[id] = copy;
    activeId = id;
    saveAll();
    renderSections();
    fillStep1();
  }

  function deleteSection() {
    if (!active()) return;
    if (!confirm('Excluir a seção "' + active().name + '"? (não tem volta)')) return;
    delete sections[activeId];
    const ids = Object.keys(sections);
    activeId = ids.length ? ids[0] : null;
    saveAll();
    renderSections();
    if (activeId) fillStep1();
  }

  function exportSections() {
    const payload = { exportedAt: now(), config, sections };
    download('riki-secoes-' + Date.now() + '.json', JSON.stringify(payload, null, 2), 'application/json');
  }

  async function importSections(file) {
    try {
      const data = JSON.parse(await readFile(file));
      if (!data.sections || typeof data.sections !== 'object') throw new Error('JSON sem "sections"');
      Object.assign(sections, data.sections);
      if (data.config) Object.assign(config, data.config);
      const ids = Object.keys(sections);
      if (ids.length && !sections[activeId]) activeId = ids[0];
      saveAll();
      renderSections();
      fillStep1();
      fillConfig();
      alert('Importado: ' + ids.length + ' seção(ões).');
    } catch (e) {
      alert('Importação falhou: ' + e.message);
    }
  }

  // ---------- Etapa 1 ----------
  function bindFields() {
    document.querySelectorAll('[data-bind]').forEach((el) => {
      el.addEventListener('input', () => {
        const s = active();
        if (!s) return;
        const key = el.dataset.bind;
        if (key === 'genCover') s.genCover = el.checked;
        else if (key === 'lang') { s.lang = el.value; saveAll(); return; }
        else s[key] = el.value;
        touch(s);
        saveAll();
      });
    });
    document.querySelectorAll('[data-upload]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = btn.dataset.upload === 'json' ? '.json' : '.md,.tex,.txt';
        input.onchange = async () => {
          const f = input.files[0];
          if (!f) return;
          if (btn.dataset.upload === 'json') return importSections(f);
          const s = active();
          if (!s) return;
          const txt = await readFile(f);
          s[btn.dataset.upload] = txt;
          touch(s); saveAll();
          if (btn.dataset.upload === 'master') {
            s.lang = f.name.includes('PT') ? 'pt' : 'en';
          }
          fillStep1();
        };
        input.click();
      });
    });
    document.querySelectorAll('[data-default]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const s = active();
        if (!s) return;
        const key = btn.dataset.default;
        const map = {
          role: DEFAULT_FILES.role,
          master: s.lang === 'pt' ? DEFAULT_FILES.masterPt : DEFAULT_FILES.masterEn,
          template: DEFAULT_FILES.template,
          pitch: DEFAULT_FILES.pitch,
        };
        s[key] = await fetchText(map[key]);
        touch(s); saveAll();
        fillStep1();
      });
    });
  }

  function fillStep1() {
    const s = active();
    if (!s) { $('step1-empty').style.display = 'block'; return; }
    $('step1-empty').style.display = 'none';
    ['role', 'master', 'template', 'pitch'].forEach((k) => { $(k).value = s[k]; });
    $('lang').value = s.lang;
    $('genCover').checked = s.genCover;
  }

  async function fetchText(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('Falha ao carregar ' + url + ': HTTP ' + r.status);
    return await r.text();
  }

  // ---------- LLM ----------
  async function generate(fn, opts) {
    const s = active();
    if (!s) return;
    try {
      await fn(s, opts);
    } catch (e) {
      setStatus('ERRO: ' + e.message, 'err');
      log('ERRO:', e.message);
    }
  }

  async function genCvOut() {
    const s = active();
    if (!s) return;
    const prompt = buildAtsPrompt(s.master, s.lang, s.role);
    setBusy('btn-gen-cv', true, 'Gerando CV_OUT.md…');
    setStatus('Gerando CV_OUT.md (' + config.model + ')…', 'busy');
    try {
      s.cvOut = await tellChat(prompt, config);
      $('cvOut').value = s.cvOut;
      touch(s); saveAll();
      setStatus('CV_OUT.md gerado — revise na Etapa 2', 'ok');
    } finally {
      setBusy('btn-gen-cv', false);
    }
  }

  async function genCover() {
    const s = active();
    if (!s) return;
    const prompt = buildCoverPrompt(s.cvOut || s.master, s.lang, s.role, s.pitch);
    setBusy('btn-gen-cover', true, 'Gerando cover.md…');
    setStatus('Gerando cover.md (' + config.model + ')…', 'busy');
    try {
      s.cover = await tellChat(prompt, config);
      $('cover').value = s.cover;
      touch(s); saveAll();
      setStatus('cover.md gerado', 'ok');
    } finally {
      setBusy('btn-gen-cover', false);
    }
  }

  async function toTex() {
    const s = active();
    if (!s) return;
    const prompt = buildTexPrompt(s.cvOut || s.master, s.template);
    setBusy('btn-to-tex', true, 'Convertendo para LaTeX…');
    setStatus('Convertendo markdown → LaTeX (' + config.model + ')…', 'busy');
    try {
      s.tex = await tellChat(prompt, config);
      $('tex').value = s.tex;
      touch(s); saveAll();
      setStatus('.tex gerado — revise e compile na Etapa 3', 'ok');
      goTo(3);
    } finally {
      setBusy('btn-to-tex', false);
    }
  }

  // ---------- Etapa 3 / Engine ----------
  function getEngine() {
    if (engine) return Promise.resolve(engine);
    if (!enginePromise) {
      enginePromise = new Promise((resolve, reject) => {
        setStatus('Carregando engine LaTeX (1ª vez ~1 min)…', 'busy');
        const e = new PdfTeXEngine();
        e.loadEngine().then(() => {
          engine = e;
          setStatus('Engine pronto', 'ok');
          resolve(e);
        }, reject);
      });
    }
    return enginePromise;
  }

  async function compilePdf() {
    const s = active();
    if (!s) return;
    if (!s.tex.trim()) {
      setStatus('Etapa 3: o .tex está vazio — gere ou cole um .tex.', 'warn');
      return;
    }
    setBusy('btn-compile', true, 'Compilando…');
    setStatus('Compilando PDF (1ª vez ~20 min)…', 'busy');
    log('--- compile start (' + now() + ') ---');
    const t0 = performance.now();
    const timer = setInterval(() => {
      setStatus('Compilando PDF… ' + ((performance.now() - t0) / 1000).toFixed(0) + 's', 'busy');
    }, 30000);
    try {
      const eng = await getEngine();
      clearInterval(timer);
      eng.writeMemFSFile('main.tex', s.tex);
      eng.setEngineMainFile('main.tex');
      const res = await eng.compileLaTeX();
      log('status:', res.status, '(' + ((performance.now() - t0) / 1000).toFixed(0) + 's)');
      if (res.status === 0) {
        showPdf(res.pdf);
        setStatus('PDF gerado (' + res.pdf.length + ' bytes)', 'ok');
      } else {
        setStatus('ERRO no compile (status ' + res.status + ') — ver log', 'err');
        log(res.log || '');
      }
    } catch (e) {
      clearInterval(timer);
      setStatus('ERRO no compile: ' + e.message, 'err');
      log('ERRO:', e.message);
    } finally {
      setBusy('btn-compile', false);
    }
  }

  function showPdf(uint8) {
    const viewer = $('viewer');
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    pdfUrl = URL.createObjectURL(new Blob([uint8], { type: 'application/pdf' }));
    viewer.src = pdfUrl;
    viewer.style.display = 'block';
  }

  // ---------- Stepper ----------
  function goTo(n) {
    document.querySelectorAll('.panel').forEach((p) => (p.style.display = 'none'));
    document.querySelectorAll('.step-dot').forEach((d, i) => d.classList.toggle('active', i + 1 === n));
    step(n).style.display = 'block';
  }

  // ---------- Config LLM ----------
  function fillConfig() {
    $('cfg-model').value = config.model;
    LLM_VENDORS.forEach((v) => {
      const k = $('cfg-key-' + v);
      const u = $('cfg-url-' + v);
      if (k) k.value = (config.keys && config.keys[v]) || '';
      if (u) u.value = (config.urls && config.urls[v]) || '';
    });
  }

  function bindConfig() {
    $('cfg-model').addEventListener('input', () => {
      config.model = $('cfg-model').value.trim() || 'g';
      saveAll();
    });
    LLM_VENDORS.forEach((v) => {
      $('cfg-key-' + v).addEventListener('input', () => {
        config.keys[v] = $('cfg-key-' + v).value.trim();
        saveAll();
      });
      $('cfg-url-' + v).addEventListener('input', () => {
        config.urls[v] = $('cfg-url-' + v).value.trim();
        saveAll();
      });
    });
    $('btn-cfg-test').addEventListener('click', async () => {
      setBusy('btn-cfg-test', true, 'Testando…');
      try {
        const r = await llmTest(config);
        setStatus('Conexão LLM: ' + r, 'ok');
        log('LLM test:', r);
      } catch (e) {
        setStatus('Conexão LLM falhou: ' + e.message, 'err');
        log('LLM test falhou:', e.message);
      } finally {
        setBusy('btn-cfg-test', false);
      }
    });
  }

  // ---------- Init ----------
  async function init() {
    loadAll();
    if (!Object.keys(sections).length) {
      await createInitial();
    }
    renderSections();
    fillStep1();
    fillConfig();
    bindFields();
    bindConfig();

    $('btn-new-section').addEventListener('click', createSection);
    $('btn-rename-section').addEventListener('click', renameSection);
    $('btn-dup-section').addEventListener('click', duplicateSection);
    $('btn-del-section').addEventListener('click', deleteSection);
    $('btn-export').addEventListener('click', exportSections);

    $('section-select').addEventListener('change', (e) => switchSection(e.target.value));

    $('btn-gen-cv').addEventListener('click', () => generate(genCvOut));
    $('btn-gen-cover').addEventListener('click', () => generate(genCover));
    $('btn-to-tex').addEventListener('click', () => generate(toTex));
    $('btn-compile').addEventListener('click', compilePdf);

    document.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => goTo(+b.dataset.nav)));

    $('dl-cvout').addEventListener('click', () => { const s = active(); if (s) download('CV_OUT.md', s.cvOut); });
    $('dl-cover').addEventListener('click', () => { const s = active(); if (s) download('cover.md', s.cover); });
    $('dl-tex').addEventListener('click', () => { const s = active(); if (s) download('CV.tex', s.tex); });
    $('dl-pdf').addEventListener('click', () => {
      if (pdfUrl) {
        const a = document.createElement('a');
        a.href = pdfUrl;
        a.download = 'CV.pdf';
        a.click();
      }
    });

    // Etapa 2/3 refletem o estado salvo da seção ativa
    ['cvOut', 'cover', 'tex'].forEach((k) => {
      const el = $(k);
      const s = active();
      if (s) el.value = s[k];
      el.addEventListener('input', () => {
        const ss = active();
        if (!ss) return;
        ss[k] = el.value;
        touch(ss);
        saveAll();
      });
    });

    const s = active();
    if (s && s.updatedAt) $('last-saved').textContent = 'última edição: ' + new Date(s.updatedAt).toLocaleString('pt-BR');

    goTo(1);
    if (!active()) $('step1-empty').style.display = 'block';
    setStatus('Pronto', 'ok');
  }

  async function createInitial() {
    const s = defaultSection();
    s.name = 'Padrão';
    try {
      [s.role, s.master, s.template, s.pitch] = await Promise.all([
        fetchText(DEFAULT_FILES.role),
        fetchText(DEFAULT_FILES.masterEn),
        fetchText(DEFAULT_FILES.template),
        fetchText(DEFAULT_FILES.pitch),
      ]);
    } catch (e) {
      console.warn('defaults fetch failed', e);
    }
    const id = 's' + Date.now().toString(36);
    sections[id] = s;
    activeId = id;
    saveAll();
    fillStep1();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
