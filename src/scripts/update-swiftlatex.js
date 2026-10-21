#!/usr/bin/env node
'use strict';

/*
 * RirekiTailor Web — SwiftLaTeX vendoring updater
 *
 * Downloads a pinned SwiftLaTeX release, extracts the pdftex/dvipdfm engine
 * files into src/vendor/swiftlatex/ and re-applies the local patches:
 *
 *   1. swiftlatexpdftex.js  — texlive_endpoint defaults to site root
 *                             (static-hosting safe, no external texlive2 host,
 *                             subdirectory-aware for GitHub Pages)
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

const ROOT = path.resolve(__dirname, '..', '..');
const WEB_ROOT = path.resolve(__dirname, '..');
const PKG = require(path.join(ROOT, 'package.json'));
const PIN = PKG.config && PKG.config.swiftlatex;

/* The flags exist for the test suite: it needs a local archive and a
 * directory of its own. */
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const VENDOR_DIR = path.resolve(argOf('--vendor-dir', path.join(WEB_ROOT, 'vendor', 'swiftlatex')));
const PINNED_URL = argOf('--url', PIN && PIN.url);

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

// Worker lives three segments below site root (vendor/swiftlatex/file),
// so strip them to support subdirectory hosting such as GitHub Pages.
const PATCH_ENDPOINT = {
  from: 'self.texlive_endpoint="https://texlive2.swiftlatex.com/"',
  to:
    'self.texlive_endpoint=(function(){try{var u=new URL(' +
    'self.location.href),x=u.pathname.split("/").filter(Boolean);' +
    'if(x.length>=3)x=x.slice(0,x.length-3);' +
    'return u.origin+(x.length?"/"+x.join("/")+"/":"/")}' +
    'catch(err){return"/"}})()',
};

const PATCH_ENGINE_PATH = {
  from: "var ENGINE_PATH = 'swiftlatexpdftex.js';",
  to:
    "var ENGINE_PATH = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) ?\n" +
    "    new URL('swiftlatexpdftex.js', document.currentScript.src).href : 'swiftlatexpdftex.js';",
};

/* Static hosts (GitHub Pages) send no fileid/pkid headers, so every 200
 * landed on TEXCACHEROOT/null and the 200-cache served stale bytes
 * across files/compiles (instant "Fatal format file error" online while
 * dev worked). Fall back to a savepath unique per cache key; with the
 * header present (dev serve.js) behavior is byte-identical. */
const PATCH_FILEID_FALLBACK = {
  from: 'const fileid=xhr.getResponseHeader("fileid");const savepath=TEXCACHEROOT+"/"+fileid;',
  to: 'const fileid=xhr.getResponseHeader("fileid")||(format+"_"+reqname.replace(/[^\\w.\\-]/g,"_"));const savepath=TEXCACHEROOT+"/"+fileid;',
};

const PATCH_PKID_FALLBACK = {
  from: 'const pkid=xhr.getResponseHeader("pkid");const savepath=TEXCACHEROOT+"/"+pkid;',
  to: 'const pkid=xhr.getResponseHeader("pkid")||("pk_"+dpi+"_"+reqname.replace(/[^\\w.\\-]/g,"_"));const savepath=TEXCACHEROOT+"/"+pkid;',
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
  { file: 'swiftlatexpdftex.js', text: 'new URL(self.location.href)' },
  { file: 'swiftlatexpdftex.js', text: 'format+"_"+reqname.replace' },
  { file: 'swiftlatexpdftex.js', text: '"pk_"+dpi+"_"+reqname.replace' },
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
    let out = patchOnce(content, PATCH_ENDPOINT, 'texlive_endpoint site-root');
    out = patchOnce(out, PATCH_FILEID_FALLBACK, 'fileid fallback savepath');
    return patchOnce(out, PATCH_PKID_FALLBACK, 'pkid fallback savepath');
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
  /* The download goes to a private directory. A file in the shared temp
   * directory has a name that anyone can guess, and a symlink with that
   * name makes the write land in another file. */
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftlatex-'));
  const zipPath = path.join(tmpDir, 'swiftlatex.zip');
  /* The engine files go to a staging directory. The live files change only
   * when every file passed the checks: a failure in the middle of the run
   * left the engine half updated before. */
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftlatex-stage-'));
  try {
    fs.mkdirSync(VENDOR_DIR, { recursive: true });

    console.log(`update-swiftlatex: fetching ${PIN.version} (${PINNED_URL})`);
    const zipBuf = await download(PINNED_URL);
    fs.writeFileSync(zipPath, zipBuf, { flag: 'wx' });

    let total = 0;
    for (const file of FILES) {
      const raw = execFileSync('unzip', ['-p', zipPath, file.name], {
        encoding: 'buffer',
        maxBuffer: 64 * 1024 * 1024,
      });
      let content = applyPatches(file.name, raw.toString('utf8'));
      const outBuf = file.name.endsWith('.wasm') ? raw : Buffer.from(content, 'utf8');
      const staged = path.join(stageDir, file.name);
      fs.writeFileSync(staged, outBuf, { flag: 'wx' });
      const delta = outBuf.length - raw.length;
      total += delta;
      console.log(`  ${file.name.padEnd(24)} ${String(raw.length).padStart(8)} -> ${String(outBuf.length).padStart(8)} bytes (${delta >= 0 ? '+' : ''}${delta})`);
    }

    for (const { file, text } of VERIFY) {
      const content = fs.readFileSync(path.join(stageDir, file), 'utf8');
      if (!content.includes(text)) {
        throw new Error(`verify failed: '${text}' not in ${file}`);
      }
    }
    for (const file of ['swiftlatexpdftex.wasm', 'swiftlatexdvipdfm.wasm']) {
      const head = fs.readFileSync(path.join(stageDir, file)).subarray(0, 4);
      if (!head.equals(Buffer.from([0, 0x61, 0x73, 0x6d]))) {
        throw new Error(`verify failed: ${file} missing wasm magic`);
      }
    }

    /* Every file passed the checks: the live engine changes now. The
     * rename per file keeps the old file in place until the new one is
     * complete. */
    for (const file of FILES) {
      const target = path.join(VENDOR_DIR, file.name);
      const pending = target + '.new';
      fs.copyFileSync(path.join(stageDir, file.name), pending);
      fs.renameSync(pending, target);
    }

    console.log(`\nupdate-swiftlatex: OK — ${PIN.version} vendored into src/vendor/swiftlatex/ (net ${total >= 0 ? '+' : ''}${total} bytes)`);
    console.log('NOTE: engine change invalidates src/pdftex/10/swiftlatexpdftex.fmt — rebuild it via');
    console.log('  test.html?autostart=format (wasm) or re-run: npm run bootstrap');
  } catch (err) {
    console.error(`update-swiftlatex: FAILED — ${err.message}`);
    process.exitCode = 1;
  } finally {
    for (const dir of [tmpDir, stageDir]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
    if (process.exitCode) process.exit(process.exitCode);
  }
})();