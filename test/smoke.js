#!/usr/bin/env node
'use strict';
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const page = await browser.newPage({ colorScheme: 'dark' }); // deterministic initial theme
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);

  const names = () => page.$$eval('#section-select option', (o) => o.map((x) => x.textContent));
  console.log('sections:', await names());
  console.log('master:', (await page.inputValue('#master')).length, '| template:', (await page.inputValue('#template')).length, '| role:', (await page.inputValue('#role')).length);

  // TellSDK loaded + LLM config
  const sdk = await page.evaluate(() => ({
    tell: typeof (window.TellSDK && window.TellSDK.tell),
    nVendors: document.querySelectorAll('#cfg-panel .vendor-row').length,
    chatFn: typeof window.Chat !== 'undefined',
  }));
  console.log('TellSDK:', JSON.stringify(sdk));

  // ---------- theme ----------
  console.log('initial theme:', await page.evaluate(() => document.documentElement.dataset.theme), '(expected: dark)');
  await page.click('#btn-theme');
  await page.waitForTimeout(200);
  console.log('after toggle:', await page.evaluate(() => document.documentElement.dataset.theme), '(expected: light)');

  // ---------- LLM config inside the menu (sidebar) ----------
  console.log('cfg model default:', await page.inputValue('#cfg-model'));
  await page.click('#btn-cfg'); // opens the sidebar on the LLM tab
  await page.waitForSelector('#cfg-panel', { state: 'visible' });
  await page.fill('#cfg-model', 'd');
  await page.fill('#cfg-key-google', 'AIza-test');
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  console.log('cfg persisted:', await page.inputValue('#cfg-model'), '| google key persisted:', (await page.inputValue('#cfg-key-google')).length > 0);
  console.log('theme persisted:', await page.evaluate(() => document.documentElement.dataset.theme), '(expected: light)');

  // new section via the CUSTOM modal
  await page.click('#btn-new-section');
  await page.fill('.modal-input', 'Test Job');
  await page.click('.modal-foot button.primary');
  await page.waitForTimeout(400);
  console.log('after new:', await names());
  console.log('master inherited:', (await page.inputValue('#master')).length > 0);

  // edit role and switch sections (checks isolation)
  await page.fill('#role', 'SPECIFIC TEST JOB');
  await page.waitForTimeout(200);
  await page.selectOption('#section-select', { index: 1 });
  await page.waitForTimeout(200);
  console.log('default role isolated:', !(await page.inputValue('#role')).includes('TEST JOB'));
  await page.selectOption('#section-select', { index: 0 });
  console.log('back on the job:', (await page.inputValue('#role')).includes('TEST JOB'));

  // persistence (reload)
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  console.log('after reload:', await names());
  console.log('role persisted:', (await page.inputValue('#role')).includes('TEST JOB'));

  // export JSON
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    page.click('#btn-export'),
  ]);
  const path = '/tmp/opencode/riki-export.json';
  await dl.saveAs(path);
  const fs = require('fs');
  const json = JSON.parse(fs.readFileSync(path, 'utf8'));
  console.log('export ok:', !!json.sections, Object.keys(json.sections).length, 'sections | library masters:', (json.library && json.library.masters || []).length);

  // stepper
  await page.click('[data-nav="2"]');
  console.log('step2 visible:', (await page.$eval('#panel2', (p) => p.style.display)) === 'block');
  await page.click('[data-nav="3"]');
  console.log('step3 visible:', (await page.$eval('#panel3', (p) => p.style.display)) === 'block');

  // compile with an empty .tex → warn
  await page.click('#btn-compile');
  await page.waitForTimeout(200);
  console.log('warn empty tex:', (await page.textContent('#status')).includes('empty'));

  // ---------- library (side menu) ----------
  await page.click('#btn-menu');
  await page.waitForSelector('#lib-masters .lib-entry', { timeout: 5000 });
  let nMasters = await page.$$eval('#lib-masters .lib-entry', (e) => e.length);
  console.log('library masters (seeded):', nMasters, '| badge:', await page.textContent('#lib-master-count'));
  await page.click('#btn-add-master'); // 2nd master allowed
  await page.waitForTimeout(200);
  nMasters = await page.$$eval('#lib-masters .lib-entry', (e) => e.length);
  console.log('after add:', nMasters, '| add button disabled:', await page.$eval('#btn-add-master', (b) => b.disabled));
  await page.click('#btn-sidebar-close');
  await page.waitForTimeout(300);

  // per-section dropdown: copy a library master into the 2nd section
  await page.click('[data-nav="1"]');
  await page.waitForTimeout(200);
  await page.selectOption('#section-select', { index: 1 });
  await page.waitForTimeout(200);
  await page.$eval('#role', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.selectOption('#master-lib', { index: 1 }); // first library entry
  await page.waitForTimeout(300);
  const masterAfterLib = (await page.inputValue('#master')).length;
  console.log('dropdown loaded master into section:', masterAfterLib > 0, '(' + masterAfterLib + ' chars)');
  console.log('toast shown:', (await page.$$eval('.toast', (t) => t.length)) > 0);

  // ---------- per-section chat (Step 3) ----------
  await page.click('[data-nav="3"]');
  await page.waitForTimeout(300);
  console.log('chat visible:', await page.$eval('#chat-panel', (p) => p.offsetParent !== null));

  // section with role filled in → quick chips available
  await page.selectOption('#section-select', { index: 0 }); // Test Job (role filled in)
  await page.waitForTimeout(300);
  console.log('quick chips (job filled in):', (await page.$$('.chat-quick button')).length >= 1);
  console.log('assistant greeting:', (await page.$$('.msg.assistant')).length >= 1);

  // clear the key to test the no-API-key path (no network)
  await page.click('#btn-cfg');
  await page.waitForSelector('#cfg-key-google', { state: 'visible' });
  await page.fill('#cfg-key-google', '');
  await page.waitForTimeout(300);
  await page.click('#btn-sidebar-close');
  await page.waitForTimeout(200);

  await page.fill('#chat-input', 'What should I improve in this CV?');
  await page.click('#chat-send');
  await page.waitForSelector('.msg.error', { timeout: 5000 });
  const errMsg = await page.textContent('.msg.error');
  console.log('friendly chat error (no key):', errMsg.includes('API key'));
  console.log('link/button to open config on error:', (await page.$$('[data-open-cfg]', )).length > 0);

  // clear conversation via modal
  await page.click('#chat-clear');
  await page.waitForTimeout(300);
  await page.click('.modal-foot button.danger');
  await page.waitForTimeout(300);
  console.log('chat cleared (back to empty state):', (await page.$$('.msg.assistant')).length === 1 && (await page.$$('.msg.error')).length === 0 && (await page.$$('.msg.user')).length === 0);

  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})().catch((e) => { console.error('SMOKE-FAIL:', e); process.exit(1); });
