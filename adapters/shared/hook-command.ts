/** Quote a path for the shell used by command hooks. */
function quotePath(value: string, platform: string): string {
  if (platform !== "win32") return `'${value.replaceAll("'", "'\\''")}'`;
  // cmd expands %VAR% even inside quotes, PowerShell and Git Bash expand $ and `,
  // and none of them can escape these inside a quoted Windows path the same way.
  if (/[%$`"]/.test(value)) {
    throw new Error(`Lazy Polyglot can't write a hook for a path containing % $ \` or ": ${value}. Move the folder and install again.`);
  }
  return `"${value}"`;
}

/**
 * Run the hook with the runtime that runs the installer, so Node-only installs never
 * depend on bun. The runtime is named, not its absolute path: Homebrew, nvm and fnm
 * keep each version in its own folder, so a path like …/Cellar/bun/1.4.3/bin/bun
 * would break on the next upgrade (and make Codex ask to review the hook again).
 */
export function hookCommand(
  cli: string,
  args: string[] = [],
  runtime = { bun: !!process.versions.bun, node: process.versions.node, platform: process.platform as string },
): string {
  const [major, minor] = runtime.node.split(".").map(Number);
  if (!runtime.bun && (major! < 22 || (major === 22 && minor! < 6))) {
    throw new Error("Lazy Polyglot requires bun or Node.js >= 22.6");
  }
  const executable = runtime.bun ? "bun" : "node";
  const flag = !runtime.bun && (major === 22 || (major === 23 && minor! < 6)) ? " --experimental-strip-types" : "";
  return `${executable}${flag} ${quotePath(cli, runtime.platform)} hook${args.map((arg) => ` ${/^[\w-]+$/.test(arg) ? arg : quotePath(arg, runtime.platform)}`).join("")}`;
}
