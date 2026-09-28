import { memo } from 'react'
import { buildRuns, stateClass } from '../lib/tokenize.js'
import type { CharState } from '../lib/trace.js'

interface LineProps {
  text: string
  off: number
  states: Uint8Array
  wrongAt: Map<number, string>
  num: number
  isCur: boolean
  /** Column of the caret, or -1 when this line doesn't hold it. */
  caret: number
  /** Bumped whenever this line's character states change. Drives the memo. */
  v: number
}

/**
 * Memoized on (v, isCur, caret). `states` and `wrongAt` are stable mutable
 * refs, so the shallow compare is honest: lines you aren't touching never
 * re-render, and a keystroke costs two line updates instead of one per line in
 * the file.
 */
const Line = memo(function Line({
  text,
  off,
  states,
  wrongAt,
  num,
  isCur,
  caret,
  v,
}: LineProps) {
  const runs = buildRuns(text, states, off, isCur ? caret : -1, wrongAt)
  void v
  return (
    <div className={isCur ? 'ln cur' : 'ln'}>
      <span className="lnum">{num}</span>
      <span className="lcode">
        {runs.map((r, i) => {
          if (r.caret) return <i key={i} className="caret" />
          const cls = r.got ? 'g' : stateClass(r.c as CharState) + (r.cur ? ' curc' : '')
          return (
            <span key={i} className={cls}>
              {r.t}
            </span>
          )
        })}
      </span>
    </div>
  )
})

export interface SourceViewProps {
  lines: string[]
  lineStarts: number[]
  states: Uint8Array
  wrongAt: Map<number, string>
  versions: Uint32Array
  cursor: number
  lineOf: Uint32Array
  scrollerRef: React.RefObject<HTMLDivElement | null>
}

export default function SourceView({
  lines,
  lineStarts,
  states,
  wrongAt,
  versions,
  cursor,
  lineOf,
  scrollerRef,
}: SourceViewProps) {
  const curLine = cursor < lineOf.length ? (lineOf[cursor] as number) : lines.length - 1
  const caretCol = cursor - (lineStarts[curLine] ?? 0)

  return (
    <div className="source" ref={scrollerRef}>
      {lines.map((text, li) => (
        <Line
          key={li}
          text={text}
          off={lineStarts[li] as number}
          states={states}
          wrongAt={wrongAt}
          num={li + 1}
          isCur={li === curLine}
          caret={caretCol}
          v={versions[li] as number}
        />
      ))}
    </div>
  )
}
