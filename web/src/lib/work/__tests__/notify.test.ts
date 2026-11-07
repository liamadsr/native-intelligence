/**
 * Work notices name their teammate (bots v3 1a): a `work_needs_you` /
 * `work_failed` row whose ledger row has a teammate carries the bot keys
 * (bot-notice.ts) with the line its bubble says, and speaks as the bot (1b):
 * the title is the teammate's name (the app's title when the name can't be
 * read), the body that line. A row with no teammate comes from its
 * workspace's Assistant (Liam, 2026-10-08: work with no bot is the
 * Assistant's); a sequence send's, or one with no Assistant to read, is
 * exactly what it was.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { WorkNotifyRow } from '../notify'

const h = vi.hoisted(() => ({ createNotification: vi.fn(async () => {}) }))
vi.mock('@/lib/notifications', () => ({ createNotification: h.createNotification }))

const { notifyWorkFailed, notifyWorkNeedsYou, needsYouCopy, failedCopy } = await import('../notify')

function row(over: Partial<WorkNotifyRow> = {}): WorkNotifyRow {
  return {
    id: 'job-1',
    workspace_id: 'ws-1',
    member_id: 'm-1',
    kind: 'work_run',
    title: 'Follow up with Acme',
    needs: { kind: 'input', questions: ['Which Acme contact should get this?'] },
    deliverables: [],
    result_summary: null,
    error_message: null,
    ...over,
  }
}

/** A client whose ai_team_member read answers `teammate`, and whose notification read finds nothing. */
function client(teammate: { name?: string | null; role?: string | null } | null) {
  const reads: string[] = []
  const chain = (table: string) => {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'limit']) c[m] = () => c
    c.maybeSingle = async () => {
      reads.push(table)
      return { data: table === 'ai_team_member' ? teammate : null, error: null }
    }
    c.then = (resolve: (v: unknown) => unknown) => {
      reads.push(table)
      return Promise.resolve({ data: [], error: null }).then(resolve)
    }
    return c
  }
  // The Assistant's self-heal seed (system-teammates.ts): answers, seeds nothing.
  const rpc = async (name: string) => {
    reads.push(`rpc:${name}`)
    return { data: null, error: null }
  }
  return { client: { from: chain, rpc } as unknown as SupabaseClient, reads }
}

function sent(): Record<string, unknown> {
  return (h.createNotification.mock.calls.at(-1) as unknown[])[0] as Record<string, unknown>
}

beforeEach(() => h.createNotification.mockClear())

describe('notifyWorkNeedsYou', () => {
  it('names the teammate with its name, the bubble’s line and the run, and speaks as the bot', async () => {
    const r = row({ ai_team_member_id: 'tm-writer' })
    const { client: db } = client({ name: 'Writer' })
    expect(await notifyWorkNeedsYou(r, 'needs_input', db)).toBe(true)
    const n = sent()
    expect(n.title).toBe('Writer')
    expect(n.body).toBe('I have a question: which Acme contact should get this?')
    expect(n.metadata).toEqual({
      kind: 'work_run',
      status: 'needs_input',
      teammate_id: 'tm-writer',
      teammate_name: 'Writer',
      sentence: 'I have a question: which Acme contact should get this?',
      work_item_id: 'job-1',
    })
  })

  it('a waiting deliverable says what it made', async () => {
    const r = row({
      ai_team_member_id: 'tm-writer',
      needs: { kind: 'review', verb: 'review' },
      deliverables: [{ type: 'document', id: 'doc-1', label: 'Q3 kickoff notes' }],
    })
    await notifyWorkNeedsYou(r, 'needs_review', client({ name: 'Writer' }).client)
    const meta = sent().metadata as Record<string, unknown>
    expect(meta.teammate_id).toBe('tm-writer')
    expect(typeof meta.sentence).toBe('string')
    expect(String(meta.sentence)).toMatch(/^I /)
  })

  it('goes out unsigned (no name) without a client to read it', async () => {
    const r = row({ ai_team_member_id: 'tm-writer' })
    await notifyWorkNeedsYou(r, 'needs_input')
    const meta = sent().metadata as Record<string, unknown>
    expect(meta.teammate_id).toBe('tm-writer')
    expect(meta.teammate_name).toBeUndefined()
    // No name to sign with: the app's title, the bot's sentence.
    expect(sent().title).toBe(needsYouCopy(r, 'needs_input').title)
    expect(sent().body).toBe(meta.sentence)
  })

  it('a row with no teammate comes from its workspace’s Assistant, and speaks as it', async () => {
    const { client: db } = client({ id: 'tm-assistant', name: 'Assistant' } as never)
    await notifyWorkNeedsYou(row({ ai_team_member_id: null }), 'needs_input', db)
    expect(sent().title).toBe('Assistant')
    expect(sent().metadata).toEqual({
      kind: 'work_run',
      status: 'needs_input',
      teammate_id: 'tm-assistant',
      teammate_name: 'Assistant',
      sentence: 'I have a question: which Acme contact should get this?',
      work_item_id: 'job-1',
    })
  })

  it('a sequence send keeps no bot: exactly as it was, with no read', async () => {
    const { client: db, reads } = client({ id: 'tm-assistant', name: 'Assistant' } as never)
    const r = row({ kind: 'sequence_enrolment', ai_team_member_id: null })
    await notifyWorkNeedsYou(r, 'needs_input', db)
    expect(sent().metadata).toEqual({ kind: 'sequence_enrolment', status: 'needs_input' })
    expect([sent().title, sent().body]).toEqual([needsYouCopy(r, 'needs_input').title, needsYouCopy(r, 'needs_input').body])
    expect(reads).toEqual([])
  })

  it('with no Assistant to read (or no client), a row with no teammate is exactly as it was', async () => {
    const { client: db } = client(null)
    await notifyWorkNeedsYou(row({ ai_team_member_id: null }), 'needs_input', db)
    expect(sent().metadata).toEqual({ kind: 'work_run', status: 'needs_input' })
    expect([sent().title, sent().body]).toEqual([needsYouCopy(row(), 'needs_input').title, needsYouCopy(row(), 'needs_input').body])
    await notifyWorkNeedsYou(row(), 'needs_input')
    expect(sent().metadata).toEqual({ kind: 'work_run', status: 'needs_input' })
  })
})

describe('notifyWorkFailed', () => {
  it('names the teammate and says, as the bot, it could not finish', async () => {
    const r = row({ ai_team_member_id: 'tm-writer', needs: null, error_message: 'Model timed out', title: 'Q3 plan' })
    const { client: db } = client({ name: 'Writer' })
    expect(await notifyWorkFailed(db, r, { nowIso: '2026-10-02T10:00:00Z' })).toBe(true)
    const n = sent()
    expect([n.title, n.body]).toEqual(['Writer', "I couldn't finish 'Q3 plan'."])
    expect(n.metadata).toEqual({
      kind: 'work_run',
      teammate_id: 'tm-writer',
      teammate_name: 'Writer',
      sentence: "I couldn't finish 'Q3 plan'.",
      work_item_id: 'job-1',
    })
  })

  it('a row with no teammate fails as its workspace’s Assistant, grouped as its', async () => {
    const r = row({ kind: 'crm_import', needs: null, error_message: 'x', title: 'Importing from HubSpot' })
    await notifyWorkFailed(client({ id: 'tm-assistant', name: 'Assistant' } as never).client, r, { nowIso: '2026-10-02T10:00:00Z' })
    expect(sent()).toMatchObject({
      title: 'Assistant',
      groupKey: 'work_failed:ws-1:crm_import:tm-assistant:2026-10-02',
      metadata: { kind: 'crm_import', teammate_id: 'tm-assistant', teammate_name: 'Assistant', work_item_id: 'job-1' },
    })
  })

  it('a sequence send’s failure, or one with no Assistant to read, is exactly as it was', async () => {
    const seq = row({ kind: 'sequence_enrolment', needs: null, error_message: 'Bounced' })
    await notifyWorkFailed(client({ id: 'tm-assistant', name: 'Assistant' } as never).client, seq, { nowIso: '2026-10-02T10:00:00Z' })
    expect(sent().metadata).toEqual({ kind: 'sequence_enrolment' })
    expect(sent().groupKey).toBe('work_failed:ws-1:sequence_enrolment:2026-10-02')
    const r = row({ needs: null, error_message: 'x' })
    await notifyWorkFailed(client(null).client, r, { nowIso: '2026-10-02T10:00:00Z' })
    expect(sent().metadata).toEqual({ kind: 'work_run' })
    expect([sent().title, sent().body]).toEqual([failedCopy(r).title, failedCopy(r).body])
  })
})

// bots-v4 Phase 4c (review on #653): an unread failed run lights its own bot's
// dot, so each bot's failure of a kind gets a notice of its own that day; still
// one per bot per kind per day, so the banners stay few.
describe('failedGroupKey: one per (workspace, kind, teammate) per day', () => {
  it('names the teammate, so a second bot’s failure the same day isn’t folded into the first’s', async () => {
    const { failedGroupKey } = await import('../notify')
    const day = '2026-10-02T10:00:00Z'
    const writer = failedGroupKey({ workspace_id: 'ws-1', kind: 'work_run', ai_team_member_id: 'tm-writer' }, day)
    const triage = failedGroupKey({ workspace_id: 'ws-1', kind: 'work_run', ai_team_member_id: 'tm-triage' }, day)
    expect(writer).toBe('work_failed:ws-1:work_run:tm-writer:2026-10-02')
    expect(triage).not.toBe(writer)
    // The same bot, the same kind, later that day: the same group (one notice).
    expect(failedGroupKey({ workspace_id: 'ws-1', kind: 'work_run', ai_team_member_id: 'tm-writer' }, '2026-10-02T23:00:00Z')).toBe(writer)
    // No teammate: the bell's one a day per kind, as before.
    expect(failedGroupKey({ workspace_id: 'ws-1', kind: 'work_run', ai_team_member_id: null }, day)).toBe('work_failed:ws-1:work_run:2026-10-02')
  })

  it('a second bot’s failure that day is sent; the same bot’s second is not', async () => {
    const sentGroups = new Set<string>()
    // A notification read that finds a group already sent.
    const db = {
      from: () => {
        let group = ''
        const c: Record<string, unknown> = {}
        c.select = () => c
        c.limit = () => c
        c.eq = (col: string, v: unknown) => {
          if (col === 'group_key') group = String(v)
          return c
        }
        c.maybeSingle = async () => ({ data: { name: 'Bot' }, error: null })
        c.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: sentGroups.has(group) ? [{ id: 'n' }] : [], error: null }).then(resolve)
        return c
      },
    } as unknown as SupabaseClient
    h.createNotification.mockImplementation((async (params: unknown) => {
      sentGroups.add(String((params as { groupKey: string }).groupKey))
    }) as never)
    const day = { nowIso: '2026-10-02T10:00:00Z' }
    expect(await notifyWorkFailed(db, row({ ai_team_member_id: 'tm-writer', needs: null }), day)).toBe(true)
    expect(await notifyWorkFailed(db, row({ id: 'job-2', ai_team_member_id: 'tm-triage', needs: null }), day)).toBe(true)
    expect(await notifyWorkFailed(db, row({ id: 'job-3', ai_team_member_id: 'tm-writer', needs: null }), day)).toBe(false)
    h.createNotification.mockImplementation(async () => {})
  })
})
