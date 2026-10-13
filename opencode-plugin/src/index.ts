/**
 * opencode-devtrace
 *
 * Blocks OpenCode's writing tools (`edit`, `write`, `multiedit`) and stages each
 * proposed change under `<worktree>/.devtrace/pending/` instead. The DevTrace
 * VS Code extension watches that directory, opens the file, and lets the
 * developer *type the change by hand* over a ghost overlay. Nothing is written
 * until the developer has typed it.
 *
 * Edits to the same file are coalesced into a single pending record: each new
 * tool call composes on top of what is already staged, so one file shows up
 * once in the queue with every hunk, however many calls the agent made.
 *
 * Opt-in: staging activates when `DEVTRACE_STAGE=1` is set, or when a
 * `.devtrace/` directory exists in the worktree (the extension creates it).
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'

interface PluginContext {
  directory: string
  worktree: string
  client?: {
    app?: {
      log?: (input: {
        body: { service: string; level: string; message: string; extra?: unknown }
      }) => Promise<unknown>
    }
  }
}

interface ToolInput {
  tool: string
}

interface ToolOutput {
  args: Record<string, unknown>
}

interface StagedRecord {
  id: string
  ts: number
  tool: string
  file: string
  before: string
  after: string
}

function applyOne(before: string, args: Record<string, unknown>): string {
  const oldString = args.oldString
  const newString = args.newString
  if (typeof oldString !== 'string' || typeof newString !== 'string') return before
  if (args.replaceAll === true) return before.split(oldString).join(newString)
  const i = before.indexOf(oldString)
  if (i === -1) return before
  return before.slice(0, i) + newString + before.slice(i + oldString.length)
}

function applyEdits(before: string, args: Record<string, unknown>): string {
  const edits = args.edits
  if (Array.isArray(edits)) {
    let out = before
    for (const e of edits) {
      if (e && typeof e === 'object') out = applyOne(out, e as Record<string, unknown>)
    }
    return out
  }
  return applyOne(before, args)
}

export const DevTracePlugin = async ({ directory, worktree, client }: PluginContext) => {
  const root = worktree && worktree.length > 0 ? worktree : directory
  const devDir = join(root, '.devtrace')
  const pendingDir = join(devDir, 'pending')

  const enabled = (): boolean => process.env.DEVTRACE_STAGE === '1' || existsSync(devDir)

  const readSafe = async (path: string): Promise<string> => {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return ''
    }
  }

  /** Every pending record that already targets `file`, oldest first. */
  const readPendingFor = async (file: string): Promise<StagedRecord[]> => {
    let names: string[]
    try {
      names = await readdir(pendingDir)
    } catch {
      return []
    }
    const records: StagedRecord[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const rec = JSON.parse(
          await readFile(join(pendingDir, name), 'utf8'),
        ) as StagedRecord
        if (rec && rec.file === file && typeof rec.after === 'string') records.push(rec)
      } catch {
        // partially written or garbage — ignore, the next stage will retry
      }
    }
    return records.sort((a, b) => a.ts - b.ts)
  }

  const stage = async (input: ToolInput, output: ToolOutput): Promise<void> => {
    const tool = input.tool
    if (tool !== 'edit' && tool !== 'write' && tool !== 'multiedit') return
    if (!enabled()) return

    const args = output.args ?? {}
    const filePath = args.filePath
    if (typeof filePath !== 'string' || filePath.length === 0) return

    const abs = isAbsolute(filePath) ? filePath : resolve(root, filePath)
    const disk = await readSafe(abs)

    // Compose on top of anything already staged for this file, rather than the
    // unchanged disk: the extension blocks writes, so an edit that references
    // text a previous (still-pending) edit introduced would otherwise be lost.
    const prior = await readPendingFor(abs)
    const newest = prior[prior.length - 1]
    const base = newest ? newest.after : disk

    const after =
      tool === 'write' && typeof args.content === 'string' ? args.content : applyEdits(base, args)
    if (after === base) return

    await mkdir(pendingDir, { recursive: true })
    const id = newest ? newest.id : randomUUID()
    const ts = newest ? newest.ts : Date.now()
    // `before` mirrors the committed file so the extension's diff against disk
    // yields exactly the pending hunks.
    const record: StagedRecord = { id, ts, tool, file: abs, before: disk, after }
    const tmp = join(pendingDir, `${id}.json.tmp`)
    await writeFile(tmp, JSON.stringify(record), 'utf8')
    await rename(tmp, join(pendingDir, `${id}.json`))

    // Retire any older duplicate records for this file (legacy queue entries),
    // so the file occupies exactly one slot.
    for (const r of prior) {
      if (r.id !== id) await unlink(join(pendingDir, `${r.id}.json`)).catch(() => {})
    }

    await client?.app?.log?.({
      body: {
        service: 'opencode-devtrace',
        level: 'info',
        message: `staged ${tool} for ${abs}`,
      },
    })

    // The message is deliberately phrased as a successful outcome. It is still a
    // thrown error (that is the only way to block a tool), so we also inject a
    // system rule and a tool-description note below telling the model that this
    // result is expected and must not be retried.
    throw new Error(
      `DevTrace: ${tool} staged successfully for the developer to type by hand. ` +
        `The file is intentionally left unchanged for now — the developer will apply ` +
        `this exact change. This is the expected behavior, NOT a failure. Do not retry ` +
        `this edit, do not call ${tool} again for this file, and continue with other work.`,
    )
  }

  const devTraceTools = new Set(['edit', 'write', 'multiedit'])

  return {
    'tool.execute.before': stage,

    // Tell the model up front that intercepted edits are success.
    'experimental.chat.system.transform': async (
      _input: unknown,
      output: { system: string[] },
    ) => {
      if (!enabled()) return
      output.system.push(
        'DevTrace mode is active. File writes (edit/write/multiedit) are intercepted: ' +
          'each is staged for the developer to type by hand and the tool returns a message ' +
          'starting with "DevTrace:". Treat that result as SUCCESS. Do not retry the edit, ' +
          'do not re-read the file expecting the change to be present yet, and do not ' +
          'apologize or warn about the file being unchanged. Continue with the task.',
      )
    },

    // And annotate the writing tools themselves, where the model looks first.
    'tool.definition': async (
      input: { toolID: string },
      output: { description: string },
    ) => {
      if (!enabled()) return
      if (devTraceTools.has(input.toolID)) {
        output.description +=
          ' Note: DevTrace may stage this change for hand-typing and return a "DevTrace:" ' +
          'message. That is expected success — do not retry.'
      }
    },
  }
}

export default DevTracePlugin
