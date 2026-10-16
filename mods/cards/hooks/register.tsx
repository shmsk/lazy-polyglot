import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Card, CardResult, CardStatus, CardsView, HintLine } from '../types'
import { cardLangs, langTag } from './lang'
import { cardSvg, doneSvg } from './svg'
import { ask, hintText } from './text'

// The mod draws; the Lazy Polyglot CLI picks, grades and records every card
// (`lazy-polyglot cards ...`, JSON out), so progress lives in one place: ~/.lazy-polyglot.
const PANE = 'lazy-polyglot-cards'
const ROUND = 10
const view = atom({ plugin: 'lazy-polyglot', key: 'view' } as const, { phase: 'loading' } as CardsView)
// a word being learned and the learned count, dim at the end of the hint line under the prompt; null draws nothing
const hint = atom({ plugin: 'lazy-polyglot', key: 'hint' } as const, null as HintLine | null)

type Engine = EngineInterface

/** Where the Lazy Polyglot CLI is: an override, the lazy-polyglot plugin this mod ships in, a checkout, or the installed plugin. */
async function findCli($: Engine): Promise<string> {
  const exists = async (path: string) => {
    try {
      await $.fs.read(path)
      return true
    } catch {
      return false
    }
  }
  const root = $.plugin.root
  const override = (await $.env.get('LAZY_POLYGLOT_CLI')) || (await $.env.get('LANGCOUCH_CLI'))
  if (override) return override
  for (const local of [`${root}/scripts/cli.sh`, `${root}/../../scripts/cli.sh`])
    if (await exists(local)) return local
  const home = await $.env.get('HOME')
  if (home) {
    try {
      const installed = JSON.parse(await $.fs.read(`${home}/.claude/plugins/installed_plugins.json`)) as {
        plugins?: Record<string, { installPath?: string }[]>
      }
      for (const [name, entries] of Object.entries(installed.plugins ?? {}))
        if (name.startsWith('lazy-polyglot@') || name.startsWith('langcouch@'))
          for (const entry of entries)
            if (entry.installPath && (await exists(`${entry.installPath}/scripts/cli.sh`))) return `${entry.installPath}/scripts/cli.sh`
    } catch {
      // no plugin registry: fall through to the error below
    }
  }
  throw new Error('Lazy Polyglot is not installed. Install the lazy-polyglot plugin first (/plugin), or set LAZY_POLYGLOT_CLI to its scripts/cli.sh.')
}

// no type argument on the call: the directory reads `cards($, ...)` only in that plain form
async function cards($: Engine, args: string[]): Promise<unknown> {
  const cli = await findCli($)
  const { exitCode, stdout, stderr } = await $.process.run(['/bin/sh', cli, 'cards', ...args])
  if (exitCode !== 0) throw new Error(stderr.trim() || `lazy-polyglot cards ${args[0]} failed (exit ${exitCode})`)
  return JSON.parse(stdout) as unknown
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

async function showStatus($: Engine, status: CardStatus) {
  // opt-in: the space under the prompt is the user's, nothing shows there until they say yes.
  // Not $.ui.status: the terminal draws that as a yellow warning row.
  const show = status.statusLine === true && !status.paused && ((status.words?.length ?? 0) > 0 || status.known > 0)
  await update($, hint, (prev): HintLine | null => (show ? { words: status.words ?? [], known: status.known, total: status.total, index: prev?.index ?? 0 } : null))
}

async function refresh($: Engine) {
  try {
    const status = (await cards($, ['status'])) as CardStatus
    await showStatus($, status)
  } catch {
    // Lazy Polyglot missing or broken: /cards says why when opened
  }
}

async function start($: Engine) {
  await update($, view, (): CardsView => ({ phase: 'loading' }))
  try {
    const { status, cards: list } = (await cards($, ['next', String(ROUND)])) as { status: CardStatus; cards: Card[] }
    await showStatus($, status)
    await update($, view, (): CardsView => {
      if (status.paused) return { phase: 'paused' }
      if (list.length === 0) return { phase: 'empty', status }
      return { phase: 'card', cards: list, index: 0, right: 0, status }
    })
  } catch (err) {
    await update($, view, (): CardsView => ({ phase: 'error', message: message(err) }))
  }
}

/** Record a result (typed or self-graded) and move to the `result` phase. */
async function record($: Engine, args: string[], typed?: string) {
  const v = await read($, view)
  if (v.phase !== 'card' && v.phase !== 'revealed') return
  try {
    const res = (await cards($, args)) as CardResult & { status: CardStatus }
    const { status, ...last } = res
    await showStatus($, status)
    await update($, view, (): CardsView => ({ ...v, phase: 'result', last, status, typed, right: v.right + (last.ok ? 1 : 0) }))
  } catch (err) {
    await update($, view, (): CardsView => ({ phase: 'error', message: message(err) }))
  }
}

async function answer($: Engine, text: string) {
  const v = await read($, view)
  if (v.phase !== 'card') return
  const card = v.cards[v.index]!
  const typed = text.trim()
  await record($, ['answer', card.id, card.kind, card.dir, ...(typed ? [typed] : [])], typed || undefined)
}

/** "My answer was right": Lazy Polyglot takes the miss back and records the card as right (kid for child). */
async function accept($: Engine) {
  const v = await read($, view)
  if (v.phase !== 'result' || !v.last?.undo) return
  const card = v.cards[v.index]!
  try {
    const res = (await cards($, ['accept', card.id, card.kind, card.dir, JSON.stringify(v.last.undo)])) as CardResult & { status: CardStatus }
    const { status, ...last } = res
    await showStatus($, status)
    await update($, view, (): CardsView => ({ ...v, last, status, right: v.right + (last.ok ? 1 : 0) }))
  } catch (err) {
    await update($, view, (): CardsView => ({ phase: 'error', message: message(err) }))
  }
}

async function reveal($: Engine) {
  const v = await read($, view)
  if (v.phase !== 'card') return
  const card = v.cards[v.index]!
  try {
    const { expected } = (await cards($, ['reveal', card.id, card.dir])) as { expected: string }
    await update($, view, (): CardsView => ({ ...v, phase: 'revealed', expected }))
  } catch (err) {
    await update($, view, (): CardsView => ({ phase: 'error', message: message(err) }))
  }
}

async function grade($: Engine, ok: boolean) {
  const v = await read($, view)
  if (v.phase !== 'revealed') return
  const card = v.cards[v.index]!
  await record($, ['grade', card.id, card.kind, card.dir, ok ? 'ok' : 'fail'])
}

/** The once-only question on the done screen: show a learning word under the prompt? */
async function chooseStatusLine($: Engine, show: boolean) {
  try {
    const cli = await findCli($)
    const { exitCode, stderr } = await $.process.run(['/bin/sh', cli, 'cards-status', show ? 'on' : 'off'])
    if (exitCode !== 0) throw new Error(stderr.trim() || 'lazy-polyglot cards-status failed')
    const status = (await cards($, ['status'])) as CardStatus
    await showStatus($, status)
    await update($, view, (v): CardsView => (v.phase === 'done' ? { ...v, status } : v))
  } catch (err) {
    await update($, view, (): CardsView => ({ phase: 'error', message: message(err) }))
  }
}

async function advance($: Engine) {
  await update($, view, (v): CardsView => {
    if (v.phase !== 'result') return v
    const index = v.index + 1
    return index < v.cards.length ? { ...v, phase: 'card', index, last: undefined, expected: undefined } : { ...v, phase: 'done' }
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'cards', description: 'Review Lazy Polyglot words as flashcards (due words first, then placement)' })
    void refresh($)
    return next(e)
  })

  // a new word each message; the list itself follows what the replies wove
  on('prompt.submit', async ($, e, next) => {
    await update($, hint, (h): HintLine | null => (h ? { ...h, index: h.index + 1 } : h))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    void refresh($)
    return next(e)
  })

  // the engine keeps its own hint line and draws the tail dim after it: `? for shortcuts  ·  cucina = кухня  ·  5 of 451 learned`
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const h = await read($, hint)
    return h ? next({ ...e, props: { ...e.props, tail: `  ·  ${hintText(h)}` } }) : next(e)
  })

  on('command.run', { command: 'cards' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Lazy Polyglot cards', focus: true, closeOnEscape: true })
    void start($)
    return { text: 'Lazy Polyglot cards opened. Esc closes them.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = e.surface === 'mobile' ? undefined : $.ui.resolve(e).Input
    // desktop, VS Code and mobile draw SVG: there the card looks like a flashcard app
    const Svg = e.surface === 'terminal' ? undefined : $.ui.resolve(e).Svg
    const v = await read($, view)
    const close = () => void $.ui.close({ id: PANE })

    if (v.phase === 'loading') return <Text dimColor>Loading cards…</Text>
    if (v.phase === 'error')
      return (
        <Box flexDirection="column">
          <Text>Cards could not load: {v.message}</Text>
          <Button key="retry" variant="primary" autoFocus onPress={() => void start($)}>Try again</Button>
        </Box>
      )
    if (v.phase === 'paused')
      return (
        <Box flexDirection="column">
          <Text>Lazy Polyglot is paused. /lazy-polyglot:resume turns it back on.</Text>
          <Button key="close" role="dismiss" autoFocus onPress={close}>Close</Button>
        </Box>
      )
    if (v.phase === 'empty')
      return (
        <Box flexDirection="column">
          <Text>Nothing to review right now: {v.status.known} of {v.status.total} words known.</Text>
          <Text dimColor>Words come back here when they are due.</Text>
          <Button key="close" role="dismiss" autoFocus onPress={close}>Close</Button>
        </Box>
      )
    const statusQuestion = v.phase === 'done' && v.status.statusLine === null && (
      <Box flexDirection="column">
        <Text>Show a word you're learning under the prompt? You can change it later: /lazy-polyglot:cards-status</Text>
        <Box flexDirection="row" gap={1}>
          <Button key="statusYes" onPress={() => void chooseStatusLine($, true)}>Yes, show it</Button>
          <Button key="statusNo" onPress={() => void chooseStatusLine($, false)}>No</Button>
        </Box>
      </Box>
    )

    if (Svg) {
      if (v.phase === 'done')
        return (
          <Box flexDirection="column" gap={1}>
            <Svg
              source={doneSvg({ right: v.right, total: v.cards.length, due: v.status.due, known: v.status.known, left: v.status.placementLeft })}
              alt={`Round done: ${v.right} of ${v.cards.length} right. ${v.status.due} due, ${v.status.known} known, ${v.status.placementLeft} left to place.`}
            />
            {statusQuestion}
            <Box flexDirection="row" gap={1}>
              <Button key="again" variant="primary" autoFocus onPress={() => void start($)}>Another round</Button>
              <Button key="close" role="dismiss" onPress={close}>Close</Button>
            </Box>
          </Box>
        )
      const card = v.cards[v.index]!
      const ask_ = ask(card, v.status.lang)
      const back =
        v.phase === 'result' ? { expected: v.last!.expected, ok: v.last!.ok, typed: v.typed } : v.phase === 'revealed' ? { expected: v.expected ?? '' } : undefined
      const face = (
        <Svg
          source={cardSvg({ kind: card.kind, index: v.index, total: v.cards.length, lang: v.status.lang, promptLang: cardLangs(card, v.status.lang, v.status.native).prompt, prompt: card.prompt, reading: card.reading, ask: ask_, answer: back })}
          alt={[`${card.kind === 'placement' ? 'Placement' : 'Review'} ${v.index + 1} of ${v.cards.length}: ${card.prompt}. ${ask_}`, back && `${back.ok === undefined ? '' : back.ok ? 'Right: ' : 'Wrong: '}${back.expected}`].filter(Boolean).join(' ')}
        />
      )
      if (v.phase === 'result') {
        const last = v.last!
        return (
          <Box flexDirection="column" gap={1}>
            {face}
            {last.meant && <Text dimColor>Right: {last.meant} is another meaning of this word.</Text>}
            {last.also && <Text dimColor>Also means: {last.also.join(', ')}</Text>}
            {last.known && card.kind === 'placement' && <Text dimColor>Marked known: it skips the new-word stage.</Text>}
            <Box flexDirection="row" gap={1}>
              <Button key="next" variant="primary" autoFocus onPress={() => void advance($)}>
                {v.index + 1 < v.cards.length ? 'Next' : 'Finish'}
              </Button>
              {!last.ok && v.typed && last.undo && (
                <Button key="accept" onPress={() => void accept($)}>My answer was right</Button>
              )}
            </Box>
          </Box>
        )
      }
      if (v.phase === 'revealed')
        return (
          <Box flexDirection="column" gap={1}>
            {face}
            <Box flexDirection="row" gap={1}>
              <Button key="didnt" hotkey="1" onPress={() => void grade($, false)}>Didn't</Button>
              <Button key="knew" hotkey="2" variant="primary" autoFocus onPress={() => void grade($, true)}>Knew it</Button>
            </Box>
          </Box>
        )
      return (
        <Box flexDirection="column" gap={1}>
          {face}
          {Input ? (
            <Box flexDirection="column" gap={1}>
              <Input key="answer" placeholder="Type the answer, Enter to check" submitLabel="check" autoFocus onSubmit={text => void answer($, text)} />
              <Button key="dontknow" dimColor onPress={() => void answer($, '')}>Don't know</Button>
            </Box>
          ) : (
            <Button key="show" variant="primary" autoFocus onPress={() => void reveal($)}>Show answer</Button>
          )}
        </Box>
      )
    }

    if (v.phase === 'done')
      return (
        <Box flexDirection="column">
          <Text bold>Round done: {v.right} of {v.cards.length} right.</Text>
          <Text dimColor>
            {v.status.due} due · {v.status.known} known · {v.status.placementLeft} left to place
          </Text>
          {v.status.statusLine === null && (
            <Box flexDirection="column">
              <Text>Show a word you're learning under the prompt? You can change it later: /lazy-polyglot:cards-status</Text>
              <Box flexDirection="row" gap={1}>
                <Button key="statusYes" onPress={() => void chooseStatusLine($, true)}>Yes, show it</Button>
                <Button key="statusNo" onPress={() => void chooseStatusLine($, false)}>No</Button>
              </Box>
            </Box>
          )}
          <Box flexDirection="row" gap={1}>
            <Button key="again" variant="primary" autoFocus onPress={() => void start($)}>Another round</Button>
            <Button key="close" role="dismiss" onPress={close}>Close</Button>
          </Box>
        </Box>
      )

    const card = v.cards[v.index]!
    const header = (
      <Text dimColor>
        {card.kind === 'placement' ? 'Placement' : 'Review'} · {v.index + 1}/{v.cards.length} · {v.status.lang}
      </Text>
    )
    const langs = cardLangs(card, v.status.lang, v.status.native)
    // The word led by its flag, its language named after it: 🇮🇹 casa Italiano
    const promptTag = langs.prompt ? langTag(langs.prompt) : undefined
    const prompt = promptTag ? (
      <Box flexDirection="row" gap={1}>
        <Text>{promptTag.flag}</Text>
        <Text bold>{card.prompt}</Text>
        {card.reading ? <Text dimColor>[{card.reading}]</Text> : null}
        <Text dimColor>{promptTag.name}</Text>
      </Box>
    ) : (
      <Text bold>
        {card.prompt}
        {card.reading ? <Text dimColor> [{card.reading}]</Text> : null}
      </Text>
    )
    // The answer with its language after it: ✓ дом 🇷🇺 Русский
    const answerTag = langs.answer ? langTag(langs.answer) : undefined
    const answerLine = (line: JSX.Element) =>
      answerTag ? (
        <Box flexDirection="row" gap={1}>
          {line}
          <Text dimColor>{`${answerTag.flag} ${answerTag.name}`}</Text>
        </Box>
      ) : (
        line
      )

    if (v.phase === 'result') {
      const last = v.last!
      return (
        <Box flexDirection="column">
          {header}
          {prompt}
          {answerLine(<Text>{last.ok ? `✓ ${last.expected}` : `✗ ${last.expected}`}</Text>)}
          {!last.ok && v.typed && <Text dimColor>Your answer: {v.typed}</Text>}
          {last.meant && <Text dimColor>Right: {last.meant} is another meaning of this word.</Text>}
          {last.also && <Text dimColor>Also means: {last.also.join(', ')}</Text>}
          {last.known && card.kind === 'placement' && <Text dimColor>Marked known: it skips the new-word stage.</Text>}
          <Box flexDirection="row" gap={1}>
            <Button key="next" variant="primary" autoFocus onPress={() => void advance($)}>
              {v.index + 1 < v.cards.length ? 'Next' : 'Finish'}
            </Button>
            {!last.ok && v.typed && last.undo && (
              <Button key="accept" onPress={() => void accept($)}>My answer was right</Button>
            )}
          </Box>
        </Box>
      )
    }

    if (v.phase === 'revealed')
      return (
        <Box flexDirection="column">
          {header}
          {prompt}
          {answerLine(<Text>= {v.expected}</Text>)}
          <Box flexDirection="row" gap={1}>
            <Button key="knew" variant="primary" onPress={() => void grade($, true)}>Knew it</Button>
            <Button key="didnt" onPress={() => void grade($, false)}>Didn't</Button>
          </Box>
        </Box>
      )

    return (
      <Box flexDirection="column">
        {header}
        {prompt}
        <Text dimColor>{ask(card, v.status.lang)}</Text>
        {Input ? (
          <Box flexDirection="column">
            <Input key="answer" placeholder="Enter on empty = don't know" submitLabel="check" autoFocus onSubmit={text => void answer($, text)} />
            <Button key="dontknow" dimColor onPress={() => void answer($, '')}>Don't know</Button>
          </Box>
        ) : (
          <Button key="show" variant="primary" onPress={() => void reveal($)}>Show answer</Button>
        )}
      </Box>
    )
  })
}
