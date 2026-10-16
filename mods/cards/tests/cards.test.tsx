import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'
import { cardSvg, esc, fitSize } from '../hooks/svg'
import { langTag } from '../hooks/lang'
import { hintText } from '../hooks/text'

// A stand-in for `lazy-polyglot cards ...`: two cards, a forward review and a reverse one.
const BASE = { lang: 'it', paused: false, due: 2, known: 10, learning: 3, placementLeft: 40, total: 432, words: [{ target: 'casa', gloss: 'дом' }, { target: 'tempo', gloss: 'время', reading: 'темпо' }] }
const CARDS = [
  { id: 'house', kind: 'review', dir: 'forward', prompt: 'casa' },
  { id: 'time', kind: 'review', dir: 'reverse', prompt: 'время' },
]
const EXPECTED: Record<string, string> = { house: 'дом', time: 'tempo' }

function fakeCli(on: On, { paused = false, statusLine = null as boolean | null, native = 'ru' as string | null } = {}) {
  const calls: string[][] = []
  surfaceStubs(on)
  mock.env(on, { LAZY_POLYGLOT_CLI: '/fake/cli.sh' })
  on('process.run', async (_$, e) => {
    if (e.argv[2] === 'cards-status') {
      calls.push(e.argv.slice(2))
      statusLine = e.argv[3] === 'on'
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const STATUS = { ...BASE, statusLine, ...(native ? { native } : {}) }
    const args = e.argv.slice(3) // /bin/sh <cli> cards ...
    calls.push(args)
    const [sub, id = '', , , ...rest] = args
    const json = (v: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify(v), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (sub === 'status') return json({ ...STATUS, paused })
    if (sub === 'next') return json({ status: { ...STATUS, paused }, cards: paused ? [] : CARDS })
    if (sub === 'reveal') return json({ expected: EXPECTED[id] })
    if (sub === 'accept') return json({ ok: true, expected: EXPECTED[id], step: 2, due: '', known: false, status: { ...STATUS, due: STATUS.due - 1 } })
    const ok = sub === 'grade' ? rest[0] === 'ok' : rest.join(' ') === EXPECTED[id]
    return json({ ok, expected: EXPECTED[id], step: ok ? 2 : 0, due: '', known: false, ...(ok ? {} : { undo: { state: { [id]: null }, skipped: [] } }), status: { ...STATUS, due: STATUS.due - 1 } })
  })
  return calls
}

const tails: (string | undefined)[] = []
function surfaceStubs(on: On) {
  // beneath the plugin, where the engine would draw the line: what tail reached it
  on('ui.render', { component: 'PromptHint' }, async ($, e) => {
    tails.push(e.props.tail)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{e.props.hint}</Text>
  })
  on('ui.open', async () => ({ value: { isPlaced: true } as const }))
  on('ui.close', async () => ({ value: undefined }))
}
// the hint line under the prompt as the mod leaves it: its `tail`, or nothing
const HINT = { isDraft: false, isWorking: false, hint: '? for shortcuts' } as const
const hintTail = async ($: Engine) => {
  tails.length = 0
  const ui = await $.ui.mount({ plugin: 'lazy-polyglot', surface: 'terminal', component: 'PromptHint', props: HINT })
  await ui.unmount()
  return tails.at(-1)
}

const PROPS = { title: 'Lazy Polyglot cards', isFocused: true, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} } as const
const mountOn = async <S extends RenderSurface>($: Engine, surface: S) => {
  await $.command.run({ command: 'cards', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  return $.ui.mount({ plugin: 'lazy-polyglot', surface, component: 'Pane', requestId: 'lazy-polyglot-cards', props: PROPS })
}

describe('typed answers', () => {
  for (const surface of ['terminal'] as const)
    test(`${surface}: a right answer, then don't know, then the round summary`, async ($, on) => {
      const calls = fakeCli(on)
      const ui = await mountOn($, surface)
      expect(await ui.find({ type: 'Text', text: 'casa' })).toBeDefined()
      await ui.input({ key: 'answer', text: 'дом' })
      expect(await ui.find({ text: '✓ дом' })).toBeDefined()
      await ui.press({ key: 'next' })
      expect(await ui.find({ text: 'In it?' })).toBeDefined()
      await ui.press({ key: 'dontknow' })
      expect(await ui.find({ text: '✗ tempo' })).toBeDefined()
      expect(calls).toContainEqual(['answer', 'house', 'review', 'forward', 'дом'])
      expect(calls).toContainEqual(['answer', 'time', 'review', 'reverse'])
      await ui.press({ key: 'next' })
      expect(await ui.find({ text: /Round done: 1 of 2 right/ })).toBeDefined()
    })
})

test('"my answer was right" turns a miss into a hit: kid for child', async ($, on) => {
  const calls = fakeCli(on)
  const ui = await mountOn($, 'terminal')
  await ui.input({ key: 'answer', text: 'жилище' })
  expect(await ui.find({ text: '✗ дом' })).toBeDefined()
  expect(await ui.find({ text: /Your answer: жилище/ })).toBeDefined()
  await ui.press({ key: 'accept' })
  expect(await ui.find({ text: '✓ дом' })).toBeDefined()
  expect(await ui.find({ key: 'accept' })).toBeUndefined()
  expect(calls).toContainEqual(['accept', 'house', 'review', 'forward', JSON.stringify({ state: { house: null }, skipped: [] })])
  await ui.press({ key: 'next' })
  await ui.press({ key: 'dontknow' })
  expect(await ui.find({ key: 'accept' })).toBeUndefined() // nothing typed, nothing to overrule
  await ui.press({ key: 'next' })
  expect(await ui.find({ text: /Round done: 1 of 2 right/ })).toBeDefined()
})

describe('status line is opt-in', () => {
  test('never asked: no count in the status line, the done screen asks once; yes turns it on', async ($, on) => {
    const calls = fakeCli(on)
    const ui = await mountOn($, 'terminal')
    await ui.press({ key: 'dontknow' })
    await ui.press({ key: 'next' })
    await ui.press({ key: 'dontknow' })
    await ui.press({ key: 'next' })
    expect(await ui.find({ text: /Round done/ })).toBeDefined()
    expect(await hintTail($)).toBeUndefined()
    expect(await ui.find({ text: /Show a word you're learning under the prompt/ })).toBeDefined()
    await ui.press({ key: 'statusYes' })
    expect(calls).toContainEqual(['cards-status', 'on'])
    expect(await hintTail($)).toBe('  ·  casa = дом  ·  10 of 432 learned')
    expect(await ui.find({ key: 'statusYes' })).toBeUndefined()
  })

  test('chosen off: no count and no question', async ($, on) => {
    fakeCli(on, { statusLine: false })
    const ui = await mountOn($, 'terminal')
    for (let i = 0; i < 2; i++) {
      await ui.press({ key: 'dontknow' })
      await ui.press({ key: 'next' })
    }
    expect(await ui.find({ text: /Round done/ })).toBeDefined()
    expect(await ui.find({ key: 'statusYes' })).toBeUndefined()
    expect(await hintTail($)).toBeUndefined()
  })

  test('chosen on: the count shows', async ($, on) => {
    fakeCli(on, { statusLine: true })
    await mountOn($, 'terminal')
    expect(await hintTail($)).toBe('  ·  casa = дом  ·  10 of 432 learned')
  })
})

// desktop, VS Code and mobile draw the card as SVG: the word big, the answer under a rule
const card = async (ui: { find: (q: { type: string }) => Promise<{ props: Record<string, unknown> } | undefined> }) => {
  const svg = await ui.find({ type: 'Svg' })
  return { alt: String(svg?.props.alt ?? ''), source: String(svg?.props.source ?? '') }
}

describe('flashcard on rich surfaces', () => {
  for (const surface of ['desktop', 'vscode'] as const)
    test(`${surface}: a right answer, then don't know, then the score ring`, async ($, on) => {
      const calls = fakeCli(on)
      const ui = await mountOn($, surface)
      await ui.drawn() // rejects if the surface refused the tree
      expect((await card(ui)).alt).toBe('Review 1 of 2: casa. Translate:')
      expect((await card(ui)).source).toContain('>casa</text>')
      expect(await ui.find({ type: 'Text', text: 'casa' })).toBeUndefined() // the word is on the card, not repeated
      await ui.input({ key: 'answer', text: 'дом' })
      expect((await card(ui)).alt).toContain('Right: дом')
      expect((await card(ui)).source).toContain('✓ дом')
      await ui.press({ key: 'next' })
      expect((await card(ui)).alt).toContain('In it?')
      await ui.press({ key: 'dontknow' })
      expect((await card(ui)).alt).toContain('Wrong: tempo')
      expect(calls).toContainEqual(['answer', 'house', 'review', 'forward', 'дом'])
      await ui.press({ key: 'next' })
      await ui.drawn()
      expect((await card(ui)).alt).toMatch(/Round done: 1 of 2 right/)
      expect((await card(ui)).source).toContain('stroke-dasharray')
      expect(await ui.find({ key: 'statusYes' })).toBeDefined() // the once-only question is still asked
    })

  test('a wrong typed answer shows what you wrote and keeps "my answer was right"', async ($, on) => {
    fakeCli(on)
    const ui = await mountOn($, 'desktop')
    await ui.input({ key: 'answer', text: 'жилище' })
    expect((await card(ui)).source).toContain('you wrote: жилище')
    expect(await ui.find({ key: 'accept' })).toBeDefined()
  })
})

test('mobile: no text field, the answer is shown and self-graded with hotkeys', async ($, on) => {
  const calls = fakeCli(on)
  const ui = await mountOn($, 'mobile')
  await ui.drawn()
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  await ui.press({ key: 'show' })
  expect((await card(ui)).alt).toMatch(/casa\. Translate: дом$/)
  expect((await ui.find({ key: 'didnt' }))?.props.hotkey).toBe('1')
  expect((await ui.find({ key: 'knew' }))?.props.hotkey).toBe('2')
  await ui.press({ key: 'knew' })
  expect((await card(ui)).alt).toContain('Right: дом')
  expect(calls).toContainEqual(['grade', 'house', 'review', 'forward', 'ok'])
})

test('the SVG escapes words and shrinks long ones', () => {
  const svg = cardSvg({ kind: 'review', index: 0, total: 1, lang: 'it', prompt: `<b>&"x"'`, ask: 'Translate:', answer: { expected: 'a < b', ok: true } })
  expect(svg).toContain('&lt;b&gt;&amp;&quot;x&quot;&#39;')
  expect(svg).not.toContain('<b>')
  expect(svg).toContain('✓ a &lt; b')
  expect(esc('plain')).toBe('plain')
  expect(fitSize('casa', 280, 40, 16)).toBe(40)
  expect(fitSize('precipitevolissimevolmente', 280, 40, 16)).toBeLessThan(20)
  expect(fitSize('x'.repeat(200), 280, 40, 16)).toBe(16)
})

test('paused Lazy Polyglot shows the pause, not cards', async ($, on) => {
  fakeCli(on, { paused: true })
  const ui = await mountOn($, 'terminal')
  expect(await ui.find({ text: /paused/ })).toBeDefined()
  expect(await ui.find({ key: 'answer' })).toBeUndefined()
})

test('a failing CLI is an error with a retry, not a blank pane', async ($, on) => {
  surfaceStubs(on)
  mock.env(on, { LAZY_POLYGLOT_CLI: '/fake/cli.sh' })
  on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: 'boom', isStdoutTruncated: false, isStderrTruncated: false } }))
  const ui = await mountOn($, 'terminal')
  expect(await ui.find({ text: /could not load: boom/ })).toBeDefined()
  expect(await ui.find({ key: 'retry' })).toBeDefined()
})

test('the old LANGCOUCH_CLI name still points at the CLI', async ($, on) => {
  surfaceStubs(on)
  mock.env(on, { LANGCOUCH_CLI: '/old/cli.sh' })
  const clis: string[] = []
  on('process.run', async (_$, e) => {
    clis.push(e.argv[1])
    return { value: { exitCode: 1, stdout: '', stderr: 'boom', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const ui = await mountOn($, 'terminal')
  expect(await ui.find({ text: /could not load: boom/ })).toBeDefined()
  expect(clis).toContain('/old/cli.sh')
})

describe('each word shows its language: flag and name', () => {
  test('terminal: the Italian word, then the Russian one on the reverse card', async ($, on) => {
    fakeCli(on)
    const ui = await mountOn($, 'terminal')
    expect(await ui.find({ type: 'Text', text: '🇮🇹' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Italiano' })).toBeDefined()
    await ui.input({ key: 'answer', text: 'дом' })
    expect(await ui.find({ text: '✓ дом' })).toBeDefined()
    expect(await ui.find({ text: '🇷🇺 Русский' })).toBeDefined()
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: '🇷🇺' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Русский' })).toBeDefined()
    await ui.press({ key: 'dontknow' })
    expect(await ui.find({ text: '🇮🇹 Italiano' })).toBeDefined()
  })

  test('an older CLI without native: the Russian side has no tag, the Italian one keeps it', async ($, on) => {
    fakeCli(on, { native: null })
    const ui = await mountOn($, 'terminal')
    expect(await ui.find({ type: 'Text', text: 'Italiano' })).toBeDefined()
    await ui.input({ key: 'answer', text: 'дом' })
    expect(await ui.find({ text: /Русский/ })).toBeUndefined()
  })

  test('names: exact code, then base, then a globe', () => {
    expect(langTag('pt-BR')).toEqual({ flag: '🇧🇷', name: 'Português (Brasil)' })
    expect(langTag('pt').name).toBe('Português')
    expect(langTag('es-419').flag).toBe('🇲🇽')
    expect(langTag('en-AU').name).toBe('English')
    expect(langTag('xx')).toEqual({ flag: '🌐', name: 'xx' })
  })

  test('SVG: the corner names the prompt language', () => {
    const face = { kind: 'review', index: 0, total: 1, lang: 'it', prompt: 'время', ask: 'In it?' } as const
    expect(cardSvg({ ...face, promptLang: 'ru' })).toContain('🇷🇺 РУССКИЙ')
    expect(cardSvg({ ...face, promptLang: 'it' })).toContain('🇮🇹 ITALIANO')
    expect(cardSvg(face)).toContain('>IT<')
  })
})

test('the hint line: a new word each message, round and round; the count alone when no word is in progress', () => {
  const h = { words: [{ target: 'casa', gloss: 'дом' }, { target: 'tempo', gloss: 'время', reading: 'темпо' }], known: 5, total: 451, index: 0 }
  expect(hintText(h)).toBe('casa = дом  ·  5 of 451 learned')
  expect(hintText({ ...h, index: 1 })).toBe('tempo [темпо] = время  ·  5 of 451 learned')
  expect(hintText({ ...h, index: 2 })).toBe('casa = дом  ·  5 of 451 learned')
  expect(hintText({ ...h, words: [] })).toBe('5 of 451 learned')
})
