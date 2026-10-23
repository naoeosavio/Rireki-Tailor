'use strict';

/*
 * Fuzz engine for the test suite.
 *
 * The engine has four parts: a deterministic random source, a mutator that
 * builds hostile values, a shrinker that reduces a failing value to a small
 * case, and a runner that calls a check function and reports the reduction.
 *
 * The random source has a fixed seed. A failure must reproduce on every run.
 */

const assert = require('assert');
const fs = require('fs');

const SEED = 0x5eed1234;
const MAX_DEPTH = 6;
const MAX_SHRINK_STEPS = 400;

/* ---- deterministic random ---- */

let rngState = SEED;

function randNext() {
  /* mulberry32: small, fast, and stable across Node versions. */
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function randInt(n) {
  return Math.floor(randNext() * n);
}

function pick(list) {
  return list[randInt(list.length)];
}

function resetRandom(seed) {
  rngState = (seed >>> 0) || SEED;
}

/* ---- hostile values ---- */

const SCALAR_POOL = [
  null, undefined, true, false, 0, -0, 1, -1, NaN, Infinity, -Infinity,
  1e308, 2 ** 53, Number.MAX_SAFE_INTEGER, 0.1, 1e-7,
  '', ' ', 'x', 'name', 'role', 'chat', 'id', 'lang', 'en', 'pt',
  '__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty',
  'a"]', 'a]b', 'm1', 's1', 'riki.sections', 'riki.config', 'riki.active',
  '\u0000', '\u0000B0\u0000', '\uD800', '\uDC00', '\uD800\uDC00', '�',
  'café', '𝔘𝔫𝔦', 'a'.repeat(200),
  '<script>alert(1)</script>', '"><img src=x onerror=alert(1)>',
  '```latex\n\\documentclass{a}\n```', '# Heading', '\\end{document}',
];

const KEY_POOL = [
  'name', 'role', 'master', 'lang', 'masterId', 'template', 'templateId',
  'pitch', 'genCover', 'cvOut', 'cover', 'tex', 'texHash', 'coverTex',
  'coverTexHash', 'chat', 'updatedAt',
  'id', 'content', 'keys', 'urls', 'model', 'customApi', 'customHeaders',
  'setupDone', 'masters', 'templates', '__proto__', 'constructor', 'toString',
  'valueOf', '0', '1', '', ' ', 'a b', 'a"b',
];

/* A deep copy that keeps own properties, including an own "__proto__". */
function cloneValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneValue);
  const out = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
  for (const key of Object.keys(value)) {
    Object.defineProperty(out, key, {
      value: cloneValue(value[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, {
    value: value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function mutateNode(value, depth) {
  if (depth > MAX_DEPTH) return pick(SCALAR_POOL);
  const roll = randInt(100);
  if (roll < 18) return pick(SCALAR_POOL);
  if (Array.isArray(value)) {
    if (roll < 30 && value.length) {
      value.splice(randInt(value.length), 1);
    } else if (roll < 40) {
      value.push(pick(SCALAR_POOL));
    } else if (roll < 50 && value.length) {
      value[randInt(value.length)] = mutateNode(value[randInt(value.length)], depth + 1);
    } else if (roll < 58 && value.length > 1) {
      value.length = randInt(value.length);
    }
    return value;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (roll < 30 && keys.length) {
      delete value[keys[randInt(keys.length)]];
    } else if (roll < 45) {
      setOwn(value, pick(KEY_POOL), pick(SCALAR_POOL));
    } else if (roll < 60 && keys.length) {
      const key = keys[randInt(keys.length)];
      value[key] = mutateNode(value[key], depth + 1);
    } else if (roll < 70) {
      setOwn(value, pick(KEY_POOL), {
        role: pick(['user', 'assistant', 'system', 7]),
        content: pick(SCALAR_POOL),
        at: pick(SCALAR_POOL),
      });
    }
    return value;
  }
  if (typeof value === 'string') {
    if (roll < 25 && value.length > 1) return value.slice(0, randInt(value.length));
    return value + pick(['', 'x', '\u0000', '```', '\n', '<b>']);
  }
  if (typeof value === 'number' && roll < 25) return pick(SCALAR_POOL);
  return value;
}

function mutate(value) {
  return mutateNode(cloneValue(value), 0);
}

/* ---- reduction ---- */

function simpleValues() {
  return [null, '', 0, true, false, [], {}];
}

function shrinkCandidates(value) {
  const out = [];
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') {
      if (value.length > 1) out.push(value.slice(0, Math.floor(value.length / 2)));
      if (value.length > 0) out.push(value.slice(1));
      out.push('');
    } else if (typeof value === 'number') {
      out.push(0);
    }
    return out;
  }
  if (Array.isArray(value)) {
    if (value.length) out.push(value.slice(1));
    if (value.length > 1) out.push(value.slice(0, Math.floor(value.length / 2)));
    out.push([]);
    return out;
  }
  const keys = Object.keys(value);
  for (const key of keys) {
    const without = cloneValue(value);
    delete without[key];
    out.push(without);
    for (const simple of simpleValues()) {
      const replaced = cloneValue(value);
      setOwn(replaced, key, simple);
      out.push(replaced);
    }
  }
  return out;
}

function shrink(value, stillFails) {
  let best = value;
  for (let step = 0; step < MAX_SHRINK_STEPS; step++) {
    let improved = false;
    for (const candidate of shrinkCandidates(best)) {
      let fails = false;
      try {
        stillFails(candidate);
      } catch (_) {
        fails = true;
      }
      if (fails) {
        best = candidate;
        improved = true;
        break;
      }
    }
    if (!improved) break;
  }
  return best;
}

/* ---- runner ---- */

function show(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

/*
 * Runs the check over mutated values. A failure is reduced before it is
 * reported, so the message shows the smallest case that still fails.
 */
function fuzz(name, seeds, iterations, check) {
  for (let i = 0; i < iterations; i++) {
    const seed = seeds[randInt(seeds.length)];
    const input = mutate(seed);
    try {
      check(input);
    } catch (err) {
      const reduced = shrink(input, (candidate) => {
        try {
          check(candidate);
          return false;
        } catch (_) {
          return true;
        }
      });
      const message = err && err.message ? err.message : String(err);
      throw new Error(
        name + ' failed on ' + show(reduced) + '\n       ' + message.split('\n').join('\n       ')
      );
    }
  }
}

/* ---- source extraction ---- */

/*
 * Reads functions from a source file and returns their text. The functions
 * stay in the source file. A copy would test the copy, not the code.
 */
function extractFunctions(file, names) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const out = [];
  for (const name of names) {
    const startRe = new RegExp('^([ \\t]*)(?:async )?function ' + name + '\\s*\\(');
    let start = -1;
    let indent = '';
    for (let i = 0; i < lines.length; i++) {
      const m = startRe.exec(lines[i]);
      if (m) {
        start = i;
        indent = m[1];
        break;
      }
    }
    assert.ok(start !== -1, 'function not found: ' + name + ' in ' + file);
    let end = -1;
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i] === indent + '}') {
        end = i;
        break;
      }
    }
    assert.ok(end !== -1, 'function end not found: ' + name + ' in ' + file);
    out.push(lines.slice(start, end + 1).join('\n'));
  }
  return out.join('\n\n');
}

/* Reads one constant declaration from a source file. A declaration that
 * spans several lines is read until the braces balance. */
function extractConst(file, name) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!new RegExp('^\\s*const ' + name + '\\s*=').test(lines[i])) continue;
    let text = lines[i].trim();
    let depth = countBraces(text);
    while (depth > 0 && i + 1 < lines.length) {
      i++;
      text += '\n' + lines[i].trim();
      depth += countBraces(lines[i]);
    }
    return text;
  }
  assert.fail('const not found: ' + name + ' in ' + file);
  return '';
}

function countBraces(text) {
  let depth = 0;
  for (const char of String(text)) {
    if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
  }
  return depth;
}

module.exports = {
  SEED: SEED,
  SCALAR_POOL: SCALAR_POOL,
  KEY_POOL: KEY_POOL,
  cloneValue: cloneValue,
  setOwn: setOwn,
  mutate: mutate,
  shrink: shrink,
  fuzz: fuzz,
  show: show,
  randInt: randInt,
  pick: pick,
  resetRandom: resetRandom,
  extractFunctions: extractFunctions,
  extractConst: extractConst,
};
