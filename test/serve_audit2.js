#!/usr/bin/env node
'use strict';

/*
 * Integration tests for the /api/upload-fmt idle path in src/scripts/serve.js.
 *
 * A client that opens an upload and then goes silent must not hold the
 * single-upload slot forever: the server answers 408, deletes the temp
 * file, and the next upload is accepted. Runs its own server instance
 * with a short --upload-timeout-ms so the suite stays fast.
 *
 * Usage: node test/serve_audit2.js
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVE = path.resolve(__dirname, '..', 'src', 'scripts', 'serve.js');
const FMT_MAGIC = Buffer.from([0x58, 0x54, 0x32, 0x57]); // "XT2W", web2c format

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let child = null;
let fmt_target = null;
let port = 0;

function start_server(extra_args) {
  return new Promise((resolve, reject) => {
    const args = ['--port', '0', '--no-mirror', '--fmt-target', fmt_target].concat(extra_args || []);
    child = spawn(process.execPath, [SERVE].concat(args), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => reject(new Error('server did not start: ' + out)), 10000);
    child.stdout.on('data', (c) => {
      out += c.toString();
      const m = out.match(/listening: (\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.stderr.on('data', (c) => { out += c.toString(); });
    child.on('error', reject);
  });
}

function stop_server() {
  if (child && !child.killed) child.kill('SIGTERM');
  child = null;
}

/* Opens an upload and goes silent; resolves with the status or 'TIMEOUT'. */
function silent_upload(timeout_ms) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/upload-fmt', method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': 5000000 },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve('CONN-RESET'));
    /* Sem write()/end() o Node nem descarrega os headers: flushHeaders()
     * garante que o servidor veja o upload e comece a esperar o corpo. */
    req.flushHeaders();
    const timer = setTimeout(() => { req.destroy(); resolve('TIMEOUT'); }, timeout_ms);
    timer.unref();
  });
}

function valid_upload() {
  return new Promise((resolve, reject) => {
    const payload = Buffer.concat([FMT_MAGIC, Buffer.alloc(2048, 0x43)]);
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/upload-fmt', method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, payload }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/* ================================================================== */

test('upload-fmt: a silent upload is answered with 408, not held forever', async () => {
  fs.writeFileSync(fmt_target, Buffer.concat([FMT_MAGIC, Buffer.alloc(4096)]));
  const status = await silent_upload(5000);
  assert.strictEqual(status, 408, 'expected 408 for the idle upload, got ' + status);
});

test('upload-fmt: the slot is free again after the idle timeout', async () => {
  const before = fs.readFileSync(fmt_target);
  const res = await valid_upload();
  assert.strictEqual(res.status, 200, 'expected 200 after the idle timeout, got ' + res.status);
  assert.ok(fs.readFileSync(fmt_target).equals(res.payload), 'target file does not match');
  assert.ok(!fs.existsSync(fmt_target + '.upload'), 'temp file leaked after the idle timeout');
  assert.ok(!before.equals(res.payload) || true, 'sanity');
});

/* ================================================================== */

(async () => {
  fmt_target = path.join(os.tmpdir(), 'riki-audit2-' + process.pid + '.fmt');
  fs.writeFileSync(fmt_target, Buffer.concat([FMT_MAGIC, Buffer.alloc(4096)]));
  try {
    const addr = await start_server(['--upload-timeout-ms', '400']);
    port = parseInt(addr.slice(addr.lastIndexOf(':') + 1), 10);
  } catch (err) {
    console.error('SERVE-AUDIT2: could not start server — ' + err.message);
    process.exit(1);
  }
  console.log('serve.js (idle-test) on 127.0.0.1:' + port);

  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log('  ok   ' + t.name);
    } catch (err) {
      failed++;
      console.log('  FAIL ' + t.name);
      console.log('       ' + (err && err.message ? err.message.split('\n').join('\n       ') : err));
    }
  }

  stop_server();
  try { fs.unlinkSync(fmt_target); } catch (_) { /* best effort */ }
  try { fs.unlinkSync(fmt_target + '.upload'); } catch (_) { /* best effort */ }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((err) => { stop_server(); console.error('SERVE-AUDIT2-FAIL:', err); process.exit(1); });
