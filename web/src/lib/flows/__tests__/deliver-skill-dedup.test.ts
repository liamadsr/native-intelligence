/**
 * deliverSkillOutput idempotency (retries:1 double-delivery guard).
 *
 * The enclosing Inngest step runs the LLM call + delivery under retries:1, so a
 * step retry re-runs deliverSkillOutput for the SAME fire. With a stable fireId,
 * the second delivery must find the already-inserted document (stamped in
 * frontmatter) and reuse it — NO second document insert, NO duplicate
 * notification. Without a fireId (test-fires, older callers) the behaviour is
 * unchanged (always inserts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SkillRunSpec, SkillRunOutput } from '../run-skill'

const h = vi.hoisted(() => ({
  logUsage: vi.fn(async () => {}),
  createNotification: vi.fn(async () => {}),
  indexDocument: vi.fn(async () => ({ chunksCreated: 1, chunksEmbedded: 1 })),
}))

vi.mock('@/lib/ai/auth', () => ({ logUsage: h.logUsage, extractGatewayCost: () => null }))
vi.mock('@/lib/ai/embeddings', () => ({ indexDocument: h.indexDocument }))
vi.mock('@/lib/notifications', () => ({ createNotification: h.createNotification }))

const { deliverSkillOutput } = await import('../run-skill')

const SPEC: SkillRunSpec = {
  runAsUserId: 'user-1',
  workspaceId: 'ws-1',
  skillId: 'skill-1',
  skillName: 'Morning Brief',
  skillUpdatedAt: null,
  systemPrompt: 'sys',
  userMessage: 'go',
  ceiling: [],
  activeTools: [],
  model: 'claude-opus',
  mode: 'report',
  deliver: undefined,
  templateTitleDefault: '{skill} — {date}',
  outputContract: 'prose',
}

const OUTPUT: SkillRunOutput = {
  text: 'the brief body',
  usage: { inputTokens: 10, outputTokens: 20 },
  costUsd: 0.01,
  feature: 'flow_run_skill',
  durationMs: 100,
  bodyByteLength: 2,
}

/**
 * Fake supabase. `priorDoc` is what the frontmatter-dedup lookup returns; the
 * insert path records calls and hands back a fresh id.
 */
function makeSupabase(opts: { priorDoc?: { id: string } | null }) {
  const inserts: Record<string, unknown>[] = []
  const documentQuery = () => {
    const q: Record<string, unknown> = {}
    Object.assign(q, {
      select: () => q,
      eq: () => q,
      contains: () => q,
      limit: () => q,
      // dedup lookup terminal
      maybeSingle: async () => ({ data: opts.priorDoc ?? null, error: null }),
      // insert path
      insert: (row: Record<string, unknown>) => {
        inserts.push(row)
        return {
          select: () => ({ single: async () => ({ data: { id: 'new-doc' }, error: null }) }),
        }
      },
    })
    return q
  }
  const supabase = {
    from: (table: string) => {
      if (table === 'member') {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'm1' }, error: null }) }) }) }) }
      }
      return documentQuery()
    },
  } as unknown as SupabaseClient
  return { supabase, inserts }
}

beforeEach(() => {
  h.logUsage.mockClear()
  h.createNotification.mockClear()
})

describe('deliverSkillOutput — fire-id dedup', () => {
  it('reuses an existing document and skips insert + notification on a retry', async () => {
    const { supabase, inserts } = makeSupabase({ priorDoc: { id: 'existing-doc' } })
    const result = await deliverSkillOutput(supabase, SPEC, OUTPUT, Date.now(), 'fire-abc')
    expect(result.status).toBe('success')
    expect(result.output_document_id).toBe('existing-doc')
    expect(inserts).toHaveLength(0)
    expect(h.createNotification).not.toHaveBeenCalled()
  })

  it('inserts a document stamped with the fire id on first delivery', async () => {
    const { supabase, inserts } = makeSupabase({ priorDoc: null })
    const result = await deliverSkillOutput(supabase, SPEC, OUTPUT, Date.now(), 'fire-abc')
    expect(result.output_document_id).toBe('new-doc')
    expect(inserts).toHaveLength(1)
    expect(inserts[0].frontmatter).toEqual({ flow_fire_id: 'fire-abc', skill_id: 'skill-1' })
    // Reports are indexed for search now (documents phase 1), like any document.
    expect(h.indexDocument).toHaveBeenCalledWith(supabase, 'new-doc', SPEC.runAsUserId, null, OUTPUT.text, SPEC.workspaceId)
    // The "output ready" push is the work ledger's (the fire's item lands in
    // Needs you with the document); delivery itself no longer notifies.
    expect(h.createNotification).not.toHaveBeenCalled()
  })

  it('mutes the fire\'s work item when the flow opted out of notifications', async () => {
    const { supabase } = makeSupabase({ priorDoc: null })
    const mute = vi.fn(async () => {})
    const work = { id: 'job-1', mute } as never
    await deliverSkillOutput(supabase, { ...SPEC, deliver: { notification: false } as never }, OUTPUT, Date.now(), 'fire-abc', work)
    expect(mute).toHaveBeenCalledOnce()
    await deliverSkillOutput(supabase, SPEC, OUTPUT, Date.now(), 'fire-abc', work)
    expect(mute).toHaveBeenCalledOnce()
  })

  it('does not stamp a fire id or dedup when no fireId is given; the skill stamp (a report) is always there', async () => {
    const { supabase, inserts } = makeSupabase({ priorDoc: { id: 'existing-doc' } })
    const result = await deliverSkillOutput(supabase, SPEC, OUTPUT, Date.now())
    // No fireId → no dedup lookup honored → always inserts.
    expect(inserts).toHaveLength(1)
    // document.kind 'report' (migration 367) comes from the skill stamp.
    expect(inserts[0].frontmatter).toEqual({ skill_id: SPEC.skillId })
    expect(result.output_document_id).toBe('new-doc')
  })
})

describe('deliverSkillOutput — cached input rides the usage metadata', () => {
  it('spreads cache_read/creation_input_tokens so log_ai_usage prices them at the cache rates', async () => {
    h.logUsage.mockClear()
    const { supabase } = makeSupabase({})
    await deliverSkillOutput(
      supabase,
      SPEC,
      { ...OUTPUT, usage: { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 700, cacheWriteTokens: 50 } },
      Date.now(),
    )
    const [, row] = h.logUsage.mock.calls[0] as unknown as [string, { metadata: Record<string, unknown> }]
    expect(row.metadata).toMatchObject({ cache_read_input_tokens: 700, cache_creation_input_tokens: 50 })
  })
})
