// RirekiTailor Web — app principal.
// Seções (workspaces por vaga) + stepper 3 etapas + LLM + engine SwiftLaTeX.
// UI: temas dark/light, toasts, modais customizados, menu global (biblioteca de
// masters/templates + config LLM), chat por seção (js/chat.js).

(function () {
  'use strict';

  // ---------- Estado ----------
  const LS_SECTIONS = 'riki.sections';
  const LS_ACTIVE = 'riki.active';
  const LS_CONFIG = 'riki.config';
  const LS_LIBRARY = 'riki.library';
  const LS_THEME = 'riki.theme';

  const LIB_MAX = 2;

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
  let library = { masters: [], templates: [] };
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
      masterId: null,
      template: '',
      templateId: null,
      pitch: '',
      genCover: false,
      cvOut: '',
      cover: '',
      tex: '',
      chat: [],
      updatedAt: Date.now(),
    };
  }

  function now() { return new Date().toLocaleString('pt-BR'); }
  function touch(s) { s.updatedAt = Date.now(); }
  function active() { return sections[activeId] || null; }

  // ---------- Tema ----------
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    localStorage.setItem(LS_THEME, t);
  }

  function initTheme() {
    const saved = localStorage.getItem(LS_THEME);
    const t = saved || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    applyTheme(t);
  }

  // ---------- Persistência ----------
  function saveAll() {
    localStorage.setItem(LS_CONFIG, JSON.stringify(config));
    localStorage.setItem(LS_SECTIONS, JSON.stringify(sections));
    localStorage.setItem(LS_LIBRARY, JSON.stringify(library));
    localStorage.setItem(LS_ACTIVE, activeId || '');
    const s = active();
    if (s && s.updatedAt) {
      const el = $('last-saved');
      if (el) el.textContent = 'última edição: ' + new Date(s.updatedAt).toLocaleString('pt-BR');
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

  function loadAll() {
    try {
      const c = JSON.parse(localStorage.getItem(LS_CONFIG) || '{}');
      config = migrateConfig(c);
      sections = JSON.parse(localStorage.getItem(LS_SECTIONS) || '{}');
      library = JSON.parse(localStorage.getItem(LS_LIBRARY) || 'null') || { masters: [], templates: [] };
      if (!library.masters) library.masters = [];
      if (!library.templates) library.templates = [];
      const a = localStorage.getItem(LS_ACTIVE);
      if (a && sections[a]) activeId = a;
    } catch (e) {
      console.error('load failed', e);
      sections = {};
      library = { masters: [], templates: [] };
    }
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

  function progress(on) {
    $('progress').hidden = !on;
  }

  function setBusy(btnId, busy) {
    const b = $(btnId);
    if (!b) return;
    b.classList.toggle('is-loading', !!busy);
    b.disabled = !!busy;
  }

  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg || 'Copiado para a área de transferência', 'ok');
    } catch (e) {
      toast('Não consegui copiar: ' + e.message, 'err');
    }
  }

  function updateCounter(key) {
    const ta = $(key);
    const el = document.querySelector('[data-count-for="' + key + '"]');
    if (!ta || !el) return;
    el.textContent = ta.value.length.toLocaleString('pt-BR') + ' caracteres';
  }

  function updateAllCounters() {
    ['role', 'master', 'template', 'pitch', 'cvOut', 'cover', 'tex'].forEach(updateCounter);
  }

  // ---------- Toasts ----------
  function toast(msg, type, ms) {
    const box = $('toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    const body = document.createElement('div');
    body.className = 'toast-body';
    body.textContent = msg;
    const dismiss = () => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 200);
    };
    const x = document.createElement('button');
    x.className = 'toast-close';
    x.setAttribute('aria-label', 'Fechar aviso');
    x.innerHTML = '<svg class="ic"><use href="#i-close"/></svg>';
    x.addEventListener('click', dismiss);
    el.append(body, x);
    box.appendChild(el);
    setTimeout(dismiss, ms || 4200);
  }

  // ---------- Modais (substituem prompt/confirm/alert nativos) ----------
  function buildModal(opts) {
    return new Promise((resolve) => {
      const root = $('modal-root');
      const back = document.createElement('div');
      back.className = 'modal-backdrop';
      const m = document.createElement('div');
      m.className = 'modal';
      m.setAttribute('role', 'dialog');
      m.setAttribute('aria-modal', 'true');

      const head = document.createElement('div');
      head.className = 'modal-head' + (opts.danger ? ' danger' : '');
      head.textContent = opts.title || '';

      const body = document.createElement('div');
      body.className = 'modal-body';
      if (opts.message) {
        const p = document.createElement('p');
        p.style.margin = '0';
        p.innerHTML = opts.message;
        body.appendChild(p);
      }
      let input = null;
      if (opts.input) {
        input = document.createElement('input');
        input.className = 'modal-input';
        input.type = 'text';
        input.placeholder = opts.placeholder || '';
        input.value = opts.initial || '';
        body.appendChild(input);
      }

      const foot = document.createElement('div');
      foot.className = 'modal-foot';
      const closed = { v: false };
      const finish = (val) => {
        if (closed.v) return;
        closed.v = true;
        document.removeEventListener('keydown', onKey, true);
        back.remove();
        resolve(val);
      };
      const ok = () => finish(input ? input.value : true);

      let cancelBtn = null;
      if (!opts.alertOnly) {
        cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = opts.cancelText || 'Cancelar';
        cancelBtn.addEventListener('click', () => finish(opts.input ? null : false));
        foot.appendChild(cancelBtn);
      }
      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = 'primary' + (opts.danger ? ' danger' : '');
      okBtn.textContent = opts.okText || 'OK';
      okBtn.addEventListener('click', ok);
      foot.appendChild(okBtn);

      function onKey(e) {
        if (e.key === 'Escape') {
          e.stopPropagation();
          finish(opts.input ? null : false);
        } else if (e.key === 'Enter' && document.activeElement !== okBtn) {
          e.preventDefault();
          ok();
        } else if (e.key === 'Tab') {
          const items = [input, cancelBtn, okBtn].filter(Boolean);
          const i = items.indexOf(document.activeElement);
          e.preventDefault();
          const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i === items.length - 1 || i < 0 ? 0 : i + 1);
          items[next].focus();
        }
      }

      m.append(head, body, foot);
      back.appendChild(m);
      root.appendChild(back);

      back.addEventListener('mousedown', (e) => {
        if (e.target === back) finish(opts.input ? null : false);
      });
      document.addEventListener('keydown', onKey, true);

      if (input) { input.focus(); input.select(); }
      else okBtn.focus();
    });
  }

  const modal = {
    confirm: (o) => buildModal(Object.assign({ okText: 'Confirmar' }, o)).then((v) => v === true),
    prompt: (o) => buildModal(Object.assign({ input: true }, o)).then((v) => (typeof v === 'string' ? v : null)),
    alert: (o) => buildModal(Object.assign({ alertOnly: true, okText: 'Entendi' }, o)),
  };

  // ---------- Biblioteca global (masters/templates) ----------
  function libArr(kind) { return kind === 'master' ? library.masters : library.templates; }

  let libSaveTimer = null;
  function libDebouncedSave() {
    clearTimeout(libSaveTimer);
    libSaveTimer = setTimeout(saveAll, 400);
  }

  async function ensureLibrarySeed() {
    if (library.masters.length || library.templates.length) return;
    try {
      const [en, tpl] = await Promise.all([
        fetchText(DEFAULT_FILES.masterEn),
        fetchText(DEFAULT_FILES.template),
      ]);
      library.masters.push({
        id: 'm' + Date.now().toString(36),
        name: 'Master EN (padrão)',
        lang: 'en',
        content: en,
      });
      library.templates.push({
        id: 't' + Date.now().toString(36),
        name: 'CV_ATS (padrão)',
        content: tpl,
      });
      saveAll();
    } catch (e) {
      console.warn('library seed failed', e);
    }
  }

  function renderLibrary() {
    [['master', 'lib-masters', 'lib-master-count', 'btn-add-master'],
     ['template', 'lib-templates', 'lib-template-count', 'btn-add-template']]
      .forEach(([kind, listId, countId, addId]) => {
        const arr = libArr(kind);
        const list = $(listId);
        const badge = $(countId);
        badge.textContent = arr.length + '/' + LIB_MAX;
        $(addId).disabled = arr.length >= LIB_MAX;
        list.innerHTML = '';
        arr.forEach((entry) => list.appendChild(libEntryEl(kind, entry)));
      });
  }

  function libEntryEl(kind, entry) {
    const art = document.createElement('article');
    art.className = 'lib-entry';
    art.dataset.id = entry.id;

    const head = document.createElement('div');
    head.className = 'lib-entry-head';

    const name = document.createElement('input');
    name.className = 'lib-name';
    name.value = entry.name;
    name.placeholder = kind === 'master' ? 'Nome do master' : 'Nome do template';
    name.setAttribute('aria-label', 'Nome');
    name.addEventListener('input', () => { entry.name = name.value; libDebouncedSave(); });
    head.appendChild(name);

    if (kind === 'master') {
      const lang = document.createElement('select');
      lang.className = 'lib-lang';
      lang.setAttribute('aria-label', 'Idioma do master');
      lang.innerHTML = '<option value="en">EN</option><option value="pt">PT</option>';
      lang.value = entry.lang || 'en';
      lang.addEventListener('change', () => { entry.lang = lang.value; libDebouncedSave(); });
      head.appendChild(lang);
    }

    const acts = document.createElement('span');
    acts.className = 'actions';
    const mkIcon = (icon, title, cls) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls || 'icon-btn';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.innerHTML = '<svg class="ic"><use href="#i-' + icon + '"/></svg>';
      return b;
    };
    const useBtn = mkIcon('check', 'Usar nesta seção');
    useBtn.addEventListener('click', () => applyLibToSection(kind, entry.id));
    const upBtn = mkIcon('upload', 'Carregar arquivo');
    upBtn.addEventListener('click', () => pickFile('.md,.tex,.txt').then(async (f) => {
      if (!f) return;
      entry.content = await readFile(f);
      libDebouncedSave();
      renderLibrary();
      toast('Arquivo carregado em "' + (entry.name || 'sem nome') + '" — clique em Salvar se quiser garantir.', 'ok');
    }));
    const delBtn = mkIcon('trash', 'Excluir', 'icon-btn danger-ghost');
    delBtn.addEventListener('click', async () => {
      const ok = await modal.confirm({
        title: 'Excluir da biblioteca?',
        message: 'Remover <b>' + escapeHtml(entry.name || 'sem nome') + '</b>? As seções que já copiaram o conteúdo não são afetadas.',
        confirmText: 'Excluir',
        danger: true,
      });
      if (!ok) return;
      const arr = libArr(kind);
      arr.splice(arr.indexOf(entry), 1);
      saveAll();
      renderLibrary();
      renderLibSelects();
      toast('Item excluído da biblioteca', 'ok');
    });
    acts.append(useBtn, upBtn, delBtn);
    head.appendChild(acts);

    const ta = document.createElement('textarea');
    ta.className = 'lib-content';
    ta.value = entry.content;
    ta.spellcheck = false;
    ta.addEventListener('input', () => {
      entry.content = ta.value;
      chars.textContent = ta.value.length.toLocaleString('pt-BR') + ' caracteres';
      libDebouncedSave();
    });

    const foot = document.createElement('div');
    foot.className = 'lib-entry-foot';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'sm primary';
    saveBtn.textContent = 'Salvar';
    saveBtn.addEventListener('click', () => {
      if (!entry.name.trim()) { toast('Dê um nome ao modelo antes de salvar.', 'warn'); return; }
      saveAll();
      renderLibSelects();
      toast('Modelo "' + entry.name + '" salvo na biblioteca', 'ok');
    });
    const chars = document.createElement('span');
    chars.className = 'meta';
    chars.textContent = (entry.content || '').length.toLocaleString('pt-BR') + ' caracteres';
    foot.append(saveBtn, chars);

    art.append(head, ta, foot);
    return art;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function pickFile(accept) {
    return new Promise((res) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept || '.md,.tex,.txt';
      input.onchange = () => res(input.files[0] || null);
      input.click();
    });
  }

  async function saveModelFromSection(kind) {
    const s = active();
    if (!s) return;
    const content = kind === 'master' ? s.master : s.template;
    if (!(content || '').trim()) {
      toast('Nada para salvar — o campo está vazio.', 'warn');
      return;
    }
    const arr = libArr(kind);
    if (arr.length >= LIB_MAX) {
      toast('Limite de ' + LIB_MAX + ' atingido na biblioteca — exclua um item para salvar outro.', 'err');
      return;
    }
    const defName = kind === 'master'
      ? 'Master ' + (s.lang === 'pt' ? 'PT' : 'EN')
      : 'Template da seção';
    const name = await modal.prompt({
      title: 'Salvar como modelo',
      message: 'Nome do modelo na biblioteca:',
      initial: defName,
      placeholder: defName,
      okText: 'Salvar',
    });
    if (name === null) return;
    const entry = { id: 'x' + Date.now().toString(36), name: name.trim() || defName, content };
    if (kind === 'master') entry.lang = s.lang;
    arr.push(entry);
    saveAll();
    renderLibrary();
    renderLibSelects();
    toast('"' + entry.name + '" salvo na biblioteca', 'ok');
  }

  function applyLibToSection(kind, id) {
    const entry = libArr(kind).find((e) => e.id === id);
    const s = active();
    if (!entry || !s) return;
    if (kind === 'master') {
      s.master = entry.content;
      if (entry.lang) s.lang = entry.lang;
      s.masterId = entry.id;
    } else {
      s.template = entry.content;
      s.templateId = entry.id;
    }
    touch(s);
    saveAll();
    fillStep1();
    toast('Copiado da biblioteca: "' + entry.name + '" (edição livre nesta seção)', 'ok');
  }

  function renderLibSelects() {
    const s = active();
    [['master-lib', 'master'], ['template-lib', 'template']].forEach(([selId, kind]) => {
      const sel = $(selId);
      const arr = libArr(kind);
      sel.innerHTML = '';
      const ph = document.createElement('option');
      ph.value = '';
      const curId = kind === 'master' ? (s && s.masterId) : (s && s.templateId);
      ph.textContent = curId && !arr.some((e) => e.id === curId) ? '— personalizado —' : '— biblioteca —';
      sel.appendChild(ph);
      arr.forEach((e) => {
        const o = document.createElement('option');
        o.value = e.id;
        o.textContent = e.name + (kind === 'master' && e.lang ? ' (' + e.lang.toUpperCase() + ')' : '');
        sel.appendChild(o);
      });
      const mg = document.createElement('option');
      mg.value = '__manage__';
      mg.textContent = 'Gerenciar biblioteca…';
      sel.appendChild(mg);
      sel.value = curId && arr.some((e) => e.id === curId) ? curId : '';
    });
  }

  // ---------- Sidebar (menu global) ----------
  let lastFocus = null;

  function activateTab(tab) {
    document.querySelectorAll('.sidebar-tab').forEach((t) => {
      const on = t.dataset.tab === tab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('.sidebar-pane').forEach((p) => {
      p.hidden = p.dataset.pane !== tab;
    });
  }

  function openSidebar(tab) {
    lastFocus = document.activeElement;
    renderLibrary();
    activateTab(tab || 'lib');
    $('sidebar-backdrop').hidden = false;
    const sb = $('sidebar');
    sb.classList.add('open');
    sb.setAttribute('aria-hidden', 'false');
    $('btn-sidebar-close').focus();
  }

  function closeSidebar() {
    const sb = $('sidebar');
    if (!sb.classList.contains('open')) return;
    sb.classList.remove('open');
    sb.setAttribute('aria-hidden', 'true');
    $('sidebar-backdrop').hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  // ---------- Seções ----------
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
    const name = await modal.prompt({
      title: 'Nova seção',
      message: 'Nome da seção (vaga):',
      initial: 'Vaga — ' + new Date().toLocaleDateString('pt-BR'),
      okText: 'Criar',
    });
    if (name === null) return;
    def.name = name.trim() || 'Vaga nova';
    if (src) {
      def.master = src.master;
      def.lang = src.lang;
      def.masterId = src.masterId || null;
      def.template = src.template;
      def.templateId = src.templateId || null;
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
    renderLibSelects();
    fillStep1();
    goTo(1);
    toast('Seção "' + def.name + '" criada', 'ok');
  }

  async function renameSection() {
    const s = active();
    if (!s) return;
    const n = await modal.prompt({
      title: 'Renomear seção',
      initial: s.name,
      okText: 'Renomear',
    });
    if (n && n.trim()) {
      s.name = n.trim();
      touch(s);
      saveAll();
      renderSections();
    }
  }

  async function duplicateSection() {
    const s = active();
    if (!s) return;
    const copy = Object.assign(defaultSection(), JSON.parse(JSON.stringify(s)));
    copy.name = s.name + ' (cópia)';
    copy.cvOut = '';
    copy.cover = '';
    copy.tex = '';
    copy.chat = [];
    const id = 's' + Date.now().toString(36);
    sections[id] = copy;
    activeId = id;
    saveAll();
    renderSections();
    renderLibSelects();
    fillStep1();
    toast('Seção duplicada — conteúdo gerado foi limpo', 'ok');
  }

  async function deleteSection() {
    const s = active();
    if (!s) return;
    const ok = await modal.confirm({
      title: 'Excluir seção?',
      message: 'Excluir <b>' + escapeHtml(s.name) + '</b>? Não tem volta.',
      confirmText: 'Excluir',
      danger: true,
    });
    if (!ok) return;
    delete sections[activeId];
    const ids = Object.keys(sections);
    activeId = ids.length ? ids[0] : null;
    saveAll();
    renderSections();
    renderLibSelects();
    fillStep1();
    toast('Seção excluída', 'ok');
  }

  function exportSections() {
    const payload = { exportedAt: now(), config, library, sections };
    download('riki-secoes-' + Date.now() + '.json', JSON.stringify(payload, null, 2), 'application/json');
    toast('Backup JSON baixado', 'ok');
  }

  async function importSections(file) {
    try {
      const data = JSON.parse(await readFile(file));
      if (!data.sections || typeof data.sections !== 'object') throw new Error('JSON sem "sections"');
      Object.assign(sections, data.sections);
      if (data.config) Object.assign(config, data.config);
      if (data.library && typeof data.library === 'object') {
        ['masters', 'templates'].forEach((k) => {
          if (!Array.isArray(data.library[k])) return;
          const target = library[k] || (library[k] = []);
          data.library[k].forEach((incoming) => {
            if (!target.some((e) => e.id === incoming.id)) target.push(incoming);
          });
          if (target.length > LIB_MAX) library[k] = target.slice(-LIB_MAX);
        });
      }
      const ids = Object.keys(sections);
      if (ids.length && !sections[activeId]) activeId = ids[0];
      saveAll();
      renderSections();
      renderLibSelects();
      fillStep1();
      fillConfig();
      toast('Importado: ' + ids.length + ' seção(ões)', 'ok');
    } catch (e) {
      toast('Importação falhou: ' + e.message, 'err');
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
        else {
          s[key] = el.value;
          if ((key === 'master' && s.masterId) || (key === 'template' && s.templateId)) {
            s[key === 'master' ? 'masterId' : 'templateId'] = null;
            renderLibSelects();
          }
        }
        touch(s);
        saveAll();
        if (el.tagName === 'TEXTAREA') updateCounter(key);
      });
    });

    document.querySelectorAll('[data-upload]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const f = await pickFile(btn.dataset.upload === 'json' ? '.json' : '.md,.tex,.txt');
        if (!f) return;
        if (btn.dataset.upload === 'json') return importSections(f);
        const s = active();
        if (!s) return;
        const txt = await readFile(f);
        const key = btn.dataset.upload;
        s[key] = txt;
        touch(s);
        saveAll();
        if (key === 'master') {
          s.lang = f.name.includes('PT') ? 'pt' : 'en';
          $('lang').value = s.lang;
        }
        if (['cvOut', 'cover', 'tex'].includes(key)) {
          $(key).value = txt;
          updateCounter(key);
        }
        fillStep1();
        toast('Arquivo "' + f.name + '" carregado', 'ok');
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
        touch(s);
        saveAll();
        fillStep1();
        toast('Restaurado padrão de data/', 'ok');
      });
    });

    document.querySelectorAll('[data-save-model]').forEach((btn) => {
      btn.addEventListener('click', () => saveModelFromSection(btn.dataset.saveModel));
    });

    $('master-lib').addEventListener('change', (e) => onLibSelect(e.target, 'master'));
    $('template-lib').addEventListener('change', (e) => onLibSelect(e.target, 'template'));

    document.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ta = $(btn.dataset.copy);
        if (ta && ta.value.trim()) copyText(ta.value, 'Copiado');
        else toast('Nada para copiar ainda.', 'warn');
      });
    });
  }

  function onLibSelect(sel, kind) {
    const v = sel.value;
    if (v === '') return;
    if (v === '__manage__') {
      openSidebar('lib');
      renderLibSelects();
      return;
    }
    applyLibToSection(kind, v);
  }

  function fillStep1() {
    const s = active();
    if (!s) { $('step1-empty').style.display = 'block'; return; }
    $('step1-empty').style.display = 'none';
    ['role', 'master', 'template', 'pitch'].forEach((k) => { $(k).value = s[k]; });
    $('lang').value = s.lang;
    $('genCover').checked = s.genCover;
    renderLibSelects();
    updateAllCounters();
    if (window.Chat) Chat.render();
  }

  async function fetchText(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('Falha ao carregar ' + url + ': HTTP ' + r.status);
    return await r.text();
  }

  // ---------- LLM ----------
  async function generate(fn, btnId, busyLabel) {
    const s = active();
    if (!s) return;
    setBusy(btnId, true);
    if (busyLabel) setStatus(busyLabel + '…', 'busy');
    progress(true);
    try {
      await fn(s);
    } catch (e) {
      setStatus('ERRO: ' + e.message, 'err');
      log('ERRO:', e.message);
      toast(e.code === 'NO_KEY' ? e.message + ' Abra o menu (LLM).' : e.message, 'err', 6000);
    } finally {
      setBusy(btnId, false);
      progress(false);
    }
  }

  async function genCvOut(s) {
    if (!s.role.trim()) { toast('Cole a descrição da vaga antes de gerar o CV.', 'warn'); return; }
    if (!s.master.trim()) { toast('O CV master está vazio — carregue ou cole um CV.', 'warn'); return; }
    setStatus('Gerando CV_OUT.md (' + config.model + ')…', 'busy');
    s.cvOut = await tellChat(buildAtsPrompt(s.master, s.lang, s.role), config);
    $('cvOut').value = s.cvOut;
    updateCounter('cvOut');
    touch(s); saveAll();
    setStatus('CV_OUT.md gerado — revise na Etapa 2', 'ok');
    toast('CV_OUT.md pronto na Etapa 2', 'ok');
  }

  async function genCover(s) {
    if (!(s.cvOut.trim() || s.master.trim())) { toast('Gere o CV_OUT.md ou tenha um CV master antes do cover.', 'warn'); return; }
    setStatus('Gerando cover.md (' + config.model + ')…', 'busy');
    s.cover = await tellChat(buildCoverPrompt(s.cvOut || s.master, s.lang, s.role, s.pitch), config);
    $('cover').value = s.cover;
    updateCounter('cover');
    touch(s); saveAll();
    setStatus('cover.md gerado', 'ok');
    toast('cover.md pronto', 'ok');
  }

  async function toTex(s) {
    if (!(s.cvOut.trim() || s.master.trim())) { toast('Sem conteúdo markdown para converter.', 'warn'); return; }
    if (!s.template.trim()) { toast('O template LaTeX está vazio — carregue um da biblioteca.', 'warn'); return; }
    setStatus('Convertendo markdown → LaTeX (' + config.model + ')…', 'busy');
    s.tex = await tellChat(buildTexPrompt(s.cvOut || s.master, s.template), config);
    $('tex').value = s.tex;
    updateCounter('tex');
    touch(s); saveAll();
    setStatus('.tex gerado — revise e compile na Etapa 3', 'ok');
    toast('.tex gerado na Etapa 3', 'ok');
    goTo(3);
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
      toast('Compile o que? O CV.tex está vazio.', 'warn');
      return;
    }
    setBusy('btn-compile', true);
    setStatus('Compilando PDF (1ª vez ~20 min)…', 'busy');
    log('--- compile start (' + now() + ') ---');
    progress(true);
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
        toast('PDF compilado com sucesso', 'ok');
      } else {
        setStatus('ERRO no compile (status ' + res.status + ') — ver log', 'err');
        log(res.log || '');
        toast('Falhou o compile — veja o log abaixo do viewer', 'err');
      }
    } catch (e) {
      clearInterval(timer);
      setStatus('ERRO no compile: ' + e.message, 'err');
      log('ERRO:', e.message);
      toast('ERRO no compile: ' + e.message, 'err');
    } finally {
      clearInterval(timer);
      setBusy('btn-compile', false);
      progress(false);
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
    document.querySelectorAll('.step-dot').forEach((d, i) => {
      d.classList.toggle('active', i + 1 === n);
      d.classList.toggle('done', i + 1 < n);
      if (i + 1 === n) d.setAttribute('aria-current', 'step');
      else d.removeAttribute('aria-current');
    });
    step(n).style.display = 'block';
    if (n === 3 && window.Chat) Chat.render();
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
      setBusy('btn-cfg-test', true);
      setStatus('Testando conexão LLM…', 'busy');
      try {
        const r = await llmTest(config);
        setStatus('Conexão LLM: ' + r, 'ok');
        log('LLM test:', r);
        toast(r, 'ok', 6000);
      } catch (e) {
        setStatus('Conexão LLM falhou: ' + e.message, 'err');
        log('LLM test falhou:', e.message);
        toast('Conexão LLM falhou: ' + e.message, 'err', 6000);
      } finally {
        setBusy('btn-cfg-test', false);
      }
    });
  }

  // ---------- Init ----------
  async function init() {
    initTheme();
    loadAll();

    $('btn-theme').addEventListener('click', () => {
      applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    });
    $('btn-menu').addEventListener('click', () => openSidebar('lib'));
    $('btn-cfg').addEventListener('click', () => openSidebar('llm'));
    $('btn-sidebar-close').addEventListener('click', closeSidebar);
    $('sidebar-backdrop').addEventListener('click', closeSidebar);
    document.querySelectorAll('.sidebar-tab').forEach((t) => {
      t.addEventListener('click', () => activateTab(t.dataset.tab));
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeSidebar();
    });
    $('btn-add-master').addEventListener('click', () => addLibraryEntry('master'));
    $('btn-add-template').addEventListener('click', () => addLibraryEntry('template'));
    $('btn-save-master-model').addEventListener('click', () => saveModelFromSection('master'));
    $('btn-save-template-model').addEventListener('click', () => saveModelFromSection('template'));

    if (!Object.keys(sections).length) {
      await createInitial();
    }
    await ensureLibrarySeed();

    renderSections();
    fillStep1();
    fillConfig();
    renderLibrary();
    bindFields();
    bindConfig();

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
        updateCounter(k);
      });
    });
    updateAllCounters();

    $('btn-new-section').addEventListener('click', createSection);
    $('btn-rename-section').addEventListener('click', renameSection);
    $('btn-dup-section').addEventListener('click', duplicateSection);
    $('btn-del-section').addEventListener('click', deleteSection);
    $('btn-export').addEventListener('click', exportSections);
    $('section-select').addEventListener('change', (e) => switchSection(e.target.value));

    $('btn-gen-cv').addEventListener('click', () => generate(genCvOut, 'btn-gen-cv', 'Gerando CV_OUT.md'));
    $('btn-gen-cover').addEventListener('click', () => generate(genCover, 'btn-gen-cover', 'Gerando cover.md'));
    $('btn-to-tex').addEventListener('click', () => generate(toTex, 'btn-to-tex', 'Convertendo para LaTeX'));
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
      } else {
        toast('Compile o PDF primeiro.', 'warn');
      }
    });

    Chat.init({
      getSection: active,
      getConfig: () => config,
      touch,
      saveAll,
      toast,
      confirm: modal.confirm,
      openLlmConfig: () => openSidebar('llm'),
    });

    goTo(1);
    if (!active()) $('step1-empty').style.display = 'block';
    setStatus('Pronto', 'ok');
    saveAll();
  }

  function addLibraryEntry(kind) {
    const arr = libArr(kind);
    if (arr.length >= LIB_MAX) {
      toast('Limite de ' + LIB_MAX + ' itens na biblioteca.', 'warn');
      return;
    }
    const entry = { id: 'x' + Date.now().toString(36), name: '', content: '' };
    if (kind === 'master') entry.lang = 'en';
    arr.push(entry);
    saveAll();
    renderLibrary();
    const list = $(kind === 'master' ? 'lib-masters' : 'lib-templates');
    const art = list.querySelector('[data-id="' + entry.id + '"] .lib-name');
    if (art) art.focus();
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
