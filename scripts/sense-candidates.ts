#!/usr/bin/env bun
/**
 * Candidate meanings for data/senses/<lang>.json, pulled from en.wiktionary's REST API.
 *
 *   bun scripts/sense-candidates.ts <lang> <out-dir>
 *
 * Writes <out-dir>/candidates-<lang>.json: concept id → { lemma, gloss, defs[] }. For a
 * regional variant (pt-BR) only its overlay lemmas are fetched. A language you added yourself
 * (~/.lazy-polyglot/wordlists/<lang>.json) is read from there. The output is raw material
 * for a person or an agent writing the senses file, never committed: Wiktionary text is
 * CC BY-SA, so the senses file carries only our own one- or two-word glosses.
 */
import { join } from "node:path";
import { loadConcepts, readJson, wordlistPath } from "../src/store.ts";

// Wiktionary heads each language section with its English name, which Intl knows for any
// ISO code (ka → Georgian); list a code here only where Wiktionary names it differently.
const WIKTIONARY_NAME: Record<string, string> = { nb: "Norwegian Bokmål", nn: "Norwegian Nynorsk", el: "Greek", zh: "Chinese" };
export function wiktionaryName(code: string): string | null {
  if (WIKTIONARY_NAME[code]) return WIKTIONARY_NAME[code]!;
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code);
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
}
const UA = "lazy-polyglot-sense-candidates/1.0 (https://github.com/shmsk/lazy-polyglot)";
// grammatical-form lines, not meanings
const FORM = /^(plural|feminine|masculine|inflection|first-person|second-person|third-person|singular|gerund|past participle|present participle|alternative|obsolete|archaic|misspelling|nonstandard)\b/i;
const strip = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\.mw-parser-output[^}]*}/g, "").replace(/\s+/g, " ").trim();

/** The Wiktionary page a lemma lives on: English verbs are listed as "to work" but the page is "work". */
export const pageFor = (lemma: string, base: string): string => (base === "en" ? lemma.replace(/^to /, "") : lemma);

async function defs(lemma: string, base: string, name: string): Promise<{ pos: string; def: string }[] | null> {
  const url = `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(pageFor(lemma, base))}`;
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (!r) continue;
    if (r.status === 404) return [];
    if (r.status === 429) { await Bun.sleep(2000 * (i + 1)); continue; }
    if (!r.ok) return null;
    const j = (await r.json()) as Record<string, { language: string; partOfSpeech: string; definitions?: { definition?: string }[] }[]>;
    const out: { pos: string; def: string }[] = [];
    for (const e of j[base] ?? []) {
      if (e.language !== name) continue;
      for (const d of e.definitions ?? []) {
        const t = strip(d.definition ?? "");
        if (t && !FORM.test(t)) out.push({ pos: e.partOfSpeech, def: t });
      }
    }
    return out;
  }
  return null;
}

if (import.meta.main) await main();

async function main() {
  const [lang, outDir] = process.argv.slice(2);
  if (!lang || !outDir) {
    console.error("usage: bun scripts/sense-candidates.ts <lang> <out-dir>");
    process.exit(1);
  }
  const base = lang.split("-")[0]!;
  const name = wiktionaryName(base);
  if (!name) {
    console.error(`no Wiktionary language name for "${base}": add it to WIKTIONARY_NAME`);
    process.exit(1);
  }
  // the wordlist the plugin would load: ~/.lazy-polyglot/wordlists/<lang>.json first, then the bundled one
  const path = wordlistPath(lang);
  if (!path) {
    console.error(`no wordlist for "${lang}"`);
    process.exit(1);
  }
  const mapping = readJson<Record<string, string>>(path, `wordlist ${lang}`);
  const gloss = new Map(loadConcepts().map((c) => [c.id, c.gloss]));
  const entries = Object.entries(mapping);
  const out: Record<string, unknown> = {};
  let failed = 0;
  for (let i = 0; i < entries.length; i += 6) {
    await Promise.all(
      entries.slice(i, i + 6).map(async ([id, lemma]) => {
        const d = await defs(lemma, base, name);
        if (d === null) failed++;
        out[id] = { lemma, gloss: gloss.get(id), defs: d ?? [] };
      }),
    );
    await Bun.sleep(300);
  }
  await Bun.write(join(outDir, `candidates-${lang}.json`), JSON.stringify(out, null, 1));
  console.log(`${lang}: ${entries.length} words from ${path}, ${failed} failed`);
}
