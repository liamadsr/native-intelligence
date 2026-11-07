/**
 * Identity-resolution tests for the live-agent staging tools.
 *
 * Two live bugs (observed 2026-07-01) drive these:
 *  1. record_commitment wrote claims with raw diarization labels as subjects
 *     ("remote_2 committed to …", "Colleague committed to …") even when voice
 *     ID had mapped the speaker to a real person, and stored the same
 *     commitment twice in slightly different wording (no ingestion dedup).
 *  2. propose_change staged actions with assignee_name "Cat" but
 *     assignee_member_id null even though "Katrina Rae" is a workspace
 *     member (no nickname-aware matching).
 *
 * These tests run the real tool execute() functions against an in-memory
 * supabase stub that records inserts, with embeddings/provenance mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import type { AutoAcceptPolicy } from '@/lib/knowledge/auto-accept'

const { mockEmbed, mockAttachProvenance } = vi.hoisted(() => ({
  mockEmbed: vi.fn(async () => [0.1, 0.2, 0.3]),
  mockAttachProvenance: vi.fn(async (..._args: unknown[]) => undefined),
}))

vi.mock('@/lib/ai/embeddings', () => ({ embed: mockEmbed }))
vi.mock('@/lib/ai/claim-provenance', () => ({ attachClaimProvenance: mockAttachProvenance }))
vi.mock('@/lib/proposed-changes/apply-engine', () => ({
  updateAppliedEntity: vi.fn(),
  deleteAppliedEntity: vi.fn(),
}))
vi.mock('@/lib/mcp-client/adapter', () => ({
  namespacedToolName: (server: string, toolName: string) => `mcp__${server}__${toolName}`,
}))
vi.mock('@/lib/live-agent/nudge-channel', () => ({
  broadcastNudge: vi.fn(async () => true),
}))

import { createLiveAgentTools } from '../tools'

const USER_ID = 'user-1'
const WORKSPACE_ID = 'ws-1'
const CAPTURE_ID = 'cap-1'
const MEMBER_ME = 'mem-liam'

const POLICY: AutoAcceptPolicy = {
  enabled: false,
  claims: 0.85,
  actions: 0.8,
  decisions: 0.85,
  allow_external: false,
}

const EXEC_OPTS = { toolCallId: 'tc-1', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>

interface DbConfig {
  participants?: Row[]
  members?: Row[]
  contacts?: Row[]
  /** Candidate pool for update/assign target resolution. */
  actions?: Row[]
  /** Rows match_claims returns — non-empty simulates a near-duplicate claim. */
  claimMatches?: Row[]
  /** Existing proposed_change rows (for edit_proposal lookups). */
  proposedChanges?: Row[]
}

/**
 * Minimal supabase stub: any chain method returns the chain; awaiting resolves
 * to the table's configured rows; inserts are recorded per table and
 * insert().select().single() returns a canned created row.
 */
function makeSupabase(cfg: DbConfig) {
  const inserts: Record<string, Row[]> = { proposed_change: [], claim: [], claim_chunks: [] }
  const updates: Record<string, Row[]> = { proposed_change: [] }

  const makeTable = (data: unknown, insertReturn?: (p: Row) => Row, updateSink?: Row[]) => {
    let lastInsert: Row | null = null
    const resolved = { data, error: null, count: 0 }
    const chain: Record<string, unknown> = {}
    const proxy: Record<string, unknown> = new Proxy(chain, {
      get(_t, prop: string) {
        if (prop === 'then') {
          return (res: (v: unknown) => unknown) => Promise.resolve(resolved).then(res)
        }
        if (prop === 'insert') {
          return (payload: Row) => {
            lastInsert = payload
            return proxy
          }
        }
        if (prop === 'update') {
          return (payload: Row) => {
            updateSink?.push(payload)
            return proxy
          }
        }
        if (prop === 'single' || prop === 'maybeSingle') {
          return () => {
            if (lastInsert && insertReturn) {
              return Promise.resolve({ data: insertReturn(lastInsert), error: null })
            }
            const d = Array.isArray(data) ? (data as Row[])[0] ?? null : data
            return Promise.resolve({ data: d, error: null })
          }
        }
        return (..._args: unknown[]) => proxy
      },
    })
    return proxy
  }

  const from = vi.fn((table: string) => {
    switch (table) {
      case 'capture_participant':
        return makeTable(cfg.participants ?? [])
      case 'member':
        return makeTable(cfg.members ?? [])
      case 'contact':
        return makeTable(cfg.contacts ?? [])
      case 'actions':
        return makeTable(cfg.actions ?? [])
      case 'proposed_change':
        return makeTable(
          cfg.proposedChanges ?? [],
          (p) => {
            inserts.proposed_change.push(p)
            return { id: 'pc-1', display_text: p.display_text }
          },
          updates.proposed_change,
        )
      case 'claim':
        return makeTable([], (p) => {
          inserts.claim.push(p)
          return { id: 'claim-new' }
        })
      case 'claim_chunks':
        return makeTable([], (p) => {
          inserts.claim_chunks.push(p)
          return p
        })
      default:
        return makeTable([])
    }
  })

  // claim_chunks insert is awaited without .select().single() — record it on
  // the insert call itself via a wrapper table.
  const origFrom = from.getMockImplementation()!
  from.mockImplementation((table: string) => {
    if (table !== 'claim_chunks') return origFrom(table)
    return {
      insert: (p: Row) => {
        inserts.claim_chunks.push(p)
        return Promise.resolve({ data: null, error: null })
      },
    }
  })

  const rpc = vi.fn(async (fnName: string) => {
    if (fnName === 'match_claims') return { data: cfg.claimMatches ?? [], error: null }
    return { data: null, error: null }
  })

  return { from, rpc, _inserts: inserts, _updates: updates }
}

function makeTools(cfg: DbConfig) {
  const supabase = makeSupabase(cfg)
  const tools = createLiveAgentTools(
    USER_ID,
    supabase as never,
    WORKSPACE_ID,
    CAPTURE_ID,
    null,
    null,
    MEMBER_ME,
    'Liam Alizadeh',
    POLICY,
  )
  return { tools, supabase }
}

const JESS_MEMBER = { id: 'mem-jess', display_name: 'Katrina Rae' }
const LIAM_MEMBER = { id: MEMBER_ME, display_name: 'Liam Alizadeh' }

const JESS_VOICE_ROW = {
  speaker_label: 'remote_2',
  member_id: 'mem-jess',
  contact_id: null,
  external_name: null,
  member: { id: 'mem-jess', display_name: 'Katrina Rae' },
  contact: null,
}

beforeEach(() => {
  mockEmbed.mockClear()
  mockAttachProvenance.mockClear()
})

describe('propose_change — assignee identity resolution', () => {
  it('resolves the nickname "Cat" to member Katrina Rae', async () => {
    const { tools, supabase } = makeTools({ members: [LIAM_MEMBER, JESS_MEMBER] })
    const res = (await tools.propose_change.execute!(
      {
        change_type: 'create',
        entity_type: 'action',
        display_text: 'Cat to send the onboarding doc',
        assignee_name: 'Cat',
      } as never,
      EXEC_OPTS,
    )) as { success: boolean }

    expect(res.success).toBe(true)
    const inserted = supabase._inserts.proposed_change[0]
    expect(inserted.assignee_member_id).toBe('mem-jess')
    expect(inserted.assignee_name).toBe('Cat')
  })

  it('resolves a voice-ID-mapped speaker label to the real person', async () => {
    const { tools, supabase } = makeTools({
      participants: [JESS_VOICE_ROW],
      members: [LIAM_MEMBER, JESS_MEMBER],
    })
    await tools.propose_change.execute!(
      {
        change_type: 'create',
        entity_type: 'action',
        display_text: 'Send the onboarding doc',
        assignee_name: 'remote_2',
      } as never,
      EXEC_OPTS,
    )

    const inserted = supabase._inserts.proposed_change[0]
    expect(inserted.assignee_name).toBe('Katrina Rae')
    expect(inserted.assignee_member_id).toBe('mem-jess')
  })

  it('stages an item WITHOUT assignee when the label has no voice-ID assignment', async () => {
    const { tools, supabase } = makeTools({ members: [LIAM_MEMBER] })
    const res = (await tools.propose_change.execute!(
      {
        change_type: 'create',
        entity_type: 'action',
        display_text: 'Follow up on the vendor quote',
        assignee_name: 'remote_3',
      } as never,
      EXEC_OPTS,
    )) as { success: boolean; note?: string }

    expect(res.success).toBe(true)
    expect(res.note).toContain('unassigned speaker label')
    const inserted = supabase._inserts.proposed_change[0]
    expect(inserted.assignee_name).toBeNull()
    expect(inserted.assignee_member_id).toBeNull()
    expect(inserted.assignee_contact_id).toBeNull()
  })
})

describe('propose_change — ownership provenance (extra.assignee_resolution)', () => {
  const SELF_VOICE_ROW = {
    speaker_label: 'local_1',
    member_id: MEMBER_ME,
    contact_id: null,
    external_name: 'Liam Alizadeh',
    is_self: true,
    member: { id: MEMBER_ME, display_name: 'Liam Alizadeh' },
    contact: null,
  }

  it('resolves ownership via speaker_label — the only provenance the self gate trusts', async () => {
    const { tools, supabase } = makeTools({
      participants: [SELF_VOICE_ROW],
      members: [LIAM_MEMBER, JESS_MEMBER],
    })
    await tools.propose_change.execute!(
      {
        change_type: 'create',
        entity_type: 'action',
        display_text: 'Liam to send the deck',
        assignee_name: 'Liam Alizadeh',
        speaker_label: 'local_1',
      } as never,
      EXEC_OPTS,
    )

    const inserted = supabase._inserts.proposed_change[0]
    expect(inserted.assignee_member_id).toBe(MEMBER_ME)
    expect((inserted.extra as Record<string, unknown>).assignee_resolution).toBe('speaker_label')
    expect((inserted.extra as Record<string, unknown>).assignee_speaker_label).toBe('local_1')
  })

  it('marks a name-only resolution as name_match (never auto-applied to the user)', async () => {
    const { tools, supabase } = makeTools({ members: [LIAM_MEMBER, JESS_MEMBER] })
    await tools.propose_change.execute!(
      {
        change_type: 'create',
        entity_type: 'action',
        display_text: 'Liam to send the deck',
        assignee_name: 'Liam Alizadeh',
      } as never,
      EXEC_OPTS,
    )

    const inserted = supabase._inserts.proposed_change[0]
    expect(inserted.assignee_member_id).toBe(MEMBER_ME)
    expect((inserted.extra as Record<string, unknown>).assignee_resolution).toBe('name_match')
  })

  it('a name that IS a mapped label still counts as speaker_label provenance', async () => {
    const { tools, supabase } = makeTools({
      participants: [JESS_VOICE_ROW],
      members: [LIAM_MEMBER, JESS_MEMBER],
    })
    await tools.propose_change.execute!(
      {
        change_type: 'create',
        entity_type: 'action',
        display_text: 'Send the onboarding doc',
        assignee_name: 'remote_2',
      } as never,
      EXEC_OPTS,
    )

    const inserted = supabase._inserts.proposed_change[0]
    expect(inserted.assignee_member_id).toBe('mem-jess')
    expect((inserted.extra as Record<string, unknown>).assignee_resolution).toBe('speaker_label')
  })

  it('an UNMAPPED speaker_label falls back to the name path with name_match provenance', async () => {
    const { tools, supabase } = makeTools({ members: [LIAM_MEMBER, JESS_MEMBER] })
    await tools.propose_change.execute!(
      {
        change_type: 'create',
        entity_type: 'action',
        display_text: 'Cat to send the doc',
        assignee_name: 'Katrina Rae',
        speaker_label: 'remote_9',
      } as never,
      EXEC_OPTS,
    )

    const inserted = supabase._inserts.proposed_change[0]
    expect(inserted.assignee_member_id).toBe('mem-jess')
    expect((inserted.extra as Record<string, unknown>).assignee_resolution).toBe('name_match')
  })

  it('stages with no provenance marker when there is no assignee at all', async () => {
    const { tools, supabase } = makeTools({ members: [LIAM_MEMBER] })
    await tools.propose_change.execute!(
      {
        change_type: 'create',
        entity_type: 'action',
        display_text: 'Follow up on the vendor quote',
      } as never,
      EXEC_OPTS,
    )

    const inserted = supabase._inserts.proposed_change[0]
    expect(inserted.extra).toBeUndefined()
  })
})

describe('propose_change — D2 explicitness (extra.is_explicitly_stated)', () => {
  it('stamps is_explicitly_stated on a DECISION when the model sets it', async () => {
    const { tools, supabase } = makeTools({ members: [LIAM_MEMBER] })
    await tools.propose_change.execute!(
      {
        change_type: 'create',
        entity_type: 'decision',
        display_text: 'We decided to ship Friday',
        is_explicitly_stated: true,
      } as never,
      EXEC_OPTS,
    )
    const inserted = supabase._inserts.proposed_change[0]
    expect((inserted.extra as Record<string, unknown>).is_explicitly_stated).toBe(true)
  })

  it('stamps is_explicitly_stated:false on a MILESTONE (an inferred one)', async () => {
    const { tools, supabase } = makeTools({ members: [LIAM_MEMBER] })
    await tools.propose_change.execute!(
      {
        change_type: 'create',
        entity_type: 'milestone',
        display_text: 'Beta milestone',
        is_explicitly_stated: false,
      } as never,
      EXEC_OPTS,
    )
    const inserted = supabase._inserts.proposed_change[0]
    expect((inserted.extra as Record<string, unknown>).is_explicitly_stated).toBe(false)
  })

  it('does NOT stamp is_explicitly_stated on an ACTION (the flag governs decisions/milestones only)', async () => {
    const { tools, supabase } = makeTools({ members: [LIAM_MEMBER] })
    await tools.propose_change.execute!(
      {
        change_type: 'create',
        entity_type: 'action',
        display_text: 'Do the thing',
        is_explicitly_stated: true,
      } as never,
      EXEC_OPTS,
    )
    const inserted = supabase._inserts.proposed_change[0]
    // No assignee + action ⇒ extra is omitted entirely (the flag never leaks onto
    // an action row).
    expect(inserted.extra).toBeUndefined()
  })

  it('omits the flag when the model does not set it on a decision', async () => {
    const { tools, supabase } = makeTools({ members: [LIAM_MEMBER] })
    await tools.propose_change.execute!(
      {
        change_type: 'create',
        entity_type: 'decision',
        display_text: 'We decided to ship Friday',
      } as never,
      EXEC_OPTS,
    )
    const inserted = supabase._inserts.proposed_change[0]
    // No assignee resolution + no flag ⇒ extra omitted; the gate then treats an
    // absent flag as not-explicit (stages).
    expect(inserted.extra).toBeUndefined()
  })
})

describe('edit_proposal — provenance follows the re-resolved assignee', () => {
  // Adversarial-review critical (2026-07-08): editing a speaker_label-staged
  // proposal's assignee to "me" kept the stale 'speaker_label' marker, letting
  // the next auto-apply sweep trust a name-echoed reassignment.
  const PENDING_WITH_LABEL_PROVENANCE = {
    id: 'pc-edit',
    status: 'pending',
    entity_type: 'action',
    result_entity_id: null,
    team_id: null,
    extra: { assignee_resolution: 'speaker_label', assignee_speaker_label: 'remote_2', guardrail: { priority_lowered: true } },
  }

  const SELF_ROW = {
    speaker_label: null,
    member_id: MEMBER_ME,
    contact_id: null,
    external_name: 'Liam Alizadeh',
    is_self: true,
    member: { id: MEMBER_ME, display_name: 'Liam Alizadeh' },
    contact: null,
  }

  it('downgrades stale speaker_label provenance to name_match when the assignee is re-pointed by name', async () => {
    const { tools, supabase } = makeTools({
      participants: [SELF_ROW],
      members: [LIAM_MEMBER, JESS_MEMBER],
      proposedChanges: [PENDING_WITH_LABEL_PROVENANCE],
    })
    const res = (await tools.edit_proposal.execute!(
      { proposal_id: 'pc-edit', assignee_name: 'me' } as never,
      EXEC_OPTS,
    )) as { success: boolean }

    expect(res.success).toBe(true)
    const update = supabase._updates.proposed_change[0]
    expect(update.assignee_member_id).toBe(MEMBER_ME)
    const extra = update.extra as Record<string, unknown>
    expect(extra.assignee_resolution).toBe('name_match')
    expect(extra.assignee_speaker_label).toBeUndefined()
    // Unrelated extra content (guardrail badge) survives the rewrite.
    expect(extra.guardrail).toEqual({ priority_lowered: true })
  })

  it('keeps speaker_label provenance when the edit re-resolves through the map', async () => {
    const { tools, supabase } = makeTools({
      participants: [JESS_VOICE_ROW],
      members: [LIAM_MEMBER, JESS_MEMBER],
      proposedChanges: [{ ...PENDING_WITH_LABEL_PROVENANCE, extra: { assignee_resolution: 'name_match' } }],
    })
    await tools.edit_proposal.execute!(
      { proposal_id: 'pc-edit', assignee_name: 'remote_2' } as never,
      EXEC_OPTS,
    )

    const update = supabase._updates.proposed_change[0]
    expect(update.assignee_member_id).toBe('mem-jess')
    expect((update.extra as Record<string, unknown>).assignee_resolution).toBe('speaker_label')
  })

  it('drops the provenance markers entirely when the assignee is cleared', async () => {
    const { tools, supabase } = makeTools({
      members: [LIAM_MEMBER],
      proposedChanges: [PENDING_WITH_LABEL_PROVENANCE],
    })
    await tools.edit_proposal.execute!(
      { proposal_id: 'pc-edit', assignee_name: '' } as never,
      EXEC_OPTS,
    )

    const update = supabase._updates.proposed_change[0]
    expect(update.assignee_member_id).toBeNull()
    const extra = update.extra as Record<string, unknown>
    expect(extra.assignee_resolution).toBeUndefined()
    expect(extra.guardrail).toEqual({ priority_lowered: true })
  })
})

describe('record_commitment — self references are redirected, not filed', () => {
  it('refuses "me"/"you" and points the model at propose_change', async () => {
    const SELF_ROW = {
      speaker_label: null,
      member_id: MEMBER_ME,
      contact_id: null,
      external_name: 'Liam Alizadeh',
      is_self: true,
      member: { id: MEMBER_ME, display_name: 'Liam Alizadeh' },
      contact: null,
    }
    const { tools, supabase } = makeTools({
      participants: [SELF_ROW],
      members: [LIAM_MEMBER],
    })
    const res = (await tools.record_commitment.execute!(
      { person_name: 'me', commitment: 'send the deck' } as never,
      EXEC_OPTS,
    )) as { success: boolean; error?: string }

    expect(res.success).toBe(false)
    expect(res.error).toContain('propose_change')
    expect(supabase._inserts.claim).toHaveLength(0)
  })
})

describe('propose_change — update/assign target resolution', () => {
  const POOL_ACTION = {
    id: 'act-9',
    title: 'Update API docs',
    identifier: 'ENG-9',
    project_id: null,
    team_id: null,
    workflow_state: { category: 'started' },
  }

  it('stages an update:action with the target resolved by title match', async () => {
    const { tools, supabase } = makeTools({ actions: [POOL_ACTION] })
    const res = (await tools.propose_change.execute!(
      {
        change_type: 'update',
        entity_type: 'action',
        display_text: 'Bump the API docs task to urgent',
        title: 'Update API docs',
        priority: 'urgent',
      } as never,
      EXEC_OPTS,
    )) as { success: boolean; note?: string }

    expect(res.success).toBe(true)
    expect(res.note).toContain('ENG-9')
    const inserted = supabase._inserts.proposed_change[0]
    expect(inserted.entity_id).toBe('act-9')
  })

  it('stages with entity_id null when nothing matches (apply engine retries later)', async () => {
    const { tools, supabase } = makeTools({ actions: [] })
    const res = (await tools.propose_change.execute!(
      {
        change_type: 'update',
        entity_type: 'action',
        display_text: 'Bump the API docs task to urgent',
        title: 'Update API docs',
      } as never,
      EXEC_OPTS,
    )) as { success: boolean; note?: string }

    expect(res.success).toBe(true)
    expect(res.note).toBeUndefined()
    const inserted = supabase._inserts.proposed_change[0]
    expect(inserted.entity_id).toBeNull()
  })

  it('does not attempt target resolution for create proposals', async () => {
    // Creates are NEW work — they never resolve against existing actions.
    // (Proposal dedup was deliberately NOT done at staging time; it lives in
    // the Triage loop, which reviews with cross-capture context. So a create
    // must never query the actions table for a fuzzy match.)
    const { tools, supabase } = makeTools({ actions: [POOL_ACTION] })
    await tools.propose_change.execute!(
      {
        change_type: 'create',
        entity_type: 'action',
        display_text: 'Update the API docs',
        title: 'Update API docs',
      } as never,
      EXEC_OPTS,
    )

    const queried = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(queried).not.toContain('actions')
    // Stays a create with no target — not folded into the similarly-titled action.
    expect(supabase._inserts.proposed_change[0].change_type).toBe('create')
    expect(supabase._inserts.proposed_change[0].entity_id).toBeNull()
  })

  it('respects an explicit entity_id without re-resolving', async () => {
    const { tools, supabase } = makeTools({ actions: [POOL_ACTION] })
    await tools.propose_change.execute!(
      {
        change_type: 'update',
        entity_type: 'action',
        entity_id: 'act-explicit',
        display_text: 'Bump the API docs task to urgent',
        title: 'Update API docs',
      } as never,
      EXEC_OPTS,
    )

    const queried = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(queried).not.toContain('actions')
    expect(supabase._inserts.proposed_change[0].entity_id).toBe('act-explicit')
  })
})

describe('record_commitment — claim subjects are real people', () => {
  it('writes the claim with the voice-ID name, never the raw label', async () => {
    const { tools, supabase } = makeTools({
      participants: [JESS_VOICE_ROW],
      members: [LIAM_MEMBER, JESS_MEMBER],
    })
    const res = (await tools.record_commitment.execute!(
      { person_name: 'remote_2', commitment: 'send the Q3 deck by Friday' } as never,
      EXEC_OPTS,
    )) as { success: boolean; tracked_as?: string }

    expect(res.success).toBe(true)
    expect(res.tracked_as).toBe('Katrina Rae committed to send the Q3 deck by Friday')
    const claim = supabase._inserts.claim[0]
    expect(claim.text).toBe('Katrina Rae committed to send the Q3 deck by Friday')
    expect(claim.subject_member_id).toBe('mem-jess')
    expect(claim.scope).toBe('personal')
  })

  it('resolves nicknames in person_name ("Cat" → subject Katrina Rae)', async () => {
    const { tools, supabase } = makeTools({ members: [LIAM_MEMBER, JESS_MEMBER] })
    await tools.record_commitment.execute!(
      { person_name: 'Cat', commitment: 'review the contract' } as never,
      EXEC_OPTS,
    )
    expect(supabase._inserts.claim[0].subject_member_id).toBe('mem-jess')
  })

  it('REFUSES to write a claim attributed to an unassigned label', async () => {
    const { tools, supabase } = makeTools({ members: [LIAM_MEMBER] })
    const res = (await tools.record_commitment.execute!(
      { person_name: 'remote_2', commitment: 'send the deck' } as never,
      EXEC_OPTS,
    )) as { success: boolean; error?: string }

    expect(res.success).toBe(false)
    expect(res.error).toContain('unassigned speaker label')
    expect(supabase._inserts.claim).toHaveLength(0)
  })

  it('REFUSES generic placeholders like "Colleague"', async () => {
    const { tools, supabase } = makeTools({ members: [LIAM_MEMBER] })
    const res = (await tools.record_commitment.execute!(
      { person_name: 'Colleague', commitment: 'send the deck' } as never,
      EXEC_OPTS,
    )) as { success: boolean }

    expect(res.success).toBe(false)
    expect(supabase._inserts.claim).toHaveLength(0)
  })

  it('dedupes a near-identical commitment onto the existing claim', async () => {
    const { tools, supabase } = makeTools({
      members: [LIAM_MEMBER, JESS_MEMBER],
      claimMatches: [{ claim_id: 'claim-existing', confirmation: 'suggested', confidence: 0.8 }],
    })
    const res = (await tools.record_commitment.execute!(
      { person_name: 'Katrina Rae', commitment: 'send the Q3 deck by Friday' } as never,
      EXEC_OPTS,
    )) as { success: boolean; claim_id?: string; deduplicated?: boolean }

    expect(res.success).toBe(true)
    expect(res.deduplicated).toBe(true)
    expect(res.claim_id).toBe('claim-existing')
    // No second claim row — provenance grows on the existing one instead.
    expect(supabase._inserts.claim).toHaveLength(0)
    expect(mockAttachProvenance).toHaveBeenCalledTimes(1)
    expect(mockAttachProvenance.mock.calls[0][1]).toMatchObject({ claimId: 'claim-existing' })
  })

  it('inserts a new claim (and reuses the dedup embedding for recall) when nothing matches', async () => {
    const { tools, supabase } = makeTools({
      members: [LIAM_MEMBER, JESS_MEMBER],
      claimMatches: [],
    })
    const res = (await tools.record_commitment.execute!(
      { person_name: 'Katrina Rae', commitment: 'send the Q3 deck by Friday' } as never,
      EXEC_OPTS,
    )) as { success: boolean; claim_id?: string }

    expect(res.success).toBe(true)
    expect(res.claim_id).toBe('claim-new')
    expect(supabase._inserts.claim).toHaveLength(1)
    // One embedding call serves both dedup and the recall index.
    expect(mockEmbed).toHaveBeenCalledTimes(1)
    expect(supabase._inserts.claim_chunks).toHaveLength(1)
    expect(supabase._inserts.claim_chunks[0].claim_id).toBe('claim-new')
  })

  it('still records the claim when embedding fails (dedup skipped, no recall row)', async () => {
    mockEmbed.mockRejectedValueOnce(new Error('gateway down'))
    const { tools, supabase } = makeTools({ members: [LIAM_MEMBER, JESS_MEMBER] })
    const res = (await tools.record_commitment.execute!(
      { person_name: 'Katrina Rae', commitment: 'send the deck' } as never,
      EXEC_OPTS,
    )) as { success: boolean }

    expect(res.success).toBe(true)
    expect(supabase._inserts.claim).toHaveLength(1)
    expect(supabase._inserts.claim_chunks).toHaveLength(0)
  })
})

describe('propose_change — combo normalization + rejection (staging drift guard)', () => {
  it('stages a target-less assign:contact as create:action (the "connect with Nikhil\'s son" card)', async () => {
    // Prod, capture 3261a80c: the extractor labelled a follow-up ABOUT a person
    // as assign:contact. No entity_id, so there is nothing to re-point — it is a
    // task for the owner. The row must be written as create:action so the card
    // renders a real Accept instead of "Unsupported: assign contact".
    const { tools, supabase } = makeTools({ members: [LIAM_MEMBER] })
    const res = (await tools.propose_change.execute!(
      {
        change_type: 'assign',
        entity_type: 'contact',
        display_text: "Liam to connect with Nikhil's son about cofounder pairing",
        title: "Connect with Nikhil's son about cofounder opportunity",
        assignee_name: 'Liam Alizadeh',
      } as never,
      EXEC_OPTS,
    )) as { success: boolean; note?: string }

    expect(res.success).toBe(true)
    expect(res.note).toContain('assign:contact')
    expect(res.note).toContain('create:action')
    const inserted = supabase._inserts.proposed_change[0]
    expect(inserted.change_type).toBe('create')
    expect(inserted.entity_type).toBe('action')
    expect(inserted.entity_id).toBeNull()
    expect(inserted.assignee_member_id).toBe(MEMBER_ME)
    expect(inserted.title).toBe("Connect with Nikhil's son about cofounder opportunity")
  })

  it('leaves a resolvable assign:action alone (targeted assign has its own handler)', async () => {
    const { tools, supabase } = makeTools({
      actions: [
        { id: 'act-9', title: 'Update API docs', identifier: 'ENG-9', project_id: null, team_id: null, workflow_state: { category: 'started' } },
      ],
      members: [JESS_MEMBER],
    })
    const res = (await tools.propose_change.execute!(
      {
        change_type: 'assign',
        entity_type: 'action',
        display_text: 'Hand the API docs task to Cat',
        title: 'Update API docs',
        assignee_name: 'Katrina Rae',
      } as never,
      EXEC_OPTS,
    )) as { success: boolean; note?: string }

    expect(res.success).toBe(true)
    const inserted = supabase._inserts.proposed_change[0]
    expect(inserted.change_type).toBe('assign')
    expect(inserted.entity_type).toBe('action')
    expect(inserted.entity_id).toBe('act-9')
  })

  it('refuses a combo with no handler and tells the model how to re-propose', async () => {
    const { tools, supabase } = makeTools({})
    const res = (await tools.propose_change.execute!(
      {
        change_type: 'delete',
        entity_type: 'contact',
        entity_id: 'contact-1',
        display_text: 'Drop the old vendor contact',
      } as never,
      EXEC_OPTS,
    )) as { success: boolean; error?: string }

    expect(res.success).toBe(false)
    expect(res.error).toContain('delete:contact')
    expect(res.error).toContain('create:action')
    expect(supabase._inserts.proposed_change).toHaveLength(0)
  })

  it('refuses a TARGETED assign of a non-action entity (nothing can re-point it)', async () => {
    const { tools, supabase } = makeTools({ members: [LIAM_MEMBER] })
    const res = (await tools.propose_change.execute!(
      {
        change_type: 'assign',
        entity_type: 'contact',
        entity_id: 'contact-1',
        display_text: 'Give the Acme contact to Liam',
        assignee_name: 'Liam Alizadeh',
      } as never,
      EXEC_OPTS,
    )) as { success: boolean; error?: string }

    expect(res.success).toBe(false)
    expect(res.error).toContain('assign:contact')
    expect(supabase._inserts.proposed_change).toHaveLength(0)
  })
})
