// Wordlist/concept validator, shared by tests/validate-wordlist.ts (repo/CI) and
// `lazy-polyglot validate` (plugin users checking a language they added locally).
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Concept, WordMapping } from "./types.ts";
import { normAnswer } from "./recall.ts";

const POS = new Set(["noun", "verb", "adj", "adv", "num"]);

export function validateConcepts(conceptsPath: string): { concepts: Map<string, Concept>; errors: string[] } {
  const list = JSON.parse(readFileSync(conceptsPath, "utf8")) as Concept[];
  const errors: string[] = [];
  const concepts = new Map<string, Concept>();
  if (list.length < 300) errors.push(`only ${list.length} concepts, need ≥300`);
  for (const [i, c] of list.entries()) {
    if (!c.id || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.id)) errors.push(`#${i}: bad id "${c.id}" (kebab-case slugs only)`);
    if (concepts.has(c.id)) errors.push(`#${i}: duplicate concept "${c.id}"`);
    if (!POS.has(c.pos)) errors.push(`#${i} (${c.id}): bad pos "${c.pos}"`);
    if (!Number.isInteger(c.tier) || c.tier < 1) errors.push(`#${i} (${c.id}): bad tier "${c.tier}"`);
    if (!c.gloss?.en) errors.push(`#${i} (${c.id}): missing gloss.en`);
    if (!c.gloss?.ru) errors.push(`#${i} (${c.id}): missing gloss.ru`);
    concepts.set(c.id, c);
  }
  // en/ru are required above; any further native language (uz, …) is all-or-nothing,
  // so a half-filled gloss key can't ship with learners seeing English fallbacks.
  const keys = new Set(list.flatMap((c) => Object.keys(c.gloss ?? {})));
  for (const key of keys) {
    const without = list.filter((c) => !c.gloss?.[key]);
    if (without.length) errors.push(`gloss.${key} missing on ${without.length} concepts: ${without.slice(0, 10).map((c) => c.id).join(", ")}${without.length > 10 ? ", …" : ""}`);
  }
  // alt answers are graded as right, so one that reads as another concept's gloss would pass the wrong word
  const glossOwners = new Map<string, Set<string>>();
  for (const c of list)
    for (const [k, g] of Object.entries(c.gloss ?? {}))
      for (const v of g.split(/[,;/()]/).map(normAnswer).filter(Boolean)) {
        const key = `${k}:${v}`;
        glossOwners.set(key, (glossOwners.get(key) ?? new Set()).add(c.id));
      }
  for (const c of list) {
    if (c.alt === undefined) continue;
    if (typeof c.alt !== "object" || Array.isArray(c.alt)) {
      errors.push(`${c.id}: alt must be an object of lists`);
      continue;
    }
    for (const [k, alts] of Object.entries(c.alt)) {
      if (!keys.has(k)) errors.push(`${c.id}: alt.${k} is not a gloss language`);
      if (!Array.isArray(alts) || !alts.length || alts.some((a) => typeof a !== "string" || !normAnswer(a))) {
        errors.push(`${c.id}: alt.${k} must be a non-empty list of answers`);
        continue;
      }
      for (const a of alts) {
        const owners = [...(glossOwners.get(`${k}:${normAnswer(a)}`) ?? [])];
        if (owners.includes(c.id)) errors.push(`${c.id}: alt.${k} "${a}" repeats its own gloss`);
        const others = owners.filter((o) => o !== c.id);
        if (others.length) errors.push(`${c.id}: alt.${k} "${a}" is the gloss of ${others.join(", ")}`);
      }
    }
  }
  return { concepts, errors };
}

/**
 * A language to validate: its files base first. One path for a plain language;
 * two for a regional variant — the base, then the sparse overlay (`pt.json`, `pt-BR.json`).
 */
export type ValidationTarget = string[];

function readMapping(path: string): WordMapping {
  return JSON.parse(readFileSync(path, "utf8")) as WordMapping;
}

/** Overlay-only checks: it must stay a diff — known concepts, no copies of the base word. */
function validateOverlay(overlay: WordMapping, base: WordMapping, concepts: Map<string, Concept>): string[] {
  const errors: string[] = [];
  for (const [id, lemma] of Object.entries(overlay)) {
    if (!concepts.has(id)) errors.push(`"${id}": unknown concept (not in concepts.json)`);
    else if (base[id] === lemma) errors.push(`"${id}": "${lemma}" is the same as the base word — drop it from the variant file`);
  }
  return errors;
}

/**
 * Validate one language. For a variant the mechanical rules (coverage, shared words)
 * run on the merged result, so a variant word that clashes with base words is caught.
 */
export function validateMapping(
  target: ValidationTarget,
  concepts: Map<string, Concept>,
  requireFull: boolean,
): { count: number; overrides: number | null; missing: string[]; shared: string[]; errors: string[] } {
  const layers = target.map(readMapping);
  const mapping = Object.assign({}, ...layers) as WordMapping;
  const overlay = layers.length > 1 ? layers[layers.length - 1]! : null;
  const errors: string[] = overlay ? validateOverlay(overlay, layers[0]!, concepts) : [];
  const entries = Object.entries(mapping);
  if (entries.length < 300) errors.push(`only ${entries.length} entries, need ≥300`);

  const missing = [...concepts.keys()].filter((id) => !(id in mapping));
  if (requireFull && missing.length) {
    errors.push(`missing ${missing.length} concepts: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", …" : ""}`);
  }

  const byLemma = new Map<string, string[]>();
  for (const [id, lemma] of entries) {
    if (!concepts.has(id)) errors.push(`"${id}": unknown concept (not in concepts.json)`);
    if (typeof lemma !== "string" || !lemma) errors.push(`"${id}": empty lemma`);
    else {
      if (lemma.split(" ").length > 3) errors.push(`"${id}" (${lemma}): longer than 3 tokens`);
      byLemma.set(lemma, [...(byLemma.get(lemma) ?? []), id]);
    }
  }
  // A language may use one word for two concepts when that is genuinely its everyday
  // word for both (es mañana = morning and tomorrow). Three or more is a lazy list, not a language.
  const shared = [...byLemma].filter(([, ids]) => ids.length > 1);
  for (const [lemma, ids] of shared) {
    if (ids.length > 2) errors.push(`"${lemma}" is used by ${ids.length} concepts (${ids.join(", ")}); at most 2 may share a word`);
  }
  return {
    count: entries.length,
    overrides: overlay ? Object.keys(overlay).length : null,
    missing,
    shared: shared.map(([lemma, ids]) => `${lemma} (${ids.join(", ")})`),
    errors: [...new Set(errors)],
  };
}

/** The senses file next to a wordlist (…/wordlists/it.json → …/senses/it.json). */
export const sensesPathFor = (wordlistPath: string): string => join(dirname(dirname(wordlistPath)), "senses", basename(wordlistPath));

const SENSE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * One language's senses file (concept id → Sense[]), checked against its merged wordlist.
 * A sense is graded as a right answer, so it must not read as the word's own gloss, and one
 * that reads as another listed concept's gloss must say so (`concept`) and stay `accept`:
 * ora = now is a fair answer, but replies teach "now" with adesso.
 */
export function validateSenses(path: string, mapping: WordMapping, concepts: Map<string, Concept>, lang: string): { count: number; errors: string[] } {
  let file: unknown;
  try {
    file = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { count: 0, errors: [`cannot read: ${(e as Error).message}`] };
  }
  if (!file || typeof file !== "object" || Array.isArray(file)) return { count: 0, errors: ["must be an object: concept id → list of senses"] };
  const errors: string[] = [];
  const own = lang.split("-")[0];
  const keys = new Set([...concepts.values()].flatMap((c) => Object.keys(c.gloss)));
  const owners = new Map<string, Set<string>>();
  for (const c of concepts.values())
    for (const [k, g] of Object.entries(c.gloss))
      for (const v of g.split(/[,;/()]/).map(normAnswer).filter(Boolean)) owners.set(`${k}:${v}`, (owners.get(`${k}:${v}`) ?? new Set()).add(c.id));
  let count = 0;
  for (const [id, list] of Object.entries(file as Record<string, unknown>)) {
    const at = `${id}${mapping[id] ? ` (${mapping[id]})` : ""}`;
    if (!concepts.has(id) || mapping[id] === undefined) {
      errors.push(`${id}: not a word of this language`);
      continue;
    }
    // [] is how a regional variant says "none of the base's meanings hold here"
    if (!Array.isArray(list)) {
      errors.push(`${at}: must be a list of senses`);
      continue;
    }
    const ids = new Set<string>();
    let weave = 0;
    for (const s of list as Record<string, unknown>[]) {
      count++;
      const sid = typeof s?.id === "string" ? s.id : "";
      const where = `${at} sense "${sid}"`;
      if (!SENSE_ID.test(sid)) errors.push(`${at}: sense id "${sid}" must be kebab-case`);
      else if (ids.has(sid)) errors.push(`${at}: duplicate sense "${sid}"`);
      ids.add(sid);
      if (s.use !== "weave" && s.use !== "accept") errors.push(`${where}: use must be "weave" or "accept"`);
      if (s.use === "weave") weave++;
      if (s.concept !== undefined) {
        if (typeof s.concept !== "string" || !concepts.has(s.concept)) errors.push(`${where}: concept "${String(s.concept)}" is not a listed concept`);
        else if (s.concept === id) errors.push(`${where}: concept is the word's own`);
        if (s.use === "weave") errors.push(`${where}: a sense that is another listed concept stays "accept"`);
      }
      const gloss = s.gloss as Record<string, unknown> | undefined;
      if (gloss === undefined) {
        if (s.concept === undefined) errors.push(`${where}: needs a gloss or a concept`);
        continue;
      }
      if (typeof gloss !== "object" || Array.isArray(gloss) || !Object.keys(gloss).length) {
        errors.push(`${where}: gloss must be an object of translations`);
        continue;
      }
      // a gloss that collides in every language it gives is that other concept, not a new meaning;
      // one that collides in some only is fine (ver = watch, ru смотреть is also to-look's word)
      const clashing = new Map<string, string[]>();
      for (const [k, g] of Object.entries(gloss)) {
        if (!keys.has(k)) errors.push(`${where}: gloss.${k} is not a gloss language`);
        if (k === own) errors.push(`${where}: gloss.${k} is the target language itself`);
        if (typeof g !== "string" || !normAnswer(g)) {
          errors.push(`${where}: gloss.${k} is empty`);
          continue;
        }
        for (const v of g.split(/[,;/()]/).map(normAnswer).filter(Boolean)) {
          const o = [...(owners.get(`${k}:${v}`) ?? [])];
          if (o.includes(id)) errors.push(`${where}: gloss.${k} "${v}" repeats the word's own gloss`);
          const others = o.filter((x) => x !== id && x !== s.concept);
          if (others.length && !clashing.has(k)) clashing.set(k, others);
        }
      }
      if (s.concept === undefined && clashing.size > 0 && clashing.size === Object.keys(gloss).length) {
        const [k, others] = [...clashing][0]!;
        errors.push(`${where}: gloss.${k} is the gloss of ${others.join(", ")} (and so is every other key); mark it {"concept": "${others[0]}", "use": "accept"}`);
      }
    }
    if (weave > 2) errors.push(`${at}: ${weave} weave senses, at most 2`);
  }
  return { count, errors: [...new Set(errors)] };
}

/** Validate concepts plus each language, printing a report. Returns true when everything passed. */
export function runValidation(conceptsPath: string, targets: ValidationTarget[], requireFull: boolean, sensesFor: (wordlistPath: string) => string = sensesPathFor): boolean {
  let failed = false;
  const { concepts, errors: conceptErrors } = validateConcepts(conceptsPath);
  if (conceptErrors.length) {
    failed = true;
    console.error(`${conceptsPath} FAILED:\n` + conceptErrors.map((e) => `  - ${e}`).join("\n"));
  } else {
    console.log(`${conceptsPath} OK: ${concepts.size} concepts, unique ids, all POS valid`);
  }

  for (const target of targets) {
    const path = target[target.length - 1]!;
    const { count, overrides, missing, shared, errors } = validateMapping(target, concepts, requireFull);
    const variant = overrides === null ? "" : ` (variant: ${overrides} overrides over ${target[0]})`;
    if (errors.length) {
      failed = true;
      console.error(`${path}${variant} FAILED:\n` + errors.map((e) => `  - ${e}`).join("\n"));
    } else {
      console.log(`${path}${variant} OK: ${count} entries, all concepts known, coverage ${count}/${concepts.size}${missing.length ? "" : " (full)"}`);
      // not an error — listed so a reviewer can check each one is a real shared word
      if (shared.length) console.log(`  ${shared.length} shared words: ${shared.join("; ")}`);
    }
    const sensesPath = sensesFor(path);
    if (existsSync(sensesPath)) {
      const merged = Object.assign({}, ...target.map(readMapping)) as WordMapping;
      const { count: n, errors: senseErrors } = validateSenses(sensesPath, merged, concepts, basename(path, ".json"));
      if (senseErrors.length) {
        failed = true;
        console.error(`${sensesPath} FAILED:\n` + senseErrors.map((e) => `  - ${e}`).join("\n"));
      } else {
        console.log(`${sensesPath} OK: ${n} senses`);
      }
    }
  }
  return !failed;
}
