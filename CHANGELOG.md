# Changelog

What changed in each version, written for people who use Lazy Polyglot. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). `lazy-polyglot status` shows the newest section once
after an update. If an update ever needs you to do something, its section starts with
**Upgrade notes**: numbered steps.

## [Unreleased]

### Changed
- `cards-status on` no longer shows a due-card count in the status line, which Claude Code drew
  as a yellow warning row (`⚠ lazy-polyglot: …`). It now shows one word you are learning and how
  many you have learned, dim at the end of the hint line under the prompt, a new word each
  message: `? for shortcuts  ·  fiore = flower  ·  5 of 451 learned`.
- New words now come most frequent first, not in blocks by part of speech (200 nouns, then
  verbs, with *molto*, *più*, *già* near the end). The order is a rank per word, computed from
  how often it turns up in film and TV subtitles and in news, across six languages; numerals,
  weekdays and months still come as sets. In Italian the first hundred new words now cover
  about a fifth of everyday speech instead of a twenty-fifth. Words you have already started
  keep their progress; only the ones you haven't met yet are reordered. Sources are credited
  in the README.

### Fixed
- A reply that weaves an irregular verb form now counts: **è** or **sono** for *essere*, *went*
  for *to go*, *fue* for *ir*. Before, only forms sharing the infinitive's root matched, so these
  were scored as misses.
- In English, a woven verb (*want*, *wanted*) now counts for *to want*. Before, the lemma's
  leading *to* had to be bold too, so no English verb ever counted.
- Claude Code runs that nobody reads (`claude --print`, the Agent SDK, a script or scheduled job)
  no longer take or score words. Before, every such run served new words and, when the reply
  skipped them, counted misses; a job running every few minutes could start the whole word list
  and send every word to rest for a week within days. To weave in those runs anyway, set
  `LAZY_POLYGLOT_HEADLESS=1`.
- When every word you've started is resting after misses and none is new, your agent gets the
  ones you saw longest ago instead of nothing, so the plugin no longer goes quiet. Skipping
  such a word doesn't lengthen its rest.
- Hermes Agent: a turn that arrives without a session id now counts under its own process instead
  of a slot shared by every id-less session, so two such sessions running at once no longer
  score words against each other's replies.

## [0.9.15] - 2026-10-09

### Added
- Milestones. At 50, 100, 200, 300 and 400 absorbed words, and at the whole core, your agent
  ends its next reply with one short line in the language you're learning. Half a topic, a whole
  topic and a week with new words get a line too. At most one a day, no streaks, and milestones
  you passed before updating aren't replayed. `status` shows the way to the next one
  (`▓▓▓░░ 87/100`).
  `/lazy-polyglot:milestones off` turns them off.

### Changed
- The "already know some of this language?" placement offer is no longer made to someone who
  has already absorbed 20 or more words in it.
- A reply ends with at most one extra line: when a question or an offer is due, a milestone
  waits for the next reply.

## [0.9.14] - 2026-10-09

### Fixed
- Words that are also English words (Italian *via*, *fine*, *due*, *zero*, and their kin in
  every language) no longer count as recalled when you write them in an English sentence. They
  count when the sentence has another listed word or is written in a non-Latin script.
- When you misspell or misuse a word you're learning, the agent corrects it in one short line.
  A misspelt word gets no credit.

### Changed
- The instruction your agent gets each turn is a little shorter, so more of your known words fit
  in it.

## [0.9.13] - 2026-10-09

### Added
- Topics: the words for one goal, taught first. Say `/lazy-polyglot:topic restaurants in
  Barcelona by Nov 20` (or ask in plain words), and the agent builds 40–150 words and short
  phrases, asking one or two skippable questions when the goal is vague. Topic words lead in
  replies, `/cards` and placement; words you already know keep their progress. `status`
  shows each running topic as *23/62 passed (18 words, 5 phrases) · 41 days left*. Two topics
  run at once, a third asks first, a fourth waits. At most 20 new entries a day: with a tight
  date the rest wait, and you're told. `topic end` stops a topic, `topic delete` removes it after a
  yes; what you learned stays either way. `export` and `import` carry topics. See
  docs/Topics.md.
- When you ask your agent why Lazy Polyglot does something, or say it's broken, the agent now
  first recommends checking for a newer version, since it may already be fixed, then works
  through the new docs/TROUBLESHOOTING.md. A paused plugin answers "why did it stop?" with how
  to resume.
- `status` shows the installed version in its first line.

## [0.9.12] - 2026-10-08

### Fixed
- Words woven in another form now count in Italian, Portuguese, French, German and Turkish,
  not only Spanish: **tira fuori** counts for *tirare fuori*, **cade** for *cadere*, and
  **abbiamo bisogno** for *avere bisogno*. Before, these were recorded as misses, so the
  word stayed in every instruction and its progress stood still.
- A word the model keeps skipping no longer holds a nudge slot forever: after 12 misses in a
  row it rests for a week, then comes back with a clean count.

## [0.9.11] - 2026-10-07

### Added
- Antigravity CLI (`agy`) support: `lazy-polyglot install antigravity [--scope project|user]`
  installs a plugin with two hooks, one rule and the same `/lazy-polyglot:*` commands as in
  Claude Code (`lang`, `level`, `pause`, `status` and the rest). Tested live on agy 1.3.1,
  including turns where the agent reads files before it answers.
- Asking the agent in plain words ("switch Lazy Polyglot to French", «переключи язык на
  французский») now works on every agent: that turn's instruction carries the exact command,
  so the agent no longer has to search for it. In Claude Code it only points you to
  `/lazy-polyglot:lang` and never runs a command itself.

### Known issues
- Codex through Ollama (`ollama launch codex`) doesn't weave: Ollama drops instructions
  that come after the start of a conversation. Other Codex providers are fine.

### Changed
- Gemini CLI support stays in beta; it is no longer on the roadmap to leave it.

## [0.9.10] - 2026-10-07

### Added
- A privacy policy, linked from the top of the README: Lazy Polyglot runs on your
  computer, stores only your word progress, and sends nothing anywhere.

## [0.9.9] - 2026-10-07

### Changed
- Tidier repository: the language data (words, grammar, pronunciations) now sits in one
  `data/` folder, so the GitHub page gets to the description faster. Nothing changes for you:
  your progress and any languages you added stay where they were.

## [0.9.8] - 2026-10-07

### Added
- Grammar constructions for English, Portuguese and Italian, not only Spanish. From level 4
  the weave teaches short patterns such as *the house is big*, *nella stanza*, *o centro da
  cidade*: 12 for `en`, 12 for `it`, 11 for `pt`.
- UK English and Brazilian Portuguese teach their own constructions first, next to the base
  form: *have you got a car? (US: do you have a car?)*, *estou trabalhando (Portugal: estou a
  trabalhar)*. A Brazilian learner is never taught *estar a + infinitive*.
- Days of the week and months in every language: 19 new words, 451 in all. If you added a
  language of your own, it keeps working without them; `lazy-polyglot validate <code> --full` lists
  them as missing so you can add them.

### Fixed
- About 65 US English pronunciations were wrong, for example *name*, *place*, *time*, *one*,
  *ten*, *woman*, *country*, *food*. They are now General American.

## [0.9.7] - 2026-10-06

### Upgrade notes
Skip these if you installed 0.9.7 or later as Lazy Polyglot. The full version, with the
other hosts, is in [UPGRADING.md](UPGRADING.md).
1. Back up your progress. In Claude Code run `/langcouch:export`. It writes
   `~/langcouch-export-YYYY-MM-DD.json`. If the command is missing, skip this step: your data
   is still in `~/.langcouch`.
2. Run `/plugin marketplace remove langcouch`. This removes the old plugin and keeps your
   progress.
3. Run `/plugin marketplace add shmsk/lazy-polyglot`, then
   `/plugin install lazy-polyglot@lazy-polyglot`.
4. Run `/reload-plugins`, or restart Claude Code.
5. Run `/lazy-polyglot:status`. It should show your language and the same word counts as
   before; on first run Lazy Polyglot moves `~/.langcouch` to `~/.lazy-polyglot` by itself.
6. If the status shows zero words, run `/lazy-polyglot:import ~/langcouch-export-YYYY-MM-DD.json`
   with the file from step 1. Import merges, so running it twice is harmless.
7. On opencode, Codex CLI, Gemini CLI, Hermes Agent or OpenClaw: back up with
   `bun src/cli.ts export`, run `git pull`, then run `bun src/cli.ts install <host>` again.
   The installer replaces the old LangCouch entry. Then check `bun src/cli.ts status`.

### Changed
- LangCouch is now Lazy Polyglot ("Get (almost) accidentally fluent"). The plugin is going
  into Anthropic's official plugin directory, and the new name is quicker to understand there.
  Same plugin, same words, same progress.
- Commands are `/lazy-polyglot:status`, `/lazy-polyglot:lang` and so on; the CLI is
  `lazy-polyglot`; the weave block in the context is tagged `<lazy-polyglot>`.
- Your data folder moves from `~/.langcouch` to `~/.lazy-polyglot` automatically on first run.
  `LAZY_POLYGLOT_DIR` replaces `LANGCOUCH_DIR`; the old variable still works.
- Spinner tips start with "Lazy Polyglot · ", and the export file is
  `~/lazy-polyglot-export-YYYY-MM-DD.json`.
- The Hermes plugin lives in `$HERMES_HOME/plugins/lazy-polyglot`, OpenClaw uses
  `plugins.entries.lazy-polyglot`, and re-running `install <host>` replaces an old LangCouch
  install.
- The repository is now github.com/shmsk/lazy-polyglot; links to the old address redirect.

## [0.9.5] - 2026-10-06

### Added
- New French, English and Portuguese words come with their pronunciation, in letters you can
  read: **maison** [мезо́н] (дом) if you write in Russian, [meh-ZAWN] in English, [mezon] in
  Uzbek. Prefer IPA ([mɛzɔ̃]) or none at all? LangCouch asks once per language, with all three
  shown on a word from your list, and `/langcouch:reading off|native|ipa` changes it any time.
  American and British English, European and Brazilian Portuguese each have their own
  pronunciation. Cards and spinner tips show it too.
- `/langcouch:lang` shows the three choices when you switch to one of these languages.

## [0.9.4] - 2026-10-05

### Changed
- `/cards` shows which language each word is in: a flag and the language's own name, like
  🇮🇹 casa Italiano, and the answer as ✓ дом 🇷🇺 Русский. Words spelled the same in two
  languages ("natural" in Spanish and English) are no longer ambiguous. The name is there
  because some terminals (Warp) draw a flag as two boxed letters. Outside the terminal the
  card's corner shows the flag and name of the word on it.

## [0.9.3] - 2026-10-05

### Changed
- `/cards` looks like a flashcard app in the Desktop Code tab, VS Code and mobile: the word
  big in the middle of a card, a progress bar for the round, the answer under a line in green
  or red, and the score as a ring at the end. It follows the light or dark theme. The terminal
  pane is unchanged.
- Where you grade yourself (mobile), 1 is "Didn't" and 2 is "Knew it".

### Fixed
- The README now says that the pane needs Claude Code 2.1.287 or newer. The Desktop app runs
  its own copy of Claude Code: if `/cards` is missing there, update the app.

## [0.9.2] - 2026-10-05

### Fixed
- Cards, `quiz` and placement no longer fail a right answer worded differently: "to work"
  for lavoro and "the child" for bambino are right (a leading the/a/an/to is ignored), and
  common synonyms such as "kid" for child or "job" for work count too. A wrong grade used
  to send the word back down the ladder.

### Added
- "My answer was right" after a miss: it takes the miss back and records the card as right,
  for answers no list foresees. `langcouch cards accept` is the command behind it.
- `/langcouch:cards-status on|off|status`: the due-card count in the status line.

### Changed
- The due-card count (`🃏 96 due`) no longer appears in the Claude Code status line unless
  you turn it on. The status line is your space: `/cards` asks once at the end of a round, and
  `/langcouch:cards-status on` turns it on any time. If you liked it in 0.9.0/0.9.1, say yes
  there or run that command.

## [0.9.1] - 2026-10-05

### Upgrade notes
1. If you installed the flashcards plugin in 0.9.0, remove it, or `/cards` is registered
   twice: run `/plugin uninstall langcouch-cards@langcouch` in Claude Code. Your card progress
   is kept: it lives in `~/.langcouch`, not in the plugin.
2. Restart the session. `/cards` now comes from LangCouch itself.

### Changed
- Flashcards ship inside the `langcouch` plugin: `/cards` and its status line count are there
  after a normal update, with nothing extra to install. The separate `langcouch-cards` plugin is
  gone from the marketplace.

## [0.9.0] - 2026-10-05

### Upgrade notes
1. If you are on a version older than 0.7.6, update to 0.7.6 first, run `langcouch status`
   once, and only then update to this version. Data from before 0.7.6 is no longer tested, so it may not carry over.
   You can tell which version you have from `langcouch status`, or `/plugin` in Claude Code.

### Added
- Flashcards: `/plugin install langcouch-cards@langcouch` adds `/cards`, a pane in the
  terminal, the Desktop Code tab, VS Code and mobile. It reviews the words that are due, the
  most overdue first, then asks placement words. From the 3rd ladder step a card can also ask
  the other way: your language → the one you learn. Where there is no text field (mobile)
  you show the answer and say whether you knew it. The status line shows how many words are due.
- `langcouch cards status | next | answer | reveal | grade`: the JSON the cards mod reads.
  Every card is graded and recorded by LangCouch, so cards and replies share one progress.

### Changed
- Data written by 0.4.0–0.7.5 is no longer tested or supported: update through 0.7.6 (see Upgrade notes).

## [0.8.0] - 2026-10-05

### Added
- Numbers 1–1000 in every language. The 30 numerals every number is built from (0–20, the
  tens, 100, 1000) are on your list like other words, at most one per reply, woven next to
  its digit so the fact stays readable: 3 (**tre**). They come early, after the first ~40 words.
- Number rules: when a numeral is in the reply, a short rule shows how bigger numbers are
  built, in the language you write in (English: learn 11 and 12, then -teen; French: 70 is
  60+10, 80 is 4×20; Turkish: learn the tens). Each rule takes the word-building rule's
  place until it has been shown three times. `status` shows "Number rules: 2/7 introduced".
  Your own rules can go in `~/.langcouch/numbers/<lang>.json`, and export/import carries them.

### Changed
- False friends next to a word-building rule now give the real meaning in Russian or Uzbek
  too, not only English: "attualmente = сейчас". Your own `falseFriends` files with a plain
  text meaning keep working as before.

## [0.7.6] - 2026-10-02

### Added
- Placement test for a language you already partly know: `langcouch placement` in a
  terminal, or `/langcouch:placement` in Claude Code. It asks the listed words you haven't
  absorbed yet, most common first. A right translation sends the word straight to the
  absorbed pool (reviewed in two weeks), so it is no longer taught as new; a word you don't
  know stays new. Progress saves after every word, and the next run carries on where you
  stopped. `langcouch placement --reset` asks the "don't know" words again.
- LangCouch offers the test once when you start a language, and again whenever you say the
  words are too easy ("слишком простые слова", "I already know these words").

## [0.7.5] - 2026-10-01

### Added
- Translations follow the language you write in: a message in Russian gets `casa (дом)`,
  one in English gets `casa (house)`, with no setting to change. Cyrillic means Russian;
  Latin means your `native` when it is English or Uzbek, otherwise English. Pasted code and
  links don't count.
- When LangCouch can't tell a message's language, it uses your `native` and the agent asks
  you once which language you want translations in.
- `langcouch native <en|ru|uz>` sets your language: the fallback above, quiz answers and
  spinner tips.
- Gemini CLI support, **beta**: `langcouch install gemini [--scope project|user]` registers
  the `BeforeAgent`, `SessionStart` and `AfterAgent` hooks in Gemini's `settings.json`. It
  follows Gemini's hooks reference and is covered by tests, but has not been run against a
  live Gemini CLI yet.

### Changed
- The rule about text you will copy or send (posts, emails, commit messages) no longer
  names a language: it only says to keep target-language words out.

## [0.7.0] - 2026-10-01

### Added
- `langcouch export` saves your progress, settings and own wordlists to one file, and
  `langcouch import <file>` merges it into another machine. Words only the other machine
  has stay, words only the file has are added, and a word on both keeps the better record.
  Your settings stay unless you pass `--config`. The old files are backed up to
  `~/.langcouch/backups/` first, and importing the same file again changes nothing.
  The export goes to `~/langcouch-export-<date>.json` unless you name a file, and an
  existing file is replaced only with `--force`.
- `/langcouch:export` and `/langcouch:import` in Claude Code; `/langcouch export` and
  `/langcouch import` in Hermes Agent and OpenClaw.

### Changed
- Progress and settings files are now written through a temporary file and a rename, so a
  crash or a sync client never leaves half a file behind. A file you symlinked elsewhere
  is written at its target and keeps its permissions.

## [0.6.0] - 2026-09-30

**Upgrade notes**

Your progress carries over by itself: on first use each word is placed on the new ladder
from its old counts, and every word you had absorbed stays absorbed. Two steps are needed
only if you installed LangCouch outside the Claude Code plugin:

1. Codex CLI, or a manual Claude Code hook: run `langcouch install codex` (or
   `langcouch install claude`) again with the same `--scope`. It adds the `Stop` hook and
   leaves your other hooks alone. In Codex, open `/hooks` and trust the new entry.
2. opencode, Hermes Agent or OpenClaw: run `langcouch install opencode` (with the same
   `--scope`), `langcouch install hermes` or `langcouch install openclaw` again, so the
   plugin file picks up the after-reply event. For OpenClaw, run the printed link command
   again too.

If you skip them, weaving keeps working and words are counted when they are served, as
before. To keep the old weave entirely, run `langcouch mode 1`.

### Changed
- Words come back on an interval ladder: 30 minutes, 8 hours, a day, 4 days, 2 weeks, a
  month, then 6 months. A word climbs a step only when a reply actually uses it while it
  is due, and it keeps coming back until one does.
- A word counts as shown only when the reply used it. LangCouch reads the finished reply
  back through the host's after-reply event: `Stop` in Claude Code and Codex,
  `post_llm_call` in Hermes, `agent_end` in OpenClaw, `session.idle` in opencode.
- Translations fade. A new word comes as **casa** (house). A familiar one comes as plain
  **casa**, and the reply ends with one line such as `casa = house · nombre = name`.
  Absorbed words get no translation, so more of each reply is in the language you learn.
- The model weaves a word only where the reply already needs its meaning, instead of
  fitting in every listed word. One or two words that kept missing may still go into a
  short aside or a closing line, never into code, facts or text you will copy.
- Posts, emails, summaries and commit messages you will copy or send stay free of
  foreign words; the weave stays in the text around them.
- A wrong `quiz` answer sends a word back to the start of the ladder.

### Added
- `langcouch mode [1|2|3]` and `/langcouch:mode`: 3 is the new default, 2 weaves only
  words that fit, 1 is the old "every listed word".
- `status` shows the current mode.

## [0.5.0] - 2026-09-30

### Added
- Hermes Agent support: `langcouch install hermes` puts a plugin into
  `$HERMES_HOME/plugins/langcouch/`, then `hermes plugins enable langcouch`. It works in the
  Hermes CLI and on gateway platforms such as Telegram.
- OpenClaw support: `langcouch install openclaw` generates a plugin and prints the three
  commands that link, allow and enable it.
- `/langcouch status`, `/langcouch lang pt`, `/langcouch level up`, `/langcouch pause` and
  `/langcouch resume` inside Hermes and OpenClaw chats.
- Every host except Claude Code is now tested end to end in CI on a clean machine: Codex
  CLI, opencode, Hermes Agent and OpenClaw. The tests check that the plugin loads, that the
  instruction reaches the model, and that real models (DeepSeek, GLM) weave the words they
  were given.

## [0.4.0] - 2026-09-28

### Added
- Word-building rules. Learn one rule, such as -tion → -ción, and you can read a whole
  family of words: *revolución*, *información*, *nación*. From level 2, each reply teaches
  one rule and may use one extra word built by it.
- Rules for Spanish, Portuguese, Italian, French, German, Turkish and English, 5 to 8 per
  language. You see the rule from your native language: -tion for English speakers,
  -ция for Russian speakers.
- False friends next to their rule, so *actual* is taught as "current", not "actual".
- Latin American Spanish grammar: *ustedes trabajan* instead of Spain's *vosotros trabajáis*,
  and the preterite for today (*hoy trabajé*).
- A warning when a Spain word is rude in Latin America:
  *tomar = to take, Spain: coger (vulgar in much of Latin America)*.
- `status` shows your word-building progress, and this list once after each update.

### Changed
- From level 7, the whole sentence in a reply is kept when a grammar construction is used,
  and the construction goes inside it. Before, the construction replaced the sentence.
- Grammar progress is shared between a regional variant and its base, like words.
- A variant's grammar file (your own in `~/.langcouch/grammar/`, too) now adds to its base's
  constructions instead of replacing them all. An item with the same `id` still replaces
  the base's one.

## [0.3.7] - 2026-09-28

### Changed
- Switching to a regional variant (es → es-419, pt → pt-BR, en → en-GB) no longer starts
  over: words spelled the same share one progress pool with the base, and only the
  variant's own words are new. They come first, with a contrast: *carro = car, Spain: coche*.
  Old variant progress is merged into the base on first save.
- `status` shows a *Regional* line for variants.

## [0.3.6] - 2026-09-27

### Fixed
- Windows: the plugin found no wordlists when its path had a drive letter or spaces.

## [0.3.5] - 2026-09-25

### Added
- `latam` works as a name for es-419.
- README in Russian and Uzbek.

### Changed
- Codex CLI runs on a real hook instead of an AGENTS.md section; the old section is removed
  for you.

## [0.3.0] - 2026-09-25

### Added
- Spinner tips: words you're learning show up in the Claude Code spinner
  (`langcouch spinner on`).

## [0.2.2] - 2026-09-25

### Added
- New languages: English (US and UK), German, French, Italian, Spanish (Latin America),
  Portuguese (Portugal and Brazil).
- Uzbek glosses.

### Changed
- Every wordlist audited by a second model from another vendor.
- Two concepts may share a word when the language does, so lists use natural words instead
  of rare synonyms.

## [0.2.1] - 2026-09-25

### Added
- Regional variants as small overlays on their base language (pt-BR over pt).

## [0.2.0] - 2026-09-25

### Added
- Your own languages in `~/.langcouch/` survive plugin updates.
- `/langcouch:add-language` and `langcouch validate`.

## [0.1.0] - 2026-09-25

### Added
- First release: passive language immersion for Claude Code, opencode and Codex CLI.
