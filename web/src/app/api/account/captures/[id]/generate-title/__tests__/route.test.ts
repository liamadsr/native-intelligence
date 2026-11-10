/**
 * POST /api/account/captures/[id]/generate-title — names a capture from its
 * summary, now through the eve utility agent (kind 'generate_title').
 *
 * Pinned:
 *   - the task message is BYTE-IDENTICAL to the prompt the pre-port
 *     generateText call sent (the kind has no system prompt, as before);
 *   - usage is logged as 'generate_title' with { captureId }, against the model
 *     the session ran on, cost omitted when eve reports none;
 *   - the guard paths (renamed title, no summary) never reach the model;
 *   - the title is cleaned and written workspace-fenced; an invalid one is
 *     skipped; a failed generation is a 500 with nothing logged or written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  runUtilityTask: vi.fn(),
  logUsage: vi.fn(async (..._a: unknown[]) => undefined),
  capture: { title: 'Capture Sep 24 3:05 PM', ai_summary: 'We agreed to ship the Q3 renewal pricing.' } as Record<string, unknown> | null,
  updates: [] as Array<{ row: unknown; eqs: Array<[string, unknown]> }>,
}))

function fakeSupabase() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: () => {
      const eqs: Array<[string, unknown]> = []
      let update: unknown = null
      const api: Record<string, unknown> = {
        select: () => api,
        update: (row: unknown) => {
          update = row
          return api
        },
        eq: (k: string, v: unknown) => {
          eqs.push([k, v])
          return api
        },
        single: async () => ({ data: hoisted.capture }),
        then: (resolve: (r: unknown) => unknown) => {
          if (update) hoisted.updates.push({ row: update, eqs })
          return Promise.resolve({ data: null, error: null }).then(resolve)
        },
      }
      return api
    },
  }
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => fakeSupabase() }))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))
vi.mock('@/lib/eve/utility/run-utility', () => ({ runUtilityTask: hoisted.runUtilityTask }))
vi.mock('@/lib/ai/auth', () => ({ logUsage: hoisted.logUsage }))

const { POST } = await import('@/app/api/account/captures/[id]/generate-title/route')

const call = () =>
  POST(new Request('https://nativeintelligence.dev/x', { method: 'POST' }) as never, { params: Promise.resolve({ id: 'cap-1' }) })

function ok(text: string) {
  hoisted.runUtilityTask.mockResolvedValue({
    text,
    model: 'deepseek-v4-flash',
    usage: { inputTokens: 120, outputTokens: 8, costUsd: null, steps: 1 },
  })
}

beforeEach(() => {
  hoisted.runUtilityTask.mockReset()
  hoisted.logUsage.mockClear()
  hoisted.updates.length = 0
  hoisted.capture = { title: 'Capture Sep 24 3:05 PM', ai_summary: 'We agreed to ship the Q3 renewal pricing.' }
})

describe('generate-title → utility agent', () => {
  it('sends the pre-port prompt, byte-identical, as the task message', async () => {
    ok('Q3 Renewal Pricing Decision')
    await call()
    const args = hoisted.runUtilityTask.mock.calls[0][0]
    expect(args).toMatchObject({ kind: 'generate_title', workspaceId: 'ws-1', userId: 'user-1' })
    expect(args.params).toBeUndefined()
    expect(args.message).toBe(
      'Generate a short, descriptive title (3-8 words) for this meeting based on the summary below. Return ONLY the title text, nothing else. No quotes, no prefix, no explanation.\n\nSummary:\nWe agreed to ship the Q3 renewal pricing.',
    )
  })

  it('caps the summary at 2000 chars', async () => {
    hoisted.capture = { title: 'Capture Jan 1 9:00 AM', ai_summary: 's'.repeat(5000) }
    ok('A title')
    await call()
    const msg = hoisted.runUtilityTask.mock.calls[0][0].message as string
    expect(msg.endsWith(`Summary:\n${'s'.repeat(2000)}`)).toBe(true)
  })

  it('logs usage as generate_title with the capture id, against the model that ran', async () => {
    ok('Q3 Renewal Pricing Decision')
    await call()
    expect(hoisted.logUsage).toHaveBeenCalledTimes(1)
    const [userId, params] = hoisted.logUsage.mock.calls[0] as [string, Record<string, unknown>]
    expect(userId).toBe('user-1')
    expect(params).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      feature: 'generate_title',
      inputTokens: 120,
      outputTokens: 8,
      costUsd: undefined,
      metadata: { captureId: 'cap-1' },
    })
  })

  it('writes the cleaned title, fenced to the workspace', async () => {
    ok('"Q3 Renewal Pricing"')
    const res = await call()
    expect(await res.json()).toEqual({ ok: true, title: 'Q3 Renewal Pricing' })
    expect(hoisted.updates).toEqual([
      { row: { title: 'Q3 Renewal Pricing' }, eqs: [['id', 'cap-1'], ['workspace_id', 'ws-1']] },
    ])
  })

  it('skips an invalid (empty / over-long) title without writing', async () => {
    ok('x'.repeat(101))
    const res = await call()
    expect(await res.json()).toMatchObject({ skipped: true })
    expect(hoisted.updates).toEqual([])
  })

  it('never calls the model when the title was already renamed, or there is no summary', async () => {
    hoisted.capture = { title: 'Board prep', ai_summary: 'x' }
    expect(await (await call()).json()).toMatchObject({ skipped: true })
    hoisted.capture = { title: 'Capture Sep 24 3:05 PM', ai_summary: null }
    expect(await (await call()).json()).toMatchObject({ skipped: true })
    expect(hoisted.runUtilityTask).not.toHaveBeenCalled()
  })

  it('a failed generation is a 500 with nothing logged or written', async () => {
    hoisted.runUtilityTask.mockRejectedValue(new Error('[utility] generate_title session failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await call()
    expect(res.status).toBe(500)
    expect(hoisted.logUsage).not.toHaveBeenCalled()
    expect(hoisted.updates).toEqual([])
  })
})
