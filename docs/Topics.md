# Topics: the words for a real goal

Written for an AI agent (Claude Code, Codex, …); a person can follow it too. Following it end to end gives the learner a topic: the words and phrases they need for one goal, taught ahead of the usual frequency order.

## What a topic is

The core teaches ~450 everyday words, the most frequent first. A topic adds what one goal needs: a trip ("restaurants in Barcelona"), an exam ("DELE A2"), a move ("renting a flat in Rome"). Its entries come first in replies, cards and placement until the topic ends: on its date, or with `topic end`.

Limits: two topics run at once; a third needs the learner's yes (`--yes`); a fourth is refused until one ends.

## 1. Ask, only if the goal is vague

A specific request ("restaurants in Barcelona, by 20 November") needs no questions: go to step 2.

A vague one ("I'm going to Spain this year", "I have an exam") gets **one or two short questions, only those that change the list**:

- a trip: which city or region; roughly when; what you'll do there (eat out, rent, see a doctor, work);
- an exam: which exam and level; when.

Every question can be skipped. If the learner skips, build a sensible general set and say in one line what you assumed ("general Spain travel, no date").

## 2. Build the set

Write a JSON file anywhere (the learner's home folder is fine), named after the topic: `barcelona-restaurants.json`. The current language is the one `status` shows.

```json
{
  "title": "Barcelona restaurants",
  "lang": "es",
  "by": "2026-11-20",
  "context": { "place": "Barcelona", "when": "November", "purpose": "eating out" },
  "entries": [
    { "key": "bill", "target": "la cuenta", "kind": "word", "pos": "noun", "gloss": { "en": "the bill", "ru": "счёт" } },
    { "key": "bill_please", "target": "la cuenta, por favor", "kind": "phrase", "gloss": { "en": "the bill, please", "ru": "счёт, пожалуйста" } },
    { "key": "water", "target": "agua", "kind": "word", "conceptId": "water", "gloss": { "en": "water", "ru": "вода" } }
  ]
}
```

- **40–150 entries.** Fewer for a short trip, more for an exam. Order by usefulness: with a tight date, the first ones are the ones that fit.
- **Phrases count.** "la cuenta, por favor" is worth more on a trip than five nouns. A phrase is at most 40 characters.
- **`key`**: short, `a-z`, `0-9`, `_`, unique in the topic. Never change a key later: progress hangs on it.
- **`gloss`**: in the learner's language (`native` in `~/.lazy-polyglot/config.json`); add `en` too if it isn't English.
- **`conceptId`**: if the entry is a core word (check `data/concepts.json` and the language's wordlist), link it. The learner keeps the progress they already have on it, and nothing is taught twice.
- **`sense`** (with `conceptId`): when the topic needs a core word in another of its meanings, name that meaning's id from `data/senses/<lang>.json`. A trip topic links *carta* as `"conceptId": "paper", "sense": "menu"`, and replies use it as the menu from the start.
- **`by`** (optional): `YYYY-MM-DD`. **`context`** (optional): the learner's answers from step 1, so the set can be rebuilt or extended later.
- Use the web only where local usage matters (Catalonia, Argentina vs Madrid), never by default.

## 3. Add it

```
lazy-polyglot topic add barcelona-restaurants.json
```

In Claude Code the CLI is `${CLAUDE_PLUGIN_ROOT}/scripts/cli.sh`. The name comes from the file name (or `--name <name>`). The CLI validates the file and prints every problem; fix them and run it again. It also:

- checks the pace: at most 20 new entries a day before the date. If there are more, the first ones fit and the rest wait until those are started; it says so;
- asks for a yes when two topics already run: show the learner its message and add `--yes` only if they agree;
- suggests a higher level at levels 1–3 (topics crawl there) and changes nothing.

Show the learner the output in one or two lines. Adding the same name again replaces the set and keeps progress.

## Later

- `topic list`: every topic with progress (`23/62 passed (18 words, 5 phrases) · 41 days left`). `status` shows the running ones.
- `topic drop <name> <entry>`: remove one entry, by key or by the word itself.
- `topic end <name>`: stop it early. Its words go back to the normal order; what was learned stays.
- `topic delete <name>`: changed your mind? Removes the topic from the list for good. It asks first: show the learner its question and add `--yes` only if they agree. Progress on its words stays, and re-adding the same name brings it back.

Topics live in `~/.lazy-polyglot/topics/<lang>.<name>.json`, next to progress: they survive plugin updates, and `export` / `import` carry them to another machine.
