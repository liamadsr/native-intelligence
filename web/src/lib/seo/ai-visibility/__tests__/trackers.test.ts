/**
 * Recurring spend in the tracker cores (../trackers.ts), the one place the
 * routes and the agent's tools share:
 *
 *   - Turning a schedule on (from off or paused, or on a new tracker) needs
 *     the access check and `confirmed`, even with no prompts (a $0 to $0
 *     change asks too).
 *   - On a tracker whose schedule runs, ANY rise of the monthly cost (more
 *     prompts, prompts turned back on, more engines, weekly instead of
 *     monthly) needs both: no $0.25 floor, so one prompt at a time asks
 *     every time.
 *   - The access check runs first: a turn nobody is in, a workspace guest
 *     and a plan that does not pay are refused before being asked, and
 *     nothing is written.
 *   - created_by changes only to a person who passed it.
 */
import type { SeoDataAccess } from '@/lib/seo/access'
import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrackerRow } from '../queries'
import type { AiPromptView } from '../view'

const q = vi.hoisted(() => ({
  getTrackerRow: vi.fn(),
  listPrompts: vi.fn(),
  getLiveRun: vi.fn(),
}))
vi.mock('../queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../queries')>()),
  getTrackerRow: q.getTrackerRow,
  listPrompts: q.listPrompts,
  getLiveRun: q.getLiveRun,
}))
vi.mock('@/lib/seo/site', () => ({
  workspaceSiteUrl: vi.fn(async () => 'fernhillstudio.example.com'),
}))

const { addPrompts, createTracker, setPromptsActive, updateTracker } =
  await import('../trackers')

const WS = '00000000-0000-4000-8000-000000000001'
const TRACKER = '00000000-0000-4000-8000-000000000002'
const PERSON = '00000000-0000-4000-8000-0000000000aa'
const OWNER = '00000000-0000-4000-8000-0000000000bb'

const who = { workspaceId: WS, userId: PERSON }

function trackerRow(patch: Partial<TrackerRow> = {}): TrackerRow {
  return {
    id: TRACKER,
    workspace_id: WS,
    created_by: OWNER,
    brand_name: 'Fernhill Studio',
    brand_aliases: [],
    domain: 'fernhillstudio.example',
    competitors: [],
    location_code: 2840,
    language_code: 'en',
    engines: ['chatgpt', 'gemini'],
    schedule_interval: 'off',
    next_run_at: null,
    last_run_at: null,
    last_skip_reason: null,
    paused: false,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    ...patch,
  }
}

function prompt(id: string, active = true): AiPromptView {
  return {
    id,
    text: `question ${id}`,
    source: 'typed',
    active,
    created_at: '2026-11-01T00:00:00Z',
  }
}

/** A fake Supabase client: records writes, answers reads from `state`. */
function fakeSvc(state: { activePrompts: number; row: TrackerRow }) {
  const writes: Array<{ table: string; op: string; payload: unknown }> = []
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = []
  const from = (table: string) => {
    let op = 'select'
    let payload: unknown = null
    let head = false
    const b: Record<string, unknown> = {}
    const chain = () => b
    Object.assign(b, {
      select: (_f?: string, o?: { head?: boolean }) => {
        if (o?.head) head = true
        return b
      },
      update: (u: unknown) => {
        op = 'update'
        payload = u
        writes.push({ table, op, payload })
        return b
      },
      insert: (r: unknown) => {
        op = 'insert'
        payload = r
        writes.push({ table, op, payload })
        return b
      },
      eq: chain,
      neq: chain,
      in: chain,
      limit: chain,
      maybeSingle: async () => ({
        data: { ...state.row, ...(payload as object) },
        error: null,
      }),
      single: async () => ({
        data: { ...state.row, id: TRACKER, ...(payload as object) },
        error: null,
      }),
      then: (resolve: (v: unknown) => unknown) =>
        resolve(
          head
            ? { count: state.activePrompts, error: null }
            : op === 'update' && table === 'seo_ai_prompt'
              ? { data: [{ id: 'x' }], error: null }
              : { data: [], error: null },
        ),
    })
    return b
  }
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    rpcs.push({ fn, args })
    const rows = (args.p_rows as Array<Record<string, unknown>>) ?? []
    return {
      data: rows.map((r, i) => ({
        id: `new-${i}`,
        text: r.text,
        source: r.source,
        active: true,
        created_at: '2026-11-12T00:00:00Z',
      })),
      error: null,
    }
  }
  return {
    svc: { from, rpc } as unknown as SupabaseClient,
    writes,
    rpcs,
  }
}

/** The access check as ../access.ts runs it, over a person's standing. */
function accessFor(standing: 'member' | 'guest' | 'free' = 'member') {
  return vi.fn(
    async (w: {
      userId: string | null
      workspaceId?: string | null
      unattended?: boolean
    }): Promise<SeoDataAccess> => {
      if (w.unattended)
        return {
          ok: false,
          code: 'UNATTENDED',
          message: 'Only when the person asks.',
        }
      if (standing === 'guest')
        return { ok: false, code: 'NOT_A_MEMBER', message: 'Guests read.' }
      if (standing === 'free')
        return { ok: false, code: 'FREE_PLAN', message: 'Paid plan only.' }
      return { ok: true }
    },
  )
}

beforeEach(() => {
  q.getTrackerRow.mockReset()
  q.listPrompts.mockReset()
  q.getLiveRun.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const trackerWrites = (
  writes: Array<{ table: string; op: string; payload: unknown }>,
) => writes.filter((w) => w.table === 'seo_ai_tracker')

describe('turning a schedule on', () => {
  it('with no prompts, a $0 to $0 change still needs the yes, and nothing is written without it', async () => {
    const row = trackerRow()
    q.getTrackerRow.mockResolvedValue(row)
    const db = fakeSvc({ activePrompts: 0, row })
    const checkAccess = accessFor()
    const out = await updateTracker(
      db.svc,
      who,
      TRACKER,
      { schedule_interval: 'weekly' },
      {},
      { checkAccess },
    )
    expect(out).toMatchObject({
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      estimate: { monthly_usd: 0, schedule_interval: 'weekly' },
      previous_estimate: { monthly_usd: 0 },
    })
    expect(checkAccess).toHaveBeenCalledWith({
      userId: PERSON,
      workspaceId: WS,
      unattended: false,
    })
    expect(trackerWrites(db.writes)).toEqual([])
  })

  it('a turn nobody is in is refused before anything is written, even confirmed', async () => {
    const row = trackerRow()
    q.getTrackerRow.mockResolvedValue(row)
    const db = fakeSvc({ activePrompts: 0, row })
    const out = await updateTracker(
      db.svc,
      { ...who, unattended: true },
      TRACKER,
      { schedule_interval: 'weekly' },
      { confirmed: true },
      { checkAccess: accessFor() },
    )
    expect(out).toMatchObject({ ok: false, code: 'UNATTENDED' })
    expect(trackerWrites(db.writes)).toEqual([])
  })

  it('a workspace guest and a person whose plan does not pay are refused, even confirmed', async () => {
    for (const standing of ['guest', 'free'] as const) {
      const row = trackerRow({ schedule_interval: 'monthly', paused: true })
      q.getTrackerRow.mockResolvedValue(row)
      const db = fakeSvc({ activePrompts: 3, row })
      const out = await updateTracker(
        db.svc,
        who,
        TRACKER,
        { paused: false },
        { confirmed: true },
        { checkAccess: accessFor(standing) },
      )
      expect(out).toMatchObject({
        ok: false,
        code: standing === 'guest' ? 'NOT_A_MEMBER' : 'FREE_PLAN',
      })
      expect(trackerWrites(db.writes)).toEqual([])
    }
  })

  it('confirmed by a person who may spend: saved, and they own the schedule', async () => {
    const row = trackerRow()
    q.getTrackerRow.mockResolvedValue(row)
    const db = fakeSvc({ activePrompts: 0, row })
    const out = await updateTracker(
      db.svc,
      who,
      TRACKER,
      { schedule_interval: 'weekly' },
      { confirmed: true },
      { checkAccess: accessFor() },
    )
    expect(out.ok).toBe(true)
    expect(trackerWrites(db.writes)).toEqual([
      expect.objectContaining({
        op: 'update',
        payload: expect.objectContaining({
          schedule_interval: 'weekly',
          created_by: PERSON,
          last_skip_reason: null,
        }),
      }),
    ])
  })

  it('a new tracker with a schedule and no prompts needs the access check and the yes', async () => {
    const db = fakeSvc({ activePrompts: 0, row: trackerRow() })
    const unconfirmed = await createTracker(
      db.svc,
      who,
      { brand_name: 'Fernhill Studio', schedule_interval: 'monthly' },
      {},
      { checkAccess: accessFor() },
    )
    expect(unconfirmed).toMatchObject({
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
    })
    const free = await createTracker(
      db.svc,
      who,
      { brand_name: 'Fernhill Studio', schedule_interval: 'monthly' },
      { confirmed: true },
      { checkAccess: accessFor('free') },
    )
    expect(free).toMatchObject({ ok: false, code: 'FREE_PLAN' })
    expect(trackerWrites(db.writes)).toEqual([])
  })

  it('a new tracker without a schedule is free: no access check', async () => {
    const db = fakeSvc({ activePrompts: 0, row: trackerRow() })
    const checkAccess = accessFor('guest')
    const out = await createTracker(
      db.svc,
      who,
      { brand_name: 'Fernhill Studio' },
      {},
      { checkAccess },
    )
    expect(out.ok).toBe(true)
    expect(checkAccess).not.toHaveBeenCalled()
  })
})

describe('changes to a running schedule', () => {
  it('weekly instead of monthly raises the cost: the yes, and the person becomes the owner', async () => {
    const row = trackerRow({ schedule_interval: 'monthly' })
    q.getTrackerRow.mockResolvedValue(row)
    const db = fakeSvc({ activePrompts: 2, row })
    const unconfirmed = await updateTracker(
      db.svc,
      who,
      TRACKER,
      { schedule_interval: 'weekly' },
      {},
      { checkAccess: accessFor() },
    )
    expect(unconfirmed).toMatchObject({ code: 'CONFIRMATION_REQUIRED' })
    const ok = await updateTracker(
      db.svc,
      who,
      TRACKER,
      { schedule_interval: 'weekly' },
      { confirmed: true },
      { checkAccess: accessFor() },
    )
    expect(ok.ok).toBe(true)
    expect(trackerWrites(db.writes)[0]).toMatchObject({
      payload: { created_by: PERSON },
    })
  })

  it('monthly instead of weekly lowers the cost: no yes needed, but a guest can’t take the schedule over', async () => {
    const row = trackerRow({ schedule_interval: 'weekly' })
    q.getTrackerRow.mockResolvedValue(row)
    const db = fakeSvc({ activePrompts: 2, row })
    const guest = await updateTracker(
      db.svc,
      who,
      TRACKER,
      { schedule_interval: 'monthly' },
      {},
      { checkAccess: accessFor('guest') },
    )
    expect(guest).toMatchObject({ ok: false, code: 'NOT_A_MEMBER' })
    expect(trackerWrites(db.writes)).toEqual([])
    const member = await updateTracker(
      db.svc,
      who,
      TRACKER,
      { schedule_interval: 'monthly' },
      {},
      { checkAccess: accessFor() },
    )
    expect(member.ok).toBe(true)
    expect(trackerWrites(db.writes)[0]).toMatchObject({
      payload: { schedule_interval: 'monthly', created_by: PERSON },
    })
  })

  it('a change that costs nothing more needs no check, and leaves the owner alone', async () => {
    const row = trackerRow({ schedule_interval: 'weekly' })
    q.getTrackerRow.mockResolvedValue(row)
    const db = fakeSvc({ activePrompts: 2, row })
    const checkAccess = accessFor('guest')
    const out = await updateTracker(
      db.svc,
      { ...who, unattended: true },
      TRACKER,
      { brand_name: 'Fernhill' },
      {},
      { checkAccess },
    )
    expect(out.ok).toBe(true)
    expect(checkAccess).not.toHaveBeenCalled()
    const payload = trackerWrites(db.writes)[0].payload as Record<
      string,
      unknown
    >
    expect(payload).not.toHaveProperty('created_by')
  })
})

describe('prompts on a running schedule', () => {
  it('one prompt at a time asks every time (no $0.25 floor), and nothing is saved without the yes', async () => {
    const row = trackerRow({ schedule_interval: 'weekly' })
    q.getTrackerRow.mockResolvedValue(row)
    q.listPrompts.mockResolvedValue([])
    const db = fakeSvc({ activePrompts: 0, row })
    const out = await addPrompts(
      db.svc,
      who,
      TRACKER,
      [{ text: 'best design studio for small brands' }],
      {},
      { checkAccess: accessFor() },
    )
    expect(out).toMatchObject({
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      previous_estimate: { monthly_usd: 0 },
    })
    if (out.ok || out.code !== 'CONFIRMATION_REQUIRED') throw new Error()
    expect(out.estimate.monthly_usd).toBeGreaterThan(0)
    expect(out.estimate.monthly_usd).toBeLessThan(0.25)
    expect(db.rpcs).toEqual([])
  })

  it('a turn nobody is in can’t add them, even claiming the yes', async () => {
    const row = trackerRow({ schedule_interval: 'weekly' })
    q.getTrackerRow.mockResolvedValue(row)
    q.listPrompts.mockResolvedValue([prompt('a')])
    const db = fakeSvc({ activePrompts: 1, row })
    const out = await addPrompts(
      db.svc,
      { ...who, unattended: true },
      TRACKER,
      [{ text: 'who makes good brand identities' }],
      { confirmed: true },
      { checkAccess: accessFor() },
    )
    expect(out).toMatchObject({ ok: false, code: 'UNATTENDED' })
    expect(db.rpcs).toEqual([])
  })

  it('confirmed by a person who may spend: added', async () => {
    const row = trackerRow({ schedule_interval: 'weekly' })
    q.getTrackerRow.mockResolvedValue(row)
    q.listPrompts.mockResolvedValue([])
    const db = fakeSvc({ activePrompts: 0, row })
    const out = await addPrompts(
      db.svc,
      who,
      TRACKER,
      [{ text: 'best design studio for small brands' }],
      { confirmed: true },
      { checkAccess: accessFor() },
    )
    expect(out).toMatchObject({ ok: true, added: [{ id: 'new-0' }] })
    expect(db.rpcs).toHaveLength(1)
  })

  it('turning prompts back on asks the same way', async () => {
    const row = trackerRow({ schedule_interval: 'monthly' })
    q.getTrackerRow.mockResolvedValue(row)
    q.listPrompts.mockResolvedValue([prompt('a'), prompt('b', false)])
    const db = fakeSvc({ activePrompts: 1, row })
    const out = await setPromptsActive(
      db.svc,
      who,
      TRACKER,
      ['b'],
      true,
      {},
      { checkAccess: accessFor() },
    )
    expect(out).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED' })
    expect(db.writes.filter((w) => w.table === 'seo_ai_prompt')).toEqual([])
    const guest = await setPromptsActive(
      db.svc,
      who,
      TRACKER,
      ['b'],
      true,
      { confirmed: true },
      { checkAccess: accessFor('guest') },
    )
    expect(guest).toMatchObject({ ok: false, code: 'NOT_A_MEMBER' })
    expect(db.writes.filter((w) => w.table === 'seo_ai_prompt')).toEqual([])
  })

  it('without a running schedule, adding prompts is free: no check, no yes', async () => {
    for (const patch of [
      { schedule_interval: 'off' as const },
      { schedule_interval: 'weekly' as const, paused: true },
    ]) {
      const row = trackerRow(patch)
      q.getTrackerRow.mockResolvedValue(row)
      q.listPrompts.mockResolvedValue([])
      const db = fakeSvc({ activePrompts: 0, row })
      const checkAccess = accessFor('guest')
      const out = await addPrompts(
        db.svc,
        { ...who, unattended: true },
        TRACKER,
        [{ text: 'best design studio for small brands' }],
        {},
        { checkAccess },
      )
      expect(out.ok).toBe(true)
      expect(checkAccess).not.toHaveBeenCalled()
    }
  })
})
