#!/usr/bin/env node
'use strict';

/*
 * Browser regression tests for src/js/app.js and src/js/chat.js.
 *
 * Every test here reproduces a confirmed failure: corrupted or hostile
 * persisted state, a failed engine load, a failed LLM call, a full
 * localStorage, and the last-section deletion path.
 *
 * Usage: node test/app_audit.js   (needs chromium via playwright)
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const SERVE = path.resolve(__dirname, '..', 'src', 'scripts', 'serve.js');
const PORT = Number(process.env.AUDIT_PORT || 8081);
const BASE = 'http://127.0.0.1:' + PORT;

let passed = 0;
let failed = 0;
let page_errors = [];

function test(name, fn) {
  tests.push({ name, fn });
}

const tests = [];

function report_ok(name) {
  passed++;
  console.log('  ok   ' + name);
}

function report_fail(name, err) {
  failed++;
  console.log('  FAIL ' + name);
  console.log('       ' + (err && err.message ? err.message.split('\n').join('\n       ') : err));
}

function section(overrides) {
  return Object.assign({
    name: 'Vaga A',
    role: 'ROLE',
    master: 'MASTER',
    template: 'TEMPLATE',
    pitch: '',
    lang: 'en',
    masterId: null,
    templateId: null,
    genCover: false,
    cvOut: '',
    cover: '',
    tex: '',
    chat: [],
    updatedAt: Date.now(),
  }, overrides || {});
}

/* Seeds localStorage, reloads, and returns the page state plus any pageerror. */
async function seed(page, state) {
  page_errors = [];
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  await page.evaluate((s) => {
    localStorage.clear();
    Object.keys(s).forEach((k) => localStorage.setItem(k, typeof s[k] === 'string' ? s[k] : JSON.stringify(s[k])));
  }, state);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
}

function take_errors() {
  return page_errors.slice();
}

/* The dev server can hold a key in its env. The tests that need the
 * no-key path tell the browser that the server holds nothing. */
async function noServerKey(page) {
  await page.route('**/api/llm/config', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ enabled: false, model: 'l', vendors: [] }),
  }));
}

/* ================================================================== *
 * loadAll(): a single corrupt key must not wipe the others
 * ================================================================== */

test('load: a corrupt riki.sections keeps the config keys and does not persist a wipe', async (page) => {
  const other = section({ name: 'OUTRA' });
  await seed(page, {
    'riki.config': { model: 'j', keys: { google: 'SECRET-KEY-123' }, urls: {} },
    'riki.sections': { s1: section({ name: 'A' }), s2: other },
    'riki.active': 's2',
    'riki.library': { masters: [{ id: 'm1', name: 'M1', lang: 'en', content: 'x' }], templates: [] },
  });
  await page.evaluate(() => localStorage.setItem('riki.sections', '{NAO-E-JSON'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  const key_kept = await page.evaluate(() => (JSON.parse(localStorage.getItem('riki.config')).keys || {}).google);
  assert.strictEqual(key_kept, 'SECRET-KEY-123', 'API key was lost');

  const lib_kept = await page.evaluate(() => JSON.parse(localStorage.getItem('riki.library')).masters.length);
  assert.strictEqual(lib_kept, 1, 'library was wiped by the unrelated failure');

  const backed_up = await page.evaluate(() => localStorage.getItem('riki.sections.backup'));
  assert.strictEqual(backed_up, '{NAO-E-JSON', 'corrupt value was not preserved for recovery');

  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('riki.sections')));
  assert.strictEqual(Object.keys(persisted).length, 1, 'expected exactly the auto-created recovery section');
  const recovered = Object.keys(persisted).map((k) => persisted[k])[0];
  assert.strictEqual(recovered.name, 'Default', 'the app did not recover with a working section');
  assert.ok(Array.isArray(recovered.chat), 'the recovery section is not normalized');
  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');
});

test('load: sections survive a corrupt library key', async (page) => {
  await seed(page, {
    'riki.sections': { s1: section({ name: 'A' }), s2: section({ name: 'B' }) },
    'riki.active': 's1',
  });
  await page.evaluate(() => localStorage.setItem('riki.library', 'lixo'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  const names = await page.$$eval('#section-select option', (o) => o.map((x) => x.textContent));
  assert.strictEqual(names.length, 2, 'sections were lost: ' + JSON.stringify(names));
  const backed_up = await page.evaluate(() => localStorage.getItem('riki.library.backup'));
  assert.strictEqual(backed_up, 'lixo', 'corrupt library was not preserved');
  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');
});

/* ================================================================== *
 * hostile / malformed shapes must not brick the app
 * ================================================================== */

test('load: a section with a non-array chat does not break the app', async (page) => {
  await noServerKey(page);
  await seed(page, {
    'riki.sections': { bad: section({ name: 'X', chat: 'not-an-array', role: 5, updatedAt: 'nope' }) },
    'riki.active': 'bad',
  });

  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');
  assert.strictEqual(await page.inputValue('#role'), '', 'a numeric role reached the form');

  await page.click('[data-nav="3"]');
  await page.waitForTimeout(400);
  assert.strictEqual(await page.$eval('#panel3', (p) => p.style.display), 'flex', 'step 3 did not open');
  assert.ok((await page.textContent('#section-select')).indexOf('Invalid Date') === -1, 'option shows Invalid Date');

  await page.fill('#chat-input', 'oi');
  await page.click('#chat-send');
  await page.waitForSelector('.msg.error', { timeout: 20000 });
  assert.ok((await page.$$('.msg.user')).length === 1, 'chat input broken after malformed load');
  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors after chat send');
});

test('load: a library entry with a non-string lang and a hostile id keeps the app alive', async (page) => {
  await seed(page, {
    'riki.sections': { s1: section() },
    'riki.active': 's1',
    'riki.library': { masters: [{ id: 'a"]', name: 'x', lang: 123, content: '' }], templates: [] },
  });

  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');

  await page.click('#btn-menu');
  await page.waitForSelector('#lib-masters .lib-entry', { timeout: 5000 });
  await page.click('#btn-add-master');
  await page.waitForTimeout(300);
  const count = await page.$$eval('#lib-masters .lib-entry', (e) => e.length);
  assert.ok(count >= 1, 'library add button did not work');
  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors after library add');
});

/* ================================================================== *
 * Step 3: CV.tex / cover.tex tabs
 * ================================================================== */

test('step 3: both .tex files show tabs and the editor follows the tab', async (page) => {
  await seed(page, {
    'riki.sections': { s1: section({ tex: 'CV-TEX', coverTex: 'COVER-TEX' }) },
    'riki.active': 's1',
  });
  await page.click('[data-nav="3"]');
  await page.waitForTimeout(400);

  assert.strictEqual(await page.$$eval('.tex-tab', (b) => b.length), 2, 'expected two tabs');
  assert.strictEqual(await page.$eval('#tex-tabs', (e) => e.hidden), false, 'tabs are hidden');
  assert.strictEqual(await page.$eval('#tex-title', (e) => e.hidden), true, 'title still shown with tabs');
  assert.strictEqual(await page.inputValue('#tex'), 'CV-TEX', 'CV.tex is not shown first');
  assert.deepStrictEqual(
    await page.$$eval('.tex-tab', (b) => b.map((x) => x.dataset.texTab + ':' + x.classList.contains('active'))),
    ['tex:true', 'coverTex:false'],
    'the CV tab is not the only active tab'
  );

  await page.click('[data-tex-tab="coverTex"]');
  await page.waitForTimeout(200);
  assert.strictEqual(await page.inputValue('#tex'), 'COVER-TEX', 'cover.tex is not shown');
  assert.deepStrictEqual(
    await page.$$eval('.tex-tab', (b) => b.map((x) => x.classList.contains('active'))),
    [false, true],
    'only one tab must be active'
  );
  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');
});

test('step 3: an edit goes to the shown file', async (page) => {
  await seed(page, {
    'riki.sections': { s1: section({ tex: 'CV-TEX', coverTex: 'COVER-TEX' }) },
    'riki.active': 's1',
  });
  await page.click('[data-nav="3"]');
  await page.click('[data-tex-tab="coverTex"]');
  await page.fill('#tex', 'COVER-EDIT');
  await page.waitForTimeout(600);

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('riki.sections')).s1);
  assert.strictEqual(saved.coverTex, 'COVER-EDIT', 'the cover edit did not reach coverTex');
  assert.strictEqual(saved.tex, 'CV-TEX', 'the cover edit overwrote CV.tex');

  /* Clearing the visible file must not move the next keystroke into the
   * other file (the fallback would pick CV because cover is empty). */
  await page.fill('#tex', '');
  await page.type('#tex', 'X');
  await page.waitForTimeout(600);
  const afterClear = await page.evaluate(() => JSON.parse(localStorage.getItem('riki.sections')).s1);
  assert.strictEqual(afterClear.coverTex, 'X', 'a keystroke after clearing went to the wrong file');
  assert.strictEqual(afterClear.tex, 'CV-TEX', 'CV.tex was overwritten after the cover was cleared');
});

test('step 3: one .tex file keeps the plain card', async (page) => {
  await seed(page, {
    'riki.sections': { s1: section({ coverTex: 'COVER-TEX' }) },
    'riki.active': 's1',
  });
  await page.click('[data-nav="3"]');
  await page.waitForTimeout(400);

  assert.strictEqual(await page.$eval('#tex-tabs', (e) => e.hidden), true, 'tabs are shown for one file');
  assert.strictEqual(await page.$eval('#tex-title', (e) => e.hidden), false, 'title is hidden without tabs');
  assert.strictEqual((await page.textContent('#tex-title')).trim(), 'cover.tex', 'wrong title');
  assert.strictEqual(await page.inputValue('#tex'), 'COVER-TEX', 'cover.tex is not in the editor');
});

test('step 2: two convert buttons replace the single one', async (page) => {
  await seed(page, { 'riki.sections': { s1: section() }, 'riki.active': 's1' });
  await page.click('[data-nav="2"]');
  await page.waitForTimeout(200);

  assert.ok(await page.$('#btn-cv-to-tex'), 'the CV to LaTeX button is missing');
  assert.ok(await page.$('#btn-cover-to-tex'), 'the Cover to LaTeX button is missing');
  assert.strictEqual(await page.$('#btn-to-tex'), null, 'the old convert button is still there');
});

test('step 2: Cover to LaTeX writes cover.tex and keeps CV.tex', async (page) => {
  await seed(page, {
    'riki.config': { model: 'g', keys: { openai: 'sk-test' }, urls: {} },
    'riki.sections': { s1: section({ cover: '# Cover letter\n\nHello.', tex: 'CV-OLD' }) },
    'riki.active': 's1',
  });
  /* The model answers with a document and the engine accepts it. This is
   * the whole button path: markdown → LLM → cover.tex → compile. */
  await page.evaluate(() => {
    window.PdfTeXEngine = function () {
      return {
        loadEngine: () => Promise.resolve(),
        writeMemFSFile: () => {},
        setEngineMainFile: () => {},
        flushCache: () => {},
        compileLaTeX: () => Promise.resolve({ status: 0, log: '', pdf: new Uint8Array([37, 80, 68, 70]) }),
      };
    };
    window.TellSDK = {
      create_ask_ai: async () => ({
        ask: async () => '\\documentclass{article}\n\\begin{document}\nCOVER TEX\n\\end{document}',
      }),
    };
  });
  await page.click('[data-nav="2"]');
  await page.waitForTimeout(200);
  await page.click('#btn-cover-to-tex');
  await page.waitForFunction(
    () => document.getElementById('status').textContent.indexOf('PDF generated') !== -1,
    null,
    { timeout: 30000 }
  );

  const out = await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('riki.sections')).s1;
    return {
      tex: saved.tex,
      coverTex: saved.coverTex,
      value: document.getElementById('tex').value,
      tab: document.querySelector('.tex-tab.active') ? document.querySelector('.tex-tab.active').dataset.texTab : '',
    };
  });
  assert.ok(out.coverTex.indexOf('COVER TEX') !== -1, 'cover.tex was not written: ' + out.coverTex);
  assert.strictEqual(out.tex, 'CV-OLD', 'the cover conversion overwrote CV.tex');
  assert.ok(out.value.indexOf('COVER TEX') !== -1, 'the editor does not show cover.tex');
  assert.strictEqual(out.tab, 'coverTex', 'the cover tab is not active');
  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');
});

/* ================================================================== *
 * getEngine(): a rejected load must not poison every later compile
 * ================================================================== */

test('engine: a failed loadEngine is retried on the next compile', async (page) => {
  await seed(page, {
    'riki.sections': { s1: section({ tex: '\\documentclass{article}\\begin{document}x\\end{document}' }) },
    'riki.active': 's1',
  });
  await page.evaluate(() => {
    window.__engine_calls = 0;
    const Real = window.PdfTeXEngine;
    window.PdfTeXEngine = function () {
      const inst = new Real();
      const original = inst.loadEngine.bind(inst);
      inst.loadEngine = function () {
        window.__engine_calls++;
        if (window.__engine_calls === 1) return Promise.reject(new Error('simulated network failure'));
        return original();
      };
      return inst;
    };
  });

  await page.click('[data-nav="3"]');
  await page.click('#btn-compile');
  await page.waitForFunction(
    () => document.getElementById('status').textContent.includes('ERROR'),
    null,
    { timeout: 60000 }
  );
  assert.ok((await page.textContent('#status')).includes('simulated network failure'), 'first failure not surfaced');

  await page.click('#btn-compile');
  await page.waitForFunction(
    () => window.__engine_calls >= 2,
    null,
    { timeout: 60000 }
  );
  const calls = await page.evaluate(() => window.__engine_calls);
  assert.ok(calls >= 2, 'loadEngine was called ' + calls + ' time(s); the cached rejection was never retried');
});

/* ================================================================== *
 * fillStep1(): no active section must clear the stale form and the PDF
 * ================================================================== */

test('sections: deleting the last section clears the form and hides the PDF', async (page) => {
  await seed(page, {
    'riki.sections': { s1: section({ role: 'ROLE-SECRETA', cvOut: 'CVOUT-SECRETO' }) },
    'riki.active': 's1',
  });

  await page.click('[data-nav="3"]');
  await page.click('#btn-del-section');
  await page.waitForSelector('.modal-foot button.danger', { timeout: 5000 });
  await page.click('.modal-foot button.danger');
  await page.waitForTimeout(500);

  assert.strictEqual(await page.$$eval('#section-select option', (e) => e.length), 0, 'section was not deleted');
  assert.strictEqual(await page.$eval('#step1-empty', (e) => e.style.display), 'block', 'empty banner not shown');
  assert.strictEqual(await page.inputValue('#role'), '', 'stale role still in the form');
  assert.strictEqual(await page.inputValue('#cvOut'), '', 'stale CV_OUT still in the form');
  assert.strictEqual(await page.$eval('#viewer', (v) => v.style.display), 'none', 'stale PDF still displayed');
});

/* ================================================================== *
 * chat.send(): the user turn must be persisted even when the call fails
 * ================================================================== */

test('chat: the user message is persisted when the LLM call fails', async (page) => {
  await noServerKey(page);
  await seed(page, {
    'riki.sections': { s1: section() },
    'riki.active': 's1',
  });

  await page.click('[data-nav="3"]');
  await page.fill('#chat-input', 'pergunta importante');
  await page.click('#chat-send');
  await page.waitForSelector('.msg.error', { timeout: 20000 });
  await page.waitForTimeout(400);

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('riki.sections')).s1.chat);
  assert.ok(stored.length >= 1, 'user message was not persisted');
  assert.strictEqual(stored[0].content, 'pergunta importante', 'wrong message persisted');
});

/* ================================================================== *
 * saveAll(): a full localStorage must not throw
 * ================================================================== */

test('save: a full localStorage does not raise uncaught errors', async (page) => {
  await seed(page, {
    'riki.sections': { s1: section() },
    'riki.active': 's1',
  });

  await page.evaluate(() => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (String(k).indexOf('riki.') === 0) {
        const err = new Error('cota estourada');
        err.name = 'QuotaExceededError';
        throw err;
      }
      return real.call(this, k, v);
    };
  });

  await page.click('[data-nav="1"]');
  await page.fill('#role', 'digitando com a cota cheia');
  await page.waitForTimeout(900);
  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors from the debounced save');

  const notified = await page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' '));
  assert.ok(notified.length > 0, 'user was not warned that persistence failed');
});

/* ================================================================== *
 * buildModal(): confirmText must label the button
 * ================================================================== */

test('modal: confirmText labels the confirmation button', async (page) => {
  await seed(page, {
    'riki.sections': { s1: section() },
    'riki.active': 's1',
  });

  await page.click('#btn-del-section');
  await page.waitForSelector('.modal-foot button', { timeout: 5000 });
  const labels = await page.$$eval('.modal-foot button', (b) => b.map((x) => x.textContent));
  assert.ok(labels.indexOf('Delete') !== -1, 'expected a "Delete" button, got ' + JSON.stringify(labels));
  await page.click('.modal-foot button:not(.danger)');
});

/* ================================================================== *
 * load path also sees backup-shaped payloads (importSections is
 * unreachable from the UI — no data-upload="json" control — so the
 * normalizers are covered here and in test/store_test.js)
 * ================================================================== */

test('load: a backup-shaped payload with injected config is normalized', async (page) => {
  await seed(page, {
    'riki.sections': { s1: section() },
    'riki.active': 's1',
    'riki.config': { model: 'g', keys: { evil: 'sk-injetada' }, urls: { openai: 'https://evil.example/v1' }, rogue: 1 },
    'riki.library': { masters: [{ id: 'b"]', name: 'M', lang: 7, content: 'c' }], templates: 'nope' },
  });

  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');

  const config = await page.evaluate(() => JSON.parse(localStorage.getItem('riki.config')));
  assert.strictEqual(config.keys.evil, undefined, 'an unknown vendor key was persisted');
  assert.strictEqual(config.rogue, undefined, 'a stray config field was persisted');
  assert.deepStrictEqual(Object.keys(config).sort(), ['keys', 'model', 'urls']);
  assert.strictEqual(config.urls.openai, 'https://evil.example/v1', 'the user-set url was dropped');

  await page.click('#btn-menu');
  await page.waitForSelector('#lib-masters .lib-entry', { timeout: 5000 });
  const badge = await page.textContent('#lib-master-count');
  assert.ok(/^[0-2]\/2$/.test(badge.trim()), 'library badge out of range: ' + badge);

  await page.click('#btn-sidebar-close');
  await page.click('[data-nav="3"]');
  await page.waitForTimeout(400);
  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors after opening step 3');
});

/* ================================================================== *
 * storage unavailable: throwing get/set must not kill the app
 * ================================================================== */

test('load: a throwing localStorage does not brick the app', async (page) => {
  const browser = page.context().browser();
  const ctx2 = await browser.newContext();
  await ctx2.addInitScript(() => {
    const boom = () => { throw new Error('SecurityError: storage blocked'); };
    Storage.prototype.getItem = boom;
    Storage.prototype.setItem = boom;
    Storage.prototype.removeItem = boom;
  });
  const p2 = await ctx2.newPage();
  const errors = [];
  p2.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  try {
    await p2.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
    await p2.waitForTimeout(1200);
    assert.deepStrictEqual(errors, [], 'uncaught page errors with broken storage');
    assert.ok(((await p2.textContent('#status')) || '').length > 0, 'status never set — init died early');
    await p2.click('#btn-new-section');
    await p2.waitForSelector('.modal-foot button', { timeout: 5000 });
    await p2.click('.modal-foot button:not(.primary)');
  } finally {
    await ctx2.close();
  }
});

/* ================================================================== *
 * libDebouncedSave(): closing the tab must not lose the library edit
 * ================================================================== */

test('save: a library edit is flushed on beforeunload', async (page) => {
  await seed(page, {
    'riki.sections': { s1: section() },
    'riki.active': 's1',
  });
  await page.click('#btn-menu');
  await page.waitForSelector('#lib-masters .lib-name', { timeout: 5000 });
  await page.fill('#lib-masters .lib-name', 'NOME-ANTES-DO-UNLOAD');
  await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('riki.library')).masters[0].name);
  assert.strictEqual(saved, 'NOME-ANTES-DO-UNLOAD', 'library edit lost on unload: ' + saved);
  await page.click('#btn-sidebar-close');
  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');
});

/* ================================================================== *
 * uploads: a gigantic file is rejected before any read
 * ================================================================== */

test('upload: an oversized file is refused with a warning', async (page) => {
  await seed(page, {
    'riki.sections': { s1: section({ master: 'CURTO' }) },
    'riki.active': 's1',
  });
  const big = path.join(os.tmpdir(), 'riki-big-' + process.pid + '.md');
  fs.writeFileSync(big, Buffer.alloc(9 * 1024 * 1024, 0x41));
  try {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5000 }),
      page.click('[data-upload="master"]'),
    ]);
    await chooser.setFiles(big);
    await page.waitForTimeout(600);
    const toasts = await page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' '));
    assert.ok(/large|limit/i.test(toasts), 'no oversize warning, got: ' + toasts.slice(0, 160));
    const len = await page.$eval('#master', (el) => el.value.length);
    assert.ok(len < 100, 'oversized file polluted the section (' + len + ' chars)');
    assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');
  } finally {
    try { fs.unlinkSync(big); } catch (_) { /* best effort */ }
  }
});

/* ================================================================== *
 * a late model answer must not land in the new section
 * ================================================================== */

test('llm: a late answer stays in the section that asked for it', async (page) => {
  await seed(page, {
    'riki.config': { model: 'g', keys: { openai: 'sk-test' }, urls: {} },
    'riki.sections': {
      s1: section({ name: 'A', role: 'ROLE', master: 'MASTER' }),
      s2: section({ name: 'B', role: 'ROLE', master: 'MASTER' }),
    },
    'riki.active': 's1',
  });
  /* The model answers after 1200 ms. The user changes the section in
   * between. */
  await page.evaluate(() => {
    window.TellSDK = {
      create_ask_ai: async () => ({
        ask: () => new Promise((resolve) => setTimeout(() => resolve('CV-GERADO-PARA-A'), 1200)),
      }),
    };
  });
  await page.click('#btn-gen-cv');
  await page.waitForTimeout(300);
  await page.selectOption('#section-select', 's2');
  await page.waitForTimeout(2000);

  const field = await page.inputValue('#cvOut');
  assert.strictEqual(field, '', 'the answer of the other section landed in the form');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('riki.sections')));
  assert.strictEqual(stored.s1.cvOut, 'CV-GERADO-PARA-A', 'the answer did not reach the section that asked');
  assert.strictEqual(stored.s2.cvOut, '', 'the answer landed in the other section');
  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');
});

/* ================================================================== *
 * the chat sends the history in the turn format of the core
 * ================================================================== */

test('llm: the chat sends the history in the turn format of the core', async (page) => {
  await seed(page, {
    'riki.config': { model: 'g', keys: { openai: 'sk-test' }, urls: {} },
    'riki.sections': { s1: section({ name: 'A', role: 'ROLE', master: 'MASTER' }) },
    'riki.active': 's1',
  });
  const core = await page.evaluate(() => typeof (window.TellCore && window.TellCore.truncate_context));
  assert.strictEqual(core, 'function', 'the core did not load');

  /* The model answers at once. The test reads the prompt of the call. */
  await page.evaluate(() => {
    window.__tell_prompt = null;
    window.TellSDK = {
      create_ask_ai: async () => ({
        ask: (message, options) => {
          window.__tell_prompt = { message: message, system: options.system };
          return Promise.resolve('OK');
        },
      }),
    };
  });
  await page.click('[data-nav="3"]');
  await page.waitForTimeout(300);
  await page.fill('#chat-input', 'first question');
  await page.click('#chat-send');
  await page.waitForTimeout(500);
  await page.fill('#chat-input', 'second question');
  await page.click('#chat-send');
  await page.waitForTimeout(500);

  const prompt = await page.evaluate(() => window.__tell_prompt);
  assert.ok(prompt, 'the model was never called');
  const message = prompt.message || '';
  assert.ok(message.indexOf('Previous context:') !== -1, 'the context is missing: ' + message.slice(0, 120));
  assert.ok(message.indexOf('User:\nfirst question') !== -1, 'the user turn is gone: ' + message.slice(0, 160));
  assert.ok(message.indexOf('Assistant:\nOK') !== -1, 'the assistant turn is gone: ' + message.slice(0, 160));
  assert.ok(message.indexOf('User:\nsecond question') !== -1, 'the question is gone: ' + message.slice(0, 160));
  assert.ok(/RirekiTailor/.test(prompt.system || ''), 'the system prompt is missing');
  assert.ok(message.length <= 24000 + 200, 'the prompt is too long: ' + message.length);
  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');
});

/* ================================================================== *
 * a command of the model never reaches the user
 * ================================================================== */

test('llm: a command of the model is denied and the answer stays clean', async (page) => {
  await seed(page, {
    'riki.config': { model: 'g', keys: { openai: 'sk-test' }, urls: {} },
    'riki.sections': { s1: section({ name: 'A', role: 'ROLE', master: 'MASTER' }) },
    'riki.active': 's1',
  });
  await page.evaluate(() => {
    window.TellSDK = {
      create_ask_ai: async () => ({
        ask: async () => '<think>the reasoning</think>\nThe answer.\n<RUN>rm -rf /</RUN>',
      }),
    };
  });
  await page.click('[data-nav="3"]');
  await page.waitForTimeout(300);
  await page.fill('#chat-input', 'do something');
  await page.click('#chat-send');
  await page.waitForTimeout(800);

  const text = (await page.textContent('#chat-messages')) || '';
  assert.ok(text.indexOf('The answer.') !== -1, 'the answer is missing: ' + text.slice(0, 160));
  assert.ok(text.indexOf('<think>') === -1, 'the thinking of the model survived');
  assert.ok(text.indexOf('<RUN>') === -1, 'the command tag survived');
  assert.ok(text.indexOf('rm -rf') === -1, 'the command survived');
  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');
});

/* ================================================================== *
 * the model picker of the setup block
 * ================================================================== */

test('config: the aliases of the sdk and the spec of the model show up', async (page) => {
  await seed(page, {
    'riki.config': { model: 'openai:g', keys: { openai: 'sk-test' }, urls: {} },
    'riki.sections': { s1: section({ name: 'A' }) },
    'riki.active': 's1',
  });
  const aliases = await page.$$eval('#cfg-model-list option', (o) => o.map((x) => x.value));
  assert.ok(aliases.length > 0, 'the model list is empty');
  assert.ok(aliases.indexOf('g') !== -1, 'the alias g is missing: ' + aliases.slice(0, 8).join(','));
  assert.ok(aliases.indexOf('s') === -1, 'the list holds an alias of another provider');

  const spec = (await page.textContent('#cfg-model-spec')) || '';
  assert.ok(/gpt-6\.1-sol/.test(spec), 'the spec of the model is wrong: ' + spec);

  await page.fill('#cfg-model', 'gpt-4o');
  await page.waitForTimeout(300);
  const spec2 = (await page.textContent('#cfg-model-spec')) || '';
  assert.ok(/gpt-4o/.test(spec2), 'the spec did not follow the model: ' + spec2);

  await page.click('[data-vendor="anthropic"]');
  await page.waitForTimeout(300);
  await page.fill('#cfg-model', 'claude-x');
  await page.waitForTimeout(300);
  await page.click('[data-vendor="openai"]');
  await page.waitForTimeout(300);
  assert.strictEqual(await page.inputValue('#cfg-model'), 'gpt-4o', 'the model of the provider was lost');
  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');
});

test('config: an alias of another provider is named in the hint', async (page) => {
  await seed(page, {
    'riki.config': { model: 'openai:g', keys: { openai: 'sk-test' }, urls: {} },
    'riki.sections': { s1: section({ name: 'A' }) },
    'riki.active': 's1',
  });
  /* The alias j belongs to google. The provider openai is selected. */
  await page.fill('#cfg-model', 'j');
  await page.waitForTimeout(300);
  const hint = (await page.textContent('#cfg-model-spec')) || '';
  assert.ok(/google/.test(hint), 'the hint does not name the provider of the alias: ' + hint);
  const bad = await page.$eval('#cfg-model-spec', (el) => el.classList.contains('bad'));
  assert.ok(bad, 'the hint does not mark the wrong alias');
  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');
});

test('config: the model list of the custom endpoint fills the picker', async (page) => {
  await seed(page, {
    'riki.config': {
      model: 'custom:my-model',
      keys: { custom: 'ck-test' },
      urls: { custom: 'https://api.example.com/v1' },
    },
    'riki.sections': { s1: section({ name: 'A' }) },
    'riki.active': 's1',
  });
  /* The sdk asks the endpoint for the model list. The endpoint answers
   * with the shape of the openai api. */
  await page.evaluate(() => {
    const real = window.fetch;
    window.fetch = (url, opts) => {
      if (String(url).indexOf('api.example.com') === -1) return real(url, opts);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [{ id: 'model-a' }, { id: 'gpt-5.4-mini' }] }),
        text: () => Promise.resolve(''),
      });
    };
  });
  await page.click('[data-vendor="custom"]');
  await page.waitForTimeout(300);
  await page.click('#btn-cfg-models');
  await page.waitForTimeout(600);
  const options = await page.$$eval('#cfg-models option', (o) => o.map((x) => x.value));
  assert.ok(options.indexOf('model-a') !== -1, 'the model list is empty: ' + options.join(','));
  await page.selectOption('#cfg-models', 'gpt-5.4-mini');
  await page.waitForTimeout(400);
  assert.strictEqual(await page.inputValue('#cfg-model'), 'gpt-5.4-mini', 'the model field was not filled');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('riki.config')).model);
  assert.strictEqual(stored, 'custom:gpt-5.4-mini', 'the model was not saved: ' + stored);
  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');
});

/* ================================================================== *
 * the template LaTeX editor hides only the template cards
 * ================================================================== */

test('setup: opening the template editor keeps the provider cards', async (page) => {
  await seed(page, {
    'riki.config': { model: 'openrouter:minimax/minimax-m3.1-flash:free', setupDone: true },
    'riki.sections': { s1: section({ name: 'A', template: 'TEMPLATE' }) },
    'riki.active': 's1',
  });
  /* A ready config starts collapsed. */
  if (await page.$eval('#setup-block', (e) => e.classList.contains('collapsed'))) {
    await page.click('#btn-setup-toggle');
    await page.waitForTimeout(200);
  }
  const vendors = await page.$$eval('#vendor-grid .model-card', (b) => b.length);
  assert.ok(vendors > 0, 'no provider card rendered');

  await page.click('.tex-details summary');
  await page.waitForTimeout(200);
  const state = await page.evaluate(() => {
    const templateGrid = document.querySelector('#template-grid');
    return {
      editorOpen: document.querySelector('.tex-details').open,
      vendorsShown: !document.querySelector('#vendor-grid').hidden,
      vendors: document.querySelectorAll('#vendor-grid .model-card').length,
      templateHidden: Boolean(templateGrid && templateGrid.hidden),
    };
  });
  assert.ok(state.editorOpen, 'the template editor did not open');
  assert.ok(state.vendorsShown && state.vendors > 0, 'the provider cards disappeared');
  assert.ok(state.templateHidden, 'the visual model cards stayed over the editor');
  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');
});

/* ================================================================== *
 * an open setup adds page height, it does not squeeze the step
 * ================================================================== */

test('setup: an open setup keeps the step height', async (page) => {
  await seed(page, {
    'riki.config': { setupDone: true },
    'riki.sections': { s1: section({ name: 'A' }) },
    'riki.active': 's1',
  });
  /* A ready config starts collapsed. */
  if (!(await page.$eval('#setup-block', (e) => e.classList.contains('collapsed')))) {
    await page.click('#btn-setup-toggle');
    await page.waitForTimeout(200);
  }
  const size = () => page.evaluate(() => ({
    panel: document.querySelector('#panel1').getBoundingClientRect().height,
    editor: document.querySelector('#role').getBoundingClientRect().height,
    master: document.querySelector('#master').getBoundingClientRect().height,
    docH: document.documentElement.scrollHeight,
    viewH: window.innerHeight,
  }));
  const before = await size();
  await page.click('#btn-setup-toggle');
  await page.waitForTimeout(250);
  const after = await size();
  assert.ok(Math.abs(after.panel - before.panel) < 1, 'the step shrank: ' + before.panel + ' → ' + after.panel);
  assert.ok(Math.abs(after.editor - before.editor) < 1, 'the editor shrank: ' + before.editor + ' → ' + after.editor);
  assert.ok(Math.abs(after.master - after.editor) < 1, 'the master editor differs from the step editor: ' + after.master + ' vs ' + after.editor);
  assert.ok(after.docH > after.viewH, 'the open setup did not add page height');
  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');
});

/* ================================================================== *
 * library: master entries show as chips in the setup
 * ================================================================== */

test('library: a master entry shows as a chip and can be applied', async (page) => {
  await seed(page, {
    'riki.sections': { s1: section({ name: 'A', master: 'LOCAL MASTER', template: 'TEMPLATE' }) },
    'riki.active': 's1',
    'riki.library': {
      masters: [{ id: 'm1', name: 'Master OAL', lang: 'pt', content: 'LIB MASTER' }],
      templates: [],
    },
  });
  const chips = await page.$$eval('#master-models .user-tpl', (b) => b.map((x) => x.textContent));
  assert.ok(chips.some((t) => t.indexOf('Master OAL') !== -1), 'master chip missing: ' + JSON.stringify(chips));

  await page.click('#master-models .user-tpl');
  await page.waitForTimeout(300);
  assert.strictEqual(await page.inputValue('#master'), 'LIB MASTER', 'the chip did not apply the master');
  const selected = await page.$eval('#master-lib', (s) => s.options[s.selectedIndex].textContent);
  assert.ok(selected.indexOf('Master OAL') !== -1, 'the select does not show the master: ' + selected);

  /* Save the field as a new master: the section links to the new entry. */
  await page.click('[data-save-model="master"]');
  await page.waitForSelector('.modal-input');
  await page.fill('.modal-input', 'Chip Master');
  await page.click('.modal-foot .primary');
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    chips: Array.from(document.querySelectorAll('#master-models .user-tpl')).map((b) => ({ text: b.textContent, on: b.classList.contains('selected') })),
    selected: (() => { const s = document.querySelector('#master-lib'); return s.options[s.selectedIndex].textContent; })(),
  }));
  assert.ok(after.chips.some((c) => c.text.indexOf('Chip Master') !== -1), 'the saved master has no chip');
  assert.ok(after.selected.indexOf('Chip Master') !== -1, 'the saved master is not selected: ' + after.selected);
  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');
});

/* ================================================================== *
 * the key on the server and the stop button
 * ================================================================== */

test('llm: the server holds the key and the browser sends the call to it', async (page) => {
  /* The routes come before the seed: the browser asks the server for the
   * config when the page starts. */
  await page.route('**/api/llm/config', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ enabled: true, model: 'l', vendors: ['openai'] }),
  }));
  await page.route('**/api/llm', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ text: 'SERVER ANSWER', status: 'completed', commands: [] }),
  }));
  await seed(page, {
    'riki.config': { model: 'openai:g', keys: {}, urls: {} },
    'riki.sections': { s1: section({ name: 'A', role: 'ROLE', master: 'MASTER' }) },
    'riki.active': 's1',
  });
  await page.click('[data-nav="3"]');
  await page.waitForTimeout(300);
  await page.fill('#chat-input', 'hello server');
  await page.click('#chat-send');
  await page.waitForTimeout(800);
  const text = (await page.textContent('#chat-messages')) || '';
  assert.ok(text.indexOf('SERVER ANSWER') !== -1, 'the answer of the server did not arrive: ' + text.slice(0, 120));
  assert.ok(text.indexOf('API key') === -1, 'the app asked for a key that the server holds');
  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');
});

test('llm: the stop button drops the pending answer', async (page) => {
  await seed(page, {
    'riki.config': { model: 'openai:g', keys: { openai: 'sk-test' }, urls: {} },
    'riki.sections': { s1: section({ name: 'A', role: 'ROLE', master: 'MASTER' }) },
    'riki.active': 's1',
  });
  await page.evaluate(() => {
    window.TellSDK = {
      create_ask_ai: async () => ({
        ask: () => new Promise((resolve) => setTimeout(() => resolve('TOO LATE'), 1500)),
      }),
    };
  });
  await page.click('[data-nav="3"]');
  await page.waitForTimeout(300);
  await page.fill('#chat-input', 'stop me');
  await page.click('#chat-send');
  await page.waitForTimeout(300);
  const shown = await page.$eval('#chat-stop', (el) => !el.hidden);
  assert.ok(shown, 'the stop button is not shown while the answer runs');
  await page.click('#chat-stop');
  await page.waitForTimeout(2200);
  const text = (await page.textContent('#chat-messages')) || '';
  assert.ok(text.indexOf('TOO LATE') === -1, 'the cancelled answer landed: ' + text.slice(0, 120));
  const hidden = await page.$eval('#chat-stop', (el) => el.hidden);
  assert.ok(hidden, 'the stop button stayed visible after the answer');
  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');
});

/* ================================================================== *
 * the fix chain: repair, compile, retry
 * ================================================================== */

test('fix: the chain repairs, compiles and retries until the document compiles', async (page) => {
  await seed(page, {
    'riki.config': { model: 'g', keys: { openai: 'sk-test' }, urls: {} },
    'riki.sections': { s1: section({ name: 'A', tex: 'not latex at all' }) },
    'riki.active': 's1',
  });
  /* The engine fails the first compile and accepts the second. The model
   * answers with a broken reply first and with a document after that. */
  await page.evaluate(() => {
    window.__compiles = 0;
    window.__asks = 0;
    window.PdfTeXEngine = function () {
      return {
        loadEngine: () => Promise.resolve(),
        writeMemFSFile: () => {},
        setEngineMainFile: () => {},
        flushCache: () => {},
        compileLaTeX: () => {
          window.__compiles++;
          if (window.__compiles === 1) {
            return Promise.resolve({ status: 1, log: '! LaTeX Error: Missing $ inserted.\nl.12 $' });
          }
          return Promise.resolve({ status: 0, log: '', pdf: new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52]) });
        },
      };
    };
    window.TellSDK = {
      create_ask_ai: async () => ({
        ask: async () => {
          window.__asks++;
          if (window.__asks === 1) return 'still broken, no document here';
          /* A different document every round: the chain keeps working. */
          return '\\documentclass{article}\n\\begin{document}\nFixed ' + window.__asks + '.\n\\end{document}';
        },
      }),
    };
  });
  await page.click('[data-nav="3"]');
  await page.waitForTimeout(300);
  await page.click('#btn-fix-tex');
  await page.waitForFunction(
    () => document.getElementById('status').textContent.includes('fixed'),
    null,
    { timeout: 30000 }
  );
  const out = await page.evaluate(() => ({
    compiles: window.__compiles,
    asks: window.__asks,
    tex: JSON.parse(localStorage.getItem('riki.sections')).s1.tex,
    status: document.getElementById('status').textContent,
  }));
  assert.ok(out.asks >= 2, 'the model was called ' + out.asks + ' time(s): ' + out.status);
  assert.ok(out.compiles >= 1, 'the engine compiled ' + out.compiles + ' time(s): ' + out.status);
  assert.ok(out.tex.indexOf('\\documentclass') !== -1, 'the fixed tex was not saved: ' + out.tex.slice(0, 80));
  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');
});

test('fix: a chain that never compiles asks the user to rewrite the tex', async (page) => {
  await seed(page, {
    'riki.config': { model: 'g', keys: { openai: 'sk-test' }, urls: {} },
    'riki.sections': { s1: section({ name: 'A', tex: 'not latex at all' }) },
    'riki.active': 's1',
  });
  /* Every compile fails and every answer is a new document: the chain runs
   * the whole budget and then tells the user to rewrite the tex. */
  await page.evaluate(() => {
    window.__compiles = 0;
    window.__asks = 0;
    window.PdfTeXEngine = function () {
      return {
        loadEngine: () => Promise.resolve(),
        writeMemFSFile: () => {},
        setEngineMainFile: () => {},
        flushCache: () => {},
        compileLaTeX: () => {
          window.__compiles++;
          return Promise.resolve({ status: 1, log: '! LaTeX Error: File ended while scanning use.' });
        },
      };
    };
    window.TellSDK = {
      create_ask_ai: async () => ({
        ask: async () => {
          window.__asks++;
          return '\\documentclass{article}\n\\begin{document}\nStill broken ' + window.__asks + '.\n\\end{document}';
        },
      }),
    };
  });
  await page.click('[data-nav="3"]');
  await page.waitForTimeout(300);
  await page.click('#btn-fix-tex');
  await page.waitForFunction(
    () => document.getElementById('status').textContent.includes('rewrite'),
    null,
    { timeout: 60000 }
  );
  const out = await page.evaluate(() => ({
    asks: window.__asks,
    compiles: window.__compiles,
    status: document.getElementById('status').textContent,
    tex: JSON.parse(localStorage.getItem('riki.sections')).s1.tex,
  }));
  assert.ok(/rewrite/i.test(out.status), 'the status does not ask for a rewrite: ' + out.status);
  assert.strictEqual(out.asks, 8, 'the chain ran ' + out.asks + ' rounds instead of 8');
  assert.strictEqual(out.compiles, 8, 'the engine compiled ' + out.compiles + ' times instead of 8');
  assert.ok(out.tex.indexOf('not latex at all') !== -1, 'the broken tex was replaced by a broken answer');
  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');
});

test('fix: the chain stops early when the model repeats the same document', async (page) => {
  await seed(page, {
    'riki.config': { model: 'g', keys: { openai: 'sk-test' }, urls: {} },
    'riki.sections': { s1: section({ name: 'A', tex: 'not latex at all' }) },
    'riki.active': 's1',
  });
  /* The model always answers with the same document and every compile
   * fails: the chain must stop before the budget is spent. */
  await page.evaluate(() => {
    window.__compiles = 0;
    window.__asks = 0;
    window.PdfTeXEngine = function () {
      return {
        loadEngine: () => Promise.resolve(),
        writeMemFSFile: () => {},
        setEngineMainFile: () => {},
        flushCache: () => {},
        compileLaTeX: () => {
          window.__compiles++;
          return Promise.resolve({ status: 1, log: '! LaTeX Error: File ended while scanning use.' });
        },
      };
    };
    window.TellSDK = {
      create_ask_ai: async () => ({
        ask: async () => {
          window.__asks++;
          return '\\documentclass{article}\n\\begin{document}\nThe same document.\n\\end{document}';
        },
      }),
    };
  });
  await page.click('[data-nav="3"]');
  await page.waitForTimeout(300);
  await page.click('#btn-fix-tex');
  await page.waitForFunction(
    () => document.getElementById('status').textContent.includes('rewrite'),
    null,
    { timeout: 60000 }
  );
  const out = await page.evaluate(() => ({
    asks: window.__asks,
    compiles: window.__compiles,
  }));
  assert.ok(out.asks < 8, 'the chain ran ' + out.asks + ' rounds with the same answer');
  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');
});

/* ================================================================== *
 * a stalled data file must not kill the app
 * ================================================================== */

test('load: a data file that never answers does not stop the app', async (page) => {
  await page.route('**/data/CV_MASTER_EN.md', () => { /* never answers */ });
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const status = (await page.textContent('#status')) || '';
  assert.ok(status.trim().length > 0, 'the status never came — init died early');
  assert.ok(!/loading/i.test(status), 'the app is still loading: ' + status);

  /* The handlers are wired: the button answers. */
  await page.click('#btn-new-section');
  await page.waitForSelector('.modal-foot button', { timeout: 5000 });
  await page.click('.modal-foot button:not(.primary)');

  /* The typed text is saved even though the seed never came. */
  await page.fill('#role', 'ROLE-DURANTE-O-BLOQUEIO');
  await page.waitForTimeout(700);
  const stored = await page.evaluate(() => JSON.stringify(localStorage.getItem('riki.sections')));
  assert.ok(stored.indexOf('ROLE-DURANTE-O-BLOQUEIO') !== -1, 'the typed text was lost');
  await page.unroute('**/data/CV_MASTER_EN.md');
});

/* ================================================================== *
 * the active section falls back to an existing section
 * ================================================================== */

test('load: a missing active key selects the first section', async (page) => {
  await seed(page, {
    'riki.sections': { s1: section({ name: 'A' }), s2: section({ name: 'B' }) },
  });
  const state = await page.evaluate(() => ({
    selected: document.getElementById('section-select').selectedIndex,
    value: document.getElementById('section-select').value,
    empty: document.getElementById('step1-empty').style.display,
  }));
  assert.ok(state.selected >= 0, 'no section is selected: ' + JSON.stringify(state));
  assert.ok(state.value !== '', 'the select has no value');
  assert.notStrictEqual(state.empty, 'block', 'the banner says there is no section');
  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');
});

/* ================================================================== *
 * the load path has a ceiling
 * ================================================================== */

test('load: a state with many sections is capped and the app stays fast', async (page) => {
  const many = {};
  for (let i = 0; i < 2500; i++) many['s' + i] = section({ name: 'S' + i });
  await seed(page, { 'riki.sections': many, 'riki.active': 's0' });
  const started = Date.now();
  const count = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('riki.sections'))).length);
  const elapsed = Date.now() - started;
  assert.ok(count <= 2000, 'the ceiling was not applied: ' + count);
  assert.ok(elapsed < 15000, 'the state is too slow: ' + elapsed + ' ms');
  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');
});

/* ================================================================== *
 * source tripwires of the app
 * ================================================================== */

test('source: the app keeps the guards of the fixes', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'js', 'app.js'), 'utf8');
  assert.ok(src.includes('if (active() !== s)'), 'the late answer guard is gone');
  assert.ok(src.includes('let compileBusy = false'), 'the compile guard is gone');
  assert.ok(src.includes('if (compileBusy)'), 'the compile guard is not used');
  assert.ok(src.includes('showPdf(res.pdf, sectionId, shownKey)'), 'the PDF does not carry its section and file');
  assert.ok(src.includes('STORE_MAX_SECTIONS_LOAD'), 'the load ceiling is gone');
  assert.ok(src.includes('FETCH_TIMEOUT_MS'), 'the fetch timeout is gone');
  assert.ok(src.includes('await seedDefaults()'), 'the seed still blocks the start');
  assert.ok(!src.includes('Object.assign(config, normalizeConfig('), 'the import replaces the config again');
});

/* ================================================================== */

(async () => {
  const fmt_target = path.join(os.tmpdir(), 'riki-app-audit-' + process.pid + '.fmt');
  const server = spawn(
    process.execPath,
    [SERVE, '--port', String(PORT), '--no-mirror', '--fmt-target', fmt_target],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  );
  await new Promise((r) => setTimeout(r, 1200));

  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => page_errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') page_errors.push('console: ' + m.text()); });

  console.log('app_audit on ' + BASE);
  for (const t of tests) {
    try {
      await t.fn(page);
      report_ok(t.name);
    } catch (err) {
      report_fail(t.name, err);
    }
  }

  await browser.close();
  server.kill('SIGTERM');
  try { fs.unlinkSync(fmt_target); } catch (_) { /* best effort */ }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((err) => {
  console.error('APP-AUDIT-FAIL:', err);
  process.exit(1);
});
