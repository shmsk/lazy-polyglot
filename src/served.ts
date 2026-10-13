import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { State } from "./types.ts";
import { markMissed, markWoven } from "./ladder.ts";
import { wovenLemmas } from "./weave-detect.ts";
import { loadIrregular } from "./store.ts";

/**
 * What the last instruction offered, per session, until the reply is read back.
 * Algorithm 3 counts a word only once the reply wove it: the prompt hook writes
 * this record, the Stop hook takes it. Records older than a day are dropped.
 */
export interface ServedRecord {
  lang: string;
  at: string;
  /** Concept id → lemma for the words the instruction asked for (all due or new) */
  picks: Record<string, string>;
  /** Concept id → lemma for the known sample, used freely */
  known: Record<string, string>;
  /** This session's host has read a reply back at least once (Claude Code Stop) */
  stopSeen?: boolean;
}

const FILE = "served.json";
const TTL_MS = 24 * 60 * 60 * 1000;
const key = (sessionId: string) => sessionId || "default";

function readAll(dir: string): Record<string, ServedRecord> {
  try {
    const path = join(dir, FILE);
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, ServedRecord>) : {};
  } catch {
    return {}; // a broken file only loses one turn of counting
  }
}

function writeAll(dir: string, all: Record<string, ServedRecord>, nowMs: number): void {
  const fresh = Object.fromEntries(Object.entries(all).filter(([, r]) => nowMs - Date.parse(r.at) < TTL_MS));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FILE), JSON.stringify(fresh));
}

/**
 * The previous offer in this session that no reply ever settled, when the host has
 * no after-reply event: it is counted as woven, the way every version before the
 * ladder counted. A session that has had a Stop drops it instead (the user
 * interrupted, or the hook failed), since guessing would inflate progress.
 */
export function staleServed(dir: string, sessionId: string): ServedRecord | null {
  const prev = readAll(dir)[key(sessionId)];
  return prev && !prev.stopSeen && Object.keys(prev.picks).length > 0 ? prev : null;
}

/** Remember this turn's offer, replacing whatever the session had. */
export function putServed(dir: string, sessionId: string, record: Omit<ServedRecord, "stopSeen">): void {
  const all = readAll(dir);
  const stopSeen = all[key(sessionId)]?.stopSeen === true;
  all[key(sessionId)] = { ...record, ...(stopSeen ? { stopSeen } : {}) };
  writeAll(dir, all, Date.parse(record.at));
}

/** The reply is done: take the session's offer and leave a marker that this host reads replies back. */
export function takeServed(dir: string, sessionId: string, now: string): ServedRecord | null {
  const all = readAll(dir);
  const rec = all[key(sessionId)] ?? null;
  all[key(sessionId)] = { lang: rec?.lang ?? "", at: now, picks: {}, known: {}, stopSeen: true };
  writeAll(dir, all, Date.parse(now));
  return rec && Object.keys(rec.picks).length + Object.keys(rec.known).length > 0 ? rec : null;
}

/**
 * Fold one settled offer into the state. `reply` null means the host could not
 * read it back: every pick counts as woven. Otherwise picks the reply wove climb,
 * the rest are missed; known words it used count as a showing. `irregular` (concept id →
 * forms) lets è count for essere.
 */
export function settleServed(state: State, rec: ServedRecord, reply: string | null, now: string, irregular: Record<string, string[]> = loadIrregular(rec.lang)): State {
  const all = { ...rec.picks, ...rec.known };
  const forms = Object.fromEntries(Object.entries(all).filter(([id]) => irregular[id]).map(([id, lemma]) => [lemma, irregular[id]!]));
  const used = new Set(reply === null ? Object.values(rec.picks) : wovenLemmas(reply, Object.values(all), forms));
  const ids = (m: Record<string, string>, hit: boolean) => Object.entries(m).filter(([, t]) => used.has(t) === hit).map(([id]) => id);
  markWoven(state, [...ids(rec.picks, true), ...ids(rec.known, true)], now);
  markMissed(state, ids(rec.picks, false), now);
  return state;
}

/**
 * The end of a transcript: a long session's file runs to tens of MB, and the hook
 * must stay fast. The last reply sits at the end; a first partial line is dropped.
 */
export function readTail(path: string, bytes = 1 << 20): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

/**
 * The last assistant reply of a Claude Code transcript (JSONL): the text blocks of
 * assistant entries after the last real user prompt. Tool results come back as
 * user entries too; those don't end the reply.
 */
export function lastReply(transcript: string): string {
  const parts: string[] = [];
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: string; isSidechain?: boolean; message?: { content?: unknown } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.isSidechain) continue; // a subagent's turn, not the reply the user reads
    const content = e.message?.content;
    if (e.type === "user") {
      const isToolResult = Array.isArray(content) && content.every((b) => (b as { type?: string })?.type === "tool_result");
      if (!isToolResult) parts.length = 0; // a new prompt: the reply starts over
    } else if (e.type === "assistant" && Array.isArray(content)) {
      for (const b of content as { type?: string; text?: string }[]) if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n");
}

/**
 * The last turn of an Antigravity CLI transcript (`transcript_full.jsonl`): one step per
 * line. `USER_INPUT` wraps the prompt in `<USER_REQUEST>` tags next to metadata the user
 * never typed; the reply is the text of the `PLANNER_RESPONSE` steps after it.
 */
export function antigravityTurn(transcript: string): { prompt: string; reply: string } {
  let prompt = "";
  const parts: string[] = [];
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: string; content?: unknown };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof e.content !== "string") continue;
    if (e.type === "USER_INPUT") {
      const m = e.content.match(/<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/);
      prompt = m ? m[1]! : e.content;
      parts.length = 0; // a new prompt: the reply starts over
    } else if (e.type === "PLANNER_RESPONSE" && e.content.trim()) parts.push(e.content);
  }
  return { prompt, reply: parts.join("\n") };
}
