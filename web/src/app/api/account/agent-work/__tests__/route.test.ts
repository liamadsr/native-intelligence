/**
 * GET /api/account/agent-work: the light read (`?light=1`); the Agents page's
 * full answer is gone (bots-v4 Phase 7b), and `?teammate=` has its own file.
 *
 * What we lock in:
 *   - anything but `?light=1` or `?teammate=` is a 400;
 *   - the light read covers every workspace the SERVER resolves for the
 *     caller, scoped by workspace, not by member (widening is a policy flip);
 *   - the roster is read on the session client (RLS picks the teammates) and
 *     each attemptable role carries the breaker the gate reads, counted on the
 *     service client over every teammate holding the role;
 *   - each teammate carries the bot it wears (migration 294), and each item's
 *     teammate embed names it too;
 *   - a failed read is a 500, never an empty answer;
 *   - `card_rows` carries the rows pending cards point at, for EVERY pending,
 *     unexpired card (not the attention route's newest 50);
 *   - the open rows come in light columns, then (bots-v4 Phase 4b) the
 *     caller's last day of done runs that made something and weren't opened,
 *     with `deliverables`, `finished_at` and `title` (so a "done" peek
 *     survives a reload), the roster with its breakers (the service client
 *     reads only those), no chips and no admin read;
 *   - `ai_limited`: the teammates whose newest run in the last 48 hours the
 *     usage limit stopped, read as the caller's members; a later run clears
 *     it; a failed read of it, or of the done rows, is none, never a failed
 *     light read;
 *   - on a database without `opened_at` (before migration 295) the light read
 *     is a 500.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readJson } from '@/test/integration'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const hoisted = vi.hoisted(() => ({
  session: null as unknown,
  service: null as unknown,
  memberships: [
    { memberId: 'm1', workspaceId: 'w1' },
    { memberId: 'm2', workspaceId: 'w2' },
  ],
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: vi.fn(async () => ({
    supabase: hoisted.session,
    user: { id: 'user-1' },
    workspaceId: 'w1',
    member: { id: 'm1' },
  })),
}))

vi.mock('@/app/api/account/notifications/scope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/api/account/notifications/scope')>()
  return { ...actual, resolveMemberships: vi.fn(async () => hoisted.memberships) }
})

vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => hoisted.service }))

const { GET } = await import('@/app/api/account/agent-work/route')

const MIN = 60_000

function req(query = '') {
  return new Request(`http://localhost/api/account/agent-work${query}`)
}

function job(over: Record<string, unknown>) {
  return {
    id: String(over.id),
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'flow_run',
    title: 't',
    status: 'done',
    origin: 'user',
    progress: {},
    created_at: new Date(Date.now() - 60 * MIN).toISOString(),
    ...over,
  }
}

function mate(over: Record<string, unknown>) {
  return {
    id: String(over.id),
    workspace_id: 'w1',
    team_id: 'team-1',
    name: String(over.id),
    avatar_url: null,
    role: null,
    autonomy: 'propose',
    is_system: false,
    system_key: null,
    bot_character: null,
    created_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    ...over,
  }
}

let session: FakeSupabase
let service: FakeSupabase

beforeEach(() => {
  session = makeFakeSupabase()
  service = makeFakeSupabase()
  hoisted.session = session
  hoisted.service = service
})

describe('GET /api/account/agent-work', () => {
  it('anything but ?light=1 or ?teammate= is a 400 (the Agents page’s full answer is gone), before any read', async () => {
    const { resolveMemberships } = await import('@/app/api/account/notifications/scope')
    vi.mocked(resolveMemberships).mockClear()
    session.seed('tracked_job', [job({ id: 'w1-live', status: 'running' })])
    for (const query of ['', '?light=0', '?full=1']) {
      const res = await GET(req(query))
      expect(res.status, query).toBe(400)
    }
    expect(resolveMemberships).not.toHaveBeenCalled()
    expect(session.calls).toEqual([])
    expect(service.calls).toEqual([])
  })

  it('carries each attemptable role’s breaker on the roster, counted over every teammate of the role', async () => {
    // The caller sees one researcher. The service client also sees a second
    // researcher on a private team, and the gate counts that one's attempts too.
    session.seed('ai_team_member', [
      mate({ id: 'res-visible', role: 'researcher', autonomy: 'attempt' }),
      mate({ id: 'dev', role: 'developer' }),
      mate({ id: 'triage', is_system: true, system_key: 'triage' }),
      mate({ id: 'w2-writer', workspace_id: 'w2', role: 'writer', autonomy: 'attempt' }),
    ])
    service.seed('ai_team_member', [
      mate({ id: 'res-visible', role: 'researcher' }),
      mate({ id: 'res-private', role: 'researcher', team_id: 'private-team' }),
      mate({ id: 'dev', role: 'developer' }),
      mate({ id: 'w2-writer', workspace_id: 'w2', role: 'writer' }),
    ])
    service.seed('workspace', [
      { id: 'w1', settings: { agent_autonomy: { mode: 'attempt', role_breaker_window: 3 } } },
      { id: 'w2', settings: {} },
    ])
    const dismissed = (id: string, teammate: string, minsAgo: number, workspace = 'w1') =>
      job({ id, workspace_id: workspace, ai_team_member_id: teammate, origin: 'attempt', status: 'dismissed', progress: { review: 'dismissed' }, created_at: new Date(Date.now() - minsAgo * MIN).toISOString() })
    service.seed('tracked_job', [
      dismissed('a1', 'res-visible', 1),
      dismissed('a2', 'res-private', 2),
      dismissed('a3', 'res-visible', 3),
      dismissed('b1', 'w2-writer', 1, 'w2'),
    ])

    const body = await readJson<{ roster: Array<{ id: string; role: string | null; breaker: { paused: boolean; window: number } | null }> }>(await GET(req('?light=1')))
    const byId = Object.fromEntries(body.roster.map((r) => [r.id, r]))
    expect(Object.keys(byId).sort()).toEqual(['dev', 'res-visible', 'triage', 'w2-writer'])
    expect(byId['res-visible'].breaker).toEqual({ paused: true, window: 3 })
    expect(byId['w2-writer'].breaker).toEqual({ paused: false, window: 3 })
    expect(byId.dev.breaker).toBeNull()
    expect(byId.triage.breaker).toBeNull()
    // The breaker never reads through the caller's client.
    expect(session.calls.filter((c) => c.table === 'tracked_job').every((c) => !c.filters.some(([col]) => col === 'origin'))).toBe(true)
  })

  it('carries the bot each teammate wears, on the roster and in the items’ teammate embed', async () => {
    session.seed('ai_team_member', [
      mate({ id: 'writer', role: 'writer', bot_character: 'writer' }),
      mate({ id: 'triage', is_system: true, system_key: 'triage', bot_character: 'triage' }),
      mate({ id: 'email', is_system: true, system_key: 'email_drafts', bot_character: null }),
      // A value the app knows no character for draws no bot.
      mate({ id: 'odd', bot_character: 'robot' }),
    ])
    const body = await readJson<{ roster: Array<{ id: string; bot_character: string | null }> }>(await GET(req('?light=1')))
    expect(Object.fromEntries(body.roster.map((r) => [r.id, r.bot_character]))).toEqual({
      writer: 'writer',
      triage: 'triage',
      email: null,
      odd: null,
    })
    const rosterRead = session.selects.find((c) => c.table === 'ai_team_member')!
    expect(rosterRead.columns.split(/,\s*/)).toContain('bot_character')
    // Every read that hands rows to the client (the AI limit's reads only say whom it stopped).
    const feedReads = session.selects.filter((c) => c.table === 'tracked_job' && !/\berror_message\b/.test(c.columns))
    expect(feedReads.length).toBeGreaterThan(0)
    for (const c of feedReads) {
      expect(c.columns).toMatch(/teammate:ai_team_member_id\([^)]*\bbot_character\b[^)]*\)/)
    }
  })

  it('is a 500 when the feed read fails, not an empty answer', async () => {
    const failing = {
      from: (table: string) => {
        if (table !== 'tracked_job') return session.from(table)
        const q: Record<string, unknown> = {}
        for (const m of ['select', 'in', 'gte', 'order']) q[m] = () => q
        q.limit = () => Promise.resolve({ data: null, error: { message: 'permission denied' } })
        return q
      },
    }
    hoisted.session = failing
    const res = await GET(req('?light=1'))
    expect(res.status).toBe(500)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe('Could not read the work feed')
  })
  it('?light=1: the open rows in light columns, card rows, the roster with its breakers; no chips, no admin read', async () => {
    session.seed('tracked_job', [
      job({ id: 'live', status: 'running', ai_team_member_id: 'writer' }),
      job({ id: 'waiting', status: 'needs_review', ai_team_member_id: 'writer' }),
      job({ id: 'settled', status: 'done' }),
      job({ id: 'verdict', flow_run_id: 'fr1', status: 'done', ai_team_member_id: 'triage' }),
    ])
    session.seed('attention_item', [
      { id: 'c1', workspace_id: 'w1', status: 'pending', source_flow_run_id: 'fr1', expires_at: null, created_at: new Date().toISOString() },
    ])
    session.seed('work_touch', [{ work_item_id: 'live', entity_type: 'contact', entity_id: 'c1', verb: 'wrote', at: new Date().toISOString() }])
    session.seed('ai_team_member', [mate({ id: 'writer', role: 'writer', autonomy: 'attempt', bot_character: 'writer' })])
    service.seed('ai_team_member', [mate({ id: 'writer', role: 'writer' })])

    const res = await GET(req('?light=1'))
    expect(res.status).toBe(200)
    const body = await readJson<{
      light: boolean
      items: Array<{ id: string }>
      card_rows: Array<{ id: string }>
      roster: Array<{ id: string; bot_character: string | null; breaker: unknown }>
      workspace_ids: string[]
      current_workspace_id: string
      chips?: unknown
      manage_workspace_ids?: unknown
    }>(res)
    expect(body.light).toBe(true)
    // A settled row that made nothing (or names no teammate) isn't a done peek's: not here.
    expect(body.items.map((i) => i.id).sort()).toEqual(['live', 'waiting'])
    expect(body.card_rows.map((r) => r.id)).toEqual(['verdict'])
    // bots-v4 Phase 4b: the breaker comes with the light read too ("Attempts paused" without an Agents page).
    expect(body.roster).toEqual([expect.objectContaining({ id: 'writer', bot_character: 'writer', breaker: { paused: false, window: expect.any(Number) } })])
    expect(body.workspace_ids).toEqual(['w1', 'w2'])
    expect(body.current_workspace_id).toBe('w1')
    expect(body.chips).toBeUndefined()
    expect(body.manage_workspace_ids).toBeUndefined()

    // Light columns, scoped by workspace, open statuses only.
    const feedRead = session.selects.find((c) => c.table === 'tracked_job')!
    expect(feedRead.columns).not.toContain('*')
    expect(feedRead.columns).toMatch(/\bsource\b/)
    // An opened row stops beckoning (migration 295): the light answer must say which.
    expect(feedRead.columns).toMatch(/\bopened_at\b/)
    // A row's waiting episode (its status and what it asks): a new question is new again for its bot.
    expect(feedRead.columns).toMatch(/\bstatus\b/)
    expect(feedRead.columns).toMatch(/\bneeds\b/)
    expect(feedRead.columns).toMatch(/teammate:ai_team_member_id\([^)]*\bbot_character\b[^)]*\)/)
    const openRead = session.calls.find((c) => c.table === 'tracked_job' && c.filters.some(([col]) => col === 'status'))!
    expect(openRead.filters).toContainEqual(['workspace_id', ['w1', 'w2']])
    expect(openRead.filters.map(([col]) => col)).not.toContain('member_id')
    // Nothing the counts do not need.
    expect(session.calls.some((c) => c.table === 'work_touch')).toBe(false)
    expect(session.calls.some((c) => c.table === 'member')).toBe(false)
    // The service client reads only the breaker: the policy, the role's teammates, its attempts.
    expect(new Set(service.calls.map((c) => c.table))).toEqual(new Set(['workspace', 'ai_team_member', 'tracked_job']))
    const attempts = service.calls.find((c) => c.table === 'tracked_job')!
    expect(attempts.filters).toContainEqual(['origin', 'attempt'])
  })

  it('?light=1: each roster entry says whether you may talk to it (bots-v4 Phase C), and the agent it’s built on', async () => {
    // Only the columns each read names come back, as PostgREST answers.
    session = makeFakeSupabase({ project: true })
    hoisted.session = session
    session.seed('ai_team_member', [
      mate({ id: 'triage', team_id: null, is_system: true, system_key: 'triage', bot_character: 'triage' }),
      mate({ id: 'writer', team_id: 'team-open', bot_character: 'writer', agent_recipe_id: 'role-writer' }),
      mate({ id: 'closer', team_id: 'team-private', bot_character: 'research' }),
    ])
    session.seed('team', [
      { id: 'team-open', workspace_id: 'w1', is_private: false },
      { id: 'team-private', workspace_id: 'w1', is_private: true },
    ])
    // An owner or admin sees the private team's teammate under RLS, but holds no seat on it.
    session.seed('member', [{ id: 'm1', user_id: 'user-1', workspace_id: 'w1' }])
    session.seed('team_member', [])
    const body = await readJson<{ roster: Array<{ id: string; reachable?: boolean; agent_recipe_id?: string | null }> }>(await GET(req('?light=1')))
    expect(Object.fromEntries(body.roster.map((m) => [m.id, m.reachable]))).toEqual({ triage: true, writer: true, closer: false })
    expect(body.roster.find((m) => m.id === 'writer')!.agent_recipe_id).toBe('role-writer')
    // No role that attempts, so no breaker to read on the service client.
    expect(service.calls).toEqual([])
  })

  it('card_rows covers every pending, unexpired card, past 50', async () => {
    const DAY = 86_400_000
    const verdicts = Array.from({ length: 60 }, (_, i) =>
      job({
        id: `verdict-${i}`,
        flow_run_id: `fr-${i}`,
        status: 'done',
        ai_team_member_id: 'triage',
        // The first ten settled inside the feed's window, the rest weeks ago.
        created_at: new Date(Date.now() - (i < 10 ? 1 : 20 + i) * DAY).toISOString(),
      }),
    )
    session.seed('tracked_job', verdicts)
    session.seed('attention_item', [
      ...verdicts.map((v, i) => ({
        id: `card-${i}`,
        workspace_id: 'w1',
        status: 'pending',
        source_flow_run_id: `fr-${i}`,
        expires_at: i % 2 ? null : new Date(Date.now() + DAY).toISOString(),
        created_at: new Date(Date.now() - i * MIN).toISOString(),
      })),
      // Expired or resolved cards find no owner here.
      { id: 'expired', workspace_id: 'w1', status: 'pending', source_flow_run_id: 'fr-expired', expires_at: new Date(Date.now() - MIN).toISOString(), created_at: new Date().toISOString() },
      { id: 'resolved', workspace_id: 'w1', status: 'accepted', source_flow_run_id: 'fr-resolved', expires_at: null, created_at: new Date().toISOString() },
    ])
    session.seed('tracked_job', [
      job({ id: 'expired-run', flow_run_id: 'fr-expired', created_at: new Date(Date.now() - 30 * DAY).toISOString() }),
      job({ id: 'resolved-run', flow_run_id: 'fr-resolved', created_at: new Date(Date.now() - 30 * DAY).toISOString() }),
    ])
    const all = verdicts.map((v) => v.id).sort()

    const light = await readJson<{ items: Array<{ id: string }>; card_rows: Array<{ id: string }> }>(await GET(req('?light=1')))
    // Light holds no settled row, so every card's run comes as a card row.
    expect(light.items).toEqual([])
    expect(light.card_rows.map((r) => r.id).sort()).toEqual(all)
    expect(light.card_rows.some((r) => r.id === 'expired-run' || r.id === 'resolved-run')).toBe(false)
  })

  it('before migration 295: the light read is a 500', async () => {
    session.seed('tracked_job', [
      job({ id: 'waiting', status: 'needs_review', ai_team_member_id: 'writer' }),
      job({ id: 'old-verdict', flow_run_id: 'fr-old', status: 'done', ai_team_member_id: 'triage', created_at: new Date(Date.now() - 21 * 86_400_000).toISOString() }),
    ])
    session.seed('attention_item', [
      { id: 'c1', workspace_id: 'w1', status: 'pending', source_flow_run_id: 'fr-old', expires_at: null, created_at: new Date().toISOString() },
    ])
    // PostgREST on a database without the column: any tracked_job read naming it fails.
    const real = session
    let namedIt = 0
    hoisted.session = {
      ...real,
      from: (table: string) => {
        const q = real.from(table) as Record<string, (...args: unknown[]) => unknown>
        if (table !== 'tracked_job') return q
        const select = q.select
        let missing = false
        q.select = (cols?: unknown, opts?: unknown) => {
          if (typeof cols === 'string' && /\bopened_at\b/.test(cols)) {
            missing = true
            namedIt += 1
          }
          select(cols, opts)
          return q
        }
        const then = q.then
        q.then = (resolve: unknown, reject: unknown) =>
          missing
            ? Promise.resolve({ data: null, error: { code: '42703', message: 'column tracked_job.opened_at does not exist' } }).then(
                resolve as (v: unknown) => unknown,
                reject as (e: unknown) => unknown,
              )
            : then(resolve, reject)
        return q
      },
    }

    const light = await GET(req('?light=1'))
    expect(light.status).toBe(500)
    expect(namedIt).toBeGreaterThan(0)
  })

  // ── bots-v4 Phase 4b: the light read's done rows and the AI limit ──

  const HOUR = 60 * MIN
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
  const DRAFTS = [
    { type: 'email_draft', id: 'draft-1', label: 'Re: pricing' },
    { type: 'email_draft', id: 'draft-2', label: 'Re: demo' },
  ]
  const donePass = (id: string, over: Record<string, unknown> = {}) =>
    job({
      id,
      kind: 'email_drafts',
      status: 'done',
      ai_team_member_id: 'mail',
      title: `Drafting pass ${id}`,
      deliverables: DRAFTS,
      needs: null,
      opened_at: null,
      result_summary: 'a long summary the light read never carries',
      progress: { steps: ['a', 'b'] },
      created_at: ago(2 * HOUR),
      finished_at: ago(2 * HOUR - MIN),
      ...over,
    })

  it('?light=1: the last day’s done runs that made something and weren’t opened, with deliverables, finished_at and title', async () => {
    session = makeFakeSupabase({ project: true })
    hoisted.session = session
    session.seed('tracked_job', [
      job({ id: 'live', status: 'running', ai_team_member_id: 'writer' }),
      donePass('drafted'),
      donePass('w2-drafted', { workspace_id: 'w2', member_id: 'm2', created_at: ago(3 * HOUR), finished_at: ago(3 * HOUR - MIN) }),
      // Opened already: its peek is gone everywhere.
      donePass('opened', { opened_at: ago(HOUR) }),
      // Finished more than a day ago: history, not news.
      donePass('stale', { created_at: ago(30 * HOUR), finished_at: ago(30 * HOUR - MIN) }),
      // Only cards (a batch's, peeking as needs-you), nothing at all, or no teammate: no done peek.
      donePass('cards-only', { deliverables: [{ type: 'attention_cards', id: 'run-1', label: '3 cards' }] }),
      donePass('nothing-made', { deliverables: [] }),
      donePass('no-teammate', { ai_team_member_id: null }),
      // Started before the start window (two days): not read, a known gap (its push is held when it settles live).
      donePass('long-runner', { created_at: ago(72 * HOUR), finished_at: ago(HOUR) }),
      // Another member's row (RLS hides it as well): the read names the caller's members.
      donePass('someone-else', { member_id: 'm9' }),
    ])

    const body = await readJson<{ items: Array<Record<string, unknown>> }>(await GET(req('?light=1')))
    // The open rows first, then the done ones, newest first.
    expect(body.items.map((i) => i.id)).toEqual(['live', 'drafted', 'w2-drafted'])
    const drafted = body.items.find((i) => i.id === 'drafted')!
    expect(drafted).toMatchObject({ status: 'done', ai_team_member_id: 'mail', title: 'Drafting pass drafted', deliverables: DRAFTS, opened_at: null })
    expect(typeof drafted.finished_at).toBe('string')
    // Only what a done peek needs: no summary, no progress.
    expect(drafted).not.toHaveProperty('result_summary')
    expect(drafted).not.toHaveProperty('progress')

    const doneRead = session.calls.find((c) => c.table === 'tracked_job' && c.filters.some(([col, v]) => col === 'status' && v === 'done'))!
    expect(doneRead.filters).toContainEqual(['member_id', ['m1', 'm2']])
    expect(doneRead.filters).toContainEqual(['workspace_id', ['w1', 'w2']])
    const doneSelect = session.selects.filter((s) => s.table === 'tracked_job').find((s) => /\bdeliverables\b/.test(s.columns))!
    expect(doneSelect.columns).toMatch(/\bfinished_at\b/)
    expect(doneSelect.columns).toMatch(/\btitle\b/)
    expect(doneSelect.columns).not.toContain('*')
  })

  // Review of #650: the cap was applied before "made something", so a busy run
  // of empty (or cards-only) done rows pushed an older drafting pass out.
  it('?light=1: an older drafting pass behind 50 newer runs that made nothing is still kept', async () => {
    session = makeFakeSupabase({ project: true })
    hoisted.session = session
    session.seed('tracked_job', [
      ...Array.from({ length: 50 }, (_, i) =>
        donePass(`empty-${i}`, { kind: 'extraction', ai_team_member_id: 'extraction', deliverables: [], created_at: ago(MIN * (i + 1)), finished_at: ago(MIN * (i + 1)) }),
      ),
      donePass('older-drafts', { created_at: ago(5 * HOUR), finished_at: ago(5 * HOUR - MIN) }),
    ])
    const body = await readJson<{ items: Array<{ id: string }> }>(await GET(req('?light=1')))
    expect(body.items.map((i) => i.id)).toEqual(['older-drafts'])
  })

  it('?light=1: … and behind 60 newer cards-only verdicts (read past them, kept after the filter)', async () => {
    session = makeFakeSupabase({ project: true })
    hoisted.session = session
    session.seed('tracked_job', [
      ...Array.from({ length: 60 }, (_, i) =>
        donePass(`verdict-${i}`, {
          kind: 'flow_run',
          ai_team_member_id: 'triage',
          deliverables: [{ type: 'attention_cards', id: `run-${i}`, label: '2 cards' }],
          created_at: ago(MIN * (i + 1)),
          finished_at: ago(MIN * (i + 1)),
        }),
      ),
      donePass('older-drafts', { created_at: ago(5 * HOUR), finished_at: ago(5 * HOUR - MIN) }),
    ])
    const body = await readJson<{ items: Array<{ id: string }> }>(await GET(req('?light=1')))
    expect(body.items.map((i) => i.id)).toEqual(['older-drafts'])
  })

  it('?light=1: keeps at most 50 done rows, the newest', async () => {
    session = makeFakeSupabase({ project: true })
    hoisted.session = session
    session.seed(
      'tracked_job',
      Array.from({ length: 60 }, (_, i) => donePass(`drafted-${i}`, { created_at: ago(MIN * (i + 1)), finished_at: ago(MIN * (i + 1)) })),
    )
    const body = await readJson<{ items: Array<{ id: string }> }>(await GET(req('?light=1')))
    expect(body.items).toHaveLength(50)
    expect(body.items[0].id).toBe('drafted-0')
    expect(body.items.at(-1)!.id).toBe('drafted-49')
  })

  it('ai_limited: whose newest run in the last 48 hours the usage limit stopped, as the caller’s member; a later run clears it', async () => {
    session = makeFakeSupabase({ project: true })
    hoisted.session = session
    const LIMIT = 'AI usage limit exceeded (plan limit) — skill run skipped'
    const failed = (id: string, teammate: string, at: string, message = LIMIT, over: Record<string, unknown> = {}) =>
      job({ id, status: 'failed', ai_team_member_id: teammate, error_message: message, created_at: at, finished_at: at, ...over })
    const stoppedAt = ago(3 * HOUR)
    session.seed('tracked_job', [
      failed('writer-stopped', 'writer', stoppedAt),
      failed('writer-older', 'writer', ago(5 * HOUR)),
      // Stopped, then a run that settled since: awake again.
      failed('research-stopped', 'research', ago(5 * HOUR)),
      job({ id: 'research-later', status: 'done', ai_team_member_id: 'research', created_at: ago(HOUR), finished_at: ago(HOUR) }),
      // Stopped, then a run going now: not stopped (it's working).
      failed('dev-stopped', 'dev', ago(4 * HOUR)),
      job({ id: 'dev-running', status: 'running', ai_team_member_id: 'dev', created_at: ago(10 * MIN) }),
      // A plain failure isn't the limit.
      failed('triage-timeout', 'triage', ago(HOUR), 'timed out at 120s'),
      // Longer ago than 48 hours.
      failed('mail-old', 'mail', ago(50 * HOUR)),
      // Another member's run (RLS hides it as well).
      failed('someone-else', 'extraction', ago(HOUR), LIMIT, { member_id: 'm9' }),
      // In the caller's other workspace, said another way.
      failed('w2-stopped', 'w2-writer', ago(2 * HOUR), 'Usage limit reached', { workspace_id: 'w2', member_id: 'm2', finished_at: null }),
    ])

    const light = await readJson<{ ai_limited: Array<{ teammate_id: string; workspace_id: string; at: string }>; ai_limited_as_of: string }>(
      await GET(req('?light=1')),
    )
    expect([...light.ai_limited].sort((a, b) => a.teammate_id.localeCompare(b.teammate_id))).toEqual([
      { teammate_id: 'w2-writer', workspace_id: 'w2', at: expect.any(String) },
      { teammate_id: 'writer', workspace_id: 'w1', at: stoppedAt },
    ])
    expect(Number.isFinite(Date.parse(light.ai_limited_as_of))).toBe(true)
    // Read as the caller's members, the usage-limit failures in the window.
    const failures = session.calls.find((c) => c.table === 'tracked_job' && c.filters.some(([col, v]) => col === 'status' && v === 'failed'))!
    expect(failures.filters).toContainEqual(['member_id', ['m1', 'm2']])
  })

  it('?light=1: a failed done-rows or AI-limit read is none of them, never a failed light read', async () => {
    session.seed('tracked_job', [job({ id: 'live', status: 'running', ai_team_member_id: 'writer' }), donePass('drafted')])
    const real = session
    hoisted.session = {
      ...real,
      from: (table: string) => {
        const q = real.from(table) as Record<string, (...args: unknown[]) => unknown>
        if (table !== 'tracked_job') return q
        let failing = false
        const eq = q.eq
        q.eq = (col: unknown, v: unknown) => {
          if (col === 'status' && (v === 'done' || v === 'failed')) failing = true
          eq(col, v)
          return q
        }
        const then = q.then
        q.then = (resolve: unknown, reject: unknown) =>
          failing
            ? Promise.resolve({ data: null, error: { message: 'statement timeout' } }).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown)
            : then(resolve, reject)
        return q
      },
    }
    const res = await GET(req('?light=1'))
    expect(res.status).toBe(200)
    const body = await readJson<{ items: Array<{ id: string }>; ai_limited: unknown[] }>(res)
    expect(body.items.map((i) => i.id)).toEqual(['live'])
    expect(body.ai_limited).toEqual([])
  })
})
