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

  // Library ceilings per kind: masters stay at 2 (the masters badge and
  // the audit assert a "/2" range), templates hold the 4 built-in visual
  // models (modern, classic, ats, academic).
  const LIB_MAX_MASTERS = 2;
  const LIB_MAX_TEMPLATES = 4;

  function libMax(kind) {
    if (kind === 'master') {
      return LIB_MAX_MASTERS;
    } else {
      return LIB_MAX_TEMPLATES;
    }
  }

  // Tail of the compiler log sent to the fix prompt. Errors are at the
  // end, and full logs would blow the LLM payload.
  const FIX_LOG_TAIL = 6000;

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
    models: {},
  };
  let sections = Object.create(null);
  let library = { masters: [], templates: [] };
  let activeId = null;
  let engine = null;
  let enginePromise = null;
  let pdfUrl = null;
  let pdfSectionId = null;
  // Transient diagnostic state for the fix button. Never persisted:
  // the last compiler error (or pre-validation refuse reason).
  let lastCompileError = '';

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
      texHash: '',
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
    config = normalizeConfig(loadJsonKey(LS_CONFIG, {}), LLM_VENDORS, defaultModel());
    backfillDefaultUrls(config);
    /* The load has a ceiling: a state with 20000 sections freezes every
     * render and repeats the freeze on every load. */
    sections = normalizeSections(loadJsonKey(LS_SECTIONS, {}), STORE_MAX_SECTIONS_LOAD);
    library = normalizeLibrary(loadJsonKey(LS_LIBRARY, null));
    /* Direct read (does not go through readJsonSafe): without the try,
     * blocked storage took down init before wiring the handlers. */
    let a = null;
    try {
      a = localStorage.getItem(LS_ACTIVE);
    } catch (_) { a = null; }
    /* Without a fallback, a missing active key leaves the list with no
     * selection and the "no section" banner, although sections exist. */
    const ids = Object.keys(sections);
    activeId = a && sections[a] ? a : (ids.length ? ids[0] : null);
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

  // Non-empty text, or '' when the value is missing/blank. Used to
  // prefer data/* files while falling back to the embedded defaults in
  // defaults.js (fresh clone, static hosting without the file, emptied file).
  function nonEmpty(text) {
    const s = typeof text === 'string' ? text : '';
    if (s.trim()) {
      return s;
    } else {
      return '';
    }
  }

  // The fallback returns the version that matches the section language.
  // English is the default language. Portuguese needs explicit 'pt'.
  function embeddedMaster(lang) {
    if (lang === 'pt') {
      if (typeof DEFAULT_MASTER_CV !== 'undefined' && DEFAULT_MASTER_CV.trim()) {
        return DEFAULT_MASTER_CV;
      } else {
        return '';
      }
    } else if (typeof DEFAULT_MASTER_CV_EN !== 'undefined' && DEFAULT_MASTER_CV_EN.trim()) {
      return DEFAULT_MASTER_CV_EN;
    } else if (typeof DEFAULT_MASTER_CV !== 'undefined' && DEFAULT_MASTER_CV.trim()) {
      return DEFAULT_MASTER_CV;
    } else {
      return '';
    }
  }

  function embeddedTemplate(key) {
    if (typeof DEFAULT_TEMPLATES !== 'undefined' && DEFAULT_TEMPLATES[key]) {
      return DEFAULT_TEMPLATES[key];
    } else if (typeof DEFAULT_TEMPLATES !== 'undefined' && DEFAULT_TEMPLATES.ats) {
      return DEFAULT_TEMPLATES.ats;
    } else {
      return '';
    }
  }

  function embeddedRole() {
    if (typeof DEFAULT_ROLE !== 'undefined' && DEFAULT_ROLE.trim()) {
      return DEFAULT_ROLE;
    } else {
      return '';
    }
  }

  /* A fetch of a data file must not wait for ever. A request that never
   * ends blocks the app, and the text the user typed is never saved. */
  const FETCH_TIMEOUT_MS = 15000;

  async function fetchText(url, signal) {
    const r = await fetch(url, signal ? { signal: signal } : undefined);
    if (!r.ok) throw new Error('Failed to load ' + url + ': HTTP ' + r.status);
    return await r.text();
  }

  async function fetchOptional(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetchText(url, controller.signal);
    } catch (e) {
      console.warn('defaults fetch failed', url, e);
      return '';
    } finally {
      clearTimeout(timer);
    }
  }

  // The library holds user content only. The 4 visual templates are
  // read-only models in defaults.js. The seed never copies them.
  async function ensureLibrarySeed() {
    if (library.masters.length) return;
    const fetchedMaster = nonEmpty(await fetchOptional(DEFAULT_FILES.masterEn));
    const masterContent = fetchedMaster || embeddedMaster('en');
    if (!masterContent) {
      console.warn('library seed failed: no data/* content and no embedded master');
      return;
    }
    library.masters.push({
      id: 'm' + Date.now().toString(36),
      name: 'Master (default)',
      lang: 'en',
      content: masterContent,
    });
    saveAll();
  }

  function renderLibrary() {
    [['master', 'lib-masters', 'lib-master-count', 'btn-add-master'],
     ['template', 'lib-templates', 'lib-template-count', 'btn-add-template']]
      .forEach(([kind, listId, countId, addId]) => {
        const arr = libArr(kind);
        const list = $(listId);
        const badge = $(countId);
        badge.textContent = arr.length + '/' + libMax(kind);
        $(addId).disabled = arr.length >= libMax(kind);
        list.innerHTML = '';
        arr.forEach((entry) => list.appendChild(libEntryEl(kind, entry)));
      });
    renderBuiltinModels();
    renderUserModels();
    renderModelCards();
  }

  function mkIconBtn(icon, title, cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls || 'icon-btn';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = '<svg class="ic"><use href="#i-' + icon + '"/></svg>';
    return b;
  }

  // Read-only model entries. Each entry has a name and a Use button.
  // No editor exists, so the user cannot change a model.
  function renderBuiltinModels() {
    const list = $('lib-models');
    if (!list) return;
    const badge = $('lib-models-count');
    const models = builtinModels();
    if (badge) badge.textContent = String(models.length);
    list.innerHTML = '';
    models.forEach((m) => {
      const art = document.createElement('article');
      art.className = 'lib-entry';
      const head = document.createElement('div');
      head.className = 'lib-entry-head';
      const name = document.createElement('span');
      name.className = 'lib-name lib-name-ro';
      name.textContent = m.name;
      head.appendChild(name);
      const useBtn = mkIconBtn('check', 'Use in this section');
      useBtn.addEventListener('click', () => applyBuiltinModel(m.key));
      head.appendChild(useBtn);
      art.appendChild(head);
      list.appendChild(art);
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
    const useBtn = mkIconBtn('check', 'Use in this section');
    useBtn.addEventListener('click', () => applyLibToSection(kind, entry.id));
    const upBtn = mkIconBtn('upload', 'Upload file');
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
    const delBtn = mkIconBtn('trash', 'Delete', 'icon-btn danger-ghost');
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

  function sanitizeFenced(text) {
    const src = String(text == null ? '' : text);
    const m = src.match(/```[^\n]*\n?([\s\S]*?)```/);
    if (m) return m[1].trim();
    /* A reply can end with a fence that never closed. The stray marker
     * reaches pdflatex and breaks the compile. */
    return src.replace(/```[a-zA-Z0-9_-]*/g, '');
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

  // The engine only accepts LaTeX. The LLM sometimes returns markdown
  // despite the prompt, and sanitizeTex passes it through when no
  // \documentclass is found. Compiling that markdown fails with the
  // cryptic "macro parameter character #" error, so classify first
  // with getTexProblem and refuse to compile before PdfTeX runs.
  function getTexProblem(text) {
    const src = String(text == null ? '' : text).trim();
    if (!src) {
      return 'empty';
    } else if (src.indexOf('\\documentclass') === -1) {
      if (/^\s*#{1,6}\s+\S/m.test(src)) {
        return 'markdown';
      } else {
        return 'no-documentclass';
      }
    } else if (src.indexOf('\\begin{document}') === -1) {
      return 'no-begin-document';
    } else if (src.search(TEX_END_RE) === -1) {
      return 'no-end-document';
    } else {
      return null;
    }
  }

  // Pulls the real cause out of a pdflatex transcript. The UI log box
  // only keeps the tail ("Fatal error ... Transcript written"), while
  // the actionable lines ("! ...") sit higher up, so surface them.
  function extractLatexError(logText) {
    const lines = String(logText == null ? '' : logText).split('\n');
    const found = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^! /.test(lines[i])) {
        let err = lines[i];
        const next = (i + 1 < lines.length) ? lines[i + 1].trim() : '';
        if (next && !/^l\.\d+/.test(next) && !/^! /.test(next)) {
          err += ' ' + next;
        } else {
          // Location (l.N) and follow-up bang lines stay separate.
        }
        found.push(err);
        if (found.length >= 3) break;
      }
    }
    if (found.length) {
      return found.join(' | ').slice(0, 300);
    } else {
      return '';
    }
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
    if (arr.length >= libMax(kind)) {
      toast('Library limit of ' + libMax(kind) + ' reached — delete an item to save another.', 'err');
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

  // Read-only visual models from defaults.js. The app copies a model
  // into the active section. The app never writes to the model itself.
  function builtinModels() {
    const meta = (typeof DEFAULT_TEMPLATE_META !== 'undefined')
      ? DEFAULT_TEMPLATE_META
      : [];
    if (typeof DEFAULT_TEMPLATES === 'undefined') {
      return [];
    } else {
      return meta.filter((m) => Boolean(DEFAULT_TEMPLATES[m.key]));
    }
  }

  function applyBuiltinModel(key) {
    const s = active();
    if (!s) return;
    if (typeof DEFAULT_TEMPLATES === 'undefined' || !DEFAULT_TEMPLATES[key]) return;
    s.template = DEFAULT_TEMPLATES[key];
    s.templateId = null;
    markSetupDone();
    touch(s);
    saveAll();
    fillStep1();
    const meta = builtinModels().find((m) => m.key === key);
    toast('Model "' + (meta ? meta.name : key) + '" applied (editable in this section)', 'ok');
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
      if (kind === 'template') {
        builtinModels().forEach((m) => {
          const o = document.createElement('option');
          o.value = '__model:' + m.key;
          o.textContent = 'Model: ' + m.name;
          sel.appendChild(o);
        });
      }
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
    // The error log belongs to the previous section's tex. Keeping it
    // would make Fix with LLM repair the new tex with the old error.
    lastCompileError = '';
    const logEl = $('log');
    if (logEl) logEl.textContent = '—';
    setStatus('Ready', 'ok');
    saveAll();
    renderSections();
    fillStep1();
    applySetupAutoState();
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
      def.master = nonEmpty(await fetchOptional(DEFAULT_FILES.masterEn)) || embeddedMaster(def.lang);
      def.template = nonEmpty(await fetchOptional(DEFAULT_FILES.template)) || embeddedTemplate('ats');
    }
    const id = 's' + Date.now().toString(36);
    sections[id] = def;
    activeId = id;
    saveAll();
    renderSections();
    renderLibSelects();
    fillStep1();
    applySetupAutoState();
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
    copy.texHash = '';
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
    if (config.models && Object.keys(config.models).length) {
      safeConfig.models = Object.assign({}, config.models);
    }
    if (config.customApi) safeConfig.customApi = config.customApi;
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
      if (data.config) {
        /* The backup holds no API keys. The keys and the urls of the
         * browser stay: an import must not send the key of the user to the
         * endpoint of another file. */
        const imported = normalizeConfig(data.config, LLM_VENDORS, defaultModel());
        if (imported.model) config.model = imported.model;
        if (imported.models) config.models = imported.models;
      }
      if (data.library && typeof data.library === 'object' && !Array.isArray(data.library)) {
        [['masters', 'master'], ['templates', 'template']].forEach(([listKey, kind]) => {
          const merged = mergeLibraryList(library[listKey], data.library[listKey], kind, libMax(kind));
          library[listKey] = merged.merged;
          if (merged.skipped) {
            toast('Library: ' + merged.skipped + ' item(s) skipped — limit of ' + libMax(kind) + ' or duplicate id.', 'warn', 6000);
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
        if (key === 'lang') { s.lang = el.value; saveAll(); return; }
        else {
          s[key] = el.value;
          if ((key === 'master' && s.masterId) || (key === 'template' && s.templateId)) {
            s[key === 'master' ? 'masterId' : 'templateId'] = null;
            renderLibSelects();
          }
          if (key === 'template') renderModelCards();
          if (key === 'master' || key === 'template') markSetupDone();
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
        let txt = nonEmpty(await fetchOptional(map[key]));
        if (!txt) {
          if (key === 'role') txt = embeddedRole();
          else if (key === 'master') txt = embeddedMaster(s.lang);
          else if (key === 'template') txt = embeddedTemplate('ats');
        }
        if (!txt) {
          toast('No default available for this field.', 'warn');
          return;
        }
        s[key] = txt;
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
    if (v === '') {
      return;
    } else if (v === '__manage__') {
      openSidebar('lib');
      renderLibSelects();
      return;
    } else if (v.indexOf('__model:') === 0) {
      applyBuiltinModel(v.slice('__model:'.length));
      return;
    } else {
      applyLibToSection(kind, v);
    }
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
  }

  // The selected card always matches section.template. A hand edit
  // matches no model, so no card stays selected (customized state).
  function currentModelKey() {
    const s = active();
    if (!s || !s.template || typeof DEFAULT_TEMPLATES === 'undefined') {
      return null;
    } else {
      const keys = Object.keys(DEFAULT_TEMPLATES);
      for (let i = 0; i < keys.length; i++) {
        if (s.template === DEFAULT_TEMPLATES[keys[i]]) return keys[i];
      }
      return null;
    }
  }

  // Second line with the user library templates. Visible while the
  // user has at least one template. A click copies it into the section.
  function renderUserModels() {
    const list = $('user-models');
    if (!list) return;
    const arr = libArr('template');
    list.innerHTML = '';
    list.hidden = arr.length === 0;
    if (!arr.length) return;
    const s = active();
    arr.forEach((e) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'user-tpl';
      if (s && s.templateId === e.id) b.classList.add('selected');
      b.textContent = e.name || 'Unnamed';
      b.title = 'Use "' + (e.name || 'Unnamed') + '" in this section';
      b.setAttribute('aria-pressed', String(s && s.templateId === e.id));
      b.addEventListener('click', () => applyLibToSection('template', e.id));
      list.appendChild(b);
    });
  }

  function renderModelCards() {
    const cur = currentModelKey();
    const s = active();
    const isModel = cur !== null && !(s && s.templateId);
    document.querySelectorAll('[data-model]').forEach((b) => {
      const on = b.dataset.model === cur;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-pressed', String(on));
    });
    // The editor only serves user library content. A pristine built-in
    // model shows no code.
    const det = document.querySelector('.tex-details');
    if (det) det.hidden = isModel;
    // Expanded editor hides every model button. Collapsed editor shows
    // them all back: the 4 model cards plus the user template row.
    const expanded = Boolean(det && !det.hidden && det.open);
    const grid = document.querySelector('.model-grid');
    if (grid) grid.hidden = expanded;
    const hint = document.querySelector('#model-hint');
    if (hint) hint.hidden = expanded;
    const list = document.querySelector('#user-models');
    if (list) list.hidden = expanded || !list.querySelector('.user-tpl');
  }

  function bindModelCards() {
    document.querySelectorAll('[data-model]').forEach((b) => {
      b.addEventListener('click', () => applyBuiltinModel(b.dataset.model));
    });
    const det = document.querySelector('.tex-details');
    if (det) det.addEventListener('toggle', () => renderModelCards());
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
      renderUserModels();
      renderModelCards();
      if (window.Chat) Chat.render();
      return;
    }
    $('step1-empty').style.display = 'none';
    STEP1_FIELDS.forEach((k) => { $(k).value = s[k]; });
    STEP2_FIELDS.forEach((k) => { $(k).value = s[k] || ''; });
    $('lang').value = s.lang;
    if (pdfSectionId !== activeId) hidePdf();
    renderLibSelects();
    renderUserModels();
    renderModelCards();
    renderSetupSummary();
    updateAllCounters();
    if (window.Chat) Chat.render();
  }

  /* ---------------------------------------------------------------- */

  // ---------- LLM ----------
  // Single in-flight LLM op: concurrent runs on the same section would
  // interleave tellChat calls and last-writer-wins the same fields.
  let opBusy = false;

  async function generate(fn, btnId, busyLabel) {
    const s = active();
    if (!s) return;
    if (opBusy) { toast('Still working — wait for the current task to finish.', 'warn'); return; }
    opBusy = true;
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
      opBusy = false;
      setBusy(btnId, false);
      progress(false);
    }
  }

  async function genCvOut(s) {
    if (!s.role.trim()) { toast('Paste the job description before generating the CV.', 'warn'); return; }
    if (!s.master.trim()) { toast('The master CV is empty — upload or paste a CV.', 'warn'); return; }
    setStatus('Generating CV_OUT.md (' + config.model + ')…', 'busy');
    s.cvOut = sanitizeFenced(await tellChat(buildAtsPrompt(s.master, s.lang, s.role), config));
    touch(s); saveAll();
    /* The user can change the section while the model works. The answer
     * belongs to the old section and must not land in the new one. */
    if (active() !== s) {
      toast('CV_OUT.md generated for "' + s.name + '" — switch to that section.', 'ok');
      return;
    }
    $('cvOut').value = s.cvOut;
    updateCounter('cvOut');
    setStatus('CV_OUT.md generated — review it in Step 2', 'ok');
    toast('CV_OUT.md ready in Step 2', 'ok');
    goTo(2);
  }

  async function genCover(s) {
    if (!(s.cvOut.trim() || s.master.trim())) { toast('Generate CV_OUT.md or have a master CV before the cover letter.', 'warn'); return; }
    setStatus('Generating cover.md (' + config.model + ')…', 'busy');
    s.cover = sanitizeFenced(await tellChat(buildCoverPrompt(s.cvOut || s.master, s.lang, s.role, s.pitch), config));
    touch(s); saveAll();
    if (active() !== s) {
      toast('cover.md generated for "' + s.name + '" — switch to that section.', 'ok');
      return;
    }
    $('cover').value = s.cover;
    updateCounter('cover');
    setStatus('cover.md generated — review it in Step 2', 'ok');
    toast('cover.md ready in Step 2', 'ok');
    goTo(2);
  }

  async function toTex(s) {
    if (!(s.cvOut.trim() || s.master.trim())) { toast('No markdown content to convert.', 'warn'); return; }
    if (!s.template.trim()) { toast('The LaTeX template is empty — load one from the library.', 'warn'); return; }
    // The tex is derived from these inputs: regenerating after a template
    // swap, an upload, or a hand edit would silently discard the current
    // tex, so ask first. First-time and same-inputs converts never nag.
    const curHash = texHashOf(s);
    if (s.tex.trim() && s.texHash !== curHash) {
      const ok = await modal.confirm({
        title: 'Overwrite CV.tex?',
        message: 'The current CV.tex does not match the current template/content — it may be hand-edited, uploaded, or generated from an older template. Regenerate it from scratch?',
        confirmText: 'Regenerate',
      });
      if (!ok) return;
    }
    setStatus('Converting markdown → LaTeX (' + config.model + ')…', 'busy');
    // Validate before assigning: a truncated/markdown reply must not
    // clobber a previous working tex (same rule fixTex follows).
    const fresh = sanitizeTex(await tellChat(buildTexPrompt(s.cvOut || s.master, s.template), config));
    const texProblem = getTexProblem(fresh);
    if (texProblem) {
      setStatus('LLM returned markdown, not LaTeX (' + texProblem + ') — previous .tex kept. Regenerate or paste a .tex starting with \\documentclass.', 'err');
      log('toTex warning: output looks like ' + texProblem + ', not LaTeX. Head: ' + fresh.trim().slice(0, 200));
      toast('The model returned markdown instead of LaTeX — previous .tex kept.', 'err', 6000);
      goTo(3);
      return;
    } else {
      s.tex = fresh;
      s.texHash = curHash;
      touch(s); saveAll();
      /* The user can change the section while the model works. */
      if (active() !== s) {
        toast('.tex generated for "' + s.name + '" — switch to that section.', 'ok');
        return;
      }
      $('tex').value = s.tex;
      updateCounter('tex');
      setStatus('.tex generated — compiling the PDF…', 'ok');
      toast('.tex generated in Step 3 — compiling the PDF', 'ok');
    }
    goTo(3);
    await compilePdf();
  }

  // Fingerprint of the inputs a .tex was generated from. toTex stamps
  // it on success and asks before overwriting a tex that no longer
  // matches — hand edits, uploads, or template swaps included. Pure.
  function texHashOf(s) {
    const src = String((s && (s.cvOut || s.master)) || '') + '\n%%template%%\n' + String((s && s.template) || '');
    let hash = 5381;
    for (let i = 0; i < src.length; i++) {
      hash = (((hash << 5) + hash) + src.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(16);
  }

  // Classifies a failed fix reply so status/toast can name the actual
  // cause instead of blaming truncation for every case. Pure: tested.
  function describeFixFailure(raw, texProblem) {
    if (!String(raw == null ? '' : raw).trim()) {
      return {
        status: 'The model returned an empty reply — previous .tex kept. Retry, or switch to a larger model.',
        toast: 'Empty model reply — previous .tex kept. Retry or switch model.',
      };
    } else if (texProblem === 'markdown' || texProblem === 'no-documentclass') {
      return {
        status: 'The model returned markdown, not LaTeX (' + texProblem + ') — previous .tex kept. Use "Convert to LaTeX" instead.',
        toast: 'Model returned markdown, not LaTeX — previous .tex kept.',
      };
    } else {
      return {
        status: 'Fix attempt incomplete (' + texProblem + ') — kept your previous .tex. Try again or a larger model.',
        toast: 'Fix reply was truncated (' + texProblem + ') — previous .tex kept. Retry or switch model.',
      };
    }
  }

  // Sends the current .tex plus the last compiler error to the LLM and
  // writes the fixed source back. Never clears tex on failure.
  async function fixTex(s) {
    if (!s.tex.trim()) { toast('Nothing to fix — CV.tex is empty.', 'warn'); return; }
    // No log yet (fresh section or post-success): fall back to the local
    // diagnosis so Fix stays useful right after a bad Convert to LaTeX.
    if (!lastCompileError.trim()) {
      const cur = getTexProblem(s.tex);
      if (cur) {
        lastCompileError = 'Pre-validation (' + cur + '). No compile attempted yet.';
      } else {
        toast('Nothing to fix — CV.tex looks valid. Compile to get an error log.', 'ok');
        return;
      }
    }
    setStatus('Fixing LaTeX from the error log (' + config.model + ')…', 'busy');
    const broken = s.tex;
    const errTail = lastCompileError.slice(-FIX_LOG_TAIL);
    // The broken tex already carries its own preamble when it has one;
    // sending the library template on top only bloats the prompt and
    // pushes small models into truncated replies. Send the template
    // only when the broken tex has no preamble to work from.
    const refTemplate = broken.indexOf('\\documentclass') === -1 ? s.template : '';
    let raw = '';
    let fixed = '';
    try {
      raw = await tellChat(buildFixTexPrompt(broken, errTail, refTemplate), config);
      fixed = sanitizeTex(raw);
    } catch (e) {
      setStatus('ERROR: ' + e.message, 'err');
      log('ERROR:', e.message);
      toast(e.code === 'NO_KEY' ? e.message + ' Open the menu (LLM).' : e.message, 'err', 6000);
      return;
    }
    const texProblem = getTexProblem(fixed);
    if (texProblem) {
      const msg = describeFixFailure(raw, texProblem);
      setStatus(msg.status, 'err');
      log('fixTex warning: raw ' + String(raw).length + ' chars, sanitized ' + fixed.length +
        ' chars, problem = ' + texProblem + '. Head: ' + String(raw).trim().slice(0, 200));
      toast(msg.toast, 'err', 6000);
      return;
    } else {
      s.tex = fixed;
      s.texHash = texHashOf(s);
      touch(s); saveAll();
      /* The user can change the section while the model works. */
      if (active() !== s) {
        toast('Fixed .tex saved in "' + s.name + '" — switch to that section.', 'ok');
        return;
      }
      $('tex').value = s.tex;
      updateCounter('tex');
      // Consumed: reusing the pre-fix log against the new tex would
      // send the model fixing an already-fixed file in circles.
      lastCompileError = '';
      setStatus('LaTeX fixed — compiling again…', 'ok');
      toast('Fixed .tex applied — compiling again', 'ok');
      await compilePdf();
    }
  }

  // ---------- Step 5 / Engine ----------
  function getEngine() {
    if (engine) return Promise.resolve(engine);
    if (!enginePromise) {
      /* The promise is built with an async function: a throw in the
       * constructor or in loadEngine must not stay cached, or every later
       * compile fails with the same error and no retry. */
      const promise = (async () => {
        setStatus('Loading LaTeX engine (first time ~1 min)…', 'busy');
        const e = new PdfTeXEngine();
        await e.loadEngine();
        engine = e;
        setStatus('Engine ready', 'ok');
        return e;
      })();
      enginePromise = promise;
      promise.catch(() => {
        if (enginePromise === promise) enginePromise = null;
      });
    }
    return enginePromise;
  }

  /* The engine has one slot. A second compile overwrites the message
   * handler of the worker, and the PDF of the first compile comes back. */
  let compileBusy = false;

  async function compilePdf() {
    const s = active();
    if (!s) return;
    if (compileBusy) {
      toast('A compile is still running — wait for it to finish.', 'warn');
      return;
    }
    if (!s.tex.trim()) {
      setStatus('Step 5: the .tex is empty — generate or paste a .tex.', 'warn');
      toast('Compile what? CV.tex is empty.', 'warn');
      return;
    }
    // Block markdown before it reaches PdfTeX, where it fails with the
    // cryptic "macro parameter character #" error on lines like "# ...".
    const texProblem = getTexProblem(s.tex);
    if (texProblem) {
      const firstLine = s.tex.trim().split('\n')[0].slice(0, 120);
      // The fix prompt already receives the tex as BROKEN .TEX — storing
      // another copy here only bloats it toward truncation.
      lastCompileError = 'Pre-validation refuse (' + texProblem + '). First line: ' + firstLine;
      setStatus('Step 5: CV.tex looks like ' + texProblem + ' — it must start with \\documentclass. Regenerate via "Convert to LaTeX" or use Fix with LLM.', 'err');
      log('Refusing to compile: CV.tex problem = ' + texProblem + '. First line: ' + firstLine);
      toast('CV.tex is not LaTeX (' + texProblem + ') — use Fix with LLM or regenerate.', 'err', 6000);
      return;
    } else {
      // Valid-looking LaTeX below — proceed to the engine.
    }
    setBusy('btn-compile', true);
    setStatus('Compiling PDF (first time ~20 min)…', 'busy');
    log('--- compile start (' + now() + ') ---');
    progress(true);
    compileBusy = true;
    /* The section of this compile. The user can change it while the
     * engine works. */
    const sectionId = activeId;
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
        lastCompileError = '';
        /* The PDF belongs to the section of the compile. Another section is
         * active now: the PDF of the other section must not stay on the
         * screen. */
        if (activeId !== sectionId) {
          hidePdf();
          toast('PDF compiled for another section — switch to it to see the PDF.', 'ok');
          return;
        }
        showPdf(res.pdf, sectionId);
        setStatus('PDF generated (' + res.pdf.length + ' bytes)', 'ok');
        toast('PDF compiled successfully', 'ok');
      } else {
        // Cap at store time: transcripts can be megabytes and this value
        // lives for the session; fixTex slices again defensively at send.
        lastCompileError = String(res.log || ('status ' + res.status)).slice(-FIX_LOG_TAIL);
        const cause = extractLatexError(res.log);
        if (cause) {
          setStatus('COMPILE ERROR: ' + cause + ' — or use Fix with LLM', 'err');
          toast('Compile failed: ' + cause, 'err', 8000);
        } else {
          setStatus('COMPILE ERROR (status ' + res.status + ') — see log, or use Fix with LLM', 'err');
          toast('Compile failed — see the log, or use Fix with LLM', 'err');
        }
        log(res.log || '');
      }
    } catch (e) {
      clearInterval(timer);
      lastCompileError = String((e && e.message) || e);
      setStatus('COMPILE ERROR: ' + e.message, 'err');
      log('ERROR:', e.message);
      toast('COMPILE ERROR: ' + e.message, 'err');
    } finally {
      clearInterval(timer);
      compileBusy = false;
      setBusy('btn-compile', false);
      progress(false);
    }
  }

  function showPdf(uint8, sectionId) {
    const viewer = $('viewer');
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    pdfUrl = URL.createObjectURL(new Blob([uint8], { type: 'application/pdf' }));
    /* The PDF belongs to the section of the compile, not to the section
     * that happens to be active now. */
    pdfSectionId = sectionId === undefined ? activeId : sectionId;
    viewer.src = pdfUrl;
    viewer.style.display = 'block';
  }

  // The tex editor collapses to a button row. Expanded shows tex plus PDF
  // plus chat as before. Collapsed shows PDF plus chat in 2 columns.
  function setTexCollapsed(collapsed) {
    const card = $('tex-card');
    const grid = $('step3-grid');
    const btn = $('btn-tex-toggle');
    if (!card || !grid || !btn) return;
    card.style.display = collapsed ? 'none' : '';
    grid.classList.toggle('grid-2', collapsed);
    grid.classList.toggle('grid-3', !collapsed);
    btn.setAttribute('aria-expanded', String(!collapsed));
  }

  function isTexCollapsed() {
    const card = $('tex-card');
    return Boolean(card && card.style.display === 'none');
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

  // ---------- Setup block (config + CV base) ----------
  // The block stays on top of every step. It collapses to a summary bar
  // so the work area keeps the space. The state is session-only.
  function isSetupCollapsed() {
    const block = $('setup-block');
    return Boolean(block && block.classList.contains('collapsed'));
  }

  function setSetupCollapsed(collapsed) {
    const block = $('setup-block');
    const btn = $('btn-setup-toggle');
    if (!block || !btn) return;
    block.classList.toggle('collapsed', collapsed);
    btn.setAttribute('aria-expanded', String(!collapsed));
    renderSetupSummary();
  }

  // Ready means: the user saved the setup values, and the section has a
  // master CV and a template. The seeded defaults do not count as saved.
  function setupIsReady() {
    const s = active();
    if (!s) return false;
    if (config.setupDone !== true) return false;
    return Boolean(s.master && s.master.trim()) && Boolean(s.template && s.template.trim());
  }

  // Marks the setup as saved. The user touched a setup field.
  function markSetupDone() {
    if (config.setupDone === true) return;
    config.setupDone = true;
    saveAllDebounced();
  }

  // Applied on load and on every section change. A manual toggle wins
  // until the next load or switch.
  function applySetupAutoState() {
    setSetupCollapsed(setupIsReady());
  }

  function renderSetupSummary() {
    const sum = $('setup-summary');
    const chips = $('setup-chips');
    if (!sum || !chips) return;
    const parsed = vendorOfModel(config.model);
    const model = parsed ? parsed.rest : config.model;
    sum.textContent = 'Configuração: ' + (model || 'sem modelo');
    chips.innerHTML = '';
    const s = active();
    const masterName = s && s.master ? s.master.split('\n')[0].replace(/^#\s*/, '') : '';
    const modelKey = currentModelKey();
    const labels = [];
    if (parsed) labels.push(parsed.vendor);
    if (masterName) labels.push(masterName.slice(0, 28));
    if (modelKey) labels.push(modelKey);
    labels.forEach((t) => {
      const c = document.createElement('span');
      c.className = 'setup-chip';
      c.textContent = t;
      chips.appendChild(c);
    });
  }

  // ---------- LLM config (setup block) ----------
  // One vendor selected at a time (session only). The detail block shows
  // that vendor's stored values. The model input holds the part after
  // "vendor:" — saving writes the full "vendor:name" spec back.
  let selectedVendor = null;

  const VENDOR_META = [
    { id: 'openai', name: 'OpenAI', desc: 'api.openai.com' },
    { id: 'anthropic', name: 'Anthropic', desc: 'api.anthropic.com' },
    { id: 'google', name: 'Google', desc: 'generativelanguage.googleapis.com' },
    { id: 'deepseek', name: 'DeepSeek', desc: 'api.deepseek.com' },
    { id: 'xai', name: 'xAI', desc: 'api.x.ai' },
    { id: 'cerebras', name: 'Cerebras', desc: 'api.cerebras.ai' },
    { id: 'fireworks', name: 'Fireworks', desc: 'api.fireworks.ai' },
    { id: 'moonshotai', name: 'Moonshot AI', desc: 'api.moonshot.ai' },
    { id: 'openrouter', name: 'OpenRouter', desc: 'openrouter.ai' },
    { id: 'alibaba', name: 'Alibaba', desc: 'dashscope-intl.aliyuncs.com' },
    { id: 'zai', name: 'Z.ai', desc: 'api.z.ai' },
    { id: 'custom', name: 'Custom', desc: 'Sua URL (formato OpenAI)' },
  ];

  function vendorOfModel(model) {
    const m = /^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/.exec(model || '');
    if (!m || LLM_VENDORS.indexOf(m[1].toLowerCase()) === -1) return null;
    return { vendor: m[1].toLowerCase(), rest: m[2] };
  }

  /* The alias table of the sdk. The app never keeps its own list: the sdk
   * owns the aliases and the spec of every alias. */
  let aliasTableCache = null;
  function aliasTable() {
    if (aliasTableCache) return aliasTableCache;
    aliasTableCache = [];
    const sdk = typeof window !== 'undefined' ? window.TellSDK : null;
    if (!sdk || !sdk.MODELS || typeof sdk.resolve_model_spec !== 'function') return aliasTableCache;
    Object.keys(sdk.MODELS).forEach((alias) => {
      let spec = null;
      try {
        spec = sdk.resolve_model_spec(alias);
      } catch (_) {
        return;
      }
      aliasTableCache.push({ alias: alias, vendor: spec.vendor, model: spec.model, thinking: spec.thinking });
    });
    return aliasTableCache;
  }

  /* The list of the model field holds the aliases of the chosen provider. */
  function renderModelList() {
    const list = $('cfg-model-list');
    if (!list) return;
    list.innerHTML = '';
    const vendor = selectedVendor;
    aliasTable().forEach((entry) => {
      if (vendor && entry.vendor !== vendor) return;
      const option = document.createElement('option');
      option.value = entry.alias;
      option.label = entry.model + ' · ' + entry.thinking;
      list.appendChild(option);
    });
  }

  /* The spec of the chosen model. The sdk resolves the alias and the full
   * spec, and it names the model that it does not know. */
  function renderModelSpec() {
    const el = $('cfg-model-spec');
    if (!el) return;
    const model = (config.model || '').trim();
    const sdk = typeof window !== 'undefined' ? window.TellSDK : null;
    if (!model || !sdk || typeof sdk.resolve_model_spec !== 'function') {
      el.textContent = '';
      el.classList.remove('bad');
      return;
    }
    try {
      const spec = sdk.resolve_model_spec(model);
      el.textContent = spec.vendor + ' · ' + spec.model + ' · ' + spec.thinking;
      el.classList.remove('bad');
    } catch (err) {
      el.textContent = err && err.message ? err.message : 'Unknown model';
      el.classList.add('bad');
    }
  }

  function renderVendorCards() {
    const grid = $('vendor-grid');
    if (!grid) return;
    grid.innerHTML = '';
    VENDOR_META.forEach((meta) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'model-card';
      b.dataset.vendor = meta.id;
      const on = selectedVendor === meta.id;
      if (on) b.classList.add('selected');
      b.setAttribute('aria-pressed', String(on));
      const badge = document.createElement('span');
      badge.className = 'model-badge';
      badge.textContent = meta.id.toUpperCase();
      const title = document.createElement('span');
      title.className = 'model-title';
      title.textContent = meta.name;
      const desc = document.createElement('span');
      desc.className = 'model-desc';
      desc.textContent = meta.desc;
      b.append(badge, title, desc);
      b.addEventListener('click', () => {
        selectedVendor = meta.id;
        markSetupDone();
        renderVendorCards();
        renderVendorDetail();
      });
      grid.appendChild(b);
    });
  }

  function renderVendorDetail() {
    const form = $('cfg-panel');
    const hint = $('vendor-pick-hint');
    const title = $('vendor-title');
    const v = selectedVendor;
    if (!v) {
      if (form) form.hidden = true;
      if (hint) hint.hidden = false;
      if (title) title.textContent = 'Detalhes';
      return;
    }
    const meta = VENDOR_META.find((m) => m.id === v);
    if (title) title.textContent = (meta ? meta.name : v) + ' — Detalhes';
    if (hint) hint.hidden = true;
    if (form) form.hidden = false;
    const parsed = vendorOfModel(config.model);
    /* The active model of the provider wins. Otherwise the model that the
     * user chose for this provider before comes back. */
    const remembered = config.models && config.models[v] ? config.models[v] : '';
    $('cfg-model').value = parsed && parsed.vendor === v ? parsed.rest : remembered;
    $('cfg-key').value = (config.keys && config.keys[v]) || '';
    $('cfg-key').type = 'password';
    const eye = $('btn-key-eye');
    if (eye) eye.setAttribute('aria-label', 'Show key');
    const extra = $('cfg-custom-extra');
    if (extra) extra.hidden = v !== 'custom';
    if (v === 'custom') {
      $('cfg-url').value = (config.urls && config.urls.custom) || '';
      $('cfg-api').value = config.customApi || 'auto';
      $('cfg-headers').value = config.customHeaders || '';
    }
    renderModelList();
    renderModelSpec();
  }

  function fillConfig() {
    const parsed = vendorOfModel(config.model);
    selectedVendor = parsed ? parsed.vendor : null;
    renderVendorCards();
    renderVendorDetail();
    renderSetupSummary();
  }

  function bindConfig() {
    renderVendorCards();
    /* The server can hold the key. The hint says so, so the user does not
     * paste a key that the server already has. */
    serverConfig().then((info) => {
      const el = $('cfg-server-hint');
      if (!el) return;
      if (!info || !info.vendors || !info.vendors.length) {
        el.hidden = true;
        return;
      }
      el.hidden = false;
      el.textContent = 'The server holds the key: ' + info.vendors.join(', ')
        + '. The call goes through the server.';
    });
    const modelEl = $('cfg-model');
    if (modelEl) modelEl.addEventListener('input', () => {
      const name = modelEl.value.trim();
      if (!name) return;
      const parsed = vendorOfModel(name);
      if (parsed) {
        /* A full spec: the user typed the vendor too, so the app keeps it. */
        config.model = name;
        if (!config.models) config.models = {};
        config.models[parsed.vendor] = parsed.rest;
      } else if (selectedVendor) {
        config.model = selectedVendor + ':' + name;
        if (!config.models) config.models = {};
        config.models[selectedVendor] = name;
      } else {
        return;
      }
      markSetupDone();
      saveAllDebounced();
      renderModelSpec();
    });
    const keyEl = $('cfg-key');
    if (keyEl) keyEl.addEventListener('input', () => {
      if (!selectedVendor) return;
      config.keys[selectedVendor] = keyEl.value.trim();
      markSetupDone();
      saveAllDebounced();
    });
    const eye = $('btn-key-eye');
    if (eye) eye.addEventListener('click', () => {
      const input = $('cfg-key');
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      eye.setAttribute('aria-label', show ? 'Hide key' : 'Show key');
      eye.setAttribute('title', show ? 'Hide key' : 'Show key');
    });
    const urlEl = $('cfg-url');
    if (urlEl) urlEl.addEventListener('input', () => {
      config.urls.custom = urlEl.value.trim();
      markSetupDone();
      saveAllDebounced();
    });
    const apiEl = $('cfg-api');
    if (apiEl) apiEl.addEventListener('change', () => {
      config.customApi = apiEl.value;
      saveAllDebounced();
    });
    const modelsEl = $('cfg-models');
    if (modelsEl) modelsEl.addEventListener('change', () => {
      const id = modelsEl.value;
      if (!id) return;
      const input = $('cfg-model');
      input.value = id;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const modelsBtn = $('btn-cfg-models');
    if (modelsBtn) modelsBtn.addEventListener('click', async () => {
      modelsBtn.disabled = true;
      try {
        const list = await customModels(config);
        const select = $('cfg-models');
        select.innerHTML = '';
        const head = document.createElement('option');
        head.value = '';
        head.textContent = list.length ? list.length + ' models' : 'no models';
        select.appendChild(head);
        list.forEach((item) => {
          const option = document.createElement('option');
          option.value = item.id;
          option.textContent = item.id + ' (' + item.wire + ')';
          select.appendChild(option);
        });
        toast(list.length + ' models loaded', 'ok');
      } catch (err) {
        toast('Model list failed: ' + (err && err.message ? err.message : err), 'err', 6000);
      } finally {
        modelsBtn.disabled = false;
      }
    });
    const headersEl = $('cfg-headers');
    if (headersEl) headersEl.addEventListener('input', () => {
      config.customHeaders = headersEl.value;
      saveAllDebounced();
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
    $('btn-cfg').addEventListener('click', () => {
      setSetupCollapsed(false);
      document.querySelector('#setup-block').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('btn-goto-config').addEventListener('click', () => {
      closeSidebar();
      setSetupCollapsed(false);
      document.querySelector('#setup-block').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('btn-setup-toggle').addEventListener('click', () => setSetupCollapsed(!isSetupCollapsed()));
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

    renderSections();
    fillStep1();
    fillConfig();
    applySetupAutoState();
    renderLibrary();
    bindFields();
    bindModelCards();
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
    $('btn-fix-tex').addEventListener('click', () => generate(fixTex, 'btn-fix-tex', 'Fixing LaTeX'));
    $('btn-compile').addEventListener('click', compilePdf);
    $('btn-tex-toggle').addEventListener('click', () => setTexCollapsed(!isTexCollapsed()));

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
      openLlmConfig: () => {
        setSetupCollapsed(false);
        const block = document.querySelector('#setup-block');
        if (block) block.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    });

    goTo(1);
    if (!active()) $('step1-empty').style.display = 'block';
    setStatus('Ready', 'ok');
    saveAll();
    /* The seed runs after the wiring. A slow data file must not stop the
     * app from working, and the user must be able to type at once. */
    await seedDefaults();
  }

  /* Loads the default content of a fresh profile. A failure here leaves the
   * app empty but usable. */
  async function seedDefaults() {
    try {
      if (!Object.keys(sections).length) {
        await createInitial();
      }
      await ensureLibrarySeed();
      renderSections();
      fillStep1();
      renderLibrary();
      setStatus('Ready', 'ok');
    } catch (e) {
      console.warn('the seed failed', e);
    }
  }

  function addLibraryEntry(kind) {
    const arr = libArr(kind);
    if (arr.length >= libMax(kind)) {
      toast('Library limit of ' + libMax(kind) + ' items.', 'warn');
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
    const [role, master, template, pitch] = await Promise.all([
      fetchOptional(DEFAULT_FILES.role),
      fetchOptional(DEFAULT_FILES.masterEn),
      fetchOptional(DEFAULT_FILES.template),
      fetchOptional(DEFAULT_FILES.pitch),
    ]);
    /* The user can type while the default files load. The typed text wins
     * over the default file. */
    const typed = {};
    STEP1_FIELDS.forEach((k) => { typed[k] = $(k) ? $(k).value : ''; });
    s.role = (typed.role || '').trim() || nonEmpty(role) || embeddedRole();
    s.master = (typed.master || '').trim() || nonEmpty(master) || embeddedMaster(s.lang);
    s.template = (typed.template || '').trim() || nonEmpty(template) || embeddedTemplate('ats');
    s.pitch = (typed.pitch || '').trim() || nonEmpty(pitch);
    const id = 's' + Date.now().toString(36);
    sections[id] = s;
    activeId = id;
    saveAll();
    fillStep1();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
