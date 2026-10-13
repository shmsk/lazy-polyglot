import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pickLadder, markWoven, markMissed, migrate, estimateStep, dueOf, stepOf } from "../src/ladder.ts";
import { recordRecalls, applyQuizResult } from "../src/recall.ts";
import { putServed, staleServed, takeServed, settleServed, lastReply, readTail } from "../src/served.ts";
import { wovenLemmas } from "../src/weave-detect.ts";
import { buildInstruction, INSTRUCTION_BUDGET } from "../src/instruction.ts";
import { loadWordlist, loadGrammar, loadPatterns, falseFriendsFor } from "../src/store.ts";
import { pickPattern, patternCue } from "../src/patterns.ts";
import { isAbsorbed, LADDER_MS, NUDGE_AFTER_MISSES, NUDGE_GIVE_UP, type State, type Word } from "../src/types.ts";

const mkWord = (id: string): Word => ({ id, target: id, pos: "noun", tier: 1, gloss: { en: `en-${id}` } });
const words: Word[] = Array.from({ length: 40 }, (_, i) => mkWord(`w${String(i).padStart(2, "0")}`));
const T0 = Date.parse("2026-10-01T09:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

describe("interval ladder", () => {
  test("a word woven every time it is due comes back at 30 min, 8 h, 1 day, 4 days, 2 weeks", () => {
    const one = [mkWord("casa")];
    const state: State = {};
    const shownAt: number[] = [];
    // one turn every 10 minutes for 40 days; the model weaves whatever it is given
    for (let t = T0; t < T0 + 40 * DAY; t += 10 * MIN) {
      const { picks } = pickLadder(one, state, 3, iso(t));
      if (picks.length === 0) continue;
      markWoven(state, picks.map((p) => p.word.id), iso(t));
      shownAt.push(t);
    }
    const gaps = shownAt.slice(1).map((t, i) => t - shownAt[i]!);
    // each gap is the ladder interval, rounded up to the next 10-minute turn
    [LADDER_MS[1], LADDER_MS[2], LADDER_MS[3], LADDER_MS[4], LADDER_MS[5]].forEach((want, i) => {
      expect(gaps[i]!).toBeGreaterThanOrEqual(want!);
      expect(gaps[i]!).toBeLessThan(want! + 10 * MIN);
    });
    expect(isAbsorbed(state.casa)).toBe(true);
  });

  test("once woven, a word does not hog the day: it stays out until due", () => {
    const state: State = {};
    const first = pickLadder(words, state, 4, iso(T0)).picks.map((p) => p.word.id);
    markWoven(state, first, iso(T0));
    const next = pickLadder(words, state, 4, iso(T0 + 5 * MIN)).picks.map((p) => p.word.id);
    expect(next.some((id) => first.includes(id))).toBe(false);
  });

  test("an early showing counts but does not climb", () => {
    const state: State = {};
    markWoven(state, ["w00"], iso(T0));
    markWoven(state, ["w00"], iso(T0 + MIN));
    expect(state.w00!.step).toBe(1);
    expect(state.w00!.exposures).toBe(2);
  });

  test("a word that never fits keeps coming back and lands in the nudge slot", () => {
    const state: State = {};
    let nudged = false;
    for (let i = 0; i < NUDGE_AFTER_MISSES + 1; i++) {
      const now = iso(T0 + i * MIN);
      const { picks } = pickLadder(words, state, 4, now);
      nudged ||= picks.some((p) => p.word.id === "w00" && p.nudge);
      // the model weaves everything except w00
      markWoven(state, picks.filter((p) => p.word.id !== "w00").map((p) => p.word.id), now);
      markMissed(state, picks.filter((p) => p.word.id === "w00").map((p) => p.word.id), now);
    }
    expect(state.w00!.missed).toBeGreaterThanOrEqual(NUDGE_AFTER_MISSES);
    expect(nudged).toBe(true);
    // woven at last: the misses clear and it climbs
    markWoven(state, ["w00"], iso(T0 + HOUR));
    expect(state.w00!.missed).toBeUndefined();
    expect(state.w00!.step).toBe(1);
  });

  test("a review backlog still leaves room for new words", () => {
    const state: State = {};
    for (const w of words.slice(0, 30)) state[w.id] = { exposures: 1, lastSeen: iso(T0 - DAY), step: 1, due: iso(T0 - HOUR) };
    const { picks } = pickLadder(words, state, 12, iso(T0));
    expect(picks.filter((p) => !state[p.word.id]).length).toBeGreaterThanOrEqual(3);
  });

  test("recall climbs, a wrong quiz answer drops to the bottom", () => {
    const state: State = { w00: { exposures: 3, lastSeen: iso(T0), step: 3, due: iso(T0 + DAY) } };
    recordRecalls(state, ["w00"]);
    expect(state.w00!.step).toBe(4);
    applyQuizResult(state, "w00", false);
    expect(state.w00!.step).toBe(0);
    expect(isAbsorbed(state.w00)).toBe(false);
    // off the ladder, recall and quiz behave as before
    const old: State = { w01: { exposures: 3, lastSeen: iso(T0) } };
    recordRecalls(old, ["w01"]);
    expect(old.w01!.step).toBeUndefined();
  });

  test("known words: absorbed, not due, least recently seen first", () => {
    const state: State = {};
    words.slice(0, 5).forEach((w, i) => (state[w.id] = { exposures: 12, lastSeen: iso(T0 - DAY + i * MIN), step: 5, due: iso(T0 + 10 * DAY) }));
    const { picks, known } = pickLadder(words, state, 4, iso(T0));
    expect(known.map((w) => w.id)).toEqual(["w00", "w01", "w02", "w03", "w04"]);
    expect(picks.some((p) => known.includes(p.word))).toBe(false);
  });
});

describe("migration of pre-ladder records", () => {
  test("absorbed → step 5, else one step per two showings, capped at 4", () => {
    expect(estimateStep({ exposures: 12, lastSeen: "" })).toBe(5);
    expect(estimateStep({ exposures: 4, lastSeen: "", recalls: 1 })).toBe(5);
    expect(estimateStep({ exposures: 5, lastSeen: "" })).toBe(2);
    expect(estimateStep({ exposures: 11, lastSeen: "" })).toBe(4);
  });

  test("nothing is lost, grammar and rule keys are left alone, absorbed stays absorbed", () => {
    const before: State = {
      house: { exposures: 9, recalls: 2, lastSeen: "2026-09-28T10:00:00.000Z" },
      time: { exposures: 4, lastSeen: "2026-09-28T10:00:00.000Z" },
      "g:def-article": { exposures: 3, lastSeen: "2026-09-28T10:00:00.000Z" },
    };
    const wasAbsorbed = Object.fromEntries(Object.entries(before).map(([k, s]) => [k, isAbsorbed(s)]));
    const after = migrate(structuredClone(before));
    for (const [k, s] of Object.entries(before)) {
      expect(after[k]!.exposures).toBe(s.exposures);
      expect(after[k]!.recalls).toBe(s.recalls);
      expect(isAbsorbed(after[k])).toBe(wasAbsorbed[k]!);
    }
    expect(after["g:def-article"]!.step).toBeUndefined();
    expect(after.time!.step).toBe(2);
    expect(after.time!.due).toBe(iso(Date.parse("2026-09-28T10:00:00.000Z") + LADDER_MS[2]!));
    expect(dueOf(after.house)).toBe(iso(Date.parse("2026-09-28T10:00:00.000Z") + LADDER_MS[5]!));
    expect(stepOf(undefined)).toBe(0);
  });
});

describe("honest counting", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "lazy-polyglot-served-"));

  test("the reply's bold words count, glossed or not, inflected, never inside code", () => {
    const reply = "The **casas** (houses) look **grande**. Run `nombre` here.\n```\n**tiempo**\n```";
    expect(wovenLemmas(reply, ["casa", "grande", "nombre", "tiempo"])).toEqual(["casa", "grande"]);
  });

  test("Italian forms count when glossed: inflected verbs, multi-word, irregular leading verb", () => {
    const served = ["tirare fuori", "cadere", "avere bisogno", "casa"];
    expect(wovenLemmas("Он **tira fuori** (вынимает) звук.", served)).toEqual(["tirare fuori"]);
    expect(wovenLemmas("Сервер **cade** (падает).", served)).toEqual(["cadere"]);
    expect(wovenLemmas("Нам **abbiamo bisogno** (нужно) ключа.", served)).toEqual(["avere bisogno"]);
    expect(wovenLemmas("Ne **ho bisogno** (мне нужно).", served)).toEqual(["avere bisogno"]);
  });

  test("the looser match never fires on bare bold headers or a lone noun", () => {
    const served = ["casa", "cadere", "avere bisogno"];
    expect(wovenLemmas("**Case closed:** the **cadence** is fine.", served)).toEqual([]);
    expect(wovenLemmas("Нужен **bisogno** (нужда).", served)).toEqual([]);
  });

  test("a word missed NUDGE_GIVE_UP times rests a week and leaves the nudge slot", () => {
    const now = iso(T0);
    const state: State = { w00: { exposures: 0, lastSeen: "", step: 0, due: iso(T0 - DAY), missed: NUDGE_GIVE_UP - 1 } };
    markMissed(state, ["w00"], now);
    expect(state.w00!.missed).toBe(1);
    expect(state.w00!.due).toBe(iso(T0 + 7 * DAY));
    const { picks } = pickLadder(words, state, 4, iso(T0 + MIN));
    expect(picks.some((p) => p.word.id === "w00")).toBe(false);
    // a week later it is due again, with a clean count
    const later = pickLadder(words, state, 4, iso(T0 + 7 * DAY + MIN)).picks.find((p) => p.word.id === "w00");
    expect(later?.nudge).toBe(false);
  });

  test("a whole deck resting after misses still serves words, seen longest ago first", () => {
    const now = iso(T0);
    const rest = iso(T0 + 5 * DAY);
    const state: State = Object.fromEntries(
      words.map((w, i) => [w.id, { exposures: 1, lastSeen: iso(T0 - (i + 1) * HOUR), step: 0, due: rest, missed: 1 }]),
    );
    const { picks } = pickLadder(words, state, 4, now);
    expect(picks.map((p) => p.word.id)).toEqual(["w39", "w38", "w37", "w36"]);
  });

  test("a fallback word the reply skipped keeps its rest; a woven one counts a showing", () => {
    const now = iso(T0);
    const rest = iso(T0 + 5 * DAY);
    const state: State = {
      a: { exposures: 1, lastSeen: iso(T0 - DAY), step: 0, due: rest, missed: 1 },
      b: { exposures: 1, lastSeen: iso(T0 - DAY), step: 0, due: rest, missed: 1 },
    };
    markMissed(state, ["a"], now);
    expect(state.a).toEqual({ exposures: 1, lastSeen: iso(T0 - DAY), step: 0, due: rest, missed: 1 });
    markWoven(state, ["b"], now);
    expect(state.b!.exposures).toBe(2);
    expect(state.b!.due).toBe(rest);
  });

  test("a word that only waits out its interval is not pulled early", () => {
    const state: State = { w00: { exposures: 1, lastSeen: iso(T0), step: 1, due: iso(T0 + 8 * HOUR) } };
    expect(pickLadder([words[0]!], state, 4, iso(T0 + HOUR)).picks).toEqual([]);
  });

  test("settle: woven picks climb, skipped ones are missed, known words only count a showing", () => {
    const state: State = { big: { exposures: 12, lastSeen: iso(T0 - DAY), step: 5, due: iso(T0 + 9 * DAY) } };
    const rec = { lang: "es", at: iso(T0), picks: { house: "casa", time: "tiempo" }, known: { big: "grande" } };
    settleServed(state, rec, "A **casa** (house), **grande**.", iso(T0));
    expect(state.house!.step).toBe(1);
    expect(state.time!.missed).toBe(1);
    expect(state.big!.step).toBe(5);
    expect(state.big!.exposures).toBe(13);
  });

  test("a host with no Stop: the unsettled offer counts as woven; after a Stop it is dropped", () => {
    const d = dir();
    const rec = { lang: "es", at: iso(T0), picks: { house: "casa" }, known: {} };
    putServed(d, "s1", rec);
    expect(staleServed(d, "s1")?.picks).toEqual({ house: "casa" });
    expect(takeServed(d, "s1", iso(T0 + MIN))?.picks).toEqual({ house: "casa" });
    putServed(d, "s1", { ...rec, at: iso(T0 + 2 * MIN) });
    expect(staleServed(d, "s1")).toBeNull(); // this host reads replies back
    expect(takeServed(d, "s1", iso(T0 + 3 * MIN))).not.toBeNull();
    expect(takeServed(d, "s1", iso(T0 + 4 * MIN))).toBeNull(); // taken once
  });

  test("last reply: assistant text after the last real prompt, tool results and subagents don't count", () => {
    const lines = [
      { type: "user", message: { content: "old prompt" } },
      { type: "assistant", message: { content: [{ type: "text", text: "old **casa** (house)" }] } },
      { type: "user", message: { content: "new prompt" } },
      { type: "assistant", message: { content: [{ type: "text", text: "part one" }, { type: "tool_use", id: "x" }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x" }] } },
      { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "subagent **tiempo**" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "part two **día** (day)" }] } },
    ];
    const text = lastReply(lines.map((l) => JSON.stringify(l)).join("\n") + "\nnot json");
    expect(text).toBe("part one\npart two **día** (day)");
  });
});

test("only the transcript's tail is read, starting at a whole line", () => {
  const path = join(mkdtempSync(join(tmpdir(), "lazy-polyglot-tail-")), "t.jsonl");
  writeFileSync(path, "x".repeat(5000) + "\n" + JSON.stringify({ type: "user", message: { content: "p" } }) + "\n" + JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "end **casa**" }] } }));
  const tail = readTail(path, 200);
  expect(tail.startsWith("{")).toBe(true);
  expect(lastReply(tail)).toBe("end **casa**");
});

describe("algorithm 3 instruction", () => {
  const es = loadWordlist("es");
  const config = { lang: "es", native: "en", level: 10 };

  test("worst case fits the budget and still offers known words", () => {
    // longest glosses first, every section present: new, familiar, nudge, grammar, rule, sentence
    const long = [...es].sort((a, b) => b.gloss.en!.length - a.gloss.en!.length);
    const picks = long.slice(0, 12).map((word, i) => ({ word, exposures: 3, step: i < 5 ? 1 : 3, nudge: i >= 10 }));
    const grammar = loadGrammar("es")[0]!;
    const rule = patternCue(pickPattern(loadPatterns("es"), "en", {})!, "en", "es", falseFriendsFor("es"));
    const known = long.slice(12, 60);
    const text = buildInstruction(config, picks, grammar, rule, 3, known);
    expect(text.length).toBeLessThanOrEqual(INSTRUCTION_BUDGET);
    for (const part of ["New, translation inline:", "Familiar, no translation in the text:", "Nudge, the one exception:", "close with one line of only those used", "Known, no translation anywhere:", "Word-building rule", "whole simple sentence", "stays free of Spanish words"])
      expect(text).toContain(part);
    const knownLine = text.split("\n").find((l) => l.startsWith("Known"))!;
    expect(knownLine.split(",").length).toBeGreaterThanOrEqual(8);
  });

  test("a typical reply offers most of the known sample", () => {
    const picks = es.slice(0, 12).map((word, i) => ({ word, exposures: 3, step: i < 8 ? 0 : 3, nudge: i === 11 }));
    const text = buildInstruction(config, picks, loadGrammar("es")[0]!, null, 3, es.slice(12, 42));
    expect(text.length).toBeLessThanOrEqual(INSTRUCTION_BUDGET);
    expect(text.split("\n").find((l) => l.startsWith("Known"))!.split(",").length).toBeGreaterThanOrEqual(25);
  });

  test("absorbed words that came due are reviewed without a translation", () => {
    const [a, b] = es;
    const text = buildInstruction(config, [{ word: a!, exposures: 12, step: 5, nudge: false }, { word: b!, exposures: 0, step: 0, nudge: false }], null, null, 3, []);
    expect(text).toContain(`Known, no translation anywhere: ${a!.target}`);
    expect(text).toContain(`New, translation inline: ${b!.target} = `);
  });

  test("algorithms 1 and 2 are unchanged by it", () => {
    const picks = es.slice(0, 5).map((word) => ({ word, exposures: 0 }));
    for (const algo of [1, 2] as const) {
      const text = buildInstruction(config, picks, null, null, algo);
      expect(text).not.toContain("Nudge");
      expect(text).toContain("Never weave into text the user will copy or send");
    }
  });
});

describe("Stop hook, end to end", () => {
  const CLI = join(import.meta.dir, "..", "src", "cli.ts");
  const run = (dir: string, payload: object) =>
    spawnSync("bun", [CLI, "hook"], { env: { ...process.env, LAZY_POLYGLOT_DIR: dir }, input: JSON.stringify(payload), encoding: "utf8" });

  test("records exactly the words the reply wove, prints {}, exits 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "lazy-polyglot-stop-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ lang: "es", native: "en", level: 2, algorithm: 3 }));
    const served = run(dir, { prompt: "hi", session_id: "s", hook_event_name: "UserPromptSubmit" });
    expect(served.stdout).toContain("<lazy-polyglot>");
    const offer = JSON.parse(readFileSync(join(dir, "served.json"), "utf8")).s.picks as Record<string, string>;
    const [first, ...rest] = Object.entries(offer);
    const [wovenId, wovenLemma] = first!;
    const transcript = join(dir, "t.jsonl");
    writeFileSync(transcript, [{ type: "user", message: { content: "hi" } }, { type: "assistant", message: { content: [{ type: "text", text: `Hello **${wovenLemma}** (x).` }] } }].map((l) => JSON.stringify(l)).join("\n"));
    const stop = run(dir, { session_id: "s", hook_event_name: "Stop", transcript_path: transcript });
    expect(stop.status).toBe(0);
    expect(stop.stdout.trim()).toBe("{}");
    const state = JSON.parse(readFileSync(join(dir, "state.es.json"), "utf8")) as State;
    expect(state[wovenId!]).toMatchObject({ exposures: 1, step: 1 });
    for (const [id] of rest) expect(state[id]).toMatchObject({ exposures: 0, missed: 1 });
  });

  test("a broken transcript changes nothing and exits 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "lazy-polyglot-stop-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ lang: "es", native: "en", level: 2, algorithm: 3 }));
    run(dir, { prompt: "hi", session_id: "s", hook_event_name: "UserPromptSubmit" });
    const stop = run(dir, { session_id: "s", hook_event_name: "Stop", transcript_path: join(dir, "missing.jsonl") });
    expect(stop.status).toBe(0);
    expect(stop.stdout.trim()).toBe("{}");
  });
});

describe("headless Claude Code runs", () => {
  const CLI = join(import.meta.dir, "..", "src", "cli.ts");
  const run = (dir: string, payload: object, env: Record<string, string>) =>
    spawnSync("bun", [CLI, "hook"], { env: { ...process.env, LAZY_POLYGLOT_DIR: dir, ...env }, input: JSON.stringify(payload), encoding: "utf8" });
  const snapshot = (dir: string) =>
    Object.fromEntries(readdirSync(dir).filter((f) => f !== "t.jsonl").map((f) => [f, readFileSync(join(dir, f), "utf8")]));
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "lazy-polyglot-headless-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ lang: "es", native: "en", level: 4, algorithm: 3 }));
    const transcript = join(dir, "t.jsonl");
    writeFileSync(transcript, [{ type: "user", message: { content: "status?" } }, { type: "assistant", message: { content: [{ type: "text", text: "All green." }] } }].map((l) => JSON.stringify(l)).join("\n"));
    return { dir, transcript };
  };

  for (const entry of ["sdk-cli", "sdk-ts", "sdk-py"]) {
    test(`${entry}: twelve prompt+reply pairs serve nothing and write nothing`, () => {
      const { dir, transcript } = setup();
      const before = snapshot(dir);
      for (let i = 0; i < NUDGE_GIVE_UP; i++) {
        const served = run(dir, { prompt: "status?", session_id: `job-${i}`, hook_event_name: "UserPromptSubmit" }, { CLAUDE_CODE_ENTRYPOINT: entry });
        expect(served.status).toBe(0);
        expect(served.stdout).toBe("");
        expect(run(dir, { session_id: `job-${i}`, hook_event_name: "Stop", transcript_path: transcript }, { CLAUDE_CODE_ENTRYPOINT: entry }).status).toBe(0);
      }
      expect(snapshot(dir)).toEqual(before);
    });
  }

  test("an interactive session (cli) still serves", () => {
    const { dir } = setup();
    const served = run(dir, { prompt: "status?", session_id: "s", hook_event_name: "UserPromptSubmit" }, { CLAUDE_CODE_ENTRYPOINT: "cli" });
    expect(served.stdout).toContain("<lazy-polyglot>");
  });

  test("LAZY_POLYGLOT_HEADLESS=1 opts a headless run back in", () => {
    const { dir } = setup();
    const served = run(dir, { prompt: "status?", session_id: "s", hook_event_name: "UserPromptSubmit" }, { CLAUDE_CODE_ENTRYPOINT: "sdk-cli", LAZY_POLYGLOT_HEADLESS: "1" });
    expect(served.stdout).toContain("<lazy-polyglot>");
  });
});
