#!/usr/bin/env node
'use strict';

/*
 * Unit tests for src/js/store.js — the state-shape barrier.
 *
 * Every case here is a value that reaches the app through localStorage or
 * an imported JSON backup. Before this module existed, each of them threw
 * a TypeError inside init() (leaving the page with zero event handlers) or
 * silently destroyed persisted user data.
 *
 * Usage: node test/store_test.js
 */

const assert = require('assert');
const store = require('../src/js/store.js');

const VENDORS = ['openai', 'google', 'anthropic'];

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

/* Minimal in-memory Storage stand-in. */
function fakeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    dump: () => Object.fromEntries(map),
  };
}

/* ================================================================== *
 * readJsonSafe / stashCorruptValue
 * ================================================================== */

test('readJsonSafe: a missing key is not an error', () => {
  const r = store.readJsonSafe(fakeStorage(), 'riki.sections');
  assert.strictEqual(r.found, false);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value, null);
});

test('readJsonSafe: valid JSON is parsed', () => {
  const r = store.readJsonSafe(fakeStorage({ 'riki.sections': '{"a":1}' }), 'riki.sections');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.value, { a: 1 });
});

test('readJsonSafe: corrupt JSON is reported with the raw value kept', () => {
  const r = store.readJsonSafe(fakeStorage({ 'riki.sections': '{NAO-E-JSON' }), 'riki.sections');
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.value, null);
  assert.strictEqual(r.raw, '{NAO-E-JSON');
});

test('readJsonSafe: a storage that throws does not propagate', () => {
  const hostile = { getItem() { throw new Error('SecurityError'); } };
  const r = store.readJsonSafe(hostile, 'riki.sections');
  assert.strictEqual(r.found, false);
  assert.strictEqual(r.ok, true);
});

test('stashCorruptValue: preserves the raw value once, never overwrites', () => {
  const s = fakeStorage({ 'riki.sections': '{NAO-E-JSON' });
  assert.strictEqual(store.stashCorruptValue(s, 'riki.sections', '{NAO-E-JSON'), true);
  store.stashCorruptValue(s, 'riki.sections', 'OUTRO');
  assert.strictEqual(s.getItem('riki.sections.backup'), '{NAO-E-JSON');
  assert.strictEqual(s.getItem('riki.sections'), '{NAO-E-JSON', 'the corrupt key must not be reset');
});

/* ================================================================== *
 * normalizeSection
 * ================================================================== */

test('normalizeSection: a non-array chat becomes an empty array', () => {
  const s = store.normalizeSection({ name: 'X', chat: 'not-an-array' });
  assert.ok(Array.isArray(s.chat));
  assert.strictEqual(s.chat.length, 0);
});

test('normalizeSection: numeric text fields are dropped, not stringified', () => {
  const s = store.normalizeSection({ role: 5, master: 42, cvOut: {}, name: 7 });
  assert.strictEqual(s.role, '');
  assert.strictEqual(s.master, '');
  assert.strictEqual(s.cvOut, '');
  assert.strictEqual(s.name, 'Vaga nova');
});

test('normalizeSection: an invalid updatedAt becomes a usable timestamp', () => {
  const s = store.normalizeSection({ updatedAt: 'nope' });
  assert.strictEqual(typeof s.updatedAt, 'number');
  assert.ok(isFinite(s.updatedAt) && s.updatedAt > 0);
});

test('normalizeSection: an unknown lang falls back to en', () => {
  assert.strictEqual(store.normalizeSection({ lang: 'fr' }).lang, 'en');
  assert.strictEqual(store.normalizeSection({ lang: 'pt' }).lang, 'pt');
  assert.strictEqual(store.normalizeSection({ lang: 42 }).lang, 'en');
});

test('normalizeSection: genCover only stays true for a real boolean', () => {
  assert.strictEqual(store.normalizeSection({ genCover: 'yes' }).genCover, false);
  assert.strictEqual(store.normalizeSection({ genCover: true }).genCover, true);
});

test('normalizeSection: unsafe masterId/templateId become null', () => {
  const s = store.normalizeSection({ masterId: 'a"]', templateId: 7 });
  assert.strictEqual(s.masterId, null);
  assert.strictEqual(s.templateId, null);
});

test('normalizeSection: chat entries are coerced to {role, content, at}', () => {
  const s = store.normalizeSection({ chat: [{ role: 'user', content: 'oi' }, 'nope', { role: 'zzz', content: 5 }] });
  assert.strictEqual(s.chat.length, 2);
  assert.strictEqual(s.chat[0].role, 'user');
  assert.strictEqual(s.chat[0].content, 'oi');
  assert.strictEqual(s.chat[1].role, 'assistant');
  assert.strictEqual(s.chat[1].content, '');
});

test('normalizeSection: a completely hostile value still yields a usable section', () => {
  for (const hostile of [null, undefined, 42, 'texto', [], true]) {
    const s = store.normalizeSection(hostile);
    assert.strictEqual(typeof s.name, 'string');
    assert.ok(Array.isArray(s.chat));
    assert.strictEqual(s.lang, 'en');
  }
});

/* ================================================================== *
 * normalizeSections
 * ================================================================== */

test('normalizeSections: __proto__ ids do not pollute the prototype', () => {
  const sections = store.normalizeSections(JSON.parse('{"__proto__":{"polluted":1},"s1":{"name":"A"}}'));
  assert.strictEqual({}.polluted, undefined, 'Object.prototype was polluted');
  assert.strictEqual(Object.getPrototypeOf(sections), null);
  assert.ok(Object.prototype.hasOwnProperty.call(sections, '__proto__'));
  assert.strictEqual(sections.s1.name, 'A');
});

test('normalizeSections: a non-object input yields an empty map', () => {
  assert.strictEqual(Object.keys(store.normalizeSections('nope')).length, 0);
  assert.strictEqual(Object.keys(store.normalizeSections(null)).length, 0);
  assert.strictEqual(Object.keys(store.normalizeSections([1, 2])).length, 0);
});

/* ================================================================== *
 * normalizeLibrary
 * ================================================================== */

test('normalizeLibrary: a non-string lang falls back to en', () => {
  const lib = store.normalizeLibrary({ masters: [{ id: 'm1', name: 'M', lang: 123 }], templates: 'nope' });
  assert.strictEqual(lib.masters[0].lang, 'en');
  assert.ok(Array.isArray(lib.templates));
  assert.strictEqual(lib.templates.length, 0);
});

test('normalizeLibrary: an id that breaks querySelector is replaced', () => {
  const lib = store.normalizeLibrary({ masters: [{ id: 'a"]', name: 'M' }] });
  assert.ok(store.isStoreSafeId(lib.masters[0].id), 'unsafe id survived: ' + lib.masters[0].id);
  assert.strictEqual(lib.masters[0].name, 'M');
});

test('normalizeLibrary: duplicate ids are made unique', () => {
  const lib = store.normalizeLibrary({ masters: [{ id: 'm1', name: 'A' }, { id: 'm1', name: 'B' }, { id: '', name: 'C' }] });
  const ids = lib.masters.map((m) => m.id);
  assert.strictEqual(new Set(ids).size, 3, 'ids collided: ' + JSON.stringify(ids));
});

test('normalizeLibrary: templates carry no lang field', () => {
  const lib = store.normalizeLibrary({ templates: [{ id: 't1', name: 'T', lang: 'en' }] });
  assert.ok(!('lang' in lib.templates[0]));
});

/* ================================================================== *
 * mergeLibraryList
 * ================================================================== */

test('mergeLibraryList: local items survive a full library', () => {
  const local = [{ id: 'l1', name: 'L1' }, { id: 'l2', name: 'L2' }];
  const r = store.mergeLibraryList(local, [{ id: 'i1', name: 'I1' }], 'master', 2);
  assert.deepStrictEqual(r.merged.map((e) => e.id), ['l1', 'l2']);
  assert.strictEqual(r.added, 0);
  assert.strictEqual(r.skipped, 1);
});

test('mergeLibraryList: incoming items fill the remaining slots', () => {
  const local = [{ id: 'l1', name: 'L1' }];
  const r = store.mergeLibraryList(local, [{ id: 'i1', name: 'I1' }], 'master', 2);
  assert.deepStrictEqual(r.merged.map((e) => e.id), ['l1', 'i1']);
  assert.strictEqual(r.added, 1);
  assert.strictEqual(r.skipped, 0);
});

test('mergeLibraryList: a duplicate id counts as skipped, not as a replacement', () => {
  const local = [{ id: 'm1', name: 'Local' }];
  const r = store.mergeLibraryList(local, [{ id: 'm1', name: 'Remoto' }], 'master', 2);
  assert.strictEqual(r.merged.length, 1);
  assert.strictEqual(r.merged[0].name, 'Local');
  assert.strictEqual(r.skipped, 1);
});

test('mergeLibraryList: imported entries are normalized', () => {
  const r = store.mergeLibraryList([], [{ id: 'b"]', name: 'M', lang: 9 }], 'master', 2);
  assert.ok(store.isStoreSafeId(r.merged[0].id));
  assert.strictEqual(r.merged[0].lang, 'en');
});

test('mergeLibraryList: a non-array incoming is a no-op', () => {
  const local = [{ id: 'l1' }];
  assert.deepStrictEqual(store.mergeLibraryList(local, 'nope', 'master', 2).merged, local);
  assert.deepStrictEqual(store.mergeLibraryList(local, null, 'master', 2).merged, local);
});

/* ================================================================== *
 * normalizeConfig
 * ================================================================== */

test('normalizeConfig: unknown vendors and stray fields are dropped', () => {
  const c = store.normalizeConfig({ model: 'd', keys: { google: 'g1', evil: 'sk-x' }, urls: { openai: 'u1', evil: 'http://e' }, rogue: 1 }, VENDORS);
  assert.deepStrictEqual(Object.keys(c).sort(), ['keys', 'model', 'urls']);
  assert.strictEqual(c.model, 'd');
  assert.deepStrictEqual(c.keys, { google: 'g1' });
  assert.deepStrictEqual(c.urls, { openai: 'u1' });
});

test('normalizeConfig: a missing or blank model falls back to j', () => {
  assert.strictEqual(store.normalizeConfig({}, VENDORS).model, 'j');
  assert.strictEqual(store.normalizeConfig({ model: '   ' }, VENDORS).model, 'j');
  assert.strictEqual(store.normalizeConfig({ model: 7 }, VENDORS).model, 'j');
  assert.strictEqual(store.normalizeConfig(null, VENDORS).model, 'j');
});

test('normalizeConfig: non-string key/url values are dropped', () => {
  const c = store.normalizeConfig({ keys: { openai: 5 }, urls: { openai: {} } }, VENDORS);
  assert.deepStrictEqual(c.keys, {});
  assert.deepStrictEqual(c.urls, {});
});

test('normalizeConfig: legacy apiKey/baseURL still migrate', () => {
  const c = store.normalizeConfig({ apiKey: 'sk-legacy', baseURL: 'http://legacy' }, VENDORS);
  assert.strictEqual(c.keys.openai, 'sk-legacy');
  assert.strictEqual(c.urls.openai, 'http://legacy');
});

test('normalizeConfig: an explicit openai key wins over the legacy field', () => {
  const c = store.normalizeConfig({ apiKey: 'sk-legacy', keys: { openai: 'sk-novo' } }, VENDORS);
  assert.strictEqual(c.keys.openai, 'sk-novo');
});

test('normalizeConfig: an array as keys does not become an object of indices', () => {
  const c = store.normalizeConfig({ keys: ['sk-a', 'sk-b'] }, VENDORS);
  assert.deepStrictEqual(c.keys, {});
});

/* ================================================================== *
 * import caps — a hostile backup must not brick the app on load
 * ================================================================== */

test('normalizeChat: a hostile history is capped to the newest messages', () => {
  const big = [];
  for (let i = 0; i < 500; i++) big.push({ role: 'user', content: 'm' + i, at: 1000 + i });
  const out = store.normalizeChat(big);
  assert.strictEqual(out.length, store.STORE_MAX_CHAT, 'expected cap at ' + store.STORE_MAX_CHAT);
  assert.strictEqual(out[out.length - 1].content, 'm499', 'the newest message was dropped');
  assert.strictEqual(out[0].content, 'm' + (500 - store.STORE_MAX_CHAT), 'oldest kept message is wrong');
});

test('normalizeSections: an import batch is capped, the load path is not', () => {
  const big = {};
  for (let i = 0; i < 500; i++) big['s' + i] = { name: 'S' + i };
  const capped = store.normalizeSections(big, store.STORE_MAX_SECTIONS);
  assert.strictEqual(Object.keys(capped).length, store.STORE_MAX_SECTIONS, 'import batch was not capped');
  assert.ok(Object.prototype.hasOwnProperty.call(capped, 's0'), 'first sections must be kept');
  const uncapped = store.normalizeSections(big);
  assert.strictEqual(Object.keys(uncapped).length, 500, 'the load path must not drop user sections');
});

test('upload gate: files over the limit are refused before any read', () => {
  assert.strictEqual(typeof store.STORE_MAX_FILE_BYTES, 'number');
  assert.ok(store.STORE_MAX_FILE_BYTES >= 1024 * 1024, 'limit absurdly small');
  assert.strictEqual(store.isFileTooBig(0), false);
  assert.strictEqual(store.isFileTooBig(store.STORE_MAX_FILE_BYTES), false);
  assert.strictEqual(store.isFileTooBig(store.STORE_MAX_FILE_BYTES + 1), true);
  assert.strictEqual(store.isFileTooBig(Number.MAX_SAFE_INTEGER), true);
});

/* ================================================================== */

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
