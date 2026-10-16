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

// a sentence keeps its end mark: the question mark is half of what makes a lookup
const SENTENCES = /[^.!?;\n]+[.!?;]*/g;
// quoted or pasted text ("what's ultimo?", «…», `…`, a `> ` line) is a mention, never the user's own question
const QUOTED = /"[^"\n]*"|“[^”\n]*”|«[^»\n]*»|`[^`\n]*`|^>.*$/gm;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The sentence asks what `t` means: «что значит casa?», "what's casa?", "casa nima degani", a bare "casa?". */
function asksMeaning(sentence: string, t: string): boolean {
  const x = `(?<!\\p{L})${escape(t)}(?!\\p{L})`;
  return [
    `what(?:'s|’s|\\s+is|\\s+does)\\s+${x}`,
    `${x}\\s+means?\\s*\\?`,
    `(?:meaning\\s+of|translate|define)\\s+${x}`,
    `что\\s+(?:значит|означает|такое)\\s+${x}`,
    `(?:как\\s+переводится|переведи|перевод)\\s+${x}`,
    `${x}\\s*(?:[—–-]\\s*)?это\\s+что`,
    `${x}\\s+(?:что\\s+)?(?:значит|означает)\\s*\\?`,
    `${x}\\s+(?:nima|nimani\\s+anglatadi|ma'nosi)`,
    `^\\s*${x}\\s*\\?+\\s*$`,
  ].some((p) => new RegExp(p, "u").test(sentence));
}

/**
 * Words the user used in their prompt (recalls) and words they asked the meaning of
 * (lookups), as concept ids. Word-boundary matching via tokenization; deduped (N mentions =
 * 1 recall); multi-token targets are skipped — the scan is a cheap signal, not a parser.
 * A homograph (a lemma that is also an English word: via, fine) counts only in a sentence
 * with a non-Latin letter or another, non-homograph list word: "via email" is English.
 * A lookup is never also a recall: asking what casa means is the opposite of knowing it.
 */
export function scanPrompt(prompt: string, words: Word[], homographs: ReadonlySet<string> = new Set()): { recalls: string[]; lookups: string[] } {
  const usable = words.filter((w) => w.target.length >= MIN_RECALL_LENGTH && !w.target.includes(" "));
  const listed = new Set(usable.map((w) => norm(w.target)));
  const scan = (text: string, keep: (sentence: string, t: string) => boolean) => {
    const found = new Set<string>();
    for (const sentence of text.match(SENTENCES) ?? []) {
      const hits = sentence.split(/[^\p{L}]+/u).filter((t) => listed.has(t));
      const anchored = NON_LATIN.test(sentence) || hits.some((t) => !homographs.has(t));
      for (const t of hits) if ((anchored || !homographs.has(t)) && keep(sentence, t)) found.add(t);
    }
    return found;
  };
  const text = norm(prompt);
  const asked = scan(text.replace(QUOTED, " "), asksMeaning);
  const used = scan(text, () => true);
  const ids = (set: Set<string>) => usable.filter((w) => set.has(norm(w.target))).map((w) => w.id);
  return { recalls: ids(new Set([...used].filter((t) => !asked.has(t)))), lookups: ids(asked) };
}

/** Words the user actively used in their prompt (see scanPrompt). */
export function scanRecalls(prompt: string, words: Word[], homographs: ReadonlySet<string> = new Set()): string[] {
  return scanPrompt(prompt, words, homographs).recalls;
}

/** The user asked what these words mean: a word already met goes back like a missed quiz answer; one never met is left alone. */
export function recordLookups(state: State, ids: string[]): State {
  for (const id of ids) if (state[id]) applyQuizResult(state, id, false);
  return state;
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
