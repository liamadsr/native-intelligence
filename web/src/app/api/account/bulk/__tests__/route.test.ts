/**
 * Tests for POST /api/account/bulk — the knowledge-graph-safe bulk delete.
 *
 * Captures and documents carry a polymorphic, no-FK provenance graph
 * (claim_source.source_id, entity_link.{source,target}_id — migration 109). A
 * raw .from(table).delete() strands every claim learned only from that source
 * as evidence-orphaned while its embeddings keep surfacing in RAG. This suite
 * locks in that the bulk 'delete' action:
 *   - routes each capture id through delete_capture_with_knowledge (per id) and
 *     never touches .from('captures').delete()
 *   - routes each document id through delete_document_with_knowledge (per id)
 *   - keeps processing after one id fails (P0002 → counted failed, rest succeed)
 *   - leaves non-knowledge entities (actions) on the raw bulk-delete path with
 *     no rpc() call at all
 *   - preserves the top-level guards (401 unauthenticated, 400 on >100 ids)
 *
 * It also covers the bulk 'change_status' emit gap: bulk status changes used to
 * skip emitStatusChange entirely, so Flows (and the Asana status echo, which
 * rides the same event) never fired for them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  getUser: vi.fn(),
  getCurrentWorkspaceId: vi.fn(),
  rpc: vi.fn(),
  // Records every .from(table) so we can assert which tables were touched.
  fromSpy: vi.fn(),
  // Records every .eq(column, value) with its table, so we can assert
  // workspace-scoped entities are never filtered by user_id.
  eqSpy: vi.fn(),
  // Records every .insert(rows) with its table.
  insertSpy: vi.fn(),
  // Records the terminal .delete() chain result per table.
  deleteResult: { error: null, count: 0 } as { error: unknown; count: number },
  emitStatusChange: vi.fn(),
  // Rows the pre-update snapshot read returns for a change_status batch.
  selectRows: [] as Array<Record<string, unknown>>,
  deleteCompaniesWithContacts: vi.fn(),
  requireWorkspaceFeature: vi.fn(),
  deleteEvalCaptures: vi.fn(),
  // The pre-cascade read that finds a run's per-trial CLONE captures. Real in
  // production, mocked here: it runs on the service client, which this suite
  // stubs as an opaque token.
  collectTrialCaptureIds: vi.fn(),
  /** Rows a `.select()` returns, per table — the eval_suite delete path reads
   *  eval_run (live-run refusal) then eval_case (template captures). */
  selectRowsByTable: {} as Record<string, Array<Record<string, unknown>>>,
  serviceClient: { __service: true },
  // Row returned for the company-delete role gate's member lookup.
  memberRow: { role: 'owner' } as { role: string } | null,
  /** maybeSingle() rows per table (falls back to memberRow): the
   *  change_status team check reads the workflow_state. */
  maybeSingleByTable: {} as Record<string, Record<string, unknown> | null>,
  // Records every .upsert(rows) with its table.
  upsertSpy: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => makeFakeSupabase(),
}))

vi.mock('@/lib/workspace', () => ({
  getCurrentWorkspaceId: hoisted.getCurrentWorkspaceId,
}))

vi.mock('@/lib/flows/emit-status-change', () => ({
  emitStatusChange: hoisted.emitStatusChange,
}))

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => hoisted.serviceClient,
}))

vi.mock('@/lib/crm/delete-companies', () => ({
  deleteCompaniesWithContacts: hoisted.deleteCompaniesWithContacts,
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceFeature: hoisted.requireWorkspaceFeature,
}))

vi.mock('@/app/api/account/evals/delete-captures', () => ({
  deleteEvalCaptures: hoisted.deleteEvalCaptures,
  collectTrialCaptureIds: hoisted.collectTrialCaptureIds,
}))

const WORKSPACE_ID = 'ws-test-1'
const USER_ID = 'user-1'

function makeFakeSupabase() {
  // A chainable stub for the raw delete path:
  // .from(table).delete().in('id', ids).eq('workspace_id', ws).eq(owner, uid)
  // Every filter method returns the same thenable so `await` resolves it.
  //
  // change_status additionally SELECTs the affected rows before updating (to
  // capture each action's team + FROM status for the emit), so a select chain
  // resolves to hoisted.selectRows while every other chain keeps the
  // delete/update shape.
  function makeChain(table: string) {
    const chain: Record<string, unknown> = {}
    let isSelect = false
    const passthrough = () => chain
    chain.delete = passthrough
    chain.update = passthrough
    chain.insert = (rows: unknown) => {
      hoisted.insertSpy(table, rows)
      return chain
    }
    chain.upsert = (rows: unknown) => {
      hoisted.upsertSpy(table, rows)
      return chain
    }
    chain.in = passthrough
    chain.eq = (column: string, value: unknown) => {
      hoisted.eqSpy(table, column, value)
      return chain
    }
    chain.select = () => {
      isSelect = true
      return chain
    }
    // Single-row terminal (add_tags reads current tags via .single()).
    chain.single = () =>
      Promise.resolve({ data: hoisted.selectRows[0] ?? null, error: null })
    // Role-gate terminal (company delete looks up the member's role).
    chain.maybeSingle = () =>
      Promise.resolve({
        data: table in hoisted.maybeSingleByTable ? hoisted.maybeSingleByTable[table] : hoisted.memberRow,
        error: null,
      })
    // Make the chain awaitable — resolves to the configured delete result.
    chain.then = (resolve: (v: unknown) => unknown) =>
      resolve(
        isSelect
          ? { data: hoisted.selectRowsByTable[table] ?? hoisted.selectRows, error: null }
          : { error: hoisted.deleteResult.error, count: hoisted.deleteResult.count },
      )
    return chain
  }

  return {
    from: (table: string) => {
      hoisted.fromSpy(table)
      return makeChain(table)
    },
    rpc: (...args: unknown[]) => hoisted.rpc(...args),
    auth: { getUser: hoisted.getUser },
  }
}

function bulkReq(body: unknown): NextRequest {
  return buildRequest({
    url: 'https://nativeintelligence.dev/api/account/bulk',
    method: 'POST',
    body,
  }) as unknown as NextRequest
}

const { POST } = await import('@/app/api/account/bulk/route')

describe('POST /api/account/bulk — knowledge-graph-safe delete', () => {
  beforeEach(() => {
    hoisted.getUser.mockResolvedValue({ data: { user: { id: USER_ID } } })
    hoisted.getCurrentWorkspaceId.mockResolvedValue(WORKSPACE_ID)
    hoisted.rpc.mockReset()
    hoisted.rpc.mockResolvedValue({ error: null })
    hoisted.fromSpy.mockReset()
    hoisted.deleteResult = { error: null, count: 0 }
    hoisted.emitStatusChange.mockReset()
    hoisted.selectRows = []
    hoisted.selectRowsByTable = {}
    hoisted.requireWorkspaceFeature.mockReset().mockResolvedValue(null)
    hoisted.deleteEvalCaptures.mockReset().mockResolvedValue(undefined)
    hoisted.collectTrialCaptureIds.mockReset().mockResolvedValue([])
  })

  it('routes capture bulk delete through the RPC once per id, never a raw delete', async () => {
    const ids = ['cap-1', 'cap-2', 'cap-3']
    const res = await POST(bulkReq({ entity_type: 'capture', ids, action: 'delete' }))
    expect(res.status).toBe(200)

    const json = await readJson<{ success: number; failed: number }>(res)
    expect(json.success).toBe(3)
    expect(json.failed).toBe(0)

    // One RPC call per id, with the right name + args.
    expect(hoisted.rpc).toHaveBeenCalledTimes(3)
    for (const id of ids) {
      expect(hoisted.rpc).toHaveBeenCalledWith('delete_capture_with_knowledge', {
        p_capture_id: id,
        p_workspace_id: WORKSPACE_ID,
      })
    }
    // The raw bulk-delete path must NOT be used for captures.
    expect(hoisted.fromSpy).not.toHaveBeenCalledWith('captures')
  })

  it('routes document bulk delete through delete_document_with_knowledge per id', async () => {
    const ids = ['doc-1', 'doc-2']
    const res = await POST(bulkReq({ entity_type: 'document', ids, action: 'delete' }))
    expect(res.status).toBe(200)

    const json = await readJson<{ success: number; failed: number }>(res)
    expect(json.success).toBe(2)
    expect(json.failed).toBe(0)

    expect(hoisted.rpc).toHaveBeenCalledTimes(2)
    for (const id of ids) {
      expect(hoisted.rpc).toHaveBeenCalledWith('delete_document_with_knowledge', {
        p_document_id: id,
        p_workspace_id: WORKSPACE_ID,
      })
    }
    // The document table is never raw-deleted.
    expect(hoisted.fromSpy).not.toHaveBeenCalledWith('document')
  })

  it('counts a P0002 id as failed but still processes the rest', async () => {
    // Second id is not found; first and third succeed.
    hoisted.rpc
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { code: 'P0002', message: 'capture not found' } })
      .mockResolvedValueOnce({ error: null })

    const ids = ['cap-1', 'cap-missing', 'cap-3']
    const res = await POST(bulkReq({ entity_type: 'capture', ids, action: 'delete' }))
    expect(res.status).toBe(200)

    const json = await readJson<{ success: number; failed: number; errors?: string[] }>(res)
    expect(json.success).toBe(2)
    expect(json.failed).toBe(1)
    expect(json.errors).toEqual(['cap-missing: Capture not found'])

    // All three ids were still attempted — no early abort.
    expect(hoisted.rpc).toHaveBeenCalledTimes(3)
  })

  it('non-knowledge entities (actions) use the raw bulk delete, no RPC', async () => {
    hoisted.deleteResult = { error: null, count: 2 }
    const res = await POST(bulkReq({ entity_type: 'action', ids: ['act-1', 'act-2'], action: 'delete' }))
    expect(res.status).toBe(200)

    const json = await readJson<{ success: number; failed: number }>(res)
    expect(json.success).toBe(2)

    // Raw path went through .from('actions'); the RPC was never called.
    expect(hoisted.fromSpy).toHaveBeenCalledWith('actions')
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('reports rows the raw delete skipped as failed, with a reason', async () => {
    // RLS or the owner filter skipping a row is not an error to Postgres —
    // only the count shows it, and the client needs words to show the user.
    hoisted.deleteResult = { error: null, count: 1 }
    const res = await POST(
      bulkReq({ entity_type: 'action', ids: ['act-1', 'act-2', 'act-3'], action: 'delete' }),
    )
    expect(res.status).toBe(200)

    const json = await readJson<{ success: number; failed: number; errors?: string[] }>(res)
    expect(json.success).toBe(1)
    expect(json.failed).toBe(2)
    expect(json.errors).toEqual([
      'they may already be gone, or you may not have permission to delete them',
    ])
  })

  it('deletes actions like the single-action DELETE: workspace-scoped, no creator filter', async () => {
    // DELETE /api/account/actions/:id filters on id + workspace and leaves the
    // rest to RLS (actions_delete: owners and admins). Bulk used to add
    // `user_id = caller`, so an admin's bulk delete silently skipped every
    // action a teammate or integration had created.
    hoisted.eqSpy.mockReset()
    hoisted.deleteResult = { error: null, count: 2 }
    const res = await POST(bulkReq({ entity_type: 'action', ids: ['act-1', 'act-2'], action: 'delete' }))
    expect(res.status).toBe(200)

    expect(hoisted.eqSpy).toHaveBeenCalledWith('actions', 'workspace_id', WORKSPACE_ID)
    expect(hoisted.eqSpy).not.toHaveBeenCalledWith('actions', 'user_id', USER_ID)
  })

  it('keeps the creator filter, and says so, for other owner-scoped types', async () => {
    hoisted.eqSpy.mockReset()
    hoisted.deleteResult = { error: null, count: 0 }
    const res = await POST(bulkReq({ entity_type: 'project', ids: ['proj-1', 'proj-2'], action: 'delete' }))
    expect(res.status).toBe(200)

    expect(hoisted.eqSpy).toHaveBeenCalledWith('projects', 'user_id', USER_ID)
    const json = await readJson<{ failed: number; errors?: string[] }>(res)
    expect(json.failed).toBe(2)
    expect(json.errors).toEqual([
      'they may already be gone, belong to someone else, or need a workspace owner or admin to delete',
    ])
  })

  it('returns 401 when unauthenticated', async () => {
    hoisted.getUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(bulkReq({ entity_type: 'capture', ids: ['cap-1'], action: 'delete' }))
    expect(res.status).toBe(401)
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('returns 400 when more than 100 ids are supplied', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `cap-${i}`)
    const res = await POST(bulkReq({ entity_type: 'capture', ids, action: 'delete' }))
    expect(res.status).toBe(400)
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })
})

/**
 * The bulk status writer used to mutate status_id with no emit, so a board
 * multi-select drag fired no Flows and (post-Asana) echoed no external task
 * updates. Every other status writer funnels through emitStatusChange; this one
 * now does too.
 */
describe('POST /api/account/bulk — change_status emits the status-change trigger', () => {
  beforeEach(() => {
    hoisted.getUser.mockResolvedValue({ data: { user: { id: USER_ID } } })
    hoisted.getCurrentWorkspaceId.mockResolvedValue(WORKSPACE_ID)
    hoisted.emitStatusChange.mockReset()
    hoisted.selectRows = []
    hoisted.deleteResult = { error: null, count: 2 }
    hoisted.maybeSingleByTable = { workflow_state: { id: 'st-done', team_id: 'team-a' } }
  })

  it('emits once per affected action with its OWN team and FROM status', async () => {
    hoisted.selectRows = [
      { id: 'act-1', team_id: 'team-a', status_id: 'st-todo' },
      { id: 'act-2', team_id: 'team-a', status_id: 'st-doing' },
    ]

    const res = await POST(
      bulkReq({
        entity_type: 'action',
        ids: ['act-1', 'act-2'],
        action: 'change_status',
        value: 'st-done',
      }),
    )
    expect(res.status).toBe(200)

    expect(hoisted.emitStatusChange).toHaveBeenCalledTimes(2)
    expect(hoisted.emitStatusChange).toHaveBeenCalledWith({
      entityType: 'action',
      entityId: 'act-1',
      workspaceId: WORKSPACE_ID,
      teamId: 'team-a',
      fromStatusId: 'st-todo',
      toStatusId: 'st-done',
      actorUserId: USER_ID,
    })
    expect(hoisted.emitStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'act-2', teamId: 'team-a', fromStatusId: 'st-doing' }),
    )
  })

  it("400s and writes nothing when the status is another team's state", async () => {
    hoisted.selectRows = [
      { id: 'act-1', team_id: 'team-a', status_id: 'st-todo' },
      { id: 'act-2', team_id: 'team-b', status_id: 'st-doing' },
    ]
    hoisted.fromSpy.mockClear()
    const res = await POST(
      bulkReq({ entity_type: 'action', ids: ['act-1', 'act-2'], action: 'change_status', value: 'st-done' }),
    )
    expect(res.status).toBe(400)
    expect(hoisted.emitStatusChange).not.toHaveBeenCalled()
    // Only the two validation reads ran; executeBulkAction never did.
    expect(hoisted.fromSpy.mock.calls.map((c) => c[0])).toEqual(['workflow_state', 'actions'])
  })

  it('400s when the status does not exist', async () => {
    hoisted.maybeSingleByTable = { workflow_state: null }
    hoisted.selectRows = [{ id: 'act-1', team_id: 'team-a', status_id: 'st-todo' }]
    const res = await POST(
      bulkReq({ entity_type: 'action', ids: ['act-1'], action: 'change_status', value: 'st-gone' }),
    )
    expect(res.status).toBe(400)
  })

  it('emits nothing when no action rows were in scope', async () => {
    hoisted.selectRows = []
    const res = await POST(
      bulkReq({
        entity_type: 'action',
        ids: ['act-nope'],
        action: 'change_status',
        value: 'st-done',
      }),
    )
    expect(res.status).toBe(200)
    expect(hoisted.emitStatusChange).not.toHaveBeenCalled()
  })

  it('does NOT emit for non-action entities (they have no status trigger)', async () => {
    hoisted.selectRows = [{ id: 'cap-1', team_id: 'team-a', status_id: 'x' }]
    const res = await POST(
      bulkReq({
        entity_type: 'capture',
        ids: ['cap-1'],
        action: 'change_status',
        value: 'archived',
      }),
    )
    expect(res.status).toBe(200)
    expect(hoisted.emitStatusChange).not.toHaveBeenCalled()
  })

  it('still rejects a change_status with no value', async () => {
    const res = await POST(
      bulkReq({ entity_type: 'action', ids: ['act-1'], action: 'change_status' }),
    )
    expect(res.status).toBe(500)
    expect(hoisted.emitStatusChange).not.toHaveBeenCalled()
  })
})

/**
 * Bulk updates are scoped by the owner column (and RLS), so some selected ids
 * can be skipped. The response must count those as failed rather than echo
 * ids.length, and join-table writes must follow only the rows actually updated.
 */
describe('POST /api/account/bulk — updates report what actually changed', () => {
  beforeEach(() => {
    hoisted.getUser.mockResolvedValue({ data: { user: { id: USER_ID } } })
    hoisted.getCurrentWorkspaceId.mockResolvedValue(WORKSPACE_ID)
    hoisted.insertSpy.mockReset()
    hoisted.selectRows = []
    hoisted.selectRowsByTable = {}
    hoisted.deleteResult = { error: null, count: 0 }
  })

  it('set_priority counts ids the owner filter skipped as failed', async () => {
    hoisted.deleteResult = { error: null, count: 1 }
    const res = await POST(
      bulkReq({ entity_type: 'action', ids: ['act-1', 'act-2'], action: 'set_priority', value: 'high' }),
    )
    expect(res.status).toBe(200)
    const json = await readJson<{ success: number; failed: number; errors?: string[] }>(res)
    expect(json.success).toBe(1)
    expect(json.failed).toBe(1)
    expect(json.errors).toHaveLength(1)
  })

  it('assign_to re-seats only the actions the update touched', async () => {
    hoisted.selectRowsByTable = { actions: [{ id: 'act-1' }] }
    const res = await POST(
      bulkReq({ entity_type: 'action', ids: ['act-1', 'act-2'], action: 'assign_to', value: 'mem-1' }),
    )
    expect(res.status).toBe(200)
    const json = await readJson<{ success: number; failed: number }>(res)
    expect(json.success).toBe(1)
    expect(json.failed).toBe(1)
    expect(hoisted.insertSpy).toHaveBeenCalledWith('action_assignee', [
      { action_id: 'act-1', member_id: 'mem-1' },
    ])
  })
})

/**
 * CRM entities: the tables are SINGULAR (contact/company, migration 033) and
 * carry NO user_id column — a user_id filter would either error or match
 * nothing. Company deletes must cascade through deleteCompaniesWithContacts
 * (contact.company_id is ON DELETE SET NULL, so a raw company delete orphans
 * contacts).
 */
describe('POST /api/account/bulk — CRM entities (contact/company)', () => {
  beforeEach(() => {
    hoisted.getUser.mockResolvedValue({ data: { user: { id: USER_ID } } })
    hoisted.getCurrentWorkspaceId.mockResolvedValue(WORKSPACE_ID)
    hoisted.rpc.mockReset()
    hoisted.fromSpy.mockReset()
    hoisted.eqSpy.mockReset()
    hoisted.deleteResult = { error: null, count: 0 }
    hoisted.selectRows = []
    hoisted.deleteCompaniesWithContacts.mockReset()
    hoisted.deleteCompaniesWithContacts.mockResolvedValue({ companies: 2, contacts: 5 })
    hoisted.memberRow = { role: 'owner' }
  })

  it('refuses company delete for plain members with 403', async () => {
    hoisted.memberRow = { role: 'member' }
    const res = await POST(
      bulkReq({ entity_type: 'company', ids: ['co-1'], action: 'delete' }),
    )
    expect(res.status).toBe(403)
    expect(hoisted.deleteCompaniesWithContacts).not.toHaveBeenCalled()
  })

  it('company delete cascades through deleteCompaniesWithContacts on the service client', async () => {
    const ids = ['co-1', 'co-2']
    const res = await POST(bulkReq({ entity_type: 'company', ids, action: 'delete' }))
    expect(res.status).toBe(200)

    const json = await readJson<{ success: number; failed: number }>(res)
    expect(json.success).toBe(2)
    expect(json.failed).toBe(0)

    expect(hoisted.deleteCompaniesWithContacts).toHaveBeenCalledTimes(1)
    expect(hoisted.deleteCompaniesWithContacts).toHaveBeenCalledWith(
      hoisted.serviceClient,
      WORKSPACE_ID,
      ids,
    )
    // No raw table delete for companies.
    expect(hoisted.fromSpy).not.toHaveBeenCalledWith('company')
    expect(hoisted.fromSpy).not.toHaveBeenCalledWith('companies')
  })

  it('counts company ids the cascade skipped (outside workspace) as failed', async () => {
    hoisted.deleteCompaniesWithContacts.mockResolvedValue({ companies: 1, contacts: 0 })
    const res = await POST(
      bulkReq({ entity_type: 'company', ids: ['co-1', 'co-other'], action: 'delete' }),
    )
    const json = await readJson<{ success: number; failed: number }>(res)
    expect(json.success).toBe(1)
    expect(json.failed).toBe(1)
  })

  it('contact delete stays a plain workspace-scoped delete on the singular table', async () => {
    hoisted.deleteResult = { error: null, count: 2 }
    const res = await POST(
      bulkReq({ entity_type: 'contact', ids: ['ct-1', 'ct-2'], action: 'delete' }),
    )
    expect(res.status).toBe(200)

    const json = await readJson<{ success: number }>(res)
    expect(json.success).toBe(2)

    expect(hoisted.fromSpy).toHaveBeenCalledWith('contact')
    expect(hoisted.fromSpy).not.toHaveBeenCalledWith('contacts')
    expect(hoisted.deleteCompaniesWithContacts).not.toHaveBeenCalled()
    // Workspace-scoped only — never a user_id filter (the column doesn't exist).
    expect(hoisted.eqSpy).toHaveBeenCalledWith('contact', 'workspace_id', WORKSPACE_ID)
    expect(hoisted.eqSpy).not.toHaveBeenCalledWith('contact', 'user_id', USER_ID)
  })

  it('set_relationship_type updates contacts without a user_id filter', async () => {
    hoisted.deleteResult = { error: null, count: 1 }
    const res = await POST(
      bulkReq({
        entity_type: 'contact',
        ids: ['ct-1'],
        action: 'set_relationship_type',
        value: 'customer',
      }),
    )
    expect(res.status).toBe(200)

    expect(hoisted.fromSpy).toHaveBeenCalledWith('contact')
    expect(hoisted.eqSpy).toHaveBeenCalledWith('contact', 'workspace_id', WORKSPACE_ID)
    expect(hoisted.eqSpy).not.toHaveBeenCalledWith('contact', 'user_id', USER_ID)
  })

  it('add_tags merges tags on companies without a user_id filter', async () => {
    hoisted.selectRows = [{ tags: ['existing'] }]
    hoisted.deleteResult = { error: null, count: 1 }
    const res = await POST(
      bulkReq({ entity_type: 'company', ids: ['co-1'], action: 'add_tags', value: ['vip'] }),
    )
    expect(res.status).toBe(200)

    const json = await readJson<{ success: number; failed: number }>(res)
    expect(json.success).toBe(1)
    expect(json.failed).toBe(0)

    expect(hoisted.fromSpy).toHaveBeenCalledWith('company')
    expect(hoisted.eqSpy).toHaveBeenCalledWith('company', 'workspace_id', WORKSPACE_ID)
    expect(hoisted.eqSpy).not.toHaveBeenCalledWith('company', 'user_id', USER_ID)
  })

  // A contact the caller may only view (can_edit_contact RLS) matches 0 rows
  // with no error: it is a failure, not a success.
  it('add_tags counts a row the update did not match as failed', async () => {
    hoisted.selectRows = [{ tags: [] }]
    hoisted.deleteResult = { error: null, count: 0 }
    const res = await POST(
      bulkReq({ entity_type: 'contact', ids: ['c-1'], action: 'add_tags', value: ['vip'] }),
    )
    expect(res.status).toBe(200)
    const json = await readJson<{ success: number; failed: number }>(res)
    expect(json.success).toBe(0)
    expect(json.failed).toBe(1)
  })
})

/**
 * eval_suite — the feature gate and the two things a bare cascade would miss.
 *
 * A suite delete cascades to its cases and runs (migration 252). It does NOT
 * reach two things, and the single-record DELETE handles both — so the bulk
 * path must too, or "delete 3 suites" behaves differently from deleting them
 * one at a time:
 *
 *   a RUN IN FLIGHT — the Inngest lane would keep writing trials against a
 *   suite that no longer exists;
 *   the TEMPLATE CAPTURES — the composite FK runs case → capture, so each
 *   case's `is_eval` capture outlives the cascade as a row no screen lists.
 */
describe('POST /api/account/bulk — eval_suite', () => {
  beforeEach(() => {
    hoisted.getUser.mockResolvedValue({ data: { user: { id: USER_ID } } })
    hoisted.getCurrentWorkspaceId.mockResolvedValue(WORKSPACE_ID)
    hoisted.fromSpy.mockReset()
    hoisted.eqSpy.mockReset()
    hoisted.deleteResult = { error: null, count: 0 }
    hoisted.selectRows = []
    hoisted.selectRowsByTable = {}
    hoisted.requireWorkspaceFeature.mockReset().mockResolvedValue(null)
    hoisted.deleteEvalCaptures.mockReset().mockResolvedValue(undefined)
    hoisted.collectTrialCaptureIds.mockReset().mockResolvedValue([])
  })

  it('403s and touches nothing when Evals is off for the workspace', async () => {
    hoisted.requireWorkspaceFeature.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: '`Evals` is not enabled for this workspace', code: 'FEATURE_DISABLED' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const res = await POST(bulkReq({ entity_type: 'eval_suite', ids: ['s1'], action: 'delete' }))
    expect(res.status).toBe(403)
    const json = await readJson<{ code: string }>(res)
    expect(json.code).toBe('FEATURE_DISABLED')
    expect(hoisted.fromSpy).not.toHaveBeenCalledWith('eval_suite')
  })

  it('deletes the suites and cleans up their template captures afterwards', async () => {
    hoisted.selectRowsByTable = {
      eval_run: [],
      eval_case: [
        { id: 'c1', capture_id: 'cap-1' },
        { id: 'c2', capture_id: 'cap-2' },
      ],
    }
    hoisted.deleteResult = { error: null, count: 2 }

    const res = await POST(bulkReq({ entity_type: 'eval_suite', ids: ['s1', 's2'], action: 'delete' }))
    expect(res.status).toBe(200)
    const json = await readJson<{ success: number; failed: number }>(res)
    expect(json.success).toBe(2)
    expect(json.failed).toBe(0)

    expect(hoisted.fromSpy).toHaveBeenCalledWith('eval_suite')
    // The cleanup runs on the SERVICE client (a template capture is private to
    // whoever authored the case), and only after the cascade has landed.
    expect(hoisted.deleteEvalCaptures).toHaveBeenCalledWith(
      hoisted.serviceClient,
      WORKSPACE_ID,
      ['cap-1', 'cap-2'],
    )
  })

  it('scopes the delete by workspace and never by an owner column', async () => {
    // eval_suite.created_by references auth.users(id), not member.id, so an
    // owner filter would compare disjoint UUID spaces and delete nothing.
    hoisted.selectRowsByTable = { eval_run: [], eval_case: [] }
    hoisted.deleteResult = { error: null, count: 1 }

    await POST(bulkReq({ entity_type: 'eval_suite', ids: ['s1'], action: 'delete' }))

    const suiteEqs = hoisted.eqSpy.mock.calls.filter((c) => c[0] === 'eval_suite')
    expect(suiteEqs).toContainEqual(['eval_suite', 'workspace_id', WORKSPACE_ID])
    expect(suiteEqs.some((c) => c[1] === 'user_id' || c[1] === 'created_by')).toBe(false)
  })

  it('refuses a suite with a run in flight, and still deletes the rest', async () => {
    hoisted.selectRowsByTable = {
      eval_run: [{ suite_id: 's2' }],
      eval_case: [{ id: 'c1', capture_id: 'cap-1' }],
    }
    hoisted.deleteResult = { error: null, count: 1 }

    const res = await POST(bulkReq({ entity_type: 'eval_suite', ids: ['s1', 's2'], action: 'delete' }))
    expect(res.status).toBe(200)
    const json = await readJson<{ success: number; failed: number; errors?: string[] }>(res)
    expect(json.success).toBe(1)
    expect(json.failed).toBe(1)
    expect(json.errors?.[0]).toContain('s2')
    expect(json.errors?.[0]).toContain('run in flight')
  })

  // The composite FK runs capture → trial, so the cascade destroys eval_trial
  // and every per-trial CLONE capture would survive with nothing pointing at
  // it. They have to be collected BEFORE the delete, while the trials exist.
  it('collects the per-trial CLONE captures before the cascade and deletes them too', async () => {
    hoisted.selectRowsByTable = {
      eval_run: [],
      eval_case: [{ id: 'c1', capture_id: 'cap-1' }],
    }
    hoisted.collectTrialCaptureIds.mockResolvedValue(['clone-1', 'clone-2'])
    hoisted.deleteResult = { error: null, count: 1 }

    await POST(bulkReq({ entity_type: 'eval_suite', ids: ['s1'], action: 'delete' }))

    expect(hoisted.collectTrialCaptureIds).toHaveBeenCalledWith(
      hoisted.serviceClient,
      WORKSPACE_ID,
      ['c1'],
    )
    expect(hoisted.deleteEvalCaptures).toHaveBeenCalledWith(
      hoisted.serviceClient,
      WORKSPACE_ID,
      ['cap-1', 'clone-1', 'clone-2'],
    )
  })

  it('deletes nothing at all when every selected suite is running', async () => {
    hoisted.selectRowsByTable = { eval_run: [{ suite_id: 's1' }], eval_case: [] }

    const res = await POST(bulkReq({ entity_type: 'eval_suite', ids: ['s1'], action: 'delete' }))
    const json = await readJson<{ success: number; failed: number }>(res)
    expect(json.success).toBe(0)
    expect(json.failed).toBe(1)
    // No delete issued, and no capture cleanup either.
    expect(hoisted.fromSpy).not.toHaveBeenCalledWith('eval_case')
    expect(hoisted.deleteEvalCaptures).not.toHaveBeenCalled()
  })
})

/**
 * eval_case — the same gate, and the ONE thing a bare cascade would miss.
 *
 * The Cases tab is a scoped `UnifiedViewLayout` now, so selecting rows and
 * pressing Delete lands here. What the cascade does NOT reach is each case's
 * TEMPLATE CAPTURE: the composite FK runs case → capture (migration 252), so
 * the `is_eval` capture outlives the row as something no screen lists and
 * nothing else ever collects. The single-record DELETE
 * (/api/account/evals/cases/[id]) cleans it up, and this path must match it or
 * "delete 3 cases" leaks where deleting them one at a time does not.
 *
 * Unlike the suite path there is NO live-run refusal, and that is deliberate:
 * deleting a case mid-run orphans nothing (eval_trial cascades from the case
 * and the run survives with fewer trials), so refusing would block ordinary
 * authoring for as long as any run is in flight.
 */
describe('POST /api/account/bulk — eval_case', () => {
  beforeEach(() => {
    hoisted.getUser.mockResolvedValue({ data: { user: { id: USER_ID } } })
    hoisted.getCurrentWorkspaceId.mockResolvedValue(WORKSPACE_ID)
    hoisted.fromSpy.mockReset()
    hoisted.eqSpy.mockReset()
    hoisted.deleteResult = { error: null, count: 0 }
    hoisted.selectRows = []
    hoisted.selectRowsByTable = {}
    hoisted.requireWorkspaceFeature.mockReset().mockResolvedValue(null)
    hoisted.deleteEvalCaptures.mockReset().mockResolvedValue(undefined)
    hoisted.collectTrialCaptureIds.mockReset().mockResolvedValue([])
  })

  it('403s and touches nothing when Evals is off for the workspace', async () => {
    hoisted.requireWorkspaceFeature.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: '`Evals` is not enabled for this workspace', code: 'FEATURE_DISABLED' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const res = await POST(bulkReq({ entity_type: 'eval_case', ids: ['c1'], action: 'delete' }))
    expect(res.status).toBe(403)
    const json = await readJson<{ code: string }>(res)
    expect(json.code).toBe('FEATURE_DISABLED')
    expect(hoisted.fromSpy).not.toHaveBeenCalledWith('eval_case')
  })

  it('deletes the cases and cleans up their template captures afterwards', async () => {
    hoisted.selectRowsByTable = {
      eval_case: [{ capture_id: 'cap-1' }, { capture_id: 'cap-2' }],
    }
    hoisted.deleteResult = { error: null, count: 2 }

    const res = await POST(bulkReq({ entity_type: 'eval_case', ids: ['c1', 'c2'], action: 'delete' }))
    expect(res.status).toBe(200)
    const json = await readJson<{ success: number; failed: number }>(res)
    expect(json.success).toBe(2)
    expect(json.failed).toBe(0)

    expect(hoisted.fromSpy).toHaveBeenCalledWith('eval_case')
    // On the SERVICE client, and only after the rows are gone — a capture
    // deleted first would take its case down with it while the case delete
    // could still fail.
    expect(hoisted.deleteEvalCaptures).toHaveBeenCalledWith(
      hoisted.serviceClient,
      WORKSPACE_ID,
      ['cap-1', 'cap-2'],
    )
  })

  it('reports rows RLS refused as failed rather than claiming success', async () => {
    // A 'private' case is creator-only under migration 252's select policy, so
    // a member can select one in a shared list and still not be allowed to
    // delete it. `count: 'exact'` is what makes that visible.
    hoisted.selectRowsByTable = { eval_case: [{ capture_id: 'cap-1' }] }
    hoisted.deleteResult = { error: null, count: 1 }

    const res = await POST(bulkReq({ entity_type: 'eval_case', ids: ['c1', 'c2'], action: 'delete' }))
    const json = await readJson<{ success: number; failed: number }>(res)
    expect(json.success).toBe(1)
    expect(json.failed).toBe(1)
  })

  it('scopes the delete by workspace and never by an owner column', async () => {
    // eval_case.created_by references auth.users(id), not member.id — the same
    // disjoint-UUID trap the suite path documents.
    hoisted.selectRowsByTable = { eval_case: [] }
    hoisted.deleteResult = { error: null, count: 1 }

    await POST(bulkReq({ entity_type: 'eval_case', ids: ['c1'], action: 'delete' }))

    const caseEqs = hoisted.eqSpy.mock.calls.filter((c) => c[0] === 'eval_case')
    expect(caseEqs).toContainEqual(['eval_case', 'workspace_id', WORKSPACE_ID])
    expect(caseEqs.some((c) => c[1] === 'user_id' || c[1] === 'created_by')).toBe(false)
  })

  it('collects the per-trial CLONE captures too, keyed on the case ids', async () => {
    hoisted.selectRowsByTable = { eval_case: [{ capture_id: 'cap-1' }] }
    hoisted.collectTrialCaptureIds.mockResolvedValue(['clone-1'])
    hoisted.deleteResult = { error: null, count: 1 }

    await POST(bulkReq({ entity_type: 'eval_case', ids: ['c1'], action: 'delete' }))

    expect(hoisted.collectTrialCaptureIds).toHaveBeenCalledWith(
      hoisted.serviceClient,
      WORKSPACE_ID,
      ['c1'],
    )
    expect(hoisted.deleteEvalCaptures).toHaveBeenCalledWith(
      hoisted.serviceClient,
      WORKSPACE_ID,
      ['cap-1', 'clone-1'],
    )
  })

  it('never consults eval_run — a case delete has no live-run refusal', async () => {
    hoisted.selectRowsByTable = { eval_case: [{ capture_id: 'cap-1' }] }
    hoisted.deleteResult = { error: null, count: 1 }

    await POST(bulkReq({ entity_type: 'eval_case', ids: ['c1'], action: 'delete' }))
    expect(hoisted.fromSpy).not.toHaveBeenCalledWith('eval_run')
  })
})

/**
 * eval_run — there is nothing to bulk-delete, and that is the assertion.
 *
 * A run is the record of what one prompt scored at one moment; deleting it
 * deletes the evidence behind every comparison that cites it. BULK_ACTIONS
 * registers none, and ENTITY_TABLE deliberately has no mapping — so a caller
 * that reached here anyway is answered with "unsupported" rather than a
 * working bulk delete nobody designed.
 */
describe('POST /api/account/bulk — eval_run', () => {
  beforeEach(() => {
    hoisted.getUser.mockResolvedValue({ data: { user: { id: USER_ID } } })
    hoisted.getCurrentWorkspaceId.mockResolvedValue(WORKSPACE_ID)
    hoisted.fromSpy.mockReset()
    hoisted.requireWorkspaceFeature.mockReset().mockResolvedValue(null)
    hoisted.deleteEvalCaptures.mockReset().mockResolvedValue(undefined)
    hoisted.collectTrialCaptureIds.mockReset().mockResolvedValue([])
  })

  it('refuses a run delete and never touches the table', async () => {
    const res = await POST(bulkReq({ entity_type: 'eval_run', ids: ['r1'], action: 'delete' }))
    expect(res.status).not.toBe(200)
    expect(hoisted.fromSpy).not.toHaveBeenCalledWith('eval_run')
  })
})

describe('POST /api/account/bulk — add_labels', () => {
  beforeEach(() => {
    hoisted.getUser.mockResolvedValue({ data: { user: { id: USER_ID } } })
    hoisted.getCurrentWorkspaceId.mockResolvedValue(WORKSPACE_ID)
    hoisted.upsertSpy.mockReset()
    hoisted.selectRows = []
    hoisted.deleteResult = { error: null, count: 0 }
  })

  it('labels projects through the project_label junction, never a label_ids column', async () => {
    hoisted.selectRowsByTable = { label: [{ id: 'lab-1' }], projects: [{ id: 'proj-1' }] }
    const res = await POST(
      bulkReq({ entity_type: 'project', ids: ['proj-1', 'proj-x'], action: 'add_labels', value: ['lab-1'] }),
    )
    expect(res.status).toBe(200)
    expect(await readJson(res)).toMatchObject({ success: 1, failed: 1 })
    expect(hoisted.upsertSpy).toHaveBeenCalledTimes(1)
    expect(hoisted.upsertSpy).toHaveBeenCalledWith('project_label', [{ project_id: 'proj-1', label_id: 'lab-1' }])
  })

  it('labels initiatives through initiative_label', async () => {
    hoisted.selectRowsByTable = { label: [{ id: 'lab-1' }], initiative: [{ id: 'ini-1' }] }
    const res = await POST(
      bulkReq({ entity_type: 'initiative', ids: ['ini-1'], action: 'add_labels', value: ['lab-1'] }),
    )
    expect(res.status).toBe(200)
    expect(hoisted.upsertSpy).toHaveBeenCalledWith('initiative_label', [{ initiative_id: 'ini-1', label_id: 'lab-1' }])
  })

  it("400s on a label that is not this workspace's", async () => {
    hoisted.selectRowsByTable = { label: [], projects: [{ id: 'proj-1' }] }
    const res = await POST(
      bulkReq({ entity_type: 'project', ids: ['proj-1'], action: 'add_labels', value: ['lab-foreign'] }),
    )
    expect(res.status).toBe(400)
    expect(hoisted.upsertSpy).not.toHaveBeenCalled()
  })
})
