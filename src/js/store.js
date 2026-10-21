// State normalizers — the shape barrier between what comes out of
// localStorage (or an imported JSON) and the app.
//
// Without this layer, a corrupted value in storage breaks rendering
// (TypeError in renderLibSelects/renderContextChips) and, in the case of
// invalid JSON, used to take down the whole init() — the page ended up with
// no event handler at all. Worse: the saveAll() at the end of init wrote the
// reset on top of the user's data.
//
// Pure functions, no DOM. Loaded as a global script (the same pattern as
// prompts.js/llm.js) and exported to Node in test/store_test.js.

const STORE_SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const STORE_LANGS = ['en', 'pt'];
const STORE_FALLBACK_NAME = 'New job';

/* Anti-DoS ceilings: a hostile backup with 500 sections or 10k messages
 * would freeze rendering (one <option>/div per item) and blow the quota on
 * the next saveAll — and the persisted state would jam EVERY later load.
 * 200 sections / 200 recent messages is plenty of headroom for real use. */
const STORE_MAX_CHAT = 200;
const STORE_MAX_SECTIONS = 200;
/* The load path has a higher ceiling than the import path. The import can
 * only add a limited batch, so the load only meets a state that the app
 * itself wrote. A real user can have more than 200 sections, and a load
 * that drops them loses data. 2000 sections still load in under a second. */
const STORE_MAX_SECTIONS_LOAD = 2000;
/* File uploads (master/template/tex via FileReader): without a ceiling, a
 * multi-GB file goes entirely into RAM and then into localStorage. */
const STORE_MAX_FILE_BYTES = 8 * 1024 * 1024;

function isFileTooBig(size) {
  return typeof size === 'number' && isFinite(size) && size > STORE_MAX_FILE_BYTES;
}

function isStoreObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/* Only strings are real text: a number/object in a text field is
 * corruption, not a value. */
function storeText(value) {
  return typeof value === 'string' ? value : '';
}

function storeTime(value) {
  return typeof value === 'number' && isFinite(value) && value > 0 ? value : Date.now();
}

/* Section/library ids end up in querySelector and in <option value>;
 * only the safe alphabet passes. */
function isStoreSafeId(value) {
  return typeof value === 'string' && STORE_SAFE_ID.test(value);
}

function storeOptionalId(value) {
  return isStoreSafeId(value) ? value : null;
}

function storePickId(candidate, taken) {
  const base = isStoreSafeId(candidate) ? candidate : 'i' + taken.length.toString(36);
  let id = base;
  let suffix = 1;
  while (taken.indexOf(id) !== -1) {
    id = base + '_' + suffix;
    suffix++;
  }
  taken.push(id);
  return id;
}

/* Read a JSON key from storage without throwing. Distinguishes "does not
 * exist" from "exists but does not parse" — the second case is the one that
 * must not be overwritten with a reset. */
function readJsonSafe(storage, key) {
  let raw = null;
  try {
    raw = storage.getItem(key);
  } catch (_) {
    return { found: false, ok: true, value: null, raw: null };
  }
  if (raw === null || raw === undefined) return { found: false, ok: true, value: null, raw: null };
  try {
    return { found: true, ok: true, value: JSON.parse(raw), raw };
  } catch (_) {
    return { found: true, ok: false, value: null, raw };
  }
}

/* Stash the raw value under <key>.backup exactly once: overwriting the key
 * with a reset destroys the evidence and prevents the user from recovering. */
function stashCorruptValue(storage, key, raw) {
  const backupKey = key + '.backup';
  try {
    if (storage.getItem(backupKey) === null) storage.setItem(backupKey, raw);
  } catch (_) {
    return false;
  }
  return true;
}

function normalizeChat(raw) {
  if (!Array.isArray(raw)) return [];
  const items = raw.filter(isStoreObject);
  /* Hostile history (thousands of messages) becomes thousands of divs on
   * render and locks the tab on every load: keep only the most recent. */
  const tail = items.length > STORE_MAX_CHAT ? items.slice(items.length - STORE_MAX_CHAT) : items;
  return tail.map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: storeText(m.content),
    at: storeTime(m.at),
  }));
}

function normalizeSection(raw) {
  const src = isStoreObject(raw) ? raw : {};
  return {
    name: storeText(src.name) || STORE_FALLBACK_NAME,
    role: storeText(src.role),
    master: storeText(src.master),
    lang: STORE_LANGS.indexOf(src.lang) === -1 ? 'en' : src.lang,
    masterId: storeOptionalId(src.masterId),
    template: storeText(src.template),
    templateId: storeOptionalId(src.templateId),
    pitch: storeText(src.pitch),
    genCover: src.genCover === true,
    cvOut: storeText(src.cvOut),
    cover: storeText(src.cover),
    tex: storeText(src.tex),
    texHash: storeText(src.texHash),
    chat: normalizeChat(src.chat),
    updatedAt: storeTime(src.updatedAt),
  };
}

/* Map of sections on a null prototype: a "__proto__" id coming from a
 * tampered JSON becomes an ordinary property instead of polluting the
 * prototype. `max` (used only on import) caps the batch size: without it, a
 * backup with thousands of sections freezes rendering and persists the
 * freeze. */
function normalizeSections(raw, max) {
  const out = Object.create(null);
  if (!isStoreObject(raw)) return out;
  let ids = Object.keys(raw);
  if (typeof max === 'number' && isFinite(max) && ids.length > max) ids = ids.slice(0, max);
  ids.forEach((id) => {
    out[id] = normalizeSection(raw[id]);
  });
  return out;
}

function normalizeLibraryEntry(raw, kind, taken) {
  const src = isStoreObject(raw) ? raw : {};
  const entry = {
    id: storePickId(src.id, taken),
    name: storeText(src.name),
    content: storeText(src.content),
  };
  if (kind === 'master') entry.lang = STORE_LANGS.indexOf(src.lang) === -1 ? 'en' : src.lang;
  return entry;
}

function normalizeLibraryList(raw, kind) {
  if (!Array.isArray(raw)) return [];
  const taken = [];
  return raw.filter(isStoreObject).map((entry) => normalizeLibraryEntry(entry, kind, taken));
}

function normalizeLibrary(raw) {
  const src = isStoreObject(raw) ? raw : {};
  return {
    masters: normalizeLibraryList(src.masters, 'master'),
    templates: normalizeLibraryList(src.templates, 'template'),
  };
}

/* Merge imported items without evicting local ones when the ceiling is hit:
 * the old slice(-max) replaced the user's library with the backup's.
 *
 * The local list is filtered: a raw list can hold a null or a number, and
 * the renderer reads e.name on every entry. The source id of every entry is
 * tracked apart from the id in the list, so the same backup merged twice
 * does not add the same item twice. */
function mergeLibraryList(local, incoming, kind, max) {
  /* A duplicate id is dropped: the renderer looks the card up by id, so
   * the second card with the same id can never be reached. */
  const localIds = [];
  const target = (Array.isArray(local) ? local : []).filter(isStoreObject).filter((entry) => {
    if (typeof entry.id !== 'string' || !isStoreSafeId(entry.id)) return true;
    if (localIds.indexOf(entry.id) !== -1) return false;
    localIds.push(entry.id);
    return true;
  });
  /* The ids in the list. The normalizer uses them to build a new id that
   * does not collide with an entry of the list. */
  const taken = target.map((e) => e.id);
  /* The source id of every entry. An imported entry with an unusable id
   * gets a new one, so the source id is the only way to know that the same
   * backup item arrived twice. */
  const sourceIds = target.map((e) => e.id);
  const source = Array.isArray(incoming) ? incoming : [];
  let added = 0;
  let skipped = 0;
  source.forEach((raw) => {
    if (!isStoreObject(raw)) { skipped++; return; }
    if (typeof raw.id === 'string' && sourceIds.indexOf(raw.id) !== -1) { skipped++; return; }
    if (target.length >= max) { skipped++; return; }
    const entry = normalizeLibraryEntry(raw, kind, taken);
    /* The same item twice must not land in the list twice. The id of an
     * imported item can change, so the content decides as well. */
    const sameContent = target.some((e) => e.name === entry.name && e.content === entry.content);
    if (sameContent) { skipped++; return; }
    target.push(entry);
    sourceIds.push(typeof raw.id === 'string' ? raw.id : entry.id);
    added++;
  });
  return { merged: target, added: added, skipped: skipped };
}

/* Strict allowlist: only the model and the keys/urls of known vendors pass,
 * so a backup cannot inject a router, a third-party URL, or extra fields
 * into the config. */
function normalizeConfig(raw, vendors) {
  const src = isStoreObject(raw) ? raw : {};
  const list = Array.isArray(vendors) ? vendors : [];
  const model = typeof src.model === 'string' && src.model.trim() ? src.model.trim() : 'j';
  const rawKeys = isStoreObject(src.keys) ? src.keys : {};
  const rawUrls = isStoreObject(src.urls) ? src.urls : {};
  const keys = {};
  const urls = {};
  list.forEach((vendor) => {
    if (typeof rawKeys[vendor] === 'string' && rawKeys[vendor].trim()) keys[vendor] = rawKeys[vendor].trim();
    if (typeof rawUrls[vendor] === 'string' && rawUrls[vendor].trim()) urls[vendor] = rawUrls[vendor].trim();
  });
  if (typeof src.apiKey === 'string' && src.apiKey.trim() && !keys.openai) keys.openai = src.apiKey.trim();
  if (typeof src.baseURL === 'string' && src.baseURL.trim() && !urls.openai) urls.openai = src.baseURL.trim();
  const out = { model: model, keys: keys, urls: urls };
  if (src.customApi === 'responses' || src.customApi === 'chat') out.customApi = src.customApi;
  if (typeof src.customHeaders === 'string' && src.customHeaders) out.customHeaders = src.customHeaders;
  /* setupDone means the user saved the setup values. The seeded defaults
     do not set it, so a fresh profile still shows the setup block. */
  if (src.setupDone === true) out.setupDone = true;
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    STORE_LANGS: STORE_LANGS,
    STORE_MAX_CHAT: STORE_MAX_CHAT,
    STORE_MAX_SECTIONS: STORE_MAX_SECTIONS,
    STORE_MAX_SECTIONS_LOAD: STORE_MAX_SECTIONS_LOAD,
    STORE_MAX_FILE_BYTES: STORE_MAX_FILE_BYTES,
    isFileTooBig: isFileTooBig,
    isStoreSafeId: isStoreSafeId,
    readJsonSafe: readJsonSafe,
    stashCorruptValue: stashCorruptValue,
    normalizeChat: normalizeChat,
    normalizeSection: normalizeSection,
    normalizeSections: normalizeSections,
    normalizeLibrary: normalizeLibrary,
    mergeLibraryList: mergeLibraryList,
    normalizeConfig: normalizeConfig,
  };
}
