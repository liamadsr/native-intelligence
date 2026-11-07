/**
 * Outreach draft generator tests (loop-closure Phase 3, WS-2a).
 *
 * The generator's job: make ONE LLM call and write the body into an EXISTING
 * email_draft shell — the exact row keyed by id — leaving status 'pending_review'.
 * A stateful fake Supabase (email_draft + captures + auth.getUser) lets us assert
 * the real row was filled, that a sibling shell is untouched, and that every
 * failure mode (model throw, empty draft, write error, missing shell) is honest
 * and leaves no half-written body. The model call — one task session on the eve
 * utility agent (kind 'outreach_draft', runUtilityTask) — and the usage utils are
 * mocked; `generateText` below is that dispatcher.
 *
 * Also pinned since the eve port: the task message is byte-identical to the
 * pre-port prompt, the sign-off name rides as the kind's param, and an eval
 * (`is_eval`) capture NEVER grounds the prompt.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  generateText: vi.fn(),
  logUsage: vi.fn(),
}))

vi.mock('@/lib/eve/utility/run-utility', () => ({ runUtilityTask: hoisted.generateText }))
vi.mock('@/lib/ai/auth', () => ({
  logUsage: hoisted.logUsage,
}))

/** A runUtilityTask text result. */
function gen(text: string, usage: { inputTokens?: number; outputTokens?: number } = {}) {
  return {
    text,
    model: 'deepseek-v4-flash',
    usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, costUsd: null, steps: 1 },
  }
}

const { generateOutreachDraft } = await import('@/lib/email/outreach-draft-generator')

interface Row {
  [k: string]: unknown
}

// A tiny stateful fake honoring the exact chains the generator uses:
// select().eq().eq()[.neq()].maybeSingle() and update().eq().eq() (awaited).
function makeFake(seed: {
  drafts?: Row[]
  captures?: Row[]
  user?: Row | null
  updateError?: string
}) {
  const tables: Record<string, Row[]> = {
    email_draft: seed.drafts ?? [],
    captures: seed.captures ?? [],
  }
  const user =
    seed.user === undefined ? { id: 'u1', user_metadata: { full_name: 'Liam Ada' } } : seed.user

  function builder(table: string) {
    const filters: Array<[string, unknown]> = []
    const notFilters: Array<[string, unknown]> = []
    let op: 'select' | 'update' = 'select'
    let pendingUpdate: Row | null = null
    // PostgREST `neq` on a NULL column excludes the row too; model is_eval as a
    // plain boolean here (default false), which is what the fence relies on.
    const match = (r: Row) =>
      filters.every(([k, v]) => r[k] === v) && notFilters.every(([k, v]) => (r[k] ?? false) !== v)

    const api: Record<string, unknown> = {
      select: () => api,
      eq: (k: string, v: unknown) => {
        filters.push([k, v])
        return api
      },
      neq: (k: string, v: unknown) => {
        notFilters.push([k, v])
        return api
      },
      update: (row: Row) => {
        op = 'update'
        pendingUpdate = row
        return api
      },
      maybeSingle: async () => ({ data: tables[table].filter(match)[0] ?? null, error: null }),
      // A bare awaited update (no .select) runs here.
      then: (resolve: (r: unknown) => unknown) => {
        if (op === 'update') {
          if (table === 'email_draft' && seed.updateError) {
            return Promise.resolve({ data: null, error: { message: seed.updateError } }).then(resolve)
          }
          for (const r of tables[table].filter(match)) Object.assign(r, pendingUpdate)
          return Promise.resolve({ data: null, error: null }).then(resolve)
        }
        return Promise.resolve({ data: tables[table].filter(match), error: null }).then(resolve)
      },
    }
    return api
  }

  return {
    from: (t: string) => builder(t),
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    _tables: tables,
  }
}

const baseCtx = () => ({
  to_name: 'Sam',
  to_address: 'sam@x.com',
  subject: 'Reach out',
  email_context: 'follow up on the deal',
  trigger_quote: 'I said I would email Sam',
  capture_id: null as string | null,
})

beforeEach(() => {
  hoisted.generateText.mockReset()
  hoisted.logUsage.mockReset()
})

describe('generateOutreachDraft — happy path', () => {
  it('writes the generated body into the target row and leaves status untouched', async () => {
    hoisted.generateText.mockResolvedValue(
      gen('Hi Sam,\n\nCircling back on the deal.\n\nBest,\nLiam Ada', { inputTokens: 50, outputTokens: 30 }),
    )
    const fake = makeFake({
      drafts: [{ id: 'd1', user_id: 'u1', workspace_id: 'ws1', status: 'pending_review', body_text: null, body_html: null }],
      captures: [{ id: 'cap1', workspace_id: 'ws1', title: 'ORCA sync', ai_summary: 'We aligned on scope.' }],
    })
    const res = await generateOutreachDraft(fake as never, 'ws1', 'd1', { ...baseCtx(), capture_id: 'cap1' })
    expect(res.success).toBe(true)
    expect(hoisted.generateText).toHaveBeenCalledTimes(1)
    const row = fake._tables.email_draft[0]
    expect(row.body_text).toContain('Circling back on the deal.')
    expect(row.body_html).toContain('<p>Hi Sam,</p>')
    expect(row.status).toBe('pending_review') // never flips toward send
  })

  it('fills only the targeted shell, never a sibling draft', async () => {
    hoisted.generateText.mockResolvedValue(gen('Body text'))
    const fake = makeFake({
      drafts: [
        { id: 'd1', user_id: 'u1', workspace_id: 'ws1', body_text: null, body_html: null },
        { id: 'd2', user_id: 'u1', workspace_id: 'ws1', body_text: null, body_html: null },
      ],
    })
    const res = await generateOutreachDraft(fake as never, 'ws1', 'd2', baseCtx())
    expect(res.success).toBe(true)
    expect(fake._tables.email_draft.find((r) => r.id === 'd1')!.body_text).toBeNull()
    expect(fake._tables.email_draft.find((r) => r.id === 'd2')!.body_text).toBe('Body text')
  })

  it('logs usage against the draft OWNER (billing visibility)', async () => {
    hoisted.generateText.mockResolvedValue(gen('Body', { inputTokens: 5, outputTokens: 7 }))
    const fake = makeFake({ drafts: [{ id: 'd1', user_id: 'owner-9', workspace_id: 'ws1', body_text: null }] })
    await generateOutreachDraft(fake as never, 'ws1', 'd1', baseCtx())
    expect(hoisted.logUsage).toHaveBeenCalledTimes(1)
    expect(hoisted.logUsage.mock.calls[0][0]).toBe('owner-9')
    expect(hoisted.logUsage.mock.calls[0][1]).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      feature: 'outreach_draft',
      inputTokens: 5,
      outputTokens: 7,
      costUsd: undefined,
    })
    // Gateway attribution goes to the owner too.
    expect(hoisted.generateText.mock.calls[0][0]).toMatchObject({ kind: 'outreach_draft', userId: 'owner-9', workspaceId: 'ws1' })
  })

  it('sends the pre-port prompt, byte-identical, with the sign-off name as the kind param', async () => {
    hoisted.generateText.mockResolvedValue(gen('Body'))
    const fake = makeFake({
      drafts: [{ id: 'd1', user_id: 'u1', workspace_id: 'ws1', body_text: null }],
      captures: [{ id: 'cap1', workspace_id: 'ws1', title: 'ORCA sync', ai_summary: 'We aligned on scope.' }],
    })
    await generateOutreachDraft(fake as never, 'ws1', 'd1', { ...baseCtx(), capture_id: 'cap1' })
    const args = hoisted.generateText.mock.calls[0][0]
    expect(args.params).toEqual({ userName: 'Liam Ada' })
    expect(args.message).toBe(
      'Reaching out to: Sam <sam@x.com>\n' +
        'Intended subject: Reach out\n' +
        "Why I'm reaching out: follow up on the deal\n" +
        'What I said I\'d do (my own words): "I said I would email Sam"\n' +
        '\nFrom the meeting "ORCA sync": We aligned on scope.' +
        '\n\nDraft the email body.',
    )
  })

  it('falls back to the "me" sign-off when the caller has no name', async () => {
    hoisted.generateText.mockResolvedValue(gen('Body'))
    const fake = makeFake({ drafts: [{ id: 'd1', user_id: 'u1', workspace_id: 'ws1', body_text: null }], user: null })
    await generateOutreachDraft(fake as never, 'ws1', 'd1', baseCtx())
    expect(hoisted.generateText.mock.calls[0][0].params).toEqual({ userName: 'me' })
  })

  it('NEVER grounds the prompt in an eval (is_eval) capture', async () => {
    hoisted.generateText.mockResolvedValue(gen('Body'))
    const fake = makeFake({
      drafts: [{ id: 'd1', user_id: 'u1', workspace_id: 'ws1', body_text: null }],
      captures: [{ id: 'cap-eval', workspace_id: 'ws1', title: 'Mock sales call', ai_summary: 'FAKE PRICING', is_eval: true }],
    })
    const res = await generateOutreachDraft(fake as never, 'ws1', 'd1', { ...baseCtx(), capture_id: 'cap-eval' })
    expect(res.success).toBe(true)
    const message = hoisted.generateText.mock.calls[0][0].message as string
    expect(message).not.toContain('Mock sales call')
    expect(message).not.toContain('FAKE PRICING')
    expect(message).not.toContain('From the meeting')
  })

  it('still succeeds when the capture grounding is unavailable (best-effort)', async () => {
    hoisted.generateText.mockResolvedValue(gen('Body'))
    const fake = makeFake({ drafts: [{ id: 'd1', user_id: 'u1', workspace_id: 'ws1', body_text: null }], captures: [] })
    const res = await generateOutreachDraft(fake as never, 'ws1', 'd1', { ...baseCtx(), capture_id: 'ghost' })
    expect(res.success).toBe(true)
    expect(fake._tables.email_draft[0].body_text).toBe('Body')
  })
})

describe('generateOutreachDraft — honest failure (no half-write)', () => {
  it('fails and writes nothing when the model call throws', async () => {
    hoisted.generateText.mockRejectedValue(new Error('rate limited'))
    const fake = makeFake({ drafts: [{ id: 'd1', user_id: 'u1', workspace_id: 'ws1', body_text: null }] })
    const res = await generateOutreachDraft(fake as never, 'ws1', 'd1', baseCtx())
    expect(res.success).toBe(false)
    expect(res.error).toContain('rate limited')
    expect(fake._tables.email_draft[0].body_text).toBeNull()
    expect(hoisted.logUsage).not.toHaveBeenCalled()
  })

  it('fails and writes nothing when the eve session times out', async () => {
    hoisted.generateText.mockRejectedValue(new Error('[utility] outreach_draft timed out after 90000ms'))
    const fake = makeFake({ drafts: [{ id: 'd1', user_id: 'u1', workspace_id: 'ws1', body_text: null }] })
    const res = await generateOutreachDraft(fake as never, 'ws1', 'd1', baseCtx())
    expect(res).toEqual({ success: false, error: '[utility] outreach_draft timed out after 90000ms' })
    expect(fake._tables.email_draft[0].body_text).toBeNull()
    expect(hoisted.logUsage).not.toHaveBeenCalled()
  })

  it('treats an empty model draft as a failure (never writes an empty body)', async () => {
    hoisted.generateText.mockResolvedValue(gen('   '))
    const fake = makeFake({ drafts: [{ id: 'd1', user_id: 'u1', workspace_id: 'ws1', body_text: null }] })
    const res = await generateOutreachDraft(fake as never, 'ws1', 'd1', baseCtx())
    expect(res.success).toBe(false)
    expect(fake._tables.email_draft[0].body_text).toBeNull()
  })

  it('returns failure when the draft write errors', async () => {
    hoisted.generateText.mockResolvedValue(gen('Body'))
    const fake = makeFake({ drafts: [{ id: 'd1', user_id: 'u1', workspace_id: 'ws1', body_text: null }], updateError: 'db exploded' })
    const res = await generateOutreachDraft(fake as never, 'ws1', 'd1', baseCtx())
    expect(res.success).toBe(false)
    expect(res.error).toBe('db exploded')
  })

  it('fails cleanly (no model call) when the shell is missing', async () => {
    hoisted.generateText.mockResolvedValue(gen('Body'))
    const fake = makeFake({ drafts: [] })
    const res = await generateOutreachDraft(fake as never, 'ws1', 'missing', baseCtx())
    expect(res.success).toBe(false)
    expect(hoisted.generateText).not.toHaveBeenCalled()
  })
})
