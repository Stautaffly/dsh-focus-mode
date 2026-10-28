/** Run host integration tests against an explicitly selected dsh source checkout. */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defineConfig } from 'vitest/config'
import ts from 'typescript'

if (!process.env.DSH_SOURCE) {
  throw new Error('Set DSH_SOURCE to a prepared deepseek-harness checkout; see README.md#development.')
}
const host = resolve(process.env.DSH_SOURCE)
process.env.DSH_SOURCE = host
if (!existsSync(join(host, 'vitest.shared.ts')) || !existsSync(join(host, 'node_modules'))) {
  throw new Error('DSH_SOURCE needs the dsh source tree and installed host dependencies; see README.md#development.')
}
const { standardDecoratorPlugin, vitestExecArgv } = await import(pathToFileURL(join(host, 'vitest.shared.ts')).href)
const root = fileURLToPath(new URL('.', import.meta.url))
const virtualId = 'virtual:dsh-host-modules'
// The host's default include cannot match tests outside its checkout. Resolve
// every workspace import to source in both trees to keep one module identity.
const parsed = ts.readConfigFile(join(host, 'tsconfig.base.json'), ts.sys.readFile)
if (parsed.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'))
const hostPaths = parsed.config.compilerOptions.paths as Record<string, string[]>
const aliases = Object.entries(hostPaths).sort(([a], [b]) => b.length - a.length).map(([key, values]) => {
  if (values.length !== 1) throw new Error(`Expected one source target for host alias ${key}`)
  const pattern = key.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.*)')
  return { find: new RegExp(`^${pattern}$`), replacement: resolve(host, values[0]!).replaceAll('\\', '/').replace('*', '$1') }
})

/** Generate the original source fixture map without copying or changing the host. */
function hostModules() {
  return {
    name: 'focus-host-fixtures',
    resolveId(id: string) { if (id === virtualId) return '\0' + virtualId },
    load(id: string) {
      if (id !== '\0' + virtualId) return
      const sources: string[] = []
      const manifests: Record<string, { name: string }> = {}
      for (const group of readdirSync(join(host, 'packages'), { withFileTypes: true })) {
        if (!group.isDirectory()) continue
        for (const pkg of readdirSync(join(host, 'packages', group.name), { withFileTypes: true })) {
          if (!pkg.isDirectory()) continue
          const folder = join(host, 'packages', group.name, pkg.name)
          if (!existsSync(join(folder, 'package.json')) || !existsSync(join(folder, 'src'))) continue
          const key = `host/packages/${group.name}/${pkg.name}`
          const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'))
          manifests[`${key}/package.json`] = { name: manifest.name }
          for (const source of readdirSync(join(folder, 'src'), { withFileTypes: true })) {
            if (!source.isFile() || !source.name.endsWith('.ts') || source.name.endsWith('.d.ts')) continue
            const path = join(folder, 'src', source.name).replaceAll('\\', '/')
            sources.push(`${JSON.stringify(`${key}/src/${source.name}`)}: () => import(${JSON.stringify(path)})`)
          }
        }
      }
      return `export const sources = {${sources.join(',\n')}};\nexport const manifests = ${JSON.stringify(manifests)};`
    },
  }
}

export default defineConfig({
  plugins: [standardDecoratorPlugin(), hostModules()],
  resolve: { alias: aliases },
  server: { fs: { allow: [root, host] } },
  test: {
    root, include: ['tests/**/*.spec.ts'],
    testTimeout: 20000, hookTimeout: 30000, maxWorkers: 1, pool: 'forks', execArgv: vitestExecArgv,
  },
})
