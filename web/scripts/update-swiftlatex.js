#!/usr/bin/env node
'use strict';

/*
 * RirekiTailor Web — SwiftLaTeX vendoring updater
 *
 * Downloads a pinned SwiftLaTeX release, extracts the pdftex/dvipdfm engine
 * files into web/vendor/swiftlatex/ and re-applies the local patches:
 *
 *   1. swiftlatexpdftex.js  — texlive_endpoint defaults to same-origin
 *                             (static-hosting safe, no external texlive2 host)
 *   2. PdfTeXEngine.js      — ENGINE_PATH resolved from document.currentScript
 *                             (works under any base path / subdirectory)
 *   3. PdfTeXEngine.js      — compileFormat() resolves with the fmt bytes
 *                             (Uint8Array) instead of downloading via blob URL
 *
 * Usage:
 *   npm run update:swiftlatex
 *
 * Pinned source: package.json → "config" → "swiftlatex" → { version, url }.
 * License: vendored code keeps its own license (EPL-2.0 OR GPL-2.0 WITH
 * Classpath-exception-2.0 / AGPL-3.0 upstream).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const WEB_ROOT = path.resolve(__dirname, '..');
const VENDOR_DIR = path.join(WEB_ROOT, 'vendor', 'swiftlatex');
const PKG = require(path.join(WEB_ROOT, 'package.json'));
const PIN = PKG.config && PKG.config.swiftlatex;

if (!PIN || !PIN.version || !PIN.url) {
  console.error('update-swiftlatex: missing package.json → config.swiftlatex {version, url}');
  process.exit(1);
}

const FILES = [
  { name: 'PdfTeXEngine.js' },
  { name: 'swiftlatexpdftex.js' },
  { name: 'swiftlatexpdftex.wasm' },
  { name: 'swiftlatexdvipdfm.js' },
  { name: 'swiftlatexdvipdfm.wasm' },
];

const PATCH_ENDPOINT = {
  from: 'self.texlive_endpoint="https://texlive2.swiftlatex.com/"',
  to: 'self.texlive_endpoint=(self.location&&self.location.origin)?(self.location.origin+"/"):"/"',
};

const PATCH_ENGINE_PATH = {
  from: "var ENGINE_PATH = 'swiftlatexpdftex.js';",
  to:
    "var ENGINE_PATH = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) ?\n" +
    "    new URL('swiftlatexpdftex.js', document.currentScript.src).href : 'swiftlatexpdftex.js';",
};

const PATCH_COMPILE_FORMAT = {
  from: [
    "                                    if (result === 'ok') {",
    "                                        var formatArray = data['pdf']; /* PDF for result */",
    "                                        var formatBlob = new Blob([formatArray], { type: 'application/octet-stream' });",
    '                                        var formatURL_1 = URL.createObjectURL(formatBlob);',
    '                                        setTimeout(function () { URL.revokeObjectURL(formatURL_1); }, 30000);',
    "                                        console.log('Download format file via ' + formatURL_1);",
    '                                        resolve();',
    '                                    }',
  ].join('\n'),
  to: [
    "                                    if (result === 'ok') {",
    "                                        var formatArray = data['pdf']; /* PDF for result */",
    "                                        var formatBlob = new Blob([formatArray], { type: 'application/octet-stream' });",
    '                                        var formatURL_1 = URL.createObjectURL(formatBlob);',
    '                                        setTimeout(function () { URL.revokeObjectURL(formatURL_1); }, 30000);',
    "                                        console.log('Download format file via ' + formatURL_1);",
    '                                        const fview = new Uint8Array(formatArray);',
    '                                        resolve(fview);',
    '                                    }',
  ].join('\n'),
};

const VERIFY = [
  { file: 'PdfTeXEngine.js', text: "new URL('swiftlatexpdftex.js', document.currentScript.src)" },
  { file: 'PdfTeXEngine.js', text: 'resolve(fview);' },
  { file: 'swiftlatexpdftex.js', text: '(self.location&&self.location.origin)' },
];

function patchOnce(content, { from, to }, label) {
  if (!content.includes(from)) {
    throw new Error(`patch failed (marker not found): ${label}`);
  }
  const out = content.replace(from, to);
  if (out === content) {
    throw new Error(`patch failed (no change): ${label}`);
  }
  return out;
}

function applyPatches(name, content) {
  if (name === 'swiftlatexpdftex.js') {
    return patchOnce(content, PATCH_ENDPOINT, 'texlive_endpoint same-origin');
  }
  if (name === 'PdfTeXEngine.js') {
    let out = patchOnce(content, PATCH_ENGINE_PATH, 'ENGINE_PATH from document.currentScript');
    return patchOnce(out, PATCH_COMPILE_FORMAT, 'compileFormat resolves fmt bytes');
  }
  return content;
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status} ${res.statusText} (${url})`);
  }
  return Buffer.from(await res.arrayBuffer());
}

(async () => {
  try {
    fs.mkdirSync(VENDOR_DIR, { recursive: true });

    console.log(`update-swiftlatex: fetching ${PIN.version} (${PIN.url})`);
    const zipBuf = await download(PIN.url);
    const zipPath = path.join(os.tmpdir(), `swiftlatex-${PIN.version}.zip`);
    fs.writeFileSync(zipPath, zipBuf);

    let total = 0;
    for (const file of FILES) {
      const raw = execFileSync('unzip', ['-p', zipPath, file.name], {
        encoding: 'buffer',
        maxBuffer: 64 * 1024 * 1024,
      });
      let content = applyPatches(file.name, raw.toString('utf8'));
      const outBuf = file.name.endsWith('.wasm') ? raw : Buffer.from(content, 'utf8');
      const target = path.join(VENDOR_DIR, file.name);
      fs.writeFileSync(target, outBuf);
      const delta = outBuf.length - raw.length;
      total += delta;
      console.log(`  ${file.name.padEnd(24)} ${String(raw.length).padStart(8)} -> ${String(outBuf.length).padStart(8)} bytes (${delta >= 0 ? '+' : ''}${delta})`);
    }

    for (const { file, text } of VERIFY) {
      const content = fs.readFileSync(path.join(VENDOR_DIR, file), 'utf8');
      if (!content.includes(text)) {
        throw new Error(`verify failed: '${text}' not in ${file}`);
      }
    }
    for (const file of ['swiftlatexpdftex.wasm', 'swiftlatexdvipdfm.wasm']) {
      const head = fs.readFileSync(path.join(VENDOR_DIR, file)).subarray(0, 4);
      if (!head.equals(Buffer.from([0, 0x61, 0x73, 0x6d]))) {
        throw new Error(`verify failed: ${file} missing wasm magic`);
      }
    }

    console.log(`\nupdate-swiftlatex: OK — ${PIN.version} vendored into web/vendor/swiftlatex/ (net ${total >= 0 ? '+' : ''}${total} bytes)`);
    console.log('NOTE: engine change invalidates web/pdftex/10/swiftlatexpdftex.fmt — rebuild it via');
    console.log('  test.html?autostart=format (wasm) or re-run: npm run bootstrap');
  } catch (err) {
    console.error(`update-swiftlatex: FAILED — ${err.message}`);
    process.exit(1);
  }
})();