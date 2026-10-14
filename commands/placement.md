---
description: Placement test — check which Lazy Polyglot words you already know, so only new ones are taught
argument-hint: "[batch size, default 10]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/cli.sh *)
---

Run a placement test in this chat. The CLI decides what is right; you judge an answer only through `!sense` (step 2).

1. Run `${CLAUDE_PLUGIN_ROOT}/scripts/cli.sh placement next $ARGUMENTS` and show the words exactly as printed. Ask the user to reply with translations in the same order, one per line, leaving a line blank (or writing "-") for a word they don't know. Don't translate, hint, or explain the words.
2. When they answer, pass every word with their answer as typed: `${CLAUDE_PLUGIN_ROOT}/scripts/cli.sh placement answer "<word>=<answer>" "<word>=<answer>" ...`. A blank or "-" answer is `"<word>="`. Show the output verbatim.
   The CLI knows a word's other meanings (carta = paper, map, menu). If it still marks an answer ✗ and you are sure the answer is a real, common meaning of that word (not a guess, not a related word), pass that one pair again with `!sense` at the end: `"bambino=baby!sense"`. It counts the word as known and logs the meaning so it can be added to the dictionary. Say in one line which answer you vouched for.
3. Ask whether to continue; if yes, go back to step 1. Stop when they say so or the CLI says placement is done.

If anything errors, show the error message as-is. The same test runs interactively in a terminal with `lazy-polyglot placement`.
