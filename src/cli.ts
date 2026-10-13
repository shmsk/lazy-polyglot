#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { initConfig, loadConfig, saveConfig, loadState, saveState, loadWordlist, readJson, loadGrammar, loadPatterns, loadNumberRules, falseFriendsFor, availableLangs, userLangs, wordlistPath, wordlistLayers, normalizeLang, baseLang, langsWithState, sharedWithBase, changelogFor, loadHomographs, PLUGIN_VERSION, DATA_DIR, CONCEPTS_PATH, USER_WORDLISTS_DIR } from "./store.ts";
import { runValidation } from "./validate.ts";
import { langName } from "./instruction.ts";
import { invocationKey, isDuplicateInvocation } from "./guard.ts";
import { pickGrammar, markGrammarShown, grammarProgress, type GrammarItem } from "./grammar.ts";
import { pickPattern, markPatternShown, patternCue, patternProgress, PATTERN_MIN_LEVEL, type Pattern } from "./patterns.ts";
import { pickNumberRule, markNumberRuleShown, numberCue, numberRuleProgress, pickedNumeral, type NumberRule } from "./numbers.ts";
import { pickWords, markExposed, unlockedWords, tierProgress, type Pick } from "./scheduler.ts";
import { migrate, pickLadder } from "./ladder.ts";
import { putServed, staleServed, takeServed, settleServed, lastReply, readTail, antigravityTurn } from "./served.ts";
import { buildInstruction } from "./instruction.ts";
import { readingOf, readingFor, askReadingLine, readingExamples, READING_MODES, type ReadingMode } from "./reading.ts";
import { promptGlossLang, askNativeLine, GLOSS_LANGS } from "./glossLang.ts";
import { scanRecalls, recordRecalls, applyQuizResult, checkAnswer } from "./recall.ts";
import { placementQueue, answerPlacement, skippedFor, withSkipped, placementStarted, detectTooEasy, OFFER_TOO_EASY, OFFER_KNOWN_MAX, offerAtStart } from "./placement.ts";
import { acceptCard, answerCard, cardQueue, cardStatus, revealCard } from "./cards.ts";
import type { CardUndo } from "./cards.ts";
import { algorithmOf, glossFor, grammarStage, isAbsorbed, isWordKey, wordsPerResponse, type Config } from "./types.ts";
import type { Word, WordState } from "./types.ts";
import { pickSpinnerWords, tipFor, applySpinnerTips, removeSpinnerTips, countOurTips, readSettings, writeSettingsIfChanged, claudeSettingsPath } from "./spinner.ts";
import { exportBundle, importBundle, parseBundle, formatImportReport, formatExportSummary } from "./transfer.ts";
import { installClaude } from "../adapters/claude/install.ts";
import { installCodex } from "../adapters/codex/install.ts";
import { installOpencode } from "../adapters/opencode/install.ts";
import { installHermes } from "../adapters/hermes/install.ts";
import { installOpenclaw } from "../adapters/openclaw/install.ts";
import { installGemini } from "../adapters/gemini/install.ts";
import { installAntigravity } from "../adapters/antigravity/install.ts";
import { migrateLegacyDataDir } from "./migrate.ts";
import { loadLearningWords, runningTopics, isTopicOnly, listTopics, topicId, isRunning, topicProgress, topicLine, topicListView, addTopic, endTopic, deleteTopic, dropEntry, type Topic } from "./topics.ts";
import { pickCheer, cheerLine, absorbedCount, milestoneBar } from "./milestones.ts";
import { detectControl, detectTrouble, troubleLine, controlCommand, controlLine, claudeControlLine } from "./control.ts";

const PAUSED_LINE = "The user may be asking why Lazy Polyglot stopped: it is paused. Tell them in one line that `/lazy-polyglot:resume` (or the `resume` command) turns it back on.";

/**
 * Build this turn's instruction. `mark` records the turn: algorithms 1-2 count the
 * served words as shown right away; algorithm 3 only remembers the offer, and the
 * Stop hook counts what the reply actually wove. SessionStart serves without an
 * offer to settle, since no reply of its own follows it.
 */
function makeInstruction(mark: boolean, sessionId = "", eventName = "", prompt = ""): string {
  const saved = loadConfig();
  // paused: nothing, except a one-line answer when the user asks why the plugin went quiet
  if (saved.enabled === false) return prompt !== "" && detectTrouble(prompt) ? PAUSED_LINE : "";
  // translations follow the language the user just wrote in; quiz, spinner and status stay on `native`
  const gloss = promptGlossLang(prompt, saved.native);
  const ask = gloss.unsure === "unknown" && saved.nativeAsked !== true;
  // placement: offered when the user says the words are too easy, and once per language at the start
  const tooEasy = prompt !== "" && detectTooEasy(prompt);
  const offerCandidate = !tooEasy && eventName !== "SessionStart" && !placementStarted(saved, saved.lang) && !(saved.placementOffered ?? []).includes(saved.lang);
  const config: Config = { ...saved, native: gloss.lang };
  const algorithm = algorithmOf(config);
  const state = loadState(config.lang);
  const now = new Date().toISOString();
  const words = loadLearningWords(config.lang, state, now);
  // no "new to Italian?" for someone who already knows a fair share: they never get asked
  const offerStart = offerCandidate && absorbedCount(state) < OFFER_KNOWN_MAX;
  const n = wordsPerResponse(config.level);
  let picks: Pick[];
  let known: Word[] = [];
  if (algorithm === 3) {
    migrate(state);
    const stale = mark ? staleServed(DATA_DIR, sessionId) : null;
    if (stale && stale.lang === config.lang) settleServed(state, stale, null, now); // host with no after-reply event
    ({ picks, known } = pickLadder(unlockedWords(words, state), state, n, now));
  } else {
    picks = pickWords(unlockedWords(words, state), state, n);
  }
  if (picks.length === 0) return "";
  const stage = grammarStage(config.level);
  const grammar = stage >= 2 ? pickGrammar(loadGrammar(config.lang), words, state, stage) : null;
  // a picked numeral brings its number rule while one is still new; it takes the word-building rule's slot
  const numberRule = pickedNumeral(picks.map((p) => p.word)) ? pickNumberRule(loadNumberRules(config.lang), state) : null;
  const rule = !numberRule && config.level >= PATTERN_MIN_LEVEL ? pickPattern(loadPatterns(config.lang), config.native, state) : null;
  if (mark) {
    if (algorithm !== 3) markExposed(state, picks, now);
    else if (eventName !== "SessionStart") {
      const ids = (ws: Word[]) => Object.fromEntries(ws.map((w) => [w.id, w.target]));
      putServed(DATA_DIR, sessionId, { lang: config.lang, at: now, picks: ids(picks.map((p) => p.word)), known: ids(known) });
    }
    if (grammar) markGrammarShown(state, grammar, now);
    if (rule) markPatternShown(state, rule, now);
    if (numberRule) markNumberRuleShown(state, numberRule, now);
    saveState(config.lang, state);
  }
  const cue = rule ? patternCue(rule, config.native, normalizeLang(config.lang), falseFriendsFor(config.lang)) : null;
  // asked once: a user who ignores the question isn't asked again
  if (ask && mark) saveConfig({ ...loadConfig(), nativeAsked: true }); // re-read: never undo a change made meanwhile
  if (offerStart && mark) {
    const fresh = loadConfig();
    saveConfig({ ...fresh, placementOffered: [...(fresh.placementOffered ?? []), config.lang] });
  }
  const extra = [
    // "switch to French" in plain words: hand the agent the exact command
    prompt !== "" && detectControl(prompt) ? (process.env.CLAUDE_PLUGIN_ROOT ? claudeControlLine : controlLine(controlCommand())) : "",
    // "why is Lazy Polyglot doing X": recommend checking for an update first, then the troubleshooting doc
    prompt !== "" && detectTrouble(prompt) ? troubleLine(PLUGIN_VERSION) : "",
    ask ? askNativeLine(langName(gloss.lang.split("-")[0]!)) : "",
    tooEasy ? OFFER_TOO_EASY : offerStart ? offerAtStart(langName(config.lang)) : "",
  ].filter(Boolean);
  // pronunciation: in the learner's letters by default where the language has readings; asked once per
  // language, and never in the same reply as another question
  const hasReadings = words.some((w) => w.ipa);
  const mode = readingOf(saved, config.lang, hasReadings);
  const askReading = hasReadings && extra.length === 0 && !(saved.readingAsked ?? []).includes(config.lang) && eventName !== "SessionStart";
  const sample = askReading ? (picks.find((p) => p.word.ipa)?.word ?? words.find((w) => w.ipa)) : undefined;
  if (sample) {
    extra.push(askReadingLine(config.lang, langName(config.lang), config.native, sample));
    if (mark) {
      const fresh = loadConfig();
      saveConfig({ ...fresh, readingAsked: [...(fresh.readingAsked ?? []), config.lang] });
    }
  }
  // a round number of absorbed words, half a topic, a week's tally: one closing line, at most once a day
  // one closing line per reply: a milestone waits while a question or an offer takes the slot (it is not marked shown)
  if (mark && eventName !== "SessionStart" && saved.milestones !== false && !ask && !tooEasy && !offerStart && !sample) {
    const cheer = milestoneCheer(config.lang, words, state, now);
    if (cheer) extra.push(cheer);
  }
  const num = numberRule ? numberCue(numberRule, config.native) : null;
  return buildInstruction(config, picks, grammar, cue, algorithm, known, extra.length ? extra.join(" ") : null, num, (w) => readingFor(w, mode, config.native, config.lang));
}

/** This turn's milestone line, if one is due; records it (and a first run's starting point) in the config. */
function milestoneCheer(lang: string, words: Word[], state: Record<string, WordState>, now: string): string | null {
  const core = words.filter((w) => !isTopicOnly(w));
  const topics = runningTopics(lang, now).map((f) => topicProgress(f, state, now));
  const fresh = loadConfig(); // re-read: never undo a change made meanwhile
  const { cheer, log } = pickCheer(fresh.milestoneLog?.[lang], absorbedCount(state), { absorbed: core.filter((w) => isAbsorbed(state[w.id])).length, total: core.length }, topics, now);
  if (JSON.stringify(log) !== JSON.stringify(fresh.milestoneLog?.[lang])) saveConfig({ ...fresh, milestoneLog: { ...fresh.milestoneLog, [lang]: log } });
  return cheer ? cheerLine(cheer, langName(lang)) : null;
}

/**
 * Stop hook (algorithm 3): read the finished reply and count the words it wove.
 * The reply comes from the payload when the host sends it, else from the transcript.
 */
function settleReply(payload: HookPayload): void {
  const config = loadConfig();
  if (config.enabled === false || algorithmOf(config) !== 3) return;
  const reply = payload.lastMessage || (payload.transcriptPath ? lastReply(readTail(payload.transcriptPath)) : "");
  // an unreadable reply leaves the offer for the served-as-woven fallback, rather than marking every word missed
  if (!reply.trim()) return;
  const now = new Date().toISOString();
  const rec = takeServed(DATA_DIR, payload.sessionId, now);
  if (!rec || rec.lang !== config.lang) return;
  const state = migrate(loadState(config.lang));
  saveState(config.lang, settleServed(state, rec, reply, now));
}

/** Rewrite our spinner tips from current progress; spinner off (or no words) removes them. Returns tips written. */
function refreshSpinner(on: boolean): number {
  const config = loadConfig();
  const before = readSettings();
  const words = on ? loadLearningWords(config.lang, loadState(config.lang)) : [];
  const mode = readingOf(config, config.lang, words.some((w) => w.ipa));
  const tips = on ? pickSpinnerWords(words, loadState(config.lang)).map((w) => tipFor(w, config.native, readingFor(w, mode, config.native, config.lang))) : [];
  writeSettingsIfChanged(before, on ? applySpinnerTips(before, tips) : removeSpinnerTips(before), DATA_DIR);
  return tips.length;
}

/** Portable stdin drain (no Bun-only APIs — the plugin path may run under Node). */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

interface HookPayload {
  prompt: string;
  sessionId: string;
  eventName: string;
  /** Stop only: where the host keeps the conversation (Claude Code transcript JSONL) */
  transcriptPath?: string;
  /** Stop only: the finished reply, when the host sends it directly */
  lastMessage?: string;
  /** Antigravity CLI: model calls so far in this turn (0 = the turn just started) */
  invocationNum?: number;
}

/**
 * A Claude Code run with nobody reading it: `claude --print` (or a non-TTY stdout) and the
 * Agent SDK set CLAUDE_CODE_ENTRYPOINT to sdk-cli / sdk-ts / sdk-py. Such runs never serve
 * or count words, or a background job would burn the deck. LAZY_POLYGLOT_HEADLESS=1 opts back in.
 */
function isHeadless(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.LAZY_POLYGLOT_HEADLESS === "1") return false;
  return ["sdk-cli", "sdk-ts", "sdk-py"].includes(env.CLAUDE_CODE_ENTRYPOINT ?? "");
}

/**
 * Read the hook payload from stdin without ever hanging:
 * TTY (manual run) → skip; open-but-silent pipe → 100ms timeout wins.
 */
async function readHookPayload(): Promise<HookPayload> {
  const empty: HookPayload = { prompt: "", sessionId: "", eventName: "" };
  if (process.stdin.isTTY) return empty;
  const raw = await Promise.race([
    readAllStdin(),
    new Promise<string>((resolve) => setTimeout(() => resolve(""), 100)),
  ]);
  if (!raw) return empty;
  try {
    // Antigravity CLI sends camelCase (conversationId, transcriptPath, invocationNum)
    const payload = JSON.parse(raw) as { prompt?: string; session_id?: string; conversationId?: string; hook_event_name?: string; transcript_path?: string; transcriptPath?: string; last_assistant_message?: string; prompt_response?: string; invocationNum?: number };
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    return {
      prompt: str(payload.prompt),
      sessionId: str(payload.session_id) || str(payload.conversationId),
      eventName: str(payload.hook_event_name),
      transcriptPath: str(payload.transcript_path) || str(payload.transcriptPath) || undefined,
      lastMessage: str(payload.last_assistant_message) || str(payload.prompt_response) || undefined,
      invocationNum: typeof payload.invocationNum === "number" ? payload.invocationNum : undefined,
    };
  } catch {
    return { ...empty, prompt: raw }; // plain-text stdin still counts as a prompt
  }
}

/** How many words a variant's own file changes; "?" if it can't be read — listing must never crash. */
function overrideCount(lang: string): string {
  try {
    return String(Object.keys(JSON.parse(readFileSync(wordlistPath(lang)!, "utf8")) as object).length);
  } catch {
    return "?";
  }
}

/** A word is "in progress" once it's been shown or recalled at least once. */
const inProgress = (s: WordState): boolean => s.exposures > 0 || (s.recalls ?? 0) > 0;

/** Load the wordlist, degrading to [] if it was removed while state survives. */
function safeWordlist(lang: string): Word[] {
  try {
    return loadWordlist(lang);
  } catch {
    return [];
  }
}

/** Concepts a variant shares with its base, null if unreadable — status must never crash. */
function safeShared(lang: string): Set<string> | null {
  try {
    return sharedWithBase(lang);
  } catch {
    return null;
  }
}

/** Load word-building rules, degrading to [] like safeGrammar. */
function safePatterns(lang: string): Pattern[] {
  try {
    return loadPatterns(lang);
  } catch {
    return [];
  }
}

/** Load number rules, degrading to [] like safeGrammar. */
function safeNumberRules(lang: string): NumberRule[] {
  try {
    return loadNumberRules(lang);
  } catch {
    return [];
  }
}

/** Load grammar, degrading to [] if the file is missing or malformed — status must never crash. */
function safeGrammar(lang: string): GrammarItem[] {
  try {
    return loadGrammar(lang);
  } catch {
    return [];
  }
}

function langSummary(lang: string): { dict: string; touched: number; absorbed: number } {
  const state = loadState(lang);
  const entries = Object.entries(state).filter(([k, s]) => isWordKey(k) && inProgress(s));
  const words = safeWordlist(lang);
  const dict = words.length > 0 ? String(words.length) : "—";
  return { dict, touched: entries.length, absorbed: entries.filter(([, s]) => isAbsorbed(s)).length };
}

/**
 * "What's new" for a version `status` hasn't shown yet: all of its changelog entries.
 * Marks the version seen, so it shows once per update.
 */
function whatsNew(config: Config): string | null {
  if (config.seenVersion === PLUGIN_VERSION) return null;
  saveConfig({ ...config, seenVersion: PLUGIN_VERSION });
  const items = changelogFor(PLUGIN_VERSION);
  return items.length > 0 ? `What's new in ${PLUGIN_VERSION}:\n${items.map((i) => `  • ${i}`).join("\n")}` : null;
}

function status(): string {
  const config = loadConfig();
  const news = whatsNew(config);
  const words = safeWordlist(config.lang);
  const state = loadState(config.lang);
  const now = new Date().toISOString();
  const topics = listTopics(config.lang);
  // names for the "most exposed" list: core words, plus the words of every topic, ended ones too
  const byId = new Map([
    ...topics.flatMap((f) => f.topic.entries.map((e): [string, string] => [topicId(f.slug, e.key), e.target])),
    ...words.map((w): [string, string] => [w.id, w.target]),
  ]);
  const touched = Object.entries(state).filter(([k, s]) => isWordKey(k) && inProgress(s));
  const absorbed = touched.filter(([, s]) => isAbsorbed(s));
  const top = touched
    .sort((a, b) => b[1].exposures - a[1].exposures)
    .slice(0, 10)
    .map(([id, s]) => `  ${byId.get(id) ?? id} — ${s.exposures}×${(s.recalls ?? 0) > 0 ? ` (recalls ${s.recalls})` : ""}`)
    .join("\n");

  // Core vocabulary progress: the lowest not-yet-cleared tier is the active cohort.
  // Today all data is tier 1, so this reads as core-vocabulary mastery; the
  // "→ unlock tier N+1" clause only appears once a higher tier actually exists.
  const tiers = tierProgress(words, state);
  const active = tiers.find((t) => !t.cleared) ?? tiers[tiers.length - 1];
  const hasHigher = active ? tiers.some((t) => t.tier > active.tier) : false;
  const coreLine = active
    ? `Core (tier ${active.tier}): ${active.absorbed}/${active.total} absorbed · ${(active.ratio * 100).toFixed(1)}%` +
      (hasHigher && active.toClear > 0 ? ` · ${active.toClear} more to unlock tier ${active.tier + 1}` : "")
    : null;

  // Grammar progress: "shown"/"unlocked", never "mastered". Below level 4 no
  // construction is woven, so note when weaving actually starts.
  const stage = grammarStage(config.level);
  const gp = grammarProgress(safeGrammar(config.lang), words, state, stage < 2 ? 2 : stage); // below stage 2, preview what stage 2 brings
  const grammarLine =
    gp.total > 0
      ? `Grammar (stage ${stage}): ${gp.unlockedCount}/${gp.total} unlocked · ${gp.introduced} introduced` +
        (gp.next ? ` · next: ${gp.next.pattern} (${gp.next.pos} ${gp.next.have}/${gp.next.need})` : "") +
        (stage < 2 ? " · weaving starts at level 4" : "")
      : null;

  const pp = patternProgress(safePatterns(config.lang), config.native, state);
  const np = numberRuleProgress(safeNumberRules(config.lang), state);
  const numberLine = np.total > 0 ? `Number rules: ${np.introduced}/${np.total} introduced` : null;
  const patternLine =
    pp.total > 0
      ? `Word-building rules: ${pp.introduced}/${pp.total} introduced` +
        (pp.next ? ` · next: ${pp.next.from} → ${pp.next.to}` : "") +
        (config.level < PATTERN_MIN_LEVEL ? ` · start at level ${PATTERN_MIN_LEVEL}` : "")
      : null;

  // A regional variant shares progress with its base; only its own words are new to learn.
  const variantBase = baseLang(config.lang);
  const shared = variantBase ? safeShared(config.lang) : null;
  const regional = words.filter((w) => !shared?.has(w.id));
  const regionalLine = shared
    ? `Regional (vs ${variantBase}): ${regional.filter((w) => isAbsorbed(state[w.id])).length}/${regional.length} absorbed · ${words.length - regional.length} words share progress with ${variantBase}`
    : null;

  const others = langsWithState().filter((l) => l !== config.lang);
  const langRows = [config.lang, ...others].map((lang) => {
    const s = langSummary(lang);
    const marker = lang === config.lang ? "→" : " ";
    return `${marker} ${lang}: dictionary ${s.dict} | in progress ${s.touched} | absorbed ${s.absorbed}`;
  });

  return [
    `lazy-polyglot ${PLUGIN_VERSION} — ${config.lang} @ level ${config.level} (${wordsPerResponse(config.level)} words/response) · mode ${algorithmOf(config)}`,
    news,
    coreLine,
    regionalLine,
    grammarLine,
    patternLine,
    numberLine,
    ...topics.filter((f) => isRunning(f.topic, now)).map((f) => topicLine(topicProgress(f, state, now))),
    milestoneStatus(config, words, state),
    `Dictionary: ${words.length} | In progress: ${touched.length} | Absorbed (recall formula): ${absorbed.length}`,
    `Languages:\n${langRows.join("\n")}`,
    `Spinner tips: ${config.spinner ? "on" : "off (lazy-polyglot spinner on)"}`,
    `Learning word under the prompt: ${config.cardsStatus ? "on" : "off (lazy-polyglot cards-status on)"}`,
    `Data: ${DATA_DIR}`,
    top ? `Most exposed:\n${top}` : `No exposures yet — run a session with the hook installed.`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** "Next milestone: ▓▓▓▓░ 87/100", or how to turn milestones back on. */
function milestoneStatus(config: Config, words: Word[], state: Record<string, WordState>): string | null {
  if (config.milestones === false) return "Milestones: off (lazy-polyglot milestones on)";
  const bar = milestoneBar(absorbedCount(state), words.length);
  return bar ? `Next milestone: ${bar}` : null;
}

/** `status --absorbed`: the full list of absorbed words with their gloss. */
function absorbedListView(): string {
  const config = loadConfig();
  const words = safeWordlist(config.lang);
  const state = loadState(config.lang);
  const rows = words
    .filter((w) => isAbsorbed(state[w.id]))
    .sort((a, b) => (state[b.id]?.exposures ?? 0) - (state[a.id]?.exposures ?? 0))
    .map((w) => {
      const s = state[w.id]!;
      const recalls = (s.recalls ?? 0) > 0 ? `, recalls ${s.recalls}` : "";
      return `  ${w.target} — ${glossFor(w, config.native, config.lang)} (${s.exposures}×${recalls})`;
    });
  if (rows.length === 0) return `No absorbed words yet in ${config.lang} — keep going.`;
  return [`Absorbed in ${config.lang} (${rows.length}):`, ...rows].join("\n");
}

const MODE_NAMES: Record<1 | 2 | 3, string> = {
  1: "every listed word, counted when served",
  2: "only words that fit the reply, counted when served",
  3: "words that fit plus a nudge, translations fade on an interval ladder, counted when the reply uses them",
};

/** A path typed by hand; chat hosts pass "~/x" through unexpanded. */
const userPath = (p: string) => resolve(p === "~" || p.startsWith("~/") ? homedir() + p.slice(1) : p);

const [cmd, ...args] = process.argv.slice(2);

// first run after the rename: ~/.langcouch becomes ~/.lazy-polyglot (DATA_DIR is only a path, read lazily)
migrateLegacyDataDir();

try {
  switch (cmd) {
    case "init": {
      const { config, created } = initConfig();
      console.log(created ? `Created ${DATA_DIR} (${config.lang}, level ${config.level})` : `Config already exists — leaving it alone (${config.lang}, level ${config.level})`);
      break;
    }
    case "instruction":
      console.log(makeInstruction(false));
      break;
    case "hook": {
      // UserPromptSubmit contract: stdout is added to context; NEVER break the host session.
      // Gemini CLI (--host gemini, beta) names the events BeforeAgent / AfterAgent and reads
      // context only from JSON; any non-zero exit or a `decision` would block or retry its turn.
      const gemini = args[0] === "--host" && args[1] === "gemini";
      const GEMINI_EVENT: Record<string, string> = { BeforeAgent: "UserPromptSubmit", AfterAgent: "Stop" };
      // Antigravity CLI (--host antigravity --event <name>): the payload names no event and
      // carries no prompt or reply, so both come from its transcript. PreInvocation runs
      // before every model call of a turn and its ephemeral message lasts one call, so the
      // turn's first call builds the instruction and later calls repeat it without counting.
      const antigravity = args[0] === "--host" && args[1] === "antigravity";
      const ANTIGRAVITY_EVENT: Record<string, string> = { PreInvocation: "UserPromptSubmit", Stop: "Stop" };
      const TURN_FILE = join(DATA_DIR, "antigravity-turn.json");
      let hostEvent = "";
      // `silent`: the duplicate guard prints nothing for plain-text hosts, as before
      const emit = (text: string, silent = false) => {
        if (gemini) console.log(text ? JSON.stringify({ hookSpecificOutput: { hookEventName: hostEvent || "BeforeAgent", additionalContext: text } }) : "{}");
        else if (antigravity) console.log(text ? JSON.stringify({ injectSteps: [{ ephemeralMessage: text }] }) : "{}");
        else if (!silent) console.log(text);
        process.exit(0);
      };
      // nobody reads a headless Claude Code reply: no words, no recalls, no misses, no writes
      if (!gemini && !antigravity && isHeadless()) process.exit(0);
      let payload: HookPayload = { prompt: "", sessionId: "", eventName: "" };
      try {
        payload = await readHookPayload();
        hostEvent = payload.eventName;
        if (gemini) payload.eventName = GEMINI_EVENT[payload.eventName] ?? payload.eventName;
        if (antigravity) {
          const event = args.includes("--event") ? (args[args.indexOf("--event") + 1] ?? "") : "";
          payload.eventName = ANTIGRAVITY_EVENT[event] ?? event;
          if (payload.eventName === "UserPromptSubmit" && (payload.invocationNum ?? 0) > 0) {
            // a later model call of the same turn: repeat the turn's instruction, count nothing
            let text = "";
            try {
              const turn = JSON.parse(readFileSync(TURN_FILE, "utf8")) as { conversationId?: string; text?: string };
              if (turn.conversationId === payload.sessionId && typeof turn.text === "string") text = turn.text;
            } catch {
              // no turn recorded: skip this call rather than count the turn twice
            }
            emit(text);
          }
          if (payload.transcriptPath && existsSync(payload.transcriptPath)) {
            const turn = antigravityTurn(readTail(payload.transcriptPath));
            payload.prompt ||= turn.prompt;
            if (payload.eventName === "Stop") payload.lastMessage ||= turn.reply;
          }
        }
        // Plugin installs skip `init`; bootstrap the default config (idempotent, never clobbers).
        initConfig();
        // Plugin + legacy settings.json hook may both deliver the same payload — emit once.
        const key = invocationKey(payload.sessionId, payload.eventName, payload.prompt);
        if (isDuplicateInvocation(DATA_DIR, key, Date.now())) emit("", true);
      } catch {
        // guard/bootstrap are best-effort — never let them break the instruction below
      }
      if (payload.eventName === "Stop") {
        try {
          settleReply(payload);
        } catch {
          // counting is best-effort and never blocks the stop
        }
        // Codex wants JSON from a Stop hook; an empty object means "no decision" to Claude Code too
        console.log("{}");
        process.exit(0);
      }
      try {
        // recall scan: the user's own prompt is the strongest signal a word is known
        if (payload.prompt) {
          const config = loadConfig();
          if (config.enabled !== false) {
            const state = loadState(config.lang);
            const found = scanRecalls(payload.prompt, loadLearningWords(config.lang, state), loadHomographs(config.lang));
            if (algorithmOf(config) === 3) migrate(state); // recalls climb the ladder only once it is there
            if (found.length) saveState(config.lang, recordRecalls(state, found));
          }
        }
      } catch {
        // recall is best-effort too
      }
      try {
        // spinner tips only refresh at session start: one settings write per session, not per prompt
        if (payload.eventName === "SessionStart" && loadConfig().spinner === true) refreshSpinner(true);
      } catch {
        // spinner is a bonus — a broken settings.json must never cost us the instruction
      }
      let text = "";
      try {
        text = makeInstruction(true, payload.sessionId, payload.eventName, payload.prompt);
      } catch {
        // swallow everything — empty stdout, exit 0
      }
      if (antigravity) {
        try {
          writeFileSync(TURN_FILE, JSON.stringify({ conversationId: payload.sessionId, text }));
        } catch {
          // later calls of this turn go without the instruction; never break the session
        }
      }
      emit(text);
    }
    case "quiz": {
      const config = loadConfig();
      const state = loadState(config.lang);
      const words = loadLearningWords(config.lang, state);
      if (algorithmOf(config) === 3) migrate(state); // a quiz answer climbs or resets the ladder
      const n = Math.max(1, Math.trunc(Number(args[0])) || 5);
      const seenTargets = new Set<string>();
      const candidates = words
        .filter((w) => (state[w.id]?.exposures ?? 0) > 0)
        .sort((a, b) => (state[b.id]?.exposures ?? 0) - (state[a.id]?.exposures ?? 0))
        .filter((w) => !seenTargets.has(w.target) && seenTargets.add(w.target)) // a shared word is asked once
        .slice(0, n);
      if (candidates.length === 0) {
        console.log("Nothing to quiz — no exposures yet. Work with the hook installed first.");
        break;
      }
      // node:readline instead of Bun's prompt() — quiz must work under the plugin's Node fallback
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      let correct = 0;
      for (const w of candidates) {
        const answer = await rl.question(`${w.target} → `);
        // "mañana → tomorrow" and "mañana → morning" are both right; credit the concept(s) the answer names
        const matched = words.filter((x) => x.target === w.target && checkAnswer(answer, x, config.lang));
        const ok = matched.length > 0;
        if (ok) for (const x of matched) applyQuizResult(state, x.id, true);
        else applyQuizResult(state, w.id, false);
        if (ok) correct++;
        const shown = glossFor(w, config.native, config.lang);
        const own = baseLang(config.lang) ?? config.lang;
        const others = Object.entries(w.gloss).filter(([k, g]) => k !== own && g !== shown).map(([, g]) => g);
        console.log(ok ? "  ✓" : `  ✗ ${w.target} = ${glossFor(w, config.native, config.lang)}${others.length ? ` (${others.join("; ")})` : ""}${isAbsorbed(state[w.id]) ? "" : " — back into rotation"}`);
      }
      rl.close();
      saveState(config.lang, state);
      console.log(`Score: ${correct}/${candidates.length}`);
      break;
    }
    case "cards": {
      // JSON for the cards mod: it draws, this grades and records
      const config = loadConfig();
      const lang = config.lang;
      const state = loadState(lang);
      const words = loadLearningWords(lang, state);
      if (algorithmOf(config) === 3) migrate(state);
      const now = new Date().toISOString();
      const out = (v: unknown) => console.log(JSON.stringify(v));
      const sub = args[0];
      if (sub === "status") {
        out(cardStatus(words, state, config, now));
        break;
      }
      if (sub === "next") {
        const n = Math.max(1, Math.trunc(Number(args[1])) || 10);
        const status = cardStatus(words, state, config, now);
        out({ status, cards: status.paused ? [] : cardQueue(words, state, config, n, now) });
        break;
      }
      if (sub === "reveal") {
        const [id, dir] = args.slice(1);
        if (!id || (dir !== "forward" && dir !== "reverse")) {
          console.error("usage: lazy-polyglot cards reveal <id> <forward|reverse>");
          process.exit(1);
        }
        out({ expected: revealCard(words, config, { id, dir }) });
        break;
      }
      if (sub === "answer" || sub === "grade") {
        const [id, kind, dir, ...rest] = args.slice(1);
        const graded = sub === "grade" ? rest[0] : "ok";
        if (!id || (kind !== "review" && kind !== "placement") || (dir !== "forward" && dir !== "reverse") || (graded !== "ok" && graded !== "fail")) {
          console.error(`usage: lazy-polyglot cards answer <id> <review|placement> <forward|reverse> [answer...] (no answer = don't know)
       lazy-polyglot cards grade <id> <review|placement> <forward|reverse> <ok|fail>   self-graded, where no answer can be typed`);
          process.exit(1);
        }
        // a self-grade is recorded as the right answer or as "don't know", through the same path as a typed one
        const answer = sub === "grade" ? (graded === "ok" ? revealCard(words, config, { id, dir }) : "") : rest.join(" ");
        const skipped = skippedFor(config, lang);
        const result = answerCard(words, state, config, skipped, { id, kind, dir }, answer, now);
        saveState(lang, state);
        // re-read the config before writing: never undo a change made meanwhile (the hook may run in between)
        if (kind === "placement") saveConfig(withSkipped(loadConfig(), lang, skipped));
        out({ ...result, status: cardStatus(words, state, loadConfig(), now) });
        break;
      }
      if (sub === "accept") {
        // "my answer was right": take back a miss (the `undo` that answer printed) and record it as right
        const [id, kind, dir, undoJson] = args.slice(1);
        let undo: CardUndo | undefined;
        try {
          undo = undoJson ? (JSON.parse(undoJson) as CardUndo) : undefined;
        } catch {
          undo = undefined;
        }
        if (!id || (kind !== "review" && kind !== "placement") || (dir !== "forward" && dir !== "reverse") || !undo || typeof undo.state !== "object" || !Array.isArray(undo.skipped)) {
          console.error("usage: lazy-polyglot cards accept <id> <review|placement> <forward|reverse> <undo-json>   (undo from the answer's output)");
          process.exit(1);
        }
        const skipped = skippedFor(config, lang);
        const result = acceptCard(words, state, config, skipped, { id, kind, dir }, undo, now);
        saveState(lang, state);
        if (kind === "placement") saveConfig(withSkipped(loadConfig(), lang, skipped));
        out({ ...result, status: cardStatus(words, state, loadConfig(), now) });
        break;
      }
      console.error("usage: lazy-polyglot cards status | next [n] | answer <id> <review|placement> <forward|reverse> [answer...] | reveal <id> <dir> | grade <id> <kind> <dir> <ok|fail> | accept <id> <kind> <dir> <undo-json>");
      process.exit(1);
    }
    case "placement": {
      const config = loadConfig();
      const lang = config.lang;
      const state = loadState(lang);
      const words = loadLearningWords(lang, state);
      if (algorithmOf(config) === 3) migrate(state);
      const skipped = skippedFor(config, lang);
      const now = () => new Date().toISOString();
      // re-read the config before writing: never undo a change made meanwhile (the hook may run in between)
      const save = () => {
        saveState(lang, state);
        saveConfig(withSkipped(loadConfig(), lang, skipped));
      };
      const gloss = (w: Word) => glossFor(w, config.native, lang);
      const known = () => words.filter((w) => isAbsorbed(state[w.id])).length;
      const left = () => placementQueue(words, state, skipped).length;
      const summary = () => `${langName(lang)}: ${known()} of ${words.length} words known, ${left()} left to check`;
      const sub = args[0];
      if (sub === "--reset") {
        saveConfig(withSkipped(loadConfig(), lang, []));
        console.log(`Placement for ${lang} starts over: words you answered "don't know" will be asked again. Words already marked known stay known.`);
        break;
      }
      if (sub === "next") {
        // non-interactive half for agents (no stdin through a Bash tool): print a batch, answers come back via `answer`
        const n = Math.max(1, Math.trunc(Number(args[1])) || 10);
        const batch = placementQueue(words, state, skipped).slice(0, n);
        if (batch.length === 0) {
          console.log(`Placement done. ${summary()}.`);
          break;
        }
        console.log(`Translate each word (any of en/ru/uz is fine), leave blank if you don't know it:\n${batch.map((w, i) => `${i + 1}. ${w.target}`).join("\n")}\n(${left()} left to check)`);
        break;
      }
      if (sub === "answer") {
        const pairs = args.slice(1);
        if (pairs.length === 0 || pairs.some((p) => !p.includes("="))) {
          console.error('usage: lazy-polyglot placement answer "<word>=<translation>" ... (empty translation = don\'t know)');
          process.exit(1);
        }
        const queue = new Map(placementQueue(words, state, skipped).map((w) => [w.target.toLowerCase(), w]));
        let right = 0;
        const lines: string[] = [];
        for (const p of pairs) {
          const at = p.indexOf("=");
          const target = p.slice(0, at).trim().toLowerCase();
          const w = queue.get(target);
          if (!w) {
            lines.push(`  · ${target}: not in the placement queue (already placed or not in the list), skipped`);
            continue;
          }
          queue.delete(target);
          const { ok } = answerPlacement(words, state, skipped, w, p.slice(at + 1), lang, now());
          if (ok) right++;
          lines.push(ok ? `  ✓ ${w.target}` : `  ✗ ${w.target} = ${gloss(w)}, stays new`);
        }
        save();
        console.log(`${lines.join("\n")}\nKnown this round: ${right}. ${summary()}.`);
        break;
      }
      if (sub !== undefined && !/^\d+$/.test(sub)) {
        console.error("usage: lazy-polyglot placement [n] | next [n] | answer <word>=<translation>... | --reset");
        process.exit(1);
      }
      const queue = placementQueue(words, state, skipped);
      if (queue.length === 0) {
        console.log(`Placement done. ${summary()}. \`lazy-polyglot placement --reset\` asks the "don't know" words again.`);
        break;
      }
      const n = sub ? Math.max(1, Number(sub)) : queue.length;
      console.log(`Placement: type a translation (en/ru/uz), Enter = don't know, q = stop. Progress saves after every word.\n${summary()}.`);
      // a line iterator, not rl.question: piped answers that arrive at once would be dropped between questions
      const rl = createInterface({ input: process.stdin, terminal: false });
      const lines = rl[Symbol.asyncIterator]();
      let asked = 0;
      let right = 0;
      for (const w of queue.slice(0, n)) {
        process.stdout.write(`${w.target} → `);
        const line = await lines.next();
        if (line.done) break; // input closed (Ctrl-D): everything answered so far is saved
        const answer = String(line.value);
        if (answer.trim().toLowerCase() === "q") break;
        const { ok } = answerPlacement(words, state, skipped, w, answer, lang, now());
        asked++;
        if (ok) right++;
        console.log(ok ? "  ✓ known" : `  ✗ ${w.target} = ${gloss(w)}`);
        save();
      }
      rl.close();
      console.log(`\nKnown this round: ${right}/${asked}. ${summary()}.${left() ? " Run `lazy-polyglot placement` again to carry on." : ""}`);
      break;
    }
    case "level": {
      const config = loadConfig();
      const arg = args[0] ?? "";
      const next = arg === "up" ? config.level + 1 : arg === "down" ? config.level - 1 : Number(arg);
      if (!Number.isInteger(next) || next < 1 || next > 10) {
        console.error("usage: lazy-polyglot level <1-10|up|down>");
        process.exit(1);
      }
      saveConfig({ ...config, level: next });
      console.log(`Level: ${config.level} → ${next} (${wordsPerResponse(next)} words/response)`);
      break;
    }
    case "mode": {
      const config = loadConfig();
      const arg = args[0];
      if (arg === undefined) {
        console.log(`Weave algorithm: ${algorithmOf(config)} (${MODE_NAMES[algorithmOf(config)]})`);
        break;
      }
      const next = Number(arg);
      if (next !== 1 && next !== 2 && next !== 3) {
        console.error("usage: lazy-polyglot mode <1|2|3> — 3: interval ladder (default), 2: only words that fit, 1: every listed word");
        process.exit(1);
      }
      saveConfig({ ...config, algorithm: next });
      console.log(`Weave algorithm: ${algorithmOf(config)} → ${next} (${MODE_NAMES[next]})`);
      break;
    }
    case "native": {
      const config = loadConfig();
      const arg = args[0];
      if (arg === undefined) {
        console.log(`Translations: ${config.native} when your message's language can't be read (Cyrillic → ru, Latin → ${["en", "uz"].includes(config.native) ? config.native : "en"}); quiz and spinner always use ${config.native}`);
        break;
      }
      if (!GLOSS_LANGS.includes(arg)) {
        console.error(`usage: lazy-polyglot native <${GLOSS_LANGS.join("|")}>`);
        process.exit(1);
      }
      saveConfig({ ...config, native: arg, nativeAsked: true });
      console.log(`Native language: ${config.native} → ${arg}`);
      break;
    }
    case "lang": {
      const config = loadConfig();
      if (!args[0]) {
        const local = new Set(userLangs());
        const rows = availableLangs().map((l) => {
          const base = baseLang(l);
          const variant = base ? ` — variant of ${base}, ${overrideCount(l)} words differ` : "";
          return `  ${l === config.lang ? "→" : " "} ${l} ${langName(l)}${variant}${local.has(l) ? " (local)" : ""}`;
        });
        console.log(`Available languages:\n${rows.join("\n")}`);
        break;
      }
      const code = normalizeLang(args[0]);
      if (!availableLangs().includes(code)) {
        console.error(`lazy-polyglot: no wordlist for "${code}" — available: ${availableLangs().join(", ")}`);
        process.exit(1);
      }
      loadWordlist(code); // fail now, not in the hook, if a variant's base is missing or a file is broken
      saveConfig({ ...config, lang: code });
      console.log(`Language: ${config.lang} → ${code} (progress is per-language, ${config.lang} is kept)`);
      if (!placementStarted(config, code)) console.log(`Already know some ${langName(code)}? \`lazy-polyglot placement\` (or /lazy-polyglot:placement in Claude Code) checks the list and marks the words you know.`);
      const sample = loadWordlist(code).find((w) => w.ipa);
      if (sample) {
        console.log(`Pronunciation of new words: ${readingOf(config, code, true)} — change with \`lazy-polyglot reading off|native|ipa\` (/lazy-polyglot:reading):`);
        console.log(readingExamples(code, config.native, sample).join("\n"));
      }
      break;
    }
    case "reading": {
      const config = loadConfig();
      const sub = args[0] ?? "status";
      const sample = loadWordlist(config.lang).find((w) => w.ipa);
      if (!sample) {
        console.log(`${langName(config.lang)} reads as it is written: Lazy Polyglot shows no pronunciation for it.`);
        break;
      }
      if (sub === "status") {
        console.log(`Pronunciation of new ${langName(config.lang)} words: ${readingOf(config, config.lang, true)}`);
        console.log(readingExamples(config.lang, config.native, sample).join("\n"));
        break;
      }
      if (!READING_MODES.includes(sub as ReadingMode)) {
        console.error("usage: lazy-polyglot reading <off|native|ipa|status>");
        process.exit(1);
      }
      const asked = config.readingAsked ?? [];
      saveConfig({ ...config, reading: { ...config.reading, [config.lang]: sub as ReadingMode }, readingAsked: asked.includes(config.lang) ? asked : [...asked, config.lang] });
      const line = readingExamples(config.lang, config.native, sample).find((l) => l.trimStart().startsWith(sub))!;
      console.log(`Pronunciation of new ${langName(config.lang)} words: ${readingOf(config, config.lang, true)} → ${sub}\n${line}`);
      break;
    }
    case "validate": {
      const target = args.find((a) => !a.startsWith("--"));
      if (!target) {
        console.error(`usage: lazy-polyglot validate <code|path.json> [--full] — user languages live in ${USER_WORDLISTS_DIR}`);
        process.exit(1);
      }
      let layers: string[];
      if (target.endsWith(".json")) {
        // An explicit variant file (…/pt-BR.json) is still checked merged over its installed base.
        const base = baseLang(normalizeLang(basename(target, ".json")));
        const basePath = base ? wordlistPath(base) : null;
        if (base && !basePath) throw new Error(`lazy-polyglot: ${target} is a variant of "${base}", but there is no ${base} wordlist to build on`);
        layers = basePath ? [basePath, target] : [target];
      } else {
        const code = normalizeLang(target);
        if (!wordlistPath(code)) {
          console.error(`lazy-polyglot: no wordlist for "${code}" — put it at ${USER_WORDLISTS_DIR}/${code}.json`);
          process.exit(1);
        }
        layers = wordlistLayers(code);
      }
      if (!runValidation(CONCEPTS_PATH, [layers], args.includes("--full"))) process.exit(1);
      break;
    }
    case "pause":
    case "resume": {
      const config = loadConfig();
      saveConfig({ ...config, enabled: cmd === "resume" });
      console.log(cmd === "pause" ? "Weaving paused (lazy-polyglot resume to turn it back on)" : "Weaving resumed");
      break;
    }
    case "spinner": {
      const config = loadConfig();
      const sub = args[0] ?? "status";
      if (sub === "on" || sub === "off") {
        saveConfig({ ...config, spinner: sub === "on" });
        const n = refreshSpinner(sub === "on");
        console.log(
          sub === "on"
            ? n > 0
              ? `Spinner tips on: ${n} words in ${claudeSettingsPath()} (refreshed every session start)`
              : "Spinner tips on — no words in progress yet, they appear after a few replies"
            : `Spinner tips off: Lazy Polyglot lines removed from ${claudeSettingsPath()}`,
        );
      } else if (sub === "status") {
        const n = countOurTips(readSettings());
        console.log(`Spinner tips: ${config.spinner ? "on" : "off"} · ${n} Lazy Polyglot lines in ${claudeSettingsPath()}`);
      } else {
        console.error("usage: lazy-polyglot spinner <on|off|status>");
        process.exit(1);
      }
      break;
    }
    case "cards-status": {
      const sub = args[0] ?? "status";
      if (sub === "on" || sub === "off") {
        saveConfig({ ...loadConfig(), cardsStatus: sub === "on" });
        console.log(sub === "on" ? "Learning word under the prompt: on (from the next session start or /cards)" : "Learning word under the prompt: off (gone from the next session start or /cards)");
      } else if (sub === "status") {
        const v = loadConfig().cardsStatus;
        console.log(`Learning word under the prompt: ${v === true ? "on" : v === false ? "off" : "off (never chosen; /cards asks once)"}`);
      } else {
        console.error("usage: lazy-polyglot cards-status <on|off|status>");
        process.exit(1);
      }
      break;
    }
    case "topic": {
      const config = loadConfig();
      const lang = config.lang;
      const now = new Date().toISOString();
      const [sub, ...rest] = args;
      const value = (flag: string) => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : undefined; };
      const plain = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1] === "--name"));
      if (sub === "list" || sub === undefined) {
        console.log(topicListView(lang, loadState(lang), now));
      } else if (sub === "add" && plain[0]) {
        const file = userPath(plain[0]);
        const slug = value("--name") ?? basename(file).replace(/\.json$/i, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
        const draft = readJson<Topic>(file, "topic draft");
        const r = addTopic(draft, slug, lang, loadState(lang), config.level, now, rest.includes("--yes"));
        console.log(r.lines.join("\n"));
        if (!r.ok && !r.confirm) process.exit(1);
      } else if (sub === "end" && plain[0]) {
        console.log(endTopic(lang, plain[0], now));
      } else if (sub === "delete" && plain[0]) {
        const r = deleteTopic(lang, plain[0], rest.includes("--yes"));
        console.log(r.line);
        if (!r.ok && !r.confirm) process.exit(1);
      } else if (sub === "drop" && plain[0] && plain[1]) {
        console.log(dropEntry(lang, plain[0], plain.slice(1).join(" ")));
      } else {
        console.error("usage: lazy-polyglot topic list | add <file.json> [--name <name>] [--yes] | end <name> | delete <name> [--yes] | drop <name> <entry>");
        process.exit(1);
      }
      break;
    }
    case "milestones": {
      const sub = args[0] ?? "status";
      const config = loadConfig();
      if (sub === "on" || sub === "off") {
        saveConfig({ ...config, milestones: sub === "on" });
        console.log(sub === "on" ? "Milestones on: one short line at 50, 100, 200… words, half and all of a topic, and a weekly tally; at most one a day" : "Milestones off: no closing lines, no progress bar");
      } else if (sub === "status") {
        const bar = milestoneBar(absorbedCount(loadState(config.lang)), safeWordlist(config.lang).length);
        console.log(`Milestones: ${config.milestones === false ? "off" : "on"}${config.milestones !== false && bar ? ` · next ${bar}` : ""}`);
      } else {
        console.error("usage: lazy-polyglot milestones <on|off|status>");
        process.exit(1);
      }
      break;
    }
    case "status":
      console.log(args.includes("--absorbed") ? absorbedListView() : status());
      break;
    case "export": {
      const { bundle, skipped } = exportBundle();
      // the home folder by default: a chat host's working directory could be anywhere
      const target = args.find((a) => !a.startsWith("--")) ?? join(homedir(), `lazy-polyglot-export-${bundle.exportedAt.slice(0, 10)}.json`);
      const json = JSON.stringify(bundle, null, 2) + "\n";
      if (target === "-") {
        process.stdout.write(json);
        break;
      }
      const path = userPath(target);
      const dataDir = existsSync(DATA_DIR) ? realpathSync(DATA_DIR) : resolve(DATA_DIR);
      const parent = existsSync(dirname(path)) ? realpathSync(dirname(path)) : dirname(path);
      if (parent === dataDir || parent.startsWith(dataDir + sep)) {
        throw new Error(`lazy-polyglot: ${path} is inside ${DATA_DIR}, where it could replace your progress; pick another place`);
      }
      if (existsSync(path) && !args.includes("--force")) {
        throw new Error(`lazy-polyglot: ${path} already exists; add --force to replace it, or give another file name`);
      }
      writeFileSync(path, json);
      console.log(formatExportSummary(bundle, path, skipped));
      break;
    }
    case "import": {
      const file = args.find((a) => !a.startsWith("--"));
      if (!file) {
        console.error("usage: lazy-polyglot import <file> [--config]");
        process.exit(1);
      }
      const path = userPath(file);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(path, "utf8"));
      } catch (e) {
        throw new Error(`lazy-polyglot: cannot read ${path} as JSON (${e instanceof Error ? e.message : String(e)}) — nothing was imported`);
      }
      const report = importBundle(parseBundle(raw), { takeConfig: args.includes("--config") });
      console.log(formatImportReport(report, path));
      break;
    }
    case "install": {
      if (args[0] === "claude") {
        const scope = args.includes("--scope") ? args[args.indexOf("--scope") + 1] : "project";
        if (scope !== "project" && scope !== "user") {
          console.error("--scope must be project or user");
          process.exit(1);
        }
        console.log(installClaude(scope));
      } else if (args[0] === "codex") {
        const scope = args.includes("--scope") ? args[args.indexOf("--scope") + 1] : "project";
        if (scope !== "project" && scope !== "user") {
          console.error("--scope must be project or user");
          process.exit(1);
        }
        console.log(installCodex(scope));
      } else if (args[0] === "opencode") {
        const scope = args.includes("--scope") ? args[args.indexOf("--scope") + 1] : "project";
        if (scope !== "project" && scope !== "user") {
          console.error("--scope must be project or user");
          process.exit(1);
        }
        console.log(installOpencode(scope));
      } else if (args[0] === "gemini") {
        const scope = args.includes("--scope") ? args[args.indexOf("--scope") + 1] : "project";
        if (scope !== "project" && scope !== "user") {
          console.error("--scope must be project or user");
          process.exit(1);
        }
        console.log(installGemini(scope));
      } else if (args[0] === "antigravity") {
        const scope = args.includes("--scope") ? args[args.indexOf("--scope") + 1] : "project";
        if (scope !== "project" && scope !== "user") {
          console.error("--scope must be project or user");
          process.exit(1);
        }
        console.log(installAntigravity(scope));
      } else if (args[0] === "hermes") {
        console.log(installHermes());
      } else if (args[0] === "openclaw") {
        console.log(installOpenclaw());
      } else {
        console.error("usage: lazy-polyglot install <claude [--scope project|user] | codex [--scope project|user] | opencode [--scope project|user] | antigravity [--scope project|user] | gemini [--scope project|user] | hermes | openclaw>");
        process.exit(1);
      }
      break;
    }
    default:
      console.log(
        [
          "lazy-polyglot — learn a language without leaving the terminal (diglot weave for AI agents)",
          "",
          "  init                      create ~/.lazy-polyglot",
          "  pause / resume            turn weaving off/on",
          "  status [--absorbed]       level, core/grammar progress; --absorbed lists absorbed words",
          "  topic list|add|end|delete|drop  words for a goal (a trip, an exam): see docs/Topics.md",
          "  lang [code]               switch language / list available (regional variants too: pt-BR)",
          "  validate <code> [--full]  check a wordlist (e.g. one you added in ~/.lazy-polyglot/wordlists/)",
          "  native [en|ru|uz]         your language: translations when a message's language is unclear, quiz answers",
          "  level <1-10|up|down>      weaving intensity",
          "  mode [1|2|3]              weave algorithm: 3 interval ladder (default), 2 fit only, 1 every word",
          "  quiz [n]                  absorption check (default 5 words)",
          "  placement [n]             check which listed words you already know; they skip the new-word stage",
          "  placement next [n] / answer <word>=<translation>...   the same, one batch at a time (for agents)",
          "  cards status | next [n] | answer <id> <kind> <dir> [answer] | reveal | grade | accept   flashcards as JSON (for the cards mod)",
          "  export [file|-] [--force] save progress to one file (default ~/lazy-polyglot-export-<date>.json) for another machine",
          "  import <file> [--config]  merge an export into this machine's progress (keeps the best of both)",
          "  reading <off|native|ipa|status>   pronunciation of new words: your letters (default), IPA, or none (fr, en, pt)",
          "  spinner <on|off|status>   words to review in the Claude Code spinner tips (opt-in)",
          "  cards-status <on|off|status>   a learning word under the Claude Code prompt (opt-in)",
          "  milestones <on|off|status>   one short line at 50, 100, 200… words and topic halves; at most one a day",
          "  instruction               print the weave instruction (without marking exposures)",
          "  hook                      CLI-hook mode (marks exposures, always exit 0)",
          "  install claude [--scope project|user]   register the hook in Claude Code",
          "  install codex [--scope project|user]   register the hook in Codex CLI (hooks.json)",
          "  install opencode [--scope project|user]   install the plugin + AGENTS.md fallback for opencode",
          "  install antigravity [--scope project|user]   install the plugin for Antigravity CLI (agy)",
          "  install gemini [--scope project|user]   register the hook in Gemini CLI (settings.json, beta)",
          "  install hermes            install the Hermes Agent plugin ($HERMES_HOME/plugins/lazy-polyglot)",
          "  install openclaw          generate the OpenClaw plugin and print the link commands",
        ].join("\n"),
      );
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
