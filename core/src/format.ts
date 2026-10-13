/**
 * Whitespace has no visible glyph in a monospace font, so a miss on a space
 * looks like nothing happened. These are the standard ASCII "control picture"
 * characters: a typist reads ␣ as "that was a space" instantly.
 */
export function showChar(s: string): string {
  if (s === ' ') return '␣'
  if (s === '\n') return '↵'
  if (s === '\t') return '⇥'
  return s
}
