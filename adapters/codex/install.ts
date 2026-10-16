import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { addHooks } from "../shared/json-hooks.ts";
import { hookCommand } from "../shared/hook-command.ts";
import { removeAgentsSection } from "../shared/agents-section.ts";

function cliPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli.ts");
}

/**
 * Register the UserPromptSubmit hook in Codex CLI's hooks.json. Codex hooks use the
 * same file shape and stdin payload as Claude Code, and plain stdout is added as
 * developer context, so `lazy-polyglot hook` works unchanged.
 * scope=project → ./.codex/hooks.json (Codex loads it only in a trusted project)
 * scope=user    → $CODEX_HOME/hooks.json, default ~/.codex/hooks.json
 * Also removes the old self-serve AGENTS.md section from earlier installs, which
 * would otherwise make the model run the hook a second time, and replaces the hook
 * entry of the pre-rename "langcouch" install.
 */
export function installCodex(scope: "project" | "user"): string {
  const hooksPath =
    scope === "user"
      ? join(process.env.CODEX_HOME || join(homedir(), ".codex"), "hooks.json")
      : join(process.cwd(), ".codex", "hooks.json");

  const { changed, replaced } = addHooks(hooksPath, hookCommand(cliPath()));
  const agentsPath = join(process.cwd(), "AGENTS.md");
  const migrated = removeAgentsSection(agentsPath)
    ? `\nRemoved the old self-serve lazy-polyglot section from ${agentsPath}.`
    : "";
  const upgraded = replaced ? `\nReplaced ${replaced} old langcouch hook ${replaced === 1 ? "entry" : "entries"}.` : "";

  if (changed.length === 0) return `lazy-polyglot hook already installed in ${hooksPath} — leaving it alone${migrated}`;
  return [
    `Hook installed (${changed.join(" + ")}): ${hooksPath}${upgraded}${migrated}`,
    `Codex skips hooks it hasn't reviewed: start Codex, open /hooks and trust the lazy-polyglot hook${scope === "project" ? " (the project itself must be trusted too)" : ""}.`,
    "Then replies will start weaving words.",
  ].join("\n");
}
