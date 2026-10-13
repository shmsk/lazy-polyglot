#!/usr/bin/env bun
/**
 * Rank every concept by how often its word turns up, so new words come most useful first.
 * Writes `rank` (1..N) into data/concepts.json; nothing else in the file changes.
 *
 *   bun scripts/rank-words.ts <work-dir>
 *
 * Sources, downloaded into <work-dir> on first run and never committed (only the ranks ship):
 * - FrequencyWords by Hermit Dave, OpenSubtitles 2018, 50k lists (content CC BY-SA 4.0)
 * - Leipzig Corpora Collection, news 2020, 300K sentences (CC BY)
 *
 * Per language a concept's position among our concepts is (3 × subtitle position + news position) / 4:
 * subtitles are the base (how people talk), news trims film quirks (signore, sir). A concept's
 * score is the median over en, es, it, pt, fr, de. Turkish sits out: an agglutinative lemma
 * spreads over dozens of surface forms, so its counts don't compare. Numerals 0–12 come right after
 * the first 40 words, as they always have: every number is built from them. The other numerals,
 * weekdays and months stay blocks in their own order, placed at their members' median.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONCEPTS_PATH, loadConcepts, loadIrregular, loadWordMapping } from "../src/store.ts";

const work = process.argv[2];
if (!work) {
  console.error("usage: bun scripts/rank-words.ts <work-dir>");
  process.exit(1);
}

const LANGS = ["en", "es", "it", "pt", "fr", "de"] as const;
type Lang = (typeof LANGS)[number];
const LEIPZIG: Record<Lang, string> = { en: "eng", es: "spa", it: "ita", pt: "por", fr: "fra", de: "deu" };
const SUBTITLE_WEIGHT = 3;
/** Forms a guess must not borrow: a derived form this frequent is a function word (para, como, de). */
const FUNCTION_RANK = 150;
/** Hand fixes, concept id → score added after the median; empty until a mover looks wrong. */
const OVERRIDES: Record<string, number> = {};

/** Numerals 0–12: a block pinned after this many words. */
const EARLY_NUMERALS = Array.from({ length: 13 }, (_, i) => `num-${i}`);
const EARLY_NUMERALS_AT = 40;
const BLOCKS: string[][] = [
  ["num-13", "num-14", "num-15", "num-16", "num-17", "num-18", "num-19", "num-20", "num-30", "num-40", "num-50", "num-60", "num-70", "num-80", "num-90", "num-100", "num-1000"],
  ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
  ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"],
];

async function download(url: string, path: string) {
  if (existsSync(path)) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await Bun.write(path, res);
}

type Freq = Map<string, { rank: number; n: number }>;

function ranked(counts: Map<string, number>): Freq {
  const out: Freq = new Map();
  [...counts].sort((a, b) => b[1] - a[1]).forEach(([w, n], i) => out.set(w, { rank: i + 1, n }));
  return out;
}

async function subtitles(lang: Lang): Promise<Freq> {
  const path = join(work!, `${lang}_50k.txt`);
  await download(`https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/${lang}/${lang}_50k.txt`, path);
  const counts = new Map<string, number>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const [w, n] = line.trim().split(" ");
    if (w && n && !counts.has(w)) counts.set(w, Number(n));
  }
  return ranked(counts);
}

async function news(lang: Lang): Promise<Freq> {
  const name = `${LEIPZIG[lang]}_news_2020_300K`;
  const words = join(work!, name, `${name}-words.txt`);
  if (!existsSync(words)) {
    const archive = join(work!, `${name}.tar.gz`);
    await download(`https://downloads.wortschatz-leipzig.de/corpora/${name}.tar.gz`, archive);
    const tar = Bun.spawnSync(["tar", "xzf", archive, "-C", work!, `${name}/${name}-words.txt`]);
    if (tar.exitCode !== 0) throw new Error(`tar ${archive}: ${tar.stderr.toString()}`);
  }
  // id \t word \t count; case variants merge, tokens with digits or punctuation drop
  const counts = new Map<string, number>();
  for (const line of readFileSync(words, "utf8").split("\n")) {
    const [, w, n] = line.split("\t");
    if (!w || !n || !/^\p{L}[\p{L}']*$/u.test(w)) continue;
    const k = w.toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + Number(n));
  }
  return ranked(counts);
}

/** The bare lemma: "to want" → want, "se trouver" → trouver, "sich setzen" → setzen. */
const bare = (lemma: string) => lemma.toLowerCase().replace(/^(to|se|s'|sich) ?/, "");

/** Regular forms a word shows up as in running text; irregular ones come from data/irregular. */
function guesses(lang: Lang, lemma: string, pos: string): string[] {
  const w = bare(lemma);
  if (pos === "verb") {
    const stem = (re: RegExp) => w.match(re)?.[1];
    switch (lang) {
      case "en":
        return [`${w}s`, `${w}ed`, `${w}d`, `${w}ing`, `${w.replace(/e$/, "")}ing`];
      case "it": {
        const s = stem(/^(.*)(are|ere|ire)(si)?$/) ?? stem(/^(.*)(arsi|ersi|irsi)$/);
        return s ? ["o", "a", "e", "i", "ato", "uto", "ito", "iamo", "ava", "eva", "iva"].map((e) => s + e) : [];
      }
      case "es": {
        const s = stem(/^(.*)(ar|er|ir)(se)?$/);
        return s ? ["o", "a", "e", "as", "es", "an", "en", "ado", "ido", "amos", "emos", "imos", "ó", "ió", "aba", "ía"].map((e) => s + e) : [];
      }
      case "pt": {
        const s = stem(/^(.*)(ar|er|ir)$/);
        return s ? ["o", "a", "e", "as", "es", "am", "em", "ado", "ido", "amos", "emos", "imos", "ou", "eu", "iu", "ava", "ia"].map((e) => s + e) : [];
      }
      case "fr": {
        const s = stem(/^(.*)(er|ir|re)$/);
        return s ? ["e", "es", "ent", "é", "ée", "ons", "ez", "ait", "is", "it", "i", "ais"].map((e) => s + e) : [];
      }
      case "de": {
        const s = stem(/^(.*?)(en|n)$/);
        return s ? ["e", "st", "t", "te", "ten", "et"].map((e) => s + e).concat(`ge${s}t`) : [];
      }
    }
  }
  if (w.includes(" ")) return [];
  switch (lang) {
    case "it":
      return [w.replace(/o$/, "i"), w.replace(/a$/, "e"), w.replace(/e$/, "i"), w.replace(/o$/, "a")];
    case "es":
    case "pt":
      return [`${w}s`, `${w}es`, w.replace(/o$/, "a"), w.replace(/o$/, "os")];
    case "fr":
      return [`${w}s`, `${w}e`, `${w}x`];
    case "de":
      return [`${w}e`, `${w}en`, `${w}n`, `${w}er`, `${w}s`];
    case "en":
      return [`${w}s`];
  }
}

/** Best rank of a word over its forms, and its total count. */
function lookup(freq: Freq, lemma: string, sure: string[], guessed: string[]): number {
  let best = Infinity;
  for (const f of new Set(sure)) best = Math.min(best, freq.get(f.toLowerCase())?.rank ?? Infinity);
  for (const f of new Set(guessed)) {
    const e = freq.get(f.toLowerCase());
    if (e && e.rank > FUNCTION_RANK) best = Math.min(best, e.rank);
  }
  // a multi-word lemma ("ice cream", "avere bisogno") is as rare as its rarest word
  if (best === Infinity && bare(lemma).includes(" ")) best = Math.max(...bare(lemma).split(" ").map((t) => freq.get(t)?.rank ?? Infinity));
  return best;
}

/** Position 1..n of each id when sorted by rank (unfound words last). */
function positions(ranks: Map<string, number>): Map<string, number> {
  return new Map([...ranks].sort((a, b) => a[1] - b[1]).map(([id], i) => [id, i + 1]));
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const concepts = loadConcepts();
const scores = new Map<string, number[]>();
for (const lang of LANGS) {
  const [subs, press] = await Promise.all([subtitles(lang), news(lang)]);
  const mapping = loadWordMapping(lang);
  const irregular = loadIrregular(lang);
  const bySubs = new Map<string, number>();
  const byNews = new Map<string, number>();
  for (const c of concepts) {
    const lemma = mapping[c.id];
    if (!lemma) continue;
    const sure = [bare(lemma), ...(irregular[c.id] ?? [])];
    const guessed = guesses(lang, lemma, c.pos);
    bySubs.set(c.id, lookup(subs, lemma, sure, guessed));
    byNews.set(c.id, lookup(press, lemma, sure, guessed));
  }
  const pS = positions(bySubs);
  const pN = positions(byNews);
  for (const id of pS.keys()) {
    const s = (SUBTITLE_WEIGHT * pS.get(id)! + pN.get(id)!) / (SUBTITLE_WEIGHT + 1);
    scores.set(id, [...(scores.get(id) ?? []), s]);
  }
  console.log(`${lang}: ${pS.size} words`);
}

const score = (id: string) => median(scores.get(id) ?? [Infinity]) + (OVERRIDES[id] ?? 0);
const inBlock = new Set([...BLOCKS.flat(), ...EARLY_NUMERALS]);
const units = [
  ...concepts.filter((c) => !inBlock.has(c.id)).map((c) => ({ ids: [c.id], score: score(c.id) })),
  ...BLOCKS.map((ids) => ({ ids, score: median(ids.map(score)) })),
];
const order = units.sort((a, b) => a.score - b.score).flatMap((u) => u.ids); // stable: file order breaks ties
order.splice(EARLY_NUMERALS_AT, 0, ...EARLY_NUMERALS);
const rank = new Map(order.map((id, i) => [id, i + 1]));

// one concept per line, as authored: only the rank field is added or replaced
const lines = readFileSync(CONCEPTS_PATH, "utf8").split("\n").map((line) => {
  const id = line.match(/^\s*\{"id":"([^"]+)"/)?.[1];
  if (!id) return line;
  return line.replace(/,"rank":\d+/, "").replace(/("tier":\d+)/, `$1,"rank":${rank.get(id)}`);
});
writeFileSync(CONCEPTS_PATH, lines.join("\n"));

const file = new Map(concepts.map((c, i) => [c.id, i + 1]));
console.log("\nfirst 40:", order.slice(0, 40).join(" "));
console.log("\nbiggest moves up (file → rank):");
for (const id of [...order].sort((a, b) => rank.get(a)! - file.get(a)! - (rank.get(b)! - file.get(b)!)).slice(0, 20)) console.log(`  ${id}: ${file.get(id)} → ${rank.get(id)}`);
