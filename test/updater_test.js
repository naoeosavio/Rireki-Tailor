#!/usr/bin/env node
'use strict';

/*
 * Tests for src/scripts/update-swiftlatex.js.
 *
 * The updater replaces the vendored engine. A failure in the middle of the
 * run left the engine half updated before, and the download went to a path
 * in the shared temp directory that anyone can guess.
 *
 * The suite builds a small archive with the same file names as the real
 * release, serves it over HTTP, and runs the updater against it.
 *
 * Usage: node test/updater_test.js
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const UPDATER = path.resolve(__dirname, '..', 'src', 'scripts', 'update-swiftlatex.js');
const PKG = require('../package.json');

/* ---- the archive ---- */

const WASM_MAGIC = Buffer.from([0, 0x61, 0x73, 0x6d]);

/* The markers that the updater patches. The fake archive carries exactly
 * the markers of the source, so the test follows the source and does not
 * hold a second copy of the markers. */
function patchMarker(name, field) {
  const src = fs.readFileSync(UPDATER, 'utf8');
  const start = src.indexOf('const ' + name + ' = {');
  assert.ok(start !== -1, 'the patch is not in the source: ' + name);
  const keyStart = src.indexOf(field + ':', start);
  assert.ok(keyStart !== -1, 'the field is not in the source: ' + name + '.' + field);
  let valueStart = keyStart + field.length + 1;
  while (valueStart < src.length && /\s/.test(src[valueStart])) valueStart++;
  const first = src[valueStart];
  if (first === '[') {
    const valueEnd = findArrayEnd(src, valueStart);
    return new Function('return ' + src.slice(valueStart, valueEnd + 1))();
  }
  if (first === "'" || first === '"') {
    let end = valueStart + 1;
    while (end < src.length) {
      if (src[end] === '\\') { end += 2; continue; }
      if (src[end] === first) break;
      end++;
    }
    return new Function('return ' + src.slice(valueStart, end + 1))();
  }
  assert.fail('the marker of ' + name + '.' + field + ' has an unknown shape');
  return '';
}

const ENGINE_JS = [
  patchMarker('PATCH_ENGINE_PATH', 'from'),
  patchMarker('PATCH_COMPILE_FORMAT', 'from').join('\n'),
].join('\n');

const TEXLIVE_JS = [
  patchMarker('PATCH_ENDPOINT', 'from'),
  patchMarker('PATCH_FILEID_FALLBACK', 'from'),
  patchMarker('PATCH_PKID_FALLBACK', 'from'),
].join('\n');

const DVIPDFM_JS = '// dvi pdfm\n';

/* The index of the bracket that closes the array. A bracket inside a
 * string does not count. */
function findArrayEnd(src, start) {
  let depth = 0;
  let quote = '';
  for (let i = start; i < src.length; i++) {
    const char = src[i];
    if (quote) {
      if (char === '\\') { i++; continue; }
      if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '[') depth++;
    else if (char === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  assert.fail('the array has no end');
  return start;
}

function buildZip(dir, withGoodWasm) {
  const stage = path.join(dir, 'zip');
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, 'PdfTeXEngine.js'), ENGINE_JS);
  fs.writeFileSync(path.join(stage, 'swiftlatexpdftex.js'), TEXLIVE_JS);
  fs.writeFileSync(path.join(stage, 'swiftlatexdvipdfm.js'), DVIPDFM_JS);
  const wasm = withGoodWasm ? Buffer.concat([WASM_MAGIC, Buffer.alloc(64, 0x41)]) : Buffer.alloc(64, 0x42);
  fs.writeFileSync(path.join(stage, 'swiftlatexpdftex.wasm'), wasm);
  fs.writeFileSync(path.join(stage, 'swiftlatexdvipdfm.wasm'), wasm);
  const zipPath = path.join(dir, 'archive.zip');
  execFileSync('zip', ['-q', '-j', zipPath, path.join(stage, 'PdfTeXEngine.js'),
    path.join(stage, 'swiftlatexpdftex.js'), path.join(stage, 'swiftlatexdvipdfm.js'),
    path.join(stage, 'swiftlatexpdftex.wasm'), path.join(stage, 'swiftlatexdvipdfm.wasm')]);
  return zipPath;
}

/* ---- the server ---- */

let server = null;
let zipPath = '';

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const body = fs.readFileSync(zipPath);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': body.length });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function stopServer() {
  if (server) server.close();
  server = null;
}

function runUpdater(vendorDir, url) {
  /* The child fetches from the server of this process. The call must not
   * block the event loop, or the server never answers the child. */
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [UPDATER, '--vendor-dir', vendorDir, '--url', url], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code, signal: signal, stdout: stdout, stderr: stderr });
    });
  });
}

/* ================================================================== */

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'riki-updater-'));
  const vendorDir = path.join(work, 'vendor');
  const zipDir = path.join(work, 'zip');
  fs.mkdirSync(zipDir, { recursive: true });
  zipPath = buildZip(zipDir, true);
  const port = await startServer();
  const url = 'http://127.0.0.1:' + port + '/swiftlatex.zip';

  const results = [];
  const addTest = (name, fn) => { results.push({ name: name, fn: fn }); };

  addTest('updater: a good archive lands in the vendor directory', async () => {
    const res = await runUpdater(vendorDir, url);
    assert.strictEqual(res.status, 0, 'the updater failed: ' + res.stdout + res.stderr);
    const engine = fs.readFileSync(path.join(vendorDir, 'PdfTeXEngine.js'), 'utf8');
    assert.ok(engine.includes("new URL('swiftlatexpdftex.js', document.currentScript.src)"), 'the patch is missing');
    assert.ok(engine.includes('resolve(fview);'), 'the patch is missing');
    const wasm = fs.readFileSync(path.join(vendorDir, 'swiftlatexpdftex.wasm'));
    assert.ok(wasm.subarray(0, 4).equals(WASM_MAGIC), 'the wasm magic is wrong');
  });

  addTest('updater: a broken archive leaves the good engine in place', async () => {
    /* The archive has a wasm file without the magic. The run must fail and
     * the files of the last good run must stay untouched. */
    const before = fs.readFileSync(path.join(vendorDir, 'PdfTeXEngine.js'));
    const badZip = buildZip(path.join(work, 'badzip'), false);
    const good = zipPath;
    zipPath = badZip;
    const res = await runUpdater(vendorDir, url);
    zipPath = good;
    assert.notStrictEqual(res.status, 0, 'the updater accepted a broken archive');
    assert.ok(res.stderr.includes('FAILED'), 'the failure is not reported');
    assert.ok(fs.readFileSync(path.join(vendorDir, 'PdfTeXEngine.js')).equals(before), 'the engine changed anyway');
  });

  addTest('updater: the download does not use a predictable path', async () => {
    /* The old updater wrote the archive to
     * <tmp>/swiftlatex-<version>.zip. The name is known, so another user of
     * the machine can put a symlink there. The file is removed first, so
     * the test sees only the run of the updater. */
    const guess = path.join(os.tmpdir(), 'swiftlatex-' + PKG.config.swiftlatex.version + '.zip');
    try { fs.unlinkSync(guess); } catch (_) { /* the file is not there */ }
    const res = await runUpdater(vendorDir, url);
    assert.strictEqual(res.status, 0, 'the updater failed: ' + res.stdout + res.stderr);
    assert.ok(!fs.existsSync(guess), 'the archive landed on the predictable path: ' + guess);
  });

  addTest('updater: the source keeps the staging directory', () => {
    const src = fs.readFileSync(UPDATER, 'utf8');
    assert.ok(src.includes('mkdtempSync'), 'the private temp directory is gone');
    assert.ok(src.includes('stageDir'), 'the staging directory is gone');
    assert.ok(src.includes("flag: 'wx'"), 'the exclusive write flag is gone');
  });

  let passed = 0;
  let failed = 0;
  for (const item of results) {
    try {
      await item.fn();
      passed++;
      console.log('  ok   ' + item.name);
    } catch (err) {
      failed++;
      console.log('  FAIL ' + item.name);
      console.log('       ' + (err && err.message ? err.message.split('\n').join('\n       ') : err));
    }
  }

  stopServer();
  try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) { /* best effort */ }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((err) => {
  stopServer();
  console.error('UPDATER-FAIL:', err);
  process.exit(1);
});
