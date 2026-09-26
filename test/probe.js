#!/usr/bin/env node
'use strict';
/* Probe: tests compileLaTeX directly (without compileFormat) in a fresh browser */
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = 'http://localhost:8080';

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const page = await browser.newPage();
  page.on('console', (m) => console.log('[console]', m.text().slice(0, 200)));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('crash', () => console.log('[CRASH]'));
  page.on('requestfailed', (r) => console.log('[reqfail]', r.url(), r.failure()?.errorText));
  await page.goto(BASE + '/test.html', { waitUntil: 'domcontentloaded', timeout: 60000 });

  const wait = async (txt, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = await page.textContent('#status').catch(() => '?');
      if (s.includes(txt)) return s;
      await page.waitForTimeout(1000);
    }
    return 'TIMEOUT(' + txt + ')';
  };
  console.log('engine:', await wait('engine ready', 120000));
  console.log('click compile...');
  await page.click('#btn-compile');
  console.log('compile:', await wait('ERROR', 600000));
  const log = await page.textContent('#log');
  fs.writeFileSync('/tmp/opencode/bootstrap/probe-log.txt', log);
  console.log('--- log tail ---');
  console.log(log.split('\n').slice(-6).join('\n'));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
