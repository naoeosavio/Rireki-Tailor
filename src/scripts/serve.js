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

/* fmt gravado por /api/upload-fmt. O formato web2c comeca com a magic
 * "XT2W" (0x58543257) — sem ela o payload e' lixo. */
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
  /* 0 = porta efêmera (os testes usam); fora de 0-65535 é erro de digitação. */
  if (!Number.isInteger(v) || v < 0 || v > 65535) {
    console.error('invalid --port (use 0-65535): ' + raw);
    process.exit(2);
  }
  return v;
})();
/* Loopback por padrao: o servidor expoe o fonte inteiro com CORS aberto e
 * tem um endpoint de escrita. Quem quiser acesso pela LAN passa
 * --host 0.0.0.0 explicitamente. */
const HOST = argOf('--host', '127.0.0.1');
const TEXMF = path.resolve(argOf('--texmf', '/usr/share/texlive/texmf-dist'));
const FMT_TARGET = path.resolve(
  argOf('--fmt-target', path.join(MIRROR_ROOT, '10', 'swiftlatexpdftex.fmt'))
);
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

/* Ids de formato kpathsea reais (o enum de texlive-source/texk/kpathsea/types.h
 * coberto por FORMAT_ROOTS + FORMAT_EXT). Ids fora daqui nunca vêm do engine:
 * responder 404 direto evita varrer a árvore TeXLive à toa (N raízes por
 * request, síncrono, bloqueando o loop — qualquer página visitada pelo dev
 * poderia disparar via CORS *). */
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
  /* DNS é case-insensitive: LOCALHOST e localhost são o mesmo host. Sem o
   * toLowerCase, um same-origin legítimo com caixa diferente tomava 403. */
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
 * POST /api/upload-fmt — grava o .fmt gerado no browser.
 *
 * Endereco de escrita sem autenticacao, entao precisa de guarda de origem
 * (CSRF), validacao de payload e limite de tamanho. O corpo vai para um
 * arquivo temporario e so substitui o alvo via rename: um upload abortado
 * ou gigante nunca deixa o .fmt truncado, e a RAM nao segura o payload.
 * ------------------------------------------------------------------ */
let fmtUploadBusy = false;

/* Upload parado com o slot ocupado trava o endpoint para todo mundo (só há
 * 1 upload por vez). O timer morre sozinho em 60 s sem dados — sem ele, um
 * slowloris ou um close sem 'aborted' segurava o 409 para sempre. */
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
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Origem nao permitida');
    return;
  }
  if (fmtUploadBusy) {
    res.writeHead(409, { 'Content-Type': 'text/plain' }).end('Outro upload em andamento');
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
    try { fs.unlinkSync(tmpPath); } catch (_) { /* ja removido */ }
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
        console.error('[fmt] falha ao gravar:', err.message);
        discard();
        res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Falha ao gravar o fmt');
        return;
      }
      fmtUploadBusy = false;
      console.log(`[mirror] fmt gravado: ${FMT_TARGET} (${size} bytes)`);
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    });
  };

  sink.on('error', (err) => {
    console.error('[fmt] erro de escrita:', err.message);
    reject(500, 'Falha ao gravar o fmt');
  });
  const armIdle = () => {
    clearIdle();
    idle = setTimeout(() => {
      reject(408, 'Upload expirou sem dados');
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
      reject(413, 'Payload grande demais');
      setImmediate(() => req.destroy());
      return;
    }
    sink.write(chunk);
  });
  req.on('end', () => {
    if (settled) return;
    if (size < FMT_MIN_BYTES) { reject(400, 'Payload invalido'); return; }
    if (!head.equals(FMT_MAGIC)) { reject(400, 'Payload nao parece um fmt web2c'); return; }
    commit();
  });
  /* upload abortado: solta o temporario na hora, sem esperar o GC */
  req.on('aborted', () => { settled = true; discard(); });
  /* 'aborted' nem sempre dispara (timeout do servidor, half-open): o 'close'
   * sem settle libera o slot do mesmo jeito, sem tocar na resposta. */
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
  /* Host malformado (ou request-target estranha) quebra o parser de URL:
   * isso é request ruim (400), nunca erro interno (500). */
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
    /* O pathname do URL parser mantem %2f, entao o segmento precisa ser
     * decodificado E validado: sem isso, "..%2f..%2f" viraria traversal. */
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
  console.log(`Mirror mode:     ${MIRROR ? 'ON (arquivos copiados para src/pdftex/)' : 'OFF'}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    console.warn(`WARN: escutando em ${HOST} — qualquer host da rede pode ler o fonte e escrever em src/pdftex/.`);
  }
  if (!fs.existsSync(TEXMF)) {
    console.warn(`WARN: ${TEXMF} nao existe. Use --texmf <dir>`);
  }
});
