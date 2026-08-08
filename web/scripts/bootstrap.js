#!/usr/bin/env node
'use strict';
/* Bootstrap: compila CV_ATS.tex via engine wasm num browser headless,
 * espelhando arquivos texlive locais. Uso:
 *   node bootstrap.js [--new-browser] [--timeout-min 20]
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const BASE = 'http://localhost:8080';
const OUT = '/tmp/opencode/bootstrap';
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({
    headless: true,
    dumpio: true,
    args: ['--disable-dev-shm-usage', '--enable-logging=stderr', '--log-level=0'],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('crash', () => note('*** PAGE CRASHED ***'));

const texliveReqs = new Set();
const consoleLog = [];
const PROGRESS = path.join(OUT, 'progress.txt');
const note = (s) => {
  console.log(s);
  fs.appendFileSync(PROGRESS, new Date().toISOString() + ' ' + s + '\n');
};

page.on('console', (msg) => {
  const t = msg.text();
  consoleLog.push(t);
  const m = t.match(/Start downloading texlive file (.+)$/);
  if (m) { texliveReqs.add(m[1]); note('[dl] ' + m[1]); }
  const e = t.match(/TexLive Download Failed (.+)$/);
  if (e) note('[FAILED-DL] ' + e[1]);
});
  page.on('pageerror', (e) => { consoleLog.push('PAGEERROR: ' + e.message); console.log('PAGEERROR:', e.message); });

  page.on('response', (res) => {
    const u = res.url();
    const m = u.match(/\/pdftex\/(pk\/)?(\d+)\/([^/]+)/);
    if (m) texliveReqs.add(`${m[2]}/${m[3]} ${res.status()}`);
  });

  console.log('abrindo', BASE + '/test.html');
  await page.goto(BASE + '/test.html', { waitUntil: 'domcontentloaded', timeout: 60000 });

  const waitStatus = async (label, timeoutMs, expected) => {
    const start = Date.now();
    let lastNote = 0;
    while (Date.now() - start < timeoutMs) {
      const s = await page.textContent('#status').catch(() => '');
      if (expected) {
        if (s.includes(expected)) return s;
      } else if (s.includes('OK') || s.includes('ERRO') || s.includes('TIMEOUT')) return s;
      const now = Date.now();
      if (now - lastNote > 15000) {
        lastNote = now;
        note(`  [${label}] ${((now - start) / 1000).toFixed(0)}s status="${s}" downloads=${texliveReqs.size}`);
      }
      await page.waitForTimeout(2500);
    }
    return 'TIMEOUT';
  };

  // espera engine pronto
  const st0 = await waitStatus('engine', 120000, 'engine pronto');
  note('engine: ' + st0);

  await page.click('#btn-format');
  const stF = await waitStatus('format', 25 * 60 * 1000);
  note('format build: ' + stF);

  await page.click('#btn-compile');
  const st1 = await waitStatus('compile', 25 * 60 * 1000);
  note('compile: ' + st1);

  const logText = await page.textContent('#log');
  fs.writeFileSync(path.join(OUT, 'log.txt'), logText);
  fs.writeFileSync(path.join(OUT, 'console.txt'), consoleLog.join('\n'));
  fs.writeFileSync(path.join(OUT, 'texlive-requests.txt'), [...texliveReqs].sort().join('\n'));
  console.log('logs salvos em', OUT);
  console.log('total texlive requests:', texliveReqs.size);

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
