import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { addHooks } from "../shared/json-hooks.ts";
import { hookCommand } from "../shared/hook-command.ts";

function cliPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli.ts");
}

/** Best-effort check: is the plugin (under its current or its pre-rename "langcouch" name) already installed in Claude Code? */
function pluginAlreadyInstalled(): boolean {
  try {
    const raw = readFileSync(join(homedir(), ".claude", "plugins", "installed_plugins.json"), "utf8");
    return raw.includes('"lazy-polyglot@') || raw.includes('"langcouch@');
  } catch {
    return false;
  }
}

/**
 * Register the UserPromptSubmit hook in Claude Code settings.
 * scope=project → ./.claude/settings.json (safe default for trying things out)
 * scope=user    → ~/.claude/settings.json (every session everywhere)
 * Idempotent: an up-to-date lazy-polyglot entry is left as is. A hook entry from the
 * pre-rename "langcouch" install is replaced, so it can't fire twice.
 */
export function installClaude(scope: "project" | "user"): string {
  const settingsPath =
    scope === "user"
      ? join(homedir(), ".claude", "settings.json")
      : join(process.cwd(), ".claude", "settings.json");

  const pluginWarning = pluginAlreadyInstalled()
    ? "\nNote: the lazy-polyglot Claude Code plugin is already installed — it provides this hook by itself. A duplicate-delivery guard prevents double counting, but you likely don't need this manual install."
    : "";

  const { changed, replaced } = addHooks(settingsPath, hookCommand(cliPath()));

  if (changed.length === 0) return `lazy-polyglot hook already installed in ${settingsPath} — leaving it alone${pluginWarning}`;
  const upgraded = replaced ? `\nReplaced ${replaced} old langcouch hook ${replaced === 1 ? "entry" : "entries"}.` : "";
  return `Hook installed (${changed.join(" + ")}): ${settingsPath}${upgraded}\nRestart your Claude Code session ${scope === "project" ? "in this project" : "anywhere"} — replies will start weaving words.${pluginWarning}`;
}
