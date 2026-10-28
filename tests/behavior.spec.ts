/** Keyless Loader/PTY integration and public executor behavior. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ResolvedToolSet } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Terminals from '@deepseek-ai/dsh-terminal'
import * as Bash from '@deepseek-ai/dsh-terminal-bash'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv } from '@deepseek-ai/dsh-sandbox'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import Jobs from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import * as Native from '@deepseek-ai/dsh-tool-executor-native'
import PtcRuntime from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcRunRequest, PtcRunSpec, PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import { provideWorkingDirectoryFixture, unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as Commands from '../src/exec.ts'
import * as Hybrid from '../src/hybrid.ts'
import { delta, response } from '../src/output.ts'

class TestSandbox extends Sandbox {
  async confine(argv: readonly string[]): Promise<ConfinedArgv> {
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}
class BindingRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test-binding'
  last?: PtcRunSpec
  resolve(request: PtcRunRequest): PtcRunSpec { return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: 5000 } }
  async run(spec: PtcRunSpec): Promise<PtcRunResult> {
    this.last = spec
    const tools = spec.bindings.find(binding => binding.global === 'tools')!.functions
    if (spec.program === 'inspect') return { logs: [], value: Object.keys(tools) }
    const fn = tools[spec.program]
    if (fn === undefined) return { logs: [], error: { kind: 'exception', message: `No binding ${spec.program}` } }
    try { return { logs: [], value: await fn({}) } }
    catch (error) { return { logs: [], error: { kind: 'exception', message: String(error) } } }
  }
}
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function boot(options: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'focus-codex-'))
  cleanup.push(() => rm(directory, { force: true, recursive: true }))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  provideWorkingDirectoryFixture(ctx, directory)
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['prompt', SystemPrompt], ['tools', ToolRuntime], ['native', Native],
    ['projections', Projections], ['agents', AgentRegistry], ['terminals', Terminals],
    ['sandbox', TestSandbox], ['policy', Policy], ['subprocess', Subprocess],
    ['bash', Bash], ['jobs', Jobs], ['tool-jobs', ToolJobs], ['commands', Commands], ['runtime', BindingRuntime], ['hybrid', Hybrid],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const value = modules.get(specifier)
      if (value === undefined) throw new Error(`Unknown fixture module ${specifier}`)
      return value
    },
  } as NonNullable<typeof ctx.loader.internal>
  const rows = [
    { name: 'prompt' }, { name: 'tools' }, { name: 'native' }, { name: 'projections' },
    { name: 'agents' }, { name: 'terminals' }, { name: 'sandbox' },
    { name: 'policy', config: { mode: 'danger-full-access', workspaceRoot: directory } },
    { name: 'subprocess' }, { name: 'jobs' }, { name: 'tool-jobs', config: { completionDelivery: 'quiet' } },
    { name: 'bash', config: { timeoutMs: 3000, idleSilenceMs: 100, handoffGraceMs: 100, pollIntervalMs: 10, disposeGraceMs: 500 } },
    { name: 'commands', config: { yieldMs: 500, pollMs: 10, ...options } },
    { name: 'runtime' },
  ]
  const path = join(directory, 'cordis.yml')
  await writeFile(path, JSON.stringify(rows))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  const makeOwner = async (id: string) => {
    const fiber = ctx.plugin(() => {})
    const owner: Agent = {
      id: SessionId(id), options: {}, session: Session.create(SessionId(id)), model: unsupportedModel(),
      inbox: unsupportedInbox(), status: 'idle', ctx: fiber.ctx,
      send() {}, followup() {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
      inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
    }
    await ctx.agents.register(owner)
    return owner
  }
  const owner = await makeOwner('focus-test-owner')
  let callIndex = 0
  const call = async (name: string, args: object, agent = owner, signal = new AbortController().signal, toolSet?: ResolvedToolSet) => {
    const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: ToolCallId(`focus-${++callIndex}`), name, arguments: JSON.stringify(args) }], agent, signal, ...toolSet === undefined ? {} : { toolSet } })
    const result = batch.results[0]!.result
    return { result, text: result.content.filter(block => block.type === 'text').map(block => block.text).join('') }
  }
  return { ctx, owner, call, makeOwner, directory }
}
const idOf = (text: string) => { const value = /^\[session (\S+) \|/.exec(text)?.[1]; if (!value) throw new Error(text); return value }
async function until(check: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (!check()) { if (Date.now() > deadline) throw new Error('condition timed out'); await delay(20) }
}

describe('persistent commands through the real Loader and PTY backend', () => {
  it('preserves cwd/environment and reuses one session', async () => {
    const { ctx, owner, call } = await boot()
    const first = await call('exec_command', { cmd: 'cd /tmp; export FOCUS_VALUE=kept' })
    const id = idOf(first.text)
    const second = await call('exec_command', { session_id: id, cmd: 'pwd; printf "VALUE=%s\\n" "$FOCUS_VALUE"' })
    expect(second.text).toContain('/tmp')
    expect(second.text).toContain('VALUE=kept')
    expect(ctx.terminals.list(owner)).toHaveLength(1)
  })
  it('returns output produced between calls once, rather than losing or replaying it', async () => {
    const { ctx, owner, call } = await boot()
    const first = await call('exec_command', { cmd: "sleep 0.8; printf 'FOCUS_GAP_%s\\n' OUTPUT" })
    const id = idOf(first.text)
    expect(first.text).not.toContain('FOCUS_GAP_OUTPUT')
    const terminal = ctx.terminals.list(owner)[0]!
    await until(() => ctx.terminals.read(owner, terminal.sessionId).text.includes('FOCUS_GAP_OUTPUT'))
    expect((await call('write_stdin', { session_id: id })).text).toContain('FOCUS_GAP_OUTPUT')
    expect((await call('write_stdin', { session_id: id })).text).not.toContain('FOCUS_GAP_OUTPUT')
  })
  it('reports the initial readLines page gap instead of silently discarding earlier lines', async () => {
    const { call } = await boot({ readLines: 3, maxResultBytes: 10000 })
    const value = await call('exec_command', { cmd: 'for i in $(seq 1 20); do printf "FIRST_PAGE_%s\\n" "$i"; done' })
    expect(value.result.isError, value.text).not.toBe(true)
    expect(value.text).toContain('FIRST_PAGE_20')
    expect(value.text).toContain('[retained output may be incomplete]')
    await expect(value.text.replace(/wait \w+/, 'wait <readiness>')).toMatchFileSnapshot('./snapshots/paged-output.txt')
  })
  it('reports a paged output gap produced between foreground calls', async () => {
    const { ctx, owner, call } = await boot({ readLines: 3 })
    const first = await call('exec_command', { cmd: 'sleep 0.8; for i in $(seq 1 20); do printf "LATER_PAGE_%s\\n" "$i"; done' })
    const id = idOf(first.text)
    const terminal = ctx.terminals.list(owner)[0]!
    await until(() => ctx.terminals.read(owner, terminal.sessionId).text.includes('LATER_PAGE_20'))
    const polled = await call('write_stdin', { session_id: id })
    expect(polled.text).toContain('[retained output may be incomplete]')
    expect(polled.text).toContain('LATER_PAGE_20')
    expect((await call('write_stdin', { session_id: id })).text).not.toContain('LATER_PAGE_20')
  })
  it('reports a background monitor page gap and preserves its bounded output', async () => {
    const { ctx, owner, call } = await boot({ readLines: 3, pollMs: 100, maxResultBytes: 256 })
    const started = await call('exec_command', { cmd: 'for i in $(seq 1 20); do printf "BACKGROUND_PAGE_%s\\n" "$i"; done; sleep 30', run_in_background: true })
    expect(started.result.isError, started.text).not.toBe(true)
    const job = ctx.jobs.list(owner.id)[0]!
    await until(() => ctx.jobs.readAt(job.id, 0, owner.id).chunks.some(chunk => chunk.text.includes('BACKGROUND_PAGE_20')))
    const output = await call('job_output', { job_id: job.id })
    expect(output.text).toContain('incomplete')
    expect(Buffer.byteLength(output.text)).toBeLessThanOrEqual(256)
    await call('job_kill', { job_id: job.id })
  })
  it('accepts stdin, bounds sessions, closes and releases the slot', async () => {
    const { call } = await boot({ maxSessionsPerAgent: 1 })
    const first = await call('exec_command', { cmd: 'read -r line; printf "RECEIVED=%s\\n" "$line"' })
    const id = idOf(first.text)
    const written = await call('write_stdin', { session_id: id, chars: 'input-value\n' })
    expect(written.text).toContain('RECEIVED=input-value')
    expect((await call('exec_command', { cmd: 'echo another' })).result.isError).toBe(true)
    expect((await call('write_stdin', { session_id: id, close: true })).text).toContain('closed')
    expect((await call('exec_command', { cmd: 'echo replacement' })).result.isError).not.toBe(true)
  })
  it('enforces exact Agent ownership', async () => {
    const { call, makeOwner } = await boot()
    const id = idOf((await call('exec_command', { cmd: 'echo owned' })).text)
    const other = await makeOwner('other-agent')
    const denied = await call('write_stdin', { session_id: id }, other)
    expect(denied.result.isError).toBe(true)
    expect(denied.text).toContain('another agent')
  })
  it('bounds terminal failures as well as successful output', async () => {
    const { call } = await boot({ maxResultBytes: 256 })
    const value = await call('write_stdin', { session_id: '不存在😀'.repeat(2000) })
    expect(value.result.isError).toBe(true)
    expect(Buffer.byteLength(value.text)).toBeLessThanOrEqual(256)
    expect(value.text).not.toContain('\uFFFD')
  })
  it('background jobs actually collect later output and kill the whole session', async () => {
    const { ctx, owner, call } = await boot()
    const first = await call('exec_command', { cmd: "sleep 0.2; printf 'FOCUS_JOB_%s\\n' OUTPUT; sleep 30", run_in_background: true })
    expect(first.result.isError, first.text).not.toBe(true)
    expect(first.text).toContain('background job')
    const job = ctx.jobs.list(owner.id)[0]!
    await until(() => ctx.jobs.readAt(job.id, 0, owner.id).chunks.some(chunk => chunk.text.includes('FOCUS_JOB_OUTPUT')))
    expect((await call('job_output', { job_id: job.id })).text).toContain('FOCUS_JOB_OUTPUT')
    expect((await call('job_kill', { job_id: job.id })).result.isError).not.toBe(true)
    await ctx.jobs.wait(job.id, 5000, owner.id)
    expect(ctx.jobs.get(job.id, owner.id).status).toBe('killed')
    expect(ctx.terminals.list(owner)).toHaveLength(0)
  })
  it('aborting a foreground wait interrupts its send and plugin disposal closes shells', async () => {
    const { ctx, owner, call } = await boot({ yieldMs: 5000 })
    const controller = new AbortController()
    const pending = call('exec_command', { cmd: 'sleep 30' }, owner, controller.signal)
    await until(() => ctx.terminals.list(owner).length === 1)
    controller.abort()
    expect((await pending).result.isError).toBe(true)
    const terminals = ctx.terminals
    await ctx.fiber.dispose()
    expect(terminals.list(owner)).toHaveLength(0)
  })
  it('reclaims a new session and its quota when cancelled before returning its handle', async () => {
    const { ctx, owner, call } = await boot({ yieldMs: 5000, maxSessionsPerAgent: 1 })
    const controller = new AbortController()
    const pending = call('exec_command', { cmd: 'sleep 30' }, owner, controller.signal)
    await until(() => ctx.terminals.list(owner).length === 1)
    controller.abort()
    expect((await pending).result.isError).toBe(true)
    expect(ctx.terminals.list(owner)).toHaveLength(0)
    const retried = await call('exec_command', { cmd: 'printf RETRY_AFTER_CANCEL' })
    expect(retried.result.isError, retried.text).not.toBe(true)
    expect(retried.text).toContain('RETRY_AFTER_CANCEL')
  })
  it('keeps an existing session recoverable after cancelling a later command', async () => {
    const { ctx, owner, call } = await boot({ yieldMs: 5000, maxSessionsPerAgent: 1 })
    const id = idOf((await call('exec_command', { cmd: 'export FOCUS_CANCEL_STATE=kept' })).text)
    const controller = new AbortController()
    const pending = call('exec_command', { session_id: id, cmd: 'sleep 30' }, owner, controller.signal)
    // Wait for the existing send to begin, without relying on a fixed delay.
    const terminal = ctx.terminals.list(owner)[0]!
    await until(() => ctx.terminals.read(owner, terminal.sessionId).text.includes('sleep 30'))
    controller.abort()
    expect((await pending).result.isError).toBe(true)
    expect(ctx.terminals.list(owner)).toHaveLength(1)
    const recovered = await call('exec_command', { session_id: id, cmd: 'printf "STATE=%s\\n" "$FOCUS_CANCEL_STATE"' })
    expect(recovered.result.isError, recovered.text).not.toBe(true)
    expect(recovered.text).toContain('STATE=kept')
  })
  it('returns a bounded recovery handle and cause if fresh-session cleanup fails', async () => {
    const { ctx, owner, call } = await boot({ yieldMs: 5000, maxSessionsPerAgent: 1, maxResultBytes: 256 })
    const controller = new AbortController()
    const pending = call('exec_command', { cmd: 'sleep 30' }, owner, controller.signal)
    await until(() => ctx.terminals.list(owner).length === 1)
    const cleanup = vi.spyOn(Terminals.prototype, 'kill').mockRejectedValueOnce(new Error('CLEANUP_PROBE_FAILURE'))
    let failed: Awaited<typeof pending>
    try { controller.abort(); failed = await pending }
    finally { cleanup.mockRestore() }
    expect(failed.result.isError).toBe(true)
    expect(failed.text).toContain('cleanup failed')
    expect(failed.text).toContain('CLEANUP_PROBE_FAILURE')
    expect(Buffer.byteLength(failed.text)).toBeLessThanOrEqual(256)
    const id = idOf(failed.text.replace(/^Error: /, ''))
    expect((await call('write_stdin', { session_id: id, close: true })).result.isError).not.toBe(true)
    expect(ctx.terminals.list(owner)).toHaveLength(0)
    expect((await call('exec_command', { cmd: 'printf RECOVERED_QUOTA' })).result.isError).not.toBe(true)
  })
})

describe('public hybrid executor', () => {
  it('projects the registry view and retains its restrictions, guards and durable dispatch', async () => {
    const { ctx, owner, call } = await boot()
    ctx.tools.register(defineTool({ name: 'web_search', description: 'probe', parameters: {}, output: { schema: { type: 'string' }, render: (_a, value: string) => [{ type: 'text', text: value }] }, execute: () => 'probe-success' }))
    ctx.tools.register(defineTool({ name: 'host_secret', description: 'hidden', parameters: {}, output: { schema: { type: 'string' }, render: (_a, value: string) => [{ type: 'text', text: value }] }, execute: () => { throw new Error('hidden body must not run') } }))
    let focused!: Context
    await ctx.plugin(Object.assign((inner: Context) => { focused = createScope(inner, owner).ctx }, { inject: ['tools', 'systemPrompt', 'ptcRuntime'] }))
    focused.tools.restrict({ deny: ['host_secret'] })
    const fiber = await focused.plugin(Hybrid)
    const assembly = await ctx.systemPrompt.assemble({ scope: owner })
    expect(assembly.tools.map(tool => tool.name).sort()).toEqual([...ctx.tools.schemas(owner).map(tool => tool.name), 'run_code'].sort())
    expect(renderPrompt(assembly)).not.toContain('only tool you can call directly')
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')!.text
    expect(sdk).not.toContain('host_secret')
    expect(sdk).not.toMatch(/^\s+run_code:/m)
    expect((await call('web_search', {})).text).toContain('probe-success')
    expect((await call('host_secret', {})).result.isError).toBe(true)
    expect((await call('run_code', { code: 'web_search', description: 'Call a permitted probe' })).text).toContain('probe-success')
    expect((await call('run_code', { code: 'host_secret', description: 'Try a hidden probe' })).result.isError).toBe(true)
    const bindings = await call('run_code', { code: 'inspect', description: 'Inspect available program bindings' })
    expect(bindings.text).not.toContain('run_code')
    expect(bindings.text).not.toContain('host_secret')
    const bodies: string[] = []
    ctx.tools.guard(exec => { if (exec.name === 'web_search') { bodies.push(exec.parent === undefined ? 'direct' : 'nested'); return 'guard denied' } })
    expect((await call('web_search', {})).result.isError).toBe(true)
    expect((await call('run_code', { code: 'web_search', description: 'Test nested guard behavior' })).result.isError).toBe(true)
    expect(bodies).toEqual(['direct', 'nested'])
    expect(owner.session.snapshotEvents().some(event => event.type === 'tool/ptc-dispatch-start')).toBe(true)
    await fiber.dispose()
    await expect(ctx.systemPrompt.assemble({ scope: owner })).rejects.toThrow('unavailable')
  })
  it('selects hybrid for one scope while other scopes keep native behavior', async () => {
    const { ctx, owner } = await boot()
    let focused!: Context
    await ctx.plugin(Object.assign((inner: Context) => { focused = createScope(inner, owner).ctx }, { inject: ['tools', 'systemPrompt', 'ptcRuntime'] }))
    await focused.plugin(Hybrid)
    expect((await ctx.systemPrompt.assemble({ scope: owner })).tools.some(tool => tool.name === 'run_code')).toBe(true)
    expect((await ctx.systemPrompt.assemble()).tools.some(tool => tool.name === 'run_code')).toBe(false)
  })
  it('discovers arbitrary tool names and follows registration and removal on both routes', async () => {
    const { ctx, owner, call } = await boot()
    let focused!: Context
    await ctx.plugin(Object.assign((inner: Context) => { focused = createScope(inner, owner).ctx }, { inject: ['tools', 'systemPrompt', 'ptcRuntime'] }))
    await focused.plugin(Hybrid)
    const toolName = 'extension_' + randomUUID().replaceAll('-', '_')
    const dispose = ctx.tools.register(defineTool({
      name: toolName, description: 'A separately installed extension.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value: string) => [{ type: 'text', text: value }] },
      execute: () => 'EXTENSION_RESULT',
    }))
    const assembly = await ctx.systemPrompt.assemble({ scope: owner })
    expect(assembly.tools.map(tool => tool.name)).toContain(toolName)
    expect(assembly.sections.find(section => section.name === 'tools:sdk')?.text).toContain(toolName)
    expect((await call(toolName, {})).text).toContain('EXTENSION_RESULT')
    expect((await call('run_code', { code: toolName, description: 'Call a newly registered extension' })).text).toContain('EXTENSION_RESULT')
    dispose()
    const after = await ctx.systemPrompt.assemble({ scope: owner })
    expect(after.tools.map(tool => tool.name)).not.toContain(toolName)
    expect(after.sections.find(section => section.name === 'tools:sdk')?.text).not.toContain(toolName)
    expect((await call(toolName, {})).result.isError).toBe(true)
    expect((await call('run_code', { code: toolName, description: 'Try an unloaded extension' })).result.isError).toBe(true)
  })
  it('preserves conditional step admission without granting later or disposed capabilities', async () => {
    const { ctx, owner, call } = await boot()
    let focused!: Context
    await ctx.plugin(Object.assign((inner: Context) => { focused = createScope(inner, owner).ctx }, { inject: ['tools', 'systemPrompt', 'ptcRuntime'] }))
    await focused.plugin(Hybrid)
    let enabled = false
    let bodies = 0
    const toolName = 'conditional_' + randomUUID().replaceAll('-', '_')
    ctx.tools.register(defineTool({
      name: toolName, description: 'Conditionally available extension.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value: string) => [{ type: 'text', text: value }] },
      execute: () => { bodies++; return 'ADMITTED_RESULT' },
    }), { when: () => enabled })
    const signal = new AbortController().signal
    const admission = () => ctx.tools.resolve({ agent: owner, modelSelection: { provider: 'test', model: 'test' }, signal })
    const denied = await admission()
    enabled = true
    expect((await call(toolName, {}, owner, signal, denied)).result.isError).toBe(true)
    expect((await call('run_code', { code: toolName, description: 'Check the previous step admission' }, owner, signal, denied)).result.isError).toBe(true)
    const admitted = await admission()
    const assembly = await ctx.systemPrompt.assemble({ scope: owner, toolSet: admitted })
    expect(assembly.tools.map(tool => tool.name)).toContain(toolName)
    expect((await call(toolName, {}, owner, signal, admitted)).text).toContain('ADMITTED_RESULT')
    expect((await call('run_code', { code: toolName, description: 'Call an admitted extension' }, owner, signal, admitted)).text).toContain('ADMITTED_RESULT')
    expect(bodies).toBe(2)
    admitted.dispose()
    expect((await call(toolName, {}, owner, signal, admitted)).result.isError).toBe(true)
    expect((await call('run_code', { code: toolName, description: 'Try a disposed admission' }, owner, signal, admitted)).result.isError).toBe(true)
    denied.dispose()
  })
  it('keeps mixed batch result order and logs every root exactly once', async () => {
    const { ctx, owner } = await boot()
    ctx.tools.register(defineTool({ name: 'web_search', description: 'probe', parameters: {}, output: { schema: { type: 'string' }, render: (_a, value: string) => [{ type: 'text', text: value }] }, execute: () => 'batched-probe' }))
    let focused!: Context
    await ctx.plugin(Object.assign((inner: Context) => { focused = createScope(inner, owner).ctx }, { inject: ['tools', 'systemPrompt', 'ptcRuntime'] }))
    await focused.plugin(Hybrid)
    const batch = await ctx.tools.execute({
      agent: owner, signal: new AbortController().signal, log: { turn: 1, step: 1 },
      calls: [
        { type: 'tool-call', id: ToolCallId('batch-1'), name: 'web_search', arguments: '{}' },
        { type: 'tool-call', id: ToolCallId('batch-2'), name: 'run_code', arguments: JSON.stringify({ code: 'web_search', description: 'Call a probe inside batch' }) },
        { type: 'tool-call', id: ToolCallId('batch-3'), name: 'web_search', arguments: '{}' },
      ],
    })
    expect(batch.results.map(value => value.callId)).toEqual(['batch-1', 'batch-2', 'batch-3'])
    expect(batch.results.every(value => value.result.isError !== true)).toBe(true)
    const events = owner.session.snapshotEvents()
    expect(events.filter(event => event.type === 'tool/call')).toHaveLength(3)
    expect(events.filter(event => event.type === 'tool/result')).toHaveLength(3)
    expect(events.filter(event => event.type === 'tool/ptc-dispatch-start')).toHaveLength(1)
    await expect(JSON.stringify(events.filter(event => event.type === 'tool/call' || event.type === 'tool/result' || event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch').map(event => event.type), null, 2) + '\n').toMatchFileSnapshot('./snapshots/mixed-session-events.json')
  })
})

describe('bounded output and cursor behavior', () => {
  it('retains a tail within the complete response cap without damaging Unicode', () => {
    const value = response('[session pty-1 | running]', '汉字😀'.repeat(1000) + 'TAIL', 256)
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(256)
    expect(value).toContain('pty-1')
    expect(value).toContain('truncated')
    expect(value).toContain('TAIL')
    expect(value).not.toContain('\uFFFD')
  })
  it('recognizes rolled scrollback and explicit gaps', () => {
    expect(delta('a\nb\n', 'b\nc\n')).toEqual({ text: 'c\n', gap: false })
    expect(delta('old', 'new')).toEqual({ text: 'new', gap: true })
    expect(delta('same', 'same')).toEqual({ text: '', gap: false })
  })
})
