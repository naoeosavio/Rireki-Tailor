#!/usr/bin/env node
'use strict';
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const page = await browser.newPage({ colorScheme: 'dark' }); // tema inicial determinístico
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);

  const names = () => page.$$eval('#section-select option', (o) => o.map((x) => x.textContent));
  console.log('sections:', await names());
  console.log('master:', (await page.inputValue('#master')).length, '| template:', (await page.inputValue('#template')).length, '| role:', (await page.inputValue('#role')).length);

  // TellSDK carregado + config LLM
  const sdk = await page.evaluate(() => ({
    tell: typeof (window.TellSDK && window.TellSDK.tell),
    nVendors: document.querySelectorAll('#cfg-panel .vendor-row').length,
    chatFn: typeof window.Chat !== 'undefined',
  }));
  console.log('TellSDK:', JSON.stringify(sdk));

  // ---------- tema ----------
  console.log('tema inicial:', await page.evaluate(() => document.documentElement.dataset.theme), '(esperado: dark)');
  await page.click('#btn-theme');
  await page.waitForTimeout(200);
  console.log('após toggle:', await page.evaluate(() => document.documentElement.dataset.theme), '(esperado: light)');

  // ---------- config LLM dentro do menu (sidebar) ----------
  console.log('cfg model default:', await page.inputValue('#cfg-model'));
  await page.click('#btn-cfg'); // abre sidebar na aba LLM
  await page.waitForSelector('#cfg-panel', { state: 'visible' });
  await page.fill('#cfg-model', 'd');
  await page.fill('#cfg-key-google', 'AIza-test');
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  console.log('cfg persistido:', await page.inputValue('#cfg-model'), '| google key persistida:', (await page.inputValue('#cfg-key-google')).length > 0);
  console.log('tema persistido:', await page.evaluate(() => document.documentElement.dataset.theme), '(esperado: light)');

  // nova seção via MODAL CUSTOMIZADO
  await page.click('#btn-new-section');
  await page.fill('.modal-input', 'Vaga Teste');
  await page.click('.modal-foot button.primary');
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
  await page.waitForTimeout(1500);
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
  console.log('export ok:', !!json.sections, Object.keys(json.sections).length, 'seções | library masters:', (json.library && json.library.masters || []).length);

  // stepper
  await page.click('[data-nav="2"]');
  console.log('step2 visible:', (await page.$eval('#panel2', (p) => p.style.display)) === 'block');
  await page.click('[data-nav="3"]');
  console.log('step3 visible:', (await page.$eval('#panel3', (p) => p.style.display)) === 'block');

  // compile com .tex vazio → warn
  await page.click('#btn-compile');
  await page.waitForTimeout(200);
  console.log('warn tex vazio:', (await page.textContent('#status')).includes('vazio'));

  // ---------- biblioteca (menu lateral) ----------
  await page.click('#btn-menu');
  await page.waitForSelector('#lib-masters .lib-entry', { timeout: 5000 });
  let nMasters = await page.$$eval('#lib-masters .lib-entry', (e) => e.length);
  console.log('biblioteca masters (seeded):', nMasters, '| badge:', await page.textContent('#lib-master-count'));
  await page.click('#btn-add-master'); // 2º master permitido
  await page.waitForTimeout(200);
  nMasters = await page.$$eval('#lib-masters .lib-entry', (e) => e.length);
  console.log('após add:', nMasters, '| botão add desabilitado:', await page.$eval('#btn-add-master', (b) => b.disabled));
  await page.click('#btn-sidebar-close');
  await page.waitForTimeout(300);

  // dropdown por seção: copiar master da biblioteca para a 2ª seção
  await page.click('[data-nav="1"]');
  await page.waitForTimeout(200);
  await page.selectOption('#section-select', { index: 1 });
  await page.waitForTimeout(200);
  await page.$eval('#role', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.selectOption('#master-lib', { index: 1 }); // primeira entrada da biblioteca
  await page.waitForTimeout(300);
  const masterAfterLib = (await page.inputValue('#master')).length;
  console.log('dropdown carregou master na seção:', masterAfterLib > 0, '(' + masterAfterLib + ' chars)');
  console.log('toast exibido:', (await page.$$eval('.toast', (t) => t.length)) > 0);

  // ---------- chat por seção (Etapa 3) ----------
  await page.click('[data-nav="3"]');
  await page.waitForTimeout(300);
  console.log('chat visível:', await page.$eval('#chat-panel', (p) => p.offsetParent !== null));

  // seção com role preenchido → quick chips disponíveis
  await page.selectOption('#section-select', { index: 0 }); // Vaga Teste (role preenchido)
  await page.waitForTimeout(300);
  console.log('quick chips (vaga preenchida):', (await page.$$('.chat-quick button')).length >= 1);
  console.log('saudação do assistente:', (await page.$$('.msg.assistant')).length >= 1);

  // limpar a key para testar o caminho sem API key (sem rede)
  await page.click('#btn-cfg');
  await page.waitForSelector('#cfg-key-google', { state: 'visible' });
  await page.fill('#cfg-key-google', '');
  await page.waitForTimeout(300);
  await page.click('#btn-sidebar-close');
  await page.waitForTimeout(200);

  await page.fill('#chat-input', 'O que melhorar neste CV?');
  await page.click('#chat-send');
  await page.waitForSelector('.msg.error', { timeout: 5000 });
  const errMsg = await page.textContent('.msg.error');
  console.log('chat erro amigável (sem key):', errMsg.includes('API key'));
  console.log('link/botão abrir config no erro:', (await page.$$('[data-open-cfg]', )).length > 0);

  // limpar conversa via modal
  await page.click('#chat-clear');
  await page.waitForTimeout(300);
  await page.click('.modal-foot button.danger');
  await page.waitForTimeout(300);
  console.log('chat limpo (voltou ao estado vazio):', (await page.$$('.msg.assistant')).length === 1 && (await page.$$('.msg.error')).length === 0 && (await page.$$('.msg.user')).length === 0);

  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})().catch((e) => { console.error('SMOKE-FAIL:', e); process.exit(1); });
