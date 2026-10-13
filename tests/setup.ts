// Preloaded before every test file (bunfig.toml): one throwaway LAZY_POLYGLOT_DIR for the
// whole run. The store resolves DATA_DIR once at module load and the module is shared
// across files, so per-file sandboxes would depend on file order.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LAZY_POLYGLOT_DIR = mkdtempSync(join(tmpdir(), "lazy-polyglot-test-"));
// Hook tests spawn the CLI as an interactive session would, even when the suite itself runs under `claude --print`.
delete process.env.CLAUDE_CODE_ENTRYPOINT;
// Spinner tests must never touch the real ~/.claude/settings.json.
process.env.LAZY_POLYGLOT_CLAUDE_SETTINGS = join(process.env.LAZY_POLYGLOT_DIR, "claude-settings.json");
