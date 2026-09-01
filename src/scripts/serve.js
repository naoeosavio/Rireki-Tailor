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
 *   node serve.js [--port 8080] [--texmf /usr/share/texlive/texmf-dist] [--no-mirror]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const WEB_ROOT = path.resolve(__dirname, '..');
const TEST_ROOT = path.resolve(WEB_ROOT, '..', 'test');
const MIRROR_ROOT = path.join(WEB_ROOT, 'pdftex');

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const PORT = parseInt(argOf('--port', '8080'), 10);
const TEXMF = path.resolve(argOf('--texmf', '/usr/share/texlive/texmf-dist'));
/* Ordem kpathsea (texmf.cnf Debian): TEXMFSYSVAR (/var/lib/texmf), TEXMFDEBIAN
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

/* fix_extension: o wasm (kpseemu.c) anexa a extensao do formato ao nome
 * localmente e envia o nome ORIGINAL ao JS; replicamos aqui. */
const FORMAT_EXT = {
  0: '.gf', 1: '.pk', 3: '.tfm', 4: '.afm', 5: '.base', 6: '.bib', 7: '.bst',
  10: '.fmt', 11: '.map', 12: '.mem', 13: '.mf', 15: '.mft', 16: '.mp',
  17: '.pool', 19: '.ocp', 20: '.ofm', 21: '.opl', 22: '.otp', 23: '.ovf',
  24: '.ovp', 25: '.esp', 26: '.tex', 28: '.pool', 29: '.dtx', 31: '.pfa',
  32: '.pfa', 33: '.vf', 35: '.ist', 36: '.ttf', 37: '.t42', 44: '.enc',
  45: 'cmap', 47: '.otf', 48: '.cfg', 49: '.lig', 52: '.fea', 53: '.cid',
  54: '.mlbib', 55: '.mlbst', 57: '.ris', 58: '.bltxml',
};

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
 * mirror
 * ------------------------------------------------------------------ */
function mirrorFile(formatId, basename, absPath) {
  if (!MIRROR) return;
  const target = path.join(MIRROR_ROOT, String(formatId), basename);
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

/* Stream -> resposta, com cleanup: se o cliente abortar, destrói o stream
 * (libera fd/buffers); erro de leitura destrói a resposta em vez de derrubar
 * o processo. Sem isso, aborts repetidos vazam memória/fds no server. */
function pipeFile(res, file) {
  const stream = fs.createReadStream(file);
  stream.on('error', (err) => {
    console.error('[stream] erro lendo', file, '-', err.message);
    res.destroy();
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function sendStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const isTest = rel === '/test.html' || rel.startsWith('/test/');
  const base = isTest ? TEST_ROOT : WEB_ROOT;
  let file = rel;
  if (rel.startsWith('/test/')) file = rel.slice('/test'.length);
  let abs = path.normalize(path.join(base, file));
  const root = base;
  if (!abs.startsWith(root)) {
    res.writeHead(403).end('Forbidden');
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
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const m = url.pathname.match(/^\/pdftex\/(pk\/)?(\d+)\/([^/]+)$/);

  if (m) {
    const isPk = Boolean(m[1]);
    const formatId = parseInt(m[2], 10);
    const basename = m[3];
    if (isPk) {
      res.writeHead(301, { 'Access-Control-Allow-Origin': '*' }).end();
      return;
    }
    const abs = resolveFile(formatId, withExtension(formatId, basename));
    const mirrored = path.join(WEB_ROOT, 'pdftex', String(formatId), withExtension(formatId, basename));
    const fileId = withExtension(formatId, basename);
    if (!abs && !fs.existsSync(mirrored)) {
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
    mirrorFile(formatId, basename, abs);
    serveFile(abs, 'HIT');
    return;
  }

  if (url.pathname === '/api/upload-fmt') {
    const MAX_FMT = 128 * 1024 * 1024; // fmt real ~40MB; headroom p/ abusos
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_FMT) {
        done = true;
        chunks.length = 0;
        res.writeHead(413).end('Payload grande demais');
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const buf = Buffer.concat(chunks);
      chunks.length = 0;
      const target = path.join(WEB_ROOT, 'pdftex', '10', 'swiftlatexpdftex.fmt');
      if (!buf.length || buf.length < 1000) {
        res.writeHead(400).end('Payload invalido');
        return;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf);
      console.log(`[mirror] fmt gravado: ${target} (${buf.length} bytes)`);
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    });
    /* upload abortado: solta os buffers na hora, sem esperar o GC */
    req.on('aborted', () => { done = true; chunks.length = 0; });
    req.on('close', () => { done = true; chunks.length = 0; });
    return;
  }

  if (url.pathname === '/__texmf') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ texmf: TEXMF, mirror: MIRROR, mirrorRoot: MIRROR_ROOT }));
    return;
  }

  sendStatic(req, res, url.pathname);
}

server.listen(PORT, () => {
  console.log(`RirekiTailor web: http://localhost:${PORT}`);
  console.log(`TeXLive root:    ${TEXMF}`);
  console.log(`Mirror mode:     ${MIRROR ? 'ON (arquivos copiados para src/pdftex/)' : 'OFF'}`);
  if (!fs.existsSync(TEXMF)) {
    console.warn(`WARN: ${TEXMF} nao existe. Use --texmf <dir>`);
  }
});
