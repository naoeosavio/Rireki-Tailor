#!/usr/bin/env node
'use strict';
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1200);

  const names = () => page.$$eval('#section-select option', (o) => o.map((x) => x.textContent));
  console.log('sections:', await names());
  console.log('master:', (await page.inputValue('#master')).length, '| template:', (await page.inputValue('#template')).length, '| role:', (await page.inputValue('#role')).length);

  // TellSDK carregado + config LLM
  const sdk = await page.evaluate(() => ({
    tell: typeof (window.TellSDK && window.TellSDK.tell),
    modJ: window.TellSDK && window.TellSDK.MODELS && window.TellSDK.MODELS['j'],
    modD: window.TellSDK && window.TellSDK.MODELS && window.TellSDK.MODELS['d'],
    nVendors: document.querySelectorAll('#cfg-panel .vendor-row').length,
  }));
  console.log('TellSDK:', JSON.stringify(sdk));
  console.log('cfg model default:', await page.inputValue('#cfg-model'));
  await page.$eval('#cfg-panel', (d) => (d.open = true));
  await page.fill('#cfg-model', 'd');
  await page.fill('#cfg-key-google', 'AIza-test');
  await page.waitForTimeout(200);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  console.log('cfg model persistido:', await page.inputValue('#cfg-model'), '| google key persistida:', (await page.inputValue('#cfg-key-google')).length > 0);

  // nova seção (dialog do prompt)
  page.once('dialog', async (d) => { await d.accept('Vaga Teste'); });
  await page.click('#btn-new-section');
  await page.waitForTimeout(400);
  console.log('after new:', await names());
  console.log('master inherited:', (await page.inputValue('#master')).length > 0);

  // editar role e trocar de seção (verifica isolamento)
  await page.fill('#role', 'VAGA TESTE ESPECIFICA');
  await page.waitForTimeout(200);
  await page.selectOption('#section-select', { index: 1 });
  await page.waitForTimeout(200);
  console.log('padrão role isolado:', !(await page.inputValue('#role')).includes('VAGA TESTE'));
  await page.selectOption('#section-select', { index: 0 });
  console.log('volta na vaga:', (await page.inputValue('#role')).includes('VAGA TESTE'));

  // persistência (reload)
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  console.log('after reload:', await names());
  console.log('role persistido:', (await page.inputValue('#role')).includes('VAGA TESTE'));

  // exportar JSON
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    page.click('#btn-export'),
  ]);
  const path = '/tmp/opencode/riki-export.json';
  await dl.saveAs(path);
  const fs = require('fs');
  const json = JSON.parse(fs.readFileSync(path, 'utf8'));
  console.log('export ok:', !!json.sections, Object.keys(json.sections).length, 'seções');

  // stepper
  await page.click('[data-nav="2"]');
  console.log('step2 visible:', (await page.$eval('#panel2', (p) => p.style.display)) === 'block');
  await page.click('[data-nav="3"]');
  console.log('step3 visible:', (await page.$eval('#panel3', (p) => p.style.display)) === 'block');

  // compile com .tex vazio → warn
  await page.click('#btn-compile');
  await page.waitForTimeout(200);
  console.log('warn tex vazio:', (await page.textContent('#status')).includes('vazio'));

  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})().catch((e) => { console.error('SMOKE-FAIL:', e); process.exit(1); });
