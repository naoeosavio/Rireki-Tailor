// Node builtin stubs for the tell-ai SDK bundle in the browser.
// The AI-SDK auth-config helpers require('path'|'fs'|'os') at module scope;
// these stubs make them loadable. We always pass explicit apiKey/baseURL,
// so the auth helpers are never actually exercised.
window.require = function (name) {
  var base = {
    os: { platform: function () { return 'browser'; }, homedir: function () { return '/'; }, tmpdir: function () { return '/tmp'; }, arch: function () { return 'x64'; }, EOL: '\n', hostname: function () { return 'browser'; }, userInfo: function () { return { username: 'user' }; } },
    path: { join: function () { return Array.prototype.join.call(arguments, '/'); }, resolve: function () { return Array.prototype.join.call(arguments, '/'); }, dirname: function () { return '.'; }, basename: function (p) { return String(p).split('/').pop(); }, extname: function () { return ''; }, sep: '/', normalize: function (p) { return p; }, relative: function () { return ''; }, isAbsolute: function () { return false; }, parse: function () { return {}; } },
    fs: { readFileSync: function () { return ''; }, writeFileSync: function () {}, existsSync: function () { return false; }, mkdirSync: function () {}, readdirSync: function () { return []; }, statSync: function () { return { isFile: function () { return false; }, isDirectory: function () { return false; } }; }, unlinkSync: function () {}, rmSync: function () {}, realpathSync: function (p) { return p; } },
    crypto: { createHash: function () { return { update: function () { return { digest: function () { return ''; } }; } }; }, randomBytes: function (n) { return new Uint8Array(n); } },
    buffer: { Buffer: { isBuffer: function () { return false; }, from: function () { return []; } } },
    stream: {},
    url: { fileURLToPath: function (u) { return u; }, pathToFileURL: function (p) { return p; } },
    http: {}, https: {}, zlib: {}, events: {},
  }[name] || {};
  return new Proxy(base, {
    get: function (t, p) { return (typeof p === 'string' && p !== 'then') ? (t[p] || (t[p] = function () { return {}; })) : undefined; },
    ownKeys: function (t) { return Object.keys(t); },
    getOwnPropertyDescriptor: function (t, p) { return { configurable: true, enumerable: true, value: t[p] }; },
  });
};
window.process = { env: {}, platform: 'browser', versions: {}, cwd: function () { return '/'; }, arch: 'x64' };
