import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCodex } from "../adapters/codex/install.ts";
import { installClaude } from "../adapters/claude/install.ts";
import { writeAgentsSection, AGENTS_START } from "../adapters/shared/agents-section.ts";
import { hookCommand } from "../adapters/shared/hook-command.ts";

const expectedCommand = hookCommand(join(import.meta.dir, "..", "src", "cli.ts"));

let scratch: string;
let origCwd: string;
let origCodexHome: string | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "lazy-polyglot-codex-"));
  origCwd = process.cwd();
  origCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(scratch, "codex-home");
  process.chdir(scratch);
});

afterEach(() => {
  process.chdir(origCwd);
  if (origCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = origCodexHome;
  rmSync(scratch, { recursive: true, force: true });
});

const readHooks = (path: string) => JSON.parse(readFileSync(path, "utf8")).hooks;

describe("installCodex", () => {
  test("project scope: registers UserPromptSubmit + SessionStart + Stop in .codex/hooks.json", () => {
    const msg = installCodex("project");
    expect(msg).toContain("Hook installed (UserPromptSubmit + SessionStart + Stop)");
    expect(msg).toContain("/hooks");

    const hooks = readHooks(join(scratch, ".codex", "hooks.json"));
    for (const event of ["UserPromptSubmit", "SessionStart", "Stop"]) {
      expect(hooks[event]).toHaveLength(1);
      expect(hooks[event][0].hooks[0].type).toBe("command");
      expect(hooks[event][0].hooks[0].command).toBe(expectedCommand);
    }
  });

  test("user scope: writes to $CODEX_HOME/hooks.json", () => {
    installCodex("user");
    expect(existsSync(join(scratch, "codex-home", "hooks.json"))).toBe(true);
    expect(existsSync(join(scratch, ".codex", "hooks.json"))).toBe(false);
  });

  test("idempotent: a rerun leaves the file alone", () => {
    installCodex("project");
    const path = join(scratch, ".codex", "hooks.json");
    const first = readFileSync(path, "utf8");
    expect(installCodex("project")).toContain("already installed");
    expect(readFileSync(path, "utf8")).toBe(first);
  });

  test("keeps the user's other hooks and settings", () => {
    const path = join(scratch, ".codex", "hooks.json");
    mkdirSync(join(scratch, ".codex"));
    const foreign = { hooks: [{ type: "command", command: "echo mine" }] };
    writeFileSync(path, JSON.stringify({ hooks: { UserPromptSubmit: [foreign], PreToolUse: [foreign], Stop: [foreign] }, other: 1 }));

    installCodex("project");
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.other).toBe(1);
    expect(file.hooks.PreToolUse).toEqual([foreign]);
    expect(file.hooks.Stop).toHaveLength(2);
    expect(file.hooks.Stop[0]).toEqual(foreign);
    expect(file.hooks.UserPromptSubmit).toHaveLength(2);
    expect(file.hooks.UserPromptSubmit[0]).toEqual(foreign);
  });

  test("refreshes previous commands and removes duplicates without changing foreign hooks", () => {
    const path = join(scratch, ".codex", "hooks.json");
    mkdirSync(join(scratch, ".codex"));
    const old = { type: "command", command: "bun /old/lazy-polyglot/src/cli.ts hook", timeout: 9000 };
    const foreign = { type: "command", command: "echo lazy-polyglot" };
    writeFileSync(path, JSON.stringify({ hooks: { UserPromptSubmit: [{ matcher: "*", hooks: [old, foreign, old] }] } }));
    expect(installCodex("project")).toContain("Hook installed");
    expect(readHooks(path).UserPromptSubmit).toEqual([{ matcher: "*", hooks: [{ ...old, command: expectedCommand }, foreign] }]);
    const first = readFileSync(path, "utf8");
    expect(installCodex("project")).toContain("already installed");
    expect(readFileSync(path, "utf8")).toBe(first);
  });

  test("migrates the old self-serve AGENTS.md section away, keeping the rest", () => {
    const agents = join(scratch, "AGENTS.md");
    writeFileSync(agents, "# My project rules\n\nBe nice.\n");
    writeAgentsSection(agents, "/x/src/cli.ts");

    const msg = installCodex("project");
    expect(msg).toContain("Removed the old self-serve lazy-polyglot section");
    const left = readFileSync(agents, "utf8");
    expect(left).not.toContain(AGENTS_START);
    expect(left).toBe("# My project rules\n\nBe nice.\n");
  });

  test("an AGENTS.md that held only our section is deleted", () => {
    const agents = join(scratch, "AGENTS.md");
    writeAgentsSection(agents, "/x/src/cli.ts");
    installCodex("project");
    expect(existsSync(agents)).toBe(false);
  });
});

describe("installClaude (shared JSON-hooks writer)", () => {
  test("project scope still writes both events to .claude/settings.json, idempotently", () => {
    expect(installClaude("project")).toContain("Hook installed (UserPromptSubmit + SessionStart + Stop)");
    const hooks = readHooks(join(scratch, ".claude", "settings.json"));
    expect(hooks.UserPromptSubmit[0].hooks[0].command).toBe(expectedCommand);
    expect(hooks.SessionStart).toHaveLength(1);
    expect(installClaude("project")).toContain("already installed");
  });
});

/** A hooks file as the LangCouch-era installer wrote it, plus one foreign hook per event. */
const legacyHooksFile = (extra: Record<string, unknown> = {}) => {
  const foreign = { hooks: [{ type: "command", command: "echo mine" }] };
  const old = { hooks: [{ type: "command", command: "bun /old/langcouch/src/cli.ts hook", ...extra }] };
  return { hooks: { UserPromptSubmit: [foreign, old], SessionStart: [old], Stop: [old, foreign] }, other: 1 };
};

describe("upgrade from the LangCouch install", () => {
  test("codex: old entries are replaced, foreign hooks and settings stay, nothing fires twice", () => {
    const path = join(scratch, ".codex", "hooks.json");
    mkdirSync(join(scratch, ".codex"));
    writeFileSync(path, JSON.stringify(legacyHooksFile()));
    writeFileSync(join(scratch, "AGENTS.md"), "# Mine\n\n<!-- langcouch:start -->\nold\n<!-- langcouch:end -->\n");

    const msg = installCodex("project");
    expect(msg).toContain("Replaced 3 old langcouch hook entries");
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.other).toBe(1);
    for (const event of ["UserPromptSubmit", "SessionStart", "Stop"]) {
      const commands = JSON.stringify(file.hooks[event]);
      expect(commands).not.toContain("/old/langcouch");
      expect(file.hooks[event].flatMap((g: { hooks: { command: string }[] }) => g.hooks).filter((h: { command: string }) => h.command === expectedCommand)).toHaveLength(1);
    }
    expect(file.hooks.UserPromptSubmit[0].hooks[0].command).toBe("echo mine");
    expect(file.hooks.SessionStart).toHaveLength(1);
    expect(readFileSync(join(scratch, "AGENTS.md"), "utf8")).toBe("# Mine\n");

    const once = readFileSync(path, "utf8");
    expect(installCodex("project")).toContain("already installed");
    expect(readFileSync(path, "utf8")).toBe(once);
  });

  test("claude: same upgrade in .claude/settings.json", () => {
    const path = join(scratch, ".claude", "settings.json");
    mkdirSync(join(scratch, ".claude"));
    writeFileSync(path, JSON.stringify(legacyHooksFile()));

    expect(installClaude("project")).toContain("Replaced 3 old langcouch hook entries");
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.other).toBe(1);
    for (const event of ["UserPromptSubmit", "SessionStart", "Stop"]) {
      expect(JSON.stringify(file.hooks[event])).not.toContain("/old/langcouch");
      expect(file.hooks[event].flatMap((g: { hooks: { command: string }[] }) => g.hooks).filter((h: { command: string }) => h.command === expectedCommand)).toHaveLength(1);
    }
    expect(installClaude("project")).toContain("already installed");
  });
});
