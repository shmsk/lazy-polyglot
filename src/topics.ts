import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import type { Pos, State, Word } from "./types.ts";
import { isAbsorbed, wordsPerResponse } from "./types.ts";
import { DATA_DIR, loadConcepts, loadWordlist, normalizeLang, readJson, writeJsonAtomic } from "./store.ts";

/**
 * Topics: the words for one real goal (a trip, an exam, a move), on top of the frequency
 * core. The agent builds the set (docs/Topics.md); this module stores, validates and
 * merges it. Files live next to progress, flat, so export/import carries them:
 * ~/.lazy-polyglot/topics/<lang>.<slug>.json
 */

export interface TopicEntry {
  /** Stable within the topic, [a-z0-9_]: the state key is topic.<slug>.<key> */
  key: string;
  /** The word or phrase in the target language */
  target: string;
  kind: "word" | "phrase";
  pos?: Pos;
  /** By native-language code ({ en, ru, uz }); at least one */
  gloss: Record<string, string>;
  /** Links the entry to a core concept: the core word and its progress are reused, nothing is duplicated */
  conceptId?: string;
  /** With conceptId: one of that word's other meanings (data/senses), woven in that meaning from the start (carta = menu for a trip) */
  sense?: string;
  /** Set by the pace check: doesn't fit before the deadline, taught only after the rest */
  waiting?: boolean;
}

export interface Topic {
  title: string;
  lang: string;
  /** Optional deadline, YYYY-MM-DD; the topic ends by itself after it */
  by?: string;
  /** Answers to the clarifying questions, kept so the set can be rebuilt or extended */
  context?: { place?: string; when?: string; purpose?: string; exam?: string; level?: string };
  createdAt: string;
  active: boolean;
  endedAt?: string;
  entries: TopicEntry[];
}

export interface TopicFile {
  slug: string;
  path: string;
  topic: Topic;
}

/** A file in the topics folder that can't be used, and why: listed by `topic list`, skipped by the hook. */
export interface BrokenTopic {
  slug: string;
  path: string;
  errors: string[];
}

export const TOPICS_DIR = () => join(DATA_DIR, "topics");
/** Active topics before the third needs a yes; the fourth is refused. */
export const TOPICS_SOFT_MAX = 2;
export const TOPICS_HARD_MAX = 3;
/** New entries a day the pace check allows; a tight deadline shortens the list instead. */
export const TOPIC_DAILY_NEW = 20;
/** Bold spans the reply checker reads are capped at 40 characters. */
export const PHRASE_MAX = 40;

const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;
const KEY = /^[a-z0-9_]{1,40}$/;
const KEY_SENSE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const POS = new Set<Pos>(["noun", "verb", "adj", "adv", "num"]);

export const topicId = (slug: string, key: string) => `topic.${slug}.${key}`;
/** True for a word that exists only in a topic (not a core concept). */
export const isTopicOnly = (w: Word) => w.id.startsWith("topic.");

const DAY_MS = 24 * 60 * 60 * 1000;
/** "1 phrase", "3 phrases" */
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Whole days from today to the deadline, counting today; 0 once it has passed. */
export function daysLeft(by: string, now: string): number {
  const end = Date.parse(`${by}T23:59:59`);
  return Math.max(0, Math.ceil((end - Date.parse(now)) / DAY_MS));
}

/** Running: switched on and not past its date. A passed date ends a topic without a write. */
export const isRunning = (t: Topic, now: string) => t.active && (!t.by || daysLeft(t.by, now) > 0);

export function topicPath(lang: string, slug: string): string {
  if (!SLUG.test(slug)) throw new Error(`lazy-polyglot: "${slug}" is not a topic name (a-z, 0-9, dashes)`);
  return join(TOPICS_DIR(), `${normalizeLang(lang)}.${slug}.json`);
}

/**
 * Every topic of a language on disk, oldest first, split into usable and broken. A broken file
 * (bad JSON, failed validation) never stops the hook: it is skipped there and shown by `topic list`.
 */
export function scanTopics(lang: string): { topics: TopicFile[]; broken: BrokenTopic[] } {
  const dir = TOPICS_DIR();
  const topics: TopicFile[] = [];
  const broken: BrokenTopic[] = [];
  if (!existsSync(dir)) return { topics, broken };
  const code = normalizeLang(lang);
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(`${code}.`) || !f.endsWith(".json")) continue;
    const slug = f.slice(code.length + 1, -".json".length);
    const path = join(dir, f);
    if (!SLUG.test(slug)) continue;
    let topic: Topic;
    try {
      topic = readJson<Topic>(path, "topic");
    } catch (e) {
      broken.push({ slug, path, errors: [(e as Error).message] });
      continue;
    }
    const errors = validateTopic(topic, code);
    if (errors.length) broken.push({ slug, path, errors });
    else topics.push({ slug, path, topic });
  }
  topics.sort((a, b) => a.topic.createdAt.localeCompare(b.topic.createdAt));
  return { topics, broken };
}

export const listTopics = (lang: string) => scanTopics(lang).topics;
export const runningTopics = (lang: string, now: string) => listTopics(lang).filter((f) => isRunning(f.topic, now));

export function saveTopic(lang: string, slug: string, topic: Topic): string {
  mkdirSync(TOPICS_DIR(), { recursive: true });
  const path = topicPath(lang, slug);
  writeJsonAtomic(path, topic);
  return path;
}

/** Everything wrong with a topic file, as readable lines; [] when it's fine. */
export function validateTopic(topic: Topic, lang: string, coreIds: Set<string> = new Set(loadConcepts().map((c) => c.id))): string[] {
  const errors: string[] = [];
  if (!topic || typeof topic !== "object") return ["not a JSON object"];
  if (typeof topic.title !== "string" || !topic.title.trim()) errors.push("title is missing");
  if (normalizeLang(String(topic.lang ?? "")) !== normalizeLang(lang)) errors.push(`lang is "${topic.lang}", expected "${lang}"`);
  if (topic.by !== undefined && (!DATE.test(topic.by) || Number.isNaN(Date.parse(topic.by)))) errors.push(`by "${topic.by}" is not YYYY-MM-DD`);
  if (!Array.isArray(topic.entries) || topic.entries.length === 0) return [...errors, "entries is empty"];
  const keys = new Set<string>();
  const concepts = new Set<string>();
  topic.entries.forEach((e, i) => {
    const at = `entry ${i + 1}${e?.key ? ` (${e.key})` : ""}`;
    if (!e || typeof e !== "object") return void errors.push(`${at}: not an object`);
    if (typeof e.key !== "string" || !KEY.test(e.key)) errors.push(`${at}: key must be a-z, 0-9 or _`);
    else if (keys.has(e.key)) errors.push(`${at}: duplicate key`);
    else keys.add(e.key);
    if (typeof e.target !== "string" || !e.target.trim()) errors.push(`${at}: target is missing`);
    else if (e.target.length > PHRASE_MAX) errors.push(`${at}: target is longer than ${PHRASE_MAX} characters`);
    if (e.kind !== "word" && e.kind !== "phrase") errors.push(`${at}: kind must be "word" or "phrase"`);
    if (e.pos !== undefined && !POS.has(e.pos)) errors.push(`${at}: bad pos "${e.pos}"`);
    const glosses = e.gloss && typeof e.gloss === "object" ? Object.values(e.gloss) : [];
    if (glosses.length === 0 || glosses.some((g) => typeof g !== "string" || !g.trim())) errors.push(`${at}: needs a gloss, e.g. { "en": "...", "ru": "..." }`);
    if (e.conceptId !== undefined) {
      if (!coreIds.has(e.conceptId)) errors.push(`${at}: conceptId "${e.conceptId}" is not a core concept`);
      else if (concepts.has(e.conceptId)) errors.push(`${at}: conceptId "${e.conceptId}" is used twice`);
      else concepts.add(e.conceptId);
    }
    if (e.sense !== undefined && (typeof e.sense !== "string" || !KEY_SENSE.test(e.sense) || e.conceptId === undefined)) errors.push(`${at}: sense must be a sense id of the word its conceptId names`);
  });
  return errors;
}

/**
 * Core words plus the words of running topics: what the hook, cards, placement and quiz teach.
 * Topic words come first (placement and cards follow list order); a topic entry linked to a
 * core concept marks that core word instead of adding a copy, so its progress carries over.
 * Waiting entries join only when nothing else of the topic is left to start.
 */
export function mergeTopics(core: Word[], topics: TopicFile[], state: State = {}): Word[] {
  if (topics.length === 0) return core;
  const byId = new Map(core.map((w) => [w.id, w]));
  const lead: Word[] = [];
  const marked = new Set<string>();
  for (const { slug, topic } of topics) {
    const started = (e: TopicEntry) => state[e.conceptId ?? topicId(slug, e.key)] !== undefined;
    const open = topic.entries.filter((e) => !e.waiting);
    const entries = open.every(started) ? topic.entries : open;
    for (const e of entries) {
      const base = e.conceptId ? byId.get(e.conceptId) : undefined;
      if (base) {
        if (marked.has(base.id)) continue;
        marked.add(base.id);
        const focus = e.sense && base.senses?.some((s) => s.id === e.sense) ? e.sense : undefined;
        lead.push({ ...base, topic: slug, ...(focus ? { focus } : {}) });
        continue;
      }
      lead.push({
        id: topicId(slug, e.key),
        target: e.target,
        pos: e.pos ?? "noun",
        tier: 1,
        gloss: e.gloss,
        topic: slug,
        ...(e.kind === "phrase" ? { phrase: true } : {}),
      });
    }
  }
  return [...lead, ...core.filter((w) => !marked.has(w.id))];
}

/** The learning list for a language: core plus running topics. Validation and `lang` keep using loadWordlist. */
export function loadLearningWords(lang: string, state: State = {}, now = new Date().toISOString()): Word[] {
  return mergeTopics(loadWordlist(lang), runningTopics(lang, now), state);
}

export interface TopicProgress {
  slug: string;
  title: string;
  total: number;
  passed: number;
  words: number;
  phrases: number;
  daysLeft: number | null;
}

/** "Passed" = absorbed on the ladder, the same bar core words use. */
export function topicProgress(file: TopicFile, state: State, now: string): TopicProgress {
  const ids = file.topic.entries.map((e) => ({ id: e.conceptId ?? topicId(file.slug, e.key), phrase: e.kind === "phrase" }));
  const passed = ids.filter((x) => isAbsorbed(state[x.id]));
  return {
    slug: file.slug,
    title: file.topic.title,
    total: ids.length,
    passed: passed.length,
    words: passed.filter((x) => !x.phrase).length,
    phrases: passed.filter((x) => x.phrase).length,
    daysLeft: file.topic.by ? daysLeft(file.topic.by, now) : null,
  };
}

export const topicLine = (p: TopicProgress) =>
  `Topic ${p.title}: ${p.passed}/${p.total} passed (${count(p.words, "word")}, ${count(p.phrases, "phrase")})` +
  (p.daysLeft === null ? "" : ` · ${count(p.daysLeft, "day")} left`);

/**
 * The pace check, run when a topic is added: with a deadline, keep what fits at
 * TOPIC_DAILY_NEW new entries a day (entries already known don't count) and mark
 * the rest waiting, in file order. Returns the topic and a one-line verdict.
 */
export function planPace(topic: Topic, slug: string, state: State, now: string): { topic: Topic; note: string } {
  const isNew = (e: TopicEntry) => !isAbsorbed(state[e.conceptId ?? topicId(slug, e.key)]);
  const fresh = topic.entries.filter(isNew).length;
  if (!topic.by) {
    return { topic: { ...topic, entries: topic.entries.map(({ waiting: _, ...e }) => e) }, note: `${fresh} new entries, no deadline` };
  }
  const days = daysLeft(topic.by, now);
  const room = days * TOPIC_DAILY_NEW;
  let taken = 0;
  const entries = topic.entries.map(({ waiting: _, ...e }) => {
    if (!isNew(e)) return e;
    taken++;
    return taken > room ? { ...e, waiting: true } : e;
  });
  const perDay = days > 0 ? Math.ceil(fresh / days) : fresh;
  const note =
    fresh <= room
      ? `${fresh} new entries, ${days} days: about ${perDay} a day, fine`
      : `${fresh} new entries in ${days} days is too many; the first ${room} fit, the other ${fresh - room} wait until those are started`;
  return { topic: { ...topic, entries }, note };
}

/** At low levels few words go into a reply, so a topic crawls: suggest a higher level, change nothing. */
export function levelHint(level: number): string | null {
  if (level > 3) return null;
  const now = wordsPerResponse(level);
  const up = wordsPerResponse(level + 4);
  return `Level ${level} weaves ${now} words a reply; level ${level + 4} weaves ${up}, so this topic would move about ${(up / now).toFixed(1)}× as fast. Run \`level ${level + 4}\` if you want that; nothing was changed.`;
}

export interface AddResult {
  ok: boolean;
  /** Needs a yes first (the third topic); nothing written */
  confirm?: boolean;
  lines: string[];
  path?: string;
}

/**
 * Add (or replace, same slug) a topic for `lang`: validate, apply the 2/3 limit, run the
 * pace check, save it running. `yes` confirms a third topic. A replaced topic keeps its
 * createdAt, so rebuilding a set doesn't move it in the list.
 */
export function addTopic(draft: Topic, slug: string, lang: string, state: State, level: number, now: string, yes = false): AddResult {
  draft = { ...draft, lang: draft.lang ?? normalizeLang(lang) }; // the agent may leave lang out: it's the current one
  const errors = validateTopic(draft, lang);
  if (errors.length) return { ok: false, lines: [`Topic "${slug}" has problems:`, ...errors.map((e) => `  - ${e}`)] };
  if (draft.by && daysLeft(draft.by, now) === 0) return { ok: false, lines: [`The date ${draft.by} has already passed; pick a later one or leave it out.`] };
  const others = runningTopics(lang, now).filter((f) => f.slug !== slug);
  if (others.length >= TOPICS_HARD_MAX) {
    return { ok: false, lines: [`${others.length} topics are already running (${others.map((f) => f.topic.title).join(", ")}); ${TOPICS_HARD_MAX} is the most. End one first: \`topic end <name>\`.`] };
  }
  if (others.length >= TOPICS_SOFT_MAX && !yes) {
    return {
      ok: false,
      confirm: true,
      lines: [`Two topics are already running (${others.map((f) => f.topic.title).join(", ")}). A third is a lot of new words at once. Are you sure? Add it again with --yes.`],
    };
  }
  const old = listTopics(lang).find((f) => f.slug === slug);
  const { topic, note } = planPace({ ...draft, lang: normalizeLang(lang), active: true, createdAt: old?.topic.createdAt ?? now }, slug, state, now);
  delete topic.endedAt;
  const path = saveTopic(lang, slug, topic);
  const phrases = topic.entries.filter((e) => e.kind === "phrase").length;
  const lines = [
    `${old ? "Updated" : "Added"} topic "${topic.title}" (${slug}): ${count(topic.entries.length, "entry", "entries")}, ${count(topic.entries.length - phrases, "word")} and ${count(phrases, "phrase")}. ${note}.`,
    "Its words now come first in replies, cards and placement.",
  ];
  const hint = levelHint(level);
  if (hint) lines.push(hint);
  return { ok: true, lines, path };
}

/** Stop a topic: its words stop leading, their progress stays. */
export function endTopic(lang: string, slug: string, now: string): string {
  const f = listTopics(lang).find((t) => t.slug === slug);
  if (!f) return `No topic "${slug}" for ${lang}. \`topic list\` shows them.`;
  if (!f.topic.active) return `Topic "${f.topic.title}" has already ended.`;
  saveTopic(lang, slug, { ...f.topic, active: false, endedAt: now });
  return `Ended topic "${f.topic.title}". Its words go back to the normal order; what you learned stays.`;
}

/**
 * Delete a topic for good (changed your mind): the file goes, so it leaves `topic list` and
 * `status`. Progress on its words stays in the state file: core words stay learned, and a
 * topic re-added under the same name gets its progress back. Asks first; `yes` confirms.
 * Works on a broken file too.
 */
export function deleteTopic(lang: string, slug: string, yes = false): { ok: boolean; confirm?: boolean; line: string } {
  const path = SLUG.test(slug) ? topicPath(lang, slug) : null;
  if (!path || !existsSync(path)) return { ok: false, line: `No topic "${slug}" for ${lang}. \`topic list\` shows them.` };
  const title = listTopics(lang).find((t) => t.slug === slug)?.topic.title ?? slug;
  if (!yes) return { ok: false, confirm: true, line: `Delete topic "${title}" for good? Its progress stays, but the topic leaves the list. Run it again with --yes. (\`topic end ${slug}\` only stops it.)` };
  unlinkSync(path);
  return { ok: true, line: `Deleted topic "${title}". What you learned from it stays.` };
}

/** Remove one entry (a bad word from the model, or one you don't need). Progress on it stays in the state file. */
export function dropEntry(lang: string, slug: string, key: string): string {
  const f = listTopics(lang).find((t) => t.slug === slug);
  if (!f) return `No topic "${slug}" for ${lang}.`;
  const entry = f.topic.entries.find((e) => e.key === key || e.target.toLowerCase() === key.toLowerCase());
  if (!entry) return `Topic "${f.topic.title}" has no entry "${key}".`;
  const entries = f.topic.entries.filter((e) => e !== entry);
  if (entries.length === 0) return `"${entry.target}" is the last entry; end the topic instead: \`topic end ${slug}\`.`;
  saveTopic(lang, slug, { ...f.topic, entries });
  return `Dropped "${entry.target}" from "${f.topic.title}" (${entries.length} left).`;
}

/** `topic list`: every topic of the language, running ones with progress, plus files that can't be used. */
export function topicListView(lang: string, state: State, now: string): string {
  const { topics, broken } = scanTopics(lang);
  if (topics.length === 0 && broken.length === 0) return `No topics for ${lang} yet. Ask your agent for one, e.g. "a topic for my trip to Barcelona" (docs/Topics.md).`;
  const lines = topics.map((f) => {
    const p = topicProgress(f, state, now);
    const waiting = f.topic.entries.filter((e) => e.waiting).length;
    const status = isRunning(f.topic, now) ? "running" : f.topic.active ? `ended (date ${f.topic.by} passed)` : "ended";
    return `  ${f.slug}: ${p.title} · ${status} · ${p.passed}/${p.total} passed (${count(p.words, "word")}, ${count(p.phrases, "phrase")})` +
      (p.daysLeft !== null && isRunning(f.topic, now) ? ` · ${count(p.daysLeft, "day")} left` : "") +
      (waiting ? ` · ${waiting} waiting` : "");
  });
  for (const b of broken) lines.push(`  ${b.slug}: can't be used (${b.path}): ${b.errors.join("; ")}`);
  return `Topics (${lang}):\n${lines.join("\n")}`;
}
