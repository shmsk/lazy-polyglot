---
description: Add a new Lazy Polyglot language for yourself (survives plugin updates)
argument-hint: <language name or ISO code>
allowed-tools: Read, Write(~/.lazy-polyglot/**), Edit(~/.lazy-polyglot/**), Bash(${CLAUDE_PLUGIN_ROOT}/scripts/cli.sh *), Bash(bun ${CLAUDE_PLUGIN_ROOT}/scripts/sense-candidates.ts *)
---

Add the language "$ARGUMENTS" to Lazy Polyglot for this user.

Follow `${CLAUDE_PLUGIN_ROOT}/docs/AddLanguage.md` (path "For yourself"), reading the concept inventory from `${CLAUDE_PLUGIN_ROOT}/data/concepts.json`. Differences from a repo contribution:

- Write the wordlist to `~/.lazy-polyglot/wordlists/<code>.json`, and every other file next to it as `~/.lazy-polyglot/<folder>/<code>.json`, never inside `${CLAUDE_PLUGIN_ROOT}` (files there are replaced on every plugin update). The folders: `grammar/`, `patterns/`, `falseFriends/`, `numbers/`, `readings/`, `irregular/`, `senses/` (the doc's Steps 4–4f).
- Do the wordlist with its 30 numerals first (Steps 2 and 4c), then the other meanings of the words (Step 4f, `senses/<code>.json`), starting from the most frequent ~150 words, unless the user says they want it fast. Without that file a learner who gives a real second meaning of a word is marked wrong. The other optional files only when the user asks or the language clearly needs one (pronunciation for a language not read as spelled).
- For candidate meanings, `bun ${CLAUDE_PLUGIN_ROOT}/scripts/sense-candidates.ts <code> <scratch dir>` reads the user's wordlist and pulls Wiktionary definitions as raw material (it needs bun; without it, write from your own knowledge). Never copy Wiktionary text into the file.
- Validate with `${CLAUDE_PLUGIN_ROOT}/scripts/cli.sh validate <code> --full` and fix every reported error until it passes; it checks the senses file too.
- Then run `${CLAUDE_PLUGIN_ROOT}/scripts/cli.sh lang <code>` to switch to it, and check one other meaning is graded right: `${CLAUDE_PLUGIN_ROOT}/scripts/cli.sh placement answer "<word>=<other meaning>"`.
- If the user asks for a regional variant ("Brazilian Portuguese", `pt-BR`, "Mexican Spanish") of a language that already exists, follow the doc's "Adding a regional variant" section instead: the file `~/.lazy-polyglot/wordlists/<base>-<REGION>.json` holds only the words that differ from the base, and `~/.lazy-polyglot/senses/<base>-<REGION>.json` overrides any inherited meaning that doesn't hold in that region.

Done means: the validator passes with full coverage, `lang` shows `<code> (local)` as current, and you tell the user how many entries needed forced compromises and how many words got other meanings. Mention that they can share the language with everyone by opening a PR at https://github.com/shmsk/lazy-polyglot with the same files under `data/` (`data/wordlists/<code>.json`, `data/senses/<code>.json`, …).
