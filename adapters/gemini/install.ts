import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { addHooks } from "../shared/json-hooks.ts";
import { hookCommand } from "../shared/hook-command.ts";

function cliPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli.ts");
}

/**
 * Gemini CLI's names for the three moments Lazy Polyglot needs: before the model sees
 * the prompt (BeforeAgent ≈ UserPromptSubmit), session start, and after the reply
 * (AfterAgent ≈ Stop, with the reply in `prompt_response`).
 */
export const GEMINI_EVENTS = ["BeforeAgent", "SessionStart", "AfterAgent"];

/**
 * Register `lazy-polyglot hook --host gemini` in Gemini CLI's settings.json. The file has
 * the same `hooks` shape as Claude Code's, but Gemini reads context only from JSON on
 * stdout (`hookSpecificOutput.additionalContext`), hence the --host flag.
 * scope=project → ./.gemini/settings.json (Gemini warns before running a new project hook)
 * scope=user    → ~/.gemini/settings.json
 * Beta: built from Gemini's hooks reference, not yet run against a live Gemini CLI.
 */
export function installGemini(scope: "project" | "user"): string {
  const settingsPath =
    scope === "user" ? join(homedir(), ".gemini", "settings.json") : join(process.cwd(), ".gemini", "settings.json");

  const { changed, replaced } = addHooks(settingsPath, hookCommand(cliPath(), ["--host", "gemini"]), GEMINI_EVENTS, { name: "lazy-polyglot", timeout: 10000 });
  if (changed.length === 0) return `lazy-polyglot hook already installed in ${settingsPath} — leaving it alone`;
  return [
    `Hook installed (${changed.join(" + ")}): ${settingsPath}`,
    replaced ? `Replaced ${replaced} old langcouch hook ${replaced === 1 ? "entry" : "entries"}.` : "",
    "Gemini CLI support is beta: built from Gemini's hooks reference, not yet tested against a live Gemini CLI.",
    scope === "project" ? "Gemini asks before running a new project hook: allow lazy-polyglot when it does." : "",
    "Then replies will start weaving words.",
  ]
    .filter(Boolean)
    .join("\n");
}
