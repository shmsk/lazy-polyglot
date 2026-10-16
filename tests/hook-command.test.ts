import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { hookCommand } from "../adapters/shared/hook-command.ts";

describe("hook command", () => {
  test("executes Bun and Node from PATH with a script path containing spaces and shell characters", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "lazy-polyglot space '$`;-"));
    try {
      const cli = join(dir, "probe '$`.ts");
      writeFileSync(cli, "const n: number = 1; console.log(JSON.stringify({ n, args: process.argv.slice(2) }));");
      const node = spawnSync("node", ["-p", "JSON.stringify({ executable: process.execPath, node: process.versions.node })"], { encoding: "utf8" });
      expect(node.status).toBe(0);
      const nodeRuntime = JSON.parse(node.stdout) as { executable: string; node: string };
      for (const runtime of [
        { executable: process.execPath, bun: true, node: process.versions.node },
        { ...nodeRuntime, bun: false },
      ]) {
        // only this runtime is on PATH, so the command must find it by name
        const bin = join(dir, runtime.bun ? "bun-bin" : "node-bin");
        mkdirSync(bin);
        symlinkSync(runtime.executable, join(bin, runtime.bun ? "bun" : "node"));
        const command = hookCommand(cli, ["--host", "gemini"], { bun: runtime.bun, node: runtime.node, platform: "darwin" });
        const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", env: { ...process.env, PATH: bin } });
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ n: 1, args: ["hook", "--host", "gemini"] });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("names the runtime instead of a versioned absolute path", () => {
    expect(hookCommand("/cli.ts", [], { bun: true, node: "24.0.0", platform: "darwin" })).toBe("bun '/cli.ts' hook");
    expect(hookCommand("/cli.ts", [], { bun: false, node: "24.0.0", platform: "darwin" })).toBe("node '/cli.ts' hook");
  });

  test("Node 22 and early Node 23 use the type stripping flag", () => {
    const runtime = { bun: false, node: "22.6.0", platform: "linux" };
    expect(hookCommand("/cli.ts", [], runtime)).toBe("node --experimental-strip-types '/cli.ts' hook");
    expect(hookCommand("/cli.ts", [], { ...runtime, node: "23.5.0" })).toBe("node --experimental-strip-types '/cli.ts' hook");
    expect(hookCommand("/cli.ts", [], { ...runtime, node: "23.6.0" })).toBe("node '/cli.ts' hook");
    expect(hookCommand("/cli.ts", [], { ...runtime, node: "24.0.0" })).toBe("node '/cli.ts' hook");
    expect(() => hookCommand("/cli.ts", [], { ...runtime, node: "22.5.0" })).toThrow("Node.js >= 22.6");
  });

  test("Windows quotes the script path", () => {
    const command = hookCommand("C:\\My Project & Tools\\cli.ts", ["--host", "gemini"], { bun: false, node: "24.0.0", platform: "win32" });
    expect(command).toBe('node "C:\\My Project & Tools\\cli.ts" hook --host gemini');
  });

  test("Windows refuses paths a quoted hook command can't carry safely", () => {
    for (const path of ["C:\\100%\\cli.ts", "C:\\$dir\\cli.ts", "C:\\a`b\\cli.ts"]) {
      expect(() => hookCommand(path, [], { bun: true, node: "24.0.0", platform: "win32" })).toThrow("Move the folder");
    }
  });
});
