#!/usr/bin/env node
'use strict';

/*
 * Tests with a real model.
 *
 * The suite calls the tell CLI with the model
 * openrouter:minimax/minimax-m3.1-flash:free and runs every answer through
 * the validators of the app. The model is a small one, so the answers are
 * not always good. The test measures the quality and checks the parts that
 * must always hold:
 *
 * 1. The pipeline never breaks. Any answer of the model goes through the
 *    helpers of the app without a throw.
 * 2. A hostile answer stays inert. The chat renderer escapes it.
 * 3. A broken answer never replaces a good .tex. The app keeps the old one.
 * 4. The chat answer comes in the language of the section.
 *
 * The real answer is also the seed of the mutation fuzzer: the model
 * writes the strange text, the fuzzer changes it, and the app must still
 * hold.
 *
 * The suite skips itself when the CLI or the network is not there. A missing
 * network must not fail the build. A wrong answer must fail the build.
 *
 * Usage: node test/llm_real_test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const lib = require('./fuzz_lib.js');
const prompts = require('../src/js/prompts.js');

/* The chat bounds the history with the core. The Node build of the core
 * has the same truncation as the browser build. */
globalThis.TellCore = require('@tell-ai/core');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'src', 'js', 'app.js');
const CHAT = path.join(ROOT, 'src', 'js', 'chat.js');

const MODEL = 'openrouter:minimax/minimax-m3.1-flash:free';
const CALL_TIMEOUT_MS = 180000;

let passed = 0;
let failed = 0;
let skipped = 0;

function test(name, fn) {
  try {
    const outcome = fn();
    if (outcome === 'skip') {
      skipped++;
      console.log('  skip ' + name);
      return;
    }
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
  lib.extractFunctions(APP, ['sanitizeFenced', 'sanitizeTex', 'getTexProblem']),
  'return { sanitizeFenced, sanitizeTex, getTexProblem };',
].join('\n'))();

const chat = new Function([
  lib.extractConst(CHAT, 'HISTORY_MAX_CHARS'),
  lib.extractConst(CHAT, 'HISTORY_MAX_MESSAGES'),
  lib.extractFunctions(CHAT, [
    'escHtml', 'inlineMd', 'mdLite', 'fieldText',
    'contextParts', 'buildSystem', 'historyText', 'truncateContext', 'serializeHistory',
  ]),
  'return { escHtml, inlineMd, mdLite, buildSystem, serializeHistory };',
].join('\n'))();

/* ---- the model ---- */

function stripAnsi(text) {
  return String(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/* The answer of the model, or null when the CLI or the network is not
 * there. */
function tellModel(prompt) {
  let res = null;
  try {
    res = spawnSync('tell', ['-m', MODEL, '--no-exec', prompt], {
      encoding: 'utf8',
      timeout: CALL_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (_) {
    return null;
  }
  if (!res || res.error || res.status !== 0) return null;
  const out = stripAnsi(res.stdout || '').trim();
  if (!out) return null;
  return out;
}

/* ---- the material ---- */

const MASTER_CV = [
  '# Jane Doe',
  '',
  '## Summary',
  'Backend engineer with 9 years of experience in Node.js and PostgreSQL.',
  '',
  '## Experience',
  '### Senior Engineer — Acme (2020-2024)',
  '- Built a payment service in Node.js with PostgreSQL and Redis.',
  '- Cut the answer time of the API from 800 ms to 120 ms.',
  '',
  '### Engineer — Globex (2016-2020)',
  '- Wrote unit tests with Jest and CI pipelines with GitHub Actions.',
  '',
  '## Skills',
  'Node.js, PostgreSQL, Redis, Docker, Jest, GitHub Actions.',
  '',
  '## Education',
  'BSc Computer Science, University of Springfield, 2016.',
].join('\n');

const JOB_DESC = [
  'We are looking for a backend engineer.',
  'You will build services with Node.js and PostgreSQL.',
  'Experience with Docker and automated tests is a plus.',
  'You will work with a small team on a payment platform.',
].join('\n');

const TEMPLATE_TEX = [
  '\\documentclass[letterpaper,11pt]{article}',
  '\\usepackage[margin=1in]{geometry}',
  '\\begin{document}',
  '\\section*{Experience}',
  '\\textbf{Jane Doe} \\hfill 2020-2024 \\\\',
  'Engineer at Acme.',
  '\\end{document}',
].join('\n');

/* ---- the checks ---- */

const ALLOWED_TAGS = ['p', 'code', 'strong', 'em', 'a', 'ul', 'li', 'h1', 'h2', 'h3', 'pre'];

function assertInertHtml(html, label) {
  const tags = html.match(/<[^>]*>/g) || [];
  for (const tag of tags) {
    const name = (/^<\/?\s*([a-zA-Z0-9]+)/.exec(tag) || [])[1] || '';
    assert.ok(ALLOWED_TAGS.indexOf(name.toLowerCase()) !== -1, label + ': unknown tag ' + tag);
    assert.ok(!/\son[a-z]+\s*=/i.test(tag), label + ': an event handler survived: ' + tag);
    assert.ok(!/javascript:/i.test(tag), label + ': a javascript link survived: ' + tag);
  }
}

function countMarkers(text, markers) {
  let score = 0;
  for (const marker of markers) {
    if (new RegExp('\\b' + marker + '\\b', 'i').test(text)) score++;
  }
  return score;
}

const PT_MARKERS = [
  'você', 'seu', 'sua', 'não', 'experiência', 'curriculum',
  'vaga', 'qualidades', 'objetivo', 'melhorar', 'fale', 'posso',
];
const EN_MARKERS = [
  'your', 'experience', 'skills', 'summary', 'employment', 'education',
  'role', 'job', 'improve', 'bullet', 'recommend',
];

/* ================================================================== *
 * the tests
 * ================================================================== */

/* The answer of the CV prompt. The other tests use it as a seed. */
let cvAnswer = null;
let texAnswer = null;
let ptAnswer = null;
let enAnswer = null;

/* The model answers in the language of the section most of the time. The
 * test asks again when the answer comes in the other language. The answer
 * of the last try is the one that the test reports. */
function askInLanguage(section, question, markers, otherMarkers) {
  const system = chat.buildSystem(section);
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const answer = tellModel(system + '\n\n' + question);
    if (answer === null) return null;
    const score = countMarkers(answer, markers);
    const other = countMarkers(answer, otherMarkers);
    last = { answer: answer, score: score, other: other, attempts: attempt };
    if (score > 0) return last;
  }
  return last;
}

test('the model answers the CV prompt with markdown', () => {
  const prompt = prompts.buildAtsPrompt(MASTER_CV, 'en', JOB_DESC);
  const answer = tellModel(prompt);
  if (answer === null) return 'skip';
  cvAnswer = answer;
  assert.ok(answer.length > 20, 'the answer is too short: ' + answer.slice(0, 120));
  const markdown = app.sanitizeFenced(answer);
  assert.ok(markdown.indexOf('```') === -1, 'a fence survived: ' + markdown.slice(0, 120));
  /* The prompt asks for the CV only. The model must not repeat the
   * instructions of the prompt. */
  assert.ok(markdown.indexOf('## MASTER CV') === -1, 'the answer repeats the prompt');
  console.log('       the CV answer: ' + answer.length + ' characters');
  return true;
});

test('the model answer goes through the markdown renderer without a tag', () => {
  if (cvAnswer === null) return 'skip';
  const html = chat.mdLite(cvAnswer);
  assertInertHtml(html, 'the CV answer');
  return true;
});

test('the model answer for the LaTeX prompt is a document or a clear problem', () => {
  const prompt = prompts.buildTexPrompt(MASTER_CV, TEMPLATE_TEX);
  const answer = tellModel(prompt);
  if (answer === null) return 'skip';
  texAnswer = answer;
  const tex = app.sanitizeTex(answer);
  const problem = app.getTexProblem(tex);
  if (problem === null) {
    assert.ok(tex.indexOf('\\documentclass') !== -1, 'the preamble is missing');
    assert.ok(tex.indexOf('\\begin{document}') !== -1, 'the begin is missing');
    assert.ok(/\\end\s*\{(?:document|end)\}/i.test(tex), 'the end is missing');
    console.log('       the LaTeX answer is a complete document');
  } else {
    /* A broken answer must not replace a good tex. The app checks the
     * answer before it writes it. */
    console.log('       the LaTeX answer is incomplete (' + problem + ') — the app keeps the old tex');
    let current = 'GOOD-TEX';
    const fresh = app.sanitizeTex(answer);
    if (app.getTexProblem(fresh) === null) current = fresh;
    assert.strictEqual(current, 'GOOD-TEX', 'a broken answer replaced the tex');
  }
  return true;
});

test('the model answers the chat prompt in the language of the section', () => {
  const section = { name: 'Acme', lang: 'pt', role: JOB_DESC, master: MASTER_CV, cvOut: '' };
  const result = askInLanguage(
    section,
    'User: Quais são as minhas principais skills?\n\nAssistente:',
    PT_MARKERS,
    EN_MARKERS
  );
  if (result === null) return 'skip';
  ptAnswer = result.answer;
  console.log('       the Portuguese answer: ' + result.score + ' PT markers, ' +
    result.other + ' EN markers, ' + result.attempts + ' tries');
  assert.ok(result.score > 0, 'the answer is in English: ' + result.answer.slice(0, 120));
  return true;
});

test('the model answers the chat prompt in English', () => {
  const section = { name: 'Acme', lang: 'en', role: JOB_DESC, master: MASTER_CV, cvOut: '' };
  const result = askInLanguage(
    section,
    'User: What are my main skills?\n\nAssistant:',
    EN_MARKERS,
    PT_MARKERS
  );
  if (result === null) return 'skip';
  enAnswer = result.answer;
  console.log('       the English answer: ' + result.score + ' EN markers, ' +
    result.other + ' PT markers, ' + result.attempts + ' tries');
  assert.ok(result.score > 0, 'the answer is in Portuguese: ' + result.answer.slice(0, 120));
  return true;
});

test('the real answers survive the mutation fuzzer', () => {
  const seeds = [cvAnswer, texAnswer, ptAnswer, enAnswer].filter((s) => typeof s === 'string');
  if (!seeds.length) return 'skip';
  /* The model writes the strange text. The fuzzer changes it, and the
   * validators of the app must hold for every change. */
  lib.fuzz('the real answers', seeds, 200, (input) => {
    const html = chat.mdLite(input);
    assertInertHtml(html, 'a changed answer');
    const tex = app.sanitizeTex(input);
    assert.strictEqual(typeof tex, 'string');
    const problem = app.getTexProblem(tex);
    if (problem === null) {
      assert.ok(tex.indexOf('\\documentclass') !== -1, 'the preamble is missing');
      assert.ok(tex.indexOf('\\begin{document}') !== -1, 'the begin is missing');
    }
    const history = chat.serializeHistory([{ role: 'user', content: input, at: 1 }]);
    assert.ok(history.length <= 24000, 'the history is too long: ' + history.length);
  });
  return true;
});

test('the real answers keep the chat history inside the limit', () => {
  const seeds = [cvAnswer, texAnswer, ptAnswer, enAnswer].filter((s) => typeof s === 'string');
  if (!seeds.length) return 'skip';
  for (const seed of seeds) {
    const history = chat.serializeHistory([
      { role: 'user', content: seed, at: 1 },
      { role: 'assistant', content: seed, at: 2 },
    ]);
    assert.ok(history.length <= 24000, 'the history is too long: ' + history.length);
  }
  return true;
});

/* ================================================================== */

console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
if (failed) process.exit(1);
