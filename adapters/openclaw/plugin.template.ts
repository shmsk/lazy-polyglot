import { spawnSync } from "node:child_process";

/* lazy-polyglot */

/**
 * Lazy Polyglot adapter for OpenClaw (native plugin).
 *
 * `lazy-polyglot install openclaw` stamps this file as index.ts into a plugin
 * directory next to openclaw.plugin.json + package.json; the user links it
 * with `openclaw plugins install --link`.
 *
 * - before_prompt_build: shells out to `lazy-polyglot hook` with the current user
 *   message and returns the <lazy-polyglot> block as prependContext, the same
 *   position as the Claude Code UserPromptSubmit hook and the opencode plugin.
 * - agent_end: when a run finishes successfully, sends the last assistant
 *   message to `lazy-polyglot hook` as a Stop payload so the CLI counts which
 *   served words the reply really used. Once per runId when present.
 * - /lazy-polyglot <args>: routes to the CLI and replies without calling the LLM.
 *
 * Turn-scoped dedup: OpenClaw re-runs before_prompt_build on retries and
 * rebuilds of one admitted request. currentUserMessageId is stable across
 * those, so we key on it per session and weave a given request once; without
 * that, each retry would mark exposures again and corrupt the SRS counts.
 *
 * Sacred hook contract (matches src/cli.ts): never break the host session.
 * Every failure path is a silent no-op. Runtime detection tries Bun first;
 * Node >= 23.6 runs natively, Node 22.6+ and early 23 use --experimental-strip-types.
 *
 * Deliberately no import from the OpenClaw SDK: the plugin directory lives
 * outside the host's node_modules, and the entry is a plain object of the
 * shape definePluginEntry() accepts, so nothing has to resolve at load time.
 */

const CLI_PATH = "__LAZY_POLYGLOT_CLI_PATH__"; // replaced at install time

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { input: string; encoding: "utf8"; timeout: number; stdio: ["pipe", "pipe", "pipe"] },
) => { error?: unknown; status: number | null; stdout?: string; stderr?: string };

const defaultSpawn: SpawnFn = (cmd, args, opts) =>
  spawnSync(cmd, args, opts) as { error?: unknown; status: number | null; stdout?: string; stderr?: string };

type RunResult = { status: number | null; stdout: string; stderr: string };

/** Run the CLI with the first runtime that starts. null if none did. */
function runCli(args: string[], input: string, spawn: SpawnFn): RunResult | null {
  const opts = { input, encoding: "utf8" as const, timeout: 5000, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };
  const attempt = (cmd: string, argv: string[]): RunResult | null => {
    const r = spawn(cmd, argv, opts);
    if (r.error) return null;
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };

  const viaBun = attempt("bun", [CLI_PATH, ...args]);
  if (viaBun) return viaBun;

  const v = spawn("node", ["-v"], { ...opts, input: "" }).stdout?.trim() ?? "";
  const m = /^v(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major > 23 || (major === 23 && minor >= 6)) return attempt("node", [CLI_PATH, ...args]);
  if (major === 23 || (major === 22 && minor >= 6)) return attempt("node", ["--experimental-strip-types", CLI_PATH, ...args]);
  return null;
}

export function runHook(prompt: string, sessionId: string, spawn: SpawnFn = defaultSpawn): string {
  const payload = JSON.stringify({ prompt, session_id: sessionId, hook_event_name: "UserPromptSubmit" });
  const r = runCli(["hook"], payload, spawn);
  return r && r.status === 0 ? r.stdout.trim() : "";
}

/** Send a finished reply to the CLI (Stop payload). */
export function runStop(reply: string, sessionId: string, spawn: SpawnFn = defaultSpawn): void {
  const payload = JSON.stringify({ hook_event_name: "Stop", session_id: sessionId, last_assistant_message: reply });
  runCli(["hook"], payload, spawn);
}

/** Text of the last assistant entry in an agent_end messages array ("" if none). Shapes vary, so all access is defensive. */
export function lastAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const raw = messages[i] as any;
    const msg = raw?.message && typeof raw.message === "object" ? raw.message : raw;
    if (msg?.role !== "assistant") continue;
    const c = msg?.content;
    if (typeof c === "string") return c.trim();
    if (Array.isArray(c)) {
      return c
        .filter((p: any) => p?.type === "text" && typeof p?.text === "string")
        .map((p: any) => p.text)
        .join("\n")
        .trim();
    }
    return "";
  }
  return "";
}

// Subcommands safe to run from a chat; quiz is interactive, init/install touch host config.
const COMMANDS = ["lang", "level", "mode", "pause", "resume", "status", "validate", "instruction", "export", "import"];

/**
 * Split shell-style arguments without evaluating substitutions or running a shell.
 * A backslash escapes only what would otherwise end or quote a word (whitespace and
 * quotes; inside double quotes, only `"`), so Windows paths like C:\Users\me and
 * \\server\share pass through unquoted.
 */
function commandArgs(raw: string): string[] {
  const args: string[] = [];
  let word = "";
  let quote = "";
  let started = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    const next = raw[i + 1];
    if (char === "\\" && next !== undefined && (quote === '"' ? next === '"' : !quote && /[\s'"]/.test(next))) {
      word += next;
      i++;
      started = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) throw new Error("Unclosed quote");
  if (started) args.push(word);
  return args;
}

export function runCommand(rawArgs: string, spawn: SpawnFn = defaultSpawn): string {
  let args: string[];
  try {
    args = commandArgs(rawArgs);
  } catch {
    return "Lazy Polyglot: invalid arguments; close every quote.";
  }
  if (!args[0] || !COMMANDS.includes(args[0])) return `Usage: /lazy-polyglot <${COMMANDS.join("|")}> [args]`;
  const r = runCli(args, "", spawn);
  if (!r) return "Lazy Polyglot: the CLI did not run. It needs bun or Node.js >= 22.6.";
  // errors (bad language code, wrong level) come back on stderr
  return r.stdout.trim() || r.stderr.trim() || "ok";
}

/** Minimal slice of the OpenClaw plugin API this adapter uses. */
export type PromptBuildEvent = { prompt: string; currentUserMessage?: string; currentUserMessageId?: string };
export type AgentContext = { sessionId?: string; sessionKey?: string };
export type AgentEndEvent = { runId?: string; messages: unknown[]; success: boolean; error?: string; durationMs?: number };
export type PluginApi = {
  on(
    hook: "agent_end",
    handler: (event: AgentEndEvent, ctx: AgentContext) => void,
  ): void;
  on(
    hook: "before_prompt_build",
    handler: (event: PromptBuildEvent, ctx: AgentContext) => { prependContext: string } | undefined,
  ): void;
  registerCommand(def: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    handler: (ctx: { args?: string }) => { text: string };
  }): void;
};

/** Build the plugin entry with an optional spawn function (tests inject a fake). */
export function buildPlugin(spawn: SpawnFn = defaultSpawn) {
  return {
    id: "lazy-polyglot",
    name: "Lazy Polyglot",
    description: "Learn a language while you work (diglot weave in agent replies)",
    register(api: PluginApi) {
      // session → last woven request id
      const lastHandled = new Map<string, string>();

      api.on("before_prompt_build", (event, ctx) => {
        try {
          const prompt = event.currentUserMessage ?? event.prompt ?? "";
          const sessionId = ctx?.sessionId ?? ctx?.sessionKey ?? "";
          const requestId = event.currentUserMessageId;
          if (requestId) {
            if (lastHandled.get(sessionId) === requestId) return undefined;
            // mark before spawning: a "no words due" turn must not re-fire on retry
            lastHandled.set(sessionId, requestId);
          }
          const block = runHook(prompt, sessionId, spawn);
          return block ? { prependContext: block } : undefined;
        } catch {
          return undefined; // never break the host session
        }
      });

      // runId → already sent (per session, last one only is enough)
      const lastReply = new Map<string, string>();

      api.on("agent_end", (event, ctx) => {
        try {
          if (event?.success === false) return;
          const text = lastAssistantText(event?.messages);
          if (!text) return;
          const sessionId = ctx?.sessionId ?? ctx?.sessionKey ?? "";
          const runId = event?.runId;
          if (runId) {
            if (lastReply.get(sessionId) === runId) return;
            lastReply.set(sessionId, runId);
          }
          runStop(text, sessionId, spawn);
        } catch {
          // never break the host session
        }
      });

      api.registerCommand({
        name: "lazy-polyglot",
        description: "Lazy Polyglot: lang, level, pause, resume, status, export, import",
        acceptsArgs: true,
        handler: (ctx) => {
          try {
            return { text: runCommand(ctx?.args ?? "", spawn) };
          } catch {
            return { text: "Lazy Polyglot: command failed." };
          }
        },
      });
    },
  };
}

export default buildPlugin();
