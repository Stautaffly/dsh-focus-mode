/** Terminal cursor and complete-result UTF-8 retention. */
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'

/** Read after the last returned snapshot, including a rolled retained window.
 * @param before Last observed retained text.
 * @param after Current retained text.
 * @returns New suffix and whether the retained window no longer overlaps.
 */
export function delta(before: string, after: string): { text: string; gap: boolean } {
  if (after.startsWith(before)) return { text: after.slice(before.length), gap: false }
  if (after.length === 0) return { text: '', gap: before.length > 0 }
  // KMP: longest prefix of after which is also a suffix of before; linear in
  // the two bounded snapshots even for repetitive command output.
  const prefix = new Uint32Array(after.length)
  for (let i = 1, j = 0; i < after.length; i++) {
    while (j > 0 && after[i] !== after[j]) j = prefix[j - 1]!
    if (after[i] === after[j]) j++
    prefix[i] = j
  }
  let overlap = 0
  for (const character of before.split('')) {
    while (overlap > 0 && (overlap === after.length || character !== after[overlap])) overlap = prefix[overlap - 1]!
    if (character === after[overlap]) overlap++
  }
  return { text: after.slice(overlap), gap: overlap === 0 && before.length > 0 }
}

/** Bound one complete response, preserving its identity/status header.
 * @param header Required identity and status.
 * @param body Observed terminal output.
 * @param limit Complete response byte cap.
 * @returns Bounded text and explicit truncation notice when needed.
 */
export function response(header: string, body: string, limit: number): string {
  const whole = `${header}\n${body || '(no new output)'}`
  if (Buffer.byteLength(whole) <= limit) return whole
  const notice = '\n[output truncated]\n'
  const budget = limit - Buffer.byteLength(header + '\n' + notice)
  if (budget < 0) throw new Error('maxResultBytes cannot fit session metadata')
  const retainer = new TextRetainer({ kind: 'tail', maxBytes: budget })
  retainer.push(body)
  return `${header}\n${notice}${retainer.finish().text}`
}
