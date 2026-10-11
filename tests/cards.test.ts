import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { acceptCard, answerCard, cardDir, cardQueue, cardStatus, checkReverse, foldTarget } from "../src/cards.ts";
import { markKnown } from "../src/placement.ts";
import { isAbsorbed, type Config, type State, type Word } from "../src/types.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const w = (id: string, target: string, en: string, ru: string): Word => ({ id, target, pos: "noun", tier: 1, gloss: { en, ru } });
const WORDS = [w("house", "casa", "house", "дом"), w("time", "tempo", "time", "время"), w("tomorrow", "domani", "tomorrow", "завтра"), w("morning", "domani", "morning", "утро"), w("city", "città", "city", "город")];
const NOW = "2026-10-05T10:00:00.000Z";
const EARLIER = "2026-10-01T10:00:00.000Z";
const CONFIG: Config = { lang: "it", native: "ru", level: 2 };

describe("card direction", () => {
  test("forward below step 3, then odd steps reverse", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(cardDir)).toEqual(["forward", "forward", "forward", "reverse", "forward", "reverse", "forward", "reverse"]);
  });
});

describe("reverse check", () => {
  test("accents, case, an article and spaces don't matter", () => {
    expect(checkReverse("Citta", WORDS[4]!)).toBe(true);
    expect(checkReverse("  la città ", WORDS[4]!)).toBe(true);
    expect(checkReverse("l'acqua", w("water", "acqua", "water", "вода"))).toBe(true);
  });
  test("another word, an empty answer or a bare article is wrong", () => {
    expect(checkReverse("casa", WORDS[1]!)).toBe(false);
    expect(checkReverse("", WORDS[0]!)).toBe(false);
    expect(checkReverse("la", WORDS[0]!)).toBe(false);
  });
  test("a regional variant also accepts its base lemma", () => {
    expect(checkReverse("ordenador", { ...WORDS[0]!, target: "computadora", baseTarget: "ordenador" })).toBe(true);
  });
  test("fold keeps a lone article as itself", () => {
    expect(foldTarget("La")).toBe("la");
  });
});

describe("queue", () => {
  test("due reviews first, most overdue first, then placement; not-due and known words left out", () => {
    const state: State = {
      time: { exposures: 2, lastSeen: EARLIER, step: 1, due: "2026-10-04T00:00:00.000Z" },
      house: { exposures: 4, lastSeen: EARLIER, step: 3, due: "2026-10-02T00:00:00.000Z" },
      city: { exposures: 1, lastSeen: NOW, step: 1, due: "2026-10-06T00:00:00.000Z" },
    };
    const cards = cardQueue(WORDS, state, CONFIG, 10, NOW);
    expect(cards.map((c) => [c.id, c.kind, c.dir])).toEqual([
      ["house", "review", "reverse"],
      ["time", "review", "forward"],
      ["tomorrow", "placement", "forward"],
      ["city", "placement", "forward"],
    ]);
    expect(cards[0]!.prompt).toBe("дом");
    expect(cards[1]!.prompt).toBe("tempo");
  });
  test("a shared lemma is one card, and n caps the queue", () => {
    expect(cardQueue(WORDS, {}, CONFIG, 10, NOW).filter((c) => c.prompt === "domani")).toHaveLength(1);
    expect(cardQueue(WORDS, {}, CONFIG, 2, NOW)).toHaveLength(2);
  });
});

describe("answers", () => {
  test("forward review: right climbs every concept the answer names", () => {
    const state: State = { tomorrow: { exposures: 2, lastSeen: EARLIER, step: 1, due: EARLIER }, morning: { exposures: 2, lastSeen: EARLIER, step: 1, due: EARLIER } };
    const r = answerCard(WORDS, state, CONFIG, [], { id: "tomorrow", kind: "review", dir: "forward" }, "утро", NOW);
    expect(r.ok).toBe(true);
    expect(state.morning!.step).toBe(2);
    expect(state.tomorrow!.step).toBe(1);
  });
  test("reverse review: right climbs, wrong resets, expected is the target word", () => {
    const state: State = { house: { exposures: 4, lastSeen: EARLIER, step: 3, due: EARLIER } };
    const ok = answerCard(WORDS, state, CONFIG, [], { id: "house", kind: "review", dir: "reverse" }, "casa", NOW);
    expect(ok).toMatchObject({ ok: true, expected: "casa", step: 4 });
    const bad = answerCard(WORDS, state, CONFIG, [], { id: "house", kind: "review", dir: "reverse" }, "tempo", NOW);
    expect(bad).toMatchObject({ ok: false, expected: "casa", step: 0 });
  });
  test("placement: right marks known, don't know goes on the skip list", () => {
    const state: State = {};
    const skipped: string[] = [];
    expect(answerCard(WORDS, state, CONFIG, skipped, { id: "house", kind: "placement", dir: "forward" }, "дом", NOW).known).toBe(true);
    expect(answerCard(WORDS, state, CONFIG, skipped, { id: "time", kind: "placement", dir: "forward" }, "", NOW).ok).toBe(false);
    expect(skipped).toEqual(["time"]);
    expect(isAbsorbed(state.time)).toBe(false);
  });
  test("an unknown id is an error, not a silent pass", () => {
    expect(() => answerCard(WORDS, {}, CONFIG, [], { id: "nope", kind: "review", dir: "forward" }, "x", NOW)).toThrow();
  });
});

describe("status", () => {
  test("counts due, known, learning and placement left; reports the pause", () => {
    const state: State = markKnown({ time: { exposures: 2, lastSeen: EARLIER, step: 1, due: EARLIER } }, "house", NOW);
    expect(cardStatus(WORDS, state, { ...CONFIG, enabled: false }, NOW)).toEqual({ lang: "it", native: "ru", paused: true, due: 1, known: 1, learning: 1, placementLeft: 3, total: 5, statusLine: null, progress: "▓░░░░ 1/5", words: [{ target: "tempo", gloss: "время" }] });
  });
});

describe("my answer was right", () => {
  const due = (step: number): State => ({ house: { exposures: 4, lastSeen: EARLIER, step, recalls: 2, due: EARLIER } });
  const strip = (st: State) => Object.fromEntries(Object.entries(st).map(([k, v]) => [k, { ...v, lastSeen: undefined, due: undefined }]));

  for (const [dir, step] of [["forward", 2], ["reverse", 3]] as const)
    test(`review ${dir}: accept after a miss leaves the state of a right answer`, () => {
      const right = due(step);
      answerCard(WORDS, right, CONFIG, [], { id: "house", kind: "review", dir }, dir === "forward" ? "дом" : "casa", NOW);
      const missed = due(step);
      const miss = answerCard(WORDS, missed, CONFIG, [], { id: "house", kind: "review", dir }, "хата", NOW);
      expect(miss.ok).toBe(false);
      expect(miss.undo).toEqual({ state: { house: due(step).house! }, skipped: [] });
      const res = acceptCard(WORDS, missed, CONFIG, [], { id: "house", kind: "review", dir }, miss.undo!, NOW);
      expect(res.ok).toBe(true);
      expect(res.undo).toBeUndefined();
      expect(strip(missed)).toEqual(strip(right));
    });

  test("a right answer carries no undo", () => {
    expect(answerCard(WORDS, due(2), CONFIG, [], { id: "house", kind: "review", dir: "forward" }, "дом", NOW).undo).toBeUndefined();
  });

  test("placement: accept takes the word off the skip list and marks it known", () => {
    const state: State = {};
    const skipped = ["time"];
    const miss = answerCard(WORDS, state, CONFIG, skipped, { id: "house", kind: "placement", dir: "forward" }, "хата", NOW);
    expect(skipped).toEqual(["time", "house"]);
    expect(miss.undo).toEqual({ state: { house: null }, skipped: ["house"] });
    const res = acceptCard(WORDS, state, CONFIG, skipped, { id: "house", kind: "placement", dir: "forward" }, miss.undo!, NOW);
    expect(res).toMatchObject({ ok: true, known: true });
    expect(skipped).toEqual(["time"]);
    expect(isAbsorbed(state.house)).toBe(true);
  });
});

describe("cards CLI", () => {
  const run = (dir: string, ...args: string[]) => spawnSync("bun", [CLI, "cards", ...args], { env: { ...process.env, LAZY_POLYGLOT_DIR: dir }, encoding: "utf8" });
  const fresh = (config: object) => {
    const dir = mkdtempSync(join(tmpdir(), "lc-cards-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify(config));
    return dir;
  };

  test("next on a fresh learner is placement cards as JSON; answer records and returns status", () => {
    const dir = fresh({ lang: "it", native: "ru", level: 2 });
    const next = JSON.parse(run(dir, "next", "3").stdout);
    expect(next.cards).toHaveLength(3);
    expect(next.cards[0]).toMatchObject({ kind: "placement", dir: "forward" });
    const first = next.cards[0];
    const res = run(dir, "answer", first.id, first.kind, first.dir);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.ok).toBe(false);
    expect(out.status.placementLeft).toBe(next.status.placementLeft - 1);
  });

  test("paused: next returns no cards and says so", () => {
    const dir = fresh({ lang: "it", native: "ru", level: 2, enabled: false });
    const next = JSON.parse(run(dir, "next").stdout);
    expect(next).toMatchObject({ status: { paused: true }, cards: [] });
  });

  test("self-grade: reveal records nothing, grade ok marks a placement word known", () => {
    const dir = fresh({ lang: "it", native: "ru", level: 2 });
    const card = JSON.parse(run(dir, "next", "1").stdout).cards[0];
    const before = JSON.parse(run(dir, "status").stdout);
    expect(JSON.parse(run(dir, "reveal", card.id, card.dir).stdout).expected).toBeTruthy();
    expect(JSON.parse(run(dir, "status").stdout)).toEqual(before);
    const graded = JSON.parse(run(dir, "grade", card.id, card.kind, card.dir, "ok").stdout);
    expect(graded).toMatchObject({ ok: true, known: true });
    expect(graded.status.known).toBeGreaterThan(before.known);
  });

  test("accept: a placement miss becomes known, the skip list is restored", () => {
    const dir = fresh({ lang: "it", native: "ru", level: 2 });
    const card = JSON.parse(run(dir, "next", "1").stdout).cards[0];
    const miss = JSON.parse(run(dir, "answer", card.id, card.kind, card.dir, "nonsense").stdout);
    expect(miss.ok).toBe(false);
    const res = run(dir, "accept", card.id, card.kind, card.dir, JSON.stringify(miss.undo));
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out).toMatchObject({ ok: true, known: true });
    expect(out.status.placementLeft).toBe(miss.status.placementLeft);
    expect(out.status.known).toBe(miss.status.known + 1);
    expect(run(dir, "accept", card.id, card.kind, card.dir, "not json").status).toBe(1);
  });

  test("cards-status: off until chosen, then on/off sticks and shows in cards status", () => {
    const dir = fresh({ lang: "it", native: "ru", level: 2 });
    expect(JSON.parse(run(dir, "status").stdout).statusLine).toBeNull();
    const cs = (...a: string[]) => spawnSync("bun", [CLI, "cards-status", ...a], { env: { ...process.env, LAZY_POLYGLOT_DIR: dir }, encoding: "utf8" });
    expect(cs().stdout).toContain("never chosen");
    expect(cs("on").status).toBe(0);
    expect(JSON.parse(run(dir, "status").stdout).statusLine).toBe(true);
    expect(cs("off").status).toBe(0);
    expect(JSON.parse(run(dir, "status").stdout).statusLine).toBe(false);
    expect(cs("maybe").status).toBe(1);
  });

  test("a bad answer call fails loudly", () => {
    const dir = fresh({ lang: "it", native: "ru", level: 2 });
    expect(run(dir, "answer", "house", "oops", "forward").status).toBe(1);
  });
});
