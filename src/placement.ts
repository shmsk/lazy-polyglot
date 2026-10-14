import type { Config, Sense, State, Word } from "./types.ts";
import { ABSORBED_STEP, LADDER_MS, isAbsorbed, shownSenses } from "./types.ts";
import { answerMatch } from "./recall.ts";

/**
 * Placement test: a learner who already knows part of the list proves it once, and
 * those words skip the new-word stage. Every word not yet absorbed is asked (a word the
 * hook served but no reply used was never in front of the learner); a right
 * answer puts the word straight into the absorbed pool, a wrong or empty one changes
 * nothing (it stays new). Words answered "don't know" are remembered in the config so
 * the next run carries on instead of asking them again.
 */

/** Words still to place, in list order (the lists open with the most common words), one per shared lemma. */
export function placementQueue(words: Word[], state: State, skipped: string[] = []): Word[] {
  const skip = new Set(skipped);
  const targets = new Set<string>();
  return words.filter((w) => {
    if (targets.has(w.target)) return false;
    targets.add(w.target);
    // a shared lemma (mañana) is asked once, while any of its concepts is still unplaced and not absorbed
    const siblings = words.filter((x) => x.target === w.target);
    return siblings.some((x) => !isAbsorbed(state[x.id]) && !skip.has(x.id));
  });
}

/** Known from day one: absorbed on the ladder and by the points formula, back for review in 14 days. */
export function markKnown(state: State, id: string, now: string): State {
  const prev = state[id] ?? { exposures: 0, lastSeen: "" };
  const { missed: _, ...rest } = prev;
  state[id] = {
    ...rest,
    recalls: Math.max(1, prev.recalls ?? 0),
    step: Math.max(ABSORBED_STEP, prev.step ?? 0),
    due: new Date(Date.parse(now) + LADDER_MS[ABSORBED_STEP]!).toISOString(),
    lastSeen: now,
  };
  return state;
}

export interface PlacementAnswer {
  word: Word;
  ok: boolean;
  /** Set when the answer named another meaning of the word (carta → map), not its main one. */
  sense?: Sense;
}

/**
 * Check one answer against every concept sharing the word (mañana is both "tomorrow" and
 * "morning"). Right: every matched concept is marked known. Wrong or empty: all of the
 * word's concepts go on the skip list, so the queue moves on.
 */
export function answerPlacement(words: Word[], state: State, skipped: string[], word: Word, answer: string, lang: string, now: string): PlacementAnswer {
  const siblings = words.filter((x) => x.target === word.target);
  const hits = siblings.map((x) => ({ x, m: answerMatch(answer, x, lang) })).filter((h) => h.m !== null);
  if (hits.length) for (const { x } of hits) markKnown(state, x.id, now);
  else for (const x of siblings) if (!skipped.includes(x.id)) skipped.push(x.id);
  const sense = hits.every((h) => h.m !== "main") ? (hits[0]?.m as Sense | undefined) : undefined;
  return { word, ok: hits.length > 0, ...(sense ? { sense } : {}) };
}

/** "carta (also: map, menu)": the word with its everyday other meanings, for a ✓ line; just the word when it has none. */
export function withAlso(word: Word, native: string, lang: string, except?: Sense): string {
  const also = shownSenses(word, native, lang, except).map((x) => x.gloss);
  return also.length ? `${word.target} (also: ${also.join(", ")})` : word.target;
}

export const skippedFor = (config: Config, lang: string): string[] => [...(config.placementSkipped?.[lang] ?? [])];

export const withSkipped = (config: Config, lang: string, skipped: string[]): Config => ({
  ...config,
  placementSkipped: { ...config.placementSkipped, [lang]: skipped },
});

/** Run placement for a language before? The offer at start is made only until then. */
export const placementStarted = (config: Config, lang: string): boolean => config.placementSkipped?.[lang] !== undefined;

/**
 * "These words are too easy / I know them all" in Russian, English or Uzbek. A cheap
 * signal, matched on the user's own message only, so a false hit costs one offer line.
 */
const TOO_EASY = [
  /слишком\s+(простые|лёгкие|легкие)/,
  /(очень|совсем|самые)\s+(простые|лёгкие|легкие)\s+слова/,
  /(эти|все|такие)\s+слова\s+(я\s+)?(уже\s+)?знаю/,
  /я\s+(их\s+)?(уже\s+)?(все|всё)\s+знаю/,
  /уже\s+знаю\s+(эти|все|их)/,
  /\btoo\s+(easy|simple|basic)\b/,
  /\b(already\s+know|know\s+(all\s+)?(of\s+)?(these|them|those))\b.*\bwords?\b/,
  /\bwords?\b.*\b(already\s+know|too\s+(easy|simple|basic))\b/,
  /juda\s+(oson|oddiy)/,
  /bu\s+so['ʻ‘’]?zlarni\s+(allaqachon\s+)?bilaman/,
];

export function detectTooEasy(prompt: string): boolean {
  const p = prompt.toLowerCase();
  return TOO_EASY.some((re) => re.test(p));
}

export const OFFER_TOO_EASY =
  "The user says these words are too easy. In one short line after the answer, offer a placement test: `/lazy-polyglot:placement` here, or `lazy-polyglot placement` in a terminal. It marks the words they already know, so only new ones are taught.";

/** The start-of-use offer is for beginners: a learner with this many words absorbed already found their level. */
export const OFFER_KNOWN_MAX = 20;

export const offerAtStart = (name: string) =>
  `New to ${name} in Lazy Polyglot? Once, in one short line after the answer, mention that if the user already knows some ${name}, a placement test marks those words: \`/lazy-polyglot:placement\` here, or \`lazy-polyglot placement\` in a terminal.`;
