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
  await seed(page, {
    'riki.sections': { bad: section({ name: 'X', chat: 'not-an-array', role: 5, updatedAt: 'nope' }) },
    'riki.active': 'bad',
  });

  assert.deepStrictEqual(take_errors(), [], 'uncaught page errors');
  assert.strictEqual(await page.inputValue('#role'), '', 'a numeric role reached the form');

  await page.click('[data-nav="3"]');
  await page.waitForTimeout(400);
  assert.strictEqual(await page.$eval('#panel3', (p) => p.style.display), 'block', 'step 3 did not open');
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
      tell: () => new Promise((resolve) => setTimeout(() => resolve('CV-GERADO-PARA-A'), 1200)),
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
  assert.ok(src.includes('showPdf(res.pdf, sectionId)'), 'the PDF does not carry its section');
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
