import { useMemo, useState } from 'react'

export interface RepoFile {
  rel: string
  size: number
  mtime: number
  ext: string
  lines: number
}

interface Props {
  files: RepoFile[]
  onStart: (f: RepoFile, start: number, count: number) => void
  onBack: () => void
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

export default function FileList({ files, onStart, onBack }: Props) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<RepoFile | null>(null)
  const [start, setStart] = useState(1)
  const [count, setCount] = useState(40)

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return files
    return files.filter((f) => f.rel.toLowerCase().includes(needle))
  }, [files, q])

  const groups = useMemo(() => {
    const m = new Map<string, RepoFile[]>()
    for (const f of filtered) {
      const i = f.rel.lastIndexOf('/')
      const dir = i === -1 ? '' : f.rel.slice(0, i)
      const arr = m.get(dir)
      if (arr) arr.push(f)
      else m.set(dir, [f])
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [filtered])

  const pick = (f: RepoFile) => {
    setSel(f)
    setStart(1)
    setCount(Math.min(40, f.lines))
  }

  const maxCount = sel ? sel.lines : 0
  const clampedStart = Math.min(Math.max(1, start), Math.max(1, maxCount))
  const clampedCount = Math.min(Math.max(1, count), maxCount - clampedStart + 1)

  return (
    <div className="browse">
      <header className="topbar">
        <button className="ghost" onClick={onBack}>
          ← Folders
        </button>
        <span className="count">
          {filtered.length} of {files.length} files
        </span>
        <input
          className="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filter by path…"
          spellCheck={false}
        />
      </header>

      <div className="split">
        <div className="filepane">
          {groups.map(([dir, fs]) => (
            <div key={dir || '.'} className="group">
              {dir && <div className="gdir">{dir}/</div>}
              {fs.map((f) => (
                <button
                  key={f.rel}
                  className={sel?.rel === f.rel ? 'file sel' : 'file'}
                  onClick={() => pick(f)}
                >
                  <span className="fname">{f.rel.slice(dir ? dir.length + 1 : 0)}</span>
                  <span className="fmeta">
                    {f.lines} ln · {fmtBytes(f.size)}
                  </span>
                </button>
              ))}
            </div>
          ))}
          {filtered.length === 0 && <div className="empty">No files match.</div>}
        </div>

        <div className="chunkpane">
          {!sel ? (
            <div className="empty">Pick a file to choose what to trace.</div>
          ) : (
            <>
              <div className="chunkhead">
                <div className="cpath">{sel.rel}</div>
                <div className="csub">{sel.lines} lines</div>
              </div>

              <div className="presets">
                <button onClick={() => { setStart(1); setCount(maxCount) }}>
                  Entire file
                </button>
                <button onClick={() => { setStart(1); setCount(40) }}>
                  First 40
                </button>
                <button
                  onClick={() => {
                    const c = Math.min(30, maxCount)
                    setStart(1 + Math.floor(Math.random() * (maxCount - c + 1)))
                    setCount(c)
                  }}
                >
                  Random 30
                </button>
              </div>

              <div className="range">
                <label>
                  from line
                  <input
                    type="number"
                    min={1}
                    max={maxCount}
                    value={clampedStart}
                    onChange={(e) => setStart(Number(e.target.value))}
                  />
                </label>
                <label>
                  lines
                  <input
                    type="number"
                    min={1}
                    max={maxCount}
                    value={clampedCount}
                    onChange={(e) => setCount(Number(e.target.value))}
                  />
                </label>
              </div>

              <div className="endline">
                tracing lines {clampedStart}–{clampedStart + clampedCount - 1} of {maxCount}
              </div>

              <button
                className="go"
                onClick={() => onStart(sel, clampedStart - 1, clampedCount)}
              >
                Start tracing
              </button>
              <p className="hint">
                Function-level chunks and git-selected changes land in M2–M3.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
