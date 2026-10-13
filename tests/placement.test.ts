import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { placementQueue, markKnown, answerPlacement, detectTooEasy } from "../src/placement.ts";
import { isAbsorbed, type State, type Word } from "../src/types.ts";
import { pickLadder } from "../src/ladder.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const w = (id: string, target: string, en: string, ru: string): Word => ({ id, target, pos: "noun", tier: 1, gloss: { en, ru } });
const WORDS = [w("house", "casa", "house", "дом"), w("time", "tempo", "time", "время"), w("tomorrow", "domani", "tomorrow", "завтра"), w("morning", "domani", "morning", "утро"), w("water", "acqua", "water", "вода")];
const NOW = "2026-10-02T10:00:00.000Z";

describe("placement core", () => {
  test("a known word is absorbed and sits in the known sample, not the new words", () => {
    const state = markKnown({}, "house", NOW);
    expect(isAbsorbed(state.house)).toBe(true);
    const { picks, known } = pickLadder(WORDS, state, 3, NOW);
    expect(picks.map((p) => p.word.id)).not.toContain("house");
    expect(known.map((k) => k.id)).toContain("house");
  });

  test("queue: words not yet absorbed (served-but-unused and in-progress too), a shared lemma once, skipped left out", () => {
    const state: State = markKnown({ time: { exposures: 2, lastSeen: NOW, step: 1 }, tomorrow: { exposures: 0, lastSeen: "", step: 0, missed: 5 } }, "house", NOW);
    expect(placementQueue(WORDS, state, ["water"]).map((x) => x.target)).toEqual(["tempo", "domani"]);
  });

  test("an in-progress word answered right keeps its exposures and becomes absorbed", () => {
    const state: State = { time: { exposures: 3, lastSeen: NOW, step: 2, recalls: 1 } };
    answerPlacement(WORDS, state, [], WORDS[1]!, "время", "it", NOW);
    expect(state.time!.exposures).toBe(3);
    expect(isAbsorbed(state.time)).toBe(true);
  });

  test("right answer marks every concept it names; wrong one changes nothing but the skip list", () => {
    const state: State = {};
    const skipped: string[] = [];
    expect(answerPlacement(WORDS, state, skipped, WORDS[2]!, "утро", "it", NOW).ok).toBe(true);
    expect(isAbsorbed(state.morning)).toBe(true);
    expect(state.tomorrow).toBeUndefined();
    expect(answerPlacement(WORDS, state, skipped, WORDS[0]!, "кот", "it", NOW).ok).toBe(false);
    expect(state.house).toBeUndefined();
    expect(skipped).toEqual(["house"]);
  });

  test("too-easy phrases in ru/en/uz, silence on ordinary text", () => {
    for (const p of ["слушай, совсем простые слова", "эти слова я уже знаю", "я их все знаю", "Слишком лёгкие", "these words are too easy", "I already know these words", "juda oson so'zlar"])
      expect(detectTooEasy(p)).toBe(true);
    for (const p of ["сделай простой тест", "I know what you mean", "fix the build", "какие слова в README?"])
      expect(detectTooEasy(p)).toBe(false);
  });
});

describe("placement CLI", () => {
  const fresh = () => {
    const dir = mkdtempSync(join(tmpdir(), "lazy-polyglot-placement-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ lang: "it", native: "ru", level: 3 }));
    return dir;
  };
  const run = (dir: string, args: string[], input = "") =>
    spawnSync("bun", [CLI, ...args], { env: { ...process.env, LAZY_POLYGLOT_DIR: dir }, input, encoding: "utf8" });
  const state = (dir: string): State => JSON.parse(readFileSync(join(dir, "state.it.json"), "utf8"));
  const config = (dir: string) => JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));

  test("next lists words without translations; answer marks the known ones and moves on", () => {
    const dir = fresh();
    const next = run(dir, ["placement", "next", "3"]);
    expect(next.status).toBe(0);
    expect(next.stdout).toContain("1. essere");
    expect(next.stdout).not.toContain("быть");
    const ans = run(dir, ["placement", "answer", "essere=быть", "stare=", "avere=кошка"]);
    expect(ans.status).toBe(0);
    expect(ans.stdout).toContain("✓ essere");
    expect(isAbsorbed(state(dir)["to-be"])).toBe(true);
    expect(state(dir)["to-be-state"]).toBeUndefined();
    expect(config(dir).placementSkipped.it).toContain("to-be-state");
    const again = run(dir, ["placement", "next", "1"]);
    expect(again.stdout).not.toContain("essere");
    expect(again.stdout).not.toContain("stare");
  });

  test("interactive run saves as it goes and stops on q", () => {
    const dir = fresh();
    const out = run(dir, ["placement"], "быть\n\nq\n");
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("Known this round: 1/2");
    expect(isAbsorbed(state(dir)["to-be"])).toBe(true);
    expect(config(dir).placementSkipped.it).toHaveLength(1);
  });

  test("hook offers the test when the user says the words are too easy, and once at the start", () => {
    const dir = fresh();
    const hook = (prompt: string) => run(dir, ["hook"], JSON.stringify({ prompt, session_id: `s-${prompt}`, hook_event_name: "UserPromptSubmit" })).stdout;
    expect(hook("first message")).toContain("/lazy-polyglot:placement");
    expect(hook("second message")).not.toContain("/lazy-polyglot:placement");
    expect(hook("эти слова я уже знаю")).toContain("too easy");
  });
});
