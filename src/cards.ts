import type { Config, State, Word, WordState } from "./types.ts";
import { glossFor, isAbsorbed, senseGloss, shownSenses } from "./types.ts";
import { dueOf, isDue, stepOf } from "./ladder.ts";
import { answerMatch, applyQuizResult, dropLeading } from "./recall.ts";
import { answerPlacement, placementQueue, skippedFor } from "./placement.ts";
import { readingFor, readingOf } from "./reading.ts";
import { absorbedCount, milestoneBar } from "./milestones.ts";
import { isTopicOnly } from "./topics.ts";
import { pickSpinnerWords } from "./spinner.ts";

/**
 * Flashcards: the review half of the ladder, driven by the learner instead of by replies.
 * Due words come first (most overdue first), then the placement queue fills the rest, so
 * a new learner places first and a placed one reviews. Every card is graded here, never by
 * the UI or the model; the cards mod only draws what `cards next` returns.
 */

export type CardDir = "forward" | "reverse";
export type CardKind = "review" | "placement";

export interface Card {
  id: string;
  kind: CardKind;
  dir: CardDir;
  /** What the learner sees: the target word (forward) or its gloss in their language (reverse). */
  prompt: string;
  /** Forward cards: the word's pronunciation, when the learner has it on (data/readings/<lang>.json). */
  reading?: string;
}

/** From this ladder step on, review cards alternate: odd steps ask native → target. */
export const REVERSE_FROM_STEP = 3;

export const cardDir = (step: number): CardDir => (step >= REVERSE_FROM_STEP && step % 2 === 1 ? "reverse" : "forward");

/** Started words due for review, most overdue first, one card per shared lemma. */
export function dueCards(words: Word[], state: State, now: string): Word[] {
  const seen = new Set<string>();
  return words
    .filter((w) => {
      const s = state[w.id];
      return s !== undefined && (s.exposures > 0 || (s.recalls ?? 0) > 0 || (s.step ?? 0) > 0) && isDue(s, now);
    })
    .sort((a, b) => dueOf(state[a.id]).localeCompare(dueOf(state[b.id])))
    .filter((w) => !seen.has(w.target) && !!seen.add(w.target));
}

export function cardQueue(words: Word[], state: State, config: Config, n: number, now: string): Card[] {
  const lang = config.lang;
  const mode = readingOf(config, lang, words.some((w) => w.ipa));
  const said = (w: Word) => {
    const r = readingFor(w, mode, config.native, lang);
    return r ? { reading: r } : {};
  };
  const due = dueCards(words, state, now).map((w): Card => {
    const dir = cardDir(stepOf(state[w.id]));
    return { id: w.id, kind: "review", dir, prompt: dir === "reverse" ? glossFor(w, config.native, lang) : w.target, ...(dir === "forward" ? said(w) : {}) };
  });
  const taken = new Set(due.map((c) => words.find((w) => w.id === c.id)!.target));
  const placement = placementQueue(words, state, skippedFor(config, lang))
    .filter((w) => !taken.has(w.target))
    .map((w): Card => ({ id: w.id, kind: "placement", dir: "forward", prompt: w.target, ...said(w) }));
  return [...due, ...placement].slice(0, n);
}

const ARTICLES = new Set(["il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "el", "los", "las", "unos", "unas", "les", "une", "der", "die", "das", "ein", "eine", "o", "a", "os", "as", "um", "uma", "the", "an", "to", "bir"]);

/** Lowercase, trimmed, accents folded (casà = casa), apostrophes unified, a leading article or "to" dropped. */
export function foldTarget(s: string): string {
  const t = s.toLowerCase().trim().normalize("NFD").replace(/\p{M}/gu, "").replace(/[ʻʼ‘’`´]/g, "'").replace(/\s+/g, " ");
  return dropLeading(t.replace(/^(l|un|d)'\s*/, ""), ARTICLES);
}

/** Native → target: the answer names the word itself (its lemma, or the base lemma of a regional variant). */
export function checkReverse(answer: string, word: Word): boolean {
  const a = foldTarget(answer);
  if (!a) return false;
  return [word.target, word.baseTarget].filter((x): x is string => !!x).some((t) => foldTarget(t) === a);
}

export interface CardResult {
  ok: boolean;
  /** The right answer, shown after a miss and after a hit alike. */
  expected: string;
  step: number;
  due: string;
  known: boolean;
  /** On a miss only: what grading changed, so "my answer was right" can take it back (acceptCard). */
  undo?: CardUndo;
  /** Forward cards: the word's everyday other meanings (carta: map, menu), shown with the answer. */
  also?: string[];
  /** The answer named one of those other meanings, not the main one. */
  meant?: string;
}

/** The state before a miss: each concept's entry (null = there was none) and the ids the miss put on the skip list. */
export interface CardUndo {
  state: Record<string, WordState | null>;
  skipped: string[];
}

/**
 * Grade one card and record it. Review: a right answer climbs every concept it names
 * (mañana is tomorrow and morning), a wrong or empty one resets the card's own concept.
 * A reverse card accepts any word whose gloss reads the same in the learner's language.
 * Placement: a right answer marks the word known, a wrong one goes on the skip list.
 * `skipped` is the config's list for this language, changed in place.
 */
export function answerCard(words: Word[], state: State, config: Config, skipped: string[], card: Pick<Card, "id" | "kind" | "dir">, answer: string, now: string): CardResult {
  const lang = config.lang;
  const word = words.find((w) => w.id === card.id);
  if (!word) throw new Error(`lazy-polyglot: no word "${card.id}" in the ${lang} list`);
  const gloss = glossFor(word, config.native, lang);
  // a miss changes only this concept's entry (review) or adds to the skip list (placement)
  const before = state[word.id] ? { ...state[word.id]! } : null;
  const skippedBefore = new Set(skipped);
  let ok: boolean;
  let meant: string | undefined;
  if (card.kind === "placement") {
    const placed = answerPlacement(words, state, skipped, word, answer, lang, now);
    ok = placed.ok;
    if (placed.sense) meant = senseGloss(placed.sense, config.native, lang);
  } else if (card.dir === "reverse") {
    const same = words.filter((w) => glossFor(w, config.native, lang) === gloss);
    const matched = same.filter((w) => checkReverse(answer, w));
    ok = matched.length > 0;
    if (ok) for (const w of matched) applyQuizResult(state, w.id, true);
    else applyQuizResult(state, word.id, false);
  } else {
    const hits = words.filter((w) => w.target === word.target).map((w) => ({ w, m: answerMatch(answer, w, lang) })).filter((h) => h.m !== null);
    ok = hits.length > 0;
    if (ok) for (const { w } of hits) applyQuizResult(state, w.id, true);
    else applyQuizResult(state, word.id, false);
    const sense = hits.every((h) => h.m !== "main") ? hits[0]?.m : undefined;
    if (sense && sense !== "main") meant = senseGloss(sense, config.native, lang);
  }
  const s = state[word.id];
  const undo: CardUndo | undefined = ok ? undefined : { state: { [word.id]: before }, skipped: skipped.filter((id) => !skippedBefore.has(id)) };
  const also = card.dir === "reverse" ? [] : shownSenses(word, config.native, lang).map((x) => x.gloss).filter((g) => g !== meant);
  return { ok, expected: card.dir === "reverse" ? word.target : gloss, step: stepOf(s), due: s ? dueOf(s) : "", known: isAbsorbed(s), ...(undo ? { undo } : {}), ...(also.length ? { also } : {}), ...(meant ? { meant } : {}) };
}

/**
 * "My answer was right": the learner overrules a miss (kid for bambino, where only child is
 * stored). Takes the miss back from `undo`, then records the card as answered right, through
 * the same path as a typed right answer. `skipped` is changed in place, as in answerCard.
 */
export function acceptCard(words: Word[], state: State, config: Config, skipped: string[], card: Pick<Card, "id" | "kind" | "dir">, undo: CardUndo, now: string): CardResult {
  for (const [id, prev] of Object.entries(undo.state)) {
    if (prev) state[id] = prev;
    else delete state[id];
  }
  for (const id of undo.skipped) {
    const i = skipped.indexOf(id);
    if (i >= 0) skipped.splice(i, 1);
  }
  return answerCard(words, state, config, skipped, card, revealCard(words, config, card), now);
}

/** The right answer for a card, without recording anything: what a self-graded card shows before "knew it / didn't". */
export function revealCard(words: Word[], config: Config, card: Pick<Card, "id" | "dir">): string {
  const word = words.find((w) => w.id === card.id);
  if (!word) throw new Error(`lazy-polyglot: no word "${card.id}" in the ${config.lang} list`);
  return card.dir === "reverse" ? word.target : glossFor(word, config.native, config.lang);
}

export interface CardStatus {
  lang: string;
  /** The learner's language: what a reverse card's prompt and a forward card's answer are in. */
  native: string;
  paused: boolean;
  due: number;
  known: number;
  learning: number;
  placementLeft: number;
  total: number;
  /** Show a learning word under the prompt: true/false as chosen, null = never asked. */
  statusLine: boolean | null;
  /** The way to the next milestone (`▓▓▓▓░ 87/100`), null when milestones are off or all are behind. */
  progress: string | null;
  /** Words being learned, most recently woven first: the mod shows one under the prompt, a new one each message. */
  words: { target: string; gloss: string; reading?: string }[];
}

/** How many learning words a status carries for the hint line to rotate through. */
export const HINT_WORDS = 10;

export function cardStatus(words: Word[], state: State, config: Config, now: string): CardStatus {
  const mode = readingOf(config, config.lang, words.some((w) => w.ipa));
  const known = words.filter((w) => isAbsorbed(state[w.id])).length;
  const started = words.filter((w) => {
    const s = state[w.id];
    return s && !isAbsorbed(s) && (s.exposures > 0 || (s.recalls ?? 0) > 0 || (s.step ?? 0) > 0);
  }).length;
  return {
    lang: config.lang,
    native: config.native,
    paused: config.enabled === false,
    due: dueCards(words, state, now).length,
    known,
    learning: started,
    placementLeft: placementQueue(words, state, skippedFor(config, config.lang)).length,
    total: words.length,
    statusLine: config.cardsStatus ?? null,
    progress: config.milestones === false ? null : milestoneBar(absorbedCount(state), words.filter((w) => !isTopicOnly(w)).length),
    words: pickSpinnerWords(words, state, HINT_WORDS).map((w) => {
      const reading = readingFor(w, mode, config.native, config.lang);
      return { target: w.target, gloss: glossFor(w, config.native), ...(reading ? { reading } : {}) };
    }),
  };
}
