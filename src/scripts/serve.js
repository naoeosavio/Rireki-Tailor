#!/usr/bin/env node
'use strict';

/*
 * RirekiTailor Web — dev server + TeXLive mirror resolver
 *
 * Serves src/ statically. Handles the SwiftLaTeX engine's texlive requests
 * (`/pdftex/{kpse_format_id}/{basename}`) by resolving them against a local
 * TeXLive installation (kpathsea-style search) and MIRRORING each resolved
 * file into src/pdftex/{id}/{basename}, so the app becomes
 * fully static/offline-capable after one compile.
 *
 * Usage:
 *   node serve.js [--port 8080] [--host 127.0.0.1] [--texmf /usr/share/texlive/texmf-dist] [--no-mirror]
 *                 [--fmt-target <path>] [--upload-timeout-ms 60000]
 */

const http = require('http');
const dns = require('dns');
const fs = require('fs');
const path = require('path');

const WEB_ROOT = path.resolve(__dirname, '..');
const TEST_ROOT = path.resolve(WEB_ROOT, '..', 'test');
const MIRROR_ROOT = path.join(WEB_ROOT, 'pdftex');

/* fmt written by /api/upload-fmt. A web2c format starts with the
 * "XT2W" magic (0x58543257) — without it the payload is garbage. */
const FMT_MAGIC = Buffer.from([0x58, 0x54, 0x32, 0x57]);
const FMT_MIN_BYTES = 1000;
const FMT_MAX_BYTES = 64 * 1024 * 1024;

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const PORT = (() => {
  const raw = argOf('--port', '8080');
  const v = parseInt(raw, 10);
  /* 0 = ephemeral port (the tests use it); outside 0-65535 is a typo. */
  if (!Number.isInteger(v) || v < 0 || v > 65535) {
    console.error('invalid --port (use 0-65535): ' + raw);
    process.exit(2);
  }
  return v;
})();
/* Loopback by default: the server exposes the entire source tree with open
 * CORS and has a write endpoint. Anyone wanting LAN access must pass
 * --host 0.0.0.0 explicitly. */
const HOST = argOf('--host', '127.0.0.1');
const TEXMF = path.resolve(argOf('--texmf', '/usr/share/texlive/texmf-dist'));
const FMT_TARGET = path.resolve(
  argOf('--fmt-target', path.join(MIRROR_ROOT, '10', 'swiftlatexpdftex.fmt'))
);
/* kpathsea order (Debian texmf.cnf): TEXMFSYSVAR (/var/lib/texmf), TEXMFDEBIAN
 * (/usr/share/texmf), TEXMFDIST. */
const TEXMF_DIRS = [
  path.resolve(argOf('--texmf-extra', '/var/lib/texmf')),
  path.resolve(argOf('--texmf-extra2', '/usr/share/texmf')),
  TEXMF,
];
const MIRROR = !args.includes('--no-mirror');

/* ------------------------------------------------------------------ *
 * kpathsea format ids (texlive-source/texk/kpathsea/types.h, stable)
 * ------------------------------------------------------------------ */
const TEX_SUBROOTS = ['tex/latex', 'tex/generic', 'tex/plain', 'tex/latex-dev', 'tex/context', 'tex/xelatex', 'tex/luatex', 'tex'];
const FORMAT_ROOTS = {
  0: [],                        // gf
  1: [],                        // pk
  3: ['fonts/tfm'],             // tfm
  4: ['fonts/afm'],             // afm
  5: ['fonts/afm'],             // base
  6: ['bibtex/bib'],            // bib
  7: ['bibtex/bst'],            // bst
  8: ['web2c'],                 // cnf
  10: ['web2c', ...TEX_SUBROOTS], // fmt (pdflatex.ini lives under tex/)
  11: ['fonts/map'],            // fontmap
  13: ['fonts/source'],         // mf
  16: ['fonts/source'],         // mp
  18: ['fonts/source'],         // mpsupport
  19: ['fonts/ocp'],            // ocp
  20: ['fonts/ofm'],            // ofm
  21: ['fonts/opl'],            // opl
  22: ['fonts/otp'],            // otp
  23: ['fonts/ovf'],            // ovf
  24: ['fonts/ovp'],            // ovp
  25: [...TEX_SUBROOTS, 'fonts'], // pict
  26: TEX_SUBROOTS,             // tex
  29: TEX_SUBROOTS,             // texsource
  30: ['fonts/type1', 'dvips'], // tex_ps_header
  31: ['fonts/type1'],          // troff_font
  32: ['fonts/type1'],          // type1
  33: ['fonts/vf'],             // vf
  34: ['dvips'],                // dvips_config
  35: ['makeindex'],            // ist
  36: ['fonts/truetype'],       // truetype
  38: ['web2c'],                // web2c
  41: ['fonts'],                // miscfonts
  44: ['fonts/enc'],            // enc
  45: ['fonts/cmap'],           // cmap
  47: ['fonts/opentype'],       // opentype
  49: ['fonts/lig'],            // lig
};
const DEFAULT_ROOTS = [...TEX_SUBROOTS, 'fonts', 'web2c', 'bibtex', 'makeindex', 'dvips'];

/* fix_extension: the wasm (kpseemu.c) appends the format's extension to the
 * name locally and sends the ORIGINAL name to JS; we replicate that here. */
const FORMAT_EXT = {
  0: '.gf', 1: '.pk', 3: '.tfm', 4: '.afm', 5: '.base', 6: '.bib', 7: '.bst',
  10: '.fmt', 11: '.map', 12: '.mem', 13: '.mf', 15: '.mft', 16: '.mp',
  17: '.pool', 19: '.ocp', 20: '.ofm', 21: '.opl', 22: '.otp', 23: '.ovf',
  24: '.ovp', 25: '.esp', 26: '.tex', 28: '.pool', 29: '.dtx', 31: '.pfa',
  32: '.pfa', 33: '.vf', 35: '.ist', 36: '.ttf', 37: '.t42', 44: '.enc',
  45: '', 47: '.otf', 48: '.cfg', 49: '.lig', 52: '.fea', 53: '.cid',
  54: '.mlbib', 55: '.mlbst', 57: '.ris', 58: '.bltxml',
};

/* Real kpathsea format ids (the enum in texlive-source/texk/kpathsea/types.h
 * covered by FORMAT_ROOTS + FORMAT_EXT). Ids outside this set never come from
 * the engine: answering 404 directly avoids sweeping the TeXLive tree for
 * nothing (N roots per request, synchronous, blocking the loop — any page the
 * dev visits could trigger it via CORS *). */
const KNOWN_FORMAT_IDS = new Set(
  Object.keys(FORMAT_ROOTS).concat(Object.keys(FORMAT_EXT)).map((k) => parseInt(k, 10))
);

function withExtension(formatId, basename) {
  if (basename.includes('.')) return basename;
  const ext = FORMAT_EXT[formatId];
  return ext ? basename + ext : basename;
}

function rootsForFormat(id) {
  return FORMAT_ROOTS[id] ?? DEFAULT_ROOTS;
}

/* ------------------------------------------------------------------ *
 * basename index (lazy per-root, memoized)
 * ------------------------------------------------------------------ */
const dirCache = new Map(); // root -> Promise<Map>

/* The tree has more than 100000 files. The sweep runs with the async API:
 * the sync version blocked the event loop for 10 seconds, and every other
 * request of the server waited behind it. */
async function buildIndex(rootRel) {
  if (dirCache.has(rootRel)) return dirCache.get(rootRel);
  const promise = (async () => {
    const index = new Map();
    for (const texmfDir of TEXMF_DIRS) {
      const rootAbs = path.join(texmfDir, rootRel);
      if (!fs.existsSync(rootAbs)) continue;
      const stack = [rootAbs];
      while (stack.length) {
        const dir = stack.pop();
        let entries;
        try {
          entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : 1));
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory() && !e.isSymbolicLink()) stack.push(full);
          else if ((e.isFile() || e.isSymbolicLink()) && !index.has(e.name)) index.set(e.name, full);
        }
      }
    }
    return index;
  })();
  dirCache.set(rootRel, promise);
  return promise;
}

async function resolveFile(formatId, basename) {
  for (const rootRel of rootsForFormat(formatId)) {
    const index = await buildIndex(rootRel);
    const hit = index.get(basename);
    if (hit) return hit;
  }
  return null;
}

/* The index builds in the background from the start. The first request finds
 * it ready in most cases. The roots build one after the other: the tree has
 * more than 100000 files, and 30 walks at the same time slow the machine. */
function prebuildIndex() {
  const roots = new Set([...Object.values(FORMAT_ROOTS).flat(), ...DEFAULT_ROOTS]);
  (async () => {
    for (const rootRel of roots) {
      try {
        await buildIndex(rootRel);
      } catch (err) {
        console.error('[texlive] index failed for ' + rootRel + ': ' + err.message);
      }
    }
  })();
}

/* ------------------------------------------------------------------ *
 * request-path hygiene (single containment invariant, shared by every
 * route that turns a URL segment into a filesystem path)
 * ------------------------------------------------------------------ */

/* Percent-decode rejecting malformed escapes and NUL bytes; null = bad. */
function decodePathSegment(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch (_) {
    return null;
  }
  return decoded.indexOf('\u0000') === -1 ? decoded : null;
}

/* Resolve segments under root or null — never returns a sibling path such
 * as /x/src-evil when root is /x/src. */
function resolveInside(root, ...segments) {
  const abs = path.normalize(path.join(root, ...segments));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/* kpathsea basenames are single, non-dot path segments. Rejecting "." and
 * ".." also keeps a directory from ever reaching pipeFile(). */
function isPlainBasename(name) {
  if (!name || name === '.' || name === '..') return false;
  return !/[\\/\u0000]/.test(name);
}

/* Browsers always send Origin on cross-origin writes, so refusing a
 * mismatched Origin is enough to stop CSRF. Absent Origin (curl, the
 * bootstrap page, the test suite) is a same-origin request.
 *
 * The Origin is compared with the Host header of the request. A name that
 * points at this machine is refused: such a name is a DNS rebinding attack.
 * The page runs in the browser of the developer and reaches the dev server
 * through a public name, so the Host and the Origin match each other. */
function isLoopbackName(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (/^127\./.test(h)) return true;
  return false;
}

/* A private, loopback, or link-local address. */
function isPrivateAddress(address) {
  const a = String(address || '').toLowerCase();
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true;
  if (a.startsWith('fe80') || a.startsWith('fc') || a.startsWith('fd')) return true;
  if (a.startsWith('::ffff:')) return isPrivateAddress(a.slice(7));
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return false;
  const n = m.slice(1).map(Number);
  if (n[0] === 127 || n[0] === 10 || n[0] === 0) return true;
  if (n[0] === 172 && n[1] >= 16 && n[1] <= 31) return true;
  if (n[0] === 192 && n[1] === 168) return true;
  if (n[0] === 169 && n[1] === 254) return true;
  return false;
}

/* The addresses of a name. An empty list means the name does not resolve. */
function lookupAddresses(hostname) {
  return new Promise((resolve) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err || !addrs || !addrs.length) {
        resolve([]);
        return;
      }
      resolve(addrs.map((a) => a.address));
    });
  });
}

async function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch (_) {
    return false;
  }
  const host = String(req.headers.host || '');
  /* DNS is case-insensitive: LOCALHOST and localhost are the same host.
   * Without the toLowerCase, a legitimate same-origin request with different
   * casing got a 403. */
  if (!host || parsed.host.toLowerCase() !== host.toLowerCase()) return false;
  if (isLoopbackName(parsed.hostname)) return true;
  const addresses = await lookupAddresses(parsed.hostname);
  if (!addresses.length) return true;
  return !addresses.some((address) => isPrivateAddress(address));
}

/* ------------------------------------------------------------------ *
 * mirror
 * ------------------------------------------------------------------ */
function mirrorFile(formatId, basename, absPath) {
  if (!MIRROR) return;
  const target = resolveInside(MIRROR_ROOT, String(formatId), basename);
  if (!target) return;
  if (fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(absPath, target);
  console.log(`[mirror] +pdftex/${formatId}/${basename}  <-  ${absPath}`);
}

/* ------------------------------------------------------------------ *
 * static file serving
 * ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.md': 'text/markdown; charset=utf-8',
  '.tex': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* Stream -> response, with cleanup: if the client aborts, destroy the stream
 * (releasing fd/buffers); a read error destroys the response instead of
 * bringing down the process. Without this, repeated aborts leak memory/fds
 * on the server. */
function pipeFile(res, file) {
  const stream = fs.createReadStream(file);
  stream.on('error', (err) => {
    console.error('[stream] read error', file, '-', err.message);
    res.destroy();
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function sendStatic(req, res, urlPath) {
  let rel = decodePathSegment(urlPath);
  if (rel === null) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request');
    return;
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const isTest = rel === '/test.html' || rel.startsWith('/test/');
  const base = isTest ? TEST_ROOT : WEB_ROOT;
  const relToBase = rel.startsWith('/test/') ? rel.slice('/test'.length) : rel;
  const abs = resolveInside(base, relToBase);
  if (!abs) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
    return;
  }
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    pipeFile(res, abs);
  });
}

/* ------------------------------------------------------------------ *
 * http server
 * ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ *
 * POST /api/upload-fmt — writes the .fmt generated in the browser.
 *
 * An unauthenticated write endpoint, so it needs an origin guard (CSRF),
 * payload validation and a size limit. The body goes to a temp file and
 * only replaces the target via rename: an aborted or gigantic upload never
 * leaves a truncated .fmt, and RAM never holds the payload.
 * ------------------------------------------------------------------ */
let fmtUploadBusy = false;

/* An upload stuck while the slot is busy locks the endpoint for everyone
 * (there is only 1 upload at a time). The timer dies on its own after 60 s
 * with no data — without it, a slowloris or a close without 'aborted' would
 * hold the 409 forever. */
const UPLOAD_TIMEOUT_MS = (() => {
  const v = parseInt(argOf('--upload-timeout-ms', '60000'), 10);
  return Number.isFinite(v) && v > 0 ? v : 60000;
})();

/* The idle timer restarts on every chunk, so a client that sends one byte
 * per minute holds the slot for ever. The total timer ends the upload. */
const UPLOAD_TOTAL_TIMEOUT_MS = (() => {
  const v = parseInt(argOf('--upload-total-timeout-ms', '300000'), 10);
  return Number.isFinite(v) && v > 0 ? v : 300000;
})();

/* Forward a custom LLM call so endpoints without CORS headers work from
 * the browser. Same-origin POST only, http(s) targets only, 1 MB cap.
 *
 * The target must be a public address. The proxy runs on the machine of the
 * developer, so an open proxy reaches the local network and the cloud
 * metadata of the host. */
const LLM_FORWARD_MAX_BYTES = 1024 * 1024;
const LLM_FORWARD_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const LLM_FORWARD_TIMEOUT_MS = 30000;

/* The framing and routing headers of the upstream request. A client must not
 * set them: they belong to the connection, not to the message. */
const LLM_FORWARD_DENIED_HEADERS = [
  'host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive',
  'upgrade', 'te', 'trailer', 'expect', 'proxy-authorization',
  'proxy-connection', 'forwarded', 'x-forwarded-for', 'x-forwarded-host',
];

function forwardHeaders(headers) {
  const out = { 'Content-Type': 'application/json' };
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return out;
  for (const name of Object.keys(headers)) {
    const value = headers[name];
    if (typeof value !== 'string') continue;
    if (LLM_FORWARD_DENIED_HEADERS.indexOf(name.toLowerCase()) !== -1) continue;
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue;
    out[name] = value;
  }
  return out;
}

/* The body of the upstream answer, with a cap. An answer without a limit
 * fills the memory of the server. */
async function readCapped(res, max) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    total += step.value.length;
    if (total > max) {
      await reader.cancel();
      throw new Error('the upstream answer is too large');
    }
    parts.push(step.value);
  }
  return Buffer.concat(parts).toString('utf8');
}

/* Read the rest of the request and drop it. The answer goes out after the
 * body: a server that answers while the body is still on the way closes the
 * connection, and the client sees a reset instead of the answer. */
function drainRequest(req, maxMs) {
  if (req.readableEnded || req.complete) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      req.destroy();
      resolve();
    }, maxMs || 2000);
    const done = () => { clearTimeout(timer); resolve(); };
    req.on('end', done);
    req.on('error', done);
    req.on('close', done);
    req.resume();
  });
}

async function handleLlmForward(req, res) {
  if (req.method !== 'POST') {
    await drainRequest(req);
    res.writeHead(405, { Allow: 'POST' }).end();
    return;
  }
  if (!(await isSameOrigin(req))) {
    await drainRequest(req);
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Origin not allowed');
    return;
  }
  const chunks = [];
  let size = 0;
  let settled = false;
  const reject = (code, message) => {
    if (settled) return;
    settled = true;
    res.writeHead(code, { 'Content-Type': 'text/plain' }).end(message);
  };
  req.on('data', (chunk) => {
    if (settled) return;
    size += chunk.length;
    if (size > LLM_FORWARD_MAX_BYTES) {
      /* The answer closes the connection. A hard reset would break the
       * keep-alive socket of the client, and the next request of that
       * client would fail. */
      settled = true;
      res.writeHead(413, { 'Content-Type': 'text/plain', Connection: 'close' }).end('Request too large');
      drainRequest(req, 2000);
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', async () => {
    if (settled) return;
    settled = true;
    /* The body arrives in several chunks. Decoding every chunk on its own
     * breaks a multi-byte character that sits on a chunk border. */
    const raw = Buffer.concat(chunks).toString('utf8');
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch (_) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad JSON');
      return;
    }
    const target = payload && typeof payload.url === 'string' ? payload.url : '';
    if (!/^https?:\/\//i.test(target)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad URL');
      return;
    }
    let parsedTarget = null;
    try {
      parsedTarget = new URL(target);
    } catch (_) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad URL');
      return;
    }
    if (parsedTarget.username || parsedTarget.password) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad URL');
      return;
    }
    const addresses = await lookupAddresses(parsedTarget.hostname);
    if (addresses.some((address) => isPrivateAddress(address))) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Target not allowed');
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_FORWARD_TIMEOUT_MS);
    try {
      const upstream = await fetch(parsedTarget.toString(), {
        method: 'POST',
        headers: forwardHeaders(payload.headers),
        body: typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body),
        /* A redirect can point at a private address. The app never needs a
         * redirect for an LLM endpoint. */
        redirect: 'manual',
        signal: controller.signal,
      });
      const text = await readCapped(upstream, LLM_FORWARD_MAX_RESPONSE_BYTES);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: upstream.status, text: text }));
    } catch (err) {
      /* The headers are already sent when the answer breaks during the
       * copy. A second writeHead throws and ends the process. */
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' }).end('Upstream failed');
      } else {
        res.end();
      }
      console.error('[llm-forward] ' + (err && err.message ? err.message : 'error'));
    } finally {
      clearTimeout(timer);
    }
  });
  req.on('error', () => reject(500, 'Request failed'));
}

async function handleFmtUpload(req, res) {
  if (req.method !== 'POST') {
    await drainRequest(req);
    res.writeHead(405, { Allow: 'POST' }).end();
    return;
  }
  if (!(await isSameOrigin(req))) {
    await drainRequest(req);
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Origin not allowed');
    return;
  }
  if (fmtUploadBusy) {
    await drainRequest(req);
    res.writeHead(409, { 'Content-Type': 'text/plain' }).end('Another upload in progress');
    return;
  }
  fmtUploadBusy = true;

  const tmpPath = FMT_TARGET + '.upload';
  const sink = fs.createWriteStream(tmpPath, { flags: 'w' });
  let size = 0;
  let head = Buffer.alloc(0);
  let settled = false;
  let idle = null;
  let total = null;
  const clearIdle = () => { if (idle !== null) { clearTimeout(idle); idle = null; } };
  const clearTotal = () => { if (total !== null) { clearTimeout(total); total = null; } };

  const discard = () => {
    clearIdle();
    clearTotal();
    sink.destroy();
    try { fs.unlinkSync(tmpPath); } catch (_) { /* already removed */ }
    fmtUploadBusy = false;
  };
  const reject = (code, message) => {
    if (settled) return;
    settled = true;
    clearIdle();
    discard();
    res.writeHead(code, { 'Content-Type': 'text/plain' }).end(message);
  };
  const commit = () => {
    if (settled) return;
    settled = true;
    clearIdle();
    clearTotal();
    sink.end(() => {
      /* The write can fail after the last chunk: a full disk or a file
       * limit ends the stream with an error. The temp file is then short,
       * and the rename would put a broken format in place of the good one. */
      let written = -1;
      try {
        written = fs.statSync(tmpPath).size;
      } catch (_) {
        written = -1;
      }
      if (written !== size) {
        console.error('[fmt] write incomplete: ' + written + ' of ' + size + ' bytes');
        discard();
        res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Failed to write the fmt');
        return;
      }
      try {
        fs.mkdirSync(path.dirname(FMT_TARGET), { recursive: true });
        fs.renameSync(tmpPath, FMT_TARGET);
      } catch (err) {
        console.error('[fmt] write failed:', err.message);
        discard();
        res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Failed to write the fmt');
        return;
      }
      fmtUploadBusy = false;
      console.log(`[mirror] fmt gravado: ${FMT_TARGET} (${size} bytes)`);
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    });
  };

  sink.on('error', (err) => {
    console.error('[fmt] write error:', err.message);
    reject(500, 'Failed to write the fmt');
  });
  const armIdle = () => {
    clearIdle();
    idle = setTimeout(() => {
      reject(408, 'Upload expired with no data');
      setImmediate(() => req.destroy());
    }, UPLOAD_TIMEOUT_MS);
  };
  /* The upload ends after this time, even when the client keeps sending. */
  total = setTimeout(() => {
    reject(408, 'Upload expired');
    setImmediate(() => req.destroy());
  }, UPLOAD_TOTAL_TIMEOUT_MS);
  req.on('data', (chunk) => {
    if (settled) return;
    armIdle();
    size += chunk.length;
    if (head.length < FMT_MAGIC.length) {
      head = Buffer.concat([head, chunk]).subarray(0, FMT_MAGIC.length);
    }
    if (size > FMT_MAX_BYTES) {
      settled = true;
      clearIdle();
      clearTotal();
      res.writeHead(413, { 'Content-Type': 'text/plain', Connection: 'close' }).end('Payload too large');
      discard();
      drainRequest(req, 2000);
      return;
    }
    sink.write(chunk);
  });
  req.on('end', () => {
    if (settled) return;
    if (size < FMT_MIN_BYTES) { reject(400, 'Invalid payload'); return; }
    if (!head.equals(FMT_MAGIC)) { reject(400, 'Payload does not look like a web2c fmt'); return; }
    commit();
  });
  /* aborted upload: drop the temp file immediately, without waiting for GC */
  req.on('aborted', () => { settled = true; discard(); });
  /* 'aborted' does not always fire (server timeout, half-open): a 'close'
   * without settle frees the slot the same way, without touching the
   * response. */
  req.on('close', () => {
    if (settled) return;
    settled = true;
    discard();
  });
  armIdle();
}

/* ------------------------------------------------------------------ *
 * http server
 * ------------------------------------------------------------------ */
const server = http.createServer((req, res) => {
  /* The handler is async. A rejection that nobody catches ends the process
   * on Node 15 and later, so the promise gets a catch here. */
  Promise.resolve()
    .then(() => handle(req, res))
    .catch((err) => {
      console.error('handler error:', err && err.message ? err.message : err);
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    });
});

async function handle(req, res) {
  /* A malformed Host (or a strange request-target) breaks the URL parser:
   * that is a bad request (400), never an internal error (500). */
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request');
    return;
  }
  const m = url.pathname.match(/^\/pdftex\/(pk\/)?(\d+)\/([^/]+)$/);

  if (m) {
    const isPk = Boolean(m[1]);
    const formatId = parseInt(m[2], 10);
    const rawBasename = m[3];
    if (isPk) {
      res.writeHead(301, { 'Access-Control-Allow-Origin': '*' }).end();
      return;
    }
    if (!KNOWN_FORMAT_IDS.has(formatId)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Unknown format');
      return;
    }
    /* The URL parser's pathname keeps %2f, so the segment must be decoded
     * AND validated: without this, "..%2f..%2f" would become traversal. */
    const basename = decodePathSegment(rawBasename);
    if (basename === null || !isPlainBasename(basename)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad basename');
      return;
    }
    const fileId = withExtension(formatId, basename);
    const abs = await resolveFile(formatId, fileId);
    const mirrored = resolveInside(MIRROR_ROOT, String(formatId), fileId);
    if (!abs && !(mirrored && fs.existsSync(mirrored))) {
      console.log(`[texlive] MISS pdftex/${formatId}/${basename}`);
      res.writeHead(process.env.TEXLIVE_404 ? 404 : 301, { 'Access-Control-Allow-Origin': '*' }).end();
      return;
    }
    const serveFile = (file, tag) => {
      console.log(`[texlive] ${tag} pdftex/${formatId}/${basename}  <-  ${file}`);
      const headers = {
        'Content-Type': 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      };
      if (!process.env.TEXLIVE_NO_FILEID) headers['fileid'] = fileId;
      res.writeHead(200, headers);
      pipeFile(res, file);
    };
    if (!abs) {
      serveFile(mirrored, 'MIRRORED');
      return;
    }
    mirrorFile(formatId, fileId, abs);
    serveFile(abs, 'HIT');
    return;
  }

  if (url.pathname === '/api/upload-fmt') {
    await handleFmtUpload(req, res);
    return;
  }

  if (url.pathname === '/api/llm-forward') {
    await handleLlmForward(req, res);
    return;
  }

  if (url.pathname === '/__texmf') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ texmf: TEXMF, mirror: MIRROR, mirrorRoot: MIRROR_ROOT }));
    return;
  }

  sendStatic(req, res, url.pathname);
}

server.listen(PORT, HOST, () => {
  const addr = server.address();
  const shown = addr.family === 'IPv6' ? '[' + addr.address + ']' : addr.address;
  console.log(`listening: ${shown}:${addr.port}`);
  console.log(`RirekiTailor web: http://${HOST}:${PORT}`);
  console.log(`TeXLive root:    ${TEXMF}`);
  console.log(`Mirror mode:     ${MIRROR ? 'ON (files copied into src/pdftex/)' : 'OFF'}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    console.warn(`WARN: listening on ${HOST} — any host on the network can read the source and write into src/pdftex/.`);
  }
  if (!fs.existsSync(TEXMF)) {
    console.warn(`WARN: ${TEXMF} does not exist. Use --texmf <dir>`);
  }
  /* The TeXLive index builds in the background. The first request does not
   * wait for the sweep of the whole tree. */
  prebuildIndex();
});
