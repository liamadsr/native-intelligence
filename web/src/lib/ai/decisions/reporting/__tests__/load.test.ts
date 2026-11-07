import { createClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_PROJECTION, loadDecisionReport, REPORT_ROW_LIMITS, REPORT_TIMEOUT_MS, USAGE_PROJECTION, validateReportRange } from '../load'
import type { BrowserCommandReportRow, UsageReportRow } from '../types'
import { PARENT_USAGE_PROVIDERS } from '../provenance'

const admin = vi.hoisted(() => ({ requireAdmin: vi.fn(), getAdminServiceClient: vi.fn() }))
vi.mock('@/lib/admin', () => admin)
const range = { from: '2026-10-01T00:00:00Z', to: '2026-10-04T00:00:00Z' }
const workspace = '11111111-1111-4111-8111-111111111111'
const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
function usage(index: number): UsageReportRow {
  return { id: id(index), user_id: 'user', workspace_id: workspace, created_at: '2026-10-02T00:00:00Z',
    provider: 'typesafe-ai', feature: 'decision.browser.next_action', input_tokens: 10, output_tokens: 0, estimated_cost_usd: 0.01,
    usage_unknown: 'false', cost_unknown: 'false', outcome: 'accepted' }
}
function command(index = 1): BrowserCommandReportRow {
  return { id: id(index), user_id: 'user', workspace_id: workspace, created_at: '2026-10-02T00:00:00Z',
    claimed_at: null, finished_at: null, status: 'running', attribution_version: '1', parent_run_id: 'ai_chat:session:turn' }
}
function response(rows: unknown[], status = 200) { return new Response(JSON.stringify(rows), { status, headers: { 'Content-Type': 'application/json' } }) }
let requests: URL[]
let serve: (url: URL) => Promise<Response> | Response
beforeEach(() => {
  requests = []
  serve = () => response([])
  admin.requireAdmin.mockReset().mockResolvedValue({ id: 'admin', email: 'admin@dial8.ai' })
  admin.getAdminServiceClient.mockReset().mockResolvedValue(createClient('https://report-test.invalid', 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      requests.push(url)
      return serve(url)
    } },
  }))
})
afterEach(() => vi.useRealTimers())
const isCommands = (url: URL) => url.pathname.endsWith('/browser_command_queue')
const isParents = (url: URL) => url.searchParams.has('or')

describe('admin decision report loader', () => {
  it('loads only trusted helper rows scoped to the browser command IDs', async () => {
    serve = url => isCommands(url) ? response([command()]) : url.searchParams.get('feature') === 'eq.browser.field_text'
      ? response([{ ...usage(7), provider: 'deepseek', feature: 'browser.field_text', run_id: id(1) }]) : response([])
    const result = await loadDecisionReport(range)
    const query = requests.find(url => url.searchParams.get('feature') === 'eq.browser.field_text')!
    expect(query.searchParams.get('metadata->>run_id')).toBe(`in.(${id(1)})`)
    expect(query.searchParams.get('provider')).toBe(`in.(${PARENT_USAGE_PROVIDERS.join(',')})`)
    expect(query.searchParams.get('select')).toBe(USAGE_PROJECTION)
    expect(result.browser.fieldText.rows).toBe(1)
    expect(result.coverage.fieldTextUsage).toMatchObject({ rows: 1, partial: false })
  })
  it('requires admin before constructing a service client or fetching any rows', async () => {
    const denied = new Response('Unauthorized', { status: 401 })
    admin.requireAdmin.mockRejectedValue(denied)
    await expect(loadDecisionReport(range)).rejects.toBe(denied)
    expect(admin.getAdminServiceClient).not.toHaveBeenCalled()
    expect(requests).toHaveLength(0)
  })

  it('projects safe fields only and applies inclusive-from/exclusive-to and workspace filters', async () => {
    const result = await loadDecisionReport({ ...range, workspaceId: workspace })
    expect(requests).toHaveLength(2)
    for (const url of requests) {
      expect(url.searchParams.getAll('created_at')).toEqual(['gte.2026-10-01T00:00:00.000Z', 'lt.2026-10-04T00:00:00.000Z'])
      expect(url.searchParams.get('order')).toBe('created_at.asc,id.asc')
      expect(url.searchParams.get('limit')).toBe('1000')
      expect(url.searchParams.get(isCommands(url) ? 'workspace_id' : 'metadata->>workspace_id')).toBe(`eq.${workspace}`)
      const fields = url.searchParams.get('select')!.split(',')
      expect(fields).not.toEqual(expect.arrayContaining(['metadata', 'request', 'result', '*', 'error_message']))
      expect(url.searchParams.get('select')).toBe(isCommands(url) ? COMMAND_PROJECTION : USAGE_PROJECTION)
    }
    expect(requests.find(isCommands)?.searchParams.get('command')).toBe('eq.run_task')
    expect(requests.find(url => !isCommands(url))?.searchParams.get('feature')).toBe('like.decision.%')
    expect(requests.find(url => !isCommands(url))?.searchParams.get('provider')).toBe('eq.typesafe-ai')
    expect(result.coverage.partial).toBe(false)
  })

  it('loads past Supabase default 1000-row pages instead of silently truncating', async () => {
    serve = url => isCommands(url) ? response([]) : response(Array.from({ length: 1003 }, (_, i) => usage(i)).slice(Number(url.searchParams.get('offset')), Number(url.searchParams.get('offset')) + Number(url.searchParams.get('limit'))))
    const result = await loadDecisionReport(range)
    expect(result.overview.attempts).toBe(1003)
    expect(requests.filter(url => !isCommands(url)).map(url => url.searchParams.get('offset'))).toEqual(['0', '1000'])
    expect(result.coverage.decisions).toMatchObject({ rows: 1003, partial: false, truncated: false })
  })

  it('detects an extra row beyond the cap and labels the loaded subtotal as truncated', async () => {
    serve = url => {
      if (isCommands(url)) return response([])
      const offset = Number(url.searchParams.get('offset'))
      const limit = Number(url.searchParams.get('limit'))
      return response(Array.from({ length: limit }, (_, i) => usage(offset + i)))
    }
    const result = await loadDecisionReport(range)
    expect(result.overview.attempts).toBe(REPORT_ROW_LIMITS.decisions)
    expect(result.coverage.decisions).toMatchObject({ rows: REPORT_ROW_LIMITS.decisions, partial: true, truncated: true, error: null })
    expect(requests.at(-1)?.searchParams.get('limit')).toBe('1')
  })

  it('reports a failed later page while preserving the successfully loaded rows', async () => {
    serve = url => {
      if (isCommands(url)) return response([])
      if (url.searchParams.get('offset') === '0') return response(Array.from({ length: 1000 }, (_, i) => usage(i)))
      return new Response(JSON.stringify({ message: 'private diagnostic that must not appear in the report' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    }
    const result = await loadDecisionReport(range)
    expect(result.overview.attempts).toBe(1000)
    expect(result.coverage.decisions).toMatchObject({ rows: 1000, partial: true, error: 'unavailable' })
    expect(JSON.stringify(result)).not.toContain('private diagnostic')
  })

  it('queries exact origin and server-returned command links, then counts overlapping parent pages once', async () => {
    serve = url => {
      if (isCommands(url)) return response(Array.from({ length: 51 }, (_, i) => command(i)))
      if (!isParents(url)) return response([])
      return response([{ ...usage(500), feature: 'ai_chat', provider: 'claude', attribution_version: '1', usage_scope: 'eve_turn',
        parent_run_id: 'ai_chat:session:turn', usage_key: 'billing:turn', browser_command_ids: [id(1)], cost_source: 'eve_reported' }])
    }
    const result = await loadDecisionReport({ ...range, workspaceId: workspace })
    const parentQueries = requests.filter(isParents)
    expect(parentQueries).toHaveLength(2)
    expect(parentQueries[0].searchParams.get('or')).toContain('metadata->>parent_run_id.in.("ai_chat:session:turn")')
    expect(parentQueries[0].searchParams.get('or')).toContain(`metadata->browser_command_ids.cs.["${id(1)}"]`)
    expect(parentQueries[0].searchParams.get('feature')).toBe('eq.ai_chat')
    expect(parentQueries[0].searchParams.get('provider')).toBe(`in.(${PARENT_USAGE_PROVIDERS.join(',')})`)
    expect(parentQueries[0].searchParams.get('metadata->>attribution_version')).toBe('eq.1')
    expect(parentQueries[0].searchParams.get('metadata->>usage_scope')).toBe('in.(eve_turn,eve_compaction)')
    expect(result.browser.parent.rows).toBe(1)
    expect(result.browser.parent.knownCostUsd).toBe(0.01)
    expect(result.browser.commandsWithParentUsage).toBe(51)
  })

  it('rejects forged local rows even if a data source violates the provider filter', async () => {
    serve = url => {
      if (isCommands(url)) return response([command()])
      if (!isParents(url)) return response([{ ...usage(1), provider: 'claude-code-local', run_id: id(1) }])
      return response([{ ...usage(2), provider: 'claude-code-local', feature: 'ai_chat', attribution_version: '1',
        usage_scope: 'eve_turn', parent_run_id: 'ai_chat:session:turn', browser_command_ids: [id(1)] }])
    }
    const result = await loadDecisionReport(range)
    expect(result.overview.attempts).toBe(0)
    expect(result.browser.jev.rows).toBe(0)
    expect(result.browser.parent.rows).toBe(0)
    expect(result.browser.commandsWithParentUsage).toBe(0)
  })

  it('keeps unavailable command and dependent parent sources explicitly partial', async () => {
    serve = url => isCommands(url) ? new Response('{}', { status: 400 }) : response([])
    const result = await loadDecisionReport(range)
    expect(result.coverage.browserCommands).toMatchObject({ rows: 0, partial: true, error: 'unavailable' })
    expect(result.coverage.parentUsage.partial).toBe(true)
    expect(requests.filter(isParents)).toHaveLength(0)
  })

  it('bounds total time even if the HTTP transport never settles after abort', async () => {
    vi.useFakeTimers()
    serve = () => new Promise(() => {})
    const pending = loadDecisionReport(range)
    await vi.advanceTimersByTimeAsync(REPORT_TIMEOUT_MS + 1)
    const result = await pending
    expect(result.coverage.decisions.error).toBe('timeout')
    expect(result.coverage.browserCommands.error).toBe('timeout')
    expect(result.coverage.partial).toBe(true)
  })

  it('rejects unsafe or unbounded filters before fetching data', async () => {
    await expect(loadDecisionReport({ ...range, workspaceId: 'invalid,or=(true)' })).rejects.toThrow('UUID')
    expect(admin.getAdminServiceClient).not.toHaveBeenCalled()
  })
})

describe('report range validation', () => {
  it('accepts a bounded UTC range and canonicalizes milliseconds', () => {
    expect(validateReportRange(range)).toEqual({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-04T00:00:00.000Z' })
  })
  it('normalizes a valid workspace UUID before comparing metadata text', () => {
    expect(validateReportRange({ ...range, workspaceId: 'ABCDEF00-1234-5678-90AB-ABCDEF123456' }).workspaceId).toBe('abcdef00-1234-5678-90ab-abcdef123456')
  })
  it.each([
    { from: 'invalid', to: range.to },
    { from: '2026-02-31T00:00:00Z', to: range.to },
    { from: range.to, to: range.from },
    { from: range.from, to: range.from },
    { from: '2020-01-01T00:00:00Z', to: range.to },
    { from: '2026-10-01', to: range.to },
  ])('rejects malformed/empty/reversed/overlong ranges: %j', input => {
    expect(() => validateReportRange(input)).toThrow()
  })
})
