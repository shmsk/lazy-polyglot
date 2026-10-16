import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { stampCliPath } from "../adapters/shared/stamp.ts";

/**
 * Runs the real Python template under python3 against a fake CLI (a tiny TS
 * script run by bun), with a fake Hermes `ctx`. Proves the shim's contract:
 * what it registers, what it returns, and that failures come back as None.
 * Skipped when python3 is missing; Hermes itself is never needed.
 */

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), "..", "adapters", "hermes", "plugin.template.py");
const hasPython = spawnSync("python3", ["--version"]).status === 0;

const HARNESS = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("lc", sys.argv[1])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
class Ctx:
    def __init__(self): self.hooks, self.commands = {}, {}
    def register_hook(self, name, fn): self.hooks[name] = fn
    def register_command(self, name, handler, description="", args_hint=""): self.commands[name] = handler
ctx = Ctx(); mod.register(ctx)
out = {"hooks": sorted(ctx.hooks), "commands": sorted(ctx.commands)}
out["pre_llm_call"] = ctx.hooks["pre_llm_call"](session_id="s1", user_message="hola", conversation_history=[], is_first_turn=True, model="m", platform="cli")
out["post_llm_call"] = ctx.hooks["post_llm_call"](session_id="s1", user_message="hola", assistant_response="Una **casa** (house).", conversation_history=[], model="m", platform="cli")
out["post_empty"] = ctx.hooks["post_llm_call"](session_id="s1", assistant_response="")
out["pre_noid"] = ctx.hooks["pre_llm_call"](user_message="ciao")
ctx.hooks["post_llm_call"](session_id=None, assistant_response="ok")
out["pid"] = __import__("os").getpid()
out["cmd"] = ctx.commands["lazy-polyglot"](sys.argv[2])
print(json.dumps(out))
`;

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "lazy-polyglot-hermes-plugin-"));
  writeFileSync(join(scratch, "harness.py"), HARNESS);
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Write a fake CLI with the given behavior and the stamped plugin that calls it. */
function setup(name: string, cliBody: string): string {
  const cli = join(scratch, `${name}-cli.ts`);
  writeFileSync(cli, cliBody);
  const plugin = join(scratch, `${name}.py`);
  writeFileSync(plugin, stampCliPath(readFileSync(TEMPLATE, "utf8"), cli));
  return plugin;
}

function run(plugin: string, cmdArgs: string) {
  const r = spawnSync("python3", [join(scratch, "harness.py"), plugin, cmdArgs], { encoding: "utf8", timeout: 40000, env: { ...process.env, LC_STOP_LOG: join(scratch, "stop.jsonl") } });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout) as { hooks: string[]; commands: string[]; pre_llm_call: unknown; post_llm_call: unknown; post_empty: unknown; pre_noid: unknown; pid: number; cmd: string };
}

const ECHO_CLI = `
const args = process.argv.slice(2);
if (args[0] === "hook") {
  const input = await Bun.stdin.json();
  if (input.hook_event_name === "Stop") {
    require("node:fs").appendFileSync(process.env.LC_STOP_LOG, JSON.stringify(input) + String.fromCharCode(10));
    console.log("{}");
    process.exit(0);
  }
  console.log("<lazy-polyglot>" + input.hook_event_name + "|" + input.session_id + "|" + input.prompt + "</lazy-polyglot>");
} else if (args[0] === "lang" && args[1] === "xx") {
  console.error("unknown language: xx"); process.exit(1);
} else {
  console.log("ran: " + args.join(" "));
}
`;

describe.skipIf(!hasPython)("hermes plugin (python3 + fake CLI)", () => {
  test("Node fallback selects the type stripping flag for supported versions", () => {
    const plugin = setup("runtime", "");
    const harness = `
import importlib.util, json, sys
from types import SimpleNamespace
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("lc", sys.argv[1])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
results = []
for version in ["22.5.0", "22.6.0", "23.0.0", "23.5.0", "23.6.0", "24.0.0"]:
    calls = []
    def run(args, **kwargs):
        if args[0] == "bun": raise FileNotFoundError()
        if args == ["node", "-v"]: return SimpleNamespace(stdout="v" + version)
        calls.append(args)
        return SimpleNamespace(stdout="ok", returncode=0)
    with patch.object(mod.subprocess, "run", run):
        mod._run(["hook"], "{}")
    results.append(calls)
print(json.dumps(results))
`;
    const r = spawnSync("python3", ["-c", harness, plugin], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const results = JSON.parse(r.stdout) as string[][][];
    expect(results[0]).toEqual([]);
    for (const index of [1, 2, 3, 4, 5]) {
      expect(results[index]).toHaveLength(1);
      expect(results[index]![0]!.includes("--experimental-strip-types")).toBe(index <= 3);
      expect(results[index]![0]!.at(-1)).toBe("hook");
    }
  });

  test("registers pre_llm_call, post_llm_call and /lazy-polyglot", () => {
    const out = run(setup("reg", ECHO_CLI), "status");
    expect(out.hooks).toEqual(["post_llm_call", "pre_llm_call"]);
    expect(out.commands).toEqual(["lazy-polyglot"]);
  });

  test("pre_llm_call pipes the turn to `hook` and returns the block as context", () => {
    const out = run(setup("ok", ECHO_CLI), "status");
    expect(out.pre_llm_call).toEqual({ context: "<lazy-polyglot>UserPromptSubmit|s1|hola</lazy-polyglot>" });
  });

  test("post_llm_call hands the final answer to `hook` as a Stop event, once; an empty answer sends nothing", () => {
    const log = join(scratch, "stop.jsonl");
    rmSync(log, { force: true });
    const out = run(setup("post", ECHO_CLI), "status");
    expect(out.post_llm_call).toBeNull();
    expect(out.post_empty).toBeNull();
    const sent = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(sent[0]).toEqual({ session_id: "s1", hook_event_name: "Stop", last_assistant_message: "Una **casa** (house)." });
    expect(sent).toHaveLength(2); // the second is the id-less turn below
  });

  test("no session id → both hooks use the same per-process id, never the shared empty slot", () => {
    const log = join(scratch, "stop.jsonl");
    rmSync(log, { force: true });
    const out = run(setup("noid", ECHO_CLI), "status");
    const id = `pid-${out.pid}`;
    expect(out.pre_noid).toEqual({ context: `<lazy-polyglot>UserPromptSubmit|${id}|ciao</lazy-polyglot>` });
    const sent = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(sent[1].session_id).toBe(id);
  });

  test("empty block → None (no injection)", () => {
    const out = run(setup("empty", `process.exit(0);`), "status");
    expect(out.pre_llm_call).toBeNull();
  });

  test("crashing CLI → None, host turn continues", () => {
    const out = run(setup("crash", `throw new Error("boom");`), "status");
    expect(out.pre_llm_call).toBeNull();
  });

  test("hanging CLI → None after the timeout", () => {
    const out = run(setup("hang", `await new Promise((r) => setTimeout(r, 60000));`), "status");
    expect(out.pre_llm_call).toBeNull();
  }, 30000);

  test("/lazy-polyglot routes arguments to the CLI", () => {
    const out = run(setup("cmd", ECHO_CLI), "level up");
    expect(out.cmd).toBe("ran: level up");
    expect(run(setup("transfer", ECHO_CLI), "import '~/My Files/b.json' --config").cmd).toBe("ran: import ~/My Files/b.json --config");
    expect(run(setup("transfer2", ECHO_CLI), "export").cmd).toBe("ran: export");
  });

  test("/lazy-polyglot shows CLI errors from stderr", () => {
    const out = run(setup("err", ECHO_CLI), "lang xx");
    expect(out.cmd).toBe("unknown language: xx");
  });

  test("/lazy-polyglot refuses unsafe or unknown subcommands", () => {
    const plugin = setup("usage", ECHO_CLI);
    expect(run(plugin, "install claude").cmd).toStartWith("Usage: /lazy-polyglot");
    expect(run(plugin, "").cmd).toStartWith("Usage: /lazy-polyglot");
  });
});
