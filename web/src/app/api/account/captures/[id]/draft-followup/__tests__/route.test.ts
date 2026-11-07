/**
 * POST /api/account/captures/[id]/draft-followup — drafts a meeting follow-up
 * email, now through the eve utility agent (kind 'draft_followup').
 *
 * Pinned:
 *   - the task message is BYTE-IDENTICAL to the prompt the pre-port generateText
 *     call sent (meeting header, summary, confirmed actions and decisions,
 *     notes, the closing ask, the sign-off line);
 *   - the tone rides as the kind's prompt param (the spec route templates the
 *     system prompt from it — parity pinned in the spec route tests);
 *   - checkUsageLimits gates BEFORE the model call;
 *   - usage is logged as 'draft_followup_email' with { captureId } against the
 *     model the session ran on, before the provider draft is attempted;
 *   - the body becomes a provider draft when the user has an email connection,
 *     and the response still returns it when they do not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { withMemberSchema } from '@/test/member-schema'

type Row = Record<string, unknown>

const hoisted = vi.hoisted(() => ({
  runUtilityTask: vi.fn(),
  logUsage: vi.fn(async (..._a: unknown[]) => undefined),
  checkUsageLimits: vi.fn(async (..._a: unknown[]) => undefined),
  getValidToken: vi.fn(async (..._a: unknown[]) => null as string | null),
  createEmailDraft: vi.fn(async (..._a: unknown[]) => ({ id: 'draft-1' })),
  order: [] as string[],
  tables: {} as Record<string, Row[] | Row | null>,
}))

// Member columns are the table's real ones: a member query naming one it lacks
// (the old `member:member!member_id(email)` embed) fails as PostgREST fails it.
function fakeSupabase() {
  return withMemberSchema({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: (table: string) => {
      const api: Record<string, unknown> = {
        select: () => api,
        eq: () => api,
        single: async () => ({ data: hoisted.tables[table] ?? null, error: hoisted.tables[table] ? null : { message: 'none' } }),
        maybeSingle: async () => ({ data: hoisted.tables[table] ?? null, error: null }),
        then: (resolve: (r: unknown) => unknown) => Promise.resolve({ data: hoisted.tables[table] ?? [] }).then(resolve),
      }
      return api
    },
  })
}

// A member participant's address is their sign-in email, on the auth user:
// Dana's is resolved through the service client.
const service = withMemberSchema({
  from(table: string) {
    const api: Record<string, unknown> = {}
    api.select = () => api
    api.eq = () => api
    api.then = (resolve: (r: unknown) => unknown) =>
      Promise.resolve({
        data: table === 'member' ? [{ id: 'member-dana', user_id: 'user-dana', display_name: 'Dana' }] : [],
        error: null,
      }).then(resolve)
    return api
  },
  auth: {
    admin: {
      getUserById: async (id: string) => ({
        data: { user: { id, email: id === 'user-dana' ? 'dana@dial8.ai' : null } },
        error: null,
      }),
    },
  },
})
vi.mock('@/lib/admin', () => ({ getServiceClient: () => service }))

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => fakeSupabase() }))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))
vi.mock('@/lib/eve/utility/run-utility', () => ({ runUtilityTask: hoisted.runUtilityTask }))
vi.mock('@/lib/ai/auth', () => ({ logUsage: hoisted.logUsage, checkUsageLimits: hoisted.checkUsageLimits }))
vi.mock('@/lib/oauth/token-manager', () => ({ getValidToken: hoisted.getValidToken }))
vi.mock('@/lib/integrations/email', () => ({ createEmailDraft: hoisted.createEmailDraft }))

const { POST } = await import('@/app/api/account/captures/[id]/draft-followup/route')
const { _resetMemberEmailCacheForTests } = await import('@/lib/workspace-member-emails')

const call = (body: Record<string, unknown> = {}) =>
  POST(new Request('https://dial8.ai/x', { method: 'POST', body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: 'cap-1' }),
  })

beforeEach(() => {
  _resetMemberEmailCacheForTests()
  hoisted.order.length = 0
  hoisted.runUtilityTask.mockReset()
  hoisted.runUtilityTask.mockImplementation(async () => {
    hoisted.order.push('model')
    return {
      text: 'Hi all,\n\nThanks for the time today.',
      model: 'deepseek-v4-flash',
      usage: { inputTokens: 300, outputTokens: 90, costUsd: null, steps: 1 },
    }
  })
  hoisted.checkUsageLimits.mockReset()
  hoisted.checkUsageLimits.mockImplementation(async () => {
    hoisted.order.push('limits')
  })
  hoisted.logUsage.mockClear()
  hoisted.getValidToken.mockReset()
  hoisted.getValidToken.mockResolvedValue(null)
  hoisted.createEmailDraft.mockClear()
  hoisted.tables = {
    captures: {
      id: 'cap-1',
      title: 'Q3 renewal sync',
      ai_summary: 'We agreed on the renewal price.',
      summary: null,
      started_at: null,
      ended_at: null,
      duration_seconds: 1800,
      ai_processed: true,
      organizer_email: null,
    },
    actions: [{ title: 'Send the quote', due_at: null, assignee: { display_name: 'Dana' } }],
    decision: [{ content: 'Price stays at $99' }],
    capture_participant: [{ external_email: 'sam@x.com', member_id: null }, { external_email: null, member_id: 'member-dana' }],
    // The sender's member row in the workspace: the signature's name.
    member: { display_name: 'Liam Ada' },
  }
})

describe('draft-followup → utility agent', () => {
  it('sends the pre-port prompt, byte-identical, as the task message, with the tone as a param', async () => {
    await call({ tone: 'casual', additional_context: 'Mention the pilot.' })
    const args = hoisted.runUtilityTask.mock.calls[0][0]
    expect(args).toMatchObject({ kind: 'draft_followup', workspaceId: 'ws-1', userId: 'user-1', params: { tone: 'casual' } })
    expect(args.message).toBe(
      [
        'Meeting: Q3 renewal sync',
        'Duration: 30 minutes',
        'Participants: sam@x.com, dana@dial8.ai',
        'Summary:',
        'We agreed on the renewal price.',
        'Action Items:',
        '- Send the quote (Owner: Dana)',
        'Decisions Made:',
        '- Price stays at $99',
        'Additional notes: Mention the pilot.',
        'Please draft a follow-up email for the participants of this meeting.',
        'Sign off as Liam Ada.',
      ].join('\n'),
    )
  })

  it('defaults the tone to professional; the date line uses the same formatter as before', async () => {
    ;(hoisted.tables.captures as Row).started_at = '2026-09-21T15:00:00Z'
    await call({ include_actions: false, include_decisions: false, recipients: ['a@b.co'] })
    const args = hoisted.runUtilityTask.mock.calls[0][0]
    expect(args.params).toEqual({ tone: 'professional' })
    const date = new Date('2026-09-21T15:00:00Z').toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
    expect(args.message).toBe(
      `Meeting: Q3 renewal sync\nDate: ${date}\nDuration: 30 minutes\nParticipants: a@b.co\nSummary:\nWe agreed on the renewal price.\nPlease draft a follow-up email for the participants of this meeting.\nSign off as Liam Ada.`,
    )
  })

  it('gates on the usage limit before the model call, and logs draft_followup_email after it', async () => {
    await call()
    expect(hoisted.order).toEqual(['limits', 'model'])
    expect(hoisted.logUsage).toHaveBeenCalledTimes(1)
    const [userId, params] = hoisted.logUsage.mock.calls[0] as [string, Record<string, unknown>]
    expect(userId).toBe('user-1')
    expect(params).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      feature: 'draft_followup_email',
      inputTokens: 300,
      outputTokens: 90,
      costUsd: undefined,
      metadata: { captureId: 'cap-1' },
    })
  })

  it('returns the body; with a connected mailbox it also becomes a provider draft', async () => {
    let res = await call()
    expect(await res.json()).toEqual({
      draft_id: null,
      subject: 'Follow-up: Q3 renewal sync',
      to: ['sam@x.com', 'dana@dial8.ai'],
      body: 'Hi all,\n\nThanks for the time today.',
      provider: null,
    })
    expect(hoisted.createEmailDraft).not.toHaveBeenCalled()

    hoisted.getValidToken.mockImplementation(async (_u: unknown, provider: unknown) => (provider === 'google' ? 'tok' : null))
    res = await call()
    expect(await res.json()).toMatchObject({ draft_id: 'draft-1', provider: 'google' })
    expect(hoisted.createEmailDraft).toHaveBeenCalledWith('user-1', {
      to: ['sam@x.com', 'dana@dial8.ai'],
      subject: 'Follow-up: Q3 renewal sync',
      body: 'Hi all,\n\nThanks for the time today.',
    })
  })

  it('never reaches the model for an unprocessed capture', async () => {
    ;(hoisted.tables.captures as Row).ai_processed = false
    const res = await call()
    expect(res.status).toBe(400)
    expect(hoisted.runUtilityTask).not.toHaveBeenCalled()
  })
})
