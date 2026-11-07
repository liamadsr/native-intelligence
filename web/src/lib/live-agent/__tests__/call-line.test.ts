/**
 * The main agent's one line about a call going on (one-chat plan, Slice 3):
 * systemContext.onCallCaptureId becomes the `call` turn-context section
 * ("On a call now: <title>, live agent <name>"), for the caller's own,
 * still-going capture only, never in a teammate's chat or the live
 * conversation's own turn (which has the whole live block).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/ai/system-prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/system-prompt')>()),
  buildSystemPromptParts: vi.fn(async () => ({
    clock: 'CLOCK',
    profile: 'PROFILE',
    projects: null,
    captures: null,
    view: null,
    base: 'BASE',
    webAccess: null,
  })),
}))
vi.mock('@/lib/knowledge/brief', () => ({ getWorkspaceBrief: vi.fn(async () => null) }))
vi.mock('@/lib/live-agent/live-capture-context', () => ({ buildLiveCaptureContext: vi.fn(async () => 'LIVE BLOCK') }))

import { buildCallLine, renderCallLine } from '../call-line'
import { buildChatSystemPrompt, TURN_CONTEXT_KEYS } from '@/lib/ai/chat-system-prompt'

const CAPTURE = '11111111-2222-3333-4444-555555555555'

type Rows = {
  capture: { id: string; title: string | null; ended_at: string | null } | null
  conversation: { recipe_id: string | null } | null
  recipe: { name: string | null } | null
  /** The person's meeting_goal row for the capture (the linked read finds it). */
  goal?: Record<string, unknown> | null
}

function db(rows: Rows) {
  const filters: Array<[string, string, unknown]> = []
  const from = (table: string) => {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'order', 'limit', 'in', 'is', 'gte']) c[m] = () => c
    c.eq = (k: string, v: unknown) => {
      filters.push([table, k, v])
      return c
    }
    c.maybeSingle = async () => ({
      data:
        table === 'captures'
          ? rows.capture
          : table === 'chat_conversations'
            ? rows.conversation
            : table === 'recipe'
              ? rows.recipe
              : table === 'meeting_goal'
                ? (rows.goal ?? null)
                : null,
      error: null,
    })
    c.single = async () => ({ data: null, error: null })
    c.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null })
    return c
  }
  return { client: { from } as never, filters }
}

const going: Rows = {
  capture: { id: CAPTURE, title: 'Acme renewal', ended_at: null },
  conversation: { recipe_id: 'rec-1' },
  recipe: { name: 'Sales Coach' },
}

describe('renderCallLine', () => {
  it('is one line naming the call, its live agent and the capture to read', () => {
    const text = renderCallLine({ captureId: CAPTURE, title: 'Acme renewal', agentName: 'Sales Coach' })
    expect(text.split('\n')[0]).toBe('## On a call now')
    expect(text).toContain(`On a call now: "Acme renewal", live agent Sales Coach (capture ${CAPTURE}).`)
    expect(text).toContain('get_capture_transcript')
    expect(text).not.toContain('tell_note_taker')
  })
})

describe('buildCallLine', () => {
  it('reads the caller’s own capture in this workspace, and its live agent', async () => {
    const { client, filters } = db(going)
    const text = await buildCallLine(client, CAPTURE, 'ws-1', 'user-1')
    expect(text).toContain('"Acme renewal", live agent Sales Coach')
    expect(filters).toEqual(
      expect.arrayContaining([
        ['captures', 'id', CAPTURE],
        ['captures', 'workspace_id', 'ws-1'],
        ['captures', 'user_id', 'user-1'],
        ['chat_conversations', 'capture_id', CAPTURE],
        ['chat_conversations', 'user_id', 'user-1'],
      ]),
    )
  })

  it('names the built-in Assistant when the conversation has no agent, and tidies the title', async () => {
    const { client } = db({ capture: { id: CAPTURE, title: 'Q3\n"plan"  review', ended_at: null }, conversation: null, recipe: null })
    const text = await buildCallLine(client, CAPTURE, 'ws-1', 'user-1')
    expect(text).toContain('On a call now: "Q3 plan review", live agent Assistant')
  })

  it("carries the person's own goal in a few quoted words, still one line", async () => {
    const goal = { id: 'g-1', calendar_event_id: 'evt-1', starts_at: '2026-10-18T15:00:00Z', capture_id: CAPTURE, goal: 'Close the "pilot"\nby Friday ' + 'x'.repeat(300), source: 'chat', updated_at: '2026-10-18T14:00:00Z' }
    const { client, filters } = db({ ...going, goal })
    const text = (await buildCallLine(client, CAPTURE, 'ws-1', 'user-1'))!
    const [heading, line, ...rest] = text.split('\n')
    expect(heading).toBe('## On a call now')
    expect(rest).toEqual([])
    expect(line).toContain(`(capture ${CAPTURE}), their goal (their words): "Close the pilot by Friday x`)
    expect(line).toMatch(/…"\. The live agent/)
    expect(line.length).toBeLessThan(560)
    // Read for the person alone.
    expect(filters).toEqual(expect.arrayContaining([['meeting_goal', 'user_id', 'user-1'], ['meeting_goal', 'workspace_id', 'ws-1']]))
  })

  it('no goal, no goal words', async () => {
    const text = await buildCallLine(db(going).client, CAPTURE, 'ws-1', 'user-1')
    expect(text).not.toContain('goal')
    expect(renderCallLine({ captureId: CAPTURE, title: 'T', agentName: 'A', goal: 'Ship it' })).toContain('(capture ' + CAPTURE + '), their goal (their words): "Ship it".')
  })

  it('is nothing for a call that ended, a capture not the caller’s, or a junk id', async () => {
    expect(await buildCallLine(db({ ...going, capture: { ...going.capture!, ended_at: '2026-10-15T10:00:00Z' } }).client, CAPTURE, 'ws-1', 'user-1')).toBeNull()
    expect(await buildCallLine(db({ ...going, capture: null }).client, CAPTURE, 'ws-1', 'user-1')).toBeNull()
    expect(await buildCallLine(db(going).client, 'not an id; drop table', 'ws-1', 'user-1')).toBeNull()
  })
})

describe('buildChatSystemPrompt — the call note', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sits right after `live` in the turn-context order', () => {
    expect(TURN_CONTEXT_KEYS.indexOf('call')).toBe(TURN_CONTEXT_KEYS.indexOf('live') + 1)
  })

  it('a main chat turn during a call carries it', async () => {
    const built = await buildChatSystemPrompt({ userId: 'user-1', supabase: db(going).client, workspaceId: 'ws-1', systemContext: { onCallCaptureId: CAPTURE } })
    const call = built.turnContext.find((s) => s.key === 'call')
    expect(call?.markdown).toContain('On a call now: "Acme renewal", live agent Sales Coach')
    expect(built.turnContext.some((s) => s.key === 'live')).toBe(false)
  })

  it('never in the live conversation’s own turn, nor with no call', async () => {
    const live = await buildChatSystemPrompt({
      userId: 'user-1',
      supabase: db(going).client,
      workspaceId: 'ws-1',
      systemContext: { onCallCaptureId: CAPTURE, liveCaptureId: CAPTURE },
    })
    expect(live.turnContext.some((s) => s.key === 'call')).toBe(false)
    const none = await buildChatSystemPrompt({ userId: 'user-1', supabase: db(going).client, workspaceId: 'ws-1', systemContext: {} })
    expect(none.turnContext.some((s) => s.key === 'call')).toBe(false)
  })
})
