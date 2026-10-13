import * as vscode from 'vscode'
import { diffHunks } from '@devtrace/core'
import type { PendingStore, StagedEntry } from './staging.js'

/** Added / Modified / Deleted, in the same spirit as Source Control letters. */
type ChangeStatus = 'A' | 'M' | 'D'

function statusOf(entry: StagedEntry): ChangeStatus {
  const { before, after } = entry.change
  if (before.length === 0 && after.length > 0) return 'A'
  if (after.length === 0) return 'D'
  return 'M'
}

function toolLabel(tool: string): string {
  return tool === 'multiedit' ? 'multi-edit' : tool
}

/** One pending AI change, shown like a Source Control file row. */
export class PendingItem extends vscode.TreeItem {
  constructor(readonly entry: StagedEntry) {
    const rel = vscode.workspace.asRelativePath(entry.change.file, false)
    super(rel, vscode.TreeItemCollapsibleState.None)
    this.id = entry.change.id
    this.contextValue = 'devtrace.pending'
    this.resourceUri = vscode.Uri.file(entry.change.file)

    let hunks = 0
    try {
      hunks = diffHunks(entry.change.before, entry.change.after).length
    } catch {
      hunks = 0
    }
    const parts = [`${toolLabel(entry.change.tool)}`, hunks === 1 ? '1 hunk' : `${hunks} hunks`]
    this.description = parts.join(' · ')
    this.tooltip = new vscode.MarkdownString(
      `**${rel}**\n\n${toolLabel(entry.change.tool)} · ` +
        `${hunks === 1 ? '1 hunk' : `${hunks} hunks`} · staged ${new Date(entry.change.ts).toLocaleTimeString()}\n\n` +
        `Click to trace it by hand.`,
    )
    this.command = {
      command: 'devtrace.pending.trace',
      title: 'Trace change',
      arguments: [entry.change.id],
    }
  }
}

export class PendingTreeProvider implements vscode.TreeDataProvider<PendingItem> {
  private readonly emitter = new vscode.EventEmitter<PendingItem | undefined | void>()
  readonly onDidChangeTreeData = this.emitter.event

  constructor(private readonly store: PendingStore) {}

  refresh(): void {
    this.emitter.fire()
  }

  getTreeItem(element: PendingItem): vscode.TreeItem {
    return element
  }

  getChildren(): PendingItem[] {
    return this.store.list().map((entry) => new PendingItem(entry))
  }

  dispose(): void {
    this.emitter.dispose()
  }
}

/**
 * Colours each pending file with the familiar Source Control M/A/D badge, so the
 * panel reads at a glance the way the Changes list does.
 */
export class PendingDecorations implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>()
  readonly onDidChangeFileDecorations = this.emitter.event
  private readonly byPath = new Map<string, ChangeStatus>()

  constructor(store: PendingStore) {
    store.onDidChange(() => {
      this.byPath.clear()
      for (const entry of store.list()) {
        this.byPath.set(vscode.Uri.file(entry.change.file).toString(), statusOf(entry))
      }
      this.emitter.fire(undefined)
    })
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const status = this.byPath.get(uri.toString())
    if (!status) return undefined
    const color =
      status === 'A'
        ? new vscode.ThemeColor('gitDecoration.addedResourceForeground')
        : status === 'D'
          ? new vscode.ThemeColor('gitDecoration.deletedResourceForeground')
          : new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')
    return {
      badge: status,
      color,
      propagate: false,
      tooltip: status === 'A' ? 'New file' : status === 'D' ? 'Deletes code' : 'Edits code',
    }
  }

  dispose(): void {
    this.emitter.dispose()
  }
}
