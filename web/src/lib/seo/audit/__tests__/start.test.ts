/**
 * Starting, stopping and deleting an audit (../start.ts): which site, the
 * one-at-a-time rule, what the row is created with, and that an audit never
 * sits at "queued" when its event could not be sent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
  SEO_AUDIT_REQUESTED: 'seo/audit.requested',
  SEO_AUDIT_CANCEL: 'seo/audit.cancel',
}))
const site = vi.hoisted(() => ({ workspaceSiteUrl: vi.fn() }))
vi.mock('../../site', () => site)
const store = vi.hoisted(() => ({ clearCrawlTables: vi.fn(async () => {}) }))
vi.mock('../store', () => ({ createAuditStore: () => store }))

import type { SupabaseClient } from '@supabase/supabase-js'
import { AUDIT_STARTS_PER_DAY, DEFAULT_AUDIT_PAGES, MAX_AUDIT_PAGES } from '../limits'
import type { AuditRow } from '../queries'
import { cancelSiteAudit, deleteSiteAudit, startSiteAudit } from '../start'

const WS = '0b0f6e0e-3f0a-4a52-9d2b-1f6f0f3f7a01'
const USER = '4d2c7b1a-9a53-4e0f-8f3e-2a6f1c9b7d02'
const AUDIT = '6f1d7c1e-58c8-4f0b-9c64-0d6a3f1f2a11'

function row(over: Partial<AuditRow> = {}): AuditRow {
  return {
    id: AUDIT,
    start_url: 'https://fernhillstudio.example/',
    origin: 'https://fernhillstudio.example',
    status: 'queued',
    phase: 'discovery',
    max_pages: 100,
    pages_crawled: 0,
    pages_queued: 0,
    critical_count: 0,
    warning_count: 0,
    info_count: 0,
    error_code: null,
    error_detail: null,
    started_by: USER,
    created_at: '2026-11-12T08:00:00.000Z',
    started_at: null,
    completed_at: null,
    ...over,
  }
}

interface Call {
  table: string
  op: 'select' | 'insert' | 'update' | 'delete' | 'rpc'
  payload?: Record<string, unknown>
  filters: Array<[string, unknown]>
}

/** A service client that records what was asked and answers from `answer`. */
function fakeSvc(answer: (call: Call) => { data: unknown; error: { message: string } | null }) {
  const calls: Call[] = []
  const svc = {
    rpc(name: string, args: Record<string, unknown>) {
      const call: Call = { table: name, op: 'rpc', payload: args, filters: [] }
      calls.push(call)
      return Promise.resolve(answer(call))
    },
    from(table: string) {
      const call: Call = { table, op: 'select', filters: [] }
      calls.push(call)
      const settle = () => Promise.resolve(answer(call))
      const chain: Record<string, unknown> = {
        insert: (payload: Record<string, unknown>) => ((call.op = 'insert'), (call.payload = payload), chain),
        update: (payload: Record<string, unknown>) => ((call.op = 'update'), (call.payload = payload), chain),
        delete: () => ((call.op = 'delete'), chain),
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        eq: (column: string, value: unknown) => (call.filters.push([column, value]), chain),
        in: (column: string, value: unknown) => (call.filters.push([column, value]), chain),
        single: settle,
        maybeSingle: settle,
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => settle().then(resolve, reject),
      }
      return chain
    },
  }
  return { svc: svc as unknown as SupabaseClient, calls }
}

/** The start function's answer, then the audit row it names. */
function starting(outcome: 'started' | 'live' | 'limit', live: Partial<AuditRow> = {}) {
  return fakeSvc((call) => {
    if (call.op === 'rpc') return { data: [{ outcome, audit_id: outcome === 'limit' ? null : AUDIT }], error: null }
    if (call.op === 'select') return { data: row(outcome === 'live' ? live : {}), error: null }
    return { data: null, error: null }
  })
}

/** No audit is live: the start function inserts the row. */
function idle() {
  return starting('started')
}

const startCall = (calls: Call[]) => calls.find((c) => c.op === 'rpc')!

const who = { workspaceId: WS, userId: USER }

beforeEach(() => {
  vi.clearAllMocks()
  site.workspaceSiteUrl.mockResolvedValue(null)
})

describe('startSiteAudit', () => {
  it('audits the address it is given: a bare domain becomes https, the row carries its origin and the default page budget', async () => {
    const { svc, calls } = idle()
    const send = vi.fn(async () => {})
    const out = await startSiteAudit(svc, who, { url: 'fernhillstudio.example' }, { send })
    expect(out).toMatchObject({ ok: true, audit: { id: AUDIT, host: 'fernhillstudio.example', status: 'queued' } })
    // One function call checks for a live audit, holds the daily limit and
    // inserts, under a lock per workspace: two starts can't both get in.
    const start = startCall(calls)
    expect(start.table).toBe('seo_audit_start')
    expect(start.payload).toEqual({
      p_workspace: WS,
      p_started_by: USER,
      p_start_url: 'https://fernhillstudio.example/',
      p_origin: 'https://fernhillstudio.example',
      p_max_pages: DEFAULT_AUDIT_PAGES,
      p_daily_limit: AUDIT_STARTS_PER_DAY,
    })
    expect(calls.some((c) => c.op === 'insert')).toBe(false)
    expect(send).toHaveBeenCalledWith({ name: 'seo/audit.requested', data: { auditId: AUDIT, workspaceId: WS } })
    expect(site.workspaceSiteUrl).not.toHaveBeenCalled()
  })

  it('with no address, audits the workspace’s own site; with none known, asks which', async () => {
    const send = vi.fn(async () => {})
    site.workspaceSiteUrl.mockResolvedValue('https://www.fernhillstudio.example')
    const first = idle()
    expect(await startSiteAudit(first.svc, who, {}, { send })).toMatchObject({ ok: true })
    expect(startCall(first.calls).payload).toMatchObject({ p_start_url: 'https://www.fernhillstudio.example/' })

    site.workspaceSiteUrl.mockResolvedValue(null)
    const second = idle()
    expect(await startSiteAudit(second.svc, who, { url: '   ' }, { send })).toMatchObject({ ok: false, code: 'NO_SITE' })
    expect(second.calls).toEqual([])
  })

  it('holds the page budget to its bounds', async () => {
    const send = vi.fn(async () => {})
    const big = idle()
    await startSiteAudit(big.svc, who, { url: 'fernhillstudio.example', maxPages: 99_999 }, { send })
    expect(startCall(big.calls).payload).toMatchObject({ p_max_pages: MAX_AUDIT_PAGES })
    const odd = idle()
    await startSiteAudit(odd.svc, who, { url: 'fernhillstudio.example', maxPages: 'lots' }, { send })
    expect(startCall(odd.calls).payload).toMatchObject({ p_max_pages: DEFAULT_AUDIT_PAGES })
  })

  it.each([
    ['http://localhost:3000', 'NOT_PUBLIC'],
    ['http://127.0.0.1/', 'NOT_PUBLIC'],
    ['http://169.254.169.254/latest/meta-data', 'NOT_PUBLIC'],
    ['http://printer.local', 'NOT_PUBLIC'],
    ['ftp://fernhillstudio.example', 'INVALID_URL'],
    ['intranet', 'INVALID_URL'],
    ['https://user:secret@fernhillstudio.example', 'INVALID_URL'],
    ['https://fernhillstudio.example:8443/', 'INVALID_URL'],
  ])('refuses %s (%s) before anything is written or sent', async (url, code) => {
    const { svc, calls } = idle()
    const send = vi.fn(async () => {})
    expect(await startSiteAudit(svc, who, { url }, { send })).toMatchObject({ ok: false, code })
    expect(calls).toEqual([])
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses a second audit while one is queued or running, and hands back the live one', async () => {
    const { svc, calls } = starting('live', { status: 'running', phase: 'crawl' })
    const send = vi.fn(async () => {})
    const out = await startSiteAudit(svc, who, { url: 'fernhillstudio.example' }, { send })
    expect(out).toMatchObject({ ok: false, code: 'AUDIT_ALREADY_RUNNING', audit: { id: AUDIT, status: 'running' } })
    // The live one is read back within this workspace.
    expect(calls.find((c) => c.op === 'select')!.filters).toEqual([
      ['workspace_id', WS],
      ['id', AUDIT],
    ])
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses a start past the daily limit with AUDIT_LIMIT_REACHED, and sends nothing', async () => {
    const { svc, calls } = starting('limit')
    const send = vi.fn(async () => {})
    const out = await startSiteAudit(svc, who, { url: 'fernhillstudio.example' }, { send })
    expect(out).toMatchObject({ ok: false, code: 'AUDIT_LIMIT_REACHED' })
    expect((out as { message: string }).message).toMatch(/20 audits/)
    expect(calls.filter((c) => c.op !== 'rpc')).toEqual([])
    expect(send).not.toHaveBeenCalled()
  })

  it('a start the database refuses says so in plain words, never the database’s', async () => {
    const { svc } = fakeSvc(() => ({ data: null, error: { message: 'permission denied for function seo_audit_start' } }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = await startSiteAudit(svc, who, { url: 'fernhillstudio.example' }, { send: vi.fn() })
    expect(out).toMatchObject({ ok: false, code: 'START_FAILED' })
    expect(JSON.stringify(out)).not.toContain('permission')
  })

  it('an event that can’t be sent leaves the row failed, never queued forever', async () => {
    const { svc, calls } = idle()
    const send = vi.fn(async () => {
      throw new Error('inngest is down')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await startSiteAudit(svc, who, { url: 'fernhillstudio.example' }, { send })).toMatchObject({ ok: false, code: 'START_FAILED' })
    const update = calls.find((c) => c.op === 'update')!
    expect(update.payload).toMatchObject({ status: 'failed', error_code: 'START_FAILED' })
    expect(update.filters).toEqual([
      ['id', AUDIT],
      ['workspace_id', WS],
    ])
  })
})

describe('cancelSiteAudit', () => {
  it('stops a running audit: the status first (scoped to this workspace and to live rows), then the event, then the cleanup', async () => {
    let status: AuditRow['status'] = 'running'
    const { svc, calls } = fakeSvc((call) => {
      if (call.op === 'update') {
        status = 'canceled'
        return { data: null, error: null }
      }
      return { data: row({ status, phase: 'crawl' }), error: null }
    })
    const send = vi.fn(async () => {})
    const out = await cancelSiteAudit(svc, { workspaceId: WS }, AUDIT, { send })
    expect(out).toMatchObject({ ok: true, audit: { status: 'canceled' } })
    const update = calls.find((c) => c.op === 'update')!
    expect(update.payload).toMatchObject({ status: 'canceled', robots_txt: null })
    expect(update.filters).toEqual([
      ['id', AUDIT],
      ['workspace_id', WS],
      ['status', ['queued', 'running']],
    ])
    expect(send).toHaveBeenCalledWith({ name: 'seo/audit.cancel', data: { auditId: AUDIT } })
    expect(store.clearCrawlTables).toHaveBeenCalledTimes(1)
  })

  it('an audit that already ended, or another workspace’s, is refused untouched', async () => {
    const ended = fakeSvc(() => ({ data: row({ status: 'completed', phase: 'done' }), error: null }))
    expect(await cancelSiteAudit(ended.svc, { workspaceId: WS }, AUDIT, { send: vi.fn() })).toMatchObject({ ok: false, code: 'NOT_RUNNING' })
    expect(ended.calls.some((c) => c.op === 'update')).toBe(false)
    const missing = fakeSvc(() => ({ data: null, error: null }))
    expect(await cancelSiteAudit(missing.svc, { workspaceId: WS }, AUDIT, { send: vi.fn() })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(store.clearCrawlTables).not.toHaveBeenCalled()
  })

  it('still cancels when the event can’t be sent: the status alone stops the crawl', async () => {
    const { svc } = fakeSvc((call) => (call.op === 'update' ? { data: null, error: null } : { data: row({ status: 'running' }), error: null }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = await cancelSiteAudit(svc, { workspaceId: WS }, AUDIT, {
      send: vi.fn(async () => {
        throw new Error('down')
      }),
    })
    expect(out.ok).toBe(true)
    expect(store.clearCrawlTables).toHaveBeenCalledTimes(1)
  })
})

describe('deleteSiteAudit', () => {
  it('deletes an ended audit of this workspace', async () => {
    const { svc, calls } = fakeSvc((call) => (call.op === 'delete' ? { data: null, error: null } : { data: row({ status: 'completed', phase: 'done' }), error: null }))
    expect(await deleteSiteAudit(svc, { workspaceId: WS }, AUDIT)).toMatchObject({ ok: true })
    expect(calls.find((c) => c.op === 'delete')!.filters).toEqual([
      ['id', AUDIT],
      ['workspace_id', WS],
    ])
  })

  it('refuses while the audit is still running, and when it is not found', async () => {
    const live = fakeSvc(() => ({ data: row({ status: 'running' }), error: null }))
    expect(await deleteSiteAudit(live.svc, { workspaceId: WS }, AUDIT)).toMatchObject({ ok: false, code: 'STILL_RUNNING' })
    expect(live.calls.some((c) => c.op === 'delete')).toBe(false)
    const missing = fakeSvc(() => ({ data: null, error: null }))
    expect(await deleteSiteAudit(missing.svc, { workspaceId: WS }, AUDIT)).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })
})
