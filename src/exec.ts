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
import { clipTail, delta, response } from './output.js'

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
  maxBackgroundJobsPerAgent: z.number().step(1).min(1).max(64).default(2),
  reuseMostRecentSession: z.boolean().default(true),
  maxResultBytes: z.number().step(1).min(256).max(16 * 1024 * 1024).default(262144),
  yieldMs: z.number().step(1).min(0).max(60000).default(1000),
  pollMs: z.number().step(1).min(1).max(10000).default(50),
  readLines: z.number().step(1).min(1).max(100000).default(10000),
})
type Settings = ReturnType<typeof Config>
interface ExecArgs { cmd: string; session_id?: string; cwd?: string; run_in_background?: boolean; new_session?: boolean }
interface WriteArgs { session_id: string; chars?: string; run_in_background?: boolean; close?: boolean }
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
  used: number
}
type ShellStatus = 'running' | 'exited' | 'closed'
type SendState = 'settled' | 'pending' | 'none'

/** One command-tool result: shell identity, readiness, and the observed output window. */
interface CommandOutput {
  session_id: string
  status: ShellStatus
  created: boolean
  closed: boolean
  send: SendState
  wait: string
  text: string
  incomplete: boolean
  exit_code?: number
  signal?: string
  job_id?: string
}
/** One owned shell as reported by the listing tool. */
interface SessionView {
  session_id: string
  status: ShellStatus
  busy: boolean
  background: boolean
  most_recent: boolean
}
interface SessionListOutput { sessions: SessionView[] }

const COMMAND_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    session_id: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['running', 'exited', 'closed'] },
    created: { type: 'boolean', required: true },
    closed: { type: 'boolean', required: true },
    send: { type: 'string', required: true, enum: ['settled', 'pending', 'none'] },
    wait: { type: 'string', required: true },
    text: { type: 'string', required: true },
    incomplete: { type: 'boolean', required: true },
    exit_code: { type: 'number' },
    signal: { type: 'string' },
    job_id: { type: 'string' },
  },
} as const
const SESSION_LIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessions: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['running', 'exited', 'closed'] },
          busy: { type: 'boolean', required: true },
          background: { type: 'boolean', required: true },
          most_recent: { type: 'boolean', required: true },
        },
      },
    },
  },
} as const

/** Bind command tools, sticky shells, plugin-owned cursors, and bounded session counts.
 * @param ctx Preset-private terminal context.
 * @param input Deployment configuration.
 */
export function apply(ctx: Context, input: Partial<Settings> = {}): void {
  const config = Config(input)
  const owners = new Map<Agent, Map<string, RecordState>>()
  const reservations = new Map<Agent, number>()
  let usage = 0

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
  /** Registry status that does not fail for a shell the backend already released. */
  const statusOf = (state: RecordState): ShellStatus => {
    try { return snapshot(state).status.kind === 'exited' ? 'exited' : 'running' }
    catch { return 'closed' }
  }
  /** Background jobs currently monitoring one of this agent's shells. */
  const monitored = (owner: Agent): number => [...owners.get(owner)?.values() ?? []]
    .filter(state => state.monitor !== undefined).length
  const liveIds = (owner: Agent): string[] => [...owners.get(owner)?.values() ?? []]
    .filter(state => statusOf(state) === 'running')
    .map(state => String(state.id))
  const notOpen = (owner: Agent, id: string): string => {
    const live = liveIds(owner)
    return live.length === 0
      ? `session ${id} is not open and this agent has no live shell; run exec_command to start one`
      : `session ${id} is not open; live shells: ${live.join(', ')}`
  }
  const header = (value: CommandOutput): string => {
    if (value.closed) return `[session ${value.session_id} | closed]`
    if (value.job_id !== undefined) return `[session ${value.session_id} | background job ${value.job_id}]`
    if (value.status === 'exited') return `[session ${value.session_id} | shell exited: ${value.exit_code ?? value.signal ?? 'unknown'}]`
    return `[session ${value.session_id} | shell running; send ${value.send}; wait ${value.wait}]`
  }
  const read = (state: RecordState, created: boolean): CommandOutput => {
    const current = page(state)
    const fresh = delta(state.cursor, current.text)
    const clipped = clipTail(fresh.text, config.maxResultBytes)
    const status = snapshot(state).status
    // Cursor must advance after the gap test: the retained window no longer
    // matching the previous snapshot is itself evidence of missing output.
    const incomplete = fresh.gap || clipped.incomplete || (current.truncated && current.text !== state.cursor)
    state.cursor = current.text
    const value: CommandOutput = {
      session_id: String(state.id),
      status: status.kind === 'exited' ? 'exited' : 'running',
      created,
      closed: false,
      send: state.operation === undefined ? 'settled' : 'pending',
      wait: state.wait,
      text: clipped.text,
      incomplete,
      ...status.kind === 'exited' && status.exitCode !== null ? { exit_code: status.exitCode } : {},
      ...status.kind === 'exited' && status.exitCode === null && status.signal !== null ? { signal: String(status.signal) } : {},
    }
    // An exited shell can never accept another command, so stop counting it
    // toward maxSessionsPerAgent the moment the backend reports the exit.
    if (status.kind === 'exited') owners.get(state.owner)?.delete(state.id)
    return value
  }
  const closedOutput = (state: RecordState): CommandOutput => ({
    session_id: String(state.id), status: 'closed', created: false, closed: true,
    send: 'none', wait: 'closed', text: '', incomplete: false,
  })
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
    try { ctx.terminals.read(owner, TerminalSessionId(id), { count: 1 }) }
    catch (error) {
      if (error instanceof TerminalError && error.code === 'NO_SESSION') throw new TerminalError(notOpen(owner, id), 'NO_SESSION')
      throw error
    }
    const state = owners.get(owner)?.get(id)
    if (state === undefined) throw new TerminalError(notOpen(owner, id), 'NO_SESSION')
    return state
  }
  /** The agent's most recently used shell that can accept a foreground command now. */
  const sticky = (owner: Agent): RecordState | undefined => {
    const records = owners.get(owner)
    if (records === undefined) return undefined
    const candidates = [...records.values()].filter(state =>
      state.busy !== true && state.operation === undefined && state.monitor === undefined && statusOf(state) === 'running')
    if (candidates.length === 0) return undefined
    candidates.sort((left, right) => right.used - left.used)
    return candidates[0]
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
      const state: RecordState = { owner, id: TerminalSessionId(value.sessionId), cursor: '', wait: 'inferred_idle', busy: false, used: 0 }
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
  const poll = async (state: RecordState, signal: AbortSignal, waitForSend: boolean, preserveSession = true, created = false): Promise<CommandOutput> => {
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
          || snapshot(state).status.kind === 'exited' || Date.now() >= deadline) return read(state, created)
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
  const background = (state: RecordState, exec: ToolRunContext, created: boolean, send?: { text: string; submit: boolean }): CommandOutput => {
    if (state.monitor !== undefined) throw new Error(`session ${state.id} already has a background monitor; use job_output or write_stdin`)
    if (monitored(state.owner) >= config.maxBackgroundJobsPerAgent) throw new Error(`background job limit ${config.maxBackgroundJobsPerAgent} for this agent; collect or kill a running job first, or raise focus-commands config.maxBackgroundJobsPerAgent`)
    const controller = new AbortController()
    state.monitor = controller
    let cursor = state.cursor
    let killing = false
    let jobId
    try {
      jobId = ctx.jobs.start({
        kind: 'focus-session', label: `persistent session ${state.id}`, owner: state.owner.id,
        toolCall: { callId: exec.callId, rootCallId: exec.rootCallId }, outputLimitBytes: config.maxResultBytes,
        run(job) {
          if (send !== undefined) start(state, send.text, send.submit)
          const pump = async () => {
            try {
              while (true) {
                // Check the shell first: a backend that already finished it can
                // reject reads, and that is a completed job, not a failed one.
                if (statusOf(state) !== 'running') {
                  owners.get(state.owner)?.delete(state.id)
                  return { status: 'completed' as const }
                }
                const current = page(state)
                const fresh = delta(cursor, current.text)
                const clipped = clipTail(fresh.text, config.maxResultBytes)
                cursor = current.text
                if (fresh.gap || clipped.incomplete) job.append('[retained output may be incomplete]\n')
                job.append(clipped.text)
                if (state.failure !== undefined) throw state.failure
                await delay(config.pollMs, undefined, { signal: controller.signal })
              }
            } catch (error) {
              if (error instanceof TerminalError && error.code === 'NO_SESSION') {
                owners.get(state.owner)?.delete(state.id)
                return { status: 'completed' as const }
              }
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
      })
    } catch (error) {
      controller.abort()
      delete state.monitor
      throw error
    }
    return {
      session_id: String(state.id), status: statusOf(state), created, closed: false,
      send: state.operation === undefined ? 'settled' : 'pending', wait: state.wait, incomplete: false, job_id: String(jobId),
      text: 'Use job_output to collect output. job_kill closes this entire shell. The job monitors the persistent session until it exits or is closed; it does not certify individual command completion.',
    }
  }
  const ownerOf = (exec: ToolRunContext) => {
    if (exec.agent === undefined) throw new Error('focus command tools require an initiating Agent')
    return exec.agent
  }
  const withState = async (state: RecordState, run: () => Promise<CommandOutput>) => {
    if (state.busy) throw new TerminalError(`session ${state.id} already has a command-tool call in progress`, 'SEND_ACTIVE')
    state.busy = true
    state.used = ++usage
    try { return await run() } finally { state.busy = false }
  }
  const renderCommand = (_args: unknown, value: CommandOutput) => [
    {
      type: 'text' as const,
      text: response(header(value), (value.incomplete ? '[retained output may be incomplete]\n' : '') + value.text, config.maxResultBytes),
    },
  ]
  const renderSessions = (_args: unknown, value: SessionListOutput) => {
    if (value.sessions.length === 0) return [{ type: 'text' as const, text: '[focus shells: none]\nNo persistent shell is open; exec_command starts one.' }]
    const lines = value.sessions.map(session => [
      session.session_id,
      session.status,
      ...session.most_recent ? ['default'] : [],
      ...session.busy ? ['busy'] : [],
      ...session.background ? ['monitored'] : [],
    ].join(' '))
    return [{ type: 'text' as const, text: `[focus shells: ${value.sessions.length}]\n${lines.join('\n')}` }]
  }
  const finalizeContent: NonNullable<ToolDefinition['finalizeContent']> = (_exec, result) => {
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (Buffer.byteLength(text) <= config.maxResultBytes) return undefined
    return [{ type: 'text', text: response('[focus command result]', text, config.maxResultBytes) }]
  }
  ctx.tools.register(defineTool({
    name: 'exec_command',
    description: 'Run a command in an Agent-owned persistent shell. Without session_id it reuses this agent\'s most recently used live shell; pass new_session:true (or cwd) to start another shell. Reuse session_id to target a specific shell. Returns after a bounded wait; a running shell or settled send does not prove the command completed. run_in_background without session_id starts its own shell and returns a job monitoring it; job_kill closes that shell. At most ${config.maxBackgroundJobsPerAgent} background jobs run per agent.',
    parameters: {
      cmd: { type: 'string', required: true }, session_id: { type: 'string' }, cwd: { type: 'string' },
      run_in_background: { type: 'boolean' }, new_session: { type: 'boolean' },
    },
    output: { schema: COMMAND_OUTPUT_SCHEMA, render: renderCommand },
    finalizeContent,
    async execute(args: ExecArgs, exec) {
      if (args.cmd.trim().length === 0) throw new Error('cmd must not be empty')
      if (args.session_id !== undefined && args.cwd !== undefined) throw new Error('cwd applies only to a new session; use cd to change an existing shell')
      if (args.session_id !== undefined && args.new_session === true) throw new Error('new_session applies only without session_id; omit session_id to reuse the default shell')
      const owner = ownerOf(exec)
      const backgroundCall = args.run_in_background === true
      let state: RecordState
      let created = false
      if (args.session_id !== undefined) state = find(owner, args.session_id)
      else {
        const reusable = !backgroundCall && args.cwd === undefined && args.new_session !== true && config.reuseMostRecentSession
        const reused = reusable ? sticky(owner) : undefined
        if (reused !== undefined) state = reused
        else {
          // Reject before spending a shell slot on a job the limit cannot accept.
          if (backgroundCall && monitored(owner) >= config.maxBackgroundJobsPerAgent) {
            throw new Error(`background job limit ${config.maxBackgroundJobsPerAgent} for this agent; collect or kill a running job first, or raise focus-commands config.maxBackgroundJobsPerAgent`)
          }
          state = await create(owner, args.cwd, exec.signal)
          created = true
        }
      }
      return withState(state, async () => {
        try {
          exec.signal.throwIfAborted()
          if (args.run_in_background === true) return background(state, exec, created, { text: args.cmd, submit: true })
          start(state, args.cmd, true)
          return await poll(state, exec.signal, true, !created, created)
        } catch (error) {
          if (created) {
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
    output: { schema: COMMAND_OUTPUT_SCHEMA, render: renderCommand },
    finalizeContent,
    async execute(args: WriteArgs, exec) {
      const state = find(ownerOf(exec), args.session_id)
      return withState(state, async () => {
        if (args.close === true) {
          if (args.chars !== undefined || args.run_in_background === true) throw new Error('close cannot be combined with chars or run_in_background')
          const value = closedOutput(state)
          await close(state)
          return value
        }
        if (args.run_in_background === true && state.monitor !== undefined) throw new Error(`session ${state.id} already has a background monitor`)
        if (args.run_in_background === true && args.chars !== '\u0003') {
          return background(state, exec, false, args.chars === undefined || args.chars.length === 0 ? undefined : { text: args.chars, submit: false })
        }
        if (args.chars !== undefined && args.chars.length > 0) {
          if (args.chars === '\u0003') await ctx.terminals.signal(state.owner, state.id, 'SIGINT')
          else start(state, args.chars, false)
        }
        return args.run_in_background === true ? background(state, exec, false) : poll(state, exec.signal, args.chars !== undefined)
      })
    },
    presentCall: args => ({ card: 'terminal', title: args.close ? '(close)' : args.chars ?? '(read)', description: args.session_id }),
  }))
  ctx.tools.register(defineTool({
    name: 'focus_sessions',
    description: 'List the persistent shells this agent owns for exec_command and write_stdin: session_id, whether each shell is running, busy with a call or monitored by a background job, and which shell exec_command reuses by default.',
    parameters: {},
    output: { schema: SESSION_LIST_SCHEMA, render: renderSessions },
    finalizeContent,
    async execute(_args: object, exec) {
      const owner = ownerOf(exec)
      const recent = sticky(owner)
      const records = owners.get(owner)
      const sessions: SessionView[] = []
      for (const state of [...records?.values() ?? []]) {
        const status = statusOf(state)
        // A shell the backend already finished counting cannot be reused or closed,
        // so listing it would only invite another failed call.
        if (status !== 'running') { records?.delete(state.id); continue }
        sessions.push({
          session_id: String(state.id),
          status,
          busy: state.busy === true || state.operation !== undefined,
          background: state.monitor !== undefined,
          most_recent: recent !== undefined && recent.id === state.id,
        })
      }
      sessions.sort((left, right) => left.session_id.localeCompare(right.session_id))
      return { sessions }
    },
    presentCall: () => ({ card: 'generic', title: 'focus_sessions' }),
  }))
  ctx.systemPrompt.section({
    name: 'tool:focus-commands', order: ctx.systemPrompt.getSectionOrder('TOOL_PTY'),
    text: 'exec_command starts or reuses a persistent shell. Omitting session_id reuses this agent\'s most recently used live shell; pass new_session:true or cwd to start another. Keep the returned session_id for write_stdin or later commands; focus_sessions lists the shells this agent owns. Poll to read output produced between calls. A shell running, a timeout, or a settled send is not proof the command finished. Background jobs monitor entire sessions, at most ${config.maxBackgroundJobsPerAgent} run at once, and job_kill closes that shell. A shell that exits releases its slot automatically; use write_stdin with close:true when a live shell is no longer needed.',
  })
}
