/**
 * The draft context's "five most urgent" actions for a linked contact are
 * their OPEN work (src/lib/actions/open-work.ts): top level, not dismissed,
 * not in a closed state, assigned through action_assignee. It read every row
 * on the assignee_id column, finished and dismissed ones included.
 */
import { describe, it, expect, vi } from 'vitest'

type Row = Record<string, unknown>
type Call = [string, ...unknown[]]

const hoisted = vi.hoisted(() => ({ actionCalls: [] as Array<[string, ...unknown[]]> }))

function chain(rows: Row[], calls: Call[] = []) {
  let proxy: Record<string, unknown>
  const self: Record<string, unknown> = {
    single: async () => ({ data: rows[0] ?? null, error: null }),
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
  }
  proxy = new Proxy(self, {
    get: (t, p: string) =>
      p in t
        ? t[p]
        : (...args: unknown[]) => {
            calls.push([p, ...args])
            return proxy
          },
  })
  return proxy
}

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      if (table === 'contact') return chain([{ id: 'c-1', member_id: 'm-1' }])
      if (table === 'team') return chain([{ id: 't-1' }])
      if (table === 'workflow_state') return chain([{ id: 'state-done', category: 'completed' }])
      if (table === 'actions') {
        return chain(
          [{ id: 'a-1', title: 'Send SOW', identifier: 'ENG-1', priority: 'high', due_at: null, workflow_state: { name: 'Todo' }, assigned: [{ member_id: 'm-1' }] }],
          hoisted.actionCalls,
        )
      }
      return chain([])
    },
  }),
}))
vi.mock('@/lib/eve/utility/run-utility', () => ({ runUtilityTask: vi.fn() }))
vi.mock('@/lib/ai/auth', () => ({ logUsage: vi.fn() }))
vi.mock('@/lib/integrations/email', () => ({ createEmailDraft: vi.fn() }))
vi.mock('@/lib/email/email-read-service', () => ({ readEmailThread: vi.fn() }))

const { gatherDraftContext } = await import('../email-drafts')

describe('gatherDraftContext — the contact\'s actions', () => {
  it('reads their five most urgent open actions through action_assignee', async () => {
    const context = await gatherDraftContext('ws-1', 'user-1', { linked_contact_id: 'c-1', participant_emails: [] })
    const calls = hoisted.actionCalls

    const select = calls.find((c) => c[0] === 'select')!
    expect(select[1]).toContain('assigned:action_assignee!inner(member_id)')
    expect(calls).toContainEqual(['eq', 'assigned.member_id', 'm-1'])
    expect(calls).toContainEqual(['is', 'parent_id', null])
    expect(calls).toContainEqual(['neq', 'confirmation', 'dismissed'])
    expect(calls).toContainEqual(['or', 'status_id.is.null,status_id.not.in.(state-done)'])
    expect(calls).toContainEqual(['order', 'priority', { ascending: false, nullsFirst: false }])
    expect(calls).toContainEqual(['limit', 5])
    expect(calls).not.toContainEqual(['eq', 'assignee_id', 'm-1'])

    // The filter-only embed stays out of the context.
    expect(context.actions).toEqual([
      { id: 'a-1', title: 'Send SOW', identifier: 'ENG-1', priority: 'high', due_at: null, workflow_state: { name: 'Todo' }, status: 'Todo' },
    ])
  })
})
