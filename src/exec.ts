/** Agent-owned persistent command tools over the public terminal and jobs interfaces. */
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TerminalSessionId, TerminalError } from '@deepseek-ai/dsh-terminal'
import type { TerminalSendOperation, TerminalWaitReason } from '@deepseek-ai/dsh-terminal'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-working-directory'
import z from '@deepseek-ai/schemastery'
import { delta, response } from './output.js'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap { 'focus-session': 'focus-session' }
}

/** Cordis identity. */
export const name = 'focus-command-tools'
/** Required host and preset-private capabilities. */
export const inject = ['tools', 'systemPrompt', 'terminals', 'workingDirectory', 'jobs']
/** Deployment bounds, validated before registering tools. */
export const Config = z.object({
  backendType: z.string().default('shell'),
  maxSessionsPerAgent: z.number().step(1).min(1).max(64).default(4),
  maxResultBytes: z.number().step(1).min(256).max(16 * 1024 * 1024).default(262144),
  yieldMs: z.number().step(1).min(0).max(60000).default(1000),
  pollMs: z.number().step(1).min(1).max(10000).default(50),
  readLines: z.number().step(1).min(1).max(100000).default(10000),
})
type Settings = ReturnType<typeof Config>
interface Args { session_id: string; chars?: string; run_in_background?: boolean; close?: boolean }
interface RecordState {
  owner: Agent
  id: ReturnType<typeof TerminalSessionId>
  cursor: string
  wait: TerminalWaitReason
  operation?: TerminalSendOperation
  failure?: Error
  busy: boolean
  monitor?: AbortController
  closing?: Promise<void>
}

/** Bind two command tools, with plugin-owned cursors and bounded session counts.
 * @param ctx Preset-private terminal context.
 * @param input Deployment configuration.
 */
export function apply(ctx: Context, input: Partial<Settings> = {}): void {
  const config = Config(input)
  const owners = new Map<Agent, Map<string, RecordState>>()
  const reservations = new Map<Agent, number>()

  const page = (state: RecordState) => {
    const current = ctx.terminals.read(state.owner, state.id, { offset: 0, count: config.readLines })
    // The backend's truncated flag covers retention/byte loss, not pagination.
    return { ...current, truncated: current.truncated || current.lineEnd < current.totalLines }
  }
  const snapshot = (state: RecordState) => {
    const value = ctx.terminals.list(state.owner).find(session => session.sessionId === state.id)
    if (value === undefined) throw new TerminalError(`unknown focus session ${state.id}`, 'NO_SESSION')
    return value
  }
  const read = (state: RecordState): string => {
    const current = page(state)
    const fresh = delta(state.cursor, current.text)
    const incomplete = fresh.gap || (current.truncated && current.text !== state.cursor)
    state.cursor = current.text
    const status = snapshot(state).status
    const detail = status.kind === 'exited'
      ? `shell exited: ${status.exitCode ?? status.signal}`
      : `shell running; send ${state.operation === undefined ? 'settled' : 'pending'}; wait ${state.wait}`
    const header = `[session ${state.id} | ${detail}]`
    return response(header, `${incomplete ? '[retained output may be incomplete]\n' : ''}${fresh.text}`, config.maxResultBytes)
  }
  const close = (state: RecordState): Promise<void> => {
    if (state.closing !== undefined) return state.closing
    state.closing = Promise.resolve().then(async () => {
      state.monitor?.abort()
      try { await ctx.terminals.kill(state.owner, state.id, 'focus-mode session closed') }
      catch (error) { if (!(error instanceof TerminalError && error.code === 'NO_SESSION')) throw error }
      owners.get(state.owner)?.delete(state.id)
    }).catch(error => { delete state.closing; throw error })
    return state.closing
  }
  ctx.effect(() => async () => {
    await Promise.all([...owners.values()].flatMap(records => [...records.values()].map(close)))
    owners.clear()
    reservations.clear()
  }, 'focus sessions')

  const find = (owner: Agent, id: string) => {
    // Registry performs the authoritative cross-agent ownership check first.
    ctx.terminals.read(owner, TerminalSessionId(id), { count: 1 })
    const state = owners.get(owner)?.get(id)
    if (state === undefined) throw new TerminalError(`session ${id} was not opened by focus-mode`, 'NO_SESSION')
    return state
  }
  const create = async (owner: Agent, cwd: string | undefined, signal: AbortSignal) => {
    let records = owners.get(owner)
    if (records === undefined) {
      records = new Map()
      owners.set(owner, records)
      owner.ctx.effect(() => () => { owners.delete(owner); reservations.delete(owner) }, 'focus cursors')
    }
    const pending = reservations.get(owner) ?? 0
    if (records.size + pending >= config.maxSessionsPerAgent) throw new Error(`focus-mode session limit ${config.maxSessionsPerAgent}; close an existing session with write_stdin(close: true)`)
    reservations.set(owner, pending + 1)
    try {
      const base = await ctx.workingDirectory.ensure(owner, signal)
      const value = await ctx.terminals.spawn(owner, { type: config.backendType, ...cwd === undefined ? {} : { cwd: resolve(base, cwd) } }, signal)
      const state: RecordState = { owner, id: TerminalSessionId(value.sessionId), cursor: '', wait: 'inferred_idle', busy: false }
      records.set(state.id, state)
      return state
    } finally {
      reservations.set(owner, (reservations.get(owner) ?? 1) - 1)
    }
  }
  const start = (state: RecordState, text: string, submit: boolean) => {
    if (state.operation !== undefined) throw new TerminalError(`session ${state.id} has an active send; poll, interrupt, or close it`, 'SEND_ACTIVE')
    const operation = ctx.terminals.startSend(state.owner, state.id, { text, submit })
    state.operation = operation
    delete state.failure
    // Observe every rejection even after a yielded call has returned.
    void operation.done.then(result => {
      state.wait = result.waitReason
      if (state.operation === operation) delete state.operation
    }, error => {
      state.failure = error instanceof Error ? error : new Error(String(error))
      if (state.operation === operation) delete state.operation
    })
  }
  const poll = async (state: RecordState, signal: AbortSignal, waitForSend: boolean, preserveSession = true) => {
    const abort = () => state.operation?.cancel()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try {
      const deadline = Date.now() + config.yieldMs
      while (true) {
        signal.throwIfAborted()
        if (state.failure !== undefined) throw state.failure
        const current = page(state)
        const hasOutput = current.text !== state.cursor
        if ((waitForSend ? state.operation === undefined : hasOutput)
          || snapshot(state).status.kind === 'exited' || Date.now() >= deadline) return read(state)
        await delay(Math.min(config.pollMs, Math.max(1, deadline - Date.now())), undefined, { signal })
      }
    } catch (error) {
      if (signal.aborted && preserveSession) {
        // A known session remains owned by the caller. Drain its interrupted
        // send before accepting another command in that same shell.
        const operation = state.operation
        if (operation !== undefined) {
          operation.cancel()
          try { await operation.done }
          catch (drainError) {
            throw new AggregateError([error, drainError], response(
              `[session ${state.id} | interrupt failed]`,
              `Close this session before retrying. ${drainError instanceof Error ? drainError.message : String(drainError)}`,
              config.maxResultBytes - Buffer.byteLength('Error: '),
            ))
          }
        }
      }
      throw error
    } finally { signal.removeEventListener('abort', abort) }
  }
  const background = (state: RecordState, exec: ToolRunContext, send?: { text: string; submit: boolean }): string => {
    if (state.monitor !== undefined) throw new Error(`session ${state.id} already has a background monitor; use job_output or write_stdin`)
    const controller = new AbortController()
    state.monitor = controller
    let cursor = state.cursor
    let killing = false
    let jobId
    try { jobId = ctx.jobs.start({
      kind: 'focus-session', label: `persistent session ${state.id}`, owner: state.owner.id,
      toolCall: { callId: exec.callId, rootCallId: exec.rootCallId }, outputLimitBytes: config.maxResultBytes,
      run(job) {
        if (send !== undefined) start(state, send.text, send.submit)
        const pump = async () => {
          try {
            while (true) {
              const current = page(state)
              const fresh = delta(cursor, current.text)
              const incomplete = fresh.gap || (current.truncated && current.text !== cursor)
              cursor = current.text
              if (incomplete) job.append('[retained output may be incomplete]\n')
              job.append(fresh.text)
              if (state.failure !== undefined) throw state.failure
              if (snapshot(state).status.kind === 'exited') return { status: 'completed' as const }
              await delay(config.pollMs, undefined, { signal: controller.signal })
            }
          } catch (error) {
            if (controller.signal.aborted) {
              if (killing) await close(state)
              else await state.closing
              return { status: 'killed' as const }
            }
            return { status: 'failed' as const, detail: String(error) }
          } finally { if (state.monitor === controller) delete state.monitor }
        }
        return { cancel: () => { killing = true; controller.abort() }, done: pump() }
      },
    }) } catch (error) {
      controller.abort()
      delete state.monitor
      throw error
    }
    return response(`[session ${state.id} | background job ${jobId}]`, 'Use job_output to collect output. job_kill closes this entire shell. The job monitors the persistent session until it exits or is closed; it does not certify individual command completion.', config.maxResultBytes)
  }
  const ownerOf = (exec: ToolRunContext) => {
    if (exec.agent === undefined) throw new Error('focus command tools require an initiating Agent')
    return exec.agent
  }
  const withState = async (state: RecordState, run: () => Promise<string>) => {
    if (state.busy) throw new TerminalError(`session ${state.id} already has a command-tool call in progress`, 'SEND_ACTIVE')
    state.busy = true
    try { return await run() } finally { state.busy = false }
  }
  const output = {
    schema: { type: 'string' as const },
    render: (_args: unknown, text: string) => [{ type: 'text' as const, text }],
  }
  const finalizeContent: NonNullable<ToolDefinition['finalizeContent']> = (_exec, result) => {
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (Buffer.byteLength(text) <= config.maxResultBytes) return undefined
    return [{ type: 'text', text: response('[focus command result]', text, config.maxResultBytes) }]
  }
  ctx.tools.register(defineTool({
    name: 'exec_command',
    description: 'Run a command in an Agent-owned persistent shell. Reuse session_id to keep cwd and environment. Returns after a bounded wait; a running shell or settled send does not prove the command completed. run_in_background returns a job monitoring this session; job_kill closes the shell.',
    parameters: {
      cmd: { type: 'string', required: true }, session_id: { type: 'string' }, cwd: { type: 'string' },
      run_in_background: { type: 'boolean' },
    },
    output, finalizeContent,
    async execute(args: { cmd: string; session_id?: string; cwd?: string; run_in_background?: boolean }, exec) {
      if (args.cmd.trim().length === 0) throw new Error('cmd must not be empty')
      if (args.session_id !== undefined && args.cwd !== undefined) throw new Error('cwd applies only to a new session; use cd to change an existing shell')
      const owner = ownerOf(exec)
      const fresh = args.session_id === undefined
      const state = fresh ? await create(owner, args.cwd, exec.signal) : find(owner, args.session_id!)
      return withState(state, async () => {
        try {
          exec.signal.throwIfAborted()
          if (args.run_in_background === true) return background(state, exec, { text: args.cmd, submit: true })
          start(state, args.cmd, true)
          return await poll(state, exec.signal, true, !fresh)
        } catch (error) {
          if (fresh) {
            try { await close(state) }
            catch (cleanupError) {
              throw new AggregateError([error, cleanupError], response(
                `[session ${state.id} | cleanup failed]`,
                `Use write_stdin(close: true) to retry cleanup. ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
                config.maxResultBytes - Buffer.byteLength('Error: '),
              ))
            }
          }
          throw error
        }
      })
    },
    presentCall: args => ({ card: 'terminal', title: args.cmd }),
  }))
  ctx.tools.register(defineTool({
    name: 'write_stdin',
    description: 'Read new output since the previous foreground call, or send chars verbatim to the same shell. A newline submits input, Ctrl-C interrupts. Set close:true to close the shell and release its session slot. run_in_background starts a session-monitor job; job_kill closes the shell.',
    parameters: {
      session_id: { type: 'string', required: true }, chars: { type: 'string' },
      run_in_background: { type: 'boolean' }, close: { type: 'boolean' },
    },
    output, finalizeContent,
    async execute(args: Args, exec) {
      const state = find(ownerOf(exec), args.session_id)
      return withState(state, async () => {
        if (args.close === true) {
          if (args.chars !== undefined || args.run_in_background === true) throw new Error('close cannot be combined with chars or run_in_background')
          await close(state)
          return `[session ${state.id} | closed]`
        }
        if (args.run_in_background === true && state.monitor !== undefined) throw new Error(`session ${state.id} already has a background monitor`)
        if (args.run_in_background === true && args.chars !== '\u0003') {
          return background(state, exec, args.chars === undefined || args.chars.length === 0 ? undefined : { text: args.chars, submit: false })
        }
        if (args.chars !== undefined && args.chars.length > 0) {
          if (args.chars === '\u0003') await ctx.terminals.signal(state.owner, state.id, 'SIGINT')
          else start(state, args.chars, false)
        }
        return args.run_in_background === true ? background(state, exec) : poll(state, exec.signal, args.chars !== undefined)
      })
    },
    presentCall: args => ({ card: 'terminal', title: args.close ? '(close)' : args.chars ?? '(read)', description: args.session_id }),
  }))
  ctx.systemPrompt.section({
    name: 'tool:focus-commands', order: ctx.systemPrompt.getSectionOrder('TOOL_PTY'),
    text: 'exec_command starts a persistent shell. Keep its session_id for write_stdin or later commands. Poll to read output produced between calls. A shell running, a timeout, or a settled send is not proof the command finished. Background jobs monitor entire sessions; job_kill closes that shell. Use write_stdin with close:true when a session is no longer needed.',
  })
}
