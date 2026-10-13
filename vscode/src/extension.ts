import * as vscode from 'vscode'
import * as os from 'node:os'
import * as path from 'node:path'
import { existsSync } from 'node:fs'
import { diffHunks, type Hunk, type Metrics, type Trace } from '@devtrace/core'
import { TraceSession } from './session.js'
import { ResultsPanel } from './results.js'
import { PendingStore, type StagedChange, type StagedEntry } from './staging.js'
import { PendingDecorations, PendingTreeProvider } from './pendingView.js'
import { TracePanel } from './tracePanel.js'

interface LastResults {
  trace: Trace
  metrics: Metrics
  label: string
  completed: boolean
}

let statusItem: vscode.StatusBarItem
let lastResults: LastResults | undefined
let extensionUri: vscode.Uri
let store: PendingStore
let treeProvider: PendingTreeProvider
let treeView: vscode.TreeView<unknown>

let processing = false
let autoPumping = false

const hooks = {
  onProgress: (t: Trace): void => {
    const total = t.doc.text.length
    const pct = total > 0 ? Math.round((t.cursor / total) * 100) : 0
    statusItem.text = `$(keyboard) DevTrace ${pct}%`
    statusItem.tooltip = 'Tracing — click (or Esc) to end the session'
    statusItem.show()
  },
  onFinish: (t: Trace, m: Metrics, completed: boolean): void => {
    const label = TraceSession.active?.sessionLabel ?? 'session'
    lastResults = { trace: t, metrics: m, label, completed }
    statusItem.text = '$(keyboard) DevTrace'
    statusItem.tooltip = 'Click to show the last results'
    ResultsPanel.show(t, m, label, completed)
  },
}

/** Start a trace, chaining `onDone` after the session ends. */
async function begin(
  editor: vscode.TextEditor,
  target: string,
  range: vscode.Range,
  replace: boolean,
  onDone?: () => void,
): Promise<void> {
  if (TraceSession.active) {
    void vscode.window.showWarningMessage('A DevTrace session is already running.')
    return
  }
  const wrapped = {
    onProgress: hooks.onProgress,
    onFinish: (t: Trace, m: Metrics, completed: boolean) => {
      hooks.onFinish(t, m, completed)
      onDone?.()
    },
  }
  await TraceSession.start(editor, { target, range, replace, hooks: wrapped })
  statusItem.show()
}

/**
 * Trace the staged change in the dedicated DevTrace panel. Nothing is written
 * unless the developer saves; then the hunk is replaced with exactly what was
 * typed. The editor buffer is never touched, so the change is never "already in"
 * the file until the developer commits to it.
 *
 * Returns what the developer chose, so the caller can retire the queue entry.
 */
async function applyStaged(change: StagedChange): Promise<'save' | 'discard'> {
  const uri = vscode.Uri.file(change.file)
  let current = ''
  try {
    current = (await vscode.workspace.openTextDocument(uri)).getText()
  } catch {
    // New file the AI wanted to create: it is not on disk yet.
    current = ''
  }

  const hunks = diffHunks(current, change.after)
  if (hunks.length === 0) {
    void vscode.window.showInformationMessage('DevTrace: that staged change was already applied.')
    return 'save'
  }

  const rel = vscode.workspace.asRelativePath(uri, false)
  const changes = hunks.length === 1 ? '1 change' : `${hunks.length} changes`
  const label = `${rel} · ${changes}`

  // Every hunk of the file is traced in one panel, over the whole proposed file:
  // the developer sees the complete file as context and only types the changes.
  const regions = hunks.map((h) => ({ start: h.afterStart, target: h.newText }))

  statusItem.text = '$(keyboard) DevTrace 0%'
  statusItem.tooltip = 'Tracing an AI change — Save writes what you type, Esc discards'
  statusItem.show()

  const result = await TracePanel.show(extensionUri, change.after, regions, label)

  statusItem.text = '$(keyboard) DevTrace'
  statusItem.tooltip = 'Click to end a running session'

  if (result.action === 'discard') return 'discard'

  // One typed string per hunk: a pure deletion has nothing to type and is
  // accepted as-is, matching the empty target the panel was given.
  const typed = hunks.map((h, i) => (h.newText.length === 0 ? '' : (result.typedTexts[i] ?? '')))

  await writeHunks(uri, current, hunks, typed)
  return 'save'
}

/**
 * Write exactly what was typed for each hunk, leaving the unchanged text between
 * them untouched. The editor buffer is only touched here, once, after every hunk
 * has been traced.
 */
async function writeHunks(
  uri: vscode.Uri,
  current: string,
  hunks: Hunk[],
  typed: string[],
): Promise<void> {
  let out = ''
  let pos = 0
  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i] as Hunk
    out += current.slice(pos, hunk.start) + typed[i]
    pos = hunk.start + hunk.oldText.length
  }
  out += current.slice(pos)

  try {
    await vscode.workspace.fs.stat(uri)
  } catch {
    await vscode.workspace.fs.writeFile(uri, new Uint8Array())
  }

  const doc = await vscode.workspace.openTextDocument(uri)
  const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length))
  const edit = new vscode.WorkspaceEdit()
  edit.replace(uri, full, out)
  const applied = await vscode.workspace.applyEdit(edit)
  if (!applied) {
    void vscode.window.showErrorMessage('DevTrace: could not write the traced change.')
    return
  }
  await doc.save()
}

/** Trace one queue entry, retiring it on save. Serialised against the panel. */
async function traceEntry(entry: StagedEntry): Promise<'save' | 'discard' | undefined> {
  if (processing) {
    void vscode.window.showInformationMessage('DevTrace is already tracing a change.')
    return undefined
  }
  processing = true
  try {
    const action = await applyStaged(entry.change)
    if (action === 'save') await store.remove(entry.change.id)
    return action
  } finally {
    processing = false
  }
}

function autoTraceEnabled(): boolean {
  return vscode.workspace.getConfiguration('devtrace').get<boolean>('autoTrace', false)
}

/** With auto-trace on, work through the queue until one is discarded or empty. */
async function autoPump(): Promise<void> {
  if (autoPumping || !autoTraceEnabled()) return
  autoPumping = true
  try {
    while (!processing) {
      const next = store.list()[0]
      if (!next) break
      const action = await traceEntry(next)
      if (action !== 'save') break
    }
  } finally {
    autoPumping = false
  }
}

/** Trace every queued change in order, stopping if one is discarded. */
async function traceAll(): Promise<void> {
  while (!processing) {
    const next = store.list()[0]
    if (!next) break
    const action = await traceEntry(next)
    if (action !== 'save') break
  }
}

/** The workspace-relative queue directory, e.g. `<root>/.devtrace`. */
function queueDirUri(folder: vscode.WorkspaceFolder): vscode.Uri {
  const cfg = vscode.workspace.getConfiguration('devtrace', folder.uri)
  const rel = cfg.get<string>('queueDir', '.devtrace')
  return vscode.Uri.joinPath(folder.uri, rel)
}

/**
 * DevTrace staging is on exactly when a `.devtrace/` queue directory exists —
 * that is the same signal the OpenCode plugin watches.
 */
function isStagingEnabled(): boolean {
  return (vscode.workspace.workspaceFolders ?? []).some((f) => existsSync(queueDirUri(f).fsPath))
}

async function updateStagingContext(): Promise<void> {
  await vscode.commands.executeCommand('setContext', 'devtrace.stagingEnabled', isStagingEnabled())
}

/** On startup, honour the persisted preference by ensuring the queue exists. */
async function ensureStagingFromSetting(): Promise<void> {
  if (!vscode.workspace.getConfiguration('devtrace').get<boolean>('enabled', true)) return
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(queueDirUri(folder), 'pending'))
    } catch {
      /* unwritable folder — staging just stays off */
    }
  }
}

/** Turn staging on/off by creating or removing the queue directory. */
async function setStaging(enabled: boolean): Promise<void> {
  if (enabled === isStagingEnabled()) {
    await updateStagingContext()
    return
  }

  if (!enabled) {
    const n = store.list().length
    const detail =
      n > 0
        ? `This removes ${n} pending change${n === 1 ? '' : 's'} that haven't been traced.`
        : 'OpenCode edits will no longer be staged for hand-typing.'
    const pick = await vscode.window.showWarningMessage(`Turn off DevTrace? ${detail}`, { modal: true }, 'Turn off')
    if (pick !== 'Turn off') return
  }

  const folders = vscode.workspace.workspaceFolders ?? []
  const target =
    folders.length > 0 ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global
  await vscode.workspace.getConfiguration('devtrace').update('enabled', enabled, target)

  for (const folder of folders) {
    const dir = queueDirUri(folder)
    try {
      if (enabled) await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dir, 'pending'))
      else await vscode.workspace.fs.delete(dir, { recursive: true })
    } catch {
      /* best effort */
    }
  }

  await store.reset()
  await updateStagingContext()
}

export function activate(context: vscode.ExtensionContext): void {
  extensionUri = context.extensionUri
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusItem.command = 'devtrace.endSession'
  statusItem.text = '$(keyboard) DevTrace'

  TracePanel.onProgress = (pct) => {
    statusItem.text = `$(keyboard) DevTrace ${pct}%`
    statusItem.show()
  }

  // The pending-changes panel: a Source Control-like list of AI edits waiting to
  // be typed by hand.
  store = new PendingStore(() => void autoPump())
  treeProvider = new PendingTreeProvider(store)
  treeView = vscode.window.createTreeView('devtrace.pending', {
    treeDataProvider: treeProvider,
  })
  const decorations = new PendingDecorations(store)
  store.onDidChange(() => {
    treeProvider.refresh()
    const n = store.list().length
    treeView.badge = n > 0 ? { value: n, tooltip: `${n} pending change${n === 1 ? '' : 's'}` } : undefined
  })
  void (async () => {
    await ensureStagingFromSetting()
    await store.start()
    await updateStagingContext()
    await autoPump()
  })()

  const traceSelection = vscode.commands.registerCommand('devtrace.traceSelection', async () => {
    const editor = vscode.window.activeTextEditor
    if (!editor) return
    if (editor.selection.isEmpty) {
      void vscode.window.showInformationMessage('Select the code you want to trace first.')
      return
    }
    const range = new vscode.Range(editor.selection.start, editor.selection.end)
    const target = editor.document.getText(range)
    if (!target.trim()) {
      void vscode.window.showInformationMessage('That selection is empty.')
      return
    }
    await begin(editor, target, range, false)
  })

  const traceFile = vscode.commands.registerCommand('devtrace.traceFile', async () => {
    const editor = vscode.window.activeTextEditor
    if (!editor) return
    const doc = editor.document
    const target = doc.getText()
    if (!target.trim()) {
      void vscode.window.showInformationMessage('This file is empty.')
      return
    }
    const range = new vscode.Range(doc.positionAt(0), doc.positionAt(target.length))
    await begin(editor, target, range, false)
  })

  const endSession = vscode.commands.registerCommand('devtrace.endSession', () => {
    TracePanel.discardActive()
    TraceSession.active?.abort()
  })

  const showResults = vscode.commands.registerCommand('devtrace.showResults', () => {
    if (!lastResults) {
      void vscode.window.showInformationMessage('No DevTrace results yet.')
      return
    }
    ResultsPanel.show(lastResults.trace, lastResults.metrics, lastResults.label, lastResults.completed)
  })

  const tracePending = vscode.commands.registerCommand('devtrace.pending.trace', async (id: string) => {
    const entry = store.find(id)
    if (entry) await traceEntry(entry)
  })

  const discardPending = vscode.commands.registerCommand('devtrace.pending.discard', async (id: string) => {
    const entry = store.find(id)
    if (!entry) return
    const rel = vscode.workspace.asRelativePath(entry.change.file, false)
    const pick = await vscode.window.showWarningMessage(
      `Discard the staged change to ${rel}?`,
      { modal: true },
      'Discard',
    )
    if (pick === 'Discard') await store.remove(entry.change.id)
  })

  const revealPending = vscode.commands.registerCommand('devtrace.pending.reveal', async (id: string) => {
    const entry = store.find(id)
    if (!entry) return
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(entry.change.file))
    } catch {
      void vscode.window.showWarningMessage('DevTrace: that file no longer exists.')
    }
  })

  const traceAllPending = vscode.commands.registerCommand('devtrace.pending.traceAll', () => void traceAll())

  const clearPending = vscode.commands.registerCommand('devtrace.pending.clear', async () => {
    const n = store.list().length
    if (n === 0) return
    const pick = await vscode.window.showWarningMessage(
      `Discard all ${n} pending change${n === 1 ? '' : 's'}?`,
      { modal: true },
      'Discard all',
    )
    if (pick !== 'Discard all') return
    for (const entry of store.list()) await store.remove(entry.change.id)
  })

  const refreshPending = vscode.commands.registerCommand('devtrace.pending.refresh', () =>
    treeProvider.refresh(),
  )

  const enableStaging = vscode.commands.registerCommand('devtrace.enableStaging', () => setStaging(true))
  const disableStaging = vscode.commands.registerCommand('devtrace.disableStaging', () => setStaging(false))

  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('devtrace.enabled') || e.affectsConfiguration('devtrace.queueDir')) {
      void updateStagingContext()
    }
  })

  const installPlugin = vscode.commands.registerCommand('devtrace.installOpencodePlugin', async () => {
    const source = vscode.Uri.joinPath(context.extensionUri, 'assets', 'opencode-plugin.ts')
    const pluginsDir = vscode.Uri.file(path.join(os.homedir(), '.config', 'opencode', 'plugins'))
    try {
      await vscode.workspace.fs.createDirectory(pluginsDir)
      const bytes = await vscode.workspace.fs.readFile(source)
      const target = vscode.Uri.joinPath(pluginsDir, 'devtrace.ts')
      await vscode.workspace.fs.writeFile(target, bytes)
      const open = 'Show folder'
      void vscode.window
        .showInformationMessage(
          'DevTrace: OpenCode plugin installed. Restart opencode to load it.',
          open,
        )
        .then((pick) => {
          if (pick === open) void vscode.env.openExternal(pluginsDir)
        })
    } catch (err) {
      void vscode.window.showErrorMessage(`DevTrace: could not install plugin — ${(err as Error).message}`)
    }
  })

  context.subscriptions.push(
    statusItem,
    store,
    treeProvider,
    treeView,
    decorations,
    vscode.window.registerFileDecorationProvider(decorations),
    traceSelection,
    traceFile,
    endSession,
    showResults,
    tracePending,
    discardPending,
    revealPending,
    traceAllPending,
    clearPending,
    refreshPending,
    enableStaging,
    disableStaging,
    configListener,
    installPlugin,

    // Special keys. Bound only while a session runs so the editor never inserts
    // anything for them — the document must stay immutable.
    vscode.commands.registerCommand('devtrace.enter', () => TraceSession.active?.enter()),
    vscode.commands.registerCommand('devtrace.tab', () => TraceSession.active?.tab()),
    vscode.commands.registerCommand('devtrace.backspace', () => TraceSession.active?.backspace()),
    vscode.commands.registerCommand('devtrace.skipLine', () => TraceSession.active?.skipLine()),
  )
}

export function deactivate(): void {
  TraceSession.active?.dispose()
}
