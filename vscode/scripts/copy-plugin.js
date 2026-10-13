// Copies the single opencode-plugin source into the extension so it can be
// shipped in the VSIX and installed with one command. One source of truth:
// edit opencode-plugin/src/index.ts, this runs on every build.
const { copyFileSync, mkdirSync, existsSync } = require('node:fs')
const { join, dirname } = require('node:path')

const src = join(__dirname, '..', '..', 'opencode-plugin', 'src', 'index.ts')
const dest = join(__dirname, '..', 'assets', 'opencode-plugin.ts')

if (!existsSync(src)) {
  if (existsSync(dest)) {
    console.warn(`[copy-plugin] source not found: ${src}; keeping existing ${dest}`)
    process.exit(0)
  }
  console.error(`[copy-plugin] source not found: ${src}`)
  process.exit(1)
}

mkdirSync(dirname(dest), { recursive: true })
copyFileSync(src, dest)
console.log(`[copy-plugin] ${src} -> ${dest}`)
