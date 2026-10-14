# Adding a language to Lazy Polyglot

This document is written for an AI coding agent (Claude Code, Codex, etc.) — a human can follow it too. Following it end-to-end produces a complete, validated language, either just for yourself or as a PR for everyone.

## What you are building

Lazy Polyglot weaves target-language words into an AI agent's replies. Vocabulary is defined once as a canonical inventory of ~400 language-independent meanings (`data/concepts.json`); each language is a thin file mapping concept ids to that language's words. You will produce **one JSON file**. Three more are optional: grammar constructions, word-building rules and false friends. No code changes: the language name is derived from its ISO code.

Inputs you need before starting:
- the ISO 639-1 language code (`tr`, `de`, `fr`, …) — called `<code>` below

## Two ways to add a language

- **For yourself** (Claude Code plugin users): run `/lazy-polyglot:add-language <language>`, or follow this doc and put the file at `~/.lazy-polyglot/wordlists/<code>.json` (optional files go next to it: `~/.lazy-polyglot/grammar/`, `~/.lazy-polyglot/patterns/`, `~/.lazy-polyglot/falseFriends/`, each as `<code>.json`). It lives next to your progress and survives plugin updates. No clone needed; validate with `lazy-polyglot validate <code> --full` (inside Claude Code: `${CLAUDE_PLUGIN_ROOT}/scripts/cli.sh validate <code> --full`). Never write into the plugin folder (`~/.claude/plugins/cache/…`): it is replaced on every update.
- **For everyone** (a PR): work in a clone of this repo with [bun](https://bun.sh) (`bun install`), put the file at `data/wordlists/<code>.json`, and follow every step below including the PR checklist.

A file in `~/.lazy-polyglot/wordlists/` overrides a bundled one with the same code, so you can also fix a word locally.

## Step 1 — Read the concept inventory

Open `data/concepts.json`. Each entry is:

```json
{ "id": "house", "pos": "noun", "tier": 1, "gloss": { "en": "house", "ru": "дом" } }
```

- `id` — stable kebab-case concept id; this is what your file keys on
- `pos` — part of speech the translation must match (`noun` | `verb` | `adj` | `adv`)
- `gloss.en` — the English meaning; where an id carries a sense hint (`time-occasion`, `floor-surface`), translate that specific sense
- `tier` — vocabulary band (all current concepts are tier 1); ignore it when translating

A complete contribution covers **every** concept.

## Step 2 — Create `<code>.json`

A flat JSON object, one line per entry, concept id → word:

```json
{
 "house": "ev",
 "time": "zaman"
}
```

Translation rules (the validator enforces the mechanical ones):

1. **Most common everyday word** for the concept, matching its `pos`. No rare, literary, or archaic words — pick what a beginner hears daily.
2. **Lemma / citation form**: nouns in singular, verbs in the language's dictionary form (infinitive where that is the convention), adjectives in the base (masculine singular where applicable).
3. **Single word strongly preferred**; hard maximum 3 space-separated tokens.
4. **The natural word wins, even when two concepts share it.** If your language really uses one everyday word for two concepts (Spanish *mañana* = morning and tomorrow, Turkish *ay* = moon and month), use it for both; don't swap in a rare synonym to keep them apart. Lazy Polyglot handles it: a batch shows the word once, a recall credits both concepts, and the quiz accepts either meaning. At most 2 concepts may share a word (the validator enforces it), and it prints every shared word, so **list them in your PR** for the auditor to confirm each is real.
5. **Keep noun and verb apart by citation form where the language has one.** English writes verbs as `to work`, `to love`, so the verb entry never reads like the noun; the weave inflects it in context anyway (*worked*, *she loves*). Where the language has no such form, rule 4 applies.
6. **Content words only.** If the natural translation is a particle or function word, choose the nearest content-word synonym. When your language expresses a concept grammatically rather than lexically (no verb "to have", modality as a suffix, comparatives needing a particle), use the closest common periphrastic or derived form — that is expected, not a violation; note it in the PR.
7. Native script, lowercase by the language's own convention (this matters for recall matching — e.g. Turkish dotted/dotless i). Where correct orthography and what users actually type diverge, **the typed form wins**.
8. No transliterations of English, no offensive words. Words shorter than 3 characters are fine when they're the natural choice — they just never trigger prompt-recall (see FAQ); mention roughly how many such entries you have in the PR.

## Step 3 — Language name: nothing to register

The instruction names the language via `Intl.DisplayNames` (`ka` → Georgian). Use a standard ISO 639-1 code and it just works; there is no code to edit.

## Step 4 (optional) — `data/grammar/<code>.json`

Grammar constructions unlock at higher levels. Mirror the schema of `data/grammar/es.json`:

```json
{ "id": "def-article", "pattern": "gender + definite article (el/la + noun)", "exampleTarget": "la casa", "exampleGloss": "the house", "unlock": { "pos": "noun", "absorbedCount": 3 } }
```

8–12 constructions, ordered easy → hard with rising `absorbedCount` thresholds (compare `data/grammar/es.json`). `pattern` and `exampleGloss` are in English; `exampleTarget` must use words from your wordlist. Skip this step if unsure — languages work without a grammar file.

## Step 4b (optional) — `data/patterns/<code>.json` and `data/falseFriends/<code>.json`

Word-building rules teach one suffix that turns a whole family of known words into your language: *-tion → -ción* makes *revolución*, *información*, *nación* readable at once. One rule per reply, from level 2. Mirror `data/patterns/es.json`:

```json
{ "id": "tion", "from": { "en": "-tion", "ru": "-ция" }, "to": "-ción", "examples": [ { "target": "revolución", "gloss": { "en": "revolution", "ru": "революция" } } ], "source": "https://en.wiktionary.org/wiki/-ci%C3%B3n" }
```

- `id`: reuse the ids other languages use (`tion`, `ity`, `al`, `ism`, `ist`, `ic`, `ly`, `ate`, `irovat`, `izovat`), so a learner's rules line up across languages.
- `from`: the suffix in each native language that has a real parallel. Leave a key out when it has none (`ly` has no `ru`); the learner then sees the English side, or nothing for a ru-only rule.
- `examples`: exactly 3 common words with the same meaning in every native language, and each gloss should itself show the native suffix (*revolución = революция*).
- `source`: a URL that backs the correspondence, usually the Wiktionary page of the suffix.
- 5–8 rules, most reliable first; the file order is the teaching order. Drop a rule whose exceptions outnumber its matches.

False friends warn about words that look like a rule but mean something else. Mirror `data/falseFriends/es.json`:

```json
{ "target": "actual", "means": { "en": "current", "ru": "текущий", "uz": "joriy" }, "register": "neutral", "looksLike": { "en": "actual" }, "pattern": "al", "source": "https://en.wiktionary.org/wiki/actual" }
```

`means` gives the real meaning in every native language (`en`, `ru`, `uz`); the learner sees theirs, falling back to English. A plain string still loads, but then every learner sees that one language. `pattern` ties it to a rule; only false friends with a `pattern` are shown, next to that rule. A word that is rude somewhere gets `"register": "vulgar"` and `"vulgarIn": ["<code>"]` for the codes where it is rude. Such words are never taught; the tests fail if one is a lemma or an example in those codes, and the instruction tells the agent to avoid it. Never put a vulgar word in `examples`.

Check every example and false friend against a live dictionary, then run the Step 6 audit on these files too.

## Step 4c — numbers: the 30 numerals and `data/numbers/<code>.json`

Numbers are taught as building blocks plus rules. The wordlist maps the 30 numeral concepts (`num-0` … `num-20`, `num-30` … `num-90`, `num-100`, `num-1000`) to the standalone counting form ("uno", "cien", "mil"); `--full` validation fails without them. Put them early in the wordlist (after the first ~40 entries): the file order is the order new words come in. A reply carries at most one numeral, woven next to its digit: `3 (**tre**)`.

`data/numbers/<code>.json` holds 4–8 rules, in teaching order, that let a learner build any number up to 1000 from those blocks:

```json
{ "id": "teens", "hint": { "en": "17-19: dicia-/dician- + unit, one word", "ru": "17-19: dicia-/dician- + единица, одним словом", "uz": "17-19: dicia-/dician- + birlik, bitta so'z" }, "example": { "value": 17, "target": "diciassette" }, "source": "https://en.wiktionary.org/wiki/diciassette" }
```

- `hint`: what to memorize and what follows a pattern, in every native language, at most 110 characters each.
- `example`: one number the rule builds, spelled correctly; up to 1000, except a thousands rule may show 2000 to make its point (*dos mil*).
- A regional variant may override a base rule with a file of its own, using the same `id`.

A rule is shown when a numeral is in the reply and some rule is still new (shown fewer than 3 times); it then takes the word-building rule's place.

## Step 4d (optional) — `data/readings/<code>.json`

Only for a language that is not read the way it is spelled (French, English, Portuguese are; Spanish, Italian, Turkish are not). New words then come with their pronunciation, rendered for each learner in their own letters or as IPA (`/lazy-polyglot:reading`). The file maps every concept id to its IPA:

```json
{
 "house": "mɛ.zɔ̃",
 "time": "tɑ̃"
}
```

- The phonemic transcription from the language section of the word's English Wiktionary page, without the slashes: syllable dots and the stress mark `ˈ` stay (the English respelling capitalises the stressed syllable, the Russian one marks it).
- The standard citation form: not a weak form, a dialect, a liaison form or a usage note. Where Wiktionary lists several standard accents, use the one your base code stands for (`en`: General American, `pt`: Portugal).
- Cover every concept in your wordlist; `bun test` checks coverage and renders every entry for every native language, failing on any IPA symbol it cannot spell.
- A regional variant gets its own file with only the words that sound different, plus every word it spells differently (`pt-BR`: Brazilian pronunciation; `en-GB`: Received Pronunciation).
- For yourself, the file goes in `~/.lazy-polyglot/readings/<code>.json`, like the others.

## Step 4e (optional) — `data/irregular/<code>.json`

A reply counts a word only when it shows up in bold, and a verb is matched by its root: `venire` finds *vengo*. Forms that share no root with the infinitive (`essere` → *è*, *sono*; `to go` → *went*) would count as a miss. List them for your language's ~15 most used irregular verbs, keyed by concept id:

```json
{
 "to-be": ["è", "sono", "sei", "era", "stato", "fu"],
 "to-go": ["vado", "vai", "va", "vanno", "andato"]
}
```

- Lowercase, accents as written: a bold «e» never passes for «è».
- Only verbs in your wordlist; `bun test` checks every key.
- A regional variant inherits its base's file; for yourself, the file goes in `~/.lazy-polyglot/irregular/<code>.json`.

## Step 4f (optional) — `data/senses/<code>.json`

A wordlist gives each word one meaning, from its concept. Most words have more: Italian *carta* is paper, but also a map and a menu. List a word's other meanings so a learner who answers "map" is marked right, and so replies can use them once the main one is familiar. Keyed by concept id:

```json
{
  "paper": [
    { "id": "map", "use": "weave", "gloss": { "en": "map", "ru": "карта", "uz": "xarita" } },
    { "id": "menu", "use": "weave", "gloss": { "en": "menu", "ru": "меню", "uz": "menyu" } },
    { "id": "playing-card", "use": "accept", "gloss": { "en": "card", "ru": "карта (игральная)", "uz": "karta" } }
  ],
  "hour": [{ "id": "now", "use": "accept", "concept": "now" }]
}
```

- **`weave`**: an everyday meaning a learner meets in normal text. At most 2 per word. Shown next to the main meaning and woven once that is familiar.
- **`accept`**: a fair answer not worth teaching (a near-synonym, a rarer meaning). Graded right, never shown.
- **`concept`**: the meaning is another listed concept (Italian *ora* also means "now", which *adesso* teaches). No gloss needed; always `accept`. The validator tells you when a gloss collides with another concept.
- Glosses are short (1–3 words), in your own words, in the native languages the concepts have (`en`, `ru`, `uz`), never in the language itself. Leave a key out where that language uses one word for both meanings (Russian *язык* is language and tongue): a learner with no gloss in their language never sees the sense, which is right, because for them it is the same word. Leave out inflected forms, archaic, slang and vulgar meanings, and figurative uses that translate the same way.
- Be selective: most words get nothing. `scripts/sense-candidates.ts <code> <dir>` pulls candidate meanings from Wiktionary as raw material; don't copy its text (CC BY-SA).
- A regional variant inherits its base's file, except for the words it spells differently; give those their own entries in `data/senses/<variant>.json`. An entry there replaces the base's for that word, so a meaning that doesn't hold in the region goes too: Spanish *piso* = apartment is Spain only, and `es-419.json` lists piso without it (`[]` drops them all). For yourself, the file goes in `~/.lazy-polyglot/senses/<code>.json`.

## Step 5 — Validate

All three must pass; paste their output into your PR description:

```bash
bun tests/validate-wordlist.ts <code> --full   # every concept covered, shared words listed (for yourself: lazy-polyglot validate <code> --full)
bunx tsc --noEmit                              # typecheck
bun test                                       # unit tests
```

If `tsc` or `bun test` fail in files you never touched, that's a pre-existing repo issue, not yours: verify your two files aren't in the error output, report it in the PR, and continue — the wordlist validator passing is your gate.

## Step 6 — Second-model quality audit (strongly recommended)

Have a **different model or vendor** than the one that generated the list review it read-only. Prompt template:

> You are auditing a beginner-frequency wordlist for {Language} learners. Below are entries `conceptId: word`, each with the concept's English gloss and part of speech. Flag any entry that is: (a) a wrong translation for the glossed sense, (b) wrong part of speech, (c) a rare/unnatural choice where a more common everyday word exists, or (d) not the lemma/citation form. Output ONLY a list of `conceptId: current → suggested (one-line reason)`. Do not rewrite the file, do not comment on correct entries.

Apply the fixes you agree with, re-run Step 5, and note in the PR which findings you applied or rejected and why. (Precedent: the Portuguese list went through such an audit; 19 of 24 findings were applied.)

## Step 7 — Live smoke test

```bash
export LAZY_POLYGLOT_DIR=$(mktemp -d)
bun src/cli.ts init
bun src/cli.ts lang <code>
bun src/cli.ts instruction
```

Expect a `<lazy-polyglot>` block containing `word = gloss` pairs in your language. (The inflection example inside the block — "casas, bonitas" — is currently fixed Spanish wording regardless of language; that's expected.) Unset `LAZY_POLYGLOT_DIR` afterwards.

## Step 8 — PR checklist

- [ ] Files touched are exactly: `data/wordlists/<code>.json` and optionally `data/grammar/<code>.json`, `data/patterns/<code>.json`, `data/falseFriends/<code>.json`, `data/numbers/<code>.json`, `data/readings/<code>.json`, `data/irregular/<code>.json`
- [ ] Output of all three Step 5 commands pasted
- [ ] Audit summary: model used, findings applied/rejected
- [ ] Live smoke test output pasted
- [ ] Listed: shared words (rule 4), periphrastic forms (rule 6), count of <3-char recall-dead entries (rule 8)

## Adding a regional variant (pt-BR, pt-PT, es-MX, …)

Some learners want one regional standard specifically: Brazilian Portuguese says *trem* and *celular*, European Portuguese says *comboio* and *telemóvel*. A variant is **not** a full copy of the language. It is a small file holding only the words that differ from the base language; every other concept comes from the base.

- **Code**: BCP 47, `<base>-<REGION>` (`pt-BR`, `es-MX`, `es-419`). Case doesn't matter on the command line (`lang pt-br` works); the file name uses the canonical form, `pt-BR.json`. The name comes from `Intl.DisplayNames` ("Brazilian Portuguese"), nothing to register.
- **File**: `~/.lazy-polyglot/wordlists/pt-BR.json` for yourself, `data/wordlists/pt-BR.json` for a PR. The base (`pt`) must exist, bundled or local.
- **Content**: go through the base wordlist and add an entry only where the variant's everyday word differs. Rules 1–8 above apply to each entry. Don't copy a base word into the variant: the validator rejects entries identical to the base.
- **Grammar**: optional `data/grammar/pt-BR.json`, an overlay on the base's grammar. An item with a base `id` replaces that item, a new `id` is added. Give a regional item `baseExample` (the base's way of saying it), and it is taught first with a contrast: *ustedes trabajan (Spain: vosotros trabajáis)*. See `data/grammar/es-419.json`.
- **Word-building rules**: a variant uses its base's `data/patterns/` file; add `data/patterns/<code>.json` only for rules that differ.
- **Rude words**: if a base word is rude in the variant's region, add it to the base's `data/falseFriends/<base>.json` with `"vulgarIn": ["<code>"]`. The contrast then warns about it (*Spain: coger (vulgar in much of Latin America)*), and the tests fail if the variant ever teaches it.
- **Validate**: `lazy-polyglot validate pt-BR --full` (repo: `bun tests/validate-wordlist.ts pt-BR --full`). Duplicates and coverage are checked on the merged result, so a variant word that clashes with another base word is caught.
- **Audit**: run Step 6 on the variant entries plus the base entries you considered and kept. The question for the auditor is "is this what a speaker of that region says every day?"
- **Progress** is shared with the base for every word spelled the same, and for shared grammar and rules. Switching from `pt` to `pt-BR` keeps all of it; only the variant's own words and constructions start fresh, and they come first.

## Also possible: adding native-language glosses

Learners see translations in their own language via `config.native`. To support a new *native* language, add a `"<code>": "…"` key to the `gloss` object of every concept in `data/concepts.json` (keep `en` and existing keys). The same quality rules and audit flow apply; validate with `bun tests/validate-wordlist.ts`.

## FAQ / known limitations

- **Why at most 2 concepts per word?** Progress is kept per concept, but a recall of a shared word credits every concept that uses it. Two is a real homonym; more means the list is dodging the work.
- **Multi-token entries** are never counted by the prompt-recall scanner (it matches single tokens only) — another reason to prefer single words.
- **Words shorter than 3 characters** are never counted as recalls (noise filter).
- **Words that are also English** (Italian *via*, *fine*) count as a recall only in a sentence that isn't English. After changing a wordlist, rerun `bun scripts/homographs.ts` (macOS) to refresh `data/homographs.json`.
- **Case folding**: recall matching lowercases with default Unicode rules; store words pre-lowercased in your language's own convention (Turkish `İstanbul` → dotted lowercase `i̇stanbul` differs from `istanbul` — prefer the form users actually type).
