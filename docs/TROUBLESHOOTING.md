# Troubleshooting

Written for you and for the AI agent helping you. Lazy Polyglot is young and changes often, so start with step 1: many problems are already fixed in a newer version.

## 1. Check your version first

- See what you have: `/lazy-polyglot:status` in Claude Code, or `lazy-polyglot status` anywhere else. The first line starts with `lazy-polyglot <version>`.
- See what's out: the top of [CHANGELOG.md](https://github.com/shmsk/lazy-polyglot/blob/main/CHANGELOG.md). Skim the versions above yours for your problem.
- If yours is older, update and restart the session, then try again:
  - Claude Code: `/plugin marketplace update lazy-polyglot`, then `/plugin manage` → lazy-polyglot → "Update now", then `/reload-plugins` (or restart). From a shell: `claude plugin update lazy-polyglot@lazy-polyglot`. To get updates automatically from now on: `/plugin` → Marketplaces → lazy-polyglot → "Enable auto-update" (off by default for marketplaces outside the official one).
  - Manual clone: `git pull` in the clone.
  - Codex, Gemini CLI, Antigravity, OpenCode, Hermes, OpenClaw: `git pull` in the clone, then run the same `install <host>` command you used the first time (it updates in place).
- Your progress lives in `~/.lazy-polyglot/` and survives updates: new versions read data from 0.7.6 on and carry it forward without loss.

If you're already on the latest version, go on to the table.

## 2. Common problems

| What you see | Usual cause | Fix |
|---|---|---|
| No words woven at all | Paused | `/lazy-polyglot:resume` (or `resume`) |
| No words in `claude --print` or Agent SDK runs | By design: nobody reads those replies, so they never take or score words | To weave there anyway (tests, evals), set `LAZY_POLYGLOT_HEADLESS=1` |
| No words right after installing | The session started before the install | Restart the session |
| No words in Codex | The hook isn't trusted yet | Open `/hooks` in Codex and trust the `lazy-polyglot` hook |
| No words in OpenClaw | The `claude-cli` provider doesn't run prompt hooks | Use another provider ([openclaw#65157](https://github.com/openclaw/openclaw/issues/65157)) |
| No words in Antigravity | The plugin is disabled | `agy -p /hooks` should list two `lazy-polyglot` hooks; enable the plugin |
| Wrong language | Another language is selected | `/lazy-polyglot:lang` lists them; `/lazy-polyglot:lang es` switches |
| Translations in the wrong language | Glosses follow the language you write in | Write in English, Russian or Uzbek; your default is `native` in `~/.lazy-polyglot/config.json` |
| Too many or too few words | Level | `/lazy-polyglot:level up` or `down` (1–10) |
| The same words every reply | Words come back until the reply actually uses them (mode 3) | Normal; they move on once woven. `/lazy-polyglot:mode` shows the other modes |
| `status` counts don't move | The host has no after-reply event, or the session was cut short | Counts settle on the next turn; if they never move, report it |
| Words you already know keep coming | They were never marked known | `/lazy-polyglot:placement` |
| `/cards` is missing | Old Claude Code or Desktop app | Update the app (Claude Code 2.1.287+), restart |
| Your own language doesn't load | The file has errors | `lazy-polyglot validate <code>` lists them |

## 3. Still broken

Open an issue at https://github.com/shmsk/lazy-polyglot/issues with:

- your version and host (Claude Code, Codex, …) and OS;
- what you did, what you expected, what happened;
- the output of `status`.

Leave out personal data: your words and progress are enough, nothing from your other conversations is needed.
