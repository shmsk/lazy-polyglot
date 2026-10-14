import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DATA_DIR, clashesElsewhere, loadSenses, loadWordlist } from "../src/store.ts";
import { answerMatch, checkAnswer } from "../src/recall.ts";
import { answerPlacement } from "../src/placement.ts";
import { answerCard } from "../src/cards.ts";
import { buildInstruction, INSTRUCTION_BUDGET } from "../src/instruction.ts";
import { mergeTopics, validateTopic, type TopicFile } from "../src/topics.ts";
import { validateSenses, validateConcepts } from "../src/validate.ts";
import { isAbsorbed, shownSenses, type Config, type Sense, type State, type Word } from "../src/types.ts";
import type { Pick } from "../src/scheduler.ts";

const NOW = "2026-10-14T10:00:00.000Z";
const CONCEPTS = join(import.meta.dir, "..", "data", "concepts.json");
const { concepts } = validateConcepts(CONCEPTS);

const MAP: Sense = { id: "map", use: "weave", gloss: { en: "map", ru: "карта", uz: "xarita" } };
const MENU: Sense = { id: "menu", use: "weave", gloss: { en: "menu", ru: "меню", uz: "menyu" } };
const CARD: Sense = { id: "playing-card", use: "accept", gloss: { en: "card", ru: "карта (игральная)" } };
const carta: Word = { id: "paper", target: "carta", pos: "noun", tier: 1, gloss: { en: "paper", ru: "бумага" }, senses: [MAP, MENU, CARD] };
const ora: Word = { id: "hour", target: "ora", pos: "noun", tier: 1, gloss: { en: "hour", ru: "час" }, senses: [{ id: "now", use: "accept", concept: "now", gloss: { en: "now", ru: "сейчас" } }] };
const adesso: Word = { id: "now", target: "adesso", pos: "adv", tier: 1, gloss: { en: "now", ru: "сейчас" } };
const acqua: Word = { id: "water", target: "acqua", pos: "noun", tier: 1, gloss: { en: "water", ru: "вода" } };
const WORDS = [carta, ora, adesso, acqua];
const config: Config = { lang: "it", native: "ru", level: 4 };

describe("grading other meanings", () => {
  test("any sense counts, in any gloss language but the target's own; the main meaning wins a tie", () => {
    expect(checkAnswer("map", carta, "it")).toBe(true);
    expect(checkAnswer("Меню", carta, "it")).toBe(true);
    expect(checkAnswer("игральная", carta, "it")).toBe(true);
    expect(checkAnswer("pane", carta, "it")).toBe(false);
    expect(answerMatch("paper", carta, "it")).toBe("main");
    expect(answerMatch("map", carta, "it")).toBe(MAP);
    // learning English, "map" is the word itself, not a translation of it
    expect(checkAnswer("map", carta, "en")).toBe(false);
  });

  test("placement: a sense marks the word known and says which meaning matched", () => {
    const state: State = {};
    const r = answerPlacement(WORDS, state, [], carta, "map", "it", NOW);
    expect(r.ok).toBe(true);
    expect(r.sense?.id).toBe("map");
    expect(isAbsorbed(state.paper)).toBe(true);
    expect(answerPlacement(WORDS, {}, [], carta, "бумага", "it", NOW).sense).toBeUndefined();
  });

  test("ora = now is right for ora, and leaves the now concept (adesso) untouched", () => {
    const state: State = {};
    expect(answerPlacement(WORDS, state, [], ora, "now", "it", NOW).ok).toBe(true);
    expect(isAbsorbed(state.hour)).toBe(true);
    expect(state.now).toBeUndefined();
  });

  test("a forward card names the meaning given and lists the everyday others", () => {
    const state: State = { paper: { exposures: 2, lastSeen: NOW, step: 1, due: NOW } };
    const r = answerCard(WORDS, state, config, [], { id: "paper", kind: "review", dir: "forward" }, "карта", NOW);
    expect(r.ok).toBe(true);
    expect(r.meant).toBe("карта");
    expect(r.also).toEqual(["меню"]);
    const plain = answerCard(WORDS, { ...state }, config, [], { id: "paper", kind: "review", dir: "forward" }, "бумага", NOW);
    expect(plain.meant).toBeUndefined();
    expect(plain.also).toEqual(["карта", "меню"]);
    const water = answerCard(WORDS, {}, config, [], { id: "water", kind: "review", dir: "forward" }, "вода", NOW);
    expect(water.also).toBeUndefined();
  });
});

describe("weave instruction", () => {
  const fresh = (word: Word): Pick => ({ word, exposures: 0, step: 0 });
  const familiar = (word: Word): Pick => ({ word, exposures: 4, step: 3 });
  const line = (text: string, prefix: string) => text.split("\n").find((l) => l.startsWith(prefix)) ?? "";

  test("a familiar word carries its weave senses and the one-meaning rule; a new one only its main meaning", () => {
    const text = buildInstruction(config, [fresh(acqua), familiar(carta)], null, null, 3);
    expect(line(text, "Familiar")).toContain("carta = бумага (also карта, меню)");
    expect(text).not.toContain("игральная");
    expect(text).toContain("One meaning per word per reply");
    expect(text).toContain("(here: meaning)");
    const asNew = buildInstruction(config, [fresh(carta)], null, null, 3);
    expect(line(asNew, "New")).toContain("carta = бумага");
    expect(asNew).not.toContain("also");
  });

  test("Anti: words without senses build the same instruction as before (no new lines)", () => {
    const plain = (w: Word): Word => ({ ...w, senses: undefined });
    const picks = [fresh(acqua), familiar(plain(carta))];
    const text = buildInstruction(config, picks, null, null, 3);
    expect(text).not.toContain("also");
    expect(text).not.toContain("≠");
    expect(text).not.toContain("One meaning per word");
    for (const alg of [1, 2] as const) expect(buildInstruction(config, [fresh(carta)], null, null, alg)).toBe(buildInstruction(config, [fresh(plain(carta))], null, null, alg));
  });

  test("a clash with another studied language is shown on the new word", () => {
    const text = buildInstruction(config, [fresh({ ...carta, elsewhere: "es carta = письмо" })], null, null, 3);
    expect(line(text, "New")).toContain("carta = бумага (≠ es carta = письмо)");
    expect(text).toContain("A word marked ≠");
  });

  test("a level-10 instruction with senses on every familiar word stays within budget", () => {
    const words = loadWordlist("it");
    const many = words.slice(0, 12).map((w) => familiar({ ...w, senses: [MAP, MENU] }));
    const text = buildInstruction({ ...config, level: 10 }, many, null, null, 3, words.slice(100, 400));
    expect(text.length).toBeLessThanOrEqual(INSTRUCTION_BUDGET);
  });
});

describe("topics ask for a sense", () => {
  const topic = (sense?: string): TopicFile => ({
    slug: "trip",
    path: "",
    topic: { title: "Trip", lang: "it", createdAt: NOW, active: true, entries: [{ key: "menu", target: "carta", kind: "word", gloss: { en: "menu" }, conceptId: "paper", ...(sense ? { sense } : {}) }] },
  });

  test("the word is woven in that sense from the start", () => {
    const [lead] = mergeTopics(WORDS, [topic("menu")]);
    expect(lead!.focus).toBe("menu");
    const text = buildInstruction(config, [{ word: lead!, exposures: 0, step: 0 }], null, null, 3);
    expect(text).toContain("carta = меню");
    // grading still knows every meaning
    expect(checkAnswer("бумага", lead!, "it")).toBe(true);
  });

  test("an unknown sense id is ignored; a sense without conceptId is invalid", () => {
    expect(mergeTopics(WORDS, [topic("nope")])[0]!.focus).toBeUndefined();
    const bad = topic("menu").topic;
    delete bad.entries[0]!.conceptId;
    expect(validateTopic(bad, "trip", new Set(concepts.keys())).join(" ")).toContain("sense must be");
  });
});

describe("senses files", () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-senses-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const check = (file: unknown, mapping: Record<string, string> = { paper: "carta", hour: "ora", now: "adesso" }, lang = "it") => {
    const path = join(dir, "x.json");
    writeFileSync(path, JSON.stringify(file));
    return validateSenses(path, mapping, concepts, lang).errors.join("\n");
  };

  test("a good file passes", () => {
    expect(check({ paper: [MAP, MENU, CARD], hour: [{ id: "now", use: "accept", concept: "now" }] })).toBe("");
  });

  test("the validator rejects what would grade or teach the wrong thing", () => {
    expect(check({ paper: [MAP, MENU, { ...CARD, use: "weave" }] })).toContain("at most 2");
    expect(check({ chair: [MAP] })).toContain("not a word of this language");
    expect(check({ paper: [{ ...MAP, use: "often" }] })).toContain('use must be "weave" or "accept"');
    expect(check({ paper: [{ id: "paper", use: "accept", gloss: { en: "paper" } }] })).toContain("repeats the word's own gloss");
    expect(check({ hour: [{ id: "now", use: "accept", gloss: { en: "now" } }] })).toContain('mark it {"concept": "now"');
    expect(check({ hour: [{ id: "now", use: "weave", concept: "now" }] })).toContain('stays "accept"');
    expect(check({ paper: [{ id: "Map", use: "weave", gloss: { en: "map" } }] })).toContain("kebab-case");
    expect(check({ paper: [{ id: "map", use: "weave", gloss: { it: "mappa" } }] })).toContain("target language itself");
  });
});

describe("loading senses (user files, variants)", () => {
  const user = (sub: string, name: string, content: unknown) => {
    mkdirSync(join(DATA_DIR, sub), { recursive: true });
    writeFileSync(join(DATA_DIR, sub, `${name}.json`), JSON.stringify(content));
  };
  afterAll(() => {
    for (const sub of ["wordlists", "senses"]) for (const n of ["xs", "xs-yy"]) rmSync(join(DATA_DIR, sub, `${n}.json`), { force: true });
  });

  test("a variant keeps the base senses for words it spells the same and drops them where it respells", () => {
    const ids = [...concepts.keys()];
    user("wordlists", "xs", Object.fromEntries(ids.map((id, i) => [id, `w${i}`])));
    user("wordlists", "xs-yy", { car: "auto2" });
    user("senses", "xs", { paper: [MAP], car: [MENU], hour: [{ id: "now", use: "accept", concept: "now" }] });
    const base = loadSenses("xs");
    expect(base.paper).toEqual([MAP]);
    // a concept sense without a gloss takes the concept's
    expect(base.hour![0]!.gloss?.en).toBe("now");
    const variant = loadSenses("xs-yy");
    expect(variant.paper).toEqual([MAP]);
    expect(variant.car).toBeUndefined();
    user("senses", "xs-yy", { car: [CARD] });
    expect(loadSenses("xs-yy").car).toEqual([CARD]);
    expect(loadWordlist("xs-yy").find((w) => w.id === "car")!.senses).toEqual([CARD]);
    // a meaning that doesn't hold in the region (es piso = apartment, not in Latin America): [] drops the base's
    user("senses", "xs-yy", { car: [CARD], paper: [] });
    expect(loadWordlist("xs-yy").find((w) => w.id === "paper")!.senses).toBeUndefined();
    expect(loadWordlist("xs").find((w) => w.id === "paper")!.senses).toEqual([MAP]);
  });
});

describe("the same spelling in another language the learner studies", () => {
  const path = join(DATA_DIR, "state.es.json");
  afterAll(() => rmSync(path, { force: true }));

  test("Italian carta (paper) is flagged for someone who also learns Spanish (carta = letter)", () => {
    const it = loadWordlist("it");
    const paper = it.find((w) => w.id === "paper")!;
    const house = it.find((w) => w.id === "house")!;
    expect(clashesElsewhere("it", [paper, house], "ru").size).toBe(0); // no Spanish progress yet
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(path, "{}");
    const clashes = clashesElsewhere("it", [paper, house], "ru");
    expect(clashes.get("paper")).toBe("es carta = письмо");
    expect(clashes.has("house")).toBe(false); // casa is house in both
  });
});

describe("a sense the learner's language doesn't split", () => {
  // Russian язык and Uzbek til are both language and tongue: for them lingua has one meaning
  const lingua: Word = { id: "language", target: "lingua", pos: "noun", tier: 1, gloss: { en: "language", ru: "язык", uz: "til" }, senses: [{ id: "tongue", use: "weave", gloss: { en: "tongue" } }] };

  test("is shown to an English speaker and hidden from a Russian one, but graded right for both", () => {
    expect(shownSenses(lingua, "en", "it").map((x) => x.gloss)).toEqual(["tongue"]);
    expect(shownSenses(lingua, "ru", "it")).toEqual([]);
    const familiar = { word: lingua, exposures: 4, step: 3 };
    expect(buildInstruction(config, [familiar], null, null, 3)).not.toContain("also");
    expect(buildInstruction({ ...config, native: "en" }, [familiar], null, null, 3)).toContain("lingua = language (also tongue)");
    expect(checkAnswer("tongue", lingua, "it")).toBe(true);
  });
});
