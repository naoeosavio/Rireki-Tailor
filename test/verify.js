#!/usr/bin/env node
'use strict';
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const page = await browser.newPage();
  await page.goto('http://localhost:8080/test.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const t0 = Date.now();
  for (let i = 0; i < 300; i++) {
    const s = await page.textContent('#status').catch(() => '?');
    if (s.includes('engine ready')) break;
    await page.waitForTimeout(1000);
  }
  await page.click('#btn-compile');
  for (let i = 0; i < 1500; i++) {
    const s = await page.textContent('#status').catch(() => '?');
    if (s.includes('OK') || s.includes('ERROR')) break;
    await page.waitForTimeout(1000);
  }
  console.log('status:', await page.textContent('#status'));
  console.log('meta:', await page.textContent('#meta'));
  const pdfUrl = await page.evaluate(() => document.getElementById('viewer').src);
  const pdf = await page.evaluate(async (u) => {
    const r = await fetch(u);
    return Array.from(new Uint8Array(await r.arrayBuffer()).slice(0, 12));
  }, pdfUrl);
  console.log('pdf header:', pdf.map((b) => b.toString(16).padStart(2, '0')).join(' '));
  const pdfSize = await page.evaluate(async (u) => (await fetch(u)).arrayBuffer().then((b) => b.byteLength), pdfUrl);
  console.log('pdf size:', pdfSize);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
