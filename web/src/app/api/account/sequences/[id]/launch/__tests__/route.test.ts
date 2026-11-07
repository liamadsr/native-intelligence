/**
 * Tests for POST /api/account/sequences/[id]/launch — the resume guard.
 *
 * Review & launch on a PAUSED sequence restarts everyone already in it, whose
 * next_send_at went overdue while paused. The route must snap those forward
 * through the send window (resumePastDueEnrollments, the same helper the PATCH
 * status resume and the AI tool use) BEFORE arming, so the backlog never fires
 * as one burst. A draft or active sequence has no such backlog: no call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  resumePastDueEnrollments: vi.fn(),
  /** Every call, in order: a resume, or a write to a table. */
  log: [] as Array<{ kind: 'resume' } | { kind: 'update'; table: string; values: Record<string, unknown> }>,
  sequence: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))
vi.mock('@/lib/sequences/mutations', () => ({
  resumePastDueEnrollments: hoisted.resumePastDueEnrollments,
}))

const STEPS = [{ id: 'step-1', step_order: 1, subject: 'Quick idea', body: 'Hello there', delay_days: 0 }]
const ACCOUNT = { id: 'acct-1', account_email: 'me@acme.com', display_name: 'Me' }
const ENROLLMENTS = [
  // Already in flight: went overdue while paused.
  {
    id: 'enr-1',
    contact_id: 'c-1',
    contact_email: 'a@x.com',
    current_step_order: 1,
    next_send_at: '2026-01-01T17:00:00.000Z',
    overrides: null,
    thread_subject: 'Quick idea',
    provider_thread_id: 't-1',
    contact: { first_name: 'Ann', email: 'a@x.com', company: { name: 'X' } },
  },
]

function makeSupabase() {
  return {
    from: (table: string) => {
      let updating: Record<string, unknown> | null = null
      const result = () => {
        if (updating) return { data: null, error: null }
        if (table === 'sequence_step') return { data: STEPS, error: null }
        if (table === 'connected_account') return { data: [ACCOUNT], error: null }
        if (table === 'sequence_enrollment') return { data: ENROLLMENTS, error: null }
        return { data: null, error: null }
      }
      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        order: () => chain,
        limit: () => chain,
        update: (values: Record<string, unknown>) => {
          updating = values
          hoisted.log.push({ kind: 'update', table, values })
          return chain
        },
        maybeSingle: async () => ({ data: table === 'sequence' ? hoisted.sequence : null, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve),
      })
      return chain
    },
  }
}

const { POST } = await import('@/app/api/account/sequences/[id]/launch/route')

function launch(id = 'seq-1') {
  const request = buildRequest({
    url: `https://dial8.ai/api/account/sequences/${id}/launch`,
    method: 'POST',
    body: {},
  }) as unknown as NextRequest
  return POST(request, { params: Promise.resolve({ id }) })
}

function sequenceWith(status: string) {
  return {
    id: 'seq-1',
    workspace_id: 'ws-1',
    status,
    sending_account_id: null,
    delay_unit: 'business',
    timezone: 'America/Los_Angeles',
    send_window: { days: [1, 2, 3, 4, 5], start_hour: 9, end_hour: 16 },
  }
}

beforeEach(() => {
  hoisted.log.length = 0
  hoisted.requireWorkspace.mockReset()
  hoisted.requireWorkspace.mockResolvedValue({ supabase: makeSupabase(), user: { id: 'user-1' }, workspaceId: 'ws-1' })
  hoisted.resumePastDueEnrollments.mockReset()
  hoisted.resumePastDueEnrollments.mockImplementation(async () => {
    hoisted.log.push({ kind: 'resume' })
    return { error: null }
  })
})

describe('POST /api/account/sequences/[id]/launch: the resume guard', () => {
  it('on a paused sequence, reschedules the past-due enrollments before arming it', async () => {
    hoisted.sequence = sequenceWith('paused')
    const res = await launch()
    expect(res.status).toBe(200)
    expect(hoisted.resumePastDueEnrollments).toHaveBeenCalledTimes(1)
    expect(hoisted.resumePastDueEnrollments).toHaveBeenCalledWith(expect.anything(), {
      id: 'seq-1',
      delay_unit: 'business',
      timezone: 'America/Los_Angeles',
      send_window: { days: [1, 2, 3, 4, 5], start_hour: 9, end_hour: 16 },
    })
    const resumeAt = hoisted.log.findIndex((e) => e.kind === 'resume')
    const armAt = hoisted.log.findIndex((e) => e.kind === 'update' && e.table === 'sequence' && e.values.status === 'active')
    expect(resumeAt).toBeGreaterThan(-1)
    expect(armAt).toBeGreaterThan(resumeAt)
  })

  it('does not arm when the reschedule fails', async () => {
    hoisted.sequence = sequenceWith('paused')
    hoisted.resumePastDueEnrollments.mockResolvedValue({ error: 'boom' })
    const res = await launch()
    expect(res.status).toBe(500)
    expect(hoisted.log.some((e) => e.kind === 'update' && e.table === 'sequence')).toBe(false)
  })

  it.each(['draft', 'active'])('on a %s sequence, arms without a resume', async (status) => {
    hoisted.sequence = sequenceWith(status)
    const res = await launch()
    expect(res.status).toBe(200)
    expect(await readJson(res)).toMatchObject({ launched: true })
    expect(hoisted.resumePastDueEnrollments).not.toHaveBeenCalled()
    expect(hoisted.log.some((e) => e.kind === 'update' && e.table === 'sequence' && e.values.status === 'active')).toBe(true)
  })
})

describe('POST /api/account/sequences/[id]/launch: the sender name', () => {
  it('never resolves {{sender_first_name}} from the mailbox provider label', async () => {
    // connected_account.display_name is 'Gmail'/'Outlook', not a person. With no
    // member name and no mailbox address there is no sender name at all, so the
    // render check must block, as the engine would at send time.
    hoisted.sequence = sequenceWith('draft')
    const originalBody = STEPS[0].body
    const originalAccount = { ...ACCOUNT }
    STEPS[0].body = 'Hi, {{sender_first_name}} here'
    Object.assign(ACCOUNT, { account_email: null, display_name: 'Gmail' })
    try {
      const res = await launch()
      expect(res.status).toBe(400)
      expect(await readJson(res)).toMatchObject({ details: { code: 'unresolved_tokens' } })
    } finally {
      STEPS[0].body = originalBody
      Object.assign(ACCOUNT, originalAccount)
    }
  })
})
