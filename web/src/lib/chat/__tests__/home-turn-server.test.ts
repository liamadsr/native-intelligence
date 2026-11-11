/**
 * Server-written home turns (A4 slice 5), the server half, over an in-memory
 * database and a scripted eve session. Pinned:
 *   - the skip rules: not a home thread, gone, no longer a member, autonomy
 *     off, over the usage limit, no eve session, nothing new; a skip with
 *     something to deliver records a `skipped` row;
 *   - the claim: unique per conversation and dedupe key; a retry resumes its
 *     own claimed/sent row and a settled one is a duplicate;
 *   - the send: once (claimed → sent), exactly `{ message, turnPolicy: 'queue' }`
 *     with a `server: 'home_turn'` token and no credential; a refused send
 *     fails the row; a retried step never sends again;
 *   - the read: finds its own message by tag, skips the turn it queued behind,
 *     stops at the first event of another delivery (the person's message
 *     folded in), and continues across a budget cut to the same parts;
 *   - the finish: a no_reply turn, `[quiet]` or nothing writes nothing; a reply is written as
 *     `home-turn:<row>` with kind home_turn; the activity signal fires.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HandleMessageStreamEvent } from 'eve/client'
import fixtures from '@/lib/chat/eve/__tests__/fixtures/eve-0.66.3-live-streams.json'

vi.mock('@/lib/ai/auth', () => ({ checkUsageLimits: vi.fn(async () => undefined) }))
const signal = vi.hoisted(() => vi.fn())
vi.mock('@/lib/chat/idle-compaction-signal', () => ({ signalChatSessionActivity: signal }))

import { HOME_TURN_TOKEN_MAX_TTL_MS, verifyChatRunToken } from '@/lib/chat/chat-run-token'
import { IDLE_COMPACTION_QUIET_MS } from '@/lib/chat/idle-compaction'
import { buildTeammateReport, teammateReportMessageId, TEAMMATE_REPORT_KIND } from '@/lib/chat/teammate-report'
import { CHECK_IN_GUIDANCE, HOME_TURN_KIND, homeTurnTag, type HomeTurnRequestedData } from '@/lib/chat/home-turn'
import { renderChannelTurnBody } from '@/lib/chat/channel-turn'
import {
  attributeHomeTurnEvent,
  claimHomeTurn,
  continueHomeTurn,
  createCheckInSession,
  finishHomeTurn,
  homeTurnLogLine,
  homeTurnLabel,
  homeTurnDedupeKey,
  lastPersonMessageAt,
  acceptedDeliveryIdOf,
  hasOpenInputRequest,
  HOME_TURN_COMPACTION_WINDOW_MS,
  HOME_TURN_MAX_READ_STEPS,
  HOME_TURN_READ_TOKEN_TTL_MS,
  HOME_TURN_STEP_BUDGET_MS,
  HOME_TURN_TOKEN_TTL_MS,
  homeTurnToken,
  newHomeTurnReadState,
  peekSessionTail,
  planHomeTurn as realPlanHomeTurn,
  readHomeTurnEvents,
  inputBudgetRequestIds,
  type SessionTail,
  sendHomeTurn,
  type HomeTurnPlan,
  type HomeTurnReadResult,
  type HomeTurnRow,
  ensureHomeSession,
  isSessionGoneError,
  isSendSessionGoneError,
  SessionTailError,
  withHomeTurnPrimer,
  HOME_TURN_SEND_MAX_CHARS,
} from '../home-turn-server'

// ── An in-memory database (just what these paths query) ─────────────────────

type Row = Record<string, unknown>
type Filter = { col: string; op: 'eq' | 'neq' | 'gte' | 'gt' | 'notnull' | 'in' | 'isnull' | 'or'; val?: unknown }

/** PostgREST's `or` list, the shapes these paths write: `col.is.null` and `col.eq.value`. */
function orMatch(row: Row, list: string): boolean {
  return list.split(',').some((term) => {
    const [col, op, ...rest] = term.split('.')
    const value = rest.join('.')
    if (op === 'is' && value === 'null') return get(row, col) == null
    if (op === 'eq') return get(row, col) === value.replace(/^"|"$/g, '')
    throw new Error(`memDb: unsupported or term ${term}`)
  })
}

function get(row: Row, col: string): unknown {
  if (!col.includes('->')) return row[col]
  let cur: unknown = row
  for (const key of col.split(/->>?/)) cur = cur && typeof cur === 'object' ? (cur as Row)[key] : undefined
  return cur
}

function memDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]))
  const unique: Record<string, (r: Row) => string> = {
    home_turn: (r) => `${r.conversation_id}|${r.dedupe_key}`,
    chat_messages: (r) => `${r.conversation_id}|${(r.ui_message as Row | undefined)?.id}`,
  }
  let seq = 0
  function from(table: string) {
    const filters: Filter[] = []
    let kind: 'select' | 'insert' | 'update' | 'upsert' = 'select'
    let payload: Row | null = null
    let ignoreDuplicates = false
    let returning = false
    let limit = Infinity
    let order: { col: string; asc: boolean } | null = null
    const rows = () => (tables[table] ??= [])
    const match = (r: Row) =>
      filters.every((f) =>
        f.op === 'or' ? orMatch(r, String(f.val)) : f.op === 'isnull' ? get(r, f.col) == null : f.op === 'in' ? (f.val as unknown[]).includes(get(r, f.col)) : f.op === 'eq' ? get(r, f.col) === f.val : f.op === 'neq' ? get(r, f.col) !== f.val : f.op === 'gte' ? String(get(r, f.col)) >= String(f.val) : f.op === 'gt' ? get(r, f.col) != null && String(get(r, f.col)) > String(f.val) : get(r, f.col) != null,
      )
    const run = (): { data: unknown; error: { message: string; code?: string } | null } => {
      if (kind === 'insert' || kind === 'upsert') {
        const stamp = new Date(Date.now() + seq).toISOString()
        const row: Row = { id: `row-${++seq}`, created_at: stamp, updated_at: stamp, ...payload! }
        const key = unique[table]?.(row)
        if (key && rows().some((r) => unique[table]!(r) === key)) {
          if (kind === 'upsert' && ignoreDuplicates) return { data: [], error: null }
          return { data: null, error: { message: 'duplicate key', code: '23505' } }
        }
        rows().push(row)
        return { data: returning ? [row] : null, error: null }
      }
      if (kind === 'update') {
        const hit = rows().filter(match)
        for (const r of hit) Object.assign(r, payload)
        return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null }
      }
      let out = rows().filter(match)
      if (order) {
        const { col, asc } = order
        out = [...out].sort((a, b) => (String(get(a, col)) < String(get(b, col)) ? -1 : 1) * (asc ? 1 : -1))
      }
      return { data: out.slice(0, limit).map((r) => ({ ...r })), error: null }
    }
    const q: Record<string, unknown> = {
      select: () => ((returning = true), q),
      insert: (p: Row) => ((kind = 'insert'), (payload = p), q),
      upsert: (p: Row, o?: { ignoreDuplicates?: boolean }) => ((kind = 'upsert'), (payload = p), (ignoreDuplicates = !!o?.ignoreDuplicates), q),
      update: (p: Row) => ((kind = 'update'), (payload = p), q),
      eq: (col: string, val: unknown) => (filters.push({ col, op: 'eq', val }), q),
      neq: (col: string, val: unknown) => (filters.push({ col, op: 'neq', val }), q),
      in: (col: string, val: unknown[]) => (filters.push({ col, op: 'in', val }), q),
      gte: (col: string, val: unknown) => (filters.push({ col, op: 'gte', val }), q),
      gt: (col: string, val: unknown) => (filters.push({ col, op: 'gt', val }), q),
      not: (col: string) => (filters.push({ col, op: 'notnull' }), q),
      is: (col: string) => (filters.push({ col, op: 'isnull' }), q),
      or: (list: string) => (filters.push({ col: '', op: 'or', val: list }), q),
      order: (col: string, o?: { ascending?: boolean }) => ((order = { col, asc: o?.ascending !== false }), q),
      limit: (n: number) => ((limit = n), q),
      maybeSingle: async () => {
        const r = run()
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }
      },
      single: async () => {
        const r = run()
        const data = Array.isArray(r.data) ? (r.data[0] ?? null) : r.data
        return { data, error: r.error ?? (data ? null : { message: 'no row' }) }
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    }
    return q
  }
  return { client: { from } as never, tables }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CONV = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const WS = '33333333-3333-4333-8333-333333333333'
const ITEM_A = '44444444-4444-4444-8444-444444444444'
const ITEM_B = '55555555-5555-4555-8555-555555555555'
const DATA: HomeTurnRequestedData = { conversationId: CONV, userId: USER, workspaceId: WS, workItemIds: [ITEM_B], reason: 'helper_report' }

/** The session tail the plan reads (no live eve): settable per test. */
let TAIL: SessionTail = { tailIndex: -1, events: [] }
const planHomeTurn = (client: never, data: HomeTurnRequestedData, deps: Parameters<typeof realPlanHomeTurn>[2] = {}) =>
  realPlanHomeTurn(client, data, {
    peekTail: async () => TAIL,
    // Hermetic: no eve to create a session in, no primer reads.
    ensureSession: async () => ({ ok: false, reason: 'no_session' }),
    renderPrimer: async () => null,
    ...deps,
  })

function reportRow(item: string, status: 'needs_review' | 'needs_input' | 'failed', minutesAgo: number) {
  const report = buildTeammateReport({
    runId: null,
    workItemId: item,
    workspaceId: WS,
    status,
    teammateId: null,
    teammateName: 'Researcher',
    title: `Work ${item.slice(0, 4)}`,
    question: status === 'needs_input' ? 'Which region?' : null,
  })
  const id = teammateReportMessageId({ runId: null, workItemId: item, status, question: report.question })
  return {
    conversation_id: CONV,
    user_id: USER,
    workspace_id: WS,
    role: 'assistant',
    created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    ui_message: { id, role: 'assistant', parts: [], metadata: { kind: TEAMMATE_REPORT_KIND, teammate_report: report } },
  }
}

function baseSeed(over: { conv?: Row; member?: boolean; settings?: unknown; reports?: Row[]; turns?: Row[] } = {}) {
  return {
    chat_conversations: [{ id: CONV, user_id: USER, workspace_id: WS, eve_session_id: 'sess-home', is_home: true, ...over.conv }],
    member: over.member === false ? [] : [{ id: 'm1', user_id: USER, workspace_id: WS }],
    workspace: [{ id: WS, settings: over.settings ?? {} }],
    chat_messages: over.reports ?? [reportRow(ITEM_A, 'needs_review', 5), reportRow(ITEM_B, 'needs_input', 1)],
    home_turn: over.turns ?? [],
  }
}

const ev = (type: string, data: object, ids?: string[]): HandleMessageStreamEvent =>
  ({ type, data, meta: { at: '2026-10-14T00:00:00.000Z', id: `e-${type}`, ...(ids ? { deliveryIds: ids } : {}) } }) as unknown as HandleMessageStreamEvent

/** A scripted session: send records the call; stream yields `events` from startIndex, then waits (or throws on abort). */
function scriptedSession(events: HandleMessageStreamEvent[], opts: { sendError?: Error; stall?: boolean; deliveryId?: string; onSend?: () => void } = {}) {
  const sends: Array<{ message: unknown; options: unknown }> = []
  const responds: Array<{ responses: unknown; token: string }> = []
  const attaches: Array<{ id: string; streamIndex: number }> = []
  const tokens: string[] = []
  const session = {
    send: vi.fn(async (message: unknown, options: unknown) => {
      if (opts.sendError) throw opts.sendError
      opts.onSend?.()
      sends.push({ message, options })
      // eve 0.66.3 keeps the accepted delivery id under this own symbol.
      return opts.deliveryId ? { [Symbol('acceptedDeliveryId')]: opts.deliveryId } : {}
    }),
    stream: ({ startIndex, signal: abort }: { startIndex: number; signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        for (let i = startIndex; i < events.length; i++) {
          if (abort.aborted) throw new Error('aborted')
          yield events[i]
        }
        if (opts.stall) {
          await new Promise((_r, reject) => abort.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
        }
      },
    }),
  }
  const makeClient = (args: { secret: string; token: string }) => {
    tokens.push(args.token)
    // Each client's session answers `respond` with the token it was made with.
    const bound = {
      ...session,
      respond: vi.fn(async (responses: unknown) => {
        responds.push({ responses, token: args.token })
        return {}
      }),
    }
    return { sessions: { attach: (id: string, o: { streamIndex: number }) => (attaches.push({ id, streamIndex: o.streamIndex }), bound) } } as never
  }
  return { session, sends, responds, attaches, tokens, makeClient }
}

/** The events of a home turn whose message carries `tag`, with delivery id `own`. */
function ownTurn(tag: string, own = 'd-own', reply = 'Your researcher has a question: which region?'): HandleMessageStreamEvent[] {
  return [
    ev('turn.started', { turnId: 'turn_9' }, [own]),
    ev('message.received', { message: `[BACKGROUND UPDATE · ${tag}] Not from the person.`, turnId: 'turn_9' }, [own]),
    ev('step.started', { turnId: 'turn_9' }, [own]),
    ev('message.appended', { messageDelta: reply, turnId: 'turn_9' }, [own]),
    ev('message.completed', { message: reply, turnId: 'turn_9' }, [own]),
    ev('turn.completed', { turnId: 'turn_9' }, [own]),
    ev('session.waiting', { wait: 'next-user-message' }, [own]),
  ]
}

beforeEach(() => {
  process.env.CHAT_INTERNAL_SECRET = 'chat-internal-secret-0123456789'
  signal.mockClear()
  TAIL = { tailIndex: -1, events: [] }
})

// ── Plan: the skip rules ─────────────────────────────────────────────────────

describe('planHomeTurn', () => {
  it('plans the reports no earlier home turn carried, oldest first, with a stable dedupe key', async () => {
    const { client } = memDb(baseSeed())
    const plan = await planHomeTurn(client, DATA)
    expect(plan.ok).toBe(true)
    const p = plan as HomeTurnPlan
    expect(p.sessionId).toBe('sess-home')
    expect(p.reports.map((r) => r.report.work_item_id)).toEqual([ITEM_A, ITEM_B])
    expect(p.workItemIds.sort()).toEqual([ITEM_A, ITEM_B].sort())
    expect(p.dedupeKey).toBe(homeTurnDedupeKey('helper_report', [...p.reports.map((r) => r.messageId)].reverse()))
  })

  it('leaves out reports a sent, done, skipped or fresh claimed home turn carried, and a send that may have landed', async () => {
    const carried = reportRow(ITEM_A, 'needs_review', 5)
    const id = (carried.ui_message as { id: string }).id
    const fresh = new Date().toISOString()
    for (const [status, error] of [['sent', null], ['done', null], ['skipped', 'autonomy_off'], ['claimed', null], ['failed', 'send_failed']] as const) {
      const { client } = memDb(baseSeed({ turns: [{ conversation_id: CONV, user_id: USER, status, error, report_message_ids: [id], created_at: 'x', updated_at: fresh }] }))
      const plan = (await planHomeTurn(client, DATA)) as HomeTurnPlan
      expect([status, plan.reports.map((r) => r.messageId)]).toEqual([status, [expect.not.stringContaining(id)]])
    }
  })

  it('a failure before eve accepted anything carried nothing: its reports get a turn', async () => {
    const id = (reportRow(ITEM_A, 'needs_review', 5).ui_message as { id: string }).id
    for (const error of ['send_refused_403_server_send_not_home', 'claim_stale', 'server_auth_unavailable', 'empty_body']) {
      const { client } = memDb(baseSeed({ turns: [{ conversation_id: CONV, user_id: USER, status: 'failed', error, report_message_ids: [id], created_at: 'x' }] }))
      const plan = (await planHomeTurn(client, DATA)) as HomeTurnPlan
      expect([error, plan.reports.map((r) => r.messageId)]).toEqual([error, expect.arrayContaining([id])])
    }
  })

  it('a claim left past 15 minutes (nothing sent) is failed claim_stale, and its reports get a turn', async () => {
    const id = (reportRow(ITEM_A, 'needs_review', 5).ui_message as { id: string }).id
    const old = new Date(Date.now() - 16 * 60_000).toISOString()
    const db = memDb(baseSeed({ turns: [{ id: 'stale', conversation_id: CONV, user_id: USER, status: 'claimed', report_message_ids: [id], created_at: old, updated_at: old }] }))
    const plan = (await planHomeTurn(db.client, DATA)) as HomeTurnPlan
    expect(plan.reports.map((r) => r.messageId)).toContain(id)
    expect(db.tables.home_turn[0]).toMatchObject({ status: 'failed', error: 'claim_stale' })
  })

  it('starts the turn at the session’s tail (absolute), never replaying the session', async () => {
    TAIL = { tailIndex: 41, events: [] }
    const { client } = memDb(baseSeed())
    expect(await planHomeTurn(client, DATA)).toMatchObject({ ok: true, fromIndex: 42 })
  })

  it('defers (and records) while the thread is parked on the person’s question; a resolved one is fine', async () => {
    const rec = fixtures as unknown as Record<string, HandleMessageStreamEvent[]>
    TAIL = { tailIndex: 17, events: rec.askUserApprovalPark }
    const { client } = memDb(baseSeed())
    expect(await planHomeTurn(client, DATA)).toMatchObject({ ok: false, reason: 'question_pending', record: expect.anything() })
    TAIL = { tailIndex: 39, events: [...rec.askUserApprovalPark, ...rec.askUserApprovalResume] }
    expect(await planHomeTurn(client, DATA)).toMatchObject({ ok: true, fromIndex: 40 })
  })

  it.each([
    ['a side chat', { conv: { is_home: null } }, 'not_home', false],
    ['a person no longer a member', { member: false }, 'not_member', false],
    ['autonomy off', { settings: { agent_autonomy: { mode: 'off' } } }, 'autonomy_off', true],
    // No eve session yet is no longer a stop (home-turn-session.test.ts): only one that can't be had.
    ['no eve session to be had', { conv: { eve_session_id: null } }, 'no_session', true],
    ['nothing new', { reports: [] }, 'nothing_new', false],
  ])('skips %s', async (_label, over, reason, records) => {
    const { client } = memDb(baseSeed(over as never))
    const plan = await planHomeTurn(client, DATA)
    expect(plan).toMatchObject({ ok: false, reason })
    expect(!!(plan as { record?: unknown }).record).toBe(records)
  })

  it('an unreadable kill switch skips the turn (fails CLOSED: a turn spends money), keeping its record', async () => {
    const { client } = memDb(baseSeed())
    const broken = { from: (t: string) => (t === 'workspace' ? (() => { throw new Error('socket hang up') })() : (client as { from: (t: string) => unknown }).from(t)) }
    expect(await planHomeTurn(broken as never, DATA)).toMatchObject({ ok: false, reason: 'autonomy_off', record: expect.anything() })
  })

  it('skips a conversation that is gone, and a reason with no body yet', async () => {
    const { client } = memDb(baseSeed())
    expect(await planHomeTurn(client, { ...DATA, conversationId: '99999999-9999-4999-8999-999999999999' })).toMatchObject({ reason: 'no_conversation' })
    // An event turn with no turn rows waiting has nothing to say.
    expect(await planHomeTurn(client, { ...DATA, reason: 'event' })).toMatchObject({ reason: 'nothing_new' })
    // A digest names its day (the parse refuses one without; the plan holds too).
    expect(await planHomeTurn(client, { ...DATA, reason: 'digest' })).toMatchObject({ reason: 'bad_event' })
  })

  it('an event turn (the router\'s turn rows): gathers every undelivered one (never the payload\'s word), drops what settled, names each thread with its pointer, keyed on the rows', async () => {
    const now = Date.now()
    const iso = (min: number) => new Date(now - min * 60_000).toISOString()
    const turnRow = (over: Row) => ({ workspace_id: WS, user_id: USER, state: 'routed', outcome: 'turn', delivered_at: null, created_at: iso(5), occurs_at: iso(5), expires_at: null, ...over })
    const seed = {
      ...baseSeed(),
      agent_event: [
        turnRow({ id: '1', kind: 'email.drafted', facts: { from: 'dana@acme.com', known: true }, ref_type: 'email_draft', ref_id: 'd-1' }),
        turnRow({ id: '2', kind: 'email.needs_reply', facts: { title: 'Intro', from: 'Sam', known: true }, ref_type: 'email_thread', ref_id: 'pt-2' }),
        // Sent since the router saw it: dropped, and marked settled.
        turnRow({ id: '3', kind: 'email.drafted', facts: { title: 'Already sent', known: true }, ref_type: 'email_draft', ref_id: 'd-3' }),
        // Quiet rows and delivered ones never ride an event turn.
        turnRow({ id: '4', kind: 'email.drafted', outcome: 'quiet', facts: { title: 'Newsletter' }, ref_type: 'email_draft', ref_id: 'd-4' }),
        turnRow({ id: '5', kind: 'email.drafted', delivered_at: iso(1), state: 'delivered', facts: { title: 'Told already' }, ref_type: 'email_draft', ref_id: 'd-5' }),
      ],
      email_draft: [
        { id: 'd-1', workspace_id: WS, status: 'pending_review' },
        { id: 'd-3', workspace_id: WS, status: 'sent' },
      ],
      email_thread_index: [{ id: 'ti-2', workspace_id: WS, user_id: USER, provider_thread_id: 'pt-2', needs_reply: true }],
    }
    const { client, tables } = memDb(seed)
    const plan = await planHomeTurn(client, { ...DATA, workItemIds: [], reason: 'event', eventIds: ['1'] }, { now })
    expect(plan.ok).toBe(true)
    const events = (plan as HomeTurnPlan).events!
    expect(events.eventIds).toEqual(['1', '2'])
    expect(events.lines[0]).toContain('Reply needed from dana@acme.com.')
    expect(events.lines[0]).toContain('review pile')
    expect(events.lines[0]).toContain('[email_draft d-1]')
    expect(events.lines[1]).toContain('[email_thread pt-2]')
    expect(events.lines.join('\n')).not.toMatch(/Already sent|Newsletter|Told already/)
    expect((plan as HomeTurnPlan).dedupeKey).toBe(homeTurnDedupeKey('event', ['1', '2']))
    expect(tables.agent_event.find((r) => r.id === '3')).toMatchObject({ state: 'delivered', delivered_key: 'settled' })
    // The body: fenced, names the threads, points at the review pile, allows no_reply and a read-and-draft helper.
    const { buildHomeTurnBody } = await import('@/lib/chat/home-turn')
    const body = buildHomeTurnBody('row-1', 'event', { events })!
    expect(body).toContain('[BACKGROUND UPDATE · home-turn row-1]')
    expect(body).toContain('review pile')
    expect(body).toContain('call no_reply')
    expect(body).toContain('start_helper')
    expect(body).toContain('[UPDATE DATA')
  })

  it("opts in to the ChatGPT plan by default: a free user's home turn goes ahead (its rebuild runs it on their plan)", async () => {
    const { checkUsageLimits } = await import('@/lib/ai/auth')
    const { client } = memDb(baseSeed())
    await planHomeTurn(client, DATA)
    expect(checkUsageLimits).toHaveBeenCalledWith(DATA.userId, undefined, { chatgptPlan: true })
  })

  it('skips (and records) over the usage limit; a failed check skips without a record', async () => {
    const { client } = memDb(baseSeed())
    const limited = await planHomeTurn(client, DATA, { checkUsage: async () => { throw new Response('limit', { status: 429 }) } })
    expect(limited).toMatchObject({ ok: false, reason: 'usage_limited', record: expect.anything() })
    const broken = await planHomeTurn(client, DATA, { checkUsage: async () => { throw new Error('boom') } })
    expect(broken).toEqual({ ok: false, reason: 'usage_check_failed' })
  })
})

// ── Claim: dedupe ────────────────────────────────────────────────────────────

describe('claimHomeTurn: one home turn per conversation at a time (the lease)', () => {
  const DIGEST_DATA: HomeTurnRequestedData = { ...DATA, workItemIds: [], reason: 'digest', digestDate: '2026-10-14', eventIds: ['7'] }
  const digestPlan: HomeTurnPlan = {
    ok: true,
    sessionId: 'sess-home',
    fromIndex: 0,
    reports: [],
    workItemIds: [],
    dedupeKey: 'digest:2026-10-14',
    digest: { date: '2026-10-14', timeZone: 'UTC', counts: ['1 failed'], lines: ['- x'], eventIds: ['7'] },
  }
  const holder = (status: string, minutesAgo: number) => ({
    id: 'holder',
    conversation_id: CONV,
    user_id: USER,
    reason: 'helper_report',
    dedupe_key: 'helper_report:abc',
    status,
    report_message_ids: [],
    created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    updated_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  })

  it('a digest never overlaps a helper report: busy while the report turn is claimed or sent, claimed once it is done', async () => {
    for (const status of ['claimed', 'sent']) {
      const db = memDb(baseSeed({ turns: [holder(status, 1)] }))
      expect(await claimHomeTurn(db.client, DIGEST_DATA, digestPlan)).toEqual({ kind: 'busy', holder: 'holder' })
      expect(db.tables.home_turn).toHaveLength(1)
      db.tables.home_turn[0].status = 'done'
      expect((await claimHomeTurn(db.client, DIGEST_DATA, digestPlan)).kind).toBe('claimed')
    }
  })

  it('and the other way round: a report waits for the digest turn', async () => {
    const db = memDb(baseSeed())
    expect((await claimHomeTurn(db.client, DIGEST_DATA, digestPlan)).kind).toBe('claimed')
    const plan = (await planHomeTurn(db.client, DATA)) as HomeTurnPlan
    expect(await claimHomeTurn(db.client, DATA, plan)).toMatchObject({ kind: 'busy' })
  })

  it('a holder no step touched for a while (its run died) holds nothing', async () => {
    const db = memDb(baseSeed({ turns: [holder('sent', 30)] }))
    expect((await claimHomeTurn(db.client, DIGEST_DATA, digestPlan)).kind).toBe('claimed')
  })

  it('two claims that race past the check: the newer gives way (failed lease_busy, claimable again)', async () => {
    const db = memDb(baseSeed({ turns: [holder('claimed', 1)] }))
    // The first lease read misses the holder (it landed in between).
    let first = true
    const empty: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'order', 'limit']) empty[m] = () => empty
    empty.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve)
    const racing = {
      from: (t: string) => {
        if (t === 'home_turn' && first) {
          first = false
          return empty
        }
        return (db.client as unknown as { from: (t: string) => unknown }).from(t)
      },
    } as never
    expect(await claimHomeTurn(racing, DIGEST_DATA, digestPlan)).toEqual({ kind: 'busy', holder: 'holder' })
    const mine = db.tables.home_turn.find((r) => r.dedupe_key === 'digest:2026-10-14')!
    expect(mine).toMatchObject({ status: 'failed', error: 'lease_busy' })
    // Once the holder is done, the same claim is taken again.
    db.tables.home_turn.find((r) => r.id === 'holder')!.status = 'done'
    expect((await claimHomeTurn(db.client, DIGEST_DATA, digestPlan)).kind).toBe('claimed')
  })
})

describe('claimHomeTurn', () => {
  it('claims once; another run’s live row is a duplicate (never two readers), a stale one resumes, a settled one is a duplicate', async () => {
    const db = memDb(baseSeed())
    const plan = (await planHomeTurn(db.client, DATA)) as HomeTurnPlan
    const first = await claimHomeTurn(db.client, DATA, plan)
    expect(first.kind).toBe('claimed')
    expect(db.tables.home_turn).toHaveLength(1)
    expect(db.tables.home_turn[0]).toMatchObject({ status: 'claimed', dedupe_key: plan.dedupeKey, eve_session_id: 'sess-home' })

    // Touched just now: another run holds it.
    expect(await claimHomeTurn(db.client, DATA, plan)).toEqual({ kind: 'duplicate', status: 'claimed' })
    db.tables.home_turn[0].status = 'sent'
    expect(await claimHomeTurn(db.client, DATA, plan)).toEqual({ kind: 'duplicate', status: 'sent' })
    // Untouched past the lease: its run died, this one resumes it.
    db.tables.home_turn[0].updated_at = new Date(Date.now() - 7 * 60_000).toISOString()
    expect(await claimHomeTurn(db.client, DATA, plan)).toMatchObject({ kind: 'resumed', row: { id: (first as { row: HomeTurnRow }).row.id } })
    db.tables.home_turn[0].status = 'done'
    expect(await claimHomeTurn(db.client, DATA, plan)).toEqual({ kind: 'duplicate', status: 'done' })
    expect(db.tables.home_turn).toHaveLength(1)
  })

  it('a row that failed before eve accepted anything is claimed again; one that may have landed is not', async () => {
    const db = memDb(baseSeed())
    const plan = (await planHomeTurn(db.client, DATA)) as HomeTurnPlan
    await claimHomeTurn(db.client, DATA, plan)
    Object.assign(db.tables.home_turn[0], { status: 'failed', error: 'send_refused_503', stream_position: 4 })
    expect(await claimHomeTurn(db.client, DATA, plan)).toMatchObject({ kind: 'claimed' })
    expect(db.tables.home_turn[0]).toMatchObject({ status: 'claimed', error: null, stream_position: null })
    Object.assign(db.tables.home_turn[0], { status: 'failed', error: 'send_failed' })
    expect(await claimHomeTurn(db.client, DATA, plan)).toEqual({ kind: 'duplicate', status: 'failed' })
  })
})

// ── Send + read + finish ─────────────────────────────────────────────────────

async function claimed() {
  const db = memDb(baseSeed())
  const plan = (await planHomeTurn(db.client, DATA)) as HomeTurnPlan
  const claim = (await claimHomeTurn(db.client, DATA, plan)) as { row: HomeTurnRow }
  return { db, plan, row: claim.row }
}

describe('homeTurnToken: why a home turn was minted', () => {
  it.each(['helper_report', 'event', 'digest', 'guest_ask', 'agent_answer', 'approval'] as const)('a %s turn\'s token carries its reason', (reason) => {
    expect(verifyChatRunToken(homeTurnToken({ ...DATA, reason }))).toMatchObject({ server: 'home_turn', homeTurnReason: reason })
  })

  it('a channel turn\'s token is a channel_turn\'s, with no home-turn reason', () => {
    const claims = verifyChatRunToken(homeTurnToken({ ...DATA, reason: 'text' }))
    expect(claims).toMatchObject({ server: 'channel_turn', surface: 'sms' })
    expect(claims?.homeTurnReason).toBeUndefined()
  })
})

describe('sendHomeTurn', () => {
  it("on the person's own ChatGPT plan: the plan says so and the send's token carries the claim (a spec outage keeps the turn on their plan)", async () => {
    const db = memDb(baseSeed())
    const plan = (await planHomeTurn(db.client, DATA, { checkUsage: async () => ({ allowed: true, reason: 'chatgpt_plan' }) })) as HomeTurnPlan
    expect(plan.chatgptPlan).toBe(true)
    const claim = (await claimHomeTurn(db.client, DATA, plan)) as { row: HomeTurnRow }
    const eve = scriptedSession(ownTurn(homeTurnTag(claim.row.id)))
    await sendHomeTurn(db.client, DATA, plan, claim.row, { makeClient: eve.makeClient, budgetMs: 1000 })
    expect(verifyChatRunToken(eve.tokens[0])).toMatchObject({ server: 'home_turn', chatgptPlan: true })
    // A paid person's plan and token never do.
    const paid = (await planHomeTurn(memDb(baseSeed()).client, DATA, { checkUsage: async () => ({ allowed: true, reason: 'subscription' }) })) as HomeTurnPlan
    expect(paid.chatgptPlan).toBeUndefined()
  })

  it('sends exactly once, queued, as the home-turn server principal, then reads the turn', async () => {
    const { db, plan, row } = await claimed()
    const eve = scriptedSession(ownTurn(homeTurnTag(row.id)))
    const out = await sendHomeTurn(db.client, DATA, plan, row, { makeClient: eve.makeClient, budgetMs: 1000 })
    expect(eve.sends).toHaveLength(1)
    expect(eve.sends[0].options).toEqual({ turnPolicy: 'queue' })
    expect(String(eve.sends[0].message)).toContain(homeTurnTag(row.id))
    expect(String(eve.sends[0].message)).toContain('call no_reply')
    const claims = verifyChatRunToken(eve.tokens[0])
    // It says why it was minted: only some background updates act on their own (chat-ceiling.ts).
    expect(claims).toMatchObject({ conversationId: CONV, userId: USER, workspaceId: WS, server: 'home_turn', homeTurnReason: 'helper_report' })
    expect(claims?.cred).toBeUndefined()
    expect(claims?.chatgptPlan).toBeUndefined()
    // The send carries the turn-long token (its tools, and a later compaction recall, present it).
    expect(Math.abs(claims!.exp - Date.now() - HOME_TURN_TOKEN_TTL_MS)).toBeLessThan(5_000)
    expect(eve.attaches[0]).toEqual({ id: 'sess-home', streamIndex: 0 })
    expect(db.tables.home_turn[0]).toMatchObject({ status: 'sent', stream_position: 0 })
    expect(out).toMatchObject({ kind: 'read', result: { done: true, end: 'completed' } })

    // A retried step finds the row sent: it reads again and never re-sends.
    const retry = await sendHomeTurn(db.client, DATA, plan, row, { makeClient: eve.makeClient, budgetMs: 1000 })
    expect(eve.sends).toHaveLength(1)
    expect(retry).toMatchObject({ kind: 'read', result: { done: true, end: 'completed' } })
  })

  it('a digest plan sends the digest body (A6 slice 4), keyed on its day', async () => {
    const db = memDb(baseSeed({ reports: [] }))
    const digestData: HomeTurnRequestedData = { ...DATA, workItemIds: [], reason: 'digest', digestDate: '2026-10-14', eventIds: ['7'] }
    const plan: HomeTurnPlan = {
      ok: true,
      sessionId: 'sess-home',
      fromIndex: 0,
      reports: [],
      workItemIds: [],
      dedupeKey: 'digest:2026-10-14',
      digest: { date: '2026-10-14', timeZone: 'Europe/London', counts: ['1 waiting on you'], lines: ['- 2026-10-14 07:10 Ready for your review: Prospects'], eventIds: ['7'] },
    }
    const claim = await claimHomeTurn(db.client, digestData, plan)
    expect(claim.kind).toBe('claimed')
    expect(db.tables.home_turn[0]).toMatchObject({ reason: 'digest', dedupe_key: 'digest:2026-10-14', report_message_ids: [], work_item_ids: [] })
    const row = (claim as { row: HomeTurnRow }).row
    const eve = scriptedSession(ownTurn(homeTurnTag(row.id)))
    await sendHomeTurn(db.client, digestData, plan, row, { makeClient: eve.makeClient, budgetMs: 1000 })
    const message = String(eve.sends[0].message)
    expect(message).toContain('Daily digest')
    expect(message).toContain('1 waiting on you')
    expect(message).toContain('Ready for your review: Prospects')
    expect(eve.sends[0].options).toEqual({ turnPolicy: 'queue' })
  })

  it('the turn bills as an ordinary ai_chat turn to the person, through the token (not a surface)', async () => {
    const { db, plan, row } = await claimed()
    const eve = scriptedSession(ownTurn(homeTurnTag(row.id)))
    await sendHomeTurn(db.client, DATA, plan, row, { makeClient: eve.makeClient, budgetMs: 1000 })
    const { resolveChatUsagePayer } = await import('@/lib/chat/chat-usage-meter')
    expect(await resolveChatUsagePayer(db.client, eve.tokens[0], { sessionId: 'sess-home' })).toEqual({
      kind: 'payer',
      payer: { userId: USER, conversationId: CONV, workspaceId: WS, via: 'token' },
    })
  })

  it('reads from the plan’s tail index, written with the move to sent (before the send)', async () => {
    const { db, plan, row } = await claimed()
    const earlier = [ev('turn.started', {}, ['x']), ev('turn.completed', {}, ['x']), ev('session.waiting', {}, ['x'])]
    let atSend: Row | null = null
    const eve = scriptedSession([...earlier, ...ownTurn(homeTurnTag(row.id))], { onSend: () => (atSend = { ...db.tables.home_turn[0] }) })
    const out = await sendHomeTurn(db.client, DATA, { ...plan, fromIndex: 3 }, row, { makeClient: eve.makeClient, budgetMs: 1000 })
    expect(atSend).toMatchObject({ status: 'sent', stream_position: 3 })
    expect(eve.attaches[0].streamIndex).toBe(3)
    expect(out).toMatchObject({ kind: 'read', result: { done: true, end: 'completed', state: { nextIndex: 9 } } })
  })

  it('a failed move to sent fails the step: nothing is sent', async () => {
    const { db, plan, row } = await claimed()
    const eve = scriptedSession(ownTurn(homeTurnTag(row.id)))
    const realFrom = (db.client as unknown as { from: (t: string) => Record<string, unknown> }).from
    const broken = {
      from: (table: string) => ({
        ...realFrom(table),
        update: () => ({ eq: () => ({ eq: () => ({ select: async () => ({ data: null, error: { message: 'down' } }) }) }) }),
      }),
    }
    await expect(sendHomeTurn(broken as never, DATA, plan, row, { makeClient: eve.makeClient })).rejects.toThrow(/down/)
    expect(eve.sends).toHaveLength(0)
  })

  it('attributes by the delivery id the send returned: a tagless turn of its own is found, another turn is not', async () => {
    const { db, plan, row } = await claimed()
    const other = [ev('turn.started', {}, ['d-person']), ev('message.appended', { messageDelta: 'not mine' }, ['d-person']), ev('turn.completed', {}, ['d-person'])]
    // The message text carries no tag here: only the delivery id finds it.
    const mine = ownTurn('no-tag-at-all', 'd-own')
    const eve = scriptedSession([...other, ...mine], { deliveryId: 'd-own' })
    const out = (await sendHomeTurn(db.client, DATA, plan, row, { makeClient: eve.makeClient, budgetMs: 1000 })) as { result: HomeTurnReadResult }
    expect(out.result).toMatchObject({ done: true, end: 'completed' })
    expect(out.result.state.parts.parts).toEqual([{ type: 'text', text: 'Your researcher has a question: which region?' }])
  })

  it('a refused send fails the row and sends nothing more', async () => {
    const { db, plan, row } = await claimed()
    const { ClientError } = await import('eve/client')
    const eve = scriptedSession([], { sendError: new ClientError(403, JSON.stringify({ code: 'server_send_not_home' })) })
    const out = await sendHomeTurn(db.client, DATA, plan, row, { makeClient: eve.makeClient, budgetMs: 1000 })
    expect(out).toMatchObject({ kind: 'failed' })
    expect(db.tables.home_turn[0]).toMatchObject({ status: 'failed' })
  })

  it('a row left sent with no position (an older write) stops the run, never re-sends', async () => {
    const { db, plan, row } = await claimed()
    db.tables.home_turn[0].status = 'sent'
    const eve = scriptedSession([])
    expect(await sendHomeTurn(db.client, DATA, plan, row, { makeClient: eve.makeClient })).toEqual({ kind: 'failed', error: 'send_unconfirmed' })
    expect(eve.sends).toHaveLength(0)
  })
})

describe('readHomeTurnEvents: the input-budget prompt never waits on a button', () => {
  const budget = (requestId: string, kind = 'session-limit') =>
    ev('input.requested', { requests: [{ kind, requestId, action: { callId: requestId, kind: 'tool-call', toolName: 'session_limit_continuation', input: {} } }] }, ['d-own'])

  it('answers Continue on eve’s input budget once, and reads the turn on to its end', async () => {
    const tag = homeTurnTag('r9')
    const own = ownTurn(tag)
    const events = [...own.slice(0, 2), budget('wrun_1:3:limit:input:40000100'), ...own.slice(2)]
    const continued: string[] = []
    const out = await readHomeTurnEvents((async function* () { for (const e of events) yield e })(), 'r9', newHomeTurnReadState('r9', 0), undefined, async (id) => {
      continued.push(id)
    })
    expect(continued).toEqual(['wrun_1:3:limit:input:40000100'])
    expect(out).toMatchObject({ done: true, end: 'completed' })
  })

  it('never another limit, a question or an approval; a failed answer leaves the turn parked, no throw', async () => {
    expect(inputBudgetRequestIds(budget('wrun_1:3:limit:output:150001'))).toEqual([])
    expect(inputBudgetRequestIds(budget('wrun_1:3:limit:token-cost:5.01'))).toEqual([])
    expect(inputBudgetRequestIds(budget('wrun_1:3:limit:input:1', 'tool-approval'))).toEqual([])
    expect(inputBudgetRequestIds(ev('message.appended', { messageDelta: 'x' }))).toEqual([])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tag = homeTurnTag('r10')
    const events = [...ownTurn(tag).slice(0, 2), budget('wrun_1:3:limit:input:40000100')]
    const out = await readHomeTurnEvents((async function* () { for (const e of events) yield e })(), 'r10', newHomeTurnReadState('r10', 0), undefined, async () => {
      throw new Error('403')
    })
    expect(out.done).toBe(false)
    warn.mockRestore()
  })
})

describe('readHomeTurnEvents: attribution', () => {
  it('skips the turn it queued behind, and stops at the first event of another delivery', async () => {
    const tag = homeTurnTag('r1')
    const events = [
      ev('turn.started', {}, ['d-person']),
      ev('message.appended', { messageDelta: 'the person’s own reply' }, ['d-person']),
      ev('turn.completed', {}, ['d-person']),
      ...ownTurn(tag).slice(0, 4),
      // The person typed: their message folds in, the rest is theirs.
      ev('message.received', { message: 'actually, stop' }, ['d-own', 'd-person2']),
      ev('message.appended', { messageDelta: ' and more' }, ['d-own', 'd-person2']),
    ]
    async function* src() {
      for (const e of events) yield e
    }
    const out = await readHomeTurnEvents(src(), 'r1', newHomeTurnReadState('r1', 0))
    expect(out).toMatchObject({ done: true, end: 'steered' })
    const parts = out.state.parts.parts
    expect(parts).toEqual([{ type: 'text', text: 'Your researcher has a question: which region?' }])
    expect(out.state.ownDeliveryIds).toEqual(['d-own'])
  })

  it('a recorded folded steer: the reply after the fold is never the server’s', async () => {
    const recorded = (fixtures as unknown as Record<string, HandleMessageStreamEvent[]>).steerFoldedIntoSameTurn
    const tag = homeTurnTag('r2')
    // Our message is the first one received in the recording.
    const events = recorded.map((e, i) =>
      i === 1 ? ({ ...e, data: { ...(e as { data: object }).data, message: `${tag} ${(e as { data: { message: string } }).data.message}` } } as HandleMessageStreamEvent) : e,
    )
    async function* src() {
      for (const e of events) yield e
    }
    const out = await readHomeTurnEvents(src(), 'r2', newHomeTurnReadState('r2', 0))
    expect(out).toMatchObject({ done: true, end: 'steered' })
    expect(out.state.parts.parts).toEqual([])
  })

  it('a message folded in from the very start is not the server’s at all', () => {
    const e = ev('message.received', { message: `${homeTurnTag('r3')} hi` }, ['d-own', 'd-other'])
    expect(attributeHomeTurnEvent(e, homeTurnTag('r3'), null, false).verdict).toBe('foreign')
    expect(attributeHomeTurnEvent(ev('message.received', { message: 'someone else' }, ['z']), homeTurnTag('r3'), null, false).verdict).toBe('before')
    // Known by delivery id: a first own event that also carries another id is foreign too.
    expect(attributeHomeTurnEvent(ev('turn.started', {}, ['d-own', 'd-p']), 'x', ['d-own'], false)).toMatchObject({ verdict: 'foreign', seenOwn: true })
    expect(attributeHomeTurnEvent(ev('turn.started', {}, ['d-p']), 'x', ['d-own'], false)).toMatchObject({ verdict: 'before', seenOwn: false })
  })

  it('an input-budget prompt in the turn is answered Continue with the SEND token, on the send step and on a later read step', async () => {
    const { db, plan, row } = await claimed()
    const id = 'wrun_1:9:limit:input:40000100'
    const prompt = ev('input.requested', { requests: [{ kind: 'session-limit', requestId: id, action: { callId: id, kind: 'tool-call', toolName: 'session_limit_continuation', input: {} } }] }, ['d-own'])
    const own = ownTurn(homeTurnTag(row.id))
    const events = [...own.slice(0, 3), prompt, ...own.slice(3)]
    const sent = scriptedSession(events)
    const out = await sendHomeTurn(db.client, DATA, plan, row, { makeClient: sent.makeClient, budgetMs: 1000 })
    expect(out).toMatchObject({ kind: 'read', result: { done: true, end: 'completed' } })
    expect(sent.responds).toEqual([{ responses: [{ requestId: id, optionId: 'continue' }], token: sent.tokens[0] }])
    // A read step answers through a session of its own, made with the send token (never the short read one).
    const read = scriptedSession(events)
    await continueHomeTurn(db.client, DATA, plan, row, newHomeTurnReadState(row.id, 0), { makeClient: read.makeClient, budgetMs: 1000 })
    expect(read.responds).toHaveLength(1)
    const respondToken = read.responds[0].token
    expect(respondToken).not.toBe(read.tokens[0])
    expect(Math.abs(verifyChatRunToken(respondToken)!.exp - Date.now() - HOME_TURN_READ_TOKEN_TTL_MS)).toBeGreaterThan(5_000)
  })

  it('a budget cut hands back the cursor; the next step continues to the same parts', async () => {
    const { db, plan, row } = await claimed()
    const events = ownTurn(homeTurnTag(row.id))
    const cut = scriptedSession(events.slice(0, 4), { stall: true })
    const first = await sendHomeTurn(db.client, DATA, plan, row, { makeClient: cut.makeClient, budgetMs: 20 })
    expect(first).toMatchObject({ kind: 'read', result: { done: false, state: { nextIndex: 4 } } })
    const state = JSON.parse(JSON.stringify((first as { result: HomeTurnReadResult }).result.state))
    const rest = scriptedSession(events)
    const second = await continueHomeTurn(db.client, DATA, plan, row, state, { makeClient: rest.makeClient, budgetMs: 1000 })
    expect(rest.attaches[0].streamIndex).toBe(4)
    expect(rest.sends).toHaveLength(0)
    // A read step mints a short token of its own.
    expect(Math.abs(verifyChatRunToken(rest.tokens[0])!.exp - Date.now() - HOME_TURN_READ_TOKEN_TTL_MS)).toBeLessThan(5_000)
    const whole = await readHomeTurnEvents((async function* () { for (const e of events) yield e })(), row.id, newHomeTurnReadState(row.id, 0))
    expect((second as { result: HomeTurnReadResult }).result.state.parts.parts).toEqual(whole.state.parts.parts)
    expect(db.tables.home_turn[0]).toMatchObject({ eve_turn_id: 'turn_9', stream_position: 0 })
  })
})

describe('finishHomeTurn', () => {
  async function readWith(reply: string) {
    const { db, plan, row } = await claimed()
    const eve = scriptedSession(ownTurn(homeTurnTag(row.id), 'd-own', reply))
    const sent = (await sendHomeTurn(db.client, DATA, plan, row, { makeClient: eve.makeClient, budgetMs: 1000 })) as { result: HomeTurnReadResult }
    return { db, row, read: sent.result }
  }

  it('writes the reply as home-turn:<row>, kind home_turn, and settles the row done', async () => {
    const { db, row, read } = await readWith('Your researcher has a question: which region?')
    const out = await finishHomeTurn(db.client, DATA, row, read)
    expect(out).toEqual({ outcome: 'written', written: true })
    const written = db.tables.chat_messages.find((m) => (m.ui_message as { id: string }).id === `home-turn:${row.id}`)
    expect(written).toBeTruthy()
    expect((written!.ui_message as { metadata: Row }).metadata).toMatchObject({ kind: HOME_TURN_KIND, home_turn_id: row.id, eve_turn_id: 'turn_9', eve_written: true })
    // The cursor after turn.completed: where the next home turn on this session reads from.
    expect(db.tables.home_turn[0]).toMatchObject({ status: 'done', message_written: true, stream_position: 6, error: null })
    expect(signal).toHaveBeenCalledWith({ conversationId: CONV, workspaceId: WS, userId: USER, source: 'turn' })
  })

  it('carries the label its line names it by (the chat\'s day lines)', async () => {
    const { db, row, read } = await readWith('Your evening brief is ready.')
    await finishHomeTurn(db.client, DATA, row, read, 'Evening Brief')
    const written = db.tables.chat_messages.find((m) => (m.ui_message as { id: string }).id === `home-turn:${row.id}`)
    expect((written!.ui_message as { metadata: Row }).metadata).toMatchObject({ label: 'Evening Brief' })
  })

  it('stamps a report that is only meeting preps prep_only (the router banners it, never texts it); others carry no mark', async () => {
    const { db, row, read } = await readWith('Your prep for the 12:00 PM meeting is ready.')
    await finishHomeTurn(db.client, DATA, row, read, 'Prep', { prepOnly: true })
    const written = db.tables.chat_messages.find((m) => (m.ui_message as { id: string }).id === `home-turn:${row.id}`)
    expect((written!.ui_message as { metadata: Row }).metadata).toMatchObject({ prep_only: true })
    const other = await readWith('Your evening brief is ready.')
    await finishHomeTurn(other.db.client, DATA, other.row, other.read)
    const plain = other.db.tables.chat_messages.find((m) => (m.ui_message as { id: string }).id === `home-turn:${other.row.id}`)
    expect((plain!.ui_message as { metadata: Row }).metadata).not.toHaveProperty('prep_only')
    expect((plain!.ui_message as { metadata: Row }).metadata).not.toHaveProperty('ended_quiet')
  })

  it('a quiet home turn: the agent narrates a line, calls no_reply, and no chat message is written', async () => {
    const { db, plan, row } = await claimed()
    const tag = homeTurnTag(row.id)
    const events = ownTurn(tag, 'd-own', 'Nothing here needs them right now.')
    const at = events.findIndex((e) => e.type === 'turn.completed')
    // eve's no_reply (endsTurn): the call and its result, then the turn completes with no final message.
    events.splice(
      at,
      0,
      ev('actions.requested', { turnId: 'turn_9', actions: [{ kind: 'tool-call', callId: 'nr-1', toolName: 'no_reply', input: { reason: 'routine progress' } }] }, ['d-own']),
      ev('action.result', { turnId: 'turn_9', result: { kind: 'tool-result', callId: 'nr-1', toolName: 'no_reply', output: { ended: true } } }, ['d-own']),
    )
    const eve = scriptedSession(events)
    const sent = (await sendHomeTurn(db.client, DATA, plan, row, { makeClient: eve.makeClient, budgetMs: 1000 })) as { result: HomeTurnReadResult }
    const before = db.tables.chat_messages.length
    // The narration went to nobody: its length (never its text) rides the log line.
    const narrationChars = 'Nothing here needs them right now.'.length
    expect(await finishHomeTurn(db.client, DATA, row, sent.result)).toEqual({ outcome: 'quiet', written: false, narrationChars })
    expect(db.tables.chat_messages).toHaveLength(before)
    expect(db.tables.home_turn[0]).toMatchObject({ status: 'done', message_written: false })
    expect(homeTurnLogLine({ conversationId: CONV, rowId: row.id, reports: 1, outcome: 'quiet', narrationChars })).toMatch(
      new RegExp(`outcome=quiet narration=${narrationChars}$`),
    )
    expect(homeTurnLogLine({ conversationId: CONV, outcome: 'quiet' })).not.toContain('narration=')
  })

  it('a turn that went on to speak after a no_reply writes its reply, without the no_reply call in it', async () => {
    const { db, plan, row } = await claimed()
    const events = ownTurn(homeTurnTag(row.id), 'd-own', 'The research run failed: the site blocked it. Want me to retry?')
    const at = events.findIndex((e) => e.type === 'step.started')
    // A refused or side-by-side no_reply first, then the model speaks.
    events.splice(
      at + 1,
      0,
      ev('actions.requested', { turnId: 'turn_9', actions: [{ kind: 'tool-call', callId: 'nr-2', toolName: 'no_reply', input: {} }] }, ['d-own']),
      ev('action.result', { turnId: 'turn_9', result: { kind: 'tool-result', callId: 'nr-2', toolName: 'no_reply', output: { ended: false, note: 'Not available' } } }, ['d-own']),
    )
    const eve = scriptedSession(events)
    const sent = (await sendHomeTurn(db.client, DATA, plan, row, { makeClient: eve.makeClient, budgetMs: 1000 })) as { result: HomeTurnReadResult }
    expect(await finishHomeTurn(db.client, DATA, row, sent.result)).toEqual({ outcome: 'written', written: true })
    const written = db.tables.chat_messages.find((m) => (m.ui_message as { id: string }).id === `home-turn:${row.id}`)
    const parts = (written!.ui_message as { parts: Array<{ type: string; toolName?: string }> }).parts
    expect(parts.some((p) => p.toolName === 'no_reply')).toBe(false)
    expect(parts.some((p) => p.type === 'text')).toBe(true)
  })

  it('a turn that marked its message urgent writes urgent_by and urgent_why, and never the mark_urgent call (part D)', async () => {
    const { db, plan, row } = await claimed()
    const events = ownTurn(homeTurnTag(row.id), 'd-own', 'Jess moved the 9:00 call with Ken to 8:30.')
    const at = events.findIndex((e) => e.type === 'step.started')
    events.splice(
      at + 1,
      0,
      ev('actions.requested', { turnId: 'turn_9', actions: [{ kind: 'tool-call', callId: 'mu-1', toolName: 'mark_urgent', input: { by: '2026-11-01T09:00:00-05:00', why: 'the call is first thing' } }] }, ['d-own']),
      ev('action.result', { turnId: 'turn_9', result: { kind: 'tool-result', callId: 'mu-1', toolName: 'mark_urgent', output: { marked: true, by: '2026-11-01T09:00:00-05:00' } } }, ['d-own']),
    )
    const eve = scriptedSession(events)
    const sent = (await sendHomeTurn(db.client, DATA, plan, row, { makeClient: eve.makeClient, budgetMs: 1000 })) as { result: HomeTurnReadResult }
    expect(await finishHomeTurn(db.client, DATA, row, sent.result)).toEqual({ outcome: 'written', written: true })
    const written = db.tables.chat_messages.find((m) => (m.ui_message as { id: string }).id === `home-turn:${row.id}`)
    const ui = written!.ui_message as { parts: Array<{ type: string; toolName?: string }>; metadata: Row }
    expect(ui.metadata).toMatchObject({ urgent_by: '2026-11-01T09:00:00-05:00', urgent_why: 'the call is first thing' })
    expect(ui.parts.some((p) => p.toolName === 'mark_urgent')).toBe(false)
    expect(ui.parts.some((p) => p.type === 'text')).toBe(true)
  })

  it('a refused mark (a person’s turn) writes no urgency', async () => {
    const { db, plan, row } = await claimed()
    const events = ownTurn(homeTurnTag(row.id), 'd-own', 'Done.')
    const at = events.findIndex((e) => e.type === 'step.started')
    events.splice(
      at + 1,
      0,
      ev('actions.requested', { turnId: 'turn_9', actions: [{ kind: 'tool-call', callId: 'mu-2', toolName: 'mark_urgent', input: { by: '2026-11-01T09:00:00-05:00' } }] }, ['d-own']),
      ev('action.result', { turnId: 'turn_9', result: { kind: 'tool-result', callId: 'mu-2', toolName: 'mark_urgent', output: { marked: false, note: 'Not available' } } }, ['d-own']),
    )
    const sent = (await sendHomeTurn(db.client, DATA, plan, row, { makeClient: scriptedSession(events).makeClient, budgetMs: 1000 })) as { result: HomeTurnReadResult }
    await finishHomeTurn(db.client, DATA, row, sent.result)
    const written = db.tables.chat_messages.find((m) => (m.ui_message as { id: string }).id === `home-turn:${row.id}`)
    expect((written!.ui_message as { metadata: Row }).metadata).not.toHaveProperty('urgent_by')
  })

  it.each([['[quiet]'], ['  [quiet]  ']])('a reply of %j (the old marker, still in old sessions) writes nothing', async (reply) => {
    const { db, row, read } = await readWith(reply)
    const before = db.tables.chat_messages.length
    expect(await finishHomeTurn(db.client, DATA, row, read)).toEqual({ outcome: 'quiet', written: false })
    expect(db.tables.chat_messages).toHaveLength(before)
    expect(db.tables.home_turn[0]).toMatchObject({ status: 'done', message_written: false })
  })

  it('an empty reply writes nothing; a read that never finished writes nothing either', async () => {
    const { db, row } = await claimed()
    const empty: HomeTurnReadResult = { done: true, end: 'completed', state: newHomeTurnReadState(row.id, 0) }
    const before = db.tables.chat_messages.length
    expect((await finishHomeTurn(db.client, DATA, row, empty)).outcome).toBe('quiet')
    const unfinished: HomeTurnReadResult = { done: false, state: newHomeTurnReadState(row.id, 0) }
    expect((await finishHomeTurn(db.client, DATA, row, unfinished)).outcome).toBe('watch_exhausted')
    expect(db.tables.chat_messages).toHaveLength(before)
  })
})

describe('the session tail (peekSessionTail) and the park check', () => {
  it('reads the tail as the server principal in one bounded request, and parses the index and events', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const lines = ['', JSON.stringify(ev('turn.completed', {}, ['a'])), '', JSON.stringify(ev('session.waiting', {}, ['a'])), '']
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(lines.join('\n'), { headers: { 'x-eve-stream-tail-index': '57' } })
    }) as unknown as typeof fetch
    const tail = await peekSessionTail(DATA, 'sess/home', { fetch: fakeFetch })
    expect(tail.tailIndex).toBe(57)
    expect(tail.events.map((e) => e.type)).toEqual(['turn.completed', 'session.waiting'])
    expect(calls[0].url).toMatch(/\/eve\/chat-agent\/v1\/session\/sess%2Fhome\/stream\?startIndex=-1000&includeTailIndex=1$/)
    expect(calls[0].init.redirect).toBe('error')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers['x-chat-run-secret']).toBe('chat-internal-secret-0123456789')
    expect(verifyChatRunToken(headers['x-chat-run-token'])).toMatchObject({ server: 'home_turn', conversationId: CONV })
  })

  it('throws (the plan step retries) on a refusal or a missing tail index', async () => {
    const refused = (async () => new Response('no', { status: 403 })) as unknown as typeof fetch
    await expect(peekSessionTail(DATA, 's', { fetch: refused })).rejects.toThrow(/403/)
    const noHeader = (async () => new Response('')) as unknown as typeof fetch
    await expect(peekSessionTail(DATA, 's', { fetch: noHeader })).rejects.toThrow(/tail index/)
  })

  it('hasOpenInputRequest: an unanswered request is open; a resolution, a settle, a cancel closes it', () => {
    const req = ev('input.requested', { requests: [{ requestId: 'q1' }] })
    expect(hasOpenInputRequest([req])).toBe(true)
    expect(hasOpenInputRequest([req, ev('turn.completed', {}), ev('turn.started', {})])).toBe(true)
    expect(hasOpenInputRequest([req, ev('input.resolved', { resolutions: [{ requestId: 'q1' }] })])).toBe(false)
    expect(hasOpenInputRequest([req, ev('approval.settled', { requestId: 'q1' })])).toBe(false)
    expect(hasOpenInputRequest([req, ev('turn.cancelled', {})])).toBe(false)
    expect(hasOpenInputRequest([])).toBe(false)
  })

  it('hasOpenInputRequest: a request asked before a turn the person started never blocks a home turn (they moved on past the picker)', () => {
    const req = ev('input.requested', { requests: [{ requestId: 'q1' }] })
    const started = ev('turn.started', {})
    const typed = ev('message.received', { message: 'never mind, do the other thing' })
    expect(hasOpenInputRequest([req, started, typed])).toBe(false)
    expect(hasOpenInputRequest([req, started, typed, ev('turn.completed', {})])).toBe(false)
    // A question asked AFTER the person's message, in their new turn, is open.
    expect(hasOpenInputRequest([req, started, typed, ev('input.requested', { requests: [{ requestId: 'q2' }] })])).toBe(true)
    // A home turn's own message (a background update) is not the person's.
    const update = ev('message.received', { message: `[BACKGROUND UPDATE · ${homeTurnTag('row-1')}] Not from the person: Native Intelligence sent this on its own, and nobody typed it.` })
    expect(hasOpenInputRequest([req, started, update])).toBe(true)
  })

  it('hasOpenInputRequest: a relayed answer (a mid-turn message.received) clears nothing else', () => {
    const asked = ev('input.requested', { requests: [{ requestId: 'q1' }, { requestId: 'q2' }] })
    // eve records the answer to a helper's question as message.received, then resolves only that one.
    const relayed = ev('message.received', { message: 'yes, the second one' })
    const resolved = ev('input.resolved', { resolutions: [{ requestId: 'q1' }] })
    expect(hasOpenInputRequest([ev('turn.started', {}), ev('message.received', { message: 'do it' }), asked, relayed, resolved])).toBe(true)
  })

  it('only the send carries the long token; the reads keep a short one', () => {
    expect(HOME_TURN_READ_TOKEN_TTL_MS).toBe(10 * 60_000)
    expect(HOME_TURN_READ_TOKEN_TTL_MS).toBeLessThan(HOME_TURN_TOKEN_TTL_MS)
  })

  it('the turn token covers the turn’s cap plus a later idle compaction (its profile recall posts it)', () => {
    expect(HOME_TURN_TOKEN_TTL_MS).toBe(HOME_TURN_STEP_BUDGET_MS * (HOME_TURN_MAX_READ_STEPS + 1) + HOME_TURN_COMPACTION_WINDOW_MS)
    // The hour-long turn cap (and more), plus the 10-minute quiet, its 5-minute look-again and the compaction.
    expect(HOME_TURN_TOKEN_TTL_MS).toBeGreaterThanOrEqual(60 * 60_000 + IDLE_COMPACTION_QUIET_MS + 5 * 60_000 + 3 * 60_000)
    expect(HOME_TURN_TOKEN_TTL_MS).toBeLessThanOrEqual(HOME_TURN_TOKEN_MAX_TTL_MS)
  })
})

describe('DRIFT — the eve 0.66.3 internals the home turn reads', () => {
  const eveRoot = `${process.cwd()}/node_modules/eve/dist/src`
  it('the accepted delivery id is an own Symbol(acceptedDeliveryId) on MessageResponse', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(`${eveRoot}/client/message-response.js`, 'utf8')
    expect(src).toContain('acceptedDeliveryId=Symbol(`acceptedDeliveryId`)')
    expect(src).toContain('this[acceptedDeliveryId]=e.deliveryId')
    expect(acceptedDeliveryIdOf({ [Symbol('acceptedDeliveryId')]: 'd1' })).toBe('d1')
    expect(acceptedDeliveryIdOf({})).toBeNull()
  })

  it('the stream route answers the tail index on includeTailIndex, in x-eve-stream-tail-index, inclusive', async () => {
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(`${eveRoot}/protocol/message.js`, 'utf8')).toContain('EVE_STREAM_TAIL_INDEX_HEADER=`x-eve-stream-tail-index`')
    const request = readFileSync(`${eveRoot}/eve-channel/request.js`, 'utf8')
    expect(request).toContain('searchParams.get(`includeTailIndex`);return t===`1`||t===`true`')
    // The limit is t - start + 1: the tail index is the LAST event's (the next one is tail + 1).
    expect(request).toContain('function streamEventLimit(e,t){if(t===void 0)return;let n=e===void 0?0:e<0?Math.max(0,t+1+e):e;return Math.max(0,t-n+1)}')
  })
})

// ── A home thread with no live session (it gets one, never racing the person) ─

/** An eve whose create parks a session (records each create's token), or refuses. */
function creatingEve(opts: { ids?: string[]; refuse?: Error } = {}) {
  const ids = [...(opts.ids ?? ['sess-new'])]
  const creates: string[] = []
  const makeClient = (args: { secret: string; token: string }) =>
    ({
      sessions: {
        create: async (o: unknown) => {
          creates.push(args.token)
          // A message-free create: never a first turn.
          expect(o).toEqual({})
          if (opts.refuse) throw opts.refuse
          return { session: { state: { sessionId: ids.shift() ?? 'sess-extra' } } }
        },
      },
    }) as never
  return { creates, makeClient }
}

describe('ensureHomeSession', () => {
  it('creates a parked session as the home-turn principal and registers it on a row that holds none', async () => {
    const db = memDb(baseSeed({ conv: { eve_session_id: null } }))
    const eve = creatingEve()
    expect(await ensureHomeSession(db.client, DATA, { previous: null }, { makeClient: eve.makeClient })).toEqual({ ok: true, sessionId: 'sess-new', created: true })
    expect(db.tables.chat_conversations[0].eve_session_id).toBe('sess-new')
    expect(verifyChatRunToken(eve.creates[0])).toMatchObject({ conversationId: CONV, userId: USER, workspaceId: WS, server: 'home_turn' })
  })

  it('never races the person: a session their window registered first wins, and the turn uses it', async () => {
    const db = memDb(baseSeed({ conv: { eve_session_id: 'sess-browser' } }))
    const eve = creatingEve()
    expect(await ensureHomeSession(db.client, DATA, { previous: null }, { makeClient: eve.makeClient })).toEqual({ ok: true, sessionId: 'sess-browser', created: false })
    expect(db.tables.chat_conversations[0].eve_session_id).toBe('sess-browser')
  })

  it('replaces a gone session only while the row still names it', async () => {
    const db = memDb(baseSeed({ conv: { eve_session_id: 'sess-dead' } }))
    expect(await ensureHomeSession(db.client, DATA, { previous: 'sess-dead' }, { makeClient: creatingEve().makeClient })).toMatchObject({ ok: true, sessionId: 'sess-new', created: true })
    expect(db.tables.chat_conversations[0].eve_session_id).toBe('sess-new')
    // The person's window moved the row on meanwhile: theirs stands.
    const moved = memDb(baseSeed({ conv: { eve_session_id: 'sess-browser' } }))
    expect(await ensureHomeSession(moved.client, DATA, { previous: 'sess-dead' }, { makeClient: creatingEve().makeClient })).toMatchObject({ sessionId: 'sess-browser', created: false })
    expect(moved.tables.chat_conversations[0].eve_session_id).toBe('sess-browser')
  })

  it('never writes a side chat, nor someone else’s row', async () => {
    const side = memDb(baseSeed({ conv: { eve_session_id: null, is_home: null } }))
    expect(await ensureHomeSession(side.client, DATA, { previous: null }, { makeClient: creatingEve().makeClient })).toEqual({ ok: false, reason: 'no_session' })
    expect(side.tables.chat_conversations[0].eve_session_id).toBeNull()
    const other = memDb(baseSeed({ conv: { eve_session_id: null, user_id: 'someone-else' } }))
    expect(await ensureHomeSession(other.client, DATA, { previous: null }, { makeClient: creatingEve().makeClient })).toEqual({ ok: false, reason: 'no_session' })
    expect(other.tables.chat_conversations[0].eve_session_id).toBeNull()
  })

  it('eve refusing the create (or no chat secret) is no session, never a throw', async () => {
    const { ClientError } = await import('eve/client')
    const db = memDb(baseSeed({ conv: { eve_session_id: null } }))
    const refused = creatingEve({ refuse: new ClientError(403, JSON.stringify({ code: 'server_create_not_home' })) })
    expect(await ensureHomeSession(db.client, DATA, { previous: null }, { makeClient: refused.makeClient })).toEqual({ ok: false, reason: 'no_session' })
    delete process.env.CHAT_INTERNAL_SECRET
    delete process.env.RUN_SKILL_INTERNAL_SECRET
    const none = creatingEve()
    expect(await ensureHomeSession(db.client, DATA, { previous: null }, { makeClient: none.makeClient })).toEqual({ ok: false, reason: 'no_session' })
    expect(none.creates).toHaveLength(0)
    expect(db.tables.chat_conversations[0].eve_session_id).toBeNull()
  })
})

describe('planHomeTurn: an approval turn (445)', () => {
  const APPROVAL: HomeTurnRequestedData = { conversationId: CONV, userId: USER, workspaceId: WS, workItemIds: [], reason: 'approval' }
  const held = (id: string, over: Row = {}) => ({
    id,
    tool: 'mcp__supabase__execute_sql',
    status: 'approved',
    door: 'chat',
    conversation_id: CONV,
    user_id: USER,
    workspace_id: WS,
    context: {},
    result: { success: true, content: [] },
    decided_at: new Date(Date.now() - 60_000).toISOString(),
    executed_at: new Date(Date.now() - 55_000).toISOString(),
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    home_turn_id: null,
    ...over,
  })

  it('plans the calls the person’s yes ran here that no turn carried, keyed on their ids', async () => {
    const ap1 = held('ap-1')
    const { client } = memDb({ ...baseSeed(), tool_approval: [ap1, held('ap-2', { home_turn_id: 'turn-0' }), held('ap-3', { context: { homeTurn: true } })] })
    const plan = (await planHomeTurn(client, APPROVAL)) as HomeTurnPlan
    expect(plan.ok).toBe(true)
    expect(plan.approvals).toEqual({ lines: ['approval_id ap-1 · mcp__supabase__execute_sql · ran'], approvalIds: ['ap-1'], ranAt: [ap1.executed_at] })
    expect(plan.dedupeKey).toBe(homeTurnDedupeKey('approval', ['ap-1']))
    expect(plan.reports).toEqual([])
    expect(homeTurnLabel(plan, 'approval')).toBe('After your approval')
  })

  it('nothing new when every call was carried; never in a side chat (server turns send only into the home thread)', async () => {
    expect(await planHomeTurn(memDb({ ...baseSeed(), tool_approval: [held('ap-1', { home_turn_id: 'turn-0' })] }).client, APPROVAL)).toMatchObject({ ok: false, reason: 'nothing_new' })
    expect(await planHomeTurn(memDb({ ...baseSeed({ conv: { is_home: null } }), tool_approval: [held('ap-1')] }).client, APPROVAL)).toMatchObject({ ok: false, reason: 'not_home' })
  })

  it('the person wrote after a call ran: their own turn had it, so only the calls that ran since are news', async () => {
    const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
    const said = (msAgo: number, message = 'great, now do the next one') =>
      ({ type: 'message.received', data: { message }, meta: { at: at(msAgo), id: `e-${msAgo}` } }) as unknown as HandleMessageStreamEvent
    const seed = { ...baseSeed(), tool_approval: [held('ap-1', { executed_at: at(50_000) }), held('ap-2', { executed_at: at(10_000) })] }
    // Wrote after both ran: nothing is news.
    TAIL = { tailIndex: 9, events: [said(5_000)] }
    expect(await planHomeTurn(memDb(seed).client, APPROVAL)).toMatchObject({ ok: false, reason: 'nothing_new' })
    // Wrote between them: only the second, keyed on it alone.
    TAIL = { tailIndex: 9, events: [said(30_000)] }
    const plan = (await planHomeTurn(memDb(seed).client, APPROVAL)) as HomeTurnPlan
    expect(plan.approvals?.approvalIds).toEqual(['ap-2'])
    expect(plan.dedupeKey).toBe(homeTurnDedupeKey('approval', ['ap-2']))
    // A background update is not the person writing; an older message changes nothing.
    TAIL = { tailIndex: 9, events: [said(120_000), said(1_000, '[BACKGROUND UPDATE · home-turn x] Not from the person')] }
    expect(((await planHomeTurn(memDb(seed).client, APPROVAL)) as HomeTurnPlan).approvals?.approvalIds).toEqual(['ap-1', 'ap-2'])
  })

  it('lastPersonMessageAt: the newest message the person sent, never a background update', () => {
    const ev = (message: string, at: string) => ({ type: 'message.received', data: { message }, meta: { at } }) as unknown as HandleMessageStreamEvent
    expect(lastPersonMessageAt([])).toBeNull()
    expect(lastPersonMessageAt([ev('[BACKGROUND UPDATE · home-turn r] x', '2026-10-27T12:00:00Z')])).toBeNull()
    expect(lastPersonMessageAt([ev('a', '2026-10-27T11:00:00Z'), ev('b', '2026-10-27T11:05:00Z'), ev('[BACKGROUND UPDATE · home-turn r] x', '2026-10-27T12:00:00Z')])).toBe(Date.parse('2026-10-27T11:05:00Z'))
  })

  it('autonomy off stops it, as every turn the agent takes on its own', async () => {
    const { client } = memDb({ ...baseSeed({ settings: { agent_autonomy: { mode: 'off' } } }), tool_approval: [held('ap-1')] })
    expect(await planHomeTurn(client, APPROVAL)).toMatchObject({ ok: false, reason: 'autonomy_off', record: expect.objectContaining({ dedupeKey: homeTurnDedupeKey('approval', ['ap-1']) }) })
  })
})

describe('planHomeTurn: a home thread with no live session', () => {
  const realEnsure = (db: ReturnType<typeof memDb>, eve: ReturnType<typeof creatingEve>) => (previous: string | null) =>
    ensureHomeSession(db.client, DATA, { previous }, { makeClient: eve.makeClient })

  it('no session yet: one is created and registered, and the turn is primed with the thread', async () => {
    const db = memDb(baseSeed({ conv: { eve_session_id: null } }))
    const eve = creatingEve()
    const peeked: string[] = []
    const plan = await planHomeTurn(db.client, DATA, {
      ensureSession: realEnsure(db, eve),
      peekTail: async (id) => (peeked.push(id), TAIL),
      renderPrimer: async () => '<conversation-so-far>\nUser: hi\n</conversation-so-far>',
    })
    expect(plan).toMatchObject({ ok: true, sessionId: 'sess-new', fromIndex: 0, primer: expect.stringContaining('User: hi') })
    expect(db.tables.chat_conversations[0].eve_session_id).toBe('sess-new')
    // A session this run made holds nothing: no tail read.
    expect(peeked).toEqual([])
  })

  it('a registered session with events is used as it is: no create, no primer', async () => {
    TAIL = { tailIndex: 41, events: [] }
    const db = memDb(baseSeed())
    const eve = creatingEve()
    const plan = await planHomeTurn(db.client, DATA, { ensureSession: realEnsure(db, eve), renderPrimer: async () => 'PRIMER' })
    expect(plan).toMatchObject({ ok: true, sessionId: 'sess-home', fromIndex: 42 })
    expect((plan as HomeTurnPlan).primer).toBeUndefined()
    expect(eve.creates).toHaveLength(0)
  })

  it('a registered session nothing was sent into yet (a retried plan after its create) is primed, not replaced', async () => {
    TAIL = { tailIndex: -1, events: [] }
    const db = memDb(baseSeed({ conv: { eve_session_id: 'sess-new' } }))
    const eve = creatingEve()
    const plan = await planHomeTurn(db.client, DATA, { ensureSession: realEnsure(db, eve), renderPrimer: async () => 'PRIMER' })
    expect(plan).toMatchObject({ ok: true, sessionId: 'sess-new', fromIndex: 0, primer: 'PRIMER' })
    expect(eve.creates).toHaveLength(0)
  })

  it('a gone session (410 session_expired, 409 session_stranded, 404 Session not found.) is replaced over the dead id', async () => {
    for (const gone of [
      new SessionTailError(410, 'session_expired', null),
      new SessionTailError(409, 'session_stranded', null),
      new SessionTailError(404, null, 'Session not found.'),
    ]) {
      const db = memDb(baseSeed({ conv: { eve_session_id: 'sess-dead' } }))
      const eve = creatingEve()
      const plan = await planHomeTurn(db.client, DATA, {
        ensureSession: realEnsure(db, eve),
        peekTail: async () => {
          throw gone
        },
      })
      expect([gone.status, plan]).toEqual([gone.status, expect.objectContaining({ ok: true, sessionId: 'sess-new', fromIndex: 0 })])
      expect(db.tables.chat_conversations[0].eve_session_id).toBe('sess-new')
    }
  })

  it('any other tail failure keeps the registered session and throws (the step retries): a misroute never replaces it', async () => {
    for (const err of [
      new SessionTailError(403, 'session_forbidden', null),
      new SessionTailError(503, null, 'Session stream unavailable.'),
      new SessionTailError(404, null, null),
      new Error('socket hang up'),
    ]) {
      const db = memDb(baseSeed())
      const eve = creatingEve()
      await expect(
        planHomeTurn(db.client, DATA, {
          ensureSession: realEnsure(db, eve),
          peekTail: async () => {
            throw err
          },
        }),
      ).rejects.toBe(err)
      expect(eve.creates).toHaveLength(0)
      expect(db.tables.chat_conversations[0].eve_session_id).toBe('sess-home')
    }
  })

  it('the person’s window won the race: the turn queues onto their session, read as any other', async () => {
    TAIL = { tailIndex: 7, events: [] }
    const db = memDb(baseSeed({ conv: { eve_session_id: null } }))
    const eve = creatingEve()
    const plan = await planHomeTurn(db.client, DATA, {
      ensureSession: async (previous) => {
        // Their register lands between our read of the row and our create.
        db.tables.chat_conversations[0].eve_session_id = 'sess-browser'
        return realEnsure(db, eve)(previous)
      },
      renderPrimer: async () => 'PRIMER',
    })
    expect(plan).toMatchObject({ ok: true, sessionId: 'sess-browser', fromIndex: 8 })
    expect((plan as HomeTurnPlan).primer).toBeUndefined()
    expect(db.tables.chat_conversations[0].eve_session_id).toBe('sess-browser')
  })

  it('the gates still come first: autonomy off or over the limit never creates a session', async () => {
    const overLimit = async () => {
      throw new Response('limit', { status: 429 })
    }
    const cases: Array<[Parameters<typeof baseSeed>[0], Parameters<typeof realPlanHomeTurn>[2], string]> = [
      [{ conv: { eve_session_id: null }, settings: { agent_autonomy: { mode: 'off' } } }, {}, 'autonomy_off'],
      [{ conv: { eve_session_id: null } }, { checkUsage: overLimit }, 'usage_limited'],
    ]
    for (const [over, deps, reason] of cases) {
      const db = memDb(baseSeed(over))
      const eve = creatingEve()
      expect(await planHomeTurn(db.client, DATA, { ensureSession: realEnsure(db, eve), ...deps })).toMatchObject({ ok: false, reason })
      expect(eve.creates).toHaveLength(0)
      expect(db.tables.chat_conversations[0].eve_session_id).toBeNull()
    }
  })

  it('isSessionGoneError: only eve’s words for a session that can never run again', () => {
    expect(isSessionGoneError(new SessionTailError(410, 'session_expired', null))).toBe(true)
    expect(isSessionGoneError(new SessionTailError(410, null, null))).toBe(false)
    expect(isSessionGoneError(new SessionTailError(401, 'session_expired', null))).toBe(false)
    expect(isSessionGoneError(new Error('tail read refused (410)'))).toBe(false)
  })

  it('peekSessionTail carries eve’s code and words on a refusal', async () => {
    const expired = (async () =>
      Response.json({ code: 'session_expired', error: 'Session history is no longer available.', ok: false }, { status: 410 })) as unknown as typeof fetch
    const err = await peekSessionTail(DATA, 's', { fetch: expired }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SessionTailError)
    expect(isSessionGoneError(err)).toBe(true)
  })
})

describe('sendHomeTurn: a primed first message', () => {
  it('the update leads (every reader matches its first line) and the history follows it', async () => {
    const { db, plan, row } = await claimed()
    const eve = scriptedSession(ownTurn(homeTurnTag(row.id)))
    const primer = '<conversation-so-far>\nUser: earlier words\n</conversation-so-far>'
    await sendHomeTurn(db.client, DATA, { ...plan, primer }, row, { makeClient: eve.makeClient, budgetMs: 1000 })
    const message = String(eve.sends[0].message)
    expect(message.startsWith(`[BACKGROUND UPDATE · ${homeTurnTag(row.id)}`)).toBe(true)
    expect(message).toContain('User: earlier words')
    expect(message.indexOf('User: earlier words')).toBeGreaterThan(message.indexOf('call no_reply'))
    expect(eve.sends[0].options).toEqual({ turnPolicy: 'queue' })
  })

  it('withHomeTurnPrimer drops a primer that would pass the server entry’s cap, never the update', () => {
    expect(withHomeTurnPrimer('UPDATE', null)).toBe('UPDATE')
    expect(withHomeTurnPrimer('UPDATE', 'P')).toMatch(/^UPDATE\n\n[\s\S]*\nP$/)
    expect(withHomeTurnPrimer('UPDATE', 'x'.repeat(HOME_TURN_SEND_MAX_CHARS))).toBe('UPDATE')
  })
})

// ── Text turns (reason 'text', docs/plans/text-and-calling.md) ──────────────

describe('text turns: the person texting the Native Intelligence number', () => {
  const TEXT_DATA: HomeTurnRequestedData = { conversationId: CONV, userId: USER, workspaceId: WS, workItemIds: [], reason: 'text' }
  const textRow = (sid: string, text: string, minutesAgo: number) => ({
    conversation_id: CONV,
    user_id: USER,
    workspace_id: WS,
    role: 'user',
    created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    ui_message: { id: `sms-in:${sid}`, role: 'user', parts: [{ type: 'text', text }], metadata: { kind: 'channel_message', channel: 'sms' } },
  })
  const textSeed = (turns: Row[] = []) => baseSeed({ reports: [textRow('SM1', 'Move my 3pm to Friday', 3), textRow('SM2', 'and tell Dana', 1), textRow('SM0', 'too old', 90)], turns })

  it('still plans a text Phase 1 SMS wrote (the legacy kind), so one sent across the deploy is answered', async () => {
    const legacy = (sid: string, text: string, minutesAgo: number) => ({ ...textRow(sid, text, minutesAgo), ui_message: { ...textRow(sid, text, minutesAgo).ui_message, metadata: { kind: 'text_message', channel: 'sms' } } })
    const { client } = memDb(baseSeed({ reports: [legacy('SM9', 'Sent before the deploy', 2)], turns: [] }))
    const plan = (await planHomeTurn(client, TEXT_DATA)) as HomeTurnPlan
    expect(plan.channelMessages?.map((m) => m.messageId)).toEqual(['sms-in:SM9'])
  })

  it('plans every text no earlier text turn carried, oldest first, within the hour, keyed on their ids', async () => {
    const { client } = memDb(textSeed())
    const plan = (await planHomeTurn(client, TEXT_DATA)) as HomeTurnPlan
    expect(plan.ok).toBe(true)
    expect(plan.channelMessages).toEqual([
      { messageId: 'sms-in:SM1', text: 'Move my 3pm to Friday' },
      { messageId: 'sms-in:SM2', text: 'and tell Dana' },
    ])
    expect(plan.dedupeKey).toBe(homeTurnDedupeKey('text', ['sms-in:SM2', 'sms-in:SM1']))
    expect(plan.reports).toEqual([])
  })

  it('a skipped or sent text turn carried its texts (never replayed); one that failed before eve accepted anything did not', async () => {
    const fresh = new Date().toISOString()
    for (const [status, error, expected] of [
      ['skipped', 'question_pending', ['sms-in:SM2']],
      ['done', null, ['sms-in:SM2']],
      ['failed', 'send_refused_403', ['sms-in:SM1', 'sms-in:SM2']],
    ] as const) {
      const turn = { conversation_id: CONV, user_id: USER, reason: 'text', status, error, text_message_ids: ['sms-in:SM1'], created_at: 'x', updated_at: fresh }
      const plan = (await planHomeTurn(memDb(textSeed([turn])).client, TEXT_DATA)) as HomeTurnPlan
      expect([status, plan.channelMessages?.map((t) => t.messageId)]).toEqual([status, expected])
    }
    // Nothing left: nothing new.
    const all = { conversation_id: CONV, user_id: USER, reason: 'text', status: 'done', text_message_ids: ['sms-in:SM1', 'sms-in:SM2'], created_at: 'x', updated_at: fresh }
    expect(await planHomeTurn(memDb(textSeed([all])).client, TEXT_DATA)).toMatchObject({ ok: false, reason: 'nothing_new' })
  })

  it("a call's turn carries only that call's words, never ones an earlier call left undelivered", async () => {
    const callRow = (session: string, delegation: string, text: string, minutesAgo: number) => ({
      ...textRow('x', text, minutesAgo),
      ui_message: { id: `call-in:${session}:${delegation}`, role: 'user', parts: [{ type: 'text', text }], metadata: { kind: 'channel_message', channel: 'call' } },
    })
    const seed = baseSeed({ reports: [callRow('live_old', 'del_1', 'from a call that failed', 6), callRow('live_now', 'del_2', "what's on tomorrow", 1)], turns: [] })
    const CALL_DATA: HomeTurnRequestedData = { ...TEXT_DATA, reason: 'call', callSessionId: 'live_now' }
    const plan = (await planHomeTurn(memDb(seed).client, CALL_DATA)) as HomeTurnPlan
    expect(plan.channelMessages).toEqual([{ messageId: 'call-in:live_now:del_2', text: "what's on tomorrow" }])
    // Without a session (never sent that way), every undelivered call message, as a text turn's.
    const loose = (await planHomeTurn(memDb(seed).client, { ...CALL_DATA, callSessionId: undefined })) as HomeTurnPlan
    expect(loose.channelMessages?.map((m) => m.messageId)).toEqual(['call-in:live_old:del_1', 'call-in:live_now:del_2'])
  })

  it('a text turn is skipped (and records its texts) while the thread is parked on a question for the person', async () => {
    const rec = fixtures as unknown as Record<string, HandleMessageStreamEvent[]>
    TAIL = { tailIndex: 17, events: rec.askUserApprovalPark }
    const plan = await planHomeTurn(memDb(textSeed()).client, TEXT_DATA)
    expect(plan).toMatchObject({ ok: false, reason: 'question_pending', record: { channelMessages: [{ messageId: 'sms-in:SM1' }, { messageId: 'sms-in:SM2' }] } })
  })

  it('claims with text_message_ids; any other reason never writes the column (a database without 411 still takes it)', async () => {
    const db = memDb(textSeed())
    const plan = (await planHomeTurn(db.client, TEXT_DATA)) as HomeTurnPlan
    await claimHomeTurn(db.client, TEXT_DATA, plan)
    expect(db.tables.home_turn[0]).toMatchObject({ reason: 'text', status: 'claimed', text_message_ids: ['sms-in:SM1', 'sms-in:SM2'] })
    const reports = memDb(baseSeed())
    await claimHomeTurn(reports.client, DATA, (await planHomeTurn(reports.client, DATA)) as HomeTurnPlan)
    expect('text_message_ids' in reports.tables.home_turn[0]).toBe(false)
  })

  it("sends the person's own words under the row's tag, as the channel_turn principal with the sms surface, and writes the reply marked by text", async () => {
    const db = memDb(textSeed())
    const plan = (await planHomeTurn(db.client, TEXT_DATA)) as HomeTurnPlan
    const { row } = (await claimHomeTurn(db.client, TEXT_DATA, plan)) as { row: HomeTurnRow }
    const eve = scriptedSession(ownTurn(homeTurnTag(row.id), 'd-own', 'Done: moved to Friday 3pm and told Dana.'))
    const out = (await sendHomeTurn(db.client, TEXT_DATA, plan, row, { makeClient: eve.makeClient, budgetMs: 1000 })) as { result: HomeTurnReadResult }
    const message = String(eve.sends[0].message)
    expect(message.split('\n')).toEqual([`[TEXT MESSAGE · ${homeTurnTag(row.id)}] The person texted you from their phone (2 texts, oldest first):`, 'Move my 3pm to Friday', 'and tell Dana'])
    expect(message).not.toContain('BACKGROUND UPDATE')
    expect(eve.sends[0].options).toEqual({ turnPolicy: 'queue' })
    const claims = verifyChatRunToken(eve.tokens[0])
    expect(claims).toMatchObject({ server: 'channel_turn', surface: 'sms', conversationId: CONV, userId: USER })
    expect(claims?.cred).toBeUndefined()

    const finished = await finishHomeTurn(db.client, TEXT_DATA, row, out.result)
    expect(finished).toEqual({ outcome: 'written', written: true })
    const reply = db.tables.chat_messages.find((m) => (m.ui_message as { id: string }).id === `home-turn:${row.id}`)
    expect((reply!.ui_message as { metadata: Row }).metadata).toMatchObject({ kind: HOME_TURN_KIND, reason: 'text', channel: 'sms' })
  })

  it('a fresh session: the primer LEADS a text turn (so the history is never the person’s words); a background update keeps it after', async () => {
    const primer = '<conversation-so-far>\nUser: earlier\n</conversation-so-far>'
    expect(withHomeTurnPrimer('BODY', primer, { lead: true })).toBe(`${primer}\n\nBODY`)
    expect(withHomeTurnPrimer('BODY', primer)).toMatch(/^BODY\n\n/)
    const db = memDb(textSeed())
    const plan = (await planHomeTurn(db.client, TEXT_DATA, { renderPrimer: async () => primer })) as HomeTurnPlan
    expect(plan.primer).toBe(primer)
    const { row } = (await claimHomeTurn(db.client, TEXT_DATA, plan)) as { row: HomeTurnRow }
    const eve = scriptedSession(ownTurn(homeTurnTag(row.id)))
    await sendHomeTurn(db.client, TEXT_DATA, plan, row, { makeClient: eve.makeClient, budgetMs: 1000 })
    const message = String(eve.sends[0].message)
    expect(message.startsWith(primer)).toBe(true)
    expect(message).toContain(`[TEXT MESSAGE · ${homeTurnTag(row.id)}]`)
  })

  it('the plan step hands on ids only; the send step reads the words back, in order', async () => {
    const { redactChannelPlan, hydrateChannelPlan } = await import('../channel-turn-server')
    const db = memDb(textSeed())
    const plan = (await planHomeTurn(db.client, TEXT_DATA)) as HomeTurnPlan
    const redacted = redactChannelPlan(plan) as HomeTurnPlan
    expect(JSON.stringify(redacted)).not.toMatch(/Move my 3pm|tell Dana/)
    expect(redacted.channelMessages?.map((t) => t.messageId)).toEqual(['sms-in:SM1', 'sms-in:SM2'])
    const hydrated = await hydrateChannelPlan(db.client, TEXT_DATA, redacted)
    expect(hydrated.channelMessages).toEqual(plan.channelMessages)
    // A skip's record is redacted too.
    const skipped = redactChannelPlan({ ok: false, reason: 'question_pending', record: { dedupeKey: 'k', reports: [], workItemIds: [], sessionId: null, channelMessages: plan.channelMessages } })
    expect(JSON.stringify(skipped)).not.toMatch(/Move my 3pm/)
  })

  describe('settling and texting the reply', () => {
    const PHONE = '+15551234567'
    const replyMessage = (text: string) => ({
      conversation_id: CONV,
      user_id: USER,
      workspace_id: WS,
      role: 'assistant',
      ui_message: { id: 'home-turn:turn-1', role: 'assistant', parts: [{ type: 'text', text }], metadata: { kind: HOME_TURN_KIND } },
    })
    const replySeed = (over: { phone?: Row; reply?: string | null } = {}) => ({
      user_phone: [{ id: 'p1', user_id: USER, workspace_id: WS, phone_e164: PHONE, verified_at: 'x', opted_out_at: null, line: 'dial8', ...over.phone }],
      home_turn: [{ id: 'turn-1', conversation_id: CONV, user_id: USER, reason: 'text', reply_sent_at: null }],
      chat_messages: over.reply === null ? [] : [replyMessage(over.reply ?? '**Done.** Moved it.')],
      sms_message: [] as Row[],
    })
    const ARGS = { userId: USER, workspaceId: WS, conversationId: CONV, rowId: 'turn-1' }

    it('texts the stored reply once (claimed on the row), formatted for a phone, to the verified number, and records it', async () => {
      const { sendTextTurnReply } = await import('../text-turn-server')
      const db = memDb(replySeed())
      const send = vi.fn(async () => ({ ok: true as const, sid: 'SM-out' }))
      expect(await sendTextTurnReply(db.client, ARGS, { send, origin: 'https://app.test' })).toEqual({ sent: true, sid: 'SM-out' })
      expect(send).toHaveBeenCalledWith(PHONE, 'Done. Moved it.')
      expect(db.tables.home_turn[0].reply_sent_at).toBeTruthy()
      expect(db.tables.sms_message).toEqual([expect.objectContaining({ direction: 'out', kind: 'reply', phone_e164: PHONE, twilio_sid: 'SM-out', user_id: USER })])
      // A retried step never texts twice.
      expect(await sendTextTurnReply(db.client, ARGS, { send })).toEqual({ sent: false, reason: 'already_sent' })
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('texts only the final answer: the narration before a tool call stays in the thread', async () => {
      const { sendTextTurnReply } = await import('../text-turn-server')
      const seed = replySeed()
      seed.chat_messages[0].ui_message.parts = [
        { type: 'text', text: "Let me check Liam's calendar first." },
        { type: 'dynamic-tool', toolName: 'get_calendar_events', state: 'output-available' } as never,
        { type: 'text', text: 'You are free at 7.' },
      ]
      const send = vi.fn(async () => ({ ok: true as const, sid: 'SM-out' }))
      expect(await sendTextTurnReply(memDb(seed).client, ARGS, { send, origin: 'https://app.test' })).toEqual({ sent: true, sid: 'SM-out' })
      expect(send).toHaveBeenCalledWith(PHONE, 'You are free at 7.')
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('sends nothing for no reply or [quiet], to an opted-out number, or with no linked phone; 21610 marks the number opted out', async () => {
      const { sendTextTurnReply } = await import('../text-turn-server')
      const send = vi.fn(async () => ({ ok: true as const, sid: 'SM-out' }))
      expect(await sendTextTurnReply(memDb(replySeed({ reply: ' [quiet] ' })).client, ARGS, { send })).toEqual({ sent: false, reason: 'quiet' })
      expect(await sendTextTurnReply(memDb(replySeed({ reply: null })).client, ARGS, { send })).toEqual({ sent: false, reason: 'quiet' })
      expect(await sendTextTurnReply(memDb(replySeed({ phone: { opted_out_at: 'x' } })).client, ARGS, { send })).toEqual({ sent: false, reason: 'opted_out' })
      expect(await sendTextTurnReply(memDb({ ...replySeed(), user_phone: [] }).client, ARGS, { send })).toEqual({ sent: false, reason: 'no_phone' })
      expect(send).not.toHaveBeenCalled()
      const db = memDb(replySeed())
      const blocked = vi.fn(async () => ({ ok: false as const, reason: 'unsubscribed' as const, code: 21610 }))
      expect(await sendTextTurnReply(db.client, ARGS, { send: blocked })).toEqual({ sent: false, reason: 'unsubscribed' })
      expect(db.tables.user_phone[0].opted_out_at).toBeTruthy()
    })

    const doneRead = (end: 'completed' | 'failed' | 'cancelled' | 'session_ended' | 'steered'): HomeTurnReadResult => ({ done: true, end, state: newHomeTurnReadState('turn-1', 0) })

    it('a replayed write (written by an earlier attempt) is still texted: the reply is read back from the thread', async () => {
      const { settleTextTurn } = await import('../text-turn-server')
      const db = memDb(replySeed({ reply: 'Moved it.' }))
      const send = vi.fn(async () => ({ ok: true as const, sid: 'SM-out' }))
      const finish = vi.fn(async () => ({ outcome: 'written' as const, written: false }))
      const settled = await settleTextTurn(db.client, TEXT_DATA, { id: 'turn-1' }, doneRead('completed'), { send, finish })
      expect(settled).toEqual({ outcome: 'written', written: false, replied: true })
      expect(send).toHaveBeenCalledWith(PHONE, 'Moved it.')
      // Outcomes only: never the reply's words (an Inngest step output).
      expect(JSON.stringify(settled)).not.toContain('Moved it')
    })

    it('a text turn that held a call for approval and said nothing is still written (its card lives there) and texts the held notice', async () => {
      const { settleTextTurn, textTurnSkipNotice } = await import('../text-turn-server')
      const { approvalIdOfToolOutput } = await import('@/lib/attention/chat-asks')
      const approvalId = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b'
      const held = {
        type: 'dynamic-tool',
        toolName: 'delete_action',
        toolCallId: 'call-1',
        state: 'output-available',
        input: { action_id: 'GEN-12' },
        output: { success: false, code: 'APPROVAL_REQUIRED', approval_id: approvalId, message: 'Nothing ran.' },
      }
      expect(approvalIdOfToolOutput(held.toolName, held.output)).toBe(approvalId)
      const fresh = newHomeTurnReadState('turn-1', 0)
      const read = (end: 'completed' | 'failed'): HomeTurnReadResult => ({ done: true, end, state: { ...fresh, parts: { ...fresh.parts, parts: [held] } } })
      // The home thread the written message lands in.
      const seed = () => ({ ...replySeed({ reply: null }), chat_conversations: baseSeed().chat_conversations })
      for (const end of ['completed', 'failed'] as const) {
        const db = memDb(seed())
        const send = vi.fn(async () => ({ ok: true as const, sid: 'SM-n' }))
        expect(await settleTextTurn(db.client, TEXT_DATA, { id: 'turn-1' }, read(end), { send })).toMatchObject({ written: true, replied: false, notice: 'held' })
        const message = db.tables.chat_messages.find((m) => (m.ui_message as { id: string }).id === 'home-turn:turn-1')
        const parts = (message!.ui_message as { parts: Array<{ toolName?: string; output?: unknown }> }).parts
        expect(parts.map((p) => approvalIdOfToolOutput(p.toolName ?? '', p.output))).toEqual([approvalId])
        expect(send).toHaveBeenCalledWith(PHONE, textTurnSkipNotice('held'))
      }
      // A background update that held a card is written too (every reason): the card lives on the message, and the
      // router texts its code alone (ended_quiet: what a quiet turn wrote was narration, src/lib/reach/route-policy.ts).
      const db = memDb(seed())
      expect(await finishHomeTurn(db.client, DATA, { id: 'turn-1' }, read('completed'))).toEqual({ outcome: 'written', written: true, heldApproval: true })
      const bg = db.tables.chat_messages.find((m) => (m.ui_message as { id: string }).id === 'home-turn:turn-1')
      expect((bg!.ui_message as { metadata: Record<string, unknown> }).metadata).toMatchObject({ reason: DATA.reason, ended_quiet: true })
    })

    it.each(['failed', 'cancelled', 'session_ended'] as const)('a %s turn with nothing to say texts the failed notice', async (end) => {
      const { settleTextTurn, textTurnSkipNotice } = await import('../text-turn-server')
      const db = memDb(replySeed({ reply: null }))
      const send = vi.fn(async () => ({ ok: true as const, sid: 'SM-n' }))
      const finish = vi.fn(async () => ({ outcome: 'quiet' as const, written: false }))
      expect(await settleTextTurn(db.client, TEXT_DATA, { id: 'turn-1' }, doneRead(end), { send, finish })).toMatchObject({ replied: false, notice: 'failed' })
      expect(send).toHaveBeenCalledWith(PHONE, textTurnSkipNotice('failed'))
    })

    it('a quiet completed turn, or one the person steered from the app, texts nothing; one still running at the cap texts the unfinished notice', async () => {
      const { settleTextTurn } = await import('../text-turn-server')
      const send = vi.fn(async () => ({ ok: true as const, sid: 'SM-n' }))
      const finish = vi.fn(async () => ({ outcome: 'quiet' as const, written: false }))
      for (const end of ['completed', 'steered'] as const) {
        expect(await settleTextTurn(memDb(replySeed({ reply: null })).client, TEXT_DATA, { id: 'turn-1' }, doneRead(end), { send, finish })).toMatchObject({ replied: false })
      }
      expect(send).not.toHaveBeenCalled()
      const running: HomeTurnReadResult = { done: false, state: newHomeTurnReadState('turn-1', 0) }
      expect(await settleTextTurn(memDb(replySeed({ reply: null })).client, TEXT_DATA, { id: 'turn-1' }, running, { send, finish: vi.fn(async () => ({ outcome: 'watch_exhausted' as const, written: false })) })).toMatchObject({ notice: 'unfinished' })
      expect(send).toHaveBeenCalledTimes(1)
    })
  })
})

describe('homeTurnLabel', () => {
  const report = (title: string) => ({ messageId: 'm', report: { title } as never })
  it('names one report by its title, more by their count, a digest and an event by their kind', () => {
    expect(homeTurnLabel({ reports: [report('Evening Brief')] }, 'helper_report')).toBe('Evening Brief')
    expect(homeTurnLabel({ reports: [report('x'), report('y')] }, 'helper_report')).toBe('2 updates')
    expect(homeTurnLabel({ reports: [] }, 'digest')).toBe('Daily digest')
    expect(homeTurnLabel({ reports: [] }, 'event')).toBe('Heads up')
    expect(homeTurnLabel({ reports: [report('A very long title that goes on and on past the line’s room for it')] }, 'helper_report').length).toBeLessThanOrEqual(48)
  })
})

// ── A Slack turn (reason 'slack': the person messaging from Slack) ───────────

describe('a Slack turn (docs/plans/slack-connect.md, decision 14)', () => {
  const SLACK: HomeTurnRequestedData = { conversationId: CONV, userId: USER, workspaceId: WS, workItemIds: [], reason: 'slack' }

  function slackRow(ts: string, text: string, minutesAgo: number) {
    return {
      conversation_id: CONV,
      user_id: USER,
      workspace_id: WS,
      role: 'user',
      created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      ui_message: {
        id: `slack-in:T111:D333:${ts}`,
        role: 'user',
        parts: [{ type: 'text', text }],
        metadata: { kind: 'channel_message', channel: 'slack', slack: { team_id: 'T111', channel_id: 'D333', ts, installation_id: 'T111' } },
      },
    }
  }

  it('plans the person’s Slack messages no earlier Slack turn carried, oldest first, and no reports', async () => {
    const seed = baseSeed({ reports: [reportRow(ITEM_A, 'needs_review', 5), slackRow('1.1', 'first', 3), slackRow('1.2', 'second', 1)] })
    const { client } = memDb(seed)
    const plan = (await planHomeTurn(client, SLACK)) as HomeTurnPlan
    expect(plan.ok).toBe(true)
    expect(plan.reports).toEqual([])
    expect(plan.channelMessages).toEqual([
      { messageId: 'slack-in:T111:D333:1.1', text: 'first' },
      { messageId: 'slack-in:T111:D333:1.2', text: 'second' },
    ])
    expect(plan.dedupeKey).toBe(homeTurnDedupeKey('slack', ['slack-in:T111:D333:1.2', 'slack-in:T111:D333:1.1']))
  })

  it('leaves out messages an earlier Slack turn carried (a skipped one too), and has nothing new without them', async () => {
    const fresh = new Date().toISOString()
    const { client } = memDb(
      baseSeed({
        reports: [slackRow('1.1', 'first', 3)],
        turns: [{ conversation_id: CONV, user_id: USER, reason: 'slack', status: 'skipped', error: 'question_pending', text_message_ids: ['slack-in:T111:D333:1.1'], created_at: 'x', updated_at: fresh }],
      }),
    )
    expect(await planHomeTurn(client, SLACK)).toMatchObject({ ok: false, reason: 'nothing_new' })
  })

  it('runs with autonomy off: it is the person speaking, not the agent acting on its own', async () => {
    const { client } = memDb(baseSeed({ settings: { agent_autonomy: { mode: 'off' } }, reports: [reportRow(ITEM_A, 'needs_review', 5), slackRow('1.1', 'hi', 1)] }))
    expect(await planHomeTurn(client, SLACK)).toMatchObject({ ok: true })
    // A helper's report in the same thread still waits.
    expect(await planHomeTurn(client, DATA)).toMatchObject({ ok: false, reason: 'autonomy_off' })
  })

  it('claims with its message ids, sends the person’s words as the channel_turn principal with the Slack surface', async () => {
    const db = memDb(baseSeed({ reports: [slackRow('1.1', 'what is on my calendar', 1)] }))
    const plan = (await planHomeTurn(db.client, SLACK)) as HomeTurnPlan
    const claim = await claimHomeTurn(db.client, SLACK, plan)
    expect(claim.kind).toBe('claimed')
    expect(db.tables.home_turn[0]).toMatchObject({ reason: 'slack', text_message_ids: ['slack-in:T111:D333:1.1'], report_message_ids: [] })
    const row = (claim as { row: HomeTurnRow }).row
    const eve = scriptedSession(ownTurn(homeTurnTag(row.id), 'd-own', 'You have standup at 9.'))
    await sendHomeTurn(db.client, SLACK, plan, row, { makeClient: eve.makeClient, budgetMs: 1000 })
    const message = String(eve.sends[0].message)
    expect(message.split('\n')[0]).toBe(`[SLACK MESSAGE · ${homeTurnTag(row.id)}] The person messaged you from Slack:`)
    expect(message).toContain('what is on my calendar')
    expect(message).not.toContain('BACKGROUND UPDATE')
    const claims = verifyChatRunToken(eve.tokens[0])
    expect(claims).toMatchObject({ server: 'channel_turn', surface: 'slack', userId: USER, workspaceId: WS })
    expect(claims?.cred).toBeUndefined()
  })

  it('a fresh session’s primer leads the person’s words (so it never reads as something they said)', () => {
    const body = '[SLACK MESSAGE · home-turn r1] The person messaged you from Slack:\nhi'
    const primer = '<conversation-so-far>\nUser: earlier\n</conversation-so-far>'
    expect(withHomeTurnPrimer(body, primer, { lead: true })).toBe(`${primer}\n\n${body}`)
    expect(withHomeTurnPrimer(body, primer).startsWith(body)).toBe(true)
  })

  it('the reply is written marked as from Slack', async () => {
    const db = memDb(baseSeed({ reports: [] }))
    const read = {
      done: true,
      end: 'completed',
      state: { ...newHomeTurnReadState('row-9', 0), parts: { messageId: 'home-turn:row-9', parts: [{ type: 'text', text: 'You have standup at 9.', state: 'done' }] } },
    } as unknown as HomeTurnReadResult
    db.tables.home_turn = [{ id: 'row-9', conversation_id: CONV, status: 'sent' }]
    const out = await finishHomeTurn(db.client, SLACK, { id: 'row-9' }, read)
    expect(out.written).toBe(true)
    const written = db.tables.chat_messages.find((r) => (r.ui_message as { id: string }).id === 'home-turn:row-9')
    expect((written?.ui_message as { metadata: Record<string, unknown> }).metadata).toMatchObject({ kind: HOME_TURN_KIND, reason: 'slack', channel: 'slack' })
  })
})

describe('a Slack turn in the person’s own channel-thread conversation (migration 414)', () => {
  const SLACK: HomeTurnRequestedData = { conversationId: CONV, userId: USER, workspaceId: WS, workItemIds: [], reason: 'slack' }
  const mentionRow = {
    conversation_id: CONV,
    user_id: USER,
    workspace_id: WS,
    role: 'user',
    created_at: new Date(Date.now() - 60_000).toISOString(),
    ui_message: { id: 'slack-in:T111:C444:2.1', role: 'user', parts: [{ type: 'text', text: 'what did we decide?' }], metadata: { kind: 'channel_message', channel: 'slack', slack: { team_id: 'T111', ts: '2.1' } } },
  }

  it('plans in a conversation marked for Slack, as a thread', async () => {
    const { client } = memDb(baseSeed({ conv: { is_home: null, outside_channel: 'slack' }, reports: [mentionRow] }))
    const plan = (await planHomeTurn(client, SLACK)) as HomeTurnPlan
    expect(plan).toMatchObject({ ok: true, channelPlace: 'thread' })
    expect(buildHomeTurnBodyFor(plan)).toContain('mentioned you in a Slack channel thread (others in the channel read your reply)')
  })

  it('any other server turn stays out of it (only the home thread)', async () => {
    const { client } = memDb(baseSeed({ conv: { is_home: null, outside_channel: 'slack' } }))
    expect(await planHomeTurn(client, DATA)).toMatchObject({ ok: false, reason: 'not_home' })
  })

  it('a DM stays a DM', async () => {
    const { client } = memDb(baseSeed({ reports: [{ ...mentionRow }] }))
    expect(await planHomeTurn(client, SLACK)).toMatchObject({ ok: true, channelPlace: 'direct' })
  })

  it('registers a new session only on the conversation the plan checked: the thread, by its marker', async () => {
    const db = memDb(baseSeed({ conv: { is_home: null, outside_channel: 'slack', eve_session_id: null }, reports: [mentionRow] }))
    const eve = scriptedSession([])
    const created = { session: { state: { sessionId: 'sess-new' } } }
    const makeClient = () => ({ sessions: { create: async () => created } }) as never
    const out = await ensureHomeSession(db.client, SLACK, { previous: null, channelThread: true }, { makeClient })
    expect(out).toEqual({ ok: true, sessionId: 'sess-new', created: true })
    expect(db.tables.chat_conversations[0].eve_session_id).toBe('sess-new')
    void eve
  })
})

function buildHomeTurnBodyFor(plan: HomeTurnPlan): string {
  return renderChannelTurnBody('slack', homeTurnTag('r1'), [{ messageId: 'm', text: 'x' }], plan.channelPlace ?? 'direct') ?? ''
}

describe('a database without migration 414', () => {
  it('plans a home turn as before: the conversation read falls back without the column', async () => {
    const { client } = memDb(baseSeed())
    const refusing = {
      from: (t: string) => {
        const q = (client as { from: (t: string) => Record<string, unknown> }).from(t)
        if (t !== 'chat_conversations') return q
        const select = q.select as (c?: string) => unknown
        const missing: Record<string, unknown> = {
          eq: () => missing,
          maybeSingle: async () => ({ data: null, error: { code: '42703', message: 'column does not exist' } }),
        }
        return { ...q, select: (c?: string) => (c?.includes('outside_channel') ? missing : select(c)) }
      },
    }
    expect(await planHomeTurn(refusing as never, DATA)).toMatchObject({ ok: true })
  })
})

// ── The check-in (docs/plans/now-file.md "The check-in") ────────────────────

describe('the check-in: a fresh session of its own, its reply into the home thread', () => {
  const CHECK_IN: HomeTurnRequestedData = { conversationId: CONV, userId: USER, workspaceId: WS, workItemIds: [], reason: 'check_in', checkInSlot: { date: '2026-10-27', hour: 12 } }
  const BODY = {
    date: '2026-10-27',
    hour: 12,
    timeZone: 'UTC',
    revision: 3,
    lines: ['Line 5 (In flight), item work:w-1: - A helper is drafting the Acme follow-up (Oct 26)', '- New: 2026-10-27 11:12 Finished: Acme follow-up draft'],
    eventIds: ['7'],
  }
  const untouched = () => ({
    peekTail: vi.fn(async (): Promise<SessionTail> => {
      throw new Error('a check-in never reads the thread’s session')
    }),
    ensureSession: vi.fn(async () => ({ ok: false as const, reason: 'no_session' as const })),
    renderPrimer: vi.fn(async () => 'THE HOME THREAD’S HISTORY'),
  })
  const plans = (deps: Parameters<typeof realPlanHomeTurn>[2] = {}) => ({
    gatherCheckIn: vi.fn(async () => ({ ok: true as const, body: BODY })),
    createCheckInSession: vi.fn(async () => ({ ok: true as const, sessionId: 'sess-check-in' })),
    ...untouched(),
    ...deps,
  })

  it('plans a FRESH session: never the thread’s session, its tail or its primer; keyed on its slot', async () => {
    const { client } = memDb(baseSeed())
    const deps = plans()
    const plan = await realPlanHomeTurn(client, CHECK_IN, deps)
    expect(plan).toEqual({ ok: true, sessionId: 'sess-check-in', fromIndex: 0, reports: [], workItemIds: [], dedupeKey: 'check_in:2026-10-27:12', checkIn: BODY })
    expect(deps.peekTail).not.toHaveBeenCalled()
    expect(deps.ensureSession).not.toHaveBeenCalled()
    expect(deps.renderPrimer).not.toHaveBeenCalled()
    // It re-gathers what is due itself (never the payload's word), for the person's member row and slot.
    expect(deps.gatherCheckIn).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS, userId: USER, memberId: 'm1', conversationId: CONV, date: '2026-10-27', hour: 12 }))
  })

  it('nothing due is nothing_new, and no session is made', async () => {
    const deps = plans({ gatherCheckIn: vi.fn(async () => ({ ok: false as const, reason: 'nothing_due' as const })) })
    expect(await realPlanHomeTurn(memDb(baseSeed()).client, CHECK_IN, deps)).toEqual({ ok: false, reason: 'nothing_new' })
    expect(deps.createCheckInSession).not.toHaveBeenCalled()
  })

  it('only for the home thread (its reply lands there), and autonomy off fails closed with a record that names no session', async () => {
    expect(await realPlanHomeTurn(memDb(baseSeed({ conv: { is_home: null } })).client, CHECK_IN, plans())).toMatchObject({ ok: false, reason: 'not_home' })
    const off = await realPlanHomeTurn(memDb(baseSeed({ settings: { agent_autonomy: { mode: 'off' } } })).client, CHECK_IN, plans())
    expect(off).toMatchObject({ ok: false, reason: 'autonomy_off', record: { dedupeKey: 'check_in:2026-10-27:12', sessionId: null } })
    const none = await realPlanHomeTurn(memDb(baseSeed()).client, CHECK_IN, plans({ createCheckInSession: vi.fn(async () => ({ ok: false as const })) }))
    expect(none).toMatchObject({ ok: false, reason: 'no_session', record: { sessionId: null } })
    expect(await realPlanHomeTurn(memDb(baseSeed()).client, { ...CHECK_IN, checkInSlot: undefined }, plans())).toEqual({ ok: false, reason: 'bad_event' })
  })

  it('the session is created message-free with the check-in’s own token (home_turn, reason check_in, the home thread’s conversation)', async () => {
    const tokens: string[] = []
    const creates: unknown[] = []
    const makeClient = (args: { secret: string; token: string }) => {
      tokens.push(args.token)
      return { sessions: { create: async (body: unknown) => (creates.push(body), { session: { state: { sessionId: 'sess-fresh' } } }) } } as never
    }
    expect(await createCheckInSession(CHECK_IN, { makeClient })).toEqual({ ok: true, sessionId: 'sess-fresh' })
    expect(creates).toEqual([{}])
    expect(verifyChatRunToken(tokens[0])).toMatchObject({ server: 'home_turn', homeTurnReason: 'check_in', conversationId: CONV, userId: USER, workspaceId: WS })
    expect(verifyChatRunToken(homeTurnToken(CHECK_IN, 'send'))).toMatchObject({ server: 'home_turn', homeTurnReason: 'check_in' })
    // Never for another reason.
    expect(await createCheckInSession(DATA, { makeClient })).toEqual({ ok: false })
  })

  it('the claim registers the fresh session on its own row; a live row for the slot is a duplicate, never resumed', async () => {
    const db = memDb(baseSeed())
    const plan = (await realPlanHomeTurn(db.client, CHECK_IN, plans())) as HomeTurnPlan
    const claim = (await claimHomeTurn(db.client, CHECK_IN, plan)) as { kind: string; row: HomeTurnRow }
    expect(claim.kind).toBe('claimed')
    expect(db.tables.home_turn.at(-1)).toMatchObject({ reason: 'check_in', dedupe_key: 'check_in:2026-10-27:12', eve_session_id: 'sess-check-in', status: 'claimed' })
    const old = new Date(Date.now() - HOME_TURN_STEP_BUDGET_MS * 2).toISOString()
    const stale = memDb(baseSeed({ turns: [{ id: 'dead', conversation_id: CONV, user_id: USER, reason: 'check_in', dedupe_key: 'check_in:2026-10-27:12', status: 'sent', eve_session_id: 'sess-other', created_at: old, updated_at: old }] }))
    expect(await claimHomeTurn(stale.client, CHECK_IN, plan)).toEqual({ kind: 'duplicate', status: 'sent' })
  })

  it('sends its own body into its own session: the check-in summary, its guidance and the fenced lines, never a primer', async () => {
    const db = memDb(baseSeed())
    const plan = (await realPlanHomeTurn(db.client, CHECK_IN, plans())) as HomeTurnPlan
    const { row } = (await claimHomeTurn(db.client, CHECK_IN, plan)) as { row: HomeTurnRow }
    const eve = scriptedSession(ownTurn(homeTurnTag(row.id), 'd-own', 'ENG-42 is done; I took it off your list.'))
    await sendHomeTurn(db.client, CHECK_IN, plan, row, { makeClient: eve.makeClient, budgetMs: 1000 })
    expect(eve.attaches[0]).toEqual({ id: 'sess-check-in', streamIndex: 0 })
    const message = String(eve.sends[0].message)
    expect(message.startsWith(`[BACKGROUND UPDATE · home-turn ${row.id}]`)).toBe(true)
    expect(message).toContain('Check-in: it is 12:00 for the person')
    expect(message).toContain(CHECK_IN_GUIDANCE)
    for (const line of BODY.lines) expect(message).toContain(line)
    expect(message).not.toContain('restored for context')
    expect(eve.sends[0].options).toEqual({ turnPolicy: 'queue' })
    for (const token of eve.tokens) expect(verifyChatRunToken(token)).toMatchObject({ server: 'home_turn', homeTurnReason: 'check_in' })
  })

  it('its reply lands in the home thread as text through appendHomeMessage; a no_reply writes nothing; neither signals idle compaction', async () => {
    const db = memDb(baseSeed())
    const plan = (await realPlanHomeTurn(db.client, CHECK_IN, plans())) as HomeTurnPlan
    const { row } = (await claimHomeTurn(db.client, CHECK_IN, plan)) as { row: HomeTurnRow }
    const events = ownTurn(homeTurnTag(row.id), 'd-own', "ENG-42's coding run failed twice. Retry, or take a look?")
    const at = events.findIndex((e) => e.type === 'message.appended')
    // An update_now call before the reply: its row stays in the check-in's own session.
    events.splice(
      at,
      0,
      ev('actions.requested', { turnId: 'turn_9', actions: [{ kind: 'tool-call', callId: 'un-1', toolName: 'update_now', input: { summary: 'x' } }] }, ['d-own']),
      ev('action.result', { turnId: 'turn_9', result: { kind: 'tool-result', callId: 'un-1', toolName: 'update_now', output: { success: true } } }, ['d-own']),
    )
    const eve = scriptedSession(events)
    const sent = (await sendHomeTurn(db.client, CHECK_IN, plan, row, { makeClient: eve.makeClient, budgetMs: 1000 })) as { result: HomeTurnReadResult }
    const tellHome = vi.fn(async () => ({ written: true }))
    signal.mockClear()
    expect(await finishHomeTurn(db.client, CHECK_IN, row, sent.result, homeTurnLabel({ reports: [] }, 'check_in'), { tellHome })).toEqual({ outcome: 'written', written: true })
    expect(tellHome).toHaveBeenCalledWith(db.client, {
      userId: USER,
      workspaceId: WS,
      messageId: `home-turn:${row.id}`,
      parts: [{ type: 'text', text: "ENG-42's coding run failed twice. Retry, or take a look?" }],
      metadata: { kind: HOME_TURN_KIND, home_turn_id: row.id, reason: 'check_in', label: 'Check-in' },
    })
    // Never through the eve writer: the home thread's session never held this turn.
    expect(db.tables.chat_messages.some((m) => (m.ui_message as { id: string }).id === `home-turn:${row.id}`)).toBe(false)
    expect(signal).not.toHaveBeenCalled()
    expect(db.tables.home_turn.at(-1)).toMatchObject({ status: 'done', message_written: true })

    const quietRow = { id: 'quiet-row' }
    const quietEvents = ownTurn(homeTurnTag(quietRow.id), 'd-q', 'Nothing needs them.')
    quietEvents.splice(
      quietEvents.findIndex((e) => e.type === 'turn.completed'),
      0,
      ev('actions.requested', { turnId: 'turn_9', actions: [{ kind: 'tool-call', callId: 'nr', toolName: 'no_reply', input: {} }] }, ['d-q']),
      ev('action.result', { turnId: 'turn_9', result: { kind: 'tool-result', callId: 'nr', toolName: 'no_reply', output: { ended: true } } }, ['d-q']),
    )
    const quiet = await readHomeTurnEvents(scriptedSession(quietEvents).session.stream({ startIndex: 0, signal: new AbortController().signal }) as never, quietRow.id, newHomeTurnReadState(quietRow.id, 0, 'd-q'))
    const quietTell = vi.fn(async () => ({ written: true }))
    expect((await finishHomeTurn(db.client, CHECK_IN, quietRow, quiet, 'Check-in', { tellHome: quietTell })).written).toBe(false)
    expect(quietTell).not.toHaveBeenCalled()

    // Only its final answer lands: the narration between its calls stays in its own session (the router texts what is stored).
    const fresh = newHomeTurnReadState('narrated-row', 0)
    const narrated = (parts: unknown[]): HomeTurnReadResult => ({ done: true, end: 'completed', state: { ...fresh, parts: { ...fresh.parts, parts } as never } })
    const narratedTell = vi.fn(async () => ({ written: true }))
    const parts = [
      { type: 'text', text: 'Let me update the note first.' },
      { type: 'dynamic-tool', toolName: 'update_now', toolCallId: 'u1', state: 'output-available', input: {}, output: { success: true } },
      { type: 'text', text: 'Your 9:00 with Ken moved to 8:30.' },
    ]
    expect((await finishHomeTurn(db.client, CHECK_IN, { id: 'narrated-row' }, narrated(parts), 'Check-in', { tellHome: narratedTell })).written).toBe(true)
    expect(narratedTell).toHaveBeenCalledWith(db.client, expect.objectContaining({ parts: [{ type: 'text', text: 'Your 9:00 with Ken moved to 8:30.' }] }))
    // Words only before a call that failed were narration: its final answer is nothing, so nothing is written.
    const failedTell = vi.fn(async () => ({ written: true }))
    const failed = [parts[0], { ...parts[1], state: 'output-error', output: undefined, errorText: 'boom' }]
    expect(await finishHomeTurn(db.client, CHECK_IN, { id: 'narrated-row' }, narrated(failed), 'Check-in', { tellHome: failedTell })).toEqual({ outcome: 'quiet', written: false })
    expect(failedTell).not.toHaveBeenCalled()

    // A check-in that marked its line urgent (part D): the home thread's message carries urgent_by too.
    const urgentRow = { id: 'urgent-row' }
    const urgentEvents = ownTurn(homeTurnTag(urgentRow.id), 'd-u', 'Your 9:00 with Ken moved to 8:30.')
    urgentEvents.splice(
      urgentEvents.findIndex((e) => e.type === 'message.appended'),
      0,
      ev('actions.requested', { turnId: 'turn_9', actions: [{ kind: 'tool-call', callId: 'mu', toolName: 'mark_urgent', input: { by: '2026-11-01T09:00:00-05:00' } }] }, ['d-u']),
      ev('action.result', { turnId: 'turn_9', result: { kind: 'tool-result', callId: 'mu', toolName: 'mark_urgent', output: { marked: true, by: '2026-11-01T09:00:00-05:00' } } }, ['d-u']),
    )
    const urgentRead = await readHomeTurnEvents(scriptedSession(urgentEvents).session.stream({ startIndex: 0, signal: new AbortController().signal }) as never, urgentRow.id, newHomeTurnReadState(urgentRow.id, 0, 'd-u'))
    const urgentTell = vi.fn(async () => ({ written: true }))
    expect((await finishHomeTurn(db.client, CHECK_IN, urgentRow, urgentRead, 'Check-in', { tellHome: urgentTell })).written).toBe(true)
    expect(urgentTell).toHaveBeenCalledWith(db.client, expect.objectContaining({ metadata: expect.objectContaining({ reason: 'check_in', urgent_by: '2026-11-01T09:00:00-05:00' }) }))
  })
})

// ── A send eve refuses because it has no run for the session ────────────────

describe('sendHomeTurn: eve has no run for the thread’s session (409 session_not_active on the send)', () => {
  const PRIMER = '<conversation-so-far>\nUser: earlier words\n</conversation-so-far>'

  /**
   * Two sessions: the thread's ('sess-home'), whose send eve refuses with
   * `refuse`, and the fresh one a create makes ('sess-new'), which takes the
   * send (or refuses with `refuseNew`) and streams `events`.
   */
  function goneEve(
    refuse: Error,
    events: (tag: string) => HandleMessageStreamEvent[],
    opts: { refuseNew?: Error; tag: string; createIds?: string[]; onRefuse?: () => void },
  ) {
    const ids = [...(opts.createIds ?? ['sess-new'])]
    const creates: string[] = []
    const attaches: Array<{ id: string; streamIndex: number }> = []
    const sends: Array<{ id: string; message: unknown; options: unknown }> = []
    const sessionFor = (id: string) => {
      const scripted = scriptedSession(id === 'sess-home' ? [] : events(opts.tag), { deliveryId: 'd-own' })
      return {
        ...scripted.session,
        send: vi.fn(async (message: unknown, options: unknown) => {
          if (id === 'sess-home') {
            opts.onRefuse?.()
            throw refuse
          }
          if (opts.refuseNew) throw opts.refuseNew
          sends.push({ id, message, options })
          return { [Symbol('acceptedDeliveryId')]: 'd-own' }
        }),
        respond: vi.fn(async () => ({})),
      }
    }
    const makeClient = (args: { secret: string; token: string }) =>
      ({
        sessions: {
          create: async (o: unknown) => {
            expect(o).toEqual({})
            creates.push(args.token)
            return { session: { state: { sessionId: ids.shift() ?? 'sess-extra' } } }
          },
          attach: (id: string, o: { streamIndex: number }) => (attaches.push({ id, streamIndex: o.streamIndex }), sessionFor(id)),
        },
      }) as never
    return { creates, attaches, sends, makeClient }
  }

  const notActive = async () => {
    const { ClientError } = await import('eve/client')
    return new ClientError(409, JSON.stringify({ code: 'session_not_active' }))
  }

  it('gives the thread a fresh session (replacing only the refused one), primes its first message, moves the row, sends once there, and reads it from its start', async () => {
    const { db, plan, row } = await claimed()
    // The plan read the unknown session's tail as an ordinary one (eve's local storage answers 200): no primer.
    const stale = { ...plan, fromIndex: 42 }
    expect(stale.primer).toBeUndefined()
    const eve = goneEve(await notActive(), (tag) => ownTurn(tag), { tag: homeTurnTag(row.id) })
    const renderPrimer = vi.fn(async () => PRIMER)
    const out = (await sendHomeTurn(db.client, DATA, stale, row, { makeClient: eve.makeClient, renderPrimer, budgetMs: 1000 })) as { kind: string; result: HomeTurnReadResult }

    // One create, as the home-turn principal, registered over the refused id.
    expect(eve.creates).toHaveLength(1)
    expect(verifyChatRunToken(eve.creates[0])).toMatchObject({ server: 'home_turn', conversationId: CONV })
    expect(db.tables.chat_conversations[0].eve_session_id).toBe('sess-new')
    // Sent once, to the new session, as its first message: the update leads, the history follows.
    expect(eve.sends).toHaveLength(1)
    expect(eve.sends[0]).toMatchObject({ id: 'sess-new', options: { turnPolicy: 'queue' } })
    const message = String(eve.sends[0].message)
    expect(message.startsWith(`[BACKGROUND UPDATE · ${homeTurnTag(row.id)}`)).toBe(true)
    expect(message).toContain('User: earlier words')
    expect(renderPrimer).toHaveBeenCalledTimes(1)
    // The row names the new session and its start; the read starts there.
    expect(db.tables.home_turn[0]).toMatchObject({ status: 'sent', eve_session_id: 'sess-new', stream_position: 0 })
    expect(eve.attaches.at(-1)).toEqual({ id: 'sess-new', streamIndex: 0 })
    expect(out).toMatchObject({ kind: 'read', result: { done: true, end: 'completed', state: { sessionId: 'sess-new' } } })
    expect(out.result.state.parts.parts).toEqual([{ type: 'text', text: 'Your researcher has a question: which region?' }])

    // A retried step finds the row sent: it reads the NEW session from its start and never sends again.
    const retry = await sendHomeTurn(db.client, DATA, stale, row, { makeClient: eve.makeClient, renderPrimer, budgetMs: 1000 })
    expect(eve.sends).toHaveLength(1)
    expect(eve.creates).toHaveLength(1)
    expect(eve.attaches.at(-1)).toEqual({ id: 'sess-new', streamIndex: 0 })
    expect(retry).toMatchObject({ kind: 'read', result: { done: true, end: 'completed', state: { sessionId: 'sess-new' } } })
  })

  it('a later read step follows the new session, not the plan’s', async () => {
    const { db, plan, row } = await claimed()
    // Only the start of the turn so far: the send step's read ends without the turn's end.
    const eve = goneEve(await notActive(), (tag) => ownTurn(tag).slice(0, 3), { tag: homeTurnTag(row.id) })
    const out = (await sendHomeTurn(db.client, DATA, plan, row, { makeClient: eve.makeClient, renderPrimer: async () => null, budgetMs: 1000 })) as { result: HomeTurnReadResult }
    expect(out.result).toMatchObject({ done: false, state: { sessionId: 'sess-new', nextIndex: 3 } })
    await continueHomeTurn(db.client, DATA, plan, row, out.result.state, { makeClient: eve.makeClient, budgetMs: 1000 })
    expect(eve.attaches.at(-1)).toEqual({ id: 'sess-new', streamIndex: 3 })
  })

  it('never twice: a refusal from the fresh session fails the turn, with no second replacement', async () => {
    const { db, plan, row } = await claimed()
    const eve = goneEve(await notActive(), (tag) => ownTurn(tag), { tag: homeTurnTag(row.id), refuseNew: await notActive() })
    const out = await sendHomeTurn(db.client, DATA, plan, row, { makeClient: eve.makeClient, renderPrimer: async () => null, budgetMs: 1000 })
    expect(out).toEqual({ kind: 'failed', error: 'send_refused_409_session_not_active' })
    expect(eve.creates).toHaveLength(1)
    expect(eve.sends).toHaveLength(0)
    expect(db.tables.home_turn[0]).toMatchObject({ status: 'failed', error: 'send_refused_409_session_not_active', eve_session_id: 'sess-new' })
  })

  it('no fresh session to be had: the turn fails as before, nothing sent', async () => {
    const { db, plan, row } = await claimed()
    const eve = goneEve(await notActive(), (tag) => ownTurn(tag), { tag: homeTurnTag(row.id) })
    const ensureSession = vi.fn(async () => ({ ok: false as const, reason: 'no_session' as const }))
    const out = await sendHomeTurn(db.client, DATA, plan, row, { makeClient: eve.makeClient, ensureSession, budgetMs: 1000 })
    expect(ensureSession).toHaveBeenCalledWith('sess-home')
    expect(out).toEqual({ kind: 'failed', error: 'send_refused_409_session_not_active' })
    expect(db.tables.home_turn[0]).toMatchObject({ status: 'failed', eve_session_id: 'sess-home' })
    expect(eve.sends).toHaveLength(0)
  })

  it.each([
    [401, { code: 'session_expired' }, 'send_refused_401_session_expired'],
    [403, { code: 'server_send_not_home' }, 'send_refused_403_server_send_not_home'],
    [409, { code: 'session_busy' }, 'send_refused_409_session_busy'],
    [423, {}, 'send_refused_423'],
    [500, {}, 'send_refused_500'],
  ])('any other refusal (%i) fails the row as before, and the thread keeps its session', async (status, body, error) => {
    const { db, plan, row } = await claimed()
    const { ClientError } = await import('eve/client')
    const eve = goneEve(new ClientError(status, JSON.stringify(body)), (tag) => ownTurn(tag), { tag: homeTurnTag(row.id) })
    const out = await sendHomeTurn(db.client, DATA, plan, row, { makeClient: eve.makeClient, renderPrimer: async () => null, budgetMs: 1000 })
    expect(out).toEqual({ kind: 'failed', error })
    expect(eve.creates).toHaveLength(0)
    expect(eve.sends).toHaveLength(0)
    expect(db.tables.chat_conversations[0].eve_session_id).toBe('sess-home')
    expect(db.tables.home_turn[0]).toMatchObject({ status: 'failed', error, eve_session_id: 'sess-home' })
  })

  it('a check-in’s own session is never replaced, and the home thread is never touched', async () => {
    const CHECK_IN: HomeTurnRequestedData = { conversationId: CONV, userId: USER, workspaceId: WS, workItemIds: [], reason: 'check_in', checkInSlot: { date: '2026-10-27', hour: 12 } }
    const db = memDb(baseSeed())
    const plan: HomeTurnPlan = {
      ok: true,
      sessionId: 'sess-home',
      fromIndex: 0,
      reports: [],
      workItemIds: [],
      dedupeKey: 'check_in:2026-10-27:12',
      checkIn: { date: '2026-10-27', hour: 12, timeZone: 'UTC', revision: 3, lines: ['- New: a line'], eventIds: ['7'] },
    }
    const { row } = (await claimHomeTurn(db.client, CHECK_IN, plan)) as { row: HomeTurnRow }
    const eve = goneEve(await notActive(), (tag) => ownTurn(tag), { tag: homeTurnTag(row.id) })
    const ensureSession = vi.fn(async () => ({ ok: true as const, sessionId: 'sess-new', created: true }))
    const out = await sendHomeTurn(db.client, CHECK_IN, plan, row, { makeClient: eve.makeClient, ensureSession, budgetMs: 1000 })
    expect(out).toEqual({ kind: 'failed', error: 'send_refused_409_session_not_active' })
    expect(ensureSession).not.toHaveBeenCalled()
    expect(eve.creates).toHaveLength(0)
    expect(db.tables.chat_conversations[0].eve_session_id).toBe('sess-home')
  })

  it('a Slack channel thread’s turn: the fresh session goes on that conversation (by its marker), and the history leads the person’s words', async () => {
    const SLACK: HomeTurnRequestedData = { conversationId: CONV, userId: USER, workspaceId: WS, workItemIds: [], reason: 'slack' }
    const mention = {
      conversation_id: CONV,
      user_id: USER,
      workspace_id: WS,
      role: 'user',
      created_at: new Date(Date.now() - 60_000).toISOString(),
      ui_message: { id: 'slack-in:T111:C444:2.1', role: 'user', parts: [{ type: 'text', text: 'what did we decide?' }], metadata: { kind: 'channel_message', channel: 'slack' } },
    }
    const db = memDb(baseSeed({ conv: { is_home: null, outside_channel: 'slack' }, reports: [mention] }))
    TAIL = { tailIndex: 7, events: [] }
    const plan = (await planHomeTurn(db.client, SLACK)) as HomeTurnPlan
    expect(plan).toMatchObject({ ok: true, channelPlace: 'thread', sessionId: 'sess-home', fromIndex: 8 })
    const { row } = (await claimHomeTurn(db.client, SLACK, plan)) as { row: HomeTurnRow }
    const eve = goneEve(await notActive(), (tag) => ownTurn(tag), { tag: homeTurnTag(row.id) })
    await sendHomeTurn(db.client, SLACK, plan, row, { makeClient: eve.makeClient, renderPrimer: async () => PRIMER, budgetMs: 1000 })
    expect(db.tables.chat_conversations[0].eve_session_id).toBe('sess-new')
    const message = String(eve.sends[0].message)
    expect(message.startsWith(PRIMER)).toBe(true)
    expect(message).toContain('what did we decide?')
    expect(db.tables.home_turn[0]).toMatchObject({ eve_session_id: 'sess-new', stream_position: 0 })
  })

  it('a crash after the fresh session is registered, before the row moved: the row is back at claimed, and the retry sends once, primed, to that session', async () => {
    const { db, plan, row } = await claimed()
    const first = goneEve(await notActive(), (tag) => ownTurn(tag), { tag: homeTurnTag(row.id) })
    let registered!: () => void
    const atRegister = new Promise<void>((resolve) => (registered = resolve))
    // The first attempt registers 'sess-new', then its process dies (the step never returns).
    void sendHomeTurn(db.client, DATA, plan, row, {
      makeClient: first.makeClient,
      ensureSession: async (previous) => {
        await ensureHomeSession(db.client, DATA, { previous }, { makeClient: first.makeClient })
        registered()
        return new Promise(() => {})
      },
      budgetMs: 1000,
    })
    await atRegister
    expect(db.tables.chat_conversations[0].eve_session_id).toBe('sess-new')
    expect(db.tables.home_turn[0]).toMatchObject({ status: 'claimed', eve_session_id: 'sess-home' })

    // The retried step: the old session refuses again; ensureHomeSession finds 'sess-new' (its own create is parked unused).
    const retry = goneEve(await notActive(), (tag) => ownTurn(tag), { tag: homeTurnTag(row.id), createIds: ['sess-extra'] })
    const peekTail = vi.fn(async () => ({ tailIndex: -1, events: [] }))
    const out = await sendHomeTurn(db.client, DATA, plan, row, { makeClient: retry.makeClient, peekTail, renderPrimer: async () => PRIMER, budgetMs: 1000 })
    expect(peekTail).toHaveBeenCalledWith('sess-new')
    expect(retry.sends).toHaveLength(1)
    expect(retry.sends[0].id).toBe('sess-new')
    expect(String(retry.sends[0].message)).toContain('User: earlier words')
    expect(db.tables.chat_conversations[0].eve_session_id).toBe('sess-new')
    expect(db.tables.home_turn[0]).toMatchObject({ status: 'sent', eve_session_id: 'sess-new', stream_position: 0 })
    expect(out).toMatchObject({ kind: 'read', result: { done: true, end: 'completed', state: { sessionId: 'sess-new' } } })
  })

  it('a crash after the row moved, before the send: the retry reads the new session and never sends (the same at-most-once trade the first send makes)', async () => {
    const { db, plan, row } = await claimed()
    // Where a crash between the move and the send leaves things: the row sent on the new session at its start.
    db.tables.chat_conversations[0].eve_session_id = 'sess-new'
    Object.assign(db.tables.home_turn[0], { status: 'sent', eve_session_id: 'sess-new', stream_position: 0 })
    const eve = goneEve(await notActive(), () => [], { tag: homeTurnTag(row.id) })
    const out = await sendHomeTurn(db.client, DATA, plan, row, { makeClient: eve.makeClient, budgetMs: 50 })
    expect(eve.sends).toHaveLength(0)
    expect(eve.creates).toHaveLength(0)
    expect(eve.attaches).toEqual([{ id: 'sess-new', streamIndex: 0 }])
    expect(out).toMatchObject({ kind: 'read', result: { done: false, state: { sessionId: 'sess-new', nextIndex: 0 } } })
  })

  it('another caller’s session (created: false) is read as the plan reads one: a tail means no primer and the read starts after it', async () => {
    const { db, plan, row } = await claimed()
    const earlier = [ev('turn.started', {}, ['x']), ev('turn.completed', {}, ['x']), ev('session.waiting', {}, ['x']), ev('turn.started', {}, ['y']), ev('turn.completed', {}, ['y'])]
    const eve = goneEve(await notActive(), (tag) => [...earlier, ...ownTurn(tag)], { tag: homeTurnTag(row.id) })
    const renderPrimer = vi.fn(async () => PRIMER)
    const io = {
      makeClient: eve.makeClient,
      ensureSession: async () => ({ ok: true as const, sessionId: 'sess-browser', created: false }),
      peekTail: async () => ({ tailIndex: 4, events: earlier }),
      renderPrimer,
      budgetMs: 1000,
    }
    const out = await sendHomeTurn(db.client, DATA, plan, row, io)
    expect(renderPrimer).not.toHaveBeenCalled()
    expect(eve.sends).toHaveLength(1)
    expect(eve.sends[0].id).toBe('sess-browser')
    expect(String(eve.sends[0].message)).not.toContain('restored for context')
    expect(db.tables.home_turn[0]).toMatchObject({ status: 'sent', eve_session_id: 'sess-browser', stream_position: 5 })
    expect(eve.attaches.at(-1)).toEqual({ id: 'sess-browser', streamIndex: 5 })
    expect(out).toMatchObject({ kind: 'read', result: { done: true, end: 'completed', state: { sessionId: 'sess-browser' } } })
  })

  it('another caller’s session with no events yet still gets the history primer', async () => {
    const { db, plan, row } = await claimed()
    const eve = goneEve(await notActive(), (tag) => ownTurn(tag), { tag: homeTurnTag(row.id) })
    await sendHomeTurn(db.client, DATA, plan, row, {
      makeClient: eve.makeClient,
      ensureSession: async () => ({ ok: true as const, sessionId: 'sess-browser', created: false }),
      peekTail: async () => ({ tailIndex: -1, events: [] }),
      renderPrimer: async () => PRIMER,
      budgetMs: 1000,
    })
    expect(String(eve.sends[0].message)).toContain('User: earlier words')
    expect(db.tables.home_turn[0]).toMatchObject({ status: 'sent', eve_session_id: 'sess-browser', stream_position: 0 })
  })

  it('another caller’s session parked on the person’s question: the turn stops with the first refusal, nothing sent', async () => {
    const { db, plan, row } = await claimed()
    const eve = goneEve(await notActive(), (tag) => ownTurn(tag), { tag: homeTurnTag(row.id) })
    const asked = [ev('input.requested', { requests: [{ requestId: 'q1', kind: 'question' }] })]
    const out = await sendHomeTurn(db.client, DATA, plan, row, {
      makeClient: eve.makeClient,
      ensureSession: async () => ({ ok: true as const, sessionId: 'sess-browser', created: false }),
      peekTail: async () => ({ tailIndex: 0, events: asked }),
      renderPrimer: async () => PRIMER,
      budgetMs: 1000,
    })
    expect(out).toEqual({ kind: 'failed', error: 'send_refused_409_session_not_active' })
    expect(eve.sends).toHaveLength(0)
    // Failed before eve accepted anything: what it carried is still undelivered.
    expect(db.tables.home_turn[0]).toMatchObject({ status: 'failed', error: 'send_refused_409_session_not_active' })
  })

  it('a row another attempt moved meanwhile is left to it: nothing sent, nothing written', async () => {
    // The move to the new session finds the row no longer claimed (another attempt sent it).
    const a = await claimed()
    const eveA = goneEve(await notActive(), (tag) => ownTurn(tag), { tag: homeTurnTag(a.row.id) })
    const outA = await sendHomeTurn(a.db.client, DATA, a.plan, a.row, {
      makeClient: eveA.makeClient,
      ensureSession: async () => {
        Object.assign(a.db.tables.home_turn[0], { status: 'sent', eve_session_id: 'sess-home', stream_position: 0 })
        return { ok: true as const, sessionId: 'sess-new', created: true }
      },
      renderPrimer: async () => PRIMER,
      budgetMs: 1000,
    })
    expect(outA).toEqual({ kind: 'failed', error: 'send_unconfirmed' })
    expect(eveA.sends).toHaveLength(0)
    expect(a.db.tables.home_turn[0]).toMatchObject({ status: 'sent', eve_session_id: 'sess-home', stream_position: 0 })
    expect(a.db.tables.home_turn[0].error ?? null).toBeNull()

    // The put-back finds the row no longer on the old session.
    const b = await claimed()
    const eveB = goneEve(await notActive(), (tag) => ownTurn(tag), {
      tag: homeTurnTag(b.row.id),
      onRefuse: () => Object.assign(b.db.tables.home_turn[0], { eve_session_id: 'sess-other' }),
    })
    const ensureSession = vi.fn(async () => ({ ok: true as const, sessionId: 'sess-new', created: true }))
    expect(await sendHomeTurn(b.db.client, DATA, b.plan, b.row, { makeClient: eveB.makeClient, ensureSession, budgetMs: 1000 })).toEqual({ kind: 'failed', error: 'send_unconfirmed' })
    expect(ensureSession).not.toHaveBeenCalled()
    expect(b.db.tables.home_turn[0]).toMatchObject({ status: 'sent', eve_session_id: 'sess-other' })
  })

  it('a guest’s text turn: the fresh session goes on that guest’s own thread', async () => {
    const GUEST: HomeTurnRequestedData = { conversationId: CONV, userId: USER, workspaceId: WS, workItemIds: [], reason: 'text', guestId: 'guest-1' }
    const text = {
      conversation_id: CONV,
      user_id: USER,
      workspace_id: WS,
      role: 'user',
      created_at: new Date(Date.now() - 60_000).toISOString(),
      ui_message: { id: 'sms-in:SM7', role: 'user', parts: [{ type: 'text', text: 'Is Thursday still on?' }], metadata: { kind: 'channel_message', channel: 'sms' } },
    }
    const db = memDb(baseSeed({ conv: { is_home: null, agent_guest_id: 'guest-1' }, reports: [text] }))
    TAIL = { tailIndex: 3, events: [] }
    const plan = (await planHomeTurn(db.client, GUEST)) as HomeTurnPlan
    expect(plan).toMatchObject({ ok: true, channelPlace: 'thread', sessionId: 'sess-home' })
    const { row } = (await claimHomeTurn(db.client, GUEST, plan)) as { row: HomeTurnRow }
    const eve = goneEve(await notActive(), (tag) => ownTurn(tag), { tag: homeTurnTag(row.id) })
    await sendHomeTurn(db.client, GUEST, plan, row, { makeClient: eve.makeClient, renderPrimer: async () => PRIMER, budgetMs: 1000 })
    expect(db.tables.chat_conversations[0].eve_session_id).toBe('sess-new')
    expect(verifyChatRunToken(eve.creates[0])).toMatchObject({ server: 'channel_turn', surface: 'sms', guestId: 'guest-1' })
    expect(eve.sends).toHaveLength(1)
    expect(String(eve.sends[0].message)).toContain('Is Thursday still on?')
    expect(db.tables.home_turn[0]).toMatchObject({ status: 'sent', eve_session_id: 'sess-new', stream_position: 0 })

    // Another guest's thread is never written.
    const other = memDb(baseSeed({ conv: { is_home: null, agent_guest_id: 'guest-2', eve_session_id: 'sess-home' } }))
    expect(await ensureHomeSession(other.client, GUEST, { previous: 'sess-home', channelThread: true }, { makeClient: goneEve(await notActive(), () => [], { tag: 'x' }).makeClient })).toEqual({ ok: false, reason: 'no_session' })
    expect(other.tables.chat_conversations[0].eve_session_id).toBe('sess-home')
  })

  it('isSendSessionGoneError: only eve’s 409 session_not_active', async () => {
    const { ClientError } = await import('eve/client')
    expect(isSendSessionGoneError(new ClientError(409, JSON.stringify({ code: 'session_not_active' })))).toBe(true)
    expect(isSendSessionGoneError(new ClientError(409, JSON.stringify({ code: 'session_stranded' })))).toBe(false)
    expect(isSendSessionGoneError(new ClientError(423, '{}'))).toBe(false)
    expect(isSendSessionGoneError({ status: 409, code: 'session_not_active' })).toBe(false)
  })
})
