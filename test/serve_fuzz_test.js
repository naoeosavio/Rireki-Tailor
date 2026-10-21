#!/usr/bin/env node
'use strict';

/*
 * Fuzz tests for the dev server: src/scripts/serve.js.
 *
 * The server is the only part of the project that a web page can reach from
 * outside. The suite throws malformed paths, methods, headers, and bodies at
 * it and checks four properties:
 *
 * 1. The server never answers with an internal error. A bad request is a
 *    4xx, not a 500.
 * 2. The server never dies. One bad request must not end the process.
 * 3. The server never reads a file outside the web root.
 * 4. The proxy route never reaches a private address.
 *
 * The suite starts its own server on an ephemeral port.
 *
 * Usage: node test/serve_fuzz_test.js
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVE = path.resolve(__dirname, '..', 'src', 'scripts', 'serve.js');
const FMT_MAGIC = Buffer.from([0x58, 0x54, 0x32, 0x57]);

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) { tests.push({ name, fn }); }

let child = null;
let fmtTarget = null;
let port = 0;
let host = '127.0.0.1';

function startServer(extraArgs) {
  return new Promise((resolve, reject) => {
    const args = ['--port', '0', '--no-mirror', '--fmt-target', fmtTarget].concat(extraArgs || []);
    child = spawn(process.execPath, [SERVE].concat(args), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => reject(new Error('the server did not start: ' + out)), 10000);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      const m = out.match(/listening: (\S+):(\d+)/);
      if (m) {
        clearTimeout(timer);
        host = m[1].replace(/^\[|\]$/g, '');
        resolve(parseInt(m[2], 10));
      }
    });
    child.stderr.on('data', (chunk) => { out += chunk.toString(); });
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timer);
        reject(new Error('the server exited with ' + code + ': ' + out));
      }
    });
    child.on('error', reject);
  });
}

function stopServer() {
  if (child && !child.killed) child.kill('SIGTERM');
  child = null;
}

/* A request with a timeout. The answer is the status and the body. */
function request(options, body, timeoutMs) {
  return new Promise((resolve) => {
    let answered = null;
    const finish = (res) => {
      if (answered) return;
      answered = res;
      resolve(res);
    };
    const req = http.request({
      host: host,
      port: port,
      path: options.path || '/',
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => finish({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (err) => {
      /* The server can close the connection while the body is still on the
       * way. The answer then arrives a moment later. */
      setTimeout(() => finish({ status: 0, body: '', error: err.code || err.message }), 200);
    });
    req.setTimeout(timeoutMs || 5000, () => { req.destroy(); finish({ status: 0, body: '', error: 'TIMEOUT' }); });
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}

/* A raw request on a socket. The answer is the raw bytes. */
function rawRequest(payload, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect(port, host, () => socket.write(payload));
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(Buffer.concat(chunks).toString('latin1'));
    };
    socket.on('data', (c) => chunks.push(c));
    socket.on('close', finish);
    socket.on('error', () => finish());
    const timer = setTimeout(finish, timeoutMs || 4000);
    timer.unref();
  });
}

/* The statuses the server may answer with. An internal error is not one. */
const ALLOWED = [200, 301, 302, 304, 400, 403, 404, 405, 408, 409, 413, 415, 429, 500, 501];

function assertNoInternalError(res, label) {
  assert.ok(res.status !== 0, label + ': no answer (the request hung or the connection failed)');
  assert.ok(
    res.status !== 500,
    label + ': the server answered 500 (internal error): ' + res.body.slice(0, 200)
  );
}

function assertAlive(label) {
  assert.ok(child && child.exitCode === null, label + ': the server process died');
}

/* ================================================================== *
 * path fuzzing
 * ================================================================== */

const PATHS = [
  '/', '/index.html', '/js/app.js', '/css/app.css', '/data/role.md',
  '/%zz', '/%', '/%2', '/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fetc/passwd',
  '/%252e%252e%252fetc%252fpasswd', '/js/../../etc/passwd', '/./../../etc/passwd',
  '/%00', '/a%00b', '/test.html', '/test/', '/test/../index.html',
  '/pdftex/10/x', '/pdftex/999/x', '/pdftex/10/..%2f..%2fetc%2fpasswd',
  '/pdftex/pk/1/x', '/pdftex/10/', '/pdftex/', '/pdftex/abc/x',
  '/api/llm-forward', '/api/upload-fmt', '/__texmf', '/api/', '/api/none',
  '//', '///', '/./', '/?', '/?x=1', '/index.html?x=1', '/index.html#a',
  '/' + 'a'.repeat(2000), '/' + encodeURIComponent('a'.repeat(2000)),
  '/%c0%ae%c0%ae/etc/passwd', '/..;/etc/passwd', '/%09', '/%20', '/+', '/\\',
  '/index.html%20', '/INDEX.HTML', '/Js/App.js',
];

test('paths: a malformed path is a 4xx, never an internal error', async () => {
  for (const p of PATHS) {
    const res = await request({ path: p });
    assertNoInternalError(res, 'GET ' + p);
    assertAlive('GET ' + p);
  }
});

test('paths: the response never holds a file outside the web root', async () => {
  for (const p of PATHS) {
    const res = await request({ path: p });
    assert.ok(res.body.indexOf('root:x:') === -1, 'the answer of ' + p + ' holds a system file');
    assert.ok(res.body.indexOf('BEGIN RSA') === -1, 'the answer of ' + p + ' holds a key');
  }
});

test('paths: a long path does not kill the server', async () => {
  const res = await request({ path: '/' + 'b'.repeat(8000) });
  assertNoInternalError(res, 'the long path');
  assertAlive('the long path');
});

/* ================================================================== *
 * method fuzzing
 * ================================================================== */

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH', 'TRACE', 'PROPFIND', 'BOGUS'];

test('methods: every method is refused cleanly', async () => {
  for (const method of METHODS) {
    for (const p of ['/index.html', '/api/llm-forward', '/api/upload-fmt', '/pdftex/10/x', '/__texmf']) {
      const res = await request({ method: method, path: p, headers: { 'Content-Length': '0' } });
      assertNoInternalError(res, method + ' ' + p);
      assertAlive(method + ' ' + p);
    }
  }
});

/* ================================================================== *
 * header fuzzing
 * ================================================================== */

test('headers: a strange header never breaks the server', async () => {
  const cases = [
    { 'X-Big': 'a'.repeat(8000) },
    { 'Origin': 'http://evil.example' },
    { 'Origin': 'not a url' },
    { 'Origin': 'null' },
    { 'Content-Length': 'abc' },
    { 'Content-Length': '-1' },
    { 'Transfer-Encoding': 'chunked' },
    { 'Host': 'other.example' },
    { 'Cookie': 'a'.repeat(4000) },
  ];
  for (const headers of cases) {
    const res = await request({ path: '/index.html', headers: headers });
    assertNoInternalError(res, 'the header ' + JSON.stringify(headers).slice(0, 60));
    assertAlive('the header');
  }
});

test('headers: a bad request line is refused and the server stays alive', async () => {
  const payloads = [
    'GET /%zz HTTP/1.1\r\nHost: x\r\n\r\n',
    'GET / HTTP/1.1\r\nHost: x\r\nContent-Length: abc\r\n\r\n',
    'POST /api/llm-forward HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\nZZ\r\n',
    'GET / HTTP/1.1\r\n\r\n',
    'GET / HTTP/1.0\r\n\r\n',
    'BOGUS / HTTP/1.1\r\nHost: x\r\n\r\n',
    'GET / HTTP/9.9\r\nHost: x\r\n\r\n',
    'GET /\r\n\r\n',
    'GET http://evil.example/ HTTP/1.1\r\nHost: x\r\n\r\n',
    'GET / HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nab',
    '\r\n\r\n',
    'GET / HTTP/1.1\r\nHost: x\r\nX-A: \u0000\r\n\r\n',
    'GET /index.html HTTP/1.1\r\nHost: x\r\nX-Nul: a\u0000b\r\n\r\n',
    'GET /\u0000 HTTP/1.1\r\nHost: x\r\n\r\n',
    'GET /index.html HTTP/1.1\r\nHost: x\r\nX-Crlf: value\r\nX-Injected: yes\r\n\r\n',
    'GET /index.html HTTP/1.1\r\nHost: x\r\nCookie: ' + 'a'.repeat(8000) + '\r\n\r\n',
  ];
  for (const payload of payloads) {
    const raw = await rawRequest(payload);
    assert.ok(!/ 500 /.test(raw), 'the server answered 500 for: ' + JSON.stringify(payload));
    assertAlive('the raw request');
  }
});

/* ================================================================== *
 * the proxy route
 * ================================================================== */

test('proxy: a private target is refused', async () => {
  const targets = [
    'http://127.0.0.1:' + port + '/index.html',
    'http://localhost:' + port + '/index.html',
    'http://[::1]:' + port + '/index.html',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/x',
    'http://192.168.1.1/x',
    'http://172.16.0.1/x',
  ];
  for (const url of targets) {
    const res = await request({
      method: 'POST',
      path: '/api/llm-forward',
      headers: { 'Content-Type': 'application/json' },
    }, JSON.stringify({ url: url, body: 'x' }));
    assert.ok(res.status !== 0, 'the proxy request for ' + url + ' got no answer');
    assert.ok(res.status !== 200, 'the proxy reached the private target ' + url);
    assertNoInternalError(res, 'the proxy request for ' + url);
    assertAlive('the proxy request');
  }
});

test('proxy: a broken body is refused and the server stays alive', async () => {
  const bodies = [
    '', 'not json', '[]', 'null', '{"url":123}', '{"url":""}', '{"url":"file:///etc/passwd"}',
    '{"url":"http://x","headers":{"a":1}}', '{"url":"http://x","body":{"a":1}}',
    '{"url":"http://x\\u0000y"}', '{"url":"http://x\\r\\nHost: evil"}',
    '{"url":"' + 'a'.repeat(200) + '"}',
  ];
  for (const body of bodies) {
    const res = await request({
      method: 'POST',
      path: '/api/llm-forward',
      headers: { 'Content-Type': 'application/json' },
    }, body);
    assertNoInternalError(res, 'the proxy body ' + JSON.stringify(body).slice(0, 50));
    assertAlive('the proxy body');
  }
});

test('proxy: a body over the limit is refused', async () => {
  const res = await request({
    method: 'POST',
    path: '/api/llm-forward',
    headers: { 'Content-Type': 'application/json' },
  }, JSON.stringify({ url: 'http://example.com', body: 'a'.repeat(2 * 1024 * 1024) }));
  assertNoInternalError(res, 'the big body');
  assertAlive('the big body');
});

test('proxy: a target that fails is answered, and the server stays alive', async () => {
  /* A name that does not resolve, a name with no port, and a name with
   * credentials. Every failure must end in an answer, never in a dead
   * server. */
  const targets = [
    'http://this-name-does-not-exist-at-all.invalid/x',
    'http://example.invalid:99999/x',
    'http://user:pass@example.invalid/x',
  ];
  for (const url of targets) {
    const res = await request({
      method: 'POST',
      path: '/api/llm-forward',
      headers: { 'Content-Type': 'application/json' },
    }, JSON.stringify({ url: url, body: 'x' }));
    assert.ok(res.status !== 0, 'the proxy request for ' + url + ' got no answer');
    assertNoInternalError(res, 'the proxy request for ' + url);
    assertAlive('the proxy request for ' + url);
  }
});

test('proxy: a cross origin request is refused', async () => {
  const res = await request({
    method: 'POST',
    path: '/api/llm-forward',
    headers: { 'Content-Type': 'application/json', 'Origin': 'https://evil.example' },
  }, JSON.stringify({ url: 'http://example.com', body: 'x' }));
  const detail = 'expected 403, got ' + res.status + ' err=' + (res.error || '-') +
    ' body=' + JSON.stringify(res.body).slice(0, 80);
  assert.strictEqual(res.status, 403, detail);
});

/* ================================================================== *
 * the fmt upload
 * ================================================================== */

test('upload: a payload without the magic never reaches the file', async () => {
  const before = fs.readFileSync(fmtTarget);
  const res = await request({
    method: 'POST',
    path: '/api/upload-fmt',
    headers: { 'Content-Type': 'application/octet-stream' },
  }, Buffer.alloc(4096, 0x41));
  assert.strictEqual(res.status, 400, 'expected 400, got ' + res.status);
  assert.ok(fs.readFileSync(fmtTarget).equals(before), 'the target file changed');
  assertAlive('the upload');
});

test('upload: a short payload is refused', async () => {
  const res = await request({
    method: 'POST',
    path: '/api/upload-fmt',
    headers: { 'Content-Type': 'application/octet-stream' },
  }, Buffer.from([0x58, 0x54]));
  assert.strictEqual(res.status, 400, 'expected 400, got ' + res.status);
  assertAlive('the upload');
});

test('upload: a cross origin upload is refused', async () => {
  const payload = Buffer.concat([FMT_MAGIC, Buffer.alloc(2048, 0x43)]);
  const res = await request({
    method: 'POST',
    path: '/api/upload-fmt',
    headers: { 'Content-Type': 'application/octet-stream', 'Origin': 'https://evil.example' },
  }, payload);
  const detail = 'expected 403, got ' + res.status + ' err=' + (res.error || '-') +
    ' body=' + JSON.stringify(res.body).slice(0, 80);
  assert.strictEqual(res.status, 403, detail);
});

test('upload: the slot is free after the fuzzing', async () => {
  const payload = Buffer.concat([FMT_MAGIC, Buffer.alloc(2048, 0x43)]);
  const res = await request({
    method: 'POST',
    path: '/api/upload-fmt',
    headers: { 'Content-Type': 'application/octet-stream' },
  }, payload);
  assert.strictEqual(res.status, 200, 'expected 200, got ' + res.status + ' ' + res.body);
  assert.ok(fs.readFileSync(fmtTarget).equals(payload), 'the target file does not match the upload');
  assert.ok(!fs.existsSync(fmtTarget + '.upload'), 'the temp file leaked');
});

/* ================================================================== *
 * the end state
 * ================================================================== */

test('the server still serves the app after the fuzzing', async () => {
  const res = await request({ path: '/index.html' });
  assert.strictEqual(res.status, 200, 'expected 200, got ' + res.status);
  assert.ok(res.body.indexOf('<html') !== -1, 'the answer is not the page');
  assertAlive('the last request');
});

/* ================================================================== *
 * source tripwires
 *
 * The paths above need a network or a big body to reach. The source keeps
 * the guards that stop them, and the tripwires fail when a guard goes.
 * ================================================================== */

test('source: the proxy keeps the guards of the answer', () => {
  const src = fs.readFileSync(SERVE, 'utf8');
  assert.ok(src.indexOf('LLM_FORWARD_MAX_RESPONSE_BYTES') !== -1, 'the answer cap is gone');
  assert.ok(src.indexOf('readCapped') !== -1, 'the answer cap is not used');
  assert.ok(src.indexOf('if (!res.headersSent)') !== -1, 'the header guard is gone');
  assert.ok(src.indexOf('isPrivateAddress') !== -1, 'the private address check is gone');
  assert.ok(src.indexOf('AbortController') !== -1, 'the upstream timeout is gone');
  assert.ok(src.indexOf('Buffer.concat(chunks)') !== -1, 'the body is decoded per chunk again');
});

test('source: the upload keeps the guards of the file', () => {
  const src = fs.readFileSync(SERVE, 'utf8');
  assert.ok(src.indexOf('UPLOAD_TOTAL_TIMEOUT_MS') !== -1, 'the total upload timer is gone');
  assert.ok(src.indexOf('written !== size') !== -1, 'the size check before the rename is gone');
  assert.ok(src.indexOf('FMT_MAGIC') !== -1, 'the magic check is gone');
});

test('source: the origin check keeps the rebinding guard', () => {
  const src = fs.readFileSync(SERVE, 'utf8');
  assert.ok(src.indexOf('isLoopbackName') !== -1, 'the loopback name check is gone');
  assert.ok(src.indexOf('lookupAddresses') !== -1, 'the address lookup is gone');
});

/* ================================================================== */

(async () => {
  fmtTarget = path.join(os.tmpdir(), 'riki-fuzz-' + process.pid + '.fmt');
  fs.writeFileSync(fmtTarget, Buffer.concat([FMT_MAGIC, Buffer.alloc(4096)]));
  try {
    port = await startServer();
  } catch (err) {
    console.error('SERVE-FUZZ: could not start the server — ' + err.message);
    process.exit(1);
  }
  console.log('serve.js (fuzz) on ' + host + ':' + port);

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

  stopServer();
  try { fs.unlinkSync(fmtTarget); } catch (_) { /* best effort */ }
  try { fs.unlinkSync(fmtTarget + '.upload'); } catch (_) { /* best effort */ }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((err) => { stopServer(); console.error('SERVE-FUZZ-FAIL:', err); process.exit(1); });
