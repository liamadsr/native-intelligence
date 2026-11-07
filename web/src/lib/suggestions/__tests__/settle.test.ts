import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb, has, type FakeQuery } from './fake-db'

const hoisted = vi.hoisted(() => ({
  claimAndApplyChange: vi.fn(),
  deleteAppliedEntity: vi.fn(),
  updateAppliedEntity: vi.fn(),
}))
vi.mock('@/lib/proposed-changes/claim-apply', () => ({ claimAndApplyChange: hoisted.claimAndApplyChange }))
vi.mock('@/lib/proposed-changes/apply-engine', () => ({
  deleteAppliedEntity: hoisted.deleteAppliedEntity,
  updateAppliedEntity: hoisted.updateAppliedEntity,
}))
vi.mock('@/lib/proposed-changes/undo-applied', () => ({ undoAppliedProposal: vi.fn() }))
vi.mock('@/lib/workspace-fences', () => ({ isAssignableTeammate: vi.fn(async () => true), FOREIGN_AI_MEMBER_ERROR: 'x' }))

const { applySuggestion, applySuggestions, dismissSuggestion } = await import('../settle')

const SUGGESTION = {
  id: 'pc-1',
  workspace_id: 'ws-2',
  status: 'pending',
  change_type: 'update',
  entity_type: 'action',
  entity_id: 'act-1',
  status_to: 'Done',
  fingerprint: 'fp-1',
  base: { status: 'Todo', priority: 'medium', due_date: null, assignee_id: null, assignee_contact_id: null, project_id: null },
}

function actionRow(status: string) {
  return {
    id: 'act-1', workspace_id: 'ws-2', team_id: 't', identifier: 'GEN-1', title: 't', status_id: 's',
    assignee_id: null, assignee_contact_id: null, due_at: null, priority: 'medium', project_id: null,
    workflow_state: { name: status, category: 'x' },
  }
}

let current: string
let suggestion: Record<string, unknown> | null
let updates: FakeQuery[]

function handler(q: FakeQuery) {
  if (q.table === 'member') return { data: has(q, 'workspace_id', 'ws-2') ? { id: 'mem-2' } : null }
  if (q.table === 'actions') return { data: current === 'gone' ? [] : [actionRow(current)] }
  if (q.table === 'proposed_change') {
    if (q.op === 'update') {
      updates.push(q)
      return { data: [{ id: 'pc-1', ...(q.payload as object) }] }
    }
    return { data: suggestion }
  }
  return { data: null }
}

beforeEach(() => {
  current = 'Todo'
  suggestion = { ...SUGGESTION }
  updates = []
  hoisted.claimAndApplyChange.mockReset()
  hoisted.deleteAppliedEntity.mockReset()
})

describe('applySuggestion', () => {
  it('applies in the suggestion’s own workspace and expires its twins', async () => {
    hoisted.claimAndApplyChange.mockResolvedValueOnce({ ok: true, entity_id: 'act-1', change: { ...SUGGESTION, status: 'applied' } })
    const { client } = fakeDb(handler)

    const r = await applySuggestion(client, 'user-1', 'pc-1')

    expect(r.status).toBe(200)
    expect(hoisted.claimAndApplyChange).toHaveBeenCalledWith(client, expect.objectContaining({ id: 'pc-1' }), {
      workspaceId: 'ws-2',
      memberId: 'mem-2',
      userId: 'user-1',
    })
    const twins = updates.find((u) => has(u, 'fingerprint', 'fp-1'))!
    expect(twins.payload).toEqual({ status: 'expired', expire_reason: 'applied_elsewhere' })
    expect(twins.filters).toContainEqual(['neq', 'id', 'pc-1'])
  })

  it('expires instead of applying when the change already holds', async () => {
    current = 'Done'
    const { client } = fakeDb(handler)
    const r = await applySuggestion(client, 'user-1', 'pc-1')
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('already_true')
    expect(hoisted.claimAndApplyChange).not.toHaveBeenCalled()
    expect(updates[0].payload).toEqual({ status: 'expired', expire_reason: 'already_true' })
  })

  it('asks before applying over someone else’s change, and applies with force', async () => {
    current = 'In Progress'
    const { client } = fakeDb(handler)
    const r = await applySuggestion(client, 'user-1', 'pc-1')
    expect(r).toMatchObject({ status: 409, body: { code: 'target_changed', details: { fields: [{ field: 'status', was: 'Todo', now: 'In Progress' }] } } })
    expect(hoisted.claimAndApplyChange).not.toHaveBeenCalled()

    hoisted.claimAndApplyChange.mockResolvedValueOnce({ ok: true, entity_id: 'act-1', change: { ...SUGGESTION, status: 'applied' } })
    const forced = await applySuggestion(client, 'user-1', 'pc-1', { force: true })
    expect(forced.status).toBe(200)
  })

  it('404 when the person can’t see it, 403 when not in its workspace, 409 when not pending', async () => {
    suggestion = null
    expect((await applySuggestion(fakeDb(handler).client, 'u', 'pc-1')).status).toBe(404)
    suggestion = { ...SUGGESTION, workspace_id: 'ws-elsewhere' }
    expect((await applySuggestion(fakeDb(handler).client, 'u', 'pc-1')).status).toBe(403)
    suggestion = { ...SUGGESTION, status: 'applied' }
    expect((await applySuggestion(fakeDb(handler).client, 'u', 'pc-1')).status).toBe(409)
  })

  it('apply-all reports skipped and applied separately', async () => {
    hoisted.claimAndApplyChange.mockResolvedValueOnce({ ok: false, reason: 'not_pending' })
    const r = await applySuggestions(fakeDb(handler).client, 'u', ['pc-1', 'pc-1'])
    expect(r.body).toMatchObject({ applied: 0, skipped: 1, failed: 0 })
  })
})

describe('dismissSuggestion', () => {
  it('dismisses a pending suggestion', async () => {
    const r = await dismissSuggestion(fakeDb(handler).client, 'u', 'pc-1')
    expect(r.status).toBe(200)
    expect(updates[0].payload).toEqual({ status: 'dismissed', result_entity_id: null })
    expect(hoisted.deleteAppliedEntity).not.toHaveBeenCalled()
  })

  it('removes what an applied create made', async () => {
    suggestion = { ...SUGGESTION, status: 'applied', change_type: 'create', result_entity_id: 'act-new' }
    hoisted.deleteAppliedEntity.mockResolvedValueOnce({ success: true })
    await dismissSuggestion(fakeDb(handler).client, 'u', 'pc-1')
    expect(hoisted.deleteAppliedEntity).toHaveBeenCalledWith(expect.anything(), 'create', 'action', 'act-new', 'ws-2')
  })
})
