import type { MilestoneLog } from "./milestones.ts";

export type Pos = "noun" | "verb" | "adj" | "adv" | "num";

/**
 * A language-independent meaning, authored once in data/concepts.json.
 * Glosses are keyed by native-language code — adding a native language
 * is one more key here, never a wordlist change.
 */
export interface Concept {
  id: string;
  pos: Pos;
  /** Vocabulary band: 1 = core (~400), 2 → 1000, 3 → 3000. Unlocked progressively. */
  tier: number;
  /** Order new words come in, most useful first: 1..N, computed by scripts/rank-words.ts from word frequency. */
  rank?: number;
  gloss: Record<string, string>;
  /** Other right answers by native-language code ("kid" for child): accepted when grading, never shown. */
  alt?: Record<string, string[]>;
}

/**
 * Per-language wordlist file: concept id → lemma.
 * The value may later grow to an object ({ lemma, gender, ... }) — loaders normalize.
 */
export type WordMapping = Record<string, string>;

/** A concept joined with its lemma in the active target language. */
export interface Word {
  /** Concept id — the state key: progress survives lemma fixes and links across languages. */
  id: string;
  /** The lemma in the target language ("casa"). */
  target: string;
  pos: Pos;
  tier: number;
  /** The concept's rank: new words come in this order. */
  rank?: number;
  gloss: Record<string, string>;
  /** Other right answers, as on the concept: graded, never shown. */
  alt?: Record<string, string[]>;
  /** Regional variant only: the base's lemma when this one differs (es-419 carro → es coche). */
  baseTarget?: string;
  /** Regional variant only: a warning about baseTarget here ("vulgar in much of Latin America"). */
  baseNote?: string;
  /** Pronunciation as IPA, from data/readings/<lang>.json; absent for languages that read as written. */
  ipa?: string;
  /** Other meanings of this lemma in this language (it carta: map, menu), from data/senses/<lang>.json. */
  senses?: Sense[];
  /** A topic asked for one of the senses (trip → carta = menu): replies weave the word in that meaning. */
  focus?: string;
  /** The same spelling means another concept in a language the learner also studies (es carta = letter). */
  elsewhere?: string;
  /** Slug of the running topic this word belongs to: topic words lead the queue (src/topics.ts). */
  topic?: string;
  /** A topic phrase ("la cuenta, por favor"): taught whole, never counted toward grammar unlocks. */
  phrase?: boolean;
}

/**
 * A word that misleads: it looks like a native word but means something else (neutral),
 * or it is rude somewhere (vulgar). Vulgar entries are never teaching content; they only
 * warn and guard the data. Lives in data/falseFriends/<lang>.json, keyed by the word's language.
 */
/**
 * One more meaning of a word in one language: Italian carta is paper (its concept) but also
 * map and menu. Lives in data/senses/<lang>.json as concept id → Sense[]; the concept stays
 * the unit of progress, so a sense never gets its own card or state.
 */
export interface Sense {
  /** Stable within the word, kebab-case: a topic names a sense by it (paper.menu). */
  id: string;
  /** weave: an everyday meaning, shown and woven once the main one is familiar. accept: only graded as right. */
  use: "weave" | "accept";
  /** By native-language code. Optional when `concept` is set: that concept's gloss is used. */
  gloss?: Record<string, string>;
  /** The meaning is this listed concept (it ora → now, which adesso teaches); its progress is never touched. */
  concept?: string;
}

export type SenseFile = Record<string, Sense[]>;

/** The sense's gloss in the learner's language, like glossFor (never the target language itself). */
export function senseGloss(s: Sense, native: string, lang?: string): string {
  const g = s.gloss ?? {};
  const own = lang?.split("-")[0];
  const key = [native, "en", ...Object.keys(g)].find((k) => k !== own && g[k] !== undefined);
  return key ? g[key]! : s.id;
}

/** Weave senses only: the everyday other meanings. */
export const weaveSenses = (w: Word): Sense[] => (w.senses ?? []).filter((s) => s.use === "weave");

/**
 * The weave senses a learner is shown, as glosses in their language. A sense with no gloss in
 * that language is left out: Russian язык is both language and tongue, so for a Russian
 * speaker lingua = tongue is not another meaning. A learner whose language the word's own
 * glosses lack (no ru, no uz) falls back to English, like glossFor.
 */
export function shownSenses(w: Word, native: string, lang?: string, except?: Sense): { sense: Sense; gloss: string }[] {
  const own = lang?.split("-")[0];
  const key = w.gloss[native] !== undefined && native !== own ? native : null;
  return weaveSenses(w)
    .filter((s) => s !== except && (key === null || s.gloss?.[key] !== undefined))
    .map((s) => ({ sense: s, gloss: senseGloss(s, native, lang) }));
}

export interface FalseFriend {
  target: string;
  /** What it really means, by native-language code ({ en, ru, uz }); a plain string (files before 0.8.0) reads as one meaning for everyone */
  means: string | Record<string, string>;
  register: "neutral" | "vulgar";
  /** Native words it looks like, by native-language code ({ en: "embarrassed" }) */
  looksLike?: Record<string, string>;
  /** Language codes (a variant, or a native language) where the word is rude */
  vulgarIn?: string[];
  /** Id of the word-building rule it poses as (data/patterns/<lang>.json) */
  pattern?: string;
  /** How the warning reads; default "vulgar in <region>" */
  note?: string;
  /** Where it was checked (dictionary URL) */
  source: string;
}

export interface Config {
  /** Target language code, matches data/wordlists/<lang>.json */
  lang: string;
  /** User's native language — used for glosses in the instruction */
  native: string;
  /** 1..10; drives words-per-response and grammar stage */
  level: number;
  /** Kill switch: when false, the hook emits nothing. Toggled by pause/resume. */
  enabled?: boolean;
  /** Spanish words in the Claude Code spinner tips. Opt-in; toggled by `spinner on|off`. */
  spinner?: boolean;
  /** The due-card count in the Claude Code status line. Opt-in: unset = never asked (the cards pane asks once), toggled by `cards-status on|off`. */
  cardsStatus?: boolean;
  /** Last plugin version whose changelog `status` has shown; a newer one shows once. */
  seenVersion?: string;
  /**
   * Weave algorithm (src/instruction.ts): 1 = every listed word (default), 2 = only where it fits,
   * 3 = fit + nudge + interval ladder with honest counting (src/ladder.ts). Set by `lazy-polyglot mode`.
   */
  algorithm?: 1 | 2 | 3;
  /** The hook already asked once which language translations should be in (or `lazy-polyglot native` set it). */
  nativeAsked?: boolean;
  /** Placement test, per language: concept ids answered "don't know", so the next run carries on. */
  placementSkipped?: Record<string, string[]>;
  /** Languages whose start-of-use placement offer has been made (it is made once). */
  placementOffered?: string[];
  /** Pronunciation next to new words, per language: off, in the learner's own letters (native), or IPA. Unset = native where the language has readings. */
  reading?: Record<string, "off" | "native" | "ipa">;
  /** Languages whose pronunciation question has been asked (it is asked once). */
  readingAsked?: string[];
  /** A closing line at round numbers of absorbed words, topic halves and a weekly tally. On unless false; toggled by `milestones on|off`. */
  milestones?: boolean;
  /** Per language: which milestones were already celebrated (src/milestones.ts). */
  milestoneLog?: Record<string, MilestoneLog>;
}

/** Algorithm 3 since 0.6.0; a config without the field gets it. `lazy-polyglot mode 1` brings the old weave back. */
export const DEFAULT_ALGORITHM = 3;
export const algorithmOf = (config: Config): 1 | 2 | 3 => config.algorithm ?? DEFAULT_ALGORITHM;

export interface WordState {
  exposures: number;
  /** ISO timestamp of last time the word was put into an instruction */
  lastSeen: string;
  /** Times the user actively produced the word: found in their prompt or answered in quiz. */
  recalls?: number;
  /** Interval-ladder step (algorithm 3). Absent on records from 0.5.0 and earlier: estimated on first read. */
  step?: number;
  /** ISO time the word is due again on the ladder */
  due?: string;
  /** Times served while due but not woven; enough of them make the word a nudge candidate */
  missed?: number;
}

/** True for state keys that track words; constructions ("g:") and rules ("p:") carry a prefix. */
export const isWordKey = (key: string) => !key.includes(":");

/** Keyed by concept id (grammar constructions use a "g:" prefix, word-building rules "p:"). */
export type State = Record<string, WordState>;

/**
 * Absorption formula: exposure is not knowledge.
 * A word is absorbed when its combined score reaches ABSORBED_SCORE,
 * AND there is at least one recall OR enough raw exposures to compensate.
 */
export const RECALL_WEIGHT = 4; // 1 recall ≈ 4 exposures
export const ABSORBED_SCORE = 8; // exposures + RECALL_WEIGHT * recalls threshold
export const NO_RECALL_EXPOSURES = 12; // exposures that absorb even with zero recalls
export const QUIZ_FAIL_EXPOSURES = 2; // exposures cap after a failed quiz — re-absorbing must be earned

/** Tier N+1 unlocks when this share of tier N is absorbed. */
export const TIER_UNLOCK_RATIO = 0.8;

/**
 * Interval ladder (algorithm 3): after a word is woven at step k it moves to k+1
 * and comes back LADDER_MS[k+1] later. Steps up to INLINE_GLOSS_MAX_STEP carry the
 * translation inline, up to GLOSSARY_MAX_STEP in the closing glossary line, then none.
 */
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const LADDER_MS = [0, 30 * MIN, 8 * HOUR, DAY, 4 * DAY, 14 * DAY, 30 * DAY, 180 * DAY];
export const INLINE_GLOSS_MAX_STEP = 2;
export const GLOSSARY_MAX_STEP = 4;
export const ABSORBED_STEP = 5;
/** Served while due this many times without fitting → the word may be nudged in */
export const NUDGE_AFTER_MISSES = 3;
export const MAX_NUDGE = 2;
/** Missed this many times in a row → the word stops blocking a nudge slot and rests (NUDGE_REST_MS) */
export const NUDGE_GIVE_UP = 12;
export const NUDGE_REST_MS = 7 * 24 * 60 * 60 * 1000;
/** Absorbed lemmas offered per reply, without glosses, to use freely where they fit */
export const KNOWN_SAMPLE = 30;

/** The points formula: how absorption worked before the ladder, and how old records are estimated. */
export function absorbedByScore(s: WordState): boolean {
  const recalls = s.recalls ?? 0;
  const score = s.exposures + RECALL_WEIGHT * recalls;
  return score >= ABSORBED_SCORE && (recalls >= 1 || s.exposures >= NO_RECALL_EXPOSURES);
}

/** On the ladder (a step is recorded) absorbed means step ≥ ABSORBED_STEP; otherwise the points formula. */
export function isAbsorbed(s: WordState | undefined): boolean {
  if (!s) return false;
  return s.step !== undefined ? s.step >= ABSORBED_STEP : absorbedByScore(s);
}

/**
 * Gloss in the user's native language, falling back to English, then anything.
 * A gloss in the target language itself is useless (house = house), so the gloss
 * keyed by `lang`'s base is skipped: learning en with native en shows ru.
 */
export function glossFor(word: Word, native: string, lang?: string): string {
  const own = lang?.split("-")[0];
  const key = [native, "en", ...Object.keys(word.gloss)].find((k) => k !== own && word.gloss[k] !== undefined);
  return (key ? word.gloss[key] : word.gloss[native] ?? Object.values(word.gloss)[0]) ?? word.id;
}

/** A false friend's meaning in the learner's native language, falling back to English, then anything; like glossFor, never in the target language itself. */
export function meansFor(f: FalseFriend, native: string, lang?: string): string {
  const means = f.means;
  if (typeof means === "string") return means;
  const own = lang?.split("-")[0];
  const key = [native, "en", ...Object.keys(means)].find((k) => k !== own && means[k] !== undefined);
  return key ? means[key]! : "";
}

export function wordsPerResponse(level: number): number {
  // level 1 → 3 words, level 10 → 12 words
  return Math.min(12, 2 + level);
}

export type GrammarStage = 1 | 2 | 3;

export function grammarStage(level: number): GrammarStage {
  if (level >= 7) return 3;
  if (level >= 4) return 2;
  return 1;
}
