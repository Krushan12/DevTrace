import {
  backspace,
  buildDoc,
  CORRECT,
  createTrace,
  finalizeAll,
  isComplete,
  metrics,
  press,
  tabFill,
  topOffenders,
  WRONG,
} from './trace.js'
import { buildRuns } from './tokenize.js'
import { showChar } from './format.js'

let failures = 0
function ok(label: string, cond: boolean, detail = '') {
  if (!cond) {
    failures++
    console.log(`  FAIL  ${label} ${detail}`)
  } else {
    console.log(`  ok    ${label}`)
  }
}
function near(label: string, a: number, b: number, eps = 0.001) {
  ok(`${label} (${a.toFixed(3)} ~= ${b})`, Math.abs(a - b) < eps)
}

/** Types `text` at a fixed cadence so the numbers are deterministic. */
function typeAll(t: ReturnType<typeof createTrace>, str: string, step = 200) {
  let now = 1000
  for (const ch of str) {
    press(t, ch, now)
    now += step
  }
  return now
}

console.log('\n1. perfect run')
{
  const src = 'def f():\n    return 1\n'
  const t = createTrace(src)
  typeAll(t, src)
  ok('complete', isComplete(t))
  finalizeAll(t)
  const m = metrics(t)
  near('accuracy', m.accuracy, 1)
  ok('errors 0', m.errors === 0, `got ${m.errors}`)
  // 22 chars in 21 gaps of 200ms = 4.2s -> 22/5 per (4.2/60) min
  near('netWpm', m.netWpm, 22 / 5 / (4.2 / 60))
  ok('one indented line', m.indentLines === 1, `got ${m.indentLines}`)
  near('indentAccuracy', m.indentAccuracy, 1)
  ok('keystrokes logged', t.keystrokes.length === 22, `got ${t.keystrokes.length}`)
}

console.log('\n2. one bad indent char (substituted in place, no shift)')
{
  const src = 'def f():\n    return 1\n'
  const t = createTrace(src)
  const wrong = src.slice(0, 12) + 'x' + src.slice(13)
  ok('substitution is length-preserving', wrong.length === src.length)
  typeAll(t, wrong)
  finalizeAll(t)
  const m = metrics(t)
  near('accuracy', m.accuracy, 21 / 22)
  ok('1 error', m.errors === 1, `got ${m.errors}`)
  ok('indent miss', m.indentMisses === 1, `got ${m.indentMisses}`)
  near('indentAccuracy', m.indentAccuracy, 0)
}

console.log('\n3. backspace clears the error, but accuracy still counts it')
{
  const src = 'def f():\n    return 1\n'
  const t = createTrace(src)
  typeAll(t, src.slice(0, 12)) // through 3 of the 4 indent spaces
  ok('no errors so far', t.keystrokes.filter((k) => !k.ok).length === 0)
  press(t, 'x', 2000) // wrong char on the 4th indent space
  backspace(t, 2100)
  typeAll(t, src.slice(12)) // retype the rest correctly
  ok('complete', isComplete(t))
  finalizeAll(t)
  const m = metrics(t)
  ok('backspace logged', t.keystrokes.filter((k) => k.kind === 'back').length === 1)
  ok('1 backspace in metrics', m.backspaces === 1, `got ${m.backspaces}`)
  ok('1 error still counted', m.errors === 1, `got ${m.errors}`)
  near('accuracy = 22/23, the error is not forgiven', m.accuracy, 22 / 23)
  // The whole point: indentAccuracy reads final state, accuracy reads history.
  ok('indent is clean after the fix', m.indentMisses === 0, `got ${m.indentMisses}`)
  near('indentAccuracy', m.indentAccuracy, 1)
  ok('rawWpm >= netWpm', m.rawWpm >= m.netWpm)
}

console.log('\n4. tab stops')
{
  ok('empty line -> 4 spaces', tabFill('') === '    ')
  ok('col 4 -> 4 spaces', tabFill('def ') === '    ')
  ok('col 2 -> 2 spaces', tabFill('  ') === '  ')
  ok('col 7 -> 1 space', tabFill('       ') === ' ')
  ok('col 8 -> 4 spaces', tabFill('        ') === '    ')
}

console.log('\n5. doc indexing')
{
  const src = 'a\nbb\n\nccc'
  const d = buildDoc(src)
  ok('4 lines', d.lines.length === 4, `got ${d.lines.length}`)
  ok('starts', JSON.stringify(d.lineStarts) === '[0,2,5,6]', JSON.stringify(d.lineStarts))
  ok('lineOf[0]=0', d.lineOf[0] === 0)
  ok('lineOf[2]=1', d.lineOf[2] === 1)
  ok('lineOf[5]=2', d.lineOf[5] === 2)
  ok('lineOf[6]=3', d.lineOf[6] === 3)
  ok('indent lengths', JSON.stringify([...d.indentLen]) === '[0,0,0,0]')
  ok('indentedLines', d.indentedLines === 0)
}

console.log('\n6. empty input is safe')
{
  const t = createTrace('')
  ok('starts complete', isComplete(t))
  ok('press is a no-op', press(t, 'a', 1) === false)
  ok('backspace is a no-op', backspace(t, 1) === false)
  finalizeAll(t)
  const m = metrics(t)
  ok('no NaN in metrics', Object.values(m).every((v) => typeof v !== 'number' || !Number.isNaN(v)))
}

console.log('\n7. empty-line indent does not count')
{
  const src = 'x\n    y\n\nz'
  const d = buildDoc(src)
  ok('indentedLines counts only line 1', d.indentedLines === 1, `got ${d.indentedLines}`)
}

// ---------------------------------------------------------------------------
// Rendering. The rule under test: the source character is never replaced.
// ---------------------------------------------------------------------------

/** Everything that isn't the caret or an annotation is verbatim source text. */
const sourceOf = (runs: ReturnType<typeof buildRuns>) =>
  runs
    .filter((r) => !r.caret && !r.got)
    .map((r) => r.t)
    .join('')

console.log('\n8. a wrong keystroke keeps the source character')
{
  const src = 'ab'
  const t = createTrace(src)
  press(t, 'x', 1000) // wrong on 'a'
  const runs = buildRuns(src, t.states, 0, 1, t.wrongAt)

  ok('source text is intact', sourceOf(runs) === src, JSON.stringify(sourceOf(runs)))
  const srcRun = runs.find((r) => r.c === WRONG && !r.got)
  ok('source char "a" is rendered', srcRun?.t === 'a', `got ${JSON.stringify(srcRun?.t)}`)
  const ann = runs.find((r) => r.got)
  ok('what I pressed is annotated', ann?.t === 'x', `got ${JSON.stringify(ann?.t)}`)
  ok('annotation is not mistaken for source', sourceOf(runs).indexOf('x') === -1)
  ok('exactly one caret', runs.filter((r) => r.caret).length === 1)
}

console.log('\n9. a miss on a space keeps the space, annotates what I hit')
{
  const src = 'if x:'
  const t = createTrace(src)
  press(t, 'z', 1000) // wrong on 'i'
  press(t, 'f', 1200) // correct on 'f'
  press(t, 'q', 1400) // wrong on the space at index 2
  const runs = buildRuns(src, t.states, 0, 3, t.wrongAt)

  ok('source text is intact', sourceOf(runs) === src, JSON.stringify(sourceOf(runs)))
  ok('the space is still there', runs.some((r) => r.c === WRONG && !r.got && r.t === ' '))
  ok('annotated with what I pressed', runs.some((r) => r.got && r.t === 'q'))
  ok('showChar maps space to ␣', showChar(' ') === '␣')
  ok('showChar maps newline to ↵', showChar('\n') === '↵')
  ok('showChar maps tab to ⇥', showChar('\t') === '⇥')
  ok('showChar passes a letter through', showChar('a') === 'a')
}

console.log('\n10. correct runs still collapse (the perf property)')
{
  const src = 'return 1'
  const t = createTrace(src)
  typeAll(t, src)
  const runs = buildRuns(src, t.states, 0, src.length, t.wrongAt)
  ok('one span for 8 correct chars + caret', runs.length === 2, `got ${runs.length}`)
  ok('the span holds the whole line', runs[0]?.t === src)
  ok('typed run is CORRECT', runs[0]?.c === CORRECT)
}

console.log('\n11. exactly one caret at every position, errors present')
{
  const src = '  if x:\n\ty = 1'
  const t = createTrace(src)
  let now = 1000
  // A deliberately messy run: wrong chars, a correct space, a tab-as-␣ miss.
  for (const ch of ['q', ' ', 'Z', 'f', ' ', 'x', ':', '\n', '\t', 'y', ' ', '=', ' ', 'Q']) {
    press(t, ch, now)
    now += 50
  }
  const lineStart = t.doc.lineStarts[1] as number
  const line = (t.doc.lines[1] as string)

  let caretCounts = new Set<number>()
  let sourceOk = true
  for (let c = 0; c <= line.length; c++) {
    const runs = buildRuns(line, t.states, lineStart, c, t.wrongAt)
    caretCounts.add(runs.filter((r) => r.caret).length)
    if (sourceOf(runs) !== line) sourceOk = false
  }
  ok('one caret at every column', caretCounts.size === 1 && caretCounts.has(1), `counts: ${[...caretCounts]}`)
  ok('source text intact at every column', sourceOk)

  const none = buildRuns(line, t.states, lineStart, -1, t.wrongAt)
  ok('caretCol -1 emits no caret', none.filter((r) => r.caret).length === 0)
  ok('caretCol -1 marks no current char', none.filter((r) => r.cur).length === 0)
}

console.log('\n12. the current character is always marked')
{
  const src = 'hello'
  const t = createTrace(src)
  typeAll(t, 'hel')
  for (let c = 0; c < src.length; c++) {
    const runs = buildRuns(src, t.states, 0, c, t.wrongAt)
    const cur = runs.filter((r) => r.cur)
    ok(`  col ${c} has exactly one current run`, cur.length === 1, `got ${cur.length}`)
  }
  // Past the last character there is nothing under the caret, so nothing is
  // marked. The caret bar is the only indicator there, which is correct: the
  // next thing to type is Enter, not a character.
  const past = buildRuns(src, t.states, 0, src.length, t.wrongAt)
  ok('end of line marks no character', past.filter((r) => r.cur).length === 0)
  ok('end of line still places the caret', past.filter((r) => r.caret).length === 1)
}

console.log('\n13. backspace removes the annotation')
{
  const src = 'ab'
  const t = createTrace(src)
  press(t, 'x', 1000)
  ok('annotation present', t.wrongAt.get(0) === 'x')
  backspace(t, 1100)
  ok('annotation cleared', t.wrongAt.has(0) === false)
  press(t, 'a', 1200)
  ok('annotation stays cleared on a correct retype', t.wrongAt.size === 0)
  ok('no leftover got runs', buildRuns(src, t.states, 0, 1, t.wrongAt).filter((r) => r.got).length === 0)
}

console.log('\n14. a space keystroke round-trips through topOffenders')
{
  const src = 'a b'
  const t = createTrace(src)
  press(t, 'q', 1000) // expected 'a'
  press(t, 'x', 1200) // expected a SPACE
  press(t, 'b', 1400) // correct
  const off = topOffenders(t)
  const spaceMiss = off.find((o) => o.expected === ' ')
  ok('space miss is recorded', spaceMiss !== undefined)
  ok('its "got" is not empty', spaceMiss?.got === 'x', `got ${JSON.stringify(spaceMiss?.got)}`)
  ok('expected "a" miss intact', off.some((o) => o.expected === 'a' && o.got === 'q'))
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
