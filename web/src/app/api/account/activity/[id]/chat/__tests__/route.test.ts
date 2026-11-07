import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * POST + GET /api/account/activity/[id]/chat — the exact chat for a loop run
 * (bots v3 Phase 4). Pins:
 *   - who: the row's owner who is ALSO the run's run-as user, never either alone;
 *   - the refusals the bubble falls back on: a live run, a cancelled run, a run
 *     with no parked session (or no bot), a run that isn't a loop's;
 *   - a turn mints a FRESH token carrying the run's facts and the bot (the chat
 *     claim: the bot's chat limit), sends a plain queued turn (no outputSchema),
 *     streams the reduced vocabulary, bills the turn (source 'chat') and moves
 *     the cursor past it;
 *   - the usage limit gates a turn; GET replays from the frozen settle boundary;
 *   - a session eve says is gone (the 30-day timeout) reopens the chat in a new
 *     session led by a history primer (loop-run-chat-reopen.ts), under the same
 *     fresh chat token; a live one is untouched; GET replays a reopened chat's
 *     earlier sessions first.
 */

const h = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  row: null as Record<string, unknown> | null,
  ownerMember: true,
  record: null as unknown,
  minted: [] as unknown[],
  attachCalls: [] as unknown[][],
  sendCalls: [] as unknown[][],
  streamCalls: [] as unknown[],
  events: [] as unknown[],
  usage: [] as unknown[],
  advanced: [] as unknown[],
  limitError: null as Response | null,
  /** The row's bot's team: public, or private with or without the caller's seat. */
  botTeam: 'public' as 'public' | 'private' | 'private-seated',
  // ── A session that expired (the 30-day timeout): the chat reopens ──
  /** How many skill-runner clients the route built (one per request: one fresh token). */
  clients: 0,
  /** Per session id: its send fails. */
  sendErrors: {} as Record<string, Error>,
  /** Per session id: its turn's stream fails before any event. */
  responseErrors: {} as Record<string, Error>,
  /** Per session id: its replay script (or failure), else `events`. */
  streams: {} as Record<string, unknown[] | Error>,
  /** Every (sessionId, options) a replay opened. */
  streamsById: [] as Array<[string, Record<string, unknown>]>,
  resets: [] as string[],
  /** The reopen's message-free creates, and the new session's sends. */
  creates: [] as unknown[],
  newSends: [] as unknown[][],
  newSendError: null as Error | null,
  newDrained: false,
  /** Runs inside the reopen's create (a Stop pressed meanwhile). */
  onCreate: null as (() => void) | null,
  /** The reopen's guarded register (swapSkillRunSession), and whether it wins. */
  swaps: [] as Array<{ ref: unknown; swap: unknown }>,
  swapWins: true,
  /** What the primer restores: the ledger row, the skill, the flow run (service reads). */
  primerRow: null as Record<string, unknown> | null,
}))

vi.mock('eve/client', () => {
  // A stand-in for eve's ClientError (an HTTP status and the raw body), so the
  // gone and busy classifiers run against the real shape.
  class ClientError extends Error {
    status: number
    body: string
    constructor(status: number, body = '') {
      super(body || `Server returned ${status}.`)
      this.name = 'ClientError'
      this.status = status
      this.body = body
    }
  }
  return { ClientError }
})
vi.mock('@/lib/api-auth', () => ({
  requireUser: async () => {
    if (!h.user) return new Response('no', { status: 401 })
    const supabase = {
      from: (table: string) => {
        const c: Record<string, unknown> = {}
        for (const m of ['select', 'eq']) c[m] = () => c
        c.maybeSingle = async () => {
          if (table === 'tracked_job') return { data: h.row, error: null }
          if (table === 'ai_team_member') return { data: { id: 'tm-1', team_id: 'team-1', is_system: false }, error: null }
          if (table === 'team') return { data: { is_private: h.botTeam !== 'public' }, error: null }
          if (table === 'team_member') return { data: h.botTeam === 'private-seated' ? { team_id: 'team-1' } : null, error: null }
          return { data: h.ownerMember ? { id: 'm-1' } : null, error: null }
        }
        return c
      },
    }
    return { supabase, user: h.user }
  },
}))
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({
    from: (table: string) => ({
      select: () => {
        const chain = {
          eq: () => chain,
          or: () => chain,
          maybeSingle: async () => {
            if (table === 'tracked_job') return { data: h.primerRow, error: null }
            if (table === 'recipe') return { data: { name: 'Triage', description: 'Sorts the week’s proposals.' }, error: null }
            if (table === 'flow_run') {
              return {
                data: {
                  flow: { workspace_id: 'ws-1', actions: [{ id: 'a-1', type: 'run_skill' }] },
                  action_results: [
                    {
                      action_id: 'a-1',
                      verdict: { summary: 'One duplicate.', entries: [{ decision: 'dismiss', outcome: 'dismissed', reason: 'Duplicate of GEN-12.' }] },
                    },
                  ],
                },
                error: null,
              }
            }
            return { data: null, error: null }
          },
        }
        return chain
      },
    }),
  }),
}))
vi.mock('@/lib/ai/auth', () => ({
  checkUsageLimits: async () => {
    if (h.limitError) throw h.limitError
  },
}))
vi.mock('@/lib/flows/skill-run-token', () => ({
  internalSecret: () => 'secret',
  mintRunToken: (claims: unknown) => {
    h.minted.push(claims)
    return 'fresh.token'
  },
}))
vi.mock('@/lib/flows/skill-run-session', () => ({
  readSkillRunSession: async () => h.record,
  advanceSkillRunCursor: async (_s: unknown, record: unknown, next: unknown) => {
    h.advanced.push({ record, next })
  },
  swapSkillRunSession: async (_s: unknown, ref: unknown, swap: unknown) => {
    h.swaps.push({ ref, swap })
    return h.swapWins
  },
}))
vi.mock('@/lib/flows/skill-run-chat-usage', () => ({
  logSkillRunChatUsage: async (args: unknown) => {
    h.usage.push(args)
    return 1
  },
}))
vi.mock('@/lib/flows/run-skill-eve', () => ({
  skillRunnerClient: () => {
    h.clients += 1
    return {
      sessions: {
        attach: (...args: unknown[]) => {
          h.attachCalls.push(args)
          const id = args[0] as string
          return {
            state: { sessionId: id, streamIndex: 15 },
            send: async (...sendArgs: unknown[]) => {
              h.sendCalls.push(sendArgs)
              if (h.sendErrors[id]) throw h.sendErrors[id]
              const failure = h.responseErrors[id]
              return {
                cancel: async () => ({}),
                async *[Symbol.asyncIterator]() {
                  if (failure) throw failure
                  for (const ev of h.events) yield ev
                },
              }
            },
            respond: async () => {
              if (h.sendErrors[id]) throw h.sendErrors[id]
              return { cancel: async () => ({}), async *[Symbol.asyncIterator]() {} }
            },
            reset: async () => {
              h.resets.push(id)
              return {}
            },
            stream: (opts: Record<string, unknown>) => {
              h.streamCalls.push(opts)
              h.streamsById.push([id, opts])
              const script = h.streams[id] ?? h.events
              return {
                async *[Symbol.asyncIterator]() {
                  if (script instanceof Error) throw script
                  for (const ev of script) yield ev
                },
              }
            },
          }
        },
        // The reopen's message-free create (loop-run-chat-reopen.ts): a new
        // session whose turn echoes the message (the primer leads it), then replies.
        create: async (opts: unknown) => {
          h.creates.push(opts)
          h.onCreate?.()
          return {
            session: {
              get state() {
                return { sessionId: 'sess-new', streamIndex: h.newDrained ? 4 : 0 }
              },
              reset: async () => {
                h.resets.push('sess-new')
                return {}
              },
              send: async (message: unknown, sendOpts: unknown) => {
                h.newSends.push([message, sendOpts])
                if (h.newSendError) throw h.newSendError
                const events = [
                  { type: 'message.received', data: { message: 'flattened', parts: message } },
                  { type: 'message.appended', data: { messageDelta: 'It duplicated GEN-12.' } },
                  { type: 'turn.completed', data: {} },
                  { type: 'session.waiting', data: {} },
                ]
                return {
                  cancel: async () => ({}),
                  async *[Symbol.asyncIterator]() {
                    for (const ev of events) yield ev
                    h.newDrained = true
                  },
                }
              },
            },
          }
        },
      },
    }
  },
}))

// The composer's turn builder (bots v4; run-chat-turn.test.ts covers it).
const composerTurn = vi.hoisted(() => ({ result: null as unknown, calls: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/agent-run/run-chat-turn', async (importOriginal) => ({
  // The real fences (the reopen's primer uses them).
  ...(await importOriginal<typeof import('@/lib/agent-run/run-chat-turn')>()),
  buildRunChatTurn: async (args: Record<string, unknown>) => {
    composerTurn.calls.push(args)
    return composerTurn.result
  },
}))

import { ClientError } from 'eve/client'
import { GET, POST } from '../route'

const MockClientError = ClientError as unknown as new (status: number, body?: string) => Error

const RECORD = {
  workItemId: 'job-1',
  workspaceId: 'ws-1',
  state: { sessionId: 'sess-1', streamIndex: 9, settleStreamIndex: 7 },
  facts: { skillId: 'skill-1', mode: 'act', hasCapture: true, outputContract: 'verdict', model: 'claude-haiku-4-5', runAsUserId: 'user-1' },
}

const params = { params: Promise.resolve({ id: 'job-1' }) }
const post = (body: unknown = { message: 'why did you dismiss the second one?' }) =>
  POST(new Request('http://localhost/api/account/activity/job-1/chat', { method: 'POST', body: JSON.stringify(body) }), params)
const get = () => GET(new Request('http://localhost/api/account/activity/job-1/chat'), params)
const lines = async (res: Response) =>
  (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

const textEvents = () => [
  { type: 'message.appended', data: { messageDelta: 'Because it was a duplicate.', sequence: 0, stepIndex: 0, turnId: 't2' } },
  { type: 'session.waiting', data: {} },
]

beforeEach(() => {
  h.user = { id: 'user-1' }
  h.row = { id: 'job-1', workspace_id: 'ws-1', member_id: 'm-1', kind: 'flow_run', status: 'done', ai_team_member_id: 'tm-1' }
  h.ownerMember = true
  h.record = RECORD
  h.minted = []
  h.attachCalls = []
  h.sendCalls = []
  h.streamCalls = []
  h.events = textEvents()
  h.usage = []
  h.advanced = []
  h.limitError = null
  h.botTeam = 'public'
  h.clients = 0
  h.sendErrors = {}
  h.responseErrors = {}
  h.streams = {}
  h.streamsById = []
  h.resets = []
  h.creates = []
  h.newSends = []
  h.newSendError = null
  h.newDrained = false
  h.onCreate = null
  h.swaps = []
  h.swapWins = true
  h.primerRow = {
    title: 'Weekly triage',
    status: 'done',
    result_summary: 'dismissed 1',
    error_message: null,
    deliverables: [],
    flow_run_id: 'fr-1',
  }
})

describe('who may chat, and the refusals', () => {
  it('401 without a user', async () => {
    h.user = null
    expect((await post()).status).toBe(401)
  })

  it('404 for a row the caller can’t read', async () => {
    h.row = null
    expect((await post()).status).toBe(404)
  })

  it('403 for a row the caller doesn’t own', async () => {
    h.ownerMember = false
    expect((await post()).status).toBe(403)
    expect(h.sendCalls).toHaveLength(0)
  })

  it('403 for the owner when the run ran as someone else', async () => {
    h.record = { ...RECORD, facts: { ...RECORD.facts, runAsUserId: 'user-2' } }
    expect((await post()).status).toBe(403)
    expect(h.sendCalls).toHaveLength(0)
  })

  it('409 NO_SESSION for a run whose bot the caller can’t reach (a private team they aren’t on): nothing is sent', async () => {
    h.botTeam = 'private'
    const res = await post()
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('NO_SESSION')
    expect(h.sendCalls).toHaveLength(0)
    expect(h.minted).toHaveLength(0)
    // A seat on the team opens it.
    h.botTeam = 'private-seated'
    expect((await post()).status).toBe(200)
  })

  it('400 for a row that isn’t a loop’s run', async () => {
    h.row = { ...h.row!, kind: 'work_run' }
    const res = await post()
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('INVALID_KIND')
  })

  for (const [status, code] of [
    ['running', 'NOT_TERMINAL'],
    ['queued', 'NOT_TERMINAL'],
    ['canceled', 'CANCELED'],
  ] as const) {
    it(`409 ${code} for a ${status} run`, async () => {
      h.row = { ...h.row!, status }
      const res = await post()
      expect(res.status).toBe(409)
      expect((await res.json()).code).toBe(code)
      expect(h.sendCalls).toHaveLength(0)
    })
  }

  it('409 NO_SESSION for a run that never parked (before this phase, failed, capped)', async () => {
    h.record = null
    const res = await post()
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('NO_SESSION')
  })

  it('409 NO_SESSION for a run no bot fronts', async () => {
    h.row = { ...h.row!, ai_team_member_id: null }
    const res = await post()
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('NO_SESSION')
  })
})

describe('POST: one follow-up turn', () => {
  it('mints a fresh chat token for the bot, sends a plain queued turn, bills it and moves the cursor', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    const events = await lines(res)
    expect(events).toContainEqual({ type: 'text-delta', delta: 'Because it was a duplicate.' })
    expect(events.at(-1)?.type).toBe('done')

    // The run's facts, the item, and the bot: its chat limit, not the run's.
    expect(h.minted).toEqual([
      expect.objectContaining({
        workspaceId: 'ws-1',
        runAsUserId: 'user-1',
        skillId: 'skill-1',
        mode: 'act',
        outputContract: 'verdict',
        workItemId: 'job-1',
        chat: { teammateId: 'tm-1' },
      }),
    ])
    expect(h.attachCalls[0]).toEqual(['sess-1', { streamIndex: 9 }])
    // A plain turn: no outputSchema, queued.
    expect(h.sendCalls[0]).toEqual(['why did you dismiss the second one?', { turnPolicy: 'queue' }])
    // Billed as a chat turn (the parked session keeps the item's key), then the cursor moves past it.
    expect(h.usage).toEqual([
      expect.objectContaining({ userId: 'user-1', workItemId: 'job-1', sessionId: undefined, teammateId: 'tm-1', events: h.events }),
    ])
    expect(h.advanced).toEqual([{ record: RECORD, next: 15 }])
  })

  it('the usage limit stops a turn before it is sent', async () => {
    h.limitError = new Response(JSON.stringify({ error: 'Usage limit exceeded' }), { status: 429 })
    expect((await post()).status).toBe(429)
    expect(h.sendCalls).toHaveLength(0)
  })

  it('an empty body is a 400', async () => {
    expect((await post({ message: '  ' })).status).toBe(400)
  })
})

describe('GET: replay', () => {
  it('replays from the frozen settle boundary, through the reduced vocabulary', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(await lines(res)).toContainEqual({ type: 'text-delta', delta: 'Because it was a duplicate.' })
    expect(h.streamCalls[0]).toMatchObject({ startIndex: 7 })
    expect(h.sendCalls).toHaveLength(0)
  })

  it('refuses a cancelled run like POST', async () => {
    h.row = { ...h.row!, status: 'canceled' }
    expect((await get()).status).toBe(409)
  })
})

describe('POST: the full composer’s turn (bots v4)', () => {
  const built = {
    message: 'Use the brief playbook on this',
    clientContext: ['## Skill picked for this message: Brief', '## Mentioned in this message'],
    skill: { id: 'skill-brief', name: 'Brief' },
  }

  beforeEach(() => {
    composerTurn.calls = []
    composerTurn.result = built
  })

  it('builds the turn for the run’s own session and sends it with its one-turn context; the token stays the bot’s chat token', async () => {
    const res = await post({
      message: 'Use the brief playbook on this',
      skillId: 'skill-brief',
      // A stale client's "My captures": read without it.
      searchSettings: { timeWindow: 'recent', includeTranscripts: false, includeAttachments: true },
    })
    expect(res.status).toBe(200)
    await lines(res)
    expect(composerTurn.calls).toHaveLength(1)
    expect(composerTurn.calls[0]).toMatchObject({
      userId: 'user-1',
      workspaceId: 'ws-1',
      message: 'Use the brief playbook on this',
      extras: { skillId: 'skill-brief' },
      // An attended chat turn reads the person's private captures, as its tools do.
      privateCaptures: true,
    })
    expect(composerTurn.calls[0]).not.toHaveProperty('model')
    expect(composerTurn.calls[0].extras).not.toHaveProperty('searchSettings')
    expect(h.sendCalls[0]).toEqual([built.message, { turnPolicy: 'queue', clientContext: built.clientContext }])
    // The skill's tools need no claim: the turn already has the bot's whole attended chat ceiling.
    expect(h.minted[0]).toMatchObject({ chat: { teammateId: 'tm-1' } })
    expect(h.minted[0]).not.toHaveProperty('skillId', 'skill-brief')
  })

  it('a refusal is a 400 before anything is sent', async () => {
    composerTurn.result = { status: 400, error: 'skill not found', code: 'SKILL_NOT_FOUND' }
    const res = await post({ message: 'go', skillId: 'skill-other' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'SKILL_NOT_FOUND' })
    expect(h.sendCalls).toHaveLength(0)
  })

  it('a malformed extra is a 400; a plain message builds nothing', async () => {
    expect((await post({ message: 'go', files: [{}] })).status).toBe(400)
    await lines(await post({ message: 'plain' }))
    expect(composerTurn.calls).toHaveLength(0)
    expect(h.sendCalls.at(-1)).toEqual(['plain', { turnPolicy: 'queue' }])
  })
})


describe('POST: a session that expired (the 30-day timeout) reopens with a history primer', () => {
  const GONE_409 = () => new MockClientError(409, '{"ok":false,"code":"session_not_active","error":"The session is no longer active."}')

  beforeEach(() => {
    // The gone session's follow-up turns, still readable after the timeout.
    h.streams['sess-1'] = [
      { type: 'message.received', data: { message: 'which ones did you dismiss?' } },
      { type: 'message.appended', data: { messageDelta: 'The duplicate of GEN-12.' } },
      { type: 'actions.requested', data: { actions: [{ kind: 'tool-call', callId: 'c', toolName: 'list_proposals', input: { secret: 'old-input' } }] } },
      { type: 'turn.completed', data: {} },
      { type: 'session.completed', data: {} },
    ]
  })

  it('reopens: a new session registered over the gone one, the turn led by the fenced primer under the same fresh token, billed and advanced on the new session', async () => {
    h.sendErrors['sess-1'] = GONE_409()
    const events = await lines(await post())

    // The person sees their words and the reply, never the restored history.
    expect(events).toEqual([
      { type: 'user-message', text: 'why did you dismiss the second one?' },
      { type: 'text-delta', delta: 'It duplicated GEN-12.' },
      { type: 'done' },
    ])
    expect(JSON.stringify(events)).not.toContain('run-history')

    // One client, one fresh chat token (the bot's attended chat claim), made the create and the send.
    expect(h.clients).toBe(1)
    expect(h.minted).toEqual([expect.objectContaining({ workItemId: 'job-1', chat: { teammateId: 'tm-1' } })])
    expect(h.creates).toEqual([{}])

    // Registered over the gone session only; the gone one's turns stay replayable.
    const state = { sessionId: 'sess-new', streamIndex: 0, settleStreamIndex: 0, previous: [{ sessionId: 'sess-1', startIndex: 7 }] }
    expect(h.swaps).toEqual([{ ref: RECORD, swap: { from: 'sess-1', to: state } }])

    // The turn: the primer first, then the person's words, queued.
    const [message, opts] = h.newSends[0] as [Array<{ type: string; text: string }>, unknown]
    expect(opts).toEqual({ turnPolicy: 'queue' })
    expect(message.slice(1)).toEqual([{ type: 'text', text: 'why did you dismiss the second one?' }])
    const primer = message[0].text
    expect(primer.startsWith('## Restored history of this chat')).toBe(true)
    expect(primer).toContain('<run-history part="task">\nLoop: Weekly triage\nSkill: Triage\nSorts the week’s proposals.\n</run-history>')
    expect(primer).toContain('<run-history part="report">\ndismissed 1\n</run-history>')
    expect(primer).toContain('1. dismiss, dismissed: Duplicate of GEN-12.')
    expect(primer).toContain('Person: which ones did you dismiss?\nAgent: The duplicate of GEN-12.')
    expect(primer).not.toContain('old-input')
    // The gone session's history: a bounded catch-up read from its settle boundary.
    expect(h.streamsById[0]).toEqual(['sess-1', expect.objectContaining({ startIndex: 7, follow: false })])

    // Billed on the new session (its turn ids restart), and its cursor advanced.
    expect(h.usage).toEqual([expect.objectContaining({ workItemId: 'job-1', sessionId: 'sess-new' })])
    expect(h.advanced).toEqual([{ record: { ...RECORD, state }, next: 4 }])
  })

  it('a live session is untouched: no new session, no register, the turn goes to the run’s own session', async () => {
    const events = await lines(await post())
    expect(events).toContainEqual({ type: 'text-delta', delta: 'Because it was a duplicate.' })
    expect(h.creates).toEqual([])
    expect(h.swaps).toEqual([])
    expect(h.newSends).toEqual([])
    expect(h.sendCalls).toEqual([['why did you dismiss the second one?', { turnPolicy: 'queue' }]])
    expect(h.advanced).toEqual([{ record: RECORD, next: 15 }])
  })

  it('a session that took the POST but whose history expired (410 before any event): reset, then the turn reopens', async () => {
    h.responseErrors['sess-1'] = new MockClientError(410, '{"ok":false,"code":"session_expired","error":"Session history is no longer available."}')
    h.streams['sess-1'] = new MockClientError(410, '{"ok":false,"code":"session_expired"}')
    const events = await lines(await post())
    expect(events).toEqual([
      { type: 'user-message', text: 'why did you dismiss the second one?' },
      { type: 'text-delta', delta: 'It duplicated GEN-12.' },
      { type: 'done' },
    ])
    expect(h.resets).toEqual(['sess-1'])
    expect(h.sendCalls).toHaveLength(1)
    expect(h.newSends).toHaveLength(1)
    // No history to restore: the primer still carries the run's facts.
    const primer = (h.newSends[0][0] as Array<{ text: string }>)[0].text
    expect(primer).toContain('Loop: Weekly triage')
    expect(primer).not.toContain('part="messages"')
  })

  it('BUSY when the session is gone but another send reopened the chat first: nothing goes to the parked new session', async () => {
    h.sendErrors['sess-1'] = GONE_409()
    h.swapWins = false
    const events = await lines(await post())
    expect(events).toEqual([{ type: 'error', message: 'The agent could not be reached', code: 'BUSY' }])
    expect(h.newSends).toEqual([])
    // Never the winner's session: the cursor stays the gone record's (its send moved nothing).
    expect((h.advanced as Array<{ record: typeof RECORD }>).map((a) => a.record.state.sessionId)).toEqual(['sess-1'])
  })

  it('a locked session (423) is BUSY and never reopens', async () => {
    h.sendErrors['sess-1'] = new MockClientError(423, '{"ok":false,"code":"session_locked"}')
    const events = await lines(await post())
    expect(events).toEqual([{ type: 'error', message: 'The agent could not be reached', code: 'BUSY' }])
    expect(h.creates).toEqual([])
    expect(h.swaps).toEqual([])
  })

  it('a turn the new session refuses is FAILED, and the record goes back to the gone session', async () => {
    h.sendErrors['sess-1'] = GONE_409()
    h.newSendError = new Error('eve refused the send at /var/task')
    const events = await lines(await post())
    expect(events).toEqual([{ type: 'error', message: 'The turn failed', code: 'FAILED' }])
    expect(JSON.stringify(events)).not.toContain('/var/task')
    // Put back only while the new session's cursor is still at its start, then reset.
    expect(h.swaps[1]).toEqual({ ref: RECORD, swap: { from: 'sess-new', fromStreamIndex: 0, to: RECORD.state } })
    expect(h.swaps).toHaveLength(2)
    expect(h.resets).toEqual(['sess-new'])
  })

  it('a timed-out session (409 session_not_active) reopens without a reset; a stranded one (409 session_stranded) is reset first', async () => {
    h.sendErrors['sess-1'] = GONE_409()
    await lines(await post())
    expect(h.resets).toEqual([])

    h.newSends = []
    h.newDrained = false
    h.sendErrors['sess-1'] = new MockClientError(409, '{"ok":false,"code":"session_stranded"}')
    const events = await lines(await post())
    expect(events).toContainEqual({ type: 'text-delta', delta: 'It duplicated GEN-12.' })
    expect(h.resets).toEqual(['sess-1'])
    expect(h.newSends).toHaveLength(1)
  })

  it('Stop while the gone session’s turn moves to a new one: nothing is sent, and no send failure is logged', async () => {
    h.sendErrors['sess-1'] = GONE_409()
    const ac = new AbortController()
    // The person presses Stop while the new session is being created.
    h.onCreate = () => ac.abort()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await POST(
        new Request('http://localhost/api/account/activity/job-1/chat', {
          method: 'POST',
          body: JSON.stringify({ message: 'why did you dismiss the second one?' }),
          signal: ac.signal,
        }),
        params,
      )
      expect(await lines(res)).toEqual([{ type: 'done' }])
      expect(h.creates).toHaveLength(1)
      expect(h.swaps).toEqual([])
      expect(h.newSends).toEqual([])
      expect(errors.mock.calls.some((c) => String(c[0]).includes('send failed'))).toBe(false)
    } finally {
      errors.mockRestore()
    }
  })

  it('a gone session with nothing to carry (an answer with no words) is FAILED, not BUSY: nothing opens', async () => {
    h.sendErrors['sess-1'] = GONE_409()
    const res = await post({ inputResponses: [{ requestId: 'r-1', optionId: 'approve' }] })
    // An answer goes through respond(), which the gone session refuses too.
    expect(await lines(res)).toEqual([{ type: 'error', message: 'The turn failed', code: 'FAILED' }])
    expect(h.creates).toEqual([])
  })
})

describe('GET: a reopened chat', () => {
  it('replays its earlier sessions first (bounded reads), then its own, never the restored history', async () => {
    h.record = {
      ...RECORD,
      state: { sessionId: 'sess-new', streamIndex: 6, settleStreamIndex: 0, previous: [{ sessionId: 'sess-old', startIndex: 7 }] },
    }
    h.streams['sess-old'] = [
      { type: 'message.received', data: { message: 'which ones did you dismiss?' } },
      { type: 'message.appended', data: { messageDelta: 'The duplicate.' } },
      { type: 'turn.completed', data: {} },
    ]
    h.streams['sess-new'] = [
      {
        type: 'message.received',
        data: {
          message: 'flattened',
          parts: [
            { type: 'text', text: '## Restored history of this chat\n<run-history part="messages">\nPerson: x\n</run-history>' },
            { type: 'text', text: 'and the second?' },
          ],
        },
      },
      { type: 'message.appended', data: { messageDelta: 'Already done.' } },
      { type: 'turn.completed', data: {} },
    ]
    const events = await lines(await get())
    expect(events).toEqual([
      { type: 'user-message', text: 'which ones did you dismiss?' },
      { type: 'text-delta', delta: 'The duplicate.' },
      { type: 'done' },
      { type: 'user-message', text: 'and the second?' },
      { type: 'text-delta', delta: 'Already done.' },
      { type: 'done' },
    ])
    expect(h.streamsById.map(([id, opts]) => [id, opts.startIndex, opts.follow])).toEqual([
      ['sess-old', 7, false],
      ['sess-new', 0, undefined],
    ])
  })

  it('reads several earlier sessions side by side under one deadline, and shows them oldest first', async () => {
    h.record = {
      ...RECORD,
      state: {
        sessionId: 'sess-new',
        streamIndex: 6,
        settleStreamIndex: 0,
        previous: [
          { sessionId: 'sess-a', startIndex: 7 },
          { sessionId: 'sess-b', startIndex: 0 },
        ],
      },
    }
    h.streams['sess-a'] = [{ type: 'message.appended', data: { messageDelta: 'first' } }]
    h.streams['sess-b'] = [{ type: 'message.appended', data: { messageDelta: 'second' } }]
    h.streams['sess-new'] = [{ type: 'message.appended', data: { messageDelta: 'third' } }]
    const deltas = (await lines(await get())).filter((e) => e.type === 'text-delta').map((e) => e.delta)
    expect(deltas).toEqual(['first', 'second', 'third'])
    const [a, b] = h.streamsById
    expect([a[0], b[0]]).toEqual(['sess-a', 'sess-b'])
    // One deadline for all of them, not one each.
    expect(a[1].signal).toBeInstanceOf(AbortSignal)
    expect(a[1].signal).toBe(b[1].signal)
  })

  it('a session whose history eve no longer holds opens quietly (no error): the next send reopens the chat', async () => {
    h.streams['sess-1'] = new MockClientError(410, '{"ok":false,"code":"session_expired"}')
    expect(await lines(await get())).toEqual([])
  })
})
