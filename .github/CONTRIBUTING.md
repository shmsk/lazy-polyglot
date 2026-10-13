# Contributing to Lazy Polyglot

## The contribution we want most: add your language

Every language is one JSON file mapping ~400 canonical concepts to that language's words. The full flow — designed so **your AI coding agent can do it for you** — lives in [docs/AddLanguage.md](../docs/AddLanguage.md). Point Claude Code (or any agent) at that file with your language code and review the PR it produces.

Also welcome via the same doc: native-language glosses (so learners can see translations in their own language) and grammar construction files for existing languages.

## Dev loop

```bash
bun install
bun test                        # unit tests
bunx tsc --noEmit               # typecheck
bun tests/validate-wordlist.ts  # data validation (add --full when contributing a language)
```

All three must be green before a PR. CI runs the same commands.

A new concept in `data/concepts.json` needs a rank: run `bun scripts/rank-words.ts <work-dir>` (it downloads the frequency sources into `<work-dir>`; never commit them) and commit the updated ranks. `tests/rank.test.ts` fails until every concept has one.

### Host smoke tests

[`.github/workflows/hosts-smoke.yml`](workflows/hosts-smoke.yml) installs Codex CLI, opencode, Hermes Agent and OpenClaw on a clean runner and checks each adapter end to end. Never run these hosts on your own machine for this; the runner is thrown away afterwards.

- **Fake-model jobs** point each host at [`tests/smoke/fake-llm.ts`](../tests/smoke/fake-llm.ts), a tiny stand-in for an OpenAI-compatible API. It records every request and always answers "ok". The job passes when a recorded request contains the `<lazy-polyglot>` block: the plugin loaded, the hook fired, and the block reached the model. No API key needed, and the result is the same every run.
- **Live jobs** run each host on real cheap models through OpenRouter. They pass when the reply contains, as `**word** (translation)`, at least one of the words the hook served in that run (read back from the state file). They run only after all fake-model jobs pass, and never on pull requests, because they need the `OPENROUTER_API_KEY` secret.
- To run the live jobs in your fork, add your own `OPENROUTER_API_KEY` secret with a spending limit, then start the workflow by hand in the Actions tab. The key is given only to the step that calls the model, and is never written to disk.

### Weave eval

[`evals/`](../evals/README.md) measures how well models follow the weave instruction, at three learner stages and on five everyday topics, with deterministic metrics and a blind judge. How it works and how to run it: [`evals/README.md`](../evals/README.md). Latest numbers: [`evals/RESULTS.md`](../evals/RESULTS.md).

## Ground rules

- TypeScript + bun; no runtime dependencies (the hook must start in milliseconds).
- The hook contract is sacred: `lazy-polyglot hook` never breaks the host session — on any error it prints nothing and exits 0.
- All product surfaces (CLI output, docs, code comments, weave instructions) are English-only. Wordlist/gloss data and README translations (`README.<lang>.md`, which follow `README.md`) are the only places other languages appear.
- **Nothing new appears in the user's own space without asking first.** The status line, spinner tips, settings files and anything else that stays on screen outside a Lazy Polyglot reply or pane are opt-in: off until the user says yes, asked once at a natural moment (the end of a `/cards` round, say), and switchable with a command. An update must never switch such a thing on for people who already have Lazy Polyglot. People keep that space clean on purpose (0.9.2: the due-card count in the status line, switched on silently in 0.9.0, became opt-in).
- Data changes should come with a second-model audit (see docs/AddLanguage.md, Step 6).
- **Updates must not break what people already have.** Users update in place and keep their `~/.lazy-polyglot` (config, progress, their own languages). Support data written by 0.7.6 and every later version; older formats need no care (someone on an older version updates to 0.7.6 first). Concretely:
  - Read old data, don't reject it: a missing field gets a default, an unknown field is kept, and a format change migrates on first save without losing progress (0.3.7 folded variant progress into the base this way).
  - `tests/upgrade.test.ts` runs every folder in `tests/fixtures/<version>/`: status and the hook must work on it, and no word, construction or rule may lose progress. When a release changes what goes on disk, add `tests/fixtures/<new version>/`, and never edit an old one.
  - Before a release, run the new code on a copy of a real `~/.lazy-polyglot` written by the previous release (`LAZY_POLYGLOT_DIR=<copy> bun src/cli.ts status`, then a few `hook` calls).
  - If an update ever needs the user to do something, the CHANGELOG entry gets an **Upgrade notes** section with numbered steps: what to run, where, and how to tell it worked. Write the steps so a person and an AI agent can both follow them without guessing.
