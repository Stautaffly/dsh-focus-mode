/** Normal CLI installation, discovery and removal in isolated profiles. */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
const repository = process.env.DSH_SOURCE!
const plugin = fileURLToPath(new URL('../', import.meta.url))

it.each(['directory', 'archive'])('discovers and removes focus-mode from a normal %s installation', async kind => {
  const home = await mkdtemp(join(tmpdir(), 'focus-install-'))
  const profile = `focus-${kind}`
  const cli = async (...args: string[]) => execute(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', ...args], {
    cwd: repository, env: { ...process.env, DSH_HOME: home }, timeout: 120000, maxBuffer: 8 * 1024 * 1024,
  })
  let installed = false
  try {
    let spec = plugin
    if (kind === 'archive') {
      const packed = await execute('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', home], { cwd: plugin, timeout: 30000 })
      const metadata = JSON.parse(packed.stdout) as { filename: string }[] | Record<string, { filename: string }>
      const archive = Array.isArray(metadata) ? metadata[0] : metadata['dsh-focus-mode']
      expect(archive).toBeDefined()
      spec = join(home, archive!.filename)
    }
    const added = await cli('plugin', '--profile', profile, 'add', spec)
    installed = true
    expect(added.stderr).not.toContain('plain dependency')
    const manifestPath = join(home, 'profiles', profile, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    expect(manifest.dsh.profile.bundles).toContain('dsh-focus-mode')
    const dump = await cli('--profile', profile, '--dump-config')
    expect(dump.stdout).toContain('external-preset-focus-mode')
    expect(dump.stdout).toContain('focus-mode')
    await cli('plugin', '--profile', profile, 'remove', 'dsh-focus-mode')
    installed = false
    const removed = JSON.parse(await readFile(manifestPath, 'utf8'))
    expect(removed.dsh.profile.bundles).not.toContain('dsh-focus-mode')
    const after = await cli('--profile', profile, '--dump-config')
    expect(after.stdout).not.toContain('external-preset-focus-mode')
  } finally {
    try { if (installed) await cli('plugin', '--profile', profile, 'remove', 'dsh-focus-mode') }
    finally { await rm(home, { recursive: true, force: true }) }
  }
}, 150000)
