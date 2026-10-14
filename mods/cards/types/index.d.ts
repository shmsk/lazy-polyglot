export type CardDir = 'forward' | 'reverse'
export type CardKind = 'review' | 'placement'

/** One card as `lazy-polyglot cards next` returns it. */
export type Card = { id: string; kind: CardKind; dir: CardDir; prompt: string; reading?: string }

/** `lazy-polyglot cards status`, also carried by `next` and every answer. */
export type CardStatus = {
  lang: string
  /** The learner's language; missing from a CLI older than 0.9.4. */
  native?: string
  paused: boolean
  due: number
  known: number
  learning: number
  placementLeft: number
  total: number
  /** A learning word under the prompt: chosen on/off, or null = never asked (the done screen asks once). */
  statusLine?: boolean | null
  /** The way to the next milestone (`▓▓▓▓░ 87/100`), no longer drawn by the mod; null when milestones are off, missing from a CLI older than 0.9.15. */
  progress?: string | null
  /** Words being learned, most recently woven first; missing from a CLI older than 0.9.16. */
  words?: { target: string; gloss: string; reading?: string }[]
}

/** The hint line under the prompt: the learning words, the learned count, and which word shows now. */
export type HintLine = { words: { target: string; gloss: string; reading?: string }[]; known: number; total: number; index: number }

/** What an answer came to: the right answer is shown after a hit and a miss alike. */
export type CardResult = { ok: boolean; expected: string; step: number; due: string; known: boolean; undo?: { state: Record<string, unknown>; skipped: string[] }; also?: string[]; meant?: string }

/**
 * The pane's view. `card`: asking; `revealed`: a self-graded card shows its answer
 * (surfaces without a text field); `result`: graded; `done`: the round is over.
 */
export type CardsView =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'paused' }
  | { phase: 'empty'; status: CardStatus }
  | { phase: 'card' | 'revealed' | 'result' | 'done'; cards: Card[]; index: number; right: number; status: CardStatus; expected?: string; last?: CardResult; typed?: string }

declare module 'claude-code' {
  interface PluginState {
    'lazy-polyglot': { view: CardsView; hint: HintLine | null }
  }
}
