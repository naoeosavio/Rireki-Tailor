#!/usr/bin/env node
'use strict';

/*
 * Unit tests for task-003 (Fix with LLM): src/js/prompts.js →
 * buildFixTexPrompt, plus the pure tex helpers living in src/js/app.js
 * (sanitizeFenced, sanitizeTex, getTexProblem, extractLatexError).
 *
 * prompts.js is required directly (it guards module.exports like store.js).
 * app.js runs as a browser IIFE with no exports, so the helpers are
 * extracted from the real source (balanced top-level markers) and
 * evaluated — never copied. If a helper moves or is renamed, the
 * extractor throws and the suite fails loudly instead of testing a stale
 * copy. A final section asserts the Step-3 wiring exists in index.html
 * and app.js.
 *
 * Usage: node test/fixtex_test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const prompts = require('../src/js/prompts.js');

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

/* Loads the real helpers out of src/js/app.js (see header). */
function loadAppHelpers() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'js', 'app.js'), 'utf8');
  const endRe = /\n  (?:async function|function|const|let|var) /g;
  function take(name) {
    const marker = '\n  function ' + name + '(';
    const start = src.indexOf(marker);
    assert.ok(start !== -1, 'helper marker not found: ' + name);
    endRe.lastIndex = start + marker.length;
    const m = endRe.exec(src);
    assert.ok(m, 'helper end not found: ' + name);
    return src.slice(start, m.index) + '\n';
  }
  const texEndLine = src.split('\n').find((l) => l.startsWith('  const TEX_END_RE ='));
  assert.ok(texEndLine, 'TEX_END_RE line not found');
  const body = [
    texEndLine,
    take('sanitizeFenced'),
    take('sanitizeTex'),
    take('getTexProblem'),
    take('extractLatexError'),
    take('describeFixFailure'),
    'return { sanitizeFenced, sanitizeTex, getTexProblem, extractLatexError, describeFixFailure };',
  ].join('\n');
  return new Function(body)();
}

const tex = loadAppHelpers();

const VALID_TEX = [
  '\\documentclass[letterpaper,11pt]{article}',
  '\\begin{document}',
  'Hello world.',
  '\\end{document}',
].join('\n');

/* ================================================================== *
 * buildFixTexPrompt
 * ================================================================== */

test('buildFixTexPrompt: embeds the broken tex and the error log', () => {
  const out = prompts.buildFixTexPrompt('BROKEN-BODY', '! Something broke', '');
  assert.strictEqual(typeof out, 'string');
  assert.ok(out.includes('BROKEN-BODY'), 'broken tex missing');
  assert.ok(out.includes('! Something broke'), 'error log missing');
});

test('buildFixTexPrompt: includes the template section when given', () => {
  const out = prompts.buildFixTexPrompt('BROKEN', '! err', 'TEMPLATE-PREAMBLE');
  assert.ok(out.includes('TEMPLATE-PREAMBLE'), 'template missing');
  assert.ok(out.includes('LATEX TEMPLATE'), 'template header missing');
});

test('buildFixTexPrompt: omits the template block when empty', () => {
  for (const tpl of ['', '   ', null, undefined]) {
    const out = prompts.buildFixTexPrompt('BROKEN', '! err', tpl);
    assert.ok(!out.includes('LATEX TEMPLATE'), 'template block leaked for ' + JSON.stringify(tpl));
    assert.ok(out.includes('BROKEN'), 'broken tex lost for ' + JSON.stringify(tpl));
  }
});

test('buildFixTexPrompt: demands complete .tex output only', () => {
  const out = prompts.buildFixTexPrompt('BROKEN', '! err', '');
  assert.ok(/Output ONLY the complete/i.test(out), 'ONLY .tex rule missing');
  assert.ok(out.includes('\\documentclass'), 'documentclass requirement missing');
  assert.ok(out.includes('\\begin{document}'), 'begin-document requirement missing');
  assert.ok(out.includes('\\end{document}'), 'end-document requirement missing');
  assert.ok(out.includes('preamble'), 'preamble rule missing');
});

/* ================================================================== *
 * getTexProblem
 * ================================================================== */

test('getTexProblem: empty input is empty', () => {
  assert.strictEqual(tex.getTexProblem(''), 'empty');
  assert.strictEqual(tex.getTexProblem('   \n  '), 'empty');
  assert.strictEqual(tex.getTexProblem(null), 'empty');
  assert.strictEqual(tex.getTexProblem(undefined), 'empty');
});

test('getTexProblem: markdown headings are markdown', () => {
  assert.strictEqual(tex.getTexProblem('# Professional Summary\nbody'), 'markdown');
  assert.strictEqual(tex.getTexProblem('### Skills\n- x'), 'markdown');
});

test('getTexProblem: text without a preamble is no-documentclass', () => {
  assert.strictEqual(tex.getTexProblem('just some text'), 'no-documentclass');
  assert.strictEqual(tex.getTexProblem(42), 'no-documentclass');
});

test('getTexProblem: preamble without begin is no-begin-document', () => {
  assert.strictEqual(tex.getTexProblem('\\documentclass{article}\nhello'), 'no-begin-document');
});

test('getTexProblem: body without end is no-end-document', () => {
  assert.strictEqual(
    tex.getTexProblem('\\documentclass{article}\n\\begin{document}\nhello'),
    'no-end-document'
  );
});

test('getTexProblem: a complete document is null', () => {
  assert.strictEqual(tex.getTexProblem(VALID_TEX), null);
});

/* ================================================================== *
 * extractLatexError
 * ================================================================== */

test('extractLatexError: no input or no bangs is empty', () => {
  assert.strictEqual(tex.extractLatexError(null), '');
  assert.strictEqual(tex.extractLatexError(''), '');
  assert.strictEqual(tex.extractLatexError('Output written on main.pdf (3 pages).'), '');
});

test('extractLatexError: surfaces the bang line', () => {
  const log = 'l.1 # foo\n! You can\'t use `macro parameter character #\'.\nl.1 # foo\n';
  const got = tex.extractLatexError(log);
  assert.ok(got.includes('! You can\'t use'), 'bang line missing: ' + got);
});

test('extractLatexError: appends a detail line but not the l.N line', () => {
  const log = '! Package babel Error: Unknown option.\n(babel) extra detail\nl.5 \\usepackage\n';
  const got = tex.extractLatexError(log);
  assert.ok(got.includes('(babel) extra detail'), 'detail line missing: ' + got);
  const log2 = '! Something broke.\nl.12 \\bad\n';
  assert.ok(!tex.extractLatexError(log2).includes('l.12'), 'location line leaked in');
});

test('extractLatexError: caps at three errors and 300 chars', () => {
  const log = ['! a', '! b', '! c', '! d'].join('\n');
  const got = tex.extractLatexError(log);
  assert.ok(got.includes('! a') && got.includes('! c'), 'first three missing: ' + got);
  assert.ok(got.indexOf('! d') === -1, 'fourth error leaked: ' + got);
  const long = '! ' + 'x'.repeat(500);
  assert.ok(tex.extractLatexError(long).length <= 300, 'length cap broken');
});

/* ================================================================== *
 * sanitizeFenced / sanitizeTex
 * ================================================================== */

test('sanitizeFenced: extracts fenced content, identity otherwise', () => {
  assert.strictEqual(tex.sanitizeFenced('```latex\n\\documentclass{a}\n```'), '\\documentclass{a}');
  assert.strictEqual(tex.sanitizeFenced('plain'), 'plain');
});

test('sanitizeTex: markdown without a preamble passes through trimmed', () => {
  assert.strictEqual(tex.sanitizeTex('  # Professional Summary\nbody  '), '# Professional Summary\nbody');
  assert.strictEqual(tex.sanitizeTex(null), '');
});

test('sanitizeTex: strips fences and shell wrappers', () => {
  const raw = [
    '```latex',
    'cat > main.tex <<\'EOF\'',
    'pdflatex main.tex',
    '\\documentclass{article}',
    '\\begin{document}',
    'hi',
    '\\end{document}',
    'EOF',
    '```',
  ].join('\n');
  const got = tex.sanitizeTex(raw);
  assert.ok(got.includes('\\documentclass{article}'), 'preamble lost: ' + got);
  assert.ok(!got.includes('pdflatex'), 'shell line leaked: ' + got);
  assert.ok(!got.includes('EOF'), 'heredoc marker leaked: ' + got);
  assert.ok(!got.includes('<RUN>'), 'run marker leaked');
});

test('sanitizeTex: slices from documentclass and normalizes the end', () => {
  const raw = 'chatter\n\\documentclass{article}\n\\begin{document}\nhi\n\\end{document}\ntrailer';
  const got = tex.sanitizeTex(raw);
  assert.ok(got.startsWith('\\documentclass{article}'), 'prefix not sliced: ' + got);
  assert.ok(got.trimEnd().endsWith('\\end{document}'), 'end not normalized: ' + got);
  assert.ok(!got.includes('trailer'), 'trailer leaked: ' + got);
});

test('sanitizeTex: a complete valid document survives intact', () => {
  const got = tex.sanitizeTex(VALID_TEX);
  assert.ok(got.includes('\\begin{document}') && got.trimEnd().endsWith('\\end{document}'), got);
});

/* ================================================================== *
 * describeFixFailure
 * ================================================================== */

test('describeFixFailure: empty raw reply names the empty reply', () => {
  for (const raw of ['', '   ', null, undefined]) {
    const msg = tex.describeFixFailure(raw, 'empty');
    assert.ok(msg.status.includes('empty reply'), 'wrong status: ' + msg.status);
    assert.ok(msg.toast.includes('Empty model reply'), 'wrong toast: ' + msg.toast);
  }
});

test('describeFixFailure: markdown output points at Convert', () => {
  for (const p of ['markdown', 'no-documentclass']) {
    const msg = tex.describeFixFailure('# Title', p);
    assert.ok(msg.status.includes('Convert to LaTeX'), 'wrong status: ' + msg.status);
  }
});

test('describeFixFailure: truncated output keeps the retry advice', () => {
  const msg = tex.describeFixFailure('\\documentclass{x}', 'no-end-document');
  assert.ok(msg.status.includes('no-end-document'), 'problem missing: ' + msg.status);
  assert.ok(msg.toast.includes('truncated'), 'truncate word missing: ' + msg.toast);
});

/* ================================================================== *
 * Step-3 wiring tripwires (index.html + app.js source)
 * ================================================================== */

test('wiring: the Fix with LLM button exists in the PDF card', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  assert.ok(html.includes('id="btn-fix-tex"'), 'btn-fix-tex missing');
  assert.ok(html.includes('Fix with LLM'), 'button label missing');
});

test('wiring: app.js routes the button through generate(fixTex)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'js', 'app.js'), 'utf8');
  assert.ok(src.includes("addEventListener('click', () => generate(fixTex"), 'button wiring missing');
  assert.ok(src.includes('buildFixTexPrompt(broken, errTail'), 'fix prompt call missing');
  assert.ok(src.includes('.slice(-FIX_LOG_TAIL)'), 'log tail cap missing');
  assert.ok(src.includes('extractLatexError(res.log)'), 'compile error surfacing missing');
});

/* ================================================================== *
 * Task-005 lifecycle tripwires (app.js + serve.js source)
 * ================================================================== */

test('lifecycle: section switch and fix success consume the error', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'js', 'app.js'), 'utf8');
  const clears = src.split("lastCompileError = '';").length - 1;
  assert.ok(clears >= 3, 'expected switch/fix/compile clears, found ' + clears);
  assert.ok(src.includes('belongs to the previous section'), 'switch rationale comment missing');
});

test('lifecycle: stored errors are capped and carry no tex dump', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'js', 'app.js'), 'utf8');
  const caps = src.split('slice(-FIX_LOG_TAIL)').length - 1;
  assert.ok(caps >= 2, 'expected store+send caps, found ' + caps);
  assert.ok(!src.includes('Current CV.tex:'), 'tex dump still stored');
});

test('lifecycle: toTex keeps the previous tex on bad output', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'js', 'app.js'), 'utf8');
  assert.ok(src.includes('const fresh = sanitizeTex'), 'validate-before-assign missing');
  assert.ok(!src.includes('s.tex = sanitizeTex(await tellChat(buildTexPrompt'), 'clobber pattern back');
});

test('lifecycle: fixTex falls back to local diagnosis without a log', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'js', 'app.js'), 'utf8');
  assert.ok(src.includes("'Pre-validation (' + cur"), 'fallback missing');
  assert.ok(!src.includes('there is no error log to fix from yet'), 'dead-end toast back');
});

test('lifecycle: dead sanitizers are gone, markdown detect allows indent', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'js', 'app.js'), 'utf8');
  assert.ok(!src.includes('function sanitizeEol'), 'sanitizeEol back');
  assert.ok(!src.includes('function sanitizeLatexBody'), 'sanitizeLatexBody back');
  assert.ok(src.includes('^\\s*#{1,6}'), 'indented heading not detected');
});

test('lifecycle: generate() refuses concurrent runs', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'js', 'app.js'), 'utf8');
  assert.ok(src.includes('let opBusy = false'), 'opBusy flag missing');
  assert.ok(src.includes('if (opBusy)'), 'reentrancy guard missing');
});

test('lifecycle: serve.js leaves extensionless cmaps alone', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'scripts', 'serve.js'), 'utf8');
  assert.ok(src.includes("45: ''"), 'cmap ext fix missing');
});

/* ================================================================== */

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
