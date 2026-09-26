// Normalizadores de estado — a barreira de shape entre o que vem do
// localStorage (ou de um JSON importado) e o app.
//
// Sem esta camada, um valor corrompido no storage quebra a renderização
// (TypeError em renderLibSelects/renderContextChips) e, no caso de JSON
// inválido, derrubava o init() inteiro — a página ficava sem nenhum event
// handler. Pior: o saveAll() do fim do init gravava o reset por cima dos
// dados do usuário.
//
// Funções puras, sem DOM. Carregado como script global (o mesmo padrão de
// prompts.js/llm.js) e exportado para Node em test/store_test.js.

const STORE_SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const STORE_LANGS = ['en', 'pt'];
const STORE_FALLBACK_NAME = 'Vaga nova';

/* Tetos anti-DoS: um backup hostil com 500 seções ou 10 mil mensagens
 * congelaria a render (um <option>/div por item) e estouraria a cota no
 * próximo saveAll — e o estado persistido travaria TODO load seguinte.
 * 200 seções / 200 msgs recentes é folga ampla para uso real. */
const STORE_MAX_CHAT = 200;
const STORE_MAX_SECTIONS = 200;
/* Uploads de arquivo (master/template/tex via FileReader): sem teto, um
 * arquivo de GBs vai inteiro para a RAM e depois para o localStorage. */
const STORE_MAX_FILE_BYTES = 8 * 1024 * 1024;

function isFileTooBig(size) {
  return typeof size === 'number' && isFinite(size) && size > STORE_MAX_FILE_BYTES;
}

function isStoreObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/* Só strings são texto de verdade: número/objeto num campo de texto é
 * corrupção, não valor. */
function storeText(value) {
  return typeof value === 'string' ? value : '';
}

function storeTime(value) {
  return typeof value === 'number' && isFinite(value) && value > 0 ? value : Date.now();
}

/* Os ids de seção/biblioteca entram em querySelector e em <option value>;
 * só o alfabeto seguro passa. */
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

/* Lê uma chave JSON do storage sem lançar. Distingue "não existe" de
 * "existe mas não parseia" — o segundo caso é o que não pode ser
 * sobrescrito com um reset. */
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

/* Guarda o valor bruto sob <chave>.backup uma única vez: sobrescrever a
 * chave com um reset destrói a evidência e impede o usuário de recuperar. */
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
  /* Histórico hostil (milhares de msgs) vira milhares de divs no render e
   * trava a aba em todo load: mantém só as mais recentes. */
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
    chat: normalizeChat(src.chat),
    updatedAt: storeTime(src.updatedAt),
  };
}

/* Mapa de seções em null-prototype: um id "__proto__" vindo de um JSON
 * adulterado vira uma propriedade comum em vez de pollutar o prototype.
 * `max` (só usado no import) limita o tamanho do lote: sem ele, um backup
 * com milhares de seções congela o render e persiste o congelamento. */
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

/* Une itens importados sem expulsar os locais quando o teto é atingido: o
 * slice(-max) antigo trocava a biblioteca do usuário pela do backup. */
function mergeLibraryList(local, incoming, kind, max) {
  const target = Array.isArray(local) ? local.slice() : [];
  const taken = target.map((e) => e.id);
  const source = Array.isArray(incoming) ? incoming : [];
  let added = 0;
  let skipped = 0;
  source.forEach((raw) => {
    if (!isStoreObject(raw)) { skipped++; return; }
    if (isStoreSafeId(raw.id) && taken.indexOf(raw.id) !== -1) { skipped++; return; }
    if (target.length >= max) { skipped++; return; }
    target.push(normalizeLibraryEntry(raw, kind, taken));
    added++;
  });
  return { merged: target, added: added, skipped: skipped };
}

/* Whitelist estrita: só o modelo e as chaves/urls de vendors conhecidos
 * passam, então um backup não injeta router, URL de terceiros ou campos
 * extras no config. */
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
  return { model: model, keys: keys, urls: urls };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    STORE_LANGS: STORE_LANGS,
    STORE_MAX_CHAT: STORE_MAX_CHAT,
    STORE_MAX_SECTIONS: STORE_MAX_SECTIONS,
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
