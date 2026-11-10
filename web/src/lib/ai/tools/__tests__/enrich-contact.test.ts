/**
 * enrich_contact (src/lib/ai/tools/enrich-contact.ts): the chat's Enrich, on
 * the person's yes.
 *
 * Pinned:
 *   1. the module exports exactly enrich_contact, and its description is the
 *      registry's, within OpenAI's 1024 characters, naming the go-ahead;
 *   2. without confirmed_with_user: true it refuses (needs_go_ahead) and
 *      touches nothing; a background update can't call it at all, and a loop
 *      run's true flag is refused by its route;
 *   3. a contact the caller can't see (the write gate, contact_visible_to_
 *      ungranted, false: a per-item grant is read-only, migration 495), or one
 *      in a workspace they don't belong to, is "Contact not found" and nothing
 *      runs;
 *   4. a permanently-failed contact: ENRICHMENT_PERMANENTLY_FAILED, no mark, no event;
 *   5. a go: the row is marked pending, the Activity row opened, and
 *      crm/enrich-contact.manual sent with the button's payload;
 *   6. when the row settles: the columns this run filled (applied_fields less
 *      what was there before), their values with the web-derived ones fenced,
 *      and the status;
 *   7. still pending at the end of the wait: status running, "do not call again";
 *   8. a run already going for the contact is waited on, not searched again;
 *   9. a run the usage guard skipped (row left pending) reports the skip;
 *  10. a failed send: nothing ran, the Activity row settled failed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import type { SupabaseClient } from '@supabase/supabase-js'

type Row = Record<string, unknown>

const hoisted = vi.hoisted(() => ({
  inngestSend: vi.fn(),
  openManualEnrichment: vi.fn(),
  settleManualEnrichment: vi.fn(),
  findWork: vi.fn(),
  trackedJobs: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.inngestSend } }))
vi.mock('@/lib/work/enrichment-mirror', () => ({
  openManualEnrichment: hoisted.openManualEnrichment,
  settleManualEnrichment: hoisted.settleManualEnrichment,
}))
vi.mock('@/lib/work/recorder', () => ({ findWork: hoisted.findWork }))
vi.mock('@/lib/admin', () => ({
  // The service client the tool reads tracked_job with (runInFlight).
  getServiceClient: () => ({ from: (table: string) => tableChain(table, () => hoisted.trackedJobs, []) }),
}))

const { createEnrichContactTools, ENRICH_WAIT_MS } = await import('../enrich-contact')
const { ENRICH_CONTACT_DESCRIPTION } = await import('../enrich-contact-text')
const { getToolDefinition } = await import('../../tool-registry')
const { MAX_ADVERTISED_DESCRIPTION, withToolGuide } = await import('../../tool-guides')
const { serverTurnMayCall } = await import('@/lib/chat/chat-ceiling')
const { unattendedGoAheadRefusal } = await import('../go-ahead')

const USER = 'user-1'
const WS = 'ws-1'
const WS_OTHER = 'ws-2'
const EXEC = { toolCallId: 'call-1', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

type LogEntry = { table: string; op: string; val?: unknown }

/** A JSON-path-aware field read: `source->>record_id`. */
function field(row: Row, col: string): unknown {
  const [base, key] = col.split('->>')
  if (key === undefined) return row[col]
  const obj = row[base]
  return obj && typeof obj === 'object' ? String((obj as Row)[key] ?? '') : undefined
}

/** A lazy query-builder double: filters accumulate, a terminal await runs them. */
function tableChain(table: string, rows: () => Row[], log: LogEntry[]) {
  const preds: Array<(r: Row) => boolean> = []
  let mode: 'select' | 'update' = 'select'
  let patch: Row = {}
  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.order = () => chain
  chain.limit = () => chain
  chain.eq = (col: string, val: unknown) => {
    preds.push((r) => field(r, col) === val)
    return chain
  }
  chain.in = (col: string, vals: unknown[]) => {
    preds.push((r) => vals.includes(field(r, col)))
    return chain
  }
  // PostgREST's or-list, as the claim uses it: `col.is.null,col.neq.pending`.
  chain.or = (list: string) => {
    const terms = list.split(',').map((t) => {
      const [col, op, ...rest] = t.split('.')
      const val = rest.join('.')
      return (r: Row) =>
        op === 'is' ? field(r, col) == null : op === 'neq' ? field(r, col) !== val : op === 'eq' ? field(r, col) === val : false
    })
    preds.push((r) => terms.some((t) => t(r)))
    return chain
  }
  chain.update = (p: Row) => {
    log.push({ table, op: 'update', val: p })
    mode = 'update'
    patch = p
    return chain
  }
  const run = () => {
    const matched = rows().filter((r) => preds.every((p) => p(r)))
    if (mode === 'update') for (const r of matched) Object.assign(r, patch)
    return matched
  }
  // Copies, like the real client: a row read is a snapshot, not the stored row.
  chain.maybeSingle = async () => {
    const [first] = run()
    return { data: first ? { ...first } : null, error: null }
  }
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: run().map((r) => ({ ...r })), error: null }).then(resolve)
  return chain
}

function makeSupabase(opts: { contacts: Row[]; memberOf?: string[]; hidden?: string[] }) {
  const log: LogEntry[] = []
  const members = (opts.memberOf ?? [WS]).map((w) => ({ user_id: USER, workspace_id: w, id: `m-${w}` }))
  const supabase = {
    from: (table: string) => {
      if (table === 'contact') return tableChain(table, () => opts.contacts, log)
      if (table === 'member') return tableChain(table, () => members, log)
      throw new Error(`unexpected table ${table}`)
    },
    rpc: async (fn: string, args: { p_contact_id: string }) => {
      if (fn !== 'contact_visible_to_ungranted') throw new Error(`unexpected rpc ${fn}`)
      return { data: !(opts.hidden ?? []).includes(args.p_contact_id), error: null }
    },
  }
  return { supabase: supabase as unknown as SupabaseClient, log }
}

function contact(over: Row = {}): Row {
  return {
    id: 'c-1',
    workspace_id: WS,
    full_name: 'Dana Lee',
    email: 'dana@acme.com',
    enrichment_status: 'enriched',
    job_title: null,
    department: null,
    linkedin_url: 'https://linkedin.com/in/dana',
    metadata: { enrichment: { status: 'enriched', applied_fields: ['linkedin_url'] } },
    ...over,
  }
}

async function call(supabase: SupabaseClient, input: Record<string, unknown>) {
  const { enrich_contact } = createEnrichContactTools(USER, supabase, WS)
  const pending = Promise.resolve(enrich_contact.execute!(input as never, EXEC)) as unknown as Promise<Record<string, unknown>>
  await vi.advanceTimersByTimeAsync(ENRICH_WAIT_MS + 1_000)
  return pending
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  hoisted.inngestSend.mockResolvedValue({ ids: ['e'] })
  hoisted.openManualEnrichment.mockResolvedValue('manual:contact:c-1:run')
  hoisted.settleManualEnrichment.mockResolvedValue(undefined)
  hoisted.findWork.mockResolvedValue({ status: 'running' })
  hoisted.trackedJobs = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('enrich_contact: the contract', () => {
  it('the module exports exactly enrich_contact, described as the registry describes it', () => {
    const tools = createEnrichContactTools(USER, {} as SupabaseClient, WS)
    expect(Object.keys(tools)).toEqual(['enrich_contact'])
    expect(tools.enrich_contact.description).toBe(ENRICH_CONTACT_DESCRIPTION)
    const def = getToolDefinition('enrich_contact')
    expect(def).toMatchObject({ sideEffect: 'internal-write', writeTarget: 'crm', description: ENRICH_CONTACT_DESCRIPTION })
    expect(withToolGuide('enrich_contact', def!.description).length).toBeLessThanOrEqual(MAX_ADVERTISED_DESCRIPTION)
    const shape = (tools.enrich_contact.inputSchema as unknown as { shape: Record<string, unknown> }).shape
    expect(Object.keys(shape).sort()).toEqual(['confirmed_with_user', 'contact_id'])
  })

  it('nobody else can claim the yes: no background update runs it, and a loop run’s true flag is refused', () => {
    // A home turn (the meeting prep's report arriving, an event, …) is refused
    // by the chat tool route (SERVER_TURN_READ_ONLY); the person's own turns
    // are not server turns, and a channel turn is the person texting.
    for (const reason of ['helper_report', 'event', 'agent_answer', 'approval', 'guest_ask', 'digest'] as const) {
      expect([reason, serverTurnMayCall('enrich_contact', 'home_turn', reason)]).toEqual([reason, false])
    }
    expect(serverTurnMayCall('enrich_contact', 'channel_turn')).toBe(true)
    // The skill-run tool route's refusal for an unattended loop run (go-ahead.ts).
    expect(unattendedGoAheadRefusal({ contact_id: 'c-1', confirmed_with_user: true })).toMatchObject({ success: false, needs_go_ahead: true })
  })

  it('the description says: only after a yes, one contact per call, a paid web search', () => {
    expect(ENRICH_CONTACT_DESCRIPTION).toContain('confirmed_with_user: true')
    expect(ENRICH_CONTACT_DESCRIPTION).toContain('ONLY after the person said yes')
    expect(ENRICH_CONTACT_DESCRIPTION).toContain('One contact per call')
    expect(ENRICH_CONTACT_DESCRIPTION).toContain('one paid web search')
    expect(ENRICH_CONTACT_DESCRIPTION).toMatch(/rarely finds anything new/)
  })
})

describe('enrich_contact: refusals', () => {
  it('without the go-ahead: needs_go_ahead, nothing read, nothing sent', async () => {
    const { supabase, log } = makeSupabase({ contacts: [contact()] })
    const fromSpy = vi.spyOn(supabase, 'from')
    for (const confirmed of [false, undefined]) {
      const out = await call(supabase, { contact_id: 'c-1', confirmed_with_user: confirmed })
      expect(out).toMatchObject({ success: false, needs_go_ahead: true })
      expect(String(out.error)).toContain('confirmed_with_user: true')
    }
    expect(fromSpy).not.toHaveBeenCalled()
    expect(log).toEqual([])
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it("a contact the caller can't see is not found, and nothing runs", async () => {
    const { supabase, log } = makeSupabase({ contacts: [contact()], hidden: ['c-1'] })
    const out = await call(supabase, { contact_id: 'c-1', confirmed_with_user: true })
    expect(out).toEqual({ success: false, error: 'Contact not found' })
    expect(log).toEqual([])
    expect(hoisted.openManualEnrichment).not.toHaveBeenCalled()
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it("a contact in a workspace the caller doesn't belong to is not found", async () => {
    const { supabase, log } = makeSupabase({ contacts: [contact({ workspace_id: WS_OTHER })], memberOf: [WS] })
    const out = await call(supabase, { contact_id: 'c-1', confirmed_with_user: true })
    expect(out).toEqual({ success: false, error: 'Contact not found' })
    expect(log).toEqual([])
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it('a permanently-failed contact: ENRICHMENT_PERMANENTLY_FAILED, no mark, no event', async () => {
    const { supabase, log } = makeSupabase({
      contacts: [contact({ enrichment_status: 'failed', metadata: { enrichment: { status: 'failed', permanent: true } } })],
    })
    const out = await call(supabase, { contact_id: 'c-1', confirmed_with_user: true })
    expect(out).toMatchObject({ success: false, code: 'ENRICHMENT_PERMANENTLY_FAILED' })
    expect(String(out.error)).toContain('do not retry')
    expect(log).toEqual([])
    expect(hoisted.openManualEnrichment).not.toHaveBeenCalled()
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })
})

describe('enrich_contact: a run', () => {
  it('marks pending, opens the Activity row and sends the manual event with the button payload', async () => {
    const { supabase, log } = makeSupabase({ contacts: [contact()] })
    await call(supabase, { contact_id: 'c-1', confirmed_with_user: true })
    expect(log).toEqual([{ table: 'contact', op: 'update', val: { enrichment_status: 'pending' } }])
    expect(hoisted.openManualEnrichment).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: WS,
      userId: USER,
      table: 'contact',
      recordId: 'c-1',
      name: 'Dana Lee',
    })
    expect(hoisted.inngestSend).toHaveBeenCalledTimes(1)
    expect(hoisted.inngestSend).toHaveBeenCalledWith({
      name: 'crm/enrich-contact.manual',
      data: { contactId: 'c-1', workspaceId: WS, userId: USER, allowSelf: true, workRunKey: 'manual:contact:c-1:run' },
    })
  })

  it('returns the columns the run filled, their values (web ones fenced) and the status', async () => {
    const row = contact()
    const { supabase } = makeSupabase({ contacts: [row] })
    // The Inngest run settles the row as soon as the event is sent.
    hoisted.inngestSend.mockImplementationOnce(async () => {
      Object.assign(row, {
        enrichment_status: 'enriched',
        job_title: 'VP Sales',
        department: 'Sales',
        metadata: {
          enrichment: { status: 'enriched', applied_fields: ['linkedin_url', 'job_title', 'department'], summary: 'Dana leads sales at Acme.' },
        },
      })
      return { ids: ['e'] }
    })
    const out = await call(supabase, { contact_id: 'c-1', confirmed_with_user: true })
    expect(out).toMatchObject({
      success: true,
      contact_id: 'c-1',
      name: 'Dana Lee',
      status: 'enriched',
      filled_fields: ['job_title', 'department'],
      applied_fields: ['linkedin_url', 'job_title', 'department'],
    })
    const found = out.found as Record<string, string>
    expect(Object.keys(found).sort()).toEqual(['department', 'job_title'])
    expect(found.job_title).toContain('[UNTRUSTED WEB CONTENT')
    expect(found.job_title).toContain('VP Sales')
    expect(String(out.summary)).toContain('[UNTRUSTED WEB CONTENT')
    expect(String(out.message)).toContain('filled job_title, department')
  })

  it('a refresh that fills nothing new says so', async () => {
    const row = contact()
    const { supabase } = makeSupabase({ contacts: [row] })
    hoisted.inngestSend.mockImplementationOnce(async () => {
      row.enrichment_status = 'enriched'
      return { ids: ['e'] }
    })
    const out = await call(supabase, { contact_id: 'c-1', confirmed_with_user: true })
    expect(out).toMatchObject({ status: 'enriched', filled_fields: [], found: {} })
    expect(String(out.message)).toContain('no empty fields left to fill')
  })

  it('still pending when the wait runs out: status running, do not call again', async () => {
    const { supabase } = makeSupabase({ contacts: [contact()] })
    const out = await call(supabase, { contact_id: 'c-1', confirmed_with_user: true })
    expect(out).toMatchObject({ success: true, status: 'running', contact_id: 'c-1', name: 'Dana Lee' })
    expect(String(out.message)).toContain('do not call enrich_contact again')
    // Bounded: ten reads of the run's Activity row at most in the 45 s budget.
    expect(hoisted.findWork.mock.calls.length).toBeGreaterThan(0)
    expect(hoisted.findWork.mock.calls.length).toBeLessThanOrEqual(10)
    expect(hoisted.inngestSend).toHaveBeenCalledTimes(1)
  })

  it('a run already going for the contact is waited on, not searched again', async () => {
    const row = contact({ enrichment_status: 'pending' })
    const { supabase, log } = makeSupabase({ contacts: [row] })
    hoisted.trackedJobs = [
      { workspace_id: WS, kind: 'crm_enrichment', status: 'running', run_key: 'manual:contact:c-1:earlier', source: { record_id: 'c-1' } },
    ]
    const out = await call(supabase, { contact_id: 'c-1', confirmed_with_user: true })
    expect(out).toMatchObject({ success: true, status: 'running', already_running: true })
    expect(hoisted.findWork).toHaveBeenCalledWith(expect.anything(), { kind: 'crm_enrichment', runKey: 'manual:contact:c-1:earlier' })
    expect(log).toEqual([])
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it('a pending row with no live run (a stale mark) starts a new run', async () => {
    const { supabase } = makeSupabase({ contacts: [contact({ enrichment_status: 'pending' })] })
    hoisted.trackedJobs = [
      { workspace_id: WS, kind: 'crm_enrichment', status: 'failed', run_key: 'manual:contact:c-1:old', source: { record_id: 'c-1' } },
    ]
    await call(supabase, { contact_id: 'c-1', confirmed_with_user: true })
    expect(hoisted.inngestSend).toHaveBeenCalledTimes(1)
  })

  it('a run the usage guard skipped (row left pending) reports the skip', async () => {
    const { supabase } = makeSupabase({ contacts: [contact()] })
    hoisted.findWork.mockResolvedValue({ status: 'skipped', skip_reason: 'Usage limit reached' })
    const out = await call(supabase, { contact_id: 'c-1', confirmed_with_user: true })
    expect(out).toMatchObject({ success: true, status: 'skipped', reason: 'Usage limit reached', filled_fields: [] })
    expect(String(out.message)).toContain('usage limit')
  })

  // A transient failure (a 429, a 5xx) writes 'failed' and then throws for
  // Inngest to retry: not the outcome while the run's Activity row is live.
  it("a 'failed' row whose run is still retrying is not reported failed", async () => {
    const row = contact()
    const { supabase } = makeSupabase({ contacts: [row] })
    hoisted.inngestSend.mockImplementationOnce(async () => {
      row.enrichment_status = 'failed'
      return { ids: ['e'] }
    })
    const out = await call(supabase, { contact_id: 'c-1', confirmed_with_user: true })
    expect(out).toMatchObject({ success: true, status: 'running' })
  })

  it("a 'failed' row whose run has ended is the failure", async () => {
    const row = contact()
    const { supabase } = makeSupabase({ contacts: [row] })
    hoisted.inngestSend.mockImplementationOnce(async () => {
      Object.assign(row, { enrichment_status: 'failed', metadata: { enrichment: { status: 'failed', error: 'Exa 503' } } })
      return { ids: ['e'] }
    })
    hoisted.findWork.mockResolvedValue({ status: 'failed', error_message: 'Exa 503' })
    const out = await call(supabase, { contact_id: 'c-1', confirmed_with_user: true })
    expect(out).toMatchObject({ success: true, status: 'failed', reason: 'Exa 503' })
  })

  // A click and a chat yes at the same moment: one claim wins, one paid run.
  it('a contact claimed by another request between the read and the claim is waited on, not run twice', async () => {
    const row = contact()
    const { supabase } = makeSupabase({ contacts: [row] })
    // The button claims it after this call's read and before its claim.
    const realFrom = supabase.from.bind(supabase)
    let reads = 0
    ;(supabase as unknown as { from: (t: string) => unknown }).from = (table: string) => {
      const chain = realFrom(table) as unknown as Record<string, (...a: unknown[]) => unknown>
      if (table === 'contact') {
        const update = chain.update
        chain.update = (p: unknown) => {
          if ((p as Row).enrichment_status === 'pending' && reads++ === 0) row.enrichment_status = 'pending'
          return update(p)
        }
      }
      return chain
    }
    hoisted.trackedJobs = [
      { workspace_id: WS, kind: 'crm_enrichment', status: 'running', run_key: 'manual:contact:c-1:button', source: { record_id: 'c-1' } },
    ]
    const out = await call(supabase, { contact_id: 'c-1', confirmed_with_user: true })
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
    expect(hoisted.openManualEnrichment).not.toHaveBeenCalled()
    expect(out).toMatchObject({ success: true, status: 'running', already_running: true })
    expect(hoisted.findWork).toHaveBeenCalledWith(expect.anything(), { kind: 'crm_enrichment', runKey: 'manual:contact:c-1:button' })
  })

  it('a failed send: nothing ran, the Activity row is settled failed', async () => {
    const { supabase } = makeSupabase({ contacts: [contact()] })
    hoisted.inngestSend.mockRejectedValueOnce(new Error('inngest down'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = await call(supabase, { contact_id: 'c-1', confirmed_with_user: true })
    errorSpy.mockRestore()
    expect(out).toMatchObject({ success: false })
    expect(String(out.error)).toContain('nothing ran')
    expect(hoisted.settleManualEnrichment).toHaveBeenCalledWith(
      expect.anything(),
      'manual:contact:c-1:run',
      { status: 'failed', error: 'The search could not be queued' },
      { workspaceId: WS, table: 'contact', recordId: 'c-1' },
    )
  })
})
