#!/usr/bin/env node
'use strict';

/*
 * Integration tests for src/scripts/serve.js — dev server hardening.
 *
 * Boots the real server over real HTTP and asserts the security invariants:
 * path containment, malformed-URL handling, and the write endpoint
 * (/api/upload-fmt) origin/magic/size guards.
 *
 * --no-mirror and --fmt-target keep the run from writing into src/pdftex/.
 *
 * Usage: node test/serve_audit.js
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVE = path.resolve(__dirname, '..', 'src', 'scripts', 'serve.js');
const FMT_MAGIC = Buffer.from([0x58, 0x54, 0x32, 0x57]); // "XT2W", web2c format
const FMT_CAP = 64 * 1024 * 1024;

let passed = 0;
let failed = 0;

/* ---------- tiny test harness ---------- */

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function report_ok(name) {
  passed++;
  console.log('  ok   ' + name);
}

function report_fail(name, err) {
  failed++;
  console.log('  FAIL ' + name);
  console.log('       ' + (err && err.message ? err.message.split('\n').join('\n       ') : err));
}

/* ---------- server control ---------- */

let child = null;
let fmt_target = null;
let current_info = null;
let current_port = 0;

function lan_addresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

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
        resolve({ address: m[1], log: () => out });
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

function request(opts) {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function get(port, url_path, headers) {
  return request({ host: '127.0.0.1', port, path: url_path, method: 'GET', headers: headers || {} });
}

function post(port, url_path, body, headers) {
  return request({
    host: '127.0.0.1',
    port,
    path: url_path,
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/octet-stream', 'Content-Length': body.length }, headers || {}),
    body,
  });
}

function port_of(address) {
  return parseInt(address.slice(address.lastIndexOf(':') + 1), 10);
}

function can_connect(ip, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: ip, port, timeout: 1500 });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
    sock.on('timeout', () => done(false));
  });
}

function reset_fmt() {
  fs.writeFileSync(fmt_target, Buffer.concat([FMT_MAGIC, Buffer.alloc(4096)]));
}

function fmt_bytes() {
  return fs.readFileSync(fmt_target);
}

/* ================================================================== *
 * path containment — static files
 * ================================================================== */

test('static: legitimate files are served', async (port) => {
  for (const p of ['/index.html', '/js/app.js', '/css/app.css', '/data/role.md', '/test.html']) {
    const res = await get(port, p);
    assert.strictEqual(res.status, 200, p + ' -> ' + res.status);
    assert.ok(res.body.length > 0, p + ' is empty');
  }
});

test('static: percent-encoded traversal is rejected, never leaks a file', async (port) => {
  const probes = [
    '/..%2f..%2f..%2f..%2f..%2fetc%2fpasswd',
    '/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '/js/..%2f..%2f..%2fetc%2fpasswd',
    '/test/..%2f..%2f..%2f..%2f..%2fetc%2fpasswd',
  ];
  for (const p of probes) {
    const res = await get(port, p);
    assert.ok(res.status === 403 || res.status === 404, p + ' -> ' + res.status);
    assert.ok(!res.body.toString('utf8').includes('root:'), p + ' leaked /etc/passwd');
  }
});

test('static: malformed percent-escape answers 400, not 500', async (port) => {
  const res = await get(port, '/%zz');
  assert.strictEqual(res.status, 400, 'expected 400, got ' + res.status);
});

test('static: NUL byte in path is rejected', async (port) => {
  const res = await get(port, '/index.html%00.png');
  assert.ok(res.status === 400 || res.status === 404, 'expected 4xx, got ' + res.status);
});

/* ================================================================== *
 * path containment — /pdftex/ resolver
 * ================================================================== */

test('pdftex: traversal basename never escapes WEB_ROOT', async (port) => {
  const probes = [
    '/pdftex/2/..%2f..%2f..%2f..%2f..%2f..%2f..%2fetc%2fpasswd',
    '/pdftex/2/..%2f..%2f..%2f..%2fpackage.json',
    '/pdftex/2/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json',
    '/pdftex/2/..%2f..%2f..%2f..%2f..%2ftmp%2fopencode%2fcanary.txt',
  ];
  for (const p of probes) {
    const res = await get(port, p);
    const text = res.body.toString('utf8');
    assert.ok(res.status !== 200 || text.length === 0, p + ' -> ' + res.status + ' with ' + text.length + ' bytes');
    assert.ok(!text.includes('root:'), p + ' leaked /etc/passwd');
    assert.ok(!text.includes('"rireki-tailor"'), p + ' leaked package.json');
  }
});

test('pdftex: dot-segment basenames are rejected, not served as 200', async (port) => {
  for (const p of ['/pdftex/2/%2e', '/pdftex/2/%2e%2e', '/pdftex/2/%2e%2e%2f', '/pdftex/2/.']) {
    const res = await get(port, p);
    assert.ok(res.status === 400 || res.status === 404, p + ' -> ' + res.status);
  }
});

test('pdftex: missing file still answers 404 or 301, never 500', async (port) => {
  const res = await get(port, '/pdftex/3/definitely-not-a-real-font');
  assert.ok(res.status === 301 || res.status === 404, 'expected 301/404, got ' + res.status);
});

/* ================================================================== *
 * /api/upload-fmt — the write endpoint
 * ================================================================== */

test('upload-fmt: cross-origin POST is refused and the file is untouched', async (port) => {
  reset_fmt();
  const before = fmt_bytes();
  const res = await post(port, '/api/upload-fmt', Buffer.concat([FMT_MAGIC, Buffer.alloc(2048)]), {
    Origin: 'https://evil.example',
  });
  assert.strictEqual(res.status, 403, 'expected 403, got ' + res.status);
  assert.ok(fmt_bytes().equals(before), 'target file was modified by a cross-origin request');
});

test('upload-fmt: payload without the web2c magic is refused', async (port) => {
  reset_fmt();
  const before = fmt_bytes();
  const res = await post(port, '/api/upload-fmt', Buffer.alloc(4096, 0x41));
  assert.strictEqual(res.status, 400, 'expected 400, got ' + res.status);
  assert.ok(fmt_bytes().equals(before), 'target file was modified by an invalid payload');
});

test('upload-fmt: short payload is refused', async (port) => {
  reset_fmt();
  const before = fmt_bytes();
  const res = await post(port, '/api/upload-fmt', FMT_MAGIC);
  assert.strictEqual(res.status, 400, 'expected 400, got ' + res.status);
  assert.ok(fmt_bytes().equals(before), 'target file was modified by a short payload');
});

test('upload-fmt: oversized payload is refused and the file survives', async (port) => {
  reset_fmt();
  const before = fmt_bytes();
  const oversized = Buffer.alloc(FMT_CAP + 4096, 0x42);
  FMT_MAGIC.copy(oversized, 0);
  const res = await post(port, '/api/upload-fmt', oversized);
  assert.strictEqual(res.status, 413, 'expected 413, got ' + res.status);
  assert.ok(fmt_bytes().equals(before), 'target file was truncated by an oversized upload');
});

test('upload-fmt: valid same-origin upload is accepted', async (port) => {
  reset_fmt();
  const payload = Buffer.concat([FMT_MAGIC, Buffer.alloc(2048, 0x43)]);
  const res = await post(port, '/api/upload-fmt', payload, { Origin: 'http://127.0.0.1:' + port });
  assert.strictEqual(res.status, 200, 'expected 200, got ' + res.status + ' ' + res.body.toString().slice(0, 80));
  assert.ok(fmt_bytes().equals(payload), 'target file does not match the uploaded payload');
});

test('upload-fmt: origin on a different port of the same host is refused', async (port) => {
  reset_fmt();
  const before = fmt_bytes();
  const res = await post(port, '/api/upload-fmt', Buffer.concat([FMT_MAGIC, Buffer.alloc(2048)]), {
    Origin: 'http://127.0.0.1:1',
  });
  assert.strictEqual(res.status, 403, 'expected 403, got ' + res.status);
  assert.ok(fmt_bytes().equals(before), 'target file was modified');
});

test('server: a malformed Host header answers 400, not 500', async (port) => {
  const status_line = await new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      sock.write('GET /index.html HTTP/1.1\r\nHost: exa mple\r\nConnection: close\r\n\r\n');
    });
    let data = '';
    sock.on('data', (c) => { data += c.toString(); });
    sock.on('close', () => resolve((data.split('\r\n')[0] || '').trim()));
    sock.on('error', reject);
    setTimeout(() => reject(new Error('no response to the malformed Host header')), 5000);
  });
  assert.ok(status_line.indexOf(' 400') !== -1, 'expected 400, got: ' + status_line);
});

test('upload-fmt: the same-origin check ignores Host/Origin letter case', async (port) => {
  reset_fmt();
  const payload = Buffer.concat([FMT_MAGIC, Buffer.alloc(2048, 0x43)]);
  const res = await request({
    host: '127.0.0.1',
    port,
    path: '/api/upload-fmt',
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': payload.length,
      Host: 'LOCALHOST:' + port,
      Origin: 'http://localhost:' + port,
    },
    body: payload,
  });
  assert.strictEqual(res.status, 200, 'same host with different case must pass, got ' + res.status);
  assert.ok(fmt_bytes().equals(payload), 'target file does not match the uploaded payload');
});

test('pdftex: an unknown format id answers 404 instead of walking TeXLive', async (port) => {
  for (const p of ['/pdftex/999/definitely-not-a-real-file', '/pdftex/2/definitely-not-a-real-file']) {
    const res = await get(port, p);
    if (p.indexOf('/999/') !== -1) {
      assert.strictEqual(res.status, 404, p + ' -> ' + res.status + ' (unknown ids must not reach the resolver)');
    } else {
      assert.ok(res.status === 301 || res.status === 404, p + ' -> ' + res.status);
    }
  }
});

test('server: an invalid --port exits with a clear message', async () => {
  const probed = await new Promise((resolve) => {
    const kid = spawn(process.execPath, [SERVE, '--port', '99999', '--no-mirror', '--fmt-target', fmt_target]);
    let text = '';
    kid.stdout.on('data', (c) => { text += c.toString(); });
    kid.stderr.on('data', (c) => { text += c.toString(); });
    kid.on('exit', (code) => resolve({ code, text }));
    setTimeout(() => { kid.kill('SIGKILL'); resolve({ code: 'timeout', text }); }, 8000);
  });
  assert.notStrictEqual(probed.code, 0, 'server started with --port 99999');
  assert.ok(probed.text.indexOf('invalid --port') !== -1, 'no actionable message, got: ' + probed.text.slice(0, 200));
});

/* ================================================================== *
 * network exposure
 * ================================================================== */

test('server: binds loopback by default, not every interface', async (port) => {
  const lan = lan_addresses();
  for (const ip of lan) {
    const reachable = await can_connect(ip, port);
    assert.ok(!reachable, 'server is reachable on LAN address ' + ip + ':' + port);
  }
});

const wildcard_tests = [
  {
    name: 'server: --host 0.0.0.0 opts back into LAN exposure',
    fn: async (port, info) => {
      assert.ok(info.log().includes('0.0.0.0'), 'startup log does not report the wildcard bind');
    },
  },
];

/* ================================================================== */

async function run(tests_to_run) {
  for (const t of tests_to_run) {
    try {
      await t.fn(current_port, current_info);
      report_ok(t.name);
    } catch (err) {
      report_fail(t.name, err);
    }
  }
}

(async () => {
  fmt_target = path.join(os.tmpdir(), 'riki-audit-' + process.pid + '.fmt');
  reset_fmt();
  try {
    current_info = await start_server();
  } catch (err) {
    console.error('SERVE-AUDIT: could not start server — ' + err.message);
    process.exit(1);
  }
  current_port = port_of(current_info.address);
  console.log('serve.js on ' + current_info.address + ' (fmt target: ' + fmt_target + ')');

  await run(tests);

  stop_server();
  try {
    current_info = await start_server(['--host', '0.0.0.0']);
    current_port = port_of(current_info.address);
    await run(wildcard_tests);
  } catch (err) {
    report_fail(wildcard_tests[0].name, err);
  }

  stop_server();
  try { fs.unlinkSync(fmt_target); } catch (_) { /* best effort */ }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((err) => { stop_server(); console.error('SERVE-AUDIT-FAIL:', err); process.exit(1); });
