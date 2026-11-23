/**
 * A history as editing sessions, a fork's name and the markdown download
 * (../revision-sessions.ts).
 */
import { describe, expect, it } from 'vitest'
import type { RevisionSummary } from '../revision-format'
import { documentMarkdown, forkTitle, groupRevisionSessions, markdownFileName } from '../revision-sessions'

const at = (min: number) => new Date(Date.UTC(2026, 10, 20, 9, 0) + min * 60_000).toISOString()
const rev = (n: number, author: string | null, start: number, end = start): RevisionSummary => ({
  revision_number: n,
  title: 'Plan',
  author_kind: author === null ? null : author === 'agent' ? 'agent' : 'human',
  author_id: author,
  author_name: author,
  change_summary: null,
  created_at: at(start),
  updated_at: at(end),
})

describe('groupRevisionSessions', () => {
  it('groups one author’s changes less than 30 minutes apart, newest first', () => {
    const history = [
      rev(7, 'ana', 200, 205),
      rev(6, 'ana', 180, 190), // 10 min before 7
      rev(5, 'agent', 175),
      rev(4, 'ana', 100, 120),
      rev(3, 'ana', 60, 95), // 5 min before 4
      rev(2, 'ana', 0, 10), // 50 min before 3: a new session
      rev(1, null, 0),
    ]
    const sessions = groupRevisionSessions(history)
    expect(sessions.map((s) => s.revisions.map((r) => r.revision_number))).toEqual([[7, 6], [5], [4, 3], [2], [1]])
    expect(sessions[0]).toMatchObject({ key: '7', author_name: 'ana', started_at: at(180), ended_at: at(205) })
  })

  it('never folds a baseline into a session, and copes with an empty list', () => {
    expect(groupRevisionSessions([])).toEqual([])
    const s = groupRevisionSessions([rev(2, null, 5), rev(1, null, 0)])
    expect(s).toHaveLength(2)
  })
})

describe('names and the download', () => {
  it('names a fork after its version', () => {
    expect(forkTitle('Plan', 4)).toBe('Plan (version 4)')
    expect(forkTitle('  ', 2)).toBe('Untitled document (version 2)')
  })

  it('makes a safe file name', () => {
    expect(markdownFileName('Q4: plan / draft?')).toBe('Q4 plan draft.md')
    expect(markdownFileName('..hidden')).toBe('hidden.md')
    expect(markdownFileName('')).toBe('Untitled document.md')
  })

  it('heads the body with its title, once', () => {
    expect(documentMarkdown('Plan', 'Body $x$\n\n')).toBe('# Plan\n\nBody $x$\n')
    expect(documentMarkdown('Plan', '# Plan\n\nBody')).toBe('# Plan\n\nBody\n')
    expect(documentMarkdown('', 'Body')).toBe('Body\n')
  })
})
