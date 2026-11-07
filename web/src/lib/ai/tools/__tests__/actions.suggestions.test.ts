/**
 * Tests for get_action_suggestions, dismiss_proposal, and accept_proposal
 * tools in actions.ts.
 *
 * Root cause (GEN-73): get_action_suggestions was querying the `actions` table
 * with confirmation='suggested', but the live agent writes proposals to the
 * `proposed_change` table with status='pending'. The fix points the tool at the
 * correct table.
 *
 * GEN-93: accept_proposal — single-call alternative to the lossy create+dismiss
 * workaround. Delegates to the same apply-engine used by the HTTP route.
 *
 * GEN-74: get_action_suggestions returned up to 50 full-detail rows unpaginated
 * (~90KB with a 50-proposal queue), blowing client token limits. Now paginated
 * (limit/offset, default 20) with a compact default shape; verbose=true restores
 * full detail with a tighter page cap, and pending_by_capture summarizes the
 * whole queue.
 *
 * These are Vitest unit tests (no network, no DB). They run via `npm test`
 * as part of the standard test suite and are covered by CI on every PR.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createSupabaseMock } from '@/test/supabase-mock'
import { createActionTools } from '../actions'

// Hoist the mock function before vi.mock so the factory can reference it.
const { mockApplyChange } = vi.hoisted(() => ({
  mockApplyChange: vi.fn(),
}))

// Replace the entire apply-engine module so tests never hit the real DB or
// any mcp-client imports that would fail in a test environment.
vi.mock('@/lib/proposed-changes/apply-engine', () => ({
  applyChange: mockApplyChange,
}))

const USER_ID = 'user-uuid-1'
const WORKSPACE_ID = 'workspace-uuid-1'

// Minimal ToolExecutionOptions required by the AI SDK tool execute signature.
const EXEC_OPTS = {
  toolCallId: 'test-call-id',
  messages: [],
  context: {},
} satisfies ToolExecutionOptions<Record<string, unknown>>

/**
 * Parse raw args through the tool's zod inputSchema before calling execute —
 * the MCP/AI SDK layer registers the zod shape, so defaults (limit=20,
 * offset=0, verbose=false) are filled before execute runs, exactly as in
 * production. Calling execute with raw args would skip the defaulting.
 */
function runGetSuggestions(supabase: unknown, rawArgs: Record<string, unknown> = {}) {
  const tools = createActionTools(USER_ID, supabase as never, WORKSPACE_ID)
  const schema = tools.get_action_suggestions.inputSchema as unknown as {
    parse: (v: unknown) => Record<string, unknown>
  }
  const parsed = schema.parse(rawArgs)
  return tools.get_action_suggestions.execute!(parsed as never, EXEC_OPTS)
}

const PENDING_PROPOSAL = {
  id: 'proposal-uuid-1',
  capture_id: 'capture-uuid-1',
  change_type: 'create',
  entity_type: 'action',
  entity_id: null,
  display_text: 'Liam to follow up with vendor by Friday',
  title: 'Follow up with vendor',
  description: 'Send pricing proposal and schedule next call',
  priority: 'high',
  due_date: '2026-05-30',
  assignee_name: 'Liam',
  assignee_member_id: 'member-uuid-1',
  project_id: null,
  reasoning: 'Explicit commitment made in meeting',
  trigger_quote: 'I\'ll follow up with the vendor this Friday',
  stakes: null,
  open_questions: [],
  confidence: 0.9,
  created_at: '2026-05-26T10:00:00Z',
  capture: { id: 'capture-uuid-1', title: 'Vendor Sync Meeting' },
}

describe('get_action_suggestions', () => {
  let supabase: ReturnType<typeof createSupabaseMock>

  beforeEach(() => {
    supabase = createSupabaseMock({
      tables: {
        proposed_change: {
          data: [PENDING_PROPOSAL],
          error: null,
        },
      },
    })
  })

  it('queries proposed_change table (not actions) with status=pending', async () => {
    const result = await runGetSuggestions(supabase) as any

    expect(result.success).toBe(true)

    // Confirm we queried the proposed_change table
    expect(supabase.from).toHaveBeenCalledWith('proposed_change')
    // Confirm we did NOT query the actions table for suggestions
    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0])
    expect(fromCalls).not.toContain('actions')
  })

  it('maps proposals to a compact response shape with capture_title by default', async () => {
    const result = await runGetSuggestions(supabase) as any

    expect(result.success).toBe(true)
    expect(result.count).toBe(1)

    const suggestion = result.suggestions?.[0]
    expect(suggestion).toMatchObject({
      id: 'proposal-uuid-1',
      capture_id: 'capture-uuid-1',
      capture_title: 'Vendor Sync Meeting',
      change_type: 'create',
      entity_type: 'action',
      display_text: 'Liam to follow up with vendor by Friday',
      priority: 'high',
      due_date: '2026-05-30',
      assignee_name: 'Liam',
      confidence: 0.9,
    })

    // Compact mode drops the heavy provenance prose (GEN-74).
    expect(suggestion).not.toHaveProperty('reasoning')
    expect(suggestion).not.toHaveProperty('trigger_quote')
    expect(suggestion).not.toHaveProperty('description')
    expect(suggestion).not.toHaveProperty('open_questions')
  })

  it('verbose=true includes full detail (reasoning, trigger_quote, description)', async () => {
    const result = await runGetSuggestions(supabase, { verbose: true }) as any

    expect(result.success).toBe(true)
    expect(result.verbose).toBe(true)

    const suggestion = result.suggestions?.[0]
    expect(suggestion).toMatchObject({
      id: 'proposal-uuid-1',
      title: 'Follow up with vendor',
      description: 'Send pricing proposal and schedule next call',
      assignee_member_id: 'member-uuid-1',
      reasoning: 'Explicit commitment made in meeting',
      trigger_quote: "I'll follow up with the vendor this Friday",
      open_questions: [],
    })
  })

  it('verbose rows carry spoken_by: the voice that said the trigger quote, and whether it may be the caller (issue 11)', async () => {
    supabase = createSupabaseMock({
      tables: {
        proposed_change: { data: [PENDING_PROPOSAL], error: null },
        captures: {
          data: [
            {
              id: 'capture-uuid-1',
              user_id: USER_ID,
              transcript: "[remote_1] Where are we with the vendor?\n[local_2] I'll follow up with the vendor this Friday.",
            },
          ],
          error: null,
        },
        // The caller's own voice was not identified on this capture; remote_1 was.
        capture_participant: {
          data: [
            { capture_id: 'capture-uuid-1', speaker_label: 'remote_1', is_self: false, self_binding: 'none', external_name: 'Dana Lee', member: null },
          ],
          error: null,
        },
      },
    })
    const verbose = (await runGetSuggestions(supabase, { verbose: true })) as any
    expect(verbose.suggestions[0].spoken_by).toEqual({
      speakers: [{ label: 'local_2', channel: 'microphone', identified_as: null }],
      possibly_you: true,
    })

    // A compact page reads no transcript and carries no spoken_by.
    ;(supabase.from as ReturnType<typeof vi.fn>).mockClear()
    const compact = (await runGetSuggestions(supabase)) as any
    expect(compact.suggestions[0]).not.toHaveProperty('spoken_by')
    const tables = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0])
    expect(tables).not.toContain('captures')
  })

  it('returns success with empty list when no pending proposals exist', async () => {
    supabase = createSupabaseMock({
      tables: {
        proposed_change: { data: [], error: null },
      },
    })
    const result = await runGetSuggestions(supabase) as any

    expect(result.success).toBe(true)
    expect(result.count).toBe(0)
    expect(result.suggestions).toEqual([])
  })

  it('returns error on database failure', async () => {
    supabase = createSupabaseMock({
      tables: {
        proposed_change: { data: null, error: { message: 'permission denied' } },
      },
    })
    const result = await runGetSuggestions(supabase) as any

    expect(result.success).toBe(false)
    expect(result.error).toBe('permission denied')
  })

  it('accepts optional capture_id to scope results and skips the queue roll-up', async () => {
    const result = await runGetSuggestions(supabase, { capture_id: 'capture-uuid-1' }) as any

    // Verify we queried proposed_change (capture_id scoping is applied on the chain)
    expect(supabase.from).toHaveBeenCalledWith('proposed_change')
    // Scoped to one capture — the per-capture roll-up would be redundant.
    expect(result.pending_by_capture).toBeUndefined()
  })

  it('includes a pending_by_capture roll-up when unscoped', async () => {
    const result = await runGetSuggestions(supabase) as any

    expect(result.pending_by_capture).toEqual([
      { capture_id: 'capture-uuid-1', capture_title: 'Vendor Sync Meeting', pending_count: 1 },
    ])
  })
})

// ─── GEN-74: pagination & payload size ────────────────────────────────────────

describe('get_action_suggestions pagination (GEN-74)', () => {
  /**
   * The stock createSupabaseMock returns the same rows for every chain and
   * ignores .range()/.limit(), so it can't exercise pagination. This handler
   * emulates the real builder for the proposed_change table: .range(s, e)
   * slices the row set and resolves with an exact count; .limit(n) (the slim
   * roll-up query) slices from the top without a count.
   */
  function pagedProposedChangeHandler(rows: Record<string, unknown>[]) {
    return () => {
      let rangeArgs: [number, number] | null = null
      let limitArg: number | null = null
      const chain: Record<string, unknown> = {}
      const proxy: Record<string, unknown> = new Proxy(chain, {
        get(target, prop: string) {
          if (prop === 'then') {
            return (resolve: (r: unknown) => unknown) => {
              if (rangeArgs) {
                const [start, end] = rangeArgs
                return Promise.resolve({
                  data: rows.slice(start, end + 1),
                  error: null,
                  count: rows.length,
                }).then(resolve)
              }
              const n = limitArg ?? rows.length
              return Promise.resolve({ data: rows.slice(0, n), error: null }).then(resolve)
            }
          }
          if (prop === 'range') {
            return (start: number, end: number) => {
              rangeArgs = [start, end]
              return proxy
            }
          }
          if (prop === 'limit') {
            return (n: number) => {
              limitArg = n
              return proxy
            }
          }
          if (prop in target) return target[prop]
          return () => proxy
        },
      })
      return proxy
    }
  }

  /** 60 pending proposals across 3 captures, with realistic heavy prose fields. */
  const LARGE_QUEUE = Array.from({ length: 60 }, (_, i) => {
    const captureIdx = i % 3
    return {
      ...PENDING_PROPOSAL,
      id: `proposal-uuid-${i}`,
      capture_id: `capture-uuid-${captureIdx}`,
      capture: { id: `capture-uuid-${captureIdx}`, title: `Sync Meeting ${captureIdx}` },
      display_text: `Suggestion ${i}: follow up on workstream item discussed in meeting ${captureIdx}`,
      description: 'A detailed multi-sentence description of the proposed change with context. '.repeat(5),
      reasoning: 'Extended reasoning about why the agent proposed this change, citing meeting context. '.repeat(5),
      trigger_quote: 'A long verbatim quote lifted from the meeting transcript that triggered this proposal. '.repeat(3),
      open_questions: ['Who owns this?', 'What is the deadline?', 'Is budget approved?'],
    }
  })

  function makeLargeQueueSupabase() {
    return createSupabaseMock({ tableHandler: pagedProposedChangeHandler(LARGE_QUEUE) })
  }

  it('returns a bounded first page with total and has_more for a large queue', async () => {
    const result = await runGetSuggestions(makeLargeQueueSupabase()) as any

    expect(result.success).toBe(true)
    expect(result.count).toBe(20) // default page size
    expect(result.suggestions).toHaveLength(20)
    expect(result.total).toBe(60)
    expect(result.offset).toBe(0)
    expect(result.has_more).toBe(true)
  })

  it('keeps the default response payload small even with a large queue', async () => {
    const result = await runGetSuggestions(makeLargeQueueSupabase()) as any

    // The pre-fix behavior returned 50 full rows (~90KB in the live audit).
    // The compact default page must stay an order of magnitude below that.
    const payloadBytes = JSON.stringify(result).length
    expect(payloadBytes).toBeLessThan(20_000)
  })

  it('pages through the queue with offset', async () => {
    const result = await runGetSuggestions(makeLargeQueueSupabase(), { offset: 40 }) as any

    expect(result.success).toBe(true)
    expect(result.offset).toBe(40)
    expect(result.count).toBe(20)
    expect(result.suggestions[0].id).toBe('proposal-uuid-40')
    expect(result.has_more).toBe(false) // 40 + 20 = 60 = total
  })

  it('caps the page size at 25 when verbose', async () => {
    const result = await runGetSuggestions(makeLargeQueueSupabase(), { verbose: true, limit: 100 }) as any

    expect(result.success).toBe(true)
    expect(result.count).toBe(25)
    expect(result.has_more).toBe(true)
    // Verbose rows retain the full provenance fields.
    expect(result.suggestions[0].reasoning).toContain('Extended reasoning')
  })

  it('summarizes the whole queue per capture, not just the current page', async () => {
    const result = await runGetSuggestions(makeLargeQueueSupabase()) as any

    expect(result.pending_by_capture).toHaveLength(3)
    for (const entry of result.pending_by_capture) {
      expect(entry.pending_count).toBe(20)
      expect(entry.capture_title).toMatch(/^Sync Meeting \d$/)
    }
  })
})

describe('dismiss_proposal', () => {
  it('updates proposed_change status to dismissed', async () => {
    const dismissedRow = { id: 'proposal-uuid-1', display_text: 'Liam to follow up with vendor by Friday' }
    const supabase = createSupabaseMock({
      tables: {
        proposed_change: { data: dismissedRow, error: null },
      },
    })

    const tools = createActionTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.dismiss_proposal.execute!({ proposal_id: 'proposal-uuid-1' }, EXEC_OPTS) as any

    expect(result.success).toBe(true)
    expect(result.message).toContain('Liam to follow up with vendor by Friday')
    expect(supabase.from).toHaveBeenCalledWith('proposed_change')
  })

  it('returns error when proposal not found in workspace', async () => {
    const supabase = createSupabaseMock({
      tables: {
        proposed_change: { data: null, error: null },
      },
    })

    const tools = createActionTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.dismiss_proposal.execute!({ proposal_id: 'nonexistent-uuid' }, EXEC_OPTS) as any

    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('returns error on database failure', async () => {
    const supabase = createSupabaseMock({
      tables: {
        proposed_change: { data: null, error: { message: 'connection timeout' } },
      },
    })

    const tools = createActionTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.dismiss_proposal.execute!({ proposal_id: 'proposal-uuid-1' }, EXEC_OPTS) as any

    expect(result.success).toBe(false)
    expect(result.error).toBe('connection timeout')
  })
})

// ─── accept_proposal ──────────────────────────────────────────────────────────

/** Full ProposedChange row as stored in the DB (status=pending). */
const FULL_PENDING_PROPOSAL = {
  id: 'proposal-uuid-1',
  workspace_id: WORKSPACE_ID,
  capture_id: 'capture-uuid-1',
  change_type: 'create',
  entity_type: 'action',
  entity_id: null,
  display_text: 'Liam to follow up with vendor by Friday',
  title: 'Follow up with vendor',
  description: 'Send pricing proposal and schedule next call',
  priority: 'high',
  due_date: '2026-05-30',
  status_from: null,
  status_to: null,
  assignee_name: 'Liam',
  assignee_member_id: 'member-uuid-1',
  assignee_contact_id: null,
  team_id: null,
  project_id: null,
  labels: null,
  email_to_name: null,
  email_to_address: null,
  email_subject: null,
  email_context: null,
  extra: null,
  anchor_text: null,
  sort_order: 0,
  confidence: 0.9,
  trigger_quote: "I'll follow up with the vendor this Friday",
  reasoning: 'Explicit commitment made in meeting',
  stakes: null,
  open_questions: [],
  status: 'pending',
  applied_at: null,
  applied_by: null,
  result_entity_id: null,
  error_message: null,
  created_at: '2026-05-26T10:00:00Z',
  updated_at: '2026-05-26T10:00:00Z',
}

const MEMBER_ROW = { id: 'member-uuid-1' }
const ACTION_ROW = { id: 'action-uuid-1', identifier: 'GEN-42', title: 'Follow up with vendor' }

describe('accept_proposal', () => {
  beforeEach(() => {
    mockApplyChange.mockReset()
  })

  it('refuses an approval card (A5): only the person approves a held call, on its card', async () => {
    const supabase = createSupabaseMock({
      tables: {
        attention_item: { data: [{ id: 'approval-card-1' }], error: null },
        proposed_change: { data: FULL_PENDING_PROPOSAL, error: null },
      },
    })
    const tools = createActionTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.accept_proposal.execute!({ proposal_id: 'approval-card-1' }, EXEC_OPTS) as any
    expect(result).toMatchObject({ success: false, code: 'APPROVAL_PERSON_ONLY' })
    expect(mockApplyChange).not.toHaveBeenCalled()
  })

  it('refuses an mcp_call proposal (a connected app\'s tool): only the person applies it, on its card or in the capture', async () => {
    const supabase = createSupabaseMock({
      tables: {
        proposed_change: {
          data: { ...FULL_PENDING_PROPOSAL, change_type: 'mcp_call', entity_type: 'external', mcp_tool_name: 'createJiraIssue' },
          error: null,
        },
        member: { data: MEMBER_ROW, error: null },
      },
    })
    const tools = createActionTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.accept_proposal.execute!({ proposal_id: 'proposal-uuid-1' }, EXEC_OPTS) as any
    expect(result).toMatchObject({ success: false, code: 'PROPOSAL_PERSON_ONLY', error: expect.stringMatching(/only the person can accept it/) })
    expect(mockApplyChange).not.toHaveBeenCalled()
  })

  it('happy path: calls applyChange, marks proposal applied, returns identifier', async () => {
    mockApplyChange.mockResolvedValueOnce({ success: true, entity_id: 'action-uuid-1' })

    const supabase = createSupabaseMock({
      tables: {
        proposed_change: { data: FULL_PENDING_PROPOSAL, error: null },
        member: { data: MEMBER_ROW, error: null },
        actions: { data: ACTION_ROW, error: null },
      },
    })

    const tools = createActionTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.accept_proposal.execute!({ proposal_id: 'proposal-uuid-1' }, EXEC_OPTS) as any

    expect(result.success).toBe(true)
    expect(result.identifier).toBe('GEN-42')
    expect(result.entity_type).toBe('action')
    expect(result.entity_id).toBe('action-uuid-1')
    expect(result.message).toContain('GEN-42')

    // Verify applyChange was called with the right arguments
    expect(mockApplyChange).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ id: 'proposal-uuid-1', status: 'pending' }),
      WORKSPACE_ID,
      MEMBER_ROW.id,
      USER_ID,
    )

    // Verify the proposal row was updated to 'applied'
    expect(supabase.from).toHaveBeenCalledWith('proposed_change')
  })

  it('works for non-action entity types without identifier lookup', async () => {
    const decisionProposal = {
      ...FULL_PENDING_PROPOSAL,
      entity_type: 'decision',
      id: 'proposal-uuid-2',
    }
    mockApplyChange.mockResolvedValueOnce({ success: true, entity_id: 'decision-uuid-1' })

    const supabase = createSupabaseMock({
      tables: {
        proposed_change: { data: decisionProposal, error: null },
        member: { data: MEMBER_ROW, error: null },
      },
    })

    const tools = createActionTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.accept_proposal.execute!({ proposal_id: 'proposal-uuid-2' }, EXEC_OPTS) as any

    expect(result.success).toBe(true)
    expect(result.entity_type).toBe('decision')
    expect(result.entity_id).toBe('decision-uuid-1')
    // No identifier for non-action entity types
    expect(result.identifier).toBeUndefined()
    // We should NOT have queried the actions table for decisions
    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0])
    expect(fromCalls).not.toContain('actions')
  })

  it('returns error when proposal not found', async () => {
    const supabase = createSupabaseMock({
      tables: {
        proposed_change: { data: null, error: null },
      },
    })

    const tools = createActionTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.accept_proposal.execute!({ proposal_id: 'nonexistent-uuid' }, EXEC_OPTS) as any

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/i)
    expect(mockApplyChange).not.toHaveBeenCalled()
  })

  it('returns error when proposal is already applied or dismissed', async () => {
    const alreadyApplied = { ...FULL_PENDING_PROPOSAL, status: 'applied' }
    const supabase = createSupabaseMock({
      tables: {
        proposed_change: { data: alreadyApplied, error: null },
      },
    })

    const tools = createActionTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.accept_proposal.execute!({ proposal_id: 'proposal-uuid-1' }, EXEC_OPTS) as any

    expect(result.success).toBe(false)
    expect(result.error).toContain('applied')
    expect(mockApplyChange).not.toHaveBeenCalled()
  })

  it('returns error when user is not a workspace member', async () => {
    const supabase = createSupabaseMock({
      tables: {
        proposed_change: { data: FULL_PENDING_PROPOSAL, error: null },
        member: { data: null, error: null },
      },
    })

    const tools = createActionTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.accept_proposal.execute!({ proposal_id: 'proposal-uuid-1' }, EXEC_OPTS) as any

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/member/i)
    expect(mockApplyChange).not.toHaveBeenCalled()
  })

  it('returns error on initial DB fetch failure', async () => {
    const supabase = createSupabaseMock({
      tables: {
        proposed_change: { data: null, error: { message: 'connection reset' } },
      },
    })

    const tools = createActionTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.accept_proposal.execute!({ proposal_id: 'proposal-uuid-1' }, EXEC_OPTS) as any

    expect(result.success).toBe(false)
    expect(result.error).toBe('connection reset')
    expect(mockApplyChange).not.toHaveBeenCalled()
  })

  it('surfaces applyChange failure and forwards error code', async () => {
    mockApplyChange.mockResolvedValueOnce({
      success: false,
      error: 'MCP server disconnected',
      code: 'MCP_SERVER_DISCONNECTED',
    })

    const supabase = createSupabaseMock({
      tables: {
        proposed_change: { data: FULL_PENDING_PROPOSAL, error: null },
        member: { data: MEMBER_ROW, error: null },
      },
    })

    const tools = createActionTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.accept_proposal.execute!({ proposal_id: 'proposal-uuid-1' }, EXEC_OPTS) as any

    expect(result.success).toBe(false)
    expect(result.error).toBe('MCP server disconnected')
    expect(result.code).toBe('MCP_SERVER_DISCONNECTED')
  })
})

// ─── accept_proposal: status/target overrides + batch (2026-07-01 fixes) ─────
//
// Live defects: (1) accepted create-proposals were parked in the team's first
// unstarted state (Todo) with no way to choose otherwise — in workspaces with
// status-change flows on Todo, every accept sat one touch from firing an
// automation; (2) update proposals staged with entity_id=null had no way to be
// pointed at their real target; (3) triaging a 25-proposal queue took 25 calls.

describe('accept_proposal — overrides and batch', () => {
  beforeEach(() => {
    mockApplyChange.mockReset()
  })

  function makeAcceptSupabase(proposal: Record<string, unknown> = FULL_PENDING_PROPOSAL) {
    return createSupabaseMock({
      tables: {
        proposed_change: { data: proposal, error: null },
        member: { data: MEMBER_ROW, error: null },
        actions: { data: ACTION_ROW, error: null },
      },
    })
  }

  it('forwards a status override to the apply engine as status_to', async () => {
    mockApplyChange.mockResolvedValueOnce({ success: true, entity_id: 'action-uuid-1' })
    const supabase = makeAcceptSupabase()

    const tools = createActionTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.accept_proposal.execute!(
      { proposal_id: 'proposal-uuid-1', status: 'In Progress' },
      EXEC_OPTS,
    ) as any

    expect(result.success).toBe(true)
    expect(mockApplyChange).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ id: 'proposal-uuid-1', status_to: 'In Progress' }),
      WORKSPACE_ID,
      MEMBER_ROW.id,
      USER_ID,
    )
  })

  it('forwards target_action_id as the entity_id for an unresolved update proposal', async () => {
    mockApplyChange.mockResolvedValueOnce({ success: true, entity_id: 'action-uuid-9' })
    const updateProposal = {
      ...FULL_PENDING_PROPOSAL,
      change_type: 'update',
      entity_id: null,
    }
    const supabase = makeAcceptSupabase(updateProposal)

    const tools = createActionTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.accept_proposal.execute!(
      { proposal_id: 'proposal-uuid-1', target_action_id: 'action-uuid-9' },
      EXEC_OPTS,
    ) as any

    expect(result.success).toBe(true)
    expect(mockApplyChange).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ change_type: 'update', entity_id: 'action-uuid-9' }),
      WORKSPACE_ID,
      MEMBER_ROW.id,
      USER_ID,
    )
  })

  it('rejects target_action_id when several proposals are passed', async () => {
    const supabase = makeAcceptSupabase()
    const tools = createActionTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.accept_proposal.execute!(
      { proposal_ids: ['p-1', 'p-2'], target_action_id: 'action-uuid-9' },
      EXEC_OPTS,
    ) as any

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/single proposal/i)
    expect(mockApplyChange).not.toHaveBeenCalled()
  })

  it('accepts a batch and reports per-proposal results', async () => {
    mockApplyChange.mockResolvedValue({ success: true, entity_id: 'action-uuid-1' })
    const supabase = makeAcceptSupabase()

    const tools = createActionTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.accept_proposal.execute!(
      { proposal_ids: ['proposal-uuid-1', 'proposal-uuid-2'] },
      EXEC_OPTS,
    ) as any

    expect(result.success).toBe(true)
    expect(result.accepted_count).toBe(2)
    expect(result.failed_count).toBe(0)
    expect(result.results).toHaveLength(2)
    expect(result.results[0]).toMatchObject({ proposal_id: 'proposal-uuid-1', success: true })
    expect(mockApplyChange).toHaveBeenCalledTimes(2)
  })

  it('returns an error when neither proposal_id nor proposal_ids is given', async () => {
    const supabase = makeAcceptSupabase()
    const tools = createActionTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.accept_proposal.execute!({}, EXEC_OPTS) as any

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/proposal_id/)
    expect(mockApplyChange).not.toHaveBeenCalled()
  })
})

// ─── dismiss_proposal: reason + batch ─────────────────────────────────────────

/**
 * Recording store: select chains resolve to `rows`, update chains record their
 * payload + eq filters. Each from() call gets a fresh chain, so the initial
 * fetch and the per-row updates don't bleed into each other.
 */
function makeRecordingProposalStore(rows: Array<Record<string, unknown>>) {
  const updates: Array<{ payload: Record<string, unknown>; eqs: Record<string, unknown> }> = []
  const from = vi.fn(() => {
    let op: 'select' | 'update' = 'select'
    let payload: Record<string, unknown> | null = null
    const eqs: Record<string, unknown> = {}
    const chain: Record<string, unknown> = {}
    const proxy: Record<string, unknown> = new Proxy(chain, {
      get(_t, prop: string) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown) => {
            if (op === 'update') {
              updates.push({ payload: payload!, eqs: { ...eqs } })
              return Promise.resolve({ error: null }).then(resolve)
            }
            return Promise.resolve({ data: rows, error: null }).then(resolve)
          }
        }
        if (prop === 'update') {
          return (p: Record<string, unknown>) => {
            op = 'update'
            payload = p
            return proxy
          }
        }
        if (prop === 'eq') {
          return (col: string, val: unknown) => {
            eqs[col] = val
            return proxy
          }
        }
        return () => proxy
      },
    })
    return proxy
  })
  return { supabase: { from }, updates }
}

describe('dismiss_proposal — reason + batch', () => {
  it('persists the reason in extra.dismiss_reason without clobbering reasoning', async () => {
    const { supabase, updates } = makeRecordingProposalStore([
      { id: 'p-1', display_text: 'Stale suggestion', extra: { assignee_ai_member_id: 'agent-1' } },
    ])

    const tools = createActionTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.dismiss_proposal.execute!(
      { proposal_id: 'p-1', reason: 'Task was cancelled in the meeting' },
      EXEC_OPTS,
    ) as any

    expect(result.success).toBe(true)
    expect(updates).toHaveLength(1)
    expect(updates[0].payload.status).toBe('dismissed')
    // Reason merges into extra, preserving what was already there…
    expect(updates[0].payload.extra).toMatchObject({
      assignee_ai_member_id: 'agent-1',
      dismiss_reason: 'Task was cancelled in the meeting',
    })
    // …and never overwrites the AI's staging rationale.
    expect(updates[0].payload).not.toHaveProperty('reasoning')
  })

  it('dismisses a batch, reporting counts and ids that were not found', async () => {
    const { supabase, updates } = makeRecordingProposalStore([
      { id: 'p-1', display_text: 'One', extra: null },
      { id: 'p-2', display_text: 'Two', extra: null },
    ])

    const tools = createActionTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.dismiss_proposal.execute!(
      { proposal_ids: ['p-1', 'p-2', 'p-gone'], reason: 'Scope changed' },
      EXEC_OPTS,
    ) as any

    expect(result.success).toBe(true)
    expect(result.dismissed_count).toBe(2)
    expect(result.not_found).toEqual(['p-gone'])
    expect(updates).toHaveLength(2)
    for (const u of updates) {
      expect(u.payload.status).toBe('dismissed')
      expect((u.payload.extra as Record<string, unknown>).dismiss_reason).toBe('Scope changed')
    }
  })

  it('leaves extra untouched when no reason is given', async () => {
    const { supabase, updates } = makeRecordingProposalStore([
      { id: 'p-1', display_text: 'One', extra: { foo: 'bar' } },
    ])

    const tools = createActionTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.dismiss_proposal.execute!({ proposal_id: 'p-1' }, EXEC_OPTS) as any

    expect(result.success).toBe(true)
    expect(updates[0].payload).not.toHaveProperty('extra')
  })

  it('returns an error when neither proposal_id nor proposal_ids is given', async () => {
    const { supabase } = makeRecordingProposalStore([])
    const tools = createActionTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.dismiss_proposal.execute!({}, EXEC_OPTS) as any

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/proposal_id/)
  })
})
