import { open, readdir, realpath, stat } from 'node:fs/promises'
import { join, relative, extname, basename } from 'node:path'

/** Directories we never descend into. Cheap win: skips the 95% of node_modules-style noise. */
const IGNORE_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'out', 'target',
  '.venv', 'venv', 'env', '__pycache__', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', '.tox', 'site-packages', '.next', '.nuxt', '.svelte-kit',
  '.cache', '.parcel-cache', 'coverage', 'htmlcov', '.gradle', 'vendor',
  '.idea', '.vscode', '.ipynb_checkpoints', '.terraform', 'Pods',
])

const SOURCE_EXT = new Set([
  '.py', '.pyi', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.cpp', '.cc', '.cxx', '.c', '.hpp', '.h', '.ipp',
  '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.rb', '.php', '.cs', '.m', '.scala', '.ex',
])

/** 2MB. Bigger than any function; smaller than "I accidentally loaded a bundle". */
const MAX_BYTES = 2_000_000

const MAX_FILES = 5_000

export interface RepoFile {
  /** Path relative to the repo root, posix-separated. Stable id for the client. */
  rel: string
  abs: string
  size: number
  mtime: number
  ext: string
}

export interface ScanResult {
  root: string
  name: string
  files: RepoFile[]
  truncated: boolean
  skipped: { dirs: number; big: number; binary: number }
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

async function isBinary(abs: string): Promise<boolean> {
  let fh
  try {
    fh = await open(abs, 'r')
  } catch {
    return true
  }
  try {
    const buf = Buffer.alloc(4096)
    const { bytesRead } = await fh.read(buf, 0, 4096, 0)
    return looksBinary(buf.subarray(0, bytesRead))
  } catch {
    return true
  } finally {
    await fh.close().catch(() => {})
  }
}

export async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Walks `root` for source files. Follows symlinked directories only once and
 * never escapes `root` — otherwise a `node_modules` symlink or a symlink to
 * `~` turns this into a full-disk walk.
 */
export async function scan(root: string): Promise<ScanResult> {
  const files: RepoFile[] = []
  const seenDirs = new Set<string>()
  const skipped = { dirs: 0, big: 0, binary: 0 }
  let truncated = false

  async function walk(dir: string): Promise<void> {
    if (truncated) return
    let real: string
    try {
      real = await realpath(dir)
    } catch {
      return
    }
    if (seenDirs.has(real)) {
      skipped.dirs++
      return
    }
    seenDirs.add(real)

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const e of entries) {
      if (truncated) return
      if (e.name.startsWith('.') && e.name !== '.') {
        if (e.isDirectory()) skipped.dirs++
        continue
      }
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) {
          skipped.dirs++
          continue
        }
        await walk(abs)
      } else if (e.isFile() || e.isSymbolicLink()) {
        const ext = extname(e.name).toLowerCase()
        if (!SOURCE_EXT.has(ext)) continue
        let st
        try {
          st = await stat(abs)
        } catch {
          continue
        }
        if (!st.isFile()) continue
        if (st.size > MAX_BYTES) {
          skipped.big++
          continue
        }
        if (st.size === 0) continue
        // Cheap binary sniff: read a 4KB prefix, not the whole file.
        if (await isBinary(abs)) {
          skipped.binary++
          continue
        }
        files.push({
          rel: relative(root, abs).split(/[\\/]/).join('/'),
          abs,
          size: st.size,
          mtime: st.mtimeMs,
          ext,
        })
        if (files.length >= MAX_FILES) {
          truncated = true
          return
        }
      }
    }
  }

  await walk(root)
  files.sort((a, b) => a.rel.localeCompare(b.rel))

  return {
    root,
    name: basename(root) || root,
    files,
    truncated,
    skipped,
  }
}
