#!/usr/bin/env node
'use strict';

/*
 * Fuzz, differential, and reduction tests for the text layers:
 * src/js/app.js (LaTeX and markdown helpers), src/js/chat.js (the markdown
 * renderer and the history builder), src/js/llm.js (the config layer), and
 * src/js/prompts.js (the prompt builders).
 *
 * The functions come from the source files. The suite never keeps a copy.
 * A moved or renamed function makes the extractor fail loudly.
 *
 * Usage: node test/fuzz_parsers_test.js
 */

const assert = require('assert');
const path = require('path');

const prompts = require('../src/js/prompts.js');
const lib = require('./fuzz_lib.js');

/* The chat bounds the history with the core. The Node build of the core
 * has the same truncation as the browser build. */
globalThis.TellCore = require('@tell-ai/core');
/* The wire of the custom endpoint comes from the sdk. The llm layer reads
 * it from the window, like in the browser. */
globalThis.window = { TellSDK: require('@tell-ai/sdk') };

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'src', 'js', 'app.js');
const CHAT = path.join(ROOT, 'src', 'js', 'chat.js');
const LLM = path.join(ROOT, 'src', 'js', 'llm.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL ' + name);
    console.log('       ' + (err && err.message ? err.message.split('\n').join('\n       ') : err));
  }
}

/* ---- the real functions ---- */

const app = new Function([
  lib.extractConst(APP, 'TEX_END_RE'),
  lib.extractFunctions(APP, [
    'sanitizeFenced', 'sanitizeTex', 'getTexProblem',
    'extractLatexError', 'texHashOf', 'nonEmpty', 'escapeHtml',
    'describeFixFailure',
  ]),
  'return { sanitizeFenced, sanitizeTex, getTexProblem, extractLatexError, texHashOf, nonEmpty, escapeHtml, describeFixFailure };',
].join('\n'))();

const chat = new Function([
  lib.extractConst(CHAT, 'HISTORY_MAX_CHARS'),
  lib.extractConst(CHAT, 'HISTORY_MAX_MESSAGES'),
  lib.extractFunctions(CHAT, [
    'escHtml', 'inlineMd', 'mdLite', 'fieldText',
    'contextParts', 'buildSystem', 'historyText', 'truncateContext', 'serializeHistory',
  ]),
  'return { escHtml, inlineMd, mdLite, contextParts, buildSystem, serializeHistory };',
].join('\n'))();

const llm = new Function([
  lib.extractConst(LLM, 'LLM_VENDORS'),
  lib.extractConst(LLM, 'DEFAULT_URLS'),
  lib.extractFunctions(LLM, ['tellCfg', 'customModelOf', 'customHeadersOf', 'customTextOf', 'customWire', 'cleanAnswer']),
  'return { LLM_VENDORS, DEFAULT_URLS, tellCfg, customModelOf, customHeadersOf, customTextOf, customWire, cleanAnswer };',
].join('\n'))();

/* ---- seeds ---- */

const TEXT_SEEDS = [
  '',
  '   ',
  'plain text',
  '# Heading\nbody',
  '```latex\n\\documentclass{article}\n\\begin{document}\nhi\n\\end{document}\n```',
  '```\ncode\n```',
  '\\documentclass{article}\n\\begin{document}\nhi\n\\end{document}',
  '\\end{document}',
  '\\end{end}',
  'cat > main.tex <<\'EOF\'\npdflatex main.tex\nEOF',
  '<RUN>rm -rf /</RUN>',
  'a'.repeat(500),
  'café 𝔘𝔫𝔦 \uD800',
  '```\n```\n```\n```',
  '**bold** _italic_ `code` [link](https://example.com)',
  '- item\n- item\n1. first',
];

const SECTION_SEEDS = [
  { name: 'Job', lang: 'en', role: 'r', master: 'm', cvOut: 'c', cover: 'x', tex: 't' },
  { name: 'Job', lang: 'pt' },
  { name: 42, lang: 'fr', role: null, master: undefined, cvOut: 5, cover: {}, tex: [] },
  { chat: [{ role: 'user', content: 'x'.repeat(50000), at: 1 }] },
  { chat: [] },
  {},
];

const CONFIG_SEEDS = [
  {},
  { model: 'j', keys: {}, urls: {} },
  { model: 'custom:my-model', keys: { custom: 'k' }, urls: { custom: 'https://x' } },
  { model: 'openrouter:minimax/minimax-m3.1-flash:free', keys: { openrouter: 'k' } },
  { model: 42, keys: 'x', urls: 7 },
  { model: 'custom:', keys: null },
  { customHeaders: '{"a":1}', customApi: 'responses' },
  { customHeaders: 'not json' },
  { customHeaders: '[1,2]' },
  { customHeaders: 'null' },
];

const REPLY_SEEDS = [
  { choices: [{ message: { content: 'hello' } }] },
  { choices: [] },
  { choices: [{ message: {} }] },
  { output: [{ content: [{ text: 'hello' }] }] },
  { output: [] },
  {},
  null,
  'text',
];

/* A field of a hostile value, or nothing. The value can be null. */
function field(value, key) {
  return value && typeof value === 'object' ? value[key] : undefined;
}

/* A text field of a hostile value, or an empty string. */
function textField(value, key) {
  const raw = field(value, key);
  return typeof raw === 'string' ? raw : '';
}

/* ================================================================== *
 * app.js — the LaTeX and markdown helpers
 * ================================================================== */

test('sanitizeFenced: the result never keeps a fence', () => {
  lib.fuzz('sanitizeFenced', TEXT_SEEDS, 400, (input) => {
    const out = app.sanitizeFenced(input);
    assert.strictEqual(typeof out, 'string');
    if (/```/.test(String(input))) {
      assert.ok(!/```/.test(out), 'the fence survived: ' + JSON.stringify(out));
    }
  });
});

test('sanitizeTex: the result is a string without shell noise', () => {
  lib.fuzz('sanitizeTex', TEXT_SEEDS, 400, (input) => {
    const out = app.sanitizeTex(input);
    assert.strictEqual(typeof out, 'string');
    assert.ok(!/<\/?RUN>/i.test(out), 'a run marker survived: ' + JSON.stringify(out));
    assert.ok(!/^[\t ]*pdflatex\b/m.test(out), 'a shell line survived: ' + JSON.stringify(out));
    assert.ok(!/^[\t ]*EOF[\t ]*$/m.test(out), 'a heredoc marker survived: ' + JSON.stringify(out));
  });
});

test('sanitizeTex: a document that passes the check is complete', () => {
  /* The compile step trusts getTexProblem. A tex that passes the check must
   * carry the three parts that pdflatex needs. */
  lib.fuzz('sanitizeTex complete', TEXT_SEEDS, 400, (input) => {
    const out = app.sanitizeTex(input);
    if (app.getTexProblem(out) === null) {
      assert.ok(out.indexOf('\\documentclass') !== -1, 'the preamble is missing');
      assert.ok(out.indexOf('\\begin{document}') !== -1, 'the begin is missing');
      assert.ok(/\\end\s*\{(?:document|end)\}/i.test(out), 'the end is missing');
    }
  });
});

test('getTexProblem: the answer is always a known value', () => {
  const known = ['empty', 'markdown', 'no-documentclass', 'no-begin-document', 'no-end-document'];
  lib.fuzz('getTexProblem', TEXT_SEEDS, 400, (input) => {
    const problem = app.getTexProblem(input);
    if (problem === null) return;
    assert.ok(known.indexOf(problem) !== -1, 'unknown problem: ' + JSON.stringify(problem));
  });
});

test('extractLatexError: the answer is short and never throws', () => {
  lib.fuzz('extractLatexError', TEXT_SEEDS, 400, (input) => {
    const out = app.extractLatexError(input);
    assert.strictEqual(typeof out, 'string');
    assert.ok(out.length <= 300, 'the answer is too long: ' + out.length);
  });
});

test('texHashOf: the hash is stable and short', () => {
  lib.fuzz('texHashOf', SECTION_SEEDS, 300, (input) => {
    const a = app.texHashOf(input);
    const b = app.texHashOf(input);
    assert.strictEqual(a, b, 'the hash changed between two calls');
    assert.strictEqual(typeof a, 'string');
    assert.ok(/^[0-9a-f]+$/.test(a), 'the hash is not hex: ' + a);
  });
});

test('escapeHtml: the angle brackets are gone', () => {
  lib.fuzz('escapeHtml', TEXT_SEEDS, 300, (input) => {
    const out = app.escapeHtml(input);
    assert.ok(out.indexOf('<') === -1, 'a left bracket survived');
    assert.ok(out.indexOf('>') === -1, 'a right bracket survived');
  });
});

test('nonEmpty: only a text with content comes back', () => {
  lib.fuzz('nonEmpty', TEXT_SEEDS, 200, (input) => {
    const out = app.nonEmpty(input);
    assert.strictEqual(typeof out, 'string');
    if (typeof input !== 'string' || !input.trim()) {
      assert.strictEqual(out, '', 'a blank value came back');
    }
  });
});

/* ================================================================== *
 * chat.js — the markdown renderer
 * ================================================================== */

const ALLOWED_TAGS = ['p', 'code', 'strong', 'em', 'a', 'ul', 'li', 'h1', 'h2', 'h3', 'pre'];
const TAG_RE = new RegExp('</?(?:' + ALLOWED_TAGS.join('|') + ')(?:\\s[^>]*)?>', 'gi');

function stripTags(html) {
  return html.replace(TAG_RE, '');
}

test('mdLite: the result has no tag outside the allowed set', () => {
  lib.fuzz('mdLite tags', TEXT_SEEDS, 400, (input) => {
    const out = chat.mdLite(input);
    assert.strictEqual(typeof out, 'string');
    const rest = stripTags(out);
    assert.ok(rest.indexOf('<') === -1, 'a left bracket survived: ' + JSON.stringify(out));
    assert.ok(rest.indexOf('>') === -1, 'a right bracket survived: ' + JSON.stringify(out));
  });
});

test('mdLite: the result has no script and no event handler', () => {
  lib.fuzz('mdLite script', TEXT_SEEDS, 400, (input) => {
    const out = chat.mdLite(input);
    /* The escaped text can hold the words "onerror" or "javascript". Only a
     * real tag matters, so the check runs on the tags of the result. */
    const tags = out.match(/<[^>]*>/g) || [];
    for (const tag of tags) {
      const name = (/^<\/?\s*([a-zA-Z0-9]+)/.exec(tag) || [])[1] || '';
      assert.ok(ALLOWED_TAGS.indexOf(name.toLowerCase()) !== -1, 'unknown tag: ' + tag);
      assert.ok(!/\son[a-z]+\s*=/i.test(tag), 'an event handler survived: ' + tag);
      assert.ok(!/javascript:/i.test(tag), 'a javascript link survived: ' + tag);
    }
  });
});

test('mdLite: the number of code blocks matches the number of fences', () => {
  /* The renderer swaps a code block for a marker and puts it back later. A
   * text that carries the marker itself must not insert a block. */
  lib.fuzz('mdLite blocks', TEXT_SEEDS, 400, (input) => {
    const out = chat.mdLite(input);
    const fences = (String(input).match(/```[\s\S]*?```/g) || []).length;
    const blocks = (out.match(/<pre>/g) || []).length;
    assert.strictEqual(blocks, fences, 'the number of code blocks changed');
  });
});

test('inlineMd: the result has no tag outside the allowed set', () => {
  lib.fuzz('inlineMd', TEXT_SEEDS, 300, (input) => {
    const out = chat.inlineMd(chat.escHtml(input));
    const rest = stripTags(out);
    assert.ok(rest.indexOf('<') === -1, 'a left bracket survived: ' + JSON.stringify(out));
    assert.ok(rest.indexOf('>') === -1, 'a right bracket survived: ' + JSON.stringify(out));
  });
});

test('contextParts: a hostile section never breaks the builder', () => {
  lib.fuzz('contextParts', SECTION_SEEDS, 300, (input) => {
    const parts = chat.contextParts(input);
    assert.ok(Array.isArray(parts), 'the parts are not an array');
    for (const part of parts) {
      assert.strictEqual(typeof part, 'string');
    }
  });
});

test('buildSystem: a hostile section never breaks the builder', () => {
  lib.fuzz('buildSystem', SECTION_SEEDS, 300, (input) => {
    const out = chat.buildSystem(input);
    assert.strictEqual(typeof out, 'string');
    assert.ok(out.length > 0, 'the system prompt is empty');
  });
});

test('serializeHistory: the history stays under the size limit', () => {
  lib.fuzz('serializeHistory', SECTION_SEEDS, 300, (input) => {
    const chat1 = Array.isArray(field(input, 'chat')) ? field(input, 'chat') : [];
    const out = chat.serializeHistory(chat1);
    assert.strictEqual(typeof out, 'string');
    assert.ok(out.length <= 24000, 'the history is too long: ' + out.length);
  });
});

test('serializeHistory: the history uses the turn markers of the core', () => {
  const out = chat.serializeHistory([
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
  ]);
  assert.strictEqual(out, 'User:\nq1\n\nAssistant:\na1');
});

test('serializeHistory: a long history is cut at a turn border', () => {
  const messages = [];
  for (let i = 0; i < 14; i++) {
    messages.push({ role: 'user', content: 'q' + i + ' ' + 'w'.repeat(5000) });
    messages.push({ role: 'assistant', content: 'a' + i + ' ' + 'v'.repeat(5000) });
  }
  const out = chat.serializeHistory(messages);
  assert.ok(out.length <= 24000, 'the history is too long: ' + out.length);
  assert.ok(
    out.indexOf('[older context truncated]') !== -1,
    'the cut has no marker: ' + out.slice(0, 80)
  );
  /* A turn that is cut in the middle leaves a partial run of the filler.
   * Every kept turn holds a whole run. */
  assert.strictEqual((out.match(/w/g) || []).length % 5000, 0, 'a user turn was cut');
  assert.strictEqual((out.match(/v/g) || []).length % 5000, 0, 'an assistant turn was cut');
});

/* ================================================================== *
 * llm.js — the config layer
 * ================================================================== */

test('tellCfg: the result holds only known vendors', () => {
  lib.fuzz('tellCfg', CONFIG_SEEDS, 300, (input) => {
    const cfg = llm.tellCfg(input);
    assert.strictEqual(typeof cfg.model, 'string');
    assert.ok(cfg.model.length > 0, 'the model is empty');
    for (const map of [cfg.keys, cfg.urls]) {
      assert.ok(map && typeof map === 'object', 'the map is not an object');
      for (const key of Object.keys(map)) {
        const known = llm.LLM_VENDORS.indexOf(key) !== -1 || key === 'zhipu';
        assert.ok(known, 'unexpected vendor ' + JSON.stringify(key));
        assert.strictEqual(typeof map[key], 'string', 'the value of ' + key + ' is not a string');
      }
    }
  });
});

test('tellCfg: the result is stable after a second pass', () => {
  lib.fuzz('tellCfg idempotent', CONFIG_SEEDS, 200, (input) => {
    const once = llm.tellCfg(input);
    const twice = llm.tellCfg(once);
    assert.deepStrictEqual(twice, once, 'the second pass changed the value');
  });
});

test('customModelOf: the answer is a name or nothing', () => {
  lib.fuzz('customModelOf', CONFIG_SEEDS, 300, (input) => {
    const name = llm.customModelOf(field(input, 'model'));
    if (name === null) return;
    assert.strictEqual(typeof name, 'string');
    assert.ok(name.length > 0, 'the model name is empty');
  });
});

test('customHeadersOf: the answer is an object or a clear error', () => {
  lib.fuzz('customHeadersOf', CONFIG_SEEDS, 300, (input) => {
    try {
      const out = llm.customHeadersOf(input);
      assert.ok(out && typeof out === 'object' && !Array.isArray(out), 'the headers are not an object');
    } catch (err) {
      assert.ok(err instanceof Error, 'the failure is not an error');
      const known = ['Custom headers are not valid JSON.', 'Custom headers must be a JSON object.'];
      assert.ok(known.indexOf(err.message) !== -1, 'unclear error: ' + err.message);
    }
  });
});

test('customTextOf: the answer is text or a clear error', () => {
  lib.fuzz('customTextOf', REPLY_SEEDS, 300, (input) => {
    for (const api of ['chat', 'responses', 'messages']) {
      try {
        const out = llm.customTextOf(input, api);
        assert.strictEqual(typeof out, 'string');
        assert.ok(out.length > 0, 'the text is empty');
      } catch (err) {
        assert.ok(err instanceof Error, 'the failure is not an error');
        assert.strictEqual(err.message, 'Custom endpoint returned no text.');
      }
    }
  });
});

test('customTextOf: the messages wire reads the content blocks', () => {
  const answer = llm.customTextOf({ content: [{ type: 'text', text: 'hello' }] }, 'messages');
  assert.strictEqual(answer, 'hello');
  assert.throws(() => llm.customTextOf({ content: [] }, 'messages'), /no text/);
});

test('customWire: the pinned wire wins over the model id', () => {
  assert.strictEqual(llm.customWire({ model: 'custom:claude-x', customApi: 'chat' }), 'chat');
  assert.strictEqual(llm.customWire({ model: 'custom:claude-x', customApi: 'responses' }), 'responses');
  assert.strictEqual(llm.customWire({ model: 'custom:claude-x', customApi: 'messages' }), 'messages');
});

test('customWire: the auto mode follows the model id of the sdk', () => {
  assert.strictEqual(llm.customWire({ model: 'custom:gpt-5.4-mini' }), 'responses');
  assert.strictEqual(llm.customWire({ model: 'custom:claude-sonnet-4' }), 'messages');
  assert.strictEqual(llm.customWire({ model: 'custom:llama-3.3-70b' }), 'chat');
});

test('cleanAnswer: a tag that the model left open is cut', () => {
  assert.strictEqual(llm.cleanAnswer('the answer'), 'the answer');
  assert.strictEqual(llm.cleanAnswer('the answer<think>secret'), 'the answer');
  assert.strictEqual(llm.cleanAnswer('the answer</RUN>'), 'the answer');
  assert.strictEqual(llm.cleanAnswer('<think>secret</think> the answer'), '<think>secret</think> the answer');
});

/* ================================================================== *
 * prompts.js — the prompt builders
 * ================================================================== */

test('buildAtsPrompt: the master and the job are in the prompt', () => {
  lib.fuzz('buildAtsPrompt', SECTION_SEEDS, 300, (input) => {
    const master = textField(input, 'master');
    const role = textField(input, 'role');
    const out = prompts.buildAtsPrompt(master, field(input, 'lang'), role);
    assert.strictEqual(typeof out, 'string');
    if (master) assert.ok(out.indexOf(master) !== -1, 'the master is missing');
    if (role) assert.ok(out.indexOf(role) !== -1, 'the job is missing');
  });
});

test('buildCoverPrompt: the cv and the job are in the prompt', () => {
  lib.fuzz('buildCoverPrompt', SECTION_SEEDS, 300, (input) => {
    const cv = textField(input, 'cvOut');
    const role = textField(input, 'role');
    const pitch = textField(input, 'pitch');
    const out = prompts.buildCoverPrompt(cv, field(input, 'lang'), role, pitch);
    assert.strictEqual(typeof out, 'string');
    if (cv) assert.ok(out.indexOf(cv) !== -1, 'the cv is missing');
    if (pitch) assert.ok(out.indexOf(pitch) !== -1, 'the pitch is missing');
  });
});

test('buildTexPrompt: the template and the cv are in the prompt', () => {
  lib.fuzz('buildTexPrompt', SECTION_SEEDS, 300, (input) => {
    const cv = textField(input, 'cvOut');
    const tpl = textField(input, 'template');
    const out = prompts.buildTexPrompt(cv, tpl);
    assert.strictEqual(typeof out, 'string');
    if (tpl) assert.ok(out.indexOf(tpl) !== -1, 'the template is missing');
    if (cv) assert.ok(out.indexOf(cv) !== -1, 'the cv is missing');
  });
});

test('buildFixTexPrompt: the broken tex and the log are in the prompt', () => {
  lib.fuzz('buildFixTexPrompt', SECTION_SEEDS, 300, (input) => {
    const tex = textField(input, 'tex');
    const tpl = textField(input, 'template');
    const out = prompts.buildFixTexPrompt(tex, '! error', tpl);
    assert.strictEqual(typeof out, 'string');
    if (tex) assert.ok(out.indexOf(tex) !== -1, 'the broken tex is missing');
    assert.ok(out.indexOf('! error') !== -1, 'the error log is missing');
  });
});

/* ================================================================== */

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
