/**
 * Which target-language words did a reply actually weave? Shared by the Stop hook
 * (honest counting), the eval metrics, and the live smoke check.
 */

const norm = (s: string) => s.normalize("NFC").toLowerCase();
export const tokens = (s: string) => norm(s).split(/[^\p{L}]+/u).filter(Boolean);

/** Every **bold** (gloss) pair in a reply, in the format the weave instruction asks for; a [pronunciation] between them is allowed. */
export function wovenPairs(reply: string): { word: string; gloss: string }[] {
  return [...reply.matchAll(/\*\*([^*\n]{1,40})\*\*\s*(?:\[[^\]\n]{1,40}\]\s*)?\(([^)\n]{1,60})\)/g)].map((m) => ({
    word: m[1]!.trim(),
    gloss: m[2]!.trim(),
  }));
}

/** Every **bold** span, glossed or not: familiar words come without a translation. */
export function boldSpans(reply: string): string[] {
  return [...reply.matchAll(/\*\*([^*\n]{1,40})\*\*/g)].map((m) => m[1]!.trim());
}

/**
 * Stem that still matches inflected forms: drop a final vowel on lemmas of 4+
 * letters, so casa → cas matches casas, niño → niñ matches niños/niña.
 * Short lemmas stay whole (día matches días, año matches años).
 */
export function stem(lemma: string): string {
  const w = norm(lemma);
  return w.length >= 4 && /[aeiouáéíóú]$/.test(w) ? w.slice(0, -1) : w;
}

/** Infinitive endings across the served languages: it -are/-ere/-ire, es/pt -ar/-er/-ir, fr -re, de -en, tr -mak/-mek. */
const INFINITIVE = /(?:are|ere|ire|ar|er|ir|re|en|mak|mek)$/;

/**
 * Looser root for glossed pairs: a verb loses its infinitive ending (cadere → cad,
 * tirare → tir), anything else falls back to stem(). Never shorter than 3 letters.
 */
export function looseStem(lemma: string): string {
  const w = norm(lemma);
  const end = w.match(INFINITIVE)?.[0];
  return end && w.length - end.length >= 3 ? w.slice(0, -end.length) : stem(w);
}

/**
 * Strict check for a Spanish form of a lemma in running prose, where the loose
 * stem match would fire on English words (casa → "case"). Plural, gender, and
 * common verb endings only.
 */
export function inflects(token: string, lemma: string): boolean {
  const t = norm(token), l = norm(lemma);
  if (t === l || t === l + "s" || t === l + "es") return true;
  const verb = l.match(/^(.+)(ar|er|ir)$/);
  if (verb) return t.startsWith(verb[1]!) && VERB_ENDINGS.has(t.slice(verb[1]!.length));
  const root = l.replace(/[aoe]$/, "");
  return root !== l && ["a", "o", "as", "os"].includes(t.slice(root.length)) && t.startsWith(root);
}
const VERB_ENDINGS = new Set(["o", "as", "a", "amos", "an", "es", "e", "emos", "en", "imos", "ado", "ada", "ido", "ida", "ando", "iendo", "é", "ó", "ió", "aba", "ía", "á", "ás", "án"]);

/** Code the weave must not touch: fenced blocks and inline spans. */
export function splitCode(reply: string): { prose: string; code: string } {
  const code: string[] = [];
  const prose = reply
    .replace(/```[\s\S]*?(```|$)/g, (m) => (code.push(m), "\n"))
    .replace(/`[^`\n]+`/g, (m) => (code.push(m), " "));
  return { prose, code: code.join("\n") };
}

/** Served lemmas that appear, inflected or not, as a bold woven word in the reply. */
export function matchServed(reply: string, served: string[]): string[] {
  const bold = wovenPairs(reply).flatMap((p) => tokens(p.word));
  return served.filter((lemma) => {
    const s = stem(lemma);
    return bold.some((token) => token.startsWith(s));
  });
}

/**
 * Served lemmas the reply wove in any bold form, glossed or not, outside code.
 * Bold spans of 4+ tokens are the whole-sentence task: their words count too,
 * since the learner reads them. Bare bold matches strictly (inflects), so a bold
 * English header never passes for a Spanish word; a glossed pair also matches by
 * looseStem, which counts Italian, Portuguese, French, German and Turkish forms.
 * `forms` (lemma → irregular forms) counts what shares no root with the lemma: è for
 * essere, went for to go. English verbs are matched without their leading "to".
 */
export function wovenLemmas(reply: string, served: string[], forms: Record<string, string[]> = {}): string[] {
  const { prose } = splitCode(reply);
  const spans = boldSpans(prose).map(tokens);
  const bold = spans.flat();
  const boldSet = new Set(bold);
  // a glossed pair is an explicit weave, so a loose root is safe there: tira, cade, porta
  const glossed = wovenPairs(prose).map((p) => tokens(p.word));
  const glossedHit = (part: string) => glossed.some((toks) => toks.some((t) => t.startsWith(looseStem(part))));
  const hit = (part: string) => bold.some((t) => inflects(t, part)) || glossedHit(part);
  return served.filter((lemma) => {
    if ((forms[lemma] ?? []).some((f) => boldSet.has(norm(f)))) return true;
    const all = tokens(lemma);
    // "to want" is woven as want, wants, wanted: the infinitive marker is never bold
    const parts = all.length > 1 && all[0] === "to" ? all.slice(1) : all;
    if (parts.length === 0) return false;
    // multi-word lemmas ("por favor"): every part must show up in bold
    if (parts.every(hit)) return true;
    // a leading verb may take any form, irregular too (avere bisogno → abbiamo bisogno),
    // when one bold span is long enough and holds every other part
    const [verb, ...rest] = parts;
    if (rest.length === 0 || !INFINITIVE.test(verb!)) return false;
    return spans.some((toks) => toks.length >= parts.length && rest.every((p) => toks.some((t) => inflects(t, p) || t.startsWith(looseStem(p)))));
  });
}
