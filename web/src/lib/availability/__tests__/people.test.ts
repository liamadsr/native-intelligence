/**
 * Who a request names (../people.ts): a member by their whole name, by the
 * words of it or an initial, or by sign-in email; an ambiguous or unknown
 * name an error naming the candidates, never a guess; the person asking
 * always included and never counted twice; at most TEAM_MAX_PEOPLE.
 */
import { describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { findWorkspacePeople, nameMatches, readWorkspacePeople, resolvePeople, TEAM_MAX_PEOPLE, type WorkspacePerson } from '../people'

const m = (userId: string, name: string, extra: Partial<WorkspacePerson> = {}): WorkspacePerson => ({ memberId: `m-${userId}`, userId, name, role: 'member', sharing: 'busy_only', ...extra })
const ADA = m('user-ada', 'Ada Finch', { email: 'ada.finch@example.com' })
const DANA_W = m('user-dana', 'Dana Whitfield', { email: 'dana.w@example.com' })
const DANA_K = m('user-dana-k', 'Dana Kerr', { email: 'dana.kerr@example.com' })
const LEE = m('user-lee', 'Lee Okafor', { email: 'lee@example.com' })
const MEMBERS = [ADA, DANA_W, DANA_K, LEE]

const ids = (r: ReturnType<typeof resolvePeople>) => (r.ok ? r.others.map((p) => p.userId) : r.error)

describe('nameMatches', () => {
  it('the whole name, any case and spacing', () => {
    expect(nameMatches('  dana   WHITFIELD ', 'Dana Whitfield')).toBe(true)
  })

  it("every word given is one of the name's words; a letter is an initial", () => {
    expect(nameMatches('Dana', 'Dana Whitfield')).toBe(true)
    expect(nameMatches('whitfield', 'Dana Whitfield')).toBe(true)
    expect(nameMatches('Dana W', 'Dana Whitfield')).toBe(true)
    expect(nameMatches('Dana W.', 'Dana Whitfield')).toBe(true)
    expect(nameMatches('Dana K', 'Dana Whitfield')).toBe(false)
  })

  it('part of a word, initials alone, or nothing name nobody', () => {
    expect(nameMatches('Dan', 'Dana Whitfield')).toBe(false)
    expect(nameMatches('D.', 'Dana Whitfield')).toBe(false)
    expect(nameMatches('D W', 'Dana Whitfield')).toBe(false)
    expect(nameMatches('  ', 'Dana Whitfield')).toBe(false)
  })
})

describe('resolvePeople', () => {
  it('one member per name, by name or email', () => {
    expect(ids(resolvePeople(['Lee', 'dana.kerr@example.com'], MEMBERS, 'user-ada'))).toEqual(['user-lee', 'user-dana-k'])
    expect(ids(resolvePeople(['Dana Whitfield'], MEMBERS, 'user-ada'))).toEqual(['user-dana'])
    expect(ids(resolvePeople(['dana w'], MEMBERS, 'user-ada'))).toEqual(['user-dana'])
  })

  it('an ambiguous name is an error naming every candidate with their email, never a pick', () => {
    const out = resolvePeople(['Dana'], MEMBERS, 'user-ada')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.ambiguous).toBe(true)
    expect(out.error).toContain('"Dana" could be Dana Whitfield (dana.w@example.com), Dana Kerr (dana.kerr@example.com)')
    expect(out.error).toMatch(/never pick one/)
  })

  it('a whole-name match wins over word matches', () => {
    const members = [ADA, m('user-x', 'Dana'), DANA_W]
    expect(ids(resolvePeople(['dana'], members, 'user-ada'))).toEqual(['user-x'])
  })

  it("an unknown name or email is an error naming the workspace's members, and says outside guests can't be seen", () => {
    const out = resolvePeople(['Priya', 'nobody@example.com'], MEMBERS, 'user-ada')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.ambiguous).toBe(false)
    expect(out.error).toContain('"Priya" is not a member of this workspace (its members: Dana Whitfield, Dana Kerr, Lee Okafor)')
    expect(out.error).toContain('"nobody@example.com" is not a member of this workspace')
    expect(out.error).toContain("an outside guest's calendar cannot be seen")
  })

  it('the person asking is always included, never counted among the others, and a name given twice is one person', () => {
    expect(resolvePeople(['Ada', 'ada.finch@example.com', 'Lee', 'lee@example.com'], MEMBERS, 'user-ada')).toEqual({ ok: true, requester: ADA, others: [LEE] })
    expect(resolvePeople([], MEMBERS, 'user-ada')).toEqual({ ok: true, requester: ADA, others: [] })
  })

  it('someone outside the workspace asking gets nothing', () => {
    expect(resolvePeople(['Lee'], MEMBERS, 'user-stranger')).toEqual({ ok: false, error: 'You are not a member of this workspace.' })
  })

  it(`at most ${TEAM_MAX_PEOPLE} people, the person asking included`, () => {
    const many = Array.from({ length: TEAM_MAX_PEOPLE }, (_, i) => m(`user-${i}`, `Person${i} Test`))
    const members = [ADA, ...many]
    expect(resolvePeople(many.slice(0, TEAM_MAX_PEOPLE - 1).map((p) => p.name), members, 'user-ada').ok).toBe(true)
    expect(resolvePeople(many.map((p) => p.name), members, 'user-ada')).toEqual({ ok: false, error: `At most ${TEAM_MAX_PEOPLE} people at once, you included.` })
  })
})

describe('reading the members', () => {
  const tables = () => ({
    member: [
      { id: 'm-ada', user_id: 'user-ada', workspace_id: 'ws-fernhill', display_name: 'Ada Finch', role: 'owner', availability_sharing: 'busy_only' },
      { id: 'm-dana', user_id: 'user-dana', workspace_id: 'ws-fernhill', display_name: 'Dana Whitfield', role: 'member', availability_sharing: 'busy_only' },
      { id: 'm-dana-k', user_id: 'user-dana-k', workspace_id: 'ws-fernhill', display_name: 'Dana Kerr', role: 'member', availability_sharing: 'none' },
      { id: 'm-blank', user_id: 'user-blank', workspace_id: 'ws-fernhill', display_name: '  ', role: 'guest', availability_sharing: 'something else' },
      { id: 'm-other', user_id: 'user-other', workspace_id: 'ws-other', display_name: 'Dana Elsewhere', role: 'member', availability_sharing: 'busy_only' },
    ],
  })
  const listEmails = vi.fn(async () => [
    { id: 'm-dana', userId: 'user-dana', displayName: 'Dana Whitfield', email: 'dana.w@example.com' },
    { id: 'm-dana-k', userId: 'user-dana-k', displayName: 'Dana Kerr', email: 'dana.kerr@example.com' },
    { id: 'm-blank', userId: 'user-blank', displayName: null, email: 'blank@example.com' },
  ])

  it("the workspace's members only; an unreadable sharing value is none; a blank name falls back to the email", async () => {
    const people = await readWorkspacePeople(memoryDb(tables()), 'ws-fernhill', { emails: true, listEmails })
    expect(people.map((p) => [p.userId, p.name, p.role, p.sharing])).toEqual([
      ['user-ada', 'Ada Finch', 'owner', 'busy_only'],
      ['user-dana', 'Dana Whitfield', 'member', 'busy_only'],
      ['user-dana-k', 'Dana Kerr', 'member', 'none'],
      ['user-blank', 'blank@example.com', 'guest', 'none'],
    ])
  })

  it('emails are read only for an email, or to tell an ambiguous name apart', async () => {
    listEmails.mockClear()
    const supabase = memoryDb(tables())
    expect((await findWorkspacePeople(supabase, 'ws-fernhill', 'user-ada', ['Dana Kerr'], { listEmails })).ok).toBe(true)
    expect(listEmails).not.toHaveBeenCalled()

    const ambiguous = await findWorkspacePeople(supabase, 'ws-fernhill', 'user-ada', ['Dana'], { listEmails })
    expect(listEmails).toHaveBeenCalledTimes(1)
    expect(!ambiguous.ok && ambiguous.error).toContain('Dana Kerr (dana.kerr@example.com)')

    listEmails.mockClear()
    const byEmail = await findWorkspacePeople(supabase, 'ws-fernhill', 'user-ada', ['dana.w@example.com'], { listEmails })
    expect(byEmail.ok && byEmail.others.map((p) => p.userId)).toEqual(['user-dana'])
    expect(listEmails).toHaveBeenCalledTimes(1)
  })

  it('a failed read throws', async () => {
    const failing = { from: () => ({ select: () => ({ eq: async () => ({ data: null, error: { message: 'down' } }) }) }) } as never
    await expect(readWorkspacePeople(failing, 'ws-fernhill')).rejects.toThrow('Workspace members could not be read: down')
  })
})
