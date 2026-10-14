#!/usr/bin/env bun
/**
 * Candidate meanings for data/senses/<lang>.json, pulled from en.wiktionary's REST API.
 *
 *   bun scripts/sense-candidates.ts <lang> <out-dir>
 *
 * Writes <out-dir>/candidates-<lang>.json: concept id → { lemma, gloss, defs[] }. For a
 * regional variant (pt-BR) only its overlay lemmas are fetched. The output is raw material
 * for a person or an agent writing the senses file, never committed: Wiktionary text is
 * CC BY-SA, so the senses file carries only our own one- or two-word glosses.
 */
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const NAME: Record<string, string> = { it: "Italian", es: "Spanish", pt: "Portuguese", en: "English", de: "German", fr: "French", tr: "Turkish" };
const UA = "lazy-polyglot-sense-candidates/1.0 (https://github.com/shmsk/lazy-polyglot)";
// grammatical-form lines, not meanings
const FORM = /^(plural|feminine|masculine|inflection|first-person|second-person|third-person|singular|gerund|past participle|present participle|alternative|obsolete|archaic|misspelling|nonstandard)\b/i;
const strip = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\.mw-parser-output[^}]*}/g, "").replace(/\s+/g, " ").trim();

async function defs(lemma: string, base: string): Promise<{ pos: string; def: string }[] | null> {
  const url = `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(lemma)}`;
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (!r) continue;
    if (r.status === 404) return [];
    if (r.status === 429) { await Bun.sleep(2000 * (i + 1)); continue; }
    if (!r.ok) return null;
    const j = (await r.json()) as Record<string, { language: string; partOfSpeech: string; definitions?: { definition?: string }[] }[]>;
    const out: { pos: string; def: string }[] = [];
    for (const e of j[base] ?? []) {
      if (e.language !== NAME[base]) continue;
      for (const d of e.definitions ?? []) {
        const t = strip(d.definition ?? "");
        if (t && !FORM.test(t)) out.push({ pos: e.partOfSpeech, def: t });
      }
    }
    return out;
  }
  return null;
}

const [lang, outDir] = process.argv.slice(2);
if (!lang || !outDir) {
  console.error("usage: bun scripts/sense-candidates.ts <lang> <out-dir>");
  process.exit(1);
}
const base = lang.split("-")[0]!;
if (!NAME[base]) {
  console.error(`no Wiktionary language name for "${base}"`);
  process.exit(1);
}
const mapping: Record<string, string> = await Bun.file(join(ROOT, "data/wordlists", `${lang}.json`)).json();
const concepts: { id: string; gloss: Record<string, string> }[] = await Bun.file(join(ROOT, "data/concepts.json")).json();
const gloss = new Map(concepts.map((c) => [c.id, c.gloss]));
const entries = Object.entries(mapping);
const out: Record<string, unknown> = {};
let failed = 0;
for (let i = 0; i < entries.length; i += 6) {
  await Promise.all(
    entries.slice(i, i + 6).map(async ([id, lemma]) => {
      const d = await defs(lemma, base);
      if (d === null) failed++;
      out[id] = { lemma, gloss: gloss.get(id), defs: d ?? [] };
    }),
  );
  await Bun.sleep(300);
}
await Bun.write(join(outDir, `candidates-${lang}.json`), JSON.stringify(out, null, 1));
console.log(`${lang}: ${entries.length} words, ${failed} failed`);
