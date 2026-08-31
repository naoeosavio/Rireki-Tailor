#!/usr/bin/env node
'use strict';
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1200);
  console.log('seções:', await page.$$eval('#section-select option', (o) => o.map((x) => x.textContent)));

  await page.click('[data-nav="3"]');
  const tex = await page.evaluate(() => fetch('data/CV_ATS.tex').then((r) => r.text()));
  await page.fill('#tex', tex);
  console.log('tex loaded:', tex.length, 'chars');

  await page.click('#btn-compile');
  const t0 = Date.now();
  for (let i = 0; i < 3000; i++) {
    const s = await page.textContent('#status');
    if (s.startsWith('PDF gerado') || s.startsWith('ERRO')) break;
    await page.waitForTimeout(1000);
  }
  console.log('status:', await page.textContent('#status'));
  console.log('elapsed:', ((Date.now() - t0) / 1000).toFixed(0) + 's');
  console.log('viewer visible:', await page.$eval('#viewer', (v) => v.style.display));
  const viewerSrc = await page.$eval('#viewer', (v) => v.src);
  const header = await page.evaluate(async (u) => {
    const r = await fetch(u);
    const b = new Uint8Array(await r.arrayBuffer());
    return { size: b.length, head: Array.from(b.slice(0, 8)).map((x) => x.toString(16).padStart(2, '0')).join(' ') };
  }, viewerSrc);
  console.log('pdf:', JSON.stringify(header));
  const dlPdf = await page.$eval('#dl-pdf', (b) => !!b);
  console.log('download pdf btn:', dlPdf);

  const s = await page.textContent('#status');
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
  if (!s.startsWith('PDF gerado')) process.exit(1);
  if (!header.head.replace(/ /g, '').startsWith('25504446')) process.exit(1);
})().catch((e) => { console.error('E2E-FAIL:', e); process.exit(1); });
