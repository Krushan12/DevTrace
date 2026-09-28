import { CORRECT, PENDING, WRONG, type CharState } from './trace.js'
import { showChar } from './format.js'

/**
 * Collapse a line's characters into runs of identical state. A 200-char line
 * becomes ~4 spans instead of 200, which is the difference between re-rendering
 * one line per keystroke and re-rendering the document.
 */
export interface Run {
  /** The text to draw. For a `got` run this is what you pressed, not the source. */
  t: string
  c: CharState
  /** This run annotates the key you pressed on a miss, rather than source text. */
  got?: true
  /** This run holds the character under the cursor. */
  cur?: boolean
  caret?: boolean
}

/**
 * The source character is never replaced. A run always carries the text from
 * the file; what you actually typed is emitted as an adjacent `got` run. That
 * is the whole point of the tracer — you type *on* the character, so the
 * character has to still be there afterwards.
 */
export function buildRuns(
  text: string,
  states: Uint8Array,
  off: number,
  /** Caret column, or -1 when this line doesn't hold the caret. */
  caretCol: number,
  wrongAt: Map<number, string>,
): Run[] {
  if (text.length === 0) return [{ t: ' ', c: PENDING, caret: true, cur: true }]

  const out: Run[] = []
  let caretPlaced = false
  const placeCaret = (col: number, c: CharState) => {
    if (col === caretCol && !caretPlaced) {
      out.push({ t: '', c, caret: true })
      caretPlaced = true
    }
  }

  let i = 0
  while (i < text.length) {
    placeCaret(i, states[off + i] as CharState)
    const st = states[off + i] as CharState

    let j = i + 1
    // Wrong runs deliberately do not collapse: each source character needs its
    // own annotation paired to it, and they need to stay separable.
    if (st !== WRONG) {
      while (j < text.length && states[off + j] === st) j++
    }

    if (st === WRONG) {
      for (let k = i; k < j; k++) {
        out.push({ t: text[k] as string, c: WRONG, cur: k === caretCol })
        const pressed = wrongAt.get(off + k)
        if (pressed !== undefined) {
          out.push({ t: showChar(pressed), c: WRONG, got: true })
        }
      }
    } else {
      const cut = caretCol > i && caretCol < j ? caretCol : j
      const tail = states[off + cut] as CharState
      out.push({ t: text.slice(i, cut), c: st, cur: i === caretCol })
      if (cut < j) {
        placeCaret(cut, tail)
        out.push({ t: text.slice(cut, j), c: tail, cur: true })
      }
    }
    i = j
  }

  placeCaret(text.length, PENDING)
  return out
}

export function stateClass(c: CharState): string {
  return c === CORRECT ? 'c' : c === WRONG ? 'w' : 'p'
}
