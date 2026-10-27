#!/usr/bin/env node
'use strict';

/*
 * Font coverage test for the browser PDF engine.
 *
 * The app reads every TeX file from src/pdftex/, a mirror of the TeXLive
 * files that earlier compiles requested. A deployed copy has no local
 * TeXLive to fill a gap, so a missing font stops the compile with
 * "Metric (TFM) file not found".
 *
 * This test starts serve.js in mirror-only mode (all TeXLive roots point at
 * an empty directory), compiles the built-in templates and the sample CV in
 * Chromium, and fails when one of them produces no PDF.
 *
 * Usage: node test/fonts_test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const REPO = path.resolve(__dirname, '..');
const SERVE = path.join(REPO, 'src', 'scripts', 'serve.js');
const COMPILE_TIMEOUT_MS = 120000;
const STATUS_POLL_MS = 500;
const CTX_TIMEOUT_MS = 20000;

/* A document with the shapes a CV can contain, in the T1 encoding with the
 * Latin Modern fonts. */
const T1_DOC = String.raw`\documentclass[11pt,a4paper]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\usepackage[margin=1.5cm]{geometry}
\usepackage{hyperref}
\begin{document}
\section{Experiência} \textbf{bold} \textit{italic} \textsc{caps}
\texttt{tt} \textsf{sans} {\small small} {\large large} $\sum x^2$
Ação, coração, ç. \footnote{note}
\end{document}
`;

let child = null;
let server = null;
let browser = null;

/* Starts serve.js with no readable TeXLive root: the mirror is the only
 * source of files, as on a static deployment. */
function start_server() {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'fonts-empty-'));
  const fmt_target = path.join(empty, 'swiftlatexpdftex.fmt');
  return new Promise((resolve, reject) => {
    const args = [
      '--port', '0', '--no-mirror', '--fmt-target', fmt_target,
      '--texmf', empty, '--texmf-extra', empty, '--texmf-extra2', empty,
    ];
    child = spawn(process.execPath, [SERVE].concat(args), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(
      () => reject(new Error('no start: ' + out)),
      10000
    );
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      const m = out.match(/listening: (\S+)/);
      if (!m) {
        return;
      }
      clearTimeout(timer);
      resolve('http://' + m[1].replace('0.0.0.0', '127.0.0.1'));
    });
    child.stderr.on('data', (chunk) => {
      out += chunk.toString();
    });
    child.on('error', reject);
  });
}

/* Opens the app with the code and the compile button visible. */
async function open_app(base_url) {
  const page = await browser.newPage();
  page.setDefaultTimeout(CTX_TIMEOUT_MS);
  await page.goto(base_url + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.click('[data-nav="3"]');
  await page.evaluate(() => {
    const toggle = document.querySelector('#view-code');
    if (toggle && !toggle.checked) {
      toggle.click();
    }
  });
  await page.waitForSelector('#tex', { state: 'visible' });
  return page;
}

/* Compiles one document and returns null on a PDF, or the status on a
 * failure. */
async function compile_document(page, tex) {
  await page.fill('#tex', tex);
  await page.click('#btn-compile');
  const start = Date.now();
  for (;;) {
    const status = await page.textContent('#status');
    if (/^PDF gerado/.test(status)) {
      return null;
    }
    if (/^(Erro de compila|ERRO|COMPILE ERROR)/i.test(status)) {
      return status;
    }
    if (Date.now() - start > COMPILE_TIMEOUT_MS) {
      return 'timeout after ' + COMPILE_TIMEOUT_MS + ' ms';
    }
    await page.waitForTimeout(STATUS_POLL_MS);
  }
}

/* The documents a user compiles first: the built-in templates and the
 * sample CV. */
function documents() {
  const defaults = require(path.join(REPO, 'src', 'js', 'defaults.js'));
  const list = [];
  for (const [key, tex] of Object.entries(defaults.DEFAULT_TEMPLATES)) {
    list.push({ name: 'template ' + key, tex: tex });
  }
  list.push({
    name: 'data/CV_ATS.tex',
    tex: fs.readFileSync(path.join(REPO, 'src', 'data', 'CV_ATS.tex'), 'utf8'),
  });
  list.push({ name: 'T1 + lmodern', tex: T1_DOC });
  return list;
}

async function main() {
  const base_url = await start_server();
  server = base_url;
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const page = await open_app(base_url);
  /* Every kpse answer that is not 200 names a file the mirror lacks. */
  const gaps = [];
  page.on('response', (res) => {
    const at = res.url().indexOf('/pdftex/');
    if (at !== -1 && res.status() !== 200) {
      gaps.push(res.url().slice(at));
    }
  });

  const failed = [];
  for (const doc of documents()) {
    gaps.length = 0;
    const error = await compile_document(page, doc.tex);
    if (error === null) {
      console.log('ok   ' + doc.name);
    } else {
      failed.push(doc.name);
      console.log('FAIL ' + doc.name + '\n     ' + error.slice(0, 300));
      if (gaps.length) {
        console.log('     missing from src/pdftex: ' + gaps.join(', '));
      }
    }
  }
  assert.deepStrictEqual(
    failed,
    [],
    'documents without a PDF: ' + failed.join(', ')
  );
  console.log('fonts: all ' + documents().length + ' documents compiled');
}

main()
  .catch((err) => {
    console.error('FONTS-FAIL: ' + (err && err.message ? err.message : err));
    if (server) {
      console.error('(server: ' + server + ')');
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) {
      await browser.close();
    }
    if (child) {
      child.kill();
    }
  });
