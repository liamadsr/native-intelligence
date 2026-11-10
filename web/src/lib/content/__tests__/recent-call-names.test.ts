/**
 * The names a post must never carry, from the person's own recent calls,
 * private ones included (P9: recent-call-names.ts), and lint_post's screen
 * using them: a post that names a customer is caught even when it cites only
 * shipped work.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { forgetRecentCallNames, recentCallNames } from '../recent-call-names'
import { screenPostSources } from '../post-sources'
import { checkPost } from '../post-check'
import { lensFakeDb } from '@/lib/flows/__tests__/lens-fake-db'

const NOW = new Date('2026-10-20T09:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()

const seed = () => ({
  member: [{ id: 'm-1', workspace_id: 'ws-1', user_id: 'u-1' }],
  captures: [
    // A private call the person recorded, with a customer on it.
    { id: 'c-1', workspace_id: 'ws-1', user_id: 'u-1', visibility: 'private', is_eval: false, created_at: daysAgo(3) },
    // A call they were on (someone else recorded it).
    { id: 'c-2', workspace_id: 'ws-1', user_id: 'u-9', visibility: 'workspace', is_eval: false, created_at: daysAgo(5) },
    // Too old, and another workspace's: never read.
    { id: 'c-3', workspace_id: 'ws-1', user_id: 'u-1', visibility: 'workspace', is_eval: false, created_at: daysAgo(60) },
    { id: 'c-4', workspace_id: 'ws-2', user_id: 'u-1', visibility: 'workspace', is_eval: false, created_at: daysAgo(1) },
  ],
  capture_participant: [
    { capture_id: 'c-1', member_id: null, external_name: 'Dana Whitlock', contact_id: 'ct-1', company: 'Northwind Partners LLC', is_self: false },
    // A guest on the private call who is in no CRM: only the call knows her.
    { capture_id: 'c-1', member_id: null, external_name: 'Priya Raman', contact_id: null, company: null, is_self: false },
    { capture_id: 'c-1', member_id: 'm-1', external_name: null, contact_id: null, company: 'Native Intelligence', is_self: true },
    { capture_id: 'c-2', member_id: 'm-1', external_name: null, contact_id: null, company: null, is_self: false, 'captures.created_at': daysAgo(5) },
    { capture_id: 'c-2', member_id: null, external_name: 'Speaker 2', contact_id: null, company: null, is_self: false },
    { capture_id: 'c-3', member_id: null, external_name: 'Old Contact', contact_id: null, company: 'Oldco', is_self: false },
    { capture_id: 'c-4', member_id: null, external_name: 'Other Workspace', contact_id: null, company: 'Elsewhere', is_self: false },
  ],
  actions: [{ id: 'a-1', workspace_id: 'ws-1' }],
  entity_link: [{ workspace_id: 'ws-1', source_type: 'capture', source_id: 'c-2', target_type: 'company', target_id: 'co-2' }],
  contact: [{ id: 'ct-1', workspace_id: 'ws-1', full_name: 'Dana Whitlock', last_name: 'Whitlock', company_id: 'co-1' }],
  company: [
    { id: 'co-1', workspace_id: 'ws-1', name: 'Northwind Partners', is_workspace_company: false },
    { id: 'co-2', workspace_id: 'ws-1', name: 'Globex', is_workspace_company: false },
    { id: 'co-own', workspace_id: 'ws-1', name: 'Native Intelligence', is_workspace_company: true },
  ],
})

beforeEach(() => forgetRecentCallNames())

describe('recentCallNames', () => {
  it('reads the people and companies of the person’s recent calls, private ones included, never their own company', async () => {
    const { client } = lensFakeDb(seed())
    const names = await recentCallNames(client, { workspaceId: 'ws-1', userId: 'u-1', now: NOW })
    expect(names).toEqual(expect.arrayContaining(['dana whitlock', 'whitlock', 'northwind partners', 'globex']))
    expect(names).not.toContain('dial8')
    expect(names).not.toContain('speaker 2')
    expect(names).not.toContain('oldco')
    expect(names).not.toContain('elsewhere')
  })

  it('a person with no recent calls has no names to keep out', async () => {
    const { client } = lensFakeDb({ member: [{ id: 'm-1', workspace_id: 'ws-1', user_id: 'u-1' }], captures: [], capture_participant: [] })
    expect(await recentCallNames(client, { workspaceId: 'ws-1', userId: 'u-1', now: NOW })).toEqual([])
  })
})

describe('lint_post’s screen with the person’s calls', () => {
  it('catches a private call’s guest (in no CRM) in a post that cites only shipped work: no post link', async () => {
    const { client } = lensFakeDb(seed())
    const screen = await screenPostSources(client, 'ws-1', [{ kind: 'action', id: 'a-1' }], { userId: 'u-1' })
    expect(screen.blockedPhrases).toContain('northwind partners')
    expect(screen.problems).toEqual([])
    const args = { surface: 'x' as const, sourceCount: screen.verifiedCount, blockedPhrases: screen.blockedPhrases, blockedWords: screen.blockedWords, sourceProblems: screen.problems }
    const check = checkPost({ ...args, parts: ['Priya Raman just moved her whole team onto our calendar sync.'] })
    expect(check.public_safe.ok).toBe(false)
    expect(check.post_link).toBeNull()
    const clean = checkPost({ ...args, parts: ['We shipped calendar sync this week: set it up once and it follows you.'] })
    expect(clean.public_safe.ok).toBe(true)
    expect(clean.post_link).toContain('x.com/intent/post')
  })
})
