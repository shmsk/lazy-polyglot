import { describe, expect, test } from "bun:test";
import { loadConcepts, loadWordlist } from "../src/store.ts";
import { pickLadder } from "../src/ladder.ts";

const NOW = "2026-10-14T10:00:00.000Z";
const rankOf = new Map(loadConcepts().map((c) => [c.id, c.rank]));

describe("frequency rank", () => {
  test("every concept has a unique rank 1..N (a new concept: rerun bun scripts/rank-words.ts <work-dir>)", () => {
    const ranks = loadConcepts().map((c) => c.rank);
    expect(ranks.every((r) => Number.isInteger(r))).toBe(true);
    expect([...ranks].sort((a, b) => a! - b!)).toEqual(ranks.map((_, i) => i + 1));
  });

  test.each(["it", "es", "en", "de", "fr", "pt", "tr", "es-419", "pt-BR", "en-GB"])("%s: the wordlist comes back in rank order", (lang) => {
    const ranks = loadWordlist(lang).map((w) => w.rank!);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  test("blocks stay together and in their own order", () => {
    for (const block of [
      Array.from({ length: 13 }, (_, i) => `num-${i}`),
      ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
      ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"],
    ]) {
      const ranks = block.map((id) => rankOf.get(id)!);
      expect(ranks).toEqual(ranks.map((_, i) => ranks[0]! + i));
    }
  });

  test("numerals 0–12 come right after the first 40 words", () => {
    expect(rankOf.get("num-0")).toBe(41);
    expect(rankOf.get("num-12")).toBe(53);
  });

  test("a first lesson starts with the most used words, not the noun block", () => {
    const words = loadWordlist("it");
    const first = new Set(words.slice(0, 20).map((w) => w.id));
    expect(first.has("to-be")).toBe(true);
    expect(first.has("to-have")).toBe(true);
    expect([...first].filter((id) => words.find((w) => w.id === id)!.pos === "noun").length).toBeLessThan(10);
    const picks = pickLadder(words, {}, 4, NOW).picks.map((p) => p.word.id);
    expect(picks.every((id) => first.has(id))).toBe(true);
  });
});
