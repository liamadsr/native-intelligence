/**
 * The work-agent's update_plan (A4 slice 2). Pins: the schema (1–12 steps of
 * at most 140 characters, the four statuses); it posts `{ kind: 'plan', steps }`
 * to the shared agent-run event route with the session's run token and the
 * internal secret; it returns the whole plan; a refusal comes back as words the
 * model can act on; and a canceling run is told to stop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import updatePlan, { updatePlanInput } from '../../tools/update_plan'

type Exec = (input: unknown, ctx: unknown) => Promise<Record<string, unknown>>
const execute = (updatePlan as unknown as { execute: Exec }).execute
const ctx = { session: { auth: { current: { attributes: { runToken: 'run.tok' } } } } }
const STEPS = [
  { text: 'Read the thread', status: 'done' },
  { text: 'Draft the reply', status: 'in_progress' },
  { text: 'Send for review', status: 'pending' },
]

const fetchMock = vi.fn()

beforeEach(() => {
  process.env.AGENT_RUN_INTERNAL_SECRET = 'sec'
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.AGENT_RUN_INTERNAL_SECRET
  delete process.env.NEXT_PUBLIC_APP_URL
})

function respond(status: number, body: unknown) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

describe('work-agent update_plan — schema', () => {
  it('takes 1–12 steps of a short line and a known status', () => {
    expect(updatePlanInput.safeParse({ steps: STEPS }).success).toBe(true)
    expect(updatePlanInput.safeParse({ steps: [] }).success).toBe(false)
    expect(updatePlanInput.safeParse({ steps: Array.from({ length: 13 }, () => STEPS[2]) }).success).toBe(false)
    // The text's length is the server validator's call, after tidying: a padded line passes the schema.
    expect(updatePlanInput.safeParse({ steps: [{ text: `  ${'x'.repeat(140)}  `, status: 'pending' }] }).success).toBe(true)
    expect(updatePlanInput.safeParse({ steps: [{ text: 'a', status: 'blocked' }] }).success).toBe(false)
  })
})

describe('work-agent update_plan — the post', () => {
  it('posts the whole plan to the event route with the run token, and returns it', async () => {
    respond(200, { ok: true, plan: { steps: STEPS, updated_at: 'now' }, canceling: false })
    const out = await execute({ steps: STEPS }, ctx)
    expect(out).toEqual({ ok: true, plan: STEPS })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://app.test/api/internal/agent-run/event')
    expect(JSON.parse(init.body as string)).toEqual({ kind: 'plan', steps: STEPS })
    const headers = init.headers as Record<string, string>
    expect(headers['x-agent-run-token']).toBe('run.tok')
    expect(headers['x-agent-run-secret']).toBe('sec')
  })

  it("relays the route's refusal in its own words", async () => {
    respond(400, { ok: false, error: 'Only one step can be in_progress at a time (2 are).', canceling: false })
    expect(await execute({ steps: STEPS }, ctx)).toEqual({ ok: false, error: 'Only one step can be in_progress at a time (2 are).' })
  })

  it('tells a canceling run to stop', async () => {
    respond(200, { ok: true, plan: { steps: STEPS }, canceling: true })
    expect(await execute({ steps: STEPS }, ctx)).toMatchObject({ ok: true, stop: true })
  })

  it('never throws on a network failure', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    expect(await execute({ steps: STEPS }, ctx)).toEqual({ ok: false, error: 'boom' })
  })
})
