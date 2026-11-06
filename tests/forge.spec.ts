/** Change-request evidence extraction. */
import { describe, expect, it } from 'vitest'
import { changeRequestEvidence } from '../src/forge.ts'

describe('change-request evidence', () => {
  it('binds every change request URL a creation printed', () => {
    const evidence = changeRequestEvidence(
      'gh pr create --title "retry login" --base main',
      'Creating pull request for focus-retry into main in owner/repo\n\nhttps://github.com/owner/repo/pull/7\n',
    )
    expect(evidence).toEqual({ urls: ['https://github.com/owner/repo/pull/7'] })
  })
  it('binds the change request a view command named', () => {
    expect(changeRequestEvidence('gh pr view https://github.com/owner/repo/pull/42', '')).toEqual({
      urls: ['https://github.com/owner/repo/pull/42'],
    })
    expect(changeRequestEvidence('gh pr view 42 --repo owner/repo --json url', '{"url":"https://github.com/owner/repo/pull/42"}')).toEqual({
      urls: ['https://github.com/owner/repo/pull/42'],
    })
    expect(changeRequestEvidence('gh pr checkout 42', 'url:\thttps://github.com/owner/repo/pull/42\n')).toEqual({
      urls: ['https://github.com/owner/repo/pull/42'],
    })
  })
  it('ignores commands that only print a change request URL', () => {
    expect(changeRequestEvidence("echo 'https://github.com/owner/repo/pull/7'", 'https://github.com/owner/repo/pull/7\n')).toBeUndefined()
    expect(changeRequestEvidence('git status', 'https://github.com/owner/repo/pull/7\n')).toBeUndefined()
  })
  it('reports the branch a push printed', () => {
    expect(changeRequestEvidence('git push -u origin focus-retry', 'To github.com:owner/repo.git\n   abc1234..def5678  focus-retry -> focus-retry\n')).toEqual({
      urls: [],
      push: { remote: 'github.com:owner/repo.git', branch: 'focus-retry' },
    })
    expect(changeRequestEvidence('git -C repo push', 'To git@github.com:owner/repo.git\n + abc1234...def5678 main -> main (forced update)\n')).toEqual({
      urls: [],
      push: { remote: 'git@github.com:owner/repo.git', branch: 'main' },
    })
  })
  it('skips tags, deletions, and pushes without a branch line', () => {
    expect(changeRequestEvidence('git push --tags', 'To github.com:owner/repo.git\n * [new tag]         v1.0    -> v1.0\n')).toBeUndefined()
    expect(changeRequestEvidence('git push origin :old', 'To github.com:owner/repo.git\n - [deleted]         old\n')).toBeUndefined()
    expect(changeRequestEvidence('git push', 'Everything up-to-date\n')).toBeUndefined()
  })
})
