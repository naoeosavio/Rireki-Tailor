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
  45: 'cmap', 47: '.otf', 48: '.cfg', 49: '.lig', 52: '.fea', 53: '.cid',
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
const dirCache = new Map(); // root -> { name -> absPath | null }

function buildIndex(rootRel) {
  if (dirCache.has(rootRel)) return dirCache.get(rootRel);
  const index = new Map();
  for (const texmfDir of TEXMF_DIRS) {
    const rootAbs = path.join(texmfDir, rootRel);
    if (!fs.existsSync(rootAbs)) continue;
    const stack = [rootAbs];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !e.isSymbolicLink()) stack.push(full);
        else if ((e.isFile() || e.isSymbolicLink()) && !index.has(e.name)) index.set(e.name, full);
      }
    }
  }
  dirCache.set(rootRel, index);
  return index;
}

function resolveFile(formatId, basename) {
  for (const rootRel of rootsForFormat(formatId)) {
    const hit = buildIndex(rootRel).get(basename);
    if (hit) return hit;
  }
  return null;
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
 * bootstrap page, the test suite) is a same-origin request. */
function isSameOrigin(req) {
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
  return host !== '' && parsed.host.toLowerCase() === host.toLowerCase();
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

function handleFmtUpload(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' }).end();
    return;
  }
  if (!isSameOrigin(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Origin not allowed');
    return;
  }
  if (fmtUploadBusy) {
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
  const clearIdle = () => { if (idle !== null) { clearTimeout(idle); idle = null; } };

  const discard = () => {
    clearIdle();
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
    sink.end(() => {
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
  req.on('data', (chunk) => {
    if (settled) return;
    armIdle();
    size += chunk.length;
    if (head.length < FMT_MAGIC.length) {
      head = Buffer.concat([head, chunk]).subarray(0, FMT_MAGIC.length);
    }
    if (size > FMT_MAX_BYTES) {
      reject(413, 'Payload too large');
      setImmediate(() => req.destroy());
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
  try {
    handle(req, res);
  } catch (err) {
    console.error('handler error:', err.message);
    if (!res.headersSent) res.writeHead(500).end();
    else res.end();
  }
});

function handle(req, res) {
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
    const abs = resolveFile(formatId, fileId);
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
    handleFmtUpload(req, res);
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
});
