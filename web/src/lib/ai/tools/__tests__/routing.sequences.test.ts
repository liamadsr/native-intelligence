/**
 * Workspace routing for the sequence tools (src/lib/ai/tools/sequences.ts).
 *
 * `create_sequence` is a ROOT create: with no `workspace_id` it lands in the
 * session workspace, an explicit foreign id routes there after a membership
 * check, and policy 'explicit' with several workspaces and no id refuses
 * rather than guessing. `update_sequence`, `enroll_contacts_in_sequence` and
 * `remove_from_sequence` are converted MUTATES: a sequence_id that lives in
 * another workspace the user belongs to is edited THERE — and for
 * `enroll_contacts_in_sequence`, `enrollContacts` itself is what re-scopes the
 * contact lookup, so passing it the resolved workspace is what makes "contacts
 * must be in the same workspace" true.
 *
 * `enrollContacts` and `updateSequenceStructure` are mocked (this file tests
 * ONLY which `workspaceId` reaches them, not their own business rules — those
 * are covered by sequences.test.ts and mutations' own tests). Everything else
 * runs on a small in-memory Supabase double (same shape as
 * actions.workspace-routing.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  enrollContacts: vi.fn(),
  updateSequenceStructure: vi.fn(),
  resumePastDueEnrollments: vi.fn(),
}))
vi.mock('@/lib/sequences/mutations', async () => {
  const actual = await vi.importActual<typeof import('@/lib/sequences/mutations')>(
    '@/lib/sequences/mutations',
  )
  return {
    ...actual,
    enrollContacts: hoisted.enrollContacts,
    updateSequenceStructure: hoisted.updateSequenceStructure,
    resumePastDueEnrollments: hoisted.resumePastDueEnrollments,
  }
})

const { createSequenceTools } = await import('../sequences')

const USER_ID = 'user-1'
const WS_ACTIVE = 'ws-1'
const WS_OTHER = 'ws-2'
const WS_THIRD = 'ws-3'

const WORKSPACES = [
  { id: WS_ACTIVE, name: 'Native Intelligence Marketing' },
  { id: WS_OTHER, name: 'Engineering' },
  { id: WS_THIRD, name: 'Personal' },
]

type Row = Record<string, unknown>
type LogEntry = { table: string; col?: string; val?: unknown }

function memberRows(memberOf: string[]): Row[] {
  return memberOf.map((id) => ({
    id: `member-${id}`,
    user_id: USER_ID,
    workspace_id: id,
    workspace: WORKSPACES.find((w) => w.id === id) ?? { id, name: id },
  }))
}

function tableChain(table: string, rows: Row[], log: LogEntry[]) {
  const preds: Array<(r: Row) => boolean> = []
  let mode: 'select' | 'insert' | 'update' = 'select'
  let patch: Row = {}
  let insertRows: Row[] = []

  const chain: Record<string, unknown> = {}
  const pass = () => chain
  chain.select = pass
  chain.order = pass
  chain.eq = (col: string, val: unknown) => {
    log.push({ table, col, val })
    preds.push((r) => r[col] === val)
    return chain
  }
  chain.insert = (payload: Row | Row[]) => {
    mode = 'insert'
    const arr = Array.isArray(payload) ? payload : [payload]
    insertRows = arr.map((p, i) => ({ id: `${table}-${rows.length + i + 1}`, ...p }))
    return chain
  }
  chain.update = (payload: Row) => {
    mode = 'update'
    patch = payload
    return chain
  }

  const run = (): Row[] => {
    if (mode === 'insert') {
      rows.push(...insertRows)
      return insertRows
    }
    const matched = rows.filter((r) => preds.every((p) => p(r)))
    if (mode === 'update') for (const r of matched) Object.assign(r, patch)
    return matched
  }

  chain.single = async () => {
    const matched = run()
    return matched.length === 1 ? { data: matched[0], error: null } : { data: null, error: { message: 'no rows' } }
  }
  chain.maybeSingle = async () => ({ data: run()[0] ?? null, error: null })
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: run(), error: null }).then(resolve)
  return chain
}

function makeSupabase(opts: { sequences?: Row[]; enrollments?: Row[]; memberOf: string[] }) {
  const sequences = opts.sequences ?? []
  const sequenceSteps: Row[] = []
  const enrollments = opts.enrollments ?? []
  const members = memberRows(opts.memberOf)
  const log: LogEntry[] = []
  const from = (table: string) => {
    if (table === 'sequence') return tableChain('sequence', sequences, log)
    if (table === 'sequence_step') return tableChain('sequence_step', sequenceSteps, log)
    if (table === 'sequence_enrollment') return tableChain('sequence_enrollment', enrollments, log)
    if (table === 'member') return tableChain('member', members, log)
    return tableChain(table, [], log)
  }
  // contact_visible_to: every contact is visible to the caller here.
  const rpc = vi.fn(async () => ({ data: true, error: null }))
  return { supabase: { from, rpc } as never, sequences, enrollments, log }
}

const VALID_STEPS = [{ step_order: 1, subject: 'Hi', body: 'Hello there', delay_days: 0 }]

const run = (t: { execute?: unknown }, args: Record<string, unknown>) =>
  (t as { execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(args, {} as never)

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.updateSequenceStructure.mockResolvedValue({ ok: true })
  hoisted.enrollContacts.mockResolvedValue({ ok: true, enrolled: [], skipped: [] })
})

describe('create_sequence — workspace routing', () => {
  it('(a) explicit foreign workspace_id while a member — insert carries it', async () => {
    const { supabase, sequences } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER] })
    const tools = createSequenceTools(USER_ID, supabase, WS_ACTIVE)
    const res = await run(tools.create_sequence, {
      name: 'Investor outreach',
      steps: VALID_STEPS,
      workspace_id: WS_OTHER,
    })

    expect(res).toMatchObject({ success: true, workspace: { id: WS_OTHER, name: 'Engineering' } })
    expect(sequences).toHaveLength(1)
    expect(sequences[0].workspace_id).toBe(WS_OTHER)
  })

  it('(b) explicit non-member workspace_id — "Workspace not found", no insert', async () => {
    const { supabase, sequences } = makeSupabase({ memberOf: [WS_ACTIVE] })
    const tools = createSequenceTools(USER_ID, supabase, WS_ACTIVE)
    const res = await run(tools.create_sequence, {
      name: 'Investor outreach',
      steps: VALID_STEPS,
      workspace_id: WS_OTHER,
    })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(sequences).toHaveLength(0)
  })

  it("(c) policy 'explicit', 2+ workspaces, no id — needs_workspace, no insert", async () => {
    const { supabase, sequences } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER, WS_THIRD] })
    const tools = createSequenceTools(USER_ID, supabase, WS_ACTIVE, false, 'explicit')
    const res = await run(tools.create_sequence, { name: 'Investor outreach', steps: VALID_STEPS })

    expect(res).toMatchObject({ success: false, error_type: 'needs_workspace' })
    expect(sequences).toHaveLength(0)
  })

  it("(d) policy 'session', no id — lands in the session workspace, unchanged call chain", async () => {
    const { supabase, sequences, log } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER, WS_THIRD] })
    const tools = createSequenceTools(USER_ID, supabase, WS_ACTIVE)
    const res = await run(tools.create_sequence, { name: 'Investor outreach', steps: VALID_STEPS })

    expect(res).toMatchObject({ success: true, workspace: { id: WS_ACTIVE, name: null } })
    expect(sequences[0].workspace_id).toBe(WS_ACTIVE)
    expect(log.some((e) => e.table === 'member')).toBe(false)
  })

  it('(e) strictWorkspace + explicit foreign workspace_id — not found, no member probe', async () => {
    const { supabase, sequences, log } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER] })
    const tools = createSequenceTools(USER_ID, supabase, WS_ACTIVE, true)
    const res = await run(tools.create_sequence, {
      name: 'Investor outreach',
      steps: VALID_STEPS,
      workspace_id: WS_OTHER,
    })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(sequences).toHaveLength(0)
    expect(log.some((e) => e.table === 'member')).toBe(false)
  })
})

describe('update_sequence — workspace routing', () => {
  const SEQUENCE_IN_OTHER = {
    id: 'seq-1',
    workspace_id: WS_OTHER,
    name: 'Old name',
    timezone: 'America/Los_Angeles',
    delay_unit: 'business',
    send_window: { days: [1, 2, 3, 4, 5], start_hour: 9, end_hour: 16 },
    status: 'draft',
  }

  it('foreign-but-member sequence_id — routed to its OWN workspace', async () => {
    const { supabase } = makeSupabase({
      sequences: [{ ...SEQUENCE_IN_OTHER }],
      memberOf: [WS_ACTIVE, WS_OTHER],
    })
    const tools = createSequenceTools(USER_ID, supabase, WS_ACTIVE)
    const res = await run(tools.update_sequence, { sequence_id: 'seq-1', name: 'Renamed remotely' })

    expect(res).toMatchObject({ success: true })
    expect(hoisted.updateSequenceStructure).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ workspaceId: WS_OTHER }),
    )
  })

  it('is not-found under strictWorkspace, even though the user is a member elsewhere', async () => {
    const { supabase } = makeSupabase({
      sequences: [{ ...SEQUENCE_IN_OTHER }],
      memberOf: [WS_ACTIVE, WS_OTHER],
    })
    const tools = createSequenceTools(USER_ID, supabase, WS_ACTIVE, true)
    const res = await run(tools.update_sequence, { sequence_id: 'seq-1', name: 'Should not land' })

    expect(res).toEqual({ success: false, error: 'Sequence not found' })
    expect(hoisted.updateSequenceStructure).not.toHaveBeenCalled()
  })
})

describe('enroll_contacts_in_sequence — workspace routing', () => {
  const SEQUENCE_IN_OTHER = { id: 'seq-1', workspace_id: WS_OTHER, name: 'Q4 Outbound' }

  it('foreign-but-member sequence_id — enrollContacts is called with THAT workspace, so contacts must live there too', async () => {
    const { supabase } = makeSupabase({
      sequences: [{ ...SEQUENCE_IN_OTHER }],
      memberOf: [WS_ACTIVE, WS_OTHER],
    })
    const tools = createSequenceTools(USER_ID, supabase, WS_ACTIVE)
    const res = await run(tools.enroll_contacts_in_sequence, {
      sequence_id: 'seq-1',
      contact_ids: ['c-1'],
    })

    expect(res).toMatchObject({ success: true, sequence_name: 'Q4 Outbound' })
    expect(hoisted.enrollContacts).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ workspaceId: WS_OTHER, sequenceId: 'seq-1', contactIds: ['c-1'] }),
    )
  })

  it('is not-found under strictWorkspace, and enrollContacts is never called', async () => {
    const { supabase } = makeSupabase({
      sequences: [{ ...SEQUENCE_IN_OTHER }],
      memberOf: [WS_ACTIVE, WS_OTHER],
    })
    const tools = createSequenceTools(USER_ID, supabase, WS_ACTIVE, true)
    const res = await run(tools.enroll_contacts_in_sequence, {
      sequence_id: 'seq-1',
      contact_ids: ['c-1'],
    })

    expect(res).toEqual({ success: false, error: 'Sequence not found' })
    expect(hoisted.enrollContacts).not.toHaveBeenCalled()
  })
})

describe('remove_from_sequence — workspace routing', () => {
  const SEQUENCE_IN_OTHER = { id: 'seq-1', workspace_id: WS_OTHER }
  const ENROLLMENT = {
    id: 'enr-1',
    sequence_id: 'seq-1',
    workspace_id: WS_OTHER,
    status: 'active',
    exit_reason: null,
    contact_email: 'a@example.test',
  }

  it('foreign-but-member sequence_id — the enrollment is found and exited in its OWN workspace', async () => {
    const { supabase, enrollments } = makeSupabase({
      sequences: [{ ...SEQUENCE_IN_OTHER }],
      enrollments: [{ ...ENROLLMENT }],
      memberOf: [WS_ACTIVE, WS_OTHER],
    })
    const tools = createSequenceTools(USER_ID, supabase, WS_ACTIVE)
    const res = await run(tools.remove_from_sequence, { sequence_id: 'seq-1', enrollment_id: 'enr-1' })

    expect(res).toMatchObject({ success: true, removed: true })
    expect(enrollments.find((e) => e.id === 'enr-1')!.status).toBe('exited')
  })

  it('is "Enrollment not found" under strictWorkspace, and nothing is exited', async () => {
    const { supabase, enrollments } = makeSupabase({
      sequences: [{ ...SEQUENCE_IN_OTHER }],
      enrollments: [{ ...ENROLLMENT }],
      memberOf: [WS_ACTIVE, WS_OTHER],
    })
    const tools = createSequenceTools(USER_ID, supabase, WS_ACTIVE, true)
    const res = await run(tools.remove_from_sequence, { sequence_id: 'seq-1', enrollment_id: 'enr-1' })

    expect(res).toEqual({ success: false, error: 'Enrollment not found' })
    expect(enrollments.find((e) => e.id === 'enr-1')!.status).toBe('active')
  })
})
