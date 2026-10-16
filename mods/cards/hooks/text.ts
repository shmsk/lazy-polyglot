// Plain strings the mod draws. They live here, not in register.tsx: the plugin directory reads
// a `${` in a function without $ as a stray use of the capability object.

import type { Card, HintLine } from '../types'

/** `cucina = кухня  ·  5 of 451 learned`: the word at `index`, round and round. */
export function hintText(h: HintLine): string {
  const w = h.words.length > 0 ? h.words[h.index % h.words.length]! : undefined
  const word = w && `${w.target}${w.reading ? ` [${w.reading}]` : ''} = ${w.gloss}`
  return [word, `${h.known} of ${h.total} learned`].filter(Boolean).join('  ·  ')
}

/** The question under a card's word. */
export function ask(card: Card, lang: string): string {
  return card.kind === 'placement' ? 'Do you know this one? Translate it.' : card.dir === 'reverse' ? `In ${lang}?` : 'Translate:'
}
