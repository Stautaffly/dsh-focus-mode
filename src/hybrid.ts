/** Hybrid execution assembled entirely from the host's public executors. */
import type { Context } from '@deepseek-ai/cordis'
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { RUN_CODE_NAME, ToolBatchExecutionError } from '@deepseek-ai/dsh-tools'
import type { ToolBatchInput, ToolBatchResult, ToolDefinition, ToolExecutor, ToolModelInput, ToolPromptSection } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin identity. */
export const name = 'focus-hybrid'
/** Shared host capabilities required by both executors. */
export const inject = ['tools', 'systemPrompt', 'ptcRuntime']
/** Validated deployment concurrency. */
export const Config = z.object({ maxParallelSubCalls: z.number().step(1).min(1).default(10) })

/** Preserve native concurrency groups, with run_code retaining its exclusive barrier. */
export class FocusExecutor implements ToolExecutor {
  readonly sections: readonly ToolPromptSection[]
  private readonly native: NativeToolExecutor
  private readonly ptc: PtcExecutor

  constructor(ctx: Context, config: { maxParallelSubCalls?: number } = {}) {
    this.native = new NativeToolExecutor(ctx)
    this.ptc = new PtcExecutor(ctx, config)
    this.sections = this.ptc.sections.map(section => section.name === 'tools:ptc-only'
      ? { ...section, text: 'Call the listed tools directly, or use run_code for a program that combines them. Both routes use the same tool policies. run_code is not available inside programs.' }
      : section)
  }

  describe(tools: readonly ToolDefinition[]): ToolModelInput {
    return {
      schemas: [
        ...this.native.describe(tools).schemas,
        ...this.ptc.describe(tools).schemas,
      ],
      // Older hosts do not automatically add executor-owned schema names.
      knownNames: [...new Set([...tools.map(tool => tool.name), RUN_CODE_NAME])],
    }
  }

  async execute(input: ToolBatchInput): Promise<ToolBatchResult> {
    if (input.maxParallelToolCalls !== undefined && (!Number.isInteger(input.maxParallelToolCalls) || input.maxParallelToolCalls < 1)) {
      throw new RangeError('maxParallelToolCalls must be a positive integer')
    }
    const results: ToolBatchResult['results'][number][] = []
    const additionalContexts: ToolBatchResult['additionalContexts'][number][] = []
    let concluded = false
    const collect = (value: ToolBatchResult) => {
      results.push(...value.results)
      additionalContexts.push(...value.additionalContexts)
      concluded ||= value.concluded
    }
    // A run_code root is exclusive in the upstream executor. Splitting only at
    // transport changes preserves every barrier and native rolling-pool group.
    for (let index = 0; index < input.calls.length;) {
      const program = input.calls[index]?.name === RUN_CODE_NAME
      let end = index + 1
      while (end < input.calls.length && (input.calls[end]?.name === RUN_CODE_NAME) === program) end++
      try {
        collect(await (program ? this.ptc : this.native).execute({ ...input, calls: input.calls.slice(index, end) }))
      } catch (error) {
        if (error instanceof ToolBatchExecutionError) {
          collect(error.partial)
          throw new ToolBatchExecutionError(error.cause, { results, additionalContexts, concluded })
        }
        throw error
      }
      index = end
    }
    return { results, additionalContexts, concluded }
  }
}

/** Select the hybrid executor only for this preset's scope.
 * @param ctx Mounting preset context.
 * @param config Validated concurrency configuration.
 */
export function apply(ctx: Context, config: { maxParallelSubCalls?: number }): void {
  ctx.tools.setExecutor(new FocusExecutor(ctx, config))
}
