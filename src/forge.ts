/** Change-request evidence a persistent-shell command and its output can carry. */

/** `gh pr create` and its alias print the created change request URL. */
const CREATE_COMMAND = /\bgh\s+pr\s+(?:create|new)\b/
/** `gh pr view|edit|checkout` act on one change request the command or output names. */
const REFERENCE_COMMAND = /\bgh\s+pr\s+(?:view|edit|checkout)\b/
/** `git push`, with optional leading `-C`, `-c`, and long options. */
const PUSH_COMMAND = /\bgit(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?))*\s+push\b/
const CHANGE_REQUEST_URL = /\bhttps?:\/\/[^\s"'<>]+?\/pull\/\d+(?![\w-])/g
const OWN_URL_LINE = /^(?:url:\s+)?(https?:\/\/[^\s"'<>]+?\/pull\/\d+)\/?$/
const OWN_URL_MEMBER = /"url"\s*:\s*"(https?:\/\/[^\s"'<>]+?\/pull\/\d+)\/?"/g
const PUSH_TARGET_LINE = /^To (\S+)$/
const PUSH_REF_LINE = /^ [ +*=] (\[[^\]]+\]|\S+) +\S+ -> (\S+)(?: \(.*\))?$/

/** A pushed branch whose change requests must be looked up on its remote. */
export interface PushedBranch {
  /** Remote as the push output printed it after `To`. */
  remote: string
  /** Branch name on the remote. */
  branch: string
}

/** What one completed command contributes to a Session's change-request list. */
export interface ChangeRequestEvidence {
  /** Change request URLs the command created or named. */
  urls: string[]
  /** A pushed branch to resolve into change requests, when the output shows one. */
  push?: PushedBranch
}

/** Change request URLs a text carries, in order of first appearance. */
function urlsIn(text: string): string[] {
  return [...text.matchAll(CHANGE_REQUEST_URL)].map(match => match[0])
}

/** Change request URLs one output line names on its own, as a bare URL, a `url:` field, or a JSON member. */
function ownUrls(text: string): string[] {
  const urls: string[] = []
  for (const line of text.split('\n')) {
    const match = OWN_URL_LINE.exec(line.trim())
    if (match !== null && !urls.includes(match[1]!)) urls.push(match[1]!)
  }
  for (const match of text.matchAll(OWN_URL_MEMBER)) {
    if (!urls.includes(match[1]!)) urls.push(match[1]!)
  }
  return urls
}

/** The first branch a push output named after `To <remote>`, skipping tags and deleted refs. */
function pushedBranch(text: string): PushedBranch | undefined {
  let remote: string | undefined
  for (const line of text.split('\n')) {
    const target = PUSH_TARGET_LINE.exec(line)
    if (target !== null) { remote = target[1]!; continue }
    if (remote === undefined) continue
    const ref = PUSH_REF_LINE.exec(line)
    if (ref === null) continue
    // `[new tag]` and `[deleted]` refs, and explicit tag refs, name no branch.
    if (ref[1]!.startsWith('[') || ref[1]!.includes('refs/tags/')) continue
    return { remote, branch: ref[2]! }
  }
  return undefined
}

/**
 * Read the change-request evidence of one command and its output.
 *
 * The match is textual, like the host's own shell evidence: a command that
 * merely prints a URL binds nothing, while `gh pr create` binds every change
 * request URL its output carries. `git push` contributes the remote and branch
 * so a caller can look the branch's change requests up instead of guessing.
 * @param command - the command text as the caller submitted it.
 * @param output - the text the command produced.
 * @returns the evidence, or undefined when the command carries none.
 */
export function changeRequestEvidence(command: string, output: string): ChangeRequestEvidence | undefined {
  const create = CREATE_COMMAND.test(command)
  const reference = !create && REFERENCE_COMMAND.test(command)
  const push = !create && !reference && PUSH_COMMAND.test(command)
  if (!create && !reference && !push) return undefined
  if (create) {
    // The shell echoes the command line, so the same URL can appear twice.
    const urls = [...new Set(urlsIn(output))]
    return urls.length === 0 ? undefined : { urls }
  }
  if (reference) {
    const urls = [...new Set([...urlsIn(command), ...ownUrls(output)])]
    return urls.length === 0 ? undefined : { urls }
  }
  const pushed = pushedBranch(output)
  return pushed === undefined ? undefined : { urls: [], push: pushed }
}
