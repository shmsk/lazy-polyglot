import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { wovenLemmas } from "../src/weave-detect.ts";
import { settleServed } from "../src/served.ts";
import { loadConcepts, loadIrregular, loadWordMapping } from "../src/store.ts";
import type { State } from "../src/types.ts";

const IRREGULAR = join(import.meta.dir, "..", "data", "irregular");
const langs = readdirSync(IRREGULAR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length));
const NOW = "2026-10-14T10:00:00.000Z";

describe("irregular verb forms", () => {
  test("every base language ships a file", () => {
    expect(langs.sort()).toEqual(["de", "en", "es", "fr", "it", "pt", "tr"]);
  });

  test.each(langs)("%s: keys are verbs in its wordlist, forms are lowercase words", (lang) => {
    const verbs = new Set(loadConcepts().filter((c) => c.pos === "verb").map((c) => c.id));
    const mapping = loadWordMapping(lang);
    for (const [id, forms] of Object.entries(loadIrregular(lang))) {
      expect(verbs.has(id)).toBe(true);
      expect(mapping[id]).toBeDefined();
      expect(forms.length).toBeGreaterThan(0);
      for (const f of forms) expect(f).toMatch(/^[\p{Ll}]+$/u);
    }
  });

  test("a variant inherits its base's forms", () => {
    expect(loadIrregular("es-419")["to-be"]).toContain("fue");
    expect(loadIrregular("pt-BR")["to-have"]).toContain("tem");
  });

  // one form per language that shares no root with its lemma
  test.each([
    ["it", "to-be", "Il test **è** (является) verde."],
    ["it", "to-go", "Io **vado** (иду) adesso."],
    ["es", "to-go", "Ya **fue** (пошёл) al servidor."],
    ["es", "to-be", "Eso **soy** (я есть) yo."],
    ["pt", "to-be", "Isso **é** (является) certo."],
    ["pt", "to-be", "Ontem **foi** (был) longo."],
    ["fr", "to-be", "Le test **est** (является) vert."],
    ["fr", "to-have", "J'**ai** (имею) fini."],
    ["de", "to-be", "Der Test **ist** (является) grün."],
    ["de", "to-be", "Es **war** (был) spät."],
    ["en", "to-be", "The build **was** (был) green."],
    ["en", "to-go", "It **went** (прошёл) fine."],
    ["tr", "to-go", "Test **gidiyor** (идёт)."],
  ])("%s %s: %s counts as woven", (lang, id, reply) => {
    const lemma = loadWordMapping(lang)[id]!;
    const forms = { [lemma]: loadIrregular(lang)[id]! };
    expect(wovenLemmas(reply, [lemma], forms)).toEqual([lemma]);
  });

  test("an English verb counts without its leading to", () => {
    expect(wovenLemmas("I **want** (хочу) it.", ["to want"])).toEqual(["to want"]);
    expect(wovenLemmas("She **wanted** (хотела) more.", ["to want"])).toEqual(["to want"]);
  });

  test("a bold e is not è: forms compare with accents", () => {
    const forms = { essere: loadIrregular("it")["to-be"]! };
    expect(wovenLemmas("Pane **e** (и) burro.", ["essere"], forms)).toEqual([]);
  });

  test("a form counts only for a verb that was served", () => {
    const forms = { essere: loadIrregular("it")["to-be"]! };
    expect(wovenLemmas("Lui **va** (идёт) via.", ["essere"], forms)).toEqual([]);
    expect(wovenLemmas("Il test è verde.", ["essere"], forms)).toEqual([]); // not bold
  });

  test("settle: a reply that wove sono climbs essere instead of missing it", () => {
    const state: State = {};
    settleServed(state, { lang: "it", at: NOW, picks: { "to-be": "essere", house: "casa" }, known: {} }, "Ci **sono** (есть) due file.", NOW);
    expect(state["to-be"]!.step).toBe(1);
    expect(state["to-be"]!.missed ?? 0).toBe(0);
    expect(state.house!.missed).toBe(1);
  });
});
