#!/usr/bin/env node
'use strict';

/*
 * Fuzz, differential, and reduction tests for src/js/store.js.
 *
 * The store module is the shape barrier of the app. Every value in it comes
 * from localStorage or from an imported backup. The tests here feed hostile
 * values to the normalizers and check four properties:
 *
 * 1. No throw. A normalizer must always return a usable value.
 * 2. The shape holds. Every field has the type the app expects.
 * 3. The result is stable. Normalizing twice gives the same value, and the
 *    value survives a JSON round trip.
 * 4. No prototype pollution. A hostile key never reaches Object.prototype.
 *
 * A failure is reduced to the smallest case that still fails.
 *
 * Usage: node test/fuzz_test.js
 */

const assert = require('assert');
const path = require('path');

const store = require('../src/js/store.js');
const lib = require('./fuzz_lib.js');

const VENDORS = [
  'openai', 'anthropic', 'google', 'deepseek', 'xai',
  'cerebras', 'moonshotai', 'openrouter',
  'alibaba', 'zai', 'meta', 'xiaomi', 'custom',
];

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

/* ---- shape checks ---- */

const SECTION_KEYS = [
  'name', 'role', 'master', 'lang', 'masterId', 'template', 'templateId',
  'pitch', 'genCover', 'cvOut', 'cover', 'tex', 'texHash', 'chat', 'updatedAt',
];

const TEXT_FIELDS = ['role', 'master', 'template', 'pitch', 'cvOut', 'cover', 'tex', 'texHash'];

function checkSection(s, label) {
  assert.ok(s && typeof s === 'object' && !Array.isArray(s), label + ': not an object');
  const keys = Object.keys(s);
  for (const key of keys) {
    assert.ok(SECTION_KEYS.indexOf(key) !== -1, label + ': unexpected key ' + JSON.stringify(key));
  }
  for (const key of SECTION_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(s, key), label + ': missing key ' + key);
  }
  assert.strictEqual(typeof s.name, 'string', label + ': name is not a string');
  assert.ok(s.name.length > 0, label + ': name is empty');
  for (const key of TEXT_FIELDS) {
    assert.strictEqual(typeof s[key], 'string', label + ': ' + key + ' is not a string');
  }
  assert.ok(s.lang === 'en' || s.lang === 'pt', label + ': bad lang ' + JSON.stringify(s.lang));
  assert.ok(s.masterId === null || store.isStoreSafeId(s.masterId), label + ': bad masterId');
  assert.ok(s.templateId === null || store.isStoreSafeId(s.templateId), label + ': bad templateId');
  assert.strictEqual(typeof s.genCover, 'boolean', label + ': genCover is not a boolean');
  assert.ok(typeof s.updatedAt === 'number' && isFinite(s.updatedAt) && s.updatedAt > 0, label + ': bad updatedAt');
  assert.ok(Array.isArray(s.chat), label + ': chat is not an array');
  for (const m of s.chat) {
    assert.ok(m && typeof m === 'object' && !Array.isArray(m), label + ': bad chat entry');
    assert.ok(m.role === 'user' || m.role === 'assistant', label + ': bad chat role');
    assert.strictEqual(typeof m.content, 'string', label + ': chat content is not a string');
    assert.ok(typeof m.at === 'number' && isFinite(m.at) && m.at > 0, label + ': bad chat time');
  }
}

function checkNoPollution(label) {
  assert.strictEqual({}.polluted, undefined, label + ': Object.prototype was polluted');
  assert.strictEqual({}.name, undefined, label + ': Object.prototype.name was polluted');
  assert.strictEqual({}.role, undefined, label + ': Object.prototype.role was polluted');
}

/* A plain object, or nothing. A string or an array is not a section map. */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/* ---- seeds ---- */

const SECTION_SEEDS = [
  {},
  { name: 'Job', role: 'dev', master: 'cv', lang: 'pt', chat: [] },
  { name: 42, role: { a: 1 }, lang: 'fr', genCover: 'yes', updatedAt: 'nope' },
  { chat: 'not-an-array' },
  { chat: [{ role: 'user', content: 'oi', at: 1 }, 'junk', { role: 'x', content: 5 }] },
  { masterId: 'a"]', templateId: 7 },
  { __proto__: { polluted: 1 } },
  { name: 'X', cvOut: null, cover: undefined, tex: 0, texHash: false },
  { updatedAt: NaN },
  { updatedAt: Infinity },
  { updatedAt: -1 },
  { updatedAt: 1e308 },
];

const SECTIONS_SEEDS = [
  {},
  { s1: { name: 'A' } },
  { __proto__: { polluted: 1 }, s2: { name: 'B', lang: 'pt' } },
  { 'a b': { name: 'C' }, 'a"b': { name: 'D' }, '': { name: 'E' } },
  { s3: null, s4: 42, s5: 'text', s6: [] },
  { s7: { chat: { role: 'user' } } },
];

const LIBRARY_SEEDS = [
  {},
  { masters: [{ id: 'm1', name: 'M', content: 'c', lang: 'en' }], templates: [] },
  { masters: [{ id: 'a"]', name: 'M' }], templates: [{ id: '', name: 'T' }] },
  { masters: [{ id: 'm1', name: 'A' }, { id: 'm1', name: 'B' }] },
  { masters: 'nope', templates: 42 },
  { masters: [null, 5, 'x', { id: 'm2' }] },
  { __proto__: { polluted: 1 }, masters: [{ id: 'm3' }] },
];

const CONFIG_SEEDS = [
  {},
  { model: 'j', keys: {}, urls: {} },
  { model: 42, keys: ['a'], urls: 'b' },
  { keys: { openai: 'k', evil: 'x', __proto__: 'y' }, urls: { openai: 'u', evil: 'v' } },
  { apiKey: 'sk-legacy', baseURL: 'http://legacy' },
  { customApi: 'responses', customHeaders: '{}', setupDone: true },
  { customApi: 'evil', customHeaders: 42, setupDone: 'yes' },
  { model: '   ', rogue: 1 },
  { keys: { openai: { a: 1 } }, urls: { openai: 5 } },
];

/* ================================================================== *
 * normalizeSection
 * ================================================================== */

test('normalizeSection: the shape holds for hostile input', () => {
  lib.fuzz('normalizeSection', SECTION_SEEDS, 400, (input) => {
    checkSection(store.normalizeSection(input), 'normalizeSection');
  });
});

test('normalizeSection: the result is stable after a second pass', () => {
  lib.fuzz('normalizeSection idempotent', SECTION_SEEDS, 300, (input) => {
    const once = store.normalizeSection(input);
    const twice = store.normalizeSection(once);
    assert.deepStrictEqual(twice, once, 'the second pass changed the value');
  });
});

test('normalizeSection: the result survives a JSON round trip', () => {
  lib.fuzz('normalizeSection json', SECTION_SEEDS, 300, (input) => {
    const once = store.normalizeSection(input);
    const back = JSON.parse(JSON.stringify(once));
    assert.deepStrictEqual(back, once, 'the JSON round trip changed the value');
  });
});

test('normalizeSection: wrong input types never throw', () => {
  const wrong = [null, undefined, 42, 'text', [], true, Symbol('x'), 0n, function () {}];
  for (const value of wrong) {
    checkSection(store.normalizeSection(value), 'wrong input ' + String(value));
  }
});

test('normalizeSection: a hostile key never reaches the prototype', () => {
  lib.fuzz('normalizeSection pollution', SECTION_SEEDS, 300, (input) => {
    store.normalizeSection(input);
    checkNoPollution('normalizeSection');
  });
});

/* ================================================================== *
 * normalizeSections
 * ================================================================== */

test('normalizeSections: the map keeps every key and every item is valid', () => {
  lib.fuzz('normalizeSections', SECTIONS_SEEDS, 300, (input) => {
    const map = store.normalizeSections(input);
    assert.strictEqual(Object.getPrototypeOf(map), null, 'the map is not on a null prototype');
    const sourceKeys = isPlainObject(input) ? Object.keys(input) : [];
    assert.deepStrictEqual(Object.keys(map), sourceKeys, 'the map lost or added keys');
    for (const key of sourceKeys) {
      checkSection(map[key], 'section ' + key);
    }
  });
});

test('normalizeSections: a hostile key never reaches the prototype', () => {
  lib.fuzz('normalizeSections pollution', SECTIONS_SEEDS, 300, (input) => {
    store.normalizeSections(input);
    checkNoPollution('normalizeSections');
  });
});

test('normalizeSections: the per item normalizer gives the same value', () => {
  /* Differential check: the map normalizer and the item normalizer must
   * agree for every key. Two code paths, one contract. */
  lib.fuzz('normalizeSections differential', SECTIONS_SEEDS, 300, (input) => {
    if (!isPlainObject(input)) return;
    const map = store.normalizeSections(input);
    for (const key of Object.keys(input)) {
      const fromMap = Object.assign({}, map[key]);
      const fromItem = Object.assign({}, store.normalizeSection(input[key]));
      /* The normalizer stamps the current time on a section without a
       * timestamp, so the two calls can differ by one millisecond. */
      delete fromMap.updatedAt;
      delete fromItem.updatedAt;
      assert.deepStrictEqual(fromMap, fromItem, 'the two paths differ for ' + key);
    }
  });
});

test('normalizeSections: the cap keeps the first keys and drops the rest', () => {
  const big = {};
  for (let i = 0; i < 500; i++) big['s' + i] = { name: 'S' + i };
  const capped = store.normalizeSections(big, store.STORE_MAX_SECTIONS);
  assert.strictEqual(Object.keys(capped).length, store.STORE_MAX_SECTIONS);
  assert.strictEqual(capped.s0.name, 'S0');
  checkNoPollution('normalizeSections cap');
});

/* ================================================================== *
 * normalizeLibrary
 * ================================================================== */

test('normalizeLibrary: the lists keep unique safe ids', () => {
  lib.fuzz('normalizeLibrary', LIBRARY_SEEDS, 300, (input) => {
    const lib1 = store.normalizeLibrary(input);
    assert.ok(Array.isArray(lib1.masters), 'masters is not an array');
    assert.ok(Array.isArray(lib1.templates), 'templates is not an array');
    for (const [list, kind] of [[lib1.masters, 'master'], [lib1.templates, 'template']]) {
      const ids = list.map((e) => e.id);
      assert.strictEqual(new Set(ids).size, ids.length, 'the ids collided: ' + JSON.stringify(ids));
      for (const entry of list) {
        assert.ok(store.isStoreSafeId(entry.id), 'unsafe id: ' + JSON.stringify(entry.id));
        assert.strictEqual(typeof entry.name, 'string', 'the name is not a string');
        assert.strictEqual(typeof entry.content, 'string', 'the content is not a string');
        if (kind === 'master') {
          assert.ok(entry.lang === 'en' || entry.lang === 'pt', 'bad lang');
        } else {
          assert.ok(!('lang' in entry), 'a template carries a lang');
        }
      }
    }
  });
});

test('normalizeLibrary: a hostile key never reaches the prototype', () => {
  lib.fuzz('normalizeLibrary pollution', LIBRARY_SEEDS, 300, (input) => {
    store.normalizeLibrary(input);
    checkNoPollution('normalizeLibrary');
  });
});

test('normalizeLibrary: the result is stable after a second pass', () => {
  lib.fuzz('normalizeLibrary idempotent', LIBRARY_SEEDS, 200, (input) => {
    const once = store.normalizeLibrary(input);
    const twice = store.normalizeLibrary(once);
    assert.deepStrictEqual(twice, once, 'the second pass changed the value');
  });
});

/* ================================================================== *
 * mergeLibraryList
 * ================================================================== */

test('mergeLibraryList: the local items always survive', () => {
  const locals = [[], [{ id: 'l1', name: 'L1' }], [{ id: 'l1' }, { id: 'l2' }]];
  lib.fuzz('mergeLibraryList local', locals, 300, (local) => {
    const incoming = [{ id: 'i1', name: 'I1' }, { id: 'i2', name: 'I2' }];
    const result = store.mergeLibraryList(local, incoming, 'master', 2);
    const localItems = (Array.isArray(local) ? local : []).filter(
      (e) => e && typeof e === 'object' && !Array.isArray(e)
    );
    for (const item of localItems) {
      if (typeof item.id === 'string' && store.isStoreSafeId(item.id)) {
        assert.ok(result.merged.some((e) => e.id === item.id), 'the local item ' + item.id + ' was lost');
      }
    }
    /* The merge never grows the list past the ceiling. A local list that is
     * already longer stays as it is. */
    assert.ok(
      result.merged.length <= Math.max(localItems.length, 2),
      'the ceiling was broken: ' + result.merged.length
    );
    const ids = result.merged.map((e) => e.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'the ids collided');
    assert.strictEqual(result.added + result.skipped, incoming.length, 'the counters do not add up');
  });
});

test('mergeLibraryList: a second merge of the same input adds nothing', () => {
  lib.fuzz('mergeLibraryList twice', LIBRARY_SEEDS, 200, (input) => {
    const masters = Array.isArray(input.masters) ? input.masters : [];
    const first = store.mergeLibraryList([], masters, 'master', 4);
    const second = store.mergeLibraryList(first.merged, masters, 'master', 4);
    assert.strictEqual(second.added, 0, 'the second merge added items again');
    assert.deepStrictEqual(second.merged, first.merged, 'the second merge changed the list');
  });
});

/* ================================================================== *
 * normalizeConfig
 * ================================================================== */

test('normalizeConfig: only the known vendors and the known keys survive', () => {
  lib.fuzz('normalizeConfig', CONFIG_SEEDS, 300, (input) => {
    const cfg = store.normalizeConfig(input, VENDORS);
    const allowed = ['model', 'keys', 'urls', 'customApi', 'customHeaders', 'setupDone'];
    for (const key of Object.keys(cfg)) {
      assert.ok(allowed.indexOf(key) !== -1, 'unexpected config key ' + JSON.stringify(key));
    }
    assert.strictEqual(typeof cfg.model, 'string', 'the model is not a string');
    assert.ok(cfg.model.length > 0, 'the model is empty');
    for (const map of [cfg.keys, cfg.urls]) {
      assert.ok(map && typeof map === 'object' && !Array.isArray(map), 'the map is not an object');
      for (const key of Object.keys(map)) {
        assert.ok(VENDORS.indexOf(key) !== -1, 'unexpected vendor ' + JSON.stringify(key));
        assert.strictEqual(typeof map[key], 'string', 'the value of ' + key + ' is not a string');
      }
    }
  });
});

test('normalizeConfig: a hostile key never reaches the prototype', () => {
  lib.fuzz('normalizeConfig pollution', CONFIG_SEEDS, 300, (input) => {
    store.normalizeConfig(input, VENDORS);
    checkNoPollution('normalizeConfig');
  });
});

test('normalizeConfig: the result is stable after a second pass', () => {
  lib.fuzz('normalizeConfig idempotent', CONFIG_SEEDS, 200, (input) => {
    const once = store.normalizeConfig(input, VENDORS);
    const twice = store.normalizeConfig(once, VENDORS);
    assert.deepStrictEqual(twice, once, 'the second pass changed the value');
  });
});

test('normalizeConfig: the allowlist matches an independent filter', () => {
  /* Differential check: the normalizer must keep exactly the values that a
   * simple reference filter keeps. The legacy apiKey field migrates into
   * the openai vendor, so the reference filter knows that rule too. */
  lib.fuzz('normalizeConfig differential', CONFIG_SEEDS, 200, (input) => {
    const cfg = store.normalizeConfig(input, VENDORS);
    const raw = isPlainObject(input) ? input : {};
    const rawKeys = isPlainObject(raw.keys) ? raw.keys : {};
    const legacyKey = typeof raw.apiKey === 'string' && raw.apiKey.trim() ? raw.apiKey.trim() : null;
    for (const vendor of VENDORS) {
      const value = rawKeys[vendor];
      if (typeof value === 'string' && value.trim()) {
        assert.strictEqual(cfg.keys[vendor], value.trim(), 'the key of ' + vendor + ' is wrong');
      } else if (vendor === 'openai' && legacyKey && !rawKeys.openai) {
        assert.strictEqual(cfg.keys.openai, legacyKey, 'the legacy key did not migrate');
      } else {
        assert.ok(!(vendor in cfg.keys), 'the key of ' + vendor + ' appeared from nowhere');
      }
    }
  });
});

/* ================================================================== *
 * readJsonSafe / stashCorruptValue
 * ================================================================== */

test('readJsonSafe: a storage that throws never breaks the caller', () => {
  const hostile = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('SecurityError'); },
  };
  const r = store.readJsonSafe(hostile, 'riki.sections');
  assert.strictEqual(r.found, false);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(store.stashCorruptValue(hostile, 'riki.sections', 'x'), false);
});

test('readJsonSafe: every raw string is either parsed or reported', () => {
  const raws = ['', '{', 'null', '[]', '{"a":1}', 'NaN', 'undefined', '"x"', '0', 'true', '﻿{}'];
  for (const raw of raws) {
    const storage = {
      getItem: () => raw,
      setItem() {},
    };
    const r = store.readJsonSafe(storage, 'k');
    assert.strictEqual(r.found, true, 'the key was not found: ' + raw);
    if (r.ok) {
      assert.notStrictEqual(r.value, undefined, 'a parsed value is undefined: ' + raw);
    } else {
      assert.strictEqual(r.value, null, 'a corrupt value is not null: ' + raw);
      assert.strictEqual(r.raw, raw, 'the raw value was lost: ' + raw);
    }
  }
});

/* ================================================================== */

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
