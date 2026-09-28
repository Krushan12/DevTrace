import type { Metrics } from '../lib/trace.js'
import { topOffenders, type Trace } from '../lib/trace.js'
import { showChar } from '../lib/format.js'

interface Props {
  trace: Trace
  metrics: Metrics
  label: string
  onRetrace: () => void
  onAnother: () => void
  onFiles: () => void
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`

export default function Results({ trace, metrics: m, label, onRetrace, onAnother, onFiles }: Props) {
  const offenders = topOffenders(trace)

  return (
    <div className="panel results">
      <div className="rhead">
        <h2>Session complete</h2>
        <div className="rlabel">{label}</div>
      </div>

      <div className="statgrid">
        <div className="stat big">
          <div className="v">{m.netWpm.toFixed(1)}</div>
          <div className="k">net WPM</div>
        </div>
        <div className="stat">
          <div className="v">{pct(m.accuracy)}</div>
          <div className="k">accuracy</div>
        </div>
        <div className="stat">
          <div className="v">{m.errors}</div>
          <div className="k">errors</div>
        </div>
        <div className="stat">
          <div className="v">{m.rawWpm.toFixed(1)}</div>
          <div className="k">raw WPM</div>
        </div>
        <div className="stat">
          <div className="v">{pct(m.consistency)}</div>
          <div className="k">consistency</div>
        </div>
        <div className="stat">
          <div className="v">{m.seconds.toFixed(1)}s</div>
          <div className="k">duration</div>
        </div>
        <div className="stat">
          <div className="v">{m.backspaces}</div>
          <div className="k">backspaces</div>
        </div>
        <div className="stat">
          <div className="v">{m.avgIntervalMs.toFixed(0)}ms</div>
          <div className="k">avg key</div>
        </div>
      </div>

      <div className="indentbox">
        <div className="ihead">
          <span>Indentation accuracy</span>
          <span className="ival">
            {pct(m.indentAccuracy)}{' '}
            <em>
              {m.indentHits}/{m.indentLines} lines
            </em>
          </span>
        </div>
        <div className="ibar">
          <div className="ifill" style={{ width: pct(m.indentAccuracy) }} />
        </div>
        <p className="ihint">
          Whitespace is where Python fights back. This is the number that moves
          first.
        </p>
      </div>

      {offenders.length > 0 && (
        <div className="offenders">
          <div className="ohead">Most-missed keys</div>
          <div className="ochips">
            {offenders.map((o) => (
              <span key={`${o.got}${o.expected}`} className="ochip">
                <code>{showChar(o.got)}</code>
                <span className="arrow">for</span>
                <code className="exp">{showChar(o.expected)}</code>
                <b>{o.count}</b>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="ractions">
        <button className="go" onClick={onRetrace}>
          Trace it again
        </button>
        <button onClick={onAnother}>Another range</button>
        <button className="ghost" onClick={onFiles}>
          All files
        </button>
      </div>
    </div>
  )
}
