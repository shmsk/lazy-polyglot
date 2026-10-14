import type { Sense, State, Word } from "./types.ts";
import { QUIZ_FAIL_EXPOSURES } from "./types.ts";
import { climb, reset } from "./ladder.ts";

/** On the ladder (a step is recorded) a recall climbs one step; old records only count it. */
const onLadder = (s: { step?: number }) => s.step !== undefined;
const now = () => new Date().toISOString();

/** Min target length to count a prompt hit as recall — filters short cognate/particle noise. */
export const MIN_RECALL_LENGTH = 3;

const norm = (s: string) => s.toLowerCase().normalize("NFC");

// a letter outside the Latin script (Cyrillic and the like): the sentence isn't English
const NON_LATIN = /[^\P{L}\p{Script=Latin}]/u;

/**
 * Find wordlist words the user actively used in their prompt; returns concept ids
 * (the state keys). Word-boundary matching via tokenization; deduped (N mentions =
 * 1 recall); multi-token targets are skipped — the scan is a cheap signal, not a parser.
 * A homograph (a lemma that is also an English word: via, fine) counts only in a sentence
 * with a non-Latin letter or another, non-homograph list word: "via email" is English.
 */
export function scanRecalls(prompt: string, words: Word[], homographs: ReadonlySet<string> = new Set()): string[] {
  const usable = words.filter((w) => w.target.length >= MIN_RECALL_LENGTH && !w.target.includes(" "));
  const listed = new Set(usable.map((w) => norm(w.target)));
  const found = new Set<string>();
  for (const sentence of norm(prompt).split(/[.!?;\n]+/)) {
    const hits = sentence.split(/[^\p{L}]+/u).filter((t) => listed.has(t));
    const anchored = NON_LATIN.test(sentence) || hits.some((t) => !homographs.has(t));
    for (const t of hits) if (anchored || !homographs.has(t)) found.add(t);
  }
  return usable.filter((w) => found.has(norm(w.target))).map((w) => w.id);
}

/** Record recall events by concept id. lastSeen is NOT touched — it tracks instruction exposure only. */
export function recordRecalls(state: State, ids: string[]): State {
  for (const id of ids) {
    const prev = state[id] ?? { exposures: 0, lastSeen: "" };
    const next = { ...prev, recalls: (prev.recalls ?? 0) + 1 };
    state[id] = onLadder(prev) ? climb(next, now()) : next;
  }
  return state;
}

/**
 * Quiz outcome. Success = a recall. Failure resets the word out of the
 * absorbed pool: recalls wiped, exposures capped low so re-absorbing must be earned.
 */
export function applyQuizResult(state: State, id: string, ok: boolean): State {
  const prev = state[id] ?? { exposures: 0, lastSeen: "" };
  const next = ok
    ? { ...prev, recalls: (prev.recalls ?? 0) + 1 }
    : { ...prev, recalls: 0, exposures: Math.min(prev.exposures, QUIZ_FAIL_EXPOSURES) };
  state[id] = onLadder(prev) ? (ok ? climb(next, now()) : reset(next, now())) : next;
  return state;
}

/** Drop one leading word from `set` ("to work" → "work"), never the whole answer. */
export function dropLeading(s: string, set: ReadonlySet<string>): string {
  const [first, ...rest] = s.split(" ");
  return rest.length && set.has(first!) ? rest.join(" ") : s;
}

// "the child", "a kid", "to work": the meaning is right, the article is just how English says it
const GLOSS_LEADING = new Set(["the", "a", "an", "to"]);

// Uzbek Latin oʻ/gʻ/tutuq belgisi get typed with any of these; glosses store plain '.
export const normAnswer = (s: string) =>
  dropLeading(
    s.toLowerCase().trim().replaceAll("ё", "е").replace(/[ʻʼ‘’`´]/g, "'").replace(/[.!?]+$/, "").replace(/\s+/g, " ").trim(),
    GLOSS_LEADING,
  );

/**
 * Loose gloss comparison: lowercase, trim, ё=е, any apostrophe = ', a leading the/a/an/to
 * dropped, comma/slash-separated gloss variants and `alt` answers accepted — any gloss
 * language counts except the target's own (learning en, "house" is not a translation of "house").
 */
export function checkAnswer(answer: string, word: Word, lang?: string): boolean {
  return answerMatch(answer, word, lang) !== null;
}

/** Every gloss variant of a record except the target language's own, normalized like an answer. */
const glossVariants = (gloss: Record<string, string>, own: string | undefined): string[] =>
  Object.entries(gloss)
    .filter(([k]) => k !== own)
    .flatMap(([, g]) => g.split(/[,;/()]/))
    .map(normAnswer)
    .filter(Boolean);

/**
 * Which meaning an answer names: "main" (the concept's gloss or an alt), one of the word's
 * other senses (carta → map), or null when it names none. A sense is checked only after the
 * main meaning, so an answer both share counts as the main one.
 */
export function answerMatch(answer: string, word: Word, lang?: string): "main" | Sense | null {
  const a = normAnswer(answer);
  if (!a) return null;
  const own = lang?.split("-")[0];
  const alts = Object.entries(word.alt ?? {})
    .filter(([k]) => k !== own)
    .flatMap(([, list]) => list)
    .map(normAnswer);
  if ([...glossVariants(word.gloss, own), ...alts].includes(a)) return "main";
  return (word.senses ?? []).find((s) => s.gloss && glossVariants(s.gloss, own).includes(a)) ?? null;
}
