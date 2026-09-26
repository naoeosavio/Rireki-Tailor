// RirekiTailor Web — main app.
// Sections (per-job workspaces) + 3-step stepper + LLM + SwiftLaTeX engine.
// UI: dark/light themes, toasts, custom modals, global menu (master/template
// library + LLM config), per-section chat (js/chat.js).

(function () {
  'use strict';

  // ---------- State ----------
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

  /* Text fields per step — the canonical list used by updateAllCounters,
   * fillStep1 and clearStep1Fields. */
  const STEP1_FIELDS = ['role', 'master', 'template', 'pitch'];
  const STEP2_FIELDS = ['cvOut', 'cover', 'tex'];
  const TEXT_FIELDS = STEP1_FIELDS.concat(STEP2_FIELDS);

  let config = {
    model: 'j',
    keys: {},
    urls: {},
  };
  let sections = Object.create(null);
  let library = { masters: [], templates: [] };
  let activeId = null;
  let engine = null;
  let enginePromise = null;
  let pdfUrl = null;
  let pdfSectionId = null;

  const $ = (id) => document.getElementById(id);
  const step = (n) => document.querySelectorAll('.panel')[n - 1];

  function defaultSection() {
    return {
      name: 'New job',
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

  function now() { return new Date().toLocaleString('en-US'); }
  function touch(s) { s.updatedAt = Date.now(); }
  function active() { return sections[activeId] || null; }

  // ---------- Theme ----------
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem(LS_THEME, t);
    } catch (_) { /* storage blocked: the theme stays in memory only */ }
  }

  function initTheme() {
    /* localStorage can throw (SecurityError with storage blocked, opaque
     * iframe): without the try, init() would die before wiring any handler
     * and the page would be dead. */
    let saved = null;
    try {
      saved = localStorage.getItem(LS_THEME);
    } catch (_) { saved = null; }
    const t = saved || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    applyTheme(t);
  }

  // ---------- Persistence ----------
  let quotaWarned = false;

  function saveAll() {
    try {
      localStorage.setItem(LS_CONFIG, JSON.stringify(config));
      localStorage.setItem(LS_SECTIONS, JSON.stringify(sections));
      localStorage.setItem(LS_LIBRARY, JSON.stringify(library));
      localStorage.setItem(LS_ACTIVE, activeId || '');
    } catch (e) {
      const isQuota = e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014);
      if (isQuota && !quotaWarned) {
        quotaWarned = true;
        toast('Browser storage full — the last edits were not saved. Export a backup and delete old sections.', 'err', 9000);
      } else if (!isQuota) {
        console.error('save failed', e);
      }
      return;
    }
    quotaWarned = false;
    const s = active();
    if (s && s.updatedAt) {
      const el = $('last-saved');
      if (el) el.textContent = 'last edit: ' + new Date(s.updatedAt).toLocaleString('en-US');
    }
  }

  /* Typing fires saveAll on every keystroke — serializes ALL sections.
   * 400ms debounce; the beforeunload flush guarantees the last edit. */
  let saveTimer = null;
  let libSaveTimer = null;
  function saveAllDebounced() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveAll, 400);
  }
  function flushPendingSave() {
    /* Two pending timers (typing + library): unloading the tab without
     * clearing the library one lost the edit — the unload saveAll() never
     * went through libDebouncedSave(). */
    let pending = false;
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
      pending = true;
    }
    if (libSaveTimer !== null) {
      clearTimeout(libSaveTimer);
      libSaveTimer = null;
      pending = true;
    }
    if (pending) saveAll();
  }

  /* Fills in DEFAULT_URLS (llm.js loads before app.js) so the URL fields
   * start out populated; whatever the user edits takes priority. */
  function backfillDefaultUrls(cfg) {
    LLM_VENDORS.forEach((v) => {
      if (!cfg.urls[v] && DEFAULT_URLS[v]) cfg.urls[v] = DEFAULT_URLS[v];
    });
  }

  /* Each key is read in isolation: one corrupted key must not take down the
   * others, and the raw value goes to <key>.backup instead of being
   * overwritten by a reset — the saveAll() at the end of init() would write
   * that reset on top of the user's data. */
  function loadJsonKey(key, fallback) {
    const read = readJsonSafe(localStorage, key);
    if (!read.found) return fallback;
    if (!read.ok) {
      stashCorruptValue(localStorage, key, read.raw);
      console.warn('localStorage:', key, 'corrupted — raw value preserved at', key + '.backup');
      return fallback;
    }
    return read.value;
  }

  function loadAll() {
    config = normalizeConfig(loadJsonKey(LS_CONFIG, {}), LLM_VENDORS);
    backfillDefaultUrls(config);
    sections = normalizeSections(loadJsonKey(LS_SECTIONS, {}));
    library = normalizeLibrary(loadJsonKey(LS_LIBRARY, null));
    /* Direct read (does not go through readJsonSafe): without the try,
     * blocked storage took down init before wiring the handlers. */
    let a = null;
    try {
      a = localStorage.getItem(LS_ACTIVE);
    } catch (_) { a = null; }
    activeId = a && sections[a] ? a : null;
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
    const ls = el.textContent.split('\n');
    if (ls.length > 200) el.textContent = ls.slice(-200).join('\n');
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
      toast(okMsg || 'Copied to clipboard', 'ok');
    } catch (e) {
      toast('Could not copy: ' + e.message, 'err');
    }
  }

  function updateCounter(key) {
    const ta = $(key);
    const el = document.querySelector('[data-count-for="' + key + '"]');
    if (!ta || !el) return;
    el.textContent = ta.value.length.toLocaleString('en-US') + ' characters';
  }

  function updateAllCounters() {
    TEXT_FIELDS.forEach(updateCounter);
  }

  // ---------- Toasts ----------
  function toast(msg, type, ms) {
    const box = $('toasts');
    if (!box) return;
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
    x.setAttribute('aria-label', 'Dismiss notification');
    x.innerHTML = '<svg class="ic"><use href="#i-close"/></svg>';
    x.addEventListener('click', dismiss);
    el.append(body, x);
    box.appendChild(el);
    setTimeout(dismiss, ms || 4200);
  }

  // ---------- Modals (replace native prompt/confirm/alert) ----------
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
        cancelBtn.textContent = opts.cancelText || 'Cancel';
        cancelBtn.addEventListener('click', () => finish(opts.input ? null : false));
        foot.appendChild(cancelBtn);
      }
      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = 'primary' + (opts.danger ? ' danger' : '');
      okBtn.textContent = opts.confirmText || opts.okText || 'OK';
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
    confirm: (o) => buildModal(Object.assign({ okText: 'Confirm' }, o)).then((v) => v === true),
    prompt: (o) => buildModal(Object.assign({ input: true }, o)).then((v) => (typeof v === 'string' ? v : null)),
    alert: (o) => buildModal(Object.assign({ alertOnly: true, okText: 'Got it' }, o)),
  };

  // ---------- Global library (masters/templates) ----------
  function libArr(kind) { return kind === 'master' ? library.masters : library.templates; }

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
        name: 'Master EN (default)',
        lang: 'en',
        content: en,
      });
      library.templates.push({
        id: 't' + Date.now().toString(36),
        name: 'CV_ATS (default)',
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
    name.placeholder = kind === 'master' ? 'Master name' : 'Template name';
    name.setAttribute('aria-label', 'Name');
    name.addEventListener('input', () => { entry.name = name.value; libDebouncedSave(); });
    head.appendChild(name);

    if (kind === 'master') {
      const lang = document.createElement('select');
      lang.className = 'lib-lang';
      lang.setAttribute('aria-label', 'Master language');
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
    const useBtn = mkIcon('check', 'Use in this section');
    useBtn.addEventListener('click', () => applyLibToSection(kind, entry.id));
    const upBtn = mkIcon('upload', 'Upload file');
    upBtn.addEventListener('click', () => pickFile('.md,.tex,.txt').then(async (f) => {
      if (!f) return;
      if (isFileTooBig(f.size)) {
        toast('File too large — 8 MB limit per upload.', 'err', 6000);
        return;
      }
      entry.content = await readFile(f);
      libDebouncedSave();
      renderLibrary();
      toast('File loaded into "' + (entry.name || 'unnamed') + '" — click Save to make sure it sticks.', 'ok');
    }));
    const delBtn = mkIcon('trash', 'Delete', 'icon-btn danger-ghost');
    delBtn.addEventListener('click', async () => {
      const ok = await modal.confirm({
        title: 'Delete from library?',
        message: 'Remove <b>' + escapeHtml(entry.name || 'unnamed') + '</b>? Sections that already copied the content are not affected.',
        confirmText: 'Delete',
        danger: true,
      });
      if (!ok) return;
      const arr = libArr(kind);
      arr.splice(arr.indexOf(entry), 1);
      saveAll();
      renderLibrary();
      renderLibSelects();
      toast('Item deleted from library', 'ok');
    });
    acts.append(useBtn, upBtn, delBtn);
    head.appendChild(acts);

    const ta = document.createElement('textarea');
    ta.className = 'lib-content';
    ta.value = entry.content;
    ta.spellcheck = false;
    ta.addEventListener('input', () => {
      entry.content = ta.value;
      chars.textContent = ta.value.length.toLocaleString('en-US') + ' characters';
      libDebouncedSave();
    });

    const foot = document.createElement('div');
    foot.className = 'lib-entry-foot';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'sm primary';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => {
      if (!entry.name.trim()) { toast('Name the model before saving.', 'warn'); return; }
      saveAll();
      renderLibSelects();
      toast('Model "' + entry.name + '" saved to library', 'ok');
    });
    const chars = document.createElement('span');
    chars.className = 'meta';
    chars.textContent = (entry.content || '').length.toLocaleString('en-US') + ' characters';
    foot.append(saveBtn, chars);

    art.append(head, ta, foot);
    return art;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function sanitizeEol(text, delim) {
    const first = text.indexOf(delim);
    if (first === -1) return text;
    const after = first + delim.length;
    const second = text.indexOf(delim, after);
    if (second === -1) return text;
    return text.slice(after, second).trim();
  }

  function sanitizeFenced(text) {
    const m = text.match(/```[^\n]*\n?([\s\S]*?)```/);
    return m ? m[1].trim() : text;
  }

  function sanitizeLatexBody(text) {
    const delim = '\\end{document}';
    const i = text.indexOf('\\documentclass');
    const j = text.indexOf(delim);
    if (i === -1 || j === -1) return text;
    return text.slice(i, j + delim.length).trim();
  }

  const TEX_END_RE = /\\end\s*\{(?:document|end)\}/i;

  function sanitizeTex(text) {
    const cleaned = sanitizeFenced(String(text == null ? '' : text))
      .replace(/<\/?RUN>/gi, '')
      .replace(/^[\t ]*(?:cat|tee)\b[^\n]*<<-?[\t ]*['"]?[A-Za-z_]\w*['"]?[^\n]*$/gm, '')
      .replace(/^[\t ]*(?:pdflatex|xelatex|lualatex|latex|latexmk)\b[^\n]*$/gm, '')
      .replace(/^[\t ]*(?:EOL|EOF)[\t ]*$/gm, '');
    const i = cleaned.indexOf('\\documentclass');
    if (i === -1) return cleaned.trim();
    const body = cleaned.slice(i);
    const m = body.match(TEX_END_RE);
    if (!m) return body.trim();
    return body.slice(0, m.index).trim() + '\n\n\\end{document}\n';
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
      toast('Nothing to save — the field is empty.', 'warn');
      return;
    }
    const arr = libArr(kind);
    if (arr.length >= LIB_MAX) {
      toast('Library limit of ' + LIB_MAX + ' reached — delete an item to save another.', 'err');
      return;
    }
    const defName = kind === 'master'
      ? 'Master ' + (s.lang === 'pt' ? 'PT' : 'EN')
      : 'Section template';
    const name = await modal.prompt({
      title: 'Save as model',
      message: 'Model name in the library:',
      initial: defName,
      placeholder: defName,
      okText: 'Save',
    });
    if (name === null) return;
    const entry = { id: 'x' + Date.now().toString(36), name: name.trim() || defName, content };
    if (kind === 'master') entry.lang = s.lang;
    arr.push(entry);
    saveAll();
    renderLibrary();
    renderLibSelects();
    toast('"' + entry.name + '" saved to library', 'ok');
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
    toast('Copied from library: "' + entry.name + '" (freely editable in this section)', 'ok');
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
      ph.textContent = curId && !arr.some((e) => e.id === curId) ? '— customized —' : '— library —';
      sel.appendChild(ph);
      arr.forEach((e) => {
        const o = document.createElement('option');
        o.value = e.id;
        o.textContent = e.name + (kind === 'master' && e.lang ? ' (' + e.lang.toUpperCase() + ')' : '');
        sel.appendChild(o);
      });
      const mg = document.createElement('option');
      mg.value = '__manage__';
      mg.textContent = 'Manage library…';
      sel.appendChild(mg);
      sel.value = curId && arr.some((e) => e.id === curId) ? curId : '';
    });
  }

  // ---------- Sidebar (global menu) ----------
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

  // ---------- Sections ----------
  function renderSections() {
    const sel = $('section-select');
    sel.innerHTML = '';
    Object.keys(sections).sort((a, b) => sections[b].updatedAt - sections[a].updatedAt).forEach((id) => {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = sections[id].name + ' — ' + new Date(sections[id].updatedAt).toLocaleDateString('en-US');
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
    const src = active();
    const def = defaultSection();
    const name = await modal.prompt({
      title: 'New section',
      message: 'Section name (job):',
      initial: 'Job — ' + new Date().toLocaleDateString('en-US'),
      okText: 'Create',
    });
    if (name === null) return;
    def.name = name.trim() || 'New job';
    if (src) {
      def.master = src.master;
      def.lang = src.lang;
      def.masterId = src.masterId || null;
      def.template = src.template;
      def.templateId = src.templateId || null;
      def.pitch = src.pitch;
    } else {
      try {
        def.master = await fetchText(DEFAULT_FILES.masterEn);
        def.template = await fetchText(DEFAULT_FILES.template);
      } catch (e) {
        console.warn('defaults fetch failed', e);
      }
    }
    const id = 's' + Date.now().toString(36);
    sections[id] = def;
    activeId = id;
    saveAll();
    renderSections();
    renderLibSelects();
    fillStep1();
    goTo(1);
    toast('Section "' + def.name + '" created', 'ok');
  }

  async function renameSection() {
    const s = active();
    if (!s) return;
    const n = await modal.prompt({
      title: 'Rename section',
      initial: s.name,
      okText: 'Rename',
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
    copy.name = s.name + ' (copy)';
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
    toast('Section duplicated — generated content was cleared', 'ok');
  }

  async function deleteSection() {
    const s = active();
    if (!s) return;
    const ok = await modal.confirm({
      title: 'Delete section?',
      message: 'Delete <b>' + escapeHtml(s.name) + '</b>? This cannot be undone.',
      confirmText: 'Delete',
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
    toast('Section deleted', 'ok');
  }

  function exportSections() {
    /* Sanitized config: model/urls are useful for restoring; keys never leave here */
    const safeConfig = { model: config.model, urls: Object.assign({}, config.urls) };
    const payload = { exportedAt: now(), config: safeConfig, library, sections };
    download('riki-secoes-' + Date.now() + '.json', JSON.stringify(payload, null, 2), 'application/json');
    toast('JSON backup downloaded — without the API keys (for safety)', 'ok');
  }

  async function importSections(file) {
    /* Without a ceiling, a multi-GB file would go entirely into RAM via FileReader. */
    if (isFileTooBig(file.size)) {
      toast('Backup too large — 8 MB limit per import.', 'err', 6000);
      return;
    }
    try {
      const data = JSON.parse(await readFile(file));
      if (!data || typeof data !== 'object' || !data.sections || typeof data.sections !== 'object' || Array.isArray(data.sections)) {
        throw new Error('JSON sem "sections"');
      }
      let skippedSections = 0;
      Object.keys(data.sections).forEach((id) => {
        /* Capped import batch: thousands of sections would freeze rendering
         * and persist the freeze. Existing ones may still update. */
        if (!sections[id] && Object.keys(sections).length >= STORE_MAX_SECTIONS) { skippedSections++; return; }
        sections[id] = normalizeSection(data.sections[id]);
      });
      if (data.config) Object.assign(config, normalizeConfig(data.config, LLM_VENDORS));
      if (data.library && typeof data.library === 'object' && !Array.isArray(data.library)) {
        [['masters', 'master'], ['templates', 'template']].forEach(([listKey, kind]) => {
          const merged = mergeLibraryList(library[listKey], data.library[listKey], kind, LIB_MAX);
          library[listKey] = merged.merged;
          if (merged.skipped) {
            toast('Library: ' + merged.skipped + ' item(s) skipped — limit of ' + LIB_MAX + ' or duplicate id.', 'warn', 6000);
          }
        });
      }
      const ids = Object.keys(sections);
      if (ids.length && !sections[activeId]) activeId = ids[0];
      saveAll();
      renderSections();
      renderLibSelects();
      fillStep1();
      fillConfig();
      toast('Imported: ' + ids.length + ' section(s)' + (skippedSections ? ' — ' + skippedSections + ' skipped by the ' + STORE_MAX_SECTIONS + ' limit' : ''), skippedSections ? 'warn' : 'ok');
    } catch (e) {
      toast('Import failed: ' + e.message, 'err');
    }
  }

  // ---------- Step 1 ----------
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
        saveAllDebounced();
        if (el.tagName === 'TEXTAREA') updateCounter(key);
      });
    });

    document.querySelectorAll('[data-upload]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const f = await pickFile(btn.dataset.upload === 'json' ? '.json' : '.md,.tex,.txt');
        if (!f) return;
        /* FileReader without a ceiling: a multi-GB file would go entirely
         * into RAM and then blow the localStorage quota on saveAll. */
        if (isFileTooBig(f.size)) {
          toast('File too large — 8 MB limit per upload.', 'err', 6000);
          return;
        }
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
        toast('File "' + f.name + '" loaded', 'ok');
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
        toast('Restored default from data/', 'ok');
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
        if (ta && ta.value.trim()) copyText(ta.value, 'Copied');
        else toast('Nothing to copy yet.', 'warn');
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

  function hidePdf() {
    if (pdfUrl) { URL.revokeObjectURL(pdfUrl); pdfUrl = null; }
    pdfSectionId = null;
    const viewer = $('viewer');
    if (viewer) {
      viewer.removeAttribute('src');
      viewer.style.display = 'none';
    }
  }

  function clearStep1Fields() {
    TEXT_FIELDS.forEach((k) => { $(k).value = ''; });
    $('lang').value = 'en';
    $('genCover').checked = false;
  }

  function fillStep1() {
    const s = active();
    if (!s) {
      /* With no active section, the form and PDF left over from the deleted
       * section would stay on screen as if they were the current section's data. */
      $('step1-empty').style.display = 'block';
      clearStep1Fields();
      hidePdf();
      updateAllCounters();
      renderLibSelects();
      if (window.Chat) Chat.render();
      return;
    }
    $('step1-empty').style.display = 'none';
    STEP1_FIELDS.forEach((k) => { $(k).value = s[k]; });
    STEP2_FIELDS.forEach((k) => { $(k).value = s[k] || ''; });
    $('lang').value = s.lang;
    $('genCover').checked = s.genCover;
    if (pdfSectionId !== activeId) hidePdf();
    renderLibSelects();
    updateAllCounters();
    if (window.Chat) Chat.render();
  }

  async function fetchText(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('Failed to load ' + url + ': HTTP ' + r.status);
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
      setStatus('ERROR: ' + e.message, 'err');
      log('ERROR:', e.message);
      toast(e.code === 'NO_KEY' ? e.message + ' Open the menu (LLM).' : e.message, 'err', 6000);
    } finally {
      setBusy(btnId, false);
      progress(false);
    }
  }

  async function genCvOut(s) {
    if (!s.role.trim()) { toast('Paste the job description before generating the CV.', 'warn'); return; }
    if (!s.master.trim()) { toast('The master CV is empty — upload or paste a CV.', 'warn'); return; }
    setStatus('Generating CV_OUT.md (' + config.model + ')…', 'busy');
    s.cvOut = sanitizeFenced(await tellChat(buildAtsPrompt(s.master, s.lang, s.role), config));
    $('cvOut').value = s.cvOut;
    updateCounter('cvOut');
    touch(s); saveAll();
    setStatus('CV_OUT.md generated — review it in Step 2', 'ok');
    toast('CV_OUT.md ready in Step 2', 'ok');
  }

  async function genCover(s) {
    if (!(s.cvOut.trim() || s.master.trim())) { toast('Generate CV_OUT.md or have a master CV before the cover letter.', 'warn'); return; }
    setStatus('Generating cover.md (' + config.model + ')…', 'busy');
    s.cover = sanitizeFenced(await tellChat(buildCoverPrompt(s.cvOut || s.master, s.lang, s.role, s.pitch), config));
    $('cover').value = s.cover;
    updateCounter('cover');
    touch(s); saveAll();
    setStatus('cover.md generated', 'ok');
    toast('cover.md ready', 'ok');
  }

  async function toTex(s) {
    if (!(s.cvOut.trim() || s.master.trim())) { toast('No markdown content to convert.', 'warn'); return; }
    if (!s.template.trim()) { toast('The LaTeX template is empty — load one from the library.', 'warn'); return; }
    setStatus('Converting markdown → LaTeX (' + config.model + ')…', 'busy');
    s.tex = sanitizeTex(await tellChat(buildTexPrompt(s.cvOut || s.master, s.template), config));
    $('tex').value = s.tex;
    updateCounter('tex');
    touch(s); saveAll();
    setStatus('.tex generated — review and compile in Step 3', 'ok');
    toast('.tex generated in Step 3', 'ok');
    goTo(3);
  }

  // ---------- Step 3 / Engine ----------
  function getEngine() {
    if (engine) return Promise.resolve(engine);
    if (!enginePromise) {
      enginePromise = new Promise((resolve, reject) => {
        setStatus('Loading LaTeX engine (first time ~1 min)…', 'busy');
        const e = new PdfTeXEngine();
        e.loadEngine().then(() => {
          engine = e;
          enginePromise = null;
          setStatus('Engine ready', 'ok');
          resolve(e);
        }, (err) => {
          /* Without clearing the promise, the rejection stayed cached and no
           * later compile retried — the page only came back to life on
           * reload. */
          enginePromise = null;
          reject(err);
        });
      });
    }
    return enginePromise;
  }

  async function compilePdf() {
    const s = active();
    if (!s) return;
    if (!s.tex.trim()) {
      setStatus('Step 3: the .tex is empty — generate or paste a .tex.', 'warn');
      toast('Compile what? CV.tex is empty.', 'warn');
      return;
    }
    setBusy('btn-compile', true);
    setStatus('Compiling PDF (first time ~20 min)…', 'busy');
    log('--- compile start (' + now() + ') ---');
    progress(true);
    const t0 = performance.now();
    const timer = setInterval(() => {
      setStatus('Compiling PDF… ' + ((performance.now() - t0) / 1000).toFixed(0) + 's', 'busy');
    }, 30000);
    try {
      const eng = await getEngine();
      clearInterval(timer);
      eng.writeMemFSFile('main.tex', s.tex);
      eng.setEngineMainFile('main.tex');
      const res = await eng.compileLaTeX();
      try { eng.flushCache(); } catch (_) { /* engine may not be ready */ }
      log('status:', res.status, '(' + ((performance.now() - t0) / 1000).toFixed(0) + 's)');
      if (res.status === 0) {
        showPdf(res.pdf);
        setStatus('PDF generated (' + res.pdf.length + ' bytes)', 'ok');
        toast('PDF compiled successfully', 'ok');
      } else {
        setStatus('COMPILE ERROR (status ' + res.status + ') — see log', 'err');
        log(res.log || '');
        toast('Compile failed — see the log below the viewer', 'err');
      }
    } catch (e) {
      clearInterval(timer);
      setStatus('COMPILE ERROR: ' + e.message, 'err');
      log('ERROR:', e.message);
      toast('COMPILE ERROR: ' + e.message, 'err');
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
    pdfSectionId = activeId;
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

  // ---------- LLM config ----------
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
    /* Vendors with no row in the HTML (or future HTML missing the row) must
     * not take down init: without the guard, the TypeError aborted the rest
     * of the listeners and Chat.init — dead page. */
    const modelEl = $('cfg-model');
    if (modelEl) modelEl.addEventListener('input', () => {
      config.model = modelEl.value.trim() || 'g';
      saveAllDebounced();
    });
    LLM_VENDORS.forEach((v) => {
      const k = $('cfg-key-' + v);
      const u = $('cfg-url-' + v);
      if (k) k.addEventListener('input', () => {
        config.keys[v] = k.value.trim();
        saveAllDebounced();
      });
      if (u) u.addEventListener('input', () => {
        config.urls[v] = u.value.trim();
        saveAllDebounced();
      });
    });
    $('btn-cfg-test').addEventListener('click', async () => {
      setBusy('btn-cfg-test', true);
      setStatus('Testing LLM connection…', 'busy');
      try {
        const r = await llmTest(config);
        setStatus('LLM connection: ' + r, 'ok');
        log('LLM test:', r);
        toast(r, 'ok', 6000);
      } catch (e) {
        setStatus('LLM connection failed: ' + e.message, 'err');
        log('LLM test failed:', e.message);
        toast('LLM connection failed: ' + e.message, 'err', 6000);
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
        saveAllDebounced();
        updateCounter(k);
      });
    });
    updateAllCounters();

    window.addEventListener('beforeunload', flushPendingSave);

    $('btn-new-section').addEventListener('click', createSection);
    $('btn-rename-section').addEventListener('click', renameSection);
    $('btn-dup-section').addEventListener('click', duplicateSection);
    $('btn-del-section').addEventListener('click', deleteSection);
    $('btn-export').addEventListener('click', exportSections);
    $('section-select').addEventListener('change', (e) => switchSection(e.target.value));

    $('btn-gen-cv').addEventListener('click', () => generate(genCvOut, 'btn-gen-cv', 'Generating CV_OUT.md'));
    $('btn-gen-cover').addEventListener('click', () => generate(genCover, 'btn-gen-cover', 'Generating cover.md'));
    $('btn-to-tex').addEventListener('click', () => generate(toTex, 'btn-to-tex', 'Converting to LaTeX'));
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
        toast('Compile the PDF first.', 'warn');
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
    setStatus('Ready', 'ok');
    saveAll();
  }

  function addLibraryEntry(kind) {
    const arr = libArr(kind);
    if (arr.length >= LIB_MAX) {
      toast('Library limit of ' + LIB_MAX + ' items.', 'warn');
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
    s.name = 'Default';
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
