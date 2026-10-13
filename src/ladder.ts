import type { State, Word, WordState } from "./types.ts";
import { absorbedByScore, isWordKey, ABSORBED_STEP, KNOWN_SAMPLE, LADDER_MS, MAX_NUDGE, NUDGE_AFTER_MISSES, NUDGE_GIVE_UP, NUDGE_REST_MS } from "./types.ts";
import type { Pick } from "./scheduler.ts";
import { MAX_NUMERALS, NUM_POS } from "./numbers.ts";

/**
 * Spaced scheduler for algorithm 3. A word climbs one step each time the model
 * actually weaves it while it is due; each step waits longer (LADDER_MS). Serving
 * a word is not showing it: counting happens after the reply (the Stop hook).
 */

export interface LadderPick extends Pick {
  step: number;
  nudge: boolean;
}

export const intervalFor = (step: number): number => LADDER_MS[Math.min(step, LADDER_MS.length - 1)]!;
const at = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

/** A record written before the ladder, placed on it: absorbed → step 5, else one step per two showings (max 4). */
export function estimateStep(s: WordState): number {
  return absorbedByScore(s) ? ABSORBED_STEP : Math.min(ABSORBED_STEP - 1, Math.floor(s.exposures / 2));
}

export const stepOf = (s: WordState | undefined): number => (s ? (s.step ?? estimateStep(s)) : 0);

/** When the word is due; a word never shown or never placed on the ladder is due now (""). */
export function dueOf(s: WordState | undefined): string {
  if (!s) return "";
  if (s.due !== undefined) return s.due;
  return s.lastSeen ? at(s.lastSeen, intervalFor(stepOf(s))) : "";
}

export const isDue = (s: WordState | undefined, now: string): boolean => dueOf(s) <= now;

/** A word that has been in front of the learner at least once (shown, recalled, or served and missed). */
const started = (s: WordState | undefined): boolean =>
  !!s && (s.exposures > 0 || (s.recalls ?? 0) > 0 || (s.missed ?? 0) > 0 || (s.step ?? 0) > 0);

/**
 * Put every old word record on the ladder, once, so recall and quiz see a step.
 * Nothing is lost: exposures, recalls and lastSeen stay as they were.
 */
export function migrate(state: State): State {
  for (const [key, s] of Object.entries(state)) {
    if (!isWordKey(key) || s.step !== undefined) continue;
    state[key] = { ...s, step: estimateStep(s), ...(s.lastSeen ? { due: dueOf(s) } : {}) };
  }
  return state;
}

/** One step up, next showing an interval later. */
export function climb(s: WordState, now: string): WordState {
  const step = stepOf(s) + 1;
  const { missed: _, ...rest } = s;
  return { ...rest, step, due: at(now, intervalFor(step)) };
}

/** Back to the bottom: due now, translation inline again. */
export function reset(s: WordState, now: string): WordState {
  const { missed: _, ...rest } = s;
  return { ...rest, step: 0, due: now };
}

/**
 * The reply wove these words. A due word climbs; an early one only counts as a
 * showing (lastSeen moves, so the known sample rotates), its step stays put.
 */
export function markWoven(state: State, ids: string[], now: string): State {
  for (const id of ids) {
    const prev: WordState = state[id] ?? { exposures: 0, lastSeen: "" };
    const moved = isDue(prev, now) ? climb(prev, now) : { ...prev, step: stepOf(prev), due: dueOf(prev) || now };
    state[id] = { ...moved, exposures: prev.exposures + 1, lastSeen: now };
  }
  return state;
}

/**
 * Served while due and skipped: stays due, one miss closer to the nudge slot.
 * A word missed NUDGE_GIVE_UP times rests for a week instead, so a word models
 * can never fit stops holding a nudge slot; it keeps one miss, so it stays started.
 * A word that is not due (a resting one served as a fallback) is left alone.
 */
export function markMissed(state: State, ids: string[], now: string): State {
  for (const id of ids) {
    const prev: WordState = state[id] ?? { exposures: 0, lastSeen: "" };
    if (started(prev) && !isDue(prev, now)) continue; // a resting word served as a fallback: its rest stays as it was
    const missed = (prev.missed ?? 0) + 1;
    state[id] = missed >= NUDGE_GIVE_UP
      ? { ...prev, step: stepOf(prev), due: at(now, NUDGE_REST_MS), missed: 1 }
      : { ...prev, step: stepOf(prev), due: dueOf(prev) || now, missed };
  }
  return state;
}

/**
 * Words for one reply on the ladder:
 * - due words first, longest overdue first (they return every turn until woven);
 * - then new words; a quarter of the slots stays open for them, so a backlog of
 *   reviews never stops new learning;
 * - nothing due and nothing new: the words resting after misses, seen longest ago first, so the plugin never goes quiet;
 * - up to MAX_NUDGE of the picked due words that kept missing are marked nudge;
 * - `known`: a rotating sample of absorbed words that are not due, least recently
 *   seen first, to use freely without a translation.
 */
export function pickLadder(words: Word[], state: State, n: number, now: string): { picks: LadderPick[]; known: Word[] } {
  // topic words lead, then a variant's own words (carro, not casa)
  const regional = (w: Word) => (w.topic !== undefined ? 0 : w.baseTarget === undefined ? 2 : 1);
  const due = words
    .filter((w) => started(state[w.id]) && isDue(state[w.id], now))
    .sort((a, b) => dueOf(state[a.id]).localeCompare(dueOf(state[b.id])) || regional(a) - regional(b));
  const fresh = words.filter((w) => !started(state[w.id])).sort((a, b) => regional(a) - regional(b));

  const reserve = fresh.length > 0 ? Math.max(1, Math.floor(n / 4)) : 0;
  const picks: Word[] = [];
  const targets = new Set<string>();
  const take = (pool: Word[], limit: number) => {
    for (const w of pool) {
      if (picks.length >= limit) break;
      if (targets.has(w.target)) continue; // two concepts may share one word (mañana)
      if (w.pos === NUM_POS && picks.filter((p) => p.pos === NUM_POS).length >= MAX_NUMERALS) continue;
      picks.push(w);
      targets.add(w.target);
    }
  };
  take(due, Math.max(0, n - reserve));
  take(fresh, n);
  take(due, n); // fresh ran dry: give the slots back to reviews
  // nothing due and nothing new, the deck resting after misses: the words seen longest ago, rather than silence
  // (a word that only waits out its interval keeps waiting)
  if (picks.length === 0) {
    take(
      words
        .filter((w) => (state[w.id]?.missed ?? 0) > 0 && stepOf(state[w.id]) < ABSORBED_STEP)
        .sort((a, b) => (state[a.id]!.lastSeen ?? "").localeCompare(state[b.id]!.lastSeen ?? "")),
      n,
    );
  }

  const nudges = new Set(
    picks
      .filter((w) => (state[w.id]?.missed ?? 0) >= NUDGE_AFTER_MISSES)
      .sort((a, b) => (state[b.id]!.missed ?? 0) - (state[a.id]!.missed ?? 0))
      .slice(0, MAX_NUDGE)
      .map((w) => w.id),
  );

  const known: Word[] = [];
  for (const w of words
    .filter((w) => stepOf(state[w.id]) >= ABSORBED_STEP && started(state[w.id]) && !isDue(state[w.id], now))
    .sort((a, b) => (state[a.id]!.lastSeen ?? "").localeCompare(state[b.id]!.lastSeen ?? ""))) {
    if (known.length >= KNOWN_SAMPLE) break;
    if (targets.has(w.target)) continue;
    known.push(w);
    targets.add(w.target);
  }

  return {
    picks: picks.map((word) => ({ word, exposures: state[word.id]?.exposures ?? 0, step: stepOf(state[word.id]), nudge: nudges.has(word.id) })),
    known,
  };
}
