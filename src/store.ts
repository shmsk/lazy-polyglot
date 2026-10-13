import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chmodSync, mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { Concept, Config, FalseFriend, State, Word, WordMapping, WordState } from "./types.ts";
import { grammarKey, type GrammarItem } from "./grammar.ts";
import { patternKey, type Pattern } from "./patterns.ts";
import { numberKey, type NumberRule } from "./numbers.ts";
import { stepOf } from "./ladder.ts";
import { DATA_DIR_NAME } from "./migrate.ts";

// LANGCOUCH_DIR is the old name of LAZY_POLYGLOT_DIR and keeps working.
// The ~/.langcouch move runs in cli.ts, not here: importing helpers (the wordlist validator, evals) must never touch user data.
export const DATA_DIR = process.env.LAZY_POLYGLOT_DIR ?? process.env.LANGCOUCH_DIR ?? join(homedir(), DATA_DIR_NAME);
const CONFIG_PATH = () => join(DATA_DIR, "config.json");
/** A language code never names a path: no separators, no "..". Legit codes (pt-BR, es-419) pass untouched. */
const pathSafe = (lang: string) => !/[/\\]|\.\./.test(lang);
const STATE_PATH = (lang: string) => {
  if (!pathSafe(lang)) throw new Error(`lazy-polyglot: "${lang}" is not a language code`);
  return join(DATA_DIR, `state.${lang}.json`);
};

export const DEFAULT_CONFIG: Config = { lang: "es", native: "en", level: 2 };

/**
 * Write JSON through a temp file and a rename, so a crash, a second session or a sync client
 * never sees half a file. The temp name never matches state.<lang>.json.
 */
export function writeJsonAtomic(path: string, data: unknown): void {
  // A symlinked file (someone syncing it elsewhere) is written at its target, keeping its mode.
  const target = existsSync(path) ? realpathSync(path) : path;
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : null;
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  if (mode !== null) chmodSync(tmp, mode);
  renameSync(tmp, target);
}

export function readJson<T>(path: string, what: string): T {
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`lazy-polyglot: ${what} at ${path} is not valid JSON — fix or delete it and run \`lazy-polyglot init\``);
  }
}

export function initConfig(overrides: Partial<Config> = {}): { config: Config; created: boolean } {
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(CONFIG_PATH())) {
    return { config: loadConfig(), created: false }; // idempotent: never clobber
  }
  const config: Config = { ...DEFAULT_CONFIG, ...overrides };
  writeJsonAtomic(CONFIG_PATH(), config);
  return { config, created: true };
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH())) {
    throw new Error(`lazy-polyglot: no config at ${CONFIG_PATH()} — run \`lazy-polyglot init\` first`);
  }
  const cfg = readJson<Config>(CONFIG_PATH(), "config");
  if (typeof cfg.level !== "number" || cfg.level < 1 || cfg.level > 10) {
    throw new Error(`lazy-polyglot: config level must be 1..10, got ${String(cfg.level)}`);
  }
  return cfg;
}

export function saveConfig(config: Config): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeJsonAtomic(CONFIG_PATH(), config);
}

/** One state file as it is on disk (a variant's file holds only its own keys). */
export function readStateFile(lang: string): State {
  if (!existsSync(STATE_PATH(lang))) return {};
  return readJson<State>(STATE_PATH(lang), `state ${lang}`);
}

export function writeStateFile(lang: string, state: State): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeJsonAtomic(STATE_PATH(lang), state);
}

/** Two records of one word, folded without losing progress (legacy variant files met their base). */
export function mergeWordState(a: WordState | undefined, b: WordState | undefined): WordState | undefined {
  if (!a || !b) return a ?? b;
  const recalls = Math.max(a.recalls ?? 0, b.recalls ?? 0);
  // ladder fields travel together, from the record that climbed higher; a record from before
  // the ladder counts at the step the ladder would give it (an absorbed word is not step 0)
  const ladder = stepOf(b) > stepOf(a) ? b : a;
  return {
    exposures: Math.max(a.exposures, b.exposures),
    lastSeen: a.lastSeen > b.lastSeen ? a.lastSeen : b.lastSeen,
    ...(recalls > 0 ? { recalls } : {}),
    ...(ladder.step !== undefined ? { step: ladder.step } : {}),
    ...(ladder.due !== undefined ? { due: ladder.due } : {}),
    ...(ladder.missed ? { missed: ladder.missed } : {}),
  };
}

/**
 * Concept ids a regional variant spells exactly like its base, or null for a plain code
 * (or a variant whose wordlists are missing — then its state file stands alone, as before).
 * Their progress lives in the base's state file, one pool for both codes: someone who
 * learned `es` and switches to `es-419` keeps casa, and only carro/computadora/… start fresh.
 * Grammar works the same way: base constructions the variant's overlay leaves alone are
 * shared as their "g:" keys. Everything else (regional words and constructions) stays in
 * the variant's own file.
 */
export function sharedWithBase(lang: string): Set<string> | null {
  const code = normalizeLang(lang);
  const base = baseLang(code);
  if (!base || !wordlistPath(code) || !wordlistPath(base)) return null;
  const [basePath, ownPath] = wordlistLayers(code) as [string, string];
  const baseMap = readJson<WordMapping>(basePath, `wordlist ${base}`);
  const ownMap = readJson<WordMapping>(ownPath, `wordlist ${code}`);
  const shared = new Set(Object.keys(baseMap).filter((id) => ownMap[id] === undefined || ownMap[id] === baseMap[id]));
  const overridden = new Set(grammarFile(code).map((g) => g.id));
  for (const g of grammarFile(base)) if (!overridden.has(g.id)) shared.add(grammarKey(g.id));
  const ownRules = new Set(patternsFile(code).map((p) => p.id));
  for (const p of patternsFile(base)) if (!ownRules.has(p.id)) shared.add(patternKey(p.id));
  const ownNumberRules = new Set(numberRulesFile(code).map((r) => r.id));
  for (const r of numberRulesFile(base)) if (!ownNumberRules.has(r.id)) shared.add(numberKey(r.id));
  return shared;
}

export function loadState(lang: string): State {
  const own = readStateFile(lang);
  const shared = sharedWithBase(lang);
  if (!shared) return own;
  const base = readStateFile(baseLang(normalizeLang(lang))!);
  const state: State = {};
  for (const [key, s] of Object.entries(own)) if (!shared.has(key)) state[key] = s;
  for (const id of shared) {
    const s = mergeWordState(base[id], own[id]);
    if (s) state[id] = s;
  }
  return state;
}

export function saveState(lang: string, state: State): void {
  const shared = sharedWithBase(lang);
  if (!shared) return writeStateFile(lang, state);
  const baseCode = baseLang(normalizeLang(lang))!;
  const base = readStateFile(baseCode);
  const own: State = {};
  let touchedBase = false;
  for (const [key, s] of Object.entries(state)) {
    if (shared.has(key)) {
      base[key] = s;
      touchedBase = true;
    } else own[key] = s;
  }
  if (touchedBase) writeStateFile(baseCode, base);
  writeStateFile(lang, own); // shared entries leave the variant file: a legacy copy is folded in once
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Bundled language data lives in data/ so the repo root stays short.
const BUNDLED = join(REPO_ROOT, "data");
export const WORDLISTS_DIR = join(BUNDLED, "wordlists");
const GRAMMAR_DIR = join(BUNDLED, "grammar");
// User-added languages live next to progress, so they survive plugin updates
// (the plugin itself is replaced wholesale per version). A user file overrides a bundled one.
export const USER_WORDLISTS_DIR = join(DATA_DIR, "wordlists");
const USER_GRAMMAR_DIR = join(DATA_DIR, "grammar");
const PATTERNS_DIR = join(BUNDLED, "patterns");
const USER_PATTERNS_DIR = join(DATA_DIR, "patterns");
const FALSE_FRIENDS_DIR = join(BUNDLED, "falseFriends");
const USER_FALSE_FRIENDS_DIR = join(DATA_DIR, "falseFriends");
const NUMBERS_DIR = join(BUNDLED, "numbers");
const USER_NUMBERS_DIR = join(DATA_DIR, "numbers");
const READINGS_DIR = join(BUNDLED, "readings");
const USER_READINGS_DIR = join(DATA_DIR, "readings");
const IRREGULAR_DIR = join(BUNDLED, "irregular");
const USER_IRREGULAR_DIR = join(DATA_DIR, "irregular");
export const CONCEPTS_PATH = join(BUNDLED, "concepts.json");
export const HOMOGRAPHS_PATH = join(BUNDLED, "homographs.json");
const CHANGELOG_PATH = join(REPO_ROOT, "CHANGELOG.md");

/** Version of the installed plugin, from its package.json. */
export const PLUGIN_VERSION: string = readJson<{ version: string }>(join(REPO_ROOT, "package.json"), "package.json").version;

/**
 * The changelog entries for one version, one line each, markdown emphasis stripped;
 * [] when CHANGELOG.md or the section is missing. Continuation lines join their bullet.
 */
export function changelogFor(version: string, path: string = CHANGELOG_PATH): string[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    const item = line.match(/^(?:- |(\d+)\. )(.*)$/); // bullets, and numbered Upgrade notes steps
    if (item) items.push((item[1] ? `${item[1]}. ` : "") + item[2]!.trim());
    else if (/^\s+\S/.test(line) && items.length > 0) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items.map((i) => i.replace(/\*/g, ""));
}

let conceptsCache: Concept[] | null = null;

/** All concepts (language-independent meanings). Cached per process. */
export function loadConcepts(): Concept[] {
  if (!conceptsCache) conceptsCache = readJson<Concept[]>(CONCEPTS_PATH, "concepts");
  return conceptsCache;
}

/**
 * Canonical spelling of a language code, BCP 47 style: base lowercase, region uppercase,
 * anything else lowercase ("PT_br" → "pt-BR"). File names and state keys use this form.
 * Friendly aliases resolve first, for codes nobody can guess ("latam" → "es-419").
 */
const LANG_ALIASES: Record<string, string> = { latam: "es-419" };

export function normalizeLang(code: string): string {
  const alias = LANG_ALIASES[code.trim().toLowerCase()];
  if (alias) return alias;
  const [base = "", ...rest] = code.trim().split(/[-_]/);
  const tail = rest.map((t) => (/^([a-z]{2}|\d{3})$/i.test(t) ? t.toUpperCase() : t.toLowerCase()));
  return [base.toLowerCase(), ...tail].join("-");
}

/** Base language of a regional variant ("pt-BR" → "pt"); null for a plain code. */
export function baseLang(lang: string): string | null {
  const i = lang.indexOf("-");
  return i > 0 ? lang.slice(0, i) : null;
}

/**
 * Lemmas of this language that are also English words (it: via, fine, due), lowercased;
 * empty when the language has none or the file is missing. data/homographs.json is generated
 * by scripts/homographs.ts.
 */
export function loadHomographs(lang: string): Set<string> {
  if (!existsSync(HOMOGRAPHS_PATH)) return new Set();
  return new Set(readJson<Record<string, string[]>>(HOMOGRAPHS_PATH, "homographs")[normalizeLang(lang)] ?? []);
}

/** First existing `<lang>.json`: the user dir wins over the bundled one. */
function resolveData(userDir: string, bundledDir: string, lang: string): string | null {
  if (!pathSafe(lang)) return null;
  for (const dir of [userDir, bundledDir]) {
    const path = join(dir, `${normalizeLang(lang)}.json`);
    if (existsSync(path)) return path;
  }
  return null;
}

/** Path of the wordlist file for exactly this code (for a variant: its overlay), or null. */
export function wordlistPath(lang: string): string | null {
  return resolveData(USER_WORDLISTS_DIR, WORDLISTS_DIR, lang);
}

/**
 * Files that make up a language, base first. A regional variant (`pt-BR`) is a sparse
 * overlay: only the words that differ from its base (`pt`), which supplies the rest.
 */
export function wordlistLayers(lang: string): string[] {
  const own = wordlistPath(lang);
  if (!own) {
    throw new Error(`lazy-polyglot: no wordlist for "${lang}" in ${USER_WORDLISTS_DIR} or ${WORDLISTS_DIR}`);
  }
  const base = baseLang(normalizeLang(lang));
  if (!base) return [own];
  const basePath = wordlistPath(base);
  if (!basePath) {
    throw new Error(`lazy-polyglot: "${lang}" is a variant of "${base}", but there is no ${base} wordlist to build on`);
  }
  return [basePath, own];
}

/** Raw concept→lemma mapping for a language (a variant's overlay merged over its base). */
export function loadWordMapping(lang: string): WordMapping {
  const layers = wordlistLayers(lang).map((path) => readJson<WordMapping>(path, `wordlist ${lang}`));
  return Object.assign({}, ...layers) as WordMapping;
}

/** Pronunciations (concept id → IPA) for exactly this code; {} when there is no file. */
function readingsFile(lang: string): Record<string, string> {
  const path = resolveData(USER_READINGS_DIR, READINGS_DIR, lang);
  return path ? readJson<Record<string, string>>(path, `readings ${lang}`) : {};
}

/** Pronunciations for a language; a variant's file overlays its base's, like the wordlist. */
export function loadReadings(lang: string): Record<string, string> {
  const base = baseLang(normalizeLang(lang));
  return { ...(base ? readingsFile(base) : {}), ...readingsFile(lang) };
}

/** Irregular verb forms (concept id → forms) for exactly this code; {} when there is no file. */
function irregularFile(lang: string): Record<string, string[]> {
  const path = resolveData(USER_IRREGULAR_DIR, IRREGULAR_DIR, lang);
  return path ? readJson<Record<string, string[]>>(path, `irregular ${lang}`) : {};
}

/**
 * Forms of irregular verbs that share no root with the lemma (essere → è, sono; to go → went),
 * so a reply that wove one still counts. A variant's file overlays its base's, like readings.
 */
export function loadIrregular(lang: string): Record<string, string[]> {
  const base = baseLang(normalizeLang(lang));
  return { ...(base ? irregularFile(base) : {}), ...irregularFile(lang) };
}

/** Concepts joined with their lemmas in the target language, in rank order (most useful first; unranked keep file order, last). */
export function loadWordlist(lang: string): Word[] {
  const mapping = loadWordMapping(lang);
  const readings = loadReadings(lang);
  const base = baseLang(normalizeLang(lang));
  const baseMapping = base ? loadWordMapping(base) : {};
  const code = normalizeLang(lang);
  const rude = new Map(
    (base ? loadFalseFriends(base) : [])
      .filter((f) => f.register === "vulgar" && f.vulgarIn?.includes(code))
      .map((f) => [f.target, f.note ?? `vulgar in ${regionName(code)}`]),
  );
  const concepts = new Map(loadConcepts().map((c) => [c.id, c]));
  const words: Word[] = [];
  for (const [id, lemma] of Object.entries(mapping)) {
    const c = concepts.get(id);
    if (!c) throw new Error(`lazy-polyglot: wordlist ${lang} maps unknown concept "${id}" — run tests/validate-wordlist.ts`);
    const baseTarget = baseMapping[id];
    const differs = baseTarget !== undefined && baseTarget !== lemma;
    const baseNote = differs ? rude.get(baseTarget) : undefined;
    const ipa = readings[id];
    words.push({ id, target: lemma, pos: c.pos, tier: c.tier, ...(c.rank !== undefined ? { rank: c.rank } : {}), gloss: c.gloss, ...(c.alt ? { alt: c.alt } : {}), ...(differs ? { baseTarget } : {}), ...(baseNote ? { baseNote } : {}), ...(ipa ? { ipa } : {}) });
  }
  // every algorithm and the placement cards take new words in list order, so ranking happens once, here
  return words.sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER));
}

/** False friends and rude words for exactly this code; [] when there is no file. */
export function loadFalseFriends(lang: string): FalseFriend[] {
  const path = resolveData(USER_FALSE_FRIENDS_DIR, FALSE_FRIENDS_DIR, lang);
  return path ? readJson<FalseFriend[]>(path, `falseFriends ${lang}`) : [];
}

/** False friends that concern a learner of `lang`: its own file plus, for a variant, its base's. */
export function falseFriendsFor(lang: string): FalseFriend[] {
  const base = baseLang(normalizeLang(lang));
  return [...(base ? loadFalseFriends(base) : []), ...loadFalseFriends(lang)];
}

function patternsFile(lang: string): Pattern[] {
  const path = resolveData(USER_PATTERNS_DIR, PATTERNS_DIR, lang);
  return path ? readJson<Pattern[]>(path, `patterns ${lang}`) : [];
}

/** Word-building rules for a language, in teaching order; a variant's file overlays its base's by id. */
export function loadPatterns(lang: string): Pattern[] {
  const base = baseLang(normalizeLang(lang));
  const own = patternsFile(lang);
  if (!base) return own;
  const byId = new Map(patternsFile(base).map((p) => [p.id, p]));
  for (const p of own) byId.set(p.id, p);
  return [...byId.values()];
}

function numberRulesFile(lang: string): NumberRule[] {
  const path = resolveData(USER_NUMBERS_DIR, NUMBERS_DIR, lang);
  return path ? readJson<NumberRule[]>(path, `numbers ${lang}`) : [];
}

/** How numbers are built in a language, in teaching order; a variant's file overlays its base's by id. */
export function loadNumberRules(lang: string): NumberRule[] {
  const base = baseLang(normalizeLang(lang));
  const own = numberRulesFile(lang);
  if (!base) return own;
  const byId = new Map(numberRulesFile(base).map((r) => [r.id, r]));
  for (const r of own) byId.set(r.id, r);
  return [...byId.values()];
}

const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" });

/** English name of a variant's region ("es-419" → "Latin America"); the code itself when unknown. */
function regionName(code: string): string {
  const region = code.split("-")[1];
  try {
    return (region && REGION_NAMES.of(region)) || code;
  } catch {
    return code;
  }
}

/** Constructions from exactly this code's grammar file (for a variant: its overlay); [] when there is none. */
function grammarFile(lang: string): GrammarItem[] {
  const path = resolveData(USER_GRAMMAR_DIR, GRAMMAR_DIR, lang);
  return path ? readJson<GrammarItem[]>(path, `grammar ${lang}`) : [];
}

/**
 * Grammar constructions for a language; [] when none exists. A variant's file is an
 * overlay, like its wordlist: an item with a base id replaces that item in place,
 * a new id is added after the base's.
 */
export function loadGrammar(lang: string): GrammarItem[] {
  const base = baseLang(normalizeLang(lang));
  const own = grammarFile(lang);
  if (!base) return own;
  const byId = new Map(grammarFile(base).map((g) => [g.id, g]));
  for (const g of own) byId.set(g.id, g);
  return [...byId.values()];
}

function langsIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length));
}

/** Language codes the user added in ~/.lazy-polyglot/wordlists/. */
export function userLangs(): string[] {
  return langsIn(USER_WORDLISTS_DIR).sort();
}

/** Every usable language code: bundled plus user-added, deduped. */
export function availableLangs(): string[] {
  return [...new Set([...langsIn(WORDLISTS_DIR), ...langsIn(USER_WORDLISTS_DIR)])].sort();
}

/** Language codes that have accumulated local state (scan of state.<lang>.json). */
export function langsWithState(): string[] {
  if (!existsSync(DATA_DIR)) return [];
  return readdirSync(DATA_DIR)
    .map((f) => /^state\.([a-z]+(?:-[A-Za-z0-9]+)*)\.json$/.exec(f)?.[1])
    .filter((l): l is string => Boolean(l))
    .sort();
}
