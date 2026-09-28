import { useCallback, useEffect, useRef, useState } from 'react'
import RepoPicker from './components/RepoPicker.js'
import FileList, { type RepoFile } from './components/FileList.js'
import SourceView from './components/SourceView.js'
import Results from './components/Results.js'
import {
  backspace,
  createTrace,
  finalizeAll,
  isComplete,
  metrics,
  press,
  tabFill,
  type Metrics,
  type Trace,
} from './lib/trace.js'
import { initAudio, isMuted, playClick, playComplete, setMuted } from './lib/click.js'

type Screen = 'pick' | 'browse' | 'trace' | 'done'

const RECENTS_KEY = 'devtrace.recents'

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY)
    const arr: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string').slice(0, 8) : []
  } catch {
    return []
  }
}

/** A chunk that starts or ends on a blank line is pure friction. */
function trimForTyping(text: string): string {
  return text.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '')
}

function lineAt(t: Trace, off: number): number {
  if (t.doc.text.length === 0) return 0
  const o = Math.max(0, Math.min(off, t.doc.text.length - 1))
  return t.doc.lineOf[o] as number
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('pick')
  const [root, setRoot] = useState('')
  const [repoName, setRepoName] = useState('')
  const [files, setFiles] = useState<RepoFile[]>([])
  const [recents, setRecents] = useState<string[]>(loadRecents)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [chunkLabel, setChunkLabel] = useState('')
  const [final, setFinal] = useState<Metrics | null>(null)
  const [muted, setMutedState] = useState(isMuted())
  const [tick, setTick] = useState(0)

  const traceRef = useRef<Trace | null>(null)
  const finalRef = useRef<Metrics | null>(null)
  const textRef = useRef('')
  const scrollerRef = useRef<HTMLDivElement | null>(null)

  // --- repo -----------------------------------------------------------------

  const doScan = useCallback(async (path: string) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/scan?path=${encodeURIComponent(path)}`)
      const body = (await res.json()) as { error?: string; root?: string; name?: string; files?: RepoFile[] }
      if (!res.ok) throw new Error(body.error ?? `scan failed (${res.status})`)
      setRoot(body.root as string)
      setRepoName(body.name as string)
      setFiles(body.files ?? [])
      const next = [body.root as string, ...recents.filter((r) => r !== body.root)].slice(0, 8)
      setRecents(next)
      try {
        localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
      } catch {
        /* private mode: recents are a nicety */
      }
      setScreen('browse')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [recents])

  // --- session --------------------------------------------------------------

  const startTrace = useCallback(
    async (f: RepoFile, start: number, count: number) => {
      setError(null)
      const qs = new URLSearchParams({ root, rel: f.rel, start: String(start), lines: String(count) })
      try {
        const res = await fetch(`/api/file?${qs}`)
        const body = (await res.json()) as { error?: string; text?: string }
        if (!res.ok) throw new Error(body.error ?? `read failed (${res.status})`)
        const text = trimForTyping(body.text ?? '')
        if (!text) throw new Error('That range is empty.')
        textRef.current = text
        traceRef.current = createTrace(text)
        finalRef.current = null
        setFinal(null)
        setChunkLabel(`${f.rel}:${start + 1}–${start + count}`)
        setScreen('trace')
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [root],
  )

  const trace = traceRef.current

  // Bump render versions for exactly the lines that changed, then repaint.
  const bump = useCallback((t: Trace, before: number, after: number) => {
    const n = t.doc.lines.length
    const lo = Math.max(0, Math.min(lineAt(t, before), lineAt(t, after)))
    const hi = Math.min(n - 1, Math.max(lineAt(t, before), lineAt(t, after)))
    for (let i = lo; i <= hi; i++) t.versions[i] = (t.versions[i] as number) + 1
    setTick((x) => x + 1)
  }, [])

  const finish = useCallback((t: Trace) => {
    finalizeAll(t)
    const m = metrics(t)
    finalRef.current = m
    setFinal(m)
    playComplete()
    setScreen('done')
  }, [])

  /** Same text, clean slate. Recreating the Trace is cheaper than resetting it. */
  const retrace = useCallback(() => {
    if (!textRef.current) return
    traceRef.current = createTrace(textRef.current)
    finalRef.current = null
    setFinal(null)
    setScreen('trace')
  }, [])

  /** Bail out mid-file: score whatever was typed. */
  const abandon = useCallback(() => {
    const t = traceRef.current
    if (!t || t.keystrokes.length === 0) {
      setScreen('browse')
      return
    }
    finish(t)
  }, [finish])

  // --- input ----------------------------------------------------------------

  useEffect(() => {
    if (screen !== 'trace') return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = traceRef.current
      if (!t) return

      if (e.key === 'Escape') {
        e.preventDefault()
        setScreen('browse')
        return
      }
      if (isComplete(t)) return

      if (e.key === 'Backspace') {
        e.preventDefault()
        initAudio()
        const before = t.cursor
        if (backspace(t, performance.now())) {
          playClick('ok')
          bump(t, before, t.cursor)
        }
        return
      }

      e.preventDefault()
      initAudio()
      const now = performance.now()
      const before = t.cursor

      if (e.key === 'Tab') {
        const li = lineAt(t, t.cursor)
        const soFar = t.doc.text.slice(t.doc.lineStarts[li] as number, t.cursor)
        for (const ch of tabFill(soFar)) press(t, ch, now, 'tab')
        playClick('tab')
        bump(t, before, t.cursor)
        if (isComplete(t)) finish(t)
        return
      }

      if (e.key === 'Enter') {
        press(t, '\n', now, 'newline')
        playClick('enter')
      } else if (e.key.length === 1) {
        const expected = t.doc.text[t.cursor]
        const ok = press(t, e.key, now)
        if (ok) playClick(e.key === expected ? 'ok' : 'err')
      } else {
        return
      }

      bump(t, before, t.cursor)
      if (isComplete(t)) finish(t)
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [screen, bump, finish])

  // --- follow the caret -----------------------------------------------------

  useEffect(() => {
    const c = scrollerRef.current
    if (screen !== 'trace' || !c) return
    const line = c.querySelector<HTMLElement>('.ln.cur')
    line?.scrollIntoView({ block: 'nearest' })
    const caret = c.querySelector<HTMLElement>('.caret')
    if (caret) {
      const x = caret.offsetLeft
      const rel = x - c.scrollLeft
      if (rel > c.clientWidth * 0.75 || rel < 0) c.scrollLeft = x - c.clientWidth * 0.3
    }
  }, [tick, screen])

  useEffect(() => {
    if (screen !== 'trace') return
    const c = scrollerRef.current
    if (c) {
      c.scrollTop = 0
      c.scrollLeft = 0
    }
  }, [chunkLabel, screen])

  const toggleMute = () => {
    const next = !muted
    setMuted(next)
    setMutedState(next)
  }

  // --- render ---------------------------------------------------------------

  if (screen === 'pick') {
    return <RepoPicker onScan={doScan} busy={busy} error={error} recents={recents} />
  }

  if (screen === 'browse') {
    return (
      <div>
        {error && <div className="err floating">{error}</div>}
        <FileList files={files} onStart={startTrace} onBack={() => setScreen('pick')} />
        <div className="repohead">
          <b>{repoName}</b> <span>{root}</span>
        </div>
      </div>
    )
  }

  if (screen === 'done' && trace && final) {
    return (
      <Results
        trace={trace}
        metrics={final}
        label={chunkLabel}
        onRetrace={retrace}
        onAnother={() => setScreen('browse')}
        onFiles={() => setScreen('browse')}
      />
    )
  }

  if (!trace) return null

  const progress = trace.doc.text.length
    ? Math.round((trace.cursor / trace.doc.text.length) * 100)
    : 0

  return (
    <div className="tracing">
      <header className="topbar">
        <button className="ghost" onClick={() => setScreen('browse')}>
          ← Files
        </button>
        <span className="chunklabel">{chunkLabel}</span>
        <div className="progress">
          <div className="pbar">
            <div className="pfill" style={{ width: `${progress}%` }} />
          </div>
          <span className="pnum">{progress}%</span>
        </div>
        <button className="ghost" onClick={toggleMute}>
          {muted ? '🔇' : '🔊'}
        </button>
        <button className="ghost" onClick={abandon}>
          End
        </button>
      </header>

      <SourceView
        lines={trace.doc.lines}
        lineStarts={trace.doc.lineStarts}
        states={trace.states}
        wrongAt={trace.wrongAt}
        versions={trace.versions}
        cursor={trace.cursor}
        lineOf={trace.doc.lineOf}
        scrollerRef={scrollerRef}
      />

      <footer className="foot">
        Type over the characters. Errors turn red and the cursor keeps moving —
        fix them with ⌫ if you want the accuracy to count.
        <span className="esc">esc to exit</span>
      </footer>
    </div>
  )
}
