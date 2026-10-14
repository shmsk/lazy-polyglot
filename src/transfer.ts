import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config, State, WordState } from "./types.ts";
import { isWordKey } from "./types.ts";
import {
  DATA_DIR, PLUGIN_VERSION, WORDLISTS_DIR, availableLangs, baseLang, langsWithState, loadConcepts, mergeWordState,
  normalizeLang, readJson, readStateFile, sharedWithBase, writeJsonAtomic, writeStateFile,
} from "./store.ts";
import { validateTopic, type Topic } from "./topics.ts";

/**
 * Moving progress between machines: `export` packs ~/.lazy-polyglot into one JSON file,
 * `import` merges such a file into the local data. Merging takes the best of both sides
 * per word (the same fold variant files get), so it never lowers anything, and importing
 * the same file again, or sending it back, changes nothing.
 */

export const BUNDLE_FORMAT = "langcouch-export";
export const BUNDLE_VERSION = 1;

/** The user's own data files next to progress; each folder holds <lang>.json files, topics hold <lang>.<name>.json. */
const USER_DIRS = ["wordlists", "grammar", "patterns", "falseFriends", "numbers", "readings", "senses", "topics"] as const;
type UserDir = (typeof USER_DIRS)[number];

export interface Bundle {
  format: typeof BUNDLE_FORMAT;
  formatVersion: number;
  pluginVersion: string;
  exportedAt: string;
  config: Config | null;
  /** Raw state files, keyed by language code, exactly as they are on disk. */
  states: Record<string, State>;
  user: Record<UserDir, Record<string, unknown>>;
}

// Language codes and file names come from the bundle and end up in paths and in the
// config the hook reads, so only plain codes are allowed.
const SAFE_LANG = /^[a-z]+(?:-[A-Za-z0-9]+)*$/;
const SAFE_TOPIC = /^([a-z]+(?:-[A-Za-z0-9]+)*)\.[a-z0-9][a-z0-9-]{0,40}$/;
const safeName = (dir: UserDir, name: string) => (dir === "topics" ? SAFE_TOPIC.test(name) : SAFE_LANG.test(name));

const configPath = () => join(DATA_DIR, "config.json");
const has = (o: object, k: string) => Object.hasOwn(o, k);

/** The bundle, plus user files left out because their name is not a language code. */
export function exportBundle(now: Date = new Date()): { bundle: Bundle; skipped: string[] } {
  const config = existsSync(configPath()) ? readJson<Config>(configPath(), "config") : null;
  const states: Record<string, State> = {};
  for (const lang of langsWithState()) states[lang] = readStateFile(lang);
  const user = {} as Bundle["user"];
  const skipped: string[] = [];
  for (const dir of USER_DIRS) {
    user[dir] = {};
    const path = join(DATA_DIR, dir);
    if (!existsSync(path)) continue;
    for (const f of readdirSync(path).filter((f) => f.endsWith(".json"))) {
      const name = f.slice(0, -".json".length);
      if (!safeName(dir, name)) skipped.push(`${dir}/${f}`);
      else user[dir][name] = readJson<unknown>(join(path, f), `${dir}/${f}`);
    }
  }
  return { bundle: { format: BUNDLE_FORMAT, formatVersion: BUNDLE_VERSION, pluginVersion: PLUGIN_VERSION, exportedAt: now.toISOString(), config, states, user }, skipped };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;
const optCount = (v: unknown) => v === undefined || count(v);
const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
const isTime = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));

function validRecord(v: unknown): v is WordState {
  return (
    isObject(v) &&
    count(v.exposures) &&
    (v.lastSeen === "" || isTime(v.lastSeen)) &&
    optCount(v.recalls) && optCount(v.step) && optCount(v.missed) &&
    (v.due === undefined || isTime(v.due))
  );
}

function validConfig(c: unknown): c is Config {
  return (
    isObject(c) &&
    typeof c.lang === "string" && SAFE_LANG.test(c.lang) && normalizeLang(c.lang) === c.lang &&
    typeof c.native === "string" && SAFE_LANG.test(c.native) &&
    typeof c.level === "number" && Number.isInteger(c.level) && c.level >= 1 && c.level <= 10 &&
    (c.algorithm === undefined || c.algorithm === 1 || c.algorithm === 2 || c.algorithm === 3) &&
    (c.enabled === undefined || typeof c.enabled === "boolean") &&
    (c.spinner === undefined || typeof c.spinner === "boolean") &&
    (c.seenVersion === undefined || typeof c.seenVersion === "string") &&
    (c.nativeAsked === undefined || typeof c.nativeAsked === "boolean") &&
    (c.placementSkipped === undefined || (isObject(c.placementSkipped) && Object.values(c.placementSkipped).every(strings))) &&
    (c.placementOffered === undefined || strings(c.placementOffered)) &&
    (c.cardsStatus === undefined || typeof c.cardsStatus === "boolean") &&
    (c.reading === undefined || (isObject(c.reading) && Object.entries(c.reading).every(([lang, m]) => SAFE_LANG.test(lang) && (m === "off" || m === "native" || m === "ipa")))) &&
    (c.readingAsked === undefined || strings(c.readingAsked)) &&
    (c.milestones === undefined || typeof c.milestones === "boolean") &&
    (c.milestoneLog === undefined || (isObject(c.milestoneLog) && Object.entries(c.milestoneLog).every(([lang, l]) => SAFE_LANG.test(lang) && isObject(l) && typeof l.words === "number" && isObject(l.topics) && typeof l.weekAt === "string" && typeof l.weekBase === "number")))
  );
}

/** A user file must have the shape the loaders expect, or it would break the language it overrides. */
function validUserFile(dir: UserDir, content: unknown, concepts: Set<string>, name = ""): boolean {
  if (dir === "topics") return isObject(content) && validateTopic(content as unknown as Topic, name.split(".")[0]!, concepts).length === 0;
  if (dir === "senses") return isObject(content) && Object.entries(content).every(([id, list]) => concepts.has(id) && Array.isArray(list) && list.every((x) => isObject(x) && typeof x.id === "string" && (x.use === "weave" || x.use === "accept")));
  if (dir === "wordlists" || dir === "readings") return isObject(content) && Object.entries(content).every(([id, value]) => concepts.has(id) && typeof value === "string" && value.length > 0);
  if (!Array.isArray(content) || !content.every(isObject)) return false;
  return dir === "falseFriends" || content.every((item) => typeof item.id === "string");
}

/** Checks a parsed file is a bundle this version can read; throws with the first problem found. */
export function parseBundle(raw: unknown): Bundle {
  const bad = (why: string): never => {
    throw new Error(`lazy-polyglot: not a usable Lazy Polyglot export (${why}) — nothing was imported`);
  };
  if (!isObject(raw) || raw.format !== BUNDLE_FORMAT) bad("wrong format field");
  const b = raw as Record<string, unknown>;
  if (!Number.isInteger(b.formatVersion) || (b.formatVersion as number) < 1) bad("no formatVersion");
  if ((b.formatVersion as number) > BUNDLE_VERSION) {
    throw new Error(`lazy-polyglot: this export is format ${String(b.formatVersion)}, made by Lazy Polyglot ${String(b.pluginVersion)}; update Lazy Polyglot to import it — nothing was imported`);
  }
  if (b.config !== null && b.config !== undefined && !validConfig(b.config)) bad("broken config");
  if (!isObject(b.states)) bad("no states");
  for (const [lang, state] of Object.entries(b.states as Record<string, unknown>)) {
    if (!SAFE_LANG.test(lang)) bad(`bad language code "${lang}"`);
    if (!isObject(state)) bad(`state ${lang} is not an object`);
    for (const [key, rec] of Object.entries(state as Record<string, unknown>)) {
      if (key === "__proto__") bad(`state ${lang} has a "__proto__" key`);
      if (!validRecord(rec)) bad(`state ${lang}, "${key}" is malformed`);
    }
  }
  const user = isObject(b.user) ? b.user : {};
  const concepts = new Set(loadConcepts().map((c) => c.id));
  for (const dir of USER_DIRS) {
    const files = user[dir] ?? {};
    if (!isObject(files)) bad(`user ${dir} is not an object`);
    for (const [name, content] of Object.entries(files as Record<string, unknown>)) {
      if (!safeName(dir, name)) bad(`bad file name "${dir}/${name}"`);
      if (!validUserFile(dir, content, concepts, name)) bad(`${dir}/${name}.json has the wrong shape`);
    }
  }
  const out = { ...(b as unknown as Bundle), config: (b.config as Config | undefined) ?? null, user: {} as Bundle["user"] };
  for (const dir of USER_DIRS) out.user[dir] = (user[dir] as Record<string, unknown> | undefined) ?? {};
  return out;
}

/** Same progress, ignoring key order and absent-versus-zero counters. */
function sameRecord(a: WordState, b: WordState): boolean {
  return (
    a.exposures === b.exposures && a.lastSeen === b.lastSeen &&
    (a.recalls ?? 0) === (b.recalls ?? 0) && a.step === b.step && a.due === b.due && (a.missed ?? 0) === (b.missed ?? 0)
  );
}

/** Folds `incoming` into `local`: every key ends at the best of both. Pure. */
export function mergeStates(local: State, incoming: State): { state: State; added: string[]; advanced: string[] } {
  const state: State = { ...local };
  const added: string[] = [];
  const advanced: string[] = [];
  for (const [key, rec] of Object.entries(incoming)) {
    if (key === "__proto__") continue;
    const mine = has(local, key) ? local[key] : undefined;
    if (!mine) {
      state[key] = rec;
      added.push(key);
      continue;
    }
    const merged = mergeWordState(mine, rec)!;
    if (!sameRecord(merged, mine)) {
      state[key] = merged;
      advanced.push(key);
    }
  }
  return { state, added, advanced };
}

/**
 * Bundle states regrouped by the file they belong in here: a variant's keys it shares with
 * its base go to the base file, as saveState would put them. An old export may still carry
 * them in the variant's file; left there, plain-base learners here would never see them.
 */
function byLocalFile(states: Record<string, State>): Map<string, State> {
  const files = new Map<string, State>();
  const put = (lang: string, key: string, rec: WordState) => {
    const file = files.get(lang) ?? {};
    file[key] = has(file, key) ? mergeWordState(file[key], rec)! : rec;
    files.set(lang, file);
  };
  for (const [lang, state] of Object.entries(states)) {
    let shared: Set<string> | null = null;
    try {
      shared = sharedWithBase(lang);
    } catch {
      shared = null; // wordlists unreadable here: keep the file as it came
    }
    const base = shared ? baseLang(normalizeLang(lang))! : null;
    if (!files.has(lang)) files.set(lang, {});
    for (const [key, rec] of Object.entries(state)) put(base && shared!.has(key) ? base : lang, key, rec);
  }
  return files;
}

const canonical = (v: unknown) => JSON.stringify(v, (_k, x) => (isObject(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

export interface ImportReport {
  /** Per language: words and constructions new here, and ones that moved up. */
  langs: { lang: string; added: number; advanced: number; addedWords: number; advancedWords: number }[];
  configTaken: boolean;
  userFilesAdded: string[];
  /** Added user wordlists that replace a built-in language of the same code. */
  overridesBuiltIn: string[];
  /** User files that differ locally; the local copy was kept. */
  conflicts: string[];
  backupDir: string | null;
}

export function importBundle(bundle: Bundle, opts: { takeConfig?: boolean; now?: Date } = {}): ImportReport {
  const now = opts.now ?? new Date();
  // Work everything out first; files are touched only once all of it is known.
  const stateWrites: [string, State][] = [];
  const langs: ImportReport["langs"] = [];
  for (const [lang, incoming] of byLocalFile(bundle.states)) {
    const { state, added, advanced } = mergeStates(readStateFile(lang), incoming);
    if (added.length + advanced.length === 0) continue;
    stateWrites.push([lang, state]);
    langs.push({
      lang,
      added: added.length,
      advanced: advanced.length,
      addedWords: added.filter(isWordKey).length,
      advancedWords: advanced.filter(isWordKey).length,
    });
  }

  const haveConfig = existsSync(configPath());
  const configTaken = bundle.config !== null && (opts.takeConfig === true || !haveConfig) &&
    !(haveConfig && canonical(readJson(configPath(), "config")) === canonical(bundle.config));
  if (configTaken) {
    const lang = bundle.config!.lang;
    if (!availableLangs().includes(lang) && !has(bundle.user.wordlists, lang)) {
      throw new Error(`lazy-polyglot: the export's settings use "${lang}", which this Lazy Polyglot does not have; update Lazy Polyglot, or import without --config — nothing was imported`);
    }
  }

  const userWrites: [string, unknown][] = [];
  const userFilesAdded: string[] = [];
  const overridesBuiltIn: string[] = [];
  const conflicts: string[] = [];
  for (const dir of USER_DIRS) {
    for (const [name, content] of Object.entries(bundle.user[dir])) {
      const path = join(DATA_DIR, dir, `${name}.json`);
      const label = `${dir}/${name}.json`;
      if (!existsSync(path)) {
        userWrites.push([path, content]);
        userFilesAdded.push(label);
        if (dir === "wordlists" && existsSync(join(WORDLISTS_DIR, `${name}.json`))) overridesBuiltIn.push(name);
      } else if (canonical(readJson(path, label)) !== canonical(content)) {
        conflicts.push(label);
      }
    }
  }

  let backupDir: string | null = null;
  if (stateWrites.length + userWrites.length > 0 || configTaken) {
    backupDir = join(DATA_DIR, "backups", now.toISOString().replace(/[:.]/g, "-"));
    mkdirSync(backupDir, { recursive: true });
    for (const f of readdirSync(DATA_DIR)) {
      if (f === "config.json" || /^state\..+\.json$/.test(f)) copyFileSync(join(DATA_DIR, f), join(backupDir, f));
    }
  }

  // Fold once more against the file as it is right now: a session may have saved since.
  for (const [lang, state] of stateWrites) writeStateFile(lang, mergeStates(readStateFile(lang), state).state);
  if (configTaken) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeJsonAtomic(configPath(), bundle.config);
  }
  for (const [path, content] of userWrites) {
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomic(path, content);
  }
  return { langs, configTaken, userFilesAdded, overridesBuiltIn, conflicts, backupDir };
}

export function formatImportReport(r: ImportReport, from: string): string {
  const lines = [`Imported ${from}`];
  if (r.langs.length === 0 && !r.configTaken && r.userFilesAdded.length === 0) {
    lines.push("  nothing new: everything in it is already here");
  }
  for (const l of r.langs) {
    const other = l.added + l.advanced - l.addedWords - l.advancedWords;
    lines.push(`  ${l.lang}: words ${l.addedWords} new, ${l.advancedWords} moved up` + (other > 0 ? `; grammar and rules ${other} updated` : ""));
  }
  if (r.configTaken) lines.push("  settings: taken from the export");
  for (const f of r.userFilesAdded) {
    const code = f.startsWith("wordlists/") ? f.slice("wordlists/".length, -".json".length) : null;
    lines.push(`  added ${f}` + (code && r.overridesBuiltIn.includes(code) ? ` (it replaces the built-in ${code} wordlist)` : ""));
  }
  for (const f of r.conflicts) lines.push(`  kept your ${f} (the export has a different one)`);
  if (r.backupDir) lines.push(`  backup of the previous data: ${r.backupDir}`);
  return lines.join("\n");
}

export function formatExportSummary(b: Bundle, to: string, skipped: string[] = []): string {
  const langs = Object.entries(b.states).map(([lang, s]) => `${lang} (${Object.keys(s).filter(isWordKey).length} words)`);
  const extra = USER_DIRS.flatMap((d) => Object.keys(b.user[d]).map((n) => `${d}/${n}.json`));
  return [
    `Exported to ${to}`,
    `  progress: ${langs.length ? langs.join(", ") : "none yet"}`,
    ...(extra.length ? [`  your own files: ${extra.join(", ")}`] : []),
    ...(skipped.length ? [`  left out (name is not a language code): ${skipped.join(", ")}`] : []),
    "  On the other machine: lazy-polyglot import <this file>",
  ].join("\n");
}
